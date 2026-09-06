#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
target=x86_64-unknown-linux-musl
output_dir="$project_dir/dist/vps"
binary="$project_dir/native-server/target/$target/release/sandwich-server"

command -v cargo-zigbuild >/dev/null || { echo "缺少 cargo-zigbuild" >&2; exit 1; }
command -v zig >/dev/null || { echo "缺少 zig" >&2; exit 1; }
rustup target list --installed | grep -qx "$target" || rustup target add "$target"

cargo fmt --manifest-path "$project_dir/native-server/Cargo.toml" -- --check
cargo test --locked --manifest-path "$project_dir/native-server/Cargo.toml"
cargo zigbuild --release --locked --target "$target" --manifest-path "$project_dir/native-server/Cargo.toml"

mkdir -p "$output_dir"
install -m 0755 "$binary" "$output_dir/sandwich-server"
sha256=$(shasum -a 256 "$output_dir/sandwich-server" | awk '{print $1}')
source_commit=$(git -C "$project_dir" rev-parse HEAD)
source_state=clean
git -C "$project_dir" diff --quiet && git -C "$project_dir" diff --cached --quiet || source_state=dirty

{
  echo "source_commit=$source_commit"
  echo "source_state=$source_state"
  echo "target=$target"
  echo "crate_version=$(sed -nE 's/^version = "([^"]+)"/\1/p' "$project_dir/native-server/Cargo.toml" | head -1)"
  echo "rustc=$(rustc --version)"
  echo "cargo=$(cargo --version)"
  echo "cargo_zigbuild=$(cargo-zigbuild --version)"
  echo "zig=$(zig version)"
  echo "binary_sha256=$sha256"
  echo "binary_file=$(file "$output_dir/sandwich-server")"
} > "$output_dir/build-metadata.txt"

printf '%s  %s\n' "$sha256" sandwich-server > "$output_dir/sandwich-server.sha256"
cat "$output_dir/build-metadata.txt"
