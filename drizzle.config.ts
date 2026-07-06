// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "drizzle-kit";

// Migrations are generated as plain .sql (DESIGN.md §16): applied identically by
// `wrangler d1 migrations` and the Node runner. Append-only; never edit an applied one.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
