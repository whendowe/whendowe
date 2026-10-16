// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runPeopleContract } from "../contract/people.suite.js";

// The same people / login / session contract against a real D1 binding in workerd.
runPeopleContract(async () => d1StoragePort(env.DB));
