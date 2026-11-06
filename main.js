const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Contexto');

// O nome do app define a pasta de dados. Migra a pasta antiga para não perder fontes e notícias.
(function migrateUserData() {
  const base = app.getPath('appData');
  const oldDir = path.join(base, 'news-aggregator');
  const newDir = path.join(base, 'Contexto');
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
  } catch (e) { console.error('Falha ao migrar dados:', e.message); }
  app.setPath('userData', newDir);
})();
const db = require('./src/db');
const { q } = db;
const { addSource, refreshSource, refreshArticle, refreshMissingDates } = require('./src/fetcher');
const { translateArticle, generateDigest } = require('./src/llm');

// Tradução e indexação automáticas (ao abrir o app / em "Atualizar") só valem para notícias com menos de 24 h.
const AUTO_MAX_AGE_HOURS = 24;
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const ICON = path.join(__dirname, 'build', 'icon.png');
let win;

// --- chave da API guardada criptografada (Keychain no macOS) ---
function saveApiKey(key) {
  if (!key) return q.setSetting('apiKey', '');
  const v = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(key).toString('base64')
    : 'raw:' + key;
  q.setSetting('apiKey', v);
}
function loadApiKey() {
  const v = q.getSetting('apiKey');
  if (!v) return '';
  if (v.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
    catch { return ''; } // chave do Keychain mudou (ex.: renomeação do app): peça para informar de novo
  }
  return v.replace(/^raw:/, '');
}
const llmConfig = () => ({ apiKey: loadApiKey(), model: q.getSetting('model') || DEFAULT_MODEL });
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);

// "handle" que devolve { ok, data | error } para o renderer tratar erros sem stack trace
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}

async function runPool(ids, worker, concurrency = 3) {
  let i = 0, done = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { await worker(id); } catch { failed++; }
      send('progress', { stage: 'translate', current: ++done, total: ids.length });
    }
  }));
  return { done, failed };
}

// Atualiza as fontes (uma só ou todas). Só roda uma atualização por vez: se o app já estiver
// atualizando ao abrir, o botão "Atualizar" reaproveita a mesma execução em vez de duplicar o trabalho.
let refreshJob = null;
function refreshSources(scope) {
  if (refreshJob) return refreshJob;
  refreshJob = (async () => {
    const sources = scope?.groupId ? q.sourcesInGroup(scope.groupId) : scope ? [q.getSource(scope)].filter(Boolean) : q.listSources();
    let added = 0;
    const failed = [];
    for (const [i, src] of sources.entries()) {
      send('progress', { stage: 'source', current: i, total: sources.length, title: src.name });
      try { added += (await refreshSource(src.id, (p) => send('progress', p))).added; }
      catch (e) { failed.push({ name: src.name, error: e.message }); }
    }
    if (q.getSetting('autoTranslate') === '1' && added > 0) {
      await runPool(q.pendingIds(scope, { maxAgeHours: AUTO_MAX_AGE_HOURS }), (aid) => translateArticle(aid, llmConfig()));
    }
    return { added, failed };
  })().finally(() => { refreshJob = null; });
  return refreshJob;
}

// Ao abrir o app: busca notícias novas em todas as fontes, em segundo plano.
function refreshOnStartup() {
  if (!q.listSources().length) return;
  send('refresh:start');
  refreshSources(null)
    .then((r) => send('refresh:done', r))
    .catch((e) => send('refresh:done', { added: 0, failed: [], error: e.message }));
}

function registerIpc() {
  handle('sources:list', () => q.listSources());
  handle('sources:add', async (url) => {
    const { id, usedFeed } = await addSource(url);
    const r = await refreshSource(id, (p) => send('progress', p));
    return { id, usedFeed, ...r };
  });
  handle('sources:rename', (id, name) => {
    name = String(name || '').trim().slice(0, 120);
    if (!name) throw new Error('O nome não pode ficar vazio.');
    q.renameSource(id, name);
  });
  handle('sources:remove', (id) => q.removeSource(id));
  handle('sources:refresh', (scope) => refreshSources(scope));

  // ---- grupos de fontes ----
  const groupName = (n) => {
    const name = String(n || '').trim().slice(0, 60);
    if (!name) throw new Error('O nome do grupo não pode ficar vazio.');
    return name;
  };
  handle('groups:list', () => q.listGroups());
  handle('groups:create', (name) => q.createGroup(groupName(name)));
  handle('groups:rename', (id, name) => q.renameGroup(id, groupName(name)));
  handle('groups:delete', (id) => q.deleteGroup(id));
  handle('groups:collapse', (id, collapsed) => q.setGroupCollapsed(id, collapsed));
  // resumo de um grupo de fontes, conforme os filtros da lista (período, não lidas, traduzidas)
  const groupKey = (id, filterKey) => `group:${id === 'none' ? 'none' : Number(id)}|${String(filterKey || '')}`;
  handle('groups:digest', ({ groupId, filter, filterKey }) => ({
    ...q.countStats({ ...cleanFilter(filter), groupId }),
    digest: loadDigest(groupKey(groupId, filterKey)),
  }));
  // Gera e guarda o resumo de um grupo (ou das fontes sem grupo, groupId = 'none') para um período/filtro.
  async function summarizeGroup(groupId, filter, filterKey, label) {
    const groups = q.listGroups();
    const name = groupId === 'none' ? (groups.length ? 'Fontes sem grupo' : 'Todas as fontes') : groups.find((g) => g.id === groupId)?.name;
    if (!name) throw new Error('Grupo não encontrado.');
    const f = { ...cleanFilter(filter), groupId };
    const stats = q.countStats(f);
    const items = q.filteredDigestItems(f, 80);
    const tag = stats.n > items.length ? `, limitado às ${items.length} mais recentes de ${stats.n}` : '';
    const data = await generateDigest(items, llmConfig(), String(label || 'todas as notícias do grupo') + tag, { group: name });
    q.saveDigest(groupKey(groupId, filterKey), stats.n, data);
    return loadDigest(groupKey(groupId, filterKey));
  }
  handle('groups:summarize', ({ groupId, filter, filterKey, label }) => summarizeGroup(groupId, filter, filterKey, label));

  // Início: um cartão por grupo (mais "sem grupo"), com a contagem e o resumo guardado do período
  const homeBuckets = (since, filterKey) => {
    const groups = q.listGroups(), sources = q.listSources();
    const bucket = (id, name) => ({ id, name, ...q.countStats({ since, groupId: id }), unread: q.countStats({ since, groupId: id, unread: true }).n, digest: loadDigest(groupKey(id, filterKey)) });
    const out = groups.filter((g) => sources.some((s) => s.group_id === g.id)).map((g) => bucket(g.id, g.name));
    if (sources.some((s) => !s.group_id)) out.push(bucket('none', groups.length ? 'Sem grupo' : 'Todas as fontes'));
    return out;
  };
  handle('home:groups', ({ since, filterKey }) => homeBuckets(since, filterKey));
  // gera de uma vez os resumos que faltam (ou que ficaram para trás), um grupo por vez
  // auto = chamada automática (ao abrir/atualizar): só gera para grupos com notícias NÃO LIDAS no período e se o recurso estiver ligado
  handle('home:summarizeAll', async ({ since, filterKey, label, auto }) => {
    if (auto && (q.getSetting('autoSummary') === '0' || !llmConfig().apiKey)) return { done: 0, failed: 0, skipped: true };
    const todo = homeBuckets(since, filterKey).filter((b) => b.n > 0 && (!b.digest || b.n > b.digest.article_count) && (!auto || b.unread > 0));
    let done = 0, failed = 0, lastError = null;
    for (const [i, b] of todo.entries()) {
      send('progress', { stage: 'digest', current: i, total: todo.length, title: b.name });
      try { await summarizeGroup(b.id, { since }, filterKey, label); done++; } catch (e) { failed++; lastError = e; }
    }
    send('progress', { stage: 'digest', current: todo.length, total: todo.length, title: '' });
    if (!done && lastError) throw lastError;
    return { done, failed };
  });
  handle('sources:move', (sourceId, groupId) => q.moveSource(sourceId, groupId || null));

  handle('articles:list', (filter) => q.listArticles(filter || {}));
  handle('articles:get', (id) => { q.markRead(id); return q.getArticle(id); });
  handle('articles:refreshOne', async (id) => {
    const r = await refreshArticle(id);
    return { ...r, article: q.getArticle(id) };
  });
  handle('articles:refreshDates', (scope) => refreshMissingDates(scope, (p) => send('progress', p)));
  // filtros vindos da tela: só aceita os campos conhecidos
  const cleanFilter = (f = {}) => ({
    unread: !!f.unread,
    translation: f.translation === 'yes' || f.translation === 'no' ? f.translation : null,
    since: typeof f.since === 'string' ? f.since : null,
  });

  // ---- Início ----
  const loadDigest = (key) => {
    const row = q.getDigest(key);
    if (!row) return null;
    const d = JSON.parse(row.data);
    const alive = new Set(q.existingIds(d.topics.flatMap((t) => t.articles.map((a) => a.id)))); // some artigos excluídos
    const img = new Map(q.articleImages([...alive]).map((r) => [r.id, r.image]));
    d.topics = d.topics.map((t) => ({ ...t, articles: t.articles.filter((a) => alive.has(a.id)).map((a) => ({ ...a, image: img.get(a.id) || null })) }));
    return { ...d, generated_at: row.generated_at, article_count: row.article_count };
  };
  handle('home:get', (periods) => periods.map((p) => ({
    id: p.id, key: p.key, ...q.countSince(p.since),
    unread_total: q.listSources().reduce((t, x) => t + x.unread, 0),
  })));
  handle('articles:delete', (id) => q.deleteArticle(id));
  handle('articles:translate', (id) => translateArticle(id, llmConfig()).then(() => q.getArticle(id)));
  handle('articles:translatePending', (scope) =>
    runPool(q.pendingIds(scope), (id) => translateArticle(id, llmConfig())));
  handle('open:external', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  handle('settings:get', () => ({
    hasKey: !!loadApiKey(),
    model: q.getSetting('model') || DEFAULT_MODEL,
    autoTranslate: q.getSetting('autoTranslate') === '1',
    autoSummary: q.getSetting('autoSummary') !== '0', // ligado por padrão
  }));
  handle('settings:set', ({ apiKey, model, autoTranslate, autoSummary }) => {
    if (apiKey !== undefined && apiKey !== null && apiKey !== '') saveApiKey(apiKey.trim());
    if (model) q.setSetting('model', model.trim());
    q.setSetting('autoTranslate', autoTranslate ? '1' : '0');
    q.setSetting('autoSummary', autoSummary === false ? '0' : '1');
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#14161a',
    title: 'Contexto',
    icon: ICON, // Windows/Linux; no macOS o ícone vem do Dock (abaixo) ou do app empacotado
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // links externos abrem no navegador, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(ICON); // em desenvolvimento (npm start) o Dock mostraria o ícone do Electron
  db.init(app.getPath('userData'));
  registerIpc();
  createWindow();
  win.webContents.once('did-finish-load', () => setTimeout(refreshOnStartup, 400)); // só ao abrir; reabrir a janela pelo Dock não repete
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
