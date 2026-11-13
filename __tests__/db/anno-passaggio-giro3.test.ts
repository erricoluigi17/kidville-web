// PR 4.8, GIRO DI CORREZIONE 3 · i quattro bloccanti della ri-revisione 2 provati con le ROUTE VERE nella finestra fra la conferma e l'inizio
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
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async () => h.sedi,
  assertAlunnoInScope: async () => null,
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE_E2E }),
}))
vi.mock('@/lib/audit/scrittura', async (orig) => ({ ...(await orig<object>()), logScrittura: async () => undefined }))

import { GET as LEGGI, POST as ANTEPRIMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/route'
import { PUT as RIGHE } from '@/app/api/admin/anni/[annoSedeId]/passaggio/righe/route'
import { POST as CONFERMA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma/route'
import { POST as ANNULLA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/annulla/route'
import { POST as TARDIVA } from '@/app/api/admin/anni/[annoSedeId]/passaggio/conferma-tardiva/route'
import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { PATCH as STUDENTI_PATCH, POST as STUDENTI_POST } from '@/app/api/admin/students/route'

let b: BancoPassaggio
type C = Record<string, unknown>
const GEN = '77777777-7777-4777-8777-7777777777c2'
const GEN_N = '77777777-7777-4777-8777-7777777777c3'
const FOTO_VECCHIA = '99999999-9999-4999-8999-9999999999c1'
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
    'giorno_scadenza_pagamenti integer']) {
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
const fotoVisibili = async (g: string) => (await rows<C>(`SELECT DISTINCT media_id FROM public.media_visibili_genitore($1)`, [g])).length

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

describe('NB1 · il form intero salvato in agosto (PATCH vera) non rompe e non sposta nessuno', () => {
  const CASI = ['continuaAltraSezione', 'nuova', 'ritornato', 'cambiaGradoConSezione'] as const

  /** Il risultato del 01/09 dei quattro casi: con il PATCH di agosto (`conPatch`) o senza. */
  async function giro(conPatch: boolean): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    await b.db.exec('BEGIN')
    h.db = b.db; h.utente = UTENTE; h.sedi = [SEDE_E2E]
    try {
      await oggiE(b.oggi); await prepara()
      await oggiE('2027-08-10')
      if (conPatch) {
        for (const k of CASI) {
          const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [BAMBINI[k]]))[0].j as C
          const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', { ...form, id: BAMBINI[k], note_mediche: 'nota di prova' })
          expect(r.stato, `PATCH del form intero di ${k} il 10/08: ${String(r.errore)}`).toBe(200)
          expect((await rows<C>(`SELECT note_mediche FROM public.alunni WHERE id=$1`, [BAMBINI[k]]))[0].note_mediche, `la nota di ${k} è salvata`).toBe('nota di prova')
        }
      }
      await oggiE(b.inizio)
      await ricopia(b.inizio)
      for (const k of CASI) out[k] = await sintesi(BAMBINI[k])
      expect(await invarianti(), 'invarianti il 01/09').toEqual([])
    } finally { await b.db.exec('ROLLBACK') }
    return out
  }

  it('10/08 col form intero + una nota medica: 200 per tutti e quattro, e il 01/09 ognuno è nella classe decisa dal passaggio', async () => {
    const atteso = await giro(false)
    const ottenuto = await giro(true)
    expect(ottenuto).toEqual(atteso)
  }, 300_000)

  prova('la retta cambiata il 10/08 vale per l’anno in corso e non per il nuovo; la frequenza nata dal passaggio non cambia classe', async () => {
    await oggiE('2027-08-10')
    const prima = await frequenza(BAMBINI.continua, 'nuovo')
    const form = (await rows<C>(`SELECT to_jsonb(a) j FROM public.alunni a WHERE id=$1`, [BAMBINI.continua]))[0].j as C
    const r = await rotta(STUDENTI_PATCH, 'PATCH', '/api/admin/students', { ...form, id: BAMBINI.continua, importo_retta_mensile: 321 })
    expect(r.stato, String(r.errore)).toBe(200)
    expect(Number((await frequenza(BAMBINI.continua, 'vecchio')).retta), 'la retta è dell’anno visibile').toBe(321)
    const dopo = await frequenza(BAMBINI.continua, 'nuovo')
    expect(dopo.retta, 'la frequenza nuova non cambia retta').toBe(prima.retta)
    expect(dopo.section_id, 'né classe').toBe(prima.section_id)
  })
})

describe('NB2 · l’archiviazione chiude TUTTE le iscrizioni vive del bambino, e la famiglia perde l’accesso lo stesso giorno', () => {
  const famiglia = async (g: string) => ({ figli: await figliAttivi(g), foto: await fotoVisibili(g) })

  async function archiviaEControlla(bambino: string, genitore: string, haFrequenzaVecchia: boolean) {
    await oggiE('2027-08-10')
    await b.db.query(
      `INSERT INTO public.galleria_media_v2 (id, scuola_id, giorno_competenza, target_section_ids, target_classes, is_broadcast)
       VALUES ($1,$2,'2027-08-10',ARRAY[$3,$4]::uuid[],ARRAY['Farfalle','Girasoli'],true) ON CONFLICT DO NOTHING`, [FOTO_VECCHIA, SEDE_E2E, b.sezioni.farfalle, b.sezioni.girasoli])
    await oggiE('2027-08-20')
    const r = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: bambino })
    expect(r.stato, `archivia: ${String(r.errore)}`).toBe(200)
    const nuovo = await frequenza(bambino, 'nuovo')
    expect(nuovo?.stato, 'la frequenza dell’anno nuovo è chiusa').toBe('ritirato')
    const vecchio = await frequenza(bambino, 'vecchio')
    // (giro 4) Non più «se c'è»: chi continua HA la frequenza dell'anno visibile, chi è nuovo no, e lo si dice.
    expect(Boolean(vecchio), 'la frequenza dell’anno visibile c’è solo per chi continua').toBe(haFrequenzaVecchia)
    if (vecchio) expect(vecchio.stato, 'la frequenza dell’anno visibile è chiusa').toBe('ritirato')
    for (const giorno of ['2027-08-20', '2027-08-31']) {
      await oggiE(giorno)
      expect(await famiglia(genitore), `la famiglia il ${giorno}`).toEqual({ figli: [], foto: 0 })
    }
    expect(await scheda(bambino)).toContain('ARCHIVIATO')
    await oggiE(b.inizio)
    const rr = await ricopia(b.inizio)
    expect(await famiglia(genitore), 'la famiglia il 01/09').toEqual({ figli: [], foto: 0 })
    expect(await scheda(bambino), 'il 01/09 resta archiviato').toContain('ARCHIVIATO')
    // (giro 4, NB4) E senza classe sulla scheda (il diario legge `section_id` senza guardare lo stato). (Riattiva, giro 2) La frequenza nuova chiusa
    // INVECE tiene la sua classe: «Riattiva» la riapre con quella. NB4 lo regge `alunni_riallinea_da_frequenze`, che non copia la classe di una
    // frequenza non viva su una scheda archiviata (e la `15-bis` sorveglia).
    expect((await rows<C>(`SELECT section_id FROM public.alunni WHERE id=$1`, [bambino]))[0].section_id, 'il 01/09 la scheda archiviata non ha classe').toBeNull()
    expect((await frequenza(bambino, 'nuovo')).section_id ?? null, 'la frequenza nuova chiusa tiene la sua classe').not.toBeNull()
    expect((await frequenza(bambino, 'nuovo')).stato, 'e la sua frequenza nuova resta chiusa').toBe('ritirato')
    expect(Number(rr.archiviati), 'la ricopia lo conta').toBe(1)
    const log = await rows<{ contesto: { campi: C } }>(`SELECT contesto FROM public.app_log WHERE fingerprint LIKE 'passaggio-schede-ricopiate:%'`)
    expect(Number(log[0]?.contesto.campi.n_archiviati_dopo), 'il log dice quanti').toBe(1)
    // L'invariante 13 sulla foto di prova è un artefatto del banco: la foto è nata nel vecchio anno e il 01/09 i suoi nomi si traducono nel nuovo.
    expect((await invarianti()).filter((x) => !x.startsWith('13:galleria_media_v2')), 'invarianti').toEqual([])
  }

  prova('I3 · chi continua (esito `continua`), archiviato il 20/08', async () => { await archiviaEControlla(BAMBINI.continuaB, GEN, true) })
  prova('K3 · chi è nuovo (esito `nuova`), archiviato il 20/08', async () => { await archiviaEControlla(BAMBINI.nuova, GEN_N, false) })
})

describe('NB3 · il bambino creato in agosto con la classe nuova', () => {
  prova('J2/H6 · POST il 20/08: scheda «in arrivo», frequenza nel nuovo anno con ingresso all’inizio; la ricopia lo porta in classe', async () => {
    await oggiE('2027-08-20')
    const r = await rotta(STUDENTI_POST, 'POST', '/api/admin/students', {
      nome: 'Prova', cognome: 'Finta', data_nascita: '2023-03-03', scuola_id: SEDE_E2E, classe_sezione: 'Girasoli', data_iscrizione: '2027-08-20',
    })
    expect(r.stato, String(r.errore)).toBe(201)
    const id = r.id as string
    NOME[id] = 'nuovoDiAgosto'
    expect(await scheda(id), 'il 20/08 la scheda aspetta').toBe('in_arrivo/-')
    const f = await frequenza(id, 'nuovo')
    expect(f, 'la frequenza nel nuovo anno').toMatchObject({ stato: 'in_attesa', section_id: b.sezioni.girasoliNuova, ing: b.inizio })
    expect(await frequenza(id, 'vecchio'), 'niente nel vecchio').toBeUndefined()
    expect((await rows(`SELECT 1 FROM public.app_log WHERE fingerprint LIKE 'db:anno-specchio%'`)).length, 'nessun guasto dello specchio').toBe(0)
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    expect(await scheda(id), 'il 01/09 è in classe, senza `db:anno-specchio:alunni`').toBe('iscritto/girasoliNuova')
    expect((await frequenza(id, 'nuovo')).section_id).toBe(b.sezioni.girasoliNuova)
    expect(await invarianti()).toEqual([])
    expect((await rows(`SELECT 1 FROM public.app_log WHERE fingerprint LIKE 'db:anno-specchio%'`)).length).toBe(0)
  })

  prova('`anno_registra_frequenza` accetta il 20/08 un anno `corrente` non ancora cominciato, e non più il giorno dell’inizio', async () => {
    await oggiE('2027-08-20')
    await b.db.query(
      `INSERT INTO public.alunni (id, scuola_id, nome, cognome, data_nascita, stato) VALUES ('11111111-1111-4111-8111-1111111111f1',$1,'Prova','Finta','2023-05-05','in_arrivo')`, [SEDE_E2E])
    const chiamaRpc = () => rows<C>(
      `SELECT public.anno_registra_frequenza('11111111-1111-4111-8111-1111111111f1', $1, 'nuova', 'segreteria', NULL, $2, NULL, '{}'::jsonb, NULL) r`, [b.a, b.sezioni.girasoliNuova])
    expect((await chiamaRpc())[0].r).toMatchObject({ creata: true })
    await b.db.exec('ROLLBACK'); await b.db.exec('BEGIN')
    await oggiE(b.oggi); await prepara()
    await b.db.query(
      `INSERT INTO public.alunni (id, scuola_id, nome, cognome, data_nascita, stato) VALUES ('11111111-1111-4111-8111-1111111111f1',$1,'Prova','Finta','2023-05-05','in_arrivo')`, [SEDE_E2E])
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await b.db.exec('SAVEPOINT s_rpc')
    await expect(chiamaRpc()).rejects.toThrow(/ANNO_NON_APERTO/)
    await b.db.exec('ROLLBACK TO SAVEPOINT s_rpc')
  })
})

describe('B6/P23 · archiviato DOPO la ricopia, poi l’annullo', () => {
  prova('K2 · ricopia, archivia il 03/09 dalla route, annulla il 04/09: la famiglia non lo vede e l’invariante 11 resta a zero', async () => {
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    await oggiE('2027-09-03')
    const r = await rotta(ARCHIVIA, 'POST', '/api/admin/students/archivia', { alunno_id: BAMBINI.continuaB })
    expect(r.stato, String(r.errore)).toBe(200)
    expect(await figliAttivi(GEN), 'dopo l’archiviazione').toEqual([])
    await oggiE('2027-09-04')
    const a = await chiama(ANNULLA, 'POST', '/annulla', {})
    expect(a.stato, String(a.corpo?.error)).toBe(200)
    expect(await figliAttivi(GEN), 'dopo l’annullo').toEqual([])
    expect(await scheda(BAMBINI.continuaB)).toContain('ARCHIVIATO')
    const vecchio = await frequenza(BAMBINI.continuaB, 'vecchio')
    expect(vecchio.stato, 'la frequenza dell’anno che torna visibile è chiusa').toBe('ritirato')
    expect(await invarianti(), 'invariante 11 e le altre').toEqual([])
  })
})

describe('NS2/NS3 · il battito del job a vuoto e lo storico della ricopia in ritardo', () => {
  it('NS2 · un giro senza niente da fare scrive comunque il battito, con la stessa `operazione` del log di guasto', async () => {
    await b.db.exec('BEGIN')
    try {
      await oggiE('2027-08-20')
      const r = await ricopia('2027-08-20')
      expect(r.passaggi).toBe(0)
      const log = await rows<{ livello: string; evento: string; contesto: { campi: C } }>(
        `SELECT livello, evento, contesto FROM public.app_log WHERE fingerprint = 'cron:passaggio-ricopia-schede'`)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ livello: 'info', evento: 'cron' })
      expect(log[0].contesto.campi).toMatchObject({ operazione: 'passaggio-ricopia-schede', esito: 'ok', passaggi: 0, schede: 0 })
    } finally { await b.db.exec('ROLLBACK') }
  })

  prova('NS3 · la ricopia che gira in ritardo (10/09) lascia lo storico della classe nuova dal giorno dell’inizio, non dal 10/09', async () => {
    await oggiE('2027-09-10')
    await ricopia('2027-09-10')
    const storico = await rows<{ section_id: string; dal: string; al: string | null }>(
      `SELECT section_id, dal::text, al::text FROM public.alunni_classi_storico WHERE alunno_id = $1 ORDER BY dal, al NULLS LAST`, [BAMBINI.continua])
    expect(storico.at(-1)).toMatchObject({ section_id: b.sezioni.girasoliNuova, dal: b.inizio, al: null })
  })
})

describe('NS4 · la conferma tardiva fatta nella finestra è voluta: l’invariante 11 non si accende ogni notte', () => {
  prova('chi aveva detto «no», confermato il 20/08: nessuna riga di invariante fino al 01/09, e il 01/09 la scheda entra in classe', async () => {
    await oggiE('2027-08-20')
    const r = await chiama(TARDIVA, 'POST', '/conferma-tardiva', { alunno_id: BAMBINI.nonRisposto })
    expect(r.stato, String(r.corpo?.error)).toBe(200)
    for (const giorno of ['2027-08-20', '2027-08-25', '2027-08-31']) {
      await oggiE(giorno)
      expect(JSON.stringify(await invarianti()), `invarianti il ${giorno}`).toBe('[]')
    }
    await oggiE(b.inizio)
    await ricopia(b.inizio)
    expect(await scheda(BAMBINI.nonRisposto), 'il 01/09 è in classe').toMatch(/^iscritto\/farfalleNuova$/)
    expect(await invarianti(), 'e il 01/09 nessuna riga').toEqual([])
  })
})

describe('NS5 · le quote ancora aperte su chi esce includono quelle pagate in parte', () => {
  prova('una voce `parziale` sulla frequenza nuova di chi esce è contata', async () => {
    const f = (await rows<C>(`SELECT frequenza_a_id FROM public.passaggi_anno_righe WHERE alunno_id=$1`, [BAMBINI.cambiaGradoSenzaSezione]))[0].frequenza_a_id as string | null
    expect(f, 'chi esce ha la sua frequenza nuova').not.toBeNull()
    const v = (await rows<C>(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, stato, importo_pagato)
       VALUES ($1,$2,'Quota di prova',100,DATE '2027-10-01','parziale',40) RETURNING id`, [BAMBINI.cambiaGradoSenzaSezione, SEDE_E2E]))[0].id
    await b.db.query(`UPDATE public.frequenze SET quota_pagamento_id=$1 WHERE id=$2`, [v, f])
    const r = await chiama(LEGGI, 'GET', '?pagina=1&tetto=1&contatori=50')
    expect(r.stato, JSON.stringify(h.log.filter((l) => (l as unknown[])[0] === 'errore').slice(0, 2))).toBe(200)
    expect(((r.corpo.data as C).contatori as C).quoteSuUsciti).toBe(1)
  })
})

describe('NS1 · la lettura del passaggio porta i nomi delle classi di partenza (dell’anno vecchio)', () => {
  prova('`classi_da` ha il nome di ogni classe vecchia delle righe, anche se l’elenco delle sezioni del client è quello dell’anno nuovo', async () => {
    const r = await chiama(LEGGI, 'GET', '?pagina=1&tetto=50&contatori=50')
    expect(r.stato).toBe(200)
    const classi = (r.corpo.data as C).classi_da as Record<string, string>
    expect(classi[b.sezioni.girasoli]).toBe('Girasoli')
    expect(classi[b.sezioni.farfalle]).toBe('Farfalle')
  })
})
