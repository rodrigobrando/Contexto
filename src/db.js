const Database = require('better-sqlite3');
const path = require('path');

let db;

function init(userDataDir) {
  db = new Database(path.join(userDataDir, 'news.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      feed_url TEXT,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_fetched TEXT
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      image TEXT,
      published_at TEXT,
      content TEXT,          -- texto limpo (sem anúncios), idioma original
      title_pt TEXT,
      summary_pt TEXT,
      content_pt TEXT,
      status TEXT NOT NULL DEFAULT 'new',  -- new | processed | error
      error TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id, published_at DESC);
    CREATE TABLE IF NOT EXISTS source_groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS digests (
      key TEXT PRIMARY KEY,            -- ex.: day:2026-11-05 | week:2026-11-02
      article_count INTEGER NOT NULL,  -- quantas notícias existiam quando foi gerado
      data TEXT NOT NULL,              -- JSON { overview, topics }
      generated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  // data estimada: sem data de publicação, usa-se a data da sincronização (e marca-se para corrigir depois)
  if (!db.prepare("PRAGMA table_info(articles)").all().some((c) => c.name === 'date_estimated')) {
    db.exec('ALTER TABLE articles ADD COLUMN date_estimated INTEGER NOT NULL DEFAULT 0');
  }
  // group_id: grupo da fonte na barra lateral (NULL = sem grupo). Se o grupo for apagado, a fonte volta para "sem grupo".
  if (!db.prepare("PRAGMA table_info(sources)").all().some((c) => c.name === 'group_id')) {
    db.exec('ALTER TABLE sources ADD COLUMN group_id INTEGER REFERENCES source_groups(id) ON DELETE SET NULL');
  }
  // fix_tries: quantas vezes a coleta já tentou recuperar texto/data de um artigo (evita rebaixar para sempre páginas sem data)
  if (!db.prepare("PRAGMA table_info(articles)").all().some((c) => c.name === 'fix_tries')) {
    db.exec('ALTER TABLE articles ADD COLUMN fix_tries INTEGER NOT NULL DEFAULT 0');
  }
  // exclusão lógica: a linha fica (sem conteúdo) para a coleta não trazer o artigo de volta
  if (!db.prepare("PRAGMA table_info(articles)").all().some((c) => c.name === 'deleted')) {
    db.exec('ALTER TABLE articles ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`UPDATE articles SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), date_estimated = 1
           WHERE published_at IS NULL`);
}

// Escopo de uma operação: número = uma fonte, { groupId } = todas as fontes do grupo, vazio = tudo.
function scopeClause(scope, col = 'source_id') {
  if (scope && typeof scope === 'object' && scope.groupId === 'none') return { sql: `AND ${col} IN (SELECT id FROM sources WHERE group_id IS NULL)`, args: [] };
  if (scope && typeof scope === 'object' && scope.groupId) return { sql: `AND ${col} IN (SELECT id FROM sources WHERE group_id = ?)`, args: [scope.groupId] };
  if (scope) return { sql: `AND ${col} = ?`, args: [scope] };
  return { sql: '', args: [] };
}

// Só artigos recentes (publicados nas últimas N horas). Artigos sem data de publicação
// (date_estimated = 1) ficam de fora: não dá para saber a idade deles, então só entram quando o usuário pede.
function recentClause(maxAgeHours, col = '') {
  if (!maxAgeHours) return { sql: '', args: [] };
  return {
    sql: `AND ${col}date_estimated = 0 AND datetime(COALESCE(${col}published_at, ${col}created_at)) >= datetime('now', ?)`,
    args: [`-${Number(maxAgeHours)} hours`],
  };
}

// Filtros da lista de notícias e dos resumos (a = articles).
function articleFilter({ sourceId, groupId, search, translation, unread, since } = {}) {
  const where = ['a.deleted = 0'];
  const params = {};
  if (sourceId) { where.push('a.source_id = @sourceId'); params.sourceId = sourceId; }
  if (groupId === 'none') where.push('a.source_id IN (SELECT id FROM sources WHERE group_id IS NULL)'); // fontes sem grupo
  else if (groupId) { where.push('a.source_id IN (SELECT id FROM sources WHERE group_id = @groupId)'); params.groupId = groupId; }
  if (translation === 'yes') where.push("a.status = 'processed'");
  if (translation === 'no') where.push("a.status <> 'processed'");
  if (unread) where.push('a.read = 0');
  // datas ficam em formatos diferentes (ISO com Z / "YYYY-MM-DD HH:MM:SS"): datetime() normaliza os dois
  if (since) { where.push('datetime(COALESCE(a.published_at, a.created_at)) >= datetime(@since)'); params.since = since; }
  if (search) {
    where.push('(a.title LIKE @s OR a.title_pt LIKE @s OR a.summary_pt LIKE @s OR a.content LIKE @s)');
    params.s = `%${search}%`;
  }
  return { where, params };
}

const q = {
  addSource: (url, feedUrl, name) =>
    db.prepare('INSERT INTO sources (url, feed_url, name) VALUES (?, ?, ?)').run(url, feedUrl, name).lastInsertRowid,
  getSource: (id) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id),
  listSources: () =>
    db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM articles a WHERE a.source_id = s.id AND a.read = 0 AND a.deleted = 0) AS unread
                FROM sources s ORDER BY s.name COLLATE NOCASE`).all(),
  renameSource: (id, name) => db.prepare('UPDATE sources SET name = ? WHERE id = ?').run(name, id),
  listGroups: () => db.prepare('SELECT id, name, collapsed FROM source_groups ORDER BY position, id').all(),
  createGroup: (name) =>
    db.prepare('INSERT INTO source_groups (name, position) VALUES (?, COALESCE((SELECT MAX(position) + 1 FROM source_groups), 0))').run(name).lastInsertRowid,
  renameGroup: (id, name) => db.prepare('UPDATE source_groups SET name = ? WHERE id = ?').run(name, id),
  setGroupCollapsed: (id, collapsed) => db.prepare('UPDATE source_groups SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, id),
  deleteGroup: (id) => db.transaction(() => {
    db.prepare('UPDATE sources SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM digests WHERE key LIKE ?').run(`group:${id}|%`);
    db.prepare('DELETE FROM digests WHERE key LIKE ?').run('group:none|%'); // as fontes do grupo passam a "sem grupo"
    db.prepare('DELETE FROM source_groups WHERE id = ?').run(id);
  })(),
  moveSource: (id, groupId) => db.transaction(() => {
    const old = db.prepare('SELECT group_id FROM sources WHERE id = ?').get(id)?.group_id;
    db.prepare('UPDATE sources SET group_id = ? WHERE id = ?').run(groupId, id);
    // a composição dos grupos mudou: resumos guardados deles deixam de valer
    for (const g of new Set([old ?? 'none', groupId ?? 'none'])) db.prepare('DELETE FROM digests WHERE key LIKE ?').run(`group:${g}|%`);
  })(),
  sourcesInGroup: (groupId) => groupId === 'none'
    ? db.prepare('SELECT * FROM sources WHERE group_id IS NULL').all()
    : db.prepare('SELECT * FROM sources WHERE group_id = ?').all(groupId),
  removeSource: (id) => db.prepare('DELETE FROM sources WHERE id = ?').run(id),
  touchSource: (id) => db.prepare("UPDATE sources SET last_fetched = datetime('now') WHERE id = ?").run(id),

  hasArticle: (url) => !!db.prepare('SELECT 1 FROM articles WHERE url = ?').get(url),
  addArticle: (a) =>
    db.prepare(`INSERT OR IGNORE INTO articles (source_id, url, title, image, published_at, date_estimated, content)
                VALUES (@source_id, @url, @title, @image,
                        COALESCE(@published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        CASE WHEN @published_at IS NULL THEN 1 ELSE 0 END, @content)`).run(a),
  getArticle: (id) => db.prepare('SELECT * FROM articles WHERE id = ?').get(id),
  listArticles: ({ limit = 200, ...filter }) => {
    const { where, params } = articleFilter(filter);
    return db.prepare(`
      SELECT a.id, a.source_id, a.url, a.title, a.title_pt, a.summary_pt, a.image, a.published_at, a.date_estimated,
             a.status, a.read, s.name AS source_name
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(a.published_at, a.created_at) DESC LIMIT ${Number(limit)}`).all(params);
  },
  // contagem de notícias e de fontes distintas com os filtros dados
  countStats: (filter) => {
    const { where, params } = articleFilter(filter);
    return db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT a.source_id) AS sources FROM articles a WHERE ${where.join(' AND ')}`).get(params);
  },
  pendingIds: (scope, { maxAgeHours } = {}) => {
    const sc = scopeClause(scope), rc = recentClause(maxAgeHours);
    return db.prepare(`SELECT id FROM articles WHERE deleted = 0 AND status IN ('new','error') AND content IS NOT NULL AND length(content) > 200
                ${sc.sql} ${rc.sql} ORDER BY COALESCE(published_at, created_at) DESC LIMIT 50`).all(...sc.args, ...rc.args).map((r) => r.id);
  },
  // artigos que precisam ser baixados de novo: sem texto útil ou sem data de publicação
  weakArticles: (sourceId) =>
    db.prepare(`SELECT id, url, (content IS NULL OR length(content) <= 300) AS weak_content, (date_estimated = 1) AS no_date
                FROM articles
                WHERE source_id = ? AND deleted = 0 AND fix_tries < 2 AND ((status = 'new' AND (content IS NULL OR length(content) <= 300)) OR date_estimated = 1)
                ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20`).all(sourceId),
  noDateIds: (scope) => {
    const sc = scopeClause(scope);
    return db.prepare(`SELECT id FROM articles WHERE date_estimated = 1 AND deleted = 0 ${sc.sql}
                ORDER BY created_at DESC LIMIT 200`).all(...sc.args).map((r) => r.id);
  },
  bumpFixTries: (id) => db.prepare('UPDATE articles SET fix_tries = fix_tries + 1 WHERE id = ?').run(id),
  saveDate: (id, iso) =>
    db.prepare('UPDATE articles SET published_at = ?, date_estimated = 0 WHERE id = ? AND date_estimated = 1').run(iso, id),
  saveContent: (id, content) => db.prepare('UPDATE articles SET content = ? WHERE id = ?').run(content, id),
  saveTranslation: (id, t) =>
    db.prepare(`UPDATE articles SET title_pt=@title_pt, summary_pt=@summary_pt, content_pt=@content_pt,
                status='processed', error=NULL WHERE id=@id`).run({ id, ...t }),
  saveError: (id, err) => db.prepare("UPDATE articles SET status='error', error=? WHERE id=?").run(String(err), id),
  filteredDigestItems: (filter, limit) => { // notícias que passam nos filtros (grupo, período...), mais recentes primeiro
    const { where, params } = articleFilter(filter);
    return db.prepare(`SELECT a.id, a.title, a.title_pt, a.summary_pt, substr(a.content, 1, 400) AS snippet, s.name AS source
                FROM articles a JOIN sources s ON s.id = a.source_id
                WHERE ${where.join(' AND ')}
                ORDER BY datetime(COALESCE(a.published_at, a.created_at)) DESC LIMIT ${Number(limit)}`).all(params);
  },
  // ----- Início: resumo do dia/semana -----
  countSince: (since) =>
    db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT source_id) AS sources FROM articles
                WHERE deleted = 0 AND datetime(COALESCE(published_at, created_at)) >= datetime(?)`).get(since),
  // imagem de capa de cada artigo citado (id -> url)
  articleImages: (ids) =>
    ids.length ? db.prepare(`SELECT id, image FROM articles WHERE deleted = 0 AND image IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [],
  existingIds: (ids) =>
    ids.length ? db.prepare(`SELECT id FROM articles WHERE deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id) : [],
  getDigest: (key) => db.prepare('SELECT * FROM digests WHERE key = ?').get(key),
  saveDigest: (key, count, data) =>
    db.prepare(`INSERT INTO digests (key, article_count, data, generated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                ON CONFLICT(key) DO UPDATE SET article_count = excluded.article_count, data = excluded.data, generated_at = excluded.generated_at`)
      .run(key, count, JSON.stringify(data)),
  deleteArticle: (id) =>
    db.prepare(`UPDATE articles SET deleted = 1, content = NULL, content_pt = NULL, summary_pt = NULL WHERE id = ?`).run(id),
  markRead: (id) => db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(id),

  getSetting: (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null,
  setSetting: (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
};

module.exports = { init, q };
