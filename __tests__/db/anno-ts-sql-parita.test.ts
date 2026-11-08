import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, creaAnniFissi } from '../helpers/schema-anno-pglite'
import { dataCivile } from '@/i18n/config'
import {
  annoDiIstante,
  annoAttivoDelCalendario,
  type Calendario,
  type RigaCalendario,
} from '@/lib/anno-scolastico'

/**
 * COMPITO 4.1.3 · TS e SQL danno lo stesso anno. `giorno_roma`/`anno_di`/`anno_attivo` (database) e
 * `dataCivile`/`annoDiIstante`/`annoAttivoDelCalendario` (TypeScript) rispondono alla stessa domanda, «che anno è
 * questo istante per questa sede»: se un giorno divergessero (soglia, fuso, ora legale) questo test diventa rosso.
 * Solo uuid finti, solo PGlite. Tutto il blocco gira due volte, con il fuso del processo UTC e Los Angeles: il
 * giorno deve restare quello di Roma in entrambi.
 *
 * Sede 1: calendario fisso (2025/26 fino al 31/08/2026, 2026/27 dal 01/09/2026).
 * Sede 2: confine spostato, il 2025/26 finisce il 14/09/2026 e il 2026/27 comincia il 15/09/2026.
 */

const SEDE1 = '11111111-1111-4111-8111-111111111111'
const SEDE2 = '33333333-3333-4333-8333-333333333333'

async function calendarioLettoDa(db: PGlite, sede: string): Promise<Calendario> {
  // Le date si leggono come testo dal database: nessun `Date` JS di mezzo, quindi nessun fuso che le sposti.
  const r = await db.query<{
    anno_id: string; id: string; anno_inizio: number; inizio: string; fine: string
    ultimo: string; prepara: string; stato: RigaCalendario['stato']; domande_aperte: boolean
  }>(
    `SELECT s.anno_id, s.id, y.anno_inizio, s.inizio::text AS inizio, s.fine::text AS fine,
            s.ultimo_giorno_aperto::text AS ultimo, s.prepara_successivo_dal::text AS prepara,
            s.stato, s.domande_aperte
       FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
      WHERE s.scuola_id = $1 ORDER BY s.inizio`,
    [sede],
  )
  return r.rows.map((x) => ({
    annoId: x.anno_id,
    annoSedeId: x.id,
    annoInizio: Number(x.anno_inizio),
    inizio: x.inizio,
    fine: x.fine,
    ultimoGiornoAperto: x.ultimo,
    preparaSuccessivoDal: x.prepara,
    stato: x.stato,
    domandeAperte: x.domande_aperte,
  }))
}

interface Caso { nome: string; istante: string; giorno: string; anno: number }
const CASI: Caso[] = [
  { nome: '31/07 23:30 di Roma', istante: '2026-07-31T21:30:00Z', giorno: '2026-07-31', anno: 2025 },
  { nome: '01/08 00:30 di Roma (in UTC è ancora il 31/07)', istante: '2026-07-31T22:30:00Z', giorno: '2026-08-01', anno: 2025 },
  { nome: '31/08 23:30 di Roma', istante: '2026-08-31T21:30:00Z', giorno: '2026-08-31', anno: 2025 },
  { nome: '01/09 00:30 di Roma (in UTC è ancora il 31/08)', istante: '2026-08-31T22:30:00Z', giorno: '2026-09-01', anno: 2026 },
  { nome: '31/12 23:30 di Roma', istante: '2026-12-31T22:30:00Z', giorno: '2026-12-31', anno: 2026 },
  { nome: '15/01 a mezzogiorno UTC', istante: '2027-01-15T12:00:00Z', giorno: '2027-01-15', anno: 2026 },
  { nome: 'fine ora legale, 24/10 22:30 UTC', istante: '2026-10-24T22:30:00Z', giorno: '2026-10-25', anno: 2026 },
  { nome: 'fine ora legale, 25/10 00:30 UTC', istante: '2026-10-25T00:30:00Z', giorno: '2026-10-25', anno: 2026 },
  { nome: 'fine ora legale, 25/10 23:30 UTC', istante: '2026-10-25T23:30:00Z', giorno: '2026-10-26', anno: 2026 },
  { nome: 'inizio ora legale, 27/03 23:30 UTC', istante: '2027-03-27T23:30:00Z', giorno: '2027-03-28', anno: 2026 },
  { nome: 'inizio ora legale, 28/03 00:30 UTC', istante: '2027-03-28T00:30:00Z', giorno: '2027-03-28', anno: 2026 },
  { nome: 'inizio ora legale, 28/03 22:30 UTC', istante: '2027-03-28T22:30:00Z', giorno: '2027-03-29', anno: 2026 },
]

function blocco(tz: string, oreAttese: number) {
  describe(`TS e SQL concordano con il processo in ${tz}`, () => {
    let db: PGlite
    let cal1: Calendario
    let cal2: Calendario
    const tzPrima = process.env.TZ

    async function sql(istante: string, sede: string) {
      const r = await db.query<{ g: string; a: number | null }>(
        `SELECT public.giorno_roma($1::timestamptz)::text AS g,
                (SELECT anno_inizio FROM public.anni_scolastici
                  WHERE id = public.anno_di($2, public.giorno_roma($1::timestamptz))) AS a`,
        [istante, sede],
      )
      return { g: r.rows[0].g, a: r.rows[0].a === null ? null : Number(r.rows[0].a) }
    }

    beforeAll(async () => {
      process.env.TZ = tz
      db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE1, SEDE2] })
      await creaAnniFissi(db, [SEDE1, SEDE2])
      const id = await db.query<{ id: string }>(
        `SELECT s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
          WHERE s.scuola_id = $1 AND y.anno_inizio = 2025`,
        [SEDE2],
      )
      // `sposta_confine_anno` rifiuta (ANNO_CHIUSO) un confine che tocca un anno `chiuso`, ed è giusto così: nel
      // database di prova il 2025/26 della sede 2 si riapre per un attimo, si sposta il confine, si richiude.
      await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = $1`, [id.rows[0].id])
      await db.query(`SELECT public.sposta_confine_anno($1, DATE '2026-09-14')`, [id.rows[0].id])
      await db.query(`UPDATE public.anni_sede SET stato = 'chiuso' WHERE id = $1`, [id.rows[0].id])
      cal1 = await calendarioLettoDa(db, SEDE1)
      cal2 = await calendarioLettoDa(db, SEDE2)
    }, 60_000)

    afterAll(async () => {
      if (tzPrima === undefined) delete process.env.TZ
      else process.env.TZ = tzPrima
      await db?.close()
    })

    it('il cambio di TZ ha davvero effetto sul processo (altrimenti il verde sarebbe finto)', () => {
      const d = new Date('2026-07-31T22:30:00Z')
      expect(d.getHours()).toBe(oreAttese)
      expect(d.getDate()).toBe(31)
    })

    it('il calendario di prova è quello atteso', () => {
      expect(cal1.map((r) => [r.annoInizio, r.inizio, r.fine]).slice(0, 2)).toEqual([
        [2025, '2025-09-01', '2026-08-31'],
        [2026, '2026-09-01', '2027-08-31'],
      ])
      expect(cal2.map((r) => [r.annoInizio, r.inizio, r.fine]).slice(0, 2)).toEqual([
        [2025, '2025-09-01', '2026-09-14'],
        [2026, '2026-09-15', '2027-08-31'],
      ])
    })

    it.each(CASI)('$nome · sede 1: giorno e anno uguali in SQL e TS', async ({ istante, giorno, anno }) => {
      const s = await sql(istante, SEDE1)
      expect(s.g).toBe(giorno)
      expect(dataCivile(new Date(istante))).toBe(giorno)
      expect(s.a).toBe(anno)
      expect(annoDiIstante(new Date(istante), cal1).annoInizio).toBe(anno)
      // Senza calendario il TS usa la soglia predefinita: per la sede 1 (calendario predefinito) deve dare lo
      // stesso anno del database. Qui morde la soglia (1° settembre): con il calendario in mano non si userebbe.
      const senza = annoDiIstante(new Date(istante))
      expect(senza.fonte).toBe('predefinito')
      expect(senza.annoInizio).toBe(anno)
    })

    it.each(CASI)('$nome · sede 2: anno SQL === anno TS', async ({ istante }) => {
      const s = await sql(istante, SEDE2)
      expect(s.a).not.toBeNull()
      expect(annoDiIstante(new Date(istante), cal2).annoInizio).toBe(s.a)
    })

    it('10/09: la sede dal confine spostato è ancora nel 2025/26, la prima nel 2026/27', async () => {
      const istante = '2026-09-10T10:00:00Z'
      expect((await sql(istante, SEDE2)).a).toBe(2025)
      const ts2 = annoDiIstante(new Date(istante), cal2)
      expect(ts2.annoInizio).toBe(2025)
      expect(ts2.fonte).toBe('sede')
      expect((await sql(istante, SEDE1)).a).toBe(2026)
      expect(annoDiIstante(new Date(istante), cal1).annoInizio).toBe(2026)
    })

    it('DIFFERENZA DICHIARATA: fuori dal calendario il database dice NULL, il TS ripiega sul predefinito', async () => {
      // Voluta: il database rifiuta i giorni senza anno (anno_di → NULL), mentre il TS non deve rompere una pagina
      // e risponde con la soglia predefinita (1° settembre) e fonte 'predefinito'.
      const istante = '2024-12-31T12:00:00Z'
      expect((await sql(istante, SEDE1)).a).toBeNull()
      const ts = annoDiIstante(new Date(istante), cal1)
      expect(ts.fonte).toBe('predefinito')
      expect(ts.annoInizio).toBe(2024)
    })

    it('anno attivo: stesso anni_sede.id in SQL e TS, anche dopo il passaggio a in_chiusura', async () => {
      const sqlAttivo = async (sede: string) =>
        (await db.query<{ a: string }>(`SELECT public.anno_attivo($1) AS a`, [sede])).rows[0].a
      for (const [sede, cal] of [[SEDE1, cal1], [SEDE2, cal2]] as const) {
        const ts = annoAttivoDelCalendario(cal)
        expect(ts).not.toBeNull()
        expect(ts?.annoSedeId).toBe(await sqlAttivo(sede))
        expect(ts?.annoInizio).toBe(2026)
      }
      await db.query(
        `UPDATE public.anni_sede s SET stato = 'in_chiusura'
           FROM public.anni_scolastici y
          WHERE y.id = s.anno_id AND y.anno_inizio = 2026 AND s.scuola_id = $1`,
        [SEDE1],
      )
      const dopo = await calendarioLettoDa(db, SEDE1)
      expect(dopo.find((r) => r.annoInizio === 2026)?.stato).toBe('in_chiusura')
      expect(annoAttivoDelCalendario(dopo)?.annoSedeId).toBe(await sqlAttivo(SEDE1))
    })
  })
}

blocco('UTC', 22)
blocco('America/Los_Angeles', 15)
