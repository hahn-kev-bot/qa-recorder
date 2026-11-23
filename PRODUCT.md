# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two groups use the toolbar, and when their needs conflict the first one wins:

1. **Non-technical testers.** They know the app under test, not its code. They are using the app as they normally
   would and leave a note when something is wrong, odd or good. They may be unsure which tool to use or what happens
   next.
2. **Developers** testing their own builds, who are comfortable with hotkeys and technical wording.

The reader of a session is a coding agent (and the developer who hands it over), not the tester.

## Product Purpose

QA Recorder records a QA session of any app or website and hands the notes to a coding agent. The tester works in
the app under test; a toolbar injected into its pages takes notes, screenshots, design changes and voice. A session
succeeds when the agent can find the code for each note and propose a fix without asking the tester anything.

## Positioning

Nothing is built into the app under test. QA Recorder attaches over the Chrome DevTools protocol, so it works on any
website, WebView2 app, Electron app or saved page, and everything it records stays on the tester's computer.

## Operating Context

- The toolbar lives inside someone else's page. It shares the screen with an app it knows nothing about, which can be
  light or dark, and it must not change how that app behaves: an open menu stays open while a note is taken about it.
- A note is taken mid-task. The tester has just seen something and wants to get back to what they were doing.
- The desktop app (Electron) is where sessions start and where finished sessions are read, exported and handed off.
  It is a separate surface from the toolbar.

## Capabilities and Constraints

- **Toolbar tools:** Element (F8), Region (F9), Note (F7), Move and Resize (design changes, prototype), a microphone
  button in the voice modes (push-to-talk on F6, or open mic with mute), a saved-notes count, switching the toolbar's
  side, and Finish (pressed twice).
- **Note types:** bug, dislike, idea, like. A design change is its own note type with before and after screenshots.
- **The toolbar is a guest** (`src/core/overlay.js`): one plain script with no imports or assets, drawn in a shadow
  root, markup through the Trusted Types helper, every failure contained. It is hidden while a screenshot is taken.
- **Not yet possible from the toolbar:** seeing, editing or deleting a saved note.
- **Undecided:** whether Move and Resize stay; they are marked as a prototype.

## Product Principles

1. **Guide the tester.** The tools and the next step are obvious to someone who has never used it, even when that
   takes more room on screen.
2. **The page stays itself.** Whatever the toolbar does, the app under test looks and behaves as it would without it,
   and the toolbar stays out of its own screenshots.
3. **Write for the agent, speak to the tester.** What is recorded serves the coding agent; what is shown uses the
   tester's words, not the code's.
4. **Nothing is lost.** A note is kept the moment it is saved, and an unconfirmed change can always be undone.

## Accessibility & Inclusion

The toolbar must stay legible on both light and dark apps, since it cannot know which it will sit on.
