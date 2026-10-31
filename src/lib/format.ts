const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function money(cents: number | null | undefined, opts: { exact?: boolean } = {}): string {
  if (cents === null || cents === undefined) return "—";
  return (opts.exact ? usdCents : usd).format(cents / 100);
}

export function pct(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function date(d: Date | string | null | undefined): string {
  return d ? dateFmt.format(new Date(d)) : "—";
}

export function dateTime(d: Date | string | null | undefined): string {
  return d ? dateTimeFmt.format(new Date(d)) : "—";
}

/** Parse "$4,350" / "4350" / "4350.50" into integer cents; null when blank or invalid. */
export function parseDollars(input: FormDataEntryValue | null): number | null {
  if (typeof input !== "string") return null;
  const clean = input.replace(/[$,\s]/g, "");
  if (!clean) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Only http(s) links are ever rendered as anchors (blocks javascript: and data: URLs). */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function lines(text: FormDataEntryValue | null): string[] {
  if (typeof text !== "string") return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}
