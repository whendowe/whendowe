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
import { deleteMadeCalendar } from "../../src/web/routes/oauth.js";
import { form, harness, MADE_ID, NOW, OWN_ID, REFRESH } from "./google-harness.js";

// Deleting your account asks what disconnecting asks (DESIGN §10 *Google Calendar, one way*,
// rc40; MVP-4 G3): Remove them, chosen; Keep them; for a calendar WhenDoWe made, Delete the
// WhenDoWe calendar. On the day the copies go first — removing them is the push tick's, so
// the erasure waits for it, never longer than its grace — then the account.

const LEGEND = "<legend>Your WhenDoWe events in your Google calendar";
const radio = (value: string, label: string, checked = false) =>
  `<label><input type="radio" name="copies" value="${value}"${checked ? " checked" : ""} /> ${label}</label>`;

type H = Awaited<ReturnType<typeof harness>>;

/** Nothing at all between the address to type and the opt-out: no question, no line. */
const NOTHING_ASKED = `</label></p>
  
  <p><label><input type="checkbox" name="suppress"`;

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
  return h.app.request(DELETION_LINK_PATH, form({ t: tokenOf(h), do: "now" }, ""));
}

/** The token in the last deletion email. */
function tokenOf(h: H) {
  const link = /https?:\/\/\S+\/account\/deletion\S*/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "";
  return new URL(link).searchParams.get("t") ?? "";
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
  expect(own).toContain(`${radio("keep", "Keep them")}<br />
  
  <span class="muted">On the day, before the account goes.`);
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
  expect(leaving).toContain(NOTHING_ASKED);

  const g = await harness();
  await g.connect();
  await g.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);
  // With none in Google, nothing to say here (the banner above says the rest).
  expect(await g.page(DELETE_ACCOUNT_PATH)).toContain(NOTHING_ASKED);
  const never = await harness();
  const page = await never.page(DELETE_ACCOUNT_PATH);
  expect(page).toContain("Delete your account?");
  expect(page).toContain(NOTHING_ASKED);
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
  const refused = await wrong.text();
  expect(refused).toContain("<title>Not deleted · WhenDoWe</title>");
  expect(refused).toContain("That isn't one of the choices.");
  expect(await choice(h)).toBeUndefined();
  expect((await ask()).status).toBe(200);
  expect(await choice(h)).toBe("remove");
  // Asked again during the wait (signed in again), the new answer stands.
  const id = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
  );
  await requestDeletion(h.storage, id, NOW, { copies: "keep" });
  expect(await choice(h)).toBe("keep");
  // Asked with no choice at all (no connection to ask about), Remove them.
  await requestDeletion(h.storage, id, NOW);
  expect(await choice(h)).toBe("remove");
});

it("Remove them: the copies go first, by the push tick, and then the account", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(2);
  const res = await deleteNow(h);
  const text = await res.text();
  expect(text).toContain("<title>Account being deleted · WhenDoWe</title>");
  expect(text).toContain("<h1>Your account is being deleted</h1>");
  expect(text).toContain("WhenDoWe is removing its events from your Google calendar first.");
  // Pressed again while they go: still waiting, never erased early.
  const again = await h.app.request(DELETION_LINK_PATH, form({ t: tokenOf(h), do: "now" }, ""));
  expect(await again.text()).toContain("<h1>Your account is being deleted</h1>");
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
  // The link goes with the account.
  const twice = await h.app.request(DELETION_LINK_PATH, form({ t: tokenOf(h), do: "now" }, ""));
  expect(twice.status).toBe(400);
});

it("on an instance without Google's credentials, Delete the calendar can't be done: its events go", async () => {
  const h = await harness();
  await h.connect();
  await h.copies(1);
  const id = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
  );
  const asked = await requestDeletion(h.storage, id, NOW, { copies: "calendar" });
  expect(await eraseDue(h.storage, { now: asked.eraseAfter })).toBe(0);
  expect((await h.connection())?.status).toBe("disconnected");
  expect(deletes(h)).toEqual([]);
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

it("deleteMadeCalendar deletes only a calendar WhenDoWe made, and says false when Google fails", async () => {
  const annId = async (h: H) =>
    String(
      (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
    );
  const own = await harness();
  expect(await deleteMadeCalendar(own.oauth, await annId(own))).toBe(false); // none connected
  await own.connect(OWN_ID);
  expect(await deleteMadeCalendar(own.oauth, await annId(own))).toBe(false);
  expect(deletes(own)).toEqual([]);
  const failing = await harness({ deleteStatus: 500 });
  await failing.connect();
  expect(await deleteMadeCalendar(failing.oauth, await annId(failing))).toBe(false);
  expect(deletes(failing)).toHaveLength(1);
  const made = await harness();
  await made.connect();
  expect(await deleteMadeCalendar(made.oauth, await annId(made))).toBe(true);
  expect(deletes(made)).toEqual([`${GOOGLE_CALENDARS_URL}/${encodeURIComponent(MADE_ID)}`]);
});

it("only a Google connection is asked about or waited for", async () => {
  const h = await harness();
  const ann = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
  );
  await h.storage.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, status, created_at, updated_at)
       VALUES ('other', ?, 'other', 'ann@example.com', 'cal', 'x', 'x', 'active', ?, ?)`,
      ann,
      NOW,
      NOW,
    ),
  ]);
  await h.copies(1);
  expect(await h.page(DELETE_ACCOUNT_PATH)).toContain(NOTHING_ASKED);
  // Its token is a stand-in, so no grants to revoke: the pass alone, which erases at once.
  const asked = await requestDeletion(h.storage, ann, NOW);
  expect(await eraseDue(h.storage, { now: asked.eraseAfter })).toBe(1);
  expect(await personCount(h)).toBe(0);
});
