import fs from 'node:fs/promises';
import path from 'node:path';

const KIND_LABEL = { bug: '🐛 Bug', dislike: '👎 Dislike', idea: '💡 Idea', like: '👍 Like' };
const ERROR_TYPES = new Set(['console.error', 'pageerror', 'requestfailed', 'http']);
const NEARBY_MS = 60_000;

/** Rewrites the whole session folder; called after every note so a crash loses nothing. */
export async function writeBundle({ sessionDir, session, notes, events }) {
  await fs.writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({ ...session, notes: notes.length }, null, 2));
  await fs.writeFile(path.join(sessionDir, 'notes.json'), JSON.stringify(notes, null, 2));
  await fs.writeFile(path.join(sessionDir, 'events.json'), JSON.stringify(events, null, 2));
  await fs.writeFile(path.join(sessionDir, 'feedback.md'), feedbackMarkdown(session, notes, events));
  await fs.writeFile(path.join(sessionDir, 'HANDOFF.md'), handoffPrompt(session, sessionDir));
}

function feedbackMarkdown(session, notes, events) {
  const errors = events.filter(e => ERROR_TYPES.has(e.type));
  const lines = [
    `# FW Lite QA session ${session.id}`,
    '',
    `- Build: ${session.target} from run [${session.run.databaseId}](${session.run.url}), commit \`${session.run.headSha}\` (${session.run.headBranch}: ${session.run.displayTitle})`,
    `- Started: ${session.startedAt}`,
    `- Data: ${session.openExample ? 'the built-in example project (Example-Project), fresh for this session' : 'a fresh, empty data folder'}`,
    `- Notes: ${notes.length} · errors logged: ${errors.length} (all events in events.json)`,
    '',
  ];
  if (!notes.length) lines.push('_No notes yet._', '');
  for (const n of notes) {
    lines.push(`## ${n.id}. ${KIND_LABEL[n.kind] ?? n.kind}: ${firstLine(n.text) || '(no text)'}`, '');
    lines.push(`At ${n.at} on \`${new URL(n.url).pathname}${new URL(n.url).search}\``, '');
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
    const at = Date.parse(n.at);
    const nearby = errors.filter(e => { const d = at - Date.parse(e.at); return d >= -2000 && d <= NEARBY_MS; });
    if (nearby.length) {
      lines.push(`Errors in the minute before this note:`, '');
      for (const e of nearby.slice(-5)) lines.push(`- \`${e.type}\` ${describeEvent(e)}`);
      lines.push('');
    }
  }
  const unattached = errors.filter(e => !notes.some(n => { const d = Date.parse(n.at) - Date.parse(e.at); return d >= -2000 && d <= NEARBY_MS; }));
  if (unattached.length) {
    lines.push('## Other errors during the session', '');
    for (const e of unattached.slice(0, 30)) lines.push(`- ${e.at} \`${e.type}\` ${describeEvent(e)}`);
    if (unattached.length > 30) lines.push(`- …and ${unattached.length - 30} more in events.json`);
    lines.push('');
  }
  return lines.join('\n');
}

const firstLine = s => (s ?? '').split('\n')[0].slice(0, 100);
const oneLine = s => s.replace(/\s+/g, ' ').slice(0, 300);

/** The prompt a coding agent gets. It decides with the tester how to split the work. */
function handoffPrompt(session, sessionDir) {
  const sha = session.run.headSha;
  return `# QA session handoff

You are picking up feedback from a manual QA session of FieldWorks Lite (repo \`${session.repo}\`).
Work in a checkout of that repo and follow its AGENTS.md files.

- Session folder: \`${sessionDir}\`
- Feedback: \`feedback.md\` in that folder (read the screenshots it links, they are part of the feedback)
- Build tested: commit \`${sha}\` (${session.target}, CI run ${session.run.url})

## Steps

1. Read \`feedback.md\` and every screenshot it links. \`events.json\` has the full error and navigation log if a note needs it.
2. For each note, find the code involved. The UI is \`frontend/viewer/src\` (Svelte); search for the target element's
   text, aria-label, placeholder or data attributes. Notes marked 👍 Like are things to keep; don't change those.
3. Check whether \`develop\` has moved on since the tested build:
   \`git fetch origin && git log --oneline ${sha.slice(0, 12)}..origin/develop -- <paths you found>\`.
   Say if a note looks already fixed.
4. Size each note and propose a plan to the tester before you change anything:
   - **Small and clear** (copy, styling, an obvious bug): fix it. Group related small fixes into one branch/PR.
   - **Medium**: propose the fix and ask before starting.
   - **Large, risky or unclear** (a design question, sync/data code, anything in 🔴 Critical areas): draft a GitHub
     issue instead, and show the draft to the tester before filing.
   - Ask the tester when a note is ambiguous rather than guessing what they meant.
5. Agree on the plan with the tester, then carry it out.

## Rules

- The issue tracker is public. The session used the example project, but still show the tester any screenshot or text
  before it goes into an issue or PR, and never include anything from real projects.
- Don't commit, push or open PRs without the tester's go-ahead (see the repo's AGENTS.md).
`;
}

function describeEvent(e) {
  const what = e.text ?? `${e.status ?? e.error ?? ''} ${e.url ?? ''}`;
  return oneLine(e.source ? `${what} (${e.source})` : what);
}
