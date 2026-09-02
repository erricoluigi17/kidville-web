import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// I LOG DI QUESTA ROUTE NON PORTANO DATI PERSONALI — e qui pesa più che altrove.
//
// `app_log` è interrogabile in SQL per 30 giorni e la leggono persone diverse da
// quelle che hanno titolo di aprire una pratica. Ciò che passa da questa route è:
// codice fiscale, nome e cognome, email, numero del documento d'identità, residenza,
// il recapito di un TERZO (il contatto d'emergenza, che non ha ricevuto nessuna
// informativa) e il PERCORSO della scansione — che è l'indirizzo, dentro un bucket
// privato, della fotografia di una carta d'identità.
//
// ── PERCHÉ SI MISURA COSÌ, e non fidandosi di `redact` ───────────────────────
// `redact` è a lista bianca per CHIAVE, quindi protegge finché nessuno aggiunge una
// chiave nuova «perché sarebbe comodo vederla». Questa prova guarda l'ALTRO lato: che
// cosa questa route CONSEGNA al logger. Se domani qualcuno mettesse `email` dentro un
// `logEvento`, la difesa dipenderebbe interamente dalla lista bianca — e la lista
// bianca è un file che si modifica.
//
// ── E ANCHE: il `msg` in chiaro ─────────────────────────────────────────────
// La chiave `msg` finisce IN CHIARO nella colonna `app_log.messaggio` (è così che si
// legge il nome di una colonna caduta nel degrado). È esattamente il posto in cui un
// percorso o un'email passerebbero senza che nessuna redazione li tocchi, quindi
// questa prova lo esamina come tutto il resto.
// =============================================================================

const SEGRETERIA = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_ID = 'dddddddd-0000-4000-8000-00000000000a'

/** I valori che NON devono comparire da nessuna parte nei log. */
const SEGRETI = {
  email: 'maestra.riservata@example.test',
  nome: 'Riservata',
  cognome: 'Cognome',
  codiceFiscale: 'RSSMRA90A41H501U',
  documento: 'AB1234567',
  indirizzo: 'Via Riservata',
  emergenza: 'Persona Terza',
  telefono: '+39 333 1234567',
  // ⚠️ LA FORMA CANONICA, `documenti/<uuid>/<uuid>.<ext>`. Qui c'era
  // `documenti/aaaa/carta-identita.jpg`, e da quando `assertDocumentoInScope` ha un
  // gate di FORMA quel valore non arriva più alla risoluzione: verrebbe respinto
  // prima, e le due prove sull'accesso alla scansione — quella che firma e quella del
  // diniego cross-sede — misurerebbero un ramo che non è quello che dichiarano. Un
  // percorso di prova che il prodotto non potrebbe produrre rende verdi le asserzioni
  // sbagliate.
  percorso: 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jpg',
  // La SECONDA faccia. Non è un doppione del segreto precedente: il percorso del retro
  // passa per rami diversi — il travaso nel fascicolo, il rilascio nella chiusura, il
  // conteggio del registro dei caricamenti — e una prova che ne guarda uno solo
  // lascerebbe scoperti proprio quelli aggiunti per ultimi.
  percorsoRetro: 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jpg',
}

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

import { GET, PATCH } from '@/app/api/admin/pratiche-personale/route'

const url = (qs = '') => new NextRequest(`http://localhost/api/admin/pratiche-personale${qs}`)
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/pratiche-personale', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Tutto ciò che la route ha consegnato ai logger, in una stringa sola. */
function tuttiILog(): string {
  return JSON.stringify([
    ...h.logEvento.mock.calls,
    ...h.logErrore.mock.calls,
    ...h.logOk.mock.calls,
    ...h.logScrittura.mock.calls,
  ], (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v))
}

function nessunSegretoNeiLog() {
  const log = tuttiILog()
  for (const [nome, valore] of Object.entries(SEGRETI)) {
    expect(log, `nei log è finito «${nome}»`).not.toContain(valore)
  }
}

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
      nome: SEGRETI.nome, cognome: SEGRETI.cognome, email: SEGRETI.email,
      telefono: SEGRETI.telefono, fiscal_code: SEGRETI.codiceFiscale,
      document_type: 'CI', document_number: SEGRETI.documento, document_expiry: '2030-01-01',
      address: SEGRETI.indirizzo, residence_city: 'Comune', residence_province: 'NA', zip_code: '80014',
      emergenza_nome: SEGRETI.emergenza, emergenza_telefono: SEGRETI.telefono,
      // LE COLONNE DI OGGI, E SOLO QUELLE (migrazione `20260812194501`).
      //
      // Qui c'era anche `documento_path: SEGRETI.percorso`, con un commento che diceva
      // «resta nella riga finta perché il gate di `?doc=` la interroga ancora». Non è
      // più vero, ed era la cosa peggiore che potesse restare scritta: il gate adesso
      // itera `CAMPI_DOCUMENTO` (`route.ts`, `assertDocumentoInScope`), e su
      // `pratiche_personale` quella colonna NON esiste più — misurato su produzione,
      // `information_schema.columns` restituisce solo `documento_fronte_path` e
      // `documento_retro_path`. Una riga finta più ricca del database tiene in vita una
      // query rotta e manda il prossimo lettore a cercare un gate che non c'è.
      documento_fronte_path: SEGRETI.percorso,
      documento_retro_path: SEGRETI.percorsoRetro,
      gradi: ['nido'], creata_il: '2026-08-11T08:00:00.000Z',
    }],
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti: [], parents: [], anagrafica_personale: [],
    caricamenti_personale: [
      { percorso: SEGRETI.percorso, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
      { percorso: SEGRETI.percorsoRetro, pratica_id: PRATICA_ID, anagrafica_utente_id: null },
    ],
  }
  h.staffScuola.mockResolvedValue(['direzione-1'])
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireStaff.mockImplementation(async () => ({ user: SEGRETERIA }))
})

describe('pratiche personale · nessun dato personale nei log', () => {
  it('percorso felice completo (elenco → dettaglio → documento → approva)', async () => {
    await GET(url())
    await GET(url(`?id=${PRATICA_ID}`))
    await GET(url(`?doc=${encodeURIComponent(SEGRETI.percorso)}`))
    const res = await PATCH(patch({ id: PRATICA_ID, action: 'approva' }))
    expect(res.status).toBe(200)
    nessunSegretoNeiLog()
  })

  it('l’accesso al documento LASCIA una riga — ma con uuid, non col percorso', async () => {
    await GET(url(`?doc=${encodeURIComponent(SEGRETI.percorso)}`))
    // Il registro degli accessi riusciti serve: da qui esce la copia di un documento
    // d'identità, e l'interessata ha diritto di sapere chi l'ha letta. Senza questa
    // riga, «nessun log» non distinguerebbe «nessuno ha guardato» da «la sorveglianza
    // non è mai partita».
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'documento-firmato',
    )
    expect(riga, 'nessuna traccia dell’accesso alla scansione').toBeTruthy()
    expect(riga![0]).toBe('multi_sede')
    const dati = riga![2] as Record<string, unknown>
    expect(dati.utente).toBe(SEGRETERIA.id)
    expect(dati.entita_id).toBe(PRATICA_ID)
    nessunSegretoNeiLog()
  })

  it('il DINIEGO cross-sede lascia una riga, e nemmeno lì compare il percorso', async () => {
    h.scuole = [SEDE_A]
    const res = await GET(url(`?doc=${encodeURIComponent(SEGRETI.percorso)}`))
    expect(res.status).toBe(403)
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'documento-fuori-sede',
    )
    expect(riga, 'un tentativo cross-sede non lascia traccia').toBeTruthy()
    nessunSegretoNeiLog()
  })

  it('i rami d’ERRORE non usano il messaggio del database come scorciatoia', async () => {
    // Il `message` di PostgREST è prosa inglese che su un `23505` porta dentro il
    // VALORE che ha violato la chiave — cioè l'email di una persona vera.
    h.state.erroriTabella = {
      pratiche_personale: { code: '23505', message: `duplicate key value violates unique constraint: ${SEGRETI.email}` },
    }
    await GET(url())
    await PATCH(patch({ id: PRATICA_ID, action: 'rifiuta', motivo: 'nota interna' }))
    // Il messaggio grezzo viaggia come CAUSA (ultimo argomento), che è dove deve
    // stare: quello che questa prova vieta è che finisca nei CAMPI della riga.
    for (const chiamata of h.logEvento.mock.calls) {
      expect(JSON.stringify(chiamata[2] ?? {})).not.toContain(SEGRETI.email)
    }
  })

  it('il MOTIVO del rifiuto è una nota interna: non entra nei log né nell’audit', async () => {
    const motivo = 'Sospetto che il documento consegnato non sia il suo'
    await PATCH(patch({ id: PRATICA_ID, action: 'rifiuta', motivo }))
    expect(tuttiILog()).not.toContain(motivo)
    nessunSegretoNeiLog()
  })

  it('lo SPOSTAMENTO di sede lascia le due sedi, mai la persona', async () => {
    await PATCH(patch({ id: PRATICA_ID, action: 'sposta-sede', scuola_id: SEDE_A }))
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'pratica-spostata',
    )
    expect(riga, 'uno spostamento fra plessi non lascia traccia').toBeTruthy()
    expect(riga![0]).toBe('multi_sede')
    nessunSegretoNeiLog()
  })

  it('il DINIEGO «account di un altro plesso» non nomina la persona, né nei log né a schermo', async () => {
    // Il gate nuovo del 2026-08-12 nega l'approvazione quando l'email combacia con un
    // account fuori scope. È un ramo che TOCCA `utenti`, cioè la tabella con nome,
    // cognome ed email: la riga di log lo dice con uuid e conteggi, e la risposta HTTP
    // non ripete l'indirizzo che ha fatto scattare il diniego — chi legge il messaggio
    // ce l'ha già davanti, chi legge i log no.
    h.state.authUsers = [{ id: 'auth-esistente', email: SEGRETI.email }]
    h.state.tabelle.utenti = [{
      id: 'auth-esistente', email: SEGRETI.email, ruolo: 'educator',
      scuola_id: 'cccccccc-0000-4000-8000-0000000000ff',
      nome: SEGRETI.nome, cognome: SEGRETI.cognome,
    }]
    const res = await PATCH(patch({ id: PRATICA_ID, action: 'approva' }))
    expect(res.status).toBe(403)
    const corpo = JSON.stringify(await res.json())
    for (const [campo, valore] of Object.entries(SEGRETI)) {
      expect(corpo, `la risposta del diniego contiene «${campo}»`).not.toContain(valore)
    }
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'account-fuori-sede-non-approvato',
    )
    expect(riga, 'un diniego cross-plesso non lascia traccia').toBeTruthy()
    expect(riga![0]).toBe('multi_sede')
    nessunSegretoNeiLog()
  })

  it('il BATTITO dell’approvazione conta, e non racconta', async () => {
    await PATCH(patch({ id: PRATICA_ID, action: 'approva' }))
    const battito = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'pratica-approvata',
    )
    expect(battito, 'nessun battito sul percorso felice: «nessun log» non distinguerebbe ' +
      '«non si approva nessuno» da «l’approvazione non parte più»').toBeTruthy()
    expect(battito![0]).toBe('personale')
    expect(battito![1]).toBe('info')
    const dati = battito![2] as Record<string, unknown>
    // Numeri, booleani e uuid: le sole cose che rispondono a una domanda senza aprire
    // una riga.
    expect(dati.n_gradi).toBe(1)
    expect(dati.account_creato).toBe(true)
    // Una voce per faccia: il battito dice QUALE scansione è passata al fascicolo, e
    // «una sola» è uno stato che va potuto interrogare in SQL. Qui la pratica porta
    // ENTRAMBE le facce, e le rilascia entrambe.
    expect(dati.documento_fronte_rilasciato).toBe(true)
    expect(dati.documento_retro_rilasciato).toBe(true)
    // …quindi la pratica NON è rimasta a metà. Il campo esiste per la query che, fra
    // mesi, conta le approvazioni che hanno travasato una faccia sola: qui si tiene
    // ferma la sua risposta negativa, che è quella che deve valere sul caso normale —
    // un campo di diagnosi sempre vero smette di distinguere qualcosa.
    expect(dati.documento_rilasciato_a_meta).toBe(false)
    expect(dati.sede_id).toBe(SEDE_B)
    nessunSegretoNeiLog()
  })
})
