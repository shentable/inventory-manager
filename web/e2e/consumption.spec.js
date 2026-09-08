const { test, expect } = require('@playwright/test');

async function authenticate(page, username, pin) {
  const response = await page.request.post('/api/auth/login', { data: { username, pin } });
  expect(response.status()).toBe(200);
  const session = await response.json();
  await page.addInitScript((data) => {
    localStorage.setItem('sandwich_token', data.token);
    localStorage.setItem('sandwich_user', JSON.stringify(data.user));
  }, session);
  return session.token;
}

test('店员没有看板入口，直接打开页面和接口均受权限保护', async ({ page }) => {
  const token = await authenticate(page, 'staff', '3333');
  const response = await page.request.get('/api/consumption', { headers: { Authorization: 'Bearer ' + token } });
  expect(response.status()).toBe(403);
  await page.goto('/#/');
  await expect(page.locator('.home-user-name')).toHaveText('店员');
  await expect(page.locator('.feat-card', { hasText: '消耗与补货' })).toHaveCount(0);
  await page.goto('/#/consumption');
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.consumption-page')).toHaveCount(0);
});

for (const [username, pin] of [['manager', '2222'], ['admin', '1111']]) {
  test(`${username} 可打开真实看板、调整参数并筛选数据不足的品项`, async ({ page }) => {
    await authenticate(page, username, pin);
    await page.goto('/#/');
    await page.locator('.feat-card', { hasText: '消耗与补货' }).click();
    await expect(page.locator('.consumption-card').first()).toBeVisible();
    await expect(page.locator('.consumption-card').first()).toContainText('尚无有效双人盘点');
    await page.getByText('测算设置', { exact: true }).click();
    await page.getByLabel('到货等待天数', { exact: true }).fill('4');
    const updated = page.waitForResponse(r => r.url().includes('/api/consumption?') && r.url().includes('lead_days=4'));
    await page.getByRole('button', { name: '更新测算' }).click();
    expect((await updated).status()).toBe(200);
    await page.getByLabel('搜索品名或分类…', { exact: true }).fill('不存在的库存品');
    await expect(page.locator('.consumption-card')).toHaveCount(0);
    await expect(page.getByText('没有匹配的库存品')).toBeVisible();
    await page.getByLabel('搜索品名或分类…', { exact: true }).fill('测试吐司');
    await expect(page.locator('.consumption-card')).toHaveCount(1);
    await page.locator('.consumption-filters button', { hasText: '优先补货' }).click();
    await expect(page.locator('.consumption-card')).toHaveCount(0);
    await page.locator('.consumption-filters button', { hasText: '待核查' }).click();
    await expect(page.locator('.consumption-card')).toHaveCount(1);
  });
}

test('有历史时展示趋势、公式、在途提醒，中英文与窄屏布局可用', async ({ page }, testInfo) => {
  await authenticate(page, 'manager', '2222');
  // View fixture only. Balance arithmetic is exercised against SQLite in backend tests.
  await page.route('**/api/consumption?*', route => route.fulfill({ json: {
    as_of: '2026-09-08T04:00:00Z', days: 56, lead_days: 2, coverage_days: 7,
    items: [{
      item_id: 1, name: '测试面包', category: '烘焙', unit: '袋', min_stock: 10,
      book_stock: 45, last_count_qty: 45, last_count_at: '2026-09-06T04:00:00Z', last_comparison_id: 2,
      count_age_days: 2, valid_periods: 1, period_count: 1, consumption: 110, waste: 5,
      sample_days: 7, daily_rate: 15.7, forecast_issue: null, estimated_qty: 13.6,
      days_remaining: 0.9, replenishment_gap: 137.9, received_since_count: 0, waste_since_count: 0,
      ordered_qty: 20, pending_waste_qty: 0, expired_qty: 0, expiring_qty: 0,
      daily_shortage: false, status: 'reorder', periods: [{
        opening_comparison_id: 1, closing_comparison_id: 2, start_at: '2026-08-30T04:00:00Z',
        end_at: '2026-09-06T04:00:00Z', opening_qty: 100, closing_qty: 45, received: 60,
        waste: 5, gross_depletion: 115, consumption: 110, days: 7, daily_rate: 15.7, exclusion: null
      }]
    }]
  } }));
  await page.goto('/#/consumption');
  const card = page.locator('.consumption-card');
  await expect(card).toContainText('建议补货');
  await expect(card).toContainText('待到货 20 袋');
  await card.getByText('消耗趋势与计算依据', { exact: true }).click();
  await expect(card).toContainText('100 + 入库 60 − 实盘 45 − 报损 5 = 110');
  await expect(card.locator('.consumption-trend > div')).toHaveCSS('width', /[1-9]/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('consumption-mobile.png'), fullPage: true });
  await page.evaluate(() => window.I18N.setLang('en'));
  await expect(page.locator('.page-title')).toHaveText('Usage & replenishment');
  await expect(page.locator('.consumption-card')).toContainText('Replenish');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('consumption-english.png'), fullPage: true });
});
