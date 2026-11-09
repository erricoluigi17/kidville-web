import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest, NextResponse } from 'next/server'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'
import { clienteSuPglite } from '../helpers/supabase-su-pglite'

/**
 * COMPITO 4.5.16 · IL CICLO DELLE ISCRIZIONI DELL'ANNO PROSSIMO — il codice VERO sopra il SQL VERO (modello: gli scenari S1-S6 della
 * ri-revisione). Una sola strada per riaprire una frequenza ritirata: `anno_registra_frequenza`. Archiviazione, riattivazione, ritiro
 * della conferma, nuove domande e quota si provano sulle route vere (client `supabase-js` minimo su PGlite). Sono finti solo il gate, il
 * perimetro di sede, l'audit e il ritiro degli avvisi in coda. Ogni prova gira in una transazione che finisce in `ROLLBACK`.
 * Importi e uuid sono esempi.
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
vi.mock('@/lib/pagamenti/notifiche-storiche', () => ({ ritiraPendingPagamento: vi.fn(async () => undefined) }))

import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { POST as RIATTIVA } from '@/app/api/admin/students/riattiva/route'
import { POST as CONFERMA } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { POST as RITIRA } from '@/app/api/admin/anni/[annoSedeId]/conferme/ritira/route'
import { POST as QUOTA } from '@/app/api/admin/anni/[annoSedeId]/conferme/quota/route'
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
async function apri(primaria?: number): Promise<string> {
  const a = ANNO_SEDE[`${S1}:2027`]
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  if (primaria) await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', 'primaria', $2, NULL)`, [a, primaria])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
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
const riattiva = async (id: string) => {
  const r = await RIATTIVA(richiesta({ alunno_id: id }))
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


describe('A · una sola strada per riaprire: `anno_registra_frequenza`', () => {
  prova('S1 · conferma, ritiro, conferma con la primaria: la classe NUOVA, la voce da 150, `cambia_grado: true`', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const p27 = await sezione(2027, 'Prima A', null, 'primaria')
      const a = await apri(150)
      const c1 = await conferma(a, { frequenza_id: f26 })
      expect(c1.status).toBe(200)
      expect(await voci(AL)).toEqual([{ importo: '100.00', stato: 'da_pagare' }])
      const nuova = c1.corpo.data!.frequenza_id as string
      expect((await ritira(a, nuova)).status).toBe(200)
      expect(await voci(AL)).toEqual([])
      const c2 = await conferma(a, { frequenza_id: f26, section_id: p27, cambia_grado: true })
      expect(c2.status).toBe(200)
      expect(c2.corpo.data).toMatchObject({ frequenza_id: nuova, cambia_grado: true, riaperta: true })
      expect(c2.corpo.data).not.toHaveProperty('sezione_ignorata')
      expect(await una<string>(`SELECT section_id FROM public.frequenze WHERE id = $1`, [nuova])).toBe(p27)
      expect(await voci(AL)).toEqual([{ importo: '150.00', stato: 'da_pagare' }])
      expect(await accese()).toEqual([])
    })
  })

  prova('conferma su una frequenza VIVA con un’altra classe: la classe non cambia, `sezione_ignorata` arriva, `cambia_grado` non mente', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      const g27 = await sezione(2027, 'Girasoli 27', s26)
      const p27 = await sezione(2027, 'Prima A', null, 'primaria')
      const a = await apri(150)
      const c1 = await conferma(a, { frequenza_id: f26 })
      const nuova = c1.corpo.data!.frequenza_id as string
      // seconda conferma con la primaria SENZA la spunta del cambio grado: la riga e' viva, la sezione chiesta e' ignorata
      const c2 = await conferma(a, { frequenza_id: f26, section_id: p27 })
      expect(c2.status).toBe(200)
      expect(c2.corpo.data).toMatchObject({ frequenza_id: nuova, creata: false, cambia_grado: false, sezione_ignorata: true })
      expect(c2.corpo.data).not.toHaveProperty('riaperta')
      expect(await una<string>(`SELECT section_id FROM public.frequenze WHERE id = $1`, [nuova])).toBe(g27)
    })
  })

  prova('S3 · domanda chiusa dall’archiviazione, riattivazione con la frequenza di oggi: «Conferma» la riapre, con una voce nuova', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      const reg = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: {} })
      expect(reg).toMatchObject({ ok: true, creata: true, quota: 'creata' })
      expect((await archivia(AL)).status).toBe(200)
      expect((await riattiva(AL)).status).toBe(200)
      expect((await frequenze(AL)).map((x) => `${x.anno_inizio}:${x.stato}:${x.origine}`)).toEqual(['2026:iscritto:recupero', '2027:ritirato:domanda'])
      expect(await voci(AL)).toEqual([])
      const co = await conferma(a, { frequenza_id: f26 })
      expect(co.status).toBe(200)
      expect(co.corpo.data).toMatchObject({ riaperta: true, quota: 'creata' })
      // la riga e' `nuova` (nata da una domanda) e tale resta: la voce e' la quota della nuova iscrizione
      expect(await voci(AL)).toEqual([{ importo: '200.00', stato: 'da_pagare' }])
      // `tipo` e `origine` sono quelli della riga: la riapertura non li riscrive
      expect((await frequenze(AL)).map((x) => `${x.anno_inizio}:${x.stato}:${x.origine}:${x.tipo}`)).toEqual(['2026:iscritto:recupero:null', '2027:in_attesa:domanda:nuova'])
      expect(await accese()).toEqual([])
    })
  })

  prova('S6a · una domanda rimandata dopo l’archiviazione: la frequenza si riapre con la voce, e le invarianti restano a zero', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await approvaPerAnnoProssimo(AL, a)
      expect((await archivia(AL)).status).toBe(200)
      expect(await voci(AL)).toEqual([])
      await cliente().from('alunni').update({ ...PATCH_RITORNO_IN_ARRIVO }).eq('id', AL)
      const reg = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: {} })
      expect(reg).toMatchObject({ ok: true, creata: false, riaperta: true, quota: 'creata' })
      expect((await frequenze(AL)).map((x) => `${x.anno_inizio}:${x.stato}`)).toContain('2027:in_attesa')
      expect(await voci(AL)).toEqual([{ importo: '200.00', stato: 'da_pagare' }])
      expect(await accese()).toEqual([])
    })
  })

  prova('S6b · conferma ritirata e poi domanda approvata: riaperta, con la voce; il dato di famiglia presente vale, quello assente resta', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      const g27 = await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      const c1 = await conferma(a, { frequenza_id: f26 })
      const nuova = c1.corpo.data!.frequenza_id as string
      await db.query(`UPDATE public.frequenze SET retta_mensile = 321, usa_pannolino = true WHERE id = $1`, [nuova])
      expect((await ritira(a, nuova)).status).toBe(200)
      const reg = await registraFrequenzaPerAnno(cliente() as never, {
        alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: { usa_pannolino: false },
      })
      expect(reg).toMatchObject({ ok: true, creata: false, riaperta: true })
      const f = await una<Rec>(`SELECT to_jsonb(f) FROM public.frequenze f WHERE f.id = $1`, [nuova])
      expect(f).toMatchObject({ stato: 'in_attesa', data_uscita: null, section_id: g27, usa_pannolino: false, tipo: 'conferma', origine: 'conferma' })
      expect(Number(f.retta_mensile), 'la chiave assente resta').toBe(321)
      expect(await voci(AL)).toHaveLength(1)
      expect(await accese()).toEqual([])
    })
  })

  prova('una frequenza `trasferito` non si riapre: `chiusa: true`, nessuna voce, e «Conferma» risponde FREQUENZA_NON_VIVA', async () => {
    await inRollback(async () => {
      const { f26, s26 } = await frequentante()
      await sezione(2027, 'Girasoli 27', s26)
      const a = await apri()
      const nuova = (await conferma(a, { frequenza_id: f26 })).corpo.data!.frequenza_id as string
      const rit = await ritira(a, nuova)
      expect(rit.status).toBe(200)
      await db.query(`UPDATE public.frequenze SET stato = 'trasferito' WHERE id = $1`, [nuova])
      const reg = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: {} })
      expect(reg).toMatchObject({ ok: true, creata: false, chiusa: true, quota: null })
      expect(reg).not.toHaveProperty('riaperta')
      expect(await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [nuova])).toBe('trasferito')
      expect(await voci(AL)).toEqual([])
      const co = await conferma(a, { frequenza_id: f26 })
      expect(co.status).toBe(409)
      expect(co.corpo.codice).toBe('FREQUENZA_NON_VIVA')
    })
  })

  prova('idempotenza: rifare su una riga già viva è `creata: false`, senza `riaperta` né `chiusa`', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await approvaPerAnnoProssimo(AL, a)
      const reg = await registraFrequenzaPerAnno(cliente() as never, { alunnoId: AL, annoSedeId: a, tipo: 'nuova', origine: 'domanda', campi: {} })
      expect(reg).toMatchObject({ ok: true, creata: false })
      expect(reg).not.toHaveProperty('riaperta')
      expect(reg).not.toHaveProperty('chiusa')
      expect(await voci(AL)).toHaveLength(1)
    })
  })
})

describe('F · «Genera la quota» dalla frequenza dell\u2019anno nuovo', () => {
  const quota = async (anno: string, corpo: unknown) => {
    const r = await QUOTA(
      new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }),
      { params: Promise.resolve({ annoSedeId: anno }) })
    return { status: r.status, corpo: (await r.json()) as { data?: Rec; codice?: string } }
  }
  /** Un anno aperto il cui listino della «nuova» è stato tolto dopo l'apertura: la domanda approvata ha la frequenza, la voce no (`senza_listino`). */
  async function apriSenzaListino(): Promise<string> {
    const a = await apri()
    await db.query(`DELETE FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_nuova'`, [a])
    return a
  }
  const freqNuova = (anno: string) => una<string>(`SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL, anno])

  prova('senza listino: 200 `senza_listino`; messo il listino, la stessa richiesta fa nascere la voce (`creata`, con il suo uuid); rifatta, la riprende', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apriSenzaListino()
      await approvaPerAnnoProssimo(AL, a)
      const f = await freqNuova(a)
      const senza = await quota(a, { frequenza_id: f })
      expect(senza.status).toBe(200)
      expect(senza.corpo.data).toMatchObject({ frequenza_id: f, quota: 'senza_listino', pagamento_id: null })
      expect(await voci(AL)).toHaveLength(0)

      await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
      const creata = await quota(a, { frequenza_id: f })
      expect(creata.status).toBe(200)
      expect(creata.corpo.data).toMatchObject({ frequenza_id: f, quota: 'creata' })
      expect(typeof creata.corpo.data!.pagamento_id).toBe('string')
      expect(await voci(AL)).toHaveLength(1)

      const di_nuovo = await quota(a, { frequenza_id: f })
      expect(di_nuovo.corpo.data).toMatchObject({ quota: 'gia_collegata', pagamento_id: creata.corpo.data!.pagamento_id })
      expect(await voci(AL), 'nessuna voce doppia').toHaveLength(1)
    })
  })

  prova('due voci già lì: `piu_voci`, e la richiesta non ne crea una terza', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await approvaPerAnnoProssimo(AL, a)
      const f = await freqNuova(a)
      const voceId = await una<string>(`SELECT id FROM public.pagamenti WHERE alunno_id = $1`, [AL])
      await db.query(
        `INSERT INTO public.pagamenti SELECT (jsonb_populate_record(null::public.pagamenti, to_jsonb(p) || jsonb_build_object('id', gen_random_uuid()))).* FROM public.pagamenti p WHERE p.id = $1`,
        [voceId])
      // la frequenza non ha la voce collegata (com'è per una domanda approvata con più voci «Iscrizione» già in contabilità)
      await db.query(`UPDATE public.frequenze SET quota_pagamento_id = NULL WHERE id = $1`, [f])
      expect(await voci(AL)).toHaveLength(2)
      const r = await quota(a, { frequenza_id: f })
      expect(r.status).toBe(200)
      expect(r.corpo.data).toMatchObject({ quota: 'piu_voci', pagamento_id: null })
      expect(await voci(AL)).toHaveLength(2)
    })
  })

  prova('una frequenza di un ALTRO anno: 404 FREQUENZA_NON_TROVATA, e non si scrive niente', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const a = await apri()
      const f26 = await una<string>(
        `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [AL])
      const r = await quota(a, { frequenza_id: f26 })
      expect(r.status).toBe(404)
      expect(r.corpo.codice).toBe('FREQUENZA_NON_TROVATA')
      expect(await voci(AL)).toHaveLength(0)
    })
  })

  prova('una frequenza RITIRATA: 409 FREQUENZA_NON_VIVA prima di registrare, quindi NON si riapre e non nasce una voce', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL, 'in_arrivo')
      const a = await apri()
      await approvaPerAnnoProssimo(AL, a)
      const f = await freqNuova(a)
      expect((await ARCHIVIA(new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alunno_id: AL }) }))).status).toBe(200)
      expect(await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [f])).toBe('ritirato')
      const r = await quota(a, { frequenza_id: f })
      expect(r.status).toBe(409)
      expect(r.corpo.codice).toBe('FREQUENZA_NON_VIVA')
      expect(await una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [f])).toBe('ritirato')
      expect(await voci(AL)).toHaveLength(0)
    })
  })

  prova('corpo con campi in più o uuid sbagliato: 400; anno nell\u2019URL non valido: 400', async () => {
    await inRollback(async () => {
      const a = ANNO_SEDE[`${S1}:2027`]
      expect((await quota(a, { frequenza_id: '11111111-1111-4111-8111-111111111111', extra: 1 })).status).toBe(400)
      expect((await quota(a, { frequenza_id: 'non-un-uuid' })).status).toBe(400)
      expect((await quota('non-un-anno', { frequenza_id: '11111111-1111-4111-8111-111111111111' })).status).toBe(400)
    })
  })
})
