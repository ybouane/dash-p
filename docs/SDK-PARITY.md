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
| `user` | ✅ | Echo of the submitted prompt. |
| `stream_event` | ✅ | Text deltas only, when `includePartialMessages: true`. `event` is a `content_block_delta` with `text_delta`. |
| `assistant` | ✅ | Final clean message, one `text` block. No `tool_use` blocks yet. |
| `result` / `success` | ✅ | Adds dash-p extensions `degraded` and `confidence`. |
| `result` / `error_*` | ⚠️ | Surfaced on thrown errors / timeouts. |
| everything else (hooks, tasks, status, compact, etc.) | ❌ | Not emitted. |

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
| `canUseTool` (callback) | ❌ | use `permissionMode` / engine `onPermission` instead |
| `mcpServers`, `hooks`, `settingSources`, … | ❌ | not wired |

### dash-p-only options

`claudePath`, `terminalSize`, `includePartialMessages`, `quietMs`, `debug`,
`extraArgs` (forwarded verbatim to the `claude` CLI).

## Control methods

| Method | Status |
|---|---|
| `interrupt()` | ✅ (ESC) |
| `setPermissionMode(mode)` | ✅ (updates engine policy) |
| `setModel(model)` | ⚠️ no-op + warning; pass `options.model` at query time |
| `setMaxThinkingTokens`, etc. | ❌ |

## Permission mapping

| `permissionMode` | engine policy | behaviour at a prompt |
|---|---|---|
| `bypassPermissions` / `acceptEdits` / `auto` | `allow` | Enter (accept highlighted) |
| `default` / `plan` | `ask` | calls `onPermission`, else denies |
| `dontAsk` | `deny` | ESC |

## Biggest gap

**Structured tool calls.** The real SDK yields `tool_use` blocks and
`tool_result` user messages. dash-p currently folds tool activity into the
assistant text. Parsing the TUI's `⏺ Tool(args)` / result rendering into
structured blocks is the main planned improvement.
