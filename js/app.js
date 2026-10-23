/* ===== 六级高频词汇 PWA 核心逻辑 ===== */
'use strict';

/* ---------- 状态管理 ---------- */
const STATE_KEY = 'cet6.state.v1';
const state = loadState();

const MODE_LABEL = {
  swipe: '刷词模式',
  ebbinghaus: '艾宾浩斯模式',
};

function normalizeMode(value) {
  return value === 'ebbinghaus' ? 'ebbinghaus' : 'swipe';
}

function isSpecialMarkMode(mode) {
  return normalizeMode(mode || state.mode) === 'ebbinghaus';
}

function normalizeMap(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function clampDailyGoal(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(500, Math.max(10, Math.round(n / 10) * 10));
}

function todayKey(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function normalizeDailyReview(raw) {
  const out = (raw && typeof raw === 'object') ? raw : {};
  const words = Array.isArray(out.words) ? out.words.filter(w => typeof w === 'string') : [];
  return {
    date: typeof out.date === 'string' ? out.date : '',
    count: Math.max(0, Math.floor(Number(out.count) || 0)),
    words: [...new Set(words)],
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && typeof s === 'object') return normalizeState(s);
  } catch (e) { /* 损坏则重建 */ }
  return normalizeState({});
}

function normalizeState(s) {
  const markedByMode = normalizeMap(s.markedByMode);
  const markedScheduleByMode = normalizeMap(s.markedScheduleByMode);
  return {
    mode: normalizeMode(s.mode),
    display: s.display === 'direct' ? 'direct' : 'flip',
    wordlist: (s.wordlist === 'full' || s.wordlist === 'zsb') ? s.wordlist : 'core',
    round: Number(s.round) || 1,
    dailyGoal: clampDailyGoal(s.dailyGoal),
    doneMap: (s.doneMap && typeof s.doneMap === 'object') ? s.doneMap : {},
    markedByMode: {
      // 旧版本的标记迁入刷词模式，避免升级后已有标记丢失。
      swipe: normalizeMap(markedByMode.swipe || s.marked),
      ebbinghaus: normalizeMap(markedByMode.ebbinghaus),
    },
    markedScheduleByMode: {
      swipe: normalizeMap(markedScheduleByMode.swipe || s.markedSchedule),
      ebbinghaus: normalizeMap(markedScheduleByMode.ebbinghaus),
    },
    ebbinghausSchedule: (s.ebbinghausSchedule && typeof s.ebbinghausSchedule === 'object')
      ? s.ebbinghausSchedule : {},
    dailyReview: normalizeDailyReview(s.dailyReview),
  };
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

/* 当前词表 */
function wordList() {
  if (state.wordlist === 'full') return CET6_WORDS_FULL;
  if (state.wordlist === 'zsb' && typeof ZSB_WORDS !== 'undefined') return ZSB_WORDS;
  return CET6_WORDS;
}

/* ---------- 朗读 (预录mp3优先, 浏览器TTS兜底) ---------- */
let curAudio = null;
function speak(word) {
  try {
    if (!curAudio) curAudio = new Audio();
    curAudio.pause();
    curAudio.src = 'audio/' + encodeURIComponent(word) + '.mp3';
    const p = curAudio.play();
    if (p && p.catch) p.catch(() => ttsSpeak(word)); // 无音频文件时回退TTS
  } catch (e) { ttsSpeak(word); }
}

/* 停止一切发声: 预录音频 + TTS (离开卡片/结束会话时调用) */
function stopSpeak() {
  try { if (curAudio) { curAudio.pause(); curAudio.currentTime = 0; } } catch (e) {}
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {}
}

let voicesCache = [];
function refreshVoices() { voicesCache = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function pickMaleVoice() {
  const en = voicesCache.filter(v => /^en(-|_)?/i.test(v.lang));
  if (!en.length) return null;
  const male = en.find(v => /male|david|mark|alex|daniel|fred|george|james|guy|reed|grandpa/i.test(v.name) && !/female/i.test(v.name));
  return male || en.find(v => /en[-_]US/i.test(v.lang)) || en[0];
}

function ttsSpeak(word) { // 浏览器TTS兜底(部分手机阉割了此功能)
  if (!('speechSynthesis' in window)) return;
  const synth = speechSynthesis;
  try { synth.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.92;
  // 立即取一次 voices(部分手机首次为空, 隔一段再试)
  if (!voicesCache.length) refreshVoices();
  const v = pickMaleVoice();
  if (v) u.voice = v;
  u.onerror = () => { // 部分安卓机 cancel 后立即 speak 会静音, 延迟重试一次
    if (!u._retried) {
      u._retried = true;
      setTimeout(() => synth.speak(u), 120);
    }
  };
  // Chrome安卓: cancel 后同一帧 speak 会被吞, 延迟一帧
  setTimeout(() => synth.speak(u), 50);
}

/* ---------- 会话 ---------- */
let lastNavTime = 0; // 最近一次翻页时间, 防止滑动后误触发翻面
const session = {
  active: false,
  kind: 'remain', // remain=背未完成 / done=复习已完成 / marked=标记词 / review=艾宾浩斯复习
  markMode: 'swipe', // 当前会话对应哪一套独立标记
  words: [],      // 本轮会话的词对象列表
  queue: [],      // 播放队列 {idx, review}
  pos: 0,
  noProgress: false, // 复习/标记模式只读, 不写入背诵进度
};

const SESSION_LABEL = {
  remain: '刷词模式',
  done: '复习模式',
  marked: '标记词复习',
  review: '艾宾浩斯复习',
};

function marksForMode(mode) {
  return state.markedByMode[normalizeMode(mode || state.mode)];
}

function markedSchedulesForMode(mode) {
  return state.markedScheduleByMode[normalizeMode(mode || state.mode)];
}

/* 当前模式的标记词集合: 当前词表在前, 再补上其它词表里标过的词 */
function markedWords(mode) {
  const marks = marksForMode(mode);
  const seen = new Set();
  const out = [];
  const push = w => {
    if (w && marks[w.word] && !seen.has(w.word)) { seen.add(w.word); out.push(w); }
  };
  const lists = [
    wordList(),
    CET6_WORDS,
    CET6_WORDS_FULL,
    typeof ZSB_WORDS !== 'undefined' ? ZSB_WORDS : null,
  ];
  lists.forEach(list => { if (list) list.forEach(push); });
  return out;
}

/* ---------- 跨天复习间隔 ---------- */
/* 间隔参考艾宾浩斯遗忘曲线: 12小时 → 1天 → 2天 → 4天 → 7天 → 15天 → 30天
   艾宾浩斯新词和刷词模式的标记词使用；艾宾浩斯特重点词只做顺序复习。 */
const REVIEW_INTERVALS = [
  12 * 3600e3,
  1 * 86400e3,
  2 * 86400e3,
  4 * 86400e3,
  7 * 86400e3,
  15 * 86400e3,
  30 * 86400e3,
];

function syncDailyReview(now) {
  now = now || Date.now();
  const key = todayKey(new Date(now));
  if (!state.dailyReview || state.dailyReview.date !== key) {
    state.dailyReview = { date: key, count: 0, words: [] };
  }
  return state.dailyReview;
}

function dailyReviewCount(now) {
  return syncDailyReview(now).count;
}

function markDailyReviewed(word, now) {
  const daily = syncDailyReview(now);
  if (daily.words.includes(word)) return false;
  daily.words.push(word);
  daily.count = daily.words.length;
  return true;
}

function allWordEntries() {
  const seen = new Set();
  const out = [];
  [
    CET6_WORDS,
    CET6_WORDS_FULL,
    typeof ZSB_WORDS !== 'undefined' ? ZSB_WORDS : null,
  ].forEach(list => {
    if (!list) return;
    list.forEach(w => {
      if (w && w.word && !seen.has(w.word)) {
        seen.add(w.word);
        out.push(w);
      }
    });
  });
  return out;
}

function ebbinghausScheduleOf(word) {
  const s = state.ebbinghausSchedule && state.ebbinghausSchedule[word];
  return (s && typeof s === 'object') ? s : null;
}

function ensureEbbinghausSchedule(word, now) {
  now = now || Date.now();
  let s = ebbinghausScheduleOf(word);
  if (!s) {
    s = { stage: 0, due: now + REVIEW_INTERVALS[0], lapses: 0, last: now };
    state.ebbinghausSchedule[word] = s;
  }
  return s;
}

/* 独立的新词复习队列: 背完的新词自动进入计划；特重点标记不影响其排期。 */
function ebbinghausWords() {
  return allWordEntries().filter(w => ebbinghausScheduleOf(w.word));
}

function ebbinghausStats(now) {
  now = now || Date.now();
  const words = ebbinghausWords();
  let due = 0;
  let nextDue = null;
  words.forEach(w => {
    const s = ebbinghausScheduleOf(w.word);
    if (!s || !(s.due > now)) due++;
    else if (nextDue === null || s.due < nextDue) nextDue = s.due;
  });
  const goal = clampDailyGoal(state.dailyGoal);
  const today = dailyReviewCount(now);
  return {
    total: words.length,
    due,
    today,
    goal,
    remaining: Math.max(0, goal - today),
    nextDue,
  };
}

function ebbinghausReviewQueue(now) {
  now = now || Date.now();
  const stats = ebbinghausStats(now);
  if (!stats.remaining) return [];
  return ebbinghausWords()
    .filter(w => {
      const s = ebbinghausScheduleOf(w.word);
      return !s || !(s.due > now);
    })
    .sort((a, b) => {
      const da = Number(ebbinghausScheduleOf(a.word).due) || 0;
      const db = Number(ebbinghausScheduleOf(b.word).due) || 0;
      return da - db;
    })
    .slice(0, stats.remaining);
}

function scheduleOf(word, mode) {
  const schedules = markedSchedulesForMode(mode);
  const s = schedules && schedules[word];
  return (s && typeof s === 'object') ? s : null;
}

/* 标记一个词时建立复习计划; 已存在则原样返回 */
function ensureSchedule(word, now, mode) {
  now = now || Date.now();
  const schedules = markedSchedulesForMode(mode);
  let s = scheduleOf(word, mode);
  if (!s) {
    s = { stage: 0, due: now + REVIEW_INTERVALS[0], lapses: 0, last: now };
    schedules[word] = s;
  }
  return s;
}

function humanInterval(ms) {
  if (ms >= 86400e3) return Math.round(ms / 86400e3) + ' 天';
  if (ms >= 3600e3) return Math.round(ms / 3600e3) + ' 小时';
  return Math.max(1, Math.round(ms / 60000)) + ' 分钟';
}

function formatDueTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
}

/* 已到期待复习的标记词(历史遗留的、没有计划的标记词视为立即到期) */
function isDueNow(word, now, mode) {
  const s = scheduleOf(word, mode);
  return !s || !(s.due > now);
}

function markedScheduleStats(now, mode) {
  now = now || Date.now();
  const words = markedWords(mode);
  let due = 0, nextDue = null;
  words.forEach(w => {
    const s = scheduleOf(w.word, mode);
    if (!s || !(s.due > now)) due++;
    else if (nextDue === null || s.due < nextDue) nextDue = s.due;
  });
  return { total: words.length, due: due, nextDue: nextDue };
}

/* 复习队列: 到期的在前, 未到期的在后, 组内按到期时间升序 */
function markedReviewQueue(now, mode) {
  now = now || Date.now();
  const items = markedWords(mode).map(w => {
    const s = scheduleOf(w.word, mode);
    return { w: w, due: (s && typeof s.due === 'number') ? s.due : 0 };
  });
  const due = items.filter(x => x.due <= now).sort((a, b) => a.due - b.due).map(x => x.w);
  const later = items.filter(x => x.due > now).sort((a, b) => a.due - b.due).map(x => x.w);
  return { due: due, later: later };
}

function startSession(kind) {
  const all = wordList();
  const markMode = kind === 'review' ? 'ebbinghaus' : normalizeMode(state.mode);
  let list;
  let dueSet = null;
  if (kind === 'marked') {
    if (isSpecialMarkMode(markMode)) {
      // 艾宾浩斯特重点词只做顺序浏览，不使用跨天记忆计划。
      list = markedWords(markMode);
    } else {
      const rq = markedReviewQueue(Date.now(), markMode);
      list = rq.due.concat(rq.later);
      dueSet = new Set(rq.due.map(w => w.word));
    }
  } else if (kind === 'review') {
    list = ebbinghausReviewQueue();
    dueSet = new Set(list.map(w => w.word));
  } else if (kind === 'done') list = all.filter(w => state.doneMap[w.word]);
  else list = all.filter(w => !state.doneMap[w.word]);

  if (!list.length) {
    if (kind === 'marked') {
      showDoneOverlay(
        isSpecialMarkMode(markMode)
          ? '当前没有特重点标记词\n背词时点底部「⭐ 标记」即可加入特重点'
          : '当前没有' + MODE_LABEL[markMode] + '标记词\n背词时点底部「⭐ 标记」即可收藏',
        true
      );
    }
    else if (kind === 'done') showDoneOverlay('已完成词库是空的', true);
    else if (kind === 'review') {
      const stats = ebbinghausStats();
      showDoneOverlay(
        stats.remaining
          ? '现在没有到期单词\n新词完成后会按遗忘曲线自动安排复习'
          : '今日目标已完成 ' + stats.today + '/' + stats.goal + '\n明天再来继续复习吧',
        true
      );
    }
    else showDoneOverlay('本轮已全部背完！', true);
    return;
  }

  session.kind = kind;
  session.markMode = markMode;
  session.noProgress = (kind !== 'remain');
  session.words = list;
  // 每轮只出现一次; 跨天重复由独立复习计划控制。
  session.queue = list.map((w, i) => ({
    idx: i,
    review: !!(dueSet && dueSet.has(w.word)),
  }));
  session.pos = 0;
  session.active = true;
  showPage('swipe');
  renderCard();
}

function curEntry() { return session.queue[session.pos]; }

/* 卡片计数使用当前词表中的绝对位置，而不是本次筛选队列中的位置。 */
function wordPositionInList(word) {
  const all = wordList();
  const index = all.findIndex(item => item.word === word.word);
  return {
    current: index >= 0 ? index + 1 : session.pos + 1,
    total: all.length,
  };
}

function renderCard() {
  const e = curEntry();
  if (!e) return endSession();
  const w = session.words[e.idx];
  const card = document.getElementById('word-card');
  card.classList.remove('flipped');
  card.classList.toggle('direct', state.display === 'direct');

  document.getElementById('word-text').textContent = w.word;
  document.getElementById('word-phonetic').textContent = w.phonetic || '';
  document.getElementById('word-meaning-front').textContent = w.meaning || '';
  document.getElementById('word-text-back').textContent = w.word;
  document.getElementById('word-phonetic-back').textContent = w.phonetic || '';
  document.getElementById('word-meaning').textContent = w.meaning || '';

  const badge = document.getElementById('review-badge');
  const intervalMarkedReview =
    session.kind === 'marked' && !isSpecialMarkMode(session.markMode);
  const intervalReview = session.kind === 'review' || intervalMarkedReview;
  if (intervalReview) {
    const st = session.kind === 'marked'
      ? scheduleOf(w.word, session.markMode)
      : ebbinghausScheduleOf(w.word);
    const stage = st ? (Number(st.stage) || 0) : 0;
    badge.textContent = e.review
      ? '⏰ 到期复习'
      : (stage > 0
        ? '🔁 第 ' + (stage + 1) + ' 次复习'
        : (session.kind === 'marked' ? '⭐ 已标记' : '📚 新词'));
    badge.classList.add('show');
  } else if (session.kind === 'marked') {
    badge.textContent = '⭐ 特重点';
    badge.classList.add('show');
  } else if (session.kind === 'remain' && isSpecialMarkMode(session.markMode)) {
    badge.textContent = '📚 新词';
    badge.classList.add('show');
  } else {
    badge.textContent = '🔁 复习';
    badge.classList.toggle('show', !!e.review);
  }

  let sessionLabel = SESSION_LABEL[session.kind] || MODE_LABEL[session.markMode];
  if (session.kind === 'remain') {
    sessionLabel = isSpecialMarkMode(session.markMode)
      ? '艾宾浩斯 · 背新词'
      : MODE_LABEL[session.markMode];
  }
  if (session.kind === 'marked') {
    sessionLabel = isSpecialMarkMode(session.markMode)
      ? '特重点标记词'
      : MODE_LABEL[session.markMode] + '标记词';
  }
  document.getElementById('swipe-mode-label').textContent = sessionLabel;
  document.getElementById('swipe-hint').textContent =
    intervalReview
      ? '「没记住」回到 12 小时 · 「记住了」进入下一复习间隔'
      : (session.kind === 'remain' && isSpecialMarkMode(session.markMode))
        ? '← 左滑下一个 · 新词会自动加入艾宾浩斯复习计划'
      : (state.display === 'direct' ? '← 左滑下一个 · 右滑上一个' : '← 左滑下一个 · 点击卡片看释义');
  const gradeBar = document.getElementById('grade-bar');
  if (gradeBar) {
    gradeBar.style.display = intervalReview ? 'flex' : 'none';
  }
  const position = wordPositionInList(w);
  document.getElementById('swipe-counter').textContent =
    position.current + ' / ' + position.total;
  syncMarkButton();

  speak(w.word);
}

function markCurrentDone() {
  const e = curEntry();
  if (!e) return;
  if (!session.noProgress) {
    const word = session.words[e.idx].word;
    state.doneMap[word] = 1;
    ensureEbbinghausSchedule(word);
  }
}

/* 标记词评分: 记住了 -> 推进到下一间隔; 没记住 -> 回到第一间隔并本轮稍后重现 */
function gradeMarked(ok) {
  if (!session.active || session.kind !== 'marked' || isSpecialMarkMode(session.markMode)) return;
  const e = curEntry();
  if (!e) return;
  const w = session.words[e.idx];
  const now = Date.now();
  const s = ensureSchedule(w.word, now, session.markMode);
  s.last = now;
  if (ok) {
    s.stage = Math.min((Number(s.stage) || 0) + 1, REVIEW_INTERVALS.length - 1);
    s.due = now + REVIEW_INTERVALS[s.stage];
    toast('✅ 记住了 · ' + humanInterval(REVIEW_INTERVALS[s.stage]) + '后再复习');
  } else {
    s.stage = 0;
    s.due = now + REVIEW_INTERVALS[0];
    s.lapses = (Number(s.lapses) || 0) + 1;
    session.queue.push({ idx: e.idx, review: true }); // 本轮稍后再出现一次
    toast('😖 没记住 · 本轮稍后再复习');
  }
  saveState();
  refreshHome();
  next(1);
}

/* 独立艾宾浩斯复习评分: 逾期仍从当前节点开始，每次只推进一个节点。
   "没记住"退回第一节点，但同一词本轮只出现一次。 */
function gradeEbbinghaus(ok) {
  if (!session.active || session.kind !== 'review') return;
  const e = curEntry();
  if (!e) return;
  const w = session.words[e.idx];
  const now = Date.now();
  const s = ensureEbbinghausSchedule(w.word, now);
  s.last = now;
  markDailyReviewed(w.word, now);
  if (ok) {
    s.stage = Math.min((Number(s.stage) || 0) + 1, REVIEW_INTERVALS.length - 1);
    s.due = now + REVIEW_INTERVALS[s.stage];
    toast('✅ 记住了 · ' + humanInterval(REVIEW_INTERVALS[s.stage]) + '后再复习');
  } else {
    s.stage = 0;
    s.due = now + REVIEW_INTERVALS[0];
    s.lapses = (Number(s.lapses) || 0) + 1;
    toast('😖 没记住 · ' + humanInterval(REVIEW_INTERVALS[0]) + '后再复习');
  }
  saveState();
  refreshHome();
  next(1);
}

function gradeCurrent(ok) {
  if (!session.active) return;
  if (session.kind === 'review') gradeEbbinghaus(ok);
  else if (session.kind === 'marked') gradeMarked(ok);
}

function next(dir) { // dir: 1 下一个, -1 上一个
  if (!session.active) return;
  lastNavTime = Date.now();
  if (dir === 1) markCurrentDone();
  const card = document.getElementById('word-card');
  const total = session.queue.length;

  const target = session.pos + dir;
  if (target >= total) { endSession(); return; }
  if (target < 0) return;

  const anim = dir === 1 ? 'slide-out-left' : 'slide-out-right';
  card.classList.add(anim);
  setTimeout(() => {
    session.pos = target;
    card.classList.remove(anim);
    card.classList.add(dir === 1 ? 'slide-in-left' : 'slide-in-right');
    renderCard();
    setTimeout(() => card.classList.remove('slide-in-left', 'slide-in-right'), 260);
  }, 240);
  if (dir === 1) saveState();
}

function endSession() {
  session.active = false;
  stopSpeak();
  const kind = session.kind;
  const all = wordList();
  const doneCount = all.filter(w => state.doneMap[w.word]).length;

  if (kind === 'marked') {
    showDoneOverlay(
      isSpecialMarkMode(session.markMode)
        ? '特重点标记词复习结束！\n本次共 ' + session.words.length + ' 个，不占用艾宾浩斯复习计划'
        : '标记词背诵结束！\n本次共 ' + session.words.length + ' 个标记词'
    );
  } else if (kind === 'review') {
    const stats = ebbinghausStats();
    showDoneOverlay(
      '艾宾浩斯复习结束！\n今日进度 ' + stats.today + '/' + stats.goal +
      (stats.due > 0 ? '\n还有 ' + stats.due + ' 个到期词' : '')
    );
  } else if (kind === 'remain' && isSpecialMarkMode(session.markMode)) {
    const ebbinghausHighlights = doneCount >= all.length
      ? '🎉 本词表的新词已全部学完！\n它们都已进入艾宾浩斯复习计划'
      : '艾宾浩斯新词学习结束！\n本次共 ' + session.words.length +
        ' 个新词\n已完成的新词已自动加入复习计划';
    showDoneOverlay(ebbinghausHighlights);
  } else if (kind === 'remain' && doneCount >= all.length) {
    // 本轮全部完成 -> 下一轮
    state.round += 1;
    state.doneMap = {};
    saveState();
    showDoneOverlay('🎉 第 ' + (state.round - 1) + ' 轮全部完成！\n已开启第 ' + state.round + ' 轮');
  } else {
    const remain = all.length - doneCount;
    showDoneOverlay('本次学习结束！\n剩余 ' + remain + ' 词未背完');
  }
  refreshHome();
}

/* ---------- 滑动手势 ---------- */
(function initGestures() {
  const card = document.getElementById('word-card');
  const SWIPE_THRESHOLD = 60; // 滑动判定阈值(原先只在 touchend 内声明, 鼠标分支引用会抛错)
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;

  card.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    dx = dy = 0; dragging = true;
    card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (!dragging) return;
    dx = e.touches[0].clientX - sx;
    dy = e.touches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy)) {
      card.style.transform = 'translateX(' + dx * 0.85 + 'px) rotate(' + dx * 0.02 + 'deg)';
    }
  }, { passive: true });

  card.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    card.style.transform = '';
    if (dx < -SWIPE_THRESHOLD) next(1);        // 左滑 -> 下一个
    else if (dx > SWIPE_THRESHOLD) next(-1);   // 右滑 -> 上一个
    // 轻点翻面交给 click 事件处理
  });

  // 桌面鼠标拖拽
  let mdx = null;
  card.addEventListener('mousedown', e => { mdx = e.clientX; });
  window.addEventListener('mouseup', e => {
    if (mdx === null) return;
    const d = e.clientX - mdx; mdx = null;
    if (d < -SWIPE_THRESHOLD) next(1); else if (d > SWIPE_THRESHOLD) next(-1);
  });

  // 翻面: 用 click 事件(桌面/手机都可靠); 滑动后短暂忽略防误翻
  card.addEventListener('click', () => {
    if (state.display !== 'flip') return;
    if (Date.now() - lastNavTime < 400) return;
    card.classList.toggle('flipped');
  });
})();

/* ---------- 首页刷新 ---------- */
/* 首页标题随所选词表变化, 避免选了专升本词表仍显示"六级" */
const HOME_META = {
  core: ['六级高频词汇', 'CET-6 High Frequency · 按考频排序'],
  full: ['六级完整词汇', 'CET-6 Full List · 按词频排序'],
  zsb: ['专升本必背词', '专升本大纲必背词 · 按词频排序'],
};

function refreshHome() {
  applyModeUI();
  const all = wordList();
  const done = all.filter(w => state.doneMap[w.word]).length;
  const newRemaining = Math.max(0, all.length - done);
  const meta = HOME_META[state.wordlist] || HOME_META.core;
  document.getElementById('app-title').textContent = meta[0];
  document.getElementById('app-subtitle').textContent = meta[1];
  document.getElementById('stat-total-num').textContent = all.length;
  document.getElementById('stat-done-num').textContent = done;
  document.getElementById('stat-remain-num').textContent = all.length - done;
  const pct = all.length ? (done / all.length * 100) : 0;
  document.getElementById('home-progress').style.width = pct + '%';
  document.getElementById('home-progress-text').textContent =
    '第 ' + state.round + ' 轮 · 进度 ' + done + '/' + all.length + ' (' + pct.toFixed(1) + '%)';
  refreshMarkedCount();
  const rs = markedScheduleStats();
  const planEl = document.getElementById('review-plan-text');
  if (planEl) {
    if (isSpecialMarkMode(state.mode)) {
      planEl.textContent = rs.total
        ? '特重点 ' + rs.total + ' 个 · 按刷词方式顺序复习'
        : '特重点 0 个 · 背词时点 ⭐ 即可加入';
    } else {
      planEl.textContent = rs.total
        ? (MODE_LABEL[state.mode] + '标记 ' + rs.total + ' 个 · 今日待复习 ' + rs.due + ' 个')
        : (MODE_LABEL[state.mode] + '标记 0 个 · 两套标记互不影响');
    }
  }
  const es = ebbinghausStats();
  const dueText = document.getElementById('ebbinghaus-due-text');
  if (dueText) {
    dueText.textContent =
      '新词剩余 ' + newRemaining + ' 词 · 计划 ' + es.total + ' 词 · 今日到期 ' + es.due + ' 词';
  }
  const newBtn = document.getElementById('btn-start-ebbinghaus-new');
  const newLabel = document.getElementById('ebbinghaus-new-label');
  const newCount = document.getElementById('ebbinghaus-new-count');
  if (newBtn) newBtn.disabled = newRemaining === 0;
  if (newLabel) newLabel.textContent = newRemaining === 0 ? '新词已背完' : '背新词';
  if (newCount) newCount.textContent = newRemaining;
  const progress = document.getElementById('daily-review-progress');
  if (progress) progress.textContent = es.today + '/' + es.goal;
  const goalProgress = document.getElementById('daily-goal-progress');
  if (goalProgress) {
    goalProgress.style.width = Math.min(100, es.today / es.goal * 100) + '%';
  }
  const goalInput = document.getElementById('daily-goal-input');
  if (goalInput && document.activeElement !== goalInput) goalInput.value = es.goal;
  const reviewBtn = document.getElementById('btn-start-ebbinghaus');
  const reviewLabel = document.getElementById('ebbinghaus-review-label');
  const dueCount = document.getElementById('ebbinghaus-due-count');
  const reviewCaption = document.getElementById('ebbinghaus-review-caption');
  const reviewAvailable = Math.min(es.due, es.remaining);
  if (reviewBtn) {
    reviewBtn.disabled = es.due === 0 || es.remaining === 0;
  }
  if (reviewLabel) {
    reviewLabel.textContent = es.remaining === 0 ? '今日复习完成' : '艾宾浩斯复习';
  }
  if (dueCount) dueCount.textContent = reviewAvailable;
  if (reviewCaption) {
    if (es.total === 0) {
      reviewCaption.textContent = newRemaining
        ? '背完的新词会按间隔自动加入这里。'
        : '暂无复习任务。';
    } else if (es.remaining === 0) {
      reviewCaption.textContent = '今日目标已完成，到期词会继续保留。';
    } else if (es.due > 0) {
      reviewCaption.textContent = '今天可复习 ' + reviewAvailable + ' 个到期词；逾期词仍从原节点继续。';
    } else if (es.nextDue) {
      reviewCaption.textContent = '下次到期：' + formatDueTime(es.nextDue);
    } else {
      reviewCaption.textContent = '暂无到期单词。';
    }
  }
}

function applyModeUI() {
  const isEbbinghaus = state.mode === 'ebbinghaus';
  const module = document.getElementById('ebbinghaus-module');
  if (module) module.hidden = !isEbbinghaus;
  document.querySelectorAll('[data-swipe-only]').forEach(el => {
    el.hidden = isEbbinghaus;
  });

  const modeLabel = document.getElementById('home-mode-label');
  if (modeLabel) modeLabel.textContent = MODE_LABEL[state.mode];

  const remainLabel = document.getElementById('remain-action-label');
  if (remainLabel) {
    remainLabel.textContent = isEbbinghaus
      ? '学习新词并建立复习计划'
      : '背未完成的单词';
  }

  const markedLabel = document.getElementById('marked-action-label');
  if (markedLabel) {
    markedLabel.textContent = isEbbinghaus
      ? '背特重点标记词'
      : '背刷词模式标记词';
  }

  const clearButton = document.getElementById('btn-clear-marked');
  if (clearButton) {
    const count = markedWords().length;
    clearButton.textContent = isEbbinghaus
      ? '清空特重点标记词（' + count + '）'
      : '清空刷词模式标记词（' + count + '）';
  }
}

function refreshMarkedCount() {
  const el = document.getElementById('marked-count');
  if (el) el.textContent = markedWords().length;
}

/* ---------- 页面切换 ---------- */
function showPage(name, push) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  // 历史管理: 进子页面压栈, 回首页用 replaceState(不调用 history.back,
  // 部分手机浏览器对程序化回退支持差, 会卡死)
  if (push === false) return; // popstate 触发的渲染
  try {
    if (name === 'home') {
      history.replaceState({ page: 'home' }, '', location.pathname + location.search);
    } else {
      history.pushState({ page: name }, '', location.pathname + location.search + '#' + name);
    }
  } catch (e) {}
}
window.addEventListener('popstate', e => {
  let name = (e.state && e.state.page) || 'home';
  if (name === 'swipe' && !session.active) name = 'home';
  showPage(name, false);
});

document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => showPage(b.dataset.page)));

/* ---------- 完成弹窗 ---------- */
function showDoneOverlay(msg, noop) {
  const ov = document.getElementById('done-overlay');
  ov.querySelector('p').textContent = msg;
  ov.classList.add('show');
  ov.dataset.noop = noop ? '1' : '';
}
document.getElementById('done-overlay-btn')?.addEventListener('click', () => {
  document.getElementById('done-overlay').classList.remove('show');
  showPage('home');
});

/* ---------- 点按处理: 去重 / 反馈 ---------- */
// 手机上同时绑 touchend 和 click 时, 同一次点按可能触发两次,
// 对"标记"这种切换型操作就会连切两次而看起来完全没反应。
// 这里统一处理: touchend 立即执行, 并抑制紧随其后的合成 click。
function bindTap(el, handler) {
  if (!el) return;
  let suppressClickUntil = 0;
  el.addEventListener('touchend', e => {
    e.preventDefault();
    suppressClickUntil = Date.now() + 700;
    handler(e);
  }, { passive: false });
  el.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) return;
    handler(e);
  });
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
}

/* 标记按钮状态: 当前词已标记时高亮 */
function syncMarkButton() {
  const btn = document.getElementById('btn-mark');
  if (!btn) return;
  const e = session.active ? curEntry() : null;
  const marks = marksForMode(session.markMode);
  const on = !!(e && marks[session.words[e.idx].word]);
  btn.classList.toggle('active', on);
  btn.textContent = on ? '★ 已标记' : '⭐ 标记';
}

function toggleMark() {
  if (!session.active) return;
  const e = curEntry();
  if (!e) return;
  const w = session.words[e.idx];
  const marks = marksForMode(session.markMode);
  const schedules = markedSchedulesForMode(session.markMode);
  const on = !marks[w.word];
  if (on) {
    marks[w.word] = 1;
    if (isSpecialMarkMode(session.markMode)) delete schedules[w.word];
    else ensureSchedule(w.word, null, session.markMode);
  }
  else {
    delete marks[w.word];
    delete schedules[w.word];
  }
  saveState();
  syncMarkButton();
  refreshMarkedCount();
  refreshHome();
  const markLabel = isSpecialMarkMode(session.markMode)
    ? '特重点'
    : MODE_LABEL[session.markMode] + '标记';
  toast(
    (on ? '⭐ 已加入' + markLabel + ' · ' : '已从' + markLabel + '移除 · ') + w.word
  );
}

/* ---------- 事件绑定 ---------- */
function goHome() {
  session.active = false;
  stopSpeak();
  refreshHome();
  showPage('home');
}
document.getElementById('btn-start-remain').addEventListener('click', () => startSession('remain'));
document.getElementById('btn-start-ebbinghaus-new').addEventListener('click', () => startSession('remain'));
document.getElementById('btn-start-marked').addEventListener('click', () => startSession('marked'));
document.getElementById('btn-start-done').addEventListener('click', () => startSession('done'));
document.getElementById('btn-start-ebbinghaus').addEventListener('click', () => startSession('review'));
// 手机上部分浏览器 click 不可靠, 统一用 bindTap 绑 touchend + click (不会重复触发)
bindTap(document.getElementById('btn-back-home'), goHome);
bindTap(document.getElementById('btn-prev'), () => next(-1));
bindTap(document.getElementById('btn-next'), () => next(1));
bindTap(document.getElementById('btn-mark'), toggleMark);
bindTap(document.getElementById('btn-grade-again'), () => gradeCurrent(false));
bindTap(document.getElementById('btn-grade-good'), () => gradeCurrent(true));
document.getElementById('btn-speak').addEventListener('click', e => {
  e.stopPropagation();
  const w = curEntry(); if (w) speak(session.words[w.idx].word);
});
document.getElementById('btn-speak').addEventListener('touchend', e => e.stopPropagation());

/* ---------- 设置 ---------- */
document.querySelectorAll('input[name=mode]').forEach(r =>
  r.addEventListener('change', () => {
    state.mode = normalizeMode(r.value);
    saveState();
    session.active = false;
    stopSpeak();
    refreshHome();
  }));

document.querySelectorAll('input[name=display]').forEach(r =>
  r.addEventListener('change', () => { state.display = r.value; saveState(); }));

document.querySelectorAll('input[name=wordlist]').forEach(r =>
  r.addEventListener('change', () => {
    state.wordlist = r.value;
    saveState();
    session.active = false;
    stopSpeak();
    refreshHome();
    showPage('home');
  }));

const goalInput = document.getElementById('daily-goal-input');
function setDailyGoal(value) {
  state.dailyGoal = clampDailyGoal(value);
  if (goalInput) goalInput.value = state.dailyGoal;
  saveState();
  refreshHome();
}
if (goalInput) {
  goalInput.value = state.dailyGoal;
  goalInput.addEventListener('input', () => {
    if (goalInput.value === '') return;
    setDailyGoal(goalInput.value);
  });
  goalInput.addEventListener('change', () => setDailyGoal(goalInput.value));
}
bindTap(document.getElementById('goal-minus'), () => setDailyGoal(state.dailyGoal - 10));
bindTap(document.getElementById('goal-plus'), () => setDailyGoal(state.dailyGoal + 10));

document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('确定重置所有学习进度吗？此操作不可恢复。')) {
    localStorage.removeItem(STATE_KEY);
    Object.assign(state, normalizeState({}));
    document.querySelector('input[name=mode][value=' + state.mode + ']').checked = true;
    document.querySelector('input[name=display][value=' + state.display + ']').checked = true;
    document.querySelector('input[name=wordlist][value=' + state.wordlist + ']').checked = true;
    if (goalInput) goalInput.value = state.dailyGoal;
    refreshHome();
  }
});

/* 一键清空所有标记词(不影响背诵进度) */
document.getElementById('btn-clear-marked').addEventListener('click', () => {
  const mode = state.mode;
  const marks = marksForMode(mode);
  const schedules = markedSchedulesForMode(mode);
  const n = Object.keys(marks).length;
  if (!n) { toast('当前模式没有标记词'); return; }
  const modeName = isSpecialMarkMode(mode) ? '特重点标记词' : MODE_LABEL[mode] + '的全部标记词';
  if (confirm('确定清空' + modeName + '吗？\n共 ' + n +
    ' 个。另一模式的标记词会保留。')) {
    state.markedByMode[mode] = {};
    state.markedScheduleByMode[mode] = {};
    saveState();
    syncMarkButton();
    refreshMarkedCount();
    refreshHome();
    toast('已清空 ' + n + ' 个' + modeName);
  }
});

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let swRegistration = null;
  let refreshing = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    swRegistration = reg;
    reg.update().catch(() => {});
  }).catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && swRegistration) {
      swRegistration.update().catch(() => {});
    }
  });
}

/* ---------- 发音预缓存: 首次打开后空闲时批量拉取, 之后离线可听 ---------- */
function prefetchAudio() {
  if (!navigator.onLine) return;
  const set = new Set();
  CET6_WORDS.forEach(w => set.add(w.word));
  if (typeof CET6_WORDS_FULL !== 'undefined') CET6_WORDS_FULL.forEach(w => set.add(w.word));
  if (typeof ZSB_WORDS !== 'undefined') ZSB_WORDS.forEach(w => set.add(w.word));
  const words = [...set];
  let i = 0;
  const worker = async () => {
    while (i < words.length) {
      const w = words[i++];
      try { await fetch('audio/' + encodeURIComponent(w) + '.mp3'); } catch (e) { return; }
    }
  };
  Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
}
if (localStorage.getItem('audio.prefetched') !== '1') {
  setTimeout(() => {
    prefetchAudio();
    localStorage.setItem('audio.prefetched', '1');
  }, 4000);
}

/* ---------- 启动 ---------- */
document.querySelector('input[name=mode][value=' + state.mode + ']').checked = true;
document.querySelector('input[name=display][value=' + state.display + ']').checked = true;
document.querySelector('input[name=wordlist][value=' + state.wordlist + ']').checked = true;
refreshHome();
