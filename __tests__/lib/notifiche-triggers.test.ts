import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { controparteThread, genitoriDiClassi, staffScuola } from '@/lib/notifiche/destinatari'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

// notificaEvento: toggle → destinatari (utenteIds + genitori degli alunni) →
// debounce (delete pending stesso tipo+entita_id) → enqueue. Sempre best-effort.

const h = vi.hoisted(() => ({
  toggles: {} as Record<string, boolean>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  // Stato vero della tabella `notifiche` per il client stateful in fondo al file.
  notifiche: [] as Array<{ utente_id: string; tipo: string; entita_id: string | null; push_inviata_il: string | null }>,
  // `alunno_id` presente: la risoluzione dei genitori passa ora dall'unione
  // runtime+anagrafica (`getGenitoriDiAlunni`), che mappa alunno → genitori.
  legami: [
    { alunno_id: 'a1', genitore_id: 'p1' },
    { alunno_id: 'a1', genitore_id: 'p2' },
  ] as Array<Record<string, unknown>>,
  alunniClasse: [{ id: 'a1' }, { id: 'a2' }] as Array<Record<string, unknown>>,
  thread: { teacher_id: 't1', parent_id: 'p1' } as Record<string, unknown> | null,
  utenti: [
    { id: 'u1', role: 'admin', ruolo: null },
    { id: 'u2', role: null, ruolo: 'cuoca' },
    { id: 'u3', role: 'educator', ruolo: null },
  ] as Array<Record<string, unknown>>,
}))

function makeClient() {
  return {
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const rowsFor = () => {
        if (table === 'legame_genitori_alunni') return h.legami
        if (table === 'alunni') return h.alunniClasse
        if (table === 'utenti') return h.utenti
        return []
      }
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => { filtri[col] = val; return chain },
        in: (col: string, val: unknown) => { filtri[col] = val; return chain },
        is: (col: string, val: unknown) => { filtri[col] = val; h.deletes.push({ table, ...filtri }); return Promise.resolve({ error: null }) },
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: { notifiche_config: { toggles: h.toggles } }, error: null }
          if (table === 'chat_threads') return { data: h.thread, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: rowsFor(), error: null }),
      }
      return {
        select: () => chain,
        delete: () => chain,
        insert: async (rows: Record<string, unknown>[]) => { h.inserts.push(...rows); return { error: null } },
      }
    },
  }
}

beforeEach(() => {
  h.toggles = {}
  h.inserts = []
  h.deletes = []
  h.thread = { teacher_id: 't1', parent_id: 'p1' }
  invalidateNotificheConfigCache()
})

describe('notificaEvento', () => {
  it('toggle off → nessun insert e nessun debounce', async () => {
    h.toggles = { chat_genitore: false }
    await notificaEvento(makeClient() as never, {
      tipo: 'chat_genitore', scuolaId: 's1', utenteIds: ['p1'], titolo: 'T', entitaId: 'th1', debounce: true,
    })
    expect(h.inserts).toHaveLength(0)
    expect(h.deletes).toHaveLength(0)
  })

  it('somma utenteIds e genitori degli alunni, deduplicati', async () => {
    await notificaEvento(makeClient() as never, {
      tipo: 'avviso', scuolaId: 's1', utenteIds: ['p1', 'x1'], alunnoIds: ['a1'], titolo: 'T',
    })
    const destinatari = h.inserts.map((r) => r.utente_id).sort()
    expect(destinatari).toEqual(['p1', 'p2', 'x1'])
  })

  it('debounce: elimina le pending con stesso tipo+entita_id prima di accodare', async () => {
    await notificaEvento(makeClient() as never, {
      tipo: 'chat_docente', scuolaId: 's1', utenteIds: ['t1'], titolo: 'T', entitaId: 'th1', debounce: true, bufferMin: 0,
    })
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0]).toMatchObject({ tipo: 'chat_docente', entita_id: 'th1', push_inviata_il: null })
    expect(h.inserts).toHaveLength(1)
  })

  it('nessun destinatario → nessun insert', async () => {
    h.legami = []
    await notificaEvento(makeClient() as never, { tipo: 'avviso', scuolaId: 's1', alunnoIds: ['a1'], titolo: 'T' })
    expect(h.inserts).toHaveLength(0)
    h.legami = [{ alunno_id: 'a1', genitore_id: 'p1' }, { alunno_id: 'a1', genitore_id: 'p2' }]
  })
})

describe('destinatari', () => {
  it('controparteThread: dal docente → genitore e viceversa', async () => {
    expect(await controparteThread(makeClient() as never, 'th1', 't1')).toEqual({ utenteId: 'p1', versoGenitore: true })
    expect(await controparteThread(makeClient() as never, 'th1', 'p1')).toEqual({ utenteId: 't1', versoGenitore: false })
    expect(await controparteThread(makeClient() as never, 'th1', 'estraneo')).toBeNull()
  })

  it('genitoriDiClassi: alunni delle classi → genitori distinti', async () => {
    const out = await genitoriDiClassi(makeClient() as never, 's1', ['1A'])
    expect(out.sort()).toEqual(['p1', 'p2'])
  })

  it('staffScuola: filtra per role O ruolo (schema legacy doppio)', async () => {
    const out = await staffScuola(makeClient() as never, 's1', ['admin', 'cuoca'])
    expect(out.sort()).toEqual(['u1', 'u2'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL DEBOUNCE NON DEVE CANCELLARE LE FAMIGLIE DEGLI ALTRI.
//
// Client con STATO, non un mock piatto: la `delete` toglie davvero le righe da
// `h.notifiche` e la `insert` ce le mette. Con un mock che si limita a registrare
// la forma della chiamata, questo test resterebbe verde anche col difetto —
// che è esattamente il modo in cui il difetto è sopravvissuto finora.
//
// Il caso è quello vero, misurato in produzione il 07/09: un'insegnante carica
// 37 foto (una POST ciascuna), ogni foto tagga bambini diversi, e `entitaId` è
// l'INSEGNANTE. Senza il filtro per destinatario sopravvivevano solo i genitori
// dell'ultima foto: 168 avvisi persi e 153 famiglie mai avvisate in due giorni.
// ─────────────────────────────────────────────────────────────────────────────

function makeStatefulClient() {
  return {
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => { filtri[col] = val; return chain },
        in: (col: string, val: unknown) => { filtri[col] = val; return chain },
        // `is` NON è il terminale: la delete chiude con `.select('id')`, che è
        // ciò che restituisce le righe tolte. Se questo mock si fermasse a `is`,
        // la catena esploderebbe, il `catch` di `notificaEvento` inghiottirebbe
        // tutto e i test qui sotto sarebbero verdi PER LA RAGIONE SBAGLIATA.
        is: (col: string, val: unknown) => {
          filtri[col] = val
          return {
            select: () => {
              h.deletes.push({ table, ...filtri })
              const utenti = filtri.utente_id as string[] | undefined
              const tolte = h.notifiche.filter((n) => (
                n.tipo === filtri.tipo &&
                n.entita_id === filtri.entita_id &&
                n.push_inviata_il === null &&
                (utenti === undefined || utenti.includes(n.utente_id))
              ))
              h.notifiche = h.notifiche.filter((n) => !tolte.includes(n))
              return Promise.resolve({ data: tolte.map(() => ({ id: 'x' })), error: null })
            },
          }
        },
        maybeSingle: async () => (table === 'admin_settings'
          ? { data: { notifiche_config: { toggles: {} } }, error: null }
          : { data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      }
      return {
        select: () => chain,
        delete: () => chain,
        insert: async (rows: Array<Record<string, unknown>>) => {
          for (const r of rows) {
            h.notifiche.push({
              utente_id: r.utente_id as string,
              tipo: r.tipo as string,
              entita_id: (r.entita_id ?? null) as string | null,
              push_inviata_il: null,
            })
          }
          return { error: null }
        },
      }
    },
  }
}

async function pubblicaFoto(destinatari: string[]) {
  // Le stesse opzioni della galleria: `entitaId` è l'uploader e il buffer è 30'.
  await notificaEvento(makeStatefulClient() as never, {
    tipo: 'galleria', scuolaId: 's1', utenteIds: destinatari, titolo: 'Nuove foto in galleria',
    entitaTipo: 'galleria', entitaId: 'maestra-1', bufferMin: 30, debounce: true,
  })
}

describe('debounce per destinatario (galleria a raffica)', () => {
  beforeEach(() => { h.notifiche = [] })

  it('la seconda foto NON cancella l\'avviso della famiglia della prima', async () => {
    await pubblicaFoto(['fam-a'])
    await pubblicaFoto(['fam-b'])
    expect(h.notifiche.map((n) => n.utente_id).sort()).toEqual(['fam-a', 'fam-b'])
  })

  it('una raffica di 5 foto su 5 famiglie diverse le avvisa tutte e 5', async () => {
    for (const f of ['fam-a', 'fam-b', 'fam-c', 'fam-d', 'fam-e']) await pubblicaFoto([f])
    expect(h.notifiche).toHaveLength(5)
  })

  it('ma la stessa famiglia taggata su 4 foto riceve UN avviso solo (il debounce serve ancora)', async () => {
    for (let i = 0; i < 4; i++) await pubblicaFoto(['fam-a'])
    expect(h.notifiche.filter((n) => n.utente_id === 'fam-a')).toHaveLength(1)
  })

  it('la delete è ristretta ai destinatari che sta per riaccodare', async () => {
    await pubblicaFoto(['fam-a', 'fam-b'])
    const ultima = h.deletes[h.deletes.length - 1]
    expect(ultima.utente_id).toEqual(['fam-a', 'fam-b'])
  })

  it('345 destinatari (Giugliano) NON finiscono in un solo `.in`: la richiesta sarebbe da ~13 kB', async () => {
    // PostgREST mette `.in()` in query string. Il repo ha già preso questo 414 una
    // volta e ha scritto il tetto in `@/lib/db/blocchi`: qui si verifica che il
    // debounce lo rispetti, perché la sede più grande è quella in cui la
    // correzione si romperebbe per prima — e in silenzio.
    const molti = Array.from({ length: 345 }, (_, i) => `fam-${i}`)
    h.deletes = []
    await pubblicaFoto(molti)
    expect(h.deletes.length).toBe(4)
    for (const d of h.deletes) expect((d.utente_id as string[]).length).toBeLessThanOrEqual(100)
    expect(h.notifiche).toHaveLength(345)
  })

  it('una riga GIÀ INVIATA non viene toccata dal debounce', async () => {
    h.notifiche.push({ utente_id: 'fam-a', tipo: 'galleria', entita_id: 'maestra-1', push_inviata_il: 'ieri' })
    await pubblicaFoto(['fam-a'])
    expect(h.notifiche.filter((n) => n.utente_id === 'fam-a')).toHaveLength(2)
  })
})
