import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * `admin/staff/eliminazione` — l'anteprima dice ciò che l'esecuzione farà
 *
 * ⚠️ IL FINTO NON EMULA LE CHIAVI ESTERNE, e va detto a lettere: accetta la
 * DELETE che Postgres rifiuterebbe. La domanda «questo docente è davvero
 * cancellabile?» la fa `personale_elimina_dipendente`, provata su PGlite in
 * `__tests__/lib/personale-elimina-dipendente-sql.test.ts`. Qui si prova che la
 * route ASCOLTA la risposta: 23503 → si archivia senza aver toccato un file, e mai
 * «cancellato» su una cancellazione che non c'è stata.
 *
 * ⚠️ LA PROIEZIONE È OBBLIGATORIA. Senza `creaFintoSupabaseConProiezione` il file
 * resterebbe verde anche se la route smettesse di CHIEDERE `ruolo` nella select
 * del bersaglio: la riga finta lo porterebbe comunque, e `puoEliminareStaff`
 * deciderebbe su un valore che in produzione sarebbe `undefined`.
 *
 * ─── L'ORDINE (sessione 10 della seconda serie di robustezza) ──────────────────
 *   poteri → righe in UNA transazione → account → file nel CESTINO.
 * I file per ULTIMI: un passo che fallisce dopo di loro li avrebbe persi. Nel
 * cestino e non cancellati: finché il giro notturno non li distrugge, un errore si
 * rimedia. I percorsi si leggono per primi, perché la cascata sulla pratica porta
 * via `caricamenti_personale`.
 *
 * ─── PROVA PER ROTTURA (Compito 8, Passo 7 del piano della sessione 10) ───────
 *   • `spostaScansioniNelCestino` spostato PRIMA di `eliminaRigheDipendente`
 *       → rossi «l'ordine» e «23503 … nessun file toccato»
 *   • tolto il ramo `rifiutata` (cade nel 503)                       → 1 rosso
 *   • fatto rispondere «cancellato» al ramo di ripiego dell'account  → 1 rosso
 * ═══════════════════════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  attore: {
    id: 'a0000000-0000-4000-8000-00000000000a',
    role: 'admin',
    ruoli: ['admin'],
    scuola_id: 'e0000000-0000-4000-8000-0000000000e1',
  } as Record<string, unknown>,
  deleteUserError: null as unknown,
  rpcChiamate: [] as { nome: string; args: unknown }[],
  /** Risposta per nome di funzione; una funzione assente risponde PGRST202, come il DB della CI. */
  rpcRisposte: {} as Record<string, { data: unknown; error: unknown }>,
  spostati: [] as string[][],
  ordine: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => ({ user: h.attore })),
}))

vi.mock('@/lib/auth/scope', () => ({
  assertUtenteInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['e0000000-0000-4000-8000-0000000000e1']),
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => {}) }))

vi.mock('@/lib/storage/cestino-file', () => ({
  spostaNelCestino: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => {
    h.ordine.push('storage.cestino')
    h.spostati.push(percorsi)
    return { nelCestino: percorsi.length, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }
  }),
}))

import { logEvento } from '@/lib/logging/logger'

import { creaFintoSupabaseConProiezione } from '../fixtures/proiezione'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { VOCI_CHE_PESANO } from '@/lib/personale/tracce-docente'

const BERSAGLIO = 'b0000000-0000-4000-8000-0000000000b1'
const SEDE = 'e0000000-0000-4000-8000-0000000000e1'
const PRATICA = 'c0000000-0000-4000-8000-0000000000c1'

let db: DBFinto
let scritture: Scrittura[]
let proiezioni: { tabella: string; colonne: string }[]

/** Un database finto con tutte le tabelle del registro, vuote. */
function dbBase(): DBFinto {
  const d: DBFinto = {
    utenti: [{ id: BERSAGLIO, ruolo: 'educator', role: 'educator', scuola_id: SEDE, archiviato_il: null }],
    parents: [],
    anagrafica_personale: [],
    pratiche_personale: [],
    utenti_sezioni: [],
    utenti_sezioni_materie: [],
    utenti_scuole: [],
    push_subscriptions: [],
    orario_settimanale: [],
    task_interni: [],
  }
  for (const v of VOCI_CHE_PESANO) d[v.tabella] = d[v.tabella] ?? []
  return d
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabaseConProiezione(db, [], { scritture }, proiezioni)
    const from = (client as unknown as { from: (t: string) => Record<string, unknown> }).from.bind(client)
    ;(client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = from(t)
      for (const op of ['delete', 'update'] as const) {
        const orig = (b[op] as (...a: unknown[]) => unknown).bind(b)
        b[op] = (...a: unknown[]) => {
          h.ordine.push(`${t}.${op}`)
          return orig(...a)
        }
      }
      return b
    }
    ;(client as unknown as Record<string, unknown>).rpc = async (nome: string, args: unknown) => {
      h.ordine.push(`rpc.${nome}`)
      h.rpcChiamate.push({ nome, args })
      return h.rpcRisposte[nome] ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    }
    ;(client as unknown as Record<string, unknown>).auth = {
      admin: {
        deleteUser: async () => {
          h.ordine.push('auth.deleteUser')
          return { error: h.deleteUserError }
        },
      },
    }
    return client
  },
}))

import { GET, POST } from '@/app/api/admin/staff/eliminazione/route'

const richiestaGet = () =>
  new Request(`http://localhost/api/admin/staff/eliminazione?id=${BERSAGLIO}`)

const richiestaPost = (corpo: unknown) =>
  new Request('http://localhost/api/admin/staff/eliminazione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

beforeEach(() => {
  vi.clearAllMocks()
  db = dbBase()
  scritture = []
  proiezioni = []
  h.deleteUserError = null
  h.rpcChiamate = []
  h.spostati = []
  h.rpcRisposte = {
    personale_elimina_dipendente: {
      data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1, profili_cancellati: 1 },
      error: null,
    },
    personale_cancella_fascicolo: { data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1 }, error: null },
  }
  h.ordine = []
  h.attore = {
    id: 'a0000000-0000-4000-8000-00000000000a',
    role: 'admin',
    ruoli: ['admin'],
    scuola_id: SEDE,
  }
})

describe("GET — l'anteprima", () => {
  it('docente senza tracce e senza ponte → cancella', async () => {
    const res = await GET(richiestaGet() as never)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.decisione).toBe('cancella')
    expect(data.motivi).toEqual([])
  })

  it('una traccia → archivia, e dice QUALE con la sua etichetta', async () => {
    db.eventi_diario = [{ maestra_id: BERSAGLIO }]
    const res = await GET(richiestaGet() as never)
    const { data } = await res.json()
    expect(data.decisione).toBe('archivia')
    expect(data.motivi).toEqual([{ chiave: 'tracciaDocenteDiario', n: 1 }])
  })

  it('ponte genitore e nessuna traccia → profilo-doppio, nessun comando', async () => {
    db.parents = [{ id: 'p1', auth_user_id: BERSAGLIO }]
    const res = await GET(richiestaGet() as never)
    const { data } = await res.json()
    expect(data.decisione).toBe('profilo-doppio')
    expect(data.ponteGenitore).toBe(true)
  })

  it('CHIEDE il ruolo del bersaglio: senza, il permesso deciderebbe su undefined', async () => {
    await GET(richiestaGet() as never)
    const sulBersaglio = proiezioni.filter((p) => p.tabella === 'utenti')
    expect(sulBersaglio.length).toBeGreaterThan(0)
    expect(sulBersaglio[0].colonne).toContain('ruolo')
  })
})

describe('POST — le guardie che vengono prima di tutto', () => {
  it('sé stessi → 403, e nessuna scrittura', async () => {
    h.attore = { ...h.attore, id: BERSAGLIO }
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_SE_STESSI')
    expect(scritture).toEqual([])
  })

  it('bersaglio di Direzione → 403 anche per un admin', async () => {
    db.utenti = [{ id: BERSAGLIO, ruolo: 'coordinator', role: 'coordinator', scuola_id: SEDE, archiviato_il: null }]
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'archivia', conferma: true }) as never)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE')
    expect(scritture).toEqual([])
  })

  it('senza `conferma` il corpo non passa nemmeno la validazione', async () => {
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella' }) as never)
    expect(res.status).toBe(400)
    expect(scritture).toEqual([])
  })

  it('profilo doppio → 409, e nessuna scrittura', async () => {
    db.parents = [{ id: 'p1', auth_user_id: BERSAGLIO }]
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_PROFILO_DOPPIO')
    expect(scritture).toEqual([])
  })
})

describe('POST — la corsa fra anteprima e conferma', () => {
  it('ha letto «cancella» ma nel frattempo è comparsa una traccia → 409, ZERO scritture', async () => {
    // È il caso che rende impossibile «ho premuto archivia e mi ha cancellato»,
    // e il suo gemello: si asserisce sulle SCRITTURE, non solo sulla risposta.
    db.presenze = [{ registrato_da: BERSAGLIO }]
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_CAMBIATA')
    expect(scritture).toEqual([])
    expect(h.ordine).toEqual([])
  })
})

describe('POST — archivia', () => {
  it('scrive archiviato_il, sgancia i poteri e segna la cessazione', async () => {
    db.eventi_diario = [{ maestra_id: BERSAGLIO }]
    db.utenti_sezioni = [{ utente_id: BERSAGLIO, sezione_id: 's1' }]
    db.anagrafica_personale = [{ utente_id: BERSAGLIO, cessato_il: null, origine_pratica_id: null }]

    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'archivia', conferma: true }) as never)
    expect(res.status).toBe(200)
    expect((await res.json()).data.esito).toBe('archiviato')
    expect(db.utenti[0].archiviato_il).toBeTruthy()
    expect(db.utenti_sezioni).toEqual([])
    expect(db.anagrafica_personale[0].cessato_il).toBeTruthy()
  })

  it("i poteri si sganciano PRIMA che l'account venga archiviato", async () => {
    // `sezioniVisibili` legge `utenti_sezioni` e non guarda il ruolo: invertire
    // l'ordine lascerebbe una finestra in cui l'account è archiviato ma compare
    // ancora fra i docenti di una classe.
    db.eventi_diario = [{ maestra_id: BERSAGLIO }]
    db.utenti_sezioni = [{ utente_id: BERSAGLIO, sezione_id: 's1' }]
    await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'archivia', conferma: true }) as never)
    expect(h.ordine.indexOf('utenti_sezioni.delete')).toBeLessThan(h.ordine.indexOf('utenti.update'))
  })

  it('già archiviato → 409 dalla CAS, non un secondo «fatto»', async () => {
    db.utenti = [
      { id: BERSAGLIO, ruolo: 'educator', role: 'educator', scuola_id: SEDE, archiviato_il: '2026-09-01T00:00:00Z' },
    ]
    db.eventi_diario = [{ maestra_id: BERSAGLIO }]
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'archivia', conferma: true }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STAFF_GIA_ARCHIVIATO')
  })
})

describe('POST — cancella', () => {
  beforeEach(() => {
    db.anagrafica_personale = [
      {
        utente_id: BERSAGLIO,
        origine_pratica_id: PRATICA,
        documento_fronte_path: 'p/fronte.jpg',
        documento_retro_path: 'p/retro.jpg',
        cessato_il: null,
      },
    ]
    db.pratiche_personale = [
      { id: PRATICA, stato: 'approvata', documento_fronte_path: null, documento_retro_path: null },
    ]
  })

  const conferma = () => POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)

  it("l'ordine: poteri → righe in transazione → account → file nel CESTINO, per ultimi", async () => {
    await conferma()
    const i = (passo: string) => h.ordine.indexOf(passo)
    expect(i('utenti_sezioni.delete')).toBeGreaterThanOrEqual(0)
    expect(i('utenti_sezioni.delete')).toBeLessThan(i('rpc.personale_elimina_dipendente'))
    expect(i('rpc.personale_elimina_dipendente')).toBeLessThan(i('auth.deleteUser'))
    expect(i('auth.deleteUser')).toBeLessThan(i('storage.cestino'))
    expect(h.spostati).toEqual([['p/fronte.jpg', 'p/retro.jpg']])
  })

  it('la funzione riceve anche la pratica d’origine', async () => {
    await conferma()
    expect(h.rpcChiamate[0]).toMatchObject({
      nome: 'personale_elimina_dipendente',
      args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA },
    })
  })

  it('la risposta dice quanti file sono nel cestino', async () => {
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      esito: 'cancellato',
      fileNelCestino: 2,
      fileRimossi: 2,
      praticheCancellate: 1,
      accountAccessoRimosso: true,
    })
  })

  it('23503 dal database: si ARCHIVIA, nessun file toccato, nessun account cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = {
      data: null,
      error: { code: '23503', message: 'violates foreign key constraint' },
    }
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ esito: 'archiviato', motivo: 'cancellazione-rifiutata' })
    expect(db.utenti[0].archiviato_il).toBeTruthy()
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
  })

  it('un guasto della funzione (57014): 503, nessun file toccato, nessun account cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code: '57014', message: 'timeout' } }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_CANCELLATO')
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'righe-dipendente-non-cancellate', entita_id: BERSAGLIO }),
      expect.objectContaining({ code: '57014' }),
    )
  })

  it.each(['PGRST202', '42883'])('funzione assente (%s, DB della CI): ripiega su personale_cancella_fascicolo e lo dice', async (code) => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code, message: 'funzione assente' } }
    const res = await conferma()
    expect((await res.json()).data.esito).toBe('cancellato')
    expect(h.rpcChiamate.map((c) => c.nome)).toEqual(['personale_elimina_dipendente', 'personale_cancella_fascicolo'])
    expect(h.rpcChiamate[1]).toMatchObject({ args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA } })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'info',
      expect.objectContaining({ esito: 'rpc-eliminazione-assente-ripiego' }),
      expect.objectContaining({ code }),
    )
  })

  it.each(['42P01', '42703', 'PGRST205'])('%s dentro la funzione è schema a metà: niente ripiego, 503, nessun file toccato', async (code) => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code, message: 'manca qualcosa' } }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect(h.rpcChiamate.map((c) => c.nome)).toEqual(['personale_elimina_dipendente'])
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
  })

  it('ripiego e account rifiutato: i file vanno nel cestino PRIMA di archiviare, perché le righe non ci sono più', async () => {
    delete h.rpcRisposte.personale_elimina_dipendente
    h.deleteUserError = { code: '23503', message: 'violates foreign key constraint' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'archiviato', motivo: 'cancellazione-rifiutata' })
    expect(h.ordine.indexOf('storage.cestino')).toBeGreaterThanOrEqual(0)
    expect(h.ordine.indexOf('storage.cestino')).toBeLessThan(h.ordine.indexOf('utenti.update'))
  })

  it('profilo cancellato ma account di accesso rifiutato: «cancellato», e lo si grida', async () => {
    h.deleteUserError = { status: 500, message: 'Database error deleting user' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', accountAccessoRimosso: false, fileNelCestino: 2 })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'account-accesso-non-rimosso', entita_id: BERSAGLIO }),
      h.deleteUserError,
    )
    expect(db.utenti[0].archiviato_il).toBeFalsy()
  })
})
