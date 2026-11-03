// SPDX-License-Identifier: AGPL-3.0-or-later
// Invites first: this file's first import decides the order the modules load in, as the
// sign-in route's import of shared links (via notes and responses) does.
import "../../src/people/invite.js";
import { expect, it } from "vitest";
import type { StoragePort } from "../../src/db/port.js";
import { groupDefaults } from "../../src/events/participation.js";

// participation.ts once took its tier schemas from invite.ts, closing a cycle
// (invite → suppression → erasure → event → participation → invite): loaded invites
// first, its row schema saw `undefined` and every event write failed. The tiers live in
// group.ts now; this pins that they are there whichever module loads first.

it("participation reads tiers when invites loaded first", async () => {
  const storage: StoragePort = {
    query: async () => [{ person_id: "p", default_edit_tier: "edit", default_visibility: "FULL" }],
    batch: async () => {},
  };
  const membership = { group: { id: "g", name: "G", createdAt: "" }, role: "member" } as const;
  expect(await groupDefaults(storage, membership)).toEqual([
    { personId: "p", editTier: "edit", visibility: "FULL" },
  ]);
});
