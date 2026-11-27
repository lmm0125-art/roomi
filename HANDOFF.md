# RooMi — Engineering Handoff (for Claude)

> **Last verified**: 2026-11-27 · app version **v1.81** · local regression `npm test` **21/21 PASS** (online smoke 442/442 was v1.80 — re-run after deploy)
> **Live demo**: https://my-dorobot.app.workbuddy.host/?sharecode=M3SXYFV64Y
> **Owner**: 이멍멍 (Hanyang ERICA, AI major) · IC-PBL course project
> **Read this file fully before touching code.** It supersedes `CODEX_CONTEXT.md` (Oct 2026, obsolete).

---

## 0. Five-minute orientation

RooMi is a Korean elementary-school learning companion: a robot the child paints becomes a 3D roommate,
and a chat tutor that **does not hand out answers** — it walks the child through L1 (ask back) → L2 (analogy)
→ L3 (next step), then asks the child to **teach it back**. What the child teaches becomes a **memory lamp**;
the lamp fades every day ("fog"), and the child defends it in a daily **Tower of Fog** mini-game.

The engineering thesis is: **memory must be a data structure, not a prompt**. Every screen reads the same
tables (`chat_analyses`, `concept_mastery`, `learning_plans`, `review_cards`, `memory_lamps`), so a single
conversation changes tomorrow's plan, the guardian report, and the tower deck.

Stack: **Node 22 + Express 5 + `node:sqlite` (built-in, no ORM)** + vanilla JS + Babylon.js 3D.
No build step. `public/` is served as-is; cache busting is a `?v=` query.

---

## 1. Product facts

| Item | Value |
|---|---|
| Audience | Korean elementary ~ middle school (7–11 in copy, 10–15 in older docs) |
| Core loop | chat → analysis → mastery → plan → review → lamp → tower → (back to chat) |
| Session model | `chat_sessions` per user per day per mode (`chat` / `learn` / `reflect`) |
| Chat limits | `CHAT_LIMITS = { chat:10, learn:10, reflect:1 }` |
| Economy | "cells" (셀). Ledger `cell_tx`, materialized balance `users.cell_balance` |
| Daily income ceiling | **393 cells** (do not exceed; one-off items cost up to 400) |
| 3D | Babylon.js `@7.54.3` pinned via CDN; room scene + open world |
| LLM | K-EXAONE 2.5 (primary) → DeepSeek (fallback) → rule preset |
| Code comments | **Korean** (technical terms may stay English) |

---

## 2. Live system

```
URL        https://my-dorobot.app.workbuddy.host/?sharecode=M3SXYFV64Y
Share code M3SXYFV64Y
DB (prod)  /tmp/dorobot-online.db      (persists while the deployed instance lives)
Admin      /admin.html  (header: X-Admin-Key: <ADMIN_KEY env>; if ADMIN_KEY is unset the server returns 503 for every admin route — fail-closed)
Demo seed  POST /api/demo/seed          (7-day fake history, Lv.5, streak 6, 320 cells)
Demo lamps POST /api/demo/lamps         (lights 3 lamps + taught memories, then open the tower)
```

**Critical**: every `/api/*` and `/world.js` request requires the share cookie. Without
`?sharecode=...` the server returns **403**. A raw smoke test must first `GET /?sharecode=...`
and keep the `__wb_rsc` cookie.

---

## 3. Run / deploy

### Local

```bash
cd dorobot
DB_PATH=/tmp/roomi-dev.db ADMIN_KEY=testkey \
  node --experimental-sqlite server.js          # http://127.0.0.1:3000
```

Node 22+ is required (`node:sqlite`). The managed WorkBuddy node is:
`~/.workbuddy/binaries/node/versions/22.12.0/bin/node` — the system has no `node`.
`start.command` (double-click) does the same with the dev DB.

Health check: `curl --noproxy '*' http://127.0.0.1:3000/` → 200.
If you get **502** through a proxy, add `--noproxy '*'` (corporate/broker proxy).

### Deploy (already approved, no confirmation needed)

```
tool: workbuddy_sites_deploy
directory: <workspace>/dorobot
language:  node
domainPrefix: my-dorobot
startCmd:  DB_PATH=/tmp/dorobot-online.db node --experimental-sqlite server.js
```

After deploy, **verify by hash**, not by version text:

```bash
curl -s -c /tmp/c.txt "https://my-dorobot.app.workbuddy.host/?sharecode=M3SXYFV64Y" -o /dev/null
curl -s -b /tmp/c.txt "https://.../app.js?v=<current>" | shasum -a 256
shasum -a 256 public/app.js      # must match
```

If hashes differ, the deploy did not pick up your files — redeploy, don't guess.

---

## 4. Repository map

```
dorobot/
├── server.js              7,797 lines — Express app, ALL routes, DB schema + migrations, LLM layer
├── public/
│   ├── index.html         1,475 lines — all screens as <section class="screen">, modals at the bottom
│   ├── app.js             9,617 lines — screen router, chat UI, 3D room, shop, parent, admin glue
│   ├── world.js           6,266 lines — open-world 3D (village, NPCs, stars, quests)
│   ├── style.css          2,428 lines — single stylesheet, no preprocessor
│   ├── admin.html         standalone admin console
│   └── assets/            robot GLBs (78), room props, logo
├── docs/
│   ├── 技术文档.md         authoritative feature index + §14 «problem→design→evidence» table
│   ├── 数据库设计-全量-20261109.md   1,384-line DB design doc
│   └── 设计-*.md          game/world design docs (some are concepts only, NOT implemented)
├── AGENTS.md              short collaboration rules (memo protocol, Korean comments, checks)
├── CODEX_CONTEXT.md       OLD handoff (Oct 2026) — historical, do not trust numbers
├── package.json           only dependency: express ^5.2.1
├── start.command          local launcher
└── roomi.db               local dev DB (448 KB, stale; do not use as truth)
```

`docs/` is git-ignored upstream (the GitHub repo is code-only). Keep it locally.

---

## 5. Architecture

```
Browser (vanilla JS)
  ├─ index.html: <section id="screen-*"> + modals
  ├─ app.js: show(id) toggles .screen.hidden; chat panel; room 3D (Babylon engine `bjs`)
  └─ world.js: separate Babylon scene for the open world
        │  fetch JSON / SSE (X-Token header)
        ▼
Express 5 (server.js)
  ├─ authUser(req)  -> users row from X-Token
  ├─ route handlers: validation + SQL + rule decisions
  ├─ chat pipeline: buildChatContext() -> LLM (or rule) -> sanitize -> saveChatTurn()
  └─ SSE: /api/chat/stream (text/event-stream)
        │  node:sqlite (synchronous)
        ▼
SQLite  /tmp/dorobot-online.db   (56 tables + 1 view + 29 indexes)
```

Deliberate rule: **the LLM never decides** hint level, correctness, rewards, or streaks.
Those are server-side deterministic functions. The LLM only produces Korean text.

---

## 6. Database

### 6.1 Domains (56 tables)

| Domain | ~count | Representative tables |
|---|---|---|
| Identity / robot | 8 | `users`, `robots`, `robot_lines`, `robot_recalls`, `visits`, `user_memories`, `memory_lamps`, `learner_profile` |
| Learning | 11 | `chat_sessions`, `chat_messages`, `chat_analyses`, `chat_reports`, `learning_plans`, `review_cards`, `concept_mastery`, `knowledge_cards`, `learning_help_logs`, `weekly_topics`, `daily_quests` |
| Game / world | 12 | `game_logs`, `world_stars`, `world_quests`, `world_secrets`, `world_presence`, `world_lessons`, `village_props`, `sort_progress`, `treasure_claims`, `campaign_*` (3) |
| Social | 7 | `friendships`, `friend_messages`, `friend_blocks`, `friend_reports`, `cheers`, `guestbook`, `class_logs` |
| Economy | 6 | `items`, `inventory`, `cell_tx`, `weekly_sales`, `season_claims`, `seasons` |
| Ops / system | 12 | `llm_logs`, `daily_counters`, `mailbox`, `nudges`, `mood_logs`, `focus_sessions`, `thought_shards`, `weekly_goals`, `goal_claims`, `quest_logs`, `workshop_logs`, `interact_logs` |

### 6.2 Key tables (exact shapes)

```sql
users(id, nickname UNIQUE, cell_balance, created_at, friend_code, token,
      level, exp, streak, ...)
robots(id, user_id → users, name, template, palette JSON, personality, greeting, desc)
chat_sessions(id, user_id, day, mode, concept, stage DEFAULT 'L1',
              turns, stage_turns, stuck_type, summary, updated_at)
  UNIQUE(user_id, day, mode)
chat_messages(id, user_id, role, content, mode, hint_level, ts, follow_up)   -- append-only
chat_analyses(id, user_id, user_msg_id, ai_msg_id, day, mode, topic, subject,
              intent, sentiment, stuck, hint_level, solved, stuck_type)
user_memories(id, user_id, kind, key, value, confidence, source, created_at, updated_at)
  UNIQUE(user_id, kind, key)          -- kinds: taught, preference, fact, ...
memory_lamps(user_id, topic, lit_day, reinforce, crystal, immune_day, extra_decay,
             PRIMARY KEY(user_id, topic))
learning_plans(id, user_id, day, plan_json, source, created_at, UNIQUE(user_id, day))
review_cards(id, user_id, card_id, topic, question, options_json, answer,
             wrong_count, due_date, done, created_at)
concept_mastery(user_id, topic, score DEFAULT 0.3, attempts, correct, last_day,
                PRIMARY KEY(user_id, topic))
cell_tx(id, user_id, amount, source, ts)     -- ledger; source is a short tag
items(id, name, type, price, consumable, limited_days, sale_end)
inventory(id, user_id, item_id, qty)
daily_counters(user_id, day, kind, count, PRIMARY KEY(user_id, day, kind))
mailbox(id, user_id, title, body, cell, item_id, tag, claimed, ts)
world_stars(id, user_id, day, star, ts)
```

`v_chat_subject` is the only view (chat_analyses subject rollup).

### 6.3 Normalization

- 3NF baseline: definitions (`items`) vs ownership (`inventory`); session state
  (`chat_sessions`) vs utterances (`chat_messages`).
- **Two intentional denormalizations**, both documented in the thesis:
  1. `users.cell_balance` — materialized sum of `cell_tx`. Reads happen on every screen;
     writes go through one transaction (`grantCell` / `spendCell`) so it stays consistent.
  2. `memory_lamps` — derived from `user_memories(kind='taught')`, but stores `lit_day` so
     decay is O(1) instead of recomputed from history on every render.

Rule of thumb used in this codebase: **denormalize only when the value is (a) derivable,
(b) read far more than written, and (c) has one write path.**

### 6.4 Indexes (29)

Pattern: composite indexes lead with the equality column, then the sort column.

| Index | Serves |
|---|---|
| `idx_chat_user_ts(user_id, ts)` | last N messages |
| `idx_ca_user_day(user_id, day)` / `idx_ca_subject` | analysis rollups |
| `idx_review_due(user_id, done, due_date)` | today's review queue |
| `idx_mem_user(user_id, kind)` | taught memories |
| `idx_llm_user_ts(user_id, ts)` | today's token usage (**v1.75**) |
| `idx_mail_user(user_id)` / `idx_mail_tag` | mailbox list / unread tag lookup |
| `idx_presence_ts(ts)` | world presence TTL sweep |
| `idx_world_*`, `idx_quest_user`, `idx_game_daily`, … | per-feature daily rollups |

**Performance case study (used in the final presentation)**: 5,001 rows in `llm_logs`.

```sql
-- before: substr() disables the second index column -> 0.734 ms
WHERE user_id=? AND substr(ts,1,10)=?
-- after: range predicate uses both columns -> 0.021 ms (35x)
WHERE user_id=? AND ts>=? AND ts<?
EXPLAIN QUERY PLAN -> SEARCH llm_logs USING INDEX idx_llm_user_ts (user_id=? AND ts>? AND ts<?)
```

Same trap still exists in `chatCount()` and a few `chat_messages` stats (`substr(ts,1,10)`).
See §14.

### 6.5 Migrations

No migration framework. `server.js` runs `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
at boot, then opportunistic `ALTER TABLE ... ADD COLUMN` wrapped in `try{}`. New columns must be
additive and idempotent. **Never** drop a table on boot.

---

## 7. Learn loop

### 7.1 Chat state machine

`chat_sessions.stage` ∈ `L1 | L2 | L3 | confirm | teachback`.
`stage_turns` counts turns inside the current stage (resets to 1 when stage changes).

Rules (all server-side, see `buildChatContext` / `/api/chat`):

- First turn of a session is **always L1** (`finalLevel = 1`).
- Same stage for 2 turns → forced promotion (`wantLevel = baseLevel + 1`).
- The LLM may raise the level by **at most one** and can never lower it.
- `frustrated` (continuous "모르겠어") freezes the stage — **except** after 2 stage-turns,
  where promotion is forced so the child does not loop in reassurance forever (v1.78).
- `gotIt` → stage becomes `confirm`; after L3 the UI offers "내 말로 설명하기" (`teachback`).

**v1.78 change — L1 does not call the LLM at all.** The SSE handler returns the card's
`hint_l1` verbatim:

```
같이 생각해 보자. {hint_l1}
```

This is why the token cost page can claim "L1 = 0 model calls". Do not "optimize" this back
into an LLM call; the model kept ignoring the instruction and explaining the concept.

### 7.2 Intent routing — when to answer, when to guide

`routeLearnIntent(msg, sess)` returns `direct | guide`:

| Condition | Route |
|---|---|
| `/(그냥|바로|정답|답만|답을|알려줘|가르쳐줘|답이 뭐|답은)/` | **direct** |
| Message mentions the current `sess.concept` (or its aliases) | **guide** |
| `/(뭐야|뭔가요|무엇|왜|어떻게|어디서|언제|누구|얼마|뜻|의미|차이|원리)/` | **direct** |
| anything else | **guide** |

`direct` turns:
- use `DIRECT_RULE` in the system prompt (explain in 2 sentences, still end with a question),
- return `hintLevel: null` (no badge in the UI),
- **do not advance `stage_turns`** (they must not pollute the learning ladder).

The user can override routing with the UI chip (`style` in the request body):

| `style` | Behaviour |
|---|---|
| `auto` (default) | the table above |
| `guide` | force L1→L3 |
| `direct` | force a direct answer |

Front-end: `#chat-style` chips, only visible in `learn` mode, persisted in
`localStorage.roomi_answer_style`.

### 7.3 Memory lamps & fog

Lamp is lit when:
- the child completes teach-back (`/api/chat/explain`), or
- the child wins "루미가 틀려볼게" (`POST /api/teach/challenge`).

Decay is a **pure function of the date** (`fogDecay`):

```
d = days between lit_day and today
d=1 → 10   d=2 → 25   d=3 → 45   d>=4 → 45 + (d-3)*10   (cap 100)
crystal=1 → 0        immune_day = today → 0
extra_decay (0..50) is added, final clamp 100
```

Effects:
- `decay >= 60` → the lamp's concept is injected into the learn prompt as "루미가 가물가물해" (the robot
  asks the child to re-teach it).
- `decay >= 50` → once per day, `/api/robot/hello` mentions it.
- `decay >= 50` → one SOS mail per day (`daily_counters kind='fog_sos'`, tag `fog:<day>`).
- **v1.81 (bug 1 fix):** `reinforce` +1 only on a *spaced* re-teach (lit_day ≠ today). Three same-day
teach-backs stay at reinforce 1 and never crystallize. Three spaced re-teaches → `reinforce=3` → `crystal=1`
(permanent immunity) + a crystal prop in the village.

**v1.81 spacing:** the decay step table is applied to `floor(days / stability)`, where
`stability = 2^(reinforce-1)` (×1.5 if mastery ≥ 0.75, cap 6). A fresh lamp decays exactly as before.

**v1.81 tower recall:** a correct tower answer sets `lit_day = today` and `extra_decay = 0` (crystals keep
their date). A lamp already at decay 100 gives a **rescue floor**: a miss there is penalty-free and does not
end the day.

Do **not** award cells for lighting lamps (economy ceiling, §8).

### 7.4 Tower of Fog (`안개 속의 탑`)

- Entry: `/api/tower/today`; needs ≥1 lamp, otherwise 404 with a friendly message.
- Deck is fixed per day: `daily_counters kind='tower_deck'` stores the floor layout so GET and
  POST agree (same tower all day). 4–6 floors; weekends add a BOSS floor (concept transplant).
- Each floor: a statement is either **the robot's original words** or **fog-distorted**.
  The child picks `original` / `fogged`. Wrong answer ends the day (`tower_ended=1`).
- Correct floor sets `immune_day = today` on that lamp (the shield icon in the UI).
- `POST /api/tower/answer` returns `{correct, expected, why, clearedMask, ended}` — `why` explains
  the real sentence. Do not leak `hint_l3` into the deck.

### 7.5 Plan / review / mastery

- `concept_mastery.score` is 0..1 (ELO-ish). Event weights (`bumpMastery`): stuck ×0.75, wrong ×0.85,
  correct +0.10, review +0.15, **lesson +0.10 (teach-back — only when the explanation is verified, v1.81)**,
  solved +0.08 (self-report, once per concept per day, v1.81).
  Teach-back verification: `checkTeachBack` — LLM yes/no when available, otherwise a card-keyword rule (≥2 hits).
  Unverified explanations still light the lamp (no grading on the child screen) but are stored as
  `source='explain:unverified'`, confidence 0.4, and never become the tower's "original" sentence.
- `learning_plans.plan_json` = `{focus, steps:[{id,title,minutes,done}]}` for the day.
  Regeneration is capped at 2/day (`daily_counters kind='plan_refresh'`).
- `/api/next-action` returns one step: mood-first → tower (if lamps) → weakest concept → review due.
- `review_cards.due_date` uses a 3-day cycle; wrong cards get pushed forward, not deleted.

---

## 8. Economy (cells)

- Ledger: `cell_tx(user_id, amount, source, ts)`. Materialized: `users.cell_balance`.
- `grantCell(uid, amount, source)` and `spendCell(uid, amount, source)` are the only writers.
  Spending uses a conditional `UPDATE ... WHERE cell_balance >= ?` to stay atomic.
- **Daily income ceiling 393**, below the cheapest one-off item (400). Any new reward must be
  added to that budget — recompute before shipping.
- Limited items: `items.sale_end` (ISO day). Weekly sales: `weekly_sales`.
- **Never grant cells for a new system** without re-doing the ceiling math.

---

## 9. LLM layer

```
callLLM(messages, opts)
  1. K-EXAONE 2.5   (reasoning_effort:low, max_tokens>=700)
  2. DeepSeek       (fast, cheap)
  3. rule preset    (deterministic Korean lines)
```

- `LLM_FORCE_FAST` defaults to `'1'`: DeepSeek first for every mode, EXAONE as last resort.
  Set `LLM_FORCE_FAST=0` to prefer quality (EXAONE) again.
- Per-provider **circuit breaker**: a 429 opens a 10-minute cooldown for that provider only.
- `llm_logs` records `prompt_tokens, completion_tokens, total_tokens, prompt_chars, model, ts`.
  `GET /api/llm/usage` returns today/week/avg-per-turn, so the cost claim is measured, not estimated.
- Prompt composition (`buildChatContext`):
  robot persona → mode rule → `[이번 대화] 목표/단계` → session memo (≤180 chars) →
  stuck type → interest → knowledge card (only the current level's line) → memory top-1 →
  output contract.
- Streaming (`/api/chat/stream`) deliberately outputs **plain text, no JSON**, because the server
  owns `hintLevel`. `res.on('close')` (not `req`) is the disconnect signal. If no delta arrives
  within the timeout, fall back; if any delta arrived, never switch providers mid-stream.
- All output passes `isSafeText` + `sanitizeLine`; `limitSentences` caps learn replies at 2
  sentences / 90 chars.

Cost history: 955 → 434 tokens/turn (−55%) after v1.52–v1.66; L1 now costs 0 calls.

---

## 10. Frontend

- **Screens**: every screen is `<section id="screen-<name>" class="screen hidden">`; `show(name)`
  toggles `.hidden`, top bar, sidebar, and the chat FAB. Names: `start`, `myroom`, `games`,
  `workshop`, `shop`, `mail`, `friends`, `board` (report/parent), `settings`.
- **Layout 3.0**: 250px sidebar (collapses to **80px** when not hovered) + top bar + `#content`.
- **Chat**: `#chat-panel`; modes `chat|learn|reflect`; chips `#chat-style` (auto/guide/direct).
  Streams via `chatStreamRequest` (SSE), 60s idle timeout, barge-in via `getUserMedia` RMS.
- **3D room**: `bjs` engine, `rebuildRobot()` builds the robot from `template` + `palette`.
  Eye layers use `layerMat` (diffuse/emissive/ambient all **1.0** — 0.3 makes eyes gray, v1.77).
  Robot gestures: `focus` (walk to the child + tilt 0.18rad + book prop), `cheer` (1.6s hop),
  `nod`, `bounce`. **Never touch `lookY`** — eyes disappear.
- **World**: `world.js`, open village with NPC schedule (well 06–11, windmill 12–16, bell tower 17–21),
  stars (`world_stars`), secrets, quests, campaign props.
- **Avatar/badge**: `botBadgeSVG(template, pal)` is the **only** icon function for small boxes
  (40px). Do not feed full-body `robotSVG` into 40px containers (it was the gray-block bug).
- **Cache busting**: three `?v=` refs in `index.html` must always be identical.

---

## 11. API map (148 routes, 138 unique)

| Prefix | # | Notes |
|---|---|---|
| `/api/admin/*` | 16 | fail-closed, `X-Admin-Key`, timing-safe compare |
| `/api/world/*` | 14 | stars, quests, secrets, presence, NPC lessons |
| `/api/parent/*` | 10 | guardian dashboard, error patterns, weekly report |
| `/api/friends/*` | 10 | codes, messages, cheers, blocks, reports |
| `/api/chat/*` | 9 | `POST /api/chat`, `POST /api/chat/stream`, `POST /api/chat/explain`, analysis, schema |
| `/api/account/*` | 4 | nickname, transfer, delete (wipes 45 tables) |
| `/api/workshop/*` | 4 | paint, personality, ask |
| `/api/memory/*` | 4 | list/forget/recall |
| `/api/campaign/*` | 4 | events, facilities, journal |
| `/api/user`, `/api/robots`, `/api/robot/*` | 6 | `GET /api/user` returns `{user, teach_count}` |
| `/api/plan`, `/api/goals`, `/api/review` | 6 | today's plan, weekly goals, due cards |
| `/api/lamps`, `/api/tower/*` | 4 | lamps list, today's deck, answer |
| `/api/shop/*`, `/api/mailbox/*` | 6 | buy/equip, claim mail |
| `/api/llm/usage`, `/api/rank/*`, `/api/season/*` | 7 | cost, leaderboard, seasons |
| `/api/demo/*` | 2 | `seed`, `lamps` |

Auth: `X-Token` header (from `POST /api/user`). `authUser` returns the user or `null`; every
protected route returns 401 with a Korean message.

---

## 12. Verification

There is **no unit-test framework**. Verification is black-box scripts + a 442-assertion smoke.

```bash
# local API + UI regressions (in /tmp, Playwright core + Chrome)
node /tmp/v167_browser.mjs        # layout (6)
node /tmp/v172_browser.mjs        # guide modal + demo lamps (5)
node /tmp/smoke1121_ui.mjs        # lamps/tower/world (4)
node /tmp/companion58_browser.mjs # robot companion (9)
node /tmp/week59_browser.mjs      # weekly panel (7)

# online full smoke (needs share cookie)
node /tmp/dorobot-online-verify.mjs     # -> ONLINE 442 PASS / 0 FAIL  (v1.80 run)

# v1.81 — repo-local regression (throwaway DB, ROOMI_TEST_NO_LLM=1 → rule fallback only, no API calls)
npm test                                # node --experimental-sqlite tests/regression.mjs → 21/21
# NOTE: the test forces the rule fallback, so it still passes when the LLM keys are absent.
```

Traps that cost hours:

- **Sharecode cookie**: the smoke script keeps `__wb_rsc`; a bare `fetch` gets 403.
- **Playwright `:last-of-type`** matches every `.msg-meta`; use `$$eval` with the last index.
- **Sandbox HTTP broker**: parallel local browser tests can hit `write EPIPE` and GLB 500s.
  Do visual checks against the **online** URL instead.
- **`bjs.ready`** may be false for a fresh account without a robot — create one first
  (`POST /api/robots`).
- **Token** lives in `localStorage.roomi_token`; tests must read the current value.
- Local SQLite writes from two processes: use `busy_timeout` and retry.

---

## 13. Conventions

1. **All code comments in Korean.** Keep technical terms/identifiers as-is.
2. Bump **all three** `?v=` refs in `index.html` together, plus the visible `<em class="ver">vX.Y</em>`.
3. After any change: `node --check server.js public/app.js` before deploying.
4. Deploy is pre-approved (see §3). Deploy, then **verify hashes**, then run the online smoke.
5. DB writes go through `saveChatTurn()` for chat (single write point) and `grantCell`/`spendCell`
   for money. Do not invent parallel writers.
6. Korean user-facing copy: keep it short (2 sentences), warm, and never scold.

---

## 14. Known issues / tech debt

| Issue | Impact | Notes |
|---|---|---|
| `substr(ts,1,10)` in `chatCount` / message stats | index only uses `user_id`, scans the day | fix by range predicate, same as v1.75 |
| `weekStartKST()` defined twice | dead code | harmless |
| `cell_tx.created_at` vs `ts` naming | one starfall counter reads the wrong column | see docs |
| `RP_ZONES` / `rpCfg()` / `powerMax` in `app.js` | unused half-patch from v1.46 | no runtime effect; delete or finish |
| Tower L3 fallback in streaming | `c.focusCard.hint_l3` may be empty → generic line | acceptable, could pass `cards[0]` |
| Prod DB in `/tmp` | lost if the instance is recreated | acceptable for a demo; document it |
| Mobile <760px hides `.side-tools` | sound/reset/settings unreachable | intentional for now |
| `roomi.db` in repo | stale 448 KB dev DB | do not treat as schema truth |
| **v1.81** tower answers are predictable | a sentence with a flip word (같으면, 모두…) is *always* fogged, so «원래 말» is almost never right | fix: seeded coin so ~50% of floors are unfogged |
| **v1.81** parent PIN = child login PIN | `pin_hash` is shared by child PIN login and the parent gate | product decision: separate parent PIN |
| **v1.81** no two-lives tower / review-card link | a tower miss still ends the day (except rescue floors); review cards only come from wrong puzzles | planned, see roadmap |
| **v1.81** letter email not sent | `nodemailer` not in package.json; SMTP env unset → dashboard shows a preview only | opt-in, documented in roadmap |

---

## 15. Next tasks (in order)

1. **Range-predicate cleanup**: replace remaining `substr(ts,1,10)` filters with
   `ts >= day AND ts < nextDay` (chatCount, message stats). Add `idx_chat_user_day` if needed.
2. **Tower surface**: currently inside the room tab; consider promoting to `오늘 할 일` when lamps ≥ 3
   (already partly done in v1.71.2 — verify on mobile).
3. **Parent report**: add "what to say tonight" 3 lines (data exists: `chat_analyses` + `mood_logs`).
4. **Delete or finish** the `RP_ZONES` remnant.
5. **PPT assets**: the final deck lives in `output/RooMi_Final_Presentation/` (13 slides, Korean,
   academic style); keep numbers in sync with §2 and §6.4.

---

## 16. Never do

- ❌ Give cells for a new system without recomputing the 393/day ceiling.
- ❌ Let the LLM decide hint level, correctness, streaks, or rewards.
- ❌ Put a full-body `robotSVG` (200×250) into a 40px container — use `botBadgeSVG`.
- ❌ Touch `lookY` on the 3D eyes (they vanish).
- ❌ Use `disableLighting` alone on eye materials (they turn black — use emissiveTexture).
- ❌ Add a second writer for `cell_balance` or `chat_sessions`.
- ❌ Deploy without comparing `sha256` of `app.js` / `style.css` against the live URL.
- ❌ Assume `docs/*.md` design files are implemented — several are concepts only (check §14 of
  `技术文档.md`).

---

*End of handoff. If something here contradicts the code, the code wins — then update this file.*
