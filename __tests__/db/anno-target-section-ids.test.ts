import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, fissaCalendarioAnni } from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.3 · I NOMI DI CLASSE → UUID DI SEZIONE (migrazione M1: colonne, `anno_traduci_classi_trg`,
 * `anno_target_divergenti`, invariante 13 di V2).
 *
 * Sei tabelle: `avvisi`, `galleria_media_v2`, `news_posts`, `forms_templates` (`target_classes`), `video_intents`
 * (`classi_destinatarie`) e `mensa_class_menu_assignment` (`classe` → `section_id`). I NOMI vincono (fino alla PR 4.4
 * sono la fonte); si traduce solo sull'anno ATTIVO della sede; un nome che nessuna sezione ha resta nei nomi e c'è
 * un `warn` che dice quanti, MAI quali. Date FISSE (2025/26-2027/28); solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const FINTO = '99999999-9999-4999-8999-999999999999'
const GIORNO = '2026-10-05'

const ARRAY_TABELLE = [
  { t: 'avvisi', src: 'target_classes', dst: 'target_section_ids', extra: true },
  { t: 'galleria_media_v2', src: 'target_classes', dst: 'target_section_ids', extra: true },
  { t: 'news_posts', src: 'target_classes', dst: 'target_section_ids', extra: false },
  { t: 'forms_templates', src: 'target_classes', dst: 'target_section_ids', extra: false },
  { t: 'video_intents', src: 'classi_destinatarie', dst: 'classi_destinatarie_section_ids', extra: true },
] as const
const TUTTE = [...ARRAY_TABELLE.map((x) => x.t), 'mensa_class_menu_assignment']

let db: PGlite
let GIRASOLI: string     // S1, 2026/27
let MARGHERITE: string   // S1, 2026/27
let GIRASOLI_2728: string

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
/** INSERT con i nomi (e, se date, gli uuid) e ritorna gli uuid scritti dal trigger. */
async function inserisci(t: (typeof ARRAY_TABELLE)[number], nomi: string[] | null, ids?: string[] | null, sede: string | null = S1) {
  const colonne = ['scuola_id', t.src]
  const valori: unknown[] = [sede, nomi]
  if (ids !== undefined) { colonne.push(t.dst); valori.push(ids) }
  if (t.extra) { colonne.push('giorno_competenza'); valori.push(GIORNO) }
  const segnaposto = valori.map((_, i) => `$${i + 1}${i === 1 ? '::text[]' : i === 2 && ids !== undefined ? '::uuid[]' : ''}`)
  const r = await db.query<{ id: string; ids: string[] | null }>(
    `INSERT INTO public.${t.t} (${colonne.join(', ')}) VALUES (${segnaposto.join(', ')}) RETURNING id, ${t.dst} AS ids`, valori)
  return r.rows[0]
}
async function avvisiLog(): Promise<Array<{ livello: string; contesto: Record<string, unknown>; messaggio: string }>> {
  const r = await db.query<{ livello: string; contesto: Record<string, unknown>; messaggio: string }>(
    `SELECT livello, contesto, messaggio FROM public.app_log WHERE evento = 'anno-scolastico' ORDER BY id`)
  return r.rows
}
async function divergenti(): Promise<Record<string, number>> {
  const r = await db.query<{ tabella: string; righe: string }>(`SELECT tabella, righe::text FROM public.anno_target_divergenti()`)
  return Object.fromEntries(r.rows.map((x) => [x.tabella, Number(x.righe)]))
}

beforeAll(async () => {
  // Fino a M44a e non fino a V2: `anno_traduci_classi_trg` nasce in M1 e lì è ridefinito. Una prova sulla definizione vecchia non proverebbe niente.
  db = await creaDbAnnoPr2({ sedi: [S1, S2], fino: 'M44a', completo: true })
  const a2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  GIRASOLI = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
  MARGHERITE = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Margherite') RETURNING id`, [S1])
  GIRASOLI_2728 = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Girasoli', $2) RETURNING id`, [S1, a2728])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.app_log;
    DELETE FROM public.avvisi; DELETE FROM public.galleria_media_v2; DELETE FROM public.news_posts;
    DELETE FROM public.forms_templates; DELETE FROM public.video_intents; DELETE FROM public.mensa_class_menu_assignment;
  `)
})

describe.each(ARRAY_TABELLE)('$t · $src → $dst', (t) => {
  it('{Girasoli, Delfini} con la sola sezione Girasoli → ids {Girasoli}; Delfini resta nei nomi, con un warn senza il nome', async () => {
    const riga = await inserisci(t, ['Girasoli', 'Delfini'])
    expect(riga.ids).toEqual([GIRASOLI])
    expect(await una<string[]>(`SELECT ${t.src} FROM public.${t.t} WHERE id = $1`, [riga.id])).toEqual(['Girasoli', 'Delfini'])
    const log = await avvisiLog()
    expect(log).toHaveLength(1)
    expect(log[0].livello).toBe('warn')
    expect(log[0].contesto).toMatchObject({ esito: 'classe-non-abbinata', tabella: t.t, conteggio: 1 })
    expect(JSON.stringify(log)).not.toContain('Delfini')
    expect(JSON.stringify(log)).not.toContain('Girasoli')
  })

  it('UPDATE dei nomi → ricalcolo; UPDATE di un\'altra colonna → il trigger non scatta (gli uuid scritti a mano restano)', async () => {
    const riga = await inserisci(t, ['Girasoli'])
    expect(riga.ids).toEqual([GIRASOLI])
    await db.query(`UPDATE public.${t.t} SET ${t.src} = ARRAY['Margherite', 'Girasoli'] WHERE id = $1`, [riga.id])
    expect((await una<string[]>(`SELECT ${t.dst} FROM public.${t.t} WHERE id = $1`, [riga.id])).sort()).toEqual([GIRASOLI, MARGHERITE].sort())
    // gli uuid scritti a mano: la colonna dei nomi non è nel SET, quindi il trigger (UPDATE OF …) non gira
    await db.query(`UPDATE public.${t.t} SET ${t.dst} = ARRAY[$2]::uuid[] WHERE id = $1`, [riga.id, FINTO])
    expect(await una<string[]>(`SELECT ${t.dst} FROM public.${t.t} WHERE id = $1`, [riga.id])).toEqual([FINTO])
  })

  it('nomi NULL e ids scritti a mano → gli ids restano; nomi e ids insieme e divergenti → vincono i nomi', async () => {
    const a = await inserisci(t, null, [FINTO])
    expect(a.ids).toEqual([FINTO])
    const b = await inserisci(t, ['Girasoli'], [FINTO])
    expect(b.ids).toEqual([GIRASOLI])
  })

  describe('quando i nomi spariscono', () => {
    const uuidDi = (id: string) => una<string[] | null>(`SELECT ${t.dst} FROM public.${t.t} WHERE id = $1`, [id])

    it('nomi da un valore a NULL, uuid non toccati: anche gli uuid vanno a NULL', async () => {
      const riga = await inserisci(t, ['Girasoli'])
      expect(riga.ids).toEqual([GIRASOLI])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL WHERE id = $1`, [riga.id])
      expect(await uuidDi(riga.id)).toBeNull()
      expect((await divergenti())[t.t]).toBe(0)
    })

    it('nomi a NULL e uuid diversi nella stessa scrittura: restano quelli', async () => {
      const riga = await inserisci(t, ['Girasoli'])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL, ${t.dst} = ARRAY[$2]::uuid[] WHERE id = $1`, [riga.id, MARGHERITE])
      expect(await uuidDi(riga.id)).toEqual([MARGHERITE])
    })

    it('nomi a NULL e uuid a NULL nella stessa scrittura: NULL', async () => {
      const riga = await inserisci(t, ['Girasoli'])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL, ${t.dst} = NULL WHERE id = $1`, [riga.id])
      expect(await uuidDi(riga.id)).toBeNull()
    })

    it('nomi a NULL rimettendo gli stessi uuid: non si distingue da chi non li ha toccati, e vanno a NULL', async () => {
      const riga = await inserisci(t, ['Girasoli'])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL, ${t.dst} = ARRAY[$2]::uuid[] WHERE id = $1`, [riga.id, GIRASOLI])
      expect(await uuidDi(riga.id)).toBeNull()
    })

    it('nomi già NULL che restano NULL: gli uuid scritti a mano restano', async () => {
      const riga = await inserisci(t, null, [FINTO])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL WHERE id = $1`, [riga.id])
      expect(await uuidDi(riga.id)).toEqual([FINTO])
    })

    it('nomi vuoti: gli uuid vanno vuoti, e da vuoti a NULL anche gli uuid', async () => {
      const riga = await inserisci(t, ['Girasoli'])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = '{}' WHERE id = $1`, [riga.id])
      expect(await uuidDi(riga.id)).toEqual([])
      await db.query(`UPDATE public.${t.t} SET ${t.src} = NULL WHERE id = $1`, [riga.id])
      expect(await uuidDi(riga.id)).toBeNull()
    })

    it('un INSERT con nomi NULL non tocca gli uuid, e nessun guasto finisce nel registro', async () => {
      expect((await inserisci(t, null, [FINTO])).ids).toEqual([FINTO])
      expect(await avvisiLog()).toEqual([])
    })
  })

  it('la traduzione guarda solo l\'anno ATTIVO: con una «Girasoli» anche nel 2027/28 sceglie quella del 2026/27', async () => {
    const riga = await inserisci(t, ['girasoli'])
    expect(riga.ids).toEqual([GIRASOLI])
    expect(riga.ids).not.toContain(GIRASOLI_2728)
  })

  it('una riga senza sede non si traduce (e non dà errore)', async () => {
    if (t.t === 'news_posts' || t.t === 'forms_templates') return // scuola_id NOT NULL
    const riga = await inserisci(t, ['Girasoli'], undefined, null)
    expect(riga.ids).toBeNull()
  })
})

describe('mensa_class_menu_assignment · classe → section_id', () => {
  it('«Girasoli» → la sezione; «Delfini» → NULL e un warn senza il nome', async () => {
    const ok = await una<string | null>(
      `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe) VALUES ($1, 'Girasoli') RETURNING section_id`, [S1])
    expect(ok).toBe(GIRASOLI)
    const no = await una<string | null>(
      `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe) VALUES ($1, 'Delfini') RETURNING section_id`, [S1])
    expect(no).toBeNull()
    const log = await avvisiLog()
    expect(log).toHaveLength(1)
    expect(log[0].contesto).toMatchObject({ esito: 'classe-non-abbinata', tabella: 'mensa_class_menu_assignment', conteggio: 1 })
    expect(JSON.stringify(log)).not.toContain('Delfini')
  })

  it('un UPDATE della classe ricalcola la sezione', async () => {
    const id = await una<string>(`INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
    await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = 'Margherite' WHERE id = $1`, [id])
    expect(await una<string>(`SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [id])).toBe(MARGHERITE)
  })

  describe('quando il nome sparisce: oggi `classe` è NOT NULL, e il vincolo si toglie solo per queste prove', () => {
    const sezioneDi = (id: string) => una<string | null>(`SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [id])
    const senzaVincolo = async (fn: () => Promise<void>) => {
      await db.exec('BEGIN')
      try {
        await db.exec(`ALTER TABLE public.mensa_class_menu_assignment ALTER COLUMN classe DROP NOT NULL`)
        await fn()
      } finally {
        await db.exec('ROLLBACK')
      }
    }
    const conGirasoli = () => una<string>(
      `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe) VALUES ($1, 'Girasoli') RETURNING id`, [S1])

    it('nome a NULL, sezione non toccata: anche la sezione va a NULL', async () => {
      await senzaVincolo(async () => {
        const id = await conGirasoli()
        expect(await sezioneDi(id)).toBe(GIRASOLI)
        await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = NULL WHERE id = $1`, [id])
        expect(await sezioneDi(id)).toBeNull()
      })
    })

    it('nome a NULL e un\'altra sezione nella stessa scrittura: resta quella', async () => {
      await senzaVincolo(async () => {
        const id = await conGirasoli()
        await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = NULL, section_id = $2 WHERE id = $1`, [id, MARGHERITE])
        expect(await sezioneDi(id)).toBe(MARGHERITE)
      })
    })

    it('nome già NULL che resta NULL: la sezione scritta a mano resta', async () => {
      await senzaVincolo(async () => {
        const id = await una<string>(
          `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe, section_id) VALUES ($1, NULL, $2) RETURNING id`, [S1, MARGHERITE])
        expect(await sezioneDi(id)).toBe(MARGHERITE)
        await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = NULL WHERE id = $1`, [id])
        expect(await sezioneDi(id)).toBe(MARGHERITE)
      })
    })
  })
})

describe('la rinomina di una sezione', () => {
  it('propaga_rinomina_sezione riscrive i nomi, ma gli uuid non cambiano (la sezione ha sempre lo stesso uuid)', async () => {
    const riga = await inserisci(ARRAY_TABELLE[0], ['Margherite'])
    expect(riga.ids).toEqual([MARGHERITE])
    await db.query(`UPDATE public.sections SET name = 'Fiordalisi' WHERE id = $1`, [MARGHERITE])
    try {
      expect(await una<string[]>(`SELECT target_classes FROM public.avvisi WHERE id = $1`, [riga.id])).toEqual(['Fiordalisi'])
      expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [riga.id])).toEqual([MARGHERITE])
      expect((await divergenti()).avvisi).toBe(0)
    } finally {
      await db.query(`UPDATE public.sections SET name = 'Margherite' WHERE id = $1`, [MARGHERITE])
    }
  })
})

describe('anno_target_divergenti() e l\'invariante 13', () => {
  it('seme pulito: zero per ogni tabella (una riga per tabella che ha le due colonne)', async () => {
    await inserisci(ARRAY_TABELLE[0], ['Girasoli'])
    const d = await divergenti()
    expect(Object.keys(d).sort()).toEqual([...TUTTE].sort())
    expect(Object.values(d).reduce((n, x) => n + x, 0)).toBe(0)
  })

  it('un uuid senza nome (o un nome che nessuna sezione ha) → righe = 1 per quella tabella, e l\'invariante 13 sale', async () => {
    await inserisci(ARRAY_TABELLE[0], null, [FINTO])            // uuid senza nome
    await inserisci(ARRAY_TABELLE[2], ['Delfini'])              // nome senza uuid
    expect(await divergenti()).toMatchObject({ avvisi: 1, news_posts: 1, forms_templates: 0, video_intents: 0 })
    const inv = await db.query<{ tabella: string; righe: string }>(
      `SELECT tabella, righe::text FROM public.anno_invarianti() WHERE invariante = '13' ORDER BY tabella`)
    expect(Object.fromEntries(inv.rows.map((x) => [x.tabella, Number(x.righe)]))).toMatchObject({ avvisi: 1, news_posts: 1, forms_templates: 0 })
    expect(inv.rows.map((x) => x.tabella).sort()).toEqual([...TUTTE].sort())
  })

  it('l\'insieme degli uuid si confronta ordinato e senza doppioni', async () => {
    const riga = await inserisci(ARRAY_TABELLE[0], ['Girasoli', 'Margherite'])
    await db.query(`UPDATE public.avvisi SET target_section_ids = ARRAY[$2, $3, $2]::uuid[] WHERE id = $1`, [riga.id, MARGHERITE, GIRASOLI])
    expect((await divergenti()).avvisi).toBe(0)
  })
})

describe('dopo il passaggio d\'anno: la traduzione guarda l\'anno DELLA RIGA, non quello attivo', () => {
  // la sede S1 passa al 2027/28 (corrente); il 2026/27 diventa chiuso. In `finally` il calendario torna quello di prova.
  async function passaAl2728() {
    await db.query(`UPDATE public.anni_sede s SET stato = 'chiuso' FROM public.anni_scolastici y
                     WHERE y.id = s.anno_id AND y.anno_inizio = 2026 AND s.scuola_id = $1`, [S1])
    await db.query(`UPDATE public.anni_sede s SET stato = 'corrente' FROM public.anni_scolastici y
                     WHERE y.id = s.anno_id AND y.anno_inizio = 2027 AND s.scuola_id = $1`, [S1])
  }
  async function tornaAl2627() { await fissaCalendarioAnni(db) }

  it('un avviso del 2026/27: un UPDATE che rimanda gli stessi nomi lascia gli uuid del 2026/27 e l\'invariante 13 resta a zero', async () => {
    const riga = await inserisci(ARRAY_TABELLE[0], ['Girasoli'])
    expect(riga.ids).toEqual([GIRASOLI])
    try {
      await passaAl2728()
      expect((await divergenti()).avvisi).toBe(0)
      await db.query(`UPDATE public.avvisi SET target_classes = ARRAY['Girasoli'] WHERE id = $1`, [riga.id])
      expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [riga.id])).toEqual([GIRASOLI])
      expect(Object.values(await divergenti()).reduce((n, x) => n + x, 0)).toBe(0)
      // un INSERT nuovo (con il giorno del 2027/28) sceglie la «Girasoli» del 2027/28
      const nuovo = await db.query<{ ids: string[] }>(
        `INSERT INTO public.avvisi (scuola_id, target_classes, giorno_competenza) VALUES ($1, ARRAY['Girasoli'], DATE '2027-10-05')
         RETURNING target_section_ids AS ids`, [S1])
      expect(nuovo.rows[0].ids).toEqual([GIRASOLI_2728])
      expect((await divergenti()).avvisi).toBe(0)
    } finally { await tornaAl2627() }
  })

  it('una voce di mensa del 2026/27 (attivo_dal) segue il suo anno anche dopo il passaggio', async () => {
    const m = await una<string>(
      `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe, attivo_dal) VALUES ($1, 'Girasoli', DATE '2026-09-01') RETURNING id`, [S1])
    expect(await una<string>(`SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [m])).toBe(GIRASOLI)
    try {
      await passaAl2728()
      await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = 'Girasoli' WHERE id = $1`, [m])
      expect(await una<string>(`SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [m])).toBe(GIRASOLI)
      expect((await divergenti()).mensa_class_menu_assignment).toBe(0)
    } finally { await tornaAl2627() }
  })
})

describe('un anno senza sezioni nella sede (gli avvisi di luglio e agosto 2026 stanno nel 2025/26)', () => {
  // Data letterale ma non scadente: `creaAnniFissi` ricrea SEMPRE il calendario 2025/26 (chiuso) e 2026/27 (corrente), qualunque sia oggi.
  const ESTATE = '2026-07-10'
  /** Un avviso dell'estate: l'anno è il 2025/26, che non ha nessuna sezione; gli uuid sono quelli del 2026/27 (anno attivo). */
  async function avvisoEstivo(): Promise<string> {
    return await una<string>(
      `INSERT INTO public.avvisi (scuola_id, target_classes, giorno_competenza) VALUES ($1, ARRAY['Girasoli'], DATE '${ESTATE}') RETURNING id`, [S1])
  }

  it('il seme: l\'avviso cade nel 2025/26, che non ha sezioni, con gli uuid del 2026/27', async () => {
    const id = await avvisoEstivo()
    expect(await una<number>(`SELECT y.anno_inizio FROM public.avvisi a JOIN public.anni_scolastici y ON y.id = a.anno_id WHERE a.id = $1`, [id])).toBe(2025)
    expect(await una<number>(
      `SELECT count(*)::int FROM public.sections s JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2025`, [S1])).toBe(0)
    expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).toEqual([GIRASOLI])
  })

  it('(a) la riga di un anno senza sezioni non è divergente', async () => {
    await avvisoEstivo()
    expect((await divergenti()).avvisi).toBe(0)
  })

  it('(a) un nome senza sezione in un anno che ne HA resta divergente', async () => {
    await inserisci(ARRAY_TABELLE[0], ['Delfini'])
    expect((await divergenti()).avvisi).toBe(1)
  })

  it('(b) un UPDATE che rimanda gli stessi nomi lascia gli uuid come sono, invece di ricalcolarli', async () => {
    const id = await avvisoEstivo()
    // Uuid che la traduzione non darebbe mai: se il trigger ricalcolasse, qui si vedrebbe.
    await db.query(`UPDATE public.avvisi SET target_section_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [id, FINTO])
    await db.query(`UPDATE public.avvisi SET target_classes = ARRAY['Girasoli'] WHERE id = $1`, [id])
    expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).toEqual([FINTO])
    expect((await divergenti()).avvisi).toBe(0)
  })

  it('(b) un UPDATE che cambia i nomi traduce sull\'anno attivo, come l\'INSERT: gli uuid della classe vecchia non restano', async () => {
    const id = await avvisoEstivo()
    await db.query(`UPDATE public.avvisi SET target_classes = ARRAY['Margherite'] WHERE id = $1`, [id])
    expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).toEqual([MARGHERITE])
    await db.query(`UPDATE public.avvisi SET target_classes = ARRAY['Girasoli', 'Margherite'] WHERE id = $1`, [id])
    expect((await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).sort()).toEqual([GIRASOLI, MARGHERITE].sort())
    expect((await divergenti()).avvisi).toBe(0)
  })

  it('(b) nomi cambiati in uno che nessuna sezione ha: uuid vuoti e un warn, come l\'INSERT', async () => {
    const id = await avvisoEstivo()
    await db.query(`UPDATE public.avvisi SET target_classes = ARRAY['Delfini'] WHERE id = $1`, [id])
    expect(await una<string[]>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).toEqual([])
    const log = await avvisiLog()
    expect(log).toHaveLength(1)
    expect(log[0].contesto).toMatchObject({ esito: 'classe-non-abbinata', tabella: 'avvisi', conteggio: 1 })
  })

  it('(b) nomi a NULL: anche in un anno senza sezioni gli uuid vanno a NULL', async () => {
    const id = await avvisoEstivo()
    await db.query(`UPDATE public.avvisi SET target_classes = NULL WHERE id = $1`, [id])
    expect(await una<string[] | null>(`SELECT target_section_ids FROM public.avvisi WHERE id = $1`, [id])).toBeNull()
  })

  it('(b) la forma scalare: a nome uguale la sezione resta, a nome cambiato si traduce sull\'anno attivo', async () => {
    const id = await una<string>(
      `INSERT INTO public.mensa_class_menu_assignment (scuola_id, classe, attivo_dal) VALUES ($1, 'Girasoli', DATE '${ESTATE}') RETURNING id`, [S1])
    const sezione = () => una<string | null>(`SELECT section_id FROM public.mensa_class_menu_assignment WHERE id = $1`, [id])
    // Senza `anno_id` l'INSERT traduce sull'anno della data, che non ha sezioni. Una sezione che la traduzione non darebbe mai,
    // né su quell'anno né su quello attivo: se il trigger ricalcolasse, qui si vedrebbe.
    expect(await sezione()).toBeNull()
    await db.query(`UPDATE public.mensa_class_menu_assignment SET section_id = $2 WHERE id = $1`, [id, GIRASOLI_2728])
    await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = 'Girasoli' WHERE id = $1`, [id])
    expect(await sezione()).toBe(GIRASOLI_2728)
    await db.query(`UPDATE public.mensa_class_menu_assignment SET classe = 'Margherite' WHERE id = $1`, [id])
    expect(await sezione()).toBe(MARGHERITE)
    expect((await divergenti()).mensa_class_menu_assignment).toBe(0)
  })

  it('(c) anno_fotografa conta la riga come ambiguo:classi_in_anno_senza_sezioni:avvisi, e un avviso normale no', async () => {
    await avvisoEstivo()
    await inserisci(ARRAY_TABELLE[0], ['Girasoli'])
    await db.exec(`DELETE FROM public.riconciliazione_anno`)
    await db.query(`SELECT public.anno_fotografa('prima', ARRAY['avvisi'])`)
    const v = await una<number>(
      `SELECT coalesce(sum(valore), 0)::float8 FROM public.riconciliazione_anno WHERE fase = 'prima' AND voce = 'ambiguo:classi_in_anno_senza_sezioni:avvisi'`)
    expect(v).toBe(1)
  })
})
