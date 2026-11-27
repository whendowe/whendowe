// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runSetupContract } from "../contract/setup.suite.js";

// The same setup contract against a real D1 binding in workerd.
runSetupContract(async () => d1StoragePort(env.DB));
