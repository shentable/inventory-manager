const { test, expect } = require('@playwright/test');

test('店员入库、查询自己的记录、小数更正和历史审计', async ({ page }, testInfo) => {
  async function login(username, pin) {
    const response = await page.request.post('/api/auth/login', { data: { username, pin } });
    expect(response.status()).toBe(200);
    return response.json();
  }
  const admin = await login('admin', '1111');
  const staff = await login('staff_b', '4444');
  const response = await page.request.post('/api/items', { headers: { Authorization: 'Bearer ' + admin.token },
    data: { name: '入库更正浏览器测试', unit: 'kg', min_stock: 0.5 } });
  expect(response.status()).toBe(201);
  const item = await response.json();
  await page.addInitScript(session => {
    localStorage.setItem('sandwich_token', session.token);
    localStorage.setItem('sandwich_user', JSON.stringify(session.user));
  }, staff);
  await page.goto('/#/');
  await page.locator('.feat-card', { hasText: '登记到货、查询与更正' }).click();
  await page.getByPlaceholder('搜索库存品…').fill(item.name);
  await page.getByRole('spinbutton', { name: '数量', exact: true }).fill('1.2');
  await page.getByRole('button', { name: '下一步：填写效期' }).click();
  await page.getByRole('button', { name: '确认入库', exact: true }).click();
  const received = page.waitForResponse(r => r.url().endsWith('/api/stock/receive') && r.request().method() === 'POST');
  await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认入库', exact: true }).click();
  const receipt = (await (await received).json())[0];
  await page.goto('/#/receipts');
  await page.getByRole('searchbox', { name: '搜索入库记录' }).fill(item.name);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.locator('.receipt-list .receipt-card')).toHaveCount(1);
  await page.getByRole('button', { name: '查看与更正' }).click();
  await expect(page.getByRole('spinbutton', { name: '更正后入库数量', exact: true })).toHaveValue('1.2');
  await page.getByRole('spinbutton', { name: '更正后入库数量', exact: true }).fill('0.8');
  await page.getByLabel('更正后效期', { exact: true }).fill('2099-02-01');
  await page.getByRole('textbox', { name: '入库备注', exact: true }).fill('复核后备注');
  await page.getByRole('textbox', { name: '更正原因', exact: true }).fill('送货单核实为 0.8 kg');
  await page.getByRole('button', { name: '保存更正', exact: true }).click();
  const changed = page.waitForResponse(r => r.url().endsWith('/api/stock/receipts/' + receipt.id) && r.request().method() === 'PATCH');
  await page.locator('.overlay:not(.hide)').getByRole('button', { name: '保存更正', exact: true }).click();
  expect((await changed).status()).toBe(200);
  await expect(page.locator('.receipt-audit')).toContainText('1.2 kg → 0.8 kg');
  await expect(page.locator('.receipt-audit')).toContainText('送货单核实为 0.8 kg');
  await expect(page.locator('.receipt-page')).toContainText('批次剩余 0.8 kg');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('receipt-correction.png'), fullPage: true });
  // Another authorized editor saves first; the stale form must not overwrite it.
  const detail = await (await page.request.get('/api/stock/receipts/' + receipt.id, { headers: { Authorization: 'Bearer ' + admin.token } })).json();
  const concurrent = await page.request.patch('/api/stock/receipts/' + receipt.id, {
    headers: { Authorization: 'Bearer ' + admin.token },
    data: { qty: 0.9, expiry_date: detail.expiry_date, note: '管理员复核', reason: '二次核实', expected_revision: detail.revision }
  });
  expect(concurrent.status()).toBe(200);
  await page.getByRole('textbox', { name: '更正原因', exact: true }).fill('旧页面不应覆盖');
  await page.getByRole('button', { name: '保存更正', exact: true }).click();
  const stale = page.waitForResponse(r => r.url().endsWith('/api/stock/receipts/' + receipt.id) && r.request().method() === 'PATCH');
  await page.locator('.overlay:not(.hide)').getByRole('button', { name: '保存更正', exact: true }).click();
  expect((await stale).status()).toBe(409);
  await page.goto('/#/');
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.locator('.overlay:not(.hide)').getByRole('button', { name: 'English', exact: true }).click();
  await page.goto('/#/receipts');
  await expect(page.locator('.page-title')).toHaveText('Receipt records & corrections');
  await expect(page.locator('.receipt-list .receipt-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
