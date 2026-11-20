// covers AG-SEC-01
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const workflow = read(".github/workflows/secret-scan.yml");
const config = read(".gitleaks.toml");

describe("secret scan workflow", () => {
  it("runs on pull requests and on pushes to main", () => {
    expect(workflow).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(workflow).toMatch(/push:\s*\n\s+branches: \[main\]/);
  });

  it("checks out the full history", () => {
    expect(workflow).toMatch(/fetch-depth: 0/);
  });

  it("pins the gitleaks version and verifies a SHA-256 checksum", () => {
    expect(workflow).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+/);
    expect(workflow).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}\b/);
    expect(workflow).toContain("sha256sum -c");
  });

  it("redacts findings and fails on leaks", () => {
    expect(workflow).toContain("--redact");
    expect(workflow).toContain("--exit-code 1");
    expect(workflow).toContain("--config .gitleaks.toml");
  });

  it("scans the PR commit range", () => {
    expect(workflow).toContain("--log-opts");
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
  });

  it("has a self-test step before the real scans", () => {
    const selfTest = workflow.indexOf("Self-test");
    expect(selfTest).toBeGreaterThan(-1);
    expect(selfTest).toBeLessThan(workflow.indexOf("Scan pull request commits"));
    expect(selfTest).toBeLessThan(workflow.indexOf("Scan full history"));
  });

  it("uses no secrets, tokens or the gitleaks action", () => {
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("gitleaks-action");
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
  });
});

describe(".gitleaks.toml", () => {
  const lines = config.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("extends the default ruleset", () => {
    expect(lines.join("\n")).toMatch(/useDefault = true/);
  });

  it("does not allowlist anything broader than a single file", () => {
    const paths = lines.join("\n").match(/paths\s*=\s*\[[^\]]*\]/g) ?? [];
    for (const entry of paths) {
      const items = [...entry.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? "");
      for (const item of items) {
        expect(item).not.toMatch(/\.\*|\*|\(|\||\[/);
        expect(item).toMatch(/\.[A-Za-z0-9]+(\$)?$/);
      }
    }
  });
});
