import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SEDE_E2E, SEDE_SIM, SEDE_VERA, UTENTE, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'
import { creaBancoAzzera } from '../helpers/banco-azzera'

/**
 * LE FUNZIONI `demo_*` (14/11/2026): il ripristino della Demo come funzioni del database, provate su PGlite (mai su Demo né su produzione).
 *
 * Il banco è quello dell'azzeramento. Prima della «partenza» (committata) la Demo ha due anni, listino, moduli, posti, una sezione, una
 * domanda, una voce e tre bambini; tutto ciò che la prova scrive porta lo stesso `now()` della transazione e `>=` lo conta come dopo.
 * Le altre sedi (`SEDE_E2E`, anch'essa con prefisso e2e00000, `SEDE_SIM`, `SEDE_VERA`) hanno la loro popolazione e non devono cambiare di una riga.
 */

const DEMO = 'e2e00000-0000-4000-8000-00000000d000'
const MIGRAZIONE = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261114124928_demo_funzioni_ripristino.sql'), 'utf8')

const id = (n: number) => `44444444-4444-4444-8444-4444444444${String(n).padStart(2, '0')}`
const AL = { a: id(1), b: id(2), c: id(3), d: id(4), e: id(5) }

let b: BancoPassaggio
let annoVecchio: string
let annoNuovo: string
let annoNuovoId: string
let annoVecchioId: string
let sezioneVecchia: string

beforeAll(async () => {
  b = await creaBancoAzzera()
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  // In produzione il trigger `incassi_ricalcola` riporta la voce a «da pagare» quando l'incasso va via: il banco lo imita.
  // (e in produzione `incassi.creato_il` esiste: il banco condiviso non ce l'ha)
  await b.db.exec(`ALTER TABLE public.incassi ADD COLUMN IF NOT EXISTS creato_il timestamptz NOT NULL DEFAULT now()`)
  await b.db.exec(`
    CREATE FUNCTION public.trg_incassi_ricalcola_banco() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE public.pagamenti SET importo_pagato = coalesce((SELECT sum(importo) FROM public.incassi WHERE pagamento_id = coalesce(NEW.pagamento_id, OLD.pagamento_id)), 0),
             stato = CASE WHEN EXISTS (SELECT 1 FROM public.incassi WHERE pagamento_id = coalesce(NEW.pagamento_id, OLD.pagamento_id)) THEN stato ELSE 'da_pagare' END
       WHERE id = coalesce(NEW.pagamento_id, OLD.pagamento_id);
      RETURN NULL;
    END $$;
    CREATE TRIGGER incassi_ricalcola AFTER INSERT OR DELETE OR UPDATE ON public.incassi FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola_banco();
  `)
  // In produzione `pagamenti.fattura_stato` è un enum NOT NULL con predefinito 'non_richiesta': il banco condiviso lo ha nullabile, e con quello
  // una condizione «fattura_stato IS NOT NULL» sembrerebbe giusta (revisione del 14/11, rilievo 1). Qui il banco è fedele alla produzione.
  // (Stesso allineamento di `banco-azzera.ts` nel ramo integrato: idempotente, così regge con e senza.)
  await b.db.exec(`
    UPDATE public.pagamenti SET fattura_stato = 'non_richiesta' WHERE fattura_stato IS NULL;
    ALTER TABLE public.pagamenti ALTER COLUMN fattura_stato SET DEFAULT 'non_richiesta', ALTER COLUMN fattura_stato SET NOT NULL;
    -- ciò che un periodo di scrutinio si porta dietro a cascata (baseline.sql:5920 e :5992)
    CREATE TABLE IF NOT EXISTS public.scrutini (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), periodo_id uuid NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS public.scrutinio_giudizio_descrittivo (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), periodo_id uuid NOT NULL REFERENCES public.scrutinio_periodi(id) ON DELETE CASCADE);
  `)
  await b.db.exec(MIGRAZIONE)

  await q(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Demo di prova')`, [DEMO])
  await q(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [DEMO])
  const anno = async (inizio: number) =>
    (await q(`SELECT s.id, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = $2`, [DEMO, inizio])).rows[0] as { id: string; anno_id: string }
  const v = await anno(2026)
  const n = await anno(2027)
  annoVecchio = v.id; annoVecchioId = v.anno_id; annoNuovo = n.id; annoNuovoId = n.anno_id

  sezioneVecchia = await una<string>(b.db,
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Girasoli', 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoVecchioId])
  for (const a of Object.values(AL)) await q(`INSERT INTO public.alunni (id, scuola_id, stato, section_id) VALUES ($1, $2, 'iscritto', $3)`, [a, DEMO, sezioneVecchia])
  await q(`UPDATE public.frequenze SET non_rinnova_il = now(), non_rinnova_motivo = 'trasloco' WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL.e, annoVecchio])

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
  // un periodo di scrutinio che c'era PRIMA della partenza: deve restare
  await q(`INSERT INTO public.scrutinio_periodi (scuola_id, anno_scolastico) VALUES ($1, '2026/27')`, [DEMO])
}, 240_000)
afterAll(async () => {
  await b?.db.close()
})

const conta = (sql: string, p: unknown[] = []) => una<number>(b.db, `SELECT count(*)::int FROM (${sql}) x`, p)
const impronta = (sql: string, p: unknown[] = []) =>
  una<string>(b.db, `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM (${sql}) t`, p)
const adesso = () => una<string>(b.db, `SELECT now()::text`)

/** Le altre sedi per intero: non devono cambiare di una riga. */
async function altreSedi() {
  const altre = (t: string, col = 'scuola_id') => impronta(`SELECT * FROM public.${t} WHERE ${col} <> $1`, [DEMO])
  return {
    frequenze: await altre('frequenze'), pagamenti: await altre('pagamenti'), sezioni: await altre('sections'), alunni: await altre('alunni'),
    domande: await altre('enrollment_submissions'), scrutinio: await altre('scrutinio_periodi'),
    anni: await impronta(`SELECT * FROM public.anni_sede WHERE scuola_id <> $1`, [DEMO]),
    listino: await impronta(`SELECT l.* FROM public.listino_voci l JOIN public.anni_sede a ON a.id = l.anno_sede_id WHERE a.scuola_id <> $1`, [DEMO]),
    incassi: await impronta(`SELECT i.* FROM public.incassi i JOIN public.pagamenti p ON p.id = i.pagamento_id WHERE p.scuola_id <> $1`, [DEMO]),
  }
}
/** Tutta la Demo: per vedere che una prova a secco, o una ripetizione, non cambia niente. */
async function demoIntera() {
  const d = (t: string, col = 'scuola_id') => impronta(`SELECT * FROM public.${t} WHERE ${col} = $1`, [DEMO])
  return {
    frequenze: await d('frequenze'), pagamenti: await d('pagamenti'), sezioni: await d('sections'), alunni: await d('alunni'),
    domande: await d('enrollment_submissions'), scrutinio: await d('scrutinio_periodi'), anni: await d('anni_sede'),
    passaggi: await d('passaggi_anno'),
    incassi: await impronta(`SELECT i.* FROM public.incassi i JOIN public.pagamenti p ON p.id = i.pagamento_id WHERE p.scuola_id = $1`, [DEMO]),
    stati: await impronta(`SELECT * FROM public.anni_sede_stati WHERE anno_sede_id IN (SELECT id FROM public.anni_sede WHERE scuola_id = $1)`, [DEMO]),
    listino: await impronta(`SELECT l.* FROM public.listino_voci l JOIN public.anni_sede a ON a.id = l.anno_sede_id WHERE a.scuola_id = $1`, [DEMO]),
  }
}

const frequenzaVecchia = (alunno: string) =>
  una<string>(b.db, `SELECT id FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, annoVecchio])

/** Il giro dell'agente 2 nella Demo, con le funzioni vere del database. */
async function giro(): Promise<void> {
  const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
  await q(`SELECT public.anno_apri_iscrizioni($1, $2)`, [annoNuovo, UTENTE])
  await q(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 150, NULL)`, [annoNuovo])
  await q(`SELECT public.anno_modulo_richiesto_togli($1, 'conferma', 'foto')`, [annoNuovo])
  await q(`SELECT public.anno_posti_imposta($1, 'primavera', 4, 'nuova')`, [annoNuovo])
  // quattro conferme e un «non rinnova»
  for (const al of [AL.a, AL.b, AL.c, AL.d]) {
    await q(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL, $3::uuid, false)`, [await frequenzaVecchia(al), annoNuovo, UTENTE])
  }
  await q(`SELECT public.anno_non_rinnova($1::uuid, true, 'altro', $2::uuid)`, [await frequenzaVecchia(AL.e), UTENTE])
  // una quota incassata, con il suo incasso
  const incassata = await una<string>(b.db,
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id, stato, importo_pagato) VALUES ($1, $2, 'quota incassata', 300, DATE '2027-12-05', $3, 'pagato', 300) RETURNING id`,
    [AL.a, DEMO, annoNuovoId])
  await q(`INSERT INTO public.incassi (pagamento_id, importo) VALUES ($1, 300)`, [incassata])
  // l'anteprima del passaggio
  const oggi = await una<string>(b.db, `SELECT (ultimo_giorno_aperto + 1)::text FROM public.anni_sede WHERE id = $1`, [annoVecchio])
  await q(`SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid, $4::date)`, [annoVecchio, annoNuovo, UTENTE, oggi])
  // due periodi di scrutinio nati nel giro (uno dell'anno chiuso)
  await q(`INSERT INTO public.scrutinio_periodi (scuola_id, anno_scolastico) VALUES ($1, '2026/27'), ($1, '2025/26')`, [DEMO])
  const periodo = await una<string>(b.db, `SELECT id FROM public.scrutinio_periodi WHERE scuola_id = $1 AND anno_scolastico = '2026/27' ORDER BY creato_il DESC, id LIMIT 1`, [DEMO])
  await q(`INSERT INTO public.scrutini (periodo_id) VALUES ($1), ($1)`, [periodo])
  await q(`INSERT INTO public.scrutinio_giudizio_descrittivo (periodo_id) VALUES ($1)`, [periodo])
  // il tempo passa: il tick prepara il 2028/29, che nasce con le sue sezioni
  await q(`SELECT public.anni_tick('2027-09-02'::date, $1::uuid)`, [DEMO])
  const nato = await una<string | null>(b.db,
    `SELECT s.anno_id FROM public.anni_sede s WHERE s.scuola_id = $1 AND s.id <> $2 AND s.inizio > (SELECT inizio FROM public.anni_sede WHERE id = $2) LIMIT 1`, [DEMO, annoNuovo])
  expect(nato, 'il tick ha fatto nascere l’anno dopo').not.toBeNull()
  await q(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Futuri', 'infanzia', 'infanzia')`, [DEMO, nato])
}

const SENZA_NOME = /nome|cognome|codice_fiscale/i

describe('demo_* · la guardia: solo le sedi di prova', () => {
  it('una sede vera è rifiutata da tutte e tre le funzioni, prima di toccare qualsiasi riga', async () => {
    await inRollback(b.db, async () => {
      const prima = await altreSedi()
      const dopoDemo = await demoIntera()
      for (const sede of [SEDE_VERA, SEDE_SIM, '55555555-5555-4555-8555-555555555599']) {
        for (const sql of [
          `SELECT public.demo_fotografa('${sede}'::uuid)`,
          `SELECT public.demo_ripristina('${sede}'::uuid, now(), false)`,
          `SELECT public.demo_ripristina('${sede}'::uuid, now(), true)`,
          `SELECT * FROM public.demo_controllo('${sede}'::uuid)`,
        ]) {
          await b.db.exec('SAVEPOINT g')
          await expect(b.db.query(sql), `${sql} su ${sede}`).rejects.toThrow(/DEMO_SEDE_NON_DI_PROVA/)
          await b.db.exec('ROLLBACK TO SAVEPOINT g')
          await b.db.exec('RELEASE SAVEPOINT g')
        }
      }
      expect(await conta(`SELECT 1 FROM public.demo_fotografie WHERE scuola_id <> $1`, [DEMO]), 'nessuna fotografia di una sede vera').toBe(0)
      expect(await altreSedi()).toEqual(prima)
      expect(await demoIntera()).toEqual(dopoDemo)
    })
  })

  it('la sede nulla è rifiutata, e la tabella delle fotografie non accetta una sede vera nemmeno a mano', async () => {
    await inRollback(b.db, async () => {
      await b.db.exec('SAVEPOINT n')
      await expect(b.db.query(`SELECT public.demo_ripristina(NULL, now(), false)`)).rejects.toThrow(/DEMO_SEDE_NON_DI_PROVA/)
      await b.db.exec('ROLLBACK TO SAVEPOINT n')
      await b.db.exec('RELEASE SAVEPOINT n')
      await b.db.exec('SAVEPOINT t')
      await expect(b.db.query(`INSERT INTO public.demo_fotografie (scuola_id, scattata_il, fotografia) VALUES ($1, now(), '{}'::jsonb)`, [SEDE_VERA])).rejects.toThrow(/demo_fotografie_sede_di_prova/)
      await b.db.exec('ROLLBACK TO SAVEPOINT t')
      await b.db.exec('RELEASE SAVEPOINT t')
    })
  })

  it('senza una fotografia la Demo non si ripristina (DEMO_FOTOGRAFIA_MANCANTE)', async () => {
    await inRollback(b.db, async () => {
      await b.db.exec('SAVEPOINT m')
      await expect(b.db.query(`SELECT public.demo_ripristina($1::uuid, now(), false)`, [DEMO])).rejects.toThrow(/DEMO_FOTOGRAFIA_MANCANTE/)
      await b.db.exec('ROLLBACK TO SAVEPOINT m')
      await b.db.exec('RELEASE SAVEPOINT m')
    })
  })
})

describe('demo_* · un giro dell’agente 2 e il ripristino', () => {
  it('fotografia → giro → prova a secco (niente scritto) → ripristino vero → controllo tutto ok → ripetizione senza effetti', async () => {
    await inRollback(b.db, async () => {
      const altrePrima = await altreSedi()
      const partenza = await adesso()
      const prima = {
        frequenze: await conta(`SELECT 1 FROM public.frequenze WHERE scuola_id = $1`, [DEMO]),
        sezioni: await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1`, [DEMO]),
        pagamenti: await conta(`SELECT 1 FROM public.pagamenti WHERE scuola_id = $1`, [DEMO]),
        domande: await conta(`SELECT 1 FROM public.enrollment_submissions WHERE scuola_id = $1`, [DEMO]),
        anni: await conta(`SELECT 1 FROM public.anni_sede WHERE scuola_id = $1`, [DEMO]),
        scrutinio: await conta(`SELECT 1 FROM public.scrutinio_periodi WHERE scuola_id = $1`, [DEMO]),
      }
      const foto = JSON.parse(await una<string>(b.db, `SELECT public.demo_fotografa($1::uuid)::text`, [DEMO]))
      expect(foto).toMatchObject({ versione: 2, etichetta: '2027/28', stato: 'in_preparazione', domande_aperte: false })
      expect(JSON.stringify(foto)).not.toMatch(SENZA_NOME)
      expect(await conta(`SELECT 1 FROM public.demo_fotografie WHERE scuola_id = $1`, [DEMO])).toBe(1)

      await giro()
      expect(await conta(`SELECT 1 FROM public.frequenze WHERE anno_sede_id = $1`, [annoNuovo]), 'il giro ha scritto').toBeGreaterThan(0)
      const controlloPrima = (await b.db.query<{ ok: boolean }>(`SELECT * FROM public.demo_controllo($1::uuid)`, [DEMO])).rows
      expect(controlloPrima.filter((r) => !r.ok).length, 'dopo il giro il controllo è rosso').toBeGreaterThanOrEqual(8)

      // la prova a secco: un'eccezione col riassunto, e non resta scritto niente
      const dopoGiro = await demoIntera()
      await b.db.exec('SAVEPOINT secco')
      const msg = await b.db.query(`SELECT public.demo_ripristina($1::uuid, $2::timestamptz)`, [DEMO, partenza]).then(() => 'nessun errore', (e: Error) => e.message)
      await b.db.exec('ROLLBACK TO SAVEPOINT secco')
      await b.db.exec('RELEASE SAVEPOINT secco')
      expect(msg).toMatch(/DEMO_PROVA_A_SECCO/)
      expect(msg).not.toMatch(SENZA_NOME)
      expect(await demoIntera(), 'la prova a secco non lascia scritto niente').toEqual(dopoGiro)

      // il ripristino vero
      const esito = JSON.parse(await una<string>(b.db, `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)::text`, [DEMO, partenza]))
      expect(esito.a_secco).toBe(false)
      expect(esito.righe_non_coperte).toEqual({ incassi: 1, sezioni_di_anni_nati_dopo: 1, scrutinio_periodi: 2 })
      expect(esito.ripristino.passaggi).toBe(1)
      // la cascata dei periodi (scrutini e giudizi) è nell'esito, non solo nel documento
      expect(esito.cascata_dei_periodi_di_scrutinio).toEqual({ scrutini: 2, scrutinio_giudizio_descrittivo: 1 })
      expect(await conta(`SELECT 1 FROM public.scrutini`), 'gli scrutini a cascata sono andati').toBe(0)
      // la riga di log del successo è stata scritta davvero (la scrittura sta in un EXCEPTION che altrimenti la inghiottirebbe)
      expect(await conta(`SELECT 1 FROM public.app_log WHERE fingerprint = $1`, ['demo-ripristina:' + DEMO]), 'riga di log del ripristino').toBe(1)
      expect(JSON.stringify(esito)).not.toMatch(SENZA_NOME)

      // i conteggi della partenza
      expect({
        frequenze: await conta(`SELECT 1 FROM public.frequenze WHERE scuola_id = $1`, [DEMO]),
        sezioni: await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1`, [DEMO]),
        pagamenti: await conta(`SELECT 1 FROM public.pagamenti WHERE scuola_id = $1`, [DEMO]),
        domande: await conta(`SELECT 1 FROM public.enrollment_submissions WHERE scuola_id = $1`, [DEMO]),
        anni: await conta(`SELECT 1 FROM public.anni_sede WHERE scuola_id = $1`, [DEMO]),
        scrutinio: await conta(`SELECT 1 FROM public.scrutinio_periodi WHERE scuola_id = $1`, [DEMO]),
      }).toEqual(prima)
      expect(await conta(`SELECT 1 FROM public.incassi i JOIN public.pagamenti p ON p.id = i.pagamento_id WHERE p.scuola_id = $1`, [DEMO])).toBe(0)

      const controllo = (await b.db.query<{ controllo: string; ok: boolean; dettaglio: string }>(`SELECT * FROM public.demo_controllo($1::uuid)`, [DEMO])).rows
      expect(controllo.length).toBeGreaterThanOrEqual(16)
      expect(controllo.filter((r) => !r.ok), 'ogni controllo ok').toEqual([])

      // le altre sedi non sono cambiate di una riga
      expect(await altreSedi()).toEqual(altrePrima)

      // ripetere non fa niente e non dà errore
      const dopo = await demoIntera()
      const ancora = JSON.parse(await una<string>(b.db, `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)::text`, [DEMO, partenza]))
      expect(ancora.righe_non_coperte).toEqual({ incassi: 0, sezioni_di_anni_nati_dopo: 0, scrutinio_periodi: 0 })
      expect(ancora.ripristino).toMatchObject({ gettoni: 0, passaggi: 0 })
      expect(await demoIntera(), 'la ripetizione non cambia niente').toEqual(dopo)
      expect((await b.db.query<{ ok: boolean }>(`SELECT * FROM public.demo_controllo($1::uuid)`, [DEMO])).rows.filter((r) => !r.ok)).toEqual([])
      expect(await altreSedi()).toEqual(altrePrima)
    })
  }, 240_000)

  it('un incasso su una voce che c’era già alla partenza non si tocca: si conta e si dice', async () => {
    await inRollback(b.db, async () => {
      const partenza = await adesso()
      await b.db.query(`SELECT public.demo_fotografa($1::uuid)`, [DEMO])
      const voce = await una<string>(b.db, `SELECT id FROM public.pagamenti WHERE scuola_id = $1 LIMIT 1`, [DEMO])
      await b.db.query(`INSERT INTO public.incassi (pagamento_id, importo) VALUES ($1, 10)`, [voce])
      const esito = JSON.parse(await una<string>(b.db, `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)::text`, [DEMO, partenza]))
      expect(esito.righe_non_coperte.incassi).toBe(0)
      expect(esito.incassi_su_voci_precedenti_non_toccati).toBe(1)
      expect(await conta(`SELECT 1 FROM public.incassi WHERE pagamento_id = $1`, [voce]), 'l’incasso c’è ancora').toBe(1)
    })
  })
})

describe('demo_* · le altre sedi, con righe nate DOPO la partenza', () => {
  it('righe nate dopo la partenza in ogni altra sede restano, e un alunno condiviso con una sede vera resta fra le lasciate', async () => {
    await inRollback(b.db, async () => {
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      const partenza = await adesso()
      await q(`SELECT public.demo_fotografa($1::uuid)`, [DEMO])
      await giro()

      // In OGNI altra sede, righe di ogni tipo cancellato, tutte nate adesso (>= partenza): senza il filtro per sede la Demo le porterebbe via.
      const sedi = [SEDE_E2E, SEDE_SIM, SEDE_VERA]
      // anche gli anni delle altre sedi nascono adesso (dopo la partenza) e condividono gli anni globali con la Demo: non si toccano
      for (const sede of sedi) await q(`SELECT public.anni_sede_crea_per_sede($1::uuid, DATE '2027-09-02')`, [sede])
      // l'anno globale NATO dopo la partenza (il tick della Demo): le sezioni delle altre sedi che lo usano non si toccano
      const nato = await una<string>(b.db,
        `SELECT s.anno_id FROM public.anni_sede s WHERE s.scuola_id = $1 AND s.inizio > (SELECT inizio FROM public.anni_sede WHERE id = $2) LIMIT 1`, [DEMO, annoNuovo])
      for (const sede of sedi) {
        await q(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Altrove nel futuro', 'infanzia', 'infanzia')`, [sede, nato])
      }
      for (const sede of sedi) {
        const al = await una<string>(b.db, `INSERT INTO public.alunni (scuola_id, stato) VALUES ($1, 'iscritto') RETURNING id`, [sede])
        await q(`INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Altrove', 'infanzia', 'infanzia')`, [sede, annoNuovoId])
        const voce = await una<string>(b.db,
          `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id, stato, importo_pagato) VALUES ($1, $2, 'altrove', 5, DATE '2027-12-05', $3, 'pagato', 5) RETURNING id`,
          [al, sede, annoNuovoId])
        await q(`INSERT INTO public.incassi (pagamento_id, importo) VALUES ($1, 5)`, [voce])
        await q(`INSERT INTO public.enrollment_submissions (scuola_id, anno_id, data, status) VALUES ($1, $2, '{}'::jsonb, 'pending')`, [sede, annoNuovoId])
        const per = await una<string>(b.db, `INSERT INTO public.scrutinio_periodi (scuola_id, anno_scolastico) VALUES ($1, '2026/27') RETURNING id`, [sede])
        await q(`INSERT INTO public.scrutini (periodo_id) VALUES ($1)`, [per])
      }
      // un alunno nato nella Demo dopo la partenza, ma con una voce di una sede vera: è condiviso, quindi NON si cancella
      const condiviso = await una<string>(b.db, `INSERT INTO public.alunni (scuola_id, stato) VALUES ($1, 'iscritto') RETURNING id`, [DEMO])
      await q(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, anno_id) VALUES ($1, $2, 'voce di una sede vera', 7, DATE '2027-12-05', $3)`,
        [condiviso, SEDE_VERA, annoNuovoId])

      const altre = await altreSedi()
      for (const sede of sedi) {
        expect(await conta(`SELECT 1 FROM public.sections WHERE scuola_id = $1 AND name = 'Altrove'`, [sede]), 'riga nata dopo, nella sede ' + sede.slice(0, 8)).toBe(1)
      }
      const esito = JSON.parse(await una<string>(b.db, `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)::text`, [DEMO, partenza]))
      expect(await altreSedi(), 'le altre sedi, comprese le righe nate dopo la partenza, restano identiche').toEqual(altre)
      expect(await conta(`SELECT 1 FROM public.sections WHERE name = 'Altrove'`)).toBe(3)
      expect(await conta(`SELECT 1 FROM public.sections WHERE name = 'Altrove nel futuro'`)).toBe(3)
      expect(await conta(`SELECT 1 FROM public.anni_scolastici WHERE id = $1`, [nato]), 'l’anno globale condiviso con altre sedi resta').toBe(1)
      expect(await conta(`SELECT 1 FROM public.scrutini s JOIN public.scrutinio_periodi p ON p.id = s.periodo_id WHERE p.scuola_id <> $1`, [DEMO]), 'scrutini a cascata delle altre sedi').toBe(3)
      expect(await conta(`SELECT 1 FROM public.alunni WHERE id = $1`, [condiviso]), 'l’alunno condiviso c’è ancora').toBe(1)
      expect(esito.lasciate).toContainEqual({ tabella: 'alunni', id: condiviso })
    })
  }, 240_000)
})

describe('demo_* · gli aiuti, la fotografia passata a mano', () => {
  it('le chiavi esterne composte bloccano: una tabella che punta a (id, scuola_id) tiene ferma la riga', async () => {
    await inRollback(b.db, async () => {
      const q = (sql: string, p: unknown[] = []) => b.db.query(sql, p)
      await q(`ALTER TABLE public.sections ADD CONSTRAINT zz_sections_id_scuola UNIQUE (id, scuola_id)`)
      await q(`CREATE TABLE public.zz_figlia_composta (scuola_id uuid NOT NULL, section_id uuid NOT NULL, FOREIGN KEY (section_id, scuola_id) REFERENCES public.sections (id, scuola_id))`)
      const tenuta = await una<string>(b.db, `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Tenuta', 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoNuovoId])
      const libera = await una<string>(b.db, `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, 'Libera', 'infanzia', 'infanzia') RETURNING id`, [DEMO, annoNuovoId])
      await q(`INSERT INTO public.zz_figlia_composta (scuola_id, section_id) VALUES ($1, $2)`, [DEMO, tenuta])
      await q(`CREATE TEMP TABLE pg_temp._azzera_cand (tabella text NOT NULL, id uuid NOT NULL, bloccata boolean NOT NULL DEFAULT false, PRIMARY KEY (tabella, id))`)
      await q(`INSERT INTO pg_temp._azzera_cand (tabella, id) VALUES ('sections', $1), ('sections', $2)`, [tenuta, libera])
      await q(`SELECT public.demo_i_blocca('sections', ARRAY[]::text[])`)
      const r = (await q(`SELECT id, bloccata FROM pg_temp._azzera_cand ORDER BY id`)).rows as { id: string; bloccata: boolean }[]
      expect(r.find((x) => x.id === tenuta)?.bloccata, 'la riga tenuta da una chiave composta è bloccata').toBe(true)
      expect(r.find((x) => x.id === libera)?.bloccata, 'quella libera no').toBe(false)
    })
  })

  it('la fotografia passata come JSON (senza quella salvata) ripristina e il controllo torna tutto ok', async () => {
    await inRollback(b.db, async () => {
      const foto = JSON.parse(await una<string>(b.db, `SELECT public.demo_fotografa($1::uuid)::text`, [DEMO]))
      const partenza = foto.scattata_il as string
      await b.db.query(`DELETE FROM public.demo_fotografie WHERE scuola_id = $1`, [DEMO])
      await b.db.exec('SAVEPOINT m')
      await expect(b.db.query(`SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false)`, [DEMO, partenza])).rejects.toThrow(/DEMO_FOTOGRAFIA_MANCANTE/)
      await b.db.exec('ROLLBACK TO SAVEPOINT m')
      await b.db.exec('RELEASE SAVEPOINT m')
      await giro()
      const esito = JSON.parse(await una<string>(b.db,
        `SELECT public.demo_ripristina($1::uuid, $2::timestamptz, false, $3::jsonb)::text`, [DEMO, partenza, JSON.stringify(foto)]))
      expect(esito.a_secco).toBe(false)
      const controllo = (await b.db.query<{ ok: boolean }>(`SELECT * FROM public.demo_controllo($1::uuid, $2::timestamptz, $3::jsonb)`, [DEMO, partenza, JSON.stringify(foto)])).rows
      expect(controllo.length).toBeGreaterThanOrEqual(16)
      expect(controllo.filter((r) => !r.ok)).toEqual([])
    })
  }, 240_000)
})
