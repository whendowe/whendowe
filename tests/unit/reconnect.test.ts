// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { stmt } from "../../src/db/port.js";
import { grantCapability, revokeCapability } from "../../src/people/capability.js";
import { suppress } from "../../src/privacy/suppression.js";
import { RECONNECT_MAIL_MAX, reconnectMailPass } from "../../src/reconcile/tick.js";
import { reconnectMailer } from "../../src/web/app.js";
import { EVENTS_PATH, GROUPS_PATH, PLANS_PATH } from "../../src/web/layout.js";
import { CALLBACK_PATH, CONNECT_PATH } from "../../src/web/routes/oauth.js";
import { form, harness, NOW } from "./google-harness.js";

// When Google stops answering for you (DESIGN §10 *Google Calendar, one way*, rc40; MVP-4 G3):
// every page shows Reconnect Google Calendar, and one email says so — to your own address,
// taking nothing from your share. Reconnecting takes it all away, and a later loss says so again.

const BANNER = "<strong>Google stopped accepting WhenDoWe's access";
const LATER = "2101-10-01T10:05:00.000Z";

const lose = (h: { storage: Parameters<typeof reconnectMailPass>[0] }) =>
  h.storage.batch([stmt("UPDATE calendar_connection SET status = 'auth_error'")]);

/** Connect again through Google, as the banner's button does: the same calendar, refreshed. */
async function reconnect(h: Awaited<ReturnType<typeof harness>>) {
  const start = await h.app.request(CONNECT_PATH, form({ csrf: h.ann.csrf }, h.ann.cookie));
  expect(start.status).toBe(303);
  const flow = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const done = await h.app.request(`${CALLBACK_PATH}?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${h.ann.cookie}; ${flow}` },
  });
  expect(await done.text()).toContain("Reconnected.");
}

it("every page shows Reconnect Google Calendar while Google refuses, and none before or after", async () => {
  const h = await harness();
  await h.connect();
  const pages = ["/", `${EVENTS_PATH}/new`, GROUPS_PATH, PLANS_PATH, "/account"];
  for (const path of pages) expect(await h.page(path), path).not.toContain(BANNER);
  await lose(h);
  for (const path of pages) {
    const text = await h.page(path);
    expect(
      text,
      path,
    ).toContain(`<form class="wd-deleting error" method="post" action="${CONNECT_PATH}">
  <input type="hidden" name="csrf" value="${h.ann.csrf}" />
  ${BANNER}, so your events aren't reaching your Google calendar.</strong>
  <button type="submit">Reconnect Google Calendar</button>
</form>`);
    expect(text.split(">Reconnect Google Calendar</button>").length, path).toBe(2); // once
  }
  // Home still says which account, and offers Disconnect.
  expect(await h.page("/")).toContain(
    "Google stopped accepting WhenDoWe's access to <strong>ann@example.com</strong>.",
  );
  await reconnect(h);
  for (const path of pages) expect(await h.page(path), path).not.toContain(BANNER);
});

it("without calendar_sync the banner's button shows disabled, with its line, and posts nothing", async () => {
  const h = await harness({ capabilities: { default: "granted", operators: [] } });
  const ann = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'ann@example.org'")))[0]?.id,
  );
  const who = { capability: "calendar_sync" as const, actorId: ann, now: NOW };
  await grantCapability(h.storage, { email: "ann@example.org", ...who });
  await h.connect();
  await revokeCapability(h.storage, { personId: ann, ...who });
  await lose(h);
  for (const path of ["/", GROUPS_PATH]) {
    const text = await h.page(path);
    expect(
      text,
      path,
    ).toContain(`<p class="wd-deleting error">${BANNER}, so your events aren't reaching your Google calendar.</strong>
  <button type="button" disabled>Reconnect Google Calendar</button> <span class="muted">Connecting Google Calendar isn&#39;t available to this account.</span></p>`);
    expect(text, path).not.toContain(`action="${CONNECT_PATH}"`);
  }
  // Granted again, it is offered.
  await grantCapability(h.storage, { email: "ann@example.org", ...who });
  expect(await h.page("/")).toContain(
    `<form class="wd-deleting error" method="post" action="${CONNECT_PATH}">`,
  );
});

it("only the account whose connection it is; another provider's doesn't count", async () => {
  const h = await harness();
  await h.connect();
  const bob = await h.signIn("bob@example.org");
  const bobId = String(
    (await h.storage.query(stmt("SELECT id FROM person WHERE email = 'bob@example.org'")))[0]?.id,
  );
  await h.storage.batch([
    stmt(
      `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
         access_token_enc, refresh_token_enc, status, created_at, updated_at)
       VALUES ('other', ?, 'other', 'bob@example.com', 'cal', 'x', 'x', 'auth_error', ?, ?)`,
      bobId,
      NOW,
      NOW,
    ),
  ]);
  expect(await h.page("/", bob)).not.toContain(BANNER);
  await lose(h); // Ann's, and Bob's other one again
  expect(await h.page("/")).toContain(BANNER);
  expect(await h.page("/", bob)).not.toContain(BANNER);
  // A disconnected connection isn't one Google refuses.
  await h.storage.batch([
    stmt("UPDATE calendar_connection SET status = 'disconnected' WHERE provider = 'google'"),
  ]);
  expect(await h.page("/")).not.toContain(BANNER);
});

it("one email, to your own address, saying which Google account and where to reconnect", async () => {
  const h = await harness();
  await h.connect();
  const pass = reconnectMailer(h.auth);
  const before = h.sent.length;
  expect(await pass(LATER)).toEqual({ sent: 0, failed: 0 }); // nothing lost yet
  await lose(h);
  expect(await pass(LATER)).toEqual({ sent: 1, failed: 0 });
  const mail = h.sent.slice(before);
  expect(mail).toEqual([
    {
      to: "ann@example.org",
      subject: "Reconnect Google Calendar",
      text: `Google stopped accepting WhenDoWe's access to ann@example.com, so your WhenDoWe events aren't reaching that calendar any more.

Reconnect it: http://localhost:8080/

If you removed WhenDoWe's access on purpose, you can disconnect it there instead.`,
      cause: { kind: "self" },
    },
  ]);
  const [row] = await h.storage.query(stmt("SELECT reconnect_mailed_at FROM calendar_connection"));
  expect(row?.reconnect_mailed_at).toBe(LATER);
  // Once: the next minutes send nothing and write nothing.
  let writes = 0;
  const counted = {
    query: h.storage.query.bind(h.storage),
    batch: (s: Parameters<typeof h.storage.batch>[0]) => {
      writes += s.length;
      return h.storage.batch(s);
    },
  };
  expect(await reconnectMailPass(counted, h.auth.mail, { now: LATER, publicBaseUrl: "x" })).toEqual(
    { sent: 0, failed: 0 },
  );
  expect(writes).toBe(0);
  expect(await pass(LATER)).toEqual({ sent: 0, failed: 0 });
  expect(h.sent.length).toBe(before + 1);
});

it("reconnecting clears it, so a later loss mails again", async () => {
  const h = await harness();
  await h.connect();
  const pass = reconnectMailer(h.auth);
  await lose(h);
  await pass(LATER);
  await reconnect(h);
  const [row] = await h.storage.query(
    stmt("SELECT status, reconnect_mailed_at FROM calendar_connection"),
  );
  expect(row).toEqual({ status: "active", reconnect_mailed_at: null });
  expect(await pass(LATER)).toEqual({ sent: 0, failed: 0 });
  await lose(h);
  expect(await pass(LATER)).toEqual({ sent: 1, failed: 0 });
  expect(h.sent.filter((m) => m.subject === "Reconnect Google Calendar")).toHaveLength(2);
});

it("an opt-out from everyone doesn't stop it: it is mail you caused", async () => {
  const h = await harness();
  await h.connect();
  await suppress(h.storage, "ann@example.org", { kind: "all" }, NOW);
  await lose(h);
  expect(await reconnectMailer(h.auth)(LATER)).toEqual({ sent: 1, failed: 0 });
  expect(h.sent.at(-1)?.subject).toBe("Reconnect Google Calendar");
});

it(`a failed send is tried again the next minute and doesn't stop the others; at most ${RECONNECT_MAIL_MAX} a minute`, async () => {
  const h = await harness();
  const people = RECONNECT_MAIL_MAX + 1;
  for (let i = 0; i < people; i++) {
    const id = `p-${String(i).padStart(2, "0")}`;
    await h.storage.batch([
      stmt(
        "INSERT INTO person (id, email, created_at) VALUES (?, ?, ?)",
        id,
        `${id}@example.org`,
        NOW,
      ),
      stmt(
        `INSERT INTO calendar_connection (id, owner_id, provider, account_email, calendar_id,
           access_token_enc, refresh_token_enc, status, created_at, updated_at)
         VALUES (?, ?, 'google', ?, 'cal', 'x', 'x', 'auth_error', ?, ?)`,
        `c-${id}`,
        id,
        `${id}@example.com`,
        NOW,
        NOW,
      ),
    ]);
  }
  const to: string[] = [];
  const mail = {
    send: (m: { readonly to: string }) => {
      if (m.to === "p-00@example.org" && !to.includes("refused")) {
        to.push("refused");
        return Promise.reject(new Error("cap reached"));
      }
      to.push(m.to);
      return Promise.resolve();
    },
  };
  const opts = { now: LATER, publicBaseUrl: "https://whendowe.example" };
  expect(await reconnectMailPass(h.storage, mail, opts)).toEqual({
    sent: RECONNECT_MAIL_MAX - 1,
    failed: 1,
  });
  expect(to).not.toContain("p-00@example.org");
  expect(to).toContain("p-01@example.org");
  expect(to).not.toContain(`p-${RECONNECT_MAIL_MAX}@example.org`); // the next minute's
  expect(await reconnectMailPass(h.storage, mail, opts)).toEqual({ sent: 2, failed: 0 });
  expect(to).toContain("p-00@example.org");
  expect(to).toContain(`p-${RECONNECT_MAIL_MAX}@example.org`);
  expect(await reconnectMailPass(h.storage, mail, opts)).toEqual({ sent: 0, failed: 0 });
});
