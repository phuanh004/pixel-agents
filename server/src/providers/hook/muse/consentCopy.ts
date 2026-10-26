/**
 * Disclosure text for the Muse (Meta) hooks consent gate. Mirrors the
 * Claude provider's consentCopy.ts structure: the server ships these strings
 * in the `hooksConsentRequest` message and the webview renders them verbatim,
 * so there is exactly one copy of the terms. The event count is interpolated
 * from MUSE_HOOK_EVENTS, never written out.
 */

import { MUSE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.config/muse/settings.json';

/** WHY we ask + WHAT we write. */
export const CONSENT_FACT_WHAT =
  `To bring your Muse (Meta) sessions to life in real time, Pixel Agents adds hooks for ` +
  `${MUSE_HOOK_EVENTS.length} Muse events to ${SETTINGS_FILE}. ` +
  `Note that your existing settings are kept, and a one-time backup is saved as settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops. */
export const CONSENT_FACT_DATA =
  'Muse will send those events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
  'you explicitly start it with --host to expose it on your network.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate. Carries NO disclosure facts by design:
 *  the facts all live in CONSENT_DISCLOSURE. */
export const CONSENT_INSTALL_HEADLINE = 'One more thing: hooks!';

/** The three disclosure facts, in order, as one block. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
