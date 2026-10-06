/**
 * `monitor` — run one background command for a Codex conversation and push
 * its output into that conversation as it arrives. See README.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets";
import { startupBudget } from "./app-server";
import type { RunnerSpec } from "./runner";
import {
  deriveStatus,
  ensureRoot,
  groupSignalable,
  ID_PATTERN,
  isAlive,
  loadAll,
  loadState,
  newId,
  procRef,
  prune,
  signalGroup,
  stateRoot,
  TERMINAL,
  writeState,
  type Loaded,
  type Phase,
} from "./state";

const USAGE = `monitor — stream a background command's output into this Codex conversation

  monitor '<bash command>'
  monitor start [--interval S] [--grace S] [--rpc-timeout S] [--thread ID] [--socket PATH] '<bash command>'
  monitor list [--all] [--json]
  monitor status <id> [--json]
  monitor stop <id>

start runs the command once, detached, in the current directory, and prints its
id. Output arrives in this conversation as monitor_event tool output, batched at
most every --interval seconds (default 5), followed by one final event with the
exit status. The target is $CODEX_THREAD_ID unless --thread is given; the App
Server socket comes from \`codex app-server daemon version\` unless --socket is.
State: --state-dir, else $CODEX_MONITOR_STATE_DIR, else $XDG_STATE_HOME/codex-monitor.`;

export const CLAUDE_REFUSAL =
  "Claude Code: use your native Monitor tool. `monitor` delivers output to Codex App Server threads only; nothing was started.";

const LABEL_CHARS = 200;
const DISCOVERY_TIMEOUT_MS = 15_000;
/** Upper bound for every seconds option; larger timer values overflow. */
const MAX_SECONDS = 86_400;

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Record<string, string>;
  bools: Set<string>;
}

const VALUE_FLAGS = new Set(["thread", "socket", "interval", "grace", "state-dir", "rpc-timeout"]);
const BOOL_FLAGS = new Set(["all", "json", "help"]);

function parse(argv: string[], stopAtFirstPositional: boolean): Parsed {
  const out: Parsed = { positional: [], flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        out.flags[name] = v;
      } else if (BOOL_FLAGS.has(name)) out.bools.add(name);
      else throw new UsageError(`unknown option --${name}`);
      continue;
    }
    if (a === "-h") {
      out.bools.add("help");
      continue;
    }
    out.positional.push(a);
    if (stopAtFirstPositional) {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
  }
  return out;
}

function seconds(p: Parsed, name: string, fallback: number, min: number): number {
  const raw = p.flags[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < min || n > MAX_SECONDS) {
    throw new UsageError(`--${name} must be a number of seconds from ${min} to ${MAX_SECONDS}`);
  }
  return Math.round(n * 1000);
}

function isClaude(env = process.env): boolean {
  const v = (env.CLAUDECODE ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

function discoverSocket(): string {
  const r = spawnSync("codex", ["app-server", "daemon", "version"], {
    encoding: "utf8",
    timeout: DISCOVERY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) {
    throw new Error("cannot query the Codex App Server daemon (`codex app-server daemon version` failed); pass --socket");
  }
  let info: any;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw new Error("`codex app-server daemon version` printed unexpected output; pass --socket");
  }
  if (info?.status !== "running") {
    throw new Error(`the Codex App Server daemon is not running (status: ${String(info?.status)}); monitor does not start one`);
  }
  if (typeof info.socketPath !== "string" || info.socketPath === "") {
    throw new Error("the Codex App Server daemon reported no socketPath; pass --socket");
  }
  return info.socketPath;
}

async function start(p: Parsed): Promise<number> {
  if (process.platform !== "linux") throw new Error("monitor currently supports Linux only");
  if (p.positional.length !== 1) throw new UsageError("pass one quoted Bash command");
  const command = p.positional[0].trim();
  if (!command) throw new UsageError("start needs a command");
  const threadId = p.flags.thread ?? process.env.CODEX_THREAD_ID ?? "";
  if (!threadId) throw new Error("no target thread: run inside a Codex session (CODEX_THREAD_ID) or pass --thread");
  const intervalMs = seconds(p, "interval", 5, 0.1);
  const graceMs = seconds(p, "grace", 5, 0);
  const rpcTimeoutMs = seconds(p, "rpc-timeout", 30, 0.1);

  const socketPath = p.flags.socket ?? discoverSocket();

  const root = stateRoot(p.flags["state-dir"]);
  ensureRoot(root);
  prune(root);
  const id = newId();
  const dir = join(root, id);
  mkdirSync(dir, { mode: 0o700 });

  // Redact before collapsing whitespace: some detector rules are line-based.
  const label = redactSecrets(command, { strict: true }).redacted.replace(/\s+/g, " ");
  const spec: RunnerSpec = {
    id,
    dir,
    command,
    cwd: process.cwd(),
    threadId,
    socketPath,
    label: label.length > LABEL_CHARS ? label.slice(0, LABEL_CHARS - 1) + "…" : label,
    strict: true,
    intervalMs,
    graceMs,
    rpcTimeoutMs,
  };
  const logFd = openSync(join(dir, "runner.log"), "a", 0o600);
  const runner = spawn(process.execPath, [join(import.meta.dir, "runner.ts")], {
    detached: true,
    stdio: ["pipe", "pipe", logFd],
    cwd: spec.cwd,
    env: process.env,
  });
  closeSync(logFd);
  // A record exists from the moment the runner does; the runner replaces it.
  const runnerRef = runner.pid === undefined ? null : procRef(runner.pid);
  writeState(dir, {
    version: 1,
    id,
    thread_id: threadId,
    label: spec.label,
    cwd: spec.cwd,
    phase: "starting",
    created_at: new Date().toISOString(),
    finished_at: null,
    runner: runnerRef,
    child: null,
    exit: null,
    delivery: { sent: 0, last_seq: 0, error: null },
    error: null,
    grace_ms: graceMs,
    interval_ms: intervalMs,
  });
  runner.stdin!.end(JSON.stringify(spec));

  const readyMs = startupBudget(rpcTimeoutMs);
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve("timeout"), readyMs);
    runner.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(buf.slice(0, nl));
      }
    });
    runner.stdout!.on("end", () => {
      clearTimeout(timer);
      resolve(buf.includes("\n") ? buf.slice(0, buf.indexOf("\n")) : "eof");
    });
  });
  runner.stdout!.destroy();
  runner.unref();

  if (line === "ready") {
    process.stdout.write(id + "\n");
    return 0;
  }
  if (line.startsWith("error ")) {
    // Nothing ran: leave no record behind.
    await new Promise((r) => (runner.exitCode !== null ? r(null) : runner.once("exit", r)));
    rmSync(dir, { recursive: true, force: true });
    throw new Error(line.slice(6));
  }
  if (line === "eof") {
    // The runner died before readiness (stopped while loading, or crashed).
    await new Promise((r) => (runner.exitCode !== null || runner.signalCode !== null ? r(null) : runner.once("exit", r)));
    const loaded = loadState(root, id);
    const child = loaded && "state" in loaded ? loaded.state.child : null;
    if (child === null) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error("the monitor runner exited before starting the command (stopped or crashed); nothing ran");
    }
    signalGroup(child, "SIGKILL");
    throw new Error(`the monitor runner exited before becoming ready; its command was killed (log: ${join(dir, "runner.log")})`);
  }
  // No readiness in time (a wedged runner): stop whatever it may have started.
  const exited = new Promise((r) => (runner.exitCode !== null || runner.signalCode !== null ? r(null) : runner.once("exit", r)));
  try {
    process.kill(runner.pid!, "SIGTERM");
  } catch {}
  await Bun.sleep(graceMs + 1000);
  try {
    process.kill(runner.pid!, "SIGKILL");
  } catch {}
  await exited;
  const loaded = loadState(root, id);
  const child = loaded && "state" in loaded ? loaded.state.child : null;
  const waited = `the monitor runner did not become ready within ${Math.round(readyMs / 1000)}s`;
  if (child === null) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${waited}; it was stopped before starting the command; nothing ran`);
  }
  signalGroup(child, "SIGKILL");
  throw new Error(`${waited}; it and its command were stopped (log: ${join(dir, "runner.log")})`);
}

function view(l: Loaded): Record<string, unknown> {
  if ("corrupt" in l) return { id: l.id, status: "corrupt", error: l.corrupt };
  return { ...l.state, status: deriveStatus(l.state) };
}

function detail(v: Record<string, any>): string {
  if (v.status === "corrupt") return v.error;
  if (v.status === "lost") return "runner is gone; `monitor stop` reaps any leftover processes";
  const parts: string[] = [];
  if (v.exit) parts.push(v.exit.signal ? `signal ${v.exit.signal}` : `exit ${v.exit.code}`);
  if (v.delivery?.error) parts.push(`delivery: ${v.delivery.error}`);
  else if (v.error) parts.push(v.error);
  return parts.join("; ");
}

function age(iso: string | undefined): string {
  if (!iso) return "?";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function list(p: Parsed): number {
  const thread = p.flags.thread ?? process.env.CODEX_THREAD_ID;
  const all = p.bools.has("all") || !thread;
  const views = loadAll(stateRoot(p.flags["state-dir"]))
    .filter((l) => all || "corrupt" in l || l.state.thread_id === thread)
    .map(view)
    .sort((a: any, b: any) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  if (p.bools.has("json")) {
    process.stdout.write(JSON.stringify(views, null, 2) + "\n");
    return 0;
  }
  if (views.length === 0) {
    process.stdout.write(all ? "no monitors\n" : "no monitors for this thread (use --all)\n");
    return 0;
  }
  for (const v of views as any[]) {
    const cols = [v.id, v.status.padEnd(8), age(v.created_at).padStart(4)];
    if (all) cols.push(String(v.thread_id ?? "-"));
    cols.push(v.label ?? "", detail(v));
    process.stdout.write(cols.filter((c) => c !== "").join("  ") + "\n");
  }
  return 0;
}

function lookup(p: Parsed): { root: string; loaded: Loaded } {
  const id = p.positional[0];
  if (!id) throw new UsageError("an id is required");
  if (!ID_PATTERN.test(id)) throw new Error(`not a monitor id: ${id}`);
  const root = stateRoot(p.flags["state-dir"]);
  const loaded = loadState(root, id);
  if (!loaded) throw new Error(`no monitor ${id}`);
  return { root, loaded };
}

function status(p: Parsed): number {
  const { loaded } = lookup(p);
  const v: any = view(loaded);
  if (p.bools.has("json")) process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  else {
    const rows: Array<[string, unknown]> = [
      ["id", v.id],
      ["status", v.status],
      ["thread", v.thread_id],
      ["command", v.label],
      ["cwd", v.cwd],
      ["started", v.created_at],
      ["finished", v.finished_at],
      ["exit", v.exit ? (v.exit.signal ? `signal ${v.exit.signal}` : v.exit.code) : null],
      ["events delivered", v.delivery?.sent],
      ["delivery error", v.delivery?.error],
      ["error", v.error],
      ["output log", "state" in loaded ? join(loaded.dir, "output.log") : null],
    ];
    for (const [k, val] of rows) if (val !== null && val !== undefined) process.stdout.write(`${k}: ${val}\n`);
  }
  return v.status === "corrupt" ? 1 : 0;
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

async function stop(p: Parsed): Promise<number> {
  const { root, loaded } = lookup(p);
  if ("corrupt" in loaded) throw new Error(`${loaded.id}: state is corrupt (${loaded.corrupt}); not signalling anything`);
  const st = loaded.state;
  if (TERMINAL.has(st.phase)) {
    process.stdout.write(`${st.id} already ${st.phase}\n`);
    return 0;
  }
  const grace = typeof st.grace_ms === "number" ? st.grace_ms : 5000;
  const latest = () => {
    const l = loadState(root, st.id);
    return l && "state" in l ? l : null;
  };
  const finished = () => TERMINAL.has(latest()?.state.phase as Phase);
  if (isAlive(st.runner)) {
    try {
      process.kill(st.runner!.pid, "SIGTERM");
    } catch {}
    // The runner stops the command, delivers the final event and records it.
    await waitFor(() => !isAlive(st.runner) || finished(), grace + 10_000);
    if (isAlive(st.runner) && !finished()) {
      try {
        process.kill(st.runner!.pid, "SIGKILL");
      } catch {}
    }
  }
  // Re-read: the runner may have started the command or finished since the first read.
  const now = latest();
  if (now && TERMINAL.has(now.state.phase)) {
    process.stdout.write(`${st.id} ${now.state.phase}\n`);
    return 0;
  }
  // The runner is gone: reap the command's group directly.
  const child = now?.state.child ?? st.child;
  if (signalGroup(child, "SIGTERM")) {
    if (!(await waitFor(() => !groupSignalable(child), grace))) signalGroup(child, "SIGKILL");
    await waitFor(() => !groupSignalable(child), 2000);
  }
  if (now) {
    const s = now.state;
    s.phase = "stopped";
    s.finished_at = new Date().toISOString();
    s.error = "the runner did not finish, so no final event was delivered";
    writeState(now.dir, s);
  }
  process.stdout.write(`${st.id} stopped\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const commands = new Set(["start", "stop", "status", "list", "help", "--help", "-h"]);
  const args = argv.length && !commands.has(argv[0]) ? ["start", ...argv] : argv;
  const [cmd, ...rest] = args;
  // Claude Code takes priority over everything else, including argument errors.
  if (cmd === "start" && isClaude()) {
    process.stderr.write(CLAUDE_REFUSAL + "\n");
    return 3;
  }
  try {
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
      process.stdout.write(USAGE + "\n");
      return cmd ? 0 : 2;
    }
    const p = parse(rest, cmd === "start");
    if (p.bools.has("help")) {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    switch (cmd) {
      case "start":
        return await start(p);
      case "list":
        return list(p);
      case "status":
        return status(p);
      case "stop":
        return await stop(p);
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (e) {
    const msg = redactSecrets((e as Error).message, { strict: true }).redacted;
    process.stderr.write(`monitor: ${msg}\n`);
    if (e instanceof UsageError) process.stderr.write(USAGE + "\n");
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
