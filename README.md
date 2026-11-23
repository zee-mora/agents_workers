# agent-worker

Worker di laptop untuk antrean Work Order (WO) dari VPS Monitor (`server.microspace.id/orders`).
Worker mengambil WO, menjalankan `claude -p` di branch git terpisah pada repo lokal, memeriksa hasilnya dari bukti, lalu melapor balik ke VPS.

Sisi server ada di repo `vps-monitor` (`orchestrator.js`, `docs/orchestrator.md`). Repo ini hanya worker.

## Alur satu WO

1. `GET /api/wo/next?wait=25` (long-poll). VPS menandai WO `IN_PROGRESS` dan memberi lease 120 detik. Worker kirim heartbeat tiap 30 detik. Worker mati: WO kembali `PENDING`, setelah 2 kali `FAILED`.
2. `project_key` diubah jadi path lewat `projects.json`. Tidak ada di daftar: ditolak.
3. Tolak jika `git status` kotor. Buat branch `wo/<id>-<attempt>` dari HEAD.
4. Jalankan `claude -p` lewat `spawn` (tanpa shell) dengan batas budget dan timeout.
5. Baca event `result` dari stream (`--output-format stream-json --verbose`). Token dari `modelUsage`, biaya dari `total_cost_usd`.
6. Bukti, berhenti di yang pertama gagal:
   - `is_error` false. `error_max_budget_usd` jadi `OVER_BUDGET`, error lain `FAILED`.
   - Jawaban memuat `BLOCKED:` jadi `NEEDS_REVIEW`.
   - `git diff` tidak kosong. Kosong jadi `FAILED`.
   - Tidak menyentuh `.env` atau `.git/`. Kalau menyentuh: `NEEDS_REVIEW`.
   - Perubahan di-commit ke branch WO, lalu `verify` dari `projects.json` dijalankan. Gagal: `NEEDS_REVIEW`.
   - Screenshot Playwright (opsional, hanya localhost). Gagal screenshot tidak menggagalkan WO.
7. `POST /api/wo/:id/complete` dengan status, hasil, dan screenshot base64 (maks 2 MB). Worker kembali ke branch semula. Merge dilakukan manusia.

## Setup

Prasyarat: Node 20.12+ (memakai `process.loadEnvFile`, `fetch` bawaan), git, Claude Code 2.1.317+ yang sudah login.

```bash
npm install
npx playwright install chromium
cp .env.example .env                    # isi WORKER_TOKEN
cp projects.json.example projects.json  # isi path repo
npm test                                # selftest, harus: selftest OK
npm start
```

`.env`:
```
VPS_URL=https://server.microspace.id
WORKER_TOKEN=<sama dengan ORCH_WORKER_TOKEN di .env server>
POLL_WAIT=25
```

`projects.json` (tidak di-commit; hanya project di sini yang boleh dikerjakan):
```json
{
  "lapila": {
    "path": "/home/zae/projects/lapila-management-system",
    "verify": "npm test -- --run",
    "url": "http://localhost:8000"
  }
}
```
`db_sync` (opsional): `{ "cmd": "<perintah bash>", "ttl_hours": 6 }`. Sebelum agent jalan, jika sinkron terakhir lebih tua dari `ttl_hours`, worker menjalankan `cmd` (cwd = folder project, tanpa `WORKER_TOKEN`). Gagal = WO `FAILED`, agent tidak jalan. Kredensial DB taruh di script/`~/.my.cnf` laptop, bukan di repo. Contoh: `ssh USER@HOST "mysqldump --single-transaction --quick --no-tablespaces DB | gzip" | gunzip | mysql DB_LOKAL`. Gunakan DB lokal khusus worker karena isinya ditimpa. Siap pakai: `scripts/sync-db.sh <db-di-server> <db-lokal>` menarik `GET /api/wo/db-dump` dari VPS (hanya DB di `ORCH_DUMP_DBS` di env server) dan merestore dengan `SYNC_MYSQL_USER`/`SYNC_MYSQL_PASSWORD` dari `.env` worker; `--dump-only` untuk tes tanpa restore. Contoh `cmd`: `./scripts/sync-db.sh oso_marketing_db oso_new`.

Sumber DB per WO: tambahkan `"sources": ["db_a", "db_b"]` dan `"default": "db_a"` di `db_sync`. UI VPS menampilkan dropdown "Sumber DB" untuk project itu, dan worker menjalankan `cmd` dengan env `DB_SOURCE=<pilihan>` (pakai `"$DB_SOURCE"` di `cmd`). Pilihan di luar `sources` ditolak (WO `FAILED`). Setiap DB harus ada di `ORCH_DUMP_DBS` server. Contoh: `./scripts/sync-db.sh "$DB_SOURCE" hrpresenttracker_12`.

Screenshot: isi `url` (origin dev server, mis. `http://localhost:8000`). Agent diminta menutup jawaban dengan `PAGE: /path`; worker memotret `url`+path itu (tanpa PAGE: halaman `url`) saat repo masih di branch WO, lalu mengirimnya ke VPS. Halaman di balik login: isi `"storage_state": "/path/state.json"` (hasil `context.storageState()` Playwright). Login otomatis (lebih awet dari `storage_state`, yang kedaluwarsa): `"login": { "user": "email@dev", "password": "..." }` (opsional `path` default `/login`, `user_selector`, `password_selector`). Worker login di browser kosong tiap foto. `login.setup` (opsional): perintah bash yang dijalankan di folder project sebelum login untuk memastikan akunnya ada (harus idempotent, mis. `php artisan db:seed --class=DeveloperSeeder --force`). Ditolak jika `DB_HOST` di `.env` project bukan `127.0.0.1`/`localhost`. Pakai akun dev berhak rendah; kredensial hanya di `projects.json` laptop (di-gitignore), tidak dikirim ke VPS dan tidak masuk prompt agent. Tidak mendukung captcha/2FA. Dev server dinyalakan worker hanya selama foto, lalu dimatikan: default `php artisan serve --host=localhost --port=<port dari url>` jika ada `artisan`, atau perintah `"serve"` di `projects.json` (cwd = folder project, tanpa `WORKER_TOKEN`). Port yang sudah terbuka dipakai apa adanya dan tidak dimatikan.

`verify`, `url`, dan `target` opsional. `verify` hanya dari file ini, tidak pernah dari WO.

Permanen dengan PM2:
```bash
pm2 start worker.js --name laptop-runner && pm2 save && pm2 startup
```
Laptop Linux agar tetap jalan saat lid ditutup: `HandleLidSwitch=ignore` di `/etc/systemd/logind.conf`.

## Daftar project di UI

Worker mengirim daftar project (hanya **key dan target**, tanpa path) ke VPS saat start, saat `projects.json` berubah, dan tiap 10 menit. UI memakainya untuk dropdown "Project" di form WO, dan VPS menolak WO ke project yang tidak terdaftar. Worker harus pernah jalan agar WO bisa dibuat.

## UI live (localhost)

Worker membuka `http://127.0.0.1:8787` (ganti dengan `STATUS_PORT` di `.env`). Isinya: status (menunggu / mengerjakan WO / merge / jeda / berhenti), WO dan project aktif, sisa waktu dan budget, serta aktivitas agent yang bergerak live (file yang dibaca/diubah, perintah yang dijalankan). Port dipakai proses lain: worker tetap jalan tanpa UI.

- Tombol **Stop** bersifat graceful: WO atau merge yang sedang berjalan diselesaikan dan dilaporkan, lalu worker berhenti mengambil job. Long-poll yang menunggu dibatalkan; jeda kuota juga dihentikan. Tombol **Start** melanjutkan segera. Tidak ada tombol kill (membuang pekerjaan parsial); darurat: `pm2 stop laptop-runner`.
- Worker selalu aktif saat (re)start. Status berhenti tidak disimpan.
- Hanya bind `127.0.0.1`. `POST /start` dan `/stop` wajib header `X-Worker-UI: 1` dan `Host` localhost (menahan CSRF dari situs lain). Header `Host` juga dicek di semua rute GET, supaya situs lain tidak bisa membaca stream aktivitas lewat DNS rebinding. Token dan path absolut repo tidak tampil.
- Riwayat aktivitas hanya di memori (±500 baris terakhir), hilang saat restart.

## Approve dan merge

Setelah admin menekan **Approve & merge** di `/orders`, VPS membuat job merge dan worker mengambilnya (`kind: "merge"`). Worker me-merge branch `wo/<id>` ke branch `target` project itu, lalu `git push origin <target>`.

- `target` **hanya** dibaca dari `projects.json` laptop. Tanpa `target` project itu tidak bisa di-merge (VPS tidak bisa memaksa). Disarankan `development`, bukan `main`.
- Syarat: working tree bersih, branch WO masih di commit yang direview (`head_sha`), dan `target` lokal bisa fast-forward ke `origin/<target>`.
- Tumpang tindih: jika ada file yang diubah WO **dan** juga diubah di `origin/<target>` sejak WO dibuat (mis. orang lain mengerjakan hal yang sama), merge ditolak dengan `MERGE_FAILED` yang menyebut nama filenya. Buat WO baru dari `<target>` terbaru atau merge manual. Aturan ini lebih ketat dari konflik Git (file yang sama tapi baris berbeda juga ditolak).
- Konflik: `git merge --abort`. Push gagal: target lokal di-reset ke posisi semula. Hasilnya dilaporkan sebagai `MERGE_FAILED` beserta pesannya.
- Claude tidak terlibat dan tidak punya hak push. Yang push hanya kode `processMerge` di `worker.js`, memakai kredensial git di laptop (`GIT_TERMINAL_PROMPT=0`, jadi tidak pernah menunggu input).
- Selama merge, worker berpindah branch di repo laptop lalu kembali ke branch semula. Jangan mengedit repo yang sama saat itu (tree kotor = ditolak).

## Batas dan keamanan (jangan dilonggarkan tanpa alasan)

- Worker tidak mempercayai VPS: budget maksimum $1, timeout maksimum 1800 detik, model hanya `haiku|sonnet|opus`.
- `claude` dijalankan dengan `--allowedTools "Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*),Bash(python3:*)"`. Jangan beri `Bash` bebas. `python3` diizinkan agar agent bisa edit besar lewat skrip; ia tidak dibatasi sandbox, jadi hanya pakai di laptop dev.
- `WORKER_TOKEN` dihapus dari environment proses `claude`.
- URL screenshot hanya `localhost` dan `127.0.0.1`.
- Tidak pernah commit ke branch utama. Rollback = hapus branch `wo/*`.
- Jangan commit `.env` dan `projects.json`.

## Hal yang sudah dipelajari dari Claude Code 2.1.317

- Objek `usage` level atas di output JSON selalu 0. Token yang benar ada di `modelUsage[<model>]`.
- `--max-turns` tidak ada. Batas utama: `--max-budget-usd` ditambah timeout proses.
- Satu panggilan kecil sudah memakai ~27k token konteks (hook, plugin, skill, memori), sekitar $0.07. Budget per WO minimal ~$0.30.
- Dengan login subscription (OAuth), `total_cost_usd` hanya angka notional. Yang habis adalah kuota.
- `--bare` mengurangi konteks dasar tetapi tidak memakai login OAuth: butuh `ANTHROPIC_API_KEY` (jalur lanjutan jika ada budget API).
- `--allowedTools` itu variadic: prompt harus ditaruh sebelum flag itu.

## Status

Teruji: selftest fungsi murni, dan end-to-end lawan server dengan `claude` palsu (status `COMPLETED`, branch, token, biaya).
Belum teruji: `claude -p` asli lewat worker, Playwright, login Claude yang aktif saat berjalan di PM2.

## Batasan yang diketahui

- Perubahan yang belum di-commit dibuang saat WO gagal atau kehabisan budget (hasil parsial tidak tersimpan).
- Deteksi kuota habis memakai pencocokan teks (`limit|rate|overload|429|not logged in`); bisa meleset. Saat terdeteksi, worker jeda 10 menit.
- Satu worker, satu job pada satu waktu (agent atau merge). Tidak ada retry otomatis di sisi worker.
- Credential Claude punya masa berlaku. Login ulang sebelum habis, atau WO gagal dengan `Not logged in`.

## Berkas

- `worker.js`: worker, plus `--selftest`.
- `ui.js`: state, ringkasan event stream, dan server UI live.
- `public/`: halaman UI (`index.html`, `app.css`, `app.js`) dan font Geist lokal (lisensi OFL di `public/fonts/OFL.txt`). Hanya berkas di daftar putih `FILES` di `ui.js` yang disajikan.
- `projects.json.example`, `.env.example`.
