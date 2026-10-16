// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runGroupsContract } from "../contract/groups.suite.js";

// The same groups contract against a real D1 binding in workerd.
runGroupsContract(async () => d1StoragePort(env.DB));
