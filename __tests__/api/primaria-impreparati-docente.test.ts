import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── V2 (spec 2026-09-24) — impreparati del docente: tipo, motivo, notifica al
// genitore dopo il buffer, PATCH/DELETE col VERO `permesso-voce` (autore =
// `creato_da`, termine sulla `data`, sblocchi, docenti della classe per le
// dichiarazioni del genitore) e la forma «elenco di un alunno» della GET.
// Qui si finge solo il database: ogni query è registrata con i suoi filtri,
// così un test che guarda solo lo status non basta a farlo passare.

const h = vi.hoisted(() => {
  interface Chiamata {
    table: string
    op: 'select' | 'update' | 'delete' | 'insert'
    payload?: unknown
    cols?: string
    filtri: unknown[][]
  }
  const state = {
    risposte: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    chiamate: [] as Chiamata[],
  }
  function take(key: string) {
    const q = state.risposte[key]
    return q && q.length > 0 ? q.shift()! : { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const c: Chiamata = { table, op: 'select', filtri: [] }
        state.chiamate.push(c)
        const qb: Record<string, unknown> = {}
        for (const m of ['eq', 'in', 'is', 'not', 'order', 'limit', 'gte', 'lte', 'neq', 'or']) {
          qb[m] = (...a: unknown[]) => { c.filtri.push([m, ...a]); return qb }
        }
        qb.select = (cols?: string) => { if (c.op === 'select') c.cols = cols; else c.cols = c.cols ?? cols; return qb }
        qb.update = (v: unknown) => { c.op = 'update'; c.payload = v; return qb }
        qb.delete = () => { c.op = 'delete'; return qb }
        qb.insert = (v: unknown) => { c.op = 'insert'; c.payload = v; return qb }
        const risolvi = () => Promise.resolve(take(`${table}:${c.op}`))
        qb.single = risolvi
        qb.maybeSingle = risolvi
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => risolvi().then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockImplementation(async () => h.makeClient()),
}))

const m = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  assertAlunniInSezione: vi.fn(),
  logScrittura: vi.fn(),
  notificaTitolariScrittura: vi.fn(),
  enqueueNotifichePerAlunni: vi.fn(),
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: m.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: m.assertSezioneInScope,
  assertAlunniInSezione: m.assertAlunniInSezione,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: m.logScrittura }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: m.enqueueNotifichePerAlunni,
  notificaTitolariScrittura: m.notificaTitolariScrittura,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: m.logEvento,
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/primaria/giustifiche-didattiche/route'
import { NextRequest, NextResponse } from 'next/server'
import { dataRomaDi } from '@/lib/primaria/timelock'

const IMP = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a'
const IMP2 = '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b'
const SEZ = '0e20e2e2-0e2e-40e2-8e2e-0e2e2e2e2e21'
const SEDE = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'
const MAT = '3a73a73a-3a7a-43a7-8a73-a73a73a73a71'
const ALU = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'
const AUTORE = 'd0c0d0c0-d0c0-4d0c-8d0c-d0c0d0c0d0c0'
const ALTRA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
const GENITORE = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2'

const GIORNO = 86_400_000
/** Data di ROMA di n giorni fa (`YYYY-MM-DD`): la data dell'evento di un impreparato. */
const giorniFa = (n: number) => dataRomaDi(new Date(Date.now() - n * GIORNO))

function riga(over: Record<string, unknown> = {}) {
  return {
    id: IMP, alunno_id: ALU, section_id: SEZ, materia_id: MAT, data: giorniFa(0),
    motivo: null, tipo: 'impreparato', origine: 'docente', creato_da: AUTORE,
    creato_il: new Date().toISOString(),
    sections: { scuola_id: SEDE }, materie: { nome: 'Matematica' },
    ...over,
  }
}

function coda(key: string, ...r: Array<{ data: unknown; error: unknown }>) {
  h.state.risposte[key] = [...(h.state.risposte[key] ?? []), ...r]
}

function utente(id: string, role: string) {
  m.requireDocente.mockResolvedValue({ user: { id, role, scuola_id: SEDE }, response: null })
}

const URL_BASE = 'http://localhost/api/primaria/giustifiche-didattiche'
function conCorpo(method: string, body: unknown): NextRequest {
  return new NextRequest(`${URL_BASE}?userId=${AUTORE}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
const del = (id: string) => new NextRequest(`${URL_BASE}?id=${id}&userId=${AUTORE}`, { method: 'DELETE' })
const get = (qs: string) => new NextRequest(`${URL_BASE}?${qs}&userId=${AUTORE}`)

const chiamate = (table: string, op: string) => h.state.chiamate.filter((c) => c.table === table && c.op === op)
const filtro = (c: { filtri: unknown[][] }, metodo: string, colonna: string) =>
  c.filtri.find((f) => f[0] === metodo && f[1] === colonna)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.risposte = {}
  h.state.chiamate = []
  utente(AUTORE, 'educator')
  m.assertSezioneInScope.mockResolvedValue(null)
  m.assertAlunniInSezione.mockResolvedValue(null)
  m.logScrittura.mockResolvedValue(undefined)
  m.notificaTitolariScrittura.mockResolvedValue(undefined)
  m.enqueueNotifichePerAlunni.mockResolvedValue(undefined)
})

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/primaria/giustifiche-didattiche — forma per alunno', () => {
  it('filtra classe + alunno + (materia O nessuna materia), senza nomi, con tipo e stato per voce', async () => {
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('giustifiche_didattiche:select', {
      data: [
        // Del docente, di oggi: modificabile.
        { id: IMP, alunno_id: ALU, materia_id: MAT, data: giorniFa(0), motivo: 'libro dimenticato', tipo: 'giustificato', origine: 'docente', creato_da: AUTORE, creato_il: 'x' },
        // Dichiarata dal genitore 5 giorni fa, senza materia: oltre il termine (2 gg).
        { id: IMP2, alunno_id: ALU, materia_id: null, data: giorniFa(5), motivo: null, tipo: 'giustificato', origine: 'genitore', creato_da: GENITORE, creato_il: 'x' },
      ],
      error: null,
    })
    // Il permesso della voce del genitore passa dai docenti della classe.
    coda('utenti_sezioni:select', { data: [{ section_id: SEZ }], error: null })

    const res = await GET(get(`sectionId=${SEZ}&alunnoId=${ALU}&materiaId=${MAT}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    const [q] = chiamate('giustifiche_didattiche', 'select')
    expect(filtro(q, 'eq', 'section_id')?.[2]).toBe(SEZ)
    expect(filtro(q, 'eq', 'alunno_id')?.[2]).toBe(ALU)
    expect(q.filtri.find((f) => f[0] === 'or')?.[1]).toBe(`materia_id.eq.${MAT},materia_id.is.null`)
    expect(filtro(q, 'eq', 'data')).toBeUndefined()
    expect(q.cols).toContain('tipo')
    expect(q.cols).not.toContain('alunni(')
    expect(m.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: AUTORE }), SEZ)

    expect(body.statoVociDisponibile).toBe(true)
    const [a, b] = body.data
    expect(a).toMatchObject({ id: IMP, tipo: 'giustificato', origine: 'docente', motivo: 'libro dimenticato', modificabile: true, bloccata: false, giorniLimite: 2 })
    expect(b).toMatchObject({ id: IMP2, tipo: 'giustificato', origine: 'genitore', modificabile: false, bloccata: true })
    // `creato_da` serve al permesso, non alla pagina.
    expect(a).not.toHaveProperty('creato_da')
  })

  it('GET e PATCH dicono la stessa cosa: una voce del genitore entro il termine è «modificabile» per un docente della classe', async () => {
    utente(ALTRA, 'educator')
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('giustifiche_didattiche:select', {
      data: [{ id: IMP, alunno_id: ALU, materia_id: MAT, data: giorniFa(0), motivo: null, tipo: 'giustificato', origine: 'genitore', creato_da: GENITORE, creato_il: 'x' }],
      error: null,
    })
    coda('utenti_sezioni:select', { data: [{ section_id: SEZ }], error: null })
    const res = await GET(get(`sectionId=${SEZ}&alunnoId=${ALU}&materiaId=${MAT}`))
    expect(res.status).toBe(200)
    expect((await res.json()).data[0]).toMatchObject({ id: IMP, origine: 'genitore', modificabile: true, bloccata: false })

    // …e la PATCH dello stesso docente sulla stessa riga passa.
    coda('giustifiche_didattiche:select', { data: riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE }), error: null })
    coda('utenti_sezioni:select', { data: [{ section_id: SEZ }], error: null })
    coda('giustifiche_didattiche:update', { data: [riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE, motivo: 'm' })], error: null })
    const patch = await PATCH(conCorpo('PATCH', { id: IMP, motivo: 'm' }))
    expect(patch.status).toBe(200)
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(1)
  })

  it('la forma del GIORNO resta: filtro per data e nome dell’alunno', async () => {
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('giustifiche_didattiche:select', { data: [], error: null })
    const oggi = giorniFa(0)
    const res = await GET(get(`sectionId=${SEZ}&data=${oggi}`))
    expect(res.status).toBe(200)
    const [q] = chiamate('giustifiche_didattiche', 'select')
    expect(filtro(q, 'eq', 'data')?.[2]).toBe(oggi)
    expect(filtro(q, 'eq', 'alunno_id')).toBeUndefined()
    expect(q.filtri.some((f) => f[0] === 'or')).toBe(false)
    expect(q.cols).toContain('alunni(nome, cognome)')
  })

  it('DB senza la colonna `tipo` (42703): rilegge senza, e il tipo lo dà l’origine', async () => {
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('giustifiche_didattiche:select',
      { data: null, error: { code: '42703', message: 'column giustifiche_didattiche.tipo does not exist' } },
      { data: [{ id: IMP, data: giorniFa(0), origine: 'genitore', creato_da: GENITORE, motivo: null }], error: null },
    )
    const res = await GET(get(`sectionId=${SEZ}&alunnoId=${ALU}`))
    expect(res.status).toBe(200)
    const [prima, seconda] = chiamate('giustifiche_didattiche', 'select')
    expect(prima.cols).toContain('tipo')
    expect(seconda.cols).not.toContain('tipo')
    expect((await res.json()).data[0].tipo).toBe('giustificato')
  })

  it('500 con codice, senza la prosa del database', async () => {
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('giustifiche_didattiche:select', { data: null, error: { code: 'XX000', message: 'segreto interno' } })
    const res = await GET(get(`sectionId=${SEZ}&alunnoId=${ALU}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('LETTURA_FALLITA')
    expect(JSON.stringify(body)).not.toContain('segreto interno')
  })
})

// ─── POST ────────────────────────────────────────────────────────────────────

describe('POST /api/primaria/giustifiche-didattiche', () => {
  const CORPO = { sectionId: SEZ, alunnoId: ALU, materiaId: MAT, data: giorniFa(0) }

  beforeEach(() => {
    coda('sections:select', { data: { scuola_id: SEDE }, error: null })
    coda('materie:select', { data: { id: MAT, nome: 'Matematica' }, error: null })
  })

  it('tipo predefinito «impreparato», il testo fisso storico NON si scrive come motivo, audit e notifica al genitore dopo 10′', async () => {
    coda('giustifiche_didattiche:insert', { data: { id: IMP, ...CORPO, tipo: 'impreparato', origine: 'docente' }, error: null })
    const res = await POST(conCorpo('POST', { ...CORPO, motivo: 'Impreparato giustificato' }))
    expect(res.status).toBe(201)

    const [ins] = chiamate('giustifiche_didattiche', 'insert')
    expect(ins.payload).toMatchObject({
      alunno_id: ALU, section_id: SEZ, materia_id: MAT, tipo: 'impreparato',
      motivo: null, origine: 'docente', creato_da: AUTORE,
    })
    // La materia si cerca DENTRO la classe.
    const [mat] = chiamate('materie', 'select')
    expect(filtro(mat, 'eq', 'section_id')?.[2]).toBe(SEZ)

    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'impreparato', entitaId: IMP, azione: 'insert', scuolaId: SEDE, sectionId: SEZ,
      valoreDopo: expect.objectContaining({ tipo: 'impreparato', origine: 'docente', con_motivo: false }),
    }))

    expect(m.enqueueNotifichePerAlunni).toHaveBeenCalledTimes(1)
    const [, notif] = m.enqueueNotifichePerAlunni.mock.calls[0]
    expect(notif).toMatchObject({
      alunnoIds: [ALU],
      tipo: 'impreparato_segnato',
      link: '/parent/primaria/valutazioni',
      entitaTipo: 'impreparato',
      entitaId: IMP,
      bufferMin: 10,
      // L'interruttore per sede si decide su QUESTA sede.
      scuolaId: SEDE,
      titolo: 'Impreparato in Matematica',
    })
    // Il buffer si legge dalla sede della classe.
    const [buf] = chiamate('admin_settings', 'select')
    expect(filtro(buf, 'eq', 'scuola_id')?.[2]).toBe(SEDE)

    expect(m.logEvento).toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'impreparato-segnato', giustifica_id: IMP, tipo: 'impreparato' }), undefined, expect.anything())
  })

  it('tipo «giustificato» e motivo libero (trim): il motivo NON finisce nella notifica', async () => {
    coda('admin_settings:select', { data: { notif_buffer_valutazioni_min: 15 }, error: null })
    coda('giustifiche_didattiche:insert', { data: { id: IMP, tipo: 'giustificato' }, error: null })
    const res = await POST(conCorpo('POST', { ...CORPO, tipo: 'giustificato', motivo: '  ha dimenticato il quaderno  ' }))
    expect(res.status).toBe(201)
    const [ins] = chiamate('giustifiche_didattiche', 'insert')
    expect(ins.payload).toMatchObject({ tipo: 'giustificato', motivo: 'ha dimenticato il quaderno' })

    const [, notif] = m.enqueueNotifichePerAlunni.mock.calls[0]
    expect(notif.titolo).toBe('Impreparato giustificato in Matematica')
    expect(notif.bufferMin).toBe(15)
    expect(JSON.stringify(notif)).not.toContain('quaderno')
  })

  it('400 IMPREPARATO_MATERIA_NON_VALIDA per una materia di un’altra classe: niente insert, niente notifica', async () => {
    h.state.risposte['materie:select'] = [{ data: null, error: null }]
    const res = await POST(conCorpo('POST', CORPO))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('IMPREPARATO_MATERIA_NON_VALIDA')
    expect(chiamate('giustifiche_didattiche', 'insert')).toHaveLength(0)
    expect(m.enqueueNotifichePerAlunni).not.toHaveBeenCalled()
  })

  it('400 su un motivo oltre il tetto e su un tipo sconosciuto', async () => {
    expect((await POST(conCorpo('POST', { ...CORPO, motivo: 'x'.repeat(501) }))).status).toBe(400)
    expect((await POST(conCorpo('POST', { ...CORPO, tipo: 'assente' }))).status).toBe(400)
    expect(chiamate('giustifiche_didattiche', 'insert')).toHaveLength(0)
  })

  it('500 IMPREPARATO_NON_SALVATO senza la prosa del database, e nessuna notifica', async () => {
    coda('giustifiche_didattiche:insert', { data: null, error: { code: '23503', message: 'violates foreign key "segreto"' } })
    const res = await POST(conCorpo('POST', CORPO))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('IMPREPARATO_NON_SALVATO')
    expect(JSON.stringify(body)).not.toContain('segreto')
    expect(m.enqueueNotifichePerAlunni).not.toHaveBeenCalled()
    expect(m.logScrittura).not.toHaveBeenCalled()
  })

  it('DB senza la colonna `tipo` (PGRST204): riscrive senza, e non perde l’impreparato', async () => {
    coda('giustifiche_didattiche:insert',
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'tipo' column" } },
      { data: { id: IMP }, error: null },
    )
    const res = await POST(conCorpo('POST', CORPO))
    expect(res.status).toBe(201)
    const [prima, seconda] = chiamate('giustifiche_didattiche', 'insert')
    expect(prima.payload).toHaveProperty('tipo')
    expect(seconda.payload).not.toHaveProperty('tipo')
  })
})

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/primaria/giustifiche-didattiche', () => {
  it('l’autore entro il termine cambia tipo, motivo e data; si allinea SOLO la notifica in coda', async () => {
    const ieri = giorniFa(1)
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    coda('giustifiche_didattiche:update', { data: [riga({ tipo: 'giustificato', motivo: 'visita', data: ieri })], error: null })

    const res = await PATCH(conCorpo('PATCH', { id: IMP, tipo: 'giustificato', motivo: '  visita  ', data: ieri }))
    expect(res.status).toBe(200)
    expect(m.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: AUTORE }), SEZ)

    const [upd] = chiamate('giustifiche_didattiche', 'update')
    expect(upd.payload).toEqual({ tipo: 'giustificato', motivo: 'visita', data: ieri })
    expect(filtro(upd, 'eq', 'id')?.[2]).toBe(IMP)
    expect(filtro(upd, 'eq', 'section_id')?.[2]).toBe(SEZ)

    const [notif] = chiamate('notifiche', 'update')
    expect(notif.payload).toMatchObject({ titolo: 'Impreparato giustificato in Matematica' })
    expect(JSON.stringify(notif.payload)).not.toContain('visita')
    expect(filtro(notif, 'eq', 'tipo')?.[2]).toBe('impreparato_segnato')
    expect(filtro(notif, 'eq', 'entita_id')?.[2]).toBe(IMP)
    expect(filtro(notif, 'is', 'push_inviata_il')?.[2]).toBeNull()
    // Nessun avviso NUOVO al genitore.
    expect(chiamate('notifiche', 'insert')).toHaveLength(0)
    expect(m.enqueueNotifichePerAlunni).not.toHaveBeenCalled()

    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'impreparato', entitaId: IMP, azione: 'update', scuolaId: SEDE, sectionId: SEZ,
      valorePrima: expect.objectContaining({ tipo: 'impreparato', con_motivo: false }),
      valoreDopo: expect.objectContaining({ tipo: 'giustificato', con_motivo: true, data: ieri }),
    }))
    const body = await res.json()
    expect(body.data).toMatchObject({ id: IMP, tipo: 'giustificato' })
    expect(body.data).not.toHaveProperty('creato_da')
  })

  it('403 VOCE_NON_AUTORE a un docente che non è l’autore: nessuna scrittura', async () => {
    utente(ALTRA, 'educator')
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, tipo: 'giustificato' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VOCE_NON_AUTORE')
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
  })

  it('423 VOCE_BLOCCATA oltre il termine (anche per l’autore)', async () => {
    coda('giustifiche_didattiche:select', { data: riga({ data: giorniFa(5) }), error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, motivo: 'x' }))
    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('VOCE_BLOCCATA')
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
  })

  it('423 se la NUOVA data è oltre il termine: il termine vale su entrambe le date', async () => {
    coda('giustifiche_didattiche:select', { data: riga({ data: giorniFa(0) }), error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, data: giorniFa(10) }))
    expect(res.status).toBe(423)
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
  })

  it('oltre il termine con lo sblocco della voce si modifica', async () => {
    coda('giustifiche_didattiche:select', { data: riga({ data: giorniFa(5) }), error: null })
    coda('sblocchi_audit:select', { data: [{ entita_tipo: 'impreparato', entita_id: IMP }], error: null })
    coda('giustifiche_didattiche:update', { data: [riga({ data: giorniFa(5), motivo: 'x' })], error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, motivo: 'x' }))
    expect(res.status).toBe(200)
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(1)
  })

  it('un impreparato del GENITORE lo modifica un docente della CLASSE (200); uno di un’altra classe no (403)', async () => {
    const delGenitore = riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE })
    utente(ALTRA, 'educator')
    coda('giustifiche_didattiche:select', { data: delGenitore, error: null })
    coda('utenti_sezioni:select', { data: [{ section_id: SEZ }], error: null })
    coda('giustifiche_didattiche:update', { data: [{ ...delGenitore, motivo: 'riscritto' }], error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, motivo: 'riscritto' }))
    expect(res.status).toBe(200)
    const [us] = chiamate('utenti_sezioni', 'select')
    expect(filtro(us, 'eq', 'utente_id')?.[2]).toBe(ALTRA)
    const [upd] = chiamate('giustifiche_didattiche', 'update')
    expect(upd.payload).toEqual({ motivo: 'riscritto' })
    expect(filtro(upd, 'eq', 'id')?.[2]).toBe(IMP)
    expect(filtro(upd, 'eq', 'section_id')?.[2]).toBe(SEZ)
    // Le voci del genitore non hanno una notifica al genitore da riallineare.
    expect(chiamate('notifiche', 'update')).toHaveLength(0)
    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'impreparato', entitaId: IMP, azione: 'update',
      valorePrima: expect.objectContaining({ origine: 'genitore', con_motivo: false }),
      valoreDopo: expect.objectContaining({ origine: 'genitore', tipo: 'giustificato', con_motivo: true }),
    }))

    h.state.chiamate = []
    h.state.risposte = {}
    vi.clearAllMocks()
    coda('giustifiche_didattiche:select', { data: delGenitore, error: null })
    coda('utenti_sezioni:select', { data: [], error: null })
    const res2 = await PATCH(conCorpo('PATCH', { id: IMP, motivo: 'riscritto' }))
    expect(res2.status).toBe(403)
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
  })

  it('il tipo di un impreparato del GENITORE resta «giustificato»: 400 IMPREPARATO_TIPO_GENITORE', async () => {
    utente(ALTRA, 'segreteria')
    coda('giustifiche_didattiche:select', { data: riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE }), error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, tipo: 'impreparato' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('IMPREPARATO_TIPO_GENITORE')
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
  })

  it('una PATCH che non scrive niente (tipo «giustificato» su una voce del genitore) NON è una rettifica: niente update, niente audit', async () => {
    utente(ALTRA, 'segreteria')
    coda('giustifiche_didattiche:select', { data: riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE }), error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, tipo: 'giustificato' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: IMP, tipo: 'giustificato', origine: 'genitore' })
    expect(body.data).not.toHaveProperty('creato_da')
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
    expect(chiamate('notifiche', 'update')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
    expect(m.notificaTitolariScrittura).not.toHaveBeenCalled()
    expect(m.logEvento).toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'impreparato-nessuna-modifica', giustifica_id: IMP }), undefined, expect.anything())
    expect(m.logEvento).not.toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'impreparato-modificato' }), undefined, expect.anything())
  })

  it('400 IMPREPARATO_MATERIA_NON_VALIDA per una materia di un’altra classe', async () => {
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    coda('materie:select', { data: null, error: null })
    const res = await PATCH(conCorpo('PATCH', { id: IMP, materiaId: '9f9f9f9f-9f9f-49f9-89f9-9f9f9f9f9f9f' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('IMPREPARATO_MATERIA_NON_VALIDA')
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
  })

  it('400 senza campi da modificare', async () => {
    expect((await PATCH(conCorpo('PATCH', { id: IMP }))).status).toBe(400)
  })

  it('403 fuori plesso: la Segreteria di un’altra sede non modifica (permesso-voce non guarda la sede, lo scope sì)', async () => {
    utente(ALTRA, 'segreteria')
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    m.assertSezioneInScope.mockResolvedValueOnce(NextResponse.json({ error: 'fuori plesso' }, { status: 403 }))
    const res = await PATCH(conCorpo('PATCH', { id: IMP, tipo: 'giustificato', motivo: 'x' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('fuori plesso')
    expect(m.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: ALTRA }), SEZ)
    expect(chiamate('giustifiche_didattiche', 'update')).toHaveLength(0)
    expect(chiamate('notifiche', 'update')).toHaveLength(0)
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
    expect(m.notificaTitolariScrittura).not.toHaveBeenCalled()
  })
})

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/primaria/giustifiche-didattiche', () => {
  it('l’autore elimina: cancellazione vera, ritiro della notifica ANCORA IN CODA, audit', async () => {
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    coda('giustifiche_didattiche:delete', { data: [{ id: IMP }], error: null })
    coda('notifiche:delete', { data: [{ id: 'n1' }], error: null })

    const res = await DELETE(del(IMP))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ id: IMP, notificheRitirate: 1 })

    const [cancella] = chiamate('giustifiche_didattiche', 'delete')
    expect(filtro(cancella, 'eq', 'id')?.[2]).toBe(IMP)
    expect(filtro(cancella, 'eq', 'section_id')?.[2]).toBe(SEZ)

    const [ritiro] = chiamate('notifiche', 'delete')
    expect(filtro(ritiro, 'eq', 'entita_id')?.[2]).toBe(IMP)
    expect(filtro(ritiro, 'in', 'entita_tipo')?.[2]).toEqual(['impreparato', 'giustifica_didattica'])
    expect(filtro(ritiro, 'is', 'push_inviata_il')?.[2]).toBeNull()
    // Prima si cancella, poi si ritira.
    expect(h.state.chiamate.indexOf(cancella)).toBeLessThan(h.state.chiamate.indexOf(ritiro))

    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'impreparato', entitaId: IMP, azione: 'delete', scuolaId: SEDE, sectionId: SEZ, valoreDopo: null,
    }))
    expect(m.logEvento).toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'impreparato-eliminato', giustifica_id: IMP, notifiche_ritirate: 1 }), undefined, expect.anything())
  })

  it('un impreparato del GENITORE lo toglie un docente della CLASSE; uno di un’altra classe no', async () => {
    const delGenitore = riga({ origine: 'genitore', tipo: 'giustificato', creato_da: GENITORE })
    utente(ALTRA, 'educator')
    coda('giustifiche_didattiche:select', { data: delGenitore, error: null })
    coda('utenti_sezioni:select', { data: [{ section_id: SEZ }], error: null })
    coda('giustifiche_didattiche:delete', { data: [{ id: IMP }], error: null })
    expect((await DELETE(del(IMP))).status).toBe(200)
    const [us] = chiamate('utenti_sezioni', 'select')
    expect(filtro(us, 'eq', 'utente_id')?.[2]).toBe(ALTRA)

    h.state.chiamate = []
    coda('giustifiche_didattiche:select', { data: delGenitore, error: null })
    coda('utenti_sezioni:select', { data: [], error: null })
    const res = await DELETE(del(IMP))
    expect(res.status).toBe(403)
    expect(chiamate('giustifiche_didattiche', 'delete')).toHaveLength(0)
  })

  it('un impreparato del DOCENTE non lo toglie un collega della classe', async () => {
    utente(ALTRA, 'educator')
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    const res = await DELETE(del(IMP))
    expect(res.status).toBe(403)
    expect(chiamate('giustifiche_didattiche', 'delete')).toHaveLength(0)
  })

  it('423 oltre il termine anche per la Segreteria: niente cancellazione, niente ritiro', async () => {
    utente(ALTRA, 'segreteria')
    coda('giustifiche_didattiche:select', { data: riga({ data: giorniFa(4) }), error: null })
    const res = await DELETE(del(IMP))
    expect(res.status).toBe(423)
    expect(chiamate('giustifiche_didattiche', 'delete')).toHaveLength(0)
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
  })

  it('oltre il termine con lo sblocco del GIORNO della classe si elimina', async () => {
    const data = giorniFa(4)
    coda('giustifiche_didattiche:select', { data: riga({ data }), error: null })
    coda('sblocchi_audit:select',
      { data: [], error: null },
      { data: [{ entita_tipo: 'giorno', section_id: SEZ, data, ora_lezione: null }], error: null },
    )
    coda('giustifiche_didattiche:delete', { data: [{ id: IMP }], error: null })
    expect((await DELETE(del(IMP))).status).toBe(200)
  })

  it('404 IMPREPARATO_NON_TROVATO se non c’è (o se sparisce fra lettura e cancellazione)', async () => {
    const res = await DELETE(del(IMP))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_TROVATO')

    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    coda('giustifiche_didattiche:delete', { data: [], error: null })
    const res2 = await DELETE(del(IMP))
    expect(res2.status).toBe(404)
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
  })

  it('403 fuori plesso: la Segreteria di un’altra sede non elimina, e la notifica in coda non si ritira', async () => {
    utente(ALTRA, 'segreteria')
    coda('giustifiche_didattiche:select', { data: riga(), error: null })
    coda('giustifiche_didattiche:delete', { data: [{ id: IMP }], error: null })
    m.assertSezioneInScope.mockResolvedValueOnce(NextResponse.json({ error: 'fuori plesso' }, { status: 403 }))
    const res = await DELETE(del(IMP))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('fuori plesso')
    expect(m.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: ALTRA }), SEZ)
    expect(chiamate('giustifiche_didattiche', 'delete')).toHaveLength(0)
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
    expect(chiamate('notifiche', 'update')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
  })
})
