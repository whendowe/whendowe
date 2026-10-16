// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runEventsContract } from "../contract/events.suite.js";

// The same events contract against a real D1 binding in workerd.
runEventsContract(async () => d1StoragePort(env.DB));
