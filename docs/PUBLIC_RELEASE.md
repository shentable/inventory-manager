# GitHub 公开发布检查清单

## 首次公开前

- 确认 `LICENSE`、`NOTICE`、`TRADEMARKS.md`、`THIRD_PARTY_NOTICES.md` 和
  `LICENSES/` 已提交，并运行 `./scripts/check-licenses.sh`。
- 在 Git 全部历史而不只是当前工作区中扫描 `.env`、Token、PIN、签名文件、恢复口令、
  EasyTier 密码、数据库和备份；发现历史泄露时先轮换凭据，再清理历史。
- 确认样例数据不包含真实门店人员、库存、图片、电话号码或其他个人信息。
- 将生产域名、服务器 IP 和运维拓扑是否公开作为独立决策；它们不是密码，但会扩大攻击面。
- 开启 GitHub secret scanning、依赖更新和私有漏洞报告；保护默认分支并要求 CI 通过。
- 在仓库确定最终 URL 后，为实际部署的 Web 界面增加清晰的“源代码”链接，满足 AGPL
  网络服务的源码获取要求。fork 和修改版部署者必须把链接改为其对应源码。

推荐在首次公开前使用 Gitleaks 对完整历史扫描：

```bash
gitleaks git --redact
git log --all --stat
git status --ignored --short
```

## 每次发布

- 记录 Git commit、应用版本、数据库 schema、构建工具版本和二进制 SHA-256。
- 服务端源码与公开运行版本保持对应；网络用户能从界面找到该版本源码。
- APK 必须包含 `assets/legal/` 下的项目许可证、EasyTier LGPL/GPL 文本及第三方声明。
- APK 只包含固定版本 EasyTier 与 Rust 后端内核，不包含真实组网密码、生产 PIN 或恢复口令。
- 发布第三方二进制时保留其许可证、版权声明和对应源码获取方式。
- 修改过 EasyTier 时，发布该修改版本的对应源码与可重复构建材料。

## 品牌与 fork

代码开放不代表品牌开放。公开 fork 或修改版服务应更换“飨拓™”名称和 Logo，只保留
“基于飨拓™库存管理”等事实性来源说明。详细规则见 `TRADEMARKS.md`。
