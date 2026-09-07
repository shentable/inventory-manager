const { test, expect } = require('@playwright/test');

async function enterPin(page, pin) {
  await expect(page.locator('.pin-card')).toHaveCount(1);
  for (const digit of pin) {
    await page.locator('.overlay:not(.hide) .pin-key', { hasText: digit }).click();
  }
  await page.locator('.overlay:not(.hide) .pin-key.ok').click();
}

async function login(page, username, pin) {
  await page.goto('/#/login');
  await page.locator('.user-card', { hasText: '@' + username + ' ·' }).click();
  await enterPin(page, pin);
}

test.describe.serial('门店试运行浏览器流程', () => {
  test('中英文切换后登录页和主导航完整可用', async ({ page }) => {
    const i18nScripts = /\/js\/i18n(?:\/.*)?\.js$/;
    await page.route(i18nScripts, (route) => route.abort());
    await page.goto('/#/login');
    await expect(page.locator('.login-title')).toHaveText('飨拓™库存管理');
    await expect(page.locator('.user-card')).toHaveCount(5);
    await page.unroute(i18nScripts);

    await page.goto('/#/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.login-title')).toHaveText('Shantech™ Inventory Management');
    await expect(page.locator('.login-sub')).toHaveText('Choose an account · enter PIN to log in');
    await expect(page.getByRole('button', { name: 'Choose language' })).toBeVisible();

    await page.locator('.user-card', { hasText: '@staff · Staff' }).click();
    await expect(page.locator('.pin-card .dialog-msg')).toHaveText('Enter PIN (4-6 digits)');
    await enterPin(page, '3333');
    await expect(page.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', 'https://github.com/shentable/inventory-manager');
    await expect(page.locator('.feat-card', { hasText: 'Weekly count' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: 'Waste' })).toBeVisible();
  });

  test('首次登录强制改 PIN 并进入首页', async ({ page }) => {
    await login(page, 'first', '1234');
    const preChangeToken = await page.evaluate(() => window.API.store.getToken());
    await enterPin(page, '1234');
    await enterPin(page, '5678');
    await enterPin(page, '5678');
    await expect(page.locator('.home-user-name')).toHaveText('首次用户');
    const revoked = await page.request.get('/api/auth/me', {
      headers: { Authorization: 'Bearer ' + preChangeToken }
    });
    expect(revoked.status()).toBe(401);

    await page.locator('.btn-logout').click();
    await login(page, 'first', '1234');
    await expect(page.locator('.toast-msg', { hasText: 'PIN 不正确' })).toBeVisible();
    await login(page, 'first', '5678');
    await expect(page.locator('.home-user-name')).toHaveText('首次用户');
  });

  test('两名店员独立提交每周盘点', async ({ page }) => {
    await login(page, 'staff', '3333');
    await expect(page.locator('.feat-card', { hasText: '采购' })).toHaveCount(0);
    await expect(page.locator('.feat-card', { hasText: '直接增加库存批次' })).toHaveCount(0);
    await expect(page.locator('.feat-card', { hasText: '用户管理' })).toHaveCount(0);
    await expect(page.locator('.feat-card', { hasText: '每周盘点' })).toBeVisible();
    await page.locator('.feat-card', { hasText: '每日盘点' }).click();
    const firstCard = page.locator('.swipe-card');
    await firstCard.locator('.swipe-qty-input').fill('12');
    await expect(firstCard.locator('.swipe-safe .swipe-metric-label')).toHaveText('安全数量');
    await expect(firstCard.locator('.swipe-safe .swipe-metric-value')).toHaveText('2 袋');
    await expect(firstCard.locator('.swipe-last-qty')).toHaveText('暂无记录');
    const box = await firstCard.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 15, box.y + box.height / 2, { steps: 5 });
    await expect(firstCard.locator('.swipe-badge-yes')).toHaveCSS('opacity', '1');
    await expect(firstCard.locator('.swipe-badge-no')).toHaveCSS('opacity', '0');
    await expect(firstCard).toHaveCSS('background-image', /54, 179, 107/);
    await page.mouse.up();
    await page.waitForTimeout(220);
    const secondCard = page.locator('.swipe-card');
    const secondBox = await secondCard.boundingBox();
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + 15, secondBox.y + secondBox.height / 2, { steps: 5 });
    await expect(secondCard.locator('.swipe-badge-no')).toHaveCSS('opacity', '1');
    await expect(secondCard.locator('.swipe-badge-yes')).toHaveCSS('opacity', '0');
    await expect(secondCard).toHaveCSS('background-image', /224, 75, 75/);
    await page.mouse.up();
    await expect(page.locator('.toast-msg', { hasText: '选择不够时必须填写现场数量' })).toBeVisible();
    await expect(page.locator('.swipe-progress')).toHaveText('2 / 9');
    await secondCard.locator('.swipe-qty-input').fill('0');
    const retryBox = await secondCard.boundingBox();
    await page.mouse.move(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(retryBox.x + 15, retryBox.y + retryBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(220);
    while (await page.locator('.swipe-card').count()) {
      await page.getByRole('button', { name: '够', exact: true }).click();
      await page.waitForTimeout(220);
    }
    await expect(page.locator('.daily-summary-title')).toHaveText('今日确认完成');
    await page.getByRole('button', { name: '提交每日盘点' }).click();
    await expect(page.locator('.toast-msg', { hasText: '每日盘点已完成' })).toBeVisible();
    await expect(page.locator('.home-user-name')).toHaveText('店员');
    await expect(page.locator('.dash-card', { hasText: '今日盘点结果' })).toBeVisible();
    await page.locator('.dash-card', { hasText: '今日盘点结果' }).click();
    await expect(page.locator('.daily-result-card')).toHaveCount(1);
    await page.locator('.daily-result-card').first().click();
    await expect(page.locator('.daily-result-line')).toHaveCount(9);
    await expect(page.locator('.daily-result-qty.recorded')).toHaveCount(2);
    await expect(page.locator('.daily-result-qty.recorded', { hasText: '现场数量：12' })).toBeVisible();
    await expect(page.locator('.daily-result-qty.recorded', { hasText: '现场数量：0' })).toBeVisible();
    await page.goto('/#/');

    // 当天再次提交时先展示逐项差异，只有明确确认才覆盖，且数据库仍只有一条今日结果。
    await page.locator('.feat-card', { hasText: '每日盘点' }).click();
    await expect(page.locator('.swipe-last-time')).not.toContainText('尚无');
    await expect(page.locator('.swipe-last-qty')).toHaveText('12 袋');
    await expect(page.locator('.swipe-last-meta')).toHaveText('每日盘点 · 够');
    await page.locator('.swipe-qty-input').fill('10');
    await page.getByRole('button', { name: '不够', exact: true }).click();
    await page.waitForTimeout(220);
    await page.locator('.swipe-qty-input').fill('1');
    await page.getByRole('button', { name: '不够', exact: true }).click();
    await page.waitForTimeout(220);
    while (await page.locator('.swipe-card').count()) {
      await page.getByRole('button', { name: '够', exact: true }).click();
      await page.waitForTimeout(220);
    }
    await page.getByRole('button', { name: '提交每日盘点' }).click();
    const overwrite = page.locator('.overlay:not(.hide)');
    await expect(overwrite.locator('.dialog-title')).toHaveText('今日已有盘点结果');
    await expect(overwrite.locator('.dialog-msg')).toContainText('够 / 数量 12 → 不够 / 数量 10');
    await overwrite.getByRole('button', { name: '确认覆盖' }).click();
    await expect(page.locator('.toast-msg', { hasText: '每日盘点已完成' })).toBeVisible();

    const token = await page.evaluate(() => window.API.store.getToken());
    const daily = await page.request.get('/api/counts?status=completed&count_type=daily', {
      headers: { Authorization: 'Bearer ' + token }
    });
    expect((await daily.json()).length).toBe(1);
    const items = await page.request.get('/api/items', { headers: { Authorization: 'Bearer ' + token } });
    const numeric = await page.request.post('/api/counts', {
      headers: { Authorization: 'Bearer ' + token },
      data: { count_type: 'weekly', entries: [{ item_id: (await items.json())[1].id, qty: 2 }] }
    });
    expect(numeric.status()).toBe(201);
    const numericBody = await numeric.json();
    await page.goto('/#/');
    await expect(page.locator('.dash-card', { hasText: '我的每周盘点' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '我的盘点' })).toHaveCount(0);
    await page.locator('.dash-card', { hasText: '我的每周盘点' }).click();
    await expect(page.locator('.page-title')).toHaveText('每周盘点');
    await expect(page.getByRole('tab', { name: '我的记录' })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.count-summary-card', { hasText: '盘点单 #' + numericBody.id }).click();
    await page.getByRole('button', { name: '修改盘点数据' }).click();
    const addItemSelect = page.getByLabel('增加盘点品');
    await expect(addItemSelect).toBeVisible();
    const addedItemId = await addItemSelect.locator('option:not([value=""])').first().getAttribute('value');
    expect(addedItemId).toBeTruthy();
    await addItemSelect.selectOption(addedItemId);
    await page.getByRole('button', { name: '加入盘点' }).click();
    await expect(page.locator('.count-edit-list .review-entry-row')).toHaveCount(2);
    await page.locator('.count-edit-list .review-qty-input').nth(0).fill('4');
    await page.locator('.count-edit-list .review-qty-input').nth(1).fill('5');
    await page.getByRole('button', { name: '保存盘点修改' }).click();
    await expect(page.locator('.toast-msg', { hasText: '盘点数据已修改' })).toBeVisible();
    await expect(page.locator('.review-compare-row')).toHaveCount(2);
    await expect(page.locator('.review-compare-row .diff-sub', { hasText: '本次记录 4' })).toBeVisible();

    const staffBLogin = await page.request.post('/api/auth/login', {
      data: { username: 'staff_b', pin: '4444' }
    });
    expect(staffBLogin.status()).toBe(200);
    const staffBToken = (await staffBLogin.json()).token;
    const secondWeekly = await page.request.post('/api/counts', {
      headers: { Authorization: 'Bearer ' + staffBToken },
      data: {
        count_type: 'weekly',
        entries: [
          { item_id: numericBody.entries[0].item_id, qty: 3 },
          { item_id: Number(addedItemId), qty: 5 }
        ],
        note: '店员乙独立复盘'
      }
    });
    expect(secondWeekly.status()).toBe(201);
    const otherVisible = await page.request.get('/api/counts?status=submitted&count_type=weekly&days=3', {
      headers: { Authorization: 'Bearer ' + staffBToken }
    });
    const staffBRecords = await otherVisible.json();
    expect(staffBRecords).toHaveLength(1);
    expect(staffBRecords[0].created_by_name).toBe('店员乙');
  });

  test('店员可提交报损', async ({ page }) => {
    await login(page, 'staff', '3333');
    await page.locator('.feat-card', { hasText: '登记损耗' }).click();
    await page.locator('.pick-card', { hasText: '测试吐司' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('.chip', { hasText: '破损' }).click();
    await page.locator('.waste-description').fill('外包装破裂，已隔离');
    await page.getByRole('button', { name: '提交报损' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认提交' }).click();
    await expect(page.locator('.success-title')).toHaveText('已提交，等待店长确认');
  });

  test('店长直接入库、比对两份盘点、确认报损和采购入库', async ({ page }) => {
    await login(page, 'manager', '2222');
    await expect(page.locator('.feat-card', { hasText: '盘点管理' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '盘点汇总' })).toHaveCount(0);
    await expect(page.locator('.dash-card', { hasText: '近3天盘点' })).toHaveCount(0);
    await expect(page.locator('.feat-card', { hasText: '采购' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '直接增加库存批次' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '用户管理' })).toHaveCount(0);

    await expect(page.locator('.dash-card', { hasText: '今日盘点结果' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '每日盘点结果' })).toHaveCount(0);
    await page.locator('.dash-card', { hasText: '今日盘点结果' }).click();
    await expect(page.locator('.daily-result-card')).toHaveCount(1);
    await expect(page.locator('.daily-result-card').first().locator('.tag.short')).toHaveText('不够 2 项');
    await page.locator('.daily-result-card').first().click();
    await expect(page.locator('.daily-result-line.lacking')).toHaveCount(2);

    await page.goto('/#/receive');
    await page.locator('.count-row').first().getByRole('button', { name: '增加' }).click();
    await page.getByRole('button', { name: '下一步：填写效期' }).click();
    await expect(page.locator('.recv-card')).toHaveCount(1);
    await page.getByPlaceholder('入库备注（选填）').fill('临时到货');
    await page.getByRole('button', { name: '确认入库' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认入库' }).click();
    await expect(page.locator('.toast-msg', { hasText: '入库成功' })).toBeVisible();

    await page.goto('/#/stock');
    const stockRows = await page.evaluate(() => window.API.stock());
    const stockCategory = stockRows[0].item.category || '未分类';
    const stockCategoryCount = stockRows.filter(row => (row.item.category || '未分类') === stockCategory).length;
    const stockCategoryNav = page.getByLabel('库存分类导航');
    await expect(stockCategoryNav).toBeVisible();
    const stockHeadBox = await page.locator('.stock-page .page-head').boundingBox();
    const stockNavBox = await stockCategoryNav.boundingBox();
    expect(stockNavBox.y).toBeGreaterThanOrEqual(stockHeadBox.y);
    expect(stockNavBox.y + stockNavBox.height).toBeLessThanOrEqual(stockHeadBox.y + stockHeadBox.height + 1);
    await stockCategoryNav.selectOption(stockCategory);
    await expect(page.locator('.stock-row')).toHaveCount(stockCategoryCount);
    await expect(page.locator('.stock-row .stock-sub')).toContainText(Array(stockCategoryCount).fill(stockCategory));
    await stockCategoryNav.selectOption('__all__');
    await expect(page.locator('.stock-row')).toHaveCount(stockRows.length);
    const emptyStock = page.locator('.stock-row', { hasText: '测试空库存' });
    await expect(emptyStock).toBeVisible();
    await expect(emptyStock.locator('.stock-qty')).toContainText('0 个');
    await expect(emptyStock.locator('.stock-qty')).toHaveClass(/low/);
    await expect(page.locator('.stock-row', { hasText: '测试吐司' }).locator('.stock-qty')).toHaveClass(/safe/);

    await page.goto('/#/count-review');
    await expect(page.locator('.page-title')).toHaveText('盘点管理');
    await expect(page.getByRole('tab', { name: '待比对' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '盘点记录' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '确认结果' })).toBeVisible();
    await expect(page.locator('.pair-select-card')).toHaveCount(2);
    await page.locator('.pair-select-card').nth(0).click();
    await page.locator('.pair-select-card').nth(1).click();
    await page.getByRole('button', { name: /比对已选记录/ }).click();
    await expect(page.locator('.pair-compare-row')).toHaveCount(2);
    await expect(page.locator('.pair-compare-row.different')).toHaveCount(1);
    await expect(page.locator('.review-qty-input')).toHaveCount(0);
    await page.getByRole('button', { name: '正常消耗，采用后提交' }).click();
    await expect(page.locator('.toast-msg', { hasText: '双人盘点已确认并落库' })).toBeVisible();

    await page.getByRole('tab', { name: '盘点记录' }).click();
    await expect(page.getByLabel('盘点记录时间范围')).toHaveValue('3');
    await expect(page.locator('.count-summary-card')).toHaveCount(2);
    await page.getByRole('tab', { name: '确认结果' }).click();
    await expect(page.getByLabel('确认结果时间范围')).toHaveValue('3');
    await expect(page.locator('.count-history-card')).toHaveCount(1);
    await expect(page.locator('.count-history-card').first()).toContainText('正常消耗 · 采用后提交');
    await expect(page.locator('.count-history-card').first()).toContainText('两份独立记录');
    await page.locator('.count-history-card').first().click();
    await expect(page.locator('.detail-head')).toContainText('比对单 #');
    await expect(page.locator('.comparison-final')).toHaveCount(2);
    await expect(page.locator('.comparison-final', { hasText: '最终采用 3' })).toBeVisible();
    await expect(page.locator('.comparison-final', { hasText: '最终采用 5' })).toBeVisible();

    await page.goto('/#/waste-review');
    await expect(page.locator('.waste-card').first().locator('.waste-description-view')).toHaveText('外包装破裂，已隔离');
    await page.locator('.waste-card').first().getByRole('button', { name: '确认', exact: true }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认', exact: true }).click({ force: true });
    await expect(page.locator('.toast-msg', { hasText: '库存已扣减' })).toBeVisible();

    await page.goto('/#/purchase');
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.locator('.count-row').first().getByRole('button', { name: '增加' }).click();
    await page.getByRole('button', { name: '提交采购单' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认提交' }).click();
    await expect(page.locator('.purchase-card')).toHaveCount(1);
    await page.locator('.purchase-card').first().getByRole('button', { name: '入库' }).click();
    await page.getByRole('button', { name: '确认入库' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认入库' }).click();
    await expect(page.locator('.toast-msg', { hasText: '入库成功' })).toBeVisible();
  });

  test('断网显示缓存且禁止写入，恢复后执行 ETag 同步', async ({ page, context }) => {
    await login(page, 'staff', '3333');
    await page.locator('.feat-card', { hasText: '库存查询' }).click();
    await expect(page.locator('.stock-row').first()).toBeVisible();
    let offlineWrites = 0;
    const notModified = [];
    page.on('request', request => {
      if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) offlineWrites += 1;
    });
    page.on('response', response => {
      if (response.url().includes('/api/') && response.status() === 304) notModified.push(response.url());
    });
    await context.setOffline(true);
    await expect(page.locator('.offline-title')).toContainText('数据未同步');
    await page.evaluate(() => window.__reloadRoute());
    await expect(page.locator('.stock-row').first()).toBeVisible();
    const blocked = await page.evaluate(() => window.API.createWaste({ item_id: 1, qty: 1, reason: 'other' }).then(() => false, err => !!err.readonly));
    expect(blocked).toBe(true);
    expect(offlineWrites).toBe(0);
    await context.setOffline(false);
    await expect(page.locator('.offline-overlay')).not.toHaveClass(/show/);
    await expect.poll(() => notModified.length).toBeGreaterThan(0);
    await expect(page.locator('.stock-row').first()).toBeVisible();
  });

  test('库存品盘点开关分别筛选每日与每周盘点', async ({ page }) => {
    await login(page, 'manager', '2222');
    await expect(page.locator('.home-user-name')).toHaveText('店长');
    const items = await page.evaluate(() => window.API.items(false));
    await page.evaluate(([id, data]) => window.API.updateItem(id, data), [items[0].id, {
      daily_count_enabled: false, weekly_count_enabled: true
    }]);
    await page.evaluate(([id, data]) => window.API.updateItem(id, data), [items[1].id, {
      daily_count_enabled: true, weekly_count_enabled: false
    }]);

    await page.goto('/#/count-daily');
    await expect(page.locator('.swipe-progress')).toHaveText('1 / 8');
    await expect(page.locator('.swipe-card')).toContainText(items[1].name);
    await expect(page.locator('.swipe-card')).not.toContainText(items[0].name);

    await page.goto('/#/count-weekly');
    await expect(page.locator('.count-row')).toHaveCount(8);
    await expect(page.locator('.count-row', { hasText: items[0].name })).toBeVisible();
    await expect(page.locator('.count-row', { hasText: items[1].name })).toHaveCount(0);

    await page.goto('/#/items');
    const category = items[0].category || '未分类';
    const expectedCategoryCount = items.filter(item => (item.category || '未分类') === category).length;
    const categoryNav = page.getByLabel('分类导航');
    await expect(categoryNav).toBeVisible();
    const headBox = await page.locator('.items-page .page-head').boundingBox();
    const navBox = await categoryNav.boundingBox();
    expect(navBox.y).toBeGreaterThanOrEqual(headBox.y);
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(headBox.y + headBox.height + 1);
    await categoryNav.selectOption(category);
    await expect(page.locator('.item-row')).toHaveCount(expectedCategoryCount);
    await categoryNav.selectOption('__all__');
    await expect(page.locator('.item-row')).toHaveCount(items.length);
    await page.locator('.item-row', { hasText: items[0].name }).click();
    await expect(page.locator('.count-scope-option', { hasText: '每日盘点' }).locator('input')).not.toBeChecked();
    await expect(page.locator('.count-scope-option', { hasText: '每周盘点' }).locator('input')).toBeChecked();
    const editCategory = page.getByLabel('库存品分类');
    await expect(editCategory).toBeVisible();
    expect(await editCategory.evaluate(el => el.tagName)).toBe('SELECT');
    const optionLabels = await editCategory.locator('option').allTextContents();
    expect(optionLabels.at(-1)).toBe('＋ 新增');
    await editCategory.selectOption('__new__');
    const newCategoryPrompt = page.locator('.overlay:not(.hide)');
    await expect(newCategoryPrompt).toContainText('新增分类');
    await newCategoryPrompt.locator('.text-prompt-input').fill('测试新增分类');
    await newCategoryPrompt.getByRole('button', { name: '新增', exact: true }).click();
    await expect(editCategory).toHaveValue('测试新增分类');
    expect((await editCategory.locator('option').allTextContents()).at(-1)).toBe('＋ 新增');
    const editUnit = page.getByLabel('库存品单位');
    await expect(editUnit).toBeVisible();
    expect(await editUnit.evaluate(el => el.tagName)).toBe('SELECT');
    expect((await editUnit.locator('option').allTextContents()).at(-1)).toBe('＋ 新增');
    await editUnit.selectOption('__new__');
    const newUnitPrompt = page.locator('.overlay:not(.hide)');
    await expect(newUnitPrompt).toContainText('新增单位');
    await newUnitPrompt.locator('.text-prompt-input').fill('测试箱');
    await newUnitPrompt.getByRole('button', { name: '新增', exact: true }).click();
    await expect(editUnit).toHaveValue('测试箱');
    expect((await editUnit.locator('option').allTextContents()).at(-1)).toBe('＋ 新增');
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('.toast-msg', { hasText: '已保存' })).toBeVisible();
    await expect(page.getByLabel('分类导航')).toHaveValue('测试新增分类');
    await expect(page.locator('.item-row', { hasText: items[0].name })).toContainText('测试箱');
  });

  test('管理员可调整身份、修改用户名且旧登录立即失效', async ({ page }) => {
    await login(page, 'admin', '1111');
    await page.locator('.feat-card', { hasText: '用户管理' }).click();
    const staffRow = page.locator('.user-row', { hasText: '@staff ·' });
    await expect(staffRow).toBeVisible();
    await staffRow.getByRole('button', { name: '调整身份' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '店长' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认调整' }).click();
    await expect(page.locator('.toast-msg', { hasText: '用户身份已调整' })).toBeVisible();
    await expect(page.locator('.user-row', { hasText: '@staff · 店长' })).toBeVisible();
    const renamedStaffRow = page.locator('.user-row', { hasText: '@staff · 店长' });
    await renamedStaffRow.getByRole('button', { name: '编辑资料' }).click();
    const prompt = page.locator('.overlay:not(.hide)');
    await prompt.locator('[data-key="username"]').fill('  SHOP_STAFF  ');
    await prompt.getByRole('button', { name: '保存' }).click();
    await page.locator('.overlay:not(.hide)').getByRole('button', { name: '确认修改' }).click();
    await expect(page.locator('.toast-msg', { hasText: '用户名已修改' })).toBeVisible();
    await expect(page.locator('.user-row', { hasText: '@shop_staff ·' })).toBeVisible();

    const oldLogin = await page.request.post('/api/auth/login', {
      data: { username: 'staff', pin: '3333' }
    });
    expect(oldLogin.status()).toBe(401);
    await page.evaluate(() => window.API.store.clear());
    await login(page, 'shop_staff', '3333');
    await expect(page.locator('.home-user-name')).toHaveText('店员');
    await expect(page.locator('.feat-card', { hasText: '采购' })).toBeVisible();
    await expect(page.locator('.feat-card', { hasText: '直接增加库存批次' })).toBeVisible();
  });
});
