// PR 4.8, GIRO DI CORREZIONE 4 · NB4 (l'archiviato della finestra non ritrova la classe il 01/09), NB3 sull'INSERT e sull'import, NS12 (la retta
// di agosto per chi non ha l'anno visibile). Stesso banco e stesse regole del giro 3 (route vere, mai UPDATE diretti sulle frequenze). Prima versione: i quattro bloccanti della ri-revisione 2 provati con le ROUTE VERE nella finestra fra la conferma e l'inizio
// (mai con UPDATE diretti sulle frequenze): NB1 il form intero salvato in agosto, NB2 l'archiviazione, NB3 il bambino nuovo creato in
// agosto, B6/P23 l'archiviazione dopo la ricopia e l'annullo. In più i secondari NS2 (battito del job), NS3 (storico della ricopia in ritardo).
// Finti: identità, sedi, logger (catturato), audit. Il client è PGlite con `.or` nella forma di `filtraPerAnnoDiSede`. Solo uuid inventati.
// Ogni prova gira in una transazione che finisce in ROLLBACK; il giorno lo fissa `giorno_roma` dentro la transazione.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest } from 'next/server'
import { BAMBINI, SEDE_E2E, UTENTE, creaBancoPassaggio, type BancoPassaggio } from '../helpers/passaggio-banco'

const h = vi.hoisted(() => ({ db: null as unknown, utente: '' as string, sedi: [] as string[], log: [] as unknown[] }))
vi.mock('@/lib/logging/logger', async (orig) => {
  const o = await orig<typeof import('@/lib/logging/logger')>()
  const f = (a: unknown[]) => a.map((x) => (x instanceof Error ? x.message : x))
  return {
    ...o,
    logEvento: (...a: unknown[]) => void h.log.push(['evento', ...f(a)]),
    logErrore: (...a: unknown[]) => void h.log.push(['errore', ...f(a)]),
    logOk: (...a: unknown[]) => void h.log.push(['ok', ...f(a)]),
  }
})
vi.mock('@/lib/supabase/server-client', async (orig) => {
  const { clienteProvaRoute } = await import('../helpers/cliente-passaggio-pglite')
  return { ...(await orig<typeof import('@/lib/supabase/server-client')>()), createAdminClient: async () => clienteProvaRoute(h.db as PGlite) }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: h.utente, role: 'admin', ruolo: 'admin', scuola_id: SEDE_E2E } }),
  requireUser: async () => ({ user: { id: h.utente, role: 'admin', ruolo: 'admin', scuola_id: SEDE_E2E } }),
  requireDocente: async () => ({ user: { id: h.utente, role: 'admin', ruolo: 'admin', scuola_id: SEDE_E2E } }),
}))
vi.mock('@/lib/sezioni/risoluzione', async (orig) => ({
  ...(await orig<object>()),
  risolviSezione: async (_s: unknown, _u: unknown, q: { sectionId?: string }) => ({ sectionIds: q.sectionId ? [q.sectionId] : [], response: undefined }),
}))
vi.mock('@/lib/anagrafiche/legami', async (orig) => ({ ...(await orig<object>()), getGenitoriDiAlunni: async () => new Map() }))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async () => h.sedi,
  resolveScuoleAttive: async () => h.sedi,
  assertAlunnoInScope: async () => null,
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE_E2E }),
}))
vi.mock('@/lib/crm/aggancio-alunno', () => ({ agganciaDaImport: async () => ({ esito: 'fatto', agganciati: 1 }) }))
vi.mock('@/lib/iscrizioni/import/inviti', async (orig) => ({
  ...(await orig<object>()), invitaGenitore: async () => ({ tipo: 'inviata', authUserId: 'auth-1', messageId: 'm-1' }),
}))
vi.mock('@/lib/auth/parent-identity', () => ({ findAuthUserIdByEmail: async () => null }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: async () => undefined }))
vi.mock('@/lib/audit/scrittura', async (orig) => ({ ...(await orig<object>()), logScrittura: async () => undefined }))

import { POST as ANTEPRIMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/route'
import { PUT as RIGHE } from '@/app/api/admin/anni/[annoSedeId]/passaggio/righe/route'
import { POST as CONFERMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma/route'
import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { PATCH as STUDENTI_PATCH, POST as STUDENTI_POST } from '@/app/api/admin/students/route'
import { GET as DIARIO } from '@/app/api/diary/students/route'
import { eseguiDomanda } from '@/lib/iscrizioni/import/esegui'
import { clienteProvaRoute } from '../helpers/cliente-passaggio-pglite'

let b: BancoPassaggio
type C = Record<string, unknown>
const GEN = '77777777-7777-4777-8777-7777777777c2'
const GEN_N = '77777777-7777-4777-8777-7777777777c3'
const NOME: Record<string, string> = {}
for (const [k, v] of Object.entries(BAMBINI)) NOME[v] = k
const SEZ: Record<string, string> = {}
const nn = (u: unknown) => (typeof u === 'string' ? NOME[u] ?? SEZ[u] ?? u.slice(0, 8) : String(u))

beforeAll(async () => {
  b = await creaBancoPassaggio()
  for (const [k, v] of Object.entries(b.sezioni)) SEZ[v as string] = k
  for (const c of ['archiviato_da uuid', 'archiviato_motivo text', 'archiviato_section_id uuid', 'archiviato_classe_sezione text', 'spazio_liberato_il timestamptz',
    'nome text', 'cognome text', 'data_nascita date', 'data_iscrizione date', 'note_mediche text',
    // le colonne che il POST della segreteria scrive e che il banco non ha
    'gender text', 'citizenship text', 'birth_nation text', 'codice_fiscale text', 'birth_city text', 'birth_province text', 'codice_belfiore_nascita text',
    'residence_address text', 'residence_street_number text', 'residence_city text', 'residence_province text', 'zip_code text', 'allergies text',
    'allergeni jsonb', 'is_bes_dsa boolean', 'usa_pannolino boolean', 'invoice_holder_type text', 'invoice_holder_details jsonb',
    'giorno_scadenza_pagamenti integer', 'consenso_privacy boolean']) {
    await b.db.exec(`ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS ${c}`)
  }
  await b.db.exec(`ALTER TABLE public.utenti ADD COLUMN IF NOT EXISTS scuola_id uuid, ADD COLUMN IF NOT EXISTS attivo boolean DEFAULT true`)
  await b.db.query(`INSERT INTO public.utenti (id, ruolo, scuola_id) VALUES ($1,'genitore',$3), ($2,'genitore',$3) ON CONFLICT DO NOTHING`, [GEN, GEN_N, SEDE_E2E])
  await b.db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1,$2), ($3,$4)`, [GEN, BAMBINI.continuaB, GEN_N, BAMBINI.nuova])
}, 180_000)
afterAll(async () => { await b?.db.close() })

const oggiE = (d: string) => b.db.exec(`CREATE OR REPLACE FUNCTION public.giorno_roma(p_istante timestamptz) RETURNS date LANGUAGE sql STABLE AS $f$ SELECT DATE '${d}' $f$`)
const rows = async <T = C>(sql: string, p: unknown[] = []) => (await b.db.query<T>(sql, p)).rows
async function chiama(fn: unknown, metodo: string, percorso: string, corpo?: unknown): Promise<{ stato: number; corpo: C }> {
  const req = new NextRequest(`http://localhost/api/admin/anni/${b.a}/passaggio${percorso}`, {
    method: metodo,
    headers: { 'x-user-id': h.utente, 'user-agent': 'prova', ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  })
  const res = await (fn as (r: NextRequest, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ annoSedeId: b.a }) })
  return { stato: res.status, corpo: (await res.json().catch(() => null)) as C }
}
async function rotta(fn: unknown, metodo: string, url: string, corpo: unknown) {
  const req = new NextRequest(`http://localhost${url}`, {
    method: metodo, headers: { 'x-user-id': h.utente, 'content-type': 'application/json', 'user-agent': 'prova' }, body: JSON.stringify(corpo),
  })
  const res = await (fn as (r: NextRequest) => Promise<Response>)(req)
  const c = (await res.json().catch(() => null)) as C | null
  return { stato: res.status, errore: c?.error ?? null, id: (c?.id as string | undefined) ?? null }
}
const scheda = async (id: string) => {
  const r = (await rows<C>(`SELECT stato, section_id, archiviato_il IS NOT NULL arch FROM public.alunni WHERE id=$1`, [id]))[0]
  return r ? `${r.stato}/${r.section_id ? nn(r.section_id) : '-'}${r.arch ? '/ARCHIVIATO' : ''}` : 'nessuna scheda'
}
const frequenza = async (id: string, anno: 'vecchio' | 'nuovo') => (await rows<C>(
  `SELECT origine, stato, section_id, data_ingresso::text ing, data_uscita::text usc, retta_mensile::text retta FROM public.frequenze
    WHERE alunno_id=$1 AND anno_sede_id=$2`, [id, anno === 'vecchio' ? b.da : b.a]))[0]
const sintesi = async (id: string) => {
  const nuovo = await frequenza(id, 'nuovo')
  return `${await scheda(id)} · nuovo:${nuovo ? `${nuovo.stato}@${nuovo.section_id ? nn(nuovo.section_id) : '-'}` : 'nessuna'}`
}
const invarianti = async () => (await rows<C>(`SELECT invariante, tabella, righe FROM public.anno_invarianti() WHERE righe > 0`)).map((x) => `${x.invariante}:${x.tabella}=${x.righe}`)
const ricopia = async (d: string) => (await rows<C>(`SELECT public.passaggio_ricopia_schede($1::date, $2::uuid) r`, [d, SEDE_E2E]))[0].r as C
const figliAttivi = async (g: string) => (await rows<C>(`SELECT alunno_id FROM public.figli_attivi($1)`, [g])).map((r) => nn(r.alunno_id))

async function prepara() {
  await chiama(ANTEPRIMA, 'POST', '', { azione: 'anteprima' })
  await chiama(RIGHE, 'PUT', '/righe', { alunno_id: BAMBINI.ritiratoTendina, esito: 'continua' })
  await chiama(RIGHE, 'PUT', '/righe', { alunno_id: BAMBINI.cambiaGradoSenzaSezione, esito: 'esce' })
  const c = await chiama(CONFERMA, 'POST', '/conferma', {})
  expect(c.stato, 'la conferma del passaggio').toBe(200)
}
function prova(titolo: string, fn: () => Promise<void>) {
  it(titolo, async () => {
    await b.db.exec('BEGIN')
    h.db = b.db; h.utente = UTENTE; h.sedi = [SEDE_E2E]; h.log.length = 0
    try { await oggiE(b.oggi); await prepara(); await fn() } finally { await b.db.exec('ROLLBACK') }
  }, 180_000)
}

async function diario(sezione: string, giorno: string) {
  const req = new NextRequest(`http://localhost/api/diary/students?sectionId=${sezione}&sezione=x&date=${giorno}`, { method: 'GET', headers: { 'x-user-id': h.utente, 'user-agent': 'prova' } })
  const res = await (DIARIO as unknown as (r: NextRequest) => Promise<Response>)(req)
  const c = (await res.json().catch(() => null)) as Array<C> | C | null
  expect(res.status, 'GET /api/diary/students').toBe(200)
  return (Array.isArray(c) ? c : []).map((x) => nn(x.id))
}

describe('NB4 · chi è archiviato nella finestra NON ritrova la classe nuova il 01/09 (scheda e diario)', () => {
  const DA_ARCHIVIARE = ['continuaB', 'nuova', 'cambiaGradoConSezione'] as const
  const CLASSE_NUOVA = { continuaB: 'farfalleNuova', nuova: 'girasoliNuova', cambiaGradoConSezione: 'primaria' } as const

  prova('continua, nuova e cambia grado archiviati il 20/08: dopo la ricopia la scheda non ha classe e il diario della classe nuova non li elenca', async () => {
    await b.db.query(`UPDATE public.alunni SET note_mediche = 'nota medica di prova' WHERE id = ANY($1::uuid[])`, [DA_ARCHIVIARE.map((k) => BAMBINI[k])])
    await oggiE('2027-08-20')
    for (const k of DA_ARCHIVIARE) {
      const r = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI[k] })
      expect(r.stato, `archivia ${k}: ${String(r.errore)}`).toBe(200)
      expect(await scheda(BAMBINI[k]), `${k} il 20/08`).toContain('ARCHIVIATO')
    }
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-02')
    for (const k of DA_ARCHIVIARE) {
      const r = (await rows<C>(`SELECT section_id, classe_sezione FROM public.alunni WHERE id=$1`, [BAMBINI[k]]))[0]
      expect(r.section_id, `${k}: la scheda archiviata non ha classe`).toBeNull()
      expect(r.classe_sezione ?? null, `${k}: né nome di classe`).toBeNull()
      expect(await diario(b.sezioni[CLASSE_NUOVA[k]], '2027-09-02'), `${k}: il diario della classe nuova non lo elenca`).not.toContain(k)
      const f = await frequenza(BAMBINI[k], 'nuovo')
      expect(f?.stato, `${k}: la frequenza nuova è chiusa`).toBe('ritirato')
      expect(f?.section_id ?? null, `${k}: e senza classe`).toBeNull()
    }
    expect(await figliAttivi(GEN), 'la famiglia di continuaB non lo vede il 02/09').toEqual([])
    expect(await figliAttivi(GEN_N), 'né quella di nuova').toEqual([])
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })

  prova('M10 · un bambino nato col POST nella finestra e archiviato: nessun allarme della 11 dal 01/09', async () => {
    await oggiE('2027-08-20')
    const nato = await rotta(STUDENTI_POST, 'POST', '/api/admin/students', {
      nome: 'Prova', cognome: 'Nato', data_nascita: '2024-03-03', classe_sezione: 'Girasoli', gender: 'M',
    })
    expect(nato.stato, `POST: ${String(nato.errore)}`).toBe(201)
    const r = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: nato.id })
    expect(r.stato, `archivia: ${String(r.errore)}`).toBe(200)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-02')
    const x = (await rows<C>(`SELECT section_id FROM public.alunni WHERE id=$1`, [nato.id]))[0]
    expect(x.section_id, 'la scheda archiviata non ha classe').toBeNull()
    expect(await invarianti(), 'nessun allarme dal 01/09').toEqual([])
  })
})

describe('NB4 · l’invariante 15-bis vede una scheda archiviata con una classe', () => {
  prova('un archiviato con la classe accende la 15-bis (e non c’è quando nessuno lo è)', async () => {
    expect((await invarianti()).filter((x) => x.startsWith('15-bis')), 'prima: la 15-bis è a zero').toEqual([])
    await b.db.query(`UPDATE public.alunni SET archiviato_il = now(), stato = 'ritirato' WHERE id = $1`, [BAMBINI.continuaB])
    expect((await invarianti()).filter((x) => x.startsWith('15-bis'))).toEqual(['15-bis:alunni (archiviata con una classe)=1'])
  })
})

describe('NB3 · una domanda per l’anno nuovo IMPORTATA nella finestra fa quello che fa il POST', () => {
  const DOMANDA = 'd1d1d1d1-0000-4000-8000-0000000000a1'
  const dati = (nome: string, extra: Record<string, unknown> = {}) => ({
    children: [{ nome, cognome: 'ProvaImport', data_nascita: '2024-03-05', ...extra }],
    adults: [{ first_name: 'Genitore', last_name: 'Prova', email: 'genitore@example.test', ruolo: 'madre' }],
  })
  const importa = async (nome: string, classe: string, extra: Record<string, unknown> = {}) => {
    await b.db.exec(`CREATE TABLE IF NOT EXISTS public.enrollment_submissions (id uuid PRIMARY KEY, scuola_id uuid, anno_id uuid, consents_log jsonb)`)
    await b.db.exec(`CREATE TABLE IF NOT EXISTS public.parents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`)
    for (const c of ['auth_user_id uuid', 'first_name text', 'last_name text', 'gender text', 'birth_date date', 'citizenship text', 'birth_nation text', 'birth_city text',
      'birth_province text', 'codice_belfiore_nascita text', 'fiscal_code text', 'residence_address text', 'residence_street_number text', 'residence_city text',
      'residence_province text', 'zip_code text', 'phone_numbers jsonb', 'emails jsonb']) await b.db.exec(`ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS ${c}`)
    await b.db.exec(`CREATE TABLE IF NOT EXISTS public.student_parents (student_id uuid, parent_id uuid, PRIMARY KEY (student_id, parent_id))`)
    await b.db.exec(`ALTER TABLE public.student_parents ADD COLUMN IF NOT EXISTS is_primary boolean`)
    await b.db.query(`INSERT INTO public.enrollment_submissions (id, scuola_id, anno_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET anno_id = excluded.anno_id`, [DOMANDA, SEDE_E2E, b.annoA])
    const esito = await eseguiDomanda(
      clienteProvaRoute(b.db) as never,
      { id: DOMANDA, scuolaId: SEDE_E2E, creataIl: '2027-08-20T09:00:00Z', bambini: [], adulti: [] } as never,
      dati(nome, extra) as never,
      [{ indice: 0, nome, cognome: 'ProvaImport', classe, retta: 150, aCaricoDi: null }] as never,
      SEDE_E2E,
    )
    const id = (await rows<C>(`SELECT id FROM public.alunni WHERE nome=$1 AND cognome='ProvaImport'`, [nome]))[0]?.id as string | undefined
    return { esito, id }
  }

  for (const [titolo, classe, atteso] of [
    ['O1 · «Girasoli» (c’è in tutti e due gli anni)', 'Girasoli', 'girasoliNuova'],
    ['O2 · «Prima A» (c’è solo nell’anno nuovo)', 'Prima A', 'primaria'],
  ] as const) {
    prova(`${titolo}: importata il 20/08, il 01/09 il bambino è nella classe nuova, con la sua frequenza`, async () => {
      await oggiE('2027-08-20')
      const { esito, id } = await importa('Bimbo', classe)
      expect(esito.esito, `import: ${String(esito.errore)}`).toBe('inviata')
      expect(id, 'la scheda è nata').toBeTruthy()
      expect(await scheda(id as string), 'il 20/08 «in arrivo», senza classe sulla scheda').toBe('in_arrivo/-')
      const f = await frequenza(id as string, 'nuovo')
      expect(f?.section_id, 'la frequenza è nell’anno nuovo, nella classe scelta').toBe(b.sezioni[atteso])
      expect(f?.ing, 'con ingresso all’inizio dell’anno').toBe(b.inizio)
      expect(await frequenza(id as string, 'vecchio'), 'e nessuna frequenza nell’anno vecchio').toBeUndefined()
      await oggiE(b.inizio)
      await ricopia(b.inizio)
      expect(await scheda(id as string), 'il 01/09 iscritto nella classe nuova').toBe(`iscritto/${atteso}`)
      expect(await invarianti(), 'invarianti il 01/09').toEqual([])
    })
  }

  prova('un bambino GIÀ in anagrafica (stesso codice fiscale) importato nella finestra non cambia classe oggi e il 01/09 è dov’era', async () => {
    await b.db.query(`UPDATE public.alunni SET codice_fiscale = 'PRVBMB24C45Z999X' WHERE id = $1`, [BAMBINI.continuaB])
    const prima = await sintesi(BAMBINI.continuaB)
    await oggiE('2027-08-20')
    const { esito } = await importa('Esistente', 'Farfalle', { codice_fiscale: 'PRVBMB24C45Z999X' })
    expect(esito.esito, `import: ${String(esito.errore)}`).toBe('inviata')
    expect(await sintesi(BAMBINI.continuaB), 'il 20/08 la scheda e la frequenza nuova sono quelle di prima').toBe(prima)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    expect(await scheda(BAMBINI.continuaB), 'il 01/09 nella classe nuova').toBe('iscritto/farfalleNuova')
    expect(await invarianti(), 'invarianti il 01/09').toEqual([])
  })

  prova('H6 · INSERT diretto «iscritto» con «Girasoli» il 20/08 (il trigger risolve sull’anno attivo, come il POST): il 01/09 è in classe e le invarianti sono a zero', async () => {
    await oggiE('2027-08-20')
    const y = '11111111-1111-4111-8111-111111111198'
    await b.db.query(`INSERT INTO public.alunni (id, scuola_id, stato, classe_sezione) VALUES ($1, $2, 'iscritto', 'Girasoli')`, [y, SEDE_E2E])
    NOME[y] = 'creatoInAgosto'
    expect(await scheda(y), 'il 20/08 «in arrivo» senza classe').toBe('in_arrivo/-')
    expect((await frequenza(y, 'nuovo'))?.section_id, 'frequenza nuova nella classe nuova').toBe(b.sezioni.girasoliNuova)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    expect(await scheda(y), 'il 01/09 nella classe nuova').toBe('iscritto/girasoliNuova')
    expect(await invarianti(), 'invarianti il 01/09').toEqual([])
  })

  prova('il bambino del centro estivo (classe che esiste solo nell’anno vecchio) resta come oggi: nell’anno vecchio', async () => {
    await oggiE('2027-08-20')
    const y = '11111111-1111-4111-8111-111111111197'
    await b.db.query(`INSERT INTO public.alunni (id, scuola_id, stato, classe_sezione) VALUES ($1, $2, 'iscritto', 'Stelline')`, [y, SEDE_E2E])
    NOME[y] = 'centroEstivo'
    expect(await scheda(y), 'iscritto nella classe vecchia').toBe('iscritto/stelline')
    expect((await frequenza(y, 'vecchio'))?.section_id, 'frequenza dell’anno vecchio').toBe(b.sezioni.stelline)
  })
})

describe('NS12 · la retta salvata in agosto per chi NON ha la frequenza dell’anno visibile non si perde il 01/09', () => {
  const retta = async (id: string) => (await rows<C>(
    `SELECT a.importo_retta_mensile::text scheda, (SELECT f.retta_mensile::text FROM public.frequenze f WHERE f.alunno_id=a.id AND f.anno_sede_id=$2) nuova,
            (SELECT f.giorno_scadenza_pagamenti FROM public.frequenze f WHERE f.alunno_id=a.id AND f.anno_sede_id=$2) giorno
       FROM public.alunni a WHERE a.id=$1`, [id, b.a]))[0]

  prova('M1 · «nuova» (solo frequenza nuova): PATCH del 10/08 con retta 321 e giorno 12: 200, e il 01/09 la retta è 321', async () => {
    await oggiE('2027-08-10')
    const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [BAMBINI.nuova]))[0].j as C
    expect(await frequenza(BAMBINI.nuova, 'vecchio'), 'premessa: non ha la frequenza dell’anno visibile').toBeUndefined()
    const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', { ...form, id: BAMBINI.nuova, importo_retta_mensile: 321, giorno_scadenza_pagamenti: 12 })
    expect(r.stato, `PATCH: ${String(r.errore)}`).toBe(200)
    expect((await retta(BAMBINI.nuova)).nuova, 'la retta è sulla frequenza dell’anno nuovo').toBe('321.00')
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    const dopo = await retta(BAMBINI.nuova)
    expect(dopo.scheda, 'il 01/09 la scheda ha la retta salvata ad agosto').toBe('321.00')
    expect(dopo.nuova).toBe('321.00')
    expect(dopo.giorno, 'e il giorno di scadenza').toBe(12)
  })

  prova('M1c · nato col POST il 20/08: PATCH con retta 333, il 01/09 la retta è 333', async () => {
    await oggiE('2027-08-20')
    const nato = await rotta(STUDENTI_POST, 'POST', '/api/admin/students', { nome: 'Prova', cognome: 'Nato', data_nascita: '2024-03-03', classe_sezione: 'Girasoli', gender: 'M' })
    expect(nato.stato, `POST: ${String(nato.errore)}`).toBe(201)
    const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [nato.id]))[0].j as C
    const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', { ...form, id: nato.id, importo_retta_mensile: 333 })
    expect(r.stato, `PATCH: ${String(r.errore)}`).toBe(200)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    const dopo = await retta(nato.id as string)
    expect(dopo.scheda, 'il 01/09 la scheda ha 333').toBe('333.00')
    expect(dopo.nuova).toBe('333.00')
  })

  prova('controllo · chi ha la frequenza dell’anno visibile («continuaB»): la retta di agosto va ancora sull’anno visibile, non sul nuovo', async () => {
    await oggiE('2027-08-10')
    const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [BAMBINI.continuaB]))[0].j as C
    const prima = (await retta(BAMBINI.continuaB)).nuova
    const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', { ...form, id: BAMBINI.continuaB, importo_retta_mensile: 444 })
    expect(r.stato, `PATCH: ${String(r.errore)}`).toBe(200)
    expect((await retta(BAMBINI.continuaB)).nuova, 'la frequenza nuova non cambia').toBe(prima)
    expect((await frequenza(BAMBINI.continuaB, 'vecchio'))?.retta, 'la vecchia sì').toBe('444.00')
  })
})
