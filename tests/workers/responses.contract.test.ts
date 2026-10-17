// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runResponsesContract } from "../contract/responses.suite.js";

// The same responses contract against a real D1 binding in workerd.
runResponsesContract(async () => d1StoragePort(env.DB));
