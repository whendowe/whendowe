// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPushTickContract } from "../contract/push-tick.suite.js";

// The push tick against a real D1 binding in workerd.
runPushTickContract(async () => d1StoragePort(env.DB));
