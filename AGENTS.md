# Noppo WhatsApp Bot

This repository runs the Noppo WhatsApp assistant on OpenCode.

- `npm test` runs the Node test suite.
- Plugins in `plugins/` hot-reload; no restart is needed.
- The agent runtime is `lib/noppo_opencode.js`; it spawns `opencode run`.
- DeepSeek V4.1 Flash defaults to OpenCode's `#max` reasoning variant (maximum reasoning effort).
- MCP `wa_control` is registered in `opencode.json`.
- Never commit `control/noppo.env`, `control/control_token`, or `session/`.
- Do not restart the PM2 process from inside an agent turn.
