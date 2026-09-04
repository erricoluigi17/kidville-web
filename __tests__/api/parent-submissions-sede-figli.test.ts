import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * LA SEGRETERIA AVVISATA È QUELLA DEI FIGLI, NON QUELLA DELL'ACCOUNT.
 *
 * ─── IL DIFETTO MISURATO ─────────────────────────────────────────────────────
 * `POST /api/parent/submissions` sceglieva la sede della notifica «modulo
 * compilato ricevuto» così:
 *
 *     let scuolaId = null
 *     if (student_id) { …sede del bambino… }
 *     if (!scuolaId) scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(supabase))
 *
 * Il primo ramo è giusto e resta. È il secondo il guasto: `auth.user.scuola_id` è
 * la sede dell'ACCOUNT, cioè il plesso in cui l'account è stato aperto. Un
 * genitore può avere due figli in due plessi — `parents` non ha `scuola_id`, ed è
 * una scelta esplicita — quindi quel valore è al più UNA delle sue sedi, e può
 * benissimo non essere nessuna delle due attuali.
 *
 * Il secondo ramo NON è un caso di laboratorio: si imbocca ogni volta che il
 * modulo non è legato a un bambino — `student_id` è opzionale e assente in tutto
 * l'onboarding, «si compila PRIMA che esista un bambino a cui riferire il
 * modulo», dice la route stessa — e ogni volta che l'anagrafica del bambino non
 * porta il plesso.
 *
 * ─── MISURATO IN PRODUZIONE, 2026-09-03 ──────────────────────────────────────
 * **639 account genitore su 639** hanno `utenti.scuola_id` valorizzata: zero a
 * `null`. Il ripiego non falliva mai, quindi decideva sempre — e in 6 di quegli
 * account contraddice almeno un figlio. `scuolaUnicaReale`, l'anello successivo,
 * non veniva mai raggiunto: è deprecata e con tre sedi risponde comunque `null`.
 *
 * ─── COSA DEVE FARE, INVECE ──────────────────────────────────────────────────
 * PRIMA di dedurre alcunché si guarda **la sede del MODULO**.
 * `forms_templates.scuola_id` è NOT NULL (baseline riga 1732, riverificata in
 * produzione il 2026-09-03) e `parent/forms:GET` elenca a una famiglia solo i
 * moduli delle sedi dei suoi figli: il plesso di un modulo non è una deduzione,
 * è un dato. La route leggeva già `forms_templates` per il titolo e non ne
 * prendeva la sede.
 *
 * ⚠️ LA PRIMA CORREZIONE DEDUCEVA DAI FIGLI ANCHE QUI, e con due plessi avvisava
 * ENTRAMBE le segreterie. Copriva, ma risolveva il problema sbagliato: un
 * genitore con figli a Giugliano e ad Aversa che firma un modulo DI AVERSA
 * faceva arrivare «Modulo compilato ricevuto» anche a Giugliano, con un link a
 * una modulistica che in quel plesso non esiste — e spegneva il debounce senza
 * motivo (in produzione oggi `forms_templates` ha 0 righe, quindi nessun danno
 * ancora: il ramo è quello che verrà usato appena ne esisterà una).
 *
 * I due anelli successivi RESTANO, e sono di sola degradazione: se la lettura di
 * `forms_templates` fallisce (DB della CI non migrato, PostgREST `42703`) si
 * ripiega sulla sede del bambino e poi su quelle dei figli. Lì, e solo lì, si
 * coprono tutte: non si sta archiviando una riga in un plesso — la compilazione
 * è già salvata, e `forms_submissions` non ha una `scuola_id` da sbagliare — si
 * decide CHI viene informato, e in un ramo di guasto avvisare in più è meno
 * grave che non avvisare.
 */

const GENITORE = 'bbbbbbbb-0000-4000-8000-000000000002'
const FIGLIO_A = 'cccccccc-0000-4000-8000-000000000003'
const FIGLIO_B = 'cccccccc-0000-4000-8000-000000000004'
const FIGLIO_SENZA_SEDE = 'cccccccc-0000-4000-8000-000000000005'
const MODULO = 'dddddddd-0000-4000-8000-000000000006'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireParentOfStudent: vi.fn(),
  assertNonSospeso: vi.fn(),
  leggiSempreFirmabile: vi.fn(),
  persistSignedSubmission: vi.fn(),
  notificaEvento: vi.fn(),
  staffScuola: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  /** Errore PostgREST da iniettare su una tabella (PostgREST non lancia). */
  errori: {} as Record<string, { code: string; message?: string }>,
  /** La PROIEZIONE di ogni `.select(…)`, tabella per tabella. Vedi `conProiezioni`. */
  proiezioni: [] as Array<{ tabella: string; colonne: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospesoSalvoEssenziale: h.assertNonSospeso,
}))
vi.mock('@/lib/forms/sempre-firmabile', () => ({ leggiSempreFirmabile: h.leggiSempreFirmabile }))
vi.mock('@/lib/forms/persist-submission', () => ({ persistSignedSubmission: h.persistSignedSubmission }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: h.staffScuola }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
// `getFigliDiGenitore` NON è mockata: gira davvero sul finto client, così il
// test prova anche che l'unione runtime+anagrafica venga interrogata sul serio.
/**
 * IL FINTO CLIENT NON APPLICA LA PROIEZIONE DI `select()`, E QUI QUEL LIMITE MORDE.
 *
 * Lo dichiara la testata di `finto-supabase.ts`: «le righe tornano INTERE, quindi
 * un test non può provare "quel campo non è stato selezionato"». MISURATO il
 * 2026-09-03: rimettendo `select('title')` al posto di `select('title, scuola_id')`
 * — cioè togliendo alla route l'unico modo di sapere il plesso del modulo — questi
 * test restavano verdi 8 su 8, perché il finto client restituiva `scuola_id`
 * comunque. In produzione PostgREST restituisce SOLO le colonne chieste: la sede
 * sarebbe `undefined` e la route ripiegherebbe in silenzio sulle sedi dei figli,
 * cioè esattamente il difetto che questo file dichiara di aver chiuso.
 *
 * È la stessa forma di guasto che il 2026-09-02 ha tenuto ferma la fatturazione
 * (il numero della fattura letto un livello più su: `undefined` su 3.311 su 3.311,
 * con i mock verdi). Un mock che risponde uguale con e senza la correzione non è
 * un test: è una certificazione.
 *
 * Rimedio: la PROIEZIONE di ogni `.select()` viene registrata, e si asserisce che
 * la lettura di `forms_templates` chieda davvero `scuola_id`. Il finto client
 * resta intatto — il limite è suo e dichiarato, la prova la fa il chiamante.
 */
const conProiezioni = (finto: SupabaseClient): SupabaseClient =>
  new Proxy(finto as unknown as Record<string, unknown>, {
    get(bersaglio, prop) {
      const membro = Reflect.get(bersaglio, prop)
      if (prop !== 'from' || typeof membro !== 'function') return membro
      return (tabella: string) => {
        const builder = (membro as (t: string) => Record<string, unknown>).call(bersaglio, tabella)
        return new Proxy(builder, {
          get(b, chiave) {
            const valore = Reflect.get(b, chiave)
            if (chiave !== 'select' || typeof valore !== 'function') return valore
            return (...args: unknown[]) => {
              h.proiezioni.push({ tabella, colonne: String(args[0] ?? '*') })
              return (valore as (...a: unknown[]) => unknown).apply(b, args)
            }
          },
        })
      }
    },
  }) as unknown as SupabaseClient

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => conProiezioni(creaFintoSupabase(h.db, [], { errori: h.errori })),
}))

import { NextRequest } from 'next/server'

import { POST } from '@/app/api/parent/submissions/route'

// `NextRequest` e non `Request`: la route è tipizzata su `NextRequest` (route.ts:121)
// e una `Request` nuda non ha `cookies`/`nextUrl`. Passarla compila solo con un
// cast, e un cast qui nasconderebbe il giorno in cui la route iniziasse davvero
// a leggere un cookie.
const req = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Le sedi con cui è stata accodata una notifica, nell'ordine in cui è successo. */
const sediNotificate = () =>
  h.notificaEvento.mock.calls.map((c) => (c[1] as { scuolaId?: string | null }).scuolaId ?? null)
/** Le sedi per cui si è chiesto l'elenco dello staff. */
const sediInterrogate = () => h.staffScuola.mock.calls.map((c) => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  // L'account del genitore è nato a Giugliano (SEDE_A): in produzione ce l'hanno
  // tutti e 639, quindi il ripiego sbagliato non fallisce mai da solo.
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: GENITORE } })
  h.assertNonSospeso.mockResolvedValue(null)
  h.leggiSempreFirmabile.mockResolvedValue(false)
  h.persistSignedSubmission.mockResolvedValue({ submission: { id: 'sub-1' } })
  h.staffScuola.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? [`staff-${sede}`] : []))
  h.notificaEvento.mockResolvedValue(undefined)
  h.db = {
    alunni: [
      { id: FIGLIO_A, scuola_id: SEDE_A },
      { id: FIGLIO_B, scuola_id: SEDE_B },
      { id: FIGLIO_SENZA_SEDE, scuola_id: null },
    ],
    legame_genitori_alunni: [],
    parents: [],
    student_parents: [],
    // Il modulo è di una TERZA sede: né quella dell'account né quella di un
    // figlio. Se la notifica esce con SEDE_C può venire solo di lì — nessuna
    // asserzione può passare per coincidenza.
    forms_templates: [{ id: MODULO, title: 'Consenso uscite', scuola_id: SEDE_C }],
  }
  h.errori = {}
  h.proiezioni = []
})

/** Le colonne chieste a una tabella, in ogni `.select()` che l'ha interrogata. */
const colonneChiesteA = (tabella: string) =>
  h.proiezioni.filter((p) => p.tabella === tabella).map((p) => p.colonne)

/** L'esito di un `logEvento`, per `esito`. */
const rigaLog = (esito: string) =>
  h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

describe('POST /api/parent/submissions — la sede della notifica è quella del MODULO', () => {
  it('modulo legato a un bambino: decide il MODULO, non il bambino e tanto meno l’account', async () => {
    // Tre sedi in gioco: l'account è nato in A, il bambino sta in B, il modulo è
    // di C. Solo una di quelle tre è un dato certo, e non è una delle prime due.
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_B }]

    const res = await POST(req({ form_id: MODULO, student_id: FIGLIO_B, answers: { x: 1 } }))

    expect(res.status).toBe(201)
    expect(sediNotificate()).toEqual([SEDE_C])
    expect(sediInterrogate()).toEqual([SEDE_C])
  })

  it('modulo SENZA bambino (onboarding): resta la sede del modulo, non quella dell’account', async () => {
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_B }]

    const res = await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    expect(res.status).toBe(201)
    expect(sediNotificate()).toEqual([SEDE_C])
  })

  it('due figli in due plessi: si avvisa UNA segreteria sola — quella del modulo — e il debounce resta ACCESO', async () => {
    // ⚠️ QUESTO TEST ASSERIVA `[SEDE_A, SEDE_B]`: entrambe le segreterie dei
    // figli. Era la copertura del problema sbagliato — la sede del modulo è
    // certa, e la segreteria dell'altro plesso riceveva un avviso con un link a
    // una modulistica che da lei non esiste. Con una sede sola il debounce non
    // ha più motivo di spegnersi: le raffiche di compilazioni dello stesso
    // modulo tornano a collassare in una notifica.
    h.db.legame_genitori_alunni = [
      { genitore_id: GENITORE, alunno_id: FIGLIO_A },
      { genitore_id: GENITORE, alunno_id: FIGLIO_B },
    ]

    const res = await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    expect(res.status).toBe(201)
    expect(sediNotificate()).toEqual([SEDE_C])
    expect(sediInterrogate()).toEqual([SEDE_C])
    expect(h.notificaEvento.mock.calls).toHaveLength(1)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ debounce: true })
  })

  it('titolo e sede si chiedono nella STESSA `select`, e la sede è davvero fra le colonne chieste', async () => {
    // Due cose, in una lettura sola:
    //  · il corpo della notifica porta il titolo, quindi `title` è stato letto;
    //  · la PROIEZIONE contiene `scuola_id`, quindi in produzione PostgREST la
    //    restituirà davvero. Senza questa seconda riga, `select('title')` — cioè
    //    la route che non chiede mai il plesso — passerebbe: il finto client
    //    restituisce le righe intere e la sede arriverebbe lo stesso.
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_B }]

    await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({
      scuolaId: SEDE_C,
      corpo: expect.stringContaining('Consenso uscite'),
    })
    const letture = colonneChiesteA('forms_templates')
    expect(letture).toHaveLength(1)
    expect(letture[0]).toMatch(/\bscuola_id\b/)
    expect(letture[0]).toMatch(/\btitle\b/)
  })

  // ── I DUE ANELLI DI DEGRADAZIONE ────────────────────────────────────────────
  // Esistono per il DB della CI, che non è migrato: se `forms_templates` non si
  // può leggere, «non avviso nessuno» sarebbe la scelta peggiore delle tre.

  it('lettura del modulo fallita (PostgREST 42703): si ripiega sul BAMBINO, e lascia una riga', async () => {
    h.errori = { forms_templates: { code: '42703', message: 'column does not exist' } }
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_B }]

    const res = await POST(req({ form_id: MODULO, student_id: FIGLIO_B, answers: { x: 1 } }))

    expect(res.status).toBe(201)
    expect(sediNotificate()).toEqual([SEDE_B])
    // PostgREST non lancia: senza il controllo di `{ error }`, «il modulo non ha
    // sede» e «non ho potuto leggerlo» sarebbero lo stesso `null`, in silenzio.
    const riga = rigaLog('modulo-non-letto')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ error_code: '42703', entita_id: MODULO })
  })

  it('modulo illeggibile e due figli in due plessi: si avvisano ENTRAMBE, e il debounce è SPENTO', async () => {
    // `notificaEvento` col debounce esegue
    //   delete from notifiche where tipo = ? and entita_id = ? and push_inviata_il is null
    // — senza filtro per sede né per destinatario. Con lo stesso `entitaId`
    // (il `form_id`) su due chiamate, la seconda spazzerebbe via la riga appena
    // accodata per la prima segreteria: «avvisate entrambe» diventerebbe
    // «avvisata solo l'ultima», in silenzio.
    h.errori = { forms_templates: { code: '42703' } }
    h.db.legame_genitori_alunni = [
      { genitore_id: GENITORE, alunno_id: FIGLIO_A },
      { genitore_id: GENITORE, alunno_id: FIGLIO_B },
    ]

    await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    expect([...sediNotificate()].sort()).toEqual([SEDE_A, SEDE_B].sort())
    expect(h.notificaEvento.mock.calls).toHaveLength(2)
    for (const [, params] of h.notificaEvento.mock.calls) {
      expect((params as { debounce?: boolean }).debounce ?? false).toBe(false)
    }
  })

  it('né modulo leggibile né un figlio con un plesso: nessuna notifica al buio, e una riga di livello `error`', async () => {
    // `staffScuola(null)` non avvisa nessuno: accodare comunque produrrebbe una
    // notifica senza destinatari, cioè rumore che somiglia a un successo.
    h.errori = { forms_templates: { code: '42703' } }
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_SENZA_SEDE }]

    const res = await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    expect(res.status).toBe(201)
    expect(h.notificaEvento.mock.calls).toHaveLength(0)
    const riga = rigaLog('sede-non-attribuibile')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('error')
    expect(riga![2]).toMatchObject({ operazione: 'parent/submissions:POST' })
  })

  it('nei log non finisce nessun id di minore: solo conteggi e uuid del modulo', async () => {
    h.errori = { forms_templates: { code: '42703' } }
    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: FIGLIO_SENZA_SEDE }]
    await POST(req({ form_id: MODULO, answers: { x: 1 } }))

    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain(FIGLIO_SENZA_SEDE)
  })
})
