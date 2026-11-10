// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createEvent, findEventForParticipant, setCancelled } from "../../src/events/event.js";
import { MAX_BUSY_DAYS } from "../../src/feeds/busy.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createPollThread, startDraft } from "../../src/plans/plan.js";
import { findThreadForMember } from "../../src/plans/thread.js";
import { issueVoteLinks } from "../../src/plans/vote-link.js";
import { BUSY_PATH } from "../../src/web/layout.js";
import { PLANS_PATH } from "../../src/web/routes/plans.js";
import { VOTE_PATH } from "../../src/web/routes/respond.js";
import { SHARE_PATH } from "../../src/web/routes/share.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// GET /busy (DESIGN §10 rc41): when the signed-in asker is already committed, for the
// picker to shade. The feed's set (rc34), times only, in the asker's zone; it writes
// nothing and needs a session.

const NOW = "2101-10-01T10:00:00.000Z";

interface Times {
  readonly allDay?: boolean;
  readonly start: string;
  readonly end: string;
  readonly tzid?: string | null;
  readonly rrule?: string;
}

async function event(storage: StoragePort, creatorId: string, t: Times, title = "Dinner") {
  return createEvent(storage, {
    creatorId,
    group: null,
    fields: {
      title,
      description: "Bring the good cheese",
      location: "Ann's place",
      allDay: t.allDay ?? false,
      startLocal: t.start,
      endLocal: t.end,
      tzid: t.allDay === true ? null : (t.tzid ?? "Europe/Prague"),
      rrule: t.rrule ?? null,
    },
    now: NOW,
  });
}

async function signedIn(): Promise<{ b: Browser; ann: string }> {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  return { b, ann: ann.id };
}

const ask = (from: string, to: string, tz: string, except?: string) =>
  `${BUSY_PATH}?${new URLSearchParams({ from, to, tz, ...(except === undefined ? {} : { except }) })}`;

async function busy(b: Browser, path: string): Promise<unknown> {
  const res = await b.request(path);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json();
}

describe("who may ask", () => {
  it("signed out: 401 and nothing, never a redirect", async () => {
    const b = await browser({ now: () => NOW });
    const res = await b.request(ask("2101-11-01", "2101-11-30", "Europe/Prague"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ busy: [] });
  });

  it("a malformed question: 400 and nothing", async () => {
    const { b } = await signedIn();
    const bad = [
      `${BUSY_PATH}?from=2101-11-01&to=2101-11-30`, // no zone
      ask("2101-11-01", "2101-11-30", "Mars/Olympus"),
      ask("2101-11-1", "2101-11-30", "UTC"),
      ask("2101-02-30", "2101-03-02", "UTC"),
      ask("2101-11-30", "2101-11-01", "UTC"), // backwards
      ask("2101-11-01", "2101-11-01T10:00", "UTC"),
      ask("2101-11-01", "2101-11-01", "x".repeat(65)),
    ];
    for (const path of bad) {
      const res = await b.request(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ busy: [] });
    }
  });

  it(`asks for at most ${MAX_BUSY_DAYS} days at once`, async () => {
    const { b } = await signedIn();
    expect((await b.request(ask("2101-11-01", "2101-11-01", "UTC"))).status).toBe(200); // one day
    expect((await b.request(ask("2101-11-01", "2102-01-01", "UTC"))).status).toBe(200); // 62
    expect((await b.request(ask("2101-11-01", "2102-01-02", "UTC"))).status).toBe(400); // 63
  });
});

describe("what you're busy with", () => {
  it("times only, in the asker's zone, and it writes nothing", async () => {
    const { b, ann } = await signedIn();
    await event(b.storage, ann, { start: "2101-11-21T18:00", end: "2101-11-21T20:00" });
    const before = b.writes;
    const london = await b.request(ask("2101-11-01", "2101-11-30", "Europe/London"));
    const text = await london.text();
    expect(JSON.parse(text)).toEqual({
      busy: [{ allDay: false, start: "2101-11-21T17:00", end: "2101-11-21T19:00" }],
    });
    for (const secret of ["Dinner", "cheese", "Ann", "/events/"])
      expect(text).not.toContain(secret);
    expect(await busy(b, ask("2101-11-01", "2101-11-30", "Europe/Prague"))).toEqual({
      busy: [{ allDay: false, start: "2101-11-21T18:00", end: "2101-11-21T20:00" }],
    });
    expect(b.writes).toBe(before);
  });

  it("all-day events are the same days everywhere, the last one included", async () => {
    const { b, ann } = await signedIn();
    await event(b.storage, ann, { allDay: true, start: "2101-11-25", end: "2101-11-28" });
    const want = { busy: [{ allDay: true, from: "2101-11-25", to: "2101-11-27" }] };
    expect(await busy(b, ask("2101-11-01", "2101-11-30", "Pacific/Auckland"))).toEqual(want);
    expect(await busy(b, ask("2101-11-27", "2101-11-27", "America/New_York"))).toEqual(want);
    expect(await busy(b, ask("2101-11-28", "2101-11-30", "UTC"))).toEqual({ busy: [] });
    expect(await busy(b, ask("2101-11-01", "2101-11-24", "UTC"))).toEqual({ busy: [] });
  });

  it("a series counts each time it happens within the range, and only those", async () => {
    const { b, ann } = await signedIn();
    // Mondays from 2101-10-31 (a Monday), 19:00 Prague.
    await event(b.storage, ann, {
      start: "2101-10-31T19:00",
      end: "2101-10-31T21:00",
      rrule: "FREQ=WEEKLY",
    });
    await event(b.storage, ann, {
      allDay: true,
      start: "2101-11-02",
      end: "2101-11-03",
      rrule: "FREQ=WEEKLY;COUNT=2",
    });
    expect(await busy(b, ask("2101-11-08", "2101-11-21", "Europe/Prague"))).toEqual({
      busy: [
        { allDay: false, start: "2101-11-14T19:00", end: "2101-11-14T21:00" },
        { allDay: false, start: "2101-11-21T19:00", end: "2101-11-21T21:00" },
        { allDay: true, from: "2101-11-09", to: "2101-11-09" },
      ],
    });
  });

  it("the range is whole days in the asker's zone: what touches it counts, what doesn't, doesn't", async () => {
    const { b, ann } = await signedIn();
    // 23:00–01:00 UTC on the night of the 9th to the 10th.
    await event(b.storage, ann, {
      start: "2101-11-09T23:00",
      end: "2101-11-10T01:00",
      tzid: "UTC",
    });
    // Ends exactly as the range starts, and starts exactly as it ends: neither counts.
    await event(b.storage, ann, {
      start: "2101-11-09T22:00",
      end: "2101-11-10T00:00",
      tzid: "UTC",
    });
    await event(b.storage, ann, {
      start: "2101-11-11T00:00",
      end: "2101-11-11T01:00",
      tzid: "UTC",
    });
    expect(await busy(b, ask("2101-11-10", "2101-11-10", "UTC"))).toEqual({
      busy: [{ allDay: false, start: "2101-11-09T23:00", end: "2101-11-10T01:00" }],
    });
    // In Prague (UTC+1) the 10th runs from 23:00 UTC on the 9th, so the one that ended
    // at midnight UTC now touches it, and the one at midnight on the 11th still doesn't.
    expect(await busy(b, ask("2101-11-10", "2101-11-10", "Europe/Prague"))).toEqual({
      busy: [
        { allDay: false, start: "2101-11-09T23:00", end: "2101-11-10T01:00" },
        { allDay: false, start: "2101-11-10T00:00", end: "2101-11-10T02:00" },
      ],
    });
  });

  it("not: cancelled events, the event being edited, or other people's", async () => {
    const { b, ann } = await signedIn();
    const bob = await findOrCreatePerson(b.storage, "bob@example.org", { now: NOW });
    await event(b.storage, bob.id, { start: "2101-11-20T10:00", end: "2101-11-20T11:00" });
    const off = await event(b.storage, ann, { start: "2101-11-21T10:00", end: "2101-11-21T11:00" });
    const access = await findEventForParticipant(b.storage, off.id, ann);
    if (access === null) throw new Error("ann's event");
    expect((await setCancelled(b.storage, access, { cancelled: true, now: NOW })).kind).not.toBe(
      "forbidden",
    );
    const editing = await event(b.storage, ann, {
      start: "2101-11-22T10:00",
      end: "2101-11-22T11:00",
    });
    const kept = { allDay: false, start: "2101-11-22T10:00", end: "2101-11-22T11:00" };
    expect(await busy(b, ask("2101-11-01", "2101-11-30", "Europe/Prague"))).toEqual({
      busy: [kept],
    });
    expect(await busy(b, ask("2101-11-01", "2101-11-30", "Europe/Prague", editing.id))).toEqual({
      busy: [],
    });
  });
});

describe("the forms ask", () => {
  it("a new event and a new poll point the picker here; editing leaves that event out", async () => {
    const { b, ann } = await signedIn();
    const newEvent = await (await b.request("/events/new")).text();
    expect(newEvent).toContain(`data-picker="event" data-busy="${BUSY_PATH}">`);
    const newPoll = await (await b.request("/polls/new")).text();
    expect(newPoll).toMatch(/data-picker="poll" data-max="\d+" data-busy="\/busy">/);
    const e = await event(b.storage, ann, { start: "2101-11-22T10:00", end: "2101-11-22T11:00" });
    const edit = await (await b.request(`/events/${e.id}/edit`)).text();
    expect(edit).toContain(`data-busy="${BUSY_PATH}" data-busy-except="${e.id}">`);
  });
});

// The plan pages and voting (B1b): the page says where to ask and in the thread's zone,
// and each option carries its events for the script to compare. Only when the person
// signed in is the one choosing — never a guest, and never on someone else's vote link.

const ON = 'data-busy="/busy" data-busy-tz="Europe/Prague"';
const SCRIPT = "globalThis.WhenDoWePlanBusy";

/** Ann's poll of two evenings, with Bob in it; Ann signed in. */
async function poll() {
  const { b, ann } = await signedIn();
  const bob = await findOrCreatePerson(b.storage, "bob@example.org", { now: NOW });
  const { threadId, planIds } = await createPollThread(b.storage, {
    creatorId: ann,
    group: null,
    fields: {
      title: "Dinner",
      location: null,
      description: null,
      allDay: false,
      tzid: "Europe/Prague",
    },
    candidates: [
      { startLocal: "2101-11-21T18:00", endLocal: "2101-11-21T20:00" },
      { startLocal: "2101-11-22T18:00", endLocal: "2101-11-22T20:00" },
    ],
    people: [bob.id],
    now: NOW,
  });
  const as = async (id: string) => {
    const a = await findThreadForMember(b.storage, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  return { b, ann, bob: bob.id, threadId, planIds, as };
}

const text = async (b: Browser, path: string) => {
  const res = await b.request(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

describe("plans and voting ask too", () => {
  it("a plan's page, its day sheet and your draft: in the thread's zone; the thread page doesn't", async () => {
    const f = await poll();
    const [first] = f.planIds;
    const plan = await text(f.b, `${PLANS_PATH}/${f.threadId}/p/${first}`);
    expect(plan).toContain(`<div class="pl" ${ON}>`);
    expect(plan).toContain(SCRIPT);
    expect(plan).toContain(
      '<p class="clash" data-busy-spans="t:2101-11-21T18:00/2101-11-21T20:00" hidden></p>',
    );
    const day = await text(f.b, `${PLANS_PATH}/${f.threadId}/p/${first}?day=2101-11-21`);
    expect(day).toContain('<p class="small clash" data-busy-day="2101-11-21" hidden></p>');

    const started = await startDraft(f.b.storage, await f.as(f.ann), {
      fromId: null,
      rest: false,
      replace: false,
      now: NOW,
    });
    expect(started.kind).not.toBe("has_draft");
    const draft = await text(f.b, `${PLANS_PATH}/${f.threadId}/draft?day=2101-11-23`);
    expect(draft).toContain(`<div class="pl" ${ON}>`);
    expect(draft).toContain('data-busy-day="2101-11-23"');
    expect(draft).toContain(SCRIPT);

    const thread = await text(f.b, `${PLANS_PATH}/${f.threadId}`);
    expect(thread).not.toContain("data-busy");
    expect(thread).not.toContain(SCRIPT);
  });

  it("a vote link: only when the one signed in is the one it's for", async () => {
    const f = await poll();
    const issued = await issueVoteLinks(f.b.storage, await f.as(f.ann), { now: NOW });
    if (issued.kind !== "issued") throw new Error(issued.kind);
    const token = issued.links.find((l) => l.personId === f.bob)?.token ?? "";
    const link = `${VOTE_PATH}?t=${encodeURIComponent(token)}`;
    const spans = 'data-busy-spans="t:2101-11-21T18:00/2101-11-21T20:00"';

    // Ann is signed in on this browser: Bob's link must not show Ann's busy times.
    const asAnn = await text(f.b, link);
    expect(asAnn).toContain(spans); // the options always carry their times; nothing asks
    expect(asAnn).not.toContain("data-busy=");
    expect(asAnn).not.toContain(SCRIPT);
    const nobody = await text(f.b.another(), link);
    expect(nobody).not.toContain("data-busy=");
    expect(nobody).not.toContain(SCRIPT);

    await addAccount(f.b, "bob@example.org"); // Bob, now the account in use
    const asBob = await text(f.b, link);
    expect(asBob).toContain(`<div class="pl" ${ON}>`);
    expect(asBob).toContain(SCRIPT);
    expect(asBob).toContain(
      `<strong>Mon 21 Nov, 18:00–20:00</strong><span class="clash" ${spans} hidden></span>`,
    );
    // A refused POST shows the page again, still for Bob.
    const refused = await f.b.request(VOTE_PATH, post({ t: token }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(ON);
  });

  it("a shared link: for an account answering as itself, never for a guest", async () => {
    const f = await poll();
    const { csrf } = await home(f.b);
    const shared = await (
      await f.b.request(`${PLANS_PATH}/${f.threadId}/share`, post({ csrf }))
    ).text();
    const path = /(\/s\?t=[^\s<"]+)/.exec(shared)?.[1] ?? "";
    expect(path.startsWith(`${SHARE_PATH}?t=`)).toBe(true);
    const asAnn = await text(f.b, path);
    expect(asAnn).toContain(`<div class="pl" ${ON}>`);
    expect(asAnn).toContain(SCRIPT);
    const guest = await text(f.b.another(), path);
    expect(guest).not.toContain("data-busy=");
    expect(guest).not.toContain(SCRIPT);
  });
});
