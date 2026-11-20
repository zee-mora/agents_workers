'use strict';
// Laptop worker: ambil WO dari VPS, jalankan `claude -p` di branch git terpisah,
// verifikasi dari bukti (bukan klaim agent), lapor balik. Lihat PRD v2.
const { spawn, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env opsional */ }

const VPS_URL = (process.env.VPS_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN;
const POLL_WAIT = Number(process.env.POLL_WAIT || 25);
const PAUSE_MS = 10 * 60 * 1000;     // jeda saat kuota/login bermasalah
const MAX_BUDGET = 1.0;              // batas keras sisi worker, tidak percaya nilai dari VPS
const MAX_TIMEOUT = 1800;
const MODELS = ['haiku', 'sonnet', 'opus'];
const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*)';
const RULES = [
  '- Hanya kerjakan goals yang tertulis. Jangan refactor di luar itu.',
  '- Mulai dari file yang disarankan. Baca file sebelum mengubahnya; jangan menebak isinya.',
  '- Jangan mengklaim sesuatu lulus/jalan tanpa menjalankan perintahnya.',
  '- Tidak yakin atau butuh info yang tidak ada: berhenti dan tulis "BLOCKED: <alasan>". Jangan mengarang.',
  '- Jawaban akhir maksimal 10 baris: file yang diubah + alasan.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 2000) => String(s || '').slice(-n);
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- fungsi murni (dites di --selftest) ----------

function parseResult(out) {
  const d = JSON.parse(out);
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

function classify(r) {
  if (!r.is_error) return null;
  return r.subtype === 'error_max_budget_usd' ? 'OVER_BUDGET' : 'FAILED';
}

const isQuota = (r) => r.is_error && /limit|rate|overload|429|not logged in/i.test(r.text + ' ' + r.errors.join(' '));

const unsafeFile = (f) => /(^|\/)\.env/.test(f) || /(^|\/)\.git\//.test(f);

function localUrlOk(u) {
  try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; }
}

function buildPrompt(wo) {
  const goals = wo.goals.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const hint = (wo.files_hint || []).length ? `\n\nFile untuk dimulai:\n${wo.files_hint.join('\n')}` : '';
  return `Context: ${wo.context}\n\nGoals:\n${goals}${hint}`;
}

// ---------- VPS API ----------

async function api(method, p, body, timeoutMs = 15000) {
  const res = await fetch(VPS_URL + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  return res.json();
}

// ---------- eksekusi ----------

function runClaude(cwd, prompt, wo) {
  const lim = wo.limits || {};
  const budget = Math.min(Number(lim.max_budget_usd) || 0.5, MAX_BUDGET);
  const timeout = Math.min(Number(lim.timeout_sec) || 600, MAX_TIMEOUT) * 1000;
  const model = MODELS.includes(lim.model) ? lim.model : 'sonnet';
  // prompt harus sebelum --allowedTools (variadic). Tanpa shell: tidak ada injection.
  const args = ['-p', prompt, '--output-format', 'json', '--model', model,
    '--max-budget-usd', String(budget), '--permission-mode', 'acceptEdits',
    '--append-system-prompt', RULES, '--allowedTools', ALLOWED_TOOLS];
  const env = { ...process.env };
  delete env.WORKER_TOKEN; // agent tidak boleh melihat token VPS

  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ stdout, stderr: String(e), code: -1, timedOut }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code, timedOut }); });
  });
}

async function screenshot(url, viewport, out) {
  if (!localUrlOk(url)) return 'URL ditolak (hanya localhost/127.0.0.1)';
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: viewport?.width ? viewport : { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.screenshot({ path: out, fullPage: true });
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
  const result = { status: 'FAILED', exit_code: null, turns: null, tokens: null, cost_usd: null,
    diff_stat: null, verify_passed: null, branch: null, logs: '' };
  const hb = setInterval(() => api('POST', `/api/wo/${wo.id}/heartbeat`, {}).catch(() => {}), 30000);
  let dir, base, shot, quota = false;

  try {
    const proj = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'))[wo.project_key];
    if (!proj || !/^[\w.-]+$/.test(wo.id)) { result.logs = 'project_key tidak ada di projects.json atau id tidak valid'; return false; }
    dir = proj.path;
    if (!fs.existsSync(dir)) { result.logs = `folder tidak ada: ${dir}`; return false; }
    if (git(dir, 'status', '--porcelain')) { result.logs = 'working tree kotor, WO ditolak'; return false; }

    base = git(dir, 'rev-parse', 'HEAD');
    const baseBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    result.branch = `wo/${wo.id}-${wo.attempts || 0}`;
    git(dir, 'switch', '-c', result.branch);

    const run = await runClaude(dir, buildPrompt(wo), wo);
    result.exit_code = run.code;
    if (run.timedOut) { result.logs = 'timeout, proses dihentikan'; return false; }

    let r;
    try { r = parseResult(run.stdout); } catch { result.logs = `output bukan JSON: ${tail(run.stdout || run.stderr)}`; return false; }
    result.turns = r.turns; result.tokens = r.tokens; result.cost_usd = r.cost;
    result.logs = tail(r.text || r.errors.join('; '));
    quota = isQuota(r);

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

    if (proj.verify) {
      const v = spawnSync('bash', ['-c', proj.verify], { cwd: dir, encoding: 'utf8', timeout: 300000 });
      result.verify_passed = v.status === 0;
      if (!result.verify_passed) { result.status = 'NEEDS_REVIEW'; result.logs = 'verifikasi gagal:\n' + tail(v.stdout + v.stderr); return false; }
    }

    const url = wo.verification?.target_url || proj.url;
    if (url) {
      shot = path.join(os.tmpdir(), `${wo.id}.png`);
      const err = await screenshot(url, wo.verification?.viewport, shot);
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
    if (shot) fs.rm(shot, () => {});
  }
}

async function main() {
  if (!TOKEN) { console.error('WORKER_TOKEN kosong (isi .env)'); process.exit(1); }
  log(`worker aktif -> ${VPS_URL}`);
  for (;;) {
    try {
      const { wo } = await api('GET', `/api/wo/next?wait=${POLL_WAIT}`, null, (POLL_WAIT + 10) * 1000);
      if (!wo) { await sleep(2000); continue; }
      if (await processWO(wo)) { log('kuota/login bermasalah, jeda 10 menit'); await sleep(PAUSE_MS); }
    } catch (e) {
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
  const budget = parseResult(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', errors: ['Reached maximum budget'] }));
  assert.strictEqual(classify(budget), 'OVER_BUDGET');
  assert.strictEqual(isQuota(budget), false);
  const login = parseResult(JSON.stringify({ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' }));
  assert.strictEqual(classify(login), 'FAILED');
  assert.strictEqual(isQuota(login), true);
  assert.ok(unsafeFile('app/.env') && unsafeFile('.git/config') && !unsafeFile('src/env.js'));
  assert.ok(localUrlOk('http://localhost:8000/x') && !localUrlOk('http://evil.com') && !localUrlOk('file:///etc/passwd'));
  assert.ok(buildPrompt({ context: 'c', goals: ['a', 'b'], files_hint: ['f.js'] }).includes('2. b'));
  console.log('selftest OK');
}

if (process.argv.includes('--selftest')) selftest();
else main();
