import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import { MUSE_SESSIONS_DIR_PARTS } from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './museHookInstaller.js';

// ── formatToolStatus ────────────────────────────────────────
//
// Muse tool names (observed in real session logs, v1.4.13): read_file,
// edit_file, write_file, bash, search, web_fetch, read_skill, subagent_spawn,
// plus MCP tools named mcp__<server>__<tool>. Tool inputs mirror Claude
// Code's shapes (read_file carries `path`, bash carries `command`).

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'read_file':
      return `Reading ${base(inp.path) || base(inp.file_path)}`;
    case 'edit_file':
      return `Editing ${base(inp.path) || base(inp.file_path)}`;
    case 'write_file':
      return `Writing ${base(inp.path) || base(inp.file_path)}`;
    case 'bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'search':
      return 'Searching code';
    case 'web_fetch':
      return 'Fetching web content';
    case 'read_skill':
      return 'Reading skill';
    case 'subagent_spawn': {
      const desc =
        typeof inp.description === 'string'
          ? inp.description
          : typeof inp.task === 'string'
            ? inp.task
            : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    default:
      return `Using ${toolName}`;
  }
}

// ── Session dirs + launch command ───────────────────────────

/** Root that holds every Muse session across all workspaces:
 *  ~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl.
 *  Used by the global session scanner ("Watch All Sessions"). */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), ...MUSE_SESSIONS_DIR_PARTS)];
}

/** Muse has no --session-id flag (sessions are named/resumed by id inside
 *  the TUI), so launching is a plain `muse` in the session's directory. */
function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
  _opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'muse', args: [], env: { PWD: cwd } };
}

// ── normalizeHookEvent: the single Muse-specific normalization boundary ──
//
// Muse's hook payloads are wire-compatible with Claude Code's (verified
// empirically against v1.4.13): same field names, same event names. The
// differences that matter live here:
//
// - SessionStart carries `transcript_path: null`. We normalize WITHOUT a
//   transcriptPath on purpose: external-session adoption keys the tracked-
//   project check off dirname(transcriptPath) when one is present, and a
//   Muse transcript lives under ~/.local/share/muse/sessions/..., not in
//   the project. Keying off `cwd` (the project the session runs in) is the
//   correct match. The agent is adopted as a hooks-only agent; the session
//   bridge (museSessionBridge.ts) covers sessions whose hooks never fire.
// - SubagentStart/SubagentStop fire for Muse's INTERNAL reminder subagents
//   (skill-reminder, goal-reminder, verify-reminder) whose session_id is a
//   child id, not the user's session. Normalizing them would spawn ghost
//   characters, so they are dropped. Real delegation is the `subagent_spawn`
//   tool on the parent session.
// - SessionEnd reason is 'other' for a clean `muse exec` exit (Claude uses
//   'exit'/'logout'/'clear'); every reason is final for Muse — there is no
//   /clear flow that reuses the process — so the raw reason passes through.

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
          runInBackground: toolInput.run_in_background === true,
        },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          // Deliberately no transcriptPath — see the header comment.
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    // Dropped on purpose (see header): prompt text is never consumed, and
    // Muse's subagent events describe internal reminder machinery whose
    // session ids are not user sessions. Stale installs may still POST any
    // of these, so the drops stay graceful.
    case 'UserPromptSubmit':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'Notification':
    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  await installerInstallHooks();
}

async function uninstallHooks(): Promise<void> {
  await installerUninstallHooks();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

/** This provider's first-run consent terms (consentCopy.ts). */
function consentDisclosure(): { headline: string; disclosure: string } {
  return { headline: CONSENT_INSTALL_HEADLINE, disclosure: CONSENT_DISCLOSURE };
}

// ── The provider ──

export const museProvider: HookProvider = {
  kind: 'hook',
  id: 'muse',
  displayName: 'Muse (Meta)',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['subagent_spawn']),
  subagentToolNames: new Set(['subagent_spawn']),
  readingTools: new Set(['read_file', 'search', 'web_fetch', 'read_skill']),

  getAllSessionRoots,
  sessionFilePattern: 'session.jsonl',
  buildLaunchCommand,
};
