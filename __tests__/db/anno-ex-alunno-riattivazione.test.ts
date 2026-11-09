import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest, NextResponse } from 'next/server'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'
import { clienteSuPglite } from '../helpers/supabase-su-pglite'

/**
 * COMPITO 4.5.15 · I2 e I3 · L'EX ALUNNO CHE TORNA «IN ARRIVO», ARCHIVIARE E RIATTIVARE UN «IN ARRIVO» (migrazione M45b + route `riattiva`).
 *
 * Tutta la sequenza gira sul codice VERO (le route `archivia` e `riattiva`, la porta dell'iscrizione, `scriviFrequenza`) sopra il SQL VERO
 * delle migrazioni, attraverso il client `supabase-js` minimo su PGlite. Sono finti solo il gate (`requireStaff`), il perimetro di sede
 * (`assertAlunnoInScope`, `scuoleDiUtente`, `assertAnnoSedeInScope`), l'audit e il ritiro degli avvisi in coda: la sede ha le sue prove altrove.
 *
 * Nessuna `UPDATE` diretta aggiusta ciò che il codice dovrebbe scrivere: lo stato di un bambino lo scrivono le route, quello di una
 * frequenza il TypeScript o il SQL. Ogni prova gira in una transazione che finisce in `ROLLBACK`. Gli importi sono esempi. Solo uuid finti.
 *
 * L'esito che decide tutto: alla fine di ogni sequenza `anno_invarianti()` ha le stesse righe accese di prima (nessuna).
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
import { registraFrequenzaPerAnno } from '@/lib/anno/iscrizione-anno'
import { scriviFrequenza } from '@/lib/anno/frequenze'
import { PATCH_RITORNO_IN_ARRIVO, eExAlunno } from '@/lib/anno/domanda-anno-prossimo'

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
const conta = (sql: string, params: unknown[] = []) => una<number>(`SELECT count(*)::int FROM (${sql}) x`, params)
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
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
  return a
}
async function sezione(anno: number, nome: string, continuaDa: string | null = null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da) VALUES ($1, $2, $3, 'infanzia', 'infanzia', $4) RETURNING id`,
    [S1, ANNO[anno], nome, continuaDa])
}
const richiesta = (corpo: unknown) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) })
const contesto = (anno: string) => ({ params: Promise.resolve({ annoSedeId: anno }) })

const alunno = (id: string) => una<Rec>(`SELECT to_jsonb(a) FROM public.alunni a WHERE a.id = $1`, [id])
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

describe('I2 · un ex alunno che torna `in_arrivo`', () => {
  prova('archiviato e poi approvato per l’anno prossimo: nessuna invariante accesa, e una scrittura sulla frequenza non lo disfa', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const prima = await accese()
      await sezione(2027, 'Girasoli 27')
      const a27 = await apri()

      const arch = await archivia(AL)
      expect(arch.status).toBe(200)
      expect((await alunno(AL)).stato).toBe('ritirato')
      expect(await accese(), 'archiviato e senza altra frequenza: la scheda e la frequenza chiusa dicono la stessa cosa').toEqual(prima)

      await approvaPerAnnoProssimo(AL, a27, true)
      expect((await alunno(AL)).stato).toBe('in_arrivo')
      expect(await accese(), 'in arrivo con la frequenza dell’anno attivo chiusa: non è un disallineamento').toEqual(prima)

      // basta una scrittura sulla frequenza dell'anno attivo (qui la retta) perché lo specchio inverso ricopi sulla scheda
      const w = await scriviFrequenza(cliente() as never, { alunnoId: AL, annoSedeId: ANNO_SEDE[`${S1}:2026`], campi: { retta_mensile: 150 } })
      expect(w).toMatchObject({ ok: true })
      const dopo = await alunno(AL)
      expect(dopo.stato, 'lo specchio inverso non rifà la scheda di un in arrivo da una frequenza chiusa').toBe('in_arrivo')
      expect(dopo.archiviato_il).toBeNull()
      expect(await accese()).toEqual(prima)
    })
  })
})

describe('I3 · archiviare e riattivare un `in_arrivo`', () => {
  prova('archiviato: invarianti a zero e quota tolta; riattivato: torna `in_arrivo`, l’iscrizione si riapre e la quota rinasce', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL, 'in_arrivo')
      await sezione(2027, 'Girasoli 27')
      const a27 = await apri()
      const nata = await approvaPerAnnoProssimo(AL, a27)
      const prima = await accese()
      expect(prima, 'il bambino in arrivo con la sua iscrizione è a posto').toEqual([])
      const voce = 'pagamento_id' in nata ? (nata.pagamento_id as string) : null
      expect(voce, 'la quota della domanda nuova è nata').toBeTruthy()

      const arch = await archivia(AL)
      expect(arch.status).toBe(200)
      expect(arch.corpo.frequenze_chiuse).toBe(1)
      expect((await frequenze(AL)).map((f) => f.stato)).toEqual(['ritirato'])
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(0)
      expect(await accese(), 'un archiviato senza frequenza dell’anno attivo non accende la 11-bis').toEqual(prima)

      const ri = await riattiva(AL)
      expect(ri.status).toBe(200)
      expect(ri.corpo.torna_in_arrivo).toBe(true)
      const scheda = await alunno(AL)
      expect(scheda.stato).toBe('in_arrivo')
      expect(scheda.archiviato_il).toBeNull()
      expect(scheda.section_id).toBeNull()
      const f = await frequenze(AL)
      expect(f.map((x) => x.stato)).toEqual(['in_attesa'])
      expect(f[0].data_uscita).toBeNull()
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [f[0].quota_pagamento_id]), 'la quota è rinata').toBe(1)
      expect(await accese(), 'a fine sequenza le invarianti sono quelle di prima').toEqual(prima)
    })
  })

  prova('un frequentante con la conferma aperta: archiviato e riattivato torna `iscritto`, la conferma NON si riapre e la risposta lo dice', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const prima = await accese()
      const f26 = await una<string>(
        `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [AL])
      const s26 = await sezione(2026, 'Girasoli')
      await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [s26, f26])
      await sezione(2027, 'Girasoli 27', s26)
      const a27 = await apri()
      const c = await CONFERMA(richiesta({ frequenza_id: f26 }), contesto(a27))
      expect(c.status).toBe(200)

      expect((await archivia(AL)).status).toBe(200)
      const ri = await riattiva(AL)
      expect(ri.status).toBe(200)
      expect(ri.corpo.torna_in_arrivo).toBeFalsy()
      expect(ri.corpo.conferma_da_rifare, 'la risposta dice che la conferma dell’anno prossimo si rifà').toBe(true)
      expect((await alunno(AL)).stato).toBe('iscritto')
      const f = await frequenze(AL)
      expect(f.map((x) => `${x.anno_inizio}:${x.stato}`)).toEqual(['2026:iscritto', '2027:ritirato'])
      expect(await accese()).toEqual(prima)
    })
  })
})

describe('4.5.16 (C) · riattivare', () => {
  prova('S2: un ex alunno tornato `in_arrivo` e riarchiviato, la cui frequenza di oggi risulta chiusa PRIMA dell\u2019archiviazione, alla riattivazione torna `in_arrivo` (non `iscritto`)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const a = await apri()
      expect((await archivia(AL)).status).toBe(200)
      await approvaPerAnnoProssimo(AL, a, true)
      expect((await archivia(AL)).status).toBe(200)
      // ⚠️ MISURA (4.5.16): `archivia` riscrive l'uscita della riga già chiusa col giorno di OGGI (la frequenza si scrive prima di
      // `alunni`, `campiFrequenzaDaAlunno`), quindi nel flusso reale le due date coincidono e la regola «uscita precedente
      // all'archiviazione» non scatta. Qui l'uscita si riporta indietro a mano, come farebbe una correzione o un import: è la sola
      // condizione in cui la regola decide. Vedi il report, dubbi.
      await db.query(
        `UPDATE public.frequenze f SET data_ingresso = public.giorno_roma(now()) - 30, data_uscita = public.giorno_roma(now()) - 5
           FROM public.anni_sede s WHERE f.anno_sede_id = s.id AND s.stato = 'corrente' AND f.alunno_id = $1`, [AL])

      const ri = await riattiva(AL)
      expect(ri.status).toBe(200)
      expect(ri.corpo.torna_in_arrivo).toBe(true)
      expect((await alunno(AL)).stato).toBe('in_arrivo')
      const f = await frequenze(AL)
      expect(f.map((x) => `${x.anno_inizio}:${x.stato}`), 'l\u2019iscrizione dell\u2019anno dopo è viva, quella di oggi resta chiusa').toEqual(['2026:ritirato', '2027:in_attesa'])
    })
  })

  prova('un frequentante archiviato OGGI torna `iscritto` come sempre (la sua uscita è di oggi, non precedente)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await apri()
      expect((await archivia(AL)).status).toBe(200)
      const ri = await riattiva(AL)
      expect(ri.status).toBe(200)
      expect(ri.corpo.torna_in_arrivo).toBeFalsy()
      expect((await alunno(AL)).stato).toBe('iscritto')
    })
  })

  prova('un frequentante con una DOMANDA approvata: archiviato e riattivato torna `iscritto`, e la risposta dice che l\u2019iscrizione si riapre da «Conferme»', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const a = await apri()
      await approvaPerAnnoProssimo(AL, a)
      expect((await archivia(AL)).status).toBe(200)
      const ri = await riattiva(AL)
      expect(ri.status).toBe(200)
      expect(ri.corpo.torna_in_arrivo).toBeFalsy()
      expect(ri.corpo.conferma_da_rifare).toBe(true)
      expect(ri.corpo, 'il campo che nessuno leggeva non c\u2019è più').not.toHaveProperty('iscrizione_prossimo_anno_chiusa')
      expect((await alunno(AL)).stato).toBe('iscritto')
      expect((await frequenze(AL)).map((x) => `${x.anno_inizio}:${x.stato}`)).toEqual(['2026:iscritto', '2027:ritirato'])
    })
  })
})

describe('4.5.16 (D) · l\u2019ex alunno è solo chi è archiviato', () => {
  it('`eExAlunno`: vale `archiviato_il`, non `stato`', () => {
    expect(eExAlunno({ stato: 'ritirato', archiviato_il: null })).toBe(false) // la tendina «Ritirato»
    expect(eExAlunno({ stato: 'ritirato' })).toBe(false)
    expect(eExAlunno({ stato: 'iscritto', archiviato_il: null })).toBe(false)
    expect(eExAlunno({ stato: 'ritirato', archiviato_il: '2026-11-04T10:00:00Z' })).toBe(true)
    expect(eExAlunno(null)).toBe(false)
  })

  prova('S4: un «ritirato» dalla tendina con una domanda approvata resta com\u2019è (classe e frequenza di oggi) e ha solo la frequenza dell\u2019anno dopo; una scrittura su quella di oggi non cambia la scheda', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const s26 = await sezione(2026, 'Girasoli')
      const f26 = await una<string>(
        `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [AL])
      await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [s26, f26])
      const a = await apri()
      // la tendina: lo stato cambia, l'archiviazione no
      const t = await cliente().from('alunni').update({ stato: 'ritirato' }).eq('id', AL)
      expect(t.error).toBeNull()
      const prima = await alunno(AL)
      expect(prima.archiviato_il).toBeNull()

      // l'approvazione, com'è dopo la correzione: il bambino NON è un ex alunno, la scheda non si tocca; nasce la frequenza dell'anno dopo
      const scheda = { stato: prima.stato as string, archiviato_il: prima.archiviato_il as string | null }
      expect(eExAlunno(scheda)).toBe(false)
      await approvaPerAnnoProssimo(AL, a, eExAlunno(scheda))
      expect(await alunno(AL)).toEqual(prima)

      const w = await scriviFrequenza(cliente() as never, { alunnoId: AL, annoSedeId: ANNO_SEDE[`${S1}:2026`], campi: { retta_mensile: 321 } })
      expect(w.ok).toBe(true)
      const dopo = await alunno(AL)
      // la retta si rispecchia sulla scheda (è giusto); lo stato, la classe e l'archiviazione no
      expect({ stato: dopo.stato, section_id: dopo.section_id, classe_sezione: dopo.classe_sezione, archiviato_il: dopo.archiviato_il },
        'una scrittura sulla frequenza di oggi non rimette `iscritto`, né tocca la classe')
        .toEqual({ stato: 'ritirato', section_id: prima.section_id, classe_sezione: prima.classe_sezione, archiviato_il: null })
      // la tendina non archivia: la frequenza di oggi resta viva (lo specchio la tratta così), e a questa PR non spetta cambiarlo
      expect((await frequenze(AL)).map((x) => `${x.anno_inizio}:${x.stato}`)).toEqual(['2026:iscritto', '2027:in_attesa'])
      expect(await accese(), 'nessuna invariante accesa').toEqual([])
    })
  })
})
