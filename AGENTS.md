# Agent instructions

Read [DEVELOPER.md](DEVELOPER.md) before changing code: it has the code layout, the test commands and which smoke
test covers what, packaging, and releasing.

## Rules

- **Public repo.** Fixtures, screenshots, test data and commit messages use made-up content (the demo shop, the
  fixture site). Session folders hold real testers' data: quote from them only into private replies, never into
  commits, issues or PRs.
- **App-agnostic core.** Behaviour for one app goes in its target (`configs/*.json`). When the target format changes,
  update `schema/target.schema.json`, `AUTHORING.md` and the README's target table in the same change.
- **Tests.** Run `npm test` and the smoke test for the area you touched before handing back. Smoke tests open real
  windows on the user's desktop and each makes its own temporary data folder; point every test at a temporary
  `QA_RECORDER_HOME`, so the user's sessions stay untouched.
- **Screenshots.** When the toolbar or the session page looks different, rerun `node scripts/readme-screenshots.mjs`
  and check the images before committing them.
- **Packaging.** The installed app runs from `resources/app` with the files listed in `build.files` in
  `package.json`. A new file the app reads at runtime goes in that list; after changing dependencies or file paths,
  run the GUI smoke test against `npm run dist`'s output (see DEVELOPER.md).

## The toolbar (`src/core/overlay.js`)

It runs inside every page of the app under test, so it is a guest: a plain script with no imports, markup set through
the `html()` Trusted Types helper, and every failure contained inside it. The page must keep working exactly as it
would without it.

## Gotchas

- Launching Electron: remove `ELECTRON_RUN_AS_NODE` from the environment (editors set it for their terminals), and
  pass paths without a trailing backslash (on Windows it escapes the closing quote).
- Shell heredocs here can halve backslashes in Windows paths (`\t` becomes a tab). Build paths with `path.join`, or
  write the file with an editor tool.
- FW Lite's isolation settings (`FwLiteMaui:BaseDataDir`, `FwDataBridge:ProjectsFolder`, `Analytics:Enabled`,
  `FwLite:UpdateCheckCondition`, `LcmCrdt:ProjectPath`) are defined in the LexBox repo; check there before adding
  one.
