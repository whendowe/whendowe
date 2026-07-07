// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Settings } from "@hegeldev/hegel";

// Gate vs soak (DESIGN.md §9): the same property suite runs with a modest budget
// in `npm run check` (Hegel's default) and a large one in nightly `npm run soak`.
// Bug-finding power scales with interleavings explored; the gate must not pay
// that cost on every commit.
export const propertySettings: Partial<Settings> =
  process.env.SOAK === undefined ? {} : { testCases: 5000 };
