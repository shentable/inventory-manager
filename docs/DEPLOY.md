# 部署指南 — 飨拓™库存管理

本轮目标是单门店、单权威后端、SQLite。权威后端可以是 Docker/FastAPI，也可以是
专用 arm64 Android 10+ 设备中的 Rust 后端；禁止两份数据库同时上线或自动合并。

## VPS 中心部署

`app.example.com`、`api.app.example.com` 和临时诊断域名 `staging.app.example.com` 均以 DNS-only
A 记录直连 VPS。Caddy 是唯一公网入口，Rust 服务只监听 `127.0.0.1:8000`。服务器不
安装 Docker，也不编译项目；静态 `x86_64-unknown-linux-musl` 二进制必须在受控本机
构建并校验后上传。

固定运行目录如下：

```text
/opt/sandwich/bin/sandwich-server  程序
/var/lib/sandwich/app.db           权威 SQLite
/etc/sandwich/token-secret         Token 密钥
/etc/sandwich/recovery-passphrase  age 恢复口令
/var/backups/sandwich              最近 14 份自动备份
```

本机构建和 D1 转换：

```bash
npm run build:linux-native
npx wrangler d1 export sandwich-inventory --remote \
  --config cloudflare/wrangler.jsonc --output dist/vps/d1-final.sql
python3 scripts/d1_to_native.py \
  --input dist/vps/d1-final.sql \
  --output dist/vps/app.db \
  --migrator native-server/target/debug/sandwich-server \
  --manifest dist/vps/app.db.manifest.json
```

转换拒绝覆盖已有输出，运行 Rust 嵌入迁移，保留 `store_id` 和 PIN 哈希，清空登录失败
记录并递增全部 `token_version`。清单必须核对 SHA-256、业务表行数、分库存量、流水汇总、
`foreign_key_check` 与 `integrity_check`。

VPS 单元文件、Caddy 配置和初始化脚本位于 `deploy/vps/`。`sandwich.service` 以无登录
用户运行且有 384MiB 硬内存上限；`sandwich-backup.timer` 每日通过 SQLite backup API
生成口令加密 `.swinv.age`，校验成功后发布，并只保留最近 14 份。正式首份备份必须复制
回本机，用临时数据库执行一次 `restore` 后才能结束迁移。
备份使用固定、跨设备可恢复的 age scrypt 工作因子，恢复口令必须由高熵随机值生成；
不得把恢复口令写入仓库或日志。

Cloudflare → VPS 正式切换顺序不可打乱：旧 Worker 开启
`MIGRATION_READ_ONLY=1` → 验证写请求返回 `503 migration_read_only` → 最终导出 D1 →
本机转换与核对 → 停止新服务并原子替换数据库 → 启动并验证 → 将正式域名从 Pages
解绑并切为 DNS-only A 记录 → 开放新端写入。新端发生任何写入后，不得把 DNS 直接
回退至旧 D1；必须修复新端或执行有核对清单的反向迁移。

完成切换后应删除或停用原 Pages/Workers/D1 资源。DNS-only A 记录指向
`<VPS_PUBLIC_IP>`；灾难恢复必须从 VPS 加密备份或本地切换归档恢复，不能再依赖旧 D1 回退。

## 首次部署

```bash
git clone <仓库地址> runner_cup
cd runner_cup
cp .env.example .env
openssl rand -hex 32       # 写入 .env 的 SECRET_KEY
openssl rand -hex 24       # 可作为 EasyTier 组网密码
# 编辑 .env，并设置一个仅首次启用的 4–6 位 BOOTSTRAP_ADMIN_PIN

docker compose up -d --build
docker compose ps
curl --fail http://localhost:8000/api/health
docker compose logs --tail=100 app
```

容器入口先运行 `alembic upgrade head`，迁移失败时 API 不会启动。空库只创建用户
`admin`，PIN 为 `BOOTSTRAP_ADMIN_PIN`，首次登录强制修改。随后由管理员创建 manager
和 staff 账号；不存在默认 `0000` 凭据。管理员改 PIN 后从 `.env` 删除
`BOOTSTRAP_ADMIN_PIN`，已有库重启不再需要它。

数据库卷为宿主机 `server/data/app.db`。本仓库的样例库不属于正式数据，首次部署应从
空目录开始。

## EasyTier v2.6.4

服务端镜像固定为 `easytier/easytier:v2.6.4`；Android 构建脚本也固定检出同一 tag。
禁止换成 `latest` 或直接构建仓库 HEAD。

在 `.env` 中设置 `EASYTIER_NETWORK_NAME`、`EASYTIER_NETWORK_SECRET`，然后启动：

```bash
docker compose --profile easytier up -d --build
docker compose logs --tail=100 easytier
docker exec sandwich-easytier easytier-cli peer
```

sidecar 需要宿主机 `/dev/net/tun` 和 `NET_ADMIN`。服务器虚拟 IP 默认
`10.126.126.1`。Android 客户端使用 `--dhcp`，不再为每台手机手工分配 `.11/.12`，
可避免地址冲突；App 内 EasyTier 以内嵌 `--no-tun --socks5` 模式运行。

如宿主机直装，也必须使用 v2.6.4：

```bash
sudo easytier-core \
  --hostname sandwich-server \
  --ipv4 10.126.126.1 \
  --network-name <门店网络名> \
  --network-secret <组网密码> \
  --peers tcp://<可公网访问的自建节点>:11010
```

自建公共节点同样固定镜像：

```bash
docker run -d --name easytier-public --net=host \
  easytier/easytier:v2.6.4 \
  --listeners tcp://0.0.0.0:11010 udp://0.0.0.0:11010
```

客户端、Android 服务端和 Docker 服务端必须使用同一组可达初始节点。历史示例域名
`public.easytier.cn` 当前无可用 DNS 记录，不得作为生产默认值；自建节点需配置公网 DNS、
放行对应 TCP/UDP 端口并纳入可用性监控。

## APK 构建与安装

在受控构建机设置组网和签名 secret，构建内核并执行统一验证：

```bash
export SANDWICH_EASYTIER_NETWORK_NAME='<门店网络名>'
export SANDWICH_EASYTIER_NETWORK_SECRET='<组网密码>'
export SANDWICH_EASYTIER_PEERS='tcp://<公共中继 IP>:32147'
export SANDWICH_DEFAULT_SERVER_URL='http://10.126.126.1:8000'
export SANDWICH_RELEASE_STORE_FILE='/绝对路径/release.jks'
export SANDWICH_RELEASE_STORE_PASSWORD='<secret>'
export SANDWICH_RELEASE_KEY_ALIAS='<alias>'
export SANDWICH_RELEASE_KEY_PASSWORD='<secret>'

./android/easytier/build-core.sh
ANDROID_NDK_HOME="$ANDROID_HOME/ndk/<version>" ./android/native-server/build-server.sh
./scripts/verify.sh
```

脚本校验后端、迁移、Web、浏览器流程、Android 单测、release 签名，以及 APK 内仅含
`arm64-v8a/libeasytiercore.so` 与 `libsandwichserver.so`，最后生成 APK 和 SHA-256
文件。签名材料、组网密码和
EasyTier 二进制均被 `.gitignore` 排除，只能从本机或 CI secret 注入。

GitHub Actions 的普通 push/PR 自动执行应用门禁；手动运行 `verify` workflow 时，
`release-apk` 还需要配置 `SANDWICH_RELEASE_STORE_BASE64`、三个 release 密码/别名
secret、两个 EasyTier secret。可选仓库变量 `SANDWICH_DEFAULT_SERVER_URL` 用于覆盖
默认服务器地址。CI 产物同时包含 APK、APK SHA-256 和 EasyTier 构建元数据。

在每台门店设备上核对 SHA-256 后安装。App 会先启动前台服务和 EasyTier，通过本地
SOCKS5 轮询 `http://10.126.126.1:8000/api/health`；健康后才加载登录页。连接页会显示
当前阶段并提供重试和设置入口。

## 加密备份、恢复与后端切换

手机服务端在用户选定的 Storage Access Framework 目录每日生成标准 age 口令加密的
`.swinv.age` 快照，自动备份保留最近 14 份，手动备份不自动删除。文件内清单包含
schema、`store_id`、时间与数据库 SHA-256；恢复会检查 SQLite 完整性、执行迁移并撤销
全部旧 Token。恢复口令至少 12 位，由 Android Keystore 加密保存。

Docker 侧使用同一个 Rust CLI 导入/导出：

```bash
cargo build --release --locked --manifest-path native-server/Cargo.toml
native-server/target/release/sandwich-server backup \
  --db server/data/app.db --output backups/store.swinv.age --passphrase-file /安全路径/recovery.pass
native-server/target/release/sandwich-server inspect-backup \
  --input backups/store.swinv.age --passphrase-file /安全路径/recovery.pass
# 必须先停止旧权威服务端
native-server/target/release/sandwich-server restore \
  --input backups/store.swinv.age --db server/data/app.db --passphrase-file /安全路径/recovery.pass
```

切换顺序固定为：停止旧服务 → 一致导出 → 停止所有客户端写入 → 新端导入 → 比较
`store_id`、库存汇总和流水数量 → 只启动新端。不得让两个副本同时上线。

### 传统 SQLite 运维快照

每天用 SQLite 在线备份 API 创建一致快照：

```bash
mkdir -p backups
sqlite3 server/data/app.db ".backup backups/app-$(date +%F-%H%M).db"
sqlite3 backups/app-$(date +%F-%H%M).db "PRAGMA integrity_check;"
```

备份文件和 `.env` 应存入受控、加密且与服务器分离的位置。`SECRET_KEY` 丢失不会让
数据库不可读，但会使已签发 token 全部失效；保留它可维持会话连续性。

恢复演练应在维护窗口执行，并记录恢复前后流水总数与库存汇总：

```bash
docker compose stop app
cp server/data/app.db server/data/app.db.pre-restore
cp backups/<已验证备份>.db server/data/app.db
sqlite3 server/data/app.db "PRAGMA integrity_check;"
docker compose run --rm app alembic upgrade head
docker compose up -d app
curl --fail http://localhost:8000/api/health
```

确认库存汇总和 `stock_movements` 一致后才结束演练；`app.db.pre-restore` 在确认无误后
转移到受控备份目录，不要直接删除。

## 升级

### 消耗看板与十分位数量（20260908_09）

`1.15.1-vps-consumption-tenths` 同时发布消耗看板和所有单位的一位小数数量。
数量字段在 SQLite 中由整单位迁移为整数十分位，API 仍返回原单位。迁移必须与新版
程序一起上线；旧程序不能直接读取新版数据库。先对生产一致备份演练恢复和迁移，
按十分位归一化后逐表核对全部字段、记录数量及完整性，再停止服务、生成最终备份并
迁移权威库。确认数据一致后启动新程序，检查健康接口 schema 与角色权限。

发生新写入后禁止恢复升级前备份作为普通应用回滚，以免丢失新流水。数据库中含小数时
Alembic 拒绝有损降级；应修复当前版本并保留新版数据。VPS 本次发布 Web/PWA 与 Rust
服务，独立 Android 本机后端需另行构建并通过签名 APK 门槛。

1. 在线备份数据库，并记录当前 Git commit、镜像版本、APK SHA-256 和流水数量。
2. 在测试副本运行 `SKIP_ANDROID=1 ./scripts/verify.sh` 和恢复演练。
3. 拉取明确的 release/commit；不要跟随任意分支 HEAD。
4. `docker compose build app && docker compose up -d app`；入口自动执行迁移。
5. 检查 `/api/health`、容器日志、登录和库存流水，再决定是否发布匹配的新 APK。
6. 回滚应用时不可直接降级数据库；应恢复升级前备份并再次核对流水。

## 安全与诊断

- 8000 仅向店内网或 EasyTier 虚拟网开放，不直接暴露公网。
- release WebView 禁用调试、备份、文件访问和非配置源导航。
- 登录失败限流为账号 + 来源 IP 持久化记录；遇到 `429` 按 `Retry-After` 等待。
- 修改/重置 PIN、停用或降权会让旧 token 失效，这是预期行为。
- 组网异常先查 `docker compose logs easytier`、`easytier-cli peer`，再查手机
  `adb logcat -s NodeService:I EasyTierCore:I BackupCoordinator:E`。
- App 显示已组网但健康检查失败时，核对 server URL、`/api/health`、服务端虚拟 IP、
  网络名和密码；无需为手机检查静态虚拟 IP。

完整现场步骤和 24 小时放行标准见 [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md)。
