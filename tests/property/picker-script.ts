// SPDX-License-Identifier: AGPL-3.0-or-later
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { pickerAssets } from "../../src/web/picker.js";

// The picker ships as a script inside the page (src/web/picker.ts). This runs THAT
// script, extracted from the rendered assets, in a fresh context without a document,
// and returns the date logic it publishes, typed. What the unit tests and the
// properties (DESIGN §9 rc17) check is exactly what browsers get.

export const fieldsSchema = z.object({ allDay: z.boolean(), start: z.string(), end: z.string() });
export const pickSchema = z.object({
  date: z.string(),
  to: z.string(),
  time: z.string(),
  length: z.union([z.number(), z.literal("allday"), z.literal("days")]),
});
const weekSchema = z.object({
  week: z.number(),
  days: z.array(z.object({ key: z.string(), inMonth: z.boolean() })),
});
const summarySchema = z.object({ main: z.string(), sub: z.string() });
export const rowSchema = z.object({ start: z.string(), end: z.string() });
export const pollSchema = z.object({
  kind: z.enum(["times", "days"]),
  start: z.string(),
  length: z.number(),
  times: z.array(z.object({ date: z.string(), own: z.string().nullable() })),
  days: z.array(z.object({ from: z.string(), to: z.string() })),
});
/** Busy times as spread over days (rc41): minutes into each day. */
export const spreadSchema = z.record(
  z.string(),
  z.array(z.object({ from: z.number(), to: z.number() })),
);
export type Spread = z.infer<typeof spreadSchema>;
export type Fields = z.infer<typeof fieldsSchema>;
export type Pick = z.infer<typeof pickSchema>;
export type Row = z.infer<typeof rowSchema>;
export type Poll = z.infer<typeof pollSchema>;

const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");

/** The script's source, exactly as the page carries it. */
export function pickerSource(): string {
  const assets = pickerAssets().value;
  const open = assets.indexOf("<script>");
  const close = assets.lastIndexOf("</script>");
  return assets.slice(open + "<script>".length, close);
}

export function loadPicker() {
  const sandbox: { WhenDoWePicker?: unknown } = {};
  runInNewContext(pickerSource(), sandbox);
  const api = z
    .object({
      monthGrid: fn,
      isoWeek: fn,
      toFields: fn,
      fromFields: fn,
      summary: fn,
      pollRows: fn,
      pollFromRows: fn,
      spreadBusy: fn,
      clash: fn,
      busyText: fn,
      busyDays: fn,
    })
    .parse(sandbox.WhenDoWePicker);
  // Results cross from the sandbox's realm; parse them back into this one.
  return {
    monthGrid: (y: number, m: number) => z.array(weekSchema).parse(api.monthGrid(y, m)),
    isoWeek: (key: string) => z.number().parse(api.isoWeek(key)),
    toFields: (p: Pick) => fieldsSchema.parse(api.toFields(p)),
    fromFields: (f: Fields, today: string) => pickSchema.parse(api.fromFields(f, today)),
    summary: (p: Pick) => summarySchema.parse(api.summary(p)),
    pollRows: (poll: Poll) => z.array(rowSchema).parse(api.pollRows(poll)),
    pollFromRows: (allDay: boolean, rows: Row[]) =>
      pollSchema.parse(api.pollFromRows(allDay, rows)),
    spreadBusy: (items: unknown) => spreadSchema.parse(api.spreadBusy(items)),
    clash: (days: Spread, date: string, start: number, length: number) =>
      z.boolean().parse(api.clash(days, date, start, length)),
    busyText: (spans: Spread[string]) => z.string().parse(api.busyText(spans)),
    busyDays: (days: Spread, from: string, to: string) =>
      z.number().parse(api.busyDays(days, from, to)),
  };
}
