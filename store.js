const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const stores = [];

// Guarda um objeto em ~/.config/Wolf Browser/<nome>.json.
// save() grava com atraso (várias mudanças seguidas viram uma escrita só).
class JsonStore {
  constructor(name, defaults, { delay = 500 } = {}) {
    this.delay = delay;
    this.writing = Promise.resolve();
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    try {
      this.data = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = structuredClone(defaults);
    }
    this.timer = null;
    stores.push(this);
  }

  // Grava depois de `delay` ms sem mudanças, em segundo plano (não trava a interface).
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.writeAsync()).catch((err) => console.error(err));
    }, this.delay);
  }

  async writeAsync() {
    if (this.closed || this.deleted) return;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.data));
    // Se o navegador fechou no meio, a gravação final (flush) já tem a versão mais nova.
    if (this.closed) return;
    await fs.promises.rename(tmp, this.file);
  }

  // Gravação imediata, usada ao fechar o navegador.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.deleted) return; // arquivo apagado de propósito (ex.: espaço removido)
    this.closed = true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.final.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

function flushAll() {
  // Grava tudo de forma síncrona ao sair, garantindo a versão mais nova no disco.
  for (const store of stores) store.flush();
}

module.exports = { JsonStore, flushAll };
