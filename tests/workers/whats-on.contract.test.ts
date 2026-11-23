// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runWhatsOnContract } from "../contract/whats-on.suite.js";

// What's on against a real D1 binding in workerd.
runWhatsOnContract(async () => d1StoragePort(env.DB));
