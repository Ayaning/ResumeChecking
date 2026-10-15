(function (global) {
  'use strict';

  var KEY_CANDIDATES = 'rds_candidates_v1';
  var KEY_SETTINGS = 'rds_settings_v1';
  var KEY_SCHEDULES = 'rds_schedules_v1';

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
      filePath: (data.filePath || '').trim(),
      fileUrl: (data.fileUrl || '').trim(),
      fileType: (data.fileType || '').trim(),
      fileSize: (data.fileSize === undefined || data.fileSize === null || data.fileSize === '') ? null : Number(data.fileSize),
      fileName: (data.fileName || '').trim(),
      createdAt: data.createdAt || now,
      updatedAt: now
    };
  }

  /* ============ 共享数据层（Supabase） ============
   * 若 js/config.js 填入了 SUPABASE_URL / SUPABASE_ANON_KEY，则所有访问者
   * 共用云端同一份数据；否则回退到 localStorage，保持单机可用。
   */
  var remoteReady = false;
  var stateCache = { candidates: [], settings: { threshold: 70 }, schedules: [] };
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
    try {
      var raw3 = localStorage.getItem(KEY_SCHEDULES);
      if (raw3) {
        var sa = JSON.parse(raw3);
        if (Array.isArray(sa)) stateCache.schedules = sa;
      }
    } catch (e) { console.error(e); }
  }

  function saveLocal() {
    try {
      localStorage.setItem(KEY_CANDIDATES, JSON.stringify(stateCache.candidates));
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(stateCache.settings));
      localStorage.setItem(KEY_SCHEDULES, JSON.stringify(stateCache.schedules));
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
      filePath: r.file_path || '',
      fileUrl: r.file_url || '',
      fileType: r.file_type || '',
      fileSize: (r.file_size === null || r.file_size === undefined) ? null : r.file_size,
      fileName: r.file_name || '',
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
      file_path: c.filePath || null,
      file_url: c.fileUrl || null,
      file_type: c.fileType || null,
      file_size: (c.fileSize === null || c.fileSize === undefined) ? null : c.fileSize,
      file_name: c.fileName || null,
      created_at: c.createdAt,
      updated_at: new Date().toISOString()
    };
  }

  function noop() {}

  /* 将内存中的整份数据同步到云端：更新/新增所有行，删除云端多出来的行 */
  function pushRemote() {
    if (!remoteReady || !client) return;
    var jobs = [];
    var rows = stateCache.candidates.map(appToRow);
    if (rows.length) {
      jobs.push(client.from('candidates').upsert(rows).then(noop, function (e) { console.error('云端保存失败', e); }));
    } else {
      jobs.push(client.from('candidates').delete().neq('id', '').then(noop, function (e) { console.error(e); }));
    }
    try {
      var sRows = stateCache.schedules.map(function (s) {
        return {
          id: s.id,
          seq: s.seq,
          name: s.name || '',
          position: s.position || '',
          time: s.time || '',
          place: s.place || '',
          note: s.note || '',
          created_at: s.createdAt,
          updated_at: s.updatedAt || new Date().toISOString()
        };
      });
      if (sRows.length) {
        jobs.push(client.from('schedules').upsert(sRows).then(noop, function (e) { console.error('云端日程保存失败', e); }));
      } else {
        jobs.push(client.from('schedules').delete().neq('id', '').then(noop, function (e) { console.error(e); }));
      }
    } catch (e) {}
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
      client.from('settings').select('*').eq('id', 1).maybeSingle(),
      client.from('schedules').select('*')
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      remoteReady = true;
      var cands = (r[0].data || []).map(rowToApp);
      var thr = (r[1] && r[1].data && typeof r[1].data.threshold === 'number') ? r[1].data.threshold : 70;
      var sc = [];
      try { if (r[2] && !r[2].error) sc = r[2].data || []; } catch (e) {}
      if (!cands.length && !sc.length) {
        loadLocalInto();
        if (stateCache.candidates.length || stateCache.schedules.length) { saveLocal(); pushRemote(); return true; }
      }
      stateCache.candidates = cands;
      stateCache.settings = { threshold: thr };
      stateCache.schedules = (sc || []).map(function (s) {
        return {
          id: s.id,
          seq: s.seq,
          name: s.name || '',
          position: s.position || '',
          time: s.time || '',
          place: s.place || '',
          note: s.note || '',
          createdAt: s.created_at,
          updatedAt: s.updated_at || s.created_at
        };
      });
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
      client.from('settings').select('*').eq('id', 1).maybeSingle(),
      client.from('schedules').select('*')
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      stateCache.candidates = (r[0].data || []).map(rowToApp);
      var thr = (r[1] && r[1].data && typeof r[1].data.threshold === 'number') ? r[1].data.threshold : stateCache.settings.threshold;
      stateCache.settings = { threshold: thr };
      var sc = [];
      try { if (r[2] && !r[2].error) sc = r[2].data || []; } catch (e) {}
      stateCache.schedules = (sc || []).map(function (s) {
        return {
          id: s.id,
          seq: s.seq,
          name: s.name || '',
          position: s.position || '',
          time: s.time || '',
          place: s.place || '',
          note: s.note || '',
          createdAt: s.created_at,
          updatedAt: s.updated_at || s.created_at
        };
      });
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

  /* ============ 候选人面试安排（本地存储） ============ */
  function newSchedule(data) {
    var now = new Date().toISOString();
    return {
      id: data.id || uid(),
      seq: Number(data.seq) || 0,
      name: (data.name || '').trim(),
      position: (data.position || '').trim(),
      time: data.time || '',
      place: (data.place || '').trim(),
      note: (data.note || '').trim(),
      createdAt: data.createdAt || now,
      updatedAt: now
    };
  }

  function loadSchedules() {
    var out = [];
    var src = stateCache.schedules.length ? stateCache.schedules : [];
    try {
      src.forEach(function (d) { out.push(newSchedule(d)); });
    } catch (e) { }
    if (!out.length) {
      try {
        var raw = localStorage.getItem(KEY_SCHEDULES);
        if (raw) {
          var arr = JSON.parse(raw);
          if (Array.isArray(arr)) out = arr.map(newSchedule);
        }
      } catch (e) { console.error('读取本地面试安排失败', e); }
    }
    return out;
  }

  function saveSchedules(list) {
    (list || []).forEach(function (s, i) { s.seq = i + 1; });
    stateCache.schedules = (list || []).slice();
    saveLocal();
    pushRemote();
    return list;
  }

  /* ============ 原始附件（Supabase Storage） ============ */
  function bucketName() {
    return (global.APP_CONFIG && global.APP_CONFIG.SUPABASE_BUCKET) || 'Resumes';
  }

  /* 依据存储路径取公开访问地址（可在线预览 / 下载） */
  function publicUrl(path) {
    if (!client || !path) return '';
    try {
      var r = client.storage.from(bucketName()).getPublicUrl(path);
      return (r && r.data && r.data.publicUrl) || '';
    } catch (e) { return ''; }
  }

  /* 上传一份原始附件，返回 { path, url }；未接入云端时 reject */
  function uploadResumeFile(path, file) {
    if (!remoteReady || !client) return Promise.reject(new Error('未接入云端存储'));
    return client.storage.from(bucketName()).upload(path, file, {
      upsert: true,
      contentType: (file && file.type) || 'application/octet-stream'
    }).then(function (res) {
      if (res.error) throw res.error;
      return { path: path, url: publicUrl(path) };
    });
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
    newSchedule: newSchedule,
    loadSchedules: loadSchedules,
    saveSchedules: saveSchedules,
    init: init,
    refresh: refresh,
    appendRemote: appendRemote,
    isRemote: isRemote,
    uploadResumeFile: uploadResumeFile,
    publicUrl: publicUrl
  };
})(window);
