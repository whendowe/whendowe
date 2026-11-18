// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runMailTrailContract } from "../contract/mail-trail.suite.js";

// Mail that stops (rc51) against a real D1 binding in workerd.
runMailTrailContract(async () => d1StoragePort(env.DB));
