import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest, NextResponse } from 'next/server'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'
import { clienteSuPglite } from '../helpers/supabase-su-pglite'

/**
 * COMPITO 4.5.15 · C1 · TOGLIERE UNA CONFERMA — il codice VERO sopra il SQL VERO.
 *
 * Le route girano davvero (`conferme/ritira`, `conferme`, `moduli-mancanti`) e parlano con PGlite attraverso un client `supabase-js`
 * minimo (`helpers/supabase-su-pglite.ts`): `scriviFrequenza`, `controllaVoceEliminabile`, la porta dell'iscrizione e le funzioni
 * `anno_conferma` / `anno_registra_frequenza` sono quelle di produzione. Sono finti solo il gate (`requireStaff`: onora la lista dei
 * ruoli che la route gli passa), il perimetro di sede (`assertAnnoSedeInScope`: la sede ha le sue prove altrove) e il ritiro degli
 * avvisi in coda (`ritiraPendingPagamento`, un'altra tabella di notifiche che qui non c'è).
 *
 * Nessuna `UPDATE` diretta aggiusta lo stato di una frequenza: il ritiro lo scrive il codice, la conferma rifatta la riapre il SQL.
 * Ogni prova gira in una transazione che finisce in `ROLLBACK`. Gli importi (100, 200) sono esempi. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const UT = '55555555-5555-4555-8555-555555555551'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'

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
vi.mock('@/lib/anno/impostazioni', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/impostazioni')>()),
  // il perimetro di sede non si prova qui; la sede dell'anno però la riempie come l'originale (la route delle conferme la legge)
  assertAnnoSedeInScope: async (supabase: { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown }> } } } }, _utente: unknown, annoSedeId: string, _operazione: string, letta?: { scuolaId?: string }) => {
    const r = await supabase.from('anni_sede').select('scuola_id').eq('id', annoSedeId).maybeSingle()
    if (letta) letta.scuolaId = (r.data as { scuola_id?: string } | null)?.scuola_id
    return null
  },
}))
vi.mock('@/lib/pagamenti/notifiche-storiche', () => ({ ritiraPendingPagamento: vi.fn(async () => undefined) }))

import { POST as RITIRA } from '@/app/api/admin/anni/[annoSedeId]/conferme/ritira/route'
import { POST as CONFERMA, GET as ELENCO } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { GET as MODULI_MANCANTI } from '@/app/api/admin/anni/[annoSedeId]/moduli-mancanti/route'
import { chiudiFrequenzeAperte } from '@/lib/anno/iscrizione-anno'

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
async function partenza(alunno: string, sezioneId: string): Promise<string> {
  const id = await una<string>(
    `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [alunno])
  await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [sezioneId, id])
  return id
}
const richiesta = (corpo: unknown) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) })
const contesto = (anno: string) => ({ params: Promise.resolve({ annoSedeId: anno }) })

/** Un bambino confermato per l'anno prossimo, dalla route vera. Torna la frequenza nuova e la voce. */
async function confermato(alunno = AL) {
  await giorni()
  await nuovoAlunno(alunno)
  const s26 = await sezione(2026, 'Girasoli')
  const f26 = await partenza(alunno, s26)
  await sezione(2027, 'Girasoli 27', s26)
  const anno = await apri()
  const r = await CONFERMA(richiesta({ frequenza_id: f26 }), contesto(anno))
  expect(r.status).toBe(200)
  const nuova = (await r.json()).data as { frequenza_id: string; pagamento_id: string; quota: string }
  expect(nuova.quota).toBe('creata')
  return { anno, f26, nuova: nuova.frequenza_id, voce: nuova.pagamento_id }
}
const freq = (id: string) => una<Rec>(`SELECT to_jsonb(f) FROM public.frequenze f WHERE f.id = $1`, [id])
const ritira = async (anno: string, frequenzaId: string) => {
  const r = await RITIRA(richiesta({ frequenza_id: frequenzaId }), contesto(anno))
  const corpo = (await r.json()) as { data?: Rec; codice?: string }
  return { status: r.status, corpo }
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1], fino: 'M45c',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0,
        ADD COLUMN archiviato_il timestamptz,
        ADD COLUMN anonimizzato_il timestamptz,
        ADD COLUMN nome text,
        ADD COLUMN cognome text;
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid;
      -- le tabelle che le guardie dell'eliminazione di una voce leggono (in produzione ci sono; qui le due che contano)
      CREATE TABLE public.incassi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id), transazione_id uuid, importo numeric(10,2) NOT NULL DEFAULT 0);
      CREATE TABLE public.fatture_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id));
      CREATE TABLE public.registro_modifiche (
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

describe('«Ritira la conferma» dalla route vera', () => {
  prova('ritira la frequenza, toglie la voce non pagata, scrive l’audit e libera posti e moduli', async () => {
    await inRollback(async () => {
      const { anno, nuova, voce } = await confermato()
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(1)
      const prima = await una<Rec[]>(`SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.anno_conta_posti($1) p`, [anno])
      expect(prima.reduce((n, p) => n + Number(p.iscritti), 0), 'prima del ritiro il bambino è contato').toBe(1)

      const r = await ritira(anno, nuova)
      expect(r.status).toBe(200)
      expect(r.corpo.data).toMatchObject({ frequenza_id: nuova, ritirata: true, quota: 'tolta' })

      const f = await freq(nuova)
      expect(f.stato).toBe('ritirato')
      expect(f.data_uscita, 'ritirato ha una data d’uscita valida per i CHECK').not.toBeNull()
      expect(f.quota_pagamento_id).toBeNull()
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce]), 'la famiglia non vede più la voce').toBe(0)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.registro_modifiche WHERE record_id = $1 AND azione = 'elimina_pagamento'`, [voce])).toBe(1)

      const dopo = await una<Rec[]>(`SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.anno_conta_posti($1) p`, [anno])
      expect(dopo.reduce((n, p) => n + Number(p.iscritti), 0), 'una frequenza ritirata non è contata nei posti').toBe(0)

      const mm = await MODULI_MANCANTI(new NextRequest(`http://localhost/api/x?anno=${anno}`), contesto(anno))
      expect(mm.status).toBe(200)
      expect(JSON.stringify(await mm.json())).not.toContain(nuova)
    })
  })

  prova('con un incasso la voce RESTA, la frequenza è ritirata lo stesso, e la risposta lo dice', async () => {
    await inRollback(async () => {
      const { anno, nuova, voce } = await confermato()
      await db.query(`INSERT INTO public.incassi (pagamento_id) VALUES ($1)`, [voce])
      const r = await ritira(anno, nuova)
      expect(r.status).toBe(200)
      expect(r.corpo.data).toMatchObject({ ritirata: true, quota: 'resta-pagata' })
      expect((await freq(nuova)).stato).toBe('ritirato')
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(1)
      expect(await conta(`SELECT 1 FROM public.registro_modifiche WHERE record_id = $1`, [voce])).toBe(0)
    })
  })

  prova('una voce già «pagato» resta anche senza incassi registrati', async () => {
    await inRollback(async () => {
      const { anno, nuova, voce } = await confermato()
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = importo WHERE id = $1`, [voce])
      const r = await ritira(anno, nuova)
      expect(r.corpo.data).toMatchObject({ quota: 'resta-pagata' })
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(1)
    })
  })

  prova('una fattura emessa trattiene la voce', async () => {
    await inRollback(async () => {
      const { anno, nuova, voce } = await confermato()
      await db.query(`INSERT INTO public.fatture_emesse (pagamento_id) VALUES ($1)`, [voce])
      expect((await ritira(anno, nuova)).corpo.data).toMatchObject({ quota: 'resta-pagata' })
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(1)
    })
  })

  prova('la conferma rifatta riapre la STESSA riga e ricrea la voce; «Non rinnova» si può dire in mezzo', async () => {
    await inRollback(async () => {
      const { anno, f26, nuova } = await confermato()
      expect((await ritira(anno, nuova)).corpo.data).toMatchObject({ quota: 'tolta' })
      const nr = await db.query(`SELECT public.anno_non_rinnova($1, true, 'altro', $2)`, [f26, UT])
      expect(nr.rows).toHaveLength(1)
      await db.query(`SELECT public.anno_non_rinnova($1, false, NULL, $2)`, [f26, UT])

      const r = await CONFERMA(richiesta({ frequenza_id: f26 }), contesto(anno))
      expect(r.status).toBe(200)
      const d = (await r.json()).data as Rec
      expect(d.frequenza_id, 'è la stessa riga (UNIQUE alunno, anno)').toBe(nuova)
      expect(d.quota).toBe('creata')
      const f = await freq(nuova)
      expect(f.stato).toBe('in_attesa')
      expect(f.data_uscita).toBeNull()
      expect(f.quota_pagamento_id).toBe(d.pagamento_id)
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL, anno])).toBe(1)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL]), 'una sola voce, non due').toBe(1)
    })
  })

  prova('dopo un ritiro con la voce rimasta pagata, la conferma rifatta la ricollega e non ne crea una seconda', async () => {
    await inRollback(async () => {
      const { anno, f26, nuova, voce } = await confermato()
      await db.query(`INSERT INTO public.incassi (pagamento_id) VALUES ($1)`, [voce])
      await ritira(anno, nuova)
      const r = await CONFERMA(richiesta({ frequenza_id: f26 }), contesto(anno))
      expect(r.status).toBe(200)
      expect(((await r.json()).data as Rec).quota).toBe('gia_collegata')
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL])).toBe(1)
    })
  })

  prova('ritirare due volte è innocuo: la seconda non riscrive niente', async () => {
    await inRollback(async () => {
      const { anno, nuova } = await confermato()
      await ritira(anno, nuova)
      const seconda = await ritira(anno, nuova)
      expect(seconda.status).toBe(200)
      expect(seconda.corpo.data).toMatchObject({ ritirata: false, quota: 'nessuna' })
    })
  })

  prova('la coordinatrice è respinta (403) e non cambia niente', async () => {
    await inRollback(async () => {
      const { anno, nuova, voce } = await confermato()
      h.ruolo = 'coordinator'
      const r = await RITIRA(richiesta({ frequenza_id: nuova }), contesto(anno))
      expect(r.status).toBe(403)
      expect((await freq(nuova)).stato).toBe('in_attesa')
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(1)
    })
  })

  prova('una frequenza che non nasce da una conferma non si ritira da qui (409) e resta com’è', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL2, 'in_arrivo')
      const anno = await apri()
      const reg = await una<Rec>(`SELECT public.anno_registra_frequenza($1, $2, 'nuova', 'domanda', NULL, NULL, NULL, NULL, $3)`, [AL2, anno, UT])
      const r = await ritira(anno, reg.frequenza_id as string)
      expect(r.status).toBe(409)
      expect(r.corpo.codice).toBe('FREQUENZA_NON_DI_CONFERMA')
      expect((await freq(reg.frequenza_id as string)).stato).toBe('in_attesa')
    })
  })

  prova('una frequenza di un altro anno, o corpo con campi in più: respinti', async () => {
    await inRollback(async () => {
      const { anno, nuova } = await confermato()
      const altroAnno = ANNO_SEDE[`${S1}:2026`]
      const r1 = await RITIRA(richiesta({ frequenza_id: nuova }), contesto(altroAnno))
      expect(r1.status).toBe(404)
      const r2 = await RITIRA(richiesta({ frequenza_id: nuova, extra: 1 }), contesto(anno))
      expect(r2.status).toBe(400)
      expect((await freq(nuova)).stato).toBe('in_attesa')
    })
  })

  prova('l’elenco delle conferme, dopo il ritiro, rimette la riga fra chi non ha risposto (azioni di nuovo disponibili)', async () => {
    await inRollback(async () => {
      const { anno, nuova } = await confermato()
      await ritira(anno, nuova)
      const r = await ELENCO(new NextRequest(`http://localhost/api/x?vista=conferme&conferma=tutti&pagina=1`), contesto(anno))
      expect(r.status).toBe(200)
      const righe = ((await r.json()).data.righe as Rec[]).filter((x) => x.alunno_id === AL)
      expect(righe).toHaveLength(1)
      expect(righe[0].conferma).not.toBe('confermato')
    })
  })
})

describe('archiviare chiude le frequenze degli anni aperti', () => {
  const attore = { id: UT, role: 'admin' } as never

  prova('un bambino con la conferma aperta: frequenza ritirata, voce tolta', async () => {
    await inRollback(async () => {
      const { nuova, voce } = await confermato()
      const c = await chiudiFrequenzeAperte(clienteSuPglite(db) as never, { alunnoId: AL, attore })
      expect(c).toMatchObject({ chiuse: 1, voci_tolte: 1, voci_pagate_rimaste: 0, non_riuscite: 0 })
      expect((await freq(nuova)).stato).toBe('ritirato')
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [voce])).toBe(0)
    })
  })

  prova('con la quota pagata la voce resta e il conteggio lo dice; rifatta non cambia nulla', async () => {
    await inRollback(async () => {
      const { nuova, voce } = await confermato()
      await db.query(`INSERT INTO public.incassi (pagamento_id) VALUES ($1)`, [voce])
      const c = await chiudiFrequenzeAperte(clienteSuPglite(db) as never, { alunnoId: AL, attore })
      expect(c).toMatchObject({ chiuse: 1, voci_tolte: 0, voci_pagate_rimaste: 1 })
      expect((await freq(nuova)).stato).toBe('ritirato')
      const di_nuovo = await chiudiFrequenzeAperte(clienteSuPglite(db) as never, { alunnoId: AL, attore })
      expect(di_nuovo).toMatchObject({ chiuse: 0, voci_pagate_rimaste: 1 })
    })
  })

  prova('un bambino in_arrivo (iscrizione da domanda) ha la sua frequenza chiusa e la voce tolta', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL2, 'in_arrivo')
      const anno = await apri()
      const reg = await una<Rec>(`SELECT public.anno_registra_frequenza($1, $2, 'nuova', 'domanda', NULL, NULL, NULL, NULL, $3)`, [AL2, anno, UT])
      expect(reg.quota).toBe('creata')
      const c = await chiudiFrequenzeAperte(clienteSuPglite(db) as never, { alunnoId: AL2, attore })
      expect(c).toMatchObject({ chiuse: 1, voci_tolte: 1 })
      expect((await freq(reg.frequenza_id as string)).stato).toBe('ritirato')
    })
  })

  prova('un bambino senza frequenze in anni aperti: niente da fare', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await apri()
      expect(await chiudiFrequenzeAperte(clienteSuPglite(db) as never, { alunnoId: AL, attore })).toEqual({ chiuse: 0, voci_tolte: 0, voci_pagate_rimaste: 0, non_riuscite: 0 })
    })
  })
})

describe('una scheda archiviata o anonimizzata non riceve una voce nuova (minore 4.5.5)', () => {
  for (const colonna of ['archiviato_il', 'anonimizzato_il']) {
    prova(`${colonna}: la frequenza nasce, la voce no, e l'esito lo dice`, async () => {
      await inRollback(async () => {
        await giorni()
        await nuovoAlunno(AL2, 'in_arrivo')
        await db.query(`UPDATE public.alunni SET ${colonna} = now() WHERE id = $1`, [AL2])
        const anno = await apri()
        const reg = await una<Rec>(`SELECT public.anno_registra_frequenza($1, $2, 'nuova', 'domanda', NULL, NULL, NULL, NULL, $3)`, [AL2, anno, UT])
        expect(reg.quota).toBe('scheda_archiviata')
        expect(reg.pagamento_id).toBeNull()
        expect(await conta(`SELECT 1 FROM public.pagamenti WHERE alunno_id = $1`, [AL2])).toBe(0)
      })
    })
  }
})
