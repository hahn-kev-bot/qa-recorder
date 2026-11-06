// Injected into the app page by the harness. Plain browser script, no imports: it runs via addInitScript/evaluate.
// Notes go to the harness through the window.__fwliteQaNote binding, which takes the screenshots.
(() => {
  if (window.top !== window || window.__fwliteQa) return;
  window.__fwliteQa = true;

  const KINDS = [
    { id: 'bug', label: '🐛 Bug' },
    { id: 'dislike', label: '👎 Dislike' },
    { id: 'idea', label: '💡 Idea' },
    { id: 'like', label: '👍 Like' },
  ];

  function mount() {
    if (!document.body) return void document.addEventListener('DOMContentLoaded', mount, { once: true });
    const host = document.createElement('div');
    host.id = 'fwlite-qa-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; }
  .bar { position: fixed; left: 12px; bottom: 12px; display: flex; gap: 4px; align-items: center; padding: 4px;
    background: #1f2937; color: #f9fafb; border-radius: 999px; box-shadow: 0 4px 16px #0005; pointer-events: auto; opacity: .85; }
  .bar:hover { opacity: 1; }
  .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin: 0 4px 0 8px; }
  button { cursor: pointer; border: 0; border-radius: 999px; padding: 4px 10px; background: transparent; color: inherit; }
  .bar button:hover { background: #374151; }
  .count { padding: 0 8px; color: #9ca3af; }
  .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: #0000000d; }
  .sel { position: fixed; border: 2px solid #3b82f6; background: #3b82f622; pointer-events: none; }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff;
    padding: 6px 12px; border-radius: 6px; pointer-events: none; }
  .form { position: fixed; width: 340px; background: #fff; color: #111827; border-radius: 8px; padding: 10px;
    box-shadow: 0 8px 32px #0006; pointer-events: auto; display: flex; flex-direction: column; gap: 8px; }
  .kinds { display: flex; gap: 4px; flex-wrap: wrap; }
  .kinds button { background: #f3f4f6; }
  .kinds button[aria-pressed="true"] { background: #2563eb; color: #fff; }
  textarea { width: 100%; min-height: 90px; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px; }
  .actions { display: flex; justify-content: space-between; align-items: center; color: #6b7280; font-size: 12px; }
  .actions button.save { background: #2563eb; color: #fff; }
  .toast { position: fixed; left: 12px; bottom: 56px; background: #065f46; color: #fff; padding: 6px 12px; border-radius: 6px; }
</style>
<div class="bar" part="bar">
  <span class="dot" title="QA session recording"></span>
  <button data-mode="element" title="Pick an element (F8)">◎ Element</button>
  <button data-mode="region" title="Drag a region (F9)">▭ Region</button>
  <button data-mode="note" title="General note (F7)">✎ Note</button>
  <span class="count">0</span>
</div>`;
    const bar = root.querySelector('.bar');
    const countEl = root.querySelector('.count');
    let busy = false;
    let count = 0;

    bar.addEventListener('click', e => {
      const mode = e.target.closest('button')?.dataset.mode;
      if (mode) start(mode);
    });
    // capture phase so the app never sees the hotkeys
    window.addEventListener('keydown', e => {
      const mode = { F7: 'note', F8: 'element', F9: 'region' }[e.key];
      if (!mode) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      start(mode);
    }, true);

    function start(mode) {
      if (busy) return;
      busy = true;
      if (mode === 'note') return openForm(null, null);
      if (mode === 'region') return pickRegion();
      return pickElement();
    }

    function done() {
      busy = false;
      root.querySelectorAll('.layer, .sel, .hint, .form').forEach(n => n.remove());
    }

    function hint(text) {
      const el = document.createElement('div');
      el.className = 'hint';
      el.textContent = text;
      root.appendChild(el);
    }

    function layerWithEsc() {
      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.tabIndex = -1;
      root.appendChild(layer);
      const onKey = e => {
        if (e.key !== 'Escape') return;
        e.stopImmediatePropagation();
        window.removeEventListener('keydown', onKey, true);
        done();
      };
      window.addEventListener('keydown', onKey, true);
      return { layer, release: () => window.removeEventListener('keydown', onKey, true) };
    }

    function pickRegion() {
      hint('Drag a region · Esc to cancel');
      const { layer, release } = layerWithEsc();
      const sel = document.createElement('div');
      sel.className = 'sel';
      let start = null;
      layer.addEventListener('pointerdown', e => {
        start = { x: e.clientX, y: e.clientY };
        layer.setPointerCapture(e.pointerId);
        root.appendChild(sel);
        place(e);
      });
      layer.addEventListener('pointermove', e => start && place(e));
      layer.addEventListener('pointerup', e => {
        if (!start) return;
        const rect = place(e);
        release();
        layer.remove();
        root.querySelector('.hint')?.remove();
        if (rect.width < 6 || rect.height < 6) return done();
        openForm(rect, describe(elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2)));
      });
      function place(e) {
        const rect = {
          x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
          width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y),
        };
        Object.assign(sel.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
        return rect;
      }
    }

    function pickElement() {
      hint('Click an element · Esc to cancel');
      const { layer, release } = layerWithEsc();
      const sel = document.createElement('div');
      sel.className = 'sel';
      root.appendChild(sel);
      let current = null;
      layer.addEventListener('pointermove', e => {
        current = elementAt(e.clientX, e.clientY);
        if (!current) return;
        const r = current.getBoundingClientRect();
        Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
      });
      layer.addEventListener('click', e => {
        e.preventDefault();
        current = elementAt(e.clientX, e.clientY);
        release();
        layer.remove();
        root.querySelector('.hint')?.remove();
        if (!current) return done();
        const r = current.getBoundingClientRect();
        openForm({ x: r.x, y: r.y, width: r.width, height: r.height }, describe(current));
      });
    }

    function elementAt(x, y) {
      return document.elementsFromPoint(x, y).find(el => el !== host && !host.contains(el)) ?? null;
    }

    function openForm(rect, target) {
      const form = document.createElement('div');
      form.className = 'form';
      form.innerHTML = `
        <div class="kinds">${KINDS.map((k, i) => `<button data-kind="${k.id}" aria-pressed="${i === 0}">${k.label}</button>`).join('')}</div>
        <textarea placeholder="What happened, what did you expect?"></textarea>
        <div class="actions"><span>Ctrl+Enter to save · Esc to cancel</span>
          <span><button class="cancel">Cancel</button> <button class="save">Save</button></span></div>`;
      root.appendChild(form);
      if (rect) {
        const sel = root.querySelector('.sel') ?? document.createElement('div');
        sel.className = 'sel';
        Object.assign(sel.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
        root.appendChild(sel);
      }
      // next to the selection when it fits, else centred
      const fw = 340, fh = 200;
      let left = (innerWidth - fw) / 2, top = (innerHeight - fh) / 2;
      if (rect) {
        left = Math.min(Math.max(8, rect.x), innerWidth - fw - 8);
        top = rect.y + rect.height + 8 + fh < innerHeight ? rect.y + rect.height + 8 : Math.max(8, rect.y - fh - 8);
      }
      Object.assign(form.style, { left: left + 'px', top: top + 'px' });
      let kind = KINDS[0].id;
      form.querySelector('.kinds').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        kind = b.dataset.kind;
        form.querySelectorAll('.kinds button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        text.focus(); // so typing carries on into the note
      });
      const text = form.querySelector('textarea');
      text.focus();
      // keep keystrokes in the form away from the app's own shortcuts
      form.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') done();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
      });
      form.querySelector('.cancel').addEventListener('click', done);
      form.querySelector('.save').addEventListener('click', save);

      async function save() {
        const note = {
          kind, text: text.value.trim(), rect, target, url: location.href,
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, at: new Date().toISOString(),
        };
        done();
        busy = true;
        host.style.display = 'none'; // keep the toolbar out of the screenshot
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
          const saved = await window.__fwliteQaNote(note);
          count = saved.count;
          countEl.textContent = String(count);
          toast(`Saved note ${saved.id}`);
        } catch (err) {
          toast(`Saving failed: ${err?.message ?? err}`);
        } finally {
          host.style.display = '';
          busy = false;
        }
      }
    }

    function toast(message) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = message;
      root.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    }
  }

  // ids generated per render (bits-ui's "bits-5", Svelte's "c43") mean nothing to someone reading the source
  const stableId = id => (id && !/\d/.test(id) ? id : null);

  /** Enough about an element for an agent to find it in the source: labels, text, attributes, a CSS path. */
  function describe(el) {
    if (!el) return null;
    const text = s => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'id' && !stableId(a.value)) continue;
      if (a.name.startsWith('data-') || ['id','role', 'aria-label', 'title', 'name', 'placeholder', 'type', 'href'].includes(a.name)) {
        attrs[a.name] = a.value.slice(0, 80);
      }
    }
    const landmarks = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const label = p.getAttribute('aria-label') ?? p.getAttribute('role') ?? (stableId(p.id) ? `#${p.id}` : null)
        ?? [...p.attributes].find(a => a.name.startsWith('data-') && !a.name.startsWith('data-svelte'))?.name;
      if (label) landmarks.push(`${p.tagName.toLowerCase()}[${label}]`);
      if (landmarks.length >= 5) break;
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: text(el.innerText ?? el.textContent),
      value: 'value' in el && typeof el.value === 'string' ? el.value.slice(0, 80) : undefined,
      classes: text(typeof el.className === 'string' ? el.className : ''),
      attrs,
      landmarks,
      cssPath: cssPath(el),
    };
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && parts.length < 6; n = n.parentElement) {
      if (stableId(n.id)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const same = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : ''));
    }
    return parts.join(' > ');
  }

  mount();
})();
