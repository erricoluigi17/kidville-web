import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// I CALL SITE di `requireParentOfStudent`, sul dato vero di un minore.
//
// Il collaudo di sicurezza del 2026-07-31 ha misurato in produzione:
//
//   GET /api/diary/entries?alunno_id=<minore iscritto a GIUGLIANO>
//   Cookie: sessione di un educator di AVERSA        → 200 + diario completo
//   GET /api/parent/primaria/assenze?studentId=…      → 200 + giustificazione_testo
//
// su cinque minori e sette attori (docenti e segreterie di altre sedi, e la
// CUOCA). L'unico 403 arrivava all'altro genitore.
//
// Qui si mette a contratto la chiusura, con tre pretese:
//  · la NEGAZIONE non si misura sullo status: si misura sul CORPO. Un 403 che
//    porta comunque il dato non è una correzione;
//  · accanto a ogni negazione c'è il CONTROLLO POSITIVO — un gate che nega a
//    tutti supererebbe un test fatto di soli 403;
//  · sulle cinque SCRITTURE non basta lo status: si verifica che nel database
//    non sia finita nessuna riga. Per la firma FES della giustifica è il punto
//    centrale: un 403 con la firma comunque apposta sarebbe un falso verde su un
//    atto con valore legale.
//
// `requireParentOfStudent` e `assertAlunnoInScope` NON sono mockati: sono ciò
// che si sta verificando. Il finto client applica davvero i filtri e registra
// davvero le scritture.
// =============================================================================

const GIUGLIANO = 'a1a1a1a1-0000-4000-8000-00000000000a'
const AVERSA = 'b2b2b2b2-0000-4000-8000-00000000000b'
const MINORE = 'c3c3c3c3-1111-4111-8111-cccccccccccc'   // iscritto a Giugliano
const OGGI = new Date().toISOString().slice(0, 10)

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  requireKitchenRead: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  getGenitoriDiAlunno: vi.fn(),
  getGenitoriDiAlunni: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  nomeUtente: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  getUserEmail: vi.fn(),
  verifyTicket: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/require-staff')>()
  return {
    ...reale,
    requireUser: h.requireUser,
    requireDocente: h.requireDocente,
    requireKitchenRead: h.requireKitchenRead,
  }
})
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: h.genitoreHasFiglio,
  getGenitoriDiAlunno: h.getGenitoriDiAlunno,
  getGenitoriDiAlunni: h.getGenitoriDiAlunni,
  getFigliDiGenitore: h.getFigliDiGenitore,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: h.notificaEvento,
  nomeUtente: h.nomeUtente,
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: h.assertGenitoreNonSospeso,
}))
// `verifyTicket` mockato SOLO per poter arrivare oltre l'OTP nel controllo
// positivo: nei casi di diniego la route non ci arriva nemmeno, ed è il punto.
vi.mock('@/lib/auth/otp-ticket', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/otp-ticket')>()
  return { ...reale, getUserEmail: h.getUserEmail, verifyTicket: h.verifyTicket }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // `rpc: {}` non è una dimenticanza: senza implementazione il finto client
  // LANCIA. È la prova che nessuna RPC viene invocata sui rami negati.
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, rpc: {} }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, rpc: {} }),
  }
})

import { GET as diarioGET } from '@/app/api/diary/entries/route'
import { GET as assenzeGET } from '@/app/api/parent/primaria/assenze/route'
import { POST as giustificaPOST } from '@/app/api/parent/presenze/giustifica/route'
import { POST as pagellaFirmaPOST } from '@/app/api/parent/primaria/pagella/firma/route'
import { POST as comunicaAssenzaPOST } from '@/app/api/parent/presenze/comunica-assenza/route'
import { POST as giustDidatticaPOST } from '@/app/api/parent/giustifiche-didattiche/route'
import { POST as inventoryPOST } from '@/app/api/locker/inventory/route'

// ── Attori ───────────────────────────────────────────────────────────────────
const comeUtente = (id: string, role: string, scuola_id: string | null) =>
  h.requireUser.mockResolvedValue({ user: { id, role, scuola_id } })

const EDUCATOR_AVERSA = () => comeUtente('ed-aversa', 'educator', AVERSA)
const EDUCATOR_GIUGLIANO = () => comeUtente('ed-giugliano', 'educator', GIUGLIANO)
const SEGRETERIA_AVERSA = () => comeUtente('seg-aversa', 'segreteria', AVERSA)
const CUOCA = () => comeUtente('cuoca-1', 'cuoca', AVERSA)
const GENITORE = () => {
  comeUtente('gen-1', 'genitore', null)
  h.genitoreHasFiglio.mockResolvedValue(true)
}

// ── Il database ──────────────────────────────────────────────────────────────
// `creato_il` vecchio di un anno: il buffer di visibilità del diario (10') non
// deve nascondere le voci al controllo positivo.
const VECCHIO = new Date(Date.now() - 365 * 86_400_000).toISOString()

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-giugliano', scuola_id: GIUGLIANO, name: '2 ANNI', school_type: 'primaria' },
    { id: 'sec-aversa', scuola_id: AVERSA, name: '2 ANNI', school_type: 'primaria' },
  ],
  utenti_sezioni: [
    { utente_id: 'ed-giugliano', section_id: 'sec-giugliano' },
    { utente_id: 'ed-aversa', section_id: 'sec-aversa' },
  ],
  utenti_scuole: [],
  alunni: [
    {
      id: MINORE, nome: 'Bambino', cognome: 'Collaudo',
      section_id: 'sec-giugliano', scuola_id: GIUGLIANO,
      usa_pannolino: false, allergeni: null, allergies: null,
    },
  ],
  admin_settings: [{ scuola_id: GIUGLIANO, diario_config: {}, presenze_config: {} }],
  eventi_diario: [
    {
      id: 'ev-1', alunno_id: MINORE, tipo_evento: 'bagno',
      orario_inizio: `${OGGI}T09:00:00.000Z`, creato_il: VECCHIO,
      dettagli: 'DETTAGLIO-RISERVATO', nota_libera: null, nota_bambino: 'NOTA-DEL-BAMBINO',
    },
  ],
  presenze: [
    {
      id: 'pr-1', alunno_id: MINORE, section_id: 'sec-giugliano', data: OGGI,
      stato: 'assente', giustificata: false,
      giustificazione_testo: 'RICOVERO-OSPEDALIERO',
      orario_entrata: null, orario_uscita: null, giustificata_il: null, note_appello: null,
    },
  ],
  scrutini: [{ id: 'scr-1', section_id: 'sec-giugliano', pubblicato: true, stato: 'chiuso' }],
  pagella_ricezioni: [],
  giustifiche_didattiche: [],
  armadietto: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.genitoreHasFiglio.mockResolvedValue(false)
  h.getGenitoriDiAlunno.mockResolvedValue([])
  h.getGenitoriDiAlunni.mockResolvedValue(new Map())
  h.getFigliDiGenitore.mockResolvedValue([MINORE])
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
  h.getUserEmail.mockResolvedValue('genitore@example.invalid')
  h.verifyTicket.mockReturnValue({ ok: true })
  h.notificaEvento.mockResolvedValue(undefined)
  h.logScrittura.mockResolvedValue(undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// LETTURE
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/diary/entries?alunno_id= — il diario di un minore', () => {
  const chiama = () =>
    diarioGET(new NextRequest(`http://localhost/api/diary/entries?alunno_id=${MINORE}`))

  it('educator di AVERSA su un minore di GIUGLIANO: 403 e nel corpo non esce NIENTE del bambino', async () => {
    EDUCATOR_AVERSA()
    const res = await chiama()
    expect(res.status).toBe(403)
    const corpo = await res.text()
    expect(corpo).not.toContain('DETTAGLIO-RISERVATO')
    expect(corpo).not.toContain('NOTA-DEL-BAMBINO')
    expect(corpo).not.toContain('bagno')
    // Il diario non è stato nemmeno letto: un 403 emesso DOPO la lettura non
    // sarebbe una correzione, sarebbe una tenda.
    expect(h.tabelle).not.toContain('eventi_diario')
  })

  it('cuoca: 403 e corpo senza dati del bambino', async () => {
    CUOCA()
    const res = await chiama()
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('DETTAGLIO-RISERVATO')
    expect(h.tabelle).not.toContain('eventi_diario')
  })

  it('segreteria di AVERSA: 403 (vede tutte le CLASSI della sua sede, non le altre SEDI)', async () => {
    SEGRETERIA_AVERSA()
    const res = await chiama()
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('DETTAGLIO-RISERVATO')
  })

  it('CONTROLLO POSITIVO: l\'educator della sezione del bambino continua a vedere il diario', async () => {
    EDUCATOR_GIUGLIANO()
    const res = await chiama()
    expect(res.status).toBe(200)
    const voci = (await res.json()) as { dettagli?: string }[]
    expect(voci).toHaveLength(1)
    expect(voci[0].dettagli).toBe('DETTAGLIO-RISERVATO')
  })

  it('CONTROLLO POSITIVO: il genitore vede il diario del proprio figlio', async () => {
    GENITORE()
    const res = await chiama()
    expect(res.status).toBe(200)
    expect((await res.json())).toHaveLength(1)
  })
})

describe('GET /api/parent/primaria/assenze — dato sanitario in chiaro', () => {
  const chiama = () =>
    assenzeGET(new NextRequest(`http://localhost/api/parent/primaria/assenze?studentId=${MINORE}`))

  it('educator di AVERSA: 403 e `giustificazione_testo` NON esce', async () => {
    EDUCATOR_AVERSA()
    const res = await chiama()
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('RICOVERO-OSPEDALIERO')
    expect(h.tabelle).not.toContain('presenze')
  })

  it('CONTROLLO POSITIVO: il genitore legge le assenze del figlio, giustificazione compresa', async () => {
    GENITORE()
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('RICOVERO-OSPEDALIERO')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCRITTURE — non basta il 403: la riga non deve esistere
// ─────────────────────────────────────────────────────────────────────────────

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('SCRITTURA 1/5 — POST /api/parent/presenze/giustifica (firma FES, valore legale)', () => {
  const corpo = { studentId: MINORE, data: OGGI, motivo: 'MOTIVO-INVENTATO', code: '123456', expiry: Date.now() + 60_000, ticket: 'x' }

  it('educator di AVERSA: 403, e sulla presenza NON compare nessuna firma', async () => {
    EDUCATOR_AVERSA()
    const res = await giustificaPOST(post('/api/parent/presenze/giustifica', corpo))
    expect(res.status).toBe(403)
    // La prova che conta su un atto con valore legale: nessuna scrittura, e la
    // riga di presenza è rimasta esattamente com'era.
    expect(h.scritture).toEqual([])
    const presenza = h.db.presenze[0]
    expect(presenza.giustificata).toBe(false)
    expect(presenza.giustificazione_firma).toBeUndefined()
    expect(presenza.giustificata_da).toBeUndefined()
    expect(presenza.giustificazione_testo).toBe('RICOVERO-OSPEDALIERO')
  })

  it('CONTROLLO POSITIVO: il genitore giustifica davvero il proprio figlio', async () => {
    GENITORE()
    const res = await giustificaPOST(post('/api/parent/presenze/giustifica', corpo))
    expect(res.status).toBe(200)
    expect(h.db.presenze[0].giustificata).toBe(true)
    expect(h.db.presenze[0].giustificata_da).toBe('gen-1')
  })
})

describe('SCRITTURA 2/5 — POST /api/parent/primaria/pagella/firma (presa visione FES)', () => {
  const corpo = { scrutinioId: 'scr-1', studentId: MINORE, code: '123456', expiry: Date.now() + 60_000, ticket: 'x' }

  it('segreteria di AVERSA: 403 e nessuna ricezione firmata', async () => {
    SEGRETERIA_AVERSA()
    const res = await pagellaFirmaPOST(post('/api/parent/primaria/pagella/firma', corpo))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(h.db.pagella_ricezioni).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: il genitore firma la ricezione', async () => {
    GENITORE()
    const res = await pagellaFirmaPOST(post('/api/parent/primaria/pagella/firma', corpo))
    expect(res.status).toBe(200)
    expect(h.db.pagella_ricezioni).toHaveLength(1)
    expect(h.db.pagella_ricezioni[0].genitore_id).toBe('gen-1')
  })
})

describe('SCRITTURA 3/5 — POST /api/parent/presenze/comunica-assenza', () => {
  // La data era `'2026-12-01'`, cioè un futuro CHE SCADE: dal 2026-12-02 la
  // route l'avrebbe rifiutata con 400 `ASSENZA_DATA_PASSATA` (dal 2026-08-07 la
  // comunicazione d'assenza si accetta solo da oggi in avanti, fuso
  // Europe/Rome) e il CONTROLLO POSITIVO qui sotto sarebbe diventato rosso senza
  // che nessuno avesse toccato niente — il modo peggiore di rompersi, perché la
  // causa non è in nessun diff.
  //
  // Un mese avanti, calcolato: sempre futuro, e sempre DIVERSO dal giorno della
  // riga `pr-1` del fixture — che è `OGGI`, e con `onConflict: 'alunno_id,data'`
  // verrebbe aggiornata invece di aggiungerne una seconda (misurato: il test
  // chiede due righe e ne troverebbe una).
  const FRA_UN_MESE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  const corpo = { studentId: MINORE, data: FRA_UN_MESE, motivo: 'INVENTATO' }

  it('cuoca: 403 e nessuna presenza creata', async () => {
    CUOCA()
    const res = await comunicaAssenzaPOST(post('/api/parent/presenze/comunica-assenza', corpo))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(h.db.presenze).toHaveLength(1) // solo quella del fixture
  })

  it('CONTROLLO POSITIVO: il genitore comunica l\'assenza del figlio', async () => {
    GENITORE()
    const res = await comunicaAssenzaPOST(post('/api/parent/presenze/comunica-assenza', corpo))
    expect(res.status).toBe(201)
    expect(h.db.presenze).toHaveLength(2)
  })
})

describe('SCRITTURA 4/5 — POST /api/parent/giustifiche-didattiche', () => {
  const corpo = { studentId: MINORE, data: OGGI, motivo: 'INVENTATO' }

  it('educator di AVERSA: 403 e nessuna giustifica didattica inserita', async () => {
    EDUCATOR_AVERSA()
    const res = await giustDidatticaPOST(post('/api/parent/giustifiche-didattiche', corpo))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(h.db.giustifiche_didattiche).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: il genitore dichiara il figlio impreparato', async () => {
    GENITORE()
    const res = await giustDidatticaPOST(post('/api/parent/giustifiche-didattiche', corpo))
    expect(res.status).toBe(201)
    expect(h.db.giustifiche_didattiche).toHaveLength(1)
  })
})

describe('SCRITTURA 5/5 — POST /api/locker/inventory (carico armadietto)', () => {
  const corpo = { alunno_id: MINORE, materiale: 'Pannolini', quantita: 3 }

  it('educator di AVERSA: 403 e nessuna riga di armadietto', async () => {
    EDUCATOR_AVERSA()
    const res = await inventoryPOST(post('/api/locker/inventory', corpo))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(h.db.armadietto).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: il genitore registra il carico, con la sede del bambino', async () => {
    GENITORE()
    const res = await inventoryPOST(post('/api/locker/inventory', corpo))
    expect(res.status).toBe(200)
    expect(h.db.armadietto).toHaveLength(1)
    expect(h.db.armadietto[0].scuola_id).toBe(GIUGLIANO)
  })

  it('CONTROLLO POSITIVO: l\'educator della sezione può registrare il carico', async () => {
    EDUCATOR_GIUGLIANO()
    const res = await inventoryPOST(post('/api/locker/inventory', corpo))
    expect(res.status).toBe(200)
    expect(h.db.armadietto).toHaveLength(1)
  })
})
