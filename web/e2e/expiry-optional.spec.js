const { test, expect } = require('@playwright/test');
const user = { id: 1, role: 'admin', display_name: '测试管理员', must_change_pin: false };
const item = { id: 71, name: '效期测试品', category: '测试分类', unit: '个', shelf_life_days: 7, min_stock: 1, stock: 5, active: true };
async function setup(page, items, batches = []) {
  const writes = [];
  await page.addInitScript(user => { localStorage.setItem('sandwich_token', 'expiry-test'); localStorage.setItem('sandwich_user', JSON.stringify(user)); }, user);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { writes.push({ path, body: request.postDataJSON() });
      if (path.match(/^\/api\/batches\/\d+\/expiry$/)) { const batch = batches.find(b => path.includes('/' + b.id + '/')); batch.expiry_date = request.postDataJSON().expiry_date; batch.days_to_expiry = 59; }
      return route.fulfill({ json: { id: 99 } }); }
    const json = path === '/api/auth/me' ? user : path === '/api/items' ? items : path === '/api/stock' ? items.map(it => ({ item: it, stock: 5, batch_count: batches.length, nearest_expiry: batches.map(b => b.expiry_date).filter(Boolean).sort()[0] || null, missing_expiry_count: batches.filter(b => !b.expiry_date).length, latest_received_at: '2026-11-02T10:00:00Z' })) : path.endsWith('/batches') ? batches : {};
    return route.fulfill({ json });
  });
  return writes;
}
async function noOverflow(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
test('item default enabled, off hides shelf field and retains saved shelf configuration', async ({ page }, testInfo) => {
  const writes = await setup(page, [{ ...item }]);
  await page.goto('/#/items');
  await page.getByRole('button', { name: '+ 新增', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '启用效期', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.item-row').click();
  const toggle = page.getByRole('checkbox', { name: '启用效期', exact: true });
  await toggle.uncheck();
  await expect(page.getByPlaceholder('如：7', { exact: true })).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('expiry-off-editor-mobile.png'),fullPage:true,animations:'disabled'});
  await toggle.check();
  await expect(page.getByPlaceholder('如：7', { exact: true })).toHaveValue('7');
  await toggle.uncheck();
  await noOverflow(page);
  const weekly = page.getByRole('checkbox', {name:/每周盘点/});
  await weekly.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const weeklyBox = await weekly.boundingBox();
  const barBox = await page.locator('.fixed-bar').boundingBox();
  expect(weeklyBox.y + weeklyBox.height).toBeLessThanOrEqual(barBox.y);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ expiry_enabled: false, shelf_life_days: 7 });
});
test('stock sorts dates descending and same-date newest first; unknown can be completed', async ({ page }, testInfo) => {
  const batches = [
    {id:1,expiry_date:'2026-11-05',received_at:'2026-11-01T10:00:00Z',qty:1,days_to_expiry:3},
    {id:2,expiry_date:'2026-12-05',received_at:'2026-11-01T10:00:00Z',qty:2,days_to_expiry:33},
    {id:3,expiry_date:'2026-12-05',received_at:'2026-11-02T10:00:00Z',qty:3,days_to_expiry:33},
    {id:4,expiry_date:null,received_at:'2026-11-02T10:00:00Z',qty:4,days_to_expiry:null}
  ];
  const writes = await setup(page, [{ ...item }], batches);
  await page.goto('/#/stock');
  await expect(page.locator('.stock-row')).toContainText('最早到期');
  await page.locator('.stock-row').click();
  await expect(page.locator('.batch-qty')).toHaveText(['3 个','2 个','1 个','4 个']);
  await expect(page.locator('.batch-row').last()).toContainText('待补效期');
  await page.screenshot({path:testInfo.outputPath('unknown-expiry-mobile.png'),fullPage:true,animations:'disabled'});
  await page.getByLabel('补填效期', {exact:true}).fill('2026-12-31');
  await page.getByRole('button', { name: '保存效期' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({path:'/api/batches/4/expiry',body:{expiry_date:'2026-12-31'}});
  await expect(page.locator('.batch-qty')).toHaveText(['4 个','3 个','2 个','1 个']);
  await expect(page.locator('.stock-sub')).not.toContainText('待补效期');
  await expect(page.locator('.stock-sub')).toContainText('最早到期 2026-11-05');
  await noOverflow(page);
});
test('off stock uses newest receipt first and hides retained historical expiry', async ({ page }, testInfo) => {
  await setup(page, [{ ...item, expiry_enabled:false }], [
    {id:1,expiry_date:'2026-12-05',received_at:'2026-11-01T10:00:00Z',qty:1,days_to_expiry:33},
    {id:2,expiry_date:null,received_at:'2026-11-02T10:00:00Z',qty:2,days_to_expiry:null}
  ]);
  await page.goto('/#/stock');
  await expect(page.locator('.stock-sub')).not.toContainText('效期');
  await page.locator('.stock-row').click();
  await expect(page.locator('.batch-qty')).toHaveText(['2 个','1 个']);
  await expect(page.locator('.batch-days')).toHaveCount(0);
  await expect(page.locator('.batch-exp')).toContainText(['入库','入库']);
  await page.screenshot({path:testInfo.outputPath('expiry-off-batches-mobile.png'),fullPage:true,animations:'disabled'});
  await noOverflow(page);
});
for (const mixed of [false,true]) test(`direct receipt ${mixed ? 'mixed requires enabled dates only' : 'all-off skips date inputs'}`, async ({ page }) => {
  const items = [{ ...item, expiry_enabled:false }, ...(mixed ? [{ ...item,id:72,name:'需日期',expiry_enabled:true }] : [])];
  const writes = await setup(page, items);
  await page.goto('/#/receive');
  await expect(page.locator('.count-row input')).toHaveCount(items.length);
  for (const input of await page.locator('.count-row input').all()) { await input.fill('1'); await input.blur(); }
  await page.getByRole('button', { name: /^下一步：/ }).click();
  await expect(page.locator('input[type=date]')).toHaveCount(mixed ? 1 : 0);
  if (!mixed) await expect(page.locator('.recv-title')).toHaveText('确认入库');
  await noOverflow(page);
  await page.getByRole('button', { name:'确认入库',exact:true }).click();
  await page.locator('.dialog').getByRole('button', {name:'确认入库',exact:true}).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.items[0].expiry_date).toBeNull();
  if (mixed) expect(writes[0].body.items[1].expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
for (const mixed of [false,true]) test(`purchase receipt ${mixed ? 'mixed' : 'all-off'} sends null for disabled items`, async ({ page }) => {
  const writes = await setup(page, [{...item}]);
  const lines = [{...item,id:101,item_id:71,expiry_enabled:false,qty:2}, ...(mixed ? [{...item,id:102,item_id:72,expiry_enabled:true,qty:1}] : [])];
  await page.route('**/api/purchases?**', route => route.fulfill({json:[{id:31,status:'ordered',items:lines,created_at:'2026-11-02T00:00:00Z'}]}));
  await page.goto('/#/purchase');
  await page.getByRole('button',{name:'入库',exact:true}).click();
  await expect(page.locator('input[type=date]')).toHaveCount(mixed ? 1 : 0);
  await noOverflow(page);
  await page.getByRole('button',{name:'确认入库',exact:true}).click();
  await page.locator('.dialog').getByRole('button',{name:'确认入库',exact:true}).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.items[0]).toEqual({purchase_item_id:101,expiry_date:null});
  if (mixed) expect(writes[0].body.items[1].expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
test('disabled receipt correction hides current expiry and retains historical dates', async ({ page }) => {
  const writes = await setup(page, [{...item,expiry_enabled:false}]);
  const receipt = { id:61,item_name:item.name,unit:'个',expiry_enabled:false,expiry_date:'2026-11-05',qty:2,original_qty:2,remaining_qty:2,revision:0,received_at:'2026-11-01T00:00:00Z',received_by_name:'测试管理员',corrections:[{old_qty:1,new_qty:2,old_expiry_date:'2026-10-01',new_expiry_date:'2026-11-05',actor_name:'测试管理员',created_at:'2026-11-02T00:00:00Z',reason:'原记录核对'}] };
  await page.route('**/api/stock/receipts?**', route => route.fulfill({json:{items:[receipt],has_more:false}}));
  await page.route('**/api/stock/receipts/61', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:receipt});
    writes.push({path:'/api/stock/receipts/61',body:route.request().postDataJSON()});
    return route.fulfill({json:receipt});
  });
  await page.goto('/#/receipts');
  await expect(page.locator('.receipt-list')).not.toContainText('2026-11-05');
  await page.getByRole('button',{name:'查看与更正'}).click();
  await expect(page.getByLabel('更正后效期',{exact:true})).toHaveCount(0);
  await expect(page.locator('.receipt-audit')).toContainText('2026-10-01 → 2026-11-05');
  await page.getByLabel('更正原因',{exact:true}).fill('数量核对');
  await page.getByRole('button',{name:'保存更正',exact:true}).click();
  await page.locator('.dialog').getByRole('button',{name:'保存更正',exact:true}).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.expiry_date).toBeNull();
  await noOverflow(page);
});

test('enabled card with no inventory batches does not claim a missing expiry', async ({ page }) => {
  await setup(page, [{...item}]);
  await page.route('**/api/stock', route => route.fulfill({json:[{item:{...item},stock:0,batch_count:0,nearest_expiry:null,missing_expiry_count:0}]}));
  await page.goto('/#/stock');
  await expect(page.locator('.stock-sub')).toContainText('0 个批次');
  await expect(page.locator('.stock-sub')).not.toContainText('待补效期');
  await expect(page.locator('.stock-sub')).not.toContainText('最早到期');
});
test('enabled card displays known earliest expiry alongside missing batch count', async ({ page }, testInfo) => {
  await setup(page, [{...item}]);
  await page.route('**/api/stock', route => route.fulfill({json:[{item:{...item},stock:3,batch_count:3,nearest_expiry:'2026-11-05',missing_expiry_count:2}]}));
  await page.goto('/#/stock');
  await expect(page.locator('.stock-sub')).toContainText('最早到期 2026-11-05');
  await expect(page.locator('.stock-sub')).toContainText('2 批待补效期');
  await noOverflow(page);
  await page.screenshot({path:testInfo.outputPath('mixed-expiry-stock-card.png'),fullPage:true,animations:'disabled'});
});
