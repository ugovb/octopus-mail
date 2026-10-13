#!/usr/bin/env bash
# Octopus Mail — instalacja serwera domowego.
# Raspberry Pi OS (64-bit), Debian, Ubuntu i inne Linuksy z systemd; procesor arm64 albo x86_64.
#
#   sudo ./install.sh                 instaluje albo aktualizuje (konta i poczta zostają)
#   sudo OCTO_PORT=9000 ./install.sh  inny port niż 8787
#   sudo ./install.sh --uninstall     usuwa program i usługę (dane zostają w ~/.config/Octopus Mail)
#
# Serwer działa jako zwykły użytkownik, który uruchomił sudo (np. "pi"), więc polecenie `octo`
# w jego sesji SSH widzi te same konta. Node.js 24 trafia do /opt/octopus-mail/node — systemowy
# Node (jeśli jest) zostaje nietknięty.
set -euo pipefail

APP=/opt/octopus-mail
UNIT=/etc/systemd/system/octopus-mail.service
NODE_MAJOR=24
PORT="${OCTO_PORT:-8787}"
SRC="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\033[1;35m»\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mBłąd:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "uruchom przez sudo:  sudo ./install.sh"
command -v systemctl >/dev/null || die "ten instalator wymaga systemd (dla Dockera zobacz deploy/docker-compose.yml)"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now octopus-mail 2>/dev/null || true
  rm -f "$UNIT" /usr/local/bin/octo
  systemctl daemon-reload
  rm -rf "$APP"
  say "Usunięto program. Dane (konta, poczta) zostały w katalogu ~/.config/Octopus Mail użytkownika serwera."
  exit 0
fi

RUN_USER="${OCTO_USER:-${SUDO_USER:-}}"
[ -n "$RUN_USER" ] && [ "$RUN_USER" != "root" ] || die "nie wiem, jako kto uruchomić serwer. Podaj użytkownika:  sudo OCTO_USER=pi ./install.sh"
id "$RUN_USER" >/dev/null 2>&1 || die "nie ma użytkownika $RUN_USER"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

case "$(uname -m)" in
  aarch64 | arm64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  armv7l | armv6l) die "32-bitowy system ARM nie jest obsługiwany. Wgraj 64-bitowy Raspberry Pi OS (Raspberry Pi 3, 4, 5, Zero 2 W)." ;;
  *) die "nieobsługiwany procesor: $(uname -m)" ;;
esac

[ -f "$SRC/out/cli/octo.js" ] || die "brak plików programu obok instalatora (out/cli/octo.js). Rozpakuj całe archiwum octopus-mail-server-*.tar.gz."

missing=""
for pair in curl:curl xz:xz-utils sha256sum:coreutils tar:tar; do
  command -v "${pair%%:*}" >/dev/null || missing="$missing ${pair#*:}"
done
if [ -n "$missing" ]; then
  command -v apt-get >/dev/null || die "zainstaluj brakujące programy:$missing"
  say "Instaluję:$missing"
  apt-get update -qq && apt-get install -y -qq $missing
fi

# --- Node.js (prywatna kopia) ---
if "$APP/node/bin/node" -e "process.exit(+process.versions.node.split('.')[0] >= $NODE_MAJOR ? 0 : 1)" 2>/dev/null; then
  say "Node.js $("$APP/node/bin/node" -v) już jest"
else
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "nie mogę pobrać listy wersji Node.js ($base)"
  file="$(printf '%s\n' "$sums" | grep -o "node-v[0-9.]*-linux-$ARCH\.tar\.xz" | head -n1)"
  [ -n "$file" ] || die "nie znalazłem Node.js $NODE_MAJOR dla linux-$ARCH"
  sum="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "Pobieram $file"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$sum  $tmp/$file" | sha256sum -c --quiet - || die "suma kontrolna Node.js się nie zgadza"
  rm -rf "$APP/node"
  mkdir -p "$APP/node"
  tar -xJf "$tmp/$file" -C "$APP/node" --strip-components=1
fi
NODE="$APP/node/bin/node"
export PATH="$APP/node/bin:$PATH"

# --- program ---
if systemctl is-active --quiet octopus-mail; then
  say "Zatrzymuję działający serwer na czas aktualizacji"
  systemctl stop octopus-mail
fi
say "Kopiuję program do $APP/app"
rm -rf "$APP/app.new"
mkdir -p "$APP/app.new"
cp -r "$SRC/out" "$SRC/package.json" "$SRC/package-lock.json" "$APP/app.new/"
(cd "$APP/app.new" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || die "npm nie zainstalował zależności"
rm -rf "$APP/app"
mv "$APP/app.new" "$APP/app"

cat >/usr/local/bin/octo <<SH
#!/bin/sh
# Octopus Mail CLI (serwer domowy). Te same konta co usługa octopus-mail.
export OCTO_SECRETS=server
exec "$NODE" "$APP/app/out/cli/octo.js" "\$@"
SH
chmod 755 /usr/local/bin/octo

# --- usługa systemd ---
sed -e "s|@USER@|$RUN_USER|g" -e "s|@HOME@|$RUN_HOME|g" -e "s|@NODE@|$NODE|g" -e "s|@APP@|$APP|g" -e "s|@PORT@|$PORT|g" \
  "$SRC/octopus-mail.service" >"$UNIT"
systemctl daemon-reload
systemctl enable --now octopus-mail >/dev/null

say "Czekam, aż serwer wystartuje…"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 || die "serwer nie odpowiada. Zobacz log:  journalctl -u octopus-mail -n 50"

host="$(hostname)"
ips="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -n3 | sed "s|.*|http://&:$PORT|" | tr '\n' ' ')"
code="$(runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" /usr/local/bin/octo server pair --name "Pierwsze urządzenie" 2>/dev/null | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' | head -n1 || true)"

cat <<TXT

  Octopus Mail — serwer domowy działa (uruchamia się sam po restarcie).

  Adres:  http://$host.local:$PORT  ${ips}
  Kod parowania (15 min):  ${code:-uruchom: octo server pair}

  Komputer:  Octopus Mail → Ustawienia → Serwer domowy → adres + kod
  Telefon:   otwórz adres w przeglądarce, wpisz kod, potem „Dodaj do ekranu głównego”

  Kolejny kod:   octo server pair
  Urządzenia:    octo server devices
  Log:           journalctl -u octopus-mail -f
  Aktualizacja:  rozpakuj nowe archiwum i uruchom ponownie sudo ./install.sh

TXT
