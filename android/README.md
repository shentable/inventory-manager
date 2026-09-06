# Android 客户端

门店受控设备使用的 Kotlin WebView 壳。目标是 Android 10+（`minSdk 29`）且仅
`arm64-v8a`。同一 APK 可作 DHCP 客户端，也可在专用常供电设备上运行内嵌 Rust 后端并
使用固定 EasyTier IP `10.126.126.1`。不实现双活、离线写入同步或冲突合并。

客户端会保留已成功读取的门店数据。网络中断时继续显示缓存，并明确进入“数据未同步、离线只读”状态；所有写操作直接拒绝且不会排队。网络恢复后先用各接口的 ETag 做条件校验，只更新发生变化的资源，完成后再恢复写操作。

## Cloudflare IPv6 DDNS（服务端模式）

店内服务端可把当前 Wi-Fi 的公网 IPv6 自动写入 Cloudflare AAAA 记录。设置页需要：

- 完整域名，例如 `inventory.example.com`；
- Cloudflare Zone ID；
- 一个仅授权该 Zone 的 `DNS: Edit` API Token。

API Token 只在首次配置或主动替换时输入，使用 Android Keystore 加密保存，之后不会在界面、日志或状态中回显。服务端启动时立即同步，随后每 5 分钟检查一次；优先选择非临时、未弃用的 Wi-Fi 全球单播 IPv6。同步状态会保存在服务端设置页，并在持续失败时显示前台通知。

DDNS 只负责域名指向，不会自动开放路由器 IPv6 入站。若域名用于 EasyTier 初始节点，
AAAA 记录必须关闭 Cloudflare 代理（灰云）；若改为下述公网 HTTPS 方案，才开启橙云代理。

### 公网 HTTPS

服务端支持在保留 `127.0.0.1:8000` 本机入口的同时监听公网 IPv6 HTTPS，默认端口为
Cloudflare 支持且相对少用的 `2096`。在 Cloudflare
`SSL/TLS → Origin Server` 创建覆盖 DDNS 域名的 Origin CA 证书，将证书和私钥在服务端
设置页各粘贴一次；两者由 Android Keystore 加密保存并且不回显。Cloudflare 配置要求：

- AAAA 记录开启代理（橙云）；
- SSL/TLS encryption mode 使用 `Full (strict)`；
- 路由器 IPv6 入站允许所选端口（默认 TCP `2096`）到服务端设备。

完成后客户端关闭 EasyTier，服务器地址填写 `https://<域名>:2096`。如果公网健康检查
失败，客户端保持离线只读，不回落到任何本机数据库。

配置页提供两个互不混淆的诊断按钮：“测试服务器 URL（直连）”不经过 EasyTier；
“测试 EasyTier 全链路”会临时使用表单内网络名、密码和初始节点启动内核，并经 SOCKS5
请求同一个 `/api/health`，结束后恢复已保存的客户端组网进程。

### 公共 EasyTier 中继（当前推荐）

店内服务手机和所有客户端都主动连接独立公共 EasyTier 中继，例如
`tcp://<中继公网 IP>:32147`，因此不再要求服务手机开放公网端口、配置 DDNS 或允许
IPv6 入站；无法建立 P2P 时流量自动经
中继转发。中继必须使用独立网络名、独立随机密钥和独立虚拟网段，不能与已有管理网络
共用身份。业务 URL 仍固定为 `http://10.126.126.1:8000`，并经本机 SOCKS5 进入虚拟网。

## 运行行为

- 前台服务保存期望组网配置，进程被系统恢复后会重新启动内核
- 内核异常退出时有上限退避重启；通知在健康探测成功前只显示“正在连接”
- App 经本地 SOCKS5 重复请求 `/api/health`，成功后才加载 WebView
- 失败页显示诊断信息，并提供重试与设置
- release 禁用 WebView 调试、系统备份、文件/内容访问和非配置源导航
- `NodeService` 分别监督 EasyTier 与 Rust 子进程，持有 partial WakeLock 并开机恢复
- 服务端只监听 `127.0.0.1:8000`；远端由 EasyTier no-tun TCP 代理进入
- 每日 age 加密一致快照保留 14 份；原生管理菜单提供手动备份和受控恢复

## 构建环境

- JDK 17、Android SDK 34、NDK、Rust stable、cargo-ndk
- AGP 8.7.3、Kotlin 2.0.21、Gradle wrapper 8.10.2
- EasyTier 构建详情见 [easytier/README.md](easytier/README.md)

Debug 构建可不含内核：

```bash
./gradlew testDebugUnitTest assembleDebug
```

正式构建需先注入门店参数和签名材料：

```bash
export SANDWICH_EASYTIER_NETWORK_NAME='<网络名>'
export SANDWICH_EASYTIER_NETWORK_SECRET='<组网密码>'
export SANDWICH_EASYTIER_PEERS='tcp://<中继公网 IP>:32147'
export SANDWICH_DEFAULT_SERVER_URL='http://10.126.126.1:8000'
export SANDWICH_RELEASE_STORE_FILE='/绝对路径/release.jks'
export SANDWICH_RELEASE_STORE_PASSWORD='<secret>'
export SANDWICH_RELEASE_KEY_ALIAS='<alias>'
export SANDWICH_RELEASE_KEY_PASSWORD='<secret>'

./easytier/build-core.sh
ANDROID_NDK_HOME="$ANDROID_HOME/ndk/<version>" ./native-server/build-server.sh
cd ..
./scripts/verify.sh
```

不要用 Android Studio 的普通 `assembleRelease` 结果直接交付；根级验证脚本还会检查
单测、签名、ABI、内核内容并生成 APK SHA-256。签名密钥、密码、组网凭据和内核文件
都不得提交到 Git。

当前版本：`versionCode 18`、`versionName 1.9.0-shantech-brand`。每次门店发布必须继续递增并
记录 APK、EasyTier、Rust 后端 SHA-256，以及 Rust/NDK/API/schema 版本。

## 主要源码

- `MainActivity.kt`：设置、健康轮询、安全 WebView 与导航限制
- `HealthProbe.kt`：直连或经本地 SOCKS5 探测健康接口
- `EasyTierCore.kt`：固定参数组装和子进程管理
- `NodeService.kt`：双子进程前台保活、开机恢复、状态与异常重启
- `EasyTierHelper.kt`：组网配置与 WebView 代理
- `NativeServerCore.kt`：Rust 后端初始化与进程参数
- `BackupCoordinator.kt`：SAF 自动/手动备份与恢复
- `SecureStore.kt`：Android Keystore 加密敏感配置
