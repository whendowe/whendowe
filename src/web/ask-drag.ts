// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// Dragging on the Ask page (DESIGN §10 *Asking when*, rc47, A3 part 2). The page is drawn by
// the server and works without this: tapping and the sheet do everything a drag does. The
// script keeps no state of its own. When a drag ends on another cell than it began, it submits
// the form with an action naming the span, exactly as a button would, and the server checks,
// saves and redraws it. A drag that ends where it began is a tap, and does what a tap does.
//
// - Days view: a drag along a week's row from an empty day makes one all-day option over those
//   days (`span:FROM:TO`). Dragging the letter on an all-day event's first or last day moves
//   that end (`move:I:J:start|end:DAY`). The row lets the page scroll up and down.
// - Hours view: time runs down the page, so empty hours are only tapped. A timed event shows a
//   grip at its start and end; dragging one moves that end by whole hours, within its day
//   (`move:I:J:start|end:DAYTHH:00`). Only the grip holds the drag; the grid scrolls as before.
// - The same gestures with a mouse, a finger or a pen.
//
// Like the picker, the script is a literal inside the `html` tag: no backtick, no dollar-brace,
// no backslash. Its pure logic is published as globalThis.WhenDoWeAskDrag for the unit tests,
// which run exactly this code; the browser tier measures its coverage (§9 rc47).

const ASK_DRAG_STYLE = html`<style>
  .pl.ask.drag-on .wkrow { touch-action: pan-y; }
  .pl.ask.drag-on .day .letter[data-grip] { cursor: ew-resize; }
  .pl.ask .day.drag, .pl.ask .hour.drag { outline: 2px dashed var(--fg); outline-offset: -2px; }
  .pl.ask .grip { display: none; }
  .pl.ask.drag-on .grip { display: block; flex: 0 0 100%; height: 14px; touch-action: none; cursor: ns-resize; position: relative; }
  .pl.ask.drag-on .grip::before { content: ""; position: absolute; left: 25%; right: 25%; top: 5px; height: 4px; border-radius: 2px; background: var(--fg); opacity: .45; }
</style>`;

const ASK_DRAG_SCRIPT = html`<script>
(function () {
  "use strict";
  /* ---------- pure: what a finished drag asks the server to do ---------- */
  /* From an empty day to another along a week: one option over those whole days. */
  function spanAction(a, z) {
    if (!a || !z || a === z) return null;
    return a < z ? "span:" + a + ":" + z : "span:" + z + ":" + a;
  }
  /*
   * A grip ("I:J", event J of option I) dragged from one cell to another. ends says which
   * end it holds: "start", "end", or "both" for a one-day event, where the direction decides.
   */
  function gripAction(grip, ends, origin, target) {
    if (!grip || !origin || !target || origin === target) return null;
    var which = ends === "both" ? (target > origin ? "end" : "start") : ends;
    if (which !== "start" && which !== "end") return null;
    return "move:" + grip + ":" + which + ":" + target;
  }
  /* Cells a span preview covers: keys between the two, inclusive. */
  function between(key, a, z) {
    if (!a || !z) return false;
    return a <= z ? key >= a && key <= z : key >= z && key <= a;
  }

  globalThis.WhenDoWeAskDrag = { spanAction: spanAction, gripAction: gripAction, between: between };
  if (typeof document === "undefined") return;

  /* ---------- the page ---------- */
  var root = document.querySelector("[data-ask-drag]");
  var form = root ? root.querySelector("form") : null;
  var send = form ? form.querySelector("button[data-drag-act]") : null;
  if (!root || !form || !send) return;
  root.classList.add("drag-on");

  var drag = null;
  var swallow = false;
  function keyOf(cell) { return cell.getAttribute("data-day") || cell.getAttribute("data-at") || ""; }
  function cellUnder(x, y) {
    var el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest("[data-day],[data-at]") : null;
  }
  function paint() {
    var cells = root.querySelectorAll("[data-day],[data-at]");
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i], k = keyOf(c), on = false;
      if (drag && drag.kind === "span") on = c.parentNode === drag.row && between(k, drag.origin, drag.target);
      else if (drag) on = k === drag.target && k !== drag.origin;
      c.classList.toggle("drag", on);
    }
  }
  /* Where a move may land: a span stays in its week, an hour grip in its day. */
  function allowed(cell) {
    if (!drag || !cell) return false;
    if (drag.kind === "span") return cell.parentNode === drag.row && cell.hasAttribute("data-day");
    if (drag.hours) return cell.hasAttribute("data-at") && keyOf(cell).slice(0, 10) === drag.origin.slice(0, 10);
    return cell.hasAttribute("data-day");
  }

  root.addEventListener("pointerdown", function (e) {
    swallow = false;
    if (e.button !== 0 || !e.target.closest) return;
    var grip = e.target.closest("[data-grip]");
    var cell = e.target.closest("[data-day],[data-at]");
    if (!cell) return;
    if (grip) {
      drag = { kind: "grip", grip: grip.getAttribute("data-grip"), ends: grip.getAttribute("data-ends"), hours: cell.hasAttribute("data-at") };
      if (drag.hours && grip.setPointerCapture) grip.setPointerCapture(e.pointerId);
    } else if (cell.tagName === "BUTTON" && cell.hasAttribute("data-day")) {
      drag = { kind: "span", row: cell.parentNode };
    } else return;
    drag.id = e.pointerId;
    drag.origin = keyOf(cell);
    drag.target = drag.origin;
  });
  root.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var cell = cellUnder(e.clientX, e.clientY);
    if (!allowed(cell)) return;
    var k = keyOf(cell);
    if (k === drag.target) return;
    drag.target = k;
    paint();
  });
  root.addEventListener("pointerup", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    paint();
    var act = d.kind === "span" ? spanAction(d.origin, d.target) : gripAction(d.grip, d.ends, d.origin, d.target);
    if (!act) return;
    /* The click that follows would be a tap on where the drag began: it is not one. */
    swallow = true;
    send.value = act;
    if (form.requestSubmit) form.requestSubmit(send);
    else send.click();
  });
  root.addEventListener("pointercancel", function () { drag = null; paint(); });
  root.addEventListener("click", function (e) {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  root.addEventListener("dragstart", function (e) { e.preventDefault(); });
})();
</script>`;

/** The Ask page's drag: its style and script, after the page (rc47). */
export function askDragAssets() {
  return html`${ASK_DRAG_STYLE}${ASK_DRAG_SCRIPT}`;
}
