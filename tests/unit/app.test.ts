// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createApp } from "../../src/web/app.js";

it("serves the hello page", async () => {
  const res = await createApp().request("/");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("WhenDoWe");
  // The page names the current milestone (it was "M0", then "M1", now "MVP-1").
  // Asserting the label, not weakening the assertion.
  expect(body).toContain("MVP-1");
});

it("serves a health check", async () => {
  const res = await createApp().request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
