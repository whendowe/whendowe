// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

it("applies defaults for an empty environment", () => {
  const config = loadConfig({});
  expect(config.PORT).toBe(8080);
  expect(config.DATABASE_URL).toBe("file:data/whendowe.db");
  expect(config.LOG_LEVEL).toBe("info");
});

it("coerces PORT from string", () => {
  expect(loadConfig({ PORT: "3000" }).PORT).toBe(3000);
});

it("rejects an invalid PORT loudly", () => {
  expect(() => loadConfig({ PORT: "not-a-port" })).toThrow();
  expect(() => loadConfig({ PORT: "70000" })).toThrow();
});

it("rejects an invalid LOG_LEVEL loudly", () => {
  expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow();
});
