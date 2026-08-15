const ANSI_ESCAPE_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ZERO_WIDTH_BIDI_PATTERN =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const CONTROL_CHARS_PATTERN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const EXCESS_NEWLINES_PATTERN = /\n{3,}/g;
const TRUNCATION_SUFFIX = " …[truncated]";

// String.prototype.toWellFormed is ES2024; this project's tsconfig lib is es2023.
function toWellFormed(v: string): string {
  return (v as unknown as { toWellFormed(): string }).toWellFormed();
}

export function sanitizeModelText(s: string, max?: number): string {
  if (typeof s !== "string") {
    return "";
  }

  // Replace lone surrogates with U+FFFD up front so every later slice — and the
  // returned string — is well-formed no matter how ill-formed the input was.
  let result = toWellFormed(s).normalize("NFKC");
  result = result.replace(ANSI_ESCAPE_PATTERN, "");
  result = result.replace(ZERO_WIDTH_BIDI_PATTERN, "");
  result = result.replace(CONTROL_CHARS_PATTERN, "");
  result = result.replace(EXCESS_NEWLINES_PATTERN, "\n\n").trim();

  if (max !== undefined) {
    // Non-positive (or NaN) max leaves no room for any output at all.
    if (!(max > 0)) {
      return "";
    }
    if (result.length > max) {
      if (max <= TRUNCATION_SUFFIX.length) {
        return TRUNCATION_SUFFIX.slice(0, max);
      }
      let cutLen = max - TRUNCATION_SUFFIX.length;
      const code = result.charCodeAt(cutLen - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        // Never cut between the halves of a surrogate pair.
        cutLen -= 1;
      }
      return result.slice(0, cutLen) + TRUNCATION_SUFFIX;
    }
  }

  return result;
}

const HOMOGLYPH_MAP: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  ј: "j",
  α: "a",
  ο: "o",
  ρ: "p",
  А: "a",
  Е: "e",
  О: "o",
  Р: "p",
  С: "c",
  Х: "x",
  Ѕ: "s",
  Ј: "j",
  Α: "a",
  Ο: "o",
  Ρ: "p",
};

const HOMOGLYPH_PATTERN = /[аеорсухіѕјаеорсхѕјаοραορ]/gi;

export function confusableSkeleton(s: string): string {
  if (typeof s !== "string") {
    return "";
  }
  const normalized = s.normalize("NFKC").toLowerCase();
  return normalized.replace(HOMOGLYPH_PATTERN, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
}

// Multi-token markers are matched as two independent single-token searches
// instead of one `token1.*token2` regex: an unbounded gap span backtracks
// quadratically (300k chars of "cur"+"l " took 11.7s), while two linear scans
// plus a slice stay O(N) *and* detect tokens any distance apart.
function orderedTokens(t: string, first: RegExp, second: RegExp): boolean {
  const m = first.exec(t);
  return m !== null && second.test(t.slice(m.index + m[0].length));
}

const INJECTION_PATTERNS: ReadonlyArray<readonly [string, (t: string) => boolean]> = [
  ["ignore_previous", (t) => /ignore\s+(all\s+)?(previous|prior|above)/i.test(t)],
  ["system_prompt", (t) => /system\s*prompt|<\s*system\s*>/i.test(t)],
  ["conceal", (t) => /do not (tell|mention|inform)|without (telling|informing)/i.test(t)],
  ["credential_path", (t) => /\.ssh|id_[rd]sa|\/etc\/shadow|\.env\b|credentials\.json/i.test(t)],
  [
    "exfil",
    (t) =>
      orderedTokens(t, /curl\s/i, /\|\s*(sh|bash)\b/i) ||
      /base64\s+-d/i.test(t) ||
      orderedTokens(t, /\bwebhook\b/i, /\bpost\b/i),
  ],
  [
    "tool_directive",
    (t) =>
      /\bbefore using this tool\b/i.test(t) ||
      orderedTokens(t, /\balways call\b/i, /\bfirst\b/i),
  ],
];

export function scanForInjection(s: string): string[] {
  try {
    if (typeof s !== "string") {
      return [];
    }
    const clean = confusableSkeleton(sanitizeModelText(s));
    const matched: string[] = [];
    for (const [name, matches] of INJECTION_PATTERNS) {
      if (matches(clean)) {
        matched.push(name);
      }
    }
    return matched;
  } catch {
    return [];
  }
}
