// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPollsContract } from "../contract/polls.suite.js";

// The same time-poll contract against a real D1 binding in workerd.
runPollsContract(async () => d1StoragePort(env.DB));
