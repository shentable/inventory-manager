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

- `staff`：每日够/不够盘点、独立提交每周实数盘点、查看自己的三天记录、报损登记、库存与效期查看、直接入库及本人入库查询更正
- `manager`：可独立提交每周盘点；可选择另外两人提交的记录进行比对确认；另有入库及全部入库记录查询更正、报损核对、采购、库存品管理和流水查看
- `admin`：拥有直接入库等管理权限，另负责用户管理和双人盘点确认；不提交每周盘点

## 核心数据

### 数量精度与单位

- 所有库存单位（包括自定义单位）均支持 0.1。入库、采购、报损数量最小为 0.1；
  盘点及最低库存允许 0。输入为 JSON 数字，最多一位小数，上限为 1,000,000,000；
  拒绝布尔值、字符串、负数、非有限数及多余小数位，不静默截断。
- API 继续使用库存品定义的单位；界面统一显示 `2`、`2.3`，不显示 `2.0`，计算结果最多一位小数。
  报损数量支持直接输入及 0.1 步进；其他数量控件也可直接输入一位小数。
  不同单位的数量不相加后标为“件”，采购/入库确认仅汇总品项数。
- SQLite 所有数量列为整数十分位：`2.3` 存为 `23`。范围包括 `items.min_stock`、
  批次剩余/初始数量、流水增减量、采购数量、盘点原值/快照/现场值/核对值、比对结果、报损数量。
  Python 列类型与 Rust `Quantity` 负责边界转换；FEFO 和数据库余额运算以整数十分位执行。
- `20260908_09` 将原整数单位数据乘以 10，保留原数量、空值、负向流水与关联记录，重复启动不再次放大。
  含小数数量或小数历史流水的库拒绝降级到整数库存版本；回滚应用时须使用升级前的数据库备份。
  旧 Rust 版本不能打开新 schema。Python/Rust 服务端须同步升级，且同一时刻仅有一个权威写入端。

### 消耗与补货看板

`GET /api/consumption?days=56&lead_days=2&coverage_days=7` 仅允许 `manager`、`admin`；
`staff` 返回 403，前端 `#/consumption` 同样有角色守卫。

- `days`：完整周期统计窗口，7–180 天，默认 56；`lead_days`：到货等待期，0–30 天，默认 2；
  `coverage_days`：到货后覆盖期，1–30 天，默认 7。均为整数；参数只作用于本次测算，不更改品项资料。
- 返回 `{as_of, days, lead_days, coverage_days, items}`。`as_of` 为 UTC 测算时间；
  每项包含账面库存、最近采用数量/时间、有效周期数、使用量、报损、样本天数、平均日耗、
  预计余量、可用天数、向上取至 0.1 的 `replenishment_gap`、待到货数量、现场报缺、效期数量、
  `forecast_issue` 和逐周期 `periods` 计算依据。预测无效时相关数量为 `null`，绝不以 0 代替缺失。
- 每组已确认双人盘点按品项仅取一份 `final_qty`；缺项、退回记录、未配对旧版单人确认不作为基准。
  时间取可信来源记录的 `created_at`，无差异/正常消耗取较晚记录；该字段目前代表提交或最后编辑时间，
  不是独立采集的实盘时间。管理员更正的差异项时间未知，相关周期排除。
- 使用量 = 期初实盘 + 期间 `stock_receive`/`purchase_receive` − 期末实盘 − 已确认报损。
  报损按 `reported_at` 近似实际发生时间归属，迟审会重算；盘盈盘亏不重复计入。所有数量沿用品项库存单位。
- 日耗 = 有效完整周期使用量之和 / 自然天数之和。周期不足一天、跨出窗口、时间异常、
  确认延迟超过 6 小时、盘点至确认间有其他库存流水、报损审批跨越盘点、待确认报损、
  负使用量均排除；保留原值和排除原因。最新周期异常时暂停当前预测，不回退到过旧周期掩盖异常。
- 当前预测另要求最近基准不超过 14 天，无待确认报损、账面过期数量，且日耗大于零。
  预计余量 = max(0, 最近实盘 + 此后入库 − 此后报损 − 日耗 × 经过天数)，可用天数 = 余量 / 日耗。
- 目标量 = min(日耗 × (等待期 + 覆盖期) + 最低库存, 日耗 × (等待期 + 保质期))；
  缺口 = ceil(max(0, 目标量 − 预计余量) × 10) / 10。它是库存单位的备货缺口，采购前须核对实际供应效期和包装规格。
  当前采购单没有预计到货日，待到货数量单列提醒，不用于抵消缺口或解除缺货风险。
- `status`：今日现场报缺优先为 `shortage`；不能预测为 `review`；剩余天数不超过等待期或
  预计余量低于最低库存为 `reorder`；其余为 `ok`。每天够/不够与现场数量不替代正式盘点基准。
- 看板无单独统计表，无预测自动扣账或自动下单。数量存储使用下述 0.1 精度迁移。Python 读取、Rust 编译嵌入同一份
  `server/app/consumption.sql`，通过单条只读查询取得一致快照；每次请求重新计算。

### 库存与操作记录

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
- `POST /stock/receive`（staff+）：`{items:[{item_id, qty, expiry_date}], note?}`，无需采购单直接创建入库批次，记录实际入库人
- `GET /stock/receipts?q=&limit=50&offset=0`：查询直接入库记录。店员只看自己的记录；店长、管理员看全部。`q` 匹配品名、入库人或备注；limit 范围 1–100，返回 `{items, has_more, limit, offset}`
- `GET /stock/receipts/{batch_id}`：入库详情，包括原始数量、当前正确入库总量、批次余量、入库人、效期、备注、更正历史与 revision。无权查看的记录统一返回 404
- `PATCH /stock/receipts/{batch_id}`：`{qty, expiry_date, note?, reason, expected_revision}`。权限与查询相同；qty 是正确的整笔入库数量，不是调整差额，支持 0.1。qty=0 用于撤销未扣减入库。商品与入库人不允许覆盖；商品选错可撤销后重新入库
- `GET /items/{id}/batches`
- `GET /items/{id}/movements`（manager+）：该库存品的审计流水
- `GET /expiry?days=3`

入库逐行创建 `source=receive` 批次并写正数 `stock_receive` 流水；库存数量也可通过采购入库、核对盘点或确认报损变化。系统不暴露覆盖库存余额的接口。

入库更正保留原始 `Batch.initial_qty` 和 `stock_receive` 流水，在 `stock_receipt_corrections`
保存数量、效期、备注前后值及操作人、原因、时间；单独追加 `stock_receive_correction`
差额流水，并在同一事务中更新批次余量。仅修改效期/备注时流水差额为 0。
版本过期、减少量超过批次余量均返回 409，不部分写入；后续确认盘点已经覆盖该库存品时，
禁止直接更正原入库数量，仍可更正效期与备注。消耗看板把更正差额计入对应周期净入库，
不重复计算原始入库。既有直接入库通过原流水识别入库人，自动出现在查询结果中。
采购下单及采购收货维持原管理权限，本接口不用于更正采购单。

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
- 采用的记录提交/最后编辑后，如果对应品项已有新的库存流水，确认返回
  `409 count_observation_stale`，必须现场重盘并提交/更新记录后重新比对。仅刷新预览不能绕过。
  一致的两份记录也允许退回重盘，退回不调整库存。此保护防止旧盘点覆盖随后入库或报损。
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
schema 均为 `20260908_09`，迁移结果由双后端浏览器套件验证。空库启动时必须提供
`BOOTSTRAP_ADMIN_PIN`（Android 由原生初始化页写入私有文件），系统
创建唯一的 `admin` 临时管理员并标记首次改 PIN；不会创建 `0000` 账号。示例库存品
仍会幂等创建，可在首次上线前按门店实际情况修改或停用。升级路径和全新建库均有测试。
