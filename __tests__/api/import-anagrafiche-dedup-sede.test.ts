import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `/api/admin/import/anagrafiche` — la dedup del codice fiscale è PER SEDE, e il
// legame che ne segue è una concessione DUREVOLE di lettura.
//
// Il difetto (audit 2026-07-31, R15/R33/R50/R99): la route risolveva bene la
// sede di SCRITTURA (`resolveScuolaScrittura`) e la usava per `alunni.scuola_id`
// alla creazione, ma la dedup che viene PRIMA era `.eq('codice_fiscale', cf)` e
// basta. Se il CF del foglio combaciava con un minore di un ALTRO plesso,
// `studentId` diventava l'id di quel minore, il ramo di creazione veniva saltato
// e i genitori del foglio finivano agganciati a lui con `student_parents.upsert`.
//
// Non è un errore di anagrafica: `public.current_parent_student_ids()` legge
// proprio `student_parents`, ed è la funzione su cui fanno join le policy RLS di
// presenze, pagamenti e note disciplinari. Quella riga è la chiave che — appena
// alla famiglia del foglio vengono emesse le credenziali — apre in lettura la
// scheda di un minore dell'altra sede. Permanente, e senza un log.
//
// Lo stesso vale nel verso opposto per i GENITORI: la dedup su `parents` resta
// (giustamente) GLOBALE — un adulto può avere figli in due sedi e `parents` non
// ha `scuola_id` — ma riusare quel record significa dare a un account già
// esistente di un'altra sede la scheda del bambino che si sta importando.
//
// I test asseriscono lo STATO ESATTO e l'EFFETTO SUL DATABASE (il finto client
// filtra e scrive davvero, e registra ogni scrittura): mai `not.toBe(403)`.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const PAR_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const PAR_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'

// Dati INVENTATI (il repo è pubblico): il CF non appartiene a nessuno.
const CF_BIMBO = 'AAABBB20A01Z999X'
const CF_GENITORE = 'CCCDDD80A01Z999Y'
const NOME_BIMBO = 'Alfa'
const COGNOME_BIMBO = 'Rossidiprova'
const EMAIL_GENITORE = 'genitore.prova@example.test'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[], errori: h.errori }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[], errori: h.errori }),
  }
})
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

import { POST } from '@/app/api/admin/import/anagrafiche/route'

/** Una riga del prestampato, con le intestazioni italiane vere. */
const foglio = (over: Record<string, unknown> = {}) => ({
  'Nome alunno': NOME_BIMBO,
  'Cognome alunno': COGNOME_BIMBO,
  'Sesso (M/F)': 'M',
  'Data nascita (AAAA-MM-GG)': '2020-01-01',
  'Codice fiscale alunno': CF_BIMBO,
  'Classe/Sezione': '2 ANNI',
  'Genitore1 Nome': 'Anna',
  'Genitore1 Cognome': 'Verdidiprova',
  'Genitore1 Codice fiscale': CF_GENITORE,
  'Genitore1 Email': EMAIL_GENITORE,
  'Genitore1 Telefono': '0000000000',
  'Genitore1 Relazione (madre/padre/tutore)': 'madre',
  ...over,
})

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/import/anagrafiche', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (rows: Record<string, unknown>[] = [foglio()], scuola_id?: string) =>
  POST(post(scuola_id ? { rows, scuola_id } : { rows }))

const dbBase = (): DBFinto => ({
  // L'admin `adm-1` è agganciato a DUE sedi: è il caso in cui la sede va DICHIARATA.
  utenti_scuole: [
    { utente_id: 'adm-1', scuola_id: SEDE_A },
    { utente_id: 'adm-1', scuola_id: SEDE_B },
  ],
  alunni: [],
  parents: [],
  student_parents: [],
  audit_scritture_docente: [],
})

const scrittureSu = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

const alunnoConCf = (cf: string) => h.db.alunni.find((a) => a.codice_fiscale === cf)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.eventi = []
  // Segreteria di SEDE_A: per progetto (decisione 30/07) opera SOLO sulla sua sede,
  // quindi `resolveScuolaScrittura` risolve SEDE_A senza bisogno di dichiararla.
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'ALUNNO — dedup ristretta alla sede + ramo esplicito «esiste ALTROVE»
// ─────────────────────────────────────────────────────────────────────────────

describe('import anagrafiche — la dedup dell\'alunno è vincolata alla sede', () => {
  it('CF che appartiene a un minore di UN\'ALTRA sede → riga in errori[], nessun legame, nessuna scrittura', async () => {
    h.db.alunni = [{ id: ALU_B, codice_fiscale: CF_BIMBO, scuola_id: SEDE_B, nome: 'Beta', cognome: 'Altrasede' }]

    const res = await importa()
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      alunniCreati: number; genitoriCreati: number; legami: number
      errori: { riga: number; messaggio: string }[]
    }

    // L'esito lo legge chi importa: una riga bloccata, con il perché e il rimedio.
    expect(json.errori).toHaveLength(1)
    expect(json.errori[0].riga).toBe(2)
    expect(json.errori[0].messaggio).toMatch(/altra sede/i)
    expect(json.errori[0].messaggio).toMatch(/trasferimento/i)
    expect(json.alunniCreati).toBe(0)
    expect(json.genitoriCreati).toBe(0)
    expect(json.legami).toBe(0)

    // L'EFFETTO, che è ciò che conta: nessuna riga nuova da nessuna parte.
    expect(scrittureSu('alunni')).toHaveLength(0)
    expect(scrittureSu('parents')).toHaveLength(0)
    expect(scrittureSu('student_parents')).toHaveLength(0)
    expect(h.db.alunni).toHaveLength(1)
    expect(h.db.student_parents).toHaveLength(0)
    expect(h.db.parents).toHaveLength(0)
  })

  it('CF già presente NELLA PROPRIA sede → riuso di quel record (comportamento invariato)', async () => {
    h.db.alunni = [{ id: ALU_A, codice_fiscale: CF_BIMBO, scuola_id: SEDE_A, nome: 'Alfa', cognome: 'Miasede' }]

    const res = await importa()
    const json = (await res.json()) as { alunniCreati: number; legami: number; errori: unknown[] }
    expect(res.status).toBe(200)
    expect(json.errori).toHaveLength(0)
    expect(json.alunniCreati).toBe(0)
    expect(json.legami).toBe(1)
    expect(scrittureSu('alunni')).toHaveLength(0)
    expect(h.db.student_parents[0]).toMatchObject({ student_id: ALU_A })
  })

  it('stesso CF in DUE sedi → vince il record della sede di scrittura, non il primo trovato', async () => {
    // L'ordine è deliberato: con la dedup globale (`.eq('codice_fiscale')` e basta)
    // `maybeSingle()` restituirebbe la PRIMA riga, cioè quella di SEDE_B.
    h.db.alunni = [
      { id: ALU_B, codice_fiscale: CF_BIMBO, scuola_id: SEDE_B },
      { id: ALU_A, codice_fiscale: CF_BIMBO, scuola_id: SEDE_A },
    ]

    const res = await importa()
    const json = (await res.json()) as { alunniCreati: number; legami: number; errori: unknown[] }
    expect(json.errori).toHaveLength(0)
    expect(json.alunniCreati).toBe(0)
    expect(json.legami).toBe(1)
    expect(h.db.student_parents).toHaveLength(1)
    expect(h.db.student_parents[0]).toMatchObject({ student_id: ALU_A })
  })

  it('CF mai visto → alunno creato NELLA sede di scrittura (comportamento invariato)', async () => {
    const res = await importa()
    const json = (await res.json()) as { alunniCreati: number; genitoriCreati: number; legami: number }
    expect(json).toMatchObject({ alunniCreati: 1, genitoriCreati: 1, legami: 1 })
    expect(scrittureSu('alunni')).toHaveLength(1)
    expect(scrittureSu('alunni')[0].colpite[0]).toMatchObject({
      scuola_id: SEDE_A,
      codice_fiscale: CF_BIMBO,
    })
    const creato = alunnoConCf(CF_BIMBO)
    expect(h.db.student_parents[0]).toMatchObject({ student_id: creato?.id })
  })

  it('23505 sull\'INSERT (il CF è UNIQUE globale) → messaggio parlante in errori[], non il testo di Postgres', async () => {
    // La dedup non è disponibile (lettura in errore) e l'INSERT sbatte sul vincolo
    // globale `alunni_codice_fiscale_key`: è l'ultima rete, e deve dire cosa fare.
    h.errori = { alunni: { code: '23505', message: 'duplicate key value violates unique constraint "alunni_codice_fiscale_key"' } }

    const res = await importa()
    expect(res.status).toBe(200)
    const json = (await res.json()) as { errori: { messaggio: string }[]; alunniCreati: number }
    expect(json.alunniCreati).toBe(0)
    expect(json.errori).toHaveLength(1)
    expect(json.errori[0].messaggio).toMatch(/già present\w* in anagrafica/i)
    expect(json.errori[0].messaggio).toMatch(/trasferimento/i)
    expect(json.errori[0].messaggio).not.toMatch(/duplicate key/i)
  })

  it('DB E2E non migrato (42703 sulla lettura) → non è un guasto: log `info`, import concluso', async () => {
    h.errori = { alunni: { code: '42703', message: 'column alunni.scuola_id does not exist' } }
    const res = await importa()
    expect(res.status).toBe(200)
    const ev = h.eventi.find((e) => e.campi?.esito === 'dedup-sede-non-disponibile')
    expect(ev?.livello).toBe('info')
    expect(ev?.campi.error_code).toBe('42703')
  })

  it('guasto vero sulla lettura (non schema assente) → log `error`', async () => {
    h.errori = { alunni: { code: '08006', message: 'connection failure' } }
    await importa()
    const ev = h.eventi.find((e) => e.campi?.esito === 'dedup-sede-non-disponibile')
    expect(ev?.livello).toBe('error')
    expect(ev?.campi.error_code).toBe('08006')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL GENITORE — dedup globale (giusta), ma il RIUSO va verificato sui figli
// ─────────────────────────────────────────────────────────────────────────────

describe('import anagrafiche — il riuso di un genitore esistente resta nello scope', () => {
  it('genitore già in anagrafica ma collegato SOLO a minori di un\'altra sede → nessun legame', async () => {
    h.db.alunni = [{ id: ALU_B, codice_fiscale: 'ZZZZZZ20A01Z999Z', scuola_id: SEDE_B }]
    h.db.parents = [{ id: PAR_B, fiscal_code: CF_GENITORE, first_name: 'Anna', last_name: 'Verdidiprova' }]
    // Il join `!inner` di `assertParentInScope` lo porta la riga (il finto client
    // non costruisce i join dalla stringa di select).
    h.db.student_parents = [{ student_id: ALU_B, parent_id: PAR_B, alunni: { scuola_id: SEDE_B } }]

    const res = await importa()
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      alunniCreati: number; genitoriCreati: number; legami: number
      errori: { messaggio: string }[]
    }

    // Il BAMBINO è legittimo (CF mai visto): nasce nella sede di chi importa.
    expect(json.alunniCreati).toBe(1)
    // L'ADULTO no: quel record è di un'altra sede e non si riusa in silenzio.
    expect(json.genitoriCreati).toBe(0)
    expect(json.legami).toBe(0)
    expect(json.errori).toHaveLength(1)
    expect(json.errori[0].messaggio).toMatch(/altra sede/i)

    // È la riga che concede la lettura: non deve esistere.
    expect(scrittureSu('student_parents')).toHaveLength(0)
    expect(h.db.student_parents).toHaveLength(1)
    expect(h.db.student_parents[0]).toMatchObject({ student_id: ALU_B, parent_id: PAR_B })
  })

  it('genitore già in anagrafica con un figlio NELLA PROPRIA sede → riuso e legame, come oggi', async () => {
    h.db.alunni = [{ id: ALU_A, codice_fiscale: 'YYYYYY20A01Z999Y', scuola_id: SEDE_A }]
    h.db.parents = [{ id: PAR_A, fiscal_code: CF_GENITORE, first_name: 'Anna', last_name: 'Verdidiprova' }]
    h.db.student_parents = [{ student_id: ALU_A, parent_id: PAR_A, alunni: { scuola_id: SEDE_A } }]

    const res = await importa()
    const json = (await res.json()) as { genitoriCreati: number; legami: number; errori: unknown[] }
    expect(json.errori).toHaveLength(0)
    expect(json.genitoriCreati).toBe(0)
    expect(json.legami).toBe(1)
    const creato = alunnoConCf(CF_BIMBO)
    expect(h.db.student_parents).toHaveLength(2)
    expect(h.db.student_parents[1]).toMatchObject({ student_id: creato?.id, parent_id: PAR_A })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA SEDE SI DICHIARA (W2-A: il 400 di `resolveScuolaScrittura` è reale)
// ─────────────────────────────────────────────────────────────────────────────

describe('import anagrafiche — la sede di scrittura non si indovina', () => {
  it('admin su DUE sedi senza `scuola_id` → 400 e ZERO scritture', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })

    const res = await importa()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(h.scritture).toHaveLength(0)
    expect(h.db.alunni).toHaveLength(0)
    expect(h.db.parents).toHaveLength(0)
    expect(h.db.student_parents).toHaveLength(0)
  })

  it('admin su DUE sedi che dichiara SEDE_B → l\'alunno nasce a SEDE_B', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })

    const res = await importa([foglio()], SEDE_B)
    expect(res.status).toBe(200)
    expect(scrittureSu('alunni')[0].colpite[0]).toMatchObject({ scuola_id: SEDE_B })
    expect(alunnoConCf(CF_BIMBO)?.scuola_id).toBe(SEDE_B)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I LOG — l'evento c'è, e non porta con sé i dati di un minore
// ─────────────────────────────────────────────────────────────────────────────

describe('import anagrafiche — il blocco cross-sede si vede nei log, senza PII', () => {
  it('il blocco è loggato a livello `error` con i conteggi e la sede', async () => {
    h.db.alunni = [{ id: ALU_B, codice_fiscale: CF_BIMBO, scuola_id: SEDE_B }]
    await importa()
    const ev = h.eventi.find((e) => e.campi?.esito === 'import-bloccato-cross-sede')
    expect(ev).toBeDefined()
    expect(ev?.livello).toBe('error')
    expect(ev?.campi.sede_id).toBe(SEDE_A)
    expect(ev?.campi.righe_cf_altra_sede).toBe(1)
  })

  it('il log non contiene né il codice fiscale, né il nome, né l\'email della famiglia', async () => {
    h.db.alunni = [{ id: ALU_B, codice_fiscale: CF_BIMBO, scuola_id: SEDE_B }]
    await importa()
    const serializzato = JSON.stringify(h.eventi)
    expect(serializzato).not.toContain(CF_BIMBO)
    expect(serializzato).not.toContain(CF_GENITORE)
    expect(serializzato).not.toContain(NOME_BIMBO)
    expect(serializzato).not.toContain(COGNOME_BIMBO)
    expect(serializzato).not.toContain(EMAIL_GENITORE)
  })

  it('import senza blocchi → nessun evento di blocco (il log non grida al lupo)', async () => {
    await importa()
    expect(h.eventi.filter((e) => e.campi?.esito === 'import-bloccato-cross-sede')).toHaveLength(0)
  })
})
