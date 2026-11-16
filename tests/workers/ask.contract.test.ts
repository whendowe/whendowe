// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runAskContract } from "../contract/ask.suite.js";

// Unsent questions against a real D1 binding in workerd.
runAskContract(async () => d1StoragePort(env.DB));
