import { BOISE_TIME_ZONE } from "../missions/contract";

// The America/Boise calendar that M2B's daily and monthly caps and approval expiry follow. Boise observes Mountain
// time: UTC-7 in winter, UTC-6 in summer. Its clocks change at 02:00 local, so every Boise day has a midnight: most
// days have 24 hours, the first Sunday of November 25 (2026-11-01) and the second Sunday of March 23 (2027-03-14).

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BOISE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function valid(at: Date): Date {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("A valid date is needed to place a cost on the Boise calendar.");
  return at;
}

/** The Boise wall-clock time at an instant. */
export function boiseTime(at: Date): LocalTime {
  const parts: Record<string, number> = {};
  for (const p of FORMAT.formatToParts(valid(at))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const t = { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
  if (Object.values(t).some((n) => !Number.isInteger(n))) throw new Error("The Boise time couldn't be worked out.");
  return t;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD in America/Boise. */
export function boiseDay(at: Date): string {
  const t = boiseTime(at);
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

/** YYYY-MM in America/Boise. */
export function boiseMonth(at: Date): string {
  return boiseDay(at).slice(0, 7);
}

const isMidnightOf = (at: Date, y: number, m: number, d: number) => {
  const t = boiseTime(at);
  return t.year === y && t.month === m && t.day === d && t.hour === 0 && t.minute === 0 && t.second === 0;
};

/** The next America/Boise midnight after `at`: when an approval given at `at` expires. */
export function endOfBoiseDay(at: Date): Date {
  const t = boiseTime(at);
  // The next calendar date, by plain date arithmetic (month and year roll over).
  const next = new Date(Date.UTC(t.year, t.month - 1, t.day + 1));
  const y = next.getUTCFullYear();
  const m = next.getUTCMonth() + 1;
  const d = next.getUTCDate();
  // Boise's midnight is 06:00 or 07:00 UTC. Should the rules ever change, every whole quarter-hour offset is tried.
  const offsets = [6 * 60, 7 * 60];
  for (let q = -14 * 60; q <= 14 * 60; q += 15) if (!offsets.includes(q)) offsets.push(q);
  for (const minutes of offsets) {
    const candidate = new Date(Date.UTC(y, m - 1, d, 0, minutes));
    if (isMidnightOf(candidate, y, m, d)) return candidate;
  }
  throw new Error(`The end of the Boise day ${boiseDay(at)} couldn't be worked out.`);
}
