// Prints the public JWKS for a dispatch signing key, using the code Convex
// signs with, so the kid the provider holds is the one Convex puts in its JWTs.
//
//   node signing-jwks.mjs <private-key.pem>

import { readFileSync } from "node:fs";

import { signingKeyJwks } from "../../dist/dispatch/cloud-run/index.js";

const path = process.argv[2];
if (!path) throw new Error("usage: signing-jwks.mjs <private-key.pem>");
process.stdout.write(`${JSON.stringify(await signingKeyJwks(readFileSync(path, "utf8")))}\n`);
