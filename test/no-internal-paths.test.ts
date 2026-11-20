import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findInternalPaths, INTERNAL_PATH_NEEDLES } from "./helpers.js";

const root = new URL("../", import.meta.url);

describe("internal path detector", () => {
  it("knows the expected needles", () => {
    expect(INTERNAL_PATH_NEEDLES).toHaveLength(5);
  });

  it.each(INTERNAL_PATH_NEEDLES)("catches %s in a sample string", (needle) => {
    expect(findInternalPaths(`see ${needle}x/y.txt for details`)).toContain(needle);
  });

  it("does not flag clean text", () => {
    expect(findInternalPaths("path/to/push.sh and src/app.ts and /usr/bin/node")).toEqual([]);
  });
});

describe("no internal machine paths in the public repo", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && f !== "package-lock.json");

  it("tracks files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s", (f) => {
    let text: string;
    try {
      text = readFileSync(new URL(f, root), "utf8");
    } catch {
      return; // deleted in the working tree
    }
    expect(findInternalPaths(text), `${f} contains an internal path`).toEqual([]);
  });
});
