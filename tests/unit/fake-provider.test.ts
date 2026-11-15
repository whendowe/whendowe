// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { ProviderEventGoneError } from "../../src/providers/base.js";
import { FakeCalendarProvider } from "../../src/providers/fake.js";

// The fake keeps the port's promises the real provider does (§9), so the push tick's tests
// against it mean something: here, that a copy deleted in the provider is never revived.

const FIELDS = {
  title: "t",
  description: null,
  location: null,
  startLocal: "2026-09-13T09:00:00",
  endLocal: "2026-09-13T10:00:00",
  tzid: "Europe/Prague",
  allDay: false,
  rrule: null,
  sourceUrl: null,
};

it("updates a copy it has, and refuses one deleted there or never made", async () => {
  const fake = new FakeCalendarProvider();
  const { id } = await fake.upsert(null, FIELDS, { canonicalUid: "evt-1" });
  const updated = await fake.upsert(id, { ...FIELDS, title: "u" }, { canonicalUid: "evt-1" });
  expect(updated.id).toBe(id);
  expect((await fake.findByMetadata("evt-1"))?.fields.title).toBe("u");

  await fake.delete(id);
  await expect(fake.upsert(id, FIELDS, { canonicalUid: "evt-1" })).rejects.toThrow(
    ProviderEventGoneError,
  );
  await expect(fake.upsert("never", FIELDS, { canonicalUid: "evt-1" })).rejects.toThrow(
    ProviderEventGoneError,
  );
  expect(await fake.findByMetadata("evt-1")).toBeNull();
});
