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
  expect(renderPage("<script>", html`<p>x</p>`, null)).toContain(
    "<title>&lt;script&gt; · WhenDoWe</title>",
  );
});

const viewer = {
  email: "ann@example.org",
  csrfToken: "csrf-ann",
  others: [{ sessionId: "s-bob", email: "bob@example.org" }],
  canAddAccount: true,
  here: "/groups",
  deletesAt: null,
};

it("a signed-in page names its account in the header, with the menu (rc18)", () => {
  const page = renderPage("Groups", html`<h1>Groups</h1>`, viewer);
  expect(page).toMatch(/<summary>.*Signed in as.*<strong>ann@example\.org<\/strong>/s);
  expect(page).toContain('<input type="hidden" name="session" value="s-bob" />');
  expect(page).toContain("Switch to <strong>bob@example.org</strong>");
  expect(page).toContain('<input type="hidden" name="back" value="/groups" />');
  expect(page).toContain("Add another account");
  expect(page).toContain("Sign out of all accounts on this browser");
  // Every action in the menu is a POST that carries the active account's CSRF token.
  expect(page.match(/<form method="post"/g)?.length).toBe(3);
  expect(page.match(/name="csrf" value="csrf-ann"/g)?.length).toBe(3);
});

it("the header escapes what it shows, and a lone account has no 'all' button", () => {
  const page = renderPage("x", html``, {
    ...viewer,
    email: "<img src=x>@example.org",
    others: [],
    canAddAccount: false,
  });
  expect(page).toContain("&lt;img src=x&gt;@example.org");
  expect(page).not.toContain("<img src=x>");
  expect(page).not.toContain("Sign out of all");
  expect(page).not.toContain("Add another account");
});

it("a page with no account signed in has no header", () => {
  expect(renderPage("x", html`<p>x</p>`, null)).not.toContain('class="wd-top"');
});
