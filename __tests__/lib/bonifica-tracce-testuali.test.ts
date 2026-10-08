import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'

// =============================================================================
// LE TRACCE DI TESTO SENZA FK — una procedura, due canali (2026-10-09).
//
// `bonificaTracceTestualiAlunno` è stata estratta da `anonimizzaAlunno` perché anche
// l'eliminazione definitiva di una scheda non iscritta la deve usare: la funzione SQL
// cancella la riga `alunni` e ciò che è in CASCADE, ma notifiche, segnalazioni di
// moderazione e audit del diario senza id non hanno FK verso il bambino e resterebbero.
//
// Questo file prova la funzione DA SOLA, col finto client che applica davvero i filtri e
// le scritture: le asserzioni sono sulle righe rimaste nel finto DB, non sul solo conteggio.
// Che `anonimizzaAlunno` la chiami senza cambiare il proprio comportamento lo provano i test
// dell'oblio, rimasti invariati (`gdpr-oblio-notifiche`, `gdpr-esegui`, `gdpr-oblio-completo`…).
//
// OLTRE LE MILLE RIGHE (2026-10-09). Un bambino del nido supera le mille presenze e le mille
// voci di diario in un anno. Il finto qui sotto ha il tetto muto di PostgREST (`maxRighe: 1000`)
// e conta quanti id passano in ogni `.in()`: una lettura non paginata perde la milleunesima
// riga, e un `.in()` con mille uuid in produzione è un 414 — la funzione direbbe
// `completo: false` per sempre, e l'eliminazione definitiva di un ritirato del nido non
// partirebbe mai.
// =============================================================================

const spie = vi.hoisted(() => ({ logErrore: vi.fn(), logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: spie.logErrore, logEvento: spie.logEvento }
})

import { anonimizzaAlunno, bonificaTracceTestualiAlunno } from '@/lib/gdpr/esegui'
import { ID_PER_QUERY } from '@/lib/db/blocchi'

const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'

function db(): DBFinto {
  return {
    presenze: [
      { id: 'pr-1', alunno_id: NOSTRO },
      { id: 'pr-9', alunno_id: ALTRO },
    ],
    notifiche: [
      { id: 'n-alunno', entita_id: NOSTRO, utente_id: 'u-1' },
      { id: 'n-presenza', entita_id: 'pr-1', utente_id: 'u-1' },
      { id: 'n-altro-alunno', entita_id: ALTRO, utente_id: 'u-2' },
      { id: 'n-altra-presenza', entita_id: 'pr-9', utente_id: 'u-2' },
    ],
    eventi_diario: [
      { id: 'd-1', alunno_id: NOSTRO },
      { id: 'd-9', alunno_id: ALTRO },
    ],
    galleria_media_v2: [
      { id: 'm-1', tag_students: [NOSTRO], cestinato_il: null },
      { id: 'm-9', tag_students: [ALTRO], cestinato_il: null },
    ],
    chat_threads: [
      { id: 't-1', student_id: NOSTRO },
      { id: 't-9', student_id: ALTRO },
    ],
    segnalazioni: [
      { id: 's-diario', tipo_oggetto: 'voce_diario', oggetto_id: 'd-1', thread_id: null, motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-media', tipo_oggetto: 'media_galleria', oggetto_id: 'm-1', thread_id: null, motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-chat', tipo_oggetto: 'messaggio_chat', oggetto_id: 'msg-1', thread_id: 't-1', motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA' },
      { id: 's-diario-altro', tipo_oggetto: 'voce_diario', oggetto_id: 'd-9', thread_id: null, motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' },
      { id: 's-chat-altro', tipo_oggetto: 'messaggio_chat', oggetto_id: 'msg-9', thread_id: 't-9', motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' },
    ],
    conversazioni_sospensioni: [
      { id: 'so-1', thread_id: 't-1', motivo: 'TESTO DI PROVA' },
      { id: 'so-9', thread_id: 't-9', motivo: 'TESTO ALTRUI' },
    ],
    audit_scritture_docente: [
      { id: 'a-1', entita_tipo: 'diario', entita_id: null, valore_prima: [{ id: 'd-x', alunno_id: NOSTRO, nota_bambino: 'NOTA DI PROVA' }], valore_dopo: null },
      { id: 'a-9', entita_tipo: 'diario', entita_id: null, valore_prima: [{ id: 'd-y', alunno_id: ALTRO, nota_bambino: 'NOTA ALTRUI' }], valore_dopo: null },
    ],
  }
}

const riga = (d: DBFinto, tabella: string, id: string) => d[tabella].find((r) => r.id === id)

/**
 * Il finto client, col tetto di PostgREST e con un contatore della lunghezza di ogni elenco
 * passato a `.in()`. Il builder del finto restituisce sé stesso a ogni filtro: lo si avvolge in
 * un Proxy che misura `.in` e restituisce di nuovo il Proxy, così la catena resta misurata.
 */
function fintoMisurato(d: DBFinto, opzioni: OpzioniFinto = {}) {
  const misure: { tabella: string; n: number }[] = []
  const vero = creaFintoSupabase(d, [], { maxRighe: 1000, ...opzioni })
  const avvolgi = (tabella: string, b: object): object => {
    const proxy: object = new Proxy(b, {
      get(bersaglio, chiave) {
        const v = Reflect.get(bersaglio, chiave, bersaglio) as unknown
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          if (chiave === 'in' && Array.isArray(args[1])) misure.push({ tabella, n: args[1].length })
          const esito = (v as (...a: unknown[]) => unknown).apply(bersaglio, args)
          return esito === bersaglio ? proxy : esito
        }
      },
    })
    return proxy
  }
  const client = new Proxy(vero, {
    get(bersaglio, chiave) {
      if (chiave === 'from') return (tabella: string) => avvolgi(tabella, bersaglio.from(tabella))
      return Reflect.get(bersaglio, chiave, bersaglio) as unknown
    },
  }) as SupabaseClient
  return { client, misure }
}

const ordinale = (i: number) => String(i).padStart(4, '0')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('bonificaTracceTestualiAlunno — le notifiche', () => {
  it('rimuove la notifica che punta al bambino E quella che punta a una sua presenza; quelle di un altro restano', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    const rimaste = d.notifiche.map((n) => n.id).sort()
    // `assenza_non_comunicata`/`mensa_saldo_basso` puntano all'ALUNNO, `assenza_comunicata`/
    // `giustifica_ricevuta` alla PRESENZA: due spazi-id nella stessa colonna, servono entrambi.
    expect(rimaste, 'una notifica che nomina il bambino è rimasta in campanella').toEqual(['n-altra-presenza', 'n-altro-alunno'])
    expect(r.notificheRimosse).toBe(2)
    expect(r.completo).toBe(true)
  })
})

describe('bonificaTracceTestualiAlunno — segnalazioni, sospensioni, audit', () => {
  it('azzera motivo e note della segnalazione su una SUA voce di diario; quella su un altro bambino resta', async () => {
    const d = db()
    await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-diario-altro')).toMatchObject({ motivo: 'TESTO ALTRUI', note_gestione: 'NOTA ALTRUI' })
  })

  it('arriva anche alle segnalazioni sui suoi media e sui suoi thread, alle sospensioni e all’audit del diario senza id', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')

    expect(riga(d, 'segnalazioni', 's-media')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-chat')).toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-chat-altro')).toMatchObject({ motivo: 'TESTO ALTRUI' })
    expect(riga(d, 'conversazioni_sospensioni', 'so-1')!.motivo).toBeNull()
    expect(riga(d, 'conversazioni_sospensioni', 'so-9')!.motivo).toBe('TESTO ALTRUI')
    expect(riga(d, 'audit_scritture_docente', 'a-1')!.valore_prima).toBeNull()
    expect(riga(d, 'audit_scritture_docente', 'a-9')!.valore_prima).not.toBeNull()

    expect(r).toMatchObject({
      segnalazioniBonificate: 3,
      sospensioniBonificate: 1,
      completo: true,
      threadIds: ['t-1'],
      threadLetti: true,
      auditDiarioCompleto: true,
    })
  })
})

describe('bonificaTracceTestualiAlunno — un passo a metà deve essere VISIBILE', () => {
  it('lettura delle voci di diario rifiutata (42501) → `completo: false`, logga, e gli altri passi vanno avanti', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'eventi_diario:select': { code: '42501', message: 'permission denied' } } }),
      NOSTRO,
      'test',
    )

    expect(r.completo, '«non ho potuto guardare» dichiarato come «non c’era niente»').toBe(false)
    // La segnalazione sulla voce di diario non si è potuta raggiungere…
    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: 'TESTO DI PROVA' })
    // …ma best-effort come il resto del file: le altre tracce escono lo stesso.
    expect(d.notifiche.map((n) => n.id).sort()).toEqual(['n-altra-presenza', 'n-altro-alunno'])
    expect(riga(d, 'segnalazioni', 's-media')).toMatchObject({ motivo: null })
    const eventi = spie.logErrore.mock.calls.map((c) => (c[0] as { evento?: string }).evento)
    expect(eventi).toContain('oblio_segnalazioni_diario_select')
  })

  it('lettura dei thread rifiutata → `threadLetti: false` e `completo: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'chat_threads:select': { code: '42501' } } }),
      NOSTRO,
      'test',
    )
    expect(r).toMatchObject({ threadLetti: false, completo: false, threadIds: [] })
    expect(riga(d, 'conversazioni_sospensioni', 'so-1')!.motivo).toBe('TESTO DI PROVA')
  })

  it('cancellazione delle notifiche rifiutata → `completo: false` (non «zero notifiche da togliere»)', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { 'notifiche:delete': { code: '42501' } } }),
      NOSTRO,
      'test',
    )
    expect(r.notificheRimosse).toBe(0)
    expect(r.completo).toBe(false)
    expect(d.notifiche).toHaveLength(4)
  })

  it('schema assente (DB E2E non migrato, 42P01) NON è un passo fallito: degrada come il resto del file', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(
      creaFintoSupabase(d, [], { errori: { segnalazioni: { code: '42P01' }, conversazioni_sospensioni: { code: '42P01' } } }),
      NOSTRO,
      'test',
    )
    expect(r.completo).toBe(true)
    expect(spie.logErrore).not.toHaveBeenCalled()
  })
})

describe('bonificaTracceTestualiAlunno — oltre le mille righe (il nido)', () => {
  it('1001 presenze e 1001 voci di diario: la notifica della 1001ª presenza e la segnalazione sulla 1001ª voce escono; nessun `.in()` supera i 100 id', async () => {
    const d = db()
    // Gli id ordinati come li ordina `.order('id')`: la milleunesima è l'ultima, quella che una
    // lettura sola (troncata a 1000) non vede.
    d.presenze = [
      ...Array.from({ length: 1001 }, (_, i) => ({ id: `pr-n-${ordinale(i)}`, alunno_id: NOSTRO })),
      { id: 'pr-9', alunno_id: ALTRO },
    ]
    d.eventi_diario = [
      ...Array.from({ length: 1001 }, (_, i) => ({ id: `d-n-${ordinale(i)}`, alunno_id: NOSTRO })),
      { id: 'd-9', alunno_id: ALTRO },
    ]
    d.notifiche.push(
      { id: 'n-millesima', entita_id: `pr-n-${ordinale(999)}`, utente_id: 'u-1' },
      { id: 'n-milleunesima', entita_id: `pr-n-${ordinale(1000)}`, utente_id: 'u-1' },
    )
    d.segnalazioni.push({
      id: 's-milleunesima', tipo_oggetto: 'voce_diario', oggetto_id: `d-n-${ordinale(1000)}`, thread_id: null,
      motivo: 'TESTO DI PROVA', note_gestione: 'NOTA DI PROVA',
    })
    const { client, misure } = fintoMisurato(d)

    const r = await bonificaTracceTestualiAlunno(client, NOSTRO, 'test')

    expect(riga(d, 'notifiche', 'n-milleunesima'), 'la notifica della 1001ª presenza è rimasta: lettura delle presenze non paginata').toBeUndefined()
    expect(riga(d, 'notifiche', 'n-millesima')).toBeUndefined()
    expect(riga(d, 'notifiche', 'n-altra-presenza'), 'tolta la notifica di un altro bambino').toBeDefined()
    expect(riga(d, 'segnalazioni', 's-milleunesima'), 'la segnalazione sulla 1001ª voce di diario ha ancora il testo').toMatchObject({ motivo: null, note_gestione: null })
    expect(riga(d, 'segnalazioni', 's-diario-altro')).toMatchObject({ motivo: 'TESTO ALTRUI' })
    expect(r.completo).toBe(true)
    // L'alunno, la 1000ª e la 1001ª presenza (le presenze di `db()` sono state sostituite: `pr-1` qui non c'è).
    expect(r.notificheRimosse).toBe(3)

    // L'URL: mille uuid in una query string sono un 414 in produzione.
    const piuLungo = misure.reduce((m, x) => (x.n > m.n ? x : m), { tabella: '-', n: 0 })
    expect(piuLungo.n, `un \`.in()\` su \`${piuLungo.tabella}\` con ${piuLungo.n} id: in produzione è un 414`).toBeLessThanOrEqual(ID_PER_QUERY)
    // …e il contatore deve aver VISTO le cancellazioni a blocchi, o l'asserzione sopra non dice niente:
    // 1002 id (l'alunno + 1001 presenze) sono 11 blocchi.
    expect(misure.filter((x) => x.tabella === 'notifiche').length).toBe(11)
  })
})

describe('bonificaTracceTestualiAlunno — ogni lettura e ogni scrittura rifiutata si vede in `completo`', () => {
  const rifiuto = { code: '42501', message: 'permission denied' }

  it('lettura delle presenze rifiutata → `completo: false`, ma la notifica che punta all’alunno esce lo stesso', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'presenze:select': rifiuto } }), NOSTRO, 'test')
    expect(r.completo).toBe(false)
    expect(riga(d, 'notifiche', 'n-alunno')).toBeUndefined()
    expect(riga(d, 'notifiche', 'n-presenza'), 'senza le presenze non la si può trovare: è il motivo di `completo: false`').toBeDefined()
  })

  it('lettura delle segnalazioni candidate rifiutata → `completo: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'segnalazioni:select': rifiuto } }), NOSTRO, 'test')
    expect(r.completo).toBe(false)
    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: 'TESTO DI PROVA' })
  })

  it('lettura dei media rifiutata → `completo: false`, la segnalazione sul media resta col testo', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'galleria_media_v2:select': rifiuto } }), NOSTRO, 'test')
    expect(r.completo).toBe(false)
    expect(riga(d, 'segnalazioni', 's-media')).toMatchObject({ motivo: 'TESTO DI PROVA' })
    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: null })
  })

  it('update delle segnalazioni rifiutato → `completo: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'segnalazioni:update': rifiuto } }), NOSTRO, 'test')
    expect(r.completo).toBe(false)
    expect(r.segnalazioniBonificate).toBe(0)
    expect(riga(d, 'segnalazioni', 's-diario')).toMatchObject({ motivo: 'TESTO DI PROVA' })
  })

  it('update delle sospensioni rifiutato → `completo: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'conversazioni_sospensioni:update': rifiuto } }), NOSTRO, 'test')
    expect(r.completo).toBe(false)
    expect(riga(d, 'conversazioni_sospensioni', 'so-1')!.motivo).toBe('TESTO DI PROVA')
  })

  it('bonifica dell’audit del diario rifiutata → `completo: false` e `auditDiarioCompleto: false`', async () => {
    const d = db()
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d, [], { errori: { 'audit_scritture_docente:update': rifiuto } }), NOSTRO, 'test')
    expect(r).toMatchObject({ completo: false, auditDiarioCompleto: false })
  })

  it('una segnalazione GIÀ senza testo non si riscrive e non si conta', async () => {
    const d = db()
    riga(d, 'segnalazioni', 's-diario')!.motivo = null
    riga(d, 'segnalazioni', 's-diario')!.note_gestione = null
    const r = await bonificaTracceTestualiAlunno(creaFintoSupabase(d), NOSTRO, 'test')
    expect(r.segnalazioniBonificate).toBe(2) // media + chat
    expect(r.completo).toBe(true)
  })
})

describe('anonimizzaAlunno — `lettureFallite` conta le stesse due voci di prima, e solo quelle', () => {
  const RPC = { video_intent_oblio_alunno: async () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }) }
  const lettureFallite = async (errori: OpzioniFinto['errori'] = {}) => {
    const client = creaFintoSupabase(db(), [], { errori, rpc: RPC })
    // L'oblio passa anche dallo Storage (pagelle, certificati, allegati): qui non c'è niente da togliere.
    ;(client as unknown as { storage: unknown }).storage = {
      from: () => ({ remove: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }) }),
    }
    return (await anonimizzaAlunno(client, { id: NOSTRO }, '2026-10-09T00:00:00Z', 'test')).lettureFallite
  }

  it('cancellazione delle notifiche rifiutata → `lettureFallite` NON cambia (è una scrittura, non un inventario)', async () => {
    const base = await lettureFallite()
    expect(base).toBe(0)
    expect(await lettureFallite({ 'notifiche:delete': { code: '42501' } })).toBe(base)
  })

  it('lettura dei thread rifiutata → `lettureFallite` sale di ESATTAMENTE uno', async () => {
    const base = await lettureFallite()
    expect(await lettureFallite({ 'chat_threads:select': { code: '42501' } })).toBe(base + 1)
  })
})
