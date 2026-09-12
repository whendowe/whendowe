// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { escapeHtml } from "../../src/web/escape.js";

it("escapes the five characters that matter", () => {
  expect(escapeHtml("&")).toBe("&amp;");
  expect(escapeHtml("<")).toBe("&lt;");
  expect(escapeHtml(">")).toBe("&gt;");
  expect(escapeHtml('"')).toBe("&quot;");
  expect(escapeHtml("'")).toBe("&#39;");
});

it("does not double-escape ampersands", () => {
  // `&` must be replaced first, or "<" would become "&amp;lt;".
  expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
  expect(escapeHtml("a & b")).toBe("a &amp; b");
  expect(escapeHtml("&amp;")).toBe("&amp;amp;");
});

it("neutralises a script tag", () => {
  expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("neutralises an attribute break-out", () => {
  // The quote characters are why this must also be safe inside an attribute value.
  expect(escapeHtml('" onerror="alert(1)')).toBe("&quot; onerror=&quot;alert(1)");
  expect(escapeHtml("' onerror='alert(1)")).toBe("&#39; onerror=&#39;alert(1)");
});

it("leaves ordinary text and non-ASCII alone", () => {
  expect(escapeHtml("Someone's calendar")).toBe("Someone&#39;s calendar");
  expect(escapeHtml("réunion 会議 🗓️")).toBe("réunion 会議 🗓️");
  expect(escapeHtml("")).toBe("");
});
