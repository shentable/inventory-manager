# 飨拓™库存管理

面向单门店试运行的库存管理 Web 应用与 Android App。中心化部署可使用 VPS 上的
Rust/Axum + SQLite，由 Caddy 提供同源 HTTPS；DNS 可由任意兼容服务商托管。
后端也可选 Docker/FastAPI，或由一台
专用 Android 设备运行内嵌 Rust/Axum 后端；两者共享 SQLite 结构且任一时刻只能有一个
权威服务端。Android 10+ arm64 设备通过内嵌 EasyTier v2.6.4 加入门店虚拟网络。

## 当前能力

- 每日盘点：只包含库存品中勾选“每日盘点”的项目；店员逐项左右滑确认“够 / 不够”，“不够”必须填写现场数量，“够”可选填，作为当日补货信号且不直接改库存
- 每日盘点结果：全员按时间查看够用/缺货汇总、数量填写覆盖率，并可展开查看逐项现场数量
- 每周盘点工作区：只包含勾选“每周盘点”的项目；“提交盘点 / 我的记录”集中完成独立提交、查看和处理前编辑
- 盘点管理工作台：店长/管理员在“待比对 / 盘点记录 / 确认结果”一处查看原始记录、选择两份独立记录、确认调账并追溯结果
- 报损：店员登记，店长确认后按 FEFO 原子扣减
- 入库：管理员和店长可直接登记到货数量、批次效期与备注
- 采购：店长下单、到货登记批次与效期
- 库存流水：直接入库、采购入库、盘盈、盘亏和报损均写入不可变流水
- 安全登录：点选用户 + 4–6 位 PIN、首次强制改 PIN、登录限流、Token 即时撤销
- 交付：Alembic 迁移、浏览器自动化、Android 单测、release APK 内容与签名校验
- 可选手机服务端：回环监听、固定虚拟 IP、开机恢复、age 加密备份与双向迁移工具
- VPS 中心模式：静态 musl Rust 后端内嵌 PWA、SQLite、Caddy 自动证书和每日 age 加密备份
- 中英双语：Web 可在登录页或首页切换中文/English，Android 壳跟随系统语言
- Cloudflare 旧应用环境已退役：Pages 项目与 D1 已于 2026-09-03 删除，仅保留 DNS 托管

角色边界：`staff` 可做每日盘点、独立提交每周盘点、报损和查看库存；`manager` 也可提交每周盘点，
并可确认由另外两人提交的配对盘点，另有直接入库、采购与库存品管理；`admin` 可直接入库，负责配对确认和用户管理，不提交每周盘点。
系统不提供绕过流水的手工库存调整。

盘点导航按任务归并：“盘点汇总”与“近3天盘点”已收入“盘点管理 · 盘点记录”，三天仅作为默认时间筛选；
“比对盘点”已收入“盘点管理 · 待比对”的页内处理动作。旧链接会按身份自动跳转到每周盘点或管理工作台。
每日够/不够及其今日结果保持独立，因为它们不参与库存调账。

## 快速开始

需要 Docker Engine 与 Compose v2。首次空库只创建一个临时管理员，PIN 来自环境变量；
首次登录必须修改 PIN。

```bash
cp .env.example .env
secret="$(openssl rand -hex 32)"
# 编辑 .env：填入上面的 SECRET_KEY，并设置临时 BOOTSTRAP_ADMIN_PIN
docker compose up -d --build
curl http://localhost:8000/api/health
```

容器启动时先执行 `alembic upgrade head`，迁移成功后才启动服务。随后用 `admin` 和
`BOOTSTRAP_ADMIN_PIN` 登录，立即修改 PIN，再由管理员创建店长和店员账号。
改 PIN 后可从 `.env` 删除该一次性变量；已有库重启不会再使用它。

显式装载可重复的试运行测试数据（不会随生产启动自动执行）：

```bash
python3 scripts/load-pilot-test-data.py --base-url http://127.0.0.1:8000 --admin-pin '<当前管理员 PIN>'
```

脚本幂等创建 8 类测试库存及 `pilot_manager`、`pilot_staff` 两个临时账号；首次登录仍会强制修改 PIN。

本地验证：

```bash
npm ci
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
npm run cf:test && npm run cf:check # Workers 运行时契约、类型与打包
SKIP_ANDROID=1 ./scripts/verify.sh   # 后端、迁移、Web 语法与浏览器测试
./android/easytier/build-core.sh    # 固定构建 EasyTier v2.6.4 arm64 内核
./android/native-server/build-server.sh # 构建 Rust arm64 原生后端
./scripts/verify.sh                  # 加签 release APK 与内容/校验和验证
```

完整验证需要 JDK 17、Android SDK、Rust/cargo-ndk、release 签名 secret 与 EasyTier 内核。
成功产物为 `artifacts/sandwich-inventory-pilot.apk` 及同名 `.sha256`。

## 项目结构

```text
server/                   FastAPI、SQLAlchemy、Alembic 与后端测试
native-server/            Rust/Axum 兼容后端、共享迁移与加密迁移 CLI
cloudflare/               Workers API、D1 迁移、运行时契约测试和部署配置
pages-api/                API 的 Pages Functions 高级模式入口（运行于 Workers Runtime）
web/                      原生 Web SPA 与 Playwright 测试
android/                  Kotlin 客户端/服务端双模式、EasyTier 与 Rust 内核集成
scripts/verify.sh         统一交付验证入口
docs/API_CONTRACT.md      接口、权限与并发语义
docs/DEPLOY.md            部署、备份与升级
docs/PILOT_RUNBOOK.md     门店试运行操作手册与放行清单
```

## Android 与 EasyTier

- `minSdk 29`，仅允许 `arm64-v8a`
- 客户端使用 EasyTier `--dhcp` 自动分配虚拟 IP，服务器默认固定为 `10.126.126.1`
- 同一 APK 的高级设置可切换客户端/本机服务端；服务端 WebView 直连 `127.0.0.1:8000`
- Rust 后端只监听回环，EasyTier no-tun TCP 代理负责虚拟网入站；不向店内 Wi‑Fi 裸露
- EasyTier 源码和服务端镜像均固定为 `v2.6.4`，构建记录版本、提交和 SHA-256
- App 通过本地 SOCKS5 轮询 `/api/health`，健康后才加载 WebView
- release 包禁用 WebView 调试、备份、文件访问和跨目标站点导航

部署、APK 安装、组网诊断、备份恢复和升级步骤见
[门店试运行手册](docs/PILOT_RUNBOOK.md)。Android 构建细节见
[android/README.md](android/README.md)。

Cloudflare 兼容实现、本地测试和远程资源退役记录见 [cloudflare/README.md](cloudflare/README.md)。
VPS 迁移、加密备份和回滚步骤见 [部署指南](docs/DEPLOY.md)。

## 许可证与品牌

除明确列出的例外外，本项目源代码采用
[GNU Affero General Public License v3.0 only](LICENSE)（SPDX：
`AGPL-3.0-only`）。允许个人和商业使用、修改及部署；分发修改版本，或通过网络向用户
提供修改版本时，必须按 AGPL 提供对应源码和保留许可声明。

“飨拓™”、“飨拓™库存管理”和项目 Logo 不包含在 AGPL 授权中。未修改的官方版本可以
保留品牌；公开 fork、修改版或独立托管服务应更换名称与 Logo，具体见
[品牌与商标政策](TRADEMARKS.md)。

EasyTier 等组件继续适用各自的上游许可证。发布 APK 时必须同时保留 EasyTier 的
LGPL/GPL 文本、第三方声明和对应源码获取方式，详见
[第三方软件声明](THIRD_PARTY_NOTICES.md) 与 [LICENSES](LICENSES)。

准备公开仓库或提交修改前，请阅读 [贡献指南](CONTRIBUTING.md)、
[安全政策](SECURITY.md) 与 [GitHub 公开发布检查清单](docs/PUBLIC_RELEASE.md)。
