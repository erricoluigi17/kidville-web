import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SEDE_SIM, SEDE_VERA, UTENTE, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'
import { creaBancoAzzera } from '../helpers/banco-azzera'

/**
 * IL FILE CHE AZZERA L'ANNO NUOVO DELLA DEMO, ESEGUITO DAVVERO (su PGlite, mai su Demo né su produzione).
 *
 * `azzera-anno-nuovo-demo.sql` è UN blocco: `BEGIN; CREATE FUNCTION pg_temp…; DO $$ … $$; DROP FUNCTION; COMMIT;`, mandato in una richiesta
 * sola con la STESSA esecuzione multi-istruzione di PGlite (`db.exec`) del test del ripristino. Il banco ha quattro sedi:
 *
 *  · `DEMO`      (`e2e00000-…d000`): la Demo. Prima della «partenza» (committata) ha due anni, un listino, tre moduli, due fasce di posti,
 *                una sezione, una domanda e una voce di pagamento dell'anno nuovo, e tre bambini iscritti nell'anno corrente.
 *  · `SEDE_E2E`, `SEDE_SIM`, `SEDE_VERA`: le sedi del banco del passaggio, con la loro popolazione: non devono cambiare di una riga.
 *
 * Ogni prova gira in una transazione che finisce in ROLLBACK. La «partenza» è l'istante d'inizio della transazione: le righe della Demo
 * committate nel `beforeAll` sono PRIMA, tutto ciò che la prova scrive porta lo stesso `now()` (e `>=` lo conta come dopo).
 *
 * Il caso principale (parte A): fotografia → apre le iscrizioni, cambia il listino e toglie un modulo, conferma due bambini, segna un «no»,
 * accoglie una domanda (nasce un alunno), mette tre voci di pagamento (una incassata) e fa un'anteprima del passaggio → ripristino →
 * azzeramento. Si controlla riga per riga che la Demo sia com'era e che nient'altro sia cambiato (md5 dell'insieme delle righe).
 */

const DEMO = 'e2e00000-0000-4000-8000-00000000d000'
const DIR = path.resolve(__dirname, '../../docs/superpowers/simulazione')
const AZZERA = fs.readFileSync(path.join(DIR, 'azzera-anno-nuovo-demo.sql'), 'utf8')
const FOTOGRAFA = fs.readFileSync(path.join(DIR, 'fotografa-anno-nuovo-demo.sql'), 'utf8')
const RIPRISTINO = fs.readFileSync(path.join(DIR, 'ripristino-demo.sql'), 'utf8')

const id = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, '0')}`
const AL = { a: id(1), b: id(2), c: id(3), d: id(4), e: id(5) }

let b: BancoPassaggio
let annoVecchio: string
let annoNuovo: string
let annoVecchioId: string
let annoNuovoId: string
let sezioneVecchia: string

beforeAll(async () => {
  b = await creaBancoAzzera()
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  await q(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Demo di prova')`, [DEMO])
  await q(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [DEMO])
  const anno = async (inizio: number) =>
    (await q(`SELECT s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [DEMO, inizio])).rows[0] as { id: string; anno_id: string }
  const v = await anno(2026)
  const n = await anno(2027)
  annoVecchio = v.id; annoVecchioId = v.anno_id; annoNuovo = n.id; annoNuovoId = n.anno_id

  // L'anno corrente: una sezione e tre bambini iscritti (lo specchio scrive le loro frequenze).
  sezioneVecchia = await una<string>(b.db,
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Girasoli', 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoVecchioId])
  for (const a of Object.values(AL)) await q(`INSERT INTO public.alunni (id, scuola_id, stato, section_id) VALUES ($1, $2, 'iscritto', $3)`, [a, DEMO, sezioneVecchia])

  // E aveva già detto «no» PRIMA della partenza (con un motivo): dopo l'azzeramento il suo «no» resta. D non risponderà mai.
  await q(`UPDATE public.frequenze SET non_rinnova_il = now(), non_rinnova_motivo = 'trasloco' WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL.e, annoVecchio])

  // L'anno nuovo prima dei collaudi: listino, moduli, posti, una sezione, una domanda e una voce di pagamento (tutto PRIMA della partenza).
  await q(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [annoNuovo])
  await q(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [annoNuovo])
  await q(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [annoNuovo])
  await q(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'foto', 'Liberatoria foto', 2)`, [annoNuovo])
  await q(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [annoNuovo])
  await q(`SELECT public.anno_posti_imposta($1, 'infanzia', 20, 'autorizzazione A')`, [annoNuovo])
  await q(`SELECT public.anno_posti_imposta($1, 'nido_1', 6, 'autorizzazione B')`, [annoNuovo])
  await q(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Orsetti', 'infanzia', 'infanzia')`, [DEMO, annoNuovoId])
  await q(`INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'pending')`, [DEMO, annoNuovoId])
  await q(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'voce di prima', 50, DATE '2027-10-05', $3)`, [AL.a, DEMO, annoNuovoId])
}, 240_000)
afterAll(async () => {
  await b?.db.close()
})

const conta = (sql: string, p: unknown[] = []) => una<number>(b.db, `SELECT count(*)::int FROM (${sql}) x`, p)
const adesso = () => una<string>(b.db, `SELECT now()::text`)

interface Fotografia { sede_di_prova: boolean; anni_candidati: number; fotografia: string | null }
async function fotografa(sede = DEMO): Promise<Fotografia> {
  const r = await b.db.query<Fotografia>(FOTOGRAFA.replace("'<DEMO>'", `'${sede}'`))
  return r.rows[0]
}

/** `scattata`: l'istante dello scatto che la fotografia dichiara (la PARTENZA dello script); senza, la fotografia va com'è. */
interface Compilazione { sede?: string; foto?: string; scattata?: string }
const compila = (o: Compilazione): string => {
  let sql = AZZERA
  if (o.sede) sql = sql.replace("'<DEMO>'", `'${o.sede}'`)
  let foto = o.foto
  if (foto && o.scattata) foto = JSON.stringify({ ...JSON.parse(foto), scattata_il: o.scattata })
  if (foto) sql = sql.replace('$foto$<FOTOGRAFIA>$foto$', () => `$foto$${foto}$foto$`)
  return sql
}
/** Il file raccolto in un SAVEPOINT al posto di BEGIN/COMMIT: la prova sta già in una transazione che finisce in ROLLBACK. */
function dentro(sql: string, nome = 'azz'): string {
  const out = sql.replace(/^BEGIN;\s*$/m, `SAVEPOINT ${nome};`).replace(/^COMMIT;\s*$/m, `RELEASE SAVEPOINT ${nome};`)
  expect(out).not.toBe(sql)
  return out
}

/** Il ripristino (compilato come fa il titolare) con gli stati degli anni di Demo così come sono ORA. */
async function ripristina(dal: string, stati: { etichetta: string; stato: string; domande: boolean }[], inTransazione = true): Promise<void> {
  const righe = stati.map((s) => `('${s.etichetta}', '${s.stato}', ${s.domande})`).join(',\n    ')
  const sql = RIPRISTINO.replace("'<DEMO>'", `'${DEMO}'`).replace("'AAAA-MM-GG'", `'${dal}'`).replace("('AAAA/AA', 'corrente', false)", righe)
  await b.db.exec(inTransazione ? sql.replace(/^BEGIN;\s*$/m, 'SAVEPOINT ripr;').replace(/^COMMIT;\s*$/m, 'RELEASE SAVEPOINT ripr;') : sql)
}
const statiDemo = async () =>
  (await b.db.query<{ etichetta: string; stato: string; domande: boolean }>(
    `SELECT y.etichetta_breve AS etichetta, a.stato, a.domande_aperte AS domande FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id WHERE a.scuola_id = $1 ORDER BY a.inizio`, [DEMO])).rows

/** L'impronta (md5) di un insieme di righe. */
const impronta = (sql: string, p: unknown[] = []) =>
  una<string>(b.db, `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM (${sql}) t`, p)

/** Tutto ciò che deve restare identico: le altre sedi per intero e la Demo fino alla partenza. */
async function quadro(dal: string) {
  const altre = (t: string, col = 'scuola_id') => impronta(`SELECT * FROM public.${t} WHERE ${col} <> $1`, [DEMO])
  return {
    altreFrequenze: await altre('frequenze'),
    altrePagamenti: await altre('pagamenti'),
    altreSezioni: await altre('sections'),
    altriAlunni: await altre('alunni'),
    altreDomande: await altre('enrollment_submissions'),
    altriAnni: await impronta(`SELECT * FROM public.anni_sede WHERE scuola_id <> $1`, [DEMO]),
    altroListino: await impronta(`SELECT l.* FROM public.listino_voci l JOIN public.anni_sede a ON a.id = l.anno_sede_id WHERE a.scuola_id <> $1`, [DEMO]),
    demoFrequenzePrima: await impronta(`SELECT * FROM public.frequenze WHERE scuola_id = $1 AND creata_il < $2::timestamptz`, [DEMO, dal]),
    demoPagamentiPrima: await impronta(`SELECT * FROM public.pagamenti WHERE scuola_id = $1 AND creato_il < $2::timestamptz`, [DEMO, dal]),
    demoSezioniPrima: await impronta(`SELECT * FROM public.sections WHERE scuola_id = $1 AND created_at < $2::timestamptz`, [DEMO, dal]),
    demoAlunniPrima: await impronta(`SELECT * FROM public.alunni WHERE scuola_id = $1 AND creato_il < $2::timestamptz`, [DEMO, dal]),
    demoDomandePrima: await impronta(`SELECT * FROM public.enrollment_submissions WHERE scuola_id = $1 AND created_at < $2::timestamptz`, [DEMO, dal]),
    demoAnniVecchi: await impronta(`SELECT * FROM public.anni_sede WHERE scuola_id = $1 AND id <> $2`, [DEMO, annoNuovo]),
  }
}

/** La configurazione dell'anno nuovo di Demo ORA (listino, moduli, posti), come la fotografia la scrive. */
async function configurazione() {
  const j = (t: string) => una<unknown>(b.db, `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM public.${t} x WHERE x.anno_sede_id = $1`, [annoNuovo])
  return { listino: await j('listino_voci'), moduli: await j('moduli_richiesti'), posti: await j('posti_autorizzati') }
}

const frequenzaVecchia = (alunno: string) =>
  una<string>(b.db, `SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, annoVecchio])

interface Collaudo { domandaAccolta: string; alunnoNuovo: string; alunnoConIncasso: string; pagamentoIncassato: string }
/** La parte A: ciò che fanno gli agenti di collaudo nella Demo, con le funzioni vere del database. */
async function collaudo(conTick = false): Promise<Collaudo> {
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  await q(`SELECT public.anno_apri_iscrizioni($1, $2)`, [annoNuovo, UTENTE])
  await q(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 150, NULL)`, [annoNuovo])
  await q(`SELECT public.anno_modulo_richiesto_togli($1, 'conferma', 'foto')`, [annoNuovo])
  await q(`SELECT public.anno_posti_imposta($1, 'infanzia', 22, 'autorizzazione A bis')`, [annoNuovo])
  await q(`SELECT public.anno_posti_imposta($1, 'primavera', 4, 'nuova')`, [annoNuovo])
  // due conferme e un «no»
  await q(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL, $3::uuid, false)`, [await frequenzaVecchia(AL.a), annoNuovo, UTENTE])
  await q(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL, $3::uuid, false)`, [await frequenzaVecchia(AL.b), annoNuovo, UTENTE])
  await q(`SELECT public.anno_non_rinnova($1::uuid, true, 'altro', $2::uuid)`, [await frequenzaVecchia(AL.c), UTENTE])
  // una domanda accolta: nasce un alunno, con la sua frequenza nuova
  const sezNuova = await una<string>(b.db, `SELECT id FROM public.sections WHERE scuola_id = $1 AND anno_id = $2 AND continua_da = $3`, [DEMO, annoNuovoId, sezioneVecchia])
  const domanda = await una<string>(b.db,
    `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'approved') RETURNING id`, [DEMO, annoNuovoId])
  const nuovo = id(40)
  await q(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'in_arrivo')`, [nuovo, DEMO])
  await q(`SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'domanda', $3::uuid, $4::uuid, NULL, '{}'::jsonb, $5::uuid)`, [nuovo, annoNuovo, domanda, sezNuova, UTENTE])
  // una seconda domanda accolta, il cui bambino ha una voce incassata: l'alunno e la voce restano
  const domanda2 = await una<string>(b.db,
    `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'approved') RETURNING id`, [DEMO, annoNuovoId])
  const conIncasso = id(41)
  await q(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'in_arrivo')`, [conIncasso, DEMO])
  await q(`SELECT public.anno_registra_frequenza($1::uuid, $2::uuid, 'nuova', 'domanda', $3::uuid, $4::uuid, NULL, '{}'::jsonb, $5::uuid)`, [conIncasso, annoNuovo, domanda2, sezNuova, UTENTE])
  // rette generate: due da pagare e una incassata
  for (const [al, mese] of [[AL.a, '2027-10-05'], [AL.b, '2027-11-05']] as const) {
    await q(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'retta generata', 300, $3::date, $4)`, [al, DEMO, mese, annoNuovoId])
  }
  const incassata = await una<string>(b.db,
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id, stato, importo_pagato) VALUES ($1, $2, 'retta incassata', 300, DATE '2027-12-05', $3, 'pagato', 300) RETURNING id`,
    [conIncasso, DEMO, annoNuovoId])
  await q(`INSERT INTO public.incassi (pagamento_id, importo) VALUES ($1, 300)`, [incassata])
  // l'anteprima del passaggio
  const oggi = await una<string>(b.db, `SELECT (ultimo_giorno_aperto + 1)::text FROM public.anni_sede WHERE id = $1`, [annoVecchio])
  await q(`SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [annoVecchio, annoNuovo, UTENTE, oggi])
  if (conTick) {
    // la conferma del passaggio: chi non ha risposto (D) e chi ha detto «no» (C, E) escono: la loro frequenza dell'anno in corso diventa `uscito`
    const passaggio = await una<string>(b.db, `SELECT id FROM public.passaggi_anno WHERE a_anno_sede_id = $1 AND stato = 'anteprima'`, [annoNuovo])
    await q(`SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [passaggio, UTENTE, oggi])
    expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1 AND stato = 'uscito'`, [annoVecchio]), 'la conferma ha fatto uscire dei bambini').toBeGreaterThanOrEqual(2)
    // il viaggio nel tempo: il 01/09/2027 il `prepara_successivo_dal` del 2027/28 scatta e il tick crea il 2028/29 (con le copie di listino, moduli e posti)
    await q(`SELECT public.anni_tick('2027-09-02'::date, $1::uuid)`, [DEMO])
  }
  return { domandaAccolta: domanda, alunnoNuovo: nuovo, alunnoConIncasso: conIncasso, pagamentoIncassato: incassata }
}

/** Il file mandato COM'È (BEGIN e COMMIT compresi) e fermato dal blocco: l'errore porta il codice atteso, la transazione RESTA in errore e, tornati indietro, non è cambiato niente. */
async function fermato(sql: string, codice: string, dal: string): Promise<void> {
  await b.db.exec('SAVEPOINT prima_del_file')
  const prima = { q: await quadro(dal), c: await configurazione(), s: await statiDemo(), n: await conta(`SELECT 1 FROM public.frequenze WHERE scuola_id = $1`, [DEMO]) }
  await expect(b.db.exec(sql)).rejects.toThrow(codice)
  await expect(b.db.query('SELECT 1'), 'dopo l’errore la richiesta si è interrotta: nemmeno il COMMIT è partito').rejects.toThrow(/aborted/i)
  await b.db.exec('ROLLBACK TO SAVEPOINT prima_del_file')
  expect({ q: await quadro(dal), c: await configurazione(), s: await statiDemo(), n: await conta(`SELECT 1 FROM public.frequenze WHERE scuola_id = $1`, [DEMO]) }, 'dopo l’errore non è cambiato niente').toEqual(prima)
  await b.db.exec('RELEASE SAVEPOINT prima_del_file')
}

describe('fotografa-anno-nuovo-demo.sql · sola lettura', () => {
  it('trova l’anno nuovo di Demo e ne dice listino, moduli, posti e conteggi', async () => {
    await inRollback(b.db, async () => {
      const f = await fotografa()
      expect(f.sede_di_prova).toBe(true)
      expect(Number(f.anni_candidati)).toBe(1)
      const j = JSON.parse(f.fotografia!)
      expect(j).toMatchObject({ etichetta: '2027/28', stato: 'in_preparazione', domande_aperte: false })
      expect(j.listino).toHaveLength(2)
      expect(j.moduli).toHaveLength(3)
      expect(j.posti).toHaveLength(2)
      expect(j.partenza.etichetta).toBe('2026/27')
      expect(j.partenza.frequenze).toHaveLength(5)
      expect(JSON.stringify(j.partenza)).not.toMatch(/nome|cognome|codice_fiscale/)
      expect(j.conteggi).toEqual({ frequenze: 0, pagamenti: 1, sezioni: 1, domande: 1 })
      expect(FOTOGRAFA).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i)
    })
  })

  it('una sede vera fuori elenco: dice sede_di_prova = false', async () => {
    await inRollback(b.db, async () => {
      const f = await fotografa(SEDE_VERA)
      expect(f.sede_di_prova).toBe(false)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · quando riesce', () => {
  it('dopo il collaudo, il ripristino e l’azzeramento la Demo è com’era e il resto non si muove', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const foto = JSON.parse(f.fotografia!)
      const stati = await statiDemo()
      const prima = await quadro(dal)
      const invariantiPrima = await conta(`SELECT 1 FROM public.anno_invarianti() WHERE righe <> 0`)
      const configPrima = await configurazione()
      expect(configPrima).toEqual({ listino: foto.listino, moduli: foto.moduli, posti: foto.posti })

      const anniPrima = await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_sede WHERE scuola_id = $1`, [DEMO])
      const globaliPrima = await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_scolastici`)
      const c = await collaudo(true)
      // il collaudo ha cambiato davvero le cose, compreso un anno in più nel selettore
      expect(await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_sede WHERE scuola_id = $1`, [DEMO]), 'il tick ha creato il 2028/29').not.toBe(anniPrima)
      expect(await conta(`SELECT 1 FROM public.listino_voci l JOIN public.anni_sede a ON a.id = l.anno_sede_id JOIN public.anni_scolastici y ON y.id = a.anno_id WHERE a.scuola_id = $1 AND y.anno_inizio = 2028`, [DEMO]), 'con le copie di listino').toBeGreaterThan(0)
      expect(await configurazione()).not.toEqual(configPrima)
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1`, [annoNuovo])).toBeGreaterThan(0)
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1 AND non_rinnova_il IS NOT NULL`, [annoVecchio]), 'i «no» di C e di E').toBe(2)
      expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [DEMO, annoNuovoId])).toBeGreaterThan(1)
      expect(await conta(`SELECT 1 FROM public.passaggi_anno WHERE scuola_id = $1`, [DEMO])).toBe(1)

      await ripristina(dal, stati)
      expect((await statiDemo()).find((s) => s.etichetta === '2027/28')?.stato).toBe('in_preparazione')

      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))

      // listino, moduli e posti: riga per riga come la fotografia
      expect(await configurazione()).toEqual({ listino: foto.listino, moduli: foto.moduli, posti: foto.posti })
      // niente di ciò che è nato dopo la partenza
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1`, [annoNuovo]), 'zero frequenze dell’anno nuovo').toBe(0)
      expect(await conta(`SELECT 1 FROM public.frequenze_moduli m JOIN public.frequenze f ON f.id = m.frequenza_id WHERE f.anno_sede_id = $1`, [annoNuovo])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE scuola_id = $1 AND non_rinnova_il IS NOT NULL`, [DEMO]), 'resta solo il «no» di prima della partenza (E)').toBe(1)
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE alunno_id = $1 AND non_rinnova_motivo = 'trasloco'`, [AL.e])).toBe(1)
      // i bambini usciti col passaggio sono tornati com'erano, e la scheda dell'alunno coincide con la frequenza
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1 AND stato = 'uscito'`, [annoVecchio]), 'nessun bambino uscito nell’anno in corso').toBe(0)
      expect(await conta(`SELECT 1 FROM public.frequenze f JOIN public.alunni al ON al.id = f.alunno_id WHERE f.anno_sede_id = $1 AND al.archiviato_il IS NOT NULL`, [annoVecchio]), 'nessuna scheda archiviata').toBe(0)
      // le invarianti sono a zero, salvo UNA riga voluta: l'alunno con la voce incassata resta «in arrivo» senza più la frequenza, ed è
      // elencato come «lasciata» (lo decide il titolare); la 11-ter lo conta, e nient'altro
      const rosse = (await b.db.query<{ invariante: string; righe: number }>(`SELECT invariante, righe FROM public.anno_invarianti() WHERE righe <> 0`)).rows
      expect(rosse.map((r) => `${r.invariante}:${r.righe}`), 'le invarianti: solo l’alunno lasciato').toEqual(['11:1'])
      expect(await conta(`SELECT 1 FROM public.alunni al WHERE al.stato = 'in_arrivo' AND NOT EXISTS (SELECT 1 FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id WHERE f.alunno_id = al.id AND f.stato IN ('in_attesa', 'iscritto') AND s.stato::text IN ('in_preparazione', 'iscrizioni_aperte')) AND al.id <> $1`, [c.alunnoConIncasso]), 'nessun altro alunno senza arrivo').toBe(0)
      expect(invariantiPrima, 'prima del collaudo le invarianti erano a zero').toBe(0)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE scuola_id = $1 AND anno_id = $2 AND creato_il >= $3::timestamptz`, [DEMO, annoNuovoId, dal]), 'resta solo la voce incassata').toBe(1)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [c.pagamentoIncassato])).toBe(1)
      expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE scuola_id = $1 AND anno_id = $2 AND created_at >= $3::timestamptz`, [DEMO, annoNuovoId, dal])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND anno_id = $2 AND created_at >= $3::timestamptz`, [DEMO, annoNuovoId, dal]), 'zero sezioni nate dopo la partenza').toBe(0)
      expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [DEMO, annoNuovoId]), 'resta la sezione di prima').toBe(1)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [c.alunnoNuovo]), 'l’alunno senza altro è tolto').toBe(0)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [c.alunnoConIncasso]), 'l’alunno con una voce incassata resta').toBe(1)
      expect(await conta(`SELECT 1 FROM public.passaggi_anno WHERE scuola_id = $1`, [DEMO])).toBe(0)
      // lo stato
      expect(await statiDemo()).toEqual(stati)
      expect(await conta(`SELECT 1 FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND dal >= $2::timestamptz`, [annoNuovo, dal])).toBe(0)
      // gli anni sono quelli di prima: il 2028/29 nato nel collaudo è sparito, con la sua configurazione e la riga globale
      expect(await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_sede WHERE scuola_id = $1`, [DEMO]), 'gli anni della Demo sono quelli di prima').toBe(anniPrima)
      expect(await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_scolastici`), 'la riga globale del 2028/29 è sparita').toBe(globaliPrima)
      expect(await conta(`SELECT 1 FROM public.listino_voci l WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede a WHERE a.id = l.anno_sede_id)`)).toBe(0)
      // nient'altro si è mosso
      expect(await quadro(dal), 'le altre sedi e le righe di prima della partenza sono identiche').toEqual(prima)

      // l'ultima tabella: conteggi, uuid delle righe lasciate, invarianti
      const ultimo = risultati.at(-1)!.rows as { voce: string; tolte: string; rimesse: string; lasciate: string }[]
      const riga = (inizio: string) => ultimo.find((r) => r.voce.startsWith(inizio))!
      // quattro quote (due conferme e due nuove iscrizioni, scritte da `anno_registra_frequenza`) e due rette; resta quella incassata
      expect(Number(riga('voci di pagamento').tolte)).toBe(6)
      expect(Number(riga('voci di pagamento').lasciate)).toBe(1)
      expect(Number(riga('alunni').tolte)).toBe(1)
      expect(Number(riga('alunni').lasciate)).toBe(1)
      expect(Number(riga('domande').tolte)).toBe(2)
      expect(Number(riga("frequenze dell'anno di partenza rimesse").rimesse), 'C, D ed E').toBe(3)
      expect(ultimo.map((r) => r.voce)).toContain(`lasciata · pagamenti · ${c.pagamentoIncassato}`)
      expect(ultimo.map((r) => r.voce)).toContain(`lasciata · alunni · ${c.alunnoConIncasso}`)
      expect(ultimo.some((r) => r.voce === 'invarianti non a zero')).toBe(true)
    })
  })

  it('le altre sedi non si muovono: righe nate DOPO la partenza sullo stesso 2027/28 (e un 2028/29 di un’altra sede) sopravvivono tutte', async () => {
    await inRollback(b.db, async () => {
      // Il 2027/28 globale è condiviso da tutte le sedi: se un filtro `scuola_id = v_sede` mancasse, le righe nate dopo la partenza in
      // un'altra sede sarebbero candidate alla cancellazione quanto quelle della Demo. Prima del giro 1 le righe delle altre sedi stavano
      // tutte PRIMA della partenza, quindi nessuna versione dello script le avrebbe mai viste: il test era verde con e senza i filtri.
      const dal = await adesso()
      const f = await fotografa()
      const stati = await statiDemo()
      await collaudo(true)
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      const sedi = [SEDE_SIM, SEDE_VERA] as const
      const creati: { sede: string; alunno: string; pagamento: string; domanda: string; sezione: string }[] = []
      for (const [i, sede] of sedi.entries()) {
        const alunno = `44444444-4444-4444-8444-4444444444${80 + i}`
        await q(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'in_arrivo')`, [alunno, sede])
        const pagamento = await una<string>(b.db, `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'voce di un’altra sede', 120, DATE '2027-10-05', $3) RETURNING id`, [alunno, sede, annoNuovoId])
        const domanda = await una<string>(b.db, `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'pending') RETURNING id`, [sede, annoNuovoId])
        const sezione = await una<string>(b.db, `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Sezione di un’altra sede', 'infanzia', 'infanzia') RETURNING id`, [sede, annoNuovoId])
        creati.push({ sede, alunno, pagamento, domanda, sezione })
      }
      // un 2028/29 anche per la sede di simulazione: la riga globale dell'anno è usata da due sedi e non deve sparire
      await q(`SELECT public.anni_tick('2027-09-02'::date, $1::uuid)`, [SEDE_SIM])
      const anno2028Sim = () => conta(`SELECT 1 FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2028`, [SEDE_SIM])
      expect(await anno2028Sim(), 'la sede di simulazione ha il suo 2028/29').toBe(1)
      const prima = await quadro(dal)
      const globaliPrima = await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_scolastici`)

      await ripristina(dal, stati)
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))

      for (const c of creati) {
        for (const [tabella, colonna, valore] of [['alunni', 'id', c.alunno], ['pagamenti', 'id', c.pagamento], ['enrollment_submissions', 'id', c.domanda], ['sections', 'id', c.sezione]] as const) {
          expect(await conta(`SELECT 1 FROM public.${tabella} WHERE ${colonna} = $1`, [valore]), `${tabella} di ${c.sede === SEDE_SIM ? 'SEDE_SIM' : 'SEDE_VERA'} sopravvive`).toBe(1)
        }
      }
      expect(await anno2028Sim(), 'il 2028/29 dell’altra sede sopravvive').toBe(1)
      expect(await conta(`SELECT 1 FROM public.anni_scolastici y WHERE y.anno_inizio = 2028`), 'e la riga globale con lui').toBe(1)
      expect(await una<string>(b.db, `SELECT string_agg(id::text, ',' ORDER BY id) FROM public.anni_scolastici`)).toBe(globaliPrima)
      expect(await conta(`SELECT 1 FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2028`, [DEMO]), 'quello della Demo è sparito').toBe(0)
      const dopo = await quadro(dal)
      const soloAltre = (q: Awaited<ReturnType<typeof quadro>>) =>
        Object.fromEntries(Object.entries(q).filter(([k]) => k.startsWith('altr')))
      expect(soloAltre(dopo), 'le altre sedi, riga per riga, sono identiche').toEqual(soloAltre(prima))
    })
  })

  it('senza collaudo (niente da togliere) riesce e lascia tutto com’era', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const prima = { q: await quadro(dal), c: await configurazione(), s: await statiDemo() }
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect({ q: await quadro(dal), c: await configurazione(), s: await statiDemo() }).toEqual(prima)
    })
  })

  it('anche con le iscrizioni aperte alla partenza: lo stato torna `iscrizioni_aperte`, non `in_preparazione`', async () => {
    await inRollback(b.db, async () => {
      await b.db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [annoNuovo, UTENTE])
      // l'apertura è avvenuta “ieri”, prima della partenza: le sezioni che ha copiato e la cronologia dello stato hanno un giorno
      await b.db.exec(`
        UPDATE public.sections SET created_at = now() - interval '1 day' WHERE scuola_id = '${DEMO}';
        UPDATE public.anni_sede_stati SET dal = now() - interval '1 day' WHERE anno_sede_id = '${annoNuovo}';`)
      const f = await fotografa()
      expect(JSON.parse(f.fotografia!).stato).toBe('iscrizioni_aperte')
      // una riga «dopo» la partenza: il listino cambia e lo stato si sposta
      await b.db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 999, NULL)`, [annoNuovo])
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect(await configurazione()).toMatchObject({ listino: JSON.parse(f.fotografia!).listino })
      expect((await statiDemo()).find((s) => s.etichetta === '2027/28')?.stato).toBe('iscrizioni_aperte')
    })
  })

  it('una sede NON `e2e00000…` ma unica in `sedi_simulazione` è ammessa', async () => {
    await inRollback(b.db, async () => {
      const f = await fotografa(SEDE_SIM)
      expect(f.sede_di_prova).toBe(true)
      // righe nate DOPO la fotografia nella sede di simulazione (non `e2e00000…`) e, per confronto, nella sede di Demo e in una sede vera
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      const nate: Record<string, { alunno: string; voce: string; domanda: string }> = {}
      for (const [i, sede] of [SEDE_SIM, DEMO, SEDE_VERA].entries()) {
        const alunno = `44444444-4444-4444-8444-4444444444${60 + i}`
        await q(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'in_arrivo')`, [alunno, sede])
        const voce = await una<string>(b.db, `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'voce nata dopo', 90, DATE '2027-10-05', $3) RETURNING id`, [alunno, sede, annoNuovoId])
        const domanda = await una<string>(b.db, `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'pending') RETURNING id`, [sede, annoNuovoId])
        nate[sede] = { alunno, voce, domanda }
      }
      await b.db.exec(dentro(compila({ sede: SEDE_SIM, foto: f.fotografia! })))
      const s = nate[SEDE_SIM]
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [s.voce]), 'la voce nata dopo, nella sede di simulazione, è tolta').toBe(0)
      expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE id = $1`, [s.domanda]), 'la domanda').toBe(0)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [s.alunno]), 'l’alunno').toBe(0)
      for (const altra of [DEMO, SEDE_VERA]) {
        expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [nate[altra].voce]), `la voce della sede ${altra === DEMO ? 'Demo' : 'vera'} resta`).toBe(1)
        expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE id = $1`, [nate[altra].domanda])).toBe(1)
        expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [nate[altra].alunno])).toBe(1)
      }
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · il blocco si ferma da solo, e non cambia niente', () => {
  it('il file com’è, con i segnaposto: AZZERA_SEGNAPOSTO', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      await fermato(AZZERA, 'AZZERA_SEGNAPOSTO', dal)
    })
  })

  it('un segnaposto alla volta: la sede, la fotografia (anche non JSON)', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await collaudo()
      await fermato(compila({ foto: f.fotografia! }), 'AZZERA_SEGNAPOSTO', dal)
      await fermato(compila({ sede: DEMO }), 'AZZERA_SEGNAPOSTO', dal)
      await fermato(compila({ sede: DEMO, foto: 'non è json' }), 'AZZERA_SEGNAPOSTO', dal)
    })
  })

  it('una sede che non è di prova: AZZERA_SEDE_NON_DI_PROVA, anche se compare in elenco insieme ad altre', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa(SEDE_SIM)
      // SEDE_VERA non comincia per e2e00000 e non è in elenco
      await fermato(compila({ sede: SEDE_VERA, foto: f.fotografia! }), 'AZZERA_SEDE_NON_DI_PROVA', dal)
      // l'elenco vuoto
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = '{}'::uuid[]`)
      await fermato(compila({ sede: SEDE_SIM, foto: f.fotografia! }), 'AZZERA_SEDE_NON_DI_PROVA', dal)
      // l'elenco con due sedi
      await b.db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1, $2]::uuid[]`, [SEDE_SIM, SEDE_VERA])
      await fermato(compila({ sede: SEDE_SIM, foto: f.fotografia! }), 'AZZERA_SEDE_NON_DI_PROVA', dal)
    })
  })

  it('la data: nel futuro, e troppo tarda (le righe del collaudo contate come “di prima”) → AZZERA_DATA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await collaudo()
      await fermato(compila({ sede: DEMO, scattata: '2999-01-01T00:00:00Z', foto: f.fotografia! }), 'AZZERA_DATA', dal)
      // il collaudo è vecchio di 5 giorni; la «partenza ricordata male» è di 3 giorni fa
      await b.db.exec(`
        DELETE FROM public.passaggi_anno WHERE scuola_id = '${DEMO}';
        UPDATE public.anni_sede SET creato_il = now() - interval '10 days' WHERE scuola_id = '${DEMO}';
        UPDATE public.frequenze SET creata_il = now() - interval '5 days' WHERE anno_sede_id = '${annoNuovo}';
        UPDATE public.pagamenti SET creato_il = now() - interval '5 days' WHERE scuola_id = '${DEMO}' AND anno_id = '${annoNuovoId}';
        UPDATE public.sections SET created_at = now() - interval '5 days' WHERE scuola_id = '${DEMO}' AND anno_id = '${annoNuovoId}';
        UPDATE public.enrollment_submissions SET created_at = now() - interval '5 days' WHERE scuola_id = '${DEMO}' AND anno_id = '${annoNuovoId}';
      `)
      const tarda = await una<string>(b.db, `SELECT (now() - interval '3 days')::text`)
      await fermato(compila({ sede: DEMO, scattata: tarda, foto: f.fotografia! }), 'AZZERA_DATA', dal)
    })
  })

  it('una data più vecchia della nascita dell’anno: nessun anno nuovo → AZZERA_ANNO_NUOVO_NON_UNO', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await fermato(compila({ sede: DEMO, scattata: '2020-01-01T00:00:00Z', foto: f.fotografia! }), 'AZZERA_ANNO_NUOVO_NON_UNO', dal)
    })
  })

  it('due anni in preparazione → AZZERA_ANNO_NUOVO_NON_UNO', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      // un secondo anno “nuovo”: l’anno vecchio dell’altra parte del calendario torna in preparazione
      await b.db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE scuola_id = $1 AND id <> $2 AND id <> $3`, [DEMO, annoNuovo, annoVecchio])
      expect(await conta(`SELECT 1 FROM public.anni_sede WHERE scuola_id = $1 AND stato = 'in_preparazione'`, [DEMO])).toBe(2)
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_ANNO_NUOVO_NON_UNO', dal)
    })
  })

  it('l’anno nuovo è già `corrente` (il ripristino non è stato eseguito) → AZZERA_PRIMA_IL_RIPRISTINO', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await collaudo()
      // la conferma del passaggio sposta il corrente
      await b.db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [annoVecchio])
      await b.db.query(`UPDATE public.anni_sede SET stato = 'corrente' WHERE id = $1`, [annoNuovo])
      expect((await statiDemo()).find((s) => s.etichetta === '2027/28')?.stato).toBe('corrente')
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_PRIMA_IL_RIPRISTINO', dal)
    })
  })

  it('restano passaggi dopo la partenza (il ripristino non c’è stato) → AZZERA_PRIMA_IL_RIPRISTINO', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await collaudo()
      expect(await conta(`SELECT 1 FROM public.passaggi_anno WHERE scuola_id = $1`, [DEMO])).toBe(1)
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_PRIMA_IL_RIPRISTINO', dal)
    })
  })

  it('la fotografia: un’altra etichetta, uno stato che non va, una riga di un altro anno, un pezzo mancante → AZZERA_FOTOGRAFIA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const j = JSON.parse(f.fotografia!)
      const con = (m: object) => JSON.stringify({ ...j, ...m })
      const comp = (foto: string) => compila({ sede: DEMO, foto })
      await fermato(comp(con({ etichetta: '2028/29' })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp(con({ stato: 'corrente' })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp(con({ etichetta: 'duemila' })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp(con({ listino: null })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp(con({ conteggi: { frequenze: 0 } })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp(con({ posti: j.posti.map((p: object) => ({ ...p, anno_sede_id: annoVecchio })) })), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(comp('{}'), 'AZZERA_FOTOGRAFIA', dal)
    })
  })

  it('un anno nato nel collaudo che qualcuno usa (una sezione) → AZZERA_ANNI_NATI_USATI, con i conteggi, e non cambia niente', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const stati = await statiDemo()
      await collaudo(true)
      await ripristina(dal, stati)
      const nato = await b.db.query<{ anno_id: string }>(`SELECT s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2028`, [DEMO])
      await b.db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Sezione del 2028', 'infanzia', 'infanzia')`, [DEMO, nato.rows[0].anno_id])
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_ANNI_NATI_USATI', dal)
      await expect(b.db.exec(compila({ sede: DEMO, foto: f.fotografia! }))).rejects.toThrow(/sections=1/)
    })
  })

  it('un anno nato nel collaudo con una voce di pagamento, una presenza e una valutazione datate nel 2028/29 → AZZERA_ANNI_NATI_USATI con i conteggi (mai un 23503 grezzo)', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const stati = await statiDemo()
      await collaudo(true)
      await ripristina(dal, stati)
      // l'anno lo assegna da sé il database in base alla data: queste tre righe finiscono nel 2028/29, che il tick ha fatto nascere
      await b.db.query(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'retta 2028', 300, DATE '2028-10-05')`, [AL.a, DEMO])
      await b.db.query(`INSERT INTO public.presenze (alunno_id, scuola_id, section_id, data) VALUES ($1, $2, $3, DATE '2028-10-05')`, [AL.a, DEMO, sezioneVecchia])
      await b.db.query(`INSERT INTO public.valutazioni (alunno_id, section_id, data_evento) VALUES ($1, $2, DATE '2028-10-05')`, [AL.a, sezioneVecchia])
      const nato = await una<string>(b.db, `SELECT s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2028`, [DEMO])
      for (const t of ['pagamenti', 'presenze', 'valutazioni']) {
        expect(await conta(`SELECT 1 FROM public.${t} WHERE anno_id = $1`, [nato]), `${t} nel 2028/29`).toBe(1)
      }
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_ANNI_NATI_USATI', dal)
      await b.db.exec('SAVEPOINT leggi_messaggio')
      const messaggio = await b.db.exec(compila({ sede: DEMO, foto: f.fotografia! })).then(() => '', (e: Error) => e.message)
      await b.db.exec('ROLLBACK TO SAVEPOINT leggi_messaggio')
      expect(messaggio).toContain('pagamenti=1')
      expect(messaggio).toContain('presenze=1')
      expect(messaggio).toContain('valutazioni=1')
    })
  })

  it('i conteggi dopo non tornano (un trigger rimette una sezione): AZZERA_CONTEGGI e tutto annullato', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      await collaudo()
      await ripristina(dal, await statiDemo().then((s) => s.map((x) => (x.etichetta === '2027/28' ? { ...x, stato: 'in_preparazione' } : x))))
      await b.db.exec(`
        CREATE FUNCTION public.prova_rimetti_sezione() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES (OLD.scuola_id, OLD.anno_id, OLD.name || ' bis', OLD.school_type, OLD.fascia);
          RETURN OLD;
        END $f$;
        CREATE TRIGGER prova_rimetti_sezione AFTER DELETE ON public.sections FOR EACH ROW WHEN (OLD.name NOT LIKE '% bis') EXECUTE FUNCTION public.prova_rimetti_sezione();
      `)
      await fermato(compila({ sede: DEMO, foto: f.fotografia! }), 'AZZERA_CONTEGGI', dal)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · le frequenze dell’anno di partenza', () => {
  it('una frequenza della fotografia che non esiste più → AZZERA_FREQUENZA_SPARITA, e non cambia niente', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const j = JSON.parse(f.fotografia!)
      j.partenza.frequenze.push({ id: id(99), stato: 'iscritto', data_uscita: null, non_rinnova_il: null, non_rinnova_motivo: null })
      const stati = await statiDemo()
      await collaudo(true)
      await ripristina(dal, stati)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify(j) }), 'AZZERA_FREQUENZA_SPARITA', dal)
    })
  })

  it('una frequenza dell’anno di partenza nata dopo la partenza si toglie (e il suo alunno, se non ha altro)', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const stati = await statiDemo()
      await collaudo(true)
      await b.db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'iscritto')`, [id(60), DEMO])
      // l'inserimento dell'alunno in un anno corrente fa nascere da sé la frequenza (specchio inverso)
      const nata = await una<string>(b.db, `SELECT id FROM public.frequenze WHERE anno_sede_id = $1 AND alunno_id = $2`, [annoVecchio, id(60)])
      await ripristina(dal, stati)
      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE id = $1`, [nata]), 'tolta').toBe(0)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [id(60)]), 'e il suo alunno').toBe(0)
      const ultimo = risultati.at(-1)!.rows as { voce: string; tolte: string }[]
      expect(Number(ultimo.find((r) => r.voce.startsWith('frequenze nate dopo la partenza'))!.tolte)).toBe(1)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · la partenza la dà la fotografia', () => {
  it('una fotografia della versione 1, o senza scattata_il, o con un istante che non lo è → AZZERA_FOTOGRAFIA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const j = JSON.parse(f.fotografia!)
      expect(j.versione, 'la fotografia è della versione 2').toBe(2)
      expect(typeof j.scattata_il).toBe('string')
      const senza = { ...j }
      delete senza.scattata_il
      await fermato(compila({ sede: DEMO, foto: JSON.stringify({ ...j, versione: 1 }) }), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify(senza) }), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify({ ...j, scattata_il: 'ieri' }) }), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify({ ...j, scattata_il: 20261113 }) }), 'AZZERA_FOTOGRAFIA', dal)
    })
  })

  it('una riga nata PRIMA della fotografia sopravvive sempre: anche una frequenza e un alunno di poche ore prima, e una data “storta”', async () => {
    await inRollback(b.db, async () => {
      // un bambino iscritto QUELLA MATTINA, tre ore prima di scattare la fotografia
      await b.db.query(`INSERT INTO public.alunni (id, scuola_id, stato, section_id) VALUES ($1, $2, 'iscritto', $3)`, [id(70), DEMO, sezioneVecchia])
      await b.db.query(`UPDATE public.alunni SET creato_il = now() - interval '3 hours' WHERE id = $1`, [id(70)])
      await b.db.query(`UPDATE public.frequenze SET creata_il = now() - interval '3 hours' WHERE alunno_id = $1`, [id(70)])
      const dal = await adesso()
      const f = await fotografa()
      expect(JSON.parse(f.fotografia!).partenza.frequenze.map((x: { id: string }) => x.id)).toContain(await frequenzaVecchia(id(70)))
      const stati = await statiDemo()
      await collaudo(true)
      // e una frequenza della fotografia con la data di creazione “spostata” dopo lo scatto (un orologio storto): si riconosce dall'uuid
      await b.db.query(`UPDATE public.frequenze SET creata_il = now() + interval '1 second' WHERE alunno_id = $1`, [AL.a])
      const prima = await impronta(`SELECT f.id, f.alunno_id, f.anno_sede_id, f.creata_il FROM public.frequenze f WHERE f.alunno_id IN ($1, $2) AND f.anno_sede_id = $3`, [id(70), AL.a, annoVecchio])
      const alunnoPrima = await impronta(`SELECT id, scuola_id, creato_il FROM public.alunni WHERE id = $1`, [id(70)])
      await ripristina(dal, stati)
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect(await impronta(`SELECT f.id, f.alunno_id, f.anno_sede_id, f.creata_il FROM public.frequenze f WHERE f.alunno_id IN ($1, $2) AND f.anno_sede_id = $3`, [id(70), AL.a, annoVecchio])).toBe(prima)
      expect(await impronta(`SELECT id, scuola_id, creato_il FROM public.alunni WHERE id = $1`, [id(70)])).toBe(alunnoPrima)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · quello che nasce accogliendo una domanda (O1)', () => {
  it('i legami dell’alunno e della domanda si tolgono con loro; gli account e il CRM restano, elencati per uuid', async () => {
    await inRollback(b.db, async () => {
      // Accogliere una domanda dall'app crea più di un alunno: i legami con i genitori (legame_genitori_alunni, student_parents) e l'invito con le
      // credenziali (iscrizioni_inviti_credenziali). In produzione queste righe tenevano in vita l'alunno e la domanda: l'azzeramento "riusciva" e
      // lasciava tutto. L'account (parents, utenti) non si cancella mai; il CRM (crm_bambini, crm_schede) nemmeno, e trattiene ciò a cui punta.
      const f = await fotografa()
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      const X = id(90), Y = id(91), P = id(92), U = id(93)
      const nuova = async (stato = 'approved') =>
        una<string>(b.db, `INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, $3) RETURNING id`, [DEMO, annoNuovoId, stato])
      const D = await nuova()
      const D3 = await nuova()
      await q(`INSERT INTO public.parents (id) VALUES ($1)`, [P])
      await q(`INSERT INTO public.utenti (id, ruolo) VALUES ($1, 'genitore')`, [U])
      await q(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $3, 'in_arrivo'), ($2, $3, 'in_arrivo')`, [X, Y, DEMO])
      await q(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [U, X])
      await q(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2)`, [X, P])
      await q(`INSERT INTO public.iscrizioni_inviti_credenziali (submission_id, parent_id, auth_user_id) VALUES ($1, $2, $3)`, [D, P, U])
      const C = await una<string>(b.db, `INSERT INTO public.crm_bambini (scuola_id, alunno_id) VALUES ($1, $2) RETURNING id`, [DEMO, Y])
      const S = await una<string>(b.db, `INSERT INTO public.crm_schede (scuola_id, domanda_da_associare) VALUES ($1, $2) RETURNING id`, [DEMO, D3])

      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      const voci = (risultati.at(-1)!.rows as { voce: string }[]).map((r) => r.voce)

      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [X]), 'l’alunno accolto esce').toBe(0)
      expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE id = $1`, [D]), 'e la sua domanda').toBe(0)
      expect(await conta(`SELECT 1 FROM public.legame_genitori_alunni WHERE alunno_id = $1`, [X])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.student_parents WHERE student_id = $1`, [X])).toBe(0)
      expect(await conta(`SELECT 1 FROM public.iscrizioni_inviti_credenziali WHERE auth_user_id = $1`, [U]), 'e l’invito con le credenziali').toBe(0)
      // gli account restano, e si elencano
      expect(await conta(`SELECT 1 FROM public.parents WHERE id = $1`, [P])).toBe(1)
      expect(await conta(`SELECT 1 FROM public.utenti WHERE id = $1`, [U])).toBe(1)
      expect(voci).toContain(`lasciata · parents · ${P}`)
      expect(voci).toContain(`lasciata · utenti · ${U}`)
      // il CRM trattiene il suo alunno e la sua domanda, e si elenca
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [Y]), 'l’alunno del CRM resta').toBe(1)
      expect(await conta(`SELECT 1 FROM public.enrollment_submissions WHERE id = $1`, [D3]), 'la domanda del CRM resta').toBe(1)
      expect(await una<string>(b.db, `SELECT alunno_id FROM public.crm_bambini WHERE id = $1`, [C]), 'il CRM non perde il legame').toBe(Y)
      expect(voci).toContain(`lasciata · crm_bambini · ${C}`)
      expect(voci).toContain(`lasciata · crm_schede · ${S}`)
      expect(voci).toContain(`lasciata · alunni · ${Y}`)
      expect(voci).toContain(`lasciata · enrollment_submissions · ${D3}`)
      // O3: le domande tolte non lasciano copia (la scatola nera non le vede): l'esito ne dice gli uuid, non solo il numero
      expect(voci).toContain(`domanda tolta · ${D}`)
      expect(voci.filter((v) => v.startsWith('domanda tolta · ')), 'solo quella tolta, non quella trattenuta dal CRM').toEqual([`domanda tolta · ${D}`])
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · le dipendenze di secondo livello (O4)', () => {
  it('una sezione con una materia a cui punta una valutazione, o un menù della mensa, resta (elencata); una materia sola va via con la sezione', async () => {
    await inRollback(b.db, async () => {
      // sections → materie → valutazioni (NO ACTION): togliere la sezione trascinerebbe la materia e farebbe fallire il DELETE con un 23503 grezzo.
      // mensa_class_menu_assignment.section_id è SET NULL: togliere la sezione scollegherebbe il menù senza dire niente.
      const f = await fotografa()
      const sez = async (nome: string) =>
        una<string>(b.db, `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, $3, 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoNuovoId, nome])
      const materia = async (s: string, codice: string) =>
        una<string>(b.db, `INSERT INTO public.materie (scuola_id, section_id, nome, codice) VALUES ($1, $2, $3, $3) RETURNING id`, [DEMO, s, codice])
      const conValutazione = await sez('con una valutazione')
      const matV = await materia(conValutazione, 'AAA')
      const val = await una<string>(b.db, `INSERT INTO public.valutazioni (alunno_id, materia_id) VALUES ($1, $2) RETURNING id`, [AL.a, matV])
      // un trigger ricava section_id dalla classe a ogni INSERT o UPDATE di `classe`: il legame si mette con un UPDATE a parte
      const conMensa = await sez('con un menù')
      const mensa = await una<string>(b.db, `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe, section_id) VALUES ($1, 'A', NULL) RETURNING id`, [DEMO])
      await b.db.query(`UPDATE public.mensa_class_menu_assignment SET section_id = $2 WHERE id = $1`, [mensa, conMensa])
      const libera = await sez('libera')
      const matL = await materia(libera, 'BBB')

      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      const voci = (risultati.at(-1)!.rows as { voce: string }[]).map((r) => r.voce)

      expect(await conta(`SELECT 1 FROM public.sections WHERE id = $1`, [conValutazione]), 'la sezione con la valutazione resta').toBe(1)
      expect(await conta(`SELECT 1 FROM public.materie WHERE id = $1`, [matV])).toBe(1)
      expect(await una<string>(b.db, `SELECT materia_id FROM public.valutazioni WHERE id = $1`, [val]), 'la valutazione non perde la materia').toBe(matV)
      expect(await conta(`SELECT 1 FROM public.sections WHERE id = $1`, [conMensa]), 'la sezione con il menù resta').toBe(1)
      expect(await una<string>(b.db, `SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [mensa]), 'il menù non viene scollegato').toBe(conMensa)
      expect(voci).toContain(`lasciata · sections · ${conValutazione}`)
      expect(voci).toContain(`lasciata · sections · ${conMensa}`)
      expect(await conta(`SELECT 1 FROM public.sections WHERE id = $1`, [libera]), 'la sezione libera va via').toBe(0)
      expect(await conta(`SELECT 1 FROM public.materie WHERE id = $1`, [matL]), 'con la sua materia').toBe(0)
    })
  })

  it('una voce di pagamento con una quota a cui punta un incasso resta (elencata): l’incasso non perde il legame in silenzio', async () => {
    await inRollback(b.db, async () => {
      // pagamenti → pagamenti_quote (cascade) → incassi.quota_id (SET NULL): togliere la voce lascerebbe l'incasso senza quota, senza dirlo.
      const f = await fotografa()
      const voce = async () =>
        una<string>(b.db, `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'voce', 100, DATE '2027-10-05', $3) RETURNING id`, [AL.a, DEMO, annoNuovoId])
      const conIncasso = await voce()
      const libera = await voce()
      const quota = await una<string>(b.db, `INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 100) RETURNING id`, [conIncasso, id(95)])
      const quotaL = await una<string>(b.db, `INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 100) RETURNING id`, [libera, id(95)])
      const inc = await una<string>(b.db, `INSERT INTO public.incassi (quota_id, importo) VALUES ($1, 100) RETURNING id`, [quota])

      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      const voci = (risultati.at(-1)!.rows as { voce: string }[]).map((r) => r.voce)

      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [conIncasso]), 'la voce con l’incasso resta').toBe(1)
      expect(await una<string>(b.db, `SELECT quota_id FROM public.incassi WHERE id = $1`, [inc]), 'l’incasso tiene la sua quota').toBe(quota)
      expect(voci).toContain(`lasciata · pagamenti · ${conIncasso}`)
      expect(await conta(`SELECT 1 FROM public.pagamenti WHERE id = $1`, [libera]), 'la voce libera va via').toBe(0)
      expect(await conta(`SELECT 1 FROM public.pagamenti_quote WHERE id = $1`, [quotaL]), 'con la sua quota').toBe(0)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · le tabelle di lavoro stanno solo nello schema temporaneo (O5)', () => {
  it('con pg_temp in fondo al search_path, una tabella omonima di public non viene cancellata né letta', async () => {
    await inRollback(b.db, async () => {
      // Senza lo schema scritto, `DROP TABLE IF EXISTS _azzera_cand` cerca nel search_path: se `public` viene prima di `pg_temp`, il DROP
      // cancellerebbe una tabella VERA con quel nome. Con `pg_temp.` esplicito non può.
      const f = await fotografa()
      await b.db.exec(`SET LOCAL search_path = public, pg_temp`)
      await b.db.exec(`CREATE TABLE public._azzera_cand (tabella text, id uuid, bloccata boolean); INSERT INTO public._azzera_cand VALUES ('x', gen_random_uuid(), false)`)
      await b.db.exec(`CREATE TABLE public._azzera_esito (voce text); INSERT INTO public._azzera_esito VALUES ('mia')`)
      await b.db.exec(`CREATE TABLE public._azzera_lasciate (tabella text); INSERT INTO public._azzera_lasciate VALUES ('mia')`)
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect(await conta(`SELECT 1 FROM public._azzera_cand`), 'la tabella di public non è stata cancellata').toBe(1)
      expect(await conta(`SELECT 1 FROM public._azzera_esito WHERE voce = 'mia'`)).toBe(1)
      expect(await conta(`SELECT 1 FROM public._azzera_lasciate WHERE tabella = 'mia'`)).toBe(1)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · le date degli anni (O7)', () => {
  const date = () => impronta(`SELECT id, inizio, fine, ultimo_giorno_aperto, prepara_successivo_dal FROM public.anni_sede WHERE id IN ($1, $2)`, [annoVecchio, annoNuovo])

  it('un confine spostato durante il collaudo (e le due date di servizio) tornano com’erano, senza rompere la continuità', async () => {
    await inRollback(b.db, async () => {
      const f = await fotografa()
      const prima = await date()
      // il collaudo sposta il confine fra i due anni (fine del 2026/27 e inizio del 2027/28) e tocca le due date di servizio
      await b.db.query(`SELECT public.sposta_confine_anno($1, (SELECT fine - 5 FROM public.anni_sede WHERE id = $1))`, [annoVecchio])
      await b.db.query(`UPDATE public.anni_sede SET ultimo_giorno_aperto = fine WHERE id = $1`, [annoNuovo])
      await b.db.query(`UPDATE public.anni_sede SET prepara_successivo_dal = inizio WHERE id = $1`, [annoVecchio])
      expect(await date(), 'il collaudo ha davvero cambiato le date').not.toBe(prima)
      const risultati = await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      await b.db.exec('SET CONSTRAINTS ALL IMMEDIATE') // i vincoli differiti (continuità, sovrapposizioni) si giudicano ORA, non al COMMIT che qui non c'è
      expect(await date()).toBe(prima)
      const voci = (risultati.at(-1)!.rows as { voce: string }[]).map((r) => r.voce)
      expect(voci.some((v) => v.startsWith('date degli anni')), 'l’esito lo dice').toBe(true)
    })
  })

  it('senza collaudo le date non si toccano; e una fotografia senza le date, o con una data che non lo è → AZZERA_FOTOGRAFIA', async () => {
    await inRollback(b.db, async () => {
      const dal = await adesso()
      const f = await fotografa()
      const j = JSON.parse(f.fotografia!)
      expect(Object.keys(j.date).sort(), 'le date dell’anno nuovo').toEqual(['fine', 'inizio', 'prepara_successivo_dal', 'ultimo_giorno_aperto'])
      expect(Object.keys(j.partenza.date).sort(), 'e quelle dell’anno di partenza').toEqual(['fine', 'inizio', 'prepara_successivo_dal', 'ultimo_giorno_aperto'])
      const prima = await date()
      await b.db.exec(dentro(compila({ sede: DEMO, foto: f.fotografia! })))
      expect(await date()).toBe(prima)
      const senzaDate = { ...j }
      delete senzaDate.date
      const senzaPartenza = { ...j, partenza: { ...j.partenza, date: undefined } }
      await fermato(compila({ sede: DEMO, foto: JSON.stringify(senzaDate) }), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify(senzaPartenza) }), 'AZZERA_FOTOGRAFIA', dal)
      await fermato(compila({ sede: DEMO, foto: JSON.stringify({ ...j, date: { ...j.date, fine: 'ieri' } }) }), 'AZZERA_FOTOGRAFIA', dal)
    })
  })
})

describe('azzera-anno-nuovo-demo.sql · una richiesta sola, COMMIT compreso', () => {
  // ULTIMA prova del file: scrive davvero (COMMIT), quindi niente ROLLBACK a proteggere il banco dopo di lei.
  it('riesce con il file COM’È (BEGIN, funzione, DO, DROP, COMMIT in un invio) e la scrittura è definitiva', async () => {
    const dal = await adesso()
    const f = await fotografa()
    await b.db.exec('BEGIN')
    await b.db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [annoNuovo, UTENTE])
    await b.db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 321, NULL)`, [annoNuovo])
    await b.db.exec('COMMIT') // il collaudo, che nel mondo vero è già avvenuto prima
    await ripristina(dal, (await statiDemo()).map((s) => (s.etichetta === '2027/28' ? { ...s, stato: 'in_preparazione', domande: false } : s)), false)
    expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [DEMO, annoNuovoId])).toBeGreaterThan(1)

    await b.db.exec(compila({ sede: DEMO, foto: f.fotografia! }))

    await expect(b.db.exec('COMMIT'), 'nessuna transazione aperta: un COMMIT in più è solo un avviso').resolves.toBeDefined()
    const foto = JSON.parse(f.fotografia!)
    expect(await configurazione()).toEqual({ listino: foto.listino, moduli: foto.moduli, posti: foto.posti })
    expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [DEMO, annoNuovoId])).toBe(1)
    expect(await una<string | null>(b.db, `SELECT to_regclass('pg_temp._azzera_cand')::text`), 'la tabella di lavoro è sparita col COMMIT').toBeNull()
    expect(await una<string | null>(b.db, `SELECT to_regprocedure('pg_temp.azzera_blocca(text, text[], text)')::text`), 'la funzione d’appoggio è sparita').toBeNull()
    expect(await una<number>(b.db, `SELECT count(*)::int FROM pg_temp._azzera_esito`), 'resta la tabella dell’esito, per le letture finali').toBeGreaterThan(0)
  })
})

