// SPDX-License-Identifier: AGPL-3.0-or-later
import { runTokenCipherContract } from "../contract/token-cipher.suite.js";

// The same suite inside workerd — the token cipher claims to be platform-blind
// (WebCrypto global, never node:crypto); this is what makes that claim testable.
runTokenCipherContract();
