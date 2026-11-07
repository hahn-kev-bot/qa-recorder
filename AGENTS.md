# Agent notes

- Plain JavaScript, no build step. `src/core/` is the engine (Node), `src/cli.mjs` and `src/gui/` (Electron) sit on
  top of it. `src/core/overlay.js` runs inside the page under test (no imports). The renderer (`src/gui/renderer/`) is
  a classic script with no Node access; it reaches the core only through the IPC handlers in `src/gui/main.mjs`.
- The core knows nothing about any particular app. App specifics go in a target config (`configs/*.json`), validated
  by `schema/target.schema.json`. Change the schema, `AUTHORING.md` and the README's target table together.
- Tests: `npm test` (unit), then the smoke test for what you touched: `smoke:url` (core and overlay), `smoke:gui`
  (the app), `smoke:fwlite` (Windows, real FW Lite build). The smokes open real windows on the desktop.
- Launching Electron: strip `ELECTRON_RUN_AS_NODE` (editors set it for their terminals) and never pass a path with a
  trailing backslash on Windows (it escapes the closing quote).
- Targets must keep tests away from real data. FW Lite's isolation keys (`FwLiteMaui:BaseDataDir`,
  `FwDataBridge:ProjectsFolder`, `Analytics:Enabled`, `FwLite:UpdateCheckCondition`, `LcmCrdt:ProjectPath`) come from
  the LexBox repo; check there before adding new ones.
- Session folders end up in front of an agent that may post to a public tracker; keep real project data out of them.
