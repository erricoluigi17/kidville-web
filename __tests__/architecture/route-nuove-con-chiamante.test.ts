import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · una route nuova nasce CON il suo chiamante.
 *
 * Una route che nessuna schermata chiama è codice che passa tutti i test e non serve a nessuno: la segreteria non può usarla e
 * nessuno se ne accorge, perché non c'è niente che fallisca. Questo lock tiene un ELENCO DICHIARATO (route → il file che la
 * chiama): chi aggiunge una route lo aggiunge qui, con la schermata che la usa; chi toglie la schermata, o rinomina la route,
 * vede il lock rosso.
 *
 * Non è un'analisi del grafo delle chiamate: legge che il file indicato nomini il percorso della route, e dichiara quanti ne ha
 * guardati (un lock su zero righe sarebbe verde per sempre). Si estende una riga alla volta, con la PR che la introduce.
 */

const ROOT = process.cwd()

type Voce = {
  /** Il percorso sotto `src/app/api`, con le parentesi quadre dei segmenti dinamici. */
  route: string
  /** Chi la chiama, sotto `src/`. */
  chiamante: string
  /** Il pezzo di URL che il chiamante scrive per raggiungerla. */
  url: string
}

const ELENCO: readonly Voce[] = [
  // PR 4.6 · la retta mensile dell'anno e i mesi in cui si genera: la scheda «Rette» dell'anno che si prepara.
  { route: 'admin/anni/[annoSedeId]/rette', chiamante: 'components/features/admin/settings/AnnoConfigurazione.tsx', url: '/rette' },
]

describe('ogni route dell’elenco esiste ed è chiamata dalla sua schermata', () => {
  it('l’elenco non è vuoto: un lock su zero voci sarebbe verde per sempre', () => {
    expect(ELENCO.length).toBeGreaterThan(0)
  })

  for (const v of ELENCO) {
    it(`${v.route} ← ${v.chiamante}`, () => {
      const file = join(ROOT, 'src/app/api', v.route, 'route.ts')
      expect(existsSync(file), `la route ${v.route} non esiste più`).toBe(true)
      const chiamante = join(ROOT, 'src', v.chiamante)
      expect(existsSync(chiamante), `il chiamante ${v.chiamante} non esiste più`).toBe(true)
      const testo = readFileSync(chiamante, 'utf8')
      // l'URL va scritto per esteso nel chiamante, tra apici o backtick: un nome citato in un commento non è una chiamata
      const chiamata = new RegExp('[`\'"][^`\'"\\n]*' + v.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[`\'"]')
      expect(chiamata.test(testo), `${v.chiamante} non chiama ${v.url}`).toBe(true)
    })
  }
})
