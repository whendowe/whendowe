// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// The date/time picker (DESIGN §10 rc15, owner-reviewed mockup 2026-10-24).
//
// Progressive enhancement, never a replacement: the server renders the plain fields
// (all day, starts, ends) and reads only those. With JavaScript, this script hides
// them, draws a Monday-first month calendar in whole weeks plus a start time and a
// length, and writes every pick back into the plain fields — so a form posts one
// shape with or without it, and the server needs no second parser.
//
// The script is a literal inside the `html` tag, so it is shipped verbatim and holds
// no interpolation. It must therefore contain no backtick, no dollar-brace and no
// backslash (a tagged template "cooks" escapes, and an invalid one becomes empty).
// Its pure date logic is published as globalThis.WhenDoWePicker, which is how the
// unit tests run the exact code browsers get.

const PICKER_STYLE = html`<style>
  .wd-picker { display: grid; gap: .75rem; margin: 1rem 0; }
  .wd-picker [hidden] { display: none; }
  .wd-cal-head { display: flex; justify-content: space-between; align-items: center; }
  .wd-cal-head button { width: 2.4rem; height: 2.4rem; padding: 0; }
  .wd-cal { display: grid; grid-template-columns: 1.6rem repeat(7, 1fr); gap: 4px; font-variant-numeric: tabular-nums; }
  .wd-dow, .wd-wk { font-size: .72rem; opacity: .7; text-align: center; align-self: center; }
  .wd-dow { font-weight: 700; }
  .wd-day { aspect-ratio: 1; max-width: 100%; padding: 0; border: 1px solid transparent; border-radius: 8px;
    background: light-dark(#eef2f1, #222b2a); color: inherit; font: inherit; cursor: pointer; }
  .wd-we { font-weight: 700; }
  .wd-out { background: transparent; border: 1px dashed light-dark(#c9d1cf, #3a4644); opacity: .75; }
  .wd-today { border-color: currentColor; }
  .wd-on { background: light-dark(#0e6b66, #4fc0b6); color: light-dark(#fff, #062523); border-color: transparent; opacity: 1; }
  .wd-span { background: light-dark(#d9efec, #173936); opacity: 1; }
  .wd-pending { border: 2px dashed light-dark(#0e6b66, #4fc0b6); }
  .wd-row { display: flex; flex-wrap: wrap; gap: .75rem; }
  .wd-field { display: grid; gap: .25rem; font-weight: 700; font-size: .9rem; }
  .wd-field input, .wd-field select { font: inherit; padding: .4rem; }
  .wd-summary { font-weight: 700; font-size: 1.1rem; padding: .6rem .8rem; border-radius: 8px; background: light-dark(#d9efec, #173936); }
  .wd-summary small { display: block; font-weight: 400; font-size: .85rem; opacity: .8; }
  .wd-hint { margin: 0; font-size: .9rem; }
  .wd-tz { margin: 0; font-size: .9rem; opacity: .85; }
  .wd-link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; }
</style>`;

const PICKER_SCRIPT = html`<script>
(function () {
  "use strict";
  var LENGTHS = [30, 60, 90, 120, 180, 240];
  var ALL_DAY = "allday";
  var DAYS = "days";
  var DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;
  var TIME = /^[0-9]{2}:[0-9]{2}/;

  /* ---------- pure date logic: whole days as "YYYY-MM-DD" keys, in UTC ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function parseDate(k) { var p = k.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function isoDate(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(k, n) { var d = parseDate(k); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
  function dow(k) { return parseDate(k).getUTCDay(); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function isoWeek(k) {
    var d = parseDate(k);
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }
  /** A month in whole Monday-to-Sunday weeks, borrowing days from its neighbours. */
  function monthGrid(year, month) {
    var first = isoDate(new Date(Date.UTC(year, month, 1)));
    var last = isoDate(new Date(Date.UTC(year, month + 1, 0)));
    var from = addDays(first, -((dow(first) + 6) % 7));
    var to = addDays(last, (7 - dow(last)) % 7);
    var weeks = [];
    for (var k = from; k <= to; k = addDays(k, 7)) {
      var days = [];
      for (var i = 0; i < 7; i++) {
        var key = addDays(k, i);
        days.push({ key: key, inMonth: parseDate(key).getUTCMonth() === month });
      }
      weeks.push({ week: isoWeek(k), days: days });
    }
    return weeks;
  }
  function toMin(t) { var p = t.split(":"); return +p[0] * 60 + +p[1]; }
  function fromMin(m) { m = ((m % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
  function lengthLabel(m) {
    var h = Math.floor(m / 60), r = m % 60;
    if (h === 0) return r + " min";
    if (r === 0) return h + " h";
    if (r === 30) return h + "½ h";
    return h + " h " + r + " min";
  }
  var dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  var monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  function dayLabel(k) { return dayFmt.format(parseDate(k)).replace(",", ""); }

  /**
   * A pick is { date, to, time, length }: length is minutes, ALL_DAY, or DAYS (an
   * all-day stretch from date to to). toFields gives what the plain fields carry.
   */
  function toFields(p) {
    if (p.length === DAYS) return { allDay: true, start: p.date + "T00:00", end: p.to + "T00:00" };
    if (p.length === ALL_DAY) return { allDay: true, start: p.date + "T00:00", end: p.date + "T00:00" };
    var endAbs = toMin(p.time) + p.length;
    return {
      allDay: false,
      start: p.date + "T" + p.time,
      end: addDays(p.date, Math.floor(endAbs / 1440)) + "T" + fromMin(endAbs),
    };
  }
  /** The plain fields, as the server rendered them, back into a pick. */
  function fromFields(f, today) {
    var s = f.start || "", e = f.end || "";
    if (!DATE.test(s)) return { date: today, to: today, time: "19:00", length: 60 };
    var d1 = s.slice(0, 10);
    if (f.allDay) {
      var d2 = DATE.test(e) ? e.slice(0, 10) : d1;
      return d2 > d1
        ? { date: d1, to: d2, time: "19:00", length: DAYS }
        : { date: d1, to: d1, time: "19:00", length: ALL_DAY };
    }
    var t1 = TIME.test(s.slice(11)) ? s.slice(11, 16) : "19:00";
    var len = 60;
    if (DATE.test(e) && TIME.test(e.slice(11))) {
      len = daysBetween(d1, e.slice(0, 10)) * 1440 + toMin(e.slice(11, 16)) - toMin(t1);
      if (!(len > 0)) len = 60;
    }
    return { date: d1, to: d1, time: t1, length: len };
  }
  function summary(p) {
    if (p.length === DAYS) {
      var n = daysBetween(p.date, p.to) + 1;
      if (n === 1) return { main: dayLabel(p.date), sub: "1 day, all day" };
      return {
        main: dayLabel(p.date) + " – " + dayLabel(p.to),
        sub: n + " days, " + (n - 1) + (n === 2 ? " night" : " nights") + ", all day",
      };
    }
    if (p.length === ALL_DAY) return { main: dayLabel(p.date) + " · all day", sub: "" };
    var endAbs = toMin(p.time) + p.length;
    var ends = endAbs >= 1440 ? " (ends " + dayLabel(addDays(p.date, Math.floor(endAbs / 1440))) + ")" : "";
    return { main: dayLabel(p.date) + " · " + p.time + "–" + fromMin(endAbs) + ends, sub: lengthLabel(p.length) };
  }

  globalThis.WhenDoWePicker = {
    monthGrid: monthGrid, isoWeek: isoWeek, toFields: toFields, fromFields: fromFields,
    summary: summary, dayLabel: dayLabel, lengthLabel: lengthLabel,
  };
  if (typeof document === "undefined") return;

  /* ---------- the page ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function localToday() {
    var n = new Date();
    return n.getFullYear() + "-" + pad(n.getMonth() + 1) + "-" + pad(n.getDate());
  }

  /** The month calendar: paint(key, button) marks a day, onPick(key) handles a tap. */
  function calendar(view, paint, onPick) {
    var box = el("div");
    var head = el("div", "wd-cal-head");
    var prev = el("button", "", "‹");
    var next = el("button", "", "›");
    var title = el("strong");
    prev.type = next.type = "button";
    prev.setAttribute("aria-label", "Previous month");
    next.setAttribute("aria-label", "Next month");
    head.append(prev, title, next);
    var grid = el("div", "wd-cal");
    box.append(head, grid);
    function shift(n) {
      view.month += n;
      if (view.month < 0) { view.month = 11; view.year -= 1; }
      if (view.month > 11) { view.month = 0; view.year += 1; }
      draw();
    }
    prev.addEventListener("click", function () { shift(-1); });
    next.addEventListener("click", function () { shift(1); });
    function draw() {
      var today = localToday();
      title.textContent = monthFmt.format(new Date(Date.UTC(view.year, view.month, 1)));
      grid.textContent = "";
      grid.append(el("span", "wd-wk"));
      ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (d) { grid.append(el("span", "wd-dow", d)); });
      monthGrid(view.year, view.month).forEach(function (w) {
        grid.append(el("span", "wd-wk", String(w.week)));
        w.days.forEach(function (d, i) {
          var cls = "wd-day" + (d.inMonth ? "" : " wd-out") + (i >= 5 ? " wd-we" : "") + (d.key === today ? " wd-today" : "");
          var b = el("button", cls, String(parseDate(d.key).getUTCDate()));
          b.type = "button";
          b.setAttribute("aria-label", dayLabel(d.key));
          paint(d.key, b);
          b.addEventListener("click", function () { onPick(d.key); });
          grid.append(b);
        });
      });
    }
    return { node: box, draw: draw };
  }

  /** The event form: one day (or one stretch of days), a start time and a length. */
  function enhanceEvent(form) {
    var plain = form.querySelector("[data-picker-plain]");
    var allDay = form.querySelector("input[name=allDay]");
    var start = form.querySelector("input[name=start]");
    var end = form.querySelector("input[name=end]");
    if (!plain || !allDay || !start || !end) return;
    var p = fromFields({ allDay: allDay.checked, start: start.value, end: end.value }, localToday());
    var pending = null;
    var view = { year: +p.date.slice(0, 4), month: +p.date.slice(5, 7) - 1 };

    var ui = el("div", "wd-picker");
    var cal = calendar(view, paint, pick);
    var hint = el("p", "wd-hint");
    var row = el("div", "wd-row");
    var timeLabel = el("label", "wd-field", "Starts");
    var time = el("input");
    time.type = "time";
    time.step = "900";
    time.value = p.time;
    timeLabel.append(time);
    var lenLabel = el("label", "wd-field", "Length");
    var len = el("select");
    var lengths = LENGTHS.slice();
    if (typeof p.length === "number" && lengths.indexOf(p.length) === -1) lengths.push(p.length);
    lengths.sort(function (a, b) { return a - b; }).forEach(function (m) { len.append(new Option(lengthLabel(m), String(m))); });
    len.append(new Option("All day", ALL_DAY), new Option("Several days", DAYS));
    len.value = String(p.length);
    lenLabel.append(len);
    row.append(timeLabel, lenLabel);
    var sum = el("div", "wd-summary");
    sum.setAttribute("aria-live", "polite");
    ui.append(cal.node, hint, row, sum);

    // The time zone is one quiet line; "Change" brings back the plain field.
    var tzInput = form.querySelector("#tzid");
    var tzPara = tzInput ? tzInput.closest("p") : null;
    var tzLine = null;
    if (tzInput && tzPara) {
      tzLine = el("p", "wd-tz", "Times in ");
      var tzName = el("strong", "", tzInput.value || Intl.DateTimeFormat().resolvedOptions().timeZone);
      var change = el("button", "wd-link", "Change");
      change.type = "button";
      change.addEventListener("click", function () { tzPara.hidden = false; tzLine.hidden = true; tzInput.focus(); });
      tzLine.append(tzName, " · ", change);
      ui.append(tzLine);
      tzPara.hidden = true;
    }

    function paint(key, b) {
      var on = false, span = false;
      if (p.length === DAYS) {
        if (key >= p.date && key <= p.to) { if (key === p.date || key === p.to) on = true; else span = true; }
        if (pending === key) b.classList.add("wd-pending");
      } else {
        on = key === p.date;
      }
      if (on) b.classList.add("wd-on");
      if (span) b.classList.add("wd-span");
      b.setAttribute("aria-pressed", String(on || span));
    }
    function pick(key) {
      if (p.length === DAYS) {
        if (pending === null) {
          pending = key;
        } else {
          p.date = pending < key ? pending : key;
          p.to = pending < key ? key : pending;
          pending = null;
        }
      } else {
        p.date = key;
        p.to = key;
      }
      render();
    }
    function render() {
      timeLabel.hidden = typeof p.length !== "number";
      hint.hidden = p.length !== DAYS;
      hint.textContent = pending ? "Starts " + dayLabel(pending) + ". Now tap the last day." : "Tap the first day, then the last day.";
      cal.draw();
      var s = pending ? { main: "From " + dayLabel(pending) + "…", sub: "Tap the last day" } : summary(p);
      sum.textContent = s.main;
      if (s.sub) sum.append(el("small", "", s.sub));
      var f = toFields(p);
      allDay.checked = f.allDay;
      start.value = f.start;
      end.value = f.end;
      if (tzLine && tzPara && tzPara.hidden) tzLine.hidden = f.allDay;
    }
    time.addEventListener("input", function () { if (time.value) { p.time = time.value; render(); } });
    len.addEventListener("change", function () {
      pending = null;
      if (len.value === DAYS) {
        p.length = DAYS;
        if (p.to <= p.date) p.to = addDays(p.date, 2);
      } else {
        p.length = len.value === ALL_DAY ? ALL_DAY : +len.value;
        p.to = p.date;
      }
      render();
    });

    plain.hidden = true;
    plain.parentNode.insertBefore(ui, plain);
    render();
  }

  var forms = document.querySelectorAll("form[data-picker=event]");
  for (var i = 0; i < forms.length; i++) enhanceEvent(forms[i]);
})();
</script>`;

/** The picker's style and script, placed after the form they enhance. */
export function pickerAssets() {
  return html`${PICKER_STYLE}${PICKER_SCRIPT}`;
}
