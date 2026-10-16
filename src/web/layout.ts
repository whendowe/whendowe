// SPDX-License-Identifier: AGPL-3.0-or-later
import { escapeHtml } from "./escape.js";

// The page shell, and a template tag that makes escaping the DEFAULT (§13).
//
// Before this, every page escaped by hand — escapeHtml(x) at each interpolation — and
// one forgotten call is an XSS hole. Here, `html` escapes every interpolated value
// unless it is itself an Html fragment produced by `html`. Raw HTML therefore has to
// be built from other `html` fragments; a plain string can never smuggle markup in.

/** HTML known to be safe: only ever constructed by the `html` tag below. */
export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

type Interpolation = Html | string | number | boolean | null | undefined | readonly Interpolation[];

function render(value: Interpolation): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  // null/undefined/false render as nothing, so `${cond && html`…`}` works.
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

/** Tagged template: literal parts pass through, every interpolation is escaped. */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new Html(out);
}

export function renderPage(title: string, body: Html): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · WhenDoWe</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  input[type=email] { font: inherit; padding: .5rem; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
  .muted { opacity: .7; }
  .error { color: #b3261e; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  header form { margin: 0; }
</style>
</head>
<body>
${body}
</body>
</html>`.value;
}
