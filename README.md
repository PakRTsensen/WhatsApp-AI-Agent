# WhatsApp-AI-Agent

<p align="center">
  <img src="docs/architecture.png" alt="WhatsApp-AI-Agent Architecture" width="100%">
</p>

A WhatsApp bot designed primarily around an **autonomous agentic assistant** (powered by **Node.js + Baileys** and **Nous Hermes Agent CLI**), complemented with general WhatsApp bot utilities and automated group moderation.

Instead of operating as a traditional prompt-response chatbot, this bot runs an agentic execution loop capable of multi-step reasoning, self-correction, and tool execution. It comes bundled with a dedicated **WhatsApp Model Context Protocol (MCP) Server**, allowing the AI agent to inspect chat context, read quoted message chains, administer groups, and safely dispatch files back to WhatsApp.

---

## Table of Contents

- [Overview & Capabilities](#overview--capabilities)
- [System Requirements](#system-requirements)
- [Complete Setup Tutorial (Zero to Running)](#complete-setup-tutorial-zero-to-running)
  - [1. Server Prerequisites](#1-server-prerequisites)
  - [2. Clone & Install Dependencies](#2-clone--install-dependencies)
  - [3. Install Hermes Agent CLI](#3-install-hermes-agent-cli)
  - [4. Basic Configuration](#4-basic-configuration)
  - [5. Link WhatsApp via Pairing Code](#5-link-whatsapp-via-pairing-code)
  - [6. Register the WhatsApp MCP Server](#6-register-the-whatsapp-mcp-server)
  - [7. Run with PM2 (Background Daemon)](#7-run-with-pm2-background-daemon)
- [Tutorial: Changing and Adding AI Models](#tutorial-changing-and-adding-ai-models)
  - [Configuring Providers & Models (`noppo_config.js`)](#configuring-providers--models-noppo_configjs)
  - [Switching Models Directly in WhatsApp](#switching-models-directly-in-whatsapp)
  - [Using Alternative Providers (OpenRouter, Groq, Ollama, etc.)](#using-alternative-providers-openrouter-groq-ollama-etc)
- [Model Context Protocol (MCP) Toolsets](#model-context-protocol-mcp-toolsets)
  - [Bundled: WhatsApp MCP Server (`wa_control`)](#bundled-whatsapp-mcp-server-wa_control)
  - [Recommended External MCP Toolsets (from `SOUL.md`)](#recommended-external-mcp-toolsets-from-soulmd)
  - [Customizing or Disabling MCPs in `SOUL.md`](#customizing-or-disabling-mcps-in-soulmd)
- [Using the Agentic Assistant (Noppo)](#using-the-agentic-assistant-noppo)
- [General Bot Commands & Features](#general-bot-commands--features)
  - [Group Moderation](#group-moderation)
  - [Bot Administration](#bot-administration)
  - [Media & Utility Tools](#media--utility-tools)
- [Plugin Development & Hot Reload](#plugin-development--hot-reload)
- [Operations & Troubleshooting](#operations--troubleshooting)
  - [Monitoring Logs](#monitoring-logs)
  - [Re-pairing or Resetting WhatsApp Session](#re-pairing-or-resetting-whatsapp-session)
  - [Running the Test Suites](#running-the-test-suites)
- [Security & Privacy Guardrails](#security--privacy-guardrails)
- [License & Credits](#license--credits)

---

## Overview & Capabilities

1. **Agentic WhatsApp Assistant**:
   - Mention `@bot` or use `/noppo <prompt>` to assign multi-step tasks.
   - Hermes Agent plans, executes shell commands, analyzes files, browses websites, and performs multi-tool chains autonomously.
   - **Live Streaming Edits**: Responses stream into WhatsApp by editing a single message every 900ms, providing clean real-time output without message spam.

2. **Native WhatsApp Control via MCP**:
   - The bundled `wa_control` MCP server gives the agent tools to inspect chat history, traverse replied message threads, list joined groups, and send files directly to the owner.

3. **Multimodal Vision**:
   - Extracts images from direct messages or quoted replies, saving them to secure temporary storage and passing them to vision-capable models.

4. **Zero-Disk Chat Privacy**:
   - Conversation history is buffered in memory (rolling 30-minute window, max 4 recent messages for prompt assembly). Private chat logs are not permanently stored on disk.

5. **General Bot Utilities**:
   - Automated group moderation: `antilink` (auto-delete link spam), `antiforward` (block forwarded channels), and `closegroup` (automated open/close schedules).
   - Hot-reloadable modular plugin system (`plugins/**/*.js`).

---

## System Requirements

| Component | Minimum | Recommended | Notes |
|---|---|---|---|
| **CPU** | 2 vCPU cores | 4 vCPU cores | Needed for background Hermes agent processes |
| **RAM** | 2 GB | 4 GB | 4 GB recommended if using headless Chrome or pentest tools |
| **Storage** | 10 GB SSD | 20 GB SSD | For Node.js modules, Python venvs, and cache |
| **OS** | Linux | Ubuntu 22.04 / 24.04 LTS or Debian 12 | Linux environment recommended |
| **Node.js** | `>= 18.18.0` | Node.js 20 LTS or 22 LTS | Tested on Node 20 & 22 |
| **Python** | `>= 3.10` | Python 3.11 or 3.12 | Required by the MCP server |

---

## Complete Setup Tutorial (Zero to Running)

### 1. Server Prerequisites

Update your server and install required packages:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git build-essential ffmpeg jq python3 python3-pip python3-venv
```

Install Node.js (v22 LTS) and PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

---

### 2. Clone & Install Dependencies

Clone this repository and install Node.js packages:

```bash
git clone https://github.com/glarceny/WhatsApp-AI-Agent.git /LlamaAgentHermes
cd /LlamaAgentHermes
npm install
```

---

### 3. Install Hermes Agent CLI

Install Hermes Agent CLI globally:

```bash
curl -fsSL https://hermes.nousresearch.com/install.sh | bash
```

Verify that `hermes` is installed:

```bash
hermes --version
```

Copy the bundled agent persona and rules into `/root/.hermes/SOUL.md`:

```bash
mkdir -p /root/.hermes
cp /LlamaAgentHermes/Hermes-kit/SOUL.md /root/.hermes/SOUL.md
```

Create the API key file `/root/.hermes/noppo.env`:

```bash
cat << 'EOF' > /root/.hermes/noppo.env
NOPPO_ROUTER_API_KEY=your_api_key_here
EOF
chmod 600 /root/.hermes/noppo.env
```

---

### 4. Basic Configuration

#### Owner & Bot Identity
Edit `control/settings.js` to set your owner numbers and prefix:

```javascript
global.namaown = "Your Name";
global.prefix = "/";
global.botname = "Noppo Agent";
global.botversion = "v1.0";
// Add owner numbers in international format without '+' or spaces:
global.owner = ["6285199430173", "6285881325696"];
```

---

### 5. Link WhatsApp via Pairing Code

Run the bot once interactively to connect your WhatsApp account:

```bash
PAIRING_NUMBER=6283167054726 node index.js
```

The terminal will output:

```text
=================================
PAIRING CODE:  STENLYCL 
=================================
Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat > masukkan kode di atas.
```

1. Open **WhatsApp** on your phone.
2. Tap **Settings** (or three dots) > **Linked Devices**.
3. Select **Link a Device** > **Link with phone number instead**.
4. Enter the pairing code shown in the console (`STENLYCL` or auto-generated code).
5. Once logged in, press `Ctrl+C` to stop the interactive run.

---

### 6. Register the WhatsApp MCP Server

To enable the agent to access WhatsApp features, register `wa_control` in `/root/.hermes/config.yaml`:

```yaml
mcp_servers:
  wa_control:
    command: "/usr/bin/python3"
    args:
      - "/LlamaAgentHermes/mcp/wa_control_server.py"
```

Verify the MCP server health check:

```bash
python3 /LlamaAgentHermes/mcp/smoke_test.py
```

---

### 7. Run with PM2 (Background Daemon)

Start the bot in the background:

```bash
pm2 start index.js --name llama-hermes
pm2 save
pm2 startup
```

---

## Tutorial: Changing and Adding AI Models

### Configuring Providers & Models (`noppo_config.js`)

All model routing is managed in `lib/noppo_config.js`. The bot connects to any **OpenAI-compatible** endpoint (9Router, OpenRouter, Groq, Ollama, official OpenAI, etc.).

```javascript
module.exports = {
    provider: {
        baseUrl: process.env.NOPPO_ROUTER_URL || 'https://9router.stenly.id/v1',
        apiKeyEnv: 'NOPPO_ROUTER_API_KEY',
        credentialsFile: '/root/.hermes/noppo.env'
    },
    models: [
        {
            id: 'cx/gpt-6-luna[1m]',
            name: 'GPT Luna 6 (1M Context)',
            provider: 'openai',
            supportsVision: true,
            contextLength: 1000000
        },
        {
            id: 'dco/deepseek-ai/DeepSeek-V4.1-Flash-1017',
            name: 'DeepSeek V4.1 Flash',
            provider: 'openai',
            supportsVision: true,
            contextLength: 64000
        }
    ],
    defaultModelId: 'cx/gpt-6-luna[1m]'
};
```

#### Adding a New Model
To register a new model (e.g. `openai/gpt-4o` or `deepseek-chat`), simply append it to the `models` array:

```javascript
{
    id: 'openai/gpt-4o',
    name: 'GPT-4o Omnimodal',
    provider: 'openai',
    supportsVision: true,
    contextLength: 128000
}
```

Then update `NOPPO_ROUTER_API_KEY` in `/root/.hermes/noppo.env` if required.

### Switching Models Directly in WhatsApp

Users and owners can inspect and switch models on the fly without restarting the bot:

1. **List Models**:
   ```text
   /noppo models
   ```
   Outputs the registered models along with their ID, vision support, and index number.

2. **Switch Active Model**:
   ```text
   /noppo model 2
   ```
   or specify the model ID directly:
   ```text
   /noppo model dco/deepseek-ai/DeepSeek-V4.1-Flash-1017
   ```
   The bot persists your preference per chat session.

3. **Toggle Vision Support for a Model**:
   ```text
   /noppo modelimage 1 off
   ```

### Using Alternative Providers (OpenRouter, Groq, Ollama, etc.)

- **OpenRouter**: Set `baseUrl: 'https://openrouter.ai/api/v1'` and place your `sk-or-v1-...` key in `/root/.hermes/noppo.env`.
- **Local Ollama**: Set `baseUrl: 'http://127.0.0.1:11434/v1'` and `NOPPO_ROUTER_API_KEY=ollama`.
- **Official OpenAI**: Set `baseUrl: 'https://api.openai.com/v1'` and place your `sk-...` key in `/root/.hermes/noppo.env`.

---

## Model Context Protocol (MCP) Toolsets

The system uses the Model Context Protocol (MCP) to supply tools to the Hermes Agent.

### Bundled: WhatsApp MCP Server (`wa_control`)

The repository includes a ready-to-use Python MCP server at `mcp/wa_control_server.py`. It connects to the bot's internal control API (`127.0.0.1:5685`) and gives the agent these actions:

| Tool | Parameters | Description |
|---|---|---|
| `wa_message_thread` | `chat`, `id` | Traverses replied message chains to understand conversation context. |
| `wa_message_recent` | `chat`, `limit` | Reads recent chat messages to follow ongoing discussions. |
| `wa_message_search` | `chat`, `query` | Searches message history by text, sender name, or media type. |
| `wa_group_list` | None | Lists all joined WhatsApp groups, member counts, and admin statuses. |
| `wa_group_info` | `chat` | Retrieves group metadata, description, and settings. |
| `wa_group_setting` | `chat`, `setting` | Changes group settings (e.g. `announcement` mode). |
| `send_document` | `file_path`, `to` | Sends a generated file/document safely to the owner's private chat. |

### Recommended External MCP Toolsets (from `SOUL.md`)

In `/root/.hermes/SOUL.md` (and `Hermes-kit/SOUL.md`), the agent is pre-configured to recognize optional external MCP toolsets if you wish to equip your bot with specialized tools:

1. **`xposedornot`** (Free HTTP, keyless): Email & domain data breach lookups.
2. **`openosint`** (Passive OSINT): DNS, WHOIS, RDAP, IP intelligence, and GitHub dorking.
3. **`osint-tools`** (Identity OSINT): Sherlock, Holehe, Maigret, and TheHarvester.
4. **`hexstrike`** (Local Infrastructure Scanner): Connects to localhost:8888 for security scanning.
5. **`chrome-devtools`** (Browser Control): Headless Chrome DevTools Protocol automation (`npx chrome-devtools-mcp@1.12.0`).

### Customizing or Disabling MCPs in `SOUL.md`

> **Note**: External MCP servers are completely optional!

If you only want the bot for general assistance and WhatsApp control:
1. You only need `wa_control` configured in `/root/.hermes/config.yaml`.
2. Open `/root/.hermes/SOUL.md` (and `Hermes-kit/SOUL.md`) in any text editor.
3. Remove or comment out sections under `MCP SERVERS AKTIF` for tools you do not use.
4. Hermes will automatically adapt and only use tools that are registered.

---

## Using the Agentic Assistant (Noppo)

### Interacting with the Agent
- **In Groups**: Mention `@bot` followed by your request:
  ```text
  @bot Check why our API endpoint /v1/health returned status 502 earlier.
  ```
- **In Private Chat**: Send `/noppo <prompt>` or talk directly if configured.
- **Replying to Context**: Quote any WhatsApp message (or image) and mention `@bot` to ask questions about it.

### Agent Session Commands
- `/noppo new`: Clears the conversation memory and starts a fresh session.
- `/noppo status`: Displays active turns, process PID, and token consumption.
- `/noppo stop`: Gracefully aborts the running turn.
- `/noppo kill`: Forcefully terminates the agent process immediately.

---

## General Bot Commands & Features

### Group Moderation
- `/antilink on|off`: Automatically deletes invite links and removes offenders.
- `/antiforward on|off`: Blocks broadcast channel / newsletter forward spam.
- `/closegroup <HH:MM>`: Schedules automated closing of group permissions.

### Bot Administration
- `/exec <bash>`: Executes shell commands on the VPS (strictly limited to numbers in `global.owner`).
- `/modebot public|self|self2`:
  - `public`: Responds to all users.
  - `self`: Responds only to creator in private chat.
  - `self2`: Silent mode (moderation hooks remain active, but user commands are ignored).
- `/addown <number>`: Adds a new user number to the bot's owner list.
- `/banuserbot <number>`: Completely bans a user from using the bot.

### Media & Utility Tools
- `/hd`: Enhances image resolution.
- `/uptime`: Displays server uptime, memory usage, and load metrics.
- `/menu`: Displays the dynamic command list generated from loaded plugins.

---

## Plugin Development & Hot Reload

All custom bot features reside in `plugins/**/*.js`.

### Creating a Custom Plugin
Create a new file, for example `plugins/tools/hello.js`:

```javascript
module.exports = {
    name: 'hello',
    command: ['hello', 'hi'],
    category: 'tools',
    description: 'Greets the user',
    owner: false,
    group: false,
    admin: false,
    run: async (context) => {
        const { m } = context;
        await m.reply(`Hello ${m.pushName || 'friend'}! How can I help you today?`);
    }
};
```

Save the file. The bot's built-in watcher detects the file and reloads it in **under 100ms** without restarting the process or dropping WhatsApp connections.

---

## Operations & Troubleshooting

### Monitoring Logs
Always use `--nostream` when viewing PM2 logs to avoid locking the terminal session:

```bash
pm2 logs llama-hermes --nostream --lines 50
```

### Re-pairing or Resetting WhatsApp Session
If you need to change the phone number or re-pair:

1. Stop the bot:
   ```bash
   pm2 stop llama-hermes
   ```
2. Clear the session files:
   ```bash
   rm -rf /LlamaAgentHermes/session/*
   ```
3. Restart the bot:
   ```bash
   pm2 start llama-hermes
   ```
4. Read the logs to fetch the new pairing code:
   ```bash
   sleep 5 && pm2 logs llama-hermes --nostream --lines 30
   ```

### Running the Test Suites
The repository includes 13 Node.js test suites:

```bash
node --test test/*.test.js
```

Expected result:

```text
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
```

---

## Security & Privacy Guardrails

1. **Zero Disk Storage for Conversations**: Raw messages are buffered strictly in memory (`lib/message_cache.js`) for 30 minutes, keeping conversations confidential.
2. **Private Document Routing**: The agent is strictly instructed never to send raw documents, archives, or internal files (`.zip`, `.sql`, `.env`) into public groups. File outputs default to the verified owner's private chat via `send_document`.
3. **Execution Restrictions**: Dangerous commands like `/exec` strictly verify the sender's phone number and WhatsApp LID against `global.owner`.

---

## License & Credits

- **License**: MIT
- **Author**: Stenly Christian ([@glarceny](https://github.com/glarceny))
- **Core Libraries**: [@itsliaaa/baileys](https://github.com/itsliaaa/baileys) & [Nous Research Hermes](https://github.com/NousResearch/Hermes-Agent)
EOF
