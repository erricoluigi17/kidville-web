import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// Modulo mensa — le quattro mutazioni «per solo id» e il giro allergie manuale.
//
// R44: `menu-config` PATCH/DELETE, `class-assignments` DELETE e `menu` DELETE
// filtravano SOLO per `id`. `requireStaff` verifica il RUOLO, non il TENANT, e
// queste route girano in service-role (che scavalca la RLS): con l'uuid in mano
// si modificava e si cancellava la configurazione mensa di un altro plesso.
// Peggio nella DELETE di `menu-config`: i conteggi di rotazioni/override che
// decidono il 409 giravano su righe di UN'ALTRA SEDE — la risposta stessa era
// un oracolo sui dati altrui.
//
// R86: il giro allergie lanciato a mano (`canale: 'manuale'`, gate `requireStaff`)
// non aveva scope: leggeva le prenotazioni di TUTTE le sedi, restituiva contatori
// aggregati e faceva partire notifiche verso lo staff di plessi non propri. Il
// ramo cron resta globale — un job DEVE iterare su tutte le sedi.
//
// Regola dei test d'isolamento (piano §3): mai `not.toBe(403)`. Si asserisce lo
// stato ESATTO e l'EFFETTO sul database (`h.db` dopo la chiamata, l'accumulatore
// `h.scritture`, e `h.tabelle` per provare che dopo un 403 non si è letto nulla).
// =============================================================================

const CFG_A = 'c0c0c0c0-0000-4000-8000-cccccccccccc'
const CFG_B = 'c1c1c1c1-1111-4111-8111-cccccccccccc'
const CFG_ALTRO = 'c2c2c2c2-2222-4222-8222-cccccccccccc'
const ASS_A = '5a5a5a5a-0000-4000-8000-aaaaaaaaaaaa'
const ASS_B = '5b5b5b5b-1111-4111-8111-bbbbbbbbbbbb'
const ASS_ALTRA = '5c5c5c5c-2222-4222-8222-cccccccccccc'
const OVR_A = '0f0f0f0f-0000-4000-8000-ffffffffffff'
const OVR_B = '0e0e0e0e-1111-4111-8111-ffffffffffff'
const OVR_ORFANO = '0d0d0d0d-2222-4222-8222-ffffffffffff'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const SEG_A = '22222222-2222-4222-8222-222222222222'
const SEGRETO = 'segreto-di-collaudo'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  // `vi.fn()` nudo (non `vi.fn(async () => false)`): serve poter leggere gli
  // ARGOMENTI delle chiamate — quale alunno è stato controllato — e una firma
  // senza parametri renderebbe `mock.calls` una tupla vuota.
  controllaAllergie: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  // Errore PostgREST iniettato per tabella: è il solo modo di provare il ramo
  // `23505 → 409` senza un Postgres vero (il finto client non applica i vincoli).
  errori: {} as Record<string, { code: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireUser,
  requireDocente: h.requireStaff,
  requireParent: h.requireUser,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = async () =>
    creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as never, errori: h.errori })
  return { createAdminClient: crea, createClient: crea }
})
// Dipendenze non pertinenti all'isolamento, neutralizzate perché l'import dei
// moduli sotto test non trascini mezza applicazione.
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({}),
  loadResolveOptions: async () => ({}),
  resolveMenuConfigId: async () => null,
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuRange: () => [] }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: async () => true }))
vi.mock('@/lib/mensa/allergie-check', () => ({ controllaAllergie: h.controllaAllergie }))

import { POST as CFG_POST, PATCH as CFG_PATCH, DELETE as CFG_DELETE } from '@/app/api/mensa/menu-config/route'
import { PUT as ASS_PUT, DELETE as ASS_DELETE } from '@/app/api/mensa/class-assignments/route'
import { DELETE as MENU_DELETE } from '@/app/api/mensa/menu/route'
import { POST as ALLERGIE_POST } from '@/app/api/mensa/allergie-check/route'

interface Opzioni {
  method?: string
  body?: unknown
  /** Valore del cookie `sedi_attive` (la selezione del SedeSelector). */
  sedi?: string
  cron?: boolean
}

const req = (url: string, o: Opzioni = {}) => {
  const headers: Record<string, string> = {}
  if (o.body) headers['content-type'] = 'application/json'
  if (o.sedi) headers.cookie = `sedi_attive=${o.sedi}`
  if (o.cron) headers['x-cron-secret'] = SEGRETO
  return new NextRequest(`http://localhost${url}`, {
    method: o.method ?? 'GET',
    headers,
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  })
}

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  // Stesso NOME nelle due sedi: dal 2026-07-29 il nome non è più una chiave.
  mensa_menu_config: [
    { id: CFG_A, scuola_id: SEDE_A, nome: 'Standard', ordine: 0 },
    { id: CFG_B, scuola_id: SEDE_B, nome: 'Standard', ordine: 0 },
  ],
  mensa_class_menu_assignment: [
    { id: ASS_A, scuola_id: SEDE_A, classe: '2 ANNI', menu_config_id: CFG_A, attivo_dal: '2026-01-01' },
    { id: ASS_B, scuola_id: SEDE_B, classe: '2 ANNI', menu_config_id: CFG_B, attivo_dal: '2026-01-01' },
  ],
  // Solo il menu della sede B ha una rotazione collegata: è ciò che oggi fa
  // rispondere 409 a chi non avrebbe nemmeno dovuto vedere quel menu.
  mensa_menu_rotazione: [
    { id: 'rot-b', scuola_id: SEDE_B, menu_config_id: CFG_B, settimana: 1, giorno_settimana: 1 },
  ],
  mensa_menu_override: [
    { id: OVR_A, scuola_id: SEDE_A, menu_config_id: null, data: '2026-07-10' },
    { id: OVR_B, scuola_id: SEDE_B, menu_config_id: null, data: '2026-07-10' },
    // Riga senza sede: non è attribuibile a nessun plesso ⇒ nessuno la tocca.
    { id: OVR_ORFANO, scuola_id: null, menu_config_id: null, data: '2026-07-11' },
  ],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: '2 ANNI', section_id: 'sec-a', scuola_id: SEDE_A, allergies: null, allergeni: null },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: '2 ANNI', section_id: 'sec-b', scuola_id: SEDE_B, allergies: null, allergeni: null },
  ],
  mensa_prenotazioni: [
    { id: 'pren-a', alunno_id: ALU_A, scuola_id: SEDE_A, data: '2026-07-10', stato: 'prenotato' },
    { id: 'pren-b', alunno_id: ALU_B, scuola_id: SEDE_B, data: '2026-07-10', stato: 'prenotato' },
  ],
})

/** Le scritture registrate dal finto client, nella forma che serve alle asserzioni. */
const scritture = () => h.scritture as Scrittura[]

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  vi.stubEnv('CRON_SECRET', SEGRETO)
  const segreteriaA = { user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } }
  h.requireStaff.mockResolvedValue(segreteriaA)
  h.requireUser.mockResolvedValue(segreteriaA)
  h.controllaAllergie.mockResolvedValue(false)
})

describe('mensa/menu-config PATCH — la configurazione di un altro plesso non si modifica', () => {
  it('403 sul menu della sede B, e il nome resta quello di prima', async () => {
    const res = await CFG_PATCH(req('/api/mensa/menu-config', { method: 'PATCH', body: { id: CFG_B, nome: 'manomesso' } }))
    expect(res.status).toBe(403)
    expect(h.db.mensa_menu_config.find((c) => c.id === CFG_B)?.nome).toBe('Standard')
    // Il 403 da solo non basta: nessuna UPDATE dev'essere partita.
    expect(scritture()).toEqual([])
  })

  it('200 sul menu della PROPRIA sede, e il nome cambia davvero', async () => {
    const res = await CFG_PATCH(req('/api/mensa/menu-config', { method: 'PATCH', body: { id: CFG_A, nome: 'Senza glutine' } }))
    expect(res.status).toBe(200)
    expect(h.db.mensa_menu_config.find((c) => c.id === CFG_A)?.nome).toBe('Senza glutine')
    expect(h.db.mensa_menu_config.find((c) => c.id === CFG_B)?.nome).toBe('Standard')
  })

  it('404 su un id inesistente (e nessuna scrittura)', async () => {
    const res = await CFG_PATCH(req('/api/mensa/menu-config', { method: 'PATCH', body: { id: '99999999-9999-4999-8999-999999999999', nome: 'x' } }))
    expect(res.status).toBe(404)
    expect(scritture()).toEqual([])
  })

  it('scope VUOTO (cookie su una sede non propria) ⇒ 403, mai «nessun filtro»', async () => {
    const res = await CFG_PATCH(req('/api/mensa/menu-config', { method: 'PATCH', body: { id: CFG_A, nome: 'manomesso' }, sedi: SEDE_C }))
    expect(res.status).toBe(403)
    expect(h.db.mensa_menu_config.find((c) => c.id === CFG_A)?.nome).toBe('Standard')
  })
})

describe('mensa/menu-config DELETE — lo scope PRECEDE i conteggi', () => {
  it('403 sul menu della sede B — e i conteggi di rotazione/override non vengono nemmeno eseguiti', async () => {
    const res = await CFG_DELETE(req(`/api/mensa/menu-config?id=${CFG_B}`, { method: 'DELETE' }))
    // 403, non 409: il 409 sarebbe la risposta calcolata sulle rotazioni di
    // un'altra sede, cioè un oracolo sui dati altrui.
    expect(res.status).toBe(403)
    expect(h.db.mensa_menu_config.map((c) => c.id)).toEqual([CFG_A, CFG_B])
    expect(h.tabelle).not.toContain('mensa_menu_rotazione')
    expect(h.tabelle).not.toContain('mensa_menu_override')
    expect(scritture()).toEqual([])
  })

  it('200 sul menu della propria sede senza collegamenti: la riga sparisce davvero', async () => {
    const res = await CFG_DELETE(req(`/api/mensa/menu-config?id=${CFG_A}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.db.mensa_menu_config.map((c) => c.id)).toEqual([CFG_B])
  })

  it('409 sul menu della propria sede CON rotazioni collegate: la riga resta', async () => {
    h.db.mensa_menu_rotazione.push({ id: 'rot-a', scuola_id: SEDE_A, menu_config_id: CFG_A, settimana: 1, giorno_settimana: 1 })
    const res = await CFG_DELETE(req(`/api/mensa/menu-config?id=${CFG_A}`, { method: 'DELETE' }))
    expect(res.status).toBe(409)
    expect(h.db.mensa_menu_config.map((c) => c.id)).toEqual([CFG_A, CFG_B])
  })
})

describe('mensa/class-assignments DELETE — l\'assegnazione classe→menu di un altro plesso resta', () => {
  it('403 sull\'assegnazione della sede B, riga intatta', async () => {
    const res = await ASS_DELETE(req(`/api/mensa/class-assignments?id=${ASS_B}`, { method: 'DELETE' }))
    expect(res.status).toBe(403)
    expect(h.db.mensa_class_menu_assignment.map((a) => a.id)).toEqual([ASS_A, ASS_B])
    expect(scritture()).toEqual([])
  })

  it('200 sull\'assegnazione della propria sede: la riga sparisce davvero', async () => {
    const res = await ASS_DELETE(req(`/api/mensa/class-assignments?id=${ASS_A}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.db.mensa_class_menu_assignment.map((a) => a.id)).toEqual([ASS_B])
  })
})

// =============================================================================
// I due effetti collaterali della migrazione `mensa_unique_per_sede`, che questo
// step spedisce insieme al codice. Prima dell'indice UNIQUE un duplicato non era
// un errore: si creava, e `resolveMenuConfigId` (ORDER BY attivo_dal DESC
// LIMIT 1) sceglieva a caso quale menu — e quindi quali allergeni — valesse per
// quel giorno. Da adesso il DB rifiuta con `23505`, e il codice deve saperlo
// gestire in ENTRAMBI i punti in cui può capitare.
// =============================================================================
describe('mensa/menu-config POST — il duplicato è un 409 leggibile, non un 500 anonimo', () => {
  it('23505 dal DB ⇒ 409 con messaggio, non «Internal Server Error»', async () => {
    h.errori.mensa_menu_config = { code: '23505' }
    const res = await CFG_POST(
      req('/api/mensa/menu-config', { method: 'POST', body: { scuola_id: SEDE_A, nome: 'Standard' } }),
    )
    expect(res.status).toBe(409)
    const corpo = (await res.json()) as { error: string }
    expect(corpo.error).toContain('Esiste già un menu con questo nome in questa sede')
  })
})

describe('mensa/class-assignments PUT — un rifiuto non deve cancellare ciò che c\'era', () => {
  // Il PUT è «sostituisci l'elenco»: cancella le assegnazioni del menu e le
  // riscrive. Con l'indice UNIQUE (scuola_id, classe, attivo_dal) l'INSERT può
  // ora fallire — e la DELETE che l'ha preceduto non torna indietro. Esito: il
  // menu resta con ZERO classi assegnate, i bambini ricadono sul menu legacy
  // della sede, cioè su ALTRI allergeni. Il conflitto va visto PRIMA di toccare
  // qualunque riga.
  it('409 se una classe è già assegnata a un ALTRO menu da quella data, e nulla viene toccato', async () => {
    h.db.mensa_class_menu_assignment = [
      // Assegnazione corrente del menu che stiamo modificando: la DELETE la toglierebbe.
      { id: ASS_A, scuola_id: SEDE_A, classe: '2 ANNI', menu_config_id: CFG_A, attivo_dal: '2026-09-01' },
      // La riga che genera il conflitto: stessa classe/data, menu diverso.
      { id: ASS_ALTRA, scuola_id: SEDE_A, classe: '3 ANNI', menu_config_id: CFG_ALTRO, attivo_dal: '2026-09-01' },
    ]
    const res = await ASS_PUT(
      req('/api/mensa/class-assignments', {
        method: 'PUT',
        body: { scuola_id: SEDE_A, menu_config_id: CFG_A, classi: ['2 ANNI', '3 ANNI'], attivo_dal: '2026-09-01' },
      }),
    )
    expect(res.status).toBe(409)
    // L'asserzione che conta: il database è esattamente com'era.
    expect(h.db.mensa_class_menu_assignment.map((a) => a.id)).toEqual([ASS_A, ASS_ALTRA])
    expect(scritture()).toEqual([])
  })

  it('200 quando non c\'è conflitto: sostituisce davvero l\'elenco', async () => {
    h.db.mensa_class_menu_assignment = [
      { id: ASS_A, scuola_id: SEDE_A, classe: '2 ANNI', menu_config_id: CFG_A, attivo_dal: '2026-09-01' },
      // Stessa classe e stessa data, ma di un'ALTRA sede: non è un conflitto.
      { id: ASS_B, scuola_id: SEDE_B, classe: '3 ANNI', menu_config_id: CFG_B, attivo_dal: '2026-09-01' },
    ]
    const res = await ASS_PUT(
      req('/api/mensa/class-assignments', {
        method: 'PUT',
        body: { scuola_id: SEDE_A, menu_config_id: CFG_A, classi: ['3 ANNI'], attivo_dal: '2026-09-01' },
      }),
    )
    expect(res.status).toBe(200)
    const rimaste = h.db.mensa_class_menu_assignment
    // La vecchia riga di SEDE_A («2 ANNI») è sparita, la nuova c'è, e quella di
    // SEDE_B — stessa classe, stessa data — non è stata sfiorata.
    expect(rimaste).toHaveLength(2)
    expect(rimaste.find((a) => a.id === ASS_A)).toBeUndefined()
    expect(rimaste.find((a) => a.id === ASS_B)).toMatchObject({ scuola_id: SEDE_B, menu_config_id: CFG_B })
    expect(rimaste.filter((a) => a.scuola_id === SEDE_A)).toMatchObject([
      { classe: '3 ANNI', menu_config_id: CFG_A, attivo_dal: '2026-09-01' },
    ])
  })
})

describe('mensa/menu DELETE — l\'override del giorno è quello che porta gli allergeni', () => {
  it('403 sull\'override della sede B, riga intatta', async () => {
    const res = await MENU_DELETE(req(`/api/mensa/menu?override_id=${OVR_B}`, { method: 'DELETE' }))
    expect(res.status).toBe(403)
    expect(h.db.mensa_menu_override.map((o) => o.id)).toEqual([OVR_A, OVR_B, OVR_ORFANO])
    expect(scritture()).toEqual([])
  })

  it('403 sull\'override SENZA sede: una riga non attribuibile non è di nessuno', async () => {
    const res = await MENU_DELETE(req(`/api/mensa/menu?override_id=${OVR_ORFANO}`, { method: 'DELETE' }))
    expect(res.status).toBe(403)
    expect(h.db.mensa_menu_override.map((o) => o.id)).toEqual([OVR_A, OVR_B, OVR_ORFANO])
  })

  it('200 sull\'override della propria sede: la riga sparisce davvero', async () => {
    const res = await MENU_DELETE(req(`/api/mensa/menu?override_id=${OVR_A}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.db.mensa_menu_override.map((o) => o.id)).toEqual([OVR_B, OVR_ORFANO])
  })
})

describe('mensa/allergie-check — il giro a mano è dell\'operatore, il giro notturno è del sistema', () => {
  it('manuale: la segreteria della sede A elabora SOLO la sede A', async () => {
    const res = await ALLERGIE_POST(req('/api/mensa/allergie-check?data=2026-07-10', { method: 'POST' }))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: { prenotati: number; alert: number } }
    // Nel database ci sono DUE prenotati, uno per sede. L'operatore di Aversa
    // non deve nemmeno sapere quanti bambini pranzano a Giugliano.
    expect(corpo.data.prenotati).toBe(1)
    const alunniControllati = h.controllaAllergie.mock.calls.map((c) => (c[1] as { id: string }).id)
    expect(alunniControllati).toEqual([ALU_A])
  })

  it('manuale con scope VUOTO: 403, e gli alunni non vengono nemmeno letti', async () => {
    const res = await ALLERGIE_POST(req('/api/mensa/allergie-check?data=2026-07-10', { method: 'POST', sedi: SEDE_C }))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('alunni')
    expect(h.controllaAllergie).not.toHaveBeenCalled()
  })

  it('cron: resta globale — è il suo lavoro iterare su tutte le sedi', async () => {
    const res = await ALLERGIE_POST(req('/api/mensa/allergie-check?data=2026-07-10', { method: 'POST', cron: true }))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: { prenotati: number } }
    expect(corpo.data.prenotati).toBe(2)
    const alunniControllati = h.controllaAllergie.mock.calls.map((c) => (c[1] as { id: string }).id)
    expect(alunniControllati).toEqual([ALU_A, ALU_B])
  })
})
