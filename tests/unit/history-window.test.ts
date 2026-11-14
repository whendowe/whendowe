// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { HISTORY_DAYS, recentHistory } from "../../src/people/capability.js";
import { visibleHistory } from "../../src/web/routes/events.js";

// The 90-day window on history (DESIGN §10 rc43 `long_history`), at its boundary.

const NOW = "2101-11-01T09:00:00.000Z";
const DAY = 86_400_000;
const ago = (ms: number) => new Date(new Date(NOW).getTime() - ms).toISOString();

const entries = [
  { at: ago(0), id: "now" },
  { at: ago(HISTORY_DAYS * DAY), id: "exactly 90 days" },
  { at: ago(HISTORY_DAYS * DAY + 1), id: "a millisecond more" },
  { at: ago(400 * DAY), id: "long ago" },
];

it("without long_history: 90 days old shows, a millisecond older is hidden and counted", () => {
  const { shown, hidden } = recentHistory(entries, NOW, false);
  expect(shown.map((e) => e.id)).toEqual(["now", "exactly 90 days"]);
  expect(hidden).toBe(2);
});

it("with long_history: everything shows, nothing hidden", () => {
  const { shown, hidden } = recentHistory(entries, NOW, true);
  expect(shown).toEqual(entries);
  expect(hidden).toBe(0);
});

it("nothing older than 90 days: nothing is hidden", () => {
  expect(recentHistory(entries.slice(0, 2), NOW, false).hidden).toBe(0);
});

it("the page's line appears only when something was hidden", () => {
  expect(visibleHistory(entries.slice(0, 2), NOW, false).note).toBe("");
  expect(visibleHistory(entries, NOW, true).note).toBe("");
  expect(String(visibleHistory(entries, NOW, false).note)).toContain(
    "History older than 90 days isn&#39;t available to this account.",
  );
});
