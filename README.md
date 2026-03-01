# HumanitZ Discord Bot

A feature-rich Discord bot and web dashboard for [HumanitZ](https://store.steampowered.com/app/1658610/HumanitZ/) dedicated game servers. Monitor players, track stats, relay chat, manage settings, and visualise your world — all from Discord and the browser.

---

## Features

### Discord Integration
- **Server Status** — Live embed with player count, game day, season, and server health
- **Player Stats** — Per-player kill stats, playtime, profession, and lifetime records
- **Chat Relay** — Bidirectional chat bridge between Discord and in-game
- **Activity Log** — Real-time feeds for connections, deaths, building, looting, raids, and PvP kills
- **Auto Messages** — Configurable welcome messages, Discord link broadcasts, and SFTP-hosted welcome files with leaderboard templates
- **Milestones & Recaps** — Automatic announcements for kill milestones and periodic server recaps
- **Daily Threads** — Organised daily activity and chat threads to keep channels clean
- **Slash Commands** — Player lookup, leaderboards, server info, and admin tools

### Web Dashboard
- **Interactive Map** — Live Leaflet-based world map with player positions, structures, vehicles, containers, and AI
- **Admin Panel** — Server controls, RCON console, player management (kick/ban), game settings editor
- **Timeline Playback** — Time-scroll through historical snapshots of your world
- **Item Tracking** — Fingerprint-based item movement tracking with custody chains
- **Activity & Chat Feeds** — Searchable, filterable event and chat history
- **Database Browser** — Query game data tables directly from the panel
- **Discord OAuth2** — Role-based access tiers (survivor, mod, admin)

### Server Management
- **Multi-Server Support** — Manage multiple game servers from a single bot instance
- **PvP Scheduler** — Automatic PvP on/off at scheduled hours with countdown warnings
- **Server Scheduler** — Timed restarts with profile rotation and setting overrides
- **SFTP Auto-Discovery** — Automatically finds game files on your server
- **Panel API** — Pterodactyl panel integration for hosted servers (power controls, file access, WebSocket RCON)
- **Env Sync** — Automatic `.env` configuration management with schema versioning

---

## Quick Start

### Prerequisites
- **Node.js** 18+ (22+ recommended)
- A HumanitZ dedicated server with **RCON** enabled
- **SFTP** access to the server (password or SSH key)
- A **Discord bot** application ([guide](https://discord.com/developers/applications))

### Installation

```bash
git clone https://github.com/QS-Zuq/humanitzbot.git
cd humanitzbot
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
- `DISCORD_TOKEN` — Your bot token
- `DISCORD_CLIENT_ID` / `DISCORD_GUILD_ID` — Your Discord app and server IDs
- `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` — Game server RCON connection
- `FTP_HOST` / `FTP_USER` / `FTP_PASSWORD` — SFTP access to the game server
- `PANEL_CHANNEL_ID` — Discord channel for the bot's control panel

All other settings have sensible defaults or are auto-discovered on first run.

### First Run

```bash
npm run setup
```

The setup wizard will:
1. Connect to your game server via SFTP
2. Auto-discover file paths (save files, logs, settings)
3. Download initial data and seed the database
4. Deploy Discord slash commands

### Start the Bot

```bash
npm start
```

Or with auto-restart on file changes during development:

```bash
npm run dev
```

### Discord Setup Wizard

If RCON credentials are missing, the bot boots in minimal mode and posts an interactive setup wizard in your panel channel. It guides you through hosting profile selection, credential entry with live connection testing, and channel assignment.

---

## Web Dashboard Setup

The dashboard runs on port `3000` by default (configurable via `WEB_MAP_PORT`).

### Discord OAuth2 (optional but recommended)

For role-based access control, add to your `.env`:

```env
DISCORD_OAUTH_SECRET=your_oauth_secret
WEB_MAP_CALLBACK_URL=https://your-domain.com/auth/callback
WEB_MAP_SESSION_SECRET=random_secret_string
```

### Reverse Proxy (Caddy example)

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## Multi-Server

Additional servers are configured via the web panel or `data/servers.json`. Each server gets its own:
- Database (SQLite)
- RCON connection
- Player stats and playtime tracking
- Log watcher and chat relay
- Independent scheduler and PvP config

Supports both direct SFTP and Pterodactyl Panel API connections.

---

## Project Structure

```
src/
├── index.js              # Bot entry point
├── config.js             # Configuration loader
├── deploy-commands.js    # Slash command registration
├── commands/             # Discord slash commands
├── db/                   # SQLite database layer
├── game-server/          # Game data utilities
├── modules/              # Bot modules (chat, logs, stats, scheduler, etc.)
├── parsers/              # Save file and game data parsers
├── rcon/                 # RCON client (TCP + WebSocket)
├── server/               # Multi-server manager, panel API, server resources
├── tracking/             # Player stats and playtime tracking
└── web-map/              # Express web server + dashboard frontend
```

---

## Development

### Run Tests

```bash
npm test
```

### Build CSS (Tailwind)

```bash
npm run build:css        # One-time build
npm run dev:css          # Watch mode
```

### Environment Sync

The bot automatically keeps your `.env` in sync with new settings added in updates. Existing values are never overwritten — only missing keys are added with defaults.

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Discord:** discord.js v14
- **Database:** SQLite via better-sqlite3
- **Web:** Express 5 + Leaflet + Tailwind CSS
- **SFTP:** ssh2-sftp-client
- **RCON:** Custom TCP + WebSocket (Pterodactyl) clients

---

## License

[ISC](LICENSE)
