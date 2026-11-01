// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runVoteLinksContract } from "../contract/vote-links.suite.js";

// A thread's vote links against a real D1 binding in workerd.
runVoteLinksContract(async () => d1StoragePort(env.DB));
