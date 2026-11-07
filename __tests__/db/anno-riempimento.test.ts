import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnno, creaAnniFissi, applicaPr2, SCHEMA_PR2, SCHEMA_PR2_RIEMPIMENTO,
} from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.2 · IL RIEMPIMENTO (`anno_riempi`, migrazione M1) e le sue regole.
 *
 * Il seme nasce COME OGGI, senza `anno_id`: il trigger generico si spegne mentre si scrive (`senzaAnno`) e si
 * riaccende prima di riempire. I contatori «ambiguo:*» si leggono dalla fotografia (`anno_fotografa`), che è
 * proprio il rapporto della migrazione. Date FISSE (2025/26-2027/28), mai oggi; solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const al = (n: number) => `44444444-4444-4444-8444-44444444444${n}`
const TRIGGER = 'trg_zz_anno_assegna_e_verifica'

let db: PGlite
let A2526: string
let A2627: string
let A2728: string
let SEZ1: string
let SEZ2: string

async function una<T>(sql: string, params: unknown[] = [], d: PGlite = db): Promise<T> {
  const r = await d.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
/** Scrive il seme con il trigger generico spento sulle tabelle date: l'anno resta NULL, come nel database di oggi. */
async function senzaAnno<T>(tabelle: string[], f: () => Promise<T>): Promise<T> {
  for (const t of tabelle) await db.exec(`ALTER TABLE public.${t} DISABLE TRIGGER ${TRIGGER}`)
  try { return await f() } finally {
    for (const t of tabelle) await db.exec(`ALTER TABLE public.${t} ENABLE TRIGGER ${TRIGGER}`)
  }
}
async function riempi(tabelle: string[] | null = null): Promise<Record<string, number>> {
  const r = await db.query<{ r: Record<string, number> }>(`SELECT public.anno_riempi($1::text[], DATE '2026-11-07') AS r`, [tabelle])
  return r.rows[0].r
}
/** Il contatore del rapporto: la somma della voce nell'ultima fotografia `dopo`, scattata ora. */
async function contatore(voce: string, tabella: string, sede: string | null = null): Promise<number> {
  await db.exec(`DELETE FROM public.riconciliazione_anno`)
  await db.query(`SELECT public.anno_fotografa('dopo', $1::text[])`, [[tabella]])
  return una<number>(
    `SELECT coalesce(sum(valore), 0)::float8 FROM public.riconciliazione_anno
      WHERE fase = 'dopo' AND tabella = $1 AND voce = $2 AND ($3::uuid IS NULL OR scuola_id = $3)`, [tabella, voce, sede])
}
async function annoDi(tabella: string, id: string): Promise<string | null> {
  return una<string | null>(`SELECT anno_id FROM public.${tabella} WHERE id = $1`, [id])
}
async function alunno(n: number, o: { sede?: string | null; sezione?: string | null; retta?: number | null; archiviato?: string | null } = {}) {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id, importo_retta_mensile, archiviato_il) VALUES ($1, $2, $3, $4, $5)`,
    [al(n), o.sede === undefined ? S1 : o.sede, o.sezione ?? null, o.retta === undefined ? 0 : o.retta, o.archiviato ?? null])
}
async function storico(n: number, dal: string) {
  await db.query(`INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, dal) VALUES ($1, $2, $3)`, [al(n), S1, dal])
}

beforeAll(async () => {
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [S1, S2], codaPrima: SCHEMA_PR2 + SCHEMA_PR2_RIEMPIMENTO })
  await creaAnniFissi(db, [S1, S2])
  await applicaPr2(db, 'M1')
  // Il 2027/28 `in_preparazione`: lo crea il riempimento, ma i test che non lo provano lo trovano già (idempotente).
  for (const s of [S1, S2]) await db.query(`SELECT public.anni_sede_crea_successivo($1, DATE '2026-11-06')`, [s])
  A2526 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2025`)
  A2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  A2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  SEZ1 = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
  SEZ2 = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S2])
}, 60_000)
afterAll(async () => { await db.close() })

beforeEach(async () => {
  await db.exec(`
    UPDATE public.anno_regole SET controlli_rigidi = false, guardia_attiva = false, specchio_alunni_attivo = false;
    DROP TRIGGER IF EXISTS prova_fallimento ON public.valutazioni;
    DELETE FROM public.riconciliazione_anno;
    DELETE FROM scatola_nera.modifiche;
    DELETE FROM public.frequenze;
    DELETE FROM public.listino_voci; DELETE FROM public.moduli_richiesti; DELETE FROM public.posti_autorizzati;
    DELETE FROM public.iscrizioni_decisioni; DELETE FROM public.enrollment_submissions;
    DELETE FROM public.crm_bambini; DELETE FROM public.pagamenti;
    DELETE FROM public.presenze; DELETE FROM public.mensa_prenotazioni; DELETE FROM public.valutazioni;
    DELETE FROM public.gallery_photo_uploads; DELETE FROM public.galleria_media_v2;
    DELETE FROM public.avvisi; DELETE FROM public.video_intents;
    DELETE FROM public.news_posts; DELETE FROM public.forms_templates; DELETE FROM public.mensa_class_menu_assignment;
    DELETE FROM public.alunni_classi_storico; DELETE FROM public.alunni; DELETE FROM public.admin_settings;
  `)
})

describe('le frequenze dagli alunni', () => {
  it('una frequenza per alunno, con ingresso e uscita dentro l\'anno e i casi portati a inizio anno contati', async () => {
    await alunno(1, { sezione: SEZ1 }); await storico(1, '2026-07-07')
    await alunno(2); await storico(2, '2026-09-14')
    await alunno(3) // nessuno storico
    await alunno(4, { archiviato: '2026-10-12T22:30:00Z' }); await storico(4, '2026-09-01')
    await alunno(5, { archiviato: '2026-08-20T10:00:00Z' }); await storico(5, '2026-09-01')
    await alunno(6, { sede: null })
    await riempi()
    await riempi() // due volte: ancora una frequenza per alunno

    const f = async (n: number) => (await db.query<Record<string, string | null>>(
      `SELECT stato, origine, tipo, data_ingresso::text AS ingresso, data_uscita::text AS uscita, section_id
         FROM public.frequenze WHERE alunno_id = $1`, [al(n)])).rows
    expect(await f(1)).toEqual([{ stato: 'iscritto', origine: 'recupero', tipo: null, ingresso: '2026-09-01', uscita: null, section_id: SEZ1 }])
    expect((await f(2))[0].ingresso).toBe('2026-09-14')
    expect((await f(3))[0].ingresso).toBe('2026-09-01')
    expect(await f(4)).toMatchObject([{ stato: 'ritirato', uscita: '2026-10-13' }])
    expect(await f(5)).toMatchObject([{ stato: 'ritirato', ingresso: '2026-09-01', uscita: '2026-09-01' }])
    expect(await f(6)).toEqual([])
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze`)).toBe(5)

    expect(await contatore('ambiguo:alunni_senza_storico', 'alunni')).toBe(1)
    expect(await contatore('ambiguo:alunni_senza_sede', 'alunni')).toBe(1)
    expect(await contatore('ambiguo:uscita_portata_a_inizio_anno', 'frequenze')).toBe(1)
    expect(await contatore('ambiguo:ingresso_portato_a_inizio_anno', 'frequenze')).toBe(1)
    expect(await contatore('recuperi', 'frequenze')).toBe(5)
    expect(await contatore('alunni_senza_frequenza', 'alunni')).toBe(0)
  })

  it('la sezione di un altro anno non si copia (la frequenza resta valida)', async () => {
    const vecchia = await una<string>(
      `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Vecchi', $2) RETURNING id`, [S1, A2526])
    await alunno(1, { sezione: vecchia })
    await riempi()
    expect(await una<string | null>(`SELECT section_id FROM public.frequenze WHERE alunno_id = $1`, [al(1)])).toBeNull()
    await db.query(`DELETE FROM public.alunni WHERE id = $1`, [al(1)])
    await db.query(`DELETE FROM public.sections WHERE id = $1`, [vecchia])
  })
})

describe('la retta: zero → NULL, il listino e gli euro invariati', () => {
  it('importo 0 → NULL, 120.00 → 120.00, −5 → NULL; listino 2026/27 con una riga retta da 150.00', async () => {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150.00)`, [S1])
    await alunno(1, { retta: 0 }); await alunno(2, { retta: 120 }); await alunno(3, { retta: -5 })
    await riempi()
    const r = (await db.query<{ n: string; v: string | null }>(
      `SELECT right(alunno_id::text, 1) AS n, retta_mensile::text AS v FROM public.frequenze ORDER BY 1`)).rows
    expect(r).toEqual([{ n: '1', v: null }, { n: '2', v: '120.00' }, { n: '3', v: null }])
    const l = (await db.query<{ importo: string; slug: string }>(
      `SELECT l.importo::text AS importo, c.slug FROM public.listino_voci l
         JOIN public.anni_sede s ON s.id = l.anno_sede_id AND s.anno_id = $1 AND s.scuola_id = $2
         LEFT JOIN public.payment_categories c ON c.id = l.payment_category_id
        WHERE l.voce = 'retta' AND l.fascia IS NULL`, [A2627, S1])).rows
    expect(l).toEqual([{ importo: '150.00', slug: 'retta' }])
  })

  it('euro invariati: Σ coalesce(retta_mensile, listino) = Σ coalesce(nullif(importo,0), default, 150) = 650.50', async () => {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150.00)`, [S1])
    const importi = [120, 0, 0, 80.5, 0]
    for (let i = 0; i < importi.length; i++) await alunno(i + 1, { retta: importi[i] })
    await riempi()
    const nuovo = await una<string>(
      `SELECT sum(coalesce(f.retta_mensile, l.importo))::text FROM public.frequenze f
         JOIN public.listino_voci l ON l.anno_sede_id = f.anno_sede_id AND l.voce = 'retta' AND l.fascia IS NULL`)
    const vecchio = await una<string>(
      `SELECT sum(coalesce(nullif(a.importo_retta_mensile, 0), s.retta_default_importo, 150))::text FROM public.alunni a
         LEFT JOIN public.admin_settings s ON s.scuola_id = a.scuola_id`)
    expect(nuovo).toBe('650.50')
    expect(vecchio).toBe('650.50')
  })

  it('una sede senza riga in admin_settings ha la retta da 150.00 e le frequenze che ci si reggono sono contate', async () => {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150.00)`, [S1])
    await alunno(1, { retta: 0 })
    await db.query(`INSERT INTO public.alunni (id, scuola_id, importo_retta_mensile) VALUES ($1, $2, 0), ($3, $2, 0)`, [al(7), S2, al(8)])
    await riempi()
    expect(await una<string>(
      `SELECT l.importo::text FROM public.listino_voci l JOIN public.anni_sede s ON s.id = l.anno_sede_id AND s.anno_id = $1
        WHERE s.scuola_id = $2`, [A2627, S2])).toBe('150.00')
    expect(await contatore('ambiguo:retta_default_assente_150', 'frequenze', S2)).toBe(2)
    expect(await contatore('ambiguo:retta_default_assente_150', 'frequenze', S1)).toBe(0)
  })

  it('la configurazione del 2026/27 passa al 2027/28, una volta sola', async () => {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150.00)`, [S1])
    const as1 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, A2627])
    await db.query(`INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, 'nuova', 'privacy', 'Privacy')`, [as1])
    await db.query(`INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti) VALUES ($1, 'infanzia', 40)`, [as1])
    await riempi()
    await riempi()
    const copiate = async (t: string) => una<number>(
      `SELECT count(*)::int FROM public.${t} x JOIN public.anni_sede s ON s.id = x.anno_sede_id WHERE s.scuola_id = $1 AND s.anno_id = $2`, [S1, A2728])
    expect(await copiate('listino_voci')).toBe(1)
    expect(await copiate('moduli_richiesti')).toBe(1)
    expect(await copiate('posti_autorizzati')).toBe(1)
  })
})

describe('le regole dei dichiarati sui dati vecchi', () => {
  it('pagamenti: competenza → scadenza → creazione; gli euro non si muovono', async () => {
    // il 2027/28 non esiste ancora, com'è in produzione prima del riempimento: lo ricrea il riempimento
    await db.exec(`DELETE FROM public.anni_sede_stati WHERE anno_sede_id IN (SELECT id FROM public.anni_sede WHERE anno_id = '${A2728}');
                   DELETE FROM public.anni_sede WHERE anno_id = '${A2728}'`)
    const ids = await senzaAnno(['pagamenti'], async () => {
      const v: Array<[string, string | null, string, number]> = [
        ['2026-10-31', '2026-10-05', '2026-10-01T10:00:00Z', 100],
        ['2026-06-10', null, '2026-06-01T10:00:00Z', 50.5],
        ['2027-09-10', '2027-09-01', '2026-10-01T10:00:00Z', 20],
      ]
      const out: string[] = []
      for (const [scad, comp, creato, imp] of v) {
        out.push(await una<string>(
          `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza, creato_il)
           VALUES ($1, 'voce', $2, $3, $4, $5) RETURNING id`, [S1, imp, scad, comp, creato]))
      }
      return out
    })
    const euro = () => una<string>(`SELECT sum(importo)::text FROM public.pagamenti`)
    const prima = await euro()
    await db.query(`SELECT public.anno_fotografa('prima', ARRAY['pagamenti'])`)
    await riempi()
    expect(await annoDi('pagamenti', ids[0])).toBe(A2627)
    expect(await annoDi('pagamenti', ids[1])).toBe(A2526)
    expect(await annoDi('pagamenti', ids[2])).toBe(A2728)
    expect(await euro()).toBe(prima)
    const voce = (v: string) => una<number>(
      `SELECT coalesce(sum(valore), 0)::float8 FROM public.riconciliazione_anno WHERE fase = 'prima' AND tabella = 'pagamenti' AND voce = $1`, [v])
    expect(await voce('ambiguo:via_competenza')).toBe(2)
    expect(await voce('ambiguo:via_scadenza')).toBe(1)
    // misurato PRIMA del riempimento: il 2027/28 lo crea il riempimento stesso
    expect(await voce('ambiguo:pagamenti_anno_successivo')).toBe(1)
  })

  it('domande: tutte nel 2026/27 (anche quella di luglio); la figlia eredita; 15/09 e 01/09 contati', async () => {
    const d = await senzaAnno(['enrollment_submissions', 'iscrizioni_decisioni'], async () => {
      const out: string[] = []
      for (const g of ['2026-07-20', '2026-09-03', '2026-09-20']) {
        out.push(await una<string>(
          `INSERT INTO public.enrollment_submissions (scuola_id, created_at) VALUES ($1, $2::timestamptz) RETURNING id`, [S1, `${g}T10:00:00Z`]))
      }
      await db.query(`INSERT INTO public.iscrizioni_decisioni (submission_id) VALUES ($1)`, [out[0]])
      return out
    })
    await riempi()
    for (const id of d) expect(await annoDi('enrollment_submissions', id)).toBe(A2627)
    expect(await una<string>(`SELECT anno_id FROM public.iscrizioni_decisioni`)).toBe(A2627)
    expect(await contatore('ambiguo:domande_prima_1_09', 'enrollment_submissions')).toBe(1)
    expect(await contatore('ambiguo:domande_dopo_15_09', 'enrollment_submissions')).toBe(1)
  })

  it('CRM relativo → assoluto: le quattro regole, e la voce della quota non si tocca', async () => {
    const quota = '66666666-6666-4666-8666-666666666661'
    const c = await senzaAnno(['crm_bambini'], async () => {
      const v: Array<[string, number | null, string]> = [
        ['in_corso', 2027, '2026-10-31T10:00:00Z'],
        ['prossimo', null, '2026-10-31T10:00:00Z'],
        ['in_corso', null, '2026-10-31T10:00:00Z'],
        ['in_corso', null, '2026-07-15T10:00:00Z'],
      ]
      const out: string[] = []
      for (const [et, q, cr] of v) {
        out.push(await una<string>(
          `INSERT INTO public.crm_bambini (scuola_id, anno_ingresso, quota_anno, creata_il, quota_pagamento_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`, [S1, et, q, cr, quota]))
      }
      return out
    })
    await riempi()
    expect(await annoDi('crm_bambini', c[0])).toBe(A2728)
    expect(await annoDi('crm_bambini', c[1])).toBe(A2728)
    expect(await annoDi('crm_bambini', c[2])).toBe(A2627)
    expect(await annoDi('crm_bambini', c[3])).toBe(A2526)
    expect(await una<number>(`SELECT count(*)::int FROM public.crm_bambini WHERE quota_pagamento_id = $1`, [quota])).toBe(4)
  })
})

describe('i nomi di classe diventano uuid', () => {
  it('avvisi: nomi equivalenti → un uuid, il non abbinato resta nei nomi ed è contato; vuoto → {}, NULL → NULL', async () => {
    const a = await senzaAnno(['avvisi'], async () => {
      const out: string[] = []
      for (const t of ['{Girasoli,"gira soli",Delfini}', '{}', null]) {
        out.push(await una<string>(
          `INSERT INTO public.avvisi (scuola_id, target_classes, giorno_competenza) VALUES ($1, $2::text[], DATE '2026-10-05') RETURNING id`, [S1, t]))
      }
      return out
    })
    await riempi()
    const sez = (id: string) => una<string[] | null>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])
    expect(await sez(a[0])).toEqual([SEZ1])
    expect(await sez(a[1])).toEqual([])
    expect(await sez(a[2])).toBeNull()
    expect(await una<string[]>(`SELECT target_classes FROM public.avvisi WHERE id = $1`, [a[0]])).toEqual(['Girasoli', 'gira soli', 'Delfini'])
    expect(await contatore('ambiguo:nomi_classe_non_abbinati:avvisi', 'avvisi')).toBe(1)
  })

  it('le altre tabelle, e due sedi con una sezione omonima: ognuna abbina la propria', async () => {
    await db.query(`INSERT INTO public.forms_templates (scuola_id, target_classes) VALUES ($1, '{Girasoli}')`, [S1])
    await db.query(`INSERT INTO public.news_posts (scuola_id, target_classes) VALUES ($1, '{GIRASOLI}')`, [S2])
    await senzaAnno(['galleria_media_v2', 'video_intents'], async () => {
      await db.query(`INSERT INTO public.galleria_media_v2 (scuola_id, giorno_competenza, target_classes) VALUES ($1, DATE '2026-10-05', '{Girasoli}')`, [S1])
      await db.query(`INSERT INTO public.video_intents (scuola_id, giorno_competenza, classi_destinatarie) VALUES ($1, DATE '2026-10-05', '{Girasoli}')`, [S2])
    })
    await db.query(`INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe) VALUES ($1, 'girasoli'), ($2, 'Girasoli'), ($1, 'Nessuna')`, [S1, S2])
    await riempi()
    expect(await una<string[]>(`SELECT target_section_ids FROM public.forms_templates`)).toEqual([SEZ1])
    expect(await una<string[]>(`SELECT target_section_ids FROM public.news_posts`)).toEqual([SEZ2])
    expect(await una<string[]>(`SELECT target_section_ids FROM public.galleria_media_v2`)).toEqual([SEZ1])
    expect(await una<string[]>(`SELECT classi_destinatarie_section_ids FROM public.video_intents`)).toEqual([SEZ2])
    const m = (await db.query<{ scuola_id: string; classe: string; section_id: string | null }>(
      `SELECT scuola_id, classe, section_id FROM public.mensa_class_menu_assignment ORDER BY classe`)).rows
    expect(m).toEqual([
      { scuola_id: S2, classe: 'Girasoli', section_id: SEZ2 },
      { scuola_id: S1, classe: 'Nessuna', section_id: null },
      { scuola_id: S1, classe: 'girasoli', section_id: SEZ1 },
    ])
    expect(await contatore('ambiguo:nomi_classe_non_abbinati:mensa_class_menu_assignment', 'mensa_class_menu_assignment')).toBe(1)
  })

  it('anno_traduci_classi: stesso risultato chiamata da sola; EXECUTE solo al service_role', async () => {
    expect(await una<string[]>(`SELECT public.anno_traduci_classi($1, ARRAY['Girasoli', 'gira soli'])`, [S1])).toEqual([SEZ1])
    expect(await una<string[]>(`SELECT public.anno_traduci_classi($1, ARRAY['Girasoli'])`, [S2])).toEqual([SEZ2])
    expect(await una<string[]>(`SELECT public.anno_traduci_classi($1, '{}'::text[])`, [S1])).toEqual([])
    expect(await una<string[] | null>(`SELECT public.anno_traduci_classi($1, NULL)`, [S1])).toBeNull()
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      const m = await messaggio(db.query(`SELECT public.anno_traduci_classi('${S1}', ARRAY['Girasoli'])`))
      await db.exec('RESET ROLE')
      expect(m).toMatch(/permission denied/)
    }
  })
})

describe('gli effetti collaterali del riempimento', () => {
  it('la scatola nera non riceve righe; fuori dal riempimento lo stesso UPDATE ne scrive (non-cecità); a fine chiamata gli interruttori non sono accesi', async () => {
    await senzaAnno(['presenze', 'pagamenti'], async () => {
      await db.query(
        `INSERT INTO public.presenze (alunno_id, scuola_id, data) SELECT NULL, $1, DATE '2026-10-05' + (g % 20) FROM generate_series(1, 100) g`, [S1])
      await db.query(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza) SELECT $1, 'voce', 10, DATE '2026-10-05' FROM generate_series(1, 20) g`, [S1])
    })
    await riempi()
    expect(await una<number>(`SELECT count(*)::int FROM scatola_nera.modifiche`)).toBe(0)
    // non-cecità: lo stesso UPDATE, fuori dal riempimento, la scatola nera lo registra
    await db.exec(`UPDATE public.presenze SET anno_id = anno_id; UPDATE public.pagamenti SET anno_id = anno_id`)
    expect(await una<number>(`SELECT count(*)::int FROM scatola_nera.modifiche`)).toBe(120)
    // a chiamata finita, dentro la stessa transazione, gli interruttori sono spenti
    await db.exec('BEGIN')
    await db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`)
    const dopo = (await db.query<{ a: string; b: string }>(
      `SELECT current_setting('scatola_nera.senza_storico', true) AS a, current_setting('anno_scolastico.riempimento', true) AS b`)).rows[0]
    await db.exec('COMMIT')
    expect(dopo).toEqual({ a: 'off', b: 'off' })
  })

  it('dopo un errore a metà gli interruttori non restano accesi', async () => {
    await senzaAnno(['valutazioni'], async () => {
      await db.query(`INSERT INTO public.valutazioni (alunno_id, data_evento) VALUES (NULL, DATE '2026-10-05')`)
    })
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.prova_fallimento() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'BOOM'; END $f$;
      CREATE TRIGGER prova_fallimento BEFORE UPDATE ON public.valutazioni
        FOR EACH ROW EXECUTE FUNCTION public.prova_fallimento();`)
    await db.exec('BEGIN')
    await db.exec('SAVEPOINT s')
    expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('BOOM')
    await db.exec('ROLLBACK TO s')
    const dopo = (await db.query<{ a: string | null; b: string | null }>(
      `SELECT current_setting('scatola_nera.senza_storico', true) AS a, current_setting('anno_scolastico.riempimento', true) AS b`)).rows[0]
    await db.exec('COMMIT')
    expect(dopo.a).not.toBe('on')
    expect(dopo.b).not.toBe('on')
  })

  it('le impronte non cambiano: storico_versione e updated_at restano; un UPDATE normale subito dopo li muove', async () => {
    const [p, m] = await senzaAnno(['presenze', 'mensa_prenotazioni'], async () => [
      await una<string>(
        `INSERT INTO public.presenze (scuola_id, data, storico_versione) VALUES ($1, DATE '2026-10-05', 7) RETURNING id`, [S1]),
      await una<string>(
        `INSERT INTO public.mensa_prenotazioni (scuola_id, data, updated_at) VALUES ($1, DATE '2026-10-05', TIMESTAMPTZ '2026-10-01 10:00:00+00') RETURNING id`, [S1]),
    ])
    await riempi()
    expect(await annoDi('presenze', p)).toBe(A2627)
    expect(await una<number>(`SELECT storico_versione FROM public.presenze WHERE id = $1`, [p])).toBe(7)
    const invariato = () => una<boolean>(
      `SELECT updated_at = TIMESTAMPTZ '2026-10-01 10:00:00+00' FROM public.mensa_prenotazioni WHERE id = $1`, [m])
    expect(await invariato()).toBe(true)
    await db.exec(`UPDATE public.presenze SET stato = 'p'; UPDATE public.mensa_prenotazioni SET data = data`)
    expect(await una<number>(`SELECT storico_versione FROM public.presenze WHERE id = $1`, [p])).toBe(8)
    expect(await invariato()).toBe(false)
  })

  it('I-1: la versione della madre non si muove quando il riempimento riempie le figlie (aggregato vero)', async () => {
    await db.exec(`DELETE FROM public.nota_ricezioni; DELETE FROM public.note_disciplinari`)
    await alunno(1)
    const nota = await senzaAnno(['note_disciplinari', 'nota_ricezioni'], async () => {
      const n = await una<string>(
        `INSERT INTO public.note_disciplinari (alunno_id, data_evento, storico_versione) VALUES ($1, DATE '2026-10-05', 2) RETURNING id`, [al(1)])
      await db.query(`INSERT INTO public.nota_ricezioni (nota_id, firmato_il) VALUES ($1, now()), ($1, now())`, [n])
      return n
    })
    const prima = await una<number>(`SELECT storico_versione::int FROM public.note_disciplinari WHERE id = $1`, [nota])
    await riempi()
    expect(await annoDi('nota_ricezioni', (await una<string>(`SELECT id FROM public.nota_ricezioni WHERE nota_id = $1 LIMIT 1`, [nota])))).toBe(A2627)
    expect(await una<number>(`SELECT storico_versione::int FROM public.note_disciplinari WHERE id = $1`, [nota])).toBe(prima)
    // controllo: fuori dal riempimento, lo stesso aggiornamento di una ricezione alza la versione della nota (l'aggregato vive)
    await db.exec(`UPDATE public.nota_ricezioni SET firmato_il = now()`)
    expect(await una<number>(`SELECT storico_versione::int FROM public.note_disciplinari WHERE id = $1`, [nota])).toBeGreaterThan(prima)
  })

  it('le 194: una presenza di luglio con la sezione del 2026/27 viene riempita, contata, e un UPDATE a controlli rigidi passa', async () => {
    const p = await senzaAnno(['presenze'], () => una<string>(
      `INSERT INTO public.presenze (scuola_id, section_id, data) VALUES ($1, $2, DATE '2026-07-10') RETURNING id`, [S1, SEZ1]))
    await riempi()
    expect(await annoDi('presenze', p)).toBe(A2526)
    expect(await contatore('ambiguo:sezione_altro_anno:presenze', 'presenze')).toBe(1)
    await db.exec(`UPDATE public.anno_regole SET controlli_rigidi = true`)
    await db.query(`UPDATE public.presenze SET stato = 'p' WHERE id = $1`, [p])
    expect(await una<string>(`SELECT stato FROM public.presenze WHERE id = $1`, [p])).toBe('p')
  })
})

describe('le precondizioni, l\'atomicità, l\'ordine', () => {
  async function seme() {
    return senzaAnno(['pagamenti'], () => una<string>(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza) VALUES ($1, 'voce', 10, DATE '2026-10-05') RETURNING id`, [S1]))
  }
  async function nulla(id: string) {
    expect(await annoDi('pagamenti', id)).toBeNull()
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze`)).toBe(0)
  }

  it('a controlli rigidi: RIEMPIMENTO_A_CONTROLLI_RIGIDI e non cambia niente', async () => {
    const id = await seme()
    await alunno(1)
    await db.exec(`UPDATE public.anno_regole SET controlli_rigidi = true`)
    expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('RIEMPIMENTO_A_CONTROLLI_RIGIDI')
    await nulla(id)
  })

  it('a guardia accesa: RIEMPIMENTO_A_GUARDIA_ATTIVA', async () => {
    const id = await seme()
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
    expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('RIEMPIMENTO_A_GUARDIA_ATTIVA')
    await nulla(id)
  })

  it('una galleria con sopprimiGenitori: RIEMPIMENTO_GALLERIA_SOPPRIMI e non cambia niente', async () => {
    const id = await seme()
    await senzaAnno(['galleria_media_v2'], () => db.query(
      `INSERT INTO public.galleria_media_v2 (scuola_id, giorno_competenza, politica_operazione) VALUES ($1, DATE '2026-10-05', '{"sopprimiGenitori": true}')`, [S1]))
    expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('RIEMPIMENTO_GALLERIA_SOPPRIMI')
    await nulla(id)
  })

  it('un nome di tabella sconosciuto: TABELLA_NON_NEL_RIEMPIMENTO', async () => {
    expect(await messaggio(db.query(`SELECT public.anno_riempi(ARRAY['pagamenti', 'non_esiste'], DATE '2026-11-07')`))).toBe('TABELLA_NON_NEL_RIEMPIMENTO')
  })

  it('atomicità: se una tabella fallisce, nessuna delle precedenti resta riempita (né l\'anno creato)', async () => {
    const id = await seme()
    await alunno(1)
    await senzaAnno(['valutazioni'], () => db.query(`INSERT INTO public.valutazioni (alunno_id, data_evento) VALUES (NULL, DATE '2026-10-05')`))
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.prova_fallimento() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'BOOM'; END $f$;
      CREATE TRIGGER prova_fallimento BEFORE UPDATE ON public.valutazioni
        FOR EACH ROW EXECUTE FUNCTION public.prova_fallimento();`)
    await db.exec('BEGIN')
    await db.exec('SAVEPOINT s')
    expect(await messaggio(db.query(`SELECT public.anno_riempi(NULL, DATE '2026-11-07')`))).toBe('BOOM')
    await db.exec('ROLLBACK TO s')
    await db.exec('COMMIT')
    await nulla(id)
  })

  it('le madri prima delle figlie: la decisione prende l\'anno della domanda, qualunque sia l\'ordine del seme', async () => {
    await senzaAnno(['enrollment_submissions', 'iscrizioni_decisioni'], async () => {
      const dom = await una<string>(`INSERT INTO public.enrollment_submissions (scuola_id, created_at) VALUES ($1, TIMESTAMPTZ '2026-10-05 10:00:00+00') RETURNING id`, [S1])
      await db.query(`INSERT INTO public.iscrizioni_decisioni (submission_id) VALUES ($1)`, [dom])
    })
    const r = await riempi(['iscrizioni_decisioni', 'enrollment_submissions'])
    expect(r.enrollment_submissions).toBe(1)
    expect(r.iscrizioni_decisioni).toBe(1)
    expect(await una<string>(`SELECT anno_id FROM public.iscrizioni_decisioni`)).toBe(A2627)
  })

  it('rieseguita non tocca niente: tutti zero', async () => {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150.00)`, [S1])
    await seme()
    await alunno(1)
    await db.query(`INSERT INTO public.avvisi (scuola_id, target_classes, giorno_competenza) VALUES ($1, '{Girasoli}', DATE '2026-10-05')`, [S1])
    await riempi()
    const seconda = await riempi()
    expect(Object.values(seconda).filter((n) => n !== 0)).toEqual([])
    expect(Object.keys(seconda)).toContain('pagamenti')
  })
})

describe('il primo riempimento crea l\'anno successivo (database nuovo)', () => {
  it('2027/28 `in_preparazione` per ogni sede, una volta sola', async () => {
    const d = await creaDbAnno({ sediPrimaDellaMigrazione: [S1, S2], codaPrima: SCHEMA_PR2 + SCHEMA_PR2_RIEMPIMENTO })
    try {
      await creaAnniFissi(d, [S1, S2])
      await applicaPr2(d, 'M1')
      const conta = () => una<number>(
        `SELECT count(*)::int FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE y.anno_inizio = 2027 AND s.stato = 'in_preparazione'`, [], d)
      expect(await conta()).toBe(0)
      const r = await d.query<{ r: Record<string, number> }>(`SELECT public.anno_riempi(NULL, DATE '2026-11-07') AS r`)
      expect(r.rows[0].r.anni_sede_creati).toBe(2)
      expect(await conta()).toBe(2)
      const r2 = await d.query<{ r: Record<string, number> }>(`SELECT public.anno_riempi(NULL, DATE '2026-11-07') AS r`)
      expect(r2.rows[0].r.anni_sede_creati).toBe(0)
    } finally { await d.close() }
  }, 60_000)
})

describe('F1: il file di riempimento da solo', () => {
  it('fotografia prima, riempimento, fotografia dopo: nessuna riga senza anno, nessuna differenza, interruttori spenti', async () => {
    const d = await creaDbAnno({ sediPrimaDellaMigrazione: [S1], codaPrima: SCHEMA_PR2 + SCHEMA_PR2_RIEMPIMENTO })
    try {
      await creaAnniFissi(d, [S1])
      await applicaPr2(d, 'M1')
      for (const t of ['presenze', 'pagamenti']) await d.exec(`ALTER TABLE public.${t} DISABLE TRIGGER ${TRIGGER}`)
      await d.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [al(1), S1])
      await d.query(`INSERT INTO public.presenze (scuola_id, data) VALUES ($1, DATE '2026-10-05'), ($1, DATE '2026-07-10')`, [S1])
      await d.query(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza) VALUES ($1, 'voce', 10.50, DATE '2026-10-05')`, [S1])
      for (const t of ['presenze', 'pagamenti']) await d.exec(`ALTER TABLE public.${t} ENABLE TRIGGER ${TRIGGER}`)

      await applicaPr2(d, 'F1')

      expect(await una<number>(`SELECT count(*)::int FROM public.presenze WHERE anno_id IS NULL`, [], d)).toBe(0)
      expect(await una<number>(`SELECT count(*)::int FROM public.pagamenti WHERE anno_id IS NULL`, [], d)).toBe(0)
      expect(await una<number>(`SELECT count(*)::int FROM public.frequenze`, [], d)).toBe(1)
      expect(await una<number>(`SELECT count(DISTINCT fase)::int FROM public.riconciliazione_anno`, [], d)).toBe(2)
      expect((await d.query(`SELECT * FROM public.anno_riconciliazione_differenze()`)).rows).toEqual([])
      expect(await una<string>(`SELECT sum(valore)::text FROM public.riconciliazione_anno WHERE fase = 'dopo' AND voce = 'euro_importo'`, [], d)).toBe('10.50')
      expect(await una<string | null>(`SELECT current_setting('scatola_nera.senza_storico', true)`, [], d)).not.toBe('on')
    } finally { await d.close() }
  }, 60_000)
})
