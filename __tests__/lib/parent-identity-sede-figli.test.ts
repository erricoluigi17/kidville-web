import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// LA SEDE DI UN GENITORE VIENE DAI FIGLI, NON DA CHI PREME IL BOTTONE.
//
// Audit 2026-07-31 (F6, R6). `ensureParentIdentity(admin, row, { scuolaId:
// auth.user.scuola_id })`: la riga `utenti` del genitore nasceva con la sede
// dell'OPERATORE. L'unico admin reale ha `scuola_id` = Giugliano ed è, per la
// decisione del 30/07, l'unico che possa gestire Aversa e Cesa: appena manda le
// credenziali a una famiglia di Aversa, quel genitore ha `utenti.scuola_id` =
// Giugliano. E quella colonna non è cosmetica — è la sede con cui vengono
// registrate la richiesta GDPR di cancellazione e la notifica dei moduli firmati.
//
// Il dato giusto era già in mano al codice: `assertParentInScope` interroga
// `student_parents → alunni.scuola_id` VENTOTTO RIGHE SOPRA, nella stessa route.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { ensureParentIdentity, sedeDelGenitore } from '@/lib/auth/parent-identity'

const PARENT = { id: 'p1', auth_user_id: null, emails: ['mario@example.test'], first_name: 'Mario', last_name: 'Rossi' }

/** Un figlio nella sede B. L'operatore, invece, lavora nella sede A. */
function dbBase(): DBFinto {
  return {
    parents: [{ id: 'p1', auth_user_id: null }],
    student_parents: [{ parent_id: 'p1', student_id: 'al-b', alunni: { scuola_id: SEDE_B } }],
    utenti: [],
  }
}

/** Finto client + `auth.admin` (che il fixture non emula: non è PostgREST). */
function admin(db: DBFinto, scritture: Scrittura[] = []): SupabaseClient {
  const finto = creaFintoSupabase(db, [], { scritture })
  return {
    from: (t: string) => (finto as unknown as { from: (t: string) => unknown }).from(t),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async (attrs: { email: string }) => ({ data: { user: { id: `auth-${attrs.email}` } }, error: null }),
      },
    },
  } as unknown as SupabaseClient
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => vi.clearAllMocks())

describe('sedeDelGenitore — la sede è una proprietà dei FIGLI', () => {
  it('un solo figlio ⇒ la sua sede, anche se l\'operatore sta altrove', async () => {
    const esito = await sedeDelGenitore(admin(dbBase()), 'p1', { sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: SEDE_B, motivo: 'figli' })
  })

  it('figli in DUE sedi ⇒ decide la sede dichiarata dal dato, mai `[0]`', async () => {
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-b', alunni: { scuola_id: SEDE_B } },
      { parent_id: 'p1', student_id: 'al-c', alunni: { scuola_id: SEDE_C } },
    ]
    const esito = await sedeDelGenitore(admin(db), 'p1', { dichiarata: SEDE_C, sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: SEDE_C, motivo: 'dichiarata' })
  })

  it('figli in due sedi, l\'operatore ne copre una ⇒ quella, e si logga la scelta', async () => {
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-a', alunni: { scuola_id: SEDE_A } },
      { parent_id: 'p1', student_id: 'al-b', alunni: { scuola_id: SEDE_B } },
    ]
    const esito = await sedeDelGenitore(admin(db), 'p1', { sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: SEDE_A, motivo: 'operatore' })
    expect(logDi('sede-genitore-scelta')?.[1]).toBe('info')
  })

  it('figli in due sedi e nessun criterio ⇒ NIENTE sede, e lo si dice', async () => {
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-b', alunni: { scuola_id: SEDE_B } },
      { parent_id: 'p1', student_id: 'al-c', alunni: { scuola_id: SEDE_C } },
    ]
    const esito = await sedeDelGenitore(admin(db), 'p1', { sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: null, motivo: 'ambigua' })
    expect(logDi('sede-genitore-ambigua')?.[1]).toBe('warn')
  })

  it('nessun figlio ⇒ ripiego sulla sede dell\'operatore, DICHIARATO nei log', async () => {
    const db = dbBase()
    db.student_parents = []
    const esito = await sedeDelGenitore(admin(db), 'p1', { sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: SEDE_A, motivo: 'operatore-senza-figli' })
    expect(logDi('sede-genitore-senza-figli')?.[1]).toBe('warn')
  })

  it('lettura fallita ⇒ nessuna sede, e un `error` (non si traveste da «senza figli»)', async () => {
    const finto = creaFintoSupabase(dbBase(), [], { errori: { student_parents: { code: 'PGRST301' } } })
    const client = { from: (t: string) => (finto as unknown as { from: (t: string) => unknown }).from(t) } as unknown as SupabaseClient
    const esito = await sedeDelGenitore(client, 'p1', { sedeOperatore: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: null, motivo: 'errore' })
    expect(logDi('sede-genitore-non-risolta')?.[1]).toBe('error')
  })

  it('schema non migrato (DB E2E della CI) ⇒ si degrada alla sede dichiarata', async () => {
    const finto = creaFintoSupabase(dbBase(), [], { errori: { student_parents: { code: '42P01' } } })
    const client = { from: (t: string) => (finto as unknown as { from: (t: string) => unknown }).from(t) } as unknown as SupabaseClient
    const esito = await sedeDelGenitore(client, 'p1', { dichiarata: SEDE_A })
    expect(esito).toMatchObject({ scuolaId: SEDE_A, motivo: 'schema-assente' })
  })
})

describe('ensureParentIdentity — la riga `utenti` nasce nella sede del figlio', () => {
  it('operatore nella sede A, figlio nella sede B ⇒ `utenti.scuola_id` = B', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const r = await ensureParentIdentity(admin(db, scritture), PARENT, { sedeOperatore: SEDE_A })

    expect(r.ok).toBe(true)
    const insert = scritture.find((s) => s.tabella === 'utenti' && s.operazione === 'insert')
    expect(insert?.valori[0]).toMatchObject({ ruolo: 'genitore', scuola_id: SEDE_B })
    // E nel «database» la riga c'è, con la sede del figlio.
    expect(db.utenti[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('sede DICHIARATA dal dato (import iscrizione) ⇒ quella, anche con un fratello altrove', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const r = await ensureParentIdentity(admin(db, scritture), PARENT, {
      scuolaId: SEDE_C, sedeOperatore: SEDE_A,
    })
    expect(r.ok).toBe(true)
    expect(db.utenti[0]).toMatchObject({ scuola_id: SEDE_C })
  })

  it('figli in due sedi e nessun criterio ⇒ nessuna riga `utenti`, esito parlante', async () => {
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-b', alunni: { scuola_id: SEDE_B } },
      { parent_id: 'p1', student_id: 'al-c', alunni: { scuola_id: SEDE_C } },
    ]
    const scritture: Scrittura[] = []
    const r = await ensureParentIdentity(admin(db, scritture), PARENT, { sedeOperatore: SEDE_A })

    expect(r.ok).toBe(false)
    expect(db.utenti).toEqual([])
    expect(scritture.some((s) => s.tabella === 'utenti')).toBe(false)
  })
})
