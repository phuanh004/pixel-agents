/**
 * Muse (Meta) specific constants. Kept separate from `server/src/constants.ts`
 * so a single-provider build doesn't accidentally depend on Muse unless Muse
 * is the active provider — same pattern as `providers/hook/claude/constants.ts`.
 */

/** Output filename after esbuild compiles muse-hook.ts to CJS (source is .ts, output is .js) */
export const MUSE_HOOK_SCRIPT_NAME = 'muse-hook.js';

/** Hook events to install in ~/.config/muse/settings.json.
 *
 *  Muse's hook support is wire-compatible with Claude Code's: same settings
 *  shape (`hooks.<Event>[].hooks[].command`), same JSON payload fields on
 *  stdin (`session_id`, `hook_event_name`, `tool_name`, `tool_input`,
 *  `tool_use_id`, `cwd`). Verified empirically against Muse v1.4.13
 *  (2026-10-26): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *  Stop, SubagentStart, SubagentStop and SessionEnd all fire with
 *  Claude-Code-shaped payloads.
 *
 *  This list is the whole data-collection surface, mirroring the Claude
 *  provider's rule: an event we do not act on is scope we should not ask for.
 *  Deliberately NOT installed:
 *  - UserPromptSubmit: normalizes to null (nothing consumes it) and would
 *    forward the user's prompt text to the server only to be dropped.
 *  - SubagentStart/SubagentStop: Muse fires these for its own internal
 *    reminder subagents (skill/goal/verify reminders) with child session ids;
 *    they are runtime noise, not user-visible agents. Real delegation
 *    surfaces as the `subagent_spawn` tool on the parent session.
 *  - Notification: Muse has no permission_prompt/idle_prompt notifications
 *    under --approval-mode never; PermissionRequest covers the approval path
 *    when approvals are interactive. */
export const MUSE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
] as const;

/** Suffix of the one-time pre-modification backup of settings.json. Same
 *  brand-named suffix as the Claude installer: a foreign `.backup` must not
 *  make us believe we already saved the user's original. */
export const SETTINGS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a settings.json we create ourselves. An existing file's mode is
 *  preserved instead; this is only the fresh-file default. */
export const SETTINGS_FRESH_FILE_MODE = 0o600;

/** Attempts for the settings.json read-modify-write cycle (see the Claude
 *  installer's constants for the full rationale: the verify narrows the
 *  lost-update window, it does not eliminate it). */
export const SETTINGS_MUTATE_ATTEMPTS = 3;
/** Delay between settings.json mutation attempts. */
export const SETTINGS_MUTATE_RETRY_DELAY_MS = 100;

/** Where Muse keeps its session transcripts:
 *  ~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<session-id>/session.jsonl */
export const MUSE_SESSIONS_DIR_PARTS = ['.local', 'share', 'muse', 'sessions'] as const;

/** How long a session file may sit untouched before the session bridge treats
 *  it as dead at startup (a crashed or killed muse process leaves no
 *  session.end record; resurrecting its desk would be a ghost). */
export const MUSE_BRIDGE_STALE_MS = 15 * 60 * 1000;

/** Grace period after a session's first observed tool activity before the
 *  bridge takes over a session whose native hooks are installed but have
 *  produced no agent (e.g. hooks silently broken by a Muse update). */
export const MUSE_BRIDGE_TAKEOVER_GRACE_MS = 4000;
