const { test, expect } = require('@playwright/test');

test('所有单位可录入小数、报损小于一单位，整数和小数正确显示', async ({ page }, testInfo) => {
  async function login(username, pin) {
    const response = await page.request.post('/api/auth/login', { data: { username, pin } });
    expect(response.status()).toBe(200);
    return response.json();
  }
  const admin = await login('admin', '1111');
  const staff = await login('staff_b', '4444');
  async function call(method, path, body, session = admin) {
    const response = await page.request.fetch('/api' + path, {
      method, headers: { Authorization: 'Bearer ' + session.token }, data: body
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  let selected;
  for (const unit of ['个', '袋', 'kg', '公斤', 'L', '升', '米', '自定义单位']) {
    const item = await call('POST', '/items', { name: '小数测试-' + unit, unit, min_stock: 0.5 });
    expect(item.min_stock).toBe(0.5);
    for (const qty of [0.1, 0.2]) {
      await call('POST', '/stock/receive', { items: [{ item_id: item.id, qty, expiry_date: '2099-01-01' }] });
    }
    const waste = await call('POST', '/waste', { item_id: item.id, qty: 0.3, reason: '跨批次小数' }, staff);
    await call('POST', '/waste/' + waste.id + '/confirm');
    const batches = await call('GET', '/items/' + item.id + '/batches');
    expect(batches.every(b => b.qty === 0)).toBe(true);
    if (unit === 'kg') { selected = item; }
  }
  await call('POST', '/stock/receive', { items: [{ item_id: selected.id, qty: 0.7, expiry_date: '2099-01-01' }] });
  await page.addInitScript(session => {
    localStorage.setItem('sandwich_token', session.token);
    localStorage.setItem('sandwich_user', JSON.stringify(session.user));
  }, staff);
  await page.goto('/#/waste?item=' + selected.id);
  const quantity = page.getByRole('spinbutton', { name: '数量', exact: true });
  await expect(quantity).toHaveValue('0.7');
  await quantity.fill('0.12');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(quantity).toBeVisible();
  await quantity.fill('0.1');
  await page.getByRole('button', { name: '增加', exact: true }).click();
  await expect(quantity).toHaveValue('0.2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fractional-waste.png'), fullPage: true });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.ws-qty')).toHaveText('0.2 kg');
  await page.locator('.chip', { hasText: '破损' }).click();
  await page.getByRole('button', { name: '提交报损', exact: true }).click();
  const sent = page.waitForResponse(r => r.url().endsWith('/api/waste') && r.request().method() === 'POST');
  await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认提交', exact: true }).click();
  const waste = await (await sent).json();
  expect(waste.qty).toBe(0.2);
  await call('POST', '/waste/' + waste.id + '/confirm');
  await page.goto('/#/stock');
  const row = page.locator('.stock-row', { hasText: selected.name });
  await expect(row.locator('.stock-qty')).toHaveText('0.5 kg');
  const remainder = await call('POST', '/waste', { item_id: selected.id, qty: 0.5, reason: '全部扣完' }, staff);
  await call('POST', '/waste/' + remainder.id + '/confirm');
  await page.reload();
  await expect(row.locator('.stock-qty')).toHaveText('0 kg');
  expect(await page.evaluate(() => [0, 2, 2.4].map(window.UI.formatQuantity))).toEqual(['0', '2', '2.4']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
