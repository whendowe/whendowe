// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runHeldContract } from "../contract/held.suite.js";

// Held actions against a real D1 binding in workerd.
runHeldContract(async () => d1StoragePort(env.DB));
