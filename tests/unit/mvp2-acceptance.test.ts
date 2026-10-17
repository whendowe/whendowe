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
//   and is never signed in again. The DM offers three dates and emails vote links;
//   the players vote from those links alone — no cookie on any request. The DM
//   confirms Saturday, emails "are you coming?" links; one player says maybe and
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

  // --- "When do we play?" -------------------------------------------------------------
  const poll =
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
  expect(await (await dm(`${poll}/links`)).text()).toContain("Sent to 5 people.");

  // Options in time order: 0 = Thu 6th, 1 = Sat 8th, 2 = Sun 9th. Everyone can do Saturday.
  const ballots: Record<string, Record<string, string>> = {
    "ann@example.org": { slot_0: "no", slot_1: "yes", slot_2: "ifneedbe" },
    "bob@example.org": { slot_0: "yes", slot_1: "yes", slot_2: "no" },
    "cid@example.org": {
      slot_0: "yes",
      slot_1: "yes",
      slot_2: "yes",
      note: "Thursday's bad next week, actually",
    },
    "dee@example.org": { slot_0: "no", slot_1: "yes", slot_2: "no" },
    "eve@example.org": { slot_0: "ifneedbe", slot_1: "yes", slot_2: "yes" },
  };
  for (const [email, ballot] of Object.entries(ballots)) {
    const link = lastLinkTo(email, "/respond");
    expect((await asPlayer(link)).status).toBe(200); // opening the link: read-only
    const answered = await asPlayer(
      "/respond",
      form({ t: link.searchParams.get("t") ?? "", ...ballot }),
    );
    expect(answered.status).toBe(303);
    expect(answered.headers.get("set-cookie")).toBeNull(); // answering never signs anyone in
  }
  await dm(`${poll}/votes`, { slot_1: "yes" });

  const tally = await dmGet(poll);
  expect(tally).toMatch(/2101-11-08 18:00[^<]*<\/strong> <strong>· works for everyone/);
  expect(tally).toContain("cid@example.org: <span");

  // --- The DM confirms Saturday ---------------------------------------------------------
  const revision = /name="revision" value="(\d+)"/.exec(tally)?.[1] ?? "";
  expect((await dm(`${poll}/confirm`, { revision, slot: "1" })).status).toBe(303);
  const confirmed = await dmGet(poll);
  expect(confirmed).toContain("2101-11-08 18:00 – 22:00 · Europe/Prague");
  // A late vote from a player's old link is refused, and says why.
  const late = lastLinkTo("ann@example.org", "/respond");
  expect(await (await asPlayer(late)).text()).toContain("Voting has closed.");

  // --- "Are you coming?" ----------------------------------------------------------------
  expect(await (await dm(`${poll}/links`)).text()).toContain("Sent to 5 people.");
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
  const final = await dmGet(poll);
  expect(final).toContain("4 going · 1 maybe · 0 can't make it");
  expect(final).toContain("dee@example.org: Maybe");
  expect(final).toMatch(/dee@example\.org: <span[^>]*>might be late<\/span>/);
  expect(final).toContain("status: proposed → scheduled");
  // …and the group page shows the session at its time.
  expect(await dmGet(group)).toContain("2101-11-08 18:00 – 22:00 · Europe/Prague");
});
