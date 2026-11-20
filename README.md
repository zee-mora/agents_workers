# agent-worker

Worker di laptop untuk antrean Work Order (WO) dari VPS Monitor (`server.microspace.id/orders`).
Worker mengambil WO, menjalankan `claude -p` di branch git terpisah pada repo lokal, memeriksa hasilnya dari bukti, lalu melapor balik ke VPS.

Sisi server ada di repo `vps-monitor` (`orchestrator.js`, `docs/orchestrator.md`). Repo ini hanya worker.

## Alur satu WO

1. `GET /api/wo/next?wait=25` (long-poll). VPS menandai WO `IN_PROGRESS` dan memberi lease 120 detik. Worker kirim heartbeat tiap 30 detik. Worker mati: WO kembali `PENDING`, setelah 2 kali `FAILED`.
2. `project_key` diubah jadi path lewat `projects.json`. Tidak ada di daftar: ditolak.
3. Tolak jika `git status` kotor. Buat branch `wo/<id>-<attempt>` dari HEAD.
4. Jalankan `claude -p` lewat `spawn` (tanpa shell) dengan batas budget dan timeout.
5. Baca hasil JSON. Token dari `modelUsage`, biaya dari `total_cost_usd`.
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
`verify` dan `url` opsional. `verify` hanya dari file ini, tidak pernah dari WO.

Permanen dengan PM2:
```bash
pm2 start worker.js --name laptop-runner && pm2 save && pm2 startup
```
Laptop Linux agar tetap jalan saat lid ditutup: `HandleLidSwitch=ignore` di `/etc/systemd/logind.conf`.

## Batas dan keamanan (jangan dilonggarkan tanpa alasan)

- Worker tidak mempercayai VPS: budget maksimum $1, timeout maksimum 1800 detik, model hanya `haiku|sonnet|opus`.
- `claude` dijalankan dengan `--allowedTools "Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*)"`. Jangan beri `Bash` bebas.
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
- Satu worker, satu WO pada satu waktu. Tidak ada retry otomatis di sisi worker.
- Credential Claude punya masa berlaku. Login ulang sebelum habis, atau WO gagal dengan `Not logged in`.

## Berkas

- `worker.js`: seluruh worker, plus `--selftest`.
- `projects.json.example`, `.env.example`.
