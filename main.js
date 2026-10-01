const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, clipboard, dialog, net, protocol, session, shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
// Script da biblioteca que esconde os espaços de anúncio nas páginas (usado nas sessões dos espaços).
const ADBLOCK_PRELOAD = require.resolve('@ghostery/adblocker-electron-preload');
const { adsLists, adsAndTrackingLists } = require('@ghostery/adblocker');
const { getDomain } = require('tldts-experimental');
const { JsonStore, flushAll } = require('./store');
const spaces = require('./spaces');
const { startTranslation } = require('./translate');
const { THEMES, resolveTheme, themeCss, watchSystemTheme, systemThemeInfo } = require('./themes');
const { SHORTCUT_ACTIONS, comboFrom } = require('./shortcuts');

const APP_NAME = 'Wolf Browser';
// Largura da barra lateral (aberta e recolhida), em pixels.
const SIDEBAR_COLLAPSED = 56;
// Espaço e arredondamento em volta da página, como no Firefox.
// Cores do Wolf OS.
const HOME_URL = 'wolf://newtab/';
const PAGES_DIR = path.join(__dirname, 'ui', 'pages');
const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
};
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
// Permissões que o site precisa pedir; as demais são liberadas.
const ASK_PERMISSIONS = {
  media: 'usar sua câmera e/ou microfone',
  geolocation: 'saber sua localização',
  notifications: 'mostrar notificações',
  'clipboard-read': 'ler sua área de transferência',
  midiSysex: 'controlar dispositivos MIDI',
  openExternal: 'abrir um aplicativo externo',
};
const MAX_HISTORY = 10000;
const MAX_DOWNLOADS = 200;

app.setName(APP_NAME);

// Erros inesperados vão para um arquivo (~/.config/Wolf Browser/erros.log) em vez de uma janela.
function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`;
  console.error(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'erros.log'), line);
  } catch {
    // sem onde gravar
  }
}
process.on('uncaughtException', (err) => logError('Erro', err));
process.on('unhandledRejection', (err) => logError('Promessa rejeitada', err));
// WOLF_PROFILE=/alguma/pasta usa um perfil separado (bom para testes).
if (process.env.WOLF_PROFILE) app.setPath('userData', process.env.WOLF_PROFILE);
// Uma instância só por perfil: abrir de novo (ou clicar num link em outro programa)
// manda o endereço para a janela que já está aberta.
const urlArgs = (argv) => argv.slice(1).filter((a) => /^(https?|file):\/\//i.test(a));
if (!app.requestSingleInstanceLock()) process.exit(0);
// Identifica-se como Chrome comum; alguns sites (ex.: login do Google) bloqueiam o Electron.
app.userAgentFallback =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
protocol.registerSchemesAsPrivileged([
  { scheme: 'wolf', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const settings = new JsonStore('settings', {
  searchEngine: 'google',
  restoreSession: true,
  permissions: {},
  adblock: true,
  adblockAllow: [], // sites com a proteção desligada (escudo da barra de endereço)
  // Proteção
  blockTrackers: true,
  blockThirdPartyCookies: true,
  antiFingerprint: false,
  blockPopups: true,
  sendGpc: true, // sinal "não venda/compartilhe meus dados"
  dnsOverHttps: 'off', // off | automatic | cloudflare | google | quad9 | adguard
  webrtcPolicy: 'public', // default | public | disabled
  siteIsolation: true, // vale ao reiniciar
  clearOnExit: [], // history | cache | cookies | downloads
  permissionDefaults: { media: 'ask', geolocation: 'ask', notifications: 'ask' },
  extensionScopes: {}, // id da extensão -> 'all' | [ids de espaços]
  sleepAfter: 30, // minutos sem uso até a aba dormir; 0 = nunca
  sidebarMode: 'expanded', // expanded | collapsed | auto
  sidebarLastCompact: 'collapsed', // modo compacto usado pelo Ctrl+B
  sidebarExpandDelay: 300, // ms com o mouse em cima até abrir (modo automático)
  sidebarCollapseDelay: 400, // ms depois de tirar o mouse até recolher
  sidebarWidth: 272,
  tabDensity: 'comfortable', // comfortable | compact
  // Personalização da barra lateral: ordem das seções, ordem dos botões do rodapé e o que fica escondido.
  sidebarLayout: {
    sections: ['brand', 'nav', 'address', 'extensions', 'bookmarks', 'spaces', 'pinned', 'tabs', 'footer'],
    footer: ['media', 'ai', 'history', 'downloads', 'bookmarks', 'extensions', 'settings'],
    hidden: [],
  },
  sidebarPresets: [], // modelos salvos pelo usuário: { name, layout }
  tabGrouping: 'off', // off = lista | tree = árvore (quem abriu quem) | site = agrupar por site
  pageFrame: true, // espaço e cantos arredondados em volta da página
  scrollbars: 'wolf', // wolf = barra fina com a cor do tema | default = padrão do Chromium
  urlBarPosition: 'sidebar', // sidebar | top (gota no topo da página)
  urlBarVisibility: 'always', // always | hover (aparece com o mouse no topo)
  // Painel lateral de IA
  aiProviders: [
    { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', enabled: true },
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', enabled: true },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', enabled: true },
    { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', enabled: true },
    { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/', enabled: false },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', enabled: false },
    { id: 'grok', name: 'Grok', url: 'https://grok.com/', enabled: false },
  ],
  aiDefault: 'chatgpt',
  aiSide: 'right', // right | left
  aiWidth: 440,
  theme: 'system', // 'system' = automático (cores do Wolf OS / papel de parede)
  accent: null, // cor de destaque personalizada (#rrggbb) ou null = a do tema
  startup: 'restore', // restore | newtab | home
  homeUrl: '', // botão início; vazio = página inicial do Wolf
  newTabUrl: '', // endereço de toda aba nova; vazio = página inicial do Wolf
  linkTabPosition: 'after', // after | end
  lastTabClose: 'window', // window | newtab
  previewModifier: 'shift', // shift | alt | off
  translateLang: 'pt',
  downloadDir: '',
  askDownload: false,
  openDownloadsPanel: true,
  newtabName: '',
  newtabClock: true,
  newtabGreeting: true,
  newtabFavorites: true,
  tiles: [],
  shortcuts: {}, // id da ação -> combinação ('' = desativado)
});
// Isolamento de sites (cada site no seu processo) vem ligado no Chromium; desligar exige reiniciar.
if (settings.data.siteIsolation === false) app.commandLine.appendSwitch('disable-site-isolation-trials');
// Configuração antiga "reabrir abas" (true/false) vira "ao iniciar".
if (settings.data.restoreSession === false && !settings.data.migratedStartup) settings.data.startup = 'newtab';
settings.data.migratedStartup = true;
const SIDEBAR_MODES = ['expanded', 'collapsed', 'auto'];
const EXPAND_DELAYS = [0, 150, 300, 500, 800, 1200];
const COLLAPSE_DELAYS = [0, 200, 400, 700, 1000, 2000];
// Histórico e favoritos são por espaço (veja spaces.js).
const historyOf = (spaceId) => spaces.spaceData(spaceId).history;
const bookmarksOf = (spaceId) => spaces.spaceData(spaceId).bookmarks;
const downloads = new JsonStore('downloads', { items: [] });
const lastSession = new JsonStore('session', { spaces: {}, activeSpace: null }, { delay: 1500 });

let win = null;
let ui = null;
const tabs = new Map(); // a ordem do Map é a ordem das abas na barra
let activeId = null; // aba aberta no espaço atual
// Espaço atual e a última aba aberta em cada espaço.
let activeSpaceId = spaces.DEFAULT_SPACE_ID;
const spaceLastTab = new Map();
let nextId = 1;
// Barra lateral aberta "por cima" da página (modo automático, ou Ctrl+L / Ctrl+F no modo compacto).
let hoverOpen = false;
let htmlFullscreen = false;
let panel = null;       // painel flutuante (histórico, downloads, favoritos, ajustes)
let panelName = null;   // qual seção está aberta, ou null
let blocker = null;     // bloqueador de anúncios
const blockedCounts = new Map(); // webContents.id -> itens bloqueados na página atual
const closedTabs = [];
const activeDownloads = new Map(); // id -> DownloadItem

// ---------- Segurança: quem pode falar com o navegador ----------

// Canais da barra lateral: só aceitam mensagens da própria barra lateral.
// (Um site, mesmo explorando uma falha, não consegue pedir "fechar aba", "abrir página"...)
const fromUi = (event) => [ui, urlbar].some((view) => view && event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame);
function onUi(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromUi(event)) fn(event, ...args);
  });
}
function handleUi(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => (fromUi(event) ? fn(event, ...args) : undefined));
}

// Regras para todas as páginas criadas (abas, painéis, extensões...).
app.on('web-contents-created', (_e, contents) => {
  // <webview> dentro de páginas: nunca.
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // Site não abre página interna (wolf://): só o próprio navegador ou outra página interna.
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('wolf:') && !contents.getURL().startsWith('wolf:')) event.preventDefault();
  });
});

// ---------- Endereços ----------

function isPrivateHost(host) {
  return (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) // Tailscale
  );
}

function searchUrl(text) {
  const engine = SEARCH_ENGINES[settings.data.searchEngine] || SEARCH_ENGINES.google;
  return engine.url + encodeURIComponent(text);
}

// Transforma o que foi digitado em um endereço ou em uma busca.
function resolveInput(text) {
  const input = text.trim();
  if (!input) return HOME_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(about|file|data|view-source):/i.test(input)) return input;
  if (!/\s/.test(input)) {
    const host = input.split(/[/:?#]/)[0];
    if (isPrivateHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `http://${input}`;
    if (host.includes('.')) return `https://${input}`;
  }
  return searchUrl(input);
}

const isWeb = (url) => /^https?:/i.test(url);

// ---------- Janela e layout ----------

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  // `side` é o espaço reservado para a barra; no modo compacto ela abre por cima da página.
  const side = htmlFullscreen ? 0 : isCompact() ? SIDEBAR_COLLAPSED : sidebarWidth();
  ui.setVisible(!htmlFullscreen);
  ui.setBounds({ x: 0, y: 0, width: sidebarVisibleWidth(), height });
  const gap = htmlFullscreen || !settings.data.pageFrame ? 0 : 8;
  const pageBounds = {
    x: side,
    y: gap,
    width: Math.max(0, width - side - gap),
    height: Math.max(0, height - gap * 2),
  };
  // Gota sempre visível: a página desce para a gota não cobrir o conteúdo.
  if (!htmlFullscreen && urlbarTop() && settings.data.urlBarVisibility === 'always') {
    const reserve = URLBAR_HEIGHT + 8 - gap;
    pageBounds.y += reserve;
    pageBounds.height = Math.max(0, pageBounds.height - reserve);
  }
  // Painel de IA encaixado ao lado da página.
  if (!htmlFullscreen && ai.open) {
    const pw = Math.min(settings.data.aiWidth, Math.max(280, pageBounds.width - 320));
    const space = Math.max(gap, 6);
    ai.bounds = {
      x: settings.data.aiSide === 'left' ? pageBounds.x : pageBounds.x + pageBounds.width - pw,
      y: pageBounds.y,
      width: pw,
      height: pageBounds.height,
    };
    pageBounds.width = Math.max(0, pageBounds.width - pw - space);
    if (settings.data.aiSide === 'left') pageBounds.x += pw + space;
  }
  lastPageBounds = pageBounds;
  const split = splitOf(tabs.get(activeId));
  const rects = split ? splitRects(split, pageBounds) : null;
  for (const tab of tabs.values()) {
    if (!tab.view) continue;
    const inSplit = rects && (tab.id === split.a || tab.id === split.b);
    tab.view.setBounds(inSplit ? (tab.id === split.a ? rects.a : rects.b) : pageBounds);
    tab.view.setBorderRadius(inSplit ? Math.max(pageRadius(), 8) : pageRadius());
  }
  layoutDivider(split && !htmlFullscreen ? rects.divider : null);
  // O painel cobre a área da página (o fundo escurece); a barra lateral continua clicável.
  // Barra aberta por cima: mantém ela acima de páginas criadas depois.
  if (hoverOpen) {
    const children = win.contentView.children;
    const uiIndex = children.indexOf(ui);
    if ([...tabs.values()].some((t) => t.view && children.indexOf(t.view) > uiIndex)) win.contentView.addChildView(ui);
  }
  const shown = sidebarVisibleWidth();
  panel?.setBounds({ x: shown, y: 0, width: Math.max(0, width - shown), height });
  layoutPreview();
  layoutToast();
  layoutUrlbar();
  layoutAi();
}

function createWindow() {
  win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: currentTheme().frame,
    title: APP_NAME,
    icon: path.join(__dirname, 'ui', 'assets', 'wolf-512.png'),
  });

  ui = new WebContentsView({
    // Sem sandbox só na barra lateral (arquivo local), para os ícones das extensões funcionarem.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  ui.setBackgroundColor(currentTheme().frame);
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  ui.webContents.on('before-input-event', handleShortcut);
  ui.webContents.once('did-finish-load', () => {
    restoreSession();
    refreshUrlbar(); // gota no topo, se configurada
  });

  win.on('resize', layout);
  win.on('closed', () => {
    const views = [...tabs.values()];
    win = null; // a partir daqui nada mais é enviado nem salvo
    // Com BaseWindow as páginas não são fechadas sozinhas.
    for (const tab of views) tab.view?.webContents.close();
    tabs.clear();
    panel?.webContents.close();
    urlbar?.webContents.close();
    ai.header?.webContents.close();
    for (const view of ai.views.values()) view.webContents.close();
    ui.webContents.close();
  });
  layout();
}

function restoreSession() {
  const data = lastSession.data;
  // Formato antigo (antes dos espaços): uma lista só de abas → espaço Pessoal.
  const saved = data.spaces && Object.keys(data.spaces).length
    ? data.spaces
    : { [spaces.DEFAULT_SPACE_ID]: { tabs: data.tabs || [], active: data.active || 0 } };
  const wanted = spaces.getSpace(data.activeSpace) ? data.activeSpace : spaces.spacesStore().data.active;
  activeSpaceId = spaces.getSpace(wanted) ? wanted : spaces.DEFAULT_SPACE_ID;

  if (settings.data.startup === 'restore') {
    // As abas voltam "dormindo": só a aba ativa carrega agora; as outras carregam
    // quando você clicar nelas. Economiza muita memória e deixa a abertura rápida.
    for (const space of spaces.listSpaces()) {
      const entry = saved[space.id];
      if (!entry?.tabs?.length) continue;
      const created = entry.tabs.map((item) => {
        const info = typeof item === 'string' ? { url: item } : item;
        return createTab(info.url, { background: true, sleeping: info, space: space.id, pinnedId: info.pinnedId || null });
      });
      // Reconstrói a árvore de abas.
      entry.tabs.forEach((item, i) => {
        if (typeof item !== 'object') return;
        if (Number.isInteger(item.parent) && created[item.parent] && item.parent !== i) created[i].parentId = created[item.parent].id;
        created[i].treeCollapsed = Boolean(item.treeCollapsed);
      });
      spaceLastTab.set(space.id, created[Math.min(entry.active || 0, created.length - 1)].id);
    }
  }
  const last = spaceLastTab.get(activeSpaceId);
  if (last && tabs.has(last)) {
    activateTab(last);
    return;
  }
  if (settings.data.startup === 'home') createTab(homeTarget());
  else openNewTab();
}

function tabSessionInfo(t) {
  return { ...tabSessionData(t), pinnedId: t.pinnedId || null };
}

function tabSessionData(t) {
  const info = t.sleeping
    ? { ...t.sleeping }
    : {
        url: t.view.webContents.getURL() || t.startUrl,
        title: t.view.webContents.getTitle(),
        favicon: t.favicon,
        history: {
          entries: t.view.webContents.navigationHistory.getAllEntries(),
          index: t.view.webContents.navigationHistory.getActiveIndex(),
        },
      };
  // Até 25 páginas de voltar/avançar por aba, sem o estado interno (deixaria o arquivo enorme).
  if (info.history?.entries?.length) {
    const start = Math.max(0, info.history.entries.length - 25);
    info.history = {
      entries: info.history.entries.slice(start).map(({ url, title }) => ({ url, title })),
      index: Math.max(0, info.history.index - start),
    };
  } else {
    info.history = null;
  }
  return info;
}

function saveSession() {
  const bySpace = {};
  for (const space of spaces.listSpaces()) {
    const list = tabsOfSpace(space.id);
    if (!list.length) continue;
    const current = space.id === activeSpaceId ? activeId : spaceLastTab.get(space.id);
    bySpace[space.id] = {
      tabs: list.map((t) => {
        const parent = treeInfo(t).parentId;
        return { ...tabSessionInfo(t), parent: parent === null ? null : list.findIndex((x) => x.id === parent), treeCollapsed: Boolean(t.treeCollapsed) };
      }),
      active: Math.max(0, list.findIndex((t) => t.id === current)),
    };
  }
  lastSession.data = { spaces: bySpace, activeSpace: activeSpaceId };
  lastSession.save();
}

// ---------- Tema, página inicial e pasta de downloads ----------

const currentTheme = () => resolveTheme(settings.data.theme, spaces.getSpace(activeSpaceId)?.color || settings.data.accent);

// ---------- Barra de rolagem dos sites ----------
// Estilo "de usuário": só vale onde o site não personalizou a própria barra.

function scrollbarCss() {
  const { accent } = currentTheme();
  return `
::-webkit-scrollbar { width: 11px; height: 11px; background: transparent; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-button { display: none; }
::-webkit-scrollbar-thumb {
  min-height: 40px;
  border: 3px solid transparent;
  border-radius: 10px;
  background: rgb(128 128 128 / 0.45) padding-box;
}
::-webkit-scrollbar-thumb:hover { background: ${accent}cc padding-box; }
::-webkit-scrollbar-thumb:active { background: ${accent} padding-box; }
`;
}

async function applyScrollbars(tab) {
  const wc = tab.view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (tab.scrollbarKey) {
    // Obs.: o Chromium só volta a desenhar a barra padrão quando a página recarrega.
    await wc.removeInsertedCSS(tab.scrollbarKey).catch(() => {});
    tab.scrollbarKey = null;
  }
  if (settings.data.scrollbars !== 'wolf') return;
  try {
    tab.scrollbarKey = await wc.insertCSS(scrollbarCss(), { cssOrigin: 'user' });
  } catch {
    // página fechou no meio
  }
}

function refreshScrollbars() {
  for (const tab of tabs.values()) applyScrollbars(tab);
}

function applyTheme() {
  const theme = currentTheme();
  win?.setBackgroundColor(theme.frame);
  ui?.setBackgroundColor(theme.frame);
  refreshScrollbars(); // a barra usa a cor de destaque
  sendState();
  // Páginas internas recarregam o theme.css.
  sendToPages('wolf://', 'theme', null);
}

const homeTarget = () => (settings.data.homeUrl ? resolveInput(settings.data.homeUrl) : HOME_URL);

// Abre uma aba nova (Ctrl+T, "+ Nova aba"...) no endereço escolhido nas configurações.
function openNewTab() {
  const custom = settings.data.newTabUrl;
  createTab(custom ? resolveInput(custom) : HOME_URL, { newTab: true });
  // Com endereço próprio, o cursor vai para a barra de endereço (como no Chrome).
  if (custom) runAction('focusAddress');
}
const downloadDir = () => settings.data.downloadDir || app.getPath('downloads');



// ---------- Modos da barra lateral ----------

const isCompact = () => settings.data.sidebarMode !== 'expanded';
const sidebarWidth = () => settings.data.sidebarWidth;
const pageRadius = () => (htmlFullscreen || !settings.data.pageFrame ? 0 : 10);
const sidebarCollapsed = () => isCompact() && !hoverOpen;

function sidebarVisibleWidth() {
  if (htmlFullscreen) return 0;
  return sidebarCollapsed() ? SIDEBAR_COLLAPSED : sidebarWidth();
}

function setHoverOpen(value) {
  value = Boolean(value) && isCompact();
  if (hoverOpen === value || !win) return;
  hoverOpen = value;
  // Aberta, a barra fica por cima das páginas; o painel e a prévia se afastam para o lado.
  if (value) win.contentView.addChildView(ui);
  layout();
  sendState();
}

function setSidebarMode(mode) {
  if (!SIDEBAR_MODES.includes(mode)) return;
  if (mode !== 'expanded') settings.data.sidebarLastCompact = mode;
  settings.data.sidebarMode = mode;
  settings.save();
  hoverOpen = false;
  layout();
  sendState();
}

// Ctrl+B e o botão da barra: alterna entre expandida e o modo compacto preferido.
function toggleSidebar() {
  setSidebarMode(isCompact() ? 'expanded' : settings.data.sidebarLastCompact);
}

// Abre a barra temporariamente (para digitar), sem mudar o modo.
function revealSidebar() {
  if (isCompact()) setHoverOpen(true);
}

// ---------- Estado enviado para a barra lateral ----------

function activeTab() {
  return tabs.get(activeId);
}

// Árvore de abas: a "mãe" só vale se ainda estiver aberta no mesmo espaço.
function treeInfo(tab) {
  const parent = tab.parentId !== null && tab.parentId !== undefined ? tabs.get(tab.parentId) : null;
  return {
    parentId: parent && parent.space === tab.space && parent.id !== tab.id ? parent.id : null,
    treeCollapsed: Boolean(tab.treeCollapsed),
  };
}

function tabInfo(tab) {
  if (tab.sleeping) {
    const { url, title, favicon } = tab.sleeping;
    const isHome = url.startsWith(HOME_URL);
    return {
      id: tab.id,
      ...treeInfo(tab),
      title: isHome ? 'Nova aba' : title || url,
      url: isHome ? '' : url,
      favicon: isHome ? null : favicon || null,
      loading: false,
      audible: false,
      muted: false,
      zoom: 100,
      blocked: 0,
      adblock: null,
      canGoBack: false,
      canGoForward: false,
      sleeping: true,
    };
  }
  const wc = tab.view.webContents;
  const url = wc.getURL() || tab.startUrl;
  const isHome = url.startsWith(HOME_URL);
  return {
    id: tab.id,
    ...treeInfo(tab),
    title: isHome ? 'Nova aba' : wc.getTitle() || url || 'Carregando…',
    url: isHome ? '' : url,
    favicon: isHome ? null : tab.favicon,
    loading: wc.isLoading(),
    audible: wc.isCurrentlyAudible(),
    muted: wc.isAudioMuted(),
    zoom: Math.round(wc.getZoomFactor() * 100),
    split: tab.splitId ? { partner: splitPartner(tab)?.id ?? null, dir: splits.get(tab.splitId)?.dir } : null,
    translation: tab.translation
      ? {
          lang: tab.translation.lang,
          source: tab.translation.job.sourceLang,
          original: tab.translation.job.showingOriginal,
          error: tab.translation.error || null,
        }
      : null,
    blocked: blockedCounts.get(wc.id) || { ads: 0, trackers: 0 },
    // null = escudo escondido (página interna ou proteção toda desligada)
    adblock: isWeb(url) && protectionAnyOn() ? protectionActiveFor(url) : null,
    blockedPopup: tab.blockedPopup || null,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

function downloadSummary() {
  const running = downloads.data.items.filter((d) => d.state === 'progressing');
  const total = running.reduce((sum, d) => sum + d.total, 0);
  const received = running.reduce((sum, d) => sum + d.received, 0);
  return { running: running.length, progress: total ? received / total : 0 };
}

// Junta várias atualizações seguidas numa só (no máximo uma a cada 16 ms, um quadro de tela).
let stateTimer = null;
let lastStateAt = 0;
function sendState() {
  if (stateTimer) return;
  const wait = Math.max(0, 16 - (Date.now() - lastStateAt));
  stateTimer = setTimeout(() => {
    stateTimer = null;
    lastStateAt = Date.now();
    flushState();
  }, wait);
}

function flushState() {
  if (!win || ui.webContents.isDestroyed()) return;
  const state = {
    activeId,
    collapsed: sidebarCollapsed(),
    theme: currentTheme(),
    tabDensity: settings.data.tabDensity,
    tabGrouping: settings.data.tabGrouping,
    sidebarLayout: cleanSidebarLayout(settings.data.sidebarLayout),
    sidebarWidth: settings.data.sidebarWidth,
    sidebar: {
      mode: settings.data.sidebarMode,
      floating: isCompact() && hoverOpen,
      expandDelay: settings.data.sidebarExpandDelay,
      collapseDelay: settings.data.sidebarCollapseDelay,
    },
    tabs: tabsOfSpace(activeSpaceId).filter((t) => !pinnedTabValid(t)).map(tabInfo),
    pinned: pinsOf(activeSpaceId).map((pin) => {
      const tab = tabOfPin(pin.id);
      return { ...pin, tab: tab ? tabInfo(tab) : null };
    }),
    media: mediaSummary(),
    spaces: spaces.listSpaces().map((sp) => ({ ...sp, tabs: tabsOfSpace(sp.id).length })),
    activeSpace: activeSpaceId,
    partition: spaces.partitionOf(activeSpaceId), // ícones das extensões do espaço atual
    bookmarks: bookmarksOf(activeSpaceId).data.items.map(({ url, title, favicon }) => ({ url, title, favicon })),
    downloads: downloadSummary(),
    panel: panelName,
    urlBar: {
      position: settings.data.urlBarPosition,
      visibility: settings.data.urlBarVisibility,
      shown: urlbarShown,
    },
    ai: { open: ai.open },
  };
  ui.webContents.send('state', state);
  if (urlbar && !urlbar.webContents.isDestroyed()) urlbar.webContents.send('state', state);
  const tab = activeTab();
  if (tab) win.setTitle(`${tabInfo(tab).title} — ${APP_NAME}`);
  saveSession();
}

// Envia uma mensagem para as páginas internas abertas (ex.: wolf://downloads).
function sendToPages(prefix, channel, data) {
  const views = [...tabs.values()].map((t) => t.view).filter(Boolean);
  if (panel) views.push(panel);
  for (const view of views) {
    const wc = view.webContents;
    if (wc.getURL().startsWith(prefix) || wc === panel?.webContents) wc.send(`wolf:${channel}`, data);
  }
}

// ---------- Painel flutuante ----------

const PANELS = ['history', 'downloads', 'bookmarks', 'extensions', 'settings', 'media'];

function openPanel(name) {
  if (!PANELS.includes(name) || htmlFullscreen) return;
  closePreview();
  if (!panel) {
    panel = new WebContentsView({
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
    });
    panel.setBackgroundColor('#00000000'); // transparente: só o cartão aparece
    panel.webContents.on('before-input-event', handleShortcut);
    panel.webContents.loadURL(`wolf://panel/#${name}`);
  } else {
    panel.webContents.send('wolf:panel-show', name);
  }
  panelName = name;
  win.contentView.addChildView(panel); // (re)adicionar coloca o painel por cima de tudo
  panel.setVisible(true);
  layout();
  panel.webContents.focus();
  sendState();
}

function closePanel() {
  if (!panelName) return;
  panelName = null;
  panel.setVisible(false);
  activeTab()?.view.webContents.focus();
  sendState();
}

function togglePanel(name) {
  if (panelName === name) closePanel();
  else openPanel(name);
}

// ---------- Prévia de links (Shift + clique) ----------

const PREVIEW_TOP = 58; // espaço acima do cartão para a barrinha de controles
let preview = null; // { overlay, view, favicon, ready }

function previewRects() {
  const { width, height } = win.getContentBounds();
  const side = sidebarVisibleWidth();
  const area = { x: side, y: 0, width: Math.max(0, width - side), height };
  // O cartão é a própria página; os controles flutuam acima dele.
  const cardWidth = Math.min(1180, Math.round(area.width * 0.86));
  const card = {
    x: Math.round((area.width - cardWidth) / 2),
    y: PREVIEW_TOP,
    width: cardWidth,
    height: Math.max(0, area.height - PREVIEW_TOP - 22),
  };
  return { area, card };
}

function layoutPreview() {
  if (!preview || !win) return;
  const { area, card } = previewRects();
  preview.overlay.setBounds(area);
  preview.view.setBounds({ x: area.x + card.x, y: card.y, width: card.width, height: card.height });
  preview.view.setBorderRadius(14);
  sendPreviewInfo();
}

function sendPreviewInfo() {
  if (!preview) return;
  const wc = preview.view.webContents;
  const ov = preview.overlay.webContents;
  if (ov.isDestroyed() || ov.isLoading()) return;
  ov.send('wolf:preview', {
    card: previewRects().card,
    url: wc.getURL(),
    title: wc.getTitle(),
    favicon: preview.favicon,
    loading: wc.isLoading(),
  });
}

function previewKeys(event, input) {
  if (input.type !== 'keyDown') return;
  if (input.key === 'Escape') {
    event.preventDefault();
    closePreview();
  } else if (input.key === 'Enter' && (input.control || input.meta)) {
    event.preventDefault();
    adoptPreview();
  }
}

function openPreview(url) {
  if (!win || !isWeb(url) || htmlFullscreen) return;
  closePanel();
  closePreview();

  const overlay = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
  });
  overlay.setBackgroundColor('#00000000');
  const view = newPageView();
  preview = { overlay, view, favicon: null, ready: false, space: activeSpaceId };
  win.contentView.addChildView(overlay);
  win.contentView.addChildView(view);
  overlay.setVisible(true);

  const wc = view.webContents;
  applyWebRtc(wc);
  const current = () => preview?.view === view;
  wc.on('before-input-event', previewKeys);
  overlay.webContents.on('before-input-event', previewKeys);
  overlay.webContents.on('did-finish-load', sendPreviewInfo);
  wc.setWindowOpenHandler(({ url: target }) => {
    if (current()) createTab(target, { background: true, space: preview.space });
    return { action: 'deny' };
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (!current()) return;
    preview.favicon = favicons[0] || null;
    sendPreviewInfo();
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(ev, () => current() && sendPreviewInfo());
  }

  overlay.webContents.loadURL('wolf://preview/');
  wc.loadURL(url);
  layoutPreview();
  wc.focus();
}

function closePreview() {
  if (!preview) return;
  const { overlay, view } = preview;
  preview = null;
  win?.contentView.removeChildView(overlay);
  win?.contentView.removeChildView(view);
  overlay.webContents.close();
  view.webContents.close();
  activeTab()?.view?.webContents.focus();
}

// "Abrir em nova aba": a própria página da prévia vira a aba (sem recarregar).
function adoptPreview() {
  if (!preview) return;
  const { overlay, view, space: previewSpace } = preview;
  const favicon = preview.favicon;
  preview = null;
  win.contentView.removeChildView(overlay);
  overlay.webContents.close();
  view.webContents.off('before-input-event', previewKeys);
  view.setBorderRadius(pageRadius());
  const tab = createTab(view.webContents.getURL(), { view, space: previewSpace });
  tab.favicon = favicon;
  sendState();
}

// Links com Shift + clique (vem do page-preload.js de qualquer aba ou da própria prévia).
ipcMain.on('link-preview', (event, url) => {
  url = String(url);
  if (preview && event.sender === preview.view.webContents) {
    preview.view.webContents.loadURL(url);
    return;
  }
  if (tabFromContents(event.sender)) openPreview(url);
});

handleInternal('preview:ready', () => preview?.view.setVisible(true));
// Duplo clique dentro da prévia: abre como aba normal.
ipcMain.on('preview:dblclick', (event) => {
  if (preview && event.sender === preview.view.webContents) adoptPreview();
});
handleInternal('preview:close', closePreview);
handleInternal('preview:open-tab', adoptPreview);
handleInternal('preview:open-here', () => {
  if (!preview) return;
  const url = preview.view.webContents.getURL();
  closePreview();
  if (isWeb(url)) activeTab()?.view?.webContents.loadURL(url);
});

// ---------- Abas ----------

function setOrder(entries) {
  tabs.clear();
  for (const [key, value] of entries) tabs.set(key, value);
}

function createTab(url = HOME_URL, { background = false, sleeping = null, view = null, newTab = false, space = activeSpaceId, pinnedId = null, openerId = null } = {}) {
  closePanel();
  const id = nextId++;
  if (!spaces.getSpace(space)) space = activeSpaceId;
  const tab = {
    id,
    space, // espaço ao qual a aba pertence
    view: null, // WebContentsView; null enquanto a aba dorme
    favicon: null,
    startUrl: url,
    historyEntry: null,
    sleeping: null, // { url, title, favicon, history } enquanto dorme
    pinnedId, // aba aberta a partir de um atalho fixado (fica na seção FIXADAS)
    parentId: openerId, // árvore de abas: a aba que abriu esta
    treeCollapsed: false, // ramo recolhido na árvore
    lastActive: Date.now(),
  };

  // Abas abertas a partir de um link ficam logo abaixo da aba atual.
  // Abas novas vão para o fim; abas de links, ao lado da atual (se configurado).
  if (activeId !== null && space === activeSpaceId && !newTab && url !== HOME_URL && settings.data.linkTabPosition === 'after') {
    const entries = [...tabs.entries()];
    const index = entries.findIndex(([key]) => key === activeId);
    entries.splice(index + 1, 0, [id, tab]);
    setOrder(entries);
  } else {
    tabs.set(id, tab);
  }

  if (sleeping) {
    tab.sleeping = {
      url,
      title: sleeping.title || '',
      favicon: sleeping.favicon || null,
      history: sleeping.history || null,
    };
  } else if (view) {
    mountView(tab, view);
    layout();
    addHistory(tab, view.webContents.getURL());
  } else {
    attachView(tab, url);
  }
  // Aba de outro espaço só aparece quando você for para ele.
  if (background || (space !== activeSpaceId && !view)) sendState();
  else activateTab(id);
  return tab;
}

// Cria a página de verdade (processo, memória) de uma aba.
function newPageView(spaceId = activeSpaceId) {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      preload: path.join(__dirname, 'page-preload.js'),
      session: spaceSession(spaceId), // cookies, logins e cache do espaço
    },
  });
  view.setBackgroundColor(currentTheme().surface);
  view.setVisible(false);
  return view;
}

function attachView(tab, url, history = null) {
  const view = newPageView(tab.space);
  mountView(tab, view);

  // Com o histórico salvo, voltar/avançar e a posição de rolagem continuam funcionando.
  if (history?.entries?.length) {
    view.webContents.navigationHistory
      .restore({ entries: history.entries, index: history.index })
      .catch(() => view.webContents.loadURL(url));
  } else {
    view.webContents.loadURL(url);
  }
  layout();
}

// Liga uma página (WebContentsView) a uma aba: eventos, extensões e janela.
function mountView(tab, view) {
  tab.view = view;
  win.contentView.addChildView(view);
  setupTabEvents(tab);
  syncExtensions(() => {
    extensionsOf(view.webContents)?.addTab(view.webContents, win);
    // A biblioteca considera a aba nova como ativa; devolve o foco para a aba ativa de verdade.
    const current = activeTab();
    if (current?.view && current.id !== tab.id && current.space === tab.space) {
      extensionsOf(current.view.webContents)?.selectTab(current.view.webContents);
    }
  });
}

// Põe uma aba para dormir: encerra a página e guarda só o necessário para voltar.
// ---------- Tradução de páginas ----------

const TRANSLATE_LANGS = [
  ['pt', 'Português'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['ja', '日本語'], ['zh-CN', '中文'], ['ru', 'Русский'],
];

function translateTab(tab, lang = 'pt') {
  const wc = tab?.view?.webContents;
  if (!wc || !isWeb(wc.getURL())) return;
  tab.translation?.job.stop();
  const translation = { lang, error: null, job: null };
  translation.job = startTranslation(wc, lang, {
    onProgress: sendState,
    onError: (err) => {
      translation.error = err.message;
      sendState();
    },
  });
  tab.translation = translation;
  sendState();
}

function stopTranslation(tab) {
  if (!tab?.translation) return;
  tab.translation.job.stop();
  tab.translation = null;
  tab.translateNext = null;
  sendState();
}

async function toggleOriginal(tab) {
  const job = tab?.translation?.job;
  if (!job) return;
  await job.showOriginal(!job.showingOriginal);
  sendState();
}

onUi('translate:start', (_e, lang) => translateTab(activeTab(), String(lang || settings.data.translateLang)));
onUi('translate:stop', () => stopTranslation(activeTab()));
onUi('translate:toggle', () => toggleOriginal(activeTab()));

function sleepTab(tab) {
  if (!tab?.view || tab.id === activeId || splitPartnerOfActive(tab)) return false;
  const wc = tab.view.webContents;
  if (wc.isCurrentlyAudible() || wc.isDevToolsOpened()) return false;
  const nav = wc.navigationHistory;
  const entries = nav.getAllEntries();
  tab.sleeping = {
    url: wc.getURL() || tab.startUrl,
    title: wc.getTitle(),
    favicon: tab.favicon,
    history: entries.length ? { entries, index: nav.getActiveIndex() } : null,
  };
  win.contentView.removeChildView(tab.view);
  blockedCounts.delete(wc.id);
  tab.translation?.job.cancel();
  tab.translation = null;
  if (tab.media) {
    tab.media = null;
    mediaChanged();
  }
  wc.close();
  tab.view = null;
  tab.historyEntry = null;
  sendState();
  return true;
}

// Verifica de minuto em minuto se há abas paradas há mais tempo que o configurado.
function checkIdleTabs() {
  const minutes = settings.data.sleepAfter;
  if (!minutes || !win) return;
  const limit = Date.now() - minutes * 60 * 1000;
  for (const tab of tabs.values()) {
    if (tab.view && tab.id !== activeId && !splitPartnerOfActive(tab) && tab.lastActive < limit) sleepTab(tab);
  }
}
setInterval(checkIdleTabs, 60 * 1000);

function setupTabEvents(tab) {
  const wc = tab.view.webContents;
  wc.setMaxListeners(30); // o navegador e a biblioteca de extensões escutam os mesmos eventos

  applyWebRtc(wc);

  // Cada página nova recebe a barra de rolagem do Wolf.
  wc.on('dom-ready', () => {
    tab.scrollbarKey = null; // a página anterior (e o CSS dela) já não existe
    applyScrollbars(tab);
  });

  // Links que abririam nova janela (target=_blank, window.open, Ctrl+clique) viram abas.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Site não abre página interna (wolf://) em aba nova.
    if (url.startsWith('wolf:') && !wc.getURL().startsWith('wolf:')) return { action: 'deny' };
    createTab(url, { background: disposition === 'background-tab', space: tab.space, openerId: tab.id });
    return { action: 'deny' };
  });
  wc.on('before-input-event', handleShortcut);
  wc.on('context-menu', (_e, params) => showContextMenu(tab, params));
  // Tela dividida: clicar numa metade faz dela a aba ativa (endereço, voltar...).
  wc.on('focus', () => {
    const split = splitOf(tab);
    if (!split || activeId === tab.id || (split.a !== activeId && split.b !== activeId)) return;
    activeId = tab.id;
    spaceLastTab.set(tab.space, tab.id);
    tab.lastActive = Date.now();
    sendState();
  });

  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      // Só apaga o ícone ao ir para outro site: ao recarregar a mesma página
      // o Chromium não avisa o ícone de novo (ele sumia).
      if (hostOf(_url) !== hostOf(wc.getURL())) tab.favicon = null;
      blockedCounts.set(wc.id, { ads: 0, trackers: 0 });
      if (tab.media) {
        tab.media = null;
        mediaChanged();
      }
      tab.blockedPopup = null;
      // A página vai trocar: a tradução continua na próxima (como no Chrome).
      if (tab.translation) {
        tab.translateNext = tab.translation.job.showingOriginal ? null : tab.translation.lang;
        tab.translation.job.cancel();
        tab.translation = null;
      }
    }
  });
  wc.on('did-finish-load', () => {
    if (tab.translateNext && isWeb(wc.getURL())) translateTab(tab, tab.translateNext);
    tab.translateNext = null;
  });
  wc.on('did-navigate', (_e, url) => addHistory(tab, url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) addHistory(tab, url);
  });
  wc.on('page-title-updated', (_e, title) => {
    if (tab.historyEntry && tab.historyEntry.url === wc.getURL()) {
      tab.historyEntry.title = title;
      historyOf(tab.space).save();
    }
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] || null;
    const pinned = tab.pinnedId && findPin(tab.pinnedId);
    if (pinned && tab.favicon && !pinned.pin.favicon) {
      pinned.pin.favicon = tab.favicon;
      pinsStore(pinned.spaceId).save();
    }
    if (tab.historyEntry && tab.historyEntry.url === wc.getURL() && tab.favicon) {
      tab.historyEntry.favicon = tab.favicon;
      historyOf(tab.space).save();
    }
    const bookmark = bookmarksOf(tab.space).data.items.find((b) => b.url === wc.getURL());
    if (bookmark && tab.favicon) {
      bookmark.favicon = tab.favicon;
      bookmarksOf(tab.space).save();
    }
    sendState();
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3 = carregamento cancelado (ex.: clicou em outro link); não é erro.
    if (!isMainFrame || code === -3 || url.startsWith('wolf:')) return;
    const params = new URLSearchParams({ code, description, url });
    wc.loadURL(`wolf://error/?${params}`);
  });

  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeId) {
      ui.webContents.send('find-result', { active: result.activeMatchOrdinal, matches: result.matches });
    }
  });
  wc.on('zoom-changed', (_e, direction) => zoom(wc, direction === 'in' ? 1 : -1));
  wc.on('enter-html-full-screen', () => {
    closePanel();
    htmlFullscreen = true;
    win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
    win.setFullScreen(false);
    layout();
  });

  for (const ev of [
    'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page',
    'page-title-updated', 'audio-state-changed',
  ]) {
    wc.on(ev, sendState);
  }
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  closePanel();
  closePreview();
  const previous = activeTab();
  if (previous && previous.id !== id) {
    previous.view?.webContents.stopFindInPage('clearSelection');
    previous.lastActive = Date.now();
  }
  const tab = tabs.get(id);
  // Aba de outro espaço: vai para o espaço dela.
  const spaceChanged = tab.space !== activeSpaceId;
  if (spaceChanged) {
    if (activeId !== null) spaceLastTab.set(activeSpaceId, activeId);
    activeSpaceId = tab.space;
    spaces.spacesStore().data.active = activeSpaceId;
    spaces.spacesStore().save();
  }
  activeId = id;
  spaceLastTab.set(tab.space, id);
  tab.lastActive = Date.now();
  if (tab.sleeping) {
    // Acorda a aba: recria a página com o histórico guardado.
    const { url, favicon, history: saved } = tab.sleeping;
    tab.sleeping = null;
    tab.favicon = favicon;
    attachView(tab, url, saved);
  }
  // Aba numa divisão: as duas metades aparecem.
  const split = splitOf(tab);
  if (split) {
    for (const otherId of [split.a, split.b]) {
      const other = tabs.get(otherId);
      if (other?.sleeping) {
        const { url, favicon, history: saved } = other.sleeping;
        other.sleeping = null;
        other.favicon = favicon;
        attachView(other, url, saved);
      }
    }
  }
  for (const t of tabs.values()) t.view?.setVisible(t.id === id || Boolean(split && (t.id === split.a || t.id === split.b)));
  layout();
  tab.view.webContents.focus();
  syncExtensions(() => extensionsOf(tab.view.webContents)?.selectTab(tab.view.webContents));
  ui.webContents.send('find-close');
  if (spaceChanged) applyTheme(); // cada espaço pode ter a sua cor
  sendState();
}

// ---------- Mini player (mídia tocando nas abas) ----------
// Cada página avisa o que está tocando (page-preload.js); o painel "media" mostra tudo
// e manda comandos de volta.

const MEDIA_WORLD = 1818;

function mediaList() {
  return [...tabs.values()]
    .filter((t) => t.media && t.view)
    .map((t) => {
      const space = spaces.getSpace(t.space);
      return {
        tabId: t.id,
        ...t.media,
        favicon: t.favicon,
        site: hostOf(t.view.webContents.getURL()).replace(/^www\./, ''),
        space: space ? `${space.icon} ${space.name}` : '',
        active: t.id === activeId,
      };
    })
    .sort((a, b) => Number(b.playing) - Number(a.playing));
}

function mediaSummary() {
  const list = [...tabs.values()].filter((t) => t.media);
  return { count: list.length, playing: list.filter((t) => t.media.playing).length };
}

let mediaTimer = null;
function mediaChanged() {
  if (mediaTimer) return;
  mediaTimer = setTimeout(() => {
    mediaTimer = null;
    sendState();
    sendToPages('wolf://panel', 'media', mediaList());
  }, 120);
}

ipcMain.on('media-state', (event, info) => {
  const tab = tabFromContents(event.sender);
  if (!tab) return;
  tab.media = info && typeof info === 'object'
    ? {
        playing: Boolean(info.playing),
        title: String(info.title || '').slice(0, 200),
        artist: String(info.artist || '').slice(0, 200),
        artwork: /^https?:/.test(String(info.artwork)) ? String(info.artwork) : '',
        hasVideo: Boolean(info.hasVideo),
        muted: Boolean(info.muted),
        pip: Boolean(info.pip),
      }
    : null;
  mediaChanged();
});

// Comandos para o vídeo/áudio principal da aba (rodam como gesto do usuário: PiP e play exigem).
const MEDIA_COMMANDS = {
  toggle: 'm.paused ? m.play() : m.pause()',
  back: 'm.currentTime = Math.max(0, m.currentTime - 10)',
  forward: 'm.currentTime = Math.min(m.duration || Infinity, m.currentTime + 10)',
  mute: 'm.muted = !m.muted',
  pip: 'document.pictureInPictureElement ? document.exitPictureInPicture() : m.requestPictureInPicture()',
};
handleInternal('media:list', () => mediaList());
handleInternal('media:command', async (_e, tabId, command) => {
  const tab = tabs.get(Number(tabId));
  if (!tab?.view) return;
  if (command === 'focus') {
    closePanel();
    return activateTab(tab.id);
  }
  if (command === 'close') return closeTab(tab.id);
  const action = MEDIA_COMMANDS[command];
  if (!action) return;
  const code = `(() => {
    const all = [...document.querySelectorAll('video, audio')];
    const m = all.find((e) => !e.paused) || all.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
    if (!m) return;
    const r = ${action};
    if (r && r.catch) r.catch(() => {});
  })()`;
  await tab.view.webContents.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code }], true).catch(() => {});
});

// ---------- Tela dividida ----------
// Duas abas lado a lado (ou uma em cima da outra). a = esquerda/cima, b = direita/baixo.

const splits = new Map(); // id -> { id, a, b, dir: 'row' | 'column', ratio }
const SPLIT_GAP = 8;
let divider = null;

const splitOf = (tab) => (tab?.splitId ? splits.get(tab.splitId) : null);
function splitPartner(tab) {
  const split = splitOf(tab);
  if (!split) return null;
  return tabs.get(split.a === tab.id ? split.b : split.a) || null;
}
const splitPartnerOfActive = (tab) => {
  const split = splitOf(tabs.get(activeId));
  return Boolean(split && (split.a === tab.id || split.b === tab.id));
};

function splitRects(split, page) {
  if (split.dir === 'column') {
    const h1 = Math.round((page.height - SPLIT_GAP) * split.ratio);
    return {
      a: { x: page.x, y: page.y, width: page.width, height: h1 },
      b: { x: page.x, y: page.y + h1 + SPLIT_GAP, width: page.width, height: page.height - h1 - SPLIT_GAP },
      divider: { x: page.x, y: page.y + h1, width: page.width, height: SPLIT_GAP },
    };
  }
  const w1 = Math.round((page.width - SPLIT_GAP) * split.ratio);
  return {
    a: { x: page.x, y: page.y, width: w1, height: page.height },
    b: { x: page.x + w1 + SPLIT_GAP, y: page.y, width: page.width - w1 - SPLIT_GAP, height: page.height },
    divider: { x: page.x + w1, y: page.y, width: SPLIT_GAP, height: page.height },
  };
}

function layoutDivider(rect) {
  if (!rect) {
    divider?.setVisible(false);
    return;
  }
  if (!divider) {
    divider = new WebContentsView({
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
    });
    divider.setBackgroundColor('#00000000');
    divider.webContents.loadURL('wolf://divider/');
    win.contentView.addChildView(divider);
  }
  divider.setVisible(true);
  divider.setBounds(rect);
  const split = splitOf(tabs.get(activeId));
  if (split) divider.webContents.send('wolf:divider', { dir: split.dir });
}

// dragged = aba arrastada; target = aba que estava aberta; zone = onde soltou.
function createSplit(draggedId, targetId, zone) {
  const dragged = tabs.get(draggedId);
  const target = tabs.get(targetId);
  if (!dragged || !target || draggedId === targetId || dragged.space !== target.space) return;
  for (const tab of [dragged, target]) if (tab.splitId) dissolveSplit(tab.splitId);
  const first = zone === 'left' || zone === 'top';
  const split = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    a: first ? draggedId : targetId,
    b: first ? targetId : draggedId,
    dir: zone === 'top' || zone === 'bottom' ? 'column' : 'row',
    ratio: 0.5,
  };
  splits.set(split.id, split);
  dragged.splitId = split.id;
  target.splitId = split.id;
  activateTab(draggedId);
}

function splitWithNewTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const created = createTab(HOME_URL, { space: tab.space, background: true, newTab: true });
  createSplit(created.id, tabId, 'right');
}

function dissolveSplit(splitId) {
  const split = splits.get(splitId);
  if (!split) return;
  splits.delete(splitId);
  for (const id of [split.a, split.b]) {
    const tab = tabs.get(id);
    if (tab) tab.splitId = null;
  }
  for (const t of tabs.values()) t.view?.setVisible(t.id === activeId);
  layout();
  sendState();
}

// Arrastar uma aba da barra lateral sobre a página: zonas de encaixe.
let dropzone = null;
let draggingTab = null;
let dropTarget = null; // aba que vai dividir a tela com a arrastada

// Com qual aba a arrastada vai dividir a tela. Clicar numa aba para arrastar já a deixa
// ativa; nesse caso o par é a aba que estava aberta logo antes.
function splitTargetFor(tab) {
  if (tab.id !== activeId && !splitPartnerOfActive(tab)) return tabs.get(activeId) || null;
  const partner = splitPartner(tab);
  const others = [...tabs.values()].filter((t) => t.id !== tab.id && t !== partner && t.space === tab.space);
  others.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  return others[0] || null;
}

function showDropzone(tabId) {
  const tab = tabs.get(Number(tabId));
  if (!tab || !win || !lastPageBounds) return;
  draggingTab = tab.id;
  const target = splitTargetFor(tab);
  dropTarget = target ? target.id : null;
  if (!dropzone) {
    dropzone = new WebContentsView({
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
    });
    dropzone.setBackgroundColor('#00000000');
    dropzone.webContents.loadURL('wolf://dropzone/');
  }
  win.contentView.addChildView(dropzone);
  dropzone.setBounds(lastPageBounds);
  dropzone.setVisible(true);
  const same = !target;
  const send = () => dropzone.webContents.send('wolf:dropzone', { title: target ? tabInfo(target).title : '', same, wide: lastPageBounds.width >= lastPageBounds.height });
  if (dropzone.webContents.isLoading()) dropzone.webContents.once('did-finish-load', send);
  else send();
}

function hideDropzone() {
  dropzone?.setVisible(false);
  draggingTab = null;
  dropTarget = null;
}

onUi('split:drag-start', (_e, tabId) => showDropzone(tabId));
// O fim do arrasto chega antes do "soltar" na outra camada: espera um pouco antes de esconder.
onUi('split:drag-end', () => setTimeout(hideDropzone, 150));
handleInternal('split:drop', (_e, zone) => {
  const dragged = draggingTab;
  const target = dropTarget;
  hideDropzone();
  if (dragged === null || target === null || !['left', 'right', 'top', 'bottom'].includes(zone)) return;
  createSplit(dragged, target, zone);
});
handleInternal('split:resize', (_e, delta) => {
  const split = splitOf(tabs.get(activeId));
  if (!split || !lastPageBounds) return;
  const total = split.dir === 'column' ? lastPageBounds.height : lastPageBounds.width;
  split.ratio = Math.min(0.85, Math.max(0.15, split.ratio + Number(delta) / Math.max(1, total)));
  layout();
});
handleInternal('split:reset', () => {
  const split = splitOf(tabs.get(activeId));
  if (!split) return;
  split.ratio = 0.5;
  layout();
});
handleInternal('split:menu', () => {
  const split = splitOf(tabs.get(activeId));
  if (!split) return;
  Menu.buildFromTemplate([
    { label: 'Trocar de lado', click: () => { [split.a, split.b] = [split.b, split.a]; layout(); sendState(); } },
    { label: split.dir === 'row' ? 'Uma em cima da outra' : 'Lado a lado', click: () => { split.dir = split.dir === 'row' ? 'column' : 'row'; layout(); sendState(); } },
    { label: 'Tamanhos iguais', click: () => { split.ratio = 0.5; layout(); } },
    { type: 'separator' },
    { label: 'Desfazer divisão', click: () => dissolveSplit(split.id) },
  ]).popup({ window: win });
});

// ---------- Abas fixadas ----------
// Cada espaço tem atalhos fixados. A aba aberta por um atalho aparece no lugar dele;
// fechar a aba não remove o atalho (ele fica mais apagado, pronto para abrir de novo).

const pinsStore = (spaceId) => spaces.spaceData(spaceId).pinned;
const pinsOf = (spaceId) => pinsStore(spaceId).data.items;
const findPin = (pinId) => {
  for (const space of spaces.listSpaces()) {
    const pin = pinsOf(space.id).find((p) => p.id === pinId);
    if (pin) return { pin, spaceId: space.id };
  }
  return null;
};
const tabOfPin = (pinId) => [...tabs.values()].find((t) => t.pinnedId === pinId);
// O vínculo vale enquanto o atalho existir (desafixado = vira aba normal).
const pinnedTabValid = (tab) => Boolean(tab.pinnedId && findPin(tab.pinnedId));

function pinTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || pinnedTabValid(tab)) return;
  const wc = tab.view?.webContents;
  const url = tab.sleeping?.url ?? wc?.getURL() ?? '';
  if (!isWeb(url)) return;
  const pin = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    url,
    title: tab.sleeping?.title || wc?.getTitle() || hostOf(url),
    favicon: tab.favicon || tab.sleeping?.favicon || null,
  };
  pinsOf(tab.space).push(pin);
  pinsStore(tab.space).save();
  tab.pinnedId = pin.id;
  sendState();
}

function unpin(pinId) {
  const found = findPin(pinId);
  if (!found) return;
  const store = pinsStore(found.spaceId);
  store.data.items = store.data.items.filter((p) => p.id !== pinId);
  store.save();
  const tab = tabOfPin(pinId);
  if (tab) tab.pinnedId = null; // a aba continua aberta, como aba normal
  sendState();
}

// Clique no atalho: vai para a aba dele, ou abre no endereço fixado.
function openPin(pinId) {
  const found = findPin(pinId);
  if (!found) return;
  const tab = tabOfPin(pinId);
  if (tab) return activateTab(tab.id);
  const created = createTab(found.pin.url, { space: found.spaceId, pinnedId: pinId, background: true });
  activateTab(created.id);
}

function closePinTab(pinId) {
  const tab = tabOfPin(pinId);
  if (tab) closeTab(tab.id);
}

function resetPin(pinId) {
  const found = findPin(pinId);
  const tab = tabOfPin(pinId);
  if (!found) return;
  if (tab?.view) tab.view.webContents.loadURL(found.pin.url);
  else openPin(pinId);
}

function movePin(pinId, toIndex) {
  const found = findPin(pinId);
  if (!found) return;
  const items = pinsOf(found.spaceId);
  const from = items.findIndex((p) => p.id === pinId);
  const [pin] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, pin);
  pinsStore(found.spaceId).save();
  sendState();
}

function showPinMenu(pinId) {
  const found = findPin(pinId);
  if (!found) return;
  const tab = tabOfPin(pinId);
  const current = tab?.view?.webContents.getURL();
  Menu.buildFromTemplate([
    { label: found.pin.title, enabled: false },
    { type: 'separator' },
    { label: tab ? 'Ir para a aba' : 'Abrir', click: () => openPin(pinId) },
    { label: 'Voltar ao endereço fixado', enabled: Boolean(tab) && current !== found.pin.url, click: () => resetPin(pinId) },
    {
      label: 'Fixar o endereço atual',
      enabled: Boolean(current && isWeb(current) && current !== found.pin.url),
      click: () => {
        found.pin.url = current;
        found.pin.title = tab.view.webContents.getTitle() || found.pin.title;
        if (tab.favicon) found.pin.favicon = tab.favicon;
        pinsStore(found.spaceId).save();
        sendState();
      },
    },
    { label: 'Abrir numa aba normal', click: () => createTab(found.pin.url, { space: found.spaceId }) },
    { type: 'separator' },
    { label: 'Fechar a aba (o atalho continua)', enabled: Boolean(tab), click: () => closePinTab(pinId) },
    { label: 'Desafixar', click: () => unpin(pinId) },
  ]).popup({ window: win });
}

onUi('pin:open', (_e, pinId) => openPin(String(pinId)));
onUi('pin:close', (_e, pinId) => closePinTab(String(pinId)));
onUi('pin:menu', (_e, pinId) => showPinMenu(String(pinId)));
onUi('pin:move', (_e, pinId, toIndex) => movePin(String(pinId), Number(toIndex)));
onUi('pin:add', (_e, tabId) => pinTab(Number(tabId)));

// ---------- Espaços ----------

// Cada espaço tem sessão própria; na primeira vez ela recebe tudo que o navegador precisa.
const readySessions = new Set();
function spaceSession(spaceId) {
  const ses = spaces.sessionOf(spaces.getSpace(spaceId) ? spaceId : spaces.DEFAULT_SPACE_ID);
  if (!readySessions.has(ses)) {
    readySessions.add(ses);
    setupSession(ses);
  }
  return ses;
}

function setupSession(ses) {
  try {
    ses.setSpellCheckerLanguages(['pt-BR', 'en-US']);
  } catch {
    // corretor indisponível neste sistema
  }
  setupProtocol(ses);
  setupDownloads(ses);
  setupPermissions(ses);
  setupProtection(ses);
  return setupExtensions(ses);
}

const tabsOfSpace = (spaceId) => [...tabs.values()].filter((t) => t.space === spaceId);

function switchSpace(spaceId) {
  if (!spaces.getSpace(spaceId) || spaceId === activeSpaceId) return;
  closePanel();
  closePreview();
  const list = tabsOfSpace(spaceId);
  const last = spaceLastTab.get(spaceId);
  if (last && tabs.get(last)?.space === spaceId) return activateTab(last);
  if (list.length) return activateTab(list.at(-1).id);
  // Espaço vazio: abre uma aba nova nele.
  if (activeId !== null) spaceLastTab.set(activeSpaceId, activeId);
  activeSpaceId = spaceId;
  activeId = null;
  spaces.spacesStore().data.active = spaceId;
  spaces.spacesStore().save();
  for (const t of tabs.values()) t.view?.setVisible(false);
  applyTheme();
  openNewTab();
}

function cycleSpace(step) {
  const list = spaces.listSpaces();
  const index = list.findIndex((sp) => sp.id === activeSpaceId);
  switchSpace(list[(index + step + list.length) % list.length].id);
}

// Botão direito no ícone de um espaço (barra lateral).
function showSpaceMenu(id) {
  const space = spaces.getSpace(id);
  if (!space) return;
  Menu.buildFromTemplate([
    { label: `${space.icon}  ${space.name}`, enabled: false },
    { type: 'separator' },
    { label: 'Ir para este espaço', enabled: id !== activeSpaceId, click: () => switchSpace(id) },
    { label: 'Editar espaços…', click: () => openInternal('settings#spaces') },
    { label: 'Novo espaço…', click: () => openInternal('settings#spaces') },
  ]).popup({ window: win });
}

// Remove um espaço: fecha as abas dele e apaga os dados (cookies, histórico, favoritos).
async function removeSpace(id) {
  if (id === spaces.DEFAULT_SPACE_ID || !spaces.getSpace(id)) return false;
  if (activeSpaceId === id) switchSpace(spaces.DEFAULT_SPACE_ID);
  for (const tab of tabsOfSpace(id)) {
    tab.translation?.job.cancel();
    if (tab.view) {
      win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    tabs.delete(tab.id);
  }
  spaceLastTab.delete(id);
  const ok = await spaces.deleteSpace(id);
  for (const extId of Object.keys(settings.data.extensionScopes)) {
    const scope = settings.data.extensionScopes[extId];
    if (Array.isArray(scope)) settings.data.extensionScopes[extId] = scope.filter((sp) => sp !== id);
  }
  settings.save();
  sendState();
  return ok;
}

handleInternal('spaces:add', (_e, data) => {
  const space = spaces.addSpace(data || {});
  spaceSession(space.id); // prepara a sessão (proteção, extensões...)
  sendState();
  return space;
});
handleInternal('spaces:update', (_e, id, changes) => {
  spaces.updateSpace(id, changes || {});
  if (id === activeSpaceId) applyTheme(); // cor do espaço
  sendState();
});
handleInternal('spaces:move', (_e, id, step) => {
  spaces.moveSpace(id, step > 0 ? 1 : -1);
  sendState();
});
handleInternal('spaces:delete', (_e, id) => removeSpace(String(id)));
handleInternal('spaces:switch', (_e, id) => switchSpace(String(id)));

// "Mover para o espaço…": a aba é recriada na sessão do outro espaço (cookies são outros).
function moveTabToSpace(id, spaceId) {
  const tab = tabs.get(id);
  if (!tab || tab.space === spaceId || !spaces.getSpace(spaceId)) return;
  const url = tab.sleeping?.url ?? tab.view?.webContents.getURL() ?? tab.startUrl;
  const moved = createTab(url || HOME_URL, { space: spaceId, background: true });
  closeTab(id);
  activateTab(moved.id);
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  // Árvore: as abas filhas passam para a mãe desta aba.
  for (const child of tabs.values()) if (child.parentId === id) child.parentId = tab.parentId ?? null;
  // Fechando uma metade da tela dividida: a outra vira a aba ativa, em tela cheia.
  const splitPartnerId = tab.splitId ? splitPartner(tab)?.id : null;
  if (tab.splitId) dissolveSplit(tab.splitId);
  const url = tab.sleeping?.url ?? tab.view.webContents.getURL();
  if (url && !url.startsWith(HOME_URL)) {
    closedTabs.push({ url, space: tab.space });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  const siblings = tabsOfSpace(tab.space).map((t) => t.id);
  const index = siblings.indexOf(id);
  tab.translation?.job.cancel();
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  tabs.delete(id);
  if (tab.media) mediaChanged();

  if (spaceLastTab.get(tab.space) === id) spaceLastTab.delete(tab.space);
  const remaining = siblings.filter((key) => key !== id);
  if (activeId === id) {
    if (splitPartnerId && tabs.has(splitPartnerId)) {
      activateTab(splitPartnerId);
    } else if (remaining.length) {
      activateTab(remaining[Math.min(index, remaining.length - 1)]);
    } else if (tabs.size === 0 && settings.data.lastTabClose !== 'newtab') {
      win.close(); // era a última aba de todas
    } else {
      activeId = null;
      openNewTab(); // espaço ficou vazio: abre uma aba nova nele
    }
  } else {
    sendState();
  }
}

// Menu do botão direito numa aba da barra lateral.
function showTabMenu(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const wc = tab.view?.webContents;
  const url = tab.sleeping?.url ?? wc?.getURL() ?? '';
  const others = [...tabs.keys()].filter((key) => key !== id);
  Menu.buildFromTemplate([
    { label: 'Recarregar', enabled: Boolean(wc), click: () => wc.reload() },
    pinnedTabValid(tab)
      ? { label: 'Desafixar', click: () => unpin(tab.pinnedId) }
      : { label: 'Fixar aba', enabled: isWeb(url), click: () => pinTab(id) },
    { label: 'Duplicar aba', enabled: isWeb(url), click: () => createTab(url, { background: true, space: tab.space }) },
    { label: wc?.isAudioMuted() ? 'Ativar som' : 'Silenciar aba', enabled: Boolean(wc), click: () => {
      wc.setAudioMuted(!wc.isAudioMuted());
      sendState();
    } },
    { type: 'separator' },
    {
      label: tab.sleeping ? 'Dormindo 💤' : 'Pôr para dormir',
      enabled: Boolean(wc) && id !== activeId,
      click: () => sleepTab(tab),
    },
    {
      label: 'Pôr as outras abas para dormir',
      enabled: others.some((key) => tabs.get(key).view),
      click: () => others.forEach((key) => sleepTab(tabs.get(key))),
    },
    { type: 'separator' },
    tab.splitId
      ? { label: 'Desfazer divisão', click: () => dissolveSplit(tab.splitId) }
      : {
          label: 'Dividir tela com',
          submenu: [
            { label: 'Nova aba', click: () => splitWithNewTab(id) },
            { type: 'separator' },
            ...tabsOfSpace(tab.space)
              .filter((t) => t.id !== id)
              .slice(0, 20)
              .map((t) => ({ label: (tabInfo(t).title || 'Aba').slice(0, 50), click: () => createSplit(t.id, id, 'right') })),
          ],
        },
    {
      label: 'Mover para o espaço',
      enabled: spaces.listSpaces().length > 1,
      submenu: spaces.listSpaces().map((sp) => ({
        label: `${sp.icon}  ${sp.name}`,
        enabled: sp.id !== tab.space,
        click: () => moveTabToSpace(id, sp.id),
      })),
    },
    { type: 'separator' },
    { label: 'Fechar aba', click: () => closeTab(id) },
    { label: 'Fechar outras abas', enabled: others.length > 0, click: () => others.forEach(closeTab) },
  ]).popup({ window: win });
}

function reopenClosedTab() {
  const entry = closedTabs.pop();
  if (!entry) return;
  const space = spaces.getSpace(entry.space) ? entry.space : activeSpaceId;
  const tab = createTab(entry.url, { space, background: true });
  activateTab(tab.id);
}

function moveTab(id, toIndex) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.parentId = null; // arrastada para outro lugar: sai do ramo (as filhas continuam com ela)
  const order = tabsOfSpace(tab.space).map((t) => t.id).filter((key) => key !== id);
  order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id);
  // Reescreve a ordem geral trocando só as posições das abas deste espaço.
  let i = 0;
  const entries = [...tabs.entries()].map(([key, value]) => (value.space === tab.space ? order[i++] : key));
  setOrder(entries.map((key) => [key, tabs.get(key)]));
  sendState();
}

// Ordem visível na barra: fixadas abertas primeiro, depois as abas normais.
function visibleTabOrder() {
  const pinnedOpen = pinsOf(activeSpaceId).map((pin) => tabOfPin(pin.id)?.id).filter(Boolean);
  const normal = tabsOfSpace(activeSpaceId).filter((t) => !pinnedTabValid(t)).map((t) => t.id);
  return [...pinnedOpen, ...normal];
}

function cycleTab(step) {
  const order = visibleTabOrder();
  const index = order.indexOf(activeId);
  activateTab(order[(index + step + order.length) % order.length]);
}

// Abre uma página interna (wolf://history etc.), reaproveitando a aba se já estiver aberta.
function openInternal(name) {
  const [page, section] = name.split('#'); // ex.: 'settings#spaces' abre direto na seção
  const url = `wolf://${page}/`;
  const target = section ? `${url}#${section}` : url;
  const existing = tabsOfSpace(activeSpaceId).find((t) => (t.sleeping?.url ?? t.view.webContents.getURL()).startsWith(url));
  if (existing) {
    activateTab(existing.id);
    if (section) existing.view.webContents.loadURL(target);
  } else {
    createTab(target);
  }
}

// ---------- Histórico e favoritos ----------

function addHistory(tab, url) {
  if (!isWeb(url)) return;
  const store = historyOf(tab.space);
  const items = store.data.items;
  const last = items.at(-1);
  if (last && last.url === url) {
    tab.historyEntry = last;
    return;
  }
  const entry = { url, title: tab.view.webContents.getTitle() || url, time: Date.now() };
  items.push(entry);
  if (items.length > MAX_HISTORY) items.splice(0, items.length - MAX_HISTORY);
  tab.historyEntry = entry;
  store.save();
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const wc = tab.view.webContents;
  const url = wc.getURL();
  if (!isWeb(url)) return;
  const store = bookmarksOf(tab.space);
  const items = store.data.items;
  const index = items.findIndex((b) => b.url === url);
  if (index >= 0) items.splice(index, 1);
  else items.push({ url, title: wc.getTitle() || url, favicon: tab.favicon, time: Date.now() });
  store.save();
  sendState();
}

// Sugestões da barra de endereço: favoritos primeiro, depois histórico recente.
function suggest(text) {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const seen = new Set();
  const results = [];
  const add = (item, type) => {
    if (results.length >= 8 || seen.has(item.url)) return;
    if (!item.url.toLowerCase().includes(query) && !(item.title || '').toLowerCase().includes(query)) return;
    seen.add(item.url);
    results.push({ url: item.url, title: item.title || item.url, type });
  };
  for (const b of bookmarksOf(activeSpaceId).data.items) add(b, 'bookmark');
  const items = historyOf(activeSpaceId).data.items;
  for (let i = items.length - 1; i >= 0 && results.length < 8; i--) add(items[i], 'history');
  return results;
}

// ---------- Zoom, impressão e salvar ----------

function zoom(wc, direction) {
  if (!wc) return;
  const current = wc.getZoomFactor();
  let next = 1;
  if (direction > 0) next = ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1);
  else if (direction < 0) next = ZOOM_STEPS.findLast((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
  wc.setZoomFactor(next);
  sendState();
  showZoomToast(Math.round(next * 100));
}

// ---------- Barra de endereço no topo (gota) ----------
// Uma camada própria por cima da página. Escondida (modo "com o mouse"), fica como uma
// faixa fininha transparente no topo, só para perceber o mouse chegando.

const URLBAR_HEIGHT = 42; // altura da gota
const URLBAR_MARGIN = 14; // espaço em volta (sombra)
let urlbar = null;
let urlbarShown = false;
let urlbarExtra = 0; // altura extra quando a lista de sugestões está aberta
let urlbarHideTimer = null;
let lastPageBounds = null;

const urlbarTop = () => settings.data.urlBarPosition === 'top';

function refreshUrlbar() {
  if (!win) return;
  if (urlbarTop()) {
    if (!urlbar) {
      urlbar = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, 'urlbar-preload.js'), sandbox: true },
      });
      urlbar.setBackgroundColor('#00000000');
      urlbar.webContents.loadFile(path.join(__dirname, 'ui', 'urlbar.html'));
      urlbar.webContents.on('before-input-event', handleShortcut);
      urlbar.webContents.on('will-navigate', (e) => e.preventDefault());
      urlbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      urlbar.webContents.on('did-finish-load', sendState);
      win.contentView.addChildView(urlbar);
    }
    urlbarShown = settings.data.urlBarVisibility === 'always';
  } else if (urlbar) {
    win.contentView.removeChildView(urlbar);
    urlbar.webContents.close();
    urlbar = null;
    urlbarShown = false;
  }
  layout();
  sendState();
}

function layoutUrlbar() {
  if (!urlbar || !win || !lastPageBounds) return;
  if (htmlFullscreen) return urlbar.setVisible(false);
  urlbar.setVisible(true);
  const page = lastPageBounds;
  const always = settings.data.urlBarVisibility === 'always';
  const dropWidth = Math.round(Math.min(760, Math.max(340, page.width * 0.62)));
  const x = Math.round(page.x + (page.width - dropWidth) / 2) - URLBAR_MARGIN;
  // "Sempre visível": a gota fica no espaço acima da página; "com o mouse": por cima da página.
  const top = always ? Math.max(0, page.y - URLBAR_HEIGHT - 8) : page.y;
  if (!urlbarShown) {
    // Faixa fininha para perceber o mouse chegando no topo.
    urlbar.setBounds({ x: page.x, y: page.y, width: page.width, height: 5 });
    return;
  }
  urlbar.setBounds({
    x: Math.max(0, x),
    y: Math.max(0, top - (always ? 0 : 0)),
    width: dropWidth + URLBAR_MARGIN * 2,
    height: URLBAR_HEIGHT + URLBAR_MARGIN + urlbarExtra,
  });
  // A gota fica acima das páginas criadas depois dela.
  const children = win.contentView.children;
  if (children.indexOf(urlbar) < children.length - 1 && [...tabs.values()].some((t) => t.view && children.indexOf(t.view) > children.indexOf(urlbar))) {
    win.contentView.addChildView(urlbar);
  }
}

// Mostra a gota (modo "com o mouse"); focus = já coloca o cursor no endereço.
function showUrlbar(focus = false) {
  if (!urlbar) return;
  clearTimeout(urlbarHideTimer);
  if (!urlbarShown) {
    urlbarShown = true;
    win.contentView.addChildView(urlbar);
    layout();
    sendState();
  }
  if (focus) {
    urlbar.webContents.focus();
    urlbar.webContents.send('focus-address');
  }
}

function hideUrlbarSoon(ms = 450) {
  if (!urlbar || settings.data.urlBarVisibility === 'always') return;
  clearTimeout(urlbarHideTimer);
  urlbarHideTimer = setTimeout(() => {
    urlbarShown = false;
    urlbarExtra = 0;
    layout();
    sendState();
  }, ms);
}

onUi('urlbar:hover', (_e, over) => (over ? showUrlbar(false) : hideUrlbarSoon()));
onUi('urlbar:size', (_e, extra) => {
  urlbarExtra = Math.max(0, Math.min(460, Number(extra) || 0));
  layoutUrlbar();
});
onUi('urlbar:done', () => {
  // Terminou de digitar (Enter / Esc / clicou fora): devolve o foco à página.
  activeTab()?.view?.webContents.focus();
  hideUrlbarSoon(250);
});

// ---------- Painel lateral de IA ----------
// Cabeçalho (wolf://ai) + a página da IA. Cada IA aberta fica viva (a conversa continua);
// logins ficam numa sessão própria do painel.

const AI_HEADER = 44;
const ai = { open: false, current: null, bounds: null, header: null, views: new Map() };

const aiProviders = () => settings.data.aiProviders.filter((p) => p.enabled);
const aiSession = () => {
  const ses = session.fromPartition('persist:ai-panel');
  if (!readySessions.has(ses)) {
    readySessions.add(ses);
    setupSession(ses); // proteção, downloads, permissões (microfone para voz)...
  }
  return ses;
};

function aiView(providerId) {
  const provider = settings.data.aiProviders.find((p) => p.id === providerId);
  if (!provider) return null;
  if (!ai.views.has(providerId)) {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js'), session: aiSession() },
    });
    view.setBackgroundColor(currentTheme().surface);
    const wc = view.webContents;
    applyWebRtc(wc);
    wc.on('before-input-event', handleShortcut);
    wc.on('context-menu', (_e, params) => {
      const items = [];
      if (params.linkURL) items.push({ label: 'Abrir link numa aba', click: () => createTab(params.linkURL) });
      if (params.isEditable) items.push({ role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' });
      else if (params.selectionText) items.push({ role: 'copy', label: 'Copiar' });
      items.push({ type: 'separator' }, { label: 'Recarregar', click: () => wc.reload() });
      Menu.buildFromTemplate(items).popup({ window: win });
    });
    // Links abertos pela IA viram abas do espaço atual.
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) createTab(url, { background: false });
      return { action: 'deny' };
    });
    wc.on('did-stop-loading', sendAiState);
    wc.on('page-title-updated', sendAiState);
    wc.loadURL(provider.url);
    ai.views.set(providerId, view);
    win.contentView.addChildView(view);
  }
  return ai.views.get(providerId);
}

function ensureAiHeader() {
  if (ai.header) return;
  ai.header = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
  });
  ai.header.setBackgroundColor('#00000000');
  ai.header.webContents.loadURL('wolf://ai/');
  ai.header.webContents.on('before-input-event', handleShortcut);
  ai.header.webContents.on('did-finish-load', sendAiState);
  win.contentView.addChildView(ai.header);
}

function layoutAi() {
  const visible = ai.open && !htmlFullscreen && ai.bounds;
  ai.header?.setVisible(Boolean(visible));
  for (const [id, view] of ai.views) view.setVisible(Boolean(visible) && id === ai.current);
  if (!visible) return;
  const b = ai.bounds;
  ai.header.setBounds({ x: b.x, y: b.y, width: b.width, height: AI_HEADER });
  const view = ai.views.get(ai.current);
  if (view) {
    view.setBounds({ x: b.x, y: b.y + AI_HEADER, width: b.width, height: Math.max(0, b.height - AI_HEADER) });
    view.setBorderRadius(settings.data.pageFrame ? 10 : 0);
  }
}

function sendAiState() {
  if (!ai.header || ai.header.webContents.isDestroyed()) return;
  const view = ai.views.get(ai.current);
  ai.header.webContents.send('wolf:ai', {
    providers: aiProviders(),
    current: ai.current,
    loading: view?.webContents.isLoading() ?? false,
    title: view?.webContents.getTitle() ?? '',
    width: settings.data.aiWidth,
  });
}

function openAi(providerId) {
  const list = aiProviders();
  if (!list.length) return openInternal('settings#ai');
  const id = list.some((p) => p.id === providerId) ? providerId
    : list.some((p) => p.id === ai.current) ? ai.current
      : list.some((p) => p.id === settings.data.aiDefault) ? settings.data.aiDefault : list[0].id;
  ensureAiHeader();
  ai.current = id;
  ai.open = true;
  aiView(id);
  layout();
  ai.views.get(id).webContents.focus();
  sendAiState();
  sendState();
}

function closeAi() {
  if (!ai.open) return;
  ai.open = false;
  layout();
  activeTab()?.view?.webContents.focus();
  sendState();
}

const toggleAi = () => (ai.open ? closeAi() : openAi());

onUi('ai:toggle', () => toggleAi());
handleInternal('ai:select', (_e, id) => openAi(String(id)));
handleInternal('ai:close', () => closeAi());
handleInternal('ai:reload', () => ai.views.get(ai.current)?.webContents.reload());
handleInternal('ai:home', () => {
  const provider = settings.data.aiProviders.find((p) => p.id === ai.current);
  if (provider) ai.views.get(ai.current)?.webContents.loadURL(provider.url);
});
handleInternal('ai:open-tab', () => {
  const url = ai.views.get(ai.current)?.webContents.getURL();
  if (url && isWeb(url)) createTab(url);
});
handleInternal('ai:width', (_e, step) => {
  const sizes = [340, 440, 560, 720];
  const index = sizes.findIndex((w) => w >= settings.data.aiWidth);
  const next = sizes[Math.max(0, Math.min(sizes.length - 1, (index === -1 ? sizes.length - 1 : index) + (step > 0 ? 1 : -1)))];
  settings.data.aiWidth = next;
  settings.save();
  layout();
  sendAiState();
});
handleInternal('ai:settings', () => openInternal('settings#ai'));

// ---------- Aviso de zoom (pílula no topo da página) ----------

const TOAST_SIZE = { width: 250, height: 56 };
let toast = null;
let toastTimer = null;

function layoutToast() {
  if (!toast || !win) return;
  const { width } = win.getContentBounds();
  const side = sidebarVisibleWidth();
  const x = Math.round(side + (width - side - TOAST_SIZE.width) / 2);
  toast.setBounds({ x, y: 14, ...TOAST_SIZE });
}

function showZoomToast(percent) {
  if (!win) return;
  if (!toast) {
    toast = new WebContentsView({
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'page-preload.js') },
    });
    toast.setBackgroundColor('#00000000');
    toast.webContents.loadURL('wolf://toast/');
    toast.webContents.on('before-input-event', handleShortcut);
  }
  win.contentView.addChildView(toast); // por cima de tudo
  toast.setVisible(true);
  layoutToast();
  const send = () => toast.webContents.send('wolf:zoom', percent);
  if (toast.webContents.isLoading()) toast.webContents.once('did-finish-load', send);
  else send();
  scheduleToastHide(1600);
}

function scheduleToastHide(ms) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.setVisible(false), ms);
}

handleInternal('toast:zoom', (_e, direction) => zoom(activeTab()?.view?.webContents, Number(direction)));
// Mouse em cima da pílula: não some enquanto estiver sendo usada.
handleInternal('toast:hover', (_e, over) => scheduleToastHide(over ? 60000 : 900));

function safeFileName(name) {
  return (name || 'pagina').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

async function savePage(wc) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(downloadDir(), `${safeFileName(wc.getTitle())}.html`),
    filters: [{ name: 'Página web completa', extensions: ['html'] }],
  });
  if (canceled || !filePath) return;
  try {
    await wc.savePage(filePath, 'HTMLComplete');
  } catch (err) {
    dialog.showErrorBox('Não foi possível salvar a página', err.message);
  }
}

// ---------- Menu do botão direito ----------

function translateMenuItems(tab, pageURL) {
  if (!isWeb(pageURL)) return [];
  const langName = (code) => TRANSLATE_LANGS.find(([c]) => c === code)?.[1] ?? code;
  const items = [];
  if (tab.translation) {
    items.push(
      {
        label: tab.translation.job.showingOriginal ? `Mostrar tradução (${langName(tab.translation.lang)})` : 'Mostrar original',
        click: () => toggleOriginal(tab),
      },
      { label: 'Parar de traduzir', click: () => stopTranslation(tab) },
    );
  } else {
    const lang = settings.data.translateLang;
    items.push({ label: `Traduzir página para ${langName(lang)}`, click: () => translateTab(tab, lang) });
  }
  items.push({
    label: 'Traduzir para…',
    submenu: TRANSLATE_LANGS.map(([code, name]) => ({
      label: name,
      type: 'radio',
      checked: tab.translation?.lang === code,
      click: () => translateTab(tab, code),
    })),
  });
  return items;
}

function showContextMenu(tab, params) {
  const wc = tab.view.webContents;
  const items = [];
  const separator = () => {
    if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' });
  };

  if (params.misspelledWord) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    }
    items.push({
      label: 'Adicionar ao dicionário',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    separator();
  }

  if (params.linkURL) {
    items.push(
      { label: 'Visualizar link (Shift + clique)', enabled: isWeb(params.linkURL), click: () => openPreview(params.linkURL) },
      { label: 'Abrir link em nova aba', click: () => createTab(params.linkURL, { background: true, space: tab.space, openerId: tab.id }) },
      { label: 'Copiar endereço do link', click: () => clipboard.writeText(params.linkURL) },
    );
    separator();
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Abrir imagem em nova aba', click: () => createTab(params.srcURL, { background: true, space: tab.space }) },
      { label: 'Salvar imagem', click: () => wc.downloadURL(params.srcURL) },
      { label: 'Copiar imagem', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copiar endereço da imagem', click: () => clipboard.writeText(params.srcURL) },
    );
    separator();
  }

  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: 'Desfazer', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Refazer', enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Recortar', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copiar', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Colar', enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Selecionar tudo', enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
    separator();
  } else if (params.selectionText.trim()) {
    const text = params.selectionText.trim();
    const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
    const engine = SEARCH_ENGINES[settings.data.searchEngine] || SEARCH_ENGINES.google;
    items.push(
      { label: 'Copiar', click: () => wc.copy() },
      { label: `Pesquisar "${short}" no ${engine.name}`, click: () => createTab(searchUrl(text)) },
    );
    separator();
  }

  if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
    items.push(
      { label: 'Voltar', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Avançar', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Recarregar', click: () => wc.reload() },
      { type: 'separator' },
      ...translateMenuItems(tab, params.pageURL),
      { type: 'separator' },
      { label: 'Salvar página como…', click: () => savePage(wc) },
      { label: 'Imprimir…', click: () => wc.print() },
      { label: 'Ver código-fonte', enabled: isWeb(params.pageURL), click: () => createTab(`view-source:${params.pageURL}`) },
    );
    separator();
  }

  // Itens que as extensões adicionam ao menu.
  const extensionItems = extensionsOf(wc)?.getContextMenuItems(wc, params) ?? [];
  if (extensionItems.length) {
    separator();
    items.push(...extensionItems);
    separator();
  }

  items.push({ label: 'Inspecionar', click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- Downloads ----------

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

let downloadsTimer = null;
function downloadsChanged() {
  if (downloadsTimer) return;
  downloadsTimer = setTimeout(() => {
    downloadsTimer = null;
    sendState();
    sendToPages('wolf://downloads', 'downloads', downloads.data.items);
  }, 250);
}

// Downloads que ficaram pela metade na última vez não continuam.
for (const d of downloads.data.items) if (d.state === 'progressing') d.state = 'interrupted';

// Todas as sessões (espaços) gravam na mesma lista de downloads.
function setupDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    const savePath = uniquePath(downloadDir(), item.getFilename() || 'download');
    // "Perguntar onde salvar": o Electron mostra a janela de salvar com este caminho sugerido.
    if (settings.data.askDownload) item.setSaveDialogOptions({ defaultPath: savePath });
    else item.setSavePath(savePath);
    const record = {
      id: Date.now() + Math.random(),
      filename: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
      paused: false,
      time: Date.now(),
    };
    downloads.data.items.unshift(record);
    downloads.data.items.splice(MAX_DOWNLOADS);
    activeDownloads.set(record.id, item);
    if (settings.data.openDownloadsPanel) openPanel('downloads'); // mostra o download começando

    const update = () => {
      // Com "perguntar onde salvar", o caminho só é conhecido depois da escolha.
      const chosen = item.getSavePath();
      if (chosen && chosen !== record.path) {
        record.path = chosen;
        record.filename = path.basename(chosen);
      }
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.paused = item.isPaused();
      downloadsChanged();
    };
    item.on('updated', (_ev, state) => {
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      update();
    });
    item.once('done', (_ev, state) => {
      record.state = state; // completed | cancelled | interrupted
      activeDownloads.delete(record.id);
      update();
      downloads.save();
    });
    update();
    downloads.save();
  });
}

// ---------- Permissões (câmera, microfone, localização…) ----------

// Permissões liberadas sem perguntar (não dão acesso a nada sensível).
const SAFE_PERMISSIONS = new Set([
  'fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'speaker-selection',
  'window-placement', 'storage-access', 'top-level-storage-access', 'screen-wake-lock',
  'persistent-storage', 'background-sync', 'mediaKeySystem', 'accessibility-events',
]);

function setupPermissions(ses) {
  // Consultas do tipo "tenho permissão?" respondem de acordo com o que foi decidido.
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (SAFE_PERMISSIONS.has(permission)) return true;
    if (!ASK_PERMISSIONS[permission]) return false;
    // O Electron só responde "sim" ou "não" (não existe "vai perguntar"). Se respondesse "não"
    // antes de perguntar, alguns sites desistiriam sem pedir. Então: "não" só quando você bloqueou.
    if (settings.data.permissionDefaults[permission] === 'block') return false;
    let origin = requestingOrigin;
    try {
      origin = new URL(requestingOrigin || wc?.getURL() || '').origin;
    } catch {
      return false;
    }
    return settings.data.permissions[`${origin}|${permission}`] !== 'deny';
  });

  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const label = ASK_PERMISSIONS[permission];
    // Sem pergunta: só o que é inofensivo; o resto é bloqueado.
    if (!label) return callback(SAFE_PERMISSIONS.has(permission));
    let origin;
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {
      return callback(false);
    }
    const key = `${origin}|${permission}`;
    const saved = settings.data.permissions[key];
    if (saved) return callback(saved === 'allow');
    // "Bloquear sempre" para este tipo de permissão (câmera, localização...).
    if (settings.data.permissionDefaults[permission] === 'block') return callback(false);

    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Permitir', 'Bloquear'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permissão',
      message: `${origin} quer ${label}.`,
      checkboxLabel: 'Lembrar para este site',
      checkboxChecked: true,
    });
    const allow = response === 0;
    if (checkboxChecked) {
      settings.data.permissions[key] = allow ? 'allow' : 'deny';
      settings.save();
    }
    callback(allow);
  });
}

// ---------- Páginas internas (wolf://) ----------

function setupProtocol(ses = session.defaultSession) {
  ses.protocol.handle('wolf', async (request) => {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === '/theme.css') {
      return new Response(themeCss(currentTheme()), { headers: { 'content-type': 'text/css', 'cache-control': 'no-store' } });
    }
    const file = pathname === '/' || pathname === ''
      ? `${hostname}.html`
      : path.basename(decodeURIComponent(pathname));
    const full = path.join(PAGES_DIR, file);
    if (!full.startsWith(PAGES_DIR + path.sep) || !fs.existsSync(full)) {
      return new Response('Página não encontrada', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(full).href);
    const headers = new Headers(response.headers);
    // Nenhum site pode colocar uma página interna dentro de um iframe (clickjacking).
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}

// Só páginas wolf:// podem usar estes comandos.
function handleInternal(channel, fn) {
  ipcMain.handle(`wolf:${channel}`, (event, ...args) => {
    if (!event.senderFrame?.url.startsWith('wolf://')) throw new Error('Acesso negado');
    return fn(event, ...args);
  });
}

handleInternal('search', (e, text) => e.sender.loadURL(resolveInput(String(text))));

// Comandos do painel flutuante.
handleInternal('panel:close', closePanel);
handleInternal('panel:open', (_e, url, newTab) => {
  url = String(url);
  if (!isWeb(url)) return;
  closePanel();
  if (newTab) createTab(url, { background: true });
  else activeTab()?.view.webContents.loadURL(url);
});
handleInternal('panel:page', (_e, name) => {
  if (!PANELS.includes(name)) return;
  closePanel();
  openInternal(name);
});
handleInternal('downloads:folder', () => shell.openPath(downloadDir()));
handleInternal('downloads:choose-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Pasta de downloads',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  settings.data.downloadDir = filePaths[0];
  settings.save();
  return filePaths[0];
});

// Espaço de quem pediu: a aba da página interna, ou o espaço atual (painel flutuante).
const spaceOfSender = (event) => tabFromContents(event.sender)?.space ?? activeSpaceId;

handleInternal('history:list', (e, query = '') => {
  const q = query.trim().toLowerCase();
  const out = [];
  const items = historyOf(spaceOfSender(e)).data.items;
  for (let i = items.length - 1; i >= 0 && out.length < 1000; i--) {
    const item = items[i];
    if (!q || item.url.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)) out.push(item);
  }
  return out;
});
handleInternal('history:remove', (e, time) => {
  const store = historyOf(spaceOfSender(e));
  store.data.items = store.data.items.filter((item) => item.time !== time);
  store.save();
});
handleInternal('history:clear', (e) => {
  const store = historyOf(spaceOfSender(e));
  store.data.items = [];
  store.save();
});

handleInternal('bookmarks:list', (e) => bookmarksOf(spaceOfSender(e)).data.items);
handleInternal('bookmarks:remove', (e, url) => {
  const store = bookmarksOf(spaceOfSender(e));
  store.data.items = store.data.items.filter((b) => b.url !== url);
  store.save();
  sendState();
});
handleInternal('bookmarks:rename', (e, url, title) => {
  const store = bookmarksOf(spaceOfSender(e));
  const bookmark = store.data.items.find((b) => b.url === url);
  if (bookmark) bookmark.title = String(title);
  store.save();
  sendState();
});

const findDownload = (id) => downloads.data.items.find((d) => d.id === id);
handleInternal('downloads:list', () => downloads.data.items);
handleInternal('downloads:open', (_e, id) => shell.openPath(findDownload(id)?.path || ''));
handleInternal('downloads:show', (_e, id) => {
  const d = findDownload(id);
  if (d) shell.showItemInFolder(d.path);
});
handleInternal('downloads:pause', (_e, id) => {
  const item = activeDownloads.get(id);
  if (!item) return;
  if (item.isPaused()) item.resume();
  else item.pause();
  findDownload(id).paused = item.isPaused();
  downloadsChanged();
});
handleInternal('downloads:cancel', (_e, id) => activeDownloads.get(id)?.cancel());
handleInternal('downloads:remove', (_e, id) => {
  activeDownloads.get(id)?.cancel();
  downloads.data.items = downloads.data.items.filter((d) => d.id !== id);
  downloads.save();
  downloadsChanged();
});
handleInternal('downloads:clear', () => {
  downloads.data.items = downloads.data.items.filter((d) => d.state === 'progressing');
  downloads.save();
  downloadsChanged();
});

handleInternal('settings:get', () => ({
  ...settings.data,
  adblockReady: Boolean(blocker),
  protectionPresets: PROTECTION_PRESETS,
  dohProviders: Object.fromEntries(Object.entries(DOH_PROVIDERS).map(([k, v]) => [k, v.name])),
  engines: Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
  themes: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, { name: v.name, frame: v.frame, surface: v.surface, surface2: v.surface2, accent: v.accent }])),
  spaces: spaces.listSpaces().map((sp) => ({ ...sp, tabs: tabsOfSpace(sp.id).length })),
  activeSpace: activeSpaceId,
  extensionList: extensionList(),
  // Cores atuais do sistema (null fora do Wolf OS).
  systemTheme: systemThemeInfo(),
  languages: TRANSLATE_LANGS,
  shortcutList: shortcutList(),
  downloadDirEffective: downloadDir(),
  versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
  dataPath: app.getPath('userData'),
}));

const oneOf = (...options) => (v) => (options.includes(v) ? v : undefined);
const oneOfNumber = (options) => (v) => (options.includes(Number(v)) ? Number(v) : undefined);
const bool = (v) => Boolean(v);
const text = (max) => (v) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

// O que cada configuração aceita. Valor inválido é ignorado.
// Barra lateral personalizada: aceita só itens conhecidos, sem repetir, e completa o que faltar.
const SIDEBAR_SECTIONS = ['brand', 'nav', 'address', 'extensions', 'bookmarks', 'spaces', 'pinned', 'tabs', 'footer'];
const SIDEBAR_FOOTER = ['media', 'ai', 'history', 'downloads', 'bookmarks', 'extensions', 'settings'];
const SIDEBAR_HIDEABLE = ['brand', 'nav', 'extensions', 'bookmarks', 'spaces', 'pinned', 'footer', 'label', 'newTab',
  'back', 'forward', 'reload', 'home', 'f:media', 'f:ai', 'f:history', 'f:downloads', 'f:bookmarks', 'f:extensions'];
function cleanOrder(value, known) {
  const order = (Array.isArray(value) ? value : []).filter((id, i, all) => known.includes(id) && all.indexOf(id) === i);
  return [...order, ...known.filter((id) => !order.includes(id))];
}
function cleanSidebarLayout(v) {
  if (!v || typeof v !== 'object') return undefined;
  return {
    sections: cleanOrder(v.sections, SIDEBAR_SECTIONS),
    footer: cleanOrder(v.footer, SIDEBAR_FOOTER),
    hidden: (Array.isArray(v.hidden) ? v.hidden : []).filter((id, i, all) => SIDEBAR_HIDEABLE.includes(id) && all.indexOf(id) === i),
  };
}

const SETTINGS_SCHEMA = {
  searchEngine: (v) => (SEARCH_ENGINES[v] ? v : undefined),
  startup: oneOf('restore', 'newtab', 'home'),
  homeUrl: text(2000),
  newTabUrl: text(2000),
  linkTabPosition: oneOf('after', 'end'),
  lastTabClose: oneOf('window', 'newtab'),
  // 'off' ou combinação de ctrl/alt/shift (Ctrl sozinho já abre aba nova, então não vale).
  previewModifier: (v) => {
    if (v === 'off') return v;
    const parts = String(v).split('+');
    const order = ['ctrl', 'alt', 'shift'];
    const valid = parts.length && parts.every((p) => order.includes(p)) && new Set(parts).size === parts.length;
    if (!valid || (parts.length === 1 && parts[0] === 'ctrl')) return undefined;
    return order.filter((p) => parts.includes(p)).join('+');
  },
  sidebarExpandDelay: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? Math.round(Number(v)) : undefined),
  sidebarCollapseDelay: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? Math.round(Number(v)) : undefined),
  sidebarWidth: (v) => (Number(v) >= 220 && Number(v) <= 380 ? Math.round(Number(v)) : undefined),
  tabDensity: oneOf('comfortable', 'compact'),
  tabGrouping: oneOf('off', 'tree', 'site'),
  sidebarLayout: cleanSidebarLayout,
  sidebarPresets: (v) => (Array.isArray(v)
    ? v.slice(0, 12).map((p) => ({ name: String(p?.name || '').trim().slice(0, 30), layout: cleanSidebarLayout(p?.layout) })).filter((p) => p.name && p.layout)
    : undefined),
  pageFrame: bool,
  scrollbars: oneOf('wolf', 'default'),
  urlBarPosition: oneOf('sidebar', 'top'),
  urlBarVisibility: oneOf('always', 'hover'),
  aiProviders: (v) => (Array.isArray(v)
    ? v.slice(0, 30)
      .map((p) => ({
        id: String(p?.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30),
        name: String(p?.name || '').trim().slice(0, 30),
        url: String(p?.url || '').trim().slice(0, 2000),
        enabled: Boolean(p?.enabled),
        custom: Boolean(p?.custom),
      }))
      .filter((p) => p.id && p.name && isWeb(p.url))
    : undefined),
  aiDefault: text(30),
  aiSide: oneOf('right', 'left'),
  aiWidth: (v) => (Number(v) >= 300 && Number(v) <= 1000 ? Math.round(Number(v)) : undefined),
  sleepAfter: oneOfNumber([0, 5, 15, 30, 60, 120]),
  adblock: bool,
  blockTrackers: bool,
  blockThirdPartyCookies: bool,
  antiFingerprint: bool,
  blockPopups: bool,
  sendGpc: bool,
  dnsOverHttps: oneOf('off', 'automatic', 'cloudflare', 'google', 'quad9', 'adguard'),
  webrtcPolicy: oneOf('default', 'public', 'disabled'),
  siteIsolation: bool,
  clearOnExit: (v) => (Array.isArray(v) ? [...new Set(v.filter((k) => ['history', 'cache', 'cookies', 'downloads'].includes(k)))] : undefined),
  permissionDefaults: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const out = {};
    for (const kind of ['media', 'geolocation', 'notifications']) out[kind] = v[kind] === 'block' ? 'block' : 'ask';
    return out;
  },
  theme: (v) => (THEMES[v] || v === 'system' ? v : undefined),
  accent: (v) => (v === null || /^#[0-9a-f]{6}$/i.test(String(v)) ? v : undefined),
  translateLang: (v) => (TRANSLATE_LANGS.some(([code]) => code === v) ? v : undefined),
  askDownload: bool,
  openDownloadsPanel: bool,
  newtabName: text(40),
  newtabClock: bool,
  newtabGreeting: bool,
  newtabFavorites: bool,
  tiles: (v) => (Array.isArray(v)
    ? v.slice(0, 24)
      .map((t) => ({ name: String(t?.name ?? '').trim().slice(0, 40), url: String(t?.url ?? '').trim().slice(0, 2000) }))
      .filter((t) => t.name && t.url)
    : undefined),
};

// Efeitos imediatos de algumas configurações.
const SETTINGS_EFFECTS = {
  sidebarWidth: layout,
  pageFrame: layout,
  scrollbars: refreshScrollbars,
  urlBarPosition: refreshUrlbar,
  urlBarVisibility: refreshUrlbar,
  aiSide: layout,
  aiWidth: layout,
  aiProviders: () => sendAiState(),
  dnsOverHttps: applyDnsOverHttps,
  webrtcPolicy: refreshWebRtc,
  sleepAfter: checkIdleTabs,
  theme: applyTheme,
  accent: applyTheme,
};

handleInternal('settings:set', (_e, key, value) => {
  if (key === 'sidebarMode') {
    setSidebarMode(value);
    return;
  }
  const validate = SETTINGS_SCHEMA[key];
  if (!validate) return;
  const clean = validate(value);
  if (clean === undefined) return;
  settings.data[key] = clean;
  settings.save();
  SETTINGS_EFFECTS[key]?.();
  sendState();
});
// Níveis prontos de proteção.
const PROTECTION_PRESETS = {
  off: {
    adblock: false, blockTrackers: false, blockThirdPartyCookies: false, antiFingerprint: false,
    blockPopups: false, sendGpc: false, dnsOverHttps: 'off', webrtcPolicy: 'default',
  },
  standard: {
    adblock: true, blockTrackers: true, blockThirdPartyCookies: true, antiFingerprint: false,
    blockPopups: true, sendGpc: true, dnsOverHttps: 'off', webrtcPolicy: 'public',
  },
  strict: {
    adblock: true, blockTrackers: true, blockThirdPartyCookies: true, antiFingerprint: true,
    blockPopups: true, sendGpc: true, dnsOverHttps: 'cloudflare', webrtcPolicy: 'disabled',
  },
};
handleInternal('protection:preset', (_e, name) => {
  const preset = PROTECTION_PRESETS[name];
  if (!preset) return;
  Object.assign(settings.data, preset);
  settings.save();
  applyDnsOverHttps();
  refreshWebRtc();
  sendState();
});
handleInternal('adblock:allow-remove', (_e, host) => {
  settings.data.adblockAllow = settings.data.adblockAllow.filter((h) => h !== host);
  settings.save();
  sendState();
});
handleInternal('shortcuts:set', (_e, id, combo) => setShortcut(id, combo));
handleInternal('shortcuts:reset-all', () => {
  settings.data.shortcuts = {};
  settings.save();
  return shortcutList();
});
// Enquanto a página de configurações grava um atalho, as teclas não disparam ações.
handleInternal('shortcuts:capture', (e, on) => {
  capturingShortcut = on ? e.sender : null;
});
handleInternal('open-data-folder', () => shell.openPath(app.getPath('userData')));
handleInternal('open-error-log', () => {
  const file = path.join(app.getPath('userData'), 'erros.log');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  shell.openPath(file);
});
handleInternal('permissions:remove', (_e, key) => {
  delete settings.data.permissions[key];
  settings.save();
});
handleInternal('data:clear', (_e, kinds) => clearBrowsingData(kinds));

// Limpa os dados de todos os espaços.
async function clearBrowsingData(kinds) {
  for (const space of spaces.listSpaces()) {
    const ses = spaces.sessionOf(space.id);
    if (kinds.includes('history')) {
      const store = historyOf(space.id);
      store.data.items = [];
      store.save();
    }
    if (kinds.includes('cache')) await ses.clearCache();
    if (kinds.includes('cookies')) await ses.clearStorageData();
  }
  if (kinds.includes('history')) closedTabs.length = 0;
  if (kinds.includes('downloads')) {
    downloads.data.items = downloads.data.items.filter((d) => d.state === 'progressing');
    downloads.save();
    downloadsChanged();
  }
  flushAll();
}

// ---------- Atalhos de teclado ----------

function openFind() {
  revealSidebar();
  ui.webContents.focus();
  ui.webContents.send('find-open');
}

let capturingShortcut = null;

function shortcutList() {
  return SHORTCUT_ACTIONS.map((a) => ({ ...a, default: a.keys, keys: settings.data.shortcuts[a.id] ?? a.keys }));
}

// Grava um atalho. combo null = volta ao padrão; '' = desativado.
// Se a combinação já era usada por outra ação, essa outra fica sem atalho.
function setShortcut(id, combo) {
  if (!SHORTCUT_ACTIONS.some((a) => a.id === id)) return shortcutList();
  const overrides = settings.data.shortcuts;
  if (combo === null) delete overrides[id];
  else overrides[id] = String(combo).slice(0, 40);
  const keys = combo === null ? SHORTCUT_ACTIONS.find((a) => a.id === id).keys : overrides[id];
  if (keys) {
    for (const other of shortcutList()) {
      if (other.id !== id && other.keys === keys) overrides[other.id] = '';
    }
  }
  settings.save();
  shortcutMap = null;
  return shortcutList();
}

let shortcutMap = null;
function currentShortcutMap() {
  if (!shortcutMap) {
    shortcutMap = new Map();
    for (const a of shortcutList()) if (a.keys) shortcutMap.set(a.keys, a.id);
  }
  return shortcutMap;
}

function runAction(id, input) {
  const wc = activeTab()?.view?.webContents;
  const actions = {
    newTab: openNewTab,
    closeTab: () => closeTab(activeId),
    reopenTab: reopenClosedTab,
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    sleepOthers: () => [...tabs.values()].forEach((t) => t.id !== activeId && sleepTab(t)),
    focusAddress: () => {
      if (urlbarTop()) return showUrlbar(true);
      revealSidebar();
      ui.webContents.focus();
      ui.webContents.send('focus-address');
    },
    back: () => wc?.navigationHistory.goBack(),
    forward: () => wc?.navigationHistory.goForward(),
    reload: () => wc?.reload(),
    hardReload: () => wc?.reloadIgnoringCache(),
    home: () => wc?.loadURL(homeTarget()),
    find: openFind,
    zoomIn: () => zoom(wc, 1),
    zoomOut: () => zoom(wc, -1),
    zoomReset: () => zoom(wc, 0),
    translate: () => {
      const tab = activeTab();
      if (tab?.translation) toggleOriginal(tab);
      else translateTab(tab, settings.data.translateLang);
    },
    bookmark: toggleBookmark,
    print: () => wc?.print(),
    savePage: () => wc && savePage(wc),
    viewSource: () => wc && isWeb(wc.getURL()) && createTab(`view-source:${wc.getURL()}`),
    fullscreen: () => win.setFullScreen(!win.isFullScreen()),
    devtools: () => wc?.toggleDevTools(),
    toggleSidebar,
    history: () => togglePanel('history'),
    downloads: () => togglePanel('downloads'),
    bookmarks: () => togglePanel('bookmarks'),
    extensions: () => togglePanel('extensions'),
    settings: () => openInternal('settings'),
    nextSpace: () => cycleSpace(1),
    toggleAi: () => toggleAi(),
    splitNew: () => activeId !== null && (splitOf(tabs.get(activeId)) ? dissolveSplit(tabs.get(activeId).splitId) : splitWithNewTab(activeId)),
    prevSpace: () => cycleSpace(-1),
  };
  actions[id]?.(input);
}

// Atalhos fixos que continuam valendo (se a combinação não foi usada por outra ação).
function fixedShortcut(combo, input) {
  const wc = activeTab()?.view?.webContents;
  if (/^Ctrl\+[1-9]$/.test(combo)) {
    const order = visibleTabOrder();
    const n = Number(combo.at(-1));
    return () => activateTab(n === 9 ? order.at(-1) : order[n - 1]);
  }
  if (/^Ctrl\+Alt\+[1-9]$/.test(combo)) {
    const list = spaces.listSpaces();
    const n = Number(combo.at(-1));
    return () => list[n - 1] && switchSpace(list[n - 1].id);
  }
  const fixed = {
    F5: () => wc?.reload(),
    'Ctrl+F5': () => wc?.reloadIgnoringCache(),
    F6: () => runAction('focusAddress'),
    F3: openFind,
    'Ctrl+G': openFind,
    'Ctrl++': () => zoom(wc, 1),
    'Ctrl+Shift+I': () => wc?.toggleDevTools(),
    'Ctrl+Shift+Delete': () => openInternal('settings'),
  };
  if (fixed[combo]) return fixed[combo];
  if (input.key === 'Escape' && panelName) return closePanel;
  return null;
}

// Chamado em todas as páginas e na barra lateral (this = o webContents que recebeu a tecla).
function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  if (capturingShortcut && this === capturingShortcut) return;
  const combo = comboFrom(input);
  if (!combo) return;
  const id = currentShortcutMap().get(combo);
  const action = id ? () => runAction(id, input) : fixedShortcut(combo, input);
  if (action) {
    event.preventDefault();
    action();
  }
}

// ---------- Comandos vindos da barra lateral ----------

onUi('tab:new', openNewTab);
onUi('tab:toggle-tree', (_e, id) => {
  const tab = tabs.get(Number(id));
  if (!tab) return;
  tab.treeCollapsed = !tab.treeCollapsed;
  sendState();
});
onUi('space:switch', (_e, id) => switchSpace(String(id)));
onUi('space:cycle', (_e, step) => cycleSpace(step > 0 ? 1 : -1));
onUi('space:menu', (_e, id) => showSpaceMenu(String(id)));
onUi('space:manage', () => openInternal('settings#spaces'));
onUi('ui:focus-address', () => runAction('focusAddress'));
// Lista de espaços (clique no espaço atual com a barra recolhida).
onUi('space:picker', () => {
  Menu.buildFromTemplate([
    ...spaces.listSpaces().map((sp, i) => ({
      label: `${sp.icon}  ${sp.name}`,
      type: 'radio',
      checked: sp.id === activeSpaceId,
      accelerator: i < 9 ? `Ctrl+Alt+${i + 1}` : undefined,
      registerAccelerator: false,
      click: () => switchSpace(sp.id),
    })),
    { type: 'separator' },
    { label: 'Editar espaços…', click: () => openInternal('settings#spaces') },
  ]).popup({ window: win });
});
onUi('tab:sleep', (_e, id) => sleepTab(tabs.get(id)));
onUi('tab:menu', (_e, id) => showTabMenu(id));
onUi('tab:close', (_e, id) => closeTab(id));
onUi('tab:activate', (_e, id) => activateTab(id));
onUi('tab:move', (_e, id, toIndex) => moveTab(id, toIndex));
onUi('tab:mute', (_e, id) => {
  const wc = tabs.get(id)?.view?.webContents;
  if (!wc) return;
  wc.setAudioMuted(!wc.isAudioMuted());
  sendState();
});
onUi('ui:toggle-sidebar', toggleSidebar);
onUi('ui:hover', (_e, open) => setHoverOpen(open));
onUi('ui:panel', (_e, name) => togglePanel(name));
onUi('ui:open-page', (_e, name) => {
  if (['history', 'downloads', 'bookmarks', 'settings'].includes(name)) openInternal(name);
});
onUi('bookmark:toggle', toggleBookmark);
onUi('bookmark:open', (_e, url, newTab) => {
  if (!isWeb(url)) return;
  if (newTab) createTab(url, { background: true });
  else activeTab()?.view.webContents.loadURL(url);
});
handleUi('suggest', (_e, text) => suggest(String(text)));
onUi('find:query', (_e, text, options = {}) => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    ui.webContents.send('find-result', { active: 0, matches: 0 });
    return;
  }
  wc.findInPage(String(text), { forward: options.forward !== false, findNext: Boolean(options.newSearch) });
});
onUi('find:stop', () => {
  const wc = activeTab()?.view.webContents;
  wc?.stopFindInPage('clearSelection');
  wc?.focus();
});
onUi('zoom:reset', () => zoom(activeTab()?.view.webContents, 0));
onUi('nav:go', (_e, text) => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  wc.loadURL(resolveInput(String(text)));
  wc.focus();
});
onUi('nav:back', () => activeTab()?.view.webContents.navigationHistory.goBack());
onUi('nav:forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
onUi('nav:reload', () => activeTab()?.view.webContents.reload());
onUi('nav:stop', () => activeTab()?.view.webContents.stop());
onUi('nav:home', () => activeTab()?.view.webContents.loadURL(homeTarget()));

// Aceita certificados próprios (ex.: um servidor Proxmox em casa)
// só em endereços da rede local e do Tailscale. Na internet, bloqueia.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  if (isPrivateHost(new URL(url).hostname)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// ---------- Proteção (anúncios, rastreadores, cookies, fingerprinting...) ----------

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// Sites onde o usuário desligou a proteção pelo escudo da barra de endereço.
const siteAllowed = (url) => settings.data.adblockAllow.includes(hostOf(url));

// Algum item de proteção ligado para este site?
function protectionActiveFor(url) {
  const d = settings.data;
  const any = d.adblock || d.blockTrackers || d.blockThirdPartyCookies || d.antiFingerprint || d.blockPopups;
  return any && !siteAllowed(url);
}
// (mantido para o escudo e a barra lateral)
const adblockActiveFor = protectionActiveFor;
const protectionAnyOn = () => {
  const d = settings.data;
  return d.adblock || d.blockTrackers || d.blockThirdPartyCookies || d.antiFingerprint || d.blockPopups;
};

let adsEngine = null; // anúncios (com filtros visuais)
let trackerEngine = null; // rastreadores (só rede)

// Página (aba) de onde veio uma requisição; vazio para extensões e service workers.
function pageUrlOf(webContentsId) {
  if (webContentsId === undefined || webContentsId === null) return '';
  const tab = [...tabs.values()].find((t) => t.view && t.view.webContents.id === webContentsId);
  if (tab) return tab.view.webContents.getURL();
  if (preview && preview.view.webContents.id === webContentsId) return preview.view.webContents.getURL();
  return '';
}

// Requisição de terceiros = domínio diferente do site aberto na aba.
function isThirdParty(details) {
  const page = pageUrlOf(details.webContentsId);
  if (!isWeb(page)) return false;
  const a = getDomain(hostOf(page)) || hostOf(page);
  const b = getDomain(hostOf(details.url)) || hostOf(details.url);
  return Boolean(a && b && a !== b);
}

let blockedTimer = null;
function countBlocked(webContentsId, kind) {
  if (webContentsId === undefined) return;
  const counts = blockedCounts.get(webContentsId) || { ads: 0, trackers: 0 };
  counts[kind] += 1;
  blockedCounts.set(webContentsId, counts);
  if (!blockedTimer) {
    blockedTimer = setTimeout(() => {
      blockedTimer = null;
      sendState();
    }, 300);
  }
}

async function loadBlockEngines() {
  const cache = (name) => ({
    path: path.join(app.getPath('userData'), name),
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });
  // Listas antigas (anúncios + rastreadores juntos), de versões anteriores.
  fs.promises.rm(path.join(app.getPath('userData'), 'adblock-engine.bin'), { force: true }).catch(() => {});
  const trackerLists = adsAndTrackingLists.filter((url) => !adsLists.includes(url));
  const [ads, trackers] = await Promise.allSettled([
    // Listas de anúncios do uBlock (com filtros que escondem os espaços vazios).
    ElectronBlocker.fromPrebuiltAdsOnly(fetch, cache('adblock-ads.bin')),
    // EasyPrivacy + privacidade do uBlock: rastreadores e analytics.
    ElectronBlocker.fromLists(fetch, trackerLists, { loadCosmeticFilters: false }, cache('adblock-trackers.bin')),
  ]);
  if (ads.status === 'fulfilled') adsEngine = ads.value;
  else console.error('Bloqueador de anúncios indisponível:', ads.reason?.message);
  if (trackers.status === 'fulfilled') trackerEngine = trackers.value;
  else console.error('Bloqueador de rastreadores indisponível:', trackers.reason?.message);
  blocker = adsEngine || trackerEngine; // "pronto" para as configurações

  adsEngine?.on('request-blocked', (request) => countBlocked(request.tabId, 'ads'));
  adsEngine?.on('request-redirected', (request) => countBlocked(request.tabId, 'ads'));
}

let engineCosmeticsReady = false;
const injectedScriptlets = new Set(); // scripts anti-anúncio já injetados (aba + endereço)

function setupProtection(ses) {
  // 1) Pedidos de rede: rastreadores, depois anúncios.
  const onRequest = (details, callback) => {
    const page = pageUrlOf(details.webContentsId);
    if (page && siteAllowed(page)) return callback({});
    if (settings.data.blockTrackers && trackerEngine) {
      const request = fromElectronDetails(details);
      if (!request.isMainFrame()) {
        const { match } = trackerEngine.match(request);
        if (match) {
          countBlocked(details.webContentsId, 'trackers');
          return callback({ cancel: true });
        }
      }
    }
    if (settings.data.adblock && adsEngine) return adsEngine.onBeforeRequest(details, callback);
    return callback({});
  };

  // 2) Cabeçalhos enviados: tira cookies de terceiros; envia "não venda meus dados" (GPC).
  const onSendHeaders = (details, callback) => {
    const headers = { ...details.requestHeaders };
    const page = pageUrlOf(details.webContentsId);
    const protectedSite = !page || !siteAllowed(page);
    if (protectedSite && settings.data.blockThirdPartyCookies && isThirdParty(details)) {
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'cookie') delete headers[name];
    }
    if (settings.data.sendGpc) {
      headers['Sec-GPC'] = '1';
      headers.DNT = '1';
    }
    callback({ requestHeaders: headers });
  };

  // 3) Cabeçalhos recebidos: filtros de anúncio (CSP) e bloqueio de cookies de terceiros.
  const onHeaders = (details, callback) => {
    const page = pageUrlOf(details.webContentsId);
    const protectedSite = !page || !siteAllowed(page);
    const finish = (result = {}) => {
      if (protectedSite && settings.data.blockThirdPartyCookies && isThirdParty(details)) {
        const headers = { ...(result.responseHeaders || details.responseHeaders) };
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'set-cookie') delete headers[name];
        return callback({ ...result, responseHeaders: headers });
      }
      return callback(result);
    };
    if (protectedSite && settings.data.adblock && adsEngine) return adsEngine.onHeadersReceived(details, finish);
    return finish({});
  };

  const register = () => {
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onRequest);
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, onSendHeaders);
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeaders);
  };
  register();
  protectedSessions.set(ses, register);
  // Listas já carregadas (espaço criado depois): liga os filtros visuais nesta sessão.
  if (engineCosmeticsReady) enableCosmetics(ses);
}

// Sessões com o funil de proteção (valor = função que registra o funil de novo).
const protectedSessions = new Map();

// Filtros visuais (esconder espaços de anúncio) numa sessão.
function enableCosmetics(ses) {
  if (ses === session.defaultSession) {
    // Na sessão principal a biblioteca registra tudo (inclusive os canais usados por todas as sessões)...
    adsEngine.enableBlockingInSession(ses);
  } else {
    // ...nas outras, só o script que roda nas páginas.
    ses.registerPreloadScript({ type: 'frame', filePath: ADBLOCK_PRELOAD });
  }
  // A biblioteca troca o funil de rede; registra o nosso de novo (o último vale).
  protectedSessions.get(ses)?.();
}

function startBlockEngines() {
  loadBlockEngines().then(() => {
    if (!adsEngine) return;
    // Filtros visuais (esconder espaços de anúncio) respeitam a chave e os sites liberados.
    const onInjectCosmeticFilters = adsEngine.onInjectCosmeticFilters;
    adsEngine.onInjectCosmeticFilters = (event, url, msg) => {
      if (!settings.data.adblock || siteAllowed(url)) return undefined;
      // A biblioteca injeta sempre na página PRINCIPAL, mesmo quando quem pediu foi um iframe.
      // Com vários iframes (o YouTube tem muitos), os mesmos scripts entravam várias vezes,
      // "embrulhando" funções da página até estourar ("Maximum call stack") e quebrar o player.
      // Então só a página principal recebe a injeção.
      if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return undefined;
      // Os pequenos scripts anti-anúncio às vezes falham (sites que bloqueiam scripts de fora);
      // a biblioteca não trata essa falha, então ela é ignorada aqui para não gerar avisos.
      const { sender } = event;
      const safeEvent = {
        frameId: event.frameId,
        processId: event.processId,
        sender: {
          insertCSS: (css, options) => sender.insertCSS(css, options).catch(() => {}),
          executeJavaScript: (code, userGesture) => {
            // Cada script roda uma vez por página...
            const key = `${sender.id}|${sender.getURL()}|${code.length}|${code.slice(0, 200)}`;
            if (injectedScriptlets.has(key)) return Promise.resolve();
            injectedScriptlets.add(key);
            if (injectedScriptlets.size > 2000) injectedScriptlets.clear();
            // ...e dentro de um bloco próprio: vários scripts declaram "JSONPath" no topo e,
            // no mesmo escopo global, o segundo quebrava (e o resto estourava a pilha do site).
            return sender.executeJavaScript(`{\n${code}\n}`, userGesture).catch(() => {});
          },
        },
      };
      return onInjectCosmeticFilters(safeEvent, url, msg);
    };
    engineCosmeticsReady = true;
    // Sessão principal primeiro (registra os canais usados por todas).
    const sessions = [...protectedSessions.keys()].sort((a) => (a === session.defaultSession ? -1 : 1));
    for (const ses of sessions) enableCosmetics(ses);
  });
}

// ---------- DNS over HTTPS ----------

const DOH_PROVIDERS = {
  cloudflare: { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  google: { name: 'Google', url: 'https://dns.google/dns-query' },
  quad9: { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
  adguard: { name: 'AdGuard (bloqueia anúncios)', url: 'https://dns.adguard-dns.com/dns-query' },
};

function applyDnsOverHttps() {
  const choice = settings.data.dnsOverHttps;
  try {
    if (choice === 'off') app.configureHostResolver({ secureDnsMode: 'off' });
    else if (choice === 'automatic') app.configureHostResolver({ secureDnsMode: 'automatic' });
    else app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [DOH_PROVIDERS[choice].url] });
  } catch (err) {
    logError('DNS over HTTPS', err);
  }
}

// ---------- WebRTC ----------

const WEBRTC_POLICIES = {
  default: 'default',
  public: 'default_public_interface_only', // não revela o IP da rede local
  disabled: 'disable_non_proxied_udp', // bloqueia conexões diretas (chamadas podem falhar)
};

function applyWebRtc(wc) {
  try {
    wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICIES[settings.data.webrtcPolicy] || 'default');
  } catch {
    // página fechou
  }
}

function refreshWebRtc() {
  for (const tab of tabs.values()) if (tab.view) applyWebRtc(tab.view.webContents);
}

// ---------- Limpar dados ao fechar ----------

let exitCleaned = false;
app.on('before-quit', (event) => {
  const kinds = settings.data.clearOnExit;
  if (exitCleaned || !kinds.length) return;
  event.preventDefault();
  exitCleaned = true;
  clearBrowsingData(kinds)
    .catch((err) => logError('Limpeza ao fechar', err))
    .finally(() => app.quit());
});

// ---------- Escudo por site ----------

function toggleAdblockForSite() {
  const wc = activeTab()?.view?.webContents;
  const host = hostOf(wc?.getURL() ?? '');
  if (!host) return;
  const allow = settings.data.adblockAllow;
  const index = allow.indexOf(host);
  if (index >= 0) allow.splice(index, 1);
  else allow.push(host);
  settings.save();
  wc.reload();
  sendState();
}

onUi('adblock:toggle-site', toggleAdblockForSite);

// Configurações lidas por cada página ao carregar (page-preload.js).
const fingerprintSecret = Math.floor(Math.random() * 2 ** 31);
ipcMain.on('wolf:page-config', (event, pageUrl) => {
  const url = String(pageUrl || '');
  const protectedSite = isWeb(url) && !siteAllowed(url);
  // Semente do "ruído" anti-fingerprint: igual no mesmo site durante a sessão.
  let seed = fingerprintSecret;
  for (const ch of getDomain(hostOf(url)) || hostOf(url)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  event.returnValue = {
    previewModifier: settings.data.previewModifier,
    fingerprint: protectedSite && settings.data.antiFingerprint ? seed : null,
    blockPopups: protectedSite && settings.data.blockPopups,
    // Bloqueio específico do YouTube (anúncios do player), junto com o bloqueio de anúncios.
    youtubeAds: protectedSite && settings.data.adblock && /(^|\.)youtube\.com$/.test(hostOf(url)),
    isPreview: Boolean(preview && event.sender === preview.view.webContents),
  };
});

// Pop-up aberto sem clique do usuário foi bloqueado.
ipcMain.on('popup-blocked', (event, url) => {
  const tab = tabFromContents(event.sender);
  if (!tab) return;
  tab.blockedPopup = { url: String(url || ''), count: (tab.blockedPopup?.count || 0) + 1 };
  sendState();
});
onUi('popup:open', () => {
  const tab = activeTab();
  const url = tab?.blockedPopup?.url;
  if (tab) tab.blockedPopup = null;
  if (url && isWeb(url)) createTab(url);
  else sendState();
});
onUi('popup:dismiss', () => {
  const tab = activeTab();
  if (tab) tab.blockedPopup = null;
  sendState();
});

// ---------- Extensões do Chrome ----------

const tabFromContents = (wc) => (wc ? [...tabs.values()].find((t) => t.view && t.view.webContents === wc) : undefined);

// Enquanto o navegador informa a biblioteca sobre abas, ela "ativa" abas por conta própria
// e chama selectTab. Esses avisos são ignorados; só pedidos reais das extensões valem.
let syncingExtensions = false;
function syncExtensions(fn) {
  syncingExtensions = true;
  try {
    fn();
  } finally {
    syncingExtensions = false;
  }
}

// Instância da biblioteca de extensões da sessão (espaço) de uma página.
const extensionsOf = (wc) => (wc && !wc.isDestroyed() ? ElectronChromeExtensions.fromSession(wc.session) : undefined);
const spaceOfSession = (ses) => spaces.listSpaces().find((sp) => spaces.sessionOf(sp.id) === ses)?.id ?? spaces.DEFAULT_SPACE_ID;
const extensionsDir = () => path.join(app.getPath('userData'), 'Extensions');

async function setupExtensions(ses) {
  const spaceId = () => spaceOfSession(ses);
  new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: async (details) => {
      if (!win) throw new Error('Janela ainda não está pronta');
      const tab = createTab(details.url || HOME_URL, { background: details.active === false, space: spaceId() });
      return [tab.view.webContents, win];
    },
    selectTab: (wc) => {
      if (syncingExtensions) return;
      const tab = tabFromContents(wc);
      if (tab) activateTab(tab.id);
    },
    removeTab: (wc) => {
      const tab = tabFromContents(wc);
      if (tab) closeTab(tab.id);
    },
    createWindow: async (details) => {
      if (!win) throw new Error('Janela ainda não está pronta');
      for (const url of [details.url ?? HOME_URL].flat()) createTab(url, { space: spaceId() });
      return win;
    },
  });
  // Ícones das extensões (crx://) na barra lateral e no painel (que ficam na sessão principal).
  if (ses === session.defaultSession) ElectronChromeExtensions.handleCRXProtocol(ses);

  try {
    await installChromeWebStore({
      session: ses,
      extensionsPath: extensionsDir(), // todas as sessões usam a mesma pasta de extensões
      loadExtensions: false, // cada espaço carrega só as extensões liberadas para ele
      autoUpdate: ses === session.defaultSession,
      // Pergunta antes de instalar, mostrando o nome da extensão.
      beforeInstall: async ({ localizedName, manifest }) => {
        const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Adicionar extensão', 'Cancelar'],
          defaultId: 0,
          cancelId: 1,
          title: 'Adicionar extensão',
          message: `Adicionar "${localizedName}" ao Wolf Browser?`,
          detail: `${perms.length ? `Ela poderá acessar: ${perms.slice(0, 8).join(', ')}${perms.length > 8 ? '…' : ''}\n\n` : ''}Vale para todos os espaços (dá para mudar em Configurações → Espaços).`,
        });
        return { action: response === 0 ? 'allow' : 'deny' };
      },
    });
  } catch (err) {
    console.error('Chrome Web Store indisponível:', err.message);
  }

  const changed = () => {
    sendToPages('wolf://panel', 'extensions-changed', null);
    scheduleExtensionSync(); // extensão nova instalada num espaço → leva para os outros liberados
  };
  ses.extensions.on('extension-loaded', changed);
  ses.extensions.on('extension-unloaded', () => sendToPages('wolf://panel', 'extensions-changed', null));
  await syncSpaceExtensions(spaceId());
}

// Extensões instaladas (pasta compartilhada): { id, path, manifest } com a versão mais nova de cada.
function installedExtensions() {
  const out = [];
  let ids = [];
  try {
    ids = fs.readdirSync(extensionsDir());
  } catch {
    return out;
  }
  const newer = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  };
  for (const id of ids) {
    let best = null;
    let versions = [];
    try {
      versions = fs.readdirSync(path.join(extensionsDir(), id));
    } catch {
      continue;
    }
    for (const version of versions) {
      const dir = path.join(extensionsDir(), id, version);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        if (!best || newer(manifest.version, best.manifest.version)) best = { id, path: dir, manifest };
      } catch {
        // pasta incompleta
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// Em quais espaços a extensão vale: 'all' (padrão) ou lista de ids de espaços.
const extensionScope = (id) => settings.data.extensionScopes[id] ?? 'all';
const extensionAllowed = (id, spaceId) => {
  const scope = extensionScope(id);
  return scope === 'all' || (Array.isArray(scope) && scope.includes(spaceId));
};

// Carrega/descarrega as extensões de um espaço conforme a escolha de cada uma.
async function syncSpaceExtensions(spaceId) {
  const ses = spaces.sessionOf(spaceId);
  for (const ext of installedExtensions()) {
    const loaded = ses.extensions.getExtension(ext.id);
    const allowed = extensionAllowed(ext.id, spaceId);
    try {
      if (allowed && !loaded) {
        const extension = await ses.extensions.loadExtension(ext.path);
        if (extension?.manifest.manifest_version === 3 && extension.manifest.background?.service_worker) {
          await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`).catch(() => {});
        }
      } else if (!allowed && loaded) {
        ses.extensions.removeExtension(ext.id);
      }
    } catch (err) {
      logError(`Extensão ${ext.id}`, err);
    }
  }
}

let extensionSyncTimer = null;
function scheduleExtensionSync() {
  clearTimeout(extensionSyncTimer);
  extensionSyncTimer = setTimeout(() => {
    for (const space of spaces.listSpaces()) if (readySessions.has(spaces.sessionOf(space.id))) syncSpaceExtensions(space.id);
  }, 600);
}

function extensionList() {
  return installedExtensions().map(({ id, manifest }) => {
    // Nome traduzido: pega de um espaço onde a extensão está carregada.
    const loadedIn = spaces.listSpaces().filter((sp) => spaces.sessionOf(sp.id).extensions.getExtension(id));
    const loaded = loadedIn.length ? spaces.sessionOf(loadedIn[0].id).extensions.getExtension(id) : null;
    const options = manifest.options_ui?.page || manifest.options_page || null;
    const description = typeof manifest.description === 'string' && !manifest.description.startsWith('__MSG_') ? manifest.description : '';
    const name = loaded?.name || (String(manifest.name).startsWith('__MSG_') ? id : manifest.name);
    return { id, name, version: manifest.version, description, options, scope: extensionScope(id), spaces: loadedIn.map((sp) => sp.id) };
  });
}

handleInternal('extensions:list', extensionList);
handleInternal('extensions:store', () => {
  closePanel();
  createTab('https://chromewebstore.google.com/');
});
handleInternal('extensions:options', (_e, id) => {
  const ext = extensionList().find((x) => x.id === id);
  if (!ext?.options) return;
  closePanel();
  // Abre no espaço atual se a extensão vale nele; senão no primeiro espaço onde ela vale.
  const space = ext.spaces.includes(activeSpaceId) ? activeSpaceId : ext.spaces[0];
  if (!space) return;
  const tab = createTab(`chrome-extension://${id}/${ext.options}`, { space, background: true });
  activateTab(tab.id);
});
handleInternal('extensions:remove', async (_e, id) => {
  if (!installedExtensions().some((x) => x.id === id)) return;
  for (const space of spaces.listSpaces()) {
    const ses = spaces.sessionOf(space.id);
    if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
  }
  await uninstallExtension(id, { session: session.defaultSession, extensionsPath: extensionsDir() }).catch(() => {});
  await fs.promises.rm(path.join(extensionsDir(), id), { recursive: true, force: true }).catch(() => {});
  delete settings.data.extensionScopes[id];
  settings.save();
});
// Em quais espaços a extensão vale: 'all' ou [ids].
handleInternal('extensions:scope', async (_e, id, scope) => {
  const valid = scope === 'all' || (Array.isArray(scope) && scope.every((sp) => spaces.getSpace(sp)));
  if (!valid) return extensionList();
  settings.data.extensionScopes[id] = scope === 'all' ? 'all' : [...new Set(scope)];
  settings.save();
  for (const space of spaces.listSpaces()) await syncSpaceExtensions(space.id);
  sendState();
  return extensionList();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Tema automático: acompanha as cores do Wolf OS (mudam com o papel de parede).
  watchSystemTheme(() => {
    if (settings.data.theme === 'system') applyTheme();
    sendToPages('wolf://settings', 'system-theme', systemThemeInfo());
  });
  const ses = session.defaultSession;
  readySessions.add(ses);
  applyDnsOverHttps();
  await setupSession(ses); // sessão do espaço Pessoal
  startBlockEngines(); // listas de bloqueio carregam em segundo plano
  // Sessões dos outros espaços (abas deles podem ser restauradas).
  for (const space of spaces.listSpaces()) spaceSession(space.id);
  createWindow();
  for (const url of urlArgs(process.argv)) createTab(url);
});

app.on('second-instance', (_event, argv) => {
  if (!win) return;
  const urls = urlArgs(argv);
  for (const url of urls) createTab(url);
  if (!urls.length) openNewTab();
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('will-quit', flushAll);
app.on('window-all-closed', () => app.quit());
