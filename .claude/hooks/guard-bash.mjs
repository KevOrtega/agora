#!/usr/bin/env node
// PreToolUse hook for the Bash tool (defense in depth; real protection of main is GitHub branch protection).
// Reads the hook JSON from stdin. Exit 2 (reason on stderr) blocks the command; exit 0 allows it.
// Blocks: `git push` (any flags/spacing, also inside bash -c / sh -c / eval), `gh pr merge`, `gh api`.
// Allows only the approved push script, exactly, with no extra arguments.

const ALLOWED_EXACT = new Set([
  "bash /home/box/factory/tasks/F0-1/push.sh",
  "/home/box/factory/tasks/F0-1/push.sh",
]);

// git global options that take a separate value argument.
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GH_OPTS_WITH_VALUE = new Set(["-R", "--repo"]);

function block(reason) {
  process.stderr.write(`Blocked by guard-bash hook: ${reason}\n`);
  process.exit(2);
}

function tokenize(command) {
  // Quotes, separators and redirects become whitespace so nested shells (bash -c '...') are scanned too.
  return command.replace(/["'`;&|()<>{}\\]/g, " ").split(/\s+/).filter(Boolean);
}

function basename(token) {
  return token.slice(token.lastIndexOf("/") + 1);
}

// Returns the positional (non-option) tokens that follow index i.
function positionals(tokens, i, optsWithValue, max) {
  const out = [];
  for (let j = i + 1; j < tokens.length && out.length < max; j++) {
    const t = tokens[j];
    if (t.startsWith("-")) {
      if (optsWithValue.has(t)) j++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function inspect(command) {
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i++) {
    const name = basename(tokens[i]);
    if (name === "git") {
      const [sub] = positionals(tokens, i, GIT_OPTS_WITH_VALUE, 1);
      if (sub === "push") block("direct `git push` is not allowed; use the approved push script.");
    } else if (name === "gh") {
      const [a, b] = positionals(tokens, i, GH_OPTS_WITH_VALUE, 2);
      if (a === "api") block("`gh api` is not allowed.");
      if (a === "pr" && b === "merge") block("`gh pr merge` is not allowed; merging is done by the owner.");
    }
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    block("could not parse hook input.");
  }
  if (input?.tool_name !== "Bash") process.exit(0);
  const command = String(input?.tool_input?.command ?? "");
  if (ALLOWED_EXACT.has(command.trim())) process.exit(0);
  inspect(command);
  process.exit(0);
});
