type Role = "staff" | "manager" | "admin";

type UserRow = {
  id: number;
  username: string;
  display_name: string;
  pin_hash: string;
  role: Role;
  active: number;
  must_change_pin: number;
  token_version: number;
  created_at: string;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | Record<string, unknown>,
    readonly headers: HeadersInit = {},
  ) {
    super(typeof detail === "string" ? detail : String(detail.message ?? "请求失败"));
  }
}

const encoder = new TextEncoder();
const roles: Record<Role, number> = { staff: 0, manager: 1, admin: 2 };
const pinPattern = /^\d{4,6}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const pinIterations = 100_000;

function nowIso(): string {
  return new Date().toISOString();
}

function businessDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function plusDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysToExpiry(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${businessDate()}T00:00:00Z`)) / 86_400_000);
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

function userOut(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: asBool(row.active),
    must_change_pin: asBool(row.must_change_pin),
    created_at: row.created_at,
  };
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const output = new Headers(headers);
  output.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: output });
}

function migrationReadOnly(request: Request, env: Env): Response | null {
  if (String(env.MIGRATION_READ_ONLY) !== "1" || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  return json(
    { detail: { code: "migration_read_only", message: "系统正在迁移，暂时只读，请稍后重试" } },
    503,
    { "Retry-After": "600" },
  );
}

function cors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (origin === env.ALLOWED_ORIGIN) {
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "请求 JSON 格式无效");
  }
}

function text(value: unknown, field: string, min = 0, max = 255): string {
  if (typeof value !== "string") throw new ApiError(400, `${field}格式无效`);
  const output = value.trim();
  if (output.length < min || output.length > max) throw new ApiError(400, `${field}长度无效`);
  return output;
}

function integer(value: unknown, field: string, min = 0): number {
  if (!Number.isInteger(value) || (value as number) < min) throw new ApiError(400, `${field}格式无效`);
  return value as number;
}

function nullableText(value: unknown, max = 255): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, "文本", 0, max) || null;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: pinIterations },
    key,
    256,
  );
  return `pbkdf2_sha256$${pinIterations}$${Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")}$${Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, iterations, saltHex, expectedHex] = stored.split("$");
  if (kind !== "pbkdf2_sha256" || !iterations || !saltHex || !expectedHex) return false;
  const salt = Uint8Array.from(saltHex.match(/../g) ?? [], (hex) => Number.parseInt(hex, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: Number(iterations) },
    key,
    256,
  ));
  const expected = Uint8Array.from(expectedHex.match(/../g) ?? [], (hex) => Number.parseInt(hex, 16));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  actual.forEach((byte, index) => { diff |= byte ^ expected[index]; });
  return diff === 0;
}

async function tokenKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("TOKEN_SECRET must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createToken(env: Env, user: UserRow): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify({
    uid: user.id,
    ver: user.token_version,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  })));
  const signature = await crypto.subtle.sign("HMAC", await tokenKey(env.TOKEN_SECRET), encoder.encode(payload));
  return `${payload}.${base64Url(signature)}`;
}

async function ensureBootstrap(env: Env): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
  if (existing) return;
  if (!pinPattern.test(env.BOOTSTRAP_ADMIN_PIN)) {
    throw new Error("BOOTSTRAP_ADMIN_PIN must be 4-6 digits");
  }
  const hashed = await hashPin(env.BOOTSTRAP_ADMIN_PIN);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users(username, display_name, pin_hash, role, active, must_change_pin) VALUES('admin', '管理员', ?, 'admin', 1, 1)",
  ).bind(hashed).run();
}

async function authenticate(request: Request, env: Env, minimum: Role = "staff", allowPinChange = false): Promise<UserRow> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new ApiError(401, "未登录");
  const [payload, signature] = authorization.slice(7).split(".");
  if (!payload || !signature) throw new ApiError(401, "Token 无效");
  let token: { uid: number; ver: number; exp: number };
  try {
    const valid = await crypto.subtle.verify("HMAC", await tokenKey(env.TOKEN_SECRET), decodeBase64Url(signature), encoder.encode(payload));
    if (!valid) throw new Error();
    token = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    throw new ApiError(401, "Token 无效");
  }
  if (!Number.isInteger(token.uid) || token.exp <= Math.floor(Date.now() / 1000)) throw new ApiError(401, "Token 已过期");
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token.uid).first<UserRow>();
  if (!user || !asBool(user.active) || user.token_version !== token.ver) throw new ApiError(401, "登录已失效");
  if (roles[user.role] < roles[minimum]) throw new ApiError(403, "权限不足");
  if (asBool(user.must_change_pin) && !allowPinChange) {
    throw new ApiError(403, { code: "pin_change_required", message: "首次使用前请修改 PIN" });
  }
  return user;
}

async function withEtag(request: Request, response: Response): Promise<Response> {
  if (request.method !== "GET" || response.status < 200 || response.status >= 300 || !response.headers.get("Content-Type")?.includes("application/json")) return response;
  const payload = await response.clone().arrayBuffer();
  const digest = base64Url(await crypto.subtle.digest("SHA-256", payload));
  const etag = `"${digest}"`;
  const headers = new Headers(response.headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", "no-cache");
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return new Response(response.body, { status: response.status, headers });
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

async function stockForItem(db: D1Database, itemId: number): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(qty), 0) stock FROM batches WHERE item_id = ?").bind(itemId).first<{ stock: number }>();
  return Number(row?.stock ?? 0);
}

async function itemExists(db: D1Database, itemId: number): Promise<boolean> {
  return Boolean(await db.prepare("SELECT id FROM items WHERE id = ?").bind(itemId).first());
}

function guard(db: D1Database, conditionSql: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO _transaction_guard(value) SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE 0 END`).bind(...values);
}

async function deductStatements(
  env: Env,
  itemId: number,
  qty: number,
  actorId: number,
  operation: string,
  referenceType: string,
  referenceId: number,
  batchId?: number,
): Promise<D1PreparedStatement[]> {
  const query = batchId
    ? env.DB.prepare("SELECT id, qty FROM batches WHERE id = ? AND item_id = ? ORDER BY expiry_date, id").bind(batchId, itemId)
    : env.DB.prepare("SELECT id, qty FROM batches WHERE item_id = ? AND qty > 0 ORDER BY expiry_date, id").bind(itemId);
  const rows = (await query.all<{ id: number; qty: number }>()).results;
  if (rows.reduce((sum, row) => sum + row.qty, 0) < qty) throw new ApiError(409, "库存不足");
  const statements: D1PreparedStatement[] = [
    guard(env.DB, batchId
      ? "COALESCE((SELECT qty FROM batches WHERE id = ? AND item_id = ?), 0) >= ?"
      : "COALESCE((SELECT SUM(qty) FROM batches WHERE item_id = ?), 0) >= ?",
    ...(batchId ? [batchId, itemId, qty] : [itemId, qty])),
  ];
  let remaining = qty;
  for (const row of rows) {
    if (remaining <= 0) break;
    const amount = Math.min(row.qty, remaining);
    statements.push(env.DB.prepare("UPDATE batches SET qty = qty - ? WHERE id = ? AND qty >= ?").bind(amount, row.id, amount));
    statements.push(guard(env.DB, "changes() = 1"));
    statements.push(env.DB.prepare(
      "INSERT INTO stock_movements(item_id, batch_id, delta, operation, reference_type, reference_id, actor_id) VALUES(?, ?, ?, ?, ?, ?, ?)",
    ).bind(itemId, row.id, -amount, operation, referenceType, referenceId, actorId));
    remaining -= amount;
  }
  return statements;
}

async function deductComparisonStatements(
  env: Env,
  itemId: number,
  qty: number,
  actorId: number,
  firstId: number,
  secondId: number,
  confirmedAt: string,
): Promise<D1PreparedStatement[]> {
  const rows = (await env.DB.prepare(
    "SELECT id, qty FROM batches WHERE item_id = ? AND qty > 0 ORDER BY expiry_date, id",
  ).bind(itemId).all<{ id: number; qty: number }>()).results;
  if (rows.reduce((sum, row) => sum + row.qty, 0) < qty) throw new ApiError(409, "库存不足");
  const lookup = "(SELECT id FROM count_comparisons WHERE first_session_id = ? AND second_session_id = ? AND confirmed_by = ? AND confirmed_at = ? ORDER BY id DESC LIMIT 1)";
  const lookupValues = [firstId, secondId, actorId, confirmedAt];
  const statements: D1PreparedStatement[] = [
    guard(env.DB, "COALESCE((SELECT SUM(qty) FROM batches WHERE item_id = ?), 0) >= ?", itemId, qty),
  ];
  let remaining = qty;
  for (const row of rows) {
    if (remaining <= 0) break;
    const amount = Math.min(row.qty, remaining);
    statements.push(env.DB.prepare("UPDATE batches SET qty = qty - ? WHERE id = ? AND qty >= ?").bind(amount, row.id, amount));
    statements.push(guard(env.DB, "changes() = 1"));
    statements.push(env.DB.prepare(
      `INSERT INTO stock_movements(item_id, batch_id, delta, operation, reference_type, reference_id, actor_id)
       VALUES(?, ?, ?, 'count_shortage', 'count_comparison', ${lookup}, ?)`,
    ).bind(itemId, row.id, -amount, ...lookupValues, actorId));
    remaining -= amount;
  }
  return statements;
}

async function serializeItem(env: Env, id: number) {
  const row = await env.DB.prepare(`
    SELECT i.*, COALESCE(SUM(b.qty), 0) stock,
      (SELECT c.created_at FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
       WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
       ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_at,
      (SELECT CASE WHEN c.count_type = 'daily' THEN ce.reported_qty ELSE COALESCE(ce.reviewed_qty, ce.qty_counted) END
       FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
       WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
       ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_qty,
      (SELECT c.count_type FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
       WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
       ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_type,
      (SELECT ce.is_enough FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
       WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
       ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_enough
    FROM items i LEFT JOIN batches b ON b.item_id = i.id
    WHERE i.id = ? GROUP BY i.id
  `).bind(id).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "库存品不存在");
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    shelf_life_days: row.shelf_life_days,
    min_stock: row.min_stock,
    daily_count_enabled: asBool(row.daily_count_enabled),
    weekly_count_enabled: asBool(row.weekly_count_enabled),
    active: asBool(row.active),
    sort_order: row.sort_order,
    stock: Number(row.stock),
    last_count_at: row.last_count_at ?? null,
    last_count_qty: row.last_count_qty === null || row.last_count_qty === undefined ? null : Number(row.last_count_qty),
    last_count_type: row.last_count_type ?? null,
    last_count_enough: row.last_count_enough === null || row.last_count_enough === undefined ? null : asBool(row.last_count_enough),
  };
}

async function serializeWaste(env: Env, id: number) {
  const row = await env.DB.prepare(`
    SELECT w.*, i.name item_name, i.unit, b.expiry_date batch_expiry_date,
           u.display_name reported_by_name
    FROM waste_records w
    JOIN items i ON i.id = w.item_id
    JOIN users u ON u.id = w.reported_by
    LEFT JOIN batches b ON b.id = w.batch_id
    WHERE w.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "报损记录不存在");
  return { ...row, has_photo: false };
}

async function serializePurchase(env: Env, id: number) {
  const purchase = await env.DB.prepare(`
    SELECT p.*, u.display_name created_by_name
    FROM purchases p JOIN users u ON u.id = p.created_by WHERE p.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!purchase) throw new ApiError(404, "采购单不存在");
  const lines = (await env.DB.prepare(`
    SELECT pi.id, pi.item_id, i.name item_name, i.unit, pi.qty
    FROM purchase_items pi JOIN items i ON i.id = pi.item_id
    WHERE pi.purchase_id = ? ORDER BY pi.id
  `).bind(id).all()).results;
  return { ...purchase, items: lines };
}

async function serializeCount(env: Env, id: number, detail = true) {
  const session = await env.DB.prepare(`
    SELECT c.*, cu.display_name created_by_name, COALESCE(vu.display_name, '') verified_by_name
    FROM count_sessions c
    JOIN users cu ON cu.id = c.created_by
    LEFT JOIN users vu ON vu.id = c.verified_by
    WHERE c.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!session) throw new ApiError(404, "盘点单不存在");
  const entries: Array<Record<string, unknown>> = (await env.DB.prepare(`
    SELECT ce.id, ce.item_id, i.name item_name, i.unit, ce.expected_qty,
           ce.qty_counted, ce.qty_counted - ce.expected_qty diff, ce.is_enough,
           ce.reported_qty,
           ce.reviewed_qty, ce.reviewed_qty - ce.qty_counted review_diff,
           COALESCE((SELECT SUM(b.qty) FROM batches b WHERE b.item_id = ce.item_id), 0) current_qty
    FROM count_entries ce JOIN items i ON i.id = ce.item_id
    WHERE ce.session_id = ? ORDER BY ce.id
  `).bind(id).all<Record<string, unknown>>()).results.map((entry): Record<string, unknown> => ({
    ...entry,
    is_enough: entry.is_enough === null ? null : asBool(entry.is_enough),
  }));
  if (detail) return { ...session, entries };
  return {
    ...session,
    entries_count: entries.length,
    difference_count: entries.filter((entry) => entry.reviewed_qty !== null && entry.reviewed_qty !== entry.qty_counted).length,
    enough_count: entries.filter((entry) => entry.is_enough === true).length,
    not_enough_count: entries.filter((entry) => entry.is_enough === false).length,
    quantity_count: entries.filter((entry) => entry.reported_qty !== null).length,
  };
}

async function login(request: Request, env: Env): Promise<Response> {
  await ensureBootstrap(env);
  const input = await body(request);
  const username = text(input.username, "用户名", 1, 64).toLowerCase();
  const pin = text(input.pin, "PIN", 4, 6);
  if (!pinPattern.test(pin)) throw new ApiError(400, "PIN 必须为 4-6 位数字");
  const sourceIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const attempt = await env.DB.prepare(
    "SELECT * FROM login_attempts WHERE username = ? AND source_ip = ?",
  ).bind(username, sourceIp).first<{ locked_until: string | null }>();
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > Date.now()) {
    const seconds = Math.max(1, Math.ceil((Date.parse(attempt.locked_until) - Date.now()) / 1000));
    throw new ApiError(429, "登录尝试过多，请稍后再试", { "Retry-After": String(seconds) });
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
  const valid = Boolean(user && asBool(user.active) && await verifyPin(pin, user.pin_hash));
  if (!valid) {
    const now = nowIso();
    await env.DB.prepare(`
      INSERT INTO login_attempts(username, source_ip, failed_count, window_started_at, locked_until)
      VALUES(?, ?, 1, ?, NULL)
      ON CONFLICT(username, source_ip) DO UPDATE SET
        failed_count = CASE WHEN unixepoch(excluded.window_started_at) - unixepoch(window_started_at) > 600 THEN 1 ELSE failed_count + 1 END,
        window_started_at = CASE WHEN unixepoch(excluded.window_started_at) - unixepoch(window_started_at) > 600 THEN excluded.window_started_at ELSE window_started_at END,
        locked_until = CASE
          WHEN unixepoch(excluded.window_started_at) - unixepoch(window_started_at) <= 600 AND failed_count + 1 >= 5
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', excluded.window_started_at, '+15 minutes')
          ELSE NULL END
    `).bind(username, sourceIp, now).run();
    const updated = await env.DB.prepare(
      "SELECT locked_until FROM login_attempts WHERE username = ? AND source_ip = ?",
    ).bind(username, sourceIp).first<{ locked_until: string | null }>();
    if (updated?.locked_until) throw new ApiError(429, "登录尝试过多，请稍后再试", { "Retry-After": "900" });
    throw new ApiError(401, "用户名或 PIN 错误");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE username = ? AND source_ip = ?").bind(username, sourceIp).run();
  return json({ token: await createToken(env, user!), user: userOut(user!) });
}

async function authRoutes(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/auth/login-options") {
    await ensureBootstrap(env);
    const users = (await env.DB.prepare("SELECT * FROM users WHERE active = 1 ORDER BY id").all<UserRow>()).results;
    return json({ users: users.map(userOut) });
  }
  if (request.method === "POST" && pathname === "/api/auth/login") return login(request, env);
  if (request.method === "GET" && pathname === "/api/auth/me") {
    return json(userOut(await authenticate(request, env, "staff", true)));
  }
  if (request.method === "POST" && pathname === "/api/auth/change-pin") {
    const user = await authenticate(request, env, "staff", true);
    const input = await body(request);
    const current = text(input.current_pin, "当前 PIN", 4, 6);
    const next = text(input.new_pin, "新 PIN", 4, 6);
    if (!pinPattern.test(current) || !pinPattern.test(next)) throw new ApiError(400, "PIN 必须为 4-6 位数字");
    if (!await verifyPin(current, user.pin_hash)) throw new ApiError(400, "当前 PIN 错误");
    if (current === next) throw new ApiError(400, "新 PIN 不能与当前 PIN 相同");
    const pinHash = await hashPin(next);
    await env.DB.prepare("UPDATE users SET pin_hash = ?, must_change_pin = 0, token_version = token_version + 1 WHERE id = ?").bind(pinHash, user.id).run();
    const updated = (await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>())!;
    return json({ token: await createToken(env, updated), user: userOut(updated) });
  }
  return null;
}

async function userRoutes(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/users")) return null;
  const admin = await authenticate(request, env, "admin");
  if (request.method === "GET" && pathname === "/api/users") {
    const rows = (await env.DB.prepare("SELECT * FROM users ORDER BY id").all<UserRow>()).results;
    return json(rows.map(userOut));
  }
  if (request.method === "POST" && pathname === "/api/users") {
    const input = await body(request);
    const username = text(input.username, "用户名", 1, 64).toLowerCase();
    const displayName = text(input.display_name, "显示名称", 1, 128);
    const pin = text(input.pin, "PIN", 4, 6);
    const role = input.role === undefined ? "staff" : String(input.role) as Role;
    if (!pinPattern.test(pin)) throw new ApiError(400, "PIN 必须为 4-6 位数字");
    if (!(role in roles)) throw new ApiError(400, "角色无效");
    try {
      const result = await env.DB.prepare(
        "INSERT INTO users(username, display_name, pin_hash, role, active, must_change_pin) VALUES(?, ?, ?, ?, 1, 1)",
      ).bind(username, displayName, await hashPin(pin), role).run();
      return json(userOut((await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(result.meta.last_row_id).first<UserRow>())!), 201);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError(409, "用户名已存在");
      throw error;
    }
  }
  const match = pathname.match(/^\/api\/users\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    const id = Number(match[1]);
    const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
    if (!target) throw new ApiError(404, "用户不存在");
    const input = await body(request);
    if (id === admin.id && (input.active === false || input.role !== undefined)) throw new ApiError(400, "不能停用自己或修改自己的角色");
    const sets: string[] = [];
    const values: unknown[] = [];
    let revoke = false;
    let nextUsername: string | null = null;
    if (input.username !== undefined) {
      nextUsername = text(input.username, "用户名", 1, 64).toLowerCase();
      sets.push("username = ?"); values.push(nextUsername);
      revoke ||= nextUsername !== target.username;
    }
    if (input.display_name !== undefined) { sets.push("display_name = ?"); values.push(text(input.display_name, "显示名称", 1, 128)); }
    if (input.role !== undefined) {
      const role = String(input.role) as Role;
      if (!(role in roles)) throw new ApiError(400, "角色无效");
      sets.push("role = ?"); values.push(role); revoke ||= role !== target.role;
    }
    if (input.active !== undefined) { sets.push("active = ?"); values.push(input.active ? 1 : 0); revoke ||= asBool(input.active) !== asBool(target.active); }
    if (input.pin !== undefined) {
      const pin = text(input.pin, "PIN", 4, 6);
      if (!pinPattern.test(pin)) throw new ApiError(400, "PIN 必须为 4-6 位数字");
      sets.push("pin_hash = ?", "must_change_pin = 1"); values.push(await hashPin(pin)); revoke = true;
    }
    if (revoke) sets.push("token_version = token_version + 1");
    if (sets.length) {
      try {
        await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
      } catch (error) {
        if (isUniqueError(error)) throw new ApiError(409, "用户名已存在");
        throw error;
      }
    }
    if (nextUsername !== null && nextUsername !== target.username) {
      await env.DB.prepare("DELETE FROM login_attempts WHERE username IN (?, ?)").bind(target.username, nextUsername).run();
    }
    return json(userOut((await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>())!));
  }
  throw new ApiError(405, "方法不允许");
}

async function itemRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/items")) return null;
  if (request.method === "GET" && pathname === "/api/items") {
    await authenticate(request, env);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const query = `
      SELECT i.*, COALESCE(SUM(b.qty), 0) stock,
        (SELECT c.created_at FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
         WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
         ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_at,
        (SELECT CASE WHEN c.count_type = 'daily' THEN ce.reported_qty ELSE COALESCE(ce.reviewed_qty, ce.qty_counted) END
         FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
         WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
         ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_qty,
        (SELECT c.count_type FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
         WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
         ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_type,
        (SELECT ce.is_enough FROM count_entries ce JOIN count_sessions c ON c.id = ce.session_id
         WHERE ce.item_id = i.id AND ((c.count_type = 'daily' AND c.status = 'completed') OR (c.count_type = 'weekly' AND c.status = 'verified'))
         ORDER BY datetime(c.created_at) DESC, c.id DESC, ce.id DESC LIMIT 1) last_count_enough
      FROM items i LEFT JOIN batches b ON b.item_id = i.id
      ${includeInactive ? "" : "WHERE i.active = 1"}
      GROUP BY i.id ORDER BY i.sort_order, i.id`;
    const rows = (await env.DB.prepare(query).all<Record<string, unknown>>()).results.map((row) => ({
      id: row.id, name: row.name, category: row.category, unit: row.unit,
      shelf_life_days: row.shelf_life_days, min_stock: row.min_stock,
      daily_count_enabled: asBool(row.daily_count_enabled), weekly_count_enabled: asBool(row.weekly_count_enabled),
      active: asBool(row.active), sort_order: row.sort_order, stock: Number(row.stock),
      last_count_at: row.last_count_at ?? null,
      last_count_qty: row.last_count_qty === null || row.last_count_qty === undefined ? null : Number(row.last_count_qty),
      last_count_type: row.last_count_type ?? null,
      last_count_enough: row.last_count_enough === null || row.last_count_enough === undefined ? null : asBool(row.last_count_enough),
    }));
    return json(rows);
  }
  if (request.method === "POST" && pathname === "/api/items") {
    await authenticate(request, env, "manager");
    const input = await body(request);
    const values = {
      name: text(input.name, "库存品名称", 1, 128),
      category: input.category === undefined ? "" : text(input.category, "分类", 0, 64),
      unit: input.unit === undefined ? "个" : text(input.unit, "单位", 1, 16),
      shelf: input.shelf_life_days === undefined ? 7 : integer(input.shelf_life_days, "保质期", 1),
      minimum: input.min_stock === undefined ? 0 : integer(input.min_stock, "安全线", 0),
      dailyCount: input.daily_count_enabled === undefined ? 1 : (input.daily_count_enabled ? 1 : 0),
      weeklyCount: input.weekly_count_enabled === undefined ? 1 : (input.weekly_count_enabled ? 1 : 0),
      order: input.sort_order === undefined ? 0 : integer(input.sort_order, "排序", -2_147_483_648),
    };
    try {
      const result = await env.DB.prepare(`
        INSERT INTO items(name, category, unit, shelf_life_days, min_stock, daily_count_enabled, weekly_count_enabled, sort_order)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(values.name, values.category, values.unit, values.shelf, values.minimum, values.dailyCount, values.weeklyCount, values.order).run();
      return json(await serializeItem(env, Number(result.meta.last_row_id)), 201);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError(409, "库存品名称已存在");
      throw error;
    }
  }
  const item = pathname.match(/^\/api\/items\/(\d+)$/);
  if (request.method === "PATCH" && item) {
    await authenticate(request, env, "manager");
    const id = Number(item[1]);
    if (!await itemExists(env.DB, id)) throw new ApiError(404, "库存品不存在");
    const input = await body(request);
    const sets: string[] = [];
    const values: unknown[] = [];
    const fields: Array<[string, string, (value: unknown) => unknown]> = [
      ["name", "name", (value) => text(value, "库存品名称", 1, 128)],
      ["category", "category", (value) => text(value, "分类", 0, 64)],
      ["unit", "unit", (value) => text(value, "单位", 1, 16)],
      ["shelf_life_days", "shelf_life_days", (value) => integer(value, "保质期", 1)],
      ["min_stock", "min_stock", (value) => integer(value, "安全线", 0)],
      ["daily_count_enabled", "daily_count_enabled", (value) => value ? 1 : 0],
      ["weekly_count_enabled", "weekly_count_enabled", (value) => value ? 1 : 0],
      ["sort_order", "sort_order", (value) => integer(value, "排序", -2_147_483_648)],
      ["active", "active", (value) => value ? 1 : 0],
    ];
    for (const [key, column, parse] of fields) {
      if (input[key] !== undefined) { sets.push(`${column} = ?`); values.push(parse(input[key])); }
    }
    try {
      if (sets.length) await env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError(409, "库存品名称已存在");
      throw error;
    }
    return json(await serializeItem(env, id));
  }
  const batches = pathname.match(/^\/api\/items\/(\d+)\/batches$/);
  if (request.method === "GET" && batches) {
    await authenticate(request, env);
    const id = Number(batches[1]);
    if (!await itemExists(env.DB, id)) throw new ApiError(404, "库存品不存在");
    const rows = (await env.DB.prepare("SELECT * FROM batches WHERE item_id = ? ORDER BY expiry_date, id").bind(id).all<Record<string, unknown>>()).results;
    return json(rows.map((row) => ({ ...row, days_to_expiry: daysToExpiry(String(row.expiry_date)) })));
  }
  const movements = pathname.match(/^\/api\/items\/(\d+)\/movements$/);
  if (request.method === "GET" && movements) {
    await authenticate(request, env, "manager");
    const id = Number(movements[1]);
    if (!await itemExists(env.DB, id)) throw new ApiError(404, "库存品不存在");
    const rows = (await env.DB.prepare(`
      SELECT sm.*, u.display_name actor_name FROM stock_movements sm
      JOIN users u ON u.id = sm.actor_id WHERE sm.item_id = ? ORDER BY sm.id DESC
    `).bind(id).all()).results;
    return json(rows);
  }
  throw new ApiError(405, "方法不允许");
}

async function stockRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/stock") {
    await authenticate(request, env);
    const rows = (await env.DB.prepare(`
      SELECT i.id, i.name, i.category, i.unit, i.shelf_life_days, i.min_stock,
             i.daily_count_enabled, i.weekly_count_enabled, i.active,
             COALESCE(SUM(CASE WHEN b.qty > 0 THEN b.qty ELSE 0 END), 0) stock,
             MIN(CASE WHEN b.qty > 0 THEN b.expiry_date END) nearest_expiry,
             COUNT(CASE WHEN b.qty > 0 THEN 1 END) batch_count
      FROM items i LEFT JOIN batches b ON b.item_id = i.id
      WHERE i.active = 1 GROUP BY i.id ORDER BY i.sort_order, i.id
    `).all<Record<string, unknown>>()).results;
    return json(rows.map((row) => ({
      item: { id: row.id, name: row.name, category: row.category, unit: row.unit,
        shelf_life_days: row.shelf_life_days, min_stock: row.min_stock,
        daily_count_enabled: asBool(row.daily_count_enabled), weekly_count_enabled: asBool(row.weekly_count_enabled), active: true },
      stock: Number(row.stock), nearest_expiry: row.nearest_expiry, batch_count: Number(row.batch_count),
    })));
  }
  if (request.method === "GET" && url.pathname === "/api/expiry") {
    await authenticate(request, env);
    const days = Number(url.searchParams.get("days") ?? "3");
    if (!Number.isInteger(days) || days < 0) throw new ApiError(400, "天数格式无效");
    const rows = (await env.DB.prepare(`
      SELECT b.id batch_id, b.item_id, i.name item_name, i.unit, b.qty, b.expiry_date
      FROM batches b JOIN items i ON i.id = b.item_id
      WHERE b.qty > 0 AND b.expiry_date <= ? ORDER BY b.expiry_date, b.id
    `).bind(plusDays(businessDate(), days)).all<Record<string, unknown>>()).results;
    return json(rows.map((row) => ({ ...row, days_to_expiry: daysToExpiry(String(row.expiry_date)) })));
  }
  return null;
}

type CountInput = { item_id: number; qty?: number; enough?: boolean };
type CountReviewInput = { item_id: number; qty: number; expected_current_qty?: number };

function countEntries(value: unknown): CountInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "盘点条目不能为空");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "盘点条目格式无效");
    const entry = raw as Record<string, unknown>;
    return {
      item_id: integer(entry.item_id, "库存品", 1),
      ...(entry.qty === undefined || entry.qty === null ? {} : { qty: integer(entry.qty, "盘点数量", 0) }),
      ...(entry.enough === undefined || entry.enough === null ? {} : { enough: Boolean(entry.enough) }),
    };
  });
}

function countReviewEntries(value: unknown): CountReviewInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "核对条目不能为空");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "核对条目格式无效");
    const entry = raw as Record<string, unknown>;
    return {
      item_id: integer(entry.item_id, "库存品", 1),
      qty: integer(entry.qty, "核对数量", 0),
      ...(entry.expected_current_qty === undefined || entry.expected_current_qty === null
        ? {}
        : { expected_current_qty: integer(entry.expected_current_qty, "当前库存快照", 0) }),
    };
  });
}

async function countRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/counts")) return null;
  if (request.method === "POST" && pathname === "/api/counts") {
    const user = await authenticate(request, env);
    const input = await body(request);
    const countType = input.count_type === undefined ? "weekly" : String(input.count_type);
    if (countType !== "daily" && countType !== "weekly") throw new ApiError(400, "盘点类型无效");
    if (countType === "weekly" && user.role === "admin") throw new ApiError(403, "管理员不提交每周盘点");
    const entries = countEntries(input.entries);
    const ids = entries.map((entry) => entry.item_id);
    if (new Set(ids).size !== ids.length) throw new ApiError(400, "盘点条目重复");
    for (const entry of entries) {
      if (!await itemExists(env.DB, entry.item_id)) throw new ApiError(400, `库存品不存在：${entry.item_id}`);
      const scope = await env.DB.prepare("SELECT name, daily_count_enabled, weekly_count_enabled FROM items WHERE id = ?").bind(entry.item_id).first<{ name: string; daily_count_enabled: number; weekly_count_enabled: number }>();
      if (countType === "daily" && !asBool(scope!.daily_count_enabled)) throw new ApiError(400, `库存品未启用每日盘点：${scope!.name}`);
      if (countType === "weekly" && !asBool(scope!.weekly_count_enabled)) throw new ApiError(400, `库存品未启用每周盘点：${scope!.name}`);
      if (countType === "daily" && entry.enough === undefined) throw new ApiError(400, "每日盘点必须确认够或不够");
      if (countType === "daily" && entry.enough === false && entry.qty === undefined) throw new ApiError(400, "每日盘点选择不够时必须填写现场数量");
      if (countType === "weekly" && entry.qty === undefined) throw new ApiError(400, "每周盘点必须填写盘点数量");
      if (countType === "weekly" && entry.enough !== undefined) throw new ApiError(400, "每周盘点必须填写实际数量");
    }
    const date = countType === "daily" ? businessDate() : null;
    let id: number | null = null;
    if (date) {
      const existing = await env.DB.prepare(
        "SELECT id FROM count_sessions WHERE count_type = 'daily' AND business_date = ? AND status = 'completed'",
      ).bind(date).first<{ id: number }>();
      if (existing && input.overwrite_daily !== true) {
        const old = (await env.DB.prepare("SELECT item_id, is_enough, reported_qty FROM count_entries WHERE session_id = ?").bind(existing.id).all<{ item_id: number; is_enough: number; reported_qty: number | null }>()).results;
        const previous = new Map(old.map((entry) => [entry.item_id, { enough: asBool(entry.is_enough), qty: entry.reported_qty }]));
        const incoming = new Map(entries.map((entry) => [entry.item_id, { enough: entry.enough!, qty: entry.qty ?? null }]));
        const changes: Record<string, unknown>[] = [];
        for (const itemId of new Set([...previous.keys(), ...incoming.keys()])) {
          const before = previous.get(itemId) ?? { enough: null, qty: null };
          const after = incoming.get(itemId) ?? { enough: null, qty: null };
          if (before.enough !== after.enough || before.qty !== after.qty) {
            const item = await env.DB.prepare("SELECT name FROM items WHERE id = ?").bind(itemId).first<{ name: string }>();
            changes.push({ item_id: itemId, item_name: item?.name ?? `商品#${itemId}`, previous_enough: before.enough, new_enough: after.enough, previous_qty: before.qty, new_qty: after.qty });
          }
        }
        throw new ApiError(409, { code: "daily_count_exists", message: "今日已有每日盘点结果", count_id: existing.id, changes, unchanged_count: entries.length - changes.length });
      }
      id = existing?.id ?? null;
    }
    const snapshots = new Map<number, number>();
    for (const entry of entries) snapshots.set(entry.item_id, await stockForItem(env.DB, entry.item_id));
    const note = nullableText(input.note, 255);
    if (id !== null) {
      const statements: D1PreparedStatement[] = [
        env.DB.prepare("DELETE FROM count_entries WHERE session_id = ?").bind(id),
        env.DB.prepare("UPDATE count_sessions SET created_by = ?, created_at = ?, note = ? WHERE id = ?").bind(user.id, nowIso(), note, id),
        ...entries.map((entry) => env.DB.prepare(`
          INSERT INTO count_entries(session_id, item_id, qty_counted, expected_qty, is_enough, reported_qty)
          VALUES(?, ?, ?, ?, ?, ?)
        `).bind(id, entry.item_id, countType === "daily" ? snapshots.get(entry.item_id)! : entry.qty!, snapshots.get(entry.item_id)!, countType === "daily" ? (entry.enough ? 1 : 0) : null, countType === "daily" ? (entry.qty ?? null) : null)),
      ];
      await env.DB.batch(statements);
    } else {
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`
          INSERT INTO count_sessions(count_type, business_date, status, created_by, note)
          VALUES(?, ?, ?, ?, ?)
        `).bind(countType, date, countType === "daily" ? "completed" : "submitted", user.id, note),
        ...entries.map((entry) => env.DB.prepare(`
          INSERT INTO count_entries(session_id, item_id, qty_counted, expected_qty, is_enough, reported_qty)
          VALUES((SELECT seq FROM sqlite_sequence WHERE name = 'count_sessions'), ?, ?, ?, ?, ?)
        `).bind(entry.item_id, countType === "daily" ? snapshots.get(entry.item_id)! : entry.qty!, snapshots.get(entry.item_id)!, countType === "daily" ? (entry.enough ? 1 : 0) : null, countType === "daily" ? (entry.qty ?? null) : null)),
      ];
      const results = await env.DB.batch(statements);
      id = Number(results[0].meta.last_row_id);
    }
    return json(await serializeCount(env, id), 201);
  }
  if (request.method === "GET" && pathname === "/api/counts") {
    const user = await authenticate(request, env);
    const where: string[] = [];
    const values: Array<string | number> = [];
    const status = url.searchParams.get("status");
    const countType = url.searchParams.get("count_type");
    const daysRaw = url.searchParams.get("days");
    if (status) { where.push("status = ?"); values.push(status); }
    if (countType) {
      if (countType !== "daily" && countType !== "weekly") throw new ApiError(400, "盘点类型无效");
      where.push("count_type = ?"); values.push(countType);
    }
    if (daysRaw) {
      const days = integer(daysRaw, "days", 1);
      if (days > 30) throw new ApiError(400, "days 必须在 1 到 30 之间");
      where.push("datetime(created_at) >= datetime('now', ?)");
      values.push(`-${days} days`);
    }
    if (user.role === "staff") {
      where.push("(count_type <> 'weekly' OR created_by = ?)");
      values.push(user.id);
    }
    const sessions = (await env.DB.prepare(`SELECT id FROM count_sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`).bind(...values).all<{ id: number }>()).results;
    return json(await Promise.all(sessions.map((session) => serializeCount(env, session.id, false))));
  }
  const detail = pathname.match(/^\/api\/counts\/(\d+)$/);
  if (request.method === "PATCH" && detail) {
    const user = await authenticate(request, env);
    const id = Number(detail[1]);
    const session = await env.DB.prepare("SELECT count_type, status, created_by FROM count_sessions WHERE id = ?").bind(id).first<{ count_type: string; status: string; created_by: number }>();
    if (!session) throw new ApiError(404, "盘点单不存在");
    if (session.count_type !== "weekly") throw new ApiError(409, "每日盘点不支持此方式修改");
    if (session.created_by !== user.id) throw new ApiError(403, "只能修改自己提交的盘点单");
    if (session.status !== "submitted") throw new ApiError(409, "盘点单已核对或驳回，不能修改");
    const input = await body(request);
    const entries = countEntries(input.entries);
    if (entries.some((entry) => entry.qty === undefined || entry.enough !== undefined)) throw new ApiError(400, "每周盘点必须填写实际数量");
    const incoming = new Map(entries.map((entry) => [entry.item_id, entry.qty!]));
    if (incoming.size !== entries.length) throw new ApiError(400, "盘点条目重复");
    const existing = (await env.DB.prepare("SELECT item_id FROM count_entries WHERE session_id = ?").bind(id).all<{ item_id: number }>()).results;
    if (existing.some((entry) => !incoming.has(entry.item_id))) throw new ApiError(400, "修改不能删除原盘点条目");
    const existingIds = new Set(existing.map((entry) => entry.item_id));
    for (const itemId of incoming.keys()) {
      if (existingIds.has(itemId)) continue;
      const item = await env.DB.prepare("SELECT name, active, weekly_count_enabled FROM items WHERE id = ?").bind(itemId).first<{ name: string; active: number; weekly_count_enabled: number }>();
      if (!item || !asBool(item.active)) throw new ApiError(400, `库存品不存在或已停用：${itemId}`);
      if (!asBool(item.weekly_count_enabled)) throw new ApiError(400, `库存品未启用每周盘点：${item.name}`);
    }
    const snapshots = new Map<number, number>();
    for (const itemId of incoming.keys()) snapshots.set(itemId, await stockForItem(env.DB, itemId));
    const note = nullableText(input.note, 255);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE count_sessions SET created_at = ?, note = ? WHERE id = ? AND status = 'submitted' AND created_by = ?").bind(nowIso(), note, id, user.id),
      guard(env.DB, "changes() = 1"),
    ];
    for (const [itemId, qty] of incoming) {
      if (existingIds.has(itemId)) {
        statements.push(env.DB.prepare("UPDATE count_entries SET qty_counted = ?, expected_qty = ?, reviewed_qty = NULL WHERE session_id = ? AND item_id = ?").bind(qty, snapshots.get(itemId)!, id, itemId));
        statements.push(guard(env.DB, "changes() = 1"));
      } else {
        statements.push(env.DB.prepare("INSERT INTO count_entries(session_id, item_id, qty_counted, expected_qty, is_enough, reported_qty, reviewed_qty) VALUES(?, ?, ?, ?, NULL, NULL, NULL)").bind(id, itemId, qty, snapshots.get(itemId)!));
        statements.push(guard(env.DB, "changes() = 1"));
      }
    }
    statements.push(env.DB.prepare("DELETE FROM _transaction_guard"));
    try { await env.DB.batch(statements); } catch {
      throw new ApiError(409, "盘点单状态或明细已变化，请刷新");
    }
    return json(await serializeCount(env, id));
  }
  if (request.method === "GET" && detail) {
    const user = await authenticate(request, env);
    const id = Number(detail[1]);
    const session = await env.DB.prepare("SELECT count_type, created_by FROM count_sessions WHERE id = ?").bind(id).first<{ count_type: string; created_by: number }>();
    if (!session) throw new ApiError(404, "盘点单不存在");
    if (session.count_type === "weekly" && user.role === "staff" && session.created_by !== user.id) throw new ApiError(403, "只能查看自己提交的盘点单");
    return json(await serializeCount(env, id));
  }
  const action = pathname.match(/^\/api\/counts\/(\d+)\/(verify|reject)$/);
  if (request.method === "POST" && action) {
    const manager = await authenticate(request, env, "manager");
    const id = Number(action[1]);
    const session = await env.DB.prepare("SELECT * FROM count_sessions WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!session) throw new ApiError(404, "盘点单不存在");
    if (session.count_type !== "weekly") throw new ApiError(409, action[2] === "verify" ? "每日盘点无需核对" : "每日盘点无需驳回");
    if (session.status !== "submitted") throw new ApiError(409, "该盘点单已处理");
    if (action[2] === "reject") {
      throw new ApiError(409, { code: "pair_verification_required", message: "请在双人比对中同时退回两份记录重盘" });
    }
    throw new ApiError(409, {
      code: "pair_verification_required",
      message: "每周盘点必须选择两份独立记录进行比对确认",
    });
    /* 旧版单人核对代码仅保留用于读取历史数据，不再允许创建新记录。
    if (Number(session.created_by) === manager.id) {
      throw new ApiError(409, { code: "self_review_not_allowed", message: "盘点提交人不能核对自己的盘点单" });
    }
    const input = await body(request);
    const reviewEntries = countReviewEntries(input.entries);
    const reviewByItem = new Map(reviewEntries.map((entry) => [entry.item_id, entry]));
    if (reviewByItem.size !== reviewEntries.length) throw new ApiError(400, "核对条目重复");
    const entries = (await env.DB.prepare("SELECT * FROM count_entries WHERE session_id = ? ORDER BY id").bind(id).all<{ item_id: number; expected_qty: number; qty_counted: number }>()).results;
    if (reviewByItem.size !== entries.length || entries.some((entry) => !reviewByItem.has(entry.item_id))) {
      throw new ApiError(400, "核对必须逐项录入该盘点单的全部库存品");
    }
    const conflicts: Record<string, unknown>[] = [];
    const differences: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const review = reviewByItem.get(entry.item_id)!;
      const current = await stockForItem(env.DB, entry.item_id);
      const item = await env.DB.prepare("SELECT name FROM items WHERE id = ?").bind(entry.item_id).first<{ name: string }>();
      if (review.expected_current_qty !== undefined && current !== review.expected_current_qty) {
        conflicts.push({ item_id: entry.item_id, item_name: item?.name ?? "?", expected_qty: review.expected_current_qty, current_qty: current });
      }
      if (review.qty !== entry.qty_counted) {
        differences.push({ item_id: entry.item_id, item_name: item?.name ?? "?", submitted_qty: entry.qty_counted, reviewed_qty: review.qty, diff: review.qty - entry.qty_counted });
      }
    }
    if (conflicts.length) throw new ApiError(409, { code: "stock_changed", message: "核对录入期间库存发生变化，请刷新后重新核对", items: conflicts });
    const differenceReason = input.difference_reason === undefined || input.difference_reason === null ? null : String(input.difference_reason);
    if (differenceReason !== null && differenceReason !== "normal_consumption" && differenceReason !== "recount_corrected") throw new ApiError(400, "差异原因无效");
    if (differences.length && !differenceReason) throw new ApiError(409, { code: "count_difference", message: "两次盘点存在差异，请确认是否为正常消耗；否则重新盘点并录入", items: differences });
    const reviewNote = nullableText(input.difference_note, 255);
    if (differences.length && differenceReason === "recount_corrected" && !reviewNote) throw new ApiError(400, "非正常消耗差异重新盘点后必须填写差异说明");
    const finalReason = differences.length ? differenceReason : "no_difference";
    const statements: D1PreparedStatement[] = [];
    for (const entry of entries) {
      const review = reviewByItem.get(entry.item_id)!;
      if (review.expected_current_qty !== undefined) statements.push(guard(env.DB, "COALESCE((SELECT SUM(qty) FROM batches WHERE item_id = ?), 0) = ?", entry.item_id, review.expected_current_qty));
    }
    statements.push(env.DB.prepare("UPDATE count_sessions SET status = 'verified', verified_by = ?, verified_at = ?, review_reason = ?, review_note = ? WHERE id = ? AND status = 'submitted'").bind(manager.id, nowIso(), finalReason, reviewNote, id));
    statements.push(guard(env.DB, "changes() = 1"));
    for (const entry of entries) {
      const review = reviewByItem.get(entry.item_id)!;
      const current = await stockForItem(env.DB, entry.item_id);
      const diff = review.qty - current;
      statements.push(env.DB.prepare("UPDATE count_entries SET reviewed_qty = ? WHERE session_id = ? AND item_id = ?").bind(review.qty, id, entry.item_id));
      if (diff < 0) statements.push(...await deductStatements(env, entry.item_id, -diff, manager.id, "count_shortage", "count", id));
      if (diff > 0) {
        const item = await env.DB.prepare("SELECT shelf_life_days FROM items WHERE id = ?").bind(entry.item_id).first<{ shelf_life_days: number }>();
        statements.push(env.DB.prepare("INSERT INTO batches(item_id, qty, initial_qty, expiry_date, source, note) VALUES(?, ?, ?, ?, 'adjust', '盘盈')").bind(entry.item_id, diff, diff, plusDays(businessDate(), item!.shelf_life_days)));
        statements.push(env.DB.prepare("INSERT INTO stock_movements(item_id, batch_id, delta, operation, reference_type, reference_id, actor_id) VALUES(?, last_insert_rowid(), ?, 'count_surplus', 'count', ?, ?)").bind(entry.item_id, diff, id, manager.id));
      }
    }
    statements.push(env.DB.prepare("DELETE FROM _transaction_guard"));
    try { await env.DB.batch(statements); } catch (error) {
      console.error(JSON.stringify({ event: "count_verify_failed", count_id: id, error: String(error) }));
      throw new ApiError(409, "库存发生并发变化，请重新盘点");
    }
    return json(await serializeCount(env, id)); */
  }
  throw new ApiError(405, "方法不允许");
}

type PairSession = {
  id: number;
  count_type: string;
  status: string;
  created_by: number;
  created_at: string;
  note: string | null;
  comparison_id: number | null;
  created_by_name: string;
  creator_role: Role;
};

type PairRow = {
  item_id: number;
  item_name: string;
  unit: string;
  first_qty: number | null;
  second_qty: number | null;
  current_qty: number;
  result: "same" | "different" | "missing_first" | "missing_second";
};

type PairState = {
  first: PairSession;
  second: PairSession;
  later_count_id: number;
  shared_count: number;
  different_count: number;
  missing_count: number;
  entries: PairRow[];
  comparison_token: string;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pairState(env: Env, firstId: number, secondId: number, actor: UserRow): Promise<PairState> {
  if (firstId === secondId) throw new ApiError(400, "请选择两份不同的盘点记录");
  const load = (id: number) => env.DB.prepare(`
    SELECT c.*, u.display_name created_by_name, u.role creator_role
    FROM count_sessions c JOIN users u ON u.id = c.created_by WHERE c.id = ?
  `).bind(id).first<PairSession>();
  const first = await load(firstId);
  const second = await load(secondId);
  if (!first || !second) throw new ApiError(404, "盘点记录不存在");
  for (const session of [first, second]) {
    if (session.count_type !== "weekly") throw new ApiError(400, "只能比对每周盘点记录");
    if (session.status !== "submitted" || session.comparison_id !== null) {
      throw new ApiError(409, { code: "count_already_processed", message: "盘点记录已处理" });
    }
    if (Date.parse(session.created_at) < Date.now() - 72 * 60 * 60 * 1000) {
      throw new ApiError(400, "只能选择近72小时的盘点记录");
    }
    if (session.creator_role !== "staff" && session.creator_role !== "manager") {
      throw new ApiError(400, "盘点提交人身份不符合要求");
    }
  }
  if (first.created_by === second.created_by) throw new ApiError(400, "两份记录必须由不同人员独立提交");
  if (actor.id === first.created_by || actor.id === second.created_by) {
    throw new ApiError(409, { code: "self_review_not_allowed", message: "确认人不能是任一盘点提交人" });
  }
  const rows = (await env.DB.prepare(`
    WITH pair_items AS (
      SELECT item_id FROM count_entries WHERE session_id = ?
      UNION SELECT item_id FROM count_entries WHERE session_id = ?
    )
    SELECT p.item_id, i.name item_name, i.unit,
      a.qty_counted first_qty, b.qty_counted second_qty,
      COALESCE((SELECT SUM(qty) FROM batches WHERE item_id = p.item_id), 0) current_qty
    FROM pair_items p JOIN items i ON i.id = p.item_id
    LEFT JOIN count_entries a ON a.session_id = ? AND a.item_id = p.item_id
    LEFT JOIN count_entries b ON b.session_id = ? AND b.item_id = p.item_id
    ORDER BY p.item_id
  `).bind(firstId, secondId, firstId, secondId).all<Omit<PairRow, "result">>()).results.map((row): PairRow => ({
    ...row,
    first_qty: row.first_qty === null ? null : Number(row.first_qty),
    second_qty: row.second_qty === null ? null : Number(row.second_qty),
    current_qty: Number(row.current_qty),
    result: row.first_qty === null ? "missing_first" : row.second_qty === null ? "missing_second" :
      Number(row.first_qty) === Number(row.second_qty) ? "same" : "different",
  }));
  const shared = rows.filter((row) => row.first_qty !== null && row.second_qty !== null);
  if (!shared.length) throw new ApiError(400, { code: "no_comparable_items", message: "两份记录没有共同库存品，无法比对" });
  const token = await sha256Hex(JSON.stringify({
    sessions: [[first.id, first.status, first.created_at, first.comparison_id], [second.id, second.status, second.created_at, second.comparison_id]],
    rows: rows.map((row) => [row.item_id, row.first_qty, row.second_qty, row.current_qty]),
  }));
  const later = Date.parse(second.created_at) > Date.parse(first.created_at) ||
    (Date.parse(second.created_at) === Date.parse(first.created_at) && second.id > first.id) ? second : first;
  return {
    first, second, later_count_id: later.id, shared_count: shared.length,
    different_count: rows.filter((row) => row.result === "different").length,
    missing_count: rows.filter((row) => row.result.startsWith("missing_")).length,
    entries: rows, comparison_token: token,
  };
}

async function comparisonDetail(env: Env, id: number) {
  const comparison = await env.DB.prepare(`
    SELECT c.*, u.display_name confirmed_by_name FROM count_comparisons c
    JOIN users u ON u.id = c.confirmed_by WHERE c.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!comparison) throw new ApiError(404, "盘点比对不存在");
  const entries = (await env.DB.prepare(`
    SELECT e.item_id, i.name item_name, i.unit, e.first_qty, e.second_qty, e.final_qty, e.result
    FROM count_comparison_entries e JOIN items i ON i.id = e.item_id
    WHERE e.comparison_id = ? ORDER BY e.id
  `).bind(id).all()).results;
  return {
    id: comparison.id, first_count_id: comparison.first_session_id,
    second_count_id: comparison.second_session_id, resolution: comparison.resolution,
    trusted_count_id: comparison.trusted_session_id, note: comparison.note,
    confirmed_by: comparison.confirmed_by, confirmed_by_name: comparison.confirmed_by_name,
    confirmed_at: comparison.confirmed_at, entries,
  };
}

async function countComparisonRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/count-comparisons")) return null;
  const actor = await authenticate(request, env, "manager");
  const detail = url.pathname.match(/^\/api\/count-comparisons\/(\d+)$/);
  if (request.method === "GET" && detail) return json(await comparisonDetail(env, Number(detail[1])));
  if (request.method !== "POST" || (url.pathname !== "/api/count-comparisons/preview" && url.pathname !== "/api/count-comparisons")) {
    throw new ApiError(405, "方法不允许");
  }
  const input = await body(request);
  const firstId = integer(input.first_count_id, "第一份盘点", 1);
  const secondId = integer(input.second_count_id, "第二份盘点", 1);
  const state = await pairState(env, firstId, secondId, actor);
  if (url.pathname.endsWith("/preview")) return json(state);

  const token = text(input.comparison_token, "比对令牌", 64, 64);
  if (token !== state.comparison_token) {
    throw new ApiError(409, { code: "count_comparison_changed", message: "盘点记录或库存已变化，请重新比对" });
  }
  const resolutions = new Set(["no_difference", "normal_consumption", "trusted_first", "trusted_second", "manager_corrected", "recount_required"]);
  const resolution = String(input.resolution ?? "");
  if (!resolutions.has(resolution)) throw new ApiError(400, "盘点处理方式无效");
  const different = state.entries.filter((row) => row.result === "different");
  if (resolution === "no_difference" && different.length) throw new ApiError(400, "两份盘点存在差异，不能按无差异确认");
  if (["normal_consumption", "trusted_first", "trusted_second", "manager_corrected"].includes(resolution) && !different.length) {
    throw new ApiError(400, "两份盘点没有差异，请直接确认");
  }
  const note = nullableText(input.note, 255);
  if (["trusted_first", "trusted_second", "manager_corrected", "recount_required"].includes(resolution) && !note) {
    throw new ApiError(400, "该处理方式必须填写差异原因");
  }
  const rawCorrections = input.corrections === undefined ? [] : input.corrections;
  if (!Array.isArray(rawCorrections)) throw new ApiError(400, "更正条目格式无效");
  const corrections = new Map<number, number>();
  for (const raw of rawCorrections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "更正条目格式无效");
    const row = raw as Record<string, unknown>;
    const id = integer(row.item_id, "库存品", 1);
    if (corrections.has(id)) throw new ApiError(400, "更正条目重复");
    corrections.set(id, integer(row.qty, "更正数量", 0));
  }
  const diffIds = new Set(different.map((row) => row.item_id));
  if (resolution === "manager_corrected" && (corrections.size !== diffIds.size || [...corrections.keys()].some((id) => !diffIds.has(id)))) {
    throw new ApiError(400, "管理员更正必须填写全部差异项目");
  }
  if (resolution !== "manager_corrected" && corrections.size) throw new ApiError(400, "当前处理方式不接受更正数量");

  const final = new Map<number, number>();
  if (resolution !== "recount_required") {
    for (const row of state.entries.filter((entry) => entry.first_qty !== null && entry.second_qty !== null)) {
      if (row.result === "same" || resolution === "no_difference") final.set(row.item_id, row.first_qty!);
      else if (resolution === "normal_consumption") final.set(row.item_id, state.later_count_id === firstId ? row.first_qty! : row.second_qty!);
      else if (resolution === "trusted_first") final.set(row.item_id, row.first_qty!);
      else if (resolution === "trusted_second") final.set(row.item_id, row.second_qty!);
      else final.set(row.item_id, corrections.get(row.item_id)!);
    }
  }
  const confirmedAt = nowIso();
  const lookup = "(SELECT id FROM count_comparisons WHERE first_session_id = ? AND second_session_id = ? AND confirmed_by = ? AND confirmed_at = ? ORDER BY id DESC LIMIT 1)";
  const lookupValues = [firstId, secondId, actor.id, confirmedAt];
  const status = resolution === "recount_required" ? "rejected" : "verified";
  const trusted = resolution === "trusted_first" ? firstId : resolution === "trusted_second" ? secondId : null;
  const statements: D1PreparedStatement[] = [
    ...state.entries.map((row) => guard(env.DB, "COALESCE((SELECT SUM(qty) FROM batches WHERE item_id = ?), 0) = ?", row.item_id, row.current_qty)),
    env.DB.prepare("INSERT INTO count_comparisons(first_session_id, second_session_id, resolution, trusted_session_id, note, confirmed_by, confirmed_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .bind(firstId, secondId, resolution, trusted, note, actor.id, confirmedAt),
  ];
  for (const id of [firstId, secondId]) {
    statements.push(env.DB.prepare(`UPDATE count_sessions SET status = ?, comparison_id = ${lookup}, verified_by = ?, verified_at = ?, review_reason = ?, review_note = ? WHERE id = ? AND status = 'submitted' AND comparison_id IS NULL`)
      .bind(status, ...lookupValues, actor.id, confirmedAt, `paired_${resolution}`, note, id));
    statements.push(guard(env.DB, "changes() = 1"));
  }
  for (const row of state.entries) {
    const qty = final.get(row.item_id) ?? null;
    statements.push(env.DB.prepare(`INSERT INTO count_comparison_entries(comparison_id, item_id, first_qty, second_qty, final_qty, result) VALUES(${lookup}, ?, ?, ?, ?, ?)`)
      .bind(...lookupValues, row.item_id, row.first_qty, row.second_qty, qty, row.result));
    if (qty === null) continue;
    statements.push(env.DB.prepare("UPDATE count_entries SET reviewed_qty = ? WHERE session_id IN (?, ?) AND item_id = ?").bind(qty, firstId, secondId, row.item_id));
    const delta = qty - row.current_qty;
    if (delta < 0) {
      const deductions = await deductComparisonStatements(
        env, row.item_id, -delta, actor.id, firstId, secondId, confirmedAt,
      );
      statements.push(...deductions);
    } else if (delta > 0) {
      const item = await env.DB.prepare("SELECT shelf_life_days FROM items WHERE id = ?").bind(row.item_id).first<{ shelf_life_days: number }>();
      statements.push(env.DB.prepare("INSERT INTO batches(item_id, qty, initial_qty, expiry_date, source, note) VALUES(?, ?, ?, ?, 'adjust', '双人盘点盘盈')")
        .bind(row.item_id, delta, delta, plusDays(businessDate(), item!.shelf_life_days)));
      statements.push(env.DB.prepare(`INSERT INTO stock_movements(item_id, batch_id, delta, operation, reference_type, reference_id, actor_id) VALUES(?, last_insert_rowid(), ?, 'count_surplus', 'count_comparison', ${lookup}, ?)`)
        .bind(row.item_id, delta, ...lookupValues, actor.id));
    }
  }
  statements.push(env.DB.prepare("DELETE FROM _transaction_guard"));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ event: "count_pair_failed", first_id: firstId, second_id: secondId, error: String(error) }));
    throw new ApiError(409, { code: "count_comparison_changed", message: "盘点记录或库存已变化，请重新比对" });
  }
  const created = await env.DB.prepare("SELECT id FROM count_comparisons WHERE first_session_id = ? AND second_session_id = ? AND confirmed_by = ? AND confirmed_at = ? ORDER BY id DESC LIMIT 1")
    .bind(...lookupValues).first<{ id: number }>();
  return json(await comparisonDetail(env, created!.id), 201);
}

async function wasteRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/waste")) return null;
  if (request.method === "POST" && pathname === "/api/waste") {
    const user = await authenticate(request, env);
    const input = await body(request);
    const itemId = integer(input.item_id, "库存品", 1);
    const qty = integer(input.qty, "报损数量", 1);
    const reason = text(input.reason, "报损原因", 1, 64);
    const description = nullableText(input.description, 500);
    if (!await itemExists(env.DB, itemId)) throw new ApiError(400, "库存品不存在");
    let batchId: number | null = null;
    if (input.batch_id !== undefined && input.batch_id !== null) {
      batchId = integer(input.batch_id, "批次", 1);
      const batch = await env.DB.prepare("SELECT id FROM batches WHERE id = ? AND item_id = ?").bind(batchId, itemId).first();
      if (!batch) throw new ApiError(400, "指定批次不存在或不属于该库存品");
    }
    const result = await env.DB.prepare(`
      INSERT INTO waste_records(item_id, batch_id, qty, reason, description, status, reported_by)
      VALUES(?, ?, ?, ?, ?, 'pending', ?)
    `).bind(itemId, batchId, qty, reason, description, user.id).run();
    return json(await serializeWaste(env, Number(result.meta.last_row_id)), 201);
  }
  if (request.method === "GET" && pathname === "/api/waste") {
    await authenticate(request, env);
    const status = url.searchParams.get("status");
    const rows = status
      ? (await env.DB.prepare("SELECT id FROM waste_records WHERE status = ? ORDER BY id DESC").bind(status).all<{ id: number }>()).results
      : (await env.DB.prepare("SELECT id FROM waste_records ORDER BY id DESC").all<{ id: number }>()).results;
    return json(await Promise.all(rows.map((row) => serializeWaste(env, row.id))));
  }
  const action = pathname.match(/^\/api\/waste\/(\d+)\/(confirm|reject)$/);
  if (request.method === "POST" && action) {
    const manager = await authenticate(request, env, "manager");
    const id = Number(action[1]);
    const record = await env.DB.prepare("SELECT * FROM waste_records WHERE id = ?").bind(id).first<{ id: number; status: string; item_id: number; batch_id: number | null; qty: number }>();
    if (!record) throw new ApiError(404, "报损记录不存在");
    if (record.status !== "pending") throw new ApiError(409, "该报损记录已处理");
    if (action[2] === "reject") {
      const result = await env.DB.prepare("UPDATE waste_records SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'").bind(manager.id, nowIso(), id).run();
      if (result.meta.changes !== 1) throw new ApiError(409, "该报损记录已处理");
      return json(await serializeWaste(env, id));
    }
    const statements = [
      env.DB.prepare("UPDATE waste_records SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'").bind(manager.id, nowIso(), id),
      guard(env.DB, "changes() = 1"),
      ...await deductStatements(env, record.item_id, record.qty, manager.id, "waste", "waste", id, record.batch_id ?? undefined),
      env.DB.prepare("DELETE FROM _transaction_guard"),
    ];
    try { await env.DB.batch(statements); } catch (error) {
      console.error(JSON.stringify({ event: "waste_confirm_failed", waste_id: id, error: String(error) }));
      throw new ApiError(409, "库存不足或报损记录已处理");
    }
    return json(await serializeWaste(env, id));
  }
  throw new ApiError(405, "方法不允许");
}

type PurchaseLineInput = { item_id: number; qty: number };

async function purchaseRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/purchases")) return null;
  const manager = await authenticate(request, env, "manager");
  if (request.method === "POST" && pathname === "/api/purchases") {
    const input = await body(request);
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ApiError(400, "采购条目不能为空");
    const lines: PurchaseLineInput[] = input.items.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "采购条目格式无效");
      const line = raw as Record<string, unknown>;
      return { item_id: integer(line.item_id, "库存品", 1), qty: integer(line.qty, "采购数量", 1) };
    });
    if (new Set(lines.map((line) => line.item_id)).size !== lines.length) throw new ApiError(400, "采购条目重复");
    for (const line of lines) if (!await itemExists(env.DB, line.item_id)) throw new ApiError(400, `库存品不存在：${line.item_id}`);
    const statements = [
      env.DB.prepare("INSERT INTO purchases(status, created_by, note) VALUES('ordered', ?, ?)").bind(manager.id, nullableText(input.note, 255)),
      ...lines.map((line) => env.DB.prepare("INSERT INTO purchase_items(purchase_id, item_id, qty) VALUES((SELECT seq FROM sqlite_sequence WHERE name = 'purchases'), ?, ?)").bind(line.item_id, line.qty)),
    ];
    const results = await env.DB.batch(statements);
    return json(await serializePurchase(env, Number(results[0].meta.last_row_id)), 201);
  }
  if (request.method === "GET" && pathname === "/api/purchases") {
    const status = url.searchParams.get("status");
    const rows = status
      ? (await env.DB.prepare("SELECT id FROM purchases WHERE status = ? ORDER BY id DESC").bind(status).all<{ id: number }>()).results
      : (await env.DB.prepare("SELECT id FROM purchases ORDER BY id DESC").all<{ id: number }>()).results;
    return json(await Promise.all(rows.map((row) => serializePurchase(env, row.id))));
  }
  const action = pathname.match(/^\/api\/purchases\/(\d+)\/(receive|cancel)$/);
  if (request.method === "POST" && action) {
    const id = Number(action[1]);
    const purchase = await env.DB.prepare("SELECT * FROM purchases WHERE id = ?").bind(id).first<{ id: number; status: string }>();
    if (!purchase) throw new ApiError(404, "采购单不存在");
    if (purchase.status !== "ordered") throw new ApiError(409, "该采购单已处理");
    if (action[2] === "cancel") {
      const result = await env.DB.prepare("UPDATE purchases SET status = 'cancelled', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'ordered'").bind(manager.id, nowIso(), id).run();
      if (result.meta.changes !== 1) throw new ApiError(409, "该采购单已处理");
      return json(await serializePurchase(env, id));
    }
    const input = await body(request);
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ApiError(400, "入库条目不能为空");
    const expiry = new Map<number, string>();
    for (const raw of input.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "入库条目格式无效");
      const line = raw as Record<string, unknown>;
      const lineId = integer(line.purchase_item_id, "采购行", 1);
      const date = text(line.expiry_date, "效期", 10, 10);
      if (!datePattern.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ApiError(400, "效期必须为有效日期 YYYY-MM-DD");
      expiry.set(lineId, date);
    }
    const lines = (await env.DB.prepare("SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id").bind(id).all<{ id: number; item_id: number; qty: number }>()).results;
    if (expiry.size !== lines.length || lines.some((line) => !expiry.has(line.id))) throw new ApiError(400, "入库行必须覆盖采购单全部条目");
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE purchases SET status = 'received', received_at = ?, handled_by = ?, handled_at = ? WHERE id = ? AND status = 'ordered'").bind(nowIso(), manager.id, nowIso(), id),
      guard(env.DB, "changes() = 1"),
    ];
    for (const line of lines) {
      statements.push(env.DB.prepare("INSERT INTO batches(item_id, qty, initial_qty, expiry_date, source, note) VALUES(?, ?, ?, ?, 'purchase', ?)").bind(line.item_id, line.qty, line.qty, expiry.get(line.id)!, `采购单 #${id}`));
      statements.push(env.DB.prepare("INSERT INTO stock_movements(item_id, batch_id, delta, operation, reference_type, reference_id, actor_id) VALUES(?, last_insert_rowid(), ?, 'purchase_receive', 'purchase', ?, ?)").bind(line.item_id, line.qty, id, manager.id));
    }
    statements.push(env.DB.prepare("DELETE FROM _transaction_guard"));
    try { await env.DB.batch(statements); } catch (error) {
      console.error(JSON.stringify({ event: "purchase_receive_failed", purchase_id: id, error: String(error) }));
      throw new ApiError(409, "该采购单已处理");
    }
    return json(await serializePurchase(env, id));
  }
  throw new ApiError(405, "方法不允许");
}

async function dashboard(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  const today = businessDate();
  const cutoff = plusDays(today, 3);
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM items i WHERE i.active = 1 AND COALESCE((SELECT SUM(qty) FROM batches b WHERE b.item_id = i.id), 0) < i.min_stock) low_stock,
      (SELECT COUNT(*) FROM batches WHERE qty > 0 AND expiry_date <= ?) expiring_soon,
      (SELECT COUNT(*) FROM waste_records WHERE status = 'pending') pending_waste,
      (SELECT COUNT(*) FROM count_sessions WHERE count_type = 'weekly' AND status = 'submitted' AND datetime(created_at) >= datetime('now', '-72 hours')) pending_counts,
      (SELECT COUNT(*) FROM purchases WHERE status = 'ordered') active_purchases,
      (SELECT COUNT(*) FROM count_entries ce JOIN count_sessions cs ON cs.id = ce.session_id WHERE cs.count_type = 'daily' AND cs.business_date = ? AND cs.status = 'completed' AND ce.is_enough = 0) daily_shortages,
      (SELECT COUNT(*) FROM count_sessions WHERE count_type = 'weekly' AND datetime(created_at) >= datetime('now', '-3 days') AND (? = 0 OR created_by = ?)) recent_counts_3d
  `).bind(cutoff, today, user.role === "staff" ? 1 : 0, user.id).first();
  return json(row);
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    const meta = await env.DB.prepare("SELECT store_id, schema_version FROM store_meta WHERE id = 1").first<{ store_id: string; schema_version: string }>();
    if (!meta) throw new Error("D1 migration has not been applied");
    return json({ status: "ok", api_version: "1", db_schema: meta.schema_version, store_id: meta.store_id, backend_kind: "cloudflare_worker", app_version: env.APP_VERSION });
  }
  let response = await authRoutes(request, env, url.pathname);
  if (response) return response;
  response = await userRoutes(request, env, url.pathname);
  if (response) return response;
  response = await itemRoutes(request, env, url);
  if (response) return response;
  response = await stockRoutes(request, env, url);
  if (response) return response;
  response = await countRoutes(request, env, url);
  if (response) return response;
  response = await countComparisonRoutes(request, env, url);
  if (response) return response;
  response = await wasteRoutes(request, env, url);
  if (response) return response;
  response = await purchaseRoutes(request, env, url);
  if (response) return response;
  if (request.method === "GET" && url.pathname === "/api/dashboard") return dashboard(request, env);
  throw new ApiError(404, "接口不存在");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const origin = request.headers.get("Origin");
      if (origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      } });
    }
    if (!url.pathname.startsWith("/api/")) return json({ detail: "接口不存在" }, 404);
    const readOnlyResponse = migrationReadOnly(request, env);
    if (readOnlyResponse) return cors(readOnlyResponse, request, env);
    const started = Date.now();
    try {
      const response = await withEtag(request, await api(request, env));
      console.log(JSON.stringify({ event: "api_request", method: request.method, path: url.pathname, status: response.status, duration_ms: Date.now() - started }));
      return cors(response, request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        console.warn(JSON.stringify({ event: "api_error", method: request.method, path: url.pathname, status: error.status, detail: error.detail }));
        return cors(json({ detail: error.detail }, error.status, error.headers), request, env);
      }
      console.error(JSON.stringify({ event: "api_exception", method: request.method, path: url.pathname, error: String(error) }));
      return cors(json({ detail: "服务器内部错误" }, 500), request, env);
    }
  },
} satisfies ExportedHandler<Env>;
