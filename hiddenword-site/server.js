'use strict';
// 히든워드 서버: 정적 페이지 제공 + 방별 게임 진행(심판) + AI 유사도 채점
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';          // 유사도 채점용
const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-5-5'; // 연습봇용
const MOCK = process.env.MOCK_AI === '1';                         // 키 없이 로컬에서 돌려 볼 때
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 30);
const CFG = { maxHints: 10, hintMs: 15 * 60000, guessMs: 5 * 60000, stop: 90, stages: 3, resultMs: Number(process.env.RESULT_MS || 15000), maxPlayers: 6 };

const WORDS = ('사과 바다 구름 시계 거울 우산 열쇠 연필 지도 편지 다리 계단 마당 의자 자전거 기차 비행기 버스 택시 지하철 ' +
'신호등 횡단보도 주차장 터널 강 호수 폭포 사막 숲 섬 화산 동굴 언덕 해변 주말 생일 휴가 눈사람 무지개 번개 ' +
'안개 태풍 소나기 그림자 노을 거북이 고래 상어 독수리 나비 개미 호랑이 여우 늑대 곰 돼지 닭 김치 라면 김밥 ' +
'비빔밥 치킨 피자 햄버거 초콜릿 아이스크림 커피 우유 주스 맥주 소금 설탕 후추 꿀 빵 케이크 의사 간호사 경찰 소방관 ' +
'요리사 선생님 학생 가수 배우 화가 작가 기자 판사 농부 어부 군인 비행사 운전사 탐정 마술사 학교 병원 은행 시장 ' +
'도서관 박물관 영화관 공원 놀이터 수영장 체육관 교회 절 궁전 감옥 공장 농장 항구 공항 우체국 축구 야구 농구 수영 ' +
'달리기 등산 낚시 요가 춤 노래 그림 사진 영화 소설 만화 게임 퍼즐 장기 바둑 카드 사랑 우정 약속 비밀 ' +
'거짓말 용기 질투 행운 꿈 기억 소문 농담 인사 선물 축제 결혼 이별 여행 모험 전쟁 돈 지갑 동전 보석 ' +
'반지 목걸이 안경 모자 장갑 신발 양말 가방 치마 바지 단추 주머니 이불 베개 수건 비누 전화 컴퓨터 로봇 인터넷 ' +
'카메라 라디오 텔레비전 건전지 전구 망원경 현미경 나침반 저울 온도계 자석 망치 가위 바늘 사다리 밧줄 나무 꽃 씨앗 뿌리 ' +
'잎 열매 장미 해바라기 선인장 대나무 버섯 감자 고구마 양파 마늘 당근 오이 호박 수박 포도 불 물 얼음 바람 ' +
'흙 돌 모래 연기 재 먼지 금 은 철 유리 종이 고무 기름 소리 빛 향기 복수 대화 사고 대기 ' +
'질문 도장 배 눈 밤 말 차 병 벌 굴 김 풀 부자 전기 수도 경기 사전 지방 고장 이상 ' +
'정상 부정 사기 기사 상 거리 가사 동화 수정 정원 조화 인상 자리 감정 신 장 대답 침묵 변명 핑계 ' +
'소원 후회 오해 고백 상처 유행 습관 양심 자유 평화 시간 운명 계획 실수 이유 결과 책임 의무 권리 경쟁 ' +
'성공 실패 기회 위기 변화 균형 속도 무게 깊이 온도 리듬 회사 월급 회의 출근 면접 계약 알람 택배 영수증 ' +
'이웃 선배 손님 주인 영웅 천재 범인 증인 호기심 욕심 배신 용서 신뢰 긴장 가지 고개 무리 부채').split(' ');

const clone = o => JSON.parse(JSON.stringify(o));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const cleanName = s => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 12) : '';
const normHint = s => { s = typeof s === 'string' ? s.replace(/\s+/g, '') : ''; return /^[가-힣]{1,12}$/.test(s) ? s : ''; };
const normGuess = s => typeof s === 'string' ? s.replace(/\s+/g, '').slice(0, 20) : '';
const validPid = s => typeof s === 'string' && /^[\w-]{4,40}$/.test(s) && !/^bot\d$/.test(s);
const josa = (w, a, b) => { const c = w.charCodeAt(w.length - 1); return (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28) ? a : b; };

/* ---------- AI ---------- */
function mockAI(prompt) {
  if (prompt.includes('{"ok": true}')) return { ok: true };
  const hid = (/기준어: "([^"]+)"/.exec(prompt) || [])[1] || '';
  const m = /힌트어: "([^"]+)"/.exec(prompt);
  if (!m) { if (!hid) throw new Error('mock'); return { word: '보너스' }; }
  if (m[1] === '달리다') return { noun: false };
  if (m[1] === '보너스') return { noun: true, sem: 80, ctx: 80, rel: 80 };
  if (m[1] === '거의정답') return { noun: true, sem: 97, ctx: 95, rel: 97 };
  const x = (m[1].charCodeAt(0) + hid.charCodeAt(0)) % 60; return { noun: true, sem: x, ctx: x, rel: x };
}
function pickJSON(text) {
  const found = text.match(/\{[^{}]*\}/g) || [];
  for (let k = found.length - 1; k >= 0; k--) { try { return JSON.parse(found[k]); } catch (e) {} }
  return null;
}
async function callAI(prompt, fast) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: fast ? FAST_MODEL : MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt + '\n설명이나 풀이 과정은 쓰지 않는다. 답의 첫 글자는 { 이고 마지막 글자는 } 이다.' }] }),
    });
    if (!res.ok) { const e = new Error('api ' + res.status); e.code = 'api_' + res.status; console.error('AI error', res.status, (await res.text()).slice(0, 300)); throw e; }
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const obj = pickJSON(text);
    if (!obj) { console.error('AI answer without JSON. stop_reason=' + data.stop_reason + ' text=' + JSON.stringify(text.slice(0, 400))); const e = new Error('bad json'); e.code = 'bad_answer'; throw e; }
    return obj;
  } finally { clearTimeout(t); }
}
async function askJSON(prompt, fast) {
  if (MOCK) { await new Promise(r => setTimeout(r, 20)); return mockAI(prompt); }
  if (!KEY) { const e = new Error('no key'); e.code = 'no_api_key'; throw e; }
  try { return await callAI(prompt, fast); }
  catch (e) { if (e.code !== 'bad_answer') throw e; return await callAI(prompt, fast); } // 형식이 어긋난 답은 한 번 더 묻는다
}
const AXES = '판단은 표준국어대사전의 뜻풀이를 기준으로 한다. 두 낱말이 사전에서 어떤 뜻으로 풀이되는지를 떠올려 아래 세 가지를 각각 0~100 정수로 매긴다.\n1) sem = 의미적 거리: 뜻이 비슷할수록 가깝고(점수가 높고), 무관할수록 멀다(점수가 낮다). 뜻이 반대라고 해서 멀어지는 것이 아니다. 무관해야 멀어진다. 반의어는 같은 의미 축 위에 있으므로 조금만 낮다.\n2) ctx = 문맥적 공생: 두 낱말이 실제 말과 글에서 얼마나 함께 사용되는가. 한쪽 뜻풀이나 용례에 다른 쪽이 흔히 등장하면 높다. 두 낱말이 붙어서 사전에 실린 합성어나 굳은 표현을 이루면(안개꽃, 새벽안개, 물안개처럼) 매우 높다.\n3) rel = 관계적 구조: 두 낱말 사이에 어떤 관계(상위·하위, 반대, 부분과 전체, 도구와 쓰임, 원인과 결과, 때와 그때 하는 일 등)가 있고 그 관계가 얼마나 직접적인가.\n다의어는 사전의 뜻갈래마다 따로 살펴 세 값이 가장 높게 나오는 뜻을 기준으로 삼는다.\n\n기준이 되는 예시(sem, ctx, rel):\n- 동의어·유의어 (아버지-아빠): 97, 92, 97\n- 바로 위아래 상위어·하위어 (과일-사과): 90, 92, 97\n- 대표적인 반의어 (낮-밤): 85, 95, 97\n- 늘 붙어 다니는 짝 (바늘-실): 60, 98, 95\n- 그 낱말 하면 바로 떠오르는 상황·대상 (선물-기념일, 노래-가수): 40, 93, 88\n- 붙여 쓰면 합성어나 굳은 표현이 되는 짝 (안개-꽃: 안개꽃, 안개-새벽: 새벽안개): 30, 95, 78\n- 같은 범주의 형제 낱말 (사과-배): 75, 85, 85\n- 분명하지만 간접적인 관련 (지도-여행): 45, 85, 70\n- 느슨한 연관 (지도-종이): 30, 55, 50\n- 무관 (사과-책상): 5, 5, 5\n이 예시들과 견주어 일관되게 매긴다. 낯설고 어려운 낱말이라고 점수를 더 주지 않는다.';
const CRITERIA = AXES;
// 유사도 공식: 세 기준 가운데 높은 두 개에 0.45씩, 가장 낮은 것에 0.1을 주어 원점수를 낸 뒤,
// 난이도별 기준점(K)에서 90%가 되도록 구간별로 환산한다. 실제 AI 채점 결과(안개-구름 원점수 약 70)에 맞춰 잡은 값이다.
const DIFF = { easy: 64, normal: 70, hard: 78 };
function curve(raw, K) {
  const pts = [[0, 0], [K - 20, 65], [K, 90], [K + 15, 96], [100, 100]];
  for (let i = 1; i < pts.length; i++) if (raw <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (raw - x0) / (x1 - x0); }
  return 100;
}
function combine(r, diff) {
  const v = [r.sem, r.ctx, r.rel].map(x => Math.max(0, Math.min(100, Number(x)))).sort((a, b) => b - a);
  if (v.some(x => !Number.isFinite(x))) return NaN;
  const raw = 0.45 * v[0] + 0.45 * v[1] + 0.1 * v[2];
  return Math.round(curve(raw, DIFF[diff] || DIFF.normal));
}
const scorePrompt = (hidden, w) => '너는 단어 게임 "히든워드"의 유사도 심판이다. 기준어와 힌트어가 얼마나 가까운지 평가한다.\n기준어: "' + hidden + '"\n힌트어: "' + w + '"\n' + CRITERIA +
  '\n힌트어가 표준국어대사전에 실린 명사인지도 판정한다(noun). 사전에 없는 말, 명사가 아닌 말은 false다.\n다른 말 없이 JSON만 답한다. 예: {"noun": true, "sem": 60, "ctx": 93, "rel": 90}';
const bonusPrompt = (hidden, used) => '너는 단어 게임 "히든워드"의 심판이다. 출제자가 유사도가 충분히 높은 힌트를 내지 못해 네가 대신 힌트 낱말 하나를 낸다.\n기준어: "' + hidden + '"\n기준어와 뜻이 아주 가깝거나 직접적인 관계가 있는 낱말을 고르되, 다음을 모두 지킨다.\n- 표준국어대사전에 실린 일반명사.\n- 초등학생도 아는, 일상에서 흔히 쓰는 낱말. 드물게 쓰는 한자어, 전문어, 옛말, 사전에만 있고 실제로는 거의 쓰지 않는 낱말은 안 된다.\n- 기준어 자체, 기준어가 글자 그대로 들어간 낱말, 고유명사는 안 된다.' + (used.length ? '\n- 이미 나온 낱말도 안 된다: ' + used.join(', ') : '') +
  '\n흔한 낱말 가운데 가장 가까운 것 하나를 고른다. 한글로만 된 한 낱말이어야 한다. 다른 말 없이 JSON만 답한다. 예: {"word": "낱말"}';
/* ---------- rooms ---------- */
const rooms = new Map();
function newLobby(diff, rounds) { return { v: 1, gid: rid(), diff: diff || 'normal', rounds: rounds === 2 ? 2 : 3, phase: 'lobby', players: [], scores: {}, round: 0, order: [], envs: [], envOf: {}, ready: {}, turn: null, history: [] }; }
function getRoom(code) {
  let R = rooms.get(code);
  if (!R) {
    if (rooms.size >= MAX_ROOMS) return null;
    const HS = newLobby();
    R = { code, hostPid: null, HS, SEC: { gid: HS.gid, words: {}, guesses: {}, bots: {} }, conns: new Set(), busy: false, again: false, last: Date.now(), msg: '' };
    rooms.set(code, R);
  }
  return R;
}
function peersOf(R) {
  const out = [];
  for (const ws of R.conns) if (ws.pid) out.push({ presence: ws.presence, updatedAt: ws.updatedAt });
  for (const id of Object.keys(R.SEC.bots)) out.push({ presence: R.SEC.bots[id], updatedAt: 0 });
  return out;
}
function peerOf(R, id) { let best = null; for (const p of peersOf(R)) { if (p.presence.pid !== id) continue; if (!best || p.updatedAt > best.updatedAt) best = p; } return best; }
function onlineOf(R) { const s = new Set(); for (const p of peersOf(R)) s.add(p.presence.pid); return [...s]; }
function actingHost(R) {
  const on = onlineOf(R).filter(id => !/^bot\d$/.test(id));
  if (R.hostPid && on.indexOf(R.hostPid) >= 0) return R.hostPid;
  const pl = R.HS.players.find(p => on.indexOf(p.id) >= 0);
  return pl ? pl.id : (on[0] || null);
}
function viewFor(R, pid) {
  const st = Object.assign({}, R.HS); delete st.envs;
  const e = R.HS.envOf[pid];
  st.myWords = e != null && R.HS.envs[e] ? R.HS.envs[e].split(',') : null;
  return { t: 'state', s: st, online: onlineOf(R), host: actingHost(R), now: Date.now(), msg: R.msg };
}
function broadcast(R) { for (const ws of R.conns) if (ws.pid && ws.readyState === 1) ws.send(JSON.stringify(viewFor(R, ws.pid))); }
function commit(R) { R.HS.v++; R.last = Date.now(); broadcast(R); return true; }

/* ---------- referee ---------- */
const tkey = st => st.gid + '|' + st.round + '|' + st.turn.ex + '|' + st.turn.stage;
function startTurn(st, ex) { st.turn = { ex, stage: 1, sub: 'hint', hints: [], bonus: [], seq: 0, pending: null, note: '', dl: Date.now() + CFG.hintMs, gdl: 0, guessed: {}, res: null, log: [], nextAt: 0 }; }
function hiddenOf(R, id) { const st = R.HS, w = R.SEC.words[id]; if (!w) return ''; return (st.envs[st.envOf[id]] || '').split(',')[w['r' + st.round]] || ''; }
function openGuess(R) { const T = R.HS.turn; T.sub = 'guess'; T.gdl = Date.now() + CFG.guessMs; T.guessed = {}; R.SEC.guesses = {}; }
async function scorePending(R) {
  const st = R.HS, T = st.turn, w = T.pending.w, hidden = hiddenOf(R, st.order[T.ex]);
  try {
    const r = await askJSON(scorePrompt(hidden, w));
    const s = combine(r || {}, st.diff);
    if (!Number.isFinite(s) && !(r && r.noun === false)) throw Object.assign(new Error('bad'), { code: 'bad_score' });
    if (st.turn !== T || !T.pending) return;
    T.pending = null;
    if (r.noun === false && w !== hidden) { T.note = '"' + w + '"' + josa(w, '은', '는') + ' 명사로 인정되지 않아 힌트 수에 넣지 않았습니다.'; return; }
    T.note = '';
    const sc = w === hidden ? 100 : s;
    T.hints.push({ w, s: sc, g: T.stage });
    if (sc >= CFG.stop) openGuess(R);
  } catch (e) { if (st.turn === T && T.pending) { T.pending.st = 'error'; T.pending.code = String(e && e.code || 'error'); } }
}
async function findBonus(R) {
  const st = R.HS, T = st.turn, hidden = hiddenOf(R, st.order[T.ex]);
  const used = T.hints.map(x => x.w).concat(T.bonus.map(x => x.w));
  try {
    const r = await askJSON(bonusPrompt(hidden, used));
    const w = normHint(r && r.word);
    let s = CFG.stop + 1;
    if (w) { try { const sc = combine(await askJSON(scorePrompt(hidden, w)) || {}, st.diff); if (Number.isFinite(sc)) s = Math.max(CFG.stop, Math.min(99, sc)); } catch (e) {} }
    if (st.turn === T && w && w !== hidden && w.indexOf(hidden) < 0 && used.indexOf(w) < 0 && Number.isFinite(s)) T.bonus.push({ w, s: Math.max(CFG.stop, Math.min(99, s)), g: T.stage });
  } catch (e) {}
}
function randomWord(avoid) { for (let i = 0; i < 40; i++) { const w = WORDS[Math.floor(Math.random() * WORDS.length)]; if (avoid.indexOf(w) < 0) return w; } return '단어'; }
// 연습봇은 모두 상식적으로 추리하되, 눈여겨보는 부분이 조금씩 다르다.
const COMMON = '평범한 사람처럼 상식적으로 생각한다. ';
const BOTS = {
  bot1: { name: '연습봇1', guess: COMMON + '여러 후보가 비슷해 보이면 유사도가 가장 높은 힌트 쪽에 조금 더 무게를 둔다.', hint: COMMON + '기준어를 들으면 떠오르는 낱말 중에서 고른다.' },
  bot2: { name: '연습봇2', guess: COMMON + '여러 후보가 비슷해 보이면 힌트 전체에 두루 맞는 쪽에 조금 더 무게를 둔다.', hint: COMMON + '기준어와 관계가 분명한 낱말(상위어, 반의어, 함께 쓰이는 말) 중에서 고른다.' },
  bot3: { name: '연습봇3', guess: COMMON + '여러 후보가 비슷해 보이면 힌트가 다의어이거나 합성어의 일부일 가능성도 한 번 살펴본다.', hint: COMMON + '기준어와 함께 쓰이거나 붙여 쓰는 낱말 중에서 고른다.' },
};
async function botHint(R, id) {
  const T = R.HS.turn, hidden = hiddenOf(R, id), avoid = T.hints.map(x => x.w).concat(T.bonus.map(x => x.w), [hidden]);
  const far = T.hints.filter(x => x.g === T.stage).length < 2;
  try {
    const r = await askJSON('단어 게임에서 출제자가 되어 힌트 낱말 하나를 낸다. ' + ((BOTS[id] || BOTS.bot1).hint) + '\n기준어: "' + hidden + '"\n' + (far ? '이번에는 기준어와 관련은 있지만 정답이 바로 드러나지 않는 낱말을 고른다.' : '이번에는 기준어와 유사도가 90% 이상 나올 만큼 아주 가까운 낱말을 고른다. 기준어 자체는 안 된다.') + ' 표준국어대사전에 실린 흔한 일반명사, 한글 한 낱말이어야 한다. 쓸 수 없는 낱말: ' + avoid.join(', ') + '\n다른 말 없이 JSON만 답한다. 예: {"word": "낱말"}', true);
    const w = normHint(r && r.word); if (w && avoid.indexOf(w) < 0 && w.indexOf(hidden) < 0) return w;
  } catch (e) {}
  return randomWord(avoid);
}
async function botGuess(R, id) {
  const T = R.HS.turn, key = tkey(R.HS), wrong = []; T.log.forEach(l => Object.keys(l.guesses).forEach(k => wrong.push(l.guesses[k])));
  const taken = Object.keys(R.SEC.bots).filter(b => b !== id).map(b => R.SEC.bots[b].guess).filter(g => g && g.k === key).map(g => g.w);
  const clues = T.hints.concat(T.bonus).map(x => x.w + ' ' + x.s + '%');
  const avoid = wrong.concat(taken, T.hints.map(x => x.w), T.bonus.map(x => x.w));
  try {
    const r = await askJSON('단어 게임에서 숨겨진 한국어 명사를 추리한다. ' + ((BOTS[id] || BOTS.bot1).guess) + '\n아래는 힌트 낱말과, 숨겨진 낱말과의 유사도다.\n' + clues.join(', ') + '\n고를 수 없는 낱말(이미 틀렸거나 힌트로 나온 것, 다른 사람이 이미 고른 것): ' + (avoid.join(', ') || '없음') + '\n가장 그럴듯한 한글 명사 한 낱말을 고른다. 다른 말 없이 JSON만 답한다. 예: {"word": "낱말"}', true);
    const w = normHint(r && r.word); if (w && avoid.indexOf(w) < 0) return w;
  } catch (e) {}
  return randomWord(avoid);
}
async function botThink(R) {
  const st = R.HS, SEC = R.SEC; let ch = false; const now = Date.now();
  for (const id of Object.keys(SEC.bots)) {
    const b = SEC.bots[id]; if (!st.players.some(p => p.id === id)) continue;
    if (st.phase === 'setup') {
      if (st.envOf[id] == null) { const e = [0, 1, 2, 3, 4, 5].filter(x => Object.values(st.envOf).indexOf(x) < 0)[0]; if (e != null && !(b.pick && b.pick.g === st.gid && b.pick.e === e)) { b.pick = { g: st.gid, e }; ch = true; } }
      else if (!st.ready[id] && !(b.w1 && b.w1.g === st.gid)) { b.w1 = { g: st.gid, i: Math.floor(Math.random() * 5) }; ch = true; }
    } else if (st.phase === 'setup2') {
      const wk = 'w' + (st.round + 1);
      if (!st.ready[id] && !(b[wk] && b[wk].g === st.gid) && SEC.words[id]) { const usedI = Object.values(SEC.words[id]), free = [0, 1, 2, 3, 4].filter(i => usedI.indexOf(i) < 0); b[wk] = { g: st.gid, i: free[Math.floor(Math.random() * free.length)] }; ch = true; }
    } else if (st.phase === 'play' && st.turn) {
      const T = st.turn, key = tkey(st), exId = st.order[T.ex];
      if (T.sub === 'hint' && exId === id && !T.pending && now < T.dl) {
        if (b.hint && b.hint.k === key && b.hint.n > T.seq) continue;
        if (T.hints.filter(x => x.g === T.stage).length < CFG.maxHints) { const w = await botHint(R, id); if (R.HS !== st || st.turn !== T) return true; b.hint = { k: key, n: T.seq + 1, w }; ch = true; }
      } else if (T.sub === 'guess' && exId !== id && !T.guessed[id] && !(b.guess && b.guess.k === key)) { const w = await botGuess(R, id); if (R.HS !== st || st.turn !== T) return true; b.guess = { k: key, w }; ch = true; }
    }
  }
  return ch;
}
async function stepOnce(R) {
  const st = R.HS, SEC = R.SEC, now = Date.now();
  if (st.phase === 'lobby') {
    const want = [], seen = {};
    for (const pl of st.players) { const p = peerOf(R, pl.id); if (p && p.presence.join === true) { want.push({ id: pl.id, name: cleanName(p.presence.name) || pl.name }); seen[pl.id] = 1; } }
    for (const p of peersOf(R)) { const pr = p.presence; if (pr.join === true && pr.pid && !seen[pr.pid] && want.length < CFG.maxPlayers && cleanName(pr.name)) { seen[pr.pid] = 1; want.push({ id: pr.pid, name: cleanName(pr.name) }); } }
    if (JSON.stringify(want) !== JSON.stringify(st.players)) { st.players = want; return commit(R); }
    return false;
  }
  if (st.phase === 'setup' || st.phase === 'setup2') {
    let ch = false; const first = st.phase === 'setup';
    for (const pl of st.players) {
      const p = peerOf(R, pl.id); if (!p) continue; const pr = p.presence;
      if (first && st.envOf[pl.id] == null) {
        const k = pr.pick;
        if (k && k.g === st.gid && Number.isInteger(k.e) && k.e >= 0 && k.e < 6 && Object.values(st.envOf).indexOf(k.e) < 0) { st.envOf[pl.id] = k.e; ch = true; }
      } else if (!st.ready[pl.id]) {
        const w = pr['w' + (st.round + 1)];
        if (w && w.g === st.gid && Number.isInteger(w.i) && w.i >= 0 && w.i < 5) {
          if (first) { SEC.words[pl.id] = { r1: w.i }; st.ready[pl.id] = true; ch = true; }
          else if (SEC.words[pl.id] && Object.values(SEC.words[pl.id]).indexOf(w.i) < 0) { SEC.words[pl.id]['r' + (st.round + 1)] = w.i; st.ready[pl.id] = true; ch = true; }
        }
      }
    }
    if (st.players.every(pl => st.ready[pl.id])) {
      if (first) st.order = shuffle(st.players.map(p => p.id));
      st.round = st.round + 1; st.ready = {}; st.phase = 'play'; startTurn(st, 0); ch = true;
    }
    return ch ? commit(R) : false;
  }
  if (st.phase !== 'play' || !st.turn) return false;
  const T = st.turn, exId = st.order[T.ex], key = tkey(st);
  if (T.sub === 'hint') {
    if (T.pending) { if (T.pending.st !== 'scoring') return false; await scorePending(R); return commit(R); }
    const p = peerOf(R, exId), pr = p && p.presence, hi = pr && pr.hint;
    if (hi && hi.k === key && Number.isInteger(hi.n) && hi.n > T.seq && now < T.dl) {
      T.seq = hi.n; const w = normHint(hi.w);
      if (!w) T.note = '힌트는 한글 명사 한 단어만 낼 수 있습니다.';
      else if (T.hints.some(x => x.w === w) || T.bonus.some(x => x.w === w)) T.note = '"' + w + '"' + josa(w, '은', '는') + ' 이미 나온 단어입니다.';
      else { T.pending = { w, st: 'scoring' }; T.note = ''; }
      return commit(R);
    }
    const count = T.hints.filter(x => x.g === T.stage).length;
    if (now >= T.dl || count >= CFG.maxHints) { T.sub = 'bonus'; return commit(R); }
    return false;
  }
  if (T.sub === 'bonus') { await findBonus(R); if (R.HS === st && st.turn === T) { openGuess(R); return commit(R); } return true; }
  if (T.sub === 'guess') {
    let ch = false; const others = st.players.filter(pl => pl.id !== exId);
    for (const pl of others) {
      if (T.guessed[pl.id]) continue;
      const p = peerOf(R, pl.id), g = p && p.presence.guess;
      if (g && g.k === key) { const w = normGuess(g.w); if (w) { SEC.guesses[pl.id] = w; T.guessed[pl.id] = true; ch = true; } }
    }
    if (others.every(pl => T.guessed[pl.id]) || now >= T.gdl) {
      const hidden = hiddenOf(R, exId), pts = st.round; // 몇 차 힌트든 같은 점수: 1라운드 1점, 2라운드 2점, 3라운드 3점
      const correct = others.filter(pl => SEC.guesses[pl.id] === hidden).map(pl => pl.id);
      let over = true;
      if (correct.length) correct.forEach(id => { st.scores[id] = (st.scores[id] || 0) + pts; });
      else { st.scores[exId] = (st.scores[exId] || 0) + pts; over = T.stage >= CFG.stages; }
      T.res = { g: clone(SEC.guesses), correct, pts, over, word: over ? hidden : '' };
      T.sub = 'result'; T.nextAt = now + CFG.resultMs; SEC.guesses = {}; ch = true;
    }
    return ch ? commit(R) : false;
  }
  if (T.sub === 'result') {
    if (now < T.nextAt) return false;
    T.log.push({ g: T.stage, guesses: T.res.g, correct: T.res.correct, pts: T.res.pts });
    if (T.res.over) {
      st.history.push({ r: st.round, ex: exId, word: T.res.word, stage: T.stage, winners: T.res.correct });
      if (T.ex + 1 < st.order.length) startTurn(st, T.ex + 1);
      else if (st.round < (st.rounds || 3)) { st.phase = 'setup2'; st.turn = null; st.ready = {}; }
      else { st.phase = 'end'; st.turn = null; }
    } else { T.stage++; T.sub = 'hint'; T.dl = now + CFG.hintMs; T.res = null; T.note = ''; }
    return commit(R);
  }
  return false;
}
async function step(R) {
  if (R.busy) { R.again = true; return; }
  R.busy = true;
  try { let n = 0; do { R.again = false; const st = R.HS; if (await botThink(R)) R.again = true; if (R.HS === st && await stepOnce(R)) R.again = true; } while (R.again && ++n < 60); }
  catch (e) { console.error('step error', e); }
  finally { R.busy = false; }
}
async function command(R, ws, c) {
  if (ws.pid !== actingHost(R)) return;
  const st = R.HS, T = st.turn;
  if (c === 'start') {
    if (st.phase !== 'lobby' || st.players.length < 2) return;
    try { await askJSON('다른 말 없이 JSON만 답한다: {"ok": true}', true); }
    catch (e) { R.msg = e.code === 'no_api_key' ? 'AI 키가 설정되지 않았습니다. 서버 환경 변수 ANTHROPIC_API_KEY를 넣어 주세요.' : 'AI 심판에 연결하지 못했습니다 (' + (e.code || 'error') + '). API 키와 잔액을 확인해 주세요.'; broadcast(R); return; }
    if (R.HS !== st || st.phase !== 'lobby' || st.players.length < 2) return;
    R.msg = '';
    const pool = shuffle(WORDS).slice(0, 30);
    st.gid = rid(); st.envs = [0, 1, 2, 3, 4, 5].map(i => pool.slice(i * 5, i * 5 + 5).join(','));
    st.envOf = {}; st.ready = {}; st.scores = {}; st.history = []; st.order = []; st.round = 0; st.turn = null;
    st.players.forEach(p => { st.scores[p.id] = 0; });
    R.SEC = { gid: st.gid, words: {}, guesses: {}, bots: R.SEC.bots };
    st.phase = 'setup'; commit(R);
  } else if (c === 'reset') {
    R.HS = newLobby(st.diff, st.rounds); R.SEC = { gid: R.HS.gid, words: {}, guesses: {}, bots: R.SEC.bots }; R.msg = ''; commit(R);
  } else if (c === 'skip') { if (T && T.sub === 'result') T.nextAt = 0; }
  else if (c === 'retry') { if (T && T.pending && T.pending.st === 'error') { T.pending.st = 'scoring'; commit(R); } }
  else if (c === 'drop') { if (T && T.pending && T.pending.st === 'error') { T.pending = null; T.note = 'AI 채점에 실패한 힌트를 취소했습니다. 다른 단어를 내 주세요.'; commit(R); } }
  else if (c === 'addBot') { if (st.phase === 'lobby') { let n = 1; while (R.SEC.bots['bot' + n]) n++; if (n <= 3) R.SEC.bots['bot' + n] = { pid: 'bot' + n, name: BOTS['bot' + n].name, join: true }; } }
  else if (c.slice(0, 5) === 'diff:') { if (st.phase === 'lobby' && DIFF[c.slice(5)]) { st.diff = c.slice(5); commit(R); } }
  else if (c === 'rounds:2' || c === 'rounds:3') { if (st.phase === 'lobby') { st.rounds = Number(c.slice(7)); commit(R); } }
  else if (c === 'clearBots') { if (st.phase === 'lobby') R.SEC.bots = {}; }
  step(R);
}

/* ---------- http + websocket ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (MOCK && url.pathname === '/debug') { const R = rooms.get(url.searchParams.get('room')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(R ? { HS: R.HS, SEC: R.SEC } : null)); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX, (err, buf) => { if (err) { res.writeHead(500); res.end('error'); return; } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(buf); });
    return;
  }
  res.writeHead(404); res.end('not found');
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.presence = {}; ws.updatedAt = Date.now(); ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      if (ws.room) return;
      const code = typeof m.room === 'string' && /^[a-z0-9]{4,12}$/.test(m.room) ? m.room : null;
      if (!code || !validPid(m.pid)) { ws.send(JSON.stringify({ t: 'err', m: '방 주소가 올바르지 않습니다.' })); return; }
      const R = getRoom(code);
      if (!R) { ws.send(JSON.stringify({ t: 'err', m: '지금은 방을 더 만들 수 없습니다. 잠시 뒤에 다시 시도해 주세요.' })); return; }
      ws.room = R; ws.pid = m.pid; if (!R.hostPid) R.hostPid = m.pid;
      R.conns.add(ws); applyPatch(ws, m.presence);
      broadcast(R); step(R);
    } else if (ws.room && m.t === 'p') { applyPatch(ws, m.patch); step(ws.room); }
    else if (ws.room && m.t === 'cmd' && typeof m.c === 'string') command(ws.room, ws, m.c).then(() => broadcast(ws.room));
  });
  ws.on('close', () => { const R = ws.room; if (!R) return; R.conns.delete(ws); R.last = Date.now(); broadcast(R); step(R); });
  ws.on('error', () => {});
});
function applyPatch(ws, patch) {
  if (!patch || typeof patch !== 'object') return;
  const cur = Object.assign({}, ws.presence);
  for (const k of ['name', 'join', 'pick', 'w1', 'w2', 'w3', 'hint', 'guess']) { if (!(k in patch)) continue; if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; }
  cur.pid = ws.pid;
  if (JSON.stringify(cur).length > 2000) return;
  ws.presence = cur; ws.updatedAt = Date.now();
}
setInterval(() => {
  for (const [code, R] of rooms) {
    if (R.conns.size) step(R);
    else if (Date.now() - R.last > 6 * 3600 * 1000) rooms.delete(code);
  }
}, 1000);
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} } }, 30000);
server.listen(PORT, () => console.log('히든워드 서버 실행 중: http://localhost:' + PORT + (MOCK ? ' (모의 AI)' : KEY ? '' : ' (경고: ANTHROPIC_API_KEY 없음)')));
