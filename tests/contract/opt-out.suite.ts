// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { createEvent } from "../../src/events/event.js";
import type { MailMessage } from "../../src/mail/port.js";
import { createGroup, findGroupForMember, leaveGroup } from "../../src/people/group.js";
import { createInvite } from "../../src/people/invite.js";
import { issueLoginToken } from "../../src/people/login.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { createSession } from "../../src/people/session.js";
import { eraseAccount } from "../../src/privacy/erasure.js";
import { retentionPass } from "../../src/privacy/purge.js";
import {
  addressHash,
  deleteEverything,
  OPT_OUT_TTL_MS,
  peekOptOut,
  suppress,
  suppressingMailPort,
} from "../../src/privacy/suppression.js";
import { everywhere } from "./erasure.suite.js";

// Opt-outs (DESIGN §10 rc24 *People who never signed up*) on BOTH drivers. Tests in one
// file share a database: each uses its own addresses and checks only its own rows.

const T0 = "2101-11-01T10:00:00.000Z";
const BASE = "https://whendowe.example";

function recorder() {
  const sent: MailMessage[] = [];
  const send = (m: MailMessage) => {
    sent.push(m);
    return Promise.resolve();
  };
  return { sent, inner: { send } };
}

const tokenIn = (m: MailMessage | undefined) =>
  new URL(/https:\/\/\S+\/opt-out\?t=\S+/.exec(m?.text ?? "")?.[0] ?? `${BASE}/`).searchParams.get(
    "t",
  ) ?? "";

async function organizer(port: StoragePort, tag: string) {
  const dm = await findOrCreatePerson(port, `dm-${tag}@example.org`, { now: T0 });
  const group = await createGroup(port, { name: `Table ${tag}`, creatorId: dm.id, now: T0 });
  const membership = await findGroupForMember(port, group.id, dm.id);
  if (membership === null) throw new Error("expected membership");
  return { dm, group, membership };
}

export function runOptOutContract(makePort: () => Promise<StoragePort>): void {
  describe("opt-outs (DESIGN §10 rc24)", () => {
    it("mail the address asked for passes untouched; mail others cause gets its own 90-day link", async () => {
      const port = await makePort();
      const { sent, inner } = recorder();
      const { dm, group } = await organizer(port, "a");
      const mail = suppressingMailPort(inner, port, { publicBaseUrl: BASE, now: () => T0 });
      await mail.send({
        to: "ana-a@example.org",
        subject: "s",
        text: "body",
        cause: { kind: "self" },
      });
      expect(sent[0]?.text).toBe("body");
      const from = {
        kind: "from",
        senderId: dm.id,
        groupId: group.id,
        why: "dm invited you",
      } as const;
      await mail.send({ to: "ana-a@example.org", subject: "s", text: "body", cause: from });
      await mail.send({ to: "ana-a@example.org", subject: "s", text: "body", cause: from });
      expect(sent[1]?.text).toContain("You got this because dm invited you.");
      // Each email its own link, so an older one still works.
      const first = tokenIn(sent[1]);
      expect(first).not.toBe(tokenIn(sent[2]));
      const link = await peekOptOut(port, first, T0);
      expect(link).toEqual({
        email: "ana-a@example.org",
        senderId: dm.id,
        groupId: group.id,
        neverSignedIn: true,
      });
      // Ninety days (§10 rc24), to the minute.
      expect(await peekOptOut(port, first, "2102-01-30T09:59:00.000Z")).not.toBeNull();
      expect(await peekOptOut(port, first, "2102-01-30T10:00:00.000Z")).toBeNull();
      const later = new Date(Date.parse(T0) + OPT_OUT_TTL_MS).toISOString();
      expect(await peekOptOut(port, first, later)).toBeNull();
      expect(await peekOptOut(port, "not-a-token", T0)).toBeNull();
    });

    it("an opt-out stops what it names and nothing else, and a dropped send never reaches the cap", async () => {
      const port = await makePort();
      const { sent, inner } = recorder();
      const a = await organizer(port, "b1");
      const b = await organizer(port, "b2");
      const mail = suppressingMailPort(inner, port, { publicBaseUrl: BASE, now: () => T0 });
      const to = "ana-b@example.org";
      const send = (senderId: string, groupId: string | null) =>
        mail.send({
          to,
          subject: "s",
          text: "t",
          cause: { kind: "from", senderId, groupId, why: "w" },
        });
      const count = async (f: () => Promise<void>) => {
        const before = sent.length;
        await f();
        return sent.length - before;
      };

      await suppress(port, to, { kind: "group", id: a.group.id }, T0);
      expect(await count(() => send(a.dm.id, a.group.id))).toBe(0);
      expect(await count(() => send(a.dm.id, null))).toBe(1); // the same person, not through it
      await suppress(port, to, { kind: "person", id: b.dm.id }, T0);
      expect(await count(() => send(b.dm.id, b.group.id))).toBe(0);
      expect(await count(() => send(b.dm.id, null))).toBe(0);
      expect(await count(() => send(a.dm.id, b.group.id))).toBe(1); // someone else, same group
      await suppress(port, to, { kind: "all" }, T0);
      expect(await count(() => send(a.dm.id, null))).toBe(0);
      // Never their own request: opting out never stops anyone signing in.
      expect(
        await count(() => mail.send({ to, subject: "s", text: "t", cause: { kind: "self" } })),
      ).toBe(1);
      // An opt-out keeps no address: only its hash.
      const rows = await port.query({
        sql: "SELECT * FROM mail_suppression WHERE address_hash = ?",
        params: [await addressHash(to)],
      });
      expect(rows).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain(to);
      // From everyone, its links go too: they hold the address.
      expect(
        await port.query({ sql: "SELECT 1 FROM opt_out_token WHERE email = ?", params: [to] }),
      ).toHaveLength(0);
    });

    it("deleting everything about an address that never signed in leaves nothing of it", async () => {
      const port = await makePort();
      const { sent, inner } = recorder();
      const { dm, membership } = await organizer(port, "c");
      const ana = await findOrCreatePerson(port, "ana-c@example.org", { now: T0 });
      await createEvent(port, {
        creatorId: dm.id,
        group: null,
        fields: {
          title: "Picnic",
          description: null,
          location: null,
          allDay: false,
          startLocal: "2101-11-20T12:00",
          endLocal: "2101-11-20T15:00",
          tzid: "Europe/Prague",
        },
        people: [{ personId: ana.id, editTier: "view", visibility: "FULL" }],
        now: T0,
      });
      await createInvite(port, membership, {
        email: "ana-c@example.org",
        invitedBy: dm.id,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      await issueLoginToken(port, "ana-c@example.org", { now: T0 });
      const mail = suppressingMailPort(inner, port, { publicBaseUrl: BASE, now: () => T0 });
      await mail.send({
        to: "ana-c@example.org",
        subject: "s",
        text: "t",
        cause: { kind: "from", senderId: dm.id, groupId: null, why: "w" },
      });
      expect(await everywhere(port)).toContain("ana-c@example.org");

      expect(await deleteEverything(port, "ana-c@example.org", T0)).toBe(true);
      expect(await everywhere(port)).not.toContain("ana-c@example.org");
      expect(await everywhere(port)).not.toContain(ana.id);
      // …and nothing is sent to it again, from anyone.
      await mail.send({
        to: "ana-c@example.org",
        subject: "s",
        text: "t",
        cause: { kind: "from", senderId: dm.id, groupId: null, why: "w" },
      });
      expect(sent).toHaveLength(1);
      // An address no person has: its invites and sign-in links go.
      await createInvite(port, membership, {
        email: "bo-c@example.org",
        invitedBy: dm.id,
        editTier: "view",
        visibility: "FULL",
        now: T0,
      });
      await issueLoginToken(port, "bo-c@example.org", { now: T0 });
      expect(await deleteEverything(port, "bo-c@example.org", T0)).toBe(true);
      expect(await everywhere(port)).not.toContain("bo-c@example.org");
    });

    it("an address that has signed in can't be deleted from a link, and nothing is written", async () => {
      const port = await makePort();
      const kim = await findOrCreatePerson(port, "kim-d@example.org", { now: T0 });
      await createSession(port, kim.id, { now: T0 });
      const before = await everywhere(port);
      expect(await deleteEverything(port, "kim-d@example.org", T0)).toBe(false);
      expect(await everywhere(port)).toBe(before);
      const { dm } = await organizer(port, "d");
      const sent = recorder();
      const mail = suppressingMailPort(sent.inner, port, { publicBaseUrl: BASE, now: () => T0 });
      await mail.send({
        to: "kim-d@example.org",
        subject: "s",
        text: "t",
        cause: { kind: "from", senderId: dm.id, groupId: null, why: "w" },
      });
      expect((await peekOptOut(port, tokenIn(sent.sent[0]), T0))?.neverSignedIn).toBe(false);
    });

    it("an opt-out from a person goes when they do, and one from a group with the group", async () => {
      const port = await makePort();
      const { dm, group, membership } = await organizer(port, "f");
      const to = "ana-f@example.org";
      await suppress(port, to, { kind: "person", id: dm.id }, T0);
      await suppress(port, to, { kind: "group", id: group.id }, T0);
      await suppress(port, to, { kind: "all" }, T0);
      const scopes = async () =>
        (
          await port.query({
            sql: "SELECT scope FROM mail_suppression WHERE address_hash = ? ORDER BY scope",
            params: [await addressHash(to)],
          })
        ).map((r) => r.scope);
      expect(await scopes()).toEqual(["all", "group", "person"]);
      // dm leaves (the group goes with its last member), then is erased.
      await leaveGroup(port, membership, dm.id, T0);
      expect(await scopes()).toEqual(["all", "person"]);
      await eraseAccount(port, dm.id, { now: T0 });
      expect(await scopes()).toEqual(["all"]);
    });

    it("expired links go in the retention pass", async () => {
      const port = await makePort();
      const { sent, inner } = recorder();
      const { dm } = await organizer(port, "e");
      const mail = suppressingMailPort(inner, port, { publicBaseUrl: BASE, now: () => T0 });
      await mail.send({
        to: "ana-e@example.org",
        subject: "s",
        text: "t",
        cause: { kind: "from", senderId: dm.id, groupId: null, why: "w" },
      });
      const left = () =>
        port.query({
          sql: "SELECT 1 FROM opt_out_token WHERE email = ?",
          params: ["ana-e@example.org"],
        });
      const expiry = Date.parse(T0) + OPT_OUT_TTL_MS;
      await retentionPass(port, new Date(expiry - 60_000).toISOString());
      expect(await left()).toHaveLength(1);
      await retentionPass(port, new Date(expiry + 60_000).toISOString());
      expect(await left()).toHaveLength(0);
      expect(sent).toHaveLength(1);
    });
  });
}
