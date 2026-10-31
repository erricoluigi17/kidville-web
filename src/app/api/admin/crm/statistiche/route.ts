import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { formaConfronto, resolveScuoleAttive, restringiSedi, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import {
  PERSONA_AI,
  calcolaStatistiche,
  periodoMeseCorrente,
  type ConfrontoSede,
  type IngressoStatistiche,
  type PersonaStatistiche,
  type RigaPersonaNominata,
  type RispostaStatistiche,
} from '@/lib/crm/statistiche'
import { fineGiornoCivile, inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseQuery, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · le statistiche per persona di una sede.
 *
 * `GET /api/admin/crm/statistiche?scuolaId=<uuid>[&dal=YYYY-MM-DD&al=YYYY-MM-DD][&confronto=1]`
 * → `200 { data: RispostaStatistiche }`.
 *
 * ── CHI VEDE CHE COSA ─────────────────────────────────────────────────────────────────────────────
 *
 *  · Ogni segretaria vede i numeri di TUTTE le colleghe della propria sede (decisione del titolare,
 *    30/10/2026, spec §14). Sono misure di rendimento su lavoratori nominati: la nota sull'informativa
 *    da chiedere alla consulente del lavoro sta nella specifica, non qui.
 *  · La sede si dichiara (`scuolaId`, obbligatoria) e deve stare fra le attive dell'utente
 *    (`resolveScuoleAttive` + `restringiSedi`): una sede non propria è un 403, mai un elenco vuoto.
 *  · `confronto=1` è dell'admin: un totale per ognuna delle sue sedi. Per chiunque altro è 403
 *    `SOLO_ADMIN`, deciso PRIMA di leggere qualunque dato. Il confronto porta solo totali per sede,
 *    mai le righe per persona di un'altra sede.
 *
 * ── IL PERIODO ────────────────────────────────────────────────────────────────────────────────────
 *
 * `dal`/`al` sono giorni civili di Roma, inclusi, e vanno insieme. Senza, è il mese in corso. Il calcolo
 * vero sta in `@/lib/crm/statistiche` (puro, provato col dataset di venti visite); qui si legge, si
 * calcola e si danno i nomi alle persone.
 *
 * ── COSA SI LEGGE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Solo id, enumerazioni e date: nessun nome di famiglia, telefono, email o nota passa di qui. Le visite e
 * i bambini si leggono per intero (non per periodo) perché il merito di un'iscrizione può stare in una
 * visita fuori periodo (vedi `statistiche.ts`); i richiami solo per il periodo.
 */

const RIGHE_PER_PAGINA = 1000
/** Un tetto alle pagine: oltre 200.000 righe per tabella è un errore da vedere, non una lettura da continuare. */
const MAX_PAGINE = 200

const querySchema = z
  .object({
    scuolaId: zUuid,
    dal: zDataYMD.optional(),
    al: zDataYMD.optional(),
    confronto: z.enum(['0', '1']).optional(),
  })
  .refine((q) => (q.dal === undefined) === (q.al === undefined), {
    message: 'dal e al vanno indicati insieme',
    path: ['dal'],
  })
  .refine((q) => q.dal === undefined || q.al === undefined || q.dal <= q.al, {
    message: 'dal non può venire dopo al',
    path: ['dal'],
  })

type ErroreDb = { code?: string; message?: string }
type Riga = Record<string, unknown>
type Pagina = PromiseLike<{ data: unknown[] | null; error: ErroreDb | null }>

/**
 * Tutte le righe di una query, a pagine. Si avanza di quante righe sono TORNATE, e ci si ferma a pagina
 * vuota (non a «meno di una pagina»): se il server taglia le risposte a un massimo più basso della
 * pagina, una lettura che si fermasse alla prima pagina corta perderebbe righe in silenzio.
 */
async function leggiTutto(pagina: (da: number, a: number) => Pagina): Promise<{ righe: Riga[] } | { errore: ErroreDb }> {
  const righe: Riga[] = []
  for (let n = 0; n < MAX_PAGINE; n++) {
    const { data, error } = await pagina(righe.length, righe.length + RIGHE_PER_PAGINA - 1)
    if (error) return { errore: error }
    if (!data || data.length === 0) return { righe }
    righe.push(...(data as Riga[]))
  }
  return { errore: { code: 'CRM_TROPPE_RIGHE', message: 'lettura delle statistiche oltre il tetto delle pagine' } }
}

const perSede = (righe: Riga[]): Map<string, Riga[]> => {
  const mappa = new Map<string, Riga[]>()
  for (const r of righe) {
    const chiave = formaConfronto(String(r.scuola_id ?? ''))
    const lista = mappa.get(chiave) ?? []
    lista.push(r)
    mappa.set(chiave, lista)
  }
  return mappa
}

/** Le sedi di prova non fanno parte di nessun confronto: la finta della CI e la Demo. */
const sedeDiProva = (s: { id: string; nome: string }) => isScuolaE2E(s) || /\bdemo\b/i.test(s.nome ?? '')

const SOLO_ADMIN = () =>
  NextResponse.json({ error: 'Questa operazione è riservata alla Direzione.', codice: 'SOLO_ADMIN' }, { status: 403 })

export const GET = withRoute('admin/crm/statistiche:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  const { scuolaId } = q.data
  const conConfronto = q.data.confronto === '1'

  // Il confronto è dell'admin, e si decide prima di toccare il database.
  if (conConfronto && auth.user.role !== 'admin') {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/statistiche:GET',
      esito: 'confronto-non-admin',
      utente: auth.user.id,
      ruolo: auth.user.role,
    })
    return SOLO_ADMIN()
  }

  const supabase: SupabaseClient = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/statistiche:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }
  const sede = scuole[0]

  const mese = periodoMeseCorrente(new Date())
  const dal = q.data.dal ?? mese.dal
  const al = q.data.al ?? mese.al
  const inizioPeriodo = inizioGiornoCivile(dal)
  const finePeriodo = fineGiornoCivile(al)
  if (inizioPeriodo === null || finePeriodo === null) {
    // Non succede (zDataYMD ha già escluso le date inesistenti): se succede è un difetto, non un input.
    return validationError([{ path: ['dal'], message: 'Periodo non valido' }])
  }

  // ── Quali sedi si leggono, e come si chiamano ─────────────────────────────────────────────────
  const nomiSedi = new Map<string, string>()
  let daLeggere: string[] = [sede]
  if (conConfronto) {
    // «Le sedi che ha»: tutte quelle dell'admin, non soltanto quelle spuntate nel selettore.
    const sue = Array.from(new Set([sede, ...(await scuoleDiUtente(supabase, auth.user))]))
    const { data, error } = await supabase.from('schools').select('id, nome').in('id', sue)
    if (error) return rispostaErroreDb(error, 'admin/crm/statistiche:GET')
    const reali = ((data ?? []) as { id: string; nome: string }[]).filter(
      (s) => formaConfronto(s.id) === formaConfronto(sede) || !sedeDiProva(s),
    )
    for (const s of reali) nomiSedi.set(formaConfronto(s.id), s.nome)
    daLeggere = reali.map((s) => s.id)
    if (!daLeggere.some((id) => formaConfronto(id) === formaConfronto(sede))) daLeggere.push(sede)
  }

  // ── Le letture, tutte con la sede nella stessa query ──────────────────────────────────────────
  const [schede, bambini, appuntamenti, azioni] = await Promise.all([
    leggiTutto((da, a) =>
      supabase.from('crm_schede').select('id, scuola_id, creata_il').in('scuola_id', daLeggere).order('id').range(da, a),
    ),
    leggiTutto((da, a) =>
      supabase
        .from('crm_bambini')
        .select('scuola_id, scheda_id, esito, esito_il, domanda_id, da_verificare')
        .in('scuola_id', daLeggere)
        .order('id')
        .range(da, a),
    ),
    leggiTutto((da, a) =>
      supabase
        .from('crm_appuntamenti')
        .select('scuola_id, scheda_id, inizio, stato, fissato_da, fissato_via, svolto_da')
        .in('scuola_id', daLeggere)
        .order('id')
        .range(da, a),
    ),
    leggiTutto((da, a) =>
      supabase
        .from('crm_azioni')
        .select('scuola_id, responsabile, scadenza, fatta_il, cancellata_il')
        .in('scuola_id', daLeggere)
        .gte('scadenza', inizioPeriodo)
        .lte('scadenza', finePeriodo)
        .order('id')
        .range(da, a),
    ),
  ])
  for (const lettura of [schede, bambini, appuntamenti, azioni]) {
    if ('errore' in lettura) return rispostaErroreDb(lettura.errore, 'admin/crm/statistiche:GET')
  }
  const lette = {
    schede: perSede((schede as { righe: Riga[] }).righe),
    bambini: perSede((bambini as { righe: Riga[] }).righe),
    appuntamenti: perSede((appuntamenti as { righe: Riga[] }).righe),
    azioni: perSede((azioni as { righe: Riga[] }).righe),
  }

  const calcolaPer = (idSede: string) => {
    const chiave = formaConfronto(idSede)
    return calcolaStatistiche({
      schede: (lette.schede.get(chiave) ?? []) as unknown as IngressoStatistiche['schede'],
      bambini: (lette.bambini.get(chiave) ?? []) as unknown as IngressoStatistiche['bambini'],
      appuntamenti: (lette.appuntamenti.get(chiave) ?? []) as unknown as IngressoStatistiche['appuntamenti'],
      azioni: (lette.azioni.get(chiave) ?? []) as unknown as IngressoStatistiche['azioni'],
      dal,
      al,
      adesso: new Date(),
    })
  }

  const stat = calcolaPer(sede)

  // ── I nomi: solo di chi compare in una riga di questa sede ────────────────────────────────────
  const personeCitate = new Set<string>()
  for (const r of stat.righe) if (r.persona !== PERSONA_AI) personeCitate.add(r.persona)
  const ids = Array.from(personeCitate)
  const nomi = new Map<string, PersonaStatistiche>()
  if (ids.length > 0) {
    // Anche gli archiviati: una collega che ha lasciato la scuola ha lavorato nel periodo e il suo nome
    // resta nei numeri. Si cercano per id fra quelli che le righe di QUESTA sede hanno già nominato.
    const { data, error } = await supabase.from('utenti').select('id, nome, cognome').in('id', ids)
    if (error) return rispostaErroreDb(error, 'admin/crm/statistiche:GET')
    for (const u of (data ?? []) as { id: string; nome: string | null; cognome: string | null }[]) {
      nomi.set(u.id, { id: u.id, nome: u.nome ?? '', cognome: u.cognome ?? '' })
    }
  }
  const persona = (id: string): PersonaStatistiche => nomi.get(id) ?? { id, nome: '', cognome: '' }

  const righe: RigaPersonaNominata[] = stat.righe
    .map((r) => ({ ...r, persona: r.persona === PERSONA_AI ? PERSONA_AI : persona(r.persona) }) as RigaPersonaNominata)
    .sort((x, y) => {
      if (x.persona === PERSONA_AI || y.persona === PERSONA_AI) return x.persona === PERSONA_AI ? 1 : -1
      const senzaNome = (p: PersonaStatistiche) => (p.cognome === '' && p.nome === '' ? 1 : 0)
      return (
        senzaNome(x.persona) - senzaNome(y.persona) ||
        x.persona.cognome.localeCompare(y.persona.cognome, 'it') ||
        x.persona.nome.localeCompare(y.persona.nome, 'it') ||
        x.persona.id.localeCompare(y.persona.id)
      )
    })

  const risposta: RispostaStatistiche = {
    scuolaId: sede,
    dal,
    al,
    righe,
    totale: stat.totale,
    ritardoMedianoGiorni: stat.ritardoMedianoGiorni,
    nonAttribuiti: stat.nonAttribuiti,
  }

  if (conConfronto) {
    const confronto: ConfrontoSede[] = daLeggere.map((idSede) => {
      const s = calcolaPer(idSede)
      return {
        scuolaId: idSede,
        nome: nomiSedi.get(formaConfronto(idSede)) ?? '',
        totale: s.totale,
        ritardoMedianoGiorni: s.ritardoMedianoGiorni,
      }
    })
    confronto.sort((x, y) => x.nome.localeCompare(y.nome, 'it') || x.scuolaId.localeCompare(y.scuolaId))
    risposta.confronto = confronto
  }

  return NextResponse.json({ data: risposta })
})
