(function (global) {
  'use strict';

  var KEY_CANDIDATES = 'rds_candidates_v1';
  var KEY_SETTINGS = 'rds_settings_v1';

  var DEFAULT_STATUS = 'pending';

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* 简历编号：新建时按当前最大值 +1 递增；保存时按列表顺序重排为 1..N */
  var seqCounter = 0;

  function resyncSeq(list) {
    var max = 0;
    (list || []).forEach(function (c) {
      var n = Number(c && c.seq);
      if (n > max) max = n;
    });
    seqCounter = max;
    return seqCounter;
  }

  /* 简历编号自动更新：新增 / 删除简历后，按当前列表顺序把编号重排为 1..N */
  function renumberSeq(list) {
    (list || []).forEach(function (c, i) {
      c.seq = i + 1;
    });
    seqCounter = (list || []).length;
    return list;
  }

  function newCandidate(data) {
    var now = new Date().toISOString();
    var seq = Number(data.seq);
    if (!seq || seq <= 0) {
      seq = ++seqCounter;
    } else if (seq > seqCounter) {
      seqCounter = seq;
    }
    return {
      id: data.id || uid(),   /* 保留既有 id，保证多端数据可合并去重 */
      seq: seq,
      name: (data.name || '').trim(),
      phone: (data.phone || '').trim(),
      email: (data.email || '').trim(),
      position: (data.position || '').trim(),
      source: (data.source || '').trim(),
      rawText: data.rawText || '',
      score: data.score === undefined || data.score === '' ? null : Number(data.score),
      note: data.note || '',
      srcFile: (data.srcFile || '').trim(),
      status: data.status || DEFAULT_STATUS,
      dupFlag: data.dupFlag || '',
      interviews: data.interviews || [],
      createdAt: data.createdAt || now,
      updatedAt: now
    };
  }

  /* ============ 共享数据层（Supabase） ============
   * 若 js/config.js 填入了 SUPABASE_URL / SUPABASE_ANON_KEY，则所有访问者
   * 共用云端同一份数据；否则回退到 localStorage，保持单机可用。
   */
  var remoteReady = false;
  var stateCache = { candidates: [], settings: { threshold: 70 } };
  var client = null;

  function isRemote() { return remoteReady; }

  function dbConfigured() {
    var cfg = global.APP_CONFIG || {};
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      global.supabase && typeof global.supabase.createClient === 'function' &&
      location.protocol !== 'file:');
  }

  function loadLocalInto() {
    try {
      var raw = localStorage.getItem(KEY_CANDIDATES);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) stateCache.candidates = arr;
      }
    } catch (e) { console.error('读取本地候选人数据失败', e); }
    try {
      var raw2 = localStorage.getItem(KEY_SETTINGS);
      if (raw2) {
        var s = JSON.parse(raw2);
        if (s && typeof s.threshold === 'number') stateCache.settings = s;
      }
    } catch (e) { console.error(e); }
  }

  function saveLocal() {
    try {
      localStorage.setItem(KEY_CANDIDATES, JSON.stringify(stateCache.candidates));
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(stateCache.settings));
    } catch (e) { console.error('写入本地数据失败', e); }
  }

  function rowToApp(r) {
    return {
      id: r.id,
      seq: r.seq,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || '',
      position: r.position || '',
      source: r.source || '',
      rawText: r.raw_text || '',
      score: (r.score === null || r.score === undefined) ? null : r.score,
      note: r.note || '',
      srcFile: r.src_file || '',
      status: r.status || DEFAULT_STATUS,
      dupFlag: r.dup_flag || '',
      interviews: r.interviews || [],
      createdAt: r.created_at || new Date().toISOString(),
      updatedAt: r.updated_at || new Date().toISOString()
    };
  }

  function appToRow(c) {
    return {
      id: c.id,
      seq: c.seq,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      position: c.position || '',
      source: c.source || '',
      raw_text: c.rawText || '',
      score: (c.score === null || c.score === undefined) ? null : c.score,
      note: c.note || '',
      src_file: c.srcFile || '',
      status: c.status || DEFAULT_STATUS,
      dup_flag: c.dupFlag || '',
      interviews: c.interviews || [],
      created_at: c.createdAt,
      updated_at: new Date().toISOString()
    };
  }

  function noop() {}

  /* 将内存中的整份数据同步到云端：更新/新增所有行，删除云端多出来的行 */
  function pushRemote() {
    if (!remoteReady || !client) return;
    var rows = stateCache.candidates.map(appToRow);
    var ids = rows.map(function (r) { return r.id; });
    var jobs = [];
    if (rows.length) {
      jobs.push(client.from('candidates').upsert(rows).then(noop, function (e) { console.error('云端保存失败', e); }));
      jobs.push(client.from('candidates').delete()
        .not('id', 'in', '(' + ids.map(function (i) { return '"' + i + '"'; }).join(',') + ')')
        .then(noop, function (e) { console.error('云端删除失败', e); }));
    } else {
      jobs.push(client.from('candidates').delete().neq('id', '').then(noop, function (e) { console.error(e); }));
    }
    jobs.push(client.from('settings').upsert({ id: 1, threshold: stateCache.settings.threshold })
      .then(noop, function (e) { console.error('云端设置保存失败', e); }));
    Promise.all(jobs);
  }

  function fetchCandidates() {
    return client.from('candidates').select('*').then(function (res) {
      if (res.error) throw res.error;
      return (res.data || []).map(rowToApp);
    });
  }

  function fetchThreshold() {
    return client.from('settings').select('threshold').eq('id', 1).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        return (res.data && typeof res.data.threshold === 'number') ? res.data.threshold : 70;
      });
  }

  /* 启动时加载：优先云端（共享），失败则本地 */
  function init() {
    if (!dbConfigured()) { loadLocalInto(); return Promise.resolve(false); }
    try {
      client = global.supabase.createClient(global.APP_CONFIG.SUPABASE_URL, global.APP_CONFIG.SUPABASE_ANON_KEY);
    } catch (e) { console.error('初始化 Supabase 失败', e); loadLocalInto(); return Promise.resolve(false); }

    return Promise.all([
      client.from('candidates').select('*'),
      client.from('settings').select('*').eq('id', 1).maybeSingle()
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      remoteReady = true;
      var cands = (r[0].data || []).map(rowToApp);
      var thr = (r[1].data && typeof r[1].data.threshold === 'number') ? r[1].data.threshold : 70;
      if (!cands.length) {
        /* 云端为空时，把本机历史数据迁移上去，避免开启共享后「数据消失」 */
        loadLocalInto();
        if (stateCache.candidates.length) { saveLocal(); pushRemote(); return true; }
      }
      stateCache.candidates = cands;
      stateCache.settings = { threshold: thr };
      saveLocal();
      return true;
    }).catch(function (e) {
      console.error('读取云端数据失败，回退本地', e);
      loadLocalInto();
      return false;
    });
  }

  /* 重新拉取云端最新数据（上传前 / 切换页签时调用），实现多人数据共用 */
  function refresh() {
    if (!remoteReady || !client) return Promise.resolve(false);
    return Promise.all([
      client.from('candidates').select('*'),
      client.from('settings').select('*').eq('id', 1).maybeSingle()
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      stateCache.candidates = (r[0].data || []).map(rowToApp);
      var thr = (r[1].data && typeof r[1].data.threshold === 'number') ? r[1].data.threshold : stateCache.settings.threshold;
      stateCache.settings = { threshold: thr };
      saveLocal();
      return true;
    }).catch(function (e) { console.error('刷新云端数据失败', e); return false; });
  }

  /* 追加简历（多人同时上传时避免互相覆盖） */
  function appendRemote(items) {
    if (!remoteReady || !client) return Promise.resolve(false);
    var rows = (items || []).map(appToRow);
    if (!rows.length) return Promise.resolve(true);
    return client.from('candidates').upsert(rows)
      .then(function (res) { return !res.error; })
      .catch(function () { return false; });
  }

  function loadCandidates() {
    var out = stateCache.candidates.map(function (d) { return newCandidate(d); });
    resyncSeq(out);
    renumberSeq(out);
    stateCache.candidates = out;
    return out;
  }

  function saveCandidates(list) {
    stateCache.candidates = list;
    saveLocal();
    pushRemote();
    return list;
  }

  function loadSettings() {
    var base = { threshold: 70 };
    var s = stateCache.settings;
    if (s && typeof s.threshold === 'number') base.threshold = s.threshold;
    return base;
  }

  function saveSettings(s) {
    stateCache.settings = s;
    saveLocal();
    pushRemote();
    return s;
  }

  function storageSize() {
    var t = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k) t += localStorage.getItem(k).length;
      }
    } catch (e) { /* ignore */ }
    return (t / 1024).toFixed(1);
  }

  global.Store = {
    newCandidate: newCandidate,
    resyncSeq: resyncSeq,
    renumberSeq: renumberSeq,
    loadCandidates: loadCandidates,
    saveCandidates: saveCandidates,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    storageSize: storageSize,
    uid: uid,
    init: init,
    refresh: refresh,
    appendRemote: appendRemote,
    isRemote: isRemote
  };
})(window);
