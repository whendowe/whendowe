// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { TICK_URL } from "../../deploy/cloudflare/connection-do.js";

// The Durable Object per connection (DESIGN §11, MVP-4 G2 part 4) in workerd: the cron's one
// request is "tick this connection"; anything else is refused, and an instance with no Google
// client configured pushes nothing.

const stub = (name: string) => env.CONNECTION_DO.get(env.CONNECTION_DO.idFromName(name));

it("refuses anything but a POST naming a connection", async () => {
  const s = stub("c-refuse");
  expect((await s.fetch(TICK_URL)).status).toBe(400);
  expect((await s.fetch(TICK_URL, { method: "POST", body: "not json" })).status).toBe(400);
  expect((await s.fetch(TICK_URL, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  expect(
    (await s.fetch(TICK_URL, { method: "PUT", body: JSON.stringify({ connectionId: "c" }) }))
      .status,
  ).toBe(400);
});

it("without a Google client configured, a tick pushes nothing", async () => {
  const res = await stub("c-none").fetch(TICK_URL, {
    method: "POST",
    body: JSON.stringify({ connectionId: "c-none" }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ outcome: "unconfigured" });
});
