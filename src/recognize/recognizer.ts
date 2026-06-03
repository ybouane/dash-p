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
  TranscriptBlock,
  TurnMetrics,
} from '../types.js';
import type { Profile } from './profile.js';

export class Recognizer {
  private readonly chromeRegexes: RegExp[];

  /**
   * @param reflow When true (default), rejoin paragraphs that the TUI hard-wrapped
   *   at the terminal width back into single lines (for `claude -p`-style output).
   *   Code fences, list items, headings, and blank lines are preserved. Disable
   *   if you need the screen's literal line breaks.
   */
  constructor(private readonly profile: Profile, private readonly reflow = true) {
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

    // 3. Parse the latest assistant turn into structured blocks (text +
    //    tool_use + tool_result) and derive the prose from them.
    const blocks = this.extractTurnBlocks(snap, contentRange);
    const assistantText = this.proseFromBlocks(blocks);
    const hasAssistant = blocks.some((b) => b.kind === 'text' || b.kind === 'tool_use');
    if (hasAssistant) matched.push('assistant-text');
    if (blocks.some((b) => b.kind === 'tool_use')) matched.push('tool-use');

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
      blocks,
      confidence,
      matched,
    };
    if (permission) rec.permission = permission;
    if (menu) rec.menu = menu;
    const metrics = this.scrapeMetrics(snap.viewport);
    if (metrics) rec.metrics = metrics;
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
   * Rejoin soft-wrapped rows into logical lines. The emulator wraps a long
   * paragraph across several rows and flags each continuation with `isWrapped`;
   * concatenating them reconstructs the original paragraph so a wrapped
   * assistant message becomes one logical line (e.g. "⏺ …the whole thing…").
   */
  private logicalLines(snap: ScreenSnapshot, range: { start: number; end: number }): string[] {
    const out: string[] = [];
    for (let i = range.start; i < range.end; i++) {
      const line = snap.lines[i] ?? '';
      if (snap.wrapped[i] && out.length > 0) {
        out[out.length - 1] += line; // continuation of the previous logical line
      } else {
        out.push(line);
      }
    }
    return out;
  }

  /**
   * Parse the latest assistant turn into ordered structured blocks. A turn is
   * everything after the most recent echoed user message; within it the TUI
   * renders:
   *   ⏺ Name(args)      → tool_use
   *     ⎿  output       → tool_result (indented continuations follow)
   *   ⏺ prose…          → text (indented continuations follow)
   */
  private extractTurnBlocks(snap: ScreenSnapshot, range: { start: number; end: number }): TranscriptBlock[] {
    const logical = this.logicalLines(snap, range);

    // Bound the turn to everything after the latest non-empty user echo.
    let userIdx = -1;
    for (let i = logical.length - 1; i >= 0; i--) {
      const t = logical[i]!.trimStart();
      if (this.startsWithAny(t, this.profile.userMarkers) && this.stripMarker(t, this.profile.userMarkers).trim()) {
        userIdx = i;
        break;
      }
    }
    const turn = logical.slice(userIdx + 1);

    const resultMarkers = this.profile.toolUse?.resultMarkers ?? [];
    const nameRe = this.profile.toolUse ? new RegExp(this.profile.toolUse.namePattern) : null;
    const blocks: TranscriptBlock[] = [];

    for (let i = 0; i < turn.length; ) {
      const raw = turn[i]!;
      const t = raw.trimStart();
      if (t === '' || this.isChrome(raw)) {
        i++;
        continue;
      }

      // Assistant marker: either a tool_use (Name(args)) or a prose text block.
      if (this.startsWithAny(t, this.profile.assistantMarkers)) {
        const content = this.stripMarker(raw, this.profile.assistantMarkers);
        const m = nameRe ? content.match(nameRe) : null;
        if (m) {
          let args = (m[2] ?? '').trim();
          if (args.endsWith(')')) args = args.slice(0, -1);
          blocks.push({ kind: 'tool_use', name: m[1]!, args });
          i++;
          continue;
        }
        const textLines = [content];
        i++;
        while (i < turn.length) {
          const nt = turn[i]!.trimStart();
          if (this.startsWithAny(nt, this.profile.assistantMarkers) || this.startsWithAny(nt, resultMarkers)) break;
          if (!this.isChrome(turn[i]!)) textLines.push(this.dedent(turn[i]!));
          i++;
        }
        const text = this.reflowText(textLines, snap.size.cols);
        if (text) blocks.push({ kind: 'text', text });
        continue;
      }

      // Tool result marker.
      if (this.startsWithAny(t, resultMarkers)) {
        const first = this.stripMarker(t, resultMarkers).trim();
        const resLines = first ? [first] : [];
        i++;
        while (i < turn.length) {
          const nraw = turn[i]!;
          const nt = nraw.trimStart();
          if (this.startsWithAny(nt, this.profile.assistantMarkers) || this.startsWithAny(nt, resultMarkers)) break;
          if (nt !== '' && !/^\s{2,}/.test(nraw)) break; // result continuations are indented
          if (!this.isChrome(nraw) && nt !== '') resLines.push(this.dedent(nraw));
          i++;
        }
        const resText = resLines.join('\n').trim();
        const errMarkers = this.profile.toolUse?.errorMarkers ?? [];
        const isError = errMarkers.some((mk) => resText.includes(mk));
        blocks.push(isError ? { kind: 'tool_result', text: resText, isError: true } : { kind: 'tool_result', text: resText });
        continue;
      }

      i++;
    }
    return blocks;
  }

  /** Scrape live token/duration metrics from the footer/status region. */
  private scrapeMetrics(viewport: string[]): TurnMetrics | undefined {
    const m = this.profile.metrics;
    if (!m) return undefined;
    const text = viewport.join('\n');
    const num = (src: string | undefined): number | undefined => {
      if (!src) return undefined;
      const match = text.match(new RegExp(src));
      if (!match || !match[1]) return undefined;
      const n = parseInt(match[1].replace(/,/g, ''), 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const out: TurnMetrics = {};
    const o = num(m.outputTokens);
    const c = num(m.contextTokens);
    const d = num(m.durationSeconds);
    if (o !== undefined) out.outputTokens = o;
    if (c !== undefined) out.contextTokens = c;
    if (d !== undefined) out.durationSec = d;
    return Object.keys(out).length ? out : undefined;
  }

  private proseFromBlocks(blocks: TranscriptBlock[]): string | null {
    const text = blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('\n\n')
      .trim();
    return text.length ? text : null;
  }

  /** Strip the TUI's 2-space alignment indent from a continuation line. */
  private dedent(line: string): string {
    return line.replace(/^ {1,2}/, '').replace(/\s+$/, '');
  }

  /**
   * Rejoin paragraphs the TUI hard-wrapped at the terminal width. Claude's TUI
   * wraps text itself (each row is its own buffer line, not a soft-wrap), so we
   * reconstruct paragraphs heuristically: a line that fills ~the full width is
   * treated as a wrap and joined with the next; a short line ends the paragraph.
   * Code fences, list items, headings, blockquotes, tables and blank lines are
   * preserved verbatim so we don't mangle structured content.
   */
  private reflowText(lines: string[], width: number): string {
    const collapse = (s: string) => s.replace(/\n{3,}/g, '\n\n').trim();
    const clean = lines.map((l) => l.replace(/\s+$/, ''));
    if (!this.reflow) return collapse(clean.join('\n'));

    // Width the TUI wrapped at: terminal columns minus the ~2-space assistant
    // indent. A line wrapped (vs. ended on a real newline) iff the first word of
    // the next line would not have fit on it — the exact inverse of word-wrap.
    const wrapWidth = Math.max(20, width - 2);
    const isFence = (t: string) => /^```|^~~~/.test(t);
    // The START of a structural item (new list bullet, heading, quote, table row).
    // A *continuation* of one is plain prose and gets absorbed below.
    const isStructStart = (t: string) => /^([-*+•]|\d+[.)]|#{1,6}\s|>|\|)/.test(t);

    const out: string[] = [];
    let inFence = false;
    let i = 0;
    while (i < clean.length) {
      const line = clean[i]!;
      const t = line.trim();
      if (isFence(t)) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }
      if (inFence) {
        out.push(line);
        i++;
        continue;
      }
      if (t === '') {
        out.push('');
        i++;
        continue;
      }
      // Start a text unit (prose paragraph OR list item / heading) and absorb the
      // rows it was force-wrapped across. Stop at a blank, a fence, a NEW
      // structural item, or a row where the next word would have fit (real break).
      let para = line;
      let lastLen = line.length;
      i++;
      while (i < clean.length) {
        const next = clean[i]!;
        const nt = next.trim();
        if (nt === '' || isFence(nt) || isStructStart(nt)) break;
        const firstWord = nt.split(/\s+/)[0] ?? '';
        if (lastLen + 1 + firstWord.length <= wrapWidth) break;
        para += ' ' + nt;
        lastLen = next.length;
        i++;
      }
      out.push(para);
    }
    return collapse(out.join('\n'));
  }

  /** Clean the full content region to plain text (used for low-confidence fallback). */
  cleanTranscript(snap: ScreenSnapshot, range: { start: number; end: number }): string {
    return this.logicalLines(snap, range)
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
