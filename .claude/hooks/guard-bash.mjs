#!/usr/bin/env node
// PreToolUse hook for the Bash tool (defense in depth; real protection of main is GitHub branch protection).
// Reads the hook JSON from stdin. Exit 2 (reason on stderr) blocks the command; exit 0 allows it.
// Fails closed: unparseable input, a Bash call without a string command, or any unexpected error exits 2.
//
// Terminology:
// - "dynamic" word: a word that CONTAINS `$`, a backtick, `{` or `}` anywhere (not only as a whole word),
//   e.g. `$x`, `pu${x}sh`, `p$(true)ush`, `{push,x}`, or a word glued to a backtick.
// - "command position": the first word of a command, after separators (; & | newline ( ) ` and group braces),
//   variable assignments and wrappers (env, sudo, exec, xargs, nohup, timeout, command, bash -c, sh -c, eval, npx...).
//
// Blocks:
// - `git push`, `git send-pack`, `git receive-pack`, `git http-push` (any global options, quoting, spacing),
//   also inside bash -c / sh -c / eval / env / exec / xargs. Quotes and backslashes are removed before matching.
// - Any command word whose basename starts with `git-` (git-push, git-send-pack, ...), bare or by path.
// - `gh pr merge`, `gh api`, `gh alias`; git aliases defined on the fly (`git -c alias...`, `git config alias`,
//   GIT_CONFIG* variables).
// - A git/gh subcommand or positional, or a command word, that is dynamic (fail closed).
// - Hosting/cloud/IaC/deploy CLIs by the basename of the command word (not by substring of the text):
//   railway vercel fly flyctl netlify heroku kubectl helm aws az gcloud gsutil doctl wrangler terraform pulumi oc
//   supabase firebase, `render deploy*`, `docker|podman push`, `deploy*` executables, `npm|yarn|pnpm|make ... deploy*`
//   targets, package-runner forms (`npx vercel`, `pnpm dlx @railway/cli`, `npm exec -- vercel`), and words that
//   contain a hosting API hostname (railway.app, api.vercel.com, api.netlify.com, api.heroku.com).
// - Any other command whose FIRST argument starts with `deploy` (eb deploy, sls deploy), except text commands
//   (echo, printf, grep, rg, cat, ls, git, ...), and `cd`/`pushd` into a path containing `.claude`.
// - A nested Claude Code (command word `claude`), and any text with `disableAllHooks` or
//   `--dangerously-skip-permissions`, or `--settings` together with claude.
// - Writes to any path containing `.claude`: redirections, truncate, tee, cp/mv/install/rsync, rm, sed -i,
//   perl -i, ln, chmod, chown, touch, dd of=, find -delete/-exec, git rm/mv/restore/checkout. Reads stay allowed.
// Known accepted false positive: any text containing `git push` (echo, commit message) is blocked.
// Residuals: interpreters (python, perl scripts), copied git binaries, pre-existing aliases in .git/config.

const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source",
]);
const GH_OPTS_WITH_VALUE = new Set(["-R", "--repo"]);
const GIT_BLOCKED_SUBCOMMANDS = new Set(["push", "send-pack", "receive-pack", "http-push"]);

// Commands that run their arguments as another command (the command word follows them).
const WRAPPERS = new Set([
  "env", "exec", "nohup", "time", "command", "builtin", "nice", "timeout", "stdbuf", "sudo", "doas", "xargs", "noglob",
  "setsid", "ionice", "npx", "pnpx", "bunx", "bash", "sh", "zsh", "dash", "ksh", "ash", "eval", "source",
  "then", "do", "else", "elif", "if", "while", "until", "!",
]);
// Wrapper options that take a separate value (so the value is not mistaken for the command word).
const WRAPPER_OPT_VALUES = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C"]),
  timeout: new Set(["-s", "-k"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]),
};
const NUMERIC = /^\d+(\.\d+)?[smhd]?$/;

const BLOCKED_CLIS = new Set([
  "railway", "vercel", "fly", "flyctl", "netlify", "heroku", "kubectl", "helm", "aws", "az", "gcloud", "gsutil",
  "doctl", "wrangler", "terraform", "pulumi", "oc", "supabase", "firebase", "claude", "claude-code",
]);

// Names a command word can stand for: `vercel@latest` -> vercel, `netlify-cli` -> netlify,
// `@railway/cli` -> railway (package-runner forms such as `npx @railway/cli up`).
function cliKeys(token) {
  const base = basename(token).replace(/@[^@/]+$/, "");
  const scope = token.startsWith("@") && token.includes("/") ? token.slice(1, token.indexOf("/")) : "";
  return [base, base.replace(/-(cli|tools)$/, ""), scope].filter(Boolean);
}
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "make"]);
// Commands that only read or print text: a `deploy` argument to them is not a deploy.
const TEXT_COMMANDS = new Set([
  "echo", "printf", "grep", "rg", "egrep", "fgrep", "cat", "less", "more", "head", "tail", "ls", "find", "wc", "sed", "awk",
  "git", "man", "which", "type",
]);
const RUNTIMES = new Set(["node", "tsx", "ts-node", "deno", "bun"]);
const PACKAGE_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "x"]);
// Hostnames of hosting provider APIs (any word containing one is blocked, e.g. curl to a deploy API).
const BLOCKED_HOSTS = /railway\.app|api\.vercel\.com|api\.netlify\.com|api\.heroku\.com/;

const WRITE_ANY = new Set(["truncate", "tee", "rm", "chmod", "chown", "touch", "shred", "unlink", "rmdir", "mv", "ln", "patch", "ed", "curl", "wget"]);
const WRITE_DEST = new Set(["cp", "install", "rsync"]);
// Redirection (>, >>, >|, &>, >&) whose target contains `.claude`.
const WRITE_REDIRECT = /(?:&>>?|>>?\|?|>&)\s*[^\s;&|()<>]*\.claude/;

class Block extends Error {}
const deny = (reason) => {
  throw new Block(reason);
};

// Quotes and backslashes are REMOVED (so g""it and p\ush become git and push). Words are split on whitespace and
// on separators; `;` is the segment separator token. Each word records whether it is dynamic. A backtick is its
// own token (bt) and marks the words glued to it as dynamic.
function tokenize(command) {
  const s = command.replace(/["'\\]/g, "");
  const out = [];
  let word = "";
  let wordDyn = false;
  let pending = false; // the next word starts right after a backtick
  let btOpen = false;
  const flush = (endsAtBacktick) => {
    if (word !== "") {
      if (word === "{" || word === "}") out.push({ v: ";", dyn: false });
      else out.push({ v: word, dyn: wordDyn || endsAtBacktick || /[${}]/.test(word) });
    }
    word = "";
    wordDyn = false;
  };
  for (const ch of s) {
    if (ch === "`") {
      flush(true);
      out.push({ v: "`", dyn: true, bt: true, open: !btOpen });
      btOpen = !btOpen;
      pending = true;
    } else if (/[;&|\n()<>]/.test(ch)) {
      flush(false);
      out.push({ v: ";", dyn: false });
      pending = false;
    } else if (/\s/.test(ch)) {
      flush(false);
      pending = false;
    } else {
      if (word === "" && pending) {
        wordDyn = true;
        pending = false;
      }
      word += ch;
    }
  }
  flush(false);
  return out;
}

const basename = (token) => token.slice(token.lastIndexOf("/") + 1);
const isSimpleVar = (t) => /^\$(\w+|\{\w+\})$/.test(t);

// Returns up to `max` positional (non-option) words after index i, within the current segment.
// mode "git"/"gh": fails closed on a dynamic positional or a dynamic option value that is not a plain variable.
// mode "loose": dynamic words are returned as-is (used for package-manager scripts).
function positionals(tokens, i, optsWithValue, max, mode) {
  const out = [];
  for (let j = i + 1; j < tokens.length && out.length < max; j++) {
    const tk = tokens[j];
    const t = tk.v;
    if (t === ";") break;
    if (!tk.bt && t.startsWith("-")) {
      // `-c name=value` / `--config-env name=env`, with the value separate (-c x) or attached (-cx, --config-env=x).
      if (mode === "git" && (t.startsWith("-c") || t.startsWith("--config-env"))) {
        const separate = t === "-c" || t === "--config-env";
        const v = separate ? (tokens[j + 1]?.v ?? "") : "";
        if (/alias/i.test(t + v)) deny("git aliases can hide `git push`; `-c alias...` is not allowed.");
        if (tk.dyn || (separate && tokens[j + 1]?.dyn)) deny("git config value built from expansion is not allowed.");
      }
      if (optsWithValue.has(t)) {
        j++;
        const vt = tokens[j];
        if (vt === undefined || vt.v === ";") break;
        if (vt.dyn && !isSimpleVar(vt.v)) deny("option value built from expansion is not allowed.");
      }
      continue;
    }
    if (tk.dyn && mode !== "loose") deny("subcommand built from command substitution or variable expansion is not allowed.");
    out.push(t);
  }
  return out;
}

function segmentArgs(tokens, i) {
  const out = [];
  for (let j = i + 1; j < tokens.length && tokens[j].v !== ";" && !tokens[j].bt; j++) out.push(tokens[j].v);
  return out;
}

function checkWrites(name, args) {
  const touches = (a) => a.includes(".claude");
  const why = "writing to .claude is not allowed (the operator edits it).";
  if (WRITE_ANY.has(name) && args.some(touches)) deny(why);
  if (WRITE_DEST.has(name)) {
    const positional = args.filter((a) => !a.startsWith("-"));
    const ti = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    const target = ti < 0 ? "" : args[ti].includes("=") ? args[ti] : (args[ti + 1] ?? "");
    if (touches(positional.at(-1) ?? "") || touches(target)) deny(why);
  }
  if ((name === "sed" || name === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) && args.some(touches)) deny(why);
  if (name === "dd" && args.some((a) => a.startsWith("of=") && touches(a))) deny(why);
  if (name === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a)) && args.some(touches)) deny(why);
}

// Checks the command word at tokens[i]. Returns true when it is itself a wrapper (npm exec, pnpm dlx, ...).
function checkCommandWord(tokens, i, name) {
  if (name.startsWith("git-")) deny("git-* executables (git-push, git-send-pack, ...) are not allowed.");
  const blocked = cliKeys(tokens[i].v).find((k) => BLOCKED_CLIS.has(k));
  if (blocked) deny(`\`${blocked}\` is not allowed (hosting/cloud/IaC CLI or nested Claude Code).`);
  if (/^deploy/.test(name)) deny("deploy scripts are not allowed without the owner's approval.");
  // `eb deploy`, `sls deploy`, `render deploys create`, ...: any command whose first argument starts with `deploy`,
  // except text/inspection commands that merely mention it (echo deploy, grep deploy docs, git log --grep deploy).
  const segArgs = segmentArgs(tokens, i);
  const inspectsText = TEXT_COMMANDS.has(name) && !(name === "sed" && segArgs.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")));
  if (!inspectsText && /^deploy/.test(positionals(tokens, i, new Set(), 1, "loose")[0] ?? "")) {
    deny("commands that run a deploy are not allowed without the owner's approval.");
  }
  // Deploy scripts run through a runtime: node deploy.js, node scripts/deploy.ts, deno run deploy.ts, tsx deploy.ts.
  if (RUNTIMES.has(name) && positionals(tokens, i, new Set(), 2, "loose").some((x) => /^deploy/.test(basename(x)))) {
    deny("deploy scripts are not allowed without the owner's approval.");
  }
  if ((name === "cd" || name === "pushd") && segArgs.some((a) => a.includes(".claude"))) {
    deny("changing into .claude is not allowed (relative writes there bypass the path checks).");
  }
  if (name === "docker" || name === "podman") {
    if (positionals(tokens, i, new Set(), 1, "loose")[0] === "push") deny(`\`${name} push\` is not allowed.`);
  }
  let isWrapper = false;
  if (PACKAGE_MANAGERS.has(name)) {
    const p = positionals(tokens, i, new Set(), 3, "loose");
    const isDeploy = (x) => /^deploy([:._-]|$)/.test(x ?? "");
    if (name === "make" ? p.some(isDeploy) : isDeploy(p[0]) || ((p[0] === "run" || p[0] === "run-script") && isDeploy(p[1]))) {
      deny("deploy targets/scripts are not allowed without the owner's approval.");
    }
    if (PACKAGE_EXEC_SUBCOMMANDS.has(p[0])) isWrapper = true;
  }
  checkWrites(name, segmentArgs(tokens, i));
  return isWrapper;
}

function inspect(command) {
  if (/disableAllHooks|dangerously-skip-permissions/i.test(command)) {
    deny("disabling hooks or permissions is not allowed.");
  }
  const stripped = command.replace(/["'\\]/g, "");
  if (/--settings\b/.test(stripped) && /claude/i.test(stripped)) deny("`--settings` with claude is not allowed.");
  if (WRITE_REDIRECT.test(stripped)) deny("redirecting output into .claude is not allowed (the operator edits it).");
  if (BLOCKED_HOSTS.test(stripped)) deny("hosting provider APIs are not allowed without the owner's approval.");

  const tokens = tokenize(command);
  let atCommand = true; // next word is a command word
  let afterWrapper = false;
  let wrapperName = "";
  let viaXargs = false;
  const reset = () => {
    atCommand = true;
    afterWrapper = false;
    viaXargs = false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const t = tk.v;
    if (t === ";") {
      reset();
      continue;
    }
    if (tk.bt) {
      if (tk.open) reset();
      else atCommand = false;
      continue;
    }
    const name = basename(t);
    if (atCommand) {
      const assign = /^([A-Za-z_]\w*)=(.*)$/s.exec(t);
      if (assign) {
        if (assign[1].startsWith("GIT_CONFIG")) deny("GIT_CONFIG* variables can define git aliases; not allowed.");
        const v = basename(assign[2]);
        if (v === "git" || v === "gh") deny("storing git/gh in a variable is not allowed.");
        continue;
      }
      if (afterWrapper && t.startsWith("-")) {
        if (WRAPPER_OPT_VALUES[wrapperName]?.has(t)) i++;
        continue;
      }
      if (afterWrapper && NUMERIC.test(t)) continue;
      // `npm exec`, `pnpm dlx`, `yarn dlx`: skip the subcommand, the runner's command word follows.
      if (afterWrapper && PACKAGE_MANAGERS.has(wrapperName) && PACKAGE_EXEC_SUBCOMMANDS.has(t)) continue;
      if (WRAPPERS.has(name)) {
        afterWrapper = true;
        wrapperName = name;
        if (name === "xargs") viaXargs = true;
        continue;
      }
      if (tk.dyn) deny("command word built from expansion is not allowed.");
      if (viaXargs && (name === "git" || name === "gh")) deny("running git/gh through xargs is not allowed.");
      const becomesWrapper = checkCommandWord(tokens, i, name);
      atCommand = becomesWrapper;
      afterWrapper = becomesWrapper;
      wrapperName = name;
    }
    if (name === "git") {
      const [sub] = positionals(tokens, i, GIT_OPTS_WITH_VALUE, 1, "git");
      if (GIT_BLOCKED_SUBCOMMANDS.has(sub)) deny(`direct \`git ${sub}\` is not allowed; the operator pushes with an approved script.`);
      if (sub === "config") {
        for (let j = i + 1; j < tokens.length && tokens[j].v !== ";"; j++) {
          if (/alias/i.test(tokens[j].v)) deny("`git config` of aliases is not allowed.");
        }
      }
      if (["rm", "mv", "restore", "checkout"].includes(sub) && segmentArgs(tokens, i).some((a) => a.includes(".claude"))) {
        deny("git commands that rewrite .claude are not allowed (the operator edits it).");
      }
    } else if (name === "gh") {
      const [a, b] = positionals(tokens, i, GH_OPTS_WITH_VALUE, 2, "gh");
      if (a === "api") deny("`gh api` is not allowed.");
      if (a === "alias") deny("`gh alias` is not allowed.");
      if (a === "pr" && b === "merge") deny("`gh pr merge` is not allowed; merging is done by the owner.");
    }
  }
}

// Returns undefined to allow, or throws Block to deny. Any other thrown error is also a deny (see main).
function decide(raw) {
  if (process.env.GUARD_BASH_FORCE_ERROR === "1") throw new Error("forced internal error (test hook)");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny("could not parse hook input.");
  }
  if (input === null || typeof input !== "object" || typeof input.tool_name !== "string") deny("unexpected hook input.");
  if (input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") deny("Bash call without a command string.");
  inspect(command);
}

function main(raw) {
  try {
    decide(raw);
  } catch (err) {
    const reason = err instanceof Block ? err.message : `internal error (${err instanceof Error ? err.message : "unknown"}); failing closed.`;
    process.stderr.write(`Blocked by guard-bash hook: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("error", () => {
  process.stderr.write("Blocked by guard-bash hook: could not read hook input.\n");
  process.exit(2);
});
process.stdin.on("end", () => main(raw));
