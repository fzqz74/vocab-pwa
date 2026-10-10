/* ===== 六级高频词汇 PWA 核心逻辑 ===== */
'use strict';

/* ---------- 状态管理 ---------- */
const STATE_KEY = 'cet6.state.v1';
const state = loadState();

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (s && typeof s === 'object') return normalizeState(s);
  } catch (e) { /* 损坏则重建 */ }
  return normalizeState({});
}

function normalizeState(s) {
  return {
    mode: s.mode === 'ebbinghaus' ? 'ebbinghaus' : 'swipe',
    display: s.display === 'direct' ? 'direct' : 'flip',
    wordlist: (s.wordlist === 'full' || s.wordlist === 'zsb') ? s.wordlist : 'core',
    round: Number(s.round) || 1,
    dailyGoal: Number(s.dailyGoal) || 50,
    doneMap: (s.doneMap && typeof s.doneMap === 'object') ? s.doneMap : {},
    marked: (s.marked && typeof s.marked === 'object') ? s.marked : {},
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

/* ---------- 艾宾浩斯间隔(一轮内重复出现) ---------- */
const EBINGHAUS_GAPS = [4, 10]; // 新词之后第4个、第10个位置再现

/**
 * 生成艾宾浩斯队列: 每个词出现 1+GAPS.length 次,
 * 位置间隔模拟遗忘曲线(5分钟/30分钟压缩为序列内间隔).
 * 返回 [{idx, review}] idx=词在列表中的下标, review=是否复习出现
 */
function buildEbbinghausQueue(n) {
  if (n === 0) return { queue: [], lastOcc: [] };
  const lastGap = EBINGHAUS_GAPS.reduce((a, b) => a + b, 0); // 累计总偏移
  const slots = n + lastGap + 1;
  const events = Array.from({ length: slots }, () => []);
  for (let i = 0; i < n; i++) {
    events[i].push({ idx: i, review: false });
    let cum = 0;
    EBINGHAUS_GAPS.forEach(g => {
      cum += g;
      const pos = i + cum;
      if (pos < slots) events[pos].push({ idx: i, review: true });
    });
  }
  // 空槽被压缩后, lastOcc 必须记"队列下标"而不是槽位下标:
  // markCurrentDone 里用 lastOcc[e.idx] === session.pos 判断最后一次出现,
  // 之前存槽位下标导致两者永不相等, 艾宾浩斯模式下进度几乎不记录。
  const queue = [];
  const lastOcc = new Array(n).fill(-1);
  events.forEach(evts => evts.forEach(e => {
    lastOcc[e.idx] = queue.length;
    queue.push(e);
  }));
  return { queue, lastOcc };
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
  kind: 'remain', // remain=背未完成 / done=复习已完成 / marked=背标记词
  words: [],      // 本轮会话的词对象列表
  queue: [],      // 播放队列 {idx, review}
  lastOcc: null,  // 艾宾浩斯: 每个词最后一次出现的位置
  pos: 0,
  noProgress: false, // 复习/标记模式只读, 不写入背诵进度
};

const SESSION_LABEL = { remain: '刷词模式', done: '复习模式', marked: '标记词' };

/* 标记词集合: 当前词表的标记词在前, 再补上其它词表里标过的词 */
function markedWords() {
  const seen = new Set();
  const out = [];
  const push = w => {
    if (w && state.marked[w.word] && !seen.has(w.word)) { seen.add(w.word); out.push(w); }
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

function startSession(kind) {
  const all = wordList();
  let list;
  if (kind === 'marked') list = markedWords();
  else if (kind === 'done') list = all.filter(w => state.doneMap[w.word]);
  else list = all.filter(w => !state.doneMap[w.word]);

  if (!list.length) {
    if (kind === 'marked') showDoneOverlay('还没有标记任何单词\n刷词时点底部「⭐ 标记」即可收藏', true);
    else if (kind === 'done') showDoneOverlay('已完成词库是空的', true);
    else showDoneOverlay('本轮已全部背完！', true);
    return;
  }

  session.kind = kind;
  session.noProgress = (kind !== 'remain');
  session.words = list;
  if (state.mode === 'ebbinghaus') {
    const { queue, lastOcc } = buildEbbinghausQueue(list.length);
    session.queue = queue;
    session.lastOcc = lastOcc;
  } else {
    session.queue = list.map((_, i) => ({ idx: i, review: false }));
    session.lastOcc = null;
  }
  session.pos = 0;
  session.active = true;
  showPage('swipe');
  renderCard();
}

function curEntry() { return session.queue[session.pos]; }

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
  badge.classList.toggle('show', !!e.review);

  document.getElementById('swipe-mode-label').textContent =
    session.kind === 'remain'
      ? (state.mode === 'ebbinghaus' ? '艾宾浩斯' : '刷词模式')
      : SESSION_LABEL[session.kind];
  document.getElementById('swipe-hint').textContent =
    state.display === 'direct' ? '← 左滑下一个 · 右滑上一个' : '← 左滑下一个 · 点击卡片看释义';
  document.getElementById('swipe-counter').textContent =
    (session.pos + 1) + ' / ' + session.queue.length;
  syncMarkButton();

  speak(w.word);
}

function markCurrentDone() {
  const e = curEntry();
  if (!e) return;
  // 刷词模式: 划过即完成; 艾宾浩斯: 最后一次出现才算完成
  const isLast = state.mode === 'swipe' || session.lastOcc[e.idx] === session.pos;
  if (isLast && !session.noProgress) state.doneMap[session.words[e.idx].word] = 1;
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
  const doneCount = Object.keys(state.doneMap).length;

  if (kind === 'marked') {
    showDoneOverlay('标记词背诵结束！\n本次共 ' + session.words.length + ' 个标记词');
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
  const all = wordList();
  const done = Object.keys(state.doneMap).length;
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
  const on = !!(e && state.marked[session.words[e.idx].word]);
  btn.classList.toggle('active', on);
  btn.textContent = on ? '★ 已标记' : '⭐ 标记';
}

function toggleMark() {
  if (!session.active) return;
  const e = curEntry();
  if (!e) return;
  const w = session.words[e.idx];
  const on = !state.marked[w.word];
  if (on) state.marked[w.word] = 1; else delete state.marked[w.word];
  saveState();
  syncMarkButton();
  refreshMarkedCount();
  toast(on ? '⭐ 已标记 ' + w.word : '已取消标记 ' + w.word);
}

/* ---------- 事件绑定 ---------- */
function goHome() {
  session.active = false;
  stopSpeak();
  refreshHome();
  showPage('home');
}
document.getElementById('btn-start-remain').addEventListener('click', () => startSession('remain'));
document.getElementById('btn-start-marked').addEventListener('click', () => startSession('marked'));
document.getElementById('btn-start-done').addEventListener('click', () => startSession('done'));
// 手机上部分浏览器 click 不可靠, 统一用 bindTap 绑 touchend + click (不会重复触发)
bindTap(document.getElementById('btn-back-home'), goHome);
bindTap(document.getElementById('btn-prev'), () => next(-1));
bindTap(document.getElementById('btn-next'), () => next(1));
bindTap(document.getElementById('btn-mark'), toggleMark);
document.getElementById('btn-speak').addEventListener('click', e => {
  e.stopPropagation();
  const w = curEntry(); if (w) speak(session.words[w.idx].word);
});
document.getElementById('btn-speak').addEventListener('touchend', e => e.stopPropagation());

/* ---------- 设置 ---------- */
document.querySelectorAll('input[name=mode]').forEach(r =>
  r.addEventListener('change', () => { state.mode = r.value; saveState(); }));

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

const goalInput = document.getElementById('daily-goal');
goalInput.value = state.dailyGoal;
document.getElementById('daily-goal-value').textContent = state.dailyGoal + ' 词/天';
goalInput.addEventListener('input', () => {
  state.dailyGoal = Number(goalInput.value);
  document.getElementById('daily-goal-value').textContent = state.dailyGoal + ' 词/天';
  saveState();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('确定重置所有学习进度吗？此操作不可恢复。')) {
    localStorage.removeItem(STATE_KEY);
    Object.assign(state, normalizeState({}));
    document.querySelector('input[name=mode][value=' + state.mode + ']').checked = true;
    document.querySelector('input[name=display][value=' + state.display + ']').checked = true;
    document.querySelector('input[name=wordlist][value=' + state.wordlist + ']').checked = true;
    refreshHome();
  }
});

/* 一键清空所有标记词(不影响背诵进度) */
document.getElementById('btn-clear-marked').addEventListener('click', () => {
  const n = Object.keys(state.marked).length;
  if (!n) { toast('当前没有标记词'); return; }
  if (confirm('确定清空所有标记词吗？\n共 ' + n + ' 个，清空后不可恢复。')) {
    state.marked = {};
    saveState();
    syncMarkButton();
    refreshMarkedCount();
    toast('已清空 ' + n + ' 个标记词');
  }
});

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
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
