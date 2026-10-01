const { contextBridge, ipcRenderer } = require('electron');

// Roda em todas as abas, mas só as páginas internas (wolf://) recebem acesso.
if (location.protocol === 'wolf:') {
  contextBridge.exposeInMainWorld('wolf', {
    invoke: (channel, ...args) => ipcRenderer.invoke(`wolf:${channel}`, ...args),
    on: (channel, cb) => ipcRenderer.on(`wolf:${channel}`, (_e, data) => cb(data)),
  });
  // Tema trocado: recarrega o theme.css (as cores mudam sem recarregar a página).
  ipcRenderer.on('wolf:theme', () => {
    for (const link of document.querySelectorAll('link[href^="theme.css"]')) link.href = `theme.css?${Date.now()}`;
  });
}

// Shift + clique (ou Alt + clique, nas configurações) num link abre a prévia flutuante.
let config = { previewModifier: 'shift', fingerprint: null, blockPopups: false };
try {
  config = ipcRenderer.sendSync('wolf:page-config', location.href);
} catch {
  // mantém o padrão
}
const previewModifier = config.previewModifier;

// Teclas da prévia (ex.: 'shift', 'alt', 'ctrl+alt'): precisam ser exatamente essas.
const previewKeys = new Set(previewModifier === 'off' ? [] : String(previewModifier).split('+'));
function previewLink(event) {
  if (!previewKeys.size || event.button !== 0 || event.metaKey) return null;
  const wanted = event.ctrlKey === previewKeys.has('ctrl')
    && event.altKey === previewKeys.has('alt')
    && event.shiftKey === previewKeys.has('shift');
  if (!wanted) return null;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  return link && /^https?:/i.test(link.href) ? link : null;
}
// Evita que o Shift + clique selecione texto.
document.addEventListener('mousedown', (event) => {
  if (previewLink(event)) event.preventDefault();
}, true);
document.addEventListener('click', (event) => {
  const link = previewLink(event);
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send('link-preview', link.href);
}, true);

// Dentro da prévia flutuante: duplo clique abre como aba normal.
if (config.isPreview) {
  document.addEventListener('dblclick', () => ipcRenderer.send('preview:dblclick'), true);
}

// ---------- Mini player: avisa o navegador sobre o que está tocando ----------
if (location.protocol === 'http:' || location.protocol === 'https:') {
  let mediaTimer = null;
  let lastSent = '';
  const report = () => {
    clearTimeout(mediaTimer);
    mediaTimer = setTimeout(() => {
      const all = [...document.querySelectorAll('video, audio')].filter((m) => m.currentSrc || m.src || m.srcObject);
      // Principal: o que está tocando, senão o maior vídeo.
      const m = all.find((e) => !e.paused) || all.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
      // Sem mídia, ou só um vídeo mudo de fundo que nunca tocou som: nada a mostrar.
      const info = !m || (m.paused && m.currentTime === 0) ? null : (() => {
        const meta = navigator.mediaSession?.metadata;
        return {
          playing: !m.paused,
          title: meta?.title || document.title,
          artist: meta?.artist || '',
          artwork: meta?.artwork?.at(-1)?.src || '',
          hasVideo: m.tagName === 'VIDEO' && m.videoWidth > 0,
          muted: m.muted,
          pip: document.pictureInPictureElement === m,
        };
      })();
      const key = JSON.stringify(info);
      if (key === lastSent) return;
      lastSent = key;
      ipcRenderer.send('media-state', info);
    }, 150);
  };
  for (const name of ['play', 'pause', 'ended', 'volumechange', 'loadedmetadata', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture']) {
    document.addEventListener(name, report, true);
  }
  // Título muda (ex.: próxima música no YouTube Music)
  window.addEventListener('DOMContentLoaded', () => {
    const title = document.querySelector('title');
    if (title) new MutationObserver(report).observe(title, { childList: true });
  });
}

// ---------- Proteções que rodam dentro da página (antes do código do site) ----------

// Anti-fingerprinting: pequenas variações no canvas, no áudio e nos dados da placa de vídeo.
// O "ruído" é igual no mesmo site durante a sessão (o site funciona normal),
// mas muda entre sites e a cada vez que o navegador abre (não dá para te reconhecer).
function antiFingerprint(seed) {
  let state = seed || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const noise = (data) => {
    for (let i = 0; i < data.length; i += 4) {
      if (random() < 0.08) data[i] ^= 1; // muda 1 bit de alguns pixels (invisível)
    }
  };

  const getImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const image = getImageData.apply(this, args);
    noise(image.data);
    return image;
  };
  const withNoise = (canvas) => {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx || !canvas.width || !canvas.height) return;
      const image = getImageData.call(ctx, 0, 0, canvas.width, canvas.height);
      noise(image.data);
      ctx.putImageData(image, 0, 0);
    } catch {
      // canvas de outro site ou WebGL: segue sem ruído
    }
  };
  for (const name of ['toDataURL', 'toBlob']) {
    const original = HTMLCanvasElement.prototype[name];
    HTMLCanvasElement.prototype[name] = function (...args) {
      withNoise(this);
      return original.apply(this, args);
    };
  }

  // Placa de vídeo: nome genérico em vez do modelo real.
  for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    const getParameter = Ctx.prototype.getParameter;
    Ctx.prototype.getParameter = function (param) {
      if (param === 37445) return 'Google Inc.'; // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Generic GPU)'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };
  }

  // Áudio: variação mínima nas amostras analisadas.
  if (self.AudioBuffer) {
    const getChannelData = AudioBuffer.prototype.getChannelData;
    const touched = new WeakSet();
    AudioBuffer.prototype.getChannelData = function (...args) {
      const data = getChannelData.apply(this, args);
      if (!touched.has(data)) {
        touched.add(data);
        for (let i = 0; i < data.length; i += 97) data[i] += (random() - 0.5) * 1e-7;
      }
      return data;
    };
  }

  // Hardware: valores comuns em vez dos reais.
  const fixed = { hardwareConcurrency: 4, deviceMemory: 8 };
  for (const [name, value] of Object.entries(fixed)) {
    try {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    } catch {
      // propriedade não existe neste contexto
    }
  }
}

// Bloqueio de pop-ups: janelas abertas sem clique do usuário não abrem.
function blockPopups(report) {
  const open = window.open;
  window.open = function (url, target, features) {
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      report(url === undefined ? '' : String(url));
      return null;
    }
    return open.call(window, url, target, features);
  };
}

// ---------- YouTube: anúncios do player ----------
// Tirar os anúncios dos dados do vídeo faz o player do YouTube travar no 0:00 (ele detecta).
// Então o anúncio começa normalmente e é pulado na hora: mudo, adiantado até o fim e "Pular".
function youtubeAdBlock() {
  // Aviso "bloqueadores de anúncios violam os termos" (anti-adblock): esse pode ser removido.
  const pruneWarning = (data) => {
    const messages = data?.auxiliaryUi?.messageRenderers;
    if (messages?.enforcementMessageViewModel) delete messages.enforcementMessageViewModel;
    if (data?.playerResponse) pruneWarning(data.playerResponse);
    return data;
  };
  const parse = JSON.parse;
  JSON.parse = function (...args) {
    const data = parse.apply(this, args);
    return data && typeof data === 'object' && ('auxiliaryUi' in data || 'playerResponse' in data) ? pruneWarning(data) : data;
  };

  let wasAd = false;
  let savedVolume = null;
  const skip = () => {
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video');
    const isAd = Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'));
    if (isAd && video) {
      if (!wasAd) savedVolume = video.muted;
      video.muted = true;
      video.playbackRate = 16;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
        video.currentTime = video.duration - 0.1;
      }
      for (const button of document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button')) button.click();
    } else if (wasAd && video) {
      // Anúncio acabou: devolve o som e a velocidade normais ao vídeo.
      video.playbackRate = 1;
      if (savedVolume === false) video.muted = false;
    }
    wasAd = isAd;
  };
  setInterval(skip, 200);
}

// Anúncios da página (banners, feed, patrocinados): só esconder.
const YOUTUBE_AD_CSS = `
ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer,
ytd-statement-banner-renderer, ytd-merch-shelf-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
#player-ads, #masthead-ad, .ytd-player-legacy-desktop-watch-ads-renderer, ytm-promoted-sparkles-web-renderer,
ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
.ytp-ad-overlay-container, .ytp-ad-image-overlay, ytd-enforcement-message-view-model,
tp-yt-paper-dialog:has(ytd-enforcement-message-view-model) { display: none !important; }
`;

if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    if (config.youtubeAds) {
      contextBridge.executeInMainWorld({ func: youtubeAdBlock, args: [] });
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = YOUTUBE_AD_CSS;
        document.documentElement.append(style);
      });
    }
    if (config.fingerprint !== null) {
      contextBridge.executeInMainWorld({ func: antiFingerprint, args: [config.fingerprint] });
    }
    if (config.blockPopups) {
      contextBridge.executeInMainWorld({
        func: blockPopups,
        args: [(url) => ipcRenderer.send('popup-blocked', url)],
      });
    }
  } catch {
    // executeInMainWorld indisponível: segue sem essas proteções
  }
}
