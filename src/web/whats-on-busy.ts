// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// What's on's script (DESIGN §10 rc58, F2b). The page is drawn with your WhenDoWe events
// counted, and never waits for Google (rc41). This then asks GET /busy for the same days in
// UTC and takes out what overlaps Google's busy times — or, when clashes are shown, dims it and
// says "You have something then" — and a line says whether Google's busy times were counted.
//
// Only timed busy times are used. Google's are always timed (busyFromSpans); whole days are
// your own WhenDoWe events, which the server counted already, so an all-day event — which
// clashes only with whole days (rc58) — is never touched here.
//
// Like the plan pages' scripts, it is a literal inside the html tag: no backtick, dollar-brace
// or backslash. Its pure logic is published as globalThis.WhenDoWeWhatsOnBusy for unit tests.
const SCRIPT = html`<script>
(function () {
  "use strict";
  var MINUTE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/;

  /** The answer's timed busy items, in UTC, as [a, z) milliseconds; anything else is skipped. */
  function spans(items) {
    var out = [];
    (Array.isArray(items) ? items : []).forEach(function (b) {
      if (!b || typeof b !== "object" || b.allDay !== false) return;
      if (typeof b.start !== "string" || typeof b.end !== "string") return;
      if (!MINUTE.test(b.start) || !MINUTE.test(b.end)) return;
      var a = Date.parse(b.start + ":00Z"), z = Date.parse(b.end + ":00Z");
      if (!isNaN(a) && !isNaN(z) && z > a) out.push({ a: a, z: z });
    });
    return out;
  }
  /**
   * Whether an event from start to end (instants, as data-start and data-end hold them) meets
   * any of list. Touching ends don't overlap; a moment with no length meets what is going on
   * then. An event with no instants (all day) meets nothing here.
   */
  function clashes(list, start, end) {
    var s = Date.parse(String(start)), e = Date.parse(String(end));
    if (isNaN(s) || isNaN(e) || e < s) return false;
    return list.some(function (b) { return s === e ? b.a <= s && s < b.z : b.a < e && s < b.z; });
  }
  /** "(2 events overlap something of yours)". */
  function countText(n) {
    return "(" + (n === 1 ? "1 event overlaps" : n + " events overlap") + " something of yours)";
  }
  /** The line under the heading, from the answer's google field; "" when there's no Google. */
  function googleLine(state) {
    if (state === "shown") return "Your Google busy times are counted too.";
    if (state === "failed") return "Couldn't load your Google busy times.";
    if (state === "unavailable") return "Showing Google busy times isn't available to this account.";
    return "";
  }

  globalThis.WhenDoWeWhatsOnBusy = { spans: spans, clashes: clashes, countText: countText, googleLine: googleLine };
  if (typeof document === "undefined") return;

  var box = document.querySelector("[data-whats-on]");
  if (!box || typeof fetch !== "function") return;
  var showing = box.getAttribute("data-clashes") === "1";
  var q = "?from=" + box.getAttribute("data-from") + "&to=" + box.getAttribute("data-to") + "&tz=UTC";
  fetch(box.getAttribute("data-whats-on") + q, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .catch(function () { return null; })
    .then(function (data) {
      if (!data || typeof data !== "object") return;
      var said = googleLine(data.google);
      if (said !== "") {
        var line = document.createElement("p");
        line.className = "small muted busynote";
        line.textContent = said;
        // Under the page's own line, which says what is left out.
        var intro = box.querySelector("h1 + p");
        if (intro) intro.after(line); else box.prepend(line);
      }
      var list = spans(data.busy);
      if (list.length === 0) return;
      var items = box.querySelectorAll(".on > li:not(.clash)"), more = 0;
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        if (!clashes(list, li.getAttribute("data-start"), li.getAttribute("data-end"))) continue;
        more++;
        li.classList.add("clash");
        if (showing) {
          var note = document.createElement("span");
          note.className = "muted";
          note.textContent = "· You have something then";
          li.append(" ", note);
        } else li.hidden = true;
      }
      if (more === 0 || showing) return;
      var left = 0, days = box.querySelectorAll("ul.on");
      for (var d = 0; d < days.length; d++) {
        var open = days[d].querySelectorAll("li:not([hidden])").length;
        left += open;
        if (open > 0) continue;
        days[d].hidden = true;
        var h = days[d].previousElementSibling;
        if (h && h.tagName === "H2") h.hidden = true;
      }
      var toggle = box.querySelector("[data-clash-toggle]");
      if (toggle) {
        toggle.querySelector("[data-clash-count]").textContent =
          countText(Number(toggle.getAttribute("data-clash-toggle")) + more);
        toggle.hidden = false;
      }
      var none = box.querySelector("[data-none]");
      if (none && left === 0) none.hidden = false;
    });
})();
</script>`;

/** What's on's script, after the page (rc58). */
export function whatsOnBusyAssets() {
  return SCRIPT;
}
