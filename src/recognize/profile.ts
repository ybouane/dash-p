/**
 * Profile = all Claude-specific knowledge, expressed as *data* not code.
 *
 * A profile is keyed to a Claude Code version. When the TUI changes, you edit a
 * JSON profile (by hand, or via the auto-recalibration skill) — never the
 * engine. The recognizer reads these literals; it hardcodes nothing.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  /** How tool calls render in the transcript. */
  toolUse?: {
    /** Marker(s) prefixing a tool result line (e.g. "⎿"). */
    resultMarkers: string[];
    /** Regex matching an assistant line that is a tool call: "Name(args". */
    namePattern: string;
    /** Substrings that mark a tool result as an error (best-effort). */
    errorMarkers?: string[];
  };
  /** Regex sources (with a capture group) for scraping live metrics from the footer. */
  metrics?: {
    /** Output tokens generated this turn, e.g. "↓ 51 tokens". */
    outputTokens?: string;
    /** Context/total tokens shown on the busy footer, e.g. "20341 tokens". */
    contextTokens?: string;
    /** Elapsed seconds shown in the status line, e.g. "(2s · …)". */
    durationSeconds?: string;
  };
  /** Regex sources; matching lines are dropped as chrome during extraction. */
  chromePatterns: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
// dist/recognize -> ../../profiles ; src/recognize -> ../../profiles
const PROFILE_DIR = join(here, '..', '..', 'profiles');

export interface ProfileSelection {
  profile: Profile;
  /** The chosen file, e.g. "claude-2.1.177.json" or "default.json". */
  file: string;
  /** The profile version chosen, or null when falling back to default. */
  matchedVersion: string | null;
  /** True when the chosen profile's version differs from the installed one. */
  drifted: boolean;
}

/** Parse "2.1.177 (Claude Code)" / "claude-2.1.177.json" → [2,1,177]. */
function parseVersion(v: string): [number, number, number] | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVersion(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Weighted absolute distance (major ≫ minor ≫ patch) for the no-`<=` fallback. */
function versionDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) * 1e6 + Math.abs(a[1] - b[1]) * 1e3 + Math.abs(a[2] - b[2]);
}

/**
 * Pick the best profile for an installed `claude --version`, by nearest version:
 *   1. the highest `claude-<v>.json` whose version is <= the installed version
 *      (so a patch bump with no dedicated profile reuses the closest one below);
 *   2. if none qualify (all profiles are newer), the closest profile by distance;
 *   3. only if there are no version profiles at all, fall back to `default.json`.
 */
export function selectProfile(version: string, dir: string = PROFILE_DIR): ProfileSelection {
  const installed = parseVersion(version);
  const candidates = (existsSync(dir) ? readdirSync(dir) : [])
    .map((file) => ({ file, v: parseVersion(file.replace(/^claude-/, '').replace(/\.json$/, '')) }))
    .filter((c): c is { file: string; v: [number, number, number] } => /^claude-/.test(c.file) && c.v !== null)
    .sort((a, b) => cmpVersion(a.v, b.v));

  let chosen: { file: string; v: [number, number, number] } | null = null;
  if (candidates.length && installed) {
    const atOrBelow = candidates.filter((c) => cmpVersion(c.v, installed) <= 0);
    chosen = atOrBelow.length
      ? atOrBelow[atOrBelow.length - 1]! // highest <= installed
      : candidates.reduce((best, c) => (versionDistance(c.v, installed) < versionDistance(best.v, installed) ? c : best));
  } else if (candidates.length) {
    chosen = candidates[candidates.length - 1]!; // unparseable installed → newest available
  }

  const file = chosen ? chosen.file : 'default.json';
  const path = join(dir, file);
  if (!existsSync(path)) {
    throw new Error(`No profile found for version "${version}" (looked in ${dir})`);
  }
  const profile = JSON.parse(readFileSync(path, 'utf8')) as Profile;
  const matchedVersion = chosen ? chosen.v.join('.') : null;
  return { profile, file, matchedVersion, drifted: !!installed && matchedVersion !== installed.join('.') };
}

export function loadProfile(version: string): Profile {
  return selectProfile(version).profile;
}
