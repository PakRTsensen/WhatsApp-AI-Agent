# WhatsApp-AI-Agent (Noppo)

A personal WhatsApp assistant and group-control bot. The WhatsApp layer runs on
[Baileys](https://github.com/itsliaaa/baileys); the agent runtime is
[OpenCode](https://opencode.ai). There is no Hermes dependency.

Noppo can inspect the host, edit files, run tests, control groups, search the
message cache, and archive or resend media. The owner talks to it in a private
chat or by mentioning it in a group.

## Architecture

```text
WhatsApp (Baileys)
   │
   ├── plugins/                  command + group plugins (hot reload)
   ├── lib/noppo_*.js            routing, sessions, context, delivery, vision
   ├── lib/noppo_opencode.js     spawns: opencode run --format json
   │        │
   │        └── OpenCode agent (.opencode/agents/noppo.md)
   │                 │
   │                 └── MCP: wa_control (Python, stdio)
   │                          │
   │                          └── HTTP control API 127.0.0.1:5685
   └── control/settings.js       env-driven owner/bot identity
```

- OpenCode owns the model, tools, and agent loop.
- `wa_control` calls the bot's local control API, so it never opens a second
  WhatsApp session.
- Plugins under `plugins/` are reloaded automatically when changed.

## Requirements

| Component | Version |
|---|---|
| Node.js | >= 20 |
| npm | >= 10 |
| Python | >= 3.10 |
| OpenCode CLI | >= 2.3 |
| PM2 | optional, for a background daemon |
| WhatsApp | a number you can link |

The OpenCode CLI must already have a provider configured that exposes the models
listed in `lib/noppo_config.js`. On this machine the provider is `9router`
(`http://127.0.0.1:20128/v1`).

## Quick install

```bash
git clone https://github.com/glarceny/WhatsApp-AI-Agent.git /opt/WhatsApp-AI-Agent
cd /opt/WhatsApp-AI-Agent

BOT_OWNER_NUMBERS=628xxxxxxxxxx \
PAIRING_NUMBER=628xxxxxxxxxx \
scripts/install.sh
```

The installer:

1. checks Node, Python, and OpenCode;
2. runs `npm install` (the repo `.npmrc` allows the required git dependency);
3. creates `mcp/.venv` and installs the Python MCP SDK;
4. writes `control/noppo.env` with mode `0600` (it reuses the local 9router
   URL/key from `~/.config/opencode/opencode.json` when available);
5. runs `npm test`.

Then start it:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs noppo-agent --nostream
```

On the first run you can pair either way:

- **Pairing code**: set `PAIRING_NUMBER`; the log prints a code to enter in
  WhatsApp → Linked devices → Link a device.
- **QR code**: leave `PAIRING_NUMBER` empty; the bot prints a QR in the log and
  writes a clean copy to `logs/wa-qr.txt` (refreshed automatically). Scan it
  with WhatsApp → Linked devices.

Once linked, the bot reconnects on its own after restarts.

### Non-interactive install

Every value can be supplied through the environment:

```bash
BOT_OWNER_NUMBERS=628111,628222 \
BOT_NUMBER=628111 \
PAIRING_NUMBER=628111 \
NOPPO_ROUTER_URL=http://127.0.0.1:20128/v1 \
NOPPO_ROUTER_API_KEY=... \
NOPPO_OPENCODE_BINARY=/usr/local/bin/opencode \
scripts/install.sh
```

Set `NOPPO_FORCE_ENV=1` to rewrite an existing `control/noppo.env`.

## Manual install

```bash
npm install

python3 -m venv mcp/.venv
mcp/.venv/bin/pip install -r mcp/requirements.txt

cp control/noppo.env.example control/noppo.env
chmod 600 control/noppo.env
# edit control/noppo.env

npm test
node index.js
```

`control/noppo.env` is loaded automatically by `lib/load_env.js`; variables
already present in the real environment win over the file.

## Configuration

| Variable | Purpose |
|---|---|
| `BOT_OWNER_NUMBERS` | Comma-separated owner numbers (digits only) |
| `BOT_NUMBER` | Bot's own number, used for identity checks |
| `PAIRING_NUMBER` | Optional; number that receives the pairing code. Empty = QR mode |
| `NOPPO_OPENCODE_BINARY` | Path to `opencode` |
| `NOPPO_ENGINE_PROVIDER` | OpenCode provider ID, default `9router` |
| `NOPPO_AGENT` | OpenCode agent name, default `noppo` |
| `NOPPO_WORKDIR` | Working directory for agent turns, default repo root |
| `NOPPO_ROUTER_URL` | OpenAI-compatible base URL used for image analysis |
| `NOPPO_ROUTER_API_KEY` | Key for that router |
| `WA_STT_PYTHON` | Optional Python with `faster_whisper` for voice notes |
| `WA_CONTROL_PORT` | Control API port, default `5685` |

The control API token is generated on first start at
`control/control_token` (mode `0600`). Do not commit it.

## Models

Models are registered in `lib/noppo_config.js`. Each entry has:

- `id` — the name shown to the owner (`/noppo listmodel`);
- `engineModel` — the model ID inside the OpenCode provider;
- `contextWindow`, `maxInputTokens`, `maxOutputTokens`;
- `supportsImage`.

`getEngineModel()` prefixes the provider from `NOPPO_ENGINE_PROVIDER`, so
`ca/deepseek-v4-1-flash-1017` becomes
`9router/ca/deepseek-v4-1-flash-1017#max` for `opencode run --model`, selecting
DeepSeek's maximum reasoning-effort variant by default.

Defaults on this machine:

| Shown name | Engine model | Context | Vision |
|---|---|---|---|
| DeepSeek V4.1 Flash 1017 (default) | `9router/ca/deepseek-v4-1-flash-1017#max` | 1,000,000 | no |
| GPT Luna 6 1M | `9router/ca/gpt-6-luna` | 1,050,000 | yes |
| HY4 Flash Free 1M | `9router/ca/hy4` | 200,000 | no |

The default model is text-only. To analyse images, switch to a vision model and
enable it for image analysis:

```text
/noppo modelimage cx/gpt-6-luna[1m] on
/noppo selectmodel cx/gpt-6-luna[1m]
```

To use another OpenCode provider, register it in OpenCode's config and set
`NOPPO_ENGINE_PROVIDER` in `control/noppo.env`.

## OpenCode integration

- `opencode.json` registers the local `wa_control` MCP server
  (`codemode: false`, so tools are called directly).
- `.opencode/agents/noppo.md` is the agent persona and operating policy.
- `mcp/run-wa-control.sh` starts the MCP server with `mcp/.venv/bin/python`.
- `AGENTS.md` contains repository-level instructions for coding agents.

Each Noppo session stores the OpenCode session ID (`engineSessionId`). Follow-up
messages resume it with `opencode run --session ...`. `/noppo stop` calls the
OpenCode interrupt API, then falls back to `SIGTERM`/`SIGKILL`.

## Using Noppo

Owner triggers:

- private chat: any message once Noppo is ON;
- group: mention the bot, reply to a bot message, or start with `noppo`.

Commands:

```text
/noppo on | off | status
/noppo stop | kill
/noppo new
/noppo resume <session_id>
/noppo selectmodel <ID|number>
/noppo modeldefault <ID|number>
/noppo modeluniversal <ID|number>
/noppo modelimage <number|ID> on|off
/noppo listsesi
/noppo listmodel
```

Sessions are created automatically on the first owner mention; `/noppo new` is
not required.

## WhatsApp MCP tools

`wa_control` exposes the bot's own control API. Common tools:

- `wa_control_health` — control API and socket health;
- `wa_group_list`, `wa_group_info`, `wa_group_members`;
- `wa_group_setting`, `wa_group_schedule`, `wa_group_schedule_status`;
- `wa_group_members_action` (kick/add/promote/demote), `wa_group_invite`,
  `wa_group_rename`, `wa_group_description`, `wa_group_join_requests`,
  `wa_group_join`, `wa_group_leave`;
- `wa_message_recent`, `wa_message_get`, `wa_message_search`,
  `wa_message_thread`, `wa_message_fetch`, `wa_message_delete_own`;
- `wa_media_save`, `wa_media_list`, `wa_media_get`, `wa_media_tag`,
  `wa_media_send`, `wa_media_delete`, `wa_media_stats`;
- `wa_antiforward_status`, `wa_antiforward_exempt`.

Write actions change real group state. The agent is instructed to verify
`botIsAdmin` first and to re-read state after the action. `wa_group_leave`
requires `confirm=true`.

Verify MCP registration:

```bash
opencode mcp list
```

While the bot is stopped, `wa_control_health` returns a connection-refused
error. That is expected; start the bot and call it again.

## Tests

```bash
npm test
```

The suite uses a fake OpenCode binary, so it does not call a model or WhatsApp.
It covers routing, sessions, streaming delivery, tool events, image context,
media archive, and the control API.

## Operations

```bash
pm2 start ecosystem.config.js
pm2 restart noppo-agent
pm2 logs noppo-agent --nostream --lines 100
pm2 stop noppo-agent
```

Logs are written to `logs/noppo.out.log` and `logs/noppo.err.log`.

### Re-pair WhatsApp

```bash
pm2 stop noppo-agent
rm -rf session/
pm2 start ecosystem.config.js
pm2 logs noppo-agent --nostream
```

### Common failures

| Symptom | Fix |
|---|---|
| `OpenCode CLI tidak ditemukan` | Set `NOPPO_OPENCODE_BINARY` to the real path |
| `Model unavailable` | The provider/model is not configured in OpenCode; check `opencode models` |
| `wa_control` connection refused | Start the bot; the control API only exists inside it |
| Pairing code never appears | Set `PAIRING_NUMBER`, or leave it empty and scan `logs/wa-qr.txt`; remove `session/` and restart |
| `npm install` blocks a git dependency | Keep the repo `.npmrc` (`allow-git=all`) |
| Image analysis says the model is unsupported | Enable a vision model with `/noppo modelimage` |

## Security notes

- `control/noppo.env` and `control/control_token` are mode `0600` and ignored by
  git.
- The control API binds to `127.0.0.1` only. Never expose it publicly.
- The agent is instructed not to send documents to groups unless the owner
  explicitly asks for that group.
- Do not restart the bot's own PM2 process from inside an agent turn; it kills
  the WhatsApp socket and the turn itself.

## Known limitation

OpenCode's CLI JSON stream emits complete text/tool parts, not token deltas.
WhatsApp live edits therefore update once per model step instead of per token.
Tool progress still appears live, and the final answer is unchanged. Token-level
streaming would require OpenCode's HTTP/SSE API instead of `opencode run`.

## License

MIT. See the repository for credits and upstream licenses.
