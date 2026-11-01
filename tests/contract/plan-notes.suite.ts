// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { addVoteNote, listNotes, noteTouches } from "../../src/plans/note.js";
import { acceptPlan, createPollThread, PlanInputError, suggestTime } from "../../src/plans/plan.js";
import { findThreadForMember, leaveThread } from "../../src/plans/thread.js";

// Notes with votes (DESIGN §10 rc28, P5's first slice) on BOTH drivers. Residue-tolerant:
// every test uses its own people.

const T0 = "2101-10-01T10:00:00.000Z";
const T1 = "2101-10-01T11:00:00.000Z";

async function poll(port: StoragePort, tag: string) {
  const [mara, david, ana] = await Promise.all(
    ["mara", "david", "ana"].map((n) =>
      findOrCreatePerson(port, `note-${n}-${tag}@example.org`, { now: T0 }),
    ),
  );
  if (mara === undefined || david === undefined || ana === undefined) throw new Error("people");
  const { threadId, planIds } = await createPollThread(port, {
    creatorId: mara.id,
    group: null,
    fields: {
      title: "Dinner",
      description: null,
      location: null,
      allDay: false,
      tzid: "Europe/Prague",
    },
    candidates: [
      { startLocal: "2101-11-21T19:00", endLocal: "2101-11-21T22:00" },
      // Ends after midnight: still the 14th and the 15th.
      { startLocal: "2101-11-14T22:00", endLocal: "2101-11-15T01:00" },
    ],
    people: [david.id, ana.id],
    now: T0,
  });
  const as = async (id: string) => {
    const a = await findThreadForMember(port, threadId, id);
    if (a === null) throw new Error("member");
    return a;
  };
  return { mara, david, ana, threadId, planIds, as };
}

export function runPlanNotesContract(makePort: () => Promise<StoragePort>): void {
  describe("notes with votes (rc28)", () => {
    it("a note lies on the days from the first to the last time on the table, attributed", async () => {
      const port = await makePort();
      const f = await poll(port, "a");
      const added = await addVoteNote(port, await f.as(f.david.id), {
        body: "  Thursday's bad next week  ",
        now: T1,
      });
      expect(added.kind).toBe("added");
      // A time suggested later, before the others: the days still run earliest to latest.
      const later = await suggestTime(port, await f.as(f.ana.id), {
        planId: f.planIds[0] ?? "",
        startLocal: "2101-11-07T19:00",
        endLocal: "2101-11-07T22:00",
        now: T1,
      });
      expect(later.kind).toBe("suggested");
      await addVoteNote(port, await f.as(f.ana.id), { body: "wider", now: T1 });
      expect((await listNotes(port, await f.as(f.ana.id)))[1]).toMatchObject({
        firstDay: "2101-11-07",
        lastDay: "2101-11-21",
      });
      expect((await listNotes(port, await f.as(f.ana.id))).slice(0, 1)).toMatchObject([
        {
          authorId: f.david.id,
          firstDay: "2101-11-14",
          lastDay: "2101-11-21",
          body: "Thursday's bad next week",
          createdAt: T1,
        },
      ]);
    });

    it("refuses an empty or too-long note, and one with nothing on the table", async () => {
      const port = await makePort();
      const f = await poll(port, "b");
      const david = await f.as(f.david.id);
      await expect(addVoteNote(port, david, { body: "   ", now: T1 })).rejects.toBeInstanceOf(
        PlanInputError,
      );
      await expect(
        addVoteNote(port, david, { body: "x".repeat(501), now: T1 }),
      ).rejects.toBeInstanceOf(PlanInputError);
      expect((await addVoteNote(port, david, { body: "x".repeat(500), now: T1 })).kind).toBe(
        "added",
      );
      await acceptPlan(port, await f.as(f.mara.id), { planId: f.planIds[0] ?? "", now: T1 });
      expect(await addVoteNote(port, david, { body: "late", now: T1 })).toEqual({
        kind: "closed",
      });
    });

    it("fifty notes a person a thread, as event feedback", async () => {
      const port = await makePort();
      const f = await poll(port, "c");
      const david = await f.as(f.david.id);
      for (let i = 0; i < 50; i++) await addVoteNote(port, david, { body: `n${i}`, now: T1 });
      await expect(addVoteNote(port, david, { body: "one more", now: T1 })).rejects.toThrow(
        /a lot of notes/,
      );
      // Someone else still can.
      expect((await addVoteNote(port, await f.as(f.ana.id), { body: "me", now: T1 })).kind).toBe(
        "added",
      );
    });

    it("someone else's private note isn't listed; your own is; leaving takes yours", async () => {
      const port = await makePort();
      const f = await poll(port, "d");
      for (const [id, author, priv] of [
        ["note-d-1", f.david.id, 1],
        ["note-d-2", f.ana.id, 1],
      ] as const)
        await port.batch([
          {
            sql: `INSERT INTO plan_note (id, thread_id, author_id, first_day, last_day, body, private, created_at)
                  VALUES (?, ?, ?, '2101-11-14', '2101-11-14', 'mine', ?, ?)`,
            params: [id, f.threadId, author, priv, T0],
          },
        ]);
      expect((await listNotes(port, await f.as(f.david.id))).map((n) => n.id)).toEqual([
        "note-d-1",
      ]);
      await addVoteNote(port, await f.as(f.david.id), { body: "public", now: T1 });
      await leaveThread(port, await f.as(f.david.id), T1);
      expect(await listNotes(port, await f.as(f.ana.id))).toMatchObject([{ id: "note-d-2" }]);
    });

    it("a note touches the days it overlaps, ends included", () => {
      const n = {
        id: "n",
        authorId: "a",
        firstDay: "2101-11-14",
        lastDay: "2101-11-21",
        body: "",
        createdAt: T0,
      };
      expect(noteTouches(n, "2101-11-21", "2101-11-22")).toBe(true);
      expect(noteTouches(n, "2101-11-10", "2101-11-14")).toBe(true);
      expect(noteTouches(n, "2101-11-22", "2101-11-23")).toBe(false);
      expect(noteTouches(n, "2101-11-12", "2101-11-13")).toBe(false);
    });
  });
}
