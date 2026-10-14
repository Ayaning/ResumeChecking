(function () {
  'use strict';

  /* 筛选流程状态：待筛选 → 简历不通过 / 待一面 → 待二面 → 面试不通过 / 待录用 */
  var STATUS = [
    { key: 'pending', label: '待筛选', color: '#8a94a6' },
    { key: 'resume_fail', label: '简历不通过', color: '#e67e22' },
    { key: 'to_interview1', label: '待一面', color: '#3a7bd5' },
    { key: 'to_interview2', label: '待二面', color: '#9b59b6' },
    { key: 'interview_fail', label: '面试不通过', color: '#c0392b' },
    { key: 'to_hire', label: '待录用', color: '#16a085' }
  ];

  /* 历史状态键 → 新状态键，保证旧数据、示例数据与已改过的记录不失效 */
  var STATUS_MIGRATE = {
    pending: 'pending',
    resume_fail: 'resume_fail',
    to_interview1: 'to_interview1',
    to_interview2: 'to_interview2',
    interview_fail: 'interview_fail',
    to_hire: 'to_hire',
    /* 旧版「简历通过」这一档已取消，就近归到简历不通过 */
    resume_pass: 'resume_fail',
    screening: 'resume_fail',
    screen_pass: 'resume_fail',
    screen_reject: 'resume_fail',
    interview1: 'to_interview1',
    interview2: 'to_interview2',
    interview_pending: 'to_interview1',
    interviewing: 'to_interview1',
    fail: 'interview_fail',
    rejected: 'interview_fail',
    hired: 'to_hire'
  };
  function normalizeStatus(key) {
    return STATUS_MIGRATE[key] || 'pending';
  }
  var STATUS_LABEL_BY_KEY = {};
  STATUS.forEach(function (s) { STATUS_LABEL_BY_KEY[s.key] = s.label; });
  var RESULT_LABEL = { pass: '通过', hold: '待定', fail: '不通过', hire: '录用' };

  /* 备注长度上限，表格内编辑框与录入弹窗共用 */
  var NOTE_MAX = 500;

  /* 应聘岗位可选项：表格编辑、录入表单、普通用户上传共用同一份 */
  var POSITIONS = ['功能测试', '自动化测试', 'AI测试', '前端开发', '后端开发'];

  /* 面试职位可选项（面试安排） */
  var SCHEDULE_POSITIONS = ['自动化', 'AI测试', '功能', '前端', '后端', '实习生'];

  /* 账号体系：管理员可查看全部功能；普通用户登录后仅可使用「上传简历」 */
  var ACCOUNTS = {
    admin: { pass: '2610', role: 'admin', label: '管理员' },
    user: { pass: '000', role: 'user', label: '普通用户' }
  };
  var SESSION_KEY = 'rds_session_v1';
  var session = null;

  /* 导入时把「原始文件：xxx」从备注里拆出，避免用户写备注时覆盖来源路径 */
  function splitProvenance(c) {
    if (c.srcFile) return false;
    var m = String(c.note || '').match(/^原始文件[：:]\s*([\s\S]+)$/);
    if (!m) return false;
    c.srcFile = m[1].trim();
    c.note = '';
    return true;
  }

  var state = {
    candidates: [],
    txtIdx: null,
    settings: Store.loadSettings(),
    schedules: Store.loadSchedules(),
    dup: [],          // [{a, b, sim, hits, isDup, sameName, sameContact}]
    dupCids: new Set(), // ids involved in a dup pair
    sortKey: '',      // '' | 'date'
    sortDir: 0        // 1 升序, -1 降序
  };

  var editingId = null;
  var scheduleEditingId = null;
  var scheduleSort = { key: 'seq', dir: 1 };   /* key: 'seq' | 'time'；dir: 1 升序, -1 降序 */
  var ivCandidateId = null;
  var reportCandidateId = null;
  var ndTimer = null;   // 录入弹窗实时查重防抖
  var thTimer = null;   // 阈值变更重算防抖

  /* ================= 基础工具 ================= */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  /* 高亮命中的关键词：先转义 HTML，再按关键词包 <mark> */
  function hl(text, terms) {
    var s = esc(text);
    if (!terms || !terms.length) return s;
    var re = new RegExp('(' + terms.map(escapeReg).join('|') + ')', 'gi');
    return s.replace(re, '<mark class="hl">$1</mark>');
  }
  function fmtDate(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function dateVal(c) {
    var t = Date.parse((c && c.createdAt) || '');
    return isNaN(t) ? 0 : t;
  }
  function statusInfo(key) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].key === key) return STATUS[i];
    return STATUS[0];
  }
  /* 表格内直接改状态的下拉框 */
  function statusSelectHtml(c) {
    var cur = normalizeStatus(c.status);
    var opts = STATUS.map(function (s) {
      return '<option value="' + s.key + '"' + (s.key === cur ? ' selected' : '') + '>' + s.label + '</option>';
    }).join('');
    return '<select class="input select status-select" data-act="status" data-id="' + c.id + '" ' +
      'style="border-left:3px solid ' + statusInfo(cur).color + '">' + opts + '</select>';
  }

  /* 应聘岗位下拉：表格内联编辑、录入表单共用。旧值不在预设列表时保留，避免数据丢失 */
  function positionOptionsHtml(cur) {
    var list = POSITIONS.slice();
    if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    return ['<option value="">未填写</option>'].concat(list.map(function (p) {
      return '<option value="' + esc(p) + '"' + (p === cur ? ' selected' : '') + '>' + esc(p) + '</option>';
    })).join('');
  }
  function positionSelectHtml(c) {
    return '<select class="input select position-select" data-act="position" data-id="' + c.id + '">' +
      positionOptionsHtml(c.position || '') + '</select>';
  }

  /* 面试职位下拉：表格内联编辑、弹窗共用。旧值不在预设列表时保留，避免数据丢失 */
  function schedulePositionOptionsHtml(cur) {
    var list = SCHEDULE_POSITIONS.slice();
    if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    return ['<option value="">未填写</option>'].concat(list.map(function (p) {
      return '<option value="' + esc(p) + '"' + (p === cur ? ' selected' : '') + '>' + esc(p) + '</option>';
    })).join('');
  }

  /* 备注单元格：可编辑，最多 500 字，显示已填字数 */
  function noteCellHtml(c) {
    return '<textarea class="input note-input" data-act="note" data-id="' + c.id + '" rows="2" ' +
      'maxlength="' + NOTE_MAX + '" placeholder="添加备注…">' + esc(c.note || '') + '</textarea>' +
      '<span class="note-count"></span>';
  }

  function refreshNoteCount(ta) {
    var box = ta.closest('td');
    if (!box) return;
    var n = ta.value.length;
    var tip = box.querySelector('.note-count');
    if (tip) tip.textContent = n ? n + '/' + NOTE_MAX : '';
    ta.style.borderColor = n >= NOTE_MAX ? '#c0392b' : '';
  }
  function shortName(c) {
    var n = (c.name || '').trim();
    return n || '未命名';
  }
  function findCand(id) {
    for (var i = 0; i < state.candidates.length; i++) {
      if (state.candidates[i].id === id) return state.candidates[i];
    }
    return null;
  }
  function isUser() {
    return !!(session && session.role === 'user');
  }
  function persist() {
    Store.renumberSeq(state.candidates);
    Store.saveCandidates(state.candidates);
    $('#data-size').textContent = Store.storageSize() + ' KB';
  }

  /* ================= 查重桥接 ================= */
  // 简历正文索引缓存：分词只做一次，O(n^2) 两两比对与实时查重共用
  function invalidateTextIdx() {
    state.txtIdx = null;
  }
  function ensureTextIdx() {
    if (state.txtIdx && state.txtIdx.n === state.candidates.length) return state.txtIdx;
    var m = new Map(), t = new Map();
    state.candidates.forEach(function (c) {
      m.set(c.id, Sim.makeIndex(c.rawText));
      t.set(c.id, Sim.contactTokens(contactOf(c)));
    });
    state.txtIdx = { n: state.candidates.length, text: m, contact: t };
    return state.txtIdx;
  }
  function contactOf(c) {
    return (c.phone || '') + ' ' + (c.email || '');
  }
  /* 只接受候选人本身：既可作为 map 回调，也可用显式缓存构造。
   * 多余实参（map 的 index/array）必须忽略，否则联系人令牌会被污染。 */
  function toProbeInput(c) {
    var cache = ensureTextIdx();
    var idx = cache.text.get(c.id);
    var contacts = cache.contact.get(c.id);
    if (!contacts || !Array.isArray(contacts.phones)) contacts = Sim.contactTokens(contactOf(c));
    if (!idx || !idx.map) idx = null;
    return { id: c.id, name: c.name, contact: contactOf(c), text: c.rawText, index: idx, contacts: contacts };
  }
  function levelClass(level) {
    return 'nd-pill nd-' + level;
  }
  function sameContactOf(a, b) {
    var ta = Sim.contactTokens(contactOf(a));
    var tb = Sim.contactTokens(contactOf(b));
    for (var i = 0; i < ta.phones.length; i++) if (tb.phones.indexOf(ta.phones[i]) >= 0) return true;
    for (var j = 0; j < ta.emails.length; j++) if (tb.emails.indexOf(ta.emails[j]) >= 0) return true;
    return false;
  }
  function sameContactCached(ta, tb) {
    for (var i = 0; i < ta.phones.length; i++) if (tb.phones.indexOf(ta.phones[i]) >= 0) return true;
    for (var j = 0; j < ta.emails.length; j++) if (tb.emails.indexOf(ta.emails[j]) >= 0) return true;
    return false;
  }
  function queryDup(name, phone, text, excludeId) {
    if (!state.candidates.length) return [];
    if (!name && !phone && !text) return [];
    var probe = Sim.makeProbe(name, phone, text);
    var list = state.candidates.map(function (c) { return toProbeInput(c); });
    return Sim.checkDuplicate(probe, list, state.settings.threshold, excludeId);
  }

  /* ================= 标签页 ================= */
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });

    /* 管理员切页时拉取服务器最新数据，看到其他人新上传的简历 */
    if (session && session.role === 'admin' && Store.isRemote()) {
      Store.refresh().then(function (ok) {
        if (!ok) return;
        state.candidates = Store.loadCandidates();
        state.settings = Store.loadSettings();
        invalidateTextIdx();
        refreshDup();
      });
      return;
    }

    if (name === 'schedule') renderScheduleTable();
    if (name === 'tracking') renderKanban();
  }

  /* ================= 简历库 ================= */
  function renderStatusFilterRow() {
    var row = $('#status-filter-row');
    if (!row) return;
    var cur = $('#status-filter').value;
    var counts = {};
    var total = 0;
    state.candidates.forEach(function (c) {
      var k = normalizeStatus(c.status);
      counts[k] = (counts[k] || 0) + 1;
      total++;
    });

    var chips = ['<button class="chip' + (!cur ? ' active' : '') + '" data-status="">全部 ' + total + '</button>'];
    STATUS.forEach(function (s) {
      chips.push('<button class="chip' + (cur === s.key ? ' active' : '') + '" data-status="' + s.key + '">' +
        esc(s.label) + ' ' + (counts[s.key] || 0) + '</button>');
    });
    row.innerHTML = chips.join('');

    row.querySelectorAll('.chip').forEach(function (btn) {
      btn.onclick = function () {
        var key = btn.dataset.status;
        $('#status-filter').value = key;
        renderStatusFilterRow();
        renderResumeTable();
      };
    });
  }

  function renderResumeTable() {
    renderStatusFilterRow();
    var tbody = $('#resume-tbody');
    var empty = $('#resume-empty');
    var kwRaw = ($('#search-box').value || '').trim();
    var scopeEl = $('#search-scope');
    var scope = scopeEl ? scopeEl.value : 'name';
    var terms = kwRaw ? kwRaw.toLowerCase().split(/\s+/).filter(Boolean) : [];
    var stFilter = $('#status-filter').value;
    var df = $('#dup-filter').value;

    /* 按“搜索范围”取字段；支持多个关键词（空格分隔，需全部命中） */
    function searchField(c) {
      switch (scope) {
        case 'phone': return (c.phone || '') + ' ' + (c.email || '');
        case 'position': return c.position || '';
        case 'source': return c.source || '';
        case 'text': return c.rawText || '';
        case 'all': return [c.name, c.phone, c.email, c.position, c.source, c.rawText, c.note].join(' ');
        default: return c.name || '';
      }
    }

    var list = state.candidates.filter(function (c) {
      if (stFilter && c.status !== stFilter) return false;
      if (df === 'dup' && !state.dupCids.has(c.id)) return false;
      if (df === 'clean' && state.dupCids.has(c.id)) return false;
      if (terms.length) {
        var hay = searchField(c).toLowerCase();
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      }
      return true;
    });

    /* 按上传日期排序 */
    if (state.sortKey === 'date') {
      list.sort(function (a, b) {
        var da = dateVal(a), db = dateVal(b);
        return state.sortDir === -1 ? db - da : da - db;
      });
    }
    var indEl = $('#sort-ind-date');
    if (indEl) indEl.textContent = state.sortKey === 'date' ? (state.sortDir === -1 ? '▼' : '▲') : '↕';

    $('#total-count').textContent = state.candidates.length;
    empty.hidden = list.length > 0;
    tbody.innerHTML = '';

    list.forEach(function (c) {
      var isDup = state.dupCids.has(c.id);
      var nameHit = terms.length && terms.some(function (t) { return (c.name || '').toLowerCase().indexOf(t) >= 0; });
      var tr = document.createElement('tr');
      tr.innerHTML = [
        '<td class="col-seq">' + (c.seq || '-') + '</td>',
        '<td><div class="cell-main"><input class="input name-input' + (nameHit ? ' name-hit' : '') + '" data-act="name" data-id="' + c.id + '" value="' + esc(c.name || '') + '" placeholder="未命名">' +
          (isDup ? ' <span class="pill dup-pill">疑似重复</span>' : '') + '</div>' +
          '<div class="cell-sub">' + hl(c.source, terms) + '</div></td>',
        '<td>' + positionSelectHtml(c) + '</td>',
        '<td>' + (hl(c.phone, terms) || hl(c.email, terms) || '-') + '</td>',
        '<td class="col-date">' + fmtDate(c.createdAt) + '</td>',
        '<td>' + statusSelectHtml(c) + '</td>',
        '<td class="col-note">' + noteCellHtml(c) + '</td>',
        '<td class="row-actions">' +
          '<button class="btn sm" data-act="view" data-id="' + c.id + '">完整简历</button>' +
          '<button class="btn sm danger" data-act="del" data-id="' + c.id + '">删除</button>' +
        '</td>'
      ].join('');
      tbody.appendChild(tr);
    });

    if (list.length) {
      addActions(tbody, function (act, id) {
        var c = findCand(id);
        if (!c) return;
        if (act === 'view') openResumeInfo(c);
        if (act === 'del') {
          if (confirm('确定删除「' + shortName(c) + '」的简历？')) {
            state.candidates = state.candidates.filter(function (x) { return x.id !== id; });
            refreshDup();
          }
        }
      });
    }
  }

  function addActions(container, handler) {
    container.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        handler(btn.dataset.act, btn.dataset.id);
      };
    });
    container.querySelectorAll('select[data-act="status"]').forEach(function (sel) {
      sel.onchange = function () { setStatus(sel.dataset.id, sel.value); };
    });
    container.querySelectorAll('select[data-act="position"]').forEach(function (sel) {
      sel.onchange = function () { setPosition(sel.dataset.id, sel.value); };
    });
    container.querySelectorAll('textarea[data-act="note"]').forEach(function (ta) {
      refreshNoteCount(ta);
      var original = ta.value;
      var save = function () {
        var val = ta.value.slice(0, NOTE_MAX);
        if (val === original) { refreshNoteCount(ta); return; }
        setNote(ta.dataset.id, val);
        original = val;
        refreshNoteCount(ta);
      };
      ta.addEventListener('input', function () { refreshNoteCount(ta); });
      ta.addEventListener('blur', save);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
        if (e.key === 'Escape') { ta.value = original; refreshNoteCount(ta); ta.blur(); }
      });
    });

    container.querySelectorAll('input[data-act="name"]').forEach(function (inp) {
      var original = inp.value;
      var save = function () {
        var val = inp.value;
        if (val === original) return;
        if (!val.trim()) { alert('姓名不能为空。'); inp.value = original; return; }
        setName(inp.dataset.id, val);
      };
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = original; inp.blur(); }
      });
    });
  }

  function setNote(id, val) {
    var c = findCand(id);
    if (!c) return;
    c.note = val;
    c.updatedAt = new Date().toISOString();
    persist();
  }

  function setStatus(id, key) {
    var c = findCand(id);
    if (!c) return;
    var next = normalizeStatus(key);
    if (c.status === next) return;
    c.status = next;
    c.updatedAt = new Date().toISOString();
    persist();
    /* 状态变了，重复判定与评分不受影响，只需重绘受影响的视图 */
    renderResumeTable();
    var board = $('#kanban');
    if (board) renderKanban();
  }

  function setName(id, val) {
    var c = findCand(id);
    if (!c) return;
    val = String(val || '').trim().slice(0, 40);
    if (c.name === val) return;
    c.name = val;
    c.updatedAt = new Date().toISOString();
    refreshDup();
  }

  function setPosition(id, val) {
    var c = findCand(id);
    if (!c) return;
    val = String(val || '').trim();
    if (c.position === val) return;
    c.position = val;
    c.updatedAt = new Date().toISOString();
    persist();
    renderResumeTable();
  }

  function openResumeModal(c) {
    editingId = c ? c.id : null;
    $('#resume-modal').hidden = false;
    $('#resume-modal-title').textContent = c ? '编辑简历 - ' + shortName(c) : '录入简历';
    $('#f-name').value = c ? c.name : '';
    $('#f-phone').value = c ? c.phone : '';
    $('#f-position').innerHTML = positionOptionsHtml(c ? (c.position || '') : '');
    $('#f-position').value = c ? (c.position || '') : '';
    $('#f-source').value = c ? c.source : '';
    $('#f-text').value = c ? c.rawText : '';
    $('#f-score').value = c && c.score != null ? c.score : '';
    $('#f-note').value = c ? c.note : '';
    hideNameDupBox();
    $('#f-name').focus();
    if (editingId) renderNameDupBox();
  }

  /* ================= 录入弹窗：姓名实时查重 ================= */
  function showNameDupBox(html, cls) {
    var cell = $('#name-dup-cell'), box = $('#name-dup-box');
    cell.hidden = false;
    box.hidden = false;
    box.className = cls || 'name-dup';
    box.innerHTML = html;
  }

  function hideNameDupBox() {
    var cell = $('#name-dup-cell'), box = $('#name-dup-box');
    cell.hidden = true;
    box.hidden = true;
    box.className = 'name-dup';
    box.innerHTML = '';
  }

  function scheduleNameDup() {
    if (ndTimer) clearTimeout(ndTimer);
    ndTimer = setTimeout(renderNameDupBox, 180);
  }

  function renderNameDupBox() {
    var box = $('#name-dup-box');
    if (!box) return;
    var name = $('#f-name').value.trim();
    var phone = $('#f-phone').value.trim();
    var text = $('#f-text').value;

    if (!name && !phone && !text) { hideNameDupBox(); return; }
    if (!state.candidates.length) {
      showNameDupBox('<div class="nd-head">简历库暂无历史记录，无需查重。</div>', 'name-dup ok');
      return;
    }

    var hits = queryDup(name, phone, text, editingId);

    if (!hits.length) {
      showNameDupBox(
        '<div class="nd-head">查重通过：未发现与历史简历重复</div>' +
        '<div class="hint">已比对 ' + state.candidates.length + ' 条历史记录（姓名 / 手机号 / 邮箱 / 正文相似度 ≥ ' + state.settings.threshold + '%）。</div>',
        'name-dup ok');
      return;
    }

    var html = ['<div class="nd-head">发现 ' + hits.length + ' 条可能重复的历史简历</div>', '<ul class="nd-list">'];
    hits.slice(0, 6).forEach(function (h) {
      var c = findCand(h.id);
      if (!c) return;
      html.push(
        '<li class="nd-item">' +
          '<span class="pill ' + levelClass(h.level) + '">' + esc(h.label) + '</span>' +
          '<div class="nd-main">' +
            '<div class="cell-main">' + esc(shortName(c)) +
              (c.position ? ' <span class="cell-sub">' + esc(c.position) + '</span>' : '') +
              (h.sim ? ' <span class="nd-sim">正文 ' + h.sim + '%</span>' : '') +
            '</div>' +
            '<div class="cell-sub">命中：' + esc(h.reasons.join(' · ')) + '</div>' +
            '<div class="cell-sub">来源 ' + esc(c.source || '-') + ' · 状态 ' + esc(statusInfo(c.status).label) + ' · 录入 ' + fmtDate(c.createdAt) + (c.srcFile ? ' · 原始文件 ' + esc(c.srcFile) : '') + '</div>' +
          '</div>' +
          '<div class="nd-actions">' +
            '<button class="btn sm" data-nd="cmp" data-id="' + c.id + '">对比正文</button>' +
            '<button class="btn sm" data-nd="open" data-id="' + c.id + '">查看</button>' +
          '</div>' +
        '</li>');
    });
    html.push('</ul>');
    if (hits.length > 6) html.push('<div class="hint">另有 ' + (hits.length - 6) + ' 条较弱匹配，保存后点击列表中的「查重」查看全部。</div>');
    showNameDupBox(html.join(''), 'name-dup hit');

    box.querySelectorAll('button[data-nd]').forEach(function (btn) {
      btn.onclick = function () {
        var c = findCand(btn.dataset.id);
        if (!c) return;
        if (btn.dataset.nd === 'open') { openResumeInfo(c); return; }
        var probeText = Sim.clean(text) || c.rawText;
        showComparison({
          title: (name || '新简历') + ' ⬌ ' + shortName(c) + ' 相似内容对比',
          banner: '整体相似度 <b>' + Sim.similarity(probeText, c.rawText) + '%</b>（阈值 ' + state.settings.threshold +
            '%） · 共享完整片段 <b>' + Sim.sharedSentences(probeText, c.rawText).length + '</b> 处',
          nameA: name || '新简历', textA: probeText,
          nameB: shortName(c), textB: c.rawText
        });
      };
    });
  }

  /* ================= 查重（全量两两） ================= */
  function runDuplicates() {
    var list = state.candidates;
    var out = [];
    var dupCids = new Set();
    var th = state.settings.threshold;

    // 逐封预计算 n-gram 索引：O(n^2) 比对中复用，避免重复分词
    var cache = ensureTextIdx();
    var idxMap = cache.text;
    var contactMap = cache.contact;
    var nameMap = new Map();
    var i, j, c;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      nameMap.set(c.id, Sim.normalizeName(c.name));
    }

    for (i = 0; i < list.length; i++) {
      for (j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        var na = nameMap.get(a.id), nb = nameMap.get(b.id);
        var sameName = !!na && na === nb;
        var sameContact = sameContactCached(contactMap.get(a.id), contactMap.get(b.id));
        var sim = 0, hits = [];
        var ia = idxMap.get(a.id), ib = idxMap.get(b.id);
        if (ia.norm && ib.norm) {
          sim = Sim.similarityIdx(ia, ib);
          hits = Sim.sharedSentencesIdx(ia, ib);
        }
        // 正文达标且（有整句重复 或 相似度极高）→ 疑似重复；同名 / 同联系方式一律命中
        var isDup = sameName || sameContact || (a.rawText && b.rawText && sim >= th && (hits.length > 0 || sim >= 92));
        if (isDup) { dupCids.add(a.id); dupCids.add(b.id); }
        out.push({ a: a, b: b, sim: sim, hits: hits, isDup: isDup, sameName: sameName, sameContact: sameContact });
      }
    }
    out.sort(function (x, y) { return (y.isDup - x.isDup) || (y.sim - x.sim); });
    state.dup = out;
    state.dupCids = dupCids;
    persist();
    renderAll();
  }

  // 数据变更后同步刷新查重结果，避免标记过期
  function refreshDup() {
    invalidateTextIdx();
    if (state.candidates.length >= 2) {
      runDuplicates();
    } else {
      state.dup = [];
      state.dupCids = new Set();
      persist();
      renderAll();
    }
  }

  /* ================= 相似内容对比弹窗 ================= */
  function showComparison(o) {
    var modal = $('#dup-detail-modal');
    modal.hidden = false;
    $('#dup-detail-title').textContent = o.title;
    $('#dup-detail-score').innerHTML = o.banner;
    var hd = Sim.highlightDiff(o.nameB || '', o.textA, o.textB);
    $('#dup-left-name').textContent = o.nameA;
    $('#dup-right-name').textContent = o.nameB || '';
    $('#dup-left-text').innerHTML = hd.htmlA;
    $('#dup-right-text').innerHTML = hd.htmlB;
    modal.querySelector('.modal-body').classList.toggle('has-dup', !!o.hasDup);
  }

  function openDupDetail(pair) {
    showComparison({
      title: shortName(pair.a) + ' ⬌ ' + shortName(pair.b) + ' 相似内容对比',
      banner: '整体相似度 <b>' + pair.sim + '%</b>（阈值 ' + state.settings.threshold + '%） · ' +
        '共享完整片段 <b>' + pair.hits.length + '</b> 处 · 结论：' +
        (pair.isDup ? '<span class="pill dup-pill">疑似重复</span>' : '<span class="pill ok-pill">正常</span>'),
      nameA: shortName(pair.a), textA: pair.a.rawText,
      nameB: shortName(pair.b), textB: pair.b.rawText,
      hasDup: pair.isDup
    });
  }

  /* ================= 完整简历信息弹窗 ================= */
  function infoItem(label, value, cls) {
    return '<div class="info-item' + (cls ? ' ' + cls : '') + '">' +
      '<div class="info-label">' + esc(label) + '</div>' +
      '<div class="info-value">' + value + '</div></div>';
  }

  function openResumeInfo(c) {
    if (!c) return;
    $('#resume-info-title').textContent = '完整简历 - ' + shortName(c);

    var meta = '';
    meta += infoItem('编号', c.seq != null ? esc(String(c.seq)) : '-');
    meta += infoItem('姓名', esc(shortName(c)));
    meta += infoItem('状态', esc(statusInfo(c.status).label));
    meta += infoItem('来源', c.source ? '<b>' + esc(c.source) + '</b>' : '-', 'src');
    meta += infoItem('原始文件', esc(c.srcFile || '-'));
    meta += infoItem('疑似重复', state.dupCids.has(c.id) ? '<b>是</b>' : '否');
    meta += infoItem('电话', esc(c.phone || '-'));
    meta += infoItem('邮箱', esc(c.email || '-'));
    meta += infoItem('应聘岗位', esc(c.position || '-'));
    meta += infoItem('评分', c.score != null ? esc(String(c.score)) : '-');
    var ivs = c.interviews || [];
    var ivLabel = ivs.length
      ? String(ivs.length) + ' 轮' + (RESULT_LABEL[ivs[ivs.length - 1].result] ? ' · 最近：' + esc(RESULT_LABEL[ivs[ivs.length - 1].result]) : '')
      : '无';
    meta += infoItem('面试记录', esc(ivLabel));
    meta += infoItem('录入时间', esc(fmtDate(c.createdAt)));
    meta += infoItem('更新时间', esc(fmtDate(c.updatedAt)));
    if (c.note) meta += infoItem('备注', esc(c.note), 'full');
    $('#resume-info-meta').innerHTML = meta;

    renderOriginalFile(c);
    $('#resume-info-text').textContent = c.rawText || '（暂无正文内容）';
    $('#resume-info-modal').hidden = false;
  }

  /* 在线预览 + 下载原始附件；历史数据无原件时提供解析文本下载 */
  function renderOriginalFile(c) {
    var box = $('#resume-info-original');
    if (!box) return;
    var url = c.fileUrl || (c.filePath ? Store.publicUrl(c.filePath) : '');
    var html = '<div class="divider"><span>原始附件</span></div>';

    if (!url) {
      html += '<p class="muted">该记录没有原始附件（历史数据仅保留解析文本）。</p>' +
        '<div class="file-actions"><button class="btn sm" id="resume-info-dltext">下载解析文本 (.txt)</button></div>';
      box.innerHTML = html;
      var b = $('#resume-info-dltext');
      if (b) b.onclick = function () { downloadResumeText(c); };
      return;
    }

    var name = c.fileName || c.srcFile || url.split('/').pop();
    var ext = fileExtOf(name);
    var type = (c.fileType || fileMime(name) || '').toLowerCase();
    var dl = url + (url.indexOf('?') < 0 ? '?' : '&') + 'download';
    var size = (c.fileSize != null) ? ' · ' + fmtSize(c.fileSize) : '';

    html += '<div class="file-actions">' +
      '<a class="btn sm" href="' + esc(url) + '" target="_blank" rel="noopener">在新窗口打开</a>' +
      '<a class="btn sm primary" href="' + esc(dl) + '" download="' + esc(name) + '">下载原件</a>' +
      '<span class="muted file-name">' + esc(name) + size + '</span>' +
      '</div>';

    if (ext === 'pdf' || type === 'application/pdf') {
      html += '<iframe class="file-viewer" src="' + esc(url) + '" loading="lazy" title="原件预览"></iframe>';
    } else if (type.indexOf('image/') === 0 || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0) {
      html += '<img class="file-img" src="' + esc(url) + '" alt="原始附件">';
    } else if (ext === 'txt' || type === 'text/plain') {
      html += '<pre class="file-txt" id="resume-file-text">加载中…</pre>';
    } else if (ext === 'doc' || ext === 'docx') {
      html += '<iframe class="file-viewer" src="https://view.officeapps.live.com/op/embed.aspx?src=' +
        encodeURIComponent(url) + '"></iframe>';
    } else {
      html += '<p class="muted">该格式暂不支持在线预览，请点击「下载原件」查看。</p>';
    }

    box.innerHTML = html;

    var pre = $('#resume-info-filetext');
    if (pre) {
      fetch(url).then(function (r) { return r.text(); })
        .then(function (t) { pre.textContent = t || '（空文件）'; })
        .catch(function () { pre.textContent = '加载失败，请点击「下载原件」查看。'; });
    }
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function downloadResumeText(c) {
    var blob = new Blob([c.rawText || ''], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (shortName(c) || 'resume') + '_解析文本.txt';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* ================= 单份简历查重报告 ================= */
  function openCandDupReport(id) {
    var c = findCand(id);
    if (!c) return;
    reportCandidateId = id;
    $('#cand-dup-modal').hidden = false;
    $('#cand-dup-title').textContent = '简历查重报告 - ' + shortName(c);
    renderCandDupReport();
  }

  function renderCandDupReport() {
    var c = findCand(reportCandidateId);
    if (!c) return;
    var probe = Sim.makeProbe(c.name, contactOf(c), c.rawText);
    var others = state.candidates.filter(function (x) { return x.id !== c.id; });
    var hits = Sim.checkDuplicate(probe, others.map(toProbeInput), state.settings.threshold);
    var onlyHit = $('#cand-dup-onlyhit').checked;

    var hitMap = {};
    hits.forEach(function (h) { hitMap[h.id] = h; });

    var rows = hits.map(function (h) { return { other: findCand(h.id), hit: h }; }).filter(function (r) { return r.other; });
    if (!onlyHit) {
      others.forEach(function (o) {
        if (hitMap[o.id]) return;
        rows.push({ other: o, hit: null, sim: c.rawText && o.rawText ? Sim.similarity(c.rawText, o.rawText) : 0 });
      });
      rows.sort(function (x, y) {
        var rx = x.hit ? x.hit.rank : 0, ry = y.hit ? y.hit.rank : 0;
        if (rx !== ry) return ry - rx;
        return (y.hit ? y.hit.sim : y.sim) - (x.hit ? x.hit.sim : x.sim);
      });
    }

    var bestSim = 0;
    rows.forEach(function (r) {
      var s = r.hit ? r.hit.sim : (r.sim || 0);
      if (s > bestSim) bestSim = s;
    });
    var top = hits[0];
    $('#cand-dup-banner').innerHTML =
      '与简历库 <b>' + others.length + '</b> 封简历比对 · 命中 <b>' + hits.length + '</b> 条 · 最高正文相似度 <b>' + bestSim + '%</b> · 结论：' +
      (top ? '<span class="pill ' + levelClass(top.level) + '">' + esc(top.label) + '</span>' : '<span class="pill ok-pill">未发现重复</span>');

    var body = $('#cand-dup-body');
    if (!rows.length) {
      body.innerHTML = '<div class="empty">简历库中暂无其他简历可对比。</div>';
      return;
    }
    body.innerHTML = '<ul class="nd-list">' + rows.map(function (r) {
      var o = r.other;
      var sim = r.hit ? r.hit.sim : (r.sim || 0);
      var badge = r.hit
        ? '<span class="pill ' + levelClass(r.hit.level) + '">' + esc(r.hit.label) + '</span>'
        : '<span class="pill ok-pill">正常</span>';
      return '<li class="nd-item">' +
        badge +
        '<div class="nd-main">' +
          '<div class="cell-main">' + esc(shortName(o)) +
            (o.position ? ' <span class="cell-sub">' + esc(o.position) + '</span>' : '') +
            (sim ? ' <span class="nd-sim">正文 ' + sim + '%</span>' : '') +
          '</div>' +
          '<div class="cell-sub">' + esc(r.hit ? '命中：' + r.hit.reasons.join(' · ') : '无姓名 / 联系方式命中，正文相似度未达阈值') + '</div>' +
          '<div class="cell-sub">来源 ' + esc(o.source || '-') + ' · 状态 ' + esc(statusInfo(o.status).label) + ' · 录入 ' + fmtDate(o.createdAt) + (o.srcFile ? ' · 原始文件 ' + esc(o.srcFile) : '') + '</div>' +
        '</div>' +
        '<div class="nd-actions">' +
          (c.rawText && o.rawText ? '<button class="btn sm" data-cmp="' + o.id + '">对比正文</button>' : '') +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';

    body.querySelectorAll('button[data-cmp]').forEach(function (btn) {
      btn.onclick = function () {
        var o = findCand(btn.dataset.cmp);
        if (!o) return;
        openDupDetail({ a: c, b: o, sim: Sim.similarity(c.rawText, o.rawText), hits: Sim.sharedSentences(c.rawText, o.rawText), isDup: state.dupCids.has(c.id) && state.dupCids.has(o.id) });
      };
    });
  }

  /* ================= 筛选与面试看板 ================= */
  function renderKanban() {
    var board = $('#kanban');
    board.innerHTML = '';
    STATUS.forEach(function (st) {
      var col = document.createElement('div');
      col.className = 'kanban-col';
      var items = state.candidates.filter(function (c) { return c.status === st.key; });
      var head = document.createElement('div');
      head.className = 'kanban-head';
      head.style.borderColor = st.color;
      head.innerHTML = '<span class="kanban-dot" style="background:' + st.color + '"></span>' +
        '<b>' + st.label + '</b><span class="kanban-count">' + items.length + '</span>';
      col.appendChild(head);

      var empty = document.createElement('div');
      empty.className = 'kanban-empty';
      empty.textContent = '暂无';
      empty.hidden = items.length > 0;
      col.appendChild(empty);

      items.forEach(function (c) {
        var isDup = state.dupCids.has(c.id);
        var card = document.createElement('div');
        card.className = 'kanban-card' + (isDup ? ' dup-card' : '');
        var lastIv = c.interviews.length ? c.interviews[c.interviews.length - 1] : null;
        card.innerHTML =
          '<div class="k-name">' + esc(shortName(c)) + (isDup ? ' <span class="pill dup-pill">重复</span>' : '') + '</div>' +
          '<div class="k-sub">' + (esc(c.position) || '岗位未填') + (c.score != null ? ' · 评分 <b>' + c.score + '</b>' : '') + '</div>' +
          '<div class="k-sub">' + (esc(c.phone) || '') + '</div>' +
          (lastIv ? '<div class="k-last">上轮：' + esc(RESULT_LABEL[lastIv.result] || lastIv.result) + ' · ' + esc(lastIv.type) + '</div>' : '') +
          '<div class="k-actions">' +
            '<button class="btn sm" data-act="dup" data-id="' + c.id + '">查重</button>' +
            '<button class="btn sm" data-act="iv" data-id="' + c.id + '">面试记录(' + c.interviews.length + ')</button>' +
            '<button class="btn sm" data-act="edit" data-id="' + c.id + '">编辑</button>' +
            '<select class="input select sm-select" data-act="status" data-id="' + c.id + '">' +
              STATUS.map(function (s) { return '<option value="' + s.key + '"' + (s.key === c.status ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') +
            '</select>' +
          '</div>';

        card.querySelector('button[data-act="iv"]').onclick = function () { openInterviewModal(c.id); };
        card.querySelector('button[data-act="edit"]').onclick = function () { openResumeModal(findCand(c.id)); };
        card.querySelector('button[data-act="dup"]').onclick = function () { openCandDupReport(c.id); };
        card.querySelector('select[data-act="status"]').onchange = function (e) {
          c.status = e.target.value;
          c.updatedAt = new Date().toISOString();
          persist(); renderKanban(); renderResumeTable();
        };
        col.appendChild(card);
      });
      board.appendChild(col);
    });
  }

  /* ================= 面试记录弹窗 ================= */
  function openInterviewModal(id) {
    var c = findCand(id);
    if (!c) return;
    ivCandidateId = id;
    var st = statusInfo(c.status);
    $('#interview-modal').hidden = false;
    $('#interview-modal-title').textContent = '面试记录 - ' + shortName(c) + '（' + st.label + '）';
    $('#iv-round').value = '第 ' + (c.interviews.length + 1) + ' 轮';
    $('#iv-type').value = '技术面';
    $('#iv-interviewer').value = '';
    $('#iv-score').value = '';
    $('#iv-evaluation').value = '';
    $('#iv-result').value = 'pass';

    var tl = $('#interview-timeline');
    tl.innerHTML = '';
    if (!c.interviews.length) {
      tl.innerHTML = '<p class="muted">暂无面试记录。</p>';
    }
    c.interviews.forEach(function (iv, i) {
      var div = document.createElement('div');
      div.className = 'tl-item';
      div.innerHTML =
        '<div class="tl-dot"></div>' +
        '<div class="tl-card">' +
          '<div class="tl-head">第 ' + (i + 1) + ' 轮 · ' + esc(iv.type) + ' · ' + fmtDate(iv.date) + '</div>' +
          '<div class="tl-sub">面试官：' + esc(iv.interviewer || '-') + ' · 评分：' + (iv.score != null ? iv.score : '-') + ' · 结果：<b>' + esc(RESULT_LABEL[iv.result] || iv.result) + '</b></div>' +
          (iv.evaluation ? '<div class="tl-sub">' + esc(iv.evaluation) + '</div>' : '') +
          '<button class="btn sm danger" data-act="del-iv" data-idx="' + i + '">删除</button>' +
        '</div>';
      tl.appendChild(div);
    });
    tl.querySelectorAll('button[data-act="del-iv"]').forEach(function (btn) {
      btn.onclick = function () {
        c.interviews.splice(Number(btn.dataset.idx), 1);
        c.updatedAt = new Date().toISOString();
        persist(); openInterviewModal(id); renderKanban();
      };
    });
  }

  function addInterviewRecord() {
    var c = findCand(ivCandidateId);
    if (!c) return;
    var score = $('#iv-score').value === '' ? null : Number($('#iv-score').value);
    c.interviews.push({
      round: c.interviews.length + 1,
      type: $('#iv-type').value,
      interviewer: $('#iv-interviewer').value.trim(),
      score: score,
      evaluation: $('#iv-evaluation').value.trim(),
      result: $('#iv-result').value,
      date: new Date().toISOString()
    });
    c.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    openInterviewModal(ivCandidateId);
  }

  /* ================= 候选人面试安排 ================= */
  /* 基础顺序：按编号升序（编号由 saveSchedules 统一重排为 1..N） */
  function sortSchedules(list) {
    return list.slice().sort(function (a, b) {
      var sa = Number(a.seq) || 0, sb = Number(b.seq) || 0;
      if (sa !== sb) return sa - sb;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
  }

  /* 展示顺序：默认按编号；选择时间排序时按面试时间升/降序（无时间行始终置底） */
  function orderedScheduleList() {
    if (scheduleSort.key !== 'time') return sortSchedules(state.schedules);
    var withT = [], noT = [];
    state.schedules.forEach(function (s) {
      var t = Date.parse(s.time || '');
      if (s.time && !isNaN(t)) withT.push(s); else noT.push(s);
    });
    var dir = scheduleSort.dir === -1 ? -1 : 1;
    withT.sort(function (a, b) {
      var d = Date.parse(a.time) - Date.parse(b.time);
      if (d !== 0) return d * dir;
      return (Number(a.seq) || 0) - (Number(b.seq) || 0);
    });
    return withT.concat(noT);
  }

  function renderScheduleTable() {
    var tbody = $('#schedule-tbody');
    if (!tbody) return;
    var empty = $('#schedule-empty');
    var kw = ($('#schedule-search').value || '').trim().toLowerCase();
    var list = orderedScheduleList().filter(function (s) {
      return !kw || (s.name || '').toLowerCase().indexOf(kw) >= 0;
    });
    $('#schedule-count').textContent = state.schedules.length;
    var indEl = $('#sort-ind-sch-time');
    if (indEl) indEl.textContent = scheduleSort.key === 'time' ? (scheduleSort.dir === -1 ? '▼' : '▲') : '↕';
    empty.hidden = list.length > 0;
    tbody.innerHTML = '';
    list.forEach(function (s, idx) {
      var tr = document.createElement('tr');
      tr.innerHTML = [
        '<td class="col-seq">' + (idx + 1) + '</td>',
        '<td><input class="input name-input" data-act="s-name" data-id="' + s.id + '" value="' + esc(s.name || '') + '" placeholder="面试人姓名"></td>',
        '<td><select class="input select" data-act="s-position" data-id="' + s.id + '">' + schedulePositionOptionsHtml(s.position || '') + '</select></td>',
        '<td><input class="input" type="datetime-local" data-act="s-time" data-id="' + s.id + '" value="' + esc(s.time || '') + '"></td>',
        '<td><input class="input" data-act="s-place" data-id="' + s.id + '" value="' + esc(s.place || '') + '" placeholder="面试地点"></td>',
        '<td class="col-note"><textarea class="input note-input" data-act="s-note" data-id="' + s.id + '" rows="2" maxlength="500" placeholder="备注">' + esc(s.note || '') + '</textarea></td>',
        '<td class="row-actions"><button class="btn sm" data-copy="' + s.id + '">复制</button><button class="btn sm danger" data-del="' + s.id + '">删除</button></td>'
      ].join('');
      tbody.appendChild(tr);

      tr.querySelector('[data-copy]').onclick = function () {
        copyScheduleRows([s.id]);
      };

      tr.querySelector('[data-del]').onclick = function () {
        if (confirm('确定删除「' + (s.name || '未命名') + '」的面试安排？')) {
          state.schedules = state.schedules.filter(function (x) { return x.id !== s.id; });
          Store.saveSchedules(state.schedules);
          renderScheduleTable();
        }
      };

      var nameInp = tr.querySelector('[data-act="s-name"]');
      var nameOrig = nameInp.value;
      nameInp.addEventListener('blur', function () { saveScheduleField(nameInp, 'name', nameOrig, true); });
      nameInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); }
        if (e.key === 'Escape') { nameInp.value = nameOrig; nameInp.blur(); }
      });

      var timeInp = tr.querySelector('[data-act="s-time"]');
      var timeOrig = timeInp.value;
      timeInp.addEventListener('change', function () { saveScheduleField(timeInp, 'time', timeOrig, false); });
      timeInp.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { timeInp.value = timeOrig; timeInp.blur(); }
      });

      var posSel = tr.querySelector('[data-act="s-position"]');
      var posOrig = posSel.value;
      posSel.addEventListener('change', function () { saveScheduleField(posSel, 'position', posOrig, false); });

      var placeInp = tr.querySelector('[data-act="s-place"]');
      var placeOrig = placeInp.value;
      placeInp.addEventListener('blur', function () { saveScheduleField(placeInp, 'place', placeOrig, false); });
      placeInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); placeInp.blur(); }
        if (e.key === 'Escape') { placeInp.value = placeOrig; placeInp.blur(); }
      });

      var noteTa = tr.querySelector('[data-act="s-note"]');
      var noteOrig = noteTa.value;
      noteTa.addEventListener('blur', function () { saveScheduleField(noteTa, 'note', noteOrig, false); });
      noteTa.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); noteTa.blur(); }
        if (e.key === 'Escape') { noteTa.value = noteOrig; noteTa.blur(); }
      });
    });
  }

  function findSchedule(id) {
    for (var i = 0; i < state.schedules.length; i++) {
      if (state.schedules[i].id === id) return state.schedules[i];
    }
    return null;
  }

  function saveScheduleField(el, field, orig, required) {
    var s = findSchedule(el.dataset.id);
    if (!s) { el.value = orig; return; }
    var val = field === 'note' ? String(el.value || '').slice(0, 500) : String(el.value || '').trim();
    if (required && !val) {
      alert('面试人姓名不能为空。');
      el.value = orig;
      return;
    }
    if (field === 'time' && !val) { el.value = orig; return; }
    if (s[field] === val) return;
    s[field] = val;
    s.updatedAt = new Date().toISOString();
    Store.saveSchedules(state.schedules);
    renderScheduleTable();
  }

  function openScheduleModal(id) {
    var s = null;
    if (id) {
      for (var i = 0; i < state.schedules.length; i++) {
        if (state.schedules[i].id === id) { s = state.schedules[i]; break; }
      }
    }
    scheduleEditingId = s ? s.id : null;
    $('#schedule-modal').hidden = false;
    $('#schedule-modal-title').textContent = s ? '编辑面试安排 - ' + (s.name || '') : '新建面试安排';
    $('#s-name').value = s ? s.name : '';
    $('#s-position').innerHTML = schedulePositionOptionsHtml(s ? s.position : '');
    $('#s-time').value = s ? (s.time || '') : '';
    $('#s-place').value = s ? s.place : '';
    $('#s-note').value = s ? s.note : '';
    $('#s-name').focus();
  }

  function saveSchedule() {
    var name = $('#s-name').value.trim();
    var time = $('#s-time').value;
    if (!name) { alert('请填写面试人姓名。'); $('#s-name').focus(); return; }
    if (!time) { alert('请选择面试时间。'); $('#s-time').focus(); return; }
    var s = null;
    for (var i = 0; i < state.schedules.length; i++) {
      if (state.schedules[i].id === scheduleEditingId) { s = state.schedules[i]; break; }
    }
    if (s) {
      s.name = name;
      s.position = $('#s-position').value.trim();
      s.time = time;
      s.place = $('#s-place').value.trim();
      s.note = $('#s-note').value.trim();
      s.updatedAt = new Date().toISOString();
    } else {
      state.schedules.push(Store.newSchedule({
        name: name,
        position: $('#s-position').value.trim(),
        time: time,
        place: $('#s-place').value.trim(),
        note: $('#s-note').value.trim()
      }));
    }
    Store.saveSchedules(state.schedules);
    $('#schedule-modal').hidden = true;
    renderScheduleTable();
  }

  /* ---------- 复制：一条或多条 ---------- */
  function copyScheduleRows(ids) {
    if (!ids.length) return;
    var added = 0;
    ids.forEach(function (id) {
      var src = findSchedule(id);
      if (!src) return;
      var copy = Store.newSchedule({
        name: src.name,
        position: src.position,
        time: src.time,
        place: src.place,
        note: src.note
      });
      state.schedules.push(copy);
      added++;
    });
    if (!added) return;
    Store.saveSchedules(state.schedules);
    renderScheduleTable();
  }

  /* ---------- Excel 导出 ---------- */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtScheduleTime(timeStr) {
    var s = String(timeStr || '');
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s.indexOf('T') >= 0 ? s.replace('T', ' ') : s;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function exportScheduleXlsx() {
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请检查 js/vendor/xlsx.full.min.js。'); return; }
    var header = ['编号', '面试人姓名', '面试职位', '面试时间', '面试地点', '备注'];
    var rows = orderedScheduleList().map(function (s, i) {
      return [i + 1, s.name || '', s.position || '', fmtScheduleTime(s.time), s.place || '', s.note || ''];
    });
    var aoa = [header].concat(rows);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 30 }
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '面试安排');
    var d = new Date();
    var fname = '面试安排_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.xlsx';
    XLSX.writeFile(wb, fname);
  }

  /* ---------- Excel 导入 ---------- */
  /* Excel 序列号（天）→ Date；误差由本地时区决定，统一用本地年月日绘图 */
  function excelSerialToDate(serial) {
    var ms = Math.round((Number(serial) - 25569) * 86400000);
    return new Date(ms);
  }

  function normalizeScheduleTime(v) {
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return '';
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate()) + 'T' +
        pad2(v.getHours()) + ':' + pad2(v.getMinutes());
    }
    if (typeof v === 'number' && v > 20000 && v < 60000) {
      var dv = excelSerialToDate(v);
      if (isNaN(dv.getTime())) return '';
      return dv.getFullYear() + '-' + pad2(dv.getMonth() + 1) + '-' + pad2(dv.getDate()) + 'T' +
        pad2(dv.getHours()) + ':' + pad2(dv.getMinutes());
    }
    var s = String(v || '').trim();
    if (!s) return '';
    s = s.replace(/[\/.]/g, '-').replace(/\s+/g, ' ');
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?/);
    if (!m) return '';
    var Y = m[1], Mo = pad2(Number(m[2])), D = pad2(Number(m[3]));
    var H = m[4] ? pad2(Number(m[4])) : '00', Mi = m[5] ? pad2(Number(m[5])) : '00';
    return Y + '-' + Mo + '-' + D + 'T' + H + ':' + Mi;
  }

  function schHeaderKind(h) {
    var x = String(h || '').replace(/[\s*_\-（）()]/g, '');
    if (/姓名|名字|名字人/.test(x)) return 'name';
    if (/职位|岗位/.test(x)) return 'position';
    if (/时间|日期/.test(x)) return 'time';
    if (/地点|场所|地址/.test(x)) return 'place';
    if (/备注|说明|描述|内容/.test(x)) return 'note';
    if (/编号|序号|号/.test(x)) return 'seq';
    return '';
  }

  function importScheduleFile(file) {
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请检查 js/vendor/xlsx.full.min.js。'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        if (!wb.SheetNames.length) { alert('文件中没有可用的工作表。'); return; }
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        var dataRows = rows.slice(1);
        var colMap = { seq: 0, name: 1, position: 2, time: 3, place: 4, note: 5 };
        if (rows[0]) {
          var mapped = rows[0].map(schHeaderKind);
          if (mapped.indexOf('name') >= 0) {
            var order = { seq: 0, name: 1, position: 2, time: 3, place: 4, note: 5 };
            for (var k in order) colMap[k] = -1;
            mapped.forEach(function (kind, i) {
              if (typeof order[kind] === 'number') colMap[kind] = i;
            });
            dataRows = rows.slice(1);
          }
        }
        var added = 0, skipped = 0;
        dataRows.forEach(function (r) {
          function cell(kind) {
            var ci = colMap[kind];
            return ci >= 0 && r[ci] !== undefined ? r[ci] : '';
          }
          var name = String(cell('name') || '').trim();
          var time = normalizeScheduleTime(cell('time'));
          var rec = Store.newSchedule({
            name: name,
            position: String(cell('position') || '').trim(),
            time: time,
            place: String(cell('place') || '').trim(),
            note: String(cell('note') || '').trim()
          });
          if (!rec.name) { skipped++; return; }
          state.schedules.push(rec);
          added++;
        });
        if (!added) { alert('未解析到有效数据（需要「姓名」列，且至少一行有姓名）。'); return; }
        Store.saveSchedules(state.schedules);
        renderScheduleTable();
        var msg = '导入成功：新增 ' + added + ' 条面试安排。';
        if (skipped) msg += '\n已跳过 ' + skipped + ' 行（缺少姓名）。';
        alert(msg);
      } catch (err) {
        console.error(err);
        alert('导入失败：' + (err && err.message ? err.message : err));
      }
    };
    reader.onerror = function () { alert('文件读取失败。'); };
    reader.readAsArrayBuffer(file);
  }

  /* ================= 弹窗通用 ================= */
  function bindModalClose() {
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.onclick = function () {
        document.getElementById(btn.dataset.close).hidden = true;
      };
    });
    document.querySelectorAll('.modal-mask').forEach(function (mask) {
      mask.addEventListener('click', function (e) {
        if (e.target === mask) mask.hidden = true;
      });
    });
  }

  /* ================= 上传 / 导入导出 / 示例 ================= */
  var POS_WORDS = /(测试|开发|工程师|架构|经理|专员|主管|设计师|产品|运营|销售|人事|财务|算法|大数据|前端|后端|全栈|实施|运维|数据分析|助理|顾问|实习生|总监)/;
  var CITIES = /(北京|上海|广州|深圳|杭州|南京|成都|武汉|西安|苏州|天津|重庆|长沙|青岛|郑州|合肥|福州|厦门|济南|宁波|无锡|大连|沈阳|昆明|哈尔滨|长春|石家庄|太原|南宁|贵阳|兰州|南昌|银川|西宁|呼和浩特|海口|乌鲁木齐|香港|澳门)/;
  var ALIAS_TAIL = /(先生|女士|小姐)$/;
  var NAME_STOP = /^(个人简历|个人资料|简历|求职简历|基本信息|个人信息|联系方式|教育背景|工作经历|项目经验|专业技能|技能特长|自我评价|个人评价|个人优势|优势亮点|自我描述|求职意向|求职目标|应聘岗位|期望职位|期望岗位|意向岗位|求职期望|姓名|性别|年龄|学历|籍贯|民族|婚姻|政治面貌|毕业院校|毕业时间|工作年限|工作经验|求职状态|到岗时间|薪资要求|期望薪资|照片|头像)/;
  var HAN_NAME = /^[一-龥]{2,15}$/;

  function isPlainName(s) {
    s = String(s || '').trim();
    return HAN_NAME.test(s) && !NAME_STOP.test(s) && !POS_WORDS.test(s) && !CITIES.test(s);
  }

  /* 从中文文件名里捞姓名：【AI测试工程师_上海】许易 12年 -> 许易 */
  function nameFromFileName(fname) {
    var s = String(fname || '');
    s = s.replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）|#[^#]*#/g, ' ');
    s = s.replace(/\.[^.]+$/, '');
    s = s.replace(/[\d０-９]+(\.\d+)?\s*(年|岁|届|年以上经验|年经验|年以上工作经验|个月经验)?/g, ' ');
    s = s.replace(/[\s_\-–—|+,，、。．·:：;；!！?？"'“”‘’()（）]+/g, ' ');
    var toks = s.split(/\s+/).filter(function (x) {
      return x && x.length <= 12 && !POS_WORDS.test(x) && !CITIES.test(x) &&
        !/^(测试|开发|运维|实施|产品|运营|销售|人事|财务)$/.test(x) &&
        !/^(有|无|以上|以下|应届|实习|全职|兼职|男|女)$/.test(x);
    });
    if (!toks.length) return '';
    var last = toks[toks.length - 1];
    if (HAN_NAME.test(last) && !ALIAS_TAIL.test(last)) return last;
    var first = toks[0];
    if (HAN_NAME.test(first) && !ALIAS_TAIL.test(first)) return first;
    for (var i = 0; i < toks.length; i++) {
      if (isPlainName(toks[i])) return toks[i];
    }
    return '';
  }

  function parseResumeHead(text, fallbackName) {
    /* PDF / docx 排版常把多个字段用制表符、竖线或连续空格拼在一行，需拆成片段 */
    var segs = String(text || '').split(/\n|\t|\s{2,}|\s*\|/);
    var name = '', phone = '', email = '', position = '';
    var limit = Math.min(segs.length, 30);

    for (var i = 0; i < limit; i++) {
      var seg = segs[i].trim();
      if (!seg || seg.length > 120) continue;
      var k = seg.replace(/\s+/g, '');   /* 兼容「姓    名：」这类填充对齐 */

      var me = seg.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (me && !email) email = me[0];

      var mp = seg.match(/(?:^|\D)(1[3-9]\d{9})(?!\d)/);
      if (mp && !phone) phone = mp[1];

      var mn = k.match(/^(?:姓名|名字|姓)[:：](.+)$/);
      if (mn && !name && isPlainName(mn[1].slice(0, 20))) { name = mn[1].trim(); continue; }

      var mj = k.match(/^(?:求职意向|求职目标|目标岗位|期望职位|期望岗位|意向岗位|应聘岗位|应聘职位|应聘|岗位|职位)[:：]?(.+)$/);
      if (mj && !position && seg.length <= 40) { position = mj[1].trim(); continue; }

      if (!name && isPlainName(seg)) name = seg;
    }

    if (!position) {
      /* 回退：值在下一个字段标签或竖线处截断，避免把「期望城市」等一起吞掉 */
      var mp2 = text.match(/(?:求职意向|求职目标|目标岗位|期望职位|期望岗位|意向岗位|应聘岗位|应聘职位)\s*[:：]\s*([^\n\t|]{2,20})/);
      if (mp2) {
        position = mp2[1].split(/期望城市|期望薪资|工作城市|期望地点|到岗时间|薪资要求/)[0].trim();
      }
    }
    if (!position) {
      /* PDF 抽取常把「应聘岗位」和它的值拆成两段，中间夹一堆单字乱码，
       * 同行正则匹配不到。这里只在值里含职位关键词时才认，避免猜错。 */
      var LBL = /^(?:应聘岗位|应聘职位|求职意向|求职目标|目标职位|意向职位|意向岗位|期望职位|期望岗位|岗位|职位)\s*[:：]?$/;
      for (var j = 0; j < Math.min(segs.length, 80) && !position; j++) {
        if (!LBL.test(segs[j].trim())) continue;
        for (var k2 = j + 1; k2 < Math.min(segs.length, j + 8); k2++) {
          var v = segs[k2].trim();
          if (v && v.length <= 20 && POS_WORDS.test(v) && !NAME_STOP.test(v)) { position = v; break; }
        }
      }
    }
    if (!name) name = nameFromFileName(fallbackName) || '';

    return {
      name: (name || fallbackName || '').slice(0, 40),
      phone: phone.slice(0, 60),
      email: email.slice(0, 60),
      position: position.slice(0, 60)
    };
  }

  function setUploadStatus(msg, scope) {
    var el = scope === 'user' ? $('#user-upload-status') : $('#upload-status');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function handleFileUpload(files, scope) {
    var arr = Array.from(files || []);
    if (!arr.length) return;

    /* 普通用户：必须先选择应聘岗位，该岗位将覆盖自动解析出的岗位 */
    var pagePosition = '';
    if (scope === 'user') {
      var sel = $('#user-position');
      pagePosition = sel ? sel.value : '';
      if (!pagePosition) { alert('请先选择应聘岗位，再上传简历。'); return; }
    }

    setUploadStatus('正在同步简历库…', scope);

    function start() {
      setUploadStatus('正在解析 0/' + arr.length + '…', scope);
      var ok = [];
      var fail = [];
      var done = 0;

      /* 串行解析：避免多份 PDF 同时占用 CPU 拖慢页面 */
      var chain = Promise.resolve();
      arr.forEach(function (file) {
        chain = chain.then(function () {
          return FileParse.parse(file).then(function (text) {
            ok.push({
              head: parseResumeHead(text, file.name.replace(/\.[^.]+$/, '')),
              text: text,
              file: file.name,
              rawFile: file
            });
          }).catch(function (e) {
            fail.push(file.name + '：' + ((e && e.message) || e));
          }).then(function () {
            done++;
            setUploadStatus('正在解析 ' + done + '/' + arr.length + '…', scope);
          });
        });
      });

      chain.then(function () {
        setUploadStatus('', scope);
        if (ok.length) afterUpload(ok, fail, pagePosition);
        else alert('未能读取所选文件内容。\n\n' + fail.slice(0, 5).join('\n'));
      });
    }

    /* 上传前先同步服务器最新简历库，确保与他人共享同一份数据用于查重 */
    Store.refresh().then(function () {
      state.candidates = Store.loadCandidates();
      state.settings = Store.loadSettings();
      invalidateTextIdx();
      start();
    });
  }

  /* ================= 上传查重拦截 =================
   * 硬拦截（必定已投递，直接不收）：姓名 + 联系方式/正文，或联系方式相同
   * 软拦截（需你确认）：仅正文雷同，或仅姓名相同（可能是重名，也可能是同一人的
   *   扫描件没抽出手机号/正文，漏过去就会重复入库）
   * 放行：完全没有命中
   */
  var UPLOAD_HARD_BLOCK = { high: 1, contact: 1 };

  function afterUpload(texts, fail, pagePosition) {
    if (!texts.length) { alert('未能读取所选文件内容。'); return; }
    var th = state.settings.threshold;
    var cache = ensureTextIdx();
    var others = state.candidates.map(function (c) { return toProbeInput(c); });

    var clean = [], blocked = [], soft = [];
    var tmpSeq = 0;

    texts.forEach(function (t) {
      var head = t.head;
      var contact = (head.phone || '') + ' ' + (head.email || '');
      var probe = Sim.makeProbe(head.name, contact, t.text);
      var hits = Sim.checkDuplicate(probe, others, th);
      var top = hits[0];
      var rec = { text: t, head: head, hits: hits, top: top, level: top ? top.level : null };

      if (top && UPLOAD_HARD_BLOCK[top.level]) blocked.push(rec);
      else if (top) soft.push(rec);
      else clean.push(rec);

      /* 无论是否入库都先放进比对池：同一次选中两份一样的文件时，
       * 后一份要能查到前一份，否则会一起被放行。 */
      others.push({
        id: '__tmp' + (++tmpSeq),
        name: head.name,
        contact: contact,
        text: t.text,
        index: Sim.makeIndex(t.text),
        contacts: Sim.contactTokens(contact)
      });
    });

    if (!blocked.length && !soft.length) {
      commitUploads(clean, [], [], fail, pagePosition);
      return;
    }

    askUploadDup(blocked, soft, clean).then(function (approved) {
      if (approved === null) {          /* 全部取消 */
        alert('已取消本次上传。\n\n被拦截 ' + blocked.length + ' 份、待确认 ' + soft.length +
          ' 份、未上传 ' + clean.length + ' 份。');
        return;
      }
      commitUploads(clean.concat(approved), blocked, soft, fail, pagePosition);
    });
  }

  /* 渲染拦截弹窗，resolve 出用户勾选「仍然上传」的软拦截记录；点全部取消 resolve(null) */
  function askUploadDup(blocked, soft, clean) {
    var modal = $('#upload-dup-modal');
    var body = $('#upload-dup-body');
    var okBtn = $('#upload-dup-ok');

    $('#upload-dup-banner').innerHTML =
      '简历库中<b>已存在相同简历</b>，以下文件不会重复入库。当前相似度阈值 ' + esc(String(state.settings.threshold)) + '%。' +
      '<br><span class="muted">红色为已投递（直接阻止），橙色为疑似重复（需你勾选确认后才上传）。</span>';

    body.innerHTML =
      blocked.map(function (r) { return uploadDupItemHtml(r, -1); }).join('') +
      soft.map(function (r, i) { return uploadDupItemHtml(r, i); }).join('');
    /* 命中行上的「完整简历」按钮 */
    addActions(body, function (act, id) {
      if (act !== 'view') return;
      var c = findCand(id);
      if (c) openResumeInfo(c);
    });
    okBtn.textContent = '上传可上传的 ' + clean.length + ' 份' + (soft.length ? '（+勾选）' : '');
    modal.hidden = false;

    return new Promise(function (resolve) {
      var cancelBtn = $('#upload-dup-cancel');
      var xBtn = modal.querySelector('.modal-close');
      var finished = false;

      function done(cancelled) {
        if (finished) return;
        finished = true;
        modal.hidden = true;
        modal.removeEventListener('click', onMask);
        xBtn.onclick = null;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (cancelled) { resolve(null); return; }
        var picked = Array.prototype.slice.call(body.querySelectorAll('input[data-approve]:checked'))
          .map(function (cb) { return soft[Number(cb.dataset.approve)]; })
          .filter(Boolean);
        resolve(picked);
      }
      function onOk() { done(false); }
      function onCancel() { done(true); }
      function onMask(e) { if (e.target === modal) done(true); }

      /* 接管关闭：× 和点遮罩等同于「全部取消」，否则 Promise 悬空、上传流程卡死 */
      xBtn.onclick = function () { done(true); };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('click', onMask);
    });
  }

  /* 单个被拦截文件的展示：解析结果 + 库内命中简历的查询结果
   * softIdx >= 0 表示是软拦截（可勾选放行），-1 表示硬拦截 */
  function uploadDupItemHtml(rec, softIdx) {
    var isBlocked = softIdx < 0;
    var top = rec.top;
    var h = rec.head;
    var hits = rec.hits.slice(0, 3);

    var rows = hits.map(function (hit) {
      var c = findCand(hit.id);
      if (!c) return '';
      return '<tr>' +
        '<td>' + (c.seq != null ? '编号 ' + c.seq : '-') + '</td>' +
        '<td><b>' + esc(shortName(c)) + '</b></td>' +
        '<td>' + (esc(c.phone || c.email) || '-') + '</td>' +
        '<td>' + (esc(c.position) || '-') + '</td>' +
        '<td>' + (esc(c.source) || '-') + '</td>' +
        '<td>' + esc(statusInfo(c.status).label) + '</td>' +
        '<td><b>' + hit.sim + '%</b></td>' +
        '<td class="udup-reason">' + esc(hit.reasons.join('；') || hit.label) + '</td>' +
        '<td><button class="btn sm" data-act="view" data-id="' + c.id + '">完整简历</button></td>' +
      '</tr>';
    }).join('');

    return '<div class="udup-item' + (isBlocked ? ' is-blocked' : ' is-soft') + '">' +
      '<div class="udup-head">' +
        (isBlocked
          ? '<span class="pill dup-pill">已投递 · 阻止上传</span>'
          : '<span class="pill warn-pill">疑似重复 · 需确认</span>') +
        '<b>' + esc(h.name || '（未识别姓名）') + '</b>' +
        '<span class="muted">' + esc(h.position || '岗位未识别') + ' · ' + esc(h.phone || h.email || '联系方式未识别') + '</span>' +
        '<span class="udup-file">上传文件：' + esc(rec.text.file) + '</span>' +
      '</div>' +
      '<div class="udup-verdict">判定：<b>' + esc(top.label) + '</b> —— ' + esc(Sim.DUP_HINT[rec.level] || '') + '</div>' +
      '<div class="udup-hits-title">查询结果：简历库中已存在 ' + rec.hits.length + ' 份相同/雷同简历' +
        (rec.hits.length > hits.length ? '，仅显示相似度最高的 ' + hits.length + ' 份' : '') + '</div>' +
      '<table class="udup-hits"><thead><tr>' +
        '<th>库内编号</th><th>姓名</th><th>联系方式</th><th>应聘岗位</th><th>来源</th><th>状态</th>' +
        '<th>相似度</th><th>判定依据</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      (isBlocked
        ? '<div class="udup-note">该简历已在简历库中，本次上传已被阻止，未写入任何数据。</div>'
        : '<label class="udup-approve"><input type="checkbox" data-approve="' + softIdx +
          '"> 我确认这是新的一份，仍然上传</label>') +
      '</div>';
  }

  /* 真正写入简历库 */
  function commitUploads(accepted, blocked, soft, fail, pagePosition) {
    if (!accepted.length) {
      if (fail && fail.length) alert('没有可上传的简历。\n\n以下文件未能解析：\n— ' + fail.slice(0, 5).join('\n— '));
      else alert('没有可上传的简历。');
      return;
    }
    var cache = ensureTextIdx();
    var jobs = [];
    accepted.forEach(function (rec) {
      var h = rec.head;
      var c = Store.newCandidate({
        name: h.name,
        phone: h.phone,
        email: h.email,
        position: pagePosition || h.position,
        source: '上传',
        rawText: rec.text.text,
        srcFile: rec.text.file || '',
        note: ''
      });
      state.candidates.push(c);
      if (cache.text) cache.text.set(c.id, Sim.makeIndex(c.rawText));
      if (cache.contact) cache.contact.set(c.id, Sim.contactTokens(contactOf(c)));

      /* 保存原始附件：上传到云端存储后再把地址写回记录，供在线预览 / 下载 */
      if (rec.rawFile) {
        c.fileName = rec.file || c.srcFile || '';
        c.fileType = fileMime(c.fileName);
        c.fileSize = (typeof rec.rawFile.size === 'number') ? rec.rawFile.size : null;
        jobs.push(
          Store.uploadResumeFile(resumeFilePath(c, c.fileName), rec.rawFile)
            .then(function (info) { c.filePath = info.path; c.fileUrl = info.url; })
            .catch(function (e) { console.error('原始附件上传失败：' + c.fileName, e); })
        );
      }
    });
    cache.n = state.candidates.length;   /* 同步缓存计数，避免下次全量重建索引 */

    Promise.all(jobs).then(function () {
      persist();
      refreshDup();

      var msg = '已上传 ' + accepted.length + ' 份简历。';
      if (blocked.length) msg += '\n已阻止 ' + blocked.length + ' 份（简历库中已存在相同简历）。';
      if (soft.length) msg += '\n另有 ' + soft.length + ' 份疑似重复已按你的选择处理。';
      if (fail && fail.length) {
        msg += '\n\n以下文件未能解析：\n— ' + fail.slice(0, 5).join('\n— ');
      }
      alert(msg);
    });
  }

  /* 取文件扩展名（小写、仅字母数字） */
  function fileExtOf(name) {
    var parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  }

  /* 原始附件在存储桶中的路径：按候选人 id 命名，同一份简历重复上传时直接覆盖 */
  function resumeFilePath(c, fileName) {
    return c.id + '.' + (fileExtOf(fileName) || 'bin');
  }

  /* 依据扩展名推断 MIME，用于预览与下载 */
  function fileMime(fileName) {
    var ext = fileExtOf(fileName);
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'txt') return 'text/plain';
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === 'doc') return 'application/msword';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return '';
  }

  function exportJson() {
    var payload = {
      exportedAt: new Date().toISOString(),
      app: 'resume-duplicate-check',
      version: 1,
      candidates: state.candidates,
      settings: state.settings
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '简历查重系统数据_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var data = JSON.parse(ev.target.result);
        var arr = data.candidates || (Array.isArray(data) ? data : []);
        if (!arr.length) throw new Error('无候选人数据');
    state.candidates = arr.map(function (d) { return Store.newCandidate(d); });
    Store.resyncSeq(state.candidates);
    /* 把「原始文件：xxx」从备注拆到 srcFile，备注留给用户自己写 */
    var split = 0;
    state.candidates.forEach(function (c) { if (splitProvenance(c)) split++; });
        if (data.settings && typeof data.settings.threshold === 'number') state.settings.threshold = data.settings.threshold;
        persist();
        applySettings();
        refreshDup();
        alert('导入成功，共 ' + state.candidates.length + ' 条候选人记录。');
      } catch (e) {
        alert('导入失败：' + e.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function seedData() {
    if (state.candidates.length && !confirm('当前已有数据，继续加载示例将追加。是否继续？')) return;

    function person(o) {
      return Store.newCandidate({
        name: o.name, phone: o.phone, position: o.position, source: o.source,
        status: o.status, score: o.score, rawText: o.text, note: o.note
      });
    }

    var sharedJob1 = '负责库存管理系统后端开发，参与订单、商品、库存等核心模块的需求评审与技术设计，独立完成数据库表结构设计与接口开发。';
    var sharedJob2 = '熟练使用 Java、Spring Boot、MyBatis 框架，熟悉 MySQL，掌握 Redis 缓存与消息队列 RabbitMQ，了解 Docker 部署与 Linux 运维。';

    var r1 = '周敏\n电话：13800000007\n应聘岗位：Java 开发工程师\n\n教育背景\n2016.09-2020.06　华中科技大学　软件工程　本科\n\n工作经历\n2020.07-至今　杭州某物流科技有限公司　Java 开发工程师\n' + sharedJob1 + '\n' + sharedJob2 + '\n\n项目经验\n智能仓储系统：负责出库单模块，日均处理单据 20 万+。\n\n自我评价\n学习能力强，注重代码质量。';

    var r2 = '吴杰\n电话：13800000008\n应聘岗位：Java 开发工程师\n\n教育背景\n2015.09-2019.06　武汉理工大学　计算机科学　本科\n\n工作经历\n2020.07-至今　杭州某物流科技有限公司　Java 开发工程师\n' + sharedJob1 + '\n' + sharedJob2 + '\n\n项目经验\n智能仓储系统：负责盘点与调拨模块，日均处理单据 20 万+。\n\n自我评价\n做事踏实，善于沟通。';

    var r3 = '周敏\n电话：13800000007\n应聘岗位：Java 开发工程师\n\n教育背景\n2016.09-2020.06　华中科技大学　软件工程　本科\n\n工作经历\n' + sharedJob1 + '\n' + sharedJob2 + '\n\n自我评价\n重复投递的同名简历。';

    var sample = [
      person({ name: '王芳', phone: '13800000003', position: '产品经理', source: 'BOSS直聘', status: 'to_interview1', score: 82, note: '有 5 年 B 端产品经验，沟通能力强。', text: '王芳\n电话：13800000003\n应聘岗位：产品经理\n\n教育背景\n2012-2016　南京大学　信息管理与信息系统　本科\n\n工作经历\n2016-2019　某科技公司　产品助理\n负责后台系统需求梳理与原型绘制。\n2019-至今　某 SaaS 公司　产品经理\n负责用户增长模块的产品规划、需求评审与上线跟进。\n\n自我评价\n结果导向，擅长数据分析驱动决策。' }),
      person({ name: '赵强', phone: '13800000004', position: '前端开发工程师', source: '内推', status: 'resume_fail', score: 88, note: 'Vue/React 均可，作品演示优秀。', text: '赵强\n电话：13800000004\n应聘岗位：前端开发工程师\n\n教育背景\n2015-2019　武汉大学　软件工程　本科\n\n工作经历\n2019-至今　某头部互联网公司　前端工程师\n负责核心业务的前端开发，主导组件库建设。\n\n技术栈\nVue3、React、TypeScript、Webpack、Vite。\n\n自我评价\n追求性能与体验，善于技术沉淀。' }),
      person({ name: '钱丽', phone: '13800000005', position: '数据分析师', source: '猎头', status: 'to_hire', score: 90, text: '钱丽\n电话：13800000005\n应聘岗位：数据分析师\n\n教育背景\n2014-2018　浙江大学　统计学　本科\n\n工作经历\n2018-2021　某互联网公司　数据分析\n负责 AB 实验设计与业务报表建设。\n2021-至今　某电商平台　高级数据分析师\n负责用户运营分析模型建设。\n\n自我评价\n数据敏感度高，善于用数据讲故事。' }),
      person({ name: '孙婷', phone: '13800000006', position: '测试工程师', source: 'BOSS直聘', status: 'interview_fail', score: 45, text: '孙婷\n电话：13800000006\n应聘岗位：测试工程师\n\n教育背景\n2016-2020　华中科技大学　计算机相关专业\n\n工作经历\n2020-2022　某公司　初级测试\n2022-至今　负责功能测试用例编写。' })
    ];

    var base = sample.slice(0, 3);
    var dupPair = [
      person({ name: '周敏', phone: '13800000007', position: 'Java 开发工程师', source: 'BOSS直聘', status: 'pending', text: r1 }),
      person({ name: '吴杰', phone: '13800000008', position: 'Java 开发工程师', source: '招聘会', status: 'pending', text: r2 }),
      person({ name: '周敏', phone: '13800000007', position: 'Java 开发工程师', source: '猎头', status: 'pending', text: r3 })
    ];
    state.candidates = state.candidates.concat(base).concat(dupPair);
    persist();
    refreshDup();
    alert('已加载示例数据（' + state.candidates.length + ' 人）。含 1 组正文雷同（周敏 / 吴杰）与 1 组同名同手机号（周敏 / 周敏），已自动标记，可在简历库中查看「疑似重复」标识。');
  }

  /* ================= 登录 / 角色视图 ================= */
  function applyRoleView() {
    var loggedIn = !!session;
    var user = isUser();
    $('#login-view').hidden = loggedIn;
    var nav = document.querySelector('.tabs');
    if (nav) nav.hidden = user;
    $('#btn-logout').hidden = !loggedIn;

    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.remove('active');
      if (!loggedIn) return;
      if (user) {
        if (p.id === 'tab-user') p.classList.add('active');
      } else if (p.id === 'tab-resumes') {
        p.classList.add('active');
      }
    });
    if (loggedIn && !user) {
      document.querySelectorAll('.tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.tab === 'resumes');
      });
    }
  }

  function doLogin() {
    var u = $('#login-username').value.trim();
    var p = $('#login-password').value;
    var acc = ACCOUNTS[u];
    var err = $('#login-error');
    if (!acc || acc.pass !== p) {
      err.hidden = false;
      err.textContent = '账号或密码错误，请重试。';
      return;
    }
    session = { role: acc.role, name: acc.label, at: new Date().toISOString() };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
    err.hidden = true;
    $('#login-username').value = '';
    $('#login-password').value = '';
    applyRoleView();
    if (session.role === 'admin' && state.candidates.length >= 2) {
      runDuplicates();
    } else {
      renderAll();
    }
  }

  function doLogout() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    document.querySelectorAll('.modal-mask').forEach(function (m) { m.hidden = true; });
    applyRoleView();
  }

  /* ================= 渲染入口 ================= */
  function renderAll() {
    renderResumeTable();
    renderScheduleTable();
    renderKanban();
  }

  function applySettings() {
    var range = $('#threshold-range');
    range.value = state.settings.threshold;
    $('#threshold-val').textContent = state.settings.threshold + '%';
    $('#data-size').textContent = Store.storageSize() + ' KB';
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); };
    });

    $('#btn-new-resume').onclick = function () { openResumeModal(null); };
    $('#btn-import-file').onclick = function () { $('#file-input').click(); };
    $('#file-input').onchange = function () {
      if (this.files.length) { handleFileUpload(this.files); this.value = ''; }
    };

    $('#btn-login').onclick = doLogin;
    $('#login-username').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('#login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('#btn-logout').onclick = doLogout;
    $('#btn-user-import').onclick = function () { $('#user-file-input').click(); };
    $('#user-file-input').onchange = function () {
      if (this.files.length) { handleFileUpload(this.files, 'user'); this.value = ''; }
    };

    ['#f-name', '#f-phone', '#f-text'].forEach(function (sel) {
      $(sel).addEventListener('input', scheduleNameDup);
    });

    $('#btn-save-resume').onclick = function () {
      var name = $('#f-name').value.trim();
      var text = $('#f-text').value;
      if (!name) { alert('请填写姓名。'); $('#f-name').focus(); return; }
      if (!text) { alert('请填写简历正文。'); $('#f-text').focus(); return; }

      var hits = queryDup(name, $('#f-phone').value.trim(), text, editingId);
      var data = {
        name: name,
        phone: $('#f-phone').value.trim(),
        position: $('#f-position').value.trim(),
        source: $('#f-source').value.trim(),
        rawText: Sim.clean(text),
        score: $('#f-score').value === '' ? null : Number($('#f-score').value),
        note: $('#f-note').value.trim().slice(0, NOTE_MAX)
      };

      var c = editingId ? findCand(editingId) : null;
      if (c) {
        c.name = data.name; c.phone = data.phone; c.position = data.position;
        c.source = data.source; c.rawText = data.rawText; c.score = data.score;
        c.note = data.note; c.updatedAt = new Date().toISOString();
      } else {
        state.candidates.push(Store.newCandidate(data));
      }
      $('#resume-modal').hidden = true;
      persist();
      refreshDup();
      if (hits.length) {
        alert('提示：该简历与 ' + hits.length + ' 条历史记录疑似重复（' + hits[0].label + '）。\n已在列表中标记，可点击「查重」查看比对详情。');
      }
    };

    $('#btn-add-interview').onclick = addInterviewRecord;
    $('#btn-new-schedule').onclick = function () { openScheduleModal(null); };
    $('#btn-save-schedule').onclick = saveSchedule;
    $('#schedule-search').oninput = renderScheduleTable;
    $('#btn-export-schedule').onclick = exportScheduleXlsx;
    $('#btn-import-schedule').onclick = function () { $('#sch-import-file').click(); };
    $('#sch-import-file').onchange = function () {
      if (this.files.length) { importScheduleFile(this.files[0]); this.value = ''; }
    };

    if ($('#th-sch-time')) $('#th-sch-time').onclick = function () {
      if (scheduleSort.key !== 'time') { scheduleSort.key = 'time'; scheduleSort.dir = 1; }
      else if (scheduleSort.dir === 1) { scheduleSort.dir = -1; }
      else { scheduleSort.key = 'seq'; scheduleSort.dir = 1; }
      renderScheduleTable();
    };

    $('#threshold-range').oninput = function () {
      var v = Number(this.value);
      $('#threshold-val').textContent = v + '%';
      state.settings.threshold = v;
      Store.saveSettings(state.settings);
      if (thTimer) clearTimeout(thTimer);
      thTimer = setTimeout(function () {
        if (state.dup.length) runDuplicates();
      }, 200);
    };

    $('#btn-export').onclick = exportJson;
    $('#btn-import').onclick = function () { $('#import-input').click(); };
    $('#import-input').onchange = function () {
      if (this.files.length) { importJson(this.files[0]); this.value = ''; }
    };
    $('#btn-clear').onclick = function () {
      if (confirm('确定清空所有数据？此操作不可恢复。')) {
        state.candidates = [];
        state.dup = [];
        state.dupCids = new Set();
        persist();
        renderAll();
      }
    };
    $('#btn-seed').onclick = seedData;

    $('#search-box').oninput = renderResumeTable;
    if ($('#search-scope')) $('#search-scope').onchange = renderResumeTable;
    $('#status-filter').onchange = renderResumeTable;
    $('#dup-filter').onchange = renderResumeTable;
    if ($('#th-date')) $('#th-date').onclick = function () {
      if (state.sortKey === 'date') state.sortDir = state.sortDir === -1 ? 1 : -1;
      else { state.sortKey = 'date'; state.sortDir = -1; }
      renderResumeTable();
    };

    /* 状态筛选项由 STATUS 生成，避免和下拉框、看板列三处各写一份而对不上 */
    $('#status-filter').insertAdjacentHTML('beforeend', STATUS.map(function (s) {
      return '<option value="' + s.key + '">' + esc(s.label) + '</option>';
    }).join(''));

    $('#cand-dup-onlyhit').onchange = renderCandDupReport;

    bindModalClose();
  }

  /* ================= 启动 ================= */
  function init() {
    try {
      var saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      session = (saved && (saved.role === 'admin' || saved.role === 'user')) ? saved : null;
    } catch (e) { session = null; }

    /* 先加载共享数据（服务器 / 隧道），失败则回退本地，再渲染界面 */
    Store.init().then(function () {
      state.candidates = Store.loadCandidates();
      state.settings = Store.loadSettings();
      /* 旧版本状态键统一迁移到新流程，避免看板列统计不到人 */
      var migrated = false;
      state.candidates.forEach(function (c) {
        var ns = normalizeStatus(c.status);
        if (ns !== c.status) { c.status = ns; migrated = true; }
        if (splitProvenance(c)) migrated = true;
      });
      if (migrated) Store.saveCandidates(state.candidates);
      applySettings();
      bindEvents();
      applyRoleView();

      if (!session) return;                /* 未登录：只显示登录页 */
      if (session.role === 'user') return; /* 普通用户：仅上传，简历库数据已加载用于比对 */

      if (state.candidates.length >= 2) {
        runDuplicates();   // 启动即恢复重复标记，避免刷新后标记丢失
      } else {
        renderAll();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
