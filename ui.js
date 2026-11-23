'use strict';
// UI live worker: state di memori + ringkasan event stream-json. Hanya localhost.
const fs = require('fs');
const path = require('path');
const MAX_LINES = 500;
const MAX_LEN = 200;

const state = {
  phase: 'idle', enabled: true, wo_id: null, project_key: null,
  started_at: null, timeout_ms: null, budget_usd: null, paused_until: null, activity: [],
};
const clients = new Set(); // diisi server SSE (res)

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const snapshot = () => ({ ...state, activity: undefined });
const broadcast = (event, data) => { for (const c of clients) { try { send(c, event, data); } catch { clients.delete(c); } } };

function redact(s, root) {
  let t = String(s);
  if (root) t = t.split(root + '/').join('').split(root).join('.');
  const tok = process.env.WORKER_TOKEN;
  if (tok) t = t.split(tok).join('[token]');
  return t.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

// Satu event stream-json -> 0..n baris aktivitas. Tipe tak dikenal diabaikan.
function summarize(ev, root) {
  if (!ev || typeof ev !== 'object') return [];
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') out.push('sesi dimulai');
  else if (ev.type === 'result') out.push('selesai');
  else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text) out.push(b.text);
      else if (b.type === 'tool_use') {
        const i = b.input || {};
        const arg = i.file_path ?? i.pattern ?? i.command ?? '';
        out.push(`${b.name} ${arg}`.trim());
      }
    }
  }
  return out.map((l) => redact(l, root));
}

function push(line) {
  state.activity.push(line);
  if (state.activity.length > MAX_LINES) state.activity.splice(0, state.activity.length - MAX_LINES);
  broadcast('line', line);
}

function setPhase(phase, info = {}) {
  Object.assign(state, { phase }, info);
  broadcast('state', snapshot());
}

// Host harus localhost (tahan DNS rebinding), header kustom memicu preflight CORS (tahan CSRF).
function csrfOk(req, port) {
  const h = req.headers || {};
  return h['x-worker-ui'] === '1' && [`127.0.0.1:${port}`, `localhost:${port}`].includes(h.host);
}


const PUBLIC = path.join(__dirname, 'public');
// Daftar putih: hanya berkas ini yang disajikan, jadi tidak ada path traversal.
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/fonts/geist.woff2': ['fonts/geist.woff2', 'font/woff2'],
  '/fonts/geist-mono.woff2': ['fonts/geist-mono.woff2', 'font/woff2'],
};

function handle(req, res, ctl, port) {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && (url === '/start' || url === '/stop')) {
    if (!csrfOk(req, port)) { res.writeHead(403).end(); return; }
    state.enabled = url === '/start';
    (state.enabled ? ctl.onStart : ctl.onStop)();
    setPhase(state.phase);
    res.writeHead(204).end();
  } else if (req.method === 'GET' && Object.hasOwn(FILES, url)) {
    const [file, type] = FILES[url];
    // CSP: halaman hanya memuat sumber dari origin sendiri.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'" })
      .end(fs.readFileSync(path.join(PUBLIC, file)));
  } else if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, 'state', snapshot());
    for (const l of state.activity) send(res, 'line', l);
    clients.add(res);
    const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { /* koneksi putus */ } }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
  } else {
    res.writeHead(['/events', '/start', '/stop'].includes(url) || Object.hasOwn(FILES, url) ? 405 : 404).end();
  }
}

// Resolve http.Server, atau null jika port dipakai (worker tetap jalan tanpa UI).
function startUI({ port, onStart, onStop }) {
  return new Promise((resolve) => {
    const server = require('http').createServer((req, res) => {
      try { handle(req, res, { onStart, onStop }, server.address().port); }
      catch (e) { console.log('UI error:', e.message); try { res.writeHead(500).end(); } catch { /* sudah terkirim */ } }
    });
    server.once('error', (e) => { console.log(`UI nonaktif: ${e.message}`); resolve(null); });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { state, clients, send, snapshot, broadcast, redact, summarize, push, setPhase, csrfOk, startUI };
