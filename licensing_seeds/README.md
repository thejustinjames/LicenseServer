# licensing_seeds

Reproducible product / fixture seeders for the License Server preprod and
local dev environments. Each script is **idempotent**: keyed by product
`name`, so re-running updates pricing/features/platforms instead of
duplicating rows.

These scripts are written as plain CommonJS so they can be piped into a
running pod and executed against the bundled `@prisma/client`, without
needing the TypeScript toolchain.

## Files

| File | Purpose |
|---|---|
| `01-test-skus.cjs` | The four test SKUs we ship for QA: Standalone Home, Standalone Professional, Cortex Business, Cortex Enterprise. |

## Run inside a running pod

```bash
KCTL=/c/Users/justin/bin/kubectl.exe
POD=$($KCTL get pods -n preprod -l app=license-server \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')

cat licensing_seeds/01-test-skus.cjs | \
  $KCTL exec -n preprod -i $POD -- sh -c \
    'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
```

The script logs `CREATED` or `UPDATED` for each SKU and exits 0 on success.

## Run locally (against a local Postgres)

```bash
DATABASE_URL='postgresql://license_server:devpw@localhost:5432/license_server?schema=license_server' \
  node licensing_seeds/01-test-skus.cjs
```

You need a working `node_modules/@prisma/client` (i.e. `npm install` in the
repo root) for this to find the Prisma client.

## Why `.cjs` and not `.ts`

The application's `package.json` declares `"type": "module"`, so plain
`.js` files in `/app` are treated as ES modules. Using `.cjs` keeps these
seeders independent of the TypeScript compiler and the module-format
setting, so they can be dropped into any pod and run without a build step.

## Stripe-side products

These seeders only populate the local `Product` rows (in the
`license_server.products` table). To create matching Stripe `product` and
`price` objects and fill in `stripeProductId` / `stripePriceIdAnnual`, run
the existing `prisma/sync-stripe.ts` after seeding.
