# RooMi (루미)

**An AI learning companion that lives in a child's room.**

RooMi is a small robot you design yourself: pick a template, paint it, name it, and it moves into a
3D room. When the child gets stuck on a problem, RooMi does not hand over the answer — it asks a
question first, then explains with an everyday analogy, then suggests one next step.

> RooMi = **Room + Me** — another version of me, living in my room.

**Live demo:** https://my-dorobot.app.workbuddy.host/?sharecode=M3SXYFV64Y
Open the demo account button on the start screen to see a room with a week of history already filled in.

---

## What is in it

| Area | What it does |
|---|---|
| **Robot workshop** | 4 body templates, 12-colour palette, 5 paintable parts. Colour combination deterministically picks one of 6 personalities; the LLM only rewrites the greeting. |
| **3D room** | Babylon.js. Redesigned robot (single visor, big eyes, shoulder-pivot arms, embedded core), furniture, curtains, string lights, idle walk / talk / jump animations. |
| **AI chat** | Three modes: chat, study together, feelings check. Six-turn memory, per-user long-term memory, and a **L1 → L2 → L3 hint ladder** that never leaks the final answer. |
| **AI village** | A 184 × 184 walkable world with three wisdom wells, winding paths, water, distant ridges, and in-world conversations that do not leave the 3D scene. |
| **Town restoration (cross-day)** | Five village facilities age every day. Repairs persist across sessions, raise facility levels, fill a maintenance journal, and leave glowing lamps in the 3D world. A deterministic *tomorrow preview* names the facility that will break next. See below. |
| **Mini games** | One original diagnosis game used as a repair mission inside the town system, one level-based bottle-sorting puzzle with six original rules, and three classic games kept as optional practice. All five are shown side by side in a game lounge with hand-drawn SVG covers — nothing is hidden behind a collapsed section. |
| **Friends** | Six-digit friend code, requests, cheers, text chat with profanity/PII filtering, block and report, parental on/off. |
| **Growth & retention** | Daily AI missions, 3-step learning plans, weekly goals, review cards, streak repair, season missions, reports for the child and a one-page dashboard for parents. |
| **Shop & economy** | Parts, room decorations, recolour skins, fragment exchange. Every reward is logged in a single cell-transaction table. |

### Town restoration: the main progression system

The main loop is **not a one-shot game**. It is a village that keeps its state across days:

- Each of the five facilities has `condition`, `level`, and a repair count. Every day that passes,
  deterministic decay makes them a little older and two of them develop a fault. Nothing is
  punished for being away — coming back simply continues from the current state.
- Opening a faulty facility starts one **repair mission** (the causal-chain diagnosis below).
  A successful repair restores its condition, advances the mechanic grade, writes a journal entry,
  lights a lamp in the starlight vault, and leaves a permanent marker in the 3D village.
- A weekly three-act case file and a **tomorrow preview** computed from the same deterministic
  function give a concrete reason to return — the preview always matches what actually breaks.
- Two repair missions per day; no currency is paid out, so the existing cell economy stays balanced.

`GET /api/campaign/state` returns the whole board. `GET /api/admin/campaign/rewind` (admin key)
replays elapsed days for demonstration and testing.

### Learning loop: diagnosis → plan → hint → teach-back

The chat pipeline already classified every turn (`chat_analyses`), stored spaced-repetition cards and
logged mood, but none of it reached the next day. They are now read together in three places:

- **Plan** — the first step is pinned to the concept the child was stuck on most recently, and the
  plan panel explains why in one line (`plan.focus`). If the child has been low for two days, the
  plan drops to two steps at half the length and starts with a three-minute conversation.
- **One action** — `GET /api/next-action` returns exactly one thing, chosen in this order: mood →
  stuck concept → due review → next plan step. The first screen shows that one step, not a menu.
- **Teach-back** — after the last hint (`hintLevel >= 3`), the chat offers "explain it in your own
  words". `POST /api/chat/explain` echoes the child's own phrasing, asks a single "what if…"
  question, never grades or praises, and stores the explanation as a `taught` memory. Five per day.

For the parent dashboard, statistics are replaced by three concrete **conversation starters** built
from the same diagnosis ("«fractions» is where they got stuck — ask which part was confusing"),
so the report is something a parent can use at dinner. No currency is paid for any of these.

### LLM tutoring: a dialogue that actually advances

A helpful chatbot answers; a tutor moves the child forward. Six changes turn the chat into the
latter:

- **Server-held dialogue state** — `chat_sessions` keeps the concept, the hint stage (L1 ask back →
  L2 analogy → L3 next step → confirm → teach-back), the turn count, and how long the current stage
  has lasted. The first turn is always L1, a stage never lasts more than two turns, and the model
  may raise the stage by at most one — so the conversation cannot loop.
- **Stuck-type aware** — the model (or a rule fallback) labels the blocker as `concept`,
  `procedure`, `reading`, or `careless`, and each type gets a different move: analogy, one next
  step, re-read the question, or self-check.
- **Concept search for knowledge cards** — instead of `msg.includes(topic)`, cards are scored by
  topic, a synonym table (`CARD_ALIASES`) and tags, so "what is an index?" reaches the *list* card.
- **Two sentences, 90 characters, one action** in learn mode. `limitSentences()` enforces it after
  the model — saying less is what makes the child think.
- **Token streaming** (`chatAddLive`, SSE from `/api/chat/stream`) so a 20-second answer does not
  arrive as one wall of text.
- **Barge-in** — while 루미 is speaking, the microphone is still monitored (Analyser RMS); if the
  child starts talking, the speech is cancelled and listening resumes.

### Spending fewer tokens per turn

A tutoring chat can quietly become expensive because every turn re-sends everything. Five changes
keep the prompt flat as the conversation grows:

- **A memo instead of replay** — `chat_sessions.summary` keeps four lines ("what the child said →
  what 루미 answered"), and only the last two turns are sent verbatim. The prompt stops growing
  linearly: measured 631 → 950 → 928 → **955 characters**, flat after the memo fills up.
- **Only the hint the stage needs** — L1 sends `hint_l1`, L2 sends the analogy and `hint_l2`, L3
  sends `hint_l3`; the other two levels are no longer in the prompt.
- **Top 3 memories** instead of six.
- **Output caps by mode** — 160 tokens for learn (it only writes two sentences), 200 for chat.
- **Model routing** — all modes (`learn`, `chat`, `reflect`) try DeepSeek first. EXAONE was
  tried first for a while, but frequent 429s and 20-second successful responses made the chat feel
  slow; it is now only a last-resort fallback if DeepSeek fails. Set `LLM_FORCE_FAST=0` to restore
  quality-first ordering.

Every call now records `prompt_tokens`, `completion_tokens`, `total_tokens` and `prompt_chars` in
`llm_logs`, exposed through `GET /api/llm/usage`. Against the old structure (six turns + full cards
+ six memories) the stable prompt is roughly **45% shorter**.

### Bottle-sorting puzzle: guaranteed-solvable levels

A second, self-contained game lives on the same screen. It keeps the familiar bottle-sorting
rules (only the top run of one colour can be poured, onto an empty bottle or the same colour,
four layers per bottle) and adds two rules of its own:

- **Cracked bottle** — one empty bottle is locked. Hold it down to repair it (costs power),
  which opens an extra empty bottle. Spending power or playing with fewer bottles is a real choice.
- **Wandering pours** — a legal pour never increases the number of colour groups, so a "wasted"
  move is defined as one that neither reduces the groups nor completes a bottle. Such a pour is
  never punished: three of them turn into one free hint, so mistakes stay on screen as a resource.

Levels are **generated backwards from a solved board** using only moves that can legally be
reversed, then checked again with a depth-first solver. A board is only shown to the player if a
complete solution exists; the shorter of the generated path and the solver path sets the par for
the three-star rating. Difficulty grows from 3 to 8 colours, 2 to 1 free bottles, a cracked
bottle from level 4, and four limited tools (undo / reshuffle / extra bottle / hint).

Four more decision layers sit on top of those rules:

- **Work order (choose 1 of 2)** — finish within N moves, use at most two tools, or complete a named
  colour first. Missing an order never costs points; only the order is lost, so a different goal is
  a reason to replay.
- **Light shards and a crafting bench** — a move that improves the board earns 2 shards, making room
  in an empty bottle earns 1, and completing a bottle earns 3. Tools start at one each and further
  ones are crafted on the spot (undo 4 / reshuffle 6 / extra bottle 8 / hint 5 / power charge 6).
- **Storage bottle** — from level 2, a gold two-slot bottle accepts any single colour and gives it
  back one layer at a time. It must be empty to win. The solver knows about this bottle, and the
  generated guaranteed solution never uses it, so adding it cannot make a board unsolvable.
- **Pressure surge** — each pour raises pressure (8/10/12 by level) and each completed bottle drops
  it by 20. At 100 a *blackout* costs 20 power and pauses shard income for three moves. The board
  itself is never touched, so solvability is preserved.

Two modes ask different questions:

- **Level mode** — "how well can you solve this board?" Work orders, shards, the storage bottle and
  pressure are all active.
- **Challenge mode** — "how long can you keep going?" 90 seconds, +12 seconds per cleared board,
  the storage bottle opens from the second board, and work orders/shards/pressure are switched off
  so the only thing that matters is speed. Running out of time simply ends the run; the best
  streak is kept in `sort_progress.best_streak` and never touches the level progression.

Progress (`level`, `totalStars`, `bestStars`, completed orders, shards, surges, `bestStreak`) is
stored in `sort_progress` via `GET /api/sort/progress` and `POST /api/sort/progress`. **No currency
is paid out** — levels, stars and the journal are the reward — so the daily cell cap stays below
the one-time shop total.

The chat entry point is a 62 px double-ring button. It renders a **separate 100 × 100 badge robot**
(head, body, large eyes, smile) instead of squeezing the full 200 × 250 robot into the circle, so
the face stays readable at icon size, and it exposes a hover label, an open state, and a
`prefers-reduced-motion` fallback.

There is exactly **one** chat entry. The room used to show two competing cards (a comeback card
with the next plan step, and a proactive nudge) that also repeated what the plan panel already
said; they are merged into a single speech bubble, which falls back to the next plan step when
there is no nudge. Closing it dismisses it for the session, the robot greets at most once a day,
and the drag hint appears only once. The always-on notification dot and the duplicated header
voice button were removed — a notification dot that never turns off is worse than none.

### The original mini game: **Broken Machine Detective (고장 탐정 · 멈춘 기계의 사슬)**

Most learning games reward reflexes. This one rewards observation and revision.

1. **Observe** (2.2–3.2 s): a machine powers on; two or three parts shake and glow, then go still.
2. **First thought**: the child picks the part they suspect. This first pick is recorded and cannot be undone.
3. **Wrong is information, not a penalty**: the part is crossed out and removed from the candidates,
   and the score does not change. A wrong guess narrows the search.
4. **Repair**: every fault found adds score; a clean first pick earns a bonus; a fully repaired
   machine plays a short melody.

Three machines, rising difficulty: 6 → 8 → 9 parts, 2 → 2 → 3 faults, and decoy parts that shake
slightly even though they are healthy — so the child has to compare evidence, not just react.

The short practice games are original designs: 루미 훈련소 (teach RooMi a rule with examples),
균형 공방 (balance a scale with fraction and decimal blocks), 어림 항해 (estimate with a stated confidence
range), and 거꾸로 질문소 (build an expression from an answer). They give XP and knowledge-codex cards, not cells.

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

### LLM chain

By default (`LLM_FORCE_FAST` unset), the app tries **DeepSeek first** and falls back to the
**primary model** (LG K-EXAONE 2.5 via the EXAONE API Platform) when DeepSeek is unreachable,
returns an error, times out, or returns an empty answer. Set `LLM_FORCE_FAST=0` to restore the
quality-first order: EXAONE first, DeepSeek fallback. If both fail, a deterministic Korean preset
is used so the child never sees an empty reply. Each provider has its own circuit breaker, so a
broken provider does not add latency to every later request.

EXAONE (when used) is a reasoning model: reasoning cannot be disabled, so requests use
`reasoning_effort: low`, a larger token budget, and a longer timeout (`~22 s` for a full chat
prompt vs `~1.5 s` for DeepSeek). Leading newlines in its answers are stripped.

`GET /api/llm/status` reports which model is configured and which one answered last. It never
exposes keys or endpoints.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./roomi.db` | SQLite file path |
| `PRIMARY_LLM_API_KEY` | — | Key for the primary model (or `primary_key.txt`) |
| `PRIMARY_LLM_BASE_URL` | `https://api.exaone.ai/v1` | OpenAI-compatible base URL of the primary model |
| `PRIMARY_LLM_MODEL` | `k-exaone_v2.5` | Primary model ID |
| `PRIMARY_LLM_TIMEOUT_MS` | `28000` | Time budget before falling back to DeepSeek |
| `DEEPSEEK_API_KEY` | — | DeepSeek key (fallback). Without any key the app runs on rule-based presets. |
| `LLM_MODEL` | `deepseek-chat` | Fallback model name |
| `LLM_TIMEOUT_MS` | `6000` | Fallback per-request timeout |
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

## Brand assets

The official presentation logo is `assets/roomi-logo.png` (384x256, black mark on white,
AI-generation watermark removed). For slides use `assets/roomi-logo-transparent.png` on light
backgrounds and `assets/roomi-logo-transparent-white.png` on dark ones. Do not use the original
watermarked image in any published material.
