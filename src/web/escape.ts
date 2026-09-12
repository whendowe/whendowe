// SPDX-License-Identifier: AGPL-3.0-or-later

// HTML escaping (DESIGN.md §13: "All calendar content is untrusted input, both
// directions. Inbound titles/descriptions are authored by arbitrary
// calendar-sharers: escape on HTML render (no raw HTML from event fields)").
//
// src/web/app.ts carried the note "the moment event fields reach a view, they are
// untrusted input and must be escaped on render". That moment is here: the OAuth
// callback renders a calendar summary and an account identifier that came from
// Google, i.e. from whatever the account holder typed.
//
// Escapes the five characters that matter in element text and in quoted attribute
// values. `&` must be first or the other replacements would be double-escaped.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
