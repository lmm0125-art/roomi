// ============================================================
// 루미 (RooMi) — IC-PBL Prototype Server
// 스택: Node 22 내장 SQLite(node:sqlite) + Express
// 설명: DB는 31개 테이블(기본 15 + LLM 학습/기억/퍼즐/시즌/로그/친구/계획/목표/안전/기억/보상/복습 16). AI 대사는 우선 규칙 엔진으로 처리하고,
//       LLM 은 DeepSeek 단일(deepseek-chat)로 호출한다.
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// DB 경로: 환경변수 DB_PATH 우선(배포 시 데이터 보존용), 기본은 프로젝트 폴더
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'roomi.db'));
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

// LLM 호출 로그(비용/지연 모니터링). 민감정보 없음.
db.exec(`CREATE TABLE IF NOT EXISTS llm_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  mode TEXT,
  model TEXT,
  latency_ms INTEGER,
  ok INTEGER DEFAULT 0,
  ts TEXT DEFAULT (datetime('now','+9 hours'))
)`);
try{ db.exec('CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_logs(ts)'); }catch(e){}

// 장기 기억: 학습자 프로필.
db.exec(`CREATE TABLE IF NOT EXISTS learner_profile(
  user_id INTEGER PRIMARY KEY,
  understanding INTEGER NOT NULL DEFAULT 0,
  weak_topics TEXT,
  hint_style TEXT,
  last_summary TEXT,
  updated_at TEXT DEFAULT (datetime('now','+9 hours'))
)`);
// ★ 2026-10-28: 학습 偏好(하루 시간/선호 시간대/관심 주제/난이도)
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

// ---------- 3. LLM — DeepSeek 단일 (비추론 deepseek-chat) ----------
// ★ 2026-10-27: 구 LLM 체인을 전부 제거하고 DeepSeek 하나만 쓴다.
//   - 모델: deepseek-chat (reasoner 아님 → 깊은 사고/추론 비사용)
//   - 목표: 다중 모델 재시도로 인한 지연 제거, 설정 단순화
//   - 실패 시: 60초 회로 차단 후 프리셋 대사로 폴백(빈 응답 금지)
const fs = require('fs');
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
  || (()=>{ try{ return fs.readFileSync(path.join(__dirname,'deepseek_key.txt'),'utf8').trim(); }catch{ return ''; } })();
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 6000);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 220);
let llmDownUntil = 0;

function withTimeout(promise, ms){
  return Promise.race([promise, new Promise((_,rej)=>setTimeout(()=>rej(new Error('LLM_TIMEOUT')), ms))]);
}

// opts: { temperature, maxTokens, messages } — messages 를 주면 멀티턴, 없으면 단일 prompt
async function callLLM(prompt, opts){
  if(!DEEPSEEK_KEY || Date.now() < llmDownUntil) return null;
  const o = opts || {};
  const temperature = o.temperature != null ? o.temperature : 0.8;
  const maxTokens = o.maxTokens || LLM_MAX_TOKENS;
  const messages = o.messages || [{ role:'user', content:String(prompt||'') }];
  try{
    const ms = LLM_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(()=>ac.abort(), ms);
    const payload = { model: LLM_MODEL, messages, temperature, max_tokens: maxTokens };
    if(o.json) payload.response_format = { type: 'json_object' };
    const p = fetch('https://api.deepseek.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${DEEPSEEK_KEY}`},
      body: JSON.stringify(payload),
      signal: ac.signal
    }).then(async r=>{
      clearTimeout(timer);
      if(!r.ok) return { failed:true, status:r.status };
      const j = await r.json();
      return { text: j.choices?.[0]?.message?.content || '' };
    });
    const res = await withTimeout(p, ms);
    if(res.failed){
      const wait = (res.status===401 || res.status===402) ? 10*60*1000 : 60*1000;
      llmDownUntil = Date.now() + wait;
      console.log(`⚠️ [LLM] DeepSeek ${res.status} → ${Math.round(wait/1000)}s 프리셋`);
      return null;
    }
    return res.text || null;
  }catch(e){
    llmDownUntil = Date.now() + 60*1000;
    console.log(`💤 [LLM] ${e.name||e.message} → 60s 프리셋`);
    return null;
  }
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
  const txt = await callLLM(prompt);
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
  ['이번 주 새로 알게 된 것이 있니?', '오늘 배운 걸 친구에게 알려준다면 뭐라고 할래?', '이번 주에 제일 열심히 한 일은 뭐야?'],
  ['무언가 고장 났을 때 어떻게 했니?', '오늘 어려운 문제를 어떻게 해결했어?', '다시 도전해 보고 싶은 일이 있니?'],
  ['오늘 모은 것 중에 제일 아끼는 건 뭐야?', '친구에게 나눠준 적이 있니?', '내일 더 모으고 싶은 것은 뭐야?'],
  ['오늘 순서대로 한 일을 말해볼래?', '규칙을 지켜서 좋았던 일이 있니?', '가보고 싶은 곳이 있니?'],
  ['오늘 궁금했던 것은 뭐야?', '로봇에게 물어보고 싶은 게 있니?', '오늘 누구를 도와줬어?'],
];
const presetsForTopic = (topic) => TOPIC_PRESETS[(Math.max(1, topic.chapter) - 1) % TOPIC_PRESETS.length];
async function ensureQuests(dateStr) {
  const rows = db.prepare('SELECT * FROM daily_quests WHERE quest_date=?').all(dateStr);
  const has = t => rows.some(r=>r.type===t);
  const ins = db.prepare('INSERT INTO daily_quests(quest_date,type,title,reward,topic) VALUES(?,?,?,?,?)');
  const topic = currentTopic();     // ★ V12 이번 주 주제
  // ★ P0-5 보상 난이도 비례: 아무 노력 없이 누르는 간식은 낮게, 쓰는 일은 높게
  if(!has('feed'))   ins.run(dateStr,'feed','로봇에게 간식 주기',10,null);
  if(!has('praise')) ins.run(dateStr,'praise','로봇 칭찬하기',10,null);
  // ★ 오늘의 AI 미션: 풀이 비어 있으면 LLM 1회로 채움, 실패 시 프리셋 질문으로 보강
  const missions = rows.filter(r=>r.type==='ai_mission');
  if(missions.length < MISSION_POOL_SIZE){
    const need = MISSION_POOL_SIZE - missions.length;
    // ★ V12: 이번 주 주제(세계관/수업)를 프롬프트에 넣는다.
    //   "오늘 뭐 했어?" 같은 일반 질문 → "이번 주 배운 것과 연결된" 질문으로 바뀐다.
    const MP = `DOROBUS의 로봇이 초등 고학년~중학생 아이에게 오늘 묻고 싶은 질문 ${MISSION_POOL_SIZE}개를 만들어라.
이번 주 주제: "${topic.topic}" (도로랜드 CH.${topic.chapter}${topic.keywords ? ', ' + topic.keywords : ''})
아이가 이번 주에 배운 것과 자기 경험을 연결해서 답할 수 있는 질문으로 만들어라.
한국어 한 문장씩(각 30자 이내), 줄바꿈으로만 구분해 하나씩 출력하고 설명·번호 없이 질문만. 아이에게 안전하고 건전한 질문만.`;
    const txt = (await callLLM(MP) || '');
    let qs = txt.split('\n').map(s=>s.trim().replace(/^["'“”]+|["'“”]+$/g,'')).filter(s=>s.length>=8 && s.length<=60);
    qs = [...new Set(qs)];
    const exist = new Set(missions.map(m=>m.title));
    const preset = presetsForTopic(topic).filter(p=>!exist.has(p));
    while(qs.length < need && preset.length) qs.push(preset.shift()); // LLM 실패/부족 시 프리셋 보강
    for(const q of qs.slice(0, need)) ins.run(dateStr,'ai_mission', q, 30, topic.topic);
  }
  return db.prepare('SELECT * FROM daily_quests WHERE quest_date=?').all(dateStr);
}
// 날짜: 서버 로컬타임이 아닌 KST 기준 (배포 환경 무관하게 "하루" 경계 일관)
function today(){ return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date()); }
function dayKST(offset=0){ return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date(Date.now()+offset*86400000)); }
// ★ V12 도로랜드 챕터를 주제로 쓴다 — 새 콘텐츠가 세계관과 이어지게 하는 가장 싼 방법.
//   지정이 없으면 주차에 따라 자동으로 돌아가므로 운영자가 손대지 않아도 매주 질문이 달라진다.
const DEFAULT_TOPICS = [
  { chapter:1, topic:'도로랜드 신입 사원', keywords:'첫 출근, 새 친구, 설렘' },
  { chapter:2, topic:'멈춘 기계의 노래',   keywords:'고장, 원인 찾기, 고치기' },
  { chapter:3, topic:'별빛 저장고',       keywords:'모으기, 나누기, 약속' },
  { chapter:4, topic:'코딩 숲의 지도',     keywords:'순서, 규칙, 길 찾기' },
  { chapter:5, topic:'AI 마을의 질문',     keywords:'질문하기, 배우기, 도와주기' },
];
// 이번 주 월요일(KST) — 주제의 기준이 되는 날짜
function weekStartKST(){
  const ymd = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  const [y,m,d] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m-1, d));
  const dow = base.getUTCDay();                 // 0=일요일
  base.setUTCDate(base.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return base.toISOString().slice(0,10);
}
// 이번 주 주제 — 운영자가 넣은 값이 있으면 그것, 없으면 챕터 자동 순환
function currentTopic(){
  const week = weekStartKST();
  const row = db.prepare('SELECT * FROM weekly_topics WHERE week_start=?').get(week);
  if(row) return { week, chapter:row.chapter, topic:row.topic, keywords:row.keywords||'', source:'operator' };
  const weeks = Math.floor(Date.parse(week + 'T00:00:00Z') / 86400000 / 7);
  const t = DEFAULT_TOPICS[Math.abs(weeks) % DEFAULT_TOPICS.length];
  return { week, chapter:t.chapter, topic:t.topic, keywords:t.keywords, source:'auto' };
}

// ★ V11 요일(0=일 … 6=토, KST) — 주말 한정 아이템 판정용
function todayDow(){
  const s = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',weekday:'short'}).format(new Date());
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(s);
}
// 상시 판매(limited_days 없음) 또는 오늘이 판매 요일인가
function itemAvailable(it, dow){
  if(!it || !it.limited_days) return true;
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
function isSafeText(s){
  if(!s) return false;
  const t = String(s);
  if(t.length > 200) return false;                  // 과도한 길이(악성 반말 등)
  if(/\d{6,}/.test(t)) return false;                // 긴 숫자(전화/계좌/아이디) 차단
  for(const re of UNSAFE_PATTERNS) if(re.test(t)) return false;
  return true;
}
// LLM 결과 정리 + 안전성 검증(위반 시 null 반환 → 호출부가 프리셋 대사로 폴백)
function sanitizeLine(raw, maxLen){
  if(!raw) return null;
  let line = String(raw).trim().replace(/^["'“”]+|["'“”]+$/g,'').split('\n')[0].trim();
  if(!line) return null;
  line = line.slice(0, maxLen||80);
  return isSafeText(line) ? line : null;
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
  const isDemo = /^(데모|demo)/i.test(u.nickname || '');
  const limit = DAILY_PLAY_LIMIT + (u.play_bonus || 0);
  const overLimit = !isDemo && played >= limit;
  const revive = (u.revive_streak && u.revive_until === today())
    ? { available:true, cost:20, streak:u.revive_streak } : { available:false };
  res.json({ user: u, quests: await getQuestsFor(u.id), streakBonus, revive,
             play: { minutes: played, limit, overLimit, demo: isDemo } });
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
  db.prepare('UPDATE users SET cell_balance=cell_balance-20, streak=?, revive_streak=NULL, revive_until=NULL WHERE id=?')
    .run(streak, u.id);
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
  if(isDemo) return res.json({ ok:true, playMinutes: stored, limit: 999, over:false, demo:true });
  const limit = DAILY_PLAY_LIMIT + (u.play_bonus || 0);
  res.json({ ok:true, playMinutes: stored, limit, over: stored >= limit });
});

// ★ V4 데모 계정: 신규 계정은 지표가 전부 0이라 발표장에서 '성장'이 보이지 않는다.
//   실제 학생 7일치 데이터(레벨·스트릭·보유 부품·과제·접속)를 만들어 준다.
//   브라우저에서 바로 '데모 계정' 버튼을 눌러 전환할 수 있게 한다.
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
  const wipe = ['robots','inventory','cell_tx','quest_logs','interact_logs','game_logs','visits',
    'mailbox','learning_help_logs','chat_messages','learning_plans','weekly_goals','learner_profile',
    'user_memories','goal_claims','review_cards','world_lessons','llm_logs','workshop_logs','class_logs'];
  for(const t of wipe){ try{ db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(did); }catch(e){} }
  try{ db.prepare('DELETE FROM friendships WHERE user_a=? OR user_b=?').run(did,did); }catch(e){}
  try{ db.prepare('DELETE FROM friend_messages WHERE from_user=? OR to_user=?').run(did,did); }catch(e){}
  try{ db.prepare('DELETE FROM cheers WHERE from_user=? OR to_user=?').run(did,did); }catch(e){}

  const token = crypto.randomUUID();
  // 2) 성장 수치 + 학습 偏好
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

  // 10) 우편함: 수령 대기 선물 + 공지 + 친구 응원
  db.prepare('DELETE FROM mailbox WHERE user_id=?').run(did);
  sendMail(did, { title:'이번 주 목표 달성! 80셀', cell:80, tag:'demo-goal',
    body:'퍼즐 2번, 혼자 풀기 3개 — 진짜 해냈어! 80셀 선물이야.' });
  sendMail(did, { title:'이번 주 이야기', cell:0, tag:'demo-notice',
    body:`이번 주는 "${topic.topic}" 이야기예요. 궁금한 게 있으면 루미에게 물어봐!` });
  sendMail(did, { title:'민지가 응원했어요!', cell:0, tag:'demo-cheer',
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
app.post('/api/user/delete', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const uid = u.id;
  const wipe = ['robots','inventory','cell_tx','quest_logs','interact_logs','game_logs','visits',
    'mailbox','learning_help_logs','chat_messages','learning_plans','weekly_goals','learner_profile',
    'user_memories','goal_claims','review_cards','world_lessons','llm_logs','workshop_logs','class_logs'];
  for(const t of wipe){ try{ db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(uid); }catch(e){} }
  try{ db.prepare('DELETE FROM friendships WHERE user_a=? OR user_b=?').run(uid,uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_messages WHERE from_user=? OR to_user=?').run(uid,uid); }catch(e){}
  try{ db.prepare('DELETE FROM cheers WHERE from_user=? OR to_user=?').run(uid,uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_blocks WHERE user_id=? OR blocked_id=?').run(uid,uid); }catch(e){}
  try{ db.prepare('DELETE FROM friend_reports WHERE reporter_id=? OR target_id=?').run(uid,uid); }catch(e){}
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  res.json({ok:true});
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
  const { a, b, token, answer } = req.body || {};
  const na = Number(a), nb = Number(b);
  if(!Number.isInteger(na) || !Number.isInteger(nb)) return res.status(400).json({error:'문제가 올바르지 않아요'});
  // 서명 검증 — 토큰 조작으로 통과 불가
  const expected = quizSign(na, nb);
  if(String(token||'') !== expected) return res.status(400).json({error:'문제가 올바르지 않아요'});
  if(Number(answer) !== na*nb) return res.status(400).json({error:'정답이 아니에요. 다시 풀어볼래요?'});
  const row = db.prepare('SELECT play_bonus FROM users WHERE id=?').get(u.id);
  const nextBonus = Math.min(40, (row && row.play_bonus ? row.play_bonus : 0) + 20);
  db.prepare('UPDATE users SET parent_ok=1, play_bonus=? WHERE id=?').run(nextBonus, u.id);
  res.json({ ok:true, playBonus: nextBonus, limit: DAILY_PLAY_LIMIT + nextBonus });
});
// 부모 승인 상태 조회 (클라이언트가 진입 조건 판단에 사용)
app.get('/api/parent/status', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const row = db.prepare('SELECT parent_ok, play_minutes, play_bonus FROM users WHERE id=?').get(u.id);
  res.json({ parentOk: !!(row && row.parent_ok), playMinutes: (row && row.play_minutes) || 0,
             playBonus: (row && row.play_bonus) || 0,
             limit: DAILY_PLAY_LIMIT + ((row && row.play_bonus) || 0) });
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
  res.json({
    nickname: u.nickname, level: u.level||1,
    understanding: p.understanding||0, solved, chats,
    playMinutes: u.play_minutes||0,
    limit: DAILY_PLAY_LIMIT + (u.play_bonus||0),
    playBonus: u.play_bonus||0,
    friendChatEnabled: !!(p.friend_chat_enabled === undefined ? 1 : p.friend_chat_enabled),
    weekly: { studyDays, solved:weekSolved, chats:weekChats, games:weekGames, memories:weekMemories,
      suggestion: weakFirst ? `${weakFirst} 1문제 다시 풀기` : '새 주제 1개 읽기' },
    games, last7: rows
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
  const r = db.prepare('INSERT INTO robots(user_id,name,template,palette,personality,greeting) VALUES(?,?,?,?,?,?)')
    .run(u.id, cleanName, template, JSON.stringify(cleanPal), personality, greeting);
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
  const txt = await callLLM(IP);
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
  const raw = await callLLM(RP) || '';
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
  res.json(db.prepare('SELECT * FROM items').all().map(it=>({
    ...it,
    limitedDays: it.limited_days ? String(it.limited_days).split(',').map(Number) : null,
    available: itemAvailable(it, dow),
  })));
});
app.post('/api/shop/buy', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(Number(req.body && req.body.itemId));
  if (!it) return res.status(400).json({error:'잘못된 요청'});
  // ★ V11 주말 한정: 프론트를 우회해도 살 수 없도록 서버에서 막는다
  if(!itemAvailable(it, todayDow()))
    return res.status(400).json({error:'오늘은 살 수 없는 한정 아이템이에요! 주말에 다시 만나요 😊'});
  // ★ P1-4 소지품(consumable=0)은 1회만 보유 가능 — 서버에서 거부(프론트 우회 방지)
  const existing = db.prepare('SELECT id FROM inventory WHERE user_id=? AND item_id=?').get(u.id, it.id);
  if(existing && !it.consumable) return res.status(409).json({error:'이미 가지고 있어요'});
  const upd = db.prepare('UPDATE users SET cell_balance = cell_balance - ? WHERE id=? AND cell_balance >= ?').run(it.price, u.id, it.price);
  if (upd.changes === 0) return res.status(400).json({error:'셀이 부족해요!'});
  db.prepare('INSERT INTO cell_tx(user_id,amount,source) VALUES(?,?,?)').run(u.id, -it.price, 'shop');
  if (existing) db.prepare('UPDATE inventory SET qty=qty+1 WHERE id=?').run(existing.id);
  else db.prepare('INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,1)').run(u.id, it.id);
  res.json({ ok:true, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
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
    const reward = score >= 5000 ? 110 : score >= 3000 ? 80 : score >= 1800 ? 50
                 : score >= 1000 ? 30 : score >= 500 ? 20 : 10;
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
  const rows = db.prepare('SELECT id,title,body,cell,item_id,claimed,ts FROM mailbox WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id);
  const unread = rows.filter(r=>!r.claimed && (r.cell>0 || r.item_id)).length;
  res.json({
    unread,
    mails: rows.map(r=>({
      id:r.id, title:r.title, body:r.body, cell:r.cell, claimed:!!r.claimed, ts:r.ts,
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
  const tries = db.prepare("SELECT COUNT(*) c FROM workshop_logs WHERE user_id=? AND day=? AND kind='class_try'").get(u.id, today()).c;
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
  db.prepare('UPDATE robots SET personality=?, greeting=? WHERE id=?').run(personality, greeting, robot.id);
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
  const AP = `너는 DOROBUS의 로봇 "${robot?robot.name:'루미'}"(성격: ${robot?robot.personality:'반짝이'})다. 초등 고학년 아이가 물었다: "${q}". 이번 주 주제는 "${topic.topic}"(CH.${topic.chapter})다. 아이가 이해할 수 있는 한국어 두 문장으로만 답해라. 인사·설명·이모지 없이 답만.`;
  const raw = await callLLM(AP) || '';
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
function requireAdmin(req,res){
  // 키 미설정 상태에서는 아예 동작하지 않는다(fail-closed)
  if(!ADMIN_KEY){ res.status(503).json({error:'관리자 키가 설정되지 않았어요 (ADMIN_KEY 환경변수 필요)'}); return false; }
  const k = req.get('X-Admin-Key') || (req.query && req.query.key) || '';
  if(k !== ADMIN_KEY){ res.status(401).json({error:'관리자 키가 필요해요'}); return false; }
  return true;
}

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
    for(const t of ['robots','inventory','cell_tx','quest_logs','interact_logs','game_logs','visits']){
      try{ db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u.id); }catch(e){}
    }
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
//   평가기준 ①「운영자가 문제·보상·내용을 추가/수정할 수 있는가」에 대한 실제 구현.
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
const CHAT_LIMITS = { chat:10, learn:5, reflect:1 };
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
const MEMORY_KINDS = new Set(['fact','preference','learning','goal','event']);
const MEMORY_LABELS = { fact:'사실', preference:'선호', learning:'학습', goal:'목표', event:'일정' };
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
    const raw = await callLLM(prompt, { temperature:0.2, maxTokens:220, json:true });
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
function weekStartKST(){
  const d = new Date(Date.now() + 9*3600*1000);
  const diff = (d.getUTCDay() + 6) % 7;   // 월요일 시작
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0,10);
}

// ---- AI 학습 계획 (2026-10-28) ----
function planFallback(u, profile){
  const topic = currentTopic();
  const solved = db.prepare("SELECT subject, COUNT(*) c FROM learning_help_logs WHERE user_id=? AND solved=1 GROUP BY subject ORDER BY c DESC LIMIT 3").all(u.id);
  const weak = (profile.weak_topics||'').split(',')[0] || (solved[0] && solved[0].subject) || topic.topic;
  const review = (solved[0] && solved[0].subject) || '변수';
  const total = profile.pref_minutes || 10;
  const m1 = Math.max(1, Math.round(total*0.2));
  const m2 = Math.max(2, Math.round(total*0.5));
  const m3 = Math.max(1, total - m1 - m2);
  return [
    { type:'concept', title:`개념: ${weak}`, desc:'짧은 비유로 이해하기', minutes:m1, message:`${weak}이 뭐야? 쉽게 알려줘.` },
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
  let steps = planFallback(u, profile), source = 'fallback';
  try{
    const prompt = `너는 초등 고학년 학습 코치 '루미'다. 아래 학습자 데이터를 보고 오늘의 3단계 학습 계획을 만들어라.
- 이번 주 주제: ${topic.topic} (CH.${topic.chapter})
- 레벨: ${u.level||1}, 이해도: ${profile.understanding||0}
- 최근 스스로 해결한 개념: ${solvedText}
- 약점: ${profile.weak_topics||'(없음)'}
- 하루 학습 시간: ${profile.pref_minutes||10}분
- 선호 시간: ${profile.pref_time||'afternoon'}
- 관심 주제: ${profile.pref_subjects||'(없음)'}
- 난이도: ${profile.pref_difficulty||'normal'}
- 기억:
${memTextPlan}
규칙:
1) 3단계, 총 ${profile.pref_minutes||10}분 내외.
2) type은 concept / puzzle / review / game 중 하나.
3) concept·review는 message에 아이가 채팅에 그대로 보낼 한 문장(존댓말, 60자 이내).
4) puzzle은 오늘의 퍼즐 3문제.
5) game은 game에 mole 또는 shooter.
6) JSON만 출력: {"steps":[{"type":"concept","title":"...","desc":"...","minutes":2,"message":"..."},...]}
`;
    const raw = await callLLM(prompt, { temperature:0.4, maxTokens:340, json:true });
    let j = null;
    try{ j = raw ? JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0]) : null; }catch(e){ j = null; }
    const clean = normalizePlanSteps(j && j.steps);
    if(clean.length >= 2){ steps = clean; source = 'ai'; }
    else console.log('⚠️ [plan] LLM plan invalid:', raw ? String(raw).slice(0,180) : '(no response)');
  }catch(e){}
  const plan = { steps: steps.map((s,i)=>({ id:'s'+(i+1), done:false, ...s })) };
  db.prepare('INSERT OR REPLACE INTO learning_plans(user_id,day,plan_json,source) VALUES(?,?,?,?)')
    .run(u.id, day, JSON.stringify(plan), source);
  return { plan, source };
}

app.get('/api/plan/today', async (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const force = !!(req.query && String(req.query.refresh) === '1');
  try{
    const { plan, source } = await generatePlan(u, force);
    const done = plan.steps.filter(s=>s.done).length;
    res.json({ ok:true, plan, source, done, allDone: done === plan.steps.length });
  }catch(e){ res.status(500).json({error:'계획을 만들지 못했어요'}); }
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

// ---- 학습 偏好 + 주간 목표 (2026-10-28) ----
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
  // 偏好가 바뀌면 오늘 계획과 이번 주 목표는 새로 짜게 한다.
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
    const prompt = `너는 초등 고학년 학습 코치 '루미'다. 이번 주 3개 목표를 JSON으로만 만들어라.
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
    const raw = await callLLM(prompt, { temperature:0.4, maxTokens:260, json:true });
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
  res.json({ ok:true, code, chatEnabled, requests,
    friends: friends.map(f=>({ id:f.id, friendshipId:f.friendship_id, nickname:f.nickname,
      level:f.level||1, streak:f.streak||0,
      robot:{ template:f.template||'doro', palette:parsePalette(f.palette) },
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
  sendMail(target, { title:'친구가 응원했어요!', body:`${u.nickname}님이 오늘도 화이팅이라고 응원했어요.`, cell:0, tag:`cheer_${u.id}_${today()}` });
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
  res.json({ ok:true, id:r.lastInsertRowid });
});

// ---- 대화: 3 모드 + 최근 6턴 + JSON + 안전 ----
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
  if(mode === 'chat' && /(잊어줘|잊어\s*줘|기억하지\s*마|잊어)/.test(msg)){
    const topic = msg.replace(/(잊어줘|잊어\s*줘|기억하지\s*마|잊어)/g,'').replace(/["'“”]/g,'').replace(/기억/g,'').trim();
    const { removed } = forgetMemories(u.id, topic);
    const reply = topic
      ? (removed ? `"${topic}" 기억은 지웠어. 다른 기억은 그대로야.` : `"${topic}" 기억은 없었어.`)
      : '무엇을 잊을까? "BTS 잊어줘"처럼 말해 줘.';
    db.prepare('INSERT INTO chat_messages(user_id,role,content,mode,hint_level) VALUES(?,?,?,?,?)')
      .run(u.id, 'user', msg, mode, null);
    db.prepare('INSERT INTO chat_messages(user_id,role,content,mode,hint_level) VALUES(?,?,?,?,?)')
      .run(u.id, 'assistant', reply, mode, null);
    return res.json({ ok:true, mode, reply, hintLevel:null, followUp:null,
      left: Math.max(0, limit-used-1), understanding: profileFor(u.id).understanding||0,
      solved:false, balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  }

  const robot = db.prepare('SELECT * FROM robots WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
  const profile = profileFor(u.id);
  const topic = currentTopic();
  // ★ 질문 키워드 우선 → 없으면 이번 주 챕터 → 그래도 없으면 랜덤.
  //   (예전엔 챕터만 봐서 "변수가 뭐야?"에 AI 추천 카드가 들어가는 문제가 있었다)
  const cards = mode === 'learn'
    ? (() => {
        const all = db.prepare('SELECT * FROM knowledge_cards').all();
        let rows = all.filter(c => msg.includes(c.topic) ||
          String(c.tags||'').split(',').some(t => t.trim() && msg.includes(t.trim()))).slice(0,3);
        if(!rows.length) rows = all.filter(c => c.chapter === topic.chapter).slice(0,3);
        if(!rows.length) rows = all.slice().sort(()=>Math.random()-0.5).slice(0,3);
        return rows;
      })()
    : [];
  const cardText = cards.map(c=>`- ${c.concept}: ${c.analogy} (예: ${c.example}) / 힌트: ${c.hint_l1} | ${c.hint_l2} | ${c.hint_l3}`).join('\n') || '(없음)';
  // ★ 2026-10-29: 이번 질문과 실제로 맞은 카드 = 약점/해결 기록의 기준
  const focusCard = mode === 'learn'
    ? (cards.find(c => msg.includes(c.topic) || String(c.tags||'').split(',').some(t=>t.trim() && msg.includes(t.trim()))) || null)
    : null;
  const hist = db.prepare('SELECT role,content FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 6').all(u.id).reverse();
  // ★ 2026-10-31: 이번 질문과 관련된 장기 기억 top 6만 주입
  const mems = retrieveMemories(u.id, msg, 6);
  const memText = memoryPrompt(mems);

  const system = `너는 DOROBUS의 로봇 "${robot?robot.name:'루미'}"(성격: ${robot?robot.personality:'반짝이'})다.
대상: 초등 고학년(10-13세). 짧고 쉬운 한국어, 한 번에 2-4문장.
이번 주 주제: "${topic.topic}"(CH.${topic.chapter}). 학습자 Lv.${u.level||1}, understanding ${profile.understanding||0}.
[모드=${mode}] ${CHAT_MODE_RULES[mode]}
[지식 카드]
${cardText}
[루미가 기억하는 것]
${memText}
[출력] JSON만: {"reply":"...","hintLevel":1|2|3|null,"followUp":"...","safety":"ok"}`;

  let raw = null;
  const t0 = Date.now();
  try{
    raw = await callLLM('', {
      messages: [{ role:'system', content: system }, ...hist, { role:'user', content: msg }],
      temperature: mode==='learn' ? 0.7 : 0.9,
      maxTokens: 300,
    });
  }catch(e){ raw = null; }
  try{ db.prepare('INSERT INTO llm_logs(user_id,mode,model,latency_ms,ok) VALUES(?,?,?,?,?)')
    .run(u.id, mode, LLM_MODEL, Date.now()-t0, raw ? 1 : 0); }catch(e){}

  const parsed = parseChatJSON(raw);
  let reply = parsed ? String(parsed.reply).trim() : (raw ? String(raw).trim() : '');
  let hintLevel = parsed && [1,2,3].includes(Number(parsed.hintLevel)) ? Number(parsed.hintLevel) : (mode==='learn' ? 1 : null);
  let followUp = parsed && parsed.followUp ? sanitizeLine(String(parsed.followUp), 60) : null;

  // ★ 학습 모드: 정답 누설 차단
  if(mode === 'learn' && /(정답은|정답:|```)/.test(reply)){
    reply = (cards[0] && cards[0].hint_l3) || '정답 대신 힌트를 줄게. 먼저 스스로 한 단계만 해 볼까?';
    hintLevel = 3;
  }
  reply = sanitizeLine(reply, 180);
  if(!reply){
    reply = mode==='learn'
      ? ((cards[0] && cards[0].hint_l1) || '같이 한 단계씩 해 보자. 지금 어디까지 했어?')
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
      upsertMemory(u.id, { kind:'learning', key:'understood:'+solvedTopic, value:solvedTopic+' 이해', confidence:0.9, source:'chat' });
    }
  }

  if(mode === 'learn'){
    if(solvedNow) removeWeakTopic(u.id, focusCard ? focusCard.topic : topic.topic);
    else if((hintLevel||1) >= 2 && focusCard) addWeakTopic(u.id, focusCard.topic);
  }

  db.prepare('INSERT INTO chat_messages(user_id,role,content,mode,hint_level) VALUES(?,?,?,?,?)')
    .run(u.id, 'user', msg, mode, hintLevel);
  db.prepare('INSERT INTO chat_messages(user_id,role,content,mode,hint_level) VALUES(?,?,?,?,?)')
    .run(u.id, 'assistant', reply, mode, hintLevel);

  const p2 = profileFor(u.id);
  const remembered = extractMemoryRules(u.id, msg, reply);
  const summary = solvedNow
    ? (focusCard ? `${focusCard.topic}: ${String(focusCard.analogy||'').slice(0,100)}` : null)
    : null;
  res.json({ ok:true, mode, reply, hintLevel, followUp, summary,
             left: Math.max(0, limit - used - 1),
             understanding: p2.understanding || 0, solved: solvedNow,
             remembered: remembered.map(m=>m.value),
             balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
  // LLM 기반 심층 기억 추출은 응답 뒤 백그라운드에서
  setImmediate(()=>{ extractMemoryLLM(u.id, msg, reply); });
});

app.get('/api/chat/history', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const rows = db.prepare('SELECT role,content,mode,hint_level,ts FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id).reverse();
  res.json({ ok:true, messages: rows });
});

app.post('/api/chat/reset', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  db.prepare('DELETE FROM chat_messages WHERE user_id=?').run(u.id);
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
app.get('/api/puzzle/today', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const all = db.prepare('SELECT * FROM knowledge_cards ORDER BY id').all();
  const seed = [...today()].reduce((a,c)=>a*31 + c.charCodeAt(0), u.id * 97);
  // ★ 2026-10-28: 연습 모드는 5문제·보상 없음. 오늘의 퍼즐은 3문제·+30셀.
  const practice = !!(req.query && String(req.query.practice) === '1');
  const count = practice ? 5 : 3;
  const picked = practice
    ? seededShuffle(all, Date.now() + u.id).slice(0, count)
    : seededShuffle(all, seed).slice(0, count);
  const questions = picked.map(c=>{
    let quiz = {}; try{ quiz = JSON.parse(c.quiz || '{}'); }catch(e){}
    return { cardId:c.id, topic:c.topic, question:quiz.q, options:quiz.options || [],
             hints:[c.hint_l1, c.hint_l2, c.hint_l3] };
  });
  const done = practice ? false
    : !!db.prepare("SELECT id FROM game_logs WHERE user_id=? AND day=? AND kind='puzzle'").get(u.id, today());
  res.json({ ok:true, questions, reward: practice ? 0 : 30, done, practice });
});

app.post('/api/puzzle/answer', (req,res)=>{
  const u = authUser(req);
  if (!u) return res.status(401).json({error:'로그인이 필요해요'});
  const { cardId, choice, final } = req.body || {};
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
    return res.json({ ok:true, correct:false, hint: card.hint_l2 || '한 번 더 생각해 보자.' });
  }
  // 마지막 문제가 아니면 정답 여부만 알려주고, 보상은 세트 마지막에 한 번만 준다.
  if(!final){
    return res.json({ ok:true, correct:true, reward:0 });
  }
  try{
    db.prepare("INSERT INTO game_logs(user_id,day,kind,score,reward) VALUES(?,?,?,?,?)")
      .run(u.id, today(), 'puzzle', 3, 30);
  }catch(e){ return res.status(400).json({error:'오늘은 이미 풀었어!'}); }
  grantCell(u.id, 30, 'game');
  const g = addExp(u.id, 15);
  res.json({ ok:true, correct:true, reward:30, growth:g,
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
  grantCell(u.id, 5, 'world_lesson');
  const doneCnt = db.prepare('SELECT COUNT(*) c FROM world_lessons WHERE user_id=? AND day=? AND solved=1').get(u.id, today()).c;
  res.json({ ok:true, correct:true, reward:5, done:doneCnt, total:WORLD_ST,
    explain: (c && c.analogy) || '',
    balance: db.prepare('SELECT cell_balance FROM users WHERE id=?').get(u.id).cell_balance });
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


// 마지막 에러 핸들러 — 스택/내부 정보 노출 방지
app.use((err,_req,res,_next)=>{ console.error('💥', err); res.status(500).json({error:'서버 오류가 났어요'}); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=> console.log(`🤖 루미 prototype → http://localhost:${PORT}`));
