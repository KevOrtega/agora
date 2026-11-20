# Agora — project rules for Claude Code

## Rules
- Code, identifiers, files, comments, commits, branches, PRs, routes, logs and tests are in **English**. Only user-facing UI text is in **Spanish**.
- Work on a branch and open a PR. Never commit or push to `main`; never merge (the owner merges).
- This repo is **PUBLIC**: no secrets, no real data (names, phones, emails, businesses, amounts) in code, logs, tests, commits or PRs. Use fictitious test data only.
- Secrets are provided later through secure fields; use mocks until then. Never read `.env*`, `*.pem`, `*.key` or `secrets/**`. Only `.env.example` (names, no values) is committed; it is edited by a human, because Claude cannot read or edit it (the `.env*` deny rules cover it).
- No deploys, no hosting CLIs, no real external calls (WhatsApp, payments) without the owner's approval.
- Keep changes small and in scope.

## Stack
TypeScript on Node.js 22+ (npm), plain `node:http` server, Vitest, ESLint. Planned: PostgreSQL (the credit ledger needs transactions) with a Postgres-backed job queue (e.g. pg-boss) to avoid extra infrastructure. Neither is wired yet.

## Commands
- `npm ci` — install
- `npm run dev` — start locally (`PORT` optional, default 3000; `GET /health`)
- `npm test` — tests (must not need network or a database)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript check
- `npm run secret-scan` — gitleaks scan of the full git history including merge commits (requires gitleaks installed locally)
- Tests run with the network blocked: a Vitest setup file (`test/setup-network-guard.ts`) blocks non-loopback traffic in every test file, and integration suites use the stricter `test/no-network.ts` guard. CI additionally reruns `npm test` inside a loopback-only network namespace (`unshare --net`) after a canary step that proves the block.

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on every PR and on push to main. `.github/workflows/secret-scan.yml` runs a gitleaks secret scan (config: `.gitleaks.toml`, no allowlists, merge commits included) on every PR and on every push to any branch.

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
