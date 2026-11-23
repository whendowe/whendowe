// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createEvent } from "../../src/events/event.js";
import type { PublicGet } from "../../src/following/fetch.js";
import { refreshCalendar } from "../../src/following/follow.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { findAskDraft } from "../../src/plans/ask.js";
import { FOLLOWING_PATH } from "../../src/web/routes/following.js";
import { sheetPath, WHATS_ON_PATH } from "../../src/web/routes/whats-on.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";
import { harness } from "./google-harness.js";

// What's on when you're free (DESIGN §10 rc58): the next two weeks of what you follow, by day,
// what clashes with something of yours left out unless asked for; a followed event's sheet
// shown only to its followers; Invite people a POST that starts an Ask with its time.

const NOW = "2026-11-21T12:00:00.000Z"; // a Saturday, 13:00 in Prague
const URL_ICS = "https://club.example/swing.ics";

const FEED = [
  "BEGIN:VCALENDAR",
  "X-WR-CALNAME:Swing <school>",
  "X-WR-TIMEZONE:Europe/Prague",
  ...[
    // Tonight, 19:00–23:00.
    [
      "UID:tonight",
      "DTSTART:20261121T180000Z",
      "DTEND:20261121T220000Z",
      "SUMMARY:Social <b>night</b>",
      "LOCATION:Hall & bar",
      "DESCRIPTION:Bring shoes.\\nAll levels.",
      "URL:https://club.example/social?id=1",
    ],
    // Tomorrow, past midnight.
    [
      "UID:late",
      "DTSTART:20261122T190000Z",
      "DTEND:20261123T000000Z",
      "SUMMARY:Late jam",
      "URL:javascript:alert(1)",
    ],
    ["UID:fest", "DTSTART;VALUE=DATE:20261128", "DTEND;VALUE=DATE:20261130", "SUMMARY:Festival"],
    // Floating: no zone at all, read as UTC.
    ["UID:float", "DTSTART:20261124T190000", "DTEND:20261124T200000", "SUMMARY:Floating"],
    ["UID:market", "DTSTART;VALUE=DATE:20261125", "DTEND;VALUE=DATE:20261126", "SUMMARY:Market"],
    ["UID:bell", "DTSTART:20261126T170000Z", "DTEND:20261126T170000Z", "SUMMARY:Bell"],
    [
      "UID:long",
      "DTSTART:20261127T170000Z",
      "DTEND:20261127T180000Z",
      `SUMMARY:${"T".repeat(250)}`,
      `LOCATION:${"L".repeat(250)}`,
    ],
    [
      "UID:gone",
      "DTSTART:20261125T180000Z",
      "DTEND:20261125T200000Z",
      "SUMMARY:Gone",
      "STATUS:CANCELLED",
    ],
  ].flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
  "END:VCALENDAR",
].join("\r\n");

const serving: PublicGet = async () => ({
  status: 200,
  header: () => null,
  body: {
    getReader: () => {
      const chunks = [new TextEncoder().encode(FEED)];
      return {
        read: async () => {
          const value = chunks.shift();
          return value === undefined ? { done: true } : { done: false, value };
        },
        cancel: async () => {},
      };
    },
  },
});

/** Ann, signed in, following the swing school. */
async function following(now = NOW): Promise<{ b: Browser; csrf: string; calendarId: string }> {
  const b = await browser({ now: () => now, publicGet: serving });
  await addAccount(b, "ann@example.org");
  const { csrf } = await home(b);
  await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS, for: "me" }));
  const [row] = await b.storage.query({ sql: "SELECT id FROM followed_calendar", params: [] });
  return { b, csrf, calendarId: String(row?.id) };
}

const text = async (b: Browser, path: string) => (await b.request(path)).text();

it("asks you to sign in, writes nothing, and is linked from home", async () => {
  const b = await browser({ now: () => NOW });
  const out = await b.request(WHATS_ON_PATH);
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe(
    `/auth/sign-in?next=${encodeURIComponent(WHATS_ON_PATH)}`,
  );
  await addAccount(b, "ann@example.org");
  expect((await home(b)).text).toContain(`<a href="${WHATS_ON_PATH}">What's on</a>`);
  const before = b.writes;
  const res = await b.request(WHATS_ON_PATH);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const page = await res.text();
  expect(page).toContain("<h1>What's on</h1>");
  // Nothing on: no toggle and no script, as there is nothing to take out (F2b).
  expect(page.replace(/\s+/g, " ")).toContain(
    '<a href="/following">Calendars you follow</a></p> <p class="muted">Nothing on in the next 14 days from the calendars you follow.</p></div> </body>',
  );
  expect(b.writes).toBe(before);
});

it("lists what's on by day, in the calendar's own time, escaped, cancelled left out", async () => {
  const { b, calendarId } = await following();
  const before = b.writes;
  const page = await text(b, WHATS_ON_PATH);
  expect(b.writes).toBe(before);
  expect(page).toContain('<h2 class="day">Today · Saturday 21 November</h2>');
  expect(page).toContain('<h2 class="day">Tomorrow · Sunday 22 November</h2>');
  expect(page).toContain('<h2 class="day">Saturday 28 November</h2>');
  expect(page).toContain('<span class="when">19:00–23:00</span>');
  expect(page).toContain('<span class="when">20:00 – Mon 01:00</span>');
  expect(page).toContain('<span class="when">All day, to Sunday 29 November</span>');
  expect(page).toContain(
    `<a href="${sheetPath({ calendarId, uid: "tonight" }).replace("&", "&amp;")}"><strong>Social &lt;b&gt;night&lt;/b&gt;</strong></a> <span class="muted">· Hall &amp; bar</span>`,
  );
  expect(page).toContain("Swing &lt;school&gt;");
  expect(page).toContain('data-start="2026-11-21T18:00:00Z" data-end="2026-11-21T22:00:00Z"');
  expect(page).not.toContain("Gone");
  // In order: tonight, tomorrow, the festival.
  expect(page.indexOf("Social &lt;b&gt;")).toBeLessThan(page.indexOf("Late jam"));
  expect(page.indexOf("Late jam")).toBeLessThan(page.indexOf("Festival"));
  // Nothing clashes, so nothing to show — until the page's script finds Google's (F2b).
  expect(page).toContain('<p data-clash-toggle="0" hidden><a href="/whats-on?clashes=1">');
});

it("leaves out what overlaps something of yours, and shows it dimmed when asked", async () => {
  const { b } = await following();
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createEvent(b.storage, {
    creatorId: ann.id,
    group: null,
    fields: {
      title: "Dinner",
      description: null,
      location: null,
      allDay: false,
      startLocal: "2026-11-21T18:00",
      endLocal: "2026-11-21T20:00",
      tzid: "Europe/Prague",
    },
    now: NOW,
  });
  const page = await text(b, WHATS_ON_PATH);
  expect(page).not.toContain("Social &lt;b&gt;");
  expect(page).toContain("Late jam");
  expect(page).toContain(
    `<p data-clash-toggle="1"><a href="${WHATS_ON_PATH}?clashes=1">Show what clashes</a> <span class="muted" data-clash-count>(1 event overlaps something of yours)</span></p>`,
  );
  const all = await text(b, `${WHATS_ON_PATH}?clashes=1`);
  expect(all).toContain('class="fc-f1 clash"');
  expect(all).toContain("Social &lt;b&gt;");
  expect(all).toContain("· You have something then");
  expect(all).toContain(`<a href="${WHATS_ON_PATH}">Hide what clashes</a>`);
});

it("says when everything clashes, and counts more than one", async () => {
  const { b } = await following();
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createEvent(b.storage, {
    creatorId: ann.id,
    group: null,
    fields: {
      title: "Away",
      description: null,
      location: null,
      allDay: true,
      startLocal: "2026-11-21",
      endLocal: "2026-12-06",
      tzid: null,
    },
    now: NOW,
  });
  const page = await text(b, WHATS_ON_PATH);
  expect(page).toContain(
    '<p class="muted" data-none>Nothing on when you\'re free in the next 14 days.</p>',
  );
  expect(page).toContain("(7 events overlap something of yours)");
});

it("a followed event's sheet: what it is, a link only if it is web, for its followers only", async () => {
  const { b, calendarId } = await following();
  const res = await b.request(sheetPath({ calendarId, uid: "tonight" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const sheet = await res.text();
  expect(sheet).toContain("<h1>Social &lt;b&gt;night&lt;/b&gt;</h1>");
  expect(sheet).toContain(
    '<p>Saturday 21 November · 19:00–23:00 <span class="muted">Europe/Prague</span></p>',
  );
  expect(sheet).toContain("<p>Hall &amp; bar</p>");
  expect(sheet).toContain('<p class="description">Bring shoes.\nAll levels.</p>');
  expect(sheet).toContain(
    '<a href="https://club.example/social?id=1" rel="noreferrer noopener">https://club.example/social?id=1</a>',
  );
  expect(sheet).toContain(
    "From Swing &lt;school&gt;. It isn't an event of yours: nobody is asked anything about it.</p>",
  );
  expect(sheet).toContain(`action="${WHATS_ON_PATH}/${calendarId}/invite"`);
  expect(sheet).toContain('<input type="hidden" name="e" value="tonight" />');
  expect(sheet).not.toContain("You have something then");
  // A link that isn't web isn't kept, and so isn't shown.
  const late = await text(b, sheetPath({ calendarId, uid: "late" }));
  expect(late).toContain("<h1>Late jam</h1>");
  expect(late).not.toContain("javascript");
  // A cancelled one says so, and offers no Invite.
  const gone = await text(b, sheetPath({ calendarId, uid: "gone" }));
  expect(gone).toContain('<p class="error">Cancelled.</p>');
  expect(gone).not.toContain("Invite people");
  // Someone who doesn't follow it, or an event that isn't there: not found.
  const carl = b.another();
  await addAccount(carl, "carl@example.org");
  expect((await carl.request(sheetPath({ calendarId, uid: "tonight" }))).status).toBe(404);
  expect((await b.request(sheetPath({ calendarId, uid: "nothing" }))).status).toBe(404);
  expect((await b.request(`${WHATS_ON_PATH}/${calendarId}`)).status).toBe(404);
});

it("Invite people starts an Ask with its time, title, place and link; a POST with its CSRF", async () => {
  const { b, csrf, calendarId } = await following();
  const invite = `${WHATS_ON_PATH}/${calendarId}/invite`;
  const before = b.writes;
  expect((await b.request(invite, post({ csrf: "wrong", e: "tonight" }))).status).toBe(403);
  expect(b.writes).toBe(before);
  const res = await b.request(invite, post({ csrf, e: "tonight" }));
  expect(res.status).toBe(303);
  const id = /^\/ask\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const draft = await findAskDraft(b.storage, { id, authorId: ann.id });
  expect(draft?.groupId).toBeNull();
  expect(draft?.body).toMatchObject({
    title: "Social <b>night</b>",
    location: "Hall & bar",
    note: "https://club.example/social?id=1",
    tzid: "Europe/Prague",
    emails: [],
    options: [[{ allDay: false, startLocal: "2026-11-21T19:00", endLocal: "2026-11-21T23:00" }]],
  });
  expect(draft?.body.options[0]?.[0]?.sid).toMatch(/^[0-9a-f-]{36}$/);
  // The Ask page opens on it.
  expect(await text(b, `/ask/${id}`)).toContain('value="Social &lt;b&gt;night&lt;/b&gt;"');
  // An all-day one is its days.
  const fest = await b.request(invite, post({ csrf, e: "fest" }));
  const festId = /^\/ask\/(.+)$/.exec(fest.headers.get("location") ?? "")?.[1] ?? "";
  expect((await findAskDraft(b.storage, { id: festId, authorId: ann.id }))?.body).toMatchObject({
    location: null,
    note: null,
    options: [[{ allDay: true, startLocal: "2026-11-28", endLocal: "2026-11-30" }]],
  });
  // Cancelled, not followed, not there: not found, nothing written.
  const carl = b.another();
  await addAccount(carl, "carl@example.org");
  const carlCsrf = (await home(carl)).csrf;
  const was = b.writes;
  expect((await b.request(invite, post({ csrf, e: "gone" }))).status).toBe(404);
  expect((await b.request(invite, post({ csrf, e: "nothing" }))).status).toBe(404);
  expect((await carl.request(invite, post({ csrf: carlCsrf, e: "tonight" }))).status).toBe(404);
  expect(b.writes).toBe(was);
  // Signed out: to sign in, nothing written.
  const out = await browser({ now: () => NOW });
  expect((await out.request(invite, post({ csrf: "x", e: "tonight" }))).status).toBe(303);
});

/** Whitespace as one space, so markup can be compared across the template's line breaks. */
const squash = (s: string) => s.replace(/\s+/g, " ");

it("draws each kind of time, and only what each event has", async () => {
  const { b, calendarId } = await following();
  const page = squash(await text(b, WHATS_ON_PATH));
  expect(page).toContain("<title>What&#39;s on · WhenDoWe</title>");
  // Nothing clashes: between the page's line and its first day, only what the script may show.
  expect(page).toContain(
    '<div data-whats-on="/busy" data-from="2026-11-20" data-to="2026-12-06" data-clashes="0"><h1>What\'s on</h1> <p class="muted">The next 14 days from the calendars you and your groups follow, when you\'re free: what overlaps something of yours is left out. <a href="/following">Calendars you follow</a></p> <p data-clash-toggle="0" hidden><a href="/whats-on?clashes=1">Show what clashes</a> <span class="muted" data-clash-count>(0 events overlap something of yours)</span></p> <p class="muted" data-none hidden>Nothing on when you\'re free in the next 14 days.</p><h2 class="day">Today',
  );
  // No place, no clash: nothing after its calendar.
  expect(page).toContain(
    `<li class="fc-f1" data-start="2026-11-22T19:00:00Z" data-end="2026-11-23T00:00:00Z"> <span class="when">20:00 – Mon 01:00</span><a href="${sheetPath({ calendarId, uid: "late" }).replace("&", "&amp;")}"><strong>Late jam</strong></a><br /><span class="muted"><span class="fc-dot" aria-hidden="true"></span>Swing &lt;school&gt;</span></li>`,
  );
  // All-day: no instants; one day, or to its last.
  expect(page).toContain(
    '<li class="fc-f1" data-start="" data-end=""> <span class="when">All day</span>',
  );
  expect(page).toContain('<span class="when">All day, to Sunday 29 November</span>');
  // A moment, and a floating time read as UTC.
  expect(page).toContain('<span class="when">18:00</span>');
  expect(page).toContain(
    'data-start="2026-11-24T19:00:00Z" data-end="2026-11-24T20:00:00Z"> <span class="when">19:00–20:00</span>',
  );
  // Its sheet: no zone to name, no place, no description, no link, no clash.
  const floating = squash(await text(b, sheetPath({ calendarId, uid: "float" })));
  expect(floating).toContain(
    '<h1>Floating</h1> <p>Tuesday 24 November · 19:00–20:00</p> <p class="muted"><span class="fc-dot" aria-hidden="true"></span>From Swing &lt;school&gt;. It isn\'t an event of yours: nobody is asked anything about it.</p> </div> <form method="post"',
  );
  // A cancelled one's sheet ends with the way back.
  const gone = squash(await text(b, sheetPath({ calendarId, uid: "gone" })));
  expect(gone).toContain('anything about it.</p> </div> <p><a href="/whats-on">What\'s on</a></p>');
});

it("today is the calendar's own: past midnight in Prague, before it in UTC", async () => {
  const { b } = await following("2026-11-21T23:30:00.000Z");
  const page = await text(b, WHATS_ON_PATH);
  expect(page).toContain('<h2 class="day">Today · Sunday 22 November</h2>');
  expect(page).toContain('<h2 class="day">Tuesday 24 November</h2>');
});

it("a link a feed shouldn't have given is never a link", async () => {
  const { b, calendarId } = await following();
  await b.storage.batch([
    {
      sql: "UPDATE followed_event SET url = ? WHERE uid = ?",
      params: ["javascript:alert('https://x')", "late"],
    },
    {
      sql: "UPDATE followed_event SET url = ? WHERE uid = ?",
      params: ["http://club.example/x", "fest"],
    },
  ]);
  expect(await text(b, sheetPath({ calendarId, uid: "late" }))).not.toContain("javascript");
  expect(await text(b, sheetPath({ calendarId, uid: "fest" }))).toContain(
    '<p><a href="http://club.example/x" rel="noreferrer noopener">http://club.example/x</a></p>',
  );
});

it("a clashing event's sheet says so; not found says why; signed out is asked to sign in", async () => {
  const { b, csrf, calendarId } = await following();
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createEvent(b.storage, {
    creatorId: ann.id,
    group: null,
    fields: {
      title: "Dinner",
      description: null,
      location: null,
      allDay: false,
      startLocal: "2026-11-21T18:00",
      endLocal: "2026-11-21T20:00",
      tzid: "Europe/Prague",
    },
    now: NOW,
  });
  expect(await text(b, sheetPath({ calendarId, uid: "tonight" }))).toContain(
    '<p class="muted">You have something then.</p>',
  );
  const missing = await b.request(sheetPath({ calendarId, uid: "nothing" }));
  const missingText = await missing.text();
  expect(missingText).toContain("<title>Not found · WhenDoWe</title>");
  expect(missingText).toContain(
    "<h1>Not found</h1><p>That isn't an event from a calendar you follow.</p>",
  );
  // No event named: not found.
  const invite = `${WHATS_ON_PATH}/${calendarId}/invite`;
  expect((await b.request(invite, post({ csrf }))).status).toBe(404);
  const out = await browser({ now: () => NOW });
  const res = await out.request(sheetPath({ calendarId, uid: "tonight" }));
  expect(res.status).toBe(303);
});

it("Invite people keeps to what an Ask holds", async () => {
  const { b, csrf, calendarId } = await following();
  const res = await b.request(`${WHATS_ON_PATH}/${calendarId}/invite`, post({ csrf, e: "long" }));
  const id = /^\/ask\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const body = (await findAskDraft(b.storage, { id, authorId: ann.id }))?.body;
  expect(body?.title).toBe("T".repeat(200));
  expect(body?.location).toBe("L".repeat(200));
});

it("gives the page's script the days to ask Google about, and says when it can't (F2b)", async () => {
  const { b } = await following();
  const page = await text(b, WHATS_ON_PATH);
  // The same UTC days the server counted your own busy times over, a day either side.
  expect(page).toContain('data-whats-on="/busy" data-from="2026-11-20" data-to="2026-12-06"');
  expect(page).toContain("globalThis.WhenDoWeWhatsOnBusy");
  expect(await text(b, `${WHATS_ON_PATH}?clashes=1`)).toContain('data-clashes="1"');
  // An instance with no Google client has no Google busy times to miss.
  expect(page).not.toContain("<noscript>");
  const g = await harness();
  const withGoogle = await g.page(WHATS_ON_PATH);
  expect(withGoogle).toContain(
    '<noscript><p class="small muted">Without JavaScript, your Google busy times aren\'t counted.</p></noscript>',
  );
  // Nothing on: nothing to take out, so no script.
  expect(withGoogle).not.toContain("globalThis.WhenDoWeWhatsOnBusy");
});

it("Going makes an event of yours, a POST with its CSRF; the sheet and the page then say so (rc59)", async () => {
  const { b, csrf, calendarId } = await following();
  const going = `${WHATS_ON_PATH}/${calendarId}/going`;
  const sheet = await text(b, sheetPath({ calendarId, uid: "tonight" }));
  expect(squash(sheet)).toContain(
    `<form method="post" action="${going}"> <input type="hidden" name="csrf" value="${csrf}" /> <input type="hidden" name="e" value="tonight" /> <p><button type="submit">Going</button> <span class="muted">Make it an event of yours, in your calendar. Nobody is told.</span></p> </form>`,
  );
  const before = b.writes;
  expect((await b.request(going, post({ csrf: "wrong", e: "tonight" }))).status).toBe(403);
  expect(b.writes).toBe(before);
  const res = await b.request(going, post({ csrf, e: "tonight" }));
  expect(res.status).toBe(303);
  const id = /^\/events\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  expect(await text(b, `/events/${id}`)).toContain("Social &lt;b&gt;night&lt;/b&gt;");
  // Again: your event, not a second one.
  const again = await b.request(going, post({ csrf, e: "tonight" }));
  expect(again.headers.get("location")).toBe(`/events/${id}`);
  // The sheet says you're going, and offers Going no more; Invite people stays.
  const now = await text(b, sheetPath({ calendarId, uid: "tonight" }));
  expect(now).toContain(
    `<p><strong>You're going.</strong> It's <a href="/events/${id}">your event</a> now, in your calendar.</p>`,
  );
  expect(now).not.toContain(going);
  expect(now).toContain("Invite people");
  expect(now).toContain('aria-hidden="true"></span>From Swing &lt;school&gt;.</p>');
  // What's on lists it as going, never as a clash with itself, and the script leaves it alone.
  const page = squash(await text(b, WHATS_ON_PATH));
  expect(page).toContain(
    `<li class="fc-f1" data-going data-start="2026-11-21T18:00:00Z" data-end="2026-11-21T22:00:00Z">`,
  );
  expect(page).toContain(` · <a href="/events/${id}">You're going</a></li>`);
  expect(page).not.toContain('Show what clashes</a> <span class="muted" data-clash-count>(1');
  // Other events aren't marked.
  expect(page.split('<li class="fc-f1" data-going').length).toBe(2);
});

it("Going: a cancelled event offers none, a moment can't be one, and others get not found", async () => {
  const { b, csrf, calendarId } = await following();
  const going = `${WHATS_ON_PATH}/${calendarId}/going`;
  // Cancelled: no button, and a POST is not found.
  expect(await text(b, sheetPath({ calendarId, uid: "gone" }))).not.toContain(going);
  const before = b.writes;
  expect((await b.request(going, post({ csrf, e: "gone" }))).status).toBe(404);
  // A moment with no length: a line instead of the button, and a POST goes back to the sheet.
  const bell = await text(b, sheetPath({ calendarId, uid: "bell" }));
  expect(bell).toContain(
    '<p class="muted">It has no length, so it can\'t be an event of yours.</p>',
  );
  expect(bell).not.toContain(going);
  const moment = await b.request(going, post({ csrf, e: "bell" }));
  expect(moment.status).toBe(303);
  expect(moment.headers.get("location")).toBe(sheetPath({ calendarId, uid: "bell" }));
  // Not followed, not there, no uid: not found.
  expect((await b.request(going, post({ csrf, e: "nothing" }))).status).toBe(404);
  expect((await b.request(going, post({ csrf }))).status).toBe(404);
  expect(b.writes).toBe(before);
  const carl = b.another();
  await addAccount(carl, "carl@example.org");
  const carlCsrf = (await home(carl)).csrf;
  const signedIn = b.writes;
  expect((await carl.request(going, post({ csrf: carlCsrf, e: "tonight" }))).status).toBe(404);
  expect(b.writes).toBe(signedIn);
  // Signed out: to sign in.
  const out = await browser({ now: () => NOW });
  expect((await out.request(going, post({ csrf: "x", e: "tonight" }))).status).toBe(303);
});

it("a cancelled event of yours from it: the sheet links to it, and the page lists it as before", async () => {
  const { b, csrf, calendarId } = await following();
  const going = `${WHATS_ON_PATH}/${calendarId}/going`;
  const id = /^\/events\/(.+)$/.exec(
    (await b.request(going, post({ csrf, e: "tonight" }))).headers.get("location") ?? "",
  )?.[1];
  await b.storage.query({
    sql: "UPDATE canonical_event SET status = 'cancelled' WHERE id = ?",
    params: [id ?? ""],
  });
  expect(await text(b, sheetPath({ calendarId, uid: "tonight" }))).toContain(
    `<p>You cancelled <a href="/events/${id}">your event</a> from this.</p>`,
  );
  const page = await text(b, WHATS_ON_PATH);
  expect(page).not.toContain('" data-going');
  expect(page).not.toContain("You're going");
});

/** The feed again, as a server would answer it, with `edit` applied to its text. */
const servingWith =
  (edit: (feed: string) => string): PublicGet =>
  async () => ({
    status: 200,
    header: () => null,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(edit(FEED))];
        return {
          read: async () => {
            const value = chunks.shift();
            return value === undefined ? { done: true } : { done: false, value };
          },
          cancel: async () => {},
        };
      },
    },
  });

it("your event's page: the calendar's changes in its history, and its cancelling (rc59, F3b)", async () => {
  const { b, csrf, calendarId } = await following();
  const id = /^\/events\/(.+)$/.exec(
    (
      await b.request(`${WHATS_ON_PATH}/${calendarId}/going`, post({ csrf, e: "tonight" }))
    ).headers.get("location") ?? "",
  )?.[1];
  const moved = servingWith((f) => f.replace("LOCATION:Hall & bar", "LOCATION:Old Mill"));
  await refreshCalendar(b.storage, moved, calendarId, NOW);
  const page = squash(await text(b, `/events/${id}`));
  expect(page).toContain("📍 Old Mill");
  // By the name she follows it under, escaped; nobody's name, as nobody made it.
  expect(page).toContain(
    '<span class="muted">2026-11-21 12:00</span> · changed it in Swing &lt;school&gt;<ul><li>location: Hall &amp; bar → Old Mill</li></ul>',
  );
  // Nothing cancelled: nothing between the title and the time.
  expect(page).toContain("</h1> <p>2026-11-21 19:00 – 23:00 · Europe/Prague</p>");
  expect(page).not.toContain("cancelled this");
  const cancelled = servingWith((f) =>
    f.replace("LOCATION:Hall & bar", "LOCATION:Old Mill\r\nSTATUS:CANCELLED"),
  );
  await refreshCalendar(b.storage, cancelled, calendarId, NOW);
  expect(await text(b, `/events/${id}`)).toContain(
    "<p class=\"attn\">Swing &lt;school&gt; cancelled this. It's still yours: cancel or delete it if you're not going.</p>",
  );
  // Cancelled by her too: nothing more to say.
  await b.storage.query({
    sql: "UPDATE canonical_event SET status = 'cancelled' WHERE id = ?",
    params: [id ?? ""],
  });
  expect(await text(b, `/events/${id}`)).not.toContain("cancelled this");
  await b.storage.query({
    sql: "UPDATE canonical_event SET status = 'scheduled' WHERE id = ?",
    params: [id ?? ""],
  });
  // Once she stops following it, the history says "its calendar", and the page says no more.
  const following_ = await text(b, FOLLOWING_PATH);
  const followId = /action="\/following\/([^"/]+)\/stop"/.exec(following_)?.[1] ?? "";
  expect((await b.request(`${FOLLOWING_PATH}/${followId}/stop`, post({ csrf }))).status).toBe(303);
  const after = squash(await text(b, `/events/${id}`));
  expect(after).toContain("· changed it in its calendar<ul>");
  expect(after).not.toContain("cancelled this");
});
