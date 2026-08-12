import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// L'ISOLAMENTO FRA SEDI, e in particolare LA SCANSIONE DEL DOCUMENTO D'IDENTITÀ.
//
// ── IL DIFETTO CHE QUESTO FILE IMPEDISCE ─────────────────────────────────────
// Una URL firmata è scaricabile SENZA sessione: chi ce l'ha, ha il file. Produrla e
// POI rispondere 403 è una fuga con un altro nome — è il difetto misurato in
// produzione il 2026-07-31 sui documenti d'identità dei bambini, e qui l'oggetto è la
// fotografia della carta d'identità di una dipendente. Perciò la prova non guarda lo
// STATUS della risposta: guarda che `createSignedUrl` non sia stata chiamata AFFATTO.
//
// ── LE ALTRE COSE CHE TIENE FERME ────────────────────────────────────────────
//  · elenco e dettaglio portano il filtro di sede NELLA STESSA query;
//  · «non esiste» e «è di un'altra sede» escono dalla stessa porta, con la stessa
//    frase: distinguerle direbbe a chi non ha titolo di vederla che quella pratica c'è,
//    e da lì escono codice fiscale, residenza ed estremi del documento;
//  · un GUASTO dello storage DOPO il gate è 503, non 403: un guasto non si veste da
//    diniego, o la Segreteria va a cercare un problema di permessi che non c'è;
//  · la firma dura 300 secondi e non 600. Un curriculum e una carta d'identità non
//    valgono lo stesso, e una durata che nessuno misura torna al valore di prima al
//    primo copincolla;
//  · scope VUOTO ⇒ elenco vuoto, non «tutto»: `.in()` incondizionato.
// =============================================================================

const OPERATORE = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_A = 'dddddddd-0000-4000-8000-00000000000a'
const PRATICA_B = 'dddddddd-0000-4000-8000-00000000000b'
const DOC_A = 'documenti/aaaa/mia.jpg'
const DOC_B = 'documenti/bbbb/altrui.jpg'

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
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => costruisciClient(h.state as unknown as StatoFinto),
  createClient: async () => costruisciClient(h.state as unknown as StatoFinto),
}))

import { GET, PATCH } from '@/app/api/admin/pratiche-personale/route'

const url = (qs = '') => new NextRequest(`http://localhost/api/admin/pratiche-personale${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.scuole = [SEDE_A]
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], erroriTabella: {}, colonneAssenti: {},
    erroreStorage: null, urlFirmate: [],
  })
  h.state.tabelle = {
    pratiche_personale: [
      {
        id: PRATICA_A, scuola_id: SEDE_A, stato: 'pending', nome: 'Mia', cognome: 'Collega',
        email: 'mia@example.test', fiscal_code: 'RSSMRA90A41H501U', documento_path: DOC_A,
        document_expiry: '2030-01-01', gradi: ['nido'], creata_il: '2026-08-11T08:00:00.000Z',
      },
      {
        id: PRATICA_B, scuola_id: SEDE_B, stato: 'pending', nome: 'Altra', cognome: 'Sede',
        email: 'altra@example.test', fiscal_code: 'VRDLGU85M01F839X', documento_path: DOC_B,
        document_expiry: '2029-01-01', gradi: ['infanzia'], creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    utenti: [], parents: [], anagrafica_personale: [],
  }
  h.requireStaff.mockImplementation(async () => ({ user: OPERATORE }))
})

describe('pratiche personale · isolamento fra sedi', () => {
  it('l’ELENCO mostra solo le pratiche delle sedi attive, e resta POVERO', async () => {
    const res = await GET(url())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(PRATICA_A)
    expect(body.total).toBe(1)

    // L'elenco NON porta codice fiscale, email, residenza né il percorso della
    // scansione: è la lezione di «Moduli ricevuti», dove il payload completo di ogni
    // domanda partiva verso il browser di ogni membro dello staff a ogni apertura.
    const riga = body.data[0] as Record<string, unknown>
    expect(Object.keys(riga).sort()).toEqual(
      ['cognome', 'creata_il', 'document_expiry', 'id', 'nome', 'scuola_id', 'stato'],
    )
  })

  it('scope VUOTO ⇒ elenco vuoto, non «tutto»', async () => {
    h.scuole = []
    const res = await GET(url())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('il DETTAGLIO di un’altra sede: 404 con la STESSA frase di «non esiste»', async () => {
    const fuori = await GET(url(`?id=${PRATICA_B}`))
    expect(fuori.status).toBe(404)
    const corpoFuori = await fuori.json()
    expect(corpoFuori.codice).toBe('PRATICA_NON_TROVATA')

    const inesistente = await GET(url('?id=11111111-1111-4111-8111-111111111111'))
    expect(inesistente.status).toBe(404)
    const corpoInesistente = await inesistente.json()
    // La stessa frase: distinguerle sarebbe un oracolo su chi lavora dove.
    expect(corpoFuori.error).toBe(corpoInesistente.error)
  })

  it('il DETTAGLIO della PROPRIA sede si apre, e porta i campi che servono a decidere', async () => {
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const dati = (await res.json()).data as Record<string, unknown>
    expect(dati.fiscal_code).toBe('RSSMRA90A41H501U')
    expect(dati.documento_path).toBe(DOC_A)
  })

  it('🔴 `?doc=` di un’ALTRA sede: 403 e `createSignedUrl` MAI chiamata', async () => {
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_B)}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('PRATICA_NON_TROVATA')
    // LA PROVA VERA: non lo status, ma il fatto che la firma non sia mai stata
    // prodotta. Una URL firmata vive di vita propria: emetterla e poi negare l'accesso
    // è una fuga con un altro nome.
    expect(h.state.urlFirmate, 'una URL firmata è stata prodotta prima del diniego').toEqual([])
  })

  it('`?doc=` di un percorso INVENTATO: stesso 403, stessa frase, nessuna firma', async () => {
    const res = await GET(url('?doc=documenti/xxxx/inventato.pdf'))
    expect(res.status).toBe(403)
    expect(h.state.urlFirmate).toEqual([])
  })

  it('`?doc=` della PROPRIA sede: firma da 300 secondi, non 600', async () => {
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(200)
    expect(typeof (await res.json()).url).toBe('string')
    expect(h.state.urlFirmate).toHaveLength(1)
    expect(h.state.urlFirmate[0].path).toBe(DOC_A)
    expect(
      h.state.urlFirmate[0].secondi,
      'la durata della firma su una carta d’identità è tornata a quella di un curriculum',
    ).toBe(300)
  })

  it('🔴 storage in ERRORE DOPO il gate: 503, non 403 — un guasto non si veste da diniego', async () => {
    h.state.erroreStorage = { message: 'Object not found in bucket documenti_personale' }
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    // Il messaggio grezzo non torna al client: contiene il percorso dell'oggetto.
    expect(String(body.error)).not.toContain('documenti_personale')
    expect(String(body.error)).not.toContain(DOC_A)
  })

  it('lettura fallita durante il gate del documento: fail-CLOSED, e nessuna firma', async () => {
    h.state.erroriTabella = { pratiche_personale: { code: '08006', message: 'connection failure' } }
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(503)
    expect(h.state.urlFirmate, 'non sapere di chi è un documento non può voler dire consegnarlo').toEqual([])
  })

  it('la PATCH su una pratica di un’altra sede: 404, e nessuna scrittura', async () => {
    const res = await PATCH(new NextRequest('http://localhost/api/admin/pratiche-personale', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PRATICA_B, action: 'approva' }),
    }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRATICA_NON_TROVATA')
    expect(h.state.aggiornamenti).toEqual([])
    expect(h.state.creazioniAuth).toEqual([])
  })

  it('il DETTAGLIO dice se quell’email ha già un account, e con che ruolo', async () => {
    /**
     * La route lo sapeva già — `risolviAccountEsistente` gira prima del claim — e lo
     * buttava in un campo di log. Il riquadro di conferma non poteva dirlo, quindi non
     * lo diceva: chi premeva «Approva» non sapeva che stava per riscrivere il profilo
     * e il fascicolo di una persona che esiste, né con quale ruolo o sede.
     * `/anagrafica-personale` è pubblico e ANONIMO: chiunque può mandare una pratica
     * con l'email di una collega o della Direzione.
     */
    h.state.tabelle.utenti = [
      { id: 'u-1', email: 'mia@example.test', ruolo: 'admin', scuola_id: SEDE_A },
    ]
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account).toMatchObject({ esiste: true, ruolo: 'admin', sede_gestita: true })
    expect(body.account.sede_nome).toBe('Kidville Alfa')
    // …e NON esce l'uuid dell'account: qui si risponde a una domanda su QUESTA pratica,
    // non si apre una finestra sull'anagrafica del personale.
    expect(JSON.stringify(body.account)).not.toContain('u-1')
  })

  it('l’account è in un plesso FUORI scope: si dice che c’è, ma il ruolo NON esce', async () => {
    // La decisione lì è già presa — il gate del punto 5 negherà l'approvazione — e il
    // ruolo di una persona di un altro plesso non serve a prenderla.
    h.state.tabelle.utenti = [
      { id: 'u-2', email: 'mia@example.test', ruolo: 'admin', scuola_id: SEDE_B },
    ]
    const body = await (await GET(url(`?id=${PRATICA_A}`))).json()
    expect(body.account).toEqual({ esiste: true, ruolo: null, sede_gestita: false, sede_nome: null })
  })

  it('nessun account con quell’email: `esiste: false`, che NON è `null`', async () => {
    const body = await (await GET(url(`?id=${PRATICA_A}`))).json()
    expect(body.account.esiste).toBe(false)
  })

  it('la verifica dell’account NON riesce: `esiste: null`, e il dettaglio si apre lo stesso', async () => {
    // Tre stati e non due. `false` direbbe «non c'è» su una domanda a cui non si è
    // risposto, ed è esattamente l'errore che il fail-closed della PATCH esiste per
    // evitare — qui però la lettura della pratica è riuscita, quindi il dettaglio non
    // si nega: si dichiara ciò che non si sa.
    h.state.erroriTabella = { utenti: { code: '08006', message: 'connection failure' } }
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.fiscal_code).toBe('RSSMRA90A41H501U')
    expect(body.account.esiste).toBeNull()
  })

  it('la TABELLA assente non si degrada in «non è arrivato niente»: 503 dichiarato', async () => {
    // Un elenco vuoto sarebbe una risposta, e sarebbe falsa: la Segreteria
    // concluderebbe che non ha compilato nessuno.
    h.state.erroriTabella = { pratiche_personale: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await GET(url())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
  })
})
