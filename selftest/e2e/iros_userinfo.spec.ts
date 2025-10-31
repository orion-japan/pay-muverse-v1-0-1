import { test, expect } from '@playwright/test';

const base = process.env.SELFTEST_BASE_URL;
if (!base) test.skip(true, 'SELFTEST_BASE_URL not set');

const ensureBase = () => {
  if (!base) throw new Error('SELFTEST_BASE_URL not set');
  return base.replace(/\/$/, '');
};

test('Iros userinfo badge shows name and q_code', async ({ page }) => {
  const root = ensureBase();
  const response = await page.request.get(`${root}/api/agent/iros/userinfo`, {
    headers: { Accept: 'application/json' },
  });
  await expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const expectedName = String(payload?.name ?? '').trim();
  const expectedQCode = String(payload?.q_code ?? '').trim();

  await page.goto(`${root}/iros`);
  const badge = page.getByTestId('userinfo-badge');
  await expect(badge).toBeVisible();

  if (expectedName) {
    await expect(badge).toContainText(expectedName);
  }
  if (expectedQCode) {
    await expect(badge).toContainText(expectedQCode);
    await expect(badge).toContainText(/Q[1-5]/);
  } else {
    await expect(badge).toContainText(/Q[1-5]/);
  }
});
