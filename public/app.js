'use strict';
const $ = (id) => document.getElementById(id);
const log = $('log');
let st = {};
let last = ''; // baris aktivitas terakhir, untuk kalimat besar

const VERB = { Read: 'Membaca', Edit: 'Mengedit', Write: 'Menulis', Bash: 'Menjalankan', Grep: 'Mencari', Glob: 'Mencari' };
const KIND = { Edit: 'edit', Write: 'edit', Bash: 'run' };
const TOOL = /^(Read|Edit|Write|Glob|Grep|Bash|WebFetch|WebSearch|Task|NotebookEdit)\b ?(.*)$/s;

// Path boleh patah setelah '/', bukan di tengah nama.
const setText = (el, s) => el.replaceChildren(...s.split(/(?<=\/)/).flatMap((p, i) => (i ? [document.createElement('wbr'), p] : [p])));
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clock = () => new Date().toLocaleTimeString('id-ID', { hour12: false });

function describe(line) {
  const m = TOOL.exec(line);
  if (m && VERB[m[1]]) return `${VERB[m[1]]} ${m[2]}`.trim();
  return line;
}

function render() {
  const busy = st.phase === 'wo' || st.phase === 'merge';
  let text, color = 'var(--ok)';
  if (!st.enabled) { text = busy ? 'Menghentikan setelah WO selesai' : 'Berhenti'; color = busy ? 'var(--warn)' : 'var(--off)'; }
  else if (st.phase === 'wo') text = 'Mengerjakan WO';
  else if (st.phase === 'merge') text = 'Merge';
  else if (st.phase === 'paused') { text = 'Jeda: kuota atau login bermasalah'; color = 'var(--warn)'; }
  else text = 'Menunggu WO';
  document.body.classList.toggle('working', busy);
  $('status').textContent = text;
  $('dot').style.setProperty('--c', color);

  let doing = ' ';
  if (busy) doing = last ? describe(last) : 'Memulai…';
  else if (st.phase === 'paused') doing = 'Lanjut otomatis setelah jeda';
  else if (!st.enabled) doing = 'Worker tidak mengambil job baru';
  else doing = 'Menunggu WO dari antrean';
  setText($('doing'), doing);

  let meta = '';
  let pct = null;
  if (busy) {
    meta = [st.wo_id, st.project_key].filter(Boolean).join(' · ');
    if (st.started_at && st.timeout_ms) {
      const left = st.started_at + st.timeout_ms - Date.now();
      meta += ` · sisa waktu ${fmt(left)}`;
      pct = Math.min(100, Math.max(0, 100 - (left / st.timeout_ms) * 100));
    }
    if (st.budget_usd) meta += ` · batas biaya $${st.budget_usd}`;
  } else if (st.phase === 'paused' && st.paused_until) meta = `lanjut dalam ${fmt(st.paused_until - Date.now())}`;
  $('meta').textContent = meta;
  $('bar').hidden = pct === null;
  if (pct !== null) $('barfill').style.width = `${pct}%`;

  $('start').disabled = !!st.enabled;
  $('stop').disabled = !st.enabled;
}

function add(line) {
  last = line;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const m = TOOL.exec(line);
  const li = document.createElement('li');
  const t = document.createElement('time'); t.textContent = clock();
  const tag = document.createElement('span'); tag.className = 'tag';
  const txt = document.createElement('span'); txt.className = 'txt';
  if (m) { tag.textContent = m[1]; tag.classList.add(KIND[m[1]] || 'read'); setText(txt, m[2]); }
  else { li.className = 'msg'; txt.textContent = line; }
  li.append(t, tag, txt);
  log.append(li);
  while (log.children.length > 500) log.firstChild.remove();
  $('empty').hidden = true;
  if (stick) log.scrollTop = log.scrollHeight;
  render();
}

const es = new EventSource('/events');
// Tiap (re)connect server mengirim ulang seluruh buffer: kosongkan dulu agar tidak dobel.
es.addEventListener('open', () => { log.replaceChildren(); $('empty').hidden = false; last = ''; });
es.addEventListener('state', (e) => {
  const n = JSON.parse(e.data);
  if (n.wo_id && n.wo_id !== st.wo_id) { log.replaceChildren(); $('empty').hidden = false; last = ''; } // WO baru: transkrip baru
  st = n; render();
});
es.addEventListener('line', (e) => add(JSON.parse(e.data)));
const post = (p) => fetch(p, { method: 'POST', headers: { 'X-Worker-UI': '1' } });
$('start').onclick = () => post('/start');
$('stop').onclick = () => post('/stop');
setInterval(render, 1000);
