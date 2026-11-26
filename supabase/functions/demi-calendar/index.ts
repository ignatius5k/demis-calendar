import postgres from "postgres";
import { buildPushPayload, type PushSubscription } from "web-push";
import { appleClient, type AppleCalendar, type AppleEvent, type Credentials } from "./apple.ts";
import {
  BOOKING_DAYS, candidateSlots, DAY, DURATION_STEP, durationOptions, durationWindows, isBookingDuration,
  isEmail, isId, iso, label, midnight, MINUTE, NOTICE_DAYS,
  overlaps, RequestError, splitSlots, validateHours, type Interval, type WeeklyHours,
} from "./schedule.ts";

const SITE = "https://ignatius5k.github.io";
const database = Deno.env.get("SUPABASE_DB_URL");
if (!database) throw new Error("Missing SUPABASE_DB_URL.");
const sql = postgres(database, { max: 2, prepare: false, idle_timeout: 10, connect_timeout: 8, onnotice: () => {} });

type Connection = {
  email: string;
  calendars: AppleCalendar[];
  busyCalendars: string[];
  writeCalendar: string;
};
type Settings = {
  host_key_hash: string | null;
  length_minutes: number;
  weekly: WeeklyHours;
  connection: Connection | null;
  vapid_public_key: string | null;
  closed_slots: number[];
};
type EventRow = {
  id: string;
  kind: "booking" | "block";
  state: "pending" | "confirmed" | "canceling" | "canceled";
  starts_at: Date;
  ends_at: Date;
  calendar_url: string;
  name: string;
  email: string;
  note: string;
  sync_lease_until: Date;
};
type ActivityRow = { id: string; title: string; body: string; push_body: string; created_at: Date };

const encoder = new TextEncoder();

function safeEqual(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index++) difference |= (a.charCodeAt(index) || 0) ^ b.charCodeAt(index);
  return difference === 0;
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getSettings() {
  const [settings] = await sql<Settings[]>`select * from demi.settings where id`;
  return settings;
}

async function getSecret(name: string) {
  const [row] = await sql<{ decrypted_secret: string }[]>`
    select decrypted_secret from vault.decrypted_secrets where name = ${name}
  `;
  return row?.decrypted_secret || null;
}

async function credentials() {
  const secret = await getSecret("demi_apple_connection");
  if (!secret) throw new RequestError(409, "Apple Calendar hasn’t been connected yet.");
  return JSON.parse(secret) as Credentials;
}

async function authorize(req: Request, settings: Settings) {
  const key = req.headers.get("X-Demi-Key") || "";
  if (!settings.host_key_hash || !/^[A-Za-z0-9_-]{43}$/.test(key) ||
    !safeEqual(await digest(key), settings.host_key_hash)) {
    throw new RequestError(401, "That host key doesn’t match.");
  }
}

function readString(value: unknown, limit: number, multiline = false) {
  if (typeof value !== "string" || value.length > limit) throw new RequestError(400, "Check the details and try again.");
  return (multiline ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    : value.replace(/[\u0000-\u001F\u007F]/g, " ")).trim();
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new RequestError(415, "Send JSON data.");
  const declaredSize = Number(req.headers.get("content-length") || 0);
  if (declaredSize > 12_000) throw new RequestError(413, "The request is too long.");
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError(400, "Check the details and try again.");
  const decoder = new TextDecoder();
  let size = 0, text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 12_000) {
      await reader.cancel();
      throw new RequestError(413, "The request is too long.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try {
    const input = JSON.parse(text + decoder.decode());
    if (!input || Array.isArray(input) || typeof input !== "object") throw new Error();
    return input;
  } catch {
    throw new RequestError(400, "Check the details and try again.");
  }
}

function eventInterval(row: EventRow) {
  return { start: row.starts_at.getTime(), end: row.ends_at.getTime() };
}

async function storedBusy(range: Interval) {
  const rows = await sql<EventRow[]>`
    select starts_at, ends_at from demi.events
    where state <> 'canceled' and starts_at < ${iso(range.end)} and ends_at > ${iso(range.start)}
  `;
  return rows.map(eventInterval);
}

async function busyTimes(connection: Connection, range: Interval, access: Credentials) {
  const api = appleClient(access);
  const calendars = [...new Set([...connection.busyCalendars, connection.writeCalendar])];
  const [storage, ...apple] = await Promise.all([
    storedBusy(range),
    ...calendars.map((calendar) => api.busy(calendar, range.start, range.end)),
  ]);
  return [...storage, ...apple.flat()];
}

async function availability(settings: Settings) {
  const now = Date.now();
  const windows = durationWindows(now, BOOKING_DAYS, settings.weekly);
  const connection = settings.connection;
  if (!connection || !windows.length) {
    return { connected: Boolean(connection), starts: [], options: [], duration: settings.length_minutes };
  }
  const range = { start: windows[0].start, end: windows[windows.length - 1].end };
  const busy = await busyTimes(connection, range, await credentials());
  const slots = candidateSlots(now, BOOKING_DAYS, settings.weekly, settings.length_minutes);
  const { open } = splitSlots(slots, busy);
  return { connected: true, starts: open, options: durationOptions(windows, busy), duration: settings.length_minutes };
}

async function hostView(settings?: Settings) {
  const config = settings || await getSettings();
  const [events, activity, subscriptions] = await Promise.all([
    sql<EventRow[]>`select id, kind, state, starts_at, ends_at, name, email, note from demi.events
      where state <> 'canceled' and ends_at > now() order by starts_at`,
    sql<ActivityRow[]>`select id, title, body, created_at from demi.activity order by created_at desc limit 24`,
    sql<{ endpoint: string }[]>`select endpoint from demi.subscriptions`,
  ]);
  const details = (event: EventRow) => ({
    id: event.id, status: event.state, ...eventInterval(event), name: event.name, email: event.email, note: event.note,
  });
  return {
    connection: config.connection, duration: config.length_minutes, weekly: config.weekly,
    pushKey: config.vapid_public_key, pushEndpoints: subscriptions.map((row) => row.endpoint),
    bookings: events.filter((e) => e.kind === "booking").map(details),
    blocks: events.filter((e) => e.kind === "block").map(details),
    activity: activity.map((a) => ({ id: a.id, title: a.title, body: a.body, created: a.created_at.getTime() })),
  };
}

async function connect(input: Record<string, unknown>, settings: Settings) {
  const email = readString(input.email, 254).toLowerCase();
  const rawPassword = readString(input.password, 64);
  const compact = rawPassword.replace(/-/g, "");
  if (!isEmail(email) || !/^[a-z0-9]{16}$/i.test(compact)) {
    throw new RequestError(400, "Enter your Apple Account email and a 16-character app-specific password.");
  }
  const access = { email, password: compact.match(/.{4}/g)!.join("-") };
  const calendars = await appleClient(access).discover();
  const previous = settings.connection;
  const sameAccount = previous?.email === email;
  const known = new Set(calendars.map((calendar) => calendar.id));
  const writeCalendar = calendars.find((calendar) => calendar.id === previous?.writeCalendar && calendar.writable)?.id ??
    calendars.find((calendar) => calendar.writable)!.id;
  const selected = sameAccount ? previous.busyCalendars.filter((id) => known.has(id)).slice(0, 15) : calendars.slice(0, 15).map((calendar) => calendar.id);
  const connection: Connection = { email, calendars, busyCalendars: [...new Set([writeCalendar, ...selected])], writeCalendar };
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as typeof sql;
    const [current] = await tx<Settings[]>`select * from demi.settings where id for update`;
    if (current.connection && current.connection.email !== email) {
      const [upcoming] = await tx`select id from demi.events where state <> 'canceled' and ends_at > now() limit 1`;
      if (upcoming) throw new RequestError(409, "Reconnect the same Apple Account while there are upcoming hangouts or blocks.");
    }
    const value = JSON.stringify(access);
    const [secret] = await tx`select id from vault.decrypted_secrets where name = 'demi_apple_connection'`;
    if (secret) await tx`select vault.update_secret(${secret.id}::uuid, ${value})`;
    else await tx`select vault.create_secret(${value}, 'demi_apple_connection')`;
    await tx`update demi.settings set connection = ${tx.json(connection)}, closed_slots = '[]' where id`;
  });
  return hostView();
}

async function setCalendars(input: Record<string, unknown>, settings: Settings) {
  const connection = settings.connection;
  if (!connection) throw new RequestError(409, "Connect Apple Calendar first.");
  const { writeCalendar, busyCalendars } = input;
  if (typeof writeCalendar !== "string" || !connection.calendars.some((c) => c.id === writeCalendar && c.writable) ||
    !Array.isArray(busyCalendars) || busyCalendars.length > 16 ||
    busyCalendars.some((value) => !connection.calendars.some((c) => c.id === value))) {
    throw new RequestError(400, "Choose a writable calendar and up to 16 calendars to check.");
  }
  const next = { ...connection, writeCalendar, busyCalendars: [...new Set<string>([writeCalendar, ...busyCalendars])] };
  const [saved] = await sql`update demi.settings set connection = ${sql.json(next)}, closed_slots = '[]'
    where id and connection = ${sql.json(connection)} returning id`;
  if (!saved) throw new RequestError(409, "Calendar settings changed. Reopen the host view and try again.");
  return hostView();
}

async function completeEvent(row: EventRow) {
  const [leased] = await sql<EventRow[]>`update demi.events set sync_lease_until = date_trunc('milliseconds', now()) + interval '90 seconds'
    where id = ${row.id} and state in ('pending', 'canceling') and (sync_lease_until is null or sync_lease_until < now())
    returning *`;
  if (!leased) {
    const [current] = await sql<EventRow[]>`select * from demi.events where id = ${row.id}`;
    if (current?.state === "confirmed" && row.state === "pending" || current?.state === "canceled" && row.state === "canceling") return;
    throw new RequestError(503, "This change is still syncing. Try again shortly.");
  }
  const api = appleClient(await credentials());
  const interval = eventInterval(leased);
  try {
    if (leased.state === "canceling") {
      await api.remove(leased.calendar_url, leased.id);
      await sql`update demi.events set state = 'canceled', name = '', email = '', note = '', sync_lease_until = null
        where id = ${leased.id} and sync_lease_until = ${leased.sync_lease_until}`;
    } else {
      const event: AppleEvent = { ...interval, id: leased.id, kind: leased.kind, name: leased.name, email: leased.email, note: leased.note };
      await api.create(leased.calendar_url, event);
      await sql.begin(async (transaction) => {
        const tx = transaction as unknown as typeof sql;
        const [config] = await tx<Settings[]>`select * from demi.settings where id for update`;
        const [updated] = await tx`update demi.events set state = 'confirmed', sync_lease_until = null
          where id = ${leased.id} and sync_lease_until = ${leased.sync_lease_until} returning id`;
        if (!updated) return;
        const candidates = candidateSlots(Date.now(), NOTICE_DAYS, config.weekly, config.length_minutes);
        const closed = candidates.filter((slot) => overlaps(slot, interval)).map((slot) => slot.start);
        if (closed.length) {
          const busySlots = [...new Set([...config.closed_slots, ...closed])];
          await tx`update demi.settings set closed_slots = ${tx.json(busySlots)} where id`;
        }
        if (leased.kind === "booking") {
          await tx`insert into demi.activity (title, body, push_body) values (
            'New hangout booked', ${leased.name + " booked " + label(interval.start) + "."},
            ${"A hangout was booked for " + label(interval.start) + "."})`;
        }
      });
    }
  } finally {
    await sql`update demi.events set sync_lease_until = null where id = ${leased.id}
      and state = ${leased.state} and sync_lease_until = ${leased.sync_lease_until}`;
  }
}

async function reserve(input: Record<string, unknown>, settings: Settings, kind: "booking" | "block"): Promise<{ id: string; start: number; end: number }> {
  const { requestId: id, start, end } = input;
  if (!isId(id) || typeof start !== "number" || typeof end !== "number" ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new RequestError(400, "Choose an available date and time.");
  }
  const name = kind === "booking" ? readString(input.name, 80) : "";
  const email = kind === "booking" ? readString(input.email, 254).toLowerCase() : "";
  const note = kind === "booking" ? readString(input.note ?? "", 280, true) : "";
  if (kind === "booking" && (!name || !isEmail(email))) throw new RequestError(400, "Enter your name and a valid email address.");
  const connection = settings.connection;
  if (!connection) throw new RequestError(409, "Apple Calendar hasn’t been connected yet.");
  const interval = { start, end };
  const result = { id, start, end };
  const [existing] = await sql<EventRow[]>`select * from demi.events where id = ${id}`;
  if (existing) {
    const previous = eventInterval(existing);
    if (existing.kind !== kind || existing.name !== name || existing.email !== email || existing.note !== note ||
      previous.start !== start || previous.end !== end || !["pending", "confirmed"].includes(existing.state)) {
      throw new RequestError(409, "This booking request is no longer valid. Choose a time again.");
    }
    if (existing.state === "pending") await completeEvent(existing);
    return result;
  }
  const now = Date.now();
  if (kind === "booking") {
    const duration = (end - start) / MINUTE;
    if (!isBookingDuration(duration)) {
      throw new RequestError(400, "Choose a length from 15 to 120 minutes in 15-minute steps.");
    }
    const slots = candidateSlots(now, BOOKING_DAYS, settings.weekly, duration, DURATION_STEP);
    if (!slots.some((slot) => slot.start === start && slot.end === end)) throw new RequestError(409, "That time is no longer available.");
    const busy = await busyTimes(connection, interval, await credentials());
    if (busy.some((event) => overlaps(event, interval))) throw new RequestError(409, "That time just became unavailable. Please choose another.");
  } else if (end <= now || start < midnight(now) || end > midnight(now) + BOOKING_DAYS * DAY ||
    start % MINUTE !== 0 || end % MINUTE !== 0) {
    throw new RequestError(400, "Choose a time block within the next 45 days.");
  }

  let row: EventRow;
  try {
    row = await sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const [config] = await tx<Settings[]>`select * from demi.settings where id for update`;
      if (JSON.stringify(config.connection) !== JSON.stringify(connection) ||
        kind === "booking" && JSON.stringify(config.weekly) !== JSON.stringify(settings.weekly)) {
        throw new RequestError(409, "Availability changed. Please select a time again.");
      }
      const [saved] = await tx<EventRow[]>`insert into demi.events (id, kind, starts_at, ends_at, calendar_url, name, email, note)
        values (${id}, ${kind}, ${iso(start)}, ${iso(end)}, ${connection.writeCalendar}, ${name}, ${email}, ${note}) returning *`;
      return saved;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return await reserve(input, settings, kind);
    if (code === "23P01") throw new RequestError(409, kind === "block"
      ? "This overlaps an existing hangout or time block."
      : "Someone just took that time. Please choose another.");
    throw error;
  }
  await completeEvent(row);
  return result;
}

async function cancel(input: Record<string, unknown>) {
  if (!isId(input.id)) throw new RequestError(400, "This item couldn’t be found.");
  const [updated] = await sql<EventRow[]>`update demi.events set state = 'canceling'
    where id = ${input.id} and state = 'confirmed' returning *`;
  const [row] = updated ? [updated] : await sql<EventRow[]>`select * from demi.events where id = ${input.id}`;
  if (!row) throw new RequestError(404, "This item couldn’t be found.");
  if (row.state === "pending") throw new RequestError(409, "Wait for this item to sync before canceling.");
  if (row.state !== "canceled") await completeEvent(row);
  return hostView();
}

function subscriptionEndpoint(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw new RequestError(400, "This device didn’t provide a valid push subscription.");
  let url: URL;
  try { url = new URL(value); } catch { throw new RequestError(400, "This push provider isn’t supported."); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
    !(host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
      host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com"))) {
    throw new RequestError(400, "This push provider isn’t supported.");
  }
  return url.href;
}

async function updatePush(input: Record<string, unknown>) {
  if (input.remove === true) {
    const endpoint = subscriptionEndpoint(input.endpoint);
    await sql`delete from demi.subscriptions where endpoint = ${endpoint}`;
  } else {
    const push = input.subscription as PushSubscription;
    const endpoint = subscriptionEndpoint(push?.endpoint);
    const p256dh = push.keys?.p256dh;
    const auth = push.keys?.auth;
    if (typeof p256dh !== "string" || !/^[\w-]{87}$/.test(p256dh) || typeof auth !== "string" || !/^[\w-]{22}$/.test(auth)) {
      throw new RequestError(400, "This device didn’t provide valid push keys.");
    }
    const subscription = { endpoint, expirationTime: null, keys: { p256dh, auth } };
    await sql`insert into demi.subscriptions (endpoint, subscription) values (${endpoint}, ${sql.json(subscription)})
      on conflict (endpoint) do update set subscription = excluded.subscription`;
  }
  return hostView();
}

async function sendAlerts(settings: Settings) {
  const [events, subscriptions, privateKey] = await Promise.all([
    sql<ActivityRow[]>`select * from demi.activity where not pushed and created_at >= now() - interval '24 hours' order by created_at limit 25`,
    sql<{ endpoint: string; subscription: PushSubscription }[]>`select * from demi.subscriptions`,
    getSecret("demi_vapid_key"),
  ]);
  if (!privateKey || !settings.vapid_public_key) return;
  const vapid = { subject: SITE + "/demis-calendar/", privateKey, publicKey: settings.vapid_public_key };
  for (const alert of events) {
    const results = await Promise.allSettled(subscriptions.map(async ({ endpoint, subscription }) => {
      const payload = await buildPushPayload({
        data: JSON.stringify({ id: alert.id, title: alert.title, body: alert.push_body }), options: { ttl: 3600 },
      }, subscription, vapid);
      const response = await fetch(endpoint, { ...payload, redirect: "error", signal: AbortSignal.timeout(3500) });
      if (response.status === 404 || response.status === 410) {
        await sql`delete from demi.subscriptions where endpoint = ${endpoint}`;
      } else if (!response.ok) {
        throw new Error("Push delivery failed with status " + response.status);
      }
    }));
    if (results.every((result) => result.status === "fulfilled")) {
      await sql`update demi.activity set pushed = true where id = ${alert.id}`;
    }
  }
}

async function runChecks() {
  const [settings] = await sql<(Settings & { check_lease_until: Date })[]>`
    update demi.settings set check_lease_until = date_trunc('milliseconds', now()) + interval '2 minutes'
    where id and (check_lease_until is null or check_lease_until < now()) returning *
  `;
  if (!settings) return { busy: true };
  try {
    if (!settings.connection) return { connected: false };
    const pending = await sql<EventRow[]>`select * from demi.events where
      state in ('pending', 'canceling') and ends_at > now()
      and created_at < now() - interval '30 seconds'
      and (sync_lease_until is null or sync_lease_until < now()) limit 4`;
    const retries = await Promise.allSettled(pending.map(completeEvent));
    for (const result of retries) {
      if (result.status === "rejected") console.warn("Calendar sync retry deferred.");
    }
    const slots = candidateSlots(Date.now(), NOTICE_DAYS, settings.weekly, settings.length_minutes);
    try {
      if (slots.length) {
        const busy = await busyTimes(settings.connection, { start: slots[0].start, end: slots[slots.length - 1].end }, await credentials());
        const { open, closed } = splitSlots(slots, busy);
        const previouslyClosed = new Set(settings.closed_slots);
        const openings = open.filter((start) => previouslyClosed.has(start));
        await sql.begin(async (transaction) => {
        const tx = transaction as unknown as typeof sql;
          const [saved] = await tx`update demi.settings set closed_slots = ${tx.json(closed)}
            where id and connection = ${tx.json(settings.connection!)} and weekly = ${tx.json(settings.weekly)}
            and length_minutes = ${settings.length_minutes} and closed_slots = ${tx.json(settings.closed_slots)} returning id`;
          if (!saved || !openings.length) return;
          const title = openings.length === 1 ? "A time opened up" : openings.length + " times opened up";
          const detail = openings.slice(0, 5).map(label).join("\n") +
            (openings.length > 5 ? "\nPlus " + (openings.length - 5) + " more." : "");
          await tx`insert into demi.activity (title, body, push_body) values
            (${title}, ${detail}, ${"First opening: " + label(openings[0]) + "."})`;
        });
      }
    } catch {
      console.warn("iCloud availability check deferred.");
    }
    await sendAlerts(settings);
    await sql`delete from demi.activity where created_at < now() - interval '90 days'`;
    await sql`delete from demi.events where ends_at < now() - interval '90 days'`;
    return { checked: true };
  } finally {
    await sql`update demi.settings set check_lease_until = null where id and check_lease_until = ${settings.check_lease_until}`;
  }
}

const publicActions = new Map([["availability", "GET"], ["book", "POST"]]);
const hostActions = new Map([
  ["host", "GET"], ["connect", "POST"], ["calendars", "POST"], ["hours", "POST"],
  ["block", "POST"], ["cancel", "POST"], ["push", "POST"],
]);
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const allowedOrigin = origin === SITE || Boolean(origin && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(origin));
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Demi-Key",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && allowedOrigin) headers.set("Access-Control-Allow-Origin", origin);
  if (origin && !allowedOrigin) return Response.json({ error: "This origin isn’t allowed." }, { status: 403, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const action = new URL(req.url).searchParams.get("action") || "availability";
  const method = publicActions.get(action) || hostActions.get(action) || (action === "cron" ? "POST" : "");
  if (!method || req.method !== method) return Response.json({ error: "This action isn’t available." }, { status: 405, headers });
  try {
    if (action === "cron") {
      const key = await getSecret("demi_cron_key");
      if (!key || !safeEqual(req.headers.get("X-Demi-Cron") || "", key)) throw new RequestError(401, "Unauthorized.");
      return Response.json(await runChecks(), { headers });
    }
    const settings = await getSettings();
    if (hostActions.has(action)) await authorize(req, settings);
    const input = method === "POST" ? await body(req) : {};
    let result;
    switch (action) {
      case "availability": result = await availability(settings); break;
      case "book": result = await reserve(input, settings, "booking"); break;
      case "host": result = await hostView(settings); break;
      case "connect": result = await connect(input, settings); break;
      case "calendars": result = await setCalendars(input, settings); break;
      case "hours": {
        const { weekly, duration } = input;
        validateHours(weekly, duration);
        const normalized = weekly.map((day) => day ? { start: day.start, end: day.end } : null);
        await sql`update demi.settings set weekly = ${sql.json(normalized)}, length_minutes = ${duration as number},
          closed_slots = '[]' where id`;
        result = await hostView();
        break;
      }
      case "block": await reserve(input, settings, "block"); result = await hostView(); break;
      case "cancel": result = await cancel(input); break;
      case "push": result = await updatePush(input); break;
    }
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers });
    console.error("Calendar request failed", action, error instanceof Error ? error.name : "UnknownError",
      (error as { code?: string })?.code || "");
    return Response.json({ error: "The calendar service is temporarily unavailable." }, { status: 503, headers });
  }
});
