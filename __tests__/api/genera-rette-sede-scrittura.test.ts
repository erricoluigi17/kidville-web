import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B, SEDE_E2E } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// «Genera rette» — la sede si DICHIARA, e la RPC la riceve.
//
// Non è un rischio teorico: in produzione è GIÀ SUCCESSO. `registro_modifiche`
// conserva UNA sola esecuzione di `genera_rette` (2026-07-10, `generati: 25`) e
// i `pagamenti` con `gruppo LIKE 'retta-%'` sono 21 su una sede + 4 sulla sede
// finta di collaudo: 21+4 = 25. Un clic, due sedi.
//
// La causa: l'anteprima (GET) filtrava per plesso, la conferma (POST) chiamava
// `genera_rette_mensili(p_periodo)` — una RPC senza parametro di sede. Anteprima
// e azione guardavano insiemi diversi sullo stesso bottone.
//
// PERCHÉ QUESTO TEST NON PUÒ ESSERE UN FALSO VERDE. La finta RPC qui sotto si
// comporta come quella vera PRIMA della correzione: se `p_scuola_id` non arriva,
// genera per TUTTE le sedi. Quindi le asserzioni non guardano la forma della
// chiamata soltanto, ma lo STATO DEL DATABASE (`db.pagamenti`) e i destinatari
// delle notifiche. Togliere il parametro dalla route fa comparire nel finto DB
// le rette dell'altra sede, e i test diventano rossi da soli.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_E2E = 'e2e11111-1111-4111-8111-111111111111'
const CAT_GLOBALE = 'c0000000-0000-4000-8000-000000000001'
const CAT_SEDE_B = 'c0000000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  // Firma esplicita: serve a leggere `mock.calls[0][1]` (i parametri della
  // notifica) senza cast su una tupla vuota.
  notificaEvento: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Record<string, unknown>[],
  chiamate: [] as { nome: string; args: Record<string, unknown> }[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))

// La finta RPC replica il comportamento della funzione SQL **prima** della
// correzione: senza `p_scuola_id` cicla su tutte le sedi. È il modo per
// provare la correzione sul DATO e non sulla forma della chiamata.
const generaMensili = (args: Riga) => {
  h.chiamate.push({ nome: 'genera_rette_mensili', args })
  const sede = (args.p_scuola_id as string | undefined) ?? null
  const periodo = String(args.p_periodo)
  const candidati = (h.db.alunni ?? []).filter(
    (a) => a.stato === 'iscritto' && (sede === null || a.scuola_id === sede),
  )
  const gruppo = `retta-${periodo.slice(0, 7)}`
  const nuove = candidati.filter(
    (a) => !(h.db.pagamenti ?? []).some((p) => p.alunno_id === a.id && p.periodo_competenza === periodo),
  )
  for (const a of nuove) {
    h.db.pagamenti.push({
      id: `pag-${String(a.id).slice(0, 8)}-${periodo}`,
      alunno_id: a.id,
      scuola_id: a.scuola_id,
      categoria_id: CAT_GLOBALE,
      periodo_competenza: periodo,
      gruppo,
      visibile_dal: '2026-07-25',
    })
  }
  return { data: nuove.length, error: null }
}

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        errori: h.errori,
        scritture: h.scritture as unknown as Scrittura[],
        rpc: {
          genera_rette_mensili: generaMensili,
          genera_rette_anno: (args: Riga) => {
            h.chiamate.push({ nome: 'genera_rette_anno', args })
            let tot = 0
            for (const m of ['09', '10']) {
              const r = generaMensili({ p_periodo: `${args.p_anno_inizio}-${m}-01`, p_scuola_id: args.p_scuola_id })
              tot += Number(r.data)
            }
            return { data: tot, error: null }
          },
        },
      }) as never,
  }
})

import { GET, POST } from '@/app/api/pagamenti/genera-rette/route'

const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/genera-rette', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const get = (qs: string) => new Request(`http://localhost/api/pagamenti/genera-rette?${qs}`)

const alunno = (id: string, scuola: string, nome: string): Riga => ({
  id,
  scuola_id: scuola,
  nome,
  cognome: 'Prova',
  stato: 'iscritto',
  classe_sezione: '2 ANNI',
  section_id: null,
  importo_retta_mensile: 0,
  genitori_separati: false,
  data_iscrizione: null,
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ],
  payment_categories: [{ id: CAT_GLOBALE, slug: 'retta', scuola_id: null, nome: 'Retta' }],
  admin_settings: [
    { scuola_id: SEDE_A, retta_default_importo: 150 },
    { scuola_id: SEDE_B, retta_default_importo: 120 },
  ],
  alunni: [alunno(ALU_A, SEDE_A, 'Anna'), alunno(ALU_B, SEDE_B, 'Bruno')],
  pagamenti: [],
  registro_modifiche: [],
})

const sediDi = (righe: Riga[]) => [...new Set(righe.map((r) => String(r.scuola_id)))].sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.chiamate = []
  h.errori = {}
  h.log = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/genera-rette — la sede si dichiara', () => {
  it('admin multi-sede senza scuola_id: 400, nessuna RPC, nessuna retta, nessun audit', async () => {
    const res = await POST(post({ periodo: '2026-09' }))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
    expect(h.db.pagamenti).toEqual([])
    expect(h.db.registro_modifiche).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('con scuola_id: la RPC riceve p_scuola_id e le rette nascono SOLO in quella sede', async () => {
    const res = await POST(post({ periodo: '2026-09', scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.chiamate).toHaveLength(1)
    expect(h.chiamate[0]).toEqual({
      nome: 'genera_rette_mensili',
      args: { p_periodo: '2026-09-01', p_scuola_id: SEDE_B },
    })
    // Lo stato del database, non la forma della chiamata.
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_B])
    expect((h.db.pagamenti as Riga[]).map((p) => p.alunno_id)).toEqual([ALU_B])
    const audit = (h.db.registro_modifiche as Riga[])[0]
    expect(audit.azione).toBe('genera_rette')
    expect((audit.nuovo_valore as Riga).scuola_id).toBe(SEDE_B)
    expect((audit.nuovo_valore as Riga).generati).toBe(1)
  })

  it('anno scolastico: genera_rette_anno riceve p_anno_inizio E p_scuola_id', async () => {
    const res = await POST(post({ anno: 2026, scuola_id: SEDE_A }))
    expect(res.status).toBe(200)
    expect(h.chiamate[0]).toEqual({
      nome: 'genera_rette_anno',
      args: { p_anno_inizio: 2026, p_scuola_id: SEDE_A },
    })
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_A])
    const audit = (h.db.registro_modifiche as Riga[])[0]
    expect(audit.azione).toBe('genera_rette_anno')
    expect((audit.nuovo_valore as Riga).scuola_id).toBe(SEDE_A)
  })

  it('una sola sede accessibile (segreteria): niente 400, la sede è la sua', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await POST(post({ periodo: '2026-09' }))
    expect(res.status).toBe(200)
    expect(h.chiamate[0].args).toEqual({ p_periodo: '2026-09-01', p_scuola_id: SEDE_A })
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_A])
  })

  it('sede di collaudo E2E: 400 e nessuna RPC, nemmeno se è fra le sue sedi', async () => {
    h.db.utenti_scuole.push({ utente_id: ADMIN, scuola_id: SEDE_E2E })
    h.db.alunni.push(alunno(ALU_E2E, SEDE_E2E, 'Test'))
    const res = await POST(post({ periodo: '2026-09', scuola_id: SEDE_E2E }))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
    expect(h.db.pagamenti).toEqual([])
    expect(h.db.registro_modifiche).toEqual([])
  })

  it('notifica solo la sede generata: le rette preesistenti di un\'altra sede non rientrano', async () => {
    // La sede A ha già la sua retta di settembre (generata prima, altro clic).
    h.db.pagamenti.push({
      id: 'pag-vecchio',
      alunno_id: ALU_A,
      scuola_id: SEDE_A,
      categoria_id: CAT_GLOBALE,
      periodo_competenza: '2026-09-01',
      gruppo: 'retta-2026-09',
      visibile_dal: '2026-07-25',
    })
    const res = await POST(post({ periodo: '2026-09', scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const arg = h.notificaEvento.mock.calls[0][1] as { scuolaId: string; alunnoIds: string[] }
    expect(arg.scuolaId).toBe(SEDE_B)
    expect(arg.alunnoIds).toEqual([ALU_B])
  })

  it('audit non scritto: la risposta resta 200 ma l\'evento è loggato a error', async () => {
    h.errori = { registro_modifiche: { code: '42501', message: 'permission denied' } }
    const res = await POST(post({ periodo: '2026-09', scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    const righe = h.log.filter((c) => c[1] === 'error')
    expect(righe.length).toBeGreaterThan(0)
    expect(JSON.stringify(righe)).toContain('audit-non-scritto')
  })
})

describe('GET /api/pagamenti/genera-rette — anteprima e conferma condividono lo scope', () => {
  it('admin multi-sede senza scuola_id: 400, come la conferma', async () => {
    const res = await GET(get('periodo=2026-09'))
    expect(res.status).toBe(400)
  })

  it('con scuola_id: i candidati sono solo quelli della sede', async () => {
    const res = await GET(get(`periodo=2026-09&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.candidati.map((c: { id: string }) => c.id)).toEqual([ALU_B])
    expect(j.data.retta_default).toBe(120)
  })

  it('categoria «retta» di sede: ha la precedenza sulla globale', async () => {
    h.db.payment_categories.push({ id: CAT_SEDE_B, slug: 'retta', scuola_id: SEDE_B, nome: 'Retta' })
    // La retta di settembre di ALU_B esiste già, ma sulla categoria DELLA SEDE:
    // con la risoluzione «solo globale» risulterebbe ancora da generare.
    h.db.pagamenti.push({
      id: 'pag-b-set',
      alunno_id: ALU_B,
      scuola_id: SEDE_B,
      categoria_id: CAT_SEDE_B,
      periodo_competenza: '2026-09-01',
      gruppo: 'retta-2026-09',
    })
    const res = await GET(get(`periodo=2026-09&scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.candidati).toEqual([])
    expect(j.data.gia_generati).toBe(1)
  })
})
