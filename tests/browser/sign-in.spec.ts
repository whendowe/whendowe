// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "./fixtures.js";

// The sign-in page on an instance with Google credentials (DESIGN §13 rc20): the email
// link first, then "Sign in with Google". Both are plain forms, so they work without
// JavaScript.

test("sign-in offers the email link and Google", async ({ page }) => {
  await page.goto(new URL("./.pages/sign-in.html", import.meta.url).href);
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  const google = page.getByRole("button", { name: "Sign in with Google" });
  await expect(google).toBeVisible();
  await expect(page.locator('form[method="post"][action="/oauth/google/sign-in"]')).toHaveCount(1);
  await expect(page).toHaveScreenshot("sign-in.png");
});
