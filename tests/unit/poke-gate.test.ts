// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { PokeGate } from "../../src/reconcile/watch.js";

// One connection's single writer and Google's pokes (DESIGN §10 rc53): every poke gets a read
// that starts after it arrived; pokes during a tick are one read when it ends; the cron's own
// tick asked for during one is refused, as before.

it("runs when nothing is running, and is free again once the tick ends", () => {
  const gate = new PokeGate();
  expect(gate.arrive(true)).toBe("run");
  expect(gate.ended()).toBe(false);
  expect(gate.arrive(true)).toBe("run");
});

it("pokes during a tick are one more read after it, however many", () => {
  const gate = new PokeGate();
  expect(gate.arrive(false)).toBe("run");
  expect(gate.arrive(true)).toBe("queued");
  expect(gate.arrive(true)).toBe("queued");
  expect(gate.ended()).toBe(true); // read once more
  expect(gate.arrive(true)).toBe("queued"); // one during that read: once more again
  expect(gate.ended()).toBe(true);
  expect(gate.ended()).toBe(false);
  expect(gate.arrive(false)).toBe("run");
});

it("the cron's tick during one is refused; released, nothing is left running or queued", () => {
  const gate = new PokeGate();
  expect(gate.arrive(true)).toBe("run");
  expect(gate.arrive(false)).toBe("busy");
  expect(gate.arrive(true)).toBe("queued");
  gate.release();
  expect(gate.arrive(false)).toBe("run");
  expect(gate.ended()).toBe(false);
});
