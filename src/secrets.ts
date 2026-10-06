/** Self-contained, best-effort secret detection. No network or environment reads. */
export interface SecretMatch {
  provider: string;
  value: string;
  start: number;
  end: number;
}

export function detectSecrets(text: string, { strict = false } = {}): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const add = (provider: string, pattern: RegExp, capture = 0) => {
    for (const m of text.matchAll(pattern)) {
      const value = m[capture];
      if (!value) continue;
      const start = m.index! + (capture ? m[0].lastIndexOf(value) : 0);
      matches.push({ provider, value, start, end: start + value.length });
    }
  };
  add("private-key-pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g);
  add("anthropic", /sk-ant-[A-Za-z0-9_-]{12,}/g);
  add("openai", /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g);
  add("github", /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g);
  add("slack", /xox[baprs]-[A-Za-z0-9-]{10,}/g);
  add("aws", /(?:AKIA|ASIA)[A-Z0-9]{16}/g);
  add("google", /AIza[A-Za-z0-9_-]{30,}/g);
  add("stripe", /(?:sk|rk)_live_[A-Za-z0-9]{16,}/g);
  add("jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
  add("authorization", /\b(?:Bearer|Basic)\s+([A-Za-z0-9_+/=.-]{8,})/gi, 1);
  add("credential", /\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;"'<>]+))/gi);
  add("url-credentials", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi, 1);
  if (strict) add("opaque-token", /^[ \t]*([A-Za-z0-9_+/=-]{20,})[ \t]*$/gm, 1);
  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function redactSecrets(text: string, options = { strict: true }): { redacted: string } {
  let redacted = "";
  let cursor = 0;
  for (const match of detectSecrets(text, options)) {
    if (match.start >= cursor) redacted += text.slice(cursor, match.start) + `<REDACTED:${match.provider}>`;
    cursor = Math.max(cursor, match.end);
  }
  return { redacted: redacted + text.slice(cursor) };
}
