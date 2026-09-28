import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { formaConfronto } from '@/lib/auth/scope'
import { sessoDa, type LegameRetta } from './rette-a-carico'

/**
 * ─── CHI PAGA LA RETTA DI CHI, LETTO UNA VOLTA PER DUE CONSUMATORI ───────────────
 *
 * La route del cruscotto (`/api/pagamenti/rette-a-carico`) e l'export dello scadenzario
 * leggono i legami da QUI: se le due strade leggessero in modo diverso, lo schermo e
 * l'Excel direbbero cose diverse sullo stesso bambino.
 *
 * DUE query semplici e non un embed della self-FK: la sintassi di PostgREST per una FK
 * verso la stessa tabella è fragile, e il client finto dei test non costruisce join —
 * con due query i filtri li verifica davvero.
 *
 * `sediPaganti` sono le sedi a cui l'utente ha ACCESSO (non solo quelle selezionate), unite a
 * quelle dei bambini perché una lettura andata storta non le svuoti (`sediDeiPaganti`, K4):
 * un pagante in un'altra sede accessibile si vede, e accende l'avviso «altra sede»; uno
 * in una sede non accessibile non si rivela — di lui non esce NIENTE, ma il bambino (che è
 * nella sede dell'utente) finisce in `nonVisibili`, contato in un `warn`. Prima si scartava
 * e basta: quel bambino tornava «Non generata» e «mancante» per sempre, perché la
 * generazione lo salta comunque (D6 vale anche quando chi paga non si può leggere).
 */

/**
 * K4 (seconda revisione 2026-09-28) — le sedi in cui si legge chi paga: quelle dei bambini ∪
 * quelle accessibili, senza doppioni (confronto senza maiuscole, come `scope.ts`; esce la
 * prima forma incontrata, cioè quella dei bambini).
 *
 * PERCHÉ L'UNIONE. Le route prendono le accessibili da una SECONDA chiamata a
 * `scuoleDiUtente` (la prima è dentro `resolveScuoleAttive`), e quella funzione non lancia
 * mai: per un utente non-Direzione restituisce la sua sede senza leggere niente; per la
 * Direzione legge `utenti_scuole`, e se la tabella MANCA (`42P01`/`PGRST205`) logga un `warn`
 * e restituisce la sola sede propria, mentre su ogni ALTRO errore logga
 * `sedi-utente-non-risolte` (error) e restituisce `[]`. Con `[]` qui ogni pagante — anche
 * quello nella STESSA sede del bambino — risultava non leggibile, e il cruscotto diceva il
 * falso «Chi paga è in un'altra sede». Le sedi dei bambini sono già validate (vengono da
 * `resolveScuoleAttive`), quindi l'unione non allarga niente: nel caso buono coincide con le
 * accessibili, nel caso guasto si perde solo il pagante di un'ALTRA sede accessibile.
 */
export function sediDeiPaganti(sediBambini: readonly string[], accessibili: readonly string[]): string[] {
  const viste = new Set<string>()
  const out: string[] = []
  for (const s of [...sediBambini, ...accessibili]) {
    const k = formaConfronto(s)
    if (viste.has(k)) continue
    viste.add(k)
    out.push(s)
  }
  return out
}

export interface LegameRettaCompleto extends LegameRetta {
  /** Il bambino a carico: serve all'export, NON esce dalla route del cruscotto. */
  alunno: { nome: string; cognome: string; classe_sezione: string | null; section_id: string | null }
}

/** Un bambino a carico il cui pagante sta in una sede che l'utente NON legge: solo chi è e dove. */
export interface BambinoACaricoNonVisibile {
  alunno_id: string
  scuola_id: string | null
}

export type EsitoLegami =
  | { ok: true; legami: LegameRettaCompleto[]; nonVisibili: BambinoACaricoNonVisibile[] }
  | { ok: false }

interface OpzioniLegami {
  /** Le sedi dei bambini a carico (il perimetro della schermata o dell'export). */
  sediBambini: string[]
  /** Le sedi in cui si può leggere il pagante: `sediDeiPaganti(sediBambini, accessibili)`. */
  sediPaganti: string[]
  /** L'operazione che chiama, per i log (`pagamenti/rette-a-carico:GET`, `pagamenti/export:GET`). */
  operazione: string
}

interface RigaBambino {
  id: string
  nome: string | null
  cognome: string | null
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  retta_a_carico_di: string | null
}

interface RigaPagante {
  id: string
  nome: string | null
  cognome: string | null
  gender?: string | null
  classe_sezione: string | null
  stato: string | null
  archiviato_il?: string | null
  scuola_id: string | null
}

const COLONNE_BAMBINO = 'id, nome, cognome, classe_sezione, section_id, scuola_id, retta_a_carico_di'
const COLONNE_PAGANTE = 'id, nome, cognome, gender, classe_sezione, stato, archiviato_il, scuola_id'
/** Ripiego sul DB non migrato della CI: senza sesso («A carico di …») e senza archiviazione. */
const COLONNE_PAGANTE_BASE = 'id, nome, cognome, classe_sezione, stato, scuola_id'

const codiceDi = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

/**
 * Il `42703` dice «colonna assente», non QUALE. Il DB E2E della CI non migrato manca proprio
 * di `retta_a_carico_di`, e solo quello si degrada a «nessun legame»: un 42703 su un'altra
 * colonna (una `section_id` rinominata, un refuso nella select) è un guasto, e degradarlo
 * lo avrebbe nascosto a livello `info` con i bambini tornati «Non generata». Il nome della
 * colonna sta nel messaggio di Postgres, che PostgREST passa tale e quale
 * («column alunni.retta_a_carico_di does not exist»). Senza messaggio non si indovina.
 */
const COLONNA_LEGAME = 'retta_a_carico_di'
function mancaColonnaLegame(e: unknown): boolean {
  if (codiceDi(e) !== '42703') return false
  const { message, details } = (e ?? {}) as { message?: unknown; details?: unknown }
  return [message, details].some((x) => typeof x === 'string' && x.includes(COLONNA_LEGAME))
}

export async function caricaLegamiRetta(
  supabase: SupabaseClient,
  { sediBambini, sediPaganti, operazione }: OpzioniLegami,
): Promise<EsitoLegami> {
  if (sediBambini.length === 0) return { ok: true, legami: [], nonVisibili: [] }

  const bambini = await supabase
    .from('alunni')
    .select(COLONNE_BAMBINO)
    .eq('stato', STATO_ISCRITTO)
    .in('scuola_id', sediBambini)
    .not('retta_a_carico_di', 'is', null)
  if (bambini.error) {
    if (mancaColonnaLegame(bambini.error)) {
      // DB E2E della CI, non migrato: la colonna non c'è, quindi non c'è nessun legame.
      // Non è un guasto — il cruscotto resta quello di prima — e lo si dice a livello info.
      logEvento('pagamento', 'info', {
        operazione, esito: 'legami-colonna-assente',
        msg: 'retta_a_carico_di assente (DB non migrato): nessun legame, i bambini restano «Non generata»',
      }, bambini.error)
      return { ok: true, legami: [], nonVisibili: [] }
    }
    logEvento('pagamento', 'error', { operazione, esito: 'legami-bambini-non-letti' }, bambini.error)
    return { ok: false }
  }

  const righe = (bambini.data ?? []) as unknown as RigaBambino[]
  const idPaganti = [...new Set(righe.map((r) => r.retta_a_carico_di).filter((x): x is string => !!x))]
  if (idPaganti.length === 0) return { ok: true, legami: [], nonVisibili: [] }

  const leggiPaganti = (colonne: string) =>
    supabase.from('alunni').select(colonne).in('id', idPaganti).in('scuola_id', sediPaganti)
  let paganti = sediPaganti.length > 0 ? await leggiPaganti(COLONNE_PAGANTE) : { data: [], error: null }
  if (paganti.error && codiceDi(paganti.error) === '42703') paganti = await leggiPaganti(COLONNE_PAGANTE_BASE)
  if (paganti.error) {
    logEvento('pagamento', 'error', { operazione, esito: 'legami-paganti-non-letti', n: idPaganti.length }, paganti.error)
    return { ok: false }
  }

  const perId = new Map(((paganti.data ?? []) as unknown as RigaPagante[]).map((p) => [p.id, p]))
  const legami: LegameRettaCompleto[] = []
  const nonVisibili: BambinoACaricoNonVisibile[] = []
  for (const r of righe) {
    const p = r.retta_a_carico_di ? perId.get(r.retta_a_carico_di) : undefined
    if (!p) {
      // La FK garantisce che il pagante esista: se non torna, sta fuori da `sediPaganti`.
      nonVisibili.push({ alunno_id: r.id, scuola_id: r.scuola_id ?? null })
      continue
    }
    legami.push({
      alunno_id: r.id,
      scuola_id: r.scuola_id ?? null,
      alunno: { nome: r.nome ?? '', cognome: r.cognome ?? '', classe_sezione: r.classe_sezione ?? null, section_id: r.section_id ?? null },
      pagante: {
        id: p.id,
        nome: p.nome ?? '',
        cognome: p.cognome ?? '',
        sesso: sessoDa(p.gender),
        classe_sezione: p.classe_sezione ?? null,
        iscritto: p.stato === STATO_ISCRITTO && !p.archiviato_il,
        scuola_id: p.scuola_id ?? null,
      },
    })
  }
  if (nonVisibili.length > 0) {
    // Solo il conteggio: mai nomi (AGENTS.md, regola 8).
    logEvento('pagamento', 'warn', {
      operazione, esito: 'legami-pagante-non-leggibile', n: nonVisibili.length,
      msg: 'pagante fuori dalle sedi accessibili: quei bambini risultano «a carico di un fratello di un’altra sede», senza i suoi dati',
    })
  }
  return { ok: true, legami, nonVisibili }
}
