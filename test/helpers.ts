import { readFileSync } from "node:fs";

/** Reads a QA case file: one command per line, blank lines and `#` comments skipped. */
export function readCases(name: string): string[] {
  return readFileSync(new URL(`./fixtures/qa-cases/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"));
}
