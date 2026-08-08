import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { motivoVisibileA } from '@/lib/presenze/motivo-visibile'
import type { AppUser } from '@/lib/auth/require-staff'

/**
 * LOCK — LA FRASE CHE IL GENITORE LEGGE E L'INSIEME DI CHI LEGGE DAVVERO.
 *
 * ─── IL FATTO (rilievo Q1, quarto collaudo) ─────────────────────────────────
 *
 * Sotto il campo «Motivo», nel momento esatto in cui il dato viene raccolto, il modulo del
 * genitore dichiara: «Il motivo lo leggono le insegnanti della sezione e viene cancellato dopo
 * dodici mesi». È l'informativa dell'art. 13 su un dato dell'art. 9 (salute) di un minore.
 *
 * Misurato: con la sessione di un `coordinator` NON assegnato alla sezione,
 *   GET /api/attendance/daily?sezione=…&data=…  → 200, `giustificazione_testo` per intero.
 * Controprova che il gate funziona: lo stesso identico invito con un `educator` non assegnato
 * → 403 «Classe non assegnata al docente». Quindi non era il gate a essere rotto: era la
 * FRASE a dichiarare una platea più stretta di quella reale — `requireDocente` ammette
 * `educator, admin, coordinator, segreteria`, e la restrizione alla sezione vale solo per chi
 * NON passa da `vedeTutteLeClassi`.
 *
 * ─── LA STRADA SCELTA, FRA LE DUE POSSIBILI ─────────────────────────────────
 *
 * Si è ristretto l'ACCESSO, non allargata la frase. Il motivo è la minimizzazione (art. 5 §1
 * lett. c): il motivo dell'assenza serve a chi accoglie il bambino la mattina dopo, e nessuna
 * mansione di segreteria ha bisogno del sintomo di un minore di una sezione non sua. La
 * schermata resta la stessa per tutti; cambia solo che quella colonna non viaggia.
 *
 * ─── E LA STESSA FORMA NELL'ALTRA ROTTA ─────────────────────────────────────
 *
 * Cercata: `primaria/appello:GET` fa esattamente lo stesso — `requireDocente` +
 * `assertSezioneInScope`, che restringe alla sezione solo chi non vede tutte le classi — e
 * restituisce `giustificazione_testo` nella riga dell'alunno. Il rilievo nominava una rotta
 * sola; la regola vale per entrambe, e vive in `src/lib/presenze/motivo-visibile.ts`.
 *
 * ─── PERCHÉ UN LOCK ─────────────────────────────────────────────────────────
 *
 * Perché la frase e il gate vivono in due file che nessuno confronta, ed è già successo: il
 * microtesto era stato scritto guardando alla schermata («l'appello della maestra») invece che
 * al gate della rotta. Alla prossima modifica del gate tornerebbero a divergere in silenzio.
 */

const RADICE = process.cwd()
const catalogo = JSON.parse(readFileSync(join(RADICE, 'messages/it/parentAssenze.json'), 'utf8'))
const FRASE: string = catalogo.motivoPrivacy ?? ''

/** Le rotte del PERSONALE che restituiscono il motivo dell'assenza in una schermata. */
const ROTTE_STAFF = [
  'src/app/api/attendance/daily/route.ts',
  'src/app/api/primaria/appello/route.ts',
]

const utente = (role: string): AppUser => ({ id: 'u1', role } as AppUser)

describe('lock · il motivo dell’assenza lo legge chi la frase dice che lo legge', () => {
  it('la frase esiste e nomina le insegnanti della sezione (sanity)', () => {
    // Se la chiave sparisce o viene riscritta, tutte le prove qui sotto girerebbero sul vuoto.
    expect(FRASE, '`motivoPrivacy` non si trova più in messages/it/parentAssenze.json').not.toBe('')
    expect(/insegnanti della sezione/i.test(FRASE)).toBe(true)
  })

  it('la frase NON promette una platea più larga di quella che il codice applica', () => {
    // La direzione che conta: se un domani si decidesse di mostrare il motivo anche alla
    // segreteria, questa prova cadrebbe e obbligherebbe a togliere il filtro — invece di
    // lasciare la frase a dire una cosa e il codice a farne un'altra.
    const dichiaraAltri = /segreteria|direzione|amministrazione|tutto il personale/i.test(FRASE)
    expect(
      dichiaraAltri,
      'La frase mostrata al genitore nomina anche la segreteria (o la direzione): allora il ' +
        'codice deve smettere di filtrare la colonna — vedi `motivoVisibileA` — oppure la frase ' +
        'va rimessa alla platea vera. Le due cose non possono divergere: è l’informativa data ' +
        'nel momento in cui si raccoglie un dato sanitario di un minore.',
    ).toBe(false)
  })

  it('e il codice restringe davvero: lo legge chi ha la classe assegnata', () => {
    expect(motivoVisibileA(utente('educator'))).toBe(true)
    for (const role of ['admin', 'coordinator', 'segreteria']) {
      expect(
        motivoVisibileA(utente(role)),
        `"${role}" vede tutte le classi del plesso: se legge anche il motivo, la frase mostrata ` +
          `al genitore è falsa.`,
      ).toBe(false)
    }
  })

  it('ogni rotta del PERSONALE che restituisce il motivo passa da quella regola', () => {
    for (const percorso of ROTTE_STAFF) {
      const sorgente = readFileSync(join(RADICE, percorso), 'utf8')
      expect(
        sorgente.includes('giustificazione_testo'),
        `${percorso} non nomina più \`giustificazione_testo\`: aggiorna l’elenco di questo lock, ` +
          `altrimenti sorveglia una rotta che non esiste più.`,
      ).toBe(true)
      expect(
        sorgente.includes("@/lib/presenze/motivo-visibile"),
        `${percorso} restituisce \`giustificazione_testo\` senza passare da ` +
          `\`@/lib/presenze/motivo-visibile\`: con \`requireDocente\` quella colonna arriva ` +
          `anche a chi vede TUTTE le classi del plesso, e la frase mostrata al genitore dice ` +
          `«le insegnanti della sezione».`,
      ).toBe(true)
    }
  })
})
