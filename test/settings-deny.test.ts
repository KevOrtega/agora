import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCases } from "./helpers.js";

const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
const base = JSON.parse(readFileSync(new URL("./fixtures/qa-settings-base.json", import.meta.url), "utf8"));
const deny: string[] = settings.permissions.deny;

// --- Port of QA's sim_deny.py (Bash rules only) ---
function ruleRegex(p: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let r = p.split("*").map(esc).join(".*");
  if (p.endsWith(" *") && p.split("*").length === 2) r = `(?:${r}|${esc(p.slice(0, -2))})`;
  return new RegExp(`^${r}$`, "s");
}
const bashRules = deny.filter((d) => d.startsWith("Bash(")).map((d) => ({ rule: d, rx: ruleRegex(d.slice(5, -1)) }));
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"]);

function subcommands(cmd: string): string[] {
  const out: string[] = [];
  for (const part of cmd.split(/\|\||&&|\|&|[;|&\n]/)) {
    let toks = part.trim().split(" ");
    if (toks.join("") === "") continue;
    let changed = true;
    while (changed && toks.length) {
      changed = false;
      const t0 = toks[0] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t0)) {
        toks = toks.slice(1);
        changed = true;
      } else if (WRAPPERS.has(t0)) {
        toks = toks.slice(1);
        changed = true;
        while (toks.length && (toks[0]!.startsWith("-") || /^\d+[smhd]?$/.test(toks[0]!))) toks = toks.slice(1);
      } else if (t0 === "xargs" && toks.length > 1 && !toks[1]!.startsWith("-")) {
        toks = toks.slice(1);
        changed = true;
      }
    }
    out.push(toks.join(" "));
  }
  return out;
}
function deniedBy(cmd: string): string | null {
  for (const s of subcommands(cmd)) for (const { rule, rx } of bashRules) if (rx.test(s)) return rule;
  return null;
}

// Documented limits: Bash text rules cannot catch these. The hook (git push / gh pr merge / gh api inside
// bash -c, sh -c, eval) or the Read/Edit rules cover them instead; the rest is defense-in-depth residual.
const EXCEPTION_PREFIXES = [
  "bash -c", "sh -c", "eval ", // nested shells: covered by the hook for push/merge/api
  "node -e", "python3 -c", // interpreters: not analysed (residual)
  "source .env", // covered by Read(.env*) only for direct readers (residual)
  "grep -r . .", // recursive grep (residual)
  "git merge main", // local merge; protection of main is GitHub branch protection
  "kubectl apply", // non-listed platform (gcloud run deploy / wrangler deploy are matched by *deploy*)
  // Covered by Read(...) / Edit(...) deny rules, not by Bash rules:
  "cat ~/", "cat /proc/", "head -c 200 /proc/", "cat .env", "cat config/.env", "tail server.key",
  "sed -n 1p secrets/", "node app.js < .env", "cat > .claude/", "echo '{}' > .claude/", "echo x >> .claude/",
  "echo x | tee .claude/", "cd .claude && echo",
];
const isException = (c: string) => EXCEPTION_PREFIXES.some((p) => c.startsWith(p) && deniedBy(c) === null);

describe("settings.json deny rules", () => {
  const allowedCases = [...readCases("allowed_cases.txt"), "gh pr edit 1 --body-file /tmp/f0-1-pr-body.md"];

  it.each(allowedCases)("does not deny: %s", (c) => {
    expect(deniedBy(c)).toBeNull();
  });

  it("push script contains neither 'deploy' nor 'TOKEN'", () => {
    const c = "bash /home/box/factory/tasks/F0-1/push.sh";
    expect(c).not.toMatch(/deploy|TOKEN/);
    expect(deniedBy(c)).toBeNull();
  });

  // all_cases.txt ends with commands that are intentionally allowed (not block cases).
  const intendedAllowed = [
    /^gh pr create /, /^gh pr checks /, /^npm (test|run lint)$/, /^git (commit|status)\b/,
  ];
  const blockCases = [...new Set(["block_cases.txt", "extra_cases.txt", "all_cases.txt"].flatMap(readCases))].filter(
    (c) => !allowedCases.includes(c) && !c.includes("push.sh") && !intendedAllowed.some((rx) => rx.test(c)),
  );

  it.each(blockCases)("denies (or documented exception): %s", (c) => {
    expect(deniedBy(c) !== null || isException(c)).toBe(true);
  });

  it("deny list is the QA base plus Write(./.claude/**)", () => {
    expect(deny).toEqual([...base.permissions.deny, "Write(./.claude/**)"]);
  });

  it("has required Read/Edit/Write rules", () => {
    for (const r of ["Read(./.env*)", "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(./secrets/**)", "Read(**/secrets/**)", "Edit(./.claude/**)", "Write(./.claude/**)"]) {
      expect(deny).toContain(r);
    }
  });

  it("registers the Bash PreToolUse guard hook", () => {
    const entry = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toContain(".claude/hooks/guard-bash.mjs");
  });
});
