import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// «RIFIUTA»: la pratica si archivia, e NON succede nient'altro.
//
// È la metà silenziosa di questo cockpit, e proprio per questo la più facile da
// sbagliare: un rifiuto che tocca `utenti` non produce nessun errore visibile, e chi
// lo scoprisse lo scoprirebbe da un'insegnante che non entra più. Le quattro cose che
// questo file tiene ferme:
//
//  1. NESSUNA scrittura su `utenti` e NESSUN fascicolo: né insert, né update, né
//     upsert. È l'unica prova che distingue «rifiutata» da «approvata a metà»;
//  2. il MOTIVO è una nota INTERNA: resta in tabella, non parte nessuna email e non
//     entra nei log (l'audit registra che c'era, mai che cosa diceva);
//  3. si rifiuta ciò che è ancora in gioco (`pending` o `in_approvazione`): su una
//     pratica già decisa esce 409, che è «ha già deciso qualcun altro»;
//  4. nessuna email di esito, e non è una dimenticanza: chi ha compilato lavora qui, e
//     una mail automatica di rifiuto senza motivazione — perché il motivo è interno —
//     direbbe meno di niente e allarmerebbe una collega.
// =============================================================================

const SEGRETERIA = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_ID = 'dddddddd-0000-4000-8000-00000000000a'
const EMAIL = 'maestra.prova@example.test'
const MOTIVO = 'Il codice fiscale non corrisponde al documento consegnato in segreteria.'
/**
 * LE DUE FACCE DEL DOCUMENTO, con i NOMI DI COLONNA CHE ESISTONO DAVVERO.
 *
 * Fino a questa correzione la riga finta portava `documento_path`, e la prova «la
 * scansione resta dov'è» asseriva su quel nome. Quella colonna NON esiste più: la
 * migrazione `20260812194501` l'ha rinominata in `documento_fronte_path` e ha aggiunto
 * `documento_retro_path`. Misurato sul database di produzione, non dedotto:
 *
 *     select column_name from information_schema.columns
 *      where table_name = 'pratiche_personale' and column_name like 'documento%'
 *     → documento_fronte_path, documento_retro_path
 *
 * Un'asserzione su una colonna che non c'è è un'asserzione VUOTA: se il rifiuto un
 * giorno azzerasse per errore i due percorsi veri, questo file resterebbe verde e
 * l'unica prova che «il rifiuto non rilascia la scansione» sarebbe una prova su un
 * fantasma.
 */
const DOC_FRONTE = 'documenti/aaaa/bbbb.jpg'
const DOC_RETRO = 'documenti/aaaa/cccc.jpg'

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
const rifiuta = (motivo?: string) => PATCH(patch({ id: PRATICA_ID, action: 'rifiuta', motivo }))
const pratica = () => h.state.tabelle.pratiche_personale[0]

beforeEach(() => {
  vi.clearAllMocks()
  h.scuole = [SEDE_A, SEDE_B]
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], authUsers: [], creazioniAuth: [],
    cancellazioniAuth: [], erroriTabella: {}, colonneAssenti: {}, erroreStorage: null,
    urlFirmate: [], erroreCreazioneAuth: null,
  })
  h.state.tabelle = {
    pratiche_personale: [{
      id: PRATICA_ID, scuola_id: SEDE_B, stato: 'pending',
      nome: 'Prova', cognome: 'Cognome', email: EMAIL, telefono: '+39 000 0000000',
      fiscal_code: 'RSSMRA90A41H501U', gradi: ['nido'],
      documento_fronte_path: DOC_FRONTE, documento_retro_path: DOC_RETRO,
      creata_il: '2026-08-11T08:00:00.000Z',
    }],
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    utenti: [{ id: 'utente-1', email: EMAIL, ruolo: 'educator', scuola_id: SEDE_B, nome: 'X', cognome: 'Y' }],
    anagrafica_personale: [],
    parents: [],
  }
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    if (!ammessi.includes(SEGRETERIA.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: SEGRETERIA }
  })
})

describe('pratiche personale · rifiuto', () => {
  it('archivia la pratica e NON tocca `utenti` né l’anagrafica', async () => {
    const res = await rifiuta(MOTIVO)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.stato).toBe('rifiutata')

    expect(pratica().stato).toBe('rifiutata')
    expect(pratica().evasa_da).toBe(SEGRETERIA.id)
    expect(pratica().motivo_rifiuto).toBe(MOTIVO)

    // Le tre prove che distinguono un rifiuto da un'approvazione a metà.
    expect(h.state.inserimenti).toEqual([])
    expect(h.state.upserts).toEqual([])
    expect(h.state.aggiornamenti.filter((a) => a.table === 'utenti')).toEqual([])
    expect(h.state.creazioniAuth).toEqual([])
    // LE DUE SCANSIONI restano dove sono: la pratica rifiutata le conserva finché la
    // conservazione a 90 giorni non porta via riga e file insieme. Il rilascio dei
    // percorsi è un gesto dell'APPROVAZIONE («un oggetto, un proprietario»), e un
    // rifiuto che li azzerasse lascerebbe nel bucket due oggetti che nessuna riga
    // nomina — invisibili alla conservazione e non cancellabili nemmeno su richiesta
    // dell'interessata. Si guardano ENTRAMBE: con una faccia sola questa prova non
    // vedrebbe il caso in cui il rifiuto ne rilascia una e si tiene l'altra.
    expect(pratica().documento_fronte_path).toBe(DOC_FRONTE)
    expect(pratica().documento_retro_path).toBe(DOC_RETRO)
    // E l'istruzione di rifiuto non le ha nemmeno NOMINATE: non è «le ha riscritte col
    // valore giusto», è «non gliele ha proprio chieste».
    const scrittura = h.state.aggiornamenti.filter((a) => a.table === 'pratiche_personale').at(-1)!
    expect('documento_fronte_path' in scrittura.patch).toBe(false)
    expect('documento_retro_path' in scrittura.patch).toBe(false)
  })

  it('il MOTIVO non esce da `pratiche_personale`: niente audit, niente log, niente email', async () => {
    await rifiuta(MOTIVO)

    // L'audit dice CHE c'era un motivo, non che cosa diceva.
    const voce = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    const dopo = voce.valoreDopo as Record<string, unknown>
    expect(dopo.motivo_presente).toBe(true)
    expect(JSON.stringify(dopo)).not.toContain('codice fiscale')

    // E nei log applicativi non compare da nessuna parte.
    const tuttiILog = JSON.stringify(h.logEvento.mock.calls)
    expect(tuttiILog).not.toContain(MOTIVO)
    expect(tuttiILog).not.toContain('segreteria.')

    // Nessuna notifica e nessuna email: il rifiuto non si annuncia a nessuno.
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('senza motivo: 200, e l’audit dice che la nota NON c’è', async () => {
    const res = await rifiuta()
    expect(res.status).toBe(200)
    expect(pratica().motivo_rifiuto).toBeNull()
    const dopo = (h.logScrittura.mock.calls[0][1] as Record<string, unknown>).valoreDopo as Record<string, unknown>
    expect(dopo.motivo_presente).toBe(false)
  })

  it('una pratica GIÀ decisa prende 409: «ha già deciso qualcun altro»', async () => {
    pratica().stato = 'approvata'
    const res = await rifiuta(MOTIVO)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PRATICA_GIA_EVASA')
    expect(pratica().stato, 'un rifiuto ha sovrascritto un’approvazione').toBe('approvata')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('si rifiuta anche una presa in carico rimasta appesa (`in_approvazione`)', async () => {
    pratica().stato = 'in_approvazione'
    const res = await rifiuta()
    expect(res.status).toBe(200)
    expect(pratica().stato).toBe('rifiutata')
  })

  it('`motivo_rifiuto` assente sul database: 200 con l’avviso, non un 500 muto', async () => {
    // Il DB E2E della CI non è migrato: la colonna cade, il rifiuto si registra lo
    // stesso e l'audit NON dichiara presente una nota che non è stata scritta da
    // nessuna parte — altrimenti fra mesi qualcuno la cercherebbe in tabella.
    h.state.colonneAssenti = { pratiche_personale: ['motivo_rifiuto'] }
    const res = await rifiuta(MOTIVO)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Il codice, non la frase: dal 2026-08-12 gli avvisi viaggiano come
    // `{ codice, parametri }` e la prosa la sceglie il catalogo del client.
    const avvisi = (body.warnings ?? []) as { codice: string; parametri?: Record<string, unknown> }[]
    expect(avvisi.map((a) => a.codice)).toEqual(['rifiutoParziale'])
    expect(JSON.stringify(avvisi[0].parametri)).toContain('motivo_rifiuto')
    expect(pratica().stato).toBe('rifiutata')
    const dopo = (h.logScrittura.mock.calls[0][1] as Record<string, unknown>).valoreDopo as Record<string, unknown>
    expect(dopo.motivo_presente).toBe(false)
  })

  it('scrittura FALLITA: 503 con codice, e la pratica resta dov’era', async () => {
    h.state.erroriTabella = { pratiche_personale: { code: '08006', message: 'connection failure' } }
    const res = await rifiuta(MOTIVO)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    expect(String(body.error)).not.toMatch(/connection failure/i)
  })
})
