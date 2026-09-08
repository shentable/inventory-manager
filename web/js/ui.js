/* ===== UI 组件：DOM 助手、toast、对话框、PIN 键盘、底部面板、步进器、chips、开关、离线提示 ===== */
(function () {
  'use strict';

  var t = window.I18N && window.I18N.t ? window.I18N.t : function (s) { return s; };
  function curLang() { return window.I18N && window.I18N.getLang ? window.I18N.getLang() : undefined; }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
        var v = attrs[k];
        if (v === undefined || v === null) { continue; }
        if (k === 'class') { el.className = v; }
        else if (k === 'style') { el.style.cssText = v; }
        else if (k === 'dataset') { for (var dk in v) { if (Object.prototype.hasOwnProperty.call(v, dk)) { el.dataset[dk] = v[dk]; } } }
        else if (k === 'value') { el.setAttribute('value', v); }
        else { el.setAttribute(k, v); }
      }
    }
    var children = Array.prototype.slice.call(arguments, 2).flat(Infinity);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false) { continue; }
      if (c instanceof Node) { el.appendChild(c); }
      else { el.appendChild(document.createTextNode(String(c))); }
    }
    return el;
  }

  function clampNum(v, min, max) {
    v = Number(v);
    if (isNaN(v)) { v = min; }
    if (v < min) { v = min; }
    if (v > max) { v = max; }
    return v;
  }

  /* ---------- Toast ---------- */
  var toastBox = null;
  function toast(msg, type, duration) {
    type = type || 'info';
    duration = duration || 2400;
    if (!toastBox) {
      toastBox = h('div', { class: 'toast-box' });
      document.body.appendChild(toastBox);
    }
    var icons = { success: '✓', error: '✕', info: 'ℹ', warn: '!' };
    var t = h('div', { class: 'toast toast-' + type },
      h('span', { class: 'toast-icon' }, icons[type] || ''),
      h('span', { class: 'toast-msg' }, msg)
    );
    toastBox.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 320);
    }, duration);
  }

  /* ---------- 对话框（底部弹出，返回所选 option 的 value，取消返回 null） ---------- */
  function dialog(opts) {
    opts = opts || {};
    var options = opts.options || [
      { label: opts.okText || t('确定'), value: true, kind: opts.danger ? 'danger' : 'primary' },
      { label: opts.cancelText || t('取消'), value: null, kind: 'ghost' }
    ];
    return new Promise(function (resolve) {
      var overlay = h('div', { class: 'overlay' });
      var card = h('div', { class: 'dialog' });
      if (opts.title) { card.appendChild(h('div', { class: 'dialog-title' }, opts.title)); }
      if (opts.message) { card.appendChild(h('div', { class: 'dialog-msg' }, opts.message)); }
      var done = false;
      function finish(val) {
        if (done) { return; }
        done = true;
        overlay.classList.add('hide');
        setTimeout(function () { if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); } }, 200);
        resolve(val);
      }
      for (var i = 0; i < options.length; i++) {
        (function (o) {
          var cls = 'btn btn-block btn-' + (o.kind || 'primary');
          var b = h('button', { class: cls }, o.label);
          b.addEventListener('click', function () { finish(o.value); });
          card.appendChild(b);
        })(options[i]);
      }
      overlay.appendChild(card);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { finish(null); } });
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); });
    });
  }

  /* ---------- 多字段表单弹窗（返回 {key: value}，取消返回 null） ---------- */
  function formPrompt(opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    return new Promise(function (resolve) {
      var overlay = h('div', { class: 'overlay' });
      var card = h('form', { class: 'dialog text-prompt' });
      if (opts.title) { card.appendChild(h('div', { class: 'dialog-title' }, opts.title)); }
      if (opts.subtitle) { card.appendChild(h('div', { class: 'dialog-msg' }, opts.subtitle)); }
      var inputs = [];
      fields.forEach(function (f) {
        if (f.label) { card.appendChild(h('label', { class: 'text-prompt-label' }, f.label)); }
        var input = h('input', {
          class: 'input text-prompt-input',
          type: f.type || 'text',
          value: f.value || '',
          placeholder: f.placeholder || '',
          maxlength: f.maxlength || 128,
          autocomplete: 'off',
          autocapitalize: 'none',
          spellcheck: 'false'
        });
        input.setAttribute('data-key', f.key || '');
        card.appendChild(input);
        inputs.push({ key: f.key, input: input, required: f.required !== false, label: f.label });
      });
      var error = h('div', { class: 'text-prompt-error', role: 'alert' });
      card.appendChild(error);
      var actions = h('div', { class: 'text-prompt-actions' });
      var cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, opts.cancelText || t('取消'));
      var save = h('button', { class: 'btn btn-primary', type: 'submit' }, opts.okText || t('继续'));
      actions.appendChild(cancel);
      actions.appendChild(save);
      card.appendChild(actions);
      var done = false;
      function finish(value) {
        if (done) { return; }
        done = true;
        overlay.classList.add('hide');
        setTimeout(function () {
          if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
          resolve(value);
        }, 200);
      }
      cancel.addEventListener('click', function () { finish(null); });
      card.addEventListener('submit', function (event) {
        event.preventDefault();
        var values = {};
        for (var i = 0; i < inputs.length; i++) {
          var it = inputs[i];
          var v = it.input.value.trim();
          if (it.required && !v) {
            error.textContent = t('请填写{label}', { label: it.label || '' });
            it.input.focus();
            return;
          }
          values[it.key] = v;
        }
        finish(values);
      });
      overlay.appendChild(card);
      overlay.addEventListener('click', function (event) { if (event.target === overlay) { finish(null); } });
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); });
      if (inputs.length) { inputs[0].input.focus(); }
    });
  }


  /* ---------- 文本输入框（返回输入字符串，取消返回 null） ---------- */
  function textPrompt(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = h('div', { class: 'overlay' });
      var card = h('form', { class: 'dialog text-prompt' });
      if (opts.title) { card.appendChild(h('div', { class: 'dialog-title' }, opts.title)); }
      if (opts.subtitle) { card.appendChild(h('div', { class: 'dialog-msg' }, opts.subtitle)); }
      var input = h('input', {
        class: 'input text-prompt-input',
        type: 'text',
        value: opts.value || '',
        placeholder: opts.placeholder || '',
        maxlength: opts.maxlength || 128,
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false'
      });
      card.appendChild(input);
      var error = h('div', { class: 'text-prompt-error', role: 'alert' });
      card.appendChild(error);
      var actions = h('div', { class: 'text-prompt-actions' });
      var cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, opts.cancelText || t('取消'));
      var save = h('button', { class: 'btn btn-primary', type: 'submit' }, opts.okText || t('继续'));
      actions.appendChild(cancel);
      actions.appendChild(save);
      card.appendChild(actions);
      var done = false;
      function finish(value) {
        if (done) { return; }
        done = true;
        overlay.classList.add('hide');
        setTimeout(function () {
          if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
          resolve(value);
        }, 200);
      }
      cancel.addEventListener('click', function () { finish(null); });
      card.addEventListener('submit', function (event) {
        event.preventDefault();
        var value = input.value.trim();
        if (!value) {
          error.textContent = opts.emptyMessage || t('请输入内容');
          input.focus();
          return;
        }
        finish(value);
      });
      overlay.appendChild(card);
      overlay.addEventListener('click', function (event) { if (event.target === overlay) { finish(null); } });
      document.body.appendChild(overlay);
      requestAnimationFrame(function () {
        overlay.classList.add('show');
        input.focus();
        input.select();
      });
    });
  }

  /* ---------- PIN 键盘（4-6 位数字，返回 PIN 字符串或 null） ---------- */
  function pinPrompt(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var pin = '';
      var overlay = h('div', { class: 'overlay' });
      var card = h('div', { class: 'dialog pin-card' });
      if (opts.title) { card.appendChild(h('div', { class: 'dialog-title' }, opts.title)); }
      if (opts.subtitle) { card.appendChild(h('div', { class: 'dialog-msg' }, opts.subtitle)); }

      var dots = h('div', { class: 'pin-dots' });
      for (var i = 0; i < 6; i++) { dots.appendChild(h('span', { class: 'pin-dot' })); }
      card.appendChild(dots);

      var errEl = h('div', { class: 'pin-error' });
      card.appendChild(errEl);

      var pad = h('div', { class: 'pin-pad' });
      var okBtn = null;

      var done = false;
      function finish(val) {
        if (done) { return; }
        done = true;
        overlay.classList.add('hide');
        // 连续 PIN 步骤必须等旧键盘完全移除后再创建下一套键盘。
        // 若提前 resolve，Android WebView 在退场动画期间可能把点击送到旧键盘。
        setTimeout(function () {
          if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
          resolve(val);
        }, 200);
      }

      function render() {
        for (var j = 0; j < 6; j++) {
          dots.children[j].classList.toggle('on', j < pin.length);
        }
        okBtn.disabled = pin.length < 4;
      }
      function press(d) {
        if (pin.length >= 6) { return; }
        pin += d;
        errEl.textContent = '';
        render();
      }
      function del() {
        pin = pin.slice(0, -1);
        render();
      }

      var rows = [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
        ['del', '0', 'ok']
      ];
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < rows[r].length; c++) {
          var k = rows[r][c];
          var key;
          if (k === 'del') {
            key = h('button', { class: 'pin-key del', 'aria-label': t('删除') }, '⌫');
            key.addEventListener('click', del);
          } else if (k === 'ok') {
            key = h('button', { class: 'pin-key ok', 'aria-label': t('确认') }, t('确认'));
            key.disabled = true;
            key.addEventListener('click', function () { if (pin.length >= 4) { finish(pin); } });
            okBtn = key;
          } else {
            key = h('button', { class: 'pin-key' }, k);
            key.addEventListener('click', function (d) { return function () { press(d); }; }(k));
          }
          pad.appendChild(key);
        }
      }
      card.appendChild(pad);

      var cancelBtn = h('button', { class: 'btn btn-ghost btn-block' }, t('取消'));
      cancelBtn.addEventListener('click', function () { finish(null); });
      card.appendChild(cancelBtn);

      overlay.appendChild(card);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { finish(null); } });
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); });
      render();
    });
  }

  /* ---------- 底部面板（sheet） ---------- */
  function openSheet(opts) {
    opts = opts || {};
    var overlay = h('div', { class: 'overlay' });
    var sheetEl = h('div', { class: 'sheet' });
    var head = h('div', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, opts.title || ''),
      h('button', { class: 'sheet-close', 'aria-label': t('关闭') }, '✕')
    );
    var body = h('div', { class: 'sheet-body' });
    sheetEl.appendChild(head);
    sheetEl.appendChild(body);
    overlay.appendChild(sheetEl);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    function close() {
      overlay.classList.add('hide');
      setTimeout(function () { if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); } }, 200);
    }
    head.querySelector('.sheet-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) { close(); } });

    return { overlay: overlay, body: body, close: close };
  }

  function closeOverlays() {
    var list = document.querySelectorAll('.overlay');
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      o.classList.add('hide');
      setTimeout(function (el) { return function () { if (el.parentNode) { el.parentNode.removeChild(el); } }; }(o), 220);
    }
  }

  /* ---------- 步进器（长按连续增减） ---------- */
  function formatQuantity(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) { return '—'; }
    return String(Number(Number(value).toFixed(1)));
  }
  function validateQuantities(root, values) {
    var inputs = root.querySelectorAll('.quantity-input');
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].checkValidity()) {
        inputs[i].reportValidity();
        toast(t('数量必须大于或等于 0，最多一位小数'), 'warn');
        return false;
      }
    }
    if (values && Object.keys(values).some(function (key) { return !Number.isFinite(values[key]); })) {
      toast(t('请修正无效的数量后再继续'), 'warn');
      return false;
    }
    return true;
  }
  function stepper(init, opts) {
    opts = opts || {};
    var min = opts.min !== undefined ? opts.min : 0;
    var max = opts.max !== undefined ? opts.max : Infinity;
    var step = opts.step || 1;
    var onChange = opts.onChange || null;
    var value = clampNum(init, min, max);

    var root = h('div', { class: 'stepper' });
    var minus = h('button', { class: 'step-btn minus', 'aria-label': t('减少') }, '−');
    var valEl = h('input', { class: 'step-val quantity-input', type: 'number', inputmode: 'decimal',
      step: '0.1', min: String(min), max: Number.isFinite(max) ? String(max) : null,
      required: 'required', 'aria-label': t('数量'), value: formatQuantity(value) });
    var plus = h('button', { class: 'step-btn plus', 'aria-label': t('增加') }, '+');
    root.appendChild(minus);
    root.appendChild(valEl);
    root.appendChild(plus);

    function set(v, notify) {
      value = Math.round(clampNum(v, min, max) * 10) / 10;
      valEl.value = formatQuantity(value);
      minus.disabled = value <= min;
      plus.disabled = value >= max;
      if (notify !== false && onChange) { onChange(value); }
    }

    valEl.addEventListener('input', function () {
      var raw = valEl.value;
      var valid = /^\d+(?:\.\d?)?$/.test(raw) && valEl.checkValidity();
      if (valid) {
        value = Number(raw);
        minus.disabled = value <= min;
        plus.disabled = value >= max;
      }
      if (onChange) { onChange(valid ? value : NaN); }
    });
    valEl.addEventListener('change', function () {
      if (valEl.checkValidity() && /^\d+(?:\.\d?)?$/.test(valEl.value)) { set(Number(valEl.value)); }
    });

    function repeat(btn, delta) {
      var timer = null;
      var interval = null;
      function start(e) {
        if (e && e.preventDefault) { e.preventDefault(); }
        set(value + delta);
        if (timer !== null) { clearTimeout(timer); }
        timer = setTimeout(function () {
          interval = setInterval(function () { set(value + delta); }, 90);
        }, 380);
      }
      function stop() {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (interval !== null) { clearInterval(interval); interval = null; }
      }
      if (window.PointerEvent) {
        btn.addEventListener('pointerdown', start);
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('pointercancel', stop);
        btn.addEventListener('pointerleave', stop);
      } else {
        btn.addEventListener('touchstart', start, { passive: false });
        btn.addEventListener('touchend', stop);
        btn.addEventListener('touchcancel', stop);
        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', stop);
        btn.addEventListener('mouseleave', stop);
      }
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
    repeat(minus, -step);
    repeat(plus, step);
    set(value, false);
    if (!Number.isFinite(Number(init))) { valEl.value = ''; }

    return {
      el: root,
      get: function () { return value; },
      set: set
    };
  }

  /* ---------- chips 单选组 ---------- */
  function chips(items, opts) {
    opts = opts || {};
    var multi = !!opts.multi;
    var state = new Set();
    var selected = opts.selected;
    if (selected !== undefined && selected !== null) {
      (Array.isArray(selected) ? selected : [selected]).forEach(function (s) {
        if (s !== null && s !== undefined) { state.add(String(s)); }
      });
    }
    var onChange = opts.onChange || null;
    var root = h('div', { class: 'chips' });
    var btns = [];

    function paint() {
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', state.has(String(items[i].value)));
      }
    }
    function current() {
      var arr = Array.from(state);
      return multi ? arr : (arr.length ? arr[0] : null);
    }
    function emit() {
      if (onChange) { onChange(current()); }
    }
    function set(v) {
      state.clear();
      if (v !== undefined && v !== null) {
        (Array.isArray(v) ? v : [v]).forEach(function (x) {
          if (x !== null && x !== undefined) { state.add(String(x)); }
        });
      }
      paint();
    }

    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var b = h('button', { class: 'chip' + (state.has(String(it.value)) ? ' active' : '') }, it.label);
        b.addEventListener('click', function () {
          var key = String(it.value);
          if (multi) {
            if (state.has(key)) { state.delete(key); } else { state.add(key); }
          } else {
            state.clear();
            state.add(key);
          }
          paint();
          emit();
        });
        btns.push(b);
        root.appendChild(b);
      })(items[i]);
    }

    return { el: root, get: current, set: set };
  }

  /* ---------- 开关 ---------- */
  function toggleSwitch(checked, onChange) {
    var label = h('label', { class: 'switch' });
    var input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', function () {
      if (onChange) { onChange(input.checked); }
    });
    label.appendChild(input);
    label.appendChild(h('span', { class: 'slider' }));
    return label;
  }

  /* ---------- 表单字段 ---------- */
  function field(labelText, inputEl) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, labelText),
      inputEl
    );
  }

  /* ---------- 固定底部操作栏 ---------- */
  function fixedBar(children) {
    var bar = h('div', { class: 'fixed-bar' });
    var inner = h('div', { class: 'fixed-bar-inner' });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c) { inner.appendChild(c); }
    });
    bar.appendChild(inner);
    return bar;
  }

  /* ---------- 空态 / 加载 / 错误 ---------- */
  function emptyView(text, icon) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon || '📭'),
      h('div', { class: 'empty-text' }, text || t('暂无数据'))
    );
  }
  function loadingView(text) {
    return h('div', { class: 'loading' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'loading-text' }, text || t('加载中…'))
    );
  }
  function errorView(msg, onRetry) {
    var root = h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, '⚠️'),
      h('div', { class: 'empty-text' }, msg || t('加载失败'))
    );
    if (onRetry) {
      var b = h('button', { class: 'btn btn-primary' }, t('重试'));
      b.addEventListener('click', onRetry);
      root.appendChild(b);
    }
    return root;
  }

  /* ---------- 离线提示 ---------- */
  var offlineEl = null;
  function showOffline(lastSyncedAt) {
    if (!offlineEl) {
      offlineEl = h('div', { class: 'offline-overlay', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'offline-card' },
          h('div', { class: 'offline-icon' }, '↻'),
          h('div', { class: 'offline-copy' },
            h('div', { class: 'offline-title' }, t('数据未同步 · 离线只读')),
            h('div', { class: 'offline-msg' }, t('当前显示本机缓存，写操作已禁用'))
          ),
          (function () {
            var b = h('button', { class: 'offline-retry' }, t('重新同步'));
            b.addEventListener('click', function () {
              if (!window.API || !window.API.reconnect) { return; }
              b.disabled = true;
              b.textContent = t('校验中…');
              window.API.reconnect().then(function (ok) {
                b.disabled = false;
                b.textContent = t('重新同步');
                if (ok && window.__reloadRoute) { window.__reloadRoute(); }
              });
            });
            return b;
          })()
        )
      );
      document.body.appendChild(offlineEl);
    }
    var msg = offlineEl.querySelector('.offline-msg');
    if (msg) {
      msg.textContent = lastSyncedAt
        ? t('当前显示本机缓存（上次同步 {time}），写操作已禁用', { time: new Date(lastSyncedAt).toLocaleString(curLang()) })
        : t('当前显示本机缓存，写操作已禁用');
    }
    document.body.classList.add('offline-readonly');
    offlineEl.classList.add('show');
  }
  function hideOffline() {
    if (offlineEl) { offlineEl.classList.remove('show'); }
    document.body.classList.remove('offline-readonly');
  }

  window.UI = {
    h: h,
    toast: toast,
    dialog: dialog,
    textPrompt: textPrompt,
    formPrompt: formPrompt,
    pinPrompt: pinPrompt,
    openSheet: openSheet,
    closeOverlays: closeOverlays,
    stepper: stepper,
    formatQuantity: formatQuantity,
    validateQuantities: validateQuantities,
    chips: chips,
    toggleSwitch: toggleSwitch,
    field: field,
    fixedBar: fixedBar,
    emptyView: emptyView,
    loadingView: loadingView,
    errorView: errorView,
    showOffline: showOffline,
    hideOffline: hideOffline,
    clampNum: clampNum
  };
})();
