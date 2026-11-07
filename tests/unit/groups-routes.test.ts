// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { cappedMailPort, type MailCap } from "../../src/mail/capped.js";
import type { MailMessage, MailPort } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

/** With `cap`, mail goes through the real cap (src/mail/capped.ts), as it does deployed. */
async function harness(cap?: MailCap) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const now = () => new Date().toISOString();
  const recording: MailPort = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
  const app = createApp({
    auth: {
      storage,
      mail: cap === undefined ? recording : cappedMailPort(recording, storage, { cap, now }),
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now,
    },
  });
  return { app, sent };
}

type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: H, email: string): Promise<{ cookie: string; csrf: string }> {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, post({ t }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  return { cookie, csrf };
}

async function createGroupVia(
  h: H,
  me: { cookie: string; csrf: string },
  name: string,
): Promise<string> {
  const res = await h.app.request(GROUPS_PATH, post({ csrf: me.csrf, name }, me.cookie));
  expect(res.status).toBe(303);
  return res.headers.get("location") ?? "";
}

it("requires sign-in for every group page", async () => {
  const h = await harness();
  for (const path of [GROUPS_PATH, `${GROUPS_PATH}/anything`]) {
    const res = await h.app.request(path);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(SIGN_IN_PATH);
  }
  expect((await h.app.request(GROUPS_PATH, post({ name: "x" }))).status).toBe(303);
});

it("creates a group and shows it with its organizer", async () => {
  const h = await harness();
  const me = await signIn(h, "dm@example.org");
  const location = await createGroupVia(h, me, "Thursday Table");
  const page = await (await h.app.request(location, { headers: { cookie: me.cookie } })).text();
  expect(page).toContain("<h1>Thursday Table</h1>");
  // No name chosen yet: a guest to everyone, themselves included — never the address
  // (DESIGN §10 rc21). Home asks for a name.
  expect(page).toMatch(/<li>Guest \d{4} \(you\)/);
  expect(page).toContain("You appear here as");
  const front = await (await h.app.request("/", { headers: { cookie: me.cookie } })).text();
  expect(front).toContain("Choose the name people see");
  const list = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(list).toContain("you organize");
});

it("refuses to create a group without this session's CSRF token", async () => {
  const h = await harness();
  const me = await signIn(h, "csrf-g@example.org");
  const res = await h.app.request(GROUPS_PATH, post({ name: "Forged" }, me.cookie));
  expect(res.status).toBe(403);
  const list = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(list).not.toContain("Forged");
});

it("another person cannot see the group, even with its URL", async () => {
  const h = await harness();
  const owner = await signIn(h, "owner@example.org");
  const location = await createGroupVia(h, owner, "Our Household");
  const stranger = await signIn(h, "stranger@example.org");
  const res = await h.app.request(location, { headers: { cookie: stranger.cookie } });
  // 404, not 403: an outsider must not even learn that the group exists.
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("Our Household");
  const missing = await h.app.request(`${GROUPS_PATH}/no-such-group`, {
    headers: { cookie: stranger.cookie },
  });
  expect(missing.status).toBe(404);
});

it("escapes a hostile group name everywhere it is shown", async () => {
  const h = await harness();
  const me = await signIn(h, "xss@example.org");
  const location = await createGroupVia(h, me, '<img src=x onerror="alert(1)">');
  for (const path of [location, GROUPS_PATH]) {
    const page = await (await h.app.request(path, { headers: { cookie: me.cookie } })).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x");
  }
});

it("rejects an empty name and keeps what was typed", async () => {
  const h = await harness();
  const me = await signIn(h, "empty@example.org");
  const res = await h.app.request(GROUPS_PATH, post({ csrf: me.csrf, name: "   " }, me.cookie));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Give the group a name.");
});

it("shows a helpful empty state before the first group", async () => {
  const h = await harness();
  const me = await signIn(h, "new@example.org");
  const page = await (await h.app.request(GROUPS_PATH, { headers: { cookie: me.cookie } })).text();
  expect(page).toContain("No groups yet.");
});

// --- invites (slice D2) -----------------------------------------------------------

async function inviteVia(
  h: H,
  me: { cookie: string; csrf: string },
  groupPath: string,
  email: string,
  extra: Record<string, string> = {},
) {
  return h.app.request(
    `${groupPath}/invites`,
    post({ csrf: me.csrf, email, editTier: "view", visibility: "FULL", ...extra }, me.cookie),
  );
}

function inviteLink(h: H): URL {
  return new URL(
    /https?:\/\/\S+\/invite\?t=\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "http://x/invalid",
  );
}

it("an organizer sees the invite form; the invite email links to PUBLIC_BASE_URL", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm@example.org");
  const group = await createGroupVia(h, dm, "Thursday Table");
  expect(await (await h.app.request(group, { headers: { cookie: dm.cookie } })).text()).toContain(
    "Invite someone",
  );
  const res = await inviteVia(h, dm, group, "Player@Example.org", { host: "evil.example" });
  expect(res.status).toBe(200);
  expect(h.sent.at(-1)?.to).toBe("player@example.org");
  expect(inviteLink(h).origin).toBe("https://whendowe.example");
});

it("an organizer's invites stop at their share of the mail, and the page says whose (rc37, rc39)", async () => {
  const h = await harness({ daily: 200, monthly: 2500, senderDaily: 2 });
  const dm = await signIn(h, "share-dm@example.org"); // a sign-in link: not dm's share
  const group = await createGroupVia(h, dm, "Thursday Table");
  expect((await inviteVia(h, dm, group, "a@example.org")).status).toBe(200);
  expect((await inviteVia(h, dm, group, "b@example.org")).status).toBe(200);
  const third = await inviteVia(h, dm, group, "c@example.org");
  expect(third.status).toBe(503);
  // No "copy their links": an invite has none to copy.
  expect(await third.text()).toContain(
    "You&#39;ve sent as much email today as one person can. You can send more tomorrow.</p>",
  );
  expect(h.sent.map((m) => m.to)).not.toContain("c@example.org");
  // Someone else still sends.
  const ann = await signIn(h, "share-ann@example.org");
  expect(
    (await inviteVia(h, ann, await createGroupVia(h, ann, "Jam"), "d@example.org")).status,
  ).toBe(200);

  const fresh = await harness({ daily: 200, monthly: 2500, senderDaily: 5, newSenderDaily: 1 });
  const new1 = await signIn(fresh, "share-new@example.org");
  const g = await createGroupVia(fresh, new1, "Book club");
  expect((await inviteVia(fresh, new1, g, "e@example.org")).status).toBe(200);
  const second = await inviteVia(fresh, new1, g, "f@example.org");
  expect(second.status).toBe(503);
  expect(await second.text()).toMatch(
    /New accounts send less email in their first week, until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. You can send more tomorrow\./,
  );
});

it("the invitee joins with one click, is signed in, and sees the group — but cannot invite", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm2@example.org");
  await h.app.request(ACCOUNT_PATH, post({ csrf: dm.csrf, handle: "The DM" }, dm.cookie));
  const group = await createGroupVia(h, dm, "Thursday Table");
  await inviteVia(h, dm, group, "player2@example.org");
  const link = inviteLink(h);

  // GET (a scanner, or the person reading) names group, inviter and account; uses nothing.
  const preview = await h.app.request(`${link.pathname}${link.search}`);
  expect(preview.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await preview.text();
  expect(body).toContain("Join “Thursday Table”?");
  expect(body).toContain("<strong>The DM</strong> invited <strong>player2@example.org</strong>");
  expect(body).not.toContain("inv-dm2@example.org");
  expect(h.sent.at(-1)?.subject).toBe('The DM invited you to "Thursday Table" on WhenDoWe');

  const joined = await h.app.request("/invite", post({ t: link.searchParams.get("t") ?? "" }));
  expect(joined.status).toBe(303);
  expect(joined.headers.get("location")).toBe(group);
  const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await (await h.app.request(group, { headers: { cookie } })).text();
  expect(page).toMatch(/<li>Guest \d{4} \(you\)/);
  expect(page).not.toContain("Invite someone");

  // A member who tries the organizer's invite action anyway is refused.
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  expect((await inviteVia(h, { cookie, csrf }, group, "friend@example.org")).status).toBe(403);
});

it("an invite works once", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm3@example.org");
  const group = await createGroupVia(h, dm, "G");
  await inviteVia(h, dm, group, "once3@example.org");
  const t = inviteLink(h).searchParams.get("t") ?? "";
  expect((await h.app.request("/invite", post({ t }))).status).toBe(303);
  expect((await h.app.request("/invite", post({ t }))).status).toBe(400);
});

it("each member chooses a name per group, and whether this group sees their address", async () => {
  // DESIGN §10 rc21: a handle by default, changeable per group; addresses hidden unless
  // their owner turns them on, for that one group.
  const h = await harness();
  const dm = await signIn(h, "pg-dm@example.org");
  await h.app.request(ACCOUNT_PATH, post({ csrf: dm.csrf, handle: "Mara" }, dm.cookie));
  const group = await createGroupVia(h, dm, "Rope jam");
  const other = await createGroupVia(h, dm, "Swing practice");
  await inviteVia(h, dm, group, "pg-lena@example.org");
  const joined = await h.app.request(
    "/invite",
    post({ t: inviteLink(h).searchParams.get("t") ?? "" }),
  );
  const lenaCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const asLena = async (path: string) =>
    (await h.app.request(path, { headers: { cookie: lenaCookie } })).text();
  const lenaCsrf = /name="csrf" value="([^"]+)"/.exec(await asLena("/"))?.[1] ?? "";

  expect(await asLena(group)).toMatch(/<li>Mara <span class="muted">· organizer/);
  expect(await asLena(group)).not.toContain("pg-dm@example.org");

  // Mara is "Kestrel" in the rope group, and shows her address there only.
  const me = await h.app.request(
    `${group}/me`,
    post({ csrf: dm.csrf, handle: "Kestrel", show_email: "1" }, dm.cookie),
  );
  expect(me.status).toBe(303);
  const rope = await asLena(group);
  expect(rope).toContain('<li>Kestrel <span class="muted">pg-dm@example.org</span>');
  const page = async (path: string) =>
    (await h.app.request(path, { headers: { cookie: dm.cookie } })).text();
  expect(await page(other)).toMatch(/<li>Mara \(you\)/);

  // Emptied, the group name falls back to the account's; unticked, the address goes.
  await h.app.request(`${group}/me`, post({ csrf: dm.csrf, handle: "" }, dm.cookie));
  expect(await asLena(group)).toMatch(/<li>Mara <span class="muted">· organizer/);
  expect(await asLena(group)).not.toContain("pg-dm@example.org");

  // Only your own row, only with your CSRF token, only where you're a member.
  const forged = await h.app.request(`${group}/me`, post({ csrf: "nope", handle: "X" }, dm.cookie));
  expect(forged.status).toBe(403);
  const notMine = await h.app.request(
    `${other}/me`,
    post({ csrf: lenaCsrf, handle: "Intruder" }, lenaCookie),
  );
  expect(notMine.status).toBe(404);
  const bad = await h.app.request(
    `${group}/me`,
    post({ csrf: dm.csrf, handle: "x".repeat(41) }, dm.cookie),
  );
  expect(bad.status).toBe(400);
});

// rc18 (DESIGN §13): this used to sign the other account out. A browser now holds
// several accounts, so joining adds the invited one and keeps the other.
it("joining while signed in as someone else adds the invited account and keeps the other", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm4@example.org");
  const group = await createGroupVia(h, dm, "G");
  await inviteVia(h, dm, group, "newbie4@example.org");
  const link = inviteLink(h);

  // The DM opens the link in their own browser by mistake: the page says what happens.
  const preview = await (
    await h.app.request(`${link.pathname}${link.search}`, { headers: { cookie: dm.cookie } })
  ).text();
  expect(preview).toContain("You're signed in as inv-dm4@example.org");
  expect(preview).toContain("Joining also signs this browser in as newbie4@example.org");

  const joined = await h.app.request(
    "/invite",
    post({ t: link.searchParams.get("t") ?? "" }, dm.cookie),
  );
  const both = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie: both } })).text();
  expect(home).toMatch(/<summary>.*<strong>newbie4@example\.org<\/strong>/s);
  expect(home).toContain("Switch to <strong>inv-dm4@example.org</strong>");
  // The DM's own session is still alive, and still theirs.
  expect(await (await h.app.request("/", { headers: { cookie: dm.cookie } })).text()).toMatch(
    /<summary>.*<strong>inv-dm4@example\.org<\/strong>/s,
  );
});

it("refuses an invite without CSRF, from a non-member, or to an existing member", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm5@example.org");
  const group = await createGroupVia(h, dm, "G");
  expect(
    (
      await h.app.request(
        `${group}/invites`,
        post({ email: "a@example.org", editTier: "view", visibility: "FULL" }, dm.cookie),
      )
    ).status,
  ).toBe(403);
  const stranger = await signIn(h, "inv-stranger@example.org");
  expect((await inviteVia(h, stranger, group, "b@example.org")).status).toBe(404);
  expect((await inviteVia(h, dm, group, "inv-dm5@example.org")).status).toBe(409);
});

it("rejects tiers that aren't on the list", async () => {
  const h = await harness();
  const dm = await signIn(h, "inv-dm6@example.org");
  const group = await createGroupVia(h, dm, "G");
  expect((await inviteVia(h, dm, group, "c@example.org", { editTier: "superuser" })).status).toBe(
    400,
  );
});

it("leaving a group: the organizer's role passes on; the last one out deletes it (§10 rc21)", async () => {
  const h = await harness();
  const dm = await signIn(h, "lg-dm@example.org");
  const group = await createGroupVia(h, dm, "Jam");
  await inviteVia(h, dm, group, "lg-lena@example.org");
  const joined = await h.app.request(
    "/invite",
    post({ t: inviteLink(h).searchParams.get("t") ?? "" }),
  );
  const lena = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const lenaCsrf =
    /name="csrf" value="([^"]+)"/.exec(
      await (await h.app.request("/", { headers: { cookie: lena } })).text(),
    )?.[1] ?? "";
  const asOrganizer = await (
    await h.app.request(`${group}/leave`, { headers: { cookie: dm.cookie } })
  ).text();
  expect(asOrganizer).toContain("Someone else will organize it");
  expect((await h.app.request(`${group}/leave`, post({ csrf: dm.csrf }, dm.cookie))).status).toBe(
    303,
  );
  expect((await h.app.request(group, { headers: { cookie: dm.cookie } })).status).toBe(404);
  const lenaPage = await (await h.app.request(group, { headers: { cookie: lena } })).text();
  expect(lenaPage).toContain("Invite someone"); // she organizes it now

  const last = await (await h.app.request(`${group}/leave`, { headers: { cookie: lena } })).text();
  expect(last).toContain("leaving deletes the group");
  expect((await h.app.request(`${group}/leave`, post({ csrf: lenaCsrf }, lena))).status).toBe(303);
  expect((await h.app.request(group, { headers: { cookie: lena } })).status).toBe(404);
});
