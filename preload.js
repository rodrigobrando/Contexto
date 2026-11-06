const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => async (...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  listSources: call('sources:list'),
  addSource: call('sources:add'),
  renameSource: call('sources:rename'),
  listGroups: call('groups:list'),
  createGroup: call('groups:create'),
  renameGroup: call('groups:rename'),
  deleteGroup: call('groups:delete'),
  setGroupCollapsed: call('groups:collapse'),
  groupDigest: call('groups:digest'),
  groupSummarize: call('groups:summarize'),
  moveSource: call('sources:move'),
  removeSource: call('sources:remove'),
  refresh: call('sources:refresh'),
  listArticles: call('articles:list'),
  getArticle: call('articles:get'),
  refreshArticle: call('articles:refreshOne'),
  refreshDates: call('articles:refreshDates'),
  homeGet: call('home:get'),
  homeGroups: call('home:groups'),
  homeSummarizeAll: call('home:summarizeAll'),
  deleteArticle: call('articles:delete'),
  translate: call('articles:translate'),
  translatePending: call('articles:translatePending'),
  openExternal: call('open:external'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onRefreshStart: (cb) => ipcRenderer.on('refresh:start', () => cb()),
  onRefreshDone: (cb) => ipcRenderer.on('refresh:done', (_e, r) => cb(r)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m)),
});
