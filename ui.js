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


const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Worker</title>
<style>
:root{--bg:#f6f6f4;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--bd:#dcdcd6;--ok:#1a7f4b;--warn:#a15c00;--off:#8a8a85;--btn:#1c1c1a;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141413;--fg:#ecece8;--mut:#9a9a94;--card:#1d1d1b;--bd:#33332f;--ok:#4cc38a;--warn:#e0a040;--off:#77776f;--btn:#ecece8;--btnfg:#141413}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:12px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.badge{font-weight:600}.badge::before{content:"";display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--c,var(--off));margin-right:8px}
.meta{color:var(--mut);font-size:13px}
button{font:inherit;border:1px solid var(--bd);background:var(--btn);color:var(--btnfg);border-radius:8px;padding:8px 16px;cursor:pointer}
button:disabled{opacity:.35;cursor:not-allowed}
#log{font:13px/1.5 ui-monospace,monospace;height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
#log div{padding:1px 0}
</style></head><body><main>
<h1>Agent Worker</h1>
<div class="card"><div class="row">
 <div><div class="badge" id="badge">…</div><div class="meta" id="meta"></div></div>
 <div><button id="start">Start</button> <button id="stop">Stop</button></div>
</div></div>
<div class="card"><pre id="log" aria-live="polite"></pre></div>
</main><script>
const $=(i)=>document.getElementById(i);let st={};const log=$('log');
const fmt=(ms)=>{ms=Math.max(0,Math.round(ms/1000));return Math.floor(ms/60)+':'+String(ms%60).padStart(2,'0')};
function render(){
 const busy=st.phase==='wo'||st.phase==='merge';
 let t,c='var(--ok)';
 if(!st.enabled){t=busy?'Menghentikan setelah WO selesai':'Berhenti';c=busy?'var(--warn)':'var(--off)'}
 else if(st.phase==='wo')t='Mengerjakan WO';
 else if(st.phase==='merge')t='Merge';
 else if(st.phase==='paused'){t='Jeda (kuota/login)';c='var(--warn)'}
 else t='Menunggu WO';
 $('badge').textContent=t;$('badge').style.setProperty('--c',c);
 let m='';
 if(busy){m=(st.wo_id||'')+' · '+(st.project_key||'');
  if(st.started_at&&st.timeout_ms)m+=' · sisa waktu '+fmt(st.started_at+st.timeout_ms-Date.now());
  if(st.budget_usd)m+=' · budget $'+st.budget_usd}
 else if(st.phase==='paused'&&st.paused_until)m='lanjut dalam '+fmt(st.paused_until-Date.now());
 $('meta').textContent=m;
 $('start').disabled=!!st.enabled;$('stop').disabled=!st.enabled;
}
function add(l){const stick=log.scrollTop+log.clientHeight>=log.scrollHeight-8;const d=document.createElement('div');d.textContent=l;log.appendChild(d);while(log.children.length>500)log.firstChild.remove();if(stick)log.scrollTop=log.scrollHeight}
const es=new EventSource('/events');
es.addEventListener('state',(e)=>{st=JSON.parse(e.data);render()});
es.addEventListener('line',(e)=>add(JSON.parse(e.data)));
const post=(p)=>fetch(p,{method:'POST',headers:{'X-Worker-UI':'1'}});
$('start').onclick=()=>post('/start');$('stop').onclick=()=>post('/stop');
setInterval(render,1000);
</script></body></html>`;

function handle(req, res, ctl, port) {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && (url === '/start' || url === '/stop')) {
    if (!csrfOk(req, port)) { res.writeHead(403).end(); return; }
    state.enabled = url === '/start';
    (state.enabled ? ctl.onStart : ctl.onStop)();
    setPhase(state.phase);
    res.writeHead(204).end();
  } else if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, 'state', snapshot());
    for (const l of state.activity) send(res, 'line', l);
    clients.add(res);
    const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { /* koneksi putus */ } }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
  } else {
    res.writeHead(['/', '/events', '/start', '/stop'].includes(url) ? 405 : 404).end();
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
