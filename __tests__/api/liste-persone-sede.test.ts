import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W3-E — Le liste di persone devono poter DIRE la sede (R72).
//
// Il filtro per sede è arrivato (ondata 2): le liste non mescolano più i plessi
// di nascosto. Ma il CONTRATTO è rimasto quello mono-sede: `gdpr/candidates` e
// `admin/chat/contacts` non selezionano nemmeno `scuola_id`, quindi l'interfaccia
// non potrebbe scrivere il plesso accanto al nome NEANCHE VOLENDO.
//
// Perché conta: l'admin è multi-sede e con «Tutte le sedi» attive vede in
// un'unica lista i bambini dei tre plessi — e nel pannello Oblio quella lista
// alimenta un'ANONIMIZZAZIONE IRREVERSIBILE che si conferma digitando un nome.
// Due bambini omonimi in due sedi, e la conferma non distingue nulla.
//
// ⚠️ NOTA DI METODO. Il finto client NON emula la proiezione di `select()`: le
// righe tornano intere. Un `expect(riga.scuola_id).toBe(…)` sarebbe quindi verde
// ANCHE con la select vecchia — un falso verde da manuale. Qui la proiezione si
// verifica con una spia locale sulle colonne chieste (`proiezioni`), che è
// l'unica cosa che in produzione decide se la colonna arriva o no.
// =============================================================================

const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const GEN_A = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const GEN_B = 'f2f2f2f2-2222-4222-8222-999999999999'
const PAR_A = '0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa'
const PAR_B = '0b0b0b0b-2222-4222-8222-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireKitchenRead: vi.fn(),
  getGenitoriDiAlunni: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  proiezioni: [] as { tabella: string; colonne: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireKitchenRead: h.requireKitchenRead,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: h.getGenitoriDiAlunni,
  getGenitoriDiAlunno: vi.fn(async () => []),
  getFigliDiGenitore: vi.fn(async () => []),
  genitoreHasFiglio: vi.fn(async () => false),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Spia sulle COLONNE chieste: il finto client restituisce le righe intere, quindi
  // senza questo un test sulla proiezione sarebbe verde comunque. Il client è un
  // Proxy con la sola trappola `get`: la scrittura di `select` arriva al bersaglio.
  const conSpia = () => {
    const c = creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture })
    const originale = (c as unknown as { from: (t: string) => unknown }).from.bind(c)
    ;(c as unknown as { from: (t: string) => unknown }).from = (tabella: string) => {
      const b = originale(tabella) as { select: (c?: string, o?: unknown) => unknown }
      const sel = b.select.bind(b)
      b.select = (colonne?: string, opts?: unknown) => {
        h.proiezioni.push({ tabella, colonne: String(colonne ?? '*') })
        return sel(colonne, opts)
      }
      return b
    }
    return c
  }
  return { createAdminClient: async () => conSpia(), createClient: async () => conSpia() }
})

import { GET as CANDIDATES } from '@/app/api/admin/gdpr/candidates/route'
import { GET as CONTACTS } from '@/app/api/admin/chat/contacts/route'
import { GET as SEDI } from '@/app/api/admin/sedi/route'
import { GET as PARENTS } from '@/app/api/admin/parents/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)

/** Colonne chieste sulla tabella, come stringa PostgREST. */
const colonneDi = (tabella: string) =>
  h.proiezioni.filter((p) => p.tabella === tabella).map((p) => p.colonne)

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'DiAlfa', classe_sezione: '2 ANNI', scuola_id: SEDE_A, stato: 'ritirato', anonimizzato_il: null },
    { id: ALU_B, nome: 'Beta', cognome: 'DiBeta', classe_sezione: '2 ANNI', scuola_id: SEDE_B, stato: 'ritirato', anonimizzato_il: null },
  ],
  utenti: [
    { id: GEN_A, nome: 'Genitore', cognome: 'DiAlfa', ruolo: 'genitore' },
    { id: GEN_B, nome: 'Genitore', cognome: 'DiBeta', ruolo: 'genitore' },
  ],
  student_parents: [
    { student_id: ALU_A, parent_id: PAR_A },
    { student_id: ALU_B, parent_id: PAR_B },
  ],
  parents: [
    { id: PAR_A, first_name: 'Anna', last_name: 'DiAlfa' },
    { id: PAR_B, first_name: 'Bruna', last_name: 'DiBeta' },
  ],
})

/** Riproduce il gate vero: la lista di ruoli ammessi la decide la ROUTE; senza,
 *  vale il default del guard. Se la route non allarga i ruoli, il 403 arriva. */
const gate = (
  utente: { id: string; role: string; scuola_id: string },
  predefiniti: string[] = ['admin', 'coordinator', 'segreteria'],
) =>
  async (_r: unknown, allowed: string[] = predefiniti) =>
    allowed.includes(utente.role)
      ? { user: utente }
      : { response: NextResponse.json({ error: 'negato' }, { status: 403 }), user: null }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture.length = 0
  h.proiezioni.length = 0
  h.getGenitoriDiAlunni.mockImplementation(async (_c: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, id === ALU_A ? [GEN_A] : [GEN_B])
    return m
  })
  // Direzione MULTI-SEDE: entrambe le sedi accessibili, nessun cookie di
  // selezione ⇒ la lista è davvero mista, ed è il caso che il difetto colpisce.
  h.requireStaff.mockImplementation(gate({ id: 'dir1', role: 'admin', scuola_id: SEDE_A }))
  // `requireKitchenRead` ha il suo default di ruoli (cucina + staff + docente).
  h.requireKitchenRead.mockImplementation(
    gate({ id: 'dir1', role: 'admin', scuola_id: SEDE_A }, ['admin', 'coordinator', 'segreteria', 'cuoca', 'educator']),
  )
  h.db.utenti_scuole = [{ utente_id: 'dir1', scuola_id: SEDE_B }]
})

describe('GET /api/admin/gdpr/candidates — ogni candidato porta la sua sede', () => {
  it('`scuola_id` è nella proiezione: senza, l\'oblio si conferma alla cieca', async () => {
    const res = await CANDIDATES(req('/api/admin/gdpr/candidates'))
    expect(res.status).toBe(200)
    expect(colonneDi('alunni')).toEqual([expect.stringContaining('scuola_id')])
  })

  it('la sede esce nel corpo, accanto al candidato giusto', async () => {
    const res = await CANDIDATES(req('/api/admin/gdpr/candidates'))
    const j = (await res.json()) as { id: string; scuola_id: string }[]
    expect(j.map((c) => [c.id, c.scuola_id])).toEqual([
      [ALU_A, SEDE_A],
      [ALU_B, SEDE_B],
    ])
  })
})

describe('GET /api/admin/chat/contacts — la rubrica dice a quale plesso si scrive', () => {
  it('`scuola_id` è nella proiezione degli alunni', async () => {
    const res = await CONTACTS(req('/api/admin/chat/contacts'))
    expect(res.status).toBe(200)
    expect(colonneDi('alunni')).toEqual([expect.stringContaining('scuola_id')])
  })

  it('ogni contatto porta `scuolaId` del figlio', async () => {
    const res = await CONTACTS(req('/api/admin/chat/contacts'))
    const j = (await res.json()) as { data: { studentId: string; scuolaId: string }[] }
    expect(j.data.map((c) => `${c.studentId}|${c.scuolaId}`).sort()).toEqual(
      [`${ALU_A}|${SEDE_A}`, `${ALU_B}|${SEDE_B}`].sort(),
    )
  })
})

describe('GET /api/admin/parents — la sede del genitore viene dai FIGLI', () => {
  // `parents` non ha `scuola_id`, e non deve averlo: un genitore può avere figli
  // in due plessi. L'anagrafica adulti però va letta insieme alla sede, come
  // quella degli alunni — altrimenti resta l'unica lista di persone muta.
  it('ogni genitore porta `scuole_ids` dedotti dai legami', async () => {
    const res = await PARENTS(req('/api/admin/parents'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(j.map((p) => `${p.id}|${p.scuole_ids.join(',')}`).sort()).toEqual(
      [`${PAR_A}|${SEDE_A}`, `${PAR_B}|${SEDE_B}`].sort(),
    )
  })

  it('un genitore con figli in due sedi le porta ENTRAMBE', async () => {
    h.db.student_parents.push({ student_id: ALU_B, parent_id: PAR_A })
    const res = await PARENTS(req('/api/admin/parents'))
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    const a = j.find((p) => p.id === PAR_A)!
    expect([...a.scuole_ids].sort()).toEqual([SEDE_A, SEDE_B].sort())
  })
})

describe('GET /api/admin/sedi — la cuoca deve poter sapere qual è la sua sede', () => {
  // `/admin/mensa/cucina` passa sotto `SedeRequired`: il report nominativo con gli
  // allergeni non parte più senza una sede dichiarata. Il guard legge le sedi da
  // QUESTA route; con il gate di default (admin/coordinator/segreteria) la cuoca
  // riceve 403, l'elenco resta vuoto, la sede corrente è `null` e la cuoca resta
  // chiusa fuori dalla SUA pagina. Nessun allargamento di visibilità: la route
  // restituisce comunque solo `scuoleDiUtente`.
  it('200 e SOLO le proprie sedi', async () => {
    const cuoca = { id: 'cuoca1', role: 'cuoca', scuola_id: SEDE_A }
    // Entrambi i guard rifiutano la cuoca sul PROPRIO default: solo una route che
    // la nomina esplicitamente le risponde. Se il ruolo sparisce dalla lista, 403.
    h.requireStaff.mockImplementation(gate(cuoca))
    h.requireKitchenRead.mockImplementation(gate(cuoca, ['admin', 'coordinator', 'segreteria']))
    h.db.utenti_scuole = []
    const res = await SEDI(req('/api/admin/sedi'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: { id: string }[] }
    expect(j.data.map((s) => s.id)).toEqual([SEDE_A])
  })

  it('il genitore resta fuori', async () => {
    const gen = { id: 'gen1', role: 'genitore', scuola_id: SEDE_A }
    h.requireStaff.mockImplementation(gate(gen))
    h.requireKitchenRead.mockImplementation(gate(gen, ['admin', 'coordinator', 'segreteria', 'cuoca', 'educator']))
    const res = await SEDI(req('/api/admin/sedi'))
    expect(res.status).toBe(403)
  })
})
