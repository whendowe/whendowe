// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { OPT_OUT_PATH } from "../../src/privacy/suppression.js";
import { createApp } from "../../src/web/app.js";
import { ACCOUNT_PATH } from "../../src/web/layout.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { loadMigrationSql } from "../conftest.js";

// The opt-out link end to end (DESIGN §10 rc24): every email someone else caused carries
// it; its page renders on GET and acts on POST; the scope comes from the link; sign-in
// links are never stopped.

async function harness() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const app = createApp({
    auth: {
      storage,
      mail: { send: (m) => (sent.push(m), Promise.resolve()) },
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
  });
  return { app, sent, storage };
}
type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: H, email: string, handle: string) {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, post({ t }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  await h.app.request(ACCOUNT_PATH, post({ csrf, handle }, cookie));
  return { cookie, csrf };
}

/** dm's group, and an invite to `email`; returns the group path. */
async function invited(h: H, email: string) {
  const dm = await signIn(h, "dm@example.org", "dm");
  const res = await h.app.request(
    GROUPS_PATH,
    post({ csrf: dm.csrf, name: "Thursday Table" }, dm.cookie),
  );
  const group = res.headers.get("location") ?? "";
  const invite = () =>
    h.app.request(
      `${group}/invites`,
      post({ csrf: dm.csrf, email, editTier: "view", visibility: "FULL" }, dm.cookie),
    );
  await invite();
  return { dm, group, invite };
}

const optOutToken = (m: MailMessage | undefined) =>
  new URL(
    /https:\/\/\S+\/opt-out\?t=\S+/.exec(m?.text ?? "")?.[0] ?? "https://x/",
  ).searchParams.get("t") ?? "";

const suppressions = async (h: H) =>
  (await h.storage.query({ sql: "SELECT scope FROM mail_suppression", params: [] })).length;

it("an invite says who and why, and its link offers that person, that group, or everyone", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  const mail = h.sent.at(-1);
  expect(mail?.text).toContain(
    'You got this because dm invited this address to the group "Thursday Table".',
  );
  const t = optOutToken(mail);
  for (let i = 0; i < 2; i += 1) {
    const res = await h.app.request(`${OPT_OUT_PATH}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await res.text();
    expect(page).toContain("Stop emails from dm");
    expect(page).toContain("Stop emails through “Thursday Table”");
    expect(page).toContain("Stop emails from anyone on WhenDoWe");
    expect(page).toContain("Delete everything about this address");
  }
  // GET never mutates.
  expect(await suppressions(h)).toBe(0);
});

it("stopping a group's mail drops its next invite; a sign-in link still arrives, with no opt-out", async () => {
  const h = await harness();
  const { invite } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "group" }));
  expect(res.status).toBe(200);
  const before = h.sent.length;
  await invite();
  expect(h.sent.length).toBe(before);
  await h.app.request(OPT_OUT_PATH, post({ t, do: "all" }));
  await h.app.request(SIGN_IN_PATH, post({ email: "ana@example.org" }));
  const signIn = h.sent.at(-1);
  expect(signIn?.to).toBe("ana@example.org");
  expect(signIn?.subject).toBe("Your WhenDoWe sign-in link");
  expect(signIn?.text).not.toContain(OPT_OUT_PATH);
});

it("delete everything erases an address that never signed in, at once", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "delete" }));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Everything about this address is deleted");
  const left = await h.storage.query({
    sql: "SELECT 1 FROM group_invite WHERE email = ? UNION ALL SELECT 1 FROM opt_out_token WHERE email = ?",
    params: ["ana@example.org", "ana@example.org"],
  });
  expect(left).toHaveLength(0);
  // The link is spent, and says so.
  expect((await h.app.request(`${OPT_OUT_PATH}?t=${t}`)).status).toBe(400);
});

it("an address with an account is told to sign in to delete it, and the POST refuses", async () => {
  const h = await harness();
  await signIn(h, "kim@example.org", "kim");
  await invited(h, "kim@example.org");
  const t = optOutToken(h.sent.at(-1));
  const page = await (await h.app.request(`${OPT_OUT_PATH}?t=${t}`)).text();
  expect(page).not.toContain("Delete everything about this address");
  expect(page).toContain("This address has an account");
  const res = await h.app.request(OPT_OUT_PATH, post({ t, do: "delete" }));
  expect(res.status).toBe(409);
  expect(await suppressions(h)).toBe(0);
});

it("an unknown link, or an action the link doesn't carry, does nothing", async () => {
  const h = await harness();
  await invited(h, "ana@example.org");
  expect((await h.app.request(`${OPT_OUT_PATH}?t=nope`)).status).toBe(400);
  expect((await h.app.request(OPT_OUT_PATH)).status).toBe(400);
  expect((await h.app.request(OPT_OUT_PATH, post({ t: "nope", do: "all" }))).status).toBe(400);
  const t = optOutToken(h.sent.at(-1));
  expect((await h.app.request(OPT_OUT_PATH, post({ t, do: "everything" }))).status).toBe(400);
  expect(await suppressions(h)).toBe(0);
});

it("stopping one person's mail stops it through every group, and nobody else's", async () => {
  const h = await harness();
  const { dm } = await invited(h, "ana@example.org");
  const t = optOutToken(h.sent.at(-1));
  expect((await h.app.request(OPT_OUT_PATH, post({ t, do: "person" }))).status).toBe(200);
  const groupBy = async (who: { cookie: string; csrf: string }, name: string) => {
    const res = await h.app.request(GROUPS_PATH, post({ csrf: who.csrf, name }, who.cookie));
    const group = res.headers.get("location") ?? "";
    const before = h.sent.length;
    await h.app.request(
      `${group}/invites`,
      post(
        { csrf: who.csrf, email: "ana@example.org", editTier: "view", visibility: "FULL" },
        who.cookie,
      ),
    );
    return h.sent.length - before;
  };
  expect(await groupBy(dm, "Another table")).toBe(0);
  const eva = await signIn(h, "eva@example.org", "eva");
  expect(await groupBy(eva, "Eva's table")).toBe(1);
});
