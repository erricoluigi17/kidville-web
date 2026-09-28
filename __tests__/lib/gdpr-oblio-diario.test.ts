import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { anonimizzaAlunno } from '@/lib/gdpr/esegui'

// =============================================================================
// L'OBLIO DEVE ARRIVARE AL TESTO DEL DIARIO (2026-09-28, seconda revisione delle routine)
//
// `eventi_diario` porta tre testi liberi scritti su un bambino:
//  · `nota_bambino` — la nota che la maestra scrive per UN genitore («oggi aveva un po' di
//    febbre», «non ha voluto la crema»);
//  · `nota_libera` — la nota di sezione, copiata su ogni riga: può nominare il bambino;
//  · il VALORE delle routine della scuola a testo libero (`routine:<id>`, risposta «testo»):
//    fino a 200 caratteri, pensati proprio per il singolo bambino («pomata per la dermatite»).
//
// Misurato prima di scrivere questo test: `anonimizzaAlunno` leggeva `eventi_diario` SOLO per
// trovare le segnalazioni da bonificare. Dopo un oblio il nome diventava un segnaposto e le note
// restavano leggibili, agganciate a un `alunno_id` invariato. Le routine a testo allargavano il
// buco che c'era già.
//
// Si toglie il TESTO, non la riga: che un bambino abbia pranzato o dormito è un fatto del
// registro, come la presenza. Le asserzioni sono sulla MUTAZIONE, mai sul solo conteggio.
// =============================================================================

const AT = '2026-09-28T09:00:00Z'
const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'

const APPUNTO = { nome: 'Appunto', emoji: '📝', risposta: 'testo' }

function dbConDiario(): DBFinto {
  return {
    eventi_diario: [
      { id: 'd-1', alunno_id: NOSTRO, tipo_evento: 'pranzo', dettagli: { corsi: { primo: 'tutto' } }, nota_bambino: 'DATO SANITARIO DI PROVA', nota_libera: null },
      { id: 'd-2', alunno_id: NOSTRO, tipo_evento: 'bagno', dettagli: { pipi: 1 }, nota_bambino: null, nota_libera: 'NOTA DI SEZIONE CHE LO NOMINA' },
      { id: 'd-3', alunno_id: NOSTRO, tipo_evento: 'routine:d0d0d0d0', dettagli: { ...APPUNTO, valore: 'TESTO LIBERO DI PROVA' }, nota_bambino: null, nota_libera: null },
      { id: 'd-4', alunno_id: NOSTRO, tipo_evento: 'routine:a1b2c3d4', dettagli: { nome: 'Crema', emoji: '🧴', risposta: 'spunta', valore: true }, nota_bambino: null, nota_libera: null },
      { id: 'd-altro', alunno_id: ALTRO, tipo_evento: 'routine:d0d0d0d0', dettagli: { ...APPUNTO, valore: 'TESTO DI UN ALTRO BAMBINO' }, nota_bambino: 'NOTA DI UN ALTRO BAMBINO', nota_libera: 'NOTA DI SEZIONE' },
    ],
  }
}

describe('anonimizzaAlunno — il testo del diario', () => {
  it('azzera le note e il testo delle routine a testo libero del bambino, e SOLO le sue', async () => {
    const db = dbConDiario()
    const r = await anonimizzaAlunno(creaFintoSupabase(db), { id: NOSTRO }, AT, 'test')

    for (const riga of db.eventi_diario.filter((e) => e.alunno_id === NOSTRO)) {
      expect(riga.nota_bambino, `nota del bambino residua su ${riga.id}`).toBeNull()
      expect(riga.nota_libera, `nota di sezione residua su ${riga.id}`).toBeNull()
    }
    const appunto = db.eventi_diario.find((e) => e.id === 'd-3')!
    expect((appunto.dettagli as Record<string, unknown>).valore, 'testo della routine residuo').toBeNull()
    // Nome e icona della routine sono della SCUOLA, non del bambino: restano, e la riga resta leggibile.
    expect(appunto.dettagli).toMatchObject(APPUNTO)

    // Controllo positivo: l'oblio di un bambino non tocca il diario di un altro.
    const altrui = db.eventi_diario.find((e) => e.id === 'd-altro')!
    expect(altrui.nota_bambino).toBe('NOTA DI UN ALTRO BAMBINO')
    expect((altrui.dettagli as Record<string, unknown>).valore).toBe('TESTO DI UN ALTRO BAMBINO')

    expect(r.diarioBonificate).toBe(3)
  })

  it('le RIGHE restano, e i valori che non sono testo libero pure', async () => {
    const db = dbConDiario()
    await anonimizzaAlunno(creaFintoSupabase(db), { id: NOSTRO }, AT, 'test')
    expect(db.eventi_diario).toHaveLength(5)
    expect(db.eventi_diario.find((e) => e.id === 'd-1')!.dettagli).toEqual({ corsi: { primo: 'tutto' } })
    expect((db.eventi_diario.find((e) => e.id === 'd-4')!.dettagli as Record<string, unknown>).valore).toBe(true)
  })

  it('non riscrive le righe che non hanno niente da togliere', async () => {
    const scritture: Scrittura[] = []
    const db: DBFinto = {
      eventi_diario: [
        { id: 'd-1', alunno_id: NOSTRO, tipo_evento: 'pranzo', dettagli: { corsi: {} }, nota_bambino: null, nota_libera: null },
        { id: 'd-2', alunno_id: NOSTRO, tipo_evento: 'routine:d0d0d0d0', dettagli: { ...APPUNTO, valore: null }, nota_bambino: null, nota_libera: null },
      ],
    }
    const r = await anonimizzaAlunno(creaFintoSupabase(db, [], { scritture }), { id: NOSTRO }, AT, 'test')
    expect(scritture.filter((s) => s.tabella === 'eventi_diario').flatMap((s) => s.colpite)).toEqual([])
    expect(r.diarioBonificate).toBe(0)
  })

  it('una lettura fallita del diario si CONTA fra le letture fallite: non è «niente da togliere»', async () => {
    const db = dbConDiario()
    const r = await anonimizzaAlunno(creaFintoSupabase(db, [], { errori: { eventi_diario: { code: '57014' } } }), { id: NOSTRO }, AT, 'test')
    expect(r.lettureFallite).toBeGreaterThan(0)
  })
})

describe('anonimizzaAlunno — il diario di un anno intero, e le colonne che mancano', () => {
  it('oltre le 1000 righe (il tetto muto di PostgREST) si bonifica TUTTO, a pagine', async () => {
    // Un bambino del nido arriva a ~1.400 righe di diario in un anno. Una lettura sola ne vedeva
    // 1.000, e la risposta diceva «completo».
    const eventi = Array.from({ length: 2500 }, (_, i) => ({
      id: `d-${i}`, alunno_id: NOSTRO, tipo_evento: i % 2 ? 'pranzo' : 'routine:d0d0d0d0',
      dettagli: i % 2 ? { corsi: {} } : { ...APPUNTO, valore: `TESTO ${i}` },
      nota_bambino: `NOTA ${i}`, nota_libera: null,
    }))
    const db: DBFinto = { eventi_diario: eventi }
    const r = await anonimizzaAlunno(creaFintoSupabase(db, [], { maxRighe: 1000 }), { id: NOSTRO }, AT, 'test')
    expect(db.eventi_diario.filter((e) => e.nota_bambino !== null), 'note residue').toHaveLength(0)
    expect(db.eventi_diario.filter((e) => (e.dettagli as Record<string, unknown>).valore?.toString().startsWith('TESTO')), 'testi residui').toHaveLength(0)
    expect(r.diarioBonificate).toBe(2500)
  })

  it('DB senza la colonna `nota_bambino` (E2E non migrato): la nota di sezione si bonifica lo stesso', async () => {
    // Un finto minimo: l'update che nomina `nota_bambino` fallisce con 42703, gli altri riescono.
    const riga = { id: 'd-1', alunno_id: NOSTRO, nota_libera: 'NOTA DI SEZIONE' }
    const aggiornamenti: Array<Record<string, unknown>> = []
    const catena = (esito: () => { data: unknown; error: unknown }) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'not', 'like', 'order', 'range', 'in', 'is', 'neq', 'contains', 'limit']) b[m] = () => b
      b.then = (r: (v: unknown) => unknown) => Promise.resolve(esito()).then(r)
      b.maybeSingle = async () => esito()
      return b
    }
    const client = {
      from: (tabella: string) => ({
        select: () => catena(() => ({ data: [], error: null })),
        update: (valori: Record<string, unknown>) => catena(() => {
          if (tabella !== 'eventi_diario') return { data: [], error: null }
          if ('nota_bambino' in valori) return { data: null, error: { code: '42703', message: 'colonna assente' } }
          aggiornamenti.push(valori)
          Object.assign(riga, valori)
          return { data: [{ id: riga.id }], error: null }
        }),
        delete: () => catena(() => ({ data: [], error: null })),
        insert: () => catena(() => ({ data: [], error: null })),
        upsert: () => catena(() => ({ data: [], error: null })),
      }),
      storage: { from: () => ({ remove: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }) }) },
      rpc: async () => ({ data: null, error: null }),
    } as unknown as Parameters<typeof anonimizzaAlunno>[0]
    await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')
    expect(riga.nota_libera, 'la nota di sezione è rimasta').toBeNull()
    expect(aggiornamenti).toContainEqual({ nota_libera: null })
  })
})

describe('anonimizzaAlunno — il registro delle scritture del diario', () => {
  it('le cancellazioni di voci scritte SENZA `entita_id` (prima del 2026-09-28) si bonificano lo stesso', async () => {
    // In produzione, misurato il 28/09: 79 righe d'audit di cancellazioni del diario senza
    // `entita_id`, una con una nota del bambino. `bonificaAuditScritture` cerca per `entita_id`.
    const db: DBFinto = {
      audit_scritture_docente: [
        { id: 'a-1', entita_tipo: 'diario', azione: 'delete', entita_id: null, valore_prima: [{ id: 'd-1', alunno_id: NOSTRO, nota_bambino: 'DATO SANITARIO DI PROVA' }], valore_dopo: null },
        { id: 'a-altro', entita_tipo: 'diario', azione: 'delete', entita_id: null, valore_prima: [{ id: 'd-9', alunno_id: ALTRO, nota_bambino: 'NOTA DI UN ALTRO BAMBINO' }], valore_dopo: null },
      ],
    }
    await anonimizzaAlunno(creaFintoSupabase(db), { id: NOSTRO }, AT, 'test')
    expect(db.audit_scritture_docente.find((a) => a.id === 'a-1')!.valore_prima).toBeNull()
    expect(db.audit_scritture_docente.find((a) => a.id === 'a-altro')!.valore_prima).not.toBeNull()
  })
})
