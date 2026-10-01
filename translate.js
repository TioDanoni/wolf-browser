// Tradução de páginas no lugar: os textos da página são lidos num "mundo isolado"
// (o site não enxerga nem interfere), traduzidos pelo processo principal e devolvidos.
// Funciona em páginas com login, sem recarregar, e respeita o CSP dos sites.

const WORLD_ID = 1717;
const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const MAX_CHARS = 3500; // por requisição
const MAX_ITEMS = 100;
const PARALLEL = 4;

// Coleta os textos ainda não vistos. Os da parte visível da tela vêm primeiro.
const COLLECT = `(() => {
  const s = window.__wolfTr || (window.__wolfTr = {
    nodes: [], originals: [], translated: [], seen: new WeakSet(), pending: [], observer: null,
  });
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'SVG', 'MATH', 'KBD', 'SAMP', 'VAR', 'TEMPLATE', 'IFRAME', 'CANVAS']);
  const skip = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (SKIP.has(p.tagName) || p.isContentEditable || p.getAttribute('translate') === 'no'
        || p.classList.contains('notranslate')) return true;
    }
    return false;
  };
  const found = [];
  const scan = (root) => {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (s.seen.has(n)) continue;
      s.seen.add(n);
      const text = n.nodeValue;
      if (!text || !/\\p{L}/u.test(text) || !n.parentElement || skip(n.parentElement)) continue;
      found.push(n);
    }
  };
  scan(document.body);
  for (const root of s.pending.splice(0)) if (root.isConnected) scan(root);
  // Conteúdo que aparece depois (rolagem infinita, menus...) fica guardado para a próxima coleta.
  if (!s.observer) {
    s.observer = new MutationObserver((records) => {
      for (const r of records) for (const node of r.addedNodes) {
        s.pending.push(node.nodeType === 3 ? node.parentNode : node);
      }
    });
    s.observer.observe(document.body, { childList: true, subtree: true });
  }
  const vh = innerHeight;
  const out = found.map((n) => {
    const id = s.nodes.push(n) - 1;
    s.originals[id] = n.nodeValue;
    const r = n.parentElement.getBoundingClientRect();
    return [id, n.nodeValue, r.bottom > 0 && r.top < vh ? 0 : 1];
  });
  return { items: out, lang: document.documentElement.lang || '' };
})()`;

const applyScript = (pairs) => `(() => {
  const s = window.__wolfTr;
  if (!s) return;
  for (const [id, text] of ${JSON.stringify(pairs)}) {
    const n = s.nodes[id];
    if (!n) continue;
    s.translated[id] = text;
    if (!s.showOriginal) n.nodeValue = text;
  }
})()`;

const SHOW_SCRIPT = (original) => `(() => {
  const s = window.__wolfTr;
  if (!s) return;
  s.showOriginal = ${original};
  const source = ${original} ? s.originals : s.translated;
  s.nodes.forEach((n, id) => { if (source[id] !== undefined && n.isConnected) n.nodeValue = source[id]; });
})()`;

const STOP_SCRIPT = `(() => {
  const s = window.__wolfTr;
  if (!s) return;
  s.observer?.disconnect();
  s.nodes.forEach((n, id) => { if (s.originals[id] !== undefined && n.isConnected) n.nodeValue = s.originals[id]; });
  delete window.__wolfTr;
})()`;

async function requestBatch(texts, lang) {
  const body = new URLSearchParams();
  for (const t of texts) body.append('q', t);
  const res = await fetch(`${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dj=1`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  });
  if (!res.ok) throw new Error(`o tradutor respondeu ${res.status}`);
  const data = await res.json();
  // Com idioma automático cada item vem como [tradução, idioma de origem].
  return data.map((item) => (Array.isArray(item) ? { text: item[0], lang: item[1] } : { text: item, lang: null }));
}

// Mantém os espaços do começo e do fim do texto original.
function withSpacing(original, translated) {
  const lead = original.match(/^\s*/)[0];
  const trail = original.match(/\s*$/)[0];
  return lead + translated.trim() + trail;
}

function makeBatches(items) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const len = item.text.length;
    if (current.length && (size + len > MAX_CHARS || current.length >= MAX_ITEMS)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Traduz os textos novos da página e aplica cada lote assim que chega.
async function translatePass(wc, job) {
  const { items, lang: pageLang } = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: COLLECT }]);
  // Idioma declarado pela página (<html lang="en">) é o mais confiável.
  if (pageLang && !job.pageLang) {
    job.pageLang = pageLang.split('-')[0].toLowerCase();
    job.sourceLang = job.pageLang;
  }
  if (!items.length || job.cancelled) return 0;

  // Textos repetidos (menus, botões) são traduzidos uma vez só.
  const unique = new Map();
  for (const [id, raw, offscreen] of items.sort((a, b) => a[2] - b[2])) {
    const text = raw.trim();
    const cached = job.cache.get(text);
    if (cached !== undefined) {
      job.ready.push([id, withSpacing(raw, cached)]);
      continue;
    }
    if (!unique.has(text)) unique.set(text, { text, targets: [] });
    unique.get(text).targets.push([id, raw]);
  }
  if (job.ready.length) {
    await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: applyScript(job.ready.splice(0)) }]);
  }

  const queue = makeBatches([...unique.values()]);
  const worker = async () => {
    while (queue.length && !job.cancelled && !wc.isDestroyed()) {
      const batch = queue.shift();
      const results = await requestBatch(batch.map((b) => b.text), job.lang);
      const pairs = [];
      batch.forEach((entry, i) => {
        const result = results[i];
        if (!result) return;
        // Sem idioma declarado: vale o idioma da maior parte do texto (trechos curtos enganam).
        if (result.lang && !job.pageLang) {
          job.votes.set(result.lang, (job.votes.get(result.lang) || 0) + entry.text.length);
          job.sourceLang = [...job.votes].sort((a, b) => b[1] - a[1])[0][0];
        }
        job.cache.set(entry.text, result.text);
        for (const [id, raw] of entry.targets) pairs.push([id, withSpacing(raw, result.text)]);
      });
      if (!job.cancelled && !wc.isDestroyed()) {
        await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: applyScript(pairs) }]);
      }
      job.onProgress?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  return items.length;
}

/**
 * Começa a traduzir a página. Retorna um "job" que continua traduzindo o conteúdo
 * que aparecer depois, até `stop()`.
 */
function startTranslation(wc, lang, { onProgress, onError } = {}) {
  const job = {
    lang,
    sourceLang: null,
    pageLang: null,
    votes: new Map(),
    cache: new Map(),
    ready: [],
    cancelled: false,
    busy: false,
    showingOriginal: false,
    onProgress,
    timer: null,
  };
  const run = async () => {
    if (job.busy || job.cancelled || wc.isDestroyed()) return;
    job.busy = true;
    try {
      await translatePass(wc, job);
    } catch (err) {
      onError?.(err);
    } finally {
      job.busy = false;
    }
  };
  job.done = run();
  job.timer = setInterval(run, 1500); // pega o conteúdo novo
  job.stop = () => {
    job.cancelled = true;
    clearInterval(job.timer);
    if (!wc.isDestroyed()) wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: STOP_SCRIPT }]).catch(() => {});
  };
  // Página trocou: a tradução acabou (os nós antigos não existem mais).
  job.cancel = () => {
    job.cancelled = true;
    clearInterval(job.timer);
  };
  job.showOriginal = async (original) => {
    job.showingOriginal = original;
    clearInterval(job.timer);
    if (!original) job.timer = setInterval(run, 1500);
    if (!wc.isDestroyed()) await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: SHOW_SCRIPT(original) }]);
  };
  return job;
}

module.exports = { startTranslation };
