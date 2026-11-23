'use strict';
// UI live worker: state di memori + ringkasan event stream-json. Hanya localhost.
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

module.exports = { state, clients, send, snapshot, broadcast, redact, summarize, push, setPhase, csrfOk };
