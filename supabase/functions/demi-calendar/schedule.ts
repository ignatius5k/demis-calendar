export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const SHIFT = 8 * 60 * MINUTE;
export const BOOKING_DAYS = 45;
export const NOTICE_DAYS = 7;
export const LEAD = 15 * MINUTE;

export type Interval = { start: number; end: number };
export type WeeklyHours = ({ start: string; end: string } | null)[];

export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function iso(time: number) {
  return new Date(time).toISOString();
}
export function midnight(epoch: number) {
  return Math.floor((epoch + SHIFT) / DAY) * DAY - SHIFT;
}
export function overlaps(a: Interval, b: Interval) {
  return a.start < b.end && b.start < a.end;
}
export function timeMinutes(value: unknown) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function validateHours(weekly: unknown, duration: unknown): asserts weekly is WeeklyHours {
  if (typeof duration !== "number" || ![30, 45, 60, 90].includes(duration)) {
    throw new RequestError(400, "Choose a supported hangout length.");
  }
  if (!Array.isArray(weekly) || weekly.length !== 7) throw new RequestError(400, "Enter hours for each day.");
  for (const [index, entry] of weekly.entries()) {
    if (entry === null) continue;
    const distance = timeMinutes(entry?.end) - timeMinutes(entry?.start);
    if (!Number.isFinite(distance) || distance < duration) {
      const day = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index];
      throw new RequestError(400, day + " needs a window of at least " + duration + " minutes.");
    }
  }
}

export function candidateSlots(now: number, days: number, weekly: WeeklyHours, duration: number) {
  const slots: Interval[] = [];
  const base = midnight(now);
  const length = duration * MINUTE;
  for (let offset = 0; offset < days; offset++) {
    const day = base + offset * DAY;
    const index = (new Date(day + SHIFT).getUTCDay() + 6) % 7;
    const range = weekly[index];
    if (!range) continue;
    const end = day + timeMinutes(range.end) * MINUTE;
    for (let slot = day + timeMinutes(range.start) * MINUTE; slot + length <= end; slot += length) {
      if (slot >= now + LEAD) slots.push({ start: slot, end: slot + length });
    }
  }
  return slots;
}

export function splitSlots(slots: Interval[], busy: Interval[]) {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const open: number[] = [], closed: number[] = [];
  let cursor = 0;
  for (const slot of slots) {
    while (cursor < sorted.length && sorted[cursor].end <= slot.start) cursor++;
    const blocked = cursor < sorted.length && overlaps(slot, sorted[cursor]);
    (blocked ? closed : open).push(slot.start);
  }
  return { open, closed };
}

const dateFormatter = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", weekday: "short", month: "short", day: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit", hour12: true });
export function label(time: number) {
  return dateFormatter.format(time) + " at " + timeFormatter.format(time).toUpperCase() + " SGT";
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isEmail(value: string) {
  return value.length <= 254 && /^[^\s@:<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}
