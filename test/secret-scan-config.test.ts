// covers AG-SEC-01
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoPath = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(repoPath(path), "utf8");

const workflow = read(".github/workflows/secret-scan.yml");
const config = read(".gitleaks.toml");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

/** Every gitleaks invocation in the workflow, with line continuations joined. */
const invocations = (text: string): string[] =>
  text.replace(/\\\n\s*/g, " ").match(/gitleaks (?:git|dir) [^\n]*/g) ?? [];

/** Returns a description of every allowlist mechanism found in a gitleaks TOML config. */
export function findAllowlistViolations(toml: string): string[] {
  const violations: string[] = [];
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (/^\[\[?[^\]]*allowlists?[^\]]*\]\]?/i.test(trimmed)) violations.push(`table: ${trimmed}`);
    if (/^(allowlists?|regexes|stopwords|commits|paths|regexTarget|disabledRules|targetRules)\s*=/.test(trimmed)) {
      violations.push(`key: ${trimmed}`);
    }
  }
  return violations;
}

const workflowGit = invocations(workflow).filter((i) => i.startsWith("gitleaks git"));
const scripts = pkg.scripts["secret-scan"] ?? "";

describe("secret scan workflow", () => {
  it("runs on pull requests and on pushes to any branch", () => {
    expect(workflow).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(workflow).toMatch(/push:\s*\n\s+branches: \['\*\*'\]/);
  });

  it("checks out the full history without persisting credentials", () => {
    expect(workflow).toMatch(/fetch-depth: 0/);
    expect(workflow).toMatch(/persist-credentials: false/);
    expect(workflow).toContain("actions/checkout@v4");
  });

  it("pins the gitleaks version and verifies a SHA-256 checksum", () => {
    expect(workflow).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+/);
    expect(workflow).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}\b/);
    expect(workflow).toContain("sha256sum -c");
  });

  it("every gitleaks invocation redacts and ignores gitleaks:allow comments", () => {
    const all = invocations(workflow);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const inv of all) {
      expect(inv).toContain("--redact");
      expect(inv).toContain("--no-banner");
      expect(inv).toContain("--ignore-gitleaks-allow");
      expect(inv).toContain("--config .gitleaks.toml");
    }
  });

  it("every gitleaks git invocation scans merge commits with -m", () => {
    expect(workflowGit).toHaveLength(3);
    for (const inv of workflowGit) expect(inv).toMatch(/--log-opts "-m[ "]/);
    expect(scripts).toMatch(/--log-opts "-m[ "]/);
    expect(scripts).toContain("--ignore-gitleaks-allow");
    expect(scripts).toContain("--config .gitleaks.toml");
  });

  it("scans the PR commit range and the full history on push", () => {
    const pr = workflowGit.filter((i) => i.includes("pull_request.base.sha"));
    expect(pr).toHaveLength(1);
    expect(pr[0]).toContain("github.event.pull_request.head.sha");
    expect(pr[0]).toContain("--exit-code 1");
    const full = workflowGit.filter((i) => i.includes("--exit-code 1") && i.includes("--all --full-history"));
    expect(full).toHaveLength(1);
    expect(workflow).toContain("if: github.event_name == 'push'");
  });

  it("has self-tests that require exactly exit code 42, before the real scans", () => {
    const selfTests = invocations(workflow).filter((i) => i.includes("--exit-code 42"));
    expect(selfTests).toHaveLength(2);
    expect(workflow.match(/-ne 42/g)).toHaveLength(2);
    const lastSelfTest = workflow.lastIndexOf("Merge self-test passed");
    expect(lastSelfTest).toBeGreaterThan(-1);
    expect(lastSelfTest).toBeLessThan(workflow.indexOf("Scan pull request commits"));
    expect(lastSelfTest).toBeLessThan(workflow.indexOf("Scan full history"));
    expect(workflow).toContain("--no-ff --no-commit");
  });

  it("rejects .gitleaksignore files before scanning", () => {
    expect(workflow).toContain("-name .gitleaksignore");
    expect(workflow.indexOf("-name .gitleaksignore")).toBeLessThan(workflow.indexOf("Self-test"));
  });

  it("uses no secrets, tokens, report artifacts or the gitleaks action", () => {
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("gitleaks-action");
    expect(workflow).not.toContain("upload-artifact");
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
  });

  it("does not track any .gitleaksignore file", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: repoPath("."), encoding: "utf8" }).split("\n");
    expect(files.filter((f) => f === ".gitleaksignore" || f.endsWith("/.gitleaksignore"))).toEqual([]);
  });
});

describe(".gitleaks.toml", () => {
  it("extends the default ruleset", () => {
    const body = config
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(body).toMatch(/useDefault = true/);
  });

  it("has no allowlist of any kind", () => {
    expect(findAllowlistViolations(config)).toEqual([]);
  });

  it("ignores comment lines", () => {
    expect(findAllowlistViolations("# [allowlist]\n# regexes = ['.*']\n")).toEqual([]);
  });

  it.each([
    ["[allowlist]", "[allowlist]\nregexes = ['.*']"],
    ["regexes", "regexes = ['.*']"],
    ["stopwords", "stopwords = ['fake']"],
    ["commits", "commits = ['abc123']"],
    ["paths", "paths = ['test/fixture.txt']"],
    ["regexTarget", "regexTarget = 'line'"],
    ["[[allowlists]]", "[[allowlists]]\nregexes = ['x']"],
    ["[[rules.allowlists]]", "[[rules]]\nid = 'x'\n[[rules.allowlists]]\nstopwords = ['x']"],
    ["[extend] disabledRules", "[extend]\nuseDefault = true\ndisabledRules = ['github-pat']"],
  ])("rejects %s", (_name, toml) => {
    expect(findAllowlistViolations(toml).length).toBeGreaterThan(0);
  });
});

// Local-only: needs the gitleaks binary on PATH (CI's lint-and-test job has none, so it skips there).
const hasGitleaks = spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;

describe("merge commit scanning (needs gitleaks on PATH)", () => {
  it.skipIf(!hasGitleaks)("finds a secret present only in a merge commit, and only with -m", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-canary-"));
    try {
      const repo = join(dir, "repo");
      mkdirSync(repo);
      const git = (...args: string[]): void => {
        execFileSync(
          "git",
          ["-C", repo, "-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", ...args],
          { stdio: "ignore" },
        );
      };
      const write = (name: string, content: string): void => writeFileSync(join(repo, name), content);

      git("init", "-q", "-b", "main");
      write("base.txt", "base\n");
      git("add", "base.txt");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "side");
      write("side.txt", "side\n");
      git("add", "side.txt");
      git("commit", "-q", "-m", "side");
      git("checkout", "-q", "main");
      write("main.txt", "main\n");
      git("add", "main.txt");
      git("commit", "-q", "-m", "main");
      git("merge", "-q", "--no-ff", "--no-commit", "side");
      // Built at runtime so no token-shaped literal ever exists in the repo.
      const suffix = randomBytes(64).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 36);
      write("merge-only.txt", `github_token = "${["ghp", suffix].join("_")}"\n`);
      git("add", "merge-only.txt");
      git("commit", "-q", "-m", "merge");

      const logOpts = /--log-opts "([^"]*)"|--log-opts \\"([^"\\]*)\\"/.exec(scripts);
      const repoLogOpts = logOpts?.[1] ?? logOpts?.[2] ?? "";
      expect(repoLogOpts).toMatch(/^-m /);

      const scan = (opts: string): number | null =>
        spawnSync(
          "gitleaks",
          [
            "git", repo, "--redact", "--no-banner", "--ignore-gitleaks-allow", "--exit-code", "42",
            "--config", repoPath(".gitleaks.toml"), "--log-opts", opts,
          ],
          { stdio: "ignore" },
        ).status;

      expect(scan("--all --full-history")).toBe(0); // without -m the merge-only secret is missed
      expect(scan(repoLogOpts)).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
