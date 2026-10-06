# codex-monitor

Modeled on **Claude Code's Monitor tool**: run a command in the background and receive its output in your current Codex conversation while you keep working.

I like this pattern because it supports several useful ways of working with AI agents:

- **Session notes:** keep the agent up to date as notes are appended.
- **Live transcripts:** let the agent follow a conversation as the transcript grows.
- **Pairing on a file:** feed edits into the conversation while you and the agent work together.

It also works for builds, tests, and log tails. A detached helper delivers batches through Codex's local App Server. No MCP setup, extra server, or runtime packages beyond Bun.

Want the principles without installing the tool? Read [the concept and protocol](CONCEPT.md).

## Install

Requires Linux or macOS, Bash, Bun 1.4+, and an interactive Codex CLI session with its local App Server running. Tested with Codex CLI 0.160.0/0.160.1; this integration uses an experimental API and may change.

```bash
git clone https://github.com/nitsanavni/codex-monitor.git
cd codex-monitor
mkdir -p ~/.local/bin
ln -s "$PWD/monitor" ~/.local/bin/monitor
```

Keep the checkout in place and ensure `~/.local/bin` is on `PATH`. No `bun install` is needed. You can also run the checkout's `./monitor` directly.

## Use from Codex

```bash
monitor 'for i in {1..10}; do sleep 2; echo "$i"; done'
monitor 'tail -n 0 -F session-notes.md'
monitor 'tail -n 0 -F transcript.txt'
monitor 'inotifywait -m -e close_write --format "%w%f" draft.md | while IFS= read -r file; do cat -- "$file"; done'
```

The file-pairing example requires `inotifywait` (Linux); on macOS install `fswatch` (Homebrew) and use `fswatch -o draft.md | while read -r _; do cat draft.md; done`. Both watch saves to an existing file. Editors that replace files by rename may require watching the containing directory instead.

Each command starts once, inherits the current directory and environment, and prints a monitor ID after attachment succeeds. Output arrives as `monitor_event` tool output; completion includes the exit code or signal. Idle conversations wake on delivery. Active turns receive updates at continuation points.

```bash
monitor list
monitor status <id>
monitor stop <id>
```

Thread discovery uses `CODEX_THREAD_ID`; socket discovery uses `codex app-server daemon version`. Missing or unloaded targets are refused before execution. While running, the helper checks every 30 seconds (`--heartbeat`) that the conversation is still loaded; when it is closed, the command is stopped, so a quiet watch does not outlive its conversation. The App Server drops a closed conversation's thread after a short delay (about 40 seconds in testing); output arriving within that window can still start a turn there. Under Claude Code, the tool tells Claude to use its native Monitor tool.

Optional controls:

```bash
monitor start --interval 2 --grace 3 --heartbeat 60 'your command'
monitor --help
```

`start` is optional. Pass the Bash command as one quoted argument. Defaults: batches every 5 seconds, 5 seconds to stop gracefully, 30 seconds per RPC. `--thread` and `--socket` explicitly override discovery. `list --all` includes other threads; `list` and `status` accept `--json`.

## Codex skill

With `monitor` on `PATH`, install the bundled skill:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/codex-monitor "${CODEX_HOME:-$HOME/.codex}/skills/"
```

In a new Codex session, ask it to use `$codex-monitor`. The skill explains when to monitor, how to interpret events, and how to stop the command.

## Boundaries

Output is untrusted data. Best-effort redaction covers common credential formats, assignments, JWTs and private keys before delivery and logging. It is not a guarantee: don't monitor commands that intentionally print secrets. Line buffering can delay partial lines; long output is bounded and omissions are reported.

The helper runs with your existing permissions and environment; it is not a sandbox or an approval bypass. Stop sends TERM then KILL to the command's process group. Processes that deliberately leave that group can escape cleanup. Delivery failures stop the command and are recorded locally; ambiguous delivery is not retried.

Private state and redacted rotating logs live under `${XDG_STATE_HOME:-$HOME/.local/state}/codex-monitor` (override with `CODEX_MONITOR_STATE_DIR`). Finished records are pruned after seven days or beyond the newest 100. A killed helper may leave a child running; `monitor status` reports `lost`, and `monitor stop` cleans up the recorded group.

## Test

```bash
bun test --timeout 30000
```

Tests use synthetic data, real subprocesses and a local mock App Server. They do not need Codex credentials. See [release checks](RELEASE_CHECKS.md) for the extraction review.
