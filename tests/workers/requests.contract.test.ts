// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runRequestsContract } from "../contract/requests.suite.js";

// The same response-request contract against a real D1 binding in workerd.
runRequestsContract(async () => d1StoragePort(env.DB));
