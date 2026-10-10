(function (global) {
  'use strict';

  var NGRAM = 3;
  var SPAN_NGRAM = 5;

  /* ================= 文本归一化 ================= */
  function cleanText(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalize(text) {
    return cleanText(text).toLowerCase();
  }

  function toLines(text) {
    return normalize(text).split('\n');
  }

  function toNgrams(text, n) {
    n = n || NGRAM;
    var s = text.replace(/[ \n]/g, '');
    var out = {};
    if (s.length < n) {
      if (s.length > 0) out[s] = 1;
      return out;
    }
    for (var i = 0; i <= s.length - n; i++) {
      var g = s.substr(i, n);
      out[g] = (out[g] || 0) + 1;
    }
    return out;
  }

  function countsIntersection(a, b) {
    var sum = 0;
    for (var k in a) {
      if (b[k]) sum += Math.min(a[k], b[k]);
    }
    return sum;
  }

  function countsSum(m) {
    var sum = 0;
    for (var k in m) sum += m[k];
    return sum;
  }

  function similarity(a, b, n) {
    var na = normalize(a), nb = normalize(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;
    if ((n || NGRAM) !== NGRAM) return legacySimilarity(na, nb, n);
    return similarityIdx(makeIndex(na), makeIndex(nb));
  }

  // 旧实现：字符串键词频表，保留给超短文本等退化场景
  function legacySimilarity(na, nb, n) {
    var ga = toNgrams(na, n), gb = toNgrams(nb, n);
    var inter = countsIntersection(ga, gb);
    var union = countsSum(ga) + countsSum(gb) - inter;
    if (union === 0) return 0;
    return Math.round((inter / union) * 1000) / 10;
  }

  /* ================= 姓名 / 联系方式 归一化 ================= */
  function toHalfWidth(s) {
    return s.replace(/[\uff01-\uff5e]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    }).replace(/\u3000/g, ' ');
  }

  // 姓名归一化：去空白、全角转半角、转小写，便于「张 伟」与「张伟」判为同名
  function normalizeName(s) {
    return toHalfWidth(String(s == null ? '' : s))
      .replace(/[\s·．.、,，_\-—]+/g, '')
      .toLowerCase();
  }

  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var PHONE_RE = /\d[\d\s\-()（）*xX转分机ext]{5,}\d/gi;

  // 从「13800000001 / a@b.com」这类混合字段中抽出手机号与邮箱
  function contactTokens(s) {
    var str = toHalfWidth(String(s == null ? '' : s));
    var out = { phones: [], emails: [] };
    var em = str.match(EMAIL_RE);
    if (em) {
      em.forEach(function (e) {
        var v = e.toLowerCase();
        if (out.emails.indexOf(v) < 0) out.emails.push(v);
      });
    }
    var rest = str.replace(EMAIL_RE, ' ');
    var ph = rest.match(PHONE_RE);
    if (ph) {
      ph.forEach(function (p) {
        var digits = p.replace(/[^\d]/g, '');
        if (digits.length < 7 || digits.length > 15) return;
        if (out.phones.indexOf(digits) < 0) out.phones.push(digits);
      });
    }
    return out;
  }

  function normalizePhone(s) {
    var t = contactTokens(s).phones;
    return t.length ? t[0] : '';
  }

  function intersectTokens(a, b) {
    var phones = a.phones.filter(function (x) { return b.phones.indexOf(x) >= 0; });
    var emails = a.emails.filter(function (x) { return b.emails.indexOf(x) >= 0; });
    return { phones: phones, emails: emails, any: phones.length > 0 || emails.length > 0 };
  }

  /* ================= 查重判定规则 ================= */
  var DUP_RULES = {
    high:    { rank: 4, label: '高度疑似重复', hint: '姓名相同，且联系方式或正文重复' },
    name:    { rank: 3, label: '疑似同名',     hint: '姓名与历史简历完全相同' },
    contact: { rank: 2, label: '联系方式相同', hint: '手机号或邮箱与历史简历相同' },
    content: { rank: 1, label: '正文重复',     hint: '正文相似度超过阈值' }
  };

  function buildReasons(sameName, inter, sim, threshold, hits, hasText) {
    var r = [];
    if (sameName) r.push('姓名相同');
    inter.phones.forEach(function (p) { r.push('手机号相同 ' + p); });
    inter.emails.forEach(function (e) { r.push('邮箱相同 ' + e); });
    if (hasText) {
      if (sim >= threshold) r.push('正文相似度 ' + sim + '% ≥ 阈值 ' + threshold + '%');
      else if (sim > 0) r.push('正文相似度 ' + sim + '%');
      if (hits.length) r.push('共享完整语句 ' + hits.length + ' 处');
      if (!hits.length && sim >= threshold) r.push('无整句相同，仅内容高度雷同');
    }
    return r;
  }

  // 单条比对：probe 与 other（other 需含 name/contact/text，可选 index 加速）
  function compareWith(probe, other, threshold) {
    var sameName = !!(probe.name && probe.name === normalizeName(other.name));
    var inter = intersectTokens(probe.contacts, other.contacts || contactTokens(other.contact));
    var hasText = !!(probe.text && other.text);
    var sim = 0, hits = [];
    if (hasText) {
      var pi = probe.index, oi = other.index;
      if (pi && oi) {
        sim = similarityIdx(pi, oi);
        hits = sharedSentencesIdx(pi, oi);
      } else {
        sim = similarity(probe.text, other.text);
        hits = sharedSentences(probe.text, other.text);
      }
    }
    var level = null;
    if (sameName && (inter.any || sim >= threshold)) level = 'high';
    else if (sameName) level = 'name';
    else if (inter.any) level = 'contact';
    else if (sim >= threshold) level = 'content';

    return {
      sameName: sameName,
      sameContact: inter.any,
      sim: sim,
      hits: hits,
      level: level,
      reasons: buildReasons(sameName, inter, sim, threshold, hits, hasText)
    };
  }

  function makeProbe(name, contact, text) {
    var t = cleanText(text);
    return {
      name: normalizeName(name),
      contacts: contactTokens(contact),
      text: t,
      index: makeIndex(t)
    };
  }

  /**
   * 姓名查重：把「待录入的简历」与「历史简历库」逐条比对，按命中强度排序。
   * @param {{name:string, contact:string, text:string}} probe 待查简历
   * @param {Array<{id:string,name:string,contact:string,text:string}>} list 历史简历
   * @param {number} threshold 正文相似度阈值
   * @param {string} [excludeId] 编辑场景下排除自身
   * @returns {Array<{id,level,label,rank,sim,hits,reasons,sameName,sameContact}>}
   */
  function checkDuplicate(probe, list, threshold, excludeId) {
    var p = (probe && probe.contacts) ? probe : makeProbe(probe && probe.name, probe && probe.contact, probe && probe.text);
    if (!p.name && !p.contacts.phones.length && !p.contacts.emails.length) return [];
    var out = [];
    (list || []).forEach(function (o) {
      if (!o) return;
      if (excludeId && o.id === excludeId) return;
      var r = compareWith(p, o, threshold);
      if (!r.level) return;
      out.push({
        id: o.id,
        level: r.level,
        label: DUP_RULES[r.level].label,
        rank: DUP_RULES[r.level].rank,
        sim: r.sim,
        hits: r.hits.length,
        reasons: r.reasons,
        sameName: r.sameName,
        sameContact: r.sameContact
      });
    });
    out.sort(function (a, b) {
      return b.rank - a.rank || b.sim - a.sim || String(a.id).localeCompare(String(b.id));
    });
    return out;
  }

  /* ================= 共享语句 & 差异高亮 ================= */
  var NOISE_PREFIX = /^(?:[0-9]{1,4}\s*[、.．\-·)）]|[(（]?\s*[0-9]{1,2}\s*[)）]|第\s*[0-9一二三四五六七八九十]+\s*[章节页部分讲]|page\s*[0-9]+)/i;
  var NOISE_HEAD = /^(联系电话|联系方式|联系地址|手机号码?|电\s*话|邮箱|电子邮箱|e-?mail|地\s*址|邮\s*编|求职意向|期望(?:职位|岗位|薪资)|出生(?:日期)?|性\s*别|年\s*龄|政治面貌|身份证)/i;

  function isPureLine(line) {
    if (!line) return false;
    if (line.length < 6) return false;
    if (NOISE_PREFIX.test(line)) return false;
    if (NOISE_HEAD.test(line)) return false;
    return true;
  }

  function sharedSentences(a, b) {
    var la = toLines(a), lb = toLines(b);
    var map = {};
    lb.forEach(function (line) { if (isPureLine(line)) map[line] = (map[line] || 0) + 1; });
    var hits = [];
    la.forEach(function (line) {
      if (isPureLine(line) && map[line]) {
        hits.push(line);
        map[line]--;
      }
    });
    return hits;
  }

  /* ================= 批量比对：文档索引 ================= */
  /**
   * 把一段简历预编译成可复用的比对索引。
   * 3-gram 用 3 个 UTF-16 码元编码成 48 位整数（精确可表示于 double），
   * 因此不存在哈希碰撞，相似度结果与逐对现算完全一致。
   */
  function makeIndex(text) {
    var norm = normalize(text);
    var idx = { norm: norm, short: true, keys: null, counts: null, gramSum: 0, lines: [], lineMap: null };
    if (!norm) return idx;
    idx.lines = norm.split('\n');
    var s = norm.replace(/[ \n]/g, '');
    if (s.length < NGRAM) return idx;

    var cnt = new Map();
    var sum = 0;
    for (var i = 0; i <= s.length - NGRAM; i++) {
      var k = s.charCodeAt(i) * 4294967296 + s.charCodeAt(i + 1) * 65536 + s.charCodeAt(i + 2);
      var c = (cnt.get(k) || 0) + 1;
      cnt.set(k, c);
      sum += 1;
    }
    var m = cnt.size;
    var ks = new Float64Array(m), cs = new Int32Array(m), p = 0;
    cnt.forEach(function (v, key) { ks[p] = key; cs[p] = v; p++; });

    var perm = new Array(m);
    for (i = 0; i < m; i++) perm[i] = i;
    perm.sort(function (x, y) { return ks[x] - ks[y]; });

    var keys = new Float64Array(m), counts = new Int32Array(m);
    for (i = 0; i < m; i++) { keys[i] = ks[perm[i]]; counts[i] = cs[perm[i]]; }
    idx.short = false;
    idx.keys = keys;
    idx.counts = counts;
    idx.gramSum = sum;
    return idx;
  }

  // 两个有序 gram 表的多重集交集：sum(min(countA, countB))
  function intersectIdx(a, b) {
    var ka = a.keys, ca = a.counts, kb = b.keys, cb = b.counts;
    var i = 0, j = 0, total = 0;
    var n = ka.length, m = kb.length;
    while (i < n && j < m) {
      var x = ka[i], y = kb[j];
      if (x < y) { i++; }
      else if (y < x) { j++; }
      else { total += ca[i] < cb[j] ? ca[i] : cb[j]; i++; j++; }
    }
    return total;
  }

  function pureLineMap(idx) {
    if (!idx.lineMap) {
      var map = Object.create(null);
      idx.lines.forEach(function (l) { if (isPureLine(l)) map[l] = (map[l] || 0) + 1; });
      idx.lineMap = map;
    }
    return idx.lineMap;
  }

  function similarityIdx(a, b) {
    if (!a.norm || !b.norm) return 0;
    if (a.norm === b.norm) return 100;
    if (a.short || b.short) return legacySimilarity(a.norm, b.norm);
    var inter = intersectIdx(a, b);
    var union = a.gramSum + b.gramSum - inter;
    if (union === 0) return 0;
    return Math.round((inter / union) * 1000) / 10;
  }

  function sharedSentencesIdx(a, b) {
    if (!a.lines.length || !b.lines.length) return [];
    var mb = pureLineMap(b);
    var used = Object.create(null);
    var hits = [];
    for (var i = 0; i < a.lines.length; i++) {
      var line = a.lines[i];
      if (!mb[line] || !isPureLine(line)) continue;
      var k = (used[line] = (used[line] || 0) + 1);
      if (k <= mb[line]) hits.push(line);
    }
    return hits;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 保留原文，逐行记录行首偏移
  function rawLines(raw) {
    var lines = [], pos = 0;
    raw.split('\n').forEach(function (l) {
      lines.push({ text: l, start: pos, end: pos + l.length });
      pos += l.length + 1;
    });
    return lines;
  }

  function gramSet(lowerText) {
    var set = Object.create(null);
    for (var i = 0; i + SPAN_NGRAM <= lowerText.length; i++) {
      set[lowerText.substr(i, SPAN_NGRAM)] = 1;
    }
    return set;
  }

  // 种子延伸法：找出 self 中所有在 other 里出现过的连续片段
  function commonSpans(lowerSelf, setOther, minLen) {
    var spans = [], p = 0;
    while (p < lowerSelf.length) {
      if (p + SPAN_NGRAM > lowerSelf.length || !setOther[lowerSelf.substr(p, SPAN_NGRAM)]) { p++; continue; }
      var q = p + SPAN_NGRAM;
      while (q < lowerSelf.length && setOther[lowerSelf.substr(q, SPAN_NGRAM)]) q++;
      if (q - p >= minLen) spans.push([p, q]);
      p = q;
    }
    return spans;
  }

  function markSpans(line, spans) {
    if (!spans.length) return escHtml(line);
    var out = '', last = 0;
    spans.forEach(function (s) {
      if (s[0] > last) out += escHtml(line.slice(last, s[0]));
      out += '<mark class="hl">' + escHtml(line.slice(s[0], s[1])) + '</mark>';
      last = s[1];
    });
    if (last < line.length) out += escHtml(line.slice(last));
    return out;
  }

  /**
   * 双向差异高亮：整句相同的行整体标黄，其余部分按字符 n-gram 片段标黄。
   */
  function highlightDiff(title, textA, textB) {
    var shared = sharedSentences(textA, textB);
    var keyMap = Object.create(null);
    shared.forEach(function (s) { keyMap[s] = true; });

    var rawA = String(textA == null ? '' : textA).replace(/\r\n?/g, '\n');
    var rawB = String(textB == null ? '' : textB).replace(/\r\n?/g, '\n');
    var loA = rawA.toLowerCase(), loB = rawB.toLowerCase();
    var spansA = commonSpans(loA, gramSet(loB), 8);
    var spansB = commonSpans(loB, gramSet(loA), 8);

    function render(raw, spans) {
      return rawLines(raw).map(function (ln) {
        var key = cleanText(ln.text).toLowerCase();
        if (key && keyMap[key] && ln.text.length >= 6) {
          return '<mark class="hl">' + escHtml(ln.text) + '</mark>';
        }
        var local = [];
        spans.forEach(function (s) {
          var a = Math.max(s[0], ln.start);
          var b = Math.min(s[1], ln.end);
          if (b - a >= 4) local.push([a - ln.start, b - ln.start]);
        });
        return markSpans(ln.text, local);
      }).join('\n');
    }

    return {
      titleA: title,
      htmlA: render(rawA, spansA),
      htmlB: render(rawB, spansB),
      intersects: shared.length,
      spanA: spansA.length,
      spanB: spansB.length
    };
  }

  global.Sim = {
    clean: cleanText,
    normalize: normalize,
    similarity: similarity,
    sharedSentences: sharedSentences,
    makeIndex: makeIndex,
    similarityIdx: similarityIdx,
    sharedSentencesIdx: sharedSentencesIdx,
    highlightDiff: highlightDiff,
    normalizeName: normalizeName,
    normalizePhone: normalizePhone,
    contactTokens: contactTokens,
    makeProbe: makeProbe,
    compareWith: compareWith,
    checkDuplicate: checkDuplicate,
    DUP_RULES: DUP_RULES,
    /* 判定说明文案：上传拦截弹窗要展示给用户看 */
    DUP_HINT: {
      high: DUP_RULES.high.hint,
      name: DUP_RULES.name.hint,
      contact: DUP_RULES.contact.hint,
      content: DUP_RULES.content.hint
    }
  };
})(window);
