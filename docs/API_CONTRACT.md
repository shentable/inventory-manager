# 飨拓™库存管理 — API 契约

所有路径以 `/api` 开头。除健康检查、登录选项和登录外均需
`Authorization: Bearer <token>`。错误响应使用 FastAPI 的 `{detail: ...}`；业务冲突的
`detail` 是带 `code` 和 `message` 的对象。

## GET 缓存与增量校验

- 所有成功的 `GET /api/*` 响应返回强 `ETag` 与 `Cache-Control: no-cache`。
- 客户端恢复联通后按已缓存的完整 URL 发送 `If-None-Match`；未变化返回 `304`，有变化才返回 `200` 和新内容。
- 缓存按登录令牌隔离。离线缓存仅供查看，`POST`、`PATCH` 等写操作不得排队或回放。
- 只有健康检查及全部已缓存资源校验完成后才解除“数据未同步 / 离线只读”状态。

## 认证与权限

- `GET /health`：无需登录，返回 `status`、`api_version`、`db_schema`、稳定的
  `store_id`、`backend_kind`（`python`、`android_native`、`linux_native` 或
  `cloudflare_worker`）和 `app_version`
- `GET /auth/login-options`：返回可点选的启用用户
- `POST /auth/login`：`{username, pin}` → `{token, user}`；同一账号与来源 IP 在
  10 分钟内失败 5 次后锁定 15 分钟，返回 `429` 和 `Retry-After`
- `GET /auth/me`：当前用户
- `POST /auth/change-pin`：`{current_pin, new_pin}` → 新 token 与用户；旧 token 立即失效

`UserOut` 包含 `id`、`username`、`display_name`、`role`、`active` 和
`must_change_pin`。空库管理员以及新建/重置 PIN 的用户必须先改 PIN；此前只允许访问
当前用户和改 PIN 接口。PIN 为 4–6 位数字。

Token 包含用户的 `token_version`。改 PIN、管理员重置 PIN、停用用户或修改角色都会
递增该版本，从而撤销该用户此前签发的全部 token。

角色：

- `staff`：每日够/不够盘点、独立提交每周实数盘点、查看自己的三天记录、报损登记、库存与效期查看
- `manager`：可独立提交每周盘点；可选择另外两人提交的记录进行比对确认；另有报损核对、采购、库存品管理和流水查看
- `admin`：用户管理和双人盘点确认；不提交每周盘点

## 核心数据

- `users`：账号、PIN 哈希、角色、启用状态、首次改 PIN 标志、token 版本
- `login_attempts`：账号 + 来源 IP 的失败窗口、次数和锁定时间
- `items`：库存品定义；`batches`：带效期的当前数量批次
- `stock_movements`：不可变流水，记录 item、batch、增减量、业务类型、关联单据、
  操作者和时间
- `count_sessions/count_entries`：两名盘点人各自的原始盘点单和提交时库存快照
- `count_comparisons/count_comparison_entries`：永久关联两份原始盘点、逐项差异、最终数量、处理方式和确认人
- `waste_records`：报损单
- `purchases/purchase_items`：采购单和行项目
- `store_meta`：随数据库迁移的门店身份、共享 schema 版本和创建时间

当前库存是有效批次数量之和。扣减使用带数量条件的原子 SQL 更新；未指定批次时按
FEFO。业务单的核对/确认/取消用状态条件更新，因此重复或并发处理只有一次成功。

## 接口

### 用户（admin）

- `GET /users`
- `POST /users`：`{username, display_name, pin, role}`
- `PATCH /users/{id}`：`{username?, display_name?, role?, active?, pin?}`

用户名统一去除首尾空格并转为小写，且全局唯一。新建或重置 PIN 后
`must_change_pin=true`。用户名、角色、启用状态或 PIN 变化会撤销该用户的旧 token。

### 库存品与库存

- `GET /items?include_inactive=false`：每项附带最近一次有效盘点的 `last_count_at`、`last_count_qty`、`last_count_type`、`last_count_enough`；每日仅采用 `completed`，每周仅采用 `verified`，未填现场实数时数量为 `null`
- `POST /items`、`PATCH /items/{id}`（manager+）：库存品包含 `daily_count_enabled`、`weekly_count_enabled` 两个布尔开关，均默认 `true`
- `GET /stock`
- `GET /items/{id}/batches`
- `GET /items/{id}/movements`（manager+）：该库存品的审计流水
- `GET /expiry?days=3`

系统不暴露直接改库存接口；数量只能通过采购入库、核对盘点或确认报损变化。

### 盘点

- `POST /counts` 每日盘点（staff+）：只允许提交勾选 `daily_count_enabled` 的库存品；请求为 `{count_type:"daily", entries:[{item_id, enough, qty?}]}`。选择“不够”时 `qty` 必填，选择“够”时 `qty` 可空，响应中以 `reported_qty` 返回。完成后状态为 `completed` 且不修改库存。同一业务日期只保留一条结果；重复提交会同时比较“够/不够”和现场数量，返回 `409 daily_count_exists` 及逐项差异，客户端确认后以 `overwrite_daily:true` 覆盖原记录。
- `POST /counts` 每周盘点（staff、manager，管理员不可提交，`count_type:"weekly"`）：只允许提交勾选 `weekly_count_enabled` 的库存品；请求为 `{count_type:"weekly", entries:[{item_id, qty}], note?}`，提交后状态为 `submitted`
- `GET /counts?status=&count_type=daily|weekly&days=3`、`GET /counts/{id}`：店员查看每周盘点时只返回自己提交的数据，店长和管理员可查看全部；每日盘点结果仍对全员可见
- `PATCH /counts/{id}`（原提交人）：仅可在每周盘点处于 `submitted` 时提交 `{entries:[{item_id, qty}], note?}`；不得删除原单明细，可补加启用每周盘点的库存品；保存后刷新提交时间和库存快照，核对或驳回后不可再编辑
- `POST /count-comparisons/preview`（manager+）：`{first_count_id, second_count_id}`，两份记录必须来自不同提交人、均在近 72 小时内且未处理；返回逐项左右对照、单边缺失项、较晚记录和 `comparison_token`
- `POST /count-comparisons`（manager+）：提交两份记录 ID、预览令牌、`resolution`、可选原因及更正项，在同一事务中锁定两份原始记录、调整库存并写流水
- `GET /count-comparisons/{id}`（manager+）：查看永久保存的完整比对及落库结果
- `POST /counts/{id}/verify`、`POST /counts/{id}/reject` 已停用，返回结构化 `409 pair_verification_required`

每日盘点的 `enough` 表达现场够用与否；可选 `qty` 只作为当日现场记录，不直接调整库存，也不进入双人比对。列表的 `quantity_count` 表示填写了现场数量的条目数。

每周盘点由两名不同人员独立提交，互不复用同一份记录。确认人不得是任一提交人，每份记录只能参与一次最终处理。两份记录的共同库存品进入比对，单边缺失项标记“未盘”且绝不更新库存；没有共同项时拒绝确认。正常确认页不录入第三套数字：

- `no_difference`：两份共同项完全一致，直接采用。
- `normal_consumption`：有差异时采用提交时间较晚的一整份记录。
- `trusted_first` / `trusted_second`：采用指定可信记录，必须填写原因。
- `manager_corrected`：只对共同且有差异的条目填写最终数量，必须填写原因；这是管理人员唯一出现数字输入框的场景。
- `recount_required`：两份记录同时退回重盘，不修改库存，也不生成库存流水。

预览令牌覆盖两份原始记录的内容、状态和共同库存快照。编辑记录、记录被其他比对占用或库存变化后确认会返回：

```json
{
  "detail": {
    "code": "count_comparison_changed",
    "message": "盘点记录或库存已变化，请重新比对"
  }
}
```

盘亏按 FEFO 扣减并写 `count_shortage` 流水；盘盈创建调整批次并写
`count_surplus` 流水，关联类型为 `count_comparison`。原批次备注保持不变。旧版已核对记录保持原值，界面以“旧版单人核对”标识。

### 报损

- `POST /waste`（staff+）：中心 Workers 目标使用 `{item_id, qty, reason, batch_id?, description?}`，不保存或上传图片
- `GET /waste?status=`
- `POST /waste/{id}/confirm`、`POST /waste/{id}/reject`（manager+）

旧 Python/Rust/Android 部署为兼容既有数据库暂保留图片字段，但当前 Web/PWA 不再发送或读取图片，Workers/D1 迁移中也不存在图片列。

确认成功写负数 `waste` 流水；并发确认只有一次能改变库存。

### 采购（manager+）

- `GET /purchases?status=`
- `POST /purchases`：`{items:[{item_id, qty}], note?}`
- `POST /purchases/{id}/receive`：`{items:[{purchase_item_id, expiry_date}]}`
- `POST /purchases/{id}/cancel`

入库逐行创建批次并写正数 `purchase_receive` 流水；入库/取消互斥且只处理一次。

### 仪表盘

- `GET /dashboard`：低库存、临期、待确认报损、待比对记录、近三天实数盘点和在途采购数量

## 数据库初始化与迁移

Docker 正式环境通过 Alembic 建库或升级；Rust 后端执行语义相同的嵌入迁移。两端当前
schema 均为 `20260904_08`，迁移结果由双后端浏览器套件验证。空库启动时必须提供
`BOOTSTRAP_ADMIN_PIN`（Android 由原生初始化页写入私有文件），系统
创建唯一的 `admin` 临时管理员并标记首次改 PIN；不会创建 `0000` 账号。示例库存品
仍会幂等创建，可在首次上线前按门店实际情况修改或停用。升级路径和全新建库均有测试。
