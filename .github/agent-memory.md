# Agent Memory — HumanitZ Bot

> **Read this file at the start of every session.** It is the persistent brain — decisions, traps, lessons, and work state. If this file and the user conflict, the user wins.

---

## Core Identity

This is a **professional-grade** game server management suite heading toward **Bisect Hosting partnership integration**. The developer works with game devs, community team, and hosting partners. Treat every change as if it ships to paying customers.

Agent role: **Senior engineer.** Build the blocks. Follow best cybersecurity practices. Follow logic, not assumptions. When the user says something is true, **trust it immediately** — do not waste money verifying.

---

## Known Data Traps (DO NOT REPEAT THESE MISTAKES)

### ❌ `unlocked_skills` column — BAD DATA
The `unlocked_skills` column in the `players` table contains **hex GUIDs from an OLD save parser with WRONG BYTE OFFSETS**. These GUIDs are meaningless. The current save parser writes correct data but the DB was never wiped, so stale values persist. **Never use `unlocked_skills` for anything.**

### ❌ `unlockedSkills` arrays inside `skills_data` JSON — ALSO BAD
The `skills_data` JSON objects contain `unlockedSkills: [GUID, ...]` arrays. These GUIDs come from the same bad parser. **Ignore them.** Use `locked: true/false` and `unlockProgress` x/y ratios instead.

### ❌ `guid-map.json` — LEGACY
Part of the old system before game data decompilation. The DB game reference tables (seeded from `game-data-extract.js`) are the source of truth. Don't try to resolve GUIDs through guid-map.

### ✅ `skills_data` JSON — CORRECT (partial)
Structure: array of objects, each with:
```json
{
  "type": "E_SkillCatType::NewEnumerator0|1|2",
  "index": N,
  "locked": bool,
  "needSpecialUnlock": bool,
  "exp": N,
  "expNeeded": N,
  "unlockedSkills": ["BAD-GUIDS-IGNORE"],
  "unlockProgress": [{"x": N, "y": N}, ...]
}
```
- `NewEnumerator0` = Survival, `NewEnumerator1` = Crafting, `NewEnumerator2` = Combat
- Use `locked` flag and `unlockProgress` for display, NOT the GUID arrays
- `SKILL_DETAILS` (35 entries) maps skill IDs → names/descriptions/categories

---

## DB Architecture (Source of Truth)

- **DB is SOLE source of truth.** Not JSON files, not RCON, not save files directly.
- 133 columns per player in `players` table.
- `_dbRowToSave()` (player-stats-channel.js lines 22-155) maps ALL DB columns to save objects.
- `_resolvePlayer()` (lines 159-193) returns `{ name, firstSeen, lastActive, playtime, log, save }`.

### Rich DB fields NOT yet surfaced in Discord embeds:
- `exp_current` / `exp_required` — XP progress bar
- `skills_point` — Available skill points
- `skills_data` — Full skill tree (locked/unlocked per category)
- `quest_data` — Quest tracking
- `mini_quest` — Mini-quest progress
- `companion_data` — Companion details (vest, command, energy, inventory)
- `loot_item_unique` — Readable unique item names (not just counts)
- `crafted_uniques` — Crafted unique items
- `well_rested` / `energy` — Additional vitals
- `hood` / `hypo_handle` — Cosmetic/status flags

### Game Data Reference (from DB-seeded tables):
- `SKILL_DETAILS` — 35 skills with name, description, category, cost, tier, column, effects
- `SKILL_CATEGORY_NAMES` — NewEnumerator0=Survival, 1=Crafting, 2=Combat
- `CHALLENGE_DESCRIPTIONS` — 19 challenges with names, descriptions, targets
- `PROFESSION_DETAILS` — 12 professions
- `AFFLICTION_MAP` — 20 affliction types
- `LOADING_TIPS` — Fun facts for embed footers

---

## Current Codebase State

### Display Files (rewritten this session):
| File | Lines | Status |
|------|-------|--------|
| `src/modules/player-stats-embeds.js` | 847 | Rewritten but **needs enrichment** |
| `src/modules/server-status-embeds.js` | 286 | ✅ Done, deduplicated |
| `src/modules/player-embed.js` | 120 | ✅ Done, log-only card |
| `src/commands/playerstats.js` | 117 | ✅ Done |
| `src/commands/playtime.js` | 96 | ✅ Done, no SteamID exposure |
| `src/commands/players.js` | 65 | ✅ Done |
| `src/commands/server.js` | 79 | Not modified (not requested) |

### Tests: 1046 passing, 0 failures
### Bot: Running cleanly on production

### Pending unstaged changes:
- `status-channels.js` — Removed channel creation, now find-only (never create)
- `playtime-tracker.js` — Added `getActiveSessions()` method
- `panel.css` / `panel.html` / `panel.js` — Web panel redesign (landing, multi-server, schedule tooltips)
- `server.js` (web-map) — Multi-server context middleware, `_resolveServer()`, per-server DB/RCON/config
- `new-parser.test.js` / `timeline.test.js` — Schema version bump 12→13
- `.bak` files — Old command backups (players, playerstats, playtime, server)

---

## Active Work Items

### PRIORITY 1: Enrich `buildFullPlayerEmbed()` (NOT STARTED)
The embed is too sparse given the rich DB data. Needs:
- **XP progress bar** from `expCurrent`/`expRequired` 
- **Skill points** indicator from `skillPoints`
- **Skill tree visualization** from `skillsData` (use `locked`/`unlockProgress`, NOT GUIDs)
- **Quest tracking** from `questData`
- **Mini-quest progress** from `miniQuest`
- **Richer companion data** (vest, command, energy) from `companionData`
- **Actual unique item names** from `lootItemUnique` (not just counts)
- **Challenge descriptions** from `CHALLENGE_DESCRIPTIONS`
- **Additional vitals** (wellRested, energy)
- **Lifetime vs current life comparisons** in more fields

### PRIORITY 2: Phase 5 — Community Features (Roadmap)
- 5a: Milestone tracker
- 5b: Daily/weekly recap
- 5c: Leaderboard commands
- 5d: Compare command
- 5e: Did You Know
- 5f: Bounty board

### Phase 6: Creative Data Presentation
### Phase 7: Web Panel Redesign (in progress — see unstaged changes)
### Phase AC: Anticheat (AC-1 through AC-5 complete, 1046 tests)
### Phase 8: Polish & Public Release

### HOWYAGARN: Faction PVP / MMOlite (Design approved Feb 28 2026)
- **Full design doc**: See `copilot-instructions.md` → "HOWYAGARN: Faction PVP / MMOlite" section
- **Concept**: Transform HumanitZ server into faction-based PvP MMOlite via server-side modding only (no client mod)
- **3 factions**: Reapers (raiders), Wardens (builders), Drifters (scavengers) — asymmetric bonuses
- **Systems**: Territory control, quest engine (daily/faction/story), faction progression (rank 1-20), economy, scheduled events
- **Tech**: Custom RCON commands injected into `BP_HMZRCon` via UAssetAPI bytecode patching → deployed as `.pak` mod
- **Test server**: EU2 (`hzserver2`, port 8889, password `Vp3kR8wN2mYx`, game pw `"Sammy"`) — **NEVER touch EU1**
- **Current state**: ✅ **Patcher v5 WORKING — 3 custom RCON commands deployed and tested on EU2**
  - `hmz help` → returns command list
  - `hmz ping` → returns "pong"
  - `hmz version` → returns "HOWYAGARN v0.1.0-alpha"
  - All stock commands still work (`info`, `Players`, etc.)
  - Pak: `zzz_howyagarn_mod_P.pak` (63998 bytes) at `/home/steam/hzserver2/serverfiles/HumanitZServer/Content/Paks/`
- **Next**: Implement real game commands (faction join, quest, rank, map, etc.) + build bot-side MMO modules
- **Key rule from user**: "every occasion you mention using a command, replace with UI" and "dialog must be believable, immersive, not cringey"

#### RCON Patcher Technical Notes (Lessons Learned v1-v5)
- **Patcher location**: `/root/server-pak-extract/rcon-patcher/Program.cs` (C# .NET 8.0)
- **v1 bug**: Only fixed JumpIfNot targets == 7204. Missed Jump and PushExecFlow → broke RCON
- **v2 bug**: Used .uexp file size delta (+571) instead of ScriptBytecodeSize delta (+439) → PushExecFlow target exceeded bounds → server crash (`Unknown code token 05`)
- **v3 bug**: Used `AssetBinaryWriter.Write()` per instruction to measure sizes — gives StorageSize (64-bit) not BytecodeSize (32-bit). Wrong coordinate space for jump targets.
- **v4 bug**: Template search found instructions from DIFFERENT commands — Let[229]+LetBool[230] from "season" cmd paired with JumpIfNot[237] from a Map.Find branch. Variable mismatch: JumpIfNot read `CallFunc_Map_Find_ReturnValue` instead of `CallFunc_StartsWith_ReturnValue`.
- **v5 fix**: Search for 3 CONSECUTIVE instructions (EX_Let + EX_LetBool + EX_JumpIfNot) with LINKED variables from a single command. Found "weather" at [254,255,256]. Uses `GetSize(asset)` for correct in-memory code offsets. All custom commands work.
- **Key insight**: `KismetExpression.GetSize(asset)` returns in-memory/BytecodeSize-space sizes (CORRECT for jump targets). `AssetBinaryWriter.Write()` returns StorageSize-space bytes (WRONG for jump targets). ScriptBytecodeSize ≠ ScriptStorageSize on 64-bit platforms.
- **Build pipeline**: `dotnet run` → `repak pack --version V11 --mount-point "../../../" patched-rcon zzz_howyagarn_mod_P.pak` → copy to EU2 Paks dir → restart EU2
- **Insertion pattern**: 5 instructions per command (EX_Let, EX_LetBool, EX_JumpIfNot, EX_FinalFunction/SendRCONData, EX_PopExecutionFlow). Inserted before "Unknown command!" fallback. Jump chain links commands sequentially, final JumpIfNot falls through to "Unknown command!".

### UAssetAPI — Permanent Tooling (Decision Feb 28 2026)
- **NOT a one-off patcher** — permanent mod SDK for all server-side modding
- **Capabilities**: Read/write any .uasset/.uexp, Kismet bytecode manipulation (100 expression types), DataTable read/write, JSON roundtrip (verified safe)
- **Uses beyond RCON**: DataTable modding (loot/items/recipes), Blueprint patching (any of 18+ dumped BPs), game data extraction, automated mod builder (JSON config → .pak), hot-reload dev
- **Location**: `/root/server-pak-extract/` — `uasset-api/`, `rcon-patcher/`, `bp-dumper/`, `blueprint-dumps/`, `extracted/`
- **Long-term**: Modular mod SDK — RCON module + DataTable module + Blueprint module + pak builder, all from one JSON config

---

## Absolute Rules (from copilot-instructions.md)

1. **NEVER modify `.gitignore`** without asking first
2. **Never commit credentials** — `.env` only
3. **Review public wiki** before feature changes
4. **Close terminals** when done
5. **Commit messages**: professional, describe what/why, never reference conversation details
6. **No code may rely on uncommitted files** — hardcoded defaults or generate at build time
7. **Never deploy rapid restarts** — stop → verify → change → start
8. **Env-sync never removes user settings**
9. **DB writes must be idempotent** — use `MAX(existing, new)` for cumulative stats
10. **Singleton init must be DB-aware** — `setDb()` reloads with `MAX()` merge
11. **Module cleanup: NO timestamp filters** — delete ALL bot messages in target channel

---

## Lessons Learned

1. **Trust the user.** When they say data is bad, don't burn rounds verifying. Cost: wasted 5+ tool calls chasing bad GUIDs the user had already warned about twice.
2. **Read before you write.** Understand the full data pipeline before touching display code.
3. **DB-first means DB-first.** The save file is a data source, but the DB is the canonical store.
4. **One restart at a time.** The Feb 26 incident was caused by 7 restarts in 24h. The embed duplication, data wipe, and scheduler destruction were all downstream effects.
5. **Multi-server is real.** EU1 (primary, 36+ players) and EU2 (1 player "Zuq"). `ServerInstance` isolation with per-server DB/RCON/config.
6. **The dynamic schedule is THE #1 feature.** `RESTART_TIMES=01:00,09:00,17:00`, `RESTART_PROFILES=calm,surge,horde`. Daily rotation. This is what makes the server special.

---

## Infrastructure Quick Reference

- **VPS**: `216.201.76.252` (Bisect Hosting), Ubuntu 24.04 LTS, 16GB RAM, 6 vCores
- **Game server**: Docker container, LinuxGSM. Ports: 7777/udp, 27015/udp, 8888/tcp (localhost)
- **Bot**: `/root/humanitzbot`, Node.js 22.x, systemd `humanitzbot`
- **DB**: SQLite (`better-sqlite3`), schema v13
- **Git remotes**: `origin` → public `QS-Zuq/humanitzbot`, `dev` → private `QS-Zuq/humanitzbot-dev` (branch: `experimental`)

## Game Data Extraction

### AES Encryption Key
`0x321166CACD1E2BBEAC9794AAF468DE277001D2EF8F74A8D6B3CC6EDFE87945CA`

### Client Pak (COMPLETED)
- Source: Local game install pak
- Extraction archive: `/root/humanitz-extraction-handoff.tar.gz` (28MB)
- Contains: 105 DataTables, 79 enums, 193 structs, 2282 blueprints, 18 save files fully extracted to JSON
- Parsers: `gvas-reader.js` (569 lines), `save-parser.js` (1150 lines)
- All extracted data feeds into `data/game-tables-raw.json` (22MB) → `game-data-extract.js` → 23 DB reference tables

### Server Pak (IN PROGRESS — Feb 28 2026)
- Location: `/app/serverfiles/HumanitZServer/Content/Paks/HumanitZServer-LinuxServer.pak` (1,063,625,347 bytes / ~1GB)
- Container: `hzserver` Docker container
- Goal: Extract server-specific blueprints for RCON command handlers, chat routing, game mode logic, save pipeline
- Key targets: RCON command registration, clan/whisper chat dispatch, server-only validation, mod loading capability
- The Paks directory has NO other files — just the one server pak. No mods directory exists yet.

### RCON Commands (from server-info.js)
Available: `info`, `Players`, `admin`, `kick`, `ban`, `unban`, `fetchbanned`, `teleport`, `unstuck`, `season`, `weather`, `restart`, `QuickRestart`, `RestartNow`, `CancelRestart`, `shutdown`
No clan/whisper/group chat commands exist. `admin` and `say` are server-wide only.

### Clan Chat Findings (Feb 28 in-game test)
- Clan chat renders in general chat for clan members (blue name, white text)
- Group chat untested (requires being in a group)
- No RCON command exists for targeted messaging
- **Action item**: Ask game devs about whisper/clanchat RCON commands

---

## Session Handoff Checklist

When starting a new session:
1. Read this file
2. Read `.github/copilot-instructions.md` (1086 lines — the project bible)
3. Run `npm test` to verify state
4. Check `git status` for pending work
5. Ask: "Where did we leave off?" if context is unclear
