// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPurgeContract } from "../contract/purge.suite.js";

// Leaving, deleting and the purge pipeline against a real D1 binding in workerd.
runPurgeContract(async () => d1StoragePort(env.DB));
