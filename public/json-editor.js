/*
 * JsonEditor — small dependency-free editor for localStorage values.
 *
 *   const ed = JsonEditor.create({ value: '{"a":1}', onSave: async (str) => {...}, onDirtyChange: (dirty) => {...} });
 *   container.appendChild(ed.el);
 *
 * - Tree mode: collapsible nodes, edit keys/values inline, change types, add/remove entries.
 * - Text mode: formatted JSON textarea with live validation, Format / Minify.
 * - JSON stored inside JSON strings (very common in localStorage) is detected and edited as a
 *   nested tree; it is written back as a string again on save.
 * - Values that are not JSON just get a plain text box.
 * - Numbers JavaScript can't hold exactly (e.g. 20-digit IDs) would be silently corrupted by
 *   JSON.parse. Before parsing, such number literals are swapped for a marker string, and swapped
 *   back to the original digits when written out, so they survive byte-for-byte.
 */
(function (global) {
  'use strict';

  const PAGE = 100;

  class Nested {
    constructor(v, pretty) { this.v = v; this.pretty = !!pretty; }
  }
  /** A number literal JS can't represent exactly; we keep its original text. */
  class BigNum { constructor(raw) { this.raw = raw; } }

  const MARK = '\u0000BIG:';                    // what the marker string looks like once parsed
  const MARK_ESC = '\\u0000BIG:';               // ...and as written inside JSON text
  const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
  const TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\d[\d.eE+\-]*/g;

  function lossy(tok) {
    if (!NUM_RE.test(tok)) return false;       // malformed: leave it so JSON.parse reports it
    const n = Number(tok);
    if (!Number.isFinite(n)) return true;
    if (/^-?\d+$/.test(tok)) return !Number.isSafeInteger(n);
    const mantissa = tok.split(/[eE]/)[0].replace('-', '').replace('.', '').replace(/^0+/, '');
    return mantissa.length > 17;
  }

  /** Replace lossy number literals (outside strings) with marker strings. */
  function protect(text) {
    return text.replace(TOKEN_RE, (m) => (m[0] === '"' || !lossy(m)) ? m : `"${MARK_ESC}${m}"`);
  }
  /** Turn marker strings in JSON.stringify output back into the original digits. */
  function restore(text) {
    return text.replace(/"\\u0000BIG:([^"]+)"/g, '$1');
  }
  function sparse(text) { return JSON.parse(protect(text)); }
  function sstringify(v, indent) { return restore(JSON.stringify(v, null, indent)); }
  /** Can't round-trip safely if the text already contains our marker. */
  function collides(text) { return /u0000BIG:/i.test(text); }

  // ---------- helpers ----------

  function isContainer(v) { return v !== null && typeof v === 'object' && !(v instanceof Nested) && !(v instanceof BigNum); }

  function setAt(parent, key, value) {
    if (Array.isArray(parent)) parent[key] = value;
    else Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
  }

  function looksLikeJsonContainer(str) {
    const t = str.trim();
    return t.length > 1 && ((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']'));
  }

  /** Parse into an editable model. Throws SyntaxError if invalid. */
  function parseModel(str, depth) {
    depth = depth || 0;
    return walk(sparse(str), depth);
  }

  function walk(v, depth) {
    if (typeof v === 'string') {
      if (v.startsWith(MARK)) return new BigNum(v.slice(MARK.length));
      if (depth < 4 && looksLikeJsonContainer(v)) {
        try {
          if (collides(v)) throw new Error('reserved');
          return new Nested(walk(sparse(v), depth + 1), v.includes('\n'));
        } catch (_) { /* not JSON, or unsafe numbers inside -> keep as a plain string */ }
      }
      return v;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) setAt(v, k, walk(v[k], depth)); return v; }
    return v;
  }

  /** Model -> plain JSON-able value (Nested becomes a JSON string again). */
  function plain(v) {
    if (v instanceof Nested) {
      const inner = plain(v.v);
      return v.pretty ? sstringify(inner, 2) : sstringify(inner);
    }
    if (v instanceof BigNum) return MARK + v.raw;
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) setAt(out, k, plain(v[k]));
      return out;
    }
    return v;
  }

  function serialize(model, minify) {
    return minify ? sstringify(plain(model)) : sstringify(plain(model), 2);
  }

  /** Try to read text as a JSON object/array. */
  function analyse(str) {
    const t = str.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return { kind: 'text' };
    if (collides(t)) {
      try { const p = JSON.parse(t); if (p && typeof p === 'object') return { kind: 'json-unsafe', isArray: Array.isArray(p), count: Object.keys(p).length }; } catch (_) {}
      return { kind: 'text' };
    }
    try {
      const parsed = sparse(t);
      if (parsed === null || typeof parsed !== 'object') return { kind: 'text' };
      return { kind: 'json', isArray: Array.isArray(parsed), count: Object.keys(parsed).length, big: protect(t) !== t };
    } catch (_) {
      return { kind: 'text' };
    }
  }

  function canonical(str) {
    try { return collides(str) ? JSON.stringify(JSON.parse(str)) : sstringify(sparse(str)); } catch (_) { return str; }
  }

  function kindOf(v) {
    if (v instanceof Nested) return 'json';
    if (v instanceof BigNum) return 'number';
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v === 'object' ? 'object' : typeof v;
  }

  function summary(c) {
    const n = Array.isArray(c) ? c.length : Object.keys(c).length;
    return Array.isArray(c) ? `[ ${n} item${n === 1 ? '' : 's'} ]` : `{ ${n} key${n === 1 ? '' : 's'} }`;
  }

  function convert(val, to) {
    if (val instanceof BigNum) {
      if (to === 'number') return val;
      if (to === 'string') return val.raw;
      if (to === 'boolean') return true;
      val = val.raw;           // anything else: convert from its text
    }
    const inner = val instanceof Nested ? val.v : val;
    if (to === 'string') {
      if (val instanceof Nested) return plainString(val);
      if (inner === null) return '';
      if (isContainer(inner)) return sstringify(plain(inner));
      return String(inner);
    }
    if (to === 'number') {
      const n = typeof inner === 'string' ? Number(inner) : typeof inner === 'boolean' ? Number(inner) : 0;
      return Number.isFinite(n) ? n : 0;
    }
    if (to === 'boolean') return typeof inner === 'string' ? inner.trim().toLowerCase() === 'true' : !!inner && !isContainer(inner);
    if (to === 'null') return null;
    if (to === 'object') {
      if (Array.isArray(inner)) { const o = {}; inner.forEach((x, i) => setAt(o, String(i), x)); return o; }
      return isContainer(inner) ? inner : {};
    }
    if (to === 'array') {
      if (Array.isArray(inner)) return inner;
      return isContainer(inner) ? Object.values(inner) : [];
    }
    if (to === 'json') {
      if (isContainer(inner)) return new Nested(inner, false);
      if (typeof inner === 'string') {
        try { return new Nested(parseModel(inner), inner.includes('\n')); } catch (_) { /* fall through */ }
      }
      return new Nested({}, false);
    }
    return val;
  }

  function plainString(n) { return plain(n); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px';
  }

  // ---------- editor ----------

  function create(opts) {
    const original0 = String(opts.value == null ? '' : opts.value);
    let original = original0;
    let mode = null;            // 'tree' | 'text'
    let model = null;           // tree model (when mode === 'tree')
    let touched = false;        // tree edited since load/save
    let minify = !original0.includes('\n');
    const openState = new WeakMap();
    const shown = new WeakMap();

    const root = el('div', 'jse');
    const toolbar = el('div', 'jse-toolbar');
    const body = el('div', 'jse-body');
    const footer = el('div', 'jse-footer');
    root.append(toolbar, body, footer);

    const info = analyse(original);
    const canTree = info.kind === 'json';

    // toolbar
    const modeBox = el('div', 'jse-seg');
    const btnTree = el('button', 'jse-seg-btn', 'Tree');
    const btnText = el('button', 'jse-seg-btn', 'Text');
    btnTree.type = btnText.type = 'button';
    modeBox.append(btnTree, btnText);
    const treeTools = el('div', 'jse-tools');
    const btnExpand = el('button', 'jse-mini', 'Expand all');
    const btnCollapse = el('button', 'jse-mini', 'Collapse all');
    btnExpand.type = btnCollapse.type = 'button';
    treeTools.append(btnExpand, btnCollapse);
    const textTools = el('div', 'jse-tools');
    const btnFormat = el('button', 'jse-mini', 'Format');
    const btnMinify = el('button', 'jse-mini', 'Minify');
    btnFormat.type = btnMinify.type = 'button';
    textTools.append(btnFormat, btnMinify);
    const status = el('span', 'jse-status');
    toolbar.append(modeBox, treeTools, textTools, status);

    // footer
    const minLabel = el('label', 'jse-check');
    const minBox = document.createElement('input');
    minBox.type = 'checkbox';
    minBox.checked = minify;
    minLabel.append(minBox, document.createTextNode(' Minify on save'));
    const sizeEl = el('span', 'jse-size');
    const spacer = el('span', 'jse-spacer');
    const btnRevert = el('button', 'jse-btn', 'Revert');
    const btnSave = el('button', 'jse-btn jse-save', 'Save');
    btnRevert.type = btnSave.type = 'button';
    footer.append(minLabel, sizeEl, spacer, btnRevert, btnSave);

    const textarea = el('textarea', 'jse-text');
    textarea.spellcheck = false;
    const treeHost = el('div', 'jse-tree');

    // ----- state helpers -----

    function currentText() { return textarea.value; }

    function getValue() {
      if (mode === 'tree') {
        if (!touched) return original;
        return serialize(model, minBox.checked);
      }
      const t = currentText();
      if (canonical(t) === canonical(original) && t === original) return original;
      if (minBox.checked) {
        const a = analyse(t);
        if (a.kind === 'json') { try { return sstringify(sparse(t)); } catch (_) { /* keep raw */ } }
      }
      return t;
    }

    function isDirty() {
      if (mode === 'tree') return touched;
      return canonical(currentText()) !== canonical(original);
    }

    function textIsValid() {
      const a = analyse(currentText());
      if (a.kind !== 'text') return true;
      // non-JSON values are always "valid" plain text, unless it looks like broken JSON
      const t = currentText().trim();
      if (t && (t[0] === '{' || t[0] === '[')) { try { JSON.parse(protect(t)); } catch (_) { return false; } }
      return true;
    }

    function refreshFooter() {
      const v = getValue();
      const bytes = new Blob([v]).size;
      sizeEl.textContent = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
      const dirty = isDirty();
      const valid = mode === 'tree' ? true : textIsValid();
      btnSave.disabled = !dirty || !valid;
      btnRevert.disabled = !dirty;
      root.classList.toggle('dirty', dirty);
      if (opts.onDirtyChange) opts.onDirtyChange(dirty);
    }

    function markTouched() {
      touched = true;
      refreshFooter();
    }

    function setStatus(msg, kind) {
      status.textContent = msg || '';
      status.className = 'jse-status' + (kind ? ' ' + kind : '');
    }

    // ----- text mode -----

    function showText(initial) {
      mode = 'text';
      body.innerHTML = '';
      body.appendChild(textarea);
      treeTools.hidden = true;
      textTools.hidden = false;
      btnText.classList.add('active');
      btnTree.classList.remove('active');
      textarea.value = initial;
      validateText();
      refreshFooter();
    }

    function validateText() {
      const t = currentText();
      const a = analyse(t);
      const trimmed = t.trim();
      const looksJson = trimmed && (trimmed[0] === '{' || trimmed[0] === '[');
      let valid = true;
      if (a.kind === 'json' || a.kind === 'json-unsafe') {
        setStatus(a.kind === 'json-unsafe'
          ? '✓ Valid JSON — contains a reserved marker sequence, so Tree view and reformatting are disabled to avoid altering it'
          : a.big ? '✓ Valid JSON — very large / high-precision numbers are kept exactly' : '✓ Valid JSON', 'ok');
      } else if (looksJson) {
        valid = false;
        try { JSON.parse(protect(trimmed)); } catch (e) { setStatus('✗ ' + e.message, 'err'); }
      } else {
        setStatus(trimmed ? 'Plain text' : 'Empty', '');
      }
      textarea.classList.toggle('invalid', !valid);
      const jsonOk = a.kind === 'json';
      btnFormat.disabled = !jsonOk;
      btnMinify.disabled = !jsonOk;
      btnTree.disabled = !jsonOk;
      btnTree.title = jsonOk ? '' : (a.kind === 'json-unsafe' ? 'Contains a reserved marker sequence' : 'Only available for valid JSON objects/arrays');
      return valid;
    }

    textarea.addEventListener('input', () => { validateText(); refreshFooter(); });

    btnFormat.addEventListener('click', () => {
      try { textarea.value = sstringify(sparse(currentText()), 2); } catch (_) {}
      validateText(); refreshFooter();
    });
    btnMinify.addEventListener('click', () => {
      try { textarea.value = sstringify(sparse(currentText())); } catch (_) {}
      validateText(); refreshFooter();
    });

    // ----- tree mode -----

    function showTree() {
      let m;
      try { m = parseModel(currentTextForTree()); } catch (_) { return false; }
      const dirtyText = mode === 'text' && canonical(currentText()) !== canonical(original);
      model = m;
      mode = 'tree';
      touched = dirtyText;
      body.innerHTML = '';
      body.appendChild(treeHost);
      treeTools.hidden = false;
      textTools.hidden = true;
      btnTree.classList.add('active');
      btnText.classList.remove('active');
      setStatus('', '');
      renderTree();
      refreshFooter();
      return true;
    }

    function currentTextForTree() {
      // Entering tree from text: use the textarea. First open: use the original.
      return mode === 'text' ? textarea.value : original;
    }

    function renderTree() {
      treeHost.innerHTML = '';
      const holder = { root: model };
      treeHost.appendChild(renderRow(holder, 'root', { kind: 'root', depth: 0, refresh: null }));
    }

    function newKeyFor(obj) {
      let i = 1, k = 'newKey';
      while (Object.prototype.hasOwnProperty.call(obj, k)) { i++; k = 'newKey' + i; }
      return k;
    }

    function renderChildren(box, container, ctx) {
      box.innerHTML = '';
      const keys = Array.isArray(container) ? container.map((_, i) => i) : Object.keys(container);
      const limit = shown.get(container) || PAGE;
      keys.slice(0, limit).forEach((k) => {
        box.appendChild(renderRow(container, k, { kind: Array.isArray(container) ? 'index' : 'key', depth: ctx.depth, refresh: ctx.refresh }));
      });
      if (keys.length > limit) {
        const more = el('button', 'jse-more', `Show ${Math.min(PAGE, keys.length - limit)} more (${keys.length - limit} hidden)`);
        more.type = 'button';
        more.addEventListener('click', () => { shown.set(container, limit + PAGE); ctx.refresh(); });
        box.appendChild(more);
      }
      const add = el('button', 'jse-add', Array.isArray(container) ? '+ Add item' : '+ Add field');
      add.type = 'button';
      add.addEventListener('click', () => {
        let focusKey;
        if (Array.isArray(container)) { container.push(''); focusKey = container.length - 1; shown.set(container, Math.max(limit, container.length)); }
        else { focusKey = newKeyFor(container); setAt(container, focusKey, ''); shown.set(container, Math.max(limit, keys.length + 1)); }
        markTouched();
        ctx.refresh();
        const target = box.querySelector(`[data-k="${(typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(String(focusKey)) : String(focusKey).replace(/"/g, "\\\"")}"]`);
        const input = target && target.querySelector(Array.isArray(container) ? '.jse-val' : '.jse-key');
        if (input) { input.focus(); if (input.select) input.select(); }
      });
      box.appendChild(add);
    }

    function renderRow(parent, key, ctx) {
      const val = parent[key];
      const nested = val instanceof Nested;
      const inner = nested ? val.v : val;
      const isC = isContainer(inner);

      const node = el('div', 'jse-node');
      node.dataset.k = String(key);
      const line = el('div', 'jse-line');
      node.appendChild(line);

      // caret
      const caret = el('button', 'jse-caret', isC ? '▸' : '');
      caret.type = 'button';
      if (!isC) caret.disabled = true;
      line.appendChild(caret);

      // key
      if (ctx.kind === 'key') {
        const ki = el('input', 'jse-key');
        ki.value = String(key);
        ki.spellcheck = false;
        ki.addEventListener('change', () => {
          const nk = ki.value;
          if (nk === key) return;
          if (nk === '' || Object.prototype.hasOwnProperty.call(parent, nk)) {
            ki.value = String(key);
            ki.classList.add('shake');
            setTimeout(() => ki.classList.remove('shake'), 400);
            return;
          }
          const entries = Object.keys(parent).map((k) => [k === key ? nk : k, parent[k]]);
          for (const k of Object.keys(parent)) delete parent[k];
          for (const [k, v] of entries) setAt(parent, k, v);
          markTouched();
          ctx.refresh();
        });
        line.appendChild(ki);
        line.appendChild(el('span', 'jse-colon', ':'));
      } else if (ctx.kind === 'index') {
        line.appendChild(el('span', 'jse-idx', String(key)));
        line.appendChild(el('span', 'jse-colon', ':'));
      } else {
        line.appendChild(el('span', 'jse-idx', 'root'));
      }

      // value
      let sumEl = null, childBox = null, childCtx = null;
      if (isC) {
        sumEl = el('span', 'jse-sum', summary(inner));
        line.appendChild(sumEl);
        childBox = el('div', 'jse-children');
        childCtx = {
          depth: ctx.depth + 1,
          refresh() {
            renderChildren(childBox, inner, childCtx);
            sumEl.textContent = summary(inner);
          }
        };
        const open = openState.has(inner) ? openState.get(inner) : ctx.depth === 0;
        const setOpen = (o) => {
          openState.set(inner, o);
          caret.textContent = o ? '▾' : '▸';
          childBox.hidden = !o;
          if (o && !childBox.dataset.ready) { childBox.dataset.ready = '1'; childCtx.refresh(); }
        };
        caret.addEventListener('click', () => setOpen(!!childBox.hidden));
        sumEl.addEventListener('click', () => setOpen(!!childBox.hidden));
        node.appendChild(childBox);
        setOpen(open);
      } else {
        line.appendChild(primitiveInput(parent, key, val));
      }

      // nested badge
      if (nested) line.appendChild(el('span', 'jse-badge', 'JSON in string'));

      // type select (not for the root value)
      const sel = el('select', 'jse-type');
      [['string', 'text'], ['number', 'number'], ['boolean', 'true/false'], ['null', 'null'], ['object', 'object {}'], ['array', 'list []'], ['json', 'JSON string']].forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = label; sel.appendChild(o);
      });
      sel.value = kindOf(val);
      sel.title = 'Change type';
      sel.addEventListener('change', () => {
        setAt(parent, key, convert(val, sel.value));
        markTouched();
        const fresh = renderRow(parent, key, ctx);
        node.replaceWith(fresh);
      });
      if (ctx.kind !== 'root') line.appendChild(sel);

      // remove
      if (ctx.kind !== 'root') {
        const rm = el('button', 'jse-rm', '×');
        rm.type = 'button';
        rm.title = 'Remove';
        rm.addEventListener('click', () => {
          if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key];
          markTouched();
          ctx.refresh();
        });
        line.appendChild(rm);
      }
      return node;
    }

    function primitiveInput(parent, key, val) {
      if (typeof val === 'boolean') {
        const b = el('button', 'jse-bool ' + val, String(val));
        b.type = 'button';
        b.addEventListener('click', () => {
          const nv = !(parent[key]);
          setAt(parent, key, nv);
          b.textContent = String(nv);
          b.className = 'jse-bool ' + nv;
          markTouched();
        });
        return b;
      }
      if (val === null) return el('span', 'jse-null', 'null');
      if (typeof val === 'number' || val instanceof BigNum) {
        const i = el('input', 'jse-val jse-num');
        const show = (v) => (v instanceof BigNum ? v.raw : String(v));
        i.value = show(val);
        if (val instanceof BigNum) i.title = 'Too large/precise for JavaScript numbers — kept exactly as written';
        i.spellcheck = false;
        i.addEventListener('input', () => {
          const t = i.value.trim();
          if (NUM_RE.test(t)) {
            i.classList.remove('invalid');
            setAt(parent, key, lossy(t) ? new BigNum(t) : Number(t));
            markTouched();
          } else i.classList.add('invalid');
        });
        i.addEventListener('blur', () => { i.value = show(parent[key]); i.classList.remove('invalid'); });
        return i;
      }
      const ta = el('textarea', 'jse-val jse-str');
      ta.rows = 1;
      ta.value = val;
      ta.spellcheck = false;
      ta.addEventListener('input', () => { setAt(parent, key, ta.value); autosize(ta); markTouched(); });
      // size after being attached to the DOM
      requestAnimationFrame(() => autosize(ta));
      return ta;
    }

    function setAll(container, open) {
      const stack = [container];
      let n = 0;
      while (stack.length && n++ < 20000) {
        let c = stack.pop();
        if (c instanceof Nested) c = c.v;
        if (!isContainer(c)) continue;
        openState.set(c, open);
        for (const k of Object.keys(c)) stack.push(c[k]);
      }
    }

    btnExpand.addEventListener('click', () => { setAll(model, true); renderTree(); });
    btnCollapse.addEventListener('click', () => { setAll(model, false); openState.set(model, true); renderTree(); });

    // ----- mode switching, save, revert -----

    btnTree.addEventListener('click', () => { if (mode !== 'tree') showTree(); });
    btnText.addEventListener('click', () => {
      if (mode === 'text') return;
      let t;
      if (!touched) {
        try { t = sstringify(sparse(original), 2); } catch (_) { t = original; }
      } else {
        t = serialize(model, false);
      }
      showText(t);
    });

    minBox.addEventListener('change', () => { minify = minBox.checked; refreshFooter(); });

    async function save() {
      if (btnSave.disabled) return;
      const value = getValue();
      btnSave.disabled = true;
      try {
        await opts.onSave(value);
        original = value;
        touched = false;
        refreshFooter();
      } catch (_) {
        refreshFooter();
      }
    }

    function revert() {
      touched = false;
      if (canTreeNow()) {
        model = parseModel(original);
        if (mode === 'tree') { renderTree(); }
        else showText(prettyOrRaw(original));
      } else {
        showText(original);
      }
      refreshFooter();
    }

    function canTreeNow() { return analyse(original).kind === 'json'; }
    function prettyOrRaw(s) { try { return sstringify(sparse(s), 2); } catch (_) { return s; } }

    btnSave.addEventListener('click', save);
    btnRevert.addEventListener('click', revert);
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });

    // ----- initial render -----
    if (canTree) {
      showTree();
    } else if (info.kind === 'json-unsafe') {
      showText(original);
    } else {
      showText(original);
      textTools.hidden = true;
    }
    if (info.kind === 'text') modeBox.hidden = true;

    return {
      el: root,
      getValue,
      isDirty,
      /** false when the text editor holds broken JSON (Save is disabled for it too). */
      isValid() { return mode === 'tree' ? true : textIsValid(); },
      revert,
      /** Replace the stored baseline after something outside saved a new value. */
      setBaseline(v) { original = v; touched = false; refreshFooter(); },
      focus() { (mode === 'text' ? textarea : treeHost).focus(); }
    };
  }

  global.JsonEditor = { create, analyse };
})(window);
