# 单门店试运行手册

本手册用于门店正式数据首次建立、受控 APK 安装、日常保障和放行验收。每次操作记录
执行人、时间、服务端 Git commit、EasyTier `v2.6.4`、APK 版本与 SHA-256。

中心化生产入口应由 `https://app.example.com` 一类自有域名提供，由 VPS 上的 Caddy 反向代理至
回环监听的 Rust/SQLite 服务。DNS 服务商仅托管解析；下述手机服务端/DDNS 内容只适用
于切换回 Android 本机服务端的备用方案，不是当前生产链路。

## Cloudflare DDNS

1. 在 Cloudflare 创建仅限目标 Zone、权限为 `Zone / DNS / Edit` 的 API Token，不使用 Global API Key。
2. 从 Zone Overview 复制 32 位 Zone ID，并准备业务子域名。
3. 在服务端手机设置中启用“Cloudflare DDNS”，填写域名、Zone ID，并一次性输入 Token。
4. 保存后检查前台通知和设置页状态，应显示同步成功以及当前 `2400::/3` 公网 IPv6。
5. 用 Cloudflare 控制台确认只有一个同名 AAAA 记录。若有多个，App 会拒绝覆盖，需先人工合并。
6. Token 不会再次显示；需要轮换时在同一输入框输入新 Token 覆盖。

DDNS 每 5 分钟运行一次。它不会证明公网入站可达；必须从店外 IPv6 网络验证目标端口，并在开放业务前完成 HTTPS。

### EasyTier 初始节点（推荐试运行路径）

1. 将业务域名的 AAAA 设置为 DNS-only（灰云），不可开启 Cloudflare HTTP 代理。
2. 服务端和客户端都使用独立公共中继 `tcp://<中继公网 IP>:32147`，无需开放服务手机 IPv6 入站。
3. 新安装使用 APK 内置公共中继配置；旧安装点击“使用内置公共中继配置”后先执行全链路测试。
4. 点击“测试 EasyTier 全链路”；成功后业务实际地址自动保存为 `http://10.126.126.1:8000`。
5. “测试服务器 URL（直连）”只用于公网 HTTPS 诊断，不代表 EasyTier 是否正常。

### 公共中继模式

店内 IPv6 入站不可用时，服务手机与客户端使用相同的公共中继初始节点，例如
`tcp://<relay-host>:32147`。服务手机保持固定虚拟 IP `10.126.126.1`，客户端继续 DHCP；
业务 URL 始终为 `http://10.126.126.1:8000`。公共中继使用独立网络名和随机密钥，不能
加入已有的办公或管理 EasyTier 网络。上线前从移动网络验证中继 TCP 端口和
“测试 EasyTier 全链路”，不要再以服务手机公网 `ping6` 作为放行条件。

### IPv6 HTTPS 放行

1. 在 Cloudflare `SSL/TLS / Origin Server` 创建覆盖业务域名的 ECC Origin CA 证书。
2. 在服务端设置页一次性粘贴 Origin Certificate 和 Origin Private Key；保存后不可回显。
3. 将该 Zone 的 SSL/TLS encryption mode 设置为 `Full (strict)`，并确认业务 AAAA 为橙云代理。
4. 在店内路由器按设备放行所选 HTTPS 端口（默认 TCP `2096`）；不要开放数据库文件、ADB、8000 或其他端口。
5. 从店外移动网络访问 `https://<域名>:2096/api/health`，核对 `store_id`。
6. 客户端关闭 EasyTier，服务器地址改为 `https://<域名>:2096`；完成登录和写操作后再将 EasyTier 作为回退通道下线。

## 1. 首次建库与账号

1. 确认 `server/data/` 没有样例 `app.db`，准备独立备份目录。
2. 从 `.env.example` 创建 `.env`，设置强随机 `SECRET_KEY`、一次性
   `BOOTSTRAP_ADMIN_PIN`、EasyTier 网络名和强密码。
3. 用 Compose v2 启动；确认迁移日志成功且 `/api/health` 返回 ok。
4. 用 `admin` 和一次性 PIN 登录并立即改 PIN。
5. 从 `.env` 删除 `BOOTSTRAP_ADMIN_PIN`，重启并确认已有库正常；再创建一名 manager
   和所需 staff，逐一首次登录改 PIN。确认生产没有 `0000` 凭据。
6. 按门店实际物料修改或停用示例库存品，不通过数据库或脚本直接填库存。
7. 首批数量应通过采购入库形成批次和 `stock_movements` 流水。

## 2. APK 发布与安装

1. 在隔离构建机注入签名和组网 secret，运行 EasyTier `build-core.sh`、Rust
   `build-server.sh` 与完整
   `scripts/verify.sh`。
2. 保存 APK、`.sha256`、EasyTier/Rust build metadata、Git commit 和构建日志。
3. 用 `sha256sum -c` 或 `shasum -a 256 -c` 校验后，安装到 arm64 Android 10+ 设备。
4. 禁止分发 debug、无签名、缺少内核或包含其他 ABI 的包。
5. 移动网络下打开 App；确认通知先显示连接中，健康成功后出现点选用户登录页。

## 3. 组网诊断

按以下顺序排查，避免直接修改手机虚拟 IP：

1. `curl http://localhost:8000/api/health` 验证后端。
2. `docker compose ps` 和 `docker compose logs app easytier` 验证容器。
3. `docker exec sandwich-easytier easytier-cli peer` 确认手机节点已加入。
4. `adb logcat -s NodeService:I EasyTierCore:I BackupCoordinator:E` 检查节点状态。
5. 核对 APK 中网络名/密码和默认 server URL；客户端 IP 由 DHCP 分配。

## 4. 每日操作

- 开店前：健康检查、一次 staff 登录、待办角标、最后一条库存流水。
- 营业中：店员用左右滑完成每日“够 / 不够”检查。每周由两名人员分别独立提交实数盘点，
  并在“每周盘点”的“提交盘点 / 我的记录”内完成提交、查看和处理前编辑。店长/管理员在
  “盘点管理”的“待比对 / 盘点记录 / 确认结果”中查看原始数据并选择两份近 72 小时记录；无差异直接采纳，正常销售消耗采用
  较晚提交记录，异常差异选择可信记录、只更正差异项或同时退回重盘。确认人不得是任一提交人，
  店员只能查看和编辑自己的待处理记录。遇到 `count_comparison_changed` 必须重新预览。
- 闭店后：执行 SQLite 在线备份、`PRAGMA integrity_check`，把备份复制到异机加密存储；
  记录库存总量和流水数量。
- 每周抽查一次：管理员停用测试账号后旧 token 立即失效；恢复演练环境能从备份启动。

## 5. 恢复和升级

恢复时先停 app、保留当前数据库副本、恢复已做完整性检查的备份、执行 Alembic、启动
并检查健康。恢复前后比较每个 item 的批次合计和 `stock_movements`；不一致不得放行。
详细命令见 [DEPLOY.md](DEPLOY.md)。

手机服务端恢复只能从 App 的原生管理菜单执行。首次启用必须设置临时管理员 PIN 和至少
12 位恢复口令，并选择外部备份目录；没有最近成功备份时 App 阻止切回客户端模式。
卸载服务端 APK 会删除应用私有数据库，未核对外部加密备份前严禁卸载。
Docker ↔ Android 切换严格执行“停止旧端、导出、冻结写入、导入、核对、启动新端”。

升级前先备份并在副本上验证迁移。升级后依次检查健康、三角色登录、PIN 修改、盘点、
报损、采购入库和流水。服务端与 APK 不兼容时不可只发布其中一端。

## 6. 试运行验收矩阵

软件自动门禁：

- 后端全部测试、全新建库和旧库升级路径通过
- 登录限流、首次改 PIN、token 撤销、并发审批、库存快照冲突和流水测试通过
- 同一套 Playwright 分别在 Python 与 Rust 后端覆盖三角色、权限、每日滑动盘点、每周实数盘点、报损/采购和 PIN
- Android 单测通过，release APK 签名有效且只含 arm64 EasyTier 与 Rust 两个内核

目标环境人工门禁：

- 实际部署机 Compose v2 用固定镜像启动，跨公网移动网络可访问
- 真机完成登录、盘点、报损、采购入库，并核对对应流水
- 切后台恢复、杀进程重启、断网重连和服务端重启后均能恢复
- 服务端模式完成两台真机跨网健康验证、五客户端并发不透支和连续 72 小时运行
- 自动备份、异机恢复及 Docker ↔ Android 双向迁移通过，恢复后批次总量和流水一致

只有在无默认凭据、自动门禁全过、上述人工门禁有记录且 APK/服务端/EasyTier 校验信息
齐全时，才允许进入门店试运行。
