import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK — un `getByPlaceholder()` degli spec Playwright deve corrispondere a un
 * placeholder che nel prodotto esiste davvero.
 *
 * ─── IL DIFETTO CHE QUESTO TEST RENDE IMPOSSIBILE ──────────────────────────
 * CI del 2026-08-02, run 30765844979: quattro spec E2E rossi su sei, tutti con
 * lo stesso errore — `locator.fill: Test timeout … waiting for
 * getByPlaceholder('Cerca per nome, cognome o codice fiscale...')`.
 *
 * L'applicazione era SANA. Il commit `362cd3b` (ondata 3A/3B, rilievo di
 * localizzazione) aveva sostituito nei cataloghi i tre punti ASCII `...` con
 * l'ellissi tipografica `…` — la forma corretta, in 40 stringhe. Ma
 * `getByPlaceholder('…')` senza `exact` fa un match per SOTTOSTRINGA, e la
 * sottostringa `...` non esiste dentro `…`: quattro selettori sono diventati
 * ciechi nello stesso istante, in tre file di test che nessuno aveva toccato.
 *
 * ─── PERCHÉ UN LOCK, E NON «basta ricordarsene» ────────────────────────────
 * La stessa stringa d'interfaccia viveva in due posti — il catalogo i18n e il
 * selettore dello spec — senza niente che li tenesse allineati. L'unica cosa
 * che se ne accorgeva era la suite E2E, che gira in CI, dura 30 minuti, non è
 * eseguibile in locale (`.env.local` punta al database di PRODUZIONE) e blocca
 * un merge. Il costo di scoprirlo era massimo e il momento il peggiore.
 *
 * Questo lock gira dentro `npx vitest run`, in due secondi, sulla macchina di
 * chi ha appena rinominato l'etichetta. È il gemello di R5 del lock dei flow
 * Maestro (`maestro-flows-selettori.test.ts`), che fa la stessa cosa per i
 * selettori di Maestro: la regola era già scritta per una delle due suite, e
 * mancava all'altra.
 *
 * ─── COSA CONTROLLA, ESATTAMENTE ───────────────────────────────────────────
 * Per ogni stringa LETTERALE passata a `getByPlaceholder()` negli spec di
 * `e2e/`, ne cerca almeno un candidato fra:
 *  · i valori dei cataloghi `messages/it/**.json` (i placeholder tradotti);
 *  · i letterali `placeholder="…"` / `placeholder: '…'` di `src/` — i moduli
 *    dinamici (`src/lib/forms/*.ts`) definiscono i propri placeholder lì, non
 *    nei cataloghi.
 * Il confronto replica la semantica di Playwright: **sottostringa,
 * case-insensitive**, esattamente come `getByPlaceholder(stringa)` senza
 * `{ exact: true }`. Un selettore che non ha nessun candidato è un selettore
 * cieco: in CI diventerà un timeout di 30 secondi, qui è una riga rossa.
 *
 * ─── COSA NON PUÒ FARE ─────────────────────────────────────────────────────
 * Non sa se il campo è VISIBILE nel momento in cui lo spec lo cerca, né se la
 * pagina giusta è stata caricata: quello lo dice solo l'E2E. E non copre i
 * selettori costruiti a runtime (`getByPlaceholder(variabile)`) né le regex —
 * che però sono già al riparo da questa classe di guasto, perché
 * `/Scrivi un messaggio/` continua a matchare anche dopo un cambio di
 * punteggiatura in coda.
 */

const RADICE = process.cwd()

/** Ricorsione su una cartella, saltando ciò che non è codice del repo. */
function fileDi(dir: string, filtro: (f: string) => boolean): string[] {
  const out: string[] = []
  const visita = (d: string): void => {
    for (const voce of readdirSync(d)) {
      if (voce === 'node_modules' || voce === '.next' || voce === '.auth') continue
      const p = join(d, voce)
      if (statSync(p).isDirectory()) visita(p)
      else if (filtro(p)) out.push(p)
    }
  }
  visita(dir)
  return out
}

/** Tutti i valori stringa di un catalogo, a qualunque profondità. */
function valoriStringa(nodo: unknown, out: string[] = []): string[] {
  if (typeof nodo === 'string') {
    out.push(nodo)
  } else if (nodo !== null && typeof nodo === 'object') {
    for (const v of Object.values(nodo as Record<string, unknown>)) valoriStringa(v, out)
  }
  return out
}

/** I placeholder che il prodotto può davvero mostrare. */
function placeholderDelProdotto(): string[] {
  const candidati: string[] = []

  for (const f of fileDi(join(RADICE, 'messages', 'it'), (p) => p.endsWith('.json'))) {
    candidati.push(...valoriStringa(JSON.parse(readFileSync(f, 'utf8'))))
  }

  // `placeholder="…"`, `placeholder={'…'}` (JSX) e `placeholder: '…'` (i campi
  // dei moduli dinamici, che non passano dai cataloghi).
  const LETTERALE = /placeholder\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"`]([^'"`]*)['"`]\s*\})/g
  for (const f of fileDi(join(RADICE, 'src'), (p) => /\.(tsx?|jsx?)$/.test(p))) {
    for (const m of readFileSync(f, 'utf8').matchAll(LETTERALE)) {
      candidati.push(m[1] ?? m[2] ?? m[3] ?? '')
    }
  }

  return candidati.filter((s) => s.length > 0)
}

interface Selettore {
  file: string
  riga: number
  testo: string
}

/**
 * I `getByPlaceholder('…')` / `getByPlaceholder("…")` degli spec. Le forme con
 * regex o con variabile non sono raccolte: vedi «cosa non può fare».
 */
function selettoriDegliSpec(): Selettore[] {
  const LETTERALE = /getByPlaceholder\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  const out: Selettore[] = []
  for (const f of fileDi(join(RADICE, 'e2e'), (p) => p.endsWith('.ts'))) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((linea, i) => {
        for (const m of linea.matchAll(LETTERALE)) {
          const grezzo = m[1] ?? m[2] ?? ''
          // `\'` dentro una stringa a doppi apici resta un apostrofo.
          out.push({ file: relative(RADICE, f), riga: i + 1, testo: grezzo.replace(/\\(['"\\])/g, '$1') })
        }
      })
  }
  return out
}

describe('lock: i selettori placeholder degli spec E2E esistono nel prodotto', () => {
  it('raccoglie sia i selettori sia i placeholder (il lock non è vuoto per costruzione)', () => {
    // Un lock che non trova niente da controllare è verde per il motivo
    // sbagliato: è il modo in cui un test smette di proteggere senza dirlo.
    expect(selettoriDegliSpec().length).toBeGreaterThan(10)
    expect(placeholderDelProdotto().length).toBeGreaterThan(100)
  })

  it('ogni getByPlaceholder() ha un placeholder corrispondente (sottostringa, case-insensitive)', () => {
    const candidati = placeholderDelProdotto().map((s) => s.toLowerCase())
    const orfani = selettoriDegliSpec()
      .filter(({ testo }) => {
        const ago = testo.toLowerCase()
        return !candidati.some((c) => c.includes(ago))
      })
      .map(({ file, riga, testo }) => `${file}:${riga} → «${testo}»`)

    expect(
      orfani,
      'Selettori E2E che nessun placeholder del prodotto può soddisfare: in CI diventano ' +
        'un timeout di 30s. Di solito è una stringa rinominata nei cataloghi (attenzione ai ' +
        'tre punti «...» diventati ellissi «…»): allinea il selettore al testo nuovo — non ' +
        'il contrario, se il testo nuovo è migliore.',
    ).toEqual([])
  })
})
