# UI live untuk worker: desain singkat

Status: menunggu persetujuan. Ukuran: perubahan kecil (satu berkas `worker.js` + satu halaman HTML statis).

## Tujuan dan alasan

Admin ingin melihat apa yang sedang dikerjakan worker (agent) saat ini. Sekarang `claude -p` dijalankan dengan `--output-format json`, sehingga tidak ada informasi apa pun sampai WO selesai. Satu-satunya jejak adalah `pm2 logs`.

## Non-tujuan

- Aksi tulis dari UI hanya dua: Start dan Stop (lihat "Kontrol"). Tidak ada cancel WO, approve, atau edit `projects.json`.
- Tidak ada riwayat yang bertahan setelah restart (dibahas sebagai opsi terpisah, bukan bagian dasar).
- Tidak mengubah repo `vps-monitor` dan tidak mengirim aktivitas ke VPS.
- Tidak ada dependency baru, build step, atau database.

## Anti-tujuan (dianggap gagal walau fungsinya jalan)

- UI membuka jalur serangan: bind selain localhost, menampilkan `WORKER_TOKEN`, atau path repo lokal.
- Perubahan format output merusak bukti yang dipakai worker (token, biaya, `is_error`, `BLOCKED:`).

## Pendekatan yang dipertimbangkan

1. **Server SSE di dalam `worker.js`** (dipilih): `http` bawaan Node, tanpa dependency, tanpa proses tambahan. Riwayat hilang saat restart.
2. Proses UI terpisah yang membaca JSONL: riwayat awet, tetapi dua proses dan satu format berkas tambahan. Terlalu berat untuk kebutuhan ini.
3. Dorong aktivitas ke VPS dan tampil di `/orders`: bisa diakses dari mana saja, tetapi mengubah `vps-monitor` dan potongan kode agent keluar dari laptop. Mungkin tahap kedua.

## Desain

- `runClaude` memakai `--output-format stream-json --verbose`. Stdout dibaca per baris (NDJSON). Setiap event `assistant`/`tool_use` diringkas menjadi satu baris aktivitas dan dimasukkan ke ring buffer (±500 baris). Event `result` terakhir menggantikan JSON tunggal lama, dan `parseResult` membaca dari sana. Selftest diperbarui untuk format baru.
- State di memori: `{ phase: idle | wo | merge | paused, wo_id, project_key, mulai, batas waktu & budget, aktivitas[] }`. `processWO`/`processMerge`/jeda kuota mengubah `phase`.
- Server `http` di `127.0.0.1:${STATUS_PORT || 8787}`:
  - `GET /` halaman HTML statis (inline di `worker.js`, tema gelap/terang mengikuti sistem).
  - `GET /events` SSE: kirim snapshot state, lalu setiap baris aktivitas baru.
  - `POST /start` dan `POST /stop` (lihat "Kontrol"). Tanpa autentikasi karena hanya localhost, tetapi dengan perlindungan CSRF.
- Halaman menampilkan: lencana status, WO/project aktif, sisa waktu dan budget, dan daftar aktivitas yang bergerak live (auto-scroll, dapat dijeda).
- Redaksi: path absolut repo diubah jadi relatif terhadap `proj.path`; nilai `WORKER_TOKEN` tidak pernah masuk state. Baris aktivitas dipotong maks 200 karakter.

## Kontrol: Start dan Stop

Proses worker (dan UI) tetap hidup. Tombol hanya menyalakan/mematikan pengambilan job oleh loop `main`, lewat flag `enabled` di memori.

- **Stop** bersifat graceful: WO atau merge yang sedang berjalan diselesaikan sampai laporan terkirim, lalu loop berhenti mengambil job. Status tampil "Menghentikan setelah WO selesai" lalu "Berhenti". Long-poll `/api/wo/next` yang sedang menunggu dibatalkan dengan `AbortController`. Jika VPS sudah sempat menyerahkan WO tepat saat itu, WO kembali `PENDING` lewat habisnya lease 120 detik (tidak ada WO yang hilang).
- **Start** mengaktifkan lagi loop, dan jeda kuota 10 menit dibatalkan.
- Saat worker (re)start, `enabled = true` agar PM2/reboot tetap jalan tanpa campur tangan manual. Status berhenti tidak disimpan ke disk.
- Tidak ada tombol "kill sekarang": mematikan `claude` di tengah jalan membuang pekerjaan parsial dan meninggalkan branch `wo/*`. Kalau perlu, `pm2 stop`.
- Perlindungan CSRF (halaman web lain bisa mengirim POST ke `localhost`): POST wajib berheader `X-Worker-UI: 1` (memicu preflight CORS yang tidak dijawab server, jadi situs lain tidak bisa mengirimnya), dan header `Host` harus `127.0.0.1:<port>` atau `localhost:<port>` (menahan DNS rebinding). Selain itu 403.

## Ditentukan builder (pilihan saya)

- Port default 8787, dapat diganti lewat `STATUS_PORT` di `.env`. Port bentrok: worker tetap jalan, UI dinonaktifkan dengan satu baris log.
- Ringkasan aktivitas per tool: `Read/Edit/Write <file>`, `Grep/Glob <pola>`, `Bash <perintah>`, teks agent dipotong.
- Setelah WO selesai, aktivitas terakhir tetap tampil sampai WO berikutnya mulai.

## Risiko

- Format `stream-json` Claude Code 2.1.317 belum diuji lewat worker. Langkah pertama implementasi: tangkap output nyata dan pastikan token/biaya di event `result` sama dengan format lama.
- Bug di server UI tidak boleh menjatuhkan worker: handler dibungkus try/catch, error hanya dicatat.
