'use strict';
// Laptop worker: ambil WO dari VPS, jalankan `claude -p` di branch git terpisah,
// verifikasi dari bukti (bukan klaim agent), lapor balik. Lihat PRD v2.
const { spawn, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ui = require('./ui');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env opsional */ }

const VPS_URL = (process.env.VPS_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN;
const POLL_WAIT = Number(process.env.POLL_WAIT || 25);
const PAUSE_MS = 10 * 60 * 1000;     // jeda saat kuota/login bermasalah
const MAX_BUDGET = 1.0;              // batas keras sisi worker, tidak percaya nilai dari VPS
const MAX_TIMEOUT = 1800;
const MODELS = ['haiku', 'sonnet', 'opus'];
const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*),Bash(python3:*)';
const RULES = [
  '- Hanya kerjakan goals yang tertulis. Jangan refactor di luar itu.',
  '- Mulai dari file yang disarankan. Baca file sebelum mengubahnya; jangan menebak isinya.',
  '- Jangan mengklaim sesuatu lulus/jalan tanpa menjalankan perintahnya.',
  '- Tidak yakin atau butuh info yang tidak ada: berhenti dan tulis "BLOCKED: <alasan>". Jangan mengarang.',
  '- Jawaban akhir maksimal 10 baris: file yang diubah + alasan.',
  '- Akhiri jawaban dengan satu baris `COMPLEXITY: simple|complex - alasan singkat`. complex = mengubah struktur database (tabel/kolom/index/migrasi), struktur app (file/modul baru, dihapus, dipindah, routing, dependency, config deploy), logika auth/keamanan/pembayaran, atau perubahan lintas banyak modul, atau kamu ragu. Selain itu simple.',
].join('\n');

// Penilaian kompleksitas WO (dipakai VPS untuk prioritas audit). Deterministik dari diff, ditambah
// penilaian agent (baris `COMPLEXITY:`); hasil akhir = yang terberat. Daftar sinyal sengaja konservatif:
// salah-complex hanya menambah antrean audit, salah-simple melewatkan perubahan berisiko.
const CX_SIGNALS = [ // [label, cocok per file, cocok per diff, keras?]. Keras = agent tidak boleh menurunkan.
  ['struktur database', (f) => /(^|\/)(migrations?|migrate|schema|seeders?)(\/|\.|$)|\.sql$|prisma\/schema|(^|\/)models?\//i.test(f.path), (p) => /^\+.*\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|INDEX|COLUMN|DATABASE)\b|^\+.*\bADD\s+COLUMN\b|\$table->|Schema::|db\.(create|drop)Collection/im.test(p), true],
  ['struktur app (file ditambah/dihapus/dipindah)', (f) => /^[DR]/.test(f.st) && /\.(js|ts|jsx|tsx|py|php|rb|go|java|vue|svelte)$/.test(f.path), null, true],
  ['routing/entry point', (f) => /(^|\/)(routes?|router|server|app|main|index)\.(js|ts|py|php)$|(^|\/)routes?\//i.test(f.path)],
  ['dependency/build/deploy', (f) => /(^|\/)(package\.json|composer\.json|requirements\.txt|pyproject\.toml|go\.mod|Dockerfile|docker-compose\.ya?ml|ecosystem\.config\.js|nginx[^/]*\.conf|\.github\/workflows\/.+)$/.test(f.path)],
  ['auth/keamanan/pembayaran', (f) => /auth|login|password|permission|session|csrf|token|payment|billing|middleware/i.test(f.path)],
];
function assessComplexity(nameStatus, patch, agentText) {
  const files = String(nameStatus || '').split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { st, path: p[p.length - 1] }; });
  const why = []; let hard = false;
  for (const [label, byFile, byPatch, h] of CX_SIGNALS) if (files.some(byFile) || (byPatch && byPatch(patch || ''))) { why.push(label); hard ||= !!h; }
  const added = files.filter((f) => f.st === 'A' && /\.(js|ts|jsx|tsx|py|php|rb|go|java|vue|svelte)$/.test(f.path)).length;
  if (added >= 3) { why.push(`${added} file kode baru`); hard = true; }
  if (files.length > 10) why.push(`${files.length} file berubah`);
  const m = /^COMPLEXITY:\s*(simple|complex)\b\s*[-—:]*\s*(.*)$/im.exec(agentText || '');
  const agent = m && m[1].toLowerCase(), note = m ? m[2].trim() : '';
  if (agent === 'complex') why.push('agent: ' + (note || 'ditandai complex'));
  else if (agent === 'simple' && why.length && !hard && note) return { complexity: 'simple', reason: `diturunkan agent (${note}); sinyal kode: ${why.join(', ')}`.slice(0, 300) };
  return { complexity: why.length ? 'complex' : 'simple', reason: (why.join('; ') || 'perubahan kecil, tanpa sinyal struktur/DB').slice(0, 300) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 2000) => String(s || '').slice(-n);
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
// Tidur yang bisa dibangunkan (tombol Start/Stop UI).
let wake = null;
const sleepWake = (ms) => new Promise((r) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); wake = null; r(); } wake = done; });
const wakeUp = () => wake && wake();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- fungsi murni (dites di --selftest) ----------

function parseResult(out) {
  // stream-json: NDJSON, ambil event `result` terakhir. Format lama: satu objek JSON utuh.
  const ev = out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const d = ev.some((e) => e.type) ? ev.findLast((e) => e.type === 'result') : JSON.parse(out);
  if (!d) throw new Error('tidak ada event result');
  const mu = Object.values(d.modelUsage || {}); // `usage` level atas selalu 0, pakai modelUsage
  const sum = (k) => mu.reduce((a, m) => a + (m[k] || 0), 0);
  return {
    is_error: !!d.is_error,
    subtype: d.subtype || null,
    cost: d.total_cost_usd ?? null,
    turns: d.num_turns ?? null,
    text: String(d.result ?? ''),
    errors: d.errors || [],
    tokens: {
      input: sum('inputTokens'),
      output: sum('outputTokens'),
      cache_read: sum('cacheReadInputTokens'),
      cache_creation: sum('cacheCreationInputTokens'),
    },
  };
}

// Sambung chunk stdout jadi baris utuh (satu baris JSON bisa terpotong di tengah chunk).
function makeLineReader(onLine) {
  let buf = '';
  return {
    write(chunk) { buf += chunk; const parts = buf.split('\n'); buf = parts.pop(); parts.forEach(onLine); },
    flush() { if (buf) onLine(buf); buf = ''; },
  };
}

function classify(r) {
  if (!r.is_error) return null;
  return r.subtype === 'error_max_budget_usd' ? 'OVER_BUDGET' : 'FAILED';
}

const isQuota = (r) => r.is_error && /limit|rate|overload|429|not logged in/i.test(r.text + ' ' + r.errors.join(' '));

const unsafeFile = (f) => /(^|\/)\.env/.test(f) || /(^|\/)\.git\//.test(f);

function localUrlOk(u) {
  try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; }
}

function buildPrompt(wo, imgPaths = []) {
  const goals = (wo.goals || []).length ? `\n\nGoals:\n${wo.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}` : '';
  const hint = (wo.files_hint || []).length ? `\n\nFile untuk dimulai:\n${wo.files_hint.join('\n')}` : '';
  const imgs = imgPaths.length ? `\n\nAttached images (read them with the Read tool):\n${imgPaths.join('\n')}` : '';
  const page = '\n\nJika perubahan terlihat di halaman web, akhiri jawaban dengan satu baris `PAGE: /path/halaman` (path saja, untuk screenshot).';
  return `Context: ${wo.context}${goals}${hint}${imgs}${page}`;
}

// Halaman yang disebut agent -> URL penuh di origin project. Hanya path; host selalu dari projects.json.
function pageUrl(base, text) {
  const m = /^PAGE:\s*(\/[^\s`]*)/m.exec(text || '');
  if (!m || m[1].startsWith('//')) return base;
  try { return new URL(m[1], base).href; } catch { return base; }
}

// ---------- VPS API ----------

async function api(method, p, body, timeoutMs = 15000, signal) {
  const res = await fetch(VPS_URL + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  return res.json();
}

// Sinkron DB sebelum agent jalan: hanya jika data lebih tua dari ttl. Async supaya heartbeat tetap jalan.
// `cmd` datang dari projects.json (file laptop, dipercaya seperti `verify`), tidak pernah dari WO.
const SYNC_DIR = path.join(__dirname, '.sync');
function syncAge(key, now = Date.now()) {
  try { return now - fs.statSync(path.join(SYNC_DIR, key)).mtimeMs; } catch { return Infinity; }
}
// dbSource (dari WO) harus ada di db_sync.sources milik laptop; dikirim ke cmd lewat env DB_SOURCE, tidak pernah disisipkan ke string.
async function syncDb(key, proj, now = Date.now(), dbSource = null) {
  const c = proj.db_sync;
  if (!c || !c.cmd) return false;
  const sources = Array.isArray(c.sources) ? c.sources : [];
  let src = null;
  if (sources.length) {
    src = dbSource || c.default || sources[0];
    if (!sources.includes(src)) throw new Error(`sumber DB "${src}" tidak ada di db_sync.sources project ini`);
  }
  const stamp = src ? `${key}__${src}` : key; // ganti sumber = restore ulang walau TTL belum habis
  if (syncAge(stamp, now) < Number(c.ttl_hours ?? 6) * 3600 * 1000) return false;
  log(`sync DB ${key}${src ? ' dari ' + src : ''}…`);
  const env = { ...process.env, VPS_URL, ...(src ? { DB_SOURCE: src } : {}) }; // script sync (milik laptop, dipercaya) butuh WORKER_TOKEN untuk db-dump
  const out = await new Promise((resolve) => {
    const p = spawn('bash', ['-c', c.cmd], { cwd: proj.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 30 * 60 * 1000);
    p.stdout.on('data', (d) => { buf = (buf + d).slice(-1500); });
    p.stderr.on('data', (d) => { buf = (buf + d).slice(-1500); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, buf: String(e) }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, buf }); });
  });
  if (out.code !== 0) throw new Error(`sync DB gagal (exit ${out.code}): ${tail(out.buf, 500)}`);
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SYNC_DIR, stamp), String(now));
  return true;
}

// Unduh lampiran WO ke folder sementara di luar repo. Nama file dari VPS divalidasi dulu.
async function downloadImages(wo) {
  const names = Array.isArray(wo.images) ? wo.images : [];
  if (!names.length) return { dir: null, paths: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wo-${wo.id}-`));
  try {
    const paths = [];
    for (const n of names) {
      if (!/^[a-f0-9]{16}\.(png|jpg|webp|gif)$/.test(n)) throw new Error('nama lampiran tidak valid');
      const res = await fetch(`${VPS_URL}/api/wo/${wo.id}/img/${n}`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`GET lampiran -> ${res.status}`);
      const f = path.join(dir, n);
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      paths.push(f);
    }
    return { dir, paths };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

// ---------- eksekusi ----------

function runClaude(cwd, prompt, wo, addDir) {
  const lim = wo.limits || {};
  const budget = Math.min(Number(lim.max_budget_usd) || 0.5, MAX_BUDGET);
  const timeout = Math.min(Number(lim.timeout_sec) || 600, MAX_TIMEOUT) * 1000;
  const model = MODELS.includes(lim.model) ? lim.model : 'sonnet';
  // prompt harus sebelum --allowedTools (variadic). Tanpa shell: tidak ada injection.
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model,
    '--max-budget-usd', String(budget), '--permission-mode', 'acceptEdits',
    ...(addDir ? ['--add-dir', addDir] : []),
    '--append-system-prompt', RULES, '--allowedTools', ALLOWED_TOOLS];
  const env = { ...process.env };
  delete env.WORKER_TOKEN; // agent tidak boleh melihat token VPS
  delete env.SYNC_MYSQL_USER; delete env.SYNC_MYSQL_PASSWORD; // dan tidak boleh melihat login MySQL untuk sync

  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '', resultLine = '', stderr = '', timedOut = false;
    ui.setPhase('wo', { started_at: Date.now(), timeout_ms: timeout, budget_usd: budget });
    const lines = makeLineReader((l) => {
      try {
        const ev = JSON.parse(l);
        if (ev.type === 'result') resultLine = l;
        ui.summarize(ev, cwd).forEach(ui.push);
      } catch { /* baris bukan JSON: abaikan */ }
    });
    p.stdout.on('data', (d) => { raw = (raw + d).slice(-2000); lines.write(String(d)); });
    p.stderr.on('data', (d) => { stderr += d; });
    const stdout = () => { lines.flush(); return resultLine || raw; }; // hanya baris result, bukan seluruh stream
    const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ stdout: stdout(), stderr: String(e), code: -1, timedOut }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ stdout: stdout(), stderr, code, timedOut }); });
  });
}

// Nyalakan dev server project hanya selama foto. Port sudah terbuka (server manual) = dipakai apa adanya, tidak dimatikan.
// Default: `php artisan serve` jika ada file artisan; `serve` di projects.json menimpa. Token worker tidak diteruskan.
async function withServer(proj, url, fn) {
  const portOpen = () => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  const port = new URL(url).port;
  const cmd = proj.serve || (port && fs.existsSync(path.join(proj.path, 'artisan')) ? `php artisan serve --host=localhost --port=${port}` : null);
  if (!cmd || await portOpen()) return fn();
  const { WORKER_TOKEN, ...env } = process.env;
  const p = spawn('bash', ['-c', cmd], { cwd: proj.path, env, stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 30 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 500));
    return await fn();
  } finally { try { process.kill(-p.pid); } catch { /* sudah mati */ } } // grup proses: bash + php + worker php
}

// login.setup (mis. seeder yang membuat akun dev, idempotent) hanya jalan jika DB_HOST di .env project lokal: jangan pernah menulis ke DB remote.
function runSetup(proj) {
  const envFile = path.join(proj.path, '.env');
  const host = (fs.existsSync(envFile) ? /^DB_HOST=(.*)$/m.exec(fs.readFileSync(envFile, 'utf8')) : null)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return `setup login ditolak: DB_HOST project "${host}" bukan lokal`;
  const { WORKER_TOKEN, ...env } = process.env;
  const r = spawnSync('bash', ['-c', proj.login.setup], { cwd: proj.path, env, encoding: 'utf8', timeout: 120000 });
  return r.status === 0 ? null : `setup login gagal (exit ${r.status}): ${tail((r.stdout || '') + (r.stderr || ''), 500)}`;
}

const DEVICES = [{ name: 'Desktop', width: 1280, height: 800 }, { name: 'Tablet', width: 768, height: 1024 }, { name: 'HP', width: 390, height: 844 }];

async function screenshot(url, viewport, out, storageState, login, proj) {
  if (!localUrlOk(url)) return 'URL ditolak (hanya localhost/127.0.0.1)';
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    // storageState (opsional, dari projects.json): sesi login Playwright supaya halaman di balik login bisa difoto
    const ctx = await browser.newContext({ viewport: viewport?.width ? viewport : { width: 1280, height: 800 },
      ...(storageState && fs.existsSync(storageState) ? { storageState } : {}) });
    const page = await ctx.newPage();
    if (login && login.setup) { const e = runSetup(proj); if (e) return e; }
    if (login && login.user && login.password) { // login otomatis tiap foto (kredensial hanya dari projects.json di laptop, tidak dikirim ke VPS)
      await page.goto(new URL(login.path || '/login', url).href, { waitUntil: 'networkidle', timeout: 15000 });
      await page.fill(login.user_selector || 'input[name="email"]', login.user);
      await page.fill(login.password_selector || 'input[type="password"]', login.password);
      await Promise.all([page.waitForLoadState('networkidle'), page.press(login.password_selector || 'input[type="password"]', 'Enter')]);
      if (new URL(page.url()).pathname === new URL(login.path || '/login', url).pathname) return 'login gagal (kredensial salah / ada captcha atau 2FA)';
    }
    // viewport dari WO = satu foto; tanpa itu: desktop + tablet + HP digabung jadi satu PNG (server hanya menerima satu gambar)
    const devs = viewport?.width ? [{ name: `${viewport.width}px`, ...viewport }] : DEVICES;
    const shots = [];
    for (const d of devs) {
      await page.setViewportSize({ width: d.width, height: d.height || 800 });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(3000); // animasi masuk halaman (konten baru muncul ±3 dtk)
      shots.push({ name: d.name, w: d.width, h: d.height || 800, b64: (await page.screenshot()).toString('base64') }); // bukan fullPage: fullPage memicu ulang animasi masuk (konten kosong)
    }
    if (shots.length === 1) { fs.writeFileSync(out, Buffer.from(shots[0].b64, 'base64')); return null; }
    const H = 700; // semua foto diskalakan ke tinggi sama
    const html = `<body style="margin:0;padding:16px;background:#e5e7eb;font:600 13px sans-serif;display:flex;gap:16px;align-items:flex-start;width:max-content">${shots.map((x) =>
      `<div><div style="margin-bottom:6px;color:#374151">${x.name} (${x.w}×${x.h})</div><img style="display:block;height:${H}px;width:${Math.round(x.w * H / x.h)}px;border:1px solid #9ca3af;background:#fff" src="data:image/png;base64,${x.b64}"></div>`).join('')}</body>`;
    const cp = await ctx.newPage();
    await cp.setContent(html);
    await cp.setViewportSize({ width: 100, height: 100 });
    await cp.screenshot({ path: out, fullPage: true });
    return null;
  } catch (e) {
    return `screenshot gagal: ${e.message}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function report(wo, result, shotPath) {
  const body = { status: result.status, result };
  if (shotPath && fs.existsSync(shotPath)) {
    const png = fs.readFileSync(shotPath);
    if (png.length <= 2 * 1024 * 1024) body.screenshot_b64 = png.toString('base64'); // batas server 2 MB
    else result.logs += '\n[screenshot > 2 MB, tidak dikirim]';
  }
  await api('POST', `/api/wo/${wo.id}/complete`, body, 60000);
}

// Return true jika kuota/login bermasalah (loop akan jeda).
async function processWO(wo) {
  log(`WO ${wo.id} diterima`);
  ui.setPhase('wo', { wo_id: wo.id, project_key: wo.project_key, started_at: Date.now(), timeout_ms: null, budget_usd: null });
  const result = { status: 'FAILED', exit_code: null, turns: null, tokens: null, cost_usd: null,
    diff_stat: null, verify_passed: null, branch: null, logs: '' };
  const hb = setInterval(() => api('POST', `/api/wo/${wo.id}/heartbeat`, {}).catch(() => {}), 30000);
  let dir, base, shot, imgDir, pageText = '', quota = false;

  try {
    const proj = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'))[wo.project_key];
    if (!proj || !/^[\w.-]+$/.test(wo.id)) { result.logs = 'project_key tidak ada di projects.json atau id tidak valid'; return false; }
    dir = proj.path;
    if (!fs.existsSync(dir)) { result.logs = `folder tidak ada: ${dir}`; return false; }
    if (git(dir, 'status', '--porcelain')) { result.logs = 'working tree kotor, WO ditolak'; return false; }

    try { await syncDb(wo.project_key, proj, Date.now(), wo.db_source); }
    catch (e) { result.logs = `WO tidak dijalankan: ${e.message}`; return false; } // jangan kerja di data basi tanpa sepengetahuan

    let imgPaths = [];
    try { ({ dir: imgDir, paths: imgPaths } = await downloadImages(wo)); }
    catch (e) { result.logs = `gagal mengunduh lampiran, WO tidak dijalankan: ${e.message}`; return false; }

    base = git(dir, 'rev-parse', 'HEAD');
    const baseBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    result.branch = `wo/${wo.id}-${wo.attempts || 0}`;
    git(dir, 'switch', '-c', result.branch);

    const run = await runClaude(dir, buildPrompt(wo, imgPaths), wo, imgDir);
    result.exit_code = run.code;
    if (run.timedOut) { result.logs = 'timeout, proses dihentikan'; return false; }

    let r;
    try { r = parseResult(run.stdout); } catch { result.logs = `output bukan JSON: ${tail(run.stdout || run.stderr)}`; return false; }
    result.turns = r.turns; result.tokens = r.tokens; result.cost_usd = r.cost;
    result.logs = tail(r.text || r.errors.join('; '));
    quota = isQuota(r);
    pageText = r.text;

    const bad = classify(r);
    if (bad) { result.status = bad; return quota; }

    // bukti: commit perubahan ke branch WO supaya diff awet dan bisa direview
    git(dir, 'add', '-A');
    const files = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
    if (/^BLOCKED:/m.test(r.text)) { result.status = 'NEEDS_REVIEW'; return false; }
    if (!files.length) { result.status = 'FAILED'; result.logs = 'agent tidak mengubah file. ' + result.logs; return false; }
    if (files.some(unsafeFile)) { result.status = 'NEEDS_REVIEW'; result.logs = 'menyentuh .env/.git: ' + files.filter(unsafeFile).join(', '); return false; }
    git(dir, 'commit', '-m', `WO ${wo.id}: ${wo.context}`.slice(0, 200));
    result.diff_stat = git(dir, 'diff', '--stat', base, 'HEAD');
    result.head_sha = git(dir, 'rev-parse', 'HEAD'); // merge nanti hanya jika branch masih di commit ini
    try { result.patch = execFileSync('git', ['-C', dir, 'diff', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).slice(0, 200 * 1024); }
    catch { result.patch = '[diff terlalu besar untuk dikirim, lihat di laptop]'; }
    { const a = assessComplexity(git(dir, 'diff', '--name-status', '-M', base, 'HEAD'), result.patch, r.text); result.complexity = a.complexity; result.complexity_reason = a.reason; }

    if (proj.verify) {
      const v = spawnSync('bash', ['-c', proj.verify], { cwd: dir, encoding: 'utf8', timeout: 300000 });
      result.verify_passed = v.status === 0;
      if (!result.verify_passed) { result.status = 'NEEDS_REVIEW'; result.logs = 'verifikasi gagal:\n' + tail(v.stdout + v.stderr); return false; }
    }

    const url = wo.verification?.target_url || proj.url;
    if (url) {
      shot = path.join(os.tmpdir(), `${wo.id}.png`);
      const err = await withServer(proj, url, () => screenshot(pageUrl(url, pageText), wo.verification?.viewport, shot, proj.storage_state, proj.login, proj));
      if (err) result.logs += `\n[${err}]`; // screenshot gagal tidak menggagalkan WO
    }
    result.status = 'COMPLETED';
    git(dir, 'switch', baseBranch);
    return false;
  } catch (e) {
    result.logs = `error worker: ${e.message}`;
    return quota;
  } finally {
    clearInterval(hb);
    try { if (dir && base) { const cur = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'); if (cur.startsWith('wo/')) git(dir, 'checkout', '-f', '-'); } } catch { /* biarkan */ }
    try { await report(wo, result, shot); log(`WO ${wo.id} -> ${result.status} ($${result.cost_usd})`); }
    catch (e) { log(`gagal lapor WO ${wo.id}: ${e.message} (lease akan habis)`); }
    ui.setPhase('idle', { wo_id: null, project_key: null }); // idle hanya setelah laporan terkirim (Stop menunggu ini)
    if (shot) fs.rm(shot, () => {});
    if (imgDir) fs.rm(imgDir, { recursive: true, force: true }, () => {});
  }
}

// File yang diubah WO dan juga diubah di origin/<target> sejak WO dibuat. Tidak kosong = jangan merge otomatis.
function mergeClash(dir, branch, target) {
  const mb = git(dir, 'merge-base', branch, `origin/${target}`);
  const files = (ref) => new Set(git(dir, 'diff', '--name-only', mb, ref).split('\n').filter(Boolean));
  const theirs = files(`origin/${target}`);
  return [...files(branch)].filter((f) => theirs.has(f));
}

const gitNet = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Job merge setelah admin menekan Approve di VPS. Target branch ditentukan HANYA oleh projects.json laptop
// ("target"); VPS tidak bisa memilih. Agent (claude) tidak terlibat dan tidak punya hak push.
async function processMerge(wo) {
  log(`MERGE ${wo.id} diterima`);
  ui.setPhase('merge', { wo_id: wo.id, project_key: wo.project_key, started_at: Date.now(), timeout_ms: null, budget_usd: null });
  const out = { status: 'MERGE_FAILED', detail: '', sha: null, target: null };
  const hb = setInterval(() => api('POST', `/api/wo/${wo.id}/heartbeat`, {}).catch(() => {}), 30000);
  let dir, origBranch, targetPrev;
  try {
    const proj = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'))[wo.project_key];
    const r = wo.result || {};
    if (!proj) throw new Error('project_key tidak ada di projects.json');
    if (!proj.target) throw new Error('project ini belum diizinkan merge: tambahkan "target" (mis. "development") di projects.json laptop');
    if (!/^[\w][\w./-]*$/.test(proj.target)) throw new Error('nama target tidak valid');
    if (!/^wo\/[\w.-]+$/.test(r.branch || '') || !/^[0-9a-f]{7,40}$/.test(r.head_sha || '')) throw new Error('branch/head_sha tidak valid');
    dir = proj.path; out.target = proj.target;
    if (git(dir, 'status', '--porcelain')) throw new Error('working tree kotor, merge ditolak');
    const head = git(dir, 'rev-parse', '--verify', r.branch);
    if (!head.startsWith(r.head_sha)) throw new Error(`branch berubah sejak direview (${head.slice(0, 8)} != ${r.head_sha.slice(0, 8)})`);

    origBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    gitNet(dir, 'fetch', 'origin', proj.target);
    const clash = mergeClash(dir, r.branch, proj.target);
    if (clash.length) throw new Error(`file ini juga diubah di ${proj.target} sejak WO dibuat: ${clash.join(', ')}. Buat WO baru dari ${proj.target} terbaru atau merge manual.`);
    git(dir, 'switch', proj.target);
    targetPrev = git(dir, 'rev-parse', 'HEAD');
    try { git(dir, 'merge', '--ff-only', `origin/${proj.target}`); } // susul origin; menyimpang = berhenti
    catch { throw new Error(`${proj.target} lokal menyimpang dari origin/${proj.target}, rapikan manual`); }
    try { git(dir, 'merge', '--no-edit', r.branch); }
    catch (e) { try { git(dir, 'merge', '--abort'); } catch { /* tidak ada merge berjalan */ } throw new Error('konflik merge, dibatalkan: ' + tail(e.message, 500)); }
    gitNet(dir, 'push', 'origin', proj.target);
    out.sha = git(dir, 'rev-parse', 'HEAD');
    out.status = 'MERGED';
    out.detail = `${r.branch} di-merge ke ${proj.target} dan di-push`;
    try { git(dir, 'branch', '-d', r.branch); out.detail += ' (branch WO dihapus)'; } // -d aman: hanya hapus jika sudah ter-merge
    catch (e) { log(`branch ${r.branch} tidak dihapus: ${e.message}`); }
  } catch (e) {
    out.detail = tail(e.message, 1500);
    // push gagal setelah merge lokal: kembalikan target lokal ke keadaan semula
    try { if (dir && targetPrev && git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === out.target) git(dir, 'reset', '--hard', targetPrev); } catch { /* biarkan */ }
  } finally {
    clearInterval(hb);
    try { if (dir && origBranch && git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== origBranch) git(dir, 'switch', origBranch); } catch { /* biarkan */ }
    try { await api('POST', `/api/wo/${wo.id}/merge-result`, out, 30000); log(`MERGE ${wo.id} -> ${out.status}: ${out.detail}`); }
    catch (e) { log(`gagal lapor merge ${wo.id}: ${e.message} (lease akan habis)`); }
    ui.setPhase('idle', { wo_id: null, project_key: null });
  }
}

// Daftarkan nama project (key + target merge, TANPA path) ke VPS untuk dropdown UI dan validasi WO.
// Dikirim saat start, saat projects.json berubah, dan tiap 10 menit.
let regMtime = 0, regAt = 0;
async function registerProjects() {
  try {
    const f = path.join(__dirname, 'projects.json');
    const m = fs.statSync(f).mtimeMs;
    if (m === regMtime && Date.now() - regAt < 600000) return;
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const projects = Object.entries(cfg).map(([key, p]) => {
      const s = p && p.db_sync && Array.isArray(p.db_sync.sources) ? p.db_sync.sources : [];
      return { key, target: (p && p.target) || null, ...(s.length ? { db_sources: s, db_default: p.db_sync.default || s[0] } : {}) };
    });
    await api('POST', '/api/wo/projects', { projects });
    regMtime = m; regAt = Date.now();
    log(`project terdaftar: ${projects.map((p) => p.key + (p.target ? '→' + p.target : '')).join(', ')}`);
  } catch (e) {
    log('gagal mendaftarkan project:', e.message); // dicoba lagi di siklus berikutnya
  }
}

async function main() {
  if (!TOKEN) { console.error('WORKER_TOKEN kosong (isi .env)'); process.exit(1); }
  log(`worker aktif -> ${VPS_URL}`);
  const port = Number(process.env.STATUS_PORT || 8787);
  let pollAbort = null;
  // Stop: batalkan long-poll dan bangunkan jeda kuota supaya loop sampai ke gerbang. Job berjalan tidak diinterupsi.
  const onStop = () => { pollAbort?.abort(); wakeUp(); };
  if (await ui.startUI({ port, onStart: wakeUp, onStop })) log(`UI: http://127.0.0.1:${port}`);
  for (;;) {
    if (!ui.state.enabled) { log('worker dihentikan dari UI'); while (!ui.state.enabled) await sleepWake(60000); log('worker dilanjutkan dari UI'); }
    await registerProjects();
    try {
      pollAbort = new AbortController();
      const { wo, kind } = await api('GET', `/api/wo/next?wait=${POLL_WAIT}`, null, (POLL_WAIT + 10) * 1000, pollAbort.signal);
      if (!wo) { await sleep(2000); continue; }
      if (kind === 'merge' || wo.status === 'MERGING') { await processMerge(wo); continue; } // jangan pernah menjalankan agent untuk job merge
      if (await processWO(wo)) {
        log('kuota/login bermasalah, jeda 10 menit');
        ui.setPhase('paused', { paused_until: Date.now() + PAUSE_MS });
        await sleepWake(PAUSE_MS);
        ui.setPhase('idle', { paused_until: null });
      }
    } catch (e) {
      if (pollAbort?.signal.aborted) continue; // Stop dari UI, bukan error
      log('polling error:', e.message);
      await sleep(5000);
    }
  }
}

// ---------- selftest: node worker.js --selftest ----------

function selftest() {
  const assert = require('assert');
  const ok = JSON.stringify({ is_error: false, subtype: 'success', total_cost_usd: 0.1, num_turns: 3, result: 'done',
    usage: { input_tokens: 0 }, modelUsage: { a: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 11, cacheCreationInputTokens: 13 } } });
  const r = parseResult(ok);
  assert.deepStrictEqual(r.tokens, { input: 5, output: 7, cache_read: 11, cache_creation: 13 });
  assert.strictEqual(classify(r), null);
  const nd = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [] } }, { type: 'result', ...JSON.parse(ok) }].map((e) => JSON.stringify(e)).join('\n');
  assert.deepStrictEqual(parseResult(nd).tokens, { input: 5, output: 7, cache_read: 11, cache_creation: 13 });
  assert.strictEqual(parseResult('{"type":"system"}\nrusak{\n' + nd).cost, 0.1);
  assert.throws(() => parseResult('{"type":"system","subtype":"init"}\n{"type":"assistant"}'));
  const budget = parseResult(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', errors: ['Reached maximum budget'] }));
  assert.strictEqual(classify(budget), 'OVER_BUDGET');
  assert.strictEqual(isQuota(budget), false);
  const login = parseResult(JSON.stringify({ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' }));
  assert.strictEqual(classify(login), 'FAILED');
  assert.strictEqual(isQuota(login), true);
  assert.ok(unsafeFile('app/.env') && unsafeFile('.git/config') && !unsafeFile('src/env.js'));
  assert.ok(localUrlOk('http://localhost:8000/x') && !localUrlOk('http://evil.com') && !localUrlOk('file:///etc/passwd'));
  assert.strictEqual(assessComplexity('M\tsrc/a.js', '+x', '').complexity, 'simple');
  assert.strictEqual(assessComplexity('A\tdb/migrations/001.sql', '', '').complexity, 'complex');
  assert.strictEqual(assessComplexity('M\tsrc/a.js', '+ALTER TABLE t ADD COLUMN c int', '').complexity, 'complex');
  assert.strictEqual(assessComplexity('R100\told.js\tnew.js', '', '').complexity, 'complex');
  assert.strictEqual(assessComplexity('M\tsrc/a.js', '+x', 'COMPLEXITY: complex - ubah alur').complexity, 'complex');
  assert.strictEqual(assessComplexity('M\tsrc/a.js', '+x', 'COMPLEXITY: simple - typo').complexity, 'simple');
  assert.strictEqual(assessComplexity('M\tnginx-x.conf', '+x', 'COMPLEXITY: simple - ganti regex').complexity, 'simple'); // sinyal lemah, agent menurunkan
  assert.strictEqual(assessComplexity('M\tnginx-x.conf', '+x', 'COMPLEXITY: simple').complexity, 'complex'); // tanpa alasan: tidak diturunkan
  assert.strictEqual(assessComplexity('D\tsrc/a.js', '', 'COMPLEXITY: simple - hapus file mati').complexity, 'complex'); // sinyal keras
  assert.strictEqual(assessComplexity('M\tdb/x.sql', '', 'COMPLEXITY: simple - kecil').complexity, 'complex');
  assert.ok(buildPrompt({ context: 'c', goals: ['a', 'b'], files_hint: ['f.js'] }).includes('2. b'));
  const ip = buildPrompt({ context: 'c', goals: ['a'] }, ['/tmp/x/a.png']);
  assert.ok(ip.includes('Attached images (read them with the Read tool):\n/tmp/x/a.png'));
  assert.ok(!buildPrompt({ context: 'c', goals: ['a'] }).includes('Attached images'));
  assert.ok(!buildPrompt({ context: 'c', goals: [] }).includes('Goals'));
  assert.strictEqual(pageUrl('http://localhost:8000', 'selesai\nPAGE: /attendance'), 'http://localhost:8000/attendance');
  assert.strictEqual(pageUrl('http://localhost:8000', 'PAGE: //evil.com/x'), 'http://localhost:8000');
  assert.strictEqual(pageUrl('http://localhost:8000', 'tanpa halaman'), 'http://localhost:8000');
  const ui = require('./ui');
  const tu = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.deepStrictEqual(ui.summarize(tu('Edit', { file_path: '/home/x/proj/app/Foo.php' }), '/home/x/proj'), ['Edit app/Foo.php']);
  assert.deepStrictEqual(ui.summarize(tu('Bash', { command: 'npm test' }), '/r'), ['Bash npm test']);
  assert.deepStrictEqual(ui.summarize(tu('Grep', { pattern: 'foo' }), '/r'), ['Grep foo']);
  assert.deepStrictEqual(ui.summarize(tu('WebFetch', {}), '/r'), ['WebFetch']);
  assert.deepStrictEqual(ui.summarize({ type: 'assistant', message: { content: [{ type: 'text', text: 'halo\ndunia' }] } }, '/r'), ['halo dunia']);
  assert.deepStrictEqual(ui.summarize({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }, '/r'), []);
  assert.deepStrictEqual(ui.summarize({ type: 'system', subtype: 'init' }, '/r'), ['sesi dimulai']);
  assert.deepStrictEqual(ui.summarize({ type: 'system', subtype: 'hook_started' }, '/r'), []);
  assert.deepStrictEqual(ui.summarize({ type: 'result' }, '/r'), ['selesai']);
  assert.deepStrictEqual(ui.summarize({ type: 'zzz' }, '/r'), []);
  assert.deepStrictEqual(ui.summarize(null, '/r'), []);
  process.env.WORKER_TOKEN = 'rahasia123';
  assert.strictEqual(ui.redact('cat /home/x/proj/a rahasia123', '/home/x/proj'), 'cat a [token]');
  assert.strictEqual(ui.redact('a'.repeat(300), '/r').length, 200);
  for (let i = 0; i < 501; i++) ui.push('baris ' + i);
  assert.ok(ui.state.activity.length === 500 && ui.state.activity[0] === 'baris 1');
  ui.setPhase('wo', { wo_id: 'a' }); ui.push('x');
  ui.setPhase('wo', { wo_id: 'a' }); assert.strictEqual(ui.state.activity.length, 1, 'WO sama: aktivitas dipertahankan');
  ui.setPhase('wo', { wo_id: 'b' }); assert.strictEqual(ui.state.activity.length, 0, 'WO baru: aktivitas dikosongkan');
  ui.setPhase('idle', { wo_id: null });
  const rq = (method, headers) => ({ method, headers });
  assert.ok(ui.csrfOk(rq('POST', { 'x-worker-ui': '1', host: '127.0.0.1:8787' }), 8787));
  assert.ok(ui.csrfOk(rq('POST', { 'x-worker-ui': '1', host: 'localhost:8787' }), 8787));
  assert.ok(!ui.csrfOk(rq('POST', { host: '127.0.0.1:8787' }), 8787));
  assert.ok(!ui.csrfOk(rq('POST', { 'x-worker-ui': '1', host: 'evil.com' }), 8787));
  assert.ok(!ui.csrfOk(rq('POST', { 'x-worker-ui': '1', host: '127.0.0.1:9999' }), 8787));
  const got = [];
  const lr = makeLineReader((l) => got.push(l));
  lr.write('{"a":1}\n{"b"'); lr.write(':2}\n'); lr.write('tanpa newline'); lr.flush();
  assert.deepStrictEqual(got, ['{"a":1}', '{"b":2}', 'tanpa newline']);
  const t0 = Date.now();
  setTimeout(wakeUp, 10);
  const sw = sleepWake(60000).then(() => assert.ok(Date.now() - t0 < 1000, 'sleepWake harus selesai lebih awal'));
  // mergeClash: repo sementara dengan ref origin/main buatan
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-'));
  const g = (...x) => execFileSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...x], { encoding: 'utf8' }).trim();
  const commit = (file, msg) => { fs.writeFileSync(path.join(tmp, file), msg); g('add', '-A'); g('commit', '-qm', msg); };
  g('init', '-q', '-b', 'main'); commit('a.txt', 'a0'); commit('b.txt', 'b0');
  const base0 = g('rev-parse', 'HEAD');
  g('switch', '-q', '-c', 'wo/x'); commit('a.txt', 'a1');                    // WO mengubah a.txt
  g('switch', '-q', 'main'); commit('b.txt', 'b1');                          // orang lain mengubah b.txt
  g('update-ref', 'refs/remotes/origin/main', 'main');
  assert.deepStrictEqual(mergeClash(tmp, 'wo/x', 'main'), [], 'file berbeda: tidak bentrok');
  commit('a.txt', 'a2');                                                     // orang lain juga mengubah a.txt
  g('update-ref', 'refs/remotes/origin/main', 'main');
  assert.deepStrictEqual(mergeClash(tmp, 'wo/x', 'main'), ['a.txt'], 'file sama: bentrok');
  assert.ok(base0);
  fs.rmSync(tmp, { recursive: true });
  return sw.then(() => selftestSync(assert)).then(() => selftestServer(assert, ui)).then(() => console.log('selftest OK'));
}

async function selftestSync(assert) {
  const key = 'selftest-' + process.pid, f = path.join(SYNC_DIR, key);
  const run = (cmd, ttl, now) => syncDb(key, { path: '.', db_sync: { cmd, ttl_hours: ttl } }, now);
  try {
    assert.strictEqual(syncAge(key), Infinity);
    await assert.rejects(run('echo boom >&2; exit 3'), /exit 3.*boom/s);
    assert.ok(!fs.existsSync(f)); // gagal = tidak dianggap segar
    assert.strictEqual(await run('true'), true);
    assert.strictEqual(await run('exit 9'), false); // masih segar: tidak dijalankan
    assert.strictEqual(await run('true', 1, Date.now() + 2 * 3600e3), true); // lewat ttl: jalan lagi
    assert.strictEqual(await syncDb(key, { path: '.' }), false); // tanpa db_sync: dilewati
    // sources: pilih per WO, di luar daftar ditolak, ganti sumber = sync ulang, DB_SOURCE lewat env
    const ms = (cmd) => ({ path: '.', db_sync: { cmd, ttl_hours: 6, sources: ['a_db', 'b_db'], default: 'a_db' } });
    await assert.rejects(syncDb(key, ms('true'), Date.now(), 'x; rm -rf /'), /tidak ada di db_sync\.sources/);
    assert.strictEqual(await syncDb(key, ms('[ "$DB_SOURCE" = a_db ]')), true); // default
    assert.strictEqual(await syncDb(key, ms('exit 9'), Date.now(), 'a_db'), false); // a_db masih segar
    assert.strictEqual(await syncDb(key, ms('[ "$DB_SOURCE" = b_db ]'), Date.now(), 'b_db'), true); // b_db belum
  } finally { for (const x of [f, f + '__a_db', f + '__b_db']) fs.rmSync(x, { force: true }); }
}

async function selftestServer(assert, ui) {
  const http = require('http');
  const call = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => {
      let b = '';
      s.on('data', (d) => { b += d; if (p === '/events') { s.destroy(); resolve({ status: s.statusCode, body: b }); } });
      s.on('end', () => resolve({ status: s.statusCode, body: b }));
    });
    r.on('error', reject); r.end();
  });
  const http2 = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (s) => { s.resume(); resolve({ status: s.statusCode, type: s.headers['content-type'] || '' }); }).on('error', reject));
  let stops = 0, starts = 0;
  const srv = await ui.startUI({ port: 0, onStart() { starts++; }, onStop() { stops++; } });
  const port = srv.address().port;
  const ok = { 'x-worker-ui': '1', host: `127.0.0.1:${port}` };
  assert.strictEqual((await call(port, 'POST', '/stop')).status, 403);
  assert.strictEqual((await call(port, 'POST', '/stop', { ...ok, host: 'evil.com' })).status, 403);
  assert.strictEqual(ui.state.enabled, true);
  assert.strictEqual((await call(port, 'POST', '/stop', ok)).status, 204);
  assert.ok(stops === 1 && ui.state.enabled === false);
  assert.strictEqual((await call(port, 'POST', '/start', ok)).status, 204);
  assert.ok(starts === 1 && ui.state.enabled === true);
  assert.strictEqual((await call(port, 'GET', '/nope')).status, 404);
  assert.strictEqual((await call(port, 'PUT', '/')).status, 405);
  const page = await call(port, 'GET', '/');
  assert.ok(page.status === 200 && page.body.includes('Start') && page.body.includes('Stop'));
  assert.ok(page.body.includes('app.css') && page.body.includes('app.js'));
  const css = await http2(port, '/app.css'), js = await http2(port, '/app.js'), font = await http2(port, '/fonts/geist.woff2');
  assert.ok(css.status === 200 && css.type.startsWith('text/css'));
  assert.ok(js.status === 200 && js.type.startsWith('text/javascript'));
  assert.ok(font.status === 200 && font.type === 'font/woff2');
  for (const bad of ['/fonts/../ui.js', '/..%2fworker.js', '/.env', '/fonts/OFL.txt', '/projects.json']) assert.strictEqual((await call(port, 'GET', bad)).status, 404, bad);
  for (const p of ['/events', '/', '/app.js']) assert.strictEqual((await call(port, 'GET', p, { host: 'evil.com' })).status, 403, 'GET dengan Host asing: ' + p);
  assert.ok((await call(port, 'GET', '/events')).body.startsWith('event: state'));
  assert.strictEqual(await ui.startUI({ port, onStart() {}, onStop() {} }), null); // port dipakai: UI nonaktif, tidak melempar
  srv.closeAllConnections(); srv.close();
}

if (process.argv.includes('--selftest')) selftest().catch((e) => { console.error(e); process.exit(1); });
else main();
