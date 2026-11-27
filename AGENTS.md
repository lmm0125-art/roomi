# AGENTS.md — 项目协作约定

> **New to this repo? Read `HANDOFF.md` first** — full English handoff verified at v1.80 (2026-11-27).


## 每次会话开始（不用用户提醒）

1. 先读 `.context/memo.md` 与 `.context/tasks.md`，或直接运行：

   ```bash
   python3 ~/.workbuddy/skills/context-memo/scripts/memo.py show
   ```

2. 只回一句「已读：目标… / 下一步… / 阻塞…」，不要重述历史、不要复述整份 memo。
3. 之后每轮只带 memo + 最近 2 条，不重新读全部对话。

## 编号约定

- 用户说 `2-1` 就只改 `2-1`，不动其他条目。
- `[locked]` 的条目未解锁前不改；要改先问一句。
- 变更后必须更新 `.context/memo.md` 的「已决定 / 下一步」，并在 `log.md` 留一行。

## 代码约定

- 代码注释一律韩语（技术术语、专有名词保留原文）。
- 提交前跑 `node --check server.js public/app.js`。
- `.context/` 已被 `.gitignore` 排除，不要提交。
- 部署：`workbuddy_sites_deploy`，`domainPrefix=my-dorobot`，`DB_PATH=/tmp/dorobot-online.db node --experimental-sqlite server.js`。

## 当前状态

以 `.context/memo.md` 为准，不要在这里维护第二份状态。
