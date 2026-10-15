import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eseguiRitiroGiornate } from '@/lib/primaria/ritiro-notifiche'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
const log = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
let db: DBFinto
const costruisci = () => creaFintoSupabase(db).from('notifiche').delete().eq('entita_id', 'fonte-sede-a').select('id')
const opts = { giorni: ['2026-10-25'], storica: true, operazione: 'test/ritiro-storico' }
beforeEach(() => {
  vi.clearAllMocks()
  const base = { entita_id: 'fonte-sede-a', giorno_competenza: '2026-10-25', politica_operazione: null, push_inviata_il: null, push_presa_scade_il: null }
  db = { notifiche: [
    { ...base, id: 'pending' },
    { ...base, id: 'claim', push_inviata_il: '2026-10-26T09:00:00Z', push_presa_scade_il: '2026-10-26T09:10:00Z' },
    { ...base, id: 'finalizzata', push_inviata_il: '2026-10-26T09:00:00Z' },
    { ...base, id: 'altro-giorno', giorno_competenza: '2026-10-26', push_inviata_il: '2026-10-26T09:00:00Z', push_presa_scade_il: '2026-10-26T09:10:00Z' },
    { ...base, id: 'altra-sede', entita_id: 'fonte-sede-b', push_inviata_il: '2026-10-26T09:00:00Z', push_presa_scade_il: '2026-10-26T09:10:00Z' },
  ] }
})
describe('ritiro storico — claim recuperabili e invii finalizzati', () => {
  it('ritira pending e claim del fatto storico, preservando finalizzate, altro giorno e fonte di altra sede', async () => {
    const r = await eseguiRitiroGiornate(costruisci, opts)
    expect(r.error).toBeNull()
    expect(db.notifiche.map(n => n.id)).toEqual(['finalizzata', 'altro-giorno', 'altra-sede'])
  })
  it('il ritiro ordinario conserva anche il claim della stessa giornata', async () => {
    expect((await eseguiRitiroGiornate(costruisci, { ...opts, storica: false })).error).toBeNull()
    expect(db.notifiche.map(n => n.id)).toEqual(['claim', 'finalizzata', 'altro-giorno', 'altra-sede'])
  })
  it.each(['42703', 'PGRST204'])('schema senza lease: %s nominato produce fallback solo NULL e avviso compatibilità', async code => {
    const filtri: string[] = []
    const ricostruisci = () => {
      const query = costruisci()
      let filtro = ''
      const simulata = {
        is: (colonna: 'push_inviata_il', valore: null) => { query.is(colonna, valore); return simulata },
        or: (v: string) => { filtro = v; filtri.push(v); query.or(v); return simulata },
        then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => filtro.includes('push_presa_scade_il')
          ? Promise.resolve({ data: null, error: { code, message: 'column notifiche.push_presa_scade_il does not exist' } }).then(ok, ko)
          : query.then(ok, ko),
      }
      return simulata as never
    }
    const r = await eseguiRitiroGiornate(ricostruisci, opts)
    expect(r.error).toBeNull()
    expect(filtri).toHaveLength(2)
    expect(filtri[1]).not.toContain('push_presa_scade_il')
    expect(db.notifiche.map(n => n.id)).toEqual(['claim', 'finalizzata', 'altro-giorno', 'altra-sede'])
    expect(log.logEvento).toHaveBeenCalledWith('notifica', 'warn', expect.objectContaining({ esito: 'ritiro-schema-precedente' }), expect.objectContaining({ code }))
  })
  it.each([
    { code: '57014', message: 'timeout nominando push_presa_scade_il' },
    { code: '42703', message: 'column altra_colonna does not exist' },
  ])('non applica fallback a errori diversi o colonne non riconosciute %o', async error => {
    const tentativi = vi.fn(() => {
      const query = {
        or: () => query,
        is: () => query,
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ error, data: null }).then(ok),
      }
      return query as never
    })
    expect((await eseguiRitiroGiornate(tentativi, opts)).error).toEqual(error)
    expect(tentativi).toHaveBeenCalledTimes(1)
    expect(db.notifiche).toHaveLength(5)
    expect(log.logEvento).not.toHaveBeenCalled()
  })
})
