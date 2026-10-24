// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:test";
import { d1StoragePort } from "../../src/db/d1.js";
import { runParticipantsContract } from "../contract/participants.suite.js";

// The same people-on-an-event contract against a real D1 binding in workerd.
runParticipantsContract(async () => d1StoragePort(env.DB));
