# Wolf Browser

Navegador do [Wolf OS](https://github.com/TioDanoni/wolfos), feito com Electron (Chromium).

- Abas verticais, com árvore de abas ou agrupamento por site
- Espaços (Pessoal, Trabalho…) com abas, logins, histórico e favoritos separados
- Abas fixadas, tela dividida, prévia de links e painel de IA ao lado da página
- Bloqueio de anúncios e rastreadores, proteção contra fingerprinting, DNS seguro
- Extensões do Chrome
- Tradução de páginas, mini-player de mídia, abas que dormem para economizar memória
- Tema automático que acompanha o papel de parede do Wolf OS
- Barra lateral personalizável (ordem, itens e modelos)

## Instalar no Wolf OS / Arch

Adicione o repositório em `/etc/pacman.conf`:

```ini
[wolf-browser]
SigLevel = Optional TrustAll
Server = https://github.com/TioDanoni/wolf-browser/releases/download/repo
```

Depois:

```sh
sudo pacman -Sy wolf-browser
```

As versões novas chegam junto com as atualizações do sistema (`sudo pacman -Syu`).

## Desenvolver

```sh
npm install
npm start
```

Para testar sem mexer no seu perfil: `WOLF_PROFILE=/tmp/perfil npm start`.

## Lançar uma versão

```sh
npm run publicar            # 0.19.0 -> 0.19.1
npm run publicar -- minor   # 0.19.0 -> 0.20.0
```

O comando guarda as mudanças no git, cria a tag e envia para o GitHub. O GitHub monta o
pacote e atualiza o repositório pacman sozinho (`.github/workflows/pacote.yml`).

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
