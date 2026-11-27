// ============================================================
// 루미 (RooMi) — IC-PBL Prototype Server
// 스택: Node 22 내장 SQLite(node:sqlite) + Express
// 설명: DB는 39개 테이블(기본 15 + 학습/기억/퍼즐/시즌/로그/친구/계획/목표/안전/보상/복습/마을/리텐션
//       + 2026-11-04 학습 동행 2.0 의 nudges·mood_logs·focus_sessions·season_claims 4개).
//       AI 대사는 우선 규칙 엔진으로 처리하고, LLM 은 DeepSeek 단일(deepseek-chat)로 호출한다.
//       신규 기능은 LLM 호출을 늘리지 않고 기존 로그를 결정론 규칙으로 집계한다(자세한 내용은 docs/기술문서.md v1.27).
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// DB 경로: 환경변수 DB_PATH 우선(배포 시 데이터 보존용), 기본은 프로젝트 폴더
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'roomi.db'));
// ★ v1.53: 배포 재시작 때 이전 프로세스가 잠깐 DB 를 쥐고 있으면 «database is locked» 로 죽는다.
//   WAL 로 읽기/쓰기 충돌을 줄이고, 잠금은 최대 8초 기다린다(그 사이 이전 프로세스가 종료된다).
try{ db.exec('PRAGMA busy_timeout=8000'); }catch(e){}
try{ db.exec('PRAGMA journal_mode=WAL'); }catch(e){}
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 1. 테이블 생성 (31개) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT UNIQUE NOT NULL,
  cell_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+9 hours'))
);
CREATE TABLE IF NOT EXISTS robots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  palette TEXT NOT NULL,
  personality TEXT NOT NULL,
  greeting TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours'))
);
CREATE TABLE IF NOT EXISTS robot_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personality TEXT NOT NULL,
  situation TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cell_tx(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
);
CREATE TABLE IF NOT EXISTS daily_quests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_date TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  reward INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quest_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  quest_id INTEGER NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours')),
  reward INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  entered_at TEXT DEFAULT (datetime('now','+9 hours')),
  duration INTEGER DEFAULT 0
);
`);

// ★ 2026-10-29: 친구 코드(개인정보 없이 6자리로 연결)
try{ db.exec('ALTER TABLE users ADD COLUMN friend_code TEXT'); }catch{}
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code)'); }catch{}

// ---------- 1-B. 마이그레이션 (기존 DB 호환): 컬럼 추가 + 유니크 제약 ----------
// 컬럼 추가는 try/catch 로 감싸 "이미 존재" 오류를 무시한다(재실행 안전).
try{ db.exec('ALTER TABLE users ADD COLUMN token TEXT'); }catch{}

// ★ P0-2 성장 시스템: 레벨·경험치·연속 방문(스트릭)·성장 단계
try{ db.exec('ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN exp INTEGER NOT NULL DEFAULT 0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN last_visit TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN revive_streak INTEGER'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN revive_until TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN parent_ok INTEGER NOT NULL DEFAULT 0'); }catch{}

// ★ P0-5 경제 확장: 소지품(1회 보유) / 소모품(반복 구매) 구분
try{ db.exec('ALTER TABLE items ADD COLUMN consumable INTEGER NOT NULL DEFAULT 0'); }catch{}

// ★ V11 주간(주말) 한정 아이템: '0,6' = 일·토 에만 판매. NULL = 상시 판매
try{ db.exec('ALTER TABLE items ADD COLUMN limited_days TEXT'); }catch{}

// ★ V12 이번 주 주제 — AI 과제를 세계관/수업과 연결한다(평가기준 ③창의성).
//   운영자(교사)가 주차별로 바꿔 넣을 수 있고, 지정이 없으면 도로랜드 챕터가 자동 순환한다.
db.exec(`CREATE TABLE IF NOT EXISTS weekly_topics(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  chapter INTEGER NOT NULL DEFAULT 1,
  topic TEXT NOT NULL,
  keywords TEXT,
  created_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_week ON weekly_topics(week_start)'); }catch(e){}
// 어떤 주제로 물어본 질문이었는지 기록해 두면 효과 검증 때 주제별 분석이 가능하다
try{ db.exec('ALTER TABLE daily_quests ADD COLUMN topic TEXT'); }catch{}

// ============================================================
// ★ V15 — 실행방안 대조에서 나온 P0 3건을 채운다
//   P0-4 우편함(회사 5탭 중 누락) · P0-3 수업도 콘텐츠(3대 기대효과 ②) · P0-1 공작소(회사 최우선 요구)
// ============================================================

// ★ P0-4 우편함 — 보상과 공지를 '담아 두고 아이가 직접 여는' 구조.
//   즉시 지급만 하면 아이가 우편함을 볼 이유가 없다. 수령(claim) 방식이라 로그인 동기가 하나 늘어난다.
//   tag 는 '종류+주차' 같은 고유 키로, 같은 보상이 두 번 발송되는 것을 막는다.
db.exec(`CREATE TABLE IF NOT EXISTS mailbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  cell INTEGER NOT NULL DEFAULT 0,
  item_id INTEGER,
  tag TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_mail_user ON mailbox(user_id, claimed)'); }catch(e){}
// tag 가 NULL 인 행(운영자 공지 등)은 중복 허용. SQLite 는 NULL 을 유일성 비교에서 제외한다.
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_tag ON mailbox(user_id, tag)'); }catch(e){}

// ★ P0-3 수업도 콘텐츠 — 수업 출석으로도 셀을 받는다(회사 3대 기대효과 ②).
//   주 1회 제한을 UNIQUE 로 강제한다: 코드를 알아도 같은 주에 두 번은 못 받는다.
db.exec(`CREATE TABLE IF NOT EXISTS class_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_class_week ON class_logs(user_id, week_start)'); }catch(e){}

// ★ P0-1 공작소 — 색칠 변경 / AI 성격 재생성의 일일 사용 기록(남용 방지).
//   같은 day+kind 는 1회만 → UNIQUE 로 강제(동시 요청도 통과 못 함).
db.exec(`CREATE TABLE IF NOT EXISTS workshop_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_daily ON workshop_logs(user_id, day, kind)'); }catch(e){}

// 운영자(교사)가 알려주는 수업 출석 코드. 발표/운영 시 바꿀 수 있게 환경변수로 열어 둔다.
const CLASS_CODE = process.env.CLASS_CODE || '1004';
const CLASS_REWARD = 100;          // 수업 참여 보상(셀) — 하루 과제(+30)보다 큼: '수업도 콘텐츠' 임을 금액으로 보여준다
const CLASS_ATTEMPT_LIMIT = 5;     // 코드 오입력 시도 제한(찾기 공격 방지)

// ★ P0-4 오버플레이 방지: 일일 플레이타임 상한(분). 0 = 무제한
try{ db.exec('ALTER TABLE users ADD COLUMN play_minutes INTEGER NOT NULL DEFAULT 0'); }catch{}
// ★ 2026-10-28: 학부모 승인 시 +20분(최대 +40분) 연장. 날짜가 바뀌면 0으로 리셋.
try{ db.exec('ALTER TABLE users ADD COLUMN play_bonus INTEGER NOT NULL DEFAULT 0'); }catch{}
try{ db.exec('UPDATE users SET play_bonus=20 WHERE parent_ok=1 AND play_bonus=0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN play_day TEXT'); }catch{}

// ★ P1-3 인터랙션 일일 횟수 제한용 로그
// 주의: (user_id,day,situation)에 UNIQUE 를 걸면 안 된다.
  //       요청마다 1행씩 쌓는 횟수 카운터용이라 중복이 정상인데,
//       유니크를 걸면 2회차부터 INSERT 가 실패해 카운트가 영구히 1이 되고
//       일일 한도(5회)가 영영 걸리지 않는다. 일반 인덱스로만 둔다.
db.exec(`CREATE TABLE IF NOT EXISTS interact_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  situation TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('DROP INDEX IF EXISTS idx_interact_daily'); }catch(e){}
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_interact_daily ON interact_logs(user_id,day,situation)'); }catch(e){ console.log('⚠️ interact_logs index:', e.message); }

// 중복 로봇/중복 퀘스트 로그 정리 후 유니크 인덱스 (경제 시스템 무결성)
db.exec("DELETE FROM robots WHERE id NOT IN (SELECT MAX(id) FROM robots GROUP BY user_id)");
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_robots_user ON robots(user_id)'); }catch(e){ console.log('⚠️ robots unique index:', e.message); }
// ★ AI 가 만든 «성격 소개(desc)» 를 저장한다 — 예전엔 생성 응답에만 담기고 버려져,
//   다시 들어오면 소개가 사라졌다. desc 는 SQLite 예약어라 큰따옴표로 감싼다(멱등 마이그레이션).
try{ db.exec('ALTER TABLE robots ADD COLUMN "desc" TEXT'); }catch(e){ /* 이미 있으면 무시 */ }
db.exec("DELETE FROM quest_logs WHERE id NOT IN (SELECT MAX(id) FROM quest_logs GROUP BY user_id, quest_id)");
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_user ON quest_logs(user_id, quest_id)'); }catch(e){ console.log('⚠️ quest_logs unique index:', e.message); }
// ★ P2-1 visits 인덱스 (통계 쿼리 전표 스캔 방지)
// ★ 미니게임 기록(하루 1회 보상 지급의 근거). quest_logs 와 분리해 과제 통계 오염을 막는다.
db.exec(`CREATE TABLE IF NOT EXISTS game_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  reward INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_game_daily ON game_logs(user_id,day,kind)'); }catch(e){ console.log('⚠️ game_logs index:', e.message); }

// ★ v1.46 «빛의 병 정리» 진행도. 셀은 지급하지 않는다 — 보상은 레벨·별·기록 자체다.
//   일 수입 상한 393셀 < 일회성 상품 400셀 이므로 새 게임에 셀을 얹으면 하루에 매대가 비는
//   회귀가 생긴다(v1.44 교훈). 대신 «진행도» 를 서버에 남겨 기기 간 이어하기 + 발표 증거로 쓴다.
db.exec(`CREATE TABLE IF NOT EXISTS sort_progress(
  user_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 1,
  total_stars INTEGER NOT NULL DEFAULT 0,
  best_stars TEXT NOT NULL DEFAULT '{}',
  plays INTEGER NOT NULL DEFAULT 0,
  wanders INTEGER NOT NULL DEFAULT 0,
  hints_earned INTEGER NOT NULL DEFAULT 0,
  missions INTEGER NOT NULL DEFAULT 0,
  shards INTEGER NOT NULL DEFAULT 0,
  surges INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  day TEXT,
  updated_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);
// ★ v1.47: 이미 배포된 DB 에 컬럼을 추가한다(신규 설치는 위 DDL 로 끝난다).
for(const col of ['missions','shards','surges','best_streak']){
  try{ db.exec(`ALTER TABLE sort_progress ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); }catch(e){ /* 이미 있으면 무시 */ }
}

// visits.last_beat: 체류시간 중복 누적 방지를 위한 마지막 기록 시각(마이그레이션)
try{ db.exec('ALTER TABLE visits ADD COLUMN last_beat INTEGER'); }catch(e){ /* 이미 있으면 무시 */ }

try{ db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id, entered_at)'); }catch(e){ console.log('⚠️ visits index:', e.message); }


// ============================================================
// ★ 2026-10-27 — LLM 학습 대화 / 방 상태 / 퍼즐 / 시즌
// ============================================================
try{ db.exec('ALTER TABLE users ADD COLUMN understanding INTEGER NOT NULL DEFAULT 0'); }catch{}

// 단기 기억: 최근 대화. 30일 보관, 계정 삭제 시 함께 삭제.
db.exec(`CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  hint_level INTEGER,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_chat_user_ts ON chat_messages(user_id, ts)'); }catch(e){}
// 30일 지난 대화는 서버 시작 시 정리한다(개인정보 최소화).
try{ db.prepare("DELETE FROM chat_messages WHERE ts < datetime('now','+9 hours','-30 days')").run(); }catch(e){}

// ★ v1.40 «대화 저장 → 분석» — 원문은 chat_messages, 분석 결과는 chat_analyses(1턴 1행),
//   일별 집계는 chat_reports. «모든 대화» 가 이 파이프라인을 통과하도록 saveChatTurn() 으로 단일화했다.
//   고아 분석행을 막기 위해 DELETE 시 함께 지우고, 재집계(rebuild) 가 가능하도록 UNIQUE(user_msg_id).
db.exec(`CREATE TABLE IF NOT EXISTS chat_analyses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_msg_id INTEGER NOT NULL,
  ai_msg_id INTEGER,
  day TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  topic TEXT,
  subject TEXT,
  intent TEXT,
  sentiment TEXT,
  stuck INTEGER NOT NULL DEFAULT 0,
  hint_level INTEGER,
  solved INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  reply_len INTEGER NOT NULL DEFAULT 0,
  reply_has_hint INTEGER NOT NULL DEFAULT 0,
  reply_has_praise INTEGER NOT NULL DEFAULT 0,
  keywords TEXT,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_msg_id),
  FOREIGN KEY(user_msg_id) REFERENCES chat_messages(id)
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_ca_user_day ON chat_analyses(user_id, day)'); }catch(e){}
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_ca_subject ON chat_analyses(user_id, subject)'); }catch(e){}
db.exec(`CREATE TABLE IF NOT EXISTS chat_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  user_words INTEGER NOT NULL DEFAULT 0,
  stuck_count INTEGER NOT NULL DEFAULT 0,
  solved_count INTEGER NOT NULL DEFAULT 0,
  hint_sum INTEGER NOT NULL DEFAULT 0,
  top_subject TEXT,
  top_intent TEXT,
  mood TEXT,
  summary TEXT,
  updated_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day)
)`);
// 주제별 집계는 «뷰» 로 둔다 — 저장하지 않고도 최신 분석 결과를 SQL 한 줄로 읽는다(중복 데이터 없음).
db.exec(`CREATE VIEW IF NOT EXISTS v_chat_subject AS
  SELECT user_id, subject, COUNT(*) AS turns,
         SUM(stuck) AS stuck_count, SUM(solved) AS solved_count,
         ROUND(AVG(word_count), 1) AS avg_words
  FROM chat_analyses
  WHERE subject IS NOT NULL
  GROUP BY user_id, subject`);

// LLM 호출 로그(비용/지연 모니터링). 민감정보 없음.
db.exec(`CREATE TABLE IF NOT EXISTS llm_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  mode TEXT,
  model TEXT,
  latency_ms INTEGER,
  ok INTEGER DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  prompt_chars INTEGER,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
// ★ v1.52 «적게 쓰기» — 이미 배포된 DB 에 토큰 계측 컬럼을 더한다.
for(const col of ['prompt_tokens','completion_tokens','total_tokens','prompt_chars']){
  try{ db.exec(`ALTER TABLE llm_logs ADD COLUMN ${col} INTEGER`); }catch(e){}
}
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_logs(ts)'); }catch(e){}
// ★ v1.75: «user_id + ts» 복합 인덱스. 기존 단일(ts) 로는 user 필터 + substr(ts,1,10) 를 못 탄다.
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_llm_user_ts ON llm_logs(user_id, ts)'); }catch(e){}

// 장기 기억: 학습자 프로필.
db.exec(`CREATE TABLE IF NOT EXISTS learner_profile(
  user_id INTEGER PRIMARY KEY,
  understanding INTEGER NOT NULL DEFAULT 0,
  weak_topics TEXT,
  hint_style TEXT,
  last_summary TEXT,
  updated_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);
// ★ 2026-10-28: 학습 선호(하루 시간/선호 시간대/관심 주제/난이도)
try{ db.exec("ALTER TABLE learner_profile ADD COLUMN pref_minutes INTEGER NOT NULL DEFAULT 10"); }catch{}
try{ db.exec("ALTER TABLE learner_profile ADD COLUMN pref_time TEXT NOT NULL DEFAULT 'afternoon'"); }catch{}
try{ db.exec("ALTER TABLE learner_profile ADD COLUMN pref_subjects TEXT NOT NULL DEFAULT ''"); }catch{}
try{ db.exec("ALTER TABLE learner_profile ADD COLUMN pref_difficulty TEXT NOT NULL DEFAULT 'normal'"); }catch{}
try{ db.exec("ALTER TABLE learner_profile ADD COLUMN friend_chat_enabled INTEGER NOT NULL DEFAULT 1"); }catch{}

// RAG-lite 지식 카드: 벡터DB 없이 topic/tags 매칭.
db.exec(`CREATE TABLE IF NOT EXISTS knowledge_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  chapter INTEGER DEFAULT 1,
  concept TEXT NOT NULL,
  analogy TEXT,
  example TEXT,
  hint_l1 TEXT,
  hint_l2 TEXT,
  hint_l3 TEXT,
  quiz TEXT,
  tags TEXT
)`);

// 학습 도움 기록: solved=1 이면 '스스로 해결'.
db.exec(`CREATE TABLE IF NOT EXISTS learning_help_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  subject TEXT,
  level INTEGER DEFAULT 1,
  solved INTEGER DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_help_user_day ON learning_help_logs(user_id, day)'); }catch(e){}

// ★ 2026-10-28: AI가 하루 계획을 짜서 저장(사용자/날짜당 1개).
db.exec(`CREATE TABLE IF NOT EXISTS learning_plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  source TEXT DEFAULT 'ai',
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day)
)`);

// ★ 2026-10-28: 주간 목표(주 시작일당 1개).
db.exec(`CREATE TABLE IF NOT EXISTS weekly_goals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  goals_json TEXT NOT NULL,
  source TEXT DEFAULT 'ai',
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, week_start)
)`);
// ★ 2026-10-31: 주간 목표 달성 보상 수령 기록(주 1회)
db.exec(`CREATE TABLE IF NOT EXISTS goal_claims(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, week_start)
)`);
// ★ 2026-10-31: 3일 뒤 복습 카드(틀린 문제)
db.exec(`CREATE TABLE IF NOT EXISTS review_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  topic TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 1,
  due_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, card_id, due_date)
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_review_due ON review_cards(user_id, done, due_date)'); }catch{}

// ---- AI 마을 학습 스테이션 (2026-11-02) ----
//   마을 외곽 3곳의 «지혜의 샘» 에서 하루 1문제씩. 지식카드(quiz) 를 결정론적으로 배정한다.
// ---- 마을 성장 · 방명록 (2026-11-03) ----
db.exec(`CREATE TABLE IF NOT EXISTS village_props(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prop_key TEXT NOT NULL,
  granted_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, prop_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS treasure_claims(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  spot INTEGER NOT NULL,
  claimed_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day, spot)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS guestbook(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user INTEGER NOT NULL,
  from_user INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_gb_to ON guestbook(to_user, id DESC)'); }catch{}

db.exec(`CREATE TABLE IF NOT EXISTS world_lessons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  station INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  solved INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day, station)
)`);
// ★ 2026-10-31: AI 전용 장기 기억(사용자별 1개, 대화 기록과 별도로 증류 저장)
db.exec(`CREATE TABLE IF NOT EXISTS user_memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  source TEXT DEFAULT 'chat',
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  updated_at TEXT DEFAULT (datetime('now','+9 hours')),
  last_used_at TEXT,
  expires_at TEXT,
  UNIQUE(user_id, kind, key)
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_mem_user ON user_memories(user_id, kind)'); }catch{}
// ★ v1.63: «네가 가르쳐 준 거» 를 하루 한 번만 되묻기 위한 기록(LLM 없음).
db.exec(`CREATE TABLE IF NOT EXISTS robot_recalls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  concept TEXT,
  UNIQUE(user_id, day)
)`);

// ★ v1.51 «한 번의 대화에도 목표와 단계가 있다» — 힌트 단계는 LLM 의 즉흥 판단에 맡기지 않는다.
//   stage: L1 되묻기 → L2 비유 → L3 다음 단계 → confirm(확인) → teachback(설명). 같은 단계 2턴이면 강제 승급.
db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  concept TEXT,
  stage TEXT NOT NULL DEFAULT 'L1',
  turns INTEGER NOT NULL DEFAULT 0,
  stage_turns INTEGER NOT NULL DEFAULT 0,
  stuck_type TEXT,
  summary TEXT,
  updated_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day, mode)
)`);
// ★ v1.52: «대화 메모» — 6턴짜리 원문을 다시 넣지 않고, 4줄 요약만 다음 턴에 넘긴다.
try{ db.exec('ALTER TABLE chat_sessions ADD COLUMN summary TEXT'); }catch(e){}
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_cs_user ON chat_sessions(user_id, day)'); }catch{}

// ★ 2026-10-29: 친구 관계 + 응원(채팅 없이 안전하게)
db.exec(`CREATE TABLE IF NOT EXISTS friendships(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_a, user_b)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS cheers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(from_user, to_user, day)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS friend_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  read_at TEXT
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_fmsg_pair ON friend_messages(from_user, to_user, id)'); }catch{}
// ★ v1.35 AI 마을 «같이 놀기» — 지금 마을에 있는 친구의 위치. 45초 넘으면 «떠난 것» 으로 본다.
db.exec(`CREATE TABLE IF NOT EXISTS world_presence(
  user_id INTEGER PRIMARY KEY,
  x REAL NOT NULL DEFAULT 0,
  z REAL NOT NULL DEFAULT 0,
  ry REAL NOT NULL DEFAULT 0,
  anim TEXT DEFAULT 'Idle',
  ts INTEGER NOT NULL
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_presence_ts ON world_presence(ts)'); }catch{}
// ★ v1.37 대세계 «의뢰» — 하루 3건. __skip__ 행은 «건너뛰기 1장»(소모 = DELETE).
db.exec(`CREATE TABLE IF NOT EXISTS world_quests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  quest TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  reward INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wq_daily ON world_quests(user_id, day, quest)'); }catch{}
// ★ v1.37 빛 조각 3개 — 모으면 «건너뛰기» 한 장
db.exec(`CREATE TABLE IF NOT EXISTS world_stars(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  star INTEGER NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_daily ON world_stars(user_id, day, star)'); }catch{}
// ★ v1.38 이스터에그 «주인공의 흔적» — 마을 끝 낡은 이정표를 처음 읽은 기록. 계정당 1회 보상.
db.exec(`CREATE TABLE IF NOT EXISTS world_secrets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wsec_user ON world_secrets(user_id, key)'); }catch{}
// ★ v1.39 «자기 생각 × 도로랜드» — 아이가 막힌 순간에 적은 «생각 조각».
//   핵심은 «틀린 답» 이 아니라 «처음에 한 생각» 을 지우지 않고 남긴다는 것.
//   나중에 아이가 스스로 «고쳐 쓴 생각» 을 적으면 fixed 가 되고, 그때 별빛 셀이 나온다.
db.exec(`CREATE TABLE IF NOT EXISTS thought_shards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  chapter INTEGER NOT NULL DEFAULT 1,
  topic TEXT,
  stuck TEXT NOT NULL,
  guess TEXT NOT NULL,
  revised TEXT,
  prompt_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  cell_reward INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  fixed_at TEXT
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_thought_user ON thought_shards(user_id, id DESC)'); }catch{}

// ★ v1.44 «멈춘 마을을 다시 켜기» — 한 판 게임이 아니라 «어제 고친 게 오늘도 도는» 마을 상태.
//   조건(condition)은 날짜가 바뀔 때마다 결정론적으로 낡아가고, 고친 흔적은 영구히 남는다.
db.exec(`CREATE TABLE IF NOT EXISTS campaign_facilities(
  user_id INTEGER NOT NULL,
  facility_key TEXT NOT NULL,
  condition INTEGER NOT NULL DEFAULT 70,
  level INTEGER NOT NULL DEFAULT 1,
  repairs INTEGER NOT NULL DEFAULT 0,
  last_serviced TEXT,
  last_roll TEXT,
  updated_at TEXT,
  PRIMARY KEY(user_id, facility_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS campaign_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  facility_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  delta INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day, facility_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS campaign_journal(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  facility_key TEXT,
  title TEXT,
  body TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  lamps INTEGER NOT NULL DEFAULT 0,
  spares INTEGER NOT NULL DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_cj_user ON campaign_journal(user_id, id DESC)'); }catch{}
db.exec(`CREATE TABLE IF NOT EXISTS friend_blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, blocked_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS friend_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);

// 시즌(최소): 주 단위 구간 + 종료 보상.
db.exec(`CREATE TABLE IF NOT EXISTS seasons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_week TEXT NOT NULL,
  end_week TEXT NOT NULL,
  reward_cell INTEGER DEFAULT 0
)`);

// ---- 학습 동행 2.0 (2026-11-04): 능동 넛지 · 기분 · 집중 · 시즌 ----
//   원칙: 새 LLM 호출 없이 «기존 기록»을 규칙으로 읽어 아이에게 돌려준다.
//         화면의 DeepSeek 표기는 정적 UI 크레딧이며 생성 로직은 결정론적이다.
db.exec(`CREATE TABLE IF NOT EXISTS nudges(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  cta TEXT,
  target TEXT,
  shown INTEGER NOT NULL DEFAULT 0,
  clicked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS mood_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  mood TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, day)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS focus_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  reward INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_focus_user ON focus_sessions(user_id, day)'); }catch(e){}
db.exec(`CREATE TABLE IF NOT EXISTS season_claims(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  week TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT DEFAULT (datetime('now','+9 hours')),
  UNIQUE(user_id, week)
)`);
// ★ 일일 카운터(멱등 테이블) — 하루 단위 횟수 제한용.
//   계획 refresh 남발·부모 인증 무차별 대입 등 «LLM 예산/보호 우회» 를 막는 데 쓴다.
//   (user_id, day, kind) 가 기본키라 UPSERT 로 안전하게 증가시킬 수 있다.
db.exec(`CREATE TABLE IF NOT EXISTS daily_counters(
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY(user_id, day, kind)
)`);
// 카운터 +1 후 현재값을 돌려준다(UPSERT — 동시 요청에도 원자적)
function bumpDailyCounter(uid, day, kind){
  try{
    db.prepare(`INSERT INTO daily_counters(user_id,day,kind,count) VALUES(?,?,?,1)
      ON CONFLICT(user_id,day,kind) DO UPDATE SET count=count+1`).run(uid, day, kind);
    const r = db.prepare('SELECT count FROM daily_counters WHERE user_id=? AND day=? AND kind=?').get(uid, day, kind);
    return r ? r.count : 1;
  }catch(e){ return 1; }
}
// 현재값만 읽는다(증가 없음)
function dailyCounterOf(uid, day, kind){
  try{
    const r = db.prepare('SELECT count FROM daily_counters WHERE user_id=? AND day=? AND kind=?').get(uid, day, kind);
    return r ? r.count : 0;
  }catch(e){ return 0; }
}

// ============================================================
// ★ 2026-11-20 / v1.70 ① 개념별 마스터리(숙련도) — 학습 경로의 기초 데이터.
//   막힘·오답·정답·복습·수업·자가해결 6가지 사건을 점수 하나로 환산한다.
//   규칙: stuck → ×0.75, wrong → ×0.85 (감점) / correct +0.10, review +0.15,
//         lesson +0.10, solved +0.20 (가점). 점수는 [0.05, 1] 로 클램프한다.
//   attempts: 모든 사건에서 +1. correct: 성공 사건(correct/review/lesson/solved)에서만 +1
//   (stuck·wrong 은 «시도했지만 실패» 이므로 correct 는 세지 않는다).
// ============================================================
db.exec(`CREATE TABLE IF NOT EXISTS concept_mastery(
  user_id INTEGER NOT NULL, topic TEXT NOT NULL,
  score REAL DEFAULT 0.3, attempts INTEGER DEFAULT 0, correct INTEGER DEFAULT 0,
  last_day TEXT, PRIMARY KEY(user_id, topic)
)`);
// 마스터리 «완전 습득» 축하 메일은 개념당 딱 한 번(tag UNIQUE 로 보장)
const MASTERY_DONE_LINE = 0.8;

// 사건 1건을 마스터리 점수에 반영한다. topic 이 비면 무시(멱등·안전).
// 점수가 처음 0.8 을 넘으면(직전 < 0.8) 우편함에 축하 편지를 넣는다(셀 없음, 개념당 1회).
function bumpMastery(uid, topic, event){
  const t = String(topic || '').trim();
  if(!t) return null;
  const ev = String(event || '');
  if(!['stuck','wrong','correct','review','lesson','solved'].includes(ev)) return null;
  const day = today();
  let prev = 0.3;
  try{
    const row = db.prepare('SELECT score FROM concept_mastery WHERE user_id=? AND topic=?').get(uid, t);
    if(row && row.score != null) prev = Math.max(0.05, Math.min(1, Number(row.score)));
  }catch(e){ return null; }
  let score = prev;
  if(ev === 'stuck') score = prev * 0.75;
  else if(ev === 'wrong') score = prev * 0.85;
  else if(ev === 'correct') score = prev + 0.10;
  else if(ev === 'review') score = prev + 0.15;
  else if(ev === 'lesson') score = prev + 0.10;
  else score = prev + 0.20;   // solved
  score = Math.max(0.05, Math.min(1, score));
  const correctInc = (ev === 'correct' || ev === 'review' || ev === 'lesson' || ev === 'solved') ? 1 : 0;
  try{
    db.prepare(`INSERT INTO concept_mastery(user_id,topic,score,attempts,correct,last_day)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,topic) DO UPDATE SET
        score=excluded.score, attempts=attempts+1,
        correct=correct+excluded.correct, last_day=excluded.last_day`)
      .run(uid, t, score, 1, correctInc, day);
  }catch(e){ return null; }
  // ★ 성장 서사 ⑤: 처음 0.8 을 넘은 순간만 축하한다. tag='mastery:'+topic 로 개념당 1회 보장.
  if(prev < MASTERY_DONE_LINE && score >= MASTERY_DONE_LINE){
    sendMail(uid, { title:'🎉 개념을 완전히 익혔어요!',
      body:`«${t}» 를 완전히 익혔어요! 마을에서도 확인해 봐.`,
      cell:0, tag:'mastery:'+t });
  }
  return score;
}

// 가장 약한 개념부터 — score 오름차순, 같은 점수면 최근에 만진 것 우선.
function weakestTopics(uid, limit = 1){
  try{
    return db.prepare(`SELECT topic, score, attempts, correct, last_day FROM concept_mastery
      WHERE user_id=? ORDER BY score ASC, last_day DESC LIMIT ?`).all(uid, Math.max(1, limit|0));
  }catch(e){ return []; }
}

// ============================================================
// ★ 2026-11-21 (v1.74) A3 선수개념(prereq) — knowledge_cards.prereq(쉼표 구분) 를 읽는 3 형제.
//   · prereqListOf     : 개념의 선수개념 topic 배열(없으면 빈 배열)
//   · prereqBlockedFor : 선수개념 중 «마스터리 행이 있고 score<0.5» 인 첫 토픽(미달이면 그 이름)
//     — 행이 «없는» 선수개념은 막지 않는다(한 번도 만진 적 없으면 장애물이 아니라 미래 과제다).
//   · weakestTopicsOrdered : 가장 약한 개념 목록에서 미달 개념을 «삭제하지 않고 목록 끝» 으로 보낸다.
//     (선수개념이 흐려진 채 본개념부터 파는 교착을 막는다 — 없어도 항상 답이 나온다)
// ============================================================
function prereqListOf(topic){
  try{
    const r = db.prepare('SELECT prereq FROM knowledge_cards WHERE topic=?').get(String(topic || '').trim());
    return String((r && r.prereq) || '').split(',').map(s => s.trim()).filter(Boolean);
  }catch(e){ return []; }
}
function prereqBlockedFor(uid, topic){
  try{
    for(const p of prereqListOf(topic)){
      const m = db.prepare('SELECT score FROM concept_mastery WHERE user_id=? AND topic=?').get(uid, p);
      if(m && m.score != null && Number(m.score) < 0.5) return p;
    }
  }catch(e){}
  return null;
}
function weakestTopicsOrdered(uid, limit = 1){
  const lim = Math.max(1, limit | 0);
  const rows = weakestTopics(uid, 40);   // 재정렬 여유분 — 표가 작아 여유 40 행이면 충분하다
  const open = [], blocked = [];
  for(const r of rows){
    (prereqBlockedFor(uid, r.topic) ? blocked : open).push(r);
  }
  return open.concat(blocked).slice(0, lim);
}

// 특정 개념의 현재 마스터리(기록이 없으면 초기값 0.3)
function masteryOf(uid, topic){
  const t = String(topic || '').trim();
  if(!t) return 0.3;
  try{
    const r = db.prepare('SELECT score FROM concept_mastery WHERE user_id=? AND topic=?').get(uid, t);
    if(r && r.score != null) return Math.max(0.05, Math.min(1, Number(r.score)));
  }catch(e){}
  return 0.3;
}

// ============================================================
// ★ 2026-11-20 / v1.71 «루미는 잊어버려» — 기억 등불(기억 램프) 데이터 계층.
//   루미는 아이가 «가르쳐 준» 개념을 기억 등불로 밝혀 두고, DOROLAND 의 안개가
//   매일 등불을 흐리게 만든다. 아이는 기억의 수호자 — 다시 가르치면 등불이 되살아나고,
//   같은 개념을 3번 굳히면 수정 구슬이 되어 안개에 영원히 면역된다.
//   ★ 설계 규칙: 감쇠(decay)는 «날짜의 순수 함수» 다. campaign 처럼 cron·타이머 없이
//     읽는 시점에 계산한다(서버 재시작·미접속 날에도 정확).
// ============================================================
db.exec(`CREATE TABLE IF NOT EXISTS memory_lamps(
  user_id INTEGER NOT NULL, topic TEXT NOT NULL,
  lit_day TEXT, reinforce INTEGER DEFAULT 0, crystal INTEGER DEFAULT 0,
  immune_day TEXT, extra_decay INTEGER DEFAULT 0,
  PRIMARY KEY(user_id, topic)
)`);

// 두 KST 날짜(YYYY-MM-DD) 사이의 일수. b 가 a 보다 미래면 양수(0 = 같은 날).
function daysBetween(a, b){
  const ta = Date.parse(String(a) + 'T00:00:00Z');
  const tb = Date.parse(String(b) + 'T00:00:00Z');
  if(!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.floor((tb - ta) / 86400000);
}

// user_memories 의 taught 기억을 기억 등불로 «지연 동기화» 한다(없는 등불만 생성 — 멱등).
//   taught 키 포맷: 'taught:<개념>'(공백은 _ 로 저장 → 읽을 때 복원, robot/recall 과 동일 규칙).
//   lit_day 는 기억의 날짜(updated_at 의 KST 날짜). reinforce 는 0 에서 시작(lightLamp 만 올린다).
function lampSyncFromMemories(uid){
  try{
    const rows = db.prepare("SELECT key, updated_at FROM user_memories WHERE user_id=? AND kind='taught'").all(uid);
    for(const r of rows){
      const topic = String(r.key || '').replace(/^taught:/, '').replace(/_/g, ' ').trim().slice(0, 60);
      if(!topic) continue;
      const m = String(r.updated_at || '').match(/^\d{4}-\d{2}-\d{2}/);
      const litDay = m ? m[0] : today();
      db.prepare(`INSERT INTO memory_lamps(user_id,topic,lit_day,reinforce,crystal,immune_day,extra_decay)
        VALUES(?,?,?,0,0,NULL,0)
        ON CONFLICT(user_id,topic) DO NOTHING`).run(uid, topic, litDay);
    }
  }catch(e){}
}

// 감쇠 순수 함수 — (등불 행, 오늘) 만으로 0~100 을 계산한다.
//   d=daysBetween(lit_day, day): d<=0 → 0 · 1일 10 · 2일 25 · 3일 45 · 이후 +10/일, 상한 100.
//   crystal=1 → 항상 0(수정 구슬은 안개에 면역). immune_day=오늘 → 오늘만 0.
//   최종 = min(100, base + extra_decay).
function fogDecay(lamp, day){
  try{
    if(Number(lamp.crystal) === 1) return 0;
    if(lamp.immune_day && String(lamp.immune_day) === String(day)) return 0;
    const lit = String(lamp.lit_day || '');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(lit)) return 100;   // 날짜가 이상하면 최대 안개(안전 쪽으로)
    const d = daysBetween(lit, day);
    let base = 0;
    if(d === 1) base = 10;
    else if(d === 2) base = 25;
    else if(d >= 3) base = 45 + (d - 3) * 10;
    const extra = Math.max(0, Math.min(50, Number(lamp.extra_decay) || 0));
    return Math.min(100, base + extra);
  }catch(e){ return 0; }
}

// ★ 2026-11-21 (v1.74) B1 삼막 온보딩 보조 — «안개를 처음 겪음» 을 기록한다(1막 다음 단계).
//   ob_step<2 이면 2 로 올리고, «아직 /api/lamps 가 못 보냈으면» 보류 플래그를 남긴다.
//   플래그는 /api/lamps 가 응답으로 소비하면 지운다(사실상 «최초 1회» 전달 보장).
function obAdvanceFog(uid, day){
  try{
    const u = db.prepare('SELECT ob_step FROM users WHERE id=?').get(uid);
    if(u && Number(u.ob_step || 0) < 2){
      db.prepare('UPDATE users SET ob_step=2 WHERE id=?').run(uid);
      try{
        db.prepare(`INSERT INTO daily_counters(user_id,day,kind,count) VALUES(?,?,?,1)
          ON CONFLICT(user_id,day,kind) DO UPDATE SET count=1`).run(uid, day, 'ob_sos_pending');
      }catch(e){}
      return true;
    }
  }catch(e){}
  return false;
}

// ★ 2026-11-21 (v1.74) A3 ② 등불별 blockedBy — 선수개념 중 «안개 decay≥50» 인 첫 토픽.
//   램프 자체가 없는 선수개념은 막지 않는다(아직 배우지 않은 과제는 장애물이 아니라 길이다).
function blockedByFor(topic, decayMap){
  for(const p of prereqListOf(topic)){
    const d = decayMap ? decayMap.get(p) : null;
    if(d != null && Number(d) >= 50) return p;
  }
  return null;
}

// 등불 전체 조회 — 동기화 → 감쇠 계산 → 무거운(안개 진한) 순 정렬 + SOS 우편(하루 1통).
//   decay≥50 인 등불이 있는데 오늘 아직 fog_sos 카운터가 0 이면 우편함에 부탁 편지를 넣는다.
//   (tag='fog:<day>' UNIQUE 로 우편 중복도 이중 방어. 하루 최대 1통.)
//   ★ 2026-11-21 (v1.74) B1: 이 SOS 가 «처음» 이면 ob_step 1→2 를 세우고 sosFirst 로 돌려준다.
function lampsFor(uid){
  lampSyncFromMemories(uid);
  const day = today();
  let rows = [];
  try{ rows = db.prepare('SELECT * FROM memory_lamps WHERE user_id=?').all(uid); }catch(e){}
  const lamps = rows.map(r => ({
      topic: String(r.topic), lit_day: String(r.lit_day || ''),
      reinforce: Number(r.reinforce) || 0, crystal: Number(r.crystal) || 0,
      immune_day: r.immune_day || null, extra_decay: Number(r.extra_decay) || 0, decay: 0,
    }))
    .map(l => { l.decay = fogDecay(l, day); return l; })
    .sort((a, b) => (b.decay - a.decay) || a.topic.localeCompare(b.topic, 'ko'));
  let sosFirst = false;
  const heaviest = lamps.find(l => l.decay >= 50) || null;
  if(heaviest && dailyCounterOf(uid, day, 'fog_sos') === 0){
    sendMail(uid, { title: '😢 루미의 기억이 흐려져요',
      body: `«${heaviest.topic}» 이 가물가물해… 다시 가르쳐 줄래?`,
      cell: 0, tag: 'fog:' + day });
    bumpDailyCounter(uid, day, 'fog_sos');
    sosFirst = obAdvanceFog(uid, day);
  }
  return { lamps, sos: heaviest ? { topic: heaviest.topic } : null, sosFirst };
}

// «읽기 전용» 조회 — SOS 우편 발송(부작용) 없이 가장 무거운 등불만 본다.
//   robot/hello · 대화 프롬프트 같은 «말 걸기» 경로에서 쓴다(우편과 말 중 하나만 나가도록).
function fogHeaviestReadonly(uid, minDecay){
  try{
    lampSyncFromMemories(uid);
    const day = today();
    const rows = db.prepare('SELECT * FROM memory_lamps WHERE user_id=?').all(uid);
    const lamps = rows.map(r => ({ topic: String(r.topic), lit_day: String(r.lit_day || ''),
        crystal: Number(r.crystal) || 0, immune_day: r.immune_day || null, extra_decay: Number(r.extra_decay) || 0, decay: 0 }))
      .map(l => { l.decay = fogDecay(l, day); return l; })
      .sort((a, b) => (b.decay - a.decay) || a.topic.localeCompare(b.topic, 'ko'));
    return lamps.find(l => l.decay >= (Number(minDecay) || 0)) || null;
  }catch(e){ return null; }
}

// ★ 2026-11-21 (v1.74) A2 «빛의 조각» 다음 배지 — 명예 카운트(teach_count) 의 딱지 10/50/100.
const TEACH_BADGES = [10, 50, 100];
function nextBadgeFor(count){
  for(const at of TEACH_BADGES){
    if((Number(count) || 0) < at) return { at, have: Number(count) || 0 };
  }
  return null;
}

// 개념 하나를 다시 «가르쳐» 등불을 밝힌다: lit_day=오늘 · extra_decay=0 · reinforce=min(+1,3).
//   reinforce 가 처음 3 에 닿으면 수정 구슬(안개 면역) + 마을에 crystal_<n> 조형물이 생긴다.
//   ★ 2026-11-21 (v1.74) A2/B1 반환 확장:
//     · counted    — teach_count +1 이 실제로 일어났나(같은 등불을 같은 날 다시 밝히면 세지 않는다)
//     · first      — 삼막 1막: 첫 등불(teach_count 0→1, ob_step 0→1) 순간(응답에 firstLamp 로 전달)
//     · crystalNow — 삼막 3막: 수정화 첫 순간(ob_step<3 → 3, 응답에 crystalNow 로 전달)
function lightLamp(uid, topicRaw){
  const topic = String(topicRaw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if(!topic) return { crystal:false, counted:false, first:false, crystalNow:false };
  const day = today();
  let lamp = null;
  try{ lamp = db.prepare('SELECT * FROM memory_lamps WHERE user_id=? AND topic=?').get(uid, topic); }catch(e){}
  const wasCrystal = !!(lamp && Number(lamp.crystal) === 1);
  const reinforce = lamp ? Math.min(3, (Number(lamp.reinforce) || 0) + 1) : 1;
  // ★ A2: «이전 lit_day ≠ 오늘 또는 새 등불» 일 때만 빛의 조각을 센다(같은 날 재점등은 무료).
  //   B1 1막: teach_count 0→1 인 «그 한 번» 에 ob_step 도 0→1 로 올린다(1막 플래그).
  let counted = false, first = false, obStep = 0;
  let userRow = null;
  try{ userRow = db.prepare('SELECT teach_count, ob_step FROM users WHERE id=?').get(uid); }catch(e){}
  obStep = Number((userRow && userRow.ob_step) || 0);
  const wasLitToday = !!(lamp && String(lamp.lit_day || '') === day);
  if(!wasLitToday){
    try{
      const before = Number((userRow && userRow.teach_count) || 0);
      db.prepare('UPDATE users SET teach_count=? WHERE id=?').run(before + 1, uid);
      counted = true;
      if(before === 0 && obStep === 0){
        db.prepare('UPDATE users SET ob_step=1 WHERE id=?').run(uid);
        first = true;
      }
    }catch(e){}
  }
  try{
    db.prepare(`INSERT INTO memory_lamps(user_id,topic,lit_day,reinforce,crystal,immune_day,extra_decay)
      VALUES(?,?,?,1,0,NULL,0)
      ON CONFLICT(user_id,topic) DO UPDATE SET
        lit_day=excluded.lit_day, extra_decay=0, reinforce=excluded.reinforce`)
      .run(uid, topic, day);
  }catch(e){ return { crystal: wasCrystal, counted, first, crystalNow:false }; }
  let crystal = wasCrystal, crystalNow = false;
  if(!wasCrystal && reinforce >= 3){
    try{
      const r = db.prepare('UPDATE memory_lamps SET crystal=1 WHERE user_id=? AND topic=? AND crystal=0').run(uid, topic);
      if(r.changes > 0){
        crystal = true;
        crystalEventFor(uid);   // ★ 마을 조형물 기록 — 3D 렌더는 별도 에이전트가 village_props 를 읽어 그린다
        // ★ B1 3막: «수정화» 를 처음 겪으면 ob_step 를 3 까지 올린다(삼막은 순서 없이 독립 진행).
        if(obStep < 3){
          try{ db.prepare('UPDATE users SET ob_step=3 WHERE id=?').run(uid); crystalNow = true; }catch(e){}
        }
      }
    }catch(e){}
  }
  return { crystal, counted, first, crystalNow };
}

// 수정 구슬 이벤트 — village_props 에 crystal_<n> 을 기록(n=현재 구슬 수, 상한 5).
//   INSERT OR IGNORE 로 마을 관례(villageKeys/syncVillage)와 같은 방식. 결정론적 키라 재실행 무해.
//   ★ 2026-11-21 (v1.74) A2: teach_count 마일스톤 조형물도 여기서 함께 기록한다(25=벤치 · 50=화환).
//     INSERT OR IGNORE 라 몇 번을 불려도 같은 조형물이 두 개 생기지 않는다(멱등).
function crystalEventFor(uid){
  try{
    const n = db.prepare('SELECT COUNT(*) c FROM memory_lamps WHERE user_id=? AND crystal=1').get(uid).c;
    const key = 'crystal_' + Math.min(5, Math.max(1, Number(n) || 1));
    db.prepare('INSERT OR IGNORE INTO village_props(user_id,prop_key) VALUES(?,?)').run(uid, key);
    const u = db.prepare('SELECT teach_count FROM users WHERE id=?').get(uid);
    const tc = Number((u && u.teach_count) || 0);
    if(tc >= 25) db.prepare('INSERT OR IGNORE INTO village_props(user_id,prop_key) VALUES(?,?)').run(uid, 'shard_bench');
    if(tc >= 50) db.prepare('INSERT OR IGNORE INTO village_props(user_id,prop_key) VALUES(?,?)').run(uid, 'shard_wreath');
  }catch(e){}
}

// 안개 벌점 — 탑에서 틀렸을 때 그 등불의 안개를 더 진하게(+10, 상한 50) + 마스터리 감점(wrong).
function fogPenalize(uid, topicRaw){
  const topic = String(topicRaw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if(!topic) return;
  try{
    const has = db.prepare('SELECT 1 FROM memory_lamps WHERE user_id=? AND topic=?').get(uid, topic);
    if(has){
      db.prepare('UPDATE memory_lamps SET extra_decay=MIN(extra_decay+10,50) WHERE user_id=? AND topic=?')
        .run(uid, topic);
    }else{
      // 등불이 아직 없으면 «오늘 밝은 뒤 흐려진» 상태로 새로 만든다(벌점이 기록에 남도록).
      db.prepare(`INSERT INTO memory_lamps(user_id,topic,lit_day,reinforce,crystal,immune_day,extra_decay)
        VALUES(?,?,?,0,0,NULL,10)
        ON CONFLICT(user_id,topic) DO NOTHING`).run(uid, topic, today());
    }
  }catch(e){}
  bumpMastery(uid, topic, 'wrong');
}

// ============================================================
// ★ 2026-11-20 / v1.71 «안개 속의 탑» — 결정론적 출제 엔진(순수 함수 · LLM 없음 · 비용 0).
//   각 층은 (uid, 개념, 층, 날짜) 시드로만 계산 → GET/POST 가 같은 문장을 다시 만든다.
//   원래 문장: ①아이의 taught 원문 → ②지식 카드 analogy/hint_l2(hint_l3·퀴즈 정답은 절대 안 쓴다).
//   왜곡 3종: ①단어 반전(모두↔일부 · 항상↔가끔 …, 문장에 실제 나올 때만)
//             ②개념 이식(문장 속 개념어를 다른 등불의 개념명으로 교체 — 주말 BOSS 층 필수)
//             ③대상 교체(v1.70 teachFallbackPair 의 «다른 카드 정의» 템플릿 재사용)
//   «탑에 최소 1층은 왜곡» 보장: 각 층이 3종 전부를 시도하므로, 어느 한 층이라도
//   왜곡 가능하면 그 층은 반드시 왜곡 문제가 된다(모두 불가능하면 «원래 말» 탑이 된다).
// ============================================================
const TOWER_FLOOR_MAX = 6;

// 안개 변형 쌍 — [원래 단어, 바뀔 단어, 조사 결합 허용 여부].
const FOG_FLIP_PAIRS = [
  ['모두', '일부', true], ['항상', '가끔'], ['있다', '없다'], ['먼저', '나중에'],
  ['더하면', '빼면'], ['나누면', '곱하면'], ['같으면', '다르면'], ['크다', '작다'],
];
// 단어 경계 문자(공백·문장부호) — 한글엔 \b 가 없어 «긴 단어 한복판» 교체를 막는다.
const FOG_EDGE_RE = /[\s.,!?…:;'"()«»\-]/;
const FOG_JOSA = '가을이는의로도만와과에서';

// 문장에서 from 을 «단어 경계에서만» to 로 바꾼다. 불가능하면 null.
function fogFlipAt(sentence, from, to, josaOk){
  const s = String(sentence);
  let idx = s.indexOf(from);
  while(idx >= 0){
    const before = idx === 0 ? '' : s[idx - 1];
    const afterCh = idx + from.length >= s.length ? '' : s[idx + from.length];
    const okBefore = before === '' || FOG_EDGE_RE.test(before);
    const okAfter = afterCh === '' || FOG_EDGE_RE.test(afterCh) || (!!josaOk && FOG_JOSA.includes(afterCh));
    if(okBefore && okAfter) return s.slice(0, idx) + to + s.slice(idx + from.length);
    idx = s.indexOf(from, idx + 1);
  }
  return null;
}

// 날짜 문자열 → 결정론적 해시(시드 재료)
function fogDayHash(day){
  return String(day).split('').reduce((a, ch) => (a * 131 + ch.charCodeAt(0)) >>> 0, 7);
}

// 왜곡의 «재료»: 다른 등불·다른 카드의 개념(자기 개념은 제외). 순서 고정 → 결정론 보장.
function fogOtherConceptsFor(uid, topic){
  const out = [];
  try{
    const rows = db.prepare('SELECT topic FROM memory_lamps WHERE user_id=? AND topic<>? ORDER BY topic')
      .all(uid, topic);
    for(const r of rows) out.push({ topic: String(r.topic), concept: null });
  }catch(e){}
  try{
    const cards = db.prepare(`SELECT topic, concept FROM knowledge_cards
      WHERE topic<>? AND concept IS NOT NULL AND concept<>'' ORDER BY id`).all(topic);
    for(const c of cards){
      const t = String(c.topic);
      if(!out.some(o => o.topic === t)) out.push({ topic: t, concept: String(c.concept) });
    }
  }catch(e){}
  return out;
}

// 문장에 실제로 나오는 «개념 이름 후보»(주제 + 카드 별칭, 가장 긴 것부터).
function fogTopicNamesIn(topic, sentence){
  const s = String(sentence);
  const names = new Set([String(topic || '').trim()]);
  try{
    const card = teachCardFor(topic);
    if(card){
      if(card.topic) names.add(String(card.topic).trim());
      for(const a of (CARD_ALIASES[card.topic] || [])) if(a) names.add(String(a).trim());
    }
    for(const a of (CARD_ALIASES[topic] || [])) if(a) names.add(String(a).trim());
  }catch(e){}
  return [...names].filter(n => n.length >= 2 && s.includes(n)).sort((a, b) => b.length - a.length);
}

// 탑의 «원래 문장» — taught 원문 → 카드 analogy → hint_l2 첫 문장 → 결정론 기본 문장.
//   (hint_l3 와 퀴즈 정답은 이 어디에도 들어가지 않는다.)
function towerOriginalFor(uid, topic){
  const t = String(topic || '').trim();
  try{
    const key = 'taught:' + t.replace(/\s+/g, '_');
    const r = db.prepare("SELECT value FROM user_memories WHERE user_id=? AND kind='taught' AND key=?").get(uid, key);
    if(r && String(r.value || '').trim()) return String(r.value).trim().slice(0, 60);
  }catch(e){}
  const card = teachCardFor(t);
  if(card){
    if(card.analogy && String(card.analogy).trim()) return String(card.analogy).trim().slice(0, 60);
    if(card.hint_l2 && String(card.hint_l2).trim()) return String(card.hint_l2).trim().split(/[.!?]/)[0].slice(0, 60);
  }
  return `${t}는 차근차근 배우면 이해할 수 있는 개념이야.`;
}

// 왜곡 전략 1건 시행 — 불가능하면 null(그 층엔 그 전략을 못 쓴다).
function fogApplyStrategy(name, topic, original, others, seed){
  if(name === 'flip'){
    for(let i = 0; i < FOG_FLIP_PAIRS.length; i++){
      const p = FOG_FLIP_PAIRS[(i + seed % FOG_FLIP_PAIRS.length) % FOG_FLIP_PAIRS.length];
      const out = fogFlipAt(original, p[0], p[1], !!p[2]);
      if(out && out !== original) return { strategy: 'flip', statement: out.slice(0, 80) };
    }
    return null;
  }
  if(name === 'graft'){
    const names = fogTopicNamesIn(topic, original);
    if(!names.length || !others.length) return null;
    const name = names[seed % names.length];
    const other = others[seed % others.length];
    const out = String(original).replace(name, () => other.topic);   // 첫 등장만(함수 치환으로 $ 안전)
    if(out !== original) return { strategy: 'graft', statement: out.slice(0, 80) };
    return null;
  }
  // swap — v1.70 teachFallbackPair 의 «대상 교체» 템플릿(개념 정의를 다른 카드 것으로 끼워 넣기)
  const withConcept = others.find(o => o.concept && String(o.concept).trim());
  if(!withConcept) return null;
  const c = String(withConcept.concept).trim();
  return { strategy: 'swap', statement: `${topic}는 ${c}${koIraNeun(c)} 뜻이야.`.slice(0, 80) };
}

// 한 층의 문장 — 결정론. seed=uid*31+날짜 해시+층. boss 면 «개념 이식» 을 반드시 먼저 시도한다.
//   반환: { statement(출제 문장), fogged(왜곡 여부 — 응답엔 절대 실지 않는다), canFog, original }
function fogStatement(uid, topic, floor, day, opts){
  const o = opts || {};
  const original = towerOriginalFor(uid, topic);
  const seed = (((Number(uid) || 0) * 31 + fogDayHash(day) + (Number(floor) || 0)) >>> 0);
  const others = fogOtherConceptsFor(uid, topic);
  const all = ['flip', 'graft', 'swap'];
  const st = seed % 3;
  // BOSS(주말) 층은 «개념 이식 필수» — graft → swap(교차 개념) → flip 순. 일반 층은 시드 회전 순.
  const order = o.boss ? ['graft', 'swap', 'flip'] : [all[st], all[(st + 1) % 3], all[(st + 2) % 3]];
  for(const name of order){
    const r = fogApplyStrategy(name, topic, original, others, seed);
    if(r) return { statement: r.statement, fogged: true, canFog: true, original, strategy: r.strategy };
  }
  return { statement: original, fogged: false, canFog: false, original, strategy: 'none' };
}

// ============================================================
// ★ v1.71 «탑 덱(층 배치)» — 하루 1회 고정. GET 과 POST 가 다른 시점에 불려도 «같은 탑» 이 되게.
//   배치는 «첫 접속 시점의 감쇠 순» 으로 고정한다. 정답 → immune_day 로 감쇠가 0 이 되어도
//   층이 흔들리지 않는다(그렇지 않으면 POST 재계산 때 다른 개념을 채점하는 버그가 난다).
//   저장소: daily_counters 의 kind 문자열('tower_deck|개념|개념…') — 표를 하나 더 만들지 않는 선택.
// ============================================================
function towerDeckLoad(uid, day){
  try{
    const row = db.prepare(`SELECT kind FROM daily_counters
      WHERE user_id=? AND day=? AND kind LIKE 'tower_deck|%' ORDER BY rowid LIMIT 1`).get(uid, day);
    if(row){
      const parts = String(row.kind).slice('tower_deck|'.length).split('|').filter(s => s.length);
      if(parts.length) return parts;
    }
  }catch(e){}
  return null;
}
function towerDeckSave(uid, day, topics){
  try{
    const kind = 'tower_deck|' + topics.map(t => String(t).replace(/[|%]/g, ' ').trim()).join('|');
    db.prepare(`INSERT INTO daily_counters(user_id,day,kind,count) VALUES(?,?,?,1)
      ON CONFLICT(user_id,day,kind) DO UPDATE SET count=count`).run(uid, day, kind);
  }catch(e){}
}
// 저장된 덱이 없으면 «지금» 만든다: decay<100 인 등불(crystal 포함)을 무거운 순으로 최대 6개.
function towerDeckFor(uid, day, lamps){
  const saved = towerDeckLoad(uid, day);
  if(saved) return saved;
  const eligible = (lamps || []).filter(l => l.decay < 100).slice(0, TOWER_FLOOR_MAX).map(l => l.topic);
  if(eligible.length) towerDeckSave(uid, day, eligible);
  return eligible;
}

// ★ 2026-11-21 (v1.74) A3 ③ BOSS 층 개념 선택 — prereq 가 붙은 개념을 우선한다.
//   덱 순서를 훑고 «선수개념이 기록된» 첫 개념을 BOSS 로 삼는다(결정론 — 덱과 카드만 보므로
//   GET/POST 가 같은 층을 다시 계산해도 같은 결과). prereq 가 하나도 없으면 기존대로 deck[0].
function bossConceptFor(deck){
  for(const t of (deck || [])){
    if(prereqListOf(t).length) return String(t);
  }
  return (deck && deck[0]) || null;
}

// 탑 전체 상태(층 배열) — GET/POST 가 공유하는 유일한 출제 경로(같은 입력 → 같은 문장).
//   BOSS: 주말(KST 토·일)이면 7층을 추가한다(개념 이식 필수 층).
//   ★ 2026-11-21 (v1.74) A3 ③: BOSS 개념은 deck[0] 대신 «prereq 가 붙은 개념» 을 우선 출제한다.
function towerStateFor(uid, day, deck, boss){
  const floors = [];
  for(let i = 0; i < deck.length; i++){
    floors.push({ floor: i, concept: deck[i], ...fogStatement(uid, deck[i], i, day, { boss: false }) });
  }
  if(boss && deck.length){
    const bossTopic = bossConceptFor(deck) || deck[0];
    floors.push({ floor: deck.length, concept: bossTopic, ...fogStatement(uid, bossTopic, deck.length, day, { boss: true }) });
  }
  return floors;
}

// 주말(토·일) 판정 — «day 문자열» 기준의 순수 함수(KST 달력 날짜를 그대로 본다).
function towerIsBoss(day){
  const d = new Date(String(day) + 'T00:00:00Z');
  const dow = Number.isNaN(d.getTime()) ? todayDow() : d.getUTCDay();
  return dow === 6 || dow === 0;   // 토 · 일
}

function towerPopcount(n){
  let x = Number(n) || 0, c = 0;
  while(x){ c += (x & 1); x >>>= 1; }
  return c;
}

// clearedMask 비트 세우기(UPSERT — 증가가 아니라 OR. 층 i → bit i)
function towerClearBitSet(uid, day, floor){
  const next = (dailyCounterOf(uid, day, 'tower_clears') | (1 << floor)) >>> 0;
  try{
    db.prepare(`INSERT INTO daily_counters(user_id,day,kind,count) VALUES(?,?,?,?)
      ON CONFLICT(user_id,day,kind) DO UPDATE SET count=excluded.count`)
      .run(uid, day, 'tower_clears', next);
  }catch(e){}
  return next;
}

// 오답 1회로 오늘의 탑 종료(재도전 금지 — 내일 다시. 값은 1 로 고정, 멱등).
function towerEndedSet(uid, day){
  try{
    db.prepare(`INSERT INTO daily_counters(user_id,day,kind,count) VALUES(?,?,?,1)
      ON CONFLICT(user_id,day,kind) DO UPDATE SET count=1`).run(uid, day, 'tower_ended');
  }catch(e){}
}

// ★ v1.71 «친구와 함께 배운 개념» — 수락된 친구 중 같은 개념을 teach-back 한 사람이 있으면
//   «존재 여부와 닉네임만» 돌려준다. 친구의 기억 «내용» 은 절대 조회하지 않는다(프라이버시).
function coTeacherOf(uid, topic){
  const t = String(topic || '').trim();
  if(!t) return null;
  const key = 'taught:' + t.replace(/\s+/g, '_');
  try{
    const friends = db.prepare(`SELECT u.id, u.nickname FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END
      WHERE (f.user_a=? OR f.user_b=?) AND f.status='accepted'`).all(uid, uid, uid);
    for(const fr of friends){
      const hit = db.prepare("SELECT 1 FROM user_memories WHERE user_id=? AND kind='taught' AND key=? LIMIT 1")
        .get(fr.id, key);
      if(hit) return String(fr.nickname || '').slice(0, 20) || null;
    }
  }catch(e){}
  return null;
}

// ★ 대화의 «다음 질문»을 남겨 두면 다음 접속에 루미가 먼저 말을 이어간다.
try{ db.exec('ALTER TABLE chat_messages ADD COLUMN follow_up TEXT'); }catch(e){}

// ============================================================
// ★ 2026-11-21 (v1.74) «논리와 편의» 마이그레이션 — 전부 try/catch 로 «이미 존재» 를 무시(멱등).
//   users.teach_count      : «빛의 조각» 명예 카운트(lightLamp 가 등불을 새로 밝힐 때만 +1)
//   users.ob_step          : 삼막 온보딩(0=시작 전 1=첫 등불 2=안개 겪음 3=수정화)
//   users.play_limit_delta : 부모가 조절하는 하루 플레이 한도 오프셋(기본 40분 기준, -10~+20)
//   users.pin_hash/transfer_hash/transfer_exp : 계정 PIN · 기기 이전(SHA-256 만 저장)
//   users.parent_email/parent_optin : «루미의 편지» 수신 동의
//   knowledge_cards.prereq : 선수개념(쉼표 구분 topic — 학습 순서의 기초 데이터)
// ============================================================
try{ db.exec('ALTER TABLE users ADD COLUMN teach_count INTEGER DEFAULT 0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN ob_step INTEGER DEFAULT 0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN play_limit_delta INTEGER DEFAULT 0'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN transfer_hash TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN transfer_exp TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN parent_email TEXT'); }catch{}
try{ db.exec('ALTER TABLE users ADD COLUMN parent_optin INTEGER DEFAULT 0'); }catch{}
try{ db.exec("ALTER TABLE knowledge_cards ADD COLUMN prereq TEXT DEFAULT ''"); }catch{}

// 지식 카드 시드(운영자가 추가/수정 가능). quiz 는 정답을 서버에만 둔다.
// ★ 2026-10-28: 8 → 16장. 기존 DB에도 없는 카드만 추가(멱등).
{
  const cards = [
    { topic:'변수', chapter:4, concept:'값을 담아 두는 이름 붙은 상자',
      analogy:'이름표를 붙인 상자에 장난감을 넣는 것',
      example:'score = 10',
      h1:'지금 기억하고 싶은 값이 뭐야?', h2:'변수는 이름표 붙은 상자야. 이름을 먼저 정해 보자.', h3:'이름을 정했으면 = 로 값을 넣어 보자.',
      quiz:{ q:'변수에 값을 넣을 때 쓰는 기호는?', options:['=','+','#','{}'], answer:0 }, tags:'변수,상자,저장' },
    { topic:'반복문', chapter:4, concept:'같은 일을 여러 번 되풀이하는 명령',
      analogy:'계단을 한 칸씩 여러 번 오르는 것',
      example:'for i in range(3): print(i)',
      h1:'몇 번 반복하려고 했어?', h2:'반복문은 같은 일을 여러 번 하는 거야. 계단 오르기처럼 생각해 봐.', h3:'먼저 3번 반복부터 써 보자.',
      quiz:{ q:'3번 반복하려면 어떤 숫자를 써야 할까?', options:['1','2','3','0'], answer:2 }, tags:'반복,for,루프' },
    { topic:'조건문', chapter:4, concept:'만약 ~이면 이렇게 하라는 명령',
      analogy:'신호등이 초록불이면 건너고, 빨간불이면 멈추는 것',
      example:'if score > 10: print("통과")',
      h1:'어떤 조건일 때 실행하고 싶어?', h2:'조건문은 신호등 같아. 초록불일 때만 건너.', h3:'if 다음에 조건을 먼저 써 보자.',
      quiz:{ q:'조건문을 시작할 때 쓰는 말은?', options:['if','for','def','print'], answer:0 }, tags:'조건,if,분기' },
    { topic:'함수', chapter:4, concept:'이름을 붙여 묶어 둔 명령 묶음',
      analogy:'요리 레시피를 한 장에 적어 두는 것',
      example:'def greet(): print("안녕")',
      h1:'어떤 일을 한 묶음으로 만들고 싶어?', h2:'함수는 레시피야. 한 번 적어 두고 여러 번 써.', h3:'def 로 이름을 붙이고 안에 할 일을 써 보자.',
      quiz:{ q:'함수를 만들 때 쓰는 말은?', options:['def','if','for','='], answer:0 }, tags:'함수,def,레시피' },
    { topic:'디버깅', chapter:2, concept:'오류를 찾아서 고치는 일',
      analogy:'퍼즐에서 잘못 끼운 조각을 찾는 것',
      example:'print()로 값을 하나씩 확인하기',
      h1:'어디서 멈추는지 확인해 봤어?', h2:'디버깅은 틀린 조각을 찾는 거야. 한 줄씩 확인해 보자.', h3:'먼저 print()로 중간 값을 확인해 보자.',
      quiz:{ q:'오류를 찾을 때 가장 먼저 할 일은?', options:['코드를 전부 지운다','중간 값을 출력해 확인한다','컴퓨터를 끈다','친구를 부른다'], answer:1 }, tags:'디버깅,오류,print' },
    { topic:'리스트', chapter:4, concept:'여러 값을 순서대로 담는 그릇',
      analogy:'기차 칸에 짐을 순서대로 넣는 것',
      example:'items = ["나사", "리본", "부스터"]',
      h1:'어떤 값들을 순서대로 담고 싶어?', h2:'리스트는 기차 칸이야. 순서대로 넣어.', h3:'대괄호 [ ] 안에 값을 넣어 보자.',
      quiz:{ q:'리스트를 만들 때 쓰는 기호는?', options:['( )','{ }','[ ]','< >'], answer:2 }, tags:'리스트,배열,순서' },
    { topic:'이벤트', chapter:4, concept:'무언가 일어났을 때 실행되는 명령',
      analogy:'초인종을 누르면 문이 열리는 것',
      example:'button.onclick = 함수',
      h1:'무슨 일이 일어났을 때 실행하고 싶어?', h2:'이벤트는 초인종이야. 누르면 반응해.', h3:'먼저 어떤 버튼을 눌렀을 때인지 정해 보자.',
      quiz:{ q:'버튼을 눌렀을 때 실행되는 것은?', options:['이벤트','변수','리스트','주석'], answer:0 }, tags:'이벤트,클릭,반응' },
    { topic:'AI 추천', chapter:5, concept:'전에 본 기록을 보고 다음 내용을 고르는 것',
      analogy:'내가 좋아했던 책을 보고 다음 책을 추천해 주는 것',
      example:'추천 알고리즘은 시청 기록·검색 기록을 사용',
      h1:'앱은 내 어떤 정보를 보고 추천할까?', h2:'AI는 내가 전에 본 것을 기억해. 책 추천과 비슷해.', h3:'시청 기록과 검색 기록을 떠올려 보자.',
      quiz:{ q:'영상 앱이 추천 영상을 고를 때 주로 보는 것은?', options:['오늘 날씨','내가 전에 본 영상 기록','배터리 양','휴대폰 색깔'], answer:1 }, tags:'AI,추천,기록' },
    { topic:'출력', chapter:2, concept:'화면에 보여 주는 명령',
      analogy:'마이크로 발표하기',
      example:'print("안녕")',
      h1:'무엇을 보여 주고 싶어?', h2:'print는 화면에 보여 주는 명령이야.', h3:'print 다음 괄호 안에 보여 줄 내용을 넣어 보자.',
      quiz:{ q:'화면에 글자를 보여 줄 때 쓰는 것은?', options:['print','input','if','for'], answer:0 }, tags:'출력,print,화면' },
    { topic:'입력', chapter:2, concept:'사용자에게 값을 받는 명령',
      analogy:'친구에게 질문하고 대답 듣기',
      example:'name = input("이름?")',
      h1:'누구에게 무엇을 물어볼까?', h2:'input은 사용자의 대답을 받는 명령이야.', h3:'input 괄호 안에 질문을 넣어 보자.',
      quiz:{ q:'사용자의 입력을 받을 때 쓰는 것은?', options:['print','input','while','def'], answer:1 }, tags:'입력,input,질문' },
    { topic:'산술 연산', chapter:4, concept:'숫자를 계산하는 기호',
      analogy:'계산기',
      example:'3 + 4 * 2',
      h1:'무엇을 계산하고 싶어?', h2:'+, -, *, /는 계산 기호야.', h3:'곱셈이 덧셈보다 먼저라는 것도 기억해.',
      quiz:{ q:'곱셈에 쓰는 기호는?', options:['+','-','*','/'], answer:2 }, tags:'계산,연산,산술' },
    { topic:'비교 연산', chapter:4, concept:'두 값을 비교해 참/거짓을 만드는 기호',
      analogy:'키를 재서 누가 더 큰지 비교하기',
      example:'score >= 10',
      h1:'무엇과 무엇을 비교할까?', h2:'>, <, ==는 두 값을 비교하는 기호야.', h3:'같다는 =가 아니라 ==라는 걸 기억해.',
      quiz:{ q:'두 값이 같은지 비교할 때 쓰는 기호는?', options:['=','==','+','!='], answer:1 }, tags:'비교,==,조건' },
    { topic:'문자열', chapter:4, concept:'글자를 담는 값',
      analogy:'편지 봉투에 글을 담는 것',
      example:'"안녕" + "루미"',
      h1:'어떤 글자를 담고 싶어?', h2:'문자열은 따옴표 안에 글자를 담는 거야.', h3:'따옴표로 감싸면 글자로 인식해.',
      quiz:{ q:'문자열을 만들 때 감싸는 것은?', options:['괄호','따옴표','대괄호','중괄호'], answer:1 }, tags:'문자열,따옴표,글자' },
    { topic:'while 반복', chapter:4, concept:'조건이 참인 동안 계속 반복',
      analogy:'비가 그칠 때까지 우산을 들고 기다리기',
      example:'while count < 3:',
      h1:'언제까지 반복하고 싶어?', h2:'while은 조건이 참인 동안 계속해.', h3:'조건이 언젠가 거짓이 되게 값을 바꿔 줘.',
      quiz:{ q:'조건이 참인 동안 반복하는 것은?', options:['if','for','while','def'], answer:2 }, tags:'while,반복,조건' },
    { topic:'오류 메시지', chapter:2, concept:'컴퓨터가 알려 주는 문제 설명',
      analogy:'선생님이 숙제에서 틀린 곳을 알려 주는 것',
      example:'SyntaxError: ...',
      h1:'오류 메시지에서 어떤 단어가 보여?', h2:'오류 메시지는 틀린 곳을 알려 주는 힌트야.', h3:'마지막 줄의 파일 이름과 줄 번호를 먼저 봐.',
      quiz:{ q:'오류 메시지에서 가장 먼저 확인할 것은?', options:['색깔','파일 이름과 줄 번호','글자 크기','소리'], answer:1 }, tags:'오류,에러,메시지' },
    { topic:'AI 윤리', chapter:5, concept:'AI를 쓸 때 지켜야 할 약속',
      analogy:'친구의 비밀을 함부로 말하지 않기',
      example:'내 사진을 허락 없이 올리지 않기',
      h1:'AI에게 어떤 정보를 주면 안 될까?', h2:'AI도 개인정보와 예의를 지켜야 해.', h3:'이름·얼굴·주소 같은 건 함부로 올리지 말자.',
      quiz:{ q:'AI를 쓸 때 하면 안 되는 것은?', options:['내가 쓴 글을 확인한다','친구 사진을 허락 없이 올린다','질문을 한다','결과를 다시 확인한다'], answer:1 }, tags:'AI윤리,개인정보,예의' }
  ];
  const ins = db.prepare(`INSERT INTO knowledge_cards(topic,chapter,concept,analogy,example,hint_l1,hint_l2,hint_l3,quiz,tags)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM knowledge_cards WHERE topic=?)`);
  let added = 0;
  for (const c of cards) {
    const r = ins.run(c.topic,c.chapter,c.concept,c.analogy,c.example,c.h1,c.h2,c.h3,JSON.stringify(c.quiz),c.tags,c.topic);
    if (r && r.changes) added++;
  }
  if (added) console.log('🧠 knowledge_cards 추가:', added, '개');
}

// ★ 2026-11-21 (v1.74) D1 지식 카드 24장 추가(컴퓨터개론 12 + 초등 수학·과학 12) — 멱등 INSERT.
//   규칙(기존 16장과 같은 구조 + prereq):
//   · quiz 4지선다 · 정답은 객관적으로 검증 가능한 것만(논쟁 문제 금지)
//   · h1(hint_l1)=되묻기/둘 중 고르기 · h2(hint_l2)=생활 비유 · h3(hint_l3)=다음 행동(정답어 금지)
//   · prereq=선수개념 topic(쉼표) — 컴퓨터개론·수학 사슬이 각자 순서를 이룬다
//   · 저장: topic 이 이미 있으면 건너뛴다(재실행 안전)
{
  const newCards = [
    // ---------- 컴퓨터개론 12장 (chapter 2) ----------
    { topic:'입출력', chapter:2, prereq:'입력,출력',
      concept:'컴퓨터에 넣고(입력) 결과를 꺼내 보는(출력) 모든 흐름',
      analogy:'카페에서 주문을 말하고(입력) 음료를 받는(출력) 계산대',
      example:'키보드로 입력 → 모니터로 출력',
      h1:'키보드는 값을 넣어 주는 쪽일까, 화면에 보여 주는 쪽일까?',
      h2:'카페에서 주문하면 음료가 나오지. 키보드가 주문, 모니터가 음료야.',
      h3:'컴퓨터 부품을 «넣어 주는 쪽 / 보여 주는 쪽» 두 그룹으로 나눠 표를 만들어 보자.',
      quiz:{ q:'마우스로 화면을 클릭하는 것은?', options:['출력이다','입력이다','저장이다','삭제이다'], answer:1 },
      tags:'입출력,입력,출력,마우스' },
    { topic:'바이너리', chapter:2, prereq:'',
      concept:'0과 1 두 개의 숫자만으로 모든 정보를 나타내는 방법',
      analogy:'전등 스위치 켬(1)·끔(0) 두 가지로 비밀 신호 보내기',
      example:'이진수 1010 은 십진수 10',
      h1:'전등 «켬/끔» 두 가지 신호만으로도 숫자를 만들 수 있을까?',
      h2:'전등을 여러 개 늘어 놓고 켜고 꺼서 신호를 보내는 것과 같아.',
      h3:'스위치 네 개를 그리고 켬·끔을 마음대로 골라 나만의 비밀 신호를 만들어 보자.',
      quiz:{ q:'바이너리(이진법)에서 쓰는 숫자는?', options:['1과 2','0부터 9','0과 1','A부터 F'], answer:2 },
      tags:'바이너리,이진법,0과 1' },
    { topic:'메모리', chapter:2, prereq:'입출력,바이너리',
      concept:'컴퓨터가 지금 쓰는 정보를 잠시 펼쳐 두는 작업 공간',
      analogy:'공부할 때 책상 위에 필요한 책을 펼쳐 놓는 것',
      example:'지금 열어 둔 앱과 문서는 메모리 위에 있어요',
      h1:'지금 하고 있는 일의 정보는 어디에 잠시 놓아 둘까?',
      h2:'책상 위에 공부할 책을 펼쳐 놓는 것처럼, 컴퓨터도 지금 할 일을 작업 공간에 펼쳐 놓아.',
      h3:'게임이나 앱을 끄면 어떤 정보가 사라질지 상상해서 말해 보자.',
      quiz:{ q:'지금 열어 둔 앱의 내용이 잠시 머무는 곳은?', options:['프린터','메모리','스피커','마우스'], answer:1 },
      tags:'메모리,램,작업공간,임시' },
    { topic:'RAM·ROM', chapter:2, prereq:'메모리',
      concept:'RAM 은 전원이 꺼지면 사라지는 임시 기억, ROM 은 지워지지 않는 읽기 전용 기억',
      analogy:'RAM 은 수업 칠판(지우면 사라짐), ROM 은 새겨 넣은 비석(그대로 남음)',
      example:'ROM 에는 컴퓨터를 켜는 첫 명령이 담겨 있어요',
      h1:'전원을 꺼도 남아야 할 내용은 칠판에 써 둘까, 돌에 새겨 둘까?',
      h2:'칠판은 수업이 끝나면 지워져. 새겨 둔 글자는 그대로 남지.',
      h3:'«지워지는 쪽» 과 «남는 쪽» 이 각각 어떤 기억 장치인지 노트에 적어 비교해 보자.',
      quiz:{ q:'전원을 꺼도 내용이 남아 있는 기억 장치는?', options:['RAM','마우스','ROM','모니터'], answer:2 },
      tags:'RAM,ROM,기억장치' },
    { topic:'캐시', chapter:2, prereq:'RAM·ROM',
      concept:'자주 쓰는 데이터를 곁에 두고 빨리 꺼내 쓰는 임시 보관함',
      analogy:'매일 쓰는 색연필만 책상 서랍에 꽂아 두기',
      example:'자주 보는 그림은 캐시 덕분에 다시 빨리 열려요',
      h1:'매번 멀리 가서 꺼내기엔 너무 자주 쓰는 물건은 뭘까?',
      h2:'매일 쓰는 색연필은 서랍에, 가끔 쓰는 것은 책장에 둬. 캐시가 바로 그 서랍이야.',
      h3:'자주 쓰는 물건 3개를 골라 «나의 서랍 규칙» 을 정해 보자.',
      quiz:{ q:'자주 쓰는 데이터를 곁에 두고 빨리 꺼내는 임시 보관함은?', options:['스피커','키보드','케이블','캐시'], answer:3 },
      tags:'캐시,cache,속도,보관함' },
    { topic:'CPU 클록', chapter:2, prereq:'캐시',
      concept:'CPU 가 명령을 처리하는 빠르기 — 초에 똑딱이는 횟수',
      analogy:'박자를 치는 메트로놈 — 똑딱이 빠를수록 노래가 빨리 진행된다',
      example:'클록 3GHz 는 초에 30억 번 똑딱',
      h1:'CPU 가 일하는 빠르기를 무엇으로 셀 수 있을까?',
      h2:'메트로놈이 빠르면 노래가 빨리 진행되지. CPU 도 똑딱이 빠를수록 일이 빨라져.',
      h3:'메트로놈 영상을 보며 «느림/빠름» 두 가지 박자를 따라 치며 비교해 보자.',
      quiz:{ q:'CPU 의 빠르기를 나타내는 것은?', options:['화면 크기','클록','케이블 색','마우스 개수'], answer:1 },
      tags:'CPU,클록,clock,GHz' },
    { topic:'운영체제 프로세스', chapter:2, prereq:'CPU 클록',
      concept:'실행 중인 프로그램 하나하나를 운영체제가 관리하는 단위',
      analogy:'여러 반을 돌아보며 순서를 정해 주는 선생님',
      example:'음악 앱과 게임이 같이 켜져도 운영체제가 순서를 나눠 줘요',
      h1:'여러 프로그램이 동시에 돌 때 누가 순서를 정해 줄까?',
      h2:'음악 앱과 게임이 같이 켜지면 운영체제가 선생님처럼 차례를 나눠 줘.',
      h3:'집 컴퓨터에서 지금 실행 중인 프로그램 세 개를 세어 목록을 만들어 보자.',
      quiz:{ q:'실행 중인 프로그램 하나를 부르는 말은?', options:['프로세스','키보드','폴더','파일'], answer:0 },
      tags:'운영체제,프로세스,OS,작업관리자' },
    { topic:'파일·디렉터리', chapter:2, prereq:'운영체제 프로세스',
      concept:'정보를 파일로 담고 디렉터리(폴더)로 정리하는 방법',
      analogy:'서류를 파일에 넣고 과목별 서랍에 정리하기',
      example:'내문서/사진/생일.jpg',
      h1:'사진과 숙제 파일이 한곳에 섞이면 어디서부터 찾기 쉬워질까?',
      h2:'책상 서랍을 과목별로 나누면 찾기 쉬워. 폴더가 바로 그 서랍이야.',
      h3:'내 파일을 주제별로 나눌 «서랍» 이름 세 개를 정해 보자.',
      quiz:{ q:'파일을 정리해 두는 «서랍» 을 부르는 말은?', options:['프로세스','RAM','클록','디렉터리(폴더)'], answer:3 },
      tags:'파일,폴더,디렉터리,정리' },
    { topic:'데이터베이스 테이블', chapter:2, prereq:'파일·디렉터리',
      concept:'정보를 행과 열로 깔끔하게 모아 둔 표(데이터 저장소)',
      analogy:'반 친구 이름·생일을 정리한 출석부',
      example:'학생 테이블 — 세로줄: 이름/반, 가로줄: 학생 한 명',
      h1:'친구 정보를 마구 섞어 두면 찾기 어렵겠지. 어떻게 정리하면 좋을까?',
      h2:'출석부처럼 가로줄(한 명)과 세로줄(정보 종류)로 정리하면 원하는 것을 금방 찾아.',
      h3:'가족 생일표를 행과 열로 정리해 직접 만들어 보자.',
      quiz:{ q:'데이터베이스에서 행과 열로 정보를 정리하는 단위는?', options:['테이블','폴더','캐시','프로세스'], answer:0 },
      tags:'데이터베이스,테이블,DB,표' },
    { topic:'네트워크 패킷', chapter:2, prereq:'바이너리',
      concept:'큰 데이터를 잘게 나눠 여러 번에 걸쳐 보내는 작은 소포',
      analogy:'큰 레고 성을 조각으로 나눠 여러 상자에 나눠 배송하기',
      example:'사진 한 장도 여러 조각으로 나뉘어 이동해요',
      h1:'사진 한 장을 한 번에 보내기 어렵다면 어떻게 나눠 보낼까?',
      h2:'레고 성을 한 상자에 못 넣으면 조각으로 나눠 보내지. 그 조각이 패킷이야.',
      h3:'나눠 간 소포가 도착하면 다시 합쳐진다고 상상하며 순서를 적어 보자.',
      quiz:{ q:'큰 데이터를 잘게 나눠 보내는 작은 조각은?', options:['프로세스','패킷','폴더','ROM'], answer:1 },
      tags:'네트워크,패킷,packet,소포' },
    { topic:'프로토콜', chapter:2, prereq:'네트워크 패킷',
      concept:'컴퓨터끼리 미리 정해 둔 약속된 대화 규칙',
      analogy:'전화를 받으면 «여보세요» 로 시작하는 예의',
      example:'HTTP 는 웹에서 쓰는 약속이에요',
      h1:'컴퓨터끼리 말을 주고받으려면 무엇을 먼저 정해 둘까?',
      h2:'전화할 때 «여보세요» 하고 시작하듯, 컴퓨터도 약속된 방식으로 말을 건네.',
      h3:'친구와 «비밀 신호 규칙» 을 하나 정하고 그 규칙으로 놀아 보자.',
      quiz:{ q:'컴퓨터끼리 정해 둔 통신 규칙은?', options:['패킷','테이블','프로토콜','캐시'], answer:2 },
      tags:'프로토콜,protocol,규칙,HTTP' },
    { topic:'압축', chapter:2, prereq:'파일·디렉터리',
      concept:'데이터를 규칙으로 줄여 작게 만드는 방법',
      analogy:'옷을 둥글게 말아 가방에 꾹꾹 눌러 담기',
      example:'큰 사진을 작게 줄이면 보내기 쉬워져요',
      h1:'가방에 옷이 너무 많으면 어떻게 담으면 더 들어갈까?',
      h2:'여행 가방에 옷을 말아 눌러 담으면 더 많이 들어가. 데이터도 그렇게 줄여 담아.',
      h3:'용량이 다른 파일 두 개를 골라 «작게 줄이는» 방법을 말해 보자.',
      quiz:{ q:'데이터를 작게 줄여 담는 것은?', options:['복사','출력','삭제','압축'], answer:3 },
      tags:'압축,zip,용량' },
    // ---------- 초등 수학·과학 12장 (chapter 3) ----------
    { topic:'곱셈 순서', chapter:3, prereq:'산술 연산',
      concept:'+, - 보다 ×, ÷ 를 먼저 계산하기로 약속한 규칙',
      analogy:'계산에도 «먼저 할 사람» 줄 세우기가 있다는 것',
      example:'3 + 4 × 2 = 3 + 8 = 11',
      h1:'3 + 4 × 2 에서 먼저 계산할 것은 덧셈일까, 곱셈일까?',
      h2:'놀이 순서 정하기처럼 계산에도 «먼저 할 사람» 이 있어. 곱셈이 먼저야.',
      h3:'3 + 4 × 2 를 두 가지 순서로 각각 계산해 보고 답이 어떻게 달라지는지 비교해 보자.',
      quiz:{ q:'3 + 4 × 2 를 바르게 계산하면?', options:['14','11','24','10'], answer:1 },
      tags:'곱셈,연산순서,사칙연산' },
    { topic:'분수의 덧셈', chapter:3, prereq:'산술 연산',
      concept:'조각 크기(분모)를 같게 맞춘 뒤 조각 수(분자)를 더하는 계산',
      analogy:'피자를 같은 크기로 다시 자른 뒤 조각 수를 세기',
      example:'1/2 + 1/3 = 3/6 + 2/6 = 5/6',
      h1:'1/2 와 1/3 — 조각 크기가 같을까, 다를까?',
      h2:'피자를 2조각과 3조각으로 자르면 크기가 달라. 같은 크기로 다시 잘라야 더할 수 있어.',
      h3:'1/2 를 6조각 크기로 다시 나타내 적어 보자.',
      quiz:{ q:'1/2 + 1/4 의 답은?', options:['2/6','3/4','1/6','2/4'], answer:1 },
      tags:'분수,덧셈,분모' },
    { topic:'약분·통분', chapter:3, prereq:'분수의 덧셈',
      concept:'분수의 모양을 바꿔도 크기가 같음을 이용해 분모를 통일하거나 줄이는 방법',
      analogy:'같은 물감 양을 «2통» 으로도 «4개의 반 통» 으로도 세는 것',
      example:'2/4 를 줄이면 1/2',
      h1:'2/4 와 1/2 는 크기가 같을까, 다를까?',
      h2:'케이크의 4등분 중 2조각은 반 조각과 같은 양이야. 쓴 모양만 다를 뿐이야.',
      h3:'3/6 과 4/8 을 가장 간단한 모양으로 바꿔 적어 보자.',
      quiz:{ q:'2/6 을 가장 간단한 모양으로 줄이면?', options:['2/3','1/6','1/3','3/6'], answer:2 },
      tags:'약분,통분,분수' },
    { topic:'소수', chapter:3, prereq:'분수의 덧셈,약분·통분',
      concept:'자연수 사이를 10 등분한 눈금으로 나타낸 수',
      analogy:'1 미터 자에서 눈금 하나(0.1) 읽기',
      example:'0.5 는 1/2 와 같은 크기예요',
      h1:'1과 2 사이의 딱 절반은 어떤 기호로 쓸 수 있을까?',
      h2:'자의 눈금처럼 1 사이를 10칸으로 나눠 읽으면 0.1, 0.2 … 처럼 쓸 수 있어.',
      h3:'자로 0.1 부터 0.9 까지 차례로 가리키며 소리 내어 읽어 보자.',
      quiz:{ q:'0.5 와 크기가 같은 것은?', options:['1/5','1/2','5/2','0.2'], answer:1 },
      tags:'소수,decimal,눈금' },
    { topic:'도형 넓이', chapter:3, prereq:'곱셈 순서',
      concept:'직사각형 안에 같은 크기 칸이 몇 개 들어가는지 세는 양',
      analogy:'바닥에 같은 크기 타일이 몇 장 깔리는지 세기',
      example:'가로 4 × 세로 3 = 넓이 12',
      h1:'가로 4칸, 세로 3칸 바닥에는 타일이 모두 몇 장 깔릴까?',
      h2:'타일을 한 줄씩 세어 보면 «가로×세로» 와 같아진다는 걸 알 수 있어.',
      h3:'연습장 칸에 가로 5, 세로 3 직사각형을 그리고 칸 수를 직접 세어 보자.',
      quiz:{ q:'가로 5, 세로 3 인 직사각형의 넓이는?', options:['8','16','15','10'], answer:2 },
      tags:'넓이,면적,직사각형,타일' },
    { topic:'각도', chapter:3, prereq:'',
      concept:'두 변이 만나서 벌어진 크기',
      analogy:'시계 바늘이 벌어진 폭으로 시간을 보는 것',
      example:'직각은 90도예요',
      h1:'3시의 시계 바늘은 얼마나 벌어져 있을까?',
      h2:'시계 바늘이 벌어진 폭이 바로 각도야. 3시의 바늘 모양은 딱 반쪽 사각형이지.',
      h3:'집 안에서 «반쪽 사각형» 모양으로 벌어진 곳 세 곳을 찾아 적어 보자.',
      quiz:{ q:'직각의 각도는?', options:['45도','180도','30도','90도'], answer:3 },
      tags:'각도,도,직각,각도기' },
    { topic:'물의 상태', chapter:3, prereq:'',
      concept:'같은 물이 온도에 따라 고체(얼음)·액체(물)·기체(수증기)로 모습을 바꾼다',
      analogy:'같은 인형이 온도에 따라 옷을 갈아입는 것',
      example:'0도에서 얼고, 100도에서 끓어요',
      h1:'냉동실의 얼음과 컵의 물은 다른 것일까, 같은 것일까?',
      h2:'같은 물이 온도에 따라 옷(모습)을 갈아입는 거야. 얼음·물·김 전부 물이야.',
      h3:'얼음을 녹였다가 다시 얼려 보며 모습 변화를 그림으로 기록해 보자.',
      quiz:{ q:'물이 기체가 된 모습은?', options:['얼음','수증기','눈사람','물방울'], answer:1 },
      tags:'물,상태,얼음,수증기' },
    { topic:'온도와 열', chapter:3, prereq:'물의 상태',
      concept:'온도는 «얼마나 따뜻한지» 눈금이고, 열은 따뜻함이 이동하는 것',
      analogy:'따뜻한 손으로 차가운 손을 잡으면 온기가 옮아 가는 것',
      example:'뜨거운 컵을 찬물에 담그면 컵의 열이 물로 옮아 가요',
      h1:'뜨거운 컵을 찬물에 담그면 따뜻함은 어디로 갈까?',
      h2:'손이 따뜻하면 옆 사람 손도 따뜻해지지. 열은 따뜻한 쪽에서 차가운 쪽으로 옮아 가.',
      h3:'따뜻한 물과 찬물을 번갈아 만져 보고 «따뜻함이 이동한 길» 을 손가락으로 가리켜 보자.',
      quiz:{ q:'열이 이동하는 방향은?', options:['차가운 곳에서 따뜻한 곳으로','따뜻한 곳에서 차가운 곳으로','위에서 아래로만 이동한다','오른쪽에서 왼쪽으로만 이동한다'], answer:1 },
      tags:'온도,열,이동' },
    { topic:'빛의 반사', chapter:3, prereq:'',
      concept:'빛이 물체에 부딪혀 되튕겨 나오는 현상',
      analogy:'벽에 던진 공이 튕겨 돌아오는 것',
      example:'거울은 빛을 잘 튕겨 내요',
      h1:'어두운 방에서 거울에 내 모습이 보이려면 무엇이 필요할까?',
      h2:'벽에 던진 공이 튕겨 돌아오듯, 빛도 거울에 부딪혀 되튕겨 눈에 들어와.',
      h3:'어두운 곳에서 손전등을 거울에 비추며 되돌아오는 길을 관찰해 보자.',
      quiz:{ q:'거울에 빛이 되튕겨 나오는 현상은?', options:['투명','흡수만 되는 것','반사','소리'], answer:2 },
      tags:'빛,반사,거울' },
    { topic:'자석', chapter:3, prereq:'',
      concept:'쇠 종류를 끌어당기거나 밀어내는 힘을 가진 물체',
      analogy:'보이지 않는 팔로 쇠를 붙잡는 것',
      example:'같은 극끼리는 밀고, 다른 극은 끌어당겨요',
      h1:'자석이 붙는 것과 안 붙는 것은 어떻게 다를까?',
      h2:'자석은 보이지 않는 팔로 쇠를 붙잡아. 같은 극은 밀어내고 다른 극은 끌어당겨.',
      h3:'집에서 자석이 붙는 물건 세 개를 찾아 목록을 만들어 보자.',
      quiz:{ q:'자석의 N 극과 N 극을 가까이 두면?', options:['서로 밀어낸다','서로 붙는다','아무 일도 없다','녹아 없어진다'], answer:0 },
      tags:'자석,N극,S극,자기력' },
    { topic:'식물 광합성', chapter:3, prereq:'물의 상태',
      concept:'식물이 빛·물·공기 중 기체로 겉면에서 양분을 만드는 일',
      analogy:'태양빛을 반죽으로 써서 양분 빵을 굽는 식물의 부엌',
      example:'잎이 광합성의 주방이에요',
      h1:'식물은 밥을 안 먹는데 무엇으로 힘을 낼까?',
      h2:'잎은 식물의 부엌이야. 빛과 물을 재료로 양분을 만들어 내.',
      h3:'창가 화분과 어두운 방 화분의 자라는 모습을 비교해 기록해 보자.',
      quiz:{ q:'광합성에 꼭 필요한 재료는?', options:['어둠','장난감','빛','포장지'], answer:2 },
      tags:'광합성,식물,잎,양분' },
    { topic:'지층', chapter:3, prereq:'',
      concept:'오랜 시간 흙과 돌이 겹겹이 쌓여 만든 층',
      analogy:'샌드위치를 아래 빵부터 차곡차곡 쌓는 것',
      example:'지층의 겹을 보면 쌓인 순서를 알 수 있어요',
      h1:'강가 절벽에 줄줄이 보이는 무늬는 무엇일까?',
      h2:'샌드위치를 아래에서부터 차곡차곡 쌓듯, 흙도 오래 쌓여 겹을 만들어.',
      h3:'컵에 모래·자갈·흙을 순서대로 부어 나만의 겹을 만들어 보자.',
      quiz:{ q:'지층에서 «먼저 쌓인 겹» 은 어디에 있을까?', options:['가장 위','가장 아래','가운데','바깥에'], answer:1 },
      tags:'지층,층,화석,쌓임' },
  ];
  const ins = db.prepare(`INSERT INTO knowledge_cards(topic,chapter,concept,analogy,example,hint_l1,hint_l2,hint_l3,quiz,tags,prereq)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM knowledge_cards WHERE topic=?)`);
  let added74 = 0;
  for (const c of newCards) {
    const r = ins.run(c.topic, c.chapter, c.concept, c.analogy, c.example, c.h1, c.h2, c.h3,
      JSON.stringify(c.quiz), c.tags, c.prereq || '', c.topic);
    if (r && r.changes) added74++;
  }
  if (added74) console.log('🧠 knowledge_cards (v1.74) 추가:', added74, '개');
}

// ---------- 2. 시드 데이터: 성격 대사(아동용 한국어) + 상점 아이템 ----------
const seedLines = [
  ['활발이','greeting','안녕! 나 너랑 같이 뛰어놀고 싶어! 에너지 부스터 온!'],
  ['활발이','feed','와, 맛있다! 배부르니까 더 신나는 거 있지?'],
  ['활발이','praise','헤헤, 나 최고인 거 알아! 너도 최고야!'],
  ['차분이','greeting','안녕... 나 조용히 네 옆에 있을게.'],
  ['차분이','feed','고마워. 천천히 잘 먹을게.'],
  ['차분이','praise','응, 네 말이 기분 좋아. 오늘도 잘 부탁해.'],
  ['반짝이','greeting','빙그르르~ 오늘 하루도 빛나게 만들어줄게!'],
  ['반짝이','feed','우와~ 배터리가 반짝반짝 충전됐다!'],
  ['반짝이','praise','너랑 있으면 매일이 별처럼 반짝반짝!'],
  ['숲돌이','greeting','안녕~ 오늘도 함께 지구를 지켜보자!'],
  ['숲돌이','feed','싱싱한 에너지야! 고마워, 친구!'],
  ['숲돌이','praise','너는 정말 다정다감한 친구구나!'],
  ['몽글이','greeting','몽글몽글... 어서 와. 꿈을 함께 그려보자.'],
  ['몽글이','feed','몽글... 달콤한 충전이야. 고마워.'],
  ['몽글이','praise','헤헤... 너랑 있으면 꿈속에 온 것 같아.'],
  ['멋돌이','greeting','왔구나. 오늘도 스타일리시하게 가보자구.'],
  ['멋돌이','feed','쿨하게 잘 먹었습니다. 역시 너뿐이야.'],
  ['멋돌이','praise','인정. 너랑 나, 최고의 콤비야.'],
];
const seedItems = [
  ['안테나 리본','part',80],
  ['로켓 부스터','part',120],
  ['나사 장식','part',60],
  ['별 스티커','decor',40],
  ['선물 상자','decor',100],
];
// ★ P0-5 경제 확장: 기존 5개는 전부 "1회 보유"라 6일 안에 전부 사면 구매 동기 자체가 사라졌다.
//   아래 두 종류를 추가해 소비처를 늘린다.
//   1) 색칠 스킨(consumable=1): 반복 구매 가능. 이 프로젝트의 핵심 행동이 "칠하기"이므로
  //      같은 외형에 다른 색을 사는 것은 세계관과도 맞다(재활용이므로 어색하지 않다).
//   2) 부품 조각: 모으기(collect) 동기 — 3개 모이면 부품 1개와 교환.
const seedSkins = [
  ['파란 포커 스킨','skin',30], ['핑크 포커 스킨','skin',30],
  ['민트 포커 스킨','skin',30], ['노랑 포커 스킨','skin',30],
];
const seedShards = [
  ['부품 조각','shard',20],
];
const lineCount = db.prepare('SELECT COUNT(*) c FROM robot_lines').get().c;
if (lineCount === 0) {
  for (const [p,s,l] of seedLines) db.prepare('INSERT INTO robot_lines(personality,situation,line) VALUES(?,?,?)').run(p,s,l);
  for (const [n,t,p] of seedItems) db.prepare('INSERT INTO items(name,type,price) VALUES(?,?,?)').run(n,t,p);
}
// 소비 가능 여부(소지품=0 / 소모품=1)는 시드가 모두 삽입된 뒤에 설정한다.
// (먼저 UPDATE 하면 아직 행이 없어 반영되지 않는다 — 순서 중요)
const skinCount = db.prepare("SELECT COUNT(*) c FROM items WHERE type='skin'").get().c;
if (skinCount === 0) {
  for (const [n,t,p] of seedSkins) db.prepare('INSERT INTO items(name,type,price) VALUES(?,?,?)').run(n,t,p);
}
const shardCount = db.prepare("SELECT COUNT(*) c FROM items WHERE type='shard'").get().c;
if (shardCount === 0) {
  for (const [n,t,p] of seedShards) db.prepare('INSERT INTO items(name,type,price) VALUES(?,?,?)').run(n,t,p);
}
// 이제 모든 아이템 행이 존재하므로 소모품 플래그를 설정한다(멱등).
try{ db.exec("UPDATE items SET consumable=1 WHERE type IN ('skin','shard')"); }catch(e){}

// ★ V11 주말 한정 아이템 — '주말에만 열린다'는 예고가 재방문 이유가 된다.
//   스킨으로만 구성한다: 색이 실제로 바뀌므로 "사도 안 보이는" 함정이 될 수 없다.
//   (보라 스킨은 SKIN_PALETTES 에 이미 정의돼 있어 그대로 쓸 수 있다)
const seedWeekend = [
  ['보라 포커 스킨', 'skin', 45, '0,6'],
  ['무지개 스킨',   'skin', 60, '0,6'],
];
const weekendCount = db.prepare('SELECT COUNT(*) c FROM items WHERE limited_days IS NOT NULL').get().c;
if (weekendCount === 0) {
  for (const [n,t,p,d] of seedWeekend)
    db.prepare('INSERT INTO items(name,type,price,limited_days) VALUES(?,?,?,?)').run(n,t,p,d);
  db.exec("UPDATE items SET consumable=1 WHERE limited_days IS NOT NULL AND type='skin'");
}

// ★ v1.64 «한정 판매(기간)» — 주말 한정(limited_days)과 별개로, 정해진 날짜가 지나면 판매 종료.
try{ db.exec('ALTER TABLE items ADD COLUMN sale_end TEXT'); }catch(e){}
const seedSaleEnd = [
  ['하늘 스킨',  'skin', 55, '2026-11-24'],
  ['복숭아 스킨','skin', 55, '2026-11-24'],
];
for(const [n,t,p,end] of seedSaleEnd){
  const ex = db.prepare('SELECT id FROM items WHERE name=?').get(n);
  if(!ex) db.prepare('INSERT INTO items(name,type,price,consumable,sale_end) VALUES(?,?,?,1,?)').run(n,t,p,end);
}
// 이미 팔리고 있는 «무지개 스킨» 은 프론트 팔레트가 없어 사도 색이 안 바뀌었다 → v1.64 에서 팔레트 추가.

// ---------- 3. LLM — 1차(사용자 지정 모델) → 2차(DeepSeek) → 프리셋 ----------
// ★ 2026-11-11: «새 API 를 DeepSeek 앞에 두고, 그 모델이 안 되면 DeepSeek 으로» 요청 반영.
//   - 1차: PRIMARY_LLM_BASE_URL + PRIMARY_LLM_MODEL + primary_key.txt (OpenAI 호환)
//   - 2차: DeepSeek (기존 동작 그대로)
//   - 모델별 독립 회로 차단: 1차가 죽으면 60초(401/402 는 10분) 동안 건너뛰어
//     매 요청마다 1차 타임아웃을 기다리지 않게 한다.
//   - 주소/모델명이 없으면 DeepSeek 단독으로 동작한다(하위 호환, 배포 안전).
const fs = require('fs');
function readKeyFile(name){
  try{ return fs.readFileSync(path.join(__dirname, name), 'utf8').trim(); }catch{ return ''; }
}
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || readKeyFile('deepseek_key.txt');
const PRIMARY_KEY = process.env.PRIMARY_LLM_API_KEY || readKeyFile('primary_key.txt');
// ★ LG EXAONE API Platform (2026-11-09 공개) — OpenAI 호환, 무료, 모델 ID k-exaone_v2.5
const PRIMARY_BASE = String(process.env.PRIMARY_LLM_BASE_URL || 'https://api.exaone.ai/v1').trim().replace(/\/+$/, '');
const PRIMARY_MODEL = String(process.env.PRIMARY_LLM_MODEL || 'k-exaone_v2.5').trim();
// 이 모델은 항상 추론한다. 실제 채팅 프롬프트 기준 약 22초가 걸려 28초를 준다.
//   (짧은 프롬프트는 1.6~3초지만, 아동 안전 규칙이 들어간 system prompt 는 훨씬 길다.)
const PRIMARY_TIMEOUT_MS = Number(process.env.PRIMARY_LLM_TIMEOUT_MS || 28000);
const DEEPSEEK_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 6000);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 220);

const PRIMARY_READY = !!(PRIMARY_KEY && PRIMARY_BASE && PRIMARY_MODEL);
const LLM_PROVIDERS = [
  ...(PRIMARY_READY ? [{
    name:'primary', key:PRIMARY_KEY, model:PRIMARY_MODEL,
    url: PRIMARY_BASE + '/chat/completions', timeout: PRIMARY_TIMEOUT_MS,
    // EXAONE 2.5: 추론을 끌 수 없어 low 로 낮추고, max_tokens 에 추론 토큰까지 포함되므로 여유를 준다.
    reasoning_effort:'low', minMaxTokens:700
  }] : []),
  ...(DEEPSEEK_KEY ? [{
    name:'deepseek', key:DEEPSEEK_KEY, model:DEEPSEEK_MODEL,
    url:'https://api.deepseek.com/v1/chat/completions', timeout: LLM_TIMEOUT_MS
  }] : [])
];
// ★ v1.57: 기본값을 «전부 DeepSeek 우선» 으로 되돌린다.
//   EXAONE 은 429 가 잦고 성공해도 20초대라 체감이 느리다 → DeepSeek 실패 시에만 마지막 폴백.
//   품질 우선으로 되돌리고 싶을 때만 LLM_FORCE_FAST=0.
const LLM_FORCE_FAST = process.env.LLM_FORCE_FAST !== '0';
const llmDown = {};
let lastLLMModel = DEEPSEEK_MODEL;
if(!PRIMARY_READY) console.log('ℹ️ [LLM] 1차 모델 미설정(주소·모델명 필요) → DeepSeek 단독');
else console.log(`ℹ️ [LLM] 1차 ${PRIMARY_MODEL} → 2차 ${DEEPSEEK_MODEL}`);

function withTimeout(promise, ms){
  let t;
  const timeout = new Promise((_,rej)=>{ t = setTimeout(()=>rej(new Error('LLM_TIMEOUT')), ms); });
  return Promise.race([promise, timeout]).finally(()=>clearTimeout(t));
}
function llmStatus(){
  return {
    providers: LLM_PROVIDERS.map(p=>({ name:p.name, model:p.model,
      downForMs: Math.max(0, (llmDown[p.name]||0) - Date.now()) })),
    lastModel: lastLLMModel, primaryConfigured: PRIMARY_READY
  };
}

// opts: { temperature, maxTokens, messages, json } — messages 가 없으면 단일 prompt
// ★ v1.52 «적게 쓰기» — 호출마다 실제 토큰을 남긴다. 계측 없이는 «절약» 을 말할 수 없다.
// ★ 계량 정확성: 반환을 { text, usage, model, provider, promptChars } 한 묶음으로 단일화한다.
//   예전의 모듈 전역(lastLLMUsage 등)은 동시 요청끼리 서로 덮어써 llm_logs 계량이 어긋났다.
async function callLLM(prompt, opts){
  const noResult = { text:null, usage:null, model:null, provider:null, promptChars:0 };
  if(!LLM_PROVIDERS.length) return noResult;
  const o = opts || {};
  const temperature = o.temperature != null ? o.temperature : 0.8;
  const maxTokens = o.maxTokens || LLM_MAX_TOKENS;
  const messages = o.messages || [{ role:'user', content:String(prompt||'') }];
  const base = { messages, temperature, max_tokens: maxTokens };
  if(o.json) base.response_format = { type:'json_object' };
  const promptChars = messages.reduce((a,m)=>a+String(m.content||'').length,0);
  let usage = null;
  // ★ v1.52: 짧은 대화(수다·마음)는 «싼 모델 먼저». 학습만 품질 우선으로 1차 모델을 쓴다.
  const order = (o.prefer === 'fast' || LLM_FORCE_FAST)
    ? [...LLM_PROVIDERS].sort((a,b)=>(a.name==='deepseek'?0:1)-(b.name==='deepseek'?0:1))
    : LLM_PROVIDERS;

  for(const p of order){
    if(Date.now() < (llmDown[p.name] || 0)) continue;
    let timer = null;
    try{
      const ac = new AbortController();
      timer = setTimeout(()=>ac.abort(), p.timeout);
      const payload = Object.assign({ model:p.model }, base);
      if(p.reasoning_effort) payload.reasoning_effort = p.reasoning_effort;
      if(p.minMaxTokens) payload.max_tokens = Math.max(payload.max_tokens, p.minMaxTokens);
      const req = fetch(p.url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${p.key}`},
        body: JSON.stringify(payload),
        signal: ac.signal
      }).then(async r=>{
        clearTimeout(timer); timer = null;
        if(!r.ok) return { failed:true, status:r.status };
        const j = await r.json();
        usage = j && j.usage ? j.usage : null;
        return { text: j.choices?.[0]?.message?.content || '' };
      });
      const res = await withTimeout(req, p.timeout);
      if(res.failed){
        const wait = [401,402,429].includes(res.status) ? 10*60*1000 : 60*1000;
        llmDown[p.name] = Date.now() + wait;
        console.log(`⚠️ [LLM] ${p.name} ${res.status} → ${Math.round(wait/1000)}s 건너뛰고 다음 모델`);
        continue;
      }
      // EXAONE 은 답이 «\n\n» 으로 시작한다 — 앞뒤 공백을 지워야 아이에게 빈 줄이 보이지 않는다.
      const clean = String(res.text || '').trim();
      if(clean){
        lastLLMModel = p.model;   // 상태 표시용(/api/llm/status). 계량은 반환값을 쓴다.
        return { text:clean, usage, model:p.model, provider:p.name, promptChars };
      }
      // 빈 응답도 실패로 본다 — 바로 프리셋으로 떨어지지 않고 다음 모델을 시도
      console.log(`⚠️ [LLM] ${p.name} 빈 응답 → 다음 모델`);
    }catch(e){
      llmDown[p.name] = Date.now() + 60*1000;
      console.log(`💤 [LLM] ${p.name} ${e.name||e.message} → 60s 건너뛰고 다음 모델`);
    }finally{
      if(timer) clearTimeout(timer);
    }
  }
  return { text:null, usage, model:null, provider:null, promptChars };
}

// ★ v1.54 «진짜 토큰 스트리밍» — OpenAI 호환 stream:true 를 읽어 delta 마다 onDelta 로 넘긴다.
//   주의: 이미 delta 를 보낸 뒤에는 다른 provider 로 갈아타면 글이 겹친다 → 그 전까지만 재시도.
// ★ 계량 정확성: callLLM 과 같은 반환 규약 { text, usage, model, provider, promptChars }.
async function callLLMStream(prompt, opts, onDelta){
  const noResult = { text:null, usage:null, model:null, provider:null, promptChars:0 };
  if(!LLM_PROVIDERS.length) return noResult;
  const o = opts || {};
  const messages = o.messages || [{ role:'user', content:String(prompt||'') }];
  const base = {
    messages,
    temperature: o.temperature != null ? o.temperature : 0.8,
    max_tokens: o.maxTokens || LLM_MAX_TOKENS,
    stream: true,
  };
  const promptChars = messages.reduce((a,m)=>a+String(m.content||'').length,0);
  let usage = null;
  const order = (o.prefer === 'fast' || LLM_FORCE_FAST)
    ? [...LLM_PROVIDERS].sort((a,b)=>(a.name==='deepseek'?0:1)-(b.name==='deepseek'?0:1))
    : LLM_PROVIDERS;

  for(const p of order){
    if(Date.now() < (llmDown[p.name] || 0)) continue;
    let sent = false;
    try{
      const ac = new AbortController();
      // 스트리밍은 «전체 생성 시간» 이 필요하다. DeepSeek 의 6초 제한을 그대로 쓰면 중간에 끊긴다.
      const timer = setTimeout(()=>ac.abort(), Math.max(p.timeout, 20000));
      const payload = Object.assign({ model:p.model }, base);
      if(p.reasoning_effort) payload.reasoning_effort = p.reasoning_effort;
      if(p.minMaxTokens) payload.max_tokens = Math.max(payload.max_tokens, p.minMaxTokens);
      const r = await fetch(p.url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${p.key}`},
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if(!r.ok || !r.body){
        clearTimeout(timer);
        const wait = [401,402,429].includes(r.status) ? 10*60*1000 : 60*1000;
        llmDown[p.name] = Date.now() + wait;
        continue;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', full = '';
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        buf += dec.decode(value, { stream:true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for(const line of lines){
          const t = line.trim();
          if(!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if(!data || data === '[DONE]') continue;
          let j = null;
          try{ j = JSON.parse(data); }catch(e){ continue; }
          if(j.usage) usage = j.usage;
          const d = j.choices && j.choices[0] && j.choices[0].delta
            ? j.choices[0].delta.content : null;
          if(d){
            // ★ v1.58: «두 문장» 은 화면에서도 지킨다. 넘치는 부분은 붙이지 않고 읽기를 멈춘다.
            let piece = d;
            if(o.maxSentences){
              const before = (full.match(/[.!?…]/g) || []).length;
              const room = o.maxSentences - before;
              if(room <= 0){ try{ await reader.cancel(); }catch(e){} break; }
              let seen = 0, cut = piece.length;
              for(let i=0;i<piece.length;i++){
                if(/[.!?…]/.test(piece[i])){ seen++; if(seen >= room){ cut = i+1; break; } }
              }
              piece = piece.slice(0, cut);
              if(!piece){ try{ await reader.cancel(); }catch(e){} break; }
            }
            full += piece; sent = true; if(onDelta) onDelta(piece);
            if(o.maxSentences && (full.match(/[.!?…]/g) || []).length >= o.maxSentences){
              try{ await reader.cancel(); }catch(e){}
              break;
            }
          }
        }
      }
      clearTimeout(timer);
      if(full.trim()){
        lastLLMModel = p.model;   // 상태 표시용(/api/llm/status). 계량은 반환값을 쓴다.
        return { text:full.trim(), usage, model:p.model, provider:p.name, promptChars };
      }
      // 빈 응답이면 다음 모델. 단, 이미 화면에 보낸 글이 있으면 중복을 막기 위해 멈춘다.
      if(sent) return { text:full.trim(), usage, model:p.model, provider:p.name, promptChars };
      console.log(`⚠️ [LLM:stream] ${p.name} 빈 응답 → 다음 모델`);
    }catch(e){
      if(sent) return noResult;   // 이미 보낸 글이 있으면 재시도하지 않는다
      llmDown[p.name] = Date.now() + 60*1000;
      console.log(`💤 [LLM:stream] ${p.name} ${e.name||e.message} → 60s 건너뛰기`);
    }
  }
  return noResult;
}

// ---------- 3. AI 성격 엔진 (LLM 우선, 색→성격 매핑은 결정론 유지) ----------
const COLOR_PERSONA = {
  '#e74c3c':'활발이', '#ff8c42':'활발이',
  '#3498db':'차분이', '#1abc9c':'차분이',
  '#f1c40f':'반짝이', '#ffd93d':'반짝이',
  '#2ecc71':'숲돌이', '#8bc34a':'숲돌이',
  '#9b59b6':'몽글이', '#c39bd3':'몽글이',
  '#e91e8c':'반짝이', '#f48fb1':'반짝이',
  '#34495e':'멋돌이', '#222222':'멋돌이',
};
const TRAITS = {
  '활발이':'언제나 에너지 넘치는', '차분이':'늘 차분하고 든든한',
  '반짝이':'하루를 빛나게 하는', '숲돌이':'다정하고 따뜻한',
  '몽글이':'몽글몽글 상상력 가득한', '멋돌이':'언제나 멋진',
};
async function generatePersonality(palette){
  // 색→성격: 규칙의 결정론 유지(LLM은 대사 다듬기만 하고 성격을 임의로 고르지 않음)
  const main = COLOR_PERSONA[(palette.body||'').toLowerCase()] || '반짝이';
  const sub  = COLOR_PERSONA[(palette.antenna||'').toLowerCase()];
  const fallbackDesc = TRAITS[main] + (sub && sub !== main ? `, ${TRAITS[sub]} 매력까지!` : '') + ' 루미';
  const fb = db.prepare("SELECT line FROM robot_lines WHERE personality=? AND situation='greeting' ORDER BY RANDOM() LIMIT 1").get(main);
  const fallbackGreeting = fb ? fb.line : '안녕! 함께하자!';
  // LLM: 배색에 맞춘 개인화 인사와 소개 생성
  const colors = Object.entries(palette).map(([k,v])=>`${k}=${v}`).join(', ');
  const prompt = `너는 어린이 코딩 교육 플랫폼 DOROBUS의 캐릭터 작가다. 아이가 로봇을 이렇게 색칠했다: ${colors}. 그래서 로봇의 성격은 "${main}"(${TRAITS[main]})로 정해져 있다. 아래 JSON만 출력해라 (다른 설명 금지): {"greeting":"로봇의 첫 인사말. 한국어, 어린이 말투, 25자 이내","desc":"이 로봇의 성격 소개. 한국어 한 문장, 40자 이내"}. 출력은 초등학생에게 안전하고 건전한 표현만 사용한다.`;
  const pl = await callLLM(prompt);
  const txt = pl ? pl.text : null;
  if(txt){
    try{
      const j = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
      // ★ 반드시 안전 필터를 통과시켜야 한다.
      //   이 두 필드는 robots 테이블에 저장되어 아이 화면에 그대로 나오고,
      //   로봇이 처음 말하는 첫마디가 된다 — 가장 노출 위험이 높은 자리.
      //   prompt 로만 통제하면 우회되므로 sanitizeLine 으로 다시 검사한다.
      //   하나라도 통과하지 못하면 안전한 고정 문장으로 대체한다.
      const greeting = sanitizeLine(j.greeting, 60);
      const desc     = sanitizeLine(j.desc, 80);
      if(greeting && desc) return { personality: main, greeting, desc };
      // 일부만 통과하면 통과한 것만 쓰고 나머지는 고정값
      return { personality: main, greeting: greeting || fallbackGreeting, desc: desc || fallbackDesc };
    }catch{}
  }
  return { personality: main, greeting: fallbackGreeting, desc: fallbackDesc };
}

// ---------- 4. 오늘의 퀘스트 (날짜 기준 결정적 생성) ----------
// ★ AI 미션: 하루에 질문 풀 5개를 LLM 1회 호출로 생성 → 유저마다 uid 해시로 다른 질문 배정
// ★ P1-3 미션 풀 크기: 5 → 3. 예전에는 5개를 만들어 정작 유저 1명에게 1개만 배정해
//   4/5의 LLM 생성 비용이 테스트 계정 수 때문에 그대로 버려졌다. 3개로 줄여 낭비를 막는다.
const MISSION_POOL_SIZE = 3;
// ★ V12 주제별 예비 질문 — LLM 이 실패해도 '이번 주 주제'와 이어지게 한다.
//   (예전 예비 질문은 주제와 무관한 일상 질문이라, 실패 시 연결이 끊겼다)
const TOPIC_PRESETS = [
  // v1.34: 저학년도 바로 답할 수 있는 «구체적인 장면» 질문으로 (예전엔 «알려준다면 뭐라고 할래» 처럼 한 번 더 생각해야 했다)
  ['이번 주에 처음 알게 된 게 있니?', '오늘 학교에서 제일 웃긴 일은 뭐였어?', '이번 주에 제일 신난 일은 뭐야?'],
  ['무언가 고장 났을 때 어떻게 했니?', '오늘 어려운 문제를 어떻게 해결했어?', '다시 도전해 보고 싶은 일이 있니?'],
  ['오늘 모은 것 중에 제일 아끼는 건 뭐야?', '친구에게 나눠준 적이 있니?', '내일 더 모으고 싶은 것은 뭐야?'],
  ['오늘 순서대로 한 일을 말해볼래?', '규칙을 지켜서 좋았던 일이 있니?', '가보고 싶은 곳이 있니?'],
  ['오늘 궁금했던 것은 뭐야?', '로봇에게 물어보고 싶은 게 있니?', '오늘 누구를 도와줬어?'],
];
const presetsForTopic = (topic) => TOPIC_PRESETS[(Math.max(1, topic.chapter) - 1) % TOPIC_PRESETS.length];
// ★ v1.34 아동 눈높이 — 초등 저학년이 모르는 «어른 세계» 어휘가 섞인 질문은 만들지도, 남기지도 않는다.
//   (실제 사례: "첫 출근하는 기분을 내 경험에 빗대면 어땠나요?" → 아이가 답할 수 없는 질문)
const ADULT_WORDS = /(출근|회사|직장|업무|회의|보고서|야근|상사|동료|입사|퇴사|경력|빗대|비유하|프로젝트|매출|실적|인터뷰)/;
async function ensureQuests(dateStr) {
  const rows = db.prepare('SELECT * FROM daily_quests WHERE quest_date=?').all(dateStr);
  const has = t => rows.some(r=>r.type===t);
  const ins = db.prepare('INSERT INTO daily_quests(quest_date,type,title,reward,topic) VALUES(?,?,?,?,?)');
  const topic = currentTopic();     // ★ V12 이번 주 주제
  // ★ P0-5 보상 난이도 비례: 아무 노력 없이 누르는 간식은 낮게, 쓰는 일은 높게
  if(!has('feed'))   ins.run(dateStr,'feed','로봇에게 간식 주기',10,null);
  if(!has('praise')) ins.run(dateStr,'praise','로봇 칭찬하기',10,null);
  // ★ 오늘의 AI 미션: 풀이 비어 있으면 LLM 1회로 채움, 실패 시 프리셋 질문으로 보강
  let missions = rows.filter(r=>r.type==='ai_mission');
  // ★ v1.34: 이미 만들어진 «어른 말투» 질문은 폐기하고 새로 만든다.
  //   아이가 이미 답한 질문은 기록 보존을 위해 건드리지 않는다.
  if (missions.length) {
    const answered = new Set(db.prepare('SELECT DISTINCT quest_id FROM quest_logs').all().map(r=>r.quest_id));
    //   · 어른 어휘가 섞였거나
    //   · 주제가 바뀌었는데(예: «신입 사원» → «처음 간 날») 예전 주제로 만들어진 질문
    const bad = missions.filter(m => !answered.has(m.id) &&
      (ADULT_WORDS.test(m.title) || (m.topic && m.topic !== topic.topic)));
    if (bad.length) {
      const del = db.prepare('DELETE FROM daily_quests WHERE id=?');
      bad.forEach(m => del.run(m.id));
      missions = missions.filter(m => !bad.includes(m));
    }
  }
  if(missions.length < MISSION_POOL_SIZE){
    const need = MISSION_POOL_SIZE - missions.length;
    // ★ V12: 이번 주 주제(세계관/수업)를 프롬프트에 넣는다.
    //   "오늘 뭐 했어?" 같은 일반 질문 → "이번 주 배운 것과 연결된" 질문으로 바뀐다.
    const MP = `너는 초등학교 저학년(7~10살) 아이와 이야기하는 다정한 로봇이다. 오늘 아이에게 물어보고 싶은 질문 ${MISSION_POOL_SIZE}개를 만들어라.
이번 주 주제: "${topic.topic}" (도로랜드 CH.${topic.chapter}${topic.keywords ? ', ' + topic.keywords : ''})
[꼭 지킬 것]
- 아이가 실제로 겪어 봤을 일(학교·친구·놀이·가족·동물·날씨)로 물어라.
- 회사·출근·직장·업무·회의·보고서 같은 어른 세계 개념은 절대 쓰지 마라.
- "빗대다", "비유하면", "경험에 빗대면" 같은 어려운 말 대신 쉬운 말로 물어라.
- 한 문장, 25자 안팎. 예) "오늘 학교에서 제일 웃긴 일은 뭐였어?"
한국어 한 문장씩 줄바꿈으로만 구분해 출력하고 설명·번호·따옴표 없이 질문만. 아이에게 안전하고 건전한 질문만.`;
    const mq = await callLLM(MP);
    const txt = (mq && mq.text) || '';
    let qs = txt.split('\n').map(s=>s.trim().replace(/^["'“”]+|["'“”]+$/g,'')).filter(s=>s.length>=8 && s.length<=60);
    qs = qs.filter(q=>!ADULT_WORDS.test(q));     // ★ v1.34 LLM 이 또 어른 말을 쓰면 버리고 프리셋으로 채운다
    qs = [...new Set(qs)];
    const exist = new Set(missions.map(m=>m.title));
    const preset = presetsForTopic(topic).filter(p=>!exist.has(p));
    while(qs.length < need && preset.length) qs.push(preset.shift()); // LLM 실패/부족 시 프리셋 보강
    // ★ LLM await 동안 ensureQuests 가 동시에 재진입하면 같은 질문이 여러 행으로 쌓인다.
    //   INSERT ... SELECT ... WHERE NOT EXISTS 로 (날짜+유형+제목) 중복을 원자적으로 막는다.
    const insMission = db.prepare(`INSERT INTO daily_quests(quest_date,type,title,reward,topic)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(
        SELECT 1 FROM daily_quests WHERE quest_date=? AND type='ai_mission' AND title=?)`);
    for(const q of qs.slice(0, need)) insMission.run(dateStr,'ai_mission', q, 30, topic.topic, dateStr, q);
  }
  return db.prepare('SELECT * FROM daily_quests WHERE quest_date=?').all(dateStr);
}
// 날짜: 서버 로컬타임이 아닌 KST 기준 (배포 환경 무관하게 "하루" 경계 일관)
function today(){ return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date()); }
function dayKST(offset=0){ return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date(Date.now()+offset*86400000)); }
// ★ V12 도로랜드 챕터를 주제로 쓴다 — 새 콘텐츠가 세계관과 이어지게 하는 가장 싼 방법.
//   지정이 없으면 주차에 따라 자동으로 돌아가므로 운영자가 손대지 않아도 매주 질문이 달라진다.
const DEFAULT_TOPICS = [
  // v1.34: «신입 사원 / 첫 출근» 은 아이가 겪어 본 적 없는 어른 세계 → «처음 가 본 날» 로 바꾼다
  { chapter:1, topic:'도로랜드에 처음 간 날', keywords:'첫 방문, 새 친구, 두근두근' },
  { chapter:2, topic:'멈춘 기계의 노래',   keywords:'고장, 원인 찾기, 고치기' },
  { chapter:3, topic:'별빛 저장고',       keywords:'모으기, 나누기, 약속' },
  { chapter:4, topic:'코딩 숲의 지도',     keywords:'순서, 규칙, 길 찾기' },
  { chapter:5, topic:'AI 마을의 질문',     keywords:'질문하기, 배우기, 도와주기' },
];
// 이번 주 월요일(KST) — 주제의 기준이 되는 날짜
// ★ weekStartKST() 는 파일에 두 번 정의돼 함수 선언 호이스팅으로 뒤의 것이 앞의 것을 덮어썼다.
//   중복 정의를 제거하고 «학습 계획 섹션» 의 정의 하나만 남긴다(두 구현은 동일한 값을 낸다).
// 이번 주 주제 — 운영자가 넣은 값이 있으면 그것, 없으면 챕터 자동 순환
function currentTopic(){
  const week = weekStartKST();
  const row = db.prepare('SELECT * FROM weekly_topics WHERE week_start=?').get(week);
  if(row) return { week, chapter:row.chapter, topic:row.topic, keywords:row.keywords||'', source:'operator' };
  const weeks = Math.floor(Date.parse(week + 'T00:00:00Z') / 86400000 / 7);
  const t = DEFAULT_TOPICS[Math.abs(weeks) % DEFAULT_TOPICS.length];
  return { week, chapter:t.chapter, topic:t.topic, keywords:t.keywords, source:'auto' };
}

// ★ v1.39 «자기 생각 × 도로랜드» — 이번 주 챕터에 붙는 «정비사 서사».
//   기업 세계관(DOROLAND · 셀 · 공작소 · CH.2 «멈춘 기계의 노래»)의 «이름과 구조» 만 빌리고,
//   이야기 자체는 이 프로젝트가 새로 쓴다. (5 캐릭터 이미지는 쓰지 않는다 — IP 의존을 피한다)
//   챕터 번호는 DEFAULT_TOPICS / weekly_topics 와 그대로 맞물리므로, 운영자가 주제를 바꾸면 서사도 따라간다.
const STORY_CHAPTERS = {
  1: { badge:'새내기 정비사',
       line:'루미랑 처음 마을에 온 날을 기억해? 모르는 게 잔뜩이어도 괜찮아. 정비사는 먼저 «모르겠다» 를 적는 사람이야.',
       vow:'오늘은 모르는 걸 숨기지 않을래' },
  2: { badge:'고침 정비사',
       line:'멈춘 기계는 버리는 게 아니라 왜 멈췄는지 찾아서 고쳐. 생각도 똑같아. 지우지 말고 고쳐 쓰면 돼.',
       vow:'멈춘 생각도 버리지 않고 열어 볼래' },
  3: { badge:'별빛 정비사',
       line:'고쳐 쓴 생각 하나가 별빛 하나가 되어 저장고에 쌓여. 네가 고친 만큼 마을이 밝아져.',
       vow:'내가 고친 생각을 별빛으로 남길래' },
  4: { badge:'길 찾는 정비사',
       line:'길을 찾으려면 먼저 «여기서 헤맸어» 를 지도에 표시해야 해. 헤맨 자리가 다음 길이 되니까.',
       vow:'헤맨 자리를 지도에 그려 둘래' },
  5: { badge:'질문하는 정비사',
       line:'좋은 질문은 처음엔 엉뚱해도 괜찮아. 고쳐 쓰는 동안 질문이 자라서 진짜 질문이 돼.',
       vow:'다시 물어보는 걸 부끄러워하지 않을래' }
};
// 루미의 성찰 질문 3종 — LLM 에 맡기지 않는다. 아이 생각을 «평가» 하지 않고 «되돌아보게» 만 한다.
const REFLECT_PROMPTS = [
  { key:'where',   q:'어디에서 막혔는지 찾아볼래?',        hint:'문제의 어느 부분이 어려웠는지' },
  { key:'diff',    q:'지금은 뭐가 다르게 보여?',            hint:'처음 생각과 지금 생각의 차이' },
  { key:'explain', q:'친구에게 뭐라고 설명해 줄래?',        hint:'내 말로 다시 설명해 보기' }
];
const THOUGHT_CELL = 6;        // 고쳐 쓴 조각 1개당 별빛 셀
const THOUGHT_DAILY_CAP = 3;   // 하루에 셀을 받을 수 있는 조각 수 (4번째부터는 0셀, 그래도 불은 켜진다)
const THOUGHT_NEW_CAP = 6;     // 하루에 새로 적을 수 있는 조각 수
const VAULT_LIGHTS = 8;        // 별빛 저장고 등의 개수

// 이번 주 챕터 서사 + 아이의 조각 통계 (한 곳에서 계산해 API/UI/3D 가 같은 숫자를 본다)
function thoughtStats(uid){
  const d = today();
  const rows = db.prepare('SELECT status, cell_reward, fixed_at FROM thought_shards WHERE user_id=?').all(uid);
  const fixed = rows.filter(r => r.status === 'fixed').length;
  const todayFixed = rows.filter(r => r.status === 'fixed' && String(r.fixed_at || '').slice(0, 10) === d).length;
  const todayNew = db.prepare('SELECT COUNT(*) AS c FROM thought_shards WHERE user_id=? AND day=?').get(uid, d).c;
  return {
    total: rows.length,
    open: rows.length - fixed,
    fixed,
    starCell: rows.reduce((s, r) => s + (r.cell_reward || 0), 0),
    todayFixed,
    todayNew,
    lit: Math.min(VAULT_LIGHTS, fixed),
    lights: VAULT_LIGHTS,
    cell: THOUGHT_CELL,
    dailyCap: THOUGHT_DAILY_CAP,
    newCap: THOUGHT_NEW_CAP
  };
}

// ★ V11 요일(0=일 … 6=토, KST) — 주말 한정 아이템 판정용
function todayDow(){
  const s = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',weekday:'short'}).format(new Date());
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}
// 상시 판매(limited_days 없음) 또는 오늘이 판매 요일인가
// ★ v1.65 «이번 주 특가» — 매주 월요일(KST)에 2개 상품이 8할로 바뀐다. LLM 없이 주차 해시로 결정.
try{ db.exec(`CREATE TABLE IF NOT EXISTS weekly_sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_key TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  UNIQUE(week_key, item_id)
)`); }catch(e){}
const WEEKLY_OFF = 0.8;
function weekKeyKST(){
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  const dayOfYear = Math.floor((d.getTime() - jan1) / 86400000);
  const week = Math.floor((dayOfYear + new Date(jan1).getUTCDay()) / 7) + 1;
  return `${y}-W${String(week).padStart(2, '0')}`;
}
function ensureWeeklySale(){
  const wk = weekKeyKST();
  let rows = db.prepare('SELECT item_id FROM weekly_sales WHERE week_key=?').all(wk);
  if(!rows.length){
    const pool = db.prepare("SELECT id FROM items WHERE type='skin' AND limited_days IS NULL AND (sale_end IS NULL OR sale_end='') ORDER BY id").all();
    if(!pool.length) return new Set();
    const seed = [...wk].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const picked = [];
    for(let i = 0; picked.length < 2 && i < pool.length * 2; i++){
      const id = pool[(seed + i * 7) % pool.length].id;
      if(!picked.includes(id)) picked.push(id);
    }
    for(const id of picked) db.prepare('INSERT OR IGNORE INTO weekly_sales(week_key,item_id) VALUES(?,?)').run(wk, id);
    rows = db.prepare('SELECT item_id FROM weekly_sales WHERE week_key=?').all(wk);
  }
  return new Set(rows.map(r => r.item_id));
}
function weeklyPriceOf(it){ return Math.max(1, Math.round(it.price * WEEKLY_OFF)); }
function weeklyDaysLeft(){
  const now = Date.now() + 9 * 3600 * 1000;
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;          // 월=0 … 일=6
  const leftMs = (7 - dow) * 86400000 - (now % 86400000);
  return Math.max(1, Math.ceil(leftMs / 86400000));
}

function itemAvailable(it, dow){
  if(!it) return true;
  // ★ v1.64: 판매 종료일(sale_end) 이 지나면 주말이어도 살 수 없다.
  if(it.sale_end){
    const end = new Date(String(it.sale_end).slice(0,10) + 'T23:59:59+09:00').getTime();
    if(Number.isFinite(end) && Date.now() > end) return false;
  }
  if(!it.limited_days) return true;
  return String(it.limited_days).split(',').map(Number).includes(dow);
}
// {list, done} 구조 반환 (done = 해당 유저가 오늘 완료한 quest id)
// AI 미션은 유저별로 1개만 배정: uid 해시로 풀에서 선택, 오늘 이미 답한 미션이 있으면 그것으로 고정
function pickMission(uid, missions){
  return missions.length ? missions[uid % missions.length] : null;
}
async function getQuestsFor(uid){
  const all = await ensureQuests(today());
  const missions = all.filter(q=>q.type==='ai_mission');
  let assigned = null;
  if(missions.length){
    const ids = missions.map(m=>m.id);
    const answered = db.prepare(`SELECT quest_id FROM quest_logs WHERE user_id=? AND quest_id IN (${ids.map(()=>'?').join(',')})`)
      .all(uid, ...ids).map(r=>r.quest_id);
    assigned = missions.find(m=>m.id===answered[0]) || pickMission(uid, missions);
  }
  const list = [...all.filter(q=>q.type!=='ai_mission'), ...(assigned?[assigned]:[])];
  // ★ P1-7 빈 목록 방어: list 가 비면 "IN ()" 가 되어 SQLite 문법 오류(500)가 난다
  if(!list.length) return { list:[], done:[] };
  const done = db.prepare(`SELECT quest_id FROM quest_logs WHERE user_id=? AND quest_id IN (${list.map(()=>'?').join(',')})`)
    .all(uid, ...list.map(q=>q.id)).map(r=>r.quest_id);
  return { list, done };
}

// ---------- 5. 유틸: 셀 지급(거래 내역 기록) ----------
function grantCell(uid, amount, source) {
  db.prepare('UPDATE users SET cell_balance = cell_balance + ? WHERE id=?').run(amount, uid);
  db.prepare('INSERT INTO cell_tx(user_id,amount,source) VALUES(?,?,?)').run(uid, amount, source);
}

// ---------- 5-A. ★ 계정 삭제 공통: 이 사용자의 모든 흔적을 전 표에서 지운다 ----------
//   (계정 삭제 / 데모 시드 초기화 / 운영자 시연계정 정리가 함께 쓴다)
//   guestbook·friendships·cheers·friend_messages·friend_blocks·friend_reports 는
//   user_id 컬럼이 없고(to_user/from_user 등) «관계» 표이므로 양방향으로 지운다.
function wipeUserData(uid){
  const USER_TABLES = [
    'robots','inventory','cell_tx','quest_logs','visits','mailbox','class_logs','workshop_logs',
    'interact_logs','game_logs','sort_progress','chat_messages','chat_analyses','chat_reports',
    'llm_logs','learner_profile','learning_help_logs','learning_plans','weekly_goals','goal_claims',
    'review_cards','village_props','treasure_claims','world_lessons','user_memories','robot_recalls',
    'chat_sessions','world_presence','world_quests','world_stars','world_secrets','thought_shards',
    'campaign_facilities','campaign_events','campaign_journal','nudges','mood_logs','focus_sessions',
    'season_claims',
    'concept_mastery',   // ★ v1.70: 새 학습 테이블도 계정 삭제 때 함께 지운다(누락 방지 규칙)
    'memory_lamps',      // ★ v1.71: 기억 등불도 계정 삭제 때 함께 지운다(누락 방지 규칙)
  ];
  for(const t of USER_TABLES){
    try{ db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(uid); }catch(e){}
  }
  // 관계 표 — user_id 가 없어 양쪽 컬럼을 모두 본다
  try{ db.prepare('DELETE FROM guestbook WHERE to_user=? OR from_user=?').run(uid, uid); }catch(e){}
  try{ db.prepare('DELETE FROM friendships WHERE user_a=? OR user_b=?').run(uid, uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_messages WHERE from_user=? OR to_user=?').run(uid, uid); }catch(e){}
  try{ db.prepare('DELETE FROM cheers WHERE from_user=? OR to_user=?').run(uid, uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_blocks WHERE user_id=? OR blocked_id=?').run(uid, uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_reports WHERE reporter_id=? OR target_id=?').run(uid, uid); }catch(e){}
}

// ---------- 5-B. 인증: 세션 토큰 (uid 대신 토큰으로 본인 확인) ----------
function authUser(req){
  const t = req.get('X-Token') || (req.body && req.body.token);
  if(!t) return null;
  return db.prepare('SELECT * FROM users WHERE token=?').get(String(t)) || null;
}
// ---------- 5-C. ★ P0-4 LLM 출력 안전 필터 ----------
// 프롬프트에 "안전한 표현만" 을 지시해 두지만, LLM 은 이를 보장하지 않는다.
// 실제로 화면에 노출되는 모든 LLM 결과는 이 필터를 통과해야 한다(강제 레이어).
// 주의: 초등 고학년이 '선물' '별' 같은 단어를 쓰기도 하므로 오탐을 줄이도록
//       동사·어절 단위로 좁힌 패턴만 사용한다(예: '죽' 같은 단독 문자 금지).
const UNSAFE_PATTERNS = [
  /성적|지능|바보|멍청|천치|바보같/,            // 금언/모욕
  /(죽어라|죽으면|죽게|자살|목을\s*매|독살|살해|때려라|때리고)/,  // 폭력
  /(성인|음란|포르노|성매매|야동|성tico)/,         // 성적/부적절
  /(주사|마약|환각불상|도박|카지노|도박사이트)/,    // 약물/도박
  /(주민등록번호|비밀번호|계좌번호|전화번호를\s*알려|여기로\s*전화)/, // 개인정보 유인
  /(https?:|www\.|\.com|\.kr|\.net|\.xyz)/i,  // 링크/스팸
];
// ★ 한국어 욕설 차단(아동 서비스) — 자소 분리·특수문자 끼우기 등 «변형» 까지 커버한다.
//   한글에는 단어 경계(\b)가 없어 '새끼' 는 (개\s*)? 접두 결합으로만 잡고,
//   동물 새끼 표현이 걸릴 수 있지만 아이 화면 보호를 우선한다(오탐 시 이 배열에서만 조정).
const UNSAFE_PROFANITY = [
  /(씨\s*[@!1]*\s*발|시\s*1\s*발|ㅅ\s*ㅣ\s*ㅂ\s*ㅏ\s*ㄹ|ㅆ\s*ㅣ\s*발)/,   // 씨발 계열(ㅅㅣㅂㅏㄹ·시1발·씨@발·ㅆㅣ발)
  /(병\s*신|븅\s*신)/,                                                   // 병신/븅신
  /(개\s*)?(새\s*끼|가죽힘)/,                                            // 개새끼/새끼 계열
  /(좆|ㅈ\s*ㅂ\s*[ㅅㅄ]|ㅄ)/,                                             // 좆 · ㅈㅂㅅ/ㅄ
  /(느\s*금\s*마|느\s*금\s*니)/,                                          // 느금마/느금니
];
// maxLen: 호출부가 길이 상한을 늘릴 수 있다(기본 200 — 친구 채팅 등 기존 호출점은 그대로).
// LLM 학습 답변(maxTokens=170) 은 정상적인 한국어만으로도 200자를 넘을 수 있어 채팅 파이프라인은 600 을 쓴다.
function isSafeText(s, maxLen){
  if(!s) return false;
  const t = String(s);
  if(t.length > (maxLen || 200)) return false;      // 과도한 길이(악성 반말 등)
  if(/\d{6,}/.test(t)) return false;                // 긴 숫자(전화/계좌/아이디) 차단
  for(const re of UNSAFE_PATTERNS) if(re.test(t)) return false;
  for(const re of UNSAFE_PROFANITY) if(re.test(t)) return false;
  return true;
}
// LLM 결과 정리 + 안전성 검증(위반 시 null 반환 → 호출부가 프리셋 대사로 폴백)
// safeLen: isSafeText 에 넘길 길이 상한(생략 시 200). 채팅 파이프라인은 600 으로 통일한다.
function sanitizeLine(raw, maxLen, safeLen){
  if(!raw) return null;
  let line = String(raw).trim().replace(/^["'“”]+|["'“”]+$/g,'').split('\n')[0].trim();
  if(!line) return null;
  line = line.slice(0, maxLen||80);
  return isSafeText(line, safeLen) ? line : null;
}

// ---------- 5-E. ★ 부품 보너스(수치적 가치) ----------
// 예전에는 부품이 "외관만" 있고 실제 효과가 없어, 돈을 써도 이득이 없다는 얘기가 들었다.
// 부품 개수만큼 '오늘 과제 보상'이 올라간다(부품 1개당 +2셀, 최대 +10).
// 장식(decor)은 방 분위기만 바꾸므로 보상에 영향을 주지 않는다(역할을 분리한다).
const PART_BONUS_PER = 2, PART_BONUS_MAX = 10;
function partBonus(uid){
  // ★ V9 수정: 행 수(COUNT) → 수량 합계(SUM(qty)).
  //   부품 종류가 3개뿐이라 COUNT 로는 상한이 +6 에서 멈췄고,
  //   교환으로 중복 부품을 늘려도 같은 행의 qty 만 증가해 보너스가 오르지 않았다.
  //   → 광고한 "최대 +10" 이 도달 불가능했다(실측 확인).
  const n = db.prepare(`SELECT COALESCE(SUM(v.qty),0) c FROM inventory v JOIN items i ON i.id=v.item_id
    WHERE v.user_id=? AND i.type='part'`).get(uid).c;
  return Math.min(PART_BONUS_MAX, n * PART_BONUS_PER);
}
// ---------- 5-D. ★ P0-2 성장 시스템 엔진 ----------// 레벨 곡선: Lv.n 에 필요한 누적 EXP = 100 * n (선형, 초등 고학년이 이해하기 쉬움)
const expNeeded = lv => 100 * lv;
// 레벨 → 성장 단계(외형 변화 기준). 1=아기 2=청소년 3=성체
function growthStage(level){
  if(level >= 8) return 3;
  if(level >= 4) return 2;
  return 1;
}
// 경험치 지급 → 레벨업 처리. 반환: {level, exp, leveledUp, stage}
function addExp(uid, amount){
  const u = db.prepare('SELECT level, exp FROM users WHERE id=?').get(uid);
  if(!u) return { level:1, exp:0, leveledUp:false, stage:1 };
  let { level, exp } = u;
  // 기존 DB에는 level 컬럼이 없을 수 있어 exp/level 은 마이그레이션으로 채워진다
  exp = (exp||0) + amount;
  let leveledUp = false;
  while(exp >= expNeeded(level)){ exp -= expNeeded(level); level++; leveledUp = true; }
  db.prepare('UPDATE users SET exp=?, level=? WHERE id=?').run(exp, level, uid);
  return { level, exp, leveledUp, stage: growthStage(level) };
}

// ★ 연속 방문 계산: 오늘 첫 로그인 시 streak 증가, 어제 방문 이력이 없으면 1로 초기화
function touchStreak(uid){
  const t = today();
  const u = db.prepare('SELECT streak, last_visit FROM users WHERE id=?').get(uid);
  if(!u) return 0;
  let streak = u.streak || 0;
  if(u.last_visit === t) return streak;                 // 오늘 이미 반영됨
  const y = new Date(Date.now() - 86400000);
  const yStr = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(y);
  // ★ 2026-10-31: 딱 하루 쉬었으면 20셀로 되살릴 수 있는 제안을 남긴다.
  if(u.last_visit === dayKST(-2) && streak > 0){
    db.prepare('UPDATE users SET revive_streak=?, revive_until=? WHERE id=?').run(streak + 1, t, uid);
  }
  streak = (u.last_visit === yStr) ? (streak + 1) : 1; // 어제 접속 이력 있으면 연속
  db.prepare('UPDATE users SET streak=?, last_visit=? WHERE id=?').run(streak, t, uid);
  return streak;
}

// ★ 연속 방문 보상(중복 지급 방지 위해 last_visit 갱신과 1:1)
// 7일까지만 표가 있으면 8일째에 `8 in STREAK_REWARDS` 가 false 가 되어
// 보상이 0 이 된다(실측 확인). streak 는 계속 증가하므로 화면엔 🔥8 로 보이지만
// 아무것도 안 받는 상태가 되며, 습관이 굳어가는 시점에 보상이 끊긴다.
// → 7일 주기로 순환시키고, 완주 보상(28일)을 따로 준다.
const STREAK_REWARDS = { 1:10, 2:15, 3:25, 4:35, 5:50, 6:60, 7:100 };
const STREAK_CYCLE = 7;      // 보상 표의 길이
const STREAK_MASTER = 200;   // 7일 × 4바퀴(28일) 완주 시 보너스
function grantStreakBonus(uid, streak){
  if(streak <= 0) return 0;
  // 28일 완주 보상
  if(streak % 28 === 0) { grantCell(uid, STREAK_MASTER, 'streak'); return STREAK_MASTER; }
  // 7일 주기 순환: 8일→1일 보상, 9일→2일 보상 …
  const slot = ((streak - 1) % STREAK_CYCLE) + 1;
  const reward = STREAK_REWARDS[slot];
  if(!reward) return 0;
  grantCell(uid, reward, 'streak');
  return reward;
}


// ---------- 6. API ----------
// 로그인(단순화: 닉네임이 곧 계정. 정식 버전은 JWT로 교체, 데모에서는 생략 — 기업 설명회에서 "로그인 과정은 다루지 않기로" 명시)
// ★ v1.75: 대세계가 «빛의 조각» 상한을 맞추려고 GET /api/user 를 부른다(계약: teach_count).
//   POST 만 있던 탓에 마을을 열 때마다 404 가 났고, 조각 수가 항상 «마일스톤 하한» 으로 보였다.
app.get('/api/user', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  let teach = 0;
  try{ teach = db.prepare("SELECT COUNT(*) c FROM user_memories WHERE user_id=? AND kind='taught'").get(u.id).c; }catch(e){}
  res.json({ ok:true, teach_count: teach,
    user: { id:u.id, nickname:u.nickname, cell_balance:u.cell_balance, level:u.level || 1 } });
});

app.post('/api/user', async (req,res)=>{
  let { nickname } = req.body;
  nickname = (nickname||'').trim().slice(0,20);
  if (!nickname) return res.status(400).json({error:'닉네임을 입력하세요'});
  const token = crypto.randomUUID(); // 로그인마다 재발급
  let u = db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
  if (!u) {
    db.prepare('INSERT INTO users(nickname) VALUES(?)').run(nickname);
    u = db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
    grantCell(u.id, 100, 'welcome'); // 신규 보너스
    // ★ V15 우편함 안내: 첫 로그인에 '열어볼 편지'가 있어야 우편함 탭을 눌러본다(수령형 보상)
    sendMail(u.id, { title:'루미에 온 것을 환영해!', cell:50, tag:'welcome',
      body:'가입 선물 50셀이 도착했어요. 우편함에서 받아가세요!' });
  }
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, u.id);
  // ★ P0-3 수정: 이곳에 visits 를 넣지 않는다.
  //   방문 기록은 "마이룸 진입 시 1회"(=/api/visit)가 진짜 접속 1회의 정의다.
  //   예전처럼 로그인할 때마다 넣으면 페이지 새로고침 횟수가 접속 횟수가 되어
  //   재접속률 지표가 왜곡된다.
  // ★ P0-2 연속 방문(스트릭) 갱신 + 보상
  // ★ 수정: 예전엔 `streak in STREAK_REWARDS` 로 판정했는데 STREAK_REWARDS 는 1~7이라
  //   8일째부터 조건이 false 가 되어 보상을 주지 않았다(grantStreakBonus 안에서는
  //   7일 주기 순환으로 해결했지만, 이 호출부 조건이 그대로면 여전히 0 이다).
  //   판정 책임은 grantStreakBonus 하나로 모은다.
  const streakBefore = (u.streak||0);
  const streak = touchStreak(u.id);
  const streakBonus = (streak !== streakBefore) ? grantStreakBonus(u.id, streak) : 0;
  u = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  // ★ P0-4 오버플레이: 오늘 플레이 시간 한도 초과 여부를 함께 알려준다.
  //   날짜가 바뀌었으면 누적은 0 으로 본다(리셋은 playtime 엔드포인트가 실제 반영).
  const isNewDay = u.play_day && u.play_day !== today();
  const played = isNewDay ? 0 : (u.play_minutes || 0);
  // ★ 2026-10-28: 부모 승인 보너스(+20/회, 최대 +40) + 시연 계정은 제한 없음
  // ★ 2026-11-21 (v1.74) C2: 부모가 조절한 하루 한도 오프셋(play_limit_delta)도 판정에 반영한다.
  //   서버 판정(40+보너스+delta)과 화면 계산(40+delta)이 갈라지면 «열렸는데 잠긴» 모순이 생긴다.
  const isDemo = /^(데모|demo)/i.test(u.nickname || '');
  const limit = DAILY_PLAY_LIMIT + (u.play_bonus || 0) + (u.play_limit_delta || 0);
  const overLimit = !isDemo && played >= limit;
  const revive = (u.revive_streak && u.revive_until === today())
    ? { available:true, cost:20, streak:u.revive_streak } : { available:false };
  res.json({ user: u, quests: await getQuestsFor(u.id), streakBonus, revive,
             play: { minutes: played, limit, overLimit, demo: isDemo },
             // ★ 2026-11-21 (v1.74) 계약: /api/user += ob_step · teach_count · play_limit_delta
             ob_step: Number(u.ob_step) || 0,
             teach_count: Number(u.teach_count) || 0,
             play_limit_delta: Number(u.play_limit_delta) || 0 });
});

// ★ 2026-10-31: 하루 쉰 연속 방문을 20셀로 되살리기
app.post('/api/streak/revive', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  if(!u.revive_streak || u.revive_until !== today())
    return res.status(400).json({error:'되살릴 연속 기록이 없어요'});
  if((u.cell_balance||0) < 20)
    return res.status(400).json({error:'셀이 20개 필요해요'});
  const streak = u.revive_streak;
  // ★ last_visit 을 오늘로 함께 갱신한다 — 안 그러면 다음 touchStreak 가 «어제 접속 없음» 으로
  //   보고 되살린 streak 을 1 로 리셋해 버린다(셀은 냈는데 기록이 사라지는 재발).
  db.prepare('UPDATE users SET cell_balance=cell_balance-20, streak=?, last_visit=?, revive_streak=NULL, revive_until=NULL WHERE id=?')
    .run(streak, today(), u.id);
  db.prepare('INSERT INTO cell_tx(user_id,amount,source) VALUES(?,?,?)').run(u.id, -20, 'streak_revive');
  res.json({ ok:true, streak, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ★ P0-3 실제 접속 기록 1회 = 마이룸 진입 시. visits 테이블에 행을 쌓는다.
app.post('/api/visit', (req,res)=>{
  const u = authUser(req);
  if (u) db.prepare('INSERT INTO visits(user_id) VALUES(?)').run(u.id);
  res.json({ok:true});
});

// ★ P0-3 체류시간 기록: 세션이 끝날 때(페이지 이탈) 총 초를 1회 보고
app.post('/api/visit/duration', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  // ★ V7: 상한을 2시간 → 정책 상한(40분)으로. 탭을 열어둔 시간이 그대로 쌓여
  //   "평균 체류 81분 vs 하루 40분 제한" 이라는 모순이 생기던 원인이다.
  const sec = Math.max(0, Math.min(PLAY_CAP_SEC, Number(req.body && req.body.seconds) || 0));
  if (sec < 3) return res.json({ok:true});   // 3초 미만은 실측 오류로 간주
  // ★ 중복 누적 방지: 같은 방문 행에 5초 이내로 두 번 들어오면 두 번째를 버린다.
  //   (클라이언트 가드가 있어도 네트워크 재전송·이중 이벤트로 중복될 수 있다)
  const last = db.prepare('SELECT id,duration,last_beat FROM visits WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  if (!last) return res.json({ok:true});
  if(last.last_beat && (Date.now() - last.last_beat) < 5000){
    return res.json({ok:true, dedup:true});
  }
  db.prepare('UPDATE visits SET duration = duration + ?, last_beat=? WHERE id=?').run(sec, Date.now(), last.id);
  res.json({ok:true});
});

// ★ P0-4 오버플레이 방지: 플레이 시간 누적 + 시간 초과 잠금
//   - 하루 제한(기본 40분)을 넘으면 부모 승인 없이 다시 못 들어간다.
//   - 클라이언트가 조작해도 서버가 play_minutes 를 신뢰하므로 우회가 어렵다.
const DAILY_PLAY_LIMIT = 40;     // 하루 플레이 상한(분)
// ★ V7: 체류시간 지표도 같은 정책 상한을 쓴다(탭 방치로 부풀려지던 문제 방지)
const PLAY_CAP_SEC = DAILY_PLAY_LIMIT * 60;          // 하루 인정 체류 상한(초)
const PLAY_HARD_CAP_MIN = DAILY_PLAY_LIMIT * 6;      // 측정 보존용 안전 상한(분) — 제한 판정과 분리
app.post('/api/visit/playtime', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const sec = Math.max(0, Math.min(600, Number(req.body && req.body.seconds) || 0));
  if (sec < 3) return res.json({ok:true, playMinutes: u.play_minutes || 0});
  // ★ 매일 0으로 리셋(날짜가 바뀌면 초기화) — 누적값/보너스/승인 모두 리셋
  const day = today();
  const isDemo = /^(데모|demo)/i.test(u.nickname || '');
  if(u.play_day !== day){
    db.prepare('UPDATE users SET play_minutes=0, play_bonus=0, parent_ok=0, play_day=? WHERE id=?').run(day, u.id);
    u.play_day = day; u.play_minutes = 0; u.play_bonus = 0; u.parent_ok = 0;
  }
  // ★ V7: 예전엔 DAILY_PLAY_LIMIT 에서 값을 잘라 저장했다. 그래서 41분이든 200분이든
  //   전부 '40' 으로 기록돼 측정값 자체가 죽고 제한 판정만 남았다.
  //   이제는 안전 상한까지만 저장하고, 제한 판정은 비교로 한다(집행 동작은 동일).
  const next = (u.play_minutes || 0) + Math.round(sec/60);
  const stored = Math.min(PLAY_HARD_CAP_MIN, next);
  db.prepare('UPDATE users SET play_minutes=? WHERE id=?').run(stored, u.id);
  // ★ 2026-10-28: 시연 계정은 제한 없음(발표/테스트용). 일반 계정은 40 + 부모 보너스.
  //   ★ 2026-11-21 (v1.74) C2: 부모의 하루 한도 조절(play_limit_delta) 도 서버 판정에 반영.
  if(isDemo) return res.json({ ok:true, playMinutes: stored, limit: 999, over:false, demo:true });
  const limit = DAILY_PLAY_LIMIT + (u.play_bonus || 0) + (u.play_limit_delta || 0);
  res.json({ ok:true, playMinutes: stored, limit, over: stored >= limit });
});

// ★ V4 데모 계정: 신규 계정은 지표가 전부 0이라 발표장에서 '성장'이 보이지 않는다.
//   실제 학생 7일치 데이터(레벨·스트릭·보유 부품·과제·접속)를 만들어 준다.
//   브라우저에서 바로 '데모 계정' 버튼을 눌러 전환할 수 있게 한다.
// ★ v1.72 «데모 바로 체험» — 발표/시연에서 5분 걸리던 «등불 켜기» 를 한 번에.
//   실제 사용자 흐름(학습→설명)을 건너뛰고, 등불 3개를 심는다. 데모 전용.
app.post('/api/demo/lamps', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const seeds = [
    ['분수',  1], ['반복문', 3], ['소수', 5],
  ];
  try{
    for(const [topic, ago] of seeds){
      const lit = dayKST(-ago);
      db.prepare(`INSERT INTO memory_lamps(user_id,topic,lit_day,reinforce,crystal,immune_day,extra_decay)
        VALUES(?,?,?,1,0,NULL,0)
        ON CONFLICT(user_id,topic) DO UPDATE SET lit_day=excluded.lit_day, crystal=0, immune_day=NULL`)
        .run(u.id, topic, lit);
      db.prepare(`INSERT INTO user_memories(user_id,kind,key,value,updated_at)
        VALUES(?,?,?,?,datetime('now','+9 hours'))
        ON CONFLICT(user_id,kind,key) DO UPDATE SET updated_at=datetime('now','+9 hours')`)
        .run(u.id, 'taught', 'taught:'+topic, topic+' 이야기 (데모)');
    }
  }catch(e){ return res.status(500).json({error:'데모 등불을 켜지 못했어요'}); }
  res.json({ ok:true, topics: seeds.map(x=>x[0]) });
});

app.post('/api/demo/seed', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const nickname = '데모_루미';
  let demo = db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
  if(!demo){
    db.prepare('INSERT INTO users(nickname) VALUES(?)').run(nickname);
    demo = db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
  }
  const did = demo.id;
  // 1) 데모 계정의 모든 학습/게임/친구 데이터를 먼저 비운다(멱등).
  // ★ wipeUserData 는 guestbook 처럼 user_id 가 없는 표(to_user/from_user)까지 정확히 지운다 —
  //   예전에는 존재하지 않는 user_id 컬럼으로 DELETE 해 guestbook 행이 남았었다.
  wipeUserData(did);

  const token = crypto.randomUUID();
  // 2) 성장 수치 + 학습 선호
  db.prepare(`UPDATE users SET token=?, cell_balance=320, level=5, exp=210, streak=6, last_visit=?,
    parent_ok=1, play_minutes=22, play_bonus=40, understanding=18 WHERE id=?`)
    .run(token, today(), did);
  db.prepare(`INSERT INTO learner_profile(user_id,understanding,weak_topics,pref_minutes,pref_time,pref_subjects,pref_difficulty)
    VALUES(?,?,?,?,?,?,?)`)
    .run(did, 18, '반복문,리스트', 10, 'afternoon', 'AI,코딩', 'normal');

  // ★ 데모용 AI 기억 6개 (모달/프롬프트/계획에서 바로 보인다)
  const exp14 = new Date(Date.now() + 9*3600*1000 + 14*86400000).toISOString().slice(0,10);
  const demoMems = [
    ['fact','like','공룡이랑 BTS',0.9,null],
    ['preference','explain_style','비유로 설명하면 더 재밌어해',0.85,null],
    ['learning','weak:반복문','반복문은 아직 헷갈려',0.8,null],
    ['learning','understood:변수','변수는 이제 알겠대',0.9,null],
    ['goal','weekly_puzzle','이번 주 퍼즐 2번',0.8,null],
    ['event','next_exam','다음 주에 시험',0.6,exp14]
  ];
  for(const [kind,key,value,conf,exp] of demoMems){
    upsertMemory(did, { kind, key, value, confidence:conf, source:'demo', expires_at:exp });
  }

  // ★ 3일 전에 틀린 문제 복습 카드 1개(오늘 due)
  try{
    const rc = db.prepare("SELECT * FROM knowledge_cards WHERE concept LIKE '%반복%' OR topic LIKE '%반복%' LIMIT 1").get()
      || db.prepare('SELECT * FROM knowledge_cards ORDER BY id LIMIT 1').get();
    if(rc){
      let qz = {}; try{ qz = JSON.parse(rc.quiz || '{}'); }catch(e){}
      db.prepare(`INSERT INTO review_cards(user_id,card_id,topic,question,options_json,answer,wrong_count,due_date,done)
        VALUES(?,?,?,?,?,?,2,?,0)`)
        .run(did, rc.id, rc.topic, qz.q || '틀린 문제', JSON.stringify(qz.options||[]), Number(qz.answer)||0, today());
    }
  }catch(e){ console.warn('[demo/seed] review_cards:', e.message); }

  // ★ 2026-11-03: 지혜의 샘 4문제를 이미 푼 상태 → 마을에 나무 4그루 + 도감 4/16
  try{
    const cards = db.prepare("SELECT id FROM knowledge_cards WHERE quiz IS NOT NULL AND quiz<>'' ORDER BY id LIMIT 6").all();
    const yday = dayKST(-1), yday2 = dayKST(-2);
    const plan = [
      [today(), 0, cards[0]],
      [today(), 1, cards[1]],
      [yday, 0, cards[2]],
      [yday, 1, cards[3]]
    ].filter(x => x[2]);
    plan.forEach(([d, st, c]) => {
      try{
        db.prepare('INSERT OR IGNORE INTO world_lessons(user_id,day,station,card_id,solved) VALUES(?,?,?,?,1)')
          .run(did, d, st, c.id);
      }catch(e){}
    });
    if (plan.length >= 4) {
      try{ db.prepare('INSERT OR IGNORE INTO world_lessons(user_id,day,station,card_id,solved) VALUES(?,?,?,?,1)')
        .run(did, yday2, 0, cards[4] ? cards[4].id : cards[0].id); }catch(e){}
    }
  }catch(e){ console.warn('[demo/seed] world_lessons:', e.message); }

  // ★ 2026-11-04 학습 동행 2.0 데모 데이터 — 6개 기능이 첫 화면에서 바로 보이게
  try{
    const y1 = dayKST(-1), y2 = dayKST(-2);
    // ★ 오늘 기분은 비워 둔다 → 첫 화면에서 «오늘 기분은 어때?» 카드가 떠서
    //   아이가 직접 고르고, 그 결과가 채팅 말투·방 조명에 반영되는 흐름을 시연할 수 있다.
    db.prepare('INSERT OR IGNORE INTO mood_logs(user_id,day,mood) VALUES(?,?,?)').run(did, y1, 'ok');
    db.prepare('INSERT OR IGNORE INTO mood_logs(user_id,day,mood) VALUES(?,?,?)').run(did, y2, 'low');
    const f1 = new Date(Date.now()-3600000).toISOString(), f2 = new Date(Date.now()-90000000).toISOString();
    db.prepare('INSERT INTO focus_sessions(user_id,day,minutes,started_at,finished_at,reward,done) VALUES(?,?,?,?,?,?,1)')
      .run(did, today(), 10, f1, new Date().toISOString(), 8);
    db.prepare('INSERT INTO focus_sessions(user_id,day,minutes,started_at,finished_at,reward,done) VALUES(?,?,?,?,?,?,1)')
      .run(did, y1, 15, f2, f2, 10);
    // 지난주 시즌 보상은 이미 수령 → 이번 주 진행판이 깨끗하게 열린다
    db.prepare('INSERT OR IGNORE INTO season_claims(user_id,week,reward) VALUES(?,?,?)').run(did, weekKeyOffset(1), 30);
    // 이번 주 복습 1장 완료 → 시즌 미션 진행도가 보인다
    const c2 = db.prepare('SELECT * FROM knowledge_cards ORDER BY id DESC LIMIT 1').get();
    if(c2){
      let qz2 = {}; try{ qz2 = JSON.parse(c2.quiz||'{}'); }catch(e){}
      db.prepare('INSERT OR IGNORE INTO review_cards(user_id,card_id,topic,question,options_json,answer,wrong_count,due_date,done) VALUES(?,?,?,?,?,?,1,?,1)')
        .run(did, c2.id, c2.topic, qz2.q||'복습 문제', JSON.stringify(qz2.options||[]), Number(qz2.answer)||0, today());
    }
  }catch(e){ console.warn('[demo/seed] companion:', e.message); }

  // 3) 로봇 + 보유 부품/장식
  const pal = { body:'#5cc9a7', head:'#a8e6d0', antenna:'#ff9f43', arms:'#3d9e80', legs:'#2a7a63' };
  db.prepare("INSERT INTO robots(user_id,name,template,palette,personality,greeting) VALUES(?,?,?,?,?,?)")
    .run(did, '루미', 'doro', JSON.stringify(pal), '반짝이', '안녕! 나 루미야. 같이 놀자!');
  const inv = db.prepare("SELECT id,name,type FROM items WHERE type IN ('part','decor') ORDER BY id");
  for(const it of inv.all().slice(0,3)){
    db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(did, it.id);
  }

  const dayOffset = (n)=>{
    const d = new Date(Date.now() + 9*3600*1000 - n*86400000);
    return d.toISOString().slice(0,10);
  };

  // 4) 최근 7일 접속(리포트 7칸)
  for(let d=6; d>=0; d--){
    const dayStr = dayOffset(d);
    const mins = 8 + ((d*7)%17);
    const visits = 1 + ((d*3)%4);
    for(let v=0; v<visits; v++){
      db.prepare('INSERT INTO visits(user_id,entered_at,duration) VALUES(?,?,?)')
        .run(did, `${dayStr} 1${v}:0${(v*13)%6}:00`, mins*60);
    }
  }

  // 5) 학습 기록: 이번 주 2개 + 지난주 4개 → 책 6권, 주간 목표 2/3
  const learned = [['변수',0],['조건문',1],['반복문',8],['리스트',9],['함수',10],['변수',11]];
  for(const [subject, off] of learned){
    try{
      db.prepare('INSERT INTO learning_help_logs(user_id,day,subject,level,solved,ts) VALUES(?,?,?,?,?,?)')
        .run(did, dayOffset(off), subject, 2, 1, `${dayOffset(off)} 15:00:00`);
    }catch(e){ console.warn('[demo/seed] learning_help_logs:', e.message); }
  }

  // 6) 게임 기록(오늘은 비워 두어 데모에서 직접 플레이 가능)
  const games = [['puzzle',3,30,2],['mole',320,30,3],['shooter',520,50,4],['mole',180,20,5],['shooter',780,80,6]];
  for(const [kind,score,reward,off] of games){
    try{
      db.prepare('INSERT INTO game_logs(user_id,day,kind,score,reward,ts) VALUES(?,?,?,?,?,?)')
        .run(did, dayOffset(off), kind, score, reward, `${dayOffset(off)} 13:00:00`);
    }catch(e){ console.warn('[demo/seed] game_logs:', e.message); }
  }

  // 7) 오늘의 AI 계획: 1단계 완료, 2·3단계 남김
  const topic = currentTopic();
  const plan = { steps:[
    { id:'s1', done:true, type:'concept', title:`이번 주 궁금증: ${topic.topic}`, desc:'이번 주에 궁금한 걸 하나 골라 봐요.', minutes:2, message:`${topic.topic}이 뭐야? 쉽게 알려줘.` },
    { id:'s2', done:false, type:'puzzle', title:'질문 탐정 놀이 3문제', desc:'질문을 맞히는 퍼즐 3문제', minutes:5, message:'' },
    { id:'s3', done:false, type:'review', title:'오늘 배운 것 한 줄', desc:'내 말로 한 줄 정리', minutes:3, message:'오늘 배운 걸 한 줄로 말해 볼까?' }
  ]};
  db.prepare('INSERT OR REPLACE INTO learning_plans(user_id,day,plan_json,source) VALUES(?,?,?,?)')
    .run(did, today(), JSON.stringify(plan), 'ai');

  // 8) 이번 주 목표 3개 (진행률은 로그에서 자동 계산)
  const goals = [
    { type:'concept', title:'궁금한 것 2개 알아보기', target:2, unit:'개' },
    { type:'puzzle', title:'퍼즐 1번 도전하기', target:1, unit:'번' },
    { type:'solve', title:'혼자 힘으로 2개 풀기', target:2, unit:'개' }
  ];
  db.prepare('INSERT OR REPLACE INTO weekly_goals(user_id,week_start,goals_json,source) VALUES(?,?,?,?)')
    .run(did, weekStartKST(), JSON.stringify(goals), 'ai');

  // 9) 데모 친구 2명 + 안 읽은 채팅
  const friendDefs = [
    { nick:'데모_민지', level:4, streak:3, cells:210, palette:{ body:'#f2a65a', head:'#ffd9a8', antenna:'#ff6b9d', arms:'#d98b45', legs:'#b76f33' } },
    { nick:'데모_준호', level:6, streak:8, cells:460, palette:{ body:'#6ea8fe', head:'#b9d4ff', antenna:'#ffd43b', arms:'#4f86d6', legs:'#3b66a8' } }
  ];
  const fids = [];
  for(const f of friendDefs){
    let fu = db.prepare('SELECT * FROM users WHERE nickname=?').get(f.nick);
    if(!fu){
      db.prepare('INSERT INTO users(nickname) VALUES(?)').run(f.nick);
      fu = db.prepare('SELECT * FROM users WHERE nickname=?').get(f.nick);
    }
    db.prepare('UPDATE users SET level=?, streak=?, cell_balance=?, last_visit=? WHERE id=?')
      .run(f.level, f.streak, f.cells, today(), fu.id);
    try{ db.prepare('DELETE FROM robots WHERE user_id=?').run(fu.id); }catch(e){}
    db.prepare("INSERT INTO robots(user_id,name,template,palette,personality,greeting) VALUES(?,?,?,?,?,?)")
      .run(fu.id, '루미', 'doro', JSON.stringify(f.palette), '반짝이', '안녕! 같이 공부하자!');
    try{ db.prepare('DELETE FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)').run(did,fu.id,fu.id,did); }catch(e){}
    db.prepare("INSERT INTO friendships(user_a,user_b,status) VALUES(?,?, 'accepted')").run(did, fu.id);
    fids.push(fu.id);
  }
  try{
    db.prepare('INSERT INTO friend_messages(from_user,to_user,body) VALUES(?,?,?)').run(fids[0], did, '오늘 같이 퍼즐 풀래?');
    db.prepare('INSERT INTO friend_messages(from_user,to_user,body) VALUES(?,?,?)').run(fids[0], did, '나 두더지 300점 넘었어!');
    db.prepare('INSERT INTO friend_messages(from_user,to_user,body) VALUES(?,?,?)').run(fids[1], did, '이번 주 목표 같이 달성하자!');
  }catch(e){ console.warn('[demo/seed] friend_messages:', e.message); }
  // ★ 2026-11-04: 이번 주 '친구 응원 1번'도 채워 시즌 보상 수령까지 시연 가능하게
  try{
    db.prepare('INSERT OR IGNORE INTO cheers(from_user,to_user,day) VALUES(?,?,?)')
      .run(did, fids[0], today());
  }catch(e){ console.warn('[demo/seed] cheers:', e.message); }

  // 10) 우편함: 수령 대기 선물 + 공지 + 친구 응원
  db.prepare('DELETE FROM mailbox WHERE user_id=?').run(did);
  sendMail(did, { title:'이번 주 목표 달성! 80셀', cell:80, tag:'demo-goal',
    body:'퍼즐 2번, 혼자 풀기 3개 — 진짜 해냈어! 80셀 선물이야.' });
  sendMail(did, { title:'이번 주 이야기', cell:0, tag:'demo-notice',
    body:`이번 주는 "${topic.topic}" 이야기예요. 궁금한 게 있으면 루미에게 물어봐!` });
  sendMail(did, { title:'민지가 응원했어요!', cell:0, tag:'friend:cheer:demo',
    body:'민지: 오늘도 화이팅! 같이 퍼즐 풀자.' });

  // 11) 셀 거래 내역
  const tx = [[100,'welcome',6],[50,'robot_create',6],[10,'streak',5],[15,'streak',4],
    [30,'daily_quest',3],[80,'game',2],[60,'game',1],[-120,'shop',1],[35,'daily_quest',0],[30,'daily_quest',0]];
  for(const [amt,src,off] of tx){
    try{
      db.prepare('INSERT INTO cell_tx(user_id,amount,source,ts) VALUES(?,?,?,?)')
        .run(did, amt, src, `${dayOffset(off)} 12:00:00`);
    }catch(e){}
  }

  // 12) 오늘 과제는 1개만 완료 → 나머지는 데모에서 직접 완료 가능
  try{
    db.prepare('INSERT INTO quest_logs(user_id,quest_id,ts,reward) VALUES(?,?,?,?)')
      .run(did, 1, `${today()} 09:10:00`, 30);
  }catch(e){}

  res.json({ ok:true, token, nickname, uid: did,
    summary:'Lv.5 · 320셀 · 계획 1/3 · 목표 3개 · 친구 2명(미읽음 3) · 우편 3통 · 기억 6 · 7일 리포트' });
});

// ★ P0-4 데이터 삭제(데모 환경 개인정보 리셋): 내 계정 관련 행 전부 삭제
// ★ wipeUserData 로 전 표를 한 곳에서 관리한다 — 새 표가 생겨도 이 함수만 고치면 된다.
app.post('/api/user/delete', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const uid = u.id;
  wipeUserData(uid);
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  res.json({ok:true});
});

// ============================================================
// ★ 2026-11-21 (v1.74) E «계정 PIN · 기기 이전»
//   · PIN 은 평문 저장 금지 — SHA-256(hex) 만 보관한다(admin 키와 같은 고정길이 해시 비교 방식)
//   · 비교는 전부 timing-safe(길이·자릿수 차이도 노출하지 않는다 — adminKeyMatches 와 동일 원리)
//   · 무차별 대입은 daily_counters(kind='pin_fail') 로 «하루 5회» 까지
//   · 기기 이전 코드는 «명문은 발급 응답 딱 한 번» + 10분 수명 + 1회 소비(쓰면 hash 비움)
// ============================================================
function sha256Hex(s){
  return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
}
// ★ 고정길이 SHA-256 을 만든 뒤 timingSafeEqual 로 비교 — adminKeyMatches 와 같은 이중 해시 방식
function safeHashEqual(a, b){
  try{
    const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
    const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }catch(e){ return false; }
}
const PIN_FAIL_LIMIT = 5;             // 하루 실패 5회 — verify · claim 공용 상수
const TRANSFER_TTL_MS = 10 * 60 * 1000;  // 기기 이전 코드 수명(10분)

// E1 PIN 만들기/바꾸기(X-Token) — { pin: '1234' }
app.post('/api/account/pin', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const pin = String((req.body && req.body.pin) || '').trim();
  if(!/^\d{4}$/.test(pin)) return res.status(400).json({error:'PIN 은 숫자 4자리예요'});
  db.prepare('UPDATE users SET pin_hash=? WHERE id=?').run(sha256Hex(pin), u.id);
  res.json({ ok:true });
});

// E2 PIN 로그인 — { nickname, pin } → { ok, token } (기존 토큰 로그인 방식 재사용)
app.post('/api/account/pin/verify', (req,res)=>{
  const day = today();
  const b = req.body || {};
  const nickname = String(b.nickname || '').trim().slice(0, 20);
  const pin = String(b.pin || '').trim();
  const u = nickname ? db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname) : null;
  if(!u){
    // 닉네임이 없어도 «어느 쪽이 틀렸는지» 알려주지 않는다(계정 탐색 방지)
    try{ bumpDailyCounter(0, day, 'pin_fail'); }catch(e){}
    return res.status(400).json({error:'닉네임이나 PIN 을 다시 확인해 줘'});
  }
  if(dailyCounterOf(u.id, day, 'pin_fail') >= PIN_FAIL_LIMIT || dailyCounterOf(0, day, 'pin_fail') >= PIN_FAIL_LIMIT)
    return res.status(429).json({error:'오늘은 시도가 너무 많아요. 내일 다시 해 볼래요?'});
  if(!u.pin_hash) return res.status(400).json({error:'PIN을 먼저 만들어 줘'});
  if(!safeHashEqual(pin, u.pin_hash)){
    try{ bumpDailyCounter(u.id, day, 'pin_fail'); }catch(e){}
    return res.status(400).json({error:'PIN 이 틀렸어요. 다시 해 볼래?'});
  }
  // 성공 — 실패 카운트를 비우고(부모 인증과 같은 규칙) 기존 로그인 방식의 세션 토큰을 발급한다
  try{ db.prepare("DELETE FROM daily_counters WHERE user_id=? AND day=? AND kind='pin_fail'").run(u.id, day); }catch(e){}
  const token = crypto.randomUUID();
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, u.id);
  res.json({ ok:true, token, nickname: u.nickname });
});

// E3 기기 이전 코드 발급(X-Token) — 6자리 숫자, 10분 수명, 명문은 이 응답이 유일하다
app.post('/api/account/transfer/code', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET transfer_hash=?, transfer_exp=? WHERE id=?')
    .run(sha256Hex(code), new Date(Date.now() + TRANSFER_TTL_MS).toISOString(), u.id);
  res.json({ ok:true, code });
});

// E4 기기 이전 받기 — { code } → { ok, token, nickname } (1회 소비)
app.post('/api/account/transfer/claim', (req,res)=>{
  const day = today();
  // 코드로 유저를 먼저 찾는 구조라 실패 카운터는 «전역 버킷(user_id=0)» 으로 산다(하루 5회).
  if(dailyCounterOf(0, day, 'pin_fail') >= PIN_FAIL_LIMIT)
    return res.status(429).json({error:'오늘은 시도가 너무 많아요. 내일 다시 해 볼래요?'});
  const code = String((req.body && req.body.code) || '').trim();
  let hit = null;
  try{
    const rows = db.prepare("SELECT * FROM users WHERE transfer_hash IS NOT NULL AND transfer_hash<>''").all();
    const now = Date.now();
    for(const r of rows){
      const exp = Date.parse(r.transfer_exp || '') || 0;
      if(exp < now) continue;
      if(safeHashEqual(code, r.transfer_hash)){ hit = r; break; }
    }
  }catch(e){}
  if(!hit){
    try{ bumpDailyCounter(0, day, 'pin_fail'); }catch(e){}
    return res.status(400).json({error:'코드가 틀렸거나 만료됐어요'});
  }
  // 1회 소비 — hash/exp 를 비워 «같은 코드 두 번» 이 불가능하게 한다
  db.prepare('UPDATE users SET transfer_hash=NULL, transfer_exp=NULL WHERE id=?').run(hit.id);
  const token = crypto.randomUUID();
  db.prepare('UPDATE users SET token=? WHERE id=?').run(token, hit.id);
  res.json({ ok:true, token, nickname: hit.nickname });
});

// ★ P0-4 부모 승인 게이트: 간단한 곱셈 문제로 확인(자녀 보호 화면)
// 정답은 서버만 보관하고, 클라이언트는 문제만 받는다.
// ★ 보안 수정(V2-6): 예전 token 은 base64("7x8") 이라 브라우저 개발자도 보면 답이 그대로 보였다.
//   지금은 HMAC 서명을 쓴다 → 서버 비밀 키 없이는 답을 만들 수 없다.
const PARENT_SECRET = crypto.randomBytes(24).toString('hex');
function quizSign(a, b){
  return crypto.createHmac('sha256', PARENT_SECRET).update(`${a}x${b}`).digest('hex');
}
app.get('/api/parent/quiz', (_req,res)=>{
  const a = 2 + Math.floor(Math.random()*8);      // 2~9
  const b = 2 + Math.floor(Math.random()*8);      // 2~9
  res.json({ a, b, token: quizSign(a, b) });     // token 에 정답이 담기지 않는다
});
app.post('/api/parent/verify', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  // ★ 무차별 대입 방지: 오늘 실패 5회 이상이면 하루 동안 잠근다(daily_counters 사용)
  const day = today();
  if(dailyCounterOf(u.id, day, 'parent_verify_fail') >= 5)
    return res.status(429).json({error:'오늘은 시도가 너무 많아요. 내일 다시 해 볼래요?'});
  const { a, b, token, answer } = req.body || {};
  const na = Number(a), nb = Number(b);
  const fail = ()=>{ try{ bumpDailyCounter(u.id, day, 'parent_verify_fail'); }catch(e){} };
  if(!Number.isInteger(na) || !Number.isInteger(nb)){ fail(); return res.status(400).json({error:'문제가 올바르지 않아요'}); }
  // 서명 검증 — 토큰 조작으로 통과 불가
  const expected = quizSign(na, nb);
  if(String(token||'') !== expected){ fail(); return res.status(400).json({error:'문제가 올바르지 않아요'}); }
  if(Number(answer) !== na*nb){ fail(); return res.status(400).json({error:'정답이 아니에요. 다시 풀어볼래요?'}); }
  // 성공 — 실패 카운트를 초기화한다
  try{ db.prepare("DELETE FROM daily_counters WHERE user_id=? AND day=? AND kind='parent_verify_fail'").run(u.id, day); }catch(e){}
  const row = db.prepare('SELECT play_bonus FROM users WHERE id=?').get(u.id);
  const nextBonus = Math.min(40, (row && row.play_bonus ? row.play_bonus : 0) + 20);
  db.prepare('UPDATE users SET parent_ok=1, play_bonus=? WHERE id=?').run(nextBonus, u.id);
  res.json({ ok:true, playBonus: nextBonus, limit: DAILY_PLAY_LIMIT + nextBonus });
});
// 부모 승인 상태 조회 (클라이언트가 진입 조건 판단에 사용)
app.get('/api/parent/status', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const row = db.prepare('SELECT parent_ok, play_minutes, play_bonus, play_limit_delta FROM users WHERE id=?').get(u.id);
  res.json({ parentOk: !!(row && row.parent_ok), playMinutes: (row && row.play_minutes) || 0,
             playBonus: (row && row.play_bonus) || 0,
             // ★ 2026-11-21 (v1.74) C2: 한도 판정에 부모 조절 오프셋 반영
             limit: DAILY_PLAY_LIMIT + ((row && row.play_bonus) || 0) + ((row && row.play_limit_delta) || 0) });
});
// 보호자/교사용 1페이지 대시보드 (2026-10-28)
app.get('/api/parent/dashboard', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const p = profileFor(u.id);
  const solved = db.prepare('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1').get(u.id).c;
  const chats = db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE user_id=?').get(u.id).c;
  const games = db.prepare('SELECT kind, COUNT(*) c, MAX(score) best FROM game_logs WHERE user_id=? GROUP BY kind').all(u.id);
  const rows = db.prepare(`SELECT substr(entered_at,1,10) d, COUNT(*) c FROM visits
    WHERE user_id=? AND entered_at >= datetime('now','+9 hours','-6 days') GROUP BY d ORDER BY d`).all(u.id);
  const wk = weekStartKST();
  const studyDays = db.prepare('SELECT COUNT(DISTINCT day) c FROM learning_help_logs WHERE user_id=? AND solved=1 AND day>=?').get(u.id, wk).c;
  const weekSolved = db.prepare('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1 AND day>=?').get(u.id, wk).c;
  const weekChats = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND role='user' AND substr(ts,1,10)>=?").get(u.id, wk).c;
  const weekGames = db.prepare('SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND day>=?').get(u.id, wk).c;
  const weekMemories = db.prepare('SELECT COUNT(*) c FROM user_memories WHERE user_id=?').get(u.id).c;
  const weakFirst = (p.weak_topics||'').split(',')[0] || '';
  // ★ 2026-11-20 / v1.70 ⑦ 오답 패턴(errorPatterns) — 최근 14일 «막힌 개념» top 2.
  //   tip 은 해당 개념 knowledge_cards 의 hint_l2 만 사용(절대 hint_l3/정답을 노출하지 않는다).
  //   trend 는 이번 주 vs 지난주 stuck 횟수 비교('up'|'same'|'down').
  const wkStart = weekStartKST();
  const wkPrev = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'})
    .format(new Date(Date.parse(wkStart + 'T00:00:00+09:00') - 7 * 86400000));
  const TEACH_NO_CARD_TIP = '정답 대신 «어디부터 다를까?» 라고 물어봐 주세요';
  const errorPatterns = db.prepare(`SELECT topic, COUNT(*) c, MAX(day) lastDay
      FROM chat_analyses
      WHERE user_id=? AND day>=? AND stuck=1
        AND COALESCE(topic,'')<>'' AND topic<>'일상'
      GROUP BY topic ORDER BY c DESC LIMIT 2`).all(u.id, dayKST(-13))
    .map(r=>{
      const card = db.prepare('SELECT hint_l2 FROM knowledge_cards WHERE topic=?').get(r.topic);
      const thisWeek = db.prepare(`SELECT COUNT(*) c FROM chat_analyses
        WHERE user_id=? AND topic=? AND stuck=1 AND day>=?`).get(u.id, r.topic, wkStart).c;
      const lastWeek = db.prepare(`SELECT COUNT(*) c FROM chat_analyses
        WHERE user_id=? AND topic=? AND stuck=1 AND day>=? AND day<?`).get(u.id, r.topic, wkPrev, wkStart).c;
      return {
        topic: r.topic,
        count: r.c,
        lastDay: r.lastDay || null,
        tip: (card && card.hint_l2) ? String(card.hint_l2) : TEACH_NO_CARD_TIP,
        trend: thisWeek > lastWeek ? 'up' : (thisWeek < lastWeek ? 'down' : 'same'),
      };
    });
  res.json({
    nickname: u.nickname, level: u.level||1,
    understanding: p.understanding||0, solved, chats,
    playMinutes: u.play_minutes||0,
    limit: DAILY_PLAY_LIMIT + (u.play_bonus||0) + (u.play_limit_delta||0),
    playBonus: u.play_bonus||0,
    friendChatEnabled: !!(p.friend_chat_enabled === undefined ? 1 : p.friend_chat_enabled),
    weekly: { studyDays, solved:weekSolved, chats:weekChats, games:weekGames, memories:weekMemories,
      suggestion: weakFirst ? `${weakFirst} 1문제 다시 풀기` : '새 주제 1개 읽기' },
    // ★ v1.50: 통계 대신 «오늘 아이와 나눌 말» 3문장. 학부모가 실제로 쓰는 건 이쪽이다.
    conversationStarters: parentStarters(u.id),
    // ★ v1.70 ⑦: «아이가 자주 막히는 개념 + 어떻게 도와줄지» top 2
    errorPatterns,
    games, last7: rows,
    // ★ 2026-11-21 (v1.74) C1/C2/F: 부모 두 가지 행동 + 편지 동의 상태를 대시보드로 돌려준다.
    //   playLimit       = 40분 기준 + 부모 조절 오프셋(계약 필드)
    //   cheerSentToday  = 오늘 가족 응원(tag='parent_cheer:<오늘>') 을 이미 보냈는지(하루 1통)
    //   parentEmail     = 마스킹된 편지 수신 이메일(개인정보 최소화)
    playLimit: DAILY_PLAY_LIMIT + (Number(u.play_limit_delta) || 0),
    cheerSentToday: !!db.prepare("SELECT 1 FROM mailbox WHERE user_id=? AND tag=? LIMIT 1")
      .get(u.id, 'parent_cheer:' + today()),
    parentEmail: maskEmail(u.parent_email),
    optin: Number(u.parent_optin) ? 1 : 0,
  });
});
// 보호자: 친구 채팅 허용/차단 (2026-10-30)
app.post('/api/parent/friend-chat', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const enabled = (req.body && req.body.enabled) ? 1 : 0;
  profileFor(u.id);
  db.prepare('UPDATE learner_profile SET friend_chat_enabled=? WHERE user_id=?').run(enabled, u.id);
  res.json({ ok:true, enabled: !!enabled });
});
// 사용자가 자신의 계정을 초기화할 때 부모 승인도 함께 해제
app.post('/api/parent/reset', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  db.prepare('UPDATE users SET parent_ok=0 WHERE id=?').run(u.id);
  res.json({ok:true});
});

// ============================================================
// ★ 2026-11-21 (v1.74) C1 «가족의 한 마디» — 보호자가 아이 우편함에 응원 편지를 넣는다.
//   · 인증은 기존 parent 엔드포인트와 같은 X-Token(아이 계정 토큰) 방식
//   · tag='parent_cheer:<오늘>' — mailbox UNIQUE(user_id,tag) 가 «하루 1통» 을 자연 차단한다
//   · 읽음 판정(/api/mailbox unread)에 parent_cheer 태그를 추가해 미확인 배지가 잡힌다
// ============================================================
app.post('/api/parent/cheer', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const text = String((req.body && req.body.text) || '').trim();
  if(!text) return res.status(400).json({error:'한 마디를 적어 볼래요?'});
  if(!isSafeText(text, 80)) return res.status(400).json({error:'아이에게 보내기 어려운 내용이에요'});
  const day = today();
  const tag = 'parent_cheer:' + day;
  // sendMail 은 태그 중복(=오늘 이미 보냄)이면 false 를 돌려준다 — 별도 카운터가 필요 없다.
  if(!sendMail(u.id, { title:'💌 가족의 한 마디', body:text, cell:0, tag }))
    return res.status(429).json({error:'오늘은 이미 응원했어요. 내일 또 보내 볼래요?'});
  res.json({ ok:true, tag });
});

// ★ 2026-11-21 (v1.74) C2 «플레이 시간 조절» — 부모가 하루 한도를 상대적으로 올리거나 내린다.
//   delta 는 -10/0/10 중 하나. 총 오프셋은 -10~+20 으로 clamp(40분 기준 → 최종 30~60분).
//   서버 판정(visit/playtime · user · status)도 이 오프셋을 함께 본다(화면과 판정 분열 방지).
app.post('/api/parent/playtime', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const delta = Number((req.body && req.body.delta));
  if(delta !== -10 && delta !== 0 && delta !== 10)
    return res.status(400).json({error:'delta 는 -10, 0, 10 중 하나예요'});
  const row = db.prepare('SELECT play_limit_delta FROM users WHERE id=?').get(u.id);
  const next = Math.min(20, Math.max(-10, (Number(row && row.play_limit_delta) || 0) + delta));
  db.prepare('UPDATE users SET play_limit_delta=? WHERE id=?').run(next, u.id);
  res.json({ ok:true, playLimit: DAILY_PLAY_LIMIT + next, playLimitDelta: next });
});

// ★ 2026-11-21 (v1.74) F opt-in — «루미의 편지» 수신 동의(이메일 저장 + 동의 플래그).
//   이메일은 마스킹해서만 대시보드로 내려간다. 동의 해제(optin=0) 해도 저장 이메일은 유지한다.
app.post('/api/parent/optin', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const email = String(b.email || '').trim().slice(0, 120);
  const optin = Number(b.optin) ? 1 : 0;
  if(optin){
    if(!email) return res.status(400).json({error:'편지를 받을 이메일을 적어 볼래요?'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({error:'이메일 모양을 다시 확인해 볼래요?'});
  }
  const keepEmail = email || u.parent_email || null;
  db.prepare('UPDATE users SET parent_email=?, parent_optin=? WHERE id=?').run(keepEmail, optin, u.id);
  res.json({ ok:true, optin, parentEmail: maskEmail(keepEmail) });
});

// ★ P0-2 성장 상태 조회(프론트 상단바/리포트 표시용)
app.get('/api/growth/me', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const level = u.level || 1, exp = u.exp || 0;
  const streak = u.streak || 0;
  // ★ V9: 스트릭 보상표를 클라이언트로 내려준다.
  //   예전엔 표가 서버에만 있어서 아이는 '받고 나서야' 얼마인지 알 수 있었다.
  //   스트릭이 재방문을 만드는 원리는 '예고된 보상'이다 — 표를 보여줘야 작동한다.
  const doneSlot = streak > 0 ? (((streak - 1) % STREAK_CYCLE) + STREAK_CYCLE) % STREAK_CYCLE + 1 : 0;
  const nextSlot = (streak % STREAK_CYCLE) + 1;
  res.json({
    level, exp, expNeeded: expNeeded(level),
    stage: growthStage(level),
    streak,
    // ★ 부품 보너스(부품 1개당 +2셀, 최대 +10) — 상단바에 표시해 구매 동기를 만든다
    partBonus: partBonus(u.id),
    stageLabel: { 1:'아기', 2:'청소년', 3:'성체' }[growthStage(level)],
    streakTable: STREAK_REWARDS,      // { 1:10, 2:15, …, 7:100 }
    streakCycle: STREAK_CYCLE,
    streakDoneSlot: doneSlot,         // 오늘까지 채운 칸 수(0~7)
    streakNextSlot: nextSlot,         // 내일 받을 칸
    streakNextReward: STREAK_REWARDS[nextSlot] || 0,
    streakMaster: STREAK_MASTER,
    // ★ V12 이번 주 주제 — 아이 화면에 표시해 "수업과 연결된 질문"임을 알게 한다
    topic: currentTopic()
  });
});

// 로봇 완성(색칠+이름) → 성격 생성 + 보상 지급 (유저당 1회 — 재생성 반복으로 셀 파밀 방지)
const TEMPLATES = ['doro','roundy','boxy','tally'];
app.post('/api/robots', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const { name, template, palette } = req.body || {};
  if (!TEMPLATES.includes(template)) return res.status(400).json({error:'알 수 없는 로봇 형태예요'});
  if (!palette || typeof palette!=='object' || Array.isArray(palette)) return res.status(400).json({error:'색칠 정보가 이상해요'});
  const cleanPal = {};
  for(const [k,v] of Object.entries(palette)) if(typeof v==='string' && /^#[0-9a-fA-F]{6}$/.test(v)) cleanPal[k]=v;
  const cleanName = String(name||'').trim().slice(0,20);
  if (!cleanName || !Object.keys(cleanPal).length) return res.status(400).json({error:'이름과 색칠이 필요해요'});
  if (db.prepare('SELECT id FROM robots WHERE user_id=?').get(u.id))
    return res.status(409).json({error:'이미 로봇이 있어요'});
  const { personality, greeting, desc } = await generatePersonality(cleanPal);
  // ★ desc 도 함께 저장 — /api/robots/me 가 다시 내려줄 수 있게 한다
  const r = db.prepare('INSERT INTO robots(user_id,name,template,palette,personality,greeting,"desc") VALUES(?,?,?,?,?,?,?)')
    .run(u.id, cleanName, template, JSON.stringify(cleanPal), personality, greeting, desc || null);
  grantCell(u.id, 50, 'robot_create');
  // ★ P0-2 로봇 완성 경험치(첫 상승이 눈에 보이도록 30 XP)
  const growth = addExp(u.id, 30);
  // 보상 부품: 랜덤 지급
  const item = db.prepare('SELECT * FROM items WHERE type=? ORDER BY RANDOM() LIMIT 1').get('part');
  db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, item.id);
  // ★ P1-2 잔액은 서버가 진짜 값을 돌려준다(프론트가 +50 하드코딩하던 문제 제거)
  const balance = db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance;
  res.json({ robotId:r.lastInsertRowid, personality, greeting, desc, growth, balance,
             reward:{cell:50, part:item.name} });
});

// 내 로봇 (+ 오늘 퀘스트 상태 + 보유 부품) — 토큰으로 본인만 조회
// ★ v1.63 «네가 가르쳐 준 거, 아직 기억해» — LLM 없이 규칙으로 «되묻기».
//   아이가 설명(teach-back)한 개념을 7일 안에서 골라, 하루 한 번만 질문한다.
app.get('/api/robot/recall', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const asked = db.prepare('SELECT 1 FROM robot_recalls WHERE user_id=? AND day=?').get(u.id, day);
  if(asked) return res.json({ ok:true, ask:false });
  const mem = db.prepare(`SELECT key, value, updated_at FROM user_memories
    WHERE user_id=? AND kind='taught' AND updated_at >= datetime('now','+9 hours','-7 days')
    ORDER BY updated_at DESC LIMIT 1`).get(u.id);
  if(!mem) return res.json({ ok:true, ask:false });
  const concept = String(mem.key || '').replace(/^taught:/, '').replace(/_/g, ' ').slice(0, 40);
  const t = new Date(String(mem.updated_at || '').replace(' ', 'T') + '+09:00').getTime();
  const days = Number.isFinite(t) ? Math.max(1, Math.round((Date.now() - t) / 86400000)) : 1;
  let line;
  if(days <= 1) line = `어제 네가 가르쳐 준 «${concept}», 나 아직 기억해. 한 번 더 설명해 줄래?`;
  else if(days <= 3) line = `«${concept}» 말이야, 그때 네가 알려 줬잖아. 지금도 설명할 수 있어?`;
  else line = `오랜만에 «${concept}» 이야기 해 볼까? 네가 가르쳐 준 거 기억나?`;
  try{ db.prepare('INSERT OR IGNORE INTO robot_recalls(user_id,day,concept) VALUES(?,?,?)').run(u.id, day, concept); }catch(e){}
  res.json({ ok:true, ask:true, concept, line, days });
});

// ★ v1.70 ⑤ 성장 서사 — «7일 이상 전에 막혔던 개념» 이 지금은 «마스터리 0.7 이상» 이거나
//   «근 3일 안에 스스로 해결» 했다면, 그 성장을 루미가 먼저 말해 준다(LLM 없음, 비용 0).
//   하루 최대 1회 — daily_counters(kind='robot_growth') 로 하루 1회만 이 분기를 태운다.
function growthNarrativeTopic(uid){
  try{
    const rows = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(topic,''), subject) AS t
      FROM chat_analyses
      WHERE user_id=? AND stuck=1 AND day<=?
        AND COALESCE(NULLIF(topic,''), subject)<>'' AND COALESCE(NULLIF(topic,''), subject)<>'일상'
      LIMIT 12`).all(uid, dayKST(-7));
    for(const r of rows){
      const t = String(r.t || '').trim();
      if(!t) continue;
      if(masteryOf(uid, t) >= 0.7) return t;
      const solvedRecently = db.prepare(`SELECT 1 FROM learning_help_logs
        WHERE user_id=? AND solved=1 AND subject=? AND day>=? LIMIT 1`).get(uid, t, dayKST(-2));
      if(solvedRecently) return t;
    }
  }catch(e){}
  return null;
}

// ★ v1.58 «같이 공부하는 로봇» — 아이가 들어오면 «기억하는 것» 으로 먼저 말을 건다.
//   기능 안내(nudge)가 아니라 «너를 기억한다» 는 신호가 목적. LLM 없이 규칙으로 만든다(비용 0).
app.get('/api/robot/hello', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const mood = moodTrend(u.id);
  const stuck = stuckTopics(u.id, 7, 1)[0];
  const kstHour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',hour12:false}).format(new Date()));
  const streak = Number(u.streak) || 1;
  const day = today();
  // ★ v1.71 «루미는 잊어버려» — 기분이 가라앉은 날 «다음», 성장 서사 «전에» 안개 분기가 온다.
  //   decay≥50 인 가장 무거운 등불을 하루 1번만 되묻는다(robot_fog 카운터).
  //   SOS 우편(fog_sos)과 «한 날 한 채널» — 우편이 이미 나갔거나(kind='fog:'+day) 이 분기가
  //   먼저 나갔다면 fog_sos 를 같이 세워 우편이 중복으로 나가지 않게 한다.
  const fogLamp = (mood.today !== 'low' && mood.lowCount < 2
    && dailyCounterOf(u.id, day, 'robot_fog') === 0
    && dailyCounterOf(u.id, day, 'fog_sos') === 0)
    ? fogHeaviestReadonly(u.id, 50) : null;
  // ★ v1.70 ⑤: 성장 서사는 «기분이 가라앉은 날» 다음, «막힌 개념 되묻기» 보다 먼저 온다.
  //   (v1.71: 그 사이에 «기억 안개» 분기가 들어갔다)
  const growthTopic = (mood.today !== 'low' && mood.lowCount < 2
    && dailyCounterOf(u.id, day, 'robot_growth') === 0)
    ? growthNarrativeTopic(u.id) : null;
  let line, kind;
  if(mood.today === 'low' || mood.lowCount >= 2){
    line = '오늘은 조금 조용히 있을게. 말하고 싶으면 불러 줘.';
    kind = 'mood';
  } else if(fogLamp){
    line = `«${fogLamp.topic}» …가물가물해. 다시 가르쳐 줄래?`;
    kind = 'fog';
    // ★ 2026-11-21 (v1.74) B1: 말로 처음 «안개» 를 겪어도 삼막 2막(ob_step→2)을 세운다.
    try{ bumpDailyCounter(u.id, day, 'robot_fog'); bumpDailyCounter(u.id, day, 'fog_sos'); obAdvanceFog(u.id, day); }catch(e){}
  } else if(growthTopic){
    line = `«${growthTopic}»는 예전에 헷갈렸는데, 이제는 혼자 풀 수 있어졌네! 루미가 제일 뿌듯해.`;
    kind = 'growth';
    try{ bumpDailyCounter(u.id, today(), 'robot_growth'); }catch(e){}
  } else if(stuck){
    line = `어제 «${stuck.subject}»에서 막혔었지. 오늘은 같이 천천히 해 보자.`;
    kind = 'stuck';
  } else if(streak >= 2){
    line = `오늘로 ${streak}일째구나. 나 조금 기다렸어.`;
    kind = 'streak';
  } else if(kstHour >= 22 || kstHour < 6){
    line = '이 시간까지 깨어 있었구나. 오늘은 짧게 하자.';
    kind = 'late';
  } else if(kstHour < 10){
    line = '좋은 아침! 오늘은 뭐부터 해 볼까?';
    kind = 'morning';
  } else {
    line = '어서 와. 오늘은 뭐부터 해 볼까?';
    kind = 'default';
  }
  // ★ 2026-11-21 (v1.74) C3 «hello 전달» — 미읽은 가족 응원 편지 1통을 한 줄로 전달한다.
  //   읽음 처리는 하지 않는다(전달과 수령 분리 — 아이가 우편함에서 직접 열어 받게).
  let parentCheer = null;
  try{
    const cm = db.prepare(`SELECT body FROM mailbox WHERE user_id=? AND claimed=0
      AND tag LIKE 'parent_cheer%' ORDER BY id DESC LIMIT 1`).get(u.id);
    if(cm && cm.body) parentCheer = String(cm.body).slice(0, 80);
  }catch(e){}
  res.json({ ok:true, line, kind, mood: mood.today || null, stuck: stuck ? stuck.subject : null,
    growth: growthTopic || null,    // ★ v1.70 ⑤: 이번에 «성장 서사» 를 말했는지(디버그/표시용)
    fog: (kind === 'fog' && fogLamp) ? fogLamp.topic : null,   // ★ v1.71: 이번에 «기억 안개» 를 말했는지
    ...(parentCheer ? { parentCheer } : {}) });   // ★ v1.74 계약: /api/robot/hello += parentCheer(선택)
});

app.get('/api/robots/me', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  let palette = {};
  if (robot){ try{ palette = JSON.parse(robot.palette) || {}; }catch{} }
  // ★ P0-1 수정: decor(방 장식)도 함께 돌려준다.
  //   예전에는 type='part' 만 골라내서, 상점에서 산 장식품이 어디에도 반영되지 않았다
  //   (= 돈을 냈는데 보이지 않는 유료 함정). 이제 parts/decors 로 나누어 함께 전달한다.
  //   skin/shard 는 'part' 도 'decor' 도 아니므로 별도 배열(skins/shards)로 준다.
  // ★ V3 수정: qty>0 인 행만 가져온다. 교환으로 수량이 0 이 된 행이 남아 있으면
  //   아래 `(o.qty||1)` 에서 0 이 1 로 바뀐 버그가 발생해 "조각 1/3" 처럼 보인다
  //   (실제 0 개인데 1 로 표시 → 아이가 2 개를 더 사도 교환이 안 된다).
  const owned = db.prepare(`SELECT i.name, i.type, v.qty FROM inventory v
    JOIN items i ON i.id=v.item_id WHERE v.user_id=? AND v.qty>0`).all(u.id);
  const parts  = owned.filter(o=>o.type==='part').map(o=>o.name);
  const decors = owned.filter(o=>o.type==='decor').map(o=>o.name);
  const skins  = owned.filter(o=>o.type==='skin').map(o=>o.name);
  // ★ 조각은 개수가 곧 교환 진행도다. 이름만 돌려주면 소비자가 알 수 없다.
  const shards = owned.filter(o=>o.type==='shard').map(o=>o.name);
  // qty>0 로 걸러냈으므로 ||1 이 필요 없다(0 은 애초에 안 들어온다)
  const shardQty = owned.filter(o=>o.type==='shard').reduce((a,o)=>a+o.qty, 0);
  res.json({ robot: robot ? {...robot, palette} : null,
             parts, decors, skins, shards,
             qty: Object.fromEntries(owned.map(o=>[o.name, o.qty])),
             // ★ V4: shardProgress.need 는 '가장 싼 부품 기준' 필요 조각 수다.
  //   부품마다 필요한 조각 수가 다르므로(가격 비례), 가장 싼 값으로 표시해야
  //   아이가 "몇 개 모으면 교환할 수 있나" 를 한 번에 판단할 수 있다.
  //   상수는 아래에서 선언되므로 호출 시점(요청 처리 중)에만 쓰인다 → 안전하다.
  shardProgress: { have: shardQty, need: shardNeedMin() },
             quests: await getQuestsFor(u.id) });
});

// 상황 대사(feed/praise) — LLM 우선, 실패 시 대사 라이브러리 사용
// ★ P1-1 일일 인터랙션 횟수 제한(유저당 situation 별 5회): LLM 예산 보호 + 무한 클릭 방지
const INTERACT_DAILY_LIMIT = 5;
app.post('/api/interact', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  if (!robot) return res.status(400).json({error:'먼저 로봇을 만들어주세요'});
  // situation 화이트리스트 (임의 문자열을 프롬프트/DB 조회에 그대로 쓰지 않도록)
  const raw = req.body && req.body.situation;
  const situation = ['feed','praise'].includes(raw) ? raw : 'greet';
  // ★ P1-1 하루 한도 확인 — 요청마다 1행씩 쌓아 횟수를 센다(유니크 인덱스 없음)
  const day = today();
  const used = db.prepare('SELECT COUNT(*) c FROM interact_logs WHERE user_id=? AND day=? AND situation=?')
    .get(u.id, day, situation).c;
  if(used >= INTERACT_DAILY_LIMIT){
    // 한도 초과: LLM 을 부르지 않고 프리셋 대사로 즉시 응한다(예산 보호)
    const fb = db.prepare('SELECT line FROM robot_lines WHERE personality=? AND situation=? ORDER BY RANDOM() LIMIT 1')
      .get(robot.personality, situation);
    return res.json({ line: fb ? fb.line : robot.greeting, limited:true });
  }
  db.prepare('INSERT INTO interact_logs(user_id,day,situation) VALUES(?,?,?)').run(u.id, day, situation);
  const situationKor = situation==='feed' ? '로봇이 아이에게 간식을 받았을 때'
                     : situation==='praise' ? '아이가 로봇을 칭찬해줬을 때'
                     : '아이가 로봇에게 인사할 때';
  // 동일한 프롬프트를 두 번 중복 작성하지 않도록 변수로 재사용
  const IP = `너는 DOROBUS의 로봇 "${robot.name}"(성격: ${robot.personality})다. ${situationKor} 상황이다. 어린이용 한국어 대사 한 문장만 출력해라 (25자 이내, 따옴표·설명·이모지 없이 대사만).`;
  const ir = await callLLM(IP);
  const txt = ir ? ir.text : null;
  // ★ P0-4 LLM 출력은 반드시 안전 필터를 통과해야 한다(미통과 시 프리셋으로 폴백)
  const safe = sanitizeLine(txt, 80);
  if(safe) return res.json({ line: safe, ai:true });
  const line = db.prepare('SELECT line FROM robot_lines WHERE personality=? AND situation=? ORDER BY RANDOM() LIMIT 1')
    .get(robot.personality, situation);
  res.json({ line: line ? line.line : robot.greeting });
});

// 오늘의 퀘스트 완료 → 셀 지급 (일별·퀘스트별 1회, 유니크 인덱스로 동시 요청도 1회 보장)
app.post('/api/quest/complete', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const q = db.prepare('SELECT * FROM daily_quests WHERE id=? AND quest_date=?').get(Number(req.body && req.body.questId), today());
  if (!q) return res.status(400).json({error:'오늘의 퀘스트가 아닙니다'});
  // ★ AI 미션은 답변 제출(/api/quest/answer) 로만 완료한다 — 그냥 눌러서 보상 받는 걸 막는다
  if(q.type === 'ai_mission')
    return res.status(400).json({error:'AI 미션은 질문에 답해야 완료할 수 있어요'});
  try{
    db.prepare('INSERT INTO quest_logs(user_id,quest_id,reward) VALUES(?,?,?)').run(u.id, q.id, q.reward);
  }catch(e){ return res.status(400).json({error:'이미 완료한 퀘스트예요'}); }
  // ★ 부품 보너스: 보유 부품마다 과제 보상 +2셀(최대 +10)
  const bonus = partBonus(u.id);
  const total = q.reward + bonus;
  grantCell(u.id, total, 'daily_quest');
  // ★ P0-2 과제 완료 경험치(간식/칭찬 = 10 XP + 부품 1개당 1 XP)
  const g = addExp(u.id, 10 + Math.floor(bonus/2));
  res.json({ ok:true, reward:total, baseReward:q.reward, bonus, growth:g,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ★ 오늘의 AI 미션 답변 제출 (매일 1회, +30셀) — 로그 선기록 → 발금 (LLM 지연 중 중복 제출 무결성)
app.post('/api/quest/answer', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const missions = db.prepare("SELECT * FROM daily_quests WHERE quest_date=? AND type='ai_mission'").all(today());
  if(!missions.length) return res.status(400).json({error:'오늘의 미션을 준비 중이에요'});
  // 오늘 이미 어떤 미션이든 답했으면 1회 제한 (배정된 미션이 바뀌어도 재답변 불가)
  const mIds = missions.map(m=>m.id);
  const already = db.prepare(`SELECT quest_id FROM quest_logs WHERE user_id=? AND quest_id IN (${mIds.map(()=>'?').join(',')})`).get(u.id, ...mIds);
  if(already) return res.status(400).json({error:'이미 완료한 미션이에요'});
  const q = pickMission(u.id, missions);
  const text = (req.body && req.body.answer ? req.body.answer : '').trim().slice(0,200);
  if(text.length < 3) return res.status(400).json({error:'조금 더 이야기해줄래?'});
  try{ // 로그를 먼저 기록(유니크 제약) → 발금. 기존은 발금→로그 순서라 실패 시 무한 재수령 가능했음
    db.prepare('INSERT INTO quest_logs(user_id,quest_id,reward) VALUES(?,?,?)').run(u.id, q.id, q.reward);
  }catch(e){ return res.status(400).json({error:'이미 완료한 미션이에요'}); }
  // ★ 부품 보너스: 보유 부품마다 미션 보상 +2셀(최대 +10)
  const bonus = partBonus(u.id);
  const total = q.reward + bonus;
  grantCell(u.id, total, 'daily_quest');
  // ★ P0-2 AI 미션은 글쓰기 행동이므로 경험치를 더 준다(20 XP + 부품 보너스)
  const g = addExp(u.id, 20 + Math.floor(bonus/2));
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const RP = `로봇 "${robot?robot.name:'루미'}"(성격: ${robot?robot.personality:'반짝이'})가 아이의 대답 "${text.slice(0,80)}"에 반응하는 한국어 한 문장 (25자 이내, 대사만). 출력은 어린이에게 안전하고 건전한 표현만 사용한다.`;
  const qr = await callLLM(RP);
  const raw = (qr && qr.text) || '';
  // ★ P0-4 안전 필터: 미통과 시 프리셋 반응으로 폴백(아이 화면에 노출 전 필수)
  const reaction = sanitizeLine(raw, 80) || '오늘 이야기 들려줘서 고마워!';
  // ★ V15 주간 주제 보상: 주제에 맞게 참여한 아이에게 '주 1회' 우편 보상(수령형).
  //   같은 주에는 tag 로 중복 발송이 막힌다. 우편함을 볼 주간 이유가 생긴다.
  sendMail(u.id, { title:'이번 주 주제 보상 도착!', cell:30, tag:'topic-'+currentTopic().week,
    body:'이번 주 주제 "'+currentTopic().topic+'" 에 참여했어요. 30셀을 받아가세요!' });
  res.json({ ok:true, reward:total, baseReward:q.reward, bonus, growth:g, reaction,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// 상점: 아이템 목록 + 구매(셀 차감) — 조건부 UPDATE로 잔액 부족 시 원자적으로 거부
app.get('/api/items', (_req,res)=>{
  // ★ V11: 전체를 내려주되 available 플래그를 붙인다.
  //   잠긴 아이템도 보여줘야 "주말에 열려요" 라는 예고가 된다(숨기면 예고가 사라진다).
  const dow = todayDow();
  const weekly = ensureWeeklySale();
  const wdays = weeklyDaysLeft();
  res.json(db.prepare('SELECT * FROM items').all().map(it=>{
    const end = it.sale_end ? new Date(String(it.sale_end).slice(0,10) + 'T23:59:59+09:00').getTime() : null;
    const isWeekly = weekly.has(it.id);
    return {
      ...it,
      limitedDays: it.limited_days ? String(it.limited_days).split(',').map(Number) : null,
      available: itemAvailable(it, dow),
      saleEnd: it.sale_end || null,
      remainingDays: end ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null,
      limited: it.sale_end ? 'time' : (it.limited_days ? 'weekend' : null),
      // ★ v1.65: 이번 주 특가 — 가격은 서버가 정하고 화면은 배지로 알린다.
      weekly: isWeekly,
      weeklyPrice: isWeekly ? weeklyPriceOf(it) : null,
      weeklyDays: isWeekly ? wdays : null,
    };
  }));
});
app.post('/api/shop/buy', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(Number(req.body && req.body.itemId));
  if (!it) return res.status(400).json({error:'잘못된 요청'});
  // ★ V11 주말 한정: 프론트를 우회해도 살 수 없도록 서버에서 막는다
  if(!itemAvailable(it, todayDow())){
    const ended = it.sale_end && new Date(String(it.sale_end).slice(0,10) + 'T23:59:59+09:00').getTime() < Date.now();
    return res.status(400).json({error: ended ? '판매가 끝난 상품이에요' : '오늘은 살 수 없는 한정 아이템이에요! 주말에 다시 만나요 😊'});
  }
  // ★ P1-4 소지품(consumable=0)은 1회만 보유 가능 — 서버에서 거부(프론트 우회 방지)
  const existing = db.prepare('SELECT id FROM inventory WHERE user_id=? AND item_id=?').get(u.id, it.id);
  if(existing && !it.consumable) return res.status(409).json({error:'이미 가지고 있어요'});
  // ★ v1.65: 이번 주 특가 상품은 8할 가격으로 결제한다(서버가 가격을 결정).
  const price = ensureWeeklySale().has(it.id) ? weeklyPriceOf(it) : it.price;
  const upd = db.prepare('UPDATE users SET cell_balance = cell_balance - ? WHERE id=? AND cell_balance >= ?').run(price, u.id, price);
  if (upd.changes === 0) return res.status(400).json({error:'셀이 부족해요!'});
  db.prepare('INSERT INTO cell_tx(user_id,amount,source) VALUES(?,?,?)').run(u.id, -price, 'shop');
  if (existing) db.prepare('UPDATE inventory SET qty=qty+1 WHERE id=?').run(existing.id);
  else db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, it.id);
  res.json({ ok:true, price, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ★ 부품 조각 교환 (V2-1): 조각은 '재료'이므로 쓰려면 교환해야 한다.
//   예전에는 코멘트에만 "3개 모이면 부품 1개와 교환" 이라고 적혀 있고
//   실제 교환 엔드포인트가 없었다 → 돈을 낸 뒤 쓸 수 없는 무반환 재발.
const SHARD_PER_PART = 3;
// ★ V4: 부품별 필요 조각 수를 정가 기준으로 계산한다.
//   핵심: 어떤 부품도 정가보다 싸게 사게 되면 안 된다.
//   조각 정가 = 20셀 이므로 부품 정가 P 의 교환 조각 수는 ceil(P/20) 이고
//   회수율은 정확히 100%(할인 없음) → 상점 가격표가 유지된다.
//   이전처럼 무조건 3개로 두면 로켓 부스터(120셀)가 60셀에 들어와 절반 값이 된다.
//   조각을 모으는 재미를 위해 가장 싼 부품에만 10% 보조 할인을 둔다
//   (여전히 정가 대비 소폭 이득일 뿐, 싼 부품이 관매가 되지 않는다).
const SHARD_SURPLUS = 0.9;                 // 가장 싼 부품만 적용할 보조 할인
const SHARD_PRICE = 20;                    // 조각 1개 정가(교환 비율의 기준)
function shardCostFor(part){
  const byPrice = Math.ceil(part.price / SHARD_PRICE);
  const cheapest = exchangeableParts()[0];
  if(cheapest && part.id === cheapest.id){
    return Math.max(1, Math.round(byPrice * SHARD_SURPLUS));
  }
  return Math.max(1, byPrice);
}
// 교환 가능한 부품 목록(type='part' 인 아이템)
function exchangeableParts(){
  return db.prepare("SELECT * FROM items WHERE type='part' ORDER BY price ASC").all();
}
// 가장 싼 부품 기준 필요 조각 수(진행도 표시용)
function shardNeedMin(){
  const parts = exchangeableParts();
  if(!parts.length) return SHARD_PER_PART;
  return Math.min(...parts.map(p=>shardCostFor(p)));
}
app.post('/api/shop/exchange', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const wantId = Number(req.body && req.body.partId) || 0;
  const parts = exchangeableParts();
  if(!parts.length) return res.status(400).json({error:'교환할 부품이 없어요'});
  const target = wantId ? parts.find(p=>p.id===wantId) : parts[0];
  if(!target) return res.status(400).json({error:'해당 부품을 찾을 수 없어요'});

  // ★ V4: 조각 필요 개수를 '목표 부품의 실제 가격' 으로 계산한다.
  //   이전엔 무조건 3개(60셀) 였는데, 그 결과 값싼 부품은 그대로고
  //   비싼 부품(120셀)은 절반 값에 사는 순위가 생겨 상점 가격표가 무의미해졌다.
  //   이제 부품마다 필요한 조각 수가 다르다 → 가격이 곧 교환 비율이 된다.
  const need = shardCostFor(target);
  const shardItem = db.prepare("SELECT * FROM items WHERE type='shard' ORDER BY id LIMIT 1").get();
  if(!shardItem) return res.status(400).json({error:'부품 조각이 없어요'});
  const inv = db.prepare('SELECT id,qty FROM inventory WHERE user_id=? AND item_id=?').get(u.id, shardItem.id);
  const have = inv ? inv.qty : 0;
  if(have < need){
    return res.status(400).json({error:`조각이 ${have}개야 — ${target.name}은(는) 조각 ${need}개가 필요해!`});
  }
  const owned = db.prepare('SELECT id,qty FROM inventory WHERE user_id=? AND item_id=?').get(u.id, target.id);
  const left = have - need;
  // ★ 수량이 0 이 된 조각 행은 DELETE 한다(V3).
  //   0 행을 남겨두면 다른 조회에서 "보유 중" 처럼 오인되고,
  //   || 같은 falsy 처리에서 숫자가 뒤틀려 "조각 1/3" 로 잘못 표시된다.
  if(left > 0) db.prepare('UPDATE inventory SET qty=qty-? WHERE id=?').run(need, inv.id);
  else db.prepare('DELETE FROM inventory WHERE id=?').run(inv.id);
  if(owned) db.prepare('UPDATE inventory SET qty=qty+1 WHERE id=?').run(owned.id);
  else db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, target.id);
  res.json({
    ok:true, part: target.name, remaining: left, used: need,
    qty: (owned ? owned.qty : 0) + 1,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance
  });
});

// ★ 부품 조각 교환 가능 정보 (클라이언트가 교환 UI 를 그릴 때 사용)
app.get('/api/shop/exchange-info', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const shardItem = db.prepare("SELECT * FROM items WHERE type='shard' ORDER BY id LIMIT 1").get();
  const inv = shardItem ? db.prepare('SELECT qty FROM inventory WHERE user_id=? AND item_id=?').get(u.id, shardItem.id) : null;
  const have = inv ? inv.qty : 0;
  // ★ V4: 부품마다 필요한 조각 수가 다르다 → 클라이언트가 선택지를 보여줄 수 있게 함께 보낸다
  const targets = exchangeableParts().map(p=>({ id:p.id, name:p.name, price:p.price, need:shardCostFor(p) }));
  const cheapestNeed = targets.length ? Math.min(...targets.map(t=>t.need)) : SHARD_PER_PART;
  res.json({
    have,
    need: cheapestNeed,               // '가장 싼 부품 기준' 필요 개수(진행도 표시용)
    canExchange: have >= cheapestNeed,
    targets
  });
});

// ★ 미니게임 결과 제출 (난이도 커브)
//   게임 자체는 클라이언트에서 돌고, 여기는 '성적 검증 + 보상 지급'만 한다.
//   - reaction : 반응속도(밀리초). 낮을수록 높은 보상
//   - memory   : 기억 순서(도달 단계). 높을수록 높은 보상
//   하루 1회만 인정. quest_logs 에 섞지 않고 game_logs 를 쓰므로
//   '과제 완료 수' 통계가 게임 기록으로 오염되지 않는다.
app.post('/api/game/result', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const { kind } = req.body || {};
  const day = today();
  // 같은 종류를 오늘 두 번 받으면 안 된다(종류별 1회)
  const used = db.prepare('SELECT kind FROM game_logs WHERE user_id=? AND day=?').all(u.id, day).map(r=>r.kind);
  if (used.includes(String(kind)))
    return res.status(400).json({error:'오늘은 이미 이 게임을 했어! 내일 또 도전해 봐 😊'});
  if (kind === 'reaction'){
    const ms = Math.max(0, Math.min(99999, Number(req.body.ms)||0));
    if (ms < 120) return res.status(400).json({error:'너무 빨랐어! 다시 도전해 봐'});
    // 비정상적으로 느린 값은 조작/버그로 보고 보상을 주지 않는다(상한 9초).
    if (ms > 9000) return res.status(400).json({error:'기록이 이상해요! 다시 도전해 봐'});
    // ★ 보상 공식: 빠를수록 높고(400ms → 50셀 상한), 느릴수록 낮아진다(하한 10셀).
    //   ⚠️ 주의: 이전 식(50-(ms-1500)/60)은 ms 가 작을수록 값이 커지는
    //   역전되어 있어 "천천히 눌러야 이득" 이었다. 지금 식은 단조 감소다.
    const reward = Math.max(10, Math.min(50, Math.round(50 - (ms-400)/22)));
    return grantGameReward(u, 'reaction', reward, '반사속도', { ms, res });
  }
  if (kind === 'memory'){
    const lv = Math.max(1, Math.min(9, Number(req.body.level)||1));
    if (lv < 3) return res.status(400).json({error:'조금만 더 성공해 볼래?'});
    const reward = Math.round(20 + lv*10);   // 3단계 50셀 ~ 9단계 110셀
    return grantGameReward(u, 'memory', reward, '기억력', { level: lv, res });
  }
  // ★ 2026-10-27: 버그 슈터 — 점수 기반 보상. 하루 1회만 지급(위 used 검사).
  if (kind === 'shooter'){
    const score = Math.max(0, Math.min(99999, Number(req.body.score)||0));
    if (score < 50) return res.status(400).json({error:'조금 더 도전해 볼래?'});
    // v1.37: 보스 무한 재소환을 막았으므로 «5000점» 기준은 도달 불가 → 구간을 다시 잡았다.
    //   500/1200/2000/2800/3500 → 20/30/50/80/110 (설계 §5-3)
    const reward = score >= 3500 ? 110 : score >= 2800 ? 80 : score >= 2000 ? 50
                 : score >= 1200 ? 30 : score >= 500 ? 20 : 10;
    return grantGameReward(u, 'shooter', reward, '버그 슈터', { score, res });
  }
  // ★ 2026-10-28: 버그 두더지 — 30초 안에 버그를 잡는 다른 장르. 점수 기반 보상.
  if (kind === 'mole'){
    const score = Math.max(0, Math.min(99999, Number(req.body.score)||0));
    if (score < 20) return res.status(400).json({error:'조금 더 도전해 볼래?'});
    const reward = score >= 800 ? 80 : score >= 500 ? 50 : score >= 300 ? 30
                 : score >= 150 ? 20 : 10;
    return grantGameReward(u, 'mole', reward, '버그 두더지', { score, res });
  }
  // ★ v1.41 «고장 탐정 · 미리 고치기» — 관찰·진단·복구 게임.
  //   교수 피드백 «미니게임이 전부 유명한 장르» 에 대한 응답으로 만든 자체 장르다.
  //   핵심: 오답은 감점이 아니라 «제외» 이며, 첫 판단에만 보너스를 준다.
  if (kind === 'repair'){
    const score = Math.max(0, Math.min(9999, Number(req.body.score)||0));
    if (score < 100) return res.status(400).json({error:'조금 더 도전해 볼래?'});
    // v1.42 «사슬» 채점: 등 8개(×150) + 3대 완전 복구(×120) + 남은 부품(×60) + 남은 시간(×2)
    //   → 이론 2,100점. 보통 한 판은 1,200~1,500점이라 구간을 그 분포에 맞춘다.
    const reward = score >= 1900 ? 120 : score >= 1600 ? 90 : score >= 1300 ? 60
                 : score >= 900 ? 40 : score >= 500 ? 20 : 10;
    return grantGameReward(u, 'repair', reward, '고장 탐정', { score, res });
  }
  res.status(400).json({error:'알 수 없는 게임이야'});
});
// 게임 보상 공통 처리(로그를 먼저 남겨 중복 지급 방지)
function grantGameReward(u, kind, reward, label, extra){
  const scoreVal = extra.ms != null ? extra.ms
                 : (extra.level != null ? extra.level
                 : (extra.score != null ? extra.score : 0));
  try{
    db.prepare('INSERT INTO game_logs(user_id,day,kind,score,reward) VALUES(?,?,?,?,?)')
      .run(u.id, today(), kind, scoreVal, reward);
  }catch(e){ return extra.res.status(400).json({error:'이미 보상을 받았어'}); }
  grantCell(u.id, reward, 'game');
  const g = addExp(u.id, 15 + Math.floor(reward/20));
  extra.res.json({ ok:true, reward, label, growth:g, ms: extra.ms, level: extra.level, score: extra.score,
                   balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
}

// ───────── ★ v1.46 «빛의 병 정리» 진행도 API ─────────
//   GET  : 이어할 레벨·별·플레이 수를 되돌려 준다.
//   POST : 한 판이 끝났을 때만 호출한다. 셀 지급 없음, 레벨은 현재+1 까지만 올린다.
//   best_stars 는 «해당 레벨의 최고 별» 이며 total_stars 는 그 합을 매번 재집계한다
//   (+1 누적이 아니므로 같은 레벨을 다시 풀어도 점수가 부풀지 않는다 — v1.40 교훈).
app.get('/api/sort/progress', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  let row = db.prepare('SELECT * FROM sort_progress WHERE user_id=?').get(u.id);
  if(!row){
    db.prepare('INSERT INTO sort_progress(user_id,level,day) VALUES(?,1,?)').run(u.id, today());
    row = db.prepare('SELECT * FROM sort_progress WHERE user_id=?').get(u.id);
  }
  let best = {};
  try{ best = JSON.parse(row.best_stars || '{}') || {}; }catch(e){ best = {}; }
  res.json({ ok:true, level:row.level, totalStars:row.total_stars, bestStars:best,
             plays:row.plays, wanders:row.wanders, hintsEarned:row.hints_earned,
             missions:row.missions||0, shards:row.shards||0, surges:row.surges||0,
             bestStreak:row.best_streak||0, day:row.day });
});

app.post('/api/sort/progress', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const won = b.won === true || b.won === 1;
  const lv = Math.max(1, Math.min(99, Number(b.level)||1));
  const stars = Math.max(0, Math.min(3, Number(b.stars)||0));
  const moves = Math.max(0, Math.min(9999, Number(b.moves)||0));
  const par = Math.max(0, Math.min(9999, Number(b.par)||0));
  const wanders = Math.max(0, Math.min(9999, Number(b.wanders)||0));
  const hints = Math.max(0, Math.min(9999, Number(b.hintsEarned)||0));
  // ★ v1.47 새 규칙 지표 : 주문서 완료 / 모은 조각 / 서지 횟수(발표용 기능 증거)
  const missions = Math.max(0, Math.min(99, Number(b.missions)||0));
  const shards = Math.max(0, Math.min(99999, Number(b.shards)||0));
  const surges = Math.max(0, Math.min(999, Number(b.surges)||0));
  const orderType = ['speed','thrifty','order'].includes(String(b.orderType)) ? String(b.orderType) : null;
  // ★ v1.48 «도전 모드» : 레벨·별은 건드리지 않고 «최고 연속 단계» 만 갱신한다.
  const mode = String(b.mode) === 'endless' ? 'endless' : 'level';
  const streak = Math.max(0, Math.min(999, Number(b.streak)||0));
  let row = db.prepare('SELECT * FROM sort_progress WHERE user_id=?').get(u.id);
  if(!row){
    db.prepare('INSERT INTO sort_progress(user_id,level,day) VALUES(?,1,?)').run(u.id, today());
    row = db.prepare('SELECT * FROM sort_progress WHERE user_id=?').get(u.id);
  }
  if(mode === 'endless'){
    const bestStreak = Math.max(row.best_streak||0, streak);
    db.prepare(`UPDATE sort_progress SET best_streak=?, plays=plays+1, day=?,
                updated_at=datetime('now','+9 hours') WHERE user_id=?`)
      .run(bestStreak, today(), u.id);
    return res.json({ ok:true, mode:'endless', level:row.level, totalStars:row.total_stars,
      bestStreak, streak, plays:row.plays+1, reward:0,
      note:'도전 모드 기록이 남았어요 (셀 지급 없음)' });
  }
  let best = {};
  try{ best = JSON.parse(row.best_stars || '{}') || {}; }catch(e){ best = {}; }
  // 레벨을 건너뛰어 보내도 «한 단계» 만 올라간다(조작으로 99레벨로 점프하지 못하게).
  const effLv = Math.min(lv, row.level);
  if(won && stars > 0){
    const k = String(effLv);
    best[k] = Math.max(Number(best[k])||0, stars);
  }
  // 재집계: 최고 별의 합만 인정한다(반복 플레이로 총별이 무한정 늘어나지 않는다).
  const totalStars = Object.values(best).reduce((a,v)=>a+(Number(v)||0),0);
  const nextLevel = won && lv >= row.level ? Math.min(99, row.level + 1) : row.level;
  db.prepare(`UPDATE sort_progress SET level=?, total_stars=?, best_stars=?, plays=plays+1,
              wanders=wanders+?, hints_earned=hints_earned+?, missions=missions+?,
              shards=shards+?, surges=surges+?, day=?,
              updated_at=datetime('now','+9 hours') WHERE user_id=?`)
    .run(nextLevel, totalStars, JSON.stringify(best), wanders, hints, missions, shards, surges, today(), u.id);
  res.json({ ok:true, level:nextLevel, totalStars, bestStars:best,
             plays:row.plays+1, missions:(row.missions||0)+missions,
             shards:(row.shards||0)+shards, surges:(row.surges||0)+surges,
             bestStreak:row.best_streak||0, orderType, reward:0, moves, par,
             note:'셀 대신 레벨·별·주문서가 남았어요' });
});

// 첫 방문일부터 오늘까지 경과 일수(재접속률 분모)
// 첫 방문이 오늘이면 1로 본다(0으로 나누면 NaN이 되므로).
function daysSinceFirst(uid){
  const row = db.prepare('SELECT entered_at FROM visits WHERE user_id=? ORDER BY entered_at ASC LIMIT 1').get(uid);
  if (!row || !row.entered_at) return 1;
  const first = new Date(String(row.entered_at).replace(' ', 'T') + '+09:00');
  if (isNaN(first.getTime())) return 1;
  const diff = Date.now() - first.getTime();
  return Math.max(1, Math.round(diff / 86400000) + 1);
}

// 대시보드: 잔액/거래내역/방문 횟수/퀘스트 완료 수 (재화 흐름 + 효과 검증 데이터 소스)
app.get('/api/board/me', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const uid = u.id;
  const txs = db.prepare('SELECT amount,source,ts FROM cell_tx WHERE user_id=? ORDER BY id DESC LIMIT 20').all(uid);
  // ★ V7 체류시간: 하루 단위로 정책 상한(DAILY_PLAY_LIMIT)까지만 인정한다.
  //   탭을 열어둔 벽시계 시간이 그대로 쌓여 '하루 40분 제한'과 모순되던 문제를 막는다.
  const playSec = cappedDurationSec(uid);
  // ★ P0-3 재접속 근거: 서로 다른 날짜 수
  const dayRow = db.prepare("SELECT COUNT(DISTINCT substr(entered_at,1,10)) c FROM visits WHERE user_id=?").get(uid);
  // ★ 재접속률: '두 번째 접속일 이후 다시 온 날의 비율'.
  //   평가 세부 기준에 이름된 핵심 지표인데 이전엔 계산 자체가 없었다.
  //   첫 접속일은 재접속 대상에서 제외하고, 전체 일정수 대비 재방문일을 센다.
  const span = Math.max(1, daysSinceFirst(uid));
  const stats = {
    balance: u.cell_balance,
    visitCount: db.prepare('SELECT COUNT(*) c FROM visits WHERE user_id=?').get(uid).c,
    activeDays: dayRow.c,                                  // 방문한 서로 다른 날짜 수
    playMinutes: Math.round(playSec / 60),                 // 총 체류시간(분, 일 40분 상한)
    // 아래 4개가 '실시간 / 누적 / 평균 / 재접속' 라벨에 대응한다
    avgMinutes: dayRow.c ? Math.round(playSec / 60 / dayRow.c) : 0,   // 일당 평균 체류(분)
    // ★ V7: 재접속률 정의를 전 엔드포인트와 통일(활동일수 ÷ 경과일수). 매일 접속하면 100%.
    returnRate: Math.min(100, Math.round(dayRow.c / span * 100)),
    returnSpanDays: span,
    streak: u.streak || 0,
    level: u.level || 1,
    exp: u.exp || 0,
    expNeeded: expNeeded(u.level || 1),
    questDone: db.prepare('SELECT COUNT(*) c FROM quest_logs WHERE user_id=?').get(uid).c,
    txIn: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cell_tx WHERE user_id=? AND amount>0").get(uid).s,
    txOut: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cell_tx WHERE user_id=? AND amount<0").get(uid).s,
  };
  // 최근 7일 일별 통계(트렌드 그래프용)
  const daily = db.prepare(`SELECT substr(entered_at,1,10) d, COUNT(*) visits, COALESCE(SUM(duration),0) secs
    FROM visits WHERE user_id=? GROUP BY d ORDER BY d DESC LIMIT 7`).all(uid).reverse();
  res.json({ txs, stats, daily });
});

// ============================================================
// ★ V15 P0-4 우편함 / P0-3 수업 출석 / P0-1 공작소
// ============================================================

// 우편 발송 공통 함수. tag 가 있으면 같은 태그로 두 번 쌓이지 않는다(UNIQUE).
function sendMail(uid, { title, body, cell, itemId, tag }){
  try{
    db.prepare('INSERT INTO mailbox(user_id,title,body,cell,item_id,tag) VALUES(?,?,?,?,?,?)')
      .run(uid, String(title).slice(0,60), String(body||'').slice(0,300),
           Math.max(0, Math.round(Number(cell)||0)), itemId || null, tag || null);
    return true;
  }catch(e){ return false; }   // 태그 중복 = 이미 보낸 보상(정상 흐름)
}

app.get('/api/mailbox', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const rows = db.prepare('SELECT id,title,body,cell,item_id,claimed,ts,tag FROM mailbox WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id);
  // ★ 2026-11-04: 친구 알림(셀 없는 편지)도 미확인 배지에 잡힌다 → 재방문 이유가 된다.
  // ★ 2026-11-21 (v1.74) C1: «가족의 한 마디»(parent_cheer) 도 미확인 배지에 잡힌다.
  const unread = rows.filter(r=>!r.claimed && (r.cell>0 || r.item_id
    || String(r.tag||'').startsWith('friend:') || String(r.tag||'').startsWith('parent_cheer'))).length;
  res.json({
    unread,
    mails: rows.map(r=>({
      id:r.id, title:r.title, body:r.body, cell:r.cell, claimed:!!r.claimed, ts:r.ts,
      tag: r.tag || null,   // ★ v1.74: fog:/parent_cheer 태그 전달 — «다시 가르쳐 주기» 깊은 링크용
      item: r.item_id ? (db.prepare('SELECT name FROM items WHERE id=?').get(r.item_id)||{}).name : null,
    })),
  });
});

// 수령 — 셀/아이템을 실제로 지급하고 claimed 를 세운다.
//   ★ 지급과 표시를 분리한 이유: 아이가 '직접 여는' 행위가 있어야 우편함이 재방문 이유가 된다.
app.post('/api/mailbox/claim', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number(req.body && req.body.id) || 0;
  const m = db.prepare('SELECT * FROM mailbox WHERE id=? AND user_id=?').get(id, u.id);
  if(!m) return res.status(400).json({error:'편지를 찾을 수 없어요'});
  if(m.claimed) return res.status(400).json({error:'이미 받은 선물이에요'});
  // 조건부 UPDATE 로 동시 클릭에도 1회만 지급되게 한다
  const upd = db.prepare('UPDATE mailbox SET claimed=1 WHERE id=? AND claimed=0').run(id);
  if(!upd.changes) return res.status(400).json({error:'이미 받은 선물이에요'});
  if(m.cell > 0) grantCell(u.id, m.cell, 'mailbox');
  let itemName = null;
  if(m.item_id){
    const it = db.prepare('SELECT * FROM items WHERE id=?').get(m.item_id);
    if(it){
      itemName = it.name;
      const own = db.prepare('SELECT id FROM inventory WHERE user_id=? AND item_id=?').get(u.id, it.id);
      if(own) db.prepare('UPDATE inventory SET qty=qty+1 WHERE id=?').run(own.id);
      else db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, it.id);
    }
  }
  res.json({ ok:true, cell:m.cell, item:itemName,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// 한 번에 받기 — 아이가 여러 통을 하나씩 누르는 수고를 줄인다
app.post('/api/mailbox/claim-all', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const pend = db.prepare('SELECT * FROM mailbox WHERE user_id=? AND claimed=0 AND (cell>0 OR item_id IS NOT NULL)').all(u.id);
  let gotCell = 0, gotItems = [];
  for(const m of pend){
    const upd = db.prepare('UPDATE mailbox SET claimed=1 WHERE id=? AND claimed=0').run(m.id);
    if(!upd.changes) continue;
    if(m.cell > 0){ grantCell(u.id, m.cell, 'mailbox'); gotCell += m.cell; }
    if(m.item_id){
      const it = db.prepare('SELECT * FROM items WHERE id=?').get(m.item_id);
      if(it){
        gotItems.push(it.name);
        const own = db.prepare('SELECT id FROM inventory WHERE user_id=? AND item_id=?').get(u.id, it.id);
        if(own) db.prepare('UPDATE inventory SET qty=qty+1 WHERE id=?').run(own.id);
        else db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, it.id);
      }
    }
  }
  res.json({ ok:true, count:pend.length, cell:gotCell, items:gotItems,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---------- P0-3 수업 출석 ----------
app.get('/api/class/status', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const week = weekStartKST();
  const row = db.prepare('SELECT * FROM class_logs WHERE user_id=? AND week_start=?').get(u.id, week);
  res.json({
    week, attended: !!row, reward: CLASS_REWARD,
    weekLabel: `${week.slice(5,7)}월 ${week.slice(8,10)}일 주`,
    hint: '선생님이 알려준 4자리 코드를 넣으면 이번 주 수업 출석이 돼요',
  });
});

app.post('/api/class/attend', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const code = String((req.body && req.body.code) || '').trim();
  const week = weekStartKST();
  // 오늘 시도 횟수 제한(코드 찾기 공격 방지). 성공/실패 무관하게 센다.
  // ★ 실제 기록은 kind='class_try'+횟수(class_try0, class_try1 …) 라 정확 일치로는 못 센다 → LIKE 로 통합
  const tries = db.prepare("SELECT COUNT(*) c FROM workshop_logs WHERE user_id=? AND day=? AND kind LIKE 'class_try%'").get(u.id, today()).c;
  if(tries >= CLASS_ATTEMPT_LIMIT)
    return res.status(429).json({error:'오늘은 여러 번 틀렸어요. 선생님께 다시 물어보고 내일 해봐요!'});
  if(code !== CLASS_CODE){
    try{ db.prepare("INSERT INTO workshop_logs(user_id,day,kind,ts) VALUES(?,?,?,datetime('now','+9 hours'))").run(u.id, today(), 'class_try'+tries); }catch(e){}
    return res.status(400).json({error:'코드가 맞지 않아요. 선생님께 확인해 볼래요?'});
  }
  try{
    db.prepare('INSERT INTO class_logs(user_id,week_start,reward) VALUES(?,?,?)').run(u.id, week, CLASS_REWARD);
  }catch(e){ return res.status(400).json({error:'이번 주 수업 출석은 이미 완료했어요 😊'}); }
  grantCell(u.id, CLASS_REWARD, 'class_attend');
  const g = addExp(u.id, 30);      // 수업 참여는 경험치도 크게
  // 기록용 안내 메일(셀 0) → 우편함에 '무슨 일이 있었는지' 남는다
  sendMail(u.id, {
    title:'이번 주 수업 출석 완료!', cell:0, tag:`class-${week}`,
    body:`수업 참여로 ${CLASS_REWARD}셀을 받았어요. 이번 주도 멋졌어요!`
  });
  res.json({ ok:true, reward:CLASS_REWARD, growth:g,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---------- P0-1 공작소 ----------
app.get('/api/workshop/status', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const d = today();
  const used = db.prepare("SELECT kind FROM workshop_logs WHERE user_id=? AND day=?").all(u.id, d).map(r=>r.kind);
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const owned = db.prepare(`SELECT i.name,i.type,v.qty FROM inventory v JOIN items i ON i.id=v.item_id
    WHERE v.user_id=? AND v.qty>0 AND i.type IN ('part','decor')`).all(u.id);
  res.json({
    hasRobot: !!robot,
    robot: robot ? { name:robot.name, template:robot.template, personality:robot.personality, greeting:robot.greeting } : null,
    owned,
    canRecolor: !used.includes('recolor'),
    canRegenerate: !used.includes('regen'),
    askLeft: Math.max(0, 5 - used.filter(k=>k.startsWith('ask')).length),
  });
});

// 색칠 다시 하기 — 로봇을 만든 뒤에도 색을 바꿀 수 있다(1일 1회).
//   ★ 기존엔 로봇 생성이 1회뿐이라 "다시 만들고 싶다"는 요구를 받을 곳이 없었다.
app.post('/api/workshop/recolor', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  if(!robot) return res.status(400).json({error:'먼저 로봇을 만들어주세요'});
  const palette = (req.body && req.body.palette) || null;
  if(!palette || typeof palette!=='object' || Array.isArray(palette))
    return res.status(400).json({error:'색칠 정보가 이상해요'});
  const clean = {};
  for(const [k,v] of Object.entries(palette)) if(typeof v==='string' && /^#[0-9a-fA-F]{6}$/.test(v)) clean[k]=v;
  if(!Object.keys(clean).length) return res.status(400).json({error:'색을 골라주세요'});
  try{
    db.prepare("INSERT INTO workshop_logs(user_id,day,kind) VALUES(?,?,?)").run(u.id, today(), 'recolor');
  }catch(e){ return res.status(400).json({error:'색칠은 하루에 한 번만 할 수 있어요. 내일 다시 해볼래요?'}); }
  db.prepare('UPDATE robots SET palette=? WHERE id=?').run(JSON.stringify(clean), robot.id);
  res.json({ ok:true, palette:clean });
});

// AI 성격 다시 만들기 — '공작소 안의 AI 모듈'(회사 09-28 최종 방향).
//   색을 바꾸면 성격·인사말도 새로 생성된다. 1일 1회(LLM 예산 보호).
app.post('/api/workshop/regenerate', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  if(!robot) return res.status(400).json({error:'먼저 로봇을 만들어주세요'});
  let palette = {};
  try{ palette = JSON.parse(robot.palette) || {}; }catch(e){}
  if(!Object.keys(palette).length) return res.status(400).json({error:'먼저 색을 칠해주세요'});
  try{
    db.prepare("INSERT INTO workshop_logs(user_id,day,kind) VALUES(?,?,?)").run(u.id, today(), 'regen');
  }catch(e){ return res.status(400).json({error:'AI 성격 만들기는 하루에 한 번이에요. 내일 다시 해볼래요?'}); }
  const { personality, greeting, desc } = await generatePersonality(palette);
  // ★ 재생성 시 desc 도 갱신해 저장한다
  db.prepare('UPDATE robots SET personality=?, greeting=?, "desc"=? WHERE id=?').run(personality, greeting, desc || null, robot.id);
  res.json({ ok:true, personality, greeting, desc });
});

// AI 도우미에게 묻기 — 아이가 로봇에게 고민을 물어본다(회사 DOROBUS 에도 '보이드' 상담 챗봇이 있다).
//   ★ 아이 화면에 나가는 모든 LLM 출력은 안전 필터를 통과해야 한다(미통과 → 프리셋 폴백).
app.post('/api/workshop/ask', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const q = String((req.body && req.body.question) || '').trim().slice(0,120);
  if(q.length < 2) return res.status(400).json({error:'무엇이 궁금한지 한 줄로 적어줄래?'});
  if(!isSafeText(q)) return res.status(400).json({error:'다른 이야기를 해볼까요?'});
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const d = today();
  const asked = db.prepare("SELECT COUNT(*) c FROM workshop_logs WHERE user_id=? AND day=? AND kind LIKE 'ask%'").get(u.id, d).c;
  if(asked >= 5) return res.status(429).json({error:'오늘은 로봇이 많이 바빠요. 내일 또 물어봐요!'});
  try{ db.prepare('INSERT INTO workshop_logs(user_id,day,kind) VALUES(?,?,?)').run(u.id, d, 'ask'+asked); }catch(e){}
  const topic = currentTopic();
  // v1.34: 대상 연령을 «초등 아이» 로 낮추고 «쉬운 말» 을 명시한다(어른 말투 방지).
  const AP = `너는 DOROBUS의 로봇 "${robot?robot.name:'루미'}"(성격: ${robot?robot.personality:'반짝이'})다. 초등학교 아이가 물었다: "${q}". 이번 주 주제는 "${topic.topic}"(CH.${topic.chapter})다. 아이가 바로 알아듣는 쉬운 한국어 두 문장으로만 답해라. 인사·설명·이모지 없이 답만.`;
  const ar = await callLLM(AP);
  const raw = (ar && ar.text) || '';
  const safe = sanitizeLine(raw, 140);
  if(safe) return res.json({ ok:true, answer:safe, ai:true, left: Math.max(0, 4-asked) });
  // 폴백: 주제에 맞는 프리셋 답변(LLM 없이도 대화가 끊기지 않는다)
  const fb = db.prepare("SELECT line FROM robot_lines WHERE situation='greet' ORDER BY RANDOM() LIMIT 1").get();
  res.json({ ok:true, answer: fb ? fb.line : '우와, 좋은 질문이야! 같이 생각해 보자!', ai:false, left: Math.max(0, 4-asked) });
});

// ---------- V4 운영자용: 교차 사용자 집계 / CSV 내보내기 ----------
// ★ 평가 세부 기준이 요구하는 '재접속률·체류시간·과제 제출률' 을
//   여러 계정 묶어서 볼 수 있어야 '효과 검증' 표를 만들 수 있다.
//   사용자 API 는 전부 /me 여서 이걸 하려면 SQLite 를 직접 열어야 했다.
// ★ V5-c: 관리자 키는 '미설정 시 차단'으로 바꾼다.
//   예전엔 기본값이 'dorobus-demo' 여서 소스 코드를 anyone 이 읽으면
//   모든 사용자의 닉네임·활동·잔액을 그대로 내려받을 수 있었다.
//   평가 기준이 '안전·개인정보' 를 명시하므로, 이 기본값은 그 항목에서 감점된다.
//   배포 시 ADMIN_KEY 를 반드시 설정하고, 안 했으면 관리자 API 는 전부 503.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// ★ 키 비교는 타이밍 안전하게 — 길이 차이도 노출하지 않도록 양쪽을 SHA-256 으로
//   고정 길이 해시한 뒤 timingSafeEqual 로 비교한다(이중 해시 방식).
function adminKeyMatches(k){
  try{
    const a = crypto.createHash('sha256').update(String(k == null ? '' : k)).digest();
    const b = crypto.createHash('sha256').update(String(ADMIN_KEY)).digest();
    return crypto.timingSafeEqual(a, b);
  }catch(e){ return false; }
}
function requireAdmin(req,res){
  // 키 미설정 상태에서는 아예 동작하지 않는다(fail-closed)
  if(!ADMIN_KEY){ res.status(503).json({error:'관리자 키가 설정되지 않았어요 (ADMIN_KEY 환경변수 필요)'}); return false; }
  // ★ 헤더(x-admin-key) 우선 — 키가 URL 로그에 남지 않게 한다. 하위 호환으로 query·body 도 받는다.
  const k = req.get('x-admin-key')
    || (req.query && req.query.key)
    || (req.body && req.body.key)
    || '';
  if(!adminKeyMatches(k)){ res.status(401).json({error:'관리자 키가 필요해요'}); return false; }
  return true;
}

// ★ v1.43: 1차(EXAONE)/2차(DeepSeek) 상태 확인 — 키·주소는 절대 노출하지 않는다.
//   공개 버전은 모델 이름과 «지금 어떤 모델이 답했나» 만 알려 준다(사용자 정보 없음).
app.get('/api/llm/status', (req,res)=>{
  const s = llmStatus();
  const find = n => s.providers.find(p=>p.name===n);
  res.json({ ok:true,
    primary: (find('primary')||{}).model || null,
    fallback: (find('deepseek')||{}).model || null,
    lastModel: s.lastModel,
    primaryEnabled: s.primaryConfigured,
    primaryAvailable: !!find('primary') && (find('primary').downForMs||0) === 0
  });
});
app.get('/api/admin/llm-status', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  res.json(llmStatus());
});

// 계정별 핵심 지표(재접속률·체류·과제·재화 흐름)
// ---------- 공용 지표 계산 (단일 진실 공급원) ----------
// ★ V7: 지표 계산이 4곳에 흩어져 있었고, 그중 두 곳이 서로 다른 값을 냈다.
//   - /api/admin/stats  : 개인별 재접속률의 단순 평균 → 29%
//   - /api/public/stats : 일수 가중 통합 비율        → 55%   (같은 데이터, 26%p 불일치)
//   - /api/admin/export.csv 와 /api/board/me 도 각자 계산하고 있었다.
//   → 계산을 metricsFor() 한 곳으로 모아 정의가 갈라질 수 없게 한다.
//   (앞서 PAL_BASE 를 두 곳에 정의해 3D 가 죽었던 것과 같은 유형의 문제)
const TEST_USER_SQL = "nickname NOT LIKE '시연%' AND nickname <> '데모_루미'";
// 재접속률 정의(전 엔드포인트 공통): 가입일부터 오늘까지의 경과일수 중 실제 활동한 날의 비율.
//   매일 접속하면 100%. 한 번만 하고 오지 않으면 낮게 유지된다.
const RETURN_RATE_DEF = '재접속률 = 활동일수 ÷ 경과일수(가입일~오늘, 가입 당일 포함) × 100';
// 하루 단위로 정책 상한까지만 인정한 체류시간(초). 탭 방치 시간을 걷어낸다.
function cappedDurationSec(uid){
  return db.prepare(`SELECT COALESCE(SUM(m),0) s FROM (
    SELECT MIN(SUM(duration), ?) m FROM visits WHERE user_id=?
    GROUP BY substr(entered_at,1,10))`).get(PLAY_CAP_SEC, uid).s;
}
function rawDurationSec(uid){
  return db.prepare('SELECT COALESCE(SUM(duration),0) s FROM visits WHERE user_id=?').get(uid).s;
}
// 한 사용자의 지표 묶음 — 모든 통계 경로가 이 함수만 쓴다.
function metricsFor(uid){
  const activeDays = db.prepare("SELECT COUNT(DISTINCT substr(entered_at,1,10)) c FROM visits WHERE user_id=?").get(uid).c;
  const span = daysSinceFirst(uid);
  const first = db.prepare('SELECT entered_at FROM visits WHERE user_id=? ORDER BY entered_at ASC LIMIT 1').get(uid);
  const txIn  = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM cell_tx WHERE user_id=? AND amount>0').get(uid).s;
  const txOut = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM cell_tx WHERE user_id=? AND amount<0').get(uid).s;
  return {
    activeDays, spanDays: span,
    returnRate: Math.min(100, Math.round(activeDays / span * 100)),  // %
    playMin: Math.round(cappedDurationSec(uid) / 60),                // 정책 상한 반영
    playMinRaw: Math.round(rawDurationSec(uid) / 60),                // 상한 없는 원값(참고용)
    visitCount: db.prepare('SELECT COUNT(*) c FROM visits WHERE user_id=?').get(uid).c,
    quests: db.prepare('SELECT COUNT(*) c FROM quest_logs WHERE user_id=?').get(uid).c,
    games:  db.prepare('SELECT COUNT(*) c FROM game_logs WHERE user_id=?').get(uid).c,
    parts:  db.prepare('SELECT COUNT(*) c FROM inventory WHERE user_id=? AND qty>0').get(uid).c,
    earned: txIn, spent: Math.abs(txOut),
    hasRobot: !!db.prepare('SELECT id FROM robots WHERE user_id=?').get(uid),
    firstVisit: first ? first.entered_at : null,
  };
}
// 집계 대상 계정(데모·시연 제외)에 지표를 붙여 반환
function allUserRows(){
  return db.prepare(`SELECT id,nickname,created_at,level,exp,streak,cell_balance
    FROM users WHERE ${TEST_USER_SQL} ORDER BY id`).all()
    .map(u=>({ id:u.id, nickname:u.nickname, created:u.created_at,
               level:u.level, exp:u.exp, streak:u.streak, balance:u.cell_balance, ...metricsFor(u.id) }));
}
// 활동 기록이 있는 계정만의 '개인별 단순 평균' — 보수적이고 설명이 쉽다.
function meanOf(rows, f){ return rows.length ? Math.round(rows.reduce((a,r)=>a+f(r),0)/rows.length) : 0; }
function meanOf1(rows, f){ return rows.length ? +(rows.reduce((a,r)=>a+f(r),0)/rows.length).toFixed(1) : 0; }

app.get('/api/admin/stats', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  // ★ V7: 공용 metricsFor() 를 쓴다 → /api/public/stats 와 값이 갈라질 수 없다.
  const rows = allUserRows();
  const active = rows.filter(r=>r.activeDays>0);   // 분모: 활동 기록이 있는 계정만
  res.json({
    total: rows.length,            // 집계 대상 계정(데모·시연 제외)
    withData: active.length,       // 실제로 활동 기록이 있는 계정
    definition: RETURN_RATE_DEF,
    summary: {
      avgReturnRate: meanOf(active, r=>r.returnRate),
      avgPlayMin:    meanOf(active, r=>r.playMin),
      avgPlayMinRaw: meanOf(active, r=>r.playMinRaw),
      avgActiveDays: meanOf(active, r=>r.activeDays),
      avgQuests:     meanOf1(active, r=>r.quests),
      avgGames:      meanOf1(active, r=>r.games),
      avgStreak:     meanOf(active, r=>r.streak||0),
      avgLevel:      meanOf(active, r=>r.level||1),
      totalEarned: rows.reduce((a,r)=>a+r.earned,0),
      totalSpent:  rows.reduce((a,r)=>a+r.spent,0),
      robots: rows.filter(r=>r.hasRobot).length,
    },
    rows
  });
});

// ★ V5-b: 쓰레기 시연 계정 정리 (데모 버튼을 여러 번 눌러 생긴 것들)
app.post('/api/admin/cleanup-demo', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const junk = db.prepare("SELECT id,nickname FROM users WHERE nickname LIKE '시연%'").all();
  let n = 0;
  for(const u of junk){
    // ★ 7개 표만 지우던 예전 방식 대신 wipeUserData 로 전 표를 지운다(잔여 데이터 방지)
    wipeUserData(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    n++;
  }
  res.json({ ok:true, removed:n, accounts:junk.map(u=>u.nickname) });
});

// CSV 내보내기(스프레드시트에 붙여넣기용, BOM 포함 → 한글 엑셀 호환)
app.get('/api/admin/export.csv', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  // ★ V7: stats 와 같은 metricsFor() 를 쓴다(CSV 와 화면 숫자가 어긋나지 않도록)
  const rows = allUserRows();
  const esc = v => `"${String(v==null?'':v).replace(/"/g,'""')}"`;
  const head = ['id','nickname','created_at','level','exp','streak','balance','activeDays','spanDays','returnRate','playMin','playMinRaw','visits','quests','games','parts','earned','spent','hasRobot','firstVisit'];
  const lines = [head.join(',')];
  for(const r of rows){
    lines.push([ r.id, r.nickname, r.created, r.level, r.exp, r.streak, r.balance,
      r.activeDays, r.spanDays, r.returnRate, r.playMin, r.playMinRaw, r.visitCount,
      r.quests, r.games, r.parts, r.earned, r.spent, r.hasRobot?1:0, r.firstVisit||'' ].map(esc).join(','));
  }
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="roomi-metrics.csv"');
  res.send('\ufeff' + lines.join('\n'));   // BOM: 엑셀에서 한글이 깨지지 않도록
});

// ★ V12 운영자가 이번 주(또는 다음 주) 주제를 직접 넣는다.
//   평가기준 1) '운영자가 문제·보상·내용을 추가/수정할 수 있는가' 에 대한 실제 구현.
//   예) curl -X POST -H "X-Admin-Key: <키>" -H "Content-Type: application/json" \
//        -d '{"topic":"우리 동네 AI","keywords":"생활, 도움"}' /api/admin/topic
app.post('/api/admin/topic', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const body = req.body || {};
  const week = /^\d{4}-\d{2}-\d{2}$/.test(String(body.week||'')) ? body.week : weekStartKST();
  const topic = String(body.topic||'').trim().slice(0,60);
  if(!topic) return res.status(400).json({error:'topic 이 필요해요'});
  const chapter = Math.max(1, Math.min(99, Number(body.chapter) || 1));
  const keywords = String(body.keywords||'').trim().slice(0,80);
  const ex = db.prepare('SELECT id FROM weekly_topics WHERE week_start=?').get(week);
  if(ex) db.prepare('UPDATE weekly_topics SET chapter=?,topic=?,keywords=? WHERE id=?').run(chapter,topic,keywords,ex.id);
  else   db.prepare('INSERT INTO weekly_topics(week_start,chapter,topic,keywords) VALUES(?,?,?,?)').run(week,chapter,topic,keywords);
  res.json({ ok:true, week, chapter, topic, keywords });
});

// ★ 공개 집계(개인정보 없음) — 키 없이도 쓸 수 있다.
//   평가 기준이 요구하는 4가지 지표(재접속률·체류시간·셀 사용량·과제 제출률)의
//   **집계값만** 공개한다. 닉네임·개인 행은 절대 포함하지 않는다.
//   (W13 효과 검증 표를 만들 때 로그인 없이 바로 인용할 수 있다)
app.get('/api/public/stats', (_req,res)=>{
  // ★ V7: /api/admin/stats 와 '완전히 같은' 계산을 쓴다.
  //   예전엔 여기만 일수 가중 통합 비율을 써서 같은 데이터에 55% vs 29% 가 나왔다.
  const rows = allUserRows();
  const active = rows.filter(r=>r.activeDays>0);
  res.json({
    participants: active.length,
    avgReturnRate: meanOf(active, r=>r.returnRate),      // 관리자 화면과 동일한 값
    avgPlayMinutes: meanOf(active, r=>r.playMin),        // 일 ${DAILY_PLAY_LIMIT}분 상한 반영
    avgActiveDays: meanOf(active, r=>r.activeDays),
    avgQuests: meanOf1(active, r=>r.quests),
    avgGames: meanOf1(active, r=>r.games),
    definition: RETURN_RATE_DEF,
    playNote: `체류시간은 하루 ${DAILY_PLAY_LIMIT}분 상한을 적용한 값입니다(탭 방치 시간 제외)`,
    note: '개인 식별 정보는 포함하지 않는 집계값입니다',
  });
});

// ★ V11 오늘의 랭킹 — '자랑하고 싶다'는 동기와 '1등'이라는 목표를 만든다.
//   실재 플랫폼에도 타자게임 1등 = 셀 획득 경로가 있다(설명회 자료).
//   개인정보 보호를 위해 닉네임은 첫 글자만 남기고 가린다(본인 것은 '나' 로 표시).
const RANK_MASK = n => {
  const s = String(n||'');
  if(s.length <= 1) return s;
  return s[0] + '○'.repeat(Math.min(3, s.length - 1));
};
app.get('/api/rank/daily', (req,res)=>{
  const u = authUser(req);
  const day = today();
  const pick = (kind, orderBy) => db.prepare(`SELECT g.user_id, g.score, u.nickname
    FROM game_logs g JOIN users u ON u.id = g.user_id
    WHERE g.day = ? AND g.kind = ? AND ${TEST_USER_SQL}
    ORDER BY g.score ${orderBy} LIMIT 5`).all(day, kind);
  const mine = (kind) => u ? db.prepare('SELECT score FROM game_logs WHERE user_id=? AND day=? AND kind=?')
    .get(u.id, day, kind) : null;
  const mk = (kind, orderBy, unit, better) => {
    const rows = pick(kind, orderBy).map((r,i)=>({
      rank: i+1,
      name: (u && r.user_id === u.id) ? '나' : RANK_MASK(r.nickname),
      me: !!(u && r.user_id === u.id),
      score: r.score,
    }));
    const m = mine(kind);
    let myRank = rows.find(r=>r.me) ? rows.find(r=>r.me).rank : null;
    if(!myRank && m){
      const all = db.prepare(`SELECT g.user_id FROM game_logs g JOIN users u ON u.id=g.user_id
        WHERE g.day=? AND g.kind=? AND ${TEST_USER_SQL} ORDER BY g.score ${orderBy}`).all(day, kind);
      const idx = all.findIndex(r=>r.user_id === u.id);
      if(idx >= 0) myRank = idx + 1;
    }
    return { rows, myScore: m ? m.score : null, myRank, unit, better };
  };
  res.json({
    day,
    reaction: mk('reaction', 'ASC',  'ms',    'low'),   // 반사속도: 낮을수록 좋다
    memory:   mk('memory',   'DESC', '단계',  'high'),  // 기억순서: 높을수록 좋다
    shooter:  mk('shooter',  'DESC', '점',    'high'),  // 버그 슈터: 높을수록 좋다
    mole:     mk('mole',     'DESC', '점',    'high'),  // 버그 두더지: 높을수록 좋다
    note: '닉네임은 개인정보 보호를 위해 일부 가립니다',
  });
});

// ★ 2026-10-28: 주간 베스트(최근 7일, 게임별 최고점)
app.get('/api/rank/weekly', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const d = new Date(Date.now() + 9*3600*1000);
  d.setUTCDate(d.getUTCDate() - 6);
  const since = d.toISOString().slice(0,10);
  const mk = (kind)=>db.prepare(`SELECT u.nickname, MAX(g.score) score
    FROM game_logs g JOIN users u ON u.id=g.user_id
    WHERE g.kind=? AND g.day>=? AND ${TEST_USER_SQL}
    GROUP BY g.user_id ORDER BY score DESC LIMIT 5`).all(kind, since)
    .map((r,i)=>({rank:i+1, name:RANK_MASK(r.nickname), score:r.score}));
  res.json({ ok:true, since, mole:mk('mole'), shooter:mk('shooter') });
});

// ★ 운영자가 우편으로 공지·보상을 보낸다 — 평가 체크리스트 "운영자가 내용·보상을 추가/수정할 수 있는가"
app.post('/api/admin/mail', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const b = req.body || {};
  const title = String(b.title||'').trim().slice(0,60);
  const body  = String(b.body||'').trim().slice(0,300);
  const cell  = Math.max(0, Math.min(500, Math.round(Number(b.cell)||0)));
  if(!title) return res.status(400).json({error:'title 이 필요해요'});
  const users = db.prepare('SELECT id FROM users').all();
  const tag = b.tag ? String(b.tag).slice(0,40) : null;   // 같은 tag 면 중복 발송 차단
  let sent = 0;
  for(const u of users) if(sendMail(u.id, { title, body, cell, tag })) sent++;
  res.json({ ok:true, sent, total:users.length, tag });
});


// ============================================================
// ★ 2026-10-27 — LLM 학습 대화 / 방 상태 / 퍼즐 / 시즌 / Admin CRUD
// ============================================================
// ★ v1.54: 학습 답변이 «두 문장» 으로 짧아져 5회는 너무 빨리 소진된다(스트리밍 재시도 포함). 10회로.
const CHAT_LIMITS = { chat:10, learn:10, reflect:1 };
const CHAT_MODE_RULES = {
  chat: '공감 먼저, 짧게 2-4문장. 강의/설명 금지. 민감한 주제는 보호자·선생님과 이야기하도록 안내.',
  learn: '절대 최종 정답을 말하지 마라. L1=아이에게 되묻기, L2=생활 비유로 개념 설명, L3=다음 한 단계만 제안. 마지막에 스스로 확인할 질문 1개.',
  reflect: '판단/조언 금지. 1문장 공감 + 1개 질문. 위험 신호는 고정 안내문으로.',
};

function profileFor(uid){
  let p = db.prepare('SELECT * FROM learner_profile WHERE user_id=?').get(uid);
  if(!p){
    db.prepare('INSERT OR IGNORE INTO learner_profile(user_id,understanding) VALUES(?,0)').run(uid);
    p = db.prepare('SELECT * FROM learner_profile WHERE user_id=?').get(uid);
  }
  return p || { understanding:0, weak_topics:null, hint_style:null, last_summary:null };
}
// ★ 2026-10-29: 대화에서 약점 개념을 기억 → 계획/목표 개인화
function addWeakTopic(uid, name){
  if(!name) return;
  const p = profileFor(uid);
  const list = (p.weak_topics||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(list.includes(name)) return;
  list.unshift(name);
  db.prepare("UPDATE learner_profile SET weak_topics=?, updated_at=datetime('now','+9 hours') WHERE user_id=?")
    .run(list.slice(0,5).join(','), uid);
}
function removeWeakTopic(uid, name){
  if(!name) return;
  const p = profileFor(uid);
  const list = (p.weak_topics||'').split(',').map(s=>s.trim()).filter(Boolean).filter(x=>x!==name);
  db.prepare("UPDATE learner_profile SET weak_topics=?, updated_at=datetime('now','+9 hours') WHERE user_id=?")
    .run(list.join(','), uid);
}

// ---- ★ 2026-10-31: AI 전용 장기 기억 ----
const MEMORY_KINDS = new Set(['fact','preference','learning','goal','event','taught']);
const MEMORY_LABELS = { fact:'사실', preference:'선호', learning:'학습', goal:'목표', event:'일정', taught:'내가 가르친 것' };
function memorySafe(v){
  const t = String(v||'').replace(/\s+/g,' ').trim().slice(0,60);
  if(t.length < 1) return '';
  try{ if(!isSafeText(t)) return ''; }catch(e){}
  try{ if(hasContactInfo(t)) return ''; }catch(e){}
  return t;
}
function upsertMemory(uid, m){
  const kind = MEMORY_KINDS.has(String(m.kind)) ? String(m.kind) : 'fact';
  const key = String(m.key||'').replace(/\s+/g,'_').slice(0,40);
  const value = memorySafe(m.value);
  if(!key || !value) return null;
  const confidence = Math.max(0.1, Math.min(1, Number(m.confidence)||0.7));
  const exists = db.prepare('SELECT id FROM user_memories WHERE user_id=? AND kind=? AND key=?').get(uid, kind, key);
  if(!exists){
    const count = db.prepare('SELECT COUNT(*) c FROM user_memories WHERE user_id=?').get(uid).c;
    if(count >= 50){
      db.prepare(`DELETE FROM user_memories WHERE id = (
        SELECT id FROM user_memories WHERE user_id=? ORDER BY confidence ASC, updated_at ASC, id ASC LIMIT 1)`).run(uid);
    }
  }
  db.prepare(`INSERT INTO user_memories(user_id,kind,key,value,confidence,source,expires_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,kind,key) DO UPDATE SET
      value=excluded.value,
      confidence=MAX(user_memories.confidence, excluded.confidence),
      source=excluded.source,
      updated_at=datetime('now','+9 hours')`)
    .run(uid, kind, key, value, confidence, String(m.source||'chat'), m.expires_at||null);
  return { id: exists ? exists.id : null, kind, key, value, confidence };
}
function listMemories(uid, limit=50){
  return db.prepare(`SELECT id,kind,key,value,confidence,source,created_at,updated_at,last_used_at,expires_at
    FROM user_memories WHERE user_id=? AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY updated_at DESC, id DESC LIMIT ?`).all(uid, today(), limit);
}
function retrieveMemories(uid, query, limit=6){
  const rows = listMemories(uid, 50);
  const tokens = String(query||'').toLowerCase().split(/[^0-9a-z가-힣]+/i).filter(t=>t.length>=2).slice(0,10);
  const scored = rows.map(m=>{
    let score = Number(m.confidence)||0.5;
    const text = `${m.key} ${m.value}`.toLowerCase();
    for(const t of tokens){ if(text.includes(t)) score += 3; }
    if(m.kind === 'learning') score += 1.0;
    if(m.kind === 'preference') score += 0.6;
    if(m.kind === 'goal') score += 0.4;
    return { m, score };
  }).sort((a,b)=>b.score-a.score).slice(0, limit);
  for(const {m} of scored){
    db.prepare("UPDATE user_memories SET last_used_at=datetime('now','+9 hours') WHERE id=?").run(m.id);
  }
  return scored.map(x=>x.m);
}
function memoryPrompt(mems){
  if(!mems || !mems.length) return '(없음)';
  return mems.map(m=>`- ${MEMORY_LABELS[m.kind]||m.kind}/${m.key}: ${m.value}`).join('\n');
}
function extractMemoryRules(uid, msg, reply){
  const out = [];
  const t = String(msg||'').trim();
  const cleanKo = (s)=>String(s||'').replace(/^(나는|내가|저는|제가)\s*/,'').replace(/(을|를|이|가|은|는)\s*$/,'').trim();
  const add = (kind,key,value,confidence,expires_at)=>{
    const m = upsertMemory(uid,{kind,key,value,confidence,source:'chat',expires_at});
    if(m) out.push(m);
  };
  let m;
  if((m = t.match(/([가-힣a-zA-Z0-9 ]{2,20})(?:을|를)?\s*좋아해/))){
    const v = cleanKo(m[1]);
    if(v) add('fact','like:'+v,v,0.8);
  }
  if((m = t.match(/([가-힣a-zA-Z0-9 ]{2,20})(?:이|가)?\s*(?:어려워|모르겠|헷갈려)/))){
    const v = cleanKo(m[1]);
    if(v) add('learning','weak:'+v,v+' 어려움',0.8);
  }
  if((m = t.match(/([가-힣a-zA-Z0-9 ]{2,20})(?:을|를)?\s*(?:이해했|알겠|배웠)/))){
    const v = cleanKo(m[1]);
    if(v) add('learning','understood:'+v,v+' 이해',0.85);
  }
  if(/시험|숙제|발표/.test(t)){
    const exp = new Date(Date.now() + 9*3600*1000 + 14*86400000).toISOString().slice(0,10);
    add('event','event:'+today(), t.slice(0,50), 0.6, exp);
  }
  return out;
}
async function extractMemoryLLM(uid, msg, reply){
  try{
    const prompt = `너는 초등 고학년 학습 로봇의 기억 추출기다. 아이 메시지와 로봇 답변에서 '오래 기억할 가치가 있는' 것만 0~3개 뽑아라.
- kind: fact(사실/좋아하는 것) / preference(설명 방식/시간) / learning(이해/약점) / goal(목표) / event(시험/일정)
- 일시적 감정, 잡담, 민감정보(전화/주소/이메일/학교) 제외
- key는 짧은 영문/한글 스네이크, value는 30자 이내
- JSON만: {"memories":[{"kind":"...","key":"...","value":"...","confidence":0.0}]}
아이: ${String(msg||'').slice(0,200)}
로봇: ${String(reply||'').slice(0,180)}`;
    const mr = await callLLM(prompt, { temperature:0.2, maxTokens:220, json:true });
    const raw = mr ? mr.text : null;
    let j = null;
    try{ j = raw ? JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0]) : null; }catch(e){}
    const list = j && Array.isArray(j.memories) ? j.memories : [];
    for(const m of list.slice(0,3)){
      if(!m || !MEMORY_KINDS.has(String(m.kind))) continue;
      if(!m.key || !m.value) continue;
      upsertMemory(uid, { kind:m.kind, key:m.key, value:m.value, confidence:m.confidence, source:'chat' });
    }
  }catch(e){}
}
function forgetMemories(uid, topic){
  if(!topic) return { removed:0 };
  const rows = db.prepare('SELECT id,key,value FROM user_memories WHERE user_id=?').all(uid);
  let removed = 0;
  for(const r of rows){
    if((r.key||'').includes(topic) || (r.value||'').includes(topic)){
      db.prepare('DELETE FROM user_memories WHERE id=?').run(r.id);
      removed++;
    }
  }
  return { removed };
}
function chatCount(uid, mode, day){
  return db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND mode=? AND role='user' AND substr(ts,1,10)=?").get(uid, mode, day).c;
}
function parseChatJSON(raw){
  if(!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}/);
  if(!m) return null;
  try{ const j = JSON.parse(m[0]); if(j && typeof j.reply === 'string' && j.reply.trim()) return j; }catch{}
  return null;
}
// 이번 주 월요일(KST) — weekStartKST() 의 유일한 정의(예전 중복 정의는 제거됨)
function weekStartKST(){
  const d = new Date(Date.now() + 9*3600*1000);
  const diff = (d.getUTCDay() + 6) % 7;   // 월요일 시작
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0,10);
}

// ---- AI 학습 계획 (2026-10-28) ----
// ★ v1.51 지식 카드 검색 — «글자 그대로» 가 아니라 «개념» 으로 찾는다.
//   예전엔 msg.includes(topic) 만 봐서 «분모가 왜 달라» 가 «분수» 카드를 못 찾았다.
const CARD_ALIASES = {
  '변수': ['변수','미지수','값','저장','상자','x'],
  '함수': ['함수','펑션','function','매개변수','인자','리턴','반환','입력값'],
  '반복문': ['반복','루프','for','while','몇 번','계속','돌리'],
  'while 반복': ['while','동안','계속 반복','조건이 맞는'],
  '조건문': ['조건','if','만약','그러면','분기','경우'],
  '리스트': ['리스트','배열','목록','index','인덱스','원소','순서','몇 번째'],
  '문자열': ['문자열','글자','string','텍스트','따옴표','붙이'],
  '산술 연산': ['더하','빼','곱하','나누','계산','연산','사칙'],
  '비교 연산': ['크다','작다','같다','비교','이상','이하'],
  '입력': ['입력','input','물어보','받기','적어'],
  '출력': ['출력','print','보여주','화면에','찍'],
  '이벤트': ['이벤트','클릭','버튼','누르면','event','터치'],
  '오류 메시지': ['오류','에러','error','빨간 글씨','고장','안 돼'],
  '디버깅': ['디버깅','버그','고치','찾기','확인','하나씩'],
  'AI 추천': ['추천','AI가 골라','비슷한','다음에 뭐'],
  'AI 윤리': ['윤리','개인정보','편향','책임','AI가 나쁜']
};
// ★ 2026-11-21 (v1.74) D1: 새 지식 카드 24장의 별칭 — 채팅 카드 매칭(matchCards) 이
//   컴퓨터개론·수학·과학 주제도 «개념» 으로 찾게 한다(v1.51 원칙과 동일).
Object.assign(CARD_ALIASES, {
  '입출력': ['입출력','마우스','키보드','모니터','스피커','프린터'],
  '바이너리': ['바이너리','이진법','binary','0과 1','비트'],
  '메모리': ['메모리','작업 공간','임시 저장','열어 둔'],
  'RAM·ROM': ['램','롬','ram','rom','기억 장치'],
  '캐시': ['캐시','cache','보관함','임시 보관','서랍'],
  'CPU 클록': ['클록','clock','ghz','메트로놈','cpu 속도','똑딱'],
  '운영체제 프로세스': ['프로세스','운영체제','os','작업 관리자','동시에'],
  '파일·디렉터리': ['폴더','디렉터리','디렉토리','파일','서랍'],
  '데이터베이스 테이블': ['데이터베이스','테이블','db','출석부','행과 열'],
  '네트워크 패킷': ['패킷','packet','소포','조각으로','나눠 보내'],
  '프로토콜': ['프로토콜','protocol','여보세요','약속','통신 규칙'],
  '압축': ['압축','zip','용량','말아 담','줄여 담'],
  '곱셈 순서': ['곱셈','연산 순서','먼저 계산','사칙연산','계산 순서'],
  '분수의 덧셈': ['분수','분모','분자','피자 조각','더하기'],
  '약분·통분': ['약분','통분','간단한 분수','기약분수'],
  '소수': ['소수','0.','눈금','십분의'],
  '도형 넓이': ['넓이','면적','직사각형','타일','가로 세로'],
  '각도': ['각도','직각','각도기','시계 바늘','벌어진'],
  '물의 상태': ['얼음','수증기','상태','녹','끓'],
  '온도와 열': ['온도','열','온기','이동'],
  '빛의 반사': ['반사','거울','튕겨','손전등'],
  '자석': ['자석','magnet','n극','s극','끌어당'],
  '식물 광합성': ['광합성','양분','잎','식물의 부엌'],
  '지층': ['지층','겹','화석','쌓'],
});
function matchCards(msg, chapter){
  const all = db.prepare('SELECT * FROM knowledge_cards').all();
  const text = String(msg || '').toLowerCase();
  const scored = [];
  for(const c of all){
    let score = 0;
    const topic = String(c.topic || '').toLowerCase();
    if(topic && text.includes(topic)) score += 5;
    for(const a of (CARD_ALIASES[c.topic] || [])){
      if(a && text.includes(String(a).toLowerCase())) score += 3;
    }
    for(const t of String(c.tags || '').split(',')){
      const tag = t.trim().toLowerCase();
      if(tag && text.includes(tag)) score += 2;
    }
    if(score > 0) scored.push({ c, score });
  }
  scored.sort((a,b)=>b.score-a.score);
  let rows = scored.slice(0,3).map(x=>x.c);
  if(!rows.length) rows = all.filter(c => String(c.chapter) === String(chapter)).slice(0,3);
  if(!rows.length) rows = all.slice().sort(()=>Math.random()-0.5).slice(0,3);
  return rows;
}
// ★ v1.51 «두 문장, 한 가지 행동» — 길게 말하면 아이는 생각을 멈춘다.
function limitSentences(text, maxSent = 2, maxChars = 90){
  const t = String(text || '').replace(/\s+/g,' ').trim();
  if(!t) return t;
  const parts = t.match(/[^.!?…]+[.!?…]?/g) || [t];
  let out = parts.slice(0, maxSent).join(' ').replace(/\s+/g,' ').trim();
  if(out.length > maxChars) out = out.slice(0, maxChars - 1).trim() + '…';
  return out;
}
// ★ v1.51 대화 상태 — 같은 날 같은 모드의 «한 번의 대화» 를 이어서 본다.
function getSession(uid, day, mode){
  let s = db.prepare('SELECT * FROM chat_sessions WHERE user_id=? AND day=? AND mode=?').get(uid, day, mode);
  if(!s){
    db.prepare('INSERT INTO chat_sessions(user_id,day,mode) VALUES(?,?,?)').run(uid, day, mode);
    s = db.prepare('SELECT * FROM chat_sessions WHERE user_id=? AND day=? AND mode=?').get(uid, day, mode);
  }
  return s;
}
// ★ v1.52 «대화 메모» — 원문 6턴을 매번 다시 넣는 대신, 4줄 메모만 다음 턴에 넘긴다.
//   (스크린샷의 «메모를 만들어 두고 매번 컨텍스트를 복기하지 않는다» 와 같은 원리)
function buildSessionSummary(prev, msg, reply){
  const first = String(reply || '').split(/[.!?]/)[0] || '';
  const line = `- ${String(msg || '').replace(/\s+/g,' ').slice(0,36)} → ${first.slice(0,36)}`;
  const lines = String(prev || '').split('\n').map(x=>x.trim()).filter(Boolean);
  lines.push(line);
  return lines.slice(-4).join('\n').slice(-420);
}
function stageLevel(stage){
  if(stage === 'L3' || stage === 'confirm' || stage === 'teachback') return 3;
  if(stage === 'L2') return 2;
  return 1;
}
// 막힘 유형 — LLM 이 안 주면 문장에서 규칙으로 추정한다.
function guessStuckType(text){
  const t = String(text || '');
  if(/(못\s*읽|뭐라는|문제가\s*뭔|이해가\s*안|무슨\s*말)/.test(t)) return 'reading';
  if(/(계산|더하|빼|곱하|나누|순서|다음에\s*뭐)/.test(t)) return 'procedure';
  if(/(대충|실수|깜빡|놓쳤)/.test(t)) return 'careless';
  return 'concept';
}
const STUCK_RULES = {
  concept: '개념 자체를 모른다. 비유 하나 + 아주 쉬운 예 하나만 준다.',
  procedure: '순서를 모른다. 정답 대신 «다음 한 단계» 만 보여주고, 그다음은 아이가 하게 한다.',
  reading: '문제를 잘못 읽었다. 답을 주지 말고 «문제를 네 말로 다시 말해 줄래?» 라고 묻는다.',
  careless: '알지만 실수했다. 답을 말하지 말고 «어디를 다시 확인하면 좋을까?» 라고 묻는다.'
};
const STUCK_TYPES = ['concept','procedure','reading','careless'];

// ★ 2026-11-20 / v1.70 ③c: L1(되묻기) 방식 — 열린 질문 대신 «두 가지 선택지» 를 제시한다.
//   두 파이프라인(/api/chat · /api/chat/stream)이 같은 문장을 쓰도록 상수로 모은다.
const L1_CHOICE_RULE = '[되묻기 방식] 되묻기는 열린 질문 대신 두 가지 구체적 선택지를 제시해라 (예: «분모를 먼저 통분해야 할까, 분자를 먼저 정리할까?»). 선택지 어느 쪽도 정답을 직접 알려주면 안 된다.';
// ★ v1.70 ③c: LLM 실패 시 규칙 폴백 대사에도 «두 가지 선택지» 예시를 넣는다(계약 통일).
const L1_FALLBACK_LINE = '같이 한 단계씩 해 보자. «예시를 먼저 볼까, 아니면 문제를 다시 읽어 볼까?» 둘 중 하나만 골라 보자.';
// ★ v1.70 ⑥: learn 모드 시스템 프롬프트 말미에 붙는 태그 프로토콜(화면에는 태그가 보이지 않는다).
// ★ v1.80 «전부 유도 / 전부 답변» 금지 — 턴마다 의도를 나눈다.
//   ① 답을 명시적으로 요구 ② 지금 배우는 개념 ③ 그 외 지식 질문.
const ASK_ANSWER_RE = /(그냥|바로|정답|답만|답을|알려줘|가르쳐줘|답이 뭐|답은)/;
const ASK_KNOW_RE = /(뭐야|뭔가요|무엇|왜 |왜\?|어떻게|어디서|언제|누구|얼마|뜻|의미|차이|원리)/;
function routeLearnIntent(msg, sess){
  const m = String(msg || '');
  if(ASK_ANSWER_RE.test(m)) return 'direct';            // «그냥 알려줘» → 바로 답
  const cpt = (sess && sess.concept) ? String(sess.concept) : '';
  const inConcept = cpt && (m.includes(cpt) || (CARD_ALIASES[cpt] || []).some(a => m.includes(String(a))));
  if(inConcept) return 'guide';                          // 지금 배우는 개념 → 유도
  if(ASK_KNOW_RE.test(m)) return 'direct';               // 그 외 지식 질문 → 설명
  return 'guide';
}
// 직접 설명 모드의 규칙 — «답을 대신 풀어 주지» 않고 «개념을 설명» 한다.
const DIRECT_RULE = '[직접 설명] 이번 턴은 힌트가 아니라 설명이다. 두 문장, 아주 쉬운 말로 핵심만. 문제의 «정답 자체» 를 대신 말하지는 말고 개념을 설명한다. 끝에 짧은 확인 질문 1개.';

const TAG_LINE_RULE = '응답의 마지막 줄은 아이에게 보이지 않는 태그 한 줄로 끝내라: ⟦stuck:concept|procedure|reading|careless|none⟧';

// ★ v1.70 ⑥: ⟦stuck:…⟧ 태그 줄 분리기.
//   마지막 줄이 태그면 { reply: 태그를 뗀 본문, stuck: 유효 타입 } 을 돌려준다.
//   «none»·알 수 없는 값·태그 없음은 stuck=null → 기존 규칙 추정(guessStuckType)을 그대로 쓴다.
function parseTagLine(text){
  const s = String(text || '');
  const m = s.match(/⟦\s*stuck\s*:\s*([a-zA-Z]+)\s*⟧\s*$/);
  if(!m) return { reply: s.trim(), stuck: null };
  const val = String(m[1] || '').toLowerCase();
  const stuck = STUCK_TYPES.includes(val) ? val : null;
  // 본문 중간에 태그 조각이 남아 있으면 함께 지운다(모델이 여러 줄 출력할 경우 대비)
  const reply = s.slice(0, m.index).replace(/⟦\s*stuck[^⟧]*⟧/g, '').replace(/\s+$/, '').trim();
  return { reply, stuck };
}

// ============================================================
// ★ 2026-11-20 / v1.70 ③a 관심사 도메인 — 최근 3일 user 메시지에서 아이의 관심 영역을 찾아
//   «비유는 이 영역에서 들어 준다» 로 프롬프트에 주입한다. 히트가 없으면 아무것도 넣지 않는다.
// ============================================================
const INTEREST_HINTS = [
  ['게임',   /(게임|게임기|마인크래프트|롤|배틀|캐릭터|레벨업|점수|스테이지|보스|히어로)/],
  ['운동',   /(운동|축구|야구|농구|달리기|달리|자전거|수영|태권도|배드민턴|공놀이|농구)/],
  ['음악',   /(음악|노래|가수|아이돌|케이팝|피아노|기타|춤|댄스|콘서트|멜로디)/],
  ['동물',   /(동물|강아지|고양이|햄스터|공룡|토끼|곰|펭귄|사자|호랑이|물고기|새)/],
  ['만들기', /(만들기|공작|종이접기|블록|레고|미로|그리기|그림|색칠|붙이기|조립)/],
  ['요리',   /(요리|맛있|음식|빵|케이크|과자|김치|라면|치즈|간식|반찬)/],
];
function interestDomainOf(uid){
  try{
    const rows = db.prepare(`SELECT content FROM chat_messages
      WHERE user_id=? AND role='user' AND substr(ts,1,10)>=? ORDER BY id DESC LIMIT 40`)
      .all(uid, dayKST(-2));   // 오늘~2일 전 = 최근 3일
    for(const r of rows){
      for(const [dom, re] of INTEREST_HINTS){ if(re.test(String(r.content||''))) return dom; }
    }
  }catch(e){}
  return null;
}

// ★ v1.70 ④ 좌절 신호 — 규칙 3가지 중 하나라도 맞으면 이번 턴은 «힌트 대신 다독임».
//   1) 같은 단계 연속 2턴 + 이번 턴도 confused
//   2) 오늘 confused user 메시지 3개 이상(이번 턴 포함)
//   3) 최근 2개 user 메시지가 모두 10자 미만 + 부정 단어
const FRUSTRATED_RE = /(모르겠|몰라|어려워|이해가 안)/;
const FRUSTRATED_NEG_RE = /(모르겠|몰라|어려워|힘들|싫어|포기|속상|짜증)/;
function frustrationOf(uid, msg, sess, day){
  const m = String(msg || '');
  const confusedNow = FRUSTRATED_RE.test(m);
  // 1) 같은 단계에서 이미 2턴 이상 버텼는데 이번 턴도 «모르겠다»
  if(sess && Number(sess.stage_turns || 0) >= 2 && confusedNow) return true;
  try{
    // 2) 오늘의 confused 메시지 수(저장된 것 + 이번 턴)
    const rows = db.prepare(`SELECT content FROM chat_messages
      WHERE user_id=? AND role='user' AND substr(ts,1,10)=?`).all(uid, day);
    let confusedToday = rows.filter(r => FRUSTRATED_RE.test(String(r.content||''))).length;
    if(confusedNow) confusedToday++;
    if(confusedToday >= 3) return true;
    // 3) 직전 메시지 + 이번 턴이 둘 다 짧고(10자 미만) 부정적
    const prevLast = rows.length ? String(rows[rows.length - 1].content || '') : null;
    if(prevLast != null){
      const pair = [m, prevLast];
      if(pair.every(t => t.trim().length < 10 && FRUSTRATED_NEG_RE.test(t))) return true;
    }
  }catch(e){}
  return false;
}

// ★ v1.54 스트리밍 경로가 /api/chat 과 «같은 판단» 을 쓰도록 문맥만 따로 모은다.
// ★ v1.70 ③④: 관심사 비유 도메인(interest)·숙련도 힌트 축소(fade)·좌절 신호(frustrated) 를
//   같은 자리에서 계산해 두 파이프라인이 같은 판단을 쓰게 한다.
function buildChatContext(u, mode, msg, day, style = 'auto'){
  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const profile = profileFor(u.id);
  const topic = currentTopic();
  const moodRow = db.prepare('SELECT mood FROM mood_logs WHERE user_id=? AND day=?').get(u.id, day);
  const moodNote = moodRow && MOODS[moodRow.mood]
    ? `[아이의 오늘 기분] ${MOODS[moodRow.mood].ko} — 말투는 ${MOODS[moodRow.mood].tone}.` : '';
  let cards = mode === 'learn' ? matchCards(msg, topic.chapter).slice(0, 1) : [];

  const focusCard = mode === 'learn'
    ? (cards.find(c =>
        msg.includes(c.topic) ||
        (CARD_ALIASES[c.topic] || []).some(a => a && msg.includes(a)) ||
        String(c.tags||'').split(',').some(t => t.trim() && msg.includes(t.trim()))
      ) || null)
    : null;
  const sess = mode === 'learn' ? getSession(u.id, day, 'learn') : null;
  const baseLevel = sess ? stageLevel(sess.stage) : 1;
  // ★ «힌트 한 단계 더» 버튼 고정 문구 화이트리스트 — 키워드(모르겠/몰라)가 없어도 즉시 한 단계 올린다.
  //   이게 없으면 버튼 첫 클릭에서 wantLevel 이 그대로라 L1 이 그대로 반복됐다.
  const explicitHintUp = /힌트.*한\s*단계\s*더|한\s*단계\s*더\s*(알려|보여|주)/.test(msg);
  const confused = /(모르겠|모르겟|어려워|몰라|이해가 안)/.test(msg) || explicitHintUp;
  const gotIt = /(알겠|이해했|맞았|맞아|다 했|풀었)/.test(msg);
  // ★ v1.70 ④: 좌절 턴은 단계를 올리지 않는다(힌트 에스컬레이션 동결).
  const frustrated = mode === 'learn' ? frustrationOf(u.id, msg, sess, day) : false;
  let wantLevel = baseLevel;
  if(sess && explicitHintUp) wantLevel = Math.min(3, baseLevel + 1);
  if(sess && confused && sess.stage_turns >= 1) wantLevel = Math.min(3, baseLevel + 1);
  if(sess && sess.stage_turns >= 2 && baseLevel < 3) wantLevel = Math.min(3, baseLevel + 1);
  if(frustrated) wantLevel = baseLevel;
  if(frustrated && sess && Number(sess.stage_turns || 0) >= 2) wantLevel = Math.min(3, baseLevel + 1);
  const knownConcept = (focusCard && focusCard.topic) || (sess && sess.concept) || topic.topic;
  const stuckGuess = guessStuckType(msg);
  // ★ v1.70 ③a: 최근 3일 대화에서 관심 도메인을 찾는다(비유에 그 영역을 쓰게 함).
  const interest = mode === 'learn' ? interestDomainOf(u.id) : null;
  // ★ v1.70 ③b: 숙련도 0.75 이상이면 비유·예시를 덧붙이지 않는다(힌트 점점 흐리게).
  const fade = mode === 'learn' && !!focusCard && masteryOf(u.id, focusCard.topic) >= 0.75;
  // ★ v1.78: «모르겠어» 처럼 개념 키워드가 없는 턴은 «이 대화의 개념» 카드로 고정한다.
  //   (키워드 미검출 시 matchCards 가 같은 챕터의 다른 카드를 골라, 반복문 대화에 변수 설명이 섞였다)
  if(mode === 'learn' && sess && sess.concept){
    const cpt = String(sess.concept);
    const hit = msg.includes(cpt) || (CARD_ALIASES[cpt] || []).some(a => msg.includes(String(a)));
    if(!hit){ const fixed = teachCardFor(cpt); if(fixed) cards = [fixed]; }
  }
  // ★ v1.80: 이번 턴이 «설명» 인지 «유도» 인지 먼저 정한다.
  const intent = mode === 'learn' ? routeLearnIntent(msg, sess) : 'chat';
  const direct = mode === 'learn' && (style === 'direct' || (style === 'auto' && intent === 'direct'));
  const cardText = cards.map(c => {
    if(direct) return `- ${c.concept}: ${String(c.analogy || '').trim()} ${String(c.hint_l2 || '').trim()}`.trim();
    if(wantLevel <= 1) return `- ${c.concept}: «${c.hint_l1}» — 이 문장을 그대로 아이에게 물어라. 개념을 설명하지 마라.`;
    if(wantLevel === 2) return fade ? `- ${c.concept}: ${c.hint_l2}` : `- ${c.concept}: ${c.analogy} / 힌트: ${c.hint_l2}`;
    return `- ${c.concept}: ${c.hint_l3}`;
  }).join('\n') || '(없음)';
  // ★ v1.66: 맥락은 세션 «메모» 가 들고 있으므로 원문은 더 줄인다(비용).
  const histLimit = mode === 'learn' ? 0 : 1;   // ★ v1.66: 학습은 세션 메모가 대신한다
  const hist = db.prepare('SELECT role,content FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT ?')
    .all(u.id, histLimit).reverse();
  const sessionMemo = (mode === 'learn' && sess && sess.summary) ? String(sess.summary).slice(0,180) : '';
  const memText = memoryPrompt(retrieveMemories(u.id, msg, 1));
  // ★ v1.71 «루미는 잊어버려» — learn 모드에서 안개 진한 등불(decay≥60) «1개만» 프롬프트에 주입한다.
  //   루미는 스스로 확신 있던 말을 어색하게 하며 다시 가르쳐 달라 한다. 퀴즈 정답은 여전히 절대 말하지 않는다.
  let fogNote = '';
  if(mode === 'learn'){
    const fl = fogHeaviestReadonly(u.id, 60);
    if(fl) fogNote = `[기억 안개] 루미는 «${fl.topic}» 을(를) 많이 잊었다. 이 개념이 나오면 스스로 확신 있던 말을 어색하게 말하고 «어렸을 때 확실했는데…» 하며 아이에게 다시 가르쳐 달라 고할 수 있다(단 퀴즈 정답은 여전히 절대 말하지 않는다).`;
  }
  return { robot, profile, topic, moodNote, cards, focusCard, sess, baseLevel, confused, gotIt,
    wantLevel, knownConcept, stuckGuess, cardText, hist, sessionMemo, memText, fogNote,
    interest, fade, frustrated, intent, direct };
}

// ★ v1.50 «진단 → 계획 → 설명» 의 연결고리.
//   그동안 chat_analyses(막힌 개념)·review_cards(복습 대기)·mood_logs(기분)는 쌓이기만 하고
//   «내일 무엇을 할지» 에 쓰이지 않았다. 여기서 한 번만 모아 계획·첫 화면·리포트가 같이 읽는다.
function stuckTopics(uid, days = 7, limit = 3){
  const since = dayKST(-(days - 1));
  // ★ v1.51: «일상» 같은 넓은 분류보다 «리스트» 같은 개념(topic)을 우선한다.
  return db.prepare(`SELECT COALESCE(NULLIF(topic,''), subject) AS subject, COUNT(*) c, MAX(day) last
    FROM chat_analyses
    WHERE user_id=? AND day>=? AND stuck=1
      AND (COALESCE(topic,'')<>'' OR COALESCE(subject,'')<>'')
      AND COALESCE(NULLIF(topic,''), subject) <> '일상'
    GROUP BY 1 ORDER BY c DESC, last DESC LIMIT ?`).all(uid, since, limit);
}
function dueReviewCount(uid){
  return db.prepare('SELECT COUNT(*) c FROM review_cards WHERE user_id=? AND done=0 AND due_date<=?')
    .get(uid, today()).c;
}
function moodTrend(uid){
  const rows = db.prepare('SELECT mood FROM mood_logs WHERE user_id=? AND day>=? ORDER BY day DESC LIMIT 3')
    .all(uid, dayKST(-2));
  return { today: rows.length ? rows[0].mood : null, lowCount: rows.filter(r => r.mood === 'low').length };
}
function dayLabel(d){
  if(!d) return '';
  if(d === today()) return '오늘';
  if(d === dayKST(-1)) return '어제';
  return String(d).slice(5).replace('-', '/');
}
// «오늘 딱 하나» — 첫 화면은 기능 목록이 아니라 한 걸음이어야 한다.
// ★ v1.70 ①: 2순위 개념을 «최근에 막힌 곳» 에서 «가장 약한 개념» 으로 업그레이드한다.
//   concept_mastery 에 데이터가 있으면 score<0.75 인 가장 약한 개념을 우선하고,
//   마스터리 기록이 전혀 없으면 기존 stuckTopics 로 그대로 폴백한다(결정론 보장).
function nextActionFor(uid){
  const day = today();
  const mood = moodTrend(uid);
  const stuck = stuckTopics(uid, 7, 1)[0];
  // ★ 2026-11-21 (v1.74) A3 ①: 선수개념 미달 개념은 목록 «끝» 으로 밀린 순서에서 고른다(삭제 없음).
  const weak = weakestTopicsOrdered(uid, 12).find(w => (Number(w.score) || 0) < 0.75) || null;
  const focus = weak ? { subject: weak.topic, last: weak.last_day } : (stuck ? { subject: stuck.subject, last: stuck.last } : null);
  const due = dueReviewCount(uid);
  let plan = null;
  const row = db.prepare('SELECT plan_json FROM learning_plans WHERE user_id=? AND day=?').get(uid, day);
  if(row){ try{ plan = JSON.parse(row.plan_json); }catch(e){ plan = null; } }
  const steps = (plan && plan.steps) || [];
  const nextStep = steps.find(s => !s.done);
  // 1) 기분이 이틀 연속 가라앉았으면 학습보다 대화가 먼저다.
  if(mood.lowCount >= 2){
    return { kind:'mood', title:'오늘은 3분만 이야기해 볼까?',
      reason:'요즘 기분이 조금 가라앉아 있었어', cta:'이야기하기', target:'chat' };
  }
  // 1-1) ★ 2026-11-21 (v1.74) A1 «안개의 탑» — 기분 다음, 약한 개념 «전에» 탑을 내민다.
  //   오늘 탑이 아직 끝나지 않았고(tower_ended 0) decay≥30 인 등불이 있으면 그 한 번은 탑 차례다.
  //   프론트 계약: { kind:'tower', fogCount } — 이번 답변은 탑 카드로 대체된다.
  if(dailyCounterOf(uid, day, 'tower_ended') === 0){
    try{
      const { lamps } = lampsFor(uid);
      const fogCount = lamps.filter(l => Number(l.decay) >= 30).length;
      if(fogCount > 0) return { kind:'tower', fogCount };
    }catch(e){}
  }
  // 2) 가장 약한 개념(마스터리) 또는 최근에 막힌 개념이 있으면 그 문제부터.
  if(focus){
    return { kind:'stuck', title:`«${focus.subject}» 한 문제만 같이 풀기`,
      reason: weak ? '지금 제일 약한 개념이야' : `${dayLabel(focus.last)} 여기서 막혔었어`,
      cta:'같이 풀기', target:'learn', concept: focus.subject };
  }
  // 3) 복습 카드가 밀렸으면 복습.
  if(due > 0){
    return { kind:'review', title:`복습 카드 ${due}장`,
      reason:'오늘 넘기면 잊어버리기 쉬워', cta:'복습하기', target:'review', count:due };
  }
  // 4) 계획의 다음 단계.
  if(nextStep){
    return { kind:'plan', title:`오늘 ${steps.indexOf(nextStep)+1}단계 · ${nextStep.title}`,
      reason:'계획대로 한 걸음', cta:'시작하기', target:'plan', stepId:nextStep.id };
  }
  return null;
}
// 보호자에게 «오늘 아이와 무슨 말을 할지» 3문장. 통계보다 이게 실제로 쓰인다.
function parentStarters(uid){
  const out = [];
  const mood = moodTrend(uid);
  if(mood.lowCount >= 2){
    out.push('오늘은 기분이 가라앉아 있었어요. 숙제보다 «오늘 힘든 일 있었어?» 를 먼저 물어봐 주세요.');
  }
  const stuck = stuckTopics(uid, 7, 2);
  for(const s of stuck){
    out.push(`«${s.subject}»에서 막혔다고 해요. «어디가 제일 헷갈렸어?» 하고 물어봐 주세요.`);
    if(out.length >= 2) break;
  }
  let taught = null;
  try{
    taught = db.prepare("SELECT key,value FROM user_memories WHERE user_id=? AND kind='taught' ORDER BY updated_at DESC LIMIT 1").get(uid);
  }catch(e){ taught = null; }
  if(taught){
    const concept = String(taught.key || '').replace(/^taught:/, '').replace(/_/g, ' ');
    out.push(`루미에게 «${concept}» 이야기를 자기 말로 설명했어요. «한 번만 더 들려줄래?» 하고 부탁해 보세요.`);
  }
  // 부족하면 일반 문장으로 채운다 — 보호자 화면은 항상 «3문장» 이어야 쓸모가 있다.
  const fillers = [
    '오늘 아이가 혼자 해결한 문제가 있다면 «어떻게 풀었어?» 하고 물어봐 주세요.',
    '«오늘 루미랑 무슨 이야기 했어?» 로 대화를 시작해 보세요.',
    '오늘 배운 것 중 하나를 골라 «그게 뭐야?» 하고 물어봐 주세요. 아이가 설명하면 그게 가장 좋은 복습이에요.'
  ];
  for(const f of fillers){ if(out.length >= 3) break; out.push(f); }
  return out.slice(0, 3);
}
function planFallback(u, profile, opts){
  const topic = currentTopic();
  const solved = db.prepare("SELECT subject, COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1 GROUP BY subject ORDER BY c DESC LIMIT 3").all(u.id);
  const weak = (profile.weak_topics||'').split(',')[0] || (solved[0] && solved[0].subject) || topic.topic;
  const review = (solved[0] && solved[0].subject) || '변수';
  const total = profile.pref_minutes || 10;
  const m1 = Math.max(1, Math.round(total*0.2));
  const m2 = Math.max(2, Math.round(total*0.5));
  const m3 = Math.max(1, total - m1 - m2);
  const o = opts || {};
  const stuckList = o.stuck || [];
  // ★ v1.70 ①: 1단계 초점은 «가장 약한 개념(마스터리)» 이 1순위, 그다음 «최근에 막힌 개념».
  const focus = (o.weak && o.weak.topic) || (stuckList[0] ? stuckList[0].subject : null);
  // ★ 기분이 가라앉은 날은 «분량을 줄이고 대화부터». 학습량을 채우는 게 목적이 아니다.
  if(o.lowMood){
    return [
      { type:'chat', title:'3분 이야기', desc:'오늘 기분부터 듣기', minutes:3,
        message:'오늘 하루 어땠어? 3분만 이야기해 볼까?' },
      { type:'review', title:`가볍게 복습: ${focus || weak}`, desc:'한 문제만 천천히',
        minutes:Math.max(2, total - 3), message:`${focus || weak} 한 문제만 같이 볼까?` },
    ];
  }
  return [
    focus
      ? { type:'review', title: (o.weak && o.weak.topic) === focus ? `가장 약한 개념: ${focus}` : `${dayLabel(stuckList[0].last)} 막힌 ${focus}`,
          desc: (o.weak && o.weak.topic) === focus ? '가장 약한 개념부터 시작해요' : '막혔던 그 문제부터',
          minutes:m1, message:`${focus}이 아직 헷갈려. 같이 볼까?` }
      : { type:'concept', title:`개념: ${weak}`, desc:'짧은 비유로 이해하기', minutes:m1, message:`${weak}이 뭐야? 쉽게 알려줘.` },
    { type:'puzzle', title:'오늘의 퍼즐 3문제', desc:'4지선다로 확인하기', minutes:m2, message:'' },
    { type:'review', title:`복습: ${review}`, desc:'지난번 배운 개념 1문제', minutes:m3, message:`${review} 기억나? 1문제만 같이 풀어볼까?` },
  ];
}
function normalizePlanSteps(steps){
  // LLM이 영어 type 대신 한국어(개념/퍼즐/복습/게임)를 써도 받아준다.
  const typeMap = { concept:'concept', 개념:'concept', puzzle:'puzzle', 퍼즐:'puzzle',
    review:'review', 복습:'review', game:'game', 게임:'game', chat:'chat', 채팅:'chat' };
  const clean = [];
  for(const s of (Array.isArray(steps) ? steps : [])){
    if(!s) continue;
    const type = typeMap[String(s.type||'').trim().toLowerCase()];
    if(!type) continue;
    const title = String(s.title||'').trim().slice(0,40);
    const desc = String(s.desc||'').trim().slice(0,60);
    const minutes = Math.max(1, Math.min(10, Math.round(Number(s.minutes)||3)));
    if(!title) continue;
    const step = { type, title, desc, minutes };
    if(type === 'puzzle'){ /* message 없음 */ }
    else if(type === 'game'){ step.game = (s.game === 'shooter' ? 'shooter' : 'mole'); }
    else { step.message = String(s.message||title).trim().slice(0,120); }
    clean.push(step);
    if(clean.length >= 4) break;
  }
  return clean;
}
async function generatePlan(u, force){
  const day = today();
  if(!force){
    const row = db.prepare('SELECT plan_json, source FROM learning_plans WHERE user_id=? AND day=?').get(u.id, day);
    if(row){ try{ return { plan: JSON.parse(row.plan_json), source: row.source }; }catch(e){} }
  }
  const profile = profileFor(u.id);
  const topic = currentTopic();
  const solved = db.prepare("SELECT subject, COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1 GROUP BY subject ORDER BY c DESC LIMIT 4").all(u.id);
  const solvedText = solved.map(x=>`${x.subject}(${x.c})`).join(', ') || '(없음)';
  const memTextPlan = memoryPrompt(retrieveMemories(u.id, topic.topic, 8));
  // ★ v1.50: 쌓여만 있던 «막힌 개념·복습 대기·기분» 을 계획의 첫 문장으로 끌어올린다.
  const diag = stuckTopics(u.id, 7, 3);
  // ★ v1.70 ①: 가장 약한 개념(마스터리 최저)을 1단계 초점으로 쓴다(데이터가 있을 때만).
  //   ★ 2026-11-21 (v1.74) A3 ①: 선수개념 미달 개념은 목록 끝으로 밀려 «다음 순서» 로 자연히 넘어간다.
  const weakTop = weakestTopicsOrdered(u.id, 1)[0] || null;
  const due = dueReviewCount(u.id);
  const mood = moodTrend(u.id);
  const lowMood = mood.today === 'low' || mood.lowCount >= 2;
  const diagText = diag.map(x=>`${x.subject}(${x.c}회, 마지막 ${x.last})`).join(', ') || '(없음)';
  const weakText = weakTop ? `${weakTop.topic}(점수 ${Number(weakTop.score).toFixed(2)})` : '(없음)';
  let steps = planFallback(u, profile, { stuck: diag, lowMood, weak: weakTop }), source = 'fallback';
  try{
    const prompt = `너는 초등 저학년도 알아듣는 학습 코치 '루미'다. 아래 학습자 데이터를 보고 오늘의 학습 계획을 만들어라.
- 이번 주 주제: ${topic.topic} (CH.${topic.chapter})
- 레벨: ${u.level||1}, 이해도: ${profile.understanding||0}
- 최근 스스로 해결한 개념: ${solvedText}
- 약점: ${profile.weak_topics||'(없음)'}
- 하루 학습 시간: ${profile.pref_minutes||10}분
- 선호 시간: ${profile.pref_time||'afternoon'}
- 관심 주제: ${profile.pref_subjects||'(없음)'}
- 난이도: ${profile.pref_difficulty||'normal'}
[오늘의 진단 — 반드시 반영]
- 가장 약한 개념(마스터리 최저): ${weakText}
- 최근 7일 막힌 개념: ${diagText}
- 오늘 복습 카드: ${due}장
- 오늘 기분: ${mood.today||'기록 없음'} (최근 3일 low ${mood.lowCount}회)
- 기억:
${memTextPlan}
규칙:
0) 가장 약한 개념이 있으면 **1단계는 그 개념의 review**, 없으면 최근 막힌 개념, 그것도 없으면 concept 로 고정한다. 제목에 그 개념 이름을 넣는다.
${lowMood ? '0-1) 오늘 기분이 가라앉았다. **2단계로 줄이고**, 1단계는 type="chat" «3분 이야기» 로 한다. 분량을 채우지 마라.\n' : ''}1) ${lowMood?'2':'3'}단계, 총 ${lowMood?Math.max(4,Math.round((profile.pref_minutes||10)/2)):(profile.pref_minutes||10)}분 내외.
2) type은 concept / puzzle / review / game / chat 중 하나.
3) concept·review는 message에 아이가 채팅에 그대로 보낼 한 문장(존댓말, 60자 이내).
4) puzzle은 오늘의 퍼즐 3문제.
5) game은 game에 mole 또는 shooter.
6) JSON만 출력: {"steps":[{"type":"concept","title":"...","desc":"...","minutes":2,"message":"..."},...]}
`;
    const pr = await callLLM(prompt, { temperature:0.4, maxTokens:380, json:true });
    const raw = pr ? pr.text : null;
    let j = null;
    try{ j = raw ? JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0]) : null; }catch(e){ j = null; }
    let clean = normalizePlanSteps(j && j.steps);
    if(lowMood) clean = clean.slice(0, 2);
    if(clean.length >= 2){ steps = clean; source = 'ai'; }
    else console.log('⚠️ [plan] LLM plan invalid:', raw ? String(raw).slice(0,180) : '(no response)');
  }catch(e){}
  // 계획이 왜 이렇게 생겼는지 한 줄로 남긴다 — 아이가 «루미가 기억한다» 를 눈으로 본다.
  // ★ v1.70 ①: 마스터리 데이터가 있으면 «가장 약한 개념» 이 1순위, 없으면 기존 «어제 막힌 곳».
  let focus = null;
  if(lowMood){
    focus = { kind:'mood', label:'오늘은 3분만 이야기부터', reason:'기분이 가라앉은 날은 대화가 먼저예요' };
  }else if(weakTop){
    focus = { kind:'stuck', label:`${weakTop.topic} · 가장 약한 개념부터`,
      reason:'가장 약한 개념부터 시작해요' };
  }else if(diag.length){
    focus = { kind:'stuck', label:`${diag[0].subject} · ${dayLabel(diag[0].last)} 막힌 곳`,
      reason:'루미가 어제 막힌 곳을 기억하고 있어요' };
  }else if(due > 0){
    focus = { kind:'review', label:`복습 카드 ${due}장`, reason:'오늘 넘기면 잊어버리기 쉬워요' };
  }
  const plan = { steps: steps.map((s,i)=>({ id:'s'+(i+1), done:false, ...s })), focus };
  db.prepare('INSERT OR REPLACE INTO learning_plans(user_id,day,plan_json,source) VALUES(?,?,?,?)')
    .run(u.id, day, JSON.stringify(plan), source);
  return { plan, source };
}

app.get('/api/plan/today', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const force = !!(req.query && String(req.query.refresh) === '1');
  // ★ refresh 남발 방지: 하루 2회까지만 새로 짜고, 초과하면 저장된 계획을 그대로 돌려준다.
  //   (refresh=1 은 LLM 1회를 태우므로 무한 새로고침으로 LLM 비용이 터지는 것을 막는다)
  if(force){
    const n = bumpDailyCounter(u.id, today(), 'plan_refresh');
    if(n > 2){
      const row = db.prepare('SELECT plan_json, source FROM learning_plans WHERE user_id=? AND day=?').get(u.id, today());
      if(row){
        try{
          const plan = JSON.parse(row.plan_json);
          const done = plan.steps.filter(s=>s.done).length;
          return res.json({ ok:true, plan, source: row.source || 'cached', done,
            allDone: done === plan.steps.length, focus: plan.focus || null, limited:true });
        }catch(e){}
      }
      return res.status(429).json({error:'오늘은 계획 새로 짜기를 다 썼어요. 내일 다시 해 볼래요?'});
    }
  }
  try{
    const { plan, source } = await generatePlan(u, force);
    const done = plan.steps.filter(s=>s.done).length;
    res.json({ ok:true, plan, source, done, allDone: done === plan.steps.length,
      focus: plan.focus || null });
  }catch(e){ res.status(500).json({error:'계획을 만들지 못했어요'}); }
});

// ★ v1.50 «오늘 딱 하나» — 첫 화면은 기능 목록이 아니라 «한 걸음» 이어야 한다.
app.get('/api/next-action', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  try{ res.json({ ok:true, action: nextActionFor(u.id) }); }
  catch(e){ res.status(500).json({error:'다음 할 일을 고르지 못했어요'}); }
});

// ★ v1.52 «절약을 재는 눈금» — 오늘·최근 7일 LLM 토큰 사용량. 계측 없이는 최적화도 없다.
app.get('/api/llm/usage', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const d = today();
  const todayRow = db.prepare(`SELECT COUNT(*) calls,
      COALESCE(SUM(prompt_tokens),0) promptTokens,
      COALESCE(SUM(completion_tokens),0) completionTokens,
      COALESCE(SUM(total_tokens),0) totalTokens,
      COALESCE(SUM(prompt_chars),0) promptChars
    FROM llm_logs WHERE user_id=? AND ts>=? AND ts<?`).get(u.id, d, dayKST(1));
  const week = db.prepare(`SELECT substr(ts,1,10) day, COUNT(*) calls,
      COALESCE(SUM(total_tokens),0) totalTokens
    FROM llm_logs WHERE user_id=? AND ts>=? GROUP BY day ORDER BY day`)
    .all(u.id, dayKST(-6));
  const models = db.prepare(`SELECT model, COUNT(*) calls, COALESCE(SUM(total_tokens),0) totalTokens
    FROM llm_logs WHERE user_id=? GROUP BY model ORDER BY calls DESC`).all(u.id);
  const cooldown = {};
  for(const [name, until] of Object.entries(llmDown)){
    cooldown[name] = Math.max(0, Math.round((until - Date.now())/1000));
  }
  // ★ v1.66: «얼마나 아꼈나» 를 숫자로 — v1.51(원문 재주입) 실측 955토큰/턴을 기준선으로 쓴다.
  const BASELINE_PER_TURN = 955;
  const avgPerTurn = todayRow.calls ? Math.round(todayRow.totalTokens / todayRow.calls) : 0;
  const savedPct = avgPerTurn ? Math.max(0, Math.round((1 - avgPerTurn / BASELINE_PER_TURN) * 100)) : 0;
  const weekTotal = week.reduce((a, r) => a + (r.totalTokens || 0), 0);
  res.json({ ok:true, today: todayRow, week, models, cooldown,
    avgPerTurn, baselinePerTurn: BASELINE_PER_TURN, savedPct, weekTotal,
    primaryConfigured: PRIMARY_READY, forceFast: LLM_FORCE_FAST, lastModel: lastLLMModel });
});

app.post('/api/plan/step', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const { stepId, done } = req.body || {};
  const row = db.prepare('SELECT plan_json, source FROM learning_plans WHERE user_id=? AND day=?').get(u.id, today());
  if(!row) return res.status(400).json({error:'오늘의 계획이 없어요'});
  let plan; try{ plan = JSON.parse(row.plan_json); }catch(e){ return res.status(400).json({error:'계획을 읽지 못했어요'}); }
  const step = plan.steps.find(s=>s.id === stepId);
  if(!step) return res.status(400).json({error:'그 단계를 찾을 수 없어요'});
  step.done = !!done;
  db.prepare('UPDATE learning_plans SET plan_json=? WHERE user_id=? AND day=?')
    .run(JSON.stringify(plan), u.id, today());
  const doneCount = plan.steps.filter(s=>s.done).length;
  const allDone = doneCount === plan.steps.length;
  let reward = 0;
  if(allDone){
    try{
      db.prepare("INSERT INTO game_logs(user_id,day,kind,score,reward) VALUES(?,?,?,?,?)")
        .run(u.id, today(), 'plan', 1, 10);
      grantCell(u.id, 10, 'plan');
      addExp(u.id, 10);
      reward = 10;
    }catch(e){ /* 이미 보상 받음 */ }
  }
  res.json({ ok:true, plan, source:row.source, done:doneCount, allDone, reward,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- 학습 선호 + 주간 목표 (2026-10-28) ----
const PREF_TIMES = new Set(['morning','afternoon','evening']);
const PREF_DIFFS = new Set(['easy','normal','hard']);
app.get('/api/prefs', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const p = profileFor(u.id);
  res.json({ ok:true, minutes:p.pref_minutes||10, time:p.pref_time||'afternoon',
             subjects:(p.pref_subjects||'').split(',').filter(Boolean),
             difficulty:p.pref_difficulty||'normal' });
});
app.post('/api/prefs', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const minutes = Math.max(5, Math.min(20, Math.round(Number(b.minutes)||10)));
  const time = PREF_TIMES.has(String(b.time)) ? String(b.time) : 'afternoon';
  const subjects = Array.isArray(b.subjects)
    ? b.subjects.slice(0,5).map(x=>String(x).slice(0,12)).join(',') : '';
  const difficulty = PREF_DIFFS.has(String(b.difficulty)) ? String(b.difficulty) : 'normal';
  profileFor(u.id);
  db.prepare('UPDATE learner_profile SET pref_minutes=?, pref_time=?, pref_subjects=?, pref_difficulty=? WHERE user_id=?')
    .run(minutes, time, subjects, difficulty, u.id);
  // 선호가 바뀌면 오늘 계획과 이번 주 목표는 새로 짜게 한다.
  db.prepare('DELETE FROM learning_plans WHERE user_id=? AND day=?').run(u.id, today());
  db.prepare('DELETE FROM weekly_goals WHERE user_id=? AND week_start=?').run(u.id, weekStartKST());
  res.json({ ok:true, minutes, time, subjects:subjects.split(',').filter(Boolean), difficulty });
});

function goalFallback(profile){
  const min = profile.pref_minutes || 10;
  const base = min >= 15 ? 4 : min <= 5 ? 2 : 3;
  return [
    { type:'concept', title:`개념 ${base}개 이해하기`, target:base, unit:'개' },
    { type:'puzzle', title:'퍼즐 2회 풀기', target:2, unit:'회' },
    { type:'solve', title:`스스로 해결 ${base}개`, target:base, unit:'개' },
  ];
}
function normalizeGoals(goals){
  const allowed = new Set(['concept','puzzle','solve','game','plan']);
  const out = [];
  for(const g of (Array.isArray(goals) ? goals : [])){
    if(!g || !allowed.has(String(g.type))) continue;
    const title = String(g.title||'').trim().slice(0,40);
    const target = Math.max(1, Math.min(10, Math.round(Number(g.target)||3)));
    const unit = String(g.unit||'개').trim().slice(0,2);
    if(!title) continue;
    out.push({ type:String(g.type), title, target, unit });
    if(out.length >= 4) break;
  }
  return out;
}
async function generateGoals(u, profile){
  const week = weekStartKST();
  const row = db.prepare('SELECT goals_json, source FROM weekly_goals WHERE user_id=? AND week_start=?').get(u.id, week);
  if(row){ try{ return { goals:JSON.parse(row.goals_json), source:row.source, week }; }catch(e){} }
  let goals = goalFallback(profile), source = 'auto';
  try{
    const memTextGoal = memoryPrompt(retrieveMemories(u.id, '주간 목표', 8));
    const prompt = `너는 초등 저학년도 알아듣는 학습 코치 '루미'다. 이번 주 3개 목표를 JSON으로만 만들어라.
- 레벨: ${u.level||1}, 이해도: ${profile.understanding||0}
- 하루 학습 시간: ${profile.pref_minutes||10}분
- 관심 주제: ${profile.pref_subjects||'(없음)'}
- 난이도: ${profile.pref_difficulty||'normal'}
- 기억:
${memTextGoal}
규칙:
1) type은 concept / puzzle / solve / game / plan 중 하나.
2) target은 1~10 정수, unit은 개/회.
3) 아이가 이해할 쉬운 한국어.
4) JSON만: {"goals":[{"type":"concept","title":"...","target":3,"unit":"개"},...]}
`;
    const gr = await callLLM(prompt, { temperature:0.4, maxTokens:260, json:true });
    const raw = gr ? gr.text : null;
    let j = null;
    try{ j = raw ? JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0]) : null; }catch(e){}
    const clean = normalizeGoals(j && j.goals);
    if(clean.length >= 2){ goals = clean; source = 'ai'; }
  }catch(e){}
  db.prepare('INSERT OR REPLACE INTO weekly_goals(user_id,week_start,goals_json,source) VALUES(?,?,?,?)')
    .run(u.id, week, JSON.stringify(goals), source);
  return { goals, source, week };
}
function goalProgress(u, week){
  const q = (sql)=>db.prepare(sql).get(u.id, week).c;
  return {
    concept: q("SELECT COUNT(DISTINCT subject) c FROM learning_help_logs WHERE user_id=? AND solved=1 AND day>=?"),
    puzzle: q("SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND kind='puzzle' AND day>=?"),
    solve: q("SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1 AND day>=?"),
    game: q("SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND kind IN ('mole','shooter') AND day>=?"),
    plan: q("SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND kind='plan' AND day>=?"),
  };
}
app.get('/api/goals/week', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const p = profileFor(u.id);
  const { goals, source, week } = await generateGoals(u, p);
  const prog = goalProgress(u, week);
  const out = goals.map((g,i)=>({ ...g, id:'g'+(i+1),
    progress: Math.min(g.target, prog[g.type]||0),
    done: (prog[g.type]||0) >= g.target }));
  const claimed = !!db.prepare('SELECT 1 FROM goal_claims WHERE user_id=? AND week_start=?').get(u.id, week);
  res.json({ ok:true, week, goals:out, source, claimed,
             done:out.filter(g=>g.done).length, allDone:out.every(g=>g.done) });
});
app.post('/api/goals/claim', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const p = profileFor(u.id);
  const { goals, week } = await generateGoals(u, p);
  const prog = goalProgress(u, week);
  const allDone = goals.every(g => (prog[g.type]||0) >= g.target);
  if(!allDone) return res.status(400).json({error:'아직 목표를 다 채우지 못했어요'});
  const existing = db.prepare('SELECT 1 FROM goal_claims WHERE user_id=? AND week_start=?').get(u.id, week);
  if(existing){
    return res.json({ ok:true, already:true, reward:0,
      balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }
  db.prepare('INSERT INTO goal_claims(user_id,week_start,reward) VALUES(?,?,?)').run(u.id, week, 30);
  grantCell(u.id, 30, 'weekly_goal');
  res.json({ ok:true, reward:30,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- AI 전용 기억 API (2026-10-31) ----
app.get('/api/memory', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const memories = listMemories(u.id);
  res.json({ ok:true, count:memories.length, memories });
});
app.post('/api/memory', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const kind = MEMORY_KINDS.has(String(b.kind)) ? String(b.kind) : 'fact';
  const key = String(b.key || `manual_${Date.now()}`).slice(0,40);
  const value = memorySafe(b.value);
  if(!value) return res.status(400).json({error:'기억할 내용을 짧게 적어 주세요'});
  upsertMemory(u.id, { kind, key, value, confidence:Number(b.confidence)||0.8, source:'manual' });
  res.json({ ok:true, memories:listMemories(u.id) });
});
app.delete('/api/memory/:id', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number(req.params.id)||0;
  db.prepare('DELETE FROM user_memories WHERE id=? AND user_id=?').run(id, u.id);
  res.json({ ok:true, memories:listMemories(u.id) });
});
app.delete('/api/memory', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const r = db.prepare('DELETE FROM user_memories WHERE user_id=?').run(u.id);
  res.json({ ok:true, removed:r.changes, memories:[] });
});

// ---- 친구 시스템 (2026-10-29) ----
function friendCodeFor(u){
  if(u.friend_code) return u.friend_code;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do{
    code = Array.from({length:6}, ()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  } while(db.prepare('SELECT id FROM users WHERE friend_code=?').get(code));
  db.prepare('UPDATE users SET friend_code=? WHERE id=?').run(code, u.id);
  return code;
}
function friendshipBetween(a,b){
  return db.prepare('SELECT * FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)').get(a,b,b,a);
}
function parsePalette(p){ try{ return p ? JSON.parse(p) : {}; }catch(e){ return {}; } }

// ★ v1.37 대세계 «의뢰» — 세계를 미니게임의 «이유» 로 만든다.
//   조건은 기존 보상 기준과 맞춰 «따로 연습하지 않아도» 도전할 수 있게 잡았다.
//   보상은 15셀(설계 §9: 20 → 15, 하루 수입 330 → 375로 억제).
const WORLD_QUESTS = [
  { key:'well', prop:'well',      kind:'mole',    label:'우물',
    cond:{ score:300 },              text:'우물이 버그로 막혔어. 두더지 300점을 넘겨 봐!' },
  { key:'mill', prop:'mill',      kind:'shooter', label:'풍차',
    cond:{ score:800, lives:1 },     text:'풍차 날개가 멈췄어. 목숨 1개 이상 남기고 800점!' },
  { key:'bell', prop:'belltower', kind:'puzzle',  label:'종탑',
    cond:{ firstTry:3 },             text:'종탑이 잠들었어. 퍼즐 3문제를 한 번에 맞혀 봐!' }
];
const WORLD_QUEST_REWARD = 15;

function worldQuestState(uid, day){
  const rows = db.prepare('SELECT quest,done,reward FROM world_quests WHERE user_id=? AND day=?').all(uid, day);
  const done = new Set(rows.filter(r=>r.done && r.quest !== '__skip__').map(r=>r.quest));
  const skipReady = rows.some(r=>r.quest === '__skip__');
  const stars = db.prepare('SELECT COUNT(*) c FROM world_stars WHERE user_id=? AND day=?').get(uid, day).c;
  // ★ 오늘 이미 주운 빛 조각 인덱스(0..2) — 재입장 시 클라이언트가 별을 되살리지 않도록 복원용으로 내려준다.
  const starsCollected = db.prepare('SELECT star FROM world_stars WHERE user_id=? AND day=? ORDER BY star').all(uid, day)
    .map(r=>Number(r.star)).filter(n=>Number.isInteger(n) && n >= 0);
  return { done, skipReady, stars, starsCollected };
}

app.get('/api/world/quest', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const st = worldQuestState(u.id, day);
  res.json({ ok:true, day, reward: WORLD_QUEST_REWARD, skipReady: st.skipReady, stars: st.stars,
    stars_collected: st.starsCollected,
    quests: WORLD_QUESTS.map(q=>({ key:q.key, prop:q.prop, kind:q.kind, label:q.label,
      text:q.text, cond:q.cond, done: st.done.has(q.key) })) });
});

app.post('/api/world/quest/claim', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const key = String(b.quest || '');
  const def = WORLD_QUESTS.find(q=>q.key === key);
  if(!def) return res.status(400).json({error:'그런 의뢰는 없어요'});
  const day = today();
  const already = db.prepare('SELECT done FROM world_quests WHERE user_id=? AND day=? AND quest=?').get(u.id, day, key);
  if(already && already.done){
    return res.json({ ok:true, already:true, reward:0,
      balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }
  // 조건 판정 (신뢰 수준은 기존 /api/game/result 와 동일 — §3-3)
  const score = Number(b.score) || 0;
  const lives = Number(b.lives) || 0;
  const firstTry = Number(b.firstTry) || 0;
  const need = [];
  if(def.cond.score && score < def.cond.score) need.push('score>=' + def.cond.score);
  if(def.cond.lives && lives < def.cond.lives) need.push('lives>=' + def.cond.lives);
  if(def.cond.firstTry && firstTry < def.cond.firstTry) need.push('firstTry>=' + def.cond.firstTry);
  if(need.length) return res.json({ ok:false, need: need.join(' & ') });

  try{
    db.prepare(`INSERT INTO world_quests(user_id,day,quest,done,reward) VALUES(?,?,?,1,?)
      ON CONFLICT(user_id,day,quest) DO UPDATE SET done=1, reward=excluded.reward`)
      .run(u.id, day, key, WORLD_QUEST_REWARD);
  }catch(e){ }
  grantCell(u.id, WORLD_QUEST_REWARD, 'world_quest');
  // 영구 흔적 — 다음 날에도 «고쳐진 우물» 이 그대로다 (P2)
  try{ db.prepare('INSERT OR IGNORE INTO village_props(user_id, prop_key) VALUES(?,?)')
    .run(u.id, 'relic_' + key); }catch(e){ }
  res.json({ ok:true, reward: WORLD_QUEST_REWARD, relic:'relic_' + key,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

app.post('/api/world/quest/skip', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const has = db.prepare("SELECT 1 FROM world_quests WHERE user_id=? AND day=? AND quest='__skip__'").get(u.id, day);
  if(!has) return res.json({ ok:false, need:'skip' });
  const key = String((req.body||{}).quest || '');
  const def = WORLD_QUESTS.find(q=>q.key === key);
  if(!def) return res.status(400).json({error:'그런 의뢰는 없어요'});
  // 소모 = DELETE (하루 1장, 재사용 불가)
  db.prepare("DELETE FROM world_quests WHERE user_id=? AND day=? AND quest='__skip__'").run(u.id, day);
  db.prepare(`INSERT INTO world_quests(user_id,day,quest,done,reward) VALUES(?,?,?,1,0)
    ON CONFLICT(user_id,day,quest) DO UPDATE SET done=1, reward=0`).run(u.id, day, key);
  try{ db.prepare('INSERT OR IGNORE INTO village_props(user_id, prop_key) VALUES(?,?)')
    .run(u.id, 'relic_' + key); }catch(e){ }
  res.json({ ok:true, reward:0, relic:'relic_' + key,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

app.post('/api/world/star', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const star = Number((req.body||{}).star);
  if(!(star >= 0 && star <= 2)) return res.status(400).json({error:'별 번호가 이상해요'});
  const day = today();
  const exists = db.prepare('SELECT 1 FROM world_stars WHERE user_id=? AND day=? AND star=?').get(u.id, day, star);
  if(!exists){
    try{ db.prepare('INSERT INTO world_stars(user_id,day,star) VALUES(?,?,?)').run(u.id, day, star); }catch(e){ }
  }
  const count = db.prepare('SELECT COUNT(*) c FROM world_stars WHERE user_id=? AND day=?').get(u.id, day).c;
  if(count >= 3){
    try{ db.prepare("INSERT OR IGNORE INTO world_quests(user_id,day,quest,done,reward) VALUES(?,?,'__skip__',0,0)").run(u.id, day); }catch(e){ }
  }
  res.json({ ok:true, already: !!exists, count, skipReady: count >= 3 });
});

// ★ v1.38 이스터에그 «마을 끝의 낡은 이정표».
//   조건도 알림도 없다. 길이 끊기는 자리에 서 있을 뿐이고, 걸어온 아이만 읽는다.
//   처음 읽은 계정에만 20셀 — «발견» 자체를 기억에 남기기 위한 최소한의 보상.
const WORLD_SECRETS = {
  maker: { reward: 20 }
};
app.post('/api/world/secret', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const key = String((req.body||{}).key || '');
  const def = WORLD_SECRETS[key];
  if(!def) return res.status(400).json({error:'그런 글은 없어요'});
  const already = db.prepare('SELECT 1 FROM world_secrets WHERE user_id=? AND key=?').get(u.id, key);
  if(already){
    return res.json({ ok:true, first:false, reward:0,
      balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }
  try{ db.prepare('INSERT INTO world_secrets(user_id,key) VALUES(?,?)').run(u.id, key); }catch(e){ }
  grantCell(u.id, def.reward, 'world_secret');
  res.json({ ok:true, first:true, reward:def.reward,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ★ v1.35 AI 마을 «같이 놀기» — 친구가 같은 마을에 있으면 서로 보인다.
//   실시간 소켓 대신 1.6초 폴링 + 45초 TTL. 아이들 놀이엔 충분하고 배포가 단순하다.
//   위치는 «서로 친구(accepted)» 인 사람에게만 돌려준다 — 모르는 사람에게 좌표를 노출하지 않는다.
const PRESENCE_TTL = 45;
function presenceNow(){ return Math.floor(Date.now() / 1000); }

// 위치 보고와 «지금 마을에 있는 친구» 조회를 한 번에(왕복 1회).
app.post('/api/world/presence', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const x = Math.max(-140, Math.min(140, Number(b.x) || 0));
  const z = Math.max(-140, Math.min(140, Number(b.z) || 0));
  const ry = Math.max(-7, Math.min(7, Number(b.ry) || 0));
  const anim = String(b.anim || 'Idle').replace(/[^A-Za-z]/g, '').slice(0, 10) || 'Idle';
  const now = presenceNow();
  db.prepare(`INSERT INTO world_presence(user_id,x,z,ry,anim,ts) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      x=excluded.x, z=excluded.z, ry=excluded.ry, anim=excluded.anim, ts=excluded.ts`)
    .run(u.id, x, z, ry, anim, now);
  const rows = db.prepare(`SELECT p.user_id, p.x, p.z, p.ry, p.anim,
      u.nickname, u.level, r.template, r.palette
    FROM world_presence p
    JOIN friendships f ON f.status='accepted' AND
      ((f.user_a=? AND f.user_b=p.user_id) OR (f.user_b=? AND f.user_a=p.user_id))
    JOIN users u ON u.id=p.user_id
    LEFT JOIN robots r ON r.user_id=p.user_id
    WHERE p.ts > ?
    ORDER BY u.nickname`).all(u.id, u.id, now - PRESENCE_TTL);
  res.json({ ok:true, ttl:PRESENCE_TTL,
    peers: rows.map(r=>({ uid:r.user_id, nickname:r.nickname, level:r.level||1,
      x:r.x, z:r.z, ry:r.ry, anim:r.anim,
      robot:{ template:r.template||'doro', palette:parsePalette(r.palette) } })) });
});

app.post('/api/world/leave', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  db.prepare('DELETE FROM world_presence WHERE user_id=?').run(u.id);
  res.json({ ok:true });
});

// 친구에게 «손 흔들기» — 대화 기록(friend_messages)에 남겨 친구 시스템과 실제로 이어진다.
app.post('/api/world/wave', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const to = Number((req.body || {}).to || 0);
  if(!to || to === u.id) return res.status(400).json({error:'누구에게 인사할까요?'});
  const isFriend = db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND
    ((user_a=? AND user_b=?) OR (user_a=? AND user_b=?))`).get(u.id, to, to, u.id);
  if(!isFriend) return res.status(403).json({error:'친구에게만 인사할 수 있어요'});
  // 도배 방지: 같은 친구에게 5분에 한 번
  const recent = db.prepare(`SELECT 1 FROM friend_messages
    WHERE from_user=? AND to_user=? AND body LIKE '👋%'
      AND created_at > datetime('now','+9 hours','-5 minutes')`).get(u.id, to);
  if(recent) return res.json({ ok:true, throttled:true });
  db.prepare('INSERT INTO friend_messages(from_user,to_user,body) VALUES(?,?,?)')
    .run(u.id, to, '👋 AI 마을에서 만났어요! 같이 놀아요~');
  res.json({ ok:true });
});

app.get('/api/friends', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const code = friendCodeFor(u);
  const friends = db.prepare(`SELECT f.id friendship_id, u.id, u.nickname, u.level, u.streak, r.template, r.palette
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END
    LEFT JOIN robots r ON r.user_id = u.id
    WHERE (f.user_a=? OR f.user_b=?) AND f.status='accepted'
    ORDER BY u.nickname`).all(u.id,u.id,u.id);
  const requests = db.prepare(`SELECT f.id, u.nickname, u.level FROM friendships f
    JOIN users u ON u.id=f.user_a WHERE f.user_b=? AND f.status='pending' ORDER BY f.id DESC`).all(u.id);
  const cheered = new Set(db.prepare('SELECT to_user FROM cheers WHERE from_user=? AND day=?').all(u.id, today()).map(x=>x.to_user));
  const unreadRows = db.prepare("SELECT from_user, COUNT(*) c FROM friend_messages WHERE to_user=? AND read_at IS NULL GROUP BY from_user").all(u.id);
  const unreadMap = Object.fromEntries(unreadRows.map(x=>[x.from_user, x.c]));
  const prof = profileFor(u.id);
  const chatEnabled = !!(prof.friend_chat_enabled === undefined ? 1 : prof.friend_chat_enabled);
  // ★ v1.35 «지금 마을에 있음» 표시 — 친구 목록과 대세계가 같은 데이터를 본다
  const onlineIds = new Set(db.prepare('SELECT user_id FROM world_presence WHERE ts > ?')
    .all(presenceNow() - PRESENCE_TTL).map(r=>r.user_id));
  res.json({ ok:true, code, chatEnabled, requests,
    friends: friends.map(f=>({ id:f.id, friendshipId:f.friendship_id, nickname:f.nickname,
      level:f.level||1, streak:f.streak||0,
      robot:{ template:f.template||'doro', palette:parsePalette(f.palette) },
      inWorld: onlineIds.has(f.id),
      cheeredToday: cheered.has(f.id), unread: unreadMap[f.id]||0 })) });
});

app.post('/api/friends/request', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const code = String((req.body||{}).code||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({error:'6자리 친구 코드를 확인해 주세요'});
  const target = db.prepare('SELECT * FROM users WHERE friend_code=?').get(code);
  if(!target || target.id === u.id) return res.status(400).json({error:'코드를 확인해 주세요'});
  const blocked = db.prepare('SELECT 1 FROM friend_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)')
    .get(u.id, target.id, target.id, u.id);
  if(blocked) return res.status(400).json({error:'친구를 맺을 수 없어요'});
  const ex = friendshipBetween(u.id, target.id);
  if(ex){
    if(ex.status === 'accepted') return res.status(400).json({error:'이미 친구예요'});
    if(ex.user_a === target.id && ex.user_b === u.id){
      db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(ex.id);
      return res.json({ ok:true, auto:true, nickname:target.nickname });
    }
    return res.status(400).json({error:'이미 요청을 보냈어요'});
  }
  const count = db.prepare("SELECT COUNT(*) c FROM friendships WHERE (user_a=? OR user_b=?) AND status='accepted'").get(u.id,u.id).c;
  if(count >= 20) return res.status(400).json({error:'친구는 최대 20명까지 만들 수 있어요'});
  db.prepare("INSERT INTO friendships(user_a,user_b,status) VALUES(?,?, 'pending')").run(u.id, target.id);
  res.json({ ok:true, nickname:target.nickname });
});

app.post('/api/friends/accept', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number((req.body||{}).id)||0;
  const f = db.prepare("SELECT * FROM friendships WHERE id=? AND user_b=? AND status='pending'").get(id, u.id);
  if(!f) return res.status(400).json({error:'요청을 찾을 수 없어요'});
  db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(id);
  const other = db.prepare('SELECT nickname FROM users WHERE id=?').get(f.user_a);
  res.json({ ok:true, nickname: other ? other.nickname : '' });
});

app.post('/api/friends/decline', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number((req.body||{}).id)||0;
  db.prepare("DELETE FROM friendships WHERE id=? AND user_b=? AND status='pending'").run(id, u.id);
  res.json({ ok:true });
});

app.post('/api/friends/remove', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number((req.body||{}).id)||0;
  db.prepare("DELETE FROM friendships WHERE id=? AND (user_a=? OR user_b=?)").run(id, u.id, u.id);
  res.json({ ok:true });
});

app.post('/api/friends/cheer', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number((req.body||{}).id)||0;
  const f = db.prepare("SELECT * FROM friendships WHERE id=? AND status='accepted' AND (user_a=? OR user_b=?)").get(id, u.id, u.id);
  if(!f) return res.status(400).json({error:'친구를 찾을 수 없어요'});
  const target = f.user_a === u.id ? f.user_b : f.user_a;
  try{
    db.prepare('INSERT INTO cheers(from_user,to_user,day) VALUES(?,?,?)').run(u.id, target, today());
  }catch(e){ return res.status(400).json({error:'오늘은 이미 응원했어요'}); }
  const t = db.prepare('SELECT nickname FROM users WHERE id=?').get(target);
  sendMail(target, { title:'💌 친구가 응원했어요!', body:`${u.nickname}님이 오늘도 화이팅이라고 응원했어요.`, cell:0, tag:`friend:cheer:${u.id}:${today()}` });
  res.json({ ok:true, nickname: t ? t.nickname : '' });
});

function hasContactInfo(s){
  const t = String(s||'');
  return /(https?:\/\/|www\.)/i.test(t)
    || /[\w.+-]+@[\w-]+\.[\w.]+/.test(t)
    || /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/.test(t)
    || /\b\d{6,}\b/.test(t);
}
app.post('/api/friends/block', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const fid = Number((req.body||{}).friendId)||0;
  const f = friendshipBetween(u.id, fid);
  if(!f) return res.status(400).json({error:'친구를 찾을 수 없어요'});
  db.prepare('DELETE FROM friendships WHERE id=?').run(f.id);
  db.prepare('DELETE FROM friend_messages WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)')
    .run(u.id, fid, fid, u.id);
  db.prepare('DELETE FROM cheers WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)')
    .run(u.id, fid, fid, u.id);
  try{ db.prepare('INSERT OR IGNORE INTO friend_blocks(user_id,blocked_id) VALUES(?,?)').run(u.id, fid); }catch(e){}
  res.json({ ok:true });
});
app.post('/api/friends/report', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const fid = Number(b.friendId)||0;
  const f = friendshipBetween(u.id, fid);
  if(!f || f.status !== 'accepted') return res.status(400).json({error:'친구만 신고할 수 있어요'});
  const reason = String(b.reason||'불편한 말/행동').trim().slice(0,200);
  const count = db.prepare("SELECT COUNT(*) c FROM friend_reports WHERE reporter_id=? AND target_id=? AND substr(created_at,1,10)=?").get(u.id, fid, today()).c;
  if(count >= 3) return res.status(429).json({error:'오늘은 이미 신고했어요'});
  db.prepare('INSERT INTO friend_reports(reporter_id,target_id,reason) VALUES(?,?,?)').run(u.id, fid, reason);
  res.json({ ok:true });
});
app.get('/api/friends/chat', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  if(profileFor(u.id).friend_chat_enabled === 0) return res.status(403).json({error:'보호자가 친구 채팅을 꺼 두었어요'});
  const fid = Number(req.query.friendId)||0;
  const f = friendshipBetween(u.id, fid);
  if(!f || f.status !== 'accepted') return res.status(400).json({error:'친구만 대화할 수 있어요'});
  const rows = db.prepare(`SELECT id,from_user,to_user,body,created_at,read_at FROM friend_messages
    WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)
    ORDER BY id DESC LIMIT 50`).all(u.id, fid, fid, u.id).reverse();
  db.prepare("UPDATE friend_messages SET read_at=datetime('now','+9 hours') WHERE from_user=? AND to_user=? AND read_at IS NULL").run(fid, u.id);
  const fr = db.prepare('SELECT id,nickname,level,streak FROM users WHERE id=?').get(fid);
  const robot = db.prepare('SELECT template,palette FROM robots WHERE user_id=?').get(fid);
  res.json({ ok:true,
    friend:{ id:fid, nickname:fr?fr.nickname:'', level:fr?fr.level:1, streak:fr?fr.streak:0,
      robot:{ template:robot?robot.template:'doro', palette:parsePalette(robot && robot.palette) } },
    messages: rows });
});
app.post('/api/friends/chat', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  if(profileFor(u.id).friend_chat_enabled === 0) return res.status(403).json({error:'보호자가 친구 채팅을 꺼 두었어요'});
  const b = req.body || {};
  const fid = Number(b.friendId)||0;
  const msg = String(b.message||'').trim().slice(0,200);
  if(!msg) return res.status(400).json({error:'메시지를 적어 주세요'});
  if(!isSafeText(msg) || hasContactInfo(msg))
    return res.status(400).json({error:'예의를 지키고 개인정보/링크는 보내지 마세요'});
  const f = friendshipBetween(u.id, fid);
  if(!f || f.status !== 'accepted') return res.status(400).json({error:'친구만 대화할 수 있어요'});
  const sent = db.prepare("SELECT COUNT(*) c FROM friend_messages WHERE from_user=? AND substr(created_at,1,10)=?").get(u.id, today()).c;
  if(sent >= 30) return res.status(429).json({error:'오늘은 친구에게 30번까지 보낼 수 있어요'});
  const r = db.prepare('INSERT INTO friend_messages(from_user,to_user,body) VALUES(?,?,?)').run(u.id, fid, msg);
  // ★ 새 메시지는 우편함 배지로도 알린다(하루 1건, tag 로 중복 방지)
  sendMail(fid, { title:'💬 친구에게 새 메시지', body:`${u.nickname}님이 메시지를 보냈어요. 확인해 볼래?`,
                  cell:0, tag:`friend:chat:${u.id}:${today()}` });
  res.json({ ok:true, id:r.lastInsertRowid });
});

// ---- 대화: 3 모드 + 최근 6턴 + JSON + 안전 ----
// ────────────────────────── v1.40 대화 분석 엔진 ──────────────────────────
//  설계 원칙: 아이의 대화를 «LLM 에 다시 보내 평가» 하지 않는다.
//  ① 결정적 규칙이라 같은 입력은 항상 같은 결과(재현 가능 · 시험 가능) ② 지연 0 · 비용 0
//  ③ 원문은 chat_messages, 판정은 chat_analyses 로 분리해 나중에 규칙을 바꿔도 원문이 보존된다.
const CA_SUBJECT_RULES = [
  ['수학', /(수학|분수|더하기|빼기|곱하기|나누기|계산|숫자|도형|구구단|소수|통분)/],
  ['코딩', /(코딩|코드|변수|반복문|조건문|버그|프로그래|알고리즘|명령어|순서|리스트|배열|인덱스|문자열|함수|매개변수|출력|입력|이벤트)/],
  ['과학', /(과학|실험|중력|빛|소리|동물|식물|우주|날씨|기계|전기)/],
  ['언어', /(읽기|문장|영어|한글|단어|쓰기|독서|발표|맞춤법|이야기)/],
  ['로봇·마을', /(로봇|루미|부품|공작소|마을|미니게임|셀|별빛|의뢰)/]
];
const CA_INTENT_RULES = [
  ['인사', /(안녕|하이|반가|잘 지냈|오랜만|안녕하세요)/],
  ['힌트 요청', /(힌트|알려\s*줘|도와\s*줘|가르쳐|어떻게 해|정답|답이)/],
  ['마음 표현', /(기분|좋아|신나|속상|힘들|무서|슬프|화나|재밌|고마워|사랑)/],
  ['복습', /(다시|또|복습|어제|지난번|아까|전에)/],
  ['질문', /(\?|뭐|왜|어떻게|언제|누가|어디|무슨)/]
];
const CA_STUCK_RE = /(모르겠|어렵|힘들|틀렸|막혔|안\s*돼|이해가\s*안|헷갈|실수|못\s*하겠|포기)/;
const CA_LOW_RE = /(힘들|어렵|속상|슬프|화나|무서|모르겠|포기|싫|지루)/;
const CA_BRIGHT_RE = /(좋|신나|재밌|고마워|해냈|알겠|최고|멋져|와우|풀었)/;
const CA_HINT_RE = /(힌트|생각해|먼저|순서|예를 들어|해 볼래|찾아봐|바꿔\s*봐)/;
const CA_PRAISE_RE = /(잘했|멋져|훌륭|대단|정확|맞았|칭찬|해냈|대단해)/;
const CA_KEY_RE = /(수학|분수|더하기|계산|코딩|코드|변수|반복|버그|과학|실험|동물|우주|읽기|영어|로봇|루미|공작소|게임|셀|별빛|친구|문제|힌트|숙제)/g;

function analyzeChatText(msg, reply, mode, opts){
  const o = opts || {};
  const m = String(msg || ''), r = String(reply || '');
  const subject = (CA_SUBJECT_RULES.find(([, re]) => re.test(m)) || [null])[0] || '일상';
  const intent = (CA_INTENT_RULES.find(([, re]) => re.test(m)) || [null])[0] || '이야기';
  let sentiment = '보통';
  if(CA_LOW_RE.test(m)) sentiment = '힘듦';
  else if(CA_BRIGHT_RE.test(m)) sentiment = '밝음';
  const keys = [];
  let mk;
  CA_KEY_RE.lastIndex = 0;
  while((mk = CA_KEY_RE.exec(m)) !== null && keys.length < 5){
    if(!keys.includes(mk[0])) keys.push(mk[0]);
  }
  return {
    topic: o.topic || null,
    subject, intent, sentiment,
    stuck: CA_STUCK_RE.test(m) ? 1 : 0,
    hint_level: o.hintLevel == null ? null : Number(o.hintLevel),
    solved: o.solved ? 1 : 0,
    // ★ word_count 는 이름과 달리 «단어 수» 가 아니라 공백을 정리한 뒤의 «문자 수» 다.
    //   (통계·화면 호환을 위해 컬럼 이름은 그대로 둔다)
    word_count: m.replace(/\s+/g, ' ').trim().length,
    question_count: (m.match(/\?/g) || []).length,
    reply_len: r.length,
    reply_has_hint: CA_HINT_RE.test(r) ? 1 : 0,
    reply_has_praise: CA_PRAISE_RE.test(r) ? 1 : 0,
    keywords: keys.join(',')
  };
}

// chat_analyses 1행 + chat_reports 재집계. «+1 누적» 이 아니라 현재 분석행을 다시 세므로
// 재분석(rebuild) 을 몇 번 돌려도 숫자가 불어나지 않는다(멱등).
function recordChatAnalysis(uid, userMsgId, aiMsgId, msg, reply, mode, opts){
  const o = opts || {};
  const day = String(o.day || today()).slice(0, 10);
  const a = analyzeChatText(msg, reply, mode, o);
  // ★ v1.70 ⑥: learn 파이프라인이 남긴 ⟦stuck:…⟧ 태그가 있으면 규칙 추정(guessStuckType)보다 우선한다.
  if(o.stuckType && STUCK_TYPES.includes(String(o.stuckType))) a.stuck = 1;
  const ir = db.prepare(`INSERT OR IGNORE INTO chat_analyses(
      user_id,user_msg_id,ai_msg_id,day,mode,topic,subject,intent,sentiment,stuck,
      hint_level,solved,word_count,question_count,reply_len,reply_has_hint,reply_has_praise,keywords)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid, userMsgId, aiMsgId, day, mode || 'chat', a.topic, a.subject, a.intent, a.sentiment,
      a.stuck, a.hint_level, a.solved, a.word_count, a.question_count, a.reply_len,
      a.reply_has_hint, a.reply_has_praise, a.keywords);
  // ★ v1.70 ①: 막힘 기록(stuck=1)이 «새로» 쓰였을 때만 마스터리 감점(rebuild 재집계 시 중복 방지).
  if(a.stuck === 1 && a.topic && ir && ir.changes) bumpMastery(uid, a.topic, 'stuck');
  const agg = db.prepare(`SELECT COUNT(*) turns, SUM(word_count) words, SUM(stuck) stuck,
      SUM(solved) solved, SUM(COALESCE(hint_level,0)) hints
    FROM chat_analyses WHERE user_id=? AND day=?`).get(uid, day);
  const topSub = db.prepare(`SELECT subject FROM chat_analyses WHERE user_id=? AND day=?
      AND subject IS NOT NULL GROUP BY subject ORDER BY COUNT(*) DESC LIMIT 1`).get(uid, day);
  const topInt = db.prepare(`SELECT intent FROM chat_analyses WHERE user_id=? AND day=?
      AND intent IS NOT NULL GROUP BY intent ORDER BY COUNT(*) DESC LIMIT 1`).get(uid, day);
  const mood = db.prepare(`SELECT sentiment FROM chat_analyses WHERE user_id=? AND day=?
      GROUP BY sentiment ORDER BY COUNT(*) DESC LIMIT 1`).get(uid, day);
  const turns = agg.turns || 0, stuck = agg.stuck || 0, solved = agg.solved || 0;
  const summary = `오늘 루미와 ${turns}번 이야기했어요. `
    + (stuck ? `막힌 순간이 ${stuck}번 있었고, ` : '막힘 없이 ')
    + (solved ? `${solved}번 스스로 풀었어요.` : '천천히 같이 생각해 봤어요.');
  db.prepare(`INSERT INTO chat_reports(user_id,day,turns,user_words,stuck_count,solved_count,
      hint_sum,top_subject,top_intent,mood,summary,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now','+9 hours'))
    ON CONFLICT(user_id,day) DO UPDATE SET
      turns=excluded.turns, user_words=excluded.user_words, stuck_count=excluded.stuck_count,
      solved_count=excluded.solved_count, hint_sum=excluded.hint_sum,
      top_subject=excluded.top_subject, top_intent=excluded.top_intent,
      mood=excluded.mood, summary=excluded.summary, updated_at=excluded.updated_at`)
    .run(uid, day, turns, agg.words || 0, stuck, solved, agg.hints || 0,
      topSub ? topSub.subject : null, topInt ? topInt.intent : null,
      mood ? mood.sentiment : null, summary);
  return a;
}

// 모든 대화는 반드시 이 함수로만 저장한다. «저장했는데 분석이 없다» 는 구멍을 구조적으로 막는다.
function saveChatTurn(uid, msg, reply, mode, opts){
  const o = opts || {};
  const ins = db.prepare('INSERT INTO chat_messages(user_id,role,content,mode,hint_level,follow_up) VALUES(?,?,?,?,?,?)');
  const hint = o.hintLevel == null ? null : o.hintLevel;
  const r1 = ins.run(uid, 'user', msg, mode, hint, null);
  const r2 = ins.run(uid, 'assistant', reply, mode, hint, o.followUp || null);
  const userMsgId = Number(r1.lastInsertRowid), aiMsgId = Number(r2.lastInsertRowid);
  try{ recordChatAnalysis(uid, userMsgId, aiMsgId, msg, reply, mode, o); }
  catch(e){ console.warn('[chat analysis]', e && e.message); }
  return { userMsgId, aiMsgId };
}

app.post('/api/chat', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const mode = ['chat','learn','reflect'].includes(b.mode) ? b.mode : 'chat';
  const msg = String(b.message || '').trim().slice(0,200);
  if(msg.length < 1) return res.status(400).json({error:'하고 싶은 말을 적어줄래?'});
  if(!isSafeText(msg)) return res.status(400).json({error:'다른 이야기를 해볼까요?'});
  const day = today();
  const used = chatCount(u.id, mode, day);
  const limit = CHAT_LIMITS[mode];
  if(used >= limit) return res.status(429).json({error:'오늘은 여기까지! 내일 또 이야기하자.'});

  // ★ 2026-10-31: "잊어줘" 명령 — 기억만 삭제하고 고정 응답
  //   ★ 정규식을 «명령형» 으로만 좁힌다. 예전 /(…|잊어)/ 는 «잊어버렸어(기억 안 남)» 까지
  //     삭제 명령으로 오인해 기억을 지워 버렸다. 잊어버렸(과거형)은 절대 매치하지 않는다.
  const FORGET_RE = /(잊어\s*줘|잊어버려\s*줘|기억하지\s*마|기억에서\s*지워)/;
  if(mode === 'chat' && FORGET_RE.test(msg)){
    const topic = msg.replace(FORGET_RE, '').replace(/["'“”]/g,'').replace(/기억/g,'').trim();
    const { removed } = forgetMemories(u.id, topic);
    const reply = topic
      ? (removed ? `"${topic}" 기억은 지웠어. 다른 기억은 그대로야.` : `"${topic}" 기억은 없었어.`)
      : '무엇을 잊을까? "BTS 잊어줘"처럼 말해 줘.';
    saveChatTurn(u.id, msg, reply, mode, { topic: currentTopic().topic });
    return res.json({ ok:true, mode, reply, hintLevel:null, followUp:null,
      left: Math.max(0, limit-used-1), understanding: profileFor(u.id).understanding||0,
      solved:false, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }

  // ★ v1.38 이스터에그: «누가 만들었어?» 는 LLM 에 맡기지 않고 사실로 답한다.
  //   아이들이 진짜로 물어보는 질문이라, 여기서만큼은 지어낸 이야기가 나오면 안 된다.
  //   답 끝에 «마을 끝 이정표» 를 슬쩍 걸어 두어 세계로 한 번 더 걸어가게 만든다.
  const MAKER_Q = /(누가|누구).{0,8}(만들|만든|개발)|(만든|만들어\s*준)\s*(사람|이)|개발자|제작자|만든\s*이/;
  if(mode === 'chat' && MAKER_Q.test(msg)){
    const reply = "나를 만든 사람은 한양대학교에서 인공지능을 공부하는 '이멍멍'이야. "
      + "아주 오래 고민해서 나를 이 마을에 세웠대. "
      + "마을 끝에 그 사람이 남긴 낡은 이정표가 숨어 있어.";
    saveChatTurn(u.id, msg, reply, mode, { topic: currentTopic().topic });
    return res.json({ ok:true, mode, reply, hintLevel:null, followUp:null,
      left: Math.max(0, limit-used-1), understanding: profileFor(u.id).understanding||0,
      solved:false, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }

  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const profile = profileFor(u.id);
  const topic = currentTopic();
  // ★ 2026-11-04: 오늘 기분을 말투에 반영한다(미기록이면 중립).
  const moodRow = db.prepare('SELECT mood FROM mood_logs WHERE user_id=? AND day=?').get(u.id, day);
  const moodNote = moodRow && MOODS[moodRow.mood]
    ? `[아이의 오늘 기분] ${MOODS[moodRow.mood].ko} — 말투는 ${MOODS[moodRow.mood].tone}.`
    : '';
  // ★ 질문 키워드 우선 → 없으면 이번 주 챕터 → 그래도 없으면 랜덤.
  //   (예전엔 챕터만 봐서 "변수가 뭐야?"에 AI 추천 카드가 들어가는 문제가 있었다)
  // ★ v1.51: «개념» 으로 찾는다(동의어·태그 포함). 못 찾으면 챕터 → 랜덤 순으로 내려간다.
  let cards = mode === 'learn' ? matchCards(msg, topic.chapter).slice(0, 1) : [];

  // ★ 2026-10-29: 이번 질문과 실제로 맞은 카드 = 약점/해결 기록의 기준
  // ★ v1.51: «분모» 처럼 주제어가 아닌 말로도 카드를 잡을 수 있게 별칭까지 본다.
  const focusCard = mode === 'learn'
    ? (cards.find(c =>
        msg.includes(c.topic) ||
        (CARD_ALIASES[c.topic] || []).some(a => a && msg.includes(a)) ||
        String(c.tags||'').split(',').some(t => t.trim() && msg.includes(t.trim()))
      ) || null)
    : null;
  // ★ v1.51 «대화 상태» — 같은 단계를 계속 반복하지 않게 서버가 단계를 들고 있는다.
  const sess = mode === 'learn' ? getSession(u.id, day, 'learn') : null;
  const baseLevel = sess ? stageLevel(sess.stage) : 1;
  // ★ «힌트 한 단계 더» 버튼 고정 문구 화이트리스트 — 키워드(모르겠/몰라)가 없어도 즉시 한 단계 올린다.
  //   이게 없으면 버튼 첫 클릭에서 wantLevel 이 그대로라 L1 이 그대로 반복됐다.
  const explicitHintUp = /힌트.*한\s*단계\s*더|한\s*단계\s*더\s*(알려|보여|주)/.test(msg);
  const confused = /(모르겠|모르겟|어려워|몰라|이해가 안)/.test(msg) || explicitHintUp;
  const gotIt = /(알겠|이해했|맞았|맞아|다 했|풀었)/.test(msg);
  let wantLevel = baseLevel;
  if(sess && explicitHintUp) wantLevel = Math.min(3, baseLevel + 1);
  if(sess && confused && sess.stage_turns >= 1) wantLevel = Math.min(3, baseLevel + 1);
  if(sess && sess.stage_turns >= 2 && baseLevel < 3) wantLevel = Math.min(3, baseLevel + 1);
  const knownConcept = (focusCard && focusCard.topic) || (sess && sess.concept) || topic.topic;
  const stuckGuess = guessStuckType(msg);
  // ★ v1.70 ④: 좌절 턴 판정 — 스트리밍(buildChatContext)과 같은 규칙. 좌절 턴은 단계를 동결한다.
  const frustrated = mode === 'learn' ? frustrationOf(u.id, msg, sess, day) : false;
  if(frustrated && sess) wantLevel = baseLevel;
  if(frustrated && sess && Number(sess.stage_turns || 0) >= 2) wantLevel = Math.min(3, baseLevel + 1);
  // ★ v1.70 ③a: 관심 도메인(비유 영역) / ③b: 숙련도 높으면 힌트 축소
  const interest = mode === 'learn' ? interestDomainOf(u.id) : null;
  const fade = mode === 'learn' && !!focusCard && masteryOf(u.id, focusCard.topic) >= 0.75;
  // ★ v1.71 «루미는 잊어버려» — learn 모드에서 안개 진한 등불(decay≥60) 1개만 주입(스트림과 동일 규칙).
  let fogNoteLLM = '';
  if(mode === 'learn'){
    const fl = fogHeaviestReadonly(u.id, 60);
    if(fl) fogNoteLLM = `[기억 안개] 루미는 «${fl.topic}» 을(를) 많이 잊었다. 이 개념이 나오면 스스로 확신 있던 말을 어색하게 말하고 «어렸을 때 확실했는데…» 하며 아이에게 다시 가르쳐 달라 고할 수 있다(단 퀴즈 정답은 여전히 절대 말하지 않는다).`;
  }
  // ★ v1.52: 카드 전체(비유+예시+힌트 3단계)를 다 넣지 않고 «지금 단계에 필요한 것» 만 넣는다.
  // ★ v1.70 ③b: fade 시 L2 는 예시(비유)를 빼고 hint_l2 한 줄만 남긴다.
  // ★ v1.78: «모르겠어» 처럼 개념 키워드가 없는 턴은 «이 대화의 개념» 카드로 고정한다.
  //   (키워드 미검출 시 matchCards 가 같은 챕터의 다른 카드를 골라, 반복문 대화에 변수 설명이 섞였다)
  if(mode === 'learn' && sess && sess.concept){
    const cpt = String(sess.concept);
    const hit = msg.includes(cpt) || (CARD_ALIASES[cpt] || []).some(a => msg.includes(String(a)));
    if(!hit){ const fixed = teachCardFor(cpt); if(fixed) cards = [fixed]; }
  }
  const cardText = cards.map(c => {
    if(wantLevel <= 1) return `- ${c.concept}: «${c.hint_l1}» — 이 문장을 그대로 아이에게 물어라. 개념을 설명하지 마라.`;
    if(wantLevel === 2) return fade ? `- ${c.concept}: ${c.hint_l2}` : `- ${c.concept}: ${c.analogy} / 힌트: ${c.hint_l2}`;
    return `- ${c.concept}: ${c.hint_l3}`;
  }).join('\n') || '(없음)';
  // ★ v1.52: 원문 6턴 → 2턴(학습)·3턴(수다). 나머지 맥락은 세션 «메모» 가 대신한다.
  // ★ v1.66: 맥락은 세션 «메모» 가 들고 있으므로 원문은 더 줄인다(비용).
  const histLimit = mode === 'learn' ? 0 : 1;   // ★ v1.66: 학습은 세션 메모가 대신한다
  const hist = db.prepare('SELECT role,content FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT ?')
    .all(u.id, histLimit).reverse();
  const sessionMemo = (mode === 'learn' && sess && sess.summary) ? String(sess.summary).slice(0,180) : '';
  // ★ 2026-10-31: 이번 질문과 관련된 장기 기억 top 6만 주입
  const mems = retrieveMemories(u.id, msg, 1);   // ★ v1.52: 관련 기억 top 3 만
  const memText = memoryPrompt(mems);

  const intent = mode === 'learn' ? routeLearnIntent(msg, sess) : 'chat';
  const direct = mode === 'learn' && (b.style === 'direct' || (b.style === 'auto' && intent === 'direct'));
  const system = `너는 DOROBUS의 로봇 "${robot?robot.name:'루미'}"(성격: ${robot?robot.personality:'반짝이'})다.
대상: 초등 저학년~고학년(7-11세). 아주 쉬운 한국어.
이번 주 주제: "${topic.topic}".
${moodNote}
[모드=${mode}] ${(typeof c !== 'undefined' ? c.direct : direct) ? DIRECT_RULE : CHAT_MODE_RULES[mode]}
${mode === 'learn' ? `[이번 대화] 목표: "${knownConcept}" · 지금 단계: L${wantLevel}${sess ? ` (이 단계 ${sess.stage_turns + 1}번째)` : ''}
${sessionMemo ? `[지금까지의 대화]
${sessionMemo}
` : ''}[막힘 유형] ${stuckGuess} — ${STUCK_RULES[stuckGuess]}
${interest ? `[아이의 관심사] 비유는 «${interest}» 영역에서 들어 준다\n` : ''}${fade ? `[숙련도 높음] 힌트는 한 줄로만. 비유·예시를 덧붙이지 마라\n` : ''}${wantLevel <= 1 ? L1_CHOICE_RULE + '\n' : ''}${frustrated ? `[감정 신호] 아이가 좌절 중이다. 이번 턴은 새 힌트를 주지 말고, 한 문장으로 «틀려도 뇌가 자라는 거야» 류의 성장 마인드셋 다독임 + 편안해할 짧은 질문으로 마무리해라. 정답·힌트 금지.\n` : ''}${fogNoteLLM ? fogNoteLLM + '\n' : ''}[말하기] 두 문장·90자. 끝에 반드시 질문 1개. ${TAG_LINE_RULE}
` : ''}[지식 카드]
${cardText}
${memText ? `[루미가 기억하는 것]\n${memText}\n` : ''}[출력] JSON만: {"reply":"...","hintLevel":1|2|3|null,"stuckType":"concept|procedure|reading|careless|null","followUp":"...","safety":"ok"}`;

  let raw = null;
  const t0 = Date.now();
  let llmRes = null;
  try{
    llmRes = await callLLM('', {
      messages: [{ role:'system', content: system }, ...hist, { role:'user', content: msg }],
      temperature: mode==='learn' ? 0.7 : 0.9,
      // ★ v1.52: 학습은 «두 문장» 이면 되므로 출력 상한을 낮춘다(출력 토큰이 곧 비용).
      maxTokens: mode === 'learn' ? 140 : 170,
      // ★ v1.57 주석 정정: LLM_FORCE_FAST 기본값(true) 이면 prefer:'quality' 는 동작하지 않고
      //   모든 모드가 «싼 모델(DeepSeek) 우선» 이다. 품질 우선은 LLM_FORCE_FAST=0 일 때만 유효.
      prefer: (mode === 'learn' || mode === 'chat') ? 'quality' : 'fast',
    });
    raw = llmRes ? llmRes.text : null;
  }catch(e){ raw = null; }
  // ★ 계량은 반환값(llmRes) 기준 — 모듈 전역은 동시 요청에 오염된다.
  const us = (llmRes && llmRes.usage) || {};
  try{ db.prepare(`INSERT INTO llm_logs(user_id,mode,model,latency_ms,ok,
      prompt_tokens,completion_tokens,total_tokens,prompt_chars) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(u.id, mode, (llmRes && llmRes.model) || null, Date.now()-t0, raw ? 1 : 0,
      us.prompt_tokens || null, us.completion_tokens || null, us.total_tokens || null,
      (llmRes && llmRes.promptChars) || null); }catch(e){}

  const parsed = parseChatJSON(raw);
  let reply = parsed ? String(parsed.reply).trim() : (raw ? String(raw).trim() : '');
  // ★ v1.70 ⑥: learn 모드는 ⟦stuck:…⟧ 태그 줄을 본문에서 떼고, 유효한 태그면 막힘 유형 판정에 우선한다.
  //   태그가 없으면 parseTagLine 은 원문을 그대로 돌려준다(기존 동작과 동일).
  let tagStuck = null;
  if(mode === 'learn'){
    const tl = parseTagLine(reply);
    tagStuck = tl.stuck;
    reply = tl.reply;
  }
  // ★ v1.51: 힌트 단계는 «서버 상태» 가 기준. LLM 은 한 단계만 올릴 수 있고, 되돌릴 수는 없다.
  const llmLevel = parsed && [1,2,3].includes(Number(parsed.hintLevel)) ? Number(parsed.hintLevel) : wantLevel;
  let finalLevel = Math.max(wantLevel, Math.min(llmLevel, wantLevel + 1));
  finalLevel = Math.max(1, Math.min(3, finalLevel));
  // 첫 턴은 반드시 «되묻기(L1)» 에서 시작한다 — 바로 답을 주지 않는 것이 이 제품의 약속이다.
  if(sess && (sess.turns || 0) === 0) finalLevel = 1;
  // ★ v1.70 ④: 좌절 턴은 단계를 올리지 않는다(«이번 턴 승급 금지»).
  if(frustrated && sess && Number(sess.stage_turns || 0) < 2) finalLevel = baseLevel;
  let hintLevel = mode === 'learn' ? (direct ? null : finalLevel) : null;
  let followUp = parsed && parsed.followUp ? sanitizeLine(String(parsed.followUp), 60) : null;

  // ★ 학습 모드: 정답 누설 차단
  if(mode === 'learn' && /(정답은|정답:|```)/.test(reply)){
    reply = (cards[0] && cards[0].hint_l3) || '정답 대신 힌트를 줄게. 먼저 스스로 한 단계만 해 볼까?';
    hintLevel = 3; finalLevel = 3;
  }
  // ★ v1.51: 배움 모드에서는 «두 문장» 이면 충분하다. 길면 아이가 생각을 멈춘다.
  //   안전 필터 길이 상한은 채팅 파이프라인 공통 600(한국어 정상 응답 오탐 방지).
  reply = mode === 'learn' ? limitSentences(sanitizeLine(reply, 180, 600), 2, 90) : sanitizeLine(reply, 180, 600);
  // ★ v1.77: «L1·L2·L3 가 다 같은 설명» 문제. 모델이 카드의 단계별 문장을 무시하고
  //   매번 정의를 말하므로, 응답이 «질문으로 끝나지 않으면» 그 단계의 카드 문장으로 교체한다.
  //   → L1 은 반드시 되묻기, L2 는 비유, L3 는 다음 한 단계. 세 단계가 구조적으로 달라진다.
  // ★ v1.78: L3 인데 «다독임» 문장이 나오면(모델이 좌절 지시를 따라감) 실제 «다음 한 단계» 로 교체.
  if(mode === 'learn' && finalLevel >= 3 && /(괜찮아|자라|숨 한 번|기분은|편해졌)/.test(reply)){
    const c3 = cards[0] || {};
    reply = `${String(c3.hint_l3 || '').trim() || '먼저 한 단계만 해 보자.'} 지금 해 볼래?`;
  }
  if(mode === 'learn'){
    const endsWithQ = /(까|래|니|어때|볼까|줄래|싶어|맞아|알겠어|있어|없어|볼래|했어|될까|줄까)\s*[?？]\s*$/.test(reply.trim());
    if(!endsWithQ){
      const c = cards[0] || {};
      if(finalLevel <= 1){
        reply = `같이 생각해 보자. ${String(c.hint_l1 || '').trim() || L1_FALLBACK_LINE}`;
      }else if(finalLevel === 2){
        const ana = String(c.analogy || '').trim();
        const h2 = String(c.hint_l2 || '').trim();
        reply = `${ana ? ana + ' ' : ''}${h2 ? h2 + ' ' : ''}이걸 네 생활에서 본 적 있어?`.trim();
      }else{
        const h3 = String(c.hint_l3 || '').trim();
        reply = `${h3 || '먼저 한 단계만 해 보자.'} 지금 해 볼래?`;
      }
      reply = limitSentences(reply, 2, 110);
    }
  }
  if(!reply){
    reply = mode==='learn'
      ? ((cards[0] && cards[0].hint_l1) || L1_FALLBACK_LINE)   // ★ v1.70 ③c: 폴백도 «두 가지 선택지» 예시로 통일
      : '지금은 생각이 잠깐 멈췄어. 다시 말해 줄래?';
    hintLevel = mode==='learn' ? 1 : null;
  }

  // ★ 자가 해결 표시 → 이해도/성장/셀 (하루 3회까지)
  let solvedNow = false;
  if(mode === 'learn' && b.solved){
    const solvedToday = db.prepare('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND day=? AND solved=1').get(u.id, day).c;
    if(solvedToday < 3){
      db.prepare('INSERT INTO learning_help_logs(user_id,day,subject,level,solved) VALUES(?,?,?,?,1)')
        .run(u.id, day, focusCard ? focusCard.topic : topic.topic, hintLevel || 3);
      db.prepare('UPDATE users SET understanding = understanding + 3 WHERE id=?').run(u.id);
      db.prepare("UPDATE learner_profile SET understanding = understanding + 3, updated_at=datetime('now','+9 hours') WHERE user_id=?").run(u.id);
      grantCell(u.id, 5, 'learning');
      solvedNow = true;
      const solvedTopic = focusCard ? focusCard.topic : topic.topic;
      // ★ v1.70 ①: 스스로 해결 → 마스터리 가점(learning_help_logs solved=1 기록과 함께)
      bumpMastery(u.id, solvedTopic, 'solved');
      upsertMemory(u.id, { kind:'learning', key:'understood:'+solvedTopic, value:solvedTopic+' 이해', confidence:0.9, source:'chat' });
    }
  }

  if(mode === 'learn'){
    if(solvedNow) removeWeakTopic(u.id, focusCard ? focusCard.topic : topic.topic);
    else if((hintLevel||1) >= 2 && focusCard) addWeakTopic(u.id, focusCard.topic);
  }

  saveChatTurn(u.id, msg, reply, mode, {
    hintLevel, followUp, solved: solvedNow,
    // ★ v1.70 ⑥: 태그로 확정된 막힘 유형을 분석에 전달(chat_analyses.stuck 판정 우선순위)
    stuckType: tagStuck || null,
    // ★ 6-1 점검에서 발견: 카드가 안 잡혔을 때 «이번 주 주제» 를 topic 으로 저장하면
    //   막힘 집계(stuckTopics)가 «멈춘 기계의 노래» 를 «아이가 막힌 개념» 으로 착각한다.
    topic: focusCard ? focusCard.topic : null
  });

  // ★ v1.51 대화 상태 저장 — 다음 턴이 «어디까지 왔는지» 알고 시작한다.
  let sessionInfo = null;
  if(mode === 'learn' && sess){
    // ★ v1.70 ⑥: ⟦stuck:…⟧ 태그가 유효하면 LLM JSON·규칙 추정보다 우선한다.
    const stuckType = tagStuck
      || ((parsed && STUCK_TYPES.includes(String(parsed.stuckType)))
        ? String(parsed.stuckType) : stuckGuess);
    // ★ v1.70 ④: 좌절 턴은 단계(stage)도, 단계 턴 수(stage_turns)도 진행시키지 않는다(동결).
    const nextStage = (direct || frustrated) ? sess.stage : ((gotIt && finalLevel >= 2) ? 'confirm' : ('L' + finalLevel));
    // ★ v1.78: 좌절 턴에도 단계 턴 수는 올린다. 동결하면 «모르겠어» 가 반복될 때
    //   stage_turns 가 2 에 멈춰 다독임만 무한 반복되고 L3 에 도달하지 못한다.
    const stageTurns = direct ? (sess.stage_turns || 0) : ((nextStage === sess.stage) ? ((sess.stage_turns || 0) + 1) : 1);
    const memo = buildSessionSummary(sess.summary, msg, reply);
    db.prepare(`UPDATE chat_sessions SET stage=?, stage_turns=?, turns=turns+1, concept=?, stuck_type=?,
      summary=?, updated_at=datetime('now','+9 hours') WHERE id=?`)
      .run(nextStage, stageTurns, knownConcept, stuckType, memo, sess.id);
    sessionInfo = { stage: nextStage, level: finalLevel, turns: (sess.turns || 0) + 1, stuckType };
  }

  const p2 = profileFor(u.id);
  const remembered = extractMemoryRules(u.id, msg, reply);
  const summary = solvedNow
    ? (focusCard ? `${focusCard.topic}: ${String(focusCard.analogy||'').slice(0,100)}` : null)
    : null;
  // ★ v1.50 «L3 다음은 설명» — 힌트를 다 받은 뒤 바로 끝내면 아이는 «옮겨 적기» 로 끝낼 수 있다.
  //   마지막 단계에서만 «네 말로 설명해 줘» 를 제안하고, 그 답은 /api/chat/explain 이 받는다.
  const explain = (mode === 'learn' && Number(hintLevel) >= 3)
    ? { // ★ 6-1 점검: 카드가 없을 때 «주제» 를 개념명으로 쓰면 «멈춘 기계의 노래» 가 기억에 남는다.
        //   빈 값으로 두고 화면이 «방금 배운 것» 으로 부르게 한다.
        concept: focusCard ? focusCard.topic : '',
        prompt: '방금 이해한 걸 네 말로 설명해 줄래? 루미가 들을게.' }
    : null;
  res.json({ ok:true, mode, reply, hintLevel, followUp, summary, explain, session: sessionInfo,
             wrapUp: (mode === 'learn' && sessionInfo && sessionInfo.turns >= 6)
               ? '오늘 대화는 여기까지. 내일 이어서 보자!' : null,
             left: Math.max(0, limit - used - 1),
             understanding: p2.understanding || 0, solved: solvedNow,
             // ★ v1.70 ④: 좌절 턴일 때만 frustration:true (프론트 표시용)
             ...(frustrated ? { frustration: true } : {}),
             remembered: remembered.map(m=>m.value),
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  // LLM 기반 심층 기억 추출은 응답 뒤 백그라운드에서
  setImmediate(()=>{ extractMemoryLLM(u.id, msg, reply); });
});

// ★ v1.50 «아이가 루미를 가르친다» — 설명은 채점하지 않는다.
//   아이 말을 그대로 되받고, 한 군데만 «만약 ~라면?» 으로 물어본다. 그 설명은 taught 기억이 된다.
const EXPLAIN_DAILY = 5;
app.post('/api/chat/explain', async (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const concept = String(b.concept || '').trim().slice(0,40) || '방금 배운 것';
  const text = String(b.text || '').trim().slice(0,300);
  if(text.length < 8) return res.status(400).json({error:'조금만 더 자세히 설명해 줄래?'});
  if(!isSafeText(text)) return res.status(400).json({error:'다른 이야기를 해볼까요?'});
  const day = today();
  const used = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND mode='explain' AND substr(ts,1,10)=?")
    .get(u.id, day).c;
  if(used >= EXPLAIN_DAILY) return res.status(429).json({error:'오늘은 설명을 충분히 했어! 내일 또 들려줘.'});
  let reply = null;
  let llmRes = null;
  const t0 = Date.now();
  try{
    const prompt = `너는 7-11세 아이의 학습 친구 '루미'다. 아이가 방금 «${concept}»을 자기 말로 설명했다.
[아이의 설명] ${text}
규칙:
1) 아이가 쓴 표현을 «그대로» 한 번 되받아라. 칭찬·평가·점수는 금지.
2) 설명에서 한 군데만 골라 «만약 ~라면?» 형태의 질문 1개.
3) 2문장, 80자 이내, 존댓말. 정답을 말하지 마라.
JSON만: {"reply":"..."}`;
    const er = await callLLM(prompt, { temperature:0.5, maxTokens:220, json:true });
    llmRes = er;
    const raw = er ? er.text : null;
    const j = parseChatJSON(raw);
    if(j && j.reply) reply = String(j.reply);
  }catch(e){ reply = null; }
  // ★ 계량은 반환값 기준(모듈 전역 오염 제거)
  try{ db.prepare('INSERT INTO llm_logs(user_id,mode,model,latency_ms,ok) VALUES(?,?,?,?,?)')
    .run(u.id, 'explain', (llmRes && llmRes.model) || null, Date.now()-t0, reply ? 1 : 0); }catch(e){}
  if(!reply){
    const short = text.length > 38 ? text.slice(0,38) + '…' : text;
    reply = `«${short}» 라고 설명했구나. 그럼 만약 ${concept}에서 숫자가 하나 바뀌면 어떻게 될까?`;
  }
  reply = sanitizeLine(reply, 180);
  saveChatTurn(u.id, text, reply, 'explain', { topic: concept, hintLevel: 3, solved: false });
  // 설명까지 왔으면 이번 대화의 목표는 «달성» 단계로 본다.
  try{
    const s = getSession(u.id, today(), 'learn');
    db.prepare(`UPDATE chat_sessions SET stage='teachback', stage_turns=1,
      updated_at=datetime('now','+9 hours') WHERE id=?`).run(s.id);
  }catch(e){}
  upsertMemory(u.id, { kind:'taught', key:'taught:'+concept, value:text.slice(0,160),
    confidence:0.95, source:'explain' });
  const lampRes = lightLamp(u.id, concept);   // ★ v1.71: teach-back 이 끝나면 기억 등불을 밝힌다(lit_day=오늘, 안개 리셋)
  db.prepare('UPDATE users SET understanding = understanding + 1 WHERE id=?').run(u.id);
  const coTaught = coTeacherOf(u.id, concept);   // ★ v1.71: 친구도 가르친 개념이면 닉네임만(내용 비공개)
  res.json({ ok:true, reply, concept, saved:true, left: Math.max(0, EXPLAIN_DAILY-used-1),
    ...(coTaught ? { coTaught } : {}),
    // ★ 2026-11-21 (v1.74) B1 삼막 1막: «첫 등불» 인 그 한 번만 firstLamp 로 알려준다.
    ...(lampRes && lampRes.first ? { firstLamp:true } : {}) });
});

// ============================================================
// ★ 2026-11-20 / v1.70 ② «루미가 틀려볼게» — 루미가 두 문장을 말하고 아이가 틀린 문장을 찾는다.
//   teach-back 의 반전 모드: 아이가 «채점자» 가 된다. 셀은 지급하지 않는다(explain 과 동일).
//   · GET  /api/teach/challenge        — 하루 3회(daily_counters), LLM 우선 + 결정론 폴백
//   · POST /api/teach/challenge/answer — pendingTeach(메모리 Map) 채점, 정답 오답 모두 why 반환
//   정답 문장·이유(why)에는 hint_l3/퀴즈 정답을 절대 담지 않는다(hint_l2 이하만 사용).
// ============================================================
const TEACH_DAILY_LIMIT = 3;
// LLM 출력은 재계산할 수 없으므로 «출제 당시의 정답» 을 메모리에만 둔다(서버 재시작이면 자연 만료).
const pendingTeach = new Map();   // user_id → { day, a, b, correctChoice, concept }

// 한글 받침 판정 — «(이)라는» 조사 붙이기용
function koIraNeun(word){
  const last = String(word || '').slice(-1);
  if(!/[가-힣]/.test(last)) return '이라는';
  return ((last.charCodeAt(0) - 0xAC00) % 28 === 0) ? '라는' : '이라는';
}

// 개념에 맞는 지식 카드 찾기 — topic 정확 → 별칭/태그 매칭 순
function teachCardFor(concept){
  const c = String(concept || '').trim();
  if(!c) return null;
  const exact = db.prepare('SELECT * FROM knowledge_cards WHERE topic=?').get(c);
  if(exact) return exact;
  const all = db.prepare('SELECT * FROM knowledge_cards').all();
  const low = c.toLowerCase();
  return all.find(k => String(k.topic||'').toLowerCase() === low)
    || all.find(k => (CARD_ALIASES[k.topic] || []).some(a => a && a.toLowerCase() === low))
    || all.find(k => String(k.tags||'').split(',').some(t => t.trim() && t.trim().toLowerCase() === low))
    || null;
}

// 결정론 폴백 출제 — 지식 카드 문장(analogy/hint_l2)에서 «옳은 문장» 을 고쳐 쓰고,
//   소형 변형 템플릿으로 «틀린 문장» 을 만든다.
//   변형 2종: ①대상 교체(다른 카드의 개념 정의를 끼워 넣기) ②인과 반전(순서·원인을 뒤집은 보편 오개념)
function teachFallbackPair(concept, uid, day){
  const card = teachCardFor(concept);
  // 옳은 문장: 비유(analogy) → hint_l2 첫 문장 → 개념 정의 순으로 결정론적으로 고쳐 쓴다.
  let right = '';
  if(card && card.analogy){
    right = `${concept}는 ${String(card.analogy).trim()}처럼 생각하면 돼.`;
  }else if(card && card.hint_l2){
    right = String(card.hint_l2).trim().split(/[.!?]/)[0] + '.';
  }else if(card && card.concept){
    right = `${concept}는 ${String(card.concept).trim()}${koIraNeun(String(card.concept).trim())} 뜻이야.`;
  }else{
    right = `${concept}는 차근차근 배우면 충분히 이해할 수 있는 개념이야.`;
  }
  // 대상 교체용 «다른 카드» — 개념 이름+날짜 해시로 결정적으로 고른다(재호출에도 같은 결과)
  const others = db.prepare(`SELECT topic, concept FROM knowledge_cards
    WHERE topic<>? AND concept IS NOT NULL AND concept<>''`).all(concept);
  let wrong;
  if(others.length){
    const seed = Math.abs(String(uid + '|' + day + '|' + concept).split('').reduce((a,ch)=>(a*31 + ch.charCodeAt(0))>>>0, 7));
    const other = others[seed % others.length];
    wrong = `${concept}는 ${other.concept}${koIraNeun(other.concept)} 뜻이야.`;
  }else{
    wrong = `${concept}는 결과를 먼저 정하고 그다음에 이유를 찾아도 돼.`;   // 인과 반전(보편 오개념)
  }
  return { right: right.slice(0, 60), wrong: wrong.slice(0, 60) };
}

// 출제 — LLM 우선, 실패 시 결정론 폴백. 항상 { a, b, correctChoice, concept } 형태를 보장(빈 화면 금지).
async function generateTeachChallenge(u, concept){
  const day = today();
  // LLM 우선: 한 문장은 옳게, 한 문장은 «흔한 오류» 로. 퀴즈 정답(기호·숫자)은 옳은 문장에 직접 쓰지 않는다.
  try{
    const prompt = `너는 7-11세 아이의 학습 친구 '루미'다. 개념 «${concept}»에 대해 두 문장을 만들어라.
- 한 문장은 옳은 설명, 한 문장은 아이들이 흔히 저지르는 오류를 담은 설명이다.
- 각 문장은 40자 이내, 아이 눈높이 한국어, 존댓말 없이 반말.
- 옳은 문장에는 이 개념의 퀴즈 정답(기호·숫자·공식)을 직접 쓰지 마라. 개념을 말로 설명해야 한다.
- 오류 문장은 «살짝 틀린» 설명이어야 한다. 그냥 반대말인 뻔한 문장은 금지.
- 아이에게 안전하고 건전한 표현만 쓴다.
출력 형식을 정확히 지켜라(설명·번호·따옴표 금지):
A|첫 번째 문장
B|두 번째 문장`;
    const tr = await callLLM(prompt, { temperature:0.6, maxTokens:200 });
    const txt = tr && tr.text ? String(tr.text) : '';
    const mA = txt.match(/^A\s*\|\s*(.+)$/m), mB = txt.match(/^B\s*\|\s*(.+)$/m);
    const a = mA ? sanitizeLine(mA[1], 60) : null;
    const b = mB ? sanitizeLine(mB[1], 60) : null;
    if(a && b && a !== b){
      const seed = Math.abs(String(u.id + '|' + day + '|' + concept).split('').reduce((x,ch)=>(x*31 + ch.charCodeAt(0))>>>0, 7));
      const correctChoice = (seed % 2 === 0) ? 'a' : 'b';
      return { a, b, correctChoice, concept, source:'llm' };
    }
  }catch(e){}
  // 결정론 폴백(카드 문장 + 변형 템플릿) — LLM 이 죽어도 항상 출제된다
  const fb = teachFallbackPair(concept, u.id, day);
  const seed = Math.abs(String(u.id + '|' + day + '|' + concept + '|fb').split('').reduce((x,ch)=>(x*31 + ch.charCodeAt(0))>>>0, 7));
  const correctChoice = (seed % 2 === 0) ? 'a' : 'b';
  return correctChoice === 'a'
    ? { a: fb.right, b: fb.wrong, correctChoice, concept, source:'fallback' }
    : { a: fb.wrong, b: fb.right, correctChoice, concept, source:'fallback' };
}

// 루미가 «틀려 보기» 도전을 출제한다(하루 3회).
app.get('/api/teach/challenge', async (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  // 일일 한도 — daily_counters 로 남발을 막는다(LLM 예산 보호).
  if(dailyCounterOf(u.id, day, 'teach_challenge') >= TEACH_DAILY_LIMIT)
    return res.status(429).json({error:'오늘 도전은 3번 다 했어! 내일 루미가 또 틀려 볼게.'});
  // 개념 선정: ①최근 학습 세션 개념 → ②가장 약한 개념(마스터리) → ③최근 막힌 개념
  let concept = null;
  try{
    const s = db.prepare(`SELECT concept FROM chat_sessions
      WHERE user_id=? AND concept IS NOT NULL AND concept<>'' ORDER BY updated_at DESC LIMIT 1`).get(u.id);
    if(s && String(s.concept).trim()) concept = String(s.concept).trim().slice(0, 40);
  }catch(e){}
  if(!concept){
    const w = weakestTopics(u.id, 1)[0];
    if(w && String(w.topic).trim()) concept = String(w.topic).trim().slice(0, 40);
  }
  if(!concept){
    const s = stuckTopics(u.id, 7, 1)[0];
    if(s && String(s.subject).trim()) concept = String(s.subject).trim().slice(0, 40);
  }
  if(!concept) return res.status(404).json({error:'오늘 배운 게 아직 없어요. 같이 공부하고 올까?'});
  const q = await generateTeachChallenge(u, concept);
  // 이전 날짜의 미답변 도전은 버린다(하루 단위 정합)
  pendingTeach.set(u.id, { day, a:q.a, b:q.b, correctChoice:q.correctChoice, concept });
  bumpDailyCounter(u.id, day, 'teach_challenge');
  // 어느 문장이 옳은지는 응답에 담지 않는다 — 채점은 POST /api/teach/challenge/answer 가 한다.
  const coTaught = coTeacherOf(u.id, concept);   // ★ v1.71: 친구도 가르친 개념이면 닉네임만(내용 비공개)
  res.json({ ok:true, concept, statements:[{id:'a', text:q.a}, {id:'b', text:q.b}],
    ...(coTaught ? { coTaught } : {}) });
});

// 도전 채점 — 출제 기록(메모리 Map)이 없으면 먼저 받아 달라고 한다.
//   정답: bumpMastery('correct') + understanding +2(explain 스타일) / 오답: bumpMastery('wrong').
//   셀은 지급하지 않는다(teach-back 계열 = explain 와 동일 원칙).
app.post('/api/teach/challenge/answer', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const choice = String(b.choice || '').toLowerCase();
  if(choice !== 'a' && choice !== 'b') return res.status(400).json({error:'a 또는 b 중에 하나만 골라 줘'});
  const p = pendingTeach.get(u.id);
  if(!p || p.day !== today()) return res.status(404).json({error:'먼저 도전을 받아 줄래?'});
  pendingTeach.delete(u.id);   // 1회 채점 후 소멸 — 재전송으로 점수 파밀 불가
  const correct = choice === p.correctChoice;
  const card = db.prepare('SELECT hint_l2 FROM knowledge_cards WHERE topic=?').get(p.concept);
  let why;
  let lampRes = null;
  if(correct){
    // why 는 정답을 알려주는 문장이 아니라 «한 번 더 생각하게 하는» 힌트(hint_l2 이하만).
    why = (card && card.hint_l2)
      ? String(card.hint_l2)
      : `«${p.concept}» 문장을 잘 구분했어! 왜 그렇게 생각했는지 한마디만 더 해 볼래?`;
    bumpMastery(u.id, p.concept, 'correct');
    lampRes = lightLamp(u.id, p.concept);   // ★ v1.71: 도전 정답도 등불을 밝힌다(bumpMastery 유지)
    // explain(/api/chat/explain) 과 같은 스타일: users.understanding 를 서서히 올린다(+2)
    db.prepare('UPDATE users SET understanding = understanding + 2 WHERE id=?').run(u.id);
  }else{
    why = (card && card.hint_l2)
      ? `아직이야! 힌트: ${card.hint_l2}`
      : `괜찮아, 틀려 보면 뇌가 자라는 거야. «${p.concept}» 문장을 한 번 더 천천히 읽어 볼래?`;
    bumpMastery(u.id, p.concept, 'wrong');
  }
  res.json({ ok:true, correct, correctChoice: p.correctChoice, why,
    // ★ 2026-11-21 (v1.74) B1: 정답 응답에만 삼막 플래그를 단다(1막=첫 등불 · 3막=첫 수정화).
    ...(lampRes && lampRes.first ? { firstLamp:true } : {}),
    ...(lampRes && lampRes.crystalNow ? { crystalNow:true } : {}) });
});

// ============================================================
// ★ 2026-11-20 / v1.71 «루미는 잊어버려» — 기억 등불 / 안개 속의 탑 / 마을 루틴 엔드포인트.
//   전부 결정론(날짜의 순수 함수) · LLM 없음 · 셀 미지급(보상 = «루미의 기억이 맑아지는 것»).
//   프론트 계약: /api/lamps · /api/tower/today · /api/tower/answer · /api/robot/routine
// ============================================================

// GET /api/lamps — 기억 등불 전체(decay 내림차순) + SOS(가장 안개 진 등불, 없으면 null)
//   ★ 2026-11-21 (v1.74) A2/A3/B1 계약 확장:
//     · teachCount      — «빛의 조각» 명예 카운트(users.teach_count)
//     · nextBadge       — 다음 딱지 { at:10|50|100, have } (10/50/100 모두 받았으면 null)
//     · sosFirst        — «안개를 처음 겪음» 순간이 이번 응답까지 미전달 상태면 true(1회만)
//     · 등불별 blockedBy — 선수개념 중 decay≥50 인 첫 토픽(없으면 null — «먼저 «X» 부터» 표시용)
app.get('/api/lamps', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const { lamps, sos, sosFirst } = lampsFor(u.id);
  // ★ B1 2막 전달 보장: hello/next-action 등 «다른 길» 에서 먼저 안개를 겪었어도
  //   보류 플래그(ob_sos_pending)를 이 응답으로 소비해 «최초 1회» 가 누락되지 않게 한다.
  let sosFirstOut = !!sosFirst;
  try{
    if(dailyCounterOf(u.id, day, 'ob_sos_pending') > 0){
      sosFirstOut = true;
      db.prepare("DELETE FROM daily_counters WHERE user_id=? AND day=? AND kind='ob_sos_pending'").run(u.id, day);
    }
  }catch(e){}
  const uRow = db.prepare('SELECT teach_count FROM users WHERE id=?').get(u.id);
  const teachCount = Number((uRow && uRow.teach_count) || 0);
  const decayMap = new Map(lamps.map(l => [l.topic, l.decay]));
  res.json({ ok:true,
    teachCount,
    nextBadge: nextBadgeFor(teachCount),
    ...(sosFirstOut ? { sosFirst:true } : {}),
    lamps: lamps.map(l => ({ topic: l.topic, decay: l.decay, crystal: l.crystal ? 1 : 0,
      reinforce: l.reinforce, litDay: l.lit_day, immune: String(l.immune_day || '') === day,
      blockedBy: blockedByFor(l.topic, decayMap) })),
    sos });
});

// GET /api/tower/today — «안개 속의 탑» 출제.
//   floors 의 statement 에 «왜곡 여부» 표시를 주지 않는다 — 아이가 원래 말/안개 낀 말을 맞히는 게 놀이.
app.get('/api/tower/today', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const day = today();
  const { lamps } = lampsFor(u.id);
  const deck = towerDeckFor(u.id, day, lamps);
  if(!deck.length) return res.status(404).json({ error:'기억 등불이 아직 없어요. 루미에게 뭔가 가르쳐 줄래?' });
  const boss = towerIsBoss(day);
  const floors = towerStateFor(u.id, day, deck, boss);
  res.json({ ok:true, day,
    floors: floors.map(f => ({ floor: f.floor, concept: f.concept, statement: f.statement })),
    boss,
    clearedMask: dailyCounterOf(u.id, day, 'tower_clears'),
    ended: dailyCounterOf(u.id, day, 'tower_ended') >= 1 });
});

// POST /api/tower/answer — «원래 말 vs 안개 낀 말» 판정.
//   순서 강제: floor 는 반드시 popcount(clearedMask) 와 같아야 한다(아래층부터).
//   정답 → clearedMask 비트 + 그 층 등불 immune_day=오늘 + understanding(+1, BOSS +3).
//   오답 → fogPenalize + tower_ended(오늘 종료). 셀은 지급하지 않는다.
app.post('/api/tower/answer', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const day = today();
  if(dailyCounterOf(u.id, day, 'tower_ended') >= 1)
    return res.status(429).json({ error:'오늘의 탑은 여기까지… 내일 다시 올래?' });
  const choice = String(b.choice || '').toLowerCase();
  if(choice !== 'original' && choice !== 'fogged')
    return res.status(400).json({ error:'원래 말인지 안개 낀 말인지 골라 줘' });
  const { lamps } = lampsFor(u.id);
  const deck = towerDeckFor(u.id, day, lamps);
  if(!deck.length) return res.status(404).json({ error:'기억 등불이 아직 없어요. 루미에게 뭔가 가르쳐 줄래?' });
  const boss = towerIsBoss(day);
  const floors = towerStateFor(u.id, day, deck, boss);
  const floor = Number(b.floor);
  if(!Number.isInteger(floor) || floor < 0 || floor >= floors.length)
    return res.status(400).json({ error:'그런 층은 없어. 탑을 다시 볼래?' });
  const clearedMask = dailyCounterOf(u.id, day, 'tower_clears');
  if(towerPopcount(clearedMask) !== floor)
    return res.status(400).json({ error:'아래층부터 차례대로 올라가야 해' });
  const info = floors[floor];
  const expected = info.fogged ? 'fogged' : 'original';
  if(choice === expected){
    const mask = towerClearBitSet(u.id, day, floor);
    // ★ 이 층의 등불은 오늘 안개 면역(다시 가르친 것과 같은 효과)
    try{ db.prepare('UPDATE memory_lamps SET immune_day=? WHERE user_id=? AND topic=?').run(day, u.id, info.concept); }catch(e){}
    const isBossFloor = boss && floor === deck.length;
    db.prepare('UPDATE users SET understanding = understanding + ? WHERE id=?').run(isBossFloor ? 3 : 1, u.id);
    return res.json({ ok:true, correct:true, concept: info.concept, clearedMask: mask,
      done: towerPopcount(mask) >= floors.length });
  }
  fogPenalize(u.id, info.concept);
  towerEndedSet(u.id, day);
  // why 는 «그 문장의 정체» 를 부드럽게 알려주는 한 줄(원래 문장은 taught/카드 비유만 사용 — 정답 아님).
  const why = info.fogged
    ? `사실 이 문장은 안개가 흐린 말이었어. 루미의 원래 말은 «${info.original}» 이야. 다시 가르쳐 주면 기억이 맑아져!`
    : `«${info.statement}» 는 안개 안 낀 «원래 말» 이었어. 괜찮아, 루미의 기억은 내일도 여기 있을게!`;
  return res.json({ ok:true, correct:false, expected, concept: info.concept, clearedMask, ended:true, why });
});

// POST /api/robot/routine — 마을 스팟 «하루의 시작 인사». 전부 결정론 규칙(LLM 없음).
//   well(우물)=복습 · mill(풍차)=새 개념 · bell(종탑)=자랑.
app.post('/api/robot/routine', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const spot = String((req.body || {}).spot || '');
  if(!['well','mill','bell'].includes(spot)) return res.status(400).json({error:'마을 장소가 알 수 없어'});
  const day = today();
  let opener = '';
  if(spot === 'well'){
    // ★ 우물 = 복습. 가장 안개 진 등불을 «흘러가는 물» 에 빌려서 다시 배우기를 청한다.
    const fl = fogHeaviestReadonly(u.id, 1);
    if(fl){
      opener = `«${fl.topic}» 이 물처럼 흘러가고 있어… 여기서 다시 배워 줄래?`;
    }else{
      const due = dueReviewCount(u.id);
      opener = due > 0
        ? `우물이 반짝여. 밀린 복습 카드 ${due}장, 여기서 한 장 볼래?`
        : '오늘은 복습할 카드가 없어. 물이 이만큼 맑아!';
    }
  }else if(spot === 'mill'){
    // ★ 풍차 = 새 개념. 오늘 계획의 다음 단계 → 없으면 가장 약한 개념 → 이번 주 주제.
    let next = null;
    try{
      const row = db.prepare('SELECT plan_json FROM learning_plans WHERE user_id=? AND day=?').get(u.id, day);
      const plan = row ? JSON.parse(row.plan_json) : null;
      const steps = (plan && plan.steps) || [];
      next = steps.find(s => !s.done) || null;
    }catch(e){}
    const concept = (next && next.title) || (weakestTopics(u.id, 1)[0] || {}).topic || currentTopic().topic;
    opener = `풍차가 도는 김에 «${concept}» 도 머리에 돌려 볼까?`;
  }else{
    // ★ 종탑 = 자랑. 최근 수정 구슬 → 최근 taught 순으로 «자랑거리» 를 고른다.
    let topic = null, crystal = false;
    try{
      const c = db.prepare('SELECT topic FROM memory_lamps WHERE user_id=? AND crystal=1 ORDER BY lit_day DESC LIMIT 1').get(u.id);
      if(c){ topic = String(c.topic); crystal = true; }
    }catch(e){}
    if(!topic){
      try{
        const m = db.prepare("SELECT key FROM user_memories WHERE user_id=? AND kind='taught' ORDER BY updated_at DESC LIMIT 1").get(u.id);
        if(m) topic = String(m.key || '').replace(/^taught:/, '').replace(/_/g, ' ').trim().slice(0, 40);
      }catch(e){}
    }
    opener = (crystal && topic)
      ? `«${topic}» 는 이제 수정 구슬이 됐어! 종처럼 울리고 다녀도 돼.`
      : (topic ? `«${topic}» 를 배운 게 루미의 자랑이야. 종소리처럼 마을에 퍼뜨려 볼래?`
               : '종탑은 자랑할 때 가장 크게 울려. 오늘 뭘 배웠어?');
  }
  res.json({ ok:true, opener });
});

// ★ v1.54 «진짜 토큰 스트리밍» — 모델이 만드는 대로 흘려보낸다.
//   힌트 단계는 서버 상태기계가 이미 정하므로, 모델에게는 JSON 이 아니라 «순수 텍스트» 만 요구한다.
//   (JSON 을 요구하면 완성 전에는 화면에 아무것도 못 보여 준다 — 그게 기존 «가짜 스트리밍» 의 이유였다.)
app.post('/api/chat/stream', async (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const mode = ['chat','learn','reflect'].includes(b.mode) ? b.mode : 'chat';
  const msg = String(b.message || '').trim().slice(0,200);
  if(msg.length < 1) return res.status(400).json({error:'하고 싶은 말을 적어줄래?'});
  if(!isSafeText(msg)) return res.status(400).json({error:'다른 이야기를 해볼까요?'});
  const day = today();
  const used = chatCount(u.id, mode, day);
  const limit = CHAT_LIMITS[mode];
  if(used >= limit) return res.status(429).json({error:'오늘은 여기까지! 내일 또 이야기하자.'});

  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  if(res.flushHeaders) res.flushHeaders();
  let closed = false;
  // ★ req 의 close 는 «요청 본문을 다 읽었다» 는 뜻이라 곧바로 true 가 된다.
  //   클라이언트가 끊긴 것은 res 의 close 로 판단해야 한다(아니면 delta 를 전부 버린다).
  res.on('close', ()=>{ closed = true; });
  const send = (o)=>{ if(closed) return; try{ res.write(`data: ${JSON.stringify(o)}\n\n`); }catch(e){} };

  const c = buildChatContext(u, mode, msg, day, b.style);
  send({ type:'meta', mode, hintLevel: mode === 'learn' ? (c.direct ? null : c.wantLevel) : null,
    session: c.sess ? { stage:c.sess.stage, level:c.wantLevel, turns:(c.sess.turns||0)+1, stuckType:c.stuckGuess } : null,
    concept: c.knownConcept });

  // ★ v1.78: L1 은 LLM 을 부르지 않는다 — 카드의 «되묻기» 문장을 그대로 보낸다.
  //   모델이 매번 정의를 말해 «L1·L2·L3 가 다 같은 설명» 이 되던 문제를 규칙으로 고정(비용·지연도 절감).
  if(mode === 'learn' && !c.direct && (c.wantLevel || 1) <= 1 && c.focusCard && String(c.focusCard.hint_l1 || '').trim()){
    const line = `같이 생각해 보자. ${String(c.focusCard.hint_l1).trim()}`;
    try{
      saveChatTurn(u.id, msg, line, mode, { hintLevel: 1, topic: c.focusCard.topic });
      if(c.sess){
        db.prepare(`UPDATE chat_sessions SET stage='L1', stage_turns=1, turns=turns+1, concept=?, updated_at=datetime('now','+9 hours') WHERE id=?`)
          .run(c.knownConcept, c.sess.id);
      }
    }catch(e){}
    send({ type:'delta', text: line });
    send({ type:'done', ok:true, mode, reply: line, hintLevel: 1, followUp:null, explain:null,
      session: c.sess ? { stage:'L1', level:1, turns:(c.sess.turns || 0) + 1, stuckType: c.stuckGuess } : null,
      wrapUp:null, left: Math.max(0, limit - used - 1),
      understanding: (profileFor(u.id).understanding || 0), solved:false,
      balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
    return res.end();
  }

  const system = `너는 DOROBUS의 로봇 "${c.robot?c.robot.name:'루미'}"(성격: ${c.robot?c.robot.personality:'반짝이'})다.
대상: 초등 저학년~고학년(7-11세). 아주 쉬운 한국어.
이번 주 주제: "${c.topic.topic}"(CH.${c.topic.chapter}). 학습자 Lv.${u.level||1}, understanding ${c.profile.understanding||0}.
${c.moodNote}
[모드=${mode}] ${(typeof c !== 'undefined' ? c.direct : direct) ? DIRECT_RULE : CHAT_MODE_RULES[mode]}
${mode === 'learn' ? `[이번 대화] 목표: "${c.knownConcept}" · 지금 단계: L${c.wantLevel}${c.sess ? ` (이 단계 ${c.sess.stage_turns + 1}번째)` : ''} · 이미 해본 것: ${c.wantLevel > 1 ? 'L1 되묻기' : '없음'}${c.wantLevel > 2 ? ', L2 비유' : ''}
${c.sessionMemo ? `[지금까지의 대화]\n${c.sessionMemo}\n` : ''}[막힘 유형] ${c.stuckGuess} — ${STUCK_RULES[c.stuckGuess]}
${c.interest ? `[아이의 관심사] 비유는 «${c.interest}» 영역에서 들어 준다\n` : ''}${c.fade ? `[숙련도 높음] 힌트는 한 줄로만. 비유·예시를 덧붙이지 마라\n` : ''}${c.wantLevel <= 1 ? L1_CHOICE_RULE + '\n' : ''}${c.frustrated ? `[감정 신호] 아이가 좌절 중이다. 이번 턴은 새 힌트를 주지 말고, 한 문장으로 «틀려도 뇌가 자라는 거야» 류의 성장 마인드셋 다독임 + 편안해할 짧은 질문으로 마무리해라. 정답·힌트 금지.\n` : ''}${c.fogNote ? c.fogNote + '\n' : ''}[말하기] 두 문장·90자. 끝에 반드시 질문 1개. ${TAG_LINE_RULE}
` : ''}[지식 카드]
${c.cardText}
[루미가 기억하는 것]
${c.memText}
[출력] JSON 금지. 설명·머리말·이모지 없이 아이에게 말하듯 «순수 텍스트» 만 출력한다.`;

  const t0 = Date.now();
  let full = '';
  let llmRes = null;
  // ★ v1.70 ⑥: delta 차단 — 누적 텍스트에 «⟦» 가 나타나면 화면에는 그 앞부분만 보내고
  //   이후 delta 는 전부 끊는다(아이 화면에 태그가 노출되지 않게). 누적(acc)은 계속 쌓아
  //   done 시점에 parseTagLine 으로 본문만 꺼낸다.
  let tagSeen = false;
  let acc = '';
  const onDelta = (d)=>{
    if(tagSeen) return;
    acc += d;
    const idx = acc.indexOf('⟦');
    if(idx >= 0){
      tagSeen = true;
      const before = acc.slice(0, idx);
      if(before) send({ type:'delta', text: before });
      return;
    }
    send({ type:'delta', text: d });
  };
  try{
    llmRes = await callLLMStream('', {
      messages: [{ role:'system', content: system }, ...c.hist, { role:'user', content: msg }],
      temperature: mode === 'learn' ? 0.7 : 0.9,
      maxTokens: mode === 'learn' ? 140 : 170,
      // ★ v1.57 주석 정정: LLM_FORCE_FAST 기본값(true) 이면 prefer:'quality' 는 동작하지 않고
      //   모든 모드가 «싼 모델(DeepSeek) 우선» 이다. 품질 우선은 LLM_FORCE_FAST=0 일 때만 유효.
      prefer: (mode === 'learn' || mode === 'chat') ? 'quality' : 'fast',
      // ★ v1.58: 화면에서도 «두 문장» 을 지킨다 — 세 번째 문장이 시작되면 읽기를 멈춘다.
      maxSentences: mode === 'learn' ? 2 : 0,
    }, onDelta);
    full = (llmRes && llmRes.text) || '';
  }catch(e){ full = ''; }
  // ★ v1.70 ⑥: learn 모드는 누적 텍스트에서 태그 줄을 뗀다(저장·done.reply 에 태그가 남지 않는다).
  //   태그가 없으면 parseTagLine 은 원문을 그대로 돌려준다(기존 동작과 동일).
  let tagStuck = null;
  if(mode === 'learn'){
    const tl = parseTagLine(full);
    tagStuck = tl.stuck;
    full = tl.reply;
  }
  // ★ 계량은 반환값(llmRes) 기준 — 모듈 전역은 동시 요청에 오염된다.
  const us = (llmRes && llmRes.usage) || {};
  try{ db.prepare(`INSERT INTO llm_logs(user_id,mode,model,latency_ms,ok,
      prompt_tokens,completion_tokens,total_tokens,prompt_chars) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(u.id, mode, (llmRes && llmRes.model) || null, Date.now()-t0, full ? 1 : 0,
      us.prompt_tokens || null, us.completion_tokens || null, us.total_tokens || null,
      (llmRes && llmRes.promptChars) || null); }catch(e){}

  // 스트리밍에서는 이미 보낸 글을 되돌릴 수 없으므로, 저장·요약용 텍스트만 다듬는다.
  //   (안전 필터 길이 상한은 채팅 파이프라인 공통 600)
  let reply = sanitizeLine(String(full || '').trim(), 600, 600);
  if(!reply){
    reply = mode === 'learn'
      ? ((c.cards[0] && c.cards[0].hint_l1) || L1_FALLBACK_LINE)   // ★ v1.70 ③c: 폴백도 «두 가지 선택지» 예시로 통일
      : '지금은 생각이 잠깐 멈췄어. 다시 말해 줄래?';
    if(!full) send({ type:'delta', text: reply });
  }
  if(mode === 'learn') reply = limitSentences(reply, 2, 90);

  // ★ 정답 누설 차단 — 비스트리밍 /api/chat 과 같은 규칙. 스트리밍은 이미 보낸 delta 를
  //   되돌릴 수 없으므로, done 이벤트의 reply 로 «힌트 치환 텍스트» 를 내려
  //   최종 표시·저장이 누설본을 그대로 쓰지 않게 한다(프론트는 done.reply 를 최종 텍스트로 반영).
  let hintLevel = mode === 'learn' ? (c.direct ? null : c.wantLevel) : null;
  if(mode === 'learn' && /(정답은|정답:|```)/.test(reply)){
    reply = (c.cards[0] && c.cards[0].hint_l3) || '정답 대신 힌트를 줄게. 먼저 스스로 한 단계만 해 볼까?';
    hintLevel = 3;
    send({ type:'delta', text: reply });
  }

  // ★ v1.58: 스트리밍에도 «스스로 해결» 보상을 연결한다(비스트리밍과 같은 규칙·같은 상한).
  let solvedNow = false;
  if(mode === 'learn' && b.solved){
    const solvedToday = db.prepare('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND day=? AND solved=1')
      .get(u.id, day).c;
    if(solvedToday < 3){
      const learned = c.focusCard ? c.focusCard.topic : c.topic.topic;
      db.prepare('INSERT INTO learning_help_logs(user_id,day,subject,level,solved) VALUES(?,?,?,?,1)')
        .run(u.id, day, learned, c.wantLevel || 3);
      db.prepare('UPDATE users SET understanding = understanding + 3 WHERE id=?').run(u.id);
      db.prepare("UPDATE learner_profile SET understanding = understanding + 3, updated_at=datetime('now','+9 hours') WHERE user_id=?").run(u.id);
      grantCell(u.id, 5, 'learning');
      solvedNow = true;
      // ★ v1.70 ①: 스스로 해결 → 마스터리 가점(스트리밍 solvedNow 포함)
      bumpMastery(u.id, learned, 'solved');
      upsertMemory(u.id, { kind:'learning', key:'understood:'+learned, value:learned+' 이해',
        confidence:0.9, source:'chat' });
    }
  }
  if(mode === 'learn'){
    if(solvedNow) removeWeakTopic(u.id, c.focusCard ? c.focusCard.topic : c.topic.topic);
    else if((c.wantLevel || 1) >= 2 && c.focusCard) addWeakTopic(u.id, c.focusCard.topic);
  }

  let sessionInfo = null;
  if(mode === 'learn' && c.sess){
    // ★ v1.70 ④: 좌절 턴은 단계(stage)·단계 턴 수(stage_turns)를 동결한다.
    const nextStage = (c.direct || c.frustrated) ? c.sess.stage : ((c.gotIt && c.wantLevel >= 2) ? 'confirm' : ('L' + c.wantLevel));
    // ★ v1.78: 좌절 턴에도 단계 턴 수를 올린다(동결하면 다독임만 무한 반복).
    const stageTurns = c.direct ? (c.sess.stage_turns || 0) : ((nextStage === c.sess.stage) ? ((c.sess.stage_turns || 0) + 1) : 1);
    const memo = buildSessionSummary(c.sess.summary, msg, reply);
    // ★ v1.70 ⑥: 태그가 유효하면 규칙 추정보다 우선한다.
    const stuckType = tagStuck || c.stuckGuess;
    db.prepare(`UPDATE chat_sessions SET stage=?, stage_turns=?, turns=turns+1, concept=?, stuck_type=?,
      summary=?, updated_at=datetime('now','+9 hours') WHERE id=?`)
      .run(nextStage, stageTurns, c.knownConcept, stuckType, memo, c.sess.id);
    sessionInfo = { stage: nextStage, level: c.wantLevel, turns: (c.sess.turns||0)+1, stuckType };
  }
  saveChatTurn(u.id, msg, reply, mode, {
    hintLevel,   // ★ 누설 차단 시 3 로 저장(비스트리밍과 동일)
    followUp: null, solved: solvedNow,
    // ★ v1.70 ⑥: 태그로 확정된 막힘 유형을 분석에 전달
    stuckType: tagStuck || null,
    topic: c.focusCard ? c.focusCard.topic : null
  });

  const explain = (mode === 'learn' && c.wantLevel >= 3)
    ? { concept: c.focusCard ? c.focusCard.topic : '',
        prompt: '방금 이해한 걸 네 말로 설명해 줄래? 루미가 들을게.' }
    : null;
  // ★ v1.78: L3 인데 «다독임» 만 나오면 실제 «다음 한 단계» 로 덮어쓴다.
  //   (스트리밍은 생성 중 교체가 불가능하므로 done 이벤트의 reply 로 덮어쓴다 — 프론트가 이 값으로 갱신)
  if(mode === 'learn' && (c.wantLevel || 0) >= 3 && /(괜찮아|자라|숨 한 번|기분은|편안해|편해졌)/.test(reply)){
    const c3 = c.focusCard || {};
    reply = `${String(c3.hint_l3 || '').trim() || '먼저 한 단계만 해 보자.'} 지금 해 볼래?`;
  }
  const p2 = profileFor(u.id);
  send({ type:'done', ok:true, mode, reply, hintLevel,   // ★ 누설 차단 시 치환 텍스트+힌트 레벨 3
    followUp:null, explain, session: sessionInfo,
    wrapUp: (mode === 'learn' && sessionInfo && sessionInfo.turns >= 6)
      ? '오늘 대화는 여기까지. 내일 이어서 보자!' : null,
    left: Math.max(0, limit - used - 1), understanding: p2.understanding || 0, solved: solvedNow,
    // ★ v1.70 ④: 좌절 턴일 때만 frustration:true (프론트 표시용)
    ...(c.frustrated ? { frustration: true } : {}),
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  res.end();
});

app.get('/api/chat/history', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const rows = db.prepare('SELECT role,content,mode,hint_level,ts FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id).reverse();
  res.json({ ok:true, messages: rows });
});

// ───────── v1.40 대화 분석 API — 저장된 대화를 «읽어» 리포트를 만든다 ─────────
//  모든 쿼리는 user_id 로 스코프를 좁힌다(다른 아이의 대화/분석은 절대 조회되지 않는다).
app.get('/api/chat/analysis', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const d = today();
  const todayRow = db.prepare('SELECT * FROM chat_reports WHERE user_id=? AND day=?').get(u.id, d) || null;
  const week = db.prepare(`SELECT day,turns,user_words,stuck_count,solved_count,top_subject,mood,summary
    FROM chat_reports WHERE user_id=? AND day>=? ORDER BY day`).all(u.id, dayKST(-6));
  // v_chat_subject 뷰 — 집계 테이블을 또 만들지 않고 SQL 뷰로 최신 값을 읽는다
  const subjects = db.prepare(`SELECT subject,turns,stuck_count,solved_count,avg_words
    FROM v_chat_subject WHERE user_id=? ORDER BY turns DESC`).all(u.id);
  const intents = db.prepare(`SELECT intent, COUNT(*) c FROM chat_analyses
    WHERE user_id=? GROUP BY intent ORDER BY c DESC`).all(u.id);
  const totals = db.prepare(`SELECT COUNT(*) turns, SUM(stuck) stuck, SUM(solved) solved,
      SUM(question_count) questions, ROUND(AVG(word_count),1) avg_words,
      SUM(reply_has_hint) hints, SUM(reply_has_praise) praise
    FROM chat_analyses WHERE user_id=?`).get(u.id);
  const coverage = db.prepare(`SELECT
      (SELECT COUNT(*) FROM chat_messages WHERE user_id=? AND role='user') user_msgs,
      (SELECT COUNT(*) FROM chat_messages WHERE user_id=? AND role='assistant') ai_msgs,
      (SELECT COUNT(*) FROM chat_analyses WHERE user_id=?) analyzed`).get(u.id, u.id, u.id);
  const recent = db.prepare(`SELECT day,mode,subject,intent,sentiment,stuck,solved,keywords,word_count
    FROM chat_analyses WHERE user_id=? ORDER BY id DESC LIMIT 8`).all(u.id);
  const stuckWords = db.prepare(`SELECT keywords FROM chat_analyses
    WHERE user_id=? AND stuck=1 AND keywords<>'' ORDER BY id DESC LIMIT 20`).all(u.id);
  res.json({ ok:true, day:d, today:todayRow, week, subjects, intents, totals: totals || {},
    coverage: coverage || {}, recent, stuckWords,
    retainedDays: 30 });
});

// 원문 JOIN — «분석 1행이 실제 대화 1턴에 연결되어 있다» 는 것을 눈으로 확인하는 용도
app.get('/api/chat/analysis/messages', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const lim = Math.max(1, Math.min(100, Math.round(Number(req.query.limit) || 30)));
  const rows = db.prepare(`SELECT ca.id, ca.day, ca.mode, ca.subject, ca.intent, ca.sentiment,
      ca.stuck, ca.solved, ca.keywords, ca.word_count, ca.hint_level, cm.content
    FROM chat_analyses ca LEFT JOIN chat_messages cm ON cm.id = ca.user_msg_id
    WHERE ca.user_id=? ORDER BY ca.id DESC LIMIT ?`).all(u.id, lim);
  res.json({ ok:true, limit:lim, messages:rows });
});

// 실제 sqlite_master DDL 을 그대로 내려준다 — 발표 자료의 «데이터베이스 설계» 가 코드와 일치한다는 증거
app.get('/api/chat/analysis/schema', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name IN ('chat_messages','chat_analyses','chat_reports','v_chat_subject')
    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all();
  const indexes = db.prepare(`SELECT name,tbl_name,sql FROM sqlite_master
    WHERE type='index' AND tbl_name IN ('chat_messages','chat_analyses','chat_reports')
      AND sql IS NOT NULL ORDER BY name`).all();
  res.json({ ok:true, objects, indexes });
});

// 과거 대화도 분석 파이프라인에 편입한다. 멱등이라 몇 번 실행해도 숫자가 불어나지 않는다.
app.post('/api/chat/analysis/rebuild', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const rows = db.prepare('SELECT id,role,content,mode,hint_level,ts FROM chat_messages WHERE user_id=? ORDER BY id').all(u.id);
  const exist = db.prepare('SELECT 1 FROM chat_analyses WHERE user_msg_id=?');
  let rebuilt = 0, paired = 0;
  for(let i=0; i<rows.length; i++){
    const m = rows[i];
    if(m.role !== 'user' || exist.get(m.id)) continue;
    const a = (rows[i+1] && rows[i+1].role === 'assistant') ? rows[i+1] : null;
    if(a) paired++;
    try{
      recordChatAnalysis(u.id, m.id, a ? a.id : null, m.content, a ? a.content : '', m.mode || 'chat',
        { day: String(m.ts || today()).slice(0,10), hintLevel: m.hint_level });
      rebuilt++;
    }catch(e){ console.warn('[chat rebuild]', e && e.message); }
  }
  res.json({ ok:true, rebuilt, paired,
    userMessages: rows.filter(r=>r.role==='user').length,
    totalMessages: rows.length });
});

// 대화 초기화 시 «분석 결과» 도 함께 지운다 — 원문만 지우면 고아 분석행이 남는다.
// ★ chat_sessions(힌트 단계 상태)도 같이 지운다 — 안 그러면 다음 대화가 «어제 단계»에서 이어진다.
app.post('/api/chat/reset', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  db.prepare('DELETE FROM chat_analyses WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM chat_reports WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM chat_messages WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM chat_sessions WHERE user_id=?').run(u.id);
  db.prepare("UPDATE learner_profile SET last_summary=NULL, updated_at=datetime('now','+9 hours') WHERE user_id=?").run(u.id);
  res.json({ ok:true });
});

// ---- 방 상태: 이해도 → 조명/책장 ----
app.get('/api/room/state', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const p = profileFor(u.id);
  const solved = db.prepare('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1').get(u.id).c;
  const understanding = p.understanding || 0;
  res.json({ ok:true, understanding, level:u.level||1, stage:growthStage(u.level||1),
             solved, books: Math.min(12, solved),
             lit: Math.max(0, Math.min(1, understanding / 30)) });
});

// ---- 오늘의 퍼즐: 3문제 세트, 정답은 서버에만 ----
function seededShuffle(arr, seed){
  const a = arr.slice();
  let s = Math.abs(Number(seed) || 1) % 2147483647 || 1;
  for(let i=a.length-1;i>0;i--){
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function puzzleSeed(uid){ return [...today()].reduce((a,c)=>a*31 + c.charCodeAt(0), uid * 97); }
// ★ 오늘의 퍼즐 카드 id 집합 재계산 — hint_l3(사실상 정답)를 이 집합에만 내려 주기 위함
function dailyPuzzleIds(uid){
  const all = db.prepare('SELECT id FROM knowledge_cards ORDER BY id').all();
  return seededShuffle(all, puzzleSeed(uid)).slice(0, 3).map(c=>c.id);
}
// ★ 마지막 연습 세트(메모리) — 연습 모드는 매번 재추첨이므로 이번에 실제로 준 카드만 기억한다
const lastPracticeSet = new Map(); // user_id → { day, ids:[...] }
app.get('/api/puzzle/today', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const all = db.prepare('SELECT * FROM knowledge_cards ORDER BY id').all();
  const seed = puzzleSeed(u.id);
  // ★ 2026-10-28: 연습 모드는 5문제·보상 없음. 오늘의 퍼즐은 3문제·+30셀.
  const practice = !!(req.query && String(req.query.practice) === '1');
  const count = practice ? 5 : 3;
  const picked = practice
    ? seededShuffle(all, Date.now() + u.id).slice(0, count)
    : seededShuffle(all, seed).slice(0, count);
  if(practice) lastPracticeSet.set(u.id, { day: today(), ids: picked.map(c=>c.id) });
  const questions = picked.map(c=>{
    let quiz = {}; try{ quiz = JSON.parse(c.quiz || '{}'); }catch(e){}
    // ★ hint_l3 는 대부분 «다음 단계» 를 알려줘 사실상 정답이다 — 오늘의 퍼즐 응답에 담지 않고,
    //   아이가 요청할 때만 POST /api/puzzle/hint(level=3) 로 꺼내 준다.
    return { cardId:c.id, topic:c.topic, question:quiz.q, options:quiz.options || [],
             hints:[c.hint_l1, c.hint_l2] };
  });
  const done = practice ? false
    : !!db.prepare("SELECT id FROM game_logs WHERE user_id=? AND day=? AND kind='puzzle'").get(u.id, today());
  res.json({ ok:true, questions, reward: practice ? 0 : 30, done, practice });
});

// ★ 힌트 요청(필요할 때만 한 단계씩) — 퍼즐 목록 응답에는 hint_l3 를 실어 보내지 않는다.
//   요청: POST /api/puzzle/hint  body: { cardId:Number, level:1|2|3 }  (X-Token 인증)
//   응답: { ok:true, level, text:'힌트 문장' }  — level=3 일 때만 hint_l3 를 돌려준다.
app.post('/api/puzzle/hint', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const card = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(Number(b.cardId)||0);
  if(!card) return res.status(404).json({error:'문제를 찾을 수 없어요'});
  const level = Math.max(1, Math.min(3, Number(b.level)||1));
  // ★ L3 힌트는 사실상 정답 — 오늘의 퍼즐(또는 직전 연습 세트)에 포함된 카드에만 내려 준다.
  //   그 외 카드를 열거해 정답 힌트를 긁어 가는 것을 막는다.
  const ps = lastPracticeSet.get(u.id);
  const allowed = level < 3
    || dailyPuzzleIds(u.id).includes(card.id)
    || (ps && ps.day === today() && ps.ids.includes(card.id));
  const text = level === 1 ? card.hint_l1 : level === 2 ? card.hint_l2 : card.hint_l3;
  res.json({ ok:true, level, text: (allowed ? text : null) || '이 문제엔 준비된 힌트가 없어. 한 번 더 생각해 보자!' });
});

app.post('/api/puzzle/answer', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  // v1.37: firstTryCount = «첫 시도에 맞힌 문제 수(0~3)». hintsLeft 는 «정답 공개» 판단에만 쓴다.
  const body = req.body || {};
  const { cardId, choice, final, firstTryCount, hintsLeft } = body;
  const card = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(Number(cardId)||0);
  if(!card) return res.status(400).json({error:'문제를 찾을 수 없어요'});
  let quiz = {}; try{ quiz = JSON.parse(card.quiz || '{}'); }catch(e){}
  if(Number(choice) !== Number(quiz.answer)){
    // ★ 2026-10-31: 틀린 문제를 3일 뒤 복습 카드로 예약
    try{
      const due = dayKST(3);
      db.prepare(`INSERT INTO review_cards(user_id,card_id,topic,question,options_json,answer,wrong_count,due_date,done)
        VALUES(?,?,?,?,?,?,1,?,0)
        ON CONFLICT(user_id,card_id,due_date) DO UPDATE SET wrong_count=wrong_count+1, done=0`)
        .run(u.id, card.id, card.topic, quiz.q || '틀린 문제', JSON.stringify(quiz.options||[]), Number(quiz.answer), due);
    }catch(e){}
    // ★ v1.70 ①: 오답 → 마스터리 감점. 같은 문제를 하루에 여러 번 «틀린 채 재전송» 해 점수를
    //   끌어내리는 재전송 공격을 막기 위해, 개념당 하루 1회만 반영한다(daily_counters 가드).
    //   bumpDailyCounter 의 반환값(증가 후 현재값)이 1일 때만 = 오늘 첫 오답일 때만 반영한다.
    if(bumpDailyCounter(u.id, today(), 'puzzle_wrong:' + card.id) === 1){
      bumpMastery(u.id, card.topic, 'wrong');
    }
    const out = { ok:true, correct:false, hint: card.hint_l2 || '한 번 더 생각해 보자.' };
    // v1.37: 힌트를 다 쓴 뒤 또 틀리면 «정답을 알려주고» 다음 문제로 넘어갈 수 있게 한다(P3)
    if(Number(hintsLeft) <= 0){ out.reveal = Number(quiz.answer); out.next = true; }
    return res.json(out);
  }
  // 마지막 문제가 아니면 정답 여부만 알려주고, 보상은 세트 마지막에 한 번만 준다.
  if(!final){
    return res.json({ ok:true, correct:true, reward:0 });
  }
  // v1.37 «정확도» 축 — 첫 시도에 맞힌 문제 수 f 로 20~45셀 (전부 맞히면 +10 보너스)
  let f;
  if (firstTryCount !== undefined) f = Number(firstTryCount);
  else if (body.firstTry !== undefined)
    f = (typeof body.firstTry === 'boolean' ? (body.firstTry ? 3 : 0) : Number(body.firstTry));
  else f = 3;                       // 옛 클라이언트 = «전부 첫 시도 정답» 으로 간주(하위 호환)
  f = Math.max(0, Math.min(3, Number.isFinite(f) ? f : 0));
  const reward = 20 + 5 * f + (f >= 3 ? 10 : 0);
  try{
    db.prepare("INSERT INTO game_logs(user_id,day,kind,score,reward) VALUES(?,?,?,?,?)")
      .run(u.id, today(), 'puzzle', f, reward);
  }catch(e){ return res.status(400).json({error:'오늘은 이미 풀었어!'}); }
  // ★ v1.70 ①: 정답 → 마스터리 가점. game_logs UNIQUE(user,day,kind) 가드 덕에 하루 1회만 여기 온다.
  //   (중간 문제(!final) 정답은 재전송으로 점수를 올릴 수 있어 가점을 넣지 않는다)
  bumpMastery(u.id, card.topic, 'correct');
  grantCell(u.id, reward, 'game');
  const g = addExp(u.id, 15);
  res.json({ ok:true, correct:true, reward, firstTry:f, growth:g,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ★ 2026-10-31: 3일 뒤 복습 카드
app.get('/api/review/due', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const rows = db.prepare(`SELECT id,topic,question,options_json,wrong_count,due_date
    FROM review_cards WHERE user_id=? AND done=0 AND due_date<=?
    ORDER BY due_date ASC, id ASC LIMIT 5`).all(u.id, today());
  res.json({ ok:true, count:rows.length,
    cards: rows.map(r=>({ id:r.id, topic:r.topic, question:r.question,
      options:(()=>{ try{ return JSON.parse(r.options_json||'[]'); }catch(e){ return []; } })(),
      wrongCount:r.wrong_count, dueDate:r.due_date })) });
});
app.post('/api/review/answer', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const r = db.prepare('SELECT * FROM review_cards WHERE id=? AND user_id=?').get(Number(b.id)||0, u.id);
  if(!r) return res.status(404).json({error:'복습 카드를 찾을 수 없어요'});
  if(r.done) return res.json({ ok:true, already:true, correct:true, reward:0 });
  if(Number(b.choice) !== Number(r.answer)){
    db.prepare('UPDATE review_cards SET wrong_count=wrong_count+1, due_date=? WHERE id=?').run(dayKST(1), r.id);
    const card = db.prepare('SELECT hint_l2 FROM knowledge_cards WHERE id=?').get(r.card_id);
    return res.json({ ok:true, correct:false, hint:(card && card.hint_l2) || '한 번 더 생각해 보자.' });
  }
  db.prepare('UPDATE review_cards SET done=1 WHERE id=?').run(r.id);
  // ★ v1.70 ①: 복습 정답 → 마스터리 가점(done 플래그가 재전송을 막아 하루 1회만 반영된다)
  bumpMastery(u.id, r.topic, 'review');
  grantCell(u.id, 5, 'review');
  const card = db.prepare('SELECT analogy FROM knowledge_cards WHERE id=?').get(r.card_id);
  res.json({ ok:true, correct:true, reward:5, explain:(card && card.analogy) || '',
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- AI 마을 «지혜의 샘» 학습 스테이션 (2026-11-02) ----
//   마을 외곽 3곳에서 하루 1문제씩. 지식카드 quiz 를 (user,day,station) 로 결정론적 배정.
const WORLD_ST = 3;
function parseQuizJSON(raw){
  try{
    const j = JSON.parse(raw || '{}');
    if(!j || !j.q || !Array.isArray(j.options) || j.options.length < 2) return null;
    return { q:String(j.q), options:j.options.map(String), answer:Math.max(0, Number(j.answer)||0) };
  }catch(e){ return null; }
}
function ensureWorldLesson(uid, station){
  const d = today();
  const hit = db.prepare('SELECT * FROM world_lessons WHERE user_id=? AND day=? AND station=?').get(uid, d, station);
  if(hit) return hit;
  const cards = db.prepare("SELECT id FROM knowledge_cards WHERE quiz IS NOT NULL AND quiz<>'' ORDER BY id").all();
  if(!cards.length) return null;
  const seed = Math.abs(uid * 37 + Number(String(d).replace(/-/g,'')) * 11 + station * 7);
  const cardId = cards[seed % cards.length].id;
  try{ db.prepare('INSERT OR IGNORE INTO world_lessons(user_id,day,station,card_id) VALUES(?,?,?,?)')
        .run(uid, d, station, cardId); }catch(e){}
  return db.prepare('SELECT * FROM world_lessons WHERE user_id=? AND day=? AND station=?').get(uid, d, station);
}
app.get('/api/world/lesson', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const out = [];
  for(let i=0;i<WORLD_ST;i++){
    const row = ensureWorldLesson(u.id, i);
    if(!row) continue;
    const c = db.prepare('SELECT id,topic,concept,analogy,quiz FROM knowledge_cards WHERE id=?').get(row.card_id);
    const qz = c ? parseQuizJSON(c.quiz) : null;
    if(!qz) continue;
    out.push({ station:i, topic:c.topic, concept:c.concept,
               q:qz.q, options:qz.options, solved:!!row.solved, wrong:row.wrong|0 });
  }
  res.json({ ok:true, stations:out, done: out.filter(x=>x.solved).length, total: out.length });
});
app.post('/api/world/lesson/answer', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const b = req.body || {};
  const st = Number(b.station);
  if(!(st >= 0 && st < WORLD_ST)) return res.status(400).json({ error:'잘못된 스테이션이에요' });
  const row = ensureWorldLesson(u.id, st);
  if(!row) return res.status(404).json({ error:'문제를 찾을 수 없어요' });
  if(row.solved) return res.json({ ok:true, already:true, correct:true, reward:0 });
  const c = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(row.card_id);
  const qz = c ? parseQuizJSON(c.quiz) : null;
  if(!qz) return res.status(404).json({ error:'문제를 찾을 수 없어요' });
  if(Number(b.choice) !== qz.answer){
    db.prepare('UPDATE world_lessons SET wrong=wrong+1 WHERE id=?').run(row.id);
    return res.json({ ok:true, correct:false,
      hint: (c && c.hint_l2) || '한 번 더 생각해 보자.' });
  }
  db.prepare('UPDATE world_lessons SET solved=1 WHERE id=?').run(row.id);
  // ★ v1.70 ①: 마을 수업 정답 → 마스터리 가점(solved 플래그가 재전송을 막는다)
  bumpMastery(u.id, c.topic, 'lesson');
  grantCell(u.id, 5, 'world_lesson');
  const doneCnt = db.prepare('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day=? AND solved=1').get(u.id, today()).c;
  res.json({ ok:true, correct:true, reward:5, done:doneCnt, total:WORLD_ST,
    explain: (c && c.analogy) || '',
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- AI 마을 보물찾기 · 별똥별 (2026-11-04) ----
//   하루 5개 보물상자 + 가끔 떨어지는 별똥별. 둘 다 셀 보상.
const TREASURE_SPOTS = 5;
app.get('/api/world/treasure', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const d = today();
  const got = new Set(db.prepare('SELECT spot FROM treasure_claims WHERE user_id=? AND day=?').all(u.id, d).map(r=>r.spot));
  const spots = [];
  for(let i=0;i<TREASURE_SPOTS;i++) spots.push({ i, claimed: got.has(i) });
  res.json({ ok:true, spots, left: TREASURE_SPOTS - got.size, total: TREASURE_SPOTS });
});
app.post('/api/world/treasure', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const i = Number((req.body||{}).spot);
  if(!(i >= 0 && i < TREASURE_SPOTS)) return res.status(400).json({ error:'잘못된 위치예요' });
  const d = today();
  const r = db.prepare('INSERT OR IGNORE INTO treasure_claims(user_id,day,spot) VALUES(?,?,?)').run(u.id, d, i);
  if(!r.changes) return res.json({ ok:true, already:true, reward:0 });
  grantCell(u.id, 8, 'treasure');
  const left = TREASURE_SPOTS - db.prepare('SELECT COUNT(*) c FROM treasure_claims WHERE user_id=? AND day=?').get(u.id, d).c;
  res.json({ ok:true, reward:8, left,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});
app.post('/api/world/starfall', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const d = today();
  // ★ cell_tx 에는 created_at 이 없다(ts 컬럼 사용) — 잘못된 컬럼명으로 조회가 항상 실패했었다
  const c = db.prepare("SELECT COUNT(*) c FROM cell_tx WHERE user_id=? AND source='starfall' AND substr(ts,1,10)=?").get(u.id, d).c;
  if(c >= 5) return res.json({ ok:true, capped:true, reward:0 });
  grantCell(u.id, 3, 'starfall');
  res.json({ ok:true, reward:3, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- 마을 성장 · 지식 도감 · 컴백 카드 · 방명록 (2026-11-03) ----
//   마을은 «내가 한 만큼» 자란다. 성과 지표에서 자격 키를 계산해 village_props 에 한 번만 기록한다.
function villageStats(uid){
  const solved = db.prepare('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND solved=1').get(uid).c;
  const codex  = db.prepare('SELECT COUNT(DISTINCT card_id) c FROM world_lessons WHERE user_id=? AND solved=1').get(uid).c;
  const u = db.prepare('SELECT streak FROM users WHERE id=?').get(uid) || { streak:0 };
  return { solved, codex, streak: u.streak || 0 };
}
function villageKeys(st){
  const keys = [];
  for (let i = 1; i <= 10; i++) if (st.solved >= i) keys.push('tree_' + i);
  if (st.streak >= 3) keys.push('lantern_1');
  if (st.streak >= 7) keys.push('lantern_2');
  if (st.codex >= 4) keys.push('bench_1');
  if (st.codex >= 8) keys.push('banner_1');
  if (st.solved >= 15) keys.push('fountain');
  return keys;
}
function syncVillage(uid){
  const st = villageStats(uid);
  const keys = villageKeys(st);
  const ins = db.prepare('INSERT OR IGNORE INTO village_props(user_id,prop_key) VALUES(?,?)');
  keys.forEach(k => { try{ ins.run(uid, k); }catch(e){} });
  const have = db.prepare('SELECT prop_key FROM village_props WHERE user_id=? ORDER BY id').all(uid).map(r => r.prop_key);
  return { st, keys: have };
}
app.get('/api/world/village', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const { st, keys } = syncVillage(u.id);
  res.json({ ok:true, props:keys, stats:st });
});

// ---------- ★ v1.44 «멈춘 마을을 다시 켜기» : 크로스데이 핵심 시스템 ----------
//   게임 «한 판» 이 아니라, 날짜가 바뀌면 마을이 스스로 낡아가고 고친 흔적은 영구히 남는다.
//   - 모든 변화는 (user_id, day) 시드로 결정론적 → 크론 없이 요청 시점에 물화(materialize)한다.
//   - 안 온 날도 벌점 없이 누적만 되고, 돌아오면 그대로 이어서 고칠 수 있다.
//   - 셀 은 지급하지 않는다: 일 수입 상한 393셀 < 일회성 상품 400셀 균형을 깨지 않기 위해서다.
//     대신 등급·도감·별빛 조각·3D 세계 변화·내일 예고가 보상이다.
const CAMP_FACILITIES = [
  { key:'well',      name:'마을 우물',     icon:'💧', blurb:'물이 조금 흐려졌어' },
  { key:'mill',      name:'낡은 풍차',     icon:'🌬️', blurb:'날개가 멈춰 있어' },
  { key:'bell',      name:'시계탑 종',     icon:'🔔', blurb:'종소리가 늦게 울어' },
  { key:'laundry',   name:'빨래터 세탁기', icon:'🧺', blurb:'통이 돌다 말았어' },
  { key:'generator', name:'별빛 발전기',   icon:'✨', blurb:'불이 깜빡거려' }
];
const CAMP_KEYS = CAMP_FACILITIES.map(f => f.key);
const CAMP_GRADES = [
  { n:0,  badge:'새내기 정비사' }, { n:3,  badge:'고침 정비사' },
  { n:8,  badge:'별빛 정비사'  }, { n:15, badge:'길찾는 정비사' },
  { n:25, badge:'질문하는 정비사' }
];
// 프론트 RP_MACHINES[level-1] 과 1:1 로 맞추는 «정답 범위» (서버 검증용)
const CAMP_LEVELS = [
  { lamps:2, faults:1, spares:2 },
  { lamps:3, faults:2, spares:2 },
  { lamps:3, faults:3, spares:2 }
];
const CAMP_ACTS = [
  { title:'1막 · 이상한 소리', body:'오늘 아침 마을 어딘가에서 멈춘 기계 소리가 났대. 어디가 굳었는지부터 살펴보자.' },
  { title:'2막 · 끊긴 길',     body:'전기가 위에서부터 막혔나 봐. 가장 위의 멈춘 부품을 고치면 아래도 같이 살아날 거야.' },
  { title:'3막 · 다시 켜졌다', body:'불이 켜졌어! 오늘 고친 건 내일도 그대로 돌고 있을 거야. 정비 기록에 남겨 둘게.' }
];
const CAMP_DAILY_LIMIT = 2;

function campRnd(uid, day, salt){
  let h = 2166136261 ^ Number(uid || 0);
  const s = String(day) + '|' + String(salt || '');
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ()=>{ h ^= h<<13; h ^= h>>>17; h ^= h<<5; return (h>>>0)/4294967296; };
}
function campShiftDay(d, n){
  const p = String(d).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1]-1, p[2]) + n*86400000).toISOString().slice(0,10);
}
function campNextDay(d){ return campShiftDay(d, 1); }
// «그날 이상이 생기는 시설 2곳» — 내일 예고와 실제 내일이 반드시 같은 값을 쓴다.
function campFaultsFor(uid, day){
  const r = campRnd(uid, day, 'fault');
  const idx = CAMP_FACILITIES.map((_,i)=>i);
  for(let i=idx.length-1;i>0;i--){ const j=Math.floor(r()*(i+1)); [idx[i],idx[j]]=[idx[j],idx[i]]; }
  return [CAMP_FACILITIES[idx[0]].key, CAMP_FACILITIES[idx[1]].key];
}
function campAdvance(uid, day){
  const ins = db.prepare('INSERT OR IGNORE INTO campaign_facilities(user_id,facility_key,condition,level,repairs,last_roll,updated_at) VALUES(?,?,?,1,0,?,?)');
  const initR = campRnd(uid, 'init', 'cond');
  CAMP_FACILITIES.forEach(f => { try{ ins.run(uid, f.key, 60+Math.floor(initR()*16), day, day); }catch(e){} });
  const upd = db.prepare('UPDATE campaign_facilities SET condition=?, last_roll=?, updated_at=? WHERE user_id=? AND facility_key=?');
  for(const f of CAMP_FACILITIES){
    const row = db.prepare('SELECT * FROM campaign_facilities WHERE user_id=? AND facility_key=?').get(uid, f.key);
    if(!row) continue;
    let roll = row.last_roll || day;
    let cond = row.condition;
    let guard = 0;
    while(roll < day && guard < 60){
      roll = campNextDay(roll); guard++;
      const faults = campFaultsFor(uid, roll);
      const r = campRnd(uid, roll, 'decay');
      cond = Math.max(0, cond - (2 + Math.floor(r()*4)) - (faults.includes(f.key) ? 8 : 0));
    }
    if(guard) { try{ upd.run(cond, roll, roll, uid, f.key); }catch(e){} }
  }
  // 오늘의 «이상» 이벤트 — UNIQUE 라 몇 번 불러도 같은 하루는 한 번만 생긴다.
  const evIns = db.prepare('INSERT OR IGNORE INTO campaign_events(user_id,day,facility_key,kind,delta) VALUES(?,?,?,?,?)');
  campFaultsFor(uid, day).forEach(k => { try{ evIns.run(uid, day, k, 'fault', -8); }catch(e){} });
}
function campGrade(total){
  let i = 0;
  CAMP_GRADES.forEach((g, k)=>{ if(total >= g.n) i = k; });
  return { index:i+1, badge:CAMP_GRADES[i].badge,
    nextAt: CAMP_GRADES[i+1] ? CAMP_GRADES[i+1].n : null, repairs:total };
}
function campState(uid, day){
  campAdvance(uid, day);
  const rows = db.prepare('SELECT * FROM campaign_facilities WHERE user_id=?').all(uid);
  const evs  = db.prepare('SELECT * FROM campaign_events WHERE user_id=? AND day=?').all(uid, day);
  const journal = db.prepare('SELECT * FROM campaign_journal WHERE user_id=? ORDER BY id DESC LIMIT 10').all(uid);
  const total = rows.reduce((a,r)=>a+(r.repairs||0), 0);
  const topic = currentTopic();
  const chapter = STORY_CHAPTERS[topic.chapter] || STORY_CHAPTERS[1];
  const actIdx = Math.min(2, (Number(String(day).slice(8,10)) || 1) % 3);
  const tomorrow = campNextDay(day);
  const tm = CAMP_FACILITIES.find(f => f.key === campFaultsFor(uid, tomorrow)[0]);
  const todayCount = db.prepare("SELECT COUNT(*) c FROM campaign_journal WHERE user_id=? AND day=? AND kind='repair'").get(uid, day).c;
  const facilities = CAMP_FACILITIES.map(f => {
    const r = rows.find(x=>x.facility_key===f.key) || {};
    const ev = evs.find(e=>e.facility_key===f.key);
    const lv = r.level || 1;
    return { key:f.key, name:f.name, icon:f.icon, blurb:f.blurb,
      condition:r.condition ?? 70, level:lv, repairs:r.repairs || 0,
      abnormal:!!(ev && !ev.solved), solvedToday:!!(ev && ev.solved),
      needs:Math.max(0, lv*2 - (r.repairs||0)) };
  });
  return {
    ok:true, day, tomorrow,
    chapter:{ week:topic.week, chapter:topic.chapter, topic:topic.topic,
      badge:chapter.badge, line:chapter.line },
    act:{ index:actIdx+1, title:CAMP_ACTS[actIdx].title, body:CAMP_ACTS[actIdx].body },
    grade:campGrade(total),
    dailyLimit:CAMP_DAILY_LIMIT, todayCount,
    shards:Math.min(8, total),
    facilities,
    tomorrowNote:`내일은 ${tm.name}에 이상이 생길 것 같아… 와서 확인해 줄래?`,
    tomorrowKey:tm.key,
    journal:journal.map(j=>({ day:j.day, kind:j.kind, key:j.facility_key, title:j.title,
      body:j.body, score:j.score, lamps:j.lamps, spares:j.spares, ts:j.ts }))
  };
}
app.get('/api/campaign/state', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  res.json(campState(u.id, today()));
});
app.get('/api/campaign/facility', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const day = today();
  campAdvance(u.id, day);
  const key = String(req.query.key || '');
  if(!CAMP_KEYS.includes(key)) return res.status(400).json({ error:'없는 시설이야' });
  const ev = db.prepare('SELECT * FROM campaign_events WHERE user_id=? AND day=? AND facility_key=?').get(u.id, day, key);
  if(!ev || ev.solved) return res.status(400).json({ error:'지금은 고칠 곳이 없어' });
  const f = db.prepare('SELECT * FROM campaign_facilities WHERE user_id=? AND facility_key=?').get(u.id, key);
  const lv = Math.min(3, f ? f.level : 1);
  res.json({ ok:true, key, level:lv, ...CAMP_LEVELS[lv-1],
    facility:CAMP_FACILITIES.find(x=>x.key===key) });
});
app.post('/api/campaign/repair', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const day = today();
  campAdvance(u.id, day);
  const b = req.body || {};
  const key = String(b.key || '');
  if(!CAMP_KEYS.includes(key)) return res.status(400).json({ error:'없는 시설이야' });
  const ev = db.prepare('SELECT * FROM campaign_events WHERE user_id=? AND day=? AND facility_key=?').get(u.id, day, key);
  if(!ev || ev.solved) return res.status(400).json({ error:'오늘은 이미 고쳤거나 이상이 없어요' });
  const cnt = db.prepare("SELECT COUNT(*) c FROM campaign_journal WHERE user_id=? AND day=? AND kind='repair'").get(u.id, day).c;
  if(cnt >= CAMP_DAILY_LIMIT) return res.status(400).json({ error:'오늘은 여기까지! 내일 또 고치자' });
  const f = db.prepare('SELECT * FROM campaign_facilities WHERE user_id=? AND facility_key=?').get(u.id, key);
  const lv = Math.min(3, f ? f.level : 1);
  const cap = CAMP_LEVELS[lv-1];
  const lampN = Math.max(0, Math.min(cap.lamps, Number(b.lamps)||0));
  const scoreN = Math.max(0, Math.min(9999, Number(b.score)||0));
  const spareN = Math.max(0, Math.min(cap.spares, Number(b.spares)||0));
  const cond = Math.min(100, (f ? f.condition : 60) + 25 + lampN*5);
  const repairs = (f ? f.repairs : 0) + 1;
  let level = lv, levelUp = false;
  if(lampN > 0 && repairs >= level*2 && cond >= 90 && level < 3){ level++; levelUp = true; }
  const beforeTotal = db.prepare('SELECT COALESCE(SUM(repairs),0) s FROM campaign_facilities WHERE user_id=?').get(u.id).s;
  db.prepare('UPDATE campaign_facilities SET condition=?, level=?, repairs=?, last_serviced=?, updated_at=? WHERE user_id=? AND facility_key=?')
    .run(cond, level, repairs, day, day, u.id, key);
  db.prepare('UPDATE campaign_events SET solved=1 WHERE user_id=? AND day=? AND facility_key=?').run(u.id, day, key);
  const fac = CAMP_FACILITIES.find(x=>x.key===key);
  db.prepare('INSERT INTO campaign_journal(user_id,day,kind,facility_key,title,body,score,lamps,spares) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(u.id, day, 'repair', key, `${fac.name} 정비`,
      lampN >= cap.lamps ? '모든 등이 켜졌어' : `${lampN}개의 등을 살렸어`, scoreN, lampN, spareN);
  // 세계에 영구 흔적 — 다음 날 들어와도 «어제 고친 것» 이 남아 있다.
  try{ db.prepare('INSERT OR IGNORE INTO village_props(user_id,prop_key) VALUES(?,?)')
    .run(u.id, `campaign_${key}_lv${level}`); }catch(e){}
  const gradeUp = CAMP_GRADES.some(g => g.n > beforeTotal && g.n <= beforeTotal + 1);
  const st = campState(u.id, day);
  res.json({ ok:true, condition:cond, level, levelUp, gradeUp,
    grade:st.grade, shards:st.shards, tomorrowNote:st.tomorrowNote,
    todayCount:st.todayCount, state:st });
});
app.get('/api/campaign/journal', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const rows = db.prepare('SELECT * FROM campaign_journal WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id);
  res.json({ ok:true, journal:rows.map(j=>({ day:j.day, kind:j.kind, key:j.facility_key,
    title:j.title, body:j.body, score:j.score, lamps:j.lamps, spares:j.spares, ts:j.ts })) });
});
// 발표/검증용: 내일 예고가 «진짜 내일» 과 같은지, 그리고 날짜를 되돌려 «다음 날 변화» 를 재현한다.
//   ADMIN_KEY 가 없으면 503 이므로 일반 사용자는 쓸 수 없다.
app.get('/api/admin/campaign/probe', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const day = String(req.query.day || today());
  res.json({ ok:true, day, faults:campFaultsFor(u.id, day) });
});
app.post('/api/admin/campaign/rewind', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const n = Math.max(1, Math.min(30, Number((req.body||{}).days) || 1));
  const back = campShiftDay(today(), -n);
  db.prepare('UPDATE campaign_facilities SET last_roll=? WHERE user_id=?').run(back, u.id);
  db.prepare('DELETE FROM campaign_events WHERE user_id=? AND day>?').run(u.id, back);
  res.json({ ok:true, rewind:n, state:campState(u.id, today()) });
});

app.get('/api/codex', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const rows = db.prepare('SELECT id,topic,chapter,concept,analogy,example FROM knowledge_cards ORDER BY chapter, id').all();
  const got = new Set(db.prepare('SELECT DISTINCT card_id FROM world_lessons WHERE user_id=? AND solved=1')
    .all(u.id).map(r => r.card_id));
  const cards = rows.map(r => ({
    id:r.id, topic:r.topic, chapter:r.chapter,
    concept:r.concept || '', analogy:r.analogy || '', example:r.example || '',
    unlocked: got.has(r.id)
  }));
  res.json({ ok:true, total:cards.length, unlocked:cards.filter(c=>c.unlocked).length, cards });
});

// 컴백 카드 — 아이가 앱을 열었을 때 루미가 먼저 말을 거는 한 줄
app.get('/api/comeback', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ ok:true, card:null });
  const due = db.prepare('SELECT COUNT(*) c FROM review_cards WHERE user_id=? AND done=0 AND due_date<=?').get(u.id, today()).c;
  const solvedToday = db.prepare('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day=? AND solved=1').get(u.id, today()).c;
  const streak = u.streak || 0;
  const left = Math.max(0, 3 - solvedToday);
  let card = null;
  if (due > 0) card = { kind:'review', icon:'🔁', text:`어제 틀린 문제 ${due}개가 기다리고 있어. 3분만 같이 볼까?`, cta:'복습하기', target:'review' };
  else if (left > 0) card = { kind:'world', icon:'📖', text:`오늘의 지혜 샘 ${left}곳이 아직 비어 있어. 같이 가볼까?`, cta:'마을 가기', target:'world' };
  else if (streak >= 2) card = { kind:'streak', icon:'🔥', text:`${streak}일 연속이야! 오늘 흔적을 남기고 갈래?`, cta:'마을 가기', target:'world' };
  res.json({ ok:true, card });
});

app.get('/api/guestbook', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const fid = Number(req.query.friendId) || 0;
  const f = friendshipBetween(u.id, fid);
  if(!f || f.status !== 'accepted') return res.status(400).json({ error:'친구만 볼 수 있어요' });
  const fr = db.prepare('SELECT id,nickname,level,streak FROM users WHERE id=?').get(fid);
  const { st } = syncVillage(fid);
  const msgs = db.prepare(`SELECT g.id, g.message, g.created_at, u.nickname
    FROM guestbook g JOIN users u ON u.id=g.from_user
    WHERE g.to_user=? ORDER BY g.id DESC LIMIT 6`).all(fid);
  res.json({ ok:true,
    friend:{ id:fid, nickname: fr?fr.nickname:'', level: fr?fr.level:1, streak: fr?fr.streak:0 },
    stats: st, messages: msgs });
});
app.post('/api/guestbook', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({ error:'로그인이 필요해요' });
  const b = req.body || {};
  const fid = Number(b.friendId) || 0;
  const msg = String(b.message || '').trim().slice(0, 40);
  if(!msg) return res.status(400).json({ error:'한 줄 적어 주세요' });
  if(!isSafeText(msg) || hasContactInfo(msg))
    return res.status(400).json({ error:'예의를 지키고 개인정보는 쓰지 마세요' });
  const f = friendshipBetween(u.id, fid);
  if(!f || f.status !== 'accepted') return res.status(400).json({ error:'친구만 남길 수 있어요' });
  const already = db.prepare("SELECT COUNT(*) c FROM guestbook WHERE from_user=? AND to_user=? AND substr(created_at,1,10)=?")
    .get(u.id, fid, today()).c;
  if(already >= 3) return res.status(429).json({ error:'오늘은 3번까지 남길 수 있어요' });
  db.prepare('INSERT INTO guestbook(to_user,from_user,message) VALUES(?,?,?)').run(fid, u.id, msg);
  // ★ 친구 마을에 한 줄을 남기면 상대 우편함으로 알림 → 다시 들어올 이유
  sendMail(fid, { title:'💌 친구 마을에 방명록!', body:`${u.nickname}님이 마을에 한 줄을 남겼어요.`,
                  cell:0, tag:`friend:guestbook:${u.id}:${today()}` });
  res.json({ ok:true });
});

// ---- 시즌(최소) ----
app.get('/api/season/current', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const wk = weekStartKST();
  const s = db.prepare('SELECT * FROM seasons WHERE start_week<=? AND end_week>=? ORDER BY id DESC LIMIT 1').get(wk, wk);
  res.json({ ok:true, weekStart:wk, name: s ? s.name : '기본 시즌',
             startWeek: s ? s.start_week : null, endWeek: s ? s.end_week : null,
             rewardCell: s ? s.reward_cell : 0 });
});

// ============================================================
// ★ 2026-11-04 학습 동행 2.0
//   ① 능동 넛지  ② 성장 지도  ③ 보호자 주간 레터
//   ④ 기분 체크  ⑤ 같이 집중  ⑥ 시즌 보드
//   공통: 새 LLM 호출 없음. DeepSeek 표기는 UI 의 정적 크레딧.
// ============================================================

function robotNameFor(uid){
  const r = db.prepare('SELECT name FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(uid);
  return r ? r.name : '루미';
}
function safeCount(sql, args){
  try{ return db.prepare(sql).get(...args).c || 0; }catch(e){ return 0; }
}
function weekEndOf(wk){
  return new Date(Date.parse(wk + 'T00:00:00Z') + 7*86400000).toISOString().slice(0,10);
}
function weekKeyOffset(n){
  return new Date(Date.parse(weekStartKST() + 'T00:00:00Z') - n*7*86400000).toISOString().slice(0,10);
}
function weakList(uid){
  let raw = '';
  try{ raw = profileFor(uid).weak_topics || ''; }catch(e){}
  return String(raw).split(',').map(s=>s.trim()).filter(Boolean);
}

// ── ① 능동 넛지: 접속할 때 «루미가 먼저» 말을 건다 ──
//   우선순위: 어제 못 다 한 대화 → 복습 → 오늘 계획 → 연속 기록 → 기본 인사
function buildNudge(u){
  const day = today(), name = robotNameFor(u.id);
  // ★ 2026-11-04: 예전 대화의 follow_up 이 영구히 넛지를 점유하지 않도록 최근 2일만 본다.
  const since = dayKST(-1);
  const last = db.prepare("SELECT follow_up FROM chat_messages WHERE user_id=? AND role='assistant' AND follow_up IS NOT NULL AND follow_up<>'' AND ts>=? ORDER BY id DESC LIMIT 1").get(u.id, since);
  if(last && last.follow_up)
    return { kind:'followup', target:'chat', cta:'이어서 이야기', text:`${name}: ${String(last.follow_up).slice(0,90)}` };
  const due = safeCount('SELECT COUNT(*) c FROM review_cards WHERE user_id=? AND done=0 AND due_date<=?', [u.id, day]);
  if(due > 0)
    return { kind:'review', target:'review', cta:'3분만 같이 보기', text:`${name}: 어제 헷갈린 문제 ${due}개가 기다려. 같이 볼래?` };
  const pr = db.prepare('SELECT plan_json FROM learning_plans WHERE user_id=? AND day=?').get(u.id, day);
  if(pr){
    try{
      const p = JSON.parse(pr.plan_json);
      const next = (p.steps||[]).find(s=>!s.done);
      if(next) return { kind:'plan', target:'plan', cta:'1단계 시작', text:`${name}: 오늘 «${String(next.title).slice(0,24)}» 이 남았어. 같이 시작할까?` };
    }catch(e){}
  }
  const streak = u.streak || 0;
  const visited = safeCount('SELECT COUNT(*) c FROM visits WHERE user_id=? AND substr(entered_at,1,10)=?', [u.id, day]);
  if(streak >= 2 && !visited)
    return { kind:'streak', target:'world', cta:'마을 가기', text:`${name}: ${streak}일 연속이야! 오늘도 흔적 남기러 갈래?` };
  return { kind:'hello', target:'chat', cta:'루미와 대화', text:`${name}: 오늘은 뭐가 제일 궁금해? 같이 찾아보자!` };
}
function todayNudge(u){
  const day = today();
  const pick = db.prepare('SELECT * FROM nudges WHERE user_id=? AND day=?');
  let row = pick.get(u.id, day);
  if(!row){
    const n = buildNudge(u);
    try{ db.prepare('INSERT INTO nudges(user_id,day,kind,text,cta,target) VALUES(?,?,?,?,?,?)')
      .run(u.id, day, n.kind, n.text, n.cta, n.target); }catch(e){}
    row = pick.get(u.id, day);
  }else if(!row.clicked && row.kind !== 'followup'){
    // ★ 2026-11-04: 대화에서 새 follow_up 이 생기면 같은 날이라도 «이어서 이야기»로 갱신.
    //   (하루 1회 캐시 때문에 방금 나눈 대화가 다음 날에야 되살아나던 문제)
    const n = buildNudge(u);
    if(n.kind === 'followup'){
      try{ db.prepare('UPDATE nudges SET kind=?,text=?,cta=?,target=? WHERE id=?')
        .run(n.kind, n.text, n.cta, n.target, row.id); }catch(e){}
      row = pick.get(u.id, day);
    }
  }
  return row;
}
app.get('/api/nudge/today', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const n = todayNudge(u);
  if(!n) return res.json({ ok:true, card:null });
  db.prepare('UPDATE nudges SET shown=shown+1 WHERE id=?').run(n.id);
  res.json({ ok:true, id:n.id, kind:n.kind, text:n.text, cta:n.cta, target:n.target, clicked:!!n.clicked });
});
app.post('/api/nudge/click', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const id = Number((req.body||{}).id) || 0;
  db.prepare('UPDATE nudges SET clicked=1 WHERE id=? AND user_id=?').run(id, u.id);
  res.json({ ok:true });
});

// ── ② 성장 지도: 최근 6주 추세 + 요약 (기존 로그를 SQL 로 집계) ──
app.get('/api/growth/timeline', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const weeks = [];
  for(let i=5;i>=0;i--){
    const wk = weekKeyOffset(i), end = weekEndOf(wk);
    const solved  = safeCount('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND day>=? AND day<? AND solved=1', [u.id,wk,end]);
    const lessons = safeCount('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day>=? AND day<? AND solved=1', [u.id,wk,end]);
    const reviews = safeCount('SELECT COUNT(*) c FROM review_cards WHERE user_id=? AND done=1 AND due_date>=? AND due_date<?', [u.id,wk,end]);
    const chats   = safeCount("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND role='user' AND substr(ts,1,10)>=? AND substr(ts,1,10)<?", [u.id,wk,end]);
    const games   = safeCount('SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND day>=? AND day<?', [u.id,wk,end]);
    const focus   = safeCount('SELECT COUNT(*) c FROM focus_sessions WHERE user_id=? AND day>=? AND day<? AND done=1', [u.id,wk,end]);
    weeks.push({ week:wk, label:`${Number(wk.slice(5,7))}/${Number(wk.slice(8,10))}`,
      solved, lessons, reviews, chats, games, focus,
      index: Math.min(100, 12 + solved*4 + lessons*3 + reviews*3 + focus*2) });
  }
  const mastered = safeCount('SELECT COUNT(DISTINCT card_id) c FROM world_lessons WHERE user_id=? AND solved=1', [u.id]);
  const totalCards = safeCount('SELECT COUNT(*) c FROM knowledge_cards', []);
  res.json({ ok:true, weeks,
    summary:{ understanding: (()=>{ try{ return profileFor(u.id).understanding||0; }catch(e){ return 0; } })(),
      mastered, totalCards, weakTopics: weakList(u.id), streak:u.streak||0, level:u.level||1 } });
});

// ── ③ 보호자 주간 레터: 규칙 템플릿 (LLM 미사용, UI 에만 크레딧) ──
app.get('/api/parent/weekly', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const wk = weekStartKST(), end = weekEndOf(wk);
  const studyDays = safeCount('SELECT COUNT(DISTINCT day) c FROM learning_help_logs WHERE user_id=? AND day>=? AND day<?', [u.id,wk,end]);
  const solved  = safeCount('SELECT COUNT(*) c FROM learning_help_logs WHERE user_id=? AND day>=? AND day<? AND solved=1', [u.id,wk,end]);
  const lessons = safeCount('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day>=? AND day<? AND solved=1', [u.id,wk,end]);
  const chats   = safeCount("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND role='user' AND substr(ts,1,10)>=? AND substr(ts,1,10)<?", [u.id,wk,end]);
  const games   = safeCount('SELECT COUNT(*) c FROM game_logs WHERE user_id=? AND day>=? AND day<?', [u.id,wk,end]);
  let focusMin = 0;
  try{ focusMin = db.prepare('SELECT COALESCE(SUM(minutes),0) c FROM focus_sessions WHERE user_id=? AND day>=? AND day<? AND done=1').get(u.id,wk,end).c || 0; }catch(e){}
  const weak = weakList(u.id);
  const highlight = solved > 0 ? `스스로 ${solved}개 문제를 해결했어요`
                  : lessons > 0 ? `지혜의 샘에서 ${lessons}개 질문을 풀었어요`
                  : chats > 0 ? `${robotNameFor(u.id)}와 ${chats}번 이야기를 나눴어요`
                  : '이번 주도 루미를 찾아와 줬어요';
  const encourage = weak.length
    ? `아직 «${weak[0]}» 은 조금 헷갈려 해요. 정답보다 «어디서 막혔는지» 를 먼저 물어봐 주세요.`
    : `새 개념을 받아들이는 속도가 안정적이에요. 아이가 스스로 설명하게 해 보면 더 오래 남아요.`;
  const suggestion = focusMin >= 30
    ? '다음 주에는 집중 시간을 조금 줄이고, 짧게 자주 마주치는 편을 권해요.'
    : '다음 주에는 10분씩 3번만 같은 주제를 이어가 보도록 권해요.';
  const letter = `${highlight}.\n\n${encourage}\n\n${suggestion}\n\n` +
    `이번 주 기록: 공부 ${studyDays}일 · 스스로 해결 ${solved}개 · 지혜의 샘 ${lessons}개 · ` +
    `대화 ${chats}회 · 집중 ${focusMin}분 · 게임 ${games}회 · 연속 ${u.streak||0}일.`;
  res.json({ ok:true, weekStart:wk,
    stats:{ studyDays, solved, lessons, chats, games, focusMin, streak:u.streak||0 },
    highlight, encourage, suggestion, letter });
});

// ── ④ 기분 체크: 아이 상태를 기록하고 루미 톤·방 조명에 반영 ──
const MOODS = {
  good: { ko:'신나',   greeting:'와, 오늘 기분이 좋구나! 나도 덩달아 신나!',        light:[1.00,0.90,0.72], tone:'밝고 신나게' },
  ok:   { ko:'보통',   greeting:'오늘도 같이 천천히 해 보자. 괜찮아!',              light:[0.94,0.95,1.00], tone:'차분하고 다정하게' },
  low:  { ko:'힘들어', greeting:'오늘은 좀 지쳤구나. 쉬어도 돼, 내가 옆에 있을게.', light:[0.78,0.86,1.00], tone:'목소리를 낮추고 천천히, 다정하게' },
};
app.get('/api/mood/today', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const row = db.prepare('SELECT mood FROM mood_logs WHERE user_id=? AND day=?').get(u.id, today());
  const m = row && MOODS[row.mood] ? row.mood : null;
  res.json({ ok:true, mood:m, asked:!!m, ko:m?MOODS[m].ko:null,
    greeting:m?MOODS[m].greeting:null, light:m?MOODS[m].light:null });
});
app.post('/api/mood', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const mood = String((req.body||{}).mood||'');
  if(!MOODS[mood]) return res.status(400).json({error:'기분을 골라 주세요'});
  db.prepare('INSERT INTO mood_logs(user_id,day,mood) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET mood=excluded.mood')
    .run(u.id, today(), mood);
  res.json(Object.assign({ ok:true, mood }, MOODS[mood]));
});

// ── ⑤ 같이 집중: 루미와 5~20분 몰입, 끝나면 작은 보상 ──
app.post('/api/focus/start', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const minutes = [5,10,15,20].includes(Number((req.body||{}).minutes)) ? Number(req.body.minutes) : 10;
  const pending = db.prepare('SELECT id,minutes FROM focus_sessions WHERE user_id=? AND day=? AND done=0').get(u.id, today());
  if(pending) return res.json({ ok:true, sessionId:pending.id, minutes:pending.minutes, resumed:true });
  const info = db.prepare('INSERT INTO focus_sessions(user_id,day,minutes,started_at) VALUES(?,?,?,?)')
    .run(u.id, today(), minutes, new Date().toISOString());
  res.json({ ok:true, sessionId:Number(info.lastInsertRowid), minutes });
});
app.post('/api/focus/finish', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = req.body || {};
  const s = db.prepare('SELECT * FROM focus_sessions WHERE id=? AND user_id=? AND done=0').get(Number(b.sessionId)||0, u.id);
  if(!s) return res.status(400).json({error:'진행 중인 집중이 없어요'});
  // ★ 타이머 우회 방지: 실제 경과 시간이 목표의 80% 미만이면 보상 없이 되묻는다.
  const elapsed = s.started_at ? (Date.now() - Date.parse(s.started_at))/60000 : 0;
  if(elapsed < s.minutes*0.8) return res.status(400).json({error:'조금만 더 집중해 볼까?'});
  const done = safeCount('SELECT COUNT(*) c FROM focus_sessions WHERE user_id=? AND day=? AND done=1', [u.id, today()]);
  let reward = 0;
  if(done < 3){ reward = 4 + Math.min(6, Math.floor(s.minutes/5)*2); grantCell(u.id, reward, 'focus'); }
  db.prepare('UPDATE focus_sessions SET done=1, reward=?, finished_at=? WHERE id=?')
    .run(reward, new Date().toISOString(), s.id);
  res.json({ ok:true, reward, minutes:s.minutes,
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance,
    note: reward ? '루미가 옆에 앉아 있었어! 잘했어' : '오늘 집중 보상은 다 받았어. 내일 또 하자!' });
});
app.get('/api/focus/summary', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const all = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(minutes),0) m FROM focus_sessions WHERE user_id=? AND done=1').get(u.id);
  const t = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(minutes),0) m FROM focus_sessions WHERE user_id=? AND day=? AND done=1').get(u.id, today());
  res.json({ ok:true, total:all.n, totalMin:all.m, today:t.n, todayMin:t.m });
});

// ── ⑥ 시즌 보드: 주간 미션 3개를 기존 로그에서 실시간 집계 ──
const SEASON_TASKS = [
  { key:'review', title:'복습 카드 1장',   icon:'🔁' },
  { key:'lesson', title:'지혜의 샘 1곳',   icon:'📖' },
  { key:'friend', title:'친구에게 응원 1번', icon:'💌' },
];
function seasonBoardRow(u){
  const wk = weekStartKST(), end = weekEndOf(wk);
  const review = safeCount('SELECT COUNT(*) c FROM review_cards WHERE user_id=? AND done=1 AND due_date>=? AND due_date<?', [u.id,wk,end]);
  const lesson = safeCount('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day>=? AND day<? AND solved=1', [u.id,wk,end]);
  const friend = safeCount('SELECT COUNT(*) c FROM cheers WHERE from_user=? AND day>=? AND day<?', [u.id,wk,end])
               + safeCount('SELECT COUNT(*) c FROM guestbook WHERE from_user=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<?', [u.id,wk,end]);
  const vals = { review, lesson, friend };
  const tasks = SEASON_TASKS.map(t=>Object.assign({}, t, { done: Math.min(1, vals[t.key]), count: vals[t.key] }));
  const s = db.prepare('SELECT * FROM seasons WHERE start_week<=? AND end_week>=? ORDER BY id DESC LIMIT 1').get(wk,wk);
  const claimed = !!db.prepare('SELECT 1 FROM season_claims WHERE user_id=? AND week=?').get(u.id, wk);
  return { weekStart:wk, name:s?s.name:'기본 시즌', tasks, done:tasks.filter(t=>t.done).length,
           // ★ ?? 30 — 운영자가 0셀로 «보상 없음» 을 의도해도 30 으로 되돌려지던 버그 수정
           total:SEASON_TASKS.length, claimed, reward:s?(s.reward_cell ?? 30):30 };
}
app.get('/api/season/board', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  res.json(Object.assign({ ok:true }, seasonBoardRow(u)));
});
app.post('/api/season/claim', (req,res)=>{
  const u = authUser(req);
  if(!u) return res.status(401).json({error:'로그인이 필요해요'});
  const b = seasonBoardRow(u);
  if(b.done < b.total) return res.status(400).json({error:'아직 미션이 남았어!'});
  if(b.claimed) return res.status(400).json({error:'이번 주 보상은 이미 받았어'});
  try{ db.prepare('INSERT INTO season_claims(user_id,week,reward) VALUES(?,?,?)').run(u.id, b.weekStart, b.reward); }
  catch(e){ return res.status(400).json({error:'이번 주 보상은 이미 받았어'}); }
  grantCell(u.id, b.reward, 'season');
  try{ addExp(u.id, 12); }catch(e){}
  sendMail(u.id, { title:'🏅 이번 주 시즌 보상', body:`${b.name} 미션 3개를 모두 끝냈어요!`,
                   cell:b.reward, tag:'season:'+b.weekStart });
  res.json({ ok:true, reward:b.reward,
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
});

// ---- Admin CRUD: items / quests / season ----
app.get('/api/admin/items', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  res.json({ ok:true, items: db.prepare('SELECT * FROM items ORDER BY id').all() });
});
app.post('/api/admin/item', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const b = req.body || {};
  const name = String(b.name||'').trim().slice(0,40);
  const type = ['part','decor','skin','shard'].includes(b.type) ? b.type : 'part';
  const price = Math.max(0, Math.min(9999, Math.round(Number(b.price)||0)));
  const consumable = b.consumable ? 1 : 0;
  const limited = b.limited_days ? String(b.limited_days).slice(0,20) : null;
  if(!name) return res.status(400).json({error:'name 이 필요해요'});
  if(b.id){
    db.prepare('UPDATE items SET name=?, type=?, price=?, consumable=?, limited_days=? WHERE id=?')
      .run(name, type, price, consumable, limited, Number(b.id));
    return res.json({ ok:true, updated:Number(b.id) });
  }
  const r = db.prepare('INSERT INTO items(name,type,price,consumable,limited_days) VALUES(?,?,?,?,?)')
    .run(name, type, price, consumable, limited);
  res.json({ ok:true, id: r.lastInsertRowid });
});
app.post('/api/admin/quest', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const b = req.body || {};
  const date = String(b.date||today()).slice(0,10);
  const type = String(b.type||'daily').slice(0,20);
  const title = String(b.title||'').trim().slice(0,80);
  const reward = Math.max(0, Math.min(200, Math.round(Number(b.reward)||30)));
  const topic = b.topic ? String(b.topic).slice(0,40) : null;
  if(!title) return res.status(400).json({error:'title 이 필요해요'});
  const r = db.prepare('INSERT INTO daily_quests(quest_date,type,title,reward,topic) VALUES(?,?,?,?,?)')
    .run(date, type, title, reward, topic);
  res.json({ ok:true, id: r.lastInsertRowid });
});
app.post('/api/admin/season', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const b = req.body || {};
  const name = String(b.name||'').trim().slice(0,40);
  const start = String(b.start_week||weekStartKST()).slice(0,10);
  const end = String(b.end_week||start).slice(0,10);
  const reward = Math.max(0, Math.min(1000, Math.round(Number(b.reward_cell)||0)));
  if(!name) return res.status(400).json({error:'name 이 필요해요'});
  const r = db.prepare('INSERT INTO seasons(name,start_week,end_week,reward_cell) VALUES(?,?,?,?)').run(name,start,end,reward);
  res.json({ ok:true, id:r.lastInsertRowid });
});

// ============================================================
// ★ 2026-11-21 (v1.74) D2 지식 카드 관리(운영자 CRUD) — 알려진 문제 #3(knowledge_cards 무 UI) 종료.
//   · GET    /api/admin/cards      — 목록(topic/퀴즈 질문/prereq/완성 상태)
//   · POST   /api/admin/cards      — 추가(필드 검증 · topic 중복 금지)
//   · PUT    /api/admin/cards/:id  — 편집(퀴즈/힌트/prereq 중심 — 준 필드만 갱신)
//   · DELETE /api/admin/cards/:id  — 삭제
//   «완성 상태(status)» 판정: concept · 퀴즈(질문+보기 4+정답 0~3) · 힌트 3단계가 모두 있으면 ok.
// ============================================================
// 저장된 quiz 문자열 → { q, options, answer } 객체(망가진 행도 안전하게 {})
function cardQuizParse(quizRaw){
  let qz = {};
  try{ qz = (typeof quizRaw === 'string' ? JSON.parse(quizRaw) : (quizRaw || {})) || {}; }catch(e){ qz = {}; }
  if(!Array.isArray(qz.options)) qz.options = [];
  return qz;
}
function cardStatus(row){
  const qz = cardQuizParse(row.quiz);
  const ans = Number(qz.answer);
  const ok = row.concept && String(qz.q || '').trim()
    && qz.options.length === 4 && qz.options.every(o => String(o || '').trim())
    && Number.isInteger(ans) && ans >= 0 && ans < 4
    && row.hint_l1 && row.hint_l2 && row.hint_l3;
  return ok ? 'ok' : 'incomplete';
}
// 카드 본문 검증 — 문제가 있으면 한국어 오류 문자열, 없으면 null
function cardValidationError(b){
  const topic = String(b.topic || '').trim();
  if(!topic) return 'topic 이 필요해요';
  if(topic.length > 60) return 'topic 은 60자 이내예요';
  const concept = String(b.concept || '').trim();
  if(!concept) return 'concept 이 필요해요';
  const qz = b.quiz || {};
  if(!String(qz.q || '').trim()) return '퀴즈 질문(quiz.q) 이 필요해요';
  if(!Array.isArray(qz.options) || qz.options.length !== 4 || qz.options.some(o => !String(o || '').trim()))
    return '보기(quiz.options) 는 빈 칸 없이 4 개여야 해요';
  const ans = Number(qz.answer);
  if(!Number.isInteger(ans) || ans < 0 || ans > 3) return '정답 번호(quiz.answer) 는 0~3 이어야 해요';
  return null;
}
app.get('/api/admin/cards', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const rows = db.prepare('SELECT * FROM knowledge_cards ORDER BY chapter, id').all();
  const cards = rows.map(r=>{
    const qz = cardQuizParse(r.quiz);
    return {
      id:r.id, topic:r.topic, chapter:r.chapter, concept:r.concept || '',
      analogy:r.analogy || '', example:r.example || '',
      hint_l1:r.hint_l1 || '', hint_l2:r.hint_l2 || '', hint_l3:r.hint_l3 || '',
      prereq:r.prereq || '', tags:r.tags || '',
      question: String(qz.q || ''), quiz:qz, status: cardStatus(r),
    };
  });
  res.json({ ok:true, total: cards.length, cards });
});
app.post('/api/admin/cards', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const b = req.body || {};
  const norm = {
    topic: String(b.topic || '').trim().slice(0, 60),
    chapter: Math.max(1, Math.min(9, Math.round(Number(b.chapter) || 1))),
    concept: String(b.concept || '').trim().slice(0, 120),
    analogy: String(b.analogy || '').trim().slice(0, 120),
    example: String(b.example || '').trim().slice(0, 120),
    hint_l1: String(b.hint_l1 || '').trim().slice(0, 120),
    hint_l2: String(b.hint_l2 || '').trim().slice(0, 160),
    hint_l3: String(b.hint_l3 || '').trim().slice(0, 160),
    prereq: String(b.prereq || '').trim().split(',').map(s => s.trim()).filter(Boolean).slice(0, 4).join(','),
    tags: String(b.tags || '').trim().slice(0, 120),
    quiz: { q:String((b.quiz && b.quiz.q) || '').trim().slice(0, 120),
      options: Array.isArray(b.quiz && b.quiz.options) ? b.quiz.options.map(o => String(o || '').trim().slice(0, 60)) : [],
      answer: Math.round(Number(b.quiz && b.quiz.answer) || 0) },
  };
  const e = cardValidationError(norm);
  if(e) return res.status(400).json({error:e});
  if(db.prepare('SELECT id FROM knowledge_cards WHERE topic=?').get(norm.topic))
    return res.status(409).json({error:'같은 topic 카드가 이미 있어요'});
  const r = db.prepare(`INSERT INTO knowledge_cards(topic,chapter,concept,analogy,example,hint_l1,hint_l2,hint_l3,quiz,tags,prereq)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(norm.topic, norm.chapter, norm.concept, norm.analogy, norm.example,
         norm.hint_l1, norm.hint_l2, norm.hint_l3, JSON.stringify(norm.quiz), norm.tags, norm.prereq);
  res.json({ ok:true, id:r.lastInsertRowid });
});
app.put('/api/admin/cards/:id', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const id = Number(req.params.id) || 0;
  const cur = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(id);
  if(!cur) return res.status(404).json({error:'그 카드는 없어요'});
  const b = req.body || {};
  // ★ 준 필드만 갱신(quiz/hints/prereq 중심). 안 준 필드는 기존값 유지 — 실수로 내용을 지우는 일을 막는다.
  const merged = {
    topic: b.topic !== undefined ? String(b.topic).trim().slice(0, 60) : String(cur.topic),
    chapter: b.chapter !== undefined ? Math.max(1, Math.min(9, Math.round(Number(b.chapter) || 1))) : Number(cur.chapter) || 1,
    concept: b.concept !== undefined ? String(b.concept).trim().slice(0, 120) : String(cur.concept || ''),
    analogy: b.analogy !== undefined ? String(b.analogy).trim().slice(0, 120) : String(cur.analogy || ''),
    example: b.example !== undefined ? String(b.example).trim().slice(0, 120) : String(cur.example || ''),
    hint_l1: b.hint_l1 !== undefined ? String(b.hint_l1).trim().slice(0, 120) : String(cur.hint_l1 || ''),
    hint_l2: b.hint_l2 !== undefined ? String(b.hint_l2).trim().slice(0, 160) : String(cur.hint_l2 || ''),
    hint_l3: b.hint_l3 !== undefined ? String(b.hint_l3).trim().slice(0, 160) : String(cur.hint_l3 || ''),
    tags: b.tags !== undefined ? String(b.tags).trim().slice(0, 120) : String(cur.tags || ''),
    prereq: b.prereq !== undefined
      ? String(b.prereq).trim().split(',').map(s => s.trim()).filter(Boolean).slice(0, 4).join(',')
      : String(cur.prereq || ''),
    quiz: cardQuizParse(b.quiz !== undefined ? b.quiz : cur.quiz),
  };
  const qz = merged.quiz;
  qz.q = String(qz.q || '').trim().slice(0, 120);
  qz.options = (Array.isArray(qz.options) ? qz.options : []).map(o => String(o || '').trim().slice(0, 60));
  while(qz.options.length < 4) qz.options.push('');
  qz.options = qz.options.slice(0, 4);
  qz.answer = Math.round(Number(qz.answer) || 0);
  merged.quiz = qz;
  const e = cardValidationError(merged);
  if(e) return res.status(400).json({error:e});
  if(merged.topic !== cur.topic && db.prepare('SELECT id FROM knowledge_cards WHERE topic=?').get(merged.topic))
    return res.status(409).json({error:'같은 topic 카드가 이미 있어요'});
  db.prepare(`UPDATE knowledge_cards SET topic=?, chapter=?, concept=?, analogy=?, example=?,
    hint_l1=?, hint_l2=?, hint_l3=?, quiz=?, tags=?, prereq=? WHERE id=?`)
    .run(merged.topic, merged.chapter, merged.concept, merged.analogy, merged.example,
         merged.hint_l1, merged.hint_l2, merged.hint_l3, JSON.stringify(merged.quiz), merged.tags, merged.prereq, id);
  res.json({ ok:true, updated:id });
});
app.delete('/api/admin/cards/:id', (req,res)=>{
  if(!requireAdmin(req,res)) return;
  const id = Number(req.params.id) || 0;
  const r = db.prepare('DELETE FROM knowledge_cards WHERE id=?').run(id);
  if(!r.changes) return res.status(404).json({error:'그 카드는 없어요'});
  res.json({ ok:true, deleted:id });
});


// ───────── v1.39 «자기 생각 × 도로랜드» — 생각 조각 API (4개) ─────────
//  · GET  /api/story             : 이번 주 챕터 서사 + 조각 목록 + 통계 (수첩 화면 1회 로드)
//  · GET  /api/thoughts/summary  : 3D «별빛 저장고» 용 최소 정보
//  · POST /api/thoughts          : 막힌 순간 + 처음 생각 기록
//  · POST /api/thoughts/fix      : 고쳐 쓴 생각 → fixed + 별빛 셀 + 저장고 점등
//  보상은 «정답» 이 아니라 «고침» 에 준다. 그래서 여기 어디에도 채점 로직이 없다.
app.get('/api/story', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요해요' });
  const t = currentTopic();
  const ch = STORY_CHAPTERS[t.chapter] || STORY_CHAPTERS[1];
  const items = db.prepare(`SELECT id, day, chapter, topic, stuck, guess, revised, prompt_key,
      status, cell_reward, created_at, fixed_at
    FROM thought_shards WHERE user_id=? ORDER BY id DESC LIMIT 30`).all(u.id);
  res.json({
    ok: true,
    week: t.week, chapter: t.chapter, topic: t.topic, keywords: t.keywords || '',
    badge: ch.badge, line: ch.line, vow: ch.vow,
    prompts: REFLECT_PROMPTS,
    items, stats: thoughtStats(u.id),
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance
  });
});

app.get('/api/thoughts/summary', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요해요' });
  res.json({ ok: true, stats: thoughtStats(u.id) });
});

app.post('/api/thoughts', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요해요' });
  const b = req.body || {};
  const stuck = String(b.stuck || '').trim().slice(0, 60);
  const guess = String(b.guess || '').trim().slice(0, 120);
  if (stuck.length < 2 || guess.length < 2) return res.status(400).json({ error: '두 칸 모두 조금만 더 적어 줘' });
  if (!isSafeText(stuck) || !isSafeText(guess)) return res.status(400).json({ error: '루미가 읽기 어려운 글이야. 다시 적어 줄래?' });
  const st = thoughtStats(u.id);
  if (st.todayNew >= THOUGHT_NEW_CAP) return res.status(400).json({ error: '오늘은 생각을 많이 모았어. 내일 또 적자!' });
  const t = currentTopic();
  const r = db.prepare('INSERT INTO thought_shards(user_id,day,chapter,topic,stuck,guess) VALUES(?,?,?,?,?,?)')
    .run(u.id, today(), t.chapter, t.topic, stuck, guess);
  res.json({ ok: true, id: Number(r.lastInsertRowid), stats: thoughtStats(u.id) });
});

app.post('/api/thoughts/fix', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요해요' });
  const b = req.body || {};
  const id = Math.round(Number(b.id) || 0);
  const revised = String(b.revised || '').trim().slice(0, 120);
  const row = db.prepare('SELECT * FROM thought_shards WHERE id=? AND user_id=?').get(id, u.id);
  if (!row) return res.status(404).json({ error: '그 조각을 찾을 수 없어요' });
  // 이미 고친 조각은 «조용히 0셀» 로 돌려준다 — 두 번 눌러도 셀이 두 번 나가지 않는다.
  if (row.status === 'fixed') {
    return res.json({ ok: true, already: true, reward: 0, stats: thoughtStats(u.id),
      balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }
  if (revised.length < 4) return res.status(400).json({ error: '고쳐 쓴 생각을 조금 더 길게 적어 줘' });
  if (!isSafeText(revised)) return res.status(400).json({ error: '루미가 읽기 어려운 글이야. 다시 적어 줄래?' });
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  if (norm(revised) === norm(row.guess)) return res.status(400).json({ error: '처음 생각과 똑같아. 달라진 걸 적어 볼래?' });
  const prompt = REFLECT_PROMPTS.find(p => p.key === String(b.promptKey || '')) || REFLECT_PROMPTS[0];
  const st = thoughtStats(u.id);
  const reward = st.todayFixed < THOUGHT_DAILY_CAP ? THOUGHT_CELL : 0;
  db.prepare(`UPDATE thought_shards
      SET revised=?, prompt_key=?, status='fixed', cell_reward=?, fixed_at=datetime('now','+9 hours')
    WHERE id=? AND user_id=?`).run(revised, prompt.key, reward, id, u.id);
  if (reward) grantCell(u.id, reward, 'thought_fix');
  res.json({
    ok: true, already: false, id, reward, prompt: prompt.q,
    stats: thoughtStats(u.id),
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance
  });
});

// ============================================================
// ★ 2026-11-21 (v1.74) F «루미의 편지» — 오래 떠난 아이의 보호자에게 «기억 안개» 알림 메일.
//   SOFT DEPENDENCY — 절대 하드 require 하지 않는다. nodemailer 미설치 · MAIL_SMTP_* 미설정이면
//   «조용히 꺼진다»(기능 없음 = 원래 동작). 배포 환경이 메일을 못 써도 서버는 죽지 않는다.
//   실행 조건(전부 충족해야 보낸다):
//   · KST 19 시 시간대 + daily_counters(user_id=0, kind='mailrun') 의 «오늘 안 보냄»
//   · 대상: parent_optin=1 · parent_email 있음 · 마지막 로그인 ≥3일 경과 · decay≥50 등불 존재
//   · 사용자 주간 한도: 최근 7일 안에 outmail 2회까지(kind='outmail' — 하루 1행이라 행 수 = 횟수)
//   · 내용은 «개념 이름 + 일수» 만 — 아이의 대화·성적 등 개인 데이터는 보내지 않는다.
// ============================================================
let nodemailer = null;
try{ nodemailer = require('nodemailer'); }catch(e){ /* 미설치 — 기능 조용히 꺼짐 */ }
const MAIL_SMTP_HOST = String(process.env.MAIL_SMTP_HOST || '');
const MAIL_SMTP_PORT = Number(process.env.MAIL_SMTP_PORT || 587);
const MAIL_SMTP_USER = String(process.env.MAIL_SMTP_USER || '');
const MAIL_SMTP_PASS = String(process.env.MAIL_SMTP_PASS || '');
const MAIL_FROM = String(process.env.MAIL_FROM || MAIL_SMTP_USER);
const MAIL_READY = !!(nodemailer && MAIL_SMTP_HOST && MAIL_SMTP_USER && MAIL_SMTP_PASS && MAIL_FROM);
if(!MAIL_READY) console.log('ℹ️ [mail] 루미의 편지 꺼짐 — nodemailer 미설치 또는 MAIL_SMTP_HOST/USER/PASS 환경변수 없음');
else console.log(`✉️ [mail] 루미의 편지 준비됨 — ${MAIL_SMTP_HOST}:${MAIL_SMTP_PORT}`);

// 이메일 마스킹 — «lm*****@163.com» 처럼 앞 2글자 + 도메인만 남긴다(대시보드 표시용).
function maskEmail(e){
  const s = String(e || '');
  const at = s.indexOf('@');
  if(at <= 0) return '';
  const name = s.slice(0, at), dom = s.slice(at);
  return name.slice(0, 2) + '*'.repeat(Math.max(1, Math.min(12, name.length - 2))) + dom;
}
// 지금이 KST 19 시 시간대인가(순수 판정 — 타이머는 이 함수만 믿는다)
function isMailHourKST(){
  try{
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Seoul', hour:'2-digit', hour12:false }).format(new Date()));
    return h === 19;
  }catch(e){ return false; }
}
// 최근 7일 안에 «루미의 편지» 를 보낸 횟수(daily_counters.kind='outmail' — 하루 1행 = 1회)
function outmailCount7d(uid){
  try{
    return db.prepare("SELECT COUNT(*) c FROM daily_counters WHERE user_id=? AND kind='outmail' AND day>=?")
      .get(uid, dayKST(-6)).c;
  }catch(e){ return 0; }
}
let mailTransporter = null;
async function rumiLetterRun(){
  if(!MAIL_READY) return;                 // 기능 꺼짐 — 아무 것도 하지 않는다
  if(!isMailHourKST()) return;            // 19 시 시간대가 아니면 대기
  const day = today();
  if(dailyCounterOf(0, day, 'mailrun') > 0) return;   // 오늘 이미 실행 — 멱등 보장
  try{
    const cand = db.prepare(`SELECT id, nickname, parent_email, last_visit FROM users
      WHERE parent_optin=1 AND parent_email IS NOT NULL AND parent_email<>''`).all();
    let sent = 0, checked = 0;
    if(!mailTransporter){
      mailTransporter = nodemailer.createTransport({
        host: MAIL_SMTP_HOST, port: MAIL_SMTP_PORT, secure: MAIL_SMTP_PORT === 465,
        auth: { user: MAIL_SMTP_USER, pass: MAIL_SMTP_PASS },
      });
    }
    for(const u of cand){
      checked++;
      // 마지막 활동 ≥3일(로그인 기록 last_visit 기준 — 기록이 아예 없으면 오래 떠난 것으로 본다)
      const lv = String(u.last_visit || '');
      const idleDays = lv ? daysBetween(lv, day) : 99;
      if(idleDays < 3) continue;
      // decay≥50 인 등불이 있어야 «기억 안개» 알림일 가치가 있다(읽기 전용 조회 — SOS 우편 부작용 없음)
      const fog = fogHeaviestReadonly(u.id, 50);
      if(!fog) continue;
      if(outmailCount7d(u.id) >= 2) continue;   // 주간 한도: 7일 2통
      const subject = `«루미» 가 «${u.nickname}» 를 기다려요`;
      const text = [
        '안녕하세요, 보호자님.',
        `${u.nickname} 님이 루미와 ${idleDays}일 동안 함께하지 않았어요.`,
        `루미의 기억 중 «${fog.topic}» 이 안개로 많이 흐려졌어요.`,
        `오늘 «${fog.topic}» 를 한 번 다시 가르쳐 주면 루미의 기억이 맑아져요.`,
        '',
        '(이 편지는 개념 이름과 일수만 담고 있습니다. 아이의 대화·성적 같은 개인 데이터는 보내지 않아요.)',
        '(편지 수신을 원하지 않으면 루미 앱의 보호자 화면에서 동의를 끄세요.)',
      ].join('\n');
      try{
        await mailTransporter.sendMail({ from: MAIL_FROM, to: String(u.parent_email), subject, text });
        bumpDailyCounter(u.id, day, 'outmail');
        sent++;
      }catch(e){
        console.log('⚠️ [mail] 발송 실패(#' + u.id + '):', e.message);
      }
    }
    bumpDailyCounter(0, day, 'mailrun');   // 하루 1회 실행 완료 표시(실패가 있어도 재시도는 내일)
    if(checked || sent) console.log(`✉️ [mail] 루미의 편지: 대상 ${checked}명 중 ${sent}통 발송`);
  }catch(e){
    console.log('⚠️ [mail] 루미의 편지 실행 오류:', e.message);
  }
}
// «매시 정각» 요구의 단순·확실 변형: 부팅 시각과 무관하게 19시 창을 놓치지 않도록
// 10분 폴링 + mailrun 일일 플래그로 «하루 1회» 를 보장한다(cron·외부 의존 없음, 프로세스 내 타이머).
try{
  const mailTick = setInterval(()=>{ rumiLetterRun(); }, 10 * 60 * 1000);
  if(mailTick && mailTick.unref) mailTick.unref();   // 타이머가 종료를 막지 않게
  setTimeout(()=>{ rumiLetterRun(); }, 90 * 1000);   // 부팅 직후에도 19시 창이면 즉시 한 번 확인
}catch(e){ console.log('⚠️ [mail] 타이머 시작 실패:', e.message); }

// 마지막 에러 핸들러 — 스택/내부 정보 노출 방지
app.use((err,_req,res,_next)=>{ console.error('💥', err); res.status(500).json({error:'서버 오류가 났어요'}); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=> console.log(`🤖 루미 prototype → http://localhost:${PORT}`));
