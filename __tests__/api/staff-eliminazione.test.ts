import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * `admin/staff/eliminazione` — l'anteprima dice ciò che l'esecuzione farà
 *
 * ⚠️ IL FINTO NON EMULA LE CHIAVI ESTERNE, e va detto a lettere: accetta la
 * DELETE che Postgres rifiuterebbe. La domanda «questo docente è davvero
 * cancellabile?» NON è verificabile qui, e il codice non ci poggia sopra —
 * poggia sul RAMO DI RIPIEGO. Ciò che questi test provano è che quel ripiego
 * esista, che si attivi quando `deleteUser` rifiuta, e che la risposta non dica
 * mai «cancellato» su una cancellazione che non c'è stata.
 *
 * ⚠️ LA PROIEZIONE È OBBLIGATORIA. Senza `creaFintoSupabaseConProiezione` il file
 * resterebbe verde anche se la route smettesse di CHIEDERE `ruolo` nella select
 * del bersaglio: la riga finta lo porterebbe comunque, e `puoEliminareStaff`
 * deciderebbe su un valore che in produzione sarebbe `undefined`.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-20 ───────────────────────────────
 *   • tolto il confronto `verdetto.decisione !== body.decisioneAttesa` → 1 rosso
 *   • tolto `.is('archiviato_il', null)` dalla CAS dell'archiviazione → 1 rosso
 *   • fatto rispondere «cancellato» al ramo di ripiego                → 1 rosso
 *   • spostato `sganciaPoteri` PRIMA di `cancellaFascicolo`           → 0 rossi
 *
 * ⚠️ L'ULTIMA RIGA È LA PIÙ UTILE, e si scrive invece di nasconderla. Quella
 * mutazione lascia la suite verde perché NON È UN DIFETTO: l'invariante che
 * conta è «i file escono prima delle righe che li nominano», e sganciare le
 * sezioni non tocca né `anagrafica_personale` né `caricamenti_personale`. Un
 * test scritto apposta per coglierla inchioderebbe un ordine che non ha ragioni,
 * e il prossimo che lo trovasse rosso lo cambierebbe senza capire perché —
 * cioè avremmo speso un lock per difendere una preferenza. L'ordine ASSERITO è
 * quello che il commento della route motiva: storage → rpc → account.
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
  rimozioni: [] as string[][],
  esitoRimozione: 'ok' as 'ok' | 'bloccato',
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

vi.mock('@/lib/storage/rimozione-verificata', () => ({
  rimuoviEVerifica: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => {
    h.ordine.push('storage.remove')
    h.rimozioni.push(percorsi)
    return h.esitoRimozione === 'ok'
      ? { rimossi: percorsi, giaAssenti: [], ancoraPresenti: [], incerti: [], erroreRimozione: false }
      : { rimossi: [], giaAssenti: [], ancoraPresenti: percorsi, incerti: [], erroreRimozione: false }
  }),
  bloccanti: (e: { ancoraPresenti: string[]; incerti: string[] }) => [...e.ancoraPresenti, ...e.incerti],
}))

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
      return { data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1 }, error: null }
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
  h.rimozioni = []
  h.esitoRimozione = 'ok'
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

  it('i FILE escono prima di qualunque riga, e prima della RPC', async () => {
    // Se le righe sparissero per prime, la cascata su `caricamenti_personale`
    // porterebbe via l'unica riga che nomina quei file: resterebbero nel bucket
    // senza che nessuno possa più nominarli.
    await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    const iFile = h.ordine.indexOf('storage.remove')
    expect(iFile).toBeGreaterThanOrEqual(0)
    expect(iFile).toBeLessThan(h.ordine.indexOf('rpc.personale_cancella_fascicolo'))
    expect(iFile).toBeLessThan(h.ordine.indexOf('auth.deleteUser'))
    expect(h.rimozioni[0]).toEqual(['p/fronte.jpg', 'p/retro.jpg'])
  })

  it('la RPC riceve anche la pratica d’origine', async () => {
    await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(h.rpcChiamate[0]).toMatchObject({
      nome: 'personale_cancella_fascicolo',
      args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA },
    })
  })

  it('se le scansioni NON escono: 503, e nessuna riga toccata', async () => {
    h.esitoRimozione = 'bloccato'
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_CANCELLATO')
    expect(h.rpcChiamate).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
  })

  it('se Postgres rifiuta la DELETE si ARCHIVIA, e la risposta lo dice', async () => {
    // Il ramo che il finto non può provare da sé: qui si prova che ESISTE.
    h.deleteUserError = { code: '23503', message: 'violates foreign key constraint' }
    const res = await POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.esito).toBe('archiviato')
    expect(data.motivo).toBe('cancellazione-rifiutata')
    expect(db.utenti[0].archiviato_il).toBeTruthy()
  })
})
