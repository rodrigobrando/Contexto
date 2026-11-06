// Limpeza de conteúdo SEM LLM: remove anúncios, menus, newsletters, "leia também" etc.
// Etapas: (1) remover nós de lixo por tag/classe/id, (2) Readability extrai o corpo do artigo,
// (3) filtro linha a linha remove restos de boilerplate. O LLM só recebe o texto já limpo.
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const JUNK_TAGS = 'script,style,noscript,iframe,form,nav,footer,aside,svg,canvas,dialog,button,ins,template';

const JUNK_TOKENS = [
  'ad', 'ads', 'adv', 'advert', 'advertisement', 'advertising', 'adslot', 'adunit', 'sponsor', 'sponsored', 'sponsors',
  'promo', 'promoted', 'newsletter', 'subscribe', 'subscription', 'paywall', 'cookie', 'cookies', 'consent', 'gdpr',
  'banner', 'popup', 'modal', 'overlay', 'outbrain', 'taboola', 'recommended', 'related', 'trending', 'widget',
  'share', 'sharing', 'social', 'comments', 'comment', 'breadcrumb', 'sidebar', 'publicidade', 'patrocinado',
  'anuncio', 'anúncio', 'taboola', 'dfp', 'gpt',
];
const JUNK_RE = new RegExp(`(^|[-_\\s])(${JUNK_TOKENS.join('|')})($|[-_\\s\\d])`, 'i');

const JUNK_LINE_RE = new RegExp(
  [
    '^(advertisement|advertising|publicidade|anúncio|sponsored( content)?|conteúdo patrocinado|paid content)$',
    '^(read more|leia mais|leia também|veja também|saiba mais|related( articles| stories)?|you may also like|more from|recommended)\\b',
    '^(sign up|subscribe|inscreva-se|assine|newsletter|follow us|siga-nos|siga o|share (this|on)|compartilhe|compartilhar|tweet|copy link)',
    '^(click here|clique aqui|download the app|baixe o app)',
    '^(this (article|story) (was|is) (originally )?(published|sponsored)|copyright|©|all rights reserved|todos os direitos)',
    '^(accept (all )?cookies|we use cookies|usamos cookies|utilizamos cookies)',
    '^(photo|image|foto|imagem|credit|crédito|getty images|reuters|ap photo)\\s*[:/]',
    '^(advertisement\\s*[-–]\\s*)?continue reading',
    '^(story continues|the .* is a trusted|support (our|independent) journalism)',
  ].join('|'),
  'i'
);

function silentDom(html, url) {
  const vc = new VirtualConsole(); // evita ruído de CSS/JS inválido no console
  return new JSDOM(html, { url, virtualConsole: vc });
}

function stripJunk(doc, aggressive = true) {
  doc.querySelectorAll(JUNK_TAGS).forEach((n) => n.remove());
  if (!aggressive) return; // passada leve: só tags, o Readability decide o resto
  doc.querySelectorAll('[class],[id],[role],[aria-label]').forEach((n) => {
    if (n.tagName === 'BODY' || n.tagName === 'HTML' || n.tagName === 'ARTICLE' || n.tagName === 'MAIN') return;
    const role = n.getAttribute('role') || '';
    const hay = `${n.getAttribute('class') || ''} ${n.id || ''}`;
    if (/^(banner|complementary|navigation|contentinfo|search|dialog|alertdialog)$/.test(role) || JUNK_RE.test(hay)) {
      // não remove containers enormes que provavelmente envolvem o artigo
      if ((n.textContent || '').length > 20000) return;
      n.remove();
    }
  });
}

function cleanLines(text) {
  const seen = new Set();
  const out = [];
  for (let raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (JUNK_LINE_RE.test(line)) continue;
    // linhas muito curtas sem pontuação costumam ser menu/legenda/rótulo
    if (line.length < 25 && !/[.!?…:"”]$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join('\n\n');
}

function toIsoDate(v) {
  if (!v) return null;
  const d = new Date(String(v).trim());
  const y = d.getFullYear();
  return isNaN(d) || y < 1990 || d.getTime() > Date.now() + 864e5 ? null : d.toISOString();
}

// meta tags -> JSON-LD (datePublished) -> <time datetime>. Deve rodar ANTES de remover scripts.
function findPublishedDate(doc) {
  const metas = ['meta[property="article:published_time"]', 'meta[property="og:article:published_time"]',
    'meta[itemprop="datePublished"]', 'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="date"]',
    'meta[name="DC.date.issued"]', 'meta[name="parsely-pub-date"]', 'meta[name="sailthru.date"]'];
  for (const sel of metas) {
    const d = toIsoDate(doc.querySelector(sel)?.getAttribute('content'));
    if (d) return d;
  }
  for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const stack = [JSON.parse(sc.textContent)];
      while (stack.length) {
        const n = stack.pop();
        if (Array.isArray(n)) stack.push(...n);
        else if (n && typeof n === 'object') {
          const d = toIsoDate(n.datePublished);
          if (d) return d;
          stack.push(...Object.values(n).filter((v) => v && typeof v === 'object'));
        }
      }
    } catch { /* JSON-LD inválido */ }
  }
  for (const t of doc.querySelectorAll('time[datetime]')) {
    const d = toIsoDate(t.getAttribute('datetime'));
    if (d) return d;
  }
  return null;
}

function extractOnce(html, url, aggressive) {
  const dom = silentDom(html, url);
  const doc = dom.window.document;
  const image =
    doc.querySelector('meta[property="og:image"]')?.content ||
    doc.querySelector('meta[name="twitter:image"]')?.content ||
    null;
  const published = findPublishedDate(doc);

  stripJunk(doc, aggressive);
  const parsed = new Readability(doc, { charThreshold: 300, keepClasses: false }).parse();
  dom.window.close();
  if (!parsed) return null;

  // converte o HTML do Readability em texto com parágrafos
  const inner = silentDom(`<body>${parsed.content}</body>`, url);
  const body = inner.window.document.body;
  body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,div,tr').forEach((n) => n.append('\n'));
  const text = cleanLines(body.textContent || '');
  inner.window.close();

  return { title: parsed.title, text, image, byline: parsed.byline, published };
}

/** Recebe HTML bruto da página e devolve { title, text, image, byline } limpos.
 *  Passada agressiva (remove blocos com cara de anúncio); se sobrar pouco texto,
 *  tenta a passada leve, porque alguns sites usam classes como "share" no corpo do artigo. */
function extractArticle(html, url) {
  const strong = extractOnce(html, url, true);
  if (strong && strong.text.length >= 800) return strong;
  const light = extractOnce(html, url, false);
  const best = [strong, light].filter(Boolean).sort((a, b) => b.text.length - a.text.length)[0] || null;
  if (best && !best.published) best.published = strong?.published || light?.published || null;
  return best;
}

/** Texto limpo a partir de um trecho HTML (ex.: content:encoded do RSS). */
function htmlToCleanText(html, url) {
  const dom = silentDom(`<body>${html}</body>`, url);
  const doc = dom.window.document;
  stripJunk(doc);
  doc.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,div').forEach((n) => n.append('\n'));
  const text = cleanLines(doc.body.textContent || '');
  dom.window.close();
  return text;
}

module.exports = { extractArticle, htmlToCleanText, cleanLines };
