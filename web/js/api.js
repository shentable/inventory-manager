/* ===== API 封装：统一 fetch、token、401 处理、网络错误 ===== */
(function () {
  'use strict';

  var t = window.I18N && window.I18N.t ? window.I18N.t : function (s) { return s; };

  /* 后端错误 detail 翻译：对象含 code 时优先 errcode.code；中文纯字符串查字典，查不到回退原文 */
  function translateDetail(detail) {
    if (!detail) { return ''; }
    if (typeof detail === 'string') { return t(detail); }
    if (typeof detail === 'object') {
      if (detail.code) {
        var coded = t('errcode.' + detail.code);
        if (coded !== 'errcode.' + detail.code) { return coded; }
      }
      var msg = detail.message || detail.msg;
      if (msg) { return t(msg); }
    }
    return '';
  }

  var TOKEN_KEY = 'sandwich_token';
  var USER_KEY = 'sandwich_user';
  var CACHE_PREFIX = 'sandwich_api_cache_v1:';
  var API_BASE = (window.SANDWICH_API_BASE || '/api').replace(/\/$/, '');

  function tokenScope() {
    var token = store.getToken();
    if (!token) { return 'public'; }
    var hash = 5381;
    for (var i = 0; i < token.length; i++) { hash = ((hash << 5) + hash) ^ token.charCodeAt(i); }
    return 'user-' + (hash >>> 0).toString(16);
  }

  function cacheKey(path) { return CACHE_PREFIX + tokenScope() + ':' + encodeURIComponent(path); }
  function readCache(path) {
    try {
      var value = JSON.parse(localStorage.getItem(cacheKey(path)) || 'null');
      return value && value.path === path ? value : null;
    } catch (e) { return null; }
  }
  function writeCache(path, etag, data) {
    try {
      localStorage.setItem(cacheKey(path), JSON.stringify({
        path: path, etag: etag || '', data: data, synced_at: new Date().toISOString()
      }));
    } catch (e) { /* 空间不足时仍允许在线使用 */ }
  }
  function cachedPaths() {
    var prefix = CACHE_PREFIX + tokenScope() + ':';
    var paths = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(prefix) !== 0) { continue; }
        var record = JSON.parse(localStorage.getItem(key) || 'null');
        if (record && record.path && paths.indexOf(record.path) < 0) { paths.push(record.path); }
      }
    } catch (e) { /* ignore */ }
    return paths;
  }
  function latestCachedAt() {
    var latest = null;
    cachedPaths().forEach(function (path) {
      var record = readCache(path);
      if (record && record.synced_at && (!latest || record.synced_at > latest)) { latest = record.synced_at; }
    });
    return latest;
  }
  function invalidateCache() {
    var prefix = CACHE_PREFIX + tokenScope() + ':';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(prefix) !== 0) { continue; }
        var record = JSON.parse(localStorage.getItem(key) || 'null');
        if (record) { record.etag = ''; localStorage.setItem(key, JSON.stringify(record)); }
      }
    } catch (e) { /* ignore */ }
  }

  var store = {
    getToken: function () {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    },
    setToken: function (t) {
      try {
        if (t) { localStorage.setItem(TOKEN_KEY, t); } else { localStorage.removeItem(TOKEN_KEY); }
      } catch (e) { /* ignore */ }
    },
    getUser: function () {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
    },
    setUser: function (u) {
      try {
        if (u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); } else { localStorage.removeItem(USER_KEY); }
      } catch (e) { /* ignore */ }
    },
    clear: function () { this.setToken(''); this.setUser(null); }
  };

  var connectivity = {
    online: navigator.onLine !== false,
    syncing: false,
    lastSyncedAt: latestCachedAt()
  };
  try {
    if (window.SandwichNative && window.SandwichNative.isBackendOnline() === false) {
      connectivity.online = false;
    }
  } catch (e) { /* browser build */ }

  function emitConnectivity() {
    window.dispatchEvent(new CustomEvent('sandwich-sync-state', { detail: {
      online: connectivity.online,
      syncing: connectivity.syncing,
      lastSyncedAt: connectivity.lastSyncedAt
    } }));
  }
  function markOffline() {
    connectivity.online = false;
    connectivity.syncing = false;
    if (window.UI && window.UI.showOffline) { window.UI.showOffline(connectivity.lastSyncedAt); }
    emitConnectivity();
  }
  function markOnline(syncedAt) {
    connectivity.online = true;
    connectivity.syncing = false;
    connectivity.lastSyncedAt = syncedAt || new Date().toISOString();
    if (window.UI && window.UI.hideOffline) { window.UI.hideOffline(); }
    emitConnectivity();
  }
  function offlineError() {
    var err = new Error(t('数据未同步，离线状态禁止写操作'));
    err.network = true;
    err.readonly = true;
    if (window.UI && window.UI.showOffline) { window.UI.showOffline(connectivity.lastSyncedAt); }
    if (window.UI && window.UI.toast) { window.UI.toast(err.message, 'warn'); }
    return err;
  }

  function noteReadSuccess(syncedAt, opts) {
    if (opts.revalidate) { return; }
    if (connectivity.online) { markOnline(syncedAt); }
    else { setTimeout(reconnect, 0); }
  }

  function request(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var isGet = method === 'GET';
    var cached = isGet ? readCache(path) : null;
    if (!isGet && !connectivity.online) { return Promise.reject(offlineError()); }
    var headers = { 'Content-Type': 'application/json' };
    var token = store.getToken();
    if (token) { headers['Authorization'] = 'Bearer ' + token; }
    if (isGet && cached && cached.etag) { headers['If-None-Match'] = cached.etag; }

    var url = API_BASE + path;
    var init = {
      method: method,
      headers: headers,
      cache: 'no-store'
    };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = JSON.stringify(opts.body);
    }

    return fetch(url, init).then(function (res) {
      if (res.status === 304 && cached) {
        noteReadSuccess(cached.synced_at, opts);
        return cached.data;
      }
      // 登录相关接口的 401 = PIN 错误，交由调用方处理
      var isLogin = path.indexOf('/auth/login') === 0;
      if (res.status === 401 && !isLogin) {
        store.clear();
        if (!location.hash || location.hash.indexOf('#/login') !== 0) {
          location.hash = '#/login';
        }
        if (window.UI && window.UI.toast) {
          window.UI.toast(t('登录已过期，请重新登录'), 'info');
        }
        var authErr = new Error(t('未登录'));
        authErr.auth = true;
        authErr.silent = true;
        throw authErr;
      }
      if (res.status === 204) {
        if (!isGet) { invalidateCache(); }
        if (isGet) { noteReadSuccess(null, opts); }
        else if (!opts.revalidate) { markOnline(); }
        return null;
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = t('请求失败 ({status})', { status: res.status });
          if (data && data.detail) {
            var detailMsg = translateDetail(data.detail);
            if (detailMsg) { msg = detailMsg; }
          } else if (data && data.message) { msg = t(data.message); }
          var err = new Error(msg);
          err.status = res.status;
          err.detail = data && data.detail;
          throw err;
        }
        if (isGet) {
          writeCache(path, res.headers.get('ETag'), data);
        } else {
          invalidateCache();
        }
        if (!opts.revalidate) { markOnline(); }
        return data;
      });
    }).catch(function (err) {
      if (err && (err.auth || err.status)) { throw err; }
      markOffline();
      if (isGet && cached && !opts.noFallback) { return cached.data; }
      var netErr = new Error(isGet ? t('无法连接服务器，且没有可用的本地缓存') : t('数据未同步，离线状态禁止写操作'));
      netErr.network = true;
      throw netErr;
    });
  }

  var reconnecting = null;
  function reconnect() {
    if (reconnecting) { return reconnecting; }
    connectivity.online = false;
    connectivity.syncing = true;
    emitConnectivity();
    reconnecting = fetch(API_BASE + '/health', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) { throw new Error('health ' + res.status); }
      return Promise.all(cachedPaths().map(function (path) {
        return request(path, { revalidate: true, noFallback: true });
      }));
    }).then(function () {
      markOnline();
      window.dispatchEvent(new CustomEvent('sandwich-data-updated'));
      return true;
    }).catch(function () {
      markOffline();
      return false;
    }).then(function (ok) {
      reconnecting = null;
      return ok;
    });
    return reconnecting;
  }

  var api = {
    store: store,
    connectivity: connectivity,
    reconnect: reconnect,
    setConnectivity: function (online) {
      if (online) { return reconnect(); }
      markOffline();
      return Promise.resolve(false);
    },
    canWrite: function () { return connectivity.online && !connectivity.syncing; },

    get: function (path) { return request(path); },
    post: function (path, body) { return request(path, { method: 'POST', body: body }); },
    patch: function (path, body) { return request(path, { method: 'PATCH', body: body }); },

    // 认证
    loginOptions: function () { return request('/auth/login-options'); },
    login: function (username, pin) { return request('/auth/login', { method: 'POST', body: { username: username, pin: pin } }); },
    me: function () { return request('/auth/me'); },
    changePin: function (currentPin, newPin) {
      return request('/auth/change-pin', { method: 'POST', body: { current_pin: currentPin, new_pin: newPin } });
    },
    dashboard: function () { return request('/dashboard'); },
    consumption: function (days, leadDays, coverageDays) {
      return request('/consumption?days=' + days + '&lead_days=' + leadDays + '&coverage_days=' + coverageDays);
    },

    // 库存品
    items: function (includeInactive) {
      return request('/items?include_inactive=' + (includeInactive ? 'true' : 'false'));
    },
    createItem: function (body) { return request('/items', { method: 'POST', body: body }); },
    updateItem: function (id, body) { return request('/items/' + id, { method: 'PATCH', body: body }); },

    // 库存与效期
    stock: function () { return request('/stock'); },
    receiveStock: function (body) { return request('/stock/receive', { method: 'POST', body: body }); },
    itemBatches: function (id) { return request('/items/' + id + '/batches'); },
    expiry: function (days) { return request('/expiry?days=' + days); },

    // 盘点
    createCount: function (body) { return request('/counts', { method: 'POST', body: body }); },
    counts: function (status, countType, days) {
      var params = [];
      if (status) { params.push('status=' + encodeURIComponent(status)); }
      if (countType) { params.push('count_type=' + encodeURIComponent(countType)); }
      if (days) { params.push('days=' + encodeURIComponent(days)); }
      return request('/counts' + (params.length ? '?' + params.join('&') : ''));
    },
    countDetail: function (id) { return request('/counts/' + id); },
    updateCount: function (id, body) { return request('/counts/' + id, { method: 'PATCH', body: body }); },
    verifyCount: function (id, body) { return request('/counts/' + id + '/verify', { method: 'POST', body: body }); },
    rejectCount: function (id) { return request('/counts/' + id + '/reject', { method: 'POST' }); },
    previewCountComparison: function (body) { return request('/count-comparisons/preview', { method: 'POST', body: body }); },
    confirmCountComparison: function (body) { return request('/count-comparisons', { method: 'POST', body: body }); },
    countComparison: function (id) { return request('/count-comparisons/' + id); },

    // 报损
    createWaste: function (body) { return request('/waste', { method: 'POST', body: body }); },
    waste: function (status) { return request('/waste' + (status ? '?status=' + status : '')); },
    confirmWaste: function (id) { return request('/waste/' + id + '/confirm', { method: 'POST' }); },
    rejectWaste: function (id) { return request('/waste/' + id + '/reject', { method: 'POST' }); },

    // 采购
    createPurchase: function (body) { return request('/purchases', { method: 'POST', body: body }); },
    purchases: function (status) { return request('/purchases' + (status ? '?status=' + status : '')); },
    receivePurchase: function (id, body) { return request('/purchases/' + id + '/receive', { method: 'POST', body: body }); },
    cancelPurchase: function (id) { return request('/purchases/' + id + '/cancel', { method: 'POST' }); },

    // 用户
    users: function () { return request('/users'); },
    createUser: function (body) { return request('/users', { method: 'POST', body: body }); },
    updateUser: function (id, body) { return request('/users/' + id, { method: 'PATCH', body: body }); }
  };

  window.API = api;
})();
