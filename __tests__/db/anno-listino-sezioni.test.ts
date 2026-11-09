import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, SCHEMA_ISCRIZIONE_ANNO } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.5.3 · M45d · quote, moduli, posti e sezioni dell'anno prossimo, in PGlite vero (la migrazione si legge dal disco).
 *
 * Solo uuid finti. Il calendario è quello fisso del banco (2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione): nessuna
 * prova dipende da «oggi». Gli importi sono esempi di prova: nel codice non ce n'è nessuno predefinito.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALTRA = '22222222-2222-4222-8222-222222222223'
const UTENTE = '55555555-5555-4555-8555-555555555551'
const DOCENTE = '55555555-5555-4555-8555-555555555552'
const MATERIA = '55555555-5555-4555-8555-555555555553'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

let db: PGlite
let A26: string // anni_sede.id del 2026/27 (corrente) della SEDE
let A27: string // anni_sede.id del 2027/28 (in preparazione) della SEDE
let A26_ALTRA: string
let ANNO26: string // anni_scolastici.id
let ANNO27: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function errore(p: Promise<unknown>): Promise<{ codice: string; detail: Record<string, unknown> | null }> {
  try {
    await p
  } catch (e) {
    const x = e as { message: string; detail?: string }
    return { codice: x.message, detail: x.detail ? (JSON.parse(x.detail) as Record<string, unknown>) : null }
  }
  return { codice: 'nessun-errore', detail: null }
}
async function chiama(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  return una<Record<string, unknown>>(`SELECT ${sql}`, params)
}
const annoSede = (sede: string, anno: string) =>
  una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [sede, anno])
const nomiSezioni = async (annoSedeId: string) =>
  (
    await db.query<{ name: string }>(
      `SELECT s.name FROM public.sections s JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
        WHERE a.id = $1 ORDER BY s.name`,
      [annoSedeId],
    )
  ).rows.map((r) => r.name)
/** Le righe delle due quote (le altre voci del listino non sono di questo compito). */
const quote = (annoSedeId: string) =>
  una<number>(`SELECT count(*)::int FROM public.listino_voci WHERE anno_sede_id = $1 AND voce IN ('quota_conferma', 'quota_nuova')`, [annoSedeId])
const conta = (tabella: string, annoSedeId: string) =>
  una<number>(`SELECT count(*)::int FROM public.${tabella} WHERE anno_sede_id = $1`, [annoSedeId])

/** Il 2027/28 com'è nel banco: in preparazione, senza configurazione né sezioni, con le domande chiuse. */
async function ripristina() {
  await db.exec(`
    DELETE FROM public.utenti_sezioni_materie;
    DELETE FROM public.utenti_sezioni;
    DELETE FROM public.sections;
    DROP TRIGGER IF EXISTS prova_errore_a_meta ON public.sections;
    DELETE FROM public.listino_voci WHERE voce IN ('quota_conferma', 'quota_nuova');
    DELETE FROM public.moduli_richiesti;
    DELETE FROM public.posti_autorizzati;
    DELETE FROM public.anni_sede_stati WHERE stato = 'iscrizioni_aperte';
    UPDATE public.anni_sede SET stato = 'in_preparazione', domande_aperte = false
     WHERE stato = 'iscrizioni_aperte' OR (stato = 'in_preparazione');
  `)
}

/** Le due quote e un modulo per lista sul 2027/28: quanto basta ad `anno_prerequisiti_iscrizioni`. */
async function prerequisiti(anno = A27) {
  await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [anno])
  await chiama(`public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [anno])
  await chiama(`public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [anno])
  await chiama(`public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [anno])
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, ALTRA], fino: 'M45d', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  ANNO26 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  ANNO27 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  A26 = await annoSede(SEDE, ANNO26)
  A27 = await annoSede(SEDE, ANNO27)
  A26_ALTRA = await annoSede(ALTRA, ANNO26)
}, 120_000)
afterAll(async () => {
  await db?.close()
})
beforeEach(ripristina)

describe('quote, moduli e posti: i prerequisiti dell’apertura', () => {
  it('imposto le due quote e un modulo per lista: anno_prerequisiti_iscrizioni torna vuoto', async () => {
    expect(await una<string[]>(`SELECT public.anno_prerequisiti_iscrizioni($1)`, [A27])).toEqual([
      'quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova',
    ])
    await prerequisiti()
    expect(await una<string[]>(`SELECT public.anno_prerequisiti_iscrizioni($1)`, [A27])).toEqual([])
  })

  it('le quote: nuova, invariata (cambiato false), corretta, per fascia, con scadenza, tolta', async () => {
    const nuova = await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 120.5, DATE '2099-02-15')`, [A27])
    expect(nuova).toMatchObject({ cambiato: true, voce: 'quota_conferma', fascia: null, rimossa: false })
    const riga = await db.query<{ importo: string; scadenza: string; payment_category_id: string | null }>(
      `SELECT importo::text, scadenza::text, payment_category_id FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_conferma'`, [A27])
    expect(riga.rows).toEqual([{ importo: '120.50', scadenza: '2099-02-15', payment_category_id: null }])

    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 120.5, DATE '2099-02-15')`, [A27])).toMatchObject({ cambiato: false })
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 130, DATE '2099-02-15')`, [A27])).toMatchObject({ cambiato: true })
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 130, NULL)`, [A27])).toMatchObject({ cambiato: true })

    // una fascia è una riga a parte, e la riga senza fascia resta
    await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', 'infanzia', 90, NULL)`, [A27])
    expect(await una<number>(`SELECT count(*)::int FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_conferma'`, [A27])).toBe(2)

    // importo NULL toglie SOLO la riga nominata
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', 'infanzia', NULL, NULL)`, [A27])).toMatchObject({ cambiato: true, rimossa: true })
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', 'infanzia', NULL, NULL)`, [A27])).toMatchObject({ cambiato: false, rimossa: true })
    expect(await una<number>(`SELECT count(*)::int FROM public.listino_voci WHERE anno_sede_id = $1 AND voce = 'quota_conferma'`, [A27])).toBe(1)
  })

  it('le righe retta e servizio non si toccano e non si scrivono da qui', async () => {
    // il 2027/28 ha già la sua riga `retta` (la mette il riempimento della PR 2)
    await db.query(`INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, importo) VALUES ($1, 'servizio', 'infanzia', 150)`, [A27])
    const prima = await una<number>(`SELECT count(*)::int FROM public.listino_voci WHERE anno_sede_id = $1 AND voce IN ('retta', 'servizio')`, [A27])
    expect(prima).toBeGreaterThanOrEqual(2)
    await chiama(`public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 10, NULL)`, [A27])
    await chiama(`public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, NULL, NULL)`, [A27])
    expect(await una<number>(`SELECT count(*)::int FROM public.listino_voci WHERE anno_sede_id = $1 AND voce IN ('retta', 'servizio')`, [A27])).toBe(prima)
    const e = await errore(db.query(`SELECT public.anno_listino_quota_imposta($1, 'retta', NULL, 10, NULL)`, [A27]))
    expect(e).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'voce' } })
  })

  it.each([['0'], ['-5'], ['0.004'], ['100000000']])('importo %s → IMPORTO_NON_VALIDO e niente scritto', async (importo) => {
    const e = await errore(db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, ${importo}::numeric, NULL)`, [A27]))
    expect(e.codice).toBe('IMPORTO_NON_VALIDO')
    expect(await quote(A27)).toBe(0)
  })

  it('una scadenza nel passato → SCADENZA_QUOTA_NEL_PASSATO e niente scritto; oggi e il futuro passano (4.5.15)', async () => {
    const e = await errore(db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, public.giorno_roma(now()) - 1)`, [A27]))
    expect(e.codice).toBe('SCADENZA_QUOTA_NEL_PASSATO')
    expect(await quote(A27)).toBe(0)
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, public.giorno_roma(now()))`, [A27])).toMatchObject({ cambiato: true })
  })

  it('una fascia che non esiste → PARAMETRO_MANCANTE', async () => {
    const e = await errore(db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', 'liceo', 10, NULL)`, [A27]))
    expect(e).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'fascia' } })
  })

  it('i moduli: nuovo, titolo cambiato, ordine cambiato, invariato, tolto (anche se non c’è)', async () => {
    expect(await chiama(`public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', '  Informativa  ', 2)`, [A27])).toMatchObject({ cambiato: true, lista: 'conferma', codice: 'privacy' })
    expect((await db.query(`SELECT titolo, ordine FROM public.moduli_richiesti WHERE anno_sede_id = $1`, [A27])).rows).toEqual([{ titolo: 'Informativa', ordine: 2 }])
    expect(await chiama(`public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 2)`, [A27])).toMatchObject({ cambiato: false })
    expect(await chiama(`public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa privacy', NULL)`, [A27])).toMatchObject({ cambiato: true })
    expect(await una<number>(`SELECT ordine FROM public.moduli_richiesti WHERE anno_sede_id = $1`, [A27])).toBe(2) // NULL = non toccare
    expect(await chiama(`public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa privacy', 5)`, [A27])).toMatchObject({ cambiato: true })
    // lo stesso codice in un'altra lista è un altro modulo
    await chiama(`public.anno_modulo_richiesto_imposta($1, 'nuova', 'privacy', 'Informativa', NULL)`, [A27])
    expect(await conta('moduli_richiesti', A27)).toBe(2)

    expect(await chiama(`public.anno_modulo_richiesto_togli($1, 'conferma', 'privacy')`, [A27])).toMatchObject({ cambiato: true })
    expect(await chiama(`public.anno_modulo_richiesto_togli($1, 'conferma', 'privacy')`, [A27])).toMatchObject({ cambiato: false })
    expect(await conta('moduli_richiesti', A27)).toBe(1)
  })

  it('i moduli: titolo vuoto o oltre 120 caratteri, lista o codice sbagliati → PARAMETRO_MANCANTE col nome del campo', async () => {
    const prova = (lista: string, codice: string, titolo: string) =>
      errore(db.query(`SELECT public.anno_modulo_richiesto_imposta($1, $2, $3, $4, 1)`, [A27, lista, codice, titolo]))
    expect(await prova('conferma', 'privacy', '   ')).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'titolo' } })
    expect(await prova('conferma', 'privacy', 'x'.repeat(121))).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'titolo' } })
    expect((await errore(db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', $2, 1)`, [A27, 'x'.repeat(120)]))).codice).toBe('nessun-errore')
    expect(await prova('altra', 'privacy', 'Titolo')).toMatchObject({ detail: { campo: 'lista' } })
    expect(await prova('conferma', 'Con Spazi', 'Titolo')).toMatchObject({ detail: { campo: 'codice' } })
    expect(await prova('conferma', '', 'Titolo')).toMatchObject({ detail: { campo: 'codice' } })
  })

  it('i posti: nuovi, invariati, corretti, con la fonte, tolti con NULL; negativi rifiutati', async () => {
    expect(await chiama(`public.anno_posti_imposta($1, 'infanzia', 40, ' Autorizzazione n. 1 ')`, [A27])).toMatchObject({ cambiato: true, fascia: 'infanzia' })
    expect((await db.query(`SELECT posti, fonte FROM public.posti_autorizzati WHERE anno_sede_id = $1`, [A27])).rows).toEqual([{ posti: 40, fonte: 'Autorizzazione n. 1' }])
    expect(await chiama(`public.anno_posti_imposta($1, 'infanzia', 40, 'Autorizzazione n. 1')`, [A27])).toMatchObject({ cambiato: false })
    expect(await chiama(`public.anno_posti_imposta($1, 'infanzia', 0, NULL)`, [A27])).toMatchObject({ cambiato: true })
    expect(await una<number>(`SELECT posti FROM public.posti_autorizzati WHERE anno_sede_id = $1`, [A27])).toBe(0)
    expect(await chiama(`public.anno_posti_imposta($1, 'infanzia', NULL, NULL)`, [A27])).toMatchObject({ cambiato: true, rimossa: true })
    expect(await conta('posti_autorizzati', A27)).toBe(0)
    expect(await errore(db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', -1, NULL)`, [A27]))).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'posti' } })
    expect(await errore(db.query(`SELECT public.anno_posti_imposta($1, 'liceo', 5, NULL)`, [A27]))).toMatchObject({ codice: 'PARAMETRO_MANCANTE', detail: { campo: 'fascia' } })
  })

  it('anno corrente (o chiuso) → ANNO_NON_MODIFICABILE per tutte e quattro, e niente scritto', async () => {
    const chiuso = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND stato = 'chiuso'`, [SEDE])
    for (const anno of [A26, chiuso]) {
      for (const sql of [
        `SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`,
        `SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`,
        `SELECT public.anno_modulo_richiesto_togli($1, 'conferma', 'privacy')`,
        `SELECT public.anno_posti_imposta($1, 'infanzia', 10, NULL)`,
      ]) {
        const e = await errore(db.query(sql, [anno]))
        expect(e.codice, sql).toBe('ANNO_NON_MODIFICABILE')
        expect(e.detail).toMatchObject({ anno_sede_id: anno })
      }
      expect(await quote(anno)).toBe(0)
      expect(await conta('moduli_richiesti', anno)).toBe(0)
      expect(await conta('posti_autorizzati', anno)).toBe(0)
    }
  })

  it('un anno che non esiste → ANNO_NON_TROVATO', async () => {
    const x = '99999999-9999-4999-8999-999999999999'
    expect((await errore(db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', 1, NULL)`, [x]))).codice).toBe('ANNO_NON_TROVATO')
    expect((await errore(db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [A26, x]))).codice).toBe('ANNO_NON_TROVATO')
  })

  it('con le iscrizioni aperte le quote si correggono ancora', async () => {
    await prerequisiti()
    await chiama(`public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE])
    expect(await chiama(`public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 111, NULL)`, [A27])).toMatchObject({ cambiato: true })
    expect(await chiama(`public.anno_posti_imposta($1, 'infanzia', 30, NULL)`, [A27])).toMatchObject({ cambiato: true })
  })
})

describe('anno_copia_sezioni', () => {
  async function seme() {
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES
      ($1, $2, 'Girasoli', 'infanzia', 'infanzia'), ($1, $2, 'Coccinelle', 'nido', 'nido_2'), ($1, $2, 'Prima A', 'primaria', 'primaria')`, [SEDE, ANNO26])
    // le altre cose che stanno intorno a una sezione di oggi: docenti, materie
    const sez = await una<string>(`SELECT id FROM public.sections WHERE scuola_id = $1 AND name = 'Girasoli'`, [SEDE])
    await db.query(`INSERT INTO public.utenti (id) VALUES ($1) ON CONFLICT DO NOTHING`, [DOCENTE])
    await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOCENTE, sez])
    await db.query(`INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id) VALUES ($1, $2, $3)`, [DOCENTE, sez, MATERIA])
  }

  it('copia le sezioni di oggi con continua_da, grado e fascia; rifatta non ne crea altre', async () => {
    await seme()
    const r = await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])
    expect(r).toEqual({ copiate: 3, gia_presenti: 0 })
    expect(await nomiSezioni(A27)).toEqual(['Coccinelle', 'Girasoli', 'Prima A'])
    const righe = await db.query<{ name: string; school_type: string; fascia: string; da: string; continua: boolean }>(
      `SELECT n.name, n.school_type::text, n.fascia, v.name AS da, (n.continua_da = v.id) AS continua
         FROM public.sections n JOIN public.sections v ON v.id = n.continua_da
        WHERE n.anno_id = $1 ORDER BY n.name`, [ANNO27])
    expect(righe.rows).toEqual([
      { name: 'Coccinelle', school_type: 'nido', fascia: 'nido_2', da: 'Coccinelle', continua: true },
      { name: 'Girasoli', school_type: 'infanzia', fascia: 'infanzia', da: 'Girasoli', continua: true },
      { name: 'Prima A', school_type: 'primaria', fascia: 'primaria', da: 'Prima A', continua: true },
    ])
    // le sezioni di oggi non sono cambiate
    expect(await nomiSezioni(A26)).toEqual(['Coccinelle', 'Girasoli', 'Prima A'])

    expect(await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])).toEqual({ copiate: 0, gia_presenti: 3 })
    expect(await una<number>(`SELECT count(*)::int FROM public.sections WHERE anno_id = $1`, [ANNO27])).toBe(3)
  })

  it('rilanciata dopo aver aggiunto una classe, copia solo quella', async () => {
    await seme()
    await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Api', 'infanzia')`, [SEDE, ANNO26])
    expect(await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])).toEqual({ copiate: 1, gia_presenti: 3 })
    expect(await nomiSezioni(A27)).toEqual(['Api', 'Coccinelle', 'Girasoli', 'Prima A'])
  })

  it('non copia docenti, orari, materie: le tabelle figlie restano a zero per le sezioni nuove', async () => {
    await seme()
    expect(await una<number>(`SELECT count(*)::int FROM public.utenti_sezioni`)).toBe(1)
    await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])
    const nuove = `(SELECT id FROM public.sections WHERE anno_id = '${ANNO27}')`
    expect(await una<number>(`SELECT count(*)::int FROM public.utenti_sezioni WHERE section_id IN ${nuove}`)).toBe(0)
    expect(await una<number>(`SELECT count(*)::int FROM public.utenti_sezioni_materie WHERE section_id IN ${nuove}`)).toBe(0)
    // le tabelle di oggi sono intatte
    expect(await una<number>(`SELECT count(*)::int FROM public.utenti_sezioni`)).toBe(1)
    expect(await una<number>(`SELECT count(*)::int FROM public.utenti_sezioni_materie`)).toBe(1)
  })

  it('una copia rinominata a mano resta la continuazione della sua sezione: rifatta non ne nasce un’altra', async () => {
    await seme()
    await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])
    await db.query(`UPDATE public.sections SET name = 'Girasoli grandi' WHERE anno_id = $1 AND name = 'Girasoli'`, [ANNO27])
    expect(await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])).toEqual({ copiate: 0, gia_presenti: 3 })
    expect(await nomiSezioni(A27)).toEqual(['Coccinelle', 'Girasoli grandi', 'Prima A'])
  })

  it('una omonima già presente (stessa forma normalizzata) non si copia due volte', async () => {
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Gira Soli', 'infanzia')`, [SEDE, ANNO26])
    // il nome è «Gira Soli» a destinazione: la forma normalizzata di «Girasoli» è la stessa
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'GIRASOLI', 'infanzia')`, [SEDE, ANNO27])
    expect(await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])).toEqual({ copiate: 0, gia_presenti: 1 })
    expect(await nomiSezioni(A27)).toEqual(['GIRASOLI'])
  })

  it('l’anno di arrivo deve essere in preparazione o aperto, della stessa sede, e diverso da quello di partenza', async () => {
    await seme()
    expect((await errore(db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [A27, A26]))).codice).toBe('ANNO_NON_MODIFICABILE')
    expect((await errore(db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [A26, A26_ALTRA]))).codice).toBe('SEDE_DIVERSA')
    expect((await errore(db.query(`SELECT public.anno_copia_sezioni($1, $1)`, [A27]))).codice).toBe('ANNO_NON_COERENTE')
    expect(await una<number>(`SELECT count(*)::int FROM public.sections WHERE anno_id = $1`, [ANNO27])).toBe(0)
  })

  it('le sezioni di un’altra sede non entrano', async () => {
    await seme()
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Altrove', 'infanzia')`, [ALTRA, ANNO26])
    await chiama(`public.anno_copia_sezioni($1, $2)`, [A26, A27])
    expect(await nomiSezioni(A27)).not.toContain('Altrove')
    expect(await una<number>(`SELECT count(*)::int FROM public.sections WHERE scuola_id = $1 AND anno_id = $2`, [ALTRA, ANNO27])).toBe(0)
  })
})

describe('anno_apri_iscrizioni (ridefinita)', () => {
  it('crea le sezioni, cambia stato e apre le domande dal sito nella stessa transazione', async () => {
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Girasoli', 'infanzia'), ($1, $2, 'Api', 'infanzia')`, [SEDE, ANNO26])
    await prerequisiti()
    const r = await chiama(`public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE])
    expect(r).toMatchObject({ cambiato: true, anno_sede_id: A27, stato: 'iscrizioni_aperte', stato_precedente: 'in_preparazione', domande_aperte: true, sezioni_copiate: 2 })
    expect(await nomiSezioni(A27)).toEqual(['Api', 'Girasoli'])
    const a = await db.query<{ stato: string; domande_aperte: boolean }>(`SELECT stato, domande_aperte FROM public.anni_sede WHERE id = $1`, [A27])
    expect(a.rows).toEqual([{ stato: 'iscrizioni_aperte', domande_aperte: true }])
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND stato = 'iscrizioni_aperte'`, [A27])).toBe(1)

    // aprire di nuovo non fa niente: né una seconda riga di storico né altre sezioni
    expect(await chiama(`public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE])).toMatchObject({ cambiato: false, stato: 'iscrizioni_aperte' })
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND stato = 'iscrizioni_aperte'`, [A27])).toBe(1)
    expect(await nomiSezioni(A27)).toEqual(['Api', 'Girasoli'])
  })

  it('senza sezioni nell’anno in corso apre lo stesso, con sezioni_copiate 0', async () => {
    await prerequisiti()
    expect(await chiama(`public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE])).toMatchObject({ cambiato: true, sezioni_copiate: 0 })
  })

  it('un errore a metà non lascia sezioni, né cambia stato, né apre le domande', async () => {
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Api', 'infanzia'), ($1, $2, 'Girasoli', 'infanzia')`, [SEDE, ANNO26])
    await prerequisiti()
    // la seconda copia (in ordine di nome: Api, poi Girasoli) fallisce: la prima è già scritta quando scatta
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.prova_errore_a_meta() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.name = 'Girasoli' AND NEW.continua_da IS NOT NULL THEN RAISE EXCEPTION 'ERRORE_DI_PROVA'; END IF; RETURN NEW; END $f$;
      CREATE TRIGGER prova_errore_a_meta BEFORE INSERT ON public.sections FOR EACH ROW EXECUTE FUNCTION public.prova_errore_a_meta();
    `)
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE]))
    expect(e.codice).toBe('ERRORE_DI_PROVA')
    expect(await nomiSezioni(A27)).toEqual([])
    const a = await db.query<{ stato: string; domande_aperte: boolean }>(`SELECT stato, domande_aperte FROM public.anni_sede WHERE id = $1`, [A27])
    expect(a.rows).toEqual([{ stato: 'in_preparazione', domande_aperte: false }])
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede_stati WHERE anno_sede_id = $1 AND stato = 'iscrizioni_aperte'`, [A27])).toBe(0)
  })

  it('i prerequisiti mancanti fermano tutto prima di copiare: niente sezioni', async () => {
    await db.query(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type) VALUES ($1, $2, 'Api', 'infanzia')`, [SEDE, ANNO26])
    const e = await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [A27, UTENTE]))
    expect(e.codice).toBe('PREREQUISITI_MANCANTI')
    expect(await nomiSezioni(A27)).toEqual([])
  })

  it('un anno corrente non si apre (STATO_NON_AMMESSO) e un id sconosciuto è ANNO_NON_TROVATO', async () => {
    expect((await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [A26, UTENTE]))).codice).toBe('STATO_NON_AMMESSO')
    expect((await errore(db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, ['99999999-9999-4999-8999-999999999999', UTENTE]))).codice).toBe('ANNO_NON_TROVATO')
  })
})

describe('domande_aperte: il riempimento e la sede nuova', () => {
  it('dopo la migrazione ogni anno corrente ha domande_aperte = true, gli altri no', async () => {
    const r = await db.query<{ stato: string; aperte: number; chiuse: number }>(
      `SELECT stato, count(*) FILTER (WHERE domande_aperte)::int AS aperte, count(*) FILTER (WHERE NOT domande_aperte)::int AS chiuse
         FROM public.anni_sede GROUP BY stato ORDER BY stato`)
    const per = Object.fromEntries(r.rows.map((x) => [x.stato, x]))
    expect(per.corrente).toMatchObject({ aperte: 2, chiuse: 0 })
    expect(per.in_preparazione).toMatchObject({ aperte: 0, chiuse: 2 })
    expect(per.chiuso).toMatchObject({ aperte: 0, chiuse: 2 })
  })

  it('il riempimento è idempotente e tocca solo l’anno corrente', async () => {
    await db.exec(`UPDATE public.anni_sede SET domande_aperte = true WHERE stato = 'chiuso'`)
    await db.exec(readFileSync(join(CARTELLA, fileM45d()), 'utf8')) // la migrazione per intero, di nuovo
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede WHERE stato = 'corrente' AND domande_aperte`)).toBe(2)
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede WHERE stato = 'in_preparazione' AND domande_aperte`)).toBe(0)
    // l'anno chiuso lasciato a true da un test non lo ha toccato nessuno (e nemmeno rimesso a false)
    expect(await una<number>(`SELECT count(*)::int FROM public.anni_sede WHERE stato = 'chiuso' AND domande_aperte`)).toBe(2)
    await db.exec(`UPDATE public.anni_sede SET domande_aperte = false WHERE stato = 'chiuso'`)
  })

  it('una sede nuova nasce con il suo anno corrente aperto alle domande, e gli altri anni chiusi', async () => {
    const NUOVA = '22222222-2222-4222-8222-222222222224'
    await db.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede nuova di prova')`, [NUOVA])
    const r = await db.query<{ stato: string; domande_aperte: boolean }>(
      `SELECT stato, domande_aperte FROM public.anni_sede WHERE scuola_id = $1 ORDER BY inizio`, [NUOVA])
    expect(r.rows.length).toBeGreaterThanOrEqual(2)
    for (const x of r.rows) expect(x.domande_aperte, x.stato).toBe(x.stato === 'corrente')
    expect(r.rows.some((x) => x.stato === 'corrente')).toBe(true)
    await db.query(`DELETE FROM public.schools WHERE id = $1`, [NUOVA])
  })

  it('l’anno successivo creato dal job nasce chiuso alle domande come oggi', async () => {
    const NUOVA = '22222222-2222-4222-8222-222222222225'
    await db.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede nuova di prova')`, [NUOVA])
    await db.query(`SELECT public.anni_sede_crea_successivo($1, DATE '2026-11-06')`, [NUOVA])
    const r = await db.query<{ domande_aperte: boolean }>(
      `SELECT s.domande_aperte FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
        WHERE s.scuola_id = $1 AND y.anno_inizio = (SELECT max(y2.anno_inizio) FROM public.anni_sede s2 JOIN public.anni_scolastici y2 ON y2.id = s2.anno_id WHERE s2.scuola_id = $1)`, [NUOVA])
    expect(r.rows).toEqual([{ domande_aperte: false }])
    await db.query(`DELETE FROM public.schools WHERE id = $1`, [NUOVA])
  })
})

function fileM45d(): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith('_anno_listino_moduli_sezioni.sql'))
  if (!f) throw new Error('manca la migrazione M45d')
  return f
}

describe('la migrazione M45d', () => {
  const sql = readFileSync(join(CARTELLA, fileM45d()), 'utf8')
  const senzaCommenti = sql.replace(/^\s*--.*$/gm, '')

  it('il riempimento è UNA riga, senza sede nominata', () => {
    const scritture = senzaCommenti.match(/^\s*UPDATE public\.anni_sede[\s\S]*?;/gm) ?? []
    // l'unico UPDATE fuori da una funzione è il riempimento: gli altri due stanno dentro `$$ … $$`
    const fuori = senzaCommenti.replace(/\$\$[\s\S]*?\$\$/g, '').match(/UPDATE public\.anni_sede[\s\S]*?;/g) ?? []
    expect(scritture.length).toBeGreaterThanOrEqual(1)
    expect(fuori).toEqual(["UPDATE public.anni_sede SET domande_aperte = true WHERE stato = 'corrente' AND domande_aperte = false;"])
  })

  it('nessun uuid di sede, nessun importo o data del 2027/28, niente schools.operativa, niente SQL dinamico', () => {
    expect(senzaCommenti).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(senzaCommenti).not.toMatch(/operativa/)
    expect(senzaCommenti).not.toMatch(/\b2027\b|\b2028\b/)
    expect(senzaCommenti).not.toMatch(/\bEXECUTE\s+(?!ON\b)/i)
    expect(senzaCommenti).not.toMatch(/\bDELETE\s+FROM\s+public\.(sections|anni_sede)\b/)
  })

  it('anno_copia_sezioni nomina le colonne una per una e non legge né docenti né orari né materie', () => {
    const corpo = senzaCommenti.slice(senzaCommenti.indexOf('FUNCTION public.anno_copia_sezioni'), senzaCommenti.indexOf('FUNCTION public.anno_apri_iscrizioni'))
    expect(corpo.length).toBeGreaterThan(500)
    expect(corpo).toContain('INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da)')
    expect(corpo).not.toMatch(/utenti_sezioni|orari|materi|pg_attribute|information_schema/i)
  })

  it('le funzioni nuove sono SECURITY DEFINER con search_path fisso e solo il service_role le esegue', async () => {
    const f = await db.query<{ proname: string; definer: boolean; cfg: string[] | null }>(
      `SELECT proname, prosecdef AS definer, proconfig AS cfg FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('anno_listino_quota_imposta', 'anno_modulo_richiesto_imposta', 'anno_modulo_richiesto_togli',
                          'anno_posti_imposta', 'anno_copia_sezioni', 'anno_apri_iscrizioni', 'schools_crea_anni')`)
    expect(f.rows).toHaveLength(7)
    for (const x of f.rows) {
      expect(x.definer, x.proname).toBe(true)
      expect(x.cfg?.join(','), x.proname).toContain('search_path=public, pg_temp')
    }
    const p = await db.query<{ proname: string; anon: boolean; auth: boolean; srv: boolean }>(
      `SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS srv
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('anno_listino_quota_imposta', 'anno_modulo_richiesto_imposta', 'anno_modulo_richiesto_togli',
                            'anno_posti_imposta', 'anno_copia_sezioni', 'anno_apri_iscrizioni', 'schools_crea_anni')`)
    for (const x of p.rows) expect(x, x.proname).toMatchObject({ anon: false, auth: false, srv: true })
  })
})
