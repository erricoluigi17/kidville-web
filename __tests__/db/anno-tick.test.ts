import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2,
  SCHEMA_AVVISI_CHAT_VOCI_GENITORE,
  SCHEMA_GALLERIA_GENITORE,
  SCHEMA_ISCRIZIONE_ANNO,
  SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.2 · `anni_tick` (passo 1), il controllo notturno delle invarianti e la salute dell'anno (migrazione M45a).
 *
 * Il tick crea da solo l'anno successivo quando arriva il suo giorno e ne copia la configurazione. NON fa il passaggio e non
 * cambia lo stato di nessun anno. In produzione, fino al 01/09/2027, non ha niente da creare: il battito `ok` a vuoto è ciò che
 * si vedrà per mesi, e ha le sue prove.
 *
 * ── L'orologio ──
 * Il giorno si passa SEMPRE con `p_oggi` (che il tick ammette solo per una sede di prova o di simulazione). Mai `now()` come
 * ingresso di una prova. Le uniche due eccezioni sono dichiarate dove stanno: la prova «un errore su una sede non ferma le
 * altre» chiama il tick senza `p_oggi` (con `p_oggi` serve una sola sede) e la rende indipendente dal giorno dandole come
 * ultimo anno il 2026/27, il cui `prepara_successivo_dal` è nel passato per sempre; la prova della salute misura un ritardo
 * RELATIVO (oggi meno due giorni), perché la funzione legge l'orologio.
 *
 * Solo uuid finti: `e2e0…` sono le sedi di prova ammesse, `2222…` una sede «vera» che il tick deve rifiutare.
 */

const E = (n: number) => `e2e00000-0000-4000-8000-${String(n).padStart(12, '0')}`
const S_DUE_VOLTE = E(1)
const S_PRIMA = E(2)
const S_COPIA = E(3)
const S_CONFINI = E(4)
const S_STATI = E(5)
const S_PAG = E(6)
const S_AMMESSA = E(7)
const S_REALE = '22222222-2222-4222-8222-222222222222'
const S_SIMULATA = '33333333-3333-4333-8333-333333333333'
const TUTTE_LE_SEDI = [S_DUE_VOLTE, S_PRIMA, S_COPIA, S_CONFINI, S_STATI, S_PAG, S_AMMESSA, S_REALE, S_SIMULATA]

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_anno_tick.sql')) as string
const SQL_M45A = readFileSync(join(CARTELLA, FILE), 'utf8')

let db: PGlite

async function una<T>(sql: string, params: unknown[] = [], d: PGlite = db): Promise<T> {
  const r = await d.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** Il messaggio dell'eccezione: nel database è il codice stesso. */
async function messaggio(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  return 'nessun-errore'
}
interface EsitoTick { oggi: string; sedi: number; creati: number; copie: number; errori: number }
async function tick(oggi: string | null, sede: string | null, d: PGlite = db): Promise<EsitoTick> {
  return una<EsitoTick>(`SELECT public.anni_tick($1::date, $2::uuid)`, [oggi, sede], d)
}
async function nAnni(sede: string, d: PGlite = db): Promise<number> {
  return Number(await una<string>(`SELECT count(*)::text FROM public.anni_sede WHERE scuola_id = $1`, [sede], d))
}
/** Il giorno in cui l'ULTIMO anno della sede prepara il successivo (data della fixture, non un numero scritto qui). */
async function preparaDelUltimo(sede: string, d: PGlite = db): Promise<string> {
  return una<string>(
    `SELECT prepara_successivo_dal::text FROM public.anni_sede WHERE scuola_id = $1 ORDER BY inizio DESC LIMIT 1`, [sede], d)
}
async function giornoPiuUno(giorno: string, n: number, d: PGlite = db): Promise<string> {
  return una<string>(`SELECT ($1::date + $2::int)::text`, [giorno, n], d)
}
async function idUltimo(sede: string, d: PGlite = db): Promise<string> {
  return una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 ORDER BY inizio DESC LIMIT 1`, [sede], d)
}
/** Listino, moduli e posti di prova nell'ultimo anno della sede: i valori sono di questa prova. */
async function configurazione(sede: string): Promise<string> {
  const ultimo = await idUltimo(sede)
  await db.query(
    `INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, importo) VALUES
       ($1, 'retta', 'infanzia', 111.11), ($1, 'retta', 'nido_1', 222.22), ($1, 'quota_conferma', NULL, 33.33)`, [ultimo])
  await db.query(
    `INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo, ordine) VALUES
       ($1, 'conferma', 'm1', 'Modulo uno', 1), ($1, 'nuova', 'm2', 'Modulo due', 2)`, [ultimo])
  await db.query(
    `INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti, fonte) VALUES ($1, 'infanzia', 18, 'prova')`, [ultimo])
  return ultimo
}
async function battito(d: PGlite = db) {
  const r = await d.query<{ livello: string; occorrenze: number; campi: Record<string, unknown> }>(
    `SELECT livello, occorrenze, contesto -> 'campi' AS campi FROM public.app_log
      WHERE fingerprint = 'cron:anni-tick' ORDER BY visto_l_ultima DESC LIMIT 1`)
  return r.rows[0]
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: TUTTE_LE_SEDI, fino: 'M45a', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO,
  })
}, 180_000)
afterAll(async () => {
  await db?.close()
})

describe('il tick crea l’anno successivo il giorno giusto', () => {
  it('`anni_tick` rifatto due volte con `p_oggi = prepara_successivo_dal` crea un anno solo', async () => {
    const sorgente = await configurazione(S_DUE_VOLTE)
    const giorno = await preparaDelUltimo(S_DUE_VOLTE)
    const anniPrima = await nAnni(S_DUE_VOLTE)
    const voci = Number(await una<string>(`SELECT count(*)::text FROM public.listino_voci WHERE anno_sede_id = $1`, [sorgente]))
    const vociDellAnno = async (anno: string) =>
      Number(await una<string>(`SELECT count(*)::text FROM public.listino_voci WHERE anno_sede_id = $1`, [anno]))

    const primo = await tick(giorno, S_DUE_VOLTE)
    expect(primo).toEqual({ oggi: giorno, sedi: 1, creati: 1, copie: 1, errori: 0 })
    expect(await nAnni(S_DUE_VOLTE)).toBe(anniPrima + 1)
    const nuovo = await idUltimo(S_DUE_VOLTE)
    expect(nuovo).not.toBe(sorgente)
    expect(voci).toBeGreaterThanOrEqual(3)
    const vociDopoPrimo = await vociDellAnno(nuovo)
    expect(vociDopoPrimo).toBe(voci)

    const secondo = await tick(giorno, S_DUE_VOLTE)
    expect(secondo).toEqual({ oggi: giorno, sedi: 1, creati: 0, copie: 0, errori: 0 })
    expect(await nAnni(S_DUE_VOLTE)).toBe(anniPrima + 1)
    expect(await idUltimo(S_DUE_VOLTE)).toBe(nuovo)
    expect(await vociDellAnno(nuovo)).toBe(vociDopoPrimo)
    expect(await vociDellAnno(sorgente)).toBe(voci)
  })

  it('prima di `prepara_successivo_dal` non crea niente (il giorno prima, un mese prima, due mesi prima)', async () => {
    const giorno = await preparaDelUltimo(S_PRIMA)
    const anni = await nAnni(S_PRIMA)
    for (const indietro of [1, 31, 62]) {
      const r = await tick(await giornoPiuUno(giorno, -indietro), S_PRIMA)
      expect(r, `${indietro} giorni prima`).toMatchObject({ sedi: 1, creati: 0, copie: 0, errori: 0 })
      expect(await nAnni(S_PRIMA), `${indietro} giorni prima`).toBe(anni)
    }
    // e il giorno stesso sì: il confine è esattamente quello (`<=`), né un giorno prima né uno dopo
    expect((await tick(giorno, S_PRIMA)).creati).toBe(1)
    expect(await nAnni(S_PRIMA)).toBe(anni + 1)
  })

  it('l’anno nuovo copia listino, moduli e posti', async () => {
    const sorgente = await configurazione(S_COPIA)
    const r = await tick(await preparaDelUltimo(S_COPIA), S_COPIA)
    expect(r.creati).toBe(1)
    const nuovo = await idUltimo(S_COPIA)
    expect(nuovo).not.toBe(sorgente)

    const lista = async (tabella: string, colonne: string, anno: string) =>
      (await db.query<Record<string, unknown>>(`SELECT ${colonne} FROM public.${tabella} WHERE anno_sede_id = $1 ORDER BY 1, 2`, [anno])).rows
    for (const [tabella, colonne] of [
      ['listino_voci', 'voce, fascia, importo::text AS importo'],
      ['moduli_richiesti', 'lista, codice, titolo, ordine'],
      ['posti_autorizzati', 'fascia, posti, fonte'],
    ] as const) {
      const partenza = await lista(tabella, colonne, sorgente)
      const arrivo = await lista(tabella, colonne, nuovo)
      expect(partenza.length, `${tabella}: la partenza non è vuota`).toBeGreaterThan(0)
      expect(arrivo, tabella).toEqual(partenza)
    }
  })

  it('ha lo stesso giorno e mese di `fine` e `ultimo_giorno_aperto` anche se la sede li aveva spostati', async () => {
    // La sede ha spostato il confine di fine anno e l'ultimo giorno aperto: il nuovo anno li porta avanti di un anno, non li riporta al 31/08.
    await db.query(
      `UPDATE public.anni_sede SET fine = fine - 1, ultimo_giorno_aperto = ultimo_giorno_aperto - 40
        WHERE id = $1`, [await idUltimo(S_CONFINI)])
    const ultimo = (await db.query<{ fine: string; aperto: string; prepara: string }>(
      `SELECT fine::text, ultimo_giorno_aperto::text AS aperto, prepara_successivo_dal::text AS prepara
         FROM public.anni_sede WHERE id = $1`, [await idUltimo(S_CONFINI)])).rows[0]
    expect((await tick(ultimo.prepara, S_CONFINI)).creati).toBe(1)
    const nuovo = (await db.query<{ inizio: string; fine: string; aperto: string; prepara: string; stato: string; prima_fine: string; prima_aperto: string }>(
      `SELECT n.inizio::text, n.fine::text, n.ultimo_giorno_aperto::text AS aperto, n.prepara_successivo_dal::text AS prepara, n.stato,
              ($2::date + interval '1 year')::date::text AS prima_fine, ($3::date + interval '1 year')::date::text AS prima_aperto
         FROM public.anni_sede n WHERE n.id = $1`, [await idUltimo(S_CONFINI), ultimo.fine, ultimo.aperto])).rows[0]
    expect(nuovo.fine).toBe(nuovo.prima_fine)
    expect(nuovo.aperto).toBe(nuovo.prima_aperto)
    expect(nuovo.inizio).toBe(await giornoPiuUno(ultimo.fine, 1))
    expect(nuovo.prepara).toBe(nuovo.inizio)
    expect(nuovo.stato).toBe('in_preparazione')
  })

  it('il tick non cambia mai lo stato di un anno e non fa il passaggio', async () => {
    const prima = (await db.query<{ id: string; stato: string }>(
      `SELECT id, stato FROM public.anni_sede WHERE scuola_id = $1 ORDER BY id`, [S_STATI])).rows
    const attivoPrima = await una<string>(`SELECT public.anno_attivo($1)::text`, [S_STATI])
    const stati = Number(await una<string>(
      `SELECT count(*)::text FROM public.anni_sede_stati x JOIN public.anni_sede s ON s.id = x.anno_sede_id WHERE s.scuola_id = $1`, [S_STATI]))
    const frequenze = await una<string>(`SELECT count(*)::text FROM public.frequenze`)
    const sezioni = await una<string>(`SELECT count(*)::text FROM public.sections`)

    // tre giri con un giorno molto oltre `inizio` del nuovo anno: ogni giro crea UN anno, nessuno lo apre né lo chiude
    const lontano = await giornoPiuUno(await preparaDelUltimo(S_STATI), 3650)
    for (let i = 0; i < 3; i++) expect((await tick(lontano, S_STATI)).creati).toBe(1)

    const dopo = (await db.query<{ id: string; stato: string }>(
      `SELECT id, stato FROM public.anni_sede WHERE id = ANY ($1::uuid[]) ORDER BY id`, [prima.map((x) => x.id)])).rows
    expect(dopo).toEqual(prima)
    expect(await una<string>(`SELECT public.anno_attivo($1)::text`, [S_STATI])).toBe(attivoPrima)
    const nuovi = (await db.query<{ stato: string }>(
      `SELECT stato FROM public.anni_sede WHERE scuola_id = $1 AND NOT (id = ANY ($2::uuid[]))`, [S_STATI, prima.map((x) => x.id)])).rows
    expect(nuovi).toEqual([{ stato: 'in_preparazione' }, { stato: 'in_preparazione' }, { stato: 'in_preparazione' }])
    expect(Number(await una<string>(
      `SELECT count(*)::text FROM public.anni_sede_stati x JOIN public.anni_sede s ON s.id = x.anno_sede_id WHERE s.scuola_id = $1`, [S_STATI])))
      .toBe(stati + 3)
    expect(await una<string>(`SELECT count(*)::text FROM public.frequenze`)).toBe(frequenze)
    expect(await una<string>(`SELECT count(*)::text FROM public.sections`)).toBe(sezioni)
  })
})

describe('`p_oggi` si ammette solo per una sede di prova o di simulazione', () => {
  async function fotografia(): Promise<string> {
    const r = await db.query<{ f: string }>(
      `SELECT (SELECT count(*) FROM public.anni_sede)::text || '/' || (SELECT count(*) FROM public.anni_sede_stati)::text
              || '/' || (SELECT count(*) FROM public.anni_scolastici)::text || '/' || (SELECT count(*) FROM public.app_log)::text
              || '/' || (SELECT count(*) FROM public.listino_voci)::text AS f`)
    return r.rows[0].f
  }

  it('`p_oggi` su una sede vera → ANNI_TICK_OGGI_NON_AMMESSO, e nessuna riga cambia', async () => {
    const prima = await fotografia()
    const giorno = await preparaDelUltimo(S_REALE)
    expect(await messaggio(tick(giorno, S_REALE))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
    // anche con una sede di prova al posto di quella vera nell'argomento sbagliato: ammessa è solo la sede PASSATA
    expect(await messaggio(tick(giorno, S_SIMULATA))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
    expect(await fotografia()).toBe(prima)
  })

  it('`p_oggi` senza `p_scuola` → errore, e nessuna riga cambia', async () => {
    const prima = await fotografia()
    expect(await messaggio(tick('2030-01-01', null))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
    expect(await fotografia()).toBe(prima)
  })

  it('una sede in `sedi_simulazione` ammette `p_oggi`; toglierla lo rifiuta di nuovo', async () => {
    const giorno = await preparaDelUltimo(S_SIMULATA)
    const anni = await nAnni(S_SIMULATA)
    expect(await messaggio(tick(giorno, S_SIMULATA))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')

    await db.query(`UPDATE public.anno_regole SET sedi_simulazione = ARRAY[$1]::uuid[]`, [S_SIMULATA])
    expect((await tick(giorno, S_SIMULATA)).creati).toBe(1)
    expect(await nAnni(S_SIMULATA)).toBe(anni + 1)
    // l'elenco non ammette le altre sedi vere
    expect(await messaggio(tick(giorno, S_REALE))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')

    await db.query(`UPDATE public.anno_regole SET sedi_simulazione = '{}'`)
    expect(await messaggio(tick(await preparaDelUltimo(S_SIMULATA), S_SIMULATA))).toBe('ANNI_TICK_OGGI_NON_AMMESSO')
  })

  it('una sede col prefisso `e2e00000` è sempre ammessa, senza toccare l’elenco', async () => {
    expect(await una<string>(`SELECT coalesce(array_length(sedi_simulazione, 1), 0)::text FROM public.anno_regole`)).toBe('0')
    expect((await tick(await preparaDelUltimo(S_AMMESSA), S_AMMESSA)).creati).toBe(1)
  })

  it('la colonna nasce vuota e non nulla', async () => {
    const r = await db.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'anno_regole' AND column_name = 'sedi_simulazione'`)
    expect(r.rows[0].is_nullable).toBe('NO')
    expect(r.rows[0].column_default).toMatch(/'\{\}'/)
  })
})

describe('il giorno vero è sempre quello di Roma', () => {
  it('il default di `p_oggi` è NULL e il giorno si ricava da `giorno_roma(now())`, mai da `CURRENT_DATE`', () => {
    // PGlite non sposta `now()`: si prova sul testo, non sul comportamento.
    const m = SQL_M45A.match(/CREATE OR REPLACE FUNCTION public\.anni_tick\(([\s\S]*?)\$\$([\s\S]*?)\n\$\$;/)
    expect(m, 'anni_tick è definita in M45a').not.toBeNull()
    const firma = m![1]
    const corpo = m![2]
    expect(firma).toMatch(/p_oggi\s+date\s+DEFAULT\s+NULL/)
    expect(corpo).toContain('public.giorno_roma(now())')
    expect(SQL_M45A.replace(/--.*$/gm, '')).not.toMatch(/CURRENT_DATE|current_date/)
  })

  it('il tick non fa il passaggio: il corpo non scrive mai lo stato di un anno', () => {
    const corpo = SQL_M45A.replace(/--.*$/gm, '')
    expect(corpo).not.toMatch(/UPDATE\s+public\.anni_sede\b/i)
    expect(corpo).not.toMatch(/anno_passaggio|anno_apri_iscrizioni|anno_chiudi/i)
  })
})

describe('GIORNO_SENZA_ANNO · la consegna della PR 2', () => {
  async function voce(giorno: string): Promise<unknown> {
    return db.query(
      `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza)
       VALUES ($1, 'voce di prova', 10, $2, $2) RETURNING anno_id`, [S_PAG, giorno])
  }

  it('una voce con competenza dell’anno dopo l’ultimo fallisce prima del tick e passa dopo', async () => {
    const ultimo = (await db.query<{ fine: string; prepara: string }>(
      `SELECT fine::text, prepara_successivo_dal::text AS prepara FROM public.anni_sede
        WHERE scuola_id = $1 ORDER BY inizio DESC LIMIT 1`, [S_PAG])).rows[0]
    // una data dell'anno che il tick creerà, ricavata dal calendario della fixture
    const competenza = await giornoPiuUno(ultimo.fine, 40)
    await db.query(`UPDATE public.anno_regole SET controlli_rigidi = true`)
    try {
      expect(await messaggio(voce(competenza)), 'prima del tick nessun anno copre quel giorno').toBe('GIORNO_SENZA_ANNO')
      expect((await tick(ultimo.prepara, S_PAG)).creati).toBe(1)
      const r = await voce(competenza) as { rows: Array<{ anno_id: string | null }> }
      const nuovo = await una<string>(
        `SELECT anno_id FROM public.anni_sede WHERE scuola_id = $1 ORDER BY inizio DESC LIMIT 1`, [S_PAG])
      expect(r.rows[0].anno_id).toBe(nuovo)
    } finally {
      await db.query(`UPDATE public.anno_regole SET controlli_rigidi = false`)
    }
  })
})

describe('il battito e gli errori', () => {
  let db2: PGlite
  const A = E(21)
  const B = E(22)

  beforeAll(async () => {
    db2 = await creaDbAnnoPr2({ sedi: [A, B], fino: 'M45a', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
    // Per due sedi senza `p_oggi` serve un ultimo anno che prepari il successivo da un giorno che non passa mai: il 2026/27
    // (`prepara_successivo_dal` = 01/09/2026, nel passato per sempre). Si toglie il 2027/28 che la catena ha creato.
    await db2.exec(`
      DELETE FROM public.anni_sede_stati WHERE anno_sede_id IN (
        SELECT s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE y.anno_inizio >= 2027);
      DELETE FROM public.anni_sede WHERE anno_id IN (SELECT id FROM public.anni_scolastici WHERE anno_inizio >= 2027);
    `)
  }, 180_000)
  afterAll(async () => {
    await db2?.close()
  })

  it('un errore su una sede non ferma le altre, e il battito dice `ok-parziale`', async () => {
    // La sede B ha un calendario guasto: la sua `fine` è all'ultimo giorno possibile e «un anno dopo» non esiste.
    await db2.query(
      `UPDATE public.anni_sede SET fine = DATE '5874897-12-30', ultimo_giorno_aperto = DATE '5874897-12-01'
        WHERE scuola_id = $1 AND stato = 'corrente'`, [B])
    const anniA = await nAnni(A, db2)
    const anniB = await nAnni(B, db2)

    const r = await tick(null, null, db2)
    expect(r).toMatchObject({ sedi: 2, creati: 1, copie: 1, errori: 1 })
    expect(await nAnni(A, db2)).toBe(anniA + 1)
    expect(await nAnni(B, db2)).toBe(anniB)

    const b = await battito(db2)
    expect(b.livello).toBe('info')
    expect(b.campi).toMatchObject({ operazione: 'anni-tick', esito: 'ok-parziale', sedi: 2, creati: 1, copie: 1, errori: 1 })

    // l'errore c'è, con il solo codice e l'uuid della sede (nessun testo dell'eccezione)
    const err = (await db2.query<{ livello: string; scuola_id: string; campi: Record<string, unknown>; messaggio: string }>(
      `SELECT livello, scuola_id, contesto -> 'campi' AS campi, messaggio FROM public.app_log WHERE fingerprint LIKE 'anni-tick-errore:%'`)).rows
    expect(err).toHaveLength(1)
    expect(err[0].livello).toBe('error')
    expect(err[0].scuola_id).toBe(B)
    expect(Object.keys(err[0].campi).sort()).toEqual(['esito', 'operazione', 'sqlstate'])
    expect(err[0].campi.sqlstate).toMatch(/^[0-9A-Z]{5}$/)
    expect(err[0].messaggio).not.toMatch(/5874897/)

    // e l'anno creato per A ha lasciato la sua riga `info`, con soli uuid e conteggi
    const creato = (await db2.query<{ livello: string; campi: Record<string, unknown> }>(
      `SELECT livello, contesto -> 'campi' AS campi FROM public.app_log WHERE fingerprint LIKE 'anno-creato:%'`)).rows
    expect(creato).toHaveLength(1)
    expect(creato[0].livello).toBe('info')
    expect(creato[0].campi).toMatchObject({ operazione: 'anni-tick', esito: 'creato' })
  })

  it('battito `ok` anche a vuoto: nessuna sede ha niente da creare, e il battito c’è lo stesso', async () => {
    // A ha ora un 2027/28 che prepara il 01/09/2027: il giorno prima non c'è niente da fare
    const giorno = await giornoPiuUno(await preparaDelUltimo(A, db2), -1, db2)
    const r = await tick(giorno, A, db2)
    expect(r).toEqual({ oggi: giorno, sedi: 1, creati: 0, copie: 0, errori: 0 })
    const b = await battito(db2)
    expect(b.campi).toMatchObject({ operazione: 'anni-tick', esito: 'ok', sedi: 1, creati: 0, copie: 0, errori: 0 })
    expect(b.occorrenze).toBeGreaterThanOrEqual(2)
    // i conteggi del battito sono numeri, non testo
    for (const k of ['sedi', 'creati', 'copie', 'errori']) expect(typeof b.campi[k], k).toBe('number')
  })
})

describe('i job', () => {
  it('con `pg_cron` presente programma `anni-tick` ogni ora al minuto 10 e `anno-invarianti` alle 03:17', async () => {
    const r = await db.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job WHERE jobname IN ('anni-tick', 'anno-invarianti') ORDER BY jobname`)
    expect(r.rows.map((x) => [x.jobname, x.schedule])).toEqual([['anni-tick', '10 * * * *'], ['anno-invarianti', '17 3 * * *']])
    expect(r.rows[0].command).toMatch(/anni_tick\(\)/)
    expect(r.rows[1].command).toMatch(/anno_invarianti_notturno\(\)/)
  })

  it('senza `pg_cron` (il database della CI) la migrazione passa e non programma niente', async () => {
    const senza = await creaDbAnnoPr2({ sedi: [E(31)], fino: 'M45a' })
    try {
      const r = await senza.query<{ n: string }>(`SELECT count(*)::text n FROM pg_namespace WHERE nspname = 'cron'`)
      expect(r.rows[0].n).toBe('0')
      expect(await una<string>(`SELECT to_regproc('public.anni_tick')::text`, [], senza)).not.toBeNull()
    } finally {
      await senza.close()
    }
  })

  it('il tick e il controllo notturno sono delle sole funzioni di servizio', async () => {
    for (const f of ['anni_tick(date,uuid)', 'anno_invarianti_notturno()', 'salute_anno()']) {
      const r = await db.query<{ anon: boolean; auth: boolean; servizio: boolean; definer: boolean; cfg: string[] | null }>(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS servizio,
                p.prosecdef AS definer, p.proconfig AS cfg
           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`public.${f}`])
      expect(r.rows[0], f).toMatchObject({ anon: false, auth: false, servizio: true, definer: true })
      expect(r.rows[0].cfg?.join(','), f).toMatch(/search_path=public, pg_temp/)
    }
  })
})

describe('il controllo notturno delle invarianti e la salute', () => {
  let db3: PGlite
  const SEDE = E(41)
  const SEDE_LATE = E(42)

  async function statoSalute(): Promise<{ sedi_senza_successivo: number; in_ritardo_giorni: number; invarianti_non_zero: number }> {
    return una(`SELECT public.salute_anno()`, [], db3)
  }

  beforeAll(async () => {
    // Il banco della 4.4 (galleria, legami, avvisi): l'invariante 7 lo legge, e senza darebbe «controllo fallito» e mai zero.
    db3 = await creaDbAnnoPr2({
      sedi: [SEDE, SEDE_LATE], fino: 'M45a', codaPrima: SCHEMA_ISCRIZIONE_ANNO + SCHEMA_GALLERIA_GENITORE,
    })
    await db3.exec(SCHEMA_LEGAMI_GENITORE)
    await db3.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  }, 180_000)
  afterAll(async () => {
    await db3?.close()
  })

  it('con tutto a posto: zero, un battito `ok`, nessun errore', async () => {
    expect(await una<number>(`SELECT public.anno_invarianti_notturno()`, [], db3)).toBe(0)
    const b = (await db3.query<{ livello: string; campi: Record<string, unknown> }>(
      `SELECT livello, contesto -> 'campi' AS campi FROM public.app_log WHERE fingerprint = 'cron:anno-invarianti'`)).rows
    expect(b).toHaveLength(1)
    expect(b[0].livello).toBe('info')
    expect(b[0].campi).toMatchObject({ operazione: 'anno-invarianti', esito: 'ok', n_invarianti: 0, n_righe: 0 })
    expect(await una<string>(`SELECT count(*)::text FROM public.app_log WHERE fingerprint = 'anno-invarianti'`, [], db3)).toBe('0')
    expect((await statoSalute()).invarianti_non_zero).toBe(0)
  })

  it('`anno_invarianti_notturno` scrive un `error` quando una invariante non è zero, e il battito `ok` sempre', async () => {
    // L'invariante 5: una voce dell'anno attivo con la competenza nell'anno prima (a controlli morbidi la scrittura passa).
    const attivo = (await db3.query<{ anno_id: string; inizio: string }>(
      `SELECT s.anno_id, s.inizio::text FROM public.anni_sede s WHERE s.id = public.anno_attivo($1)`, [SEDE])).rows[0]
    // I trigger dell'anno rifiutano già la scrittura incoerente: per far salire la verifica si scrive come farebbe un dato
    // storto arrivato per un'altra via (trigger utente spenti il tempo di una INSERT).
    await db3.exec(`ALTER TABLE public.pagamenti DISABLE TRIGGER USER`)
    try {
      await db3.query(
        `INSERT INTO public.pagamenti (scuola_id, descrizione, importo, scadenza, periodo_competenza, anno_id)
         VALUES ($1, 'voce di prova', 10, $2::date, $2::date - 10, $3)`, [SEDE, attivo.inizio, attivo.anno_id])
    } finally {
      await db3.exec(`ALTER TABLE public.pagamenti ENABLE TRIGGER USER`)
    }

    expect(await una<number>(`SELECT public.anno_invarianti_notturno()`, [], db3)).toBe(1)

    const err = (await db3.query<{ livello: string; campi: Record<string, unknown> }>(
      `SELECT livello, contesto -> 'campi' AS campi FROM public.app_log WHERE fingerprint = 'anno-invarianti'`)).rows
    expect(err).toHaveLength(1)
    expect(err[0].livello).toBe('error')
    // solo i due numeri: nessun nome di tabella, nessuna riga
    expect(Object.keys(err[0].campi).sort()).toEqual(['esito', 'n_invarianti', 'n_righe', 'operazione'])
    expect(err[0].campi).toMatchObject({ operazione: 'anno-invarianti', n_invarianti: 1, n_righe: 1 })

    // il battito c'è anche stavolta, e dice che il lavoro è girato (ok), con lo stesso conteggio
    const b = (await db3.query<{ occorrenze: number; campi: Record<string, unknown> }>(
      `SELECT occorrenze, contesto -> 'campi' AS campi FROM public.app_log WHERE fingerprint = 'cron:anno-invarianti'`)).rows
    expect(b).toHaveLength(1)
    expect(b[0].occorrenze).toBe(2)
    expect(b[0].campi).toMatchObject({ operazione: 'anno-invarianti', esito: 'ok', n_invarianti: 1, n_righe: 1 })

    // la salute lo legge dall'ultimo giro notturno, senza rifarlo
    expect((await statoSalute()).invarianti_non_zero).toBe(1)
  })

  it('`salute_anno`: un anno successivo che manca da due giorni, uno che manca da meno di un giorno, uno che non è ancora il suo giorno', async () => {
    // La funzione legge l'orologio: il ritardo si prova in modo RELATIVO (oggi meno N giorni), mai con un giorno scritto qui.
    const crea = async (sede: string, anno: number, giorniDiRitardo: number) => {
      // la sede ha già i suoi anni (li ha dati la catena): si toglie tutto e le si dà un anno solo, con la scadenza voluta
      await db3.query(`DELETE FROM public.anni_sede_stati WHERE anno_sede_id IN (SELECT id FROM public.anni_sede WHERE scuola_id = $1)`, [sede])
      await db3.query(`DELETE FROM public.anni_sede WHERE scuola_id = $1`, [sede])
      await db3.query(`INSERT INTO public.anni_scolastici (anno_inizio) VALUES ($1) ON CONFLICT DO NOTHING`, [anno])
      await db3.query(
        `INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
         SELECT $1, y.id, g - 100, g + 200, 'in_preparazione', g + 150, g - $3::int
           FROM public.anni_scolastici y, (SELECT public.giorno_roma(now()) AS g) x WHERE y.anno_inizio = $2`,
        [sede, anno, giorniDiRitardo])
    }
    // Anche `SEDE` va resa relativa: la catena le ha dato il 2027/28, che dal 01/09/2027 sarebbe «in ritardo» e farebbe scadere
    // la prova col calendario. Un anno solo, il cui giorno non è ancora arrivato (oggi + 30), come per l'altra sede.
    await db3.query(`DELETE FROM public.pagamenti WHERE scuola_id = $1`, [SEDE]) // la voce storta della prova precedente tiene agganciato il suo anno
    await crea(SEDE, 2091, -30)
    await crea(SEDE_LATE, 2090, -30)
    expect(await statoSalute()).toMatchObject({ sedi_senza_successivo: 0, in_ritardo_giorni: 0 })
    await crea(SEDE_LATE, 2090, 2)
    expect(await statoSalute()).toMatchObject({ sedi_senza_successivo: 1, in_ritardo_giorni: 2 })

    // da meno di un giorno (il giorno stesso): conta come sede senza successivo ma lo scarto è zero
    await crea(SEDE_LATE, 2090, 0)
    expect(await statoSalute()).toMatchObject({ sedi_senza_successivo: 1, in_ritardo_giorni: 0 })

    // se il suo giorno non è ancora arrivato (fra 30 giorni), la sede non conta
    await crea(SEDE_LATE, 2090, -30)
    expect(await statoSalute()).toMatchObject({ sedi_senza_successivo: 0, in_ritardo_giorni: 0 })
  })

  it('la salute non scrive niente', async () => {
    const prima = await una<string>(`SELECT count(*)::text || '/' || coalesce(sum(occorrenze), 0)::text FROM public.app_log`, [], db3)
    await statoSalute()
    await statoSalute()
    expect(await una<string>(`SELECT count(*)::text || '/' || coalesce(sum(occorrenze), 0)::text FROM public.app_log`, [], db3)).toBe(prima)
  })
})
