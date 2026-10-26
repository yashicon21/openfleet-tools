const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// key=value / key: value style secrets; keeps the key, redacts the value.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

// user:pass@host in URLs
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi;

/** Redact known secret patterns, plus any exact `literals` (for example values from copied env files). */
export function redactString(input: string, literals: readonly string[] = []): string {
  let out = input;
  for (const lit of literals) if (lit) out = out.split(lit).join(REDACTED);
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(URL_CREDS, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  return out;
}

export function redact<T>(value: T, literals: readonly string[] = []): T {
  if (typeof value === "string") return redactString(value, literals) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => redact(v, literals)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, literals);
    return out as T;
  }
  return value;
}
