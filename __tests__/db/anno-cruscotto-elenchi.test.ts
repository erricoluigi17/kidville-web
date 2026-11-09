import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { NextRequest } from 'next/server'
import {
  creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * PR 4.7 · OGNI NUMERO DEL CRUSCOTTO CHE HA UN LINK È UGUALE AL TOTALE DELL'ELENCO CHE IL LINK APRE (revisione finale, B1 e secondari 1-2).
 *
 * Route vere (`cruscotto`, `conferme`, `moduli-mancanti`) sopra il SQL vero (`anno_cruscotto`) in PGlite. Finti solo il gate, il perimetro di
 * sede e il registro degli accessi. Il seme mescola i casi che fanno divergere un numero dal suo elenco: conferme di chi frequenta, nuove
 * iscrizioni, un bambino che TORNA (riga `conferma` ma scheda `in_arrivo`, sta solo nelle «Nuove») e una `nuova` di chi frequenta già
 * (sta in tutte e due le viste). Prima della correzione i due numeri dell'incrocio aprivano «Conferme» e ne mostravano solo una parte.
 * Gli importi sono esempi, i nomi inventati, gli uuid finti.
 */

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/server-client', async (orig) => {
  const { clienteSuPglite: cliente } = await import('../helpers/supabase-su-pglite')
  return {
    ...(await orig<typeof import('@/lib/supabase/server-client')>()),
    createAdminClient: async () => {
      const c = cliente(h.db as PGlite) as unknown as { rpc: (n: string, a?: Record<string, unknown>) => Promise<unknown> }
      // Il client di prova manda un array come JSON: per `uuid[]` PostgREST lo traduce, PGlite no. Qui si fa ciò che fa PostgREST.
      const rpc = c.rpc.bind(c)
      c.rpc = (n, a = {}) => rpc(n, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? `{${v.join(',')}}` : v])))
      return c
    },
  }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: '55555555-5555-4555-8555-555555555551', role: 'admin', ruolo: 'admin' } }),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async () => ['22222222-2222-4222-8222-222222222222'],
}))
vi.mock('@/lib/primaria/fascicolo-rbac', async (orig) => ({ ...(await orig<typeof import('@/lib/primaria/fascicolo-rbac')>()), logAccessoFascicolo: vi.fn(async () => undefined) }))

import { GET as CRUSCOTTO } from '@/app/api/admin/anni/[annoSedeId]/cruscotto/route'
import { GET as CONFERME } from '@/app/api/admin/anni/[annoSedeId]/conferme/route'
import { GET as MANCANTI } from '@/app/api/admin/anni/[annoSedeId]/moduli-mancanti/route'

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '22222222-2222-4222-8222-222222222223'
const UT = '55555555-5555-4555-8555-555555555551'
const ALUNNO = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`
const P = Array.from({ length: 8 }, (_, i) => ALUNNO(i + 1)) // i bambini che frequentano nel 2026/27
const N1 = ALUNNO(21)
const N2 = ALUNNO(22)

type Cruscotto = {
  anno: { inizio: string; fine: string; stato: string }
  sezioni: Array<{ section_id: string | null; nome: string | null; fascia: string | null; iscritti: number }>
  fasce: Array<{ fascia: string; iscritti: number; posti: number | null; oltre: boolean }>
  risposte: { confermati: number; no: number; non_risposto: number; di_partenza: number }
  nuove: { totale: number }
  quota: Record<string, number>
  incrocio: Record<string, number>
  confronto: null | {
    ricostruito: boolean; giorno_anno_prima: string; anno_prima_etichetta: string
    questo_anno: { domande: number; conferme: number }; anno_prima: { domande: number; conferme: number }
  }
}

let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`
const ANNO: Record<number, string> = {} // anni_scolastici.id

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 40_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
const A27 = () => ANNO_SEDE[`${S1}:2027`]
const A26 = () => ANNO_SEDE[`${S1}:2026`]

async function alunno(id: string, stato: string, creato = '2026-05-01') {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato, creato_il) VALUES ($1, $2, $3, $4)`, [id, S1, stato, creato])
}
/** Il listino e i moduli del 2027/28 di S1, e l'apertura delle iscrizioni. */
async function apri() {
  const a = A27()
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_conferma', NULL, 100, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', NULL, 200, NULL)`, [a])
  await db.query(`SELECT public.anno_listino_quota_imposta($1, 'quota_nuova', 'nido_1', 250, NULL)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'conferma', 'privacy', 'Informativa', 1)`, [a])
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, 'nuova', 'regolamento', 'Regolamento', 1)`, [a])
  await db.query(`SELECT public.anno_apri_iscrizioni($1, $2)`, [a, UT])
}
async function sezione(nome: string, fascia: string | null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia) VALUES ($1, $2, $3, 'infanzia', $4) RETURNING id`,
    [S1, ANNO[2027], nome, fascia])
}
/** Una frequenza dell'anno prossimo scritta a mano, SENZA voce. */
async function frequenza(al: string, tipo: 'conferma' | 'nuova', sez: string | null = null, creata = '2026-11-09'): Promise<string> {
  return una<string>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, tipo, origine, stato, data_ingresso, section_id, creata_il)
     SELECT $1, s.id, $2, 'segreteria', 'in_attesa', s.inizio, $3, $5::timestamptz FROM public.anni_sede s WHERE s.id = $4 RETURNING id`,
    [al, tipo, sez, A27(), creata])
}
const categoria = () => una<string>(`SELECT id FROM public.payment_categories WHERE slug = 'iscrizione' AND is_sistema AND scuola_id IS NULL`)
/** Una voce «Iscrizione» del 2027/28 (competenza = inizio dell'anno). Non la collega a nessuna frequenza. */
async function voce(al: string, importo: number, stato: 'da_pagare' | 'parziale' | 'pagato' | 'scaduto', pagato: number, cat?: string): Promise<string> {
  return una<string>(
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, stato, importo_pagato, periodo_competenza)
     SELECT $1, $2, 'Iscrizione di prova', $3, s.inizio, $4, $5, $6, s.inizio FROM public.anni_sede s WHERE s.id = $7 RETURNING id`,
    [al, S1, importo, cat ?? (await categoria()), stato, pagato, A27()])
}
async function collega(freq: string, pagamento: string) {
  await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE id = $1`, [freq, pagamento])
}
async function spunta(freq: string, lista: 'conferma' | 'nuova') {
  await db.query(
    `INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) SELECT $1, m.id FROM public.moduli_richiesti m WHERE m.anno_sede_id = $2 AND m.lista = $3`,
    [freq, A27(), lista])
}

/**
 * Il SEME NOTO. Sei frequenze vive dell'anno nuovo e una ritirata; sette bambini che frequentano nel 2026/27.
 *   F1 conferma · sezione A (infanzia) · voce pagata 100 · moduli spuntati          → iscritto (entrambi)
 *   F2 conferma · sezione A · voce da pagare 100 · moduli spuntati                  → moduli senza quota
 *   F3 conferma · sezione B (nido_1) · voce pagata 100 · moduli NON spuntati        → quota senza moduli
 *   F4 conferma · senza sezione · nessuna voce · moduli no (creata dopo la data)    → assente, stima 100
 *   F5 nuova (N1) · sezione A · nessuna voce                                        → assente, stima 200
 *   F6 nuova (N2) · sezione B (nido_1) · nessuna voce                               → assente, stima 250 (riga nido_1)
 *   F7 conferma di P5, RITIRATA, con una voce pagata 100                            → fuori dalle vive, ma ha una voce
 * P1-P4 hanno confermato, P5 è ritirata (non conta come confermata), P6 ha detto di no, P7 e P8 non hanno risposto.
 * Posti: infanzia 2 (gli iscritti sono 3: oltre), nido_1 5.
 */
async function seme() {
  for (const [i, id] of P.entries()) await alunno(id, 'iscritto', i < 3 ? '2026-01-10' : '2026-06-01')
  await alunno(N1, 'in_arrivo')
  await alunno(N2, 'in_arrivo')
  await apri()
  const A = await sezione('Sezione A', 'infanzia')
  const B = await sezione('Sezione B', 'nido_1')
  await db.query(`INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti) VALUES ($1, 'infanzia', 2), ($1, 'nido_1', 5)`, [A27()])
  const f1 = await frequenza(P[0], 'conferma', A)
  const f2 = await frequenza(P[1], 'conferma', A)
  const f3 = await frequenza(P[2], 'conferma', B)
  const f4 = await frequenza(P[3], 'conferma', null, '2027-03-01')
  const f5 = await frequenza(N1, 'nuova', A)
  const f6 = await frequenza(N2, 'nuova', B)
  await spunta(f1, 'conferma')
  await spunta(f2, 'conferma')
  await collega(f1, await voce(P[0], 100, 'pagato', 100))
  await collega(f2, await voce(P[1], 100, 'da_pagare', 0))
  await collega(f3, await voce(P[2], 100, 'pagato', 100))
  const f7 = await frequenza(P[4], 'conferma', null)
  await collega(f7, await voce(P[4], 100, 'pagato', 100))
  await db.query(`UPDATE public.frequenze SET stato = 'ritirato' WHERE id = $1`, [f7])
  await db.query(`UPDATE public.frequenze SET non_rinnova_il = '2027-01-15T10:00:00Z', non_rinnova_motivo = 'trasloco'
                   WHERE alunno_id = $1 AND anno_sede_id = $2`, [P[5], A26()])
  return { A, B, f1, f2, f3, f4, f5, f6, f7 }
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M47', completo: true,
    codaPrima: SCHEMA_ISCRIZIONE_ANNO + `
      -- con \`completo\` il banco ha già archiviato_il e importo_retta_mensile su \`alunni\`, tipo e visibile_dal su \`pagamenti\`
      ALTER TABLE public.alunni
        ADD COLUMN anonimizzato_il timestamptz,
        ADD COLUMN creato_il timestamptz DEFAULT now(),
        ADD COLUMN nome text,
        ADD COLUMN cognome text;
      ALTER TABLE public.pagamenti
        ADD COLUMN obbligatorio boolean NOT NULL DEFAULT false,
        ADD COLUMN gruppo text,
        ADD COLUMN creato_da uuid,
        ADD COLUMN sconto numeric NOT NULL DEFAULT 0;
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


const contesto = (anno: string) => ({ params: Promise.resolve({ annoSedeId: anno }) })
const get = (percorso: string, query = '') => new NextRequest(`http://localhost/api/admin/anni/x/${percorso}${query}`)

async function giorni() {
  await db.query(
    `UPDATE public.anni_sede SET inizio = least(inizio, public.giorno_roma(now()) - 40), fine = greatest(fine, public.giorno_roma(now()) + 40) WHERE id = $1`,
    [A26()])
}
async function modulo(lista: 'conferma' | 'nuova', codice: string, titolo: string) {
  await db.query(`SELECT public.anno_modulo_richiesto_imposta($1, $2, $3, $4, 9)`, [A27(), lista, codice, titolo])
  return una<string>(`SELECT id FROM public.moduli_richiesti WHERE anno_sede_id = $1 AND codice = $2 AND lista = $3`, [A27(), codice, lista])
}
async function spuntaUno(freq: string, mod: string) {
  await db.query(`INSERT INTO public.frequenze_moduli (frequenza_id, modulo_id) VALUES ($1, $2)`, [freq, mod])
}
const totale = async (query: string): Promise<number> => {
  const r = await CONFERME(get('conferme', query), contesto(A27()))
  expect(r.status, query).toBe(200)
  return ((await r.json()) as { data: { totale: number } }).data.totale
}

/**
 * Il seme di `anno-cruscotto.test.ts` più tre casi: un bambino che TORNA (P5: frequenza `conferma` ritirata, no; qui un altro, R1,
 * `in_arrivo` con riga `conferma` viva), una `nuova` di chi frequenta già (P8) e un secondo modulo di conferma.
 */
async function scenario() {
  await giorni()
  const s = await seme()
  const R1 = ALUNNO(31)
  await alunno(R1, 'in_arrivo')
  const fR1 = await frequenza(R1, 'conferma', s.A)
  await collega(fR1, await voce(R1, 100, 'pagato', 100)) // quota saldata, moduli non spuntati → «quota senza moduli», e sta solo nelle Nuove
  const fP8 = await frequenza(P[7], 'nuova', s.A) // chi frequenta e ha una domanda nuova: in tutte e due le viste
  await spuntaUno(fP8, await una<string>(`SELECT id FROM public.moduli_richiesti WHERE anno_sede_id = $1 AND lista = 'nuova' LIMIT 1`, [A27()]))
  await collega(fP8, await voce(P[7], 200, 'da_pagare', 0)) // moduli fatti, quota no → «moduli senza quota»
  const m2 = await modulo('conferma', 'secondo_modulo', 'Secondo modulo')
  await spuntaUno(s.f1, m2) // F1 ha tutto; gli altri della lista `conferma` no
  return { ...s, R1, fR1, fP8, m2 }
}

describe('ogni numero con un link è uguale al totale della lista che il link apre', () => {
  prova('i due numeri dell’incrocio: la lista «tutte le iscrizioni dell’anno» ne dà esattamente tanti', async () => {
    await inRollback(async () => {
      h.db = db
      await scenario()
      const c = JSON.parse(JSON.stringify(((await (await CRUSCOTTO(get('cruscotto'), contesto(A27()))).json()) as { data: Cruscotto }).data)) as Cruscotto
      expect(c.incrocio.moduli_senza_quota).toBeGreaterThan(0)
      expect(c.incrocio.quota_senza_moduli).toBeGreaterThan(0)
      expect(await totale('?vista=nuove&ambito=anno&conferma=moduli_senza_quota')).toBe(c.incrocio.moduli_senza_quota)
      expect(await totale('?vista=nuove&ambito=anno&conferma=quota_senza_moduli')).toBe(c.incrocio.quota_senza_moduli)
      // e tutta la lista dell'anno è il totale delle vive
      expect(await totale('?vista=nuove&ambito=anno&conferma=tutti')).toBe(c.incrocio.totale)
    })
  })

  prova('PERCHÉ serviva: il vecchio link (vista conferme, senza ambito) perdeva i bambini delle nuove iscrizioni', async () => {
    await inRollback(async () => {
      h.db = db
      await scenario()
      const c = ((await (await CRUSCOTTO(get('cruscotto'), contesto(A27()))).json()) as { data: Cruscotto }).data
      const soloConferme = await totale('?conferma=quota_senza_moduli')
      expect(soloConferme).toBeLessThan(c.incrocio.quota_senza_moduli)
    })
  })

  prova('il numero per modulo di «moduli-mancanti» è uguale alla lista filtrata per quel modulo, compreso chi torna', async () => {
    await inRollback(async () => {
      h.db = db
      await scenario()
      const r = await MANCANTI(get('moduli-mancanti'), contesto(A27()))
      const moduli = ((await r.json()) as { data: { moduli: Array<{ modulo_id: string; codice: string; mancanti: number }> } }).data.moduli
      expect(moduli.length).toBeGreaterThanOrEqual(3)
      for (const m of moduli) {
        expect(await totale(`?vista=nuove&ambito=anno&conferma=mancano_moduli&modulo=${m.modulo_id}`), m.codice).toBe(m.mancanti)
      }
      // i due moduli della lista conferma non hanno lo stesso numero: prima il link era uno solo per tutti
      const conferma = moduli.filter((m) => m.codice === 'privacy' || m.codice === 'secondo_modulo').map((m) => m.mancanti)
      expect(new Set(conferma).size).toBe(2)
    })
  })

  prova('risposte e nuove: i numeri del cruscotto sono i totali delle loro liste', async () => {
    await inRollback(async () => {
      h.db = db
      await scenario()
      const c = ((await (await CRUSCOTTO(get('cruscotto'), contesto(A27()))).json()) as { data: Cruscotto }).data
      expect(await totale('?conferma=confermato')).toBe(c.risposte.confermati)
      expect(await totale('?conferma=no')).toBe(c.risposte.no)
      expect(await totale('?conferma=non_risposto')).toBe(c.risposte.non_risposto)
      expect(await totale('?vista=nuove')).toBe(c.nuove.totale)
    })
  })

  prova('i parametri nuovi si rifiutano dove non hanno senso', async () => {
    await inRollback(async () => {
      h.db = db
      await scenario()
      expect((await CONFERME(get('conferme', '?ambito=anno'), contesto(A27()))).status).toBe(400)
      expect((await CONFERME(get('conferme', '?vista=nuove&modulo=22222222-2222-4222-8222-222222222299'), contesto(A27()))).status).toBe(400)
    })
  })
})
