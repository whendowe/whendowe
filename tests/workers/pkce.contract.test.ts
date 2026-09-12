// SPDX-License-Identifier: AGPL-3.0-or-later
import { runPkceContract } from "../contract/pkce.suite.js";

// The same suite inside workerd: crypto.subtle.digest must agree with Node's, or
// a connection started on one deployment target could not be completed on the other.
runPkceContract();
