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
    { id: 'bug', label: 'Bug' },
    { id: 'dislike', label: 'Dislike' },
    { id: 'idea', label: 'Idea' },
    { id: 'like', label: 'Like' },
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
      if (type === 'keydown' && e.key === 'Escape' && ui?.menuOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ui.closeMenu();
        return;
      }
      if (!host) return;
      const ours = e.composedPath().includes(host) || e.relatedTarget === host;
      if (!ours) {
        // a press on the page puts the toolbar's menu away, as it would any menu
        if (type === 'pointerdown') ui?.closeMenu();
        return;
      }
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

  // ---- the toolbar: a labelled bar, a step line that says what to do next, and one tag dialog ----

  const TOOLS = [
    { act: 'element', label: 'Element', key: 'F8', title: 'Pick one thing on the page and write a note about it (F8)' },
    { act: 'region', label: 'Area', key: 'F9', title: 'Drag a box round an area and write a note about it (F9)' },
    { act: 'note', label: 'Note', key: 'F7', title: 'Write a note about the whole page (F7)' },
    { act: 'move', label: 'Move', title: 'Show a layout change: drag something to where it should go' },
    { act: 'resize', label: 'Resize', title: 'Show a layout change: pick something and drag its edges' },
  ];
  const ICONS = {
    element: '<path d="M4 3l5 13 2-5 5-2z"/>',
    region: '<rect x="3" y="4" width="14" height="12" rx="1" stroke-dasharray="3 2.4"/>',
    note: '<path d="M5 3h7l4 4v10H5z"/><path d="M12 3v4h4M8 11h5M8 14h3"/>',
    move: '<path d="M10 2v16M2 10h16M10 2L7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5"/>',
    resize: '<rect x="3" y="3" width="9" height="9"/><path d="M17 12v5h-5M17 17l-6-6"/>',
    side: '<path d="M3 7h12l-3-3M17 13H5l3 3"/>',
    collapse: '<path d="M8 3v5H3M12 17v-5h5M8 8L3 3M12 12l5 5"/>',
    expand: '<path d="M3 8V3h5M17 12v5h-5M3 3l5 5M17 17l-5-5"/>',
    menu: '<path d="M3 5h14M3 10h14M3 15h14"/>',
    mic: '<rect x="7.5" y="2" width="5" height="10" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v3"/>',
    grip: '<path d="M7 5v.01M13 5v.01M7 10v.01M13 10v.01M7 15v.01M13 15v.01"/>',
  };
  const icon = name => `<svg class="ic ic-${name}" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`;
  // the page may block storage; the toolbar then just forgets its place
  const store = {
    get(key) { try { return localStorage.getItem(`qa-recorder-${key}`); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(`qa-recorder-${key}`, value); } catch { /* not kept */ } },
  };
  const ROLE_WORDS = { button: 'Button', link: 'Link', textbox: 'Text box', searchbox: 'Search box', checkbox: 'Checkbox', radio: 'Option',
    combobox: 'Drop-down', image: 'Picture', img: 'Picture', heading: 'Heading', tab: 'Tab', menuitem: 'Menu item', slider: 'Slider' };
  /** What a tester would call an element: "Button “Search”". */
  function sayWhat(el) {
    if (!el) return 'Part of the page';
    const { role, name } = brief(el);
    const word = ROLE_WORDS[role] ?? (/^h[1-6]$/.test(role) ? 'Heading' : null);
    if (word && name) return `${word} “${name}”`;
    if (name) return `“${name}”`;
    return word ?? 'Part of the page';
  }

  function mountToolbar() {
    if (!document.body) return void document.addEventListener('DOMContentLoaded', mount, { once: true });
    host = document.createElement('div');
    host.id = 'qa-recorder-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const tool = t => `<button data-act="${t.act}" class="t" title="${t.title}" aria-pressed="false">${icon(t.act)}<span class="lbl">${t.label}</span>${t.key ? `<kbd>${t.key}</kbd>` : ''}</button>`;
    const mic = config.voice === 'push-to-talk'
      ? `<button data-act="mic" class="t mic" title="Hold to talk (or hold ${config.talkKey}); each press becomes a spoken note">${icon('mic')}<span class="lbl">Hold ${config.talkKey}</span></button>`
      : config.voice === 'open-mic'
        ? `<button data-act="mic" class="t mic live" title="Open mic: everything you say is written down. Click to mute.">${icon('mic')}<span class="lbl">Live</span></button>`
        : '';
    root.innerHTML = html(`
<style>
  :host { --ink: #14181f; --card: #fffdf7; --wash: #efe9da; --muted: #566070; --focus: #1f6feb;
    --bug: #d92d20; --dislike: #f5a300; --idea: #1f6feb; --like: #157a40; --design: #6d3fc4; }
  * { box-sizing: border-box; font: 13px/1.35 system-ui, "Segoe UI", sans-serif; }
  [hidden] { display: none !important; }
  ::selection { background: #ffd166; color: var(--ink); }
  [data-k="bug"] { --k: var(--bug); --on: #fff; } [data-k="dislike"] { --k: var(--dislike); --on: var(--ink); }
  [data-k="idea"] { --k: var(--idea); --on: #fff; } [data-k="like"] { --k: var(--like); --on: #fff; }
  [data-k="design"] { --k: var(--design); --on: #fff; }
  .ic { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  button { cursor: pointer; margin: 0; border: 0; background: transparent; color: inherit; }
  button:focus-visible, textarea:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

  /* an ink line on a white card, with a white edge outside it: readable on a light page and a dark one */
  .dock { position: fixed; bottom: 12px; display: flex; flex-direction: column; gap: 8px; pointer-events: none; color: var(--ink); }
  .dock.left { left: 12px; align-items: flex-start; } .dock.right { right: 12px; align-items: flex-end; }
  .dock > * { pointer-events: auto; }
  .bar, .menu { background: var(--card); border: 2px solid var(--ink); border-radius: 12px; outline: 2px solid var(--card);
    box-shadow: 0 8px 24px #0000004d; }
  .bar { display: flex; align-items: stretch; }
  .grp { padding: 5px 8px 8px; border-left: 2px solid var(--ink); } .grp:first-child { border-left: 0; }
  .grp > small { display: block; height: 15px; margin-bottom: 3px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); white-space: nowrap; }
  .row { display: flex; gap: 4px; align-items: center; }
  .t { position: relative; width: 62px; height: 50px; padding: 0; display: grid; justify-items: center; align-content: center; gap: 2px; border-radius: 8px; }
  .t .lbl { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .t kbd { position: absolute; top: 2px; right: 4px; font-size: 9.5px; font-weight: 600; color: var(--muted); }
  .t:hover, .menu button:hover { background: var(--wash); }
  .t[aria-pressed="true"] { background: var(--ink); color: var(--card); } .t[aria-pressed="true"] kbd { color: #c9cfd8; }
  .t:active { transform: translateY(1px); }
  .rec { display: flex; align-items: center; gap: 6px; height: 50px; padding: 0 4px; }
  .rec i { width: 10px; height: 10px; border-radius: 50%; background: var(--bug); }
  .rec .lbl { font-size: 12px; font-weight: 600; }
  .mic { width: 66px; } .mic.talking { background: var(--bug); color: #fff; } .mic.live { color: var(--like); } .mic.muted { color: var(--muted); }
  .saved { width: 62px; height: 50px; display: grid; justify-items: center; align-content: center; border: 2px dashed var(--ink); border-radius: 8px; }
  .count { font-size: 20px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .saved .lbl { font-size: 10.5px; font-weight: 600; }
  .saved.stamp { animation: stamp .9s cubic-bezier(.16, 1, .3, 1); }
  @keyframes stamp { 0% { background: var(--k); color: var(--on); border-style: solid; transform: scale(1.2); } 60% { background: var(--k); color: var(--on); border-style: solid; transform: none; } }
  .finish { width: 86px; border: 2px solid var(--ink); } .finish .lbl { font-size: 13px; font-weight: 700; }
  .finish.armed, .finish.armed:hover { background: var(--bug); border-color: var(--bug); color: #fff; }
  .ic-expand, .g-menu { display: none; }

  /* collapsed: the last tool used, the count, and a menu with the rest */
  .dock.collapsed .grp > small, .dock.collapsed .rec .lbl, .dock.collapsed .g-design, .dock.collapsed .g-more { display: none; }
  .dock.collapsed .grp { padding: 6px; } .dock.collapsed .g-menu { display: block; }
  .dock.collapsed .ic-collapse { display: none; } .dock.collapsed .ic-expand { display: block; }
  .menu { display: grid; gap: 2px; min-width: 190px; padding: 6px; }
  .menu .t { width: 100%; height: 38px; padding: 0 10px; display: flex; align-items: center; justify-content: flex-start; gap: 10px; }
  .menu .t .lbl { font-size: 13px; } .menu .t kbd { position: static; margin-left: auto; font-size: 11px; }
  .menu .finish { margin-top: 4px; justify-content: center; }

  .step { display: flex; align-items: center; gap: 8px; max-width: min(520px, calc(100vw - 24px)); padding: 7px 12px; background: var(--ink); color: var(--card);
    border-radius: 8px; outline: 2px solid var(--card); }
  .step b { font-weight: 700; color: #ffd166; white-space: nowrap; }
  .step.error { background: var(--bug); color: #fff; }
  .step button { flex: none; padding: 3px 10px; border: 2px solid currentColor; border-radius: 6px; font-weight: 700; }

  .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: #0000000d; }
  .layer.grab { cursor: grab; } .layer.grabbing { cursor: grabbing; }
  .sel { position: fixed; border: 3px solid var(--k, var(--ink)); outline: 2px solid var(--card); border-radius: 3px; pointer-events: none; }
  .sel.picked { border-style: dashed; }
  .sel b, .form .num { font-weight: 800; font-variant-numeric: tabular-nums; }
  .sel b { position: absolute; left: -3px; bottom: 100%; min-width: 30px; height: 26px; padding: 0 8px; display: grid; place-items: center;
    background: var(--k); color: var(--on); font-size: 15px; border-radius: 4px 4px 0 0; }
  .sel.in b { bottom: auto; top: -3px; border-radius: 0 0 4px 0; }
  .leader { position: fixed; width: 3px; background: var(--k); outline: 1px solid var(--card); pointer-events: none; }
  .handle { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; background: var(--design); border: 2px solid var(--card);
    outline: 2px solid var(--ink); border-radius: 3px; pointer-events: auto; }
  .handle[data-h="e"] { cursor: ew-resize; } .handle[data-h="s"] { cursor: ns-resize; } .handle[data-h="se"] { cursor: nwse-resize; }

  /* the tag: one dialog for a note and for a layout change */
  .form { position: fixed; width: 380px; max-width: calc(100vw - 16px); background: var(--card); color: var(--ink); border: 2px solid var(--ink);
    border-radius: 10px; outline: 2px solid var(--card); box-shadow: 0 14px 36px #00000059; overflow: hidden; pointer-events: auto; }
  .head { display: flex; align-items: center; gap: 12px; padding: 9px 12px 9px 14px; background: var(--k); color: var(--on); cursor: grab;
    user-select: none; touch-action: none; }
  .form.dragging .head { cursor: grabbing; }
  .form .num { font-size: 34px; line-height: 1; }
  .about { flex: 1; min-width: 0; } .about small { display: block; font-size: 11.5px; font-weight: 600; }
  .about strong { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: 14.5px; font-weight: 700; overflow: hidden; overflow-wrap: anywhere; }
  .head .ic { opacity: .75; stroke-width: 2.6; }
  .body { display: grid; gap: 10px; padding: 12px 14px 14px; }
  /* the text box and the kind of note are one field, so the tag has a single row of buttons */
  .field { background: #fff; border: 2px solid var(--ink); border-radius: 8px; overflow: hidden; }
  .field:has(textarea:focus-visible) { outline: 3px solid var(--focus); outline-offset: 1px; }
  .kinds { display: flex; align-items: center; gap: 2px; padding: 4px; background: var(--card); border-top: 1px solid #cfc8b6; }
  .kinds button { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 5px; font-weight: 600; }
  .kinds button:hover { background: var(--wash); }
  .kinds button[aria-pressed="true"] { background: var(--ink); color: var(--card); }
  .kinds button:focus-visible { outline-offset: -3px; }
  .shape { width: 11px; height: 11px; background: var(--k); }
  .kinds [data-k="bug"] .shape { border-radius: 50%; } .kinds [data-k="dislike"] .shape { transform: rotate(45deg) scale(.85); }
  .kinds [data-k="like"] .shape { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  textarea { display: block; width: 100%; min-height: 92px; resize: vertical; padding: 8px 10px; background: #fff; color: var(--ink); border: 0;
    font-size: 14px; caret-color: var(--ink); }
  textarea.short { min-height: 58px; } textarea::placeholder { color: var(--muted); } textarea:focus-visible { outline: none; }
  .actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .keys { font-size: 12px; color: var(--muted); } .btns { display: flex; gap: 8px; flex: none; }
  .btns button { padding: 7px 14px; border: 2px solid var(--ink); border-radius: 8px; font-weight: 700; white-space: nowrap; }
  .btns button:hover { background: var(--wash); } .btns button:active { transform: translateY(1px); }
  .btns .save { background: var(--ink); color: var(--card); } .btns .save:hover { background: #2b3340; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
<div class="dock left">
  <div class="step" role="status" hidden><b></b><span></span><button data-act="dismiss" hidden>Dismiss</button></div>
  <div class="menu" hidden></div>
  <div class="bar">
    <div class="grp"><small>Session</small><div class="row"><span class="rec" title="This session is being recorded"><i></i><span class="lbl">Recording</span></span>${mic}</div></div>
    <div class="grp g-note"><small>Leave a note about</small><div class="row"></div></div>
    <div class="grp g-design"><small>Show a layout change</small><div class="row"></div></div>
    <div class="grp"><small>Saved</small><div class="row"><span class="saved" title="Notes saved in this session"><b class="count">0</b><span class="lbl">notes</span></span></div></div>
    <div class="grp g-more"><small>&nbsp;</small><div class="row"></div></div>
    <div class="grp g-menu"><div class="row"><button data-act="menu" class="t" title="The other tools, and Finish" aria-expanded="false">${icon('menu')}<span class="lbl">Menu</span></button></div></div>
  </div>
  <div class="parts" hidden>${TOOLS.map(tool).join('')}
    <button data-act="collapse" class="t" title="Make the toolbar smaller">${icon('collapse')}${icon('expand')}<span class="lbl">Collapse</span></button>
    <button data-act="side" class="t" title="Move the toolbar to the other side">${icon('side')}<span class="lbl">Side</span></button>
    <button data-act="finish" class="t finish" title="Finish the session and close the app"><span class="lbl">Finish</span></button>
  </div>
</div>`);
    const dock = root.querySelector('.dock');
    const bar = root.querySelector('.bar');
    const menu = root.querySelector('.menu');
    const stepEl = root.querySelector('.step');
    const savedEl = root.querySelector('.saved');
    const countEl = root.querySelector('.count');
    const micBtn = root.querySelector('.mic');
    const button = act => root.querySelector(`button[data-act="${act}"]`);
    const toolBtn = Object.fromEntries(TOOLS.map(t => [t.act, button(t.act)]));
    const collapseBtn = button('collapse'), sideBtn = button('side'), finishBtn = button('finish'), menuBtn = button('menu');
    const rows = { note: root.querySelector('.g-note .row'), design: root.querySelector('.g-design .row'), more: root.querySelector('.g-more .row') };
    let talking = false;
    let side = store.get('side') === 'right' ? 'right' : 'left';
    // Spoken remarks are photographed with the toolbar on screen (hiding it would make it blink each time the tester
    // speaks), so a voice session starts with the small bar, which covers little of the page.
    let collapsed = store.get('collapsed') === null ? ['push-to-talk', 'open-mic'].includes(config.voice) : store.get('collapsed') === '1';
    let narrow = false; // the window is too small for the full bar
    let last = toolBtn[store.get('last')] ? store.get('last') : 'element';
    let count = 0;
    let busy = false;
    let finishArmed = null;
    // the current mode's handler for events from inside the overlay (pointer drags, element picking, the form)
    let modeHandler = null;
    // what Esc (or Undo) must put back: a design tool's change that isn't confirmed yet
    let onCancel = null;
    setSide(side);
    refit();
    window.addEventListener('resize', refit);

    ui = {
      start(mode) {
        if (busy) return;
        busy = true;
        last = mode;
        store.set('last', mode);
        closeMenu();
        layout();
        toolBtn[mode]?.setAttribute('aria-pressed', 'true');
        if (mode === 'note') return openForm(null, null, 'The whole page');
        if (mode === 'region') return pickRegion();
        if (mode === 'move' || mode === 'resize') return designTool(mode);
        return pickElement();
      },
      busy: () => busy && !!modeHandler,
      cancel: () => { onCancel?.(); done(); },
      menuOpen: () => !menu.hidden,
      closeMenu,
      /** Push-to-talk: down/up from the key or the microphone button. */
      talk(down) {
        if (down === talking) return;
        talking = down;
        micBtn?.classList.toggle('talking', down);
        if (micBtn) micBtn.querySelector('.lbl').textContent = down ? 'Talking' : `Hold ${config.talkKey}`;
        void window.__qaRecorderTalk?.(down).then(r => { if (r) setCount(r.count); }).catch(() => {});
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
              micBtn.querySelector('.lbl').textContent = r.muted ? 'Muted' : 'Live';
            });
          }
          return;
        }
        if (el instanceof Element && dock.contains(el)) {
          if (e.type !== 'click') return;
          const act = el.closest('button')?.dataset.act;
          if (act === 'side') setSide(side === 'left' ? 'right' : 'left');
          else if (act === 'finish') finish();
          else if (act === 'menu') menu.hidden ? openMenu() : closeMenu();
          else if (act === 'collapse') setCollapsed(!collapsed);
          else if (act === 'dismiss') setStep();
          else if (act) ui.start(act);
          return;
        }
        modeHandler?.(e, el);
      },
    };

    function setSide(next) {
      side = next;
      store.set('side', side);
      dock.classList.toggle('left', side === 'left');
      dock.classList.toggle('right', side === 'right');
    }

    function setCollapsed(next) {
      collapsed = next;
      store.set('collapsed', collapsed ? '1' : '0');
      closeMenu();
      refit();
    }

    /** Puts each button where the current form of the bar wants it: in its group, or in the menu. */
    function layout(small = collapsed || narrow) {
      dock.classList.toggle('collapsed', small);
      collapseBtn.querySelector('.lbl').textContent = small ? 'Expand' : 'Collapse';
      collapseBtn.title = small ? 'Show the whole toolbar' : 'Make the toolbar smaller';
      collapseBtn.hidden = small && narrow;
      if (!small) {
        for (const t of TOOLS) rows[t.act === 'move' || t.act === 'resize' ? 'design' : 'note'].appendChild(toolBtn[t.act]);
        rows.more.append(collapseBtn, sideBtn, finishBtn);
        return;
      }
      rows.note.appendChild(toolBtn[last]);
      menu.append(...TOOLS.filter(t => t.act !== last).map(t => toolBtn[t.act]), sideBtn, collapseBtn, finishBtn);
    }

    /** Collapses the bar by itself when the window can't hold all of it. */
    function refit() {
      if (host.style.display === 'none') return;
      layout(false);
      narrow = bar.offsetWidth + 24 > document.documentElement.clientWidth;
      layout();
      if (!dock.classList.contains('collapsed')) closeMenu();
    }

    function openMenu() {
      menu.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }

    /** The line above the bar: which step the tester is on, or what went wrong. */
    function setStep(n, message, error = false) {
      stepEl.hidden = !message;
      stepEl.classList.toggle('error', error);
      stepEl.querySelector('b').textContent = n ?? '';
      stepEl.querySelector('b').hidden = !n;
      stepEl.querySelector('span').textContent = message ?? '';
      stepEl.querySelector('button').hidden = !error;
    }

    function setCount(n) {
      count = n;
      countEl.textContent = String(n);
    }

    function finish() {
      const lbl = finishBtn.querySelector('.lbl');
      if (!finishArmed) {
        finishBtn.classList.add('armed');
        lbl.textContent = 'Press again';
        finishArmed = setTimeout(() => {
          finishArmed = null;
          finishBtn.classList.remove('armed');
          lbl.textContent = 'Finish';
        }, 3000);
        return;
      }
      clearTimeout(finishArmed);
      lbl.textContent = 'Saving…';
      void window.__qaRecorderFinish?.();
    }

    function done() {
      busy = false;
      modeHandler = null;
      onCancel = null;
      for (const b of Object.values(toolBtn)) b.setAttribute('aria-pressed', 'false');
      if (!stepEl.classList.contains('error')) setStep();
      root.querySelectorAll('.layer, .sel, .leader, .form, .handle').forEach(n => n.remove());
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
      setStep('Step 1 of 2', 'Drag a box round the area your note is about. Esc cancels.');
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
          if (rect.width < 6 || rect.height < 6) return done();
          const under = elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
          openForm(rect, describe(under), 'The area you marked');
        }
      };
    }

    function pickElement() {
      setStep('Step 1 of 2', 'Click the thing your note is about. Esc cancels.');
      const layer = add('layer');
      const sel = add('sel');
      modeHandler = (e, el) => {
        if (el !== layer) return;
        const target = elementAt(e.clientX, e.clientY);
        if (e.type === 'pointermove' && target) place(sel, target.getBoundingClientRect());
        if (e.type !== 'click') return;
        layer.remove();
        if (!target) return done();
        const r = target.getBoundingClientRect();
        openForm({ x: r.x, y: r.y, width: r.width, height: r.height }, describe(target), sayWhat(target));
      };
    }

    function elementAt(x, y) {
      return document.elementsFromPoint(x, y).find(el => el !== host && !host.contains(el)) ?? null;
    }

    // ---- the tag ----

    /** Builds the tag dialog. A note has the row of kinds; a layout change has its summary in the head instead. */
    function tag({ k, about, what, kinds, placeholder, cancel, save }) {
      const form = add('form');
      form.innerHTML = html(`
        <div class="head" title="Drag to move this out of the way"><span class="num"></span>
          <span class="about"><small></small><strong class="what"></strong></span>${icon('grip')}</div>
        <div class="body">
          <div class="field"><textarea class="${kinds ? '' : 'short'}" placeholder="${placeholder}"></textarea>
          ${kinds ? `<div class="kinds" role="group" aria-label="What kind of note">${KINDS.map(kind => `<button data-kind="${kind.id}" data-k="${kind.id}" aria-pressed="${kind.id === k}"><span class="shape"></span>${kind.label}</button>`).join('')}</div>` : ''}</div>
          <div class="actions"><span class="keys">Ctrl+Enter saves · Esc ${cancel.esc}</span>
            <span class="btns"><button data-form="${cancel.id}">${cancel.label}</button><button data-form="${save.id}" class="save">${save.label} ${count + 1}</button></span></div>
        </div>`);
      form.dataset.k = k;
      form.querySelector('.num').textContent = String(count + 1);
      form.querySelector('small').textContent = about;
      form.querySelector('.what').textContent = what;
      return form;
    }

    /** Gives the selection the tag's number and colour. */
    function number(sel, k, r) {
      sel.dataset.k = k;
      sel.classList.toggle('in', r.y < 32);
      if (!sel.querySelector('b')) sel.appendChild(document.createElement('b')).textContent = String(count + 1);
    }

    /** Next to what it is about, clear of it, with a line joining the two; centred when it is about the whole page. */
    function placeTag(form, r) {
      root.querySelector('.leader')?.remove();
      const w = form.offsetWidth, h = form.offsetHeight, gap = 14, m = 8;
      let left = (innerWidth - w) / 2, top = (innerHeight - h) / 2;
      if (r) {
        left = Math.min(Math.max(m, r.x), innerWidth - w - m);
        const below = r.y + r.height + gap, above = r.y - gap - h;
        const joined = below + h <= innerHeight - m ? below : above >= m ? above : null;
        if (joined !== null) {
          top = joined;
          const from = Math.max(r.x, left) + 12, to = Math.min(r.x + r.width, left + w) - 12;
          if (to >= from) {
            const leader = add('leader');
            leader.dataset.k = form.dataset.k;
            Object.assign(leader.style, { left: Math.min(from + 12, to) + 'px', top: (joined === below ? r.y + r.height : top + h) + 'px', height: gap + 'px' });
          }
        } else {
          // no room above or below: beside it, or failing that the top corner
          top = Math.min(Math.max(m, r.y), innerHeight - h - m);
          if (r.x + r.width + gap + w <= innerWidth - m) left = r.x + r.width + gap;
          else if (r.x - gap - w >= m) left = r.x - gap - w;
          else top = m;
        }
      }
      Object.assign(form.style, { left: Math.max(m, left) + 'px', top: Math.max(m, top) + 'px' });
    }

    /** Lets the tag be dragged by its head. Returns a handler that says whether it used the event. */
    function draggable(form) {
      const head = form.querySelector('.head');
      let grip = null;
      return (e, el) => {
        if (!(el instanceof Element) || !head.contains(el)) return false;
        if (e.type === 'pointerdown' && e.button === 0) {
          const r = form.getBoundingClientRect();
          grip = { x: e.clientX - r.left, y: e.clientY - r.top };
          head.setPointerCapture(e.pointerId);
          form.classList.add('dragging');
        } else if (e.type === 'pointermove' && grip) {
          form.dataset.moved = '1';
          root.querySelector('.leader')?.remove();
          form.style.left = Math.min(Math.max(8, e.clientX - grip.x), innerWidth - form.offsetWidth - 8) + 'px';
          form.style.top = Math.min(Math.max(8, e.clientY - grip.y), innerHeight - form.offsetHeight - 8) + 'px';
        } else if ((e.type === 'pointerup' || e.type === 'pointercancel') && grip) {
          grip = null;
          form.classList.remove('dragging');
          form.querySelector('textarea').focus({ preventScroll: true });
        }
        return true;
      };
    }

    function openForm(rect, target, what) {
      let kind = KINDS[0].id;
      const form = tag({
        k: kind, about: 'Note about', what, kinds: true, placeholder: 'What happened? What did you expect?',
        cancel: { id: 'cancel', label: 'Cancel', esc: 'cancels' }, save: { id: 'save', label: 'Save note' },
      });
      const sel = rect ? root.querySelector('.sel') ?? add('sel') : null;
      if (sel) {
        place(sel, rect);
        number(sel, kind, rect);
      }
      placeTag(form, rect);
      setStep(rect ? 'Step 2 of 2' : null, 'Say what you noticed, then save.');
      const text = form.querySelector('textarea');
      text.focus();
      const drag = draggable(form);

      modeHandler = (e, el) => {
        if (drag(e, el)) return;
        if (!(el instanceof Element) || !form.contains(el)) return;
        if (e.type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return void save();
        if (e.type !== 'click') return;
        const pressed = el.closest('button');
        if (pressed?.dataset.kind) {
          kind = pressed.dataset.kind;
          form.querySelectorAll('.kinds button').forEach(b => b.setAttribute('aria-pressed', String(b === pressed)));
          for (const part of [form, sel, root.querySelector('.leader')]) if (part) part.dataset.k = kind;
          text.focus(); // so typing carries on into the note
        } else if (pressed?.dataset.form === 'cancel') done();
        else if (pressed?.dataset.form === 'save') void save();
      };

      async function save() {
        const note = {
          kind, text: text.value.trim(), rect, target, url: location.href,
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, at: new Date().toISOString(),
        };
        done();
        await submit(note);
      }
    }

    const twoFrames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    /**
     * Hands a note to the harness, which takes the screenshots, with the toolbar hidden so it stays out of them.
     * A design change passes `before`: the page is shown as it was for a moment, for the before screenshot.
     */
    async function submit(note, before) {
      busy = true;
      host.style.display = 'none';
      let saved = null;
      let failure = null;
      try {
        if (before) {
          before.revert();
          await twoFrames();
          try {
            await window.__qaRecorderBefore?.(note.rect, note.viewport);
          } finally {
            before.reapply();
          }
        }
        await twoFrames();
        saved = await window.__qaRecorderNote(note);
      } catch (err) {
        failure = err?.message ?? String(err);
      } finally {
        host.style.display = '';
        busy = false;
      }
      if (failure) return setStep('Not saved', `That ${note.change ? 'change' : 'note'} couldn’t be saved (${failure}). Please make it again.`, true);
      setStep();
      setCount(saved.count);
      // the count takes the note's colour for a moment: the number has arrived
      savedEl.dataset.k = note.change ? 'design' : note.kind;
      savedEl.classList.remove('stamp');
      void savedEl.offsetWidth;
      savedEl.classList.add('stamp');
    }

    // ---- design changes: Move and Resize ----

    const STYLE_PROPS = ['translate', 'display', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'flex'];
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const union = (a, b) => {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
    };
    const parseTranslate = v => {
      const [x = 0, y = 0] = v && v !== 'none' ? v.split(' ').map(parseFloat) : [];
      return { x: x || 0, y: y || 0 };
    };
    const label = t => `${t.tag}${t.text ? ` “${t.text.slice(0, 30)}”` : ''}`;
    const px = n => `${Math.round(n)}px`;

    /** The inline styles that show a change: a translate for Move, a fixed size for Resize. */
    function changeStyles(p) {
      const styles = {};
      if (p.inlineBox) styles.display = 'inline-block'; // transforms and sizes don't apply to inline boxes
      if (p.mode === 'move') {
        styles.translate = `${px(p.base.x + p.dx)} ${px(p.base.y + p.dy)}`;
      } else {
        const inner = p.borderBox ? { x: 0, y: 0 } : p.chrome;
        styles.width = px(Math.max(1, p.w - inner.x));
        styles.height = px(Math.max(1, p.h - inner.y));
        Object.assign(styles, { 'min-width': '0', 'max-width': 'none', 'min-height': '0', 'max-height': 'none' });
        if (p.flexChild) styles.flex = '0 0 auto';
      }
      return styles;
    }
    function applyChange(p) {
      for (const [prop, value] of Object.entries(changeStyles(p))) p.el.style.setProperty(prop, value, 'important');
    }
    function restore(p) {
      for (const [prop, [value, priority]] of Object.entries(p.inline)) {
        if (value) p.el.style.setProperty(prop, value, priority);
        else p.el.style.removeProperty(prop);
      }
    }

    /** What the moved element's centre now sits on: the place in the layout the tester dropped it. */
    function dropTarget(el, r) {
      const skip = n => n === host || host.contains(n) || n === el || el.contains(n) || n === document.documentElement || n === document.body;
      return document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).find(n => !skip(n)) ?? null;
    }

    /**
     * Move drags an element to where it should go; Resize drags its right and bottom edges. The change is made in
     * the page (inline styles), so the tester sees the result, and stays until the page reloads, so later changes
     * build on it. Saving records it with before and after screenshots; Undo or Esc puts the element back.
     */
    function designTool(mode) {
      setStep('Step 1 of 2', mode === 'move' ? 'Drag something to where it should go. Esc cancels.' : 'Click the thing you want to resize. Esc cancels.');
      const layer = add('layer');
      const sel = add('sel');
      let pick = null;
      let drag = null;
      let panel = null;
      let panelDrag = null;
      let handles = [];
      onCancel = () => { if (pick) restore(pick); };

      function choose(el) {
        const cs = getComputedStyle(el);
        const before = rectOf(el);
        pick = {
          mode, el, before,
          target: describe(el),
          inline: Object.fromEntries(STYLE_PROPS.map(p => [p, [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]])),
          base: parseTranslate(cs.translate),
          inlineBox: cs.display === 'inline',
          flexChild: /flex/.test(getComputedStyle(el.parentElement ?? document.body).display),
          borderBox: cs.boxSizing === 'border-box',
          // padding and border, which a content-box width leaves out
          chrome: {
            x: ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, k) => n + parseFloat(cs[k]), 0),
            y: ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + parseFloat(cs[k]), 0),
          },
          dx: 0, dy: 0, w: before.width, h: before.height,
        };
        sel.classList.add('picked');
        number(sel, 'design', before);
        layer.classList.toggle('grab', mode === 'move');
        setStep('Step 2 of 2', mode === 'move' ? 'Drag it again to adjust, then save the change. Esc undoes it.' : 'Drag the handles, then save the change. Esc undoes it.');
        if (mode === 'resize') {
          handles = ['e', 's', 'se'].map(h => {
            const handle = add('handle');
            handle.dataset.h = h;
            return handle;
          });
        }
      }

      function summary() {
        if (mode === 'move') {
          const r = rectOf(pick.el);
          const dx = r.x - pick.before.x, dy = r.y - pick.before.y;
          return `${label(pick.target)}: ${Math.abs(dx)}px ${dx < 0 ? 'left' : 'right'}, ${Math.abs(dy)}px ${dy < 0 ? 'up' : 'down'}`;
        }
        const r = rectOf(pick.el);
        return `${label(pick.target)}: ${pick.before.width}×${pick.before.height} → ${r.width}×${r.height}`;
      }

      function sync() {
        const r = pick.el.getBoundingClientRect();
        place(sel, r);
        sel.classList.toggle('in', r.y < 32);
        const at = { e: [r.right, r.top + r.height / 2], s: [r.left + r.width / 2, r.bottom], se: [r.right, r.bottom] };
        for (const handle of handles) {
          const [x, y] = at[handle.dataset.h];
          Object.assign(handle.style, { left: x + 'px', top: y + 'px' });
        }
        if (panel) {
          panel.querySelector('.what').textContent = summary();
          panel.querySelector('.what').title = summary();
        }
      }

      function showPanel() {
        if (!panel) {
          panel = tag({
            k: 'design', about: mode === 'move' ? 'Moved' : 'Resized', what: '', kinds: false, placeholder: 'Anything else to say about it? (optional)',
            cancel: { id: 'undo', label: 'Undo change', esc: 'undoes' }, save: { id: 'confirm', label: 'Save change' },
          });
          panelDrag = draggable(panel);
        }
        // a drag moves focus off the note; give it back so typing carries on into it
        panel.querySelector('textarea').focus({ preventScroll: true });
        sync();
        // follows the element, until the tester puts it somewhere themselves
        if (!panel.dataset.moved) placeTag(panel, pick.el.getBoundingClientRect());
      }

      async function confirm() {
        const p = pick;
        const after = rectOf(p.el);
        const parent = p.el.parentElement && p.el.parentElement !== document.body ? describe(p.el.parentElement) : undefined;
        const change = p.mode === 'move'
          ? { tool: 'move', before: p.before, after, dx: after.x - p.before.x, dy: after.y - p.before.y, droppedOn: describe(dropTarget(p.el, after)) ?? undefined, parent }
          : { tool: 'resize', before: p.before, after, dw: after.width - p.before.width, dh: after.height - p.before.height, parent };
        change.style = changeStyles(p);
        const note = {
          kind: p.mode, text: panel.querySelector('textarea').value.trim(), rect: union(p.before, after), target: p.target, change,
          url: location.href, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, at: new Date().toISOString(),
        };
        done(); // the change stays on the page; later changes build on it
        await submit(note, { revert: () => restore(p), reapply: () => applyChange(p) });
      }

      modeHandler = (e, el) => {
        if (panelDrag?.(e, el)) return;
        if (panel && el instanceof Element && panel.contains(el)) {
          if (e.type === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return void confirm();
          if (e.type !== 'click') return;
          const action = el.closest('button')?.dataset.form;
          if (action === 'undo') ui.cancel();
          else if (action === 'confirm') void confirm();
          return;
        }
        const onHandle = handles.includes(el);
        if (el !== layer && !onHandle) return;
        if (e.type === 'pointerdown') {
          if (onHandle) {
            el.setPointerCapture(e.pointerId);
            drag = { x: e.clientX, y: e.clientY, w: pick.w, h: pick.h, h0: el.dataset.h };
            return;
          }
          if (!pick) {
            const target = elementAt(e.clientX, e.clientY);
            if (!target || target === document.body || target === document.documentElement) return;
            choose(target);
            if (mode === 'resize') return showPanel();
          } else if (mode !== 'move') {
            return;
          } else {
            const r = pick.el.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
          }
          layer.setPointerCapture(e.pointerId);
          layer.classList.add('grabbing');
          drag = { x: e.clientX, y: e.clientY, dx: pick.dx, dy: pick.dy };
        } else if (e.type === 'pointermove') {
          if (!pick) {
            const target = elementAt(e.clientX, e.clientY);
            if (target) place(sel, target.getBoundingClientRect());
            return;
          }
          if (!drag) return;
          if (mode === 'move') {
            pick.dx = drag.dx + e.clientX - drag.x;
            pick.dy = drag.dy + e.clientY - drag.y;
          } else {
            if (drag.h0.includes('e')) pick.w = Math.max(4, drag.w + e.clientX - drag.x);
            if (drag.h0.includes('s')) pick.h = Math.max(4, drag.h + e.clientY - drag.y);
          }
          applyChange(pick);
          sync();
        } else if ((e.type === 'pointerup' || e.type === 'pointercancel') && drag) {
          drag = null;
          layer.classList.remove('grabbing');
          showPanel();
        }
      };
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
