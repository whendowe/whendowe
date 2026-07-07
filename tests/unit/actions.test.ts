// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type Action, actionReason, assertNever } from "../../src/reconcile/actions.js";

const FIELDS = {
  title: "t",
  description: null,
  location: null,
  startLocal: "2026-07-07T09:00:00",
  endLocal: "2026-07-07T10:00:00",
  tzid: null,
  allDay: false,
  rrule: null,
};

const INCOMING = {
  id: "p1",
  etag: "e1",
  fields: FIELDS,
  metadata: { canonicalUid: "evt-1" },
  isDeleted: false,
  recurringEventId: null,
};

describe("actionReason — the Action↔§14-log-vocabulary mapping", () => {
  it.each<[Action, string]>([
    [{ kind: "create_mirror", fields: FIELDS }, "pushed"],
    [{ kind: "push", providerEventId: "p1", fields: FIELDS }, "pushed"],
    [{ kind: "adopt_orphan", providerEventId: "p1", etag: "e1" }, "adopted_orphan"],
    [{ kind: "suppress_echo", incoming: INCOMING }, "echo_suppressed"],
    [{ kind: "apply_inbound", incoming: INCOMING }, "inbound_applied"],
    [{ kind: "delete_mirror", providerEventId: "p1" }, "inbound_delete_unsubscribed"],
    [{ kind: "noop" }, "skipped_unchanged"],
  ])("maps %o", (action, reason) => {
    expect(actionReason(action)).toBe(reason);
  });

  it("assertNever throws when reached at runtime", () => {
    // Cast justification: assertNever's parameter type is `never` by design — the
    // only way to pin its runtime backstop is to forge a value the type system
    // (correctly) says cannot exist. Type-level exhaustiveness is the real guarantee.
    expect(() => assertNever({ kind: "future_variant" } as never)).toThrow(/unreachable/);
  });
});
