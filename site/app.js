import { API_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const MINUTE = 60_000;
const BOOKING_DAYS = 45;
const ZONE = "Asia/Singapore";
const SHIFT = 8 * 60 * MINUTE;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const durationInput = $("guest-duration");
const DURATION_STEP = Number(durationInput.step);
const MAX_DURATION = Number(durationInput.max);
const dateFormat = new Intl.DateTimeFormat("en-SG", { timeZone: ZONE, weekday: "long", month: "long", day: "numeric" });
const monthFormat = new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-SG", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true });
const takenPreview = [];
const state = {
  mode: "loading",
  slotsByDay: new Map(),
  selectedDate: "",
  selectedStart: null,
  month: null,
  duration: 60,
  chosenDuration: null,
  options: [],
  lastFetch: 0,
  hostKey: sessionStorage.getItem("demi-host-key") || "",
  host: null,
  tab: "calendar",
};

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function icon(name) {
  const space = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(space, "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(space, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

const dateKey = (epoch) => new Date(epoch + SHIFT).toISOString().slice(0, 10);
const dayEpoch = (key, time = "00:00") => Date.parse(key + "T" + time + ":00+08:00");
const toMonth = (key) => key.slice(0, 7) + "-01";
const formatTime = (time) => timeFormat.format(time).toUpperCase();
const formatDate = (time) => dateFormat.format(time);
const timeRange = (start, end) => formatTime(start) + " – " + formatTime(end);
const describeSlot = (start, end) => formatDate(start) + " · " + timeRange(start, end) + " SGT";

function shiftMonth(month, by) {
  const date = new Date(month + "T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 10);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(action, { key, data } = {}) {
  if (!API_URL) throw new ApiError("The live calendar service hasn’t been configured.", 503);
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  const headers = { Accept: "application/json" };
  if (key) headers["X-Demi-Key"] = key;
  if (data) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method: data ? "POST" : "GET",
      headers,
      body: data ? JSON.stringify(data) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    throw new ApiError("The calendar couldn’t be reached. Try again in a moment.", 503);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error || "Something went wrong. Please try again.", response.status);
  return result;
}

function sampleOptions(now) {
  const windows = [null, [17, 20], null, [17, 20], [16, 19], [11, 15], [12, 15]];
  const today = dayEpoch(dateKey(now));
  const options = [];
  const step = DURATION_STEP * MINUTE;
  for (let offset = 0; offset < BOOKING_DAYS; offset++) {
    const day = today + offset * DAY;
    const index = (new Date(day + SHIFT).getUTCDay() + 6) % 7;
    const window = windows[index];
    if (!window) continue;
    const end = day + window[1] * 60 * MINUTE;
    for (let start = day + window[0] * 60 * MINUTE; start + step <= end; start += step) {
      if (start < now + 15 * MINUTE) continue;
      let until = Math.min(end, start + MAX_DURATION * MINUTE);
      for (const booking of takenPreview) {
        if (booking.end > start) until = Math.min(until, booking.start);
      }
      const maxMinutes = Math.floor((until - start) / step) * DURATION_STEP;
      if (maxMinutes >= DURATION_STEP) options.push({ start, maxMinutes });
    }
  }
  return options;
}

function useAvailability(options, duration, mode) {
  state.mode = mode;
  state.options = options;
  state.duration = state.chosenDuration ?? duration;
  filterSlots(false);
}

function filterSlots(keepDate) {
  state.slotsByDay = new Map();
  for (const { start, maxMinutes } of state.options) {
    if (maxMinutes < state.duration) continue;
    const key = dateKey(start);
    const slots = state.slotsByDay.get(key) || [];
    slots.push(start);
    state.slotsByDay.set(key, slots);
  }
  if ((!keepDate || !state.selectedDate) && !state.slotsByDay.has(state.selectedDate)) selectFirstDate();
  if (!(state.slotsByDay.get(state.selectedDate) || []).includes(state.selectedStart)) state.selectedStart = null;
  renderGuest();
}

function selectFirstDate() {
  state.selectedDate = [...state.slotsByDay.keys()].find((key) => toMonth(key) === state.month) || "";
  state.selectedStart = null;
}

let refreshPromise;
function refreshAvailability() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const payload = API_URL ? await api("availability") : { connected: false };
      state.lastFetch = Date.now();
      if (payload.connected) useAvailability(payload.options, payload.duration, "live");
      else useAvailability(sampleOptions(Date.now()), payload.duration ?? 60, "preview");
    } catch {
      useAvailability([], state.duration, "error");
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function renderGuest() {
  const now = Date.now();
  const today = dateKey(now);
  const lastDate = dateKey(dayEpoch(today) + (BOOKING_DAYS - 1) * DAY);
  state.month ||= toMonth(today);
  const month = state.month;
  $("month-label").textContent = monthFormat.format(new Date(month + "T00:00:00Z"));
  $("month-prev").disabled = month <= toMonth(today);
  $("month-next").disabled = month >= toMonth(lastDate);

  const selectedButton = document.activeElement?.dataset.day;
  const startOfMonth = new Date(month + "T00:00:00Z");
  const leading = (startOfMonth.getUTCDay() + 6) % 7;
  const monthDays = new Date(shiftMonth(month, 1) + "T00:00:00Z").getTime() - startOfMonth.getTime();
  const cells = [];
  const weeks = Math.ceil((leading + monthDays / DAY) / 7);
  for (let index = 0; index < weeks * 7; index++) {
    const day = index - leading + 1;
    if (day < 1 || day > monthDays / DAY) {
      const blank = node("span");
      blank.setAttribute("aria-hidden", "true");
      cells.push(blank);
      continue;
    }
    const key = month.slice(0, 8) + String(day).padStart(2, "0");
    const slots = state.slotsByDay.get(key);
    const button = node("button", "day", day);
    button.type = "button";
    button.dataset.day = key;
    button.disabled = !slots;
    button.classList.toggle("today", key === today);
    button.classList.toggle("open", Boolean(slots));
    button.setAttribute("aria-pressed", String(key === state.selectedDate));
    button.setAttribute("aria-label", formatDate(dayEpoch(key)) + (slots ? ", " + slots.length + " available" : ", unavailable"));
    if (key === today) button.setAttribute("aria-current", "date");
    cells.push(button);
  }
  $("days").replaceChildren(...cells);
  if (selectedButton) cells.find((cell) => cell.dataset.day === selectedButton)?.focus({ preventScroll: true });

  const focusedTime = document.activeElement?.dataset.start;
  const times = state.slotsByDay.get(state.selectedDate) || [];
  $("chosen-date").textContent = state.selectedDate ? formatDate(dayEpoch(state.selectedDate)) : "Choose a time";
  $("duration-control").hidden = state.mode === "loading" || state.mode === "error";
  durationInput.value = state.duration;
  durationInput.setAttribute("aria-valuetext", state.duration + " minutes");
  const minimum = Number(durationInput.min);
  const progress = (state.duration - minimum) / (MAX_DURATION - minimum) * 100;
  durationInput.style.setProperty("--duration-progress", progress + "%");
  $("duration-value").value = state.duration + " min";
  const timeButtons = times.map((start) => {
    const button = node("button", "time-choice", formatTime(start));
    button.type = "button";
    button.dataset.start = start;
    button.setAttribute("aria-label", timeRange(start, start + state.duration * MINUTE));
    button.setAttribute("aria-pressed", String(start === state.selectedStart));
    return button;
  });
  const emptyMessage = {
    loading: "Checking the calendar…",
    error: "The calendar is temporarily unavailable.",
  }[state.mode] || (state.selectedDate ? "No times fit this length on this date." : "No openings this month for this length.");
  $("times").replaceChildren(...(timeButtons.length ? timeButtons : [node("p", "slot-message", emptyMessage)]));
  if (focusedTime) timeButtons.find((button) => button.dataset.start === focusedTime)?.focus({ preventScroll: true });
  $("continue").disabled = state.selectedStart === null;

  const status = $("page-status");
  status.replaceChildren();
  if (state.mode === "error") {
    const retry = node("button", "button outline", "Retry");
    retry.addEventListener("click", () => { retry.disabled = true; refreshAvailability(); });
    status.append(retry);
  }
}

let timeRefresh;
durationInput.addEventListener("input", () => {
  timeRefresh?.cancel();
  state.duration = durationInput.valueAsNumber;
  state.chosenDuration = state.duration;
  filterSlots(true);
});

durationInput.addEventListener("change", () => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Figma Motion's available-times track settles at 12% of its two-second preview.
  timeRefresh = $("times").animate([
    { opacity: 0.72, transform: "translateY(4px)" },
    { opacity: 1, transform: "translateY(0px)" },
  ], { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
});

for (const [id, by] of [["month-prev", -1], ["month-next", 1]]) {
  $(id).addEventListener("click", () => {
    state.month = shiftMonth(state.month, by);
    selectFirstDate();
    renderGuest();
  });
}
$("days").addEventListener("click", ({ target }) => {
  const button = target.closest("button[data-day]");
  if (!button) return;
  state.selectedDate = button.dataset.day;
  state.selectedStart = null;
  renderGuest();
});
$("times").addEventListener("click", ({ target }) => {
  const button = target.closest("button[data-start]");
  if (!button) return;
  state.selectedStart = Number(button.dataset.start);
  renderGuest();
});

function showMessage(context, message = "", kind = "") {
  const output = context.matches(".form-message") ? context : context.querySelector(".form-message");
  output.textContent = message;
  output.dataset.kind = kind;
}

function handleForm(id, action) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = event.submitter || form.querySelector("[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    showMessage(form, "One moment…");
    try {
      const message = await action(new FormData(form), form);
      showMessage(form, message);
    } catch (error) {
      showMessage(form, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
}

const bookDialog = $("book-dialog");
let booking;
let completed;
$("continue").addEventListener("click", () => {
  const { selectedStart: start, duration, mode } = state;
  if (start === null || !["preview", "live"].includes(mode)) return;
  booking = { start, end: start + duration * MINUTE, preview: mode === "preview" };
  $("book-form").reset();
  showMessage($("book-form"));
  $("book-title").textContent = booking.preview ? "Try a preview booking" : "Make it a date";
  $("book-summary").textContent = describeSlot(booking.start, booking.end);
  $("booking-note").textContent = booking.preview ? "Use sample details to try the booking flow." : "Your email is shared with Demi so you can make plans.";
  $("book-step").hidden = false;
  $("confirmed-step").hidden = true;
  bookDialog.setAttribute("aria-labelledby", "book-title");
  bookDialog.showModal();
});

handleForm("book-form", async (values) => {
  const { start, end, preview } = booking;
  const details = Object.fromEntries(values);
  details.name = details.name.trim();
  details.email = details.email.trim();
  if (!details.name) throw new Error("Enter your name.");
  const fingerprint = JSON.stringify(details);
  if (booking.fingerprint !== fingerprint) {
    booking.requestId = crypto.randomUUID();
    booking.fingerprint = fingerprint;
  }
  if (!preview) {
    try {
      completed = await api("book", { data: { requestId: booking.requestId, start, end, ...details } });
    } catch (error) {
      if (error.status === 409) refreshAvailability();
      throw error;
    }
  } else {
    takenPreview.push({ start, end });
  }
  $("book-step").hidden = true;
  $("confirmed-step").hidden = false;
  $("confirmed-title").textContent = preview ? "Preview complete" : "It’s a date!";
  $("confirmed-summary").textContent = describeSlot(start, end);
  $("confirmed-note").hidden = preview;
  $("confirmed-note").textContent = "Demi has your booking. Add it to your own calendar to keep it handy.";
  $("download-event").hidden = preview;
  bookDialog.setAttribute("aria-labelledby", "confirmed-title");
  $("confirmed-step").querySelector(preview ? ".close-dialog" : "#download-event").focus();
  refreshAvailability();
});

for (const dialog of document.querySelectorAll("dialog")) {
  const isSaving = () => dialog.querySelector("button[type=submit]:disabled");
  dialog.addEventListener("cancel", (event) => { if (isSaving()) event.preventDefault(); });
  for (const button of dialog.querySelectorAll(".close-dialog")) {
    button.addEventListener("click", () => { if (!isSaving()) dialog.close(); });
  }
}

function calendarStamp(epoch) {
  return new Date(epoch).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

$("download-event").addEventListener("click", () => {
  if (!completed) return;
  const file = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demi's Calendar//Hangout//EN", "BEGIN:VEVENT",
    "UID:" + completed.id + "@demis-calendar", "DTSTAMP:" + calendarStamp(Date.now()),
    "DTSTART:" + calendarStamp(completed.start), "DTEND:" + calendarStamp(completed.end),
    "SUMMARY:Hangout with Demi", "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([file], { type: "text/calendar;charset=utf-8" }));
  const link = node("a");
  link.href = url;
  link.download = "hangout-with-demi.ics";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
});

function showTab(name) {
  state.tab = name;
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === name));
  }
  for (const pane of document.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== name;
  if (name === "notifications") updatePushButton();
}

for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", async () => {
    const tab = button.dataset.tab;
    showTab(tab);
    if (!state.hostKey || !["bookings", "notifications"].includes(tab)) return;
    const key = state.hostKey;
    try {
      const data = await api("host", { key });
      if (state.hostKey !== key) return;
      renderItems($("bookings"), data.bookings, "booking");
      renderItems($("activity"), data.activity, "activity");
    } catch (error) {
      if (error.status === 401) lockHost();
    }
  });
}

function renderWeekly(weekly, duration) {
  $("duration").value = duration;
  const rows = DAYS.map((name, index) => {
    const row = node("div", "weekly-row");
    const label = node("label", "weekday-toggle");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.name = "enabled-" + index;
    checkbox.checked = Boolean(weekly[index]);
    label.append(checkbox, document.createTextNode(name));
    const from = node("input");
    from.type = "time";
    from.name = "start-" + index;
    from.value = weekly[index]?.start || "17:00";
    from.setAttribute("aria-label", name + " start");
    const until = node("input");
    until.type = "time";
    until.name = "end-" + index;
    until.value = weekly[index]?.end || "20:00";
    until.setAttribute("aria-label", name + " end");
    const enable = () => {
      from.disabled = !checkbox.checked;
      until.disabled = !checkbox.checked;
      from.required = checkbox.checked;
      until.required = checkbox.checked;
    };
    checkbox.addEventListener("change", enable);
    enable();
    row.append(label, from, until);
    return row;
  });
  $("weekly-hours").replaceChildren(...rows);
}

function renderCalendars(data) {
  const connected = Boolean(data.connection);
  $("connect-panel").hidden = connected;
  $("connected-panel").hidden = !connected;
  if (!connected) return;
  $("connection-status").textContent = "Connected as " + data.connection.email;
  $("write-calendar").replaceChildren(...data.connection.calendars.filter((calendar) => calendar.writable).map((calendar) => {
    const option = node("option", "", calendar.name);
    option.value = calendar.id;
    return option;
  }));
  $("write-calendar").value = data.connection.writeCalendar;
  $("busy-calendars").replaceChildren(...data.connection.calendars.map((calendar) => {
    const label = node("label");
    const input = node("input");
    input.type = "checkbox";
    input.name = "busy";
    input.value = calendar.id;
    input.checked = data.connection.busyCalendars.includes(calendar.id);
    label.append(input, document.createTextNode(calendar.name));
    return label;
  }));
}

let cancellation;
function renderItems(target, items, kind) {
  if (!items.length) {
    target.replaceChildren(node("p", "muted", {
      booking: "New hangouts will show up here.",
      block: "No upcoming time blocks.",
      activity: "Booking and availability updates will show up here.",
    }[kind]));
    return;
  }
  target.replaceChildren(...items.map((item) => {
    const row = node("article", "item");
    const details = node("div");
    if (kind === "activity") {
      details.append(node("h3", "", item.title), node("p", "muted", item.body), node("p", "muted", formatDate(item.created) + " · " + formatTime(item.created)));
      row.append(details);
      return row;
    }
    const title = kind === "booking" ? item.name : "Busy";
    details.append(node("h3", "", item.status === "pending" ? title + " · Syncing" : title));
    details.append(node("p", "muted", describeSlot(item.start, item.end)));
    if (item.email) details.append(node("p", "muted", item.email));
    if (item.note) details.append(node("p", "muted", item.note));
    const remove = node("button", "button outline", kind === "booking" ? "Cancel" : "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      cancellation = item;
      $("cancel-title").textContent = kind === "booking" ? "Cancel this hangout?" : "Remove this block?";
      const description = describeSlot(item.start, item.end);
      $("cancel-summary").textContent = description + (kind === "booking" ? " · Please let " + item.name + " know." : "");
      $("cancel-submit").textContent = kind === "booking" ? "Cancel hangout" : "Remove block";
      showMessage($("cancel-form"));
      $("cancel-dialog").showModal();
    });
    row.append(details, remove);
    return row;
  }));
}

function renderHost(data) {
  state.host = data;
  $("host-unlock").hidden = true;
  $("host-content").hidden = false;
  $("host-actions").hidden = false;
  $("copy-link").disabled = !data.connection || !data.weekly.some(Boolean);
  renderCalendars(data);
  renderWeekly(data.weekly, data.duration);
  renderItems($("bookings"), data.bookings, "booking");
  renderItems($("blocks"), data.blocks, "block");
  renderItems($("activity"), data.activity, "activity");
  $("block-day").min = dateKey(Date.now());
  $("block-day").max = dateKey(Date.now() + (BOOKING_DAYS - 1) * DAY);
  if (!$("block-day").value) $("block-day").value = $("block-day").min;
  showTab(state.tab);
}

function lockHost() {
  state.hostKey = "";
  state.host = null;
  sessionStorage.removeItem("demi-host-key");
  $("host-unlock").hidden = false;
  $("host-content").hidden = true;
  $("host-actions").hidden = true;
  $("unlock-form").reset();
  $("connect-form").reset();
  $("bookings").replaceChildren();
  $("blocks").replaceChildren();
  $("activity").replaceChildren();
  $("connection-status").textContent = "";
  $("write-calendar").replaceChildren();
  $("busy-calendars").replaceChildren();
  showMessage($("unlock-form"));
}

async function updateHost(action, data) {
  const result = await api(action, { key: state.hostKey, data });
  if (state.hostKey) renderHost(result);
  state.lastFetch = 0;
  return result;
}

handleForm("unlock-form", async (values) => {
  const key = String(values.get("key")).trim();
  const data = await api("host", { key });
  state.hostKey = key;
  sessionStorage.setItem("demi-host-key", key);
  state.tab = data.connection ? "availability" : "calendar";
  renderHost(data);
  $("unlock-form").reset();
});

$("lock-host").addEventListener("click", lockHost);
$("copy-link").addEventListener("click", async () => {
  const link = new URL("./", location.href).href;
  const button = $("copy-link");
  let label;
  try {
    await navigator.clipboard.writeText(link);
    label = "Booking link copied";
  } catch {
    label = "Copy the URL from the booking page";
  }
  button.replaceChildren(icon("link"), document.createTextNode(label));
  setTimeout(() => button.replaceChildren(icon("link"), document.createTextNode("Copy booking link")), 2300);
});
$("reconnect").addEventListener("click", () => {
  $("connect-panel").hidden = false;
  $("connected-panel").hidden = true;
  $("connect-form").querySelector("[name=email]").focus();
});
handleForm("connect-form", async (values, form) => {
  await updateHost("connect", Object.fromEntries(values));
  form.reset();
  showTab("availability");
  showMessage($("hours-form"), "Apple Calendar is connected. Set your booking hours to open your calendar.");
});
handleForm("calendar-form", async (values) => {
  await updateHost("calendars", { writeCalendar: values.get("writeCalendar"), busyCalendars: values.getAll("busy") });
  return "Calendars saved.";
});
handleForm("hours-form", async (values) => {
  const weekly = DAYS.map((day, index) => (
    values.has("enabled-" + index) ? { start: values.get("start-" + index), end: values.get("end-" + index) } : null
  ));
  const result = await updateHost("hours", { duration: Number(values.get("duration")), weekly });
  return result.connection && weekly.some(Boolean) ? "Hours saved. Your booking link is open." : "Hours saved.";
});
let blockRequest = {};
handleForm("block-form", async (values) => {
  const date = values.get("date");
  const start = dayEpoch(date, values.get("start"));
  const end = dayEpoch(date, values.get("end"));
  if (end <= start) throw new Error("Choose an end time after the start time.");
  if (blockRequest.start !== start || blockRequest.end !== end) blockRequest = { start, end, requestId: crypto.randomUUID() };
  await updateHost("block", blockRequest);
  blockRequest = {};
  return "Time blocked.";
});
handleForm("cancel-form", async () => {
  await updateHost("cancel", { id: cancellation.id });
  $("cancel-dialog").close();
});

const supportsPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const worker = supportsPush ? navigator.serviceWorker.register("./sw.js").catch(() => null) : Promise.resolve(null);

async function updatePushButton() {
  const button = $("push-toggle");
  const registration = await worker;
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  const enabled = Boolean(subscription && state.host?.pushEndpoints?.includes(subscription.endpoint));
  button.disabled = !registration || !state.host?.pushKey;
  button.querySelector("span").textContent = enabled ? "Turn off alerts" : "Enable alerts";
  if (!supportsPush) showMessage($("push-message"), "This browser doesn’t support device alerts here. You can still read updates below.");
}

$("push-toggle").addEventListener("click", async () => {
  const button = $("push-toggle");
  button.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Allow notifications for this app in your device settings.");
    const registration = await worker;
    if (!registration || !state.host) throw new Error("Device alerts aren’t available right now.");
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && state.host.pushEndpoints.includes(subscription.endpoint)) {
      await updateHost("push", { endpoint: subscription.endpoint, remove: true });
      await subscription.unsubscribe();
      showMessage($("push-message"), "Alerts are off on this device.");
    } else {
      await navigator.serviceWorker.ready;
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: state.host.pushKey });
      await updateHost("push", { subscription: subscription.toJSON() });
      showMessage($("push-message"), "Alerts are on for this device.");
    }
  } catch (error) {
    showMessage($("push-message"), error.message, "error");
  } finally {
    updatePushButton();
  }
});

function route() {
  const host = location.hash === "#host";
  $("guest-view").hidden = host;
  $("host-view").hidden = !host;
  const link = $("nav-link");
  link.href = host ? "#" : "#host";
  link.textContent = host ? "Booking page" : "Host settings";
  if (host && state.hostKey && !state.host) {
    const key = state.hostKey;
    api("host", { key }).then((data) => {
      if (state.hostKey === key) renderHost(data);
    }).catch((error) => {
      if (error.status === 401) lockHost();
      if (!state.host) showMessage($("unlock-form"), error.message, "error");
    });
  }
  if (!host && Date.now() - state.lastFetch > 30_000) refreshAvailability();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") route();
});
window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  route();
});
renderGuest();
route();

if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("entered");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.querySelectorAll("[data-reveal]").forEach((section) => observer.observe(section));
}
