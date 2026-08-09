/**
 * Golden parity suite: every case in cases.json must produce byte-identical
 * output through the TS port as the Python engine wrote to expected.json.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCase } from "./golden/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "golden", "cases.json"), "utf8")).cases as Array<
  { name: string; kind: string }
>;
const expected = JSON.parse(readFileSync(join(here, "golden", "expected.json"), "utf8")) as Record<string, string>;

describe("golden parity (Python engine vs TS port)", () => {
  for (const c of cases) {
    it(`${c.name} [${c.kind}]`, () => {
      const actual = runCase(c as unknown as Record<string, unknown>);
      expect(actual).toBe(expected[c.name]);
    });
  }
});
