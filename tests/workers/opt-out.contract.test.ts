// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runOptOutContract } from "../contract/opt-out.suite.js";

// Opt-outs against a real D1 binding in workerd.
runOptOutContract(async () => d1StoragePort(env.DB));
