import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import {
  creaDbAnno,
  creaDbAnnoPr2,
  SCHEMA_AVVISI_CHAT_VOCI_GENITORE,
  SCHEMA_GALLERIA_GENITORE,
  SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.5 · LE TABELLE DEL PASSAGGIO E `anno_invarianti()`.
 *
 * Le invarianti 1-6 e 9-11 della specifica (§4.17). La 7 e la 8 arrivano con le PR 4.3 e 4.4.
 * Ogni invariante ha la sua PROVA DEL ROSSO: un seme rotto apposta la fa salire sopra zero, e il
 * test controlla che sia QUELLA (e quella tabella) a salire, e nient'altro. Ogni prova gira in una
 * transazione che si annulla: il seme pulito resta pulito.
 * Solo uuid finti: nessuna sede vera, nessun dato di famiglie.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const U1 = '77777777-7777-4777-8777-777777777771'
const U2 = '77777777-7777-4777-8777-777777777772'
const GENITORE = '55555555-5555-4555-8555-555555555551'

/** Le tabelle del registro che il banco di prova ha (le altre il registro le salta: `to_regclass`). */
const REGISTRO_PROVA = [
  'avvisi', 'chat_messages', 'enrollment_submissions', 'frequenze', 'frequenze_moduli',
  'pagamenti', 'presenze', 'sections', 'utenti_sezioni', 'valutazioni',
]
const CON_DATA = ['avvisi', 'chat_messages', 'presenze', 'valutazioni']
const CON_SEZIONE = ['frequenze', 'presenze', 'utenti_sezioni', 'valutazioni']

type Anno = { id: string; anno_id: string; inizio: string; fine: string; anno_inizio: number }
type Riga = { invariante: string; tabella: string; righe: number }

let db: PGlite
let A: Anno       // l'anno attivo di SEDE
let P: Anno       // quello prima
let AB: Anno      // l'anno attivo di SEDE_B
let SEZ: string
let SEZ2: string
let SEZ_PREV: string
let ALUNNO1: string
let ALUNNO2: string
let ALUNNO3: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function anno(where: string, params: unknown[]): Promise<Anno> {
  const r = await db.query<Anno>(
    `SELECT s.id, s.anno_id, s.inizio::text, s.fine::text, y.anno_inizio
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE ${where}`, params)
  return r.rows[0]
}
async function invarianti(): Promise<Riga[]> {
  const r = await db.query<{ invariante: string; tabella: string; righe: string }>(
    `SELECT invariante, tabella, righe::text FROM public.anno_invarianti() ORDER BY invariante, tabella`)
  return r.rows.map((x) => ({ ...x, righe: Number(x.righe) }))
}
/** Le sole righe sopra zero, come «invariante:tabella=n»: la prova del rosso confronta QUESTO. */
async function sopra(): Promise<string[]> {
  return (await invarianti()).filter((x) => x.righe > 0).map((x) => `${x.invariante}:${x.tabella}=${x.righe}`)
}
/** Una prova in una transazione che si annulla. */
async function inRollback<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN')
  try { return await fn() } finally { await db.exec('ROLLBACK') }
}
/** Il codice dell'errore, dentro una transazione: un savepoint, così l'errore non la rovina. */
async function errore(f: () => Promise<unknown>): Promise<string> {
  await db.exec('SAVEPOINT prima_dell_errore')
  try { await f() } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT prima_dell_errore')
    const x = e as { code?: string; message?: string }
    return /^[A-Z_]+$/.test(x.message ?? '') ? x.message! : (x.code ?? x.message ?? 'senza-codice')
  }
  return 'nessun-errore'
}
const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)

async function nuovoAlunno(sede = SEDE): Promise<string> {
  return una<string>(`INSERT INTO public.alunni (scuola_id) VALUES ($1) RETURNING id`, [sede])
}

beforeAll(async () => {
  db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE, SEDE_B] })
  A = await anno('s.id = public.anno_attivo($1)', [SEDE])
  AB = await anno('s.id = public.anno_attivo($1)', [SEDE_B])
  P = await anno(`s.scuola_id = $1 AND s.fine = ($2::date - 1)`, [SEDE, A.inizio])

  // La «scatola nera» di prova: registra il com'era di ogni UPDATE, come fa quella vera.
  await db.exec(`
    CREATE FUNCTION public.prova_scatola_nera() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
      SELECT TG_TABLE_NAME, (to_jsonb(OLD) ->> 'id'), to_jsonb(OLD), coalesce(array_agg(n.key), '{}'), 'prova'
        FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
       WHERE n.value IS DISTINCT FROM o.value;
      RETURN NEW;
    END $f$;
  `)

  // Il seme pulito: un po' di tutto, tutto a posto.
  SEZ = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [SEDE])
  SEZ2 = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Margherite') RETURNING id`, [SEDE])
  SEZ_PREV = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Girasoli', $2) RETURNING id`, [SEDE, P.anno_id])
  ALUNNO1 = await una<string>(`INSERT INTO public.alunni (scuola_id, section_id) VALUES ($1, $2) RETURNING id`, [SEDE, SEZ])
  ALUNNO2 = await nuovoAlunno()                       // nessuna frequenza: non si confronta
  ALUNNO3 = await una<string>(`INSERT INTO public.alunni (scuola_id, section_id) VALUES ($1, $2) RETURNING id`, [SEDE, SEZ2])
  await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, section_id, data) VALUES ($1, $2, $3, $4)`, [SEDE, ALUNNO1, SEZ, A.inizio])
  await db.query(`INSERT INTO public.valutazioni (alunno_id, section_id, data_evento) VALUES ($1, $2, $3)`, [ALUNNO1, SEZ, A.inizio])
  await db.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, $2)`, [SEDE, A.inizio])
  await db.query(
    `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
     VALUES ($1, $2, 'Retta', 100, $3, $3)`, [SEDE, ALUNNO1, A.inizio])
  const thread = await una<string>(`INSERT INTO public.chat_threads (student_id, parent_id) VALUES ($1, $2) RETURNING id`, [ALUNNO1, GENITORE])
  await db.query(`INSERT INTO public.chat_messages (thread_id, created_at) VALUES ($1, ($2::date + time '12:00') AT TIME ZONE 'Europe/Rome')`, [thread, A.inizio])
  await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [U1, SEZ])
  await db.query(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso, section_id)
     VALUES ($1, $2, 'nuova', 'segreteria', $3, $4)`, [ALUNNO1, A.id, A.inizio, SEZ])
  // ALUNNO3 ha una frequenza solo nell'anno scorso: la sua scheda (sezione diversa) NON si confronta.
  await db.query(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso, data_uscita, stato)
     VALUES ($1, $2, 'conferma', 'segreteria', $3, $4, 'uscito')`, [ALUNNO3, P.id, P.inizio, P.fine])
}, 120_000)
afterAll(async () => { await db.close() })

describe('anno_invarianti · il seme pulito', () => {
  prova('il banco di prova ha il registro che ci si aspetta', async () => {
    const r = await db.query<{ tabella: string }>(`SELECT tabella FROM public.anno_tabelle ORDER BY tabella`)
    expect(r.rows.map((x) => x.tabella)).toEqual(REGISTRO_PROVA)
  })

  prova('somma zero, e l\'insieme (invariante, tabella) è quello atteso: una riga per invariante e per tabella', async () => {
    const rs = await invarianti()
    expect(rs.reduce((n, x) => n + x.righe, 0)).toBe(0)
    const atteso = [
      '1:anni_sede',
      ...CON_DATA.map((t) => `2:${t}`),
      '3:frequenze', '4:frequenze', '4:frequenze (flag)', '5:pagamenti',
      ...REGISTRO_PROVA.map((t) => `6:${t}`),
      ...CON_SEZIONE.map((t) => `9:${t}`),
      ...REGISTRO_PROVA.map((t) => `10a:${t}`),
      '10b:(nessuna)', '11:alunni',
    ].sort()
    expect(rs.map((x) => `${x.invariante}:${x.tabella}`).sort()).toEqual(atteso)
  })

  // La 8 è della PR 4.3 (migrazione `_anno_sezioni_docenti_fase_b.sql`, provata in fondo a questo file con
  // `fino: 'M43'`): questo banco ha solo la migrazione della PR 1, quindi non la vede e non se ne parla qui.
  prova('l’invariante 7 arriva con la PR 4.4: qui non c’è (e nessuna altra manca o avanza)', async () => {
    const nomi = [...new Set((await invarianti()).map((x) => x.invariante))].sort()
    expect(nomi).toEqual(['1', '10a', '10b', '11', '2', '3', '4', '5', '6', '9'].sort())
    expect(nomi).not.toContain('7')
  })

  prova('un database con DATI VECCHI (righe senza anno, manopole spente) dà zero', async () => {
    const vecchio = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE],
      codaPrima: `
        INSERT INTO public.sections (scuola_id, name) VALUES ('${SEDE}', 'Vecchia');
        INSERT INTO public.alunni (id, scuola_id, section_id)
          SELECT '44444444-4444-4444-8444-444444444441', '${SEDE}', id FROM public.sections;
        INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ('${SEDE}', '44444444-4444-4444-8444-444444444441', '2023-10-02');
        INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
          VALUES ('${SEDE}', '44444444-4444-4444-8444-444444444441', 'Retta', 100, '2023-10-05', '2023-10-01');
        INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
          VALUES ('presenze', 'x', '{"scuola_id": "${SEDE}"}', ARRAY['data'], 'prova');`,
    })
    try {
      const r = await vecchio.query<{ s: string }>(`SELECT coalesce(sum(righe), 0)::text AS s FROM public.anno_invarianti()`)
      expect(r.rows[0].s).toBe('0')
    } finally { await vecchio.close() }
  })
})

describe('invariante 1 · nessun giorno senza anno, nessun giorno in due anni', () => {
  prova('un buco di 5 giorni fra due anni sale a 5 (e solo la 1)', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.anni_sede DISABLE TRIGGER anni_sede_continuita`)
      await db.query(`UPDATE public.anni_sede SET fine = fine - 5 WHERE id = $1`, [P.id])
      expect(await sopra()).toEqual(['1:anni_sede=5'])
    })
  })

  prova('tre giorni coperti da DUE anni salgono a 3', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.anni_sede DISABLE TRIGGER anni_sede_continuita`)
      await db.exec(`ALTER TABLE public.anni_sede DROP CONSTRAINT anni_sede_periodi_senza_sovrapposizioni`)
      await db.query(`UPDATE public.anni_sede SET inizio = inizio - 3 WHERE id = $1`, [A.id])
      expect(await sopra()).toEqual(['1:anni_sede=3'])
    })
  })
})

describe('invariante 2 · nessuna riga fuori dal suo anno (la corsa di sposta_confine_anno)', () => {
  prova('dopo uno spostamento di confine una riga scritta con l\'anno vecchio nei giorni spostati è fuori periodo', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.anni_scolastici (anno_inizio) VALUES ($1) ON CONFLICT (anno_inizio) DO NOTHING`, [A.anno_inizio + 1])
      await db.query(
        `INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
         SELECT $1, y.id, y.inizio_predefinito, y.fine_predefinita, 'in_preparazione', make_date(y.anno_inizio + 1, 7, 31), y.inizio_predefinito
           FROM public.anni_scolastici y
          WHERE y.anno_inizio = $2
            AND NOT EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.scuola_id = $1 AND x.anno_id = y.id)`,
        [SEDE, A.anno_inizio + 1])
      const esito = await una<{ cambiato: boolean }>(`SELECT public.sposta_confine_anno($1, ($2::date - 10))`, [A.id, A.fine])
      expect(esito.cambiato).toBe(true)
      expect(await sopra()).toEqual([])                       // lo spostamento pulito non lascia niente
      // l'INSERT «concorrente»: scritto con l'anno vecchio in un giorno che ormai è del successivo
      await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data, anno_id) VALUES ($1, $2, ($3::date - 5), $4)`,
        [SEDE, ALUNNO1, A.fine, A.anno_id])
      await db.query(
        `INSERT INTO public.chat_messages (thread_id, created_at, anno_id)
         SELECT id, (($1::date - 4) + time '12:00') AT TIME ZONE 'Europe/Rome', $2 FROM public.chat_threads LIMIT 1`,
        [A.fine, A.anno_id])
      expect(await sopra()).toEqual(['2:chat_messages=1', '2:presenze=1'])
    })
  })

  prova('una presenza PRIMA dell\'inizio del suo anno è fuori periodo', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data, anno_id) VALUES ($1, $2, ($3::date - 1), $4)`,
        [SEDE, ALUNNO1, A.inizio, A.anno_id])
      expect(await sopra()).toEqual(['2:presenze=1'])
    })
  })
})

describe('invariante 3 · una sola frequenza viva per bambino e per anno', () => {
  prova('due frequenze vive (due sedi) dello stesso bambino nello stesso anno → 1', async () => {
    await inRollback(async () => {
      await db.exec(`DROP INDEX public.frequenze_una_viva_per_anno`)
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, data_ingresso)
         VALUES ($1, $2, 'nuova', 'segreteria', $3)`, [ALUNNO1, AB.id, AB.inizio])
      expect(await sopra()).toEqual(['3:frequenze=1'])
    })
  })
})

describe('invariante 4 · un «iscritto» a posto davvero, ricalcolato dalla verità', () => {
  prova('un iscritto senza quota (coi flag veri scritti a mano) → 1', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.frequenze DISABLE TRIGGER USER`)
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, tipo, origine, stato, moduli_completi, quota_saldata, data_ingresso)
         VALUES ($1, $2, $3, $4, 'nuova', 'segreteria', 'iscritto', true, true, $5)`,
        [await nuovoAlunno(), A.id, A.anno_id, SEDE, A.inizio])
      // anche i flag mentono (quota_saldata vero senza voce pagata): le due righe salgono insieme
      expect(await sopra()).toEqual(['4:frequenze=1', '4:frequenze (flag)=1'])
    })
  })

  prova('lo stesso iscritto ma del RECUPERO non è una violazione', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.frequenze DISABLE TRIGGER USER`)
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, tipo, origine, stato, data_ingresso)
         VALUES ($1, $2, $3, $4, NULL, 'recupero', 'iscritto', $5)`,
        [await nuovoAlunno(), A.id, A.anno_id, SEDE, A.inizio])
      expect(await sopra()).toEqual([])
    })
  })

  prova('un flag che mente (quota_saldata vero senza voce pagata) → 1, nella riga dei flag', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.frequenze DISABLE TRIGGER USER`)
      await db.query(`UPDATE public.frequenze SET quota_saldata = true WHERE alunno_id = $1 AND anno_sede_id = $2`, [ALUNNO1, A.id])
      expect(await sopra()).toEqual(['4:frequenze (flag)=1'])
    })
  })
})

describe('invariante 5 · nessuna competenza fuori dal periodo del suo anno', () => {
  prova('una voce dell\'anno attivo con la competenza nell\'anno prima → 1', async () => {
    await inRollback(async () => {
      await db.query(
        `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza, anno_id)
         VALUES ($1, $2, 'Retta', 100, $3, ($3::date - 10), $4)`, [SEDE, ALUNNO1, A.inizio, A.anno_id])
      expect(await sopra()).toEqual(['5:pagamenti=1'])
    })
  })
})

describe('invariante 6 · nessuna modifica di un anno chiuso senza la sua correzione', () => {
  /** Una presenza dell'anno scorso (chiuso), la scatola nera di prova su `presenze`. */
  async function preparaPresenza(): Promise<string> {
    const id = await una<string>(`INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, $3) RETURNING id`, [SEDE, ALUNNO1, P.inizio])
    await db.exec(`CREATE TRIGGER trg_prova_nera AFTER UPDATE ON public.presenze FOR EACH ROW EXECUTE FUNCTION public.prova_scatola_nera()`)
    return id
  }

  prova('una modifica che ha scavalcato la guardia, senza gettone → 1', async () => {
    await inRollback(async () => {
      const id = await preparaPresenza()
      await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      await db.query(`UPDATE public.presenze SET alunno_id = $2 WHERE id = $1`, [id, ALUNNO2])
      expect(await sopra()).toEqual(['6:presenze=1'])
    })
  })

  prova('la stessa modifica col gettone nella stessa transazione → 0 (e l\'uso c\'è)', async () => {
    await inRollback(async () => {
      const id = await preparaPresenza()
      await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
      const g = await una<string>(
        `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo)
         VALUES ($1, 'direzione', $2, 'correzione', 'prova') RETURNING id`, [U1, P.id])
      await db.query(`SELECT set_config('request.headers', json_build_object('x-kidville-correzione', $1::text)::text, true)`, [g])
      await db.query(`UPDATE public.presenze SET alunno_id = $2 WHERE id = $1`, [id, ALUNNO2])
      expect(await una<string>(`SELECT count(*)::text FROM public.correzioni_anno_chiuso_usi WHERE tabella = 'presenze'`)).toBe('1')
      expect(await una<string>(`SELECT count(*)::text FROM scatola_nera.modifiche WHERE tabella = 'presenze'`)).toBe('1')
      expect(await sopra()).toEqual([])
    })
  })

  async function preparaPagamento(): Promise<string> {
    const id = await una<string>(
      `INSERT INTO public.pagamenti (scuola_id, alunno_id, descrizione, importo, scadenza, periodo_competenza)
       VALUES ($1, $2, 'Retta', 100, $3, $3) RETURNING id`, [SEDE, ALUNNO1, P.inizio])
    await db.exec(`CREATE TRIGGER trg_prova_nera AFTER UPDATE ON public.pagamenti FOR EACH ROW EXECUTE FUNCTION public.prova_scatola_nera()`)
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
    await db.exec(`ALTER TABLE public.pagamenti DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
    return id
  }

  prova('una modifica di SOLE colonne d\'incasso (anche fattura_*) è esente → 0', async () => {
    await inRollback(async () => {
      const id = await preparaPagamento()
      await db.query(
        `UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100, data_incasso = $2::date, fattura_stato = 'emessa'
          WHERE id = $1`, [id, P.fine])
      expect(await una<string>(`SELECT count(*)::text FROM scatola_nera.modifiche WHERE tabella = 'pagamenti'`)).toBe('1')
      expect(await sopra()).toEqual([])
    })
  })

  prova('ma una modifica che tocca anche altro (la descrizione) NON è esente → 1', async () => {
    await inRollback(async () => {
      const id = await preparaPagamento()
      await db.query(`UPDATE public.pagamenti SET stato = 'pagato', importo_pagato = 100, descrizione = 'Altro' WHERE id = $1`, [id])
      expect(await sopra()).toEqual(['6:pagamenti=1'])
    })
  })

  prova('frequenze: le colonne derivate sono esenti, lo stato da solo e le date no', async () => {
    await inRollback(async () => {
      const f = await una<string>(`SELECT id FROM public.frequenze WHERE anno_sede_id = $1`, [P.id])
      await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
      const casi: string[][] = [
        ['moduli_completi', 'quota_saldata'],       // esente
        ['quota_pagamento_id'],                     // esente (la chiave esterna)
        ['moduli_completi', 'stato'],               // esente (transizione automatica)
        ['stato'],                                  // NO: uno stato scritto a mano
        ['data_ingresso'],                          // NO
      ]
      for (const c of casi) {
        await db.query(
          `INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
           SELECT 'frequenze', id::text, to_jsonb(f), $2::text[], 'prova' FROM public.frequenze f WHERE id = $1`,
          [f, `{${c.join(',')}}`])
      }
      expect(await sopra()).toEqual(['6:frequenze=2'])
    })
  })

  prova('le righe senza id (utenti_sezioni): l\'uso con riga_id NULL si accoppia per transazione e tabella', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [U2, SEZ_PREV])
      await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
      await db.exec(
        `INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
         SELECT 'utenti_sezioni', 'senza-id', to_jsonb(u), ARRAY['creato_il'], 'prova' FROM public.utenti_sezioni u WHERE utente_id = '${U2}'`)
      expect(await sopra()).toEqual(['6:utenti_sezioni=1'])
      const g = await una<string>(
        `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo)
         VALUES ($1, 'direzione', $2, 'correzione', 'prova') RETURNING id`, [U1, P.id])
      await db.query(`INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id) VALUES ($1, 'utenti_sezioni', NULL)`, [g])
      expect(await sopra()).toEqual([])
    })
  })

  prova('a guardia SPENTA (guardia_attiva_dal NULL) la stessa violazione conta zero', async () => {
    await inRollback(async () => {
      const id = await preparaPresenza()
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      await db.query(`UPDATE public.presenze SET alunno_id = $2 WHERE id = $1`, [id, ALUNNO2])
      expect(await una<string>(`SELECT count(*)::text FROM scatola_nera.modifiche WHERE tabella = 'presenze'`)).toBe('1')
      expect(await sopra()).toEqual([])
    })
  })

  prova('una modifica ANTERIORE all\'accensione della guardia, o al cambio di stato, non conta', async () => {
    await inRollback(async () => {
      const id = await preparaPresenza()
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      await db.query(`UPDATE public.presenze SET alunno_id = $2 WHERE id = $1`, [id, ALUNNO2])
      await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
      await db.exec(`UPDATE scatola_nera.modifiche SET modificata_il = now() - interval '1 hour'`)
      expect(await sopra()).toEqual([])                       // prima della guardia
      await db.exec(`UPDATE scatola_nera.modifiche SET modificata_il = clock_timestamp()`)
      expect(await sopra()).toEqual(['6:presenze=1'])         // dopo: conta
      await db.query(`UPDATE public.anni_sede_stati SET dal = now() + interval '1 hour' WHERE anno_sede_id = $1`, [P.id])
      expect(await sopra()).toEqual([])                       // l'anno è diventato chiuso DOPO la modifica
    })
  })

  prova('senza scatola nera: una riga «(scatola_nera assente)» con zero, e nessuna riga per tabella', async () => {
    await inRollback(async () => {
      await db.exec(`DROP TABLE scatola_nera.modifiche`)
      const sei = (await invarianti()).filter((x) => x.invariante === '6')
      expect(sei).toEqual([{ invariante: '6', tabella: '(scatola_nera assente)', righe: 0 }])
    })
  })
})

describe('invariante 9 · nessuna riga NUOVA con una sezione di un altro anno', () => {
  prova('una presenza creata dopo l\'accensione dei controlli, con la sezione dell\'anno scorso → 1; la vecchia no', async () => {
    await inRollback(async () => {
      await db.exec(`UPDATE public.anno_regole SET controlli_rigidi = true`)
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      const ins = `INSERT INTO public.presenze (scuola_id, alunno_id, section_id, data, anno_id, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`
      await db.query(ins, [SEDE, ALUNNO1, SEZ_PREV, A.inizio, A.anno_id, new Date(Date.now() - 86_400_000).toISOString()])  // creata PRIMA
      expect(await sopra()).toEqual([])
      await db.query(ins, [SEDE, ALUNNO1, SEZ_PREV, A.inizio, A.anno_id, new Date(Date.now() + 60_000).toISOString()])     // creata DOPO
      expect(await sopra()).toEqual(['9:presenze=1'])
    })
  })

  prova('con i controlli spenti (controlli_rigidi_dal NULL) conta zero', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      await db.query(
        `INSERT INTO public.presenze (scuola_id, alunno_id, section_id, data, anno_id) VALUES ($1, $2, $3, $4, $5)`,
        [SEDE, ALUNNO1, SEZ_PREV, A.inizio, A.anno_id])
      expect(await sopra()).toEqual([])
    })
  })
})

describe('invariante 10 · il registro e lo schema dicono la stessa cosa', () => {
  prova('10a: una tabella del registro senza il trigger → 1; senza la colonna anno_id → 1', async () => {
    await inRollback(async () => {
      await db.exec(`DROP TRIGGER trg_zz_anno_assegna_e_verifica ON public.presenze`)
      expect(await sopra()).toEqual(['10a:presenze=1'])
      await db.exec(`ALTER TABLE public.valutazioni DROP COLUMN anno_id`)
      expect(await sopra()).toEqual(['10a:presenze=1', '10a:valutazioni=1'])
    })
  })

  prova('10b: una tabella con anno_id che il registro non conosce → 1, col suo nome; anni_sede non conta', async () => {
    await inRollback(async () => {
      await db.exec(`CREATE TABLE public.tabella_di_prova (anno_id uuid)`)
      const dopo = (await invarianti()).filter((x) => x.invariante === '10b')
      expect(dopo).toEqual([{ invariante: '10b', tabella: 'tabella_di_prova', righe: 1 }])
    })
  })
})

describe('invariante 11 · la scheda alunno e la frequenza dell\'anno attivo dicono la stessa cosa', () => {
  prova('la sezione della scheda diversa da quella della frequenza → 1', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.alunni SET section_id = $2 WHERE id = $1`, [ALUNNO1, SEZ2])
      expect(await sopra()).toEqual(['11:alunni=1'])
    })
  })

  prova('un campo con lo stesso nome (usa_pannolino) che diverge → 1', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.alunni SET usa_pannolino = true WHERE id = $1`, [ALUNNO1])
      expect(await sopra()).toEqual(['11:alunni=1'])
    })
  })

  prova('chi non ha la frequenza nell\'anno attivo non si confronta (nemmeno se la scheda diverge)', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.alunni SET section_id = $2, usa_pannolino = true WHERE id = ANY($1::uuid[])`, [[ALUNNO2, ALUNNO3], SEZ])
      expect(await sopra()).toEqual([])
    })
  })
})

describe('gli aiuti per tabella', () => {
  it.each(['anno_righe_fuori_periodo', 'anno_righe_sezione_altro_anno', 'anno_righe_senza_anno'])(
    '%s: una tabella che non è nel registro è un ERRORE, non uno zero', async (f) => {
      await expect(db.query(`SELECT public.${f}('alunni')`)).rejects.toThrow(/non è nel registro/)
      await expect(db.query(`SELECT public.${f}('tabella_che_non_esiste')`)).rejects.toThrow(/non è nel registro/)
    })

  prova('anno_righe_senza_anno conta le righe con anno_id NULL', async () => {
    await inRollback(async () => {
      expect(Number(await una<string>(`SELECT public.anno_righe_senza_anno('presenze')`))).toBe(0)
      await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER USER`)
      await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data) VALUES ($1, $2, $3)`, [SEDE, ALUNNO1, A.inizio])
      expect(Number(await una<string>(`SELECT public.anno_righe_senza_anno('presenze')`))).toBe(1)
      // e NON entra in anno_invarianti(): tutte le righe vecchie sono senza anno fino alla PR 2
      expect(await sopra()).toEqual([])
    })
  })

  prova('anno_righe_fuori_periodo e anno_righe_sezione_altro_anno rispondono per tabella', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.presenze (scuola_id, alunno_id, data, anno_id) VALUES ($1, $2, ($3::date - 1), $4)`,
        [SEDE, ALUNNO1, A.inizio, A.anno_id])
      expect(Number(await una<string>(`SELECT public.anno_righe_fuori_periodo('presenze')`))).toBe(1)
      expect(Number(await una<string>(`SELECT public.anno_righe_fuori_periodo('valutazioni')`))).toBe(0)
    })
  })

  prova('solo service_role può eseguirle (e anno_invarianti)', async () => {
    const chiamate = [
      `SELECT * FROM public.anno_invarianti()`,
      `SELECT public.anno_righe_fuori_periodo('presenze')`,
      `SELECT public.anno_righe_sezione_altro_anno('presenze')`,
      `SELECT public.anno_righe_senza_anno('presenze')`,
    ]
    for (const sql of chiamate) {
      for (const ruolo of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${ruolo}`)
        await expect(db.query(sql), `${ruolo}: ${sql}`).rejects.toMatchObject({ code: '42501' })
        await db.exec('RESET ROLE')
      }
      await db.exec('SET ROLE service_role')
      await expect(db.query(sql), sql).resolves.toBeDefined()
      await db.exec('RESET ROLE')
    }
  })
})

describe('le tabelle del passaggio d\'anno', () => {
  const TABELLE = ['passaggi_anno', 'passaggi_anno_righe', 'passaggi_anno_docenti']

  prova('RLS accesa, nessuna policy, nessun privilegio ad anon e authenticated, tutti a service_role', async () => {
    for (const t of TABELLE) {
      expect(await una<boolean>(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`]), t).toBe(true)
      expect(await una<string>(`SELECT count(*)::text FROM pg_policies WHERE tablename = $1`, [t]), t).toBe('0')
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

  prova('ogni chiave esterna ha il suo indice', async () => {
    const r = await db.query<{ tabella: string; vincolo: string }>(
      `SELECT c.conrelid::regclass::text AS tabella, c.conname AS vincolo
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_index i
                           WHERE i.indrelid = c.conrelid
                             AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)`, [TABELLE.map((t) => `public.${t}`)])
    expect(r.rows).toEqual([])
  })

  async function passaggio(stato: string, da = P.id, a = A.id): Promise<string> {
    return una<string>(`INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id, stato, confermato_il, annullato_il)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'confermato' THEN now() END, CASE WHEN $4 = 'annullato' THEN now() END) RETURNING id`,
      [SEDE, da, a, stato])
  }

  prova('un solo passaggio NON annullato per coppia di anni; un annullato non blocca il nuovo', async () => {
    await inRollback(async () => {
      await passaggio('anteprima')
      expect(await errore(() => passaggio('anteprima'))).toBe('23505')
    })
    await inRollback(async () => {
      await passaggio('annullato')
      await passaggio('annullato')
      await passaggio('anteprima')
      expect(await errore(() => passaggio('confermato'))).toBe('23505')
    })
  })

  prova('stato fuori elenco, stesso anno di partenza e arrivo: CHECK (23514); i conteggi partono vuoti', async () => {
    await inRollback(async () => {
      expect(await errore(() => passaggio('boh'))).toBe('23514')
    })
    await inRollback(async () => {
      expect(await errore(() => passaggio('anteprima', A.id, A.id))).toBe('23514')
    })
    await inRollback(async () => {
      const id = await passaggio('anteprima')
      expect(await una<string>(`SELECT conteggi::text FROM public.passaggi_anno WHERE id = $1`, [id])).toBe('{}')
    })
  })

  prova('le righe: eccezione è un booleano falso di default (mai testo libero), esito da un elenco chiuso, una per bambino', async () => {
    await inRollback(async () => {
      const p = await passaggio('anteprima')
      const riga = (esito: string) => db.query(
        `INSERT INTO public.passaggi_anno_righe (passaggio_id, alunno_id, esito) VALUES ($1, $2, $3)`, [p, ALUNNO1, esito])
      expect(await errore(() => riga('boh'))).toBe('23514')
      await riga('continua')
      expect(await una<boolean>(`SELECT eccezione FROM public.passaggi_anno_righe WHERE passaggio_id = $1`, [p])).toBe(false)
      expect(await errore(() => riga('esce'))).toBe('23505')
      expect(await una<string>(`SELECT data_type FROM information_schema.columns WHERE table_name = 'passaggi_anno_righe' AND column_name = 'eccezione'`)).toBe('boolean')
    })
  })

  prova('i docenti: origine copiata|aggiunta|tolta, un utente una volta per sezione; sparisce col passaggio', async () => {
    await inRollback(async () => {
      const p = await passaggio('anteprima')
      await db.query(`INSERT INTO public.utenti (id) VALUES ($1)`, [U1])
      const doc = (origine: string) => db.query(
        `INSERT INTO public.passaggi_anno_docenti (passaggio_id, utente_id, sezione_a_id, origine) VALUES ($1, $2, $3, $4)`, [p, U1, SEZ, origine])
      expect(await errore(() => doc('boh'))).toBe('23514')
      await doc('copiata')
      expect(await errore(() => doc('aggiunta'))).toBe('23505')
      await db.query(`DELETE FROM public.passaggi_anno WHERE id = $1`, [p])
      expect(await una<string>(`SELECT count(*)::text FROM public.passaggi_anno_docenti`)).toBe('0')
    })
  })
})

/**
 * PR 2 · COMPITO 2.3 · LE INVARIANTI 12, 13 E LA RIGA `alunni (senza frequenza)` (la 11-bis), definite da V2.
 *
 * Un database a parte, con la catena M1 → F1 → V1 → V2 applicata sul banco minimo della PR 1 (il registro è lo stesso
 * di `REGISTRO_PROVA`). Ogni invariante ha la sua PROVA DEL ROSSO: un seme rotto apposta la porta sopra zero e il test
 * controlla che salga SOLO quella. Date FISSE; solo uuid finti.
 */
describe('anno_invarianti · le invarianti della PR 2 (12, 13, 11-bis)', () => {
  const S = '22222222-2222-4222-8222-222222222222'
  const FINTO = '99999999-9999-4999-8999-999999999999'
  let d: PGlite
  let SEZ_P2: string
  let AL_P2: string

  const q = async <T,>(sql: string, params: unknown[] = []): Promise<T> => {
    const r = await d.query<Record<string, T>>(sql, params)
    return Object.values(r.rows[0])[0] as T
  }
  const rige = async (): Promise<Riga[]> => {
    const r = await d.query<{ invariante: string; tabella: string; righe: string }>(
      `SELECT invariante, tabella, righe::text FROM public.anno_invarianti() ORDER BY invariante, tabella`)
    return r.rows.map((x) => ({ ...x, righe: Number(x.righe) }))
  }
  const soprazero = async () => (await rige()).filter((x) => x.righe > 0).map((x) => `${x.invariante}:${x.tabella}=${x.righe}`)
  const rollback = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await d.exec('BEGIN')
    try { return await fn() } finally { await d.exec('ROLLBACK') }
  }

  beforeAll(async () => {
    d = await creaDbAnnoPr2({ sedi: [S], fino: 'V2' })
    SEZ_P2 = await q<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S])
    // lo specchio crea la frequenza dell'alunno (origine recupero) con la stessa sezione
    AL_P2 = await q<string>(`INSERT INTO public.alunni (scuola_id, section_id) VALUES ($1, $2) RETURNING id`, [S, SEZ_P2])
    await d.query(`INSERT INTO public.presenze (scuola_id, alunno_id, section_id, data) VALUES ($1, $2, $3, DATE '2026-10-05')`, [S, AL_P2, SEZ_P2])
    await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza, target_classes) VALUES ($1, DATE '2026-10-05', ARRAY['Girasoli'])`, [S])
  }, 120_000)
  afterAll(async () => { await d.close() })

  prova('seme pulito: tutto a zero, e l\'insieme restituito è quello atteso (una riga per invariante, anche a zero)', async () => {
    expect(await soprazero()).toEqual([])
    const atteso = [
      '1:anni_sede',
      ...CON_DATA.map((t) => `2:${t}`),
      '3:frequenze', '4:frequenze', '4:frequenze (flag)', '5:pagamenti',
      ...REGISTRO_PROVA.map((t) => `6:${t}`),
      ...CON_SEZIONE.map((t) => `9:${t}`),
      ...REGISTRO_PROVA.map((t) => `10a:${t}`),
      '10b:(nessuna)', '11:alunni', '11:alunni (senza frequenza)',
      ...REGISTRO_PROVA.map((t) => `12:${t}`),
      '13:avvisi',
    ].sort()
    expect((await rige()).map((x) => `${x.invariante}:${x.tabella}`).sort()).toEqual(atteso)
  })

  prova('12 · avvisi con la sede e senza anno (CHECK tolto, trigger spento nel seme) → sale SOLO 12:avvisi; senza sede non conta', async () => {
    await rollback(async () => {
      await d.exec(`ALTER TABLE public.avvisi DROP CONSTRAINT avvisi_anno_id_presente`)
      await d.exec(`ALTER TABLE public.avvisi DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
      await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES (NULL, DATE '2026-10-05')`)
      expect(await soprazero()).toEqual([])                       // senza sede: il CHECK lo ammette, la 12 non lo conta
      await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza) VALUES ($1, DATE '2026-10-05')`, [S])
      expect(await soprazero()).toEqual(['12:avvisi=1'])
    })
    expect(await soprazero()).toEqual([])
  })

  prova('13 · un uuid in target_section_ids senza il nome corrispondente → sale SOLO 13:avvisi', async () => {
    await rollback(async () => {
      await d.query(`INSERT INTO public.avvisi (scuola_id, giorno_competenza, target_section_ids) VALUES ($1, DATE '2026-10-05', ARRAY[$2]::uuid[])`, [S, FINTO])
      expect(await soprazero()).toEqual(['13:avvisi=1'])
    })
    expect(await soprazero()).toEqual([])
  })

  prova('11-bis · un alunno con sede e senza frequenza nell\'anno attivo → sale SOLO 11:alunni (senza frequenza)', async () => {
    await rollback(async () => {
      await d.query(`DELETE FROM public.frequenze WHERE alunno_id = $1`, [AL_P2])
      expect(await soprazero()).toEqual(['11:alunni (senza frequenza)=1'])
    })
    expect(await soprazero()).toEqual([])
  })
})

/**
 * COMPITO 4.3.2 · l'invariante 8: i docenti vedono solo sezioni di anni attivi o passati.
 * Banco con la catena fino a M43. `righe` = quante delle sezioni che `sezioni_visibili_docente` restituisce
 * appartengono a un anno `in_preparazione` o `iscrizioni_aperte`. «Passa» vuol dire `righe = 0`.
 */
describe('anno_invarianti · l’invariante 8 (PR 4.3)', () => {
  const S = '22222222-2222-4222-8222-222222222222'
  const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  const SEZ_CORR = '55555555-5555-4555-8555-555555555552'
  const SEZ_FUTURA = '55555555-5555-4555-8555-555555555553'
  const ZERO = [{ invariante: '8', tabella: 'utenti_sezioni', righe: 0 }]
  let d: PGlite

  const riga8 = async (): Promise<Riga[]> => {
    const r = await d.query<{ invariante: string; tabella: string; righe: string }>(
      `SELECT invariante, tabella, righe::text FROM public.anno_invarianti() WHERE invariante = '8'`)
    return r.rows.map((x) => ({ ...x, righe: Number(x.righe) }))
  }
  const rollback = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await d.exec('BEGIN')
    try { return await fn() } finally { await d.exec('ROLLBACK') }
  }

  /** Ridefinisce `sezioni_visibili_docente` col corpo dato (`p_utente` è il parametro): la versione SENZA filtro di stato. */
  const visibilitaSenzaFiltroDiStato = (corpo: string) =>
    d.exec(`
        CREATE OR REPLACE FUNCTION public.sezioni_visibili_docente(p_utente uuid)
        RETURNS TABLE (section_id uuid, sola_lettura boolean)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ ${corpo} $$`)

  beforeAll(async () => {
    d = await creaDbAnnoPr2({ sedi: [S], fino: 'M43' })
    const anni = await d.query<{ anno_inizio: number; anno_id: string }>(
      `SELECT y.anno_inizio, s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1`, [S])
    const idAnno = (n: number) => anni.rows.find((x) => x.anno_inizio === n)!.anno_id
    await d.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, 'Girasoli', $3)`, [SEZ_CORR, S, idAnno(2026)])
    await d.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, 'Girasoli', $3)`, [SEZ_FUTURA, S, idAnno(2027)])
  }, 120_000)
  afterAll(async () => { await d.close() })

  prova('anno_invarianti() contiene la riga 8 e passa con docenti assegnati solo a sezioni di anni futuri', async () => {
    await rollback(async () => {
      await d.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2)`, [DOC, SEZ_FUTURA])
      expect(await riga8()).toEqual(ZERO)
    })
    // la riga c'è anche senza nessuna assegnazione
    expect(await riga8()).toEqual(ZERO)
  })

  prova('la riga 8 va rossa se la visibilità dei docenti perde il filtro di stato', async () => {
    await rollback(async () => {
      await d.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2), ($1, $3)`, [DOC, SEZ_CORR, SEZ_FUTURA])
      expect(await riga8()).toEqual(ZERO)
      // la stessa funzione, SENZA il filtro sullo stato dell'anno
      await visibilitaSenzaFiltroDiStato(`
          SELECT us.section_id, (a.stato::text <> 'corrente')
            FROM public.utenti_sezioni us
            JOIN public.sections s  ON s.id = us.section_id
            JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
           WHERE us.utente_id = p_utente`)
      const r = await riga8()
      expect(r).toHaveLength(1)
      expect(r[0].righe).toBeGreaterThanOrEqual(1)
    })
    // il ROLLBACK ha ripristinato la funzione vera
    expect(await riga8()).toEqual(ZERO)
  })

  prova('la riga 8 non è tautologica: coincide con un conteggio fatto a parte dal catalogo', async () => {
    await rollback(async () => {
      await d.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2), ($1, $3)`, [DOC, SEZ_CORR, SEZ_FUTURA])
      await visibilitaSenzaFiltroDiStato(
        `SELECT us.section_id, false FROM public.utenti_sezioni us WHERE us.utente_id = p_utente`)
      const dalCatalogo = await d.query<{ n: string }>(
        `SELECT count(*)::text n
           FROM public.utenti_sezioni us
           JOIN public.sections s  ON s.id = us.section_id
           JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
          WHERE a.stato::text IN ('in_preparazione', 'iscrizioni_aperte')`)
      expect(Number(dalCatalogo.rows[0].n)).toBe(1)
      expect((await riga8())[0].righe).toBe(Number(dalCatalogo.rows[0].n))
    })
  })
})

/**
 * COMPITO 4.4.5 · l'invariante 7: nessun genitore vede qualcosa attraverso un figlio non attivo.
 * Banco con la catena fino a M44a. Quattro righe, una per ciò che si può vedere; «passa» vuol dire quattro zeri e nessuna
 * riga `(controllo fallito: …)`. Il figlio non attivo lo dice il catalogo, non la funzione controllata: per questo le prove
 * rompono le funzioni e guardano la riga salire. Si parla di genitori: il docente e le voci di pagamento non entrano.
 */
describe('anno_invarianti · l’invariante 7 (PR 4.4)', () => {
  const S = '22222222-2222-4222-8222-222222222222'
  const S_B = '22222222-2222-4222-8222-222222222223'
  const SEZ = '55555555-5555-4555-8555-555555555551'
  const SEZ_B = '55555555-5555-4555-8555-555555555552'

  const VIVO = '11111111-1111-4111-8111-111111111111'
  const RITIRATO = '11111111-1111-4111-8111-111111111112'
  /** Ritirato nella prima sede e iscritto nella seconda: è attivo, e nella prima non vede niente. */
  const ALTROVE = '11111111-1111-4111-8111-111111111113'
  /** Parte senza nessuna frequenza: gliela danno le prove. */
  const SENZA = '11111111-1111-4111-8111-111111111114'

  const GEN_VIVO = '99999999-9999-4999-8999-999999999991'
  const GEN_MISTO = '99999999-9999-4999-8999-999999999992'
  const GEN_RITIRATO = '99999999-9999-4999-8999-999999999993'
  /** Legato al ritirato solo dalla strada `parents` → `student_parents`. */
  const GEN_PONTE = '99999999-9999-4999-8999-999999999994'
  const GEN_ALTROVE = '99999999-9999-4999-8999-999999999995'
  const GEN_SENZA = '99999999-9999-4999-8999-999999999996'
  const DOC = '77777777-7777-4777-8777-777777777771'
  /** Docente, e genitore del ritirato: ha un thread da docente su suo figlio, e quello lo vede sempre. */
  const DOC_GENITORE = '77777777-7777-4777-8777-777777777772'
  /** Legato dalla stessa strada a un figlio vivo: non va guardato. */
  const GEN_PONTE_VIVO = '99999999-9999-4999-8999-999999999997'
  const SCHEDA_PONTE = '88888888-8888-4888-8888-888888888881'
  const SCHEDA_PONTE_VIVO = '88888888-8888-4888-8888-888888888882'
  /** Una scheda senza account: nessuno entra da lì, e non c'è nessuno da guardare. */
  const SCHEDA_SENZA_ACCOUNT = '88888888-8888-4888-8888-888888888883'

  /** I genitori da cui deve partire la riga, cioè quelli con almeno un figlio non attivo. */
  const CON_FIGLIO_NON_ATTIVO = [GEN_MISTO, GEN_RITIRATO, GEN_PONTE, GEN_SENZA, DOC_GENITORE].sort()
  const ZERO = { avvisi: 0, chat_threads: 0, frequenze: 0, galleria_media_v2: 0 }
  /** Con la funzione delle foto rotta: 2 foto del ritirato per 4 genitori, più la foto di `SENZA` per il suo. */
  const FOTO_NON_ATTIVI = 9

  let d: PGlite
  let ANNO_PRIMA: string
  let ANNO_ATTIVO: string
  let ANNO_DOPO: string
  let ATTIVO_B: string
  let PRIMA_B: string
  let THREAD_DA_DOCENTE: string

  const riga7 = async (): Promise<Record<string, number>> => {
    const r = await d.query<{ tabella: string; righe: string }>(
      `SELECT tabella, righe::text FROM public.anno_invarianti() WHERE invariante = '7'`)
    return Object.fromEntries(r.rows.map((x) => [x.tabella, Number(x.righe)]))
  }
  const rollback = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await d.exec('BEGIN')
    try { return await fn() } finally { await d.exec('ROLLBACK') }
  }
  const coppieFoto = async (genitore: string) =>
    (await d.query<{ media_id: string; alunno_id: string }>(
      `SELECT media_id, alunno_id FROM public.media_visibili_genitore($1)`, [genitore])).rows

  const QUALITA = 'STABLE SECURITY DEFINER SET search_path = public, pg_temp'
  /** Le foto di tutti i figli collegati, attivi o no. Una riga per coppia, come la funzione vera: un figlio per due strade è uno. */
  const FOTO_SENZA_FILTRO = `
      SELECT m.id, c.figlio
        FROM (SELECT DISTINCT unnest(public.figli_collegati(p_utente))) AS c(figlio)
        JOIN public.galleria_media_v2 m ON m.tag_students @> ARRAY[c.figlio]
       WHERE m.eliminato_il IS NULL`
  const fotoSenzaFiltro = () => d.exec(`
      CREATE OR REPLACE FUNCTION public.media_visibili_genitore(p_utente uuid)
      RETURNS TABLE (media_id uuid, alunno_id uuid) LANGUAGE sql ${QUALITA}
      AS $$ ${FOTO_SENZA_FILTRO} $$`)
  const avvisiSenzaFiltro = () => d.exec(`
      CREATE OR REPLACE FUNCTION public.avvisi_visibili_genitore(p_utente uuid)
      RETURNS TABLE (avviso_id uuid, alunno_id uuid) LANGUAGE sql ${QUALITA}
      AS $$ SELECT v.id, c.figlio FROM (SELECT DISTINCT unnest(public.figli_collegati(p_utente))) AS c(figlio) CROSS JOIN public.avvisi v $$`)
  const threadSenzaFiltro = () => d.exec(`
      CREATE OR REPLACE FUNCTION public.thread_visibili(p_utente uuid)
      RETURNS TABLE (thread_id uuid, scrivibile boolean) LANGUAGE sql ${QUALITA}
      AS $$ SELECT t.id, true FROM public.chat_threads t WHERE t.parent_id = p_utente OR t.teacher_id = p_utente $$`)
  /** Da qui passano `figli_attivi` e, con lei, le altre funzioni: senza filtro salgono tutte le righe. */
  const frequenzeSenzaFiltro = () => d.exec(`
      CREATE OR REPLACE FUNCTION public.frequenze_attive(p_alunni uuid[])
      RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid) LANGUAGE sql ${QUALITA}
      AS $$ SELECT f.alunno_id, f.id, f.section_id, f.scuola_id FROM public.frequenze f WHERE f.alunno_id = ANY (p_alunni) $$`)

  const GUASTABILI = [
    { nome: 'media_visibili_genitore', firma: 'media_visibili_genitore(p_utente uuid)', colonne: 'media_id uuid, alunno_id uuid' },
    { nome: 'avvisi_visibili_genitore', firma: 'avvisi_visibili_genitore(p_utente uuid)', colonne: 'avviso_id uuid, alunno_id uuid' },
    { nome: 'thread_visibili', firma: 'thread_visibili(p_utente uuid)', colonne: 'thread_id uuid, scrivibile boolean' },
    { nome: 'figli_attivi', firma: 'figli_attivi(p_utente uuid)', colonne: 'alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid' },
  ]

  /** Allarga l'anno attivo attorno a oggi, perché le date relative ci stiano qualunque sia il giorno della prova. Dentro `rollback`. */
  const giorni = async () => {
    await d.query(
      `UPDATE public.anni_sede
          SET inizio = least(inizio, public.giorno_roma(now()) - 30), fine = greatest(fine, public.giorno_roma(now()) + 30)
        WHERE id = $1`, [ANNO_ATTIVO])
    const r = await d.query<{ oggi: string; ieri: string; domani: string }>(
      `SELECT public.giorno_roma(now())::text AS oggi, (public.giorno_roma(now()) - 1)::text AS ieri,
              (public.giorno_roma(now()) + 1)::text AS domani`)
    return r.rows[0]
  }
  const frequenza = (alunno: string, annoSede: string, sezione: string | null, stato = 'iscritto', ingresso = '2026-09-01', uscita: string | null = null) =>
    d.query(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, stato, data_ingresso, data_uscita, origine)
       VALUES ($1, $2, $3, $4, $5, $6, 'recupero')`, [alunno, annoSede, sezione, stato, ingresso, uscita])
  const foto = async (sede: string, tag: string[]) =>
    (await d.query<{ id: string }>(
      `INSERT INTO public.galleria_media_v2 (scuola_id, tag_students, created_at) VALUES ($1, $2, '2026-10-20T12:00:00+02:00') RETURNING id`,
      [sede, tag])).rows[0].id

  beforeAll(async () => {
    d = await creaDbAnnoPr2({ sedi: [S, S_B], fino: 'M44a', codaPrima: SCHEMA_GALLERIA_GENITORE })
    await d.exec(SCHEMA_LEGAMI_GENITORE)
    await d.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)

    const anni = await d.query<{ anno_inizio: number; id: string; anno_id: string; scuola_id: string }>(
      `SELECT y.anno_inizio, s.id, s.anno_id, s.scuola_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
    const anno = (sede: string, n: number) => anni.rows.find((x) => x.scuola_id === sede && x.anno_inizio === n)!
    ANNO_PRIMA = anno(S, 2025).id
    ANNO_ATTIVO = anno(S, 2026).id
    ANNO_DOPO = anno(S, 2027).id
    ATTIVO_B = anno(S_B, 2026).id
    PRIMA_B = anno(S_B, 2025).id
    await d.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, 'Girasoli', $3)`, [SEZ, S, anno(S, 2026).anno_id])
    await d.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id) VALUES ($1, $2, 'Tulipani', $3)`, [SEZ_B, S_B, anno(S_B, 2026).anno_id])

    // Le frequenze le scrive la prova: lo specchio, che ne farebbe nascere una per ogni alunno nuovo, resta spento per gli alunni.
    await d.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    for (const id of [VIVO, RITIRATO, ALTROVE, SENZA]) await d.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [id, S])
    await d.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)

    await frequenza(VIVO, ANNO_ATTIVO, SEZ)
    // Senza data di uscita: lo tiene fuori lo stato e basta, quindi una funzione vera che perde quel filtro fa salire la riga.
    await frequenza(RITIRATO, ANNO_ATTIVO, SEZ, 'ritirato')
    await frequenza(ALTROVE, ANNO_ATTIVO, SEZ, 'ritirato', '2026-09-01', '2026-10-01')
    await frequenza(ALTROVE, ATTIVO_B, SEZ_B, 'iscritto', '2026-09-01')

    const legami: Array<[string, string]> = [
      [GEN_VIVO, VIVO], [GEN_MISTO, VIVO], [GEN_MISTO, RITIRATO], [GEN_RITIRATO, RITIRATO],
      [GEN_ALTROVE, ALTROVE], [GEN_SENZA, SENZA], [DOC_GENITORE, RITIRATO],
    ]
    for (const [g, a] of legami) await d.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [g, a])
    const ponti: Array<[string, string | null, string]> = [
      [SCHEDA_PONTE, GEN_PONTE, RITIRATO], [SCHEDA_PONTE_VIVO, GEN_PONTE_VIVO, VIVO], [SCHEDA_SENZA_ACCOUNT, null, RITIRATO],
    ]
    for (const [scheda, account, figlio] of ponti) {
      await d.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ($1, $2)`, [scheda, account])
      await d.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2)`, [figlio, scheda])
    }

    await foto(S, [VIVO])
    await foto(S, [RITIRATO])
    await foto(S, [VIVO, RITIRATO])
    await foto(S, [ALTROVE])
    await foto(S_B, [ALTROVE])
    await foto(S, [SENZA])

    await d.query(
      `INSERT INTO public.avvisi (scuola_id, target_scope, target_section_ids, scadenza_avviso, created_at)
       VALUES ($1, 'globale', NULL, now() + interval '1 day', '2026-10-20T12:00:00+02:00'),
              ($1, 'classi', $2, now() + interval '1 day', '2026-10-20T12:00:00+02:00')`, [S, [SEZ]])

    for (const [docente, genitore, figlio] of [[DOC, GEN_VIVO, VIVO], [DOC, GEN_MISTO, VIVO], [DOC, GEN_MISTO, RITIRATO], [DOC, GEN_RITIRATO, RITIRATO]]) {
      await d.query(`INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3)`, [docente, genitore, figlio])
    }
    THREAD_DA_DOCENTE = (await d.query<{ id: string }>(
      `INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3) RETURNING id`, [DOC_GENITORE, GEN_RITIRATO, RITIRATO])).rows[0].id
  }, 120_000)
  afterAll(async () => { await d.close() })

  prova('la riga 7 passa: nessun genitore vede righe tramite un figlio non attivo', async () => {
    expect(await riga7()).toEqual(ZERO)
    // Non è un banco vuoto: il genitore con un figlio vivo e uno ritirato vede foto, avvisi e thread, ma solo dal figlio vivo.
    const coppie = await coppieFoto(GEN_MISTO)
    expect(coppie).toHaveLength(2)
    expect(new Set(coppie.map((x) => x.alunno_id))).toEqual(new Set([VIVO]))
    const avvisi = await d.query<{ alunno_id: string }>(`SELECT alunno_id FROM public.avvisi_visibili_genitore($1)`, [GEN_MISTO])
    expect(avvisi.rows.map((x) => x.alunno_id)).toEqual([VIVO, VIVO])
    expect((await d.query(`SELECT 1 FROM public.thread_visibili($1)`, [GEN_MISTO])).rows).toHaveLength(1)
  })

  prova('la riga 7 va rossa se media_visibili_genitore perde il filtro sul figlio attivo', async () => {
    await rollback(async () => {
      await fotoSenzaFiltro()
      expect(await riga7()).toEqual({ ...ZERO, galleria_media_v2: FOTO_NON_ATTIVI })
    })
    expect(await riga7()).toEqual(ZERO)
  })

  prova('la riga 7 non è tautologica: coincide con un conteggio fatto a parte dal catalogo', async () => {
    await rollback(async () => {
      await fotoSenzaFiltro()
      // Legami per le due strade ⨝ figli senza una frequenza viva ⨝ tag. L'anno attivo lo dice `anni_sede.stato`, non `anno_attivo`.
      const dalCatalogo = await d.query<{ n: string }>(
        `WITH legami AS (
           SELECT l.genitore_id AS genitore, l.alunno_id AS figlio FROM public.legame_genitori_alunni l
           UNION
           SELECT p.auth_user_id, sp.student_id FROM public.parents p JOIN public.student_parents sp ON sp.parent_id = p.id
            WHERE p.auth_user_id IS NOT NULL
         )
         SELECT count(*)::text n
           FROM legami l
           JOIN public.galleria_media_v2 m ON m.tag_students @> ARRAY[l.figlio] AND m.eliminato_il IS NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM public.frequenze f
              JOIN public.anni_sede a ON a.id = f.anno_sede_id
             WHERE f.alunno_id = l.figlio
               AND f.stato IN ('in_attesa', 'iscritto')
               AND a.stato = 'corrente'
               AND f.data_ingresso <= public.giorno_roma(now())
               AND (f.data_uscita IS NULL OR f.data_uscita >= public.giorno_roma(now())))`)
      expect(Number(dalCatalogo.rows[0].n)).toBe(FOTO_NON_ATTIVI)
      expect((await riga7()).galleria_media_v2).toBe(Number(dalCatalogo.rows[0].n))
    })
  })

  prova('va rossa anche se perdono il filtro gli avvisi', async () => {
    await rollback(async () => {
      await avvisiSenzaFiltro()
      // Due avvisi per il ritirato di quattro genitori e per il figlio senza frequenza del quinto.
      expect(await riga7()).toEqual({ ...ZERO, avvisi: 10 })
    })
  })

  prova('va rossa anche se perdono il filtro i thread, e il thread da docente non conta nemmeno lì', async () => {
    await rollback(async () => {
      await threadSenzaFiltro()
      // I tre di chi è genitore: `DOC, GEN_MISTO`, `DOC, GEN_RITIRATO`, `DOC_GENITORE, GEN_RITIRATO`. Per `DOC_GENITORE` è da docente.
      expect(await riga7()).toEqual({ ...ZERO, chat_threads: 3 })
    })
  })

  prova('se perde il filtro la frequenza attiva salgono tutte le righe, e `figli_attivi` mostra le frequenze non vive', async () => {
    await rollback(async () => {
      await frequenzeSenzaFiltro()
      const r = await riga7()
      for (const tabella of Object.keys(ZERO)) expect(r[tabella], tabella).toBeGreaterThanOrEqual(1)
      expect(Object.keys(r).sort()).toEqual(Object.keys(ZERO).sort())
      // Il ritirato per quattro genitori: `SENZA` non ha frequenze da mostrare.
      expect(r.frequenze).toBe(4)
    })
  })

  prova('un figlio attivo in una sede e non nell’altra non fa diventare rossa la riga', async () => {
    const r = await d.query<{ stato: string }>(`SELECT stato::text FROM public.frequenze WHERE alunno_id = $1 ORDER BY stato`, [ALTROVE])
    expect(r.rows.map((x) => x.stato)).toEqual(['iscritto', 'ritirato'])
    // È il caso che mette alla prova: vede la foto della sede dove è vivo, attraverso un figlio con una frequenza non viva.
    const coppie = await coppieFoto(GEN_ALTROVE)
    expect(coppie.map((x) => x.alunno_id)).toEqual([ALTROVE])
    expect(await riga7()).toEqual(ZERO)
    // E il genitore non viene nemmeno guardato: con le foto rotte la sua foto dell'altra sede non si conta.
    await rollback(async () => {
      await fotoSenzaFiltro()
      expect(await coppieFoto(GEN_ALTROVE)).toHaveLength(2)
      expect((await riga7()).galleria_media_v2).toBe(FOTO_NON_ATTIVI)
    })
  })

  for (const { nome, firma, colonne } of GUASTABILI) {
    prova(`${nome} guasta non dà verde, e le altre invarianti arrivano lo stesso`, async () => {
      await rollback(async () => {
        await d.exec(`
          CREATE OR REPLACE FUNCTION public.${firma} RETURNS TABLE (${colonne}) LANGUAGE plpgsql ${QUALITA}
          AS $$ BEGIN RAISE EXCEPTION 'guasto di prova'; END $$`)
        expect(await riga7()).toEqual({ ...ZERO, '(controllo fallito: P0001)': CON_FIGLIO_NON_ATTIVO.length })
        const altre = await d.query(`SELECT 1 FROM public.anno_invarianti() WHERE invariante = '1'`)
        expect(altre.rows).toHaveLength(1)
        const sopra = await d.query(`SELECT 1 FROM public.anno_invarianti() WHERE righe <> 0 AND invariante = '7'`)
        expect(sopra.rows).toHaveLength(1)
      })
    })
  }

  prova('una funzione che non c’è più non dà verde: la riga dice il codice', async () => {
    await rollback(async () => {
      await d.exec(`ALTER FUNCTION public.avvisi_visibili_genitore(uuid) RENAME TO avvisi_altrove`)
      expect(await riga7()).toEqual({ ...ZERO, '(controllo fallito: 42883)': CON_FIGLIO_NON_ATTIVO.length })
    })
  })

  prova('senza nessun figlio non attivo la riga è a zero, e una funzione rotta non dà verde lo stesso', async () => {
    const senzaNonAttivi = async () => {
      await d.query(`DELETE FROM public.legame_genitori_alunni WHERE alunno_id = ANY ($1::uuid[])`, [[RITIRATO, SENZA]])
      await d.query(`DELETE FROM public.student_parents WHERE student_id = $1`, [RITIRATO])
    }
    await rollback(async () => {
      await senzaNonAttivi()
      expect(await riga7()).toEqual(ZERO)
    })
    for (const { nome, firma, colonne } of GUASTABILI) {
      await rollback(async () => {
        await senzaNonAttivi()
        await d.exec(`
          CREATE OR REPLACE FUNCTION public.${firma} RETURNS TABLE (${colonne}) LANGUAGE plpgsql ${QUALITA}
          AS $$ BEGIN RAISE EXCEPTION 'guasto di prova'; END $$`)
        expect(await riga7(), nome).toEqual({ ...ZERO, '(controllo fallito: P0001)': 1 })
      })
    }
    await rollback(async () => {
      await senzaNonAttivi()
      await d.exec(`ALTER FUNCTION public.media_visibili_genitore(uuid) RENAME TO media_altrove`)
      expect(await riga7()).toEqual({ ...ZERO, '(controllo fallito: 42883)': 1 })
    })
  })

  prova('un guasto su un genitore non nasconde ciò che si vede dagli altri', async () => {
    await rollback(async () => {
      await d.exec(`
        CREATE OR REPLACE FUNCTION public.media_visibili_genitore(p_utente uuid)
        RETURNS TABLE (media_id uuid, alunno_id uuid) LANGUAGE plpgsql ${QUALITA}
        AS $$ BEGIN
          IF p_utente = '${GEN_RITIRATO}' THEN RAISE EXCEPTION 'guasto di prova'; END IF;
          RETURN QUERY ${FOTO_SENZA_FILTRO};
        END $$`)
      expect(await riga7()).toEqual({ ...ZERO, galleria_media_v2: FOTO_NON_ATTIVI - 2, '(controllo fallito: P0001)': 1 })
    })
  })

  prova('parte dai soli genitori con un figlio non attivo: gli altri non costano una chiamata', async () => {
    await rollback(async () => {
      await d.exec(`
        CREATE OR REPLACE FUNCTION public.media_visibili_genitore(p_utente uuid)
        RETURNS TABLE (media_id uuid, alunno_id uuid) LANGUAGE plpgsql ${QUALITA}
        AS $$ BEGIN RAISE NOTICE 'chiamata %', p_utente; END $$`)
      const chiamati: string[] = []
      await d.query(`SELECT 1 FROM public.anno_invarianti()`, [], {
        onNotice: (n) => { if (n.message?.startsWith('chiamata ')) chiamati.push(n.message.slice('chiamata '.length)) },
      })
      expect(chiamati.sort()).toEqual(CON_FIGLIO_NON_ATTIVO)
    })
  })

  prova('il genitore legato al figlio solo dalla strada anagrafica viene guardato', async () => {
    await rollback(async () => {
      await d.query(`DELETE FROM public.legame_genitori_alunni WHERE alunno_id = $1`, [RITIRATO])
      await fotoSenzaFiltro()
      // Restano il genitore dalla strada anagrafica, due foto, e la foto di `SENZA`.
      expect((await riga7()).galleria_media_v2).toBe(3)
    })
  })

  prova('un figlio legato per tutte e due le strade non conta due volte', async () => {
    await rollback(async () => {
      await d.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2)`, [GEN_PONTE, RITIRATO])
      await fotoSenzaFiltro()
      expect((await riga7()).galleria_media_v2).toBe(FOTO_NON_ATTIVI)
    })
  })

  prova('un bambino vivo in due sedi con anni attivi diversi dà due righe in figli_attivi, e la riga resta a zero', async () => {
    await rollback(async () => {
      // La seconda sede non è ancora passata al 2026/27: il suo anno attivo è il 2025/26, e `frequenze_una_viva_per_anno` non lo vieta.
      await d.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE id = $1`, [ATTIVO_B])
      await frequenza(VIVO, PRIMA_B, null, 'iscritto', '2025-09-01')
      // `GEN_MISTO` è fra quelli che la riga guarda: ha anche il figlio ritirato.
      const righe = await d.query(`SELECT 1 FROM public.figli_attivi($1) WHERE alunno_id = $2`, [GEN_MISTO, VIVO])
      expect(righe.rows).toHaveLength(2)
      expect(await riga7()).toEqual(ZERO)
    })
  })

  const CHE_FREQUENZA: Array<{ nome: string; attivo: boolean; crea: (g: { oggi: string; ieri: string; domani: string }) => Promise<unknown> }> = [
    { nome: 'iscritto da oggi', attivo: true, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'iscritto', g.oggi) },
    { nome: 'in attesa, entrato oggi', attivo: true, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'in_attesa', g.oggi) },
    { nome: 'iscritto, esce oggi', attivo: true, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'iscritto', g.ieri, g.oggi) },
    { nome: 'ingresso domani', attivo: false, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'in_attesa', g.domani) },
    { nome: 'uscito ieri', attivo: false, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'iscritto', g.ieri, g.ieri) },
    { nome: 'ritirato senza data di uscita', attivo: false, crea: (g) => frequenza(SENZA, ANNO_ATTIVO, SEZ, 'ritirato', g.ieri) },
    { nome: 'solo nell’anno che non è ancora iniziato', attivo: false, crea: () => frequenza(SENZA, ANNO_DOPO, null, 'in_attesa', '2027-09-01') },
    // Qui lo stato e le date lo lascerebbero dentro: lo tiene fuori solo l'anno.
    { nome: 'iscritto solo nell’anno chiuso, senza uscita', attivo: false, crea: () => frequenza(SENZA, ANNO_PRIMA, null, 'iscritto', '2025-09-01') },
  ]
  for (const { nome, attivo, crea } of CHE_FREQUENZA) {
    prova(`un figlio con una frequenza così (${nome}) ${attivo ? 'è attivo' : 'non è attivo'} per la riga`, async () => {
      await rollback(async () => {
        await crea(await giorni())
        await fotoSenzaFiltro()
        // Attivo, la sua foto esce dal conteggio; non attivo, resta dentro.
        expect((await riga7()).galleria_media_v2).toBe(attivo ? FOTO_NON_ATTIVI - 1 : FOTO_NON_ATTIVI)
      })
    })
  }

  prova('il docente non entra: il suo thread da docente su un figlio ritirato lo vede sempre, e non conta', async () => {
    const vede = await d.query<{ thread_id: string }>(`SELECT thread_id FROM public.thread_visibili($1)`, [DOC_GENITORE])
    expect(vede.rows.map((x) => x.thread_id)).toEqual([THREAD_DA_DOCENTE])
    expect((await riga7()).chat_threads).toBe(0)
  })

  prova('le voci non entrano: la voce aperta di un ritirato resta visibile, e la riga resta a zero', async () => {
    await rollback(async () => {
      const voce = (await d.query<{ id: string }>(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, stato, importo_pagato, periodo_competenza)
         VALUES ($1, $2, 'Voce di prova', 100, '2026-10-01', 'da_pagare', 0, '2026-10-01') RETURNING id`, [RITIRATO, S])).rows[0].id
      const vede = await d.query<{ voce_id: string }>(`SELECT voce_id FROM public.voci_visibili_genitore($1)`, [GEN_RITIRATO])
      expect(vede.rows.map((x) => x.voce_id)).toEqual([voce])
      expect(await riga7()).toEqual(ZERO)
    })
  })

  prova('la copia nel file di riferimento si lancia e dice quello che dice la funzione', async () => {
    const testo = readFileSync(join(process.cwd(), 'docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql'), 'utf8')
    const copia = testo.slice(testo.indexOf('-- 7. Nessun genitore'), testo.indexOf('-- 8. Nessun docente'))
    expect((await d.query(copia)).rows).toEqual([])
    await rollback(async () => {
      await frequenzeSenzaFiltro()
      const trovate = (await d.query<{ oggetto: string }>(copia)).rows
      const quante = (oggetto: string) => trovate.filter((x) => x.oggetto === oggetto).length
      expect({
        galleria_media_v2: quante('foto'), avvisi: quante('avviso'), chat_threads: quante('thread'), frequenze: quante('frequenza'),
      }).toEqual(await riga7())
      expect(trovate.length).toBeGreaterThanOrEqual(4)
    })
  })

  prova('dove i legami o i thread non ci sono la riga c’è lo stesso, a zero', async () => {
    await rollback(async () => {
      await d.exec(`ALTER TABLE public.chat_threads RENAME TO chat_threads_altrove`)
      expect(await riga7()).toEqual(ZERO)
    })
    await rollback(async () => {
      await d.exec(`ALTER TABLE public.legame_genitori_alunni RENAME TO legami_altrove`)
      expect(await riga7()).toEqual(ZERO)
    })
    await rollback(async () => {
      await d.exec(`ALTER TABLE public.student_parents RENAME TO ponte_altrove`)
      expect(await riga7()).toEqual(ZERO)
    })
  })
})
