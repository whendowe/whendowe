// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { diff } from "../../src/changelog.js";

it("produces a field-level diff", () => {
  expect(diff({ title: "Old", location: "Home" }, { title: "New", location: "Home" })).toEqual({
    title: { before: "Old", after: "New" },
  });
});

it("identical records produce an EMPTY diff (idempotent inbound apply, §11)", () => {
  expect(diff({ title: "Same", revision: 3 }, { title: "Same", revision: 3 })).toEqual({});
});

it("records added and removed fields against null", () => {
  expect(diff({ location: "Home" }, { description: "Bring cake" })).toEqual({
    location: { before: "Home", after: null },
    description: { before: null, after: "Bring cake" },
  });
});
