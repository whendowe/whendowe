// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bytesToBase64 } from "../../src/crypto/base64.js";
import { createApp } from "../../src/web/app.js";
import { CONTENT_SECURITY_POLICY, SCRIPT_HASHES } from "../../src/web/csp.js";
import { SHARE_BUTTONS, ZONE_GUESS } from "../../src/web/layout.js";
import { pickerAssets } from "../../src/web/picker.js";
import { planAssets } from "../../src/web/plan-editor.js";

// The CSP allows scripts by hash (DESIGN §13 rc21). These tests tie the hashes to the
// scripts the pages actually ship, so changing a script without updating csp.ts fails
// here, with the value to paste, rather than silently in a browser.

const SHIPPED = [ZONE_GUESS.value, SHARE_BUTTONS.value, pickerAssets().value, planAssets().value];

function bodyOf(assets: string): string {
  const start = assets.indexOf("<script>");
  const end = assets.lastIndexOf("</script>");
  if (start === -1 || end === -1) throw new Error("no inline script");
  return assets.slice(start + "<script>".length, end);
}

async function hashOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256-${bytesToBase64(new Uint8Array(digest))}`;
}

it("allows exactly the scripts the pages ship, by hash", async () => {
  const actual = await Promise.all(SHIPPED.map((a) => hashOf(bodyOf(a))));
  expect([...SCRIPT_HASHES].sort(), `paste into src/web/csp.ts: ${JSON.stringify(actual)}`).toEqual(
    [...actual].sort(),
  );
});

it("every inline script in src/web is one of those", () => {
  // A new <script> anywhere must join SHIPPED above, or it would be blocked unseen.
  const dir = new URL("../../src/web/", import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".ts"),
  );
  const count = files
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((line) => !/^\s*(\/\/|\*)/.test(line)) // comments may mention the tag
    .map((line) => line.split("<script").length - 1)
    .reduce((a, b) => a + b, 0);
  expect(count).toBe(SHIPPED.length);
});

it("never allows inline or evaluated script, and forbids framing", () => {
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline' 'sha");
  expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
});

it("every response carries the headers, a route's own Referrer-Policy wins", async () => {
  const app = createApp();
  for (const path of ["/", "/healthz", "/no-such-page"]) {
    const res = await app.request(path);
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  }
  // The page carries the same policy for pages opened as files (the browser tier).
  expect(await (await app.request("/")).text()).toContain('http-equiv="Content-Security-Policy"');
});
