import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// Convex calls this from its default runtime, which has fetch and Web Crypto
// but no Node APIs. Checking that it imports only its own files keeps out
// `node:` modules and anything from the rest of the package that might pull
// them in. Node's globals are kept out by tsconfig.dispatch.json, which
// typechecks it with a worker's globals instead.

const dir = new URL(".", import.meta.url);

describe("the Cloud Run dispatch module", () => {
  it("imports nothing but its own files", async () => {
    const sources = (await readdir(dir)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = await readFile(new URL(file, dir), "utf8");
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[^/]+\.ts$/);
      }
    }
  });
});
