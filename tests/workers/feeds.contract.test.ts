// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runFeedsContract } from "../contract/feeds.suite.js";

// Calendar feeds against a real D1 binding in workerd.
runFeedsContract(async () => d1StoragePort(env.DB));
