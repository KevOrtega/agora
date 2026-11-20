# Agora — project rules for Claude Code

## Rules
- Code, identifiers, files, comments, commits, branches, PRs, routes, logs and tests are in **English**. Only user-facing UI text is in **Spanish**.
- Work on a branch and open a PR. Never commit or push to `main`; never merge (the owner merges).
- This repo is **PUBLIC**: no secrets, no real data (names, phones, emails, businesses, amounts) in code, logs, tests, commits or PRs. Use fictitious test data only.
- Secrets are provided later through secure fields; use mocks until then. Never read `.env*`, `*.pem`, `*.key` or `secrets/**`. Only `.env.example` (names, no values) is committed; it is edited by a human, because Claude cannot read or edit it (the `.env*` deny rules cover it).
- No deploys, no hosting CLIs, no real external calls (WhatsApp, payments) without the owner's approval.
- Keep changes small and in scope.

## Pushing and guards
Claude Code never pushes. The operator pushes the branch with an approved push script kept outside the repo. Direct `git push` (and obfuscated forms, git aliases, `gh api`, `gh pr merge`, cloud CLIs such as `kubectl`) is denied in `.claude/settings.json` and blocked by the fail-closed Bash hook `.claude/hooks/guard-bash.mjs`. GitHub branch protection on `main` is the real control. Text that merely mentions `git push` (echo, commit message) is blocked too; this is an accepted false positive. Do not put machine-specific paths in the repo (a test checks for it).

### Which layer blocks what
- **Deny list** (`.claude/settings.json`, `permissions.deny`): text patterns on the whole Bash command. Push forms (`git push`, `send-pack`, `git-push`, `http-push`), `gh api`/`gh pr merge`/`gh alias`, git aliases, hosting/cloud/IaC CLIs and deploy scripts (command-position patterns, bare or by path: `kubectl`, `aws`, `terraform`, `railway`, `npm run deploy`, ...), nested `claude`, `--settings`, `disableAllHooks`, `--dangerously-skip-permissions`, secret reads, and Bash writes into `.claude` (`>`, `tee`, `cp`, `mv`, `rm`, `sed -i`, ...). It does not see through wrappers like `sudo`, `env` or `bash -c`.
- **Bash hook** (`.claude/hooks/guard-bash.mjs`, fail closed): tokenizes the command, strips quotes/backslashes and checks the command word (after assignments and wrappers such as `env`, `sudo`, `xargs`, `bash -c`, `eval`, `npx`). Blocks push forms, any `git-*` executable, words built from `$`, backticks or braces, the CLIs above, nested `claude`, and writes into `.claude`.
- **Claude Code built-in protection**: `.claude/` is a protected path, and `Edit`/`Write` rules cover `.claude` and `~/.claude`.
- **Residuals** (not blocked; listed in `test/fixtures/qa-cases/r1_qa_new_probes.txt`): interpreters (python/perl/node scripts that spawn git or write files, e.g. `perl -e 'system("git","push",...)'`), copies or symlinks of the git binary, `echo <base64> | base64 -d | bash`, running a script written elsewhere (`bash /tmp/x.sh`, `sh < /tmp/x.sh`), `parallel git ::: push`, pre-existing aliases written into `.git/config` (Claude Code protects `.git` itself), `curl` with credentials, tools such as `k9s`, `ansible-playbook` and `docker login`, and gh commands that are not merge/api/alias/repo/auth/release/workflow-run (`gh pr review`, `gh secret set`, ...).
- A command whose first argument starts with `deploy` (e.g. `eb deploy`, `sls deploy`) is blocked unless the command only prints or inspects text (`echo`, `grep`, `cat`, `git`, ...). The deny list also covers the wrapper forms (`sudo`, `env`, `exec`, `eval`, `xargs`, `sh -c`) of every blocked CLI; `cd`/`pushd` into `.claude` is blocked. Text mentioning `git push` is blocked (accepted false positive), as are command words that start with `$`, a backtick or a brace, and heredoc lines that start with `deploy` or `claude`.
- Branch protection on `main` remains the real control.

## Stack
TypeScript on Node.js 22+ (npm), plain `node:http` server, Vitest, ESLint. Planned: PostgreSQL (the credit ledger needs transactions) with a Postgres-backed job queue (e.g. pg-boss) to avoid extra infrastructure. Neither is wired yet.

## Commands
- `npm ci` — install
- `npm run dev` — start locally (`PORT` optional, default 3000; `GET /health`)
- `npm test` — tests (must not need network or a database)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript check

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on every PR and on push to main.

## Architecture notes
One modular monolith backend with a relational database and a job queue. One folder per component in `src/modules/`:

- `web` — customer and admin site, consumes the backend API
- `whatsapp_gateway` — official WhatsApp API webhook (messages, statuses, signature checks)
- `order_orchestrator` — drives an order end to end
- `business_inquiry_service` — asynchronous conversations with businesses
- `credit_ledger` — customer credit balance; transactional
- `order_state_machine` — order lifecycle states and transitions
- `business_directory` — businesses catalog
- `reputation` — ratings and blocklist
- `business_discovery` — finding and proposing businesses
- `admin_panel` — admin operations
- `database` — relational DB access
- `job_queue` — background jobs
- `business_payouts` — payouts to businesses
- `payments_topup` — customer credit top-ups
- `settings` — typed, validated configurable parameters (timers, defaults, admin-loaded weights and commission)
- `commission` — per-purchase commission

Modules are currently empty placeholders.

External provider adapters live in `src/integrations/` (e.g. `mercadopago/`: `TopupProvider`/`PayoutProvider` interfaces, in-memory mocks by default, selected via `MERCADOPAGO_ADAPTER`; no real adapter yet).
