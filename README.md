# RooMi (루미)

**An AI learning companion that lives in a child's room.**

RooMi is a small robot you design yourself: pick a template, paint it, name it, and it moves into a
3D room. When the child gets stuck on a problem, RooMi does not hand over the answer — it asks a
question first, then explains with an everyday analogy, then suggests one next step.

> RooMi = **Room + Me** — another version of me, living in my room.

**Live demo:** https://my-dorobot.app.workbuddy.host/
Open the demo account button on the start screen to see a room with a week of history already filled in.

---

## What is in it

| Area | What it does |
|---|---|
| **Robot workshop** | 4 body templates, 12-colour palette, 5 paintable parts. Colour combination deterministically picks one of 6 personalities; the LLM only rewrites the greeting. |
| **3D room** | Babylon.js. Redesigned robot (single visor, big eyes, shoulder-pivot arms, embedded core), furniture, curtains, string lights, idle walk / talk / jump animations. |
| **AI chat** | Three modes: chat, study together, feelings check. Six-turn memory, per-user long-term memory, and a **L1 → L2 → L3 hint ladder** that never leaks the final answer. |
| **AI village** | A 184 × 184 walkable world with three wisdom wells, winding paths, water, distant ridges, and in-world conversations that do not leave the 3D scene. |
| **Mini games** | One original game plus three training games (see below). |
| **Friends** | Six-digit friend code, requests, cheers, text chat with profanity/PII filtering, block and report, parental on/off. |
| **Growth & retention** | Daily AI missions, 3-step learning plans, weekly goals, review cards, streak repair, season missions, reports for the child and a one-page dashboard for parents. |
| **Shop & economy** | Parts, room decorations, recolour skins, fragment exchange. Every reward is logged in a single cell-transaction table. |

### The original mini game: **Broken Machine Detective (고장 탐정 · 미리 고치기)**

Most learning games reward reflexes. This one rewards observation and revision.

1. **Observe** (2.2–3.2 s): a machine powers on; two or three parts shake and glow, then go still.
2. **First thought**: the child picks the part they suspect. This first pick is recorded and cannot be undone.
3. **Wrong is information, not a penalty**: the part is crossed out and removed from the candidates,
   and the score does not change. A wrong guess narrows the search.
4. **Repair**: every fault found adds score; a clean first pick earns a bonus; a fully repaired
   machine plays a short melody.

Three machines, rising difficulty: 6 → 8 → 9 parts, 2 → 2 → 3 faults, and decoy parts that shake
slightly even though they are healthy — so the child has to compare evidence, not just react.

The three training games (bug whack, puzzle quiz, bug shooter) are deliberately labelled as practice;
they are classic genres and are not presented as original work.

---

## Stack

- **Node.js 22** with the built-in `node:sqlite` module (`--experimental-sqlite`)
- **Express 5** for the HTTP API
- **Vanilla HTML/CSS/JS** on the client, no build step
- **Babylon.js 7** for the room and the village
- **DeepSeek** for chat and generated text; every feature has a deterministic fallback when the model is unavailable

---

## Run locally

```bash
npm install
npm start
# → http://localhost:3000
```

or:

```bash
node --experimental-sqlite server.js
```

The database file is created on first run, including tables and seed data. Dependencies are only
`express`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./roomi.db` | SQLite file path |
| `DEEPSEEK_API_KEY` | — | DeepSeek key. Without it the app runs on rule-based fallbacks. |
| `LLM_MODEL` | `deepseek-chat` | Model name |
| `LLM_TIMEOUT_MS` | `6000` | Per-request timeout |
| `ADMIN_KEY` | — | Enables `/admin.html` and admin APIs. When unset, admin routes return 503. |
| `CLASS_CODE` | `1004` | Classroom attendance code |

API keys are never committed. `deepseek_key.txt` and `*.db` are ignored by git.

---

## Layout

```
server.js              HTTP API, SQLite schema, game and learning rules
public/
  index.html           single-page shell
  app.js               room, chat, shop, workshop, games, reports
  world.js             Babylon.js village, terrain, presence, quests
  style.css            design system
  admin.html           operator console
  assets/              GLB models and textures (CC0 low-poly)
scripts/
  eval_chat.mjs        chat quality evaluation harness
  eval-questions.json  evaluation prompts
start.command          macOS double-click launcher
```

---

## Data and privacy

- Only a nickname and gameplay records are collected. No real name, phone number, address, school,
  photo, or location.
- Chat messages are kept for **30 days**, then deleted. Chat is analysed by deterministic rules on
  the server — child utterances are never sent anywhere for scoring.
- Per-user long-term memory is capped at 50 entries and can be inspected or deleted by the child or
  guardian.
- Friend chat is limited to 200 characters and 30 messages per day, with PII and link filtering.
- Deleting an account removes its rows across all tables.

---

## Assets

3D models under `public/assets` are CC0 low-poly assets. The robot, the village layout, the
materials, and all UI art are built for this project.

---

## Note

This repository contains the application only. Presentation decks, course reports, and internal
design documents are kept outside the repository.
