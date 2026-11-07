// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { createEvent, findEventForParticipant, setCancelled } from "../../src/events/event.js";
import { issueFeedLink, makeSharedLink } from "../../src/feeds/feed.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { ACCOUNT_FEED_PATH, feedPath, sharedPath } from "../../src/web/routes/feeds.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { addAccount, browser, home, nameActive, post } from "../property/one-browser.js";

// GET /feed/<token>.ics (DESIGN §10 rc34): the link is the key, so it works with no
// cookie at all, never sets one and writes nothing; an unchanged feed answers 304.

const NOW = "2101-10-01T10:00:00.000Z";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes: a test key

async function withFeed() {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  await createEvent(b.storage, {
    creatorId: ann.id,
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
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await issueFeedLink(b.storage, cipher, {
    personId: ann.id,
    groupId: null,
    now: NOW,
  });
  if (token === null) throw new Error("issued");
  return { b, path: feedPath(token) };
}

it("serves the feed with no cookie, sets none, writes nothing, and keeps the link out of Referer", async () => {
  const { b, path } = await withFeed();
  const before = b.writes;
  const res = await b.request(path);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("private, max-age=900");
  const body = await res.text();
  expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(body).toContain("SUMMARY:Dinner");
  expect(body).toContain("X-WR-CALNAME:WhenDoWe\r\n");
  expect(body).toMatch(/URL:https?:\/\/[^\r]+\/events\/[0-9a-f-]+\r\n/);
  expect(b.writes).toBe(before);
});

it("an unchanged feed answers 304 to its ETag; a changed one doesn't", async () => {
  const { b, path } = await withFeed();
  const first = await b.request(path);
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  const again = await b.request(path, { headers: { "If-None-Match": etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  await b.storage.batch([
    { sql: "UPDATE canonical_event SET title = 'Lunch', revision = revision + 1", params: [] },
  ]);
  const changed = await b.request(path, { headers: { "If-None-Match": etag } });
  expect(changed.status).toBe(200);
  expect(await changed.text()).toContain("SUMMARY:Lunch");
});

it("an unknown or malformed link is 404 and cached by nobody (replaced: feeds.suite)", async () => {
  const { b, path } = await withFeed();
  for (const bad of [
    "/feed/nope.ics",
    `${path}x`,
    path.replace("/feed/", "/feed/A"),
    path.replace(".ics", ""),
    "/feed/",
  ]) {
    const res = await b.request(bad);
    expect(res.status, bad).toBe(404);
  }
  const unknown = await b.request(`/feed/${"A".repeat(43)}.ics`);
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("cache-control")).toBe("no-store");
  expect(await unknown.text()).toBe("This feed link no longer works.");
});

it("a group's feed is named for the group", async () => {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(b.storage, { name: "Rope jam", creatorId: ann.id, now: NOW });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await issueFeedLink(b.storage, cipher, {
    personId: ann.id,
    groupId: group.id,
    now: NOW,
  });
  const body = await (await b.request(feedPath(token ?? ""))).text();
  expect(body).toContain("X-WR-CALNAME:WhenDoWe · Rope jam");
});

// --- The pages that offer a link (F3) ---------------------------------------------------

const linkIn = (page: string) =>
  /https:\/\/whendowe\.example\/feed\/([A-Za-z0-9_-]{43})\.ics/.exec(page)?.[0] ?? null;

it("your account page makes a link on POST, shows it again, and replaces it", async () => {
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const b = await browser({ now: () => NOW, feedCipher: cipher });
  await addAccount(b, "ann@example.org");
  const before = b.writes;
  const empty = await (await b.request("/account")).text();
  expect(b.writes).toBe(before); // looking makes nothing
  expect(empty).toContain("Your calendar feed");
  expect(empty).toContain(`action="${ACCOUNT_FEED_PATH}"`);
  expect(linkIn(empty)).toBeNull();
  expect(empty).toContain("Make a feed link");
  expect(empty).not.toContain("Make a new link");
  expect(empty).toContain("Every event you&#39;re in, in your own calendar app");

  const { csrf } = await home(b);
  expect((await b.request(ACCOUNT_FEED_PATH, post({}))).status).toBe(403); // no CSRF, no link
  const signedOut = b.another();
  const out = await signedOut.request(ACCOUNT_FEED_PATH, post({ csrf }));
  expect(out.headers.get("location") ?? "").not.toBe("/account#feed"); // to sign-in instead
  const made = await b.request(ACCOUNT_FEED_PATH, post({ csrf }));
  expect(made.status).toBe(303);
  expect(made.headers.get("location")).toBe("/account#feed");
  const page = await (await b.request("/account")).text();
  const link = linkIn(page);
  expect(link).not.toBeNull();
  expect(page).toContain(`href="${link?.replace("https:", "webcal:")}"`);
  expect(page).toContain(
    `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(link?.replace("https:", "webcal:") ?? "")}`,
  );
  expect(page).toContain("Google Calendar checks a feed every few hours");
  expect(page).toContain("data-copy");
  expect(page).toContain('aria-label="Feed link"');
  expect(page).toContain("Make a new link");
  expect(page).not.toContain('<button type="button" data-share-sheet'); // a secret: Copy, never Share…
  expect((await b.request(new URL(link ?? "").pathname)).status).toBe(200);
  expect(await (await b.request("/account")).text()).toContain(link ?? "?"); // shown again

  await b.request(ACCOUNT_FEED_PATH, post({ csrf }));
  const replaced = linkIn(await (await b.request("/account")).text());
  expect(replaced).not.toBe(link);
  expect((await b.request(new URL(link ?? "").pathname)).status).toBe(404);
});

it("a group's page offers its feed to members; a stranger can't make one", async () => {
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const b = await browser({ now: () => NOW, feedCipher: cipher });
  await addAccount(b, "ann@example.org");
  const res = await b.request(GROUPS_PATH, post({ csrf: (await home(b)).csrf, name: "Rope jam" }));
  const group = res.headers.get("location") ?? "";
  const groupPage = await (await b.request(group)).text();
  expect(groupPage).toContain(`action="${group}/feed"`);
  expect(groupPage).toContain("These events in your calendar");
  expect(groupPage).toContain("The events made in this group that you&#39;re in");
  expect((await b.request(`${group}/feed`, post({}))).status).toBe(403); // no CSRF
  const made = await b.request(`${group}/feed`, post({ csrf: (await home(b)).csrf }));
  expect(made.headers.get("location")).toBe(`${group}#feed`);
  const link = linkIn(await (await b.request(group)).text());
  const body = await (await b.request(new URL(link ?? "").pathname)).text();
  expect(body).toContain("X-WR-CALNAME:WhenDoWe · Rope jam");

  const stranger = b.another();
  await addAccount(stranger, "eve@example.org");
  const refused = await stranger.request(
    `${group}/feed`,
    post({ csrf: (await home(stranger)).csrf }),
  );
  expect(refused.status).toBe(404);
});

it("without a key the pages say feeds aren't set up, and there is nothing to POST to", async () => {
  const b = await browser({ now: () => NOW });
  await addAccount(b, "ann@example.org");
  const page = await (await b.request("/account")).text();
  expect(page).toContain("Calendar feeds aren't set up on this server.");
  expect(page).not.toContain(`action="${ACCOUNT_FEED_PATH}"`);
  expect((await b.request(ACCOUNT_FEED_PATH, post({ csrf: (await home(b)).csrf }))).status).toBe(
    404,
  );
});

// --- A group calendar link's page and feed (rc36) --------------------------------------

async function sharedFixture(tier: "DETAILS" | "BUSY") {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(b.storage, { name: "Rope jam", creatorId: ann.id, now: NOW });
  const membership = await findGroupForMember(b.storage, group.id, ann.id);
  await createEvent(b.storage, {
    creatorId: ann.id,
    group: membership,
    fields: {
      title: "Jam night",
      description: "SECRET-NOTE",
      location: "The hall",
      allDay: false,
      startLocal: "2101-11-21T18:00",
      endLocal: "2101-11-21T20:00",
      tzid: "Europe/Prague",
    },
    now: NOW,
  });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token = await makeSharedLink(b.storage, cipher, {
    groupId: group.id,
    organizerId: ann.id,
    label: "Grandparents",
    tier,
    now: NOW,
  });
  if (token === null) throw new Error("made");
  return { b, token };
}

it("a group calendar link's page: what's coming, for anyone, naming nobody, found by nobody", async () => {
  const { b, token } = await sharedFixture("DETAILS");
  const before = b.writes;
  const res = await b.request(sharedPath(token));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const page = await res.text();
  expect(page).toContain("<h1>Rope jam</h1>");
  expect(page).toContain("Jam night");
  expect(page).toContain("The hall");
  expect(page).toContain("Mon 21 Nov, 18:00–20:00 · Europe/Prague");
  for (const hidden of ["SECRET-NOTE", "ann", "Grandparents", "/events/"])
    expect(page, hidden).not.toContain(hidden);
  // The card in a chat names the group, never an event.
  expect(page).toContain('<meta property="og:title" content="Rope jam"');
  expect(page).not.toMatch(/<meta property="og:[a-z]+" content="[^"]*Jam night/);
  const webcal = `webcal://whendowe.example${sharedPath(token, true)}`;
  expect(page).toContain(`href="${webcal}"`);
  expect(page).toContain(encodeURIComponent(webcal));
  expect(b.writes).toBe(before);
});

it("a busy-only link shows the time and nothing else; its feed is the same, with an ETag", async () => {
  const { b, token } = await sharedFixture("BUSY");
  const page = await (await b.request(sharedPath(token))).text();
  expect(page).toContain("<strong>Busy</strong>");
  expect(page).toContain("when they&#39;re busy, not what with");
  for (const hidden of ["Jam night", "The hall", "SECRET-NOTE"]) expect(page).not.toContain(hidden);
  const feed = await b.request(sharedPath(token, true));
  expect(feed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  const body = await feed.text();
  expect(body).toContain("SUMMARY:Busy");
  expect(body).toContain("X-WR-CALNAME:Rope jam\r\n");
  expect(body).not.toContain("URL:");
  const etag = feed.headers.get("etag") ?? "";
  expect(
    (await b.request(sharedPath(token, true), { headers: { "If-None-Match": etag } })).status,
  ).toBe(304);
});

it("an unknown link, or a feed link at /c, is a 404 page", async () => {
  const { b } = await sharedFixture("DETAILS");
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const own = await issueFeedLink(b.storage, cipher, { personId: ann.id, groupId: null, now: NOW });
  for (const bad of [
    sharedPath("A".repeat(43)),
    sharedPath(own ?? ""),
    "/c/nope",
    `/c/x${"A".repeat(43)}`,
  ]) {
    const res = await b.request(bad);
    expect(res.status, bad).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("This link no longer works");
    expect(body).toMatch(/<title>[^<]*Link no longer works/);
  }
});

it("the page lists what's coming: not the past, repeats marked, cancelled said, places only where set", async () => {
  const b = await browser({ now: () => NOW }); // 2101-10-01
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(b.storage, { name: "Rope jam", creatorId: ann.id, now: NOW });
  const membership = await findGroupForMember(b.storage, group.id, ann.id);
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const token =
    (await makeSharedLink(b.storage, cipher, {
      groupId: group.id,
      organizerId: ann.id,
      label: "Grandparents",
      tier: "DETAILS",
      now: NOW,
    })) ?? "";
  const empty = await b.request(sharedPath(token));
  expect(empty.headers.get("cache-control")).toBe("private, no-cache");
  const emptyPage = await empty.text();
  expect(emptyPage).toContain("Nothing coming up.");
  expect(emptyPage).toContain("What's coming, shared by its organizers.</p>");
  expect(emptyPage).toContain(
    '<meta property="og:description" content="What&#39;s coming, shared by its organizers."',
  );
  const event = (title: string, fields: Record<string, unknown>) =>
    createEvent(b.storage, {
      creatorId: ann.id,
      group: membership,
      fields: {
        title,
        description: null,
        location: null,
        allDay: false,
        startLocal: "2101-10-05T18:00",
        endLocal: "2101-10-05T20:00",
        tzid: "Europe/Prague",
        ...fields,
      },
      now: NOW,
    });
  await event("Last month", { startLocal: "2101-09-05T18:00", endLocal: "2101-09-05T20:00" });
  await event("Ends today", { startLocal: "2101-09-30T22:00", endLocal: "2101-10-01T01:00" });
  await event("Weekly since summer", {
    startLocal: "2101-07-05T18:00",
    endLocal: "2101-07-05T20:00",
    rrule: "FREQ=WEEKLY",
  });
  await event("Picnic", {
    allDay: true,
    startLocal: "2101-10-10",
    endLocal: "2101-10-11",
    tzid: null,
    location: "The park",
  });
  const off = await event("Called off", {});
  const offAccess = await findEventForParticipant(b.storage, off.id, ann.id);
  if (offAccess === null) throw new Error("access");
  await setCancelled(b.storage, offAccess, { cancelled: true, now: NOW });

  const page = await (await b.request(sharedPath(token))).text();
  expect(page).not.toContain("Last month");
  expect(page).not.toContain("Nothing coming up.");
  expect(page).not.toContain("busy, not what with");
  const item = (title: string) => {
    const at = page.indexOf(`<strong>${title}</strong>`);
    expect(at, title).toBeGreaterThan(-1);
    return page.slice(at, page.indexOf("</li>", at));
  };
  expect(item("Ends today")).toContain("Europe/Prague");
  expect(item("Weekly since summer")).toContain(" · repeats");
  expect(item("Ends today")).not.toContain("repeats");
  expect(item("Called off")).toContain("(cancelled)");
  expect(item("Ends today")).not.toContain("(cancelled)");
  expect(item("Picnic")).toContain("📍 The park");
  expect(item("Picnic")).not.toContain("Europe/Prague"); // all day has no zone
  expect(item("Ends today")).not.toContain("📍");
  // Whole lines, so no part prints anything where it should print nothing.
  expect(item("Ends today")).toMatch(
    /^<strong>Ends today<\/strong><br \/><span class="muted">[^<·]+ · Europe\/Prague<\/span>$/,
  );
  expect(item("Picnic")).toMatch(
    /^<strong>Picnic<\/strong><br \/><span class="muted">[^<·]+, all day · 📍 The park<\/span>$/,
  );
  expect(item("Weekly since summer")).toMatch(
    /^<strong>Weekly since summer<\/strong><br \/><span class="muted">[^<·]+ · Europe\/Prague · repeats<\/span>$/,
  );
});

it("a link's label is short and says who it's for", async () => {
  const b = await browser({ now: () => NOW });
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(b.storage, { name: "Rope jam", creatorId: ann.id, now: NOW });
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  await expect(
    makeSharedLink(b.storage, cipher, {
      groupId: group.id,
      organizerId: ann.id,
      label: "x".repeat(41),
      tier: "BUSY",
      now: NOW,
    }),
  ).rejects.toThrow("Keep it under 40 characters.");
});

// --- The group page's calendar links (rc36, U3) ----------------------------------------

async function groupWithMember(feedCipher?: Awaited<ReturnType<typeof createTokenCipher>>) {
  const b = await browser({ now: () => NOW, ...(feedCipher === undefined ? {} : { feedCipher }) });
  await addAccount(b, "ann@example.org");
  await nameActive(b, "ann@example.org");
  const made = await b.request(GROUPS_PATH, post({ csrf: (await home(b)).csrf, name: "Rope jam" }));
  const group = made.headers.get("location") ?? "";
  const ann = await findOrCreatePerson(b.storage, "ann@example.org", { now: NOW });
  const membership = await findGroupForMember(b.storage, group.split("/").at(-1) ?? "", ann.id);
  if (membership === null) throw new Error("membership");
  const invite = await createInvite(b.storage, membership, {
    email: "bob@example.org",
    invitedBy: ann.id,
    editTier: "view",
    visibility: "FULL",
    now: NOW,
  });
  if (!invite.ok) throw new Error(invite.reason);
  await acceptInvite(b.storage, invite.token, NOW);
  const bob = b.another();
  await addAccount(bob, "bob@example.org");
  await nameActive(bob, "bob@example.org");
  return { b, bob, group };
}

const sharedLinkIn = (page: string) =>
  /https:\/\/whendowe\.example\/c\/[A-Za-z0-9_-]{43}/.exec(page)?.[0] ?? null;

it("an organizer makes, replaces and stops calendar links; every member sees that they exist", async () => {
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const { b, bob, group } = await groupWithMember(cipher);
  const before = await (await b.request(group)).text();
  expect(before).toContain("Shared with people outside the group");
  expect(before).toContain("Nobody outside the group can see its calendar.");
  expect(before).toContain(`action="${group}/shared"`);
  expect(await (await bob.request(group)).text()).toContain(
    "Nobody outside the group can see its calendar.",
  );

  const csrf = (await home(b)).csrf;
  const made = await b.request(
    `${group}/shared`,
    post({ csrf, label: "Grandparents", tier: "DETAILS" }),
  );
  expect(made.status).toBe(303);
  expect(made.headers.get("location")).toBe(`${group}#shared`);
  await b.request(`${group}/shared`, post({ csrf, label: "Babysitter", tier: "BUSY" }));
  const page = await (await b.request(group)).text();
  expect(page).toContain("<strong>Grandparents</strong> · details");
  expect(page).toContain("<strong>Babysitter</strong> · busy only");
  expect(page).toMatch(
    /<strong>Grandparents<\/strong> · details <span class="muted">· 2101-10-01, made by ann<\/span>/,
  );
  expect(page).toContain(`action="${group}/shared/replace"`);
  expect(page).toContain(`action="${group}/shared/stop"`);
  expect(page).toMatch(/<button type="submit">New link<\/button>/);
  const link = sharedLinkIn(page);
  expect(link).not.toBeNull();
  expect((await b.request(new URL(link ?? "").pathname)).status).toBe(200);
  expect(page).toContain('aria-label="Link for Grandparents"');

  // Bob, a member, sees that they exist and who they're for, but not the links or the buttons.
  const asBob = await (await bob.request(group)).text();
  expect(asBob).toContain("<strong>Grandparents</strong> · details");
  expect(sharedLinkIn(asBob)).toBeNull();
  expect(asBob).not.toContain("Link for");
  expect(asBob).not.toContain("/c/");
  expect(asBob).not.toContain("New link");
  expect(asBob).not.toContain(`action="${group}/shared`);
  const hash = /name="link" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const bobCsrf = (await home(bob)).csrf;
  for (const [path, fields] of [
    [`${group}/shared`, { label: "Mine", tier: "DETAILS" }],
    [`${group}/shared/replace`, { link: hash }],
    [`${group}/shared/stop`, { link: hash }],
  ] as const) {
    const res = await bob.request(path, post({ csrf: bobCsrf, ...fields }));
    expect(res.status, path).toBe(403);
    expect(await res.text()).toBe("Only the group's organizers share its calendar.");
  }
  expect((await b.request(`${group}/shared`, post({ label: "x", tier: "DETAILS" }))).status).toBe(
    403,
  );

  // New link: the old one is dead. Stop sharing: gone.
  const replaced = await b.request(`${group}/shared/replace`, post({ csrf, link: hash }));
  expect(replaced.status).toBe(303);
  expect((await b.request(new URL(link ?? "").pathname)).status).toBe(404);
  const after = await (await b.request(group)).text();
  const newHash = /name="link" value="([^"]+)"/.exec(after)?.[1] ?? "";
  expect(newHash).not.toBe(hash);
  expect((await b.request(`${group}/shared/stop`, post({ csrf, link: hash }))).status).toBe(409);
  expect((await b.request(`${group}/shared/replace`, post({ csrf, link: hash }))).status).toBe(409);
  for (const h of [
    ...after.matchAll(/name="link" value="([^"]+)" \/>\s*<button type="submit">Stop sharing/g),
  ])
    await b.request(`${group}/shared/stop`, post({ csrf, link: h[1] ?? "" }));
  expect(await (await b.request(group)).text()).toContain(
    "Nobody outside the group can see its calendar.",
  );
});

it("refuses a link with no label or tier, and from someone outside the group", async () => {
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const { b, group } = await groupWithMember(cipher);
  const csrf = (await home(b)).csrf;
  for (const fields of [
    { label: "  ", tier: "DETAILS" },
    { label: "Grandparents", tier: "FULL" },
  ]) {
    const res = await b.request(`${group}/shared`, post({ csrf, ...fields }));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("That link isn't this group's.");
  }
  const eve = b.another();
  await addAccount(eve, "eve@example.org");
  const res = await eve.request(
    `${group}/shared`,
    post({ csrf: (await home(eve)).csrf, label: "Mine", tier: "DETAILS" }),
  );
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not found");
});

it("when the organizer leaves, the page says who made a link and who keeps it now", async () => {
  const cipher = await createTokenCipher([{ id: 1, material: KEY }], 1);
  const { b, bob, group } = await groupWithMember(cipher);
  await b.request(
    `${group}/shared`,
    post({ csrf: (await home(b)).csrf, label: "Grandparents", tier: "DETAILS" }),
  );
  await b.request(`${group}/leave`, post({ csrf: (await home(b)).csrf }));
  const page = await (await bob.request(group)).text();
  // Ann has left: the group page names only its members, so she is a former member (rc21).
  expect(page).toContain("made by a former member, now kept by bob");
  expect(sharedLinkIn(page)).not.toBeNull(); // Bob is the organizer now: he sees it
});

it("without a key: organizers are told links aren't set up; members see nothing", async () => {
  const { b, bob, group } = await groupWithMember();
  expect(await (await b.request(group)).text()).toContain(
    "Calendar links aren't set up on this server.",
  );
  expect(await (await bob.request(group)).text()).not.toContain("Shared with people outside");
});
