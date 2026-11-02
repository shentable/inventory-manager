const { test, expect } = require('@playwright/test');

const user = { id: 1, role: 'admin', display_name: '测试管理员', must_change_pin: false };
const item = { id: 71, name: '必填测试品', category: '测试分类', unit: '个', shelf_life_days: 7, min_stock: 1, active: true, daily_count_enabled: true, weekly_count_enabled: true, daily_quantity_required: true };

async function setup(page, items = [item]) {
  const writes = [];
  await page.addInitScript(user => {
    localStorage.setItem('sandwich_token', 'daily-quantity-test');
    localStorage.setItem('sandwich_user', JSON.stringify(user));
  }, user);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (path.startsWith('/api/items')) {
        const existing = items.find(entry => path.endsWith('/' + entry.id));
        if (existing) Object.assign(existing, body);
        else items.push({ ...body, id: 72, active: true });
      }
      return route.fulfill({ json: { id: 99 } });
    }
    return route.fulfill({ json: path === '/api/auth/me' ? user : (path === '/api/items' ? items : {}) });
  });
  return writes;
}

async function swipe(page, direction) {
  const card = page.locator('.swipe-card');
  const box = await card.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 90;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + direction * 100, y, { steps: 5 });
  await page.mouse.up();
}

test('必填品项空数量无法点够/不够或双向滑过，0可提交，撤销保留数量', async ({ page }, testInfo) => {
  const writes = await setup(page, [{ ...item }]);
  await page.goto('/#/count-daily');
  const qty = page.getByRole('spinbutton');
  await expect(qty).toHaveAttribute('aria-required', 'true');
  await expect(page.locator('.swipe-qty')).toContainText('现场数量（必填）');
  for (const choice of ['够', '不够']) {
    await page.getByRole('button', { name: choice, exact: true }).click();
    await expect(page.locator('.swipe-card')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交每日盘点', exact: true })).toHaveCount(0);
  }
  for (const direction of [-1, 1]) {
    await swipe(page, direction);
    await expect(page.locator('.swipe-card')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交每日盘点', exact: true })).toHaveCount(0);
  }
  expect(writes).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('required-daily-card.png'), fullPage: true });
  await qty.fill('0');
  await page.getByRole('button', { name: '够', exact: true }).click();
  await page.getByRole('button', { name: '返回上一项', exact: true }).click();
  await expect(qty).toHaveValue('0');
  await qty.fill('');
  await page.getByRole('button', { name: '够', exact: true }).click();
  await expect(qty).toBeVisible();
  await qty.fill('0');
  await swipe(page, -1);
  await page.getByRole('button', { name: '提交每日盘点', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: '/api/counts', body: { count_type: 'daily', entries: [{ item_id: 71, enough: false, qty: 0 }] } });
});

test('关闭开关以及旧数据：够可空，不够仍必填', async ({ page }) => {
  const legacy = { ...item, id: 72, name: '旧数据' };
  delete legacy.daily_quantity_required;
  const writes = await setup(page, [{ ...item, daily_quantity_required: false }, legacy]);
  await page.goto('/#/count-daily');
  await expect(page.getByRole('spinbutton')).toHaveAttribute('aria-required', 'false');
  await page.getByRole('button', { name: '不够', exact: true }).click();
  await expect(page.locator('.swipe-name')).toHaveText(item.name);
  await page.getByRole('button', { name: '够', exact: true }).click();
  await expect(page.locator('.swipe-name')).toHaveText('旧数据');
  await page.getByRole('button', { name: '不够', exact: true }).click();
  await expect(page.locator('.swipe-name')).toHaveText('旧数据');
  await page.getByRole('button', { name: '够', exact: true }).click();
  await page.getByRole('button', { name: '提交每日盘点', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.entries).toEqual([{ item_id: 71, enough: true }, { item_id: 72, enough: true }]);
});

test('管理新增默认关闭，编辑回显并保存开关', async ({ page }, testInfo) => {
  const writes = await setup(page, [{ ...item }]);
  await page.goto('/#/items');
  await page.getByRole('button', { name: '+ 新增', exact: true }).click();
  const required = page.getByRole('checkbox', { name: '每日盘点必须填写数量', exact: true });
  await expect(required).not.toBeChecked();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.item-row', { hasText: item.name }).click();
  await expect(required).toBeChecked();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('required-item-editor.png'), fullPage: true });
  await required.uncheck();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.daily_quantity_required).toBe(false);
  await page.locator('.item-row', { hasText: item.name }).click();
  await expect(required).not.toBeChecked();
  await required.check();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body.daily_quantity_required).toBe(true);
  await page.getByRole('button', { name: '+ 新增', exact: true }).click();
  await expect(required).not.toBeChecked();
  await page.getByPlaceholder('如：吐司面包', { exact: true }).fill('新增默认关闭');
  await page.getByRole('combobox', { name: '库存品分类', exact: true }).selectOption(item.category);
  await page.getByRole('combobox', { name: '库存品单位', exact: true }).selectOption(item.unit);
  await page.getByPlaceholder('如：7', { exact: true }).fill('7');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].body.daily_quantity_required).toBe(false);
});
