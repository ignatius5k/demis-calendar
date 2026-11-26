import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { appleClient, readBusy, serializeEvent } from "./apple.ts";
import { candidateSlots, DURATION_STEP, durationOptions, durationWindows, isBookingDuration, MINUTE, splitSlots, validateHours } from "./schedule.ts";

const stamp = (date: string) => new Date(date).getTime();
const line = (...parts: string[]) => parts.join("\r\n");
const vcal = (...events: string[]) => line("BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR", "");
const vevent = (...fields: string[]) => line("BEGIN:VEVENT", ...fields, "END:VEVENT");

Deno.test("slot generation respects Singapore dates, booking lead time, and touching busy edges", () => {
  const now = stamp("2026-11-25T23:50:00Z"); // Thursday 07:50 in Singapore
  const days = [null, null, null, { start: "08:00", end: "11:00" }, null, null, null];
  validateHours(days, 60);
  const slots = candidateSlots(now, 1, days, 60);
  const nine = stamp("2026-11-26T09:00:00+08:00");
  const ten = nine + 60 * MINUTE;
  deepStrictEqual(slots.map((s) => s.start), [nine, ten]);
  deepStrictEqual(splitSlots(slots, [{ start: nine - 30 * MINUTE, end: nine }, { start: ten, end: ten + MINUTE }]), {
    open: [nine],
    closed: [ten],
  });
});

Deno.test("recurring, all-day, and free iCloud events determine busy times", () => {
  const source = vcal(
    vevent("UID:weekly", "DTSTART:20261123T090000Z", "DTEND:20261123T100000Z", "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20261124T090000Z"),
    vevent("UID:weekly", "RECURRENCE-ID:20261125T090000Z", "DTSTART:20261125T110000Z", "DTEND:20261125T120000Z"),
    vevent("UID:holiday", "DTSTART;VALUE=DATE:20261124", "DTEND;VALUE=DATE:20261125"),
    vevent("UID:free", "DTSTART:20261124T000000Z", "DTEND:20261125T000000Z", "TRANSP:TRANSPARENT"),
    vevent("UID:declined", "DTSTART:20261124T000000Z", "DTEND:20261125T000000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:host@example.com"),
  );
  const range = { start: stamp("2026-11-23T00:00:00Z"), end: stamp("2026-11-27T00:00:00Z") };
  const busy = readBusy(source, range, "host@example.com").sort((a, b) => a.start - b.start);
  deepStrictEqual(busy.map((span) => new Date(span.start).toISOString()), [
    "2026-11-23T09:00:00.000Z", "2026-11-23T16:00:00.000Z", "2026-11-25T11:00:00.000Z", "2026-11-26T09:00:00.000Z",
  ]);
});

Deno.test("duration choices stop at busy events and the end of the host's window", () => {
  const minutesFrom = (time: string) => stamp("2026-11-26T" + time + ":00+08:00");
  const now = minutesFrom("16:00");
  const weekly = [null, null, null, { start: "17:10", end: "20:25" }, null, null, null];
  const busy = [
    { start: minutesFrom("18:18"), end: minutesFrom("18:40") },
    { start: minutesFrom("18:30"), end: minutesFrom("19:10") },
  ];
  const options = durationOptions(durationWindows(now, 1, weekly), busy);
  const byStart = new Map(options.map(({ start, maxMinutes }) => [start, maxMinutes]));
  equal(byStart.get(minutesFrom("17:10")), 60);
  equal(byStart.get(minutesFrom("17:25")), 45);
  equal(byStart.get(minutesFrom("18:10")), undefined);
  equal(byStart.get(minutesFrom("18:55")), undefined);
  equal(byStart.get(minutesFrom("19:10")), 75);
  equal(byStart.get(minutesFrom("20:10")), 15);

  for (const duration of [15, 30, 45, 60, 75, 90, 105, 120]) {
    equal(isBookingDuration(duration), true);
    const slots = candidateSlots(now, 1, weekly, duration, DURATION_STEP);
    deepStrictEqual(splitSlots(slots, busy).open, options.filter((option) => option.maxMinutes >= duration).map((option) => option.start));
  }
  for (const duration of [0, 19, 121, 135]) equal(isBookingDuration(duration), false);
  equal(durationOptions(durationWindows(now, 1, weekly), [])[0].maxMinutes, 120);
});

Deno.test("CalDAV discovery follows iCloud redirects and private holds round-trip as busy", async () => {
  const host = "https://p55-caldav.icloud.com";
  const range = { start: stamp("2026-11-26T09:00:00Z"), end: stamp("2026-11-26T10:00:00Z") };
  let stored = "";
  const multistatus = (href: string, data: string) => new Response(
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>' +
      "<d:href>" + href + "</d:href><d:propstat><d:prop>" + data +
      "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>",
    { status: 207 },
  );
  const mock = ((address: URL, request: RequestInit) => {
    const path = address.pathname;
    if (address.hostname === "caldav.icloud.com") return Promise.resolve(new Response(null, { status: 301, headers: { location: host } }));
    equal(address.origin, host);
    if (request.method === "PUT") {
      if (stored) return Promise.resolve(new Response(null, { status: 412 }));
      stored = String(request.body);
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    if (request.method === "GET") return Promise.resolve(new Response(stored));
    if (request.method === "REPORT") return Promise.resolve(multistatus("/events/item.ics", "<c:calendar-data><![CDATA[" + stored + "]]></c:calendar-data>"));
    if (path === "/") return Promise.resolve(multistatus("/", "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>"));
    if (path === "/principal/") return Promise.resolve(multistatus(path, "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>"));
    return Promise.resolve(multistatus("/events/", "<d:resourcetype><c:calendar/></d:resourcetype><d:displayname>Work &amp; Home</d:displayname>"));
  }) as typeof fetch;
  const api = appleClient({ email: "host@example.com", password: "fixture" }, mock);
  const [calendar] = await api.discover();
  deepStrictEqual(calendar, { id: host + "/events/", name: "Work & Home", writable: true });
  const event = { ...range, id: "69304398-9a5d-48ad-9521-04b565f687cb", kind: "booking" as const, name: "Friend", email: "friend@example.com", note: "Tea\nthen a walk" };
  await api.create(calendar.id, event);
  await api.create(calendar.id, event);
  equal(stored.includes("CLASS:PRIVATE"), true);
  deepStrictEqual(await api.busy(calendar.id, range.start, range.end), [range]);
  equal(serializeEvent(event).includes("Tea\\nthen a walk"), true);
  await rejects(api.busy("https://example.com/calendar", range.start, range.end));
});
