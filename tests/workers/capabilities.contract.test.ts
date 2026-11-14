// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runCapabilitiesContract } from "../contract/capabilities.suite.js";

// The same capabilities contract against a real D1 binding in workerd.
runCapabilitiesContract(async () => d1StoragePort(env.DB));
