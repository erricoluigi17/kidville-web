import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-2 (c) · LE ESENZIONI DELLA GUARDIA (migrazione M3), con la guardia ACCESA nel seme.
 *
 * Le colonne che la guardia lascia cambiare senza gettone (`anno_colonne_esenti`) e le tabelle con una guardia
 * ridotta (`anno_tabelle.guardia`: `nessuna`, `solo_contenuto`). Ogni colonna esente si prova DA SOLA, e per ogni
 * tabella c'è la colonna NON esente che resta guardata. Date fisse (2025/26 chiuso, 2026/27 corrente); solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '44444444-4444-4444-8444-444444444441'
const GIORNO_CHIUSO = '2026-03-10'

/** Le tabelle del registro che lo schema di prova non ha: nascono PRIMA della migrazione, che le trova con `to_regclass`. */
const CODA_PRIMA = `
  ALTER TABLE public.chat_messages ADD COLUMN content text, ADD COLUMN read_at timestamptz, ADD COLUMN delivered_at timestamptz;
  ALTER TABLE public.avvisi ADD COLUMN titolo text;
  ALTER TABLE public.galleria_media_v2 ADD COLUMN caption text;
  ALTER TABLE public.pagamenti
    ADD COLUMN fattura_aruba_id varchar(255), ADD COLUMN fattura_pdf_path text, ADD COLUMN fattura_emessa_il timestamptz,
    ADD COLUMN fattura_causale text, ADD COLUMN sconto numeric(10,2) NOT NULL DEFAULT 0;

  -- Come in produzione: le colonne che il registro e la propagazione leggono, e il trigger che alza la versione.
  CREATE TABLE public.registro_orario (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    classe_sezione varchar(50) NOT NULL,
    data date NOT NULL,
    ora_lezione integer NOT NULL,
    section_id uuid,
    argomento text,
    creato_il timestamptz DEFAULT now(),
    storico_versione bigint NOT NULL DEFAULT 0
  );
  CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE ON public.registro_orario
    FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione();

  CREATE TABLE public.scrutini (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    periodo_id uuid NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE,
    creato_il timestamptz DEFAULT now()
  );
  CREATE TABLE public.pagella_ricezioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scrutinio_id uuid NOT NULL REFERENCES public.scrutini(id) ON DELETE CASCADE,
    firmato_il timestamptz
  );
  CREATE TABLE public.video_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id uuid NOT NULL REFERENCES public.video_intents(id) ON DELETE CASCADE,
    stato text NOT NULL DEFAULT 'coda',
    created_at timestamptz DEFAULT now()
  );
`

let db: PGlite
let A2526: string
let A2627: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
/** Il seme nasce a guardia spenta (si scrive in un anno chiuso, come i dati di prima); poi si accende. */
async function seme<T>(fn: () => Promise<T>): Promise<T> {
  await db.query(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = false`)
  try { return await fn() } finally {
    await db.query(`UPDATE public.anno_regole SET guardia_attiva = true, guardia_osserva = false`)
  }
}
const OK = 'nessun-errore'

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3', completo: true, codaPrima: CODA_PRIMA })
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [ALUNNO, SEDE])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = false;
                 DELETE FROM public.registro_orario; DELETE FROM public.avvisi; DELETE FROM public.galleria_media_v2;
                 DELETE FROM public.chat_messages; DELETE FROM public.chat_threads; DELETE FROM public.pagamenti;
                 DELETE FROM public.pagella_ricezioni; DELETE FROM public.scrutini; DELETE FROM public.scrutinio_periodi;
                 DELETE FROM public.nota_ricezioni; DELETE FROM public.note_disciplinari;
                 DELETE FROM public.video_jobs; DELETE FROM public.video_intents;
                 DELETE FROM public.sections;
                 DELETE FROM public.app_log; DELETE FROM public.anno_guardia_osservazioni;
                 UPDATE public.anni_sede SET stato = 'chiuso' WHERE anno_id = '${A2526}';
                 UPDATE public.anni_sede SET stato = 'corrente' WHERE anno_id = '${A2627}'`)
})

describe('3.3-2 (c) · le colonne esenti, tabella per tabella', () => {
  it('chat_messages: `read_at` e `delivered_at` passano su un messaggio del 2026-08-30; il testo → ANNO_CHIUSO', async () => {
    const id = await seme(async () => {
      const t = await una<string>(`INSERT INTO public.chat_threads (student_id) VALUES ($1) RETURNING id`, [ALUNNO])
      return una<string>(
        `INSERT INTO public.chat_messages (thread_id, content, created_at)
         VALUES ($1, 'ciao', TIMESTAMPTZ '2026-08-30 10:00:00+02') RETURNING id`, [t])
    })
    expect(await una<string>(`SELECT anno_id FROM public.chat_messages WHERE id = $1`, [id])).toBe(A2526)
    expect(await messaggio(db.query(`UPDATE public.chat_messages SET read_at = TIMESTAMPTZ '2026-09-02 08:00:00+02' WHERE id = $1`, [id]))).toBe(OK)
    expect(await messaggio(db.query(`UPDATE public.chat_messages SET delivered_at = TIMESTAMPTZ '2026-09-02 08:00:00+02' WHERE id = $1`, [id]))).toBe(OK)
    expect(await messaggio(db.query(`UPDATE public.chat_messages SET content = 'cambiato' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
    expect(await messaggio(db.query(
      `UPDATE public.chat_messages SET read_at = now(), content = 'cambiato' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
  })

  it('sections: `name` passa su una sezione del 2025/26; `school_type` → ANNO_CHIUSO', async () => {
    const id = await seme(() => una<string>(
      `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Vecchia', $2) RETURNING id`, [SEDE, A2526]))
    expect(await messaggio(db.query(`UPDATE public.sections SET name = 'Nuova' WHERE id = $1`, [id]))).toBe(OK)
    expect(await una<string>(`SELECT name FROM public.sections WHERE id = $1`, [id])).toBe('Nuova')
    expect(await messaggio(db.query(`UPDATE public.sections SET school_type = 'nido' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
    expect(await messaggio(db.query(`UPDATE public.sections SET name = 'Altra', school_type = 'nido' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
  })

  it('registro_orario: solo `classe_sezione` (e la versione che il trigger alza), non `argomento`', async () => {
    const id = await seme(() => una<string>(
      `INSERT INTO public.registro_orario (scuola_id, classe_sezione, data, ora_lezione) VALUES ($1, 'Girasoli', $2, 1) RETURNING id`,
      [SEDE, GIORNO_CHIUSO]))
    expect(await una<string>(`SELECT anno_id FROM public.registro_orario WHERE id = $1`, [id])).toBe(A2526)
    expect(await messaggio(db.query(`UPDATE public.registro_orario SET classe_sezione = 'Soli' WHERE id = $1`, [id]))).toBe(OK)
    expect(await una<string>(`SELECT storico_versione::text FROM public.registro_orario WHERE id = $1`, [id])).toBe('1')
    expect(await messaggio(db.query(`UPDATE public.registro_orario SET argomento = 'x' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
    expect(await messaggio(db.query(
      `UPDATE public.registro_orario SET classe_sezione = 'Lune', argomento = 'x' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
  })

  for (const [t, extra, colonnaVietata] of [
    ['avvisi', 'titolo', 'titolo'],
    ['galleria_media_v2', 'caption', 'caption'],
  ] as const) {
    it(`${t}: \`target_classes\` e \`target_section_ids\` passano su un anno chiuso, e SOLO quelle (\`${colonnaVietata}\` → ANNO_CHIUSO)`, async () => {
      const id = await seme(() => una<string>(
        `INSERT INTO public.${t} (scuola_id, giorno_competenza, target_classes) VALUES ($1, $2, ARRAY['Girasoli']) RETURNING id`,
        [SEDE, GIORNO_CHIUSO]))
      expect(await una<string>(`SELECT anno_id FROM public.${t} WHERE id = $1`, [id])).toBe(A2526)
      expect(await messaggio(db.query(`UPDATE public.${t} SET target_classes = ARRAY['Soli'] WHERE id = $1`, [id]))).toBe(OK)
      expect(await messaggio(db.query(`UPDATE public.${t} SET target_section_ids = ARRAY[gen_random_uuid()] WHERE id = $1`, [id]))).toBe(OK)
      expect(await messaggio(db.query(`UPDATE public.${t} SET ${extra} = 'x' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(db.query(
        `UPDATE public.${t} SET target_classes = ARRAY['Lune'], ${extra} = 'x' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
    })
  }

  it('note_disciplinari: la «toccata» della firma (`storico_versione = storico_versione`, fatta dall\'aggregato AFTER) passa; il contenuto no', async () => {
    const nota = await seme(() => una<string>(
      `INSERT INTO public.note_disciplinari (alunno_id, data_evento) VALUES ($1, $2) RETURNING id`, [ALUNNO, GIORNO_CHIUSO]))
    // la firma di una nota di giugno a settembre: l'INSERT della ricezione alza la versione della nota (anno chiuso)
    await db.query(`UPDATE public.anno_regole SET guardia_attiva = true`)
    expect(await messaggio(db.query(`INSERT INTO public.nota_ricezioni (nota_id, firmato_il) VALUES ($1, now())`, [nota]))).toBe(OK)
    expect(await una<string>(`SELECT storico_versione::text FROM public.note_disciplinari WHERE id = $1`, [nota])).toBe('1')
    expect(await messaggio(db.query(
      `UPDATE public.note_disciplinari SET data_evento = DATE '2026-03-11' WHERE id = $1`, [nota]))).toBe('ANNO_CHIUSO')
  })
})

describe('3.3-2 (c) · pagamenti', () => {
  const ESENTI: Array<[string, string]> = [
    ['stato', `'pagato'`],
    ['importo_pagato', `10`],
    ['data_incasso', `DATE '2026-09-02'`],
    ['fattura_aruba_id', `'ARUBA-FINTO'`],
    ['fattura_stato', `'emessa'`],
    ['fattura_pdf_path', `'cartella/finto.pdf'`],
    ['fattura_emessa_il', `TIMESTAMPTZ '2026-09-02 09:00:00+02'`],
    ['fattura_causale', `'causale finta'`],
    ['ultimo_sollecito_il', `TIMESTAMPTZ '2026-09-02 09:00:00+02'`],
    ['aggiornato_il', `TIMESTAMPTZ '2026-09-02 09:00:00+02'`],
  ]
  async function voce(): Promise<string> {
    return seme(() => una<string>(
      `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza)
       VALUES ($1, $2, 'rata', 100, DATE '2026-03-10') RETURNING id`, [SEDE, ALUNNO]))
  }
  for (const [colonna, valore] of ESENTI) {
    it(`l'incasso: \`${colonna}\` passa su una voce del 2025/26`, async () => {
      const id = await voce()
      expect(await una<string>(`SELECT anno_id FROM public.pagamenti WHERE id = $1`, [id])).toBe(A2526)
      expect(await messaggio(db.query(`UPDATE public.pagamenti SET ${colonna} = ${valore} WHERE id = $1`, [id]))).toBe(OK)
    })
  }

  it('tutte insieme (un incasso con fattura e sollecito) passano', async () => {
    const id = await voce()
    const set = ESENTI.map(([c, v]) => `${c} = ${v}`).join(', ')
    expect(await messaggio(db.query(`UPDATE public.pagamenti SET ${set} WHERE id = $1`, [id]))).toBe(OK)
  })

  for (const [colonna, valore] of [['sconto', '5'], ['importo', '90'], ['descrizione', `'altro'`]] as const) {
    it(`\`${colonna}\` NON è esente → ANNO_CHIUSO (anche insieme a una colonna d'incasso)`, async () => {
      const id = await voce()
      expect(await messaggio(db.query(`UPDATE public.pagamenti SET ${colonna} = ${valore} WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
      expect(await messaggio(db.query(
        `UPDATE public.pagamenti SET ${colonna} = ${valore}, stato = 'pagato' WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
    })
  }
})

describe('3.3-2 (c) · le tabelle con la guardia ridotta', () => {
  it('pagella_ricezioni e nota_ricezioni (`nessuna`): l\'INSERT su una pagella e su una nota del 2025/26 passa', async () => {
    const { scrutino, nota } = await seme(async () => {
      const periodo = await una<string>(`INSERT INTO public.scrutinio_periodi (scuola_id, anno_id) VALUES ($1, $2) RETURNING id`, [SEDE, A2526])
      return {
        scrutino: await una<string>(`INSERT INTO public.scrutini (periodo_id) VALUES ($1) RETURNING id`, [periodo]),
        nota: await una<string>(`INSERT INTO public.note_disciplinari (alunno_id, data_evento) VALUES ($1, $2) RETURNING id`, [ALUNNO, GIORNO_CHIUSO]),
      }
    })
    expect(await una<string>(`SELECT anno_id FROM public.scrutini WHERE id = $1`, [scrutino])).toBe(A2526)
    expect(await una<string>(`SELECT guardia FROM public.anno_tabelle WHERE tabella = 'pagella_ricezioni'`)).toBe('nessuna')
    expect(await messaggio(db.query(`INSERT INTO public.pagella_ricezioni (scrutinio_id, firmato_il) VALUES ($1, now())`, [scrutino]))).toBe(OK)
    expect(await una<string>(`SELECT anno_id FROM public.pagella_ricezioni LIMIT 1`)).toBe(A2526)
    expect(await una<string>(`SELECT guardia FROM public.anno_tabelle WHERE tabella = 'nota_ricezioni'`)).toBe('nessuna')
    expect(await messaggio(db.query(`INSERT INTO public.nota_ricezioni (nota_id, firmato_il) VALUES ($1, now())`, [nota]))).toBe(OK)
    // la pagella in sé (la madre) resta guardata: cambiare lo scrutinio di un anno chiuso è una correzione
    expect(await messaggio(db.query(`UPDATE public.scrutini SET creato_il = now() WHERE id = $1`, [scrutino]))).toBe('ANNO_CHIUSO')
  })

  it('video_jobs (`nessuna`): UPDATE e DELETE passano su un anno chiuso', async () => {
    const job = await seme(async () => {
      const intent = await una<string>(
        `INSERT INTO public.video_intents (scuola_id, giorno_competenza) VALUES ($1, $2) RETURNING id`, [SEDE, GIORNO_CHIUSO])
      return una<string>(`INSERT INTO public.video_jobs (intent_id) VALUES ($1) RETURNING id`, [intent])
    })
    expect(await una<string>(`SELECT anno_id FROM public.video_jobs WHERE id = $1`, [job])).toBe(A2526)
    expect(await una<string>(`SELECT guardia FROM public.anno_tabelle WHERE tabella = 'video_jobs'`)).toBe('nessuna')
    expect(await messaggio(db.query(`UPDATE public.video_jobs SET stato = 'finito' WHERE id = $1`, [job]))).toBe(OK)
    expect(await messaggio(db.query(`DELETE FROM public.video_jobs WHERE id = $1`, [job]))).toBe(OK)
  })

  it('video_intents (`solo_contenuto`): UPDATE passa; DELETE e INSERT su un anno chiuso → ANNO_CHIUSO', async () => {
    const intent = await seme(() => una<string>(
      `INSERT INTO public.video_intents (scuola_id, giorno_competenza) VALUES ($1, $2) RETURNING id`, [SEDE, GIORNO_CHIUSO]))
    expect(await una<string>(`SELECT guardia FROM public.anno_tabelle WHERE tabella = 'video_intents'`)).toBe('solo_contenuto')
    expect(await messaggio(db.query(`UPDATE public.video_intents SET classi_destinatarie = ARRAY['Soli'] WHERE id = $1`, [intent]))).toBe(OK)
    expect(await messaggio(db.query(
      `INSERT INTO public.video_intents (scuola_id, giorno_competenza) VALUES ($1, $2)`, [SEDE, GIORNO_CHIUSO]))).toBe('ANNO_CHIUSO')
    expect(await messaggio(db.query(`DELETE FROM public.video_intents WHERE id = $1`, [intent]))).toBe('ANNO_CHIUSO')
  })

  it('le tabelle senza la manopola restano `piena` (presenze: UPDATE guardato)', async () => {
    const id = await seme(() => una<string>(
      `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3) RETURNING id`, [ALUNNO, SEDE, GIORNO_CHIUSO]))
    expect(await messaggio(db.query(`UPDATE public.presenze SET section_id = NULL WHERE id = $1`, [id]))).toBe('ANNO_CHIUSO')
  })
})

describe('3.3-2 (c) · la rinomina in agosto', () => {
  it('la sezione del 2026/27 in_chiusura: UPDATE sections SET name riscrive `classe_sezione` dalla propagazione, senza ANNO_CHIUSO', async () => {
    const { sezione, riga, avviso } = await seme(async () => {
      const sezione = await una<string>(
        `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Girasoli', $2) RETURNING id`, [SEDE, A2627])
      const riga = await una<string>(
        `INSERT INTO public.registro_orario (scuola_id, classe_sezione, data, ora_lezione, section_id)
         VALUES ($1, 'Girasoli', DATE '2026-10-05', 1, $2) RETURNING id`, [SEDE, sezione])
      const avviso = await una<string>(
        `INSERT INTO public.avvisi (scuola_id, giorno_competenza, target_classes) VALUES ($1, DATE '2026-10-05', ARRAY['Girasoli']) RETURNING id`, [SEDE])
      return { sezione, riga, avviso }
    })
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE anno_id = $1`, [A2627])
    expect(await una<string>(`SELECT anno_id FROM public.registro_orario WHERE id = $1`, [riga])).toBe(A2627)

    expect(await messaggio(db.query(`UPDATE public.sections SET name = 'Soli' WHERE id = $1`, [sezione]))).toBe(OK)

    expect(await una<string>(`SELECT name FROM public.sections WHERE id = $1`, [sezione])).toBe('Soli')
    expect(await una<string>(`SELECT classe_sezione FROM public.registro_orario WHERE id = $1`, [riga])).toBe('Soli')
    expect(await una<string>(`SELECT target_classes[1] FROM public.avvisi WHERE id = $1`, [avviso])).toBe('Soli')
    // e il resto di una sezione in chiusura resta guardato? no: `in_chiusura` accetta il gettone `agosto`, qui senza
    expect(await messaggio(db.query(`UPDATE public.sections SET school_type = 'nido' WHERE id = $1`, [sezione]))).toBe('ANNO_CHIUSO')
  })
})
