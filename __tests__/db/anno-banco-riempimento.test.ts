import { describe, it, expect } from 'vitest'
import { creaDbAnno, creaAnniFissi, applicaPr2, SCHEMA_PR2, SCHEMA_PR2_RIEMPIMENTO } from '../helpers/schema-anno-pglite'

/**
 * BANCO DI MISURA · il riempimento sul seme di dimensioni vere (Compito 2.2).
 *
 * Gira SOLO con `KIDVILLE_BANCO_ANNO=1`; senza la variabile salta. Nessuna asserzione sui tempi: sarebbero
 * instabili. Si asserisce che ogni tabella sia stata riempita fino all'ultima riga. PGlite non è Postgres in
 * produzione (WASM, un processo, niente disco): i numeri valgono come ORDINE DI GRANDEZZA.
 *
 * REGOLA DI DECISIONE (dalla scheda del compito): tempo totale di `anno_riempi()` in PGlite < 15 s → i file di
 * riempimento F2 e F3 si FONDONO in F1 (produzione ≈ PGlite × 4, da tenere sotto un minuto); altrimenti restano
 * tre file. Il codice è lo stesso: cambia solo quante volte si chiama `anno_riempi()`.
 *
 * Dimensioni (produzione, 06/11/2026): eventi_diario 65.000, presenze 31.000, chat_messages 20.000,
 * galleria_media_v2 10.500, avvisi_risposte 11.000, gallery_photo_uploads 6.000, pagamenti 3.500,
 * mensa_prenotazioni 2.500, 811 alunni, 20.000 righe di storico. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const attivo = process.env.KIDVILLE_BANCO_ANNO === '1'
const GRANDI = ['eventi_diario', 'presenze', 'chat_messages']

describe.runIf(attivo)('banco anno · anno_riempi() sul seme pieno', () => {
  it('misura e stampa i tempi tabella per tabella', async () => {
    const db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE], codaPrima: SCHEMA_PR2 + SCHEMA_PR2_RIEMPIMENTO })
    await creaAnniFissi(db, [SEDE])
    await applicaPr2(db, 'M1')
    const una = async <T,>(sql: string) => Object.values((await db.query<Record<string, T>>(sql)).rows[0])[0] as T
    const conta = (t: string, doveNull = false) =>
      una<number>(`SELECT count(*)::int FROM public.${t}${doveNull ? ' WHERE anno_id IS NULL' : ''}`)

    // il seme nasce COME OGGI, senza `anno_id`: il trigger generico è spento mentre si scrive
    const tabelle = ['eventi_diario', 'presenze', 'chat_messages', 'galleria_media_v2', 'avvisi', 'avvisi_risposte',
      'gallery_photo_uploads', 'pagamenti', 'mensa_prenotazioni']
    for (const t of tabelle) await db.exec(`ALTER TABLE public.${t} DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
    // date fra il 07/07/2026 e il 11/12/2026 (la forbice vera: luglio e agosto sono del 2025/26)
    const giorno = `DATE '2026-07-07' + (g % 158)`
    await db.exec(`
      INSERT INTO public.alunni (id, scuola_id, importo_retta_mensile)
        SELECT gen_random_uuid(), '${SEDE}', CASE WHEN g % 8 = 0 THEN 0 ELSE 300 END FROM generate_series(1, 811) g;
      INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, dal)
        SELECT a.id, '${SEDE}', DATE '2026-09-01' + (g % 5) FROM public.alunni a CROSS JOIN generate_series(1, 25) g LIMIT 20000;
      CREATE TEMP TABLE an AS SELECT id, (row_number() OVER ()) - 1 AS n FROM public.alunni;
      INSERT INTO public.eventi_diario (alunno_id, orario_inizio)
        SELECT an.id, TIMESTAMPTZ '2026-07-07 09:00:00+00' + (g % 158) * interval '1 day'
          FROM generate_series(1, 65000) g JOIN an ON an.n = g % 811;
      INSERT INTO public.presenze (scuola_id, data) SELECT '${SEDE}', ${giorno} FROM generate_series(1, 31000) g;
      INSERT INTO public.chat_threads (student_id) SELECT id FROM public.alunni;
      CREATE TEMP TABLE th AS SELECT id, (row_number() OVER ()) - 1 AS n FROM public.chat_threads;
      INSERT INTO public.chat_messages (thread_id, created_at)
        SELECT th.id, TIMESTAMPTZ '2026-09-01 09:00:00+00' + (g % 60) * interval '1 day'
          FROM generate_series(1, 20000) g JOIN th ON th.n = g % 811;
      INSERT INTO public.galleria_media_v2 (scuola_id, giorno_competenza, target_classes)
        SELECT '${SEDE}', ${giorno}, '{Girasoli}' FROM generate_series(1, 10500) g;
      INSERT INTO public.gallery_photo_uploads (media_id) SELECT id FROM public.galleria_media_v2 LIMIT 6000;
      INSERT INTO public.avvisi (scuola_id, giorno_competenza, target_classes)
        SELECT '${SEDE}', ${giorno}, '{Girasoli,Delfini}' FROM generate_series(1, 293) g;
      CREATE TEMP TABLE av AS SELECT id, (row_number() OVER ()) - 1 AS n FROM public.avvisi;
      INSERT INTO public.avvisi_risposte (avviso_id) SELECT av.id FROM generate_series(1, 11000) g JOIN av ON av.n = g % 293;
      INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza)
        SELECT '${SEDE}', 'voce', 100, DATE '2026-09-05' + (g % 150), DATE '2026-09-01' + (g % 150) FROM generate_series(1, 3500) g;
      INSERT INTO public.mensa_prenotazioni (scuola_id, data) SELECT '${SEDE}', ${giorno} FROM generate_series(1, 2500) g;
    `)
    await db.exec(`INSERT INTO public.sections (scuola_id, name) VALUES ('${SEDE}', 'Girasoli')`)
    for (const t of tabelle) await db.exec(`ALTER TABLE public.${t} ENABLE TRIGGER trg_zz_anno_assegna_e_verifica`)

    const righe: Array<[string, number, number]> = []
    const tempo = async (nome: string, f: () => Promise<unknown>) => {
      const t = performance.now()
      await f()
      righe.push([nome, Math.round(performance.now() - t), 0])
    }

    await tempo('anno_fotografa(prima)', () => db.query(`SELECT public.anno_fotografa('prima')`))
    // il lavoro di sede (anno successivo, frequenze, listino, copia) e poi ogni tabella, nell'ordine di anno_riempi
    await tempo('frequenze + listino + anno successivo (811 alunni)', () => db.query(`SELECT public.anno_riempi(ARRAY['frequenze'])`))
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze`)).toBe(811)
    const ordine = (await db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_tabelle ORDER BY tabella`)).rows.map((r) => r.tabella)
    for (const t of ordine) {
      if (t === 'frequenze') continue
      const prima = await conta(t, true)
      await tempo(`${t} (${prima} da riempire)`, () => db.query(`SELECT public.anno_riempi(ARRAY['${t}'])`))
      righe[righe.length - 1][2] = prima
      expect(await conta(t, true)).toBe(0)
    }
    await tempo('anno_fotografa(dopo)', () => db.query(`SELECT public.anno_fotografa('dopo')`))
    await tempo('anno_invarianti() sul seme pieno', () => db.query(`SELECT * FROM public.anno_invarianti()`))
    const diff = await db.query(`SELECT * FROM public.anno_riconciliazione_differenze()`)
    expect(diff.rows).toEqual([])

    const somma = (filtro: (n: string) => boolean) => righe.filter(([n]) => filtro(n)).reduce((s, [, ms]) => s + ms, 0)
    const riempimento = somma((n) => !n.startsWith('anno_'))
    const grandi = somma((n) => GRANDI.some((g) => n.startsWith(g + ' ')))
    console.log(
      '\nBANCO RIEMPIMENTO (PGlite: ordine di grandezza)\n' +
      righe.map(([n, ms]) => `${String(ms).padStart(7)} ms  ${n}`).join('\n') +
      `\nTOTALE anno_riempi (senza fotografie e invarianti): ${riempimento} ms; le tre grandi: ${grandi} ms` +
      `\nREGOLA: ${riempimento < 15_000 ? 'sotto i 15 s → F2 e F3 si fondono in F1' : 'sopra i 15 s → tre file (F1, F2, F3)'}\n`)
    await db.close()
  }, 900_000)
})
