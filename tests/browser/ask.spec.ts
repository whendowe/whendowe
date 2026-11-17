// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { expect, type Page, test } from "./fixtures.js";

// Ask when as a plain page (DESIGN §10 *Asking when*, rc46, A2) in a real browser: pages.ts
// leaves a question being written — A is a Thursday evening and a weekend, B another evening.

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("a question being written: lettered options, or between, and inside, and what asking does", async ({
  page,
}) => {
  const errors = await open(page, "ask");
  await expect(page.getByText("Draft · step 1 of 4 · nobody has been told")).toBeVisible();
  await expect(page.locator(".option legend")).toHaveText(["A", "B"]);
  await expect(page.locator(".or")).toHaveText(["or"]);
  await expect(page.locator(".and")).toHaveText(["and"]);
  await expect(page.locator(".readback")).toHaveText(
    "Asking emails 2 people one question: does A or B suit for “Session 17”? One of them will happen.",
  );
  await expect(page.getByRole("button", { name: "Ask 2 people by email" })).toBeVisible();
  // The Days view: November 2026 in whole weeks; A's days carry its letter, B's too.
  await expect(page.locator(".days .nav strong")).toHaveText("November 2026");
  await expect(page.locator('.days a.letter[href="#o0"]')).toHaveCount(3); // the 5th, 7th, 8th
  await expect(page.locator('.days a.letter[href="#o1"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add 2026-11-20" })).toBeVisible();
  await expect(page).toHaveScreenshot("ask.png", { fullPage: true });
  expect(errors).toEqual([]);
});

test("the same question by the hour: four days, the evenings marked, the weekend all day", async ({
  page,
}) => {
  const errors = await open(page, "ask-hours");
  await expect(page.getByRole("button", { name: "Hours" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".hours .nav strong")).toHaveText("Thu 5 Nov – Sun 8 Nov");
  // A on Thursday 19:00–23:00 is four hours; its weekend fills Saturday and Sunday's all-day row.
  await expect(page.locator('.hrow:not(.allday) a.letter[href="#o0"]')).toHaveCount(4);
  await expect(page.locator('.hrow.allday a.letter[href="#o0"]')).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add 2026-11-06 12:00" })).toBeVisible();
  await expect(page.locator(".hours")).toHaveScreenshot("ask-hours.png");
  expect(errors).toEqual([]);
});

test("an option made like A: its week rows, its changes from A listed, and See A", async ({
  page,
}) => {
  const errors = await open(page, "ask-like");
  await expect(page.locator(".option legend")).toHaveText(["A", "B like A"]);
  const like = page.locator("#o1 .like");
  const listed = like.locator(":scope > .row > details");
  await expect(listed.locator("summary")).toHaveText("2 changes from A");
  await listed.locator("summary").click();
  await page.mouse.move(0, 0); // no hover left on the summary for the screenshot
  await expect(listed.locator(".wl li")).toHaveCount(2);
  await expect(listed.locator(".wl li").first()).toContainText("renamed Pizza");
  await expect(like.locator(".rib.ghost")).toHaveCount(1); // where the weekend was: one ribbon, Sat–Sun
  await expect(like.getByRole("button", { name: "See A" })).toBeVisible();
  await expect(like).toHaveScreenshot("ask-like.png");
  expect(errors).toEqual([]);
});

// --- dragging (rc47) ------------------------------------------------------------------------
// The pages are files here, so instead of navigating, sending the form records which button
// it was sent by: the drag's only output is the action it names.
async function recordSends(page: Page): Promise<void> {
  // A string, run in the page: this file is typed without the DOM.
  await page.evaluate(`(() => {
    window.sent = [];
    HTMLFormElement.prototype.requestSubmit = function (by) {
      window.sent.push(by ? by.value : "");
    };
    document.addEventListener("submit", function (e) {
      e.preventDefault();
      window.sent.push("native " + (e.submitter ? e.submitter.value : ""));
    });
  })()`);
}
const sent = async (page: Page) => z.array(z.string()).parse(await page.evaluate("window.sent"));
async function centre(page: Page, selector: string) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  const b = await page.locator(selector).first().boundingBox();
  if (b === null) throw new Error(`${selector} is not on screen`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function mouseDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  during?: () => Promise<void>,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  if (during !== undefined) await during();
  await page.mouse.up();
}
const day = (k: string) => `.days [data-day="${k}"]`;

test.describe("dragging", () => {
  test("along a week's empty days makes one option over them; ending where it began is a tap", async ({
    page,
  }) => {
    const errors = await open(page, "ask");
    await recordSends(page);
    await mouseDrag(
      page,
      await centre(page, day("2026-11-09")),
      await centre(page, day("2026-11-11")),
      async () => {
        // The days it would cover are outlined while the finger is down.
        await expect(page.locator(".days .day.drag")).toHaveCount(3);
      },
    );
    await expect(page.locator(".days .day.drag")).toHaveCount(0);
    expect(await sent(page)).toEqual(["span:2026-11-09:2026-11-11"]);
    // Right to left, the same span.
    await mouseDrag(
      page,
      await centre(page, day("2026-11-11")),
      await centre(page, day("2026-11-09")),
      async () => {
        await expect(page.locator(".days .day.drag")).toHaveCount(3);
      },
    );
    expect(await sent(page)).toEqual(["span:2026-11-09:2026-11-11", "span:2026-11-09:2026-11-11"]);
    // Back where it began: the tap's own button, nothing more.
    const tue = await centre(page, day("2026-11-10"));
    await mouseDrag(page, tue, { x: tue.x + 60, y: tue.y });
    await mouseDrag(page, tue, tue);
    expect(await sent(page)).toEqual([
      "span:2026-11-09:2026-11-11",
      "span:2026-11-09:2026-11-11",
      "span:2026-11-10:2026-11-11",
      "native add:2026-11-10",
    ]);
    expect(errors).toEqual([]);
  });

  test("an all-day event's last day, dragged by its letter, moves that end", async ({ page }) => {
    const errors = await open(page, "ask");
    await recordSends(page);
    // A's weekend is its second event: Saturday holds its start, Sunday its end.
    await expect(page.locator(`${day("2026-11-07")} a.letter`)).toHaveAttribute(
      "data-ends",
      "start",
    );
    const sunday = `${day("2026-11-08")} a.letter[data-grip="0:1"]`;
    await expect(page.locator(sunday)).toHaveAttribute("data-ends", "end");
    await mouseDrag(page, await centre(page, sunday), await centre(page, day("2026-11-10")));
    expect(await sent(page)).toEqual(["move:0:1:end:2026-11-10"]);
    // A tap on the letter still opens its sheet: it is a link to the option's card.
    await page.locator(sunday).click();
    await expect(page).toHaveURL(/#o0$/);
    expect(await sent(page)).toEqual(["move:0:1:end:2026-11-10"]);
    expect(errors).toEqual([]);
  });

  test("in Hours, an event's end grip moves it by whole hours", async ({ page }) => {
    const errors = await open(page, "ask-hours");
    await recordSends(page);
    const end = '[data-at="2026-11-05T22:00"] .grip[data-ends="end"]';
    await expect(page.locator(end)).toBeVisible();
    await expect(
      page.locator('[data-at="2026-11-05T19:00"] .grip[data-ends="start"]'),
    ).toBeVisible();
    await mouseDrag(
      page,
      await centre(page, end),
      await centre(page, '[data-at="2026-11-05T20:00"]'),
      async () => {
        await expect(page.locator('[data-at="2026-11-05T20:00"]')).toHaveClass(/drag/);
      },
    );
    // Straight across into another day's column: not this event's day, so nothing moves.
    await mouseDrag(
      page,
      await centre(page, end),
      await centre(page, '[data-at="2026-11-06T22:00"]'),
    );
    expect(await sent(page)).toEqual(["move:0:0:end:2026-11-05T20:00"]);
    expect(errors).toEqual([]);
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    async function fingerDrag(
      page: Page,
      from: { x: number; y: number },
      to: { x: number; y: number },
    ) {
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
        });
      await touch("touchStart", from.x, from.y);
      for (let i = 1; i <= 12; i++)
        await touch(
          "touchMove",
          from.x + ((to.x - from.x) * i) / 12,
          from.y + ((to.y - from.y) * i) / 12,
        );
      await touch("touchEnd", to.x, to.y);
    }

    test("a finger along a week makes the span, and adds nothing else", async ({ page }) => {
      const errors = await open(page, "ask");
      await recordSends(page);
      await fingerDrag(
        page,
        await centre(page, day("2026-11-16")),
        await centre(page, day("2026-11-19")),
      );
      expect(await sent(page)).toEqual(["span:2026-11-16:2026-11-19"]);
      expect(errors).toEqual([]);
    });

    test("a finger on a start grip moves it up; on empty hours it only scrolls", async ({
      page,
    }) => {
      const errors = await open(page, "ask-hours");
      await recordSends(page);
      const start = '[data-at="2026-11-05T19:00"] .grip[data-ends="start"]';
      await fingerDrag(
        page,
        await centre(page, start),
        await centre(page, '[data-at="2026-11-05T17:00"]'),
      );
      expect(await sent(page)).toEqual(["move:0:0:start:2026-11-05T17:00"]);
      // Down empty hours the page scrolls, and nothing is asked for.
      const top = await page.evaluate("window.scrollY");
      const free = await centre(page, '[data-at="2026-11-06T14:00"]');
      await fingerDrag(page, free, { x: free.x, y: free.y - 200 });
      expect(await page.evaluate("window.scrollY")).not.toBe(top);
      expect(await sent(page)).toEqual(["move:0:0:start:2026-11-05T17:00"]);
      expect(errors).toEqual([]);
    });
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("there are no grips, and a day is still a button that adds it", async ({ page }) => {
    await open(page, "ask-hours");
    await expect(page.locator(".grip").first()).toBeHidden();
    await open(page, "ask");
    await expect(page.getByRole("button", { name: "Add 2026-11-20" })).toBeVisible();
  });
});
