// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// The date/time picker (DESIGN §10 rc15, owner-reviewed mockup 2026-10-24), for the
// event form (one day, or one stretch) and the poll form (several, which may overlap).
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
  .wd-day { position: relative; padding-bottom: 14px; }
  .wd-asking { outline: 3px solid light-dark(#17201f, #e6eeec); outline-offset: 2px; }
  .wd-badge { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); font-size: .62rem; font-weight: 700; line-height: 1;
    padding: 2px 4px; border-radius: 999px; background: light-dark(#17201f, #e6eeec); color: light-dark(#fff, #111716); }
  .wd-bars { position: absolute; left: 0; right: 0; bottom: 3px; display: grid; gap: 2px; }
  .wd-bar { height: 4px; }
  .wd-bar.wd-first { margin-left: 4px; border-radius: 3px 0 0 3px; }
  .wd-bar.wd-last { margin-right: 4px; border-radius: 0 3px 3px 0; }
  .wd-bar.wd-first.wd-last { border-radius: 3px; }
  .wd-o0 { background: light-dark(#0e6b66, #4fc0b6); } .wd-o1 { background: light-dark(#b4511f, #f08a52); }
  .wd-o2 { background: light-dark(#5b4bb3, #a99bf0); } .wd-o3 { background: light-dark(#8a6a00, #e2c050); }
  .wd-o4 { background: light-dark(#a3336b, #ef7db4); }
  .wd-legend { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 6px;
    font-weight: 700; font-size: .85rem; color: light-dark(#fff, #111716); flex: 0 0 auto; }
  .wd-kind { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border-radius: 999px;
    border: 1px solid light-dark(#c9d1cf, #3a4644); }
  .wd-kind button { border: 0; border-radius: 999px; padding: .4rem; background: transparent; color: inherit; font: inherit; font-size: .9rem; }
  .wd-kind button[aria-pressed=true] { background: light-dark(#0e6b66, #4fc0b6); color: light-dark(#fff, #062523); font-weight: 700; }
  .wd-opts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .wd-opts li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 6px 10px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid light-dark(#c9d1cf, #3a4644); font-variant-numeric: tabular-nums; }
  .wd-opts .wd-when { min-width: 0; font-weight: 700; }
  .wd-opts .wd-times { display: block; font-weight: 400; }
  .wd-opts li.wd-empty { display: block; }
  .wd-opts small { display: block; font-weight: 400; font-size: .8rem; opacity: .8; }
  .wd-opts input[type=time] { padding: .3rem .4rem; font: inherit; font-size: .9rem; }
  .wd-x { background: none; border: 0; padding: 4px 6px; color: inherit; opacity: .7; font: inherit; font-size: 1.1rem; line-height: 1; }
  .wd-chooser { display: grid; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 2px solid light-dark(#0e6b66, #4fc0b6);
    background: light-dark(#d9efec, #173936); }
  .wd-chooser p { margin: 0; font-weight: 700; }
  .wd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .wd-chips button { font: inherit; font-size: .85rem; padding: .3rem .75rem; border-radius: 999px;
    border: 1px solid light-dark(#c9d1cf, #3a4644); background: light-dark(#fff, #1a2221); color: inherit; }
  .wd-headrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .wd-headrow h3 { margin: 0; font-size: 1rem; }
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

  /**
   * A poll is { kind, start, length, times: [{ date, own }], days: [{ from, to }] }:
   * kind "times" offers a start on each day (own = that option's own start, or null
   * for the shared one), kind "days" offers all-day stretches, which may overlap.
   * pollRows gives the numbered rows the plain form carries, soonest first.
   */
  function pollRows(poll) {
    if (poll.kind === DAYS) {
      return sortDays(poll.days).map(function (d) {
        return { start: d.from + "T00:00", end: d.to + "T00:00" };
      });
    }
    return sortTimes(poll).map(function (t) {
      var f = toFields({ date: t.date, to: t.date, time: t.own === null ? poll.start : t.own, length: poll.length });
      return { start: f.start, end: f.end };
    });
  }
  /** The rows the server rendered (after a refused submit, say) back into a poll. */
  function pollFromRows(allDay, rows) {
    var filled = rows.filter(function (r) { return DATE.test(r.start || ""); });
    var poll = { kind: allDay ? DAYS : "times", start: "19:00", length: 180, times: [], days: [] };
    if (allDay) {
      filled.forEach(function (r) {
        var from = r.start.slice(0, 10);
        var to = DATE.test(r.end || "") && r.end.slice(0, 10) > from ? r.end.slice(0, 10) : from;
        poll.days.push({ from: from, to: to });
      });
      return poll;
    }
    var picks = filled.map(function (r) { return fromFields({ allDay: false, start: r.start, end: r.end }, ""); });
    if (picks.length > 0) { poll.start = picks[0].time; poll.length = picks[0].length; }
    picks.forEach(function (pk) {
      poll.times.push({ date: pk.date, own: pk.time === poll.start ? null : pk.time });
    });
    return poll;
  }
  function sortDays(days) {
    return days.slice().sort(function (a, b) { return a.from === b.from ? (a.to < b.to ? -1 : 1) : (a.from < b.from ? -1 : 1); });
  }
  function sortTimes(poll) {
    return poll.times.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return toMin(a.own === null ? poll.start : a.own) - toMin(b.own === null ? poll.start : b.own);
    });
  }
  function nightsLabel(from, to) {
    var n = daysBetween(from, to) + 1;
    return n === 1 ? "1 day" : n + " days, " + (n - 1) + (n === 2 ? " night" : " nights");
  }

  globalThis.WhenDoWePicker = {
    monthGrid: monthGrid, isoWeek: isoWeek, toFields: toFields, fromFields: fromFields,
    summary: summary, dayLabel: dayLabel, lengthLabel: lengthLabel,
    pollRows: pollRows, pollFromRows: pollFromRows,
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

  /** The poll form: several days on the calendar, each an option to vote on. */
  function enhancePoll(form) {
    var plain = form.querySelector("[data-picker-plain]");
    var allDay = form.querySelector("input[name=allDay]");
    var max = +(form.getAttribute("data-max") || "10");
    if (!plain || !allDay) return;
    var rowInputs = [];
    for (var r = 0; r < max; r++) {
      var a = form.querySelector("input[name=start_" + r + "]");
      var b = form.querySelector("input[name=end_" + r + "]");
      // The server shows a few rows; the picker may fill up to the poll's maximum.
      if (!a) { a = el("input"); a.type = "datetime-local"; a.name = "start_" + r; plain.append(a); }
      if (!b) { b = el("input"); b.type = "datetime-local"; b.name = "end_" + r; plain.append(b); }
      rowInputs.push({ start: a, end: b });
    }
    var poll = pollFromRows(allDay.checked, rowInputs.map(function (x) { return { start: x.start.value, end: x.end.value }; }));
    var other = { times: poll.times, days: poll.days };
    var pending = null;
    var asking = null;
    var full = false;
    var first = poll.kind === DAYS ? (sortDays(poll.days)[0] || {}).from : (sortTimes(poll)[0] || {}).date;
    var view = { year: +(first || localToday()).slice(0, 4), month: +(first || localToday()).slice(5, 7) - 1 };

    var ui = el("div", "wd-picker");
    var kind = el("div", "wd-kind");
    var kindTimes = el("button", "", "A time on a day");
    var kindDays = el("button", "", "A stretch of days");
    kindTimes.type = kindDays.type = "button";
    kind.append(kindTimes, kindDays);
    var cal = calendar(view, paint, pick);
    var hint = el("p", "wd-hint");
    var chooser = el("div", "wd-chooser");
    chooser.setAttribute("role", "group");
    var chooserText = el("p");
    var chooserActions = el("div", "wd-chips");
    chooser.append(chooserText, chooserActions);
    var row = el("div", "wd-row");
    var timeLabel = el("label", "wd-field", "Starts");
    var time = el("input");
    time.type = "time";
    time.step = "900";
    time.value = poll.start;
    timeLabel.append(time);
    var lenLabel = el("label", "wd-field", "Length");
    var len = el("select");
    var lengths = LENGTHS.slice();
    if (lengths.indexOf(poll.length) === -1) lengths.push(poll.length);
    lengths.sort(function (x, y) { return x - y; }).forEach(function (m) { len.append(new Option(lengthLabel(m), String(m))); });
    len.value = String(poll.length);
    lenLabel.append(len);
    row.append(timeLabel, lenLabel);
    var head = el("div", "wd-headrow");
    var count = el("h3");
    var again = el("button", "", "Same again, +1 week");
    again.type = "button";
    head.append(count, again);
    var list = el("ul", "wd-opts");
    ui.append(kind, cal.node, hint, chooser, row, head, list);

    function options() { return poll.kind === DAYS ? sortDays(poll.days) : sortTimes(poll); }
    function startOf(t) { return t.own === null ? poll.start : t.own; }
    function endOf(t) { return fromMin(toMin(startOf(t)) + poll.length); }
    function canAdd() { full = options().length >= max; return !full; }

    function paint(key, btn) {
      if (poll.kind === DAYS) {
        var covering = [];
        options().forEach(function (d, i) { if (d.from <= key && key <= d.to) covering.push({ d: d, i: i }); });
        if (covering.length > 0) {
          var bars = el("span", "wd-bars");
          covering.forEach(function (c) {
            var bar = el("span", "wd-bar wd-o" + (c.i % 5) + (key === c.d.from ? " wd-first" : "") + (key === c.d.to ? " wd-last" : ""));
            bars.append(bar);
          });
          btn.append(bars);
          btn.setAttribute("aria-label", dayLabel(key) + ", in option " + covering.map(function (c) { return letter(c.i); }).join(" and "));
        }
        if (pending === key) btn.classList.add("wd-pending");
        btn.setAttribute("aria-pressed", String(pending === key));
      } else {
        var n = poll.times.filter(function (t) { return t.date === key; }).length;
        if (n > 0) btn.classList.add("wd-on");
        if (n > 1) btn.append(el("span", "wd-badge", "×" + n));
        if (asking === key) btn.classList.add("wd-asking");
        btn.setAttribute("aria-pressed", String(n > 0));
      }
    }
    function letter(i) { return "ABCDEFGHIJ".charAt(i); }

    function pick(key) {
      if (poll.kind === DAYS) {
        if (pending === null) { if (canAdd()) pending = key; }
        else {
          poll.days.push({ from: pending < key ? pending : key, to: pending < key ? key : pending });
          pending = null;
        }
      } else {
        var onDay = poll.times.filter(function (t) { return t.date === key; });
        if (onDay.length === 0) { asking = null; if (canAdd()) poll.times.push({ date: key, own: null }); }
        else if (onDay.length === 1) { asking = null; poll.times = poll.times.filter(function (t) { return t.date !== key; }); }
        else asking = asking === key ? null : key;
      }
      render();
    }

    function setKind(k) {
      if (k === poll.kind) return;
      other[poll.kind === DAYS ? "days" : "times"] = poll.kind === DAYS ? poll.days : poll.times;
      poll.kind = k;
      poll.days = other.days;
      poll.times = other.times;
      pending = null;
      asking = null;
      render();
    }
    kindTimes.addEventListener("click", function () { setKind("times"); });
    kindDays.addEventListener("click", function () { setKind(DAYS); });
    time.addEventListener("change", function () { if (time.value) { poll.start = time.value; render(); } });
    len.addEventListener("change", function () { poll.length = +len.value; render(); });
    again.addEventListener("click", function () {
      var opts = options();
      var last = opts[opts.length - 1];
      if (!last || !canAdd()) { render(); return; }
      var moved;
      if (poll.kind === DAYS) {
        moved = { from: addDays(last.from, 7), to: addDays(last.to, 7) };
        poll.days.push(moved);
        moved = moved.from;
      } else {
        moved = addDays(last.date, 7);
        poll.times.push({ date: moved, own: last.own });
      }
      view.year = +moved.slice(0, 4);
      view.month = +moved.slice(5, 7) - 1;
      render();
    });

    function renderChooser() {
      var onDay = asking === null ? [] : options().filter(function (t) { return t.date === asking; });
      chooser.hidden = poll.kind === DAYS || onDay.length < 2;
      if (chooser.hidden) { asking = null; return; }
      var all = options();
      chooserText.textContent = dayLabel(asking) + " has " + onDay.length + " times. Which do you want to remove?";
      chooserActions.textContent = "";
      function chip(label, fn) {
        var c = el("button", "", label);
        c.type = "button";
        c.addEventListener("click", fn);
        chooserActions.append(c);
        return c;
      }
      onDay.forEach(function (t) {
        chip(letter(all.indexOf(t)) + " · " + startOf(t) + "–" + endOf(t), function () {
          poll.times = poll.times.filter(function (x) { return x !== t; });
          asking = null;
          render();
        });
      });
      var day = asking;
      chip("Remove all", function () { poll.times = poll.times.filter(function (x) { return x.date !== day; }); asking = null; render(); });
      chip("Keep", function () { asking = null; render(); });
    }

    function renderList() {
      var opts = options();
      count.textContent = opts.length === 1 ? "1 option" : opts.length + " options";
      again.disabled = opts.length === 0;
      list.textContent = "";
      if (opts.length === 0) {
        list.append(el("li", "wd-empty", poll.kind === DAYS ? "No stretches yet. Tap a first day, then a last day." : "No days picked yet. Tap days on the calendar."));
        return;
      }
      opts.forEach(function (o, i) {
        var li = el("li");
        var tag = el("span", "wd-legend wd-o" + (i % 5), letter(i));
        var when = el("div", "wd-when");
        li.append(tag, when);
        if (poll.kind === DAYS) {
          when.textContent = o.from === o.to ? dayLabel(o.from) : dayLabel(o.from) + " – " + dayLabel(o.to);
          when.append(el("small", "", nightsLabel(o.from, o.to)));
        } else {
          when.textContent = dayLabel(o.date);
          when.append(el("span", "wd-times", startOf(o) + "–" + endOf(o)));
          var small = el("small", "", o.own === null ? "Shared time · " : "Own time · ");
          var more = el("button", "wd-link", "another time this day");
          more.type = "button";
          more.addEventListener("click", function () {
            if (!canAdd()) { render(); return; }
            var starts = poll.times.filter(function (t) { return t.date === o.date; }).map(function (t) { return toMin(startOf(t)); });
            var s = Math.max.apply(null, starts) + poll.length;
            if (s + poll.length > 1440) s = Math.max(0, Math.min.apply(null, starts) - poll.length);
            poll.times.push({ date: o.date, own: fromMin(s) });
            render();
          });
          small.append(more);
          when.append(small);
          var t = el("input");
          t.type = "time";
          t.step = "900";
          t.value = startOf(o);
          t.setAttribute("aria-label", "Start time of option " + letter(i));
          t.addEventListener("change", function () {
            if (!t.value) return;
            o.own = t.value === poll.start ? null : t.value;
            render();
          });
          li.append(t);
        }
        var x = el("button", "wd-x", "×");
        x.type = "button";
        x.setAttribute("aria-label", "Remove option " + letter(i));
        x.addEventListener("click", function () {
          if (poll.kind === DAYS) poll.days = poll.days.filter(function (d) { return d !== o; });
          else poll.times = poll.times.filter(function (d) { return d !== o; });
          render();
        });
        li.append(x);
        list.append(li);
      });
    }

    function render() {
      kindTimes.setAttribute("aria-pressed", String(poll.kind !== DAYS));
      kindDays.setAttribute("aria-pressed", String(poll.kind === DAYS));
      row.hidden = poll.kind === DAYS;
      canAdd();
      hint.textContent = full
        ? "That is the most options a poll can offer (" + max + "). Remove one to add another."
        : poll.kind === DAYS
          ? (pending ? "Starts " + dayLabel(pending) + ". Now tap the last day of this option." : "Tap the first day of an option, then its last day. Options may overlap.")
          : "Tap the days that could work. Each gets the shared time; tap a day with several times to choose which to remove.";
      cal.draw();
      renderChooser();
      renderList();
      // Write back: the plain rows are what the server reads.
      var rows = pollRows(poll);
      allDay.checked = poll.kind === DAYS;
      rowInputs.forEach(function (x, i) {
        x.start.value = rows[i] ? rows[i].start : "";
        x.end.value = rows[i] ? rows[i].end : "";
      });
    }

    plain.hidden = true;
    plain.parentNode.insertBefore(ui, plain);
    render();
  }

  var forms = document.querySelectorAll("form[data-picker=event]");
  for (var i = 0; i < forms.length; i++) enhanceEvent(forms[i]);
  var polls = document.querySelectorAll("form[data-picker=poll]");
  for (var j = 0; j < polls.length; j++) enhancePoll(polls[j]);
})();
</script>`;

/** The picker's style and script, placed after the form they enhance. */
export function pickerAssets() {
  return html`${PICKER_STYLE}${PICKER_SCRIPT}`;
}
