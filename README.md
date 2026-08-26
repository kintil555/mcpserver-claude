# mcp-github-push

An MCP server that runs **on your own computer**, stores your GitHub PAT locally, and performs **real `git clone`/`commit`/`push`** through the actual `git` CLI — not a REST API that forces every file's full content to be retyped into tool call parameters.

Ships as a **terminal CLI** — install via npm, set up your token once, then register it with your MCP client.

## How it works

1. Claude works in its own sandbox (clone, edit files, etc.).
2. When done, Claude produces a **`git diff`** of its changes — compact text, not full file contents.
3. That diff is sent via a `git_apply_patch` tool call to this MCP server, which applies it to **its own local workspace** (a separate clone stored under `~/.config/mcp-github-push/workspaces/`).
4. After the user reviews (`git_status` / `git_diff`) and approves, Claude calls `git_push` — this server runs the actual `git commit` + `git push` using the token stored locally.

**Your GitHub token never passes through Claude's chat/context** — it only lives in a local config file and is injected directly into the `git` process during fetch/push.

## Why is this different from the built-in GitHub connector?

- **Not per-file REST calls.** Pushes use the real `git` CLI on top of a local clone, so hundreds of files are supported in one diff — not retyped one-by-one as JSON parameters.
- **Push requires confirmation.** `git_push` requires a `confirmed: true` parameter, which Claude may only set after the user has explicitly approved in conversation.
- **Token stored locally, never sent to chat.** Config file permissions are `600` on POSIX (Linux/macOS); on Windows it relies on standard user-folder ACLs.

## Installation

### Option A — No Node.js required (standalone executable)

No need to install Node.js at all. Download the binary for your OS from the [Releases page](https://github.com/kintil555/mcpserver-claude/releases/latest):

- Windows: `mcp-github-push-win-x64.exe`
- Linux: `mcp-github-push-linux-x64`
- macOS: `mcp-github-push-macos-x64`

Run from a terminal:

```bash
# Windows (PowerShell/CMD)
mcp-github-push-win-x64.exe setup

# Linux/macOS
chmod +x mcp-github-push-linux-x64
./mcp-github-push-linux-x64 setup
```

Then register the **full path to the exe** in your MCP client config:

```json
{
  "mcpServers": {
    "github-push": {
      "command": "C:\\path\\to\\mcp-github-push-win-x64.exe",
      "args": ["start"]
    }
  }
}
```

### Option B — Via npm (requires Node.js 18+)

```bash
npx @kintil555/mcp-github-push setup
```

Follow the prompts:
1. Create a [Personal Access Token](https://github.com/settings/tokens?type=beta) (fine-grained recommended) with **Contents: Read and write** scope for the repos you want to use.
2. Paste the token when prompted (input is masked in the terminal).
3. The token is verified automatically and stored at `~/.config/mcp-github-push/config.json`.

## Register with your MCP client

Add this to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-push": {
      "command": "npx",
      "args": ["-y", "@kintil555/mcp-github-push", "start"]
    }
  }
}
```

Restart the client. Tools available to Claude:

| Tool | Function |
|---|---|
| `github_whoami` | Check whether the token is valid and see the username |
| `git_sync_workspace` | Clone (if not present) or fetch+checkout the latest branch into the local workspace |
| `git_write_file` | Write/overwrite a single file with full content — the primary way to edit files, no diff needed |
| `git_delete_file` | Delete a single file from the local workspace |
| `git_apply_patch` | (Fallback) Apply a raw unified diff — prone to failure if hand-typed |
| `git_status` | View a summary of changed files, not yet committed |
| `git_diff` | View the full diff in the local workspace |
| `git_push` | Actually commit + push — only runs after user approval (`confirmed: true`) |
| `git_discard_workspace` | Delete the local workspace (e.g. to re-clone from scratch) |

## Other CLI commands

```bash
npx @kintil555/mcp-github-push status   # check whether the token is still valid
npx @kintil555/mcp-github-push logout   # remove the stored token
```

## Building from source

```bash
git clone https://github.com/kintil555/mcp-github-push.git
cd mcp-github-push
npm install
npm run build
```

CI on GitHub Actions automatically builds & type-checks every push/PR to `main`, and publishes to npm on new release tags.

## Prerequisites

- **The `git` CLI must be installed** and on your PATH (this server runs real `git`, not a REST API). Check with `git --version`. If missing: [git-scm.com/downloads](https://git-scm.com/downloads).

## Performance

- **Local operations** (`git_status`, `git_diff`, `git_write_file`, `git_delete_file`, `git_apply_patch`) are fast — plain disk I/O and local `git` commands, no network round trip.
- **Network operations** (`git_sync_workspace`, `git_push`) shell out to real `git` over HTTPS, so speed depends on your connection and repo size — same as running `git clone`/`push` yourself. The proxy adds negligible overhead on top of that.
- For large repos, the first `git_sync_workspace` (initial clone) is the slowest step; subsequent syncs only fetch new commits.

## Security

- Token is stored at `~/.config/mcp-github-push/config.json`. Permission `600` is applied on Linux/macOS; on Windows it relies on default user-folder permissions (NTFS ACL), not Unix `chmod`.
- The token is **never** written to `.git/config` in the local workspace — it's injected only momentarily into the `git` process via a temporary HTTP header during fetch/push.
- Use a **fine-grained PAT** scoped to specific repos, not a classic token with full access.
- Set a token expiry and rotate it periodically.
- `git_push` requires the `confirmed: true` parameter — make sure your MCP client shows the tool call for user review before executing it.

## License

MIT
