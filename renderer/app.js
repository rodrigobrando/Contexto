const $ = (id) => document.getElementById(id);
const state = { groupView: false, home: true, groupId: null, newGroup: null, unread: false, period: null, translation: null, sourceId: null, articleId: null, article: null, showOriginal: false };

// ---------- util ----------
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), isErr ? 7000 : 3500);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };
const fmtDate = (iso) => !iso ? 'data não disponível' : new Date(iso).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
}
function setBusy(btn, busy, label) {
  if (btn.classList.contains('icon')) { btn.disabled = busy; btn.classList.toggle('busy', busy); return; }
  btn.disabled = busy; if (label) btn.dataset.label ??= btn.textContent, btn.textContent = busy ? label : btn.dataset.label; }

// ---------- fontes ----------
// ---------- filtros: chave, rótulo para o modelo e título na tela ----------
// f = { period: 'today'|'week'|'month'|null, unread: bool, translation: 'yes'|'no'|null }
function filterKeyOf(f) {
  const day = f.period ? localKey(new Date(periodStart(f.period))) : '';
  return `${f.period ? f.period + ':' + day : 'all'}|${f.translation || 'any'}|${f.unread ? 'unread' : 'read-any'}`;
}
function filterLabelOf(f) {
  const parts = [];
  if (f.period) parts.push({ today: 'publicadas hoje', week: 'publicadas esta semana (segunda a domingo)', month: 'publicadas este mês' }[f.period]);
  if (f.unread) parts.push('ainda não lidas');
  if (f.translation) parts.push(f.translation === 'yes' ? 'já traduzidas' : 'ainda não traduzidas');
  return parts.length ? `notícias ${parts.join(', ')}` : 'todas as notícias';
}
function filterTitleOf(f) {
  const now = new Date(), fmt = (d, o) => d.toLocaleDateString('pt-BR', o);
  let head = 'Todas as notícias';
  if (f.period === 'today') head = `Hoje, ${fmt(now, { weekday: 'long', day: 'numeric', month: 'long' })}`;
  else if (f.period === 'week') {
    const start = new Date(periodStart('week')), end = new Date(start); end.setDate(end.getDate() + 6);
    head = `Esta semana, ${fmt(start, { day: 'numeric', month: 'long' })} a ${fmt(end, { day: 'numeric', month: 'long' })}`;
  } else if (f.period === 'month') head = `Este mês, ${fmt(now, { month: 'long', year: 'numeric' })}`;
  const extra = [f.unread ? 'não lidas' : '', f.translation === 'yes' ? 'traduzidas' : f.translation === 'no' ? 'não traduzidas' : ''].filter(Boolean);
  return extra.length ? `${head}, ${extra.join(', ')}` : head;
}
const listFilter = () => ({ period: state.period, unread: state.unread, translation: state.translation });

// ---------- fontes e grupos (barra lateral) ----------
let groupsCache = [];
const FOLDER_PLUS = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>';
const sidebarShort = (n) => n.split(/\s[|—–-]\s/)[0].trim();
const sidebarActive = () => !state.home;

// edição de nome no próprio lugar (Enter salva, Esc cancela)
function inlineEdit(nameEl, value, save) {
  const input = el('input', { className: 'rename', value, maxLength: 120 });
  input.onclick = (e) => e.stopPropagation();
  let finished = false;
  const finish = guard(async (ok) => {
    if (finished) return; finished = true;
    const name = input.value.trim();
    if (ok && name && name !== value) await save(name);
    await refreshAll();
  });
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  nameEl.replaceWith(input); input.focus(); input.select();
}
function startRename(src, nameEl) {
  inlineEdit(nameEl, src.name, async (name) => {
    await api.renameSource(src.id, name);
    if (state.article) openArticle(state.articleId); // o nome da fonte no leitor acompanha
  });
}

// menu "Mover para…"
function closeMenu() { document.getElementById('ctx-menu')?.remove(); }
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

function openMoveMenu(src, groups, x, y) {
  closeMenu();
  const menu = el('div', { id: 'ctx-menu', className: 'ctx-menu', role: 'menu' },
    el('div', { className: 'ctx-title', textContent: `Mover "${sidebarShort(src.name)}" para` }));
  const item = (label, checked, onPick) => {
    const b = el('button', { className: 'ctx-item', role: 'menuitem' }, el('span', { textContent: label }), checked ? el('span', { textContent: '✓' }) : '');
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); onPick(); };
    return b;
  };
  for (const g of groups) menu.append(item(g.name, src.group_id === g.id, () => moveSource(src.id, g.id)));
  if (src.group_id) menu.append(item('Sem grupo', false, () => moveSource(src.id, null)));
  menu.append(el('div', { className: 'ctx-sep' }),
    item('Novo grupo…', false, () => { state.newGroup = { moveSourceId: src.id }; loadSources(); }));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menu.querySelector('.ctx-item')?.focus();
}
const moveSource = guard(async (sourceId, groupId) => { await api.moveSource(sourceId, groupId); await loadSources(); });

async function loadSources() {
  const [list, groups] = await Promise.all([api.listSources(), api.listGroups()]);
  groupsCache = groups;
  const nav = $('sources'); nav.replaceChildren();
  const active = sidebarActive();

  const home = el('div', { className: 'src' + (state.home ? ' active' : '') }, el('span', { className: 'name', textContent: '☀ Início' }));
  home.onclick = () => showHome();
  const all = el('div', { className: 'src' + (active && state.sourceId === null && !state.groupId ? ' active' : '') }, el('span', { className: 'name', textContent: 'Todas as fontes' }));
  all.onclick = () => selectSource(null);
  nav.append(home, all);

  // cabeçalho da seção + novo grupo
  const addGroup = el('button', { className: 'icon mini', title: 'Novo grupo', ariaLabel: 'Novo grupo' });
  addGroup.innerHTML = FOLDER_PLUS;
  addGroup.onclick = () => { state.newGroup = { moveSourceId: null }; loadSources(); };
  nav.append(el('div', { className: 'sec-head' }, el('span', { textContent: 'Fontes' }), addGroup));

  // linha de uma fonte (arrastável; "⋯" abre o menu de mover)
  const sourceRow = (s, child) => {
    const nameEl = el('span', { className: 'name', textContent: s.name });
    const more = el('button', { className: 'rm', textContent: '⋯', title: 'Mover para um grupo', ariaLabel: 'Mover para um grupo' });
    more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); openMoveMenu(s, groups, r.left, r.bottom + 4); };
    const ed = el('button', { className: 'rm', textContent: '✎', title: 'Renomear fonte' });
    ed.onclick = (e) => { e.stopPropagation(); startRename(s, nameEl); };
    const rm = el('button', { className: 'rm', textContent: '✕', title: 'Remover fonte' });
    rm.onclick = guard(async (e) => {
      e.stopPropagation();
      if (!confirm(`Remover "${s.name}" e suas notícias?`)) return;
      await api.removeSource(s.id);
      if (state.sourceId === s.id) state.sourceId = null;
      await refreshAll();
    });
    nameEl.ondblclick = (e) => { e.stopPropagation(); startRename(s, nameEl); };
    const row = el('div', { className: 'src' + (child ? ' child' : '') + (active && state.sourceId === s.id ? ' active' : ''), draggable: true,
      title: s.feed_url ? 'via RSS' : 'via varredura da home' },
      nameEl, el('span', { className: 'count', textContent: s.unread || '' }), more, ed, rm);
    row.onclick = () => selectSource(s.id);
    row.oncontextmenu = (e) => { e.preventDefault(); openMoveMenu(s, groups, e.clientX, e.clientY); };
    row.ondragstart = (e) => { e.dataTransfer.setData('text/plain', `source:${s.id}`); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
    row.ondragend = () => row.classList.remove('dragging');
    return row;
  };

  // alvo de soltar (cabeçalho de grupo ou "Sem grupo")
  const dropTarget = (node, groupId) => {
    node.ondragover = (e) => { if (e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); node.classList.add('drop'); } };
    node.ondragleave = () => node.classList.remove('drop');
    node.ondrop = (e) => {
      e.preventDefault(); node.classList.remove('drop');
      const m = /^source:(\d+)$/.exec(e.dataTransfer.getData('text/plain'));
      if (m) moveSource(Number(m[1]), groupId);
    };
  };

  // campo para criar um grupo (a partir do "+" ou do menu "Novo grupo…")
  if (state.newGroup) {
    const pending = state.newGroup;
    const input = el('input', { className: 'rename new-group-input', placeholder: 'Nome do grupo', maxLength: 60 });
    let done = false;
    const finish = guard(async (ok) => {
      if (done) return; done = true;
      state.newGroup = null;
      const name = input.value.trim();
      if (ok && name) {
        const id = await api.createGroup(name);
        if (pending.moveSourceId) await api.moveSource(pending.moveSourceId, id);
      }
      await loadSources();
    });
    input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
    nav.append(el('div', { className: 'grp new' }, input));
  }

  // grupos com suas fontes
  for (const g of groups) {
    const members = list.filter((s) => s.group_id === g.id);
    const unread = members.reduce((t, s) => t + (s.unread || 0), 0);
    const collapsed = !!g.collapsed;
    const hasActive = collapsed && active && members.some((s) => s.id === state.sourceId);

    const chev = el('button', { className: 'chev', textContent: collapsed ? '▸' : '▾', title: collapsed ? 'Expandir grupo' : 'Recolher grupo' });
    chev.setAttribute('aria-expanded', !collapsed);
    chev.onclick = guard(async (e) => { e.stopPropagation(); await api.setGroupCollapsed(g.id, !collapsed); await loadSources(); });
    const nameEl = el('span', { className: 'name', textContent: g.name });
    nameEl.ondblclick = (e) => { e.stopPropagation(); inlineEdit(nameEl, g.name, (n) => api.renameGroup(g.id, n)); };
    const ed = el('button', { className: 'rm', textContent: '✎', title: 'Renomear grupo' });
    ed.onclick = (e) => { e.stopPropagation(); inlineEdit(nameEl, g.name, (n) => api.renameGroup(g.id, n)); };
    const rm = el('button', { className: 'rm', textContent: '✕', title: 'Excluir grupo (as fontes são mantidas)' });
    rm.onclick = guard(async (e) => {
      e.stopPropagation();
      if (!confirm(`Excluir o grupo "${g.name}"?\n\n${members.length ? `As ${members.length} fontes dele voltam para "Sem grupo".` : 'Ele está vazio.'}`)) return;
      await api.deleteGroup(g.id);
      if (state.groupId === g.id) state.groupId = null;
      await refreshAll();
    });
    const head = el('div', { className: 'src grp' + (active && state.groupId === g.id ? ' active' : '') + (hasActive ? ' has-active' : ''), tabIndex: 0, role: 'button',
      title: 'Ver as notícias de todo o grupo' },
      chev, nameEl, el('span', { className: 'count', textContent: unread || '' }), ed, rm);
    head.onclick = () => selectGroup(g.id);
    head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectGroup(g.id); } };
    dropTarget(head, g.id);
    nav.append(head);
    if (!collapsed) for (const s of members) nav.append(sourceRow(s, true));
  }

  // fontes sem grupo
  const loose = list.filter((s) => !s.group_id);
  if (groups.length) {
    const label = el('div', { className: 'sec-sub', textContent: 'Sem grupo' });
    dropTarget(label, null);
    nav.append(label);
  }
  for (const s of loose) nav.append(sourceRow(s, false));
  nav.querySelector('.new-group-input')?.focus();
}
// sai da tela cheia (Início) e volta ao par lista + leitor
function leaveViews() {
  state.home = false; state.groupId = null; state.sourceId = null; state.groupView = false;
  document.body.classList.remove('home-mode');
  $('gsummary').hidden = true;
  if ($('article').hidden) $('empty').hidden = false; // nenhum artigo aberto: volta a mensagem padrão
}
function selectSource(id) {
  leaveViews();
  state.sourceId = id; refreshAll();
}
function selectGroup(id) { // todas as fontes do grupo: lista à esquerda e resumo à direita
  leaveViews();
  state.groupId = id; state.articleId = null; state.article = null;
  $('article').hidden = true;
  showGroupSummary();
  refreshAll();
}
// escopo das ações em lote: uma fonte, um grupo ou tudo
const currentScope = () => (state.groupId ? { groupId: state.groupId } : state.sourceId);

// ---------- filtros ----------
// Início do período no fuso local. Semana começa na segunda-feira.
function periodStart(period) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (period === 'month') d.setDate(1);
  else if (period !== 'today') return null;
  return d.toISOString();
}
function syncChips() {
  $('f-unread').setAttribute('aria-pressed', state.unread);
  document.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.period === state.period));
  document.querySelectorAll('[data-tr]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tr === state.translation));
}
$('f-unread').onclick = () => { state.unread = !state.unread; syncChips(); guard(loadArticles)(); };
document.querySelectorAll('[data-period]').forEach((b) => {
  b.onclick = () => { state.period = state.period === b.dataset.period ? null : b.dataset.period; syncChips(); guard(loadArticles)(); };
});

document.querySelectorAll('[data-tr]').forEach((b) => {
  b.onclick = () => { state.translation = state.translation === b.dataset.tr ? null : b.dataset.tr; syncChips(); guard(loadArticles)(); };
});

// ---------- exclusão ----------
const guardedDelete = guard(async (id, title) => {
  if (!confirm(`Excluir este artigo?\n\n${title}\n\nEle não será coletado novamente.`)) return;
  await api.deleteArticle(id);
  if (state.articleId === id) {
    state.articleId = null; state.article = null;
    $('article').hidden = true;
    if (state.groupId) showGroupSummary(); else $('empty').hidden = false;
  }
  toast('Artigo excluído');
  await refreshAll();
});
$('btn-delete').onclick = () => state.article && guardedDelete(state.article.id, state.article.title_pt || state.article.title);

// ---------- lista ----------
async function loadArticles() {
  const items = await api.listArticles({
    sourceId: state.sourceId, groupId: state.groupId, search: $('search').value.trim() || null, translation: state.translation,
    unread: state.unread, since: periodStart(state.period),
  });
  const ul = $('articles'); ul.replaceChildren();
  if (state.groupId) { // item fixo: volta ao resumo do grupo
    const pin = el('li', { className: 'item pinned' + (state.groupView ? ' active' : '') },
      el('div', {}, el('div', { className: 't', textContent: '✦ Resumo do grupo' }), el('div', { className: 'm', textContent: filterTitleOf(listFilter()) })), el('div'));
    pin.onclick = () => { state.articleId = null; state.article = null; showGroupSummary(); loadArticles(); };
    ul.append(pin);
  }
  if (state.groupId && state.groupView) guard(renderGroupSummary)(); // filtros mudaram: o resumo acompanha
  if (!items.length) ul.append(el('li', { className: 'item', textContent: (state.unread || state.period || $('search').value || state.translation) ? 'Nenhuma notícia com esses filtros.' : 'Nenhuma notícia. Adicione um site ou clique em Atualizar.' }));
  for (const a of items) {
    const badge = a.status === 'processed' ? el('span', { className: 'badge', textContent: 'PT' })
      : a.status === 'error' ? el('span', { className: 'badge err', textContent: 'erro' }) : '';
    const li = el('li', { className: `item ${a.read ? '' : 'unread'} ${a.id === state.articleId ? 'active' : ''}` },
      el('div', {},
        el('div', { className: 't' }, badge, a.title_pt || a.title),
        a.summary_pt ? el('div', { className: 's', textContent: a.summary_pt }) : '',
        el('div', { className: 'm', textContent: `${a.source_name} · ${a.date_estimated ? 'coletada em ' : ''}${fmtDate(a.published_at)}` })),
      a.image ? el('img', { src: a.image, loading: 'lazy', referrerPolicy: 'no-referrer' }) : el('div'));
    const del = el('button', { className: 'icon danger del', title: 'Excluir artigo', ariaLabel: 'Excluir artigo' });
    del.innerHTML = $('btn-delete').innerHTML; // mesmo ícone da barra do leitor
    del.onclick = (e) => { e.stopPropagation(); guardedDelete(a.id, a.title_pt || a.title); };
    li.append(del);
    li.onclick = () => openArticle(a.id);
    ul.append(li);
  }
}

// ---------- leitor ----------
function paragraphs(text) {
  const frag = document.createDocumentFragment();
  (text || '').split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => frag.append(el('p', { textContent: p })));
  return frag;
}
function renderArticle() {
  const a = state.article; if (!a) return;
  const done = a.status === 'processed';
  $('empty').hidden = true; $('gsummary').hidden = true; $('article').hidden = false;
  $('a-source').textContent = ''; $('a-date').textContent = a.date_estimated ? `Coletada em ${fmtDate(a.published_at)} (publicação sem data)` : `Publicado em ${fmtDate(a.published_at)}`;
  $('a-title').textContent = done ? a.title_pt : a.title;
  $('a-orig-title').textContent = done ? a.title : ''; $('a-orig-title').hidden = !done;
  $('a-summary').textContent = a.summary_pt || ''; $('a-summary').hidden = !done;
  $('a-error').textContent = a.error ? `Erro: ${a.error}` : ''; $('a-error').hidden = !a.error;
  $('btn-translate').textContent = done ? 'Traduzir novamente' : 'Resumir e traduzir';
  $('btn-translate').disabled = !a.content;
  $('btn-date').hidden = !a.date_estimated;
  $('btn-toggle').hidden = !done;
  $('btn-toggle').textContent = state.showOriginal ? 'Ver tradução' : 'Ver texto original';
  const showPt = done && !state.showOriginal;
  const body = $('a-body');
  body.replaceChildren(a.content || showPt ? paragraphs(showPt ? a.content_pt : a.content)
    : el('p', { textContent: 'Não foi possível extrair o texto (possível paywall). Use "Abrir original".' }));
}
async function openArticle(id) {
  state.articleId = id; state.showOriginal = false; state.groupView = false;
  state.article = await api.getArticle(id);
  const srcs = await api.listSources();
  $('a-source').textContent = srcs.find((s) => s.id === state.article.source_id)?.name || '';
  renderArticle(); $('reader').scrollTop = 0;
  loadArticles(); loadSources();
}

$('btn-translate').onclick = guard(async () => {
  const btn = $('btn-translate'); setBusy(btn, true, 'Traduzindo…');
  try { state.article = await api.translate(state.articleId); state.showOriginal = false; renderArticle(); loadArticles(); }
  catch (e) { toast(e.message, true); state.article = await api.getArticle(state.articleId); renderArticle(); }
  finally { setBusy(btn, false, 'x'); renderArticle(); }
});
$('btn-date').onclick = guard(async () => {
  const b = $('btn-date'); setBusy(b, true, 'Buscando…');
  try {
    const r = await api.refreshArticle(state.articleId);
    state.article = r.article; renderArticle(); loadArticles();
    toast(r.foundDate ? 'Data de publicação encontrada' : 'A página não informa a data de publicação', !r.foundDate);
  } finally { setBusy(b, false, 'x'); }
});
$('btn-dates').onclick = guard(async () => {
  const b = $('btn-dates'); setBusy(b, true, 'Buscando…');
  try {
    const r = await api.refreshDates(currentScope());
    if (!r.checked) toast('Todos os artigos já têm data');
    else toast(`${r.found} de ${r.checked} datas encontradas` + (r.blocked ? '. O site bloqueou o acesso; tente mais tarde.' : ''), r.blocked);
    await refreshAll();
    if (state.articleId) { state.article = await api.getArticle(state.articleId); renderArticle(); }
  } finally { setBusy(b, false, 'x'); endProgress(); }
});
$('btn-original').onclick = () => state.article && api.openExternal(state.article.url);
$('btn-toggle').onclick = () => { state.showOriginal = !state.showOriginal; renderArticle(); };

// ---------- resumo do grupo (painel de leitura) ----------
function showGroupSummary() {
  state.groupView = true;
  $('empty').hidden = true; $('article').hidden = true; $('gsummary').hidden = false;
  $('reader').scrollTop = 0;
  renderGroupSummary();
}

async function renderGroupSummary() {
  const box = $('gsummary');
  const gid = state.groupId, f = listFilter(), key = filterKeyOf(f);
  const group = gid === 'none' ? { id: 'none', name: groupsCache.length ? 'Fontes sem grupo' : 'Todas as fontes' } : groupsCache.find((g) => g.id === gid);
  if (!group) return;
  const info = await api.groupDigest({ groupId: gid, filter: { ...f, since: periodStart(f.period) }, filterKey: key });
  if (state.groupId !== gid || !state.groupView) return; // o usuário mudou de tela durante a consulta

  const dg = info.digest;
  const btn = el('button', { className: dg ? 'btn-ghost' : 'btn-glow', textContent: dg ? 'Atualizar resumo' : 'Gerar resumo' });
  const wrap = el('div', { className: 'gsum-inner' },
    el('div', { className: 'gsum-head' },
      el('div', {}, el('h1', { textContent: group.name }), el('p', { className: 'gsum-sub', textContent: filterTitleOf(f) })),
      info.n ? btn : ''));

  if (!info.n) {
    wrap.append(el('p', { className: 'empty-note', textContent: 'Nenhuma notícia neste grupo com os filtros atuais. Mude o período ou os filtros da lista.' }));
    box.replaceChildren(wrap);
    return;
  }

  const status = el('span', { className: 'status' + (dg ? '' : ' idle'), textContent: dg ? `Resumo gerado às ${fmtClockShort(dg.generated_at)}` : 'Resumo não gerado' });
  if (dg && info.n > dg.article_count) status.append(' ', el('span', { className: 'more', textContent: `+${info.n - dg.article_count} novas` }));
  wrap.append(el('div', { className: 'panel-meta' }, status,
    el('span', { className: 'count', textContent: `${info.n} ${info.n === 1 ? 'notícia' : 'notícias'} de ${info.sources} ${info.sources === 1 ? 'fonte' : 'fontes'}` })));

  const zone = el('div', { className: 'gsum-body' });
  if (dg) zone.append(digestBlocks(dg));
  else zone.append(el('p', { className: 'hint', textContent: 'Gere um resumo das notícias deste grupo no período escolhido. O modelo recebe só o título e o resumo de cada uma.' }));
  wrap.append(zone);

  btn.onclick = guard(async () => {
    setBusy(btn, true, 'Resumindo…');
    zone.before(el('div', { className: 'skeleton', ariaLabel: 'Gerando resumo' }, el('i'), el('i'), el('i'), el('i')));
    try {
      await api.groupSummarize({ groupId: gid, filter: { ...f, since: periodStart(f.period) }, filterKey: key, label: filterLabelOf(f) });
      if (state.groupId === gid && state.groupView) await renderGroupSummary();
    } finally { setBusy(btn, false, 'x'); wrap.querySelector('.skeleton')?.remove(); endProgress(); }
  });
  box.replaceChildren(wrap);
}
const fmtClockShort = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// ---------- ações globais ----------
// Progresso global, mostrado na barra lateral em qualquer tela.
const ACTIVITY = new Set(['Buscando datas de publicação', 'Reprocessando artigos']); // eventos que trazem o nome da tarefa, não de um artigo
let progressHide;
function showProgress({ label, current = 0, total = 0, detail = '', indeterminate = false }) {
  clearTimeout(progressHide);
  const box = $('progress');
  box.hidden = false;
  box.classList.toggle('indeterminate', indeterminate || !total);
  $('pg-label').textContent = label;
  $('pg-count').textContent = total ? `${current}/${total}` : '';
  $('pg-detail').textContent = detail;
  $('bar').style.width = total ? `${(current / total) * 100}%` : '';
  if (total) box.setAttribute('aria-valuenow', Math.round((current / total) * 100)); else box.removeAttribute('aria-valuenow');
}
function endProgress() { // some um instante depois, para dar tempo de ver o 100%
  clearTimeout(progressHide);
  progressHide = setTimeout(() => ($('progress').hidden = true), 900);
}
api.onProgress((p) => {
  const isActivity = ACTIVITY.has(p.title);
  showProgress({
    label: isActivity ? p.title : p.stage === 'source' ? 'Atualizando fontes' : p.stage === 'digest' ? 'Gerando resumos' : p.stage === 'fetch' ? 'Baixando artigos' : 'Traduzindo',
    current: p.stage === 'source' || p.stage === 'digest' ? Math.min(p.current + 1, p.total) : p.current, total: p.total, detail: isActivity ? '' : p.title || '',
  });
});
api.onToast((m) => toast(m, true));

async function refreshAll() {
  await Promise.all([loadSources(), loadArticles()]);
  if (state.home && typeof loadHome === 'function') await loadHome();
}

$('add-form').onsubmit = guard(async (e) => {
  e.preventDefault();
  const url = $('add-url').value.trim(); if (!url) return;
  const btn = e.target.querySelector('button'); btn.disabled = true;
  showProgress({ label: 'Indexando site', detail: 'Procurando o feed RSS…', indeterminate: true });
  try {
    const r = await api.addSource(url);
    $('add-url').value = '';
    toast(`${r.added} notícias indexadas ${r.usedFeed ? '(via RSS)' : '(varrendo a home — sem RSS)'}` + (r.rateLimited ? '. O site bloqueou/limitou o download das páginas (401/403/429): os artigos ficaram só com o texto que vem no RSS (em sites com paywall, costuma ser apenas um resumo).' : ''), r.rateLimited);
    selectSource(r.id); // abre a fonte nova (sai da Início, se for o caso)
  } finally { btn.disabled = false; endProgress(); }
});
function refreshSummary(r) {
  const parts = [r.added ? `${r.added} ${r.added === 1 ? 'nova notícia' : 'novas notícias'}` : 'Nenhuma notícia nova'];
  if (r.failed?.length) parts.push(`${r.failed.length} ${r.failed.length === 1 ? 'fonte falhou' : 'fontes falharam'} (${r.failed.slice(0, 2).map((f) => f.name.split(/\s[|—–-]\s/)[0]).join(', ')}${r.failed.length > 2 ? '…' : ''})`);
  return parts.join('. ');
}
$('btn-refresh').onclick = guard(async () => {
  const b = $('btn-refresh'); setBusy(b, true, 'Atualizando…');
  try { const r = await api.refresh(currentScope()); toast(refreshSummary(r), !!r.failed?.length); await refreshAll(); autoSummarizeHome(); }
  finally { setBusy(b, false, 'x'); endProgress(); }
});

// Atualização automática ao abrir o app (disparada pelo processo principal)
api.onRefreshStart(() => {
  setBusy($('btn-refresh'), true, 'Atualizando…');
  showProgress({ label: 'Atualizando fontes', indeterminate: true });
});
api.onRefreshDone(guard(async (r) => {
  setBusy($('btn-refresh'), false, 'x'); endProgress();
  toast(r.error ? `Falha ao atualizar: ${r.error}` : refreshSummary(r), !!r.error || !!r.failed?.length);
  await refreshAll(); // recarrega a Início ou a lista, conforme a tela aberta
  autoSummarizeHome(); // resumos automáticos: só de grupos com notícias não lidas
}));
$('btn-translate-all').onclick = guard(async () => {
  const b = $('btn-translate-all'); setBusy(b, true, 'Traduzindo…');
  try { const r = await api.translatePending(currentScope()); toast(`${r.done - r.failed} traduzidas, ${r.failed} com erro`, r.failed > 0); await refreshAll(); }
  finally { setBusy(b, false, 'x'); endProgress(); }
});
let st; $('search').oninput = () => { clearTimeout(st); st = setTimeout(guard(loadArticles), 250); };

// ---------- configurações ----------
$('btn-settings').onclick = guard(async () => {
  const s = await api.getSettings();
  $('s-key').value = ''; $('s-model').value = s.model; $('s-auto').checked = s.autoTranslate; $('s-autosum').checked = s.autoSummary;
  $('s-key-hint').textContent = s.hasKey ? 'Uma chave já está salva. Deixe em branco para manter.' : 'Crie em openrouter.ai/keys';
  $('settings').showModal();
});
$('s-cancel').onclick = () => $('settings').close();
$('settings-form').onsubmit = guard(async () => {
  await api.setSettings({ apiKey: $('s-key').value, model: $('s-model').value, autoTranslate: $('s-auto').checked, autoSummary: $('s-autosum').checked });
  $('settings').close(); toast('Configurações salvas');
});

guard(refreshAll)();
