import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { startMuseSessionBridge } = await import('../src/providers/hook/muse/museSessionBridge.js');

const SID = '01a17a2e-b5bc-70e1-8fb2-da5bec96d08a';
const PROJECT = '/work/little-kitchen';

function sessionFile(sid: string): string {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(
    tmpBase,
    '.local',
    'share',
    'muse',
    'sessions',
    yyyy,
    mm,
    dd,
    sid,
    'session.jsonl',
  );
}

function record(payloadType: string, record: Record<string, unknown>): string {
  return JSON.stringify({
    payload_type: payloadType,
    payload: { kind: 'test', record },
    stream: { kind: 'session', id: SID },
    recorded_at: Date.now() * 1000,
  });
}

function frameRecord(payloadType: string, record: Record<string, unknown>): string {
  return JSON.stringify({
    retained_frame: 'session_permission_transaction',
    children: [
      {
        child_index: 0,
        record_json: JSON.stringify({
          payload_type: payloadType,
          payload: { kind: 'test', record },
          stream: { kind: 'session', id: SID },
        }),
      },
    ],
  });
}

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

interface Harness {
  emitted: Array<Record<string, unknown>>;
  stop: () => void;
}

function startBridge(opts: {
  hooksInstalled: boolean;
  hasAgent?: boolean;
  takeoverGraceMs?: number;
}): Harness {
  const emitted: Array<Record<string, unknown>> = [];
  const bridge = startMuseSessionBridge(
    {
      emit: (e) => emitted.push(e),
      hasAgentForSession: () => opts.hasAgent ?? false,
    },
    {
      fallbackCwd: '/fallback',
      areHooksInstalled: () => opts.hooksInstalled,
      takeoverGraceMs: opts.takeoverGraceMs ?? 4000,
    },
  );
  return { emitted, stop: () => bridge.stop() };
}

async function until(cond: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('muse session bridge', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-bridge-'));
  });

  afterEach(() => {
    harness?.stop();
    harness = null;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('seats a live session from its transcript when hooks are not installed', async () => {
    const file = sessionFile(SID);
    writeLines(file, [
      record('runtime.session.metadata', { workspace_root: PROJECT }),
      record('session.started', {}),
    ]);

    harness = startBridge({ hooksInstalled: false });
    await until(() => harness!.emitted.some((e) => e.hook_event_name === 'SessionStart'));
    const start = harness.emitted.find((e) => e.hook_event_name === 'SessionStart');
    expect(start?.session_id).toBe(SID);
    expect(start?.cwd).toBe(PROJECT);

    // Live tool activity streams through, including a frame-wrapped record.
    writeLines(file, [
      record('tool_batch.effect.started', { tool_name: 'read_file', call_id: 'call_1' }),
    ]);
    await until(() => harness!.emitted.some((e) => e.hook_event_name === 'PreToolUse'));
    const pre = harness.emitted.find((e) => e.hook_event_name === 'PreToolUse');
    expect(pre?.tool_name).toBe('read_file');

    writeLines(file, [
      frameRecord('tool_batch.effect.terminal', { tool_name: 'read_file', call_id: 'call_1' }),
    ]);
    await until(() => harness!.emitted.some((e) => e.hook_event_name === 'PostToolUse'));

    // Session end closes the turn and releases the session.
    writeLines(file, [record('session.end', { exit_reason: 'clean' })]);
    await until(() => harness!.emitted.some((e) => e.hook_event_name === 'SessionEnd'));
    const names = harness.emitted.map((e) => e.hook_event_name);
    expect(names.indexOf('Stop')).toBeGreaterThan(-1);
    expect(names.indexOf('Stop')).toBeLessThan(names.indexOf('SessionEnd'));
    const end = harness.emitted.find((e) => e.hook_event_name === 'SessionEnd');
    expect(end?.reason).toBe('clean');
  });

  it('stays silent while native hooks deliver (agent exists)', async () => {
    const file = sessionFile(SID);
    writeLines(file, [
      record('runtime.session.metadata', { workspace_root: PROJECT }),
      record('session.started', {}),
      record('tool_batch.effect.started', { tool_name: 'bash', call_id: 'call_9' }),
    ]);
    harness = startBridge({ hooksInstalled: true, hasAgent: true, takeoverGraceMs: 200 });
    // Well past the takeover grace: with an agent present, nothing is emitted.
    await new Promise((r) => setTimeout(r, 2500));
    expect(harness.emitted).toEqual([]);
  });

  it('takes over when hooks are installed but no agent appears', async () => {
    const file = sessionFile(SID);
    writeLines(file, [
      record('runtime.session.metadata', { workspace_root: PROJECT }),
      record('session.started', {}),
      record('tool_batch.effect.started', { tool_name: 'bash', call_id: 'call_9' }),
    ]);
    harness = startBridge({ hooksInstalled: true, hasAgent: false, takeoverGraceMs: 200 });
    await until(() => harness!.emitted.some((e) => e.hook_event_name === 'SessionStart'));
    const start = harness.emitted.find((e) => e.hook_event_name === 'SessionStart');
    expect(start?.cwd).toBe(PROJECT);
  });

  it('never resurrects a finished session', async () => {
    const file = sessionFile(SID);
    writeLines(file, [
      record('runtime.session.metadata', { workspace_root: PROJECT }),
      record('session.started', {}),
      record('tool_batch.effect.started', { tool_name: 'bash', call_id: 'call_9' }),
      record('session.end', { exit_reason: 'clean' }),
    ]);
    harness = startBridge({ hooksInstalled: false });
    await new Promise((r) => setTimeout(r, 2500));
    expect(harness.emitted).toEqual([]);
  });
});
