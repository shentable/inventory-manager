# jniLibs — 内嵌 easytier-core 内核放置目录

运行 `android/easytier/build-core.sh` 后会生成：

```
jniLibs/
├── arm64-v8a/libeasytiercore.so    # 绝大多数现代手机（必选）
├── armeabi-v7a/libeasytiercore.so  # 老旧 32 位手机（可选）
└── x86_64/libeasytiercore.so       # 模拟器（可选）
```

文件实为按 Android ABI 交叉编译的 **easytier-core 可执行文件**，
命名为 `lib*.so` 是为了让 APK 打包系统把它提取到 `nativeLibraryDir`
（带可执行权限），App 运行时以进程方式拉起（`--no-tun --socks5` 模式）。

体积提示：每个 ABI 约 20–40MB（strip 后更小）。只发真机包可仅保留 arm64-v8a。

*.so 体积大且可复现，已加入 .gitignore，不纳入版本库。
