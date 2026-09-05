---
name: verify
description: Verify the licence server after changes - regenerate the Prisma client, type-check and build, run the unit tests, and optionally sync the schema to the local dev database (--db) and smoke-test a built server (--smoke). Use after editing src/, prisma/schema.prisma or tests/, or when asked whether the build and tests pass.
---

# Verify the licence server

Run the verification script from the repo root:

```bash
.claude/skills/verify/verify.sh            # generate + build + unit tests
.claude/skills/verify/verify.sh --db       # ...and push the schema to the local dev DB
.claude/skills/verify/verify.sh --smoke    # ...and start dist/index.js on port 3999 and probe endpoints
.claude/skills/verify/verify.sh --db --smoke
```

Pass whatever flags the user's request implies. Use `--db` after any change to
`prisma/schema.prisma` (the dev database is the `license_server_db` container on
port 5433; the URL comes from `.env`). Use `--smoke` when a change touches
routing, middleware, auth or startup. `SMOKE_PORT` overrides the smoke port.

## What it checks

1. `npx prisma generate` - the client matches the schema.
2. `npm run build` - a clean `tsc` compile.
3. `npm test` - vitest unit suite under `tests/unit`.
4. `--db`: `npx prisma db push --skip-generate` (this is also what the container
   runs at start, so it is the project's migration mechanism; `prisma/sql/*.sql`
   files document each change and are not applied by this script).
5. `--smoke`: starts the built server and asserts liveness, readiness, JSON 404
   for unknown API paths, API-key enforcement on deployments, request
   validation, the idle-config endpoint, and that the log has no errors.

## Reporting

Report each step's outcome plainly. If a step fails, quote the failing output
(the tsc error, the failing test name, the smoke check that got the wrong
status) rather than summarising it. Do not mark the work verified while any
step is failing.

## Notes

- Product ids are not always UUIDs (seeded rows such as `prod_agencio_predict_lab`).
- Local admin credentials are `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`, not
  the production account.
- Auth endpoints are rate limited to ten attempts per fifteen minutes per IP;
  the in-memory limiter resets when the server restarts.
