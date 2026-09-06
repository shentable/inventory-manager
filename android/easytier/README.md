# EasyTier v2.6.4 内嵌内核

Android 客户端把 EasyTier `easytier-core` 固定版本构建为
`app/src/main/jniLibs/arm64-v8a/libeasytiercore.so`。运行参数包含
`--dhcp --no-tun --socks5 127.0.0.1:10808`；WebView 和健康探测经该 SOCKS5 访问
服务器。DHCP 避免多台手机复用静态 `.11` 地址。

## 构建

需要 Rust stable、Android NDK 和 cargo-ndk：

```bash
rustup default stable
cargo install cargo-ndk
export ANDROID_NDK_HOME='<Android SDK>/ndk/<版本>'
./build-core.sh
```

脚本始终检出官方 tag `v2.6.4`，只构建 `aarch64-linux-android`，不会克隆 HEAD。
输出包括：

- `app/src/main/jniLibs/arm64-v8a/libeasytiercore.so`
- `easytier/build-metadata.txt`：tag、Git commit、二进制 SHA-256、Rust 与
  cargo-ndk 版本

内核与构建元数据属于产物，不提交 Git。交付前由根目录 `scripts/verify.sh` 再检查 APK
只包含这一份 arm64 内核。

## 参数注入

正式包从环境变量读取：

```bash
export SANDWICH_EASYTIER_NETWORK_NAME='<门店网络名>'
export SANDWICH_EASYTIER_NETWORK_SECRET='<组网密码>'
export SANDWICH_EASYTIER_PEERS='tcp://<可公网访问的自建节点>:11010'
export SANDWICH_DEFAULT_SERVER_URL='http://10.126.126.1:8000'
```

`EASYTIER_PEERS` 是客户端与店内服务端共同使用的初始节点列表，不能留空。多个节点用
逗号、空格或换行分隔。不要依赖历史示例中的 `public.easytier.cn`：该域名当前没有可用
的 A/AAAA 记录。应部署并监控自有共享节点，或填入已经确认可达的受控节点。

组网密码会进入 APK，可被受控设备的持有人提取；这只适用于本轮门店受控设备假设。
设备丢失或人员离店时应轮换网络名/密码并重新发布 APK。

## 生命周期与排错

`NodeService` 使用 `START_STICKY`，保存最后配置并在系统重启服务时恢复。内核异常
退出采用受限指数退避重启，显式停止不会误重启。通知只有在 `/api/health` 经 SOCKS5
成功后才标记已连接。

```bash
adb logcat -s NodeService:I EasyTierCore:I
docker exec sandwich-easytier easytier-cli peer
curl http://10.126.126.1:8000/api/health
```

持续失败时依次核对：APK 内核 ABI、网络名/密码、初始节点 DNS 与端口连通性、服务端虚拟 IP、
后端健康接口。客户端地址由 DHCP 分配，无需核对或手工填写静态手机 IP。
