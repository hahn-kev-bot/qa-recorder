// Injected into the app page by the harness. Plain browser script, no imports: it runs via addInitScript/evaluate.
// Notes go to the harness through the window.__qaRecorderNote binding, which takes the screenshots.
//
// The page must not notice the toolbar: popovers and dialogs close on pointerdown or focus "outside" them, and a
// click on the toolbar is outside. So a window capture listener, which runs before any of the app's listeners,
// swallows every event that involves the toolbar and hands it to the toolbar's own handlers instead.
(() => {
  if (window.top !== window || window.__qaRecorder) return;
  // the browser's own pages (a new tab, settings) aren't the app, and some refuse injected markup
  if (!/^(https?|file):$/.test(location.protocol)) return;
  window.__qaRecorder = true;

  // Pages that enforce Trusted Types refuse plain strings for innerHTML. Our markup is static, so a policy that
  // passes it through is safe; if the page's CSP forbids new policies, the toolbar stays off rather than throwing.
  let policy;
  try {
    policy = window.trustedTypes?.createPolicy('qa-recorder', { createHTML: s => s });
  } catch { /* not allowed here */ }
  const html = s => (policy ? policy.createHTML(s) : s);

  const KINDS = [
    { id: 'bug', label: '🐛 Bug' },
    { id: 'dislike', label: '👎 Dislike' },
    { id: 'idea', label: '💡 Idea' },
    { id: 'like', label: '👍 Like' },
  ];
  const HOTKEYS = { F7: 'note', F8: 'element', F9: 'region' };
  const SHIELDED = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click', 'dblclick',
    'contextmenu', 'wheel', 'touchstart', 'touchend', 'touchmove', 'focusin', 'focusout', 'focus', 'blur',
    'keydown', 'keyup', 'keypress', 'input', 'beforeinput'];

  let host = null;
  let ui = null;

  // registered at injection time, before the app's scripts run
  for (const type of SHIELDED) {
    window.addEventListener(type, e => {
      // push-to-talk key: held anywhere in the page, never seen by the app
      if ((type === 'keydown' || type === 'keyup') && ui && config.voice === 'push-to-talk' && e.key === config.talkKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'keyup' || !e.repeat) ui.talk(type === 'keydown');
        return;
      }
      if (type === 'keydown' && HOTKEYS[e.key] && ui) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ui.start(HOTKEYS[e.key]);
        return;
      }
      // Escape cancels a capture wherever focus is, without also closing the app's popup
      if (type === 'keydown' && e.key === 'Escape' && ui?.busy()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ui.cancel();
        return;
      }
      if (!host) return;
      const ours = e.composedPath().includes(host) || e.relatedTarget === host;
      if (!ours) return;
      // stop it reaching the app; default actions (typing, focusing the textarea) still happen
      e.stopImmediatePropagation();
      ui?.handle(e);
    }, true);
  }

  // ---- action timeline: what the tester did in the page, described the way a person would say it ----
  const config = window.__qaRecorderConfig ?? {};
  const isOurs = e => !!host && (e.composedPath().includes(host) || e.target === host);
  const sendAction = action => { void window.__qaRecorderAction?.({ ...action, url: location.href })?.catch?.(() => {}); };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role],[contenteditable=""],[contenteditable="true"],[tabindex]';
  const ROLE_BY_TAG = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'image', label: 'label' };
  const clip = s => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox' }[type] ?? 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return ROLE_BY_TAG[tag] ?? tag;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(' ').map(id => document.getElementById(id)?.innerText ?? '').join(' ');
      if (clip(text)) return clip(text);
    }
    if (el.labels?.length) return clip(el.labels[0].innerText);
    const tag = el.tagName.toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || el.isContentEditable) {
      return clip(el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name') ?? '');
    }
    return clip(el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value') || '');
  }

  /** The nearest dialog, menu or labelled region: "in dialog 'Filters'". */
  function insideOf(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const role = p.getAttribute('role') ?? (p.tagName === 'DIALOG' ? 'dialog' : p.tagName === 'NAV' ? 'navigation' : null);
      if (role && ['dialog', 'alertdialog', 'menu', 'listbox', 'navigation', 'toolbar', 'tabpanel', 'region', 'form'].includes(role)) {
        return { role, name: clip(p.getAttribute('aria-label') ?? '') };
      }
    }
    return undefined;
  }

  function brief(el) {
    const target = el.closest?.(INTERACTIVE) ?? el;
    return { role: roleOf(target), name: nameOf(target), inside: insideOf(target), ...(target.id && stableId(target.id) ? { id: target.id } : {}) };
  }

  function fieldValue(el) {
    if (el.type === 'password') return { hidden: 'password' };
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: el.checked };
    if (el.tagName === 'SELECT') return { value: clip([...el.selectedOptions].map(o => o.text).join(', ')) };
    const value = el.isContentEditable ? el.innerText : el.value;
    if (config.typedText === false) return { length: (value ?? '').length };
    return { value: (value ?? '').slice(0, 200) };
  }

  const editStart = new WeakMap(); // contenteditable text when it got focus, to log only real edits
  window.addEventListener('click', e => {
    if (isOurs(e) || ui?.busy() || !(e.target instanceof Element)) return;
    sendAction({ action: 'click', target: brief(e.target) });
  }, true);
  window.addEventListener('change', e => {
    const el = e.target;
    if (isOurs(e) || !(el instanceof Element) || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    sendAction({ action: 'input', target: brief(el), ...fieldValue(el) });
  }, true);
  window.addEventListener('focusin', e => {
    if (e.target instanceof HTMLElement && e.target.isContentEditable && !isOurs(e)) editStart.set(e.target, e.target.innerText);
  }, true);
  window.addEventListener('focusout', e => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !editStart.has(el) || isOurs(e)) return;
    if (editStart.get(el) !== el.innerText) sendAction({ action: 'input', target: brief(el), ...fieldValue(el) });
    editStart.delete(el);
  }, true);
  window.addEventListener('keydown', e => {
    if (e.repeat || isOurs(e) || HOTKEYS[e.key] || e.key === config.talkKey) return;
    const combo = e.ctrlKey || e.altKey || e.metaKey;
    if (!combo && !['Enter', 'Escape'].includes(e.key)) return;
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) return;
    const key = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && 'Shift', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
    sendAction({ action: 'key', key, target: e.target instanceof Element && e.target !== document.body ? brief(e.target) : undefined });
  }, true);

  function mountToolbar() {
    if (!document.body) return void document.addEventListener('DOMContentLoaded', mount, { once: true });
    host = document.createElement('div');
    host.id = 'qa-recorder-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = html(`
<style>
  * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; }
  .bar { position: fixed; bottom: 12px; display: flex; gap: 2px; align-items: center; padding: 4px;
    background: #1f2937; color: #f9fafb; border-radius: 999px; box-shadow: 0 4px 16px #0005; pointer-events: auto; opacity: .85; }
  .bar.left { left: 12px; } .bar.right { right: 12px; }
  .bar:hover { opacity: 1; }
  .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin: 0 4px 0 8px; }
  button { cursor: pointer; border: 0; border-radius: 999px; padding: 4px 10px; background: transparent; color: inherit; }
  .bar button:hover { background: #374151; }
  .bar button.finish { background: #374151; }
  .bar button.finish.armed { background: #dc2626; }
  .count { padding: 0 6px; color: #9ca3af; }
  .bar button.mic.talking { background: #dc2626; }
  .bar button.mic.live { color: #86efac; }
  .bar button.mic.muted { color: #9ca3af; }
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
  .toast { position: fixed; bottom: 56px; background: #065f46; color: #fff; padding: 6px 12px; border-radius: 6px; }
  .toast.left { left: 12px; } .toast.right { right: 12px; }
</style>
<div class="bar left">
  <span class="dot" title="QA session recording"></span>
  <button data-act="element" title="Pick an element (F8)">◎ Element</button>
  <button data-act="region" title="Drag a region (F9)">▭ Region</button>
  <button data-act="note" title="General note (F7)">✎ Note</button>
  <span class="count" title="Notes saved">0</span>
  ${config.voice === 'push-to-talk' ? `<button data-act="mic" class="mic" title="Hold to talk (or hold ${config.talkKey}); each press becomes a spoken note">🎙 Hold ${config.talkKey}</button>` : ''}
  ${config.voice === 'open-mic' ? '<button data-act="mic" class="mic live" title="Open mic: everything you say is transcribed. Click to mute.">🎙 Live</button>' : ''}
  <button data-act="side" title="Move the toolbar to the other side">⇄</button>
  <button data-act="finish" class="finish" title="Finish the session and close the app">Finish</button>
</div>`);
    const bar = root.querySelector('.bar');
    const countEl = root.querySelector('.count');
    const finishBtn = root.querySelector('.finish');
    const micBtn = root.querySelector('.mic');
    let talking = false;
    let side = localStorage.getItem('qa-recorder-side') === 'right' ? 'right' : 'left';
    let busy = false;
    let finishArmed = null;
    // the current mode's handler for events from inside the overlay (pointer drags, element picking, the form)
    let modeHandler = null;
    setSide(side);

    ui = {
      start(mode) {
        if (busy) return;
        busy = true;
        if (mode === 'note') return openForm(null, null);
        if (mode === 'region') return pickRegion();
        return pickElement();
      },
      busy: () => busy && !!modeHandler,
      cancel: () => done(),
      /** Push-to-talk: down/up from the key or the 🎙 button. */
      talk(down) {
        if (down === talking) return;
        talking = down;
        micBtn?.classList.toggle('talking', down);
        if (micBtn) micBtn.textContent = down ? '● Talking…' : `🎙 Hold ${config.talkKey}`;
        void window.__qaRecorderTalk?.(down).then(r => { if (r) countEl.textContent = String(r.count); }).catch(() => {});
      },
      handle(e) {
        const el = e.composedPath()[0];
        if (micBtn && el instanceof Element && micBtn.contains(el)) {
          if (config.voice === 'push-to-talk') {
            if (e.type === 'pointerdown') {
              micBtn.setPointerCapture(e.pointerId);
              ui.talk(true);
            } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
              ui.talk(false);
            }
          } else if (e.type === 'click') {
            const muted = !micBtn.classList.contains('muted');
            void window.__qaRecorderMute?.(muted).then(r => {
              micBtn.classList.toggle('muted', r.muted);
              micBtn.classList.toggle('live', !r.muted);
              micBtn.textContent = r.muted ? '🔇 Muted' : '🎙 Live';
            });
          }
          return;
        }
        if (e.type === 'click' && el instanceof Element && bar.contains(el)) {
          const act = el.closest('button')?.dataset.act;
          if (act === 'side') setSide(side === 'left' ? 'right' : 'left');
          else if (act === 'finish') finish();
          else if (act) ui.start(act);
          return;
        }
        modeHandler?.(e, el);
      },
    };

    function setSide(next) {
      side = next;
      localStorage.setItem('qa-recorder-side', side);
      bar.classList.toggle('left', side === 'left');
      bar.classList.toggle('right', side === 'right');
    }

    function finish() {
      if (!finishArmed) {
        finishBtn.classList.add('armed');
        finishBtn.textContent = 'Click again to close';
        finishArmed = setTimeout(() => {
          finishArmed = null;
          finishBtn.classList.remove('armed');
          finishBtn.textContent = 'Finish';
        }, 3000);
        return;
      }
      clearTimeout(finishArmed);
      finishBtn.textContent = 'Saving…';
      void window.__qaRecorderFinish?.();
    }

    function done() {
      busy = false;
      modeHandler = null;
      root.querySelectorAll('.layer, .sel, .hint, .form').forEach(n => n.remove());
    }

    function add(cls, text) {
      const el = document.createElement('div');
      el.className = cls;
      if (text) el.textContent = text;
      root.appendChild(el);
      return el;
    }

    function place(el, r) {
      Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
    }

    function pickRegion() {
      add('hint', 'Drag a region · Esc to cancel');
      const layer = add('layer');
      const sel = add('sel');
      sel.style.display = 'none';
      let from = null;
      const rectTo = e => ({
        x: Math.min(from.x, e.clientX), y: Math.min(from.y, e.clientY),
        width: Math.abs(e.clientX - from.x), height: Math.abs(e.clientY - from.y),
      });
      modeHandler = (e, el) => {
        if (el !== layer) return;
        if (e.type === 'pointerdown') {
          from = { x: e.clientX, y: e.clientY };
          layer.setPointerCapture(e.pointerId);
          sel.style.display = '';
          place(sel, rectTo(e));
        } else if (e.type === 'pointermove' && from) {
          place(sel, rectTo(e));
        } else if (e.type === 'pointerup' && from) {
          const rect = rectTo(e);
          layer.remove();
          root.querySelector('.hint')?.remove();
          if (rect.width < 6 || rect.height < 6) return done();
          openForm(rect, describe(elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2)));
        }
      };
    }

    function pickElement() {
      add('hint', 'Click an element · Esc to cancel');
      const layer = add('layer');
      const sel = add('sel');
      modeHandler = (e, el) => {
        if (el !== layer) return;
        const target = elementAt(e.clientX, e.clientY);
        if (e.type === 'pointermove' && target) place(sel, target.getBoundingClientRect());
        if (e.type !== 'click') return;
        layer.remove();
        root.querySelector('.hint')?.remove();
        if (!target) return done();
        const r = target.getBoundingClientRect();
        openForm({ x: r.x, y: r.y, width: r.width, height: r.height }, describe(target));
      };
    }

    function elementAt(x, y) {
      return document.elementsFromPoint(x, y).find(el => el !== host && !host.contains(el)) ?? null;
    }

    function openForm(rect, target) {
      const form = add('form');
      form.innerHTML = html(`
        <div class="kinds">${KINDS.map((k, i) => `<button data-kind="${k.id}" aria-pressed="${i === 0}">${k.label}</button>`).join('')}</div>
        <textarea placeholder="What happened, what did you expect?"></textarea>
        <div class="actions"><span>Ctrl+Enter to save · Esc to cancel</span>
          <span><button data-form="cancel">Cancel</button> <button data-form="save" class="save">Save</button></span></div>`);
      if (rect) place(root.querySelector('.sel') ?? add('sel'), rect);
      // next to the selection when it fits, else centred
      const fw = 340, fh = 200;
      let left = (innerWidth - fw) / 2, top = (innerHeight - fh) / 2;
      if (rect) {
        left = Math.min(Math.max(8, rect.x), innerWidth - fw - 8);
        top = rect.y + rect.height + 8 + fh < innerHeight ? rect.y + rect.height + 8 : Math.max(8, rect.y - fh - 8);
      }
      Object.assign(form.style, { left: left + 'px', top: top + 'px' });
      const text = form.querySelector('textarea');
      text.focus();
      let kind = KINDS[0].id;

      modeHandler = (e, el) => {
        if (!(el instanceof Element) || !form.contains(el)) return;
        if (e.type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return void save();
        if (e.type !== 'click') return;
        const button = el.closest('button');
        if (button?.dataset.kind) {
          kind = button.dataset.kind;
          form.querySelectorAll('.kinds button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
          text.focus(); // so typing carries on into the note
        } else if (button?.dataset.form === 'cancel') done();
        else if (button?.dataset.form === 'save') void save();
      };

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
          const saved = await window.__qaRecorderNote(note);
          countEl.textContent = String(saved.count);
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
      const el = add(`toast ${side}`, message);
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
      if (a.name.startsWith('data-') || ['id', 'role', 'aria-label', 'title', 'name', 'placeholder', 'type', 'href'].includes(a.name)) {
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

  // never break the page: if the toolbar can't be drawn here, the timeline still records
  function mount() {
    try {
      mountToolbar();
    } catch {
      host?.remove();
      host = null;
      ui = null;
    }
  }
  mount();

  // switching browser tabs: the recorder notes which tab the tester is looking at
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void window.__qaRecorderTabShown?.()?.catch?.(() => {});
  });
})();
