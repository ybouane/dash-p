# SDK parity

`dash-p`'s `query()` mirrors `@anthropic-ai/claude-agent-sdk` (v0.3.161 was used
as the reference) for the common path, but is powered by the TUI. This documents
what matches and what diverges.

## `query({ prompt, options })`

- `prompt`: `string | AsyncIterable<SDKUserMessage>` — both supported (a string
  is one turn; an async iterable drives multiple turns).
- Returns a `Query`: an `AsyncGenerator<SDKMessage>` plus control methods.

## Messages emitted

| Message | Status | Notes |
|---|---|---|
| `system` / `init` | ✅ | Fields populated best-effort; `tools`/`mcp_servers`/`slash_commands` are empty (not observable from the TUI cheaply). |
| `user` (prompt) | ✅ | Echo of the submitted prompt. |
| `user` (tool_result) | ✅ | Emitted after a turn that ran tools; content is `tool_result` blocks paired to the turn's `tool_use` ids by order. |
| `stream_event` | ✅ | Text deltas only, when `includePartialMessages: true`. `event` is a `content_block_delta` with `text_delta`. |
| `assistant` | ✅ | Ordered `text` + `tool_use` blocks, reconstructed from the TUI's `⏺ Name(args)` / `⏺ prose` rendering. |
| `result` / `success` | ✅ | Adds dash-p extensions `degraded` and `confidence`. |
| `result` / `error_*` | ⚠️ | Surfaced on thrown errors / timeouts. |
| everything else (hooks, tasks, status, compact, etc.) | ❌ | Not emitted. |

### Tool calls

`tool_use` blocks carry `name` and `input: { raw: "<rendered args>" }` — the args
are the **rendered** string from the TUI (e.g. `Bash(echo hi)` → `{ raw: "echo hi" }`),
not the model's original JSON input, and long args may be width-truncated by the
TUI. `tool_result` content is the rendered output (also potentially truncated for
very large results). This is a fidelity ceiling of screen-scraping, not a bug.

## Options

| Option | Status | Mapping |
|---|---|---|
| `model` | ✅ | `--model` |
| `agent` | ✅ | `--agent` |
| `systemPrompt` | ✅ | `--system-prompt` |
| `appendSystemPrompt` | ✅ | `--append-system-prompt` |
| `allowedTools` | ✅ | `--allowed-tools` |
| `disallowedTools` | ✅ | `--disallowed-tools` |
| `additionalDirectories` | ✅ | `--add-dir` |
| `permissionMode` | ✅ | `--permission-mode` + maps to an engine permission policy |
| `cwd` | ✅ | child working directory |
| `abortController` | ✅ | abort → interrupt + stop |
| `onPermission` (dash-p) | ✅ | dash-p's `canUseTool` analogue; called under "ask" mode, returns `allow`/`deny`/`abort` |
| `canUseTool` (callback) | ❌ | use `onPermission` (above) instead |
| `mcpServers`, `hooks`, `settingSources`, … | ❌ | not wired |

### dash-p-only options

`claudePath`, `terminalSize`, `includePartialMessages`, `quietMs`, `reflow`,
`onPermission`, `debug`, `extraArgs` (forwarded verbatim to the `claude` CLI).

## Control methods

| Method | Status |
|---|---|
| `interrupt()` | ✅ (ESC) |
| `setPermissionMode(mode)` | ✅ (updates engine policy) |
| `setModel(model)` | ⚠️ best-effort via the `/model` slash command; prefer `options.model` at query time |
| `setMaxThinkingTokens`, etc. | ❌ |

## Permission mapping

| `permissionMode` | engine policy | behaviour at a prompt |
|---|---|---|
| `bypassPermissions` / `acceptEdits` / `auto` | `allow` | Enter (accept highlighted) |
| `default` / `plan` | `ask` | calls `onPermission`, else denies |
| `dontAsk` | `deny` | ESC |

Note: launching with `bypassPermissions` adds a one-time "bypass permissions"
warning gate at startup that dash-p does **not** auto-accept by default (it is a
deliberate safety decision). Prefer `default` mode with pre-approved
`allowedTools`, or wire `onPermission`.

## Remaining gaps

- **Tool input is the rendered string, not the model's JSON** (`input.raw`), and
  may be width-truncated — a screen-scraping ceiling.
- **Reflow is heuristic.** Paragraphs are rejoined by an inverse-word-wrap test;
  pathological cases (a real line break that lands exactly at the wrap width) can
  be misjoined. Use `reflow: false` / `--no-reflow` for verbatim line breaks.
- **`mcpServers` / `hooks` / `canUseTool` callback** are not wired.
