// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runRetentionContract } from "../contract/retention.suite.js";

// Retention against a real D1 binding in workerd.
runRetentionContract(async () => d1StoragePort(env.DB));
