/*
 * Deadline 提醒 — App（離線優先）
 *
 * 資料：上次從 Google 拿到的狀態（base）＋還沒送出的變更（outbox）都存在這台裝置的 localStorage。
 *       畫面＝base 套上 outbox，所以任何操作都立刻生效、離線也能用。
 * 同步：隱藏的 iframe 載入 Google Apps Script 網頁（橋），用 postMessage 呼叫 getState／applyOps／maintain。
 *       outbox 依序批次送出，每個變更有 opId，重送不會重複；新增的暫時 ID（tmp_…）送出後換成真的 ID。
 */
(function () {
  'use strict';

  var BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbwtwa-FT9e2HZ1245SuyV-ABjFjVJk8I9SGNOf7eZ9UaXwSYGwa0ritn-p4igdSSBq5gw/exec';
  var BRIDGE_ORIGIN = /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/;
  (function () {   // 只在本機測試時：?bridge=… 改用本機的模擬橋
    var q = /[?&]bridge=([^&]+)/.exec(location.search);
    if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      BRIDGE_URL = decodeURIComponent(q[1]);
      BRIDGE_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    }
  })();
  var KEY_BASE = 'dr.base.v3', KEY_OUT = 'dr.outbox.v3';
  var DEF_AHEAD = 72, DEF_EVERY = 24, MAX_AHEAD = 720;
  var HOUR = 3600000, DAY = 24 * HOUR;
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load(k, def) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  // ---------- 日期 ----------
  function dayStart(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function md(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEK[d.getDay()] + '）'; }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fullDate(ms) {
    var d = new Date(ms), y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '/' : '';
    return y + md(ms);
  }
  /** 分組標籤和顏色：今天／明天＝紅，本週・下週＝黃，再之後＝綠，逾期＝灰（一週從週一算） */
  function bucket(deadline, now) {
    if (!deadline) return { key: 'rec', label: '紀錄', c: 'n' };          // 沒有截止＝單純紀錄
    if (deadline <= now) return { key: 'late', label: '已逾期', c: 'x' };
    var today = dayStart(now), d = dayStart(deadline);
    var monday = addDays(today, -((new Date(today).getDay() + 6) % 7));
    var nextMon = addDays(monday, 7), after = addDays(monday, 14), w = WEEK[new Date(d).getDay()];
    if (d === today) return { key: 'd' + d, label: '今天', c: 'r' };
    if (d === addDays(today, 1)) return { key: 'd' + d, label: '明天', c: 'r' };
    if (d < nextMon) return { key: 'd' + d, label: '本週' + w, c: 'y' };
    if (d < after) return { key: 'd' + d, label: '下週' + w, c: 'y' };
    return { key: 'd' + d, label: fullDate(deadline), c: 'g' };
  }
  function hoursLeft(deadline, now) {
    var h = Math.floor((deadline - now) / HOUR);
    return h >= 1 ? '剩 ' + h + ' 小時' : '剩不到 1 小時';
  }
  function toLocalInput(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + hm(ms); }
  function fromLocalInput(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0;
  }

  // ---------- 狀態 ----------
  var KEY_THEME = 'dr.theme', KEY_DEF = 'dr.defaults';
  var prefs = load(KEY_DEF, { ahead: DEF_AHEAD, every: DEF_EVERY });   // 新項目的預設提醒（存在這台裝置）
  var base = load(KEY_BASE, null);      // { items, done, at }
  var outbox = load(KEY_OUT, []);       // [{ opId, type, id?, tmp?, at, data? }]
  var openId = null;                    // 展開中的卡片

  function idx(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; }
  function applyLocal(a, d, op) {
    if (op.type === 'add') { a.push(Object.assign({ id: op.tmp, done: false, doneAt: 0, at: op.data.deadline ? 0 : op.at }, op.data)); return; }
    var i = idx(a, op.id), j = idx(d, op.id), it;
    if (op.type === 'update') {
      it = i >= 0 ? a[i] : (j >= 0 ? d.splice(j, 1)[0] : null);
      if (!it) return;
      var moved = Math.floor((it.deadline || 0) / 60000) !== Math.floor((op.data.deadline || 0) / 60000);
      Object.assign(it, op.data, { done: false, doneAt: 0 });
      if (moved) it.order = 0;                                           // 換了一天：手動排的順序不適用
      if (!it.deadline && !it.at) it.at = op.at;
      if (i < 0) a.push(it);
    } else if (op.type === 'complete' && i >= 0) {
      it = a.splice(i, 1)[0]; it.done = true; it.doneAt = op.at; d.push(it);
    } else if (op.type === 'restore' && j >= 0) {
      it = d.splice(j, 1)[0]; it.done = false; it.doneAt = 0; a.push(it);
    } else if (op.type === 'delete') {
      if (i >= 0) a.splice(i, 1); else if (j >= 0) d.splice(j, 1);
    } else if (op.type === 'order') {
      it = i >= 0 ? a[i] : (j >= 0 ? d[j] : null);
      if (it) it.order = Number(op.data.order) || 0;
    }
  }
  function view() {
    var a = base ? clone(base.items) : [], d = base ? clone(base.done) : [];
    outbox.forEach(function (op) { applyLocal(a, d, op); });
    var now = Date.now();
    a.sort(function (x, y) { return (groupRank(y, now) - groupRank(x, now)) || (rank(y) - rank(x)); });   // 遠的在上，近的在下；紀錄在最上面
    d.sort(function (x, y) { return (y.doneAt || y.deadline) - (x.doneAt || x.deadline); });
    return { a: a, d: d };
  }
  function sortKey(it) { return it.deadline || 9e15 - (it.at || 0); }      // 紀錄之間：新的在下面
  // 分組（和畫面上的分隔標籤一致）：紀錄 > 各天（晚的在上）> 已逾期；同一組裡依 rank（手動排過的用 order，否則依時間）
  function groupRank(it, now) { return !it.deadline ? 9e15 : it.deadline <= now ? -1 : dayStart(it.deadline); }
  function rank(it) { return it.order || sortKey(it); }
  function findItem(id) {
    var v = view(), i = idx(v.a, id);
    if (i >= 0) return { it: v.a[i], kind: 'a' };
    i = idx(v.d, id);
    return i >= 0 ? { it: v.d[i], kind: 'd' } : null;
  }

  function push(op, delay) {
    op.opId = uid();
    op.at = op.at || Date.now();
    outbox.push(op);
    save(KEY_OUT, outbox);
    render();
    updatePill();
    scheduleFlush(delay == null ? 400 : delay);
    return op;
  }
  /** 復原：還沒送出就直接拿掉，已經送出就送一個反向的變更 */
  function undo(op, inverse) {
    var k = outbox.indexOf(op);
    if (k >= 0 && !(inflight && inflight[op.opId])) { outbox.splice(k, 1); save(KEY_OUT, outbox); render(); updatePill(); return; }
    var inv = inverse && inverse();
    if (inv) pushMany([].concat(inv), 400);
  }
  function pushMany(ops, delay) {
    if (!ops.length) return;
    ops.forEach(function (op) { op.opId = uid(); op.at = op.at || Date.now(); outbox.push(op); });
    save(KEY_OUT, outbox);
    render();
    updatePill();
    scheduleFlush(delay == null ? 400 : delay);
  }

  // ---------- 同步（橋）----------
  var bridge = null, bridgeOrigin = '', frame = null, calls = {}, seq = 0, readyTimer = null;
  var inflight = null, busy = false, flushTimer = null, failCount = 0, lastSync = 0, maintained = false;

  function startBridge() {
    bridge = null;
    if (frame) frame.remove();
    frame = el('iframe');
    frame.title = 'sync';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
    frame.src = BRIDGE_URL;
    document.body.appendChild(frame);
    startedAt = Date.now();
    clearTimeout(readyTimer);
    readyTimer = setTimeout(function () { if (!bridge) updatePill(); }, 25000);
  }
  window.addEventListener('message', function (e) {
    if (!BRIDGE_ORIGIN.test(e.origin) || !e.data) return;
    if (e.data.type === 'dr-ready') {
      bridge = e.source; bridgeOrigin = e.origin; clearTimeout(readyTimer); failCount = 0;
      updatePill();
      flush();
    } else if (e.data.type === 'dr-result') {
      var c = calls[e.data.id];
      if (!c) return;
      delete calls[e.data.id];
      clearTimeout(c.t);
      if (e.data.ok) c.res(e.data.result); else c.rej(new Error(e.data.error || '同步失敗'));
    }
  });
  function call(fn, args) {
    return new Promise(function (res, rej) {
      if (!bridge) { rej(new Error('not ready')); return; }
      var id = ++seq;
      var t = setTimeout(function () { delete calls[id]; rej(new Error('timeout')); }, fn === 'applyOps' ? 60000 : 40000);
      calls[id] = { res: res, rej: rej, t: t, at: Date.now() };
      try { bridge.postMessage({ type: 'dr-call', id: id, fn: fn, args: args || [] }, bridgeOrigin); }
      catch (err) { clearTimeout(t); delete calls[id]; rej(err); }
    });
  }
  function scheduleFlush(ms) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ms);
  }
  function setBase(state) {
    base = { items: state.items || [], done: state.done || [], at: Date.now() };
    save(KEY_BASE, base);
    lastSync = Date.now();
  }
  function remap(idMap) {
    if (!idMap) return;
    outbox.forEach(function (op) { if (idMap[op.id]) op.id = idMap[op.id]; });
    if (openId && idMap[openId]) openId = idMap[openId];
    if (sheet.id && idMap[sheet.id]) sheet.id = idMap[sheet.id];
    undoOps.forEach(function (u) { if (idMap[u.id]) u.id = idMap[u.id]; });
  }
  function onFail(err) {
    busy = false; inflight = null;
    failCount++;
    if (failCount >= 3 && navigator.onLine) { failCount = 0; startBridge(); }     // 橋可能失效了，重新載入
    else scheduleFlush(Math.min(60000, 4000 * failCount));
    updatePill();
  }
  function flush() {
    clearTimeout(flushTimer);
    if (dragging) { scheduleFlush(1000); return; }
    if (!bridge || busy || !navigator.onLine) { updatePill(); return; }
    if (!outbox.length) { refresh(); return; }
    var batch = outbox.slice(0, 40);
    busy = true;
    inflight = {};
    batch.forEach(function (op) { inflight[op.opId] = true; });
    updatePill();
    call('applyOps', [batch]).then(function (res) {
      busy = false; inflight = null; failCount = 0;
      var byId = {}, failed = [];
      (res.results || []).forEach(function (r) { byId[r.opId] = r; if (!r.ok) failed.push(r); });
      outbox = outbox.filter(function (op) { return !byId[op.opId]; });
      remap(res.idMap);
      save(KEY_OUT, outbox);
      if (res.state) setBase(res.state);
      render();
      if (failed.length) notice('有 ' + failed.length + ' 項變更無法同步：' + failed[0].error);
      if (outbox.length) scheduleFlush(300); else afterSync();
      updatePill();
    }, onFail);
  }
  function refresh() {
    if (!bridge || busy || !navigator.onLine) return;
    busy = true;
    call('getState').then(function (state) {
      busy = false; failCount = 0;
      if (!outbox.length) { setBase(state); render(); }
      else scheduleFlush(100);
      afterSync();
      updatePill();
    }, onFail);
  }
  function afterSync() {
    if (maintained || !bridge) return;
    maintained = true;
    call('maintain').then(function (state) {
      if (state && !outbox.length && !busy) { setBase(state); render(); }
    }, function () { maintained = false; });
  }
  /* 上方的小提示：離線、連不上 Google，或短暫的錯誤訊息（不會擋到最下面的最新事項） */
  var noticeText = '', noticeTimer = null;
  function notice(text) {
    noticeText = text;
    updatePill();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { noticeText = ''; updatePill(); }, 5000);
  }
  function updatePill() {
    var p = $('pill'), text = '', link = false;
    if (noticeText) text = noticeText;
    else if (!navigator.onLine) text = outbox.length ? '離線中・' + outbox.length + ' 項變更連線後同步' : '離線中';
    else if (!bridge && frame && Date.now() - startedAt > 24000) { text = '無法連線到 Google・點這裡登入'; link = true; }
    p.textContent = text;
    p.classList.toggle('show', !!text);
    p.classList.toggle('link', link);
    showSync();
  }
  var startedAt = Date.now();
  $('pill').addEventListener('click', function () {
    if (!$('pill').classList.contains('link')) return;
    window.open(BRIDGE_URL, '_blank');
    setTimeout(startBridge, 1500);
  });
  window.addEventListener('online', function () { updatePill(); if (bridge) flush(); else startBridge(); });
  window.addEventListener('offline', updatePill);
  // 手機把 App 放到背景時，正在跑的同步可能就此卡住（一直顯示「同步中」）。回到前景時，卡超過 12 秒的就放棄、重新連線再送
  // （每個變更有 opId，重送不會重複）。順便檢查 App 有沒有新版。
  function ensureCache() {                     // 請 sw.js 檢查離線用的 App 本體快取還在不在，不在就補回來
    try { if (navigator.serviceWorker) navigator.serviceWorker.ready.then(function (r) { if (r.active) r.active.postMessage('ensure-cache'); }).catch(function () {}); } catch (e) {}
  }
  function restartBridge() {
    Object.keys(calls).forEach(function (k) { var c = calls[k]; delete calls[k]; clearTimeout(c.t); c.rej(new Error('stalled')); });
    startBridge();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    render();
    try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {}); } catch (e) {}
    ensureCache();
    var now = Date.now(), stuck = Object.keys(calls).some(function (k) { return now - calls[k].at > 12000; });
    if (stuck && navigator.onLine) { restartBridge(); return; }
    if (now - lastSync > 20000) flush();
  });
  setInterval(function () {
    if (!dragging && !sheet.open) render();
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60000) flush();
  }, 60000);

  // ---------- 畫面 ----------
  var ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14l-4-4 4-4M5 10h10.5a4 4 0 1 1 0 8H14"/></svg>';
  var ICON_NOTE = '<svg class="ni" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16H6zM9 9h6M9 13h6M9 17h3"/></svg>';

  function atBottom(sc) { return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40; }
  function render(opts) {
    opts = opts || {};
    var v = view(), now = Date.now();
    var pm = $('pm'), stick = opts.bottom || atBottom(pm), top = pm.scrollTop;
    var list = $('list');
    list.textContent = '';
    if (!base && !v.a.length) list.appendChild(el('div', 'empty', '載入中…'));
    else if (!v.a.length) list.appendChild(el('div', 'empty', '沒有待辦的 Deadline'));
    var last = null;
    v.a.forEach(function (it) {
      var b = bucket(it.deadline, now);
      if (b.key !== last) { var s = el('div', 'sep'); s.appendChild(el('span', '', b.label)); list.appendChild(s); last = b.key; }
      list.appendChild(card(it, 'a', b, now));
    });
    if (stick) pm.scrollTop = pm.scrollHeight; else pm.scrollTop = top;

    var dl = $('dl'), dtop = $('pd').scrollTop;
    dl.textContent = '';
    if (!v.d.length) dl.appendChild(el('div', 'empty', base ? '還沒有完成的項目' : '載入中…'));
    v.d.forEach(function (it) { dl.appendChild(card(it, 'd', null, now)); });
    $('pd').scrollTop = dtop;
  }
  function card(it, kind, b, now) {
    var w = el('div', 'cw');
    var d = el('div', 'cd ' + (kind === 'd' ? 'done' : b.c));
    d.setAttribute('data-id', it.id);
    if (it.id === openId && it.note) d.classList.add('open');
    if (sheet.open && sheet.id === it.id) d.classList.add('edit');
    d.innerHTML = '<span class="ck">' + (kind === 'd' ? ICON_BACK : ICON_CHECK) + '</span><span class="st"></span>' +
      '<div class="l1"><span class="t"></span>' + (it.note ? ICON_NOTE : '') + '<span class="sp"></span></div>' + (it.note ? '<div class="nt"></div>' : '');
    d.querySelector('.t').textContent = it.title;
    if (it.note) d.querySelector('.nt').textContent = it.note;
    var right = kind === 'd' ? el('span', 'dtm', it.doneAt ? md(it.doneAt) + hm(it.doneAt) : '')
      : b.c === 'r' ? el('span', 'h', hoursLeft(it.deadline, now))
      : b.c === 'n' && it.at ? el('span', 'dtm', md(it.at)) : null;
    if (right) d.querySelector('.l1').appendChild(right);
    w.appendChild(d);
    gesture(w, d, it.id, kind);
    return w;
  }

  // ---------- 提示（含復原）：幾秒後自己消失，也可以往左右或往下滑掉 ----------
  var toastTimer = null, undoFn = null, undoOps = [];
  function hideToast() { $('toast').classList.remove('show'); undoFn = null; }
  function toast(msg, onUndo) {
    var t = $('toast');
    t.style.transition = ''; t.style.translate = ''; t.style.opacity = '';
    $('tmsg').textContent = msg;
    t.classList.toggle('noundo', !onUndo);
    t.classList.add('show');
    undoFn = onUndo || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, onUndo ? 4500 : 2500);
  }
  (function swipeToast() {
    var T = $('toast'), s = null;
    T.addEventListener('pointerdown', function (e) {
      if (e.button || !T.classList.contains('show')) return;
      s = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false, dx: 0, dy: 0, pts: [] };
    });
    T.addEventListener('pointermove', function (e) {
      if (!s) return;
      var dx = e.clientX - s.x, dy = e.clientY - s.y, now = performance.now();
      if (!s.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        s.on = true;
        try { T.setPointerCapture(s.id); } catch (x) {}
        clearTimeout(toastTimer);
        T.style.transition = 'none';
      }
      s.dx = dx; s.dy = Math.max(0, dy);                    // 往上不動，往左右／往下跟著手指
      s.pts.push([now, dx, s.dy]);
      while (s.pts.length > 2 && now - s.pts[0][0] > 100) s.pts.shift();
      T.style.translate = 'calc(-50% + ' + dx + 'px) ' + s.dy + 'px';
      T.style.opacity = String(Math.max(0, 1 - Math.max(Math.abs(dx) / 220, s.dy / 70)));
    });
    function end() {
      if (!s) return;
      var q = s; s = null;
      if (!q.on) return;                                     // 沒有拖＝一般的點（「復原」照常）
      var now = performance.now(), a = q.pts[0], b = q.pts[q.pts.length - 1], vx = 0, vy = 0;
      if (a && now - b[0] < 120) { var dt = Math.max(16, b[0] - a[0]); vx = (b[1] - a[1]) / dt; vy = (b[2] - a[2]) / dt; }
      var side = Math.abs(q.dx) > 70 || (Math.abs(vx) > 0.2 && vx * q.dx > 0), down = q.dy > 24 || vy > 0.2;
      T.style.transition = '';
      if (side || down) {
        T.style.translate = side ? 'calc(-50% + ' + (q.dx > 0 ? 1 : -1) * (T.offsetWidth + 40) + 'px) ' + q.dy + 'px' : '-50% 90px';
        T.style.opacity = '0';
        undoFn = null;
        scheduleFlush(300);                                  // 不復原了：變更可以馬上送出
        setTimeout(function () { hideToast(); T.style.transition = 'none'; T.style.translate = ''; T.style.opacity = ''; void T.offsetHeight; T.style.transition = ''; }, 260);
      } else {
        T.style.translate = ''; T.style.opacity = '';
        toastTimer = setTimeout(hideToast, 2500);
      }
    }
    T.addEventListener('pointerup', end);
    T.addEventListener('pointercancel', end);
  })();
  $('undo').addEventListener('click', function () {
    var f = undoFn; undoFn = null;
    $('toast').classList.remove('show');
    if (f) f();
  });

  // ---------- 完成／移回／刪除 ----------
  function complete(id) {
    var f = findItem(id); if (!f) return;
    var ref = { id: id }; undoOps.push(ref);
    var op = push({ type: 'complete', id: id }, 4800);
    toast('已完成「' + f.it.title + '」', function () { undo(op, function () { return { type: 'restore', id: ref.id }; }); });
  }
  function restore(id) {
    var f = findItem(id); if (!f) return;
    var ref = { id: id }; undoOps.push(ref);
    var op = push({ type: 'restore', id: id }, 4800);
    toast('已移回「' + f.it.title + '」', function () { undo(op, function () { return { type: 'complete', id: ref.id }; }); });
  }
  function remove(id) {
    var f = findItem(id); if (!f) return;
    var it = f.it;
    var op = push({ type: 'delete', id: id }, 4800);
    toast('已刪除「' + it.title + '」', function () {
      undo(op, function () {
        if (it.deadline && it.deadline <= Date.now()) return null;
        return { type: 'add', tmp: 'tmp_' + uid(), data: { title: it.title, note: it.note, deadline: it.deadline, ahead: it.ahead, every: it.every } };
      });
    });
  }

  // ---------- 手勢：點＝展開、按住＝編輯、右拉＝完成（已完成頁左拉＝移回）、反方向＝換頁、往下拉（或按住後拖）到垃圾桶＝刪除 ----------
  var TR = $('tr'), dragging = false;
  function overTrash(x, y) { var r = TR.getBoundingClientRect(); return x > r.left - 28 && x < r.right + 28 && y > r.top - 8 && y < r.bottom + 40; }   // 上緣只多 8px：手指要拖過最後一張卡
  function collapse(w, cb) { w.style.height = w.offsetHeight + 'px'; void w.offsetHeight; w.style.height = '0px'; w.style.marginBottom = '0px'; setTimeout(cb, 280); }
  var HOLD_MS = 100;                            // 手機上按住多久卡片就壓下去、可以上下拖
  function gesture(w, d, id, kind) {
    var s = null, dir = kind === 'a' ? 1 : -1;
    d.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    d.addEventListener('touchmove', function (e) { if (s && (s.lg || s.mv || s.held)) e.preventDefault(); }, { passive: false });   // 按住後：手指移動不捲動清單
    d.addEventListener('pointerdown', function (e) {
      if (e.button || s) return;
      try { d.setPointerCapture(e.pointerId); } catch (x) {}
      s = { x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0, mv: false, lg: false, w: d.offsetWidth, touch: e.pointerType !== 'mouse' };
      // 手機上：直接上下滑＝捲動清單；按住一下（約 0.1 秒，卡片一壓下去）就可以上下拖＝拖卡片；0.5 秒震動＝編輯
      s.held = !s.touch; s.far = 0; s.t0 = e.timeStamp; s.early = false;
      if (s.touch) s.rt = setTimeout(function () { if (s && !s.mv && !s.early && s.far < 8) { s.held = true; d.classList.add('press', 'ready'); } }, HOLD_MS);   // 手指幾乎不動才算按住；壓下去的動畫一出現就能拖
      else d.classList.add('press');
      s.tm = setTimeout(function () {
        if (!s || s.mv) return;
        s.lg = true;
        d.classList.remove('press', 'ready');
        buzz(12);
        openSheet('edit', id);
        d.classList.add('edit');
      }, 500);
    });
    d.addEventListener('pointermove', function (e) {
      if (!s) return;
      if (s.page) { pageMove(e.clientX); return; }
      s.dx = e.clientX - s.x; s.dy = e.clientY - s.y;
      var dist = Math.sqrt(s.dx * s.dx + s.dy * s.dy);
      if (dist > s.far) s.far = dist;
      // 手指在 0.1 秒內就移動了 8px 以上＝在滑（捲動），不是按住。畫面忙的時候計時器可能比排隊中的手指移動先跑，
      // 所以用觸控事件本身的時間再確認一次，誤判成按住就撤回（不然快速捲動會變成拖卡片）
      if (s.touch && !s.mv && !s.lg && !s.early) {
        var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || []; if (!evs.length) evs = [e];
        for (var i = 0; i < evs.length; i++) {
          var qx = evs[i].clientX - s.x, qy = evs[i].clientY - s.y;
          if (evs[i].timeStamp - s.t0 < HOLD_MS && qx * qx + qy * qy >= 64) { s.early = true; break; }
        }
        if (s.early && s.held) { s.held = false; d.classList.remove('press', 'ready'); }
      }
      if (!s.mv) {
        if (dist <= (s.lg ? 10 : 12)) return;
        var ax = Math.abs(s.dx), ay = Math.abs(s.dy);
        // 往上／往下拉（偏一點左右也算）＝拖卡片：拖到別的卡片之間＝調整順序，拖到垃圾桶＝刪除
        var down = s.dy > 0 && s.dy >= ax * 0.6, up = s.dy < 0 && -s.dy >= ax * 0.6;
        if ((down || up) && !s.held && !s.lg) { cancel(); return; }  // 沒先按住就上下滑＝捲動清單（交給瀏覽器）
        // 換頁：待辦卡片往左滑＝打開已完成（往右滑才是完成）；已完成卡片往右滑＝回待辦（往左滑才是移回）
        if (!s.lg && !down && !up && ax >= ay && s.dx * dir < 0) {
          clearTimeout(s.tm);
          d.classList.remove('press');
          s.page = true; s.mv = true;
          pageBegin(s.x, kind === 'a', s.t); pageMove(e.clientX);
          return;
        }
        s.mv = true; dragging = true;
        clearTimeout(s.tm); clearTimeout(s.rt); d.classList.remove('ready');
        if (s.lg) { closeSheet(false, true); d.classList.remove('edit'); }
        d.classList.remove('press');
        d.classList.add('drag');
        TR.classList.add('show');
        if (kind === 'a') startReorder(s, w);
      }
      var hot = overTrash(e.clientX, e.clientY);
      if (hot !== TR.classList.contains('hot')) { TR.classList.toggle('hot', hot); if (hot) buzz(8); }
      var along = s.dx * dir, prog = along > 0 ? Math.min(1, along / (s.w * 0.35)) : 0, ok = !hot && prog >= 1;
      if (ok !== d.classList.contains('ok')) { d.classList.toggle('ok', ok); if (ok) buzz(8); }
      d.querySelector('.ck').style.opacity = hot ? 0 : Math.min(1, prog * 1.4);
      d.style.translate = s.dx + 'px ' + s.dy + 'px';
      d.style.scale = hot ? '.86' : '1';
      d.style.opacity = hot ? .85 : 1;
      if (s.grp) moveReorder(s, hot || ok);
    });
    function cancel() {
      if (!s) return;
      clearTimeout(s.tm); clearTimeout(s.rt); d.classList.remove('ready');
      if (s.page) pageEnd();
      if (s.grp) clearShift(s);
      s = null; dragging = false;
      d.classList.remove('press', 'drag', 'ok');
      d.style.translate = ''; d.style.scale = ''; d.style.opacity = '';
      d.querySelector('.ck').style.opacity = 0;
      TR.classList.remove('show', 'hot');
    }
    function end(cancelled) {
      if (!s) return;
      clearTimeout(s.tm); clearTimeout(s.rt); d.classList.remove('ready');
      var st = s; s = null;
      if (st.page) { pageEnd(); return; }
      var hot = TR.classList.contains('hot');
      d.classList.remove('press', 'drag');
      if (!st.mv && st.lg) return;                                   // 按住後放開：編輯面板留著
      if (st.grp && (cancelled || hot || st.dx * dir >= st.w * 0.35 || st.to === st.gi)) clearShift(st);
      if (!cancelled && !hot && st.grp && st.to !== st.gi && st.dx * dir < st.w * 0.35) {   // 放在別的位置＝調整順序
        dragging = false;
        TR.classList.remove('show', 'hot');
        commitReorder(st, id, d);
        return;
      }
      if (cancelled || (!hot && st.dx * dir < st.w * 0.35)) {
        dragging = false;
        TR.classList.remove('show', 'hot');
        if (!st.mv && !cancelled) { toggleOpen(id, d); return; }
        d.style.translate = ''; d.style.scale = ''; d.style.opacity = '';
        d.classList.remove('ok');
        d.querySelector('.ck').style.opacity = 0;
        return;
      }
      if (hot) {
        var r = TR.getBoundingClientRect(), c = d.getBoundingClientRect();
        var tx = st.dx + (r.left + r.width / 2) - (c.left + c.width / 2), ty = st.dy + (r.top + r.height / 2) - (c.top + c.height / 2);
        d.style.transition = 'translate .32s var(--ease), scale .32s var(--ease), opacity .32s var(--ease)';
        d.style.translate = tx + 'px ' + ty + 'px'; d.style.scale = '.35'; d.style.opacity = 0;
        setTimeout(function () {
          TR.classList.remove('hot'); setTimeout(function () { TR.classList.remove('show'); }, 120);
          collapse(w, function () { dragging = false; remove(id); });
        }, 300);
        return;
      }
      TR.classList.remove('show');
      d.style.transition = 'translate .34s var(--ease), opacity .3s var(--ease)';
      d.style.translate = (dir * st.w * 1.25) + 'px ' + st.dy + 'px'; d.style.opacity = 0;
      setTimeout(function () { collapse(w, function () { dragging = false; if (kind === 'a') complete(id); else restore(id); }); }, 300);
    }
    d.addEventListener('pointerup', function () { end(false); });
    d.addEventListener('pointercancel', function () { end(true); });
  }
  // ---------- 調整順序：同一組（同一天／已逾期／紀錄）裡上下拖，其他卡片讓位；放開後存成每張卡的 order ----------
  function groupOf(w) {
    var a = [], x = w;
    while (x.previousElementSibling && x.previousElementSibling.classList.contains('cw')) x = x.previousElementSibling;
    for (; x && x.classList.contains('cw'); x = x.nextElementSibling) a.push(x);
    return a;
  }
  function startReorder(s, w) {
    var g = groupOf(w);
    if (g.length < 2) return;
    s.grp = g; s.gi = g.indexOf(w); s.to = s.gi;
    s.mid = g.map(function (x) { var r = x.getBoundingClientRect(); return r.top + r.height / 2; });
    s.step = w.offsetHeight + (parseFloat(getComputedStyle(w).marginBottom) || 0);
  }
  function moveReorder(s, frozen) {
    var cy = s.mid[s.gi] + s.dy, to = 0;
    for (var j = 0; j < s.grp.length; j++) if (j !== s.gi && s.mid[j] < cy) to++;
    if (frozen) to = s.gi;                         // 在垃圾桶上或正要完成：不讓位
    if (to === s.to) return;
    s.to = to;
    s.grp.forEach(function (x, j) {
      var sh = 0;
      if (j !== s.gi) { if (s.gi < to && j > s.gi && j <= to) sh = -s.step; else if (to < s.gi && j >= to && j < s.gi) sh = s.step; }
      x.style.translate = sh ? '0 ' + sh + 'px' : '';
    });
    buzz(6);
  }
  function clearShift(s) { s.grp.forEach(function (x) { x.style.translate = ''; }); }
  function commitReorder(st, id, d) {
    var ids = st.grp.map(function (x) { return x.querySelector('.cd').getAttribute('data-id'); });
    ids.splice(st.gi, 1); ids.splice(st.to, 0, id);
    var v = view(), byId = {};
    v.a.forEach(function (it) { byId[it.id] = it; });
    var ranks = ids.map(function (k) { return byId[k] ? rank(byId[k]) : 0; }).sort(function (a, b) { return b - a; });   // 同一組原本的排序值，由大到小
    var ops = [], prev = Infinity;
    ids.forEach(function (k, i) {
      var r = Math.min(ranks[i], prev - 1); prev = r;                   // 依新的順序重新分配；一樣的值往下錯開 1
      var it = byId[k];
      if (it && rank(it) !== r) ops.push({ type: 'order', id: k, data: { order: r } });
    });
    var from = d.getBoundingClientRect();
    clearShift(st);
    pushMany(ops, 1200);
    var nd = document.querySelector('#list .cd[data-id="' + id + '"]');
    if (nd) {                                     // 從放開的位置滑進新的位置
      var to = nd.getBoundingClientRect();
      nd.style.transition = 'none'; nd.style.translate = (from.left - to.left) + 'px ' + (from.top - to.top) + 'px';
      void nd.offsetHeight; nd.style.transition = ''; nd.style.translate = '';
    }
  }
  function toggleOpen(id, d) {
    if (!d.querySelector('.nt')) return;
    var was = d.classList.contains('open');
    document.querySelectorAll('.cd.open').forEach(function (o) { o.classList.remove('open'); });
    d.classList.toggle('open', !was);
    openId = was ? null : id;
  }

  // ---------- 換頁：待辦頁任何地方往左滑＝已完成；已完成頁任何地方往右滑＝回待辦（手機的返回鍵也會回待辦）----------
  var APP = $('app'), PM = $('pm'), PD = $('pd');
  // 保險：舊瀏覽器不支援 overflow: clip 時，App 外框被捲動（例如鍵盤彈出）就馬上捲回來，收起來的面板和垃圾桶不會露出來
  function unscrollApp() { if (APP.scrollTop || APP.scrollLeft) { APP.scrollTop = 0; APP.scrollLeft = 0; } }
  APP.addEventListener('scroll', unscrollApp);
  if (window.visualViewport) visualViewport.addEventListener('resize', function () { unscrollApp(); setTimeout(unscrollApp, 350); });
  var pager ={ on: false, opening: false, x0: 0, dx: 0, W: 1, endAt: 0, pts: [], tm: 0 };
  function clamp01(n) { return Math.min(1, Math.max(0, n)); }
  function pageBegin(x, opening, t) {            // x, t＝手指按下的位置和時間（算甩的速度用）
    pager.on = true; pager.opening = opening; pager.x0 = x; pager.dx = 0;
    pager.pts = [[t || performance.now(), x]]; pager.W = APP.offsetWidth || 1;
    APP.classList.add('nodrag');
  }
  function pageMove(x) {
    if (!pager.on) return;
    var now = performance.now(), p = pager.pts;
    pager.dx = x - pager.x0;
    p.push([now, x]);
    while (p.length > 2 && now - p[0][0] > 100) p.shift();       // 只用最近 0.1 秒算速度
    var prog = pager.opening ? clamp01(-pager.dx / pager.W) : clamp01(1 - pager.dx / pager.W);
    PD.style.translate = ((1 - prog) * 100) + '% 0';
    PM.style.translate = (-28 * prog) + '% 0';
  }
  // 放開時：往換頁方向輕輕一甩（≥ 每秒 150px）就換過去；沒甩的話，拖過四分之一寬也換；往回甩＝取消
  function pageEnd() {
    if (!pager.on) return;
    pager.on = false;
    var now = pager.endAt = performance.now(), p = pager.pts, a = p[0], z = p[p.length - 1];
    var v = now - z[0] > 120 ? 0 : (z[1] - a[1]) / Math.max(16, z[0] - a[0]);   // px/ms；放開前停住就不算甩
    var sign = pager.opening ? -1 : 1, along = pager.dx * sign, vs = v * sign;
    var flick = Math.abs(vs) >= 0.15;
    var go = flick ? vs > 0 : along > pager.W * 0.25;
    var dur = flick && go ? 230 : 300;                               // 甩過去的比較快
    APP.style.setProperty('--navd', dur + 'ms');
    clearTimeout(pager.tm); pager.tm = setTimeout(function () { APP.style.removeProperty('--navd'); }, dur + 80);
    APP.classList.remove('nodrag');
    void APP.offsetHeight;
    PD.style.translate = ''; PM.style.translate = '';
    setDone(pager.opening ? go : !go);
  }
  function setDone(open, fromHistory) {
    if (open === APP.classList.contains('dopen')) return;
    APP.classList.toggle('dopen', open);
    if (fromHistory) return;
    if (open) history.pushState({ page: 'done' }, '');
    else if (history.state && history.state.page === 'done') history.back();
  }
  var skipPop = 0;
  window.addEventListener('popstate', function () {
    if (skipPop) { skipPop--; return; }
    if (sheet.open) { closeSheet(false, false, true); return; }
    setDone(!!(history.state && history.state.page === 'done'), true);
  });
  // 空白處、分隔標籤、輸入列、選項區的換頁手勢（卡片上的在 gesture() 裡處理）
  function swipeArea(P, opening) {
    var c = null;
    P.addEventListener('pointerdown', function (e) {
      if (e.button || e.target.closest('.cd, input, textarea')) { c = null; return; }
      c = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, on: false };
    });
    P.addEventListener('pointermove', function (e) {
      if (!c) return;
      var dx = e.clientX - c.x, dy = e.clientY - c.y;
      if (!c.on) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) || (opening ? dx > 0 : dx < 0)) { c = null; return; }
        c.on = true;
        try { P.setPointerCapture(c.id); } catch (x) {}
        pageBegin(c.x, opening, c.t);
      }
      pageMove(e.clientX);
    });
    ['pointerup', 'pointercancel'].forEach(function (t) { P.addEventListener(t, function () { if (c && c.on) pageEnd(); c = null; }); });
  }
  swipeArea(PM, true);                          // 待辦頁：任何地方往左滑＝打開已完成
  swipeArea(PD, false);                         // 已完成頁：任何地方往右滑＝回待辦

  // ---------- 新增／編輯面板 ----------
  var SH = $('sh'), BD = $('bd'), OK = $('ok');
  var sheet = { open: false, mode: '', id: null, kind: '', orig: '', deadline: 0, ua: 'h', ue: 'h' };
  function numOf(input, unit) {
    var s = String(input.value).trim().replace(/,/g, '.');
    if (s === '') return NaN;
    var n = Number(s);
    return isFinite(n) ? Math.round(n * (unit === 'd' ? 24 : 1)) : NaN;
  }
  function showNum(input, hours, unit) { input.value = String(Math.round((unit === 'd' ? hours / 24 : hours) * 100) / 100); }
  function setUnit(btn, unit) { btn.textContent = unit === 'd' ? '天' : '小時'; }
  function formData() {
    return {
      title: $('ft').value.replace(/\s+/g, ' ').trim(),
      note: $('fnote').value.replace(/\r\n?/g, '\n').trim(),
      deadline: sheet.deadline,
      ahead: numOf($('fa'), sheet.ua),
      every: numOf($('fe'), sheet.ue),
    };
  }
  function snap(f) { return [f.title, f.note, f.deadline, f.ahead, f.every].join('|'); }
  // 截止時間可以留空（＝單純紀錄，不提醒）；提前／每隔可以是 0（＝只在截止那一刻提醒）
  function validity() {
    var f = formData(), dl = f.deadline > 0;
    var ok = !!f.title && (!dl || (isFinite(f.ahead) && f.ahead >= 0 && f.ahead <= MAX_AHEAD && isFinite(f.every) && f.every >= 0 && f.every <= MAX_AHEAD));
    if (sheet.mode === 'add') ok = ok && (!dl || f.deadline > Date.now());
    else ok = ok && snap(f) !== sheet.orig && (!dl || Math.floor(f.deadline / 60000) === Math.floor(sheet.orig0 / 60000) || f.deadline > Date.now());
    OK.classList.toggle('off', !ok);
    zeroHints();
    return ok ? f : null;
  }
  function zeroHints() {
    var a = numOf($('fa'), sheet.ua), e = numOf($('fe'), sheet.ue);
    $('fas').textContent = a === 0 ? '只在截止時' : '開始提醒';
    $('fes').textContent = e === 0 ? '只在截止時' : '提醒一次';
  }
  function showDate() {
    var dv = $('fdv');
    if (sheet.deadline) { dv.textContent = fullDate(sheet.deadline) + hm(sheet.deadline); dv.classList.remove('ph'); }
    else { dv.textContent = '沒有截止（單純紀錄）'; dv.classList.add('ph'); }
    SH.classList.toggle('nodl', !sheet.deadline);
  }
  // 說明欄跟著內容長高：平常最多 140px；面板拉高時可以長到把下面多出來的空間用完（下面的列跟著往下，但不會被擠出面板）
  function growNote() {
    var t = $('fnote'), cap = 140;
    t.style.height = 'auto';
    if (SH.classList.contains('grow')) {
      var kids = SH.children, last = null;
      for (var i = kids.length - 1; i >= 0 && !last; i--) if (kids[i].getClientRects().length) last = kids[i];
      var pad = parseFloat(getComputedStyle(SH).paddingBottom) || 0;
      var free = last ? SH.getBoundingClientRect().bottom - pad - last.getBoundingClientRect().bottom : 0;
      cap = Math.max(140, t.offsetHeight + free);
    }
    t.style.height = Math.min(t.scrollHeight, cap) + 'px';
    noteScroll();
  }
  function noteScroll() { var t = $('fnote'); t.classList.toggle('scroll', t.scrollHeight > t.clientHeight + 1); }   // 說明要捲動時才讓手指捲它
  function openSheet(mode, id) {
    var f = id ? findItem(id) : null;
    if (mode === 'edit' && !f) return;
    resetSheetSize();
    sheet.open = true; sheet.mode = mode; sheet.id = id || null; sheet.kind = f ? f.kind : '';
    var it = f ? f.it : { title: '', note: '', deadline: 0, ahead: prefs.ahead, every: prefs.every };
    $('ft').value = it.title; $('fnote').value = it.note || '';
    sheet.deadline = it.deadline; sheet.orig0 = it.deadline;
    $('fd').value = it.deadline ? toLocalInput(it.deadline) : '';
    $('fd').min = toLocalInput(Date.now());
    var ahead = it.ahead == null ? DEF_AHEAD : it.ahead, every = it.every == null ? DEF_EVERY : it.every;
    sheet.ua = ahead >= 24 && ahead % 24 === 0 && ahead > 72 ? 'd' : 'h';
    sheet.ue = 'h';
    showNum($('fa'), ahead, sheet.ua); setUnit($('ua'), sheet.ua);
    showNum($('fe'), every, sheet.ue); setUnit($('ue'), sheet.ue);
    showDate(); growNote();
    sheet.orig = snap(formData());
    SH.classList.toggle('edit', mode === 'edit');
    OK.setAttribute('aria-label', mode === 'edit' ? '儲存' : '新增');
    validity();
    SH.classList.add('show'); BD.classList.add('show');
    history.pushState({ page: APP.classList.contains('dopen') ? 'done' : 'main', sheet: true }, '');
    if (mode === 'add') setTimeout(function () { $('ft').focus({ preventScroll: true }); }, 60);   // 面板還在滑上來，不要讓瀏覽器捲畫面去找輸入框
  }
  function closeSheet(save, quiet, fromHistory) {
    if (!sheet.open) return;
    var f = save ? validity() : null;
    if (save && !f) return;
    sheet.open = false;
    if (!fromHistory && history.state && history.state.sheet) { skipPop++; history.back(); }
    SH.classList.remove('show'); BD.classList.remove('show');
    clearTimeout(sizeTimer); sizeTimer = setTimeout(resetSheetSize, 450);   // 收下去之後再恢復原本大小
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.querySelectorAll('.cd.edit').forEach(function (c) { c.classList.remove('edit'); });
    if (!f) return;
    if (sheet.mode === 'add') {
      var tmp = 'tmp_' + uid();
      push({ type: 'add', tmp: tmp, data: f }, 300);
      render({ bottom: false });
      var c = document.querySelector('.cd[data-id="' + tmp + '"]');
      if (c) { c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.classList.add('flash'); }
      return;
    }
    var before = findItem(sheet.id), ref = { id: sheet.id };
    undoOps.push(ref);
    var op = push({ type: 'update', id: sheet.id, data: f }, 4800);
    toast('已更新「' + f.title + '」', function () {
      undo(op, function () {                    // 已經送出了：把舊的內容改回去（原本在已完成的，改回去後再標成完成）
        if (!before) return null;
        var o = before.it, inv = [{ type: 'update', id: ref.id, undo: true, data: { title: o.title, note: o.note, deadline: o.deadline, ahead: o.ahead, every: o.every } }];
        if (o.order) inv.push({ type: 'order', id: ref.id, data: { order: o.order } });
        if (before.kind === 'd') inv.push({ type: 'complete', id: ref.id });
        return inv;
      });
    });
  }
  $('cp').addEventListener('click', function () { if (performance.now() - pager.endAt > 400) openSheet('add'); });   // 剛在輸入列上滑動換頁時不打開
  BD.addEventListener('click', function () { closeSheet(false); });
  OK.addEventListener('click', function () { if (!OK.classList.contains('off')) closeSheet(true); });
  ['ft', 'fnote', 'fa', 'fe'].forEach(function (k) { $(k).addEventListener('input', validity); });
  $('fnote').addEventListener('input', growNote);
  $('ft').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('fnote').focus(); } });
  SH.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSheet(false);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!OK.classList.contains('off')) closeSheet(true); }
  });
  $('fd').addEventListener('click', function () { try { this.showPicker(); } catch (e) {} });
  $('fdc').addEventListener('click', function (e) {     // ✕：不設截止＝單純紀錄
    e.preventDefault(); e.stopPropagation();
    sheet.deadline = 0; $('fd').value = '';
    showDate(); validity();
  });
  $('fd').addEventListener('change', function () { sheet.deadline = fromLocalInput(this.value); showDate(); validity(); });
  $('fd').addEventListener('input', function () { sheet.deadline = fromLocalInput(this.value); showDate(); validity(); });
  function unitToggle(btnId, inputId, key) {
    $(btnId).addEventListener('click', function () {
      var input = $(inputId), hours = numOf(input, sheet[key]);
      sheet[key] = sheet[key] === 'h' ? 'd' : 'h';
      setUnit(this, sheet[key]);
      if (isFinite(hours)) showNum(input, hours, sheet[key]);
      validity();
    });
  }
  unitToggle('ua', 'fa', 'ua');
  unitToggle('ue', 'fe', 'ue');
  /* 整個面板（灰色橫條、標題、說明、日期、提醒設定、下面的空白）：往上拉＝把面板拉高（內容跟著上緣，說明寫長了可以往下長），
     往下拉＝縮回原本大小，再往下＝關掉。在標題／說明上輕點還是照常輸入，拖超過一點點才算拉面板。 */
  var sizeTimer = null;
  function resetSheetSize() {                   // 面板回到依內容決定的高度
    clearTimeout(sizeTimer);
    sheet.big = false;
    SH.classList.remove('grow', 'big');
    SH.style.height = ''; SH.style.translate = '';
  }
  (function pull() {
    var z = SH, p = null;                         // 整個面板都可以上下拉
    z.addEventListener('pointerdown', function (e) {
      if (e.button || e.target.closest('#ok')) return;
      if (e.pointerType === 'mouse' && e.target.closest('textarea, input.v')) return;   // 滑鼠在說明、數字欄裡拖＝選字
      clearTimeout(sizeTimer);
      var h = SH.offsetHeight, h0 = sheet.big ? sheet.h0 : h;
      p = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false, h: h, h0: h0, max: Math.max(h0, Math.round(APP.clientHeight * 0.92)), dy: 0, pts: [] };
      if (e.target.closest('.gz')) start();
    });
    function start() {
      p.on = true;
      try { z.setPointerCapture(p.id); } catch (x) {}
      if (document.activeElement && document.activeElement.blur && z.contains(document.activeElement)) document.activeElement.blur();
      try { window.getSelection().removeAllRanges(); } catch (x) {}
      SH.style.transition = 'none'; BD.style.transition = 'none';
      SH.style.height = p.h + 'px';
      SH.classList.add('grow');                   // 說明欄填滿多出來的高度
    }
    function place(V) {                           // V＝面板露出來的高度
      if (V >= p.h0) { SH.style.height = Math.min(V, p.max) + 'px'; SH.style.translate = '0 0'; BD.style.opacity = ''; }
      else { SH.style.height = p.h0 + 'px'; SH.style.translate = '0 ' + (p.h0 - V) + 'px'; BD.style.opacity = String(Math.max(0, V / p.h0)); }
    }
    z.addEventListener('pointermove', function (e) {
      if (!p) return;
      if (!p.on) {
        var mx = e.clientX - p.x, my = e.clientY - p.y;
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (Math.abs(my) > Math.abs(mx)) start(); else { p = null; return; }
      }
      e.preventDefault();
      var now = performance.now();
      p.dy = e.clientY - p.y;
      p.pts.push([now, e.clientY]);
      while (p.pts.length > 2 && now - p.pts[0][0] > 100) p.pts.shift();
      place(p.h - p.dy);
    });
    function rel() {
      if (!p) return;
      var q = p; p = null;
      if (!q.on) return;
      var now = performance.now(), a = q.pts[0], b = q.pts[q.pts.length - 1];
      var vy = !a || now - b[0] > 120 ? 0 : (b[1] - a[1]) / Math.max(16, b[0] - a[0]);   // px/ms，正＝往下甩
      var V = q.h - q.dy, span = q.max - q.h0, wasBig = q.h > q.h0 + 1, to;
      if (V < q.h0) to = vy < -0.2 ? 'normal' : (q.h0 - V > q.h0 * 0.25 || vy > 0.6) ? 'close' : 'normal';
      else if (vy < -0.2) to = 'big';                                  // 輕輕往上甩就拉高
      else if (vy > 0.2) to = 'normal';                                // 往下甩先縮回原本大小
      else if (wasBig) to = V < q.max - span * 0.2 ? 'normal' : 'big';
      else to = V > q.h0 + span * 0.2 ? 'big' : 'normal';
      if (span < 8 && to === 'big') to = 'normal';
      SH.style.transition = ''; BD.style.transition = '';
      void SH.offsetHeight;
      SH.style.translate = ''; BD.style.opacity = '';
      if (to === 'close') { closeSheet(false); return; }
      if (to === 'big') {
        sheet.big = true; sheet.h0 = q.h0;
        SH.style.height = q.max + 'px';
        SH.classList.add('big');
        sizeTimer = setTimeout(function () { if (sheet.big) { SH.style.height = ''; growNote(); } }, 420);   // 之後用 CSS 的 92%（鍵盤跳出來也會跟著縮）
      } else {
        sheet.big = false;
        var cur = SH.offsetHeight;                 // 縮回「依內容」的高度（說明在拉高時寫長了也算進去，最多 140px）
        SH.classList.remove('big', 'grow');
        growNote();
        SH.style.transition = 'none'; SH.style.height = '';
        var natural = SH.offsetHeight;
        SH.style.height = cur + 'px'; void SH.offsetHeight;
        SH.style.transition = '';
        SH.style.height = natural + 'px';
        sizeTimer = setTimeout(resetSheetSize, 420);
      }
    }
    z.addEventListener('pointerup', rel);
    z.addEventListener('pointercancel', rel);
  })();

  // ---------- 選項（已完成頁最上面）：外觀、新項目的預設提醒、同步狀態。存在這台裝置上 ----------
  function themeColor() { var dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches); return dark ? '#000000' : '#f2f2f7'; }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', t ? themeColor() : (m.media.indexOf('dark') >= 0 ? '#000000' : '#f2f2f7')); });
    document.querySelectorAll('#theme button').forEach(function (b) { var on = b.getAttribute('data-v') === (t || ''); b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
  }
  document.querySelectorAll('#theme button').forEach(function (b) {
    b.addEventListener('click', function () { var t = b.getAttribute('data-v'); try { if (t) localStorage.setItem(KEY_THEME, t); else localStorage.removeItem(KEY_THEME); } catch (e) {} applyTheme(t); });
  });
  var defUnits = { a: prefs.ahead >= 24 && prefs.ahead % 24 === 0 && prefs.ahead > 72 ? 'd' : 'h', e: 'h' };
  showNum($('da'), prefs.ahead, defUnits.a); setUnit($('dua'), defUnits.a);
  showNum($('de'), prefs.every, defUnits.e); setUnit($('due'), defUnits.e);
  if (prefs.ahead === 0) $('das').textContent = '只在截止時';
  if (prefs.every === 0) $('des').textContent = '只在截止時';
  function saveDefaults() {
    var a = numOf($('da'), defUnits.a), e = numOf($('de'), defUnits.e);
    var okA = isFinite(a) && a >= 0 && a <= MAX_AHEAD, okE = isFinite(e) && e >= 0 && e <= MAX_AHEAD;
    $('das').textContent = a === 0 ? '只在截止時' : '開始提醒';
    $('des').textContent = e === 0 ? '只在截止時' : '提醒一次';
    $('da').closest('.row').classList.toggle('bad', !okA);
    $('de').closest('.row').classList.toggle('bad', !okE);
    if (okA && okE) { prefs = { ahead: a, every: e }; save(KEY_DEF, prefs); }
  }
  $('da').addEventListener('input', saveDefaults);
  $('de').addEventListener('input', saveDefaults);
  [['dua', 'da', 'a'], ['due', 'de', 'e']].forEach(function (x) {
    $(x[0]).addEventListener('click', function () {
      var hours = numOf($(x[1]), defUnits[x[2]]);
      defUnits[x[2]] = defUnits[x[2]] === 'h' ? 'd' : 'h';
      setUnit(this, defUnits[x[2]]);
      if (isFinite(hours)) showNum($(x[1]), hours, defUnits[x[2]]);
    });
  });
  function showSync() {
    var s = $('syncInfo'); if (!s) return;
    var t = !navigator.onLine ? '離線中' : (busy ? '同步中…' : (lastSync ? '已同步 ' + md(lastSync) + hm(lastSync) : (base && base.at ? '上次同步 ' + md(base.at) + hm(base.at) : '尚未同步')));
    if (outbox.length) t += '・' + outbox.length + ' 項變更待同步';
    s.textContent = t;
  }
  (function () { var t = ''; try { t = localStorage.getItem(KEY_THEME) || ''; } catch (e) {} applyTheme(t); })();

  // ---------- 啟動 ----------
  if ('serviceWorker' in navigator) {
    // 有新版時：剛打開幾秒內、沒在操作，就直接換成新版（資料在本機，重新載入是瞬間的）
    var hadSW = !!navigator.serviceWorker.controller, t0 = Date.now();
    var updateReady = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadSW) return;
      if (Date.now() - t0 < 10000 && !sheet.open && !dragging && !pager.on) location.reload();
      else updateReady = true;                         // 晚到的新版：下次切到背景時換上，回來就是新版
    });
    document.addEventListener('visibilitychange', function () {
      if (updateReady && document.visibilityState === 'hidden' && !sheet.open) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(function () {});
    ensureCache();
  }
  render({ bottom: true });
  updatePill();
  if (navigator.onLine) startBridge();
  window.__drOK = true;                                              // 告訴 index.html 的保險：程式有正常跑起來
  try { sessionStorage.removeItem('dr.recover'); } catch (e) {}
})();
