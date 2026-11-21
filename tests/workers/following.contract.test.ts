// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runFollowingContract } from "../contract/following.suite.js";

// Following calendars against a real D1 binding in workerd.
runFollowingContract(async () => d1StoragePort(env.DB));
