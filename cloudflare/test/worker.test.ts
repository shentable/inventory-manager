import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

const api = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://example.test/api${path}`, init));

async function request(path: string, method = "GET", token?: string, payload?: unknown) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (payload !== undefined) headers.set("Content-Type", "application/json");
  return api(path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

async function login(username: string, pin: string) {
  const response = await request("/auth/login", "POST", undefined, { username, pin });
  expect(response.status).toBe(200);
  return (await response.json() as { token: string }).token;
}

describe("Workers + D1 inventory contract", () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  it("runs bootstrap, role, inventory, waste, count and ETag flows", async () => {
    const health = await request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", backend_kind: "cloudflare_worker" });

    const options = await request("/auth/login-options");
    expect(await options.json()).toMatchObject({ users: [{ username: "admin", must_change_pin: true }] });

    let admin = await login("admin", "246810");
    const blocked = await request("/items?include_inactive=false", "GET", admin);
    expect(blocked.status).toBe(403);

    const changed = await request("/auth/change-pin", "POST", admin, { current_pin: "246810", new_pin: "864210" });
    admin = (await changed.json() as { token: string }).token;

    const managerCreated = await request("/users", "POST", admin, { username: "manager", display_name: "店长", pin: "2222", role: "manager" });
    expect(managerCreated.status).toBe(201);
    const managerUser = await managerCreated.json() as { id: number };
    const staffCreated = await request("/users", "POST", admin, { username: "staff", display_name: "店员", pin: "3333", role: "staff" });
    expect(staffCreated.status).toBe(201);
    const staffUser = await staffCreated.json() as { id: number };
    const staffBCreated = await request("/users", "POST", admin, { username: "staff_b", display_name: "店员乙", pin: "4444", role: "staff" });
    expect(staffBCreated.status).toBe(201);

    let manager = await login("manager", "2222");
    manager = (await (await request("/auth/change-pin", "POST", manager, { current_pin: "2222", new_pin: "2233" })).json() as { token: string }).token;
    let staff = await login("staff", "3333");
    staff = (await (await request("/auth/change-pin", "POST", staff, { current_pin: "3333", new_pin: "3344" })).json() as { token: string }).token;
    let staffB = await login("staff_b", "4444");
    staffB = (await (await request("/auth/change-pin", "POST", staffB, { current_pin: "4444", new_pin: "4455" })).json() as { token: string }).token;

    const oldManagerToken = manager;
    const renamed = await request(`/users/${managerUser.id}`, "PATCH", admin, { username: "  STORE_MANAGER  " });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ username: "store_manager" });
    expect((await request("/auth/me", "GET", oldManagerToken)).status).toBe(401);
    expect((await request("/auth/login", "POST", undefined, { username: "manager", pin: "2233" })).status).toBe(401);
    manager = await login("store_manager", "2233");
    const duplicateUsername = await request(`/users/${staffUser.id}`, "PATCH", admin, { username: "STORE_MANAGER" });
    expect(duplicateUsername.status).toBe(409);
    expect(await duplicateUsername.json()).toMatchObject({ detail: "用户名已存在" });

    expect((await request("/purchases", "GET", staff)).status).toBe(403);
    const itemResponse = await request("/items", "POST", manager, { name: "测试吐司", unit: "片", shelf_life_days: 5, min_stock: 4 });
    const item = await itemResponse.json() as { id: number };
    const secondItemResponse = await request("/items", "POST", manager, { name: "测试火腿", unit: "片", shelf_life_days: 7, min_stock: 3 });
    const secondItem = await secondItemResponse.json() as { id: number };

    expect((await request("/stock/receive", "POST", staff, { items: [{ item_id: item.id, qty: 1, expiry_date: "2026-09-07" }] })).status).toBe(403);
    expect((await request("/stock/receive", "POST", manager, { items: [{ item_id: item.id, qty: 1, expiry_date: "2026-02-31" }] })).status).toBe(400);
    const directReceive = await request("/stock/receive", "POST", manager, {
      items: [{ item_id: item.id, qty: 2, expiry_date: "2026-09-08" }],
      note: "临时补货",
    });
    expect(directReceive.status).toBe(201);
    expect(await directReceive.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ item_id: item.id, qty: 2, initial_qty: 2, source: "receive", note: "临时补货" }),
    ]));

    const purchaseResponse = await request("/purchases", "POST", manager, { items: [{ item_id: item.id, qty: 10 }, { item_id: secondItem.id, qty: 6 }] });
    const purchase = await purchaseResponse.json() as { id: number; items: Array<{ id: number }> };
    expect((await request(`/purchases/${purchase.id}/receive`, "POST", manager, { items: purchase.items.map((line) => ({ purchase_item_id: line.id, expiry_date: "2026-09-07" })) })).status).toBe(200);

    const wasteResponse = await request("/waste", "POST", staff, { item_id: item.id, qty: 2, reason: "破损", description: "仅保留文字原因" });
    const waste = await wasteResponse.json() as { id: number; has_photo: boolean };
    expect(waste.has_photo).toBe(false);
    expect((await request(`/waste/${waste.id}/confirm`, "POST", manager)).status).toBe(200);

    const daily = await request("/counts", "POST", staff, { count_type: "daily", entries: [{ item_id: item.id, enough: true, qty: 6 }] });
    expect(daily.status).toBe(201);
    expect(await daily.json()).toMatchObject({ entries: [{ reported_qty: 6 }] });
    expect(await (await request("/items", "GET", staff)).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: item.id, last_count_qty: 6, last_count_type: "daily", last_count_enough: true }),
    ]));
    const dailyList = await request("/counts?count_type=daily", "GET", staff);
    expect(await dailyList.json()).toMatchObject([{ quantity_count: 1 }]);
    const missingQuantity = await request("/counts", "POST", staff, { count_type: "daily", entries: [{ item_id: item.id, enough: false }] });
    expect(missingQuantity.status).toBe(400);
    const duplicate = await request("/counts", "POST", staff, { count_type: "daily", entries: [{ item_id: item.id, enough: false, qty: 5 }] });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ detail: { code: "daily_count_exists" } });

    const numeric = await request("/counts", "POST", staff, { count_type: "weekly", entries: [{ item_id: item.id, qty: 8 }] });
    const numericCount = await numeric.json() as { id: number };
    const editedNumeric = await request(`/counts/${numericCount.id}`, "PATCH", staff, {
      entries: [{ item_id: item.id, qty: 8 }, { item_id: secondItem.id, qty: 6 }],
      note: "再次清点并补加漏项",
    });
    expect(editedNumeric.status).toBe(200);
    expect(await editedNumeric.json()).toMatchObject({ note: "再次清点并补加漏项", entries: [{ qty_counted: 8 }, { qty_counted: 6 }] });
    const legacyVerify = await request(`/counts/${numericCount.id}/verify`, "POST", manager, { entries: [] });
    expect(legacyVerify.status).toBe(409);
    expect(await legacyVerify.json()).toMatchObject({ detail: { code: "pair_verification_required" } });
    const secondCountResponse = await request("/counts", "POST", staffB, {
      count_type: "weekly",
      entries: [{ item_id: item.id, qty: 7 }, { item_id: secondItem.id, qty: 6 }],
    });
    expect(secondCountResponse.status).toBe(201);
    const secondCount = await secondCountResponse.json() as { id: number };
    const previewResponse = await request("/count-comparisons/preview", "POST", manager, {
      first_count_id: numericCount.id,
      second_count_id: secondCount.id,
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { comparison_token: string; different_count: number; shared_count: number };
    expect(preview).toMatchObject({ different_count: 1, shared_count: 2 });
    const accepted = await request("/count-comparisons", "POST", manager, {
      first_count_id: numericCount.id,
      second_count_id: secondCount.id,
      comparison_token: preview.comparison_token,
      resolution: "normal_consumption",
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      resolution: "normal_consumption",
      entries: [{ final_qty: 7 }, { final_qty: 6 }],
    });

    const stock = await request("/stock", "GET", staff);
    expect((await stock.clone().json() as Array<{ stock: number }>)[0].stock).toBe(7);
    const etag = stock.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect((await api("/stock", { headers: { Authorization: `Bearer ${staff}`, "If-None-Match": etag! } })).status).toBe(304);
  });

  it("rejects writes with a structured retry response during migration", async () => {
    const previous = testEnv.MIGRATION_READ_ONLY;
    Reflect.set(testEnv, "MIGRATION_READ_ONLY", "1");
    try {
      const health = await request("/health");
      expect(health.status).toBe(200);
      const write = await request("/auth/login", "POST", undefined, { username: "admin", pin: "864210" });
      expect(write.status).toBe(503);
      expect(write.headers.get("Retry-After")).toBe("600");
      expect(await write.json()).toMatchObject({ detail: { code: "migration_read_only" } });
    } finally {
      Reflect.set(testEnv, "MIGRATION_READ_ONLY", previous);
    }
  });
});
