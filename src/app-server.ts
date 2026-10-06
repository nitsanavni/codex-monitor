/**
 * Minimal JSON-RPC client for the Codex App Server control socket
 * (WebSocket over a Unix socket, one JSON message per text frame).
 */

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
/** The request may or may not have been applied: never replay it. */
export class AmbiguousError extends Error {}

/** Upper bound for connecting and for the initialize handshake. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Timeout for the socket connection and the initialize handshake: --rpc-timeout, capped. */
export function handshakeTimeout(rpcTimeoutMs: number): number {
  return Math.min(CONNECT_TIMEOUT_MS, rpcTimeoutMs);
}

/**
 * Longest a runner can take to attach (connect, initialize, thread/read)
 * before it reports its own error, plus a margin for process start-up.
 */
export function startupBudget(rpcTimeoutMs: number): number {
  return 2 * handshakeTimeout(rpcTimeoutMs) + rpcTimeoutMs + 5_000;
}

type Pending ={ method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer };

export class AppServerClient {
  private serial = 0;
  private readonly pending = new Map<number, Pending>();
  private closedReason: string | null = null;
  private closeListeners: Array<(reason: string) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = (e) => this.onClosed(`App Server connection closed (code ${e.code})`);
    ws.onerror = () => this.onClosed("App Server connection error");
  }

  /** Connect and complete the initialize / initialized handshake. */
  static async connect(socketPath: string, timeoutMs: number): Promise<AppServerClient> {
    const ws = new WebSocket(`ws+unix://${socketPath}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to the App Server at ${socketPath}`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to the App Server at ${socketPath}`));
      };
    });
    const client = new AppServerClient(ws);
    await client.request(
      "initialize",
      { clientInfo: { name: "codex_monitor", title: "monitor CLI", version: "1" }, capabilities: { experimentalApi: true } },
      timeoutMs,
    );
    client.notify("initialized", {});
    return client;
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  notify(method: string, params: object): void {
    this.ws.send(JSON.stringify({ method, params }));
  }

  /**
   * Send one request. A JSON-RPC error rejects with RpcError (not applied).
   * A timeout or a connection loss after sending rejects with AmbiguousError.
   */
  request(method: string, params: object, timeoutMs: number): Promise<any> {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AmbiguousError(`no response to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.closedReason ??= "closed by monitor";
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // A server-to-client request: this client offers no capabilities.
      this.ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: "monitor client handles no requests" } }));
      return;
    }
    if (msg.id === undefined) return; // notification
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(Number(msg.error.code), String(msg.error.message ?? "error")));
    else p.resolve(msg.result);
  }

  private onClosed(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AmbiguousError(`${reason} while ${p.method} was in flight`));
    }
    this.pending.clear();
    for (const l of this.closeListeners) l(reason);
  }
}

/**
 * Confirm the thread is loaded in this App Server and idle or active.
 * `thread/read` does not load or resume a thread, so a saved-but-unloaded
 * thread is refused here rather than resumed behind the user's back.
 */
export async function checkTarget(client: AppServerClient, threadId: string, timeoutMs: number): Promise<string> {
  let result: any;
  try {
    result = await client.request("thread/read", { threadId, includeTurns: false }, timeoutMs);
  } catch (e) {
    if (e instanceof RpcError) throw new Error(`target thread ${threadId} is not available: ${e.message}`);
    throw e;
  }
  const status = result?.thread?.status?.type;
  if (status !== "idle" && status !== "active") {
    throw new Error(`target thread ${threadId} is ${status ?? "in an unknown state"}; it must be loaded (idle or active)`);
  }
  return status;
}
