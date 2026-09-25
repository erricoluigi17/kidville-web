import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── V1 (spec 2026-09-24) — valutazioni della primaria: PATCH, DELETE e i flag
// `modificabile`/`bloccata` della GET. Il permesso passa dal VERO
// `permesso-voce` (autore, termine sulla data di Roma di `creato_il`, sblocchi):
// qui si finge solo il database, e ogni scrittura è registrata con i suoi filtri,
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
        qb.select = (cols?: string) => { if (c.op === 'select') c.cols = cols; return qb }
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
  logScrittura: vi.fn(),
  notificaTitolariScrittura: vi.fn(),
  obiettiviDisponibili: vi.fn(),
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: m.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: m.assertSezioneInScope,
  assertAlunnoInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: m.logScrittura }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockResolvedValue({ valutatoreId: 'maestra-1', response: null }),
}))
vi.mock('@/lib/primaria/giudizio', () => ({ renderGiudizioDescrittivo: vi.fn().mockResolvedValue('Giudizio auto') }))
// La PATCH usa la lettura VERA (`leggiObiettiviDisponibili`) sul database
// finto: così una lettura fallita di `obiettivi_apprendimento` arriva davvero
// alla route, invece di un vuoto già masticato dal mock.
vi.mock('@/lib/primaria/obiettivi', async (orig) => ({
  ...(await orig<typeof import('@/lib/primaria/obiettivi')>()),
  obiettiviDisponibili: m.obiettiviDisponibili,
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: vi.fn().mockResolvedValue(undefined),
  notificaTitolariScrittura: m.notificaTitolariScrittura,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: m.logEvento,
}))

import { GET, PATCH, DELETE } from '@/app/api/primaria/valutazioni/route'
import { NextRequest } from 'next/server'

const VAL = '5a15a15a-5a15-45a1-85a1-5a15a15a15a1'
const SEZ = '0e20e2e2-0e2e-40e2-8e2e-0e2e2e2e2e21'
const SEDE = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'
const MAT = '3a73a73a-3a7a-43a7-8a73-a73a73a73a71'
const ALU = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const AUTORE = 'd0c0d0c0-d0c0-4d0c-8d0c-d0c0d0c0d0c0'
const ALTRA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'

const GIORNO = 86_400_000
const faGiorni = (n: number) => new Date(Date.now() - n * GIORNO).toISOString()

function riga(over: Record<string, unknown> = {}) {
  return {
    id: VAL, alunno_id: ALU, maestra_id: AUTORE, section_id: SEZ, materia: 'Matematica', materia_id: MAT,
    tipo: 'orale', modalita: 'sintetico', argomento: 'Tabelline',
    dim_autonomia: null, dim_continuita: null, dim_tipologia: null, dim_risorse: null,
    giudizio_sintetico: 'Buono', giudizio_testo: null, annotazione_numerica: null,
    lock_tipo: 'classe_orale', pubblicato: false, creato_il: faGiorni(0),
    valutazione_obiettivi: [{ obiettivo_id: 'o-1' }, { obiettivo_id: 'o-2' }],
    sections: { scuola_id: SEDE },
    ...over,
  }
}

function coda(key: string, ...r: Array<{ data: unknown; error: unknown }>) {
  h.state.risposte[key] = [...(h.state.risposte[key] ?? []), ...r]
}

function utente(id: string, role: string) {
  m.requireDocente.mockResolvedValue({ user: { id, role, scuola_id: SEDE }, response: null })
}

function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/primaria/valutazioni?userId=${AUTORE}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
function del(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/primaria/valutazioni?id=${id}&userId=${AUTORE}`, { method: 'DELETE' })
}

const chiamate = (table: string, op: string) => h.state.chiamate.filter((c) => c.table === table && c.op === op)
const filtro = (c: { filtri: unknown[][] }, metodo: string, colonna: string) =>
  c.filtri.find((f) => f[0] === metodo && f[1] === colonna)

const DISPONIBILI = ['o-1', 'o-2', 'o-3'].map((id) => ({ id, codice: id, descrizione: 'x', livello: 1 }))

const CORPO = { id: VAL, modalita: 'sintetico', giudizioSintetico: 'Ottimo', argomento: '  Divisioni  ', obiettiviIds: ['o-2', 'o-3'] }

beforeEach(() => {
  vi.clearAllMocks()
  h.state.risposte = {}
  h.state.chiamate = []
  utente(AUTORE, 'educator')
  m.assertSezioneInScope.mockResolvedValue(null)
  m.logScrittura.mockResolvedValue(undefined)
  m.notificaTitolariScrittura.mockResolvedValue(undefined)
  m.obiettiviDisponibili.mockResolvedValue([{ id: 'o-1' }, { id: 'o-2' }, { id: 'o-3' }])
  coda('materie:select', { data: { nome: 'Matematica', codice: 'matematica', scuola_id: SEDE }, error: null })
  coda('obiettivi_apprendimento:select', { data: DISPONIBILI, error: null })
})

describe('PATCH /api/primaria/valutazioni', () => {
  it("l'autore entro il termine riscrive la voce, sostituisce SOLO la differenza degli obiettivi e allinea la notifica in coda", async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:update', { data: [{ ...riga(), giudizio_sintetico: 'Ottimo' }], error: null })

    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(200)

    // Scope sulla classe della voce, prima di scrivere.
    expect(m.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: AUTORE }), SEZ)

    const [upd] = chiamate('valutazioni', 'update')
    expect(upd.payload).toMatchObject({
      argomento: 'Divisioni', modalita: 'sintetico', giudizio_sintetico: 'Ottimo',
      tipo: 'orale', lock_tipo: 'classe_orale', annotazione_numerica: null,
    })
    expect(filtro(upd, 'eq', 'id')?.[2]).toBe(VAL)
    expect(filtro(upd, 'eq', 'section_id')?.[2]).toBe(SEZ)

    // o-1 via, o-3 dentro, o-2 resta.
    const [tolti] = chiamate('valutazione_obiettivi', 'delete')
    expect(filtro(tolti, 'eq', 'valutazione_id')?.[2]).toBe(VAL)
    expect(filtro(tolti, 'in', 'obiettivo_id')?.[2]).toEqual(['o-1'])
    const [aggiunti] = chiamate('valutazione_obiettivi', 'insert')
    expect(aggiunti.payload).toEqual([{ valutazione_id: VAL, obiettivo_id: 'o-3' }])
    // Prima si aggiunge, poi si toglie: un guasto a metà non lascia mai zero obiettivi.
    expect(h.state.chiamate.indexOf(aggiunti)).toBeLessThan(h.state.chiamate.indexOf(tolti))

    // La notifica ANCORA IN CODA (e solo quella) prende il giudizio nuovo.
    const [notif] = chiamate('notifiche', 'update')
    expect(notif.payload).toEqual({ corpo: 'Ottimo' })
    expect(filtro(notif, 'eq', 'entita_id')?.[2]).toBe(VAL)
    expect(filtro(notif, 'eq', 'entita_tipo')?.[2]).toBe('valutazione')
    expect(filtro(notif, 'is', 'push_inviata_il')?.[2]).toBeNull()
    // Nessun avviso NUOVO al genitore.
    expect(chiamate('notifiche', 'insert')).toHaveLength(0)

    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'valutazione', entitaId: VAL, azione: 'update', scuolaId: SEDE, sectionId: SEZ,
      valorePrima: expect.objectContaining({ giudizio_sintetico: 'Buono', obiettivi_ids: ['o-1', 'o-2'] }),
      valoreDopo: expect.objectContaining({ obiettivi_ids: ['o-2', 'o-3'] }),
    }))
    // Il successo si logga.
    expect(m.logEvento).toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'valutazione-modificata', valutazione_id: VAL }), undefined, expect.anything())
  })

  it('403 VOCE_NON_AUTORE a un docente che non è l’autore: nessuna scrittura', async () => {
    utente(ALTRA, 'educator')
    coda('valutazioni:select', { data: riga(), error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VOCE_NON_AUTORE')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
  })

  it('la Segreteria modifica la voce di un docente entro il termine', async () => {
    utente(ALTRA, 'segreteria')
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:update', { data: [riga()], error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(200)
    expect(chiamate('valutazioni', 'update')).toHaveLength(1)
  })

  it('423 VOCE_BLOCCATA oltre il termine (orale di 5 giorni fa), anche per la Direzione', async () => {
    utente(ALTRA, 'admin')
    coda('valutazioni:select', { data: riga({ creato_il: faGiorni(5) }), error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(423)
    const body = await res.json()
    expect(body.codice).toBe('VOCE_BLOCCATA')
    expect(body.giorniLimite).toBe(2)
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
  })

  it('oltre il termine ma sbloccata per voce: passa', async () => {
    coda('valutazioni:select', { data: riga({ creato_il: faGiorni(5) }), error: null })
    coda('sblocchi_audit:select', { data: [{ entita_tipo: 'valutazione', entita_id: VAL }], error: null })
    coda('valutazioni:update', { data: [riga()], error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(200)
    expect(chiamate('valutazioni', 'update')).toHaveLength(1)
  })

  it('una scritta di 10 giorni fa (termine 15) si modifica, e senza tipoProva resta scritta', async () => {
    coda('valutazioni:select', { data: riga({ tipo: 'scritto', lock_tipo: 'scritto_pratico', creato_il: faGiorni(10) }), error: null })
    coda('valutazioni:update', { data: [riga()], error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(200)
    expect(chiamate('valutazioni', 'update')[0].payload).toMatchObject({ tipo: 'scritto', lock_tipo: 'scritto_pratico' })
  })

  it('trasformarla in orale a 10 giorni: il termine è quello della voce com’è (lo stesso della GET), quindi passa', async () => {
    coda('valutazioni:select', { data: riga({ tipo: 'scritto', lock_tipo: 'scritto_pratico', creato_il: faGiorni(10) }), error: null })
    coda('valutazioni:update', { data: [riga({ tipo: 'orale' })], error: null })
    const res = await PATCH(patch({ ...CORPO, tipoProva: 'orale' }))
    expect(res.status).toBe(200)
    expect(chiamate('valutazioni', 'update')[0].payload).toMatchObject({ tipo: 'orale', lock_tipo: 'classe_orale' })
    // Un solo controllo dei termini: nessun secondo giro sul tipo nuovo.
    expect(chiamate('admin_settings', 'select')).toHaveLength(1)
  })

  it('404 VALUTAZIONE_NON_TROVATA se la voce non c’è (o non è della primaria)', async () => {
    coda('valutazioni:select', { data: null, error: null })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VALUTAZIONE_NON_TROVATA')
    const [lettura] = chiamate('valutazioni', 'select')
    expect(filtro(lettura, 'not', 'modalita')).toEqual(['not', 'modalita', 'is', null])
  })

  it('la classe fuori scope risponde con il rifiuto di scope, senza leggere i permessi', async () => {
    // Voce oltre il termine: se il permesso venisse letto (prima o invece dello
    // scope), si vedrebbero le letture dei termini e degli sblocchi.
    coda('valutazioni:select', { data: riga({ creato_il: faGiorni(5) }), error: null })
    const { NextResponse } = await import('next/server')
    m.assertSezioneInScope.mockResolvedValue(NextResponse.json({ error: 'x', codice: 'SEDE_NON_ACCESSIBILE' }, { status: 403 }))
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
    expect(chiamate('admin_settings', 'select')).toHaveLength(0)
    expect(chiamate('sblocchi_audit', 'select')).toHaveLength(0)
    expect(chiamate('utenti_sezioni', 'select')).toHaveLength(0)
  })

  it('400 con codice sugli obiettivi: mancanti o non validi', async () => {
    coda('valutazioni:select', { data: riga(), error: null }, { data: riga(), error: null })
    coda('materie:select', { data: { nome: 'Matematica', codice: 'matematica', scuola_id: SEDE }, error: null })
    coda('obiettivi_apprendimento:select', { data: DISPONIBILI, error: null })
    const r1 = await PATCH(patch({ ...CORPO, obiettiviIds: [] }))
    expect(r1.status).toBe(400)
    expect((await r1.json()).codice).toBe('VALUTAZIONE_OBIETTIVO_MANCANTE')
    const r2 = await PATCH(patch({ ...CORPO, obiettiviIds: ['o-XX'] }))
    expect(r2.status).toBe(400)
    expect((await r2.json()).codice).toBe('VALUTAZIONE_OBIETTIVO_NON_VALIDO')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
  })

  it('stessa validazione della POST: modalità sintetico senza giudizio è 400', async () => {
    const res = await PATCH(patch({ ...CORPO, giudizioSintetico: null }))
    expect(res.status).toBe(400)
    expect(chiamate('valutazioni', 'select')).toHaveLength(0)
  })

  it('500 con codice se la sostituzione degli obiettivi fallisce (non un 200 bugiardo), ma audit e notifica ci sono', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:update', { data: [{ ...riga(), giudizio_sintetico: 'Ottimo' }], error: null })
    coda('valutazione_obiettivi:delete', { data: null, error: { code: '57014', message: 'timeout' } })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VALUTAZIONE_OBIETTIVI_NON_AGGIORNATI')

    // La riga `valutazioni` è già riscritta: la rettifica resta tracciata, col
    // giudizio ORIGINALE (al nuovo tentativo la voce letta sarebbe già quella
    // nuova) e con gli obiettivi davvero presenti dopo il passo fallito: o-3 è
    // entrato, o-1 non è uscito.
    expect(m.logScrittura).toHaveBeenCalledTimes(1)
    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      azione: 'update', entitaId: VAL,
      valorePrima: expect.objectContaining({ giudizio_sintetico: 'Buono', obiettivi_ids: ['o-1', 'o-2'] }),
      valoreDopo: expect.objectContaining({ giudizio_sintetico: 'Ottimo', obiettivi_ids: ['o-1', 'o-2', 'o-3'] }),
    }))
    // La notifica in coda non parte col giudizio vecchio.
    const [notif] = chiamate('notifiche', 'update')
    expect(notif.payload).toEqual({ corpo: 'Ottimo' })
    expect(filtro(notif, 'is', 'push_inviata_il')?.[2]).toBeNull()
    // Niente log di successo.
    expect(m.logEvento).not.toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'valutazione-modificata' }), undefined, expect.anything())
    expect(m.logEvento).toHaveBeenCalledWith('db', 'error',
      expect.objectContaining({ esito: 'valutazione_obiettivi_non_sostituiti', valutazione_id: VAL }), expect.anything())
  })

  it('insert degli obiettivi fallito: nessun delete (la voce non resta mai senza obiettivi) e audit con quelli di prima', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:update', { data: [{ ...riga(), giudizio_sintetico: 'Ottimo' }], error: null })
    coda('valutazione_obiettivi:insert', { data: null, error: { code: '57014', message: 'timeout' } })
    // Si sostituisce TUTTO: o-1 e o-2 via, o-3 dentro. Col vecchio ordine
    // delete→insert la voce sarebbe rimasta con zero obiettivi.
    const res = await PATCH(patch({ ...CORPO, obiettiviIds: ['o-3'] }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VALUTAZIONE_OBIETTIVI_NON_AGGIORNATI')
    expect(chiamate('valutazione_obiettivi', 'insert')).toHaveLength(1)
    expect(chiamate('valutazione_obiettivi', 'delete')).toHaveLength(0)
    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      azione: 'update',
      valorePrima: expect.objectContaining({ giudizio_sintetico: 'Buono' }),
      valoreDopo: expect.objectContaining({ obiettivi_ids: ['o-1', 'o-2'] }),
    }))
    expect(chiamate('notifiche', 'update')).toHaveLength(1)
  })

  it('obiettivi disponibili NON letti: 500 LETTURA_FALLITA prima di qualunque scrittura (non «nessuno configurato»)', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    h.state.risposte['obiettivi_apprendimento:select'] = [{ data: null, error: { code: '57014', message: 'timeout' } }]
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
    expect(chiamate('valutazione_obiettivi', 'delete')).toHaveLength(0)
    expect(chiamate('valutazione_obiettivi', 'insert')).toHaveLength(0)
    expect(chiamate('notifiche', 'update')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
    expect(m.logEvento).toHaveBeenCalledWith('registro', 'error',
      expect.objectContaining({ esito: 'obiettivi-disponibili-non-letti', valutazione_id: VAL }), expect.anything())
  })

  it('anche la classe illeggibile (livello) è una lettura fallita, non «tutti i livelli»', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('sections:select', { data: null, error: { code: '57014', message: 'timeout' } })
    const res = await PATCH(patch(CORPO))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
  })

  it('un obiettivo GIÀ collegato e poi disattivato resta valido: nessun 400, e non si stacca', async () => {
    coda('valutazioni:select', { data: riga(), error: null }) // collegati: o-1, o-2
    // o-1 non è più fra i disponibili (disattivato o cambiato di livello).
    h.state.risposte['obiettivi_apprendimento:select'] = [{ data: DISPONIBILI.filter((o) => o.id !== 'o-1'), error: null }]
    coda('valutazioni:update', { data: [riga()], error: null })
    const res = await PATCH(patch({ ...CORPO, obiettiviIds: ['o-1', 'o-2'] }))
    expect(res.status).toBe(200)
    expect(chiamate('valutazione_obiettivi', 'delete')).toHaveLength(0)
    expect(chiamate('valutazione_obiettivi', 'insert')).toHaveLength(0)
    expect((await res.json()).data.obiettivi_ids).toEqual(['o-1', 'o-2'])
  })

  it('un obiettivo NUOVO non disponibile resta 400, anche se un altro è già collegato', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    h.state.risposte['obiettivi_apprendimento:select'] = [{ data: DISPONIBILI.filter((o) => o.id !== 'o-3'), error: null }]
    const res = await PATCH(patch({ ...CORPO, obiettiviIds: ['o-1', 'o-3'] }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('VALUTAZIONE_OBIETTIVO_NON_VALIDO')
    expect(chiamate('valutazioni', 'update')).toHaveLength(0)
  })
})

describe('DELETE /api/primaria/valutazioni', () => {
  it('cancella la voce, ritira SOLO la notifica ancora in coda e scrive l’audit', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:delete', { data: [{ id: VAL }], error: null })
    coda('notifiche:delete', { data: [{ id: 'n-1' }, { id: 'n-2' }], error: null })

    const res = await DELETE(del(VAL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ id: VAL, notificheRitirate: 2 })

    const [cancella] = chiamate('valutazioni', 'delete')
    expect(filtro(cancella, 'eq', 'id')?.[2]).toBe(VAL)
    expect(filtro(cancella, 'eq', 'section_id')?.[2]).toBe(SEZ)
    // Le righe valutazione_obiettivi vanno via con la FK a cascata: nessun delete a mano.
    expect(chiamate('valutazione_obiettivi', 'delete')).toHaveLength(0)

    const [ritiro] = chiamate('notifiche', 'delete')
    expect(filtro(ritiro, 'eq', 'entita_tipo')?.[2]).toBe('valutazione')
    expect(filtro(ritiro, 'eq', 'entita_id')?.[2]).toBe(VAL)
    // Una notifica già partita resta: il filtro è sulla coda.
    expect(filtro(ritiro, 'is', 'push_inviata_il')?.[2]).toBeNull()
    // Nessun avviso di rettifica.
    expect(chiamate('notifiche', 'insert')).toHaveLength(0)

    expect(m.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entitaTipo: 'valutazione', entitaId: VAL, azione: 'delete', valoreDopo: null, sectionId: SEZ, scuolaId: SEDE,
      valorePrima: expect.objectContaining({ giudizio_sintetico: 'Buono', obiettivi_ids: ['o-1', 'o-2'] }),
    }))
    expect(m.logEvento).toHaveBeenCalledWith('registro', 'info',
      expect.objectContaining({ esito: 'valutazione-eliminata', notifiche_ritirate: 2 }), undefined, expect.anything())
  })

  it('423 oltre il termine: né la voce né la notifica si toccano', async () => {
    coda('valutazioni:select', { data: riga({ creato_il: faGiorni(4) }), error: null })
    const res = await DELETE(del(VAL))
    expect(res.status).toBe(423)
    expect(chiamate('valutazioni', 'delete')).toHaveLength(0)
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
  })

  it('403 a chi non è l’autore', async () => {
    utente(ALTRA, 'educator')
    coda('valutazioni:select', { data: riga(), error: null })
    const res = await DELETE(del(VAL))
    expect(res.status).toBe(403)
    expect(chiamate('valutazioni', 'delete')).toHaveLength(0)
  })

  it('cancellazione fallita: 500 con codice e la notifica NON si ritira', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:delete', { data: null, error: { code: '40001', message: 'x' } })
    const res = await DELETE(del(VAL))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VALUTAZIONE_NON_ELIMINATA')
    expect(chiamate('notifiche', 'delete')).toHaveLength(0)
    expect(m.logScrittura).not.toHaveBeenCalled()
  })

  it('ritiro della notifica fallito: la cancellazione resta riuscita, ma si logga error', async () => {
    coda('valutazioni:select', { data: riga(), error: null })
    coda('valutazioni:delete', { data: [{ id: VAL }], error: null })
    coda('notifiche:delete', { data: null, error: { code: '57014', message: 'timeout' } })
    const res = await DELETE(del(VAL))
    expect(res.status).toBe(200)
    expect(m.logEvento).toHaveBeenCalledWith('notifica', 'error',
      expect.objectContaining({ esito: 'ritiro-notifica-valutazione-fallito', valutazione_id: VAL }), expect.anything())
  })

  it('id non uuid: 400 senza leggere niente', async () => {
    const res = await DELETE(del('non-un-uuid'))
    expect(res.status).toBe(400)
    expect(h.state.chiamate).toHaveLength(0)
  })
})

describe('GET /api/primaria/valutazioni — modificabile e bloccata per voce', () => {
  function get(): NextRequest {
    return new NextRequest(`http://localhost/api/primaria/valutazioni?alunnoId=${ALU}&userId=${AUTORE}`)
  }
  const MIA_RECENTE = 'aaaaaaaa-0000-4000-8000-000000000001'
  const MIA_VECCHIA = 'aaaaaaaa-0000-4000-8000-000000000002'
  const ALTRUI = 'aaaaaaaa-0000-4000-8000-000000000003'

  it('ogni voce porta i suoi flag, e l’embed della sede non esce', async () => {
    coda('valutazioni:select', {
      data: [
        riga({ id: MIA_RECENTE }),
        riga({ id: MIA_VECCHIA, creato_il: faGiorni(6) }),
        riga({ id: ALTRUI, maestra_id: ALTRA }),
      ],
      error: null,
    })
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.statoVociDisponibile).toBe(true)
    const per = new Map((body.data as Array<Record<string, unknown>>).map((v) => [v.id, v]))
    expect(per.get(MIA_RECENTE)).toMatchObject({ modificabile: true, bloccata: false, giorniLimite: 2 })
    expect(per.get(MIA_VECCHIA)).toMatchObject({ modificabile: false, bloccata: true })
    expect(per.get(ALTRUI)).toMatchObject({ modificabile: false, bloccata: false })
    expect(per.get(MIA_RECENTE)).not.toHaveProperty('sections')
  })

  it('i permessi illeggibili non tolgono l’elenco: niente bottoni e flag dichiarato', async () => {
    coda('valutazioni:select', { data: [riga({ id: MIA_RECENTE })], error: null })
    coda('admin_settings:select', { data: null, error: { code: '57014', message: 'timeout' } })
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.statoVociDisponibile).toBe(false)
    expect(body.data[0]).toMatchObject({ id: MIA_RECENTE, modificabile: false, bloccata: false })
  })
})
