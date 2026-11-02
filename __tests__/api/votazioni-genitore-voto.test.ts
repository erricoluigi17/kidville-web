import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { SchedeGenitoreRisposta, VotoRisposta } from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI · IL VOTO DEL GENITORE (`POST /api/parent/votazioni/[id]/voto`).
 *
 * Il database è il finto che APPLICA i filtri e ESEGUE le scritture: «una riga sola, aggiornata» e «l'elettore
 * è quello della sessione» sono proprietà VERIFICATE sulle righe, non asserite su una chiamata. Sono finti
 * soltanto il gate (`requireUser`) e il client service-role; la libreria degli aventi diritto e l'ammissione
 * sono quelle VERE, le stesse che usa il GET.
 *
 * Solo dati finti: uuid inventati e cognomi di fantasia.
 */

const h = vi.hoisted(() => ({
  utente: '' as string,
  ruolo: 'genitore' as string,
  anonimo: false,
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string }>,
  scritture: [] as unknown[],
  /** Se valorizzata, un'altra richiesta "vince la corsa": la sua riga compare nel momento dell'insert. */
  rivale: null as Record<string, unknown> | null,
  /** Se vera, ogni `.eq(colonna, null)` sulle query viene annotato in `eqNulli` (il NULL non si confronta con `=`). */
  spiaEqNull: false,
  eqNulli: [] as string[],
  /** Se vera, i voti spariscono nell'istante in cui parte l'update: l'update colpisce 0 righe. */
  votiSpariscono: false,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: () => {
    if (h.anonimo) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    return Promise.resolve({ user: { id: h.utente, role: h.ruolo, scuola_id: null } })
  },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    let out: SupabaseClient = h.rivale ? conCorsa(client) : client
    if (h.votiSpariscono) out = conVotiCheSpariscono(out)
    if (h.spiaEqNull) out = conSpiaEqNull(out)
    return out
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET } from '@/app/api/parent/votazioni/route'
import { POST } from '@/app/api/parent/votazioni/[id]/voto/route'

/**
 * La CORSA fra due richieste dello stesso elettore: tra la lettura «non c'è ancora il voto» e l'insert, l'altra
 * richiesta scrive il suo. L'insert di questa trova la riga già lì e il database risponde `23505`. Il finto
 * non ha concorrenza: la si mette in scena nel punto preciso in cui avviene, e solo per `votazioni_voti`.
 */
function conCorsa(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver)
      return (tabella: string) => {
        const builder = target.from(tabella)
        if (tabella !== 'votazioni_voti') return builder
        return new Proxy(builder, {
          get(bt, bp, br) {
            if (bp !== 'insert') return Reflect.get(bt, bp, br)
            return () => {
              if (h.rivale) (h.db.votazioni_voti ??= []).push({ ...h.rivale })
              return Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              })
            }
          },
        })
      }
    },
  })
}

/**
 * L'UPDATE CHE NON TROVA PIÙ LA RIGA: tra la lettura del voto e l'update la riga sparisce. Il database risponde
 * senza errore e con zero righe aggiornate: la route non deve dire 200 («voto cambiato») per una scrittura che
 * non è avvenuta.
 */
function conVotiCheSpariscono(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver)
      return (tabella: string) => {
        const builder = target.from(tabella)
        if (tabella !== 'votazioni_voti') return builder
        return new Proxy(builder, {
          get(bt, bp) {
            const valore = Reflect.get(bt, bp, bt)
            if (bp !== 'update' || typeof valore !== 'function') return typeof valore === 'function' ? valore.bind(bt) : valore
            return (...args: unknown[]) => {
              h.db.votazioni_voti.length = 0
              return valore.apply(bt, args)
            }
          },
        })
      }
    },
  })
}

/**
 * LA SPIA SUL NULL: il finto confronta `null` con `null` anche per `eq`, PostgreSQL no (`= NULL` non è mai vero,
 * e PostgREST con un uuid risponde 22P02). Il finto quindi non può accorgersene da solo: qui si annota ogni
 * `.eq(colonna, null)` lungo tutta la catena, e il test pretende che non ce ne sia nessuno.
 */
function conSpiaEqNull<T extends object>(radice: T): T {
  const avvolgi = <B extends object>(builder: B): B =>
    new Proxy(builder, {
      get(bt, bp) {
        const valore = Reflect.get(bt, bp, bt)
        if (typeof valore !== 'function') return valore
        if (bp === 'eq') {
          return (colonna: string, v: unknown) => {
            if (v === null || v === undefined) h.eqNulli.push(colonna)
            return avvolgi(valore.call(bt, colonna, v))
          }
        }
        if (bp === 'then') return valore.bind(bt)
        return (...args: unknown[]) => {
          const r = valore.apply(bt, args)
          return r !== null && typeof r === 'object' && typeof (r as { eq?: unknown }).eq === 'function' ? avvolgi(r) : r
        }
      },
    })
  return new Proxy(radice, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver)
      return (tabella: string) => avvolgi((target as unknown as SupabaseClient).from(tabella))
    },
  })
}

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

// ── persone ──────────────────────────────────────────────────────────────────
const ELETTORE = uuid('a0000000', 1) // Rossi Anna: figli in A1 (due), A2 e B1
const COLLEGA = uuid('a0000000', 2) // Bianchi Luca: genitore in A1
const VERDI = uuid('a0000000', 3) // Verdi Marta: genitore in A2
const NERI = uuid('a0000000', 4) // Neri Paolo: genitore in B1
const INATTIVO = uuid('a0000000', 5) // genitore in A1, account disattivato
const SOLO_A = uuid('a0000000', 6) // Gialli Gina: figlio solo in A1
const ALTRO_A3 = uuid('a0000000', 7) // Azzurri Aldo: genitore in A3
const ESTRANEO = uuid('a0000000', 9) // senza figli

// ── sedi, classi, votazioni ──────────────────────────────────────────────────
const A1 = uuid('c1000000', 1)
const A2 = uuid('c2000000', 2)
const A3 = uuid('c3000000', 3)
const B1 = uuid('c4000000', 4)

const VOT_A = uuid('d0000000', 1) // sede A: A1, A2, A3 + istituto
const VOT_B = uuid('d0000000', 2) // sede B: B1 + istituto
const VOT_SOLO_CLASSI = uuid('d0000000', 3) // sede A: A1, senza istituto
const VOT_SCADUTA = uuid('d0000000', 4)
const VOT_CHIUSA = uuid('d0000000', 5)

const AL = (n: number) => uuid('b0000000', n)
const ORA = Date.now()
const GIORNO = 24 * 60 * 60 * 1000
const fra = (ms: number) => new Date(ORA + ms).toISOString()

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
  id,
  cognome,
  nome,
  ruolo: 'genitore',
  attivo: true,
  ...extra,
})
const alunno = (id: string, section_id: string, scuola_id: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id,
  section_id,
  stato: 'iscritto',
  archiviato_il: null,
  nome: 'Bimbo',
  cognome: 'Finto',
  classe_sezione: 'CLASSE',
  ...extra,
})
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })
const votazione = (id: string, scuola_id: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id,
  titolo: 'Elezione di prova',
  scadenza: fra(GIORNO),
  chiusa_il: null,
  rappresentante_istituto: false,
  creata_da: uuid('e0000000', 1),
  creata_il: '2026-11-02T08:00:00.000Z',
  aggiornata_da: null,
  aggiornata_il: null,
  ...extra,
})
const classeDi = (votazione_id: string, scuola_id: string, section_id: string): Riga => ({ votazione_id, scuola_id, section_id })
const candidato = (votazione_id: string, scuola_id: string, utente_id: string): Riga => ({ votazione_id, scuola_id, utente_id })

function dbBase(): DBFinto {
  return {
    schools: [
      { id: SEDE_A, nome: 'Kidville Alfa' },
      { id: SEDE_B, nome: 'Kidville Beta' },
    ],
    sections: [
      { id: A1, scuola_id: SEDE_A, name: '2 ANNI' },
      { id: A2, scuola_id: SEDE_A, name: '3 ANNI' },
      { id: A3, scuola_id: SEDE_A, name: '4 ANNI' },
      { id: B1, scuola_id: SEDE_B, name: '2 ANNI' },
    ],
    alunni: [
      alunno(AL(1), A1, SEDE_A),
      alunno(AL(2), A1, SEDE_A),
      alunno(AL(3), A2, SEDE_A),
      alunno(AL(4), B1, SEDE_B),
      alunno(AL(5), A1, SEDE_A),
      alunno(AL(6), A2, SEDE_A),
      alunno(AL(7), B1, SEDE_B),
      alunno(AL(8), A3, SEDE_A),
    ],
    legame_genitori_alunni: [
      legame(AL(1), ELETTORE),
      legame(AL(2), ELETTORE),
      legame(AL(3), ELETTORE),
      legame(AL(4), ELETTORE),
      legame(AL(5), COLLEGA),
      legame(AL(5), INATTIVO),
      legame(AL(5), SOLO_A),
      legame(AL(6), VERDI),
      legame(AL(7), NERI),
      legame(AL(8), ALTRO_A3),
    ],
    student_parents: [],
    parents: [],
    utenti: [
      utente(ELETTORE, 'Rossi', 'Anna'),
      utente(COLLEGA, 'Bianchi', 'Luca'),
      utente(VERDI, 'Verdi', 'Marta'),
      utente(NERI, 'Neri', 'Paolo'),
      utente(INATTIVO, 'Inattivi', 'Ida', { attivo: false }),
      utente(SOLO_A, 'Gialli', 'Gina'),
      utente(ALTRO_A3, 'Azzurri', 'Aldo'),
      utente(ESTRANEO, 'Estranei', 'Elio'),
    ],
    votazioni: [
      votazione(VOT_A, SEDE_A, { rappresentante_istituto: true }),
      votazione(VOT_B, SEDE_B, { rappresentante_istituto: true }),
    ],
    votazioni_classi: [
      classeDi(VOT_A, SEDE_A, A1),
      classeDi(VOT_A, SEDE_A, A2),
      classeDi(VOT_A, SEDE_A, A3),
      classeDi(VOT_B, SEDE_B, B1),
    ],
    votazioni_candidati: [
      candidato(VOT_A, SEDE_A, COLLEGA),
      candidato(VOT_A, SEDE_A, VERDI),
      candidato(VOT_B, SEDE_B, NERI),
    ],
    votazioni_voti: [],
  }
}

const richiesta = (id: string, corpo: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/parent/votazioni/${id}/voto`, {
      method: 'POST',
      body: JSON.stringify(corpo),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  )

type Esito = { stato: number; corpo: Partial<VotoRisposta> & { codice?: string; error?: string } }
async function vota(id: string, corpo: unknown): Promise<Esito> {
  const res = await richiesta(id, corpo)
  return { stato: res.status, corpo: await res.json() }
}
const votaClasse = (id: string, sectionId: string, candidatoId: string) =>
  vota(id, { ambito: 'classe', sectionId, candidatoId })
const votaIstituto = (id: string, candidatoId: string) => vota(id, { ambito: 'istituto', candidatoId })

const righeVoti = () => (h.db.votazioni_voti ?? []) as Riga[]
const scritture = (operazione: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'votazioni_voti' && s.operazione === operazione)

/** Una votazione di sede A con la sola classe A1, senza istituto: serve a un solo test, la si crea al volo. */
function creaVotazioneSenzaIstituto(): string {
  h.db.votazioni.push(votazione(VOT_SOLO_CLASSI, SEDE_A, { rappresentante_istituto: false }))
  h.db.votazioni_classi.push(classeDi(VOT_SOLO_CLASSI, SEDE_A, A1))
  return VOT_SOLO_CLASSI
}

beforeEach(() => {
  h.utente = ELETTORE
  h.ruolo = 'genitore'
  h.anonimo = false
  h.errori = {}
  h.scritture = []
  h.rivale = null
  h.spiaEqNull = false
  h.eqNulli = []
  h.votiSpariscono = false
  h.logEvento.mockClear()
  h.logErrore.mockClear()
  h.db = dbBase()
})

describe('POST /api/parent/votazioni/[id]/voto · il voto di classe', () => {
  it('senza sessione: 401 e nessuna scrittura', async () => {
    h.anonimo = true
    const { stato } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(401)
    expect(h.scritture).toEqual([])
  })

  it('primo voto: 200 { ok, sceltaAttuale, cambiato: false } e UNA riga con la sede della votazione', async () => {
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: COLLEGA, cambiato: false })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0]).toMatchObject({
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'classe',
      section_id: A1,
      elettore_id: ELETTORE,
      candidato_id: COLLEGA,
    })
    // Mai `upsert`: il voto si scrive con una lettura e poi un insert o un update.
    expect(scritture('upsert')).toHaveLength(0)
    expect(scritture('insert')).toHaveLength(1)
  })

  it('ci si può votare da soli', async () => {
    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(200)
    expect(corpo.sceltaAttuale).toBe(ELETTORE)
  })

  it('L\'ELETTORE È SEMPRE LA SESSIONE: un `elettore_id` nel body viene scartato da zod', async () => {
    const { stato } = await vota(VOT_A, {
      ambito: 'classe',
      sectionId: A1,
      candidatoId: COLLEGA,
      elettore_id: COLLEGA,
      elettoreId: COLLEGA,
      scuola_id: SEDE_B,
      scuolaId: SEDE_B,
    })
    expect(stato).toBe(200)
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].elettore_id).toBe(ELETTORE)
    expect(righeVoti()[0].scuola_id).toBe(SEDE_A)
  })

  it('CAMBIO VOTO: una riga sola, `cambiato: true`, `aggiornato_il` valorizzato e `votato_il` intatto', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    const prima = { ...righeVoti()[0] }
    expect(prima.aggiornato_il ?? null).toBeNull()

    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: ELETTORE, cambiato: true })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].candidato_id).toBe(ELETTORE)
    expect(righeVoti()[0].id).toBe(prima.id)
    expect(righeVoti()[0].votato_il).toBe(prima.votato_il)
    expect(typeof righeVoti()[0].aggiornato_il).toBe('string')
    expect(Number.isNaN(Date.parse(righeVoti()[0].aggiornato_il as string))).toBe(false)
    expect(scritture('insert')).toHaveLength(1)
    expect(scritture('update')).toHaveLength(1)
    // L'update tocca SOLO la scelta e l'ora della modifica: elettore, scheda e sede non si riscrivono.
    expect(Object.keys(scritture('update')[0].valori[0]).sort()).toEqual(['aggiornato_il', 'candidato_id'])
  })

  it('la stessa scelta due volte: `cambiato: false`, nessuna scrittura, niente "modificato" inventato', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: COLLEGA, cambiato: false })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].aggiornato_il ?? null).toBeNull()
    expect(scritture('update')).toHaveLength(0)
    expect(scritture('insert')).toHaveLength(1)
  })

  it('CORSA: l\'insert trova la riga dell\'altra richiesta (23505): si rilegge e si aggiorna, senza doppioni', async () => {
    h.rivale = {
      id: uuid('f0000000', 1),
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'classe',
      section_id: A1,
      elettore_id: ELETTORE,
      candidato_id: COLLEGA,
      votato_il: '2026-11-03T09:00:00.000Z',
      aggiornato_il: null,
    }
    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: ELETTORE, cambiato: true })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].id).toBe(uuid('f0000000', 1))
    expect(righeVoti()[0].candidato_id).toBe(ELETTORE)
    expect(typeof righeVoti()[0].aggiornato_il).toBe('string')
  })

  it('CORSA con la stessa scelta dell\'altra richiesta: 200, cambiato false, nessun update', async () => {
    h.rivale = {
      id: uuid('f0000000', 1),
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'classe',
      section_id: A1,
      elettore_id: ELETTORE,
      candidato_id: COLLEGA,
      votato_il: '2026-11-03T09:00:00.000Z',
      aggiornato_il: null,
    }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: COLLEGA, cambiato: false })
    expect(righeVoti()).toHaveLength(1)
    expect(scritture('update')).toHaveLength(0)
  })

  it('figli in due classi: si vota in ognuna, e sono due righe distinte', async () => {
    expect((await votaClasse(VOT_A, A1, COLLEGA)).stato).toBe(200)
    expect((await votaClasse(VOT_A, A2, VERDI)).stato).toBe(200)
    expect(righeVoti()).toHaveLength(2)
    expect(righeVoti().map((r) => r.section_id).sort()).toEqual([A1, A2].sort())
  })

  it('il voto di classe e quello d\'istituto della stessa votazione sono righe distinte', async () => {
    expect((await votaClasse(VOT_A, A1, COLLEGA)).stato).toBe(200)
    expect((await votaIstituto(VOT_A, VERDI)).stato).toBe(200)
    expect(righeVoti()).toHaveLength(2)
    expect(righeVoti().map((r) => r.ambito).sort()).toEqual(['classe', 'istituto'])
  })

  it('un docente-genitore (ruolo docente) vota come genitore', async () => {
    h.ruolo = 'educator'
    const { stato } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(200)
  })

  it('un genitore con un figlio sospeso per morosità vota (nessun gate di morosità)', async () => {
    for (const a of h.db.alunni) if (a.id === AL(1) || a.id === AL(2)) a.stato = 'sospeso'
    const { stato } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(200)
    expect(h.db.pagamenti).toBeUndefined()
  })

  describe('chi non ha diritto', () => {
    it('la classe di un altro genitore (A3, dove non ha figli): 403 VOTO_ELETTORE_NON_AMMESSO, nessuna scrittura', async () => {
      const { stato, corpo } = await votaClasse(VOT_A, A3, ALTRO_A3)
      expect(stato).toBe(403)
      expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
      expect(righeVoti()).toEqual([])
      expect(h.scritture).toEqual([])
    })

    it('una classe che non fa parte della votazione: 403', async () => {
      h.db.votazioni_classi = h.db.votazioni_classi.filter((c) => !(c.votazione_id === VOT_A && c.section_id === A2))
      const { stato, corpo } = await votaClasse(VOT_A, A2, VERDI)
      expect(stato).toBe(403)
      expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
      expect(righeVoti()).toEqual([])
    })

    it('un elettore senza figli: 403', async () => {
      h.utente = ESTRANEO
      const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
      expect(stato).toBe(403)
      expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
    })

    it('un account disattivato: 403', async () => {
      h.utente = INATTIVO
      const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
      expect(stato).toBe(403)
      expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
    })

    it('un figlio ritirato non dà diritto di voto in quella classe', async () => {
      for (const a of h.db.alunni) if (a.id === AL(3)) a.stato = 'ritirato'
      const { stato } = await votaClasse(VOT_A, A2, VERDI)
      expect(stato).toBe(403)
    })

    it('il figlio archiviato non dà diritto di voto', async () => {
      for (const a of h.db.alunni) if (a.id === AL(3)) a.archiviato_il = '2026-09-01T00:00:00.000Z'
      const { stato } = await votaClasse(VOT_A, A2, VERDI)
      expect(stato).toBe(403)
    })
  })

  describe('il candidato', () => {
    it('un genitore di un\'altra classe: 400 VOTAZIONE_CANDIDATO_NON_VALIDO', async () => {
      const { stato, corpo } = await votaClasse(VOT_A, A1, VERDI)
      expect(stato).toBe(400)
      expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
      expect(righeVoti()).toEqual([])
    })

    it('un genitore di un\'altra sede: 400', async () => {
      const { stato, corpo } = await votaClasse(VOT_A, A1, NERI)
      expect(stato).toBe(400)
      expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    })

    it('un account disattivato non è un candidato: 400', async () => {
      const { stato, corpo } = await votaClasse(VOT_A, A1, INATTIVO)
      expect(stato).toBe(400)
      expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    })

    it('un uuid che non esiste: 400', async () => {
      const { stato, corpo } = await votaClasse(VOT_A, A1, uuid('99999999', 1))
      expect(stato).toBe(400)
      expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    })

    it('il voto già dato non salva un candidato che nel frattempo non è più valido', async () => {
      await votaClasse(VOT_A, A1, COLLEGA)
      for (const u of h.db.utenti) if (u.id === COLLEGA) u.attivo = false
      const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
      expect(stato).toBe(400)
      expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    })
  })
})

describe('POST /api/parent/votazioni/[id]/voto · il voto d\'istituto', () => {
  it('voto valido: 200 e una riga con ambito istituto e section_id nullo', async () => {
    const { stato, corpo } = await votaIstituto(VOT_A, VERDI)
    expect(stato).toBe(200)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: VERDI, cambiato: false })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0]).toMatchObject({
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'istituto',
      section_id: null,
      elettore_id: ELETTORE,
      candidato_id: VERDI,
    })
  })

  it('un body con `sectionId: null` esplicito è lo stesso', async () => {
    const { stato } = await vota(VOT_A, { ambito: 'istituto', sectionId: null, candidatoId: COLLEGA })
    expect(stato).toBe(200)
  })

  it('cambio voto d\'istituto: una riga sola aggiornata (il NULL di section_id non crea un secondo voto)', async () => {
    await votaIstituto(VOT_A, VERDI)
    const { corpo } = await votaIstituto(VOT_A, COLLEGA)
    expect(corpo).toEqual({ ok: true, sceltaAttuale: COLLEGA, cambiato: true })
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].candidato_id).toBe(COLLEGA)
  })

  it('CORSA sull\'istituto: 23505, si rilegge con `section_id IS NULL` e si aggiorna', async () => {
    h.rivale = {
      id: uuid('f0000000', 2),
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'istituto',
      section_id: null,
      elettore_id: ELETTORE,
      candidato_id: VERDI,
      votato_il: '2026-11-03T09:00:00.000Z',
      aggiornato_il: null,
    }
    const { stato, corpo } = await votaIstituto(VOT_A, COLLEGA)
    expect(stato).toBe(200)
    expect(corpo.cambiato).toBe(true)
    expect(righeVoti()).toHaveLength(1)
    expect(righeVoti()[0].candidato_id).toBe(COLLEGA)
  })

  it('IL NULL NON SI CONFRONTA CON `=`: nessuna query usa `.eq(colonna, null)` (primo voto, conferma, cambio, corsa)', async () => {
    h.spiaEqNull = true
    expect((await votaIstituto(VOT_A, VERDI)).stato).toBe(200) // primo voto: lettura + insert
    expect((await votaIstituto(VOT_A, VERDI)).stato).toBe(200) // conferma: la lettura trova la riga
    expect((await votaIstituto(VOT_A, COLLEGA)).stato).toBe(200) // cambio: lettura + update
    expect(h.eqNulli).toEqual([])
    h.db.votazioni_voti.length = 0
    h.rivale = {
      id: uuid('f0000000', 3),
      votazione_id: VOT_A,
      scuola_id: SEDE_A,
      ambito: 'istituto',
      section_id: null,
      elettore_id: ELETTORE,
      candidato_id: VERDI,
      votato_il: '2026-11-03T09:00:00.000Z',
      aggiornato_il: null,
    }
    expect((await votaIstituto(VOT_A, COLLEGA)).stato).toBe(200) // corsa: la rilettura dopo il 23505
    expect(h.eqNulli).toEqual([])
    // La spia non è muta: una catena con `.eq('section_id', null)` la fa scattare.
    h.rivale = null
    const finto = await (await import('@/lib/supabase/server-client')).createAdminClient()
    await finto.from('votazioni_voti').select('id').eq('section_id', null as unknown as string)
    expect(h.eqNulli).toEqual(['section_id'])
  })

  it('una votazione senza istituto: 403', async () => {
    const { stato, corpo } = await votaIstituto(creaVotazioneSenzaIstituto(), COLLEGA)
    expect(stato).toBe(403)
    expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
    expect(righeVoti()).toEqual([])
  })

  it('un candidato che non è nell\'elenco dell\'istituto: 400', async () => {
    // SOLO_A è un genitore della sede A, ma la segreteria non l'ha messo fra i candidati.
    const { stato, corpo } = await votaIstituto(VOT_A, SOLO_A)
    expect(stato).toBe(400)
    expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    expect(righeVoti()).toEqual([])
  })

  it('REVIEW FOCUS 2 · il candidato della sede A sulla scheda d\'istituto della sede B: 400 VOTAZIONE_CANDIDATO_NON_VALIDO', async () => {
    // L'elettore ha figli in tutte e due le sedi: ha diritto su entrambe le schede, ma ogni scheda ha i suoi candidati.
    const { stato, corpo } = await votaIstituto(VOT_B, COLLEGA)
    expect(stato).toBe(400)
    expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
    expect(righeVoti()).toEqual([])
    // E il verso opposto.
    const inverso = await votaIstituto(VOT_A, NERI)
    expect(inverso.stato).toBe(400)
    expect(inverso.corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
  })

  it('due sedi: si vota in tutte e due, con i candidati di ciascuna, e sono due righe', async () => {
    expect((await votaIstituto(VOT_A, COLLEGA)).stato).toBe(200)
    expect((await votaIstituto(VOT_B, NERI)).stato).toBe(200)
    expect(righeVoti()).toHaveLength(2)
    expect(righeVoti().map((r) => r.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('chi ha figli solo nella sede A non vota per la sede B: la votazione per lui non esiste (404)', async () => {
    h.utente = SOLO_A
    const { stato, corpo } = await votaIstituto(VOT_B, NERI)
    expect(stato).toBe(404)
    expect(corpo.codice).toBe('VOTAZIONE_NON_TROVATA')
    expect(righeVoti()).toEqual([])
  })

  it('chi ha un figlio in una sola classe della sede vota comunque per l\'istituto di quella sede', async () => {
    h.utente = SOLO_A
    const { stato } = await votaIstituto(VOT_A, COLLEGA)
    expect(stato).toBe(200)
  })

  it('un account disattivato come candidato d\'istituto: 400', async () => {
    h.db.votazioni_candidati.push(candidato(VOT_A, SEDE_A, INATTIVO))
    const { stato, corpo } = await votaIstituto(VOT_A, INATTIVO)
    expect(stato).toBe(400)
    expect(corpo.codice).toBe('VOTAZIONE_CANDIDATO_NON_VALIDO')
  })
})

describe('POST /api/parent/votazioni/[id]/voto · la votazione', () => {
  it('REVIEW FOCUS 3 · dopo la scadenza: 409 VOTAZIONE_CHIUSA, nessuna scrittura', async () => {
    h.db.votazioni.push(votazione(VOT_SCADUTA, SEDE_A, { scadenza: fra(-60 * 1000) }))
    h.db.votazioni_classi.push(classeDi(VOT_SCADUTA, SEDE_A, A1))
    const { stato, corpo } = await votaClasse(VOT_SCADUTA, A1, COLLEGA)
    expect(stato).toBe(409)
    expect(corpo.codice).toBe('VOTAZIONE_CHIUSA')
    expect(h.scritture).toEqual([])
  })

  it('REVIEW FOCUS 3 · dopo la chiusura a mano (anche con la scadenza nel futuro): 409', async () => {
    h.db.votazioni.push(votazione(VOT_CHIUSA, SEDE_A, { chiusa_il: fra(-60 * 1000) }))
    h.db.votazioni_classi.push(classeDi(VOT_CHIUSA, SEDE_A, A1))
    const { stato, corpo } = await votaClasse(VOT_CHIUSA, A1, COLLEGA)
    expect(stato).toBe(409)
    expect(corpo.codice).toBe('VOTAZIONE_CHIUSA')
    expect(h.scritture).toEqual([])
  })

  it('chi ha già votato non può cambiare dopo la scadenza', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    for (const v of h.db.votazioni) if (v.id === VOT_A) v.scadenza = fra(-1000)
    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(409)
    expect(corpo.codice).toBe('VOTAZIONE_CHIUSA')
    expect(righeVoti()[0].candidato_id).toBe(COLLEGA)
  })

  it('una proroga riapre: la stessa votazione scaduta, con la scadenza spostata in avanti, torna a prendere voti', async () => {
    for (const v of h.db.votazioni) if (v.id === VOT_A) v.scadenza = fra(-1000)
    expect((await votaClasse(VOT_A, A1, COLLEGA)).stato).toBe(409)
    for (const v of h.db.votazioni) if (v.id === VOT_A) v.scadenza = fra(GIORNO)
    expect((await votaClasse(VOT_A, A1, COLLEGA)).stato).toBe(200)
  })

  it('una votazione che non esiste: 404 VOTAZIONE_NON_TROVATA', async () => {
    const { stato, corpo } = await votaClasse(uuid('99999999', 9), A1, COLLEGA)
    expect(stato).toBe(404)
    expect(corpo.codice).toBe('VOTAZIONE_NON_TROVATA')
  })

  it('una votazione di una sede in cui non ha figli: 404, come se non esistesse (non si rivela che c\'è)', async () => {
    h.utente = SOLO_A
    const { stato, corpo } = await votaClasse(VOT_B, B1, NERI)
    expect(stato).toBe(404)
    expect(corpo.codice).toBe('VOTAZIONE_NON_TROVATA')
  })

  it('un elettore senza figli: 403 (non ha diritto da nessuna parte), mai 404 sull\'esistenza', async () => {
    h.utente = ESTRANEO
    const { stato, corpo } = await votaClasse(VOT_B, B1, NERI)
    expect(stato).toBe(403)
    expect(corpo.codice).toBe('VOTO_ELETTORE_NON_AMMESSO')
  })
})

describe('POST /api/parent/votazioni/[id]/voto · il body', () => {
  it('l\'id non è un uuid: 400 e il database non si tocca', async () => {
    const { stato } = await votaClasse('non-un-uuid', A1, COLLEGA)
    expect(stato).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('ambito classe senza sectionId: 400', async () => {
    const { stato } = await vota(VOT_A, { ambito: 'classe', candidatoId: COLLEGA })
    expect(stato).toBe(400)
  })

  it('ambito istituto con sectionId: 400', async () => {
    const { stato } = await vota(VOT_A, { ambito: 'istituto', sectionId: A1, candidatoId: COLLEGA })
    expect(stato).toBe(400)
  })

  it('un ambito inventato o un candidato che non è un uuid: 400', async () => {
    expect((await vota(VOT_A, { ambito: 'sede', candidatoId: COLLEGA })).stato).toBe(400)
    expect((await vota(VOT_A, { ambito: 'istituto', candidatoId: 'rossi' })).stato).toBe(400)
    expect(righeVoti()).toEqual([])
  })

  it('un corpo che non è JSON: 400', async () => {
    const res = await POST(
      new NextRequest(`http://localhost/api/parent/votazioni/${VOT_A}/voto`, {
        method: 'POST',
        body: 'non json',
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: VOT_A }) },
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/parent/votazioni/[id]/voto · i guasti', () => {
  it('schema assente (tabelle non migrate): 503 VOTAZIONI_NON_DISPONIBILI', async () => {
    h.errori = { votazioni: { code: 'PGRST205' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(503)
    expect(corpo.codice).toBe('VOTAZIONI_NON_DISPONIBILI')
  })

  it('la lettura della votazione fallita: 500, non un 404', async () => {
    h.errori = { votazioni: { code: 'XX000' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
  })

  it('la lettura dei figli fallita: 500, non un 403', async () => {
    h.errori = { 'legame_genitori_alunni:select': { code: 'XX000' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
  })

  it('la lettura dei genitori della classe fallita: 500, non un 403 né un 400 (un guasto non è un diniego)', async () => {
    h.errori = { 'utenti:select': { code: 'XX000' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(righeVoti()).toEqual([])
  })

  it('l\'insert respinto (altro codice): 500 e nessun log di successo', async () => {
    h.errori = { 'votazioni_voti:insert': { code: 'XX000' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(h.logEvento).not.toHaveBeenCalledWith('votazioni', 'info', expect.anything())
  })

  it('l\'update respinto: 500, il voto vecchio resta', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    h.errori = { 'votazioni_voti:update': { code: 'XX000' } }
    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(righeVoti()[0].candidato_id).toBe(COLLEGA)
  })

  it('l\'update che non trova più la riga (0 righe aggiornate): 500, non un falso "cambiato"', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    h.votiSpariscono = true
    const { stato, corpo } = await votaClasse(VOT_A, A1, ELETTORE)
    expect(stato).toBe(500)
    expect(corpo.codice).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
    expect(h.logEvento).not.toHaveBeenCalledWith('votazioni', 'info', expect.objectContaining({ esito: 'cambiato' }))
  })

  it('la lettura del voto esistente fallita: 500 e nessuna scrittura (non si inserisce alla cieca)', async () => {
    h.errori = { 'votazioni_voti:select': { code: 'XX000' } }
    const { stato } = await votaClasse(VOT_A, A1, COLLEGA)
    expect(stato).toBe(500)
    expect(scritture('insert')).toHaveLength(0)
  })
})

describe('POST /api/parent/votazioni/[id]/voto · il log', () => {
  const info = () => h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni' && c[1] === 'info')

  it('il successo si logga: { operazione, esito, tipo, votazione_id }, nessuna chiave con "voto", nessun nome', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    expect(info()).toHaveLength(1)
    const campi = info()[0][2] as Record<string, unknown>
    expect(campi).toEqual({ operazione: 'scheda', esito: 'registrato', tipo: 'classe', votazione_id: VOT_A })
    for (const chiave of Object.keys(campi)) expect(chiave.toLowerCase()).not.toContain('voto')
    const testo = JSON.stringify(h.logEvento.mock.calls)
    for (const nome of ['Rossi', 'Bianchi', 'Verdi', 'Anna', 'Luca']) expect(testo).not.toContain(nome)
  })

  it('l\'esito dice se il voto è nuovo, cambiato o confermato', async () => {
    await votaClasse(VOT_A, A1, COLLEGA)
    await votaClasse(VOT_A, A1, ELETTORE)
    await votaClasse(VOT_A, A1, ELETTORE)
    expect(info().map((c) => (c[2] as { esito: string }).esito)).toEqual(['registrato', 'cambiato', 'confermato'])
  })

  it('il tipo è l\'ambito', async () => {
    await votaIstituto(VOT_A, COLLEGA)
    expect((info()[0][2] as { tipo: string }).tipo).toBe('istituto')
  })

  it('un rifiuto non scrive il log di successo', async () => {
    await votaClasse(VOT_A, A3, ALTRO_A3)
    await votaClasse(VOT_A, A1, VERDI)
    expect(info()).toHaveLength(0)
  })
})

describe('UNA REGOLA SOLA · la scheda che il GET mostra è la scheda che il POST accetta', () => {
  const elettori = [ELETTORE, COLLEGA, VERDI, NERI, INATTIVO, SOLO_A, ALTRO_A3, ESTRANEO]
  const schede: { votazione: string; ambito: 'classe' | 'istituto'; sectionId: string | null }[] = [
    { votazione: VOT_A, ambito: 'classe', sectionId: A1 },
    { votazione: VOT_A, ambito: 'classe', sectionId: A2 },
    { votazione: VOT_A, ambito: 'classe', sectionId: A3 },
    { votazione: VOT_A, ambito: 'istituto', sectionId: null },
    { votazione: VOT_B, ambito: 'classe', sectionId: B1 },
    { votazione: VOT_B, ambito: 'istituto', sectionId: null },
  ]

  for (const elettore of elettori) {
    it(`elettore ${elettore.slice(0, 8)}…${elettore.slice(-1)}: stessa risposta per ogni scheda`, async () => {
      h.utente = elettore
      const res = await GET(new NextRequest('http://localhost/api/parent/votazioni'))
      const mostrate = ((await res.json()) as SchedeGenitoreRisposta).schede

      for (const s of schede) {
        const scheda = mostrate.find((m) => m.votazioneId === s.votazione && m.ambito === s.ambito && m.sectionId === s.sectionId)
        // Un candidato valido per quella scheda se c'è, altrimenti uno qualunque (che il POST non deve accettare).
        const candidatoId = scheda?.candidati[0]?.utenteId ?? COLLEGA
        h.db = dbBase()
        h.scritture = []
        const { stato } = await vota(s.votazione, { ambito: s.ambito, sectionId: s.sectionId, candidatoId })
        if (scheda) {
          expect(stato, `scheda mostrata ma voto rifiutato: ${s.ambito} ${s.sectionId} ${s.votazione}`).toBe(200)
        } else {
          expect([403, 404], `scheda NON mostrata ma voto accettato o rifiutato col codice sbagliato: ${s.ambito} ${s.sectionId}`).toContain(
            stato,
          )
        }
      }
    })
  }

  it('il confronto non è vuoto: almeno una scheda mostrata e almeno una nascosta nel giro', async () => {
    h.utente = ELETTORE
    const res = await GET(new NextRequest('http://localhost/api/parent/votazioni'))
    const mostrate = ((await res.json()) as SchedeGenitoreRisposta).schede
    expect(mostrate.length).toBe(5)
    h.utente = ALTRO_A3
    const res2 = await GET(new NextRequest('http://localhost/api/parent/votazioni'))
    expect(((await res2.json()) as SchedeGenitoreRisposta).schede.length).toBe(2)
  })
})
