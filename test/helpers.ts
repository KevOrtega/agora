import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Hook under test: `GUARD_HOOK_PATH` (test-only override) or the installed `.claude/` copy. */
export const HOOK_PATH = process.env.GUARD_HOOK_PATH
  ? resolve(process.env.GUARD_HOOK_PATH)
  : resolve(repoRoot, ".claude/hooks/guard-bash.mjs");

/** Settings under test: `GUARD_SETTINGS_PATH` (test-only override) or the installed `.claude/` copy. */
export const SETTINGS_PATH = process.env.GUARD_SETTINGS_PATH
  ? resolve(process.env.GUARD_SETTINGS_PATH)
  : resolve(repoRoot, ".claude/settings.json");

/** Reads a QA case file: one command per line, blank lines and `#` comments skipped. */
export function readCases(name: string): string[] {
  return readFileSync(new URL(`./fixtures/qa-cases/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"));
}

export type Layers = "both" | "hook" | "deny";
export interface LayeredCase {
  layers: Layers;
  command: string;
}

/** Reads a layered case file: lines are `<both|hook|deny> | <command>` (split on the first ` | ` only). */
export function readLayeredCases(name: string): LayeredCase[] {
  return readCases(name).map((line) => {
    const idx = line.indexOf(" | ");
    const layers = line.slice(0, idx) as Layers;
    if (!["both", "hook", "deny"].includes(layers)) throw new Error(`bad layer in ${name}: ${line}`);
    return { layers, command: line.slice(idx + 3) };
  });
}

export interface ProbeCase {
  command: string;
  residual: boolean;
  hook?: "BLOCK" | "pass";
  deny?: "DENY" | "pass";
}

/** Reads a probe file: `hook=<BLOCK|pass> deny=<DENY|pass> | <command>` or `residual | <command>`. */
export function readProbeCases(name: string): ProbeCase[] {
  return readCases(name).map((line) => {
    const idx = line.indexOf(" | ");
    const head = line.slice(0, idx);
    const command = line.slice(idx + 3);
    if (head === "residual") return { command, residual: true };
    const m = /^hook=(BLOCK|pass) deny=(DENY|pass)$/.exec(head);
    if (!m) throw new Error(`bad probe line in ${name}: ${line}`);
    return { command, residual: false, hook: m[1] as "BLOCK" | "pass", deny: m[2] as "DENY" | "pass" };
  });
}

// Internal-path needles are built from parts so no file (including this one) contains them literally.
export const INTERNAL_PATH_NEEDLES = [
  "/" + "home/",
  "/" + "workspace/",
  "~/" + "factory",
  "/" + "cursor/",
  "/" + "box/",
];

/** Returns the internal-path needles found in `text`. */
export function findInternalPaths(text: string): string[] {
  return INTERNAL_PATH_NEEDLES.filter((n) => text.includes(n));
}
