# Make Claude Scriptable Again

### `dash-p`

> **If Claude can interact with apps through their interfaces, developers should be able to interact with Claude Code through theirs.**

---

Claude can click buttons, type into apps, read screens, and operate software through a GUI.\
So why shouldn’t developers be able to automate their own Claude Code session?

dash-p is a CLI and TypeScript library that makes Claude Code scriptable by driving the real Claude TUI process you already use.

It does not bypass Claude Code.\
It does not fake network requests.\
It does not bypass authentication.

It simply launches the official `claude` command, injects input programmatically, reads output programmatically, and exposes a clean developer interface on top.

The same Claude Code.\
The same local session.\
The same authentication flow.\
Just composable.\
Not a replacement for Claude Code.

A bridge that makes it scriptable.

---

## Use it in one line

**CLI — replace `claude -p`:**

```diff
- claude -p "summarize this repo"
+ dash-p  "summarize this repo"
```

**SDK — replace the import:**

```diff
- import { query } from "@anthropic-ai/claude-agent-sdk";
+ import { query } from "dash-p";
```

That’s the whole idea. Same prompt in, same shape of answer out — but produced by driving the interactive TUI instead of the `-p` headless flag.

---

## Getting started

**Prerequisites:** Node ≥ 20, and the official `claude` CLI installed and logged in (run `claude` once to sign in). On macOS you’ll need Xcode Command Line Tools (for the PTY build).

```bash
git clone <this-repo> dash-p && cd dash-p
npm install        # builds the PTY layer
npm run build      # compile to dist/
npm link           # puts `dash-p` on your PATH

dash-p "what does this project do?"
```

Prefer not to link? Run straight from source: `npx tsx src/cli/index.ts "your prompt"`.
If `claude` isn’t on your `PATH`, pass `--claude-path /abs/path/to/claude`.

---

## CLI

```bash
dash-p "explain this repo in two sentences"
dash-p -m sonnet "summarise the CHANGELOG"
dash-p -o json "what is 6 * 7? reply with just the number"
echo "a long prompt from a pipe" | dash-p
dash-p -o stream-json "name two primary colors"     # JSONL message stream
```

Output formats mirror `claude -p`: `text` (default), `json`, `stream-json`.
Run `dash-p --help` for the full flag list (model, permission mode, tools,
working dir, terminal size, and more).

## SDK

The `query()` shape matches `@anthropic-ai/claude-agent-sdk`, so code ports over:

```ts
import { query } from "dash-p";

for await (const msg of query({
  prompt: "In one sentence, what is a pseudo-terminal?",
  options: { model: "sonnet", includePartialMessages: true },
})) {
  if (msg.type === "stream_event" && msg.event.type === "content_block_delta")
    process.stdout.write(msg.event.delta.text);
  if (msg.type === "result") console.log("\n[done]", msg.result);
}
```

You get `system` / `user` / `assistant` / `stream_event` / `result` messages,
with structured `tool_use` + `tool_result` blocks. See
[docs/SDK-PARITY.md](docs/SDK-PARITY.md) for exactly what’s supported.

---

## How it works

```
 your CLI / query()  →  dash-p engine  →  spawns the real `claude` in a PTY
```

1. **Launch** — spawns the official `claude` interactive TUI inside a pseudo-terminal (so it renders its true UI, exactly as for a human).
2. **Inject** — pastes your prompt and keystrokes into the terminal.
3. **Read** — feeds the terminal output through a headless terminal emulator (the same engine VS Code uses) to reconstruct the screen.
4. **Extract** — recognizes the conversation structure (assistant text, tool calls, results) and returns it as clean text or structured SDK messages.

All the Claude-specific knowledge (what the prompt box looks like, how a tool
call renders, etc.) lives as **data** in versioned [`profiles/`](profiles/), so a
TUI update is a profile edit, not an engine rewrite. There’s even a
[self-recalibration skill](recalibrate/SKILL.md) for new Claude releases.

For the full architecture, see [docs/DESIGN.md](docs/DESIGN.md).

---

## Good to know

dash-p reads the *rendered* screen, so it’s inherently tied to how the TUI looks
(it’s calibrated against Claude Code 2.1.x). A few things are fidelity ceilings of
screen-scraping — e.g. markdown syntax like code fences is rendered-then-lossy.

For byte-exact output when you need it, dash-p can read the session transcript
Claude Code already writes to disk:

```bash
dash-p --enrich-from-session "..."   # exact text + token usage
dash-p --verify-session       "..."   # warn if the scrape diverges from ground truth
```

This stays read-only — dash-p still *drives* only through the TUI.

This is a research experiment, not an official product. Use your own account and
respect Claude Code’s terms.
