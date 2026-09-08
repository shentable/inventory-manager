/* ===== 飨拓™库存管理 — SPA 主程序：hash 路由 + 全部页面 ===== */
(function () {
  'use strict';

  var h = window.UI.h;
  var API = window.API;
  // 兼容旧 PWA 缓存的混合版本：旧 index.html 不包含 i18n 脚本，
  // 但可能在升级时先拿到新 app.js。此时先以中文启动，避免整页卡死。
  var I18N = window.I18N || (function () {
    function pad2(value) { return value < 10 ? '0' + value : String(value); }
    function interpolate(text, vars) {
      if (!vars) { return text; }
      Object.keys(vars).forEach(function (key) {
        text = text.split('{' + key + '}').join(String(vars[key]));
      });
      return text;
    }
    function date(value) {
      value = value instanceof Date ? value : new Date(value);
      return (value.getMonth() + 1) + '月' + value.getDate() + '日';
    }
    return {
      LANGS: { 'zh-CN': '中文', en: 'English' },
      t: interpolate,
      getLang: function () { return 'zh-CN'; },
      setLang: function (next) {
        try { localStorage.setItem('sandwich_lang', next); } catch (e) { /* ignore */ }
        location.reload();
      },
      fmtDate: date,
      fmtDateTime: function (value) {
        value = value instanceof Date ? value : new Date(value);
        return date(value) + ' ' + pad2(value.getHours()) + ':' + pad2(value.getMinutes());
      }
    };
  })();

  var ROLE_LABEL = { staff: I18N.t('店员'), manager: I18N.t('店长'), admin: I18N.t('管理员') };
  var SOURCE_LABEL = { purchase: I18N.t('采购'), receive: I18N.t('直接入库'), init: I18N.t('初始'), adjust: I18N.t('调整') };

  /* ---------- 工具 ---------- */
  function fmtDate(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDateTime(s) {
    if (!s) { return '—'; }
    var d = new Date(s);
    if (isNaN(d.getTime())) { return String(s); }
    return I18N.fmtDateTime(d);
  }
  function fmtDateShort(s) {
    if (!s) { return '—'; }
    var d = new Date(s);
    if (isNaN(d.getTime())) { return String(s); }
    return I18N.fmtDate(d);
  }
  function pickName(o, keys) {
    if (!o) { return null; }
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v !== null && v !== undefined && v !== '') { return v; }
    }
    return null;
  }
  function itemName(it, fallback) {
    return it.item_name || (it.item && it.item.name) || fallback || I18N.t('商品');
  }
  function roleLabel(r) { return ROLE_LABEL[r] || r || ''; }

  /* 固定底部栏管理：children 传 null 表示移除。
     页面初次渲染时 root 尚未挂载到 DOM，setBar 返回栏元素，由路由在挂载 root 后追加；
     页内切换（root 已挂载）时直接插入。已离开页面的异步回调不会触碰真实 DOM。 */
  function clearAllBars() {
    var bars = document.querySelectorAll('.fixed-bar');
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].parentNode) { bars[i].parentNode.removeChild(bars[i]); }
    }
  }
  function setBar(root, children) {
    if (root && root.isConnected) {
      clearAllBars();
      root.classList.toggle('with-bar', !!children);
      if (!children) { return null; }
      var bar = window.UI.fixedBar(children);
      document.getElementById('app').appendChild(bar);
      return bar;
    }
    // root 未挂载（初次渲染中，或页面已离开）：不触碰真实 DOM
    if (!root || !children) { return null; }
    root.classList.toggle('with-bar', true);
    return window.UI.fixedBar(children);
  }

  /* ---------- 路由 ---------- */
  function parseHash() {
    var raw = location.hash || '#/';
    if (raw.charAt(0) !== '#') { raw = '#' + raw; }
    var body = raw.slice(1);
    if (!body) { body = '/'; }
    var qi = body.indexOf('?');
    var path = qi >= 0 ? body.slice(0, qi) : body;
    var qs = qi >= 0 ? body.slice(qi + 1) : '';
    if (path.charAt(0) !== '/') { path = '/' + path; }
    path = path.replace(/\/+$/, '') || '/';
    var params = {};
    if (qs) {
      qs.split('&').forEach(function (pair) {
        if (!pair) { return; }
        var i = pair.indexOf('=');
        var k = decodeURIComponent(i >= 0 ? pair.slice(0, i) : pair);
        var v = i >= 0 ? decodeURIComponent(pair.slice(i + 1)) : '';
        params[k] = v;
      });
    }
    return { path: path, params: params };
  }

  var routeGen = 0;

  function renderRoute() {
    var gen = ++routeGen;
    window.UI.closeOverlays();
    clearAllBars();

    var parsed = parseHash();
    var path = parsed.path;
    var params = parsed.params;
    var view = document.getElementById('view');
    var route = routes[path];

    var token = API.store.getToken();
    var user = API.store.getUser();

    // 登录守卫
    if (path !== '/login' && !token) {
      location.replace('#/login');
      return;
    }
    if (path === '/login' && token && user) {
      location.replace('#/');
      return;
    }
    // 角色守卫
    if (path !== '/login' && route && route.roles && (!user || route.roles.indexOf(user.role) < 0)) {
      window.UI.toast(I18N.t('无权限访问该页面'), 'warn');
      location.replace('#/');
      return;
    }
    if (!route) {
      route = { render: renderNotFound };
    }

    view.innerHTML = '';
    view.appendChild(window.UI.loadingView());

    Promise.resolve(route.render({ params: params, user: API.store.getUser() })).then(function (result) {
      if (gen !== routeGen) { return; }
      view.innerHTML = '';
      if (result && result.root) {
        view.appendChild(result.root);
      } else if (result instanceof Node) {
        view.appendChild(result);
      }
      if (result && result.bar) {
        document.getElementById('app').appendChild(result.bar);
      }
      window.scrollTo(0, 0);
      if (!API.connectivity.online) { window.UI.showOffline(API.connectivity.lastSyncedAt); }
    }).catch(function (err) {
      if (gen !== routeGen) { return; }
      if (err && err.silent) { return; } // 401 已自动跳登录
      console.error(err);
      view.innerHTML = '';
      view.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), function () {
        window.UI.hideOffline();
        renderRoute();
      }));
    });
  }

  function renderNotFound() {
    var root = h('div', { class: 'page' },
      window.UI.emptyView(I18N.t('页面不存在')),
      h('button', { class: 'btn btn-primary btn-block' }, I18N.t('回首页'))
    );
    root.querySelector('.btn').addEventListener('click', function () { location.hash = '#/'; });
    return { root: root };
  }

  /* ---------- 语言切换（🌐 chip：登录页右上角 + 首页头部） ---------- */
  function langChip() {
    var langs = I18N.LANGS || { 'zh-CN': '中文', 'en': 'English' };
    var current = I18N.getLang();
    var chip = h('button', { class: 'chip lang-switch', type: 'button', 'aria-label': I18N.t('选择语言') },
      '🌐 ' + (langs[current] || ''));
    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var options = Object.keys(langs).map(function (code) {
        return {
          label: langs[code] + (code === current ? I18N.t('（当前）') : ''),
          value: code,
          kind: code === current ? 'primary' : 'ghost'
        };
      });
      options.push({ label: I18N.t('取消'), value: null, kind: 'ghost' });
      window.UI.dialog({ title: I18N.t('选择语言'), options: options }).then(function (choice) {
        if (choice && choice !== current) { I18N.setLang(choice); }
      });
    });
    return chip;
  }

  function copyrightFooter() {
    return h('footer', { class: 'legal-footer' },
      h('span', {}, I18N.t('© 2026 飨拓™库存管理贡献者')),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      h('a', {
        class: 'source-link',
        href: 'https://github.com/shentable/inventory-manager',
        target: '_blank',
        rel: 'noopener noreferrer'
      },
      h('img', { src: '/github-mark.svg', alt: '', 'aria-hidden': 'true' }),
      I18N.t('源代码')),
      h('span', { 'aria-hidden': 'true' }, ' · AGPL-3.0')
    );
  }

  /* ================= 登录页 ================= */
  function renderLogin() {
    var root = h('div', { class: 'page login-page' },
      h('div', { class: 'login-lang', style: 'display:flex;justify-content:flex-end;' }, langChip()),
      h('div', { class: 'login-brand' },
        h('div', { class: 'login-logo' },
          h('img', { src: '/shantech-logo-512.png', alt: I18N.t('飨拓™') })
        ),
        h('div', { class: 'login-title' }, I18N.t('飨拓™库存管理')),
        h('div', { class: 'login-sub' }, I18N.t('选择账号 · 输入 PIN 登录'))
      )
    );
    var listWrap = h('div', { class: 'login-users' });
    root.appendChild(listWrap);
    root.appendChild(copyrightFooter());

    return API.loginOptions().then(function (data) {
      var users = (data && data.users) || [];
      if (!users.length) {
        listWrap.appendChild(window.UI.emptyView(I18N.t('未找到可用账号，请先联系管理员')));
        return { root: root };
      }
      users.forEach(function (u) {
        var name = u.display_name || u.username || '?';
        var card = h('button', { class: 'user-card' },
          h('div', { class: 'user-avatar' }, name.slice(0, 1)),
          h('div', { class: 'user-name' }, name),
          h('div', { class: 'user-sub' }, '@' + (u.username || '') + ' · ' + roleLabel(u.role))
        );
        card.addEventListener('click', function () {
          doLogin(u, name);
        });
        listWrap.appendChild(card);
      });
      return { root: root };
    }).catch(function (err) {
      listWrap.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderRoute));
      return { root: root };
    });
  }

  function doLogin(u, name) {
    window.UI.pinPrompt({
      title: I18N.t('登录 {name}', { name: name }),
      subtitle: I18N.t('输入 PIN（4-6 位数字）')
    }).then(function (pin) {
      if (!pin) { return null; }
      return API.login(u.username, pin);
    }).then(function (res) {
      if (!res) { return; }
      API.store.setToken(res.token);
      API.store.setUser(res.user);
      return ensurePinChanged(res.user).then(function () {
        var current = API.store.getUser();
        window.UI.toast(I18N.t('欢迎，{name}', { name: current.display_name || current.username }), 'success');
        location.hash = '#/';
      });
    }).catch(function (err) {
      if (err && err.status === 401) {
        window.UI.toast(I18N.t('PIN 不正确，请重试'), 'error');
      } else if (!(err && err.silent)) {
        window.UI.toast((err && err.message) || I18N.t('登录失败'), 'error');
      }
    });
  }

  function cancelRequiredPinChange() {
    API.store.clear();
    location.hash = '#/login';
    var err = new Error('已取消修改 PIN');
    err.silent = true;
    throw err;
  }

  function ensurePinChanged(user) {
    if (!user || !user.must_change_pin) { return Promise.resolve(user); }
    var currentPin = '';
    var newPin = '';
    return window.UI.pinPrompt({
      title: I18N.t('首次使用请修改 PIN'),
      subtitle: I18N.t('先输入当前临时 PIN')
    }).then(function (value) {
      if (!value) { cancelRequiredPinChange(); }
      currentPin = value;
      return window.UI.pinPrompt({ title: I18N.t('设置新 PIN'), subtitle: I18N.t('输入新的 4-6 位数字') });
    }).then(function (value) {
      if (!value) { cancelRequiredPinChange(); }
      newPin = value;
      return window.UI.pinPrompt({ title: I18N.t('确认新 PIN'), subtitle: I18N.t('再次输入新 PIN') });
    }).then(function (confirmation) {
      if (!confirmation) { cancelRequiredPinChange(); }
      if (confirmation !== newPin) {
        window.UI.toast(I18N.t('两次输入的新 PIN 不一致，请重试'), 'error');
        return ensurePinChanged(user);
      }
      return API.changePin(currentPin, newPin).then(function (res) {
        API.store.setToken(res.token);
        API.store.setUser(res.user);
        window.UI.toast(I18N.t('PIN 已更新'), 'success');
        return res.user;
      });
    });
  }

  /* ================= 首页 ================= */
  function renderHome() {
    var user = API.store.getUser();
    if (!user) {
      location.hash = '#/login';
      return { root: h('div', { class: 'page' }) };
    }
    var role = user.role || 'staff';
    var root = h('div', { class: 'page home-page' });

    var logout = h('button', { class: 'btn-logout' }, I18N.t('退出'));
    logout.addEventListener('click', function () {
      API.store.clear();
      location.hash = '#/login';
      window.UI.toast(I18N.t('已退出登录'), 'info');
    });
    root.appendChild(h('div', { class: 'home-head' },
      h('div', { class: 'home-user' },
        h('div', { class: 'user-avatar lg' }, (user.display_name || user.username || '?').slice(0, 1)),
        h('div', {},
          h('div', { class: 'home-user-name' }, user.display_name || user.username),
          h('div', { class: 'home-user-role' }, roleLabel(role))
        )
      ),
      langChip(),
      logout
    ));

    // dashboard 角标
    var canReview = (role === 'manager' || role === 'admin');
    var dashItems = [];
    if (canReview) { dashItems.push({ key: 'pending_counts', label: I18N.t('待比对记录'), icon: '📋', to: '#/count-review' }); }
    if (canReview) { dashItems.push({ key: 'pending_waste', label: I18N.t('待确认报损'), icon: '🗑️', to: '#/waste-review' }); }
    if (role === 'staff') { dashItems.push({ key: 'recent_counts_3d', label: I18N.t('我的每周盘点'), icon: '🧾', to: '#/count-weekly?tab=records' }); }
    dashItems.push({ key: 'daily_shortages', label: I18N.t('今日盘点结果'), icon: '📊', to: '#/count-daily-results' });
    dashItems.push({ key: 'expiring_soon', label: I18N.t('效期预警'), icon: '⏰', to: '#/expiry' });
    dashItems.push({ key: 'low_stock', label: I18N.t('低库存'), icon: '📦', to: '#/stock' });

    var dash = h('div', { class: 'dash-grid' });
    dashItems.forEach(function (it) {
      var cell = h('button', { class: 'dash-card' },
        h('div', { class: 'dash-icon' }, it.icon),
        h('div', { class: 'dash-num', 'data-k': it.key }, '…'),
        h('div', { class: 'dash-label' }, it.label)
      );
      cell.addEventListener('click', function () { location.hash = it.to; });
      dash.appendChild(cell);
    });
    root.appendChild(h('div', { class: 'sec-title' }, I18N.t('库存概览')));
    root.appendChild(dash);

    // 功能宫格
    var feats = [];
    feats.push({ icon: '↔️', label: I18N.t('每日盘点'), desc: I18N.t('左右滑确认够 / 不够'), to: '#/count-daily' });
    if (role !== 'admin') { feats.push({ icon: '🧮', label: I18N.t('每周盘点'), desc: I18N.t('提交盘点 · 查看我的记录'), to: '#/count-weekly' }); }
    feats.push({ icon: '🗑️', label: I18N.t('报损'), desc: I18N.t('登记损耗'), to: '#/waste' });
    feats.push({ icon: '⏰', label: I18N.t('效期预警'), desc: I18N.t('临期批次'), to: '#/expiry' });
    feats.push({ icon: '📦', label: I18N.t('库存查询'), desc: I18N.t('总览与批次'), to: '#/stock' });
    if (canReview) { feats.push({ icon: '✅', label: I18N.t('盘点管理'), desc: I18N.t('待比对 · 记录 · 结果'), to: '#/count-review' }); }
    if (canReview) { feats.push({ icon: '✔️', label: I18N.t('确认报损'), desc: I18N.t('处理报损'), to: '#/waste-review' }); }
    if (canReview) { feats.push({ icon: '📥', label: I18N.t('入库'), desc: I18N.t('直接增加库存批次'), to: '#/receive' }); }
    if (canReview) { feats.push({ icon: '🛒', label: I18N.t('采购'), desc: I18N.t('下单与入库'), to: '#/purchase' }); }
    if (canReview) { feats.push({ icon: '📊', label: I18N.t('消耗与补货'), desc: I18N.t('用量趋势与库存预测'), to: '#/consumption' }); }
    if (canReview) { feats.push({ icon: '🏷️', label: I18N.t('库存品管理'), desc: I18N.t('商品资料'), to: '#/items' }); }
    if (role === 'admin') { feats.push({ icon: '👥', label: I18N.t('用户管理'), desc: I18N.t('账号、身份与 PIN'), to: '#/users' }); }

    var grid = h('div', { class: 'feat-grid' });
    feats.forEach(function (f) {
      var card = h('button', { class: 'feat-card' },
        h('div', { class: 'feat-icon' }, f.icon),
        h('div', { class: 'feat-label' }, f.label),
        h('div', { class: 'feat-desc' }, f.desc)
      );
      card.addEventListener('click', function () { location.hash = f.to; });
      grid.appendChild(card);
    });
    root.appendChild(h('div', { class: 'sec-title' }, I18N.t('功能')));
    root.appendChild(grid);
    root.appendChild(copyrightFooter());

    // 拉取 dashboard 数据（失败不阻塞页面）
    API.dashboard().then(function (d) {
      d = d || {};
      dashItems.forEach(function (it) {
        var el = dash.querySelector('[data-k="' + it.key + '"]');
        if (!el) { return; }
        var n = d[it.key];
        el.textContent = (n === null || n === undefined) ? '—' : String(n);
        el.classList.toggle('zero', n === null || n === undefined || n === 0);
      });
    }).catch(function () {
      var els = dash.querySelectorAll('.dash-num');
      for (var i = 0; i < els.length; i++) { els[i].textContent = '—'; }
    });

    return { root: root };
  }

  /* ================= 盘点 ================= */
  function renderDailyCount() {
    var root = h('div', { class: 'page daily-count-page' });
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('每日盘点')));
    root.appendChild(h('div', { class: 'daily-help' }, I18N.t('向左滑：不够（数量必填）　·　向右滑：够（数量选填）')));
    var stage = h('div', { class: 'swipe-stage' });
    root.appendChild(stage);

    return API.items(false).then(function (items) {
      items = (items || []).filter(function (item) { return item.daily_count_enabled !== false; });
      if (!items.length) {
        stage.appendChild(window.UI.emptyView(I18N.t('暂无需要每日盘点的库存品')));
        return { root: root };
      }
      var answers = [];
      var qtyDrafts = {};
      var busy = false;

      function decide(enough, card) {
        if (busy) { return; }
        var current = items[answers.length];
        var rawQty = qtyDrafts[current.id];
        var qty = rawQty === '' || rawQty === undefined ? null : Number(rawQty);
        if (qty !== null && (!/^\d+(?:\.\d?)?$/.test(String(rawQty)) || !Number.isFinite(qty) || qty < 0)) {
          window.UI.toast(I18N.t('数量必须大于或等于 0，最多一位小数'), 'error');
          return;
        }
        if (!enough && qty === null) {
          card.style.transform = '';
          card.style.setProperty('--swipe-yes-strength', 0);
          card.style.setProperty('--swipe-no-strength', 0);
          window.UI.toast(I18N.t('选择不够时必须填写现场数量'), 'error');
          return;
        }
        busy = true;
        card.classList.add(enough ? 'swipe-right' : 'swipe-left');
        setTimeout(function () {
          var answer = { item_id: current.id, enough: enough };
          if (qty !== null) { answer.qty = qty; }
          answers.push(answer);
          busy = false;
          paint();
        }, 180);
      }

      function paint() {
        stage.innerHTML = '';
        var idx = answers.length;
        stage.appendChild(h('div', { class: 'swipe-progress' }, Math.min(idx + 1, items.length) + ' / ' + items.length));
        if (idx >= items.length) {
          var lacking = answers.filter(function (a) { return !a.enough; }).length;
          var withQty = answers.filter(function (a) { return a.qty !== undefined && a.qty !== null; }).length;
          stage.appendChild(h('div', { class: 'daily-summary' },
            h('div', { class: 'daily-summary-icon' }, lacking ? '⚠️' : '✅'),
            h('div', { class: 'daily-summary-title' }, I18N.t('今日确认完成')),
            h('div', { class: 'daily-summary-text' }, I18N.t('够 {enough} 项 · 不够 {lacking} 项 · 已填数量 {withQty} 项', { enough: items.length - lacking, lacking: lacking, withQty: withQty }))
          ));
          var submit = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('提交每日盘点'));
          submit.addEventListener('click', function () {
            submit.disabled = true;
            var payload = { count_type: 'daily', entries: answers };
            function save() { return API.createCount(payload); }
            save().catch(function (err) {
              if (!(err && err.status === 409 && err.detail && err.detail.code === 'daily_count_exists')) { throw err; }
              var changes = err.detail.changes || [];
              var lines = changes.slice(0, 12).map(function (change) {
                function label(value) { return value === true ? I18N.t('够') : (value === false ? I18N.t('不够') : I18N.t('未记录')); }
                function qtyLabel(value) { return value === null || value === undefined ? I18N.t('未填数量') : I18N.t('数量 {n}', { n: value }); }
                return I18N.t('{name}：{prevEnough} / {prevQty} → {newEnough} / {newQty}', {
                  name: change.item_name,
                  prevEnough: label(change.previous_enough), prevQty: qtyLabel(change.previous_qty),
                  newEnough: label(change.new_enough), newQty: qtyLabel(change.new_qty)
                });
              });
              var message = changes.length ? (I18N.t('与今日结果有 {n} 项差异：', { n: changes.length }) + '\n' + lines.join('\n')) : I18N.t('本次结果与今日已有结果一致。');
              if (changes.length > lines.length) { message += '\n' + I18N.t('另有 {n} 项差异', { n: changes.length - lines.length }); }
              return window.UI.dialog({
                title: I18N.t('今日已有盘点结果'),
                message: message + '\n\n' + I18N.t('是否覆盖今日结果？'),
                options: [
                  { label: I18N.t('确认覆盖'), value: true, kind: 'danger' },
                  { label: I18N.t('取消'), value: null, kind: 'ghost' }
                ]
              }).then(function (confirmed) {
                if (!confirmed) { var cancelled = new Error('取消覆盖'); cancelled.silent = true; throw cancelled; }
                payload.overwrite_daily = true;
                return save();
              });
            }).then(function () {
              window.UI.toast(I18N.t('每日盘点已完成'), 'success');
              setTimeout(function () {
                if (location.hash === '#/count-daily' || location.hash === '#/count') { location.hash = '#/'; }
              }, 700);
            }).catch(function (err) {
              submit.disabled = false;
              if (!(err && err.silent)) { window.UI.toast((err && err.message) || I18N.t('提交失败'), 'error'); }
            });
          });
          var undoDone = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('返回上一项'));
          undoDone.addEventListener('click', function () { answers.pop(); paint(); });
          stage.appendChild(submit);
          stage.appendChild(undoDone);
          return;
        }

        var item = items[idx];
        var qtyInput = h('input', {
          class: 'swipe-qty-input', type: 'number', min: '0', step: '0.1',
          inputmode: 'decimal', placeholder: I18N.t('不够必填，够可不填'),
          'aria-label': I18N.t('{name}现场数量', { name: item.name })
        });
        if (qtyDrafts[item.id] !== undefined) { qtyInput.value = qtyDrafts[item.id]; }
        qtyInput.addEventListener('input', function () { qtyDrafts[item.id] = qtyInput.value; });
        qtyInput.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
        qtyInput.addEventListener('click', function (ev) { ev.stopPropagation(); });
        var lastType = item.last_count_type === 'weekly' ? I18N.t('每周盘点') : I18N.t('每日盘点');
        var lastStatus = item.last_count_type === 'daily' && item.last_count_enough !== null && item.last_count_enough !== undefined
          ? (item.last_count_enough ? ' · ' + I18N.t('够') : ' · ' + I18N.t('不够')) : '';
        var lastQty = item.last_count_at
          ? (item.last_count_qty === null || item.last_count_qty === undefined ? I18N.t('未填数量') : item.last_count_qty + ' ' + (item.unit || ''))
          : I18N.t('暂无记录');
        var card = h('div', { class: 'swipe-card' },
          h('div', { class: 'swipe-badge swipe-badge-yes' }, I18N.t('够')),
          h('div', { class: 'swipe-badge swipe-badge-no' }, I18N.t('不够')),
          h('div', { class: 'swipe-card-top' },
            h('div', { class: 'swipe-category' }, I18N.t(item.category || '未分类')),
            h('div', { class: 'swipe-last-time' }, item.last_count_at ? I18N.t('上次 · {time}', { time: fmtDateTime(item.last_count_at) }) : I18N.t('尚无盘点记录'))
          ),
          h('div', { class: 'swipe-name' }, item.name),
          h('div', { class: 'swipe-metrics' },
            h('div', { class: 'swipe-metric swipe-safe' },
              h('span', { class: 'swipe-metric-label' }, I18N.t('安全数量')),
              h('strong', { class: 'swipe-metric-value' }, Number(item.min_stock || 0) + ' ' + (item.unit || ''))
            ),
            h('div', { class: 'swipe-metric swipe-last' },
              h('span', { class: 'swipe-metric-label' }, I18N.t('上次盘点数量')),
              h('strong', { class: 'swipe-metric-value swipe-last-qty' }, lastQty),
              item.last_count_at ? h('small', { class: 'swipe-last-meta' }, lastType + lastStatus) : null
            )
          ),
          h('div', { class: 'swipe-unit' }, I18N.t('现场确认后向左或向右滑动')),
          h('label', { class: 'swipe-qty' },
            h('span', {}, I18N.t('现场数量（不够必填，够选填）')),
            qtyInput,
            h('span', { class: 'swipe-qty-unit' }, item.unit || '')
          )
        );
        var startX = 0;
        var delta = 0;
        card.addEventListener('pointerdown', function (ev) {
          if (busy) { return; }
          startX = ev.clientX;
          delta = 0;
          card.setPointerCapture(ev.pointerId);
          card.classList.add('dragging');
        });
        card.addEventListener('pointermove', function (ev) {
          if (!card.classList.contains('dragging')) { return; }
          delta = ev.clientX - startX;
          card.style.transform = 'translateX(' + delta + 'px) rotate(' + (delta / 18) + 'deg)';
          var strength = Math.min(Math.abs(delta) / 80, 1);
          card.style.setProperty('--swipe-yes-strength', delta > 0 ? strength : 0);
          card.style.setProperty('--swipe-no-strength', delta < 0 ? strength : 0);
        });
        function release() {
          if (!card.classList.contains('dragging')) { return; }
          card.classList.remove('dragging');
          if (Math.abs(delta) >= 70) { decide(delta > 0, card); }
          else {
            card.style.transform = '';
            card.style.setProperty('--swipe-yes-strength', 0);
            card.style.setProperty('--swipe-no-strength', 0);
          }
        }
        card.addEventListener('pointerup', release);
        card.addEventListener('pointercancel', release);
        stage.appendChild(card);

        var noBtn = h('button', { class: 'daily-choice daily-no', 'aria-label': I18N.t('不够') }, '← ' + I18N.t('不够'));
        var yesBtn = h('button', { class: 'daily-choice daily-yes', 'aria-label': I18N.t('够') }, I18N.t('够') + ' →');
        noBtn.addEventListener('click', function () { decide(false, card); });
        yesBtn.addEventListener('click', function () { decide(true, card); });
        stage.appendChild(h('div', { class: 'daily-actions' }, noBtn, yesBtn));
        if (answers.length) {
          var undo = h('button', { class: 'daily-undo' }, I18N.t('撤销上一项'));
          undo.addEventListener('click', function () { answers.pop(); paint(); });
          stage.appendChild(undo);
        }
      }

      paint();
      return { root: root };
    }).catch(function (err) {
      if (err && err.silent) { return { root: root }; }
      return { root: window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderRoute) };
    });
  }

  function countWorkspaceTabs(active) {
    var tabs = h('div', { class: 'tabs count-workspace-tabs', role: 'tablist', 'aria-label': I18N.t('每周盘点导航') });
    [
      { key: 'submit', label: I18N.t('提交盘点'), to: '#/count-weekly' },
      { key: 'records', label: I18N.t('我的记录'), to: '#/count-weekly?tab=records' }
    ].forEach(function (item) {
      var button = h('button', {
        class: 'tab' + (active === item.key ? ' on' : ''), role: 'tab',
        'aria-selected': active === item.key ? 'true' : 'false'
      }, item.label);
      button.addEventListener('click', function () { location.hash = item.to; });
      tabs.appendChild(button);
    });
    return tabs;
  }

  function countManagementTabs(active) {
    var tabs = h('div', { class: 'tabs count-workspace-tabs', role: 'tablist', 'aria-label': I18N.t('盘点管理导航') });
    [
      { key: 'pending', label: I18N.t('待比对'), to: '#/count-review' },
      { key: 'records', label: I18N.t('盘点记录'), to: '#/count-review?tab=records' },
      { key: 'results', label: I18N.t('确认结果'), to: '#/count-review?tab=results' }
    ].forEach(function (item) {
      var button = h('button', {
        class: 'tab' + (active === item.key ? ' on' : ''), role: 'tab',
        'aria-selected': active === item.key ? 'true' : 'false'
      }, item.label);
      button.addEventListener('click', function () { location.hash = item.to; });
      tabs.appendChild(button);
    });
    return tabs;
  }

  function renderWeeklyCount(ctx) {
    if (ctx && ctx.params && ctx.params.tab === 'records') {
      return renderCountSummary({ ownOnly: true, workspace: true });
    }
    var root = h('div', { class: 'page count-page' });
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('每周盘点')));
    root.appendChild(countWorkspaceTabs('submit'));
    root.appendChild(h('div', { class: 'result-help' }, I18N.t('独立录入现场实数。另一名人员需另行提交，之后由未参与盘点的店长或管理员确认。')));
    return API.items(false).then(function (items) {
      items = (items || []).filter(function (item) { return item.weekly_count_enabled !== false; });
      if (!items.length) {
        root.appendChild(window.UI.emptyView(I18N.t('暂无需要每周盘点的库存品')));
        return { root: root };
      }
      var counts = {};
      items.forEach(function (it) { counts[it.id] = it.stock; });

      // 按分类分组
      var map = {};
      items.forEach(function (it) {
        var c = it.category || '未分类';
        if (!map[c]) { map[c] = []; }
        map[c].push(it);
      });
      var groups = Object.keys(map).map(function (c) { return { category: c, items: map[c] }; });

      var list = h('div', { class: 'count-list' });
      groups.forEach(function (g) {
        var sec = h('div', { class: 'group' });
        var headBtn = h('button', { class: 'group-head' },
          h('span', { class: 'group-name' }, I18N.t(g.category)),
          h('span', { class: 'group-count' }, I18N.t('{n} 项', { n: g.items.length })),
          h('span', { class: 'chev' }, '▾')
        );
        var body = h('div', { class: 'group-body' });
        var open = true;
        g.items.forEach(function (it) {
          var row = h('div', { class: 'count-row' });
          var info = h('div', { class: 'count-info' },
            h('div', { class: 'count-name' }, it.name),
            h('div', { class: 'count-sub' }, I18N.t('当前库存 {n} {unit}', { n: it.stock, unit: it.unit || '' }))
          );
          var st = window.UI.stepper(it.stock, {
            min: 0, max: 99999,
            onChange: function (v) {
              counts[it.id] = v;
              row.classList.toggle('changed', v !== it.stock);
            }
          });
          row.appendChild(info);
          row.appendChild(st.el);
          body.appendChild(row);
        });
        headBtn.addEventListener('click', function () {
          open = !open;
          body.classList.toggle('hide', !open);
          headBtn.querySelector('.chev').textContent = open ? '▾' : '▸';
        });
        sec.appendChild(headBtn);
        sec.appendChild(body);
        list.appendChild(sec);
      });
      root.appendChild(list);

      var submit = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('提交并等待比对'));
      submit.addEventListener('click', function () {
        if (!window.UI.validateQuantities(root, counts)) { return; }
        var changed = items.filter(function (it) { return counts[it.id] !== it.stock; });
        var allEntries = items.map(function (it) { return { item_id: it.id, qty: counts[it.id] }; });
        var changedEntries = changed.map(function (it) { return { item_id: it.id, qty: counts[it.id] }; });
        var choiceP;
        if (changed.length === 0) {
          choiceP = window.UI.dialog({
            title: I18N.t('提交盘点'),
            message: I18N.t('本次没有改动项，确定提交全部盘点结果吗？'),
            options: [
              { label: I18N.t('全部提交（{n} 项）', { n: items.length }), value: 'all', kind: 'primary' },
              { label: I18N.t('取消'), value: null, kind: 'ghost' }
            ]
          });
        } else {
          choiceP = window.UI.dialog({
            title: I18N.t('提交盘点'),
            message: I18N.t('共 {total} 项，其中 {changed} 项有改动', { total: items.length, changed: changed.length }),
            options: [
              { label: I18N.t('全部提交（{n} 项）', { n: items.length }), value: 'all', kind: 'primary' },
              { label: I18N.t('只提交改动项（{n} 项）', { n: changed.length }), value: 'changed', kind: 'ghost' },
              { label: I18N.t('取消'), value: null, kind: 'ghost' }
            ]
          });
        }
        var submitted = false;
        choiceP.then(function (choice) {
          if (!choice) { return; }
          submitted = true;
          var entries = choice === 'all' ? allEntries : changedEntries;
          return API.createCount({ count_type: 'weekly', entries: entries });
        }).then(function () {
          if (!submitted) { return; }
          window.UI.toast(I18N.t('每周盘点已提交，等待另一人独立盘点'), 'success', 3000);
          setTimeout(function () {
            if (location.hash === '#/count-weekly') { location.hash = '#/count-weekly?tab=records'; }
          }, 900);
        }).catch(function (err) {
          if (err && err.silent) { return; }
          window.UI.toast((err && err.message) || I18N.t('提交失败'), 'error');
        });
      });
      var bar = setBar(root, [submit]);
      return { root: root, bar: bar };
    }).catch(function (err) {
      if (err && err.silent) { return { root: h('div', { class: 'page' }) }; }
      return { root: window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderRoute) };
    });
  }

  /* ================= 报损 ================= */
  function renderWaste(ctx) {
    var params = (ctx && ctx.params) || {};
    var root = h('div', { class: 'page waste-page' });
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('报损')));
    var dots = h('div', { class: 'step-dots' }, h('span', { class: 'on' }), h('span'), h('span'));
    root.appendChild(dots);
    var body = h('div', { class: 'waste-body' });
    root.appendChild(body);

    var state = {
      step: 1,
      item: null,
      itemId: params.item ? Number(params.item) : null,
      batchId: params.batch ? Number(params.batch) : null,
      qty: 0,
      reason: null,
      description: '',
      batches: []
    };
    var lastBar = null;

    function updateDots() {
      var i;
      for (i = 0; i < dots.children.length; i++) {
        dots.children[i].classList.toggle('on', i <= state.step - 1);
      }
    }

    function renderStep() {
      if (!root.isConnected) { return; }
      body.innerHTML = '';
      if (state.step === 1) { renderStep1(); }
      else if (state.step === 2) { renderStep2(); }
      else { renderStep3(); }
      renderBar();
      updateDots();
    }

    function renderBar() {
      var children = [];
      if (state.step > 1) {
        var back = h('button', { class: 'btn btn-ghost' }, I18N.t('上一步'));
        back.addEventListener('click', function () { state.step--; renderStep(); });
        children.push(back);
      }
      if (state.step < 3) {
        var next = h('button', { class: 'btn btn-primary' }, I18N.t('下一步'));
        next.disabled = state.step === 1 ? !state.item : state.qty < 0.1;
        next.addEventListener('click', function () { if (state.step === 2 && !window.UI.validateQuantities(root, { qty: state.qty })) { return; } state.step++; renderStep(); });
        children.push(next);
      } else {
        var submit = h('button', { class: 'btn btn-primary' }, I18N.t('提交报损'));
        submit.disabled = !state.reason || state.qty < 0.1;
        submit.addEventListener('click', function () {
          var batchTxt = state.batchId ? I18N.t('（指定批次）') : I18N.t('（FEFO 自动扣减）');
          var submitted = false;
          window.UI.dialog({
            title: I18N.t('确认报损'),
            message: I18N.t('{name} × {qty} {batch}，原因：{reason}', { name: state.item.name, qty: state.qty, batch: batchTxt, reason: I18N.t(state.reason) }),
            options: [
              { label: I18N.t('确认提交'), value: true, kind: 'danger' },
              { label: I18N.t('取消'), value: null, kind: 'ghost' }
            ]
          }).then(function (ok) {
            if (!ok) { return; }
            submitted = true;
            var payload = { item_id: state.itemId, qty: state.qty, reason: state.reason };
            if (state.description.trim()) { payload.description = state.description.trim(); }
            if (state.batchId) { payload.batch_id = state.batchId; }
            return API.createWaste(payload);
          }).then(function () {
            if (!submitted) { return; }
            if (root.isConnected) { showSuccess(); }
          }).catch(function (err) {
            if (err && err.silent) { return; }
            window.UI.toast((err && err.message) || I18N.t('提交失败'), 'error');
          });
        });
        children.push(submit);
      }
      lastBar = setBar(root, children);
    }

    function renderStep1() {
      var old = body.querySelector('.step1-wrap');
      if (old) { old.remove(); }
      var wrap = h('div', { class: 'step1-wrap' });
      var search = h('input', { class: 'search-input', type: 'search', placeholder: I18N.t('搜索库存品…') });
      var listWrap = h('div', { class: 'pick-list' });
      wrap.appendChild(search);
      wrap.appendChild(listWrap);
      body.appendChild(wrap);
      var filtered = [];
      var items = [];

      function paint() {
        listWrap.innerHTML = '';
        if (!filtered.length) {
          listWrap.appendChild(window.UI.emptyView(I18N.t('未找到匹配的库存品')));
          return;
        }
        filtered.forEach(function (it) {
          var card = h('button', { class: 'pick-card' + (state.itemId === it.id ? ' sel' : '') },
            h('div', { class: 'pick-name' }, it.name),
            h('div', { class: 'pick-sub' }, I18N.t('库存 {n} {unit}', { n: it.stock, unit: it.unit || '' }))
          );
          card.addEventListener('click', function () {
            if (it.stock < 0.1) {
              window.UI.toast(I18N.t('该品库存为 0，无法报损'), 'warn');
              return;
            }
            state.item = it;
            state.itemId = it.id;
            state.batchId = null;
            state.qty = Math.min(1, state.item.stock);
            state.batches = [];
            state.step = 2;
            renderStep();
          });
          listWrap.appendChild(card);
        });
      }
      search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        filtered = items.filter(function (it) {
          return (it.name || '').toLowerCase().indexOf(q) >= 0 ||
                 (it.category || '').toLowerCase().indexOf(q) >= 0;
        });
        paint();
      });

      body.appendChild(wrap);
      return API.items(false).then(function (data) {
        items = data || [];
        filtered = items.slice();
        paint();
      }).catch(function (err) {
        listWrap.innerHTML = '';
        listWrap.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderStep1));
      });
    }

    function renderStep2() {
      var it = state.item;
      body.appendChild(window.UI.loadingView(I18N.t('加载批次…')));
      var info = h('div', { class: 'waste-item-info' },
        h('div', { class: 'wi-name' }, it.name),
        h('div', { class: 'wi-stock' }, I18N.t('当前库存：{n} {unit}', { n: it.stock, unit: it.unit || '' }))
      );
      var qtyBox = h('div', { class: 'qty-box' });
      var st = window.UI.stepper(state.qty || 1, {
        min: 0.1, max: it.stock, step: 0.1,
        onChange: function (v) { state.qty = v; }
      });
      qtyBox.appendChild(st.el);
      var batchBox = h('div', { class: 'batch-box' });

      return API.itemBatches(it.id).then(function (batches) {
        if (state.step !== 2) { return; }
        batches = batches || [];
        state.batches = batches;
        body.innerHTML = '';
        body.appendChild(info);
        body.appendChild(qtyBox);
        var near = batches.filter(function (b) {
          return b.qty > 0 && (b.days_to_expiry === null || b.days_to_expiry === undefined || b.days_to_expiry <= 7);
        });
        if (near.length) {
          batchBox.appendChild(h('div', { class: 'sec-label' }, I18N.t('指定批次（可选，默认 FEFO 自动扣减）')));
          var chipItems = near.map(function (b) {
            var exp = (b.expiry_date || '').slice(5) || '?';
            var d = b.days_to_expiry;
            var dTxt = '';
            if (d !== null && d !== undefined) {
              if (d < 0) { dTxt = ' · ' + I18N.t('已过期{n}天', { n: -d }); }
              else if (d === 0) { dTxt = ' · ' + I18N.t('今天到期'); }
              else { dTxt = ' · ' + I18N.t('还有{n}天', { n: d }); }
            }
            return { value: String(b.id), label: I18N.t('批次 {exp} · 剩{qty}', { exp: exp, qty: b.qty }) + dTxt };
          });
          var cg = window.UI.chips(chipItems, {
            selected: state.batchId !== null ? [String(state.batchId)] : [],
            onChange: function (v) { state.batchId = v ? Number(v) : null; }
          });
          batchBox.appendChild(cg.el);
        } else {
          batchBox.appendChild(h('div', { class: 'sec-label' }, I18N.t('无近效期批次，将按 FEFO 自动扣减')));
        }
        body.appendChild(batchBox);
      }).catch(function (err) {
        if (state.step !== 2) { return; }
        body.innerHTML = '';
        body.appendChild(info);
        body.appendChild(qtyBox);
        batchBox.appendChild(h('div', { class: 'sec-label' }, I18N.t('批次加载失败，将按 FEFO 自动扣减')));
        body.appendChild(batchBox);
        if (root.isConnected && !(err && err.silent)) { window.UI.toast(I18N.t('批次加载失败'), 'warn'); }
      });
    }

    function renderStep3() {
      var it = state.item;
      var batchTxt = I18N.t('FEFO 自动扣减');
      if (state.batchId && state.batches.length) {
        for (var i = 0; i < state.batches.length; i++) {
          if (Number(state.batches[i].id) === Number(state.batchId)) {
            batchTxt = I18N.t('批次效期 {date}', { date: state.batches[i].expiry_date || '—' });
            break;
          }
        }
      }
      var summary = h('div', { class: 'waste-summary' },
        h('div', { class: 'ws-row' },
          h('span', {}, it.name),
          h('span', { class: 'ws-qty' }, state.qty + ' ' + (it.unit || ''))
        ),
        h('div', { class: 'ws-row sub' }, I18N.t('扣减方式：{batch}', { batch: batchTxt }))
      );
      var reasons = [
        { value: '过期', label: I18N.t('过期') },
        { value: '变质', label: I18N.t('变质') },
        { value: '破损', label: I18N.t('破损') },
        { value: '污染', label: I18N.t('污染') },
        { value: '其他', label: I18N.t('其他') }
      ];
      var cg = window.UI.chips(reasons, {
        selected: state.reason ? [state.reason] : [],
        onChange: function (v) {
          state.reason = v;
          renderBar();
        }
      });
      body.appendChild(summary);
      body.appendChild(h('div', { class: 'sec-label' }, I18N.t('报损原因')));
      body.appendChild(cg.el);
      var description = h('textarea', {
        class: 'input waste-description',
        maxlength: '500',
        placeholder: I18N.t('补充原因描述（选填），如发现位置、外观和处理情况')
      });
      description.value = state.description || '';
      description.addEventListener('input', function () { state.description = description.value; });
      body.appendChild(h('div', { class: 'sec-label' }, I18N.t('原因描述（选填）')));
      body.appendChild(description);

    }

    function showSuccess() {
      setBar(root, null);
      root.innerHTML = '';
      root.appendChild(h('div', { class: 'success-view' },
        h('div', { class: 'success-icon' }, '✅'),
        h('div', { class: 'success-title' }, I18N.t('已提交，等待店长确认')),
        h('div', { class: 'success-sub' }, I18N.t('报损 {name} × {qty}', { name: state.item.name, qty: state.qty })),
        h('div', { class: 'success-actions' },
          h('button', { class: 'btn btn-primary btn-block' }, I18N.t('返回首页')),
          h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('继续报损'))
        )
      ));
      var btns = root.querySelectorAll('.success-actions .btn');
      btns[0].addEventListener('click', function () { location.hash = '#/'; });
      btns[1].addEventListener('click', function () { window.__reloadRoute(); });
    }

    // 预填（来自效期预警页）：直接进入第二步
    if (state.itemId !== null) {
      state.step = 2;
    }
    var initPromise;
    if (state.step === 2) {
      initPromise = API.items(false).then(function (items) {
        var found = null;
        (items || []).forEach(function (it) { if (Number(it.id) === Number(state.itemId)) { found = it; } });
        if (!found || !(found.stock >= 0.1)) {
          window.UI.toast(!found ? I18N.t('未找到该库存品') : I18N.t('该品库存为 0，无法报损'), 'warn');
          state.itemId = null;
          state.batchId = null;
          state.step = 1;
        } else {
          state.item = found;
          state.qty = Math.min(1, state.item.stock);
        }
      }).catch(function () {
        state.itemId = null;
        state.batchId = null;
        state.step = 1;
      });
    } else {
      initPromise = Promise.resolve();
    }
    return initPromise.then(function () {
      if (state.step === 1) {
        return renderStep1().then(function () {
          renderBar();
          updateDots();
        });
      }
      return renderStep2().then(function () {
        renderBar();
        updateDots();
      });
    }).then(function () {
      return { root: root, bar: lastBar };
    });
  }

  /* ================= 效期预警 ================= */
  function renderExpiry() {
    var root = h('div', { class: 'page expiry-page' });
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('效期预警')));
    var tabBar = h('div', { class: 'tabs' });
    var listWrap = h('div', { class: 'expiry-list' });
    root.appendChild(tabBar);
    root.appendChild(listWrap);

    var tabs = [
      { label: I18N.t('今天'), max: 0 },
      { label: I18N.t('3天内'), max: 3 },
      { label: I18N.t('7天内'), max: 7 }
    ];
    var buckets = [[], [], []];
    var active = 0;

    function paint() {
      listWrap.innerHTML = '';
      var list = buckets[active];
      if (!list.length) {
        listWrap.appendChild(window.UI.emptyView(I18N.t('没有相关批次 🎉')));
        return;
      }
      list.forEach(function (r) {
        var d = r.days_to_expiry;
        var row = h('div', { class: 'expiry-row' });
        var left = h('div', { class: 'expiry-info' },
          h('div', { class: 'expiry-name' }, r.item_name || I18N.t('商品')),
          h('div', { class: 'expiry-sub' }, I18N.t('效期 {date} · 剩 {qty} {unit}', { date: r.expiry_date || '—', qty: r.qty, unit: r.unit || '' }))
        );
        var daysEl = h('div', { class: 'expiry-days' });
        if (d === null || d === undefined) { daysEl.textContent = '—'; }
        else if (d < 0) { daysEl.textContent = I18N.t('已过期 {n} 天', { n: -d }); daysEl.classList.add('bad'); }
        else if (d === 0) { daysEl.textContent = I18N.t('今天到期'); daysEl.classList.add('bad'); }
        else if (d <= 3) { daysEl.textContent = I18N.t('还有 {n} 天', { n: d }); daysEl.classList.add('soon'); }
        else { daysEl.textContent = I18N.t('还有 {n} 天', { n: d }); }

        var btn = h('button', { class: 'btn btn-sm btn-danger' }, I18N.t('报损'));
        btn.addEventListener('click', function () {
          location.hash = '#/waste?item=' + r.item_id + '&batch=' + r.batch_id;
        });
        var right = h('div', { class: 'expiry-right' }, daysEl, btn);
        row.appendChild(left);
        row.appendChild(right);
        listWrap.appendChild(row);
      });
    }

    function renderTabs() {
      tabBar.innerHTML = '';
      tabs.forEach(function (t, i) {
        var b = h('button', { class: 'tab' + (i === active ? ' on' : '') },
          t.label + (buckets[i].length ? ' ' + buckets[i].length : '')
        );
        b.addEventListener('click', function () {
          active = i;
          renderTabs();
          paint();
        });
        tabBar.appendChild(b);
      });
    }

    return API.expiry(7).then(function (rows) {
      rows = rows || [];
      rows.forEach(function (r) {
        var d = r.days_to_expiry;
        var idx;
        if (d === null || d === undefined) { idx = 2; }
        else if (d <= 0) { idx = 0; }
        else if (d <= 3) { idx = 1; }
        else { idx = 2; }
        buckets[idx].push(r);
      });
      renderTabs();
      paint();
      return { root: root };
    }).catch(function (err) {
      if (err && err.silent) { return { root: h('div', { class: 'page' }) }; }
      root.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderRoute));
      return { root: root };
    });
  }

  /* ================= 每日盘点结果（全员只读） ================= */
  function renderDailyCountResults() {
    var root = h('div', { class: 'page daily-results-page' });
    var content = h('div', {});
    root.appendChild(content);

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'page-title' }, I18N.t('每日盘点结果')));
      content.appendChild(h('div', { class: 'result-help' }, I18N.t('按提交时间倒序展示；“不够”仅作为补货提示，不直接修改库存。')));
      var loading = window.UI.loadingView();
      content.appendChild(loading);
      API.counts('completed', 'daily').then(function (list) {
        list = list || [];
        if (loading.isConnected) { loading.remove(); }
        if (!list.length) {
          content.appendChild(window.UI.emptyView(I18N.t('还没有每日盘点记录')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        list.forEach(function (s) {
          var enough = Number(s.enough_count || 0);
          var lacking = Number(s.not_enough_count || 0);
          var card = h('button', { class: 'review-card daily-result-card' },
            h('div', { class: 'rc-top' },
              h('span', { class: 'rc-id' }, fmtDateTime(s.created_at)),
              h('span', { class: 'tag ' + (lacking ? 'short' : 'ok') }, lacking ? I18N.t('不够 {n} 项', { n: lacking }) : I18N.t('全部够用'))
            ),
            h('div', { class: 'rc-sub' }, I18N.t('提交人：{name} · 共 {n} 项', { name: s.created_by_name || '—', n: Number(s.entries_count || 0) })),
            h('div', { class: 'result-counts' },
              h('span', { class: 'result-enough' }, I18N.t('够 {n}', { n: enough })),
              h('span', { class: 'result-lacking' }, I18N.t('不够 {n}', { n: lacking })),
              h('span', { class: 'result-quantity' }, I18N.t('已填数量 {n} 项', { n: Number(s.quantity_count || 0) }))
            )
          );
          card.addEventListener('click', function () { showDetail(s); });
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (loading.isConnected) { loading.remove(); }
        if (!(err && err.silent)) { content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), showList)); }
      });
    }

    function showDetail(summary) {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.countDetail(summary.id).then(function (detail) {
        var entries = (detail.entries || []).slice().sort(function (a, b) {
          return Number(a.is_enough) - Number(b.is_enough);
        });
        var lacking = entries.filter(function (entry) { return entry.is_enough === false; }).length;
        content.innerHTML = '';
        content.appendChild(h('div', { class: 'detail-head' },
          h('div', { class: 'rc-id' }, fmtDateTime(summary.created_at)),
          h('div', { class: 'rc-sub' }, I18N.t('提交人：{name}', { name: summary.created_by_name || '—' })),
          h('div', { class: 'result-counts' },
            h('span', { class: 'result-enough' }, I18N.t('够 {n}', { n: entries.length - lacking })),
            h('span', { class: 'result-lacking' }, I18N.t('不够 {n}', { n: lacking }))
          )
        ));
        var list = h('div', { class: 'daily-result-lines' });
        entries.forEach(function (entry) {
          var enough = entry.is_enough === true;
          var hasQty = entry.reported_qty !== null && entry.reported_qty !== undefined;
          list.appendChild(h('div', { class: 'daily-result-line ' + (enough ? 'enough' : 'lacking') },
            h('div', { class: 'daily-result-item' },
              h('div', { class: 'diff-name' }, entry.item_name || I18N.t('商品#{id}', { id: entry.item_id })),
              h('div', { class: 'daily-result-qty ' + (hasQty ? 'recorded' : 'empty') }, hasQty ? I18N.t('现场数量：{n} {unit}', { n: entry.reported_qty, unit: entry.unit || '' }) : I18N.t('现场数量：未填写'))
            ),
            h('span', { class: 'tag ' + (enough ? 'ok' : 'short') }, enough ? I18N.t('够') : I18N.t('不够'))
          ));
        });
        content.appendChild(list);
        var back = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('返回结果列表'));
        back.addEventListener('click', showList);
        setBar(root, [back]);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), function () { showDetail(summary); }));
      });
    }

    showList();
    return { root: root };
  }

  /* ================= 我的每周盘点记录（嵌入“每周盘点”工作区） ================= */
  function renderCountSummary(options) {
    options = options || {};
    var root = h('div', { class: 'page review-page' });
    var content = h('div', {});
    var currentUser = API.store.getUser() || {};
    var ownOnly = options.ownOnly === true || currentUser.role === 'staff';
    var workspace = options.workspace === true;
    var management = options.management === true;
    var rangeDays = 3;
    if (management) {
      root.appendChild(h('div', { class: 'page-title' }, I18N.t('盘点管理')));
      root.appendChild(countManagementTabs('records'));
    } else if (workspace) {
      root.appendChild(h('div', { class: 'page-title' }, I18N.t('每周盘点')));
      root.appendChild(countWorkspaceTabs('records'));
    }
    root.appendChild(content);

    function statusMeta(row) {
      if (row.status === 'submitted') { return { label: I18N.t('待比对'), cls: 'short' }; }
      if (row.status === 'rejected') { return { label: I18N.t('需重盘'), cls: 'muted' }; }
      if (row.review_reason === 'no_difference') { return { label: I18N.t('旧版单人核对 · 无差异'), cls: 'ok' }; }
      if (row.review_reason === 'normal_consumption') { return { label: I18N.t('旧版单人核对 · 正常消耗'), cls: 'ok' }; }
      if (row.review_reason === 'recount_corrected') { return { label: I18N.t('旧版单人核对 · 已更正'), cls: 'ok' }; }
      if (row.review_reason === 'paired_no_difference') { return { label: I18N.t('无差异已采纳'), cls: 'ok' }; }
      if (row.review_reason === 'paired_normal_consumption') { return { label: I18N.t('正常消耗已确认'), cls: 'ok' }; }
      if (row.review_reason === 'paired_manager_corrected') { return { label: I18N.t('管理员更正已采纳'), cls: 'ok' }; }
      if (row.review_reason === 'paired_trusted_first' || row.review_reason === 'paired_trusted_second') { return { label: I18N.t('可信记录已采纳'), cls: 'ok' }; }
      if (row.review_reason === 'paired_recount_required') { return { label: I18N.t('已退回重盘'), cls: 'muted' }; }
      return { label: I18N.t('已核对'), cls: 'ok' };
    }

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      if (!workspace && !management) { content.appendChild(h('div', { class: 'page-title' }, ownOnly ? I18N.t('我的每周盘点') : I18N.t('盘点记录'))); }
      if (management) {
        var range = h('select', { class: 'count-range-select', 'aria-label': I18N.t('盘点记录时间范围') },
          h('option', { value: '3' }, I18N.t('近 3 天')),
          h('option', { value: '7' }, I18N.t('近 7 天')),
          h('option', { value: '30' }, I18N.t('近 30 天'))
        );
        range.value = String(rangeDays);
        range.addEventListener('change', function () {
          rangeDays = Number(range.value) || 3;
          showList();
        });
        content.appendChild(h('div', { class: 'count-records-head' },
          h('div', {}, h('strong', {}, I18N.t('原始盘点记录')), h('span', {}, I18N.t('查看双方独立提交的原始数据'))),
          range
        ));
      } else {
        content.appendChild(h('div', { class: 'result-help' }, I18N.t('近 72 小时内自己提交的记录；待比对时可修改，进入处理后即锁定。')));
      }
      var loading = window.UI.loadingView();
      content.appendChild(loading);
      API.counts(null, 'weekly', rangeDays).then(function (rows) {
        rows = rows || [];
        if (ownOnly) {
          rows = rows.filter(function (row) { return Number(row.created_by) === Number(currentUser.id); });
        }
        if (loading.isConnected) { loading.remove(); }
        var pending = rows.filter(function (r) { return r.status === 'submitted'; }).length;
        var verified = rows.filter(function (r) { return r.status === 'verified'; }).length;
        var rejected = rows.filter(function (r) { return r.status === 'rejected'; }).length;
        content.appendChild(h('div', { class: 'count-summary-grid' },
          h('div', { class: 'count-summary-cell' }, h('strong', {}, String(rows.length)), h('span', {}, I18N.t('合计'))),
          h('div', { class: 'count-summary-cell pending' }, h('strong', {}, String(pending)), h('span', {}, I18N.t('待比对'))),
          h('div', { class: 'count-summary-cell ok' }, h('strong', {}, String(verified)), h('span', {}, I18N.t('已采纳'))),
          h('div', { class: 'count-summary-cell' }, h('strong', {}, String(rejected)), h('span', {}, I18N.t('需重盘')))
        ));
        if (!rows.length) {
          content.appendChild(window.UI.emptyView(ownOnly ? I18N.t('近 72 小时还没有提交每周盘点') : I18N.t('当前时间范围内没有盘点记录')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        rows.forEach(function (row) {
          var meta = statusMeta(row);
          var diffCount = Number(row.difference_count || 0);
          var card = h('button', { class: 'review-card count-summary-card' },
            h('div', { class: 'rc-top' },
              h('span', { class: 'rc-id' }, I18N.t('盘点单 #{id}', { id: row.id })),
              h('span', { class: 'tag ' + meta.cls }, meta.label)
            ),
            h('div', { class: 'rc-sub' }, I18N.t('提交人：{name} · {time}', { name: row.created_by_name || '—', time: fmtDateTime(row.created_at) })),
            h('div', { class: 'rc-sub' }, I18N.t('共 {n} 项', { n: Number(row.entries_count || 0) }) + (row.status === 'verified' ? ' · ' + I18N.t('两次差异 {n} 项', { n: diffCount }) : '')),
            row.verified_by_name ? h('div', { class: 'rc-sub' }, I18N.t('核对人：{name} · {time}', { name: row.verified_by_name, time: fmtDateTime(row.verified_at) })) : null,
            row.review_note ? h('div', { class: 'rc-note' }, row.review_note) : null
          );
          card.addEventListener('click', function () { showDetail(row); });
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (loading.isConnected) { loading.remove(); }
        if (!(err && err.silent)) { content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), showList)); }
      });
    }

    function showDetail(summary) {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.countDetail(summary.id).then(function (detail) {
        content.innerHTML = '';
        var meta = statusMeta(detail);
        content.appendChild(h('div', { class: 'detail-head' },
          h('div', { class: 'rc-top' }, h('div', { class: 'rc-id' }, I18N.t('盘点单 #{id}', { id: detail.id })), h('span', { class: 'tag ' + meta.cls }, meta.label)),
          h('div', { class: 'rc-sub' }, I18N.t('提交人：{name} · {time}', { name: detail.created_by_name || '—', time: fmtDateTime(detail.created_at) })),
          detail.verified_by_name ? h('div', { class: 'rc-sub' }, I18N.t('核对人：{name} · {time}', { name: detail.verified_by_name, time: fmtDateTime(detail.verified_at) })) : null,
          detail.comparison_id ? h('div', { class: 'rc-sub' }, I18N.t('关联比对单 #{id}', { id: detail.comparison_id })) : null,
          detail.review_note ? h('div', { class: 'rc-note' }, detail.review_note) : null
        ));
        var list = h('div', { class: 'diff-list' });
        (detail.entries || []).forEach(function (entry) {
          var reviewed = entry.reviewed_qty;
          var diff = reviewed === null || reviewed === undefined ? null : reviewed - entry.qty_counted;
          list.appendChild(h('div', { class: 'review-compare-row' + (diff ? ' changed' : '') },
            h('div', { class: 'diff-info' },
              h('div', { class: 'diff-name' }, entry.item_name || I18N.t('商品#{id}', { id: entry.item_id })),
              h('div', { class: 'diff-sub' }, I18N.t('本次记录 {qty} {unit} · 最终采用 {final}', {
                qty: entry.qty_counted, unit: entry.unit || '',
                final: reviewed === null || reviewed === undefined ? I18N.t('待确认') : reviewed + ' ' + (entry.unit || '')
              }))
            ),
            h('div', { class: 'diff-val ' + (diff > 0 ? 'gain' : (diff < 0 ? 'loss' : '')) }, diff === null ? '—' : (diff > 0 ? '+' + diff : String(diff)))
          ));
        });
        content.appendChild(list);
        var back = h('button', { class: 'btn btn-ghost' }, management ? I18N.t('返回盘点记录') : I18N.t('返回我的记录'));
        back.addEventListener('click', showList);
        var actions = [back];
        if (detail.status === 'submitted' && Number(detail.created_by) === Number(currentUser.id)) {
          var edit = h('button', { class: 'btn btn-primary' }, I18N.t('修改盘点数据'));
          edit.addEventListener('click', function () { showEdit(detail); });
          actions.push(edit);
        }
        setBar(root, actions);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), function () { showDetail(summary); }));
      });
    }

    function showEdit(detail) {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'page-title' }, I18N.t('修改盘点单 #{id}', { id: detail.id })));
      content.appendChild(h('div', { class: 'result-help' }, I18N.t('可补加漏盘库存品；保存后会更新提交时间和库存快照，开始核对后将无法修改。')));
      content.appendChild(window.UI.loadingView());
      API.items(false).then(function (allItems) {
        content.innerHTML = '';
        content.appendChild(h('div', { class: 'page-title' }, I18N.t('修改盘点单 #{id}', { id: detail.id })));
        content.appendChild(h('div', { class: 'result-help' }, I18N.t('可补加漏盘库存品；保存后会更新提交时间和库存快照，开始核对后将无法修改。')));
        var editableEntries = (detail.entries || []).map(function (entry) { return Object.assign({}, entry); });
        var originalIds = {};
        var draft = {};
        editableEntries.forEach(function (entry) {
          originalIds[entry.item_id] = true;
          draft[entry.item_id] = String(entry.qty_counted);
        });
        var inputs = {};
        var list = h('div', { class: 'review-entry-list count-edit-list' });
        content.appendChild(list);

        content.appendChild(h('div', { class: 'sec-label' }, I18N.t('补加漏盘库存品')));
        var itemSelect = h('select', { class: 'input count-add-item-select', 'aria-label': I18N.t('增加盘点品') });
        var add = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, I18N.t('加入盘点'));
        var addRow = h('div', { class: 'count-add-row' }, itemSelect, add);
        content.appendChild(addRow);
        content.appendChild(h('div', { class: 'result-help count-add-help' }, I18N.t('仅显示已启用每周盘点且尚未加入本单的库存品。')));

        function rememberValues() {
          Object.keys(inputs).forEach(function (itemId) { draft[itemId] = inputs[itemId].value; });
        }

        function renderEntries() {
          rememberValues();
          inputs = {};
          list.innerHTML = '';
          editableEntries.forEach(function (entry) {
            var input = h('input', {
              class: 'review-qty-input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1',
              value: draft[entry.item_id] === undefined ? '' : draft[entry.item_id],
              'aria-label': I18N.t('{name}盘点数量', { name: entry.item_name || I18N.t('商品#{id}', { id: entry.item_id }) })
            });
            inputs[entry.item_id] = input;
            var info = h('div', { class: 'diff-info' },
              h('div', { class: 'diff-name' }, entry.item_name || I18N.t('商品#{id}', { id: entry.item_id })),
              h('div', { class: 'diff-sub' }, originalIds[entry.item_id] ? I18N.t('原盘点 {qty} {unit}', { qty: entry.qty_counted, unit: entry.unit || '' }) : I18N.t('本次补加，请填写实数'))
            );
            if (!originalIds[entry.item_id]) {
              var remove = h('button', { class: 'count-added-remove', type: 'button', 'aria-label': I18N.t('移除{name}', { name: entry.item_name || I18N.t('库存品') }) }, I18N.t('撤销补加'));
              remove.addEventListener('click', function (event) {
                event.preventDefault();
                rememberValues();
                editableEntries = editableEntries.filter(function (value) { return value.item_id !== entry.item_id; });
                delete draft[entry.item_id];
                renderEntries();
              });
              info.appendChild(remove);
            }
            list.appendChild(h('label', { class: 'review-entry-row' },
              info,
              h('div', { class: 'review-input-box' }, input, h('span', {}, entry.unit || ''))
            ));
          });
          var selected = itemSelect.value;
          itemSelect.innerHTML = '';
          var available = allItems.filter(function (item) {
            return item.active !== false && item.weekly_count_enabled && !editableEntries.some(function (entry) { return Number(entry.item_id) === Number(item.id); });
          });
          itemSelect.appendChild(h('option', { value: '' }, available.length ? I18N.t('选择要补加的库存品') : I18N.t('没有可补加的库存品')));
          available.forEach(function (item) { itemSelect.appendChild(h('option', { value: String(item.id) }, item.name + ' · ' + I18N.t(item.category || '未分类'))); });
          if (available.some(function (item) { return String(item.id) === selected; })) { itemSelect.value = selected; }
          add.disabled = available.length === 0;
        }

        add.addEventListener('click', function () {
          var itemId = Number(itemSelect.value);
          var item = allItems.find(function (value) { return Number(value.id) === itemId; });
          if (!item) { window.UI.toast(I18N.t('请先选择要补加的库存品'), 'warn'); return; }
          rememberValues();
          editableEntries.push({ item_id: item.id, item_name: item.name, unit: item.unit, qty_counted: null });
          draft[item.id] = '';
          renderEntries();
          inputs[item.id].focus();
        });
        renderEntries();

        var note = h('textarea', { class: 'input waste-description', maxlength: '255', placeholder: I18N.t('盘点备注（选填）') });
        note.value = detail.note || '';
        content.appendChild(h('div', { class: 'sec-label' }, I18N.t('备注')));
        content.appendChild(note);

        var cancel = h('button', { class: 'btn btn-ghost' }, I18N.t('取消'));
        cancel.addEventListener('click', function () { showDetail(detail); });
        var save = h('button', { class: 'btn btn-primary' }, I18N.t('保存盘点修改'));
        save.addEventListener('click', function () {
          var entries = [];
          for (var i = 0; i < editableEntries.length; i++) {
            var entry = editableEntries[i];
            var raw = inputs[entry.item_id].value.trim();
            if (!/^\d+(?:\.\d?)?$/.test(raw)) { window.UI.toast(I18N.t('请填写全部盘点数量'), 'warn'); inputs[entry.item_id].focus(); return; }
            entries.push({ item_id: entry.item_id, qty: Number(raw) });
          }
          save.disabled = true;
          API.updateCount(detail.id, { entries: entries, note: note.value.trim() || null }).then(function (updated) {
            window.UI.toast(I18N.t('盘点数据已修改，继续等待比对'), 'success');
            showDetail(updated);
          }).catch(function (err) {
            save.disabled = false;
            if (!(err && err.silent)) { window.UI.toast((err && err.message) || I18N.t('修改失败'), 'error'); }
          });
        });
        setBar(root, [cancel, save]);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('库存品加载失败'), function () { showEdit(detail); }));
      });
    }

    showList();
    return { root: root };
  }

  /* ================= 两份独立盘点比对（店长/管理员） ================= */
  function renderCountReview(ctx) {
    if (ctx && ctx.params && ctx.params.tab === 'records') {
      return renderCountSummary({ management: true });
    }
    if (ctx && ctx.params && (ctx.params.tab === 'results' || ctx.params.tab === 'history')) {
      return renderCountReviewHistory();
    }
    var root = h('div', { class: 'page review-page' });
    var content = h('div', {});
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('盘点管理')));
    root.appendChild(countManagementTabs('pending'));
    root.appendChild(content);
    var selected = [];

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'result-help' }, I18N.t('选择近72小时内两名不同人员独立提交的记录。管理人员只确认差异，不再录入第三套数字。')));
      content.appendChild(window.UI.loadingView());
      API.counts('submitted', 'weekly', 3).then(function (list) {
        list = list || [];
        selected = selected.filter(function (id) { return list.some(function (row) { return row.id === id; }); });
        content.innerHTML = '';
        content.appendChild(h('div', { class: 'result-help' }, I18N.t('请选择两份不同提交人的记录；一份记录只能处理一次。')));
        if (!list.length) {
          content.appendChild(window.UI.emptyView(I18N.t('没有待比对的盘点记录 🎉')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        list.forEach(function (s) {
          var n = s.entries_count !== null && s.entries_count !== undefined ? s.entries_count :
                  (s.entry_count !== null && s.entry_count !== undefined ? s.entry_count :
                  (s.entries ? s.entries.length : '—'));
          var checkbox = h('span', { class: 'pair-check' }, selected.indexOf(s.id) >= 0 ? '✓' : '');
          var card = h('button', { class: 'review-card pair-select-card' + (selected.indexOf(s.id) >= 0 ? ' selected' : '') },
            h('div', { class: 'rc-top' },
              h('span', { class: 'rc-id' }, I18N.t('盘点单 #{id}', { id: s.id })),
              h('span', { class: 'rc-count' }, I18N.t('{n} 项', { n: n })),
              checkbox
            ),
            h('div', { class: 'rc-sub' }, I18N.t('提交人：{name} · {time}', { name: pickName(s, ['created_by_name', 'created_by_username', 'created_by', 'creator_name']) || '—', time: fmtDateTime(s.created_at) })),
            s.note ? h('div', { class: 'rc-note' }, s.note) : null
          );
          card.addEventListener('click', function () {
            var at = selected.indexOf(s.id);
            if (at >= 0) { selected.splice(at, 1); }
            else if (selected.length < 2) {
              var firstSelected = selected.length ? list.find(function (row) { return row.id === selected[0]; }) : null;
              if (firstSelected && Number(firstSelected.created_by) === Number(s.created_by)) {
                window.UI.toast(I18N.t('请选择另一名人员提交的记录'), 'warn');
                return;
              }
              selected.push(s.id);
            }
            else { window.UI.toast(I18N.t('一次只能选择两份记录'), 'warn'); return; }
            showList();
          });
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
        if (list.length === 1) { content.appendChild(h('div', { class: 'review-instruction' }, I18N.t('已收到一份记录，等待第二人独立盘点。'))); }
        var compare = h('button', { class: 'btn btn-green' }, I18N.t('比对已选记录（{n}/2）', { n: selected.length }));
        compare.disabled = selected.length !== 2;
        compare.addEventListener('click', function () { previewSelected(); });
        setBar(root, [compare]);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), showList));
      });
    }

    function previewSelected() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.previewCountComparison({ first_count_id: selected[0], second_count_id: selected[1] }).then(function (comparison) {
        showComparison(comparison);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('比对失败'), showList));
      });
    }

    function showComparison(d) {
        content.innerHTML = '';
        var head = h('div', { class: 'detail-head' },
          h('div', { class: 'rc-id' }, I18N.t('双人盘点比对')),
          h('div', { class: 'pair-people' },
            h('div', {}, h('strong', {}, d.first.created_by_name), h('span', {}, '#' + d.first.id + ' · ' + fmtDateTime(d.first.created_at))),
            h('div', { class: 'pair-vs' }, 'VS'),
            h('div', {}, h('strong', {}, d.second.created_by_name), h('span', {}, '#' + d.second.id + ' · ' + fmtDateTime(d.second.created_at)))
          ),
          h('div', { class: 'rc-sub' }, I18N.t('共同 {shared} 项 · 差异 {diff} 项 · 单边缺失 {missing} 项', { shared: d.shared_count, diff: d.different_count, missing: d.missing_count }))
        );
        content.appendChild(head);
        var entries = d.entries || [];
        var list = h('div', { class: 'pair-compare-list' });
        entries.forEach(function (entry) {
          var missing = entry.result.indexOf('missing_') === 0;
          var stateText = entry.result === 'same' ? I18N.t('一致') : (entry.result === 'different' ? I18N.t('有差异') : I18N.t('单边未盘，不更新库存'));
          list.appendChild(h('div', { class: 'pair-compare-row ' + entry.result },
            h('div', { class: 'diff-name' }, entry.item_name),
            h('div', { class: 'pair-values' },
              h('span', {}, entry.first_qty === null ? I18N.t('未盘') : entry.first_qty + ' ' + entry.unit),
              h('span', { class: 'pair-arrow' }, '⇄'),
              h('span', {}, entry.second_qty === null ? I18N.t('未盘') : entry.second_qty + ' ' + entry.unit)
            ),
            h('div', { class: 'diff-sub' }, stateText + (missing ? '' : ' · ' + I18N.t('当前库存 {n} {unit}', { n: entry.current_qty, unit: entry.unit })))
          ));
        });
        content.appendChild(list);
        if (d.missing_count) { content.appendChild(h('div', { class: 'review-instruction warning' }, I18N.t('单边缺失项目仅保留记录，本次不会修改这些库存品。'))); }

        function submit(resolution, note, corrections) {
          return API.confirmCountComparison({
            first_count_id: d.first.id, second_count_id: d.second.id,
            comparison_token: d.comparison_token, resolution: resolution,
            note: note || null, corrections: corrections || []
          }).then(function () {
            window.UI.toast(resolution === 'recount_required' ? I18N.t('已退回，两名盘点人需重新提交') : I18N.t('双人盘点已确认并落库'), 'success', 3200);
            selected = [];
            showList();
          }).catch(function (err) {
            if (err && err.detail && err.detail.code === 'count_comparison_changed') {
              window.UI.toast(I18N.t('记录或库存已变化，请重新比对'), 'warn');
              previewSelected();
              return;
            }
            window.UI.toast((err && err.message) || I18N.t('确认失败'), 'error');
          });
        }

        function reasonThen(resolution, title) {
          return window.UI.textPrompt({ title: title, placeholder: I18N.t('请输入差异原因'), emptyMessage: I18N.t('必须填写差异原因') }).then(function (note) {
            if (note) { return submit(resolution, note); }
          });
        }

        function showCorrections() {
          setBar(root, null);
          var correctionRows = entries.filter(function (row) { return row.result === 'different'; });
          content.innerHTML = '';
          content.appendChild(h('div', { class: 'page-title' }, I18N.t('管理员更正差异项')));
          content.appendChild(h('div', { class: 'result-help' }, I18N.t('这里只录入两份记录不一致的共同项目；一致项自动沿用，缺失项不更新。')));
          var inputs = {};
          correctionRows.forEach(function (row) {
            var input = h('input', { class: 'review-qty-input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1', placeholder: I18N.t('最终数量'), 'aria-label': I18N.t('{name}最终数量', { name: row.item_name }) });
            inputs[row.item_id] = input;
            content.appendChild(h('label', { class: 'review-entry-row' },
              h('div', { class: 'diff-info' }, h('div', { class: 'diff-name' }, row.item_name), h('div', { class: 'diff-sub' }, row.first_qty + ' ⇄ ' + row.second_qty + ' ' + row.unit)),
              h('div', { class: 'review-input-box' }, input, h('span', {}, row.unit))
            ));
          });
          var note = h('textarea', { class: 'input waste-description', maxlength: '255', placeholder: I18N.t('必填：更正原因') });
          content.appendChild(h('div', { class: 'sec-label' }, I18N.t('差异原因')));
          content.appendChild(note);
          var cancel = h('button', { class: 'btn btn-ghost' }, I18N.t('返回比对'));
          cancel.addEventListener('click', function () { showComparison(d); });
          var confirm = h('button', { class: 'btn btn-green' }, I18N.t('确认更正并落库'));
          confirm.addEventListener('click', function () {
            var corrections = [];
            for (var i = 0; i < correctionRows.length; i++) {
              var row = correctionRows[i];
              var value = inputs[row.item_id].value.trim();
              if (!/^\d+(?:\.\d?)?$/.test(value)) { window.UI.toast(I18N.t('请填写全部差异项最终数量'), 'warn'); return; }
              corrections.push({ item_id: row.item_id, qty: Number(value) });
            }
            if (!note.value.trim()) { window.UI.toast(I18N.t('请填写更正原因'), 'warn'); return; }
            submit('manager_corrected', note.value.trim(), corrections);
          });
          setBar(root, [cancel, confirm]);
        }

        var back = h('button', { class: 'btn btn-ghost' }, I18N.t('返回选择'));
        back.addEventListener('click', showList);
        if (!d.different_count) {
          var direct = h('button', { class: 'btn btn-green' }, I18N.t('两份一致，确认落库'));
          direct.addEventListener('click', function () { submit('no_difference'); });
          var recount = h('button', { class: 'btn btn-ghost' }, I18N.t('退回两人重新盘点'));
          recount.addEventListener('click', function () { reasonThen('recount_required', I18N.t('退回重盘原因')); });
          setBar(root, [back, recount, direct]);
          return;
        }
        var normal = h('button', { class: 'btn btn-green' }, I18N.t('正常消耗，采用后提交'));
        normal.addEventListener('click', function () { submit('normal_consumption'); });
        var other = h('button', { class: 'btn btn-ghost' }, I18N.t('其他处理'));
        other.addEventListener('click', function () {
          window.UI.dialog({
            title: I18N.t('选择异常差异处理方式'),
            message: I18N.t('可信记录按整份采用；管理员更正只填写差异项；退回重盘不会修改库存。'),
            options: [
              { label: I18N.t('采用 {name} 的记录', { name: d.first.created_by_name }), value: 'first', kind: 'primary' },
              { label: I18N.t('采用 {name} 的记录', { name: d.second.created_by_name }), value: 'second', kind: 'primary' },
              { label: I18N.t('管理员更正差异项'), value: 'correct', kind: 'danger' },
              { label: I18N.t('退回两人重新盘点'), value: 'recount', kind: 'danger' },
              { label: I18N.t('取消'), value: null, kind: 'ghost' }
            ]
          }).then(function (choice) {
            if (choice === 'first') { return reasonThen('trusted_first', I18N.t('采用第一份记录')); }
            if (choice === 'second') { return reasonThen('trusted_second', I18N.t('采用第二份记录')); }
            if (choice === 'correct') { showCorrections(); }
            if (choice === 'recount') { return reasonThen('recount_required', I18N.t('退回重盘原因')); }
          });
        });
        setBar(root, [back, other, normal]);
    }

    showList();
    return { root: root };
  }

  function renderCountReviewHistory() {
    var root = h('div', { class: 'page review-page' });
    var content = h('div', {});
    var rangeDays = 3;
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('盘点管理')));
    root.appendChild(countManagementTabs('results'));
    root.appendChild(content);

    function resolutionLabel(value) {
      var labels = {
        no_difference: I18N.t('无差异采纳'),
        normal_consumption: I18N.t('正常消耗 · 采用后提交'),
        trusted_first: I18N.t('采用第一份可信记录'),
        trusted_second: I18N.t('采用第二份可信记录'),
        manager_corrected: I18N.t('管理更正差异项'),
        recount_required: I18N.t('已退回双人重盘')
      };
      return labels[value] || I18N.t('已处理');
    }

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      var range = h('select', { class: 'count-range-select', 'aria-label': I18N.t('确认结果时间范围') },
        h('option', { value: '3' }, I18N.t('近 3 天')),
        h('option', { value: '7' }, I18N.t('近 7 天')),
        h('option', { value: '30' }, I18N.t('近 30 天'))
      );
      range.value = String(rangeDays);
      range.addEventListener('change', function () {
        rangeDays = Number(range.value) || 3;
        showList();
      });
      content.appendChild(h('div', { class: 'count-records-head' },
        h('div', {}, h('strong', {}, I18N.t('已完成的确认结果')), h('span', {}, I18N.t('两份原始记录与最终数量永久保留'))),
        range
      ));
      var loading = window.UI.loadingView();
      content.appendChild(loading);
      API.counts(null, 'weekly', rangeDays).then(function (rows) {
        rows = (rows || []).filter(function (row) { return row.status !== 'submitted'; });
        if (loading.isConnected) { loading.remove(); }
        var grouped = {};
        rows.forEach(function (row) {
          var key = row.comparison_id ? ('comparison-' + row.comparison_id) : ('legacy-' + row.id);
          if (!grouped[key]) {
            grouped[key] = { comparisonId: row.comparison_id || null, rows: [], sortAt: row.verified_at || row.created_at };
          }
          grouped[key].rows.push(row);
          if (String(row.verified_at || row.created_at) > String(grouped[key].sortAt || '')) {
            grouped[key].sortAt = row.verified_at || row.created_at;
          }
        });
        var groups = Object.keys(grouped).map(function (key) { return grouped[key]; });
        groups.sort(function (a, b) { return String(b.sortAt || '').localeCompare(String(a.sortAt || '')); });
        if (!groups.length) {
          content.appendChild(window.UI.emptyView(I18N.t('当前时间范围内还没有确认结果')));
          return;
        }
        var wrap = h('div', { class: 'review-list count-history-list' });
        groups.forEach(function (group) {
          var first = group.rows[0];
          var paired = !!group.comparisonId;
          var names = group.rows.map(function (row) { return row.created_by_name || '—'; });
          var label = paired ? resolutionLabel(String(first.review_reason || '').replace(/^paired_/, '')) : I18N.t('旧版单人核对');
          var card = h('button', { class: 'review-card count-history-card' },
            h('div', { class: 'rc-top' },
              h('span', { class: 'rc-id' }, paired ? I18N.t('比对单 #{id}', { id: group.comparisonId }) : I18N.t('盘点单 #{id}', { id: first.id })),
              h('span', { class: 'tag ' + (first.status === 'rejected' ? 'muted' : 'ok') }, label)
            ),
            h('div', { class: 'rc-sub' }, paired ? I18N.t('{names} · 两份独立记录', { names: names.join(I18N.t(' 与 ')) }) : I18N.t('提交人：{name}', { name: names[0] })),
            h('div', { class: 'rc-sub' }, I18N.t('处理人：{name} · {time}', { name: first.verified_by_name || '—', time: fmtDateTime(first.verified_at || first.created_at) })),
            first.review_note ? h('div', { class: 'rc-note' }, first.review_note) : null
          );
          card.addEventListener('click', function () {
            if (paired) { showComparison(group.comparisonId); }
            else { showLegacy(first); }
          });
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (loading.isConnected) { loading.remove(); }
        if (!(err && err.silent)) { content.appendChild(window.UI.errorView((err && err.message) || I18N.t('处理记录加载失败'), showList)); }
      });
    }

    function showComparison(comparisonId) {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.countComparison(comparisonId).then(function (comparison) {
        content.innerHTML = '';
        content.appendChild(h('div', { class: 'detail-head' },
          h('div', { class: 'rc-top' },
            h('span', { class: 'rc-id' }, I18N.t('比对单 #{id}', { id: comparison.id })),
            h('span', { class: 'tag ' + (comparison.resolution === 'recount_required' ? 'muted' : 'ok') }, resolutionLabel(comparison.resolution))
          ),
          h('div', { class: 'rc-sub' }, I18N.t('原始记录：#{a} 与 #{b}', { a: comparison.first_count_id, b: comparison.second_count_id })),
          h('div', { class: 'rc-sub' }, I18N.t('确认人：{name} · {time}', { name: comparison.confirmed_by_name || '—', time: fmtDateTime(comparison.confirmed_at) })),
          comparison.note ? h('div', { class: 'rc-note' }, comparison.note) : null
        ));
        var list = h('div', { class: 'pair-compare-list' });
        (comparison.entries || []).forEach(function (entry) {
          var missing = entry.first_qty === null || entry.second_qty === null;
          list.appendChild(h('div', { class: 'pair-compare-row ' + entry.result },
            h('div', { class: 'diff-name' }, entry.item_name || I18N.t('商品#{id}', { id: entry.item_id })),
            h('div', { class: 'pair-values' },
              h('span', {}, entry.first_qty === null ? I18N.t('未盘') : entry.first_qty + ' ' + (entry.unit || '')),
              h('span', { class: 'pair-arrow' }, '⇄'),
              h('span', {}, entry.second_qty === null ? I18N.t('未盘') : entry.second_qty + ' ' + (entry.unit || ''))
            ),
            h('div', { class: 'comparison-final ' + (entry.final_qty === null ? 'skipped' : '') },
              entry.final_qty === null ? (missing ? I18N.t('单边缺失 · 库存未更新') : I18N.t('已退回 · 库存未更新')) : I18N.t('最终采用 {qty} {unit}', { qty: entry.final_qty, unit: entry.unit || '' })
            )
          ));
        });
        content.appendChild(list);
        var back = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('返回确认结果'));
        back.addEventListener('click', showList);
        setBar(root, [back]);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('比对结果加载失败'), function () { showComparison(comparisonId); }));
      });
    }

    function showLegacy(summary) {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.countDetail(summary.id).then(function (detail) {
        content.innerHTML = '';
        content.appendChild(h('div', { class: 'detail-head' },
          h('div', { class: 'rc-top' }, h('span', { class: 'rc-id' }, I18N.t('旧版盘点单 #{id}', { id: detail.id })), h('span', { class: 'tag muted' }, I18N.t('旧版单人核对'))),
          h('div', { class: 'rc-sub' }, I18N.t('提交人：{name} · {time}', { name: detail.created_by_name || '—', time: fmtDateTime(detail.created_at) })),
          h('div', { class: 'rc-sub' }, I18N.t('核对人：{name} · {time}', { name: detail.verified_by_name || '—', time: fmtDateTime(detail.verified_at) })),
          detail.review_note ? h('div', { class: 'rc-note' }, detail.review_note) : null
        ));
        var list = h('div', { class: 'diff-list' });
        (detail.entries || []).forEach(function (entry) {
          list.appendChild(h('div', { class: 'review-compare-row' },
            h('div', { class: 'diff-info' }, h('div', { class: 'diff-name' }, entry.item_name || I18N.t('商品#{id}', { id: entry.item_id })),
              h('div', { class: 'diff-sub' }, I18N.t('原记录 {qty} · 最终 {final} {unit}', { qty: entry.qty_counted, final: entry.reviewed_qty === null ? I18N.t('未记录') : entry.reviewed_qty, unit: entry.unit || '' })))
          ));
        });
        content.appendChild(list);
        var back = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('返回确认结果'));
        back.addEventListener('click', showList);
        setBar(root, [back]);
      }).catch(function (err) {
        content.innerHTML = '';
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('旧版记录加载失败'), function () { showLegacy(summary); }));
      });
    }

    showList();
    return { root: root };
  }

  /* ================= 确认报损（店长） ================= */
  function renderWasteReview() {
    var root = h('div', { class: 'page review-page' });

    function load() {
      setBar(root, null);
      root.innerHTML = '';
      root.appendChild(h('div', { class: 'page-title' }, I18N.t('确认报损')));
      root.appendChild(window.UI.loadingView());
      API.waste('pending').then(function (list) {
        list = list || [];
        root.innerHTML = '';
        root.appendChild(h('div', { class: 'page-title' }, I18N.t('确认报损')));
        if (!list.length) {
          root.appendChild(window.UI.emptyView(I18N.t('没有待确认的报损 🎉')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        list.forEach(function (w) {
          var name = itemName(w, I18N.t('商品#{id}', { id: w.item_id }));
          var reporter = pickName(w, ['reported_by_name', 'reported_by_username', 'reported_by']) || '—';
          var card = h('div', { class: 'waste-card' },
            h('div', { class: 'rc-top' },
              h('span', { class: 'rc-id' }, name),
              h('span', { class: 'rc-count' }, w.qty + ' ' + (w.unit || ''))
            ),
            h('div', { class: 'wc-tags' },
              h('span', { class: 'tag' }, w.reason ? I18N.t(w.reason) : '—'),
              w.batch_expiry_date ? h('span', { class: 'tag' }, I18N.t('批次效期 {date}', { date: w.batch_expiry_date })) : null
            ),
            h('div', { class: 'rc-sub' }, reporter + ' · ' + fmtDateTime(w.reported_at)),
            w.description ? h('div', { class: 'waste-description-view' }, w.description) : null,
            h('div', { class: 'pc-actions' },
              (function () {
                var b = h('button', { class: 'btn btn-green' }, I18N.t('确认'));
                b.addEventListener('click', function () {
                  var done = false;
                  window.UI.dialog({
                    title: I18N.t('确认报损'),
                    message: I18N.t('{name} × {qty}，确认后将扣减库存，确定吗？', { name: name, qty: w.qty }),
                    options: [
                      { label: I18N.t('确认'), value: true, kind: 'primary' },
                      { label: I18N.t('取消'), value: null, kind: 'ghost' }
                    ]
                  }).then(function (ok) {
                    if (!ok) { return; }
                    done = true;
                    return API.confirmWaste(w.id);
                  }).then(function () {
                    if (!done) { return; }
                    window.UI.toast(I18N.t('已确认，库存已扣减'), 'success');
                    load();
                  }).catch(function (err) {
                    if (err && err.silent) { return; }
                    window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
                  });
                });
                return b;
              })(),
              (function () {
                var b = h('button', { class: 'btn btn-ghost danger' }, I18N.t('驳回'));
                b.addEventListener('click', function () {
                  var done = false;
                  window.UI.dialog({
                    title: I18N.t('驳回报损'),
                    message: I18N.t('确定驳回该报损记录吗？'),
                    options: [
                      { label: I18N.t('驳回'), value: true, kind: 'danger' },
                      { label: I18N.t('取消'), value: null, kind: 'ghost' }
                    ]
                  }).then(function (ok) {
                    if (!ok) { return; }
                    done = true;
                    return API.rejectWaste(w.id);
                  }).then(function () {
                    if (!done) { return; }
                    window.UI.toast(I18N.t('已驳回'), 'info');
                    load();
                  }).catch(function (err) {
                    if (err && err.silent) { return; }
                    window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
                  });
                });
                return b;
              })()
            )
          );
          wrap.appendChild(card);
        });
        root.appendChild(wrap);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        root.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), load));
      });
    }

    load();
    return { root: root };
  }

  /* ================= 直接入库（店长/管理员） ================= */
  function renderStockReceive() {
    var root = h('div', { class: 'page purchase-page' });
    var content = h('div', { class: 'purchase-content' });
    var quantities = {};
    root.appendChild(content);

    function datePlus(days) {
      var base = new Date();
      base.setHours(0, 0, 0, 0);
      return fmtDate(new Date(base.getTime() + days * 86400000));
    }

    function renderExpiry(selected, allItems) {
      content.innerHTML = '';
      setBar(root, null);
      var back = h('button', { class: 'btn btn-ghost btn-sm' }, '← ' + I18N.t('返回'));
      back.addEventListener('click', function () { renderSelect(allItems); });
      content.appendChild(h('div', { class: 'recv-head' },
        back,
        h('div', { class: 'recv-title' }, I18N.t('填写入库效期'))
      ));

      var expiryState = {};
      var listWrap = h('div', { class: 'recv-list' });
      selected.forEach(function (it) {
        var shelf = Number(it.shelf_life_days || 7);
        if (!(shelf >= 1)) { shelf = 7; }
        expiryState[it.id] = datePlus(shelf);
        var card = h('div', { class: 'recv-card' });
        card.appendChild(h('div', { class: 'recv-name' },
          I18N.t('{name}（入 {qty} {unit}）', { name: it.name, qty: quantities[it.id], unit: it.unit || '' })
        ));

        var seen = {};
        var chipItems = [];
        [3, 5, shelf].forEach(function (days) {
          if (seen[days]) { return; }
          seen[days] = true;
          chipItems.push({
            value: String(days),
            label: days === shelf ? I18N.t('推荐 +{n}天', { n: days }) : I18N.t('+{n}天', { n: days })
          });
        });
        var customInput = h('input', { type: 'date', class: 'date-input' });
        var dateEl = h('div', { class: 'recv-date' });
        function renderDate() {
          var value = expiryState[it.id];
          dateEl.textContent = value ? I18N.t('效期：{date}', { date: value }) : I18N.t('请选择效期');
          dateEl.classList.toggle('missing', !value);
        }
        var chips = window.UI.chips(chipItems, {
          selected: [String(shelf)],
          onChange: function (value) {
            expiryState[it.id] = value ? datePlus(Number(value)) : (customInput.value || null);
            renderDate();
          }
        });
        customInput.addEventListener('change', function () {
          if (customInput.value) {
            expiryState[it.id] = customInput.value;
            chips.set(null);
          }
          renderDate();
        });
        card.appendChild(chips.el);
        card.appendChild(h('div', { class: 'recv-custom' },
          h('span', { class: 'recv-custom-label' }, I18N.t('自定义效期：')),
          customInput
        ));
        card.appendChild(dateEl);
        renderDate();
        listWrap.appendChild(card);
      });
      content.appendChild(listWrap);

      var note = h('textarea', {
        class: 'input waste-description',
        maxlength: '255',
        placeholder: I18N.t('入库备注（选填）')
      });
      content.appendChild(window.UI.field(I18N.t('备注'), note));

      var submit = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('确认入库'));
      submit.addEventListener('click', function () {
        var lines = selected.map(function (it) {
          return { item_id: it.id, qty: quantities[it.id], expiry_date: expiryState[it.id] };
        });
        if (lines.some(function (line) { return !line.expiry_date; })) {
          window.UI.toast(I18N.t('请为所有明细选择效期'), 'warn');
          return;
        }
        var confirmed = false;
        window.UI.dialog({
          title: I18N.t('确认入库'),
          message: I18N.t('共 {n} 项，入库后将生成库存批次', { n: lines.length }),
          options: [
            { label: I18N.t('确认入库'), value: true, kind: 'primary' },
            { label: I18N.t('取消'), value: null, kind: 'ghost' }
          ]
        }).then(function (ok) {
          if (!ok) { return; }
          confirmed = true;
          submit.disabled = true;
          return API.receiveStock({ items: lines, note: note.value.trim() || null });
        }).then(function () {
          if (!confirmed) { return; }
          window.UI.toast(I18N.t('入库成功 🎉'), 'success', 3000);
          location.hash = '#/stock';
        }).catch(function (err) {
          submit.disabled = false;
          if (err && err.silent) { return; }
          window.UI.toast((err && err.message) || I18N.t('入库失败'), 'error');
        });
      });
      setBar(root, [submit]);
    }

    function renderSelect(items) {
      content.innerHTML = '';
      setBar(root, null);
      if (!items.length) {
        content.appendChild(window.UI.emptyView(I18N.t('暂无库存品')));
        return;
      }
      items.forEach(function (it) {
        if (quantities[it.id] === undefined) { quantities[it.id] = 0; }
      });
      var search = h('input', { class: 'search-input', type: 'search', placeholder: I18N.t('搜索库存品…') });
      var listWrap = h('div', {});
      var filtered = items.slice();
      var next = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('下一步：填写效期'));

      function selectedItems() {
        return items.filter(function (it) { return quantities[it.id] > 0; });
      }
      function paint() {
        listWrap.innerHTML = '';
        if (!filtered.length) {
          listWrap.appendChild(window.UI.emptyView(I18N.t('未找到匹配的库存品')));
          return;
        }
        filtered.forEach(function (it) {
          var row = h('div', { class: 'count-row' + (quantities[it.id] > 0 ? ' changed' : '') });
          row.appendChild(h('div', { class: 'count-info' },
            h('div', { class: 'count-name' }, it.name),
            h('div', { class: 'count-sub' }, I18N.t('当前库存 {n} {unit}', { n: it.stock, unit: it.unit || '' }))
          ));
          var stepper = window.UI.stepper(quantities[it.id], {
            min: 0,
            max: 99999,
            onChange: function (value) {
              quantities[it.id] = value;
              row.classList.toggle('changed', value > 0);
              next.disabled = selectedItems().length < 1;
            }
          });
          row.appendChild(stepper.el);
          listWrap.appendChild(row);
        });
      }
      search.addEventListener('input', function () {
        var query = search.value.trim().toLowerCase();
        filtered = items.filter(function (it) {
          return (it.name || '').toLowerCase().indexOf(query) >= 0 ||
            (it.category || '').toLowerCase().indexOf(query) >= 0;
        });
        paint();
      });
      next.disabled = selectedItems().length < 1;
      next.addEventListener('click', function () {
        if (!window.UI.validateQuantities(root, quantities)) { return; }
        var selected = selectedItems();
        if (selected.length) { renderExpiry(selected, items); }
      });
      content.appendChild(h('div', { class: 'recv-title receive-page-title' }, I18N.t('直接入库')));
      content.appendChild(h('div', { class: 'page-hint' }, I18N.t('选择到货商品和数量，再填写每批效期。')));
      content.appendChild(search);
      content.appendChild(listWrap);
      paint();
      setBar(root, [next]);
    }

    content.appendChild(window.UI.loadingView());
    API.items(false).then(renderSelect).catch(function (err) {
      if (err && err.silent) { return; }
      content.innerHTML = '';
      content.appendChild(window.UI.errorView((err && err.message) || I18N.t('库存品加载失败'), function () { renderRoute(); }));
    });
    return { root: root };
  }

  /* ================= 采购（店长） ================= */
  function renderPurchase() {
    var root = h('div', { class: 'page purchase-page' });
    var tabBar = h('div', { class: 'tabs' });
    var content = h('div', { class: 'purchase-content' });
    root.appendChild(tabBar);
    root.appendChild(content);

    var TABS = [I18N.t('进行中'), I18N.t('新建'), I18N.t('历史')];
    var active = 0;

    function renderTabs() {
      tabBar.innerHTML = '';
      TABS.forEach(function (t, i) {
        var b = h('button', { class: 'tab' + (i === active ? ' on' : '') }, t);
        b.addEventListener('click', function () {
          active = i;
          renderTabs();
          if (active === 0) { renderActive(); }
          else if (active === 1) { renderNew(); }
          else { renderHistory(); }
        });
        tabBar.appendChild(b);
      });
    }

    function renderActive() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.purchases('ordered').then(function (list) {
        list = list || [];
        content.innerHTML = '';
        if (!list.length) {
          content.appendChild(window.UI.emptyView(I18N.t('没有进行中的采购单')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        list.forEach(function (p) {
          var card = h('div', { class: 'purchase-card' },
            h('div', { class: 'pc-top' },
              h('span', { class: 'pc-id' }, I18N.t('采购单 #{id}', { id: p.id })),
              h('span', { class: 'tag' }, I18N.t('进行中'))
            ),
            h('div', { class: 'pc-sub' }, (pickName(p, ['created_by_name', 'created_by_username', 'created_by']) || '—') + ' · ' + fmtDateTime(p.created_at)),
            p.note ? h('div', { class: 'pc-note' }, p.note) : null
          );
          var lines = h('div', { class: 'pc-items' });
          (p.items || []).forEach(function (li) {
            lines.appendChild(h('div', { class: 'pc-line' },
              h('span', {}, itemName(li, I18N.t('商品#{id}', { id: li.item_id }))),
              h('span', {}, '× ' + li.qty)
            ));
          });
          card.appendChild(lines);
          var actions = h('div', { class: 'pc-actions' });
          var recv = h('button', { class: 'btn btn-primary' }, I18N.t('入库'));
          recv.addEventListener('click', function () { renderReceive(p); });
          var cancel = h('button', { class: 'btn btn-ghost danger' }, I18N.t('取消订单'));
          cancel.addEventListener('click', function () {
            var done = false;
            window.UI.dialog({
              title: I18N.t('取消采购单'),
              message: I18N.t('确定取消采购单 #{id} 吗？', { id: p.id }),
              options: [
                { label: I18N.t('取消订单'), value: true, kind: 'danger' },
                { label: I18N.t('返回'), value: null, kind: 'ghost' }
              ]
            }).then(function (ok) {
              if (!ok) { return; }
              done = true;
              return API.cancelPurchase(p.id);
            }).then(function () {
              if (!done) { return; }
              window.UI.toast(I18N.t('已取消'), 'info');
              renderActive();
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
            });
          });
          actions.appendChild(recv);
          actions.appendChild(cancel);
          card.appendChild(actions);
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderActive));
      });
    }

    function renderNew() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.items(false).then(function (items) {
        items = items || [];
        content.innerHTML = '';
        if (!items.length) {
          content.appendChild(window.UI.emptyView(I18N.t('暂无库存品')));
          return;
        }
        var qty = {};
        items.forEach(function (it) { qty[it.id] = 0; });
        var search = h('input', { class: 'search-input', type: 'search', placeholder: I18N.t('搜索库存品…') });
        var listWrap = h('div', {});
        var filtered = items.slice();
        var submit = null;

        function total() {
          return items.reduce(function (s, it) { return s + qty[it.id]; }, 0);
        }
        function paint() {
          listWrap.innerHTML = '';
          if (!filtered.length) {
            listWrap.appendChild(window.UI.emptyView(I18N.t('未找到匹配的库存品')));
            return;
          }
          filtered.forEach(function (it) {
            var row = h('div', { class: 'count-row' });
            var info = h('div', { class: 'count-info' },
              h('div', { class: 'count-name' }, it.name),
              h('div', { class: 'count-sub' }, (it.unit || '') + ' · ' + I18N.t('库存 {n}', { n: it.stock }))
            );
            var st = window.UI.stepper(qty[it.id], {
              min: 0, max: 999,
              onChange: function (v) {
                qty[it.id] = v;
                if (submit) { submit.disabled = total() < 0.1; }
              }
            });
            row.appendChild(info);
            row.appendChild(st.el);
            listWrap.appendChild(row);
          });
        }
        search.addEventListener('input', function () {
          var q = search.value.trim().toLowerCase();
          filtered = items.filter(function (it) {
            return (it.name || '').toLowerCase().indexOf(q) >= 0 ||
                   (it.category || '').toLowerCase().indexOf(q) >= 0;
          });
          paint();
        });
        content.appendChild(search);
        content.appendChild(listWrap);
        paint();

        submit = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('提交采购单'));
        submit.disabled = true;
        submit.addEventListener('click', function () {
          if (!window.UI.validateQuantities(root, qty)) { return; }
          var payload = items.filter(function (it) { return qty[it.id] > 0; })
            .map(function (it) { return { item_id: it.id, qty: qty[it.id] }; });
          if (!payload.length) { return; }
          var done = false;
          window.UI.dialog({
            title: I18N.t('提交采购单'),
            message: I18N.t('共 {n} 项', { n: payload.length }),
            options: [
              { label: I18N.t('确认提交'), value: true, kind: 'primary' },
              { label: I18N.t('取消'), value: null, kind: 'ghost' }
            ]
          }).then(function (ok) {
            if (!ok) { return; }
            done = true;
            return API.createPurchase({ items: payload });
          }).then(function () {
            if (!done) { return; }
            window.UI.toast(I18N.t('采购单已提交'), 'success');
            active = 0;
            renderTabs();
            renderActive();
          }).catch(function (err) {
            if (err && err.silent) { return; }
            window.UI.toast((err && err.message) || I18N.t('提交失败'), 'error');
          });
        });
        setBar(root, [submit]);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderNew));
      });
    }

    function renderHistory() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      Promise.all([API.purchases('received'), API.purchases('cancelled')]).then(function (res) {
        var recv = res[0] || [];
        var canc = res[1] || [];
        content.innerHTML = '';
        var all = recv.map(function (p) { return { p: p, st: 'received' }; })
          .concat(canc.map(function (p) { return { p: p, st: 'cancelled' }; }));
        all.sort(function (a, b) { return String(b.p.created_at).localeCompare(String(a.p.created_at)); });
        if (!all.length) {
          content.appendChild(window.UI.emptyView(I18N.t('暂无历史采购单')));
          return;
        }
        var wrap = h('div', { class: 'review-list' });
        all.forEach(function (item) {
          var p = item.p;
          var card = h('div', { class: 'purchase-card' },
            h('div', { class: 'pc-top' },
              h('span', { class: 'pc-id' }, I18N.t('采购单 #{id}', { id: p.id })),
              h('span', { class: 'tag ' + (item.st === 'received' ? 'ok' : 'muted') },
                item.st === 'received' ? I18N.t('已入库') : I18N.t('已取消'))
            ),
            h('div', { class: 'pc-sub' }, (pickName(p, ['created_by_name', 'created_by_username', 'created_by']) || '—') + ' · ' + fmtDateTime(p.created_at))
          );
          var lines = h('div', { class: 'pc-items' });
          (p.items || []).forEach(function (li) {
            lines.appendChild(h('div', { class: 'pc-line' },
              h('span', {}, itemName(li, I18N.t('商品#{id}', { id: li.item_id }))),
              h('span', {}, '× ' + li.qty)
            ));
          });
          card.appendChild(lines);
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderHistory));
      });
    }

    function renderReceive(p) {
      tabBar.style.display = 'none';
      content.innerHTML = '';
      setBar(root, null);

      var backBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '← ' + I18N.t('返回'));
      backBtn.addEventListener('click', function () {
        tabBar.style.display = '';
        renderTabs();
        renderActive();
      });
      content.appendChild(h('div', { class: 'recv-head' },
        backBtn,
        h('div', { class: 'recv-title' }, I18N.t('采购单 #{id} 入库', { id: p.id }))
      ));

      var items = p.items || [];
      if (!items.length) {
        content.appendChild(window.UI.emptyView(I18N.t('该采购单没有明细')));
        return;
      }
      var todayBase = new Date();
      todayBase.setHours(0, 0, 0, 0);
      function datePlus(n) {
        var d = new Date(todayBase.getTime() + n * 86400000);
        return fmtDate(d);
      }

      var expiryState = {};
      var listWrap = h('div', { class: 'recv-list' });
      items.forEach(function (li) {
        var shelf = li.shelf_life_days;
        if (shelf === null || shelf === undefined || !(shelf >= 1)) {
          shelf = (li.item && li.item.shelf_life_days) || 7;
          if (!(shelf >= 1)) { shelf = 7; }
        }
        expiryState[li.id] = datePlus(shelf);
        var name = itemName(li, I18N.t('商品#{id}', { id: li.item_id }));
        var unit = li.unit || (li.item && li.item.unit) || '';
        var card = h('div', { class: 'recv-card' });
        card.appendChild(h('div', { class: 'recv-name' }, I18N.t('{name}（订 {qty} {unit}）', { name: name, qty: li.qty, unit: unit })));

        var days = [3, 5, shelf];
        var seen = {};
        var chipItems = [];
        days.forEach(function (n) {
          if (seen[n]) { return; }
          seen[n] = 1;
          chipItems.push({ value: String(n), label: n === shelf ? I18N.t('推荐 +{n}天', { n: n }) : I18N.t('+{n}天', { n: n }) });
        });

        var customInput = h('input', { type: 'date', class: 'date-input' });
        var dateEl = h('div', { class: 'recv-date' });
        function renderDate() {
          var v = expiryState[li.id];
          dateEl.textContent = v ? I18N.t('效期：{date}', { date: v }) : I18N.t('请选择效期');
          dateEl.classList.toggle('missing', !v);
        }

        var cg = window.UI.chips(chipItems, {
          selected: [String(shelf)],
          onChange: function (v) {
            if (v) {
              expiryState[li.id] = datePlus(Number(v));
            } else {
              expiryState[li.id] = customInput.value || null;
            }
            renderDate();
          }
        });
        customInput.addEventListener('change', function () {
          if (customInput.value) {
            expiryState[li.id] = customInput.value;
            cg.set(null);
          }
          renderDate();
        });

        card.appendChild(cg.el);
        card.appendChild(h('div', { class: 'recv-custom' },
          h('span', { class: 'recv-custom-label' }, I18N.t('自定义效期：')),
          customInput
        ));
        card.appendChild(dateEl);
        renderDate();
        listWrap.appendChild(card);
      });
      content.appendChild(listWrap);

      var submit = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('确认入库'));
      submit.addEventListener('click', function () {
        var payload = items.filter(function (li) { return !!expiryState[li.id]; })
          .map(function (li) { return { purchase_item_id: li.id, expiry_date: expiryState[li.id] }; });
        if (payload.length !== items.length) {
          window.UI.toast(I18N.t('请为所有明细选择效期'), 'warn');
          return;
        }
        var done = false;
        window.UI.dialog({
          title: I18N.t('确认入库'),
          message: I18N.t('共 {n} 项，入库后将生成库存批次', { n: items.length }),
          options: [
            { label: I18N.t('确认入库'), value: true, kind: 'primary' },
            { label: I18N.t('取消'), value: null, kind: 'ghost' }
          ]
        }).then(function (ok) {
          if (!ok) { return; }
          done = true;
          return API.receivePurchase(p.id, { items: payload });
        }).then(function () {
          if (!done) { return; }
          window.UI.toast(I18N.t('入库成功 🎉'), 'success', 3000);
          tabBar.style.display = '';
          active = 0;
          renderTabs();
          renderActive();
        }).catch(function (err) {
          if (err && err.silent) { return; }
          window.UI.toast((err && err.message) || I18N.t('入库失败'), 'error');
        });
      });
      setBar(root, [submit]);
    }

    renderTabs();
    renderActive();
    return { root: root };
  }

  /* ================= 库存品管理（店长） ================= */
  function renderItems() {
    var root = h('div', { class: 'page items-page' });
    var content = h('div', {});
    var selectedCategory = '__all__';
    var knownCategories = [];
    var knownUnits = [];
    root.appendChild(content);

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      var addBtn = h('button', { class: 'btn btn-primary btn-sm' }, I18N.t('+ 新增'));
      addBtn.addEventListener('click', function () { showForm(null); });
      content.appendChild(h('div', { class: 'page-head' },
        h('div', { class: 'page-title' }, I18N.t('库存品管理')),
        addBtn
      ));
      content.appendChild(window.UI.loadingView());
      API.items(true).then(function (items) {
        items = items || [];
        content.innerHTML = '';
        var addBtn2 = h('button', { class: 'btn btn-primary btn-sm' }, I18N.t('+ 新增'));
        addBtn2.addEventListener('click', function () { showForm(null); });
        var categoryCounts = {};
        items.forEach(function (it) {
          var category = it.category || '未分类';
          categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        });
        var categories = Object.keys(categoryCounts).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
        knownCategories = categories.slice();
        knownUnits = Array.from(new Set(items.map(function (it) { return (it.unit || '').trim(); }).filter(Boolean)))
          .sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
        if (selectedCategory !== '__all__' && categories.indexOf(selectedCategory) < 0) { selectedCategory = '__all__'; }
        var categoryNav = h('select', { class: 'item-category-nav', 'aria-label': I18N.t('分类导航') });
        categoryNav.appendChild(h('option', { value: '__all__' }, I18N.t('全部 {n}', { n: items.length })));
        categories.forEach(function (category) {
          categoryNav.appendChild(h('option', { value: category }, I18N.t(category) + ' ' + categoryCounts[category]));
        });
        categoryNav.value = selectedCategory;
        content.appendChild(h('div', { class: 'page-head' },
          h('div', { class: 'page-title' }, I18N.t('库存品管理')),
          categoryNav,
          addBtn2
        ));
        if (!items.length) {
          content.appendChild(window.UI.emptyView(I18N.t('暂无库存品')));
          return;
        }
        var wrap = h('div', { class: 'item-list' });
        function paintItems() {
          wrap.innerHTML = '';
          var visibleItems = selectedCategory === '__all__' ? items : items.filter(function (it) { return (it.category || '未分类') === selectedCategory; });
          visibleItems.forEach(function (it) {
          var sw = window.UI.toggleSwitch(it.active, function (val) {
            API.updateItem(it.id, { active: val }).then(function () {
              window.UI.toast(val ? I18N.t('已启用') : I18N.t('已停用'), 'info');
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
              sw.querySelector('input').checked = !val;
            });
          });
          var row = h('div', { class: 'item-row' },
            h('div', { class: 'item-info' },
              h('div', { class: 'item-name' }, it.name, it.active === false ? h('span', { class: 'tag muted' }, ' ' + I18N.t('已停用')) : null),
              h('div', { class: 'item-sub' },
                I18N.t(it.category || '未分类') + ' · ' + (it.unit || '') +
                ' · ' + (it.shelf_life_days !== null && it.shelf_life_days !== undefined ? I18N.t('效期 {n}天', { n: it.shelf_life_days }) : I18N.t('效期 —')) +
                ' · ' + I18N.t('最低 {n}', { n: it.min_stock !== null && it.min_stock !== undefined ? it.min_stock : '0' })
              ),
              h('div', { class: 'item-count-scope' },
                it.daily_count_enabled !== false ? h('span', { class: 'tag ok' }, I18N.t('每日盘点')) : null,
                it.weekly_count_enabled !== false ? h('span', { class: 'tag info' }, I18N.t('每周盘点')) : null,
                it.daily_count_enabled === false && it.weekly_count_enabled === false ? h('span', { class: 'tag muted' }, I18N.t('不参与盘点')) : null
              )
            ),
            h('div', { class: 'item-right' },
              h('span', { class: 'item-stock' }, I18N.t('库存 {n}', { n: it.stock !== null && it.stock !== undefined ? it.stock : '—' })),
              sw
            )
          );
          row.addEventListener('click', function (e) {
            if (e.target.closest('.switch')) { return; }
            showForm(it);
          });
          wrap.appendChild(row);
          });
        }
        categoryNav.addEventListener('change', function () {
          selectedCategory = categoryNav.value;
          paintItems();
        });
        paintItems();
        content.appendChild(wrap);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), showList));
      });
    }

    function showForm(item) {
      setBar(root, null);
      var isEdit = !!item;
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'page-title' }, isEdit ? I18N.t('编辑库存品') : I18N.t('新增库存品')));

      var nameInput = h('input', { class: 'input', type: 'text', placeholder: I18N.t('如：吐司面包'), value: item ? (item.name || '') : '' });
      var catSelect = h('select', { class: 'input item-category-select', 'aria-label': I18N.t('库存品分类') });
      var currentCategory = item ? (item.category || '') : '';
      var previousCategory = currentCategory;
      var formCategories = knownCategories.slice();
      if (currentCategory && formCategories.indexOf(currentCategory) < 0) { formCategories.push(currentCategory); }

      function paintCategoryOptions(selected) {
        formCategories.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
        catSelect.innerHTML = '';
        catSelect.appendChild(h('option', { value: '', disabled: 'disabled' }, I18N.t('请选择分类')));
        formCategories.forEach(function (category) {
          catSelect.appendChild(h('option', { value: category }, category));
        });
        catSelect.appendChild(h('option', { value: '__new__' }, I18N.t('＋ 新增')));
        if (selected && formCategories.indexOf(selected) >= 0) {
          catSelect.value = selected;
        } else {
          catSelect.value = '';
        }
        previousCategory = catSelect.value === '__new__' ? '' : catSelect.value;
      }

      paintCategoryOptions(currentCategory);
      catSelect.addEventListener('change', function () {
        if (catSelect.value !== '__new__') {
          previousCategory = catSelect.value;
          return;
        }
        window.UI.textPrompt({
          title: I18N.t('新增分类'),
          subtitle: I18N.t('输入新的库存品分类'),
          placeholder: I18N.t('如：面包'),
          maxlength: 64,
          okText: I18N.t('新增')
        }).then(function (category) {
          category = category ? category.trim() : '';
          if (!category) {
            paintCategoryOptions(previousCategory);
            return;
          }
          if (formCategories.indexOf(category) < 0) { formCategories.push(category); }
          paintCategoryOptions(category);
        });
      });
      var unitSelect = h('select', { class: 'input item-unit-select', 'aria-label': I18N.t('库存品单位') });
      var currentUnit = item ? (item.unit || '') : '';
      var previousUnit = currentUnit;
      var formUnits = knownUnits.slice();
      if (currentUnit && formUnits.indexOf(currentUnit) < 0) { formUnits.push(currentUnit); }

      function paintUnitOptions(selected) {
        formUnits.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
        unitSelect.innerHTML = '';
        unitSelect.appendChild(h('option', { value: '', disabled: 'disabled' }, I18N.t('请选择单位')));
        formUnits.forEach(function (unit) {
          unitSelect.appendChild(h('option', { value: unit }, unit));
        });
        unitSelect.appendChild(h('option', { value: '__new__' }, I18N.t('＋ 新增')));
        if (selected && formUnits.indexOf(selected) >= 0) {
          unitSelect.value = selected;
        } else {
          unitSelect.value = '';
        }
        previousUnit = unitSelect.value === '__new__' ? '' : unitSelect.value;
      }

      paintUnitOptions(currentUnit);
      unitSelect.addEventListener('change', function () {
        if (unitSelect.value !== '__new__') {
          previousUnit = unitSelect.value;
          return;
        }
        window.UI.textPrompt({
          title: I18N.t('新增单位'),
          subtitle: I18N.t('输入新的库存计量单位'),
          placeholder: I18N.t('如：袋、个、kg'),
          maxlength: 32,
          okText: I18N.t('新增')
        }).then(function (unit) {
          unit = unit ? unit.trim() : '';
          if (!unit) {
            paintUnitOptions(previousUnit);
            return;
          }
          if (formUnits.indexOf(unit) < 0) { formUnits.push(unit); }
          paintUnitOptions(unit);
        });
      });
      var shelfInput = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '1', placeholder: I18N.t('如：7'), value: item && item.shelf_life_days !== null && item.shelf_life_days !== undefined ? item.shelf_life_days : '' });
      var minInput = h('input', { class: 'input quantity-input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1', placeholder: I18N.t('如：2'), value: item && item.min_stock !== null && item.min_stock !== undefined ? item.min_stock : '0' });
      var dailyCountInput = h('input', { type: 'checkbox' });
      var weeklyCountInput = h('input', { type: 'checkbox' });
      dailyCountInput.checked = item ? item.daily_count_enabled !== false : true;
      weeklyCountInput.checked = item ? item.weekly_count_enabled !== false : true;

      var form = h('div', { class: 'item-form' },
        window.UI.field(I18N.t('名称 *'), nameInput),
        window.UI.field(I18N.t('分类 *'), catSelect),
        window.UI.field(I18N.t('单位 *'), unitSelect),
        window.UI.field(I18N.t('效期天数 *（从入库起算）'), shelfInput),
        window.UI.field(I18N.t('最低库存（低于此值预警）'), minInput),
        h('div', { class: 'count-scope-field' },
          h('div', { class: 'field-label' }, I18N.t('盘点范围')),
          h('label', { class: 'count-scope-option' }, dailyCountInput, h('span', {}, h('strong', {}, I18N.t('每日盘点')), h('small', {}, I18N.t('进入每日左右滑盘点')))),
          h('label', { class: 'count-scope-option' }, weeklyCountInput, h('span', {}, h('strong', {}, I18N.t('每周盘点')), h('small', {}, I18N.t('进入每周实数盘点'))))
        )
      );
      content.appendChild(form);

      var save = h('button', { class: 'btn btn-primary btn-block' }, isEdit ? I18N.t('保存修改') : I18N.t('新增'));
      save.addEventListener('click', function () {
        var name = nameInput.value.trim();
        var cat = catSelect.value === '__new__' ? '' : catSelect.value.trim();
        var unit = unitSelect.value === '__new__' ? '' : unitSelect.value.trim();
        var shelf = parseInt(shelfInput.value, 10);
        if (!/^\d+(?:\.\d?)?$/.test(minInput.value)) { window.UI.toast(I18N.t('数量必须大于或等于 0，最多一位小数'), 'warn'); return; }
        var min = Number(minInput.value);
        if (!name) { window.UI.toast(I18N.t('请填写名称'), 'warn'); return; }
        if (!cat) { window.UI.toast(I18N.t('请选择或新增分类'), 'warn'); return; }
        if (!unit) { window.UI.toast(I18N.t('请选择或新增单位'), 'warn'); return; }
        if (isNaN(shelf) || shelf < 1) { window.UI.toast(I18N.t('效期天数至少为 1'), 'warn'); return; }
        var payload = {
          name: name, category: cat, unit: unit, shelf_life_days: shelf,
          min_stock: isNaN(min) || min < 0 ? 0 : min,
          daily_count_enabled: dailyCountInput.checked,
          weekly_count_enabled: weeklyCountInput.checked
        };
        var p = isEdit ? API.updateItem(item.id, payload) : API.createItem(payload);
        p.then(function () {
          selectedCategory = cat || '未分类';
          window.UI.toast(isEdit ? I18N.t('已保存') : I18N.t('已新增'), 'success');
          showList();
        }).catch(function (err) {
          if (err && err.silent) { return; }
          window.UI.toast((err && err.message) || I18N.t('保存失败'), 'error');
        });
      });
      var cancel = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('取消'));
      cancel.addEventListener('click', showList);
      setBar(root, [save, cancel]);
    }

    showList();
    return { root: root };
  }

  /* ================= 消耗与补货（店长、管理员） ================= */
  function renderConsumption() {
    var root = h('div', { class: 'page consumption-page' });
    root.appendChild(h('div', { class: 'page-title' }, I18N.t('消耗与补货')));
    root.appendChild(h('p', { class: 'consumption-intro' }, I18N.t('从确认盘点反推用量，优先处理现场缺货与补货风险。')));
    var issueLabels = {
      no_count: I18N.t('尚无有效双人盘点'),
      insufficient_history: I18N.t('需要两次有效盘点结果'),
      corrected_time_unknown: I18N.t('更正数量的实盘时间不明确'),
      invalid_time: I18N.t('盘点时间异常'),
      late_confirmation: I18N.t('盘点与确认相隔超过 6 小时'),
      movement_during_confirmation: I18N.t('盘点至确认间发生库存变动'),
      waste_crosses_count: I18N.t('报损审批跨越盘点，需核对'),
      short_period: I18N.t('两次盘点间隔不足 1 天'),
      outside_window: I18N.t('周期起点超出统计范围'),
      pending_waste: I18N.t('存在待确认报损'),
      negative_consumption: I18N.t('反推用量为负，需核对入库与盘点'),
      stale_count: I18N.t('最近实盘超过 14 天'),
      expired_stock: I18N.t('账面有过期库存，需先核实处理'),
      zero_rate: I18N.t('有效周期用量为零，暂不预测')
    };
    var statusLabels = {
      shortage: I18N.t('今日现场报缺'), reorder: I18N.t('建议补货'),
      review: I18N.t('待核查'), ok: I18N.t('暂可覆盖到货等待期')
    };
    var windowSelect = h('select', { class: 'input', 'aria-label': I18N.t('统计范围') },
      h('option', { value: '28' }, I18N.t('近 28 天')),
      h('option', { value: '56', selected: 'selected' }, I18N.t('近 56 天')),
      h('option', { value: '84' }, I18N.t('近 84 天'))
    );
    var lead = h('input', { class: 'input', type: 'number', min: '0', max: '30', step: '1', value: '2', required: 'required', 'aria-label': I18N.t('到货等待天数') });
    var coverage = h('input', { class: 'input', type: 'number', min: '1', max: '30', step: '1', value: '7', required: 'required', 'aria-label': I18N.t('到货后覆盖天数') });
    var apply = h('button', { class: 'btn btn-primary', type: 'submit' }, I18N.t('更新测算'));
    var form = h('form', { class: 'consumption-controls' },
      window.UI.field(I18N.t('统计范围'), windowSelect),
      h('div', { class: 'consumption-control-pair' },
        window.UI.field(I18N.t('到货等待天数'), lead), window.UI.field(I18N.t('到货后覆盖天数'), coverage)), apply
    );
    root.appendChild(form);
    var settings = h('details', { class: 'consumption-settings' }, h('summary', {}, I18N.t('测算设置')), form);
    root.appendChild(settings);
    var help = h('details', { class: 'consumption-method' },
      h('summary', {}, I18N.t('计算口径与使用说明')),
      h('p', {}, I18N.t('推算使用量 = 期初实盘 + 实际入库 − 期末实盘 − 已确认报损。盘点调账不重复计入。')),
      h('p', {}, I18N.t('平均日耗按完整有效周期的总用量 ÷ 总自然天数计算，暂未区分营业日。每天的实际用量可能不同。')),
      h('p', {}, I18N.t('盘点时间取最终采用记录的提交或最后编辑时间；报损以登记时间近似发生时间。无法确定时间的周期不用于预测。')),
      h('p', {}, I18N.t('备货缺口按到货等待期、覆盖期和最低库存计算，并按保质期限制目标数量。未扣除待到货订单，请核对订单与包装规格后采购。')),
      h('p', {}, I18N.t('预测不修改库存账。推算使用量可能包含漏报损耗；批次临期数量是账面提示，需现场核实。'))
    );
    root.appendChild(help);
    var content = h('div', { 'aria-live': 'polite' });
    root.appendChild(content);
    var search = h('input', { class: 'search-input', type: 'search', placeholder: I18N.t('搜索品名或分类…'), 'aria-label': I18N.t('搜索品名或分类…') });
    var list = h('div', { class: 'consumption-list' });
    var data = null;
    var activeFilter = 'all';
    var generation = 0;
    function number(v) {
      return v === null || v === undefined ? '—' : Number(v).toLocaleString(I18N.getLang(), { maximumFractionDigits: 1 });
    }
    function quantity(v, unit) { return number(v) + (v === null || v === undefined ? '' : ' ' + unit); }
    function metric(label, value) {
      return h('div', { class: 'consumption-metric' }, h('span', {}, label), h('strong', {}, value));
    }
    function draw() {
      list.innerHTML = '';
      var q = search.value.trim().toLowerCase();
      var visible = data.items.filter(function (row) {
        return (row.name + ' ' + row.category).toLowerCase().indexOf(q) >= 0 &&
          (activeFilter === 'all' || (activeFilter === 'urgent' && (row.status === 'shortage' || row.status === 'reorder')) ||
          (activeFilter === 'review' && row.forecast_issue) || (activeFilter === 'expiry' && row.expiring_qty > 0));
      });
      if (!visible.length) { list.appendChild(window.UI.emptyView(I18N.t('没有匹配的库存品'))); }
      visible.forEach(function (row) {
        var card = h('article', { class: 'consumption-card consumption-' + row.status },
          h('div', { class: 'consumption-card-head' }, h('div', {}, h('h2', {}, row.name), h('span', { class: 'consumption-category' }, row.category || I18N.t('未分类'))),
            h('span', { class: 'consumption-status' }, statusLabels[row.status])),
          h('div', { class: 'consumption-metrics' },
            metric(I18N.t('账面库存'), quantity(row.book_stock, row.unit)),
            metric(I18N.t('最近实盘'), quantity(row.last_count_qty, row.unit)),
            metric(I18N.t('预计余量'), quantity(row.estimated_qty, row.unit))),
          h('div', { class: 'consumption-prediction' },
            metric(I18N.t('平均日耗'), quantity(row.daily_rate, row.unit)),
            metric(I18N.t('预计可用天数'), number(row.days_remaining))),
          h('p', { class: 'consumption-meta' }, row.last_count_at ? I18N.t('采用记录：{time}', { time: fmtDateTime(row.last_count_at) }) : I18N.t('尚无有效双人盘点')),
          h('p', { class: 'consumption-meta' }, I18N.t('有效周期 {valid} / {total}', { valid: row.valid_periods, total: row.period_count }))
        );
        if (row.forecast_issue) {
          card.appendChild(h('p', { class: 'consumption-warning' }, issueLabels[row.forecast_issue] || row.forecast_issue));
        }
        if (row.daily_shortage) { card.appendChild(h('p', { class: 'consumption-warning' }, I18N.t('现场反馈优先，请核实余量并安排补货。'))); }
        if (row.expiring_qty > 0) {
          card.appendChild(h('p', { class: 'consumption-warning' }, I18N.t('3 天内到期及已过期账面数量：{qty}', { qty: quantity(row.expiring_qty, row.unit) })));
        }
        if (row.replenishment_gap !== null) {
          card.appendChild(h('div', { class: 'consumption-gap' }, I18N.t('备货缺口（未扣在途）'), h('strong', {}, quantity(row.replenishment_gap, row.unit))));
        }
        if (row.ordered_qty > 0) {
          card.appendChild(h('p', { class: 'consumption-warning' }, I18N.t('待到货 {qty}，请先核对订单，避免重复采购。', { qty: quantity(row.ordered_qty, row.unit) })));
        }
        var detail = h('details', { class: 'consumption-detail' }, h('summary', {}, I18N.t('消耗趋势与计算依据')));
        detail.appendChild(h('p', { class: 'consumption-meta' }, I18N.t('有效周期使用量 {qty}，覆盖 {days} 天。', { qty: quantity(row.consumption, row.unit), days: number(row.sample_days) })));
        if (row.estimated_qty !== null) {
          detail.appendChild(h('p', { class: 'consumption-meta' }, I18N.t('自最近实盘后：入库 {received}，报损 {waste}，经过约 {days} 天。', {
            received: quantity(row.received_since_count, row.unit), waste: quantity(row.waste_since_count, row.unit), days: number(row.count_age_days)
          })));
        }
        if (!row.periods.length) { detail.appendChild(h('p', { class: 'consumption-meta' }, I18N.t('统计范围内还没有完整盘点周期。'))); }
        var maxRate = Math.max.apply(null, [1].concat(row.periods.map(function (p) { return p.exclusion ? 0 : p.daily_rate || 0; })));
        row.periods.forEach(function (p) {
          var period = h('div', { class: 'consumption-period' + (p.exclusion ? ' excluded' : '') },
            h('strong', {}, fmtDateShort(p.start_at) + ' → ' + fmtDateShort(p.end_at)),
            h('p', {}, I18N.t('推算使用 {qty} · 日均 {rate}', { qty: quantity(p.consumption, row.unit), rate: number(p.daily_rate) })),
            h('div', { class: 'consumption-trend', 'aria-hidden': 'true' }, h('div', { style: 'width:' + (p.exclusion ? 0 : Math.max(0, p.daily_rate || 0) / maxRate * 100) + '%' })),
            h('p', { class: 'consumption-meta' }, I18N.t('{opening} + 入库 {received} − 实盘 {closing} − 报损 {waste} = {used}', {
              opening: p.opening_qty, received: p.received, closing: p.closing_qty, waste: p.waste, used: p.consumption
            })),
            h('p', { class: 'consumption-meta' }, I18N.t('确认结果 #{first} → #{second} · {days} 天', { first: p.opening_comparison_id, second: p.closing_comparison_id, days: number(p.days) }))
          );
          if (p.exclusion) { period.appendChild(h('p', { class: 'consumption-warning' }, I18N.t('未纳入预测：{reason}', { reason: issueLabels[p.exclusion] || p.exclusion }))); }
          detail.appendChild(period);
        });
        card.appendChild(detail);
        list.appendChild(card);
      });
    }
    function load() {
      var requestGeneration = ++generation;
      apply.disabled = true;
      content.innerHTML = '';
      content.appendChild(window.UI.loadingView());
      API.consumption(Number(windowSelect.value), Number(lead.value), Number(coverage.value)).then(function (result) {
        if (requestGeneration !== generation) { return; }
        data = result;
        content.innerHTML = '';
        content.appendChild(h('p', { class: 'consumption-meta' }, I18N.t('测算时间：{time}', { time: fmtDateTime(data.as_of) })));
        content.appendChild(h('p', { class: 'consumption-meta' }, I18N.t('近 {days} 天 · 等待 {lead} 天 · 到货后覆盖 {coverage} 天', { days: data.days, lead: data.lead_days, coverage: data.coverage_days })));
        var filters = [
          { key: 'all', label: I18N.t('全部'), count: data.items.length },
          { key: 'urgent', label: I18N.t('优先补货'), count: data.items.filter(function (r) { return r.status === 'shortage' || r.status === 'reorder'; }).length },
          { key: 'review', label: I18N.t('待核查'), count: data.items.filter(function (r) { return r.forecast_issue; }).length },
          { key: 'expiry', label: I18N.t('临期核实'), count: data.items.filter(function (r) { return r.expiring_qty > 0; }).length }
        ];
        var filterBar = h('div', { class: 'consumption-filters', 'aria-label': I18N.t('筛选库存品') });
        filters.forEach(function (f) {
          var button = h('button', { type: 'button', 'aria-pressed': String(activeFilter === f.key) }, h('strong', {}, String(f.count)), h('span', {}, f.label));
          button.addEventListener('click', function () {
            activeFilter = f.key;
            Array.prototype.forEach.call(filterBar.children, function (b) { b.setAttribute('aria-pressed', String(b === button)); });
            draw();
          });
          filterBar.appendChild(button);
        });
        content.appendChild(filterBar);
        content.appendChild(search);
        content.appendChild(list);
        draw();
      }).catch(function (err) {
        if (requestGeneration !== generation || (err && err.silent)) { return; }
        content.innerHTML = '';
        content.appendChild(window.UI.errorView(err.message || I18N.t('加载失败'), load));
      }).then(function () { if (requestGeneration === generation) { apply.disabled = false; } });
    }
    search.addEventListener('input', function () { if (data) { draw(); } });
    form.addEventListener('submit', function (event) { event.preventDefault(); load(); });
    var actions = h('div', { class: 'consumption-actions' });
    [
      { label: I18N.t('查看采购订单'), to: '#/purchase' },
      { label: I18N.t('盘点管理'), to: '#/count-review' },
      { label: I18N.t('库存查询'), to: '#/stock' }
    ].forEach(function (action) {
      var button = h('button', { class: 'btn btn-ghost', type: 'button' }, action.label);
      button.addEventListener('click', function () { location.hash = action.to; });
      actions.appendChild(button);
    });
    root.appendChild(actions);
    load();
    return { root: root };
  }

  /* ================= 库存总览 ================= */
  function renderStock() {
    var root = h('div', { class: 'page stock-page' });
    var categoryNav = h('select', { class: 'item-category-nav stock-category-nav', 'aria-label': I18N.t('库存分类导航'), disabled: 'disabled' },
      h('option', { value: '__all__' }, I18N.t('分类加载中…'))
    );
    root.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'page-title' }, I18N.t('库存总览')),
      categoryNav
    ));
    var search = h('input', { class: 'search-input', type: 'search', placeholder: I18N.t('搜索品名或分类…') });
    root.appendChild(search);
    var listWrap = h('div', { class: 'stock-list' });
    root.appendChild(listWrap);
    listWrap.appendChild(window.UI.loadingView());

    var rows = [];
    var filtered = [];
    var selectedCategory = '__all__';

    function paint() {
      listWrap.innerHTML = '';
      if (!filtered.length) {
        listWrap.appendChild(window.UI.emptyView(I18N.t('没有匹配的库存品')));
        return;
      }
      filtered.forEach(function (r) {
        var it = r.item || {};
        var stock = Number(r.stock || 0);
        var minStock = Number(it.min_stock || 0);
        var stockClass = stock >= minStock ? 'stock-qty safe' : 'stock-qty low';
        var row = h('button', { class: 'stock-row' },
          h('div', { class: 'stock-info' },
            h('div', { class: 'stock-name' }, it.name || I18N.t('商品')),
            h('div', { class: 'stock-sub' },
              (it.category || '') +
              (r.batch_count !== null && r.batch_count !== undefined ? ' · ' + I18N.t('{n} 个批次', { n: r.batch_count }) : '') +
              ' · ' + I18N.t('安全线 {n} {unit}', { n: minStock, unit: it.unit || '' }) +
              ' · ' + I18N.t('最近效期 {date}', { date: r.nearest_expiry || '—' })
            )
          ),
          h('div', { class: stockClass }, (r.stock !== null && r.stock !== undefined ? r.stock : '—') + ' ' + (it.unit || ''))
        );
        row.addEventListener('click', function () { openBatches(r); });
        listWrap.appendChild(row);
      });
    }

    function applyFilters() {
      var q = search.value.trim().toLowerCase();
      filtered = rows.filter(function (r) {
        var it = r.item || {};
        var category = it.category || '未分类';
        var matchesCategory = selectedCategory === '__all__' || category === selectedCategory;
        var matchesSearch = !q || (it.name || '').toLowerCase().indexOf(q) >= 0 ||
          category.toLowerCase().indexOf(q) >= 0;
        return matchesCategory && matchesSearch;
      });
      paint();
    }

    search.addEventListener('input', applyFilters);
    categoryNav.addEventListener('change', function () {
      selectedCategory = categoryNav.value;
      applyFilters();
    });

    function openBatches(r) {
      if (!r.item || !r.item.id) { return; }
      var it = r.item || {};
      var sheet = window.UI.openSheet({
        title: I18N.t('{name} · 库存 {n} {unit}', { name: it.name || I18N.t('商品'), n: r.stock !== null && r.stock !== undefined ? r.stock : '—', unit: it.unit || '' })
      });
      sheet.body.appendChild(window.UI.loadingView(I18N.t('加载批次…')));
      API.itemBatches(r.item.id).then(function (batches) {
        batches = batches || [];
        sheet.body.innerHTML = '';
        if (!batches.length) {
          sheet.body.appendChild(window.UI.emptyView(I18N.t('暂无批次')));
          return;
        }
        batches.forEach(function (b) {
          var d = b.days_to_expiry;
          var daysEl = h('span', { class: 'batch-days' + (d !== null && d !== undefined && d <= 0 ? ' bad' : (d !== null && d !== undefined && d <= 3 ? ' soon' : '')) });
          if (d === null || d === undefined) { daysEl.textContent = '—'; }
          else if (d < 0) { daysEl.textContent = I18N.t('过期 {n} 天', { n: -d }); }
          else if (d === 0) { daysEl.textContent = I18N.t('今天到期'); }
          else { daysEl.textContent = I18N.t('还有 {n} 天', { n: d }); }
          var row = h('div', { class: 'batch-row' },
            h('div', { class: 'batch-info' },
              h('div', { class: 'batch-exp' }, I18N.t('效期 {date}', { date: b.expiry_date || '—' })),
              h('div', { class: 'batch-sub' }, (SOURCE_LABEL[b.source] || b.source || '') + (b.received_at ? ' · ' + I18N.t('入库 {date}', { date: fmtDateShort(b.received_at) }) : ''))
            ),
            h('div', { class: 'batch-right' },
              h('div', { class: 'batch-qty' }, b.qty + ' ' + (it.unit || '')),
              daysEl
            )
          );
          sheet.body.appendChild(row);
        });
      }).catch(function (err) {
        sheet.body.innerHTML = '';
        sheet.body.appendChild(window.UI.errorView((err && err.message) || I18N.t('批次加载失败')));
      });
    }

    return API.stock().then(function (data) {
      rows = data || [];
      var categoryCounts = {};
      rows.forEach(function (row) {
        var category = (row.item && row.item.category) || '未分类';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      });
      var categories = Object.keys(categoryCounts).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
      categoryNav.innerHTML = '';
      categoryNav.appendChild(h('option', { value: '__all__' }, I18N.t('全部 {n}', { n: rows.length })));
      categories.forEach(function (category) {
        categoryNav.appendChild(h('option', { value: category }, I18N.t(category) + ' ' + categoryCounts[category]));
      });
      categoryNav.disabled = false;
      applyFilters();
      return { root: root };
    }).catch(function (err) {
      if (err && err.silent) { return { root: h('div', { class: 'page' }) }; }
      listWrap.innerHTML = '';
      listWrap.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), renderRoute));
      return { root: root };
    });
  }

  /* ================= 用户管理（admin） ================= */
  function renderUsers() {
    var root = h('div', { class: 'page users-page' });
    var content = h('div', {});
    root.appendChild(content);

    function showList() {
      setBar(root, null);
      content.innerHTML = '';
      var addBtn = h('button', { class: 'btn btn-primary btn-sm' }, I18N.t('+ 新增用户'));
      addBtn.addEventListener('click', function () { showForm(); });
      content.appendChild(h('div', { class: 'page-head' },
        h('div', { class: 'page-title' }, I18N.t('用户管理')),
        addBtn
      ));
      content.appendChild(window.UI.loadingView());
      API.users().then(function (list) {
        list = list || [];
        content.innerHTML = '';
        var addBtn2 = h('button', { class: 'btn btn-primary btn-sm' }, I18N.t('+ 新增用户'));
        addBtn2.addEventListener('click', function () { showForm(); });
        content.appendChild(h('div', { class: 'page-head' },
          h('div', { class: 'page-title' }, I18N.t('用户管理')),
          addBtn2
        ));
        if (!list.length) {
          content.appendChild(window.UI.emptyView(I18N.t('暂无用户')));
          return;
        }
        var wrap = h('div', { class: 'user-list' });
        var currentAdmin = API.store.getUser();
        list.forEach(function (u) {
          var name = u.display_name || u.username || '?';
          var sw = window.UI.toggleSwitch(u.active, function (val) {
            API.updateUser(u.id, { active: val }).then(function () {
              window.UI.toast(val ? I18N.t('已启用') : I18N.t('已停用'), 'info');
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
              sw.querySelector('input').checked = !val;
            });
          });
          var resetBtn = h('button', { class: 'btn btn-ghost btn-sm' }, I18N.t('重置 PIN'));
          resetBtn.addEventListener('click', function () {
            window.UI.pinPrompt({
              title: I18N.t('重置 {name} 的 PIN', { name: name }),
              subtitle: I18N.t('输入新 PIN（4-6 位数字）')
            }).then(function (pin1) {
              if (!pin1) { return false; }
              return window.UI.pinPrompt({ title: I18N.t('再次输入'), subtitle: I18N.t('确认新 PIN') }).then(function (pin2) {
                if (!pin2) { return false; }
                if (pin1 !== pin2) {
                  window.UI.toast(I18N.t('两次输入不一致'), 'error');
                  return false;
                }
                return API.updateUser(u.id, { pin: pin1 }).then(function () { return true; });
              });
            }).then(function (updated) {
              if (updated) { window.UI.toast(I18N.t('PIN 已重置'), 'success'); }
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
            });
          });
          var editBtn = h('button', { class: 'btn btn-ghost btn-sm' }, I18N.t('编辑资料'));
          editBtn.addEventListener('click', function () {
            window.UI.formPrompt({
              title: I18N.t('编辑 {name} 的资料', { name: name }),
              subtitle: I18N.t('用户名不区分大小写；修改用户名后，该用户当前登录会立即失效。'),
              okText: I18N.t('保存'),
              fields: [
                { key: 'display_name', label: I18N.t('姓名'), value: u.display_name || '', placeholder: I18N.t('姓名'), maxlength: 128 },
                { key: 'username', label: I18N.t('登录用户名'), value: u.username || '', placeholder: I18N.t('登录用户名'), maxlength: 64 }
              ]
            }).then(function (values) {
              if (values === null) { return null; }
              var displayName = values.display_name.trim();
              var username = values.username.trim().toLowerCase();
              var payload = {};
              if (displayName !== (u.display_name || '')) { payload.display_name = displayName; }
              if (username !== u.username) { payload.username = username; }
              if (!Object.keys(payload).length) { return null; }
              var doSubmit = function () { return API.updateUser(u.id, payload); };
              if (payload.username) {
                return window.UI.dialog({
                  title: I18N.t('确认修改用户名'),
                  message: '@' + u.username + ' → @' + payload.username + '\n' + I18N.t('该用户需要使用新用户名重新登录。'),
                  options: [
                    { label: I18N.t('确认修改'), value: true, kind: 'primary' },
                    { label: I18N.t('取消'), value: null, kind: 'ghost' }
                  ]
                }).then(function (confirmed) {
                  if (!confirmed) { return null; }
                  return doSubmit().then(function (res) { return { res: res, usernameChanged: true }; });
                });
              }
              return doSubmit().then(function (res) { return { res: res, usernameChanged: false }; });
            }).then(function (outcome) {
              if (!outcome) { return; }
              var updated = outcome.res;
              var current = API.store.getUser();
              if (current && current.id === u.id) {
                if (outcome.usernameChanged) {
                  API.store.clear();
                  window.UI.toast(I18N.t('用户名已修改，请使用新用户名重新登录'), 'success', 3500);
                  location.hash = '#/login';
                  return;
                }
                // 仅改自己姓名：旧登录仍有效，更新本地缓存
                current.display_name = updated.display_name;
                API.store.setUser(current);
                window.UI.toast(I18N.t('资料已更新'), 'success');
                showList();
                return;
              }
              window.UI.toast(
                outcome.usernameChanged ? I18N.t('用户名已修改，旧登录已失效') : I18N.t('资料已更新'),
                'success'
              );
              showList();
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
            });
          });
          var roleBtn = h('button', {
            class: 'btn btn-ghost btn-sm',
            disabled: currentAdmin && currentAdmin.id === u.id ? 'disabled' : null,
            title: currentAdmin && currentAdmin.id === u.id ? I18N.t('不能修改自己的身份') : I18N.t('调整用户身份')
          }, currentAdmin && currentAdmin.id === u.id ? I18N.t('当前身份') : I18N.t('调整身份'));
          roleBtn.addEventListener('click', function () {
            if (currentAdmin && currentAdmin.id === u.id) { return; }
            window.UI.dialog({
              title: I18N.t('调整 {name} 的身份', { name: name }),
              message: I18N.t('身份变化后，该用户当前登录会立即失效。'),
              options: [
                { label: I18N.t('店员') + (u.role === 'staff' ? I18N.t('（当前）') : ''), value: 'staff', kind: u.role === 'staff' ? 'primary' : 'ghost' },
                { label: I18N.t('店长') + (u.role === 'manager' ? I18N.t('（当前）') : ''), value: 'manager', kind: u.role === 'manager' ? 'primary' : 'ghost' },
                { label: I18N.t('管理员') + (u.role === 'admin' ? I18N.t('（当前）') : ''), value: 'admin', kind: u.role === 'admin' ? 'primary' : 'ghost' },
                { label: I18N.t('取消'), value: null, kind: 'ghost' }
              ]
            }).then(function (role) {
              if (!role || role === u.role) { return null; }
              return window.UI.dialog({
                title: I18N.t('确认调整权限'),
                message: I18N.t('{name}：{from} → {to}', { name: name, from: roleLabel(u.role), to: roleLabel(role) }),
                options: [
                  { label: I18N.t('确认调整'), value: true, kind: role === 'admin' ? 'danger' : 'primary' },
                  { label: I18N.t('取消'), value: null, kind: 'ghost' }
                ]
              }).then(function (confirmed) {
                if (!confirmed) { return null; }
                return API.updateUser(u.id, { role: role });
              });
            }).then(function (updated) {
              if (!updated) { return; }
              window.UI.toast(I18N.t('用户身份已调整，旧登录已失效'), 'success');
              showList();
            }).catch(function (err) {
              if (err && err.silent) { return; }
              window.UI.toast((err && err.message) || I18N.t('操作失败'), 'error');
            });
          });
          var card = h('div', { class: 'user-row' },
            h('div', { class: 'user-avatar' }, name.slice(0, 1)),
            h('div', { class: 'user-meta' },
              h('div', { class: 'user-name' }, name, u.active === false ? h('span', { class: 'tag muted' }, ' ' + I18N.t('已停用')) : null),
              h('div', { class: 'user-sub' }, '@' + (u.username || '') + ' · ' + roleLabel(u.role))
            ),
            h('div', { class: 'user-actions' }, roleBtn, editBtn, resetBtn, sw)
          );
          wrap.appendChild(card);
        });
        content.appendChild(wrap);
      }).catch(function (err) {
        if (err && err.silent) { return; }
        content.appendChild(window.UI.errorView((err && err.message) || I18N.t('加载失败'), showList));
      });
    }

    function showForm() {
      setBar(root, null);
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'page-title' }, I18N.t('新增用户')));

      var nameInput = h('input', { class: 'input', type: 'text', placeholder: I18N.t('如：张三') });
      var userInput = h('input', { class: 'input', type: 'text', placeholder: I18N.t('如：zhangsan') });
      var roleChips = window.UI.chips([
        { value: 'staff', label: I18N.t('店员') },
        { value: 'manager', label: I18N.t('店长') },
        { value: 'admin', label: I18N.t('管理员') }
      ], { selected: ['staff'] });
      var pin = '';
      var pinBtn = h('button', { class: 'input pin-input-btn', type: 'button' }, I18N.t('点击输入 PIN'));
      pinBtn.addEventListener('click', function () {
        window.UI.pinPrompt({ title: I18N.t('设置 PIN'), subtitle: I18N.t('4-6 位数字') }).then(function (p) {
          if (!p) { return; }
          pin = p;
          pinBtn.textContent = I18N.t('PIN：{dots}', { dots: new Array(Math.min(p.length, 6) + 1).join('•') });
        });
      });

      var form = h('div', { class: 'item-form' },
        window.UI.field(I18N.t('姓名 *'), nameInput),
        window.UI.field(I18N.t('用户名 *（登录账号）'), userInput),
        window.UI.field(I18N.t('角色'), roleChips.el),
        window.UI.field(I18N.t('PIN *（4-6 位数字）'), pinBtn)
      );
      content.appendChild(form);

      var save = h('button', { class: 'btn btn-primary btn-block' }, I18N.t('创建用户'));
      save.addEventListener('click', function () {
        var name = nameInput.value.trim();
        var username = userInput.value.trim();
        var role = roleChips.get() || 'staff';
        if (!name) { window.UI.toast(I18N.t('请填写姓名'), 'warn'); return; }
        if (!username) { window.UI.toast(I18N.t('请填写用户名'), 'warn'); return; }
        if (!/^\d{4,6}$/.test(pin)) { window.UI.toast(I18N.t('请设置 4-6 位数字 PIN'), 'warn'); return; }
        API.createUser({ display_name: name, username: username, role: role, pin: pin }).then(function () {
          window.UI.toast(I18N.t('用户已创建'), 'success');
          showList();
        }).catch(function (err) {
          if (err && err.silent) { return; }
          window.UI.toast((err && err.message) || I18N.t('创建失败'), 'error');
        });
      });
      var cancel = h('button', { class: 'btn btn-ghost btn-block' }, I18N.t('取消'));
      cancel.addEventListener('click', showList);
      setBar(root, [save, cancel]);
    }

    showList();
    return { root: root };
  }

  /* ---------- 路由表 ---------- */
  function redirectLegacyCountSummary() {
    var user = API.store.getUser() || {};
    location.replace(user.role === 'staff' ? '#/count-weekly?tab=records' : '#/count-review?tab=records');
    return { root: h('div', { class: 'page' }, window.UI.loadingView(I18N.t('正在打开盘点记录…'))) };
  }

  var routes = {
    '/': { render: renderHome },
    '/login': { render: renderLogin, public: true },
    '/count': { render: renderDailyCount },
    '/count-daily': { render: renderDailyCount },
    '/count-weekly': { render: renderWeeklyCount, roles: ['staff', 'manager'] },
    '/count-summary': { render: redirectLegacyCountSummary, roles: ['staff', 'manager', 'admin'] },
    '/count-daily-results': { render: renderDailyCountResults, roles: ['staff', 'manager', 'admin'] },
    '/waste': { render: renderWaste },
    '/expiry': { render: renderExpiry },
    '/count-review': { render: renderCountReview, roles: ['manager', 'admin'] },
    '/waste-review': { render: renderWasteReview, roles: ['manager', 'admin'] },
    '/receive': { render: renderStockReceive, roles: ['manager', 'admin'] },
    '/purchase': { render: renderPurchase, roles: ['manager', 'admin'] },
    '/items': { render: renderItems, roles: ['manager', 'admin'] },
    '/stock': { render: renderStock },
    '/consumption': { render: renderConsumption, roles: ['manager', 'admin'] },
    '/users': { render: renderUsers, roles: ['admin'] }
  };

  window.__reloadRoute = renderRoute;

  /* ---------- 启动 ---------- */
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('offline', function () { API.setConnectivity(false); });
  window.addEventListener('online', function () {
    API.reconnect().then(function (ok) { if (ok) { renderRoute(); } });
  });
  window.addEventListener('sandwich-data-updated', renderRoute);

  var bootToken = API.store.getToken();
  function start() {
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.replace('#/');
    }
    renderRoute();
  }
  if (bootToken) {
    // 校验 token 并刷新用户信息
    API.me().then(function (me) {
      API.store.setUser(me);
      return ensurePinChanged(me);
    }).then(function () {
      start();
    }).catch(function (err) {
      if (err && err.auth) { /* 401 已由 api 层清空并跳登录 */ }
      start();
    });
  } else {
    start();
  }
})();
