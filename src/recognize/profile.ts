/**
 * Profile = all Claude-specific knowledge, expressed as *data* not code.
 *
 * A profile is keyed to a Claude Code version. When the TUI changes, you edit a
 * JSON profile (by hand, or via the auto-recalibration skill) — never the
 * engine. The recognizer reads these literals; it hardcodes nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Profile {
  /** semver range / exact version this profile was characterised against. */
  generatedFor: string;
  /** Structural anchors that delimit the input box (chrome vs content). */
  inputBox: {
    /** Box-drawing glyphs that frame the prompt region. */
    borderGlyphs: string[];
    /** Prompt markers shown inside the box (e.g. the leading "> "). */
    promptMarkers: string[];
    /** Placeholder strings shown when the box is empty. */
    placeholders: string[];
  };
  /** Footer/status text shown while the model is generating. */
  busyMarkers: string[];
  /** Footer/status text shown while idle (optional, used to confirm READY). */
  idleMarkers: string[];
  /** Animation frame glyphs (spinners, etc.) to mask from quiescence + content. */
  spinnerGlyphs: string[];
  permission: {
    /** Phrases that indicate a tool-permission prompt is open. */
    triggers: string[];
    /** Option labels meaning yes/allow/proceed. */
    affirmative: string[];
    /** Option labels meaning no/deny/cancel. */
    negative: string[];
  };
  menu: {
    /** Marker(s) on the currently-highlighted option (e.g. "❯"). */
    selectedMarkers: string[];
    /** Marker(s) that prefix selectable options. */
    optionMarkers: string[];
  };
  /** Startup gates that appear before the input box is usable. */
  startup?: {
    /** Text that identifies the workspace-trust dialog (auto-accepted if enabled). */
    trustTriggers?: string[];
  };
  /** Glyph(s) prefixing an assistant message in the transcript (e.g. "⏺"). */
  assistantMarkers: string[];
  /** Marker(s) prefixing an echoed user message. */
  userMarkers: string[];
  /** Regex sources; matching lines are dropped as chrome during extraction. */
  chromePatterns: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
// dist/recognize -> ../../profiles ; src/recognize -> ../../profiles
const PROFILE_DIR = join(here, '..', '..', 'profiles');

/**
 * Pick the best profile for a given `claude --version` string. For now we match
 * on exact version with a fallback to the bundled default. The recalibration
 * skill writes new `claude-<version>.json` files here.
 */
export function loadProfile(version: string): Profile {
  const exact = join(PROFILE_DIR, `claude-${version}.json`);
  const fallback = join(PROFILE_DIR, 'default.json');
  const path = existsSync(exact) ? exact : fallback;
  if (!existsSync(path)) {
    throw new Error(`No profile found for version "${version}" (looked in ${PROFILE_DIR})`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Profile;
}
