// Atalhos de teclado configuráveis. Cada ação tem uma combinação padrão; o usuário
// pode trocar ou desativar (string vazia) nas configurações.

const SHORTCUT_ACTIONS = [
  // Abas
  { id: 'newTab', group: 'Abas', label: 'Nova aba', keys: 'Ctrl+T' },
  { id: 'closeTab', group: 'Abas', label: 'Fechar aba', keys: 'Ctrl+W' },
  { id: 'reopenTab', group: 'Abas', label: 'Reabrir aba fechada', keys: 'Ctrl+Shift+T' },
  { id: 'nextTab', group: 'Abas', label: 'Próxima aba', keys: 'Ctrl+Tab' },
  { id: 'prevTab', group: 'Abas', label: 'Aba anterior', keys: 'Ctrl+Shift+Tab' },
  { id: 'sleepOthers', group: 'Abas', label: 'Pôr as outras abas para dormir', keys: '' },
  // Navegação
  { id: 'focusAddress', group: 'Navegação', label: 'Ir para a barra de endereço', keys: 'Ctrl+L' },
  { id: 'back', group: 'Navegação', label: 'Voltar', keys: 'Alt+Left' },
  { id: 'forward', group: 'Navegação', label: 'Avançar', keys: 'Alt+Right' },
  { id: 'reload', group: 'Navegação', label: 'Recarregar', keys: 'Ctrl+R' },
  { id: 'hardReload', group: 'Navegação', label: 'Recarregar sem cache', keys: 'Ctrl+Shift+R' },
  { id: 'home', group: 'Navegação', label: 'Página inicial', keys: 'Alt+Home' },
  // Página
  { id: 'find', group: 'Página', label: 'Procurar na página', keys: 'Ctrl+F' },
  { id: 'zoomIn', group: 'Página', label: 'Aumentar zoom', keys: 'Ctrl+=' },
  { id: 'zoomOut', group: 'Página', label: 'Diminuir zoom', keys: 'Ctrl+-' },
  { id: 'zoomReset', group: 'Página', label: 'Zoom normal', keys: 'Ctrl+0' },
  { id: 'translate', group: 'Página', label: 'Traduzir página / mostrar original', keys: 'Alt+T' },
  { id: 'bookmark', group: 'Página', label: 'Adicionar ou remover dos favoritos', keys: 'Ctrl+D' },
  { id: 'print', group: 'Página', label: 'Imprimir', keys: 'Ctrl+P' },
  { id: 'savePage', group: 'Página', label: 'Salvar página', keys: 'Ctrl+S' },
  { id: 'viewSource', group: 'Página', label: 'Ver código-fonte', keys: 'Ctrl+U' },
  { id: 'fullscreen', group: 'Página', label: 'Tela cheia', keys: 'F11' },
  { id: 'devtools', group: 'Página', label: 'Ferramentas de desenvolvedor', keys: 'F12' },
  // Navegador
  { id: 'toggleSidebar', group: 'Navegador', label: 'Expandir / recolher a barra lateral', keys: 'Ctrl+B' },
  { id: 'history', group: 'Navegador', label: 'Histórico', keys: 'Ctrl+H' },
  { id: 'downloads', group: 'Navegador', label: 'Downloads', keys: 'Ctrl+J' },
  { id: 'bookmarks', group: 'Navegador', label: 'Favoritos', keys: 'Ctrl+Shift+O' },
  { id: 'extensions', group: 'Navegador', label: 'Extensões', keys: 'Ctrl+Shift+E' },
  { id: 'settings', group: 'Navegador', label: 'Configurações', keys: 'Ctrl+,' },
  { id: 'toggleAi', group: 'Navegador', label: 'Painel de IA', keys: 'Ctrl+Shift+A' },
  { id: 'splitNew', group: 'Abas', label: 'Dividir tela com nova aba / desfazer divisão', keys: 'Ctrl+Shift+S' },
  // Espaços (Ctrl+Alt+1…9 vai direto para o espaço)
  { id: 'nextSpace', group: 'Espaços', label: 'Próximo espaço', keys: 'Ctrl+Alt+Right' },
  { id: 'prevSpace', group: 'Espaços', label: 'Espaço anterior', keys: 'Ctrl+Alt+Left' },
];

const KEY_NAMES = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ' ': 'Space',
  Escape: 'Esc',
};

// Transforma um evento de teclado ({ key, control, alt, shift, meta }) em "Ctrl+Shift+T".
// Retorna null se só um modificador foi pressionado.
function comboFrom({ key, control, alt, shift, meta }) {
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead'].includes(key)) return null;
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const parts = [];
  if (control) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  // Shift só conta para teclas que não mudam de símbolo com ele (letras, F1, setas...).
  if (shift && (key.length !== 1 || /[a-z]/i.test(key))) parts.push('Shift');
  if (meta) parts.push('Super');
  parts.push(name);
  return parts.join('+');
}

module.exports = { SHORTCUT_ACTIONS, comboFrom };
