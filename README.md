# opencode-hindsight-plus

Hindsight memory plugin for [OpenCode](https://opencode.ai) — persistent long-term memory with **Claude Code-aligned per-turn auto-recall**.

Fork of [`@vectorize-io/opencode-hindsight`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/opencode) with per-user-turn memory injection (see `SOURCE.txt`).

## Features

- **Custom tools**: `hindsight_retain`, `hindsight_recall`, `hindsight_reflect` — the agent calls these explicitly
- **Per-turn auto-recall**: On every user message, queries Hindsight with the current prompt (Claude Code `UserPromptSubmit` alignment) and injects `<hindsight_memories>` into the system prompt. Tool-loop model calls re-use the same turn's cache (no extra API call).
- **Auto-retain**: Captures conversation on `session.idle` (Claude Code `Stop` alignment) and stores to Hindsight
- **SessionEnd flush**: Force-retains any pending turns on `session.deleted` and plugin `dispose` (Claude Code `SessionEnd` alignment), even when under `retainEveryNTurns`
- **Tool trajectory retain**: When `retainToolCalls` is true (default), tool call inputs/outputs are included in retained transcripts (skips `hindsight_*` tools to avoid feedback loops)
- **Compaction hook**: Retains + injects query-relevant memories during context compaction so they survive window trimming

## Quick Start

The plugin defaults to **Hindsight Cloud** (`https://api.hindsight.vectorize.io`). Just enable it and provide your API key.

### 1. Enable the plugin

Add to your `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-hindsight-plus"]
}
```

OpenCode auto-installs plugins listed here on startup — no `npm install` required.

### 2. Provide your Hindsight Cloud API key

Get an API key at [ui.hindsight.vectorize.io/connect](https://ui.hindsight.vectorize.io/connect), then:

```bash
export HINDSIGHT_API_TOKEN="your-api-key"

# Optional: override the memory bank ID (defaults to "opencode")
export HINDSIGHT_BANK_ID="my-project"
```

That's it — the plugin now reads/writes against your Cloud bank.

### Using a self-hosted Hindsight instance

Point `HINDSIGHT_API_URL` at your server (the API key is then optional):

```bash
export HINDSIGHT_API_URL="http://localhost:8888"
```

Or configure inline in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-hindsight-plus",
      {
        "hindsightApiUrl": "http://localhost:8888"
      }
    ]
  ]
}
```

## Configuration

### Plugin Options

Pass options directly in `opencode.json`:

```json
{
  "plugin": [
    [
      "opencode-hindsight-plus",
      {
        "hindsightApiUrl": "http://localhost:8888",
        "bankId": "my-project",
        "autoRecall": true,
        "autoRetain": true,
        "recallBudget": "mid"
      }
    ]
  ]
}
```

### Config File

Create `~/.hindsight/opencode.json` for persistent configuration:

```json
{
  "hindsightApiUrl": "http://localhost:8888",
  "hindsightApiToken": "your-api-key",
  "recallBudget": "mid",
  "retainEveryNTurns": 3,
  "debug": false
}
```

### Environment Variables

| Variable                      | Description                                              | Default                               |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `HINDSIGHT_API_URL`           | Hindsight API base URL                                   | `https://api.hindsight.vectorize.io`  |
| `HINDSIGHT_API_TOKEN`         | API key for authentication                               | (none — required for Hindsight Cloud) |
| `HINDSIGHT_BANK_ID`           | Static memory bank ID                                    | `opencode`                            |
| `HINDSIGHT_AGENT_NAME`        | Agent name for dynamic bank IDs                          | `opencode`                            |
| `HINDSIGHT_AUTO_RECALL`       | Auto-recall on every user turn                           | `true`                                |
| `HINDSIGHT_AUTO_RETAIN`       | Auto-retain on session idle                              | `true`                                |
| `HINDSIGHT_RETAIN_MODE`       | `full-session` or `last-turn`                            | `full-session`                        |
| `HINDSIGHT_RECALL_BUDGET`     | Recall budget: `low`, `mid`, `high`                      | `mid`                                 |
| `HINDSIGHT_RECALL_MAX_TOKENS` | Max tokens for recall results                            | `1024`                                |
| `HINDSIGHT_MIN_RECALL_PROMPT_CHARS` | Skip auto-recall when user prompt is shorter        | `5`                                   |
| `HINDSIGHT_RETAIN_TOOL_CALLS` | Include tool call/result parts in retained transcripts | `true`                             |
| `HINDSIGHT_RECALL_TAGS`       | Comma-separated, filter recalls                          | (none)                                |
| `HINDSIGHT_RECALL_TAGS_MATCH` | Tag match mode: `any`, `all`, `any_strict`, `all_strict` | `any`                                 |
| `HINDSIGHT_RETAIN_TAGS`       | Comma-separated, added to every retain                   | (none)                                |
| `HINDSIGHT_DYNAMIC_BANK_ID`   | Enable dynamic bank ID derivation                        | `false`                               |
| `HINDSIGHT_BANK_MISSION`      | Bank mission/context                                     | (none)                                |

> **Debug logging** is a config-only option (`"debug": true` in `opencode.json`
> plugin options or `~/.hindsight/opencode.json`) — there is intentionally no
> `HINDSIGHT_DEBUG` env var, because environment variables are unreliable to set
> for OpenCode's plugin runtime (notably on Windows). Errors and the resolved
> API URL/bank are logged regardless of this setting; `debug` only adds verbose
> tracing. All plugin logs go to OpenCode's log stream (`service=hindsight`),
> visible with `--print-logs` or in the OpenCode log files.

### Configuration Priority

Settings are loaded in this order (later wins):

1. Built-in defaults
2. `~/.hindsight/opencode.json`
3. Plugin options from `opencode.json`
4. Environment variables

## Tools

### `hindsight_retain`

Store information in long-term memory. The agent uses this to save important facts, user preferences, project context, and decisions.

### `hindsight_recall`

Search long-term memory. The agent uses this proactively before answering questions where prior context would help.

### `hindsight_reflect`

Generate a synthesized answer from long-term memory. Unlike recall (raw memories), reflect produces a coherent summary.

## Dynamic Bank IDs

For multi-project setups, enable dynamic bank ID derivation:

```bash
export HINDSIGHT_DYNAMIC_BANK_ID=true
```

The bank ID is composed from granularity fields (default: `agent::project`). Supported fields: `agent`, `project`, `gitProject`, `channel`, `user`.

- `project` uses the working directory basename. With this field, separate git worktrees of the same repository end up with different bank IDs because their paths differ.
- `gitProject` resolves to the main worktree's basename via `git rev-parse --git-common-dir`, so all linked worktrees of the same repository share a single bank. Falls back to the working directory basename when git is unavailable or the directory is not a repo. Use this in place of `project` if you want worktrees to share memory:

```json
{
  "dynamicBankId": true,
  "dynamicBankGranularity": ["agent", "gitProject"]
}
```

**Note:** The bank ID is derived once when the plugin loads, from environment variables set before OpenCode starts. These dimensions are process-scoped — they don't change per session within a running OpenCode process. For per-user isolation, set the env vars before launching each user's OpenCode instance:

```bash
export HINDSIGHT_CHANNEL_ID="slack-general"
export HINDSIGHT_USER_ID="user123"
```

## Development

```bash
npm install
npm test        # Run tests
npm run build   # Build to dist/
```

## License

MIT
