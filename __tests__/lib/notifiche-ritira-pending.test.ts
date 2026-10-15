import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { politicaNotificaOperazione } from '@/lib/storici/retroattivita'

const h = vi.hoisted(() => ({ legami: vi.fn(), toggle: vi.fn(), log: vi.fn() }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunniEsito: h.legami }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: h.toggle }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log }))

import { ritiraNotifichePending, ritiraPendingOperazione } from '@/lib/notifiche/ritira-pending'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { enqueueNotifiche } from '@/lib/push/enqueue'

const politica = (originale = '2026-10-14', nuovo = originale) => politicaNotificaOperazione({
  attore: { id: 'staff', role: 'segreteria' }, giornoCompetenza: nuovo, giornoOriginale: originale,
  ora: new Date('2026-10-14T22:06:00Z'),
})
const base = (id: string, extra: Riga = {}): Riga => ({
  id, tipo: 'avviso', entita_tipo: 'avviso', entita_id: 'fonte', utente_id: 'genitore',
  giorno_competenza: null, politica_operazione: null, push_inviata_il: null,
  creato_il: '2026-10-14T21:55:00Z', invio_programmato_il: '2026-10-14T22:05:00Z', ...extra,
})
const params = () => ({ tipo: 'avviso', entitaTipo: 'avviso', entitaId: 'fonte', utenteIds: ['genitore'], giorniOriginali: ['2026-10-14'] })
const ids = (db: DBFinto) => db.notifiche.map(n => n.id)

/** Lo schema rifiuta la query PRIMA che il finto applichi una delete. */
function schemaPrecedente(db: DBFinto, assenti: string[], filtri: string[], codice = '42703') {
  const reale = creaFintoSupabase(db)
  return { from(tabella: string) {
    let builder: object = reale.from(tabella)
    let filtro = ''
    const proxy: object = new Proxy({}, { get(_target, nome) {
      if (nome === 'then') return (risolvi: (v: unknown) => unknown, rifiuta: (e: unknown) => unknown) => {
        const assente = assenti.find(c => filtro.includes(c))
        if (assente) return Promise.resolve({ data: null, error: { code: codice, message: `column notifiche.${assente} does not exist` } }).then(risolvi, rifiuta)
        return Promise.resolve(builder).then(risolvi, rifiuta)
      }
      return (...args: unknown[]) => {
        if (nome === 'or') { filtro = String(args[0]); filtri.push(filtro) }
        const metodo = Reflect.get(builder, nome)
        if (typeof metodo !== 'function') throw new Error(`Metodo finto non previsto: ${String(nome)}`)
        builder = Reflect.apply(metodo, builder, args)
        return proxy
      }
    } })
    return proxy
  } } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  h.legami.mockResolvedValue({ perAlunno: new Map([['figlio', ['genitore']]]), completo: true })
  h.toggle.mockResolvedValue(true)
})

describe('ritiro pending servizi — righe reali filtrate', () => {
  it('ritira il legacy creato ieri oltre la mezzanotte di invio, con precedenza moderna e isolamento del fatto', async () => {
    const db = { notifiche: [
      base('legacy-ieri'), base('legacy-oggi', { creato_il: '2026-10-14T22:00:00Z' }),
      base('colonna-ieri', { giorno_competenza: '2026-10-14', politica_operazione: { giornoCompetenza: '2026-10-15' }, creato_il: '2026-10-15T10:00:00Z' }),
      base('colonna-oggi', { giorno_competenza: '2026-10-15', politica_operazione: { giornoCompetenza: '2026-10-14' } }),
      base('politica-ieri', { politica_operazione: { giornoCompetenza: '2026-10-14' }, creato_il: '2026-10-15T10:00:00Z' }),
      base('politica-oggi', { politica_operazione: { giornoCompetenza: '2026-10-15' } }),
      base('politica-incompleta', { politica_operazione: {} }),
      base('inviata', { push_inviata_il: '2026-10-14T22:05:00Z' }),
      base('altro-genitore', { utente_id: 'altra-famiglia' }), base('altra-fonte', { entita_id: 'altra' }),
      base('altro-tipo', { tipo: 'avviso_risposta' }), base('altra-entita', { entita_tipo: 'chat' }),
    ] }
    expect(await ritiraNotifichePending(creaFintoSupabase(db), params())).toBe(true)
    expect(ids(db)).toEqual(['legacy-oggi', 'colonna-oggi', 'politica-oggi', 'politica-incompleta', 'inviata', 'altro-genitore', 'altra-fonte', 'altro-tipo', 'altra-entita'])
  })

  it.each(['trigger', 'enqueue'] as const)('%s ritira prima del return silenzioso anche con toggle spento', async percorso => {
    h.toggle.mockResolvedValue(false)
    const db = { notifiche: [base('ieri'), base('oggi', { creato_il: '2026-10-14T22:00:00Z' })] }
    const input = { ...params(), titolo: 'Avviso', operazione: politica(), destinatario: 'genitore' as const }
    if (percorso === 'trigger') await notificaEvento(creaFintoSupabase(db), input)
    else expect(await enqueueNotifiche(creaFintoSupabase(db), input)).toBe(false)
    expect(ids(db)).toEqual(['oggi'])
    expect(h.toggle).not.toHaveBeenCalled()
  })

  it.each(['trigger', 'enqueue'] as const)('%s ritira anche claim non finalizzati e preserva consegne definitive e altri perimetri', async percorso => {
    const claim = { push_inviata_il: '2026-10-14T22:06:00Z', push_presa_scade_il: '2026-10-14T22:11:00Z' }
    const db = { notifiche: [
      base('pending'), base('claim', claim), base('claim-scaduto', { ...claim, push_presa_scade_il: '2026-10-14T22:05:00Z' }),
      base('finalizzata', { ...claim, push_presa_scade_il: null }),
      base('claim-oggi', { ...claim, giorno_competenza: '2026-10-15' }),
      base('claim-altra-sede', { ...claim, entita_id: 'fonte-altra-sede' }),
      base('claim-altra-famiglia', { ...claim, utente_id: 'altro-genitore' }),
      base('claim-altro-tipo', { ...claim, tipo: 'avviso_risposta' }),
    ] }
    const input = { ...params(), titolo: 'Avviso', operazione: politica(), destinatario: 'genitore' as const }
    if (percorso === 'trigger') await notificaEvento(creaFintoSupabase(db), input)
    else expect(await enqueueNotifiche(creaFintoSupabase(db), input)).toBe(false)
    expect(ids(db)).toEqual(['finalizzata', 'claim-oggi', 'claim-altra-sede', 'claim-altra-famiglia', 'claim-altro-tipo'])
    expect(db.notifiche[0]).toMatchObject({ push_inviata_il: claim.push_inviata_il, push_presa_scade_il: null })
  })

  it('il ritiro ordinario conserva i claim e le consegne finalizzate', async () => {
    const db = { notifiche: [base('pending'), base('claim', { push_inviata_il: '2026-10-14T22:06:00Z', push_presa_scade_il: '2026-10-14T22:11:00Z' }), base('finalizzata', { push_inviata_il: '2026-10-14T22:06:00Z', push_presa_scade_il: null })] }
    expect(await ritiraNotifichePending(creaFintoSupabase(db), params())).toBe(true)
    expect(ids(db)).toEqual(['claim', 'finalizzata'])
  })

  it.each(['42703', 'PGRST204'])('schema senza lease (%s): fallback solo pushNULL e avviso, mai tutte le inviate', async codice => {
    const db = { notifiche: [base('pending'), base('non-null-legacy', { push_inviata_il: '2026-10-14T22:06:00Z' }), base('finalizzata', { push_inviata_il: '2026-10-14T22:06:00Z', push_presa_scade_il: null }), base('oggi', { giorno_competenza: '2026-10-15' })] }
    const filtri: string[] = []
    const input = { ...params(), titolo: 'Avviso', operazione: politica(), destinatario: 'genitore' as const }
    expect(await enqueueNotifiche(schemaPrecedente(db, ['push_presa_scade_il'], filtri, codice), input)).toBe(false)
    expect(ids(db)).toEqual(['non-null-legacy', 'finalizzata', 'oggi'])
    expect(filtri).toHaveLength(2)
    expect(filtri[0]).toContain('push_presa_scade_il')
    expect(filtri[1]).not.toContain('push_presa_scade_il')
    expect(filtri[1]).toContain('push_inviata_il.is.null')
    expect(h.log).toHaveBeenCalledWith('notifica', 'warn', expect.objectContaining({ esito: 'ritiro-schema-precedente' }), expect.objectContaining({ code: codice, message: expect.stringContaining('push_presa_scade_il') }))
  })

  it('schema senza tutti e tre i metadati: ritenta soltanto colonne nominate, preserva gli invii non nulli', async () => {
    const db = { notifiche: [base('pending'), base('non-null-legacy', { push_inviata_il: '2026-10-14T22:06:00Z' }), base('oggi', { creato_il: '2026-10-14T22:00:00Z' })] }
    const filtri: string[] = []
    expect(await ritiraPendingOperazione(schemaPrecedente(db, ['giorno_competenza', 'politica_operazione', 'push_presa_scade_il'], filtri), { ...params(), operazione: politica(), destinatario: 'genitore' })).toBe(true)
    expect(ids(db)).toEqual(['non-null-legacy', 'oggi'])
    expect(filtri).toHaveLength(4)
    expect(filtri.at(-1)).toContain('push_inviata_il.is.null')
    for (const colonna of ['giorno_competenza', 'politica_operazione', 'push_presa_scade_il']) expect(filtri.at(-1)).not.toContain(colonna)
  })

  it('un errore reale che nomina la lease non abilita il fallback e lascia intatta la coda', async () => {
    const db = { notifiche: [base('pending'), base('claim', { push_inviata_il: '2026-10-14T22:06:00Z', push_presa_scade_il: '2026-10-14T22:11:00Z' })] }
    const filtri: string[] = []
    expect(await ritiraPendingOperazione(schemaPrecedente(db, ['push_presa_scade_il'], filtri, '42501'), { ...params(), operazione: politica(), destinatario: 'genitore' })).toBe(false)
    expect(ids(db)).toEqual(['pending', 'claim'])
    expect(filtri).toHaveLength(1)
    expect(h.log).not.toHaveBeenCalledWith('notifica', 'warn', expect.objectContaining({ esito: 'ritiro-schema-precedente' }), expect.anything())
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'ritiro-pending-fallito' }), expect.objectContaining({ code: '42501', message: expect.stringContaining('push_presa_scade_il') }))
  })

  it('data spostata indietro: ritira il giorno ORIGINALE, preserva la coda del nuovo giorno', async () => {
    const db = { notifiche: [base('originaria'), base('altro-giorno', { creato_il: '2026-10-13T10:00:00Z' })] }
    expect(await ritiraPendingOperazione(creaFintoSupabase(db), { ...params(), operazione: politica('2026-10-14', '2026-10-13'), destinatario: 'genitore' })).toBe(true)
    expect(ids(db)).toEqual(['altro-giorno'])
  })

  it.each([
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
  ])('ritiro legacy della giornata DST %s: include tutti gli istanti, esclude i giorni adiacenti', async (giorno, inizio, fine) => {
    const db = { notifiche: [
      base('prima', { creato_il: new Date(Date.parse(inizio) - 1).toISOString() }),
      base('inizio', { creato_il: inizio }), base('fine', { creato_il: new Date(Date.parse(fine) - 1).toISOString() }),
      base('dopo', { creato_il: fine }),
    ] }
    expect(await ritiraNotifichePending(creaFintoSupabase(db), { ...params(), giorniOriginali: [giorno] })).toBe(true)
    expect(ids(db)).toEqual(['prima', 'dopo'])
  })

  it('personale e operazioni odierne non ritirano una coda storica', async () => {
    const db = { notifiche: [base('ieri')] }
    const client = creaFintoSupabase(db)
    expect(await ritiraPendingOperazione(client, { ...params(), operazione: politica(), destinatario: 'personale' })).toBe(false)
    expect(await ritiraPendingOperazione(client, { ...params(), operazione: politica('2026-10-15'), destinatario: 'genitore' })).toBe(false)
    expect(ids(db)).toEqual(['ieri'])
  })

  it('trigger misto: ritira i soli genitori risolti e continua ad avvisare il personale', async () => {
    const db = { notifiche: [base('genitore-ieri'), base('staff-pending', { utente_id: 'personale' })] }
    await notificaEvento(creaFintoSupabase(db), { tipo: 'avviso', entitaTipo: 'avviso', entitaId: 'fonte', titolo: 'Aggiornamento', alunnoIds: ['figlio'], utenteIds: ['personale'], operazione: politica() })
    expect(ids(db)).not.toContain('genitore-ieri')
    expect(db.notifiche[0]).toMatchObject({ id: 'staff-pending', utente_id: 'personale' })
    expect(db.notifiche).toHaveLength(2)
    expect(db.notifiche.at(-1)).toMatchObject({ utente_id: 'personale', politica_operazione: politica() })
  })

  it('risolve tutti i genitori degli alunni prima di una cancellazione; risultato incompleto non ritira neppure i destinatari espliciti', async () => {
    const db = { notifiche: [base('ieri')] }
    h.legami.mockResolvedValue({ perAlunno: new Map([['figlio', ['genitore']]]), completo: false })
    expect(await ritiraNotifichePending(creaFintoSupabase(db), { ...params(), alunnoIds: ['figlio'] })).toBe(false)
    expect(ids(db)).toEqual(['ieri'])
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'ritiro-destinatari-incompleti' }))
    h.legami.mockResolvedValue({ perAlunno: new Map([['figlio', ['genitore']]]), completo: true })
    expect(await ritiraNotifichePending(creaFintoSupabase(db), { ...params(), utenteIds: [], alunnoIds: ['figlio'] })).toBe(true)
    expect(ids(db)).toEqual([])
  })

  it('errore reale di delete: false, log intero, nessun fallback o ritiro allargato', async () => {
    const db = { notifiche: [base('ieri')] }
    const errore = { code: '42501', message: 'permission denied' }
    expect(await ritiraNotifichePending(creaFintoSupabase(db, [], { errori: { 'notifiche:delete': errore } }), params())).toBe(false)
    expect(ids(db)).toEqual(['ieri'])
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'ritiro-pending-fallito' }), expect.objectContaining(errore))
  })

  it.each([
    ['giorno_competenza'], ['politica_operazione'], ['giorno_competenza', 'politica_operazione'],
  ])('schema precedente con colonne assenti %j: elimina solo quei filtri, conservando quelli disponibili', async (...assenti) => {
    const db = { notifiche: [base('ieri'), base('oggi', { creato_il: '2026-10-14T22:00:00Z' })] }
    const filtri: string[] = []
    expect(await ritiraNotifichePending(schemaPrecedente(db, assenti, filtri), params())).toBe(true)
    expect(ids(db)).toEqual(['oggi'])
    expect(filtri).toHaveLength(assenti.length + 1)
    for (const assente of assenti) expect(filtri.at(-1)).not.toContain(assente)
    for (const presente of ['giorno_competenza', 'politica_operazione'].filter(c => !assenti.includes(c))) expect(filtri.at(-1)).toContain(presente)
  })

  it('nessuna entità o nessun destinatario non produce una query di ritiro', async () => {
    const client = { from: vi.fn() } as unknown as SupabaseClient
    expect(await ritiraNotifichePending(client, { ...params(), entitaId: null })).toBe(false)
    expect(await ritiraNotifichePending(client, { ...params(), utenteIds: [] })).toBe(false)
    expect(client.from).not.toHaveBeenCalled()
  })

  it('la galleria non ritira mai il batch tramite il generico id del caricatore', async () => {
    const db = { notifiche: [base('altra-foto', { tipo: 'galleria', entita_id: 'caricatore' })] }
    expect(await ritiraPendingOperazione(creaFintoSupabase(db), { ...params(), tipo: 'galleria', entitaId: 'caricatore', operazione: politica(), destinatario: 'genitore' })).toBe(false)
    expect(ids(db)).toEqual(['altra-foto'])
  })
})
