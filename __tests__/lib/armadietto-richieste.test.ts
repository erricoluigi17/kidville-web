import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  stock: vi.fn(),
  soglie: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  vive: { current: [] as unknown[] },
  movimenti: { current: [] as unknown[] },
  erroreInsert: { current: null as { code: string } | null },
}))

vi.mock('@/lib/armadietto/stock', () => ({ stockDiAlunno: h.stock }))
vi.mock('@/lib/armadietto/soglie', () => ({ soglieMateriali: h.soglie }))
vi.mock('@/lib/logging/logger', () => ({ logErrore: h.logErrore, logEvento: h.logEvento }))

/**
 * Il mock DISTINGUE LE TABELLE, e non è un vezzo: `riconciliaTutto` legge l'elenco
 * degli alunni da `armadietto` e le richieste vive da `armadietto_richieste`. Con una
 * lista sola servita a entrambe, le righe `{ alunno_id }` finivano nella mappa delle
 * richieste vive con chiave `undefined` — e da quando esiste lo spazzino delle
 * richieste orfane quella chiave verrebbe letta come «materiale senza soglia» e
 * produrrebbe un'evasione fantasma. Il mock deve somigliare alla realtà, altrimenti
 * il test misura il mock.
 */
function admin() {
  return {
    from: vi.fn((t: string) => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'neq', 'order']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({
        data: { section_id: 'sec1', scuola_id: 'sc1' }, error: null,
      })
      qb.insert = (...a: unknown[]) => {
        h.insert(t, ...a)
        return Promise.resolve({ data: null, error: h.erroreInsert.current })
      }
      qb.update = (...a: unknown[]) => { h.update(t, ...a); return qb }
      qb.then = (r: (v: unknown) => unknown) => Promise.resolve({
        data: t === 'armadietto' ? h.movimenti.current : h.vive.current, error: null,
      }).then(r)
      return qb
    }),
  } as never
}

import { riconciliaRichieste } from '@/lib/armadietto/richieste'

beforeEach(() => {
  vi.clearAllMocks()
  h.vive.current = []
  h.movimenti.current = []
  h.erroreInsert.current = null
  h.soglie.mockResolvedValue({ Pannolini: { allerta: 5, emergenza: 2 } })
})

describe('riconciliaRichieste', () => {
  it('apre GIALLO quando lo stock tocca la soglia di allerta', async () => {
    h.stock.mockResolvedValue({ Pannolini: 5 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ materiale: 'Pannolini', livello: 'giallo', quantita_residua: 5, stato: 'aperta' }))
  })

  it('apre ROSSO alla soglia di emergenza', async () => {
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }))
  })

  it('sopra soglia non apre niente', async () => {
    h.stock.mockResolvedValue({ Pannolini: 6 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('chiude quando il carico riporta lo stock sopra soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 32 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ stato: 'evasa' }))
  })

  it('promuove giallo → rosso', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'giallo', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 1 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }))
  })

  it('NON declassa rosso → giallo: un allarme dato non si ritira', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 4 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    const arg = h.update.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
    expect(arg?.livello).not.toBe('giallo')
  })

  it('non riapre una presa_in_carico finche resta sotto soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'presa_in_carico' }]
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('stock illeggibile → non fa NIENTE, non chiude a vuoto', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue(null)
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('materiale senza soglia configurata: nessuna richiesta', async () => {
    h.stock.mockResolvedValue({ Sconosciuto: 0 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('23505 sull apertura e la guardia che ha funzionato, non un guasto', async () => {
    // Un'altra scrittura ha gia' aperto quella richiesta e l'indice unico parziale
    // ha impedito il doppione: e' il suo mestiere. Non e' un errore da segnalare, e
    // NON e' un'apertura di questa passata.
    h.erroreInsert.current = { code: '23505' }
    h.stock.mockResolvedValue({ Pannolini: 2 })
    const esito = await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.insert).toHaveBeenCalled()
    expect(esito.aperte).toBe(0)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('un errore di insert che NON e 23505 resta un errore', async () => {
    // Il contro-test del precedente: senza, «23505 e' benigno» diventerebbe
    // «qualunque fallimento e' benigno», e le aperture morirebbero in silenzio.
    h.erroreInsert.current = { code: '42703' }
    h.stock.mockResolvedValue({ Pannolini: 2 })
    const esito = await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(esito.aperte).toBe(0)
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('evade la richiesta viva di un materiale che la segreteria non traccia piu', async () => {
    // 'Cambio' non e' piu in `soglie`: tolto da `locker_config`. Il ciclo itera
    // sulle soglie, quindi nessun ramo la guarderebbe e resterebbe aperta per
    // sempre, chiedendo al genitore una cosa che la scuola non traccia piu.
    h.vive.current = [{ id: 'r9', materiale: 'Cambio', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 30 })
    const esito = await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ stato: 'evasa' }))
    expect(esito.evase).toBe(1)
  })

  it('«non piu tracciato» e «e arrivato» non si confondono nei log', async () => {
    // Due chiusure, due ragioni diverse. Se il log le mettesse sulla stessa
    // etichetta, «quante richieste ha chiuso il rifornimento?» conterebbe insieme
    // roba portata dalle famiglie e roba cancellata dalla segreteria.
    h.vive.current = [{ id: 'r9', materiale: 'Cambio', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 30 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info',
      expect.objectContaining({ esito: 'materiale-non-piu-tracciato' }))
  })
})

describe('riconciliaTutto', () => {
  it('riconcilia ogni alunno con movimenti, non solo quelli mossi di recente', async () => {
    // La segreteria ieri ha alzato una soglia da 5 a 8: le richieste devono
    // comparire stamattina anche se nessun bambino si e' mosso.
    h.movimenti.current = [{ alunno_id: 'a1' }, { alunno_id: 'a2' }, { alunno_id: 'a1' }]
    h.stock.mockResolvedValue({ Pannolini: 6 })
    h.soglie.mockResolvedValue({ Pannolini: { allerta: 8, emergenza: 3 } })
    const { riconciliaTutto } = await import('@/lib/armadietto/richieste')
    const esito = await riconciliaTutto(admin())
    expect(esito.alunni).toBe(2)      // a1 una volta sola
    expect(esito.aperte).toBe(2)
  })
})
