/**
 * Risolutore di moduli per gli script una tantum che riusano il codice di `src/`.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Gli script in `scripts/` girano su Node puro, senza Next e senza bundler.
 * I moduli di `src/` sono scritti per il bundler e danno per scontate due cose
 * che Node da solo non sa fare:
 *
 *   1. `import { x } from './tabelle'` — senza estensione. Node ESM pretende
 *      `./tabelle.ts`, e senza il salto l'import fallisce con ERR_MODULE_NOT_FOUND.
 *   2. `import { y } from '@/lib/anagrafiche/province'` — l'alias di `tsconfig`.
 *      Node non legge `tsconfig.json` e non sa che `@/` vuol dire `src/`.
 *
 * Node 24 i TIPI li toglie da solo; questi due punti no. Questo file li copre,
 * e null'altro: non trasforma, non compila, non rilegge nulla dal disco che non
 * sia già lì.
 *
 * ⚠️ Va importato PRIMA di qualunque modulo di `src/`, e i moduli di `src/` vanno
 * poi caricati con `await import(...)` dinamico — gli `import` statici vengono
 * risolti tutti prima che una riga di codice giri, quindi un hook registrato in
 * cima al file arriverebbe comunque troppo tardi.
 */
import { registerHooks } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

/** La radice del repo: due livelli sopra `scripts/lib/`. */
const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = resolvePath(RADICE, 'src')

/** Le estensioni provate, nell'ordine in cui il bundler le prova. */
const ESTENSIONI = ['.ts', '.tsx', '.mts', '.js', '.mjs']

/**
 * Dato un percorso senza estensione, il file che esiste davvero.
 * Prova prima il file, poi `index.*` dentro la cartella. `null` se non c'è nulla:
 * il chiamante lascia allora fare a Node, che darà il suo errore di sempre.
 */
function completa(percorso) {
    if (existsSync(percorso) && statSync(percorso).isFile()) return percorso
    for (const e of ESTENSIONI) {
        const p = percorso + e
        if (existsSync(p)) return p
    }
    for (const e of ESTENSIONI) {
        const p = resolvePath(percorso, 'index' + e)
        if (existsSync(p)) return p
    }
    return null
}

registerHooks({
    resolve(specifier, context, next) {
        // 1 · L'alias `@/…` → `src/…`
        if (specifier.startsWith('@/')) {
            const completo = completa(resolvePath(SRC, specifier.slice(2)))
            if (completo) return { url: pathToFileURL(completo).href, shortCircuit: true }
        }

        // 2 · Il relativo senza estensione, ma SOLO quando parte da un file
        //     nostro: un `./qualcosa` dentro node_modules lo risolve npm come sa.
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const genitore = context.parentURL
            if (genitore?.startsWith('file:') && !genitore.includes('/node_modules/')) {
                const completo = completa(resolvePath(dirname(fileURLToPath(genitore)), specifier))
                if (completo) return { url: pathToFileURL(completo).href, shortCircuit: true }
            }
        }

        // 3 · Il sottopercorso di un pacchetto SENZA mappa `exports`.
        //
        // Misurato il 2026-09-01: `next` 16.3.0 non ha il campo `exports` nel suo
        // package.json. Perciò `import 'next/server'` — che `src/lib/logging/app-log.ts`
        // fa, e che quindi si tira dietro QUALUNQUE modulo del prodotto che logga —
        // cade nella risoluzione legacy, dove Node ESM pretende l'estensione:
        //   Cannot find module '…/node_modules/next/server'
        //   Did you mean to import "next/server.js"?
        // Non è un problema del pacchetto né dell'alias: è la stessa lacuna dei
        // punti 1 e 2, su un terzo fronte. Si prova prima la via normale — così
        // un pacchetto CON `exports` continua a decidere da sé — e solo se Node
        // dichiara di non aver trovato il modulo si completa l'estensione.
        if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('@/')) {
            try {
                return next(specifier, context)
            } catch (errore) {
                if (errore?.code !== 'ERR_MODULE_NOT_FOUND') throw errore
                const completo = completa(resolvePath(RADICE, 'node_modules', specifier))
                if (completo) return { url: pathToFileURL(completo).href, shortCircuit: true }
                throw errore
            }
        }

        return next(specifier, context)
    },
})
