import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { Page } from '@playwright/test'

/** Il modulo di produzione viene eseguito sul vero IndexedDB del browser. */
export async function installaArchivioVideo(page: Page): Promise<void> {
  await page.addScriptTag({ content: readFileSync(resolve('node_modules/dexie/dist/dexie.js'), 'utf8') })
  const moduli = Object.fromEntries(['byte-video', 'lettore-blob', 'archivio-dexie'].map(nome => [nome,
    ts.transpileModule(readFileSync(resolve(`src/lib/media/video/upload/${nome}.ts`), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
  ]))
  await page.addScriptTag({ content: `(() => {
    const sorgenti = ${JSON.stringify(moduli)};
    const cache = {};
    const log = [];
    function carica(nome) {
      if (nome === 'dexie') return window.Dexie;
      if (nome === '@/lib/logging/client') return {
        logClient: e => log.push(e),
        nomeErrore: e => (e && typeof e.name === 'string' ? e.name : 'errore'),
      };
      const id = nome.replace('./', '');
      if (cache[id]) return cache[id];
      if (!sorgenti[id]) throw Error('Modulo inatteso: ' + id);
      const exports = {}; cache[id] = exports;
      new Function('require', 'exports', sorgenti[id])(carica, exports);
      return exports;
    }
    window.videoArchivioQA = { ...carica('archivio-dexie'), ...carica('lettore-blob'), ...carica('byte-video'), log };
  })()` })
}
