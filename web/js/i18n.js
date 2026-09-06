/* ===== i18n 框架：gettext 风格（中文原文即 key），zh-CN 默认，en 查字典 ===== */
(function () {
  'use strict';

  var LANG_KEY = 'sandwich_lang';
  var LANGS = { 'zh-CN': '中文', 'en': 'English' };
  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function detectLang() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }
    if (saved && has(LANGS, saved)) { return saved; }
    // 未显式选择过时嗅探浏览器/系统语言：中文环境 zh-CN，其余 en
    var nav = '';
    try { nav = (navigator.language || '').toLowerCase(); } catch (e) { /* ignore */ }
    return nav.indexOf('zh') === 0 ? 'zh-CN' : 'en';
  }

  var lang = detectLang();

  /* 字典在 i18n.js 之后加载（en-core.js / en-app.js），首次 t() 时才合并 */
  var dict = null;
  function mergedDict() {
    if (dict) { return dict; }
    dict = {};
    var sources = [window.I18N_EN_CORE, window.I18N_EN_APP];
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      if (!src) { continue; }
      for (var k in src) {
        if (!has(src, k)) { continue; }
        if (has(dict, k) && dict[k] !== src[k] && window.console && console.warn) {
          console.warn('[i18n] duplicate key, en-app wins:', k);
        }
        dict[k] = src[k];
      }
    }
    return dict;
  }

  function interpolate(str, vars) {
    if (!vars) { return str; }
    for (var k in vars) {
      if (has(vars, k)) { str = str.split('{' + k + '}').join(String(vars[k])); }
    }
    return str;
  }

  function t(key, vars) {
    var str = key;
    if (lang === 'en') {
      var d = mergedDict();
      if (has(d, key)) { str = d[key]; }
    }
    return interpolate(str, vars);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(d) {
    d = d instanceof Date ? d : new Date(d);
    if (lang === 'en') { return MONTHS_EN[d.getMonth()] + ' ' + d.getDate(); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtDateTime(d) {
    d = d instanceof Date ? d : new Date(d);
    return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function setMeta(name, content) {
    var el = document.querySelector('meta[name="' + name + '"]');
    if (el) { el.setAttribute('content', content); }
  }

  function applyDocumentMeta() {
    document.documentElement.lang = lang;
    document.title = t('飨拓™库存管理');
    setMeta('description', t('飨拓™库存管理'));
    setMeta('apple-mobile-web-app-title', t('飨拓™库存管理'));
  }

  function setLang(next) {
    if (!has(LANGS, next)) { return; }
    try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* ignore */ }
    lang = next;
    applyDocumentMeta();
    location.reload();
  }

  window.I18N = {
    LANGS: LANGS,
    t: t,
    getLang: function () { return lang; },
    setLang: setLang,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime
  };

  /* <html lang> 立即生效；title/meta 需等字典脚本加载完（DOMContentLoaded 前同步脚本均已执行） */
  document.documentElement.lang = lang;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyDocumentMeta);
  } else {
    applyDocumentMeta();
  }
})();
