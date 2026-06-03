# dash-p — Design

## Goal

Reproduce `claude -p` (and a useful subset of the Agent SDK) **without** the
`-p` flag, by automating the real interactive Claude Code TUI: spawn it in a
pseudo-terminal, inject prompts, read the rendered screen back, and reconstruct
a clean result. It's an experiment whose central engineering problem is
**containing fragility** — the output is a constantly-redrawing, animated
terminal canvas, and the UI changes often.

## Why this is hard (and the design response)

| Problem | Response |
|---|---|
| TUI detects non-TTY and degrades | Real PTY (`node-pty`); answer device queries via `@xterm/headless` |
| Screen is a redraw canvas, not a stream | Headless terminal emulator maintains the cell grid + scrollback |
| Animations never stop (spinner, gradient) | Region-masked quiescence: hash content with animated tokens stripped |
| "Done?" is ambiguous | Footer is authoritative (`esc to interrupt` vs `? for shortcuts`) + quiescence |
| UI changes between versions | All literals live in version-keyed JSON profiles; engine is Claude-agnostic |
| Extraction can break silently | Confidence score + raw-transcript fallback flagged `degraded` |

## Layered architecture

```
 8. CLI / SDK        user surface
 7. Controller       state machine, per-turn lifecycle           src/controller/engine.ts
 6. Action           inject input                                src/act/
 5. Recognition      screen → {state, regions}  ◀ Claude-specific src/recognize/
 4. Observation      quiescence / settle detection               src/observe/
 3. Emulation        bytes → virtual screen                      src/emulation/
 2. Transport        PTY spawn / IO                              src/transport/
 1. Process          the `claude` child
```

**Invariant:** layers 1–4 contain zero Claude knowledge. All of it is in layer 5
and, crucially, expressed as **data** in `profiles/claude-<version>.json`. A TUI
redesign should be fixable by editing a profile.

## State machine

```
launching → ready → submitting → thinking → streaming → ready(complete)
                                     │            │
                                     └─ tool_permission / menu ─┘
```

- **submitting**: prompt pasted (bracketed paste) + Enter; waiting for movement.
- **thinking**: footer shows busy, no `⏺` assistant marker yet.
- **streaming**: `⏺` assistant text growing.
- **complete**: footer idle again *and* content stable for `quietMs`.

Completion requires *both* "the model started" (saw busy) *and* "back to idle +
quiescent" — so a fast reply and a long one are both handled, and a lingering
done-status animation doesn't fool it.

## What the real 2.1.x TUI taught us (calibration)

Captured via `probes/capture.ts`:

- Input box is **not** a box — it's a single `❯` prompt line between two
  full-width `────` rules, with a footer below.
- `❯` is overloaded: input prompt **and** user-message prefix **and**
  menu-selected marker. Disambiguated by structure (a menu needs ≥2 options;
  the input prompt is one `❯` line between rules).
- Assistant messages prefix `⏺`. User echoes prefix `❯`.
- The footer — not the spinner — tells you busy vs idle. The post-completion
  `✻ Crunched for 1s` line reuses a spinner glyph while already idle.
- A workspace-trust dialog appears on first entry to a directory (the engine
  auto-accepts it, mirroring `-p`).

## Key decisions

- **TypeScript + node-pty + @xterm/headless.** The emulator is the same engine
  as VS Code's terminal → ANSI parity with real terminals, and it generates the
  correct device-query replies for free. Claude Code is itself Node/Ink, so both
  ends behave consistently.
- **Profiles as JSON, not code.** Swappable, diffable, machine-writable by the
  recalibration skill.
- **Large scrollback (50k lines)** so long answers survive scrolling without a
  separate incremental accumulator (a known limit beyond that window).
- **Env scrubbing.** `CLAUDECODE`/`CLAUDE_CODE_*` are stripped from the child so
  a dash-p running *inside* Claude Code still spawns a fresh top-level session.

## "Anti-detection" = terminal fidelity (not evasion)

The only "detection" that matters is the TUI deciding whether it's attached to a
real, capable terminal. We satisfy that honestly: a real PTY, correct `TERM`,
answered device queries, a plausible window size, and *no* `CI=1` (which would
suppress the animations we want to observe). This is emulation correctness. We do
not spoof identity or evade server-side controls — there's nothing to evade for a
local experiment on your own account, and the sanctioned SDK exists anyway.

## Known limitations

- Tool `input` is the **rendered** args string (`{ raw }`), not the model's JSON,
  and the TUI may width-truncate long args/results — a screen-scraping ceiling.
- **Reflow is heuristic.** Claude's TUI hard-wraps text itself (each row is its
  own buffer line, `isWrapped` is false), so we can't rely on the terminal's
  soft-wrap flag. Instead we rejoin paragraphs with the inverse of word-wrap: a
  row is a wrap (not a real break) iff the first word of the next row would not
  have fit on it. Code fences, lists, headings, quotes, and tables are preserved.
  A real break landing exactly at the wrap width can still be misjoined; use
  `reflow: false` for verbatim line breaks.
- Output is bounded by the emulator scrollback (100k lines); streamed-delta
  accumulation keeps the prose result complete even past that, but structured
  tool blocks are bounded by what's still on-screen.
- `setModel()` mid-session is best-effort via the `/model` command (the TUI may
  open a picker for some inputs); prefer `options.model` at query time.
