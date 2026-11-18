// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { stmt } from "../../src/db/port.js";
import { GOOGLE_CALENDARS_URL } from "../../src/oauth/primary-calendar.js";
import { SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { DISCONNECT_PATH } from "../../src/web/routes/oauth.js";
import { form, harness, MADE_ID, NOW, OWN_ID, REFRESH } from "./google-harness.js";

// Disconnecting Google Calendar (DESIGN §10 *Google Calendar, one way*, rc40; MVP-4 G3): a
// page asks what to do with the copies — Remove them, Keep them, and for a calendar WhenDoWe
// made, Delete the WhenDoWe calendar — and either way the grant goes back to Google and the
// tokens are deleted. Removing is the push tick's (push-tick.suite.ts); here, the pages.

const ASK = "Also remove the 2 WhenDoWe events from your Google calendar?";
const REMOVING = "WhenDoWe is removing its events from your Google calendar";

const title = (t: string) => `<h1>${t}</h1>`;
const button = (value: string, label: string) =>
  `<button type="submit" name="copies" value="${value}">${label}</button>`;

it("home links to the page, which asks about the copies and asks Google nothing", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await h.page("/")).toContain(`<a href="${DISCONNECT_PATH}">Disconnect</a>`);
  const before = h.log.length;
  const res = await h.get(DISCONNECT_PATH);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain(title("Disconnect Google Calendar"));
  expect(text).toContain(`<form method="post" action="${DISCONNECT_PATH}">`);
  expect(text).toContain(ASK); // the one already deleted in Google isn't counted
  expect(text).toContain(button("remove", "Remove them"));
  expect(text).toContain(button("keep", "Keep them"));
  expect(text).toContain(button("calendar", "Delete the WhenDoWe calendar"));
  expect(text).toContain("Either way, WhenDoWe gives its access back to Google and forgets it.");
  expect(h.log.length).toBe(before); // Google isn't asked
  expect((await h.connection())?.status).toBe("active");
});

it("a calendar of your own is never offered for deletion; one copy is one event; none, nothing asked", async () => {
  const h = await harness();
  await h.connect(OWN_ID);
  await h.copies(1);
  const one = await h.page(DISCONNECT_PATH);
  expect(one).toContain("Also remove the 1 WhenDoWe event from your Google calendar?");
  expect(one).toContain(
    `<p>${button("remove", "Remove them")} ${button("keep", "Keep them")} </p>`,
  );
  expect((await h.leave("calendar")).status).toBe(409);
  expect(await h.count("calendar_connection")).toBe(1);
  expect(h.log.some((c) => c.method === "DELETE")).toBe(false);

  const g = await harness();
  await g.connect();
  const none = await g.page(DISCONNECT_PATH);
  expect(none).toContain("None of your WhenDoWe events are in your Google calendar.");
  expect(none).toContain(button("keep", "Disconnect"));
  expect(none).toContain(button("calendar", "Delete the WhenDoWe calendar"));
  expect(none).not.toContain('value="remove"');
});

it("Keep them: the grant goes back to Google and the connection is forgotten; the copies stay", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await h.count("busy_calendar")).toBe(1);
  const res = await h.leave("keep");
  expect(res.status).toBe(200);
  const kept = await res.text();
  expect(kept).toContain(title("Disconnected"));
  expect(kept).toContain(
    "Google Calendar is disconnected. The 2 WhenDoWe events there stay, and are no longer updated.",
  );
  expect(h.revokes()).toEqual([new URLSearchParams({ token: REFRESH }).toString()]);
  expect(await h.count("calendar_connection")).toBe(0);
  expect(await h.count("projection")).toBe(0);
  expect(await h.count("busy_calendar")).toBe(0);
  expect(h.log.some((c) => c.method === "DELETE")).toBe(false);
  const home = await h.page("/");
  expect(home).toContain(">Connect Google Calendar</button>");
  expect(home).not.toContain(DISCONNECT_PATH);
  for (const res of [await h.get(DISCONNECT_PATH), await h.leave("keep")]) {
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain(title("Disconnect"));
    expect(text).toContain("No Google Calendar is connected.");
  }

  // With nothing in Google, nothing is said to stay.
  const g = await harness();
  await g.connect();
  expect(await (await g.leave("keep")).text()).toContain("<p>Google Calendar is disconnected.</p>");
});

it("Remove them: the connection is marked for the tick, its busy times stop, Google isn't called yet", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const calls = h.log.length;
  const res = await h.leave("remove");
  expect(res.status).toBe(200);
  const removing = await res.text();
  expect(removing).toContain(title("Disconnecting"));
  expect(removing).toContain(REMOVING);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(await h.count("busy_calendar")).toBe(0);
  expect(await h.count("projection")).toBe(4); // the tick's to go through
  expect(h.log.length).toBe(calls);
  expect(await h.page("/")).toContain(
    "Disconnecting Google Calendar: removing your WhenDoWe events from it.",
  );
  const again = await h.page(DISCONNECT_PATH);
  expect(again).toContain(title("Disconnecting"));
  expect(again).toContain(REMOVING);
  // Pressed again, or another choice from a stale page: still just removing.
  const stale = await (await h.leave("keep")).text();
  expect(stale).toContain(title("Disconnecting"));
  expect(stale).toContain(REMOVING);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(h.revokes()).toEqual([]);
});

it("Delete the WhenDoWe calendar: one call to Google, then the grant goes back and it's forgotten", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const res = await h.leave("calendar");
  expect(res.status).toBe(200);
  const deleted = await res.text();
  expect(deleted).toContain(title("Disconnected"));
  expect(deleted).toContain("Google Calendar is disconnected, and the WhenDoWe calendar deleted.");
  const deletes = h.log.filter((c) => c.method === "DELETE");
  expect(deletes).toEqual([
    {
      url: `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(MADE_ID)}`,
      method: "DELETE",
      body: undefined,
      auth: "Bearer ya29.access",
    },
  ]);
  expect(h.revokes()).toHaveLength(1);
  expect(await h.count("calendar_connection")).toBe(0);
  expect(await h.count("projection")).toBe(0);
});

it("a WhenDoWe calendar already gone counts as deleted; Google failing changes nothing", async () => {
  for (const deleteStatus of [404, 410]) {
    const gone = await harness({ deleteStatus });
    await gone.connect();
    expect((await gone.leave("calendar")).status).toBe(200);
    expect(await gone.count("calendar_connection")).toBe(0);
  }

  const down = await harness({ deleteStatus: 503 });
  await down.connect();
  const res = await down.leave("calendar");
  expect(res.status).toBe(502);
  const down502 = await res.text();
  expect(down502).toContain(title("Disconnect"));
  expect(down502).toContain("Google didn't answer just now.");
  expect(await down.count("calendar_connection")).toBe(1);
  expect((await down.connection())?.status).toBe("active");
  expect(down.revokes()).toEqual([]);
});

it("after Google stopped accepting: only Disconnect, and the copies are yours to remove", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  await h.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  expect(await h.page("/")).toContain(
    `<p class="muted"><a href="${DISCONNECT_PATH}">Disconnect</a></p>`,
  );
  const text = await h.page(DISCONNECT_PATH);
  expect(text).toContain(
    "the 2 WhenDoWe events in your Google calendar can't be removed from here; remove them in Google Calendar yourself.",
  );
  expect(text).toContain(button("keep", "Disconnect"));
  expect(text).not.toContain('value="remove"');
  expect(text).not.toContain('value="calendar"');
  for (const choice of ["remove", "calendar"]) {
    const res = await h.leave(choice);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain(title("Disconnect"));
    expect(text).toContain("That isn't one of the choices. Please start again.");
    expect((await h.connection())?.status).toBe("auth_error");
  }
  expect((await h.leave("keep")).status).toBe(200);
  expect(await h.count("calendar_connection")).toBe(0);

  // With nothing in Google, there is nothing to remove yourself.
  const g = await harness();
  await g.connect();
  await g.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  expect(await g.page(DISCONNECT_PATH)).toContain(
    "Google stopped accepting WhenDoWe's access, so nothing can be removed from here.</p>",
  );
});

it("without calendar_sync, disconnecting and removing the copies still work", async () => {
  const h = await harness({ capabilities: { default: "granted", operators: [] } });
  // Connected before the capability was gated: the row is what matters.
  const g = await harness();
  await g.connect();
  const row = (await g.storage.query(stmt("SELECT * FROM calendar_connection")))[0];
  const person = (await h.storage.query(stmt("SELECT id FROM person")))[0];
  await h.storage.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, token_expiry, status, made_by_us, created_at, updated_at)
       VALUES ('c', ?, 'google', 'ann@example.com', ?, ?, ?, ?, 'active', 1, ?, ?)`,
      String(person?.id),
      MADE_ID,
      String(row?.access_token_enc),
      String(row?.refresh_token_enc),
      String(row?.token_expiry),
      NOW,
      NOW,
    ),
  ]);
  await h.copies(2);
  expect(await h.page("/")).toContain(`<a href="${DISCONNECT_PATH}">Disconnect</a>`);
  expect(await h.page(DISCONNECT_PATH)).toContain(ASK);
  expect((await h.leave("remove")).status).toBe(200);
  expect((await h.connection())?.status).toBe("disconnected");
});

it("signed out, without the form's token, or with no choice: nothing changes; others are untouched", async () => {
  const h = await harness();
  await h.connect();
  const signedOut = await h.app.request(DISCONNECT_PATH, form({ copies: "keep" }, ""));
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toBe(SIGN_IN_PATH);
  expect((await h.app.request(DISCONNECT_PATH)).status).toBe(303);
  const forged = await h.app.request(
    DISCONNECT_PATH,
    form({ csrf: "stale", copies: "keep" }, h.ann.cookie),
  );
  expect(forged.status).toBe(403);
  const rejected = await forged.text();
  expect(rejected).toContain(title("Request rejected"));
  expect(rejected).toContain("Please try again.");
  for (const bad of ["", "maybe", "Keep them"]) {
    const res = await h.leave(bad);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(title("Disconnect"));
    expect(text).toContain("Choose one.");
  }
  // Bob, with no Google connection of his own — one of another provider isn't one — can't
  // reach Ann's.
  const bob = await h.signIn("bob@example.org");
  const bobId = (
    await h.storage.query(stmt("SELECT id FROM person WHERE email = 'bob@example.org'"))
  )[0]?.id;
  await h.storage.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, status, created_at, updated_at)
       VALUES ('other', ?, 'other', 'bob@example.com', 'cal', 'x', 'x', 'active', ?, ?)`,
      String(bobId),
      NOW,
      NOW,
    ),
  ]);
  expect((await h.get(DISCONNECT_PATH, bob)).status).toBe(404);
  expect((await h.leave("keep", bob)).status).toBe(404);
  expect(await h.count("calendar_connection")).toBe(2);
  expect(h.revokes()).toEqual([]);
});
