// Tela "Início": feed de resumos por grupo de fontes.
// Cartão-índice no topo (período + uma linha por grupo) e um cartão grande por grupo.
// Os resumos são gerados pelo LLM: automaticamente só para grupos com notícias não lidas, ou ao clicar no botão.
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function periodsNow() {
  const now = new Date();
  const weekStart = new Date(periodStart('week')); // segunda-feira, igual aos filtros
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const f = (d, o) => d.toLocaleDateString('pt-BR', o);
  return [
    { id: 'day', period: 'today', key: 'day:' + localKey(now), since: periodStart('today'), title: 'Hoje',
      sub: f(now, { weekday: 'long', day: 'numeric', month: 'long' }), label: 'o dia de hoje' },
    { id: 'week', period: 'week', key: 'week:' + localKey(weekStart), since: periodStart('week'), title: 'Esta semana',
      sub: `${f(weekStart, { day: 'numeric', month: 'long' })} a ${f(weekEnd, { day: 'numeric', month: 'long' })}`, label: 'a semana atual (segunda a domingo)' },
  ];
}

// ---------- navegação ----------
function showHome() {
  state.home = true; state.sourceId = null; state.groupId = null;
  document.body.classList.add('home-mode');
  guard(async () => { await loadSources(); await loadHome(); })();
}

async function openFromHome(id) {
  leaveViews();
  await refreshAll();
  await openArticle(id);
}

// abre a lista de um grupo (ou das fontes sem grupo) já filtrada pelo período
function openGroupList(g, per, { unread = false } = {}) {
  state.period = per.period; state.unread = unread; state.translation = null;
  syncChips();
  selectGroup(g.id);
}

// ---------- utilidades ----------
const fmtClock = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function relTime(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} d`;
}
const plural2 = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function icon(paths, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
}
const ICONS = {
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  open: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};
function avatar(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const a = el('span', { className: 'avatar', textContent: (name.trim()[0] || '?').toUpperCase() });
  a.setAttribute('aria-hidden', 'true');
  a.style.setProperty('background', `linear-gradient(135deg, hsl(${h} 75% 52%), hsl(${(h + 50) % 360} 80% 38%))`);
  return a;
}

// Texto de abertura e tópicos de um resumo (usado no resumo de grupo da lista).
function digestBlocks(dg) {
  const frag = document.createDocumentFragment();
  if (dg.overview) frag.append(el('p', { className: 'lead', textContent: dg.overview }));
  const topics = el('div', { className: 'topics' });
  for (const t of dg.topics) {
    const refs = el('div', { className: 'refs' });
    for (const a of t.articles) {
      const r = el('button', { className: 'ref', textContent: a.title, title: `${a.source}: ${a.title}` });
      r.onclick = () => openFromHome(a.id);
      refs.append(r);
    }
    topics.append(el('div', { className: 'topic' }, el('h3', { textContent: t.title }), el('p', { textContent: t.summary }), refs));
  }
  frag.append(topics);
  return frag;
}

// ---------- popover das matérias citadas ----------
let pop = null, popAnchor = null;
function closePop(restoreFocus = false) {
  pop?.remove();
  popAnchor?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) popAnchor?.focus();
  pop = null; popAnchor = null;
}
document.addEventListener('click', (e) => { if (pop && !pop.contains(e.target) && !popAnchor?.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) closePop(true); });
$('home').addEventListener('scroll', () => closePop(), { passive: true });
addEventListener('resize', () => closePop());

function openPopover(anchor, title, items) {
  if (pop && popAnchor === anchor) { closePop(); return; } // segundo clique no mesmo ícone fecha
  closePop();
  popAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  const list = el('ul', { className: 'pop-list' });
  for (const a of items) {
    const b = el('button', { className: 'pop-item', title: a.title }, el('span', { className: 'pop-title', textContent: a.title }), el('span', { className: 'pop-src', textContent: a.source }));
    b.onclick = () => { closePop(); openFromHome(a.id); };
    list.append(el('li', {}, b));
  }
  pop = el('div', { className: 'pop', role: 'dialog', ariaLabel: `Matérias citadas em ${title}` },
    el('div', { className: 'pop-head', textContent: `Matérias citadas (${items.length})` }), list);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(), w = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - w.width, innerWidth - w.width - 8))}px`; // alinha à direita do ícone
  pop.style.top = `${r.bottom + 8 + w.height > innerHeight ? Math.max(8, r.top - w.height - 8) : r.bottom + 8}px`;
  pop.querySelector('.pop-item')?.focus();
}

// botão de ícone + número (matérias citadas, não lidas...)
function countButton(className, paths, n, { label, title }) {
  const b = el('button', { className, title, ariaLabel: label });
  b.innerHTML = icon(paths);
  b.append(el('span', { className: 'cnt', textContent: n }));
  return b;
}

// ---------- estado do feed ----------
function loadHomeTab() { try { return localStorage.getItem('homeTab') === 'week' ? 'week' : 'day'; } catch { return 'day'; } }
function saveHomeTab(id) { try { localStorage.setItem('homeTab', id); } catch { /* sem armazenamento: segue sem lembrar */ } }
let homeTab = loadHomeTab();
let homeView = null;              // { periods, data, groups }
const feedUi = { indexExpanded: false, topicsExpanded: new Set() };

const headlineOf = (g) => g.digest?.headline || g.digest?.topics?.[0]?.title || g.name;
const citedOf = (dg) => {         // todas as matérias citadas no resumo, sem repetir
  const seen = new Map();
  for (const t of dg.topics) for (const a of t.articles) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()];
};
const isStale = (g) => g.n > 0 && (!g.digest || g.n > g.digest.article_count);

// ---------- cartão-índice (topo do feed) ----------
function openChoiceMenu(anchor, items) {
  closeMenu();
  const menu = el('div', { id: 'ctx-menu', className: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    const b = el('button', { className: 'ctx-item', role: 'menuitem' }, el('span', { textContent: it.label }), it.checked ? el('span', { textContent: '✓' }) : '');
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.onPick(); };
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.querySelector('.ctx-item')?.focus();
}

function renderIndex(per, idx) {
  const { periods, data, groups } = homeView;
  const card = el('section', { className: 'icard' });

  const sel = el('button', { className: 'period-sel', ariaLabel: 'Trocar período' }, el('strong', { textContent: per.title }), el('span', { className: 'caret', textContent: '⌄' }));
  sel.setAttribute('aria-haspopup', 'menu');
  sel.onclick = (e) => {
    e.stopPropagation();
    openChoiceMenu(sel, periods.map((p, i) => ({ label: `${p.title} (${plural2(data[i].n, 'notícia', 'notícias')})`, checked: p.id === per.id,
      onPick: async () => { homeTab = p.id; saveHomeTab(p.id); feedUi.indexExpanded = false; await reloadGroups(); } })));
  };
  const head = el('div', { className: 'icard-head' }, el('div', { className: 'icard-when' }, sel, el('span', { className: 'icard-sub', textContent: per.sub })));

  const missing = groups.filter(isStale).length;
  const unreadAll = data[idx].unread_total;
  const actions = el('div', { className: 'icard-actions' });
  if (unreadAll) {
    const u = countButton('fbtn amber', ICONS.mail, unreadAll, { label: `${unreadAll} não lidas`, title: 'Ver todas as notícias não lidas' });
    u.append(' não lidas');
    u.onclick = () => { state.period = null; state.unread = true; state.translation = null; syncChips(); selectSource(null); };
    actions.append(u);
  }
  const all = el('button', { className: 'fbtn' + (missing ? ' glow' : ''), disabled: !missing,
    title: missing ? 'Gera de uma vez os resumos que faltam ou ficaram para trás' : 'Todos os resumos estão em dia' });
  all.innerHTML = icon(ICONS.spark);
  all.append(el('span', { textContent: missing ? `Gerar ${missing}` : 'Em dia' }));
  all.onclick = guard(async () => {
    setBusy(all, true);
    try {
      const r = await api.homeSummarizeAll({ since: per.since, filterKey: filterKeyOf({ period: per.period }), label: filterLabelOf({ period: per.period }) });
      toast(`${plural2(r.done, 'resumo gerado', 'resumos gerados')}` + (r.failed ? `, ${r.failed} com falha` : ''), r.failed > 0);
      await reloadGroups();
    } finally { endProgress(); }
  });
  actions.append(all);
  head.append(actions);
  card.append(head);

  // uma linha por grupo com notícias no período: hora do resumo, manchete e não lidas
  const withNews = groups.filter((g) => g.n > 0);
  const shown = feedUi.indexExpanded ? withNews : withNews.slice(0, 4);
  const list = el('div', { className: 'ilist' });
  for (const g of shown) {
    const dg = g.digest;
    const row = el('button', { className: 'irow' },
      el('span', { className: 'itime', textContent: dg ? fmtClock(dg.generated_at) : '--:--' }),
      el('span', { className: 'itext' },
        el('span', { className: 'ititle' + (dg ? '' : ' muted'), textContent: dg ? headlineOf(g) : 'Sem resumo ainda' }),
        el('span', { className: 'igroup', textContent: g.name })));
    if (g.unread) {
      const u = el('span', { className: 'iunread', title: plural2(g.unread, 'notícia não lida', 'notícias não lidas') });
      u.innerHTML = icon(ICONS.mail, 14);
      u.append(el('span', { textContent: g.unread }));
      row.append(u);
    }
    row.onclick = () => document.getElementById(`fc-${g.id}`)?.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    list.append(row);
  }
  if (!withNews.length) list.append(el('p', { className: 'empty-note', textContent: 'Nenhuma notícia neste período. Use "Atualizar tudo" na barra lateral.' }));
  card.append(list);
  if (withNews.length > 4) {
    const more = el('button', { className: 'more-link', textContent: feedUi.indexExpanded ? 'Mostrar menos ↑' : `Mostrar mais ${withNews.length - 4} →` });
    more.onclick = () => { feedUi.indexExpanded = !feedUi.indexExpanded; paintFeed(); };
    card.append(more);
  }
  return card;
}

// ---------- cartão de um grupo ----------
function renderFeedCard(g, per) {
  const dg = g.digest;
  const card = el('article', { className: 'fcard', id: `fc-${g.id}` });
  const filterKey = filterKeyOf({ period: per.period });

  // cabeçalho: avatar, nome do grupo, quando o resumo foi gerado
  const meta = el('div', { className: 'fmeta' }, el('strong', { textContent: g.name }));
  if (dg) meta.append(el('span', { className: 'ftime', textContent: relTime(dg.generated_at), title: `Resumo gerado às ${fmtClock(dg.generated_at)}` }));
  const head = el('div', { className: 'fhead' }, avatar(g.name), meta);
  if (dg && g.n > dg.article_count) head.append(el('span', { className: 'fnew', textContent: `+${g.n - dg.article_count} novas` }));
  card.append(head);

  const body = el('div', { className: 'fbody' });
  const cited = dg ? citedOf(dg) : [];

  if (dg) {
    body.append(el('h2', { className: 'ftitle', textContent: headlineOf(g) }));
    if (dg.overview) body.append(el('p', { className: 'fexcerpt', textContent: dg.overview }));

    const cover = cited.find((a) => a.image);
    if (cover) {
      const img = el('img', { src: cover.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
      const fig = el('figure', { className: 'fcover', title: cover.title }, img, el('figcaption', {}, el('span', { textContent: cover.source })));
      img.onerror = () => fig.remove();
      fig.onclick = () => openFromHome(cover.id);
      body.append(fig);
    }

    // tópicos como linhas compactas, cada uma com o ícone das matérias citadas
    const expanded = feedUi.topicsExpanded.has(String(g.id));
    const topics = el('div', { className: 'ftopics' });
    for (const t of expanded ? dg.topics : dg.topics.slice(0, 3)) {
      const row = el('div', { className: 'trow' }, el('div', { className: 'ttext' }, el('h3', { textContent: t.title }), el('p', { textContent: t.summary })));
      if (t.articles.length) {
        const b = countButton('pop-btn', ICONS.list, t.articles.length, { label: `Ver as ${t.articles.length} matérias citadas em ${t.title}`, title: plural2(t.articles.length, 'matéria citada', 'matérias citadas') });
        b.setAttribute('aria-haspopup', 'dialog');
        b.onclick = (e) => { e.stopPropagation(); openPopover(b, t.title, t.articles); };
        row.append(b);
      }
      topics.append(row);
    }
    body.append(topics);
    if (dg.topics.length > 3) {
      const more = el('button', { className: 'more-link', textContent: expanded ? 'Mostrar menos ↑' : `Mostrar mais ${dg.topics.length - 3} →` });
      more.onclick = () => { expanded ? feedUi.topicsExpanded.delete(String(g.id)) : feedUi.topicsExpanded.add(String(g.id)); paintFeed(); };
      body.append(more);
    }
  } else {
    body.append(el('p', { className: 'fexcerpt muted', textContent: `${plural2(g.n, 'notícia', 'notícias')} neste período${g.unread ? `, ${g.unread} não lidas` : ''}. Gere o resumo para ver o panorama do grupo.` }));
  }
  card.append(body);

  // barra de ações (como a do feed de referência)
  const bar = el('div', { className: 'fbar' });
  if (dg && cited.length) {
    const b = countButton('fbtn', ICONS.list, cited.length, { label: `Ver as ${cited.length} matérias citadas no resumo`, title: 'Matérias citadas no resumo' });
    b.setAttribute('aria-haspopup', 'dialog');
    b.onclick = (e) => { e.stopPropagation(); openPopover(b, g.name, cited); };
    bar.append(b);
  }
  const unread = g.unread ? countButton('fbtn amber', ICONS.mail, g.unread, { label: `${g.unread} notícias não lidas`, title: 'Ver as não lidas deste grupo' }) : null;
  if (unread) unread.onclick = () => openGroupList(g, per, { unread: true });
  const open = el('button', { className: 'fbtn', title: 'Ver todas as notícias do grupo no período' });
  open.innerHTML = icon(ICONS.open);
  open.append(el('span', { textContent: 'Ver notícias' }));
  open.onclick = () => openGroupList(g, per);
  if (unread) bar.append(unread);
  bar.append(open, el('span', { className: 'fspace' }),
    el('span', { className: 'fcount', textContent: `${plural2(g.n, 'notícia', 'notícias')} de ${plural2(g.sources, 'fonte', 'fontes')}` }));

  const gen = el('button', { className: 'fbtn' + (dg ? '' : ' glow'), title: dg ? 'Gerar o resumo de novo com as notícias atuais' : 'Gerar o resumo deste grupo' });
  gen.innerHTML = icon(dg ? ICONS.refresh : ICONS.spark);
  gen.append(el('span', { textContent: dg ? 'Atualizar' : 'Gerar resumo' }));
  gen.onclick = guard(async () => {
    setBusy(gen, true);
    card.classList.add('loading');
    body.before(el('div', { className: 'skeleton', ariaLabel: 'Gerando resumo' }, el('i'), el('i'), el('i'), el('i')));
    try { await api.groupSummarize({ groupId: g.id, filter: { since: per.since }, filterKey, label: filterLabelOf({ period: per.period }) }); await reloadGroups(); }
    finally { setBusy(gen, false); card.classList.remove('loading'); card.querySelector('.skeleton')?.remove(); endProgress(); }
  });
  bar.append(gen);
  card.append(bar);
  return card;
}

// ---------- montagem ----------
function paintFeed() {
  const { periods, groups } = homeView;
  const idx = Math.max(0, periods.findIndex((p) => p.id === homeTab));
  const per = periods[idx];
  closePop();
  const feed = $('home-feed');
  const cards = groups.filter((g) => g.n > 0).map((g) => renderFeedCard(g, per));
  feed.replaceChildren(renderIndex(per, idx), ...cards,
    ...(groups.length ? [] : [el('p', { className: 'empty-note', textContent: 'Nenhuma fonte ainda. Adicione um site na barra lateral.' })]));
}

async function reloadGroups() {
  const per = homeView.periods.find((p) => p.id === homeTab) || homeView.periods[0];
  homeView.groups = await api.homeGroups({ since: per.since, filterKey: filterKeyOf({ period: per.period }) });
  paintFeed();
}

async function loadHome() {
  const periods = periodsNow();
  const per = periods.find((p) => p.id === homeTab) || periods[0];
  const [data, groups] = await Promise.all([
    api.homeGet(periods.map(({ id, key, since }) => ({ id, key, since }))),
    api.homeGroups({ since: per.since, filterKey: filterKeyOf({ period: per.period }) }),
  ]);
  homeView = { periods, data, groups };
  $('home-body').replaceChildren(el('div', { id: 'home-feed', className: 'feed' }));
  paintFeed();
}

// Resumos automáticos: depois de atualizar as fontes, gera só os grupos com notícias NÃO LIDAS no período
// escolhido (e só se o resumo faltar ou estiver defasado). Sem chave ou com a opção desligada, não faz nada.
let autoBusy = false;
async function autoSummarizeHome() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    const periods = periodsNow(), per = periods.find((p) => p.id === homeTab) || periods[0];
    const r = await api.homeSummarizeAll({ since: per.since, filterKey: filterKeyOf({ period: per.period }), label: filterLabelOf({ period: per.period }), auto: true });
    if (r.done) toast(`${plural2(r.done, 'resumo gerado', 'resumos gerados')} automaticamente`);
    if (r.done && state.home) await loadHome();
  } catch { /* automático e silencioso: a chave pode não estar configurada */ }
  finally { autoBusy = false; endProgress(); }
}

guard(loadHome)();
