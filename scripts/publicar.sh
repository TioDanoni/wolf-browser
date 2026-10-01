#!/usr/bin/env bash
# Lança uma versão: guarda tudo no git, cria a tag e envia para o GitHub, que
# monta o pacote e atualiza o repositório pacman.
#   npm run publicar            sobe o último número (0.19.0 -> 0.19.1)
#   npm run publicar -- minor   sobe o do meio      (0.19.0 -> 0.20.0)
#   npm run publicar -- major   sobe o primeiro     (0.19.0 -> 1.0.0)
# Se a versão do package.json ainda não foi lançada, ela é usada como está.
set -euo pipefail
cd "$(dirname "$0")/.."

versao() { node -p "require('./package.json').version"; }
if git rev-parse -q --verify "refs/tags/v$(versao)" >/dev/null; then
    if git diff --quiet HEAD -- . && [[ -z "$(git status --porcelain)" ]]; then
        echo "Nada mudou desde a versão $(versao)."; exit 0
    fi
    npm version "${1:-patch}" --no-git-tag-version >/dev/null
fi
V="$(versao)"

git add -A
git diff --cached --quiet || git commit -q -m "Wolf Browser $V"
git tag "v$V"
git push -q origin HEAD "v$V"
echo "Versão $V enviada. O GitHub monta o pacote em alguns minutos:"
echo "  https://github.com/TioDanoni/wolf-browser/actions"
