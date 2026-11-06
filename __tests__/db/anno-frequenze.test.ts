import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.3 · FREQUENZE E CONFIGURAZIONE DELL'ANNO. Un bambino in un anno in una sede, e le tre
 * tabelle di configurazione (listino, moduli richiesti, posti). Il trigger di `frequenze` ricalcola
 * `moduli_completi` e `quota_saldata` e porta lo stato da `in_attesa` a `iscritto` e viceversa.
 * Solo uuid finti: nessuna sede vera, nessun dato di famiglie.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'

let db: PGlite

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il codice dell'errore: il SQLSTATE per i vincoli, il MESSAGGIO per i nostri (`ANNO_NON_COERENTE`…). */
async function errore(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    const x = e as { code?: string; message?: string }
    return /^[A-Z_]+$/.test(x.message ?? '') ? x.message! : (x.code ?? 'senza-codice')
  }
  return 'nessun-errore'
}

/** L'`anni_sede` attivo di una sede, e l'anno (`anni_scolastici.id`) che porta. */
async function annoSedeAttivo(sede = SEDE): Promise<{ id: string; anno_id: string; inizio: string; fine: string }> {
  const r = await db.query<{ id: string; anno_id: string; inizio: string; fine: string }>(
    `SELECT id, anno_id, inizio::text, fine::text FROM public.anni_sede WHERE id = public.anno_attivo($1)`, [sede])
  return r.rows[0]
}
async function annoSedePrecedente(sede = SEDE): Promise<{ id: string; anno_id: string }> {
  const r = await db.query<{ id: string; anno_id: string }>(
    `SELECT s.id, s.anno_id FROM public.anni_sede s
      WHERE s.scuola_id = $1 AND s.fine < (SELECT fine FROM public.anni_sede WHERE id = public.anno_attivo($1))
      ORDER BY s.fine DESC LIMIT 1`, [sede])
  return r.rows[0]
}
async function nuovoAlunno(sede = SEDE): Promise<string> {
  return una<string>(`INSERT INTO public.alunni (scuola_id) VALUES ($1) RETURNING id`, [sede])
}

type Campi = Record<string, unknown>
/** Inserisce una frequenza: valori di comodo (alunno nuovo, anno attivo di SEDE, lista `nuova`). */
async function freq(over: Campi = {}): Promise<string> {
  const as = await annoSedeAttivo(SEDE)
  const campi: Campi = {
    alunno_id: await nuovoAlunno(),
    anno_sede_id: as.id,
    tipo: 'nuova',
    origine: 'segreteria',
    data_ingresso: as.inizio,
    ...over,
  }
  const nomi = Object.keys(campi)
  return una<string>(
    `INSERT INTO public.frequenze (${nomi.join(', ')}) VALUES (${nomi.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    nomi.map((n) => campi[n]))
}
async function leggi(id: string): Promise<{ stato: string; moduli_completi: boolean; quota_saldata: boolean; quota_pagamento_id: string | null; section_id: string | null }> {
  const r = await db.query<{ stato: string; moduli_completi: boolean; quota_saldata: boolean; quota_pagamento_id: string | null; section_id: string | null }>(
    `SELECT stato, moduli_completi, quota_saldata, quota_pagamento_id, section_id FROM public.frequenze WHERE id = $1`, [id])
  return r.rows[0]
}
async function voce(stato = 'da_pagare'): Promise<string> {
  return una<string>(
    `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, stato)
     VALUES ($1, 'Quota di prova', 100, current_date, $2) RETURNING id`, [SEDE, stato])
}
async function modulo(lista: 'conferma' | 'nuova', codice: string, annoSede?: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, $2, $3, 'Modulo di prova') RETURNING id`,
    [annoSede ?? (await annoSedeAttivo()).id, lista, codice])
}
async function spunta(f: string, m: string) {
  await db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [f, m])
}
async function sezione(sede: string, nome: string, anno: string): Promise<string> {
  return una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, $2, $3) RETURNING id`, [sede, nome, anno])
}

const righeLog = (v: string) => una<number>(
    `SELECT count(*)::int FROM public.app_log WHERE fingerprint = 'db:frequenze-ricalcolo:' || $1::text`, [v])

beforeAll(async () => {
  db = await creaDbAnno()
  await db.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede A'), ($2, 'Sede B')`, [SEDE, SEDE_B])
}, 60_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE public.frequenze, public.moduli_richiesti, public.listino_voci, public.pagamenti, public.sections, public.app_log CASCADE`)
})

describe('CHECK della frequenza', () => {
  it.each([0, -50])('retta_mensile = %s → violazione del CHECK (23514): lo zero non esiste', async (retta) => {
    expect(await errore(freq({ retta_mensile: retta }))).toBe('23514')
  })

  it('retta_mensile NULL (dal listino) e positiva passano; retta_esente è un booleano a parte, falso di default', async () => {
    const a = await freq()
    const b = await freq({ retta_mensile: 180 })
    expect(await una<boolean>(`SELECT retta_esente FROM public.frequenze WHERE id = $1`, [a])).toBe(false)
    expect(await una<string>(`SELECT retta_mensile::text FROM public.frequenze WHERE id = $1`, [b])).toBe('180.00')
  })

  it.each([
    ['stato', { stato: 'sospeso' }],
    ['tipo', { tipo: 'altro' }],
    ['origine', { origine: 'magia' }],
    ['non_rinnova_motivo (testo libero)', { non_rinnova_motivo: 'non mi piace la mensa' }],
    ['giorno_scadenza_pagamenti', { giorno_scadenza_pagamenti: 31 }],
  ])('%s fuori elenco → 23514', async (_n, campi) => {
    expect(await errore(freq(campi))).toBe('23514')
  })

  it('tipo NULL solo con origine = recupero', async () => {
    expect(await errore(freq({ tipo: null, origine: 'segreteria' }))).toBe('23514')
    await expect(freq({ tipo: null, origine: 'recupero' })).resolves.toBeTruthy()
  })

  it('i motivi del «no» ammessi passano', async () => {
    for (const motivo of ['altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro']) {
      await expect(freq({ non_rinnova_motivo: motivo })).resolves.toBeTruthy()
    }
  })

  it('data_uscita prima di data_ingresso → 23514', async () => {
    const as = await annoSedeAttivo()
    const r = await db.query<{ d: string }>(`SELECT ($1::date + 10)::text AS d`, [as.inizio])
    expect(await errore(freq({ data_ingresso: r.rows[0].d, data_uscita: as.inizio }))).toBe('23514')
  })
})

describe('regola dell\'iscritto (dec. 9)', () => {
  it('stato = iscritto con i flag falsi e origine <> recupero → violazione (23514), anche se l\'app scrive i flag veri', async () => {
    expect(await errore(freq({ stato: 'iscritto' }))).toBe('23514')
    // i flag li scrive il trigger: quelli che l'app mette a true vengono sovrascritti
    expect(await errore(freq({ stato: 'iscritto', moduli_completi: true, quota_saldata: true }))).toBe('23514')
  })

  it('stato = iscritto con origine = recupero passa anche a flag falsi, e non viene declassato', async () => {
    const f = await freq({ tipo: null, origine: 'recupero', stato: 'iscritto' })
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', moduli_completi: false, quota_saldata: false })
    await db.query(`UPDATE public.frequenze SET retta_esente = true WHERE id = $1`, [f])
    expect((await leggi(f)).stato).toBe('iscritto')
  })

  it('i flag li scrive solo il trigger: quello che l\'app scrive è sovrascritto', async () => {
    // il flag dei moduli senza moduli richiesti è vero (lista vuota) anche se l'app scrive falso; con tipo NULL è falso (R25)
    const vuota = await freq({ moduli_completi: false })
    expect((await leggi(vuota)).moduli_completi).toBe(true)
    // e con un modulo richiesto non spuntato è falso anche se l'app scrive vero
    await modulo('nuova', 'privacy')
    const f = await freq({ moduli_completi: true, quota_saldata: true })
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false, quota_saldata: false })
    const senzaTipo = await freq({ tipo: null, origine: 'recupero', moduli_completi: true })
    expect((await leggi(senzaTipo)).moduli_completi).toBe(false)
  })
})

describe('transizioni di stato (R25)', () => {
  it('in_attesa → iscritto: spuntare l\'ultimo modulo, con la quota pagata', async () => {
    const m1 = await modulo('nuova', 'privacy')
    const m2 = await modulo('nuova', 'regolamento')
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false, quota_saldata: true })
    await spunta(f, m1)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
    await spunta(f, m2)
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', moduli_completi: true, quota_saldata: true })
  })

  it('in_attesa → iscritto: pagare la quota quando i moduli ci sono già', async () => {
    const m = await modulo('nuova', 'privacy')
    const v = await voce('da_pagare')
    const f = await freq({ quota_pagamento_id: v })
    await spunta(f, m)
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: true, quota_saldata: false })
    await db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v])
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', quota_saldata: true })
  })

  it.each(['da_pagare', 'parziale', 'scaduto'])('iscritto → in_attesa: la voce della quota torna «%s»', async (stato) => {
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    expect((await leggi(f)).stato).toBe('iscritto')
    await db.query(`UPDATE public.pagamenti SET stato = $2 WHERE id = $1`, [v, stato])
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', quota_saldata: false })
  })

  it('iscritto → in_attesa: eliminare la voce della quota (quota_pagamento_id → NULL), senza errori', async () => {
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    expect((await leggi(f)).stato).toBe('iscritto')
    await db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [v])
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', quota_saldata: false, quota_pagamento_id: null })
  })

  it('iscritto → in_attesa: togliere la spunta di un modulo', async () => {
    const m = await modulo('nuova', 'privacy')
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    await spunta(f, m)
    expect((await leggi(f)).stato).toBe('iscritto')
    await db.query(`DELETE FROM public.frequenze_moduli WHERE frequenza_id = $1`, [f])
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
  })

  it('iscritto → in_attesa: un modulo AGGIUNTO alla lista dopo l\'iscrizione', async () => {
    const m = await modulo('nuova', 'privacy')
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    await spunta(f, m)
    expect((await leggi(f)).stato).toBe('iscritto')
    await modulo('nuova', 'nuova-liberatoria')
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
  })

  it('un modulo aggiunto alla lista `conferma` non tocca chi è della lista `nuova`', async () => {
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    expect((await leggi(f)).stato).toBe('iscritto')
    await modulo('conferma', 'solo-per-i-confermati')
    expect((await leggi(f)).stato).toBe('iscritto')
  })

  it('in_attesa → iscritto: un modulo TOLTO dalla lista, o spostato in un\'altra lista', async () => {
    const m1 = await modulo('nuova', 'privacy')
    const m2 = await modulo('nuova', 'regolamento')
    const v = await voce('pagato')
    const f = await freq({ quota_pagamento_id: v })
    await spunta(f, m1)
    expect((await leggi(f)).stato).toBe('in_attesa')
    await db.query(`UPDATE public.moduli_richiesti SET lista = 'conferma' WHERE id = $1`, [m2])
    expect((await leggi(f)).stato).toBe('iscritto')
    await db.query(`UPDATE public.moduli_richiesti SET lista = 'nuova' WHERE id = $1`, [m2])
    expect((await leggi(f)).stato).toBe('in_attesa')
    await db.query(`DELETE FROM public.moduli_richiesti WHERE id = $1`, [m2])
    expect((await leggi(f)).stato).toBe('iscritto')
  })

  it('ritirato, trasferito e uscito non si toccano mai da soli', async () => {
    for (const stato of ['ritirato', 'trasferito', 'uscito']) {
      const v = await voce('da_pagare')
      const f = await freq({ quota_pagamento_id: v, stato })
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v])
      expect(await leggi(f), stato).toMatchObject({ stato, quota_saldata: true })
      await db.query(`UPDATE public.pagamenti SET stato = 'da_pagare' WHERE id = $1`, [v])
      expect(await leggi(f), stato).toMatchObject({ stato, quota_saldata: false })
    }
  })

  it('una voce già pagata assegnata dopo la nascita porta a iscritto (cambia quota_pagamento_id)', async () => {
    const f = await freq()
    const v = await voce('pagato')
    await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [f, v])
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', quota_saldata: true })
  })
})

describe('trigger su pagamenti', () => {
  it('un aggiornamento di una voce SENZA frequenze passa', async () => {
    const v = await voce('da_pagare')
    await expect(db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100 WHERE id = $1`, [v])).resolves.toBeDefined()
    expect(await una<string>(`SELECT stato FROM public.pagamenti WHERE id = $1`, [v])).toBe('pagato')
  })

  /** Un guasto qualunque nel trigger delle frequenze (qui ne aggiungiamo uno di prova): la rete di `pagamenti` lo deve inghiottire e registrare. */
  async function conGuasto<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec(`CREATE FUNCTION public.zz_guasto_di_prova() RETURNS trigger LANGUAGE plpgsql AS $f$
                   BEGIN RAISE EXCEPTION 'GUASTO_DI_PROVA'; END $f$;
                   CREATE TRIGGER zz_guasto_di_prova BEFORE UPDATE ON public.frequenze
                     FOR EACH ROW EXECUTE FUNCTION public.zz_guasto_di_prova();`)
    try { return await fn() } finally {
      await db.exec(`DROP TRIGGER zz_guasto_di_prova ON public.frequenze; DROP FUNCTION public.zz_guasto_di_prova();`)
    }
  }

  it('un errore su una frequenza non fa fallire l\'operazione su pagamenti: la riga resta scritta e l\'errore è nel log', async () => {
    const v = await voce('da_pagare')
    const f = await freq({ quota_pagamento_id: v })
    await conGuasto(async () => {
      await expect(db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v])).resolves.toBeDefined()
    })
    expect(await una<string>(`SELECT stato FROM public.pagamenti WHERE id = $1`, [v])).toBe('pagato')
    expect((await leggi(f)).quota_saldata).toBe(false)
    const log = await db.query<{ livello: string; contesto: Record<string, unknown> }>(
      `SELECT livello, contesto FROM public.app_log WHERE fingerprint = 'db:frequenze-ricalcolo:' || $1::text`, [v])
    expect(log.rows.length).toBe(1)
    expect(log.rows[0].livello).toBe('error')
    expect(log.rows[0].contesto).toMatchObject({ codice: 'GUASTO_DI_PROVA' })
  })

  it('scatta anche quando cambia SOLO importo_pagato (la colonna è nell\'elenco del trigger)', async () => {
    const v = await voce('da_pagare')
    await freq({ quota_pagamento_id: v })
    await conGuasto(() => db.query(`UPDATE public.pagamenti SET importo_pagato = 40 WHERE id = $1`, [v]))
    expect(await righeLog(v)).toBe(1)
  })

  it('un aggiornamento che non cambia né stato né importo_pagato non tocca le frequenze', async () => {
    const v = await voce('da_pagare')
    await freq({ quota_pagamento_id: v })
    await conGuasto(() => db.query(`UPDATE public.pagamenti SET descrizione = 'altra' WHERE id = $1`, [v]))
    expect(await una<number>(`SELECT count(*)::int FROM public.app_log`)).toBe(0)
  })
})

describe('una frequenza INCOERENTE non blocca nessun ricalcolo (giro 1)', () => {
  /** La sezione cambia anno DOPO: la frequenza è incoerente, e una rivalidazione completa solleverebbe SEZIONE_DI_ALTRO_ANNO. */
  async function incoerente(over: Campi = {}): Promise<{ f: string; sez: string }> {
    const as = await annoSedeAttivo()
    const sez = await sezione(SEDE, 'Girasoli', as.anno_id)
    const f = await freq({ section_id: sez, ...over })
    const prec = await annoSedePrecedente()
    await db.query(`UPDATE public.sections SET anno_id = $2 WHERE id = $1`, [sez, prec.anno_id])
    return { f, sez }
  }

  it('eliminare la voce della quota (review focus 5): nessun errore, quota_pagamento_id NULL, stato in_attesa', async () => {
    const v = await voce('pagato')
    const { f } = await incoerente({ quota_pagamento_id: v })
    expect((await leggi(f)).stato).toBe('iscritto')
    await expect(db.query(`DELETE FROM public.pagamenti WHERE id = $1`, [v])).resolves.toBeDefined()
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', quota_saldata: false, quota_pagamento_id: null })
  })

  it('la voce cambia stato: il ricalcolo passa senza passare dal log (nessun errore da inghiottire)', async () => {
    const v = await voce('da_pagare')
    const { f } = await incoerente({ quota_pagamento_id: v })
    await db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v])
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', quota_saldata: true })
    expect(await righeLog(v)).toBe(0)
  })

  it('spuntare e togliere un modulo: nessun errore, flag ricalcolati', async () => {
    const m = await modulo('nuova', 'privacy')
    const v = await voce('pagato')
    const { f } = await incoerente({ quota_pagamento_id: v })
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
    await spunta(f, m)
    expect(await leggi(f)).toMatchObject({ stato: 'iscritto', moduli_completi: true })
    await db.query(`DELETE FROM public.frequenze_moduli WHERE frequenza_id = $1`, [f])
    expect(await leggi(f)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
  })

  it('modificare la lista dei moduli con una frequenza incoerente nell\'anno: nessun errore, e le altre frequenze si aggiornano', async () => {
    const v = await voce('pagato')
    await incoerente()
    const sana = await freq({ quota_pagamento_id: v })
    expect((await leggi(sana)).stato).toBe('iscritto')
    const m = await modulo('nuova', 'nuova-liberatoria')
    expect(await leggi(sana)).toMatchObject({ stato: 'in_attesa', moduli_completi: false })
    await db.query(`UPDATE public.moduli_richiesti SET lista = 'conferma' WHERE id = $1`, [m])
    expect((await leggi(sana)).stato).toBe('iscritto')
    await db.query(`DELETE FROM public.moduli_richiesti WHERE id = $1`, [m])
  })

  it('un UPDATE che cambia DAVVERO una colonna validata solleva ancora', async () => {
    const as = await annoSedeAttivo()
    const { f, sez } = await incoerente()
    const prima = (await db.query<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [as.inizio])).rows[0].d
    expect(await errore(db.query(`UPDATE public.frequenze SET data_ingresso = $2 WHERE id = $1`, [f, prima]))).toBe('ANNO_NON_COERENTE')
    const dopo = (await db.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [as.fine])).rows[0].d
    expect(await errore(db.query(`UPDATE public.frequenze SET data_uscita = $2 WHERE id = $1`, [f, dopo]))).toBe('ANNO_NON_COERENTE')
    // riassegnare la sezione incoerente (cambia section_id) o rimetterla uguale con un altro valore
    const altra = await sezione(SEDE, 'Margherite', (await annoSedePrecedente()).anno_id)
    expect(await errore(db.query(`UPDATE public.frequenze SET section_id = $2 WHERE id = $1`, [f, altra]))).toBe('SEZIONE_DI_ALTRO_ANNO')
    expect(sez).toBeTruthy()
    // lo stato scritto a mano si rivalida
    expect(await errore(db.query(`UPDATE public.frequenze SET stato = 'ritirato' WHERE id = $1`, [f]))).toBe('SEZIONE_DI_ALTRO_ANNO')
    // staccare la sede dall'anno_sede
    expect(await errore(db.query(`UPDATE public.frequenze SET scuola_id = $2 WHERE id = $1`, [f, SEDE_B]))).toBe('ANNO_NON_COERENTE')
    // spostare l'anno_sede
    const prec = await annoSedePrecedente()
    expect(await errore(db.query(`UPDATE public.frequenze SET anno_sede_id = $2 WHERE id = $1`, [f, prec.id]))).toBe('ANNO_NON_COERENTE')
  })
})

describe('una frequenza viva per anno, anche fra sedi (review focus 4)', () => {
  it('due `iscritto` dello stesso bambino nello stesso anno in due sedi → errore di unicità (23505)', async () => {
    const bambino = await nuovoAlunno()
    const asB = await annoSedeAttivo(SEDE_B)
    await freq({ alunno_id: bambino, tipo: null, origine: 'recupero', stato: 'iscritto' })
    expect(await errore(freq({ alunno_id: bambino, anno_sede_id: asB.id, data_ingresso: asB.inizio, tipo: null, origine: 'recupero', stato: 'iscritto' }))).toBe('23505')
  })

  it('in_attesa + in_attesa in due sedi → 23505 (una sola frequenza viva per anno)', async () => {
    const bambino = await nuovoAlunno()
    const asB = await annoSedeAttivo(SEDE_B)
    await freq({ alunno_id: bambino })
    expect(await errore(freq({ alunno_id: bambino, anno_sede_id: asB.id, data_ingresso: asB.inizio }))).toBe('23505')
  })

  it('trasferito + iscritto in due sedi: ammesse (il genitore vede solo la nuova)', async () => {
    const bambino = await nuovoAlunno()
    const asB = await annoSedeAttivo(SEDE_B)
    await freq({ alunno_id: bambino, stato: 'trasferito' })
    await expect(freq({ alunno_id: bambino, anno_sede_id: asB.id, data_ingresso: asB.inizio, tipo: null, origine: 'recupero', stato: 'iscritto' })).resolves.toBeTruthy()
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1 AND stato IN ('in_attesa','iscritto')`, [bambino])).toBe(1)
  })

  it('UNIQUE (alunno_id, anno_sede_id): due righe nella stessa sede e nello stesso anno, mai, nemmeno ritirate', async () => {
    const bambino = await nuovoAlunno()
    await freq({ alunno_id: bambino, stato: 'ritirato' })
    expect(await errore(freq({ alunno_id: bambino, stato: 'ritirato' }))).toBe('23505')
  })

  it('anni diversi dello stesso bambino: ammessi', async () => {
    const bambino = await nuovoAlunno()
    const prec = await annoSedePrecedente()
    const r = await db.query<{ inizio: string }>(`SELECT inizio::text FROM public.anni_sede WHERE id = $1`, [prec.id])
    await freq({ alunno_id: bambino })
    await expect(freq({ alunno_id: bambino, anno_sede_id: prec.id, data_ingresso: r.rows[0].inizio })).resolves.toBeTruthy()
  })
})

describe('anno, sede e date coerenti (trigger rigido)', () => {
  it('anno_id e scuola_id si copiano da anni_sede', async () => {
    const as = await annoSedeAttivo()
    const f = await freq()
    const r = await db.query<{ anno_id: string; scuola_id: string }>(`SELECT anno_id, scuola_id FROM public.frequenze WHERE id = $1`, [f])
    expect(r.rows[0]).toEqual({ anno_id: as.anno_id, scuola_id: SEDE })
  })

  it('anno_id o scuola_id scritti e diversi da quelli di anni_sede → ANNO_NON_COERENTE', async () => {
    const prec = await annoSedePrecedente()
    expect(await errore(freq({ anno_id: prec.anno_id }))).toBe('ANNO_NON_COERENTE')
    expect(await errore(freq({ scuola_id: SEDE_B }))).toBe('ANNO_NON_COERENTE')
    // scritti ma uguali: passano
    const as = await annoSedeAttivo()
    await expect(freq({ anno_id: as.anno_id, scuola_id: SEDE })).resolves.toBeTruthy()
  })

  it('un anno_sede inesistente è una violazione di chiave esterna, non un NULL', async () => {
    expect(await errore(freq({ anno_sede_id: '99999999-9999-4999-8999-999999999999' }))).toBe('23503')
  })

  it('un UPDATE non può staccare anno_id o scuola_id da anni_sede', async () => {
    const f = await freq()
    const prec = await annoSedePrecedente()
    expect(await errore(db.query(`UPDATE public.frequenze SET anno_id = $2 WHERE id = $1`, [f, prec.anno_id]))).toBe('ANNO_NON_COERENTE')
  })

  it('data_ingresso fuori dal periodo → ANNO_NON_COERENTE (prima dell\'inizio e dopo la fine)', async () => {
    const as = await annoSedeAttivo()
    const prima = (await db.query<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [as.inizio])).rows[0].d
    const dopo = (await db.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [as.fine])).rows[0].d
    expect(await errore(freq({ data_ingresso: prima }))).toBe('ANNO_NON_COERENTE')
    expect(await errore(freq({ data_ingresso: dopo }))).toBe('ANNO_NON_COERENTE')
    // il primo e l'ultimo giorno sono dentro (periodo chiuso)
    await expect(freq({ data_ingresso: as.fine })).resolves.toBeTruthy()
    await expect(freq({ data_ingresso: as.inizio })).resolves.toBeTruthy()
  })

  it('data_uscita fuori dal periodo → ANNO_NON_COERENTE', async () => {
    const as = await annoSedeAttivo()
    const dopo = (await db.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [as.fine])).rows[0].d
    expect(await errore(freq({ data_uscita: dopo }))).toBe('ANNO_NON_COERENTE')
    await expect(freq({ data_uscita: as.fine })).resolves.toBeTruthy()
  })

  it('una sezione di un altro anno → SEZIONE_DI_ALTRO_ANNO', async () => {
    const prec = await annoSedePrecedente()
    const sez = await sezione(SEDE, 'Girasoli', prec.anno_id)
    expect(await errore(freq({ section_id: sez }))).toBe('SEZIONE_DI_ALTRO_ANNO')
  })

  it('una sezione di un\'altra sede → SEZIONE_DI_ALTRA_SEDE', async () => {
    const asB = await annoSedeAttivo(SEDE_B)
    const sez = await sezione(SEDE_B, 'Girasoli', asB.anno_id)
    expect(await errore(freq({ section_id: sez }))).toBe('SEZIONE_DI_ALTRA_SEDE')
  })

  it('la sezione giusta (stessa sede, stesso anno) passa; si può assegnare dopo e rimettere a NULL', async () => {
    const as = await annoSedeAttivo()
    const sez = await sezione(SEDE, 'Girasoli', as.anno_id)
    const f = await freq()
    await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE id = $1`, [f, sez])
    expect((await leggi(f)).section_id).toBe(sez)
    const prec = await annoSedePrecedente()
    const sezVecchia = await sezione(SEDE, 'Girasoli', prec.anno_id)
    expect(await errore(db.query(`UPDATE public.frequenze SET section_id = $2 WHERE id = $1`, [f, sezVecchia]))).toBe('SEZIONE_DI_ALTRO_ANNO')
    await db.query(`UPDATE public.frequenze SET section_id = NULL WHERE id = $1`, [f])
    expect((await leggi(f)).section_id).toBeNull()
  })
})

describe('frequenze_moduli', () => {
  it('un modulo di un altro anno_sede → ANNO_NON_COERENTE', async () => {
    const asB = await annoSedeAttivo(SEDE_B)
    const mAltraSede = await modulo('nuova', 'privacy', asB.id)
    const f = await freq()
    expect(await errore(spunta(f, mAltraSede))).toBe('ANNO_NON_COERENTE')
    const prec = await annoSedePrecedente()
    const mAltroAnno = await modulo('nuova', 'privacy', prec.id)
    expect(await errore(spunta(f, mAltroAnno))).toBe('ANNO_NON_COERENTE')
  })

  it('un modulo di una lista diversa dal tipo della frequenza → MODULO_NON_RICHIESTO', async () => {
    const mConferma = await modulo('conferma', 'privacy')
    const f = await freq({ tipo: 'nuova' })
    expect(await errore(spunta(f, mConferma))).toBe('MODULO_NON_RICHIESTO')
    const senzaTipo = await freq({ tipo: null, origine: 'recupero' })
    expect(await errore(spunta(senzaTipo, mConferma))).toBe('MODULO_NON_RICHIESTO')
  })

  it('unica per coppia (23505), con la data e senza note libere', async () => {
    const m = await modulo('nuova', 'privacy')
    const f = await freq()
    await spunta(f, m)
    expect(await errore(spunta(f, m))).toBe('23505')
    expect(await una<boolean>(`SELECT spuntato_il IS NOT NULL FROM public.frequenze_moduli WHERE frequenza_id = $1`, [f])).toBe(true)
    const colonne = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='frequenze_moduli' ORDER BY 1`)
    expect(colonne.rows.map((c) => c.column_name)).toEqual(['frequenza_id', 'id', 'modulo_id', 'spuntato_da', 'spuntato_il'])
  })

  it('eliminare la frequenza elimina le sue spunte, senza errori', async () => {
    const m = await modulo('nuova', 'privacy')
    const f = await freq()
    await spunta(f, m)
    await db.query(`DELETE FROM public.frequenze WHERE id = $1`, [f])
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze_moduli`)).toBe(0)
  })
})

describe('chiavi esterne della frequenza', () => {
  it('ogni FK ha la sua destinazione e la sua ON DELETE', async () => {
    const r = await db.query<{ c: string; dest: string; del: string }>(
      `SELECT array_to_string(array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o), '+') AS c,
              c.confrelid::regclass::text AS dest, c.confdeltype::text AS del
         FROM pg_constraint c WHERE c.conrelid = 'public.frequenze'::regclass AND c.contype = 'f'`)
    const mappa = Object.fromEntries(r.rows.map((x) => [x.c, `${x.dest}:${x.del}`]))
    // a = NO ACTION, c = CASCADE, n = SET NULL
    expect(mappa).toEqual({
      'alunno_id': 'alunni:c',
      'anno_sede_id': 'anni_sede:a',
      'scuola_id+anno_id': 'anni_sede:a',
      'section_id': 'sections:n',
      'continua_da': 'frequenze:n',
      'domanda_id': 'enrollment_submissions:n',
      'quota_pagamento_id': 'pagamenti:n',
      'retta_a_carico_di': 'alunni:n',
      'gruppo_mensa_id': 'gruppi_mensa:n',
    })
  })

  it('cancellare una sezione, una domanda o il fratello azzera il collegamento senza toccare la frequenza', async () => {
    const as = await annoSedeAttivo()
    const sez = await sezione(SEDE, 'Girasoli', as.anno_id)
    const dom = await una<string>(`INSERT INTO public.enrollment_submissions (scuola_id) VALUES ($1) RETURNING id`, [SEDE])
    const fratello = await nuovoAlunno()
    const prima = await freq()
    const f = await freq({ section_id: sez, domanda_id: dom, retta_a_carico_di: fratello, continua_da: prima })
    await db.query(`DELETE FROM public.sections WHERE id = $1`, [sez])
    await db.query(`DELETE FROM public.enrollment_submissions WHERE id = $1`, [dom])
    await db.query(`DELETE FROM public.alunni WHERE id = $1`, [fratello])
    await db.query(`DELETE FROM public.frequenze WHERE id = $1`, [prima])
    const r = await db.query<Record<string, unknown>>(
      `SELECT section_id, domanda_id, retta_a_carico_di, continua_da FROM public.frequenze WHERE id = $1`, [f])
    expect(r.rows[0]).toEqual({ section_id: null, domanda_id: null, retta_a_carico_di: null, continua_da: null })
  })

  it('cancellare l\'alunno cancella le sue frequenze (come presenze)', async () => {
    const bambino = await nuovoAlunno()
    await freq({ alunno_id: bambino })
    await db.query(`DELETE FROM public.alunni WHERE id = $1`, [bambino])
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1`, [bambino])).toBe(0)
  })

  it('ogni FK ha un indice che comincia dalla sua colonna', async () => {
    const r = await db.query<{ colonna: string; indicizzata: boolean }>(
      `SELECT a.attname AS colonna,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum) AS indicizzata
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.conrelid = ANY (ARRAY['public.frequenze'::regclass, 'public.frequenze_moduli'::regclass,
              'public.listino_voci'::regclass, 'public.moduli_richiesti'::regclass, 'public.posti_autorizzati'::regclass])`)
    expect(r.rows.length).toBeGreaterThanOrEqual(14)
    expect(r.rows.filter((x) => !x.indicizzata).map((x) => x.colonna)).toEqual([])
  })
})

describe('configurazione dell\'anno (§4.4.4)', () => {
  async function voceListino(over: Campi = {}): Promise<string> {
    const campi: Campi = { anno_sede_id: (await annoSedeAttivo()).id, voce: 'retta', fascia: 'infanzia', importo: 350, mesi: [9, 10, 11], ...over }
    const nomi = Object.keys(campi)
    return una<string>(
      `INSERT INTO public.listino_voci (${nomi.join(', ')}) VALUES (${nomi.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      nomi.map((n) => campi[n]))
  }

  it('listino_voci: voce e fascia fuori elenco → 23514', async () => {
    expect(await errore(voceListino({ voce: 'sconto' }))).toBe('23514')
    expect(await errore(voceListino({ fascia: 'liceo' }))).toBe('23514')
    for (const voce of ['quota_conferma', 'quota_nuova', 'retta', 'servizio']) {
      await expect(voceListino({ voce, fascia: null })).resolves.toBeTruthy()
      await db.exec(`TRUNCATE public.listino_voci`)
    }
  })

  it('listino_voci: importo NULL ammesso, 0 e negativo no', async () => {
    await expect(voceListino({ importo: null })).resolves.toBeTruthy()
    expect(await errore(voceListino({ fascia: 'primaria', importo: 0 }))).toBe('23514')
    expect(await errore(voceListino({ fascia: 'primaria', importo: -1 }))).toBe('23514')
  })

  it('listino_voci: mesi solo fra 1 e 12', async () => {
    expect(await errore(voceListino({ mesi: [0, 9] }))).toBe('23514')
    expect(await errore(voceListino({ mesi: [9, 13] }))).toBe('23514')
    await expect(voceListino({ mesi: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6] })).resolves.toBeTruthy()
  })

  it('listino_voci: unico per (anno_sede, voce, fascia, categoria) anche con NULL', async () => {
    await voceListino({ fascia: null })
    expect(await errore(voceListino({ fascia: null }))).toBe('23505')
    await voceListino({ fascia: 'nido_1' })
    expect(await errore(voceListino({ fascia: 'nido_1' }))).toBe('23505')
    const cat = await una<string>(`INSERT INTO public.payment_categories (nome) VALUES ('Mensa') RETURNING id`)
    await voceListino({ fascia: 'nido_1', payment_category_id: cat })
    expect(await errore(voceListino({ fascia: 'nido_1', payment_category_id: cat }))).toBe('23505')
    // un'altra voce con la stessa fascia, o un altro anno_sede: ammessi
    await voceListino({ fascia: 'nido_1', voce: 'servizio' })
    await voceListino({ fascia: 'nido_1', anno_sede_id: (await annoSedeAttivo(SEDE_B)).id })
  })

  it('moduli_richiesti: lista conferma|nuova, coppia (anno_sede, lista, codice) unica, ordine di comodo', async () => {
    const as = (await annoSedeAttivo()).id
    expect(await errore(db.query(
      `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo) VALUES ($1, 'altra', 'x', 't')`, [as]))).toBe('23514')
    await modulo('conferma', 'privacy')
    expect(await errore(modulo('conferma', 'privacy'))).toBe('23505')
    await modulo('nuova', 'privacy')
    expect(await una<number>(`SELECT ordine FROM public.moduli_richiesti WHERE lista = 'nuova'`)).toBe(0)
  })

  it('posti_autorizzati: posti >= 0, fascia nell\'elenco, (anno_sede, fascia) unica', async () => {
    const as = (await annoSedeAttivo()).id
    const ins = (fascia: string, posti: number) => db.query(
      `INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti, fonte) VALUES ($1, $2, $3, 'autorizzazione di prova')`, [as, fascia, posti])
    await ins('infanzia', 0)
    await ins('primaria', 25)
    expect(await errore(ins('nido_1', -1))).toBe('23514')
    expect(await errore(ins('liceo', 10))).toBe('23514')
    expect(await errore(ins('infanzia', 30))).toBe('23505')
  })

  it('cancellare un anno_sede toglie la sua configurazione (listino, moduli, posti)', async () => {
    const SEDE_C = '22222222-2222-4222-8222-222222222224'
    await db.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede C')`, [SEDE_C])
    const asB = (await annoSedeAttivo(SEDE_C)).id
    await voceListino({ anno_sede_id: asB })
    await modulo('nuova', 'privacy', asB)
    await db.query(`INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti) VALUES ($1, 'infanzia', 10)`, [asB])
    await db.query(`DELETE FROM public.schools WHERE id = $1`, [SEDE_C])
    for (const t of ['listino_voci', 'moduli_richiesti', 'posti_autorizzati']) {
      expect(await una<number>(`SELECT count(*)::int FROM public.${t} WHERE anno_sede_id = $1`, [asB]), t).toBe(0)
    }
  })

  it('le tre tabelle non hanno anno_id (R9): appendono ad anno_sede_id', async () => {
    const r = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='anno_id'
          AND table_name IN ('listino_voci', 'moduli_richiesti', 'posti_autorizzati', 'frequenze_moduli')`)
    expect(r.rows).toEqual([])
  })
})

describe('sicurezza delle tabelle del compito 1.3', () => {
  const TABELLE = ['frequenze', 'frequenze_moduli', 'listino_voci', 'moduli_richiesti', 'posti_autorizzati']

  it('RLS accesa, nessuna policy, nessun privilegio a anon e authenticated', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1) ORDER BY relname`, [TABELLE])
    expect(r.rows).toEqual([...TABELLE].sort().map((relname) => ({ relname, relrowsecurity: true })))
    expect(await una<string>(`SELECT count(*)::text FROM pg_policies WHERE tablename = ANY ($1)`, [TABELLE])).toBe('0')
    for (const t of TABELLE) {
      for (const ruolo of ['anon', 'authenticated']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(await una<boolean>('SELECT has_table_privilege($1, $2, $3)', [ruolo, `public.${t}`, p]), `${ruolo} ${p} ${t}`).toBe(false)
        }
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await una<boolean>('SELECT has_table_privilege($1, $2, $3)', ['service_role', `public.${t}`, p]), `service_role ${p} ${t}`).toBe(true)
      }
    }
  })

  it('i trigger di ricalcolo girano come SECURITY DEFINER: una voce pagata dal browser (authenticated, con una policy permissiva) ricalcola la frequenza', async () => {
    const v = await voce('da_pagare')
    const f = await freq({ quota_pagamento_id: v })
    await db.exec(`ALTER TABLE public.pagamenti ENABLE ROW LEVEL SECURITY;
                   CREATE POLICY prova_permissiva ON public.pagamenti FOR ALL TO authenticated USING (true) WITH CHECK (true);
                   GRANT ALL ON public.pagamenti TO authenticated;`)
    try {
      await db.exec('SET ROLE authenticated')
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato' WHERE id = $1`, [v])
    } finally {
      await db.exec('RESET ROLE')
      await db.exec(`DROP POLICY prova_permissiva ON public.pagamenti; ALTER TABLE public.pagamenti DISABLE ROW LEVEL SECURITY;`)
    }
    // nessun modulo richiesto → lista completa; quota pagata → iscritto
    expect(await leggi(f)).toMatchObject({ quota_saldata: true, stato: 'iscritto' })
  })
})
