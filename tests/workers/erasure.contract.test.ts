// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runErasureContract } from "../contract/erasure.suite.js";

// Deleting an account against a real D1 binding in workerd.
runErasureContract(async () => d1StoragePort(env.DB));
