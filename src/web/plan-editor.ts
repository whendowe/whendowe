// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// The week-row editor (DESIGN §10 rc19): the plan pages' styles and, with JavaScript, the
// script that lets a stretch be picked up and put down or dragged (slice P4).
//
// The styles are ported from the owner-reviewed prototype
// (v12, 2026-10-30): a sticky header naming the plan and what it answers, week rows with
// events as labelled ribbons, and a sticky sheet for the tapped day, the editor or the
// actions. Scoped under .pl; light and dark through light-dark(), like the picker.

export const PLAN_STYLE = html`<style>
  .pl { --fg: CanvasText; --muted: light-dark(#5d6b69, #9aa9a6); --line: light-dark(#c9d1cf, #3a4644);
    --tile: light-dark(#eef2f1, #222b2a); --card: light-dark(#ffffff, #1a2221); --accent: light-dark(#0e6b66, #4fc0b6);
    --accent-soft: light-dark(#d9efec, #173936); --on: light-dark(#ffffff, #062523); --hi: light-dark(#fff4cc, #3a3214);
    --ok: light-dark(#1f6b2e, #7fd08e); --bad: light-dark(#9a2a1f, #f19185);
    --o0: light-dark(#0e6b66, #4fc0b6); --o1: light-dark(#b4511f, #f08a52); --o2: light-dark(#5b4bb3, #a99bf0);
    --o3: light-dark(#8a6a00, #e2c050); --o4: light-dark(#a3336b, #ef7db4); --o5: light-dark(#2a6a9e, #7fb6e6);
    --o6: light-dark(#5f7a12, #b9cf6a); --o7: light-dark(#8c4a2f, #d9a07f);
    display: grid; gap: 8px; font-size: 1rem; line-height: 1.45; }
  .pl p { margin: 0; }
  .pl h1 { margin: 0; font-size: 1.3rem; }
  .pl h2 { margin: 0; font-size: 1.1rem; }
  .pl h3 { margin: 0; font-size: 1rem; }
  .pl a { color: inherit; }
  .pl button, .pl .btn { font: inherit; font-size: .95rem; padding: .45rem .9rem; cursor: pointer; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--fg); text-decoration: none; display: inline-block; line-height: 1.3; }
  .pl .primary { background: var(--accent); color: var(--on); border-color: transparent; font-weight: 700; }
  .pl .link { background: none; border: 0; padding: 0; text-decoration: underline; }
  .pl button:disabled { opacity: .5; cursor: default; }
  /* The button rules above set display; hidden must still hide: Share… and Copy until the
     script finds the browser can do them, and the shared pages' Enter guard. */
  .pl [hidden] { display: none !important; }
  .pl .share-box { display: grid; gap: 8px; }
  .pl input, .pl textarea, .pl select { font: inherit; padding: .35rem .4rem; color: var(--fg); background: var(--card);
    border: 1px solid var(--line); border-radius: 6px; }
  .pl textarea, .pl .wide { width: 100%; box-sizing: border-box; }
  .pl form { margin: 0; }
  .pl .muted { color: var(--muted); opacity: 1; }
  .pl .small { font-size: .85rem; }
  .pl .stack { display: grid; gap: 12px; }
  .pl .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pl .spread { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pl .notice { padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); }
  .pl .error { color: var(--bad); font-weight: 700; }
  .pl label.f { display: grid; gap: 2px; font-size: .85rem; font-weight: 700; }

  .pl .head { position: sticky; top: 0; z-index: 2; background: Canvas; padding: 6px 0; border-bottom: 1px solid var(--line);
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; }
  .pl .head .l1 { font-weight: 700; display: flex; gap: 6px; align-items: center; min-width: 0; }
  .pl .head .l2 { font-size: .85rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
  .pl .head .l3 { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: start; gap: 8px; font-size: .85rem; font-weight: 700; }
  .pl .head .l3 details { min-width: 0; }
  .pl .head .l3 summary { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
  .pl .head .l3 ul { font-weight: 400; }
  .pl .status { font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px;
    border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .pl .status.on_table { color: var(--accent); } .pl .status.accepted { color: var(--ok); }
  .pl .status.replaced, .pl .status.withdrawn { color: var(--muted); } .pl .status.draft { border-style: dashed; }
  .pl .letter { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 5px; font-weight: 700;
    font-size: .78rem; color: Canvas; background: var(--muted); flex: 0 0 auto; }

  .pl .seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 3px; border-radius: 999px; border: 1px solid var(--line); }
  .pl .seg button { border: 0; border-radius: 999px; padding: .35rem; background: transparent; font-size: .9rem; }
  .pl .seg button[aria-pressed=true] { background: var(--accent); color: var(--on); font-weight: 700; }

  .pl .weeks { display: grid; gap: 8px; }
  .pl .week { scroll-margin-top: 150px; border: 1px solid var(--line); border-radius: 10px; padding: 6px; background: var(--card); display: grid; gap: 5px; }
  .pl .wh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: .85rem; padding: 0 2px; }
  .pl .st { font-size: .72rem; font-weight: 700; color: var(--muted); white-space: nowrap; }
  .pl .wg { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; grid-auto-rows: minmax(1.7rem, auto); }
  .pl .dh { position: relative; padding: 2px 0; border-radius: 6px; border: 1px solid transparent; background: var(--tile); font-size: .68rem;
    line-height: 1.1; display: grid; place-items: center; min-height: 2.3rem; color: var(--muted); text-decoration: none; grid-row: 1; }
  .pl .dh b { font-size: .92rem; color: var(--fg); }
  .pl .dh.we b { font-weight: 800; }
  .pl .dh.today { border-color: var(--fg); }
  .pl .dh.picked { outline: 3px solid var(--accent); outline-offset: 1px; }
  .pl .dh.sel-end { background: var(--ev); } .pl .dh.sel-end, .pl .dh.sel-end b { color: var(--on); }
  .pl .dh.sel-mid { background: color-mix(in srgb, var(--ev) 35%, var(--tile)); }
  .pl .dh.grab { outline: 3px dashed var(--fg); outline-offset: 2px; z-index: 1; animation: pl-held 1s ease-in-out infinite alternate; }
  @keyframes pl-held { to { outline-offset: 4px; } }
  @media (prefers-reduced-motion: reduce) { .pl .dh.grab { animation: none; } }
  .pl .rib { box-sizing: border-box; display: block; min-width: 0; padding: 3px 6px; border-radius: 6px; font-size: .78rem; line-height: 1.25;
    overflow: hidden; overflow-wrap: anywhere; position: relative; text-decoration: none; color: var(--fg); }
  .pl .rib small { font-weight: 400; font-size: .7rem; }
  .pl .rib.plan { background: color-mix(in srgb, var(--x) 24%, var(--card)); border-left: 4px solid var(--x); font-weight: 700; }
  .pl .rib.agreed { background: color-mix(in srgb, var(--x) 10%, var(--tile)); color: var(--muted); }
  .pl .rib.ghost { border: 1.5px dashed var(--muted); color: var(--muted); text-decoration: line-through; }
  .pl .rib .badge { display: inline-block; margin-left: 4px; font-size: .6rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
    padding: 0 4px; border-radius: 4px; background: var(--fg); color: Canvas; text-decoration: none; vertical-align: 1px; white-space: nowrap; }
  .pl .rib.ghost .badge { background: var(--muted); }
  .pl .rib .lock { margin-left: 4px; font-size: .7rem; }
  .pl .rib.one { --w: calc((100% - 6px) / 3); white-space: nowrap; text-overflow: ellipsis; border-left: 0; padding-left: 8px; }
  .pl .rib.one.plan { background: linear-gradient(90deg, color-mix(in srgb, var(--x) 24%, var(--card)) 0 var(--w), transparent var(--w)); box-shadow: inset 4px 0 var(--x); }
  .pl .rib.one.right { text-align: right; padding: 3px 8px 3px 6px; }
  .pl .rib.one.right.plan { background: linear-gradient(270deg, color-mix(in srgb, var(--x) 24%, var(--card)) 0 var(--w), transparent var(--w)); box-shadow: inset -4px 0 var(--x); }
  .pl .rib.one.agreed { background: linear-gradient(90deg, color-mix(in srgb, var(--x) 10%, var(--tile)) 0 var(--w), transparent var(--w)); }
  .pl .rib.one.right.agreed { background: linear-gradient(270deg, color-mix(in srgb, var(--x) 10%, var(--tile)) 0 var(--w), transparent var(--w)); }
  .pl .rib.one.ghost { border: 0; border-left: 1.5px dashed var(--muted); }
  .pl .rib.one.right.ghost { border-left: 0; border-right: 1.5px dashed var(--muted); }
  .pl .rib:focus-visible, .pl .dh:focus-visible { outline: 3px solid var(--fg); }
  .pl .rib.sel { outline: 3px solid var(--fg); outline-offset: 1px; touch-action: none; }
  .pl .grip { position: absolute; top: 0; bottom: 0; width: 24px; cursor: ew-resize; display: grid; place-items: center; }
  .pl .grip::after { content: ""; width: 5px; height: 70%; min-height: 12px; border-radius: 3px; background: var(--fg); }
  .pl .rib.sel { --cw: calc((100% - (var(--n) - 1) * 3px) / var(--n)); }
  .pl .grip.s { left: calc(var(--a) * (var(--cw) + 3px)); }
  .pl .grip.e { left: calc((var(--b) + 1) * (var(--cw) + 3px) - 3px - 24px); }
  .pl .grip.on::after { width: 9px; height: 100%; background: var(--accent); }
  .pl .rib.sel.gs { padding-left: 26px; } .pl .rib.sel.ge { padding-right: 26px; }
  .pl .rib.sel.one { padding-left: calc(var(--cw) + 8px); padding-right: 6px; }
  .pl .rib.sel.one.right { padding-left: 6px; padding-right: calc(var(--cw) + 8px); }
  .pl .editing .rib:not(.sel), .pl .editing .wl { opacity: .35; }
  .pl .dragging, .pl .dragging * { user-select: none; -webkit-user-select: none; }
  .pl .wl { list-style: none; margin: 0; padding: 0 2px; display: grid; gap: 2px; font-size: .85rem; }
  .pl .wl li { padding-left: 1.2rem; text-indent: -1.2rem; }
  .pl .wl li::before { display: inline-block; width: 1.2rem; text-indent: 0; font-weight: 800; }
  .pl .wl li.add::before { content: "+"; } .pl .wl li.chg::before { content: "↷"; } .pl .wl li.rm::before { content: "−"; }
  .pl .wl li.warn::before { content: "!"; color: var(--bad); }
  .pl .wch summary { font-size: .72rem; font-weight: 700; cursor: pointer; padding: 2px 8px; border-radius: 999px; background: var(--hi); width: fit-content; }
  .pl details.fold > summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 2px 8px; cursor: pointer; list-style: none;
    border: 1px dashed var(--line); border-radius: 8px; padding: .45rem .9rem; font-size: .85rem; }
  .pl details.fold > summary::-webkit-details-marker { display: none; }
  .pl details.fold[open] > summary { margin-bottom: 8px; }
  .pl details.fold[open] { display: grid; gap: 8px; }

  .pl .sheet { position: sticky; bottom: 0; z-index: 2; background: var(--card); border: 1px solid var(--line); border-radius: 14px 14px 10px 10px;
    padding: 8px 12px; display: grid; gap: 8px; box-shadow: 0 -4px 14px rgb(0 0 0 / .08); max-height: 60vh; overflow: auto; }
  .pl .sheet > * { min-width: 0; }
  .pl .x { border: 0; background: none; padding: 2px 6px; font-size: 1.2rem; line-height: 1; color: var(--muted); text-decoration: none; }
  .pl .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .pl .rows li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: .92rem; }
  .pl .rows li .w { color: var(--muted); font-size: .85rem; }
  .pl .rows li.gone strong { text-decoration: line-through; }
  .pl .sw { display: inline-block; width: 20px; height: 8px; border-radius: 3px; flex: 0 0 auto; background: var(--x); }
  .pl .sw.stripe { background: none; border: 1.5px dashed var(--x); box-sizing: border-box; }
  .pl .sw.muted { background: color-mix(in srgb, var(--x) 30%, var(--tile)); height: 12px; }
  .pl .choose { display: grid; gap: 6px; }
  .pl .choose > a, .pl .choose button { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; align-items: center; text-align: left; width: 100%; box-sizing: border-box; }
  .pl blockquote { margin: 0; padding-left: 10px; border-left: 3px solid var(--line); font-style: italic; font-size: .92rem; }
  .pl .votes { display: flex; flex-wrap: wrap; gap: 4px; font-size: .8rem; }
  .pl .vote { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .pl .vote.yes { border-color: var(--ok); color: var(--ok); font-weight: 700; }
  .pl .vote.no { border-color: var(--bad); color: var(--bad); }
  .pl .vote.ifneedbe { border-style: dashed; }
  .pl .vote.none { color: var(--muted); }
  .pl .confirm { padding: 8px 10px; border-radius: 8px; border: 2px solid var(--accent); background: var(--accent-soft); display: grid; gap: 8px; }
  .pl .paste { font-family: ui-monospace, monospace; font-size: .8rem; }

  .pl .ed { display: grid; gap: 8px; }
  .pl .ed .eh { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
  .pl .ed .eh input { width: 100%; box-sizing: border-box; font-weight: 700; }
  .pl .dot { width: 14px; height: 14px; border-radius: 4px; background: var(--ev); }
  .pl .kind { display: flex; gap: 12px; flex-wrap: wrap; font-size: .9rem; }
  .pl .ed:has(input[name=kind][value=days]:checked) .timed, .pl .ed:has(input[name=kind][value=time]:checked) .stretch { display: none; }
  .pl .mv { display: grid; grid-template-columns: 3rem repeat(4, minmax(0, 1fr)); align-items: center; gap: 6px; }
  .pl .mv .lbl, .pl .whorow .lbl { font-size: .85rem; font-weight: 700; }
  .pl .mv button { padding: 0; height: 2.1rem; font-size: .85rem; }
  .pl .whorow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pl .whorow .lbl { width: 3rem; }
  .pl .whorow label { padding: .2rem .6rem; font-size: .85rem; border-radius: 999px; border: 1px solid var(--line); }
  .pl .whorow label:has(input:checked) { background: var(--fg); color: Canvas; border-color: var(--fg); }

  .pl .msg { border: 1px solid var(--line); border-radius: 10px; background: var(--card); display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .pl .msg.mine { border-color: var(--accent); }
  .pl .msg.replaced, .pl .msg.withdrawn { opacity: .8; border-style: dashed; }
  .pl .msg > a { display: grid; gap: 2px; padding: 8px 10px; min-width: 0; text-decoration: none; }
  .pl .msg .t1 { font-weight: 700; display: flex; gap: 6px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
  .pl .msg .t2 { font-size: .82rem; color: var(--muted); }
  .pl .msg .side { display: grid; align-content: center; padding: 6px; }
  .pl .msg .side a { font-size: .8rem; padding: .3rem .5rem; }
  .pl .group-h { margin-top: 6px; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pl .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: .9rem; }
  .pl .list li { padding: 5px 10px; border-radius: 8px; background: var(--tile); }
  .pl .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--card); display: grid; gap: 4px; }
  .pl .card .when { font-weight: 700; font-size: 1.05rem; }
  .pl .card .notes { white-space: pre-line; margin: 0; }
</style>`;

// The week-row editor script (slice P4). Progressive enhancement, never a replacement:
// the draft page works with plain links and forms, and this only adds gestures that
// write the same plain fields and submit the same form.
//
// - Tap an end of the selected stretch (or its grip) to pick it up; tap it again to
//   put it back; tap any other day, in any week, to put it down there (ends that cross
//   swap). Middle days do nothing while no end is held. A timed event moves to the
//   tapped day. This works wherever dragging doesn't (owner, 2026-10-30).
// - Drag a grip to move that end, or the ribbon to move the whole stretch, by the
//   finger's movement in days. The preview only toggles classes: nothing the finger is
//   on is ever re-rendered, so phones keep delivering the gesture (the prototype's v9
//   lesson: a detached touch target stops receiving moves).
// - Days are found from the week row under the pointer, never from a ribbon's box.
//
// Like the picker, the script is a literal inside the `html` tag: no backtick, no
// dollar-brace, no backslash. Its pure logic is published as globalThis.WhenDoWePlanEditor
// for the unit tests, which run exactly this code.
const EDITOR_SCRIPT = html`<script>
(function () {
  "use strict";
  /* ---------- pure: whole days as "YYYY-MM-DD" keys, in UTC ---------- */
  var MS = 86400000;
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isDay(k) {
    if (typeof k !== "string" || k.length !== 10 || k.charAt(4) !== "-" || k.charAt(7) !== "-") return false;
    var d = new Date(k + "T00:00:00Z");
    return !isNaN(d.getTime()) && iso(d) === k;
  }
  function iso(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(k, n) { return iso(new Date(Date.parse(k + "T00:00:00Z") + n * MS)); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / MS); }
  function ordered(a, z) { return a <= z ? { start: a, end: z } : { start: z, end: a }; }

  /*
   * One tap on day k while a whole-day stretch start..end (inclusive) is selected and
   * "grab" names the end held (or null). Returns the next state; commit says the
   * stretch changed and the form should be sent.
   */
  function tap(state, k) {
    if (!state.grab) {
      if (k === state.end) return { start: state.start, end: state.end, grab: "end", commit: false };
      if (k === state.start) return { start: state.start, end: state.end, grab: "start", commit: false };
      return { start: state.start, end: state.end, grab: null, commit: false };
    }
    var held = state.grab === "start" ? state.start : state.end;
    if (k === held) return { start: state.start, end: state.end, grab: null, commit: false };
    var r = state.grab === "start" ? ordered(k, state.end) : ordered(state.start, k);
    return { start: r.start, end: r.end, grab: null, commit: true };
  }

  /* A drag of one end (or the whole stretch: "body") by delta days, from where it began. */
  function dragged(orig, which, delta) {
    if (which === "body") return { start: addDays(orig.start, delta), end: addDays(orig.end, delta) };
    if (which === "start") return ordered(addDays(orig.start, delta), orig.end);
    return ordered(orig.start, addDays(orig.end, delta));
  }

  globalThis.WhenDoWePlanEditor = { addDays: addDays, daysBetween: daysBetween, isDay: isDay, tap: tap, dragged: dragged };
  if (typeof document === "undefined") return;

  /* ---------- the page ---------- */
  var root = document.querySelector("[data-plan-editor]");
  var form = document.getElementById("editor");
  var sheet = document.querySelector(".pl .sheet");
  var head = document.querySelector(".pl .head");
  var sel = root ? root.getAttribute("data-sel") : "";

  function sheetTop() { return sheet ? sheet.getBoundingClientRect().top : window.innerHeight; }
  function headBottom() { return head ? head.getBoundingClientRect().bottom : 0; }

  /* Keep the event being edited in sight: just above the sheet, never under the header. */
  function reveal() {
    var rib = document.querySelector(".pl .rib.sel");
    if (!rib) return;
    var r = rib.getBoundingClientRect();
    var limit = sheetTop() - 72;
    if (r.bottom > limit) window.scrollBy(0, r.bottom - limit);
    else if (r.top < headBottom() + 8) window.scrollBy(0, r.top - headBottom() - 8);
  }
  reveal();

  if (!root || !form || !sel) return;
  var field = function (name) { return form.querySelector("[name=" + name + "]"); };
  var kindDays = form.querySelector("input[name=kind][value=days]");
  var allDay = !!(kindDays && kindDays.checked);
  var from = field("from"), to = field("to"), dayField = field("day");
  var hint = form.querySelector("[data-hint]");
  var state = { start: from ? from.value : "", end: to ? to.value : "", grab: null };
  var g0 = root.getAttribute("data-grab");
  if (allDay && (g0 === "start" || g0 === "end")) state.grab = g0;
  if (allDay && !(isDay(state.start) && isDay(state.end))) allDay = false;

  function paint(range) {
    var cells = document.querySelectorAll(".pl .dh[data-k]");
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i], k = c.getAttribute("data-k");
      var inside = range && k >= range.start && k <= range.end;
      var isEnd = range && (k === range.start || k === range.end);
      c.classList.toggle("sel-end", !!(inside && isEnd));
      c.classList.toggle("sel-mid", !!(inside && !isEnd));
      c.classList.toggle("grab", !!(range && state.grab && k === (state.grab === "start" ? range.start : range.end)));
    }
    var grips = document.querySelectorAll(".pl .rib.sel .grip");
    for (var j = 0; j < grips.length; j++)
      grips[j].classList.toggle("on", grips[j].getAttribute("data-grip") === state.grab);
    if (hint && allDay) {
      hint.textContent = state.grab
        ? "Picked up its " + (state.grab === "start" ? "first" : "last") + " day: tap the day it should move to, or tap it again to leave it."
        : "Tap its first or last day to pick it up, then tap where it goes. Or drag an end.";
    }
  }
  function send() {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }
  function commit(range) {
    from.value = range.start;
    to.value = range.end;
    paint(range);
    send();
  }
  if (allDay) paint(state);

  /* ---------- taps ---------- */
  var eatClick = false;
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!(t instanceof Element)) return;
    if (eatClick) { ev.preventDefault(); ev.stopPropagation(); return; }
    var grip = t.closest(".pl .rib.sel .grip");
    if (grip && allDay) {
      ev.preventDefault();
      var which = grip.getAttribute("data-grip");
      state.grab = state.grab === which ? null : which;
      paint(state);
      return;
    }
    if (t.closest(".pl .rib.sel")) { ev.preventDefault(); return; }
    var cell = t.closest(".pl .dh[data-k]");
    if (!cell || !root.contains(cell)) return;
    var k = cell.getAttribute("data-k");
    ev.preventDefault();
    if (!allDay) {
      if (dayField && dayField.value !== k) { dayField.value = k; send(); }
      return;
    }
    var next = tap(state, k);
    state.grab = next.grab;
    if (next.commit) commit(next);
    else paint(state);
  }, true);

  /* ---------- drags ---------- */
  function dayAt(x, y) {
    var top = sheetTop() - 4;
    if (y > top) y = top;
    var rows = root.querySelectorAll(".wg[data-w]");
    var best = null, bestDist = Infinity;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (r.height === 0) continue;
      var dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dist < bestDist) { best = { row: rows[i], rect: r }; bestDist = dist; }
    }
    if (!best) return null;
    var col = Math.floor(((x - best.rect.left) / (best.rect.width + 3)) * 7);
    if (col < 0) col = 0;
    if (col > 6) col = 6;
    return addDays(best.row.getAttribute("data-w"), col);
  }

  var drag = null;
  function onMove(x, y) {
    if (!drag) return;
    if (!drag.moving && Math.abs(x - drag.x) + Math.abs(y - drag.y) < 6) return;
    drag.moving = true;
    drag.dy = y - drag.lastY;
    drag.lastX = x; drag.lastY = y;
    root.classList.add("dragging");
    var k = dayAt(x, y);
    if (!k) return;
    drag.range = dragged(drag.orig, drag.which, daysBetween(drag.d0, k));
    paint(drag.range);
  }
  /* Scroll only when the finger is at the sheet's edge (or the header's) and moving toward it. */
  function edgeScroll() {
    if (!drag || !drag.moving) return;
    var step = 0;
    if (drag.lastY > sheetTop() - 12 && drag.dy > 0) step = 8;
    else if (drag.lastY < headBottom() + 12 && drag.dy < 0) step = -8;
    if (step !== 0) {
      window.scrollBy(0, step);
      onMove(drag.lastX, drag.lastY);
    }
    drag.raf = window.requestAnimationFrame(edgeScroll);
  }
  function end() {
    if (!drag) return;
    var d = drag;
    drag = null;
    root.classList.remove("dragging");
    if (d.raf) window.cancelAnimationFrame(d.raf);
    if (!d.moving) return;
    eatClick = true;
    setTimeout(function () { eatClick = false; }, 0);
    if (d.range && (d.range.start !== state.start || d.range.end !== state.end)) commit(d.range);
    else paint(state);
  }
  root.addEventListener("pointerdown", function (ev) {
    if (!allDay || ev.button > 0) return;
    var t = ev.target;
    if (!(t instanceof Element)) return;
    var rib = t.closest(".rib.sel");
    if (!rib) return;
    var grip = t.closest(".grip");
    var d0 = dayAt(ev.clientX, ev.clientY);
    if (!d0) return;
    drag = { which: grip ? grip.getAttribute("data-grip") : "body", d0: d0, orig: { start: state.start, end: state.end },
      x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, dy: 0, moving: false, range: null, raf: 0 };
    try { rib.setPointerCapture(ev.pointerId); } catch (e) { /* capture is a nicety */ }
    drag.raf = window.requestAnimationFrame(edgeScroll);
  });
  /* The ribbon is a link: a mouse would start dragging the link itself and cancel ours. */
  var selRibs = root.querySelectorAll(".rib.sel");
  for (var s = 0; s < selRibs.length; s++) selRibs[s].setAttribute("draggable", "false");
  root.addEventListener("dragstart", function (ev) {
    if (ev.target instanceof Element && ev.target.closest(".rib.sel")) ev.preventDefault();
  });
  root.addEventListener("pointermove", function (ev) { onMove(ev.clientX, ev.clientY); });
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  document.addEventListener("touchmove", function (ev) { if (drag && drag.moving) ev.preventDefault(); }, { passive: false });
})();
</script>`;

/** The plan pages' styles and the editor script, for a page that has week rows. */
export function planAssets() {
  return html`${PLAN_STYLE}${EDITOR_SCRIPT}`;
}
