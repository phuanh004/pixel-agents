/**
 * Muse session bridge: the scanning fallback for the Muse provider.
 *
 * Muse's native hooks (museHookInstaller.ts) are the primary channel. This
 * bridge watches the session transcripts Muse always writes —
 * ~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl —
 * and translates new records into the same hook-shaped events the native
 * hook script POSTs, so a session seats a character even when hooks are not
 * installed (fresh machine, hooks declined, or a Muse update that silently
 * breaks hook delivery).
 *
 * Record shapes (verified against Muse v1.4.13 session logs):
 * - Direct records: { payload_type, payload: { record: {...} }, stream.id }.
 * - Some records arrive wrapped in transaction frames:
 *   { retained_frame: 'session_permission_transaction',
 *     children: [{ record_json: '<stringified record>' }] }.
 * - runtime.session.metadata → payload.record.workspace_root (session cwd)
 * - tool_batch.effect.started/terminal → payload.record { tool_name, call_id }
 * - approval_wait.effect.started → the session is blocked on an approval
 * - session.end → payload.record.exit_reason
 *
 * Double-delivery rule: while the native hooks ARE installed, the bridge
 * stays silent for a session unless the hooks demonstrably failed for it —
 * tool activity observed in the log, a grace period elapsed, and still no
 * agent in the runtime. From that point the bridge owns the session. (If a
 * late native event does arrive, the runtime routes it to the same agent by
 * session id, so the worst case is a duplicate tool status, never a second
 * character.)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MUSE_BRIDGE_STALE_MS,
  MUSE_BRIDGE_TAKEOVER_GRACE_MS,
  MUSE_SESSIONS_DIR_PARTS,
} from './constants.js';
import { areHooksInstalled as museHooksInstalledSync } from './museHookInstaller.js';

/** What the bridge needs from its host (the AgentRuntime, adapted in cli.ts). */
export interface MuseSessionBridgeHost {
  /** Deliver one hook-shaped event as provider 'muse'. */
  emit(event: Record<string, unknown>): void;
  /** Whether the runtime currently holds an agent for this session id. */
  hasAgentForSession(sessionId: string): boolean;
}

interface TrackedSession {
  file: string;
  sessionId: string;
  offset: number;
  partial: string;
  seenStart: boolean;
  seenStartAt: number;
  cwd: string | null;
  firstToolAt: number | null;
  startEmitted: boolean;
  ended: boolean;
  /** Startup-stale or finished before we ever saw it: never emit. */
  dead: boolean;
  /** This bridge (not the native hooks) is driving this session's events. */
  owned: boolean;
}

const POLL_MS = 1000;
/** How long to wait for the metadata record's workspace_root before falling
 *  back to the server's own cwd for the SessionStart. */
const CWD_WAIT_MS = 1500;

function sessionsRoot(): string {
  return path.join(os.homedir(), ...MUSE_SESSIONS_DIR_PARTS);
}

/** Session files for today and yesterday (local time), so a session that
 *  crosses midnight keeps being followed. */
function enumerateSessionFiles(root: string): string[] {
  const files: string[] = [];
  for (const dayOffset of [0, 1]) {
    const d = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dayDir = path.join(root, yyyy, mm, dd);
    let entries: string[];
    try {
      entries = fs.readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dayDir, entry, 'session.jsonl');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

export function startMuseSessionBridge(
  host: MuseSessionBridgeHost,
  opts?: {
    fallbackCwd?: string;
    areHooksInstalled?: () => boolean;
    /** Override for MUSE_BRIDGE_TAKEOVER_GRACE_MS (tests, tuning). */
    takeoverGraceMs?: number;
  },
): { stop(): void } {
  const root = sessionsRoot();
  const fallbackCwd = opts?.fallbackCwd ?? process.cwd();
  const hooksInstalled = opts?.areHooksInstalled ?? museHooksInstalledSync;
  const takeoverGraceMs = opts?.takeoverGraceMs ?? MUSE_BRIDGE_TAKEOVER_GRACE_MS;
  const tracked = new Map<string, TrackedSession>();
  let stopped = false;

  function emitStart(t: TrackedSession, force: boolean): void {
    if (t.startEmitted || t.ended || t.dead || !t.seenStart) return;
    const cwd = t.cwd ?? (force || Date.now() - t.seenStartAt > CWD_WAIT_MS ? fallbackCwd : null);
    if (!cwd) return;
    t.startEmitted = true;
    host.emit({
      session_id: t.sessionId,
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd,
    });
  }

  function handleRecord(t: TrackedSession, rec: Record<string, unknown>, replay: boolean): void {
    const payloadType = rec.payload_type;
    if (typeof payloadType !== 'string') return;
    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    const record = (payload.record ?? {}) as Record<string, unknown>;

    switch (payloadType) {
      case 'session.started':
        if (!t.seenStart) {
          t.seenStart = true;
          t.seenStartAt = Date.now();
        }
        break;

      case 'runtime.session.metadata':
        if (typeof record.workspace_root === 'string') t.cwd = record.workspace_root;
        break;

      case 'tool_batch.effect.started': {
        if (t.firstToolAt === null) t.firstToolAt = Date.now();
        if (replay || !t.owned) break;
        emitStart(t, true);
        host.emit({
          session_id: t.sessionId,
          hook_event_name: 'PreToolUse',
          tool_name: typeof record.tool_name === 'string' ? record.tool_name : '',
          tool_input: {},
          tool_use_id: typeof record.call_id === 'string' ? record.call_id : undefined,
        });
        break;
      }

      case 'tool_batch.effect.terminal':
        if (replay || !t.owned) break;
        host.emit({
          session_id: t.sessionId,
          hook_event_name: 'PostToolUse',
          tool_name: typeof record.tool_name === 'string' ? record.tool_name : '',
          tool_use_id: typeof record.call_id === 'string' ? record.call_id : undefined,
        });
        break;

      case 'approval_wait.effect.started':
        if (replay || !t.owned) break;
        emitStart(t, true);
        host.emit({
          session_id: t.sessionId,
          hook_event_name: 'PermissionRequest',
          tool_name: typeof record.tool_name === 'string' ? record.tool_name : '',
        });
        break;

      case 'session.end': {
        t.ended = true;
        if (replay || !t.owned || !t.startEmitted) break;
        host.emit({ session_id: t.sessionId, hook_event_name: 'Stop' });
        host.emit({
          session_id: t.sessionId,
          hook_event_name: 'SessionEnd',
          reason: typeof record.exit_reason === 'string' ? record.exit_reason : 'other',
        });
        break;
      }

      default:
        break;
    }

    if (!replay && t.owned) emitStart(t, false);
  }

  function handleLine(t: TrackedSession, line: string, replay: boolean): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj.retained_frame === 'session_permission_transaction' && Array.isArray(obj.children)) {
      for (const child of obj.children) {
        const recordJson = (child as Record<string, unknown>)?.record_json;
        if (typeof recordJson !== 'string') continue;
        try {
          handleRecord(t, JSON.parse(recordJson) as Record<string, unknown>, replay);
        } catch {
          /* a torn frame child is skipped, never fatal */
        }
      }
      return;
    }
    handleRecord(t, obj, replay);
  }

  /** Read bytes appended since the last poll. `replay` = the initial catch-up
   *  read of a newly discovered file: state is learned, nothing is emitted. */
  function readNew(t: TrackedSession, replay: boolean): void {
    let size: number;
    try {
      size = fs.statSync(t.file).size;
    } catch {
      return;
    }
    if (size < t.offset) {
      // File replaced (shouldn't happen for append-only logs): start over.
      t.offset = 0;
      t.partial = '';
    }
    if (size === t.offset) return;
    let chunk: string;
    try {
      const fd = fs.openSync(t.file, 'r');
      try {
        const buf = Buffer.alloc(size - t.offset);
        fs.readSync(fd, buf, 0, buf.length, t.offset);
        chunk = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    t.offset = size;
    const text = t.partial + chunk;
    const lines = text.split('\n');
    t.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) handleLine(t, line, replay);
    }
  }

  function discover(file: string): void {
    const sessionId = path.basename(path.dirname(file));
    const t: TrackedSession = {
      file,
      sessionId,
      offset: 0,
      partial: '',
      seenStart: false,
      seenStartAt: 0,
      cwd: null,
      firstToolAt: null,
      startEmitted: false,
      ended: false,
      dead: false,
      owned: false,
    };
    tracked.set(file, t);
    readNew(t, true);
    if (t.ended) {
      t.dead = true; // finished before we arrived; nothing to show
      return;
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > MUSE_BRIDGE_STALE_MS) {
        // No session.end but long untouched: a killed/crashed muse process.
        // Seating it would pin a ghost at a desk indefinitely.
        t.dead = true;
      }
    } catch {
      t.dead = true;
    }
  }

  function ownershipPass(): void {
    const installed = hooksInstalledSafe();
    for (const t of tracked.values()) {
      if (t.dead || t.ended || t.owned) continue;
      if (!installed) {
        t.owned = true;
        emitStart(t, true);
      } else if (
        t.firstToolAt !== null &&
        Date.now() - t.firstToolAt > takeoverGraceMs &&
        !host.hasAgentForSession(t.sessionId)
      ) {
        // Native hooks are installed but this session produced no agent:
        // hook delivery is broken for it, so the bridge takes over.
        t.owned = true;
        emitStart(t, true);
        console.log(
          `[Pixel Agents] Muse bridge: taking over session ${t.sessionId.slice(0, 8)}... ` +
            `(hooks installed but no agent appeared)`,
        );
      }
    }
  }

  function hooksInstalledSafe(): boolean {
    try {
      return hooksInstalled();
    } catch {
      return false;
    }
  }

  function poll(): void {
    if (stopped) return;
    const files = enumerateSessionFiles(root);
    const seen = new Set(files);
    for (const file of files) {
      const t = tracked.get(file);
      if (!t) {
        discover(file);
      } else if (!t.dead && !t.ended) {
        readNew(t, false);
      }
    }
    for (const file of [...tracked.keys()]) {
      if (!seen.has(file)) tracked.delete(file);
    }
    ownershipPass();
  }

  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();
  poll();
  console.log(`[Pixel Agents] Muse session bridge watching ${root}`);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
