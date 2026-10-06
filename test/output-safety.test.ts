/**
 * Output protection: the standalone secret detector applied to streamed output at
 * real write boundaries, bounded events and logs, and redacted metadata.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { StreamRedactor } from "../src/redact";
import { startMock, type MockServer } from "./mock-app-server";
import { allText, baseEnv, cleanup, makeCtx, run, type Ctx } from "./helpers";

const A = "thread-aaaa";
// Assembled at runtime so this file holds no literal secret-shaped values.
const ANTHROPIC_TAIL = ["AbCdEfGhIj", "KlMnOpQrSt", "UvWxYz0123", "456789"].join("");
const ANTHROPIC = `sk-ant-api03-${ANTHROPIC_TAIL}`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "example.invalid", ref: "synthetic", exp: 1999999999 })}.${"Q2xvdWRzaWduYXR1cmUxMjM0NTY3ODk"}`;
const PEM_BODY = ["synthetic-key-body-first-line", "synthetic-key-body-second-line"];
const PEM = ["-----BEGIN " + "PRIVATE KEY-----", ...PEM_BODY, "-----END " + "PRIVATE KEY-----", ""].join("\n");

let ctx: Ctx;
let mock: MockServer;
afterEach(() => {
  mock?.stop();
  if (ctx) cleanup(ctx);
});

const terminal = () => mock.events(A).some((e) => e.status !== "running");

async function monitor(command: string, flags: string[] = [], env: Record<string, string> = {}) {
  ctx = makeCtx();
  mock = startMock(ctx.dir, { [A]: "idle" });
  const r = await run(
    ["start", "--socket", mock.socketPath, "--interval", "0.1", ...flags, command],
    baseEnv(ctx, { CODEX_THREAD_ID: A, ...env }),
    ctx.work,
  );
  expect(r.code).toBe(0);
  await mock.waitFor(terminal, 20_000, "terminal event");
  return { id: r.stdout.trim(), events: mock.events(A) };
}

describe("streamed redaction through the real runner", () => {
  test("a token split across writes and batches is redacted whole", async () => {
    const [head, tail] = [ANTHROPIC.slice(0, 13), ANTHROPIC.slice(13)];
    const { events } = await monitor(`printf 'key: ${head}'; sleep 0.6; printf '${tail}\\n'; sleep 0.3; echo after`);
    const text = allText(events);
    expect(text).toContain("<REDACTED:anthropic>");
    expect(text).not.toContain(ANTHROPIC_TAIL.slice(0, 12));
    expect(text).toContain("after\n");
  });

  test("a private key block written over several pauses is withheld and redacted", async () => {
    const lines = PEM.trimEnd().split("\n");
    const cmd = lines.map((l) => `echo '${l}'; sleep 0.3`).join("; ") + "; echo done";
    const { events } = await monitor(cmd);
    const text = allText(events);
    for (const body of PEM_BODY) expect(text).not.toContain(body.slice(0, 16));
    expect(text).toContain("<REDACTED:private-key-pem>");
    expect(text).toContain("done\n");
  });

  test("an unterminated key block at exit is still redacted", async () => {
    const { events } = await monitor(`echo '-----BEGIN RSA PRIVATE KEY-----'; echo '${PEM_BODY[0]}'`);
    expect(allText(events)).not.toContain(PEM_BODY[0].slice(0, 16));
  });

  test("JWTs are redacted even when their context arrives later", async () => {
    const { events } = await monitor(`echo '${JWT}'; sleep 0.5; echo 'role was SERVICE_ROLE'`);
    const text = allText(events);
    expect(text).not.toContain(JWT.split(".")[2]);
    expect(text).toContain("SERVICE_ROLE");
  });

  test("UTF-8 split across writes is decoded intact", async () => {
    const { events } = await monitor(`printf '\\xe2\\x82'; sleep 0.5; printf '\\xac ok\\n'`);
    expect(allText(events)).toBe("€ ok\n");
  });

  test("secret-reading commands use the strict detector", async () => {
    const value = ["Xk39dk2l", "P0qmZ8vB", "1nT7"].join("");
    const { events } = await monitor("echo $DEMO_API_TOKEN", [], { DEMO_API_TOKEN: value });
    expect(allText(events)).not.toContain(value);
  });

  test("command text is redacted in events, list, status and state files", async () => {
    const { id, events } = await monitor(`echo hi # ${ANTHROPIC}`);
    expect(JSON.stringify(events)).not.toContain(ANTHROPIC_TAIL);
    expect(events[0].label).toContain("<REDACTED:anthropic>");
    const list = await run(["list", "--all"], baseEnv(ctx), ctx.work);
    const status = await run(["status", id], baseEnv(ctx), ctx.work);
    expect(list.stdout + status.stdout).not.toContain(ANTHROPIC_TAIL);
    for (const f of readdirSync(join(ctx.stateDir, id))) {
      expect(readFileSync(join(ctx.stateDir, id, f), "utf8")).not.toContain(ANTHROPIC_TAIL);
    }
  });
});

describe("bounded output", () => {
  test("a no-newline flood yields bounded events, a withheld notice, and a bounded log", async () => {
    const { id, events } = await monitor("head -c 3000000 /dev/zero | tr '\\0' a; echo; echo tail-marker");
    for (const e of events) expect(JSON.stringify(e).length).toBeLessThan(20_000);
    const text = allText(events);
    expect(text).toMatch(/withheld/);
    expect(text).toContain("tail-marker\n");
    const dir = join(ctx.stateDir, id);
    const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThan(700_000);
  });

  test("a line flood is truncated per event with an omitted count", async () => {
    const { events } = await monitor("yes 'flood line' | head -n 200000; echo last-line");
    for (const e of events) expect(JSON.stringify(e).length).toBeLessThan(20_000);
    expect(events.some((e) => e.omitted_chars > 0)).toBe(true);
    expect(allText(events)).toContain("last-line\n");
  });
});

describe("StreamRedactor write boundaries", () => {
  const feedAll = (text: string, cuts: number[], strict = false) => {
    const r = new StreamRedactor({ strict });
    const bytes = new TextEncoder().encode(text);
    let out = "";
    let prev = 0;
    for (const c of [...cuts, bytes.length]) {
      out += r.push(bytes.subarray(prev, c));
      prev = c;
    }
    return out + r.end();
  };

  const cases: Array<[string, string, string]> = [
    ["provider token", `token ${ANTHROPIC} end\n`, ANTHROPIC_TAIL.slice(0, 10)],
    ["private key", `x\n${PEM}y\n`, PEM_BODY[1].slice(0, 12)],
    ["jwt", `jwt=${JWT}\n`, JWT.split(".")[2]],
    ["bearer split over lines", `Authorization: Bearer\n${["k3J9xQ2mZp", "7LwT4vRb8N"].join("")}\n`, "k3J9xQ2mZp7L"],
    ["password assignment", `PASSWORD=${["hunter2", "hunter2x"].join("")}\n`, "hunter2hunter2x"],
  ];
  for (const [name, text, secret] of cases) {
    test(`${name}: no leak at any single or paired cut`, () => {
      const n = new TextEncoder().encode(text).length;
      for (let i = 0; i <= n; i++) {
        expect(feedAll(text, [i])).not.toContain(secret);
        for (let j = i; j <= n; j += 7) expect(feedAll(text, [i, j])).not.toContain(secret);
      }
    });
  }

  test("plain text passes through unchanged at every cut", () => {
    const text = "build ok €\r50% done\nall green\n";
    const n = new TextEncoder().encode(text).length;
    for (let i = 0; i <= n; i++) expect(feedAll(text, [i])).toBe(text);
  });

  test("memory stays bounded for an endless unbroken run", () => {
    const r = new StreamRedactor({ strict: false });
    const chunk = new TextEncoder().encode("z".repeat(10_000));
    let out = "";
    for (let i = 0; i < 200; i++) out += r.push(chunk);
    expect(r.pendingChars()).toBeLessThanOrEqual(70_000);
    out += r.push(new TextEncoder().encode(" next\n")) + r.end();
    expect(out).toMatch(/withheld/);
    expect(out.endsWith(" next\n")).toBe(true);
    expect(out.length).toBeLessThan(1000);
  });
});
