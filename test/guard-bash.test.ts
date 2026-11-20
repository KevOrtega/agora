import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HOOK_PATH as HOOK, readCases, readLayeredCases, readProbeCases } from "./helpers.js";

function runHook(input: unknown, env: Record<string, string> = {}): { code: number | null; stderr: string } {
  const r = spawnSync("node", [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string) => runHook({ tool_name: "Bash", tool_input: { command } });

const shouldBlock = (c: string) => /\bgit\b.*\bpush\b|gh pr merge|gh api\b/.test(c);

const allCases = [...new Set(["allowed_cases.txt", "block_cases.txt", "extra_cases.txt", "all_cases.txt"].flatMap(readCases))];

describe("guard-bash hook: QA cases", () => {
  const blocked = allCases.filter(shouldBlock);

  it("covers a meaningful number of push/merge/api cases", () => {
    expect(blocked.length).toBeGreaterThan(40);
  });

  it.each(blocked)("blocks: %s", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Blocked by guard-bash hook/);
  });

  it.each(allowed())("allows: %s", (cmd) => {
    expect(bash(cmd).code).toBe(0);
  });

  function allowed(): string[] {
    return [
      "bash path/to/push.sh",
      "path/to/push.sh",
      'gh pr create --base main --head chore/x --title "chore: x" --body-file /tmp/b.md',
      "gh pr edit 1 --body-file /tmp/f0-1-pr-body.md",
      "gh pr checks 1 --watch",
      "gh pr view 1",
      "npm ci",
      "npm test",
      "npm run lint",
      "npm run typecheck",
      "npm run dev",
      "git add -A",
      'git commit -m "chore: x"',
      "git status",
      "git diff",
      "git log --oneline -5",
      ...readCases("allowed_cases.txt"),
      ...readCases("workflow_allowed_cases.txt"),
    ];
  }
});

describe("guard-bash hook: obfuscated forms (N2)", () => {
  it.each(readCases("obfuscated_push_cases.txt"))("blocks: %s", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Blocked by guard-bash hook/);
  });

  it.each(readCases("workflow_allowed_cases.txt"))("allows workflow command: %s", (cmd) => {
    expect(bash(cmd).code).toBe(0);
  });
});

describe("guard-bash hook: QA round 1 (M1, m1, m2, m3, m5)", () => {
  const hookBlocked = (file: string) => readLayeredCases(file).filter((c) => c.layers !== "deny").map((c) => c.command);

  it.each(hookBlocked("r1_bypass_cases.txt"))("blocks push bypass: %s", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Blocked by guard-bash hook/);
  });

  it.each(hookBlocked("r1_denied_cases.txt"))("blocks: %s", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Blocked by guard-bash hook/);
  });

  it.each(readCases("r1_allowed_cases.txt"))("allows: %s", (cmd) => {
    expect(bash(cmd).code).toBe(0);
  });

  const probes = readProbeCases("r1_qa_new_probes.txt").filter((p) => !p.residual);
  it.each(probes.map((p) => [p.hook, p.command] as const))("QA probe: hook=%s | %s", (expected, cmd) => {
    expect(bash(cmd).code).toBe(expected === "BLOCK" ? 2 : 0);
  });

  const CLIS: Record<string, string> = {
    aws: "s3 ls", az: "account show", helm: "install rel ./chart", gcloud: "run services list", gsutil: "ls gs://x",
    doctl: "apps list", wrangler: "whoami", kubectl: "get pods", terraform: "apply", pulumi: "up", oc: "get pods",
    supabase: "db push", podman: "push registry.example.invalid/app:1",
  };
  const cloud = Object.entries(CLIS).flatMap(([cli, args]) => [
    `${cli} ${args}`,
    `/usr/bin/${cli} ${args}`,
    `../bin/${cli} ${args}`,
    `sudo ${cli} ${args}`,
    `bash -c "${cli} ${args}"`,
  ]);
  it.each(cloud)("blocks cloud/IaC CLI: %s", (cmd) => {
    expect(bash(cmd).code).toBe(2);
  });

  it.each(["git commit -m x; echo kubectl", "cat notes/terraform.md", "grep -rn aws docs", "echo supabase", "ls ../bin"])(
    "does not block mere mentions: %s",
    (cmd) => {
      expect(bash(cmd).code).toBe(0);
    },
  );
});

describe("guard-bash hook: other inputs", () => {
  it("ignores non-Bash tools", () => {
    expect(runHook({ tool_name: "Read", tool_input: { file_path: "x" } }).code).toBe(0);
  });
  it("does not allow chaining after the push script", () => {
    expect(bash("bash path/to/push.sh && git push origin main").code).toBe(2);
  });
});

describe("guard-bash hook: fails closed (N1)", () => {
  it.each([
    ["invalid JSON", "not json"],
    ["empty stdin", ""],
    ["JSON null", "null"],
    ["missing tool_name", { tool_input: { command: "ls" } }],
    ["missing command", { tool_name: "Bash", tool_input: {} }],
    ["missing tool_input", { tool_name: "Bash" }],
    ["non-string command", { tool_name: "Bash", tool_input: { command: 42 } }],
    ["empty command", { tool_name: "Bash", tool_input: { command: "  " } }],
  ])("exits 2 on %s", (_name, input) => {
    const r = runHook(input);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Blocked by guard-bash hook/);
  });

  it("exits 2 on an internal error", () => {
    const r = runHook({ tool_name: "Bash", tool_input: { command: "ls" } }, { GUARD_BASH_FORCE_ERROR: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/internal error/);
  });
});
