#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for path in \
  LICENSE \
  NOTICE \
  TRADEMARKS.md \
  THIRD_PARTY_NOTICES.md \
  LICENSES/LGPL-3.0-only.txt \
  LICENSES/GPL-3.0-only.txt \
  android/app/src/main/assets/legal/AGPL-3.0-only.txt \
  android/app/src/main/assets/legal/LGPL-3.0-only.txt \
  android/app/src/main/assets/legal/GPL-3.0-only.txt \
  android/app/src/main/assets/legal/NOTICE.txt \
  android/app/src/main/assets/legal/TRADEMARKS.md \
  android/app/src/main/assets/legal/THIRD_PARTY_NOTICES.md; do
  test -s "$project_dir/$path" || {
    echo "missing required legal file: $path" >&2
    exit 1
  }
done

grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' "$project_dir/LICENSE"
grep -q 'GNU LESSER GENERAL PUBLIC LICENSE' "$project_dir/LICENSES/LGPL-3.0-only.txt"
grep -q 'GNU GENERAL PUBLIC LICENSE' "$project_dir/LICENSES/GPL-3.0-only.txt"
grep -q '^license = "AGPL-3.0-only"$' "$project_dir/native-server/Cargo.toml"
grep -q '"license": "AGPL-3.0-only"' "$project_dir/package.json"
grep -q '"license": "AGPL-3.0-only"' "$project_dir/package-lock.json"
grep -q 'v2.6.4' "$project_dir/THIRD_PARTY_NOTICES.md"
grep -q 'excluded from the AGPL-3.0-only' "$project_dir/TRADEMARKS.md"

cmp "$project_dir/LICENSE" "$project_dir/android/app/src/main/assets/legal/AGPL-3.0-only.txt"
cmp "$project_dir/LICENSES/LGPL-3.0-only.txt" "$project_dir/android/app/src/main/assets/legal/LGPL-3.0-only.txt"
cmp "$project_dir/LICENSES/GPL-3.0-only.txt" "$project_dir/android/app/src/main/assets/legal/GPL-3.0-only.txt"
cmp "$project_dir/NOTICE" "$project_dir/android/app/src/main/assets/legal/NOTICE.txt"
cmp "$project_dir/TRADEMARKS.md" "$project_dir/android/app/src/main/assets/legal/TRADEMARKS.md"
cmp "$project_dir/THIRD_PARTY_NOTICES.md" "$project_dir/android/app/src/main/assets/legal/THIRD_PARTY_NOTICES.md"

echo "license metadata check passed"
