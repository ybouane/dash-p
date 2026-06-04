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
| `system` / `init` | ✅ | Best-effort; `tools`/`mcp_servers`/`slash_commands` empty unless enriched. |
| `system` / `session_state_changed` | ✅ | `idle` / `running` / `requires_action`, mirroring the engine state machine. |
| `user` (prompt) | ✅ | Echo of the submitted prompt. |
| `user` (tool_result) | ✅ | After a tool turn; `tool_result` blocks paired to the turn's `tool_use` ids, with `is_error` when detected. |
| `stream_event` | ✅ | Text deltas, when `includePartialMessages: true`. |
| `assistant` | ✅ | Ordered `text` + `tool_use` blocks (per-tool structured `input`). |
| `result` / `success` | ✅ | Now includes `ttft_ms`, `usage`, `duration_api_ms`, `structured_output` (with `jsonSchema`), plus dash-p `degraded`/`confidence`/`usage_source`. |
| `result` / `error_*` | ⚠️ | Surfaced on thrown errors / timeouts. |
| `stop_reason`, hooks, tasks, compact, thinking-as-message | ❌ | Not emitted (thinking is available via `enrichFromSession`). |

### Tool calls

`tool_use.input` is mapped per-tool from the **rendered** args (`Bash` → `{ command }`,
`Read`/`Write`/`Edit` → `{ file_path }`, `Grep`/`Glob` → `{ pattern }`, `WebFetch` →
`{ url }`, …; unknown tools fall back to `{ raw }`). This is reconstructed from the
screen, so long args can be width-truncated. **`--verbose` is launched by default**
so tool *results* aren't collapsed. For the model's exact tool input JSON and full
results, use `enrichFromSession` (reads the session JSONL — see below).

### Result shape & usage

The `result` message mirrors `claude -p --output-format json`'s field order and
includes `is_error`, `api_error_status: null`, `duration_ms`, `duration_api_ms`,
`ttft_ms`, `num_turns`, `result`, `stop_reason`, `session_id`,
`total_cost_usd`, `usage`, `permission_denials`, `terminal_reason`, `uuid` — plus
dash-p extras (`degraded`, `confidence`, `usage_source`).

| Field | scraped (default) | `--enrich-from-session` |
|---|---|---|
| `ttft_ms`, `duration_api_ms` | timing + footer timer | same |
| `usage` | approximate (`output_tokens` from the footer's `↓ N tokens`, `input_tokens: 0`) | **exact, full rich shape** (cache tokens, `service_tier`, `cache_creation`, `iterations`, …) from the JSONL |
| `stop_reason` | assumed `end_turn` | exact (from the JSONL) |
| `usage_source` | `'scraped'` | `'session'` |

**Not recoverable** (the CLI computes them post-hoc from pricing; they're not in
the transcript): `total_cost_usd` and `modelUsage` cost figures → `total_cost_usd`
is `null`, `modelUsage` is omitted. For exact usage and cost-grade accuracy, the
sanctioned `claude -p` remains the source of truth.

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
| `mcpServers` | ✅ | `--mcp-config` (external file/command/url servers; in-process `createSdkMcpServer` can't work) |
| `agents` | ✅ | `--agents` (JSON) |
| `settings` / `settingSources` | ✅ | `--settings` / `--setting-sources` |
| `betas` | ✅ | `--betas` |
| `jsonSchema` | ✅ | structured output via prompt augmentation (the `--json-schema` flag is print-only); parsed into `result.structured_output` |
| `canUseTool` (callback) | ❌ | use `onPermission` instead |
| `hooks` | ❌ | JS-callback hooks can't be injected into a separate process |

### dash-p-only options

`claudePath`, `terminalSize`, `includePartialMessages`, `quietMs`, `reflow`,
`verbose` (default true), `onPermission`, `enrichFromSession`, `verifySession`,
`debug`, `extraArgs` (forwarded verbatim to the `claude` CLI).

### Bucket 3 — session JSONL (opt-in, read-only)

With `--session-id` always set, Claude Code persists the conversation to
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. dash-p still *drives* only via the
TUI, but two opt-in flags read that file:

- `enrichFromSession` — replace the result text + usage with the **exact** values
  (recovers markdown syntax, full tool results, real token counts).
- `verifySession` — diff scraped output against the JSONL and warn on divergence.
  A correctness oracle for the scraper (it already caught a ghost-suggestion leak).

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

## Remaining gaps (the genuine ceilings)

These can't be closed from the screen alone — `enrichFromSession` is the exact
path for the first three:

- **Markdown syntax is rendered-then-lossy.** The TUI renders ```fences```/**bold**
  as styled blocks, so scraped text drops the literal syntax. `verifySession` will
  flag this as a divergence on markdown-heavy answers — it's the ceiling, not a bug.
- **Tool input/result are reconstructed from the render** and can be width-truncated.
- **Reflow is heuristic** (inverse word-wrap); a real break at exactly the wrap
  width can be misjoined. `--no-reflow` keeps verbatim line breaks.
- **In-process MCP (`createSdkMcpServer`), JS-callback `hooks`, and `canUseTool`**
  can't be driven through a separate TUI process.
