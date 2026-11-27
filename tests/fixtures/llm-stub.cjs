// 테스트 전용 LLM 스텁 (v1.83). server.js 가 ROOMI_TEST_LLM_STUB 로 이 파일을 불러올 때만 쓰인다.
//   모드는 STUB_MODE_FILE 파일을 호출마다 읽는다(테스트가 서버 재시작 없이 모드를 바꾼다).
//   ok-slow / no-slow : STUB_DELAY_MS 뒤 맞다/틀리다 판정   · fail : 즉시 예외
//   hang              : 영원히 응답하지 않음(시간 초과 경로 검증용)
//   모든 호출은 STUB_LOG 파일에 한 줄(JSON)로 남는다.
'use strict';
const fs = require('fs');

function currentMode(){
  try{ return String(fs.readFileSync(process.env.STUB_MODE_FILE, 'utf8')).trim() || 'ok-slow'; }
  catch(e){ return 'ok-slow'; }
}
function record(obj){
  if(process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(obj) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLM(prompt, opts){
  const mode = currentMode();
  const m = String(prompt || '').match(/\[아이의 설명\] ([^\n]*)/);
  record({ mode, expl: m ? m[1].trim() : null, at: Date.now() });
  if(mode === 'hang') return new Promise(() => {});
  if(mode === 'fail') throw new Error('stub: 실패 모드');
  await sleep(Number(process.env.STUB_DELAY_MS || 50));
  const ok = mode.startsWith('ok');
  return {
    text: JSON.stringify({ ok, reply: ok ? '좋아, 다음은 어떻게 될까?' : '그렇구나, 다른 예로도 생각해 볼까?' }),
    model: 'stub', usage: null, promptChars: String(prompt || '').length, provider: 'stub',
  };
}

module.exports = { callLLM };
