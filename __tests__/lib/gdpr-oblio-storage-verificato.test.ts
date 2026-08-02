import { describe, it, expect, vi, beforeEach } from 'vitest'
import { anonimizzaAlunno, anonimizzaParent } from '@/lib/gdpr/esegui'

// Le spie sul logger servono a dimostrare che il guasto ARRIVA nel canale degli
// errori, non solo nel valore di ritorno: un oblio parziale che nessuno vede è
// indistinguibile da un oblio riuscito. Si preserva il resto del modulo
// (`EVENTI_NOTI`, `vaPersistito`, …), che altri import usano davvero.
const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento, logErrore: spie.logErrore }
})

// =============================================================================
// «0 FILE NON RIMOSSI» DETTO DA CHI NON HA RIMOSSO NIENTE (debug #1, 2026-08-02).
//
// IL FATTO MISURATO. `POST /api/admin/gdpr/erase` rispondeva
// `{ ok: true, n_file_non_rimossi: 0 }` mentre nello Storage non era uscito
// NESSUN file, e la riga che indicizzava il documento era già stata cancellata un
// attimo prima. Il log `oblio-parziale` non scattava mai.
//
// LA CAUSA. `rimuoviFileOblio` guardava soltanto `error`. Ma
// `supabase.storage.remove()` NON fallisce sui percorsi che non escono: risponde
// `error: null` e semplicemente non li nomina. Nel ramo di successo la funzione
// ritornava letteralmente `nonRimossi: 0`, e quando `data` non era un array
// contava TUTTI i percorsi come rimossi — cioè trattava «non so» come «fatto»,
// l'esatto contrario della regola scritta nello stesso repo
// (`src/lib/storage/rimozione-verificata.ts`):
//
//      uscito adesso → fatto · non c'è più → fatto · c'è ancora → guasto ·
//      non si sa → guasto anche questo.
//
// L'AGGRAVANTE ERA L'ORDINE. Si cancellava PRIMA la riga-indice e POI si toglieva
// il file: combinando le due cose si otteneva il caso peggiore — il documento di
// un bambino resta nell'archivio, nessuna riga lo nomina più, e alla famiglia è
// stato risposto «fatto».
//
// QUESTI TEST NON CONTANO: GUARDANO LO STATO. Il finto Storage qui sotto è un
// archivio vero — `remove()` toglie (o non toglie) e `list()` dice com'è andata —
// perché il difetto era proprio l'assunzione su ciò che `remove()` restituisce.
// =============================================================================

const AT = '2026-08-02T09:00:00Z'

interface ArchivioCfg {
  /** Che cosa c'è davvero nell'archivio, bucket per bucket. */
  presenti?: Record<string, string[]>
  /** `false` = `remove()` risponde bene e non toglie niente (il caso del difetto). */
  rimuoveDavvero?: boolean
  /** La FORMA della risposta di `remove()`: nomi, elenco vuoto, oppure `null`. */
  forma?: 'nomi' | 'vuota' | 'null'
  removeError?: { message: string } | null
  /** `list()` non risponde: non si può sapere se il file sia ancora lì. */
  listError?: { message: string } | null
  // ── sorgenti applicative ──────────────────────────────────────────────────
  parent?: Record<string, unknown> | null
  pagelle?: { id: string; file_url: string | null }[]
  certificati?: { id: string; file_path: string | null }[]
  media?: Record<string, unknown>[]
  threadAlunno?: { id: string }[]
  threadGenitore?: { id: string }[]
  messaggi?: { id: string; attachment_url: string | null }[]
}

function scomponi(p: string) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { cartella: '', nome: p } : { cartella: p.slice(0, i), nome: p.slice(i + 1) }
}

function fakeArchivio(cfg: ArchivioCfg) {
  const updates: Record<string, unknown>[] = []
  const deleted: { table: string; ids: unknown }[] = []
  const removed: { bucket: string; paths: string[] }[] = []
  const archivio = new Map<string, Set<string>>()
  for (const [b, p] of Object.entries(cfg.presenti ?? {})) archivio.set(b, new Set(p))
  const contenuto = (b: string) => archivio.get(b) ?? new Set<string>()

  const client = {
    from(table: string) {
      const st: { isDelete?: boolean; eq: Record<string, unknown> } = { eq: {} }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { st.eq[col] = val; return b }
      b.neq = () => b
      b.not = () => b
      b.in = (_col: string, vals: unknown) => {
        if (st.isDelete) deleted.push({ table, ids: vals })
        return b
      }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => { st.isDelete = true; return b }
      b.update = (row: Record<string, unknown>) => { updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({ data: table === 'parents' ? (cfg.parent ?? null) : null, error: null })
      b.then = (res: (v: unknown) => unknown) => {
        let data: unknown[] = []
        if (table === 'pagelle') data = cfg.pagelle ?? []
        if (table === 'certificati_medici') data = cfg.certificati ?? []
        if (table === 'galleria_media_v2') data = cfg.media ?? []
        if (table === 'chat_threads') data = ('student_id' in st.eq ? cfg.threadAlunno : cfg.threadGenitore) ?? []
        if (table === 'chat_messages') data = cfg.messaggi ?? []
        return Promise.resolve({ data, error: null }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths })
          if (cfg.removeError) return { data: null, error: cfg.removeError }
          const dentro = contenuto(bucket)
          const usciti = cfg.rimuoveDavvero === false ? [] : paths.filter((p) => dentro.delete(p))
          if (cfg.forma === 'null') return { data: null, error: null }
          if (cfg.forma === 'vuota') return { data: [], error: null }
          return { data: usciti.map((p) => ({ name: p })), error: null }
        },
        list: async (cartella: string, opts?: { search?: string }) => {
          if (cfg.listError) return { data: null, error: cfg.listError }
          const cerca = opts?.search ?? ''
          const righe = [...contenuto(bucket)]
            .map(scomponi)
            .filter((s) => s.cartella === cartella && s.nome.startsWith(cerca))
            .map((s) => ({ name: s.nome }))
          return { data: righe, error: null }
        },
      }),
    },
  }
  return { client, updates, deleted, removed, archivio }
}

/** Gli `esito:` finiti nel canale degli errori dello Storage. */
const esitiErrore = () =>
  spie.logEvento.mock.calls
    .filter((c) => c[1] === 'error')
    .map((c) => (c[2] as { esito?: string })?.esito)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('oblio · lo Storage ha risposto bene e non ha tolto niente', () => {
  it('ALUNNO · file ANCORA nel bucket → l’oblio è parziale, e si vede (non «0 su 0»)', async () => {
    const f = fakeArchivio({
      presenti: { pagelle: ['scr-1/al-1.pdf'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')

    expect(
      r.fileNonRimossi,
      'la pagella è ancora nell’archivio e l’oblio si dichiara completo: è la risposta falsa data a una famiglia',
    ).toBeGreaterThan(0)
    expect(r.file, 'nessun file è uscito, ma il conteggio dice il contrario').toBe(0)
    expect(esitiErrore()).toContain('file-ancora-presenti')
  })

  it('ALUNNO · il file resta → la RIGA che lo indicizza NON si cancella', async () => {
    // Cancellare l'indice mentre il file resta è il caso peggiore dei due: il
    // documento diventa invisibile invece che cancellato, e non c'è più niente
    // da cui ripartire per toglierlo.
    const f = fakeArchivio({
      presenti: { pagelle: ['scr-1/al-1.pdf'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(
      f.deleted.some((d) => d.table === 'pagelle'),
      'la riga `pagelle` è stata cancellata mentre il PDF è rimasto nell’archivio',
    ).toBe(false)
  })

  it('ALUNNO · `remove()` risponde `data: null` e il file c’è ancora → NON si assume che sia uscito', async () => {
    // La forma della risposta non è una prova. `data: null` significa «non so»,
    // e «non so» non è «fatto»: il vecchio codice contava tutti i percorsi come
    // rimossi proprio in questo ramo.
    const f = fakeArchivio({
      presenti: { 'certificati-medici': ['al-1/cert.pdf'] },
      rimuoveDavvero: false,
      forma: 'null',
      certificati: [{ id: 'cm-1', file_path: 'al-1/cert.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi).toBeGreaterThan(0)
    expect(f.deleted.some((d) => d.table === 'certificati_medici')).toBe(false)
  })

  it('ALUNNO · `data: null` ma il file è uscito davvero → esito raggiunto, nessun falso allarme', async () => {
    // Il verso opposto, ed è il presidio che impedisce di «chiudere» il difetto
    // bloccando tutto: un archivio che non cancella più niente sarebbe la stessa
    // violazione, per un'altra strada.
    const f = fakeArchivio({
      presenti: { 'certificati-medici': ['al-1/cert.pdf'] },
      forma: 'null',
      certificati: [{ id: 'cm-1', file_path: 'al-1/cert.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi).toBe(0)
    expect(f.deleted.some((d) => d.table === 'certificati_medici')).toBe(true)
    expect(f.archivio.get('certificati-medici')?.size).toBe(0)
  })

  it('ALUNNO · file GIÀ assente → l’obiettivo è raggiunto: la riga si cancella lo stesso', async () => {
    const f = fakeArchivio({
      presenti: {},
      forma: 'vuota',
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi, 'un file già assente non è un guasto e non deve bloccare l’oblio').toBe(0)
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(true)
  })

  it('ALUNNO · non si è potuto SAPERE se il file c’è ancora → si tratta come «c’è»', async () => {
    const f = fakeArchivio({
      presenti: { pagelle: ['scr-1/al-1.pdf'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      listError: { message: 'storage down' },
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi).toBeGreaterThan(0)
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(false)
    expect(esitiErrore()).toContain('verifica-file-non-riuscita')
  })
})

describe('oblio · il percorso che nessuno sa leggere', () => {
  it('ALUNNO · un percorso non riconoscibile NON sparisce in silenzio: si conta e la riga resta', async () => {
    // `percorsoNelBucket` risponde `null` per un indirizzo che non appartiene a
    // questo bucket. Prima veniva scartato con un `.filter()` e la riga si
    // cancellava comunque: quel file non era né rimosso né contato — zero su
    // zero, la forma perfetta del guasto invisibile.
    const f = fakeArchivio({
      presenti: {},
      pagelle: [{ id: 'pg-1', file_url: 'https://altro-servizio.example/qualcosa/al-1.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(
      r.fileNonRimossi,
      'un percorso illeggibile viene scartato senza conteggio: la riga sparisce e il file resta',
    ).toBeGreaterThan(0)
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(false)
    expect(esitiErrore()).toContain('oblio-percorso-non-riconosciuto')
  })

  it('ALUNNO · riga SENZA file allegato → nessun blocco: si cancella normalmente', async () => {
    // Controllo positivo accanto al negativo: «valore assente» e «valore
    // illeggibile» sono due cose diverse, e confonderle bloccherebbe l'oblio di
    // ogni riga che non ha un allegato.
    const f = fakeArchivio({ presenti: {}, pagelle: [{ id: 'pg-1', file_url: null }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi).toBe(0)
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(true)
  })
})

describe('oblio · gli altri due magazzini con lo stesso ordine sbagliato', () => {
  it('CHAT · l’allegato resta nel bucket → `attachment_url` NON si azzera', async () => {
    // Azzerare il percorso mentre il file resta lo rende irraggiungibile e non
    // cancellato: il nome del file — quasi sempre il nome di una persona o la
    // parola «referto» — resterebbe nell'archivio senza più nessuna riga da cui
    // ritrovarlo.
    const f = fakeArchivio({
      presenti: { 'chat-allegati': ['auth-9/uuid-referto.pdf'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      threadAlunno: [{ id: 'th-1' }],
      messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/uuid-referto.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.updates.some((u) => u.table === 'chat_messages')).toBe(false)
    expect(r.fileNonRimossi).toBeGreaterThan(0)
  })

  it('CHAT · l’allegato esce davvero → allora sì che il percorso si azzera', async () => {
    const f = fakeArchivio({
      presenti: { 'chat-allegati': ['auth-9/uuid-referto.pdf'] },
      threadAlunno: [{ id: 'th-1' }],
      messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/uuid-referto.pdf' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const upd = f.updates.find((u) => u.table === 'chat_messages')
    expect(upd).toBeTruthy()
    expect(upd!.attachment_url).toBeNull()
    expect(r.fileNonRimossi).toBe(0)
  })

  it('GALLERIA · la foto resta nel bucket → la riga del media NON si cancella', async () => {
    const f = fakeArchivio({
      presenti: { gallery: ['uploads/u1/foto.jpg'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      media: [{ id: 'md-1', file_url: 'uploads/u1/foto.jpg', tag_students: ['al-1'] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.deleted.some((d) => d.table === 'galleria_media_v2')).toBe(false)
    expect(r.fotoRimosse).toBe(0)
    expect(r.fileNonRimossi).toBeGreaterThan(0)
  })

  it('GALLERIA · la foto esce → riga cancellata e conteggio pulito (nessun blocco inventato)', async () => {
    const f = fakeArchivio({
      presenti: { gallery: ['uploads/u1/foto.jpg'] },
      media: [{ id: 'md-1', file_url: 'uploads/u1/foto.jpg', tag_students: ['al-1'] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.deleted.some((d) => d.table === 'galleria_media_v2')).toBe(true)
    expect(r.fotoRimosse).toBe(1)
    expect(r.fileNonRimossi).toBe(0)
  })
})

describe('oblio del GENITORE · stessa regola, stesso conteggio', () => {
  it('il PDF delle credenziali resta nel bucket → l’oblio si dichiara parziale', async () => {
    const f = fakeArchivio({
      presenti: { credenziali: ['p-1-1700000000000.pdf'] },
      rimuoveDavvero: false,
      forma: 'vuota',
      parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null },
    })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(
      r.fileNonRimossi,
      'dentro quel PDF c’è una password in chiaro e l’oblio dice che è stato tolto',
    ).toBeGreaterThan(0)
  })

  it('il PDF esce davvero → conteggio dei rimossi, nessun bloccante', async () => {
    const f = fakeArchivio({
      presenti: { credenziali: ['p-1-1700000000000.pdf'] },
      parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null },
    })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(r.fileRimossi).toBe(1)
    expect(r.fileNonRimossi).toBe(0)
    expect(f.archivio.get('credenziali')?.size).toBe(0)
  })
})
