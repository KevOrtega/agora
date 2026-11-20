import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
// Needles are built from parts so this file does not match itself.
const NEEDLES = ["/" + "home/", "/" + "workspace/"];

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
    for (const n of NEEDLES) expect(text, `${f} contains ${n}`).not.toContain(n);
  });
});
