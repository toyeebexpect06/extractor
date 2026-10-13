(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Constants
   * ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);

  const STORE_KEY = 'smartify.state.v1';
  const CONCURRENCY = 20;           // domains crawled in parallel
  const PACING_MS = 60;             // minimum gap between domain starts
  const FETCH_TIMEOUT_MS = 12000;
  const DNS_TIMEOUT_MS = 6000;
  const MAX_PAGE_CHARS = 1500000;
  const MAX_EMAILS_PER_DOMAIN = 8;
  const MAX_RENDER_ROWS = 1500;

  // {url} is replaced with the encoded page URL
  const PROXIES = {
    allorigins: 'https://api.allorigins.win/raw?url={url}',
    corsproxy: 'https://corsproxy.io/?url={url}',
  };

  // Paths swept when "Deep crawl" is on (in addition to links found on the homepage and your extra paths)
  const BASE_DEEP_PATHS = ['/contact', '/about', '/pages/contact', '/pages/about-us'];

  const BAD_TLDS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'css', 'js', 'mjs', 'map',
    'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'pdf', 'json', 'xml', 'html', 'htm', 'php', 'txt', 'zip',
  ]);
  const JUNK_DOMAINS = new Set([
    'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain.com', 'yoursite.com',
    'yourstore.com', 'mysite.com', 'test.com', 'sentry.io', 'sentry-next.wixpress.com', 'sentry.wixpress.com',
  ]);
  const JUNK_MAILBOX = new Set([
    'email', 'name', 'yourname', 'youremail', 'your-email', 'your.email', 'user', 'username', 'example',
    'test', 'you', 'someone', 'johndoe', 'john.doe', 'jane.doe', 'first.last', 'firstname', 'lastname', 'name.surname',
  ]);
  const PLATFORM_DOMAINS = new Set([
    'shopify.com', 'myshopify.com', 'wix.com', 'wixpress.com', 'squarespace.com', 'wordpress.com', 'wpengine.com',
    'godaddy.com', 'google.com', 'apple.com', 'facebook.com', 'meta.com', 'w3.org', 'schema.org', 'cloudflare.com',
    'bigcommerce.com', 'woocommerce.com', 'klaviyo.com', 'mailchimp.com', 'stripe.com', 'paypal.com',
  ]);
  const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
    'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'gmx.net', 'yandex.com', 'mail.com', 'msn.com',
  ]);
  const LOW_MAILBOX = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|webmaster|hostmaster|root|privacy|legal|dpo|gdpr|compliance|unsubscribe|bounces?|notifications?|alerts?|newsletter|press|media|jobs|careers|recruit(?:ing|ment)?|security|spam|copyright|dmca|billing|invoices?)$/i;
  const GENERIC_MAILBOX = /^(info|hello|hi|hey|contact|contactus|support|help|care|customercare|customer-?service|service|sales|shop|store|orders?|team|office|admin|mail|enquiries|enquiry|inquiries|inquiry|general)$/i;
  const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,24}/gi;

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  const state = {
    config: {
      deep: true,
      verifiedOnly: true,
      ownerOnly: true,
      extraPaths: ['/policies/privacy-policy'],
      proxy: 'allorigins',
      customProxy: '',
    },
    viewVerifiedOnly: true,
    rows: [],            // extracted addresses
    done: {},            // domain -> 'ok' | 'none' | 'failed'
    total: 0,
    status: 'idle',      // idle | running | stopped | done
    running: false,
    runCtrl: null,
    queuedCount: 0,
  };

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  let toastTimer;
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function fetchT(url, opts = {}, ms = FETCH_TIMEOUT_MS, outer) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Persistence
   * ------------------------------------------------------------------ */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        targets: $('#targets').value,
        config: state.config,
        viewVerifiedOnly: state.viewVerifiedOnly,
        rows: state.rows,
        done: state.done,
        total: state.total,
      }));
    } catch (_) { /* storage full or unavailable */ }
  }
  const saveSoon = debounce(save, 400);

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.targets === 'string') $('#targets').value = s.targets;
      if (s.config && typeof s.config === 'object') Object.assign(state.config, s.config);
      if (!Array.isArray(state.config.extraPaths)) state.config.extraPaths = [];
      if (typeof s.viewVerifiedOnly === 'boolean') state.viewVerifiedOnly = s.viewVerifiedOnly;
      if (Array.isArray(s.rows)) state.rows = s.rows;
      if (s.done && typeof s.done === 'object') state.done = s.done;
      if (Number.isFinite(s.total)) state.total = s.total;
    } catch (_) { /* ignore corrupt state */ }
  }

  /* ------------------------------------------------------------------ *
   *  Target parsing
   * ------------------------------------------------------------------ */
  function parseTargets(text) {
    const seen = new Map();
    for (let tok of String(text).split(/[\s,;]+/)) {
      tok = tok.replace(/^["'<(\[]+|["'>)\]]+$/g, '');
      if (!tok || tok.includes('@')) continue;
      if (!/^https?:\/\//i.test(tok)) tok = 'https://' + tok;
      let u;
      try { u = new URL(tok); } catch (_) { continue; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const host = u.hostname.toLowerCase();
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) continue;   // also rejects IPs and localhost
      const domain = host.replace(/^www\./, '');
      if (!seen.has(domain)) {
        seen.set(domain, {
          domain,
          origin: u.origin,
          entry: u.pathname !== '/' ? u.origin + u.pathname : null,
        });
      }
    }
    return [...seen.values()];
  }

  /* ------------------------------------------------------------------ *
   *  Email harvesting
   * ------------------------------------------------------------------ */
  function decodeCf(hex) {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    }
    return out;
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&commat;/gi, '@')
      .replace(/&period;/gi, '.')
      .replace(/&amp;/gi, '&');
  }

  function splitEmail(email) {
    const at = email.lastIndexOf('@');
    return [email.slice(0, at), email.slice(at + 1)];
  }

  function cleanEmail(raw) {
    const e = raw.toLowerCase()
      .replace(/^(?:u00[0-9a-f]{2})+/, '')     // JSON-escaped "\u003e" prefixes
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[.\-_]+$/, '');
    if (!/^[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,24}$/.test(e)) return null;
    const at = e.lastIndexOf('@');
    if (at < 1) return null;
    const mailbox = e.slice(0, at);
    const domain = e.slice(at + 1);
    if (mailbox.length > 64 || domain.length > 253) return null;
    if (BAD_TLDS.has(domain.split('.').pop())) return null;      // logo@2x.png etc.
    if (JUNK_DOMAINS.has(domain) || JUNK_MAILBOX.has(mailbox)) return null;
    return e;
  }

  function harvestEmails(html) {
    const found = new Set();
    const addCf = (hex) => {
      try {
        const e = cleanEmail(decodeCf(hex));
        if (e) found.add(e);
      } catch (_) { /* ignore */ }
    };
    for (const m of html.matchAll(/data-cfemail="([0-9a-f]{4,})"/gi)) addCf(m[1]);
    for (const m of html.matchAll(/email-protection#([0-9a-f]{4,})/gi)) addCf(m[1]);

    const text = decodeEntities(html)
      .replace(/%40/gi, '@')
      .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@')
      .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');

    for (const m of text.matchAll(EMAIL_RE)) {
      const e = cleanEmail(m[0]);
      if (e) found.add(e);
    }
    return found;
  }

  /* ------------------------------------------------------------------ *
   *  Confidence scoring
   * ------------------------------------------------------------------ */
  function sameSite(emailDomain, storeDomain) {
    return emailDomain === storeDomain
      || emailDomain.endsWith('.' + storeDomain)
      || storeDomain.endsWith('.' + emailDomain);
  }

  // high: looks like a person on the store's own (or a free-mail) domain
  // medium: generic mailbox on the store's domain, or a person on another domain
  // low: system mailboxes, platform domains, generic mailbox on someone else's domain
  function classify(mailbox, emailDomain, storeDomain) {
    if (PLATFORM_DOMAINS.has(emailDomain) || LOW_MAILBOX.test(mailbox)) return 'low';
    const own = sameSite(emailDomain, storeDomain);
    const free = FREE_MAIL.has(emailDomain);
    if (GENERIC_MAILBOX.test(mailbox)) return own || free ? 'medium' : 'low';
    return own || free ? 'high' : 'medium';
  }
  const RANK = { high: 0, medium: 1, low: 2 };

  /* ------------------------------------------------------------------ *
   *  MX verification (DNS over HTTPS, cached per domain)
   * ------------------------------------------------------------------ */
  const mxCache = new Map();

  function hasMx(domain) {
    if (mxCache.has(domain)) return mxCache.get(domain);
    const p = (async () => {
      const endpoints = [
        `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      ];
      for (const url of endpoints) {
        try {
          const r = await fetchT(url, { headers: { accept: 'application/dns-json' } }, DNS_TIMEOUT_MS);
          if (!r.ok) continue;
          const j = await r.json();
          if (j.Status === 0) return Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 15);
          if (j.Status === 3) return false;          // NXDOMAIN
        } catch (_) { /* try next resolver */ }
      }
      return null;                                   // inconclusive
    })();
    mxCache.set(domain, p);
    p.then((v) => { if (v === null) mxCache.delete(domain); });
    return p;
  }

  /* ------------------------------------------------------------------ *
   *  Page fetching and crawling
   * ------------------------------------------------------------------ */
  function proxied(url, cfg) {
    if (cfg.proxy === 'none') return url;
    const tpl = cfg.proxy === 'custom' ? cfg.customProxy.trim() : PROXIES[cfg.proxy];
    if (!tpl) throw new Error('No proxy configured');
    return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url);
  }

  async function fetchPage(url, cfg, signal) {
    const r = await fetchT(proxied(url, cfg), { redirect: 'follow' }, FETCH_TIMEOUT_MS, signal);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    return text.slice(0, MAX_PAGE_CHARS);
  }

  function discoverLinks(html, t) {
    const out = [];
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return out; }
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
      let u;
      try { u = new URL(href, t.origin + '/'); } catch (_) { continue; }
      if (u.hostname.replace(/^www\./, '') !== t.domain) continue;
      const label = (u.pathname + ' ' + (a.textContent || '')).toLowerCase();
      if (!/contact|about|privacy|policy|policies|impressum|imprint|legal|terms/.test(label)) continue;
      u.hash = '';
      u.search = '';
      if (!out.includes(u.href)) out.push(u.href);
      if (out.length >= 4) break;
    }
    return out;
  }

  async function crawlDomain(t, cfg, signal) {
    const emails = new Map();   // email -> page it was found on
    const visited = new Set();
    let okPages = 0;
    let attempts = 0;

    const visit = async (url) => {
      const key = url.replace(/\/+$/, '').toLowerCase();
      if (visited.has(key)) return null;
      visited.add(key);
      attempts++;
      try {
        const html = await fetchPage(url, cfg, signal);
        okPages++;
        for (const e of harvestEmails(html)) if (!emails.has(e)) emails.set(e, url);
        return html;
      } catch (err) {
        if (signal.aborted) throw err;
        return null;
      }
    };

    const hasHigh = () => [...emails.keys()].some((e) => {
      const [m, d] = splitEmail(e);
      return classify(m, d, t.domain) === 'high';
    });

    const home = await visit(t.origin + '/');
    if (t.entry) await visit(t.entry);

    if (cfg.deep) {
      const queue = [];
      if (home) queue.push(...discoverLinks(home, t));
      for (const p of [...BASE_DEEP_PATHS, ...cfg.extraPaths]) queue.push(t.origin + p);
      for (const u of queue) {
        if (signal.aborted) break;
        if (hasHigh()) break;                          // good enough, stop early
        if (okPages === 0 && attempts >= 3) break;     // site unreachable
        await visit(u);
      }
    }

    const rows = [];
    for (const [email, source] of emails) {
      const [mailbox, emailDomain] = splitEmail(email);
      const confidence = classify(mailbox, emailDomain, t.domain);
      if (cfg.ownerOnly && confidence === 'low') continue;
      const mx = await hasMx(emailDomain);
      const mxState = mx === true ? 'yes' : mx === false ? 'no' : 'unknown';
      if (cfg.verifiedOnly && mxState !== 'yes') continue;
      rows.push({ store: t.domain, email, mailbox, emailDomain, mx: mxState, confidence, source });
    }
    rows.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);

    return {
      status: okPages === 0 ? 'failed' : rows.length ? 'ok' : 'none',
      rows: rows.slice(0, MAX_EMAILS_PER_DOMAIN),
    };
  }

  /* ------------------------------------------------------------------ *
   *  Run control
   * ------------------------------------------------------------------ */
  function pendingTargets(targets) {
    return targets.filter((t) => !state.done[t.domain] || state.done[t.domain] === 'failed');
  }

  async function run() {
    if (state.running) { stop(); return; }

    const targets = parseTargets($('#targets').value);
    if (!targets.length) { toast('Paste at least one store URL first.', 'warn'); return; }
    if (state.config.proxy === 'custom' && !state.config.customProxy.trim()) {
      toast('Enter your proxy URL, or pick another page fetcher.', 'warn');
      $('#customProxy').focus();
      return;
    }

    // Keep only results that belong to the current list
    const keys = new Set(targets.map((t) => t.domain));
    for (const d of Object.keys(state.done)) if (!keys.has(d)) delete state.done[d];
    state.rows = state.rows.filter((r) => keys.has(r.store));

    let pending = pendingTargets(targets);
    if (!pending.length) {            // everything finished earlier: start over
      state.done = {};
      state.rows = [];
      pending = targets;
    } else {                          // resume: retry failed domains cleanly
      for (const t of pending) {
        delete state.done[t.domain];
        state.rows = state.rows.filter((r) => r.store !== t.domain);
      }
    }

    state.total = targets.length;
    state.running = true;
    state.runCtrl = new AbortController();
    const { signal } = state.runCtrl;
    const cfg = JSON.parse(JSON.stringify(state.config));    // snapshot for this run
    setStatus('running');
    paintNow();

    let next = 0;
    let nextStart = 0;
    const gate = async () => {
      const now = Date.now();
      const wait = Math.max(0, nextStart - now);
      nextStart = Math.max(now, nextStart) + PACING_MS;
      if (wait) await sleep(wait);
    };

    const worker = async () => {
      while (!signal.aborted) {
        const i = next++;
        if (i >= pending.length) return;
        await gate();
        if (signal.aborted) return;
        const t = pending[i];
        try {
          const res = await crawlDomain(t, cfg, signal);
          if (signal.aborted) return;
          state.rows.push(...res.rows);
          state.done[t.domain] = res.status;
        } catch (_) {
          if (signal.aborted) return;
          state.done[t.domain] = 'failed';
        }
        schedulePaint();
        saveSoon();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    const aborted = signal.aborted;
    state.running = false;
    state.runCtrl = null;
    setStatus(aborted ? 'stopped' : 'done');
    paintNow();
    save();

    if (aborted) {
      toast('Stopped. Press run extraction to resume where you left off.');
    } else {
      const s = computeStats();
      toast(`Finished: ${s.withEmail} of ${s.scanned} domains had an address.`);
    }
  }

  function stop() {
    if (state.runCtrl) state.runCtrl.abort();
  }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  const STATUS_LABEL = { idle: 'idle', running: 'running', stopped: 'stopped', done: 'done' };

  function setStatus(kind) {
    state.status = kind;
    $('#statusText').textContent = STATUS_LABEL[kind];
    $('#statusDot').dataset.state = kind;
    const btn = $('#runBtn');
    btn.textContent = kind === 'running' ? 'Stop' : 'Run extraction';
    btn.classList.toggle('stop', kind === 'running');
  }

  function computeStats() {
    const keys = Object.keys(state.done);
    const failed = keys.filter((k) => state.done[k] === 'failed').length;
    const scanned = keys.length;
    return {
      scanned,
      total: state.total,
      failed,
      completed: scanned - failed,
      pending: Math.max(0, state.total - scanned),
      verified: state.rows.filter((r) => r.mx === 'yes').length,
      withEmail: keys.filter((k) => state.done[k] === 'ok').length,
      noEmail: keys.filter((k) => state.done[k] === 'none').length,
    };
  }

  function visibleRows() {
    const rows = state.viewVerifiedOnly ? state.rows.filter((r) => r.mx === 'yes') : state.rows.slice();
    return rows.sort((a, b) =>
      a.store.localeCompare(b.store) || RANK[a.confidence] - RANK[b.confidence] || a.email.localeCompare(b.email));
  }

  function badge(text, kind) {
    const td = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'badge ' + kind;
    span.textContent = text;
    td.appendChild(span);
    return td;
  }

  function textCell(value, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = value;
    return td;
  }

  function sourceCell(url) {
    const td = document.createElement('td');
    td.className = 'src';
    let label = url;
    try { const u = new URL(url); label = u.pathname === '/' ? 'homepage' : u.pathname; } catch (_) { /* keep raw */ }
    if (/^https?:\/\//i.test(url)) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      td.appendChild(a);
    } else {
      td.textContent = label;
    }
    td.title = url;
    return td;
  }

  function renderTable() {
    const rows = visibleRows();
    $('#resCount').textContent = rows.length + (rows.length === 1 ? ' row' : ' rows');

    const tbody = $('#tbody');
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, MAX_RENDER_ROWS)) {
      const tr = document.createElement('tr');
      tr.appendChild(textCell(r.store));
      tr.appendChild(textCell(r.email, 'email'));
      tr.appendChild(textCell(r.mailbox));
      tr.appendChild(textCell(r.emailDomain));
      tr.appendChild(badge(r.mx === 'yes' ? 'verified' : r.mx === 'no' ? 'no MX' : 'unknown',
        r.mx === 'yes' ? 'ok' : r.mx === 'no' ? 'bad' : 'warn'));
      tr.appendChild(badge(r.confidence, r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'warn' : 'bad'));
      tr.appendChild(sourceCell(r.source));
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);

    const capNote = $('#capNote');
    if (rows.length > MAX_RENDER_ROWS) {
      capNote.hidden = false;
      capNote.textContent = `Showing the first ${MAX_RENDER_ROWS} rows. Copy and CSV include all ${rows.length}.`;
    } else {
      capNote.hidden = true;
    }

    const empty = $('#emptyMsg');
    if (rows.length) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      if (state.running) empty.textContent = 'Crawling… addresses appear here as each domain finishes.';
      else if (state.total === 0) empty.textContent = 'Awaiting input — paste a URL list and press run extraction.';
      else empty.textContent = state.viewVerifiedOnly && state.rows.length
        ? 'No verified addresses. Turn off “Verified only” to see unverified ones.'
        : 'No addresses matched your filters.';
    }
  }

  function renderStats() {
    const s = computeStats();
    const pct = s.total ? Math.min(100, Math.floor((s.scanned / s.total) * 100)) : 0;
    $('#runPct').textContent = pct;
    $('#barFill').style.width = pct + '%';
    $('#barTrack').setAttribute('aria-valuenow', String(pct));
    $('#statScanned').textContent = `${s.scanned}/${s.total}`;
    $('#statVerified').textContent = s.verified;
    $('#statWith').textContent = s.withEmail;
    $('#statNo').textContent = s.noEmail;
    $('#cDone').textContent = s.completed;
    $('#cPending').textContent = s.pending;
    $('#cFailed').textContent = s.failed;

    const queued = state.running ? s.pending : state.queuedCount;
    $('#queuedText').textContent = `${queued} queued`;
  }

  function paintNow() { renderStats(); renderTable(); }
  let paintTimer = null;
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = null; paintNow(); }, 200);
  }

  function updateQueued() {
    const targets = parseTargets($('#targets').value);
    // If everything was already processed, a new run starts over, so the whole list counts as queued
    state.queuedCount = pendingTargets(targets).length || targets.length;
    if (!state.running) renderStats();
  }
  const updateQueuedSoon = debounce(updateQueued, 200);

  /* ------------------------------------------------------------------ *
   *  Config UI
   * ------------------------------------------------------------------ */
  function normalizePath(raw) {
    let p = String(raw).trim();
    if (!p || /\s/.test(p) || p.includes('://')) return null;
    p = p.replace(/^\/*/, '/').replace(/\/{2,}/g, '/');
    return p.length > 1 && p.length <= 200 ? p : null;
  }

  function renderChips() {
    const wrap = $('#chips');
    const frag = document.createDocumentFragment();
    state.config.extraPaths.forEach((p, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.append(p);
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove ' + p);
      x.textContent = '×';
      x.addEventListener('click', () => {
        state.config.extraPaths.splice(i, 1);
        renderChips();
        saveSoon();
      });
      chip.appendChild(x);
      frag.appendChild(chip);
    });
    wrap.replaceChildren(frag);
  }

  function addPath() {
    const input = $('#pathInput');
    const p = normalizePath(input.value);
    if (!p) { toast('Enter a path such as /pages/contact-us', 'warn'); return; }
    if (!state.config.extraPaths.includes(p)) state.config.extraPaths.push(p);
    input.value = '';
    renderChips();
    saveSoon();
  }

  function syncProxyUI() {
    $('#proxySelect').value = state.config.proxy;
    $('#customProxy').value = state.config.customProxy;
    $('#customProxy').classList.toggle('hidden', state.config.proxy !== 'custom');
  }

  /* ------------------------------------------------------------------ *
   *  File import, copy, CSV
   * ------------------------------------------------------------------ */
  function collectStrings(value, out) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  }

  function extractUrlsFromFile(name, text) {
    let tokens = [];
    if (/\.json$/i.test(name)) {
      try {
        const strings = [];
        collectStrings(JSON.parse(text), strings);
        tokens = strings.flatMap((s) => s.split(/[\s,;]+/));
      } catch (_) { tokens = text.split(/[\s,;"']+/); }
    } else {
      tokens = text.split(/[\s,;"']+/);
    }
    return tokens.filter((t) => t && !t.includes('@') && /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#].*)?$/i.test(t));
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('That file is over 5 MB. Split it and import in parts.', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const urls = extractUrlsFromFile(file.name, String(reader.result));
      if (!urls.length) { toast('No URLs found in that file.', 'warn'); return; }
      const ta = $('#targets');
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + urls.join('\n');
      updateQueued();
      saveSoon();
      toast(`Imported ${urls.length} URL${urls.length === 1 ? '' : 's'}.`);
    };
    reader.onerror = () => toast('Could not read that file.', 'bad');
    reader.readAsText(file);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;    // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv() {
    const rows = visibleRows();
    if (!rows.length) { toast('Nothing to export yet.', 'warn'); return; }
    const head = ['store_domain', 'email', 'mailbox', 'email_domain', 'mx_verified', 'confidence', 'found_on'];
    const lines = [head.join(',')].concat(rows.map((r) =>
      [r.store, r.email, r.mailbox, r.emailDomain, r.mx === 'yes' ? 'yes' : r.mx, r.confidence, r.source].map(csvCell).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `smartify-emails-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
  }

  /* ------------------------------------------------------------------ *
   *  Init
   * ------------------------------------------------------------------ */
  function init() {
    load();

    $('#optDeep').checked = !!state.config.deep;
    $('#optVerified').checked = !!state.config.verifiedOnly;
    $('#optOwner').checked = !!state.config.ownerOnly;
    $('#viewVerified').checked = state.viewVerifiedOnly;
    if (!(state.config.proxy in { ...PROXIES, custom: 1, none: 1 })) state.config.proxy = 'allorigins';
    renderChips();
    syncProxyUI();

    $('#optDeep').addEventListener('change', (e) => { state.config.deep = e.target.checked; saveSoon(); });
    $('#optVerified').addEventListener('change', (e) => { state.config.verifiedOnly = e.target.checked; saveSoon(); });
    $('#optOwner').addEventListener('change', (e) => { state.config.ownerOnly = e.target.checked; saveSoon(); });

    $('#addPath').addEventListener('click', addPath);
    $('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPath(); } });

    $('#proxySelect').addEventListener('change', (e) => { state.config.proxy = e.target.value; syncProxyUI(); saveSoon(); });
    $('#customProxy').addEventListener('input', (e) => { state.config.customProxy = e.target.value; saveSoon(); });

    $('#targets').addEventListener('input', () => { updateQueuedSoon(); saveSoon(); });
    $('#targets').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    $('#runBtn').addEventListener('click', run);

    $('#clearBtn').addEventListener('click', () => {
      const hasData = $('#targets').value.trim() || state.rows.length || Object.keys(state.done).length;
      if (!hasData) return;
      if (!window.confirm('Clear the URL list and all results?')) return;
      stop();
      $('#targets').value = '';
      state.rows = [];
      state.done = {};
      state.total = 0;
      state.queuedCount = 0;
      setStatus('idle');
      paintNow();
      save();
    });

    $('#fileBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });

    $('#viewVerified').addEventListener('change', (e) => {
      state.viewVerifiedOnly = e.target.checked;
      renderTable();
      saveSoon();
    });

    $('#copyBtn').addEventListener('click', async () => {
      const emails = [...new Set(visibleRows().map((r) => r.email))];
      if (!emails.length) { toast('Nothing to copy yet.', 'warn'); return; }
      const ok = await copyText(emails.join('\n'));
      toast(ok ? `Copied ${emails.length} address${emails.length === 1 ? '' : 'es'}.` : 'Copy failed. Use CSV instead.', ok ? '' : 'bad');
    });

    $('#csvBtn').addEventListener('click', downloadCsv);

    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

    // A run that was interrupted by closing the tab shows as stopped and can be resumed
    const unfinished = state.total > 0 && Object.keys(state.done).length < state.total;
    setStatus(unfinished ? 'stopped' : Object.keys(state.done).length ? 'done' : 'idle');
    updateQueued();
    paintNow();
  }

  init();
})();
