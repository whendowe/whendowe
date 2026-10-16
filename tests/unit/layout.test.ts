// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { Html, html, renderPage } from "../../src/web/layout.js";

it("escapes every interpolated value by default", () => {
  const evil = '<img src=x onerror="alert(1)">';
  expect(html`<p>${evil}</p>`.value).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
});

it("escapes inside attribute values too", () => {
  expect(html`<input value="${'" autofocus onfocus="x'}">`.value).toBe(
    '<input value="&quot; autofocus onfocus=&quot;x">',
  );
});

it("passes nested html fragments through, still escaping their own values", () => {
  const inner = html`<b>${"<i>"}</b>`;
  expect(html`<p>${inner}</p>`.value).toBe("<p><b>&lt;i&gt;</b></p>");
});

it("renders arrays, numbers, and nothing for null/undefined/false", () => {
  expect(html`${[html`<li>${"a"}</li>`, html`<li>${"<b>"}</li>`]}`.value).toBe(
    "<li>a</li><li>&lt;b&gt;</li>",
  );
  expect(html`${3}|${null}|${undefined}|${false}`.value).toBe("3|||");
});

it("a plain string can never pass as Html", () => {
  // Only the tag constructs Html in production code; a string interpolated anywhere
  // is escaped, so markup cannot be smuggled in by forgetting to escape.
  expect(html`${"<b>raw</b>"}`.value).toBe("&lt;b&gt;raw&lt;/b&gt;");
  expect(html`${new Html("<b>ok</b>")}`.value).toBe("<b>ok</b>");
});

it("the page shell escapes its title", () => {
  expect(renderPage("<script>", html`<p>x</p>`)).toContain(
    "<title>&lt;script&gt; · WhenDoWe</title>",
  );
});
