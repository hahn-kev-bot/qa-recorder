import fs from 'node:fs/promises';
import path from 'node:path';

const KIND_LABEL = { bug: '🐛 Bug', dislike: '👎 Dislike', idea: '💡 Idea', like: '👍 Like', spoken: '🎙 Spoken' };
export const ERROR_TYPES = new Set(['console.error', 'pageerror', 'requestfailed', 'http']);
const NEARBY_MS = 60_000;

const STEPS_BEFORE_NOTE = 10;

/**
 * Rewrites the whole session folder; called after every note so a crash loses nothing.
 * `speech` holds transcribed utterances: { id, at, end, text, mode: 'push-to-talk' | 'open-mic', screenshot }.
 */
export async function writeBundle({ sessionDir, session, notes, events, speech = [] }) {
  const errors = events.filter(e => ERROR_TYPES.has(e.type)).length;
  const actions = events.filter(e => e.type === 'action').length;
  const summary = { ...session, notes: notes.length, kinds: countKinds(notes), errors, actions, utterances: speech.length };
  await fs.writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(sessionDir, 'notes.json'), JSON.stringify(notes, null, 2));
  await fs.writeFile(path.join(sessionDir, 'events.json'), JSON.stringify(events, null, 2));
  await fs.writeFile(path.join(sessionDir, 'feedback.md'), feedbackMarkdown(session, notes, events));
  await fs.writeFile(path.join(sessionDir, 'timeline.md'), timelineMarkdown(session, notes, events, speech));
  if (speech.length) {
    await fs.writeFile(path.join(sessionDir, 'speech.json'), JSON.stringify(speech, null, 2));
    await fs.writeFile(path.join(sessionDir, 'transcript.md'), transcriptMarkdown(session, speech));
  }
  await fs.writeFile(path.join(sessionDir, 'HANDOFF.md'), handoffPrompt(session, sessionDir, { speech: speech.length > 0 }));
}

const quote = s => `“${s}”`;

/** "click button “Toggle filters” in dialog “Filters”" */
export function describeAction(a) {
  const t = a.target;
  const what = t ? `${t.role}${t.name ? ` ${quote(t.name)}` : ''}${t.inside ? ` in ${t.inside.role}${t.inside.name ? ` ${quote(t.inside.name)}` : ''}` : ''}` : '';
  switch (a.action) {
    case 'click': return `click ${what}`;
    case 'input': {
      if (a.hidden) return `typed a ${a.hidden} into ${what}`;
      if (a.checked !== undefined) return `${a.checked ? 'checked' : 'unchecked'} ${what}`;
      if (a.length !== undefined) return `typed ${a.length} characters into ${what}`;
      return a.value ? `set ${what} to ${quote(a.value)}` : `cleared ${what}`;
    }
    case 'key': return `pressed ${a.key}${what ? ` in ${what}` : ''}`;
    default: return `${a.action} ${what}`;
  }
}

/** "opened tab 2 from tab 1", "switched to tab 2 (http://…)", "closed tab 2" */
export function describeTab(e) {
  switch (e.change) {
    case 'opened': return `opened tab ${e.tab}${e.from ? ` from tab ${e.from}` : ''}${e.url ? ` at ${shortUrl(e.url)}` : ''}`;
    case 'switched': return `switched to tab ${e.tab}${e.url ? ` (${shortUrl(e.url)})` : ''}`;
    case 'closed': return `closed tab ${e.tab}`;
    default: return `tab ${e.tab} ${e.change}`;
  }
}

/**
 * Walks the events the way the tester saw them: one line per action, page change and tab change. Page loads in a
 * tab the tester isn't on are labelled with their tab; with only one tab, tabs are never mentioned.
 */
function readEvents(events, onLine) {
  const multiTab = events.some(e => e.type === 'tab' && e.change === 'opened');
  let current = events.find(e => e.tab)?.tab;
  const lastUrl = new Map();
  for (const e of events) {
    if (e.type === 'action') {
      if (multiTab && e.tab && e.tab !== current) onLine(e, 'tab', `switched to tab ${e.tab}`); // no visibility event came
      current = e.tab ?? current;
      onLine(e, 'action', describeAction(e));
    } else if (e.type === 'navigate') {
      const url = shortUrl(e.url);
      if (lastUrl.get(e.tab) === url) continue;
      lastUrl.set(e.tab, url);
      onLine(e, 'navigate', `${multiTab && e.tab && e.tab !== current ? `tab ${e.tab} ` : ''}went to ${url}`);
    } else if (e.type === 'tab' && multiTab) {
      if (e.change === 'switched') {
        if (e.tab === current) continue;
        current = e.tab;
      }
      onLine(e, 'tab', describeTab(e));
    }
  }
}

/** Actions, page and tab changes between the previous note and this one: how the tester got here. */
export function stepsBefore(note, previous, events) {
  const from = previous ? Date.parse(previous.at) : 0;
  const to = Date.parse(note.at);
  const steps = [];
  readEvents(events, (e, _kind, text) => {
    const at = Date.parse(e.at);
    if (at > from && at <= to && !e.setup) steps.push(text);
  });
  return steps;
}

const countKinds = notes => notes.reduce((acc, n) => ({ ...acc, [n.kind]: (acc[n.kind] ?? 0) + 1 }), {});

function buildLine(build) {
  if (!build) return undefined;
  if (build.source === 'github-actions') {
    return `CI run [${build.runId}](${build.url}) of \`${build.repo}\`, commit \`${build.sha}\` (${build.branch}: ${build.title})`;
  }
  return `local build ${build.title}`;
}

function feedbackMarkdown(session, notes, events) {
  const errors = events.filter(e => ERROR_TYPES.has(e.type));
  const start = events.find(e => e.type === 'navigate')?.url;
  const lines = [
    `# QA session: ${session.target.name}`,
    '',
    `- Session: ${session.id}, started ${session.startedAt}`,
    ...(buildLine(session.build) ? [`- Build: ${buildLine(session.build)}`] : []),
    ...(start ? [`- Started at: ${start}`] : []),
    ...(session.handoff?.context ? [`- Context: ${session.handoff.context}`] : []),
    `- Notes: ${notes.length} · errors logged: ${errors.length} (all events in events.json)`,
    '',
  ];
  if (session.error) lines.push(`> The session hit an error: ${oneLine(session.error)}`, '');
  if (!notes.length) lines.push('_No notes yet._', '');
  for (const [i, n] of notes.entries()) {
    lines.push(`## ${n.id}. ${KIND_LABEL[n.kind] ?? n.kind}: ${noteTitle(n)}`, '');
    lines.push(`At ${n.at} on \`${shortUrl(n.url)}\``, '');
    if (n.text && n.text.includes('\n')) lines.push(n.text.split('\n').map(l => `> ${l}`).join('\n'), '');
    const steps = stepsBefore(n, notes[i - 1], events);
    if (steps.length) {
      lines.push(`Steps before this note${steps.length > STEPS_BEFORE_NOTE ? ` (last ${STEPS_BEFORE_NOTE} of ${steps.length}; all in timeline.md)` : ''}:`, '');
      steps.slice(-STEPS_BEFORE_NOTE).forEach((s, j) => lines.push(`${j + 1}. ${s}`));
      lines.push('');
    }
    if (n.screenshots.crop) {
      lines.push(`![note ${n.id}](${n.screenshots.crop})`, '');
      lines.push(`Full window: [${n.screenshots.full}](${n.screenshots.full})`, '');
    } else {
      lines.push(`![note ${n.id}](${n.screenshots.full})`, '');
    }
    if (n.audio) lines.push(`Spoken (push-to-talk); audio: [${n.audio}](${n.audio})`, '');
    if (n.target) {
      const t = n.target;
      lines.push('Target element:', '', '```yaml');
      lines.push(`tag: ${t.tag}`);
      if (t.text) lines.push(`text: ${JSON.stringify(t.text)}`);
      if (t.value) lines.push(`value: ${JSON.stringify(t.value)}`);
      if (Object.keys(t.attrs).length) lines.push(`attrs: ${JSON.stringify(t.attrs)}`);
      if (t.classes) lines.push(`classes: ${JSON.stringify(t.classes)}`);
      if (t.landmarks.length) lines.push(`inside: ${JSON.stringify(t.landmarks)}`);
      lines.push(`cssPath: ${JSON.stringify(t.cssPath)}`, '```', '');
    }
    const nearby = errors.filter(e => near(n, e));
    if (nearby.length) {
      lines.push('Errors in the minute before this note:', '');
      for (const e of nearby.slice(-5)) lines.push(`- \`${e.type}\` ${describeEvent(e)}`);
      lines.push('');
    }
  }
  const unattached = errors.filter(e => !notes.some(n => near(n, e)));
  if (unattached.length) {
    lines.push('## Other errors during the session', '');
    for (const e of unattached.slice(0, 30)) lines.push(`- ${e.at} \`${e.type}\` ${describeEvent(e)}`);
    if (unattached.length > 30) lines.push(`- …and ${unattached.length - 30} more in events.json`);
    lines.push('');
  }
  return lines.join('\n');
}

/** mm:ss since the session started. */
function clock(session, iso) {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.parse(session.startedAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Everything in order, on one clock: what the tester did, said and noted, and what went wrong. */
/**
 * The session in order, one row per thing that happened: { at, clock, kind, text, link?, setup? }.
 * kind: action | navigate | error | note | speech | end. Plain text; the markdown and the app format it.
 */
export function timelineRows(session, notes, events, speech = []) {
  const rows = [];
  readEvents(events, (e, kind, text) => rows.push({ at: e.at, kind, text, setup: e.setup }));
  for (const e of events) {
    if (ERROR_TYPES.has(e.type)) rows.push({ at: e.at, kind: 'error', text: `${e.type} ${describeEvent(e)}` });
    else if (e.type === 'end') rows.push({ at: e.at, kind: 'end', text: 'session ended' });
  }
  for (const n of notes) {
    const summary = `${KIND_LABEL[n.kind] ?? n.kind}: ${noteTitle(n)}`;
    rows.push({ at: n.at, kind: 'note', id: n.id, summary, text: `note ${n.id} ${summary}`, link: n.screenshots.crop ?? n.screenshots.full, full: n.screenshots.full, audio: n.audio });
  }
  for (const s of speech) {
    if (s.mode === 'push-to-talk') continue; // those are notes already
    rows.push({ at: s.at, kind: 'speech', text: s.text ? quote(s.text) : '(transcribing…)', link: s.screenshot, full: s.screenshot, audio: s.audio, clip: s.clip });
  }
  return rows
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(r => ({ ...r, clock: clock(session, r.at) }));
}

function timelineLine(r) {
  switch (r.kind) {
    case 'action': return `${r.text}${r.setup ? ' _(setup step)_' : ''}`;
    case 'navigate': return `${r.text.replace(/went to (.*)$/, 'went to `$1`')}${r.setup ? ' _(setup step)_' : ''}`;
    case 'tab': return `🗂 ${r.text}`;
    case 'error': return `⚠ ${r.text}`;
    case 'note': return `**note ${r.id}** ${r.summary} ([screenshot](${r.link}))`;
    case 'speech': return `🎙 ${r.text}${r.link ? ` ([screen](${r.link}))` : ''}`;
    default: return r.text;
  }
}

function timelineMarkdown(session, notes, events, speech) {
  const rows = timelineRows(session, notes, events, speech);
  return [
    `# Timeline: ${session.target.name}`,
    '',
    `Session ${session.id}. Times are minutes:seconds since ${session.startedAt}.`,
    ...(session.trace?.length ? ['', `Playwright trace: ${session.trace.map(f => `[${f}](${f})`).join(', ')} (open with \`npx playwright show-trace <file>\`).`] : []),
    '',
    ...rows.map(r => `- \`${r.clock}\` ${timelineLine(r)}`),
    '',
  ].join('\n');
}

/** Open-mic speech as one running transcript. */
function transcriptMarkdown(session, speech) {
  return [
    `# Transcript: ${session.target.name}`,
    '',
    `Session ${session.id}. Times are minutes:seconds since ${session.startedAt}. What the tester did at each moment is in timeline.md.`,
    '',
    // one line per Whisper segment, so long utterances keep finer timestamps
    ...speech.flatMap(s => {
      const prefix = s.mode === 'push-to-talk' ? `(push-to-talk, note ${s.noteId}) ` : '';
      const parts = s.segments?.length ? s.segments : [{ at: s.at, end: s.end, text: s.text || '_(transcribing…)_' }];
      return parts.map((p, i) => `\`${clock(session, p.at)}–${clock(session, p.end ?? p.at)}\` ${i === 0 ? prefix : ''}${p.text}`);
    }).flatMap(l => [l, '']),
  ].join('\n');
}

function near(note, event) {
  const d = Date.parse(note.at) - Date.parse(event.at);
  return d >= -2000 && d <= NEARBY_MS;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') && u.hostname !== '0.0.0.1' ? u.href : `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

const firstLine = s => (s ?? '').split('\n')[0].slice(0, 100);
const noteTitle = n => (n.transcribing ? '(transcribing…)' : firstLine(n.text) || '(no text)');
const oneLine = s => s.replace(/\s+/g, ' ').slice(0, 300);

/**
 * The prompt a coding agent gets. Four steps, each ending on a "done when"; step 3 is a hard stop, because the
 * tester decides what gets changed. Written with the writing-for-agents guidance: the plan's shape is fixed (one row
 * per note) so every run accounts for every note the same way.
 */
const folderLine = dir => (dir ? `- Session folder: \`${dir}\`. The files below are in it.` : '- Session folder: the folder this file is in.');

/** HANDOFF.md for a copy of the session somewhere else: it points at its own folder instead of the original. */
export const portableHandoff = (text, sessionDir) => text.replace(folderLine(sessionDir), folderLine());

function handoffPrompt(session, sessionDir, { speech }) {
  const { workspace, hints } = session.handoff ?? {};
  const build = buildLine(session.build);
  const sha = session.build?.sha && session.build.sha !== 'local' ? session.build.sha : undefined;
  const remarks = speech ? ' and spoken remark' : '';
  return `# QA session hand-off

A tester ran a manual QA session of **${session.target.name}** and left feedback for you to act on.
${workspace ? `Work in \`${workspace}\`.` : "If you aren't already in the repo that holds this app's code, ask the tester where it is."}

${folderLine(sessionDir)}
${build ? `- Build tested: ${build}\n` : ''}
## 1. Read

Read \`feedback.md\` and open every screenshot it links: the screenshots are part of the feedback. Each note lists
the steps the tester took before it. \`timeline.md\` has the whole session in order (clicks, typing, page changes,
browser tabs${speech ? ', what the tester said' : ''}, errors), and \`events.json\` the raw log.
${speech ? `
\`transcript.md\` has the tester's spoken commentary. Spoken remarks are feedback too, even where no note was saved.
Transcription can mishear words: when a remark doesn't make sense, mark it for the tester to clarify.
` : ''}
Logged errors are leads, not tasks. An error listed under a note may explain that note; errors elsewhere go in the
plan as possible bugs for the tester to judge (some come from the browser or the network, not the app).

**Done when** you can say, for every note${remarks}, what the tester saw and what they want.

## 2. Locate

For each note, find the code behind it: search for the target element's text, aria-label, placeholder or data
attributes, which are listed under the note.${sha ? ` Then \`git log --oneline ${sha}..HEAD -- <files>\` shows whether that code
changed since the tested build; mark notes that look already fixed.` : ''}

**Done when** every note has its files, or says the code wasn't found.

## 3. Triage, then stop

Present the plan to the tester as a table with one row per note${speech ? ' and per spoken remark that asks for something' : ''}, every
one of them. Notes about the same problem share a row.

| Note | What the tester wants | Size | Proposal | Files |
|---|---|---|---|---|

- **Keep**: a 👍 Like. The behaviour it praises stays as it is.
- **Small**: clear and contained (wording, styling, an obvious bug). Propose the fix; related small fixes share a
  branch.
- **Medium**: clear, but needs a design choice or touches several places. Propose the fix you would make.
- **Large**: risky or open-ended, or it touches data or sync code. Propose an issue, and draft it.
- **Unclear**: ask the question that would settle it.

Then stop. The tester approves, changes or drops each row before you edit anything.

## 4. Carry out

Do what the tester approved, and nothing more.

Show the tester every screenshot and every piece of session text before it goes into an issue, PR or commit message:
trackers are often public, and sessions hold real data. Commit, push and open PRs when the tester says so.
${hints ? `\n## About this project\n\n${hints.trim()}\n` : ''}`;
}

function describeEvent(e) {
  const what = e.text && e.url ? `${e.text} (${e.url})` : e.text ?? `${e.status ?? ''} ${e.url ?? ''}`;
  return oneLine(what);
}
