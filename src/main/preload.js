'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => { const h = (_e, data) => fn(data); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('studio', Object.freeze({
  info: call('studio:info'),
  project: Object.freeze({
    recent: call('project:recent'), create: call('project:create'), open: call('project:open'), save: call('project:save'),
    importScript: call('project:importScript'), exportScript: call('project:exportScript')
  }),
  file: Object.freeze({ write: call('file:write'), remove: call('file:delete'), exists: call('file:exists'), pickImport: call('file:pickImport'), show: call('file:show'), open: call('file:open'), diskFree: call('disk:free') }),
  rec: Object.freeze({ start: call('rec:start'), chunk: call('rec:chunk'), finish: call('rec:finish'), abort: call('rec:abort') }),
  media: Object.freeze({ analyze: call('media:analyze'), probe: call('media:probe') }),
  transcribe: call('transcribe:run'),
  onTranscribeProgress: on('transcribe:progress'),
  exporter: Object.freeze({ run: call('export:run'), cancel: call('export:cancel'), onProgress: on('export:progress') }),
  guest: Object.freeze({ displays: call('guest:displays'), open: call('guest:open'), close: call('guest:close'), isOpen: call('guest:isOpen'), onClosed: on('guest:closed') }),
  onBeforeClose: on('studio:before-close'),
  closeReady: () => ipcRenderer.send('studio:close-ready')
}));
