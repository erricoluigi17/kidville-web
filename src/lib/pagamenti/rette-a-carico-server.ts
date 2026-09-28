import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
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
 * `sediPaganti` sono le sedi a cui l'utente ha ACCESSO (non solo quelle selezionate):
 * un pagante in un'altra sede accessibile si vede, e accende l'avviso «altra sede»; uno
 * in una sede non accessibile non si rivela — il legame si scarta, contato in un `warn`.
 */

export interface LegameRettaCompleto extends LegameRetta {
  /** Il bambino a carico: serve all'export, NON esce dalla route del cruscotto. */
  alunno: { nome: string; cognome: string; classe_sezione: string | null; section_id: string | null }
}

export type EsitoLegami = { ok: true; legami: LegameRettaCompleto[] } | { ok: false }

interface OpzioniLegami {
  /** Le sedi dei bambini a carico (il perimetro della schermata o dell'export). */
  sediBambini: string[]
  /** Le sedi in cui si può leggere il pagante: quelle accessibili all'utente. */
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

export async function caricaLegamiRetta(
  supabase: SupabaseClient,
  { sediBambini, sediPaganti, operazione }: OpzioniLegami,
): Promise<EsitoLegami> {
  if (sediBambini.length === 0) return { ok: true, legami: [] }

  const bambini = await supabase
    .from('alunni')
    .select(COLONNE_BAMBINO)
    .eq('stato', STATO_ISCRITTO)
    .in('scuola_id', sediBambini)
    .not('retta_a_carico_di', 'is', null)
  if (bambini.error) {
    if (codiceDi(bambini.error) === '42703') {
      // DB E2E della CI, non migrato: la colonna non c'è, quindi non c'è nessun legame.
      // Non è un guasto — il cruscotto resta quello di prima — e lo si dice a livello info.
      logEvento('pagamento', 'info', {
        operazione, esito: 'legami-colonna-assente',
        msg: 'retta_a_carico_di assente (DB non migrato): nessun legame, i bambini restano «Non generata»',
      }, bambini.error)
      return { ok: true, legami: [] }
    }
    logEvento('pagamento', 'error', { operazione, esito: 'legami-bambini-non-letti' }, bambini.error)
    return { ok: false }
  }

  const righe = (bambini.data ?? []) as unknown as RigaBambino[]
  const idPaganti = [...new Set(righe.map((r) => r.retta_a_carico_di).filter((x): x is string => !!x))]
  if (idPaganti.length === 0) return { ok: true, legami: [] }

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
  let scartati = 0
  for (const r of righe) {
    const p = r.retta_a_carico_di ? perId.get(r.retta_a_carico_di) : undefined
    if (!p) {
      scartati++
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
  if (scartati > 0) {
    // Solo il conteggio: mai nomi (AGENTS.md, regola 8).
    logEvento('pagamento', 'warn', {
      operazione, esito: 'legami-pagante-non-leggibile', n: scartati,
      msg: 'pagante fuori dalle sedi accessibili o non più presente: quei bambini restano «Non generata»',
    })
  }
  return { ok: true, legami }
}
