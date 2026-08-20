import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Critical-path E2E against the real production build:
 *  1. secure owner bootstrap + complete onboarding wizard
 *  2. runtime rebranding without code edits
 *  3. quote-to-cash through the UI (customer -> product -> invoice -> post ->
 *     payment -> paid)
 *  4. reports render and tie
 *  5. axe accessibility scans and zero console errors on critical pages
 */

test.describe.configure({ mode: 'serial' });

const consoleErrors: string[] = [];
function watchConsole(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast']) // brand tokens are admin-configurable; contrast is checked server-side with warnings
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
}

test('owner bootstraps the deployment and completes onboarding', async ({ page }) => {
  watchConsole(page);
  await page.goto('/');
  await expect(page.getByText('Set up your company books').first()).toBeVisible();
  await page.getByLabel('Company name').fill('Beacon Books Demo Co');
  await page.getByRole('button', { name: 'Claim this deployment' }).click();

  // Wizard step 1: company profile (prefilled from bootstrap).
  await expect(page.getByLabel('Legal name')).toHaveValue('Beacon Books Demo Co');
  await page.getByLabel('Application name (optional)').fill('Beacon Books');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 2: brand.
  await expect(page.getByRole('heading', { name: 'Brand & appearance' })).toBeVisible();
  await page.getByRole('button', { name: /Save and continue|Continue anyway/ }).click();

  // Step 3: accounting.
  await expect(page.getByLabel('Bookkeeping start date')).toBeVisible();
  await page.getByLabel('Bookkeeping start date').fill('2025-01-01');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 4: chart of accounts template.
  await expect(page.getByText('General service business')).toBeVisible();
  await page.getByText('General service business').click();
  await page.getByRole('button', { name: 'Apply template and continue' }).click();

  // Step 5: review & finish.
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(/Beacon Books/);
});

test('rebranding updates the application at runtime', async ({ page }) => {
  watchConsole(page);
  await page.goto('/settings/company');
  await page.getByLabel('Application name').fill('Lighthouse Ledger');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.goto('/');
  await expect(page).toHaveTitle(/Lighthouse Ledger/, { timeout: 10_000 });
  await expect(page.locator('aside').getByText('Lighthouse Ledger')).toBeVisible();
});

test('quote to cash: customer, product, invoice, post, payment, paid', async ({ page }) => {
  watchConsole(page);
  // Customer.
  await page.goto('/sales/customers');
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Display name').fill('Harbor Cafe');
  await page.getByRole('button', { name: /Create customer|Save/ }).click();
  await expect(page.getByRole('cell', { name: 'Harbor Cafe' }).first()).toBeVisible();

  // Product.
  await page.goto('/sales/products');
  await page.getByRole('button', { name: 'New product' }).click();
  await page.locator('#new-product-name').fill('Consulting Hours');
  await page.getByLabel(/Sales price/).fill('150');
  await page.getByRole('button', { name: /Create product|Save/ }).click();
  await expect(page.getByRole('cell', { name: 'Consulting Hours' }).first()).toBeVisible();

  // Invoice draft.
  await page.goto('/sales/invoices');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Harbor Cafe' });
  const productSelect = page.getByLabel('Product for line 1');
  const optionLabel = await productSelect
    .locator('option', { hasText: 'Consulting Hours' })
    .first()
    .textContent();
  await productSelect.selectOption({ label: optionLabel ?? 'Consulting Hours' });
  await page.getByLabel('Quantity for line 1').fill('2');
  await expect(page.getByLabel('Unit price for line 1')).toHaveValue(/^150(\.00)?$/);
  await page.getByRole('button', { name: 'Create invoice' }).click();

  // Creating navigates straight to the invoice detail page; post it there.
  await page.getByRole('button', { name: /^Post/ }).click();
  await expect(page.getByText(/posted/i).first()).toBeVisible({ timeout: 10_000 });

  // Receive full payment.
  await page.getByRole('button', { name: 'Receive payment' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(/Amount/)).toHaveValue('300.00');
  await dialog.getByRole('button', { name: /Receive|Save|Record/ }).click();
  await expect(page.getByText(/paid/i).first()).toBeVisible({ timeout: 10_000 });
});

test('reports render with balanced totals', async ({ page }) => {
  watchConsole(page);
  await page.goto('/reports/trial-balance');
  await expect(page.getByText('In balance')).toBeVisible({ timeout: 10_000 });
  await page.goto('/reports/profit-and-loss');
  await expect(page.getByText(/net income/i).first()).toBeVisible();
  await page.goto('/reports/balance-sheet');
  await expect(page.getByText(/Total assets/i).first()).toBeVisible();
});

test('critical pages pass axe scans', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto('/sales/invoices');
  await expect(page.getByRole('heading', { name: /invoice/i }).first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto('/reports/trial-balance');
  await expect(page.getByText('In balance')).toBeVisible();
  await expectNoAxeViolations(page);
});

test('no console errors were recorded across critical flows', async () => {
  expect(consoleErrors).toEqual([]);
});
