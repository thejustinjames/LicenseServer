/**
 * licensing_seeds/04-silo-causal-trust-addon.cjs
 *
 * The SILO causal trust add-on in the lab: granted as a licence add-on
 * (`license_add_ons`), never as a product feature.
 *
 * The decision this follows: the add-on is Cortex-only, offered on
 * Enterprise only, granted to the parent Cortex, and a child Cortex is
 * covered by its parent's add-on through `parentLicenseId`
 * (src/services/addon.service.ts). Cortex reads the `causal_trust` feature
 * code in `silo_cortex::causal_trust` and honours it only on an Enterprise
 * licence.
 *
 * What this does, idempotently:
 *   1. removes `causal_trust` from every product's features, where an
 *      earlier version of this seed put it;
 *   2. grants an active `causal_trust` add-on to each SILO Cortex Enterprise
 *      licence that has none;
 *   3. links each SILO Child Cortex Enterprise licence with no parent to the
 *      same customer's SILO Cortex Enterprise licence, when that customer
 *      holds exactly one.
 *
 * Needs the `license_add_ons` table (prisma db push, then
 * prisma/sql/2026-10-08-license-add-ons.sql). Run after 01, 03 and 02:
 *
 *   cat licensing_seeds/04-silo-causal-trust-addon.cjs | docker exec -i license-server \
 *     sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
 */

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const CODE = 'causal_trust';
const PARENT = 'SILO Cortex Enterprise';
const CHILD = 'SILO Child Cortex Enterprise';

(async () => {
  // 1. Off the products.
  const carrying = await p.product.findMany({ where: { features: { has: CODE } } });
  for (const prod of carrying) {
    await p.product.update({
      where: { id: prod.id },
      data: { features: prod.features.filter((f) => f !== CODE) },
    });
    console.log('REMOVED  ' + CODE + ' from product ' + prod.name);
  }

  // 2. Onto the parent licences.
  const parentProduct = await p.product.findFirst({ where: { name: PARENT } });
  if (!parentProduct) {
    console.log('MISSING  ' + PARENT + '  (run 01 and 03 first)');
    await p.$disconnect();
    return;
  }
  const parents = await p.license.findMany({
    where: { productId: parentProduct.id },
    include: { addOns: true },
  });
  for (const lic of parents) {
    const has = lic.addOns.some((a) => a.code === CODE && a.revokedAt === null);
    if (has) {
      console.log('HAS      ' + lic.key + '  ' + PARENT);
      continue;
    }
    await p.licenseAddOn.create({
      data: { licenseId: lic.id, code: CODE, grantedBy: 'seed', notes: 'lab seed 04' },
    });
    console.log('GRANTED  ' + CODE + '  ' + lic.key + '  ' + PARENT);
  }

  // 3. Children to their parent.
  const childProduct = await p.product.findFirst({ where: { name: CHILD } });
  if (childProduct) {
    const children = await p.license.findMany({ where: { productId: childProduct.id } });
    for (const child of children) {
      if (child.parentLicenseId) {
        console.log('LINKED   ' + child.key + '  (already)');
        continue;
      }
      const candidates = parents.filter((x) => x.customerId === child.customerId);
      if (candidates.length !== 1) {
        console.log('UNLINKED ' + child.key + '  (' + candidates.length + ' Enterprise parents for this customer; link by hand)');
        continue;
      }
      await p.license.update({ where: { id: child.id }, data: { parentLicenseId: candidates[0].id } });
      console.log('LINKED   ' + child.key + '  -> ' + candidates[0].key);
    }
  }

  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
