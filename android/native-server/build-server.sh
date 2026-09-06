#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CRATE="$PROJECT_DIR/native-server/Cargo.toml"
OUT="$PROJECT_DIR/android/app/src/main/jniLibs/arm64-v8a/libsandwichserver.so"
METADATA="$SCRIPT_DIR/build-metadata.txt"

command -v cargo >/dev/null || { echo "缺少 Rust cargo" >&2; exit 1; }
command -v cargo-ndk >/dev/null || { echo "缺少 cargo-ndk（cargo install cargo-ndk）" >&2; exit 1; }
[ -n "${ANDROID_NDK_HOME:-}" ] || { echo "必须设置 ANDROID_NDK_HOME" >&2; exit 1; }

(
  cd "$(dirname "$CRATE")"
  cargo ndk -t arm64-v8a -P 29 build --release --locked
)
BIN="$PROJECT_DIR/native-server/target/aarch64-linux-android/release/sandwich-server"
[ -f "$BIN" ] || { echo "未生成 Android arm64 原生后端" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
cp "$BIN" "$OUT"

if command -v sha256sum >/dev/null; then SHA="$(sha256sum "$OUT" | awk '{print $1}')";else SHA="$(shasum -a 256 "$OUT" | awk '{print $1}')";fi
{
  echo "native_server_version=1.5.0"
  echo "api_version=1"
  echo "db_schema=20260901_04"
  echo "binary_sha256=$SHA"
  echo "source_git_commit=$(git -C "$PROJECT_DIR" rev-parse HEAD)"
  if command -v sha256sum >/dev/null; then
    echo "cargo_lock_sha256=$(sha256sum "$PROJECT_DIR/native-server/Cargo.lock" | awk '{print $1}')"
  else
    echo "cargo_lock_sha256=$(shasum -a 256 "$PROJECT_DIR/native-server/Cargo.lock" | awk '{print $1}')"
  fi
  echo "rustc_version=$(rustc --version)"
  echo "cargo_ndk_version=$(cargo ndk --version)"
  echo "ndk_home=$ANDROID_NDK_HOME"
} > "$METADATA"
echo "已生成 $OUT"
