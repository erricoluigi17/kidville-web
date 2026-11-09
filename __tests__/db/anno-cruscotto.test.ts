import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.7.1 · I NUMERI DEL CRUSCOTTO, DAL DATABASE (migrazione M47), in PGlite vero.
 *
 *  · `anno_cruscotto` dà i cinque blocchi (posti, risposte, quote, incrocio moduli/quota, confronto con l'anno prima);
 *  · `anno_quota_piu_voci` copia il predicato `piu_voci` di `anno_quota_voce`: la prova di PARITÀ le mette a confronto;
 *  · nessuna delle due scrive.
 *
 * Banco: la catena fino a M47 sul banco minimo + `SCHEMA_ISCRIZIONE_ANNO`. Il banco non si tocca: le colonne che mancano si
 * aggiungono qui, in `codaPrima`. Ogni prova gira in una transazione che finisce in `ROLLBACK`.
 * Le date sono FISSE (`p_oggi`): nessuna prova guarda `now()` per il risultato. Gli importi (100, 200, 250) sono esempi di prova.
 * Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '22222222-2222-4222-8222-222222222223'
const UT = '55555555-5555-4555-8555-555555555551'
const OGGI = '2027-02-10'
const ALUNNO = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`
const P = Array.from({ length: 8 }, (_, i) => ALUNNO(i + 1)) // i bambini che frequentano nel 2026/27
const N1 = ALUNNO(21)
const N2 = ALUNNO(22)

type Rec = Record<string, unknown>
type Cruscotto = {
  anno: { inizio: string; fine: string; stato: string }
  sezioni: Array<{ section_id: string | null; nome: string | null; fascia: string | null; iscritti: number }>
  fasce: Array<{ fascia: string; iscritti: number; posti: number | null; oltre: boolean }>
  risposte: { confermati: number; no: number; non_risposto: number; di_partenza: number }
  nuove: { totale: number }
  quota: Record<string, number>
  incrocio: Record<string, number>
  confronto: null | {
    ricostruito: boolean; giorno_anno_prima: string; anno_prima_etichetta: string
    questo_anno: { domande: number; conferme: number }; anno_prima: { domande: number; conferme: number }
  }
}

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
const A27 = () => ANNO_SEDE[`${S1}:2027`]
const A26 = () => ANNO_SEDE[`${S1}:2026`]

async function alunno(id: string, stato: string, creato = '2026-05-01') {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato, creato_il) VALUES ($1, $2, $3, $4)`, [id, S1, stato, creato])
}
/** Il listino e i moduli del 2027/28 di S1, e l'apertura delle iscrizioni. */
async function apri() {
  const a = A27()
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', 'nido_1', 250, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
}
async function sezione(nome: string, fascia: string | null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, $3, 'infanzia', $4) RETURNING id`,
    [S1, ANNO[2027], nome, fascia])
}
/** Una frequenza dell'anno prossimo scritta a mano, SENZA voce. */
async function frequenza(al: string, tipo: 'conferma' | 'nuova', sez: string | null = null, creata = '2026-11-09'): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, stato, data_ingresso, section_id, creata_il)
     SELECT $1, s.id, $2, 'segreteria', 'in_attesa', s.inizio, $3, $5::timestamptz FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
    [al, tipo, sez, A27(), creata])
}
const categoria = () => una<string>(`SELECT id FROM public.payment_categories WHERE slug = 'iscrizione' AND is_sistema AND scuola_id IS NULL`)
/** Una voce «Iscrizione» del 2027/28 (competenza = inizio dell'anno). Non la collega a nessuna frequenza. */
async function voce(al: string, importo: number, stato: 'da_pagare' | 'parziale' | 'pagato' | 'scaduto', pagato: number, cat?: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, stato, importo_pagato, periodo_competenza)
     SELECT $1, $2, 'Iscrizione di prova', $3, s.inizio, $4, $5, $6, s.inizio FROM public.anni_sede s WHERE s.id = $7 RETURNING id`,
    [al, S1, importo, cat ?? (await categoria()), stato, pagato, A27()])
}
async function collega(freq: string, pagamento: string) {
  await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [freq, pagamento])
}
async function spunta(freq: string, lista: 'conferma' | 'nuova') {
  await db.query(
    `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) SELECT $1, m.id FROM public.moduli_richiesti m WHERE m.anno_sede_id = $2 AND m.lista = $3`,
    [freq, A27(), lista])
}
const cruscotto = (anno = A27(), oggi: string | null = OGGI) =>
  una<Cruscotto>(`SELECT public.anno_cruscotto($1::uuid, $2::date)`, [anno, oggi])
const piuVoci = (anno = A27(), freq: string[] | null = null) =>
  db.query<{ frequenza_id: string }>(`SELECT frequenza_id FROM public.anno_quota_piu_voci($1::uuid, $2::uuid[])`, [anno, freq]).then((r) => r.rows.map((x) => x.frequenza_id))
const stato = (f: string) => una<string>(`SELECT stato FROM public.frequenze WHERE id = $1`, [f])

/**
 * Il SEME NOTO. Sei frequenze vive dell'anno nuovo e una ritirata; sette bambini che frequentano nel 2026/27.
 *   F1 conferma · sezione A (infanzia) · voce pagata 100 · moduli spuntati          → iscritto (entrambi)
 *   F2 conferma · sezione A · voce da pagare 100 · moduli spuntati                  → moduli senza quota
 *   F3 conferma · sezione B (nido_1) · voce pagata 100 · moduli NON spuntati        → quota senza moduli
 *   F4 conferma · senza sezione · nessuna voce · moduli no (creata dopo la data)    → assente, stima 100
 *   F5 nuova (N1) · sezione A · nessuna voce                                        → assente, stima 200
 *   F6 nuova (N2) · sezione B (nido_1) · nessuna voce                               → assente, stima 250 (riga nido_1)
 *   F7 conferma di P5, RITIRATA, con una voce pagata 100                            → fuori dalle vive, ma ha una voce
 * P1-P4 hanno confermato, P5 è ritirata (non conta come confermata), P6 ha detto di no, P7 e P8 non hanno risposto.
 * Posti: infanzia 2 (gli iscritti sono 3: oltre), nido_1 5.
 */
async function seme() {
  for (const [i, id] of P.entries()) await alunno(id, 'iscritto', i < 3 ? '2026-01-10' : '2026-06-01')
  await alunno(N1, 'in_arrivo')
  await alunno(N2, 'in_arrivo')
  await apri()
  const A = await sezione('Sezione A', 'infanzia')
  const B = await sezione('Sezione B', 'nido_1')
  await db.query(`INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti) VALUES ($1, 'infanzia', 2), ($1, 'nido_1', 5)`, [A27()])
  const f1 = await frequenza(P[0], 'conferma', A)
  const f2 = await frequenza(P[1], 'conferma', A)
  const f3 = await frequenza(P[2], 'conferma', B)
  const f4 = await frequenza(P[3], 'conferma', null, '2027-03-01')
  const f5 = await frequenza(N1, 'nuova', A)
  const f6 = await frequenza(N2, 'nuova', B)
  await spunta(f1, 'conferma')
  await spunta(f2, 'conferma')
  await collega(f1, await voce(P[0], 100, 'pagato', 100))
  await collega(f2, await voce(P[1], 100, 'da_pagare', 0))
  await collega(f3, await voce(P[2], 100, 'pagato', 100))
  const f7 = await frequenza(P[4], 'conferma', null)
  await collega(f7, await voce(P[4], 100, 'pagato', 100))
  await db.query(`UPDATE public.frequenze SET stato = 'ritirato' WHERE id = $1`, [f7])
  await db.query(`UPDATE public.frequenze SET non_rinnova_il = '2027-01-15T10:00:00Z', non_rinnova_motivo = 'trasloco'
                   WHERE alunno_id = $1 AND anno_sede_id = $2`, [P[5], A26()])
  return { A, B, f1, f2, f3, f4, f5, f6, f7 }
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M47', completo: true,
    codaPrima: SCHEMA_ISCRIZIONE_ANNO + `
      -- con \`completo\` il banco ha già archiviato_il e importo_retta_mensile su \`alunni\`, tipo e visibile_dal su \`pagamenti\`
      ALTER TABLE public.alunni
        ADD COLUMN anonimizzato_il timestamptz,
        ADD COLUMN creato_il timestamptz DEFAULT now();
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid,
        ADD COLUMN sconto numeric NOT NULL DEFAULT 0;
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

describe('anno_cruscotto: i cinque blocchi', () => {
  prova('un seme noto dà i cinque blocchi esatti', async () => {
    await inRollback(async () => {
      await seme()
      const c = await cruscotto()

      expect(c.anno).toMatchObject({ stato: 'iscrizioni_aperte' })
      // Posti: per sezione (il nome non è un dato personale) e per fascia, con l'avviso sui posti superati.
      expect(c.sezioni.map((s) => [s.nome, s.fascia, s.iscritti])).toEqual([
        ['Sezione A', 'infanzia', 3], ['Sezione B', 'nido_1', 2], [null, null, 1],
      ])
      expect(c.fasce).toEqual([
        { fascia: 'infanzia', iscritti: 3, posti: 2, oltre: true },
        { fascia: 'nido_1', iscritti: 2, posti: 5, oltre: false },
        { fascia: 'senza_sezione', iscritti: 1, posti: null, oltre: false },
      ])
      // Risposte: sugli otto che frequentano. P5 è ritirata nell'anno nuovo: non conta come confermata e non ha detto «no».
      expect(c.risposte).toEqual({ confermati: 4, no: 1, non_risposto: 3, di_partenza: 8 })
      // Nuove: due `nuova`; chi conferma frequenta, quindi non è «nuovo».
      expect(c.nuove).toEqual({ totale: 2 })
      // Quote: due saldate, una da pagare, tre assenti. Euro: 200 incassati, 100 da incassare, stima 100 + 200 + 250 dal listino.
      expect(c.quota).toEqual({
        saldate: 2, da_pagare: 1, assenti: 3, senza_listino: 0,
        euro_incassati: 200, euro_da_incassare: 100, euro_assenti_stimati: 550,
        ritirati_con_voce: 1, euro_ritirati_incassati: 100,
      })
      // Incrocio: le quattro caselle sommano alle vive.
      expect(c.incrocio).toEqual({
        moduli_senza_quota: 1, quota_senza_moduli: 1, entrambi: 1, nessuno_dei_due: 3, totale: 6, piu_voci: 0,
      })
    })
  })

  prova('`moduli_senza_quota` e `quota_senza_moduli` non si sovrappongono e sommano con `entrambi` e `nessuno_dei_due` a `totale`', async () => {
    await inRollback(async () => {
      await seme()
      const { incrocio: i, quota: q } = await cruscotto()
      expect(i.moduli_senza_quota + i.quota_senza_moduli + i.entrambi + i.nessuno_dei_due).toBe(i.totale)
      expect(q.saldate + q.da_pagare + q.assenti).toBe(i.totale)
      const vive = await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE anno_sede_id = $1 AND stato IN ('in_attesa', 'iscritto')`, [A27()])
      expect(i.totale).toBe(vive)
    })
  })

  prova('una quota eliminata conta come mancante, la frequenza torna `in_attesa` e il cruscotto non dà errore', async () => {
    await inRollback(async () => {
      const { f1 } = await seme()
      const prima = await cruscotto()
      expect(await stato(f1)).toBe('iscritto')
      expect(prima.quota).toMatchObject({ saldate: 2, assenti: 3 })

      const voceF1 = await una<string>(`SELECT quota_pagamento_id FROM public.frequenze WHERE id = $1`, [f1])
      await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [voceF1])

      expect(await stato(f1)).toBe('in_attesa')
      const dopo = await cruscotto()
      expect(dopo.quota).toMatchObject({ saldate: 1, da_pagare: 1, assenti: 4, euro_incassati: 100 })
      // La frequenza è ancora viva e ha i moduli: ora ha moduli senza quota.
      expect(dopo.incrocio).toMatchObject({ moduli_senza_quota: 2, entrambi: 0, totale: 6 })
    })
  })

  prova('una voce che torna indietro (stato diverso da `pagato`) è `da_pagare`, non `saldata`', async () => {
    await inRollback(async () => {
      const { f1 } = await seme()
      const voceF1 = await una<string>(`SELECT quota_pagamento_id FROM public.frequenze WHERE id = $1`, [f1])
      await db.query(`UPDATE public.pagamenti SET stato = 'parziale', importo_pagato = 40 WHERE id = $1`, [voceF1])
      const c = await cruscotto()
      expect(c.quota).toMatchObject({ saldate: 1, da_pagare: 2, euro_incassati: 140, euro_da_incassare: 160 })
    })
  })

  prova('«Da incassare» sottrae lo sconto (come `residuoEffettivo`) e non scende sotto zero', async () => {
    await inRollback(async () => {
      const { f2 } = await seme()
      const voceF2 = await una<string>(`SELECT quota_pagamento_id FROM public.frequenze WHERE id = $1`, [f2])
      // seme: la voce di F2 vale 100 e non è pagata → senza sconto restano 100 da incassare
      expect((await cruscotto()).quota).toMatchObject({ euro_da_incassare: 100 })
      await db.query(`UPDATE public.pagamenti SET sconto = 30 WHERE id = $1`, [voceF2])
      expect((await cruscotto()).quota).toMatchObject({ euro_incassati: 200, euro_da_incassare: 70 })
      await db.query(`UPDATE public.pagamenti SET sconto = 150 WHERE id = $1`, [voceF2])
      expect((await cruscotto()).quota).toMatchObject({ euro_da_incassare: 0 })
    })
  })

  prova('un bambino che ha detto di no non è nei confermati né nei non risposto, e un ritirato non conta fra le vive', async () => {
    await inRollback(async () => {
      const { f7 } = await seme()
      const c = await cruscotto()
      // P6 ha detto di no: sta solo in `no`. P5 è ritirata nell'anno nuovo: non è confermata, e non ha detto «no».
      expect(c.risposte.no).toBe(1)
      expect(c.risposte.confermati + c.risposte.no + c.risposte.non_risposto).toBe(c.risposte.di_partenza)
      expect(await stato(f7)).toBe('ritirato')
      expect(c.incrocio.totale).toBe(6)
      expect(c.sezioni.reduce((s, x) => s + x.iscritti, 0)).toBe(6)

      // Se P5 riconferma (la stessa riga si riapre) torna fra le confermate.
      await db.query(`UPDATE public.frequenze SET stato = 'in_attesa' WHERE id = $1`, [f7])
      const dopo = await cruscotto()
      expect(dopo.risposte).toEqual({ confermati: 5, no: 1, non_risposto: 2, di_partenza: 8 })
      expect(dopo.quota.ritirati_con_voce).toBe(0)
    })
  })

  prova('i posti superati danno `oltre = true` e nessuna eccezione; senza posti dichiarati `posti` è nullo', async () => {
    await inRollback(async () => {
      await seme()
      await db.query(`UPDATE public.posti_autorizzati SET posti = 0 WHERE anno_sede_id = $1`, [A27()])
      const c = await cruscotto()
      expect(c.fasce.filter((f) => f.oltre).map((f) => f.fascia)).toEqual(['infanzia', 'nido_1'])
      await db.query(`DELETE FROM public.posti_autorizzati WHERE anno_sede_id = $1`, [A27()])
      const d = await cruscotto()
      expect(d.fasce.every((f) => f.posti === null && f.oltre === false)).toBe(true)
    })
  })

  prova('senza riga di listino la quota assente va in `senza_listino` e non in euro', async () => {
    await inRollback(async () => {
      await seme()
      // Tolte le due righe della quota delle nuove: F5 e F6 non hanno una riga da cui stimare.
      await db.query(`DELETE FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_nuova'`, [A27()])
      const c = await cruscotto()
      expect(c.quota).toMatchObject({ assenti: 3, senza_listino: 2, euro_assenti_stimati: 100 })
    })
  })

  prova('un anno vuoto dà tutti zero, senza divisioni e senza errori', async () => {
    await inRollback(async () => {
      const c = await cruscotto()
      expect(c.sezioni).toEqual([])
      expect(c.risposte).toEqual({ confermati: 0, no: 0, non_risposto: 0, di_partenza: 0 })
      expect(c.nuove.totale).toBe(0)
      expect(c.incrocio).toEqual({ moduli_senza_quota: 0, quota_senza_moduli: 0, entrambi: 0, nessuno_dei_due: 0, totale: 0, piu_voci: 0 })
      expect(c.quota).toMatchObject({ saldate: 0, da_pagare: 0, assenti: 0, euro_incassati: 0, euro_da_incassare: 0, euro_assenti_stimati: 0 })
    })
  })

  prova('un anno che non c\'è risponde ANNO_NON_TROVATO', async () => {
    await inRollback(async () => {
      await db.exec('SAVEPOINT x')
      let messaggio = ''
      try { await cruscotto('99999999-9999-4999-8999-999999999999') } catch (e) { messaggio = (e as Error).message }
      await db.exec('ROLLBACK TO SAVEPOINT x')
      expect(messaggio).toBe('ANNO_NON_TROVATO')
    })
  })

  prova('con due chiamate di fila lo stesso risultato (nessuno stato nascosto)', async () => {
    await inRollback(async () => {
      await seme()
      expect(await cruscotto()).toEqual(await cruscotto())
    })
  })
})

describe('anno_cruscotto: il confronto con la stessa data dell\'anno prima', () => {
  async function domande(anno: number, date: string[]) {
    for (const d of date) {
      await db.query(`INSERT INTO public.enrollment_submissions (scuola_id, anno_id, created_at) VALUES ($1, $2, $3::timestamptz)`, [S1, ANNO[anno], d])
    }
  }

  prova('con le frequenze dell\'anno prima tutte `recupero` le conferme sono `ricostruito`, dalle date di creazione dei bambini', async () => {
    await inRollback(async () => {
      await seme()
      await domande(2027, ['2027-01-05T09:00:00Z', '2027-02-01T09:00:00Z', '2027-03-01T09:00:00Z'])
      await domande(2026, ['2026-01-20T09:00:00Z', '2026-02-09T09:00:00Z', '2026-02-10T09:00:00Z', '2026-02-11T09:00:00Z'])
      const c = await cruscotto()
      expect(c.confronto).toEqual({
        ricostruito: true,
        giorno_anno_prima: '2026-02-10',
        anno_prima_etichetta: '2026/27',
        // `conferma` VIVE con `creata_il` fino al 10/02/2027: F1, F2, F3 (F4 è del 01/03/2027; F7 è ritirata e, come in «Hanno confermato»,
        // non conta: revisione finale, secondario 6).
        questo_anno: { domande: 2, conferme: 3 },
        // Prima: 3 domande entro il 10/02/2026 compreso; 3 bambini creati prima di quel giorno hanno una frequenza nel 2026/27.
        anno_prima: { domande: 3, conferme: 3 },
      })
    })
  })

  prova('con una `creata_il` vera l\'anno prima non è ricostruito: le conferme sono le frequenze `conferma` fino a quel giorno', async () => {
    await inRollback(async () => {
      await seme()
      await db.query(
        `UPDATE public.frequenze SET origine = 'segreteria', tipo = 'conferma',
                creata_il = CASE WHEN alunno_id = ANY ($2::uuid[]) THEN '2026-01-12T10:00:00Z'::timestamptz ELSE '2026-03-01T10:00:00Z'::timestamptz END
          WHERE anno_sede_id = $1`, [A26(), [P[0], P[1]]])
      const c = await cruscotto()
      expect(c.confronto?.ricostruito).toBe(false)
      expect(c.confronto?.anno_prima.conferme).toBe(2)
    })
  })

  prova('il 29/02 dà il 28/02 dell\'anno prima senza errore', async () => {
    await inRollback(async () => {
      await seme()
      const c = await cruscotto(A27(), '2028-02-29')
      expect(c.confronto?.giorno_anno_prima).toBe('2027-02-28')
    })
  })

  prova('la sede che non ha un anno prima ha `confronto` nullo', async () => {
    await inRollback(async () => {
      const c = await cruscotto(ANNO_SEDE[`${S1}:2025`])
      expect(c.confronto).toBeNull()
    })
  })

  prova('un anno prima senza nessuna frequenza non è «ricostruito» e dà zero conferme', async () => {
    await inRollback(async () => {
      await db.query(`DELETE FROM public.frequenze WHERE anno_sede_id = $1`, [A26()])
      const c = await cruscotto()
      expect(c.confronto).toMatchObject({ ricostruito: false, anno_prima: { conferme: 0 } })
    })
  })
})

describe('anno_quota_piu_voci: la parità con `anno_quota_voce`', () => {
  /** Chi ha a che fare con quante voci «Iscrizione» del 2027/28: ogni caso è un bambino con la sua frequenza di conferma. */
  async function casi() {
    await apri()
    const altra = await una<string>(`INSERT INTO public.payment_categories (scuola_id, nome, slug) VALUES ($1, 'Altro', 'altro') RETURNING id`, [S1])
    const f: Record<string, string> = {}
    const nuovo = async (nome: string, n: number) => { await alunno(ALUNNO(40 + n), 'iscritto'); f[nome] = await frequenza(ALUNNO(40 + n), 'conferma') }
    await nuovo('nessuna', 0)
    await nuovo('una', 1)
    await voce(ALUNNO(41), 100, 'da_pagare', 0)
    await nuovo('due', 2)
    await voce(ALUNNO(42), 100, 'da_pagare', 0)
    await voce(ALUNNO(42), 100, 'da_pagare', 0)
    await nuovo('due_di_cui_una_di_altra_categoria', 3)
    await voce(ALUNNO(43), 100, 'da_pagare', 0)
    await voce(ALUNNO(43), 100, 'da_pagare', 0, altra)
    await nuovo('archiviata_con_due', 4)
    await voce(ALUNNO(44), 100, 'da_pagare', 0)
    await voce(ALUNNO(44), 100, 'da_pagare', 0)
    await db.query(`UPDATE public.alunni SET archiviato_il = '2026-10-01T00:00:00Z' WHERE id = $1`, [ALUNNO(44)])
    await nuovo('senza_competenza_e_con', 5)
    await voce(ALUNNO(45), 100, 'da_pagare', 0)
    await db.query(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, stato, importo_pagato, periodo_competenza)
       SELECT $1, $2, 'Iscrizione di prova', 100, s.inizio + 10, $3, 'da_pagare', 0, NULL FROM public.anni_sede s WHERE s.id = $4`,
      [ALUNNO(45), S1, await categoria(), A27()])
    await nuovo('una_di_un_altro_anno', 6)
    await db.query(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, stato, importo_pagato, periodo_competenza)
       VALUES ($1, $2, 'Iscrizione di prova', 100, DATE '2026-09-10', $3, 'da_pagare', 0, DATE '2026-09-01')`,
      [ALUNNO(46), S1, await categoria()])
    await voce(ALUNNO(46), 100, 'da_pagare', 0)
    await nuovo('gia_collegata_e_altra_voce', 7)
    await collega(f.gia_collegata_e_altra_voce, await voce(ALUNNO(47), 100, 'da_pagare', 0))
    await voce(ALUNNO(47), 100, 'da_pagare', 0)
    return f
  }
  const esito = (freq: string) => una<Rec>(`SELECT public.anno_quota_voce($1::uuid, $2::uuid, $3::date)`, [freq, UT, OGGI]).then((r) => r.esito as string)

  prova('elenca la frequenza SE E SOLO SE `anno_quota_voce` risponderebbe `piu_voci`', async () => {
    await inRollback(async () => {
      const f = await casi()
      const elenco = await piuVoci()
      const attesi: Record<string, boolean> = {
        nessuna: false, una: false, due: true, due_di_cui_una_di_altra_categoria: false, archiviata_con_due: false,
        senza_competenza_e_con: true, una_di_un_altro_anno: false, gia_collegata_e_altra_voce: false,
      }
      for (const [nome, id] of Object.entries(f)) {
        expect(elenco.includes(id), `${nome}: elenco`).toBe(attesi[nome])
        // La parità: quello che dice la funzione di scrittura, sullo stesso bambino. (Poi può scrivere: il confronto è già fatto.)
        const e = await esito(id)
        expect(e === 'piu_voci', `${nome}: anno_quota_voce dice ${e}`).toBe(attesi[nome])
      }
      expect(elenco.length).toBe(2)
    })
  })

  prova('`p_frequenze` limita il calcolo alle righe chieste', async () => {
    await inRollback(async () => {
      const f = await casi()
      expect(await piuVoci(A27(), [f.due])).toEqual([f.due])
      expect(await piuVoci(A27(), [f.una, f.nessuna])).toEqual([])
      expect(await piuVoci(A27(), [])).toEqual([])
    })
  })

  prova('il cruscotto conta le «più voci» fra le assenti, non nella stima in euro', async () => {
    await inRollback(async () => {
      await casi()
      const c = await cruscotto()
      expect(c.incrocio.piu_voci).toBe(2)
      // Assenti = le sette vive senza voce collegata (tutte tranne `gia_collegata_e_altra_voce`).
      expect(c.quota.assenti).toBe(7)
      // Stima: le 5 che non hanno più voci (una di loro archiviata non è esclusa: la funzione di scrittura risponde a parte) × 100.
      expect(c.quota.euro_assenti_stimati).toBe(500)
    })
  })
})

describe('le due funzioni non scrivono niente', () => {
  prova('sono STABLE e non cambiano il conteggio di `pagamenti`, `frequenze` e `app_log`', async () => {
    await inRollback(async () => {
      const r = await db.query<{ proname: string; provolatile: string; secdef: boolean }>(
        `SELECT proname, provolatile, prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND proname IN ('anno_cruscotto', 'anno_quota_piu_voci') ORDER BY 1`)
      expect(r.rows).toEqual([
        { proname: 'anno_cruscotto', provolatile: 's', secdef: true },
        { proname: 'anno_quota_piu_voci', provolatile: 's', secdef: true },
      ])
      await seme()
      const conta = () => una<string>(
        `SELECT (SELECT count(*) FROM public.pagamenti)::text || '/' || (SELECT count(*) FROM public.frequenze)::text || '/' || (SELECT count(*) FROM public.app_log)::text`)
      const prima = await conta()
      await cruscotto()
      await piuVoci()
      await cruscotto(A26())
      expect(await conta()).toBe(prima)
    })
  })

  prova('solo il servizio le può eseguire', async () => {
    const r = await db.query<{ proname: string; anon: boolean; auth: boolean }>(
      `SELECT proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname IN ('anno_cruscotto', 'anno_quota_piu_voci')`)
      .catch(() => ({ rows: [] as Array<{ proname: string; anon: boolean; auth: boolean }> }))
    // Se il banco non ha i ruoli `anon` e `authenticated` la query non è applicabile: la prova vale dove i ruoli ci sono.
    for (const x of r.rows) {
      expect(x.anon, `${x.proname}: anon`).toBe(false)
      expect(x.auth, `${x.proname}: authenticated`).toBe(false)
    }
  })
})
