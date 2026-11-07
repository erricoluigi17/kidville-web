import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, creaAnniFissi, applicaPr2, SCHEMA_PR2 } from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.1 · IL RAPPORTO DI RICONCILIAZIONE (migrazione M1, `_anno_strumenti.sql`).
 *
 * `anno_fotografa(fase)` conta righe, euro e casi ambigui per tabella, sede e anno; `anno_riconciliazione_differenze()`
 * dice dove `prima` e `dopo` non tornano (`dopo − prima − nuove <> 0`). `anno_riempi()` nasce nel Compito 2.2: qui
 * il riempimento è l'`UPDATE … SET anno_id = anno_id` sotto l'interruttore `anno_scolastico.riempimento` (il punto
 * (c) del Compito 2.0), che è proprio ciò che farà `anno_riempi()`.
 *
 * Il test è SEQUENZIALE: il seme nasce con il trigger dell'anno spento (come il database di oggi, senza `anno_id`),
 * i primi test fotografano quello stato, uno riempie, i successivi leggono il database riempito, gli ultimi
 * mutano le voci per vedere il rosso. Date FISSE (2025/26-2027/28), mai oggi; solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const ALUNNI = [1, 2, 3, 4, 5].map((n) => `44444444-4444-4444-8444-44444444444${n}`)
const ALUNNO_SENZA_SEDE = '44444444-4444-4444-8444-444444444499'

/** Le tabelle che la PR 2 tocca ma che il registro della PR 1 non ha ancora nello schema di prova. */
const SCHEMA_RICONCILIAZIONE = `
  ALTER TABLE public.schools ADD COLUMN retta_default_importo numeric(10,2);
  CREATE TABLE public.incassi (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
    importo numeric(10,2) NOT NULL,
    data_incasso date NOT NULL DEFAULT CURRENT_DATE,
    creato_il timestamptz DEFAULT now()
  );
  CREATE TABLE public.alunni_classi_storico (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid NOT NULL,
    scuola_id uuid,
    dal date NOT NULL,
    al date
  );
  -- una madre SENZA colonna di creazione propria (come in produzione): le righe nuove non si distinguono dalle perse
  CREATE TABLE public.avvisi_risposte (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    avviso_id uuid NOT NULL REFERENCES public.avvisi(id) ON DELETE CASCADE,
    parent_id uuid NOT NULL,
    student_id uuid NOT NULL,
    risposto_il timestamptz
  );
  -- nasce senza sede (src/app/api/forms/send-otp/route.ts): la scuola_id è nullable
  CREATE TABLE public.form_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    signed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`

let db: PGlite
let A2627: string
let SEZ: string
let P2: string
let AS2627: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
async function foto(fase: string, tabelle: string[] | null = null): Promise<number> {
  return Number(await una<string | number>(`SELECT public.anno_fotografa($1, $2)`, [fase, tabelle]))
}
/** La somma di una voce nell'ultima fotografia della fase (le righe del test sono dopo `DELETE` del rapporto). */
async function voce(v: string, o: { fase?: string; tabella?: string; sede?: string } = {}): Promise<number> {
  return await una<number>(
    `SELECT coalesce(sum(valore), 0)::float8 FROM public.riconciliazione_anno
      WHERE fase = $1 AND voce = $2 AND ($3::text IS NULL OR tabella = $3) AND ($4::uuid IS NULL OR scuola_id = $4)`,
    [o.fase ?? 'prima', v, o.tabella ?? null, o.sede ?? null])
}
async function differenze() {
  return (await db.query<{ tabella: string; scuola_id: string | null; voce: string; prima: number; dopo: number; nuove: number }>(
    `SELECT tabella, scuola_id, voce, prima::float8 AS prima, dopo::float8 AS dopo, nuove::float8 AS nuove
       FROM public.anno_riconciliazione_differenze()`)).rows
}
async function come(ruolo: string, sql: string, params: unknown[] = []): Promise<string> {
  await db.exec(`SET ROLE ${ruolo}`)
  try { await db.query(sql, params); return 'ok' } catch (e) { return (e as Error).message } finally { await db.exec('RESET ROLE') }
}

beforeAll(async () => {
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [S1], codaPrima: SCHEMA_PR2 + SCHEMA_RICONCILIAZIONE })
  await creaAnniFissi(db, [S1])
  await applicaPr2(db, 'M1')
  // Lo specchio alunni → frequenze (2.3) non è l'oggetto di questo file: il seme degli alunni nasce senza frequenze.
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
  await db.query(`SELECT public.anni_sede_crea_successivo($1, DATE '2026-11-06')`, [S1])
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  AS2627 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, A2627])

  SEZ = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
  await db.query(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Margherite')`, [S1])
  for (const a of ALUNNI) await db.query(`INSERT INTO public.alunni (id, scuola_id, section_id) VALUES ($1, $2, $3)`, [a, S1, SEZ])

  // Il seme nasce COME OGGI, senza `anno_id`: il trigger generico è spento finché non è tutto al suo posto.
  const spente = ['pagamenti', 'presenze', 'enrollment_submissions', 'avvisi']
  for (const t of spente) await db.exec(`ALTER TABLE public.${t} DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)

  // 3 voci: 150.00 pagata per intero, 150.00 non pagata, 99.90 pagata a metà (senza competenza: l'anno viene dalla scadenza)
  const voci = [
    ['2026-10-05', '2026-10-01', 150.0, 150.0],
    ['2026-11-05', '2026-11-01', 150.0, 0.0],
    ['2026-12-05', null, 99.9, 49.95],
  ] as const
  const ids: string[] = []
  for (const [scad, comp, imp, pag] of voci) {
    ids.push(await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, importo_pagato, scadenza, periodo_competenza, creato_il)
       VALUES ($1, 'voce di prova', $2, $3, $4, $5, TIMESTAMPTZ '2026-10-01 10:00:00+00') RETURNING id`,
      [S1, imp, pag, scad, comp]))
  }
  P2 = ids[1]
  await db.query(`INSERT INTO public.incassi (pagamento_id, importo) VALUES ($1, 100.00), ($2, 50.00)`, [ids[0], ids[1]])

  // 4 presenze: 3 nel 2026/27 e una del 10 luglio 2026 (2025/26) con la sezione del 2026/27
  for (const g of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-07-10']) {
    await db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, section_id, data) VALUES ($1, $2, $3, $4)`,
      [ALUNNI[0], S1, SEZ, g])
  }
  // 3 domande: prima del 1 settembre, fra il 1 e il 15, dopo il 15
  for (const g of ['2026-08-20', '2026-09-10', '2026-09-20']) {
    await db.query(`INSERT INTO public.enrollment_submissions (scuola_id, created_at) VALUES ($1, $2::timestamptz)`,
      [S1, `${g}T10:00:00Z`])
  }
  // un avviso per una classe che esiste e uno per una che nessuna sezione ha
  await db.query(`INSERT INTO public.avvisi (scuola_id, target_classes) VALUES ($1, '{Girasoli}'), ($1, '{Inesistente}')`, [S1])
  // lo storico dei primi quattro alunni (il quinto non ne ha); il primo inizia prima del 01/09
  for (let i = 0; i < 4; i++) {
    await db.query(`INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, dal) VALUES ($1, $2, $3)`,
      [ALUNNI[i], S1, i === 0 ? '2026-07-01' : '2026-09-01'])
  }

  for (const t of spente) await db.exec(`ALTER TABLE public.${t} ENABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.exec('DELETE FROM public.riconciliazione_anno') })

describe('anno_fotografa · lo stato di OGGI, prima del riempimento', () => {
  it('pagamenti: righe, euro e incassi per la sede', async () => {
    expect(await foto('prima')).toBeGreaterThan(0)
    expect(await voce('righe', { tabella: 'pagamenti', sede: S1 })).toBe(3)
    expect(await voce('euro_importo', { tabella: 'pagamenti', sede: S1 })).toBe(399.9)
    expect(await voce('euro_importo_pagato', { tabella: 'pagamenti', sede: S1 })).toBe(199.95)
    expect(await voce('euro_incassi', { sede: S1 })).toBe(150)
    // nessuna voce ha ancora l'anno
    expect(await voce('righe_senza_anno', { tabella: 'pagamenti', sede: S1 })).toBe(3)
    expect(await voce('righe_per_anno', { tabella: 'pagamenti' })).toBe(0)
  })

  it('"alunni senza frequenza": i 5 alunni con sede non ne hanno ancora una', async () => {
    await foto('prima')
    expect(await voce('alunni_senza_frequenza', { tabella: 'alunni', sede: S1 })).toBe(5)
  })

  it('fase sbagliata → FASE_NON_VALIDA, e non scrive niente', async () => {
    expect(await messaggio(db.query(`SELECT public.anno_fotografa('boh')`))).toBe('FASE_NON_VALIDA')
    expect(await messaggio(db.query(`SELECT public.anno_fotografa(NULL)`))).toBe('FASE_NON_VALIDA')
    expect(await una<number>(`SELECT count(*)::int FROM public.riconciliazione_anno`)).toBe(0)
  })

  it('m-1: due fotografie nella STESSA transazione hanno istanti diversi (la durata del riempimento si misura da qui)', async () => {
    await db.exec('BEGIN')
    try {
      await foto('prima', ['presenze'])
      await foto('dopo', ['presenze'])
      const r = (await db.query<{ stessa: boolean; ordinate: boolean }>(
        `SELECT count(DISTINCT transazione) = 1 AS stessa,
                min(eseguita_il) FILTER (WHERE fase = 'prima') < min(eseguita_il) FILTER (WHERE fase = 'dopo') AS ordinate
           FROM public.riconciliazione_anno WHERE tabella = 'presenze'`)).rows[0]
      expect(r.stessa).toBe(true)
      expect(r.ordinate).toBe(true)
    } finally { await db.exec('ROLLBACK') }
  })

  it('con un elenco di tabelle scrive solo quelle', async () => {
    await foto('prima', ['presenze'])
    const t = (await db.query<{ tabella: string }>(`SELECT DISTINCT tabella FROM public.riconciliazione_anno`)).rows
    expect(t.map((x) => x.tabella)).toEqual(['presenze'])
    expect(await voce('righe', { tabella: 'presenze' })).toBe(4)
  })

  it('la sede non ricavabile si conta: una scheda di form_submissions nata senza scuola_id', async () => {
    // Controlli morbidi: la riga passa e resta senza anno. (Che a controlli RIGIDI il trigger non alzi GIORNO_SENZA_ANNO
    // su una tabella `sede_facoltativa` non è ancora scritto nel trigger: vedi il rapporto del Compito 2.1.)
    await db.query(`INSERT INTO public.form_submissions (scuola_id, created_at) VALUES (NULL, TIMESTAMPTZ '2026-10-05 10:00:00+00')`)
    await foto('prima', ['form_submissions'])
    expect(await voce('righe_senza_sede', { tabella: 'form_submissions' })).toBe(1)
    expect(await voce('righe_senza_anno', { tabella: 'form_submissions' })).toBe(1)
    await db.exec(`DELETE FROM public.form_submissions`)
  })
})

describe('il riempimento (UPDATE … SET anno_id = anno_id, come farà anno_riempi) e la fotografia dopo', () => {
  it('righe_per_anno somma a 3 su pagamenti, righe_senza_anno è 0, la fotografia dopo è uguale e le differenze sono vuote', async () => {
    await foto('prima')
    await db.exec(`
      BEGIN;
      SELECT set_config('anno_scolastico.riempimento', 'on', true);
      UPDATE public.pagamenti SET anno_id = anno_id WHERE anno_id IS NULL;
      UPDATE public.presenze SET anno_id = anno_id WHERE anno_id IS NULL;
      UPDATE public.enrollment_submissions SET anno_id = anno_id WHERE anno_id IS NULL;
      UPDATE public.avvisi SET anno_id = anno_id WHERE anno_id IS NULL;
      COMMIT;`)
    await foto('dopo')
    expect(await voce('righe_per_anno', { fase: 'dopo', tabella: 'pagamenti', sede: S1 })).toBe(3)
    expect(await voce('righe_senza_anno', { fase: 'dopo', tabella: 'pagamenti' })).toBe(0)
    for (const v of ['righe', 'euro_importo', 'euro_importo_pagato']) {
      expect(await voce(v, { fase: 'dopo', tabella: 'pagamenti', sede: S1 })).toBe(await voce(v, { fase: 'prima', tabella: 'pagamenti', sede: S1 }))
    }
    expect(await voce('righe_nuove', { fase: 'dopo', tabella: 'pagamenti' })).toBe(0)
    expect(await differenze()).toEqual([])
  })

  it('i "recuperi" delle frequenze e gli alunni senza frequenza', async () => {
    // le frequenze del passato (origine = recupero) le semina il riempimento vero; qui a mano, una per alunno
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, origine, stato, data_ingresso, data_uscita, retta_mensile)
         VALUES ($1, $2, 'recupero', 'iscritto', DATE '2026-09-01', $3, $4)`,
        [ALUNNI[i], AS2627, i === 1 ? '2026-09-01' : null, i === 4 ? null : 300])
    }
    // un alunno senza sede: non conta come «senza frequenza»
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, NULL)`, [ALUNNO_SENZA_SEDE])
    await foto('dopo')
    expect(await voce('recuperi', { fase: 'dopo', tabella: 'frequenze' })).toBe(5)
    expect(await voce('alunni_senza_frequenza', { fase: 'dopo', tabella: 'alunni' })).toBe(0)
    expect(await voce('ambiguo:alunni_senza_sede', { fase: 'dopo', tabella: 'alunni' })).toBe(1)
  })
})

describe('i casi ambigui, sul database riempito', () => {
  beforeEach(async () => { await foto('dopo') })

  it('pagamenti: la strada dell\'anno (competenza 2, scadenza 1, creazione 0)', async () => {
    expect(await voce('ambiguo:via_competenza', { fase: 'dopo' })).toBe(2)
    expect(await voce('ambiguo:via_scadenza', { fase: 'dopo' })).toBe(1)
    expect(await voce('ambiguo:via_creazione', { fase: 'dopo' })).toBe(0)
  })

  it('una presenza del 10 luglio 2026 con la sezione del 2026/27 → sezione_altro_anno:presenze = 1', async () => {
    expect(await voce('ambiguo:sezione_altro_anno:presenze', { fase: 'dopo' })).toBe(1)
  })

  it('domande: una dopo il 15/09 (20 settembre) e una prima del 1/09 (20 agosto)', async () => {
    expect(await voce('ambiguo:domande_dopo_15_09', { fase: 'dopo' })).toBe(1)
    expect(await voce('ambiguo:domande_prima_1_09', { fase: 'dopo' })).toBe(1)
  })

  it('un avviso con target_classes {Inesistente} → nomi_classe_non_abbinati:avvisi = 1 (Girasoli si abbina)', async () => {
    expect(await voce('ambiguo:nomi_classe_non_abbinati:avvisi', { fase: 'dopo' })).toBe(1)
  })

  it('frequenze: la retta dal listino, il 150 di default, l\'ingresso e l\'uscita portati a inizio anno', async () => {
    expect(await voce('ambiguo:retta_da_listino', { fase: 'dopo' })).toBe(1)
    // la sede di prova non ha `retta_default_importo`: tutte e 5 le frequenze ricadono sul 150
    expect(await voce('ambiguo:retta_default_assente_150', { fase: 'dopo' })).toBe(5)
    // il primo alunno ha lo storico dal 01/07 e la frequenza dal 01/09; il secondo esce lo stesso giorno in cui entra
    expect(await voce('ambiguo:ingresso_portato_a_inizio_anno', { fase: 'dopo' })).toBe(1)
    expect(await voce('ambiguo:uscita_portata_a_inizio_anno', { fase: 'dopo' })).toBe(1)
  })

  it('alunni senza storico (il quinto) e senza sede', async () => {
    expect(await voce('ambiguo:alunni_senza_storico', { fase: 'dopo' })).toBe(1)
    expect(await voce('ambiguo:alunni_senza_sede', { fase: 'dopo' })).toBe(1)
  })

  it('pagamenti_anno_successivo: una competenza oltre la fine dell\'ultimo anno della sede (2027/28 finisce il 31/08/2028)', async () => {
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza, creato_il)
       VALUES ($1, 'voce oltre', 10, DATE '2028-09-05', DATE '2028-09-01', TIMESTAMPTZ '2026-10-01 10:00:00+00') RETURNING id`, [S1])
    await db.exec('DELETE FROM public.riconciliazione_anno')
    await foto('dopo', ['pagamenti'])
    expect(await voce('ambiguo:pagamenti_anno_successivo', { fase: 'dopo' })).toBe(1)
    await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [id])
  })

  it('pagamenti_anno_diverso_da_scadenza: una quota 2027/28 con scadenza 15/02/2027 è legittima, ma si conta', async () => {
    const a2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, anno_id, creato_il)
       VALUES ($1, 'quota prossimo anno', 10, DATE '2027-02-15', $2, TIMESTAMPTZ '2026-10-01 10:00:00+00') RETURNING id`, [S1, a2728])
    await db.exec('DELETE FROM public.riconciliazione_anno')
    await foto('dopo', ['pagamenti'])
    expect(await voce('ambiguo:pagamenti_anno_diverso_da_scadenza', { fase: 'dopo' })).toBe(1)
    // le voci normali (anno = quello della scadenza) non contano
    await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [id])
    await db.exec('DELETE FROM public.riconciliazione_anno')
    await foto('dopo', ['pagamenti'])
    expect(await voce('ambiguo:pagamenti_anno_diverso_da_scadenza', { fase: 'dopo' })).toBe(0)
  })

  it('crm_non_indicato conta le schede con anno_ingresso = non_indicato', async () => {
    await db.query(`INSERT INTO public.crm_bambini (scuola_id, anno_ingresso) VALUES ($1, 'non_indicato'), ($1, 'in_corso')`, [S1])
    await db.exec('DELETE FROM public.riconciliazione_anno')
    await foto('dopo', ['crm_bambini'])
    expect(await voce('ambiguo:crm_non_indicato', { fase: 'dopo' })).toBe(1)
  })
})

describe('anno_riconciliazione_differenze · il rosso apposta', () => {
  it('una voce cancellata fra prima e dopo → righe 3→2 ed euro_importo 399.90→249.90', async () => {
    await foto('prima')
    await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [P2])
    await foto('dopo')
    expect(await differenze()).toEqual([
      { tabella: 'pagamenti', scuola_id: S1, voce: 'euro_importo', prima: 399.9, dopo: 249.9, nuove: 0 },
      { tabella: 'pagamenti', scuola_id: S1, voce: 'righe', prima: 3, dopo: 2, nuove: 0 },
    ])
  })

  it('una voce creata dopo la prima fotografia → nuove = 1 e le differenze tornano vuote', async () => {
    // dopo il test di sopra le voci sono 2 (P1 e P3)
    await foto('prima')
    await db.query(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza, creato_il)
       VALUES ($1, 'voce nata dopo', 20.00, DATE '2026-12-10', DATE '2026-12-01', now() + interval '1 day')`, [S1])
    await foto('dopo')
    expect(await voce('righe_nuove', { fase: 'dopo', tabella: 'pagamenti', sede: S1 })).toBe(1)
    expect(await voce('euro_nuove', { fase: 'dopo', tabella: 'pagamenti', sede: S1 })).toBe(20)
    expect(await voce('righe', { fase: 'dopo', tabella: 'pagamenti', sede: S1 })).toBe(3)
    expect(await differenze()).toEqual([])
  })

  it('le tabelle che nascono vuote (frequenze) non compaiono mai, e una fase sola non basta a confrontare', async () => {
    await foto('prima')
    expect(await differenze()).toEqual([])        // nessun `dopo`: niente da confrontare
    await db.query(`INSERT INTO public.frequenze (alunno_id, anno_sede_id, origine, stato, data_ingresso)
                    VALUES ($1, $2, 'recupero', 'iscritto', DATE '2026-09-01')`, [ALUNNO_SENZA_SEDE, AS2627])
      .catch(() => undefined)
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'frequenze')).toEqual([])
  })
})

describe('anno_riconciliazione_differenze · le tabelle madre', () => {
  it('una madre svuotata fra prima e dopo (1 riga → 0) compare: righe 1→0', async () => {
    await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES (gen_random_uuid(), $1)`, [SEZ])
    await foto('prima')
    await db.exec(`DELETE FROM public.utenti_sezioni`)
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'utenti_sezioni')).toEqual([
      { tabella: 'utenti_sezioni', scuola_id: null, voce: 'righe', prima: 1, dopo: 0, nuove: 0 },
    ])
  })

  it('una madre riempita da zero (0 → 1) compare come differenza se la riga non e nuova', async () => {
    await foto('prima')
    // creato_il nel passato: la riga non conta come «nuova», quindi la differenza deve restare visibile
    await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id, creato_il) VALUES (gen_random_uuid(), $1, TIMESTAMPTZ '2026-01-01 00:00:00+00')`, [SEZ])
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'utenti_sezioni')).toEqual([
      { tabella: 'utenti_sezioni', scuola_id: null, voce: 'righe', prima: 0, dopo: 1, nuove: 0 },
    ])
    await db.exec(`DELETE FROM public.utenti_sezioni`)
  })

  it('una madre senza colonna di creazione (avvisi_risposte) non e confrontabile: nessun falso allarme, e il conteggio resta nel rapporto', async () => {
    const avviso = await una<string>(`SELECT id FROM public.avvisi LIMIT 1`)
    await foto('prima')
    await db.query(`INSERT INTO public.avvisi_risposte (avviso_id, parent_id, student_id) VALUES ($1, gen_random_uuid(), gen_random_uuid())`, [avviso])
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'avvisi_risposte')).toEqual([])
    expect(await voce('non_confrontabili', { fase: 'prima', tabella: 'avvisi_risposte' })).toBe(0)
    expect(await voce('non_confrontabili', { fase: 'dopo', tabella: 'avvisi_risposte' })).toBe(1)
    await db.exec(`DELETE FROM public.avvisi_risposte`)
  })

  it('una madre non confrontabile che PERDE righe (avvisi_risposte 2 → 1) compare; se ne guadagna (1 → 2) no', async () => {
    const avviso = await una<string>(`SELECT id FROM public.avvisi LIMIT 1`)
    const nuova = () => db.query(`INSERT INTO public.avvisi_risposte (avviso_id, parent_id, student_id) VALUES ($1, gen_random_uuid(), gen_random_uuid())`, [avviso])
    await db.exec(`DELETE FROM public.avvisi_risposte`)
    await nuova(); await nuova()
    await foto('prima')
    await db.exec(`DELETE FROM public.avvisi_risposte WHERE ctid = (SELECT ctid FROM public.avvisi_risposte LIMIT 1)`)
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'avvisi_risposte')).toEqual([
      { tabella: 'avvisi_risposte', scuola_id: null, voce: 'righe', prima: 2, dopo: 1, nuove: 0 },
    ])
    await db.exec('DELETE FROM public.riconciliazione_anno')
    await foto('prima')
    await nuova()
    await foto('dopo')
    expect((await differenze()).filter((d) => d.tabella === 'avvisi_risposte')).toEqual([])
    await db.exec(`DELETE FROM public.avvisi_risposte`)
  })

  it('le tabelle con una colonna di creazione non sono mai tra le non confrontabili', async () => {
    await foto('prima')
    const t = (await db.query<{ tabella: string }>(
      `SELECT DISTINCT tabella FROM public.riconciliazione_anno WHERE voce = 'non_confrontabili' ORDER BY 1`)).rows.map((x) => x.tabella)
    const senza = (await db.query<{ tabella: string }>(
      `SELECT tabella FROM public.anno_tabelle WHERE colonna_creazione IS NULL ORDER BY 1`)).rows.map((x) => x.tabella)
    expect(t).toEqual(senza)
  })
})

describe('da capo a fondo: fotografia prima → anno_riempi() → fotografia dopo', () => {
  it('con le frequenze create davvero dal riempimento le differenze sono vuote (recuperi = alunni con sede, nessun alunno senza frequenza)', async () => {
    const d = await creaDbAnno({ sediPrimaDellaMigrazione: [S1], codaPrima: SCHEMA_PR2 + SCHEMA_RICONCILIAZIONE })
    try {
      await creaAnniFissi(d, [S1])
      await applicaPr2(d, 'M1')
      await d.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
      for (const t of ['pagamenti', 'presenze', 'enrollment_submissions']) {
        await d.exec(`ALTER TABLE public.${t} DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      }
      for (const a of ALUNNI) await d.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [a, S1])
      await d.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, NULL)`, [ALUNNO_SENZA_SEDE])
      await d.query(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, importo_pagato, scadenza, periodo_competenza)
         VALUES ($1, 'a', 150, 150, DATE '2026-10-05', DATE '2026-10-01'), ($1, 'b', 99.90, 0, DATE '2026-12-05', NULL)`, [S1])
      await d.query(`INSERT INTO public.presenze (scuola_id, data) VALUES ($1, DATE '2026-10-05'), ($1, DATE '2026-07-10')`, [S1])
      await d.query(`INSERT INTO public.enrollment_submissions (scuola_id, created_at) VALUES ($1, TIMESTAMPTZ '2026-09-10 10:00:00+00')`, [S1])
      for (const t of ['pagamenti', 'presenze', 'enrollment_submissions']) {
        await d.exec(`ALTER TABLE public.${t} ENABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      }

      await d.query(`SELECT public.anno_fotografa('prima')`)
      await d.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`)
      await d.query(`SELECT public.anno_fotografa('dopo')`)

      const somma = async (fase: string, voce: string, tabella: string) => Number((await d.query<{ v: string }>(
        `SELECT coalesce(sum(valore), 0)::text AS v FROM public.riconciliazione_anno WHERE fase = $1 AND voce = $2 AND tabella = $3`,
        [fase, voce, tabella])).rows[0].v)
      expect((await d.query(`SELECT * FROM public.anno_riconciliazione_differenze()`)).rows).toEqual([])
      expect(await somma('prima', 'alunni_senza_frequenza', 'alunni')).toBe(5)
      expect(await somma('dopo', 'alunni_senza_frequenza', 'alunni')).toBe(0)
      expect(await somma('dopo', 'recuperi', 'frequenze')).toBe(5)
      expect(await somma('dopo', 'righe_senza_anno', 'pagamenti')).toBe(0)
      expect(await somma('dopo', 'euro_importo', 'pagamenti')).toBe(249.9)
    } finally { await d.close() }
  }, 60_000)
})

describe('sicurezza', () => {
  it('authenticated e anon non leggono il rapporto né eseguono le funzioni', async () => {
    for (const ruolo of ['authenticated', 'anon']) {
      expect(await come(ruolo, `SELECT count(*) FROM public.riconciliazione_anno`)).toMatch(/permission denied/)
      expect(await come(ruolo, `SELECT public.anno_fotografa('prima')`)).toMatch(/permission denied/)
      expect(await come(ruolo, `SELECT * FROM public.anno_riconciliazione_differenze()`)).toMatch(/permission denied/)
    }
  })

  it('service_role li usa', async () => {
    expect(await come('service_role', `SELECT public.anno_fotografa('prima', '{presenze}')`)).toBe('ok')
    expect(await come('service_role', `SELECT count(*) FROM public.riconciliazione_anno`)).toBe('ok')
    expect(await come('service_role', `SELECT * FROM public.anno_riconciliazione_differenze()`)).toBe('ok')
  })

  it('RLS accesa e nessuna policy', async () => {
    const r = await db.query<{ rls: boolean; policy: number }>(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy
         FROM pg_class c WHERE c.oid = 'public.riconciliazione_anno'::regclass`)
    expect(r.rows[0]).toEqual({ rls: true, policy: 0 })
  })

  it('il rapporto non contiene testo libero: voci e valori sono nomi di conteggio, mai un nome di persona o di classe', async () => {
    await foto('prima')
    const strani = await una<number>(
      `SELECT count(*)::int FROM public.riconciliazione_anno WHERE voce !~ '^[a-z0-9_:]+$' OR tabella !~ '^[a-z0-9_]+$'`)
    expect(strani).toBe(0)
    // 'Inesistente' / 'Girasoli' (i nomi di classe del seme) non compaiono in nessuna colonna di testo
    const nomi = await una<number>(
      `SELECT count(*)::int FROM public.riconciliazione_anno r WHERE r::text ILIKE '%Inesistente%' OR r::text ILIKE '%Girasoli%'`)
    expect(nomi).toBe(0)
  })
})
