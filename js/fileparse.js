/* 简历文件解析：.txt / .pdf / .docx
 * .doc（Word 97-2003 二进制）为闭源 OLE2 复合文档，浏览器无法可靠解析，
 * 需另存为 .docx 或 .txt 后再上传。 */
(function (global) {
  'use strict';

  var MAX_CHARS = 120000;   // 单份简历正文上限，防止超大文件卡死
  var MAX_PAGES = 40;       // PDF 最多解析页数
  var PDF_LIB = 'js/vendor/pdf.min.js';
  var PDF_WORKER = 'js/vendor/pdf.worker.min.js';

  var pdfReady = null;

  function ext(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /* pdf.js 体积约 320KB，按需懒加载，不拖慢首页 */
  function loadPdfLib() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfReady) return pdfReady;
    pdfReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDF_LIB;
      s.onload = function () {
        if (!global.pdfjsLib) { reject(new Error('PDF 组件加载异常')); return; }
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        resolve(global.pdfjsLib);
      };
      s.onerror = function () { reject(new Error('无法加载 PDF 解析组件 pdf.js')); };
      document.head.appendChild(s);
    });
    return pdfReady;
  }

  /* 优先按 UTF-8 严格解码，失败回退 GBK（Windows 导出的 txt 常为 GBK） */
  function decodeBuf(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try {
        return new TextDecoder('gb18030').decode(buf);
      } catch (e2) {
        return new TextDecoder('utf-8').decode(buf);
      }
    }
  }

  function cleanText(t) {
    return String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ---------- .txt ---------- */
  function readTxt(file) {
    return file.arrayBuffer().then(function (ab) {
      return cleanText(decodeBuf(ab));
    });
  }

  /* ---------- .pdf ---------- */
  function readPdf(file) {
    return file.arrayBuffer().then(function (ab) {
      return loadPdfLib().then(function (lib) {
        return lib.getDocument({
          data: ab,
          isEvalSupported: false,
          useSystemFonts: true,
          useWorkerFetch: false,
          verbosity: 0
        }).promise;
      }).then(function (doc) {
        var parts = [];
        var i = 1;
        function step() {
          if (i > Math.min(doc.numPages, MAX_PAGES)) {
            return Promise.resolve(doc.numPages);
          }
          return doc.getPage(i).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var s = '';
              for (var k = 0; k < tc.items.length; k++) {
                var it = tc.items[k];
                if (typeof it.str !== 'string') continue;
                s += it.str;
                if (it.hasEOL) s += '\n';
              }
              parts.push(s);
            }).then(function () { page.cleanup(); });
          }).then(function () { i++; return step(); });
        }
        return step().then(function (n) {
          try { doc.destroy(); } catch (e) { /* 忽略 */ }
          if (n < doc.numPages) parts.push('（仅解析前 ' + n + ' 页）');
          return cleanText(parts.join('\n'));
        });
      });
    });
  }

  /* ---------- .docx ----------
   * docx 本质是 zip：解析中央目录取 word/document.xml，再用
   * DecompressionStream('deflate-raw') 解压，无需任何第三方库。 */
  function unzipText(buf, entryName) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('不是有效的 docx（zip）文件'));

    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);

    function inflate(comp, method) {
      if (method === 0) return Promise.resolve(comp);
      if (method !== 8) return Promise.reject(new Error('不支持的压缩方式 ' + method));
      if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('当前浏览器不支持解压 docx，请改用 .txt'));
      }
      var ds = new DecompressionStream('deflate-raw');
      return new Response(new Blob([comp]).stream().pipeThrough(ds))
        .arrayBuffer()
        .then(function (b) { return new Uint8Array(b); });
    }

    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) return Promise.reject(new Error('docx 目录损坏'));
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nLen = dv.getUint16(p + 28, true);
      var eLen = dv.getUint16(p + 30, true);
      var cLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nLen));
      if (name === entryName) {
        var lnLen = dv.getUint16(lho + 26, true);
        var leLen = dv.getUint16(lho + 28, true);
        var start = lho + 30 + lnLen + leLen;
        return inflate(u8.subarray(start, start + csize), method)
          .then(function (out) { return new TextDecoder('utf-8').decode(out); });
      }
      p += 46 + nLen + eLen + cLen;
    }
    return Promise.reject(new Error('docx 中找不到正文文件'));
  }

  function xmlToText(xml) {
    return xml
      /* Choice 与 Fallback 内容重复，只保留 Choice */
      .replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
      /* 文本框锚点坐标是数字，会污染正文 */
      .replace(/<wp:posOffset>[^<]*<\/wp:posOffset>/g, '')
      .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:p\b[^>]*\/>/g, '\n')
      .replace(/<w:p\b[^>]*>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
      .replace(/&amp;/g, '&');
  }

  function readDocx(file) {
    return file.arrayBuffer().then(function (ab) {
      return unzipText(ab, 'word/document.xml').then(function (xml) {
        return cleanText(xmlToText(xml));
      });
    });
  }

  /* ---------- 对外接口 ---------- */
  function parse(file) {
    var e = ext(file.name);
    var job;
    if (e === 'txt' || e === 'md' || e === 'csv') job = readTxt(file);
    else if (e === 'pdf') job = readPdf(file);
    else if (e === 'docx') job = readDocx(file);
    else if (e === 'doc') {
      return Promise.reject(new Error('.doc 是旧版二进制格式，无法在浏览器解析，请另存为 .docx 或 .txt'));
    } else {
      return Promise.reject(new Error('不支持的格式 .' + (e || '?')));
    }
    return job.then(function (text) {
      if (!text) throw new Error('未能提取到文字内容（可能是扫描版图片 PDF）');
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n（内容过长已截断）';
      return text;
    });
  }

  global.FileParse = { parse: parse, ext: ext };
})(window);
