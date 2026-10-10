import {
  aggregaEntratePerCategoria,
  aggregaMensile,
  aggregaUscitePerCategoria,
  METODI_REALI,
  type IncassoReportData,
  type ReportGrezzo,
} from '@/lib/cassa/report'

/**
 * `report_cassa_aggregato` EMULATA con la semantica di RIFERIMENTO di
 * `src/lib/cassa/report.ts`, per i test di route che costruiscono righe finte di
 * `incassi` (con l'embed `pagamenti`) e `cassa_movimenti`.
 *
 * Non è un mock piatto: calcola i gruppi dalle righe del test con le stesse funzioni
 * che la funzione SQL deve uguagliare — e che la funzione SQL uguagli queste lo prova
 * su un Postgres vero `__tests__/lib/report-cassa-aggregato-sql.test.ts`. Il
 * `controllo` è calcolato a parte, con un ciclo piatto, come il SUM del database.
 */

type Riga = Record<string, unknown>

interface Filtri { p_scuola_ids?: unknown; p_da?: unknown; p_a?: unknown; p_categoria?: unknown }

export function reportCassaDiRiferimento(db: { incassi?: Riga[]; cassa_movimenti?: Riga[] }, args: Filtri): ReportGrezzo {
  const sedi = new Set((args.p_scuola_ids as string[] | null) ?? [])
  const da = (args.p_da as string | null) ?? null
  const a = (args.p_a as string | null) ?? null
  const categoria = (args.p_categoria as string | null) ?? null

  const incassi: Array<IncassoReportData & { scuola_id: string }> = []
  for (const r of db.incassi ?? []) {
    const p = (r.pagamenti ?? null) as Riga | null
    const scuola = (p?.scuola_id as string | null) ?? null
    const data = (r.data_incasso as string | null) ?? ''
    if (!scuola || !sedi.has(scuola)) continue
    if (da && data < da) continue
    if (a && data > a) continue
    if (categoria && p?.categoria_id !== categoria) continue
    incassi.push({
      id: r.id as string,
      importo: Number(r.importo),
      metodo: r.metodo as string,
      storno_di: (r.storno_di as string | null) ?? null,
      data,
      categoria_id: (p?.categoria_id as string | null) ?? null,
      categoria_nome: ((p?.payment_categories as Riga | null)?.nome as string | null) ?? null,
      scuola_id: scuola,
    })
  }
  const uscite = (db.cassa_movimenti ?? [])
    .filter((m) => m.tipo === 'uscita' && sedi.has(m.scuola_id as string))
    .filter((m) => (!da || (m.data as string) >= da) && (!a || (m.data as string) <= a))
    .map((m) => ({
      importo: Number(m.importo),
      metodo: m.metodo as string,
      data: (m.data as string | null) ?? '',
      categoria_id: (m.categoria_id as string | null) ?? null,
      categoria_nome: ((m.cassa_categorie as Riga | null)?.nome as string | null) ?? null,
      scuola_id: m.scuola_id as string,
    }))

  const grezzo: ReportGrezzo = { entrate: [], uscite: [], mensile: [], controllo: { entrate: 0, uscite: 0, incassi: incassi.length, movimenti: uscite.length } }
  const livelli: Array<string | null> = [null, ...new Set([...incassi.map((i) => i.scuola_id), ...uscite.map((u) => u.scuola_id)])]
  for (const scuola_id of livelli) {
    const inc = incassi.filter((i) => scuola_id === null || i.scuola_id === scuola_id)
    const usc = uscite.filter((u) => scuola_id === null || u.scuola_id === scuola_id)
    for (const c of aggregaEntratePerCategoria(inc)) {
      for (const [metodo, importo] of Object.entries(c.per_metodo)) {
        grezzo.entrate.push({ scuola_id, categoria_id: c.categoria_id, categoria_nome: c.categoria_nome, metodo, importo })
      }
    }
    for (const c of aggregaUscitePerCategoria(usc)) grezzo.uscite.push({ scuola_id, ...c })
    for (const m of aggregaMensile(inc, usc)) grezzo.mensile.push({ scuola_id, ...m })
  }

  // Il controllo, a parte: un ciclo piatto, come il SUM del database.
  const perId = new Map(incassi.map((i) => [i.id, i]))
  for (const i of incassi) {
    const metodo = i.storno_di == null ? i.metodo : perId.get(i.storno_di)?.metodo
    if (metodo && METODI_REALI.has(metodo)) grezzo.controllo.entrate += i.importo
  }
  for (const u of uscite) grezzo.controllo.uscite += u.importo
  grezzo.controllo.entrate = Math.round(grezzo.controllo.entrate * 100) / 100
  grezzo.controllo.uscite = Math.round(grezzo.controllo.uscite * 100) / 100
  return grezzo
}
