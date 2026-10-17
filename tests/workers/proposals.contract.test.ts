// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runProposalsContract } from "../contract/proposals.suite.js";

// The same change-proposal contract against a real D1 binding in workerd.
runProposalsContract(async () => d1StoragePort(env.DB));
