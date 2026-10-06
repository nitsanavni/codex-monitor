import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const BIN = join(REPO, "monitor");

export interface Ctx {
  dir: string;
  stateDir: string;
  work: string;
}

export function makeCtx(): Ctx {
  // Keep paths short for AF_UNIX (macOS's TMPDIR is too long); resolve /tmp's
  // symlink on macOS so paths match the command's $PWD.
  const dir = mkdtempSync(join(realpathSync("/tmp"), "mon-"));
  const stateDir = join(dir, "state");
  const work = join(dir, "work");
  Bun.spawnSync(["mkdir", "-p", stateDir, work]);
  return { dir, stateDir, work };
}

/** A minimal, explicit environment: nothing inherited from the parent session. */
export function baseEnv(ctx: Ctx, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/nonexistent",
    TMPDIR: tmpdir(),
    CODEX_MONITOR_STATE_DIR: ctx.stateDir,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export async function run(args: string[], env: Record<string, string>, cwd: string, timeoutMs = 20_000): Promise<RunResult> {
  const t0 = Date.now();
  const p = Bun.spawn([BIN, ...args], { env, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, ms: Date.now() - t0 };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0; treat it as dead.
  if (process.platform === "darwin") {
    const ps = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "stat="]);
    return ps.exitCode === 0 && !ps.stdout.toString().trim().startsWith("Z");
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

export function readState(ctx: Ctx, id: string): any {
  return JSON.parse(readFileSync(join(ctx.stateDir, id, "state.json"), "utf8"));
}

export async function waitUntil(pred: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Kill everything a test's monitors own, whatever state they reached, then remove the sandbox. */
export function cleanup(ctx: Ctx, extraPids: number[] = []): void {
  if (existsSync(ctx.stateDir)) {
    for (const id of readdirSync(ctx.stateDir)) {
      let st: any;
      try {
        st = JSON.parse(readFileSync(join(ctx.stateDir, id, "state.json"), "utf8"));
      } catch {
        continue;
      }
      for (const pid of [st?.child?.pid, st?.runner?.pid]) {
        if (typeof pid !== "number" || pid <= 1) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(ctx.dir, { recursive: true, force: true });
}

/** Launch `bash -c script` in its own session (like a tool shell) and resolve once `marker` is printed. */
export function spawnSession(script: string, env: Record<string, string>, cwd: string, marker: string) {
  const child = nodeSpawn("bash", ["-c", script], { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const ready = new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${marker}: ${out}`)), 15_000);
    child.stdout!.on("data", (d) => {
      out += String(d);
      if (out.includes(marker)) {
        clearTimeout(timer);
        resolveReady(out);
      }
    });
  });
  return { child, ready };
}

export const allText = (events: any[], stream?: string) =>
  events
    .flatMap((e) => e.output ?? [])
    .filter((o: any) => stream === undefined || o.stream === stream)
    .map((o: any) => o.text)
    .join("");
