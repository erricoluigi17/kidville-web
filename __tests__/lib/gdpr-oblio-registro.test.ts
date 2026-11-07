import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'

const logErrore = vi.fn()
const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logErrore: (...a: unknown[]) => logErrore(...a),
  logEvento: (...a: unknown[]) => logEvento(...a),
  logOk: vi.fn(),
}))

import { scriviOblio, svuotaOblio, COPPIE_OBLIO_AMMESSE, BLOCCO_OBLIO } from '@/lib/gdpr/oblio-registro'

/**
 * COMPITO 3.6 · `scriviOblio` / `svuotaOblio`: l'oblio e la retention scrivono il registro dell'anno dall'RPC di M3,
 * con il ripiego (DB della CI senza la funzione, `PGRST202`) che riproduce la CINTURA dell'SQL. Solo uuid finti.
 */

const ID = '44444444-4444-4444-8444-444444444441'
const SOGLIA = '2026-03-01T00:00:00.000Z'

interface Chiamata { metodo: string; args: unknown[] }

/** Un finto client: `rpc` configurabile e un `from` che REGISTRA la catena di filtri del ripiego. */
function finto(rispostaRpc: (nome: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null }, esitoDiretta?: { count?: number; error?: { code?: string } | null }) {
  const catene: Array<{ tabella: string; passi: Chiamata[] }> = []
  const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
    const r = rispostaRpc(nome, args)
    return { data: r.data ?? null, error: r.error ?? null }
  })
  const from = (tabella: string) => {
    const passi: Chiamata[] = []
    catene.push({ tabella, passi })
    const q: Record<string, unknown> = {}
    for (const m of ['update', 'delete', 'in', 'not', 'lt', 'eq', 'neq', 'or']) {
      q[m] = (...args: unknown[]) => { passi.push({ metodo: m, args }); return q }
    }
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: esitoDiretta?.count ?? 1, error: esitoDiretta?.error ?? null }).then(ok)
    return q
  }
  return { client: { rpc, from } as unknown as SupabaseClient, rpc, catene }
}

const MANCA = { code: 'PGRST202', message: 'Could not find the function' }

beforeEach(() => { logErrore.mockClear(); logEvento.mockClear() })

describe('scriviOblio · via RPC', () => {
  it('chiama anno_oblio_scrivi con i parametri giusti e restituisce { ok, righe, via: rpc }', async () => {
    const { client, rpc } = finto(() => ({ data: 3 }))
    const set = { giustificazione_testo: null, note_appello: null }
    const r = await scriviOblio(client, { azione: 'update', tabella: 'presenze', colonnaFiltro: 'alunno_id', valoriFiltro: [ID], set, op: 'gdpr/anonimizza' })
    expect(r).toEqual({ ok: true, righe: 3, via: 'rpc' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('anno_oblio_scrivi', {
      p_azione: 'update', p_tabella: 'presenze', p_colonna: 'alunno_id', p_valori: [ID], p_set: set, p_op: 'gdpr/anonimizza', p_prima_di: null,
    })
  })

  it('p_prima_di solo con la soglia passata; per una delete p_set è null', async () => {
    const { client, rpc } = finto(() => ({ data: 1 }))
    await scriviOblio(client, { azione: 'delete_cestino', tabella: 'student_documents', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST', primaDi: SOGLIA })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_azione: 'delete_cestino', p_set: null, p_prima_di: SOGLIA })
  })

  it('450 valori → 3 chiamate da 200/200/50, e righe è la somma', async () => {
    const { client, rpc } = finto(() => ({ data: 2 }))
    const valori = Array.from({ length: 450 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'galleria_media_v2', colonnaFiltro: 'id', valoriFiltro: valori, op: 'x/y:POST' })
    expect(BLOCCO_OBLIO).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls.map((c) => (c[1] as { p_valori: string[] }).p_valori.length)).toEqual([200, 200, 50])
    expect(r).toEqual({ ok: true, righe: 6, via: 'rpc' })
  })

  it('nessun valore → nessuna chiamata, 0 righe', async () => {
    const { client, rpc } = finto(() => ({ data: 9 }))
    expect(await scriviOblio(client, { azione: 'delete', tabella: 'pagelle', colonnaFiltro: 'id', valoriFiltro: [], op: 'x/y:POST' })).toEqual({ ok: true, righe: 0, via: 'rpc' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('OBLIO_NON_AMMESSO → { ok: false, codice } e logErrore una volta; NESSUN ripiego', async () => {
    const { client, catene } = finto(() => ({ error: { code: 'P0001', message: 'OBLIO_NON_AMMESSO' } }))
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'pagelle', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(r).toEqual({ ok: false, codice: 'OBLIO_NON_AMMESSO' })
    expect(logErrore).toHaveBeenCalledTimes(1)
    expect(catene).toHaveLength(0)
  })

  it('un errore diverso → { ok: false, codice } e logErrore con l\'op; un blocco in errore interrompe i seguenti', async () => {
    let n = 0
    const { client, rpc, catene } = finto(() => (++n === 2 ? { error: { code: '57014', message: 'timeout con "valore-segreto"' } } : { data: 1 }))
    const valori = Array.from({ length: 450 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'galleria_media_v2', colonnaFiltro: 'id', valoriFiltro: valori, op: 'gdpr/retention-galleria:POST' })
    expect(r).toEqual({ ok: false, codice: '57014' })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(catene).toHaveLength(0)
    expect(logErrore).toHaveBeenCalledTimes(1)
    expect(logErrore.mock.calls[0][0]).toMatchObject({ operazione: 'gdpr/retention-galleria:POST' })
    // il messaggio libero dell'errore (che può citare un valore) non entra nel log
    expect(JSON.stringify(logErrore.mock.calls)).not.toContain('valore-segreto')
  })
})

describe('scriviOblio · il ripiego (PGRST202) riproduce la cintura dell\'SQL', () => {
  const passi = (c: Array<{ passi: Chiamata[] }>) => c[0].passi.map((p) => p.metodo)

  it('update: scrive con .update(set).in(colonna, valori), via diretta, una riga info senza valori', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }), { count: 4 })
    const set = { giustificazione_testo: null, note_appello: null }
    const r = await scriviOblio(client, { azione: 'update', tabella: 'presenze', colonnaFiltro: 'alunno_id', valoriFiltro: [ID], set, op: 'gdpr/anonimizza' })
    expect(r).toEqual({ ok: true, righe: 4, via: 'diretta' })
    expect(catene[0].tabella).toBe('presenze')
    expect(catene[0].passi[0]).toEqual({ metodo: 'update', args: [set, { count: 'exact' }] })
    expect(catene[0].passi[1]).toEqual({ metodo: 'in', args: ['alunno_id', [ID]] })
    // il filtro dei siti di oggi: solo le righe che hanno ancora il dato
    expect(catene[0].passi[2]).toEqual({ metodo: 'or', args: ['giustificazione_testo.not.is.null,note_appello.not.is.null'] })
    expect(logErrore).not.toHaveBeenCalled()
    expect(logEvento).toHaveBeenCalledTimes(1)
    expect(logEvento.mock.calls[0][1]).toBe('info')
    expect(JSON.stringify(logEvento.mock.calls)).not.toContain(ID)
  })

  it('update con un valore da scrivere (dettagli): nessun filtro `or`', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    await scriviOblio(client, { azione: 'update', tabella: 'eventi_diario', colonnaFiltro: 'id', valoriFiltro: [ID], set: { dettagli: { a: 1 } }, op: 'x/y:POST' })
    expect(passi(catene)).toEqual(['update', 'in'])
  })

  it('delete_cestino su galleria_media_v2: la catena contiene .not(eliminato_il, is, null)', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    await scriviOblio(client, { azione: 'delete_cestino', tabella: 'galleria_media_v2', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(catene[0].passi).toContainEqual({ metodo: 'not', args: ['eliminato_il', 'is', null] })
    expect(catene[0].passi.some((p) => p.metodo === 'lt')).toBe(false)
  })

  it('delete_cestino su student_documents: cintura .not(...) E .lt(eliminato_il, soglia)', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    await scriviOblio(client, { azione: 'delete_cestino', tabella: 'student_documents', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST', primaDi: SOGLIA })
    expect(catene[0].passi).toContainEqual({ metodo: 'not', args: ['eliminato_il', 'is', null] })
    expect(catene[0].passi).toContainEqual({ metodo: 'lt', args: ['eliminato_il', SOGLIA] })
  })

  it('delete_cestino su student_documents SENZA soglia: rifiutato, niente scritto', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    const r = await scriviOblio(client, { azione: 'delete_cestino', tabella: 'student_documents', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(r).toEqual({ ok: false, codice: 'OBLIO_NON_AMMESSO' })
    expect(catene).toHaveLength(0)
  })

  it('delete su forms_submissions: cintura .eq(signature_log->>_archive_erasure_pending, true)', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    await scriviOblio(client, { azione: 'delete', tabella: 'forms_submissions', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(catene[0].passi).toContainEqual({ metodo: 'eq', args: ['signature_log->>_archive_erasure_pending', true] })
  })

  it('le delete dell\'oblio (senza cintura) NON hanno .not(eliminato_il…): vedono anche le righe vive', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    await scriviOblio(client, { azione: 'delete', tabella: 'galleria_media_v2', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(passi(catene)).toEqual(['delete', 'in'])
  })

  it('una coppia fuori dall\'allowlist non si scrive nemmeno nel ripiego', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }))
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'pagamenti', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(r).toEqual({ ok: false, codice: 'OBLIO_NON_AMMESSO' })
    expect(catene).toHaveLength(0)
  })

  it('un errore del ripiego → { ok: false, codice } e logErrore', async () => {
    const { client } = finto(() => ({ error: MANCA }), { error: { code: '57014' } })
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'pagelle', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(r).toEqual({ ok: false, codice: '57014' })
    expect(logErrore).toHaveBeenCalledTimes(1)
  })

  it('schema assente (tabella che non c\'è nel DB della CI) → ok:false ma solo `info`, come facevano i siti', async () => {
    const { client } = finto(() => ({ error: MANCA }), { error: { code: '42P01' } })
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'pagelle', colonnaFiltro: 'id', valoriFiltro: [ID], op: 'x/y:POST' })
    expect(r).toEqual({ ok: false, codice: '42P01' })
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('450 valori nel ripiego → 3 catene, righe sommate', async () => {
    const { client, catene } = finto(() => ({ error: MANCA }), { count: 5 })
    const valori = Array.from({ length: 450 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const r = await scriviOblio(client, { azione: 'delete', tabella: 'pagelle', colonnaFiltro: 'id', valoriFiltro: valori, op: 'x/y:POST' })
    expect(catene).toHaveLength(3)
    expect(r).toEqual({ ok: true, righe: 15, via: 'diretta' })
  })
})

describe('svuotaOblio', () => {
  it('chiama anno_oblio_svuota con tabella e op', async () => {
    const { client, rpc } = finto(() => ({ data: 7 }))
    expect(await svuotaOblio(client, 'presenze', 'admin/wipe:POST')).toEqual({ ok: true, righe: 7, via: 'rpc' })
    expect(rpc).toHaveBeenCalledWith('anno_oblio_svuota', { p_tabella: 'presenze', p_op: 'admin/wipe:POST' })
  })

  it('OBLIO_NON_AMMESSO → ok:false senza ripiego', async () => {
    const { client, catene } = finto(() => ({ error: { code: 'P0001', message: 'OBLIO_NON_AMMESSO' } }))
    const r = await svuotaOblio(client, 'utenti', 'admin/wipe:POST')
    expect(r).toMatchObject({ ok: false, codice: 'OBLIO_NON_AMMESSO' })
    expect(catene).toHaveLength(0)
  })

  it('PGRST202 → ripiego con le due forme (id e created_at); alunni solo per id', async () => {
    const a = finto(() => ({ error: MANCA }), { count: 2 })
    expect(await svuotaOblio(a.client, 'presenze', 'admin/wipe:POST')).toEqual({ ok: true, righe: 4, via: 'diretta' })
    expect(a.catene).toHaveLength(2)
    const b = finto(() => ({ error: MANCA }), { count: 2 })
    await svuotaOblio(b.client, 'alunni', 'admin/wipe:POST')
    expect(b.catene).toHaveLength(1)
  })

  it('ripiego: tutte le forme in errore → ok:false con gli errori', async () => {
    const { client } = finto(() => ({ error: MANCA }), { error: { code: '42P01' } })
    const r = await svuotaOblio(client, 'presenze', 'admin/wipe:POST')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errori).toHaveLength(2)
  })
})

describe('l\'allowlist TypeScript (ripiego) coincide con il CASE di anno_oblio_scrivi in M3', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261107165503_anno_scrittura.sql'), 'utf8')
  const corpo = sql.slice(sql.indexOf('v_ammessi := CASE'), sql.indexOf('END;', sql.indexOf('v_ammessi := CASE')))
  const nelCase = [...corpo.matchAll(/WHEN '([a-z_]+\|[a-z_0-9]+\|[a-z_]+)'/g)].map((m) => m[1]).sort()

  it('stesse coppie, né una in più né una in meno', () => {
    expect(nelCase.length).toBeGreaterThan(10)
    expect([...COPPIE_OBLIO_AMMESSE].sort()).toEqual(nelCase)
  })
})
