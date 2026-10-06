/** On-disk monitor records and process identity checks. */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Phase = "starting" | "running" | "stopping" | "exited" | "stopped" | "failed";
export const TERMINAL: ReadonlySet<Phase> = new Set(["exited", "stopped", "failed"]);

export interface ProcRef {
  pid: number;
  /** /proc/<pid>/stat starttime: distinguishes a reused pid. */
  start: string;
}

export interface MonitorState {
  version: 1;
  id: string;
  thread_id: string;
  /** The command after secret redaction, truncated. The raw command is never stored. */
  label: string;
  cwd: string;
  phase: Phase;
  created_at: string;
  finished_at: string | null;
  runner: ProcRef | null;
  /** Leader of the command's own process group (pgid == pid). */
  child: ProcRef | null;
  exit: { code: number | null; signal: string | null } | null;
  delivery: { sent: number; last_seq: number; error: string | null };
  error: string | null;
  grace_ms: number;
  interval_ms: number;
}

export function stateRoot(flag?: string): string {
  if (flag) return flag;
  if (process.env.CODEX_MONITOR_STATE_DIR) return process.env.CODEX_MONITOR_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "codex-monitor");
}

export const ID_PATTERN = /^mon-[a-z0-9]{1,32}$/;

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return "mon-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function writeState(dir: string, state: MonitorState): void {
  const tmp = join(dir, `.state.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, join(dir, "state.json"));
}

export type Loaded = { id: string; dir: string; state: MonitorState } | { id: string; dir: string; corrupt: string };

export function loadState(root: string, id: string): Loaded | null {
  const dir = join(root, id);
  let raw: string;
  try {
    raw = readFileSync(join(dir, "state.json"), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      try {
        statSync(dir);
      } catch {
        return null;
      }
      return { id, dir, corrupt: "state.json is missing" };
    }
    return { id, dir, corrupt: "state.json is unreadable" };
  }
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 1 || state.id !== id || typeof state.phase !== "string" || typeof state.thread_id !== "string") {
      return { id, dir, corrupt: "state.json has an unexpected shape" };
    }
    return { id, dir, state };
  } catch {
    return { id, dir, corrupt: "state.json is not valid JSON" };
  }
}

export function loadAll(root: string): Loaded[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => ID_PATTERN.test(n))
    .map((n) => loadState(root, n))
    .filter((l): l is Loaded => l !== null);
}

function procStat(pid: number): { state: string; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] === undefined ? null : { state: rest[0], start: rest[19] };
  } catch {
    return null;
  }
}

/** Start time of `pid`, including an unreaped zombie. */
export function procStart(pid: number): string | null {
  return procStat(pid)?.start ?? null;
}

export function procRef(pid: number): ProcRef | null {
  const start = procStart(pid);
  return start === null ? null : { pid, start };
}

/** True only when the recorded process is still the same, running process. */
export function isAlive(ref: ProcRef | null): boolean {
  if (ref === null || ref.pid <= 1) return false;
  const st = procStat(ref.pid);
  return st !== null && st.start === ref.start && st.state !== "Z" && st.state !== "X";
}

/**
 * Whether signalling the recorded process group is safe and useful. The group
 * id is the recorded leader's pid. While any member lives, Linux does not hand
 * that number to a new process; if the number now belongs to a different
 * process, the group may be someone else's, so it is left alone.
 */
export function groupSignalable(ref: ProcRef | null): boolean {
  if (ref === null || ref.pid <= 1) return false;
  const start = procStart(ref.pid);
  if (start !== null && start !== ref.start) return false;
  try {
    process.kill(-ref.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalGroup(ref: ProcRef | null, signal: NodeJS.Signals): boolean {
  if (!groupSignalable(ref)) return false;
  try {
    process.kill(-ref!.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** The status shown to users: the recorded phase, corrected by liveness. */
export function deriveStatus(state: MonitorState): string {
  if (TERMINAL.has(state.phase)) return state.phase;
  if (!isAlive(state.runner)) return "lost";
  return state.phase;
}

const RETAIN_MS = 7 * 24 * 3600 * 1000;
const RETAIN_COUNT = 100;

/** Remove old finished records. Live or unfinished monitors are never pruned. */
export function prune(root: string, now = Date.now()): void {
  const finished = loadAll(root)
    .map((l) => {
      let mtime = 0;
      try {
        mtime = statSync(l.dir).mtimeMs;
      } catch {}
      const done = "state" in l ? TERMINAL.has(l.state.phase) : true;
      const at = "state" in l && l.state.finished_at ? Date.parse(l.state.finished_at) : mtime;
      return { dir: l.dir, done, at };
    })
    .filter((r) => r.done)
    .sort((a, b) => b.at - a.at);
  finished.forEach((r, i) => {
    if (i >= RETAIN_COUNT || now - r.at > RETAIN_MS) rmSync(r.dir, { recursive: true, force: true });
  });
}

export function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
}
