import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C, NOME_SEDE_E2E } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// «SPOSTA DI SEDE»: il rimedio all'errore che il modulo pubblico rende inevitabile.
//
// ── IL DIFETTO CHE QUESTA AZIONE CHIUDE ──────────────────────────────────────
// `/anagrafica-personale` chiede la sede in una schermata di card, e chi compila è una
// maestra col telefono in mano: sbagliare card è il caso normale, non l'abuso. Da quel
// momento la pratica la vede SOLO la Segreteria del plesso sbagliato — l'isolamento
// fra sedi, che qui lavora contro di noi — e quella giusta la aspetta credendo che non
// sia mai arrivata. Senza questa azione l'unico rimedio sarebbe rifiutarla e far
// ricompilare 32 campi più una nuova fotografia del documento.
//
// ── LE COSE CHE QUESTO FILE TIENE FERME ──────────────────────────────────────
//  1. il gate è sulla sede di PARTENZA: si sposta solo ciò che si vede, e la clausola
//     sta NELL'ISTRUZIONE che scrive;
//  2. la DESTINAZIONE non è gattata dallo scope — sarebbe il verso sbagliato: la
//     segreteria di un plesso solo è esattamente quella che ha bisogno di spostare
//     verso un plesso che non gestisce, e con la destinazione ristretta l'unica
//     persona capace di rimediare sarebbe l'unica che non ne ha bisogno;
//  3. …ma dev'essere una sede VERA: la sede fittizia della CI non è una destinazione,
//     e mandarci una pratica vera la farebbe sparire da tutte le scrivanie;
//  4. solo da `pending`: una pratica approvata ha già generato fascicolo e account su
//     QUELLA sede, e spostarla dopo cambierebbe la sede della pratica e non quella
//     della persona — cioè creerebbe la divergenza che si voleva chiudere;
//  5. la Segreteria di DESTINAZIONE viene avvisata, altrimenti la pratica comparirebbe
//     nel suo elenco senza che nessuno l'abbia annunciata.
// =============================================================================

const SEGRETERIA = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_ID = 'dddddddd-0000-4000-8000-00000000000a'

const h = vi.hoisted(() => ({
  state: {
    tabelle: {} as Record<string, Record<string, unknown>[]>,
    inserimenti: [] as { table: string; row: Record<string, unknown> }[],
    aggiornamenti: [] as { table: string; patch: Record<string, unknown>; filtri: { col: string; vals: unknown[] }[] }[],
    upserts: [] as { table: string; row: Record<string, unknown>; onConflict: string | null }[],
    authUsers: [] as { id: string; email: string }[],
    creazioniAuth: [] as { email: string; password?: string }[],
    cancellazioniAuth: [] as string[],
    erroriTabella: {} as Record<string, { code?: string; message: string }>,
    colonneAssenti: {} as Record<string, string[]>,
    erroreStorage: null as null | { message: string },
    urlFirmate: [] as { path: string; secondi: number }[],
    erroreCreazioneAuth: null as null | { message: string; status?: number },
  },
  scuole: [] as string[],
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
  notificaEvento: vi.fn(),
  staffScuola: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// `restringiSedi` resta VERA: la sede chiesta col filtro deve intersecare davvero,
// e un finto che dicesse sempre di sì non proverebbe nessun diniego.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => h.scuole,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: h.staffScuola }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => costruisciClient(h.state as unknown as StatoFinto),
  createClient: async () => costruisciClient(h.state as unknown as StatoFinto),
}))

import { PATCH } from '@/app/api/admin/pratiche-personale/route'

const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/pratiche-personale', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const sposta = (scuolaId: string) => PATCH(patch({ id: PRATICA_ID, action: 'sposta-sede', scuola_id: scuolaId }))
const pratica = () => h.state.tabelle.pratiche_personale[0]

beforeEach(() => {
  vi.clearAllMocks()
  // L'operatore vede SOLO SEDE_A: è la segreteria di un plesso, ed è il caso per cui
  // questa azione esiste.
  h.scuole = [SEDE_A]
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], authUsers: [], creazioniAuth: [],
    cancellazioniAuth: [], erroriTabella: {}, colonneAssenti: {}, erroreStorage: null,
    urlFirmate: [], erroreCreazioneAuth: null,
  })
  h.state.tabelle = {
    pratiche_personale: [{
      id: PRATICA_ID, scuola_id: SEDE_A, stato: 'pending',
      nome: 'Prova', cognome: 'Cognome', email: 'maestra.prova@example.test',
      gradi: ['nido'], creata_il: '2026-08-11T08:00:00.000Z',
    }],
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_C, nome: NOME_SEDE_C },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
    scuole: [
      { id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true },
    ],
    utenti: [],
    parents: [],
    anagrafica_personale: [],
  }
  h.staffScuola.mockResolvedValue(['segreteria-b'])
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    if (!ammessi.includes(SEGRETERIA.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: SEGRETERIA }
  })
})

describe('pratiche personale · sposta di sede', () => {
  it('sposta verso un plesso che l’operatore NON gestisce: è il caso per cui esiste', async () => {
    const res = await sposta(SEDE_B)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.spostata).toBe(true)
    expect(body.scuola_id).toBe(SEDE_B)
    expect(pratica().scuola_id).toBe(SEDE_B)
    expect(pratica().stato, 'lo spostamento ha anche deciso la pratica').toBe('pending')
  })

  it('il gate è sulla sede di PARTENZA, e la clausola sta NELL’ISTRUZIONE che scrive', async () => {
    await sposta(SEDE_B)
    const scritture = h.state.aggiornamenti.filter((a) => a.table === 'pratiche_personale')
    expect(scritture).toHaveLength(1)
    const perSede = scritture[0].filtri.find((f) => f.col === 'scuola_id')
    expect(perSede, 'lo spostamento non porta la clausola di sede').toBeTruthy()
    // Le sedi ATTIVE dell'operatore, cioè la PARTENZA — non la destinazione.
    expect(perSede!.vals).toEqual([SEDE_A])
    const perStato = scritture[0].filtri.find((f) => f.col === 'stato')
    expect(perStato!.vals).toEqual(['pending'])
  })

  it('una pratica di un’ALTRA sede non si sposta: 404, e nessuna scrittura', async () => {
    pratica().scuola_id = SEDE_C
    const res = await sposta(SEDE_B)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRATICA_NON_TROVATA')
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('la sede FITTIZIA della CI non è una destinazione: 400, e la pratica non si muove', async () => {
    // Mandarci una pratica vera la farebbe sparire da tutte le scrivanie: `sediReali`
    // esclude quella sede da ogni elenco pubblico, quindi nessuno la vedrebbe più.
    const res = await sposta(SEDE_E2E)
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PRATICA_SEDE_NON_AMMESSA')
    expect(pratica().scuola_id).toBe(SEDE_A)
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('una sede che non esiste: 400, e non si scrive niente', async () => {
    const res = await sposta('99999999-0000-4000-8000-000000000099')
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PRATICA_SEDE_NON_AMMESSA')
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('solo da `pending`: su una pratica già decisa esce 409', async () => {
    pratica().stato = 'approvata'
    const res = await sposta(SEDE_B)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRATICA_GIA_EVASA')
    expect(pratica().scuola_id).toBe(SEDE_A)
  })

  it('stessa sede: non è un errore e non si scrive niente', async () => {
    // Dirlo con un 400 manderebbe l'operatore a cercare che cosa ha sbagliato in un
    // gesto che semplicemente non serviva.
    const res = await sposta(SEDE_A)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.spostata).toBe(false)
    expect(h.state.aggiornamenti).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('la Segreteria di DESTINAZIONE viene avvisata, e l’avviso non porta nomi', async () => {
    await sposta(SEDE_B)
    expect(h.staffScuola).toHaveBeenCalledTimes(1)
    expect(h.staffScuola.mock.calls[0][1], 'l’avviso è andato alla sede sbagliata').toBe(SEDE_B)
    expect(h.staffScuola.mock.calls[0][2]).toEqual(['admin', 'coordinator', 'segreteria'])

    const avviso = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
    // Si riusa il tipo della pratica ricevuta: una scuola che ha spento quegli avvisi
    // non deve riceverne uno dalla porta di servizio.
    expect(avviso.tipo).toBe('pratica_personale_ricevuta')
    expect(avviso.scuolaId).toBe(SEDE_B)
    expect(avviso.link).toBe('/admin/modulistica?tab=personale')
    expect(`${String(avviso.titolo)} ${String(avviso.corpo)}`).not.toMatch(/Prova|Cognome|example\.test/)
  })

  it('l’AUDIT registra le DUE sedi, e resta agganciato a quella di partenza', async () => {
    await sposta(SEDE_B)
    const voce = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(voce.entitaTipo).toBe('pratica_personale')
    // La sede dell'audit è la PARTENZA: la domanda a cui questo registro deve saper
    // rispondere è «chi ha spostato una pratica FUORI dal proprio plesso?».
    expect(voce.scuolaId).toBe(SEDE_A)
    expect(voce.valorePrima).toEqual({ scuola_id: SEDE_A })
    expect(voce.valoreDopo).toEqual({ scuola_id: SEDE_B })
  })

  it('l’elenco delle sedi non leggibile: fail-CLOSED, 503 e nessuno spostamento', async () => {
    // Senza l'elenco non si sa dove si sta mandando una pratica con dentro un codice
    // fiscale e la fotografia di un documento d'identità.
    h.state.erroriTabella = { schools: { code: '08006', message: 'connection failure' } }
    const res = await sposta(SEDE_B)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    expect(pratica().scuola_id).toBe(SEDE_A)
  })

  it('`scuola_id` mancante nel corpo: 400 di validazione, non un ramo che scrive `undefined`', async () => {
    const res = await PATCH(patch({ id: PRATICA_ID, action: 'sposta-sede' }))
    expect(res.status).toBe(400)
    expect(h.state.aggiornamenti).toEqual([])
  })
})
