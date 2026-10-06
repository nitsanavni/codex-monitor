/**
 * In-process mock of the Codex App Server control socket: a real WebSocket
 * server on a Unix socket speaking newline-free JSON-RPC text frames, so the
 * monitor's serialization, handshake and framing are exercised as in
 * production. It enforces the parts of the contract the monitor relies on.
 */
import { join } from "node:path";
import { unlinkSync } from "node:fs";

export type ThreadStatus = "idle" | "active" | "notLoaded" | "systemError" | "unknown";
export type TurnMode = "ok" | "reject" | "hang" | "close";

export interface Received {
  conn: number;
  msg: any;
}

export interface MockServer {
  socketPath: string;
  received: Received[];
  connections: () => number;
  setThread: (id: string, status: ThreadStatus) => void;
  setTurnMode: (mode: TurnMode) => void;
  /** Leave thread/read unanswered (a slow or wedged server during startup). */
  setReadHang: (hang: boolean) => void;
  /** Close every open connection from the server side. */
  dropAll: () => void;
  /** Every `toolOutput.output` delivered to `threadId`, parsed as JSON. */
  events: (threadId?: string) => any[];
  turnStarts: () => any[];
  waitFor: (pred: () => boolean, timeoutMs?: number, what?: string) => Promise<void>;
  stop: () => void;
}

export function startMock(dir: string, threads: Record<string, ThreadStatus>): MockServer {
  const socketPath = join(dir, "app.sock");
  try {
    unlinkSync(socketPath);
  } catch {}
  const status = new Map<string, ThreadStatus>(Object.entries(threads));
  const activeTurn = new Map<string, string>();
  let turnMode: TurnMode = "ok";
  let readHang = false;
  let connCount = 0;
  let turnSerial = 0;
  const received: Received[] = [];
  const open = new Set<any>();

  const server = Bun.serve<{ conn: number; initialized: boolean; initRequested: boolean }>({
    unix: socketPath,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { conn: ++connCount, initialized: false, initRequested: false } })) return undefined;
      return new Response("websocket only", { status: 400 });
    },
    websocket: {
      open(ws) {
        open.add(ws);
      },
      close(ws) {
        open.delete(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        received.push({ conn: ws.data.conn, msg });
        const reply = (body: object): void => {
          ws.send(JSON.stringify({ id: msg.id, ...body }));
        };
        const fail = (code: number, message: string) => reply({ error: { code, message } });
        if (msg.method === "initialize") {
          ws.data.initRequested = true;
          // A notification before the response, as the real server sends.
          ws.send(JSON.stringify({ method: "configWarning", params: {} }));
          return reply({ result: { userAgent: "mock", codexHome: "/nowhere", platformFamily: "unix", platformOs: "linux" } });
        }
        if (msg.method === "initialized") {
          if (!ws.data.initRequested) throw new Error("initialized before initialize");
          ws.data.initialized = true;
          return;
        }
        if (!ws.data.initialized) return fail(-32600, "not initialized");
        if (msg.method === "thread/read") {
          if (readHang) return;
          const s = status.get(msg.params?.threadId) ?? "unknown";
          // As the real server (0.160): an unknown id is an error, while a
          // thread saved on disk but not loaded reads fine with status
          // notLoaded, and reading it does not load it.
          if (s === "unknown") return fail(-32600, `thread not loaded: ${msg.params?.threadId}`);
          return reply({
            result: {
              thread: {
                id: msg.params.threadId,
                status: s === "active" ? { type: "active", activeFlags: [] } : { type: s },
              },
            },
          });
        }
        if (msg.method === "turn/start") {
          const p = msg.params ?? {};
          const s = status.get(p.threadId) ?? "unknown";
          // Model the hazard: turn/start on a saved-but-unloaded thread would
          // resume it. The monitor must never send one.
          if (s === "notLoaded") {
            status.set(p.threadId, "idle");
            return reply({ result: { turn: { id: `turn-${++turnSerial}`, status: "inProgress", items: [] } } });
          }
          if (s !== "idle" && s !== "active") return fail(-32600, `thread not loaded: ${p.threadId}`);
          if (!Array.isArray(p.input) || p.input.length !== 0) return fail(-32602, "monitor contract: input must be []");
          if (p.toolOutput?.name !== "monitor_event" || typeof p.toolOutput?.output !== "string") {
            return fail(-32602, "monitor contract: toolOutput.name/output");
          }
          if (turnMode === "reject") return fail(-32000, "turn rejected by mock");
          if (turnMode === "hang") return;
          if (turnMode === "close") return ws.close();
          // Active: the output steers the running turn. Idle: a new turn starts.
          let turnId = activeTurn.get(p.threadId);
          if (s === "idle" || !turnId) {
            turnId = `turn-${++turnSerial}`;
            if (s === "active") activeTurn.set(p.threadId, turnId);
          }
          return reply({ result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        }
        return fail(-32601, `method not found: ${msg.method}`);
      },
    },
  });

  const turnStarts = () => received.filter((r) => r.msg.method === "turn/start").map((r) => r.msg);
  return {
    socketPath,
    received,
    connections: () => connCount,
    setThread: (id, s) => status.set(id, s),
    setTurnMode: (m) => {
      turnMode = m;
    },
    setReadHang: (h) => {
      readHang = h;
    },
    dropAll: () => {
      for (const ws of open) ws.close(1011, "mock drop");
    },
    turnStarts,
    events: (threadId) =>
      turnStarts()
        .filter((m) => threadId === undefined || m.params.threadId === threadId)
        .map((m) => JSON.parse(m.params.toolOutput.output)),
    waitFor: async (pred, timeoutMs = 10_000, what = "condition") => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (pred()) return;
        await Bun.sleep(25);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    stop: () => {
      server.stop(true);
      try {
        unlinkSync(socketPath);
      } catch {}
    },
  };
}
