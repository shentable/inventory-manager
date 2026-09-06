#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="$PROJECT_DIR/server/.venv/bin/python"

[ -x "$PYTHON" ] || { echo "缺少 server/.venv，请先安装 requirements.txt" >&2; exit 1; }
command -v node >/dev/null || { echo "缺少 Node.js" >&2; exit 1; }
[ -d "$PROJECT_DIR/node_modules/@playwright/test" ] || {
  echo "缺少 Playwright 依赖，请先在根目录运行 npm ci" >&2; exit 1;
}

echo "==> 后端测试"
(cd "$PROJECT_DIR/server" && "$PYTHON" -m pytest -q)

echo "==> Rust 原生后端格式、测试与主机构建"
cargo fmt --manifest-path "$PROJECT_DIR/native-server/Cargo.toml" -- --check
cargo test --locked --manifest-path "$PROJECT_DIR/native-server/Cargo.toml"
cargo build --locked --manifest-path "$PROJECT_DIR/native-server/Cargo.toml"
"$PYTHON" "$PROJECT_DIR/scripts/contract_parity.py"
"$PYTHON" "$PROJECT_DIR/scripts/test_d1_conversion.py"

echo "==> Web 语法"
"$PROJECT_DIR/scripts/check-licenses.sh"
node --check "$PROJECT_DIR/web/app.js"
node --check "$PROJECT_DIR/web/js/api.js"
node --check "$PROJECT_DIR/web/js/ui.js"
node --check "$PROJECT_DIR/web/js/i18n.js"
node --check "$PROJECT_DIR/web/js/i18n/en-core.js"
node --check "$PROJECT_DIR/web/js/i18n/en-app.js"
node --check "$PROJECT_DIR/web/sw.js"
node "$PROJECT_DIR/scripts/check-i18n.js"

echo "==> 浏览器端到端测试"
(cd "$PROJECT_DIR" && npm run test:e2e)
(cd "$PROJECT_DIR" && npm run test:e2e:native)

echo "==> 全新数据库迁移"
VERIFY_TMP="$(mktemp -d)"
trap 'rm -rf "$VERIFY_TMP"' EXIT
(
  cd "$PROJECT_DIR/server"
  DATABASE_URL="sqlite:///$VERIFY_TMP/verify.db" \
  SECRET_KEY="verify-secret-key-long-enough" \
  AUTO_SEED=0 \
  "$PYTHON" -m alembic upgrade head
)

if [ "${SKIP_ANDROID:-0}" = "1" ]; then
  echo "==> 按 SKIP_ANDROID=1 跳过 Android 发布门槛"
  exit 0
fi

echo "==> Android release 门槛"
for name in SANDWICH_RELEASE_STORE_FILE SANDWICH_RELEASE_STORE_PASSWORD \
  SANDWICH_RELEASE_KEY_ALIAS SANDWICH_RELEASE_KEY_PASSWORD \
  SANDWICH_EASYTIER_NETWORK_NAME SANDWICH_EASYTIER_NETWORK_SECRET \
  SANDWICH_EASYTIER_PEERS; do
  [ -n "${!name:-}" ] || { echo "缺少发布环境变量：$name" >&2; exit 1; }
done
[ -f "$SANDWICH_RELEASE_STORE_FILE" ] || {
  echo "签名密钥文件不存在：$SANDWICH_RELEASE_STORE_FILE" >&2; exit 1;
}
[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ] || {
  echo "JAVA_HOME 必须指向 JDK 17" >&2; exit 1;
}

CORE="$PROJECT_DIR/android/app/src/main/jniLibs/arm64-v8a/libeasytiercore.so"
[ -f "$CORE" ] || { echo "缺少 EasyTier arm64 内核，请先运行 android/easytier/build-core.sh" >&2; exit 1; }
[ "$(find "$PROJECT_DIR/android/app/src/main/jniLibs" -name 'libeasytiercore.so' | wc -l | tr -d ' ')" = "1" ] || {
  echo "APK 只允许包含一个 arm64 EasyTier 内核" >&2; exit 1;
}
CORE_METADATA="$PROJECT_DIR/android/easytier/build-metadata.txt"
[ -f "$CORE_METADATA" ] || { echo "缺少 EasyTier 构建元数据" >&2; exit 1; }
grep -qx 'easytier_version=v2.6.4' "$CORE_METADATA" || {
  echo "EasyTier 构建版本不是 v2.6.4" >&2; exit 1;
}
RECORDED_SHA="$(sed -n 's/^core_sha256=//p' "$CORE_METADATA")"
if command -v sha256sum >/dev/null; then
  ACTUAL_SHA="$(sha256sum "$CORE" | awk '{print $1}')"
else
  ACTUAL_SHA="$(shasum -a 256 "$CORE" | awk '{print $1}')"
fi
[ "$RECORDED_SHA" = "$ACTUAL_SHA" ] || {
  echo "EasyTier 内核 SHA-256 与构建记录不一致" >&2; exit 1;
}

NATIVE="$PROJECT_DIR/android/app/src/main/jniLibs/arm64-v8a/libsandwichserver.so"
[ -f "$NATIVE" ] || { echo "缺少 Rust arm64 原生后端，请先运行 android/native-server/build-server.sh" >&2; exit 1; }
[ "$(find "$PROJECT_DIR/android/app/src/main/jniLibs" -name 'libsandwichserver.so' | wc -l | tr -d ' ')" = "1" ] || {
  echo "APK 只允许包含一个 arm64 Rust 后端" >&2; exit 1;
}
NATIVE_METADATA="$PROJECT_DIR/android/native-server/build-metadata.txt"
[ -f "$NATIVE_METADATA" ] || { echo "缺少 Rust 后端构建元数据" >&2; exit 1; }
grep -qx 'native_server_version=1.15.1' "$NATIVE_METADATA"
NATIVE_RECORDED_SHA="$(sed -n 's/^binary_sha256=//p' "$NATIVE_METADATA")"
if command -v sha256sum >/dev/null; then NATIVE_ACTUAL_SHA="$(sha256sum "$NATIVE" | awk '{print $1}')";else NATIVE_ACTUAL_SHA="$(shasum -a 256 "$NATIVE" | awk '{print $1}')";fi
[ "$NATIVE_RECORDED_SHA" = "$NATIVE_ACTUAL_SHA" ] || { echo "Rust 后端 SHA-256 与构建记录不一致" >&2; exit 1; }

(cd "$PROJECT_DIR/android" && ./gradlew --no-daemon clean testDebugUnitTest assembleRelease)
APK="$PROJECT_DIR/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "未生成已签名 release APK" >&2; exit 1; }
unzip -l "$APK" | grep -q 'lib/arm64-v8a/libeasytiercore.so'
unzip -l "$APK" | grep -q 'lib/arm64-v8a/libsandwichserver.so'
for legal_asset in \
  AGPL-3.0-only.txt \
  LGPL-3.0-only.txt \
  GPL-3.0-only.txt \
  NOTICE.txt \
  TRADEMARKS.md \
  THIRD_PARTY_NOTICES.md; do
  unzip -l "$APK" | grep -q "assets/legal/$legal_asset" || {
    echo "APK 缺少许可文件：assets/legal/$legal_asset" >&2
    exit 1
  }
done
if unzip -l "$APK" | grep -Eq 'lib/(armeabi|armeabi-v7a|x86|x86_64)/libeasytiercore.so'; then
  echo "APK 包含非 arm64 内核" >&2
  exit 1
fi

APKSIGNER="$(find "${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1)"
[ -x "$APKSIGNER" ] || { echo "找不到 Android apksigner" >&2; exit 1; }
"$APKSIGNER" verify --verbose "$APK"

mkdir -p "$PROJECT_DIR/artifacts"
cp "$APK" "$PROJECT_DIR/artifacts/sandwich-inventory-pilot.apk"
cp "$PROJECT_DIR/android/easytier/build-metadata.txt" \
  "$PROJECT_DIR/artifacts/easytier-build-metadata.txt"
cp "$PROJECT_DIR/android/native-server/build-metadata.txt" \
  "$PROJECT_DIR/artifacts/native-server-build-metadata.txt"
if command -v sha256sum >/dev/null; then
  (cd "$PROJECT_DIR/artifacts" && sha256sum sandwich-inventory-pilot.apk > sandwich-inventory-pilot.apk.sha256)
else
  (cd "$PROJECT_DIR/artifacts" && shasum -a 256 sandwich-inventory-pilot.apk > sandwich-inventory-pilot.apk.sha256)
fi
echo "发布产物：$PROJECT_DIR/artifacts/sandwich-inventory-pilot.apk"
