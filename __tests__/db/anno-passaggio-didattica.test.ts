import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DOCENTE_1, DOCENTE_2, SEDE_E2E, UTENTE, creaBancoPassaggio, errore, inRollback, una, type BancoPassaggio } from '../helpers/passaggio-banco'

/**
 * COMPITO 4.8.2 · M48c, la didattica della classe nuova. Le cinque tabelle che seguono la sezione per `section_id` (materie,
 * campanelle, orario, tempo scuola, obiettivi) più le assegnazioni per materia si copiano dalla classe vecchia alla sua
 * continuazione, con le chiavi rimappate. Solo uuid inventati; nessuna data scritta qui che dipenda da oggi.
 */

let b: BancoPassaggio
beforeAll(async () => {
  b = await creaBancoPassaggio()
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})

const OBIETTIVO = '77777777-7777-4777-8777-777777777771'

interface Copia { materie: number; campanelle: number; orario: number; tempo_scuola: number; obiettivi: number; docenti_materie: number; sezioni_saltate: number }

/** Una didattica completa sulla sezione `s`: due materie, due campanelle, due ore di orario, un tempo scuola, un obiettivo, due assegnazioni. */
async function didattica(s: string, docenteOrario: string, docenteMateria: string): Promise<void> {
  const { db } = b
  const m1 = await una<string>(db, `INSERT INTO public.materie (scuola_id, section_id, nome, codice, ordine) VALUES ($1, $2, 'Italiano', 'ita', 1) RETURNING id`, [SEDE_E2E, s])
  const m2 = await una<string>(db, `INSERT INTO public.materie (scuola_id, section_id, nome, codice, ordine) VALUES ($1, $2, 'Gioco', 'gio', 2) RETURNING id`, [SEDE_E2E, s])
  const c1 = await una<string>(db, `INSERT INTO public.campanelle (section_id, giorno_settimana, ordine, ora_inizio, ora_fine) VALUES ($1, 1, 1, '08:00', '09:00') RETURNING id`, [s])
  const c2 = await una<string>(db, `INSERT INTO public.campanelle (section_id, giorno_settimana, ordine, ora_inizio, ora_fine) VALUES ($1, 1, 2, '09:00', '10:00') RETURNING id`, [s])
  await db.query(`INSERT INTO public.orario_settimanale (section_id, campanella_id, giorno_settimana, materia_id, docente_id) VALUES ($1, $2, 1, $3, $4), ($1, $5, 1, $6, NULL)`,
    [s, c1, m1, docenteOrario, c2, m2])
  await db.query(`INSERT INTO public.tempo_scuola (section_id, modello, giorni_settimana, attivo) VALUES ($1, 27, 5, true)`, [s])
  await db.query(`INSERT INTO public.sezione_materia_obiettivo (section_id, materia_id, obiettivo_id) VALUES ($1, $2, $3)`, [s, m1, OBIETTIVO])
  await db.query(`INSERT INTO public.utenti_sezioni_materie (utente_id, section_id, materia_id, e_contitolare) VALUES ($1, $2, $3, false), ($1, $2, $4, true)`, [docenteMateria, s, m1, m2])
}

async function anteprima(): Promise<string> {
  return (await una<{ passaggio_id: string }>(b.db, `SELECT public.passaggio_anteprima($1::uuid, $2::uuid, $3::uuid)`, [b.da, b.a, UTENTE])).passaggio_id
}
const copia = (p: string) => una<Copia>(b.db, `SELECT public.passaggio_copia_didattica($1::uuid)`, [p])
const conta = async (tabella: string, s: string) => una<number>(b.db, `SELECT count(*)::int FROM public.${tabella} WHERE section_id = $1`, [s])

describe('passaggio_copia_didattica', () => {
  it('materie, campanelle, orario, tempo scuola, obiettivi e assegnazioni arrivano nella continuazione, con le chiavi rimappate', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_1)
      const p = await anteprima()
      const r = await copia(p)
      expect(r).toEqual({ materie: 2, campanelle: 2, orario: 2, tempo_scuola: 1, obiettivi: 1, docenti_materie: 2, sezioni_saltate: 1 })

      const n = b.sezioni.girasoliNuova
      for (const t of ['materie', 'campanelle', 'orario_settimanale', 'tempo_scuola', 'sezione_materia_obiettivo', 'utenti_sezioni_materie']) {
        expect(await conta(t, n), t).toBeGreaterThan(0)
      }
      // nessuna riga della sezione nuova punta a una materia o a una campanella della sezione vecchia
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.orario_settimanale o JOIN public.campanelle c ON c.id = o.campanella_id WHERE o.section_id = $1 AND c.section_id <> $1`, [n])).toBe(0)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.orario_settimanale o JOIN public.materie m ON m.id = o.materia_id WHERE o.section_id = $1 AND m.section_id <> $1`, [n])).toBe(0)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.sezione_materia_obiettivo o JOIN public.materie m ON m.id = o.materia_id WHERE o.section_id = $1 AND m.section_id <> $1`, [n])).toBe(0)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.utenti_sezioni_materie o JOIN public.materie m ON m.id = o.materia_id WHERE o.section_id = $1 AND m.section_id <> $1`, [n])).toBe(0)
      // il contenuto è lo stesso: l'ora di italiano è rimasta italiano, con il suo docente
      const ora = await b.db.query<{ codice: string; docente_id: string | null; ora_inizio: string }>(
        `SELECT m.codice, o.docente_id, c.ora_inizio::text FROM public.orario_settimanale o
           JOIN public.campanelle c ON c.id = o.campanella_id JOIN public.materie m ON m.id = o.materia_id
          WHERE o.section_id = $1 ORDER BY c.ordine`, [n])
      expect(ora.rows).toEqual([
        { codice: 'ita', docente_id: DOCENTE_1, ora_inizio: '08:00:00' },
        { codice: 'gio', docente_id: null, ora_inizio: '09:00:00' },
      ])
      expect(await una<number>(b.db, `SELECT modello FROM public.tempo_scuola WHERE section_id = $1`, [n])).toBe(27)
      expect(await una<string>(b.db, `SELECT obiettivo_id::text FROM public.sezione_materia_obiettivo WHERE section_id = $1`, [n])).toBe(OBIETTIVO)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.utenti_sezioni_materie WHERE section_id = $1 AND e_contitolare`, [n])).toBe(1)
    })
  })

  it('rifatta, non duplica niente', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_1)
      const p = await anteprima()
      await copia(p)
      const prima = await Promise.all(['materie', 'campanelle', 'orario_settimanale', 'tempo_scuola', 'sezione_materia_obiettivo', 'utenti_sezioni_materie'].map((t) => conta(t, b.sezioni.girasoliNuova)))
      const due = await copia(p)
      expect(due).toEqual({ materie: 0, campanelle: 0, orario: 0, tempo_scuola: 0, obiettivi: 0, docenti_materie: 0, sezioni_saltate: 1 })
      const dopo = await Promise.all(['materie', 'campanelle', 'orario_settimanale', 'tempo_scuola', 'sezione_materia_obiettivo', 'utenti_sezioni_materie'].map((t) => conta(t, b.sezioni.girasoliNuova)))
      expect(dopo).toEqual(prima)
    })
  })

  it('una tabella già riempita nella sezione nuova non si tocca; le altre sì', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_1)
      await b.db.query(`INSERT INTO public.tempo_scuola (section_id, modello, giorni_settimana, attivo) VALUES ($1, 40, 6, true)`, [b.sezioni.girasoliNuova])
      await b.db.query(`INSERT INTO public.materie (scuola_id, section_id, nome, codice, ordine) VALUES ($1, $2, 'Propria', 'pro', 1)`, [SEDE_E2E, b.sezioni.girasoliNuova])
      const r = await copia(await anteprima())
      expect(r.tempo_scuola).toBe(0)
      expect(r.materie).toBe(0)
      expect(r.campanelle).toBe(2)
      expect(await una<number>(b.db, `SELECT modello FROM public.tempo_scuola WHERE section_id = $1`, [b.sezioni.girasoliNuova]), 'il tempo scuola già scelto resta').toBe(40)
      expect(await conta('materie', b.sezioni.girasoliNuova), 'mai un’unione di materie').toBe(1)
      // le materie della classe nuova sono diverse: l'orario si copia ma le ore restano senza materia (nessuna chiave verso la vecchia)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.orario_settimanale WHERE section_id = $1 AND materia_id IS NULL`, [b.sezioni.girasoliNuova])).toBe(2)
    })
  })

  it('il docente “tolto” non compare né nell’orario (resta NULL) né nelle assegnazioni per materia', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_1)
      const p = await anteprima()
      await b.db.query(`SELECT public.passaggio_docente_imposta($1::uuid, $2::uuid, $3::uuid, 'tolta', $4::uuid)`, [p, DOCENTE_1, b.sezioni.girasoliNuova, UTENTE])
      const r = await copia(p)
      expect(r.docenti_materie).toBe(0)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.utenti_sezioni_materie WHERE section_id = $1`, [b.sezioni.girasoliNuova])).toBe(0)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.orario_settimanale WHERE section_id = $1 AND docente_id IS NOT NULL`, [b.sezioni.girasoliNuova])).toBe(0)
      expect(await conta('orario_settimanale', b.sezioni.girasoliNuova), 'l’ora resta, senza docente').toBe(2)
    })
  })

  it('un altro docente della stessa classe resta, anche se uno è stato tolto', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_2)
      const p = await anteprima()
      await b.db.query(`SELECT public.passaggio_docente_imposta($1::uuid, $2::uuid, $3::uuid, 'tolta', $4::uuid)`, [p, DOCENTE_1, b.sezioni.girasoliNuova, UTENTE])
      const r = await copia(p)
      expect(r.docenti_materie).toBe(2)
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.utenti_sezioni_materie WHERE section_id = $1 AND utente_id = $2`, [b.sezioni.girasoliNuova, DOCENTE_2])).toBe(2)
    })
  })

  it('una sezione senza continuazione è saltata e contata, e non lascia niente altrove', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.stelline, DOCENTE_1, DOCENTE_1)
      const r = await copia(await anteprima())
      expect(r).toEqual({ materie: 0, campanelle: 0, orario: 0, tempo_scuola: 0, obiettivi: 0, docenti_materie: 0, sezioni_saltate: 1 })
      expect(await una<number>(b.db, `SELECT count(*)::int FROM public.materie WHERE section_id <> $1`, [b.sezioni.stelline])).toBe(0)
    })
  })

  it('le tabelle della sezione vecchia sono identiche prima e dopo', async () => {
    await inRollback(b.db, async () => {
      await didattica(b.sezioni.girasoli, DOCENTE_1, DOCENTE_1)
      const foto = async () => JSON.stringify([
        (await b.db.query(`SELECT * FROM public.materie WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
        (await b.db.query(`SELECT * FROM public.campanelle WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
        (await b.db.query(`SELECT * FROM public.orario_settimanale WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
        (await b.db.query(`SELECT * FROM public.tempo_scuola WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
        (await b.db.query(`SELECT * FROM public.sezione_materia_obiettivo WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
        (await b.db.query(`SELECT * FROM public.utenti_sezioni_materie WHERE section_id = $1 ORDER BY id`, [b.sezioni.girasoli])).rows,
      ])
      const prima = await foto()
      await copia(await anteprima())
      expect(await foto()).toBe(prima)
    })
  })

  it('un passaggio che non c’è → PASSAGGIO_NON_TROVATO; annullato → PASSAGGIO_NON_MODIFICABILE', async () => {
    await inRollback(b.db, async () => {
      expect(await errore(b.db, `SELECT public.passaggio_copia_didattica($1::uuid)`, ['00000000-0000-4000-8000-00000000dead'])).toBe('PASSAGGIO_NON_TROVATO')
      const p = await anteprima()
      await b.db.query(`UPDATE public.passaggi_anno SET stato = 'annullato', annullato_il = now() WHERE id = $1`, [p])
      expect(await errore(b.db, `SELECT public.passaggio_copia_didattica($1::uuid)`, [p])).toBe('PASSAGGIO_NON_MODIFICABILE')
    })
  })

  it('la funzione è chiusa al pubblico e aperta solo al service_role', async () => {
    const r = await b.db.query<{ a: boolean; s: boolean }>(
      `SELECT has_function_privilege('anon', 'public.passaggio_copia_didattica(uuid)', 'EXECUTE') AS a,
              has_function_privilege('service_role', 'public.passaggio_copia_didattica(uuid)', 'EXECUTE') AS s`)
    expect(r.rows[0]).toEqual({ a: false, s: true })
  })
})
