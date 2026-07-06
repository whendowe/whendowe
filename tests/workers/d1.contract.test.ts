// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runStoragePortContract } from "../contract/storage-port.suite.js";

// The same contract suite as tests/contract/sqlite.contract.test.ts, against a
// real D1 binding inside workerd — the both-drivers matrix of DESIGN.md §9.
runStoragePortContract(async () => d1StoragePort(env.DB));
