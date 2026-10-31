// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPlansContract } from "../contract/plans.suite.js";

// The same plans contract against a real D1 binding in workerd.
runPlansContract(async () => d1StoragePort(env.DB));
