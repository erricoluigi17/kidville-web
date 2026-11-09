import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileSorgente, mascheraSorgente } from '../fixtures/sorgente'

/**
 * COMPITO 4.7.5 · NESSUNA ROUTE DELL'ANNO RESTA SENZA CHI LA CHIAMA.
 *
 * La storia: `GET /api/admin/anni/[annoSedeId]/moduli-mancanti` è nata nella 4.5 con la sua pagina da scrivere «dopo» e per due PR non
 * l'ha chiamata nessuno. Aveva il gate, la validazione, il logging e il test di route: tutti i lock verdi, un endpoint
 * morto. Nessun lock guardava l'altra metà del contratto: che qualcuno, dal lato dell'interfaccia, la usi.
 *
 * Questo lock guarda quella metà. Per ogni `route.ts` sotto `src/app/api/admin/anni/` e `src/app/api/admin/frequenze/` cerca, nei
 * sorgenti dell'interfaccia (`src/app/(dashboard)`, `src/components`, `src/lib`, SENZA i commenti), l'indirizzo della route scritto come
 * lo scrive un chiamante: `/api/admin/anni/${…}/<percorso>` oppure `${base}/<percorso>` in un file che definisce l'indirizzo base
 * (`const base = \`/api/admin/anni/${…}\``, o `url`) e poi scrive `${base}/<percorso>`. Il percorso dev'essere seguito da una chiusura di stringa (`` ` ``, `'`, `"`, `?`): così
 * `conferme` non si accontenta di `conferme/quota`.
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quante route ha visto (15, esatte: una route nuova nella cartella cambia il numero e si ferma qui, a decidere se ha un
 * chiamante) e quante chiamate ha riconosciuto; ha il controllo positivo su sorgenti finti (un chiamante vero si vede, una
 * citazione in un commento no, un percorso più lungo non conta per uno più corto) e la PROVA ROSSA su una route finta che nessuno chiama.
 *
 * ─── CHE COSA NON VEDE ────────────────────────────────────────────────────────
 *  - che la chiamata sia raggiungibile dall'interfaccia (un componente scritto e mai montato è un chiamante che questo lock vede);
 *  - un indirizzo costruito a pezzi (`'/api/admin/anni/' + id + '/cruscotto'`): le pagine di questo gruppo usano template string.
 * Una route che davvero non ha un chiamante (un'API per un'integrazione esterna) si scrive in `SENZA_CHIAMANTE_AMMESSO` CON la ragione.
 */

const RADICE = process.cwd()
const API = path.join(RADICE, 'src/app/api')
const CARTELLE_ROUTE = ['admin/anni', 'admin/frequenze'] as const
const CARTELLE_CHIAMANTI = ['src/app/(dashboard)', 'src/components', 'src/lib'] as const

/** Le route che per scelta non hanno un chiamante in questa interfaccia. Parte VUOTA: ogni voce vuole la sua ragione. */
const SENZA_CHIAMANTE_AMMESSO: Record<string, string> = {}

/** Quante route ci sono oggi in quelle due cartelle (misurato il 2026-11-09, ramo PR 4.7, dopo l'allineamento alla 4.6: la route `rette` è una in più). */
const ROUTE_ATTESE = 15

const CHIUSURA = '[`\'"?]'
const escapa = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Sorgente { file: string; testo: string }

/** `admin/anni/[annoSedeId]/conferme/ritira/route.ts` → base `admin/anni`, percorso `conferme/ritira` (vuoto per la route radice). */
export function indirizzoDi(fileRoute: string): { base: string; percorso: string } {
  const rel = fileRoute.split('src/app/api/')[1].replace(/\/route\.ts$/, '')
  const m = /^(admin\/(?:anni|frequenze))\/\[[A-Za-z]+\](?:\/(.+))?$/.exec(rel)
  if (!m) throw new Error(`Route fuori schema: ${fileRoute}`)
  return { base: m[1], percorso: m[2] ?? '' }
}

/** Vero se, fra i sorgenti (già senza commenti), c'è un chiamante dell'indirizzo. */
export function haUnChiamante(fileRoute: string, sorgenti: readonly Sorgente[]): boolean {
  const { base, percorso } = indirizzoDi(fileRoute)
  const radice = `/api/${escapa(base)}/\\$\\{[^}]+\\}`
  const diretta = new RegExp(percorso ? `${radice}/${escapa(percorso)}${CHIUSURA}` : `${radice}${CHIUSURA}`)
  // la base può chiamarsi `base` (`${base}/x`), `c.base` o `url` (`${url}/x`): conta che il file la definisca come questo indirizzo
  const defBase = new RegExp(`= \`${radice}\``)
  const viaBase = percorso ? new RegExp(`\\$\\{[A-Za-z_.]+\\}/${escapa(percorso)}${CHIUSURA}`) : null
  return sorgenti.some((s) => diretta.test(s.testo) || (viaBase !== null && defBase.test(s.testo) && viaBase.test(s.testo)))
}

function routeDellAnno(): string[] {
  return CARTELLE_ROUTE.flatMap((c) => fileSorgente(path.join(API, c))).filter((f) => f.endsWith(`${path.sep}route.ts`)).sort()
}

function sorgentiChiamanti(): Sorgente[] {
  return CARTELLE_CHIAMANTI.flatMap((c) => fileSorgente(path.join(RADICE, c))).map((file) => ({
    file,
    testo: mascheraSorgente(fs.readFileSync(file, 'utf8')).senzaCommenti,
  }))
}

describe('lock architettura · ogni route dell’anno ha un chiamante', () => {
  const route = routeDellAnno()
  const sorgenti = sorgentiChiamanti()

  it('ha visto le route e i sorgenti (la copertura è dichiarata, non supposta)', () => {
    expect(route.length, 'route sotto admin/anni e admin/frequenze: una nuova va decisa qui').toBe(ROUTE_ATTESE)
    expect(sorgenti.length, 'sorgenti dell’interfaccia letti').toBeGreaterThan(300)
  })

  it('NESSUNA route senza un chiamante (o senza una ragione scritta)', () => {
    const orfane = route
      .map((f) => path.relative(RADICE, f))
      .filter((f) => !haUnChiamante(f, sorgenti) && !(f in SENZA_CHIAMANTE_AMMESSO))
    expect(
      orfane,
      'Queste route non sono chiamate da nessun file di src/app/(dashboard), src/components o src/lib. Un endpoint senza chiamante è codice morto con tutti i lock verdi: ' +
        'o scrivi la pagina che lo usa, o lo togli, o lo metti in SENZA_CHIAMANTE_AMMESSO con la ragione.',
    ).toEqual([])
  })

  it('ogni voce di SENZA_CHIAMANTE_AMMESSO è una route che esiste e ha una ragione scritta', () => {
    for (const [file, ragione] of Object.entries(SENZA_CHIAMANTE_AMMESSO)) {
      expect(route.map((f) => path.relative(RADICE, f)), file).toContain(file)
      expect(ragione.trim().length, file).toBeGreaterThan(20)
    }
  })

  it('dichiara quanti chiamanti ha riconosciuto: tutte le route, nessuna per ragione scritta', () => {
    const riconosciute = route.filter((f) => haUnChiamante(path.relative(RADICE, f), sorgenti)).length
    expect(riconosciute + Object.keys(SENZA_CHIAMANTE_AMMESSO).length).toBe(ROUTE_ATTESE)
  })
})

describe('CONTROLLO POSITIVO e PROVA ROSSA — il riconoscitore vede un chiamante vero e una route finta orfana', () => {
  const F = (percorso: string) => `/x/src/app/api/admin/anni/[annoSedeId]/${percorso}/route.ts`.replace('//route', '/route')
  const sorg = (testo: string): Sorgente[] => [{ file: 'a.tsx', testo: mascheraSorgente(testo).senzaCommenti }]

  it('un chiamante diretto si vede; uno via `base` si vede solo se la base è quella giusta', () => {
    expect(haUnChiamante(F('cruscotto'), sorg('fetch(`/api/admin/anni/${id}/cruscotto`)'))).toBe(true)
    expect(haUnChiamante(F('cruscotto'), sorg('const base = `/api/admin/anni/${id}`; leggi(`${base}/cruscotto`)'))).toBe(true)
    expect(haUnChiamante(F('cruscotto'), sorg('const base = `/api/altro/${id}`; leggi(`${base}/cruscotto`)'))).toBe(false)
  })

  it('una citazione in un commento non è un chiamante', () => {
    expect(haUnChiamante(F('cruscotto'), sorg('// GET /api/admin/anni/${id}/cruscotto\n/* `/api/admin/anni/${id}/cruscotto` */'))).toBe(false)
  })

  it('il percorso più lungo non conta per il più corto, e viceversa', () => {
    const solo = sorg('post(`/api/admin/anni/${id}/conferme/quota`)')
    expect(haUnChiamante(F('conferme'), solo)).toBe(false)
    expect(haUnChiamante(F('conferme/quota'), solo)).toBe(true)
    expect(haUnChiamante(F('conferme'), sorg('leggi(`${base}/conferme?pagina=1`)'))).toBe(false) // senza la definizione della base
  })

  it('la route radice (`anni/[annoSedeId]`) ha il suo chiamante solo se l’indirizzo si chiude subito dopo l’id', () => {
    const radice = '/x/src/app/api/admin/anni/[annoSedeId]/route.ts'
    expect(haUnChiamante(radice, sorg('const url = `/api/admin/anni/${riga.annoSedeId}`'))).toBe(true)
    expect(haUnChiamante(radice, sorg('const url = `/api/admin/anni/${id}/cruscotto`'))).toBe(false)
  })

  it('le route di frequenze hanno la loro base', () => {
    const f = '/x/src/app/api/admin/frequenze/[frequenzaId]/moduli/route.ts'
    expect(haUnChiamante(f, sorg('const url = `/api/admin/frequenze/${frequenzaId}/moduli`'))).toBe(true)
    expect(haUnChiamante(f, sorg('const url = `/api/admin/anni/${id}/moduli`'))).toBe(false)
  })

  it('PROVA ROSSA: una route finta che nessuno chiama risulta orfana', () => {
    const vere = sorgentiChiamanti()
    expect(haUnChiamante(F('route-finta-che-nessuno-chiama'), vere)).toBe(false)
    // e una vera, la prima volta che nasce, lo è finché non esiste il suo chiamante
    expect(haUnChiamante(F('cruscotto'), [])).toBe(false)
  })

  it('un file di route fuori schema lancia invece di passare in silenzio', () => {
    expect(() => indirizzoDi('/x/src/app/api/admin/altro/[id]/route.ts')).toThrow()
  })
})
