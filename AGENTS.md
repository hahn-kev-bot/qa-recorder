# Agent notes

- Plain ESM JavaScript, no build step. `src/overlay.js` runs inside the app page (no imports); everything else runs in Node.
- `npm run smoke` is the real test (Windows, ~1 min with a cached build). Run it after changing the harness or overlay.
- The tool must never touch the tester's real FW Lite or FieldWorks data: every launch goes through `isolationSettings` in `src/launch.mjs`.
- FW Lite config keys come from the LexBox repo (`FwLiteMaui:BaseDataDir`, `LcmCrdt:ProjectPath`, `FwDataBridge:ProjectsFolder`, `Analytics:Enabled`, `FwLite:UpdateCheckCondition`). Check them there before adding new ones.
- The session folder ends up in front of an agent that may post to a public tracker; keep real project data out of it.
