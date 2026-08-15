const ANSI_ESCAPE_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ZERO_WIDTH_BIDI_PATTERN =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const CONTROL_CHARS_PATTERN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const EXCESS_NEWLINES_PATTERN = /\n{3,}/g;
const TRUNCATION_SUFFIX = " …[truncated]";

export function sanitizeModelText(s: string, max?: number): string {
  if (typeof s !== "string") {
    return "";
  }

  let result = s.normalize("NFKC");
  result = result.replace(ANSI_ESCAPE_PATTERN, "");
  result = result.replace(ZERO_WIDTH_BIDI_PATTERN, "");
  result = result.replace(CONTROL_CHARS_PATTERN, "");
  result = result.replace(EXCESS_NEWLINES_PATTERN, "\n\n").trim();

  if (max !== undefined && result.length > max) {
    if (max <= TRUNCATION_SUFFIX.length) {
      return TRUNCATION_SUFFIX.slice(0, max);
    }
    return result.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
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

const INJECTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["ignore_previous", /ignore\s+(all\s+)?(previous|prior|above)/i],
  ["system_prompt", /system\s*prompt|<\s*system\s*>/i],
  ["conceal", /do not (tell|mention|inform)|without (telling|informing)/i],
  ["credential_path", /\.ssh|id_[rd]sa|\/etc\/shadow|\.env\b|credentials\.json/i],
  ["exfil", /curl\s[^|]*\|\s*(sh|bash)|base64\s+-d|\bwebhook\b.*\bpost\b/i],
  ["tool_directive", /\bbefore using this tool\b|\balways call\b.*\bfirst\b/i],
];

export function scanForInjection(s: string): string[] {
  try {
    if (typeof s !== "string") {
      return [];
    }
    const clean = confusableSkeleton(sanitizeModelText(s));
    const matched: string[] = [];
    for (const [name, regex] of INJECTION_PATTERNS) {
      if (regex.test(clean)) {
        matched.push(name);
      }
    }
    return matched;
  } catch {
    return [];
  }
}
