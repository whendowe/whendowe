// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runMailCapContract } from "../contract/mail-cap.suite.js";

// The same reservation contract against a real D1 binding in workerd.
runMailCapContract(async () => d1StoragePort(env.DB));
