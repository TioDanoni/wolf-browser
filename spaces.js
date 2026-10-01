const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');
const { JsonStore } = require('./store');

// Espaços: ambientes separados (Pessoal, Trabalho, Desenvolvimento...).
// Cada espaço tem sessão própria (cookies, logins, cache), histórico e favoritos.
// O espaço "pessoal" usa a sessão e os arquivos originais do navegador.

const DEFAULT_SPACE_ID = 'pessoal';
const DEFAULT_SPACES = [{ id: DEFAULT_SPACE_ID, name: 'Pessoal', icon: '🐺', color: null }];

// Criado só quando usado (depois de o navegador escolher a pasta de dados).
let store = null;
function spacesStore() {
  if (!store) {
    store = new JsonStore('spaces', { items: DEFAULT_SPACES, active: DEFAULT_SPACE_ID });
    if (!store.data.items.length) store.data.items = structuredClone(DEFAULT_SPACES);
  }
  return store;
}

const dataCache = new Map(); // id -> { history, bookmarks }

const listSpaces = () => spacesStore().data.items;
const getSpace = (id) => spacesStore().data.items.find((s) => s.id === id);
const fileSuffix = (id) => (id === DEFAULT_SPACE_ID ? '' : `-${id}`);

// Histórico e favoritos de cada espaço (carregados quando precisar).
function spaceData(id) {
  if (!dataCache.has(id)) {
    dataCache.set(id, {
      history: new JsonStore(`history${fileSuffix(id)}`, { items: [] }, { delay: 3000 }),
      bookmarks: new JsonStore(`bookmarks${fileSuffix(id)}`, { items: [] }),
      pinned: new JsonStore(`pinned${fileSuffix(id)}`, { items: [] }), // abas fixadas
    });
  }
  return dataCache.get(id);
}

// Sessão do Chromium de cada espaço.
function sessionOf(id) {
  return id === DEFAULT_SPACE_ID ? session.defaultSession : session.fromPartition(`persist:space-${id}`);
}

// Nome da partição usado pelos ícones das extensões na barra lateral.
const partitionOf = (id) => (id === DEFAULT_SPACE_ID ? '' : `persist:space-${id}`);

function makeId(name) {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'espaco';
  let id = base;
  for (let i = 2; getSpace(id); i++) id = `${base}-${i}`;
  return id;
}

function addSpace({ name, icon, color }) {
  const space = {
    id: makeId(String(name || 'Espaço')),
    name: String(name || 'Novo espaço').slice(0, 30),
    icon: String(icon || '✨').slice(0, 8),
    color: /^#[0-9a-f]{6}$/i.test(String(color)) ? color : null,
  };
  spacesStore().data.items.push(space);
  spacesStore().save();
  return space;
}

function updateSpace(id, changes) {
  const space = getSpace(id);
  if (!space) return null;
  if (typeof changes.name === 'string' && changes.name.trim()) space.name = changes.name.trim().slice(0, 30);
  if (typeof changes.icon === 'string' && changes.icon.trim()) space.icon = changes.icon.trim().slice(0, 8);
  if (changes.color === null || /^#[0-9a-f]{6}$/i.test(String(changes.color))) space.color = changes.color ?? null;
  spacesStore().save();
  return space;
}

function moveSpace(id, step) {
  const items = spacesStore().data.items;
  const from = items.findIndex((s) => s.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= items.length) return;
  const [space] = items.splice(from, 1);
  items.splice(to, 0, space);
  spacesStore().save();
}

// Apaga o espaço e tudo dele (cookies, cache, histórico, favoritos). O "Pessoal" não pode ser apagado.
async function deleteSpace(id) {
  if (id === DEFAULT_SPACE_ID || !getSpace(id)) return false;
  const ses = sessionOf(id);
  await ses.clearStorageData().catch(() => {});
  await ses.clearCache().catch(() => {});
  const data = dataCache.get(id);
  if (data) {
    for (const dataStore of [data.history, data.bookmarks, data.pinned]) {
      dataStore.deleted = true;
      clearTimeout(dataStore.timer);
    }
    dataCache.delete(id);
  }
  for (const name of ['history', 'bookmarks', 'pinned']) {
    fs.promises.rm(path.join(app.getPath('userData'), `${name}${fileSuffix(id)}.json`), { force: true }).catch(() => {});
  }
  spacesStore().data.items = spacesStore().data.items.filter((s) => s.id !== id);
  if (spacesStore().data.active === id) spacesStore().data.active = DEFAULT_SPACE_ID;
  spacesStore().save();
  return true;
}

module.exports = {
  DEFAULT_SPACE_ID,
  spacesStore,
  listSpaces,
  getSpace,
  spaceData,
  sessionOf,
  partitionOf,
  addSpace,
  updateSpace,
  moveSpace,
  deleteSpace,
};
