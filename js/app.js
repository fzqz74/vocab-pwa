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
    wordlist: s.wordlist === 'full' ? 'full' : 'core',
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
  return state.wordlist === 'full' ? CET6_WORDS_FULL : CET6_WORDS;
}

/* ---------- 艾宾浩斯间隔(一轮内重复出现) ---------- */
const EBINGHAUS_GAPS = [4, 10]; // 新词之后第4个、第10个位置再现

/**
 * 生成艾宾浩斯队列: 每个词出现 1+GAPS.length 次,
 * 位置间隔模拟遗忘曲线(5分钟/30分钟压缩为序列内间隔).
 * 返回 [{idx, review}] idx=词在列表中的下标, review=是否复习出现
 */
function buildEbbinghausQueue(n) {
  if (n === 0) return [];
  const lastGap = EBINGHAUS_GAPS.reduce((a, b) => a + b, 0); // 累计总偏移
  const slots = n + lastGap + 1;
  const events = Array.from({ length: slots }, () => []);
  const lastOcc = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    events[i].push({ idx: i, review: false });
    lastOcc[i] = i;
    let cum = 0;
    EBINGHAUS_GAPS.forEach(g => {
      cum += g;
      const pos = i + cum;
      if (pos < slots) {
        events[pos].push({ idx: i, review: true });
        lastOcc[i] = Math.max(lastOcc[i], pos);
      }
    });
  }
  const queue = [];
  events.forEach(evts => evts.forEach(e => queue.push(e)));
  // 压缩尾部空槽
  return { queue, lastOcc };
}

/* ---------- 朗读 (男声优先, 离线) ---------- */
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

function speak(word) {
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
  words: [],      // 本轮会话的词对象列表
  queue: [],      // 播放队列 {idx, review}
  lastOcc: null,  // 艾宾浩斯: 每个词最后一次出现的位置
  pos: 0,
  isReviewSet: false, // 本次背的是"已完成"集合
};

function startSession(reviewSet) {
  const all = wordList();
  const list = reviewSet
    ? all.filter(w => state.doneMap[w.word])
    : all.filter(w => !state.doneMap[w.word]);
  if (!list.length) { showDoneOverlay(reviewSet ? '已完成词库是空的' : '本轮已全部背完！', true); return; }

  session.isReviewSet = reviewSet;
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
    state.mode === 'ebbinghaus' ? '艾宾浩斯' : '刷词模式';
  document.getElementById('swipe-hint').textContent =
    state.display === 'direct' ? '← 左滑下一个 · 右滑上一个' : '← 左滑下一个 · 点击卡片看释义';
  document.getElementById('swipe-counter').textContent =
    (session.pos + 1) + ' / ' + session.queue.length;

  speak(w.word);
}

function markCurrentDone() {
  const e = curEntry();
  if (!e) return;
  // 刷词模式: 划过即完成; 艾宾浩斯: 最后一次出现才算完成
  const isLast = state.mode === 'swipe' || session.lastOcc[e.idx] === session.pos;
  if (isLast && !session.isReviewSet) state.doneMap[session.words[e.idx].word] = 1;
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
  speechSynthesis && speechSynthesis.cancel();
  const all = wordList();
  const doneCount = Object.keys(state.doneMap).length;

  if (!session.isReviewSet && doneCount >= all.length) {
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
    const TH = 60;
    if (dx < -TH) next(1);        // 左滑 -> 下一个
    else if (dx > TH) next(-1);   // 右滑 -> 上一个
    // 轻点翻面交给 click 事件处理
  });

  // 桌面鼠标拖拽
  let mdx = null;
  card.addEventListener('mousedown', e => { mdx = e.clientX; });
  window.addEventListener('mouseup', e => {
    if (mdx === null) return;
    const d = e.clientX - mdx; mdx = null;
    if (d < -TH) next(1); else if (d > TH) next(-1);
  });

  // 翻面: 用 click 事件(桌面/手机都可靠); 滑动后短暂忽略防误翻
  card.addEventListener('click', () => {
    if (state.display !== 'flip') return;
    if (Date.now() - lastNavTime < 400) return;
    card.classList.toggle('flipped');
  });
})();

/* ---------- 首页刷新 ---------- */
function refreshHome() {
  const all = wordList();
  const done = Object.keys(state.doneMap).length;
  document.getElementById('stat-total-num').textContent = all.length;
  document.getElementById('stat-done-num').textContent = done;
  document.getElementById('stat-remain-num').textContent = all.length - done;
  const pct = all.length ? (done / all.length * 100) : 0;
  document.getElementById('home-progress').style.width = pct + '%';
  document.getElementById('home-progress-text').textContent =
    '第 ' + state.round + ' 轮 · 进度 ' + done + '/' + all.length + ' (' + pct.toFixed(1) + '%)';
}

/* ---------- 页面切换 ---------- */
function showPage(name, push) {
  // 从子页面回首页: 消费掉压入的历史(触发 popstate 再回来渲染)
  if (name === 'home' && push !== false && history.state && history.state.page) {
    history.back();
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  // 压入浏览器历史, 让安卓返回键能回退页面
  if (push !== false && name !== 'home') {
    try { history.pushState({ page: name }, '', location.href.split('#')[0] + '#' + name); } catch (e) {}
  }
}
window.addEventListener('popstate', e => {
  let name = (e.state && e.state.page) || 'home';
  // 刷新后历史状态可能残留, 而会话已不存在, 回首页
  if (name === 'swipe' && !session.active) name = 'home';
  showPage(name, false);
});
// 启动时重置历史状态, 避免刷新后残留 #swipe 状态
if (history.state && history.state.page) {
  try { history.replaceState({ page: 'home' }, '', location.pathname + location.search); } catch (e) {}
}

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

/* ---------- 事件绑定 ---------- */
function goHome() {
  session.active = false;
  speechSynthesis && speechSynthesis.cancel();
  refreshHome();
  showPage('home');
}
document.getElementById('btn-start-remain').addEventListener('click', () => startSession(false));
document.getElementById('btn-start-done').addEventListener('click', () => startSession(true));
// 手机上部分浏览器 click 不可靠, 同时绑 touchend (preventDefault 防止触发两次)
document.getElementById('btn-back-home').addEventListener('click', goHome);
document.getElementById('btn-back-home').addEventListener('touchend', e => {
  e.preventDefault();
  goHome();
});
// 底部按钮同样加固
['btn-prev', 'btn-next', 'btn-mark'].forEach(id => {
  const b = document.getElementById(id);
  if (!b) return;
  const act = () => {
    if (id === 'btn-prev') next(-1);
    else if (id === 'btn-next') next(1);
    else {
      const e = curEntry(); if (!e) return;
      const word = session.words[e.idx].word;
      if (state.marked[word]) delete state.marked[word];
      else state.marked[word] = 1;
      saveState();
    }
  };
  b.addEventListener('touchend', e => { e.preventDefault(); act(); });
  b.addEventListener('click', act); // 桌面鼠标
});
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
    speechSynthesis && speechSynthesis.cancel();
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
    refreshHome();
  }
});

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------- 启动 ---------- */
document.querySelector('input[name=mode][value=' + state.mode + ']').checked = true;
document.querySelector('input[name=display][value=' + state.display + ']').checked = true;
document.querySelector('input[name=wordlist][value=' + state.wordlist + ']').checked = true;
refreshHome();
