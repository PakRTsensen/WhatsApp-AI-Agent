# Llama Agent Bot (Noppo Assistant)

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WhatsApp Engine](https://img.shields.io/badge/Baileys-MultiFileAuth-orange.svg)](https://github.com/itsliaaa/baileys)
[![Agent Runtime](https://img.shields.io/badge/Hermes_Agent-Nous_Research-purple.svg)](https://github.com/NousResearch/Hermes-Agent)
[![Test Suites](https://img.shields.io/badge/Tests-13%20Passing-success.svg)](test/)

An enterprise-grade, autonomous AI WhatsApp Agent and bot framework built on Node.js, [Baileys](https://github.com/itsliaaa/baileys), and [Hermes Agent CLI](https://github.com/NousResearch/Hermes-Agent). Features native multi-model LLM execution loops, streaming response edits, visual comprehension (multimodal vision), Model Context Protocol (MCP) tool integration, hot-reloading plugin architecture, and automated WhatsApp group moderation.

---

## Table of Contents

- [Overview & Architecture](#overview--architecture)
- [Key Features](#key-features)
- [System Requirements](#system-requirements)
- [Full Installation & Setup Guide](#full-installation--setup-guide)
  - [1. Server Preparation](#1-server-preparation)
  - [2. Clone & Install Dependencies](#2-clone--install-dependencies)
  - [3. Install & Setup Hermes Agent](#3-install--setup-hermes-agent)
  - [4. Configure Environment & Settings](#4-configure-environment--settings)
  - [5. Link WhatsApp via Pairing Code](#5-link-whatsapp-via-pairing-code)
  - [6. Configure MCP Toolsets](#6-configure-mcp-toolsets)
  - [7. Production Daemon (PM2)](#7-production-daemon-pm2)
- [Noppo Assistant (AI Agent Engine)](#noppo-assistant-ai-agent-engine)
- [Command Reference](#command-reference)
- [Plugin Architecture](#plugin-architecture)
- [Control API & Outbound Bridge](#control-api--outbound-bridge)
- [Directory Structure](#directory-structure)
- [Verification & Testing](#verification--testing)
- [Security & Operational Best Practices](#security--operational-best-practices)
- [License & Authors](#license--authors)

---

## Overview & Architecture

Llama Agent Bot bridges instant messaging and autonomous developer-agent execution. Unlike traditional chatbot wrappers that respond with static completions, this bot uses a decoupled dual-engine architecture:

1. **WhatsApp Messaging Gateway (`index.js`, `stenly.js`)**:
   - Manages WebSocket connections to WhatsApp Web servers using Baileys.
   - Normalizes incoming message formats (text, ephemeral messages, view-once media, voice notes, stickers, forwarded channels, reactions, polls).
   - In-memory 30-minute rolling cache (`lib/message_cache.js`) for context retrieval without writing chat content to disk.
   - Dispatches user queries to hot-reloaded plugins or routes AI prompts to the Noppo engine.

2. **Autonomous AI Execution Engine (`lib/noppo_hermes.js`, `lib/noppo_commands.js`)**:
   - Spawns background worker processes using `hermes chat --format stream-json`.
   - Intercepts JSONL stream chunks (token deltas, tool executions, results) and progressively streams them back to WhatsApp by editing a single message in real time.
   - Integrates with Model Context Protocol (MCP) servers (local command execution, web inspection, OSINT, network reconnaissance, and WhatsApp automation).
   - Governed by custom personas and operational guidelines defined in `SOUL.md`.

```
                  ┌──────────────────────────────────────────────┐
                  │                 WhatsApp App                 │
                  └──────────────────────┬───────────────────────┘
                                         │ WebSocket (Baileys)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           WhatsApp Gateway Layer                                │
│                                                                                 │
│   ┌────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐  │
│   │ Message Normalizer │──▶│   In-Memory Cache   │──▶│ Hot-Reload Plugins   │  │
│   │      (smsg)        │   │ (30-min rolling)    │   │ (plugins/**/*.js)    │  │
│   └────────────────────┘   └─────────────────────┘   └──────────┬───────────┘  │
│                                                                 │              │
│                                                                 ▼              │
│                                                      ┌──────────────────────┐  │
│                                                      │  Noppo Router & Queue│  │
│                                                      └──────────┬───────────┘  │
└─────────────────────────────────────────────────────────────────┼───────────────┘
                                                                  │ spawn CLI
                                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       Hermes Autonomous Agent Engine                            │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │               Model Router / 9Router (OpenAI-compatible)                │   │
│   │         [GPT Luna 6 1M]       [DeepSeek V4.1 Flash]       [...]         │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │                                        │
│   ┌────────────────────────────────────▼────────────────────────────────────┐   │
│   │                     Model Context Protocol (MCP) Tools                  │   │
│   │   • wa_control       • chrome-devtools      • hexstrike-server          │   │
│   │   • openosint        • osint-tools          • xposedornot               │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

- **Live WhatsApp Streaming**: Edits a single message every 900ms as tokens generate, avoiding message spam while providing real-time feedback.
- **Multimodal Image Comprehension**: Extracts attached or replied images, validates MIME types, saves to secure temporary storage, and submits them to vision models.
- **Pairing Code Authentication**: Connect without scanning QR codes. Connect directly using an 8-character pairing code (custom code `STENLYCL` supported).
- **Zero-Disk Chat Retention**: Sensitive conversation history and rolling threads remain purely in-memory (`globalThis.__waStore` and `lib/message_cache.js`).
- **Hot-Reloading Plugin System**: Any `.js` script inside `plugins/` automatically reloads on save within 100ms without restarting the process.
- **Comprehensive Group Moderation**:
  - `antilink`: Detects and removes invite links with configurable auto-kick and message deletion.
  - `antiforward`: Blocks unwanted broadcast/channel forward spam with admin exemptions.
  - `closegroup`: Schedule-based automated group opening and closing.
- **Built-in Outbound HTTP Bridge (`:5680`) & Control API (`:5685`)**: Enables local scripts and MCP tools to send messages, manage groups, and dispatch documents safely to the owner.

---

## System Requirements

### Hardware
| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 vCPU cores | 4 vCPU cores |
| **RAM** | 2 GB | 4 GB - 8 GB (required if using Headless Chrome or Hexstrike) |
| **Disk** | 10 GB SSD | 25 GB NVMe SSD |
| **Network** | 10 Mbps public connection | 100 Mbps+ low-latency connection |

### Operating System & Software
- **Operating System**: Linux (Ubuntu 20.04 LTS, Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 11/12).
- **Node.js**: Version `>= 18.18.0` (Node.js 20 LTS or 22 LTS recommended).
- **Python**: Version `>= 3.10` (Python 3.12 recommended for MCP toolsets).
- **Process Manager**: PM2 (`npm install -g pm2`).
- **Agent CLI**: Hermes Agent CLI (`hermes`) installed in PATH (`/usr/bin/hermes` or `/usr/local/bin/hermes`).

---

## Full Installation & Setup Guide

### 1. Server Preparation

Update package lists and install required build tools and libraries:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential ffmpeg libvips-dev jq python3 python3-pip python3-venv
```

Install Node.js (v22 LTS recommended):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Verify installation:

```bash
node -v   # Output: v22.x.x
npm -v    # Output: 10.x.x
pm2 -v    # Output: 5.x.x
```

---

### 2. Clone & Install Dependencies

Clone this repository and install the production dependencies:

```bash
git clone https://github.com/glarceny/LlamaAgentHermes.git /LlamaAgentHermes
cd /LlamaAgentHermes
npm install
```

---

### 3. Install & Setup Hermes Agent

Install Hermes Agent CLI globally:

```bash
curl -fsSL https://hermes.nousresearch.com/install.sh | bash
```

Verify `hermes` is accessible in your environment:

```bash
hermes --version
```

Synchronize the agent persona and environment rules:

```bash
mkdir -p /root/.hermes
cp /LlamaAgentHermes/Hermes-kit/SOUL.md /root/.hermes/SOUL.md
```

Create the credentials file `/root/.hermes/noppo.env` for API routing:

```bash
cat << 'EOF' > /root/.hermes/noppo.env
NOPPO_ROUTER_API_KEY=your_api_key_here
EOF
chmod 600 /root/.hermes/noppo.env
```

---

### 4. Configure Environment & Settings

#### Owner & Bot Settings
Edit `control/settings.js` to configure your owner numbers and bot identity:

```javascript
global.namaown = "Your Name";
global.prefix = "/";
global.botname = "Noppo Assistant";
global.botversion = "v1.0";
global.owner = ["6285199430173", "6285881325696"]; // Add owner numbers in international format without '+'
```

#### Model Router Configuration
Edit `lib/noppo_config.js` to define your available models and router URL:

```javascript
module.exports = {
    provider: {
        baseUrl: process.env.NOPPO_ROUTER_URL || 'https://9router.stenly.id/v1',
        apiKeyEnv: 'NOPPO_ROUTER_API_KEY',
        credentialsFile: '/root/.hermes/noppo.env'
    },
    models: [
        { id: 'cx/gpt-6-luna[1m]', name: 'GPT Luna 6 (1M Context)', provider: 'openai', supportsVision: true },
        { id: 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash', provider: 'openai', supportsVision: true }
    ],
    defaultModelId: 'cx/gpt-6-luna[1m]'
};
```

---

### 5. Link WhatsApp via Pairing Code

Start the bot interactively in your terminal for initial pairing:

```bash
PAIRING_NUMBER=6283167054726 node index.js
```

You will see:

```text
Meminta pairing code untuk nomor: 6283167054726...
=================================
PAIRING CODE:  STENLYCL 
=================================
Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat > masukkan kode di atas.
```

1. Open **WhatsApp** on your phone.
2. Tap **Settings** (or three dots) > **Linked Devices**.
3. Select **Link a Device** > **Link with phone number instead**.
4. Enter the code shown in your console (`STENLYCL` or auto-generated 8-digit code).
5. Once connected, stop the process with `Ctrl+C`.

---

### 6. Configure MCP Toolsets

To allow Hermes Agent to interact with WhatsApp and system utilities, register the `wa_control` MCP server in `/root/.hermes/config.yaml`:

```yaml
mcp_servers:
  wa_control:
    command: "/usr/bin/python3"
    args:
      - "/LlamaAgentHermes/mcp/wa_control_server.py"
```

Verify that the MCP server responds correctly:

```bash
python3 /LlamaAgentHermes/mcp/smoke_test.py
```

---

### 7. Production Daemon (PM2)

Start the bot in the background using PM2:

```bash
pm2 start index.js --name llama-hermes
pm2 save
pm2 startup
```

Useful management commands:

```bash
# View live status
pm2 status

# View non-streaming logs
pm2 logs llama-hermes --nostream --lines 50

# Restart bot process
pm2 restart llama-hermes

# Stop bot process
pm2 stop llama-hermes
```

---

## Noppo Assistant (AI Agent Engine)

### Triggering the Agent
- **Direct Mention**: Mention `@bot` in any group where the bot is a member:
  ```text
  @bot Analyze this repository structure and give me a summary.
  ```
- **Explicit Command**:
  ```text
  /noppo What are the open security vulnerabilities on this host?
  ```
- **Quoted Messages**: Reply to any message (text or image) and mention `@bot` to use the quoted message as context.

### Session & Model Controls
- `/noppo new`: Reset the conversation context and start a clean session.
- `/noppo model <index|id>`: Switch the active model for the current chat session.
- `/noppo models`: Display all registered models with their vision and context specifications.
- `/noppo status`: Show active execution state, runtime token usage, and session IDs.
- `/noppo stop`: Safely cancel the currently executing turn.

---

## Command Reference

| Command | Permission | Description |
|---|---|---|
| `/menu` | Public | Displays all available commands grouped by category. |
| `/noppo <prompt>` | Public / Owner | Dispatches a task to the Hermes autonomous AI engine. |
| `/noppo new` | Public / Owner | Clears conversation memory and creates a fresh agent session. |
| `/noppo model` | Public / Owner | Switches the active language model for the current chat. |
| `/antilink on\|off` | Group Admin | Automatically deletes invite links and warns/kicks violators. |
| `/antiforward on\|off` | Group Admin | Deletes messages forwarded from WhatsApp Channels/Newsletters. |
| `/closegroup <time>` | Group Admin | Closes group chat permissions according to a set schedule. |
| `/exec <command>` | Creator | Executes arbitrary bash commands directly on the host VPS. |
| `/addown <number>` | Creator | Adds a new user number to the owner authorization list. |
| `/modebot <mode>` | Creator | Toggles bot mode: `public`, `self` (private only), or `self2` (silent). |
| `/uptime` | Public | Shows host uptime, memory usage, and process statistics. |
| `/hd` | Public | Enhances image resolution using media processing tools. |

---

## Plugin Architecture

All custom features live in `plugins/**/*.js`. Every plugin exports metadata, permissions, and handler functions:

```javascript
module.exports = {
    name: 'ping',
    command: ['ping', 'p'],
    category: 'main',
    description: 'Check bot responsiveness',
    owner: false,
    group: false,
    admin: false,
    run: async (context) => {
        const { m } = context;
        const latency = Date.now() - m.messageTimestamp * 1000;
        await m.reply(`Pong! Latency: ${latency}ms`);
    }
};
```

### Hot Reloading
The runtime continuously watches `plugins/`. When you create, modify, or remove any file inside `plugins/`, the bot detects changes and reloads the modules in **under 100ms** without dropping WebSocket connections.

---

## Control API & Outbound Bridge

### Internal Control API (`http://127.0.0.1:5685`)
Used by internal scripts and MCP tools:
- `GET /health`: Health status and WebSocket connectivity check.
- `GET /groups`: Lists all joined groups, participant counts, and admin statuses.
- `POST /group/action`: Executes group management actions (`leave`, `invite`, `members`, `rename`, `setting`).
- `POST /send-document`: Dispatches generated files and documents directly to the owner's private chat.

### Media Outbound Bridge (`http://0.0.0.0:5680`)
Exposes HTTP endpoints for external tools to dispatch media, images, and text payloads directly to WhatsApp recipients using authenticated API tokens.

---

## Directory Structure

```text
/LlamaAgentHermes
├── control/                     # Bot global configurations and tokens
│   ├── settings.js              # Owner numbers, prefix, bot identity
│   └── control_token            # Ephemeral token for internal control API
├── hermes_plugins/              # Python plugins integrated into Hermes
├── Hermes-kit/                  # Standalone bundle of agent SOUL.md & instructions
│   └── SOUL.md                  # Operating system prompt for Hermes Agent
├── lib/                         # Core libraries and business logic
│   ├── antiforward_store.js     # Storage for channel forwarding exemptions
│   ├── group_control_api.js     # Fastify/HTTP internal control API server
│   ├── media_store.js           # Deduplicated SHA-256 media storage engine
│   ├── message_cache.js         # In-memory rolling message buffer
│   ├── noppo_commands.js        # Command handler & streaming dispatcher
│   ├── noppo_config.js          # Model configurations & provider endpoints
│   ├── noppo_context.js         # Prompt builder & quoted message assembler
│   ├── noppo_delivery.js        # WhatsApp streaming edit serializer
│   ├── noppo_hermes.js          # Hermes process spawner & stream-json parser
│   └── noppo_sessions.js        # Session persistence and model binding
├── mcp/                         # Model Context Protocol servers
│   ├── smoke_test.py            # Automated MCP server health check
│   └── wa_control_server.py     # Python FastMCP server for WhatsApp actions
├── plugins/                     # Hot-reloading user plugins
│   ├── grup/                    # Group moderation (antilink, antiforward, etc.)
│   ├── main/                    # General commands (menu, owner, info)
│   ├── owner/                   # Admin tools (exec, addown, modebot)
│   └── tools/                   # Utility tools (media cache, crm, upscale)
├── test/                        # Node.js native test suites (13 suites)
├── index.js                     # Main application entry point
├── package.json                 # Project dependencies and metadata
└── stenly.js                    # Message router & event distributor
```

---

## Verification & Testing

The project includes 13 test suites testing Baileys protocol normalization, message cache retention, thread reconstruction, anti-forward rules, and Hermes JSONL streaming.

Run the test suite:

```bash
node --test test/*.test.js
```

Expected output:

```text
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

---

## Security & Operational Best Practices

1. **Keep Tokens & Sessions Private**: Never commit `session/`, `noppo.env`, or `control/control_token` to version control. The included `.gitignore` protects these automatically.
2. **Document Routing Safeguard**: The system prevents Hermes from sending raw documents, archives, or sensitive files (`.zip`, `.sql`, `.env`) to public groups. All document deliveries default to the verified owner's private chat via `POST /send-document`.
3. **Restricted Shell Execution**: The `/exec` plugin is restricted strictly to numbers listed in `global.owner` and verified against sender JID and LID.
4. **PM2 Process Guard**: `SOUL.md` contains strict instructions preventing the agent from terminating or restarting the PM2 daemon (`llama-hermes`), which would drop the active WhatsApp socket.

---

## License & Authors

Distributed under the **MIT License**. See `LICENSE` for more information.

- **Author**: Stenly Christian ([@glarceny](https://github.com/glarceny))
- **Engine**: Powered by [Nous Research Hermes](https://github.com/NousResearch/Hermes-Agent) & [Baileys](https://github.com/itsliaaa/baileys)
EOF
