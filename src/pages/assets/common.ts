/**
 * Browser code shared by both pages. It builds every node with `createElement` and sets text
 * with `textContent` only (§J.3). It is a classic script that defines one global, `MA`.
 * The text below is JavaScript, not TypeScript, and has no backtick.
 */
export const COMMON_JS = `'use strict';
(function () {
  // Properties that el() sets directly on the node. Every other key is refused, so data can never
  // become an attribute such as an event handler.
  const PROPS = new Set([
    'id', 'type', 'name', 'value', 'placeholder', 'min', 'max', 'step', 'rows', 'title',
    'disabled', 'checked', 'readOnly', 'autocomplete', 'htmlFor', 'spellcheck', 'colSpan', 'selected',
  ]);

  /** Builds one element. props.text sets textContent, props.on adds listeners, props.attrs sets aria-, data-, role and inputmode attributes. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    const p = props || {};
    for (const key of Object.keys(p)) {
      const v = p[key];
      if (v === undefined || v === null) continue;
      if (key === 'text') node.textContent = String(v);
      else if (key === 'className') node.className = String(v);
      else if (key === 'href') {
        // Only links inside these pages.
        const href = String(v);
        if (href.charAt(0) !== '/' && href.charAt(0) !== '#') throw new Error('el(): an outside link is not allowed');
        node.setAttribute('href', href);
      } else if (key === 'on') {
        for (const ev of Object.keys(v)) node.addEventListener(ev, v[ev]);
      } else if (key === 'attrs') {
        for (const name of Object.keys(v)) {
          if (!/^(aria|data)-[a-z-]+$/.test(name) && name !== 'role' && name !== 'inputmode') throw new Error('el(): attribute not allowed: ' + name);
          node.setAttribute(name, String(v[name]));
        }
      } else if (PROPS.has(key)) {
        node[key] = v;
      } else {
        throw new Error('el(): property not allowed: ' + key);
      }
    }
    append(node, children);
    return node;
  }

  /** Appends children: nodes, texts and numbers, in lists that may be nested. Empty values are skipped. */
  function append(node, children) {
    if (children === undefined || children === null || children === false) return node;
    if (Array.isArray(children)) {
      for (const c of children) append(node, c);
      return node;
    }
    node.appendChild(typeof children === 'string' || typeof children === 'number' ? document.createTextNode(String(children)) : children);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** Replaces the content of a node. */
  function replace(node, children) {
    clear(node);
    append(node, children);
  }

  let onUnauthorized = null;

  /** Calls a route of the harness. Resolves with { ok, status, data }, where data is JSON or text. */
  async function api(method, path, body) {
    const init = { method: method, headers: {}, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      return { ok: false, status: 0, data: 'The harness does not answer. It may have stopped.' };
    }
    const type = res.headers.get('Content-Type') || '';
    let data;
    try {
      data = type.indexOf('application/json') === 0 ? await res.json() : await res.text();
    } catch (err) {
      data = null;
    }
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    return { ok: res.ok, status: res.status, data: data };
  }

  /** The text of an error answer. */
  function errorText(r) {
    if (r.data && typeof r.data === 'object' && typeof r.data.error === 'string') return r.data.error;
    if (typeof r.data === 'string' && r.data !== '') return r.data;
    return 'The request failed with status ' + r.status + '.';
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** A time in the local time zone, as 2026-11-25 14:05. */
  function time(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** A length of time in words, such as 3 h 20 min. */
  function duration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'less than a minute';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    const rest = min % 60;
    if (h < 48) return h + ' h' + (rest > 0 ? ' ' + rest + ' min' : '');
    return Math.floor(h / 24) + ' days';
  }

  function usd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
  }

  function bytes(n) {
    if (typeof n !== 'number') return '';
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }

  function number(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '';
  }

  /** Copies a text to the clipboard. Returns false when the browser refuses. */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  }

  window.MA = {
    el: el,
    append: append,
    clear: clear,
    replace: replace,
    api: api,
    errorText: errorText,
    time: time,
    duration: duration,
    usd: usd,
    bytes: bytes,
    number: number,
    copy: copy,
    setUnauthorized: function (fn) { onUnauthorized = fn; },
  };
})();
`;
