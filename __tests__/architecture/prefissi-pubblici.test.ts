import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Lock — ogni prefisso PUBBLICO deve proteggere qualcosa che esiste.
 *
 * `PUBLIC_PREFIXES` (`src/lib/auth/middleware-rules.ts`) è l'elenco dei percorsi
 * che il middleware lascia passare SENZA sessione. È la superficie anonima
 * dell'applicazione, e cresce di una riga alla volta: ogni riga è aggiunta da
 * chi sta costruendo la cosa che quella riga deve rendere raggiungibile.
 *
 * ── PERCHÉ ESISTE QUESTO FILE ───────────────────────────────────────────────
 *
 * Perché una riga può sopravvivere alla cosa che giustificava. Misurato il
 * 2026-08-10: DUE prefissi su tredici non corrispondono a nessuna pagina.
 *
 *   `/lavora-con-noi`  aggiunto insieme alla ROUTE del modulo di candidatura,
 *                      in anticipo sulla PAGINA, che al 2026-08-10 non esiste
 *                      (`src/app/lavora-con-noi` non è nell'albero: la corsia
 *                      che la scrive è un'altra). Oggi quel percorso risponde
 *                      404 — a chiunque, e senza login.
 *   `/forms`           più vecchio: in `src/app` esiste solo `api/forms`, già
 *                      coperto dalla voce `/api/forms`. Le pagine dei moduli
 *                      stanno sotto `(dashboard)/admin/forms` e
 *                      `(dashboard)/parent/forms`, che sono percorsi PROTETTI e
 *                      non cominciano per `/forms`.
 *
 * Nessuno dei due è pericoloso oggi: un prefisso pubblico su un 404 non apre
 * niente. Il punto è che nessuno se n'era accorto, e nessuno se ne sarebbe
 * accorto — a differenza degli handler API, sorvegliati da `gate-coverage`,
 * questo elenco non aveva un solo test addosso (`grep -rn PUBLIC_PREFIXES
 * __tests__` non trovava nulla).
 *
 * ── COSA GARANTISCE, E COSA NO ──────────────────────────────────────────────
 *
 * Garantisce che un prefisso pubblico NUOVO senza pagina diventi rosso subito.
 * NON fa cadere i due noti: sono dichiarati qui sotto per nome, con la data
 * della misura e il motivo. Un'eccezione scritta non è un'assoluzione — è la
 * differenza fra un difetto che sta in un elenco e uno che non sta da nessuna
 * parte. Se una delle due voci resterà qui quando la sua pagina esisterà, sarà
 * perché qualcuno l'avrà riletta: è più di quanto valesse prima.
 */

const RADICE = process.cwd()

/** Le voci di `PUBLIC_PREFIXES`, lette dal SORGENTE come fanno gli altri lock. */
function prefissiPubblici(): string[] {
  const sorgente = fs.readFileSync(path.join(RADICE, 'src/lib/auth/middleware-rules.ts'), 'utf8')
  const blocco = /const PUBLIC_PREFIXES = \[([\s\S]*?)\n\]/.exec(sorgente)?.[1]
  if (!blocco) throw new Error('PUBLIC_PREFIXES non trovato: il lock non sta leggendo niente')
  // Solo le stringhe fuori dai commenti: le voci sono spiegate da righe `//`
  // che contengono a loro volta dei percorsi fra apici.
  return blocco
    .split('\n')
    .map((r) => r.replace(/\/\/.*$/, ''))
    .flatMap((r) => [...r.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

/**
 * I prefissi che oggi NON hanno una pagina, con la ragione e la data.
 *
 * Aggiungere una voce qui è una decisione da scrivere, non da prendere di
 * sfuggita: significa lasciare aperto senza sessione un percorso che non serve
 * ancora a niente.
 */
const SENZA_PAGINA_DICHIARATI: Record<string, string> = {
  '/lavora-con-noi':
    'la PAGINA del modulo di candidatura non esiste ancora (misurato 2026-08-10); ' +
    'la route API sta sotto /api/iscrizione ed è già pubblica per quella voce',
  '/forms':
    'in src/app esiste solo api/forms, già coperto da /api/forms; le pagine dei ' +
    'moduli sono sotto (dashboard) e sono protette (misurato 2026-08-10)',
}

/** True se esiste una pagina servita a quel percorso, gruppi di route compresi. */
function esistePagina(prefisso: string): boolean {
  const rel = prefisso.replace(/^\//, '')
  const candidate = [path.join(RADICE, 'src/app', rel)]
  const app = path.join(RADICE, 'src/app')
  for (const voce of fs.readdirSync(app, { withFileTypes: true })) {
    // Un gruppo di route — `(dashboard)` — non compare nell'URL.
    if (voce.isDirectory() && voce.name.startsWith('(')) {
      candidate.push(path.join(app, voce.name, rel))
    }
  }
  return candidate.some((c) => fs.existsSync(c) && contienePagina(c))
}

/** True se sotto la cartella c'è almeno una `page.tsx` (anche in segmenti dinamici). */
function contienePagina(dir: string): boolean {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    if (voce.isFile() && voce.name === 'page.tsx') return true
    if (voce.isDirectory() && contienePagina(path.join(dir, voce.name))) return true
  }
  return false
}

describe('lock — i prefissi pubblici e ciò che proteggono', () => {
  it('l’elenco si legge davvero (se cade, il lock non sta provando niente)', () => {
    const p = prefissiPubblici()
    expect(p.length).toBeGreaterThan(5)
    expect(p).toContain('/auth')
    expect(p).toContain('/api/iscrizione')
  })

  it('ogni prefisso di PAGINA corrisponde a una pagina esistente', () => {
    for (const p of prefissiPubblici()) {
      // Gli handler API non sono pagine: il loro presidio è il gate applicativo,
      // sorvegliato da `gate-coverage`.
      if (p.startsWith('/api/')) continue
      // Un file statico servito da `public/`: sta nell'elenco perché il matcher
      // del middleware non esclude `.html`.
      if (p.endsWith('.html')) {
        expect(fs.existsSync(path.join(RADICE, 'public', p.replace(/^\//, ''))), `${p} non esiste in public/`).toBe(
          true,
        )
        continue
      }
      if (p in SENZA_PAGINA_DICHIARATI) continue
      expect(
        esistePagina(p),
        `«${p}» è pubblico ma non c'è nessuna pagina che risponda: o nasce la pagina, ` +
          'o la voce si toglie, o si dichiara in SENZA_PAGINA_DICHIARATI con la ragione',
      ).toBe(true)
    }
  })

  it('le eccezioni dichiarate sono ANCORA nell’elenco (nessuna voce morta qui dentro)', () => {
    // Il verso opposto: se un prefisso viene tolto da `PUBLIC_PREFIXES` e la sua
    // deroga resta qui, questo file comincia a raccontare un elenco che non
    // esiste più — e la prossima persona la legge come vera.
    const attuali = prefissiPubblici()
    for (const p of Object.keys(SENZA_PAGINA_DICHIARATI)) {
      expect(attuali, `«${p}» è dichiarato qui ma non è più un prefisso pubblico`).toContain(p)
    }
  })

  it('la pagina di «Lavora con noi», quando nascerà, resta pubblica', () => {
    // L'invariante che conta davvero, e che vale in entrambi gli stati del
    // mondo: il modulo di candidatura è ANONIMO per costruzione — chi si propone
    // come insegnante non ha un account, e l'account nasce solo se la Direzione
    // approva. Se quella pagina finisse dietro il login non la vedrebbe nessuno,
    // e il difetto sarebbe invisibile da server: la si vede solo aprendola da
    // disconnessi. Questa riga impedisce che la voce sparisca dall'elenco
    // mentre la pagina viene scritta in un'altra corsia.
    expect(prefissiPubblici()).toContain('/lavora-con-noi')
  })
})
