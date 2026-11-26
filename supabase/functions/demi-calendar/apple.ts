import ICAL from "ical.js";
import { XMLParser } from "fast-xml-parser";
import { iso, overlaps, RequestError, type Interval } from "./schedule.ts";

export type Credentials = { email: string; password: string };
export type AppleCalendar = { id: string; name: string; writable: boolean };
export type AppleEvent = Interval & { id: string; kind: "booking" | "block"; name: string; email: string; note: string };

const root = "https://caldav.icloud.com/";
const XML = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: false, processEntities: false });
const APPLE_HOST = /^(?:p\d{1,5}-)?caldav\.icloud\.com$/i;
const XML_TYPE = "application/xml; charset=utf-8";

// DAV fields contain mixed values, including empty elements and arrays for repeated tags.
type DavNode = Record<string, any>;
type Reply = { url: URL; root: DavNode };

function appleUrl(href: string, base: URL | string = root) {
  const url = new URL(href, base);
  if (url.protocol !== "https:" || !APPLE_HOST.test(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw new RequestError(502, "iCloud returned an unexpected calendar address.");
  }
  return url;
}

function list<T>(value: T | T[] | undefined | null): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function decodeXml(value: unknown) {
  return String(value ?? "").replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (original, key: string) => {
    if (key[0] === "#") {
      const number = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : original;
    }
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[key as "lt"] || original;
  });
}

export class CalDavError extends RequestError {
  constructor(public appleStatus: number) {
    super(appleStatus === 401 || appleStatus === 403 ? 422 : 503, appleStatus === 401 || appleStatus === 403
      ? "iCloud refused calendar access. Check your app-specific password and calendar permissions."
      : "iCloud couldn’t finish the request. Please try again shortly.");
  }
}

export function appleClient(credentials: Credentials, fetcher: typeof fetch = fetch) {
  const authorization = "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode(credentials.email + ":" + credentials.password)));

  async function call(url: URL, method: string, headers: HeadersInit = {}, body?: string): Promise<{ response: Response; url: URL }> {
    let next = appleUrl(url.href);
    for (let redirect = 0; redirect < 5; redirect++) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Authorization", authorization);
      let response: Response;
      try {
        response = await fetcher(next, {
          method, headers: requestHeaders, body, redirect: "manual", signal: AbortSignal.timeout(9000),
        });
      } catch {
        throw new CalDavError(0);
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        next = appleUrl(response.headers.get("location")!, next);
      } else {
        return { response, url: next };
      }
    }
    throw new RequestError(502, "iCloud returned too many redirects.");
  }

  async function xml(url: URL, method: string, depth: string, query: string): Promise<Reply> {
    const result = await call(url, method, { Depth: depth, "Content-Type": XML_TYPE }, query);
    if (!result.response.ok) throw new CalDavError(result.response.status);
    const source = await result.response.text();
    if (source.length > 5_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new CalDavError(502);
    const report = XML.parse(source);
    if (!report || !Object.hasOwn(report, "multistatus")) throw new CalDavError(502);
    return { url: result.url, root: report.multistatus || {} };
  }

  async function propfind(url: URL, ...properties: string[]) {
    return xml(url, "PROPFIND", "0", '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' +
      properties.map((property) => "<" + property + "/>").join("") + "</d:prop></d:propfind>");
  }

  async function discover() {
    let principalReply: Reply;
    try {
      principalReply = await propfind(appleUrl("/"), "d:current-user-principal");
    } catch (error) {
      if (!(error instanceof CalDavError) || ![400, 404, 405].includes(error.appleStatus)) throw error;
      principalReply = await propfind(appleUrl("/.well-known/caldav"), "d:current-user-principal");
    }
    const principalHref = properties(principalReply.root)[0]?.prop["current-user-principal"]?.href;
    if (!principalHref) throw new RequestError(422, "iCloud Calendar isn’t available for this Apple Account.");
    const homeReply = await propfind(appleUrl(decodeXml(principalHref), principalReply.url), "c:calendar-home-set");
    const homeHref = properties(homeReply.root)[0]?.prop["calendar-home-set"]?.href;
    if (!homeHref) throw new RequestError(422, "Turn on iCloud Calendar for this Apple Account, then try again.");

    const reply = await xml(appleUrl(decodeXml(homeHref), homeReply.url), "PROPFIND", "1",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' +
      "<d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/>" +
      "</d:prop></d:propfind>");
    const found = new Map<string, AppleCalendar>();
    for (const { href, prop } of properties(reply.root)) {
      if (!href || !prop.resourcetype || !Object.hasOwn(prop.resourcetype, "calendar")) continue;
      const privileges = prop["current-user-privilege-set"];
      const values = list<DavNode>(privileges?.privilege);
      if (values.length && !values.some((value) => "read" in value || "all" in value)) continue;
      const writable = privileges === undefined || values.some((value) => "write" in value || "all" in value || ("bind" in value));
      const url = appleUrl(decodeXml(href), reply.url);
      url.pathname = url.pathname.replace(/\/?$/, "/");
      const id = url.href;
      found.set(id, { id, name: decodeXml(prop.displayname).trim() || "Calendar", writable });
    }
    const calendars = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!calendars.some((calendar) => calendar.writable)) {
      throw new RequestError(422, "Create an editable iCloud calendar in Apple Calendar, then reconnect.");
    }
    return calendars;
  }

  async function busy(collection: string, start: number, end: number) {
    const from = stamp(start), to = stamp(end);
    const report = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><c:calendar-data><c:expand start="' + from + '" end="' + to + '"/></c:calendar-data></d:prop>' +
      '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
      '<c:time-range start="' + from + '" end="' + to + '"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    const { root } = await xml(appleUrl(collection), "REPORT", "1", report);
    const events: Interval[] = [];
    for (const { prop } of properties(root, true)) {
      const calendar = prop["calendar-data"];
      if (typeof calendar !== "string") throw new CalDavError(502);
      events.push(...readBusy(decodeXml(calendar), { start, end }, credentials.email));
    }
    return events;
  }

  async function create(collection: string, event: AppleEvent) {
    const url = appleUrl(event.id + ".ics", appleUrl(collection));
    const { response } = await call(url, "PUT", {
      "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*",
    }, serializeEvent(event));
    if (response.ok) return;
    if (response.status === 412) {
      const existing = await call(url, "GET");
      if (existing.response.ok && (await existing.response.text()).split(/\r?\n/).includes("UID:" + event.id + "@demis-calendar")) return;
    }
    throw new CalDavError(response.status);
  }

  async function remove(collection: string, id: string) {
    const { response } = await call(appleUrl(id + ".ics", appleUrl(collection)), "DELETE");
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new CalDavError(response.status);
  }

  return { discover, busy, create, remove };
}

function properties(root: DavNode, strict = false) {
  return list<DavNode>(root.response).flatMap((entry) => {
    const successful = list<DavNode>(entry.propstat).filter((item) => /^HTTP\/\S+\s+200(?:\s|$)/.test(item.status));
    if (strict && (entry.status && !/^HTTP\/\S+\s+200(?:\s|$)/.test(entry.status) || !successful.length)) {
      throw new CalDavError(502);
    }
    if (!successful.length) return [];
    return [{ href: entry.href as string, prop: Object.assign({}, ...successful.map((item) => item.prop)) }];
  });
}

function epoch(time: ICAL.Time) {
  if (time.isDate || time.zone === ICAL.Timezone.localTimezone) {
    const zoneTime = new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour - 8, time.minute, time.second));
    return zoneTime.valueOf();
  }
  return time.toJSDate().getTime();
}

function isBusy(component: ICAL.Component, email: string) {
  if (String(component.getFirstPropertyValue("status")).toUpperCase() === "CANCELLED") return false;
  if (String(component.getFirstPropertyValue("transp")).toUpperCase() === "TRANSPARENT") return false;
  return !component.getAllProperties("attendee").some((attendee) =>
    String(attendee.getFirstValue()).replace(/^mailto:/i, "").toLowerCase() === email &&
    String(attendee.getParameter("partstat")).toUpperCase() === "DECLINED"
  );
}

export function readBusy(source: string, range: Interval, email: string): Interval[] {
  const parsed = new ICAL.Component(ICAL.parse(source));
  for (const value of parsed.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone({ component: value });
    if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
  }
  const components = parsed.getAllSubcomponents("vevent");
  const result: Interval[] = [];
  function add(startDate: ICAL.Time, endDate: ICAL.Time, item: ICAL.Event, original?: ICAL.Event) {
    if (!isBusy(item.component, email)) return;
    if (original && !item.component.hasProperty("transp") && !isBusy(original.component, email)) return;
    const event = { start: epoch(startDate), end: epoch(endDate) };
    if (event.end > event.start && overlaps(event, range)) result.push(event);
  }

  const masters = new Map<string, ICAL.Event>();
  for (const component of components) {
    const event = new ICAL.Event(component, { exceptions: [] });
    if (!event.isRecurrenceException()) masters.set(event.uid, event);
  }
  const detached: ICAL.Event[] = [];
  for (const component of components) {
    if (!component.hasProperty("recurrence-id")) continue;
    const event = new ICAL.Event(component, { exceptions: [] });
    const master = masters.get(event.uid);
    if (master?.isRecurring()) master.relateException(event);
    else detached.push(event);
  }
  for (const event of [...masters.values(), ...detached]) {
    if (!isBusy(event.component, email) && !event.isRecurring()) continue;
    if (!event.isRecurring()) {
      if (event.startDate && event.endDate) add(event.startDate, event.endDate, event);
      continue;
    }
    const iterator = event.iterator();
    for (let iteration = 0; ; iteration++) {
      if (iteration > 40_000) throw new RequestError(503, "An iCloud event has too many repeat instances to check safely.");
      const instance = iterator.next();
      if (!instance || epoch(instance) >= range.end) break;
      const detail = event.getOccurrenceDetails(instance);
      add(detail.startDate, detail.endDate, detail.item, event);
    }
  }
  return result;
}

function stamp(time: number) {
  return iso(time).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function calendarText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, "\\$&");
}

function fold(line: string) {
  const encode = new TextEncoder();
  let bytes = 0;
  let output = "";
  for (const character of line) {
    const size = encode.encode(character).length;
    if (bytes + size > 75) {
      output += "\r\n ";
      bytes = 1;
    }
    output += character;
    bytes += size;
  }
  return output;
}

export function serializeEvent(event: AppleEvent) {
  const booking = event.kind === "booking";
  const description = booking ? calendarText("Booked through Demi’s Calendar\nGuest: " + event.name +
    "\nEmail: " + event.email + (event.note ? "\nNote: " + event.note : "")) : "";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demi Calendar//CalDAV//EN", "BEGIN:VEVENT",
    "UID:" + event.id + "@demis-calendar", "DTSTAMP:" + stamp(Date.now()),
    "DTSTART:" + stamp(event.start), "DTEND:" + stamp(event.end),
    "SUMMARY:" + (booking ? calendarText("Hangout with " + event.name) : "Busy"),
    "DESCRIPTION:" + description, "CLASS:PRIVATE", "TRANSP:OPAQUE",
    ...(booking ? ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "DESCRIPTION:Hangout coming up", "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].map(fold).join("\r\n");
}
