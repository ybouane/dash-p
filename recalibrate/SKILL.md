---
name: recalibrate-dash-p
description: >
  Recalibrate dash-p's recognition profile when a new Claude Code version ships.
  Drives the new TUI with probe scenarios, reads the captured frames, rewrites
  profiles/claude-<version>.json, and validates it before promotion. TRIGGER
  when `claude --version` changes vs the newest profiles/claude-*.json, or when
  dash-p starts returning `degraded: true` / low-confidence results.
---

# Recalibrate dash-p

dash-p reads the Claude TUI by matching **literals** (markers, glyphs, anchors)
stored in `profiles/claude-<version>.json`. When the TUI changes, those literals
drift and extraction degrades. This skill regenerates the profile from **evidence
captured against the real TUI** — never by guessing.

The split that makes this reliable: a **dumb harness** (`probes/capture.ts`)
captures ground-truth frames; **you (the agent)** interpret them and rewrite the
profile; a **validation gate** proves the rewrite works before it's promoted.

## When to run

- A scheduled check finds `claude --version` differs from the newest
  `profiles/claude-*.json` filename.
- Users report `degraded: true` results or confidence consistently < 0.5.

## Procedure

### 1. Detect the version

```bash
claude --version          # e.g. "2.1.180 (Claude Code)"
ls profiles/              # newest characterised version
```

If a profile already exists for this version, stop. Otherwise continue, seeding
the new profile from the closest existing one (copy it to
`profiles/claude-<new>.json`).

### 2. Capture ground truth

Run the probe to drive the real TUI and dump what it renders:

```bash
CLAUDE_PATH=$(which claude) RUN_MS=30000 npm run probe -- "Reply with exactly: hello from the tui"
```

Outputs to `fixtures/`:
- `spike-frames.txt` — distinct viewport frames over time, each tagged with the
  recognizer's `state`/`confidence`/`matched` so you can see *where* it misreads.
- `spike-final-buffer.txt` — full scrollback at the end.
- `spike-recognition.json` — the recognizer's verdict on the final frame.

Run additional probes for the states a single prompt won't surface (extend the
probe's scripted input for these):
- **busy/spinner** — a slow prompt; capture the busy footer text + spinner frames.
- **permission** — a prompt that triggers a tool the model must ask about.
- **menu** — `/model` or a mode picker; capture option markers + nav.
- **animation** — type "workflows"; confirm colour-strip yields the literal word.

### 3. Read the frames and update the profile

Open `fixtures/spike-frames.txt`. For each field in
`profiles/claude-<version>.json`, confirm or correct it against what you see.
Field-by-field, here is what to look for (and the traps found in 2.1.x):

| Profile field | What to extract from the frames |
|---|---|
| `inputBox.promptMarkers` | The glyph beginning the input line. **Trim-aware**: an *empty* prompt renders as just `❯` (trailing space trimmed), so a marker of `"❯ "` won't match — use the bare glyph. |
| `inputBox.borderGlyphs` | Box/rule chars framing the input (2.1.x uses full-width `─` rules, not a box). |
| `idleMarkers` | Footer text when idle (`? for shortcuts`). **Authoritative for "idle".** |
| `busyMarkers` | Footer text while generating (`esc to interrupt`). **Authoritative for "busy".** |
| `spinnerGlyphs` | Animation frames. Used only for **masking**, not state — because the done-status line (`✻ Crunched for 1s`) reuses a spinner glyph while idle. Don't use a spinner as a busy signal. |
| `assistantMarkers` | Glyph prefixing assistant turns (`⏺`). |
| `userMarkers` | Glyph prefixing echoed user turns (`❯`). |
| `menu.selectedMarkers` | Highlighted-option glyph (`❯`). Disambiguated from the input prompt by the recognizer requiring ≥2 options. |
| `permission.triggers/affirmative/negative` | Permission-prompt phrasing + option labels. |
| `startup.trustTriggers` | Text of the workspace-trust dialog (auto-accepted at startup). |
| `chromePatterns` | Regexes for lines to strip from extracted content: box/rule lines, footer, done-status (`^\s*[✻✽…].*$`), bare prompt (`^\s*❯\s*$`). |

Record *why* each change was made in the profile's `_note` field.

### 4. Validate (gate before promotion)

```bash
npm run typecheck
# Re-run the probe; the final frame should read state=ready, confidence ≥ 0.5,
# and assistantText should be the clean answer with NO chrome leakage:
CLAUDE_PATH=$(which claude) npm run probe -- "Reply with exactly: hello from the tui"
# End-to-end through the real surfaces:
npx tsx src/cli/index.ts -o json "What is 6 times 7? Reply with just the number."
#   → result must be "42", degraded:false, confidence ≥ 0.5
```

**Strongest oracle — the session JSONL cross-check.** When dash-p drives the TUI
with `--session-id`, Claude Code writes the conversation to
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` — ground truth with the exact
model text, tool input, and usage. Use `--verify-session` to diff the scraped
output against it automatically:

```bash
npx tsx src/cli/index.ts -o json --verify-session \
  "Run this exact command and show its output: echo calib-check"
#   → stderr "dash-p[session]: scraped text diverges …" flags a mismatch
```

How to read a divergence:
- **Markdown-rendering loss is expected** (the TUI renders ```code```/**bold** as
  styled blocks, so scraped text drops the literal syntax). A low similarity on a
  markdown-heavy answer is the known ceiling, not a regression — confirm with
  `--enrich-from-session`, which substitutes the exact JSONL text.
- **A divergence on plain prose, or chrome leaking into the answer** (a stray `❯`,
  a footer fragment, a tool line) **is a real recognizer bug** — fix the profile
  or `src/recognize/` before promoting. (This is literally how the `❯ <ghost
  suggestion>` leak was caught.)

The older oracle still applies as a sanity check: `claude -p "<same prompt>"` and
confirm semantic equality.

### 5. Promote or escalate

- **All checks pass** → keep `profiles/claude-<version>.json`, refresh
  `profiles/default.json` (`cp` the new one), commit with the frame evidence.
- **Any check fails / a field is uncertain** → do **not** promote. Leave the old
  profile in place and write up which field/scenario is unresolved, attaching the
  relevant `fixtures/spike-*.txt`. A wrong profile that silently mis-extracts is
  worse than an honest "needs human review".

## Guardrails

- Change **data (the profile)**, not the engine, unless the *structure* of the
  TUI changed (e.g. a brand-new prompt type) — then update `src/recognize/` and
  note it here.
- Parse **text and structure, never colour or motion.** If a change is purely
  cosmetic (new gradient, new spinner art), the only edit should be adding glyphs
  to `spinnerGlyphs`/`chromePatterns` for masking.
- Always keep `default.json` pointing at the newest validated profile.
