#!/bin/sh
# Abre o Wolf Browser instalado pelo pacote.
unset ELECTRON_RUN_AS_NODE
exec /usr/lib/wolf-browser/electron "$@"
