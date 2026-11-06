const Parser = require('rss-parser');
const { JSDOM, VirtualConsole } = require('jsdom');
const { q } = require('./db');
const { extractArticle, htmlToCleanText } = require('./cleaner');

const UA = 'Mozilla/5.0 (compatible; Contexto/1.0)';
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': UA }, customFields: { item: [['media:content', 'media'], ['content:encoded', 'encoded']] } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espaça as requisições por host (padrão: 1 a cada 1,2s) para não acionar rate limit.
const lastHit = new Map();
async function throttle(url, minGapMs = 1200) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) || 0) + minGapMs - Date.now();
  lastHit.set(host, Date.now() + Math.max(wait, 0));
  if (wait > 0) await sleep(wait);
}

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} em ${url}`); this.status = status; }
}

// Respeita Retry-After e tenta de novo em 429/503 com backoff (máx. 3 tentativas).
async function getHtml(url, attempt = 0) {
  await throttle(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    const ra = Number(res.headers.get('retry-after'));
    const delay = Math.min((Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt), 30000);
    await sleep(delay);
    return getHtml(url, attempt + 1);
  }
  if (!res.ok) throw new HttpError(res.status, url);
  return { html: await res.text(), finalUrl: res.url };
}

function normalizeUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).toString();
}

function dom(html, url) {
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
}

/** Procura o feed RSS/Atom de um site: <link rel=alternate> e caminhos comuns. */
async function discoverFeed(siteUrl, html) {
  let links = [];
  if (html) {
    const d = dom(html, siteUrl);
    links = [...d.window.document.querySelectorAll('link[rel="alternate"]')]
      .filter((l) => /rss|atom|xml/i.test(l.type || ''))
      .map((l) => new URL(l.getAttribute('href'), siteUrl).toString());
    d.window.close();
  }
  // /categoria/ai -> /categoria/ai/feed (padrão WordPress), depois caminhos comuns na raiz
  const base = siteUrl.replace(/\/+$/, '');
  const common = [base + '/feed', ...['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].map((p) => new URL(p, siteUrl).toString())];
  for (const candidate of [...new Set([...links, ...common])]) {
    try {
      await throttle(candidate);
      const feed = await parser.parseURL(candidate);
      if (feed.items?.length) return { feedUrl: candidate, title: feed.title };
    } catch { /* tenta o próximo */ }
  }
  return null;
}

/** Fallback sem RSS: pega links da home que parecem manchetes de artigos. */
function scrapeHomepageLinks(html, siteUrl) {
  const d = dom(html, siteUrl);
  const origin = new URL(siteUrl).origin;
  const seen = new Map();
  d.window.document.querySelectorAll('a[href]').forEach((a) => {
    let href;
    try { href = new URL(a.getAttribute('href'), siteUrl); } catch { return; }
    if (href.origin !== origin || href.hash && href.pathname === '/') return;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const segments = href.pathname.split('/').filter(Boolean);
    const looksLikeArticle = segments.length >= 2 || /\d{4}|\w+-\w+-\w+/.test(href.pathname);
    if (text.length >= 25 && looksLikeArticle && !seen.has(href.origin + href.pathname)) {
      seen.set(href.origin + href.pathname, { url: href.origin + href.pathname, title: text });
    }
  });
  const title = d.window.document.title;
  d.window.close();
  return { items: [...seen.values()].slice(0, 40), title };
}

const BLOCK_MSG = (status) =>
  status === 429
    ? 'O site está limitando requisições (HTTP 429). Aguarde alguns minutos e tente de novo.'
    : `O site bloqueia acesso automatizado ou exige login (HTTP ${status}), comum em sites com paywall. ` +
      'Cadastre o endereço do feed RSS público do site (muitos publicam um, ex.: procure "RSS" no rodapé).';

async function addSource(input) {
  const url = normalizeUrl(input);

  // 1) a URL já é um feed RSS/Atom?
  try {
    await throttle(url);
    const feed = await parser.parseURL(url);
    if (feed.items?.length) {
      const home = feed.link || new URL(url).origin;
      const id = q.addSource(url, url, feed.title || new URL(url).hostname);
      return { id, usedFeed: true, home };
    }
  } catch { /* não é feed: segue como site */ }

  // 2) é um site: acha o feed ou varre a home
  let html = null, finalUrl = url;
  try {
    ({ html, finalUrl } = await getHtml(url));
  } catch (e) {
    if (!(e instanceof HttpError) || ![401, 403, 429, 503].includes(e.status)) throw e;
    var blocked = e.status;
  }
  const feed = await discoverFeed(finalUrl, html);
  if (!html && !feed) throw new Error(BLOCK_MSG(blocked));
  let siteTitle = new URL(finalUrl).hostname;
  if (html) {
    const d = dom(html, finalUrl);
    siteTitle = (d.window.document.querySelector('meta[property="og:site_name"]')?.content || d.window.document.title || siteTitle).trim();
    d.window.close();
  }
  const id = q.addSource(finalUrl, feed?.feedUrl ?? null, feed?.title || siteTitle);
  return { id, usedFeed: !!feed };
}

function toIso(v) {
  const t = v ? new Date(v) : null;
  return t && !isNaN(t) ? t.toISOString() : null;
}

/** Busca novos itens da fonte e baixa/limpa o conteúdo de cada um. */
async function refreshSource(sourceId, onProgress = () => {}) {
  const src = q.getSource(sourceId);
  if (!src) throw new Error('Fonte não encontrada');

  let items = [];
  if (src.feed_url) {
    const feed = await parser.parseURL(src.feed_url);
    items = feed.items.slice(0, 25).map((it) => ({
      url: it.link,
      title: it.title,
      published_at: toIso(it.isoDate || it.pubDate),
      image: it.enclosure?.url || it.media?.$?.url || null,
      inline: it.encoded || it['content:encoded'] || it.content || null,
    }));
  } else {
    const { html, finalUrl } = await getHtml(src.url);
    items = scrapeHomepageLinks(html, finalUrl).items.map((i) => ({ ...i, published_at: null, image: null, inline: null }));
  }

  const fresh = items.filter((i) => i.url && !q.hasArticle(i.url));
  let added = 0, rateLimited = false;
  for (const [i, it] of fresh.entries()) {
    onProgress({ stage: 'fetch', current: i + 1, total: fresh.length, title: it.title });
    let content = null, title = it.title, image = it.image, published = it.published_at;
    try {
      if (rateLimited) throw new Error('skip');
      const { html, finalUrl } = await getHtml(it.url);
      const art = extractArticle(html, finalUrl);
      if (art?.text && art.text.length > 300) {
        content = art.text;
        title = title || art.title;
        image = art.image || image;
        published = published || art.published;
      }
    } catch (e) {
      // continua usando o texto do feed; se o site insiste em 429, para de baixar páginas
      if (e instanceof HttpError && [401, 403, 429].includes(e.status)) rateLimited = true;
    }
    // paywall/bloqueio: cai para o texto que veio no próprio feed
    if (!content && it.inline) {
      const t = htmlToCleanText(it.inline, it.url);
      if (t.length > 100) content = t;
    }
    if (!title) continue;
    q.addArticle({ source_id: sourceId, url: it.url, title, image, published_at: published, content });
    added++;
  }
  // reprocessa artigos antigos que ficaram sem texto (ou só com boilerplate) em coletas anteriores
  const weak = rateLimited ? [] : q.weakArticles(sourceId);
  for (const [i, w] of weak.entries()) {
    onProgress({ stage: 'fetch', current: i + 1, total: weak.length, title: 'Reprocessando artigos' });
    try {
      const { html, finalUrl } = await getHtml(w.url);
      const art = extractArticle(html, finalUrl);
      if (w.weak_content && art?.text && art.text.length > 300) q.saveContent(w.id, art.text);
      if (w.no_date && art?.published) q.saveDate(w.id, art.published);
      q.bumpFixTries(w.id);
    } catch (e) {
      if (e instanceof HttpError && [401, 403, 429].includes(e.status)) break; // bloqueio: não gasta tentativa
      q.bumpFixTries(w.id);
    }
  }
  q.touchSource(sourceId);
  return { added, rateLimited };
}

/** Baixa de novo uma página e atualiza data (e texto, se o salvo era fraco). Retorna se achou a data. */
async function refreshArticle(id) {
  const a = q.getArticle(id);
  if (!a) throw new Error('Artigo não encontrado');
  const { html, finalUrl } = await getHtml(a.url);
  const art = extractArticle(html, finalUrl);
  if (art?.text && art.text.length > 300 && (!a.content || a.content.length <= 300)) q.saveContent(id, art.text);
  if (art?.published) q.saveDate(id, art.published);
  return { foundDate: !!art?.published };
}

/** Busca a data de todos os artigos sem data (da fonte, ou de todas). Para se o site bloquear. */
async function refreshMissingDates(sourceId, onProgress = () => {}) {
  const ids = q.noDateIds(sourceId);
  let found = 0, failed = 0, blocked = false;
  for (const [i, id] of ids.entries()) {
    onProgress({ stage: 'fetch', current: i + 1, total: ids.length, title: 'Buscando datas de publicação' });
    try {
      if ((await refreshArticle(id)).foundDate) found++;
    } catch (e) {
      failed++;
      if (e instanceof HttpError && [401, 403, 429].includes(e.status)) { blocked = true; break; }
    }
  }
  return { checked: ids.length, found, failed, blocked };
}

module.exports = { addSource, refreshSource, refreshArticle, refreshMissingDates };
