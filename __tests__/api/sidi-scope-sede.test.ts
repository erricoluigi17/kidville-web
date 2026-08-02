import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import JSZip from 'jszip'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// X2 — Le tre route SIDI che non dichiaravano la sede (audit 2026-07-31).
//
// Il SIDI è l'anagrafe ministeriale. Qui non si sbaglia «una lista»: si sbaglia
// il plesso in cui nasce un bambino reale, e si spedisce al Ministero l'elenco
// di un'altra sede sotto il codice meccanografico di questa.
//
// Quattro difetti, una sola causa: la sede non veniva mai dichiarata, e dove
// c'era veniva usata solo per metà.
//  1. `frequentanti`, `import` e `piattaforma-unica` chiamavano
//     `resolveScuolaScrittura` SENZA `preferita` e senza avere un canale per
//     riceverla: dal 2026-07-31 (W2-A) quella funzione risponde davvero 400
//     quando l'utente ha più sedi — cioè l'intera sezione SIDI era diventata
//     irraggiungibile per l'unico admin reale, che di sedi ne ha tre.
//  2. `import:GET` elencava i batch di TUTTE le sedi (nome del file compreso).
//  3. `import:PATCH` applicava un batch preso per solo id: il coordinatore di
//     una sede poteva riversare l'anagrafe di un'altra nel proprio plesso.
//  4. `piattaforma-unica` leggeva `student_parents` senza nessun filtro di
//     sede: al Ministero partivano i legami genitore↔figlio di tutte e tre.
//
// Il finto client filtra e scrive DAVVERO: ogni caso asserisce lo stato esatto,
// il contenuto trasmesso e ciò che è finito (o non è finito) in tabella.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_COORD_A = 'd0000000-0000-4000-8000-0000000000c0'

const SEZ_A = '5ec00000-0000-4000-8000-00000000000a'
const SEZ_B = '5ec00000-0000-4000-8000-00000000000b'
const AL_A = 'a1000000-0000-4000-8000-00000000000a'
const AL_B = 'a1000000-0000-4000-8000-00000000000b'
const PAR_A = 'ba000000-0000-4000-8000-00000000000a'
const PAR_B = 'ba000000-0000-4000-8000-00000000000b'
const BATCH_A = 'ba7c0000-0000-4000-8000-00000000000a'
const BATCH_B = 'ba7c0000-0000-4000-8000-00000000000b'

// Codici fiscali inventati (repository pubblico: mai PII reali).
const CF_ALUNNO_A = 'AAAALF10A01H501A'
const CF_ALUNNO_B = 'BBBBET10B02H501B'
const CF_GEN_A = 'AAAADA80A41H501G'
const CF_GEN_B = 'BBBBRA80B42H501G'
const CF_NUOVO = 'CCCCAM20C03H501N'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, ErrorePostgrest>,
  trasmissioni: [] as { flusso: string; xml: string }[],
  esito: { ok: true, ricevuta: 'RIC-1' } as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }),
  }
})
// L'egress ministeriale è gated (503 finché non accreditati): senza questo
// doppio non si potrebbe mai osservare COSA sarebbe partito.
vi.mock('@/lib/sidi/client', () => ({
  sidiTransmit: async (_config: unknown, flusso: string, xml: string) => {
    h.trasmissioni.push({ flusso, xml })
    return h.esito
  },
}))

import { POST as FREQUENTANTI } from '@/app/api/admin/sidi/frequentanti/route'
import { POST as PIATTAFORMA } from '@/app/api/admin/sidi/piattaforma-unica/route'
import { GET as IMPORT_GET, POST as IMPORT_POST, PATCH as IMPORT_PATCH } from '@/app/api/admin/sidi/import/route'

// ─── Fixture ─────────────────────────────────────────────────────────────────

const legame = (alunno: Riga, parentId: string, cfParent: string, relazione: string): Riga => ({
  student_id: alunno.id,
  parent_id: parentId,
  relation_type: relazione,
  validato_sidi: true,
  // Il finto client non costruisce i join: l'oggetto annidato lo mette il fixture.
  alunni: { codice_fiscale: alunno.codice_fiscale, scuola_id: alunno.scuola_id },
  parents: { fiscal_code: cfParent },
})

const alunnoA: Riga = {
  id: AL_A, scuola_id: SEDE_A, section_id: SEZ_A, codice_fiscale: CF_ALUNNO_A,
  nome: 'Anna', cognome: 'Alfa', stato: 'iscritto', numero_domanda_sidi: null,
}
const alunnoB: Riga = {
  id: AL_B, scuola_id: SEDE_B, section_id: SEZ_B, codice_fiscale: CF_ALUNNO_B,
  nome: 'Bruno', cognome: 'Beta', stato: 'iscritto', numero_domanda_sidi: null,
}

const dbBase = (): DBFinto => ({
  // La Direzione è multi-plesso via il ponte: sede primaria A, più B.
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  sections: [
    { id: SEZ_A, name: '2 ANNI', school_type: 'infanzia', scuola_id: SEDE_A },
    { id: SEZ_B, name: '2 ANNI', school_type: 'infanzia', scuola_id: SEDE_B },
  ],
  alunni: [{ ...alunnoA }, { ...alunnoB }],
  parents: [
    { id: PAR_A, fiscal_code: CF_GEN_A, first_name: 'Ada', last_name: 'Alfa' },
    { id: PAR_B, fiscal_code: CF_GEN_B, first_name: 'Bruna', last_name: 'Beta' },
  ],
  student_parents: [
    legame(alunnoA, PAR_A, CF_GEN_A, 'madre'),
    legame(alunnoB, PAR_B, CF_GEN_B, 'madre'),
  ],
  admin_settings: [
    { scuola_id: SEDE_A, sidi_config: { abilitato: true } },
    { scuola_id: SEDE_B, sidi_config: { abilitato: true } },
  ],
  sidi_sync_state: [],
  sidi_import_batches: [],
  audit_scritture_docente: [],
})

const statoSede = (scuolaId: string, stati: Record<string, string>): Riga => ({
  scuola_id: scuolaId,
  fase_a_stato: 'non_inviato',
  frequentanti_stato: 'non_inviato',
  piattaforma_unica_stato: 'non_inviato',
  ...stati,
})

const batch = (id: string, scuolaId: string, records: unknown[]): Riga => ({
  id,
  scuola_id: scuolaId,
  filename: `domande-${scuolaId.slice(0, 4)}.zip`,
  stato: 'parsed',
  totale_record: records.length,
  matched: 0,
  creati: 0,
  parsed_payload: records,
  warnings: [],
})

const domanda = (numero: string, cfAlunno: string, extra: Record<string, unknown> = {}) => ({
  numero_domanda: numero,
  alunno: { nome: 'Carla', cognome: 'Gamma', codice_fiscale: cfAlunno, data_nascita: '2023-03-03' },
  genitori: [{ codice_fiscale: CF_GEN_A, nome: 'Ada', cognome: 'Alfa', relazione: 'madre' }],
  ...extra,
})

// ─── Richieste ───────────────────────────────────────────────────────────────

function cookieDi(valore?: string) {
  return {
    get: (nome: string) =>
      nome === 'sedi_attive' && valore !== undefined ? { name: nome, value: valore } : undefined,
  }
}

function req(url: string, metodo: string, extra: Record<string, unknown> = {}, cookie?: string): NextRequest {
  return {
    url,
    method: metodo,
    headers: new Headers({ 'content-type': 'application/json' }),
    cookies: cookieDi(cookie),
    ...extra,
  } as unknown as NextRequest
}

async function zipDomande(): Promise<{ name: string; arrayBuffer: () => Promise<ArrayBuffer> }> {
  const zip = new JSZip()
  zip.file('domande.csv', `NUMERO_DOMANDA,ALUNNO_NOME,ALUNNO_CF\n777,Carla,${CF_NUOVO}`)
  const b = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  return { name: 'domande_sidi.zip', arrayBuffer: async () => ab }
}

async function reqUpload(scuolaId?: string, cookie?: string): Promise<NextRequest> {
  const file = await zipDomande()
  return req('http://localhost/api/admin/sidi/import', 'POST', {
    formData: async () => ({
      get: (k: string) => (k === 'file' ? file : k === 'scuola_id' ? scuolaId ?? null : null),
    }),
  }, cookie)
}

const reqPatch = (body: Record<string, unknown>, cookie?: string) =>
  req('http://localhost/api/admin/sidi/import', 'PATCH', { json: async () => body }, cookie)

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)
const alunnoDb = (id: string) => (h.db.alunni ?? []).find((a) => a.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.trasmissioni = []
  h.esito = { ok: true, ricevuta: 'RIC-1' }
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

const comeCoordinatoreA = () =>
  h.requireStaff.mockResolvedValue({ user: { id: ID_COORD_A, role: 'coordinator', scuola_id: SEDE_A } })

// ─── POST /api/admin/sidi/import ─────────────────────────────────────────────

describe('POST /api/admin/sidi/import — lo ZIP ministeriale dichiara la sua sede', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400 e NIENTE in staging', async () => {
    const res = await IMPORT_POST(await reqUpload())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(scrittureSu('sidi_import_batches')).toEqual([])
    expect(h.db.sidi_import_batches).toEqual([])
  })

  it('`scuola_id` dichiarato ⇒ il batch nasce in QUELLA sede', async () => {
    const res = await IMPORT_POST(await reqUpload(SEDE_B))

    expect(res.status).toBe(200)
    expect((await res.json()).totale).toBe(1)
    const righe = scrittureSu('sidi_import_batches')
    expect(righe).toHaveLength(1)
    expect(righe[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, stato: 'parsed', totale_record: 1 })
    expect(h.db.sidi_import_batches).toHaveLength(1)
    expect(h.db.sidi_import_batches[0].scuola_id).toBe(SEDE_B)
  })

  it('SedeSelector su una sola sede ⇒ batch in quella sede', async () => {
    const res = await IMPORT_POST(await reqUpload(undefined, SEDE_B))

    expect(res.status).toBe(200)
    expect(scrittureSu('sidi_import_batches')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('utente con UNA sola sede ⇒ invariato: batch nella sua', async () => {
    comeCoordinatoreA()
    const res = await IMPORT_POST(await reqUpload())

    expect(res.status).toBe(200)
    expect(scrittureSu('sidi_import_batches')[0].valori[0]).toMatchObject({ scuola_id: SEDE_A })
  })
})

// ─── GET /api/admin/sidi/import ──────────────────────────────────────────────

describe('GET /api/admin/sidi/import — l\'elenco dei batch è della propria sede', () => {
  beforeEach(() => {
    h.db.sidi_import_batches = [batch(BATCH_A, SEDE_A, []), batch(BATCH_B, SEDE_B, [])]
  })

  it('il coordinatore di SEDE_A non vede i batch di SEDE_B', async () => {
    comeCoordinatoreA()
    const res = await IMPORT_GET(req('http://localhost/api/admin/sidi/import', 'GET'))

    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.map((b: Riga) => b.id)).toEqual([BATCH_A])
  })

  it('l\'admin col SedeSelector su SEDE_B vede solo i batch di SEDE_B', async () => {
    const res = await IMPORT_GET(req('http://localhost/api/admin/sidi/import', 'GET', {}, SEDE_B))

    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.map((b: Riga) => b.id)).toEqual([BATCH_B])
  })
})

// ─── PATCH /api/admin/sidi/import ────────────────────────────────────────────

describe('PATCH /api/admin/sidi/import — un batch si applica solo alla propria sede', () => {
  it('batch di un\'altra sede ⇒ 404, nessun alunno creato, batch NON applicato', async () => {
    comeCoordinatoreA()
    h.db.sidi_import_batches = [batch(BATCH_B, SEDE_B, [domanda('900', CF_NUOVO)])]

    const res = await IMPORT_PATCH(reqPatch({ batchId: BATCH_B }))

    expect(h.db.alunni).toHaveLength(2)
    expect(res.status).toBe(404)
    expect(scrittureSu('alunni')).toEqual([])
    expect(h.db.sidi_import_batches[0].stato).toBe('parsed')
  })

  it('batch della propria sede ⇒ l\'alunno nasce in QUELLA sede', async () => {
    comeCoordinatoreA()
    h.db.sidi_import_batches = [batch(BATCH_A, SEDE_A, [domanda('900', CF_NUOVO)])]

    const res = await IMPORT_PATCH(reqPatch({ batchId: BATCH_A }))

    expect(res.status).toBe(200)
    expect((await res.json()).creati).toBe(1)
    const inseriti = scrittureSu('alunni').filter((s) => s.operazione === 'insert')
    expect(inseriti).toHaveLength(1)
    expect(inseriti[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, codice_fiscale: CF_NUOVO })
    expect(h.db.sidi_import_batches[0].stato).toBe('applied')
  })

  it('CF già iscritto in un\'ALTRA sede ⇒ riga scartata con avviso, il bambino dell\'altra sede resta intatto', async () => {
    comeCoordinatoreA()
    h.db.sidi_import_batches = [batch(BATCH_A, SEDE_A, [domanda('901', CF_ALUNNO_B)])]

    const res = await IMPORT_PATCH(reqPatch({ batchId: BATCH_A }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.creati).toBe(0)
    expect(body.aggiornati).toBe(0)
    expect(body.warnings.join(' ')).toMatch(/altra sede/i)
    // Il bambino di SEDE_B non è stato né timbrato né ri-collegato.
    expect(alunnoDb(AL_B)).toMatchObject({ scuola_id: SEDE_B, numero_domanda_sidi: null })
    expect(scrittureSu('alunni')).toEqual([])
    expect(scrittureSu('student_parents')).toEqual([])
  })
})

// ─── POST /api/admin/sidi/frequentanti ───────────────────────────────────────

describe('POST /api/admin/sidi/frequentanti — al Ministero va UNA sede', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400, nessuna trasmissione, nessuno stato', async () => {
    h.db.sidi_sync_state = [statoSede(SEDE_A, { fase_a_stato: 'inviato' })]

    const res = await FREQUENTANTI(req('http://localhost/api/admin/sidi/frequentanti', 'POST'))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(h.trasmissioni).toEqual([])
    expect(scrittureSu('sidi_sync_state')).toEqual([])
  })

  it('`scuola_id` dichiarato ⇒ trasmette SOLO gli alunni di quella sede e persiste lo stato lì', async () => {
    h.db.sidi_sync_state = [
      statoSede(SEDE_A, { fase_a_stato: 'inviato' }),
      statoSede(SEDE_B, { fase_a_stato: 'inviato' }),
    ]

    const res = await FREQUENTANTI(
      req(`http://localhost/api/admin/sidi/frequentanti?scuola_id=${SEDE_B}`, 'POST'),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).classi).toBe(1)
    expect(h.trasmissioni).toHaveLength(1)
    expect(h.trasmissioni[0].xml).toContain(CF_ALUNNO_B)
    expect(h.trasmissioni[0].xml).not.toContain(CF_ALUNNO_A)
    const stati = scrittureSu('sidi_sync_state')
    expect(stati).toHaveLength(1)
    expect(stati[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, frequentanti_stato: 'inviato' })
  })

  it('la sequenza si legge sulla sede DICHIARATA: Fase A non inviata lì ⇒ 409 e niente egress', async () => {
    h.db.sidi_sync_state = [
      statoSede(SEDE_A, { fase_a_stato: 'inviato' }),
      statoSede(SEDE_B, { fase_a_stato: 'non_inviato' }),
    ]

    const res = await FREQUENTANTI(
      req(`http://localhost/api/admin/sidi/frequentanti?scuola_id=${SEDE_B}`, 'POST'),
    )

    expect(res.status).toBe(409)
    expect(h.trasmissioni).toEqual([])
  })

  it('utente con UNA sola sede ⇒ invariato: trasmette la sua', async () => {
    comeCoordinatoreA()
    h.db.sidi_sync_state = [statoSede(SEDE_A, { fase_a_stato: 'inviato' })]

    const res = await FREQUENTANTI(req('http://localhost/api/admin/sidi/frequentanti', 'POST'))

    expect(res.status).toBe(200)
    expect(h.trasmissioni[0].xml).toContain(CF_ALUNNO_A)
    expect(h.trasmissioni[0].xml).not.toContain(CF_ALUNNO_B)
  })

  it('lettura degli alunni fallita ⇒ 500, e al Ministero NON parte un elenco vuoto', async () => {
    comeCoordinatoreA()
    h.db.sidi_sync_state = [statoSede(SEDE_A, { fase_a_stato: 'inviato' })]
    // Colonna assente (DB E2E non migrato) o guasto: PostgREST non lancia, il
    // codice riceve `{ error }` e `data: null` — cioè «zero alunni».
    h.errori = { alunni: { code: '42703', message: 'column does not exist' } }

    const res = await FREQUENTANTI(req('http://localhost/api/admin/sidi/frequentanti', 'POST'))

    expect(res.status).toBe(500)
    expect(h.trasmissioni).toEqual([])
    expect(scrittureSu('sidi_sync_state')).toEqual([])
  })
})

// ─── POST /api/admin/sidi/piattaforma-unica ──────────────────────────────────

describe('POST /api/admin/sidi/piattaforma-unica — i legami sono quelli di UNA sede', () => {
  beforeEach(() => {
    h.db.sidi_sync_state = [
      statoSede(SEDE_A, { fase_a_stato: 'inviato', frequentanti_stato: 'inviato' }),
      statoSede(SEDE_B, { fase_a_stato: 'inviato', frequentanti_stato: 'inviato' }),
    ]
  })

  it('admin multi-sede senza `scuola_id` ⇒ 400, nessuna trasmissione, nessuno stato', async () => {
    const res = await PIATTAFORMA(req('http://localhost/api/admin/sidi/piattaforma-unica', 'POST'))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(h.trasmissioni).toEqual([])
    expect(scrittureSu('sidi_sync_state')).toEqual([])
  })

  it('trasmette SOLO i legami genitore↔figlio della sede dichiarata', async () => {
    const res = await PIATTAFORMA(
      req(`http://localhost/api/admin/sidi/piattaforma-unica?scuola_id=${SEDE_A}`, 'POST'),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).associazioni).toBe(1)
    expect(h.trasmissioni).toHaveLength(1)
    expect(h.trasmissioni[0].xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><genitoriAlunni>' +
        `<associazione alunnoCF="${CF_ALUNNO_A}" genitoreCF="${CF_GEN_A}" relazione="madre"/>` +
        '</genitoriAlunni>',
    )
    expect(scrittureSu('sidi_sync_state')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_A,
      piattaforma_unica_stato: 'inviato',
    })
  })

  it('utente con UNA sola sede ⇒ invariato: solo i legami della sua', async () => {
    comeCoordinatoreA()
    const res = await PIATTAFORMA(req('http://localhost/api/admin/sidi/piattaforma-unica', 'POST'))

    expect(res.status).toBe(200)
    expect((await res.json()).associazioni).toBe(1)
    expect(h.trasmissioni[0].xml).toContain(CF_GEN_A)
    expect(h.trasmissioni[0].xml).not.toContain(CF_GEN_B)
  })

  it('lettura dei legami fallita ⇒ 500, e al Ministero NON parte «nessuna associazione»', async () => {
    comeCoordinatoreA()
    h.errori = { student_parents: { code: '42703', message: 'column does not exist' } }

    const res = await PIATTAFORMA(req('http://localhost/api/admin/sidi/piattaforma-unica', 'POST'))

    expect(res.status).toBe(500)
    expect(h.trasmissioni).toEqual([])
    expect(scrittureSu('sidi_sync_state')).toEqual([])
  })
})
