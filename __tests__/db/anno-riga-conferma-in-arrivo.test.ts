import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest, NextResponse } from 'next/server'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'
import { clienteSuPglite } from '../helpers/supabase-su-pglite'

/**
 * COMPITO 4.5.17 · LA RIGA DI CONFERMA DI UN BAMBINO CHE TORNA: conferma, archiviazione, poi una domanda. La riga dell'anno prossimo si
 * riapre con `tipo = 'conferma'` e la scheda è `in_arrivo`: deve stare nelle «Nuove iscrizioni» (non in «Conferme»), coi moduli della
 * lista del suo tipo, e «Ritira la conferma» deve rifiutarla. Route vere sopra il SQL vero (client `supabase-js` minimo su PGlite).
 * Finti solo il gate, il perimetro di sede, l'audit e il registro degli accessi al fascicolo. Ogni prova gira in un ROLLBACK.
 * Importi e uuid sono esempi, i nomi sono inventati.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const UT = '55555555-5555-4555-8555-555555555551'
const AL = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({ db: null as unknown, ruolo: 'admin' as string }))

vi.mock('@/lib/supabase/server-client', async (orig) => {
  const { clienteSuPglite: cliente } = await import('../helpers/supabase-su-pglite')
  return { ...(await orig<typeof import('@/lib/supabase/server-client')>()), createAdminClient: async () => cliente(h.db as PGlite) }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, ruoli?: readonly string[]) => {
    if (ruoli && !ruoli.includes(h.ruolo)) {
      return { response: NextResponse.json({ error: 'Non hai il permesso di farlo.' }, { status: 403 }) }
    }
    return { user: { id: UT, role: h.ruolo, ruolo: h.ruolo } }
  },
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  assertAlunnoInScope: async () => null,
  scuoleDiUtente: async () => [S1],
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/app/api/admin/students/route', () => ({ classeEsisteInOgniSede: async () => null }))
vi.mock('@/lib/anno/impostazioni', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/impostazioni')>()),
  assertAnnoSedeInScope: async (supabase: { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown }> } } } }, _utente: unknown, annoSedeId: string, _operazione: string, letta?: { scuolaId?: string }) => {
    const r = await supabase.from('anni_sede').select('scuola_id').eq('id', annoSedeId).maybeSingle()
    if (letta) letta.scuolaId = (r.data as { scuola_id?: string } | null)?.scuola_id
    return null
  },
}))
vi.mock('@/lib/primaria/fascicolo-rbac', async (orig) => ({ ...(await orig<typeof import('@/lib/primaria/fascicolo-rbac')>()), logAccessoFascicolo: vi.fn(async () => undefined) }))
vi.mock('@/lib/pagamenti/notifiche-storiche', () => ({ ritiraPendingPagamento: vi.fn(async () => undefined) }))

import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { POST as CONFERMA } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { POST as RITIRA } from '@/app/api/admin/anni/[annoSedeId]/conferme/ritira/route'
import { POST as QUOTA } from '@/app/api/admin/anni/[annoSedeId]/conferme/quota/route'
import { GET as LEGGI } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { GET as MODULI_GET, PUT as MODULI_PUT } from '@/app/api/admin/frequenze/[frequenzaId]/moduli/route'
import { registraFrequenzaPerAnno } from '@/lib/anno/iscrizione-anno'
import { PATCH_RITORNO_IN_ARRIVO } from '@/lib/anno/domanda-anno-prossimo'

type Rec = Record<string, unknown>
let db: PGlite
const ANNO_SEDE: Record<string, string> = {}
const ANNO: Record<number, string> = {}

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 60_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  h.db = db
  h.ruolo = 'admin'
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
const cliente = () => clienteSuPglite(db)

async function giorni() {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40)
      WHERE id = $1`, [ANNO_SEDE[`${S1}:2026`]])
}
async function nuovoAlunno(id: string, stato = 'iscritto') {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, $3)`, [id, S1, stato])
}
async function apri(): Promise<string> {
  const a = ANNO_SEDE[`${S1}:2027`]
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'mod_conferma', 'Modulo di conferma', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'mod_nuova', 'Modulo di nuova iscrizione', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
  return a
}
async function sezione(anno: number, nome: string, continuaDa: string | null = null, tipo = 'infanzia'): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da) VALUES ($1, $2, $3, $4::public.school_type_enum, $4::text, $5) RETURNING id`,
    [S1, ANNO[anno], nome, tipo, continuaDa])
}
/** Il bambino che frequenta oggi, nella sua classe, e le classi dell'anno prossimo. Torna la frequenza di oggi e la sezione di oggi. */
async function frequentante(id = AL) {
  await giorni()
  await nuovoAlunno(id)
  const s26 = await sezione(2026, 'Girasoli')
  const f26 = await una<string>(
    `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [id])
  await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [s26, f26])
  return { f26, s26 }
}
const voci = async (id: string) => (await db.query<{ importo: string; stato: string }>(`SELECT importo::text, stato FROM public.pagamenti WHERE alunno_id = $1 ORDER BY importo`, [id])).rows
const conferma = async (anno: string, corpo: Rec) => {
  const r = await CONFERMA(richiesta(corpo), contesto(anno))
  return { status: r.status, corpo: (await r.json()) as { data?: Rec; codice?: string } }
}
const ritira = async (anno: string, frequenzaId: string) => {
  const r = await RITIRA(richiesta({ frequenza_id: frequenzaId }), contesto(anno))
  return { status: r.status, corpo: (await r.json()) as { data?: Rec; codice?: string } }
}
const richiesta = (corpo: unknown) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) })
const contesto = (anno: string) => ({ params: Promise.resolve({ annoSedeId: anno }) })

const frequenze = (id: string) =>
  db.query<Rec>(
    `SELECT f.id, f.stato, f.origine, f.tipo, f.data_uscita, f.quota_pagamento_id, y.anno_inizio
       FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE f.alunno_id = $1 ORDER BY y.anno_inizio`, [id]).then((r) => r.rows)
const accese = async () =>
  (await db.query<{ invariante: string; tabella: string; righe: number }>(
    `SELECT invariante, tabella, righe::int AS righe FROM public.anno_invarianti() WHERE righe > 0 ORDER BY 1, 2`)).rows
const archivia = async (id: string) => {
  const r = await ARCHIVIA(richiesta({ alunno_id: id }))
  return { status: r.status, corpo: (await r.json()) as Rec }
}

/** Il bambino che arriva l'anno prossimo, come lo scrive l'approvazione di una domanda: la scheda `in_arrivo` e la frequenza dell'anno aperto. */
async function approvaPerAnnoProssimo(id: string, anno: string, scheda = false) {
  if (scheda) {
    const { error } = await cliente().from('alunni').update({ ...PATCH_RITORNO_IN_ARRIVO }).eq('id', id)
    expect(error).toBeNull()
  }
  const r = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: id, annoSedeId: anno, tipo: 'nuova', origine: 'domanda', campi: {} })
  expect(r.ok).toBe(true)
  return r
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1], fino: 'M45c',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN IF NOT EXISTS importo_retta_mensile numeric(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS archiviato_il timestamptz,
        ADD COLUMN IF NOT EXISTS archiviato_da uuid,
        ADD COLUMN IF NOT EXISTS archiviato_motivo text,
        ADD COLUMN IF NOT EXISTS archiviato_section_id uuid,
        ADD COLUMN IF NOT EXISTS archiviato_classe_sezione text,
        ADD COLUMN IF NOT EXISTS spazio_liberato_il timestamptz,
        ADD COLUMN IF NOT EXISTS gruppo_mensa_id uuid,
        ADD COLUMN IF NOT EXISTS anonimizzato_il timestamptz,
        ADD COLUMN IF NOT EXISTS nome text,
        ADD COLUMN IF NOT EXISTS cognome text;
      ALTER TABLE public.pagamenti
        ADD COLUMN IF NOT EXISTS obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS gruppo text,
        ADD COLUMN IF NOT EXISTS creato_da uuid;
      CREATE TABLE IF NOT EXISTS public.incassi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id), transazione_id uuid, importo numeric(10,2) NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS public.fatture_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id));
      CREATE TABLE IF NOT EXISTS public.registro_modifiche (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), azione text, tabella_interessata text, record_id uuid,
        vecchio_valore jsonb, nuovo_valore jsonb, utente_id uuid);
    `,
  })
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string; anno_id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) {
    ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
    ANNO[x.anno_inizio] = x.anno_id
  }
}, 120_000)
afterAll(async () => { await db?.close() })

const leggi = async (anno: string, query = '') => {
  const r = await LEGGI(new NextRequest(`http://localhost/api/x?${query}`), contesto(anno))
  const j = (await r.json()) as { data?: { righe: Array<Record<string, unknown>>; totale: number } }
  return { status: r.status, righe: j.data?.righe ?? [], totale: j.data?.totale ?? -1 }
}
const moduliRiga = async (frequenzaId: string) => {
  const r = await MODULI_GET(new NextRequest('http://localhost/api/x'), { params: Promise.resolve({ frequenzaId }) })
  return ((await r.json()) as { data: { moduli: Array<{ modulo_id: string; codice: string; spuntato: boolean }> } }).data.moduli
}
const spunta = async (frequenzaId: string, moduloId: string) => {
  const r = await MODULI_PUT(
    new NextRequest('http://localhost/api/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modulo_id: moduloId, spuntato: true }) }),
    { params: Promise.resolve({ frequenzaId }) })
  return { status: r.status }
}
const paga = (frequenzaId: string) =>
  db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = (SELECT quota_pagamento_id FROM public.frequenze WHERE id = $1)`, [frequenzaId])
const rigaDi = (righe: Array<Record<string, unknown>>) => righe.find((x) => x.alunno_id === AL)

/** Conferma, archiviazione, poi una domanda: la riga dell'anno prossimo si riapre (`tipo = 'conferma'`) e la scheda è `in_arrivo`. */
async function famigliaTornata() {
  const { f26, s26 } = await frequentante()
  await db.query(`UPDATE public.alunni SET nome = 'Tino', cognome = 'Prova' WHERE id = $1`, [AL])
  await sezione(2027, 'Girasoli 27', s26)
  const a = await apri()
  const c = await conferma(a, { frequenza_id: f26 })
  expect(c.status).toBe(200)
  const nuova = c.corpo.data!.frequenza_id as string
  expect((await archivia(AL)).status).toBe(200)
  await approvaPerAnnoProssimo(AL, a, true)
  const [riga] = (await frequenze(AL)).filter((x) => x.anno_inizio === 2027)
  expect(riga).toMatchObject({ id: nuova, stato: 'in_attesa', tipo: 'conferma' })
  return { a, f26, nuova }
}

describe('4.5.17 · la riga di conferma di un bambino che torna', () => {
  prova('1 · sta in «Nuove iscrizioni», col nome, e NON in «Conferme»; il totale è giusto', async () => {
    await inRollback(async () => {
      const { a, nuova } = await famigliaTornata()
      const nuove = await leggi(a, 'vista=nuove')
      expect(nuove.status).toBe(200)
      expect(nuove.totale).toBe(1)
      expect(rigaDi(nuove.righe)).toMatchObject({ frequenza_id: nuova, nuova_frequenza_id: nuova, nome: 'Tino', cognome: 'Prova' })
      const conferme = await leggi(a, 'vista=conferme')
      expect(rigaDi(conferme.righe)).toBeUndefined()
    })
  })

  prova('2 · i moduli sono quelli della lista `conferma` (come la route che spunta); spunta + voce pagata → `iscritto`', async () => {
    await inRollback(async () => {
      const { a, nuova } = await famigliaTornata()
      const moduli = await moduliRiga(nuova)
      expect(moduli.map((m) => m.codice)).toEqual(['mod_conferma'])
      const prima = rigaDi((await leggi(a, 'vista=nuove')).righe)
      expect(prima!.moduli).toEqual({ fatti: 0, richiesti: 1 })
      expect((await spunta(nuova, moduli[0].modulo_id)).status).toBe(200)
      const dopo = rigaDi((await leggi(a, 'vista=nuove')).righe)
      expect(dopo!.moduli).toEqual({ fatti: 1, richiesti: 1 })
      await paga(nuova)
      expect((await frequenze(AL)).filter((x) => x.anno_inizio === 2027)[0].stato).toBe('iscritto')
    })
  })

  prova('3 · senza listino: niente voce, sta in «Nuove», «Genera la quota» risponde 200 e la voce è `quota_conferma`', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      const c = await conferma(a, { frequenza_id: f26 })
      const nuova = c.corpo.data!.frequenza_id as string
      expect((await archivia(AL)).status).toBe(200)
      await db.query(`DELETE FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_conferma'`, [a])
      await approvaPerAnnoProssimo(AL, a, true)
      expect(await voci(AL)).toEqual([])
      expect(rigaDi((await leggi(a, 'vista=nuove')).righe)).toMatchObject({ frequenza_id: nuova, quota: 'assente' })
      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a]).catch(() => undefined)
      const q = await QUOTA(richiesta({ frequenza_id: nuova }), contesto(a))
      expect(q.status).toBe(200)
      expect(await voci(AL)).toEqual([{ importo: '100.00', stato: 'da_pagare' }])
    })
  })

  prova('4 · il filtro «mancano moduli» nella vista «Nuove» la conta finché mancano e non dopo', async () => {
    await inRollback(async () => {
      const { a, nuova } = await famigliaTornata()
      const prima = await leggi(a, 'vista=nuove&conferma=mancano_moduli')
      expect(prima.totale).toBe(1)
      expect(rigaDi(prima.righe)).toBeDefined()
      const [m] = await moduliRiga(nuova)
      await spunta(nuova, m.modulo_id)
      const dopo = await leggi(a, 'vista=nuove&conferma=mancano_moduli')
      expect(dopo.totale).toBe(0)
      expect(dopo.righe).toEqual([])
    })
  })

  prova('5 · «Ritira la conferma» sulla riga: FREQUENZA_NON_DI_CONFERMA, riga e voce intatte, invarianti vuote', async () => {
    await inRollback(async () => {
      const { a, nuova } = await famigliaTornata()
      const vociPrima = await voci(AL)
      const r = await ritira(a, nuova)
      expect(r.status).toBe(409)
      expect(r.corpo.codice).toBe('FREQUENZA_NON_DI_CONFERMA')
      expect((await frequenze(AL)).filter((x) => x.anno_inizio === 2027)[0]).toMatchObject({ id: nuova, stato: 'in_attesa' })
      expect(await voci(AL)).toEqual(vociPrima)
      expect(await accese()).toEqual([])
    })
  })

  prova('6 · un frequentante con riga `nuova`, `iscritto`, col modulo della lista `nuova` spuntato: in «Conferme» dice 1/1 e il filtro non lo include; in «Nuove» dice 1/1', async () => {
    await inRollback(async () => {
      const { s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      const r = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: {} })
      expect(r.ok).toBe(true)
      const nuova = (r as { frequenza_id: string }).frequenza_id
      const [m] = await moduliRiga(nuova)
      expect(m.codice).toBe('mod_nuova')
      await spunta(nuova, m.modulo_id)
      await paga(nuova)
      const conferme = await leggi(a, 'vista=conferme')
      expect(rigaDi(conferme.righe)!.moduli).toEqual({ fatti: 1, richiesti: 1 })
      expect((await leggi(a, 'vista=conferme&conferma=mancano_moduli')).totale).toBe(0)
      const nuove = await leggi(a, 'vista=nuove')
      expect(rigaDi(nuove.righe)!.moduli).toEqual({ fatti: 1, richiesti: 1 })
    })
  })

  prova('7 · un frequentante con riga `conferma`: sta in «Conferme», non in «Nuove»', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      expect((await conferma(a, { frequenza_id: f26 })).status).toBe(200)
      expect(rigaDi((await leggi(a, 'vista=conferme')).righe)).toMatchObject({ conferma: 'confermato' })
      const nuove = await leggi(a, 'vista=nuove')
      expect(rigaDi(nuove.righe)).toBeUndefined()
      expect(nuove.totale).toBe(0)
    })
  })

  prova('8 · sede senza anno attivo: «Nuove» risponde 200 con le vive', async () => {
    await inRollback(async () => {
      const { a } = await famigliaTornata()
      await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [ANNO_SEDE[`${S1}:2026`]])
      const nuove = await leggi(a, 'vista=nuove')
      expect(nuove.status).toBe(200)
      expect(nuove.totale).toBe(1)
      expect(rigaDi(nuove.righe)).toBeDefined()
    })
  })
})
