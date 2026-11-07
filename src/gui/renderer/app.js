// The QA Recorder window. Plain script, no build step: state → HTML strings → #sidebar and #main.
// Every button has data-action; one click listener dispatches to `actions`.
'use strict';

const KIND = { bug: '🐛 Bug', dislike: '👎 Dislike', idea: '💡 Idea', like: '👍 Like', spoken: '🎙 Spoken' };
const VOICE_OPTIONS = [['off', '🔇 No voice'], ['push-to-talk', '🎙 Push-to-talk (F6)'], ['open-mic', '🎙 Open mic']];

/** The voice choice is remembered per target. localStorage can be unavailable; then it is just not remembered. */
function voiceFor(targetId) {
  try {
    return localStorage.getItem(`voice:${targetId}`) ?? 'off';
  } catch {
    return 'off';
  }
}
function rememberVoice(targetId, voice) {
  try {
    localStorage.setItem(`voice:${targetId}`, voice);
  } catch { /* not remembered */ }
}

// ---------- microphone: captured here (the app under test can't ask for it) and streamed to the session ----------

const mics = new Map(); // session id → { stop }

const MIC_KEY = 'mic-device';
function savedMic() {
  try {
    return localStorage.getItem(MIC_KEY) || undefined;
  } catch {
    return undefined;
  }
}
function saveMic(deviceId) {
  try {
    if (deviceId) localStorage.setItem(MIC_KEY, deviceId);
    else localStorage.removeItem(MIC_KEY);
  } catch { /* not remembered */ }
}

/**
 * The microphone picked on the Microphone page (or the default), unprocessed: the browser's noise suppression,
 * echo cancellation and auto gain muffle speech, and Whisper copes with background noise better than with that.
 */
async function openMic() {
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const deviceId = savedMic();
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
  } catch (e) {
    if (!deviceId || e.name !== 'OverconstrainedError') throw e;
    saveMic(undefined); // that microphone is gone; use the default
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}

/**
 * 16 kHz mono from a stream: { ctx, stop() → Float32Array of what was kept }. onBlock sees each 100 ms block;
 * keep: false for long recordings that are saved elsewhere.
 */
async function capture16k(stream, onBlock = () => {}, { keep = true } = {}) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('mic-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const blocks = [];
  node.port.onmessage = e => {
    if (keep) blocks.push(e.data);
    onBlock(e.data);
  };
  source.connect(node);
  return {
    ctx,
    stop() {
      source.disconnect();
      void ctx.close();
      const all = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of blocks) {
        all.set(b, at);
        at += b.length;
      }
      return all;
    },
  };
}

/** A WAV blob URL for playing a test recording back. */
function wavUrl(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return URL.createObjectURL(new Blob([view], { type: 'audio/wav' }));
}

async function startMic(sessionId, stream, voice) {
  let ctx;
  // the block ended just now; date its first sample. Blocks aren't kept: the session saves its own audio.
  const recorder = await capture16k(stream, samples => {
    window.qa.sendAudio(sessionId, samples, Date.now() - (samples.length / 16) - (ctx?.baseLatency ?? 0) * 1000);
  }, { keep: false });
  ctx = recorder.ctx;
  mics.set(sessionId, {
    voice,
    label: stream.getAudioTracks()[0]?.label,
    stop() {
      recorder.stop();
      stream.getTracks().forEach(track => track.stop());
      mics.delete(sessionId);
    },
  });
}
const ERROR_TYPES = ['console.error', 'pageerror', 'requestfailed', 'http'];

const state = {
  info: null,
  targets: [],
  sessions: [],
  view: { kind: 'sessions' },
  logs: {}, // scope (target id or session id) → lines
  latest: {}, // target id → latest CI build, or { error }
  busy: {}, // key → true while an action runs
};

// ---------- helpers ----------

class Raw { constructor(s) { this.s = s; } }
const raw = s => new Raw(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function html(strings, ...values) {
  const out = strings.reduce((acc, s, i) => {
    const v = values[i - 1];
    const text = v instanceof Raw ? v.s : Array.isArray(v) ? v.map(x => (x instanceof Raw ? x.s : esc(x))).join('') : v === false || v == null ? '' : esc(v);
    return acc + text + s;
  });
  return raw(out);
}

async function api(channel, ...args) {
  try {
    return await window.qa.invoke(channel, ...args);
  } catch (e) {
    toast(cleanError(e), true);
    e.shown = true; // the click dispatcher shouldn't show it again
    throw e;
  }
}

const spinner = raw('<span class="spinner" aria-hidden="true"></span>');
const cleanError = e => String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer;
function toast(message, error = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 9000 : 3500);
}

const mb = n => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`);
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const when = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sha7 = b => (b?.sha && b.sha !== 'local' ? b.sha.slice(0, 7) : b?.source === 'local' ? 'local' : '');
const kinds = k => Object.entries(k ?? {}).map(([kind, n]) => `${(KIND[kind] ?? kind).split(' ')[0]}${n}`).join(' ');
const isLive = s => s.status === 'running' || s.status === 'starting';
const fileUrl = (sessionId, rel) => `qa-file://session/${encodeURIComponent(sessionId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

function busy(key, fn) {
  return async (...args) => {
    if (state.busy[key]) return;
    state.busy[key] = true;
    render();
    try {
      return await fn(...args);
    } finally {
      delete state.busy[key];
      render();
    }
  };
}

function addLog(scope, line) {
  (state.logs[scope] ??= []).push(line);
  if (state.logs[scope].length > 300) state.logs[scope].shift();
}

// ---------- data ----------

async function refresh() {
  [state.targets, state.sessions] = await Promise.all([api('targets:list'), api('sessions:list')]);
  render();
}

async function checkLatest(targetId) {
  const t = state.targets.find(x => x.id === targetId);
  if (t?.build?.type !== 'github-actions') return;
  try {
    state.latest[targetId] = { build: await window.qa.invoke('builds:latest', targetId), downloads: await api('builds:forTarget', targetId) };
  } catch (e) {
    state.latest[targetId] = { error: cleanError(e), downloads: await api('builds:forTarget', targetId) };
  }
  render();
}

// ---------- views ----------

function sidebar() {
  const v = state.view;
  const liveByTarget = new Set(state.sessions.filter(isLive).map(s => s.target.id));
  return html`
    <h2>Targets</h2>
    ${state.targets.map(t => html`
      <button class="nav ${v.kind === 'target' && v.id === t.id ? 'on' : ''} ${t.available || t.error ? '' : 'off'}" data-action="go" data-kind="target" data-id="${t.id}"
        title="${t.error ? 'This config is broken' : t.available ? t.description ?? '' : `Not available on ${state.info?.platform}`}">
        <span class="grow">${t.error ? '⚠ ' : ''}${t.name}</span>${liveByTarget.has(t.id) ? raw('<span class="dot" title="Session running"></span>') : ''}
      </button>`)}
    <button class="nav ${v.kind === 'new' ? 'on' : ''}" data-action="go" data-kind="new">＋ New target</button>
    <h2>Sessions</h2>
    <button class="nav ${v.kind === 'sessions' ? 'on' : ''}" data-action="go" data-kind="sessions">
      <span class="grow">All sessions</span>${state.sessions.some(isLive) ? raw('<span class="dot"></span>') : ''}
    </button>
    <button class="nav ${v.kind === 'storage' ? 'on' : ''}" data-action="go" data-kind="storage">Storage and cleanup</button>
    <button class="nav ${v.kind === 'mic' ? 'on' : ''}" data-action="go" data-kind="mic">Microphone</button>`;
}

function sessionsTable(sessions, { showTarget }) {
  if (!sessions.length) return html`<div class="empty">No sessions yet.</div>`;
  return html`<table>
    <tr><th>Started</th>${showTarget ? raw('<th>Target</th>') : ''}<th>Build</th><th>Notes</th><th>Errors</th><th>Size</th><th>Status</th></tr>
    ${sessions.map(s => html`
      <tr class="clickable" data-action="go" data-kind="session" data-id="${s.id}">
        <td>${when(s.startedAt)}</td>
        ${showTarget ? html`<td>${s.target.name}</td>` : ''}
        <td class="mono">${sha7(s.build)}</td>
        <td>${s.notes}${s.notes ? html` <span class="muted small">${kinds(s.kinds)}</span>` : ''}</td>
        <td>${s.errors ?? ''}</td>
        <td>${mb(s.size)}</td>
        <td><span class="badge ${s.status}">${s.status}</span></td>
      </tr>`)}
  </table>`;
}

function targetView(t) {
  if (t.error) {
    return html`<div class="head"><div class="grow"><h1>⚠ ${t.name}</h1><div class="muted small mono">${t.file}</div></div>
      <button class="btn" data-action="edit" data-id="${t.id}">Fix config</button></div>
      <div class="card"><h3>This config doesn't load</h3><pre class="log">${t.error}</pre></div>`;
  }
  const sessions = state.sessions.filter(s => s.target.id === t.id);
  const running = sessions.find(isLive);
  const ci = t.build?.type === 'github-actions';
  const latest = state.latest[t.id];
  const downloads = latest?.downloads ?? [];
  const latestDownloaded = latest?.build && downloads.some(d => d.runId === latest.build.runId);
  const log = state.logs[t.id];
  return html`
    <div class="head">
      <div class="grow">
        <h1>${t.name}</h1>
        <div class="muted">${t.description ?? ''}</div>
        <div class="muted small">${t.source === 'bundled' ? 'Bundled target' : t.overrides ? 'Your edited copy of a bundled target' : 'Your target'} · ${t.launchType}${t.url ? html` · <span class="mono">${t.url}</span>` : ''}</div>
      </div>
      <button class="btn" data-action="edit" data-id="${t.id}">Edit config</button>
      ${running ? '' : html`<select id="voice-choice" title="Voice for this session" aria-label="Voice">
          ${VOICE_OPTIONS.map(([value, label]) => html`<option value="${value}" ${voiceFor(t.id) === value ? raw('selected') : ''}>${label}</option>`)}
        </select>`}
      ${running
        ? html`<button class="btn primary" data-action="go" data-kind="session" data-id="${running.id}">View running session</button>`
        : html`<button class="btn primary" data-action="start" data-id="${t.id}" ${!t.available || state.busy[`start:${t.id}`] ? raw('disabled') : ''}
            title="${t.available ? '' : `This target is for ${t.platforms?.join(', ')}`}">${state.busy[`start:${t.id}`] ? html`${spinner} Starting…` : '▶ Start session'}</button>`}
    </div>
    ${ci ? html`
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">Build: <span class="mono">${t.build.repo}</span> · ${t.build.workflow} · ${t.build.branch ?? 'develop'} · ${t.build.artifact}</h3>
          <button class="btn" data-action="check" data-id="${t.id}" ${state.busy[`check:${t.id}`] ? raw('disabled') : ''}>${state.busy[`check:${t.id}`] ? html`${spinner} Checking…` : 'Check for new build'}</button>
        </div>
        ${!latest ? html`<p class="muted">${spinner} Checking the latest build…</p>`
          : latest.error ? html`<p class="errors">${latest.error}</p>`
          : html`<p>Latest: <b class="mono">${sha7(latest.build)}</b> ${latest.build.title} <span class="muted small">(run ${latest.build.runId}, ${ago(latest.build.createdAt)})</span>
              ${latestDownloaded ? html`<span class="badge ok">downloaded</span>`
                : html`<span class="badge new">new</span> <button class="btn" data-action="download" data-id="${t.id}" data-run="${latest.build.runId}" ${state.busy[`download:${t.id}`] ? raw('disabled') : ''}>${state.busy[`download:${t.id}`] ? html`${spinner} Downloading…` : `Download${latest.build.artifactSize ? ` (${mb(latest.build.artifactSize)})` : ''}`}</button>`}</p>`}
        ${downloads.length ? html`
          <div class="row"><label for="build-choice">Run sessions on</label>
            <select id="build-choice">
              ${downloads.map((d, i) => html`<option value="${d.runId}" ${(state.view.runId ?? downloads[0].runId) === d.runId ? raw('selected') : ''}>${sha7(d)} · ${d.title} · ${ago(d.createdAt)} · ${mb(d.size)}${i === 0 ? ' (newest download)' : ''}</option>`)}
            </select>
          </div>`
        : latest ? html`<p class="muted small">Nothing downloaded yet; starting a session will offer to download the latest.</p>` : ''}
      </div>` : ''}
    ${log?.length ? html`<div class="card"><h3>Log</h3><pre class="log">${log.join('\n')}</pre></div>` : ''}
    <div class="card"><h3>Sessions</h3>${sessionsTable(sessions, { showTarget: false })}</div>`;
}

function sessionView(s, detail) {
  const notes = detail?.notes ?? [];
  const errors = (detail?.events ?? []).filter(e => ERROR_TYPES.includes(e.type));
  const live = isLive(s);
  const log = state.logs[s.id];
  return html`
    <div class="head">
      <div class="grow">
        <h1>${s.target.name}</h1>
        <div class="muted">${when(s.startedAt)} · <span class="badge ${s.status}">${s.status}</span>
          ${s.build?.sha ? html` · build <span class="mono">${sha7(s.build)}</span> ${s.build.title ?? ''}` : ''}</div>
      </div>
      ${live ? html`<button class="btn primary" data-action="finish" data-id="${s.id}">Finish session</button>` : ''}
      <button class="btn" data-action="handoff" data-id="${s.id}" ${notes.length || detail?.speech?.length ? '' : raw('disabled')} title="Copies: Read …/HANDOFF.md and follow it.">Copy hand-off</button>
      ${live ? '' : html`<button class="btn danger" data-action="delete-session" data-id="${s.id}">Delete</button>`}
    </div>
    <div class="path muted small mono" title="${s.dir}">${s.dir}</div>
    <div class="row files">
      <span class="muted small">Open</span>
      <button class="btn small-btn" data-action="open" data-path="${s.dir}/feedback.md">feedback.md</button>
      <button class="btn small-btn" data-action="open" data-path="${s.dir}/timeline.md">timeline.md</button>
      ${detail?.speech?.length ? html`<button class="btn small-btn" data-action="open" data-path="${s.dir}/transcript.md">transcript.md</button>` : ''}
      ${(s.trace ?? []).map((f, i, all) => html`<button class="btn small-btn" data-action="trace" data-id="${s.id}" data-file="${f}" title="Playwright Trace Viewer: network and console, with the timeline as markers">${all.length > 1 ? `trace ${i + 1}` : 'trace'}</button>`)}
      ${s.audio?.file ? html`<button class="btn small-btn" data-action="play" data-src="${fileUrl(s.id, s.audio.file)}" title="The whole session's audio">▶ all audio</button>` : ''}
      <button class="btn small-btn" data-action="open" data-path="${s.dir}">folder</button>
      ${detail?.speech?.length && !live ? html`<span class="grow"></span>
        <span class="muted small">${s.transcribedWith ? `Transcribed again with ${s.transcribedWith.split('/').pop()}` : ''}</span>
        <button class="btn small-btn" data-action="retranscribe" data-id="${s.id}" ${state.busy[`retranscribe:${s.id}`] ? raw('disabled') : ''}
          title="Run all of this session's speech through the larger Whisper model (slower, more accurate)">${state.busy[`retranscribe:${s.id}`] ? html`${spinner} ${state.retranscribeStatus ?? 'Re-transcribing…'}` : 'Re-transcribe with the better model'}</button>` : ''}
    </div>
    ${s.error ? html`<div class="card"><h3>The session hit an error</h3><pre class="log">${s.error}</pre></div>` : ''}
    ${live ? html`<div class="card"><h3>Live</h3>
      <p class="muted small">In the app: F8 pick an element · F9 drag a region · F7 general note · ⇄ moves the toolbar · Finish twice ends the session.</p>
      ${mics.has(s.id) ? html`<p class="small"><span class="dot inline"></span> Microphone on (${mics.get(s.id).voice === 'open-mic' ? 'open mic: everything you say is transcribed; 🎙 on the toolbar mutes' : 'push-to-talk: hold F6 in the app, or hold 🎙 on its toolbar'}).</p>` : ''}
      <pre class="log">${(log ?? []).join('\n')}</pre></div>` : ''}
    ${summaryRow(s, detail, errors)}
    ${notesSection(s, notes, remarks(detail), live)}
    ${timelineCard(s.id, detail?.timeline ?? [], live, state.view.timelineFilter ?? 'all')}`;
}

/** Open-mic utterances (push-to-talk ones are notes already). */
const remarks = detail => (detail?.speech ?? []).filter(x => x.mode !== 'push-to-talk');

function duration(s) {
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.now();
  const sec = Math.max(0, Math.round((end - Date.parse(s.startedAt)) / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

function summaryRow(s, detail, errors) {
  const actions = (detail?.events ?? []).filter(e => e.type === 'action' && !e.setup).length;
  const voice = { 'open-mic': '🎙 open mic', 'push-to-talk': '🎙 push-to-talk' }[s.voice] ?? (detail?.speech?.length ? '🎙 voice' : '');
  const stat = (n, one, many, filter) => html`<button class="stat" data-action="timeline-filter" data-filter="${filter}" title="Show in the timeline"><b>${n}</b> ${n === 1 ? one : many}</button>`;
  return html`<div class="row stats">
    <span class="stat plain"><b>${duration(s)}</b>${s.endedAt ? '' : ' so far'}</span>
    ${stat(detail?.notes?.length ?? 0, 'note', 'notes', 'said')}
    ${remarks(detail).length ? stat(remarks(detail).length, 'spoken remark', 'spoken remarks', 'said') : ''}
    ${stat(actions, 'action', 'actions', 'actions')}
    ${stat(s.pages ?? 0, 'page', 'pages', 'pages')}
    ${stat(errors.length, 'error', 'errors', 'errors')}
    ${voice ? html`<span class="stat plain">${voice}</span>` : ''}
  </div>`;
}

function notesSection(s, notes, spoken, live) {
  if (!notes.length && !spoken.length) {
    return html`<div class="empty">${live ? 'Notes and spoken remarks appear here as you make them.' : 'No notes or spoken remarks in this session.'}</div>`;
  }
  return html`
    ${notes.length ? html`<h3>${notes.length} note${notes.length === 1 ? '' : 's'}</h3><div class="notes">${notes.map(n => noteCard(s.id, n))}</div>` : ''}
    ${spoken.length ? html`<h3 style="margin-top:16px">${spoken.length} spoken remark${spoken.length === 1 ? '' : 's'} <span class="muted small">(open mic)</span></h3>
      <div class="notes">${spoken.map(x => remarkCard(s, x))}</div>` : ''}`;
}

const clockOf = (s, iso) => {
  const sec = Math.max(0, Math.round((Date.parse(iso) - Date.parse(s.startedAt)) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

/** Plays a WAV, or (clip: [from, to] seconds) just that part of the session recording via a media fragment. */
const playButton = (sessionId, audio, label = '▶', clip) =>
  audio ? html`<button class="btn small-btn play" data-action="play" data-src="${fileUrl(sessionId, audio)}${clip ? `#t=${clip[0]},${clip[1] + 0.3}` : ''}" title="Play what was said">${label}</button>` : '';

function remarkCard(s, x) {
  return html`<div class="note">
    ${x.screenshot ? html`<img src="${fileUrl(s.id, x.screenshot)}" alt="screen when this was said" data-action="zoom" data-src="${fileUrl(s.id, x.screenshot)}">` : ''}
    <div class="body">
      <div class="row" style="justify-content:space-between"><b>🎙 at ${clockOf(s, x.at)}</b>${playButton(s.id, x.audio, '▶ Play', x.clip)}</div>
      <div class="text">${x.transcribing ? html`${spinner} transcribing…` : `“${x.text}”`}</div>
    </div>
  </div>`;
}

const TIMELINE_ICON = { action: '›', navigate: '↪', error: '⚠', note: '📝', speech: '🎙', end: '■' };
const TIMELINE_FILTERS = [
  ['all', 'Everything', () => true],
  ['said', 'Notes & speech', r => r.kind === 'note' || r.kind === 'speech'],
  ['actions', 'Actions', r => r.kind === 'action'],
  ['pages', 'Pages', r => r.kind === 'navigate'],
  ['errors', 'Errors', r => r.kind === 'error'],
];

function timelineCard(sessionId, rows, live, filter) {
  if (!rows.length) return '';
  const [, , keep] = TIMELINE_FILTERS.find(f => f[0] === filter) ?? TIMELINE_FILTERS[0];
  const shown = rows.filter(keep);
  return html`<div class="card" style="margin-top:16px" id="timeline-card">
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <h3 style="margin:0">Timeline <span class="muted small">(${rows.length} entries${live ? ', updates as you go' : ''})</span></h3>
      <div class="row chips">${TIMELINE_FILTERS.map(([id, label]) => html`<button class="chip ${id === filter ? 'on' : ''}" data-action="timeline-filter" data-filter="${id}">${label} <span class="muted">${rows.filter(TIMELINE_FILTERS.find(f => f[0] === id)[2]).length}</span></button>`)}</div>
    </div>
    <div class="timeline" id="timeline">${shown.length ? shown.map(r => html`
      <div class="tl ${r.kind}${r.setup ? ' setup' : ''}">
        <span class="mono muted">${r.clock}</span><span class="icon">${TIMELINE_ICON[r.kind] ?? '·'}</span>
        <span>${r.text}${r.setup ? html` <span class="muted small">(setup)</span>` : ''} ${playButton(sessionId, r.audio, '▶', r.clip)}</span>
        ${r.link ? html`<img class="thumb" src="${fileUrl(sessionId, r.link)}" alt="" data-action="zoom" data-src="${fileUrl(sessionId, r.full ?? r.link)}">` : html`<span></span>`}
      </div>`) : html`<div class="muted small">Nothing of this kind in this session.</div>`}
    </div></div>`;
}

function noteCard(sessionId, n) {
  const img = n.screenshots.crop ?? n.screenshots.full;
  const t = n.target;
  return html`<div class="note">
    <img src="${fileUrl(sessionId, img)}" alt="screenshot for note ${n.id}" data-action="zoom" data-src="${fileUrl(sessionId, n.screenshots.full)}">
    <div class="body">
      <div class="row" style="justify-content:space-between"><b>${n.id}. ${KIND[n.kind] ?? n.kind}</b>
        <span class="row" style="gap:6px">${playButton(sessionId, n.audio)}<span class="muted small">${new Date(n.at).toLocaleTimeString()}</span></span></div>
      <div class="text">${n.transcribing ? html`${spinner} transcribing…` : n.text || '(no text)'}</div>
      <div class="muted small mono">${shortUrl(n.url)}</div>
      ${t ? html`<div class="muted small">on <code>${t.tag}</code>${t.text ? html` “${t.text.slice(0, 60)}”` : ''}${t.attrs?.['aria-label'] ? html` [${t.attrs['aria-label']}]` : ''}</div>` : ''}
      ${n.steps?.length ? html`<details class="steps"><summary class="muted small">${n.steps.length} step${n.steps.length === 1 ? '' : 's'} before this note</summary>
        <ol class="small">${n.steps.slice(-10).map(step => html`<li>${step}</li>`)}</ol></details>` : ''}
    </div>
  </div>`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === '0.0.0.1' ? u.pathname + u.search : u.href;
  } catch {
    return url;
  }
}

function editorView(v) {
  const isNew = v.kind === 'new';
  const errors = v.errors ?? [];
  const t = state.targets.find(x => x.id === v.id);
  return html`
    <div class="head"><div class="grow">
      <h1>${isNew ? 'New target' : `Edit ${t?.name ?? v.id}`}</h1>
      <div class="muted small">${isNew ? 'Saved to' : v.source === 'bundled' ? 'Saving keeps the bundled file and stores your copy in' : 'Stored in'} <span class="mono">${state.info?.home}\\targets</span></div>
    </div></div>
    ${isNew ? html`
      <div class="grid2">
        <div class="card"><h3>From a URL</h3>
          <p class="muted small">Opens the site in a fresh Chrome or Edge profile. Edit the JSON below to add setup steps.</p>
          <div class="row"><input type="text" id="new-url" placeholder="example.org or https://example.org/app" value="${v.url ?? ''}"><button class="btn" data-action="from-url">Fill in</button></div>
        </div>
        <div class="card"><h3>With an AI</h3>
          <p class="muted small">Copies a prompt with the schema and an example. Paste it into your AI, answer its questions, and paste the JSON it gives you below.</p>
          <button class="btn" data-action="copy-prompt">Copy AI prompt</button>
        </div>
      </div>` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <label for="target-id">Id</label>
        <input type="text" id="target-id" value="${v.id ?? ''}" ${isNew ? '' : raw('readonly')} placeholder="my-site" style="min-width:200px">
        <span class="grow"></span>
        ${!isNew && v.overrides ? html`<button class="btn" data-action="reset-target" data-id="${v.id}">Reset to bundled</button>` : ''}
        ${!isNew && v.source === 'user' && !v.overrides ? html`<button class="btn danger" data-action="delete-target" data-id="${v.id}">Delete target</button>` : ''}
        <button class="btn" data-action="save-target" data-start="">Save</button>
        <button class="btn primary" data-action="save-target" data-start="1">Save and start</button>
      </div>
      <textarea id="target-json" spellcheck="false" placeholder='{ "name": "My site", "launch": { "type": "browser", "url": "https://…" } }'>${v.text ?? ''}</textarea>
      ${errors.length ? html`<ul class="errors">${errors.map(e => html`<li class="mono small">${e}</li>`)}</ul>`
        : v.text ? html`<p class="ok-text small">Matches the schema.</p>` : ''}
      <p class="muted small">Schema reference: <span class="mono">schema/target.schema.json</span> in the tool's folder · guide: <span class="mono">AUTHORING.md</span></p>
    </div>`;
}

function allSessionsView() {
  return html`<div class="head"><div class="grow"><h1>All sessions</h1></div><button class="btn" data-action="refresh">Refresh</button></div>
    <div class="card">${sessionsTable(state.sessions, { showTarget: true })}</div>`;
}

function storageView(s) {
  if (!s) return html`<p class="muted">Measuring…</p>`;
  return html`
    <div class="head"><div class="grow"><h1>Storage and cleanup</h1><div class="muted small mono">${state.info?.home}</div></div>
      <button class="btn" data-action="open" data-path="${state.info?.home}">Open folder</button></div>
    <div class="grid2">
      <div class="card"><h3>Sessions · ${s.sessions.length} · ${mb(s.sessionsSize)}</h3>
        <div class="row">Delete sessions older than <input type="number" id="older-than" value="30" min="0" style="width:70px"> days
          <label><input type="checkbox" id="only-empty"> only those without notes</label>
          <button class="btn danger" data-action="cleanup">Delete</button></div>
        <p class="muted small">Running sessions are never deleted.</p>
      </div>
      <div class="card"><h3>Builds · ${s.builds.length} · ${mb(s.buildsSize)}</h3>
        <button class="btn danger" data-action="prune">Keep only the newest build per target</button>
      </div>
    </div>
    <div class="card"><h3>Downloaded builds</h3>
      ${s.builds.length ? html`<table><tr><th>Repo</th><th>Artifact</th><th>Build</th><th>Built</th><th>Size</th><th></th></tr>
        ${s.builds.map(b => html`<tr><td class="mono small">${b.repo}</td><td>${b.artifact}</td><td><span class="mono">${sha7(b)}</span> ${b.title}</td>
          <td>${ago(b.createdAt)}</td><td>${mb(b.size)}</td><td><button class="btn danger" data-action="delete-build" data-dir="${b.dir}">Delete</button></td></tr>`)}</table>`
        : html`<div class="empty">No builds downloaded.</div>`}
    </div>
    <div class="card"><h3>Largest sessions</h3>${sessionsTable([...s.sessions].sort((a, b) => b.size - a.size).slice(0, 15), { showTarget: true })}</div>`;
}

// ---------- render ----------

function render() {
  document.getElementById('sidebar').innerHTML = sidebar().s;
  const v = state.view;
  let content;
  if (v.kind === 'target') {
    const t = state.targets.find(x => x.id === v.id);
    content = t ? targetView(t) : html`<div class="empty">That target is gone.</div>`;
  } else if (v.kind === 'session') {
    const s = state.sessions.find(x => x.id === v.id) ?? v.detail?.session;
    content = s ? sessionView({ ...s, status: state.sessions.find(x => x.id === v.id)?.status ?? s.status }, v.detail) : html`<div class="empty">That session is gone.</div>`;
  } else if (v.kind === 'new' || v.kind === 'edit') {
    // keep what the user typed: only re-render the editor when it isn't on screen yet
    if (document.getElementById('target-json') && v.rendered) return void updateEditorStatus(v);
    content = editorView(v);
    v.rendered = true;
  } else if (v.kind === 'storage') {
    content = storageView(v.summary);
  } else if (v.kind === 'mic') {
    content = micView(v);
  } else {
    content = allSessionsView();
  }
  const main = document.getElementById('main');
  const scroll = main.scrollTop;
  main.innerHTML = content.s;
  main.scrollTop = scroll;
  // follow the newest entries while a session runs; a finished one reads from the top
  if (v.kind === 'session') {
    const live = state.sessions.some(x => x.id === v.id && isLive(x));
    for (const box of main.querySelectorAll(live ? 'pre.log, #timeline' : 'pre.log')) box.scrollTop = box.scrollHeight;
  }
}

// ---------- the Microphone page: pick a mic, watch its level, record a short test ----------

let micPage; // { stream, ctx, raf } while the page is open

async function startMicPage(view) {
  stopMicPage();
  try {
    const stream = await openMic();
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      const level = Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length);
      const bar = document.getElementById('meter-bar');
      // a log scale: quiet speech (0.01) shows about a third, normal speech (0.05–0.1) most of the bar
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, (Math.log10(level + 1e-5) + 3) / 2.3) * 100)}%`;
      micPage.raf = requestAnimationFrame(tick);
    };
    micPage = { stream, ctx };
    micPage.raf = requestAnimationFrame(tick);
    view.current = stream.getAudioTracks()[0]?.getSettings().deviceId;
    view.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    view.error = undefined;
  } catch (e) {
    view.error = `No microphone: ${e.message}. Check Windows Settings > Privacy & security > Microphone.`;
  }
  if (state.view === view) render();
}

function stopMicPage() {
  if (!micPage) return;
  cancelAnimationFrame(micPage.raf);
  micPage.stream.getTracks().forEach(t => t.stop());
  void micPage.ctx.close();
  micPage = undefined;
}

function micView(v) {
  const r = v.result;
  return html`
    <div class="head"><div class="grow"><h1>Microphone</h1>
      <div class="muted">Pick the microphone voice sessions use, and check it records clearly. You only need this once, or when something sounds off.</div></div></div>
    <div class="card">
      ${v.error ? html`<p class="errors">${v.error}</p>` : ''}
      <div class="row"><label for="mic-choice">Microphone</label>
        <select id="mic-choice" ${v.devices ? '' : raw('disabled')}>
          ${(v.devices ?? []).map(d => html`<option value="${d.deviceId}" ${d.deviceId === v.current ? raw('selected') : ''}>${d.label || 'Microphone'}</option>`)}
        </select>
      </div>
      <div class="meter" title="Input level"><div id="meter-bar"></div></div>
      <p class="muted small">Speak normally: the bar should reach the middle or beyond. Sessions record this microphone without the browser's noise suppression, echo cancellation or auto gain, which can muffle speech.</p>
      <button class="btn primary" data-action="mic-test" ${v.recording || v.checking || !v.devices ? raw('disabled') : ''}>${v.recording ? html`${spinner} Recording… keep talking` : v.checking ? html`${spinner} Checking…` : '● Record a 4-second test'}</button>
    </div>
    ${r ? html`<div class="card">
      <h3>${r.ok ? '✓ Sounds usable' : '⚠ Problems found'}</h3>
      ${r.problems.length ? html`<ul class="errors">${r.problems.map(p => html`<li>${p}</li>`)}</ul>` : ''}
      <p><b>Transcribed:</b> ${r.text ? `“${r.text}”` : html`<span class="muted">(nothing)</span>`}</p>
      <p class="muted small">Level ${r.speechLevel.toFixed(3)} · peak ${r.peak.toFixed(2)} · ${(r.highShare * 100).toFixed(1)}% of the speech above 1.5 kHz (clear speech is usually over 5%)</p>
      <audio controls src="${r.url}"></audio>
    </div>` : ''}`;
}

function updateEditorStatus(v) {
  const card = document.getElementById('target-json').parentElement;
  card.querySelector('.errors, .ok-text')?.remove();
  const errors = v.errors ?? [];
  const el = document.createElement(errors.length ? 'ul' : 'p');
  if (errors.length) {
    el.className = 'errors';
    el.innerHTML = errors.map(e => `<li class="mono small">${esc(e)}</li>`).join('');
  } else if (v.text) {
    el.className = 'ok-text small';
    el.textContent = 'Matches the schema.';
  } else {
    return;
  }
  document.getElementById('target-json').after(el);
}

async function go(view) {
  if (state.view.kind === 'mic' && view.kind !== 'mic') stopMicPage();
  state.view = view;
  render();
  if (view.kind === 'mic') {
    await startMicPage(view);
  } else if (view.kind === 'target') {
    if (!state.latest[view.id]) void checkLatest(view.id);
  } else if (view.kind === 'session') {
    await loadSession(view.id);
  } else if (view.kind === 'storage') {
    view.summary = await api('storage:summary');
    if (state.view === view) render();
  } else if (view.kind === 'sessions') {
    await refresh();
  }
}

async function loadSession(id) {
  const detail = await api('sessions:get', id).catch(() => undefined);
  if (state.view.kind === 'session' && state.view.id === id) {
    state.view.detail = detail;
    render();
  }
}

// ---------- actions ----------

const actions = {
  go: d => go({ kind: d.kind, id: d.id }),
  refresh: () => refresh(),
  check: d => busy(`check:${d.id}`, () => checkLatest(d.id))(),
  download: d => busy(`download:${d.id}`, async () => {
    await api('builds:download', d.id, d.run);
    toast('Build downloaded.');
    await checkLatest(d.id);
  })(),
  // Runs the chosen (default: newest) downloaded build; never downloads without asking first.
  start: d => {
    // read the choices before busy() re-renders the page
    const voice = document.getElementById('voice-choice')?.value ?? voiceFor(d.id);
    const chosenRun = document.getElementById('build-choice')?.value || undefined;
    return busy(`start:${d.id}`, async () => {
    const t = state.targets.find(x => x.id === d.id);
    let runId = chosenRun;
    if (!runId && t?.build?.type === 'github-actions') {
      runId = (await api('builds:forTarget', d.id))[0]?.runId;
      if (!runId) {
        if (!state.latest[d.id]?.build) await checkLatest(d.id);
        const latest = state.latest[d.id]?.build;
        const what = latest ? `the latest build, ${sha7(latest)} ${latest.title}${latest.artifactSize ? ` (${mb(latest.artifactSize)} download)` : ''}` : 'the latest build';
        if (!confirm(`No build of ${t.name} is downloaded yet.\n\nDownload ${what} and start?`)) return;
      }
    }
    rememberVoice(d.id, voice);
    // ask for the microphone before launching anything, so a refusal doesn't leave a session half started
    let stream;
    if (voice !== 'off') {
      try {
        stream = await openMic();
      } catch (e) {
        toast(`No microphone: ${e.message}. Check Windows Settings > Privacy > Microphone, or start without voice.`, true);
        return;
      }
    }
    let id;
    try {
      id = await api('sessions:start', d.id, { runId, voice });
    } catch (e) {
      stream?.getTracks().forEach(track => track.stop());
      throw e;
    }
    if (stream) await startMic(id, stream, voice);
    await refresh();
    await go({ kind: 'session', id });
    })();
  },
  finish: d => api('sessions:finish', d.id),
  handoff: async d => toast(`Copied:\n${await api('sessions:copyHandoff', d.id)}\n\nPaste it to a coding agent in the project's repo.`),
  trace: async d => {
    toast('Opening the trace in your browser…');
    const url = await api('trace:open', d.id, d.file);
    toast(`Trace Viewer: ${url}`);
  },
  open: async d => {
    toast(`Opening ${d.path.split(/[\\/]/).pop()}…`);
    await api('shell:open', d.path);
  },
  'delete-session': async d => {
    if (!confirm('Delete this session and its screenshots?')) return;
    await api('sessions:delete', d.id);
    await refresh();
    await go({ kind: 'sessions' });
  },
  'mic-test': async () => {
    const v = state.view;
    if (!micPage) return;
    if (v.result?.url) URL.revokeObjectURL(v.result.url);
    v.result = undefined;
    v.recording = true;
    render();
    const recorder = await capture16k(micPage.stream);
    await new Promise(r => setTimeout(r, 4000));
    const samples = recorder.stop();
    v.recording = false;
    v.checking = true;
    render();
    try {
      const result = await api('mic:test', samples);
      v.result = { ...result, url: wavUrl(samples) };
    } finally {
      v.checking = false;
      if (state.view === v) render();
    }
  },
  retranscribe: d => {
    if (!confirm('Transcribe this session\'s speech again with Whisper small.en?\n\nThe first time, the model downloads (249 MB). It takes about three times as long as the audio is.')) return;
    return busy(`retranscribe:${d.id}`, async () => {
      state.retranscribeStatus = 'Starting…';
      try {
        const count = await api('sessions:retranscribe', d.id);
        toast(`Re-transcribed: ${count} segment${count === 1 ? '' : 's'}.`);
      } finally {
        state.retranscribeStatus = undefined;
      }
      await loadSession(d.id);
    })();
  },
  'timeline-filter': d => {
    state.view.timelineFilter = d.filter;
    render();
    document.getElementById('timeline-card')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  play: d => {
    // one clip at a time; pressing the playing one stops it
    const playing = state.audio;
    playing?.clip.pause();
    state.audio = undefined;
    if (playing?.src === d.src) return;
    const audio = new Audio(d.src);
    state.audio = { clip: audio, src: d.src };
    audio.onended = () => { if (state.audio?.clip === audio) state.audio = undefined; };
    audio.play().catch(e => toast(`Can't play it: ${e.message}`, true));
  },
  zoom: d => {
    const z = document.createElement('div');
    z.className = 'zoom';
    z.innerHTML = `<img src="${esc(d.src)}" alt="full window">`;
    z.onclick = () => z.remove();
    document.body.append(z);
  },
  edit: async d => {
    const t = await api('targets:read', d.id);
    const v = { kind: 'edit', id: d.id, text: t.text, source: t.source, overrides: t.overrides };
    v.errors = await api('targets:validate', t.text);
    state.view = v;
    render();
  },
  'from-url': async () => {
    const url = document.getElementById('new-url').value.trim();
    if (!url) return;
    const { id, text } = await api('targets:fromUrl', url);
    document.getElementById('target-id').value = id;
    document.getElementById('target-json').value = text;
    await validateEditor();
  },
  'copy-prompt': async () => {
    await api('targets:copyPrompt');
    toast('Prompt copied. Paste it into your AI; paste the JSON it writes into the box below.');
  },
  'save-target': async d => {
    const id = document.getElementById('target-id').value.trim();
    const text = document.getElementById('target-json').value;
    if (!id) return toast('Give the target an id, e.g. my-site.', true);
    if (state.view.kind === 'new' && state.targets.some(t => t.id === id) && !confirm(`A target "${id}" exists. Replace it?`)) return;
    await api('targets:save', id, text);
    await refresh();
    toast('Saved.');
    await go({ kind: 'target', id });
    if (d.start) await actions.start({ id });
  },
  'reset-target': async d => {
    if (!confirm('Throw away your edits and go back to the bundled config?')) return;
    await api('targets:delete', d.id);
    await refresh();
    await go({ kind: 'target', id: d.id });
  },
  'delete-target': async d => {
    if (!confirm('Delete this target? Its sessions stay.')) return;
    await api('targets:delete', d.id);
    await refresh();
    await go({ kind: 'sessions' });
  },
  cleanup: async () => {
    const days = Number(document.getElementById('older-than').value);
    const onlyEmpty = document.getElementById('only-empty').checked;
    if (!confirm(`Delete ${onlyEmpty ? 'note-less ' : ''}sessions older than ${days} days?`)) return;
    const deleted = await api('sessions:cleanup', { olderThanDays: days, onlyEmpty });
    toast(`Deleted ${deleted.length} session(s).`);
    await refresh();
    await go({ kind: 'storage' });
  },
  prune: async () => {
    if (!confirm('Delete every downloaded build except the newest for each target?')) return;
    const deleted = await api('builds:prune');
    toast(`Deleted ${deleted.length} build(s).`);
    state.latest = {};
    await go({ kind: 'storage' });
  },
  'delete-build': async d => {
    if (!confirm('Delete this build?')) return;
    await api('builds:delete', d.dir);
    state.latest = {};
    await go({ kind: 'storage' });
  },
};

let validateTimer;
async function validateEditor() {
  const v = state.view;
  if (v.kind !== 'new' && v.kind !== 'edit') return;
  v.text = document.getElementById('target-json').value;
  v.id = document.getElementById('target-id').value;
  v.errors = v.text.trim() ? await api('targets:validate', v.text) : [];
  if (state.view === v) updateEditorStatus(v);
}

/** Runs an action; failures api() already reported are not shown twice, anything else gets a toast. */
function run(name, data) {
  Promise.resolve(actions[name]?.(data)).catch(e => {
    if (!e?.shown) toast(cleanError(e), true);
  });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  run(el.dataset.action, el.dataset);
});
document.addEventListener('input', e => {
  if (e.target.id === 'target-json' || e.target.id === 'target-id') {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateEditor, 300);
  }
  if (e.target.id === 'new-url') state.view.url = e.target.value;
});
document.addEventListener('change', e => {
  if (e.target.id === 'build-choice') state.view.runId = e.target.value || undefined;
  if (e.target.id === 'voice-choice' && state.view.kind === 'target') rememberVoice(state.view.id, e.target.value);
  if (e.target.id === 'mic-choice') {
    saveMic(e.target.value);
    void startMicPage(state.view); // listen to the new one
  }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'target-json' && e.key === 'Tab') {
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
  }
  if (e.key === 'Escape') document.querySelector('.zoom')?.remove();
  if (e.key === 'Enter' && e.target.id === 'new-url') run('from-url', {});
});

window.qa.on('log', ({ scope, message }) => {
  addLog(scope, message);
  // the target page shows build downloads; a session's log goes to its own page
  const v = state.view;
  if ((v.kind === 'target' && v.id === scope) || (v.kind === 'session' && v.id === scope)) render();
});
window.qa.on('session', async ({ id, targetId, type, data }) => {
  if (type === 'retranscribe') {
    state.retranscribeStatus = data;
    if (state.view.kind === 'session' && state.view.id === id) render();
    return;
  }
  if (type === 'log') {
    // a session's setup log also shows on its target until the session page opens
    addLog(targetId, data);
    return;
  }
  if (type === 'action' || type === 'speech') {
    // the recorder saves actions about a second after they happen; refresh the timeline after that, at most every 1.5 s
    const v = state.view;
    if (v.kind === 'session' && v.id === id && !v.timelineTimer) {
      v.timelineTimer = setTimeout(() => { v.timelineTimer = null; void loadSession(id); }, 1500);
    }
    return;
  }
  state.sessions = await api('sessions:list');
  const v = state.view;
  if (v.kind === 'session' && v.id === id) await loadSession(id);
  else render();
  if (type === 'status' && (data === 'ended' || data === 'failed')) mics.get(id)?.stop();
  if (type === 'status' && (data === 'ended' || data === 'failed')) toast(data === 'failed' ? 'The session failed to start. See its page for the error.' : 'Session saved.', data === 'failed');
});

(async () => {
  state.info = await api('app:info');
  await refresh();
  const first = state.targets.find(t => t.available && !t.error);
  await go(first ? { kind: 'target', id: first.id } : { kind: 'new' });
})();
