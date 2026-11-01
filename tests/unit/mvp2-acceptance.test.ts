// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createApp } from "../../src/web/app.js";
import { loadMigrationSql } from "../conftest.js";

// MVP-2's acceptance test (DESIGN §15): "when do we play?" is answered without anyone
// installing anything. WORKFLOWS US-14, the D&D table, end to end over HTTP:
//
//   the DM signs in, makes a group, invites five players; each joins with one click
//   and is never signed in again. The DM offers three dates (since rc26 a thread of
//   one-event plans) and emails vote links;
//   the players vote from those links alone — no cookie on any request. The DM
//   accepts Saturday, emails "are you coming?" links; one player says maybe and
//   "might be late". The DM sees every answer, attributed.
//
// (Joining a group creates a `person` — an email address, nothing more: no password,
// no app, no calendar. That is the account-less rule as DESIGN §10 defines it.)

const BASE = "https://whendowe.example";

it("US-14: the D&D table finds a date and says who's coming — players never sign in", async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const sent: MailMessage[] = [];
  const app = createApp({
    auth: {
      storage: sqliteStoragePort(client),
      mail: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: BASE,
      secureCookies: false,
      now: () => new Date().toISOString(),
    },
  });

  const form = (fields: Record<string, string>, cookie?: string): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
  const lastLinkTo = (email: string, path: string): URL => {
    const mail = [...sent].reverse().find((m) => m.to === email);
    const match = new RegExp(`${BASE.replace(/\./g, "\\.")}${path}\\?t=\\S+`).exec(
      mail?.text ?? "",
    );
    if (match === null) throw new Error(`no ${path} link mailed to ${email}`);
    return new URL(match[0]);
  };
  /** A request exactly as a player makes it: from an emailed link, with NO cookie. */
  const asPlayer = (url: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.has("cookie")).toBe(false);
    return app.request(typeof url === "string" ? url : `${url.pathname}${url.search}`, init);
  };

  // --- The DM signs in and sets up the table ---------------------------------------
  await app.request("/auth/sign-in", form({ email: "dm@example.org" }));
  const signIn = lastLinkTo("dm@example.org", "/auth/confirm");
  const dmCookie =
    (
      (
        await app.request(signIn.pathname, form({ t: signIn.searchParams.get("t") ?? "" }))
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0] ?? "";
  const csrf =
    /name="csrf" value="([^"]+)"/.exec(
      await (await app.request("/", { headers: { cookie: dmCookie } })).text(),
    )?.[1] ?? "";
  const dm = (path: string, fields: Record<string, string> = {}) =>
    app.request(path, form({ csrf, ...fields }, dmCookie));
  const dmGet = async (path: string) =>
    (await app.request(path, { headers: { cookie: dmCookie } })).text();

  const group = (await dm("/groups", { name: "Thursday Table" })).headers.get("location") ?? "";
  const players = ["ann", "bob", "cid", "dee", "eve"].map((n) => `${n}@example.org`);
  for (const email of players) {
    await dm(`${group}/invites`, { email, editTier: "view", visibility: "FULL" });
    const invite = lastLinkTo(email, "/invite");
    // One click to join. The session cookie this sets is thrown away: from here on
    // the player only ever uses links from their inbox.
    expect(
      (await asPlayer("/invite", form({ t: invite.searchParams.get("t") ?? "" }))).status,
    ).toBe(303);
  }

  // --- "When do we play?" (a thread of one-event plans, DESIGN §10 rc26) -------------
  const thread =
    (
      await dm(`${group}/polls`, {
        title: "Session 15: the Lich's Bargain",
        tzid: "Europe/Prague",
        start_0: "2101-11-06T19:00",
        end_0: "2101-11-06T23:00",
        start_1: "2101-11-08T18:00",
        end_1: "2101-11-08T22:00",
        start_2: "2101-11-09T14:00",
        end_2: "2101-11-09T18:00",
      })
    ).headers.get("location") ?? "";
  expect(await (await dm(`${thread}/links`)).text()).toContain("Sent to 5 people.");

  // Times in order: 0 = Thu 6th, 1 = Sat 8th, 2 = Sun 9th. Everyone can do Saturday.
  const ballots: Record<string, readonly string[]> = {
    "ann@example.org": ["no", "yes", "ifneedbe"],
    "bob@example.org": ["yes", "yes", "no"],
    "cid@example.org": ["yes", "yes", "yes"],
    "dee@example.org": ["no", "yes", "no"],
    "eve@example.org": ["ifneedbe", "yes", "yes"],
  };
  let plans: string[] = [];
  for (const [email, ballot] of Object.entries(ballots)) {
    const link = lastLinkTo(email, "/vote");
    const opened = await asPlayer(link); // opening the link: read-only
    expect(opened.status).toBe(200);
    plans = [
      ...new Set(
        [...(await opened.text()).matchAll(/name="plan_([^"]+)"/g)].map((m) => m[1] ?? ""),
      ),
    ];
    expect(plans).toHaveLength(3);
    const answers = Object.fromEntries(ballot.map((a, i) => [`plan_${plans[i]}`, a]));
    const answered = await asPlayer(
      "/vote",
      form({ t: link.searchParams.get("t") ?? "", ...answers }),
    );
    expect(answered.status).toBe(303);
    expect(answered.headers.get("set-cookie")).toBeNull(); // voting never signs anyone in
  }
  // The DM's yes went with every time when the poll was sent.
  const saturday = `${thread}/p/${plans[1]}`;
  const tally = await dmGet(saturday);
  expect(tally).toContain("6/6 yes");
  // Players never chose a name, so they show as guests; nobody's address is on the page
  // but the DM's own, in the header (DESIGN §10 rc21).
  expect(tally).toMatch(/Guest \d{4} yes/);
  expect(tally).not.toContain("cid@example.org");

  // --- The DM accepts Saturday ----------------------------------------------------------
  expect((await dm(`${saturday}/accept`)).status).toBe(303);
  const event = `/events/${/href="\/events\/([0-9a-f-]+)"/.exec(await dmGet(thread))?.[1] ?? "none"}`;
  expect(await dmGet(event)).toContain("2101-11-08 18:00 – 22:00 · Europe/Prague");
  // A late vote from a player's old link finds nothing left to vote on.
  const late = lastLinkTo("ann@example.org", "/vote");
  expect(await (await asPlayer(late)).text()).toContain("There's nothing to vote on any more.");

  // --- "Are you coming?" ----------------------------------------------------------------
  expect(await (await dm(`${event}/links`)).text()).toContain("Sent to 5 people.");
  const attending: Record<string, string> = {
    "ann@example.org": "going",
    "bob@example.org": "going",
    "cid@example.org": "going",
    "dee@example.org": "maybe",
    "eve@example.org": "going",
  };
  for (const [email, attendance] of Object.entries(attending)) {
    const link = lastLinkTo(email, "/respond");
    const note: Record<string, string> =
      email === "dee@example.org" ? { note: "might be late" } : {};
    expect(
      (
        await asPlayer(
          "/respond",
          form({ t: link.searchParams.get("t") ?? "", attendance, ...note }),
        )
      ).status,
    ).toBe(303);
  }

  // --- Done when: the DM sees attendance and feedback, attributed -------------------------
  const final = await dmGet(event);
  expect(final).toContain("4 going · 1 maybe · 0 can't make it");
  // Attributed: the same name on Dee's "maybe" and on her note — a guest name, as she
  // never chose one, and never her address (DESIGN §10 rc21).
  const dee = /<li>(Guest \d{4}): Maybe<\/li>/.exec(final)?.[1] ?? "no maybe";
  expect(final).toMatch(new RegExp(`${dee}: <span[^>]*>might be late</span>`));
  expect(final).not.toContain("dee@example.org");
  // …and the group page shows the session at its time.
  expect(await dmGet(group)).toContain("2101-11-08 18:00 – 22:00 · Europe/Prague");
});
