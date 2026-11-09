import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_GALLERIA_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * PR 4.5 · giro di correzione 4.5.15, C3 · LA FASCIA DELLE CLASSI (migrazioni M45c e M45d), in PGlite vero.
 *
 * Il difetto: nessuno scriveva `sections.fascia`, quindi le quote «per fascia» e i posti non funzionavano, in silenzio. La prova di
 * prima impostava la fascia A MANO e non poteva vederlo. Qui NESSUNA prova imposta la fascia con un UPDATE sulle classi dell'anno
 * prossimo: si parte da `anno_copia_sezioni` (e, dove serve, dalla funzione che la segreteria usa per sceglierla) e si arriva alla
 * voce con l'importo.
 *
 *  · la copia dà la fascia dell'origine, o `infanzia`/`primaria` dal grado; il nido resta vuoto;
 *  · «Apri le iscrizioni» è rifiutato se il listino ha una quota con una fascia e una classe non ce l'ha, e il rifiuto annulla anche la copia;
 *  · «Tutte le fasce a 100, Primaria a 150» dà 150 a chi sta in una primaria;
 *  · una classe senza fascia non finisce in `senza_sezione`: ha il suo conteggio `senza_fascia`.
 *
 * Banco: come `anno-conferma.test.ts`. Ogni prova gira in una transazione che finisce in ROLLBACK. Importi di prova, uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const UT = '55555555-5555-4555-8555-555555555551'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const AL3 = '11111111-1111-4111-8111-111111111113'

type Rec = Record<string, unknown>
let db: PGlite
const ANNO_SEDE: Record<string, string> = {}
const ANNO: Record<number, string> = {}

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 40_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function errore(sql: string, params: unknown[] = []): Promise<string> {
  await db.exec('SAVEPOINT prima_dell_errore')
  try {
    await db.query(sql, params)
  } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT prima_dell_errore')
    return (e as { message?: string }).message ?? 'senza-messaggio'
  }
  await db.exec('RELEASE SAVEPOINT prima_dell_errore')
  return 'nessun-errore'
}
async function giorni() {
  await db.query(
    `UPDATE public.anni_sede
        SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40)
      WHERE id = $1`, [ANNO_SEDE[`${S1}:2026`]])
}
const a27 = () => ANNO_SEDE[`${S1}:2027`]
const a26 = () => ANNO_SEDE[`${S1}:2026`]
async function nuovoAlunno(id: string) {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'iscritto')`, [id, S1])
}
/** Una classe DELL'ANNO IN CORSO, come oggi in produzione: la fascia c'è solo se la prova la dà. */
async function classeOggi(nome: string, tipo: string, fascia: string | null = null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [S1, ANNO[2026], nome, tipo, fascia])
}
async function partenza(alunno: string, sezioneId: string): Promise<string> {
  const id = await una<string>(
    `SELECT f.id FROM public.frequenze f JOIN public.anni_sede s ON s.id = f.anno_sede_id
      WHERE f.alunno_id = $1 AND s.stato = 'corrente'`, [alunno])
  await db.query(`UPDATE public.frequenze SET section_id = $1 WHERE id = $2`, [sezioneId, id])
  return id
}
const quota = (voce: string, fascia: string | null, importo: number) =>
  db.query(`SELECT public.anno_listino_quota_imposta($1, $2, $3, $4, NULL)`, [a27(), voce, fascia, importo])
async function moduli() {
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a27()])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a27()])
}
const apriSql = () => db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a27(), UT])
const fasciaDi = (nome: string) =>
  una<string | null>(`SELECT fascia FROM public.sections WHERE anno_id = $1 AND scuola_id = $2 AND name = $3`, [ANNO[2027], S1, nome])
const conferma = (frequenza: string) =>
  una<Rec>(`SELECT public.anno_conferma($1::uuid, $2::uuid, NULL::uuid, $3::uuid, false)`, [frequenza, a27(), UT])
const importoVoce = (id: string) => una<string>(`SELECT importo::text FROM public.pagamenti WHERE id = $1`, [id])

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1], fino: 'M45c',
    codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_ISCRIZIONE_ANNO + `
      ALTER TABLE public.alunni
        ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0,
        ADD COLUMN archiviato_il timestamptz,
        ADD COLUMN anonimizzato_il timestamptz;
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid;
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

describe('anno_copia_sezioni: la fascia della copia', () => {
  prova('dà infanzia e primaria dal grado, lascia vuoto il nido, tiene quella dell’origine', async () => {
    await inRollback(async () => {
      await classeOggi('Girasoli', 'infanzia')
      await classeOggi('Prima A', 'primaria')
      await classeOggi('Nido blu', 'nido')
      await classeOggi('Nido verde', 'nido', 'nido_2')
      await db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [a26(), a27()])
      expect(await fasciaDi('Girasoli')).toBe('infanzia')
      expect(await fasciaDi('Prima A')).toBe('primaria')
      expect(await fasciaDi('Nido blu')).toBeNull()
      expect(await fasciaDi('Nido verde')).toBe('nido_2')
    })
  })

  prova('le classi di OGGI non si toccano: restano senza fascia', async () => {
    await inRollback(async () => {
      await classeOggi('Girasoli', 'infanzia')
      await db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [a26(), a27()])
      expect(await una<number>(`SELECT count(*)::int FROM public.sections WHERE anno_id = $1 AND fascia IS NOT NULL`, [ANNO[2026]])).toBe(0)
    })
  })
})

describe('«Apri le iscrizioni»: ogni classe ha la fascia se il listino ne usa una', () => {
  prova('con una quota per fascia e una classe senza fascia è rifiutato, e la copia si annulla', async () => {
    await inRollback(async () => {
      await classeOggi('Girasoli', 'infanzia')
      await classeOggi('Nido blu', 'nido')
      await quota('quota_conferma', 'infanzia', 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      const e = await errore(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a27(), UT])
      expect(e).toBe('PREREQUISITI_MANCANTI')
      // il rifiuto annulla anche la copia: nessuna classe nell'anno prossimo, anno ancora in preparazione
      expect(await una<number>(`SELECT count(*)::int FROM public.sections WHERE anno_id = $1`, [ANNO[2027]])).toBe(0)
      expect(await una<string>(`SELECT stato FROM public.anni_sede WHERE id = $1`, [a27()])).toBe('in_preparazione')
    })
  })

  prova('il rifiuto dice quale prerequisito manca', async () => {
    await inRollback(async () => {
      await classeOggi('Nido blu', 'nido')
      await quota('quota_conferma', 'nido_1', 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      await db.exec('SAVEPOINT s')
      let dettaglio = ''
      try { await apriSql() } catch (e) { dettaglio = (e as { detail?: string }).detail ?? '' }
      await db.exec('ROLLBACK TO SAVEPOINT s')
      expect(JSON.parse(dettaglio).mancano).toEqual(['classi_senza_fascia'])
    })
  })

  prova('scelta la fascia dalla funzione della segreteria, si apre', async () => {
    await inRollback(async () => {
      await classeOggi('Nido blu', 'nido')
      await quota('quota_conferma', 'nido_1', 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      await db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [a26(), a27()])
      const sez = await una<string>(`SELECT id FROM public.sections WHERE anno_id = $1 AND name = 'Nido blu'`, [ANNO[2027]])
      const r = await una<Rec>(`SELECT public.anno_sezione_fascia_imposta($1, $2, 'nido_1')`, [a27(), sez])
      expect(r.cambiato).toBe(true)
      await apriSql()
      expect(await una<string>(`SELECT stato FROM public.anni_sede WHERE id = $1`, [a27()])).toBe('iscrizioni_aperte')
    })
  })

  prova('un listino senza fasce non chiede niente (il nido può restare vuoto)', async () => {
    await inRollback(async () => {
      await classeOggi('Nido blu', 'nido')
      await quota('quota_conferma', null, 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      await apriSql()
      expect(await una<string>(`SELECT stato FROM public.anni_sede WHERE id = $1`, [a27()])).toBe('iscrizioni_aperte')
    })
  })
})

describe('anno_sezione_fascia_imposta', () => {
  prova('una classe di un altro anno è SEZIONE_DI_ALTRO_ANNO, una fascia fuori elenco è PARAMETRO_MANCANTE', async () => {
    await inRollback(async () => {
      const oggi = await classeOggi('Girasoli', 'infanzia')
      expect(await errore(`SELECT public.anno_sezione_fascia_imposta($1, $2, 'infanzia')`, [a27(), oggi])).toBe('SEZIONE_DI_ALTRO_ANNO')
      await db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [a26(), a27()])
      const sez = await una<string>(`SELECT id FROM public.sections WHERE anno_id = $1`, [ANNO[2027]])
      expect(await errore(`SELECT public.anno_sezione_fascia_imposta($1, $2, 'sala')`, [a27(), sez])).toBe('PARAMETRO_MANCANTE')
    })
  })

  prova('si può togliere (NULL) e rifare è innocuo', async () => {
    await inRollback(async () => {
      await classeOggi('Girasoli', 'infanzia')
      await db.query(`SELECT public.anno_copia_sezioni($1, $2)`, [a26(), a27()])
      const sez = await una<string>(`SELECT id FROM public.sections WHERE anno_id = $1`, [ANNO[2027]])
      expect((await una<Rec>(`SELECT public.anno_sezione_fascia_imposta($1, $2, NULL)`, [a27(), sez])).cambiato).toBe(true)
      expect((await una<Rec>(`SELECT public.anno_sezione_fascia_imposta($1, $2, NULL)`, [a27(), sez])).cambiato).toBe(false)
      expect(await fasciaDi('Girasoli')).toBeNull()
    })
  })

  prova('su un anno chiuso o corrente non scrive (ANNO_NON_MODIFICABILE)', async () => {
    await inRollback(async () => {
      const oggi = await classeOggi('Girasoli', 'infanzia')
      expect(await errore(`SELECT public.anno_sezione_fascia_imposta($1, $2, 'infanzia')`, [a26(), oggi])).toBe('ANNO_NON_MODIFICABILE')
    })
  })
})

describe('dalla copia alla voce, senza impostare la fascia a mano', () => {
  prova('«Tutte le fasce a 100, Primaria a 150»: chi sta in una primaria paga 150, chi sta all’infanzia 100', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      const prima = await classeOggi('Prima A', 'primaria')
      const girasoli = await classeOggi('Girasoli', 'infanzia')
      const fPrima = await partenza(AL, prima)
      const fGira = await partenza(AL2, girasoli)
      await quota('quota_conferma', null, 100)
      await quota('quota_conferma', 'primaria', 150)
      await quota('quota_nuova', null, 200)
      await moduli()
      await apriSql() // copia le classi (con la fascia) e apre
      const r1 = await conferma(fPrima)
      const r2 = await conferma(fGira)
      expect(r1.quota).toBe('creata')
      expect(await importoVoce(r1.pagamento_id as string)).toBe('150.00')
      expect(await importoVoce(r2.pagamento_id as string)).toBe('100.00')
    })
  })

  prova('con le quote solo per fascia e le classi copiate: la voce nasce (prima era «senza_listino»)', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      const girasoli = await classeOggi('Girasoli', 'infanzia')
      const f = await partenza(AL, girasoli)
      await quota('quota_conferma', 'infanzia', 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      await apriSql()
      const r = await conferma(f)
      expect(r.quota).toBe('creata')
      expect(await importoVoce(r.pagamento_id as string)).toBe('100.00')
    })
  })
})

describe('anno_conta_posti: una classe senza fascia non è «senza sezione»', () => {
  prova('il nido senza fascia ha il suo conteggio `senza_fascia`', async () => {
    await inRollback(async () => {
      await giorni()
      await nuovoAlunno(AL)
      await nuovoAlunno(AL2)
      await nuovoAlunno(AL3)
      const nido = await classeOggi('Nido blu', 'nido')
      const gira = await classeOggi('Girasoli', 'infanzia')
      const fNido = await partenza(AL, nido)
      const fGira = await partenza(AL2, gira)
      const fSenza = await partenza(AL3, gira)
      await quota('quota_conferma', null, 100)
      await quota('quota_nuova', null, 200)
      await moduli()
      await apriSql()
      await db.query(`SELECT public.anno_posti_imposta($1, 'infanzia', 1, NULL)`, [a27()])
      await conferma(fNido)
      await conferma(fGira)
      // un terzo bambino, la cui classe di arrivo viene tolta: questa sì è «senza_sezione»
      const r3 = await conferma(fSenza)
      await db.query(`UPDATE public.frequenze SET section_id = NULL WHERE id = $1`, [r3.frequenza_id])
      const righe = await db.query<{ fascia: string; iscritti: string; oltre: boolean }>(
        `SELECT fascia, iscritti::text, oltre FROM public.anno_conta_posti($1) ORDER BY fascia`, [a27()])
      const per = Object.fromEntries(righe.rows.map((x) => [x.fascia, x]))
      expect(per.senza_fascia?.iscritti).toBe('1')
      expect(per.senza_sezione?.iscritti).toBe('1')
      expect(per.infanzia?.iscritti).toBe('1')
      expect(per.infanzia?.oltre).toBe(false)
    })
  })
})
