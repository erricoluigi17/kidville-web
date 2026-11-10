// PR 4.8, CHIUSURA · N1 (il bambino già in anagrafica che il passaggio non conosce entra nella classe nuova il 01/09), N5 (il PATCH che ripiega
// in silenzio lo dice), «Riattiva» nella finestra. Stesso banco e stesse regole del giro 4: route vere, ogni prova in BEGIN/ROLLBACK.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest } from 'next/server'
import { BAMBINI, SEDE_E2E, UTENTE, creaBancoPassaggio, type BancoPassaggio, type NomeBambino } from '../helpers/passaggio-banco'

const h = vi.hoisted(() => ({ db: null as unknown, utente: '' as string, sedi: [] as string[], log: [] as unknown[], rompiLettura: false, rompiRpc: '' as string }))
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
  // (N5) Con `h.rompiLettura` la lettura «ha una frequenza nell'anno visibile?» (frequenze · select('id') · limit) risponde con un errore.
  const avvolgi = (q: object, rompe: boolean): object => new Proxy(q, {
    get(t, prop) {
      if (prop === 'then' && rompe && h.rompiLettura) return (ok: (r: unknown) => unknown) => ok({ data: null, error: { message: 'lettura finta fallita', code: 'XX000' } })
      const v = (t as Record<string | symbol, unknown>)[prop]
      if (typeof v !== 'function') return v
      return (...a: unknown[]) => {
        const r = v.apply(t, a)
        return r && typeof r === 'object' ? avvolgi(r, rompe || prop === 'limit') : r
      }
    },
  })
  return {
    ...(await orig<typeof import('@/lib/supabase/server-client')>()),
    createAdminClient: async () => {
      const c = clienteProvaRoute(h.db as PGlite) as unknown as { from: (t: string) => object }
      return new Proxy(c, { get: (t, prop) => (prop === 'rpc' ? (nome: string, args: unknown) => (h.rompiRpc === nome ? Promise.resolve({ data: null, error: { code: 'XX000', message: 'guasto finto' } }) : (t as unknown as { rpc: (n: string, a: unknown) => unknown }).rpc(nome, args)) : prop === 'from' ? (tab: string) => (tab === 'frequenze' ? avvolgi(t.from(tab), false) : t.from(tab)) : (t as unknown as Record<string | symbol, unknown>)[prop]) })
    },
  }
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
vi.mock('@/lib/auth/parent-identity', async (orig) => ({
  ...(await orig<object>()), findAuthUserIdByEmail: async () => null, ensureParentIdentity: async () => ({ ok: false, reason: 'finto' }),
}))
vi.mock('@/lib/email/send', async (orig) => ({ ...(await orig<object>()), sendEmailDetailed: async () => ({ ok: true }) }))
vi.mock('@/lib/notifiche/triggers', async (orig) => ({ ...(await orig<object>()), notificaEvento: async () => undefined }))
vi.mock('@/lib/crm/collegamento', async (orig) => ({ ...(await orig<object>()), segnalaDomandaRespinta: async () => undefined }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: async () => undefined }))
vi.mock('@/lib/audit/scrittura', async (orig) => ({ ...(await orig<object>()), logScrittura: async () => undefined }))

import { POST as ANTEPRIMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/route'
import { PUT as RIGHE } from '@/app/api/admin/anni/[annoSedeId]/passaggio/righe/route'
import { POST as CONFERMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma/route'
import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { PATCH as STUDENTI_PATCH } from '@/app/api/admin/students/route'
import { POST as RIATTIVA } from '@/app/api/admin/students/riattiva/route'
import { POST as TARDIVA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma-tardiva/route'
import { PATCH as ISCRIZIONI_PATCH } from '@/app/api/admin/iscrizioni/route'
import { GET as DIARIO } from '@/app/api/diary/students/route'
import { eseguiDomanda } from '@/lib/iscrizioni/import/esegui'
import { clienteProvaRoute } from '../helpers/cliente-passaggio-pglite'

let b: BancoPassaggio
type C = Record<string, unknown>
const GEN = '77777777-7777-4777-8777-7777777777d2'
const GEN_N = '77777777-7777-4777-8777-7777777777d3'
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
    'giorno_scadenza_pagamenti integer', 'consenso_privacy boolean', 'documento_path text',
    'consenso_foto_galleria boolean', 'consenso_foto_sito boolean', 'consenso_foto_social boolean']) {
    await b.db.exec(`ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS ${c}`)
  }
  await b.db.exec(`ALTER TABLE public.utenti ADD COLUMN IF NOT EXISTS scuola_id uuid, ADD COLUMN IF NOT EXISTS attivo boolean DEFAULT true, ADD COLUMN IF NOT EXISTS email text`)
  await b.db.exec(`CREATE TABLE IF NOT EXISTS public.enrollment_submissions (id uuid PRIMARY KEY, scuola_id uuid, anno_id uuid, consents_log jsonb, data jsonb, status text DEFAULT 'pending', created_at timestamptz DEFAULT now(), updated_at timestamptz)`)
  await b.db.exec(`CREATE TABLE IF NOT EXISTS public.parents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`)
  for (const c of ['auth_user_id uuid', 'first_name text', 'last_name text', 'gender text', 'birth_date date', 'citizenship text', 'birth_nation text', 'birth_city text',
    'birth_province text', 'codice_belfiore_nascita text', 'fiscal_code text', 'residence_address text', 'residence_street_number text', 'residence_city text',
    'residence_province text', 'zip_code text', 'phone_numbers jsonb', 'emails jsonb', 'scuola_id uuid', 'documento_path text', 'phone text', 'email text', 'ruolo text']) {
    await b.db.exec(`ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS ${c}`)
  }
  await b.db.exec(`CREATE TABLE IF NOT EXISTS public.student_parents (student_id uuid, parent_id uuid, PRIMARY KEY (student_id, parent_id))`)
  await b.db.exec(`ALTER TABLE public.student_parents ADD COLUMN IF NOT EXISTS is_primary boolean, ADD COLUMN IF NOT EXISTS ruolo text, ADD COLUMN IF NOT EXISTS relation_type text`)
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


// ---------------------------------------------------------------------------------------------------------------------------------
// N1 · un bambino GIÀ in anagrafica, che il passaggio non conosce (nato nella finestra in una classe del solo anno vecchio: il centro
// estivo), riceve una domanda per l'anno nuovo importata nella finestra. L'import non tocca la scheda di un `iscritto`: la frequenza
// nuova c'è, la scheda no. La ricopia del 01/09 deve portarlo nella classe nuova, perché il diario e l'appello leggono `alunni.section_id`.
// ---------------------------------------------------------------------------------------------------------------------------------
describe('N1 · il bambino già in anagrafica e sconosciuto al passaggio, con una domanda importata nella finestra', () => {
  let nDomanda = 0
  const centroEstivo = async (nome: string, cf: string, classe = 'Stelline') => {
    await oggiE('2027-08-10')
    const id = crypto.randomUUID()
    await b.db.query(
      `INSERT INTO public.alunni (id, scuola_id, stato, classe_sezione, nome, cognome, data_nascita, codice_fiscale) VALUES ($1,$2,'iscritto',$3,$4,'ProvaR','2024-03-05',$5)`,
      [id, SEDE_E2E, classe, nome, cf])
    NOME[id] = nome
    return id
  }
  const domanda = async (nome: string, cf: string) => {
    nDomanda++
    const id = `d2d2d2d2-0000-4000-8000-0000000000${String(nDomanda).padStart(2, '0')}`
    const dati = {
      children: [{ nome, cognome: 'ProvaR', data_nascita: '2024-03-05', codice_fiscale: cf }],
      adults: [{ first_name: 'Genitore', last_name: 'ProvaR', email: 'genitore@example.test', ruolo: 'madre' }],
    }
    await b.db.query(`INSERT INTO public.enrollment_submissions (id, scuola_id, anno_id, data, status, created_at) VALUES ($1,$2,$3,$4,'pending','2027-08-19T09:00:00Z')`,
      [id, SEDE_E2E, b.annoA, JSON.stringify(dati)])
    return { id, dati }
  }
  const viaEseguiDomanda = async (nome: string, cf: string) => {
    const d = await domanda(nome, cf)
    const esito = await eseguiDomanda(clienteProvaRoute(b.db) as never,
      { id: d.id, scuolaId: SEDE_E2E, creataIl: '2027-08-19T09:00:00Z', bambini: [], adulti: [] } as never, d.dati as never,
      [{ indice: 0, nome, cognome: 'ProvaR', classe: 'Girasoli', retta: 150, aCaricoDi: null }] as never, SEDE_E2E)
    expect(esito.esito, `import: ${String(esito.errore)}`).toBe('inviata')
  }
  const viaRoute = async (nome: string, cf: string) => {
    const d = await domanda(nome, cf)
    const r = await rotta(ISCRIZIONI_PATCH, 'PATCH', '/api/admin/iscrizioni',
      { id: d.id, action: 'import', assignments: { 0: 'Girasoli' }, referenteIndex: 0, rette: { 0: 180 } })
    expect(r.stato, `PATCH import: ${String(r.errore)}`).toBe(200)
  }

  for (const [sigla, via] of [['R5 · eseguiDomanda', viaEseguiDomanda], ['R2 · PATCH /api/admin/iscrizioni', viaRoute]] as const) {
    prova(`${sigla}: centro estivo del 10/08 + domanda «Girasoli» del 20/08: il 02/09 la scheda è in girasoliNuova, il diario lo elenca lì e non in stelline`, async () => {
      const id = await centroEstivo('Estivo', sigla.startsWith('R5') ? 'PRVSTM24C05Z999C' : 'PRVSTV24C05Z999A')
      await oggiE('2027-08-20')
      await via('Estivo', sigla.startsWith('R5') ? 'PRVSTM24C05Z999C' : 'PRVSTV24C05Z999A')
      expect(await scheda(id), 'il 20/08 la scheda è nell\'anno vecchio').toBe('iscritto/stelline')
      expect((await frequenza(id, 'nuovo'))?.section_id, 'e la frequenza nuova è in girasoliNuova').toBe(b.sezioni.girasoliNuova)
      await oggiE(b.inizio)
      await ricopia(b.inizio)
      await oggiE('2027-09-02')
      expect(await scheda(id), 'il 02/09 la scheda è in girasoliNuova').toBe('iscritto/girasoliNuova')
      expect(await diario(b.sezioni.girasoliNuova, '2027-09-02'), 'il diario della classe nuova lo elenca').toContain('Estivo')
      expect(await diario(b.sezioni.stelline, '2027-09-02'), 'quello della classe vecchia no').not.toContain('Estivo')
      expect(await invarianti(), 'invarianti il 02/09').toEqual([])
    })
  }

  prova('la condizione nuova NON tocca: il centro estivo SENZA domanda (resta nell\'anno vecchio, decide la segreteria), un archiviato, un bambino del passaggio', async () => {
    const senza = await centroEstivo('SenzaDomanda', 'PRVSNZ24C05Z999E')
    const archiviato = await centroEstivo('Archiviato', 'PRVARC24C05Z999F')
    await oggiE('2027-08-20')
    const r = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: archiviato })
    expect(r.stato, `archivia: ${String(r.errore)}`).toBe(200)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-02')
    expect(await scheda(senza), 'senza domanda: resta com\'è (11-bis, decide la segreteria)').toBe('iscritto/stelline')
    expect((await rows<C>(`SELECT section_id, archiviato_il IS NOT NULL arch FROM public.alunni WHERE id=$1`, [archiviato]))[0], 'archiviato: nessuna classe, ancora archiviato')
      .toEqual({ section_id: null, arch: true })
    expect(await scheda(BAMBINI.continuaB), 'il bambino del passaggio fa quello che faceva').toBe('iscritto/farfalleNuova')
    expect(await invarianti(), 'il centro estivo senza domanda resta segnalato').toEqual(['11:alunni (senza frequenza)=1'])
  })
})

// «Riattiva» nella finestra · CASO 1. La route scriveva contro `annoAttivoDiSede`, che nella finestra è l'anno NUOVO: la frequenza dell'anno
// che si vede restava `ritirato` (la famiglia non vedeva il bambino fino al 01/09, la 11 suonava). Decisione del titolare (10/11, «Correggi»):
// nella finestra «Riattiva» riapre le frequenze che l'archiviazione ha chiuso, quella che si vede e, se c'era, quella nuova. Era rosso prima.
describe('Riattiva nella finestra · archiviato il 10/08, riattivato il 20/08, passaggio il 01/09', () => {
  const stato = async (id: string) => `${await scheda(id)} · vecchio:${(await frequenza(id, 'vecchio'))?.stato ?? 'nessuna'} · nuovo:${(await frequenza(id, 'nuovo'))?.stato ?? 'nessuna'}`
  it('continuaB: il 20/08 la frequenza dell\'anno che si vede è di nuovo viva e nessun invariante suona; il 02/09 è in farfalleNuova', async () => {
    await b.db.exec('BEGIN')
    h.db = b.db; h.utente = UTENTE; h.sedi = [SEDE_E2E]; h.log.length = 0
    try {
      await oggiE(b.oggi); await prepara()
      await oggiE('2027-08-10')
      const a = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.continuaB })
      expect.soft(a.stato, `archivia: ${String(a.errore)}`).toBe(200)
      await oggiE('2027-08-20')
      const r = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI.continuaB })
      expect.soft(r.stato, `riattiva: ${String(r.errore)}`).toBe(200)
      expect.soft(await scheda(BAMBINI.continuaB), 'il 20/08 la scheda è iscritto nella classe che si vede').toBe('iscritto/farfalle')
      expect.soft((await frequenza(BAMBINI.continuaB, 'nuovo'))?.stato, 'la frequenza nuova è di nuovo viva').toBe('in_attesa')
      expect.soft((await frequenza(BAMBINI.continuaB, 'vecchio'))?.stato, `la frequenza dell'anno che si vede è di nuovo viva (${await stato(BAMBINI.continuaB)})`).not.toBe('ritirato')
      expect.soft(await figliAttivi(GEN), 'la famiglia lo vede il 20/08').toContain('continuaB')
      expect.soft(await diario(b.sezioni.farfalle, '2027-08-20'), 'il diario della sua classe lo elenca').toContain('continuaB')
      expect.soft(await invarianti(), 'invarianti il 20/08').toEqual([])
      await oggiE(b.inizio)
      await ricopia(b.inizio)
      await oggiE('2027-09-02')
      expect.soft(await scheda(BAMBINI.continuaB), 'il 02/09 in farfalleNuova').toBe('iscritto/farfalleNuova')
      expect.soft(await diario(b.sezioni.farfalleNuova, '2027-09-02'), 'il diario della classe nuova lo elenca').toContain('continuaB')
      expect.soft(await diario(b.sezioni.farfalle, '2027-09-02'), 'quello della vecchia no').not.toContain('continuaB')
      expect.soft(await invarianti(), 'invarianti il 02/09').toEqual([])
    } finally { await b.db.exec('ROLLBACK') }
  }, 180_000)
})

// N5 · se la lettura «ha una frequenza nell'anno visibile?» dà errore, il PATCH ripiega sul visibile (come prima di NS12) ma lo DICE.
describe('N5 · il PATCH che ripiega sull’anno visibile lo scrive nel log', () => {
  prova('lettura rotta: 200 lo stesso e un evento «anagrafica» di livello warn con la ragione; lettura sana: nessun avviso', async () => {
    await oggiE('2027-08-10')
    const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [BAMBINI.nuova]))[0].j as C
    const corpo = { ...form, id: BAMBINI.nuova, importo_retta_mensile: 321 }
    h.log.length = 0
    expect((await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', corpo)).stato).toBe(200)
    expect(h.log.filter((x) => JSON.stringify(x).includes('lettura-frequenza-visibile-fallita')), 'lettura sana: nessun avviso').toEqual([])
    h.rompiLettura = true
    try {
      h.log.length = 0
      const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', corpo)
      expect(r.stato, `PATCH con la lettura rotta: ${String(r.errore)}`).toBe(200)
    } finally { h.rompiLettura = false }
    const avvisi = h.log.filter((x) => JSON.stringify(x).includes('lettura-frequenza-visibile-fallita'))
    expect(avvisi, 'un avviso').toHaveLength(1)
    expect((avvisi[0] as unknown[]).slice(0, 3), 'è un evento «anagrafica» di livello warn').toEqual(['evento', 'anagrafica', 'warn'])
  })
})

// «Riattiva» nella finestra · CASO 2: archiviato PRIMA della conferma (luglio, il centro estivo che il passaggio non conosce), riattivato il 20/08.
// La frequenza dell'anno che si vede si riapre; nell'anno nuovo NON se ne inventa nessuna (decide la segreteria, come per il centro estivo).
describe('Riattiva nella finestra · caso 2: archiviato in luglio (prima della conferma), riattivato il 20/08', () => {
  prova('si riapre la frequenza che si vede, nessuna ne nasce nell\'anno nuovo; il 20/08 la famiglia lo vede; il 02/09 la 11 lo segnala', async () => {
    await b.db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1,$2)`, [GEN_N, BAMBINI.ritiratoArchiviato])
    await oggiE('2027-08-20')
    expect(await scheda(BAMBINI.ritiratoArchiviato), 'prima: archiviato').toBe('ritirato/-/ARCHIVIATO')
    expect(await figliAttivi(GEN_N), 'prima: la famiglia non lo vede').not.toContain('ritiratoArchiviato')
    h.log.length = 0
    const r = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI.ritiratoArchiviato })
    expect(r.stato, `riattiva: ${String(r.errore)}`).toBe(200)
    expect(await scheda(BAMBINI.ritiratoArchiviato)).toBe('iscritto/girasoli')
    expect((await frequenza(BAMBINI.ritiratoArchiviato, 'vecchio'))?.stato, 'la frequenza che si vede è viva').toBe('iscritto')
    expect(await frequenza(BAMBINI.ritiratoArchiviato, 'nuovo'), 'nell\'anno nuovo non si inventa niente').toBeUndefined()
    expect(await figliAttivi(GEN_N), 'il 20/08 la famiglia lo vede').toContain('ritiratoArchiviato')
    expect(await diario(b.sezioni.girasoli, '2027-08-20'), 'il diario della sua classe lo elenca').toContain('ritiratoArchiviato')
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    expect(h.log.filter((x) => JSON.stringify(x).includes('riattiva-finestra-frequenza-nuova-riaperta')), 'nessuna frequenza nuova riaperta: nessun evento').toEqual([])
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-02')
    // Come il centro estivo senza domanda: resta nella classe dell'anno vecchio e la 11 lo segnala, finché la segreteria non gli dà l'iscrizione nuova.
    expect(await scheda(BAMBINI.ritiratoArchiviato), 'il 02/09 la scheda è dov\'era').toBe('iscritto/girasoli')
    expect(await invarianti(), 'il 02/09 la 11 lo segnala').toEqual(['11:alunni (senza frequenza)=1'])
  })
})

// CASO 3: uscito col passaggio (`no`, `nonRisposto`: la frequenza vecchia è `uscito`, la scheda archiviata). Non è un'archiviazione da disfare:
// la via giusta è la «Conferma tardiva» del passaggio. Ruling: resta il 409 che c'era (la frase rimanda già alla «Conferma tardiva»), perché
// lo stato che lascia è coerente: scheda e frequenze intatte, invarianti vuoti il 20/08 e il 02/09, nessun dato visibile a chi non deve vederlo.
describe('Riattiva nella finestra · caso 3: uscito col passaggio, «Riattiva» il 20/08', () => {
  for (const k of ['no', 'nonRisposto'] as const) {
    prova(`${k}: 409 che rimanda alla Conferma tardiva, niente cambia, nessun invariante il 20/08 e il 02/09`, async () => {
      const prima = await scheda(BAMBINI[k])
      expect(prima).toBe('ritirato/-/ARCHIVIATO')
      expect((await frequenza(BAMBINI[k], 'vecchio'))?.stato).toBe('uscito')
      await oggiE('2027-08-20')
      h.log.length = 0
      const r = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI[k] })
      expect(r.stato, `riattiva: ${String(r.errore)}`).toBe(409)
      expect(String(r.errore), 'la frase rimanda alla Conferma tardiva').toContain('Conferma tardiva')
      expect(h.log.some((x) => JSON.stringify(x).includes('riattiva-senza-iscrizione')), 'il rifiuto si logga').toBe(true)
      expect(await scheda(BAMBINI[k]), 'la scheda è com\'era').toBe(prima)
      expect((await frequenza(BAMBINI[k], 'vecchio'))?.stato, 'la frequenza vecchia è com\'era').toBe('uscito')
      expect(await frequenza(BAMBINI[k], 'nuovo'), 'nessuna frequenza nuova').toBeUndefined()
      expect(await invarianti(), 'invarianti il 20/08').toEqual([])
      await oggiE(b.inizio)
      await ricopia(b.inizio)
      await oggiE('2027-09-02')
      expect(await scheda(BAMBINI[k]), 'il 02/09 la scheda è com\'era').toBe(prima)
      expect(await invarianti(), 'invarianti il 02/09').toEqual([])
    })
  }
})

// Il cambio di grado: la classe nuova ha un nome diverso dalla vecchia, e la classe che il passaggio aveva dato non si legge da «Riattiva»
// (la tabella `passaggi_anno_righe` si legge solo dalla porta del passaggio, lock `passaggio-lock`). Le due frequenze tornano vive, la scheda e la
// frequenza nuova restano SENZA classe: la assegna la segreteria. Prima della correzione la stessa strada lasciava la frequenza che si vede `ritirato`
// e la `11` accesa fino al 01/09; la mancanza di classe era già così. È un limite noto, non una regressione.
describe('Riattiva nella finestra · cambio di grado: tornano vive le due frequenze, la classe nuova la dà la segreteria', () => {
  prova('cambiaGradoConSezione: archiviato il 10/08, riattivato il 20/08', async () => {
    const nuova = async () => (await frequenza(BAMBINI.cambiaGradoConSezione, 'nuovo'))
    expect((await nuova())?.stato, 'dopo la conferma: iscrizione nuova in attesa').toBe('in_attesa')
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.cambiaGradoConSezione })).stato).toBe(200)
    expect((await nuova())?.stato, 'archiviato: anche la nuova è chiusa').toBe('ritirato')
    await oggiE('2027-08-20')
    const r = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI.cambiaGradoConSezione })
    expect(r.stato, `riattiva: ${String(r.errore)}`).toBe(200)
    expect((await frequenza(BAMBINI.cambiaGradoConSezione, 'vecchio'))?.stato, 'la frequenza che si vede è viva').toBe('iscritto')
    expect((await nuova())?.stato, 'la frequenza nuova è di nuovo in attesa').toBe('in_attesa')
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-02')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// «Riattiva» nella finestra, SECONDO GIRO. La regola: «Riattiva» DISFA ESATTAMENTE l'archiviazione di quel giorno. Riapre solo le frequenze che
// lei ha chiuso (`ritirato` con la data d'uscita del suo giorno), con la classe che avevano, senza cercare nessuna classe per nome.
// Nota sul banco: `archivia` data l'uscita e `archiviato_il` con l'orologio VERO (`oggiRoma()`/`now()`), non con `giorno_roma` finto: per
// chi era uscito «mesi prima» la data d'uscita si porta indietro a mano.
// ---------------------------------------------------------------------------------------------------------------------------------
async function archiviaERiattiva(k: NomeBambino) {
  await oggiE('2027-08-10')
  const a = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI[k] })
  expect(a.stato, `archivia ${k}: ${String(a.errore)}`).toBe(200)
  await oggiE('2027-08-20')
  return rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI[k] })
}
async function finoAlDueSettembre() {
  await oggiE(b.inizio)
  await ricopia(b.inizio)
  await oggiE('2027-09-02')
}

describe('Riattiva nella finestra · B1 e O1: chi era uscito mesi prima e torna «in arrivo» torna in arrivo, la sua uscita non si cancella', () => {
  for (const k of ['ritornato', 'inArrivoConConferma'] as const) {
    prova(`${k}: archiviato il 10/08 e riattivato il 20/08 → in_arrivo, frequenza vecchia intatta, fuori da Girasoli, invarianti vuoti; il 02/09 nella classe nuova`, async () => {
      // L'uscita di quest'anno è di mesi prima dell'archiviazione di agosto.
      await b.db.query(`UPDATE public.frequenze f SET data_ingresso = lower(a.periodo), data_uscita = lower(a.periodo) + 5 FROM public.anni_sede a WHERE a.id = f.anno_sede_id AND f.alunno_id=$1 AND f.anno_sede_id=$2`, [BAMBINI[k], b.da])
      const prima = await frequenza(BAMBINI[k], 'vecchio')
      expect(prima?.stato).toBe('ritirato')
      const r = await archiviaERiattiva(k)
      expect(r.stato, `riattiva: ${String(r.errore)}`).toBe(200)
      const dopo = await frequenza(BAMBINI[k], 'vecchio')
      expect(dopo?.stato, 'la frequenza vecchia è com\'era').toBe('ritirato')
      expect(dopo?.usc, 'con la sua data d\'uscita').toBe(prima?.usc)
      expect(await scheda(BAMBINI[k]), 'torna in arrivo, senza classe').toBe('in_arrivo/-')
      expect(await diario(b.sezioni.girasoli, '2027-08-20'), 'il diario di Girasoli non lo elenca').not.toContain(k)
      const nuova = await frequenza(BAMBINI[k], 'nuovo')
      expect(nuova?.stato, 'la sua iscrizione nuova è viva').toBe('in_attesa')
      expect(nuova?.section_id, 'con la classe di prima').toBe(b.sezioni.girasoliNuova)
      expect(await invarianti(), 'invarianti il 20/08').toEqual([])
      await finoAlDueSettembre()
      expect(await scheda(BAMBINI[k]), 'il 02/09 nella classe nuova').toBe('iscritto/girasoliNuova')
      expect(await diario(b.sezioni.girasoliNuova, '2027-09-02')).toContain(k)
      expect(await invarianti(), 'invarianti il 02/09').toEqual([])
    })
  }
  prova('nuova (in arrivo dal passaggio): archiviata e riattivata torna in_arrivo con la sua frequenza nuova', async () => {
    const r = await archiviaERiattiva('nuova')
    expect(r.stato, String(r.errore)).toBe(200)
    expect(await scheda(BAMBINI.nuova)).toBe('in_arrivo/-')
    expect((await frequenza(BAMBINI.nuova, 'nuovo'))?.stato).toBe('in_attesa')
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    await finoAlDueSettembre()
    expect(await scheda(BAMBINI.nuova), 'il 02/09').toBe('iscritto/girasoliNuova')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
})

describe('Riattiva nella finestra · B2 e B3: la classe dell\'anno nuovo è quella di prima, mai una cercata per nome', () => {
  prova('B2 · continuaAltraSezione (confermato a mano in Girasoli\') torna in Girasoli\' il 02/09, nel suo diario e non in quello di Farfalle\'', async () => {
    const r = await archiviaERiattiva('continuaAltraSezione')
    expect(r.stato, String(r.errore)).toBe(200)
    expect(await scheda(BAMBINI.continuaAltraSezione), 'il 20/08 è nella classe che si vede').toBe('iscritto/farfalle')
    expect((await frequenza(BAMBINI.continuaAltraSezione, 'nuovo'))?.section_id, 'la frequenza nuova ha la classe di prima').toBe(b.sezioni.girasoliNuova)
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    await finoAlDueSettembre()
    expect(await scheda(BAMBINI.continuaAltraSezione), 'il 02/09').toBe('iscritto/girasoliNuova')
    expect(await diario(b.sezioni.girasoliNuova, '2027-09-02'), 'nel diario di Girasoli\'').toContain('continuaAltraSezione')
    expect(await diario(b.sezioni.farfalleNuova, '2027-09-02'), 'non in quello di Farfalle\'').not.toContain('continuaAltraSezione')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
  prova('B3 · cambiaGradoConSezione: due frequenze vive, il 02/09 è in Prima A e la maestra lo vede', async () => {
    const r = await archiviaERiattiva('cambiaGradoConSezione')
    expect(r.stato, String(r.errore)).toBe(200)
    expect(await scheda(BAMBINI.cambiaGradoConSezione), 'il 20/08 nella classe che si vede').toBe('iscritto/stelline')
    expect((await frequenza(BAMBINI.cambiaGradoConSezione, 'vecchio'))?.stato).toBe('iscritto')
    const nuova = await frequenza(BAMBINI.cambiaGradoConSezione, 'nuovo')
    expect(nuova?.stato).toBe('in_attesa')
    expect(nuova?.section_id, 'Prima A').toBe(b.sezioni.primaria)
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    expect(h.log.some((x) => JSON.stringify(x).includes('riattiva-finestra-frequenza-nuova-senza-classe')), 'nessun avviso: la classe c\'è').toBe(false)
    await finoAlDueSettembre()
    expect(await scheda(BAMBINI.cambiaGradoConSezione), 'il 02/09').toBe('iscritto/primaria')
    expect(await diario(b.sezioni.primaria, '2027-09-02'), 'la maestra di Prima A lo vede').toContain('cambiaGradoConSezione')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
  prova('NB4 non torna: la scheda archiviata nella finestra non ha classe, né il 20/08 né dopo la ricopia, anche se la frequenza nuova chiusa la tiene', async () => {
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.continuaAltraSezione })).stato).toBe(200)
    const chiusa = await frequenza(BAMBINI.continuaAltraSezione, 'nuovo')
    expect(chiusa?.stato).toBe('ritirato')
    expect(chiusa?.section_id, 'la frequenza chiusa tiene la sua classe').toBe(b.sezioni.girasoliNuova)
    await finoAlDueSettembre()
    const al = (await rows<C>(`SELECT section_id, classe_sezione FROM public.alunni WHERE id=$1`, [BAMBINI.continuaAltraSezione]))[0]
    expect(al.section_id, 'la scheda archiviata non ha classe').toBeNull()
    expect(al.classe_sezione ?? null).toBeNull()
    expect(await diario(b.sezioni.girasoliNuova, '2027-09-02'), 'il diario della classe nuova non lo elenca').not.toContain('continuaAltraSezione')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
})

describe('Riattiva nella finestra · O2: chi è entrato con la «Conferma tardiva»', () => {
  prova('nonRisposto: confermato in ritardo il 12/08, archiviato e riattivato nella finestra → il 02/09 in Farfalle\', nessun invariante', async () => {
    await oggiE('2027-08-12')
    const t = await chiama(TARDIVA, 'POST', '/conferma-tardiva', { alunno_id: BAMBINI.nonRisposto })
    expect(t.stato, String(t.corpo?.error)).toBe(200)
    const r = await archiviaERiattiva('nonRisposto')
    expect(r.stato, String(r.errore)).toBe(200)
    expect((await frequenza(BAMBINI.nonRisposto, 'nuovo'))?.stato, 'l\'iscrizione nuova è viva').toBe('in_attesa')
    expect((await frequenza(BAMBINI.nonRisposto, 'nuovo'))?.section_id).toBe(b.sezioni.farfalleNuova)
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
    await finoAlDueSettembre()
    expect(await scheda(BAMBINI.nonRisposto), 'il 02/09').toBe('iscritto/farfalleNuova')
    expect(await diario(b.sezioni.farfalleNuova, '2027-09-02')).toContain('nonRisposto')
    expect(await invarianti(), 'invarianti il 02/09').toEqual([])
  })
})

describe('Riattiva nella finestra · S1: un guasto nella lettura della finestra si ferma con un errore, senza scrivere', () => {
  prova('anno_visibile_oggi rotta: 500, la scheda resta archiviata, le frequenze come erano', async () => {
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.continuaB })).stato).toBe(200)
    await oggiE('2027-08-20')
    const prima = `${await scheda(BAMBINI.continuaB)} · ${(await frequenza(BAMBINI.continuaB, 'vecchio'))?.stato} · ${(await frequenza(BAMBINI.continuaB, 'nuovo'))?.stato}`
    h.rompiRpc = 'anno_visibile_oggi'
    try {
      const r = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI.continuaB })
      expect(r.stato, `riattiva con la lettura rotta: ${String(r.errore)}`).toBe(500)
    } finally { h.rompiRpc = '' }
    expect(`${await scheda(BAMBINI.continuaB)} · ${(await frequenza(BAMBINI.continuaB, 'vecchio'))?.stato} · ${(await frequenza(BAMBINI.continuaB, 'nuovo'))?.stato}`, 'niente è cambiato').toBe(prima)
    const r2 = await rotta(RIATTIVA, 'POST', '/api/admin/students/riattiva', { alunno_id: BAMBINI.continuaB })
    expect(r2.stato, 'la riprova a lettura sana completa il lavoro').toBe(200)
    expect(await invarianti()).toEqual([])
  })
})

describe('Riattiva nella finestra · S2/S3: la classe si verifica sull\'anno che si scrive', () => {
  prova('cambiaGradoConSezione (Stelline non ha continuazione nell\'anno nuovo): esito «ripristinata», non «sparita»', async () => {
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.cambiaGradoConSezione })).stato).toBe(200)
    await oggiE('2027-08-20')
    const req = new NextRequest('http://localhost/api/admin/students/riattiva', {
      method: 'POST', headers: { 'x-user-id': h.utente, 'content-type': 'application/json', 'user-agent': 'prova' }, body: JSON.stringify({ alunno_id: BAMBINI.cambiaGradoConSezione }),
    })
    const res = await RIATTIVA(req)
    const corpo = (await res.json()) as C
    expect(res.status).toBe(200)
    expect(corpo.esito_classe, 'la classe c\'è nell\'anno che si vede').toBe('ripristinata')
    expect(corpo.classe_sezione).toBe('Stelline')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// «Riattiva», TERZO GIRO. (h) dopo il 01/09 chi è stato archiviato nella finestra riapre con la classe che la sua frequenza aveva, non con una
// cercata per nome; S-n1 (il solo ritiro dalla tendina non riapre niente); S-n2 (l'uscita del passaggio resta un 409 anche con la conferma
// chiusa); S-n3 (il ramo «in arrivo» dà lo stesso segnale «senza classe» degli altri).
// ---------------------------------------------------------------------------------------------------------------------------------
async function riattivaCorpo(k: NomeBambino): Promise<{ stato: number; corpo: C }> {
  const req = new NextRequest('http://localhost/api/admin/students/riattiva', {
    method: 'POST', headers: { 'x-user-id': h.utente, 'content-type': 'application/json', 'user-agent': 'prova' }, body: JSON.stringify({ alunno_id: BAMBINI[k] }),
  })
  const res = await RIATTIVA(req)
  return { stato: res.status, corpo: ((await res.json().catch(() => null)) ?? {}) as C }
}

describe('Riattiva · (h) archiviato nella finestra e riattivato dopo il 01/09: la classe che la frequenza aveva, non una per nome', () => {
  for (const [k, scheda02, nuova] of [['continuaAltraSezione', 'iscritto/girasoliNuova', 'girasoliNuova'], ['cambiaGradoConSezione', 'iscritto/primaria', 'primaria']] as const) {
    prova(`${k}: archiviato il 20/08, ricopia il 01/09, riattivato il 10/09 → ${nuova}`, async () => {
      await oggiE('2027-08-20')
      expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI[k] })).stato).toBe(200)
      await finoAlDueSettembre()
      await oggiE('2027-09-10')
      const r = await riattivaCorpo(k)
      expect(r.stato, String(r.corpo.error)).toBe(200)
      expect(r.corpo.esito_classe, 'la classe è quella della frequenza: ripristinata, non «sparita»').toBe('ripristinata')
      expect(await scheda(BAMBINI[k]), 'la scheda è nella classe di prima').toBe(scheda02)
      expect(await diario(b.sezioni[nuova], '2027-09-10'), 'nel diario giusto').toContain(k)
      for (const altra of ['farfalleNuova', 'girasoliNuova', 'primaria'] as const) {
        if (altra !== nuova) expect(await diario(b.sezioni[altra], '2027-09-10'), `non nel diario di ${altra}`).not.toContain(k)
      }
      expect((await frequenza(BAMBINI[k], 'nuovo'))?.section_id, 'la frequenza tiene la sua classe').toBe(b.sezioni[nuova])
      expect(await invarianti(), 'invarianti').toEqual([])
    })
  }
  prova('archiviato e riattivato a ottobre, senza nessuna finestra di mezzo: la strada di sempre (il nome ricordato)', async () => {
    await finoAlDueSettembre()
    expect(await scheda(BAMBINI.continuaB)).toBe('iscritto/farfalleNuova')
    await oggiE('2027-10-05')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.continuaB })).stato).toBe(200)
    await oggiE('2027-10-10')
    const r = await riattivaCorpo('continuaB')
    expect(r.stato, String(r.corpo.error)).toBe(200)
    expect(r.corpo.esito_classe).toBe('ripristinata')
    expect(await scheda(BAMBINI.continuaB)).toBe('iscritto/farfalleNuova')
    expect(await diario(b.sezioni.farfalleNuova, '2027-10-10')).toContain('continuaB')
    expect(await invarianti()).toEqual([])
  })
})

describe('Riattiva nella finestra · S-n1: il solo ritiro dalla tendina (nessuna archiviazione) non riapre una frequenza chiusa mesi prima', () => {
  prova('ritornato: ritirato dalla tendina il 15/08, «Riattiva» il 20/08 → la sua uscita di mesi prima resta', async () => {
    await b.db.query(`UPDATE public.frequenze f SET data_ingresso = lower(a.periodo), data_uscita = lower(a.periodo) + 5 FROM public.anni_sede a WHERE a.id = f.anno_sede_id AND f.alunno_id=$1 AND f.anno_sede_id=$2`, [BAMBINI.ritornato, b.da])
    const prima = await frequenza(BAMBINI.ritornato, 'vecchio')
    await oggiE('2027-08-15')
    await b.db.query(`UPDATE public.alunni SET stato='ritirato' WHERE id=$1`, [BAMBINI.ritornato])
    await oggiE('2027-08-20')
    await riattivaCorpo('ritornato')
    const dopo = await frequenza(BAMBINI.ritornato, 'vecchio')
    expect(dopo?.stato, 'la frequenza vecchia resta chiusa').toBe('ritirato')
    expect(dopo?.usc, 'con la sua data d\'uscita').toBe(prima?.usc)
  })
})

describe('Riattiva nella finestra · S-n2: chi esce col passaggio ha il 409 anche se la sua conferma nuova risulta chiusa', () => {
  prova('cambiaGradoSenzaSezione («esce»): 409 che rimanda alla Conferma tardiva, niente cambia', async () => {
    await oggiE('2027-08-20')
    const f = await frequenza(BAMBINI.cambiaGradoSenzaSezione, 'nuovo')
    const prima = await scheda(BAMBINI.cambiaGradoSenzaSezione)
    expect(f?.stato, 'la conferma nuova è chiusa dal passaggio').toBe('ritirato')
    expect((await frequenza(BAMBINI.cambiaGradoSenzaSezione, 'vecchio'))?.stato).toBe('uscito')
    h.log.length = 0
    const r = await riattivaCorpo('cambiaGradoSenzaSezione')
    expect(r.stato, String(r.corpo.error)).toBe(409)
    expect(String(r.corpo.error)).toContain('Conferma tardiva')
    expect(h.log.some((x) => JSON.stringify(x).includes('riattiva-senza-iscrizione')), 'il rifiuto si logga').toBe(true)
    expect(await scheda(BAMBINI.cambiaGradoSenzaSezione), 'la scheda è com\'era').toBe(prima)
    expect((await frequenza(BAMBINI.cambiaGradoSenzaSezione, 'nuovo'))?.stato, 'la conferma resta chiusa').toBe('ritirato')
    expect(await invarianti(), 'invarianti il 20/08').toEqual([])
  })
})

describe('Riattiva nella finestra · S-n3: il ramo «in arrivo» dà lo stesso segnale «senza classe» degli altri', () => {
  prova('ritornato con la frequenza nuova senza classe: warn nel log e frase nella risposta', async () => {
    await b.db.query(`UPDATE public.frequenze f SET data_ingresso = lower(a.periodo), data_uscita = lower(a.periodo) + 5 FROM public.anni_sede a WHERE a.id = f.anno_sede_id AND f.alunno_id=$1 AND f.anno_sede_id=$2`, [BAMBINI.ritornato, b.da])
    await b.db.query(`UPDATE public.frequenze SET section_id = NULL WHERE alunno_id=$1 AND anno_sede_id=$2`, [BAMBINI.ritornato, b.a])
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.ritornato })).stato).toBe(200)
    await oggiE('2027-08-20')
    h.log.length = 0
    const r = await riattivaCorpo('ritornato')
    expect(r.stato, String(r.corpo.error)).toBe(200)
    expect(r.corpo.torna_in_arrivo).toBe(true)
    expect(typeof r.corpo.avviso_classe_nuova, 'la frase nella risposta').toBe('string')
    expect(h.log.some((x) => JSON.stringify(x).includes('riattiva-finestra-frequenza-nuova-senza-classe')), 'il warn nel log').toBe(true)
  })
  prova('controllo: con la classe al suo posto, nessun segnale', async () => {
    await b.db.query(`UPDATE public.frequenze f SET data_ingresso = lower(a.periodo), data_uscita = lower(a.periodo) + 5 FROM public.anni_sede a WHERE a.id = f.anno_sede_id AND f.alunno_id=$1 AND f.anno_sede_id=$2`, [BAMBINI.ritornato, b.da])
    await oggiE('2027-08-10')
    expect((await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.ritornato })).stato).toBe(200)
    await oggiE('2027-08-20')
    h.log.length = 0
    const r = await riattivaCorpo('ritornato')
    expect(r.stato).toBe(200)
    expect(r.corpo.avviso_classe_nuova).toBeUndefined()
    expect(h.log.some((x) => JSON.stringify(x).includes('frequenza-nuova-senza-classe'))).toBe(false)
  })
})
