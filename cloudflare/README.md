# Cloudflare Workers 本地兼容实现（远程环境已退役）

这一目录保留与 Rust 后端一致的 Workers Runtime API 和 D1 迁移基线。正式流量已迁至
VPS。`sandwich-inventory-web`、`sandwich-inventory-api` 两个 Pages 项目及
`sandwich-inventory` D1 已于 2026-09-03 删除；Cloudflare 只继续托管生产域名的 DNS。
当前 `wrangler.jsonc` 已移除生产路由并使用空数据库 ID，只供本地验证，不可直接远程部署。
该实现不使用 R2，也不提供报损图片上传；报损只保留原因和文字描述。

## 本地验证

```bash
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
# 将两个值替换为本地测试值；TOKEN_SECRET 至少 32 个字符，PIN 为 4-6 位数字
npm run cf:migrate:local
npm run cf:test
npm run cf:check
npm run cf:dev
```

首次读取登录用户时，空库会用 `BOOTSTRAP_ADMIN_PIN` 创建 `admin`，并强制首次改 PIN。`TOKEN_SECRET`、`BOOTSTRAP_ADMIN_PIN` 不得写入 `wrangler.jsonc` 或提交到 Git。

## 重新建立独立 Cloudflare 环境

以下步骤仅供未来明确决定重新启用 Cloudflare 后端时参考。执行前必须创建全新的 D1，
填写新 ID，并重新完成数据迁移、只读切换和全量验收；不得直接恢复已经删除的资源 ID。

部署 token 至少需要以下权限：账户级 `Workers Scripts:Edit`、`D1:Edit`、`Cloudflare Pages:Edit`，以及目标 Zone 的 `Workers Routes:Edit`、`DNS:Edit`。已有的仅 DNS 编辑 token 不足以创建 D1。

```bash
npx wrangler login
npx wrangler d1 create sandwich-inventory
```

把命令返回的 `database_id` 填入 `wrangler.jsonc`，然后执行：

```bash
npx wrangler d1 migrations apply sandwich-inventory --remote --config cloudflare/wrangler.jsonc
npx wrangler pages project create sandwich-inventory-web --production-branch main
npx wrangler pages deploy web --project-name sandwich-inventory-web --branch main
npx wrangler pages project create sandwich-inventory-api --production-branch main
npx wrangler pages deploy pages-api --project-name sandwich-inventory-api --branch main
```

在 API Pages 项目的生产与预览环境中绑定 D1 变量 `DB`，并配置 `TOKEN_SECRET`、`BOOTSTRAP_ADMIN_PIN` 两个 secret 以及 `APP_VERSION`、`STORE_TIMEZONE`、`ALLOWED_ORIGIN`。`pages-api/_worker.js` 只是高级模式入口，业务实现仍在 `cloudflare/src/index.ts`。

迁移只读开关为 `MIGRATION_READ_ONLY=1`。开启后非 GET/HEAD/OPTIONS 请求返回
`503 migration_read_only` 与 `Retry-After`。正式域名目前是指向 VPS 的 DNS-only A
记录，不得在未停写、迁移和验收的情况下重新绑定 Pages 或 Worker。

若执行灾难恢复并重新启用该实现，必须先停止 VPS 写入、创建新 D1、将 VPS 数据反向迁移、
完成清单核对，再重新绑定域名；禁止把 DNS 直接切到空库或陈旧副本。

如需测试库存品，可仅在本地执行 `npx wrangler d1 execute sandwich-inventory --local --file cloudflare/seed-dev.sql --config cloudflare/wrangler.jsonc`。不要向正式库运行该种子文件。
