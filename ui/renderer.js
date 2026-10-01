const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const bookmarksEl = $('bookmarks');
const address = $('address');
const suggestionsEl = $('suggestions');
const reloadBtn = $('reload');
const findBar = $('find');
const findInput = $('find-input');

const ICON_SOUND = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM17 10l4 4M21 10l-4 4"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';

let state = { activeId: null, collapsed: false, tabs: [], bookmarks: [], downloads: { running: 0 } };
let shownActiveId = null;
let shownBookmarks = '';
let dragId = null;
let suggestions = [];
let selected = -1;

function el(tag, className, props = {}) {
  return Object.assign(document.createElement(tag), { className }, props);
}

function siteIcon(favicon, loading = false) {
  if (loading) return el('div', 'spinner');
  if (!favicon) return el('div', 'dot');
  const img = el('img', 'favicon', { src: favicon });
  img.onerror = () => img.replaceWith(el('div', 'dot'));
  return img;
}

function miniButton(icon, title, onClick) {
  const btn = el('button', 'mini', { innerHTML: icon, title });
  btn.onmousedown = (e) => e.stopPropagation();
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return btn;
}

// Aba ativa: pode ser uma aba normal ou uma aba fixada.
const activeTab = () => state.tabs.find((t) => t.id === state.activeId)
  || (state.pinned || []).map((p) => p.tab).find((t) => t && t.id === state.activeId);

// ---------- Abas ----------

function clearDropMarks() {
  for (const t of tabsEl.children) t.classList.remove('drop-before', 'drop-after');
}

// Cada aba tem um elemento fixo; a cada atualização só muda o que for diferente
// (sem recriar a lista inteira, então nada pisca e gasta bem menos processamento).
const tabEls = new Map(); // id da aba -> { item, icon, iconKey, title, audio, audioKey }

function createTabEl(id) {
  const item = el('div', 'tab', { draggable: true });
  const entry = {
    item,
    icon: el('div', 'dot'),
    iconKey: 'dot',
    title: el('span', 'title'),
    audio: el('span', 'audio-slot'),
    audioKey: '',
    twisty: el('button', 'twisty', { hidden: true }),
  };
  // Árvore de abas: recolhe/abre o ramo desta aba.
  entry.twisty.onmousedown = (e) => e.stopPropagation();
  entry.twisty.onclick = (e) => {
    e.stopPropagation();
    window.browser.toggleTree(id);
  };
  const close = miniButton(ICON_CLOSE, 'Fechar aba (Ctrl+W)', () => window.browser.closeTab(id));
  close.classList.add('close');
  item.append(entry.icon, entry.title, entry.twisty, entry.audio, close);

  item.onmousedown = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      window.browser.closeTab(id); // botão do meio fecha
    } else if (e.button === 0) {
      window.browser.activate(id);
    }
  };

  item.oncontextmenu = (e) => {
    e.preventDefault();
    window.browser.tabMenu(id);
  };

  // Arrastar para reorganizar.
  item.ondragstart = (e) => {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.title.textContent); // necessário para soltar sobre a página
    item.classList.add('dragging');
    window.browser.splitDragStart(id); // mostra as zonas de "dividir tela" sobre a página
  };
  item.ondragend = () => {
    window.browser.splitDragEnd();
    dragId = null;
    item.classList.remove('dragging');
    clearDropMarks();
    render(); // aplica atualizações que chegaram durante o arrasto
  };
  item.ondragover = (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const box = item.getBoundingClientRect();
    clearDropMarks();
    item.classList.add(e.clientY > box.top + box.height / 2 ? 'drop-after' : 'drop-before');
  };
  item.ondrop = (e) => {
    e.preventDefault();
    if (dragId === null) return;
    const box = item.getBoundingClientRect();
    const index = state.tabs.findIndex((t) => t.id === id);
    let target = index + (e.clientY > box.top + box.height / 2 ? 1 : 0);
    const from = state.tabs.findIndex((t) => t.id === dragId);
    if (from < target) target -= 1;
    window.browser.moveTab(dragId, target);
  };
  return entry;
}

function updateTabEl(entry, tab) {
  const { item } = entry;
  item.classList.toggle('active', tab.id === state.activeId);
  item.classList.toggle('sleeping', Boolean(tab.sleeping));
  // Tela dividida: marca as duas abas (a barra à esquerda mostra de que lado está).
  item.classList.toggle('split', Boolean(tab.split));
  item.classList.toggle('split-column', tab.split?.dir === 'column');
  const tooltip = tab.url ? `${tab.title}\n${tab.url}` : tab.title;
  if (item.title !== tooltip) item.title = tooltip;
  if (entry.title.textContent !== tab.title) entry.title.textContent = tab.title;

  // Ícone: lobo (nova aba / páginas internas), carregando, ícone do site ou ponto.
  const internal = !tab.url || tab.url.startsWith('wolf://');
  const iconKey = tab.loading ? 'spin' : internal ? 'wolf' : tab.favicon || 'dot';
  if (iconKey !== entry.iconKey) {
    const icon = iconKey === 'wolf'
      ? el('img', 'favicon wolf-icon', { src: 'assets/wolf-128.png' })
      : siteIcon(iconKey === 'dot' ? null : tab.favicon, tab.loading);
    if (icon.tagName === 'IMG' && iconKey !== 'wolf') {
      icon.onerror = () => {
        const dot = el('div', 'dot');
        icon.replaceWith(dot);
        if (entry.icon === icon) entry.icon = dot;
      };
    }
    entry.icon.replaceWith(icon);
    entry.icon = icon;
    entry.iconKey = iconKey;
  }

  const audioKey = tab.muted ? 'muted' : tab.audible ? 'sound' : '';
  if (audioKey !== entry.audioKey) {
    entry.audio.replaceChildren();
    if (audioKey) {
      const audio = miniButton(tab.muted ? ICON_MUTED : ICON_SOUND,
        tab.muted ? 'Ativar som' : 'Silenciar aba', () => window.browser.toggleMute(tab.id));
      if (!tab.muted) audio.classList.add('audio');
      entry.audio.append(audio);
    }
    entry.audioKey = audioKey;
  }
}

// ---------- Barra lateral personalizada ----------

const SECTION_ELS = {
  brand: ['#brand'],
  nav: ['#nav'],
  address: ['#address-form', '#popup-bar', '#translate-bar', '#find'],
  extensions: ['#extension-actions'],
  bookmarks: ['#bookmarks-section'],
  spaces: ['#spaces'],
  pinned: ['#pinned'],
  tabs: ['.divider', '#tabs-scroll'],
  footer: ['#footer'],
};
const ITEM_ELS = { label: '.divider', newTab: '#new-tab', back: '#back', forward: '#forward', reload: '#reload', home: '#home' };
let layoutKey = '';

function applySidebarLayout(layout) {
  if (!layout) return;
  const key = JSON.stringify(layout);
  if (key === layoutKey) return;
  layoutKey = key;
  const hidden = new Set(layout.hidden);
  const all = (selector) => document.querySelectorAll(selector);
  layout.sections.forEach((id, i) => {
    for (const selector of SECTION_ELS[id] || []) {
      for (const node of all(selector)) {
        node.style.order = i;
        node.classList.toggle('cz-hidden', hidden.has(id));
      }
    }
  });
  for (const [id, selector] of Object.entries(ITEM_ELS)) {
    for (const node of all(selector)) node.classList.toggle('cz-hidden', hidden.has(id) || (id === 'label' && hidden.has('tabs')));
  }
  layout.footer.forEach((id, i) => {
    const button = document.getElementById(`open-${id}`);
    if (!button) return;
    button.style.order = i;
    button.classList.toggle('cz-hidden', hidden.has(`f:${id}`));
  });
}

// ---------- Árvore de abas / agrupar por site ----------

const groupEls = new Map(); // site -> { item, name, count }
let closedGroups = new Set();
try {
  closedGroups = new Set(JSON.parse(localStorage.getItem('closedGroups') || '[]'));
} catch { /* sem armazenamento: começa tudo aberto */ }

function siteOf(tab) {
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

function groupEl(site) {
  let entry = groupEls.get(site);
  if (entry) return entry;
  const item = el('div', 'tab-group');
  entry = { item, name: el('span', 'group-name', { textContent: site }), count: el('span', 'group-count') };
  const arrow = el('span', 'group-arrow');
  arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>';
  item.append(arrow, entry.name, entry.count);
  item.onclick = () => {
    if (closedGroups.has(site)) closedGroups.delete(site);
    else closedGroups.add(site);
    try {
      localStorage.setItem('closedGroups', JSON.stringify([...closedGroups]));
    } catch { /* ignora */ }
    render();
  };
  groupEls.set(site, entry);
  return entry;
}

// Monta as linhas na ordem em que aparecem: { tab, depth, kids, hidden } ou { group, count, closed, active }.
function tabRows() {
  const mode = state.tabGrouping || 'off';
  const list = state.tabs;
  if (mode === 'tree') {
    const ids = new Set(list.map((t) => t.id));
    const kids = new Map();
    const roots = [];
    for (const t of list) {
      if (t.parentId !== null && t.parentId !== undefined && ids.has(t.parentId)) {
        if (!kids.has(t.parentId)) kids.set(t.parentId, []);
        kids.get(t.parentId).push(t);
      } else roots.push(t);
    }
    const rows = [];
    const count = (t) => (kids.get(t.id) || []).reduce((n, k) => n + 1 + count(k), 0);
    const walk = (t, depth, hidden) => {
      rows.push({ tab: t, depth, kids: count(t), hidden });
      for (const k of kids.get(t.id) || []) walk(k, depth + 1, hidden || t.treeCollapsed);
    };
    for (const t of roots) walk(t, 0, false);
    return rows;
  }
  if (mode === 'site') {
    const groups = new Map();
    for (const t of list) {
      const site = siteOf(t);
      if (!site) continue;
      if (!groups.has(site)) groups.set(site, []);
      groups.get(site).push(t);
    }
    const rows = [];
    const done = new Set();
    for (const t of list) {
      const site = siteOf(t);
      const members = site ? groups.get(site) : null;
      if (!members || members.length < 2) {
        rows.push({ tab: t, depth: 0, kids: 0, hidden: false });
      } else if (!done.has(site)) {
        done.add(site);
        const closed = closedGroups.has(site);
        rows.push({ group: site, count: members.length, closed, active: members.some((m) => m.id === state.activeId) });
        for (const m of members) rows.push({ tab: m, depth: 1, kids: 0, hidden: closed });
      }
    }
    return rows;
  }
  return list.map((t) => ({ tab: t, depth: 0, kids: 0, hidden: false }));
}

function syncTabs() {
  const seen = new Set();
  const seenGroups = new Set();
  const rows = tabRows();
  const items = [];
  for (const row of rows) {
    if (row.group) {
      const g = groupEl(row.group);
      g.item.classList.toggle('closed', row.closed);
      g.item.classList.toggle('has-active', row.active && row.closed);
      g.item.title = `${row.group} — ${row.count} abas\nClique para ${row.closed ? 'abrir' : 'recolher'} o grupo`;
      const text = String(row.count);
      if (g.count.textContent !== text) g.count.textContent = text;
      seenGroups.add(row.group);
      items.push(g.item);
      continue;
    }
    const { tab } = row;
    let entry = tabEls.get(tab.id);
    if (!entry) {
      entry = createTabEl(tab.id);
      tabEls.set(tab.id, entry);
    }
    updateTabEl(entry, tab);
    entry.item.hidden = row.hidden;
    entry.item.style.setProperty('--depth', Math.min(row.depth, 5));
    entry.item.classList.toggle('child', row.depth > 0);
    entry.twisty.hidden = row.kids === 0;
    if (row.kids) {
      entry.twisty.classList.toggle('closed', tab.treeCollapsed);
      entry.twisty.textContent = tab.treeCollapsed ? `+${row.kids}` : '';
      entry.twisty.title = tab.treeCollapsed ? `Mostrar ${row.kids} aba(s) deste ramo` : 'Recolher o ramo';
    }
    seen.add(tab.id);
    items.push(entry.item);
  }
  for (const [id, entry] of tabEls) {
    if (!seen.has(id)) {
      entry.item.remove();
      tabEls.delete(id);
    }
  }
  for (const [site, entry] of groupEls) {
    if (!seenGroups.has(site)) {
      entry.item.remove();
      groupEls.delete(site);
    }
  }
  // Só move no DOM o que mudou de posição.
  let previous = null;
  for (const item of items) {
    const expected = previous ? previous.nextSibling : tabsEl.firstChild;
    if (item !== expected) tabsEl.insertBefore(item, expected);
    previous = item;
  }
}

// ---------- Favoritos ----------

function renderBookmark(bookmark) {
  const item = el('div', 'bookmark', { title: `${bookmark.title}\n${bookmark.url}` });
  const letter = () => el('span', 'letter', { textContent: (bookmark.title || '?').trim()[0]?.toUpperCase() || '?' });
  if (bookmark.favicon) {
    const img = el('img', 'favicon', { src: bookmark.favicon });
    img.onerror = () => img.replaceWith(letter());
    item.append(img);
  } else {
    item.append(letter());
  }
  item.onmousedown = (e) => {
    if (e.button === 1) e.preventDefault();
  };
  item.onmouseup = (e) => {
    // Clique abre na aba atual; Ctrl+clique ou botão do meio abre em nova aba.
    if (e.button === 0) window.browser.openBookmark(bookmark.url, e.ctrlKey);
    else if (e.button === 1) window.browser.openBookmark(bookmark.url, true);
  };
  return item;
}

// ---------- Abas fixadas ----------

let shownPinned = '';
let dragPin = null;
const PIN_MARK = '<svg class="pin-mark" viewBox="0 0 24 24"><path d="M15 3l6 6-3 1-4 4 1 4-2 2-4-4-5 5M9 11L4 6l3-1 4-4"/></svg>';

function renderPinned() {
  const list = state.pinned || [];
  const key = JSON.stringify([list, state.activeId]);
  if (key === shownPinned || dragId !== null || dragPin !== null) return;
  shownPinned = key;
  $('pinned').replaceChildren(...list.map((pin, index) => {
    const tab = pin.tab;
    const active = tab && tab.id === state.activeId;
    const item = el('div', `tab pin${active ? ' active' : ''}${tab ? '' : ' closed'}`, {
      title: `${pin.title}\n${pin.url}${tab ? '' : '\n(fechada — clique para abrir)'}`,
      draggable: true,
    });
    const icon = tab?.loading ? el('div', 'spinner') : siteIcon(tab?.favicon || pin.favicon);
    item.append(icon, el('span', 'title', { textContent: pin.title }));
    if (tab) {
      const close = miniButton(ICON_CLOSE, 'Fechar a aba (o atalho continua)', () => window.browser.closePin(pin.id));
      close.classList.add('close');
      item.append(close);
    } else {
      item.insertAdjacentHTML('beforeend', PIN_MARK);
    }
    item.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.browser.closePin(pin.id);
      } else if (e.button === 0) {
        window.browser.openPin(pin.id);
      }
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      window.browser.pinMenu(pin.id);
    };
    // Reordenar arrastando.
    item.ondragstart = (e) => {
      dragPin = pin.id;
      e.dataTransfer.effectAllowed = 'move';
    };
    item.ondragend = () => {
      dragPin = null;
      render();
    };
    item.ondragover = (e) => {
      if (dragPin) e.preventDefault();
    };
    item.ondrop = (e) => {
      if (!dragPin) return;
      e.preventDefault();
      e.stopPropagation();
      window.browser.movePin(dragPin, index);
    };
    return item;
  }));
}

// Arrastar uma aba normal para cima das fixadas: fixa a aba.
const pinnedEl = $('pinned');
const spacesEl = $('spaces');
for (const target of [pinnedEl, spacesEl]) {
  target.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    pinnedEl.classList.add('drop-here');
  });
  target.addEventListener('dragleave', () => pinnedEl.classList.remove('drop-here'));
  target.addEventListener('drop', (e) => {
    pinnedEl.classList.remove('drop-here');
    if (dragId === null) return;
    e.preventDefault();
    window.browser.pinTab(dragId);
  });
}

// ---------- Espaços ----------

let shownSpaces = '';
let shownSpace = null;
function renderSpaces() {
  const list = state.spaces || [];
  const key = JSON.stringify([list, state.activeSpace]);
  if (key === shownSpaces) return;
  shownSpaces = key;
  const current = list.find((sp) => sp.id === state.activeSpace);
  $('space-name').textContent = current ? `${current.icon} ${current.name}` : 'Abas';

  const buttons = list.map((sp, i) => {
    const b = el('button', `space${sp.id === state.activeSpace ? ' on' : ''}`, {
      textContent: sp.icon,
      title: `${sp.name} · ${sp.tabs} aba(s)\nCtrl+Alt+${i + 1} · botão direito: opções`,
    });
    if (sp.tabs && sp.id !== state.activeSpace) b.append(el('span', 'dot-count'));
    // Barra recolhida: só o espaço atual aparece; clicar nele mostra a lista.
    b.onclick = () => (state.collapsed && sp.id === state.activeSpace ? window.browser.spacePicker() : window.browser.switchSpace(sp.id));
    b.oncontextmenu = (e) => {
      e.preventDefault();
      window.browser.spaceMenu(sp.id);
    };
    return b;
  });
  const add = el('button', 'space add', { textContent: '+', title: 'Novo espaço / editar espaços' });
  add.onclick = () => window.browser.manageSpaces();
  $('spaces').replaceChildren(...buttons, add);

  // Ícones das extensões do espaço atual.
  $('extension-actions').setAttribute('partition', state.partition || '');

  // Animação ao trocar de espaço (para a direita ou esquerda conforme a ordem).
  if (shownSpace && shownSpace !== state.activeSpace) {
    const from = list.findIndex((sp) => sp.id === shownSpace);
    const to = list.findIndex((sp) => sp.id === state.activeSpace);
    tabsEl.style.setProperty('--space-dir', `${to > from ? 12 : -12}px`);
    tabsEl.classList.remove('switching');
    void tabsEl.offsetWidth;
    tabsEl.classList.add('switching');
  }
  shownSpace = state.activeSpace;
}

// Deslizar para o lado no touchpad (sobre a barra lateral) troca de espaço.
let swipe = 0;
let swipeLock = 0;
document.getElementById('sidebar').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  swipe += e.deltaX;
  if (Date.now() < swipeLock) return;
  if (Math.abs(swipe) > 120) {
    window.browser.cycleSpace(swipe > 0 ? 1 : -1);
    swipe = 0;
    swipeLock = Date.now() + 600;
  }
}, { passive: true });

// ---------- Desenho geral ----------

// Aplica as cores do tema na hora (sem recarregar a barra).
let shownTheme = '';
function applyTheme(theme) {
  const key = JSON.stringify(theme);
  if (!theme || key === shownTheme) return;
  shownTheme = key;
  const root = document.documentElement.style;
  root.setProperty('--frame', theme.frame);
  root.setProperty('--raised', theme.surface);
  root.setProperty('--raised-2', theme.surface2);
  root.setProperty('--text', theme.text);
  root.setProperty('--text-dim', theme.dim);
  root.setProperty('--accent', theme.accent);
}

function render() {
  applyTheme(state.theme);
  document.body.classList.toggle('compact', state.tabDensity === 'compact');
  applySidebarLayout(state.sidebarLayout);
  document.body.classList.toggle('collapsed', state.collapsed);
  $('toggle').title = state.sidebar?.floating ? 'Fixar barra aberta (Ctrl+B)' : 'Recolher barra (Ctrl+B)';
  document.body.classList.toggle('floating', Boolean(state.sidebar?.floating));
  $('logo').title = state.collapsed ? 'Expandir barra (Ctrl+B)' : 'Página inicial';

  renderSpaces();
  renderPinned();

  // Durante um arrasto, mexer na lista cancelaria o movimento.
  if (dragId === null) syncTabs();

  // Barra recolhida mostra o mesmo número de linhas de favoritos da grade expandida.
  const columns = Math.max(1, Math.floor(((state.sidebarWidth || 272) - 20 + 6) / 50));
  document.body.style.setProperty('--bm-rows', Math.max(1, Math.ceil(state.bookmarks.length / columns)));

  // Favoritos só são redesenhados quando mudam.
  const bookmarksKey = JSON.stringify(state.bookmarks);
  if (bookmarksKey !== shownBookmarks) {
    shownBookmarks = bookmarksKey;
    $('bookmarks-section').hidden = state.bookmarks.length === 0;
    bookmarksEl.replaceChildren(...state.bookmarks.map(renderBookmark));
  }

  document.body.classList.toggle('url-top', state.urlBar?.position === 'top');
  $('open-ai').classList.toggle('ai-on', Boolean(state.ai?.open));

  // Mini player: animado quando algo está tocando.
  const media = state.media || { count: 0, playing: 0 };
  $('open-media').classList.toggle('playing', media.playing > 0);
  $('open-media').classList.toggle('has-media', media.count > 0);
  $('open-media').title = media.playing ? `${media.playing} tocando` : media.count ? 'Mídia pausada' : 'Nada tocando';

  const running = state.downloads.running;
  $('downloads-badge').hidden = running === 0;
  $('downloads-badge').textContent = running;
  $('open-downloads').classList.toggle('active', running > 0);
  for (const name of ['history', 'downloads', 'bookmarks', 'extensions', 'settings', 'media']) {
    $(`open-${name}`).classList.toggle('on', state.panel === name);
  }

  const tab = activeTab();
  if (!tab) return;
  $('back').disabled = !tab.canGoBack;
  $('forward').disabled = !tab.canGoForward;
  reloadBtn.classList.toggle('loading', tab.loading);
  reloadBtn.title = tab.loading ? 'Parar' : 'Recarregar (Ctrl+R)';

  $('zoom').hidden = tab.zoom === 100;
  $('zoom').textContent = `${tab.zoom}%`;

  // Tradução da página
  const tr = tab.translation;
  const trBar = $('translate-bar');
  trBar.hidden = !tr;
  if (tr) {
    const names = new Intl.DisplayNames(['pt-BR'], { type: 'language' });
    const name = (code) => {
      try {
        return names.of(code).toLowerCase();
      } catch {
        return code;
      }
    };
    trBar.classList.toggle('error', Boolean(tr.error));
    trBar.classList.toggle('busy', !tr.source && !tr.error);
    let text;
    if (tr.error) text = `Não foi possível traduzir (${tr.error})`;
    else if (!tr.source) text = 'Traduzindo…';
    else if (tr.original) text = `Original em ${name(tr.source)}`;
    else text = `Traduzido do ${name(tr.source)}`;
    $('translate-text').textContent = text;
    $('translate-text').title = text;
    $('translate-toggle').textContent = tr.original ? 'Traduzir' : 'Original';
    $('translate-toggle').hidden = Boolean(tr.error);
  }

  // Escudo: quantos anúncios/rastreadores foram bloqueados nesta página.
  const shield = $('shield');
  shield.hidden = tab.adblock === null || tab.adblock === undefined;
  shield.classList.toggle('off', tab.adblock === false);
  const { ads = 0, trackers = 0 } = tab.blocked || {};
  const total = ads + trackers;
  $('blocked-count').textContent = tab.adblock && total ? (total > 99 ? '99+' : total) : '';
  shield.title = tab.adblock
    ? `Proteção ativa neste site\n${ads} anúncio(s) e ${trackers} rastreador(es) bloqueados\nClique para desligar a proteção neste site`
    : 'Proteção desligada neste site\nClique para ligar';

  // Pop-up bloqueado nesta página
  const popup = tab.blockedPopup;
  $('popup-bar').hidden = !popup;
  if (popup) {
    let host = '';
    try {
      host = new URL(popup.url).hostname.replace(/^www\./, '');
    } catch {
      // endereço vazio ou relativo
    }
    const text = `${popup.count > 1 ? `${popup.count} pop-ups bloqueados` : 'Pop-up bloqueado'}${host ? ` · ${host}` : ''}`;
    $('popup-text').textContent = text;
    $('popup-text').title = popup.url;
    $('popup-open').hidden = !/^https?:/.test(popup.url);
  }

  const bookmarked = state.bookmarks.some((b) => b.url === tab.url);
  $('star').classList.toggle('on', bookmarked);
  $('star').hidden = !/^https?:/.test(tab.url);
  $('star').title = bookmarked ? 'Remover dos favoritos (Ctrl+D)' : 'Adicionar aos favoritos (Ctrl+D)';

  // Não apaga o que o usuário está digitando, a não ser que ele troque de aba.
  const switched = shownActiveId !== state.activeId;
  if (switched || document.activeElement !== address) {
    address.value = displayUrl(tab.url);
    renderSiteIcon(tab.url);
  }
  if (switched) tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest' });
  shownActiveId = state.activeId;
}

window.browser.onState((s) => {
  const wasFloating = state.sidebar?.floating;
  state = s;
  render();
  // Animação suave dos textos quando a barra abre por cima da página.
  if (state.sidebar.floating && !wasFloating) {
    document.body.classList.remove('reveal');
    void document.body.offsetWidth;
    document.body.classList.add('reveal');
  }
  if (!state.sidebar.floating) document.body.classList.remove('reveal');
});

// ---------- Barra automática (abre com o mouse em cima) ----------

let pointerInside = false;
let hoverTimer = null;
const typing = () => ['address', 'find-input'].includes(document.activeElement?.id);

function scheduleHover(fn, ms) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(fn, ms);
}

// Recolhe a barra aberta por cima, se o mouse saiu e ninguém está digitando nela.
function maybeCollapse() {
  clearTimeout(hoverTimer);
  if (!state.sidebar?.floating || pointerInside || typing()) return;
  scheduleHover(() => {
    if (!pointerInside && !typing()) window.browser.setHover(false);
  }, state.sidebar.collapseDelay);
}

document.documentElement.addEventListener('mouseenter', () => {
  pointerInside = true;
  clearTimeout(hoverTimer);
  if (state.sidebar?.mode === 'auto' && state.collapsed) {
    scheduleHover(() => {
      if (pointerInside) window.browser.setHover(true);
    }, state.sidebar.expandDelay);
  }
});
document.documentElement.addEventListener('mouseleave', () => {
  pointerInside = false;
  maybeCollapse();
});
for (const input of [address, findInput]) {
  input.addEventListener('blur', () => setTimeout(maybeCollapse, 0));
}

// ---------- Barra de endereço e sugestões ----------

const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ICON_UNLOCKED = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
const ICON_WOLF = '<img src="assets/wolf-128.png" alt="">';

// Como o Firefox: sem "https://" e sem a barra final enquanto não está editando.
function displayUrl(url) {
  if (!/^https?:\/\//.test(url)) return url;
  return url.replace(/^https:\/\//, '').replace(/^(http:\/\/[^/]+|[^/]+)\/$/, '$1');
}

function renderSiteIcon(url) {
  const icon = $('site-icon');
  if (url.startsWith('https://')) {
    icon.innerHTML = ICON_LOCK;
    icon.title = 'Conexão segura';
    icon.className = 'secure';
  } else if (url.startsWith('http://')) {
    icon.innerHTML = ICON_UNLOCKED;
    icon.title = 'Conexão não segura';
    icon.className = 'insecure';
  } else if (url.startsWith('wolf://')) {
    icon.innerHTML = ICON_WOLF;
    icon.title = 'Página do Wolf Browser';
    icon.className = '';
  } else {
    icon.innerHTML = ICON_SEARCH;
    icon.title = '';
    icon.className = '';
  }
}
renderSiteIcon('');

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestions = [];
  selected = -1;
}

function renderSuggestions() {
  suggestionsEl.hidden = suggestions.length === 0;
  suggestionsEl.replaceChildren(...suggestions.map((s, i) => {
    const li = el('li', (s.type === 'bookmark' ? 'is-bookmark ' : '') + (i === selected ? 'selected' : ''));
    li.append(el('span', 's-title', { textContent: s.title }), el('span', 's-url', { textContent: s.url }));
    li.onmousedown = (e) => {
      e.preventDefault(); // não deixa o campo perder o foco antes do clique
      go(s.url);
    };
    return li;
  }));
}

let suggestRequest = 0;
address.oninput = async () => {
  const request = ++suggestRequest;
  const results = await window.browser.suggest(address.value);
  if (request !== suggestRequest || document.activeElement !== address) return;
  suggestions = results;
  selected = -1;
  renderSuggestions();
};

function go(text) {
  hideSuggestions();
  window.browser.go(text);
  address.blur();
}

$('address-form').onsubmit = (e) => {
  e.preventDefault();
  go(selected >= 0 ? suggestions[selected].url : address.value);
};
// Com o foco, mostra o endereço completo para editar.
address.onfocus = () => {
  address.value = activeTab()?.url ?? '';
  renderSiteIcon('');
  address.select();
};
address.onblur = () => {
  hideSuggestions();
  const url = activeTab()?.url ?? '';
  if (address.value === url) address.value = displayUrl(url);
  renderSiteIcon(url);
};
address.onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    selected = (selected + step + suggestions.length + 1) % (suggestions.length + 1);
    if (selected === suggestions.length) selected = -1;
    renderSuggestions();
  } else if (e.key === 'Escape') {
    if (!suggestionsEl.hidden) {
      hideSuggestions();
      return;
    }
    address.value = activeTab()?.url ?? '';
    address.blur();
  }
};

window.browser.onFocusAddress(() => {
  address.focus();
  address.select();
});

// ---------- Procurar na página ----------

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) window.browser.find(findInput.value, { newSearch: true });
}

function closeFind() {
  if (findBar.hidden) return;
  findBar.hidden = true;
  $('find-count').textContent = '';
  findBar.classList.remove('none');
  window.browser.stopFind();
}

findInput.oninput = () => window.browser.find(findInput.value, { newSearch: true });
findInput.onkeydown = (e) => {
  if (e.key === 'Enter') window.browser.find(findInput.value, { forward: !e.shiftKey });
  else if (e.key === 'Escape') closeFind();
};
$('find-next').onclick = () => window.browser.find(findInput.value, { forward: true });
$('find-prev').onclick = () => window.browser.find(findInput.value, { forward: false });
$('find-close').onclick = closeFind;

window.browser.onFindOpen(openFind);
window.browser.onFindClose(() => {
  findBar.hidden = true;
  $('find-count').textContent = '';
});
window.browser.onFindResult(({ active, matches }) => {
  $('find-count').textContent = findInput.value ? `${active}/${matches}` : '';
  findBar.classList.toggle('none', Boolean(findInput.value) && matches === 0);
});

// ---------- Botões ----------

$('toggle').onclick = () => window.browser.toggleSidebar();
$('logo').onclick = () => {
  if (state.collapsed) window.browser.toggleSidebar();
  else window.browser.home();
};
$('new-tab').onclick = () => window.browser.newTab();
$('back').onclick = () => window.browser.back();
$('forward').onclick = () => window.browser.forward();
$('home').onclick = () => window.browser.home();
$('zoom').onclick = () => window.browser.resetZoom();
$('star').onclick = () => window.browser.toggleBookmark();
$('shield').onclick = () => window.browser.toggleAdblockSite();
// Barra recolhida: clicar no ícone da barra de endereço abre a barra para digitar.
$('address-form').addEventListener('mousedown', (e) => {
  if (!state.collapsed) return;
  e.preventDefault();
  window.browser.focusAddress();
});
$('popup-open').onclick = () => window.browser.openPopup();
$('popup-dismiss').onclick = () => window.browser.dismissPopup();
$('translate-toggle').onclick = () => window.browser.toggleTranslation();
$('translate-stop').onclick = () => window.browser.stopTranslate();
$('open-history').onclick = () => window.browser.togglePanel('history');
$('open-downloads').onclick = () => window.browser.togglePanel('downloads');
$('open-bookmarks').onclick = () => window.browser.togglePanel('bookmarks');
$('open-settings').onclick = () => window.browser.togglePanel('settings');
$('open-media').onclick = () => window.browser.togglePanel('media');
$('open-ai').onclick = () => window.browser.toggleAi();
$('open-extensions').onclick = () => window.browser.togglePanel('extensions');
reloadBtn.onclick = () => {
  if (reloadBtn.classList.contains('loading')) window.browser.stop();
  else window.browser.reload();
};
