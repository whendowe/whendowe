// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { stmt } from "../../src/db/port.js";
import { GOOGLE_CALENDARS_URL } from "../../src/oauth/primary-calendar.js";
import {
  type CalendarGrants,
  COPIES_GRACE_MS,
  eraseDue,
  requestDeletion,
} from "../../src/privacy/erasure.js";
import { forgetConnection } from "../../src/reconcile/tick.js";
import { DELETE_ACCOUNT_PATH, DELETION_LINK_PATH } from "../../src/web/routes/account.js";
import { form, harness, MADE_ID, NOW, OWN_ID, REFRESH } from "./google-harness.js";

// Deleting your account asks what disconnecting asks (DESIGN §10 *Google Calendar, one way*,
// rc40; MVP-4 G3): Remove them, chosen; Keep them; for a calendar WhenDoWe made, Delete the
// WhenDoWe calendar. On the day the copies go first — removing them is the push tick's, so
// the erasure waits for it, never longer than its grace — then the account.

const LEGEND = "<legend>Your WhenDoWe events in your Google calendar";
const radio = (value: string, label: string, checked = false) =>
  `<label><input type="radio" name="copies" value="${value}"${checked ? " checked" : ""} /> ${label}</label>`;

type H = Awaited<ReturnType<typeof harness>>;

const personCount = async (h: H) =>
  Number(
    (
      await h.storage.query(
        stmt("SELECT COUNT(*) AS n FROM person WHERE email = 'ann@example.org'"),
      )
    )[0]?.n,
  );

const choice = async (h: H) =>
  (await h.storage.query(stmt("SELECT calendar_copies FROM account_deletion")))[0]?.calendar_copies;

/** Ask for the deletion on the page, then press "Delete it now" in its email. */
async function deleteNow(h: H, copies?: string) {
  const fields: Record<string, string> = { csrf: h.ann.csrf, confirm: "ann@example.org" };
  if (copies !== undefined) fields.copies = copies;
  const asked = await h.app.request(DELETE_ACCOUNT_PATH, form(fields, h.ann.cookie));
  expect(asked.status).toBe(200);
  const link = /https?:\/\/\S+\/account\/deletion\S*/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "";
  const t = new URL(link).searchParams.get("t") ?? "";
  return h.app.request(DELETION_LINK_PATH, form({ t, do: "now" }, ""));
}

const deletes = (h: H) => h.log.filter((c) => c.method === "DELETE").map((c) => c.url);

it("the page asks about the copies, Remove them chosen, and asks Google nothing", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const before = h.log.length;
  const text = await h.page(DELETE_ACCOUNT_PATH);
  expect(text).toContain(`${LEGEND} (2 WhenDoWe events now)</legend>`);
  expect(text).toContain(radio("remove", "Remove them", true));
  expect(text).toContain(radio("keep", "Keep them"));
  expect(text).toContain(radio("calendar", "Delete the WhenDoWe calendar"));
  expect(text.indexOf(LEGEND)).toBeLessThan(text.lastIndexOf("</form>"));
  expect(h.log.length).toBe(before);
});

it("a calendar of your own is never offered for deletion; one copy is one event; none, still asked", async () => {
  const h = await harness();
  await h.connect(OWN_ID);
  await h.copies(1);
  const own = await h.page(DELETE_ACCOUNT_PATH);
  expect(own).toContain(`${LEGEND} (1 WhenDoWe event now)</legend>`);
  expect(own).not.toContain('value="calendar"');
  // Made by us with none yet: there may be some by the day.
  const g = await harness();
  await g.connect();
  const none = await g.page(DELETE_ACCOUNT_PATH);
  expect(none).toContain(`${LEGEND}</legend>`);
  expect(none).toContain(radio("remove", "Remove them", true));
});

it("Google refusing, the page says to remove them yourself; disconnected or never connected, nothing", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  await h.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  const refused = await h.page(DELETE_ACCOUNT_PATH);
  expect(refused).toContain(
    `<p class="error">Google stopped accepting WhenDoWe's access, so the 2 WhenDoWe events in your Google calendar can't be removed from here: remove them in Google Calendar yourself.</p>`,
  );
  expect(refused).not.toContain(LEGEND);
  await h.storage.batch([stmt("UPDATE calendar_connection SET status = 'disconnected'")]);
  const leaving = await h.page(DELETE_ACCOUNT_PATH);
  expect(leaving).not.toContain(LEGEND);
  expect(leaving).not.toContain("remove them in Google Calendar yourself");

  const g = await harness();
  await g.connect();
  await g.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  // With none in Google, nothing to say here (the banner above says the rest).
  expect(await g.page(DELETE_ACCOUNT_PATH)).not.toContain(
    "remove them in Google Calendar yourself",
  );
  const never = await harness();
  const page = await never.page(DELETE_ACCOUNT_PATH);
  expect(page).toContain("Delete your account?");
  expect(page).not.toContain(LEGEND);
});

it("the choice is kept with the request; none sent is Remove them; anything else records nothing", async () => {
  const h = await harness();
  const ask = (copies?: string) => {
    const fields: Record<string, string> = { csrf: h.ann.csrf, confirm: "ann@example.org" };
    if (copies !== undefined) fields.copies = copies;
    return h.app.request(DELETE_ACCOUNT_PATH, form(fields, h.ann.cookie));
  };
  const wrong = await ask("burn");
  expect(wrong.status).toBe(400);
  expect(await wrong.text()).toContain("That isn't one of the choices.");
  expect(await choice(h)).toBeUndefined();
  expect((await ask()).status).toBe(200);
  expect(await choice(h)).toBe("remove");
  // Asked again during the wait (signed in again), the new answer stands.
  const id = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
  );
  await requestDeletion(h.storage, id, NOW, { copies: "keep" });
  expect(await choice(h)).toBe("keep");
});

it("Remove them: the copies go first, by the push tick, and then the account", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const res = await deleteNow(h);
  const text = await res.text();
  expect(text).toContain("<h1>Your account is being deleted</h1>");
  expect(text).toContain("WhenDoWe is removing its events from your Google calendar first.");
  // Handed to the tick: as disconnecting does, busy times stop now.
  expect((await h.connection())?.status).toBe("disconnected");
  expect(await h.count("busy_calendar")).toBe(0);
  expect(await personCount(h)).toBe(1);
  expect(h.revokes()).toEqual([]);
  expect(deletes(h)).toEqual([]);
  // While they go, the pass passes it over, and writes nothing.
  let writes = 0;
  const counted = {
    query: h.storage.query.bind(h.storage),
    batch: (s: Parameters<typeof h.storage.batch>[0]) => {
      writes += s.length;
      return h.storage.batch(s);
    },
  };
  const at = new Date().toISOString();
  expect(await eraseDue(counted, { now: at })).toBe(0);
  expect(writes).toBe(0);
  // The tick removes the last copy, gives the access back and forgets the connection…
  const id = String((await h.connection())?.id);
  await h.storage.batch(forgetConnection(id));
  // …and the next pass erases the account.
  expect(await eraseDue(h.storage, { now: at })).toBe(1);
  expect(await personCount(h)).toBe(0);
});

it("an account waiting for its copies doesn't hold up the next one", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(1);
  await deleteNow(h);
  const bob = await h.signIn("bob@example.org");
  const bobId = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'bob@example.org'")))[0]?.id,
  );
  expect(bob.cookie).not.toBe("");
  await requestDeletion(h.storage, bobId, NOW);
  // Bob's day is just after Ann's, and an hour later both are due: Ann's copies still going.
  const [ann] = await h.storage.query(
    stmt("SELECT erase_after FROM account_deletion WHERE person_id <> ?", bobId),
  );
  const annDay = Date.parse(String(ann?.erase_after));
  await h.storage.batch([
    stmt(
      "UPDATE account_deletion SET erase_after = ? WHERE person_id = ?",
      new Date(annDay + 1).toISOString(),
      bobId,
    ),
  ]);
  const hourLater = new Date(annDay + 60 * 60 * 1000).toISOString();
  expect(await eraseDue(h.storage, { now: hourLater })).toBe(1);
  const left = await h.storage.query(stmt("SELECT email FROM person ORDER BY email"));
  expect(left.map((r) => r.email)).toEqual(["ann@example.org"]);
});

it("past its grace, the account is erased anyway, its access revoked", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  await deleteNow(h);
  const [row] = await h.storage.query(stmt("SELECT erase_after FROM account_deletion"));
  const due = Date.parse(String(row?.erase_after));
  const revoked: string[] = [];
  const calendars: CalendarGrants = {
    revoke: (cs) => {
      for (const c of cs) revoked.push(c.id);
      return Promise.resolve();
    },
    deleteMadeCalendar: () => Promise.reject(new Error("not asked")),
  };
  const justBefore = new Date(due + COPIES_GRACE_MS - 1).toISOString();
  expect(await eraseDue(h.storage, { now: justBefore, calendars })).toBe(0);
  expect(await personCount(h)).toBe(1);
  const over = new Date(due + COPIES_GRACE_MS).toISOString();
  expect(await eraseDue(h.storage, { now: over, calendars })).toBe(1);
  expect(revoked).toEqual(["conn-1"]);
  expect(await personCount(h)).toBe(0);
  expect(await h.count("calendar_connection")).toBe(0);
});

it("Remove them with nothing in Google, or Google refusing: erased at once", async () => {
  const h = await harness();
  await h.connect();
  expect(await (await deleteNow(h)).text()).toContain("<h1>Your account is deleted</h1>");
  expect(await personCount(h)).toBe(0);
  expect(h.revokes()).toEqual([new URLSearchParams({ token: REFRESH }).toString()]);

  const g = await harness();
  await g.connect();
  await g.copies(2);
  await g.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  expect(await (await deleteNow(g)).text()).toContain("<h1>Your account is deleted</h1>");
  expect(await personCount(g)).toBe(0);
});

it("Keep them: the access goes back to Google and the account goes; the copies stay", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await (await deleteNow(h, "keep")).text()).toContain("<h1>Your account is deleted</h1>");
  expect(h.revokes()).toEqual([new URLSearchParams({ token: REFRESH }).toString()]);
  expect(deletes(h)).toEqual([]);
  expect(await personCount(h)).toBe(0);
  expect(await h.count("calendar_connection")).toBe(0);
});

it("Delete the WhenDoWe calendar: deleted at Google, then the account, at once", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  expect(await (await deleteNow(h, "calendar")).text()).toContain(
    "<h1>Your account is deleted</h1>",
  );
  expect(deletes(h)).toEqual([`${GOOGLE_CALENDARS_URL}/${encodeURIComponent(MADE_ID)}`]);
  expect(h.revokes()).toHaveLength(1);
  expect(await personCount(h)).toBe(0);
});

it("the calendar not deleted — Google failing, or one of your own — its events are removed instead", async () => {
  const h = await harness({ deleteStatus: 500 });
  await h.connect();
  await h.copies(2);
  expect(await (await deleteNow(h, "calendar")).text()).toContain(
    "<h1>Your account is being deleted</h1>",
  );
  expect(deletes(h)).toHaveLength(1);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(await personCount(h)).toBe(1);

  const g = await harness();
  await g.connect(OWN_ID);
  await g.copies(1);
  expect(await (await deleteNow(g, "calendar")).text()).toContain(
    "<h1>Your account is being deleted</h1>",
  );
  expect(deletes(g)).toEqual([]);
  expect((await g.connection())?.status).toBe("disconnected");
});
