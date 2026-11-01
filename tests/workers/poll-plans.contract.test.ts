// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPollPlansContract } from "../contract/poll-plans.suite.js";

// Polls as one-event plans against a real D1 binding in workerd.
runPollPlansContract(async () => d1StoragePort(env.DB));
