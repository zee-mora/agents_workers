#!/usr/bin/env bash
# Tarik dump DB dari VPS monitor (GET /api/wo/db-dump, hanya DB di ORCH_DUMP_DBS server) lalu restore ke DB lokal.
# Env dari worker: VPS_URL, WORKER_TOKEN. Dari .env worker: SYNC_MYSQL_USER, SYNC_MYSQL_PASSWORD.
# Pakai: sync-db.sh <db-di-server> <db-lokal> [--dump-only]
set -euo pipefail
remote_db=$1; local_db=$2; mode=${3:-}
[[ $remote_db =~ ^[A-Za-z0-9_]+$ && $local_db =~ ^[A-Za-z0-9_]+$ ]] || { echo "nama DB tidak valid" >&2; exit 2; }
: "${VPS_URL:?}" "${WORKER_TOKEN:?}"

# Simpan dulu ke file sementara: restore hanya jika dump utuh (gzip valid dan tidak kosong).
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
curl -fsS --max-time 1500 -H "Authorization: Bearer $WORKER_TOKEN" "${VPS_URL%/}/api/wo/db-dump?db=$remote_db" -o "$tmp"
gzip -t "$tmp"
[[ $(stat -c %s "$tmp") -gt 200 ]] || { echo "dump terlalu kecil, dibatalkan" >&2; exit 1; }
if [[ $mode == --dump-only ]]; then echo "dump OK: $(stat -c %s "$tmp") byte (gz), tidak direstore"; exit 0; fi

: "${SYNC_MYSQL_USER:?isi SYNC_MYSQL_USER di .env worker}"
# Password boleh kosong (mis. root XAMPP tanpa password); MYSQL_PWD hanya diset jika ada isinya.
if [[ -n ${SYNC_MYSQL_PASSWORD:-} ]]; then export MYSQL_PWD=$SYNC_MYSQL_PASSWORD; fi
gunzip -c "$tmp" | mysql -u"$SYNC_MYSQL_USER" "$local_db"
echo "sync selesai: $(stat -c %s "$tmp") byte (gz)"
