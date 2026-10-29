/* Human: paste text, get three human-sounding rewrites per sentence, tap any
   word for five synonyms that fit. Runs as a website and inside the Android
   app (Capacitor). No build step: plain browser JavaScript. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- basics
  const $ = (id) => document.getElementById(id);
  const REPO = 'NoorJ29/Human';
  const MAX_CHARS = 1500;
  const MAX_SENTENCES = 12;
  const CHUNK = 4; // sentences per AI request
  const TONES = ['natural', 'formal', 'casual'];
  const TONE_LABEL = { natural: 'Natural', formal: 'Formal', casual: 'Casual' };

  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const VERSION = window.APP_VERSION || { code: 0, name: '0.0.0' };

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }
  const norm = (w) => String(w || '').toLowerCase().replace(/[’‘]/g, "'").trim();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ---------------------------------------------------------------- providers
  const PROVIDERS = {
    groq: {
      name: 'Groq',
      keyUrl: 'https://console.groq.com/keys',
      note: 'Fast, with a generous free daily limit. Best choice in the Android app. Some browsers block Groq on the website; if that happens there, switch to Gemini.',
      defaultModel: 'llama-3.3-70b-versatile',
      prefer: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
      labels: {
        'llama-3.3-70b-versatile': 'Llama 3.3 70B (recommended)',
        'openai/gpt-oss-120b': 'GPT-OSS 120B (stronger, a bit slower)',
        'openai/gpt-oss-20b': 'GPT-OSS 20B',
        'llama-3.1-8b-instant': 'Llama 3.1 8B (fastest, simpler writing)',
      },
    },
    gemini: {
      name: 'Gemini',
      keyUrl: 'https://aistudio.google.com/apikey',
      note: 'Free key from Google AI Studio. Works in the app and on the website. The free daily limit is smaller, and Flash-Lite models allow the most requests.',
      defaultModel: 'gemini-flash-lite-latest',
      prefer: ['gemini-flash-lite-latest', 'gemini-flash-latest'],
      labels: {
        'gemini-flash-lite-latest': 'Gemini Flash-Lite, latest (recommended)',
        'gemini-flash-latest': 'Gemini Flash, latest (fewer free requests)',
      },
    },
    openrouter: {
      name: 'OpenRouter',
      keyUrl: 'https://openrouter.ai/keys',
      note: 'Free models from many AI labs with one key. Works in the app and on the website. The free daily limit is small.',
      defaultModel: 'openrouter/free',
      prefer: ['openrouter/free'],
      labels: { 'openrouter/free': 'Best free model, picked by OpenRouter (recommended)' },
    },
  };

  const settings = Object.assign(
    { provider: isNative ? 'groq' : 'gemini', keys: {}, models: {}, modelLists: {} },
    load('human.settings', {})
  );
  if (!PROVIDERS[settings.provider]) settings.provider = 'groq';
  const saveSettings = () => save('human.settings', settings);
  const hasKey = () => !!(settings.keys[settings.provider] || '').trim();
  const providerName = (p = settings.provider) => PROVIDERS[p].name;
  const currentModel = (p = settings.provider) => settings.models[p] || PROVIDERS[p].defaultModel;

  // ---------------------------------------------------------------- text
  const WORD_RE = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
  const STOP = new Set(('a an the and or but nor so yet if then else of to in on at by for with from as into onto upon ' +
    'is am are was were be been being do does did done have has had having can could will would shall should may might must ' +
    'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs ' +
    'this that these those there here who whom whose which what when where why how ' +
    "not no than too also just it's i'm i've i'd i'll you're you've you'd you'll he's she's we're we've we'd we'll they're they've they'd they'll " +
    "that's there's what's let's isn't aren't wasn't weren't don't doesn't didn't can't couldn't won't wouldn't shouldn't " +
    'up out off over under about via per each both either neither any some such own same other another').split(/\s+/));

  function tokenize(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(WORD_RE)) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), w: false });
      out.push({ t: m[0], w: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), w: false });
    return out;
  }
  const tokensText = (toks) => toks.map((t) => t.t).join('');
  const isTappable = (tok) => tok.w && (tok.orig != null || (norm(tok.t).length > 1 && !STOP.has(norm(tok.t))));

  function splitSentences(text) {
    const out = [];
    const paras = text.replace(/\r/g, '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;
    paras.forEach((p, pi) => {
      let parts;
      if (seg) parts = Array.from(seg.segment(p), (s) => s.segment);
      else parts = p.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [p];
      parts.map((s) => s.trim()).filter(Boolean).forEach((s) => out.push({ text: s, para: pi }));
    });
    return out;
  }

  function matchCase(word, like) {
    if (!word) return word;
    if (like.length > 1 && like === like.toUpperCase() && /\p{L}/u.test(like)) return word.toUpperCase();
    if (/^\p{Lu}/u.test(like)) return word.charAt(0).toUpperCase() + word.slice(1);
    if (/^\p{Ll}/u.test(like) && /^\p{Lu}\p{Ll}/u.test(word)) return word.charAt(0).toLowerCase() + word.slice(1);
    return word;
  }

  function startsWithVowelSound(w) {
    const s = norm(w);
    if (/^(hour|honest|honou?r|heir)/.test(s)) return true;
    if (/^(uni|use|usu|uti|ure|eu|ewe|one|once)/.test(s)) return false;
    return /^[aeiou]/.test(s);
  }

  // Keep "a"/"an" right after a swap ("an issue" -> "a problem").
  function fixArticle(toks, i) {
    let j = i - 1;
    while (j >= 0 && !toks[j].w) {
      if (/\S/.test(toks[j].t)) return; // punctuation in between: leave it
      j--;
    }
    if (j < 0) return;
    const prev = norm(toks[j].t);
    if (prev !== 'a' && prev !== 'an') return;
    const want = startsWithVowelSound(toks[i].t) ? 'an' : 'a';
    if (prev !== want) toks[j].t = matchCase(want, toks[j].t);
  }

  // ---------------------------------------------------------------- example
  const EXAMPLE = {
    original: 'I think we should meet next week to talk about the project, because there are a lot of things we need to fix.',
    versions: {
      natural: "Let's meet next week to go over the project. There's quite a bit we need to fix.",
      formal: 'I suggest we meet next week to review the project, as several issues require attention.',
      casual: "Can we catch up next week about the project? We've got a bunch of stuff to fix.",
    },
    syn: {
      think: ['believe', 'feel', 'reckon', 'suppose', 'figure'],
      meet: ['get together', 'sit down', 'catch up', 'link up', 'talk'],
      talk: ['chat', 'speak', 'have a word', 'check in', 'confer'],
      project: ['work', 'plan', 'job', 'assignment', 'initiative'],
      lot: ['ton', 'heap', 'load', 'great deal', 'bunch'],
      things: ['issues', 'items', 'bits', 'points', 'details'],
      need: ['have', 'ought', 'want', 'are supposed', 'still have'],
      fix: ['sort out', 'repair', 'correct', 'resolve', 'address'],
      bit: ['lot', 'amount', 'chunk', 'deal', 'load'],
      suggest: ['propose', 'recommend', 'advise', 'would like', 'think'],
      review: ['assess', 'examine', 'evaluate', 'go through', 'look over'],
      several: ['a number of', 'various', 'multiple', 'some', 'numerous'],
      issues: ['problems', 'concerns', 'matters', 'faults', 'points'],
      require: ['need', 'call for', 'demand', 'warrant', 'merit'],
      attention: ['action', 'consideration', 'work', 'resolution', 'review'],
      bunch: ['load', 'ton', 'heap', 'lot', 'pile'],
      stuff: ['things', 'bits', 'items', 'problems', 'work'],
    },
  };

  // ---------------------------------------------------------------- state
  let groups = [];
  let isExample = false;
  let runId = 0;
  let runCtl = null;

  function makeGroup(text, para, status) {
    return { para, original: text, tokens: { original: tokenize(text) }, syn: {}, chosen: 'natural', status };
  }

  function applyResult(g, r) {
    if (!r) { g.status = 'missing'; return; }
    const versions = {};
    for (const t of TONES) {
      let v = r[t] ?? r.versions?.[t] ?? r[t.charAt(0).toUpperCase() + t.slice(1)];
      if (typeof v !== 'string' || !v.trim()) { g.status = 'missing'; return; }
      v = v.trim().replace(/^["“]+|["”]+$/g, '').replace(/\s*—\s*/g, ', ').replace(/\s{2,}/g, ' ');
      versions[t] = v;
    }
    g.versions = versions;
    for (const t of TONES) g.tokens[t] = tokenize(versions[t]);
    g.syn = normalizeSyn(r.synonyms ?? r.syn ?? {});
    g.status = 'done';
  }

  function normalizeSyn(obj) {
    const out = {};
    const add = (k, arr) => {
      const key = norm(k);
      if (!key) return;
      let list = Array.isArray(arr) ? arr : (typeof arr === 'string' ? arr.split(/[,;]/) : []);
      list = list.map((s) => String(s ?? '').trim().replace(/^["“]|["”]$/g, '')).filter((s) => s && s.length < 40 && norm(s) !== key);
      const seen = new Set();
      list = list.filter((s) => (seen.has(norm(s)) ? false : seen.add(norm(s))));
      if (list.length) out[key] = list.slice(0, 5);
    };
    if (Array.isArray(obj)) {
      obj.forEach((e) => e && add(e.word ?? e.key, e.synonyms ?? e.list ?? e.values));
    } else if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => add(k, v));
    }
    return out;
  }

  function aiSynonyms(g, word) {
    const k = norm(word);
    return g.syn[k] || g.syn[k.replace(/'s$/, '')] || null;
  }

  // ---------------------------------------------------------------- DOM refs
  const input = $('input');
  const results = $('results');
  const statusBox = $('status');
  const finalBar = $('finalBar');
  const bubble = $('bubble');
  const sheet = $('sheet');
  const backdrop = $('sheetBackdrop');
  const header = document.querySelector('.top');

  // ---------------------------------------------------------------- render
  function pickable() {
    return groups.length > 1 && groups.some((g) => g.status === 'done');
  }

  function renderLine(gi, v) {
    const g = groups[gi];
    const p = el('p', 'line');
    p.dataset.g = gi;
    p.dataset.v = v;
    g.tokens[v].forEach((tok, i) => {
      if (isTappable(tok)) {
        const s = el('span', 'w', tok.t);
        s.dataset.i = i;
        s.tabIndex = 0;
        s.setAttribute('role', 'button');
        s.setAttribute('aria-haspopup', 'dialog');
        if (aiSynonyms(g, tok.t)) s.classList.add('has');
        if (tok.orig != null) s.classList.add('swapped');
        p.appendChild(s);
      } else {
        p.appendChild(document.createTextNode(tok.t));
      }
    });
    return p;
  }

  function pickButton(gi, choice, label) {
    const b = el('button', 'pick', label);
    b.type = 'button';
    b.dataset.pick = choice;
    b.dataset.g = gi;
    b.setAttribute('aria-pressed', String(groups[gi].chosen === choice));
    return b;
  }

  function copyButton(gi, v) {
    const b = el('button', 'icon-btn sm copy');
    b.type = 'button';
    b.dataset.copy = v;
    b.dataset.g = gi;
    b.setAttribute('aria-label', 'Copy ' + (TONE_LABEL[v] || 'original') + ' version');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
    return b;
  }

  function renderGroup(gi) {
    const g = groups[gi];
    const canPick = pickable();
    const art = el('article', 'group');
    art.dataset.g = gi;

    const orig = el('div', 'orig');
    const oh = el('div', 'orig-head');
    oh.appendChild(el('span', 'eyebrow', g.status === 'dictionary' ? 'Your sentence' : 'You wrote'));
    const tools = el('div', 'ver-tools');
    if (canPick && g.status === 'done') tools.appendChild(pickButton(gi, 'original', g.chosen === 'original' ? 'Keeping mine' : 'Keep mine'));
    tools.appendChild(copyButton(gi, 'original'));
    oh.appendChild(tools);
    orig.appendChild(oh);
    orig.appendChild(renderLine(gi, 'original'));
    art.appendChild(orig);

    if (g.status === 'loading') {
      for (const t of TONES) {
        const ver = el('div', 'ver');
        ver.dataset.tone = t;
        const vh = el('div', 'ver-head');
        vh.appendChild(el('span', 'tone', TONE_LABEL[t]));
        ver.appendChild(vh);
        const sk = el('div', 'skeleton');
        sk.setAttribute('aria-label', 'Writing');
        sk.append(el('span'), el('span'));
        ver.appendChild(sk);
        art.appendChild(ver);
      }
    } else if (g.status === 'done') {
      for (const t of TONES) {
        const ver = el('div', 'ver');
        ver.dataset.tone = t;
        if (canPick && g.chosen === t) ver.classList.add('chosen');
        const vh = el('div', 'ver-head');
        vh.appendChild(el('span', 'tone', TONE_LABEL[t]));
        const vt = el('div', 'ver-tools');
        if (canPick) vt.appendChild(pickButton(gi, t, g.chosen === t ? 'Using' : 'Use'));
        vt.appendChild(copyButton(gi, t));
        vh.appendChild(vt);
        ver.appendChild(vh);
        ver.appendChild(renderLine(gi, t));
        art.appendChild(ver);
      }
    } else if (g.status !== 'dictionary') {
      const msg = {
        missing: 'No rewrite came back for this sentence. Tap Rewrite to try again.',
        failed: 'This sentence was not rewritten. Fix the problem above, then tap Rewrite.',
        stopped: 'Stopped before this sentence was rewritten.',
      }[g.status] || '';
      const ver = el('div', 'ver');
      ver.appendChild(el('p', 'ver-missing', msg));
      art.appendChild(ver);
    }
    return art;
  }

  function renderResults() {
    closeBubble();
    results.replaceChildren();
    if (!groups.length) { updateFinal(); return; }
    const head = el('div', 'results-head');
    if (isExample) {
      head.appendChild(el('span', 'pill', 'Example'));
      head.appendChild(el('span', null, 'Tap any underlined word for five synonyms. Paste your own text above.'));
    } else if (groups.some((g) => g.status === 'dictionary')) {
      head.appendChild(el('span', null, 'Tap a word for synonyms. Add a free AI key in Settings to get three rewrites.'));
    } else {
      head.appendChild(el('span', null, 'Tap any word for five synonyms. Tap a synonym to swap it in.'));
    }
    results.appendChild(head);
    groups.forEach((_, gi) => results.appendChild(renderGroup(gi)));
    updateFinal();
  }

  function rerenderGroup(gi) {
    const old = results.querySelector(`article.group[data-g="${gi}"]`);
    if (old) old.replaceWith(renderGroup(gi));
  }

  function rerenderLine(gi, v) {
    const old = results.querySelector(`p.line[data-g="${gi}"][data-v="${v}"]`);
    const fresh = renderLine(gi, v);
    if (old) old.replaceWith(fresh);
    return fresh;
  }

  function combinedText() {
    let out = '';
    let lastPara = null;
    for (const g of groups) {
      const v = g.status === 'done' ? g.chosen : 'original';
      const text = tokensText(g.tokens[v] || g.tokens.original);
      if (lastPara === null) out = text;
      else out += (g.para === lastPara ? ' ' : '\n\n') + text;
      lastPara = g.para;
    }
    return out;
  }

  function updateFinal() {
    const show = pickable() && !isExample;
    finalBar.hidden = !show;
    document.body.classList.toggle('has-final', show);
    if (show) $('finalPreview').textContent = combinedText();
  }

  // ---------------------------------------------------------------- status + toast
  function setStatus(kind, text, actions) {
    if (!kind) { statusBox.hidden = true; statusBox.replaceChildren(); return; }
    statusBox.hidden = false;
    statusBox.className = 'status' + (kind === 'error' ? ' error' : '');
    statusBox.replaceChildren();
    if (kind === 'busy') statusBox.appendChild(el('span', 'spinner'));
    statusBox.appendChild(el('span', 'grow', text));
    (actions || []).forEach(([label, fn, primary]) => {
      const b = el('button', 'btn small ' + (primary ? 'primary' : 'ghost'), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      statusBox.appendChild(b);
    });
  }

  let toastTimer = 0;
  function toast(text, action, ms = 2600) {
    const t = $('toast');
    $('toastText').textContent = text;
    const a = $('toastAction');
    if (action) {
      a.hidden = false;
      a.textContent = action.label;
      a.onclick = () => { action.fn(); t.hidden = true; };
    } else {
      a.hidden = true;
      a.onclick = null;
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? Math.max(ms, 5000) : ms);
  }

  // Clipboard: writeText is called synchronously inside the click handler.
  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? 'Copied' : 'Could not copy. Long-press the text to copy it.');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('Copied'), fallback);
        return;
      }
    } catch (e) { /* fall through */ }
    fallback();
  }

  // ---------------------------------------------------------------- network
  async function httpJSON(url, { method = 'GET', headers = {}, body, signal, timeout = 45000 } = {}) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctl.abort(), timeout);
    // The Android app sends requests natively, where the abort signal is ignored,
    // so the timeout and Stop also race the request here.
    const aborted = new Promise((_, reject) => {
      if (ctl.signal.aborted) reject(new Error('aborted'));
      else ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    aborted.catch(() => {});
    let res;
    try {
      res = await Promise.race([
        fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal }),
        aborted,
      ]);
    } catch (e) {
      const err = new Error(signal && signal.aborted ? 'aborted' : 'network');
      err.kind = signal && signal.aborted ? 'aborted' : (ctl.signal.aborted ? 'timeout' : 'network');
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
    if (!res.ok) {
      const err = new Error('http ' + res.status);
      err.kind = 'http';
      err.status = res.status;
      const e0 = Array.isArray(json) ? json[0] : json;
      err.detail = (e0 && (e0.error?.message || e0.message || (typeof e0.error === 'string' ? e0.error : ''))) || txt.slice(0, 300);
      throw err;
    }
    if (json === null) {
      const err = new Error('bad json');
      err.kind = 'parse';
      throw err;
    }
    return json;
  }

  // ---------------------------------------------------------------- dictionaries
  const dmCache = new Map();
  const fdCache = new Map();

  function freqOf(item) {
    const tag = (item.tags || []).find((t) => t.startsWith('f:'));
    return tag ? parseFloat(tag.slice(2)) || 0 : 0;
  }

  function lemmaForms(w) {
    const s = norm(w);
    const undouble = (b) => (/([bdgklmnprt])\1$/.test(b) ? b.slice(0, -1) : b);
    if (s.length < 5) return null;
    if (s.endsWith('ies')) return { suffix: 's', bases: [s.slice(0, -3) + 'y'] };
    if (s.endsWith('ing')) { const b = s.slice(0, -3); return { suffix: 'ing', bases: [b, b + 'e', undouble(b)] }; }
    if (s.endsWith('ied')) return { suffix: 'ed', bases: [s.slice(0, -3) + 'y'] };
    if (s.endsWith('ed')) { const b = s.slice(0, -2); return { suffix: 'ed', bases: [b, s.slice(0, -1), undouble(b)] }; }
    if (/(ches|shes|sses|xes|zes)$/.test(s)) return { suffix: 's', bases: [s.slice(0, -2)] };
    if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) return { suffix: 's', bases: [s.slice(0, -1)] };
    return null;
  }

  function inflect(word, suffix) {
    if (/\s/.test(word)) return null;
    const w = word.toLowerCase();
    if (suffix === 's') {
      if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
      if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
      return w + 's';
    }
    if (suffix === 'ed') {
      if (w.endsWith('e')) return w + 'd';
      if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ied';
      return w + 'ed';
    }
    if (suffix === 'ing') {
      if (w.endsWith('ie')) return w.slice(0, -2) + 'ying';
      if (w.endsWith('e') && !w.endsWith('ee')) return w.slice(0, -1) + 'ing';
      return w + 'ing';
    }
    return null;
  }

  async function datamuse(word, lc, rc) {
    const key = [norm(word), norm(lc), norm(rc)].join('|');
    if (dmCache.has(key)) return dmCache.get(key);
    const base = 'https://api.datamuse.com/words?';
    const q = (params) => httpJSON(base + new URLSearchParams(params).toString(), { timeout: 12000 }).catch(() => []);
    const ml = { ml: word, max: '30', md: 'pf' };
    if (lc) ml.lc = lc;
    if (rc) ml.rc = rc;
    const [syn, rel] = await Promise.all([q({ rel_syn: word, max: '30', md: 'pf' }), q(ml)]);
    const scores = new Map();
    const bump = (w, s) => scores.set(w, (scores.get(w) || 0) + s);
    const okWord = (item) => {
      const w = String(item.word || '');
      if (!w || norm(w) === norm(word) || /\d/.test(w) || w.split(/\s+/).length > 3) return false;
      if ((item.tags || []).includes('prop')) return false;
      return true;
    };
    (Array.isArray(syn) ? syn : []).filter(okWord).forEach((it) => {
      const f = freqOf(it);
      if (f < 0.2) return;
      bump(it.word, 2 + Math.log10(f + 1) * 0.6);
    });
    (Array.isArray(rel) ? rel : []).filter(okWord).forEach((it, idx) => {
      const f = freqOf(it);
      if (f < 0.4) return;
      bump(it.word, (1 - idx / 30) * 1.4 + Math.log10(f + 1) * 0.3);
    });
    let list = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);

    if (list.length < 5) {
      const lf = lemmaForms(word);
      if (lf) {
        for (const b of [...new Set(lf.bases)]) {
          const more = await q({ rel_syn: b, max: '20', md: 'pf' });
          (Array.isArray(more) ? more : []).forEach((it) => {
            const inf = inflect(String(it.word || ''), lf.suffix);
            if (inf && norm(inf) !== norm(word) && !list.includes(inf) && freqOf(it) >= 0.3) list.push(inf);
          });
          if (list.length >= 8) break;
        }
      }
    }
    list = list.slice(0, 16);
    dmCache.set(key, list);
    return list;
  }

  const POS_ABBR = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.', interjection: 'interj.', determiner: 'det.', exclamation: 'excl.' };

  async function freeDictionary(word) {
    const w = norm(word);
    if (!w || /\s/.test(w)) return null;
    if (fdCache.has(w)) return fdCache.get(w);
    const get = (x) => httpJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(x), { timeout: 12000 }).catch(() => null);
    let data = await get(w);
    if (!Array.isArray(data)) {
      const lf = lemmaForms(w);
      if (lf) {
        for (const b of [...new Set(lf.bases)]) {
          data = await get(b);
          if (Array.isArray(data)) break;
        }
      }
    }
    let meanings = null;
    if (Array.isArray(data)) {
      meanings = [];
      data.forEach((entry) => (entry.meanings || []).forEach((m) => {
        const defs = m.definitions || [];
        const syns = [...(m.synonyms || []), ...defs.flatMap((d) => d.synonyms || [])];
        meanings.push({ pos: m.partOfSpeech || '', def: defs[0]?.definition || '', syns });
      }));
    }
    fdCache.set(w, meanings);
    return meanings;
  }

  const DETERMINERS = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every', 'no', 'more', 'most', 'several', 'many', 'few']);
  const VERB_CUES = new Set(['to', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must', 'i', 'we', 'you', 'they', "don't", "didn't", "doesn't", "won't", "can't", 'not', 'please', "let's"]);

  function guessPos(prev, word) {
    const p = norm(prev);
    if (/ly$/.test(norm(word))) return 'adverb';
    if (DETERMINERS.has(p)) return 'noun';
    if (VERB_CUES.has(p)) return 'verb';
    return null;
  }

  function pickMeaning(meanings, guess, chips) {
    if (!meanings || !meanings.length) return null;
    const chipSet = new Set(chips.map(norm));
    let best = null;
    let bestScore = -1;
    meanings.forEach((m, idx) => {
      let s = m.syns.filter((x) => chipSet.has(norm(x))).length * 2;
      if (guess && m.pos === guess) s += 3;
      s -= idx * 0.01;
      if (m.def && s > bestScore) { best = m; bestScore = s; }
    });
    return best || meanings[0];
  }

  // ---------------------------------------------------------------- AI
  const SYSTEM = 'You rewrite text so it sounds like a thoughtful real person wrote it. You always answer with valid JSON only, no commentary.';

  function buildPrompt(sentences) {
    const n = sentences.length;
    const list = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return [
      `Rewrite each of the ${n} numbered sentences below in three ways:`,
      '- natural: how a fluent person would actually say it in everyday writing.',
      '- formal: polished and professional, for work email or reports.',
      '- casual: relaxed and friendly, like a message to a friend.',
      '',
      'Rules for every version:',
      '- Keep the meaning and every fact. Do not add new information or opinions.',
      '- Fix grammar and spelling.',
      '- Sound human: plain everyday words, varied rhythm, contractions where natural (fewer in formal).',
      '- Avoid filler and cliches such as delve, tapestry, crucial, leverage, seamless, robust, moreover, furthermore, "in today\'s world".',
      '- No em dashes, no emojis, no hashtags, no quotation marks around the whole sentence.',
      '- Each version is one sentence, or two short ones at most.',
      '',
      'Also give synonyms for each sentence: for every distinct content word (nouns, verbs, adjectives, adverbs; skip names, numbers and small function words) that appears in the original sentence or in any of its three versions, list exactly 5 alternatives that fit the meaning in that sentence and can replace the word directly in the same spot: same tense, same number, same form. Use single words or short phrases. Key each list by the word in lowercase exactly as it appears.',
      '',
      `Return JSON only, in this exact shape, with exactly ${n} items in the "sentences" array, in the same order as the input:`,
      '{"sentences":[{"natural":"...","formal":"...","casual":"...","synonyms":{"word":["a","b","c","d","e"]}}]}',
      '',
      'Sentences:',
      list,
    ].join('\n');
  }

  function parseLooseJSON(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) { /* try slicing */ }
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fallthrough */ }
    }
    const err = new Error('parse');
    err.kind = 'parse';
    throw err;
  }

  async function callModel(prompt, signal) {
    const p = settings.provider;
    const key = (settings.keys[p] || '').trim();
    const model = currentModel(p);
    if (p === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
      const res = await httpJSON(url, {
        method: 'POST',
        signal,
        timeout: 90000,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: {
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 8192, responseMimeType: 'application/json' },
        },
      });
      const cand = res.candidates && res.candidates[0];
      const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((x) => (x.thought ? '' : x.text || '')).join('') : '';
      if (!text) {
        const err = new Error('empty');
        err.kind = res.promptFeedback && res.promptFeedback.blockReason ? 'blocked' : 'empty';
        throw err;
      }
      return text;
    }
    const url = p === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
    if (p === 'openrouter') {
      headers['X-Title'] = 'Human';
      if (/^https:/.test(location.origin)) headers['HTTP-Referer'] = location.origin;
    }
    const body = {
      model,
      temperature: 0.8,
      max_tokens: 3500,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    };
    if (p === 'groq') body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await httpJSON(url, { method: 'POST', headers, body, signal, timeout: 90000 });
    } catch (e) {
      if (e.kind === 'http' && e.status === 400 && body.response_format && /response_format|json/i.test(e.detail || '')) {
        delete body.response_format;
        res = await httpJSON(url, { method: 'POST', headers, body, signal, timeout: 90000 });
      } else {
        throw e;
      }
    }
    if (res.error) {
      const err = new Error('provider');
      err.kind = 'http';
      err.status = res.error.code || 500;
      err.detail = res.error.message || '';
      throw err;
    }
    const msg = res.choices && res.choices[0] && res.choices[0].message;
    const text = msg && typeof msg.content === 'string' ? msg.content : '';
    if (!text.trim()) {
      const err = new Error('empty');
      err.kind = 'empty';
      throw err;
    }
    return text;
  }

  async function aiRewrite(sentences, signal) {
    const raw = await callModel(buildPrompt(sentences), signal);
    const data = parseLooseJSON(raw);
    let arr = Array.isArray(data) ? data : (data.sentences || data.items || data.results || data.rewrites);
    if (!Array.isArray(arr) && sentences.length === 1 && data && (data.natural || data.versions)) arr = [data];
    if (!Array.isArray(arr)) {
      const err = new Error('shape');
      err.kind = 'parse';
      throw err;
    }
    return arr;
  }

  function friendlyError(e) {
    const name = providerName();
    const d = String(e.detail || '');
    if (e.kind === 'network') {
      if (settings.provider === 'groq' && !isNative) {
        return `Couldn't reach Groq from this browser. Websites are sometimes blocked from calling Groq directly. Switch to Gemini in Settings, or use the Android app with your Groq key.`;
      }
      return `Couldn't reach ${name}. Check your internet connection and try again.`;
    }
    if (e.kind === 'timeout') return `${name} took too long to answer. Try again, or rewrite fewer sentences at once.`;
    if (e.kind === 'parse' || e.kind === 'empty') return `The answer from ${name} came back incomplete. Tap Rewrite to try again, or pick another model in Settings.`;
    if (e.kind === 'blocked') return `${name} declined to rewrite this text. Try rewording it.`;
    if (e.kind === 'http') {
      if (e.status === 401 || e.status === 403 || /api key|invalid.*key|unauthori[sz]ed/i.test(d)) return `${name} didn't accept your key. Check it in Settings.`;
      if (e.status === 429) return `You've reached ${name}'s free limit for now. Wait a minute and try again, or pick another model in Settings. Daily limits reset the next day.`;
      if (e.status === 404 || /model.*(not found|does not exist|decommission|not supported)/i.test(d)) return `The model "${currentModel()}" isn't available. Pick another model in Settings.`;
      if (e.status === 402) return `This ${name} model needs credit. Pick a free model in Settings.`;
      if (e.status >= 500) return `${name} is having trouble right now. Try again in a moment.`;
      return `${name} returned an error (${e.status}). ${d.slice(0, 160)}`;
    }
    return 'Something went wrong. Try again.';
  }

  // ---------------------------------------------------------------- run
  async function run() {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      toast('Paste some text first');
      return;
    }
    let sentences = splitSentences(text);
    if (sentences.length > MAX_SENTENCES) {
      sentences = sentences.slice(0, MAX_SENTENCES);
      toast(`Rewriting the first ${MAX_SENTENCES} sentences. Run the rest separately.`, null, 4000);
    }
    stopRun(false);
    isExample = false;
    const ai = hasKey();
    groups = sentences.map((s) => makeGroup(s.text, s.para, ai ? 'loading' : 'dictionary'));
    renderResults();
    if (!ai) {
      setStatus(null);
      openSheet('Add a free AI key to get three rewrites. Until then you can tap words for synonyms.');
      return;
    }

    const id = ++runId;
    const ctl = new AbortController();
    runCtl = ctl;
    const go = $('goBtn');
    go.disabled = true;
    setStatus('busy', `Writing three versions with ${providerName()}…`, [['Stop', () => stopRun(true)]]);

    let failed = null;
    for (let start = 0; start < groups.length; start += CHUNK) {
      const idxs = groups.slice(start, start + CHUNK).map((_, k) => start + k);
      try {
        const arr = await aiRewrite(idxs.map((i) => groups[i].original), ctl.signal);
        if (id !== runId) return;
        idxs.forEach((gi, k) => {
          applyResult(groups[gi], arr[k]);
          rerenderGroup(gi);
        });
        if (start === 0 && pickable()) renderResults(); // pick buttons appear once two groups exist
        updateFinal();
      } catch (e) {
        if (id !== runId) return;
        failed = e;
        break;
      }
    }
    if (id !== runId) return;
    go.disabled = false;
    runCtl = null;
    if (failed) {
      groups.forEach((g) => { if (g.status === 'loading') g.status = 'failed'; });
      renderResults();
      const actions = [['Try again', run, true]];
      if (failed.kind === 'http' || failed.kind === 'network' || failed.kind === 'parse') actions.push(['Settings', () => openSheet()]);
      setStatus('error', friendlyError(failed), actions);
    } else {
      const missing = groups.filter((g) => g.status === 'missing').length;
      if (missing) setStatus('error', `${missing} sentence${missing > 1 ? 's' : ''} came back without rewrites. Tap Rewrite to try again.`, [['Try again', run, true]]);
      else setStatus(null);
    }
  }

  function stopRun(byUser) {
    if (!runCtl) return;
    runCtl.abort();
    runCtl = null;
    runId++;
    $('goBtn').disabled = false;
    if (byUser) {
      groups.forEach((g) => { if (g.status === 'loading') g.status = 'stopped'; });
      renderResults();
      setStatus(null);
      toast('Stopped');
    }
  }

  // ---------------------------------------------------------------- bubble
  let active = null; // {el, g, v, i, pinned}
  let bubbleSeq = 0;
  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;
  let moreOpen = false;

  function neighbourWords(toks, i) {
    let lc = '';
    let rc = '';
    for (let j = i - 1; j >= 0; j--) { if (toks[j].w) { lc = toks[j].t; break; } }
    for (let j = i + 1; j < toks.length; j++) { if (toks[j].w) { rc = toks[j].t; break; } }
    return { lc, rc };
  }

  function chipButton(text, cls) {
    const b = el('button', 'chip' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.dataset.word = text;
    return b;
  }

  function renderChips(box, words, cls) {
    box.replaceChildren();
    words.forEach((w) => box.appendChild(chipButton(w, cls)));
  }

  function openBubble(span, pinned) {
    const line = span.closest('p.line');
    if (!line) return;
    const gi = Number(line.dataset.g);
    const v = line.dataset.v;
    const i = Number(span.dataset.i);
    const g = groups[gi];
    const tok = g && g.tokens[v] && g.tokens[v][i];
    if (!tok) return;
    if (active && active.el === span) {
      if (pinned) active.pinned = true;
      return;
    }
    if (active && active.el) active.el.classList.remove('active');
    active = { el: span, g: gi, v, i, pinned: !!pinned };
    span.classList.add('active');
    const seq = ++bubbleSeq;
    moreOpen = false;

    const word = tok.t;
    $('bwWord').textContent = word;
    $('bwPos').textContent = '';
    $('bwDef').hidden = true;
    $('bwMoreWrap').hidden = true;
    $('bwMore').hidden = true;
    $('bwMoreBtn').setAttribute('aria-expanded', 'false');
    $('bwMoreBtn').textContent = 'More from the dictionary';

    const revWrap = $('bwRevertWrap');
    if (tok.orig != null) {
      revWrap.hidden = false;
      $('bwRevert').textContent = '↺ Back to “' + tok.orig + '”';
      $('bwRevert').dataset.word = tok.orig;
    } else {
      revWrap.hidden = true;
    }

    const chipsBox = $('bwChips');
    const fromAI = (aiSynonyms(g, word) || []).slice(0, 5);
    if (fromAI.length) {
      $('bwLabel').textContent = 'Fits this sentence';
      renderChips(chipsBox, fromAI, 'fit');
      $('bwSrc').textContent = 'Picked by AI for this sentence · Datamuse · Free Dictionary';
    } else {
      $('bwLabel').textContent = 'Synonyms';
      chipsBox.replaceChildren();
      for (let k = 0; k < 5; k++) {
        const ghost = el('span', 'chip ghost-chip', '·');
        ghost.setAttribute('aria-hidden', 'true');
        chipsBox.appendChild(ghost);
      }
      $('bwSrc').textContent = 'Datamuse · Free Dictionary';
    }

    bubble.hidden = false;
    positionBubble();

    const { lc, rc } = neighbourWords(g.tokens[v], i);
    const dmP = datamuse(word, lc, rc);
    const fdP = freeDictionary(word);

    dmP.then(async (dm) => {
      if (seq !== bubbleSeq) return;
      const fd = await fdP;
      if (seq !== bubbleSeq) return;
      const exclude = new Set([norm(word), tok.orig != null ? norm(tok.orig) : '']);
      let main = fromAI.slice();
      main.forEach((w) => exclude.add(norm(w)));
      const fdSyns = (fd || []).flatMap((m) => m.syns || []);
      if (main.length < 5) {
        for (const w of [...dm, ...fdSyns]) {
          if (main.length >= 5) break;
          if (!exclude.has(norm(w))) { main.push(w); exclude.add(norm(w)); }
        }
        if (main.length) {
          renderChips(chipsBox, main, fromAI.length ? 'fit' : '');
        } else {
          chipsBox.replaceChildren(el('p', 'empty-chips', 'No common synonyms for this word.'));
        }
      }
      const extra = [];
      for (const w of [...dm, ...fdSyns]) {
        if (extra.length >= 10) break;
        if (!exclude.has(norm(w)) && !/\s.*\s/.test(w)) { extra.push(w); exclude.add(norm(w)); }
      }
      if (extra.length) {
        renderChips($('bwMore'), extra, '');
        $('bwMoreWrap').hidden = false;
      }
      const meaning = pickMeaning(fd, guessPos(lc, word), main);
      if (meaning) {
        $('bwPos').textContent = POS_ABBR[meaning.pos] || meaning.pos;
        if (meaning.def) {
          $('bwDef').textContent = meaning.def;
          $('bwDef').hidden = false;
        }
      }
      positionBubble();
    }).catch(() => {
      if (seq !== bubbleSeq) return;
      if (!fromAI.length) chipsBox.replaceChildren(el('p', 'empty-chips', 'Couldn’t load synonyms. Check your connection.'));
      positionBubble();
    });
  }

  function closeBubble() {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    if (active && active.el) active.el.classList.remove('active');
    active = null;
    bubbleSeq++;
    bubble.hidden = true;
  }

  let posRaf = 0;
  function positionBubble() {
    cancelAnimationFrame(posRaf);
    posRaf = requestAnimationFrame(() => {
      if (!active || bubble.hidden) return;
      const span = active.el;
      if (!span.isConnected) { closeBubble(); return; }
      const r = span.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) { closeBubble(); return; }
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const minTop = Math.max(8, header.getBoundingClientRect().bottom + 6);
      let top = r.top - bh - 12;
      let place = 'above';
      if (top < minTop) {
        const below = r.bottom + 12;
        if (below + bh <= vh - 8 || below + bh - vh < minTop - top) { top = below; place = 'below'; }
      }
      const left = clamp(r.left + r.width / 2 - bw / 2, 12, Math.max(12, vw - bw - 12));
      bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      bubble.classList.toggle('above', place === 'above');
      bubble.classList.toggle('below', place === 'below');
      $('bubbleArrow').style.left = clamp(r.left + r.width / 2 - left, 18, bw - 18) + 'px';
    });
  }

  function swapWord(newWord) {
    if (!active) return;
    const { g: gi, v, i } = active;
    const g = groups[gi];
    const toks = g.tokens[v];
    const tok = toks[i];
    const snapshot = toks.map((t) => Object.assign({}, t));
    const before = tok.t;
    const replacement = matchCase(newWord, before);
    if (tok.orig == null) tok.orig = before;
    tok.t = replacement;
    if (norm(tok.t) === norm(tok.orig)) { tok.t = matchCase(tok.orig, before); delete tok.orig; }
    fixArticle(toks, i);
    closeBubble();
    const line = rerenderLine(gi, v);
    const span = line.querySelector(`.w[data-i="${i}"]`);
    if (span) {
      span.classList.add('flash');
      span.focus({ preventScroll: true });
    }
    updateFinal();
    toast(`“${before}” → “${tok.t}”`, {
      label: 'Undo',
      fn: () => {
        g.tokens[v] = snapshot;
        rerenderLine(gi, v);
        updateFinal();
      },
    });
  }

  // ---------------------------------------------------------------- settings sheet
  let lastFocus = null;

  function openSheet(intro) {
    closeBubble();
    lastFocus = document.activeElement;
    $('sheetIntro').hidden = !intro;
    $('sheetIntro').textContent = intro || '';
    syncSheet();
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => (hasKey() ? $('sheetClose') : $('keyInput')).focus(), 50);
  }

  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.style.overflow = '';
    $('testResult').textContent = '';
    $('testResult').className = 'test-result';
    updateKeynote();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function modelLabel(p, id) {
    return PROVIDERS[p].labels[id] || id;
  }

  function fillModelSelect() {
    const p = settings.provider;
    const sel = $('modelSelect');
    const list = (settings.modelLists[p] && settings.modelLists[p].length) ? settings.modelLists[p] : [PROVIDERS[p].defaultModel];
    const cur = currentModel(p);
    const ids = list.includes(cur) ? list : [cur, ...list];
    sel.replaceChildren();
    ids.forEach((id) => {
      const o = el('option', null, modelLabel(p, id));
      o.value = id;
      if (id === cur) o.selected = true;
      sel.appendChild(o);
    });
    $('modelHint').textContent = settings.modelLists[p] && settings.modelLists[p].length
      ? `${settings.modelLists[p].length} free models available with your key.`
      : 'The full list loads after you save a working key.';
  }

  function syncSheet() {
    const p = settings.provider;
    document.querySelectorAll('#providerSeg [data-provider]').forEach((b) => {
      const on = b.dataset.provider === p;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('providerNote').textContent = PROVIDERS[p].note;
    $('keyLink').href = PROVIDERS[p].keyUrl;
    $('keyLink').textContent = PROVIDERS[p].name + "'s free key page";
    $('keyInput').value = settings.keys[p] || '';
    fillModelSelect();
    $('removeKeyBtn').hidden = !settings.keys[p];
  }

  function sortModels(p, ids) {
    const pref = PROVIDERS[p].prefer;
    return ids.slice().sort((a, b) => {
      const ia = pref.indexOf(a);
      const ib = pref.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
  }

  async function fetchModels(p, key) {
    if (p === 'groq') {
      const res = await httpJSON('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key }, timeout: 20000 });
      const ids = (res.data || []).map((m) => m.id).filter((id) => id && !/whisper|guard|safeguard|orpheus|tts|playai|distil|compound|allam|embed|vision/i.test(id));
      return sortModels(p, ids);
    }
    if (p === 'gemini') {
      const res = await httpJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, timeout: 20000 });
      const ids = (res.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((id) => /^gemini/i.test(id) && /flash/i.test(id) && !/embedding|tts|image|live|transcribe|audio|robotics|computer|thinking-exp|native/i.test(id));
      const sorted = sortModels(p, ids);
      // Among the rest, put Flash-Lite (largest free allowance) first.
      return sorted.sort((a, b) => {
        const pa = PROVIDERS.gemini.prefer.indexOf(a);
        const pb = PROVIDERS.gemini.prefer.indexOf(b);
        if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        const la = /lite/i.test(a) ? 0 : 1;
        const lb = /lite/i.test(b) ? 0 : 1;
        return la - lb || b.localeCompare(a);
      });
    }
    // OpenRouter: check the key, then list free models.
    await httpJSON('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key }, timeout: 20000 });
    const res = await httpJSON('https://openrouter.ai/api/v1/models', { timeout: 20000 });
    const ids = (res.data || []).map((m) => m.id).filter((id) => id && (id.endsWith(':free') || id === 'openrouter/free'));
    return sortModels(p, ids);
  }

  async function saveAndTest() {
    const p = settings.provider;
    const key = $('keyInput').value.trim().replace(/\s+/g, '');
    const out = $('testResult');
    if (!key) {
      out.className = 'test-result bad';
      out.textContent = 'Paste your key first.';
      return;
    }
    settings.keys[p] = key;
    saveSettings();
    $('removeKeyBtn').hidden = false;
    out.className = 'test-result';
    out.textContent = 'Checking your key…';
    $('saveKeyBtn').disabled = true;
    try {
      const list = await fetchModels(p, key);
      settings.modelLists[p] = list;
      if (list.length && !list.includes(settings.models[p])) {
        settings.models[p] = list.includes(PROVIDERS[p].defaultModel) ? PROVIDERS[p].defaultModel : list[0];
      }
      saveSettings();
      fillModelSelect();
      out.className = 'test-result ok';
      out.textContent = list.length ? `Key works. Using ${modelLabel(p, currentModel(p))}.` : 'Key works, but no free models were listed. Try another service.';
    } catch (e) {
      out.className = 'test-result bad';
      if (e.kind === 'http' && (e.status === 400 || e.status === 401 || e.status === 403)) out.textContent = `${providerName(p)} didn't accept this key. Copy it again and paste it here.`;
      else if (e.kind === 'network' && p === 'groq' && !isNative) out.textContent = 'This browser was blocked from reaching Groq. Your key is saved for the Android app. On the website, use Gemini or OpenRouter.';
      else if (e.kind === 'network' || e.kind === 'timeout') out.textContent = `Couldn't reach ${providerName(p)}. Your key is saved; check your connection and test again.`;
      else if (e.kind === 'http' && e.status === 429) out.textContent = 'Key saved. The service says you are over its free limit right now; try again later.';
      else out.textContent = `Key saved, but the check failed (${e.status || e.kind}).`;
    } finally {
      $('saveKeyBtn').disabled = false;
    }
  }

  function updateKeynote() {
    $('keynote').hidden = hasKey();
  }

  // ---------------------------------------------------------------- updates (Android app)
  let pendingUpdate = null;

  const pluginCache = {};
  function getPlugin(name) {
    if (!isNative) return null;
    if (pluginCache[name]) return pluginCache[name];
    let plugin = null;
    try {
      if (window.capacitorExports && typeof window.capacitorExports.registerPlugin === 'function') {
        plugin = window.capacitorExports.registerPlugin(name);
      } else if (Cap.Plugins && Cap.Plugins[name]) {
        plugin = Cap.Plugins[name];
      } else if (typeof Cap.registerPlugin === 'function') {
        plugin = Cap.registerPlugin(name);
      }
    } catch (e) { plugin = null; }
    pluginCache[name] = plugin;
    return plugin;
  }

  function versionParts(s) {
    const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function isNewer(remote, local) {
    const a = versionParts(remote);
    const b = versionParts(local);
    if (!a) return false;
    if (!b) return true;
    for (let k = 0; k < 3; k++) {
      if (a[k] !== b[k]) return a[k] > b[k];
    }
    return false;
  }

  async function checkForUpdate(manual) {
    const out = $('updateResult');
    if (manual) out.textContent = 'Checking…';
    try {
      const rel = await httpJSON(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, timeout: 15000 });
      const remote = String(rel.tag_name || '').replace(/^v/i, '');
      const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
      if (asset && isNewer(remote, VERSION.name)) {
        const notes = String(rel.body || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
        pendingUpdate = { version: remote, url: asset.browser_download_url, notes };
        showUpdateBar();
        if (manual) {
          out.textContent = `Version ${remote} is available.`;
          closeSheet();
        }
      } else if (manual) {
        out.textContent = `You have the newest version (${VERSION.name}).`;
      }
    } catch (e) {
      if (manual) out.textContent = e.status === 404 ? 'No releases published yet.' : 'Could not check right now. Try again later.';
    }
  }

  function showUpdateBar() {
    if (!pendingUpdate) return;
    const notes = pendingUpdate.notes && !/^human\s/i.test(pendingUpdate.notes) ? ` ${pendingUpdate.notes}` : '';
    $('updateText').textContent = `Version ${pendingUpdate.version} is ready.${notes}`;
    $('updateNow').textContent = 'Update';
    $('updateNow').disabled = false;
    $('updateNow').dataset.mode = 'update';
    $('updateBar').hidden = false;
  }

  async function doUpdate() {
    if (!pendingUpdate) return;
    const btn = $('updateNow');
    const text = $('updateText');
    const Updater = getPlugin('AppUpdater');
    if (!Updater) {
      window.open(pendingUpdate.url, '_blank');
      return;
    }
    if (btn.dataset.mode === 'settings') {
      try { await Updater.openInstallSettings(); } catch (e) { /* ignore */ }
      btn.dataset.mode = 'update';
      btn.textContent = 'Update';
      text.textContent = 'When it’s allowed, come back and tap Update.';
      return;
    }
    try {
      const perm = await Updater.canInstall();
      if (!perm || !perm.allowed) {
        text.textContent = 'To install updates, allow Human to install apps. Turn it on, then come back and tap Update.';
        btn.textContent = 'Open setting';
        btn.dataset.mode = 'settings';
        return;
      }
    } catch (e) { /* older plugin: try anyway */ }
    btn.disabled = true;
    $('updateLater').disabled = true;
    text.textContent = 'Downloading the update… 0%';
    let handle = null;
    try {
      handle = await Updater.addListener('progress', (ev) => {
        const pct = ev && typeof ev.percent === 'number' ? ev.percent : 0;
        text.textContent = `Downloading the update… ${pct}%`;
      });
    } catch (e) { handle = null; }
    try {
      await Updater.downloadAndInstall({ url: pendingUpdate.url });
      text.textContent = 'Opening the installer. Tap Update or Install there.';
      btn.textContent = 'Install again';
      btn.disabled = false;
    } catch (e) {
      text.textContent = 'The download didn’t finish. Check your connection and tap Update to try again.';
      btn.textContent = 'Update';
      btn.disabled = false;
    } finally {
      $('updateLater').disabled = false;
      if (handle && handle.remove) handle.remove();
    }
  }

  // ---------------------------------------------------------------- events
  function updateCount() {
    const n = input.value.length;
    $('count').textContent = `${n.toLocaleString('en-US')} / ${MAX_CHARS.toLocaleString('en-US')}`;
  }

  let draftTimer = 0;
  input.addEventListener('input', () => {
    updateCount();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => save('human.draft', input.value), 400);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  });

  $('goBtn').addEventListener('click', run);
  $('copyAllBtn').addEventListener('click', () => copyText(combinedText()));
  $('clearBtn').addEventListener('click', () => {
    input.value = '';
    updateCount();
    save('human.draft', '');
    input.focus();
  });
  const pasteBtn = $('pasteBtn');
  if (!(navigator.clipboard && navigator.clipboard.readText)) pasteBtn.hidden = true;
  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) {
        input.value = t.slice(0, MAX_CHARS);
        updateCount();
        save('human.draft', input.value);
      } else {
        toast('Your clipboard is empty.');
      }
    } catch (e) {
      toast('Long-press the box and choose Paste.');
      input.focus();
    }
  });

  results.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) {
      if (active && active.el === w && active.pinned) closeBubble();
      else openBubble(w, true);
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const gi = Number(pick.dataset.g);
      groups[gi].chosen = pick.dataset.pick;
      rerenderGroup(gi);
      updateFinal();
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const g = groups[Number(copy.dataset.g)];
      copyText(tokensText(g.tokens[copy.dataset.copy] || g.tokens.original));
    }
  });

  results.addEventListener('keydown', (e) => {
    const w = e.target.closest && e.target.closest('.w');
    if (w && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openBubble(w, true);
      const first = bubble.querySelector('.chip:not(.ghost-chip)');
      if (first) setTimeout(() => first.focus(), 30);
    }
  });

  const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (finePointer) {
    results.addEventListener('pointerover', (e) => {
      const w = e.target.closest('.w');
      if (!w) return;
      clearTimeout(hoverCloseTimer);
      if (active && active.pinned) return;
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = setTimeout(() => openBubble(w, false), 220);
    });
    results.addEventListener('pointerout', (e) => {
      const w = e.target.closest('.w');
      if (!w) return;
      clearTimeout(hoverOpenTimer);
      if (active && !active.pinned) {
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => { if (active && !active.pinned) closeBubble(); }, 260);
      }
    });
    bubble.addEventListener('pointerenter', () => clearTimeout(hoverCloseTimer));
    bubble.addEventListener('pointerleave', () => {
      if (active && !active.pinned) hoverCloseTimer = setTimeout(() => { if (active && !active.pinned) closeBubble(); }, 260);
    });
  }

  bubble.addEventListener('click', (e) => {
    if (e.target.closest('#bubbleClose')) { const back = active && active.el; closeBubble(); if (back) back.focus(); return; }
    if (e.target.closest('#bwMoreBtn')) {
      moreOpen = !moreOpen;
      $('bwMore').hidden = !moreOpen;
      $('bwMoreBtn').setAttribute('aria-expanded', String(moreOpen));
      $('bwMoreBtn').textContent = moreOpen ? 'Fewer' : 'More from the dictionary';
      if (active) active.pinned = true;
      positionBubble();
      return;
    }
    const chip = e.target.closest('.chip[data-word]');
    if (chip) swapWord(chip.dataset.word);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!active) return;
    if (bubble.contains(e.target) || e.target.closest('.w')) return;
    closeBubble();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!sheet.hidden) { closeSheet(); return; }
    if (active) { const back = active.el; closeBubble(); if (back) back.focus(); }
  });

  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 4);
    if (active) positionBubble();
  }, { passive: true });
  window.addEventListener('resize', () => { if (active) positionBubble(); });

  // Settings
  $('settingsBtn').addEventListener('click', () => openSheet());
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) openSheet();
  });
  $('sheetClose').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
  $('providerSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-provider]');
    if (!b) return;
    settings.provider = b.dataset.provider;
    saveSettings();
    $('testResult').textContent = '';
    syncSheet();
  });
  $('providerSeg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = ['groq', 'gemini', 'openrouter'];
    const k = order.indexOf(settings.provider);
    settings.provider = order[(k + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    saveSettings();
    syncSheet();
    $('providerSeg').querySelector(`[data-provider="${settings.provider}"]`).focus();
  });
  $('keyShow').addEventListener('click', () => {
    const k = $('keyInput');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('keyShow').textContent = show ? 'Hide' : 'Show';
    $('keyShow').setAttribute('aria-pressed', String(show));
  });
  $('modelSelect').addEventListener('change', (e) => {
    settings.models[settings.provider] = e.target.value;
    saveSettings();
  });
  $('saveKeyBtn').addEventListener('click', saveAndTest);
  $('removeKeyBtn').addEventListener('click', () => {
    delete settings.keys[settings.provider];
    delete settings.modelLists[settings.provider];
    saveSettings();
    syncSheet();
    $('testResult').className = 'test-result';
    $('testResult').textContent = 'Key removed from this device.';
  });

  // Updates
  $('updateNow').addEventListener('click', doUpdate);
  $('updateLater').addEventListener('click', () => { $('updateBar').hidden = true; });
  $('checkUpdateBtn').addEventListener('click', () => checkForUpdate(true));

  // Android back button: close what's open first.
  if (isNative) {
    const App = getPlugin('App');
    if (App && App.addListener) {
      try {
        App.addListener('backButton', () => {
          if (!sheet.hidden) closeSheet();
          else if (active) closeBubble();
          else if (App.exitApp) App.exitApp();
        });
      } catch (e) { /* default behaviour stays */ }
    }
  }

  // ---------------------------------------------------------------- start
  function showExample() {
    isExample = true;
    const g = makeGroup(EXAMPLE.original, 0, 'done');
    applyResult(g, Object.assign({}, EXAMPLE.versions, { synonyms: EXAMPLE.syn }));
    groups = [g];
    renderResults();
  }

  $('versionName').textContent = VERSION.name;
  $('appNative').hidden = !isNative;
  $('appWeb').hidden = isNative;

  const draft = load('human.draft', '');
  input.value = draft && draft.trim() ? draft : EXAMPLE.original;
  updateCount();
  updateKeynote();
  showExample();

  if (isNative) setTimeout(() => checkForUpdate(false), 1500);

  // Exposed for automated checks only.
  window.__human = { splitSentences, tokenize, matchCase, fixArticle, normalizeSyn, parseLooseJSON, buildPrompt, isNewer, lemmaForms, inflect };
})();
