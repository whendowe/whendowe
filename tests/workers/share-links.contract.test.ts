// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runShareLinksContract } from "../contract/share-links.suite.js";

// Shared links against a real D1 binding in workerd.
runShareLinksContract(async () => d1StoragePort(env.DB));
