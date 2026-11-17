// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { createEvent, findEventForParticipant } from "../../src/events/event.js";
import { issueFeedLink } from "../../src/feeds/feed.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { EVENTS_PATH } from "../../src/web/layout.js";
import { feedPath } from "../../src/web/routes/feeds.js";
import { addAccount, browser, home, post } from "../property/one-browser.js";

// "Don't put this in my calendar" (DESIGN §10 *Google Calendar, one way*, rc40; MVP-4 G3): on
// an event's page, for you only; your feed leaves the event out until you put it back.

const NOW = "2101-10-01T10:00:00.000Z";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes: a test key
const KEEP_OUT = ">Don't put this in my calendar</button>";
const PUT_BACK = ">Put it back in my calendar</button>";

async function dinner() {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const ann = (await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW })).id;
  const event = await createEvent(b.storage, {
    creatorId: ann,
    group: null,
    fields: {
      title: "Dinner",
      description: null,
      location: null,
      allDay: false,
      startLocal: "2101-11-21T18:00",
      endLocal: "2101-11-21T20:00",
      tzid: "Europe/Prague",
    },
    now: NOW,
  });
  const path = `${EVENTS_PATH}/${event.id}`;
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await issueFeedLink(b.storage, cipher, { personId: ann, groupId: null, now: NOW });
  const feed = async () => (await b.request(feedPath(token ?? ""))).text();
  const set = async (value: string) =>
    b.request(`${path}/in-calendar`, post({ csrf: (await home(b)).csrf, in: value }));
  return { b, ann, id: event.id, path, feed, set };
}

it("the event's page keeps it out of your calendar and puts it back; your feed follows", async () => {
  const f = await dinner();
  const page = await (await f.b.request(f.path)).text();
  expect(page).toContain(`action="${f.path}/in-calendar"`);
  expect(page).toContain('<input type="hidden" name="in" value="0" />');
  expect(page).toContain(KEEP_OUT);
  expect(page).toContain("Only for you: it leaves your calendar feeds and your Google Calendar.");
  expect(await f.feed()).toContain("SUMMARY:Dinner");

  const out = await f.set("0");
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe(f.path);
  const hidden = await (await f.b.request(f.path)).text();
  expect(hidden).toContain("<strong>Not in your calendar.</strong>");
  expect(hidden).toContain('<input type="hidden" name="in" value="1" />');
  expect(hidden).toContain(PUT_BACK);
  expect(hidden).not.toContain(KEEP_OUT);
  expect(await f.feed()).not.toContain("SUMMARY:Dinner");

  expect((await f.set("1")).status).toBe(303);
  expect(await (await f.b.request(f.path)).text()).toContain(KEEP_OUT);
  expect(await f.feed()).toContain("SUMMARY:Dinner");
});

it("only 0 or 1; the page writes nothing; someone not in the event can't", async () => {
  const f = await dinner();
  const writes = f.b.writes;
  await f.b.request(f.path);
  expect(f.b.writes).toBe(writes);
  const bad = await f.set("maybe");
  expect(bad.status).toBe(400);
  expect(await bad.text()).toContain("Choose one.");
  expect((await findEventForParticipant(f.b.storage, f.id, f.ann))?.participation.inCalendar).toBe(
    true,
  );
  await addAccount(f.b, "eve@example.org");
  expect((await f.set("0")).status).toBe(404);
  expect((await findEventForParticipant(f.b.storage, f.id, f.ann))?.participation.inCalendar).toBe(
    true,
  );
});
