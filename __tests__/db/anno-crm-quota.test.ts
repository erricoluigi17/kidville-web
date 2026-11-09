// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  applicaPr2, creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.9 · M45e · LA QUOTA DEL CRM SEGUE L'ANNO DELLA SCHEDA, in PGlite vero (le migrazioni si leggono dal disco).
 *
 * `crm_quota_passa` parte dall'ULTIMA definizione che c'è nelle migrazioni (quella di `20261031161800_crm_quota_e_settimane.sql`: la
 * prova la estrae dal file, non la riscrive) e M45e la ridefinisce con la stessa firma:
 *  · la competenza della voce è l'`inizio` dell'anno di sede della scheda (`anni_sede`), e la fine del periodo ne discende;
 *    `make_date(quota_anno, 9, 1)` resta solo come ripiego per una scheda senza anno (o senza la riga), con una riga di log `info`;
 *  · la descrizione viene da `anni_scolastici.etichetta_breve`;
 *  · dopo aver trovato o creato la voce, la frequenza dell'alunno nell'anno (se c'è e non ha ancora la quota) la riceve.
 *
 * Banco: la catena fino a M45c, la funzione di prima, poi M45e. Il banco non si tocca: le colonne di `crm_bambini`, di `pagamenti` e
 * la tabella `crm_eventi` che mancano si creano qui, in `codaPrima`. Si usa il bonifico, che non passa dalla cassa (la voce nasce
 * `da_pagare`, senza incasso): il resto di `crm_quota_passa` è provato altrove. Solo uuid finti, date FISSE (nessun `now()`).
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '22222222-2222-4222-8222-222222222223'
const UT = '55555555-5555-4555-8555-555555555551'
const SCHEDA = '66666666-6666-4666-8666-666666666661'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const OGGI_FISSO = '2027-02-10'

type Rec = Record<string, unknown>
let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`
const ANNO: Record<number, string> = {} // anni_scolastici.id

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 40_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/** La definizione di `crm_quota_passa` com'era prima di M45e: tagliata dal file, non riscritta. */
function funzioneDiPrima(): string {
  const cartella = join(process.cwd(), 'supabase/migrations')
  const f = readdirSync(cartella).find((x) => x.endsWith('_crm_quota_e_settimane.sql'))
  if (!f) throw new Error('manca supabase/migrations/*_crm_quota_e_settimane.sql')
  const testo = readFileSync(join(cartella, f), 'utf8')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.crm_quota_passa(')
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('crm_quota_passa non trovata nella migrazione del CRM')
  return testo.slice(inizio, fine + 'END $$;'.length)
}

async function nuovoAlunno(id: string, sede = S1) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'iscritto')`, [id, sede])
}
/** Un bambino del CRM con la quota segnata in bonifico e in attesa dell'alunno (o già col suo alunno). */
async function nuovoBambino(o: { id?: string; alunno?: string | null; annoId?: string | null; quotaAnno?: number; sede?: string } = {}) {
  await db.query(
    `INSERT INTO public.crm_bambini (id, scuola_id, scheda_id, nome, anno_ingresso, anno_id, alunno_id,
        quota_importo, quota_metodo, quota_anno, quota_stato, quota_saldata_il, quota_segnata_da)
     VALUES ($1, $2, $3, 'Bimbo Prova', 'prossimo', $4, $5, 120, 'bonifico', $6, 'in_attesa', DATE '2027-02-01', $7)`,
    [o.id ?? B, o.sede ?? S1, SCHEDA, o.annoId === undefined ? ANNO[2027] : o.annoId, o.alunno === undefined ? AL : o.alunno,
      o.quotaAnno ?? 2027, UT])
}
const passa = (bambino = B) => una<Rec>(`SELECT public.crm_quota_passa($1::uuid, $2::uuid)`, [bambino, UT])
const voce = (id: string) => una<Rec>(`SELECT to_jsonb(p) FROM public.pagamenti p WHERE p.id = $1`, [id])
const voci = (alunno: string) => una<number>(`SELECT count(*)::int FROM public.pagamenti WHERE alunno_id = $1`, [alunno])
const categoriaIscrizione = () => una<string>(`SELECT id FROM public.payment_categories WHERE slug = 'iscrizione' AND is_sistema AND scuola_id IS NULL`)
const frequenza = (id: string) => una<Rec>(`SELECT to_jsonb(f) FROM public.frequenze f WHERE f.id = $1`, [id])
const inizio27 = () => una<string>(`SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [ANNO_SEDE[`${S1}:2027`]])

/** Le due quote e un modulo per lista, e l'apertura delle iscrizioni del 2027/28 di S1: il minimo perché una frequenza possa esistere. */
async function apri(): Promise<string> {
  const a = ANNO_SEDE[`${S1}:2027`]
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
  return a
}
/** Una frequenza del 2027/28 scritta a mano, SENZA voce. */
async function frequenzaCruda(alunno: string, tipo: 'conferma' | 'nuova' = 'nuova'): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, stato, data_ingresso)
     SELECT $1, s.id, $2, 'segreteria', 'in_attesa', s.inizio FROM public.anni_sede s WHERE s.id = $3 RETURNING id`,
    [alunno, tipo, ANNO_SEDE[`${S1}:2027`]])
}
/** Una voce «Iscrizione» dell'alunno, con la competenza data (o nessuna) e la scadenza data. */
async function voceIscrizione(alunno: string, competenza: string | null, scadenza = '2028-03-01'): Promise<string> {
  return una<string>(
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza, obbligatorio, tipo)
     VALUES ($1, $2, 'Iscrizione di prova', 120, $3, $4, $5, true, 'singolo') RETURNING id`,
    [alunno, S1, scadenza, await categoriaIscrizione(), competenza])
}
/** La sede sposta il confine fra il 2026/27 e il 2027/28 (nella stessa transazione, il vincolo è differito). */
async function spostaConfine27(nuovoInizio: string, ultimoGiornoPrima: string) {
  await db.query(`UPDATE public.anni_sede SET fine = $2 WHERE id = $1`, [ANNO_SEDE[`${S1}:2026`], ultimoGiornoPrima])
  await db.query(`UPDATE public.anni_sede SET inizio = $2 WHERE id = $1`, [ANNO_SEDE[`${S1}:2027`], nuovoInizio])
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M45c', completo: true,
    codaPrima: SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN anonimizzato_il timestamptz;
      -- le colonne di \`pagamenti\` che la voce della quota scrive (come \`crm_quota_passa\`) e il banco minimo non ha
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid,
        ADD COLUMN sconto numeric(10,2);
      -- le colonne di \`crm_bambini\` che la funzione legge e scrive (il banco ne ha solo il minimo per l'anno)
      ALTER TABLE public.crm_bambini
        ADD COLUMN scheda_id uuid,
        ADD COLUMN nome text,
        ADD COLUMN alunno_id uuid UNIQUE,
        ADD COLUMN quota_importo numeric(10,2),
        ADD COLUMN quota_metodo text,
        ADD COLUMN quota_stato text,
        ADD COLUMN quota_blocco_motivo text,
        ADD COLUMN quota_saldata_il date,
        ADD COLUMN quota_cassa_movimento_id uuid,
        ADD COLUMN quota_segnata_da uuid,
        ADD COLUMN aggiornata_il timestamptz;
      CREATE TABLE public.crm_eventi (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id uuid NOT NULL,
        scheda_id uuid NOT NULL,
        tipo text NOT NULL,
        autore uuid,
        autore_via text,
        dati jsonb,
        creato_il timestamptz NOT NULL DEFAULT now()
      );
    `,
  })
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  // La funzione di prima (quella che c'è in produzione), poi M45e che la ridefinisce.
  await db.exec(funzioneDiPrima())
  await applicaPr2(db, 'M45e')
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string; anno_id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) {
    ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
    ANNO[x.anno_inizio] = x.anno_id
  }
}, 120_000)
afterAll(async () => { await db?.close() })

describe('crm_quota_passa: la competenza è l’inizio dell’anno di sede della scheda', () => {
  prova('la voce nasce con la competenza dell’inizio dell’anno di sede, anche se la sede lo ha spostato', async () => {
    await inRollback(async () => {
      await spostaConfine27('2027-08-25', '2027-08-24')
      await nuovoAlunno(AL)
      await nuovoBambino()
      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', voce_nuova: true })
      const v = await voce(r.pagamento_id as string)
      expect(v.periodo_competenza).toBe('2027-08-25')
      expect(v.descrizione).toBe('Iscrizione 2027/28')
      expect(v.periodo_competenza).not.toBe('2027-09-01')
    })
  })

  prova('senza spostamenti la competenza è l’inizio dell’anno, e la descrizione l’etichetta breve dell’anno', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await nuovoBambino()
      const v = await voce(((await passa()).pagamento_id) as string)
      expect(v.periodo_competenza).toBe(await inizio27())
      expect(v.descrizione).toBe('Iscrizione 2027/28')
    })
  })

  prova('l’anno è quello della scheda (anno_id), non quello che dice `quota_anno`', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      // la scheda dice 2027 con `anno_id`; il vecchio numero è rimasto indietro: vale l'anno della scheda
      await nuovoBambino({ annoId: ANNO[2027], quotaAnno: 2026 })
      const v = await voce(((await passa()).pagamento_id) as string)
      expect(v.periodo_competenza).toBe(await inizio27())
      expect(v.descrizione).toBe('Iscrizione 2027/28')
    })
  })

  prova('una voce senza competenza con la scadenza dentro il periodo di sede (anche prima del 1° settembre) è quella dell’anno', async () => {
    await inRollback(async () => {
      await spostaConfine27('2027-08-25', '2027-08-24')
      await nuovoAlunno(AL)
      await nuovoBambino()
      const esistente = await voceIscrizione(AL, null, '2027-08-30')
      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', pagamento_id: esistente, voce_nuova: false })
      expect(await voci(AL)).toBe(1)
    })
  })

  prova('una scheda senza `anno_id` (le vecchie, o il database senza lo schema dell’anno) ripiega su `make_date(quota_anno, 9, 1)` e lascia una riga di log `info`', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await nuovoBambino({ annoId: ANNO[2027], quotaAnno: 2027 })
      // una riga di prima dello schema dell'anno: i trigger del registro riassegnerebbero l'anno, qui si spengono per la prova
      // (in produzione `anno_id` è NOT NULL e ha la chiave esterna verso la sede: il ripiego serve al database non migrato)
      await db.exec(`ALTER TABLE public.crm_bambini DISABLE TRIGGER USER; ALTER TABLE public.crm_bambini ALTER COLUMN anno_id DROP NOT NULL`)
      await db.query(`UPDATE public.crm_bambini SET anno_id = NULL WHERE id = $1`, [B])
      expect(await una<string | null>(`SELECT anno_id FROM public.crm_bambini WHERE id = $1`, [B])).toBeNull()
      expect(await una<number>(`SELECT count(*)::int FROM public.app_log WHERE fingerprint LIKE 'crm-quota-anno-di-riserva%'`)).toBe(0)
      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', voce_nuova: true })
      const v = await voce(r.pagamento_id as string)
      expect(v.periodo_competenza).toBe('2027-09-01')
      expect(v.descrizione).toBe('Iscrizione 2027/28')
      const log = await db.query<Rec>(`SELECT livello, contesto FROM public.app_log WHERE fingerprint LIKE 'crm-quota-anno-di-riserva%'`)
      expect(log.rows).toHaveLength(1)
      expect(log.rows[0]).toMatchObject({ livello: 'info' })
      // nel log solo uuid e codici: mai il nome del bambino
      expect(JSON.stringify(log.rows[0].contesto)).not.toContain('Bimbo Prova')
    })
  })
})

describe('crm_quota_passa: la frequenza dell’anno riceve la voce', () => {
  prova('una voce già creata dalla conferma per lo stesso anno viene COLLEGATA, non duplicata', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await apri()
      const f = await frequenzaCruda(AL, 'conferma')
      // la voce che la conferma (4.5.5) ha creato e legato alla frequenza
      const q = await una<Rec>(`SELECT public.anno_quota_voce($1::uuid, $2::uuid, DATE '${OGGI_FISSO}')`, [f, UT])
      expect(q.esito).toBe('creata')
      expect(await voci(AL)).toBe(1)

      await nuovoBambino()
      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', pagamento_id: q.pagamento_id, voce_nuova: false })
      expect(await voci(AL), 'la voce non si duplica').toBe(1)
      expect((await frequenza(f)).quota_pagamento_id).toBe(q.pagamento_id)
    })
  })

  prova('una voce che il CRM trova (non legata a nessuna frequenza) viene collegata alla frequenza dell’anno', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await apri()
      const f = await frequenzaCruda(AL)
      const esistente = await voceIscrizione(AL, await inizio27())
      expect((await frequenza(f)).quota_pagamento_id).toBeNull()
      await nuovoBambino()

      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', pagamento_id: esistente, voce_nuova: false })
      expect((await frequenza(f)).quota_pagamento_id).toBe(esistente)
    })
  })

  prova('la voce che il CRM crea riceve la frequenza dell’anno e, pagata, la frequenza ha `quota_saldata`', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await apri()
      const f = await frequenzaCruda(AL)
      await nuovoBambino()
      const r = await passa()
      expect(r).toMatchObject({ esito: 'ok', voce_nuova: true })
      expect((await frequenza(f)).quota_pagamento_id).toBe(r.pagamento_id)
      expect((await frequenza(f)).quota_saldata).toBe(false)

      await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = importo WHERE id = $1`, [r.pagamento_id])
      expect((await frequenza(f)).quota_saldata).toBe(true)
    })
  })

  prova('una frequenza che ha già un’altra voce non si tocca; senza frequenza dell’anno la quota passa lo stesso', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      await apri()
      const f = await frequenzaCruda(AL)
      const altra = await voceIscrizione(AL, null, '2027-03-01') // dentro il 2026/27: non è la voce del 2027/28
      await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [f, altra])
      await nuovoBambino()
      const r = await passa()
      expect(r.esito).toBe('ok')
      expect((await frequenza(f)).quota_pagamento_id, 'la voce che la frequenza aveva resta sua').toBe(altra)

      // il secondo bambino non ha nessuna frequenza nel 2027/28: la quota passa e nessuna frequenza si inventa
      await nuovoBambino({ id: B2, alunno: AL2 })
      const r2 = await passa(B2)
      expect(r2).toMatchObject({ esito: 'ok', voce_nuova: true })
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1`, [AL2])).toBe(1) // solo lo specchio dell'anno attivo
    })
  })

  prova('due voci per lo stesso alunno e anno: `bloccata` / `piu_voci` come oggi, e la frequenza non riceve niente', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL)
      await apri()
      const f = await frequenzaCruda(AL)
      await voceIscrizione(AL, await inizio27())
      await voceIscrizione(AL, await inizio27())
      await nuovoBambino()
      const r = await passa()
      expect(r).toMatchObject({ esito: 'bloccata', motivo: 'piu_voci' })
      expect(await una<string>(`SELECT quota_stato FROM public.crm_bambini WHERE id = $1`, [B])).toBe('bloccata')
      expect((await frequenza(f)).quota_pagamento_id).toBeNull()
      expect(await voci(AL)).toBe(2)
    })
  })
})

describe('crm_quota_passa: ciò che non cambia', () => {
  prova('la firma è la stessa e solo service_role la esegue', async () => {
    expect(await una<number>(
      `SELECT count(*)::int FROM pg_proc WHERE proname = 'crm_quota_passa' AND pronamespace = 'public'::regnamespace`)).toBe(1)
    expect(await una<boolean>(`SELECT has_function_privilege('service_role', 'public.crm_quota_passa(uuid, uuid)', 'EXECUTE')`)).toBe(true)
    expect(await una<boolean>(`SELECT has_function_privilege('authenticated', 'public.crm_quota_passa(uuid, uuid)', 'EXECUTE')`)).toBe(false)
    expect(await una<boolean>(`SELECT has_function_privilege('anon', 'public.crm_quota_passa(uuid, uuid)', 'EXECUTE')`)).toBe(false)
  })

  prova('bambino inesistente, quota non pronta, già in contabilità, alunno di un’altra sede: gli esiti di sempre', async () => {
    await inRollback(async () => {
      expect(await passa('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9')).toMatchObject({ esito: 'non_trovato' })
      await nuovoAlunno(AL, S2) // alunno della sede S2, bambino della sede S1
      await nuovoBambino()
      expect(await passa()).toMatchObject({ esito: 'sede_diversa' })
      await db.query(`UPDATE public.crm_bambini SET alunno_id = NULL WHERE id = $1`, [B])
      expect(await passa()).toMatchObject({ esito: 'non_pronta' })
    })
  })
})
