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
 *   righe in UNA transazione → account → file nel CESTINO. I poteri (classi, sedi,
 * push, orario, compiti) non si sganciano prima: li toglie la DELETE del profilo nella
 * stessa transazione (cascata e SET NULL della baseline), così una funzione che fallisce
 * non lascia un dipendente attivo e senza classi.
 * I file per ULTIMI: un passo che fallisce dopo di loro li avrebbe persi. Nel
 * cestino e non cancellati: finché il giro notturno non li distrugge, un errore si
 * rimedia. I percorsi si leggono per primi, e la funzione aggiunge quelli delle righe
 * di `caricamenti_personale` che ha staccato invece di lasciarle sparire in cascata.
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
  /**
   * Risposta per nome di funzione; una funzione assente risponde PGRST202, come il DB della CI.
   * Una funzione al posto della risposta può cambiare il finto database (la transazione che va
   * a buon fine e la cui risposta si perde).
   */
  rpcRisposte: {} as Record<string, { data: unknown; error: unknown } | (() => { data: unknown; error: unknown })>,
  /** Dopo la prima RPC, `utenti` non si legge più (la rete che cade anche sulla rilettura). */
  utentiNonLeggibiliDopoRpc: false,
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
import { logScrittura } from '@/lib/audit/scrittura'

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
      if (t === 'utenti' && h.utentiNonLeggibiliDopoRpc && h.rpcChiamate.length > 0) {
        const fallita = { data: null, error: { code: '', message: 'TypeError: fetch failed' } }
        const catena: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'is']) catena[m] = () => catena
        catena.maybeSingle = async () => fallita
        return catena
      }
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
      const r = h.rpcRisposte[nome]
      if (typeof r === 'function') return r()
      return r ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
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
  h.utentiNonLeggibiliDopoRpc = false
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

  // I passi che `sganciaPoteri` faceva PRIMA della funzione: ora li fa la DELETE del profilo.
  const SGANCIO = [
    'utenti_sezioni.delete',
    'utenti_sezioni_materie.delete',
    'utenti_scuole.delete',
    'push_subscriptions.delete',
    'orario_settimanale.update',
    'task_interni.update',
  ]

  it("l'ordine: righe in transazione (con i poteri) → account → file nel CESTINO, per ultimi", async () => {
    await conferma()
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente', 'auth.deleteUser', 'storage.cestino'])
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

  it('nel cestino vanno anche i percorsi che la funzione ha staccato dal registro, una volta sola', async () => {
    h.rpcRisposte.personale_elimina_dipendente = {
      data: {
        pratiche_cancellate: 1,
        anagrafiche_cancellate: 1,
        profili_cancellati: 1,
        percorsi_staccati: ['p/fronte.jpg', 'documenti/x/registro.pdf'],
      },
      error: null,
    }
    const res = await conferma()
    expect(h.spostati).toEqual([['p/fronte.jpg', 'p/retro.jpg', 'documenti/x/registro.pdf']])
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', fileNelCestino: 3 })
    // L'ordine non cambia: il cestino resta l'ultimo passo.
    expect(h.ordine.indexOf('auth.deleteUser')).toBeLessThan(h.ordine.indexOf('storage.cestino'))
  })

  it.each([
    ['elementi che non sono percorsi', [42, '', '  ', null, 'documenti/y.pdf'], ['p/fronte.jpg', 'p/retro.jpg', 'documenti/y.pdf']],
    ['una stringa invece di un elenco', 'documenti/z.pdf', ['p/fronte.jpg', 'p/retro.jpg']],
  ])('percorsi_staccati con %s: nel cestino solo percorsi veri', async (_caso, staccati, attesi) => {
    h.rpcRisposte.personale_elimina_dipendente = {
      data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1, profili_cancellati: 1, percorsi_staccati: staccati },
      error: null,
    }
    await conferma()
    expect(h.spostati).toEqual([attesi])
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
    // Archiviare SGANCIA, per conto suo, e solo dopo che la funzione ha rifiutato.
    for (const passo of SGANCIO) expect(h.ordine.indexOf(passo)).toBeGreaterThan(0)
  })

  it.each(['57014', '40P01'])('un guasto della funzione (%s): 503, e NIENTE è stato toccato, nemmeno classi e sedi', async (code) => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code, message: 'annullata' } }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_CANCELLATO')
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente'])
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'righe-dipendente-non-cancellate', entita_id: BERSAGLIO }),
      expect.objectContaining({ code }),
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
    // Un codice di PostgREST è una risposta arrivata: guasto vero, mai «esito incerto».
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'righe-dipendente-non-cancellate' }),
      expect.objectContaining({ code }),
    )
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

  // ─── Il secondo POST e l'account già tolto (seconda revisione, punto 4) ───────────
  it('secondo POST: la funzione nuova trova zero profili e l\'account è già tolto → «cancellato», niente archivio né allarmi', async () => {
    h.rpcRisposte.personale_elimina_dipendente = {
      data: { pratiche_cancellate: 0, anagrafiche_cancellate: 0, profili_cancellati: 0, percorsi_staccati: [] },
      error: null,
    }
    h.deleteUserError = { status: 404, code: 'user_not_found', message: 'User not found' }
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', giaEliminato: true, accountAccessoRimosso: true })
    expect(h.ordine).not.toContain('utenti.update')
    expect(db.utenti[0].archiviato_il).toBeFalsy()
    expect(vi.mocked(logScrittura)).not.toHaveBeenCalled()
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'staff-gia-cancellato', entita_id: BERSAGLIO }))
    expect(vi.mocked(logEvento)).not.toHaveBeenCalledWith('gdpr', 'error', expect.anything(), expect.anything())
    expect(vi.mocked(logEvento)).not.toHaveBeenCalledWith('gdpr', 'warn', expect.objectContaining({ esito: 'eliminazione-rifiutata-si-archivia' }), expect.anything())
  })

  it('primo POST: l\'account l\'ha già tolto l\'altra richiesta (404) → tolto, a livello info e non error', async () => {
    h.deleteUserError = { status: 404, code: 'user_not_found', message: 'User not found' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', accountAccessoRimosso: true })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'info',
      expect.objectContaining({ esito: 'account-accesso-gia-assente', entita_id: BERSAGLIO }),
      h.deleteUserError,
    )
    expect(vi.mocked(logEvento)).not.toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'account-accesso-non-rimosso' }), expect.anything())
    expect(vi.mocked(logScrittura)).toHaveBeenCalledTimes(1)
  })

  it('ripiego e account già tolto (404): con l\'account è sparito anche il profilo → «cancellato», non archiviato', async () => {
    delete h.rpcRisposte.personale_elimina_dipendente
    h.deleteUserError = { status: 404, code: 'user_not_found', message: 'User not found' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', accountAccessoRimosso: true })
    expect(h.ordine).not.toContain('utenti.update')
  })

  // ─── La risposta persa dopo il COMMIT (seconda revisione, punto 5) ────────────────
  const reteCaduta = { code: '', message: 'TypeError: fetch failed' }

  it('risposta persa e profilo sparito: si va avanti come dopo un successo (account, file letti prima), e lo si dice', async () => {
    h.rpcRisposte.personale_elimina_dipendente = () => {
      db.utenti = []
      return { data: null, error: reteCaduta }
    }
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', praticheCancellate: null, accountAccessoRimosso: true })
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente', 'auth.deleteUser', 'storage.cestino'])
    expect(h.spostati).toEqual([['p/fronte.jpg', 'p/retro.jpg']])
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith('gdpr', 'warn', expect.objectContaining({ esito: 'risposta-persa-dopo-commit', entita_id: BERSAGLIO }))
    expect(vi.mocked(logEvento)).not.toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'righe-dipendente-non-cancellate' }))
  })

  it('esito incerto ma il profilo c\'è ancora: 503 «nessun dato cancellato», e davvero niente toccato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: reteCaduta }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_CANCELLATO')
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente'])
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'righe-dipendente-non-cancellate', entita_id: BERSAGLIO }))
  })

  it('esito incerto e il profilo c\'è ancora ma in un\'altra sede: conta come «c\'è», mai come cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = () => {
      db.utenti[0].scuola_id = 'e0000000-0000-4000-8000-0000000000e2'
      return { data: null, error: reteCaduta }
    }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente'])
  })

  it('esito incerto e il profilo non si rilegge: 503 senza promettere che niente è cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: reteCaduta }
    h.utentiNonLeggibiliDopoRpc = true
    const res = await conferma()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_NON_DECISA')
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente'])
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'esito-eliminazione-non-verificato', entita_id: BERSAGLIO }),
      expect.objectContaining({ code: '' }),
    )
  })

  it('un codice di Postgres non è mai «incerto»: 23505 è un guasto vero, senza rilettura', async () => {
    h.rpcRisposte.personale_elimina_dipendente = () => {
      db.utenti = []
      return { data: null, error: { code: '23505', message: 'duplicate key' } }
    }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect(h.ordine).toEqual(['rpc.personale_elimina_dipendente'])
  })

})
