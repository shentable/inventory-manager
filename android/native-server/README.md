# Android 原生后端

`build-server.sh` 将根目录 `native-server` 交叉编译为 Android 10+ arm64 可执行文件，
并以 `libsandwichserver.so` 名称放入 APK 的 `jniLibs`。它不是 JNI 库，而是由
`NodeService` 启动的独立 Axum 进程；只允许监听 `127.0.0.1:8000`。

```bash
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/<version>"
./android/native-server/build-server.sh
```

二进制与构建元数据被 `.gitignore` 排除，发布流水线必须现场构建并核对 SHA-256。
