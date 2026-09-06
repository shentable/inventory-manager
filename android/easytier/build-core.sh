#!/usr/bin/env bash
# =============================================================================
# 交叉编译 easytier-core 为 Android arm64 的可执行文件，并放入
# android/app/src/main/jniLibs/<abi>/libeasytiercore.so
#
# 为什么伪装成 .so：APK 打包时 jniLibs 下的 lib*.so 会被提取到
# nativeLibraryDir（配合 Gradle useLegacyPackaging=true），且带可执行权限，
# App 可直接 ProcessBuilder 拉起。
#
# 前置条件：
#   1. Rust 工具链（rustup）
#   2. Android NDK（Android Studio SDK Manager 安装，或设 ANDROID_NDK_HOME）
#   3. cargo-ndk：cargo install cargo-ndk
#
# 用法：
#   ./build-core.sh                # 自动克隆 EasyTier 源码到 .easytier-src/
#   ./build-core.sh /path/to/EasyTier   # 使用已有源码目录
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="${1:-$SCRIPT_DIR/.easytier-src}"
JNILIBS="$ANDROID_DIR/app/src/main/jniLibs"
METADATA_DIR="$SCRIPT_DIR"
EASYTIER_VERSION="v2.6.4"

# 门店试运行只支持 arm64 Android 10+
ABIS=("arm64-v8a")
TARGETS=("aarch64-linux-android")

NDK_ROOT="${ANDROID_NDK_HOME:-}"
if [ -z "$NDK_ROOT" ] && [ -n "${ANDROID_HOME:-}" ]; then
  NDK_ROOT="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
[ -d "$NDK_ROOT" ] || {
  echo "!! 请设置 ANDROID_NDK_HOME，或设置包含已安装 NDK 的 ANDROID_HOME" >&2
  exit 1
}
export ANDROID_NDK_HOME="$NDK_ROOT"

if [ ! -d "$SRC_DIR" ]; then
  echo "==> 克隆 EasyTier 源码到 $SRC_DIR"
  git clone --depth 1 --branch "$EASYTIER_VERSION" \
    https://github.com/EasyTier/EasyTier.git "$SRC_DIR"
fi

git -C "$SRC_DIR" fetch --depth 1 origin "refs/tags/$EASYTIER_VERSION:refs/tags/$EASYTIER_VERSION"
git -C "$SRC_DIR" checkout --detach "$EASYTIER_VERSION"
RESOLVED_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD)"

echo "==> 安装 Rust Android targets"
rustup target add "${TARGETS[@]}"

command -v cargo-ndk >/dev/null || {
  echo "==> 安装 cargo-ndk"
  cargo install cargo-ndk
}

cd "$SRC_DIR"

for i in "${!ABIS[@]}"; do
  ABI="${ABIS[$i]}"
  TARGET="${TARGETS[$i]}"
  echo "==> 构建 $ABI ($TARGET)"
  # cargo-ndk 负责设置 NDK linker/sysroot 等环境；
  # 只构建内核可执行文件 easytier-core（不构建 GUI）
  cargo ndk --target "$ABI" --platform 29 build --release --bin easytier-core

  OUT_DIR="$JNILIBS/$ABI"
  mkdir -p "$OUT_DIR"
  BIN="target/$TARGET/release/easytier-core"
  [ -f "$BIN" ] || { echo "!! 未找到产物 $BIN，请检查 EasyTier 仓库结构" >&2; exit 1; }
  cp "$BIN" "$OUT_DIR/libeasytiercore.so"

  # strip 减小体积（NDK strip 工具）
  STRIP="$(find "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt" -path '*/bin/llvm-strip' -type f 2>/dev/null | head -1 || true)"
  [ -n "$STRIP" ] && "$STRIP" "$OUT_DIR/libeasytiercore.so" || true
  echo "    -> $OUT_DIR/libeasytiercore.so ($(du -h "$OUT_DIR/libeasytiercore.so" | cut -f1))"
done

mkdir -p "$METADATA_DIR"
CORE_FILE="$JNILIBS/arm64-v8a/libeasytiercore.so"
if command -v sha256sum >/dev/null; then
  CORE_SHA="$(sha256sum "$CORE_FILE" | awk '{print $1}')"
else
  CORE_SHA="$(shasum -a 256 "$CORE_FILE" | awk '{print $1}')"
fi
{
  echo "easytier_version=$EASYTIER_VERSION"
  echo "easytier_commit=$RESOLVED_COMMIT"
  echo "core_sha256=$CORE_SHA"
  echo "rustc=$(rustc --version)"
  echo "cargo_ndk=$(cargo ndk --version 2>/dev/null | head -1)"
} > "$METADATA_DIR/build-metadata.txt"

echo ""
echo "完成。arm64 内核已放入 $JNILIBS"
echo "构建元数据：$METADATA_DIR/build-metadata.txt"
echo "下一步：在 android/ 下 ./gradlew assembleDebug 打包 APK。"
