#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "provision.sh must run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -qF '/swapfile none swap sw 0 0' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab

apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg sqlite3 ufw

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id sandwich >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/sandwich --shell /usr/sbin/nologin sandwich
fi
install -d -o root -g root -m 0755 /opt/sandwich /opt/sandwich/bin
install -d -o sandwich -g sandwich -m 0700 /var/lib/sandwich /var/backups/sandwich
install -d -o root -g sandwich -m 0750 /etc/sandwich
install -d -o caddy -g caddy -m 0750 /var/log/caddy

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable caddy
echo "VPS runtime prerequisites installed; no project compilation was performed."
