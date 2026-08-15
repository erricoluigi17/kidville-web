/**
 * Hook di risoluzione per Node: fa capire a uno script i moduli TypeScript di `src/`.
 *
 * PERCHÉ ESISTE. Nessuno script di questo repo aveva mai importato codice da
 * `src/`: gli script parlano col database o con un provider, il prodotto vive in
 * `src/`, e i due mondi non si toccavano. L'anteprima delle email è il primo
 * caso in cui serve il contrario — deve rendere le email VERE, quelle che
 * partono davvero, non una copia del template che invecchia al primo ritocco.
 *
 * Node sa già togliere i tipi da solo (`--experimental-strip-types` su Node 22,
 * nativo dalla 23.6). Quello che non sa fare sono due cose che TypeScript dà per
 * scontate, e che non sono regole del linguaggio ma del suo risolutore:
 *
 *   1. l'alias `@/…`, che è una riga di `tsconfig.json`;
 *   2. gli import SENZA estensione (`from '../html'`), che l'ESM di Node
 *      rifiuta e che invece sono la convenzione di tutto questo repo.
 *
 * Sono venti righe, e sono preferibili all'alternativa: mettere estensioni e
 * percorsi lunghi dentro `src/` per fare un favore a uno script.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')

/** Le code che TypeScript prova quando un import non porta l'estensione. */
const CODE = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/** Il primo percorso che esiste davvero, o `null`. */
function primoCheEsiste(base) {
    if (existsSync(base)) return base
    for (const coda of CODE) if (existsSync(base + coda)) return base + coda
    return null
}

export async function resolve(specifier, context, next) {
    // 1 · l'alias `@/…`
    if (specifier.startsWith('@/')) {
        const trovato = primoCheEsiste(join(SRC, specifier.slice(2)))
        if (trovato) return next(pathToFileURL(trovato).href, context)
    }

    // 2 · un import relativo senza estensione, partendo da chi lo scrive
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const base = join(dirname(fileURLToPath(context.parentURL)), specifier)
        const trovato = primoCheEsiste(base)
        if (trovato) return next(pathToFileURL(trovato).href, context)
    }

    return next(specifier, context)
}
