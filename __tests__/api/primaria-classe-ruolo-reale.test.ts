import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

/**
 * `primaria/classe/[sectionId]:GET` — LA VESTE APRIVA DUE PORTE.
 *
 * ─── LA DISTINZIONE ─────────────────────────────────────────────────────────
 *
 *   RUOLO REALE  = `utenti.ruolo` (+ `genitore` se esiste il ponte `parents`) →
 *                  `haRuolo`, ed è ciò su cui decide `requireDocente`
 *   RUOLO ATTIVO = la veste scelta col cookie `kv-active-role`, che
 *                  `require-staff.ts:341-348` SCRIVE SOPRA `user.role`
 *
 * Questa route chiedeva `user.role === 'educator'` in due punti, e per la maestra
 * che è anche mamma — mentre guardava l'app come genitore — quella domanda
 * rispondeva NO. Non la teneva fuori: `requireDocente` l'aveva già fatta entrare,
 * e giustamente, perché `educator` lo è davvero. La faceva entrare **come se fosse
 * la Segreteria**, cioè saltando entrambe le restrizioni che valgono per il
 * docente puro:
 *
 *   1. il gate del grado (`loadGradoContext` → `gradi.includes('primaria')`) non
 *      veniva nemmeno interrogato;
 *   2. l'isolamento per disciplina saltava: invece delle proprie materie riceveva
 *      TUTTE le materie attive della sezione — comprese quelle di colleghe su cui
 *      non ha titolo. L'isolamento dichiarato nel commento a :57-58 si apriva
 *      cambiando veste, che è il modo più silenzioso in cui una regola può cadere.
 *
 * In produzione **un educator di primaria ha il ponte genitore**: la popolazione
 * non è teorica, ed è una sola persona a distinguere i due comportamenti — motivo
 * per cui nessuno se ne sarebbe accorto guardando i log.
 *
 * ⚠️ Il verso opposto è coperto in fondo: chi docente non è (Segreteria, anche se
 * mamma) NON deve finire nel ramo del docente e perdere le materie della classe.
 *
 * ─── PERCHÉ `@/lib/auth/require-grado` NON È MOCKATO ────────────────────────
 *
 * Fino al 2026-09-09 questo file sostituiva il modulo con
 * `vi.mock(… () => ({ loadGradoContext: h.loadGradoContext }))`, e il gate del
 * grado veniva pilotato dal mock. Regge finché la route chiama `loadGradoContext`
 * in linea — ma `require-grado.ts` ha da oggi anche `assertGradoDocente`, il
 * predicato condiviso destinato a sostituire proprio questo blocco, e quel
 * predicato chiede `user.role !== 'educator'`, cioè LA VESTE: esattamente la
 * domanda che questo file esiste per vietare.
 *
 * MISURATO nello scratchpad, sostituendo il blocco in linea con
 * `assertGradoDocente(user)` senza toccare nient'altro:
 *   · con il mock di prima → 9 test su 11 rossi con **500** («No "assertGradoDocente"
 *     export is defined on the mock»): un rosso che parla del mock, non del difetto;
 *   · aggiungendo al mock `assertGradoDocente: vi.fn().mockResolvedValue(null)` —
 *     cioè l'abitudine già scritta in `primaria-registro-contenuti.test.ts:56` e
 *     `primaria-registro-destinatari.test.ts:68` → **3 rossi**, e i due casi del
 *     grado cadono INSIEME, con lo stesso messaggio, in veste di genitore e in
 *     veste di maestra. Da lì la riparazione naturale è far rispondere 403 al
 *     mock, e a quel punto il predicato vero non viene più eseguito da nessuno.
 *
 * Perciò il grado si pilota dalla tabella `utenti` del finto client, che le due
 * strade leggono entrambe. Con il predicato condiviso di oggi cade UN test solo —
 * quello in veste di genitore — e la firma del rosso dice da sola che dipende dal
 * cookie. Con `haRuolo` al posto di `user.role`, tutti verdi.
 * Il prezzo, dichiarato: questo file esegue davvero `loadGradoContext`, quindi si
 * accorge anche se cambia la query dei gradi. È il punto, non un effetto
 * collaterale — un mock non se ne sarebbe accorto.
 */

const SEDE = 'd53b0fbc-0000-4000-8000-000000000001'
const SEZIONE = '11111111-1111-4111-8111-111111111111'
const ITALIANO = 'aa111111-1111-4111-8111-111111111111'
const MATEMATICA = 'aa222222-2222-4222-8222-222222222222'
const STORIA = 'aa333333-3333-4333-8333-333333333333'

/** La maestra che è anche mamma: `utenti.ruolo = 'educator'` + ponte `parents`. */
const DOCENTE_GENITORE = '5d0ce07e-0000-4000-8000-000000000001'
const EDUCATOR_PURO = 'ed00ca70-0000-4000-8000-000000000002'
const SEGRETERIA = '5e6e7e00-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, ErrorePostgrest>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: vi.fn().mockResolvedValue(null) }))
// `@/lib/auth/require-grado` NON è mockato di proposito: vedi la testata.
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

// `@/lib/sezioni/docenti` NON è mockato di proposito: `materieDiDocenteInSezione`
// è quella vera e interroga il finto client, che i filtri li applica davvero. Con
// un mock al suo posto «il docente vede solo le sue materie» sarebbe un'asserzione
// sul mock, non sulla route.
import { GET } from '@/app/api/primaria/classe/[sectionId]/route'

/** Nomi di fantasia palese: in produzione, dietro questa tabella, ci sono minori. */
function db(): DBFinto {
  return {
    // La fonte del GRADO. `loadGradoContext` legge di qui, e `assertGradoDocente`
    // pure: è la tabella che rende il test indifferente a quale delle due strade
    // prenda la route.
    utenti: [
      { id: DOCENTE_GENITORE, gradi: ['primaria'], scuola_id: SEDE },
      { id: EDUCATOR_PURO, gradi: ['primaria'], scuola_id: SEDE },
    ],
    sections: [{ id: SEZIONE, name: 'Classe di prova', school_type: 'primaria', scuola_id: SEDE }],
    alunni: [
      { id: 'a1111111-1111-4111-8111-111111111111', nome: 'Alunna', cognome: 'Uno', section_id: SEZIONE, stato: 'iscritto', allergies: null, allergeni: null },
      { id: 'a2222222-2222-4222-8222-222222222222', nome: 'Alunno', cognome: 'Due', section_id: SEZIONE, stato: 'ritirato', allergies: null, allergeni: null },
    ],
    materie: [
      { id: ITALIANO, section_id: SEZIONE, nome: 'Italiano', codice: 'ITA', attiva: true, ordine: 1, e_civica: false, turno_mensa: null },
      { id: MATEMATICA, section_id: SEZIONE, nome: 'Matematica', codice: 'MAT', attiva: true, ordine: 2, e_civica: false, turno_mensa: null },
      { id: STORIA, section_id: SEZIONE, nome: 'Storia', codice: 'STO', attiva: true, ordine: 3, e_civica: false, turno_mensa: null },
    ],
    utenti_sezioni_materie: [
      { utente_id: DOCENTE_GENITORE, section_id: SEZIONE, materia_id: MATEMATICA },
      { utente_id: EDUCATOR_PURO, section_id: SEZIONE, materia_id: ITALIANO },
    ],
  }
}

/** Toglie la primaria dai gradi di chi è indicato: è così che si prova il 403. */
function senzaPrimaria(utenteId: string) {
  h.db.utenti = h.db.utenti.map((u) => (u.id === utenteId ? { ...u, gradi: ['infanzia'] } : u))
}

const req = () => new NextRequest(`http://localhost/api/primaria/classe/${SEZIONE}`)
const params = Promise.resolve({ sectionId: SEZIONE })

async function chiama(user: AppUser) {
  h.requireDocente.mockResolvedValue({ user })
  const res = await GET(req(), { params })
  return { status: res.status, body: (await res.json()) as Record<string, never> }
}

const materieDi = (body: { data?: { materie?: { id: string }[] } }) =>
  (body.data?.materie ?? []).map((m) => m.id).sort()

/** Ruoli reali `['educator','genitore']`, veste attiva = quella del cookie. */
const maestraMamma = (veste: 'genitore' | 'educator'): AppUser => ({
  id: DOCENTE_GENITORE,
  role: veste,
  ruoli: ['educator', 'genitore'],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = db()
  h.tabelle = []
  h.errori = {}
})

describe('IL DIFETTO 1 — in veste di genitore il gate del grado non veniva nemmeno interrogato', () => {
  it('la maestra-mamma NON abilitata alla primaria riceve 403, comunque si vesta', async () => {
    senzaPrimaria(DOCENTE_GENITORE)

    const r = await chiama(maestraMamma('genitore'))

    // Prima della correzione: 200, e con dentro l'intera classe.
    expect(r.status).toBe(403)
    // Osservazione di COMPORTAMENTO, non di un mock: la riga dei gradi è stata
    // letta davvero. Se il gate venisse saltato per via del cookie, `utenti`
    // non comparirebbe fra le tabelle interrogate.
    expect(h.tabelle, 'il gate va CHIESTO, non saltato per via del cookie').toContain('utenti')
  })

  it('la stessa persona in veste da maestra riceve lo stesso 403: la veste non decide niente', async () => {
    senzaPrimaria(DOCENTE_GENITORE)
    expect((await chiama(maestraMamma('educator'))).status).toBe(403)
  })

  it('abilitata alla primaria ⇒ 200 in entrambe le vesti, con gli stessi alunni iscritti', async () => {
    const veste = await chiama(maestraMamma('genitore'))
    const maestra = await chiama(maestraMamma('educator'))

    expect(veste.status).toBe(200)
    expect(maestra.status).toBe(200)
    expect(veste.body).toEqual(maestra.body)
    const alunni = (veste.body as unknown as { data: { alunni: unknown[] } }).data.alunni
    expect(alunni, 'un ritirato non è un alunno della classe').toHaveLength(1)
  })

  it('se la riga dei gradi NON si legge, nega: 403, non un 200 «non lo so»', async () => {
    // `loadGradoContext` torna `null` sia per «utente non trovato» sia per un
    // guasto di lettura — PostgREST non lancia, ritorna `{ error }`. Il ramo esiste
    // (`require-grado.ts:36-42`, `tipo: 'grado-contesto-non-letto'`) e da oggi la
    // maestra-mamma ci passa dentro come ogni altro educator: `42703` è il caso
    // reale del DB E2E non migrato.
    h.errori = { 'utenti:select': { code: '42703', message: 'column "gradi" does not exist' } }
    expect((await chiama(maestraMamma('genitore'))).status).toBe(403)
  })
})

describe('IL DIFETTO 2 — in veste di genitore saltava l’isolamento per disciplina', () => {
  it('la maestra-mamma riceve SOLO le proprie materie, non tutte quelle della sezione', async () => {
    const r = await chiama(maestraMamma('genitore'))

    // Prima della correzione: [ITALIANO, MATEMATICA, STORIA] — le materie di due
    // colleghe comprese. Non è un dettaglio di presentazione: è il ramo `else`,
    // quello pensato per staff e segreteria.
    expect(materieDi(r.body)).toEqual([MATEMATICA])
  })

  it('cambiare veste non cambia il perimetro: le stesse materie in entrambe', async () => {
    expect(materieDi((await chiama(maestraMamma('genitore'))).body)).toEqual(
      materieDi((await chiama(maestraMamma('educator'))).body),
    )
  })

  it('una maestra-mamma senza materie assegnate riceve [], non l’intera classe', async () => {
    // Fail-closed: la lista vuota è la risposta giusta a «non ti è stata assegnata
    // nessuna disciplina», e prima era il caso che degradava peggio di tutti —
    // zero materie proprie diventavano tutte le materie altrui.
    h.db.utenti_sezioni_materie = [{ utente_id: EDUCATOR_PURO, section_id: SEZIONE, materia_id: ITALIANO }]
    expect(materieDi((await chiama(maestraMamma('genitore'))).body)).toEqual([])
  })
})

describe('i rami che c’erano già, e devono restare identici', () => {
  it('educator puro ⇒ le sue materie e il gate del grado interrogato', async () => {
    const r = await chiama({ id: EDUCATOR_PURO, role: 'educator' })
    expect(materieDi(r.body)).toEqual([ITALIANO])
    expect(h.tabelle).toContain('utenti')
  })

  it('Segreteria ⇒ tutte le materie attive della sezione, e nessun gate di grado', async () => {
    const r = await chiama({ id: SEGRETERIA, role: 'segreteria' })
    expect(materieDi(r.body)).toEqual([ITALIANO, MATEMATICA, STORIA].sort())
    expect(h.tabelle, 'admin/coordinator/segreteria agiscono su tutta la scuola').not.toContain('utenti')
  })

  it('la Segreteria che è anche mamma resta Segreteria: il ponte genitore non la degrada a docente', async () => {
    // Il verso opposto del difetto, ed è quello che una correzione frettolosa
    // rompe: `ruoli` contiene `genitore`, ma `educator` no — quindi niente ramo
    // docente, niente gate di grado, tutte le materie.
    const r = await chiama({ id: SEGRETERIA, role: 'genitore', ruoli: ['segreteria', 'genitore'] })
    expect(r.status).toBe(200)
    expect(materieDi(r.body)).toEqual([ITALIANO, MATEMATICA, STORIA].sort())
    expect(h.tabelle).not.toContain('utenti')
  })

  it('una materia disattivata non compare a nessuno dei due', async () => {
    h.db.materie = h.db.materie.map((m) => (m.id === MATEMATICA ? { ...m, attiva: false } : m))
    expect(materieDi((await chiama(maestraMamma('genitore'))).body)).toEqual([])
    expect(materieDi((await chiama({ id: SEGRETERIA, role: 'segreteria' })).body)).toEqual(
      [ITALIANO, STORIA].sort(),
    )
  })

  it('sezione inesistente ⇒ 404, senza inventarsi una classe vuota', async () => {
    h.db.sections = []
    expect((await chiama({ id: SEGRETERIA, role: 'segreteria' })).status).toBe(404)
  })
})
