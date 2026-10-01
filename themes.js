const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Temas do Wolf Browser. Cada tema define as cores base; o resto (hover, bordas,
// versões suaves do destaque) é derivado no CSS com color-mix().

const THEMES = {
  wolf: {
    name: 'Wolf OS',
    frame: '#0d0f13',
    surface: '#16181d',
    surface2: '#1d2027',
    text: '#e4e6ea',
    dim: '#8a909c',
    accent: '#f5a432',
  },
  midnight: {
    name: 'Meia-noite',
    frame: '#0a0e1a',
    surface: '#111827',
    surface2: '#18223a',
    text: '#e5ebff',
    dim: '#8a96b8',
    accent: '#6ea8ff',
  },
  forest: {
    name: 'Floresta',
    frame: '#0b110d',
    surface: '#121a15',
    surface2: '#19241d',
    text: '#e2ece5',
    dim: '#86a08e',
    accent: '#5fd08a',
  },
  amethyst: {
    name: 'Ametista',
    frame: '#100c16',
    surface: '#18121f',
    surface2: '#211929',
    text: '#eee6f5',
    dim: '#9f8fb0',
    accent: '#c084fc',
  },
  nord: {
    name: 'Nord',
    frame: '#1f232b',
    surface: '#2e3440',
    surface2: '#3b4252',
    text: '#eceff4',
    dim: '#a3abbd',
    accent: '#88c0d0',
  },
  ember: {
    name: 'Brasa',
    frame: '#140c0b',
    surface: '#1d1311',
    surface2: '#281a17',
    text: '#f3e7e4',
    dim: '#a8908a',
    accent: '#fb6351',
  },
};

// ---------- Tema automático: cores do sistema (Wolf OS / Noctalia) ----------
// O Noctalia gera um tema GTK a partir do papel de parede a cada troca.
// Lemos as cores desse arquivo e acompanhamos as mudanças.

// WOLF_SYSTEM_CSS permite apontar para outro arquivo (testes).
const SYSTEM_CSS = process.env.WOLF_SYSTEM_CSS || path.join(os.homedir(), '.config', 'gtk-3.0', 'noctalia.css');
let systemPalette = null;

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
// Mistura duas cores: t = 0 → a, t = 1 → b.
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));

function readSystemPalette() {
  let css;
  try {
    css = fs.readFileSync(SYSTEM_CSS, 'utf8');
  } catch {
    return null;
  }
  const color = (name) => css.match(new RegExp(`@define-color ${name} (#[0-9a-fA-F]{6});`))?.[1];
  const bg = color('window_bg_color');
  const fg = color('window_fg_color');
  const card = color('card_bg_color') || color('headerbar_bg_color');
  const accent = color('accent_color') || color('accent_bg_color');
  if (!bg || !fg || !accent) return null;
  return {
    name: 'Automático',
    frame: mix(bg, '#000000', 0.35), // moldura um pouco mais escura que o fundo
    surface: bg,
    surface2: card ? mix(bg, card, 0.5) : mix(bg, fg, 0.06),
    text: fg,
    dim: mix(fg, bg, 0.42),
    accent,
  };
}

// Acompanha o arquivo do sistema e chama onChange quando as cores mudam.
function watchSystemTheme(onChange) {
  systemPalette = readSystemPalette();
  const dir = path.dirname(SYSTEM_CSS);
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = readSystemPalette();
      if (JSON.stringify(next) === JSON.stringify(systemPalette)) return;
      systemPalette = next;
      onChange();
    }, 300);
  };
  try {
    // Vigia a pasta: o arquivo costuma ser substituído (não só editado).
    fs.watch(dir, (_event, file) => {
      if (!file || file === path.basename(SYSTEM_CSS)) check();
    });
  } catch {
    // pasta não existe (fora do Wolf OS): o tema automático usa o Wolf OS padrão
  }
}

const systemThemeInfo = () => systemPalette;

// Tema escolhido + cor de destaque personalizada (se houver).
function resolveTheme(themeId, accent) {
  if (themeId === 'system') {
    const base = systemPalette || THEMES.wolf;
    return { id: 'system', ...base, name: 'Automático', accent: accent || base.accent };
  }
  const base = THEMES[themeId] || THEMES.wolf;
  return { id: THEMES[themeId] ? themeId : 'wolf', ...base, accent: accent || base.accent };
}

// Variáveis CSS usadas pela barra lateral (style.css) e pelas páginas internas (pages.css).
function themeCss(theme) {
  return `:root {
  --frame: ${theme.frame};
  --raised: ${theme.surface};
  --raised-2: ${theme.surface2};
  --bg: ${theme.surface};
  --surface: ${theme.surface2};
  --text: ${theme.text};
  --text-dim: ${theme.dim};
  --accent: ${theme.accent};
}
`;
}

module.exports = { THEMES, resolveTheme, themeCss, watchSystemTheme, systemThemeInfo };
