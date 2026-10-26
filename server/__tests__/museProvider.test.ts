import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { museProvider } = await import('../src/providers/hook/muse/muse.js');
const { hookProviderById, hookProviders } = await import('../src/providers/index.js');
const installer = await import('../src/providers/hook/muse/museHookInstaller.js');

const SID = '01a17a2e-b5bc-70e1-8fb2-da5bec96d08a';

describe('museProvider registration', () => {
  it('is registered alongside the Claude provider', () => {
    expect(museProvider.id).toBe('muse');
    expect(museProvider.kind).toBe('hook');
    expect(hookProviderById('muse')).toBe(museProvider);
    expect(hookProviders).toContain(museProvider);
    expect(hookProviders.map((p) => p.id)).toContain('claude');
  });

  it('exposes the Muse sessions root and file pattern', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-provider-'));
    try {
      expect(museProvider.getAllSessionRoots?.()).toEqual([
        path.join(tmpBase, '.local', 'share', 'muse', 'sessions'),
      ]);
      expect(museProvider.sessionFilePattern).toBe('session.jsonl');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('museProvider.normalizeHookEvent', () => {
  const norm = (raw: Record<string, unknown>) => museProvider.normalizeHookEvent(raw);

  it('maps PreToolUse to toolStart with the tool name and input', () => {
    const out = norm({
      hook_event_name: 'PreToolUse',
      session_id: SID,
      tool_name: 'read_file',
      tool_input: { path: '/tmp/note.txt' },
      tool_use_id: 'call_123',
    });
    expect(out?.sessionId).toBe(SID);
    expect(out?.event.kind).toBe('toolStart');
    if (out?.event.kind === 'toolStart') {
      expect(out.event.toolName).toBe('read_file');
      expect(out.event.input).toEqual({ path: '/tmp/note.txt' });
    }
  });

  it('maps PostToolUse and PostToolUseFailure to toolEnd', () => {
    for (const name of ['PostToolUse', 'PostToolUseFailure']) {
      const out = norm({ hook_event_name: name, session_id: SID, tool_name: 'bash' });
      expect(out?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    }
  });

  it('maps Stop to turnEnd and PermissionRequest to permissionRequest', () => {
    expect(norm({ hook_event_name: 'Stop', session_id: SID })?.event).toEqual({
      kind: 'turnEnd',
    });
    expect(norm({ hook_event_name: 'PermissionRequest', session_id: SID })?.event).toEqual({
      kind: 'permissionRequest',
    });
  });

  it('maps SessionStart with cwd and deliberately NO transcriptPath', () => {
    // Muse hook payloads carry transcript_path: null, and adoption must key
    // off the project cwd, not the sessions-tree path.
    const out = norm({
      hook_event_name: 'SessionStart',
      session_id: SID,
      source: 'startup',
      cwd: '/work/project',
      transcript_path: null,
    });
    expect(out?.event.kind).toBe('sessionStart');
    if (out?.event.kind === 'sessionStart') {
      expect(out.event.cwd).toBe('/work/project');
      expect(out.event.transcriptPath).toBeUndefined();
    }
  });

  it('passes SessionEnd reason through verbatim (muse uses "other")', () => {
    const out = norm({ hook_event_name: 'SessionEnd', session_id: SID, reason: 'other' });
    expect(out?.event).toEqual({ kind: 'sessionEnd', reason: 'other' });
  });

  it('drops internal subagent events and prompt submissions', () => {
    // Muse fires SubagentStart/Stop for its internal reminder subagents with
    // CHILD session ids; normalizing them would spawn ghost characters.
    expect(
      norm({
        hook_event_name: 'SubagentStart',
        session_id: 'child-id',
        subagent_id: 'skill-reminder',
      }),
    ).toBeNull();
    expect(norm({ hook_event_name: 'SubagentStop', session_id: 'child-id' })).toBeNull();
    expect(
      norm({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'secret prompt' }),
    ).toBeNull();
  });

  it('drops malformed payloads', () => {
    expect(norm({ session_id: SID })).toBeNull();
    expect(norm({ hook_event_name: 'Stop' })).toBeNull();
    expect(norm({ hook_event_name: 'SomethingElse', session_id: SID })).toBeNull();
  });
});

describe('museProvider.formatToolStatus', () => {
  it('formats the observed Muse tool names', () => {
    expect(museProvider.formatToolStatus('read_file', { path: '/a/b/note.txt' })).toBe(
      'Reading note.txt',
    );
    expect(museProvider.formatToolStatus('edit_file', { path: '/a/b/x.ts' })).toBe('Editing x.ts');
    expect(museProvider.formatToolStatus('write_file', { path: '/a/b/y.ts' })).toBe('Writing y.ts');
    expect(museProvider.formatToolStatus('bash', { command: 'ls -la' })).toBe('Running: ls -la');
    expect(museProvider.formatToolStatus('search', {})).toBe('Searching code');
    expect(museProvider.formatToolStatus('web_fetch', {})).toBe('Fetching web content');
    expect(museProvider.formatToolStatus('subagent_spawn', {})).toBe('Running subtask');
    expect(museProvider.formatToolStatus('mcp__context7__query', {})).toBe(
      'Using mcp__context7__query',
    );
  });

  it('classifies reading tools and the subagent tool', () => {
    expect(museProvider.readingTools.has('read_file')).toBe(true);
    expect(museProvider.readingTools.has('bash')).toBe(false);
    expect(museProvider.subagentToolNames.has('subagent_spawn')).toBe(true);
    expect(museProvider.permissionExemptTools.has('subagent_spawn')).toBe(true);
  });
});

describe('muse hook installer (tmp HOME)', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-installer-'));
    // Pre-existing user config that must survive install/uninstall.
    const dir = path.join(tmpBase, '.config', 'muse');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        schema_version: 1,
        mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('installs entries for exactly the muse events, preserving user config', async () => {
    expect(installer.areHooksInstalled()).toBe(false);
    await installer.installHooks();
    expect(installer.areHooksInstalled()).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.config', 'muse', 'settings.json'), 'utf-8'),
    ) as {
      mcpServers: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.mcpServers).toEqual({
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    });
    const events = Object.keys(settings.hooks).sort();
    expect(events).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
      ].sort(),
    );
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toContain('/.pixel-agents/hooks/muse-hook.js');
          expect(hook.command).not.toContain('claude-hook');
        }
      }
    }
    // A one-time backup of the pre-install file exists.
    expect(
      fs.existsSync(path.join(tmpBase, '.config', 'muse', 'settings.json.pixel-agents.backup')),
    ).toBe(true);
  });

  it('install is idempotent and uninstall restores the user config', async () => {
    await installer.installHooks();
    await installer.installHooks();
    const settingsPath = path.join(tmpBase, '.config', 'muse', 'settings.json');
    const once = fs.readFileSync(settingsPath, 'utf-8');
    await installer.installHooks();
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(once);

    await installer.uninstallHooks();
    expect(installer.areHooksInstalled()).toBe(false);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings.hooks).toBeUndefined();
    expect(settings.mcpServers).toBeDefined();
  });

  it('copyHookScript copies the bundled script into ~/.pixel-agents/hooks', () => {
    const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-pkg-'));
    try {
      fs.mkdirSync(path.join(pkgRoot, 'dist', 'hooks'), { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, 'dist', 'hooks', 'muse-hook.js'),
        '#!/usr/bin/env node\n',
      );
      expect(installer.copyHookScript(pkgRoot)).toBe(true);
      expect(fs.existsSync(path.join(tmpBase, '.pixel-agents', 'hooks', 'muse-hook.js'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});
