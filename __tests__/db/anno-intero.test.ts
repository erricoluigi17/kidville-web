import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { BAMBINI, SEDE_E2E, UTENTE, creaBancoPassaggio, errore, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * COMPITO 4.9.6 · L'ANNO INTERO, SU UN BANCO SOLO (PGlite), A GUARDIA ACCESA, CON IL GIORNO ESPLICITO.
 *
 * Il percorso che una sede fa davvero in un anno, dal tick alla correzione di un anno chiuso:
 *   a metà anno il tick non muta niente → il giorno dopo l'ultimo giorno aperto la segreteria fa il passaggio (4.8) con la guardia
 *   accesa → il tick dopo la conferma NON tocca ciò che la conferma ha già mosso → un annullamento rifiutato da una presenza del
 *   nuovo anno, poi consentito → una nuova conferma → a fine anno il tick chiude → su un anno chiuso scrive solo chi ha un gettone.
 *
 * Il giorno si passa SEMPRE come `p_oggi` (ammesso per la sede di prova `e2e0…`): nessuna prova dipende dall'orologio della macchina.
 * Le date dell'anno vengono dal database (`anni_sede`), mai scritte qui. Ogni prova finisce in ROLLBACK.
 *
 * Non vede: il tick con due connessioni concorrenti (PGlite ne ha una) e il cron vero (la riga `cron.job` non esiste nel banco).
 */

let b: BancoPassaggio
afterEach(() => {
  vi.useRealTimers()
})
beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b' })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

interface Anno { id: string; stato: string; domande_aperte: boolean; inizio: string; fine: string; ultimo: string }

async function anno(id: string): Promise<Anno> {
  return (await b.db.query<Anno>(
    `SELECT id, stato, domande_aperte, inizio::text, fine::text, ultimo_giorno_aperto::text AS ultimo FROM public.anni_sede WHERE id = $1`, [id])).rows[0]
}
const tick = (oggi: string) => b.db.query(`SELECT public.anni_tick($1::date, $2::uuid)`, [oggi, SEDE_E2E])
const giorno = (base: string, n: number) => una<string>(b.db, `SELECT ($1::date + $2::int)::text`, [base, n])
const guardia = (accesa: boolean) => b.db.query(`UPDATE public.anno_regole SET guardia_attiva = $1`, [accesa])
const anteprima = async () =>
  (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
const correggi = (p: string, alunno: string, esito: string) =>
  b.db.query(`SELECT public.passaggio_riga_correggi($1::uuid, $2::uuid, $3::text, NULL, $4::uuid)`, [p, alunno, esito, UTENTE])
const conferma = (p: string, oggi: string) =>
  una<{ gia_confermato: boolean }>(b.db, `SELECT public.passaggio_conferma($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const annulla = (p: string, oggi: string) =>
  una<{ gia_annullato?: boolean }>(b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, oggi])
const invarianti = async () =>
  (await b.db.query<{ invariante: number | string; tabella: string | null }>(`SELECT invariante, tabella FROM public.anno_invarianti() WHERE righe > 0 ORDER BY 1, 2`)).rows

/** Le due decisioni che il banco richiede alla segreteria prima di confermare (le stesse del test 4.8.10). */
async function decidi(p: string) {
  await correggi(p, BAMBINI.ritiratoTendina, 'continua')
  await correggi(p, BAMBINI.cambiaGradoSenzaSezione, 'esce')
}

describe('4.9.6 · l’anno intero', () => {
  it('parte dal banco che ci si aspetta: vecchio corrente, nuovo a iscrizioni aperte, guardia spenta come in produzione', async () => {
    const da = await anno(b.da)
    const a = await anno(b.a)
    expect(da.stato).toBe('corrente')
    expect(a.stato).toBe('iscrizioni_aperte')
    expect(da.ultimo < da.fine, 'l’ultimo giorno aperto precede la fine dell’anno').toBe(true)
    expect(await una<boolean>(b.db, `SELECT guardia_attiva FROM public.anno_regole`)).toBe(false)
  })

  it('a metà anno e fino all’ultimo giorno aperto il tick non cambia lo stato di niente', async () => {
    await inRollback(b.db, async () => {
      await guardia(true)
      const da = await anno(b.da)
      for (const g of [await giorno(da.inizio, 30), da.ultimo]) {
        await tick(g)
        expect((await anno(b.da)).stato, g).toBe('corrente')
        expect((await anno(b.a)).stato, g).toBe('iscrizioni_aperte')
      }
    })
  })

  it('tutto l’anno: passaggio, tick dopo la conferma, annullamento rifiutato e consentito, riconferma, chiusura, correzione', async () => {
    await inRollback(b.db, async () => {
      await guardia(true)
      const invariantiPrima = await invarianti()
      const prima = await anno(b.da)

      // ── 1. Il passaggio con la guardia accesa: le scritture della conferma non le ferma la guardia.
      const p = await anteprima()
      await decidi(p)
      expect((await conferma(p, b.oggi)).gia_confermato).toBe(false)
      const vecchio = await anno(b.da)
      expect(vecchio.stato).toBe('in_chiusura')
      expect(vecchio.domande_aperte, 'un anno in chiusura non accetta domande').toBe(false)
      expect((await anno(b.a)).stato).toBe('corrente')
      expect(await invarianti(), 'dopo la conferma nessuna invariante in più').toEqual(invariantiPrima)

      // ── 2. Il tick dopo la conferma non tocca ciò che la conferma ha già mosso (e non promuove MAI niente a corrente).
      await tick(b.oggi)
      expect((await anno(b.da)).stato).toBe('in_chiusura')
      expect((await anno(b.a)).stato).toBe('corrente')

      // ── 3. L'annullamento è rifiutato se il nuovo anno ha già del lavoro dentro; tolto quello, passa.
      const alunno = await una<string>(b.db, `SELECT id FROM public.alunni WHERE scuola_id = $1 AND id = $2`, [SEDE_E2E, BAMBINI.continua])
      const nuova = await anno(b.a)
      const presenza = await una<string>(
        b.db,
        `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [alunno, SEDE_E2E, nuova.inizio, b.sezioni.girasoliNuova])
      expect(await errore(b.db, `SELECT public.passaggio_annulla($1::uuid, $2::uuid, $3::date)`, [p, UTENTE, b.oggi])).toBe('PASSAGGIO_NON_ANNULLABILE')
      await b.db.query(`DELETE FROM public.presenze WHERE id = $1`, [presenza])
      expect((await annulla(p, b.oggi)).gia_annullato ?? false).toBe(false)
      expect((await anno(b.da)).stato).toBe('corrente')
      expect((await anno(b.a)).stato).toBe('iscrizioni_aperte')

      // ── 4. Annullato DOPO l'ultimo giorno aperto: il tick riporta da solo il vecchio anno a `in_chiusura` (il calendario lo
      //       vuole), il nuovo resta `iscrizioni_aperte` (non si promuove da solo): è il «passaggio non fatto» che l'allarme 4.9.2 segnala.
      await tick(b.oggi)
      expect((await anno(b.da)).stato).toBe('in_chiusura')
      expect((await anno(b.a)).stato).toBe('iscrizioni_aperte')
      expect(prima.stato).toBe('corrente')
    })
  })

  it('a fine anno il tick chiude, e su un anno chiuso scrive solo chi ha un gettone di correzione', async () => {
    await inRollback(b.db, async () => {
      await guardia(true)
      const p = await anteprima()
      await decidi(p)
      await conferma(p, b.oggi)
      const da = await anno(b.da)

      await tick(da.fine)
      expect((await anno(b.da)).stato, 'l’ultimo giorno dell’anno è ancora in chiusura').toBe('in_chiusura')
      await tick(await giorno(da.fine, 1))
      const chiuso = await anno(b.da)
      expect(chiuso.stato).toBe('chiuso')
      expect(chiuso.domande_aperte).toBe(false)
      expect((await anno(b.a)).stato).toBe('corrente')

      // Un tick ripetuto non cambia niente.
      await tick(await giorno(da.fine, 5))
      expect((await anno(b.da)).stato).toBe('chiuso')

      const scrivi = () =>
        errore(b.db, `SELECT public.anno_guardia_verifica(t, 'INSERT', NULL,
           jsonb_build_object('id', gen_random_uuid(), 'scuola_id', $1::uuid, 'anno_id', $2::uuid, t.colonna_data, $3::text), NULL, false)
           FROM public.anno_tabelle t WHERE t.tabella = 'presenze'`,
        [SEDE_E2E, b.annoDa, chiuso.fine])
      await b.db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UTENTE, role: 'authenticated' })])
      await b.db.query(`SELECT set_config('request.headers', '', true)`)
      expect(await scrivi()).toBe('ANNO_CHIUSO')

      const g = await una<string>(
        b.db,
        `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo)
         VALUES ($1, 'segreteria', $2, 'correzione', 'rettifica dopo lo scrutinio') RETURNING id`,
        [UTENTE, b.da])
      await b.db.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-kidville-correzione': g })])
      expect(await scrivi()).toBe('nessun-errore')
    })
  })
})

/**
 * (giro 1) L'ORDINE VERO DEL CALENDARIO. Le prove sopra confermano il passaggio e DOPO fanno girare il tick: è l'ordine inverso di
 * quello della vita, in cui il tick del 01/08 precede la segreteria. Qui il tick viene PRIMA, a guardia accesa, con un genitore
 * legato al bambino che continua (la rete dei genitori che l'invariante 7 guarda). Avrebbe preso R1 (la conferma rifiutata dopo il
 * tick), R6 (la segreteria ferma in agosto) e S2 (l'invariante 7 rossa dal 20/08).
 */
describe('4.9 giro 1 · tick, poi conferma, poi famiglia e segreteria', () => {
  const GENITORE = '88888888-8888-4888-8888-888888888881'
  async function con(giornoIso: string, fn: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${giornoIso}T10:00:00.000Z`))
    await inRollback(b.db, fn)
  }
  const legaGenitore = async () => {
    await b.db.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ($1, '88888888-8888-4888-8888-888888888882')`, [GENITORE])
    await b.db.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2)`, [BAMBINI.continua, GENITORE])
  }
  const presenza = (data: string, sezione: string) =>
    errore(b.db, `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, $3::date, $4)`,
      [BAMBINI.continua, SEDE_E2E, data, sezione])

  it('01/08 tick → 20/08 conferma → agosto: la segreteria scrive senza gettone e le invarianti restano quelle di prima', async () => {
    await con('2027-08-20', async () => {
      await guardia(true)
      await legaGenitore()
      const invariantiPrima = await invarianti()
      await tick('2027-08-01')
      expect((await anno(b.da)).stato).toBe('in_chiusura')
      const p = await anteprima()
      await decidi(p)
      expect((await conferma(p, '2027-08-20')).gia_confermato).toBe(false)
      await tick('2027-08-20')
      expect((await anno(b.da)).stato).toBe('in_chiusura')
      expect((await anno(b.a)).stato).toBe('corrente')
      // La segreteria rettifica una presenza di agosto del vecchio anno (in_chiusura): passa, senza motivo e senza gettone.
      expect(await presenza('2027-08-10', b.sezioni.girasoli)).toBe('nessun-errore')
      expect(await invarianti(), 'con un genitore legato nessuna invariante in più').toEqual(invariantiPrima)
    })
  })

  it('(giro 2, N1) una RETTIFICA di agosto con un vero UPDATE su un anno `in_chiusura` non accende l’invariante 6; su un anno `chiuso` la accende solo se non è esente', async () => {
    await con('2027-08-20', async () => {
      await guardia(true)
      const invariantiPrima = await invarianti()
      await tick('2027-08-01')
      expect((await anno(b.da)).stato).toBe('in_chiusura')
      const id = await una<string>(b.db,
        `INSERT INTO public.presenze (alunno_id, scuola_id, data, section_id) VALUES ($1, $2, '2027-08-10', $3) RETURNING id`,
        [BAMBINI.continua, SEDE_E2E, b.sezioni.girasoli])
      // la rettifica: un UPDATE vero, che la scatola nera (anche quella finta del banco) registra
      await b.db.query(`UPDATE public.presenze SET stato = 'rettifica' WHERE id = $1`, [id])
      const nera = await una<number>(b.db, `SELECT count(*)::int FROM scatola_nera.modifiche WHERE tabella = 'presenze' AND riga_id = $1`, [id])
      expect(nera, 'la scatola nera ha registrato la rettifica').toBeGreaterThan(0)
      expect(await invarianti(), 'in_chiusura: la segreteria scrive senza gettone, e non è un difetto').toEqual(invariantiPrima)
    })
    await con('2027-09-01', async () => {
      await guardia(true)
      const invariantiPrima = await invarianti()
      await tick('2027-09-01')
      expect((await anno(b.da)).stato).toBe('chiuso')
      const sede = SEDE_E2E
      const annoId = (await anno(b.da)).id
      const annoScolastico = await una<string>(b.db, `SELECT anno_id FROM public.anni_sede WHERE id = $1`, [annoId])
      const conta6 = async () =>
        Number(await una<number>(b.db, `SELECT coalesce(sum(righe), 0)::int FROM public.anno_invarianti() WHERE invariante = '6'`))
      expect(await conta6()).toBe(0)
      const nera = (tabella: string, cambiate: string[]) => b.db.query(
        `INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo) VALUES ($1, gen_random_uuid()::text, $2::jsonb, $3::text[], 'service_role')`,
        [tabella, JSON.stringify({ anno_id: annoScolastico, scuola_id: sede, data: '2027-05-10' }), cambiate])
      // colonne esenti (incasso di un pagamento arretrato): non è un difetto
      const esentiPagamenti = await una<string[]>(b.db, `SELECT public.anno_colonne_esenti('pagamenti')`)
      await nera('pagamenti', esentiPagamenti)
      expect(await conta6(), 'l’incasso di un arretrato (colonne esenti) non accende niente').toBe(0)
      const esentiArmadietto = await una<string[]>(b.db, `SELECT public.anno_colonne_esenti('armadietto_richieste')`).catch(() => null)
      if (esentiArmadietto && esentiArmadietto.length > 0) {
        await nera('armadietto_richieste', esentiArmadietto)
        expect(await conta6(), 'il promemoria dell’armadietto non accende niente').toBe(0)
      }
      // controllo: una colonna NON esente su un anno chiuso, senza gettone, è un difetto vero
      await nera('presenze', ['stato'])
      expect(await conta6(), 'una modifica non esente senza gettone sull’anno chiuso accende la 6').toBeGreaterThan(0)
      expect(invariantiPrima.length).toBeGreaterThanOrEqual(0)
    })
  })

  it('il giorno dopo la `fine`, senza passaggio: il vecchio è chiuso, il nuovo non è stato promosso, e il database lo dice col codice giusto', async () => {
    await con('2027-09-01', async () => {
      await guardia(true)
      await tick('2027-09-01')
      expect((await anno(b.da)).stato).toBe('chiuso')
      expect((await anno(b.a)).stato).toBe('iscrizioni_aperte')
      expect(await presenza('2027-05-10', b.sezioni.girasoli), 'l’anno chiuso chiede il gettone').toBe('ANNO_CHIUSO')
      expect(await presenza('2027-09-01', b.sezioni.girasoli), 'il nuovo anno senza passaggio: né l’anno sbagliato né la classe sbagliata').toBe('PASSAGGIO_DA_FARE')
      const s = await una<{ passaggio_iniziato: number }>(b.db, `SELECT public.salute_anno()`)
      expect(s.passaggio_iniziato, 'la sede «vera» del banco ha il suo anno nuovo cominciato e nessun passaggio').toBeGreaterThan(0)
    })
  })

  it('attraversa l’`inizio`: fino al 31/08 la scheda resta sulla classe vecchia, il 01/09 il tick e la ricopia la portano sulla nuova, e le invarianti restano a posto', async () => {
    await con('2027-08-20', async () => {
      await guardia(true)
      await legaGenitore()
      const invariantiPrima = await invarianti()
      const p = await anteprima()
      await decidi(p)
      await conferma(p, '2027-08-20')
      const sezioneScheda = () =>
        una<string>(b.db, `SELECT section_id FROM public.alunni WHERE id = $1`, [BAMBINI.continua])
      expect(await sezioneScheda(), 'prima dell’inizio la scheda è ancora sulla classe dell’anno vecchio').toBe(b.sezioni.girasoli)
      await tick('2027-08-20')
      expect(await invarianti(), 'il 20/08, con un genitore legato').toEqual(invariantiPrima)
    })
    // Il giorno dell'inizio: transazione propria con l'orologio al 01/09 (il giorno di Roma dell'istante serve alla ricopia).
    await con('2027-09-01', async () => {
      await guardia(true)
      await legaGenitore()
      const invariantiPrima = await invarianti()
      const p = await anteprima()
      await decidi(p)
      await conferma(p, '2027-08-20')
      await tick('2027-09-01')
      const r = await una<{ passaggi: number }>(b.db, `SELECT public.passaggio_ricopia_schede($1::date, $2::uuid)`, ['2027-09-01', SEDE_E2E])
      expect(r.passaggi).toBeGreaterThan(0)
      expect(await una<string>(b.db, `SELECT section_id FROM public.alunni WHERE id = $1`, [BAMBINI.continua]),
        'il giorno dell’inizio la scheda è sulla classe nuova').toBe(b.sezioni.girasoliNuova)
      expect(await invarianti(), 'dopo l’inizio e la ricopia, nessuna invariante in più').toEqual(invariantiPrima)
      const ancora = await una<{ passaggi: number }>(b.db, `SELECT public.passaggio_ricopia_schede($1::date, $2::uuid)`, ['2027-09-01', SEDE_E2E])
      expect(ancora.passaggi, 'rifatta non trova niente da fare').toBe(0)
    })
  })
})
