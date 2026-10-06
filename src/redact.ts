/** Incremental, bounded, best-effort redaction before output leaves the helper. */
import { detectSecrets, type SecretMatch } from "./secrets";

export const SOFT_CAP = 8 * 1024;
export const HARD_CAP = 64 * 1024;
export const PEM_CAP = 16 * 1024;
const LOOKBACK = 512;

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A BEGIN marker cut short at the end of a forced segment. */
const PEM_BEGIN_PARTIAL = /-----(?:B(?:E(?:G(?:I(?:N(?: [A-Z ]*)?)?)?)?)?)?$/;
const SAFE_CUT = /[\s"'`,;{}[\]()<>|]/;

export interface RedactorOptions {
  /** Also apply the detector's strict (sole-token line) rule. */
  strict: boolean;
}

export class StreamRedactor {
  private readonly decoder = new TextDecoder("utf-8");
  private pending = "";
  private context = "";
  /** Characters dropped from the current over-long unbroken run. */
  private withheld = 0;
  /** Inside a private-key block that exceeded PEM_CAP: drop until END. */
  private inPem = false;
  readonly providers = new Set<string>();
  redactions = 0;

  constructor(private readonly opts: RedactorOptions) {}

  pendingChars(): number {
    return this.pending.length;
  }

  push(bytes: Uint8Array): string {
    this.pending += this.decoder.decode(bytes, { stream: true });
    return this.release(false);
  }

  end(): string {
    this.pending += this.decoder.decode();
    return this.release(true);
  }

  private release(final: boolean): string {
    let out = "";
    if (this.inPem) {
      const end = PEM_END.exec(this.pending);
      if (!end) {
        this.pending = "";
        return final ? "\n" : "";
      }
      this.inPem = false;
      this.pending = this.pending.slice(end.index + end[0].length);
    }
    if (this.withheld > 0) {
      const sep = this.pending.search(SAFE_CUT);
      if (sep < 0 && !final) {
        this.withheld += this.pending.length;
        this.pending = "";
        return "";
      }
      const dropped = sep < 0 ? this.pending.length : sep;
      this.withheld += dropped;
      this.pending = this.pending.slice(dropped);
      out += `[monitor: unbroken output run ended; ${this.withheld} characters withheld]`;
      this.withheld = 0;
    }

    let cut = final ? this.pending.length : lastBreak(this.pending);
    if (!final && this.pending.length - cut > SOFT_CAP) {
      const sep = lastSafeCut(this.pending, cut);
      if (sep > cut) {
        cut = sep;
        const partial = PEM_BEGIN_PARTIAL.exec(this.pending.slice(Math.max(0, cut - 40), cut));
        if (partial) cut -= partial[0].length;
      } else if (this.pending.length - cut > HARD_CAP) {
        // One run with no separator at all: a blob, not readable output.
        this.withheld = this.pending.length - cut;
        this.pending = this.pending.slice(0, cut);
        out += this.emit(this.pending);
        this.pending = "";
        return out + `[monitor: withholding an unbroken output run longer than ${HARD_CAP} characters]`;
      }
    }

    // Hold an unterminated private-key block until its END line.
    const head = this.pending.slice(0, cut);
    let open = -1;
    for (const m of head.matchAll(PEM_BEGIN)) {
      if (!PEM_END.test(head.slice(m.index! + m[0].length))) {
        open = m.index!;
        break;
      }
    }
    if (open >= 0) {
      if (final) {
        out += this.emit(this.pending.slice(0, open)) + this.redactedPem();
        this.pending = "";
        return out;
      }
      if (this.pending.length - open > PEM_CAP) {
        out += this.emit(this.pending.slice(0, open)) + this.redactedPem() + "\n";
        this.pending = "";
        this.inPem = true;
        return out;
      }
      cut = open;
    }

    out += this.emit(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    return out;
  }

  private redactedPem(): string {
    this.redactions++;
    this.providers.add("private-key-pem");
    this.context = "";
    return "<REDACTED:private-key-pem>";
  }

  /** Redact `segment` using the lookback context, and advance the context. */
  private emit(segment: string): string {
    if (segment.length === 0) return "";
    const base = this.context.length;
    const text = this.context + segment;
    const matches: SecretMatch[] = detectSecrets(text, { strict: this.opts.strict });
    for (const m of text.matchAll(JWT_SHAPE)) {
      matches.push({ provider: "jwt", value: m[0], start: m.index!, end: m.index! + m[0].length });
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    for (const m of matches) {
      if (m.end <= base) continue;
      const start = Math.max(m.start, base) - base;
      const end = m.end - base;
      if (start < cursor) {
        cursor = Math.max(cursor, end);
        continue;
      }
      out += segment.slice(cursor, start) + `<REDACTED:${m.provider}>`;
      cursor = end;
      this.redactions++;
      this.providers.add(m.provider);
    }
    out += segment.slice(cursor);
    this.context = text.slice(-LOOKBACK);
    return out;
  }
}

function lastBreak(s: string): number {
  return Math.max(s.lastIndexOf("\n"), s.lastIndexOf("\r")) + 1;
}

/** Index just past the last safe separator after `from`, or -1. */
function lastSafeCut(s: string, from: number): number {
  for (let i = s.length - 1; i >= from; i--) if (SAFE_CUT.test(s[i])) return i + 1;
  return -1;
}
