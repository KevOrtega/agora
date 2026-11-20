import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readCases } from "./helpers.js";

const HOOK = new URL("../.claude/hooks/guard-bash.mjs", import.meta.url).pathname;
const PUSH_SCRIPT = "bash /home/box/factory/tasks/F0-1/push.sh";

function runHook(input: unknown): { code: number | null; stderr: string } {
  const r = spawnSync("node", [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string) => runHook({ tool_name: "Bash", tool_input: { command } });

const isPushScript = (c: string) => c.trim() === PUSH_SCRIPT;
const shouldBlock = (c: string) => /\bgit\b.*\bpush\b|gh pr merge|gh api\b/.test(c) && !isPushScript(c);

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
      PUSH_SCRIPT,
      "/home/box/factory/tasks/F0-1/push.sh",
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
    ];
  }
});

describe("guard-bash hook: other inputs", () => {
  it("ignores non-Bash tools", () => {
    expect(runHook({ tool_name: "Read", tool_input: { file_path: "x" } }).code).toBe(0);
  });
  it("blocks unparseable input", () => {
    expect(runHook("not json").code).toBe(2);
  });
  it("does not allow extra args on the push script", () => {
    expect(bash(`${PUSH_SCRIPT} && git push origin main`).code).toBe(2);
  });
});
