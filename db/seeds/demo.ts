/**
 * Rich demo company seed (`npm run db:seed:demo -- --confirm-demo`).
 *
 * Safety guards (all hard failures):
 *  - refuses NODE_ENV=production
 *  - refuses when DATABASE_URL equals MIGRATION_DATABASE_URL or looks like a
 *    production URL
 *  - requires the explicit --confirm-demo flag
 *  - only seeds an ALREADY-BOOTSTRAPPED deployment whose company display
 *    name contains "demo" (the operator signals intent at bootstrap); it
 *    never touches a non-demo organization
 *  - idempotent: a feature flag marks the seeded org; reruns are no-ops
 *
 * The data is deterministic and obviously fictional (Cedar Creek Restoration
 * Demo Co) and exercises the contractor-flavored quote-to-cash and
 * purchase-to-pay journeys plus banking review.
 */
import fs from 'node:fs';

try {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
} catch {
  /* no .env */
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data with NODE_ENV=production');
  }
  if (!process.argv.includes('--confirm-demo')) {
    throw new Error('Pass --confirm-demo to seed demo data (this writes to the database)');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (process.env.MIGRATION_DATABASE_URL && url === process.env.MIGRATION_DATABASE_URL) {
    throw new Error('Refusing to seed through the privileged migration connection');
  }
  if (/prod/i.test(url)) {
    throw new Error('DATABASE_URL looks like a production database; refusing');
  }

  const { getDb } = await import('../../server/db/client');
  const schema = await import('../../server/db/schema/index');
  const { eq, and } = await import('drizzle-orm');
  const db = getDb();

  const [deployment] = await db.select().from(schema.deploymentSettings).limit(1);
  if (!deployment?.primaryOrganizationId) {
    throw new Error(
      'Bootstrap the deployment first (sign in as the owner and claim it with a company name containing "Demo").',
    );
  }
  const orgId = deployment.primaryOrganizationId;
  const [profile] = await db
    .select()
    .from(schema.companyProfiles)
    .where(eq(schema.companyProfiles.organizationId, orgId))
    .limit(1);
  if (!profile || !/demo/i.test(profile.displayName)) {
    throw new Error(
      `The company "${profile?.displayName ?? ''}" is not a demo company. Demo data only loads into a company whose name contains "Demo".`,
    );
  }
  const [already] = await db
    .select()
    .from(schema.featureFlags)
    .where(
      and(
        eq(schema.featureFlags.organizationId, orgId),
        eq(schema.featureFlags.key, 'demo_seeded'),
      ),
    )
    .limit(1);
  if (already?.enabled) {
    console.log('Demo data already seeded for this organization; nothing to do.');
    return;
  }

  const [ownerMembership] = await db
    .select({ userId: schema.memberships.userId, roleId: schema.memberships.roleId })
    .from(schema.memberships)
    .where(eq(schema.memberships.organizationId, orgId))
    .limit(1);
  if (!ownerMembership) throw new Error('No membership found; bootstrap first.');
  const [role] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.id, ownerMembership.roleId))
    .limit(1);
  const ctx = {
    organizationId: orgId,
    userId: ownerMembership.userId,
    membershipId: 'seed',
    roleId: ownerMembership.roleId,
    roleKey: role?.key ?? 'owner',
    roleName: role?.name ?? 'Owner',
    permissions: ['*'],
  };

  const { applyChartTemplate } = await import('../../server/accounting/accounts');
  const [hasAccounts] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId))
    .limit(1);
  if (!hasAccounts) {
    await db.transaction(async (tx) => {
      await applyChartTemplate(tx, orgId, 'contractor');
    });
    console.log('Applied contractor chart of accounts.');
  }

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  const byName = (name: string) => {
    const a = accounts.find((x) => x.name === name);
    if (!a) throw new Error(`Account "${name}" missing`);
    return a.id;
  };
  const checking = byName('Checking');
  const card = byName('Business Credit Card');
  const equity = byName('Owner Equity');
  const materials = byName('Direct Materials');
  const subs = byName('Subcontractor Costs');
  const office = byName('Office Supplies & Software');
  const insurance = byName('Insurance');
  const fuel = byName('Vehicles & Fuel');
  const ufId = accounts.find((a) => a.systemKey === 'undeposited_funds')!.id;

  console.log('Seeding demo records…');
  const seed = async () => {
    // Parties and items -----------------------------------------------------
    const customerRows = await db
      .insert(schema.customers)
      .values(
        [
          ['Lakeside Property Group (Demo)', 'billing@lakeside.demo', 30],
          ['Morrison Family (Demo)', 'morrisons@example.demo', 15],
          ['Bluebird Dental (Demo)', 'office@bluebird.demo', 30],
          ['Harbor View HOA (Demo)', 'board@harborview.demo', 45],
        ].map(([name, email, terms]) => ({
          organizationId: orgId,
          displayName: name as string,
          email: email as string,
          termsDays: terms as number,
        })),
      )
      .returning();
    const vendorRows = await db
      .insert(schema.vendors)
      .values(
        [
          ['BuildRight Supply (Demo)', 30, false],
          ['Rapid Plumbing Subcontractors (Demo)', 15, true],
          ['City Permit Office (Demo)', 0, false],
          ['Fleet Fuel Co (Demo)', 30, false],
        ].map(([name, terms, is1099]) => ({
          organizationId: orgId,
          displayName: name as string,
          termsDays: terms as number,
          is1099Eligible: is1099 as boolean,
        })),
      )
      .returning();
    const incomeId = accounts.find((a) => a.name === 'Contract Income')!.id;
    const productRows = await db
      .insert(schema.productsServices)
      .values([
        {
          organizationId: orgId,
          type: 'service',
          name: 'Water Mitigation (Demo)',
          salesPrice: '185',
          incomeAccountId: incomeId,
          taxable: false,
          salesDescription: 'Water extraction and drying, per hour',
        },
        {
          organizationId: orgId,
          type: 'service',
          name: 'Mold Remediation (Demo)',
          salesPrice: '225',
          incomeAccountId: incomeId,
          taxable: false,
          salesDescription: 'Certified mold remediation, per hour',
        },
        {
          organizationId: orgId,
          type: 'service',
          name: 'Reconstruction Labor (Demo)',
          salesPrice: '95',
          incomeAccountId: incomeId,
          taxable: false,
        },
        {
          organizationId: orgId,
          type: 'non_inventory',
          name: 'Job Materials (Demo)',
          salesPrice: '0',
          incomeAccountId: incomeId,
          expenseAccountId: materials,
          taxable: true,
        },
      ])
      .returning();

    const [taxRate] = await db
      .insert(schema.taxRates)
      .values({
        organizationId: orgId,
        name: 'State Sales Tax (Demo)',
        agencyName: 'State Department of Revenue',
        rate: '0.0825',
      })
      .returning();

    // Opening funds ---------------------------------------------------------
    const { postEntry } = await import('../../server/accounting/posting');
    await db.transaction(async (tx) => {
      await postEntry(tx, {
        organizationId: orgId,
        actorUserId: ctx.userId,
        sourceType: 'opening_balance',
        postingDate: '2025-01-02',
        memo: 'Owner opening contribution (demo)',
        auditAction: 'opening_balance.posted',
        lines: [
          { accountId: checking, debit: '45000' },
          { accountId: equity, credit: '45000' },
        ],
      });
    });

    // Quote-to-cash ---------------------------------------------------------
    const {
      createEstimateDraft,
      transitionEstimate,
      convertEstimateToInvoice,
      createInvoiceDraft,
      postInvoice,
    } = await import('../../server/services/invoices');
    const { receiveCustomerPayment, createDeposit } =
      await import('../../server/services/payments');

    const lakeside = customerRows[0]!;
    const morrison = customerRows[1]!;
    const bluebird = customerRows[2]!;
    const hoa = customerRows[3]!;
    const mitigation = productRows[0]!;
    const remediation = productRows[1]!;
    const rebuild = productRows[2]!;
    const jobMaterials = productRows[3]!;

    const estimate = await createEstimateDraft(db, ctx, {
      customerId: lakeside.id,
      estimateDate: '2025-05-05',
      expirationDate: '2025-07-05',
      customerMessage: 'Scope: unit 4B water loss — mitigation and rebuild.',
      taxRateId: taxRate!.id,
      lines: [
        { productId: mitigation.id, quantity: '24', unitPrice: '185' },
        { productId: rebuild.id, quantity: '60', unitPrice: '95' },
        { productId: jobMaterials.id, quantity: '1', unitPrice: '2400', taxable: true },
      ],
    });
    await transitionEstimate(db, ctx, estimate.id, { status: 'sent' }, 'seed');
    await transitionEstimate(
      db,
      ctx,
      estimate.id,
      { status: 'accepted', acceptedByName: 'R. Alvarez (property manager)' },
      'seed',
    );
    const estLines = await db
      .select()
      .from(schema.estimateLines)
      .where(eq(schema.estimateLines.estimateId, estimate.id));
    const converted = await convertEstimateToInvoice(
      db,
      ctx,
      estimate.id,
      {
        invoiceDate: '2025-05-20',
        selections: [
          { estimateLineId: estLines[0]!.id, quantity: '24' },
          { estimateLineId: estLines[2]!.id, quantity: '1' },
        ],
      },
      'seed',
    );
    await postInvoice(db, ctx, converted.invoiceId, 'demo-inv-lakeside', 'seed');

    const morrisonInv = await createInvoiceDraft(db, ctx, {
      customerId: morrison.id,
      invoiceDate: '2025-06-02',
      taxRateId: null,
      lines: [{ productId: remediation.id, quantity: '16', unitPrice: '225' }],
    });
    await postInvoice(db, ctx, morrisonInv.id, 'demo-inv-morrison', 'seed');

    const bluebirdInv = await createInvoiceDraft(db, ctx, {
      customerId: bluebird.id,
      invoiceDate: '2025-04-01',
      taxRateId: null,
      lines: [{ productId: mitigation.id, quantity: '10', unitPrice: '185' }],
    });
    await postInvoice(db, ctx, bluebirdInv.id, 'demo-inv-bluebird', 'seed');

    // Draft invoice awaiting review.
    await createInvoiceDraft(db, ctx, {
      customerId: hoa.id,
      invoiceDate: '2025-06-20',
      taxRateId: null,
      lines: [{ productId: rebuild.id, quantity: '12', unitPrice: '95' }],
    });

    // Payments: Morrison pays in full to UF; Lakeside pays half to UF.
    await receiveCustomerPayment(
      db,
      ctx,
      {
        customerId: morrison.id,
        paymentDate: '2025-06-12',
        amount: '3600',
        depositToAccountId: ufId,
        method: 'check',
        reference: '2201',
        autoApply: true,
        idempotencyKey: 'demo-pay-morrison',
      },
      'seed',
    );
    await receiveCustomerPayment(
      db,
      ctx,
      {
        customerId: lakeside.id,
        paymentDate: '2025-06-14',
        amount: '4000',
        depositToAccountId: ufId,
        method: 'ach',
        autoApply: true,
        idempotencyKey: 'demo-pay-lakeside',
      },
      'seed',
    );
    const undeposited = await (
      await import('../../server/services/payments')
    ).listUndepositedReceipts(db, orgId);
    await createDeposit(
      db,
      ctx,
      {
        depositDate: '2025-06-16',
        bankAccountId: checking,
        receipts: undeposited.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
        idempotencyKey: 'demo-deposit-1',
      },
      'seed',
    );

    // Purchase-to-pay ---------------------------------------------------------
    const { createBillDraft, postBill, payBills, createAndPostExpense } =
      await import('../../server/services/bills');
    const buildright = vendorRows[0]!;
    const plumbing = vendorRows[1]!;
    const permits = vendorRows[2]!;

    const materialsBill = await createBillDraft(db, ctx, {
      vendorId: buildright.id,
      billDate: '2025-05-22',
      vendorReference: 'BR-88412',
      lines: [
        { accountId: materials, amount: '1830.55', description: 'Drywall, studs, fasteners' },
        { accountId: materials, amount: '412.80', description: 'Paint and finish' },
      ],
    });
    await postBill(db, ctx, materialsBill.id, 'demo-bill-mat', 'seed');
    await payBills(
      db,
      ctx,
      {
        vendorId: buildright.id,
        paymentDate: '2025-06-05',
        bankAccountId: checking,
        allocations: [{ billId: materialsBill.id, amount: '1500' }],
        idempotencyKey: 'demo-billpay-1',
      },
      'seed',
    );

    const subsBill = await createBillDraft(db, ctx, {
      vendorId: plumbing.id,
      billDate: '2025-06-10',
      lines: [{ accountId: subs, amount: '2750', description: 'Unit 4B rough-in plumbing' }],
    });
    await postBill(db, ctx, subsBill.id, 'demo-bill-subs', 'seed');

    await createAndPostExpense(
      db,
      ctx,
      {
        vendorId: permits.id,
        expenseDate: '2025-05-21',
        paymentAccountId: checking,
        method: 'check',
        reference: '1104',
        lines: [{ accountId: byName('Permits & Fees (Jobs)'), amount: '385' }],
        idempotencyKey: 'demo-exp-permit',
      },
      'seed',
    );
    await createAndPostExpense(
      db,
      ctx,
      {
        payeeName: 'Fleet Fuel Co (Demo)',
        expenseDate: '2025-06-03',
        paymentAccountId: card,
        method: 'card',
        lines: [{ accountId: fuel, amount: '182.40' }],
        idempotencyKey: 'demo-exp-fuel',
      },
      'seed',
    );
    await createAndPostExpense(
      db,
      ctx,
      {
        payeeName: 'Shield Insurance (Demo)',
        expenseDate: '2025-06-01',
        paymentAccountId: checking,
        method: 'ach',
        lines: [{ accountId: insurance, amount: '640' }],
        idempotencyKey: 'demo-exp-ins',
      },
      'seed',
    );
    void office;

    // Banking staging ---------------------------------------------------------
    const { importBankCsv } = await import('../../server/services/banking');
    const csv = [
      'Date,Description,Amount',
      '06/16/2025,MOBILE DEPOSIT,7600.00',
      '06/05/2025,BUILDRIGHT SUPPLY PAYMENT,-1500.00',
      '06/01/2025,SHIELD INSURANCE ACH,-640.00',
      '06/18/2025,MAIN ST HARDWARE,-96.42',
      '06/19/2025,INTEREST PAYMENT,1.12',
    ].join('\n');
    await importBankCsv(
      db,
      ctx,
      {
        accountId: checking,
        filename: 'demo-june-statement.csv',
        content: csv,
        mapping: {
          dateColumn: 0,
          descriptionColumn: 1,
          amountColumn: 2,
          dateFormat: 'MDY',
          hasHeader: true,
        },
        dryRun: false,
        idempotencyKey: 'demo-bank-import',
      },
      'seed',
    );
  };

  await seed();
  await db
    .insert(schema.featureFlags)
    .values({ organizationId: orgId, key: 'demo_seeded', enabled: true })
    .onConflictDoNothing();
  console.log('Demo data seeded. Every record is fictional and labeled (Demo).');
  const { closeDb } = await import('../../server/db/client');
  await closeDb();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
