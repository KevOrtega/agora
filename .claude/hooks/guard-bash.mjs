#!/usr/bin/env node
// PreToolUse hook for the Bash tool (defense in depth; real protection of main is GitHub branch protection).
// Reads the hook JSON from stdin. Exit 2 (reason on stderr) blocks the command; exit 0 allows it.
// Fails closed: unparseable input, a Bash call without a string command, or any unexpected error exits 2.
//
// Blocks:
// - `git push` (any flags/spacing/quoting, also inside bash -c / sh -c / eval / env / exec / xargs)
// - `gh pr merge`, `gh api`, `gh alias`
// - git aliases defined on the fly (`git -c alias.x=...`, `git config alias...`, GIT_CONFIG* env)
// - a git/gh subcommand or command word built from expansion (`$(...)`, backticks, `$VAR`, `${IFS}`, `{a,b}`)
// Known accepted false positive: any text containing `git push` (echo, commit message) is blocked.

const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source",
]);
const GH_OPTS_WITH_VALUE = new Set(["-R", "--repo"]);
// Commands that run their arguments as another command (the command word follows them).
const WRAPPERS = new Set(["env", "exec", "nohup", "time", "command", "builtin", "nice", "timeout", "stdbuf", "sudo", "xargs", "noglob"]);

class Block extends Error {}
const deny = (reason) => {
  throw new Block(reason);
};

// Quotes and backslashes are REMOVED (so g""it and p\ush become git and push); separators split commands
// so nested shells (bash -c '...') are scanned. ";" is the segment separator token.
function tokenize(command) {
  return command
    .replace(/["'\\]/g, "")
    .replace(/(?<![=\s])\$/g, " $")
    .replace(/`/g, " ` ; ")
    .replace(/[;&|\n()<>]/g, " ; ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === "{" || t === "}" ? ";" : t));
}

const basename = (token) => token.slice(token.lastIndexOf("/") + 1);
const isDynamic = (t) => t === "`" || /[${}]/.test(t);
const isSimpleVar = (t) => /^\$(\w+|\{\w+\})$/.test(t);

// Returns up to `max` positional (non-option) tokens after index i, within the current segment.
// Fails closed on a positional built from expansion or an option value that is not a plain variable.
function positionals(tokens, i, optsWithValue, max, isGit) {
  const out = [];
  for (let j = i + 1; j < tokens.length && out.length < max; j++) {
    const t = tokens[j];
    if (t === ";") break;
    if (t.startsWith("-")) {
      if (isGit && (t === "-c" || t.startsWith("--config-env"))) {
        const v = t === "-c" || t === "--config-env" ? (tokens[j + 1] ?? "") : "";
        if (/alias/i.test(t + v)) deny("git aliases can hide `git push`; `-c alias...` is not allowed.");
        if (isDynamic(v)) deny("git config value built from expansion is not allowed.");
      }
      if (optsWithValue.has(t)) {
        j++;
        const v = tokens[j] ?? "";
        if (isDynamic(v) && !isSimpleVar(v)) deny("option value built from expansion is not allowed.");
      }
      continue;
    }
    if (isDynamic(t)) deny("subcommand built from command substitution or variable expansion is not allowed.");
    out.push(t);
  }
  return out;
}

function inspect(command) {
  const tokens = tokenize(command);
  let atCommand = true; // next token is a command word
  let afterWrapper = false; // previous command word was a wrapper (env, xargs, ...)
  let viaXargs = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === ";") {
      atCommand = true;
      afterWrapper = false;
      viaXargs = false;
      continue;
    }
    const name = basename(t);
    if (atCommand) {
      const assign = /^([A-Za-z_]\w*)=(.*)$/.exec(t);
      if (assign) {
        if (assign[1].startsWith("GIT_CONFIG")) deny("GIT_CONFIG* variables can define git aliases; not allowed.");
        const v = basename(assign[2]);
        if (v === "git" || v === "gh") deny("storing git/gh in a variable is not allowed.");
        continue;
      }
      if (WRAPPERS.has(name)) {
        afterWrapper = true;
        if (name === "xargs") viaXargs = true;
        continue;
      }
      if (afterWrapper && (t.startsWith("-") || /^\d+[smhd]?$/.test(t))) continue;
      if (isDynamic(t)) deny("command word built from expansion is not allowed.");
      if (viaXargs && (name === "git" || name === "gh")) deny("running git/gh through xargs is not allowed.");
      if (name === "eval" && isDynamic(tokens[i + 1] ?? "")) deny("eval of an expansion is not allowed.");
      atCommand = false;
    }
    if (name === "git") {
      const [sub] = positionals(tokens, i, GIT_OPTS_WITH_VALUE, 1, true);
      if (sub === "push") deny("direct `git push` is not allowed; the operator pushes with an approved script.");
      if (sub === "config") {
        for (let j = i + 1; j < tokens.length && tokens[j] !== ";"; j++) {
          if (/alias/i.test(tokens[j])) deny("`git config` of aliases is not allowed.");
        }
      }
    } else if (name === "gh") {
      const [a, b] = positionals(tokens, i, GH_OPTS_WITH_VALUE, 2, false);
      if (a === "api") deny("`gh api` is not allowed.");
      if (a === "alias") deny("`gh alias` is not allowed.");
      if (a === "pr" && b === "merge") deny("`gh pr merge` is not allowed; merging is done by the owner.");
    }
  }
}

// Returns null to allow, or throws Block to deny. Any other thrown error is also a deny (see main).
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
