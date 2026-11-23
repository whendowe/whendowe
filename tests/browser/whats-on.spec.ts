// SPDX-License-Identifier: AGPL-3.0-or-later
import { answerBusy, asked } from "./busy.js";
import { expect, type Page, test } from "./fixtures.js";

// What's on when you're free (DESIGN §10 rc58), in a real browser: the next two weeks of what
// is followed, by day, each in its calendar's colour; what clashes left out, and shown dimmed
// by a link; a followed event's sheet with Invite people — links and a form, which work with
// JavaScript off as they do with it on (rc15).

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("what's on when you're free, and what clashes, dimmed", async ({ page }) => {
  const errors = await open(page, "whats-on");
  await expect(page.getByRole("heading", { name: "What's on", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Thursday 29 October" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Game night" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beginners' class" })).toBeVisible();
  // The social overlaps the DM's own Friday: left out, and said so.
  await expect(page.getByRole("link", { name: "Friday social" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Show what clashes" })).toBeVisible();
  await expect(page).toHaveScreenshot("whats-on.png", { fullPage: true });

  await open(page, "whats-on-clashes");
  const social = page.locator(".on > li.clash");
  await expect(social).toHaveCount(1);
  await expect(social).toContainText("Friday social");
  await expect(social).toContainText("You have something then");
  await expect(page).toHaveScreenshot("whats-on-clashes.png", { fullPage: true });
  expect(errors).toEqual([]);
});

// F2b: the page's script asks for Google's busy times (rc41) and takes out what overlaps them.
// The beginners' class, Tuesday 19:00–20:30 in Prague, meets a Google busy hour from 18:00 UTC.
const GOOGLE = [{ allDay: false, start: "2026-11-03T18:00", end: "2026-11-03T19:00" }];

test("Google's busy times take out what overlaps them, or dim it when clashes are shown", async ({
  page,
}) => {
  await answerBusy(page, { status: 200, busy: GOOGLE, google: "shown" });
  const errors = await open(page, "whats-on");
  await expect(page.locator(".busynote")).toHaveText("Your Google busy times are counted too.");
  await expect(page.getByRole("link", { name: "Beginners' class" })).toBeHidden();
  // Its day had nothing else: the heading goes too.
  await expect(page.getByRole("heading", { name: "Tuesday 3 November" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Game night" })).toBeVisible();
  // One left out by the server, one by Google.
  await expect(page.locator("[data-clash-toggle]")).toContainText(
    "(2 events overlap something of yours)",
  );
  // The same days the server counted, in UTC.
  expect(await asked(page)).toEqual(["/busy?from=2026-10-23&to=2026-11-08&tz=UTC"]);
  await expect(page).toHaveScreenshot("whats-on-google.png", { fullPage: true });

  await open(page, "whats-on-clashes");
  const clash = page.locator(".on > li.clash");
  await expect(clash).toHaveCount(2);
  await expect(clash.filter({ hasText: "Beginners' class" })).toContainText(
    "You have something then",
  );
  expect(errors).toEqual([]);
});

test("says when Google's busy times couldn't be loaded, and takes nothing out", async ({
  page,
}) => {
  await answerBusy(page, { status: 200, busy: [], google: "failed" });
  const errors = await open(page, "whats-on");
  await expect(page.locator(".busynote")).toHaveText("Couldn't load your Google busy times.");
  await expect(page.getByRole("link", { name: "Beginners' class" })).toBeVisible();
  await expect(page.locator("[data-clash-toggle]")).toContainText(
    "(1 event overlaps something of yours)",
  );
  expect(errors).toEqual([]);
});

test("an answer that isn't one changes nothing", async ({ page }) => {
  await answerBusy(page, { status: 500, busy: GOOGLE, google: "shown" });
  const errors = await open(page, "whats-on");
  await expect(page.getByRole("link", { name: "Beginners' class" })).toBeVisible();
  await expect(page.locator(".busynote")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a followed event's sheet, with Going and Invite people", async ({ page }) => {
  const errors = await open(page, "whats-on-sheet");
  await expect(page.getByRole("button", { name: "Going" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Friday social" })).toBeVisible();
  await expect(page.getByText("From Lindy Hop.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite people" })).toBeVisible();
  await expect(page).toHaveScreenshot("whats-on-sheet.png", { fullPage: true });
  expect(errors).toEqual([]);
});

// Going (rc59): the DM went to the beginners' class. What's on lists it as going and links to
// the event; the page's script leaves it alone though Google is busy then, as the Google copy
// of it is.
test("what you're going to is listed as going, and Google's busy times leave it alone", async ({
  page,
}) => {
  await answerBusy(page, { status: 200, busy: GOOGLE, google: "shown" });
  const errors = await open(page, "whats-on-going");
  await expect(page.locator(".busynote")).toHaveText("Your Google busy times are counted too.");
  const going = page.locator(".on > li[data-going]");
  await expect(going).toHaveCount(1);
  await expect(going).toContainText("Beginners' class");
  await expect(going.getByRole("link", { name: "You're going" })).toHaveAttribute(
    "href",
    /^\/events\//,
  );
  await expect(going).not.toHaveClass(/clash/);
  await expect(page.locator("[data-clash-toggle]")).toContainText(
    "(1 event overlaps something of yours)",
  );
  await expect(page).toHaveScreenshot("whats-on-going.png", { fullPage: true });

  await open(page, "whats-on-going-sheet");
  await expect(page.getByText("You're going.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Going" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite people" })).toBeVisible();
  await expect(page).toHaveScreenshot("whats-on-going-sheet.png", { fullPage: true });
  expect(errors).toEqual([]);
});

test.describe("without JavaScript (DESIGN rc15: every form works without it)", () => {
  test.use({ javaScriptEnabled: false });

  test("clashes are a link, and Invite people a form", async ({ page }) => {
    await open(page, "whats-on");
    await expect(page.getByRole("link", { name: "Show what clashes" })).toHaveAttribute(
      "href",
      "/whats-on?clashes=1",
    );
    await open(page, "whats-on-sheet");
    const invite = page.locator("form", {
      has: page.getByRole("button", { name: "Invite people" }),
    });
    await expect(invite).toHaveAttribute("method", "post");
    await expect(invite.locator('input[name="csrf"]')).toHaveCount(1);
    await expect(invite.locator('input[name="e"]')).toHaveValue("social");
    const going = page.locator("form", { has: page.getByRole("button", { name: "Going" }) });
    await expect(going).toHaveAttribute("method", "post");
    await expect(going.locator('input[name="csrf"]')).toHaveCount(1);
    await expect(going.locator('input[name="e"]')).toHaveValue("social");
  });
});
