// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { createEvent } from "../../src/events/event.js";
import type { MailMessage } from "../../src/mail/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { googleNoticeRunner } from "../../src/web/routes/events.js";
import { loadMigrationSql } from "../conftest.js";

// The email for a change someone made in Google that isn't theirs to make here (DESIGN §10
// rc53, rc54): what it says, to whom, and that it never names what they can't see.

const T0 = "2101-11-20T10:00:00.000Z";
const BASE = "https://whendowe.example";
const FIELDS = {
  title: "Handover",
  description: null,
  location: null,
  allDay: false,
  startLocal: "2101-11-21T18:00",
  endLocal: "2101-11-21T19:00",
  tzid: "Europe/Prague",
};

async function setUp() {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const run = googleNoticeRunner({
    storage,
    now: () => T0,
    publicBaseUrl: BASE,
    mail: {
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    },
  });
  const [petr, ann, cy] = await Promise.all(
    ["petr", "ann", "cy"].map((n) => findOrCreatePerson(storage, `${n}@example.org`, { now: T0 })),
  );
  if (petr === undefined || ann === undefined || cy === undefined) throw new Error("people");
  await storage.batch(
    [
      [petr.id, "Petr"],
      [cy.id, "Cy"],
    ].map(([id, name]) => ({
      sql: "UPDATE person SET display_name = ? WHERE id = ?",
      params: [name ?? "", id ?? ""],
    })),
  );
  return { storage, sent, run, petr, ann, cy };
}

it("a proposal: what they did, who it waits for, and the link", async () => {
  const t = await setUp();
  const event = await createEvent(t.storage, {
    creatorId: t.petr.id,
    group: null,
    fields: FIELDS,
    now: T0,
    people: [
      { personId: t.ann.id, editTier: "propose", visibility: "FULL" },
      // Someone who may only view isn't who a proposal waits for.
      { personId: t.cy.id, editTier: "view", visibility: "FULL" },
    ],
  });
  const args = { eventId: event.id, outcome: "proposed", moved: true };
  expect(await t.run({ id: "h1", actorId: t.ann.id, threadId: null, args, now: T0 })).toBe(
    "Emailed you about your change in Google.",
  );
  expect(t.sent).toEqual([
    {
      to: "ann@example.org",
      subject: "Your change to “Handover” is a proposal",
      text: `You moved “Handover” in Google. It's a proposal now, waiting for Petr.\n\nUntil it's accepted, your calendar shows it as it is: ${BASE}/events/${event.id}`,
      cause: { kind: "self" },
    },
  ]);
});

it("waits for two editors by name, and past two for the people who can edit it", async () => {
  const t = await setUp();
  const dan = await findOrCreatePerson(t.storage, "dan@example.org", { now: T0 });
  const editors = [t.cy.id, dan.id];
  for (const [n, phrase] of [
    [1, "waiting for Petr and Cy."],
    [2, "waiting for the people who can edit it."],
  ] as const) {
    const event = await createEvent(t.storage, {
      creatorId: t.petr.id,
      group: null,
      fields: FIELDS,
      now: T0,
      people: [
        { personId: t.ann.id, editTier: "propose", visibility: "FULL" },
        ...editors
          .slice(0, n)
          .map((personId) => ({ personId, editTier: "edit", visibility: "FULL" }) as const),
      ],
    });
    await t.run({
      id: `h${n}`,
      actorId: t.ann.id,
      threadId: null,
      args: { eventId: event.id, outcome: "proposed" },
      now: T0,
    });
    expect(t.sent.at(-1)?.text).toContain(
      `You changed “Handover” in Google. It's a proposal now, ${phrase}`,
    );
  }
});

it("put back: it wasn't kept, and how to suggest something; a BUSY copy never names the event", async () => {
  const t = await setUp();
  const busy = await createEvent(t.storage, {
    creatorId: t.petr.id,
    group: null,
    fields: FIELDS,
    now: T0,
    people: [{ personId: t.ann.id, editTier: "view", visibility: "BUSY" }],
  });
  await t.run({
    id: "h1",
    actorId: t.ann.id,
    threadId: null,
    args: { eventId: busy.id, outcome: "put_back", moved: true },
    now: T0,
  });
  const [mail] = t.sent;
  const when = "an event on 2101-11-21 18:00 – 19:00 · Europe/Prague";
  expect(mail?.subject).toBe(`Your change to ${when} wasn't kept`);
  expect(mail?.text).toBe(
    `You moved ${when} in Google, but only the people who can edit it change it, so your calendar shows it as it was again.\n\nTo suggest something, leave a note on it: ${BASE}/events/${busy.id}`,
  );
  expect(`${mail?.subject} ${mail?.text}`).not.toContain("Handover");
});

it("sends nothing for an event gone, or someone no longer on it, or arguments it can't read", async () => {
  const t = await setUp();
  const event = await createEvent(t.storage, {
    creatorId: t.petr.id,
    group: null,
    fields: FIELDS,
    now: T0,
  });
  for (const [args, said] of [
    [{ eventId: "gone", outcome: "proposed" }, "The event is gone, so nobody was emailed."],
    [{ eventId: event.id, outcome: "proposed" }, "The event is gone, so nobody was emailed."], // Ann isn't on it
    [{ eventId: event.id, outcome: "something else" }, "Nothing to tell."],
    [null, "Nothing to tell."],
  ] as const) {
    expect(await t.run({ id: "h", actorId: t.ann.id, threadId: null, args, now: T0 })).toBe(said);
  }
  expect(t.sent).toEqual([]);
});
