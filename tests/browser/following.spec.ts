// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { expect, type Page, test } from "./fixtures.js";

// Calendars you follow (DESIGN §10 rc56), in a real browser: each calendar in its own colour,
// what its last read found, and Change — rename, recolour, stop — as plain forms, which work
// with JavaScript off as they do with it on (rc15).

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL("./.pages/following.html", import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

const item = (page: Page, name: string) =>
  page.locator(".follows > li").filter({ has: page.getByText(name, { exact: true }) });

test("each calendar in its colour, with what its last read found", async ({ page }) => {
  const errors = await open(page);
  await expect(page.getByRole("heading", { name: "Calendars you follow" })).toBeVisible();
  const lindy = item(page, "Lindy Hop");
  await expect(lindy).toContainText("2 events in the next 60 days");
  await expect(item(page, "cinema.example")).toContainText("Couldn't read this calendar.");
  await expect(page.getByRole("heading", { name: "Thursday Table" })).toBeVisible();
  await expect(item(page, "Board game café")).toContainText("1 event in the next 60 days");
  // Each its own colour, as its bar: the renamed one in the colour it was given.
  const bar = async (name: string) => {
    const id = z.string().parse(await item(page, name).getAttribute("id"));
    return z
      .string()
      .parse(
        await page.evaluate(`getComputedStyle(document.getElementById("${id}")).borderLeftColor`),
      );
  };
  const colours = new Set([await bar("Lindy Hop"), await bar("Board game café")]);
  expect(colours.size).toBe(2);
  await expect(page).toHaveScreenshot("following.png", { fullPage: true });
  await lindy.locator("summary").click();
  await expect(lindy.getByRole("textbox", { name: "Name" })).toHaveValue("Lindy Hop");
  await expect(lindy.getByRole("radio", { name: "3" })).toBeChecked();
  await expect(lindy).toHaveScreenshot("following-change.png");
  expect(errors).toEqual([]);
});

test.describe("without JavaScript (DESIGN rc15: every form works without it)", () => {
  test.use({ javaScriptEnabled: false });

  test("following, and every change, is a form", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("textbox", { name: "Calendar link" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "For" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Follow" })).toBeVisible();
    const lindy = item(page, "Lindy Hop");
    await lindy.locator("summary").click();
    for (const name of ["Rename", "Change colour", "Stop following"])
      await expect(lindy.getByRole("button", { name })).toBeVisible();
  });
});
