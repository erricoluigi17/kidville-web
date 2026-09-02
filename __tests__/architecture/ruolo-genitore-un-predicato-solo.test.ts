import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * «SEI UN GENITORE?» NON SI CHIEDE PIÙ A MANO, IN NESSUNA ROUTE E IN NESSUNA
 * LIBRERIA.
 *
 * ─── LA DISTINZIONE CHE QUESTO LOCK CUSTODISCE ─────────────────────────────────
 *
 *   AUTORIZZAZIONE = i ruoli REALI, letti dal database  → `haRuolo` / `eFamiglia`
 *   PRESENTAZIONE  = il ruolo ATTIVO, scelto col cookie → `agisceComeGenitore`
 *
 * Il confronto scritto a mano sul campo `role` NON dice quale delle due si sta
 * facendo: sembra un controllo di permessi e invece legge una preferenza di
 * visualizzazione. Finché in produzione ogni persona aveva un ruolo solo i due
 * significati coincidevano e nessuno pagava la confusione. Non è più così: quattro
 * insegnanti hanno insieme `utenti.ruolo = 'educator'` e il ponte
 * `parents.auth_user_id`, e su di loro le due domande danno risposte DIVERSE.
 *
 * ─── PERCHÉ UN `sed` GLOBALE QUI FA DANNI, E NON È UN'IPOTESI ──────────────────
 *
 * Le ventotto occorrenze convertite il 2026-09-01 NON erano tutte la stessa cosa:
 *
 *  · `teacher/uscite:67` NEGA a chi guarda da genitore. Il semaforo delle gite è
 *    una FUNZIONE DI LAVORO: convertirlo in `eFamiglia` avrebbe tolto a una
 *    docente-genitore il proprio mestiere. → presentazione.
 *  · `gallery:190` esclude il genitore dall'intersezione con `resolveScuoleAttive`,
 *    perché la sua sede sono i FIGLI. Con `eFamiglia` una docente-genitore che apre
 *    la galleria del figlio iscritto in UN'ALTRA SEDE avrebbe ricevuto `200` con
 *    `media: []` — un permesso concesso dal gate e poi svuotato dallo scope, cioè
 *    il difetto più difficile da vedere che esista. → presentazione.
 *  · `parent/forms/otp:110` e `parent/submissions:53` NON erano conversioni: erano
 *    `if (role === 'genitore' && !haIlLegame) → 403`, cioè per chiunque NON fosse
 *    genitore il controllo non esisteva affatto. Sono diventate
 *    `requireParentOfStudent`. → autorizzazione, e per giunta mancante.
 *
 * Tre righe con la stessa forma e tre risposte diverse: è la ragione per cui la
 * conversione è stata fatta riga per riga, ed è la ragione per cui questo lock
 * impedisce che la forma torni.
 *
 * ─── LA PROVA DI SANITÀ, ESEGUITA E NON PROMESSA ───────────────────────────────
 *
 * Un lock mai visto fallire non è un lock. Prove fatte a mano il 2026-09-01, esito
 * OSSERVATO e non previsto:
 *
 *  1. rimesso `if (user.role === 'genitore') {` in `src/app/api/teacher/uscite/route.ts`
 *     → ROSSO, con l'elenco esatto:
 *     `["src/app/api/teacher/uscite/route.ts:67 → user.role === 'genitore'"]`.
 *  2. rimesso `if (auth.user.role !== 'genitore')` in `src/app/api/gallery/route.ts`
 *     → ROSSO, stessa forma, riga 190.
 *  3. la stessa riga scritta dentro un COMMENTO (`// era: user.role === 'genitore'`)
 *     → resta VERDE, ed è voluto: la prosa deve poter nominare il gesto che vieta,
 *     altrimenti questo file accuserebbe la propria testata (è già successo al lock
 *     gemello `predicati-ruolo-non-mockabili`, che al primo giro accusò sé stesso).
 *  4. svuotato l'inventario (`RADICI` puntate su una cartella inesistente) → ROSSO
 *     sulla prova di sanità dell'inventario, non verde su tutto il resto.
 */

/**
 * Il gesto vietato: un confronto DIRETTO fra un `role` e la stringa `'genitore'`.
 * Copre `user.role === 'genitore'`, `auth.user.role !== 'genitore'`,
 * `segnalante.role === 'genitore'` — e anche la forma SENZA punto,
 * `role === 'genitore'` su una variabile locale, che `chat/contacts:180` e
 * `consensi.ts:61` usavano e che un pattern ancorato al punto avrebbe amnistiato.
 * Sono trenta righe in tutto, contate in `src/` il 2026-09-01.
 *
 * NON copre `ruolo === 'genitore'` (la COLONNA del database, non il campo
 * dell'utente applicativo): `profili.ts` e `/api/me` la leggono per COSTRUIRE i
 * ruoli reali, e lì il confronto è la definizione, non una scorciatoia.
 */
const CONFRONTO_A_MANO = /\brole\s*[!=]==\s*['"]genitore['"]/

/** Dove si applica: le route e le librerie. La UI ha regole sue. */
const RADICI = [join('src', 'app', 'api'), join('src', 'lib')]

/**
 * Gli unici file che hanno titolo a nominare il campo `role` accanto a
 * `'genitore'`. Oggi soltanto `predicati-ruolo.ts` lo fa davvero — è LA
 * definizione di `agisceComeGenitore` — e l'asserzione qui sotto lo verifica, così
 * un'esenzione che smette di servire non resta a coprire il vuoto. Gli altri tre
 * sono i moduli che costruiscono e commutano l'identità: se un domani uno di loro
 * dovesse scriverlo, lo farebbe con cognizione di causa.
 */
const ESENTI = [
  join('src', 'lib', 'auth', 'predicati-ruolo.ts'),
  join('src', 'lib', 'auth', 'require-staff.ts'),
  join('src', 'lib', 'auth', 'profili.ts'),
  join('src', 'lib', 'auth', 'active-role.ts'),
]

const ESTENSIONI = ['.ts', '.tsx']

function fileSotto(dir: string): string[] {
  let out: string[] = []
  for (const voce of readdirSync(dir)) {
    if (voce === 'node_modules' || voce.startsWith('.')) continue
    const p = join(dir, voce)
    if (statSync(p).isDirectory()) out = out.concat(fileSotto(p))
    else if (ESTENSIONI.some((e) => voce.endsWith(e))) out.push(p)
  }
  return out
}

/**
 * Le sole righe di CODICE, numerate. La prosa deve poter raccontare il difetto —
 * e in questo repo la racconta per esteso, perché è così che si evita di rifarlo.
 */
function righeDiCodice(percorso: string): { n: number; testo: string }[] {
  return readFileSync(percorso, 'utf8')
    .split('\n')
    .map((testo, i) => ({ n: i + 1, testo }))
    .filter(({ testo }) => !/^\s*(\*|\/\/|\/\*)/.test(testo))
}

describe('il ruolo genitore si chiede a un predicato, non a un confronto scritto a mano', () => {
  const sorgenti = RADICI.flatMap((r) => fileSotto(r))

  it('trova i file da controllare (prova di sanità dell’inventario)', () => {
    // Senza questa asserzione un `readdirSync` a vuoto renderebbe VERDE tutto il
    // resto: il lock guarderebbe il nulla e direbbe che va tutto bene.
    expect(sorgenti.length).toBeGreaterThan(300)
    expect(sorgenti).toContain(join('src', 'app', 'api', 'gallery', 'route.ts'))
    expect(sorgenti).toContain(join('src', 'app', 'api', 'teacher', 'uscite', 'route.ts'))
    expect(sorgenti).toContain(join('src', 'lib', 'onboarding', 'consensi.ts'))
  })

  it('nessun confronto diretto `role === "genitore"` sotto `src/app/api/**` e `src/lib/**`', () => {
    const colpevoli: string[] = []
    for (const f of sorgenti) {
      if (ESENTI.includes(f)) continue
      for (const { n, testo } of righeDiCodice(f)) {
        if (CONFRONTO_A_MANO.test(testo)) colpevoli.push(`${f}:${n} → ${testo.trim()}`)
      }
    }
    expect(
      colpevoli,
      'usa `agisceComeGenitore` (presentazione) o `eFamiglia`/`haRuolo` (autorizzazione) da @/lib/auth/predicati-ruolo',
    ).toEqual([])
  })

  it('l’esenzione di `predicati-ruolo.ts` serve davvero: è lì che il confronto vive', () => {
    // Un'esenzione che non copre più niente è un'esenzione che nasconde il vuoto.
    // Qui si verifica il rovescio: il confronto ESISTE, una volta sola, nel file
    // che ha titolo a farlo — la definizione stessa di `agisceComeGenitore`.
    const definizione = righeDiCodice(join('src', 'lib', 'auth', 'predicati-ruolo.ts')).filter(
      ({ testo }) => CONFRONTO_A_MANO.test(testo),
    )
    expect(definizione.length).toBe(1)
  })
})
