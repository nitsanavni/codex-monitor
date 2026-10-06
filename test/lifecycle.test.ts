/**
 * End-to-end: the real CLI, the real detached runner and
 * real child processes, against a WebSocket JSON-RPC mock on a Unix socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procRef } from "../src/state";
import { startMock, type MockServer } from "./mock-app-server";
import { alive, allText, baseEnv, cleanup, makeCtx, readState, run, spawnSession, waitUntil, BIN, type Ctx } from "./helpers";

const A = "thread-aaaa";
const B = "thread-bbbb";
const ID = /^mon-[a-z0-9]+$/;

let ctx: Ctx;
let mock: MockServer;
const extraPids: number[] = [];

function setup(threads: Record<string, any> = { [A]: "idle", [B]: "active" }) {
  ctx = makeCtx();
  mock = startMock(ctx.dir, threads);
}

afterEach(() => {
  mock?.stop();
  if (ctx) cleanup(ctx, extraPids.splice(0));
});

const terminal = (thread: string) => () => mock.events(thread).some((e) => e.status !== "running");

async function startOk(command: string, opts: { thread?: string; flags?: string[]; env?: Record<string, string> } = {}) {
  const r = await run(
    ["start", "--socket", mock.socketPath, "--interval", "0.2", ...(opts.flags ?? []), command],
    baseEnv(ctx, { CODEX_THREAD_ID: opts.thread ?? A, ...opts.env }),
    ctx.work,
  );
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const id = r.stdout.trim();
  expect(id).toMatch(ID);
  return id;
}

describe("start", () => {
  test("accepts one quoted command without the start subcommand", async () => {
    setup();
    const r = await run(["--socket", mock.socketPath, "printf 'shortcut works\\n'"], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work);
    expect(r.code).toBe(0);
    await mock.waitFor(terminal(A));
    expect(allText(mock.events(A))).toBe("shortcut works\n");
  });

  test("the shortcut also redirects Claude before executing anything", async () => {
    setup();
    const r = await run(["touch should-not-exist"], baseEnv(ctx, { CLAUDECODE: "1", CODEX_THREAD_ID: A }), ctx.work);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("native Monitor");
    expect(existsSync(join(ctx.work, "should-not-exist"))).toBe(false);
    expect(mock.connections()).toBe(0);
  });

  test("cleans up descendants even when they close output and ignore TERM", async () => {
    setup();
    const desc = join(ctx.work, "closed-output.pid");
    await startOk(`bash -c 'trap "" TERM; echo $$ > "${desc}"; exec sleep 300' >/dev/null 2>&1 & while [ ! -s "${desc}" ]; do sleep 0.01; done`, { flags: ["--grace", "0.1"] });
    await waitUntil(() => existsSync(desc) && readFileSync(desc, "utf8").trim() !== "", 5000, "descendant pid");
    const pid = Number(readFileSync(desc, "utf8").trim());
    extraPids.push(pid);
    await mock.waitFor(terminal(A));
    await waitUntil(() => !alive(pid), 2000, "descendant cleanup");
  });

  test("prints only the id, after attachment, and survives the caller's process group", async () => {
    setup();
    const env = baseEnv(ctx, { CODEX_THREAD_ID: A });
    // The caller pipes start's output (as Codex's redaction wrapper does) and is
    // then killed together with its whole process group (turn end).
    const script = `t0=$(bun -e 'console.log(Date.now())'); ${JSON.stringify(BIN)} start --socket ${JSON.stringify(mock.socketPath)} --interval 0.2 'sleep 1.5; echo late' 2>&1 | cat; echo "ms=$(( $(bun -e 'console.log(Date.now())')-t0 ))"; echo READY; sleep 60`;
    const { child, ready } = spawnSession(script, env, ctx.work, "READY");
    extraPids.push(child.pid!);
    const out = await ready;
    const [idLine, msLine] = out.trim().split("\n");
    expect(idLine).toMatch(ID);
    expect(Number(msLine.replace("ms=", ""))).toBeLessThan(1400);
    // Attachment happened before the id was printed.
    const methods = mock.received.map((r) => r.msg.method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "thread/read"]);
    expect(readState(ctx, idLine).phase).toBe("running");

    process.kill(-child.pid!, "SIGKILL");
    await mock.waitFor(terminal(A), 10_000, "terminal event");
    const events = mock.events(A);
    expect(allText(events, "stdout")).toBe("late\n");
    expect(events.at(-1)).toMatchObject({ monitor_id: idLine, status: "exited", exit_code: 0 });
  });

  test("delivers several batches with increasing sequence and the exit status exactly once", async () => {
    setup();
    const id = await startOk("for i in 1 2 3 4; do echo tick$i; sleep 0.5; done");
    await mock.waitFor(terminal(A), 10_000);
    await Bun.sleep(400);
    const events = mock.events(A);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.status !== "running")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ monitor_id: id, status: "exited", exit_code: 0, signal: null });
    expect(allText(events, "stdout")).toBe("tick1\ntick2\ntick3\ntick4\n");
    for (const e of events) {
      expect(e.type).toBe("monitor_event");
      expect(e.note).toMatch(/untrusted/i);
    }
    const st = (await run(["status", id, "--json"], baseEnv(ctx), ctx.work)).stdout;
    expect(JSON.parse(st)).toMatchObject({ id, status: "exited", exit: { code: 0 }, delivery: { error: null } });
  });

  test("reports a nonzero exit and keeps stderr separate", async () => {
    setup();
    await startOk("echo out; echo bad >&2; exit 7");
    await mock.waitFor(terminal(A));
    const events = mock.events(A);
    expect(events.at(-1)).toMatchObject({ status: "exited", exit_code: 7 });
    expect(allText(events, "stderr")).toBe("bad\n");
    expect(allText(events, "stdout")).toBe("out\n");
  });

  test("runs in the caller's working directory", async () => {
    setup();
    await startOk("printf 'cwd: %s\\n' \"$PWD\"");
    await mock.waitFor(terminal(A));
    expect(allText(mock.events(A), "stdout")).toBe(`cwd: ${ctx.work}\n`);
  });

  test("uses the same request shape for active and idle targets and routes by thread", async () => {
    setup();
    await startOk("echo to-a");
    await startOk("echo to-b", { flags: ["--thread", B] });
    await mock.waitFor(() => terminal(A)() && terminal(B)());
    expect(allText(mock.events(A))).toBe("to-a\n");
    expect(allText(mock.events(B))).toBe("to-b\n");
    for (const ts of mock.turnStarts()) {
      expect(Object.keys(ts.params).sort()).toEqual(["input", "threadId", "toolOutput"]);
      expect(ts.params.input).toEqual([]);
      expect(Object.keys(ts.params.toolOutput).sort()).toEqual(["name", "output"]);
      expect(ts.params.toolOutput.name).toBe("monitor_event");
    }
  });

  test("defaults: 5 s interval, 5 s grace, and quick output coalesced into the exit event", async () => {
    setup();
    const r = await run(
      ["start", "--socket", mock.socketPath, "echo a; sleep 0.3; echo b; sleep 0.3"],
      baseEnv(ctx, { CODEX_THREAD_ID: A }),
      ctx.work,
    );
    expect(r.code).toBe(0);
    const id = r.stdout.trim();
    expect(readState(ctx, id)).toMatchObject({ interval_ms: 5000, grace_ms: 5000 });
    await mock.waitFor(terminal(A));
    expect(mock.events(A)).toEqual([expect.objectContaining({ seq: 1, status: "exited", exit_code: 0 })]);
    expect(allText(mock.events(A))).toBe("a\nb\n");
  });

  test("lists monitors for the current thread by default", async () => {
    setup();
    const a = await startOk("sleep 30");
    const b = await startOk("sleep 30", { flags: ["--thread", B] });
    const mine = JSON.parse((await run(["list", "--json"], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work)).stdout);
    expect(mine.map((m: any) => m.id)).toEqual([a]);
    const all = JSON.parse((await run(["list", "--all", "--json"], baseEnv(ctx), ctx.work)).stdout);
    expect(all.map((m: any) => m.id).sort()).toEqual([a, b].sort());
    expect(all.every((m: any) => m.status === "running")).toBe(true);
    const human = await run(["list"], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work);
    expect(human.stdout).toContain(a);
    expect(human.stdout).not.toContain(b);
  });
});

test("a multi-line command is listed on one line", async () => {
  setup();
  const id = await startOk("echo one\n  echo two");
  await mock.waitFor(terminal(A));
  expect(readState(ctx, id).label).toBe("echo one echo two");
  const human = (await run(["list"], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work)).stdout;
  expect(human.trim().split("\n")).toHaveLength(1);
});

test("an exit is reported even when processes outside the group keep the output open", async () => {
  setup();
  const bg = join(ctx.work, "bg.pid");
  const id = await startOk(`echo hi; bun "${join(import.meta.dir, "detach.ts")}" "${bg}"; exit 4`, { flags: ["--grace", "0.5"] });
  await waitUntil(() => existsSync(bg) && readFileSync(bg, "utf8").trim() !== "", 10_000, "background pid");
  const bgPid = Number(readFileSync(bg, "utf8").trim());
  extraPids.push(bgPid);
  await mock.waitFor(terminal(A), 10_000, "terminal event");
  const events = mock.events(A);
  expect(events.at(-1)).toMatchObject({ status: "exited", exit_code: 4 });
  expect(allText(events, "stdout")).toBe("hi\n");
  expect(allText(events, "stderr")).toMatch(/processes outside its process group still held it open/);
  await waitUntil(() => readState(ctx, id).phase === "exited", 5_000, "exited record");
  expect(readState(ctx, id)).toMatchObject({ exit: { code: 4 }, error: expect.stringMatching(/outside its process group/) });
  await waitUntil(() => !alive(readState(ctx, id).runner.pid), 5_000, "runner exit");
  // Out of the monitor's reach, as documented.
  expect(alive(bgPid)).toBe(true);
});

describe("refusals happen before the command starts", () => {
  test("Claude Code is told to use its native Monitor tool, even with an inherited Codex thread", async () => {
    setup();
    const marker = join(ctx.work, "ran");
    const r = await run(
      ["start", "--socket", mock.socketPath, `touch ${marker}`],
      baseEnv(ctx, { CLAUDECODE: "1", CODEX_THREAD_ID: A }),
      ctx.work,
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("Claude Code: use your native Monitor tool");
    await Bun.sleep(500);
    expect(existsSync(marker)).toBe(false);
    expect(mock.connections()).toBe(0);
    // The redirect wins over argument errors too.
    const bad = await run(["start", "--no-such-flag", "x"], baseEnv(ctx, { CLAUDECODE: "1" }), ctx.work);
    expect(bad.code).toBe(3);
    expect(bad.stderr.trim()).toBe("Claude Code: use your native Monitor tool. `monitor` delivers output to Codex App Server threads only; nothing was started.");
  });

  test("out-of-range seconds are usage errors", async () => {
    setup();
    for (const flags of [["--interval", "100000"], ["--grace", "1e9"], ["--rpc-timeout", "0"]]) {
      const r = await run(["start", "--socket", mock.socketPath, ...flags, "true"], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`${flags[0]} must be a number of seconds`));
    }
    expect(mock.connections()).toBe(0);
  });

  const refusalCases: Array<[string, () => { args: string[]; env: Record<string, string> }, RegExp]> = [
    ["no thread id", () => ({ args: ["--socket", mock.socketPath], env: {} }), /CODEX_THREAD_ID|--thread/],
    ["no backend socket", () => ({ args: ["--socket", join(ctx.dir, "missing.sock")], env: { CODEX_THREAD_ID: A } }), /App Server/i],
    ["thread saved but not loaded", () => ({ args: ["--socket", mock.socketPath], env: { CODEX_THREAD_ID: "thread-saved-only" } }), /is notLoaded/],
    ["unknown thread", () => ({ args: ["--socket", mock.socketPath], env: { CODEX_THREAD_ID: "thread-nowhere" } }), /not available/],
    ["thread in system error", () => ({ args: ["--socket", mock.socketPath, "--thread", "thread-err"], env: {} }), /systemError/],
  ];
  for (const [name, make, message] of refusalCases) {
    test(name, async () => {
      setup({ [A]: "idle", "thread-saved-only": "notLoaded", "thread-err": "systemError" });
      const marker = join(ctx.work, "ran");
      const { args, env } = make();
      const r = await run(["start", ...args, `touch ${marker}`], baseEnv(ctx, env), ctx.work);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(message);
      await Bun.sleep(400);
      expect(existsSync(marker)).toBe(false);
      expect(mock.turnStarts()).toHaveLength(0);
      const all = JSON.parse((await run(["list", "--all", "--json"], baseEnv(ctx), ctx.work)).stdout);
      expect(all).toEqual([]);
    });
  }

  test("discovers the daemon socket from `codex app-server daemon version`, honoring CODEX_HOME", async () => {
    setup();
    const bin = join(ctx.dir, "bin");
    mkdirSync(bin);
    // A fake codex on PATH: the real subprocess seam the monitor uses.
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/bash\n[ "$*" = "app-server daemon version" ] || exit 9\nprintf '{"status":"%s","socketPath":"%s/app.sock","appServerVersion":"0.160.0"}\\n' "\${FAKE_STATUS:-running}" "$CODEX_HOME"\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    const env = (status: string) => baseEnv(ctx, { CODEX_THREAD_ID: A, CODEX_HOME: ctx.dir, FAKE_STATUS: status, PATH: `${bin}:${process.env.PATH}` });
    const ok = await run(["start", "--interval", "0.2", "echo found"], env("running"), ctx.work);
    expect(ok.code).toBe(0);
    await mock.waitFor(terminal(A));
    expect(allText(mock.events(A))).toBe("found\n");

    const before = mock.connections();
    const stopped = await run(["start", "echo nope"], env("stopped"), ctx.work);
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toMatch(/not running/);
    expect(mock.connections()).toBe(before);
  });
});

describe("delivery failures stop the owned command and are visible", () => {
  async function descendantCommand() {
    const desc = join(ctx.work, "desc.pid");
    const id = await startOk(`sleep 300 & echo $! > ${desc}; echo up; wait`, { flags: ["--rpc-timeout", "0.6"] });
    await waitUntil(() => existsSync(desc) && readFileSync(desc, "utf8").trim() !== "");
    const descPid = Number(readFileSync(desc, "utf8").trim());
    extraPids.push(descPid);
    return { id, descPid };
  }

  async function expectFailedAndCleaned(id: string, descPid: number, reason: RegExp) {
    await waitUntil(() => readState(ctx, id).phase === "failed", 10_000, "failed phase");
    const st = readState(ctx, id);
    expect(st.delivery.error).toMatch(reason);
    await waitUntil(() => !alive(st.runner.pid) && !alive(st.child.pid) && !alive(descPid), 10_000, "owned processes gone");
    const shown = JSON.parse((await run(["status", id, "--json"], baseEnv(ctx), ctx.work)).stdout);
    expect(shown.status).toBe("failed");
  }

  test("backend disconnect", async () => {
    setup();
    const { id, descPid } = await descendantCommand();
    await mock.waitFor(() => mock.events(A).length >= 1);
    mock.dropAll();
    await expectFailedAndCleaned(id, descPid, /disconnect|closed/i);
  });

  test("turn/start rejection is not retried", async () => {
    setup();
    mock.setTurnMode("reject");
    const { id, descPid } = await descendantCommand();
    await expectFailedAndCleaned(id, descPid, /rejected/);
    await Bun.sleep(500);
    expect(mock.turnStarts()).toHaveLength(1);
  });

  test("an unanswered turn/start is ambiguous and is not replayed", async () => {
    setup();
    mock.setTurnMode("hang");
    const { id, descPid } = await descendantCommand();
    await expectFailedAndCleaned(id, descPid, /ambiguous/);
    await Bun.sleep(500);
    expect(mock.turnStarts()).toHaveLength(1);
  });

  test("a thread unloaded mid-run is not resumed by a later delivery", async () => {
    setup();
    const id = await startOk("echo one; sleep 1; echo two; sleep 300");
    await mock.waitFor(() => mock.events(A).length >= 1);
    mock.setThread(A, "notLoaded");
    await waitUntil(() => readState(ctx, id).phase === "failed", 10_000, "failed phase");
    const st = readState(ctx, id);
    expect(st.delivery.error).toMatch(/is notLoaded/);
    expect(mock.turnStarts()).toHaveLength(1);
    await waitUntil(() => !alive(st.child.pid), 10_000, "command stopped");
  });

  test("a quiet command is stopped once its thread is unloaded", async () => {
    setup();
    const id = await startOk("sleep 300", { flags: ["--heartbeat", "0.3"] });
    await Bun.sleep(1000);
    expect(readState(ctx, id).phase).toBe("running");
    mock.setThread(A, "notLoaded");
    await waitUntil(() => readState(ctx, id).phase === "failed", 10_000, "failed phase");
    const st = readState(ctx, id);
    expect(st.delivery.error).toMatch(/heartbeat: .*is notLoaded/);
    expect(mock.turnStarts()).toHaveLength(0);
    await waitUntil(() => !alive(st.child.pid), 10_000, "command stopped");
  });

  test("a crashed runner reads as lost, and stop still reaps its process group", async () => {
    setup();
    const { id, descPid } = await descendantCommand();
    const st = readState(ctx, id);
    process.kill(st.runner.pid, "SIGKILL");
    await waitUntil(() => !alive(st.runner.pid));
    const shown = JSON.parse((await run(["status", id, "--json"], baseEnv(ctx), ctx.work)).stdout);
    expect(shown.status).toBe("lost");
    const stop = await run(["stop", id], baseEnv(ctx), ctx.work);
    expect(stop.code).toBe(0);
    await waitUntil(() => !alive(st.child.pid) && !alive(descPid), 10_000, "group reaped");
    expect(JSON.parse((await run(["status", id, "--json"], baseEnv(ctx), ctx.work)).stdout).status).toBe("stopped");
  });
});

describe("stop", () => {
  test("terminates the command and its descendants and delivers one stopped event", async () => {
    setup();
    const desc = join(ctx.work, "desc.pid");
    const id = await startOk(`sleep 300 & echo $! > ${desc}; echo up; wait`);
    await mock.waitFor(() => allText(mock.events(A)).includes("up"));
    const descPid = Number(readFileSync(desc, "utf8").trim());
    extraPids.push(descPid);
    const st = readState(ctx, id);
    const r = await run(["stop", id], baseEnv(ctx), ctx.work);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${id} stopped\n`);
    expect(alive(descPid)).toBe(false);
    expect(alive(st.child.pid)).toBe(false);
    await waitUntil(() => !alive(st.runner.pid));
    const events = mock.events(A);
    expect(events.filter((e) => e.status !== "running")).toEqual([expect.objectContaining({ status: "stopped" })]);
    expect(readState(ctx, id).phase).toBe("stopped");
    // Idempotent.
    const again = await run(["stop", id], baseEnv(ctx), ctx.work);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(`${id} already stopped\n`);
  });

  test("during startup, stop ends the attempt before the command runs", async () => {
    setup();
    mock.setReadHang(true);
    const marker = join(ctx.work, "ran");
    const pending = run(["start", "--socket", mock.socketPath, `touch ${marker}`], baseEnv(ctx, { CODEX_THREAD_ID: A }), ctx.work);
    let id = "";
    await waitUntil(() => {
      const all = JSON.parse(Bun.spawnSync([BIN, "list", "--all", "--json"], { env: baseEnv(ctx) }).stdout.toString() || "[]");
      id = all.find((m: any) => m.status === "starting")?.id ?? "";
      return id !== "";
    }, 10_000, "starting record");
    const runnerPid = readState(ctx, id).runner.pid;
    const stopped = await run(["stop", id], baseEnv(ctx), ctx.work);
    expect(stopped.stderr).toBe("");
    expect(stopped.code).toBe(0);
    const r = await pending;
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    // Depending on whether the runner had loaded yet, it either reports the
    // stop itself or dies before readiness; in both cases nothing ran.
    expect(r.stderr).toMatch(/stopped before the command started|nothing ran/);
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
    expect(alive(runnerPid)).toBe(false);
    expect(JSON.parse((await run(["list", "--all", "--json"], baseEnv(ctx), ctx.work)).stdout)).toEqual([]);
  });

  test("a runner that never becomes ready is stopped and leaves no record", async () => {
    setup();
    mock.setReadHang(true);
    const marker = join(ctx.work, "ran");
    const pending = run(
      ["start", "--socket", mock.socketPath, "--rpc-timeout", "1", "--grace", "0", `touch ${marker}`],
      baseEnv(ctx, { CODEX_THREAD_ID: A }),
      ctx.work,
      30_000,
    );
    // Freeze the runner while it waits for thread/read: it can neither report nor run anything.
    let runnerPid = 0;
    await waitUntil(() => {
      const id = readdirSync(ctx.stateDir).find((n) => n.startsWith("mon-"));
      if (!id) return false;
      try {
        runnerPid = readState(ctx, id).runner?.pid ?? 0;
      } catch {
        return false;
      }
      return runnerPid > 0;
    }, 5_000, "starting record");
    process.kill(runnerPid, "SIGSTOP");
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/did not become ready within 8s; it was stopped before starting the command; nothing ran/);
    expect(alive(runnerPid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(ctx.stateDir)).toEqual([]);
  });

  test("reaps a command the runner started after stop first read the record", async () => {
    setup();
    // Stands in for the command's process group leader.
    const command = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    extraPids.push(command.pid);
    const dir = join(ctx.stateDir, "mon-late");
    mkdirSync(dir, { recursive: true });
    // A runner that, when asked to stop, records the command it has just
    // started and then dies without finishing the record.
    const runner = Bun.spawn(["bash", "-c", `trap 'mv ${dir}/next.json ${dir}/state.json; exit 0' TERM; while true; do sleep 0.05; done`]);
    extraPids.push(runner.pid);
    await waitUntil(() => procRef(command.pid) !== null && procRef(runner.pid) !== null);
    const base = {
      id: "mon-late", version: 1, thread_id: A, label: "x", cwd: ctx.work, created_at: new Date().toISOString(),
      finished_at: null, runner: procRef(runner.pid), exit: null, delivery: { sent: 0, last_seq: 0, error: null },
      error: null, grace_ms: 500, interval_ms: 5000,
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...base, phase: "starting", child: null }));
    writeFileSync(join(dir, "next.json"), JSON.stringify({ ...base, phase: "running", child: procRef(command.pid) }));
    const r = await run(["stop", "mon-late"], baseEnv(ctx), ctx.work);
    expect(r.code).toBe(0);
    await waitUntil(() => !alive(command.pid), 5_000, "command reaped");
    expect(readState(ctx, "mon-late").phase).toBe("stopped");
  });

  test("escalates to SIGKILL after the grace period", async () => {
    setup();
    const id = await startOk("trap '' TERM; echo up; while true; do sleep 0.1; done", { flags: ["--grace", "0.5"] });
    await mock.waitFor(() => allText(mock.events(A)).includes("up"));
    const st = readState(ctx, id);
    const r = await run(["stop", id], baseEnv(ctx), ctx.work);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5000);
    expect(alive(st.child.pid)).toBe(false);
  });

  test("never signals a process that merely reuses a recorded pid", async () => {
    setup();
    // A group leader, so a missing identity check would reach it via kill(-pid).
    const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    extraPids.push(bystander.pid);
    const dir = join(ctx.stateDir, "mon-reused");
    mkdirSync(dir, { recursive: true });
    const fake = {
      id: "mon-reused", version: 1, thread_id: A, label: "x", cwd: ctx.work, phase: "running",
      created_at: new Date().toISOString(), finished_at: null,
      runner: { pid: bystander.pid, start: "1" }, child: { pid: bystander.pid, start: "1" },
      exit: null, delivery: { sent: 0, last_seq: 0, error: null }, error: null,
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(fake));
    expect(JSON.parse((await run(["status", "mon-reused", "--json"], baseEnv(ctx), ctx.work)).stdout).status).toBe("lost");
    const r = await run(["stop", "mon-reused"], baseEnv(ctx), ctx.work);
    expect(r.code).toBe(0);
    await Bun.sleep(300);
    expect(alive(bystander.pid)).toBe(true);
    expect(Number(Bun.spawnSync(["ps", "-p", String(bystander.pid), "-o", "pgid="]).stdout.toString().trim())).toBe(bystander.pid);
  });

  test("corrupt state is reported, not treated as healthy", async () => {
    setup();
    mkdirSync(join(ctx.stateDir, "mon-bad"), { recursive: true });
    writeFileSync(join(ctx.stateDir, "mon-bad", "state.json"), "{not json");
    const all = JSON.parse((await run(["list", "--all", "--json"], baseEnv(ctx), ctx.work)).stdout);
    expect(all).toEqual([expect.objectContaining({ id: "mon-bad", status: "corrupt" })]);
    const st = await run(["status", "mon-bad"], baseEnv(ctx), ctx.work);
    expect(st.code).not.toBe(0);
    expect(st.stdout + st.stderr).toMatch(/corrupt/);
    expect((await run(["stop", "mon-bad"], baseEnv(ctx), ctx.work)).code).not.toBe(0);
  });
});
