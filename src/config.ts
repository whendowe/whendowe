// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Config comes from env, parsed and validated here (DESIGN.md §13).
// Platform adapters in deploy/ pass their env source in; domain code never
// reads process.env or Workers bindings directly.
export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1).default("file:data/whendowe.db"),
  // Resolved against the working directory by the Node migration runner; the
  // compiled dist/ layout and the tsx dev layout sit at different depths, so a
  // file-relative path would break one of them.
  MIGRATIONS_DIR: z.string().min(1).default("migrations"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env);
}
