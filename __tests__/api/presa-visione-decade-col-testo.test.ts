/**
 * Q5 — RICOMUNICARE CON UN MOTIVO DIVERSO NON AZZERAVA LA PRESA VISIONE.
 *
 * La riga continuava a risultare «letta dal docente» mentre il testo che il
 * docente aveva letto era stato sostituito. La causa è meccanica e misurabile:
 * `comunica-assenza` non nomina `giust_vista_il`/`giust_vista_da` in nessuno dei
 * suoi due payload, e **PostgREST aggiorna solo le colonne nominate** — la
 * colonna sopravvive a ogni scrittura. La rotta gemella (`giustifica`) faceva
 * l'opposto e lo dichiarava in un commento: la stessa regola scritta a mano in
 * una sola delle due strade.
 *
 * La finestra è reale: `primaria/presenze/giust-vista:POST` NON scrive
 * `registrato_da`, quindi il docente può prendere visione senza aver ancora
 * salvato l'appello, e finché `registrato_da` è nullo il genitore può ancora
 * sovrascrivere il motivo (l'UPDATE condizionato passa).
 *
 * Qui si misura ciò che finisce nel PAYLOAD di scrittura, che è l'unica cosa che
 * decide: il finto client applica davvero filtri e scritture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { resetRateLimit } from '@/lib/security/rate-limit'

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const MAESTRA = 'd1111111-1111-4111-8111-111111111111'
const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const DOMANI = '2026-08-11'
const VISTA_IL = '2026-08-10T08:30:00.000Z'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
  // Tipizzata coi due argomenti veri: senza, `mock.calls[0][1]` è una tupla
  // vuota per TypeScript e le asserzioni sul `debounce` non compilerebbero.
  notificaEvento: vi.fn<(client: unknown, opzioni: Record<string, unknown>) => Promise<void>>(),
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
const logSpia = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => logSpia)

// La rotta gemella porta appesa una firma elettronica: qui interessa solo che
// scriva la stessa colonna, quindi OTP, ledger e audit sono doppi.
const otp = vi.hoisted(() => ({
  getUserEmail: vi.fn(async () => 'genitore@example.it'),
  verifyTicket: vi.fn(() => ({ ok: true })),
  codeHash: vi.fn(() => 'SHA256-FINTO'),
}))
vi.mock('@/lib/auth/otp-ticket', () => otp)
vi.mock('@/lib/security/otp-rate-limit', () => ({ limitaVerificaOtp: vi.fn(async () => null) }))
vi.mock('@/lib/fea/slots', () => ({ recordSignerSlot: vi.fn() }))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => ({
  getModuleConfig: vi.fn(async () => ({
    giustifica_max_giorni_retroattivi: 5,
    giustifica_richiede_firma_otp: true,
  })),
}))

let db: DBFinto
let scritture: Scrittura[]
let client: ReturnType<typeof creaFintoSupabase>

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => client }))

import { POST } from '@/app/api/parent/presenze/comunica-assenza/route'
import { POST as Giustifica } from '@/app/api/parent/presenze/giustifica/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** La riga comunicata dalla famiglia e GIÀ presa in visione dal docente. */
function rigaPresaInVisione(motivo: string | null = 'visita di controllo') {
  db.presenze = [
    {
      id: 'p-1',
      alunno_id: STUDENT,
      scuola_id: SCUOLA,
      section_id: SEZIONE,
      data: DOMANI,
      stato: 'assente',
      giustificata: true,
      giustificata_da: PARENT,
      giustificazione_testo: motivo,
      giust_vista_il: VISTA_IL,
      giust_vista_da: MAESTRA,
      registrato_da: null,
    },
  ]
}

/** Il payload dell'UPDATE su `presenze` (l'unica cosa che decide). */
const patchDiAggiornamento = () =>
  scritture
    .filter((s) => s.tabella === 'presenze' && s.operazione === 'update')
    .flatMap((s) => s.valori)

const rigaInTabella = () => db.presenze[0] ?? {}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  resetRateLimit()
  db = {
    alunni: [{ id: STUDENT, nome: 'Sofia', cognome: 'Rossi', section_id: SEZIONE, scuola_id: SCUOLA }],
    sections: [{ id: SEZIONE, school_type: 'primaria', scuola_id: SCUOLA }],
    utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZIONE }],
    utenti: [{ id: MAESTRA, attivo: true }],
    admin_settings: [],
    presenze: [],
    notifiche: [],
  }
  scritture = []
  client = creaFintoSupabase(db, [], { scritture })
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.assertGenitore.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Q5 — il testo cambia: la presa visione del docente decade', () => {
  it('motivo DIVERSO: le due colonne vengono azzerate nella stessa scrittura', async () => {
    rigaPresaInVisione()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre alta' }))
    expect(res.status).toBe(201)
    expect(patchDiAggiornamento()[0]).toMatchObject({ giust_vista_il: null, giust_vista_da: null })
    expect(rigaInTabella().giust_vista_il, 'la colonna non nominata sopravvive: è tutto il meccanismo').toBeNull()
    expect(rigaInTabella().giust_vista_da).toBeNull()
  })

  it('e il docente lo viene a sapere: la notifica NON si lascia collassare dal debounce', async () => {
    // Azzerare in silenzio sposterebbe soltanto il difetto: il docente aveva
    // letto, e non lo sa più nessuno. Con `debounce: true` la notifica sulla
    // stessa riga collassa, quindi la revoca resterebbe muta.
    rigaPresaInVisione()
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre alta' }))
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ debounce: false })
  })

  it('motivo INVARIATO: la presa visione resta — non si toglie una lettura legittima', async () => {
    rigaPresaInVisione('visita di controllo')
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita di controllo' }))
    expect(res.status).toBe(201)
    expect(patchDiAggiornamento()[0]).not.toHaveProperty('giust_vista_il')
    expect(rigaInTabella().giust_vista_il).toBe(VISTA_IL)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ debounce: true })
  })

  it('motivo VUOTO: la colonna del testo non si scrive, quindi non si invalida niente', async () => {
    // Il vuoto non cancella (rilievo M21): l'UPDATE non nomina
    // `giustificazione_testo`. Se non si scrive niente, non si invalida niente.
    rigaPresaInVisione('visita di controllo')
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: '' }))
    expect(res.status).toBe(201)
    expect(rigaInTabella().giustificazione_testo).toBe('visita di controllo')
    expect(rigaInTabella().giust_vista_il).toBe(VISTA_IL)
  })

  it('nessuna presa visione da togliere: niente notifica fuori debounce', async () => {
    rigaPresaInVisione('visita di controllo')
    db.presenze[0].giust_vista_il = null
    db.presenze[0].giust_vista_da = null
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre alta' }))
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ debounce: true })
  })

  it('prima comunicazione (INSERT): non c’è nessuna lettura da revocare', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre' }))
    expect(res.status).toBe(201)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ debounce: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA STESSA REGOLA SULLA PORTA GEMELLA.
//
// `giustifica` azzerava SEMPRE, e lo dichiarava. È il verso giusto ma non la
// regola giusta: una firma ripetuta con lo STESSO testo faceva perdere al
// docente una presa visione legittima, e lo faceva senza chiedere niente a
// nessuno. Ora le due strade leggono la stessa funzione.
// ─────────────────────────────────────────────────────────────────────────────
const giustificaReq = (motivo: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/giustifica', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ studentId: STUDENT, data: DOMANI, motivo, code: '424242', expiry: 999, ticket: 't' }),
  })

describe('Q5 — la porta gemella (`giustifica`) segue la stessa regola', () => {
  it('motivo DIVERSO: la presa visione decade', async () => {
    rigaPresaInVisione('visita di controllo')
    const res = await Giustifica(giustificaReq('febbre alta'))
    expect(res.status).toBe(200)
    expect(rigaInTabella().giust_vista_il).toBeNull()
    expect(rigaInTabella().giust_vista_da).toBeNull()
  })

  it('motivo INVARIATO: la presa visione RESTA (era il difetto opposto, e c’era)', async () => {
    rigaPresaInVisione('visita di controllo')
    const res = await Giustifica(giustificaReq('visita di controllo'))
    expect(res.status).toBe(200)
    expect(
      rigaInTabella().giust_vista_il,
      'firmare di nuovo lo stesso testo non cancella una lettura che il docente ha davvero fatto',
    ).toBe(VISTA_IL)
  })

  it('motivo VUOTO: la colonna del testo non si scrive, quindi non si invalida niente', async () => {
    rigaPresaInVisione('visita di controllo')
    const res = await Giustifica(giustificaReq(''))
    expect(res.status).toBe(200)
    expect(rigaInTabella().giustificazione_testo).toBe('visita di controllo')
    expect(rigaInTabella().giust_vista_il).toBe(VISTA_IL)
  })

  it('testo precedente ILLEGGIBILE: si azzera lo stesso, e non in silenzio', async () => {
    // PostgREST non lancia: senza controllo il guasto uscirebbe come «nessun
    // testo prima», cioè come «è cambiato» — stessa conseguenza, ma per caso e
    // senza una riga che lo dica. Il degrado è quello PRUDENTE: una presa
    // visione tenuta in piedi per errore afferma il falso su chi ha letto che
    // cosa; una tolta per errore costa al docente una rilettura.
    rigaPresaInVisione('visita di controllo')
    client = creaFintoSupabase(db, [], { scritture, errori: { presenze: { code: '42703' } } })
    const res = await Giustifica(giustificaReq('visita di controllo'))
    // L'UPDATE fallisce anch'esso (il finto client sbaglia tutta la tabella):
    // qui interessa che la LETTURA fallita non passi muta.
    expect(res.status).toBe(500)
    expect(logSpia.logEvento.mock.calls.some((c) => JSON.stringify(c).includes('testo-precedente-non-letto'))).toBe(true)
  })
})
