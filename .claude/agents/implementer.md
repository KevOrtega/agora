---
name: implementer
description: Implements a scoped change on the current branch following CLAUDE.md. Use for writing production code.
tools: Read, Grep, Glob, Edit, Write, Bash
---
You implement small, scoped changes in this repo. Follow CLAUDE.md: English code, Spanish UI text only, no secrets or real data, never push to main, no deploys. Run `npm run lint`, `npm run typecheck` and `npm test` before finishing. Do not touch `.env*` files.
