// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaAlunno, creaBancoRette, creaFrequenza, creaSezione, errore, inRollback, listino, righe as righeSu, SEDE_A, SEDE_B, uuidFinto, una,
  type MappaAnni,
} from '../helpers/banco-rette-pglite'

/**
 * COMPITO 4.6.1 · M46a · LE RETTE SI GENERANO DAL LISTINO E DALLE FREQUENZE DELL'ANNO, in PGlite vero.
 *
 * Il corpo di `genera_rette_mensili` non sta in nessun file di migrazione (lo riscrive con `replace()` una migrazione del
 * 07/09): per questo le formule si provano contro un ORACOLO SCRITTO A MANO (scadenza, visibilità, sconti), non contro il
 * codice. Ogni prova gira in una transazione che finisce in ROLLBACK. Nessun `now()`: i periodi si passano. Solo uuid finti.
 *
 * Calendario di prova: 2025/26 chiuso, 2026/27 corrente (01/09/2026-31/08/2027), 2027/28 in preparazione; le prove che
 * generano per il 2027/28 lo portano a `iscrizioni_aperte`.
 */

let db: PGlite
const righe = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => righeSu<T>(db, sql, params)
let anni: MappaAnni
const prova = (nome: string, fn: () => Promise<void>) => it(nome, () => inRollback(db, fn), 30_000)

beforeAll(async () => {
  ;({ db, anni } = await creaBancoRette())
}, 120_000)
afterAll(async () => {
  await db?.close()
})

const A26 = () => anni[`${SEDE_A}:2026`]
const A27 = () => anni[`${SEDE_A}:2027`]

async function apriIscrizioni2027(): Promise<void> {
  await db.query(`UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = $1`, [A27()])
}
async function bambino(o: Parameters<typeof creaAlunno>[2] & { anno?: number; retta?: number | null; esente?: boolean; aCaricoDi?: string | null; ingresso?: string; stato?: never } = {}) {
  const id = uuidFinto('1')
  await creaAlunno(db, id, o)
  await creaFrequenza(db, anni, id, { anno: o.anno ?? 2026, retta: o.retta, esente: o.esente, aCaricoDi: o.aCaricoDi, ingresso: o.ingresso, sede: o.sede })
  return id
}
async function riga(annoSede: string, periodo: string, alunno: string) {
  const r = await righe<{ esito: string; importo: string | null; origine_importo: string | null; gia_generato: boolean; posizione: number; frequenza_id: string }>(
    `SELECT esito, importo::text, origine_importo, gia_generato, posizione, frequenza_id FROM public.rette_da_generare($1, $2::date) WHERE alunno_id = $3`,
    [annoSede, periodo, alunno])
  return r[0]
}
async function genera(periodo: string, sede = SEDE_A, anno: string | null = null): Promise<number> {
  return Number(await una(db, `SELECT public.genera_rette_mensili($1::date, $2::uuid, NULL::uuid[], $3::uuid)`, [periodo, sede, anno]))
}
async function voci(alunno?: string) {
  return righe<{ importo: string; sconto: string; sconto_motivo: string | null; scadenza: string; visibile_dal: string; descrizione: string; gruppo: string; stato: string; tipo: string; periodo_competenza: string }>(
    `SELECT importo::text, sconto::text, sconto_motivo, scadenza::text, visibile_dal::text, descrizione, gruppo, stato, tipo::text, periodo_competenza::text
       FROM public.pagamenti ${alunno ? 'WHERE alunno_id = $1' : ''} ORDER BY periodo_competenza, alunno_id`, alunno ? [alunno] : [])
}

describe('1. nessuna voce da 150 inventata', () => {
  prova('una sede senza riga `retta` nel listino: senza_importo, e la generazione scrive ZERO voci', async () => {
    const a = await bambino()
    const r = await riga(A26(), '2026-10-01', a)
    expect(r.esito).toBe('senza_importo')
    expect(r.importo).toBeNull()
    expect(r.origine_importo).toBeNull()
    expect(await genera('2026-10-01')).toBe(0)
    expect(await voci()).toHaveLength(0)
    // il default di sede resta a 150: la generazione non lo legge più
    expect(Number(await una(db, `SELECT retta_default_importo FROM public.admin_settings WHERE scuola_id = $1`, [SEDE_A]))).toBe(150)
  })

  prova('un listino con importo NULL non conta: ancora senza_importo', async () => {
    await listino(db, anni, 2026, null)
    const a = await bambino()
    expect((await riga(A26(), '2026-10-01', a)).esito).toBe('senza_importo')
  })
})

describe('2. l’ordine dell’importo e la sua origine', () => {
  prova('la retta della frequenza batte la fascia del listino, che batte il listino senza fascia', async () => {
    await listino(db, anni, 2026, 250)
    await listino(db, anni, 2026, 280, { fascia: 'infanzia' })
    const sezInfanzia = await creaSezione(db, anni, 'Girasoli', 'infanzia')
    const sezSenzaFascia = await creaSezione(db, anni, 'Margherite', null)
    const sezNido = await creaSezione(db, anni, 'Pulcini', 'nido_1') // fascia senza riga di listino
    const a1 = uuidFinto(); await creaAlunno(db, a1, { sezione: sezInfanzia }); await creaFrequenza(db, anni, a1, { retta: 310, sezione: sezInfanzia })
    const a2 = uuidFinto(); await creaAlunno(db, a2, { sezione: sezInfanzia }); await creaFrequenza(db, anni, a2, { sezione: sezInfanzia })
    const a3 = uuidFinto(); await creaAlunno(db, a3, { sezione: sezSenzaFascia }); await creaFrequenza(db, anni, a3, { sezione: sezSenzaFascia })
    const a4 = uuidFinto(); await creaAlunno(db, a4, { sezione: sezNido }); await creaFrequenza(db, anni, a4, { sezione: sezNido })
    const r1 = await riga(A26(), '2026-10-01', a1)
    const r2 = await riga(A26(), '2026-10-01', a2)
    const r3 = await riga(A26(), '2026-10-01', a3)
    const r4 = await riga(A26(), '2026-10-01', a4)
    expect([r1.importo, r1.origine_importo]).toEqual(['310.00', 'frequenza'])
    expect([r2.importo, r2.origine_importo]).toEqual(['280.00', 'listino_fascia'])
    expect([r3.importo, r3.origine_importo]).toEqual(['250.00', 'listino'])
    expect([r4.importo, r4.origine_importo]).toEqual(['250.00', 'listino'])
    expect([r1.esito, r2.esito, r3.esito, r4.esito]).toEqual(['da_generare', 'da_generare', 'da_generare', 'da_generare'])
  })
})

describe('3. gli esenti non hanno voci', () => {
  prova('retta_esente: esito esente, nessuna voce, anche con una retta scritta', async () => {
    await listino(db, anni, 2026, 250)
    const a = await bambino({ esente: true, retta: 300 })
    const r = await riga(A26(), '2026-10-01', a)
    expect(r.esito).toBe('esente')
    expect(r.importo).toBeNull()
    expect(await genera('2026-10-01')).toBe(0)
    expect(await voci()).toHaveLength(0)
  })
})

describe('4. lo zero non esiste', () => {
  prova('il CHECK della tabella rifiuta una retta a 0, e le funzioni non portano né NULLIF né 150', async () => {
    const a = uuidFinto(); await creaAlunno(db, a)
    expect(await errore(db, `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, data_ingresso, retta_mensile)
      SELECT $1, s.id, s.anno_id, s.scuola_id, 'recupero', 'iscritto', s.inizio, 0 FROM public.anni_sede s WHERE s.id = $2`, [a, A26()]))
      .toMatch(/frequenze_retta_mensile_check/)
    for (const f of ['genera_rette_mensili', 'genera_rette_anno', 'rette_da_generare', 'listino_periodi', 'listino_mesi']) {
      const def = await una(db, `SELECT string_agg(pg_get_functiondef(p.oid), E'\\n') FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f])
      expect(def, f).toBeTruthy()
      expect(def, `${f} non deve avere NULLIF(…, 0)`).not.toMatch(/NULLIF\s*\([^()]*,\s*0\s*\)/i)
      expect(def, `${f} non deve avere un 150`).not.toMatch(/\b150\b/)
      expect(def, `${f} non deve leggere il default di sede`).not.toMatch(/retta_default_importo/)
      expect(def, `${f} non deve leggere CURRENT_DATE né now()`).not.toMatch(/CURRENT_DATE|\bnow\s*\(/i)
    }
  })
})

describe('5. il fratello che paga viene dalla frequenza dell’anno giusto', () => {
  prova('A paga per B solo nel 2026/27; nel 2027/28 B riceve la sua retta', async () => {
    await listino(db, anni, 2026, 250)
    await listino(db, anni, 2027, 260)
    await apriIscrizioni2027()
    const a = uuidFinto(); await creaAlunno(db, a)
    const b = uuidFinto(); await creaAlunno(db, b)
    await creaFrequenza(db, anni, a, { anno: 2026 })
    await creaFrequenza(db, anni, b, { anno: 2026, aCaricoDi: a })
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa' })
    await creaFrequenza(db, anni, b, { anno: 2027, stato: 'in_attesa' })
    expect(await riga(A26(), '2026-10-01', b)).toBeUndefined() // paga A per tutta la famiglia: nessuna riga
    expect((await riga(A26(), '2026-10-01', a)).esito).toBe('da_generare')
    const r27 = await riga(A27(), '2027-10-01', b)
    expect([r27.esito, r27.importo]).toEqual(['da_generare', '260.00'])
    expect(await genera('2026-10-01')).toBe(1)
    expect(await genera('2027-10-01', SEDE_A, A27())).toBe(2)
  })

  prova('un pagante senza frequenza viva nell’anno: pagante_assente, nessuna voce', async () => {
    await listino(db, anni, 2026, 250)
    const pagante = uuidFinto(); await creaAlunno(db, pagante)
    await creaFrequenza(db, anni, pagante, { anno: 2025, stato: 'uscito', ingresso: '2025-09-01', uscita: '2026-06-30' })
    const b = uuidFinto(); await creaAlunno(db, b)
    await creaFrequenza(db, anni, b, { anno: 2026, aCaricoDi: pagante })
    const r = await riga(A26(), '2026-10-01', b)
    expect(r.esito).toBe('pagante_assente')
    expect(r.importo).toBeNull()
    expect(await genera('2026-10-01')).toBe(0)
  })
})

describe('6. la posizione fra i fratelli si conta nello stesso anno', () => {
  prova('il fratello maggiore ha la frequenza solo nel 2026/27: nel 2027/28 il minore è in posizione 1', async () => {
    await listino(db, anni, 2026, 250)
    await listino(db, anni, 2027, 250)
    const gen = '77777777-7777-4777-8777-777777777771'
    const maggiore = uuidFinto(); await creaAlunno(db, maggiore, { nascita: '2020-01-10' })
    const minore = uuidFinto(); await creaAlunno(db, minore, { nascita: '2022-05-10' })
    await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2), ($1, $3)`, [gen, maggiore, minore])
    await creaFrequenza(db, anni, maggiore, { anno: 2026 })
    await creaFrequenza(db, anni, minore, { anno: 2026 })
    await creaFrequenza(db, anni, minore, { anno: 2027, stato: 'in_attesa' })
    expect((await riga(A26(), '2026-10-01', minore)).posizione).toBe(2)
    expect((await riga(A26(), '2026-10-01', maggiore)).posizione).toBe(1)
    expect((await riga(A27(), '2027-10-01', minore)).posizione).toBe(1)
  })
})

describe('7. i mesi vengono dal listino', () => {
  prova('mesi NULL: i dieci mesi di sempre, settembre-giugno', async () => {
    await listino(db, anni, 2026, 250)
    const p = await righe<{ d: string }>(`SELECT x::text d FROM public.listino_periodi($1, 'retta') x`, [A26()])
    expect(p.map((x) => x.d)).toEqual([
      '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01'])
  })

  prova('{9,10,11}: tre periodi; {7}: luglio DENTRO l’anno; senza riga: ancora i dieci', async () => {
    await listino(db, anni, 2026, 250, { mesi: [9, 10, 11] })
    expect((await righe(`SELECT 1 FROM public.listino_periodi($1, 'retta')`.replace('$1', `'${A26()}'`))).length).toBe(3)
    await db.query(`UPDATE public.listino_voci SET mesi = '{7}' WHERE anno_sede_id = $1`, [A26()])
    expect((await righe<{ d: string }>(`SELECT x::text d FROM public.listino_periodi($1, 'retta') x`, [A26()])).map((x) => x.d)).toEqual(['2027-07-01'])
    expect(Number(await una(db, `SELECT cardinality(public.listino_mesi($1, 'retta'))`, [A27()]))).toBe(10)
  })

  prova('un mese il cui primo giorno è fuori dall’anno si scarta', async () => {
    await db.query(`UPDATE public.anni_sede SET fine = '2028-06-15', ultimo_giorno_aperto = '2028-06-15' WHERE id = $1`, [A27()])
    await listino(db, anni, 2027, 250, { mesi: [6, 7] })
    const p = await righe<{ d: string }>(`SELECT x::text d FROM public.listino_periodi($1, 'retta') x`, [A27()])
    expect(p.map((x) => x.d)).toEqual(['2028-06-01'])
  })

  prova('`genera_rette_anno` genera solo i mesi del listino', async () => {
    await listino(db, anni, 2026, 250, { mesi: [9, 10, 11] })
    await bambino()
    expect(Number(await una(db, `SELECT public.genera_rette_anno(2026, $1::uuid, NULL::uuid[], NULL::uuid)`, [SEDE_A]))).toBe(3)
    expect((await voci()).map((v) => v.periodo_competenza)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01'])
  })
})

describe('8. il pro-rata guarda l’ingresso, e non scatta a chi è dentro dall’inizio', () => {
  const CONFIG = JSON.stringify({ pro_rata_iscrizione: { enabled: true, scaglioni: [{ dal_giorno: 1, percentuale: 100 }, { dal_giorno: 16, percentuale: 50 }] } })

  prova('ingresso = inizio dell’anno: nessuno sconto. Ingresso il 18/10: sconto solo a ottobre', async () => {
    await listino(db, anni, 2026, 200)
    await db.query(`UPDATE public.admin_settings SET rette_config = $2::jsonb WHERE scuola_id = $1`, [SEDE_A, CONFIG])
    const dentro = await bambino()
    const tardi = await bambino({ ingresso: '2026-10-18' })
    expect(await genera('2026-09-01')).toBe(1) // il bambino entrato il 18/10 non ha la retta di settembre
    expect(await genera('2026-10-01')).toBe(2)
    expect(await genera('2026-11-01')).toBe(2)
    const v = await voci(dentro)
    expect(v.map((x) => x.sconto)).toEqual(['0.00', '0.00', '0.00'])
    const t = await voci(tardi)
    expect(t.map((x) => [x.periodo_competenza, x.sconto, x.sconto_motivo])).toEqual([
      ['2026-10-01', '100.00', 'Pro-rata iscrizione'],
      ['2026-11-01', '0.00', null],
    ])
  })

  prova('una frequenza «conferma» dell’anno prossimo con ingresso = inizio: nessuno sconto', async () => {
    await listino(db, anni, 2027, 200)
    await apriIscrizioni2027()
    await db.query(`UPDATE public.admin_settings SET rette_config = $2::jsonb WHERE scuola_id = $1`, [SEDE_A, CONFIG])
    const a = uuidFinto(); await creaAlunno(db, a)
    await creaFrequenza(db, anni, a, { anno: 2026 })
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa', tipo: 'conferma', origine: 'conferma' })
    expect(await genera('2027-09-01', SEDE_A, A27())).toBe(1)
    expect((await voci(a))[0].sconto).toBe('0.00')
  })
})

describe('9. gli stati dell’anno e i codici', () => {
  prova('in_preparazione → ANNO_NON_APERTO; chiuso → ANNO_CHIUSO; iscrizioni_aperte genera', async () => {
    await listino(db, anni, 2027, 260)
    const a = uuidFinto(); await creaAlunno(db, a)
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa' })
    expect(await errore(db, `SELECT public.genera_rette_mensili('2027-10-01', $1, NULL, NULL)`, [SEDE_A])).toBe('ANNO_NON_APERTO')
    expect(await errore(db, `SELECT public.genera_rette_mensili('2025-10-01', $1, NULL, NULL)`, [SEDE_A])).toBe('ANNO_CHIUSO')
    expect(await errore(db, `SELECT public.genera_rette_anno(2027, $1, NULL, NULL)`, [SEDE_A])).toBe('ANNO_NON_APERTO')
    await apriIscrizioni2027()
    expect(await genera('2027-10-01')).toBe(1)
  })

  prova('periodo fuori anno → ANNO_NON_COERENTE; sede diversa → ANNO_NON_DELLA_SEDE', async () => {
    expect(await errore(db, `SELECT public.genera_rette_mensili('2030-01-01', $1, NULL, NULL)`, [SEDE_A])).toBe('ANNO_NON_COERENTE')
    expect(await errore(db, `SELECT public.genera_rette_mensili('2025-10-01', $1, NULL, $2)`, [SEDE_A, A26()])).toBe('ANNO_NON_COERENTE')
    expect(await errore(db, `SELECT public.genera_rette_mensili('2026-10-01', $1, NULL, $2)`, [SEDE_A, anni[`${SEDE_B}:2026`]])).toBe('ANNO_NON_DELLA_SEDE')
    expect(await errore(db, `SELECT * FROM public.rette_da_generare($1, '2030-01-01')`, [A26()])).toBe('ANNO_NON_COERENTE')
    expect(await errore(db, `SELECT * FROM public.rette_da_generare($1, '2026-10-05')`, [A26()])).toBe('ANNO_NON_COERENTE')
    expect(await errore(db, `SELECT public.genera_rette_anno(2027, $1, NULL, $2)`, [SEDE_A, A26()])).toBe('ANNO_NON_COERENTE')
  })
})

describe('10. la deduplica', () => {
  prova('rigenerare non crea doppioni; gia_generato lo dice; il secondo giro ritorna 0', async () => {
    await listino(db, anni, 2026, 250)
    const a = await bambino()
    expect(await genera('2026-10-01')).toBe(1)
    expect((await riga(A26(), '2026-10-01', a)).gia_generato).toBe(true)
    expect(await genera('2026-10-01')).toBe(0)
    expect(await voci()).toHaveLength(1)
  })
})

describe('11. parità con la formula di sempre, su un seme noto (oracolo scritto a mano)', () => {
  prova('stesse voci, stessi importi, scadenze e visibilità; lo sconto fratelli resta', async () => {
    await db.query(`UPDATE public.admin_settings SET rette_config = $2::jsonb WHERE scuola_id = $1`, [SEDE_A,
      JSON.stringify({ sconto_fratelli: { enabled: true, modo: 'percentuale', scaglioni: [{ posizione: 2, valore: 10 }] } })])
    const gen = '77777777-7777-4777-8777-777777777772'
    const maggiore = uuidFinto(); await creaAlunno(db, maggiore, { nascita: '2019-02-01' })
    const minore = uuidFinto(); await creaAlunno(db, minore, { nascita: '2021-02-01' })
    const solo = uuidFinto(); await creaAlunno(db, solo)
    await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2), ($1, $3)`, [gen, maggiore, minore])
    await creaFrequenza(db, anni, maggiore, { retta: 300 })
    await creaFrequenza(db, anni, minore, { retta: 300 })
    await creaFrequenza(db, anni, solo, { retta: 280 })
    await db.query(`UPDATE public.alunni SET giorno_scadenza_pagamenti = 10 WHERE id = $1`, [solo])
    await db.query(`UPDATE public.frequenze SET giorno_scadenza_pagamenti = 10 WHERE alunno_id = $1`, [solo])
    expect(await genera('2026-10-01')).toBe(3)
    const m = (await voci(maggiore))[0]
    expect(m).toMatchObject({ importo: '300.00', sconto: '0.00', sconto_motivo: null, scadenza: '2026-10-05', visibile_dal: '2026-09-25',
      descrizione: 'Retta 10/2026', gruppo: 'retta-2026-10', stato: 'da_pagare', tipo: 'singolo', periodo_competenza: '2026-10-01' })
    expect((await voci(minore))[0]).toMatchObject({ importo: '300.00', sconto: '30.00', sconto_motivo: 'Sconto fratelli', scadenza: '2026-10-05' })
    expect((await voci(solo))[0]).toMatchObject({ importo: '280.00', sconto: '0.00', scadenza: '2026-10-10', visibile_dal: '2026-09-25' })
  })
})

describe('12. le rette dell’anno prossimo non le vede la famiglia fino al passaggio', () => {
  prova('generate nel 2027/28 aperto, la funzione di visibilità (quella vera di M44b) non le dà; le dà dopo il passaggio', async () => {
    await listino(db, anni, 2027, 260)
    await apriIscrizioni2027()
    const gen = '77777777-7777-4777-8777-777777777773'
    const a = uuidFinto(); await creaAlunno(db, a)
    await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [gen, a])
    await creaFrequenza(db, anni, a, { anno: 2026 })
    await creaFrequenza(db, anni, a, { anno: 2027, stato: 'in_attesa' })
    expect(await genera('2027-09-01', SEDE_A, A27())).toBe(1)
    // si toglie la data di visibilità: la prova riguarda la regola dell'anno, non il calendario del 25
    await db.query(`UPDATE public.pagamenti SET visibile_dal = DATE '2020-01-01'`)
    const id = await una(db, `SELECT id FROM public.pagamenti WHERE alunno_id = $1`, [a])
    const viste = async () => (await righe<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_genitore($1)`, [gen])).map((x) => x.voce_id)
    expect(await viste()).not.toContain(id)
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [A26()])
    await db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [A27()])
    expect(await viste()).toContain(id)
  })
})

describe('13. i comportamenti di oggi, protetti', () => {
  prova('retta_auto_enabled = false spegne la generazione e l’anteprima', async () => {
    await listino(db, anni, 2026, 250)
    const a = await bambino()
    await db.query(`UPDATE public.admin_settings SET retta_auto_enabled = false WHERE scuola_id = $1`, [SEDE_A])
    expect(await riga(A26(), '2026-10-01', a)).toBeUndefined()
    expect(await genera('2026-10-01')).toBe(0)
  })

  prova('sede non operativa → eccezione; sede NULL e elenco vuoto → eccezione', async () => {
    await db.query(`UPDATE public.schools SET operativa = false WHERE id = $1`, [SEDE_A])
    expect(await errore(db, `SELECT public.genera_rette_mensili('2026-10-01', $1, NULL, NULL)`, [SEDE_A])).toMatch(/non operativa/)
    expect(await errore(db, `SELECT public.genera_rette_mensili('2026-10-01', NULL, NULL, NULL)`)).toMatch(/obbligatoria/)
    await db.query(`UPDATE public.schools SET operativa = true WHERE id = $1`, [SEDE_A])
    expect(await errore(db, `SELECT public.genera_rette_mensili('2026-10-01', $1, '{}'::uuid[], NULL)`, [SEDE_A])).toMatch(/vuoto/)
  })

  prova('una frequenza senza sezione né classe non riceve la retta; una uscita prima del mese nemmeno', async () => {
    await listino(db, anni, 2026, 250)
    const senza = uuidFinto(); await creaAlunno(db, senza, { classe: null }); await creaFrequenza(db, anni, senza)
    const uscito = uuidFinto(); await creaAlunno(db, uscito)
    await creaFrequenza(db, anni, uscito, { stato: 'iscritto', uscita: '2026-09-20' })
    expect(await riga(A26(), '2026-10-01', senza)).toBeUndefined()
    expect(await riga(A26(), '2026-10-01', uscito)).toBeUndefined()
    expect((await riga(A26(), '2026-09-01', uscito)).esito).toBe('da_generare')
  })

  prova('la firma a tre argomenti e quella a due continuano a funzionare (nessuna ambiguità)', async () => {
    await listino(db, anni, 2026, 250)
    await bambino()
    expect(Number(await una(db, `SELECT public.genera_rette_mensili('2026-10-01'::date, $1::uuid)`, [SEDE_A]))).toBe(1)
    expect(Number(await una(db, `SELECT public.genera_rette_mensili(p_periodo => '2026-11-01'::date, p_scuola_id => $1::uuid, p_alunno_ids => NULL)`, [SEDE_A]))).toBe(1)
    expect(Number(await una(db, `SELECT public.genera_rette_anno(2026, $1::uuid)`, [SEDE_A]))).toBe(8) // 10 mesi meno i due già fatti
  })

  prova('le funzioni nuove sono del solo service_role', async () => {
    const r = await righe<{ f: string; anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT p.oid::regprocedure::text f,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('listino_mesi', 'listino_periodi', 'rette_da_generare', 'genera_rette_mensili', 'genera_rette_anno', 'servizi_da_generare', 'genera_servizi_anno')`)
    expect(r.length).toBe(9)
    for (const x of r) expect([x.f, x.anon, x.auth, x.svc]).toEqual([x.f, false, false, true])
  })
})

describe('la migrazione', () => {
  it('non contiene UPDATE di dati, DROP, uuid di sede né interruttori del freno', () => {
    const f = readdirSync(join(process.cwd(), 'supabase/migrations')).find((x) => x.endsWith('_anno_rette_dal_listino.sql'))!
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/--.*$/gm, '')
    expect(sql).not.toMatch(/\bDROP\b/i)
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(sql).not.toMatch(/registri\.manutenzione|scatola_nera\.|session_replication_role|DISABLE TRIGGER/i)
  })
})
