# dash-p

> Drive the **Claude Code TUI** programmatically — a `claude -p`-style CLI and an
> Agent-SDK-shaped `query()` API — by automating the real interactive terminal
> UI through a PTY, **without** using the `-p` flag.

This is an experiment in reverse-engineering Claude Code's terminal interface.
Instead of the sanctioned headless protocol, `dash-p` spawns the actual
interactive `claude` TUI inside a pseudo-terminal, injects prompts, reads the
rendered screen back through a headless terminal emulator, and reconstructs a
clean, structured result — mimicking what `claude -p` gives you, but produced
entirely from the visual UI.

⚠️ **It works today against Claude Code 2.1.x**, but it is inherently fragile:
it depends on how the TUI *renders*. The whole architecture is built to contain
that fragility (see [Resilience](#resilience)). For production use, prefer the
real [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

---

## Two faces, one engine

```
                ┌──────────────────────────────┐
   dash-p CLI ──▶                              │
                │      TUI-driving engine       ├──▶ spawns real `claude` in a PTY
   query() SDK ─▶                              │
                └──────────────────────────────┘
```

### 1. CLI — mimics `claude -p`

```bash
dash-p "explain this repo in two sentences"
dash-p -m sonnet "summarise the CHANGELOG"
dash-p -o json "what is 6 * 7? reply with just the number"
echo "a long prompt from a pipe" | dash-p
dash-p -o stream-json "name two primary colors"   # JSONL message stream
```

Output formats (same names as `claude -p`): `text` (default), `json`, `stream-json`.

### 2. SDK — a drop-in `query()`

```ts
import { query } from 'dash-p';

for await (const msg of query({
  prompt: 'In one sentence, what is a pseudo-terminal?',
  options: { model: 'sonnet', includePartialMessages: true },
})) {
  if (msg.type === 'stream_event' && msg.event.type === 'content_block_delta')
    process.stdout.write(msg.event.delta.text);
  if (msg.type === 'result') console.log('\n[done]', msg.result);
}
```

The message types and `query({ prompt, options })` shape mirror
`@anthropic-ai/claude-agent-sdk`. See [docs/SDK-PARITY.md](docs/SDK-PARITY.md)
for exactly what's supported and what diverges.

---

## Install / run

```bash
npm install        # builds node-pty (needs Xcode CLT on macOS) + fixes spawn-helper perms
npm run build      # compile TS → dist/
npm link           # optional: put `dash-p` on your PATH

# or run straight from source without building:
npx tsx src/cli/index.ts "your prompt"
```

Requires Node ≥ 20 and a working `claude` binary. If `claude` isn't on node's
`PATH`, pass `--claude-path /abs/path/to/claude` (CLI) or `options.claudePath` (SDK).

---

## How it works

A strict layered pipeline — only the top layer knows anything about Claude:

```
 8. CLI / SDK surface       dash-p "…"  ·  query({prompt, options})
 7. Controller              per-turn state machine: submit → observe → settle → extract
 6. Action layer            type / bracketed-paste / keys / menu-nav
 5. Recognition layer       screen → {state, regions}     ◀── Claude-specific, profile-driven
 4. Observation layer       region-masked quiescence (animations don't count as activity)
 3. Emulation layer         @xterm/headless: bytes → virtual screen + scrollback
 2. Transport layer         node-pty: PTY spawn / resize / raw I/O
 1. Process                 the real `claude` child + lifecycle
```

Layers 1–4 are Claude-agnostic; they'd work against `vim`. **Everything
Claude-specific is data**, in [`profiles/claude-<version>.json`](profiles/).
When the TUI changes, you edit a profile — not the engine.

Key tactics validated against the live 2.1.x TUI:

- **Terminal fidelity.** `@xterm/headless` answers the TUI's device queries
  (cursor reports, device attributes) so it renders its true interactive UI
  rather than degrading. We set `TERM=xterm-256color`, never `CI=1`.
- **Footer-driven state.** The footer is authoritative: `esc to interrupt` ⇒
  busy, `? for shortcuts` ⇒ idle. The spinner glyph is *not* trusted — the
  post-completion line `✻ Crunched for 1s` reuses a spinner glyph while idle.
- **Animations are cosmetic.** We parse text/structure, never colour or motion;
  spinner/gradient frames are masked so they never read as "still streaming".
- **Clean extraction.** User messages (`❯`) and assistant messages (`⏺`) are
  separated; chrome (boxes, rules, footer, done-status) is stripped.
- **Graceful degradation.** If recognizer confidence is low, the turn returns a
  raw transcript fallback flagged `degraded: true` rather than crashing or lying.

See [docs/DESIGN.md](docs/DESIGN.md) for the full rationale.

---

## Resilience

The TUI changes often (it auto-updated 2.1.119 → 2.1.161 *mid-development*). Two
mechanisms keep `dash-p` adaptable:

1. **Version-keyed profiles.** `profiles/claude-<version>.json` holds every
   literal (markers, glyphs, anchors). `default.json` is the fallback.
2. **Self-recalibration.** [`recalibrate/SKILL.md`](recalibrate/SKILL.md) +
   [`probes/capture.ts`](probes/capture.ts) form an evidence-driven loop: when a
   new Claude version ships, the probe drives the new TUI and dumps frames; an
   agent reads them and rewrites the profile; a validation gate confirms it.

```bash
npm run probe -- "Reply with exactly: hello"   # capture real frames → fixtures/
```

---

## Status & limitations

✅ Working (validated against the live 2.1.x TUI): one-shot + streaming turns,
`text`/`json`/`stream-json`, model selection, workspace-trust auto-accept,
**structured `tool_use`/`tool_result` blocks**, **paragraph reflow** (rejoining
the TUI's hard-wrapped lines, code/list-aware), streamed-delta accumulation,
`onPermission` handling, clean extraction, confidence scoring + degraded
fallback.

⚠️ Fidelity ceilings (inherent to screen-scraping): tool `input` is the
*rendered* args string (`{ raw }`), not the model's JSON, and may be
width-truncated; reflow is heuristic (`--no-reflow` for verbatim breaks); MCP
servers, hooks, and the `canUseTool` callback aren't wired. See
[docs/SDK-PARITY.md](docs/SDK-PARITY.md).

This is a research experiment, not a supported product. Use your own account;
respect Claude Code's terms.
