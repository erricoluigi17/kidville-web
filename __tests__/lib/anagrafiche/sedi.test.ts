import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'

/**
 * DI CHE PLESSO È QUESTA PERSONA — le tre letture condivise.
 *
 * Il modulo `@/lib/anagrafiche/sedi` è nato il 2026-09-03 raccogliendo la stessa
 * coppia di query che viveva, identica, in tre route diverse
 * (`chat/messages`, `parent/onboarding`, `parent/submissions`, e a mano dentro
 * `chat/threads/[id]/sospendi`). Tre copie sono tre occasioni di correggerne una
 * e dimenticarne due — ed è già successo in questo repo.
 *
 * Qui si prova il modulo per quello che è: tre letture che rispondono «di che
 * plesso è questa riga», che non lanciano mai, e che quando NON sanno lo dicono
 * — nel valore di ritorno e in una riga di log.
 */

const ALUNNO = 'cccccccc-0000-4000-8000-000000000003'
const ALTRO_ALUNNO = 'cccccccc-0000-4000-8000-000000000004'
const SENZA_SEDE = 'cccccccc-0000-4000-8000-000000000005'
const DOCENTE = 'aaaaaaaa-0000-4000-8000-000000000001'
const GENITORE = 'bbbbbbbb-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string; message?: string }>,
  /** La PROIEZIONE di ogni `.select(…)`: vedi `conProiezioni`. */
  proiezioni: [] as Array<{ tabella: string; colonne: string }>,
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import { sedeDiAlunno, sedeDiAccount, sediDeiFigli } from '@/lib/anagrafiche/sedi'

/**
 * ⚠️ IL FINTO CLIENT NON APPLICA LA PROIEZIONE DI `select()` — lo dichiara la sua
 * testata: «le righe tornano INTERE, quindi un test non può provare "quel campo
 * non è stato selezionato"». Qui quel limite morderebbe: cambiando
 * `select('scuola_id')` in `select('id')` queste funzioni continuerebbero a
 * restituire la sede, perché il finto client la manda comunque — mentre in
 * produzione PostgREST restituisce SOLO le colonne chieste e la sede sarebbe
 * `undefined`. È la stessa forma di guasto che il 2026-09-02 ha tenuto ferma la
 * fatturazione (il numero letto un livello più su: `undefined` su 3.311 su 3.311,
 * con i mock verdi).
 *
 * Rimedio: si registra la proiezione di ogni `.select()` e la si asserisce. Il
 * finto client resta intatto: il limite è suo e dichiarato, la prova la fa il
 * chiamante.
 */
const conProiezioni = (finto: SupabaseClient): SupabaseClient =>
  new Proxy(finto as unknown as Record<string, unknown>, {
    get(bersaglio, prop) {
      const membro = Reflect.get(bersaglio, prop)
      if (prop !== 'from' || typeof membro !== 'function') return membro
      return (tabella: string) => {
        const builder = (membro as (t: string) => Record<string, unknown>).call(bersaglio, tabella)
        return new Proxy(builder, {
          get(b, chiave) {
            const valore = Reflect.get(b, chiave)
            if (chiave !== 'select' || typeof valore !== 'function') return valore
            return (...args: unknown[]) => {
              h.proiezioni.push({ tabella, colonne: String(args[0] ?? '*') })
              return (valore as (...a: unknown[]) => unknown).apply(b, args)
            }
          },
        })
      }
    },
  }) as unknown as SupabaseClient

const client = () => conProiezioni(creaFintoSupabase(h.db, [], { errori: h.errori }))

const CTX = { gruppo: 'chat', operazione: 'chat/messages:POST', extra: { threadId: 'dddddddd-0000-4000-8000-000000000004' } }

/** L'ultima riga di log con quell'`esito`. */
const rigaLog = (esito: string) =>
  h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)
/** Le colonne chieste a una tabella, in ogni `.select()` che l'ha interrogata. */
const colonneChiesteA = (tabella: string) =>
  h.proiezioni.filter((p) => p.tabella === tabella).map((p) => p.colonne)

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.proiezioni = []
  h.db = {
    alunni: [
      { id: ALUNNO, scuola_id: SEDE_B },
      { id: ALTRO_ALUNNO, scuola_id: SEDE_A },
      { id: SENZA_SEDE, scuola_id: null },
    ],
    utenti: [{ id: DOCENTE, scuola_id: SEDE_B }],
    legame_genitori_alunni: [],
    parents: [],
    student_parents: [],
  }
})

describe('sedeDiAlunno', () => {
  it('risponde con il plesso di QUEL bambino, chiesto per uuid', async () => {
    expect(await sedeDiAlunno(client(), ALUNNO, CTX)).toBe(SEDE_B)
    // …e non è una coincidenza: l'altro bambino sta in un plesso diverso.
    expect(await sedeDiAlunno(client(), ALTRO_ALUNNO, CTX)).toBe(SEDE_A)
    // La colonna della sede è davvero fra quelle chieste: in produzione
    // PostgREST restituisce solo ciò che gli si chiede.
    expect(colonneChiesteA('alunni').every((c) => /\bscuola_id\b/.test(c))).toBe(true)
  })

  it('bambino senza plesso o inesistente: `null`, non un plesso inventato', async () => {
    expect(await sedeDiAlunno(client(), SENZA_SEDE, CTX)).toBeNull()
    expect(await sedeDiAlunno(client(), 'cccccccc-0000-4000-8000-00000000ffff', CTX)).toBeNull()
    // Nessuno dei due è un guasto: niente righe di errore.
    expect(rigaLog('sede-bambino-non-letta')).toBeUndefined()
  })

  it('PostgREST non lancia: la lettura fallita lascia una riga, non il silenzio', async () => {
    // Senza il controllo di `{ error }`, «il bambino non ha plesso» e «non ho
    // potuto leggerlo» sarebbero lo stesso `null`, e solo uno dei due è nostro.
    h.errori = { alunni: { code: '42703', message: 'column does not exist' } }

    expect(await sedeDiAlunno(client(), ALUNNO, CTX)).toBeNull()

    const riga = rigaLog('sede-bambino-non-letta')
    expect(riga).toBeDefined()
    expect(riga![0]).toBe('chat')
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({
      operazione: 'chat/messages:POST',
      error_code: '42703',
      threadId: 'dddddddd-0000-4000-8000-000000000004',
    })
  })
})

describe('sedeDiAccount', () => {
  it('risponde con la sede dell’account chiesto, per uuid', async () => {
    expect(await sedeDiAccount(client(), DOCENTE, CTX)).toBe(SEDE_B)
    expect(colonneChiesteA('utenti').every((c) => /\bscuola_id\b/.test(c))).toBe(true)
  })

  it('account senza sede o inesistente: `null`', async () => {
    expect(await sedeDiAccount(client(), GENITORE, CTX)).toBeNull()
  })

  it('lettura fallita: `null` e una riga di `warn`', async () => {
    h.errori = { utenti: { code: '42703' } }
    expect(await sedeDiAccount(client(), DOCENTE, CTX)).toBeNull()
    const riga = rigaLog('sede-docente-non-letta')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ error_code: '42703' })
  })
})

describe('sediDeiFigli', () => {
  const CTX_MOD = { gruppo: 'modulistica', operazione: 'parent/submissions:POST' }

  it('unisce le sedi dei figli e non le ripete', async () => {
    // Due figli nello STESSO plesso e uno in un altro: due sedi, non tre.
    h.db.legame_genitori_alunni = [
      { genitore_id: GENITORE, alunno_id: ALUNNO },
      { genitore_id: GENITORE, alunno_id: ALTRO_ALUNNO },
    ]
    h.db.alunni = [
      { id: ALUNNO, scuola_id: SEDE_B },
      { id: ALTRO_ALUNNO, scuola_id: SEDE_A },
      { id: 'cccccccc-0000-4000-8000-00000000000e', scuola_id: SEDE_B },
    ]
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: 'cccccccc-0000-4000-8000-00000000000e' })

    expect((await sediDeiFigli(client(), GENITORE, CTX_MOD)).sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('percorre anche il ponte anagrafico `parents` → `student_parents`, non solo il legame runtime', async () => {
    // Il legame runtime è VUOTO: se l'elenco esce lo stesso, è passato dal ponte.
    h.db.parents = [{ id: 'parent-row-1', auth_user_id: GENITORE }]
    h.db.student_parents = [{ parent_id: 'parent-row-1', student_id: ALTRO_ALUNNO }]

    expect(await sediDeiFigli(client(), GENITORE, CTX_MOD)).toEqual([SEDE_A])
  })

  it('nessun figlio, o nessun figlio con un plesso: elenco VUOTO, che vuol dire «non lo so»', async () => {
    expect(await sediDeiFigli(client(), GENITORE, CTX_MOD)).toEqual([])

    h.db.legame_genitori_alunni = [{ genitore_id: GENITORE, alunno_id: SENZA_SEDE }]
    expect(await sediDeiFigli(client(), GENITORE, CTX_MOD)).toEqual([])
  })

  it('lettura fallita: elenco vuoto, una riga di `warn` col CONTEGGIO — e nessun id di minore', async () => {
    h.db.legame_genitori_alunni = [
      { genitore_id: GENITORE, alunno_id: ALUNNO },
      { genitore_id: GENITORE, alunno_id: ALTRO_ALUNNO },
    ]
    h.errori = { alunni: { code: '42703' } }

    expect(await sediDeiFigli(client(), GENITORE, CTX_MOD)).toEqual([])

    const riga = rigaLog('sedi-figli-non-lette')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ n: 2, error_code: '42703' })
    // La redazione è a lista bianca e questi sono minori: nei log il conteggio,
    // mai gli uuid dei bambini.
    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain(ALUNNO)
    expect(tutto).not.toContain(ALTRO_ALUNNO)
  })
})
