// Barra de endereço no topo (gota).
const $ = (id) => document.getElementById(id);
const address = $('address');
const list = $('suggestions');

const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ICON_UNLOCKED = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';

let state = null;
let shownActiveId = null;
let suggestions = [];
let selected = -1;
let pointerInside = false;

const el = (tag, className, props = {}) => Object.assign(document.createElement(tag), { className }, props);

const activeTab = () => state && (state.tabs.find((t) => t.id === state.activeId)
  || (state.pinned || []).map((p) => p.tab).find((t) => t && t.id === state.activeId));

function displayUrl(url) {
  if (!/^https?:\/\//.test(url)) return url;
  return url.replace(/^https:\/\//, '').replace(/^(http:\/\/[^/]+|[^/]+)\/$/, '$1');
}

function renderSiteIcon(url) {
  const icon = $('site-icon');
  icon.className = '';
  if (url.startsWith('https://')) {
    icon.innerHTML = ICON_LOCK;
    icon.className = 'secure';
  } else if (url.startsWith('http://')) {
    icon.innerHTML = ICON_UNLOCKED;
    icon.className = 'insecure';
  } else if (url.startsWith('wolf://')) {
    icon.innerHTML = '<img src="assets/wolf-128.png" alt="">';
  } else {
    icon.innerHTML = ICON_SEARCH;
  }
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  root.setProperty('--frame', theme.frame);
  root.setProperty('--raised', theme.surface);
  root.setProperty('--raised-2', theme.surface2);
  root.setProperty('--text', theme.text);
  root.setProperty('--text-dim', theme.dim);
  root.setProperty('--accent', theme.accent);
}

window.browser.onState((s) => {
  state = s;
  applyTheme(s.theme);
  const bar = s.urlBar || {};
  document.body.classList.toggle('mode-always', bar.visibility === 'always');
  document.body.classList.toggle('mode-hover', bar.visibility !== 'always');
  document.body.classList.toggle('hidden', !bar.shown);

  const tab = activeTab();
  if (!tab) return;
  const switched = shownActiveId !== s.activeId;
  if (switched || document.activeElement !== address) {
    address.value = displayUrl(tab.url);
    renderSiteIcon(tab.url);
  }
  shownActiveId = s.activeId;

  const shield = $('shield');
  shield.hidden = tab.adblock === null || tab.adblock === undefined;
  shield.classList.toggle('off', tab.adblock === false);
  const { ads = 0, trackers = 0 } = tab.blocked || {};
  const total = ads + trackers;
  $('blocked-count').textContent = tab.adblock && total ? (total > 99 ? '99+' : total) : '';
  shield.title = tab.adblock
    ? `Proteção ativa neste site\n${ads} anúncio(s) e ${trackers} rastreador(es) bloqueados\nClique para desligar a proteção neste site`
    : 'Proteção desligada neste site\nClique para ligar';

  const bookmarked = s.bookmarks.some((b) => b.url === tab.url);
  $('star').classList.toggle('on', bookmarked);
  $('star').hidden = !/^https?:/.test(tab.url);
});

// ---------- Mostrar / esconder com o mouse ----------

document.documentElement.addEventListener('mouseenter', () => {
  pointerInside = true;
  window.browser.hover(true);
});
document.documentElement.addEventListener('mouseleave', () => {
  pointerInside = false;
  // Digitando: continua aberta até terminar.
  if (document.activeElement !== address) window.browser.hover(false);
});

// ---------- Sugestões ----------

function hideSuggestions() {
  list.hidden = true;
  suggestions = [];
  selected = -1;
  window.browser.size(0);
}

function renderSuggestions() {
  list.hidden = suggestions.length === 0;
  list.replaceChildren(...suggestions.map((s, i) => {
    const li = el('li', `${s.type === 'bookmark' ? 'is-bookmark ' : ''}${i === selected ? 'selected' : ''}`);
    li.append(el('span', 's-title', { textContent: s.title }), el('span', 's-url', { textContent: s.url }));
    li.onmousedown = (e) => {
      e.preventDefault();
      go(s.url);
    };
    return li;
  }));
  // A camada cresce para caber a lista.
  window.browser.size(list.hidden ? 0 : list.offsetHeight + 12);
}

let request = 0;
address.oninput = async () => {
  const mine = ++request;
  const results = await window.browser.suggest(address.value);
  if (mine !== request || document.activeElement !== address) return;
  suggestions = results;
  selected = -1;
  renderSuggestions();
};

function go(text) {
  hideSuggestions();
  window.browser.go(text);
  address.blur();
}

$('drop').onsubmit = (e) => {
  e.preventDefault();
  go(selected >= 0 ? suggestions[selected].url : address.value);
};
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
  if (!pointerInside) window.browser.done();
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
    if (!list.hidden) return hideSuggestions();
    address.value = activeTab()?.url ?? '';
    address.blur();
    window.browser.done();
  }
};

window.browser.onFocusAddress(() => {
  address.focus();
  address.select();
});

$('star').onclick = () => window.browser.toggleBookmark();
$('shield').onclick = () => window.browser.toggleAdblockSite();
