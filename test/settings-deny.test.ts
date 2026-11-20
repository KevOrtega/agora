import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCases, readLayeredCases, readProbeCases, SETTINGS_PATH } from "./helpers.js";

const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
const base = JSON.parse(readFileSync(new URL("./fixtures/qa-settings-base.json", import.meta.url), "utf8"));
const deny: string[] = settings.permissions.deny;

// The only QA-base rules that may be replaced (m1: substring rules narrowed to command-position patterns).
// Each replacement stays at the position of the rule it replaces.
const cmdPos = (cli: string) => [`Bash(${cli}*)`, `Bash(*/${cli} *)`, `Bash(*/${cli})`];
const REPLACEMENTS: Record<string, string[]> = {
  "Bash(*railway*)": cmdPos("railway"),
  "Bash(*vercel*)": cmdPos("vercel"),
  "Bash(*flyctl*)": cmdPos("flyctl"),
  "Bash(*netlify*)": cmdPos("netlify"),
  "Bash(*heroku*)": cmdPos("heroku"),
  "Bash(*deploy*)": [
    "Bash(npm run deploy*)", "Bash(npm run-script deploy*)", "Bash(yarn deploy*)", "Bash(pnpm deploy*)",
    "Bash(pnpm run deploy*)", "Bash(make deploy*)", "Bash(*/deploy*.sh*)", "Bash(./deploy*)", "Bash(deploy*)",
  ],
};
const WRAPPER_PREFIXES = ["sudo ", "env ", "exec ", "eval ", "xargs ", "*sh -c"];
const WRAPPER_CLIS = [
  "railway", "vercel", "flyctl", "fly", "netlify", "heroku", "kubectl", "gcloud", "gsutil", "doctl", "wrangler", "helm", "aws", "az",
  "terraform", "pulumi", "oc", "supabase", "firebase", "claude",
];
const SHORT_CLIS = ["fly", "helm", "aws", "az", "oc"];
// Rules added after `Write(./.claude/**)`, in order.
const NEW_RULES = [
  // F0-1b round 2 (aliases, user-level settings)
  "Bash(git config*alias*)", "Bash(git -c *alias*)", "Bash(git --config-env*)", "Bash(gh alias*)",
  ...cmdPos("kubectl"), ...cmdPos("gcloud"), ...cmdPos("doctl"), ...cmdPos("wrangler"),
  "Bash(helm *)", "Bash(*/helm *)", "Bash(*/helm)",
  "Bash(aws *)", "Bash(*/aws *)", "Bash(*/aws)",
  "Bash(az *)", "Bash(*/az *)", "Bash(*/az)",
  "Edit(~/.claude/**)", "Write(~/.claude/**)",
  // m2: more cloud/IaC CLIs, bare or by path
  ...cmdPos("gsutil"), ...cmdPos("terraform"), ...cmdPos("pulumi"),
  "Bash(oc *)", "Bash(*/oc *)", "Bash(*/oc)",
  ...cmdPos("supabase"),
  "Bash(*/fly *)", "Bash(*/fly)",
  "Bash(podman push*)", "Bash(*/podman push*)",
  // M1: push bypasses
  "Bash(*send-pack*)", "Bash(*git-push*)", "Bash(*http-push*)",
  // m3: nested Claude Code and hook disabling
  "Bash(claude*)", "Bash(*/claude *)", "Bash(*/claude)", "Bash(npx *claude*)",
  "Bash(*--settings*)", "Bash(*disableAllHooks*)", "Bash(*dangerously-skip-permissions*)",
  // m5: writes into .claude
  "Bash(*>*.claude/*)", "Bash(*truncate*.claude*)", "Bash(*tee*.claude/*)", "Bash(*cp *.claude/*)",
  "Bash(*mv *.claude*)", "Bash(*rm *.claude*)", "Bash(*sed -i*.claude*)", "Bash(*ln *.claude*)",
  "Bash(*chmod *.claude*)", "Bash(*install *.claude/*)", "Bash(*dd *of=*.claude*)", "Bash(*perl -*i*.claude*)",
  // Package-runner forms of the CLIs whose substring rules were narrowed (still denied if hooks are off)
  ...["npx", "bunx", "pnpm dlx", "yarn dlx", "npm exec"].flatMap((runner) =>
    [
      ...["railway", "vercel", "flyctl", "netlify", "heroku", "wrangler", "firebase", "supabase", "kubectl", "gcloud", "doctl", "serverless", "sls"].map(
        (cli) => `Bash(${runner} *${cli}*)`,
      ),
      `Bash(${runner} eb *)`, // short name: word-boundary form (also matches bare `eb`)
    ],
  ),
  // firebase/render deploy and hosting API hosts (QA base cases that used to match substring rules)
  ...cmdPos("firebase"), "Bash(render deploy*)", "Bash(*/render deploy*)",
  "Bash(*railway.app*)", "Bash(*api.vercel.com*)", "Bash(*api.netlify.com*)", "Bash(*api.heroku.com*)",
  // Round-1 follow-ups: attached `-c<value>` alias, cd/pushd into .claude, deploy tools with `deploy` as first argument
  "Bash(git -c*alias*)", "Bash(cd *.claude*)", "Bash(pushd *.claude*)",
  "Bash(eb deploy*)", "Bash(*/eb deploy*)", "Bash(serverless deploy*)", "Bash(*/serverless deploy*)",
  "Bash(sls deploy*)", "Bash(*/sls deploy*)",
  // Wrapper forms (the deny list does not see through wrappers): for each wrapper, every narrowed/added CLI, then deploy.
  // Short CLI names use a word-boundary form (`<cli> *` and `<cli>`) so they do not match inside other words.
  ...WRAPPER_PREFIXES.flatMap((p) => [
    ...WRAPPER_CLIS.flatMap((c) => (SHORT_CLIS.includes(c) ? [`Bash(${p}*${c} *)`, `Bash(${p}*${c})`] : [`Bash(${p}*${c}*)`])),
    `Bash(${p}*deploy*)`,
  ]),
  // Deploy scripts run through runtimes and package runners (node deploy.js, npx sls deploy, deno run deploy.ts, ...)
  ...["node", "npx", "bunx", "pnpm dlx", "yarn dlx", "npm exec", "tsx", "ts-node", "deno", "bun"].map((r) => `Bash(${r} *deploy*)`),
];

// --- Port of QA's sim_deny.py (Bash rules only) ---
function ruleRegex(p: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let r = p.split("*").map(esc).join(".*");
  if (p.endsWith(" *") && p.split("*").length === 2) r = `(?:${r}|${esc(p.slice(0, -2))})`;
  return new RegExp(`^${r}$`, "s");
}
const compileRules = (rules: string[]) =>
  rules.filter((d) => d.startsWith("Bash(")).map((d) => ({ rule: d, rx: ruleRegex(d.slice(5, -1)) }));
const bashRules = compileRules(deny);
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
function deniedByRules(rules: ReturnType<typeof compileRules>, cmd: string): string | null {
  for (const s of subcommands(cmd)) for (const { rule, rx } of rules) if (rx.test(s)) return rule;
  return null;
}
const deniedBy = (cmd: string) => deniedByRules(bashRules, cmd);

// Documented limits: Bash text rules cannot catch these. The hook (git push / gh pr merge / gh api inside
// bash -c, sh -c, eval) or the Read/Edit rules cover them instead; the rest is defense-in-depth residual.
const EXCEPTION_PREFIXES = [
  "bash -c", "sh -c", "eval ", // nested shells: covered by the hook for push/merge/api
  "node -e", "python3 -c", // interpreters: not analysed (residual)
  "source .env", // covered by Read(.env*) only for direct readers (residual)
  "grep -r . .", // recursive grep (residual)
  "git merge main", // local merge; protection of main is GitHub branch protection
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
    const c = "bash path/to/push.sh";
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

  it("deny list keeps the QA base in order (only the documented replacements), then Write(./.claude/**), then the new rules", () => {
    const baseRules: string[] = base.permissions.deny;
    const expectedBase = baseRules.flatMap((r) => REPLACEMENTS[r] ?? [r]);
    expect(deny).toEqual([...expectedBase, "Write(./.claude/**)", ...NEW_RULES]);
    // Every other QA-base rule is still present verbatim.
    for (const r of baseRules.filter((x) => !(x in REPLACEMENTS))) expect(deny).toContain(r);
    // Rules that must not come back as substring rules.
    for (const r of Object.keys(REPLACEMENTS)) expect(deny).not.toContain(r);
    expect(deny).toContain("Bash(*TOKEN*)");
    expect(deny).toContain("Bash(*environ*)");
  });

  it("has no duplicate rules", () => {
    expect(new Set(deny).size).toBe(deny.length);
  });

  describe("QA round 1 cases (both layers where a deny pattern applies)", () => {
    const bypass = readLayeredCases("r1_bypass_cases.txt");
    const denied = readLayeredCases("r1_denied_cases.txt");
    const allowedBoth = readCases("r1_allowed_cases.txt");

    it.each(bypass.filter((c) => c.layers !== "hook").map((c) => c.command))("M1 deny list blocks: %s", (c) => {
      expect(deniedBy(c)).not.toBeNull();
    });
    it("M1: every send-pack / git-push / http-push fixture has a deny pattern", () => {
      for (const c of bypass.filter((x) => /send-pack|git-push|http-push/.test(x.command))) {
        expect(deniedBy(c.command), c.command).not.toBeNull();
      }
    });
    it.each(denied.filter((c) => c.layers !== "hook").map((c) => c.command))("deny list blocks: %s", (c) => {
      expect(deniedBy(c)).not.toBeNull();
    });
    it.each(allowedBoth)("deny list allows: %s", (c) => {
      expect(deniedBy(c)).toBeNull();
    });

    const probes = readProbeCases("r1_qa_new_probes.txt").filter((p) => !p.residual);
    it.each(probes.map((p) => [p.deny, p.command] as const))("QA probe: deny=%s | %s", (expected, cmd) => {
      expect(deniedBy(cmd) !== null).toBe(expected === "DENY");
    });
    it("lists the documented residuals", () => {
      expect(readProbeCases("r1_qa_new_probes.txt").filter((p) => p.residual).length).toBeGreaterThanOrEqual(10);
    });

    // m2: every cloud/IaC CLI, bare and by path.
    const CLIS: Record<string, string> = {
      aws: "s3 ls", az: "account show", helm: "install rel ./chart", gcloud: "run services list", gsutil: "ls gs://x",
      doctl: "apps list", wrangler: "whoami", kubectl: "get pods", terraform: "apply", pulumi: "up", oc: "get pods",
      supabase: "db push", podman: "push registry.example.invalid/app:1",
    };
    const cloud = Object.entries(CLIS).flatMap(([cli, a]) => [`${cli} ${a}`, `/usr/bin/${cli} ${a}`, `../bin/${cli} ${a}`]);
    it.each(cloud)("m2 deny list blocks: %s", (c) => {
      expect(deniedBy(c)).not.toBeNull();
    });
    it.each(["aws", "/usr/bin/aws", "terraform", "/opt/bin/terraform", "oc"])("m2 deny list blocks bare command: %s", (c) => {
      expect(deniedBy(c)).not.toBeNull();
    });
  });

  describe("Edit/Write deny rules for .claude (m5)", () => {
    // Minimal matcher for Edit/Write path rules: `./X/**` (project) and `~/X/**` (user).
    const pathDenied = (tool: "Edit" | "Write", path: string): boolean =>
      deny.some((r) => {
        const m = new RegExp(`^${tool}\\((.+)/\\*\\*\\)$`).exec(r);
        const dirRule = m?.[1];
        if (!dirRule) return false;
        const strip = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
        return strip(path).startsWith(`${strip(dirRule)}/`);
      });
    it.each(["Edit", "Write"] as const)("%s denied for project and user settings", (tool) => {
      expect(pathDenied(tool, ".claude/settings.json")).toBe(true);
      expect(pathDenied(tool, "./.claude/hooks/guard-bash.mjs")).toBe(true);
      expect(pathDenied(tool, "~/.claude/settings.json")).toBe(true);
      expect(pathDenied(tool, "src/app.ts")).toBe(false);
    });
  });

  it.each(["git config alias.p push", "git -c alias.p=push p origin main", "git -c alias.p=push p origin HEAD:refs/heads/main"])(
    "denies alias trick: %s",
    (c) => {
      expect(deniedBy(c)).not.toBeNull();
    },
  );

  it.each(readCases("cloud_cli_cases.txt"))("denies cloud CLI: %s", (c) => {
    expect(deniedBy(c)).not.toBeNull();
  });

  it.each(readCases("workflow_allowed_cases.txt"))("does not deny workflow command: %s", (c) => {
    expect(deniedBy(c)).toBeNull();
  });

  it("denies editing user-level Claude settings", () => {
    expect(deny).toContain("Edit(~/.claude/**)");
    expect(deny).toContain("Write(~/.claude/**)");
  });

  describe("nothing denied before QA round 1 becomes un-denied", () => {
    const before = JSON.parse(readFileSync(new URL("./fixtures/deny-before-r1.json", import.meta.url), "utf8"));
    const oldRules = compileRules(before.permissions.deny as string[]);
    // Accepted m1 false positives (pure text/read commands that used to match substring rules). Explicit on purpose.
    const ACCEPTED_FALSE_POSITIVES = new Set([
      'echo "deploying soon"',
      "grep -rn deploy docs",
      'git commit -m "docs: mention kubectl usage"',
      "grep kubectl README.md",
      "cat notes/railway.md",
      "echo deploy",
      "grep deploy docs",
      "git log --grep deploy",
    ]);
    // Every line of every fixture, with layer/expectation prefixes removed.
    const dir = new URL("./fixtures/qa-cases/", import.meta.url);
    const lines = [
      ...new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith(".txt"))
          .flatMap((f) => readCases(f))
          .map((l) => l.replace(/^(?:(?:both|hook|deny|residual) \| |hook=\S+ deny=\S+ \| )/, "")),
      ),
    ];

    it("checks a meaningful number of fixture lines", () => {
      expect(lines.length).toBeGreaterThan(200);
    });

    it("every old-denied command is still denied, except the accepted false positives", () => {
      const regressions = lines.filter(
        (c) => deniedByRules(oldRules, c) !== null && deniedBy(c) === null && !ACCEPTED_FALSE_POSITIVES.has(c),
      );
      expect(regressions).toEqual([]);
    });

    it("the accepted false positives were denied before and are allowed now", () => {
      for (const c of ACCEPTED_FALSE_POSITIVES) {
        expect(deniedByRules(oldRules, c), c).not.toBeNull();
        expect(deniedBy(c), c).toBeNull();
      }
    });
  });

  it("keeps hooks enabled", () => {
    expect(settings.disableAllHooks).toBe(false);
  });

  it("has required Read/Edit/Write rules", () => {
    for (const r of ["Read(./.env*)", "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(./secrets/**)", "Read(**/secrets/**)", "Edit(./.claude/**)", "Write(./.claude/**)"]) {
      expect(deny).toContain(r);
    }
  });

  it("registers the Bash PreToolUse guard hook", () => {
    const entry = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
    const hook = entry.hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toBe("node");
    expect(hook.args).toEqual(["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-bash.mjs"]);
    expect(hook.onFailure).toBe("block");
    expect(hook.timeout).toBe(10);
  });
});
