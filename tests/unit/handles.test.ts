// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { guestName, handleSchema, shownAs } from "../../src/people/person.js";

// How a person appears to others (DESIGN §10 rc21): the pure part.

const row = (over: Partial<Parameters<typeof shownAs>[1]> = {}) => ({
  email: "lena@example.org",
  display_name: null,
  handle: null,
  show_email: 0,
  ...over,
});

it("the container's handle wins, then the account's, then a guest name", () => {
  expect(shownAs("p1", row({ handle: "Kestrel", display_name: "Lena" }), "g1").name).toBe(
    "Kestrel",
  );
  expect(shownAs("p1", row({ display_name: "Lena" }), "g1").name).toBe("Lena");
  expect(shownAs("p1", row(), "g1").name).toBe(guestName("g1", "p1"));
});

it("an address is shown only where its owner turned it on", () => {
  expect(shownAs("p1", row(), "g1").email).toBeNull();
  expect(shownAs("p1", row({ show_email: null }), "g1").email).toBeNull(); // no row here
  expect(shownAs("p1", row({ show_email: 1 }), "g1").email).toBe("lena@example.org");
});

it("a guest name is stable in one place, differs between places, and holds nothing of the address", () => {
  expect(guestName("g1", "p1")).toBe(guestName("g1", "p1"));
  expect(guestName("g1", "p1")).toMatch(/^Guest \d{4}$/);
  // Different containers give (almost always) different names: try a few.
  const names = new Set(["g1", "g2", "g3", "g4", "g5"].map((g) => guestName(g, "p1")));
  expect(names.size).toBeGreaterThan(1);
});

it("a handle is 1–40 characters of text, trimmed", () => {
  expect(handleSchema.parse("  Kestrel ")).toBe("Kestrel");
  expect(handleSchema.safeParse("").success).toBe(false);
  expect(handleSchema.safeParse("   ").success).toBe(false);
  expect(handleSchema.safeParse("x".repeat(41)).success).toBe(false);
  expect(handleSchema.safeParse("a\u0000b").success).toBe(false);
  expect(handleSchema.safeParse("a\nb").success).toBe(false);
  expect(handleSchema.parse("Zoë 🌙")).toBe("Zoë 🌙");
});
