import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// I DUE TETTI DI PostgREST, su questa route — e perché un file a parte
// ════════════════════════════════════════════════════════════════════════════
//
//  · `.in('colonna', ids)` finisce nell'URL: mille uuid sono ~38 kB di riga di
//    richiesta e il proxy risponde 414. Per questo si va a BLOCCHI
//    (`ID_PER_QUERY`), e non su una lista sola: dispositivi, conversazioni e
//    messaggi.
//  · `db-max-rows` vale 1000: oltre quella soglia la risposta è TRONCATA e non
//    c'è nessun `error`. Un conteggio troncato per difetto dice «va tutto bene»
//    con l'aria di un dato, ed è esattamente il numero che questa schermata
//    esiste per mostrare (137 messaggi in 30 giorni, misurati su una maestra).
//
// I numeri veri (100 e 1000) non si possono provare con un finto database:
// servirebbero mille righe. Qui i due moduli che li dichiarano vengono
// sostituiti con valori minuscoli — `aBlocchi` e `leggiABlocchi` restano quelli
// VERI — e si verifica che il codice li rispetti davvero.
//
// Sta in un file suo perché `vi.mock` vale per l'intero file: negli altri casi i
// tetti devono restare quelli di produzione.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  /** Ogni `.in(colonna, lista)`: la prova che gli elenchi sono spezzati. */
  liste: [] as { colonna: string; n: number }[],
  /** Il tetto iniettato in `leggiABlocchi`, che accetta già queste opzioni. */
  tetto: { blocco: 2, maxBlocchi: 20 } as { blocco: number; maxBlocchi: number } | null,
}))

vi.mock('@/lib/db/blocchi', async (originale) => {
  const vero = await originale<typeof import('@/lib/db/blocchi')>()
  return { ...vero, ID_PER_QUERY: 2 }
})
// Il modulo VERO, con il tetto iniettato dalle opzioni che già accetta.
vi.mock('@/lib/pagamenti/leggi-a-blocchi', async (originale) => {
  const vero = await originale<typeof import('@/lib/pagamenti/leggi-a-blocchi')>()
  type Args = Parameters<typeof vero.leggiABlocchi>
  return {
    ...vero,
    leggiABlocchi: (c: Args[0], o: Args[1]) => vero.leggiABlocchi(c, h.tetto ? { ...o, ...h.tetto } : o),
  }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Si registra la LUNGHEZZA di ogni `.in()`: «gli elenchi sono spezzati» è una
  // proprietà sulle richieste, e contare le letture non basta — una lettura
  // paginata molte volte somiglia a molte letture a blocchi.
  type Catena = Record<string, unknown>
  const avvolgi = (catena: Catena): Catena =>
    new Proxy(catena, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          if (p === 'in') h.liste.push({ colonna: String(args[0]), n: (args[1] as unknown[]).length })
          const out = (v as (...a: unknown[]) => unknown).apply(t, args)
          return out === t ? avvolgi(t) : out
        }
      },
    })
  return {
    createAdminClient: async () => {
      const vero = creaFintoSupabase(h.db, h.tabelle, {})
      return new Proxy(vero, {
        get(t, prop, ric) {
          if (prop !== 'from') return Reflect.get(t, prop, ric)
          return (tabella: string) =>
            avvolgi((t as unknown as { from: (s: string) => Catena }).from(tabella))
        },
      }) as never
    },
  }
})

import { GET } from '@/app/api/admin/chat/docenti-senza-push/route'

const SEDE = SEDE_A
const DIRIGENTE = 'aaaa1111-0000-4000-8000-00000000000f'
const GENITORE = '9a9a9a9a-0000-4000-8000-00000000000e'
const ALUNNO = 'b1b1b1b1-0000-4000-8000-000000000001'

/** Cinque docenti: con `ID_PER_QUERY = 2` fanno tre blocchi. */
const DOCENTI = Array.from({ length: 5 }, (_, i) => `d${i}d${i}d${i}d${i}-0000-4000-8000-00000000000${i}`)
/** Tre conversazioni della prima: due blocchi di thread, e due di messaggi. */
const THREAD = Array.from({ length: 3 }, (_, i) => `f${i}f${i}f${i}f${i}-0000-4000-8000-00000000000${i}`)

const req = () => new NextRequest('http://localhost/api/admin/chat/docenti-senza-push')
const recente = (ore: number) => new Date(Date.now() - ore * 3600_000).toISOString()

const dbBase = (): DBFinto => ({
  utenti: DOCENTI.map((id, i) => ({
    id, nome: `Nome${i}`, cognome: `Cognome${i}`, ruolo: 'educator',
    scuola_id: SEDE, archiviato_il: null,
  })),
  push_subscriptions: [],
  alunni: [{ id: ALUNNO, scuola_id: SEDE }],
  chat_threads: THREAD.map((id) => ({
    id, teacher_id: DOCENTI[0], parent_id: GENITORE, student_id: ALUNNO, alunni: { scuola_id: SEDE },
  })),
  // Sette messaggi dal genitore in ciascuno dei tre thread: con pagine da 2
  // righe e blocchi da 2 thread, chi legge una pagina sola ne conta 2 su 21.
  chat_messages: THREAD.flatMap((t, k) =>
    Array.from({ length: 7 }, (_, i) => ({
      id: `m${k}-${i}`, thread_id: t, sender_id: GENITORE, content: 'ciao',
      read_at: null, created_at: recente(i + 1),
    })),
  ),
  utenti_scuole: [],
  chat_vigilanza_accessi: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.liste = []
  h.tetto = { blocco: 2, maxBlocchi: 20 }
  h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'coordinator', scuola_id: SEDE } })
})

const corpo = async (res: Response) =>
  (await res.json()) as {
    data?: { id: string; ricevuti30g: number; nonLetti: number }[]
    totale?: number
    docentiTotali?: number
    codice?: string
  }

describe('GET /api/admin/chat/docenti-senza-push — blocchi e pagine', () => {
  it('conta TUTTI i messaggi anche quando superano il tetto di righe per pagina', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // 21 messaggi in tre thread, tutti dal genitore e tutti da leggere.
    expect(b.data?.find((d) => d.id === DOCENTI[0])).toMatchObject({ ricevuti30g: 21, nonLetti: 21 })
  })

  it('le cinque docenti ci sono tutte: l\'elenco non si ferma alla prima pagina', async () => {
    const b = await corpo(await GET(req()))
    expect(b.totale).toBe(5)
    expect(b.docentiTotali).toBe(5)
    expect(b.data).toHaveLength(5)
  })

  it('gli `in()` sono divisi in blocchi: tre letture dei dispositivi, non una', async () => {
    await GET(req())
    // `aBlocchi([5 id], 2)` → 3 blocchi, e ogni blocco è una lettura a sé.
    // Con un solo `.in()` di cinque uuid questa conta sarebbe 1.
    expect(h.tabelle.filter((t) => t === 'push_subscriptions').length).toBeGreaterThanOrEqual(3)
  })

  it('NESSUN `.in()` supera `ID_PER_QUERY`, su nessuna delle quattro letture', async () => {
    // È la proprietà vera, e l'unica che i mutanti non possono aggirare:
    // contare le LETTURE non basta, perché una lettura paginata undici volte
    // somiglia a undici letture a blocchi. Qui si guarda la lunghezza delle
    // liste che finiscono in query string — il 414 arriva da lì.
    await GET(req())
    expect(h.liste.length, 'nessun `.in()`: il test non prova niente').toBeGreaterThan(4)
    const troppoLunghe = h.liste.filter((x) => x.n > 2)
    expect(troppoLunghe, `liste oltre ID_PER_QUERY: ${JSON.stringify(troppoLunghe)}`).toEqual([])
    // E tutte le letture ci sono passate: le docenti (`scuola_id`), i
    // dispositivi (`utente_id`), le conversazioni (`teacher_id` più il filtro
    // di sede sul join) e i messaggi (`thread_id`, sia trasferiti sia contati).
    expect([...new Set(h.liste.map((x) => x.colonna))].sort()).toEqual(
      ['alunni.scuola_id', 'scuola_id', 'teacher_id', 'thread_id', 'utente_id'],
    )
  })

  it('oltre il TETTO delle pagine si risponde 500, non un elenco a metà', async () => {
    // `maxBlocchi: 1` con `blocco: 2`: al tetto `leggiABlocchi` fa una riga di
    // prova, la trova, e dichiara `motivo: 'tetto'`. Un elenco di dispositivi
    // troncato accuserebbe maestre che le notifiche le hanno: qui si rifiuta.
    h.tetto = { blocco: 2, maxBlocchi: 1 }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    // ⚠️ LO STATUS NON BASTA. Ignorando il ramo del tetto la route risponde 500
    // lo stesso — itera su `righe` che non esiste e l'eccezione arriva al
    // `catch` esterno — e un test fermo allo status resterebbe verde su un
    // controllo cancellato. La differenza è la riga di log: `lettura-troncata`
    // dice QUALE lettura e quante righe, il `TypeError` non dice niente.
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'lettura-troncata', stato: 500 }),
      expect.objectContaining({ message: expect.stringContaining('lettura-troncata: docenti-senza-push-docenti') }),
    )
  })

  it('il tetto sui DISPOSITIVI è un guasto, non un elenco a metà', async () => {
    // ⚠️ Ogni lettura ha il suo ramo, e il tetto della PRIMA non collauda le
    // altre: con `maxBlocchi: 1` cade subito quella delle docenti e le due
    // dopo non vengono nemmeno raggiunte. Qui il tetto delle docenti sta larga
    // (quattro righe esatte: la riga di prova torna vuota e nessun allarme è
    // falso) e a sfondarlo sono i dispositivi.
    //
    // È il caso che conta di più: un elenco di dispositivi troncato farebbe
    // comparire fra le «senza notifiche» maestre che i dispositivi ce li hanno.
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    h.db.utenti = h.db.utenti.slice(0, 4)
    h.db.push_subscriptions = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`, utente_id: DOCENTI[0], endpoint: `https://esempio/${i}`,
    }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'lettura-troncata' }),
      expect.objectContaining({ message: expect.stringContaining('lettura-troncata: docenti-senza-push-dispositivi') }),
    )
  })

  it('il tetto sui MESSAGGI è un guasto, non un conteggio per difetto', async () => {
    // Stessa forma: le tre letture prima ci stanno, i messaggi no. Un conteggio
    // troncato per difetto dice «va tutto bene» con l'aria di un dato, ed è
    // proprio il numero che ordina l'elenco.
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    h.db.utenti = h.db.utenti.slice(0, 4)
    h.db.chat_threads = [h.db.chat_threads[0]]
    h.db.chat_messages = Array.from({ length: 6 }, (_, i) => ({
      id: `z${i}`, thread_id: THREAD[0], sender_id: GENITORE, content: 'ciao',
      read_at: null, created_at: recente(i + 1),
    }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'lettura-troncata' }),
      expect.objectContaining({ message: expect.stringContaining('lettura-troncata: docenti-senza-push-messaggi') }),
    )
  })
})
