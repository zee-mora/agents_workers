# UI Live Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halaman lokal yang menampilkan apa yang sedang dikerjakan worker secara live, dengan tombol Start dan Stop pengambilan job.

**Architecture:** `runClaude` pindah ke `--output-format stream-json --verbose`; setiap event diringkas jadi baris aktivitas dan didorong ke state di memori. Modul baru `ui.js` (http bawaan Node, SSE, HTML inline) menyajikan state itu di `127.0.0.1`. Loop `main` membaca flag `state.enabled` untuk Start/Stop.

**Tech Stack:** Node >=20.12, `http` bawaan, tanpa dependency baru. Tes lewat `node worker.js --selftest` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-23-worker-live-ui-design.md`

## Global Constraints

- Tanpa dependency baru, build step, atau database. Node >=20.12.
- Server hanya bind `127.0.0.1`, port `STATUS_PORT` (default `8787`). Port bentrok: worker tetap jalan, UI nonaktif, satu baris log.
- `WORKER_TOKEN` tidak pernah masuk state, SSE, atau HTML. Path absolut repo diubah jadi relatif terhadap `proj.path`. Baris aktivitas maks 200 karakter. Ring buffer maks 500 baris.
- Aksi tulis hanya `POST /start` dan `POST /stop`. Wajib header `X-Worker-UI: 1` dan `Host` `127.0.0.1:<port>` atau `localhost:<port>`; selain itu 403. Tidak ada tombol kill.
- Saat worker start, `enabled = true`. Status berhenti tidak disimpan ke disk.
- Stop graceful: WO/merge berjalan diselesaikan dan dilaporkan; long-poll yang menunggu dibatalkan.
- Bukti (token, biaya, `is_error`, `BLOCKED:`) harus identik dengan format lama. `claude` tetap dijalankan tanpa shell dan dengan `--allowedTools` yang sama.
- Bug di UI tidak boleh menjatuhkan worker (handler di try/catch).

## Review Focus

- Chunk stdout memotong satu baris JSON di tengah: harus di-buffer per `\n`, bukan crash atau baris hilang (Task 4).
- Baris stream rusak atau tipe event tak dikenal: diabaikan, worker lanjut (Task 2, 4).
- Stop ditekan saat long-poll idle: loop keluar segera, tidak mengambil WO baru (Task 5).
- Start ditekan saat jeda kuota 10 menit: jeda dibatalkan, lanjut segera (Task 5).
- POST dari situs lain (tanpa header) atau Host asing (DNS rebinding): 403 (Task 3).
- Aktivitas memuat path absolut atau token: ter-redaksi (Task 2).
- Port 8787 sudah dipakai: worker tetap jalan (Task 3).

---

### Task 1: `parseResult` membaca NDJSON stream

**Files:**
- Modify: `worker.js:34` (`parseResult`), selftest di bagian bawah
- Create: cabang kerja `feat/live-ui`

**Interfaces:**
- Produces: `parseResult(out: string)` menerima salah satu: satu objek JSON (format lama) atau NDJSON stream-json; untuk NDJSON memakai baris terakhir ber-`type === 'result'`. Bentuk return tidak berubah. Melempar jika tidak ada objek `result`.

- [ ] **Step 1:** `git switch -c feat/live-ui`, lalu commit berkas spec dan plan: `git add docs && git commit -m "docs: desain dan rencana UI live worker"`.
- [ ] **Step 2: Tangkap output nyata** (tidak di-commit): di folder scratchpad jalankan `claude -p "balas satu kata: ok" --output-format stream-json --verbose --model haiku > stream.ndjson`. Pastikan baris `type:"result"` punya `modelUsage`, `total_cost_usd`, `is_error`, `subtype`, `result`, `num_turns` yang sama dengan format lama. Catat jenis event lain dan bentuk `tool_use` (`message.content[].type/name/input`). Jika berbeda dari asumsi di Task 2, sesuaikan Task 2 sebelum lanjut.
- [ ] **Step 3: Tes gagal.** Tambah di `selftest`: NDJSON tiga baris (`system/init`, `assistant`, `result` memakai `ok` dari tes lama) harus menghasilkan `tokens` yang sama `{ input: 5, output: 7, cache_read: 11, cache_creation: 13 }`; NDJSON tanpa baris `result` harus melempar (`assert.throws`); string objek tunggal lama tetap lolos. Jalankan `npm test`: gagal.
- [ ] **Step 4:** Ubah `parseResult`: pecah per baris, parse tiap baris (abaikan yang rusak), ambil baris `result` terakhir; jika tidak ada baris ber-`type` sama sekali, `JSON.parse(out)` utuh seperti dulu. Jalankan `npm test`: `selftest OK`.
- [ ] **Step 5:** Commit `feat: parseResult membaca stream-json`.

### Task 2: `ui.js` bagian murni (state, ringkasan, redaksi, CSRF)

**Files:**
- Create: `ui.js`
- Modify: `worker.js` selftest (memanggil `require('./ui').selftest()` atau tes di tempat yang sama dengan gaya lama)

**Interfaces:**
- Produces (`module.exports`):
  - `state: { phase: 'idle'|'wo'|'merge'|'paused', enabled: boolean, wo_id: string|null, project_key: string|null, started_at: number|null, timeout_ms: number|null, budget_usd: number|null, paused_until: number|null, activity: string[] }`
  - `summarize(ev: object, root: string): string[]` — ubah satu event stream-json jadi 0..n baris. `system/init` -> `sesi dimulai`; `assistant` dengan `tool_use` -> `Read|Edit|Write <file_path>`, `Grep|Glob <pattern>`, `Bash <command>`, tool lain `<name>`; `assistant` `text` -> teksnya (satu baris); `result` -> `selesai`; lainnya -> `[]`.
  - `redact(s: string, root: string): string` — ganti `root` dengan `.`, ganti nilai `process.env.WORKER_TOKEN` (jika ada) dengan `[token]`, jadikan satu baris, potong 200 karakter.
  - `push(line: string): void` — `redact` tidak diterapkan di sini; `summarize` sudah memanggilnya. Tambah ke `state.activity` (buang yang tertua di atas 500) dan kirim ke klien SSE.
  - `setPhase(phase, info?: Partial<state>): void` — gabungkan ke `state`, kirim snapshot ke klien SSE.
  - `csrfOk(req: {method: string, headers: object}, port: number): boolean`.

- [ ] **Step 1: Tes gagal** di selftest: `summarize` untuk event `Edit` dengan `file_path: '/home/x/proj/app/Foo.php'` dan `root: '/home/x/proj'` menghasilkan `['Edit app/Foo.php']`; `Bash` dengan `command: 'npm test'` -> `['Bash npm test']`; event `{type:'zzz'}` -> `[]`; `redact` mengganti token dan memotong 200 karakter; `push` 501 kali menyisakan 500 baris dengan yang tertua terbuang; `csrfOk` benar hanya jika header `x-worker-ui === '1'` dan `host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`}, salah untuk `host: 'evil.com'` dan tanpa header.
- [ ] **Step 2:** Jalankan `npm test`: gagal (modul belum ada).
- [ ] **Step 3:** Implementasi `ui.js` sesuai Interfaces. SSE belum ada: `push`/`setPhase` memanggil daftar `clients` kosong yang diisi di Task 3.
- [ ] **Step 4:** `npm test`: `selftest OK`. Commit `feat: ui.js state, ringkasan, redaksi, csrf`.

### Task 3: Server UI (SSE, halaman, Start/Stop)

**Files:**
- Modify: `ui.js`
- Test: selftest di `worker.js` (server di port 0)

**Interfaces:**
- Consumes: `state`, `push`, `setPhase`, `csrfOk` (Task 2).
- Produces: `startUI({ port: number, onStart: () => void, onStop: () => void }): Promise<http.Server | null>` — bind `127.0.0.1:port`; resolve `null` dan `console.log` satu baris jika `listen` error. Rute:
  - `GET /` -> HTML (inline, satu string).
  - `GET /events` -> `text/event-stream`: kirim `event: state` berisi snapshot (`state` tanpa `activity`) dan `event: line` untuk tiap baris di `activity`, lalu terus mengirim `line`/`state` baru; tulis komentar `:ka` tiap 15 detik.
  - `POST /start`, `POST /stop` -> 403 jika `!csrfOk`; selain itu atur `state.enabled`, panggil `onStart`/`onStop`, `setPhase(state.phase)`, balas `204`.
  - Rute lain 404; metode salah 405. Semua handler di try/catch.

- [ ] **Step 1: Tes gagal** (port 0 agar bebas bentrok; ambil port dari `server.address()`): `POST /stop` tanpa header -> 403; dengan `X-Worker-UI: 1` dan Host benar -> 204 dan `onStop` terpanggil, `state.enabled === false`; Host `evil.com` -> 403; `GET /events` mengirim `event: state` sebagai chunk pertama; `GET /` berisi `Start` dan `Stop`; `startUI` pada port yang sudah dipakai me-resolve `null`.
- [ ] **Step 2:** `npm test`: gagal.
- [ ] **Step 3:** Implementasi `startUI`. Halaman: lencana status (turunkan dari `enabled` + `phase`: `enabled=false` dan `phase` wo/merge -> "Menghentikan setelah WO selesai"; `enabled=false` dan idle -> "Berhenti"; selain itu nama fase), WO/project aktif, sisa waktu dan budget (hitung di klien dari `started_at`/`timeout_ms`/`budget_usd`), daftar aktivitas auto-scroll, tombol Start (nonaktif saat `enabled`) dan Stop (nonaktif saat `!enabled`) yang mengirim POST dengan header `X-Worker-UI: 1`. CSS variabel dengan mode gelap/terang mengikuti sistem; layout muat di lebar ponsel.
- [ ] **Step 4:** `npm test`: `selftest OK`. Commit `feat: server UI dengan SSE dan tombol Start/Stop`.

### Task 4: Hubungkan `runClaude` dan fase WO ke UI

**Files:**
- Modify: `worker.js:88-109` (`runClaude`), `processWO`, `processMerge`, `main` (hanya `startUI` dan fase), selftest

**Interfaces:**
- Consumes: `summarize`, `push`, `setPhase`, `startUI` dari `ui.js`.
- Produces: `makeLineReader(onLine: (line: string) => void): { write(chunk: string): void, flush(): void }` (fungsi murni di `worker.js`) — menyambung chunk jadi baris utuh per `\n`; `flush` mengirim sisa tanpa `\n`.

- [ ] **Step 1: Tes gagal:** `makeLineReader` — chunk `'{"a":1}\n{"b"'` lalu `':2}\n'` menghasilkan dua baris utuh; `flush` setelah `'tanpa newline'` mengirim baris itu.
- [ ] **Step 2:** `npm test`: gagal.
- [ ] **Step 3:** Implementasi `makeLineReader`. Di `runClaude` ganti argumen `--output-format json` dengan `--output-format stream-json --verbose` (prompt tetap sebelum `--allowedTools`). Tiap baris stdout: `try { JSON.parse }` lalu `summarize(ev, root).forEach(push)`, dan simpan baris `type:"result"` ke variabel; error parse diabaikan. `stdout` yang dikembalikan = baris `result` jika ada, selain itu 2000 karakter terakhir stdout mentah (supaya pesan "output bukan JSON" tetap berguna dan memori tidak membengkak). Tambah parameter `root` (= `proj.path`).
- [ ] **Step 4:** Fase: `setPhase('wo', { wo_id, project_key, started_at: Date.now(), timeout_ms, budget_usd })` sebelum `runClaude` dan `setPhase('idle', { wo_id: null, project_key: null })` di `finally` (aktivitas terakhir tetap). Sama untuk `processMerge` dengan `'merge'`. Jeda kuota: `setPhase('paused', { paused_until: Date.now() + PAUSE_MS })`, lalu `idle` setelah jeda. Di `main`: `startUI({ port: Number(process.env.STATUS_PORT || 8787), onStart() {}, onStop() {} })` sebelum loop (callback diisi di Task 5), log alamat UI.
- [ ] **Step 5: Verifikasi nyata:** jalankan stub VPS kecil di scratchpad (tidak di-commit) yang menyajikan satu WO ke project uji, jalankan worker, buka `http://127.0.0.1:8787` dan pastikan baris aktivitas muncul live dan WO selesai `COMPLETED` dengan token/biaya terisi. `npm test` lolos. Commit `feat: aktivitas agent live di UI`.

### Task 5: Gerbang Start/Stop di loop `main`, README

**Files:**
- Modify: `worker.js` (`api`, `main`, `sleep` jeda), `README.md`, `.env.example`

**Interfaces:**
- Produces: `api(method, p, body, timeoutMs, signal?)` — sinyal opsional digabung dengan timeout lewat `AbortSignal.any`. `sleepWake(ms: number): Promise<void>` — seperti `sleep` tetapi selesai lebih awal saat `wakeUp()` dipanggil. `wakeUp(): void`.

- [ ] **Step 1: Tes gagal:** `sleepWake(60000)` yang di-`wakeUp()` setelah 10 ms selesai kurang dari 1 detik.
- [ ] **Step 2:** `npm test`: gagal.
- [ ] **Step 3:** Implementasi `sleepWake`/`wakeUp`. `main`: di awal tiap iterasi `while (!state.enabled) await sleepWake(60000)` (log sekali saat berhenti). Long-poll `/api/wo/next` memakai `AbortController` disimpan di variabel modul; `onStop` -> `pollAbort?.abort()`; `AbortError` karena Stop dianggap normal (tidak masuk `polling error`, tidak ada `sleep 5000`). `onStart` -> `wakeUp()`. Jeda kuota 10 menit memakai `sleepWake` agar Start membatalkannya (set `paused_until` null). Job yang sedang berjalan tidak diinterupsi.
- [ ] **Step 4: Verifikasi nyata** dengan stub VPS: (a) saat idle tekan Stop: status "Berhenti" dalam <2 detik dan tidak ada permintaan `/api/wo/next` baru; Start: permintaan lanjut. (b) tekan Stop saat WO berjalan: WO selesai dan terlapor, baru status "Berhenti". (c) paksa jeda kuota, tekan Start: lanjut segera. (d) `curl -X POST http://127.0.0.1:8787/stop` tanpa header: 403.
- [ ] **Step 5:** README: tambah bagian "UI live" (alamat, `STATUS_PORT`, Start/Stop graceful, tanpa kill, keamanan localhost + CSRF, riwayat tidak awet), perbarui daftar Berkas (`ui.js`) dan catat bahwa `stream-json` dipakai. `.env.example`: tambah `STATUS_PORT=8787`. `npm test` lolos. Commit `feat: tombol Start/Stop worker dan dokumentasi`.
