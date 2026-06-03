/**
 * Recognition layer — classify a screen snapshot into a state + regions.
 *
 * Everything here is driven by the Profile (data). The logic is structural and
 * text-based: it keys off the input-box chrome, footer signals, and marker
 * glyphs — never off colour or animation. A low confidence score is the signal
 * for the controller to fall back to a raw dump rather than trust extraction.
 */
import type {
  EngineState,
  MenuPrompt,
  PermissionPrompt,
  Recognition,
  ScreenSnapshot,
} from '../types.js';
import type { Profile } from './profile.js';

export class Recognizer {
  private readonly chromeRegexes: RegExp[];

  constructor(private readonly profile: Profile) {
    this.chromeRegexes = profile.chromePatterns.map((p) => new RegExp(p));
  }

  recognize(snap: ScreenSnapshot): Recognition {
    const matched: string[] = [];

    // 1. Locate the bottom chrome block (the input box). Content lives above it.
    const inputBoxStart = this.findInputBoxStart(snap.lines);
    if (inputBoxStart !== null) matched.push('input-box');
    const contentEnd = inputBoxStart ?? snap.lines.length;
    const contentRange = { start: 0, end: contentEnd };

    // 2. Look at the lower region (viewport) for live state signals.
    //
    // The FOOTER is authoritative for busy/idle: "esc to interrupt" while the
    // model generates, "? for shortcuts" when idle. The spinner glyph is NOT a
    // reliable busy signal — the post-completion line "✻ Crunched for 1s" reuses
    // a spinner glyph while the footer is already idle. So the footer wins.
    const lower = snap.viewport;

    const idle = this.hasAny(lower, this.profile.idleMarkers);
    if (idle) matched.push('idle-marker');
    const busy = this.hasAny(lower, this.profile.busyMarkers) && !idle;
    if (busy) matched.push('busy-marker');
    const spinning = this.hasSpinner(lower); // kept for debug/masking, not state

    const permission = this.detectPermission(snap.lines);
    if (permission) matched.push('permission');

    const menu = permission ? null : this.detectMenu(snap.lines);
    if (menu) matched.push('menu');

    // 3. Does the content region already contain assistant output?
    const assistantText = this.extractLatestAssistant(snap.lines, contentRange);
    const hasAssistant = !!assistantText && assistantText.trim().length > 0;
    if (hasAssistant) matched.push('assistant-text');

    // 4. Decide state by priority.
    let state: EngineState;
    if (inputBoxStart === null && !busy && !permission && !menu) {
      state = 'launching';
    } else if (permission) {
      state = 'tool_permission';
    } else if (menu) {
      state = 'menu';
    } else if (busy) {
      state = hasAssistant ? 'streaming' : 'thinking';
    } else {
      // Input box present, footer idle → ready/complete.
      state = 'ready';
    }

    // 5. Confidence: anchored if we found the box and a coherent state.
    const confidence = this.scoreConfidence({
      foundBox: inputBoxStart !== null,
      busy,
      permission: !!permission,
      menu: !!menu,
      hasAssistant,
    });

    const rec: Recognition = {
      state,
      contentRange,
      assistantText: hasAssistant ? assistantText : null,
      confidence,
      matched,
    };
    if (permission) rec.permission = permission;
    if (menu) rec.menu = menu;
    return rec;
  }

  /**
   * Scan from the bottom up; the input box is the trailing run of lines that are
   * all chrome (box borders, prompt markers, footer hints, blanks). Returns the
   * index of the first such line, or null if no box is visible yet.
   */
  private findInputBoxStart(lines: string[]): number | null {
    let i = lines.length - 1;
    // Skip trailing blank lines.
    while (i >= 0 && lines[i]!.trim() === '') i--;
    if (i < 0) return null;

    let boxStart: number | null = null;
    let sawBorder = false;
    for (; i >= 0; i--) {
      const line = lines[i]!;
      if (this.isInputBoxLine(line)) {
        boxStart = i;
        if (this.containsAny(line, this.profile.inputBox.borderGlyphs)) sawBorder = true;
        continue;
      }
      // Allow blank lines inside the chrome block.
      if (line.trim() === '' && boxStart !== null) {
        boxStart = i;
        continue;
      }
      break;
    }
    return sawBorder ? boxStart : boxStart; // boxStart may be null
  }

  private isInputBoxLine(line: string): boolean {
    if (this.containsAny(line, this.profile.inputBox.borderGlyphs)) return true;
    if (this.containsAny(line, this.profile.inputBox.promptMarkers)) return true;
    if (this.containsAny(line, this.profile.inputBox.placeholders)) return true;
    if (this.containsAny(line, this.profile.busyMarkers)) return true;
    if (this.containsAny(line, this.profile.idleMarkers)) return true;
    return false;
  }

  private detectPermission(lines: string[]): PermissionPrompt | null {
    const idx = lines.findIndex((l) => this.containsAny(l, this.profile.permission.triggers));
    if (idx === -1) return null;
    // Gather option-like lines in the window after the trigger.
    const window = lines.slice(idx, Math.min(lines.length, idx + 12));
    const options: string[] = [];
    let defaultIndex: number | null = null;
    for (const raw of window) {
      const l = raw.trim();
      if (!l) continue;
      const isOpt =
        /^[❯▶●○◯]/.test(l) || /^\(?\d+[.)]/.test(l) ||
        this.containsAny(l, this.profile.permission.affirmative) ||
        this.containsAny(l, this.profile.permission.negative);
      if (isOpt) {
        const label = l.replace(/^[❯▶●○◯]\s*/, '').replace(/^\(?\d+[.)]\s*/, '');
        if (this.containsAny(label, this.profile.permission.affirmative) && defaultIndex === null) {
          defaultIndex = options.length;
        }
        options.push(label);
      }
    }
    const question = lines[idx]!.trim();
    return { question, options, defaultIndex };
  }

  private detectMenu(lines: string[]): MenuPrompt | null {
    const selIdx = lines.findIndex((l) => this.startsWithAny(l.trim(), this.profile.menu.selectedMarkers));
    if (selIdx === -1) return null;
    // Collect contiguous option lines around the selection.
    const options: string[] = [];
    let selectedIndex: number | null = null;
    let start = selIdx;
    while (start - 1 >= 0 && this.looksLikeMenuOption(lines[start - 1]!)) start--;
    for (let i = start; i < lines.length && this.looksLikeMenuOption(lines[i]!); i++) {
      const l = lines[i]!.trim();
      if (this.startsWithAny(l, this.profile.menu.selectedMarkers)) selectedIndex = options.length;
      options.push(l.replace(/^[❯▶●○◯]\s*/, ''));
    }
    // A real selection menu has at least two options. This is what
    // disambiguates a genuine menu from the input prompt, whose marker (❯) is
    // the same glyph but appears as a single line between horizontal rules.
    if (options.length < 2) return null;
    const title = start - 1 >= 0 ? lines[start - 1]!.trim() || null : null;
    return { title, options, selectedIndex };
  }

  private looksLikeMenuOption(line: string): boolean {
    const l = line.trim();
    if (!l) return false;
    return (
      this.startsWithAny(l, this.profile.menu.selectedMarkers) ||
      this.startsWithAny(l, this.profile.menu.optionMarkers) ||
      /^\(?\d+[.)]/.test(l)
    );
  }

  /**
   * Extract the most recent assistant message from the content region. Best
   * effort for v1: take text after the last assistant marker, drop chrome lines.
   */
  private extractLatestAssistant(lines: string[], range: { start: number; end: number }): string | null {
    const slice = lines.slice(range.start, range.end);
    // Find the last assistant marker line. Without one there is no assistant
    // turn yet (e.g. we're still in the thinking phase) — return null so the
    // controller reports `thinking` and we don't stream pre-response chrome.
    let last = -1;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (this.startsWithAny(slice[i]!.trimStart(), this.profile.assistantMarkers)) {
        last = i;
        break;
      }
    }
    if (last === -1) return null;
    const body = slice.slice(last);
    const cleaned = body
      .map((l) => this.stripMarker(l, this.profile.assistantMarkers))
      .filter((l) => !this.isChrome(l));
    const text = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.length ? text : null;
  }

  /** Clean the full content region to plain text (used for low-confidence fallback). */
  cleanTranscript(snap: ScreenSnapshot, range: { start: number; end: number }): string {
    return snap.lines
      .slice(range.start, range.end)
      .filter((l) => !this.isChrome(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isChrome(line: string): boolean {
    return this.chromeRegexes.some((re) => re.test(line));
  }

  private stripMarker(line: string, markers: string[]): string {
    const trimmed = line.trimStart();
    for (const m of markers) {
      if (trimmed.startsWith(m)) return trimmed.slice(m.length).trimStart();
    }
    return line;
  }

  private hasSpinner(lines: string[]): boolean {
    return lines.some((l) => this.containsAny(l, this.profile.spinnerGlyphs));
  }

  private hasAny(lines: string[], needles: string[]): boolean {
    return lines.some((l) => this.containsAny(l, needles));
  }

  private containsAny(line: string, needles: string[]): boolean {
    return needles.some((n) => n.length > 0 && line.includes(n));
  }

  private startsWithAny(line: string, needles: string[]): boolean {
    return needles.some((n) => n.length > 0 && line.startsWith(n));
  }

  private scoreConfidence(s: {
    foundBox: boolean;
    busy: boolean;
    permission: boolean;
    menu: boolean;
    hasAssistant: boolean;
  }): number {
    let c = 0;
    if (s.foundBox) c += 0.5;
    if (s.busy) c += 0.2;
    if (s.permission || s.menu) c += 0.2;
    if (s.hasAssistant) c += 0.2;
    return Math.min(1, c || 0.1);
  }
}
