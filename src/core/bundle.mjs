import fs from 'node:fs/promises';
import path from 'node:path';

const KIND_LABEL = { bug: '🐛 Bug', dislike: '👎 Dislike', idea: '💡 Idea', like: '👍 Like' };
export const ERROR_TYPES = new Set(['console.error', 'pageerror', 'requestfailed', 'http']);
const NEARBY_MS = 60_000;

/** Rewrites the whole session folder; called after every note so a crash loses nothing. */
export async function writeBundle({ sessionDir, session, notes, events }) {
  const errors = events.filter(e => ERROR_TYPES.has(e.type)).length;
  const summary = { ...session, notes: notes.length, kinds: countKinds(notes), errors };
  await fs.writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(sessionDir, 'notes.json'), JSON.stringify(notes, null, 2));
  await fs.writeFile(path.join(sessionDir, 'events.json'), JSON.stringify(events, null, 2));
  await fs.writeFile(path.join(sessionDir, 'feedback.md'), feedbackMarkdown(session, notes, events));
  await fs.writeFile(path.join(sessionDir, 'HANDOFF.md'), handoffPrompt(session, sessionDir));
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
  for (const n of notes) {
    lines.push(`## ${n.id}. ${KIND_LABEL[n.kind] ?? n.kind}: ${firstLine(n.text) || '(no text)'}`, '');
    lines.push(`At ${n.at} on \`${shortUrl(n.url)}\``, '');
    if (n.text && n.text.includes('\n')) lines.push(n.text.split('\n').map(l => `> ${l}`).join('\n'), '');
    if (n.screenshots.crop) lines.push(`![note ${n.id}](${n.screenshots.crop})`, '');
    lines.push(`Full window: [${n.screenshots.full}](${n.screenshots.full})`, '');
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
const oneLine = s => s.replace(/\s+/g, ' ').slice(0, 300);

/** The prompt a coding agent gets. It decides with the tester how to split the work. */
function handoffPrompt(session, sessionDir) {
  const { workspace, hints } = session.handoff ?? {};
  const build = buildLine(session.build);
  return `# QA session handoff

You are picking up feedback from a manual QA session of **${session.target.name}**.
${workspace ? `Work in \`${workspace}\` and follow its AGENTS.md / CLAUDE.md files if it has them.` : 'Ask the tester which repo or folder holds the code if you are not already in it.'}

- Session folder: \`${sessionDir}\`
- Feedback: \`feedback.md\` in that folder (read the screenshots it links, they are part of the feedback)
${build ? `- Build tested: ${build}\n` : ''}
## Steps

1. Read \`feedback.md\` and every screenshot it links. \`events.json\` has the full error and navigation log if a note needs it.
2. For each note, find the code involved: search for the target element's text, aria-label, placeholder or data
   attributes. Notes marked 👍 Like are things to keep; don't change those.
3. Check whether the code has changed since the build that was tested, and say if a note looks already fixed.
4. Size each note and propose a plan to the tester before you change anything:
   - **Small and clear** (copy, styling, an obvious bug): fix it. Group related small fixes into one branch/PR.
   - **Medium**: propose the fix and ask before starting.
   - **Large, risky or unclear** (a design question, data or sync code): draft an issue instead, and show the draft to
     the tester before filing.
   - Ask the tester when a note is ambiguous rather than guessing what they meant.
5. Agree on the plan with the tester, then carry it out.
${hints ? `\n## About this project\n\n${hints.trim()}\n` : ''}
## Rules

- Issue trackers are often public. Show the tester any screenshot or text before it goes into an issue or PR.
- Don't commit, push or open PRs without the tester's go-ahead.
`;
}

function describeEvent(e) {
  const what = e.text && e.url ? `${e.text} (${e.url})` : e.text ?? `${e.status ?? ''} ${e.url ?? ''}`;
  return oneLine(what);
}
