import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { STATO_IN_ARRIVO } from '@/lib/alunni/stato'
import { normalizzaNomeSezione } from '@/lib/alunni/sezione'
import { campiFrequenzaDaAlunno } from '@/lib/anno/frequenze'
import { anniDellaSede } from '@/lib/anno/lettura'
import { annoDellaDomanda } from '@/lib/anno/iscrizione-anno'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

/**
 * APPROVARE UNA DOMANDA PER L'ANNO PROSSIMO: le poche regole che la route `admin/iscrizioni` (PATCH) e l'import massivo
 * (`iscrizioni/import/esegui.ts`) condividono (PR 4.5.8).
 *
 * Una domanda di un anno ad iscrizioni aperte NON è una domanda per la classe di oggi: il bambino nuovo nasce `in_arrivo`
 * (senza classe, senza retta, senza sezione) e la classe, la retta e il resto della famiglia stanno nella FREQUENZA dell'anno
 * aperto (`registraFrequenzaPerAnno`). Qui non si scrive niente: le scritture su `alunni` restano nei due file che le fanno,
 * accanto a `scriviAlunnoEFrequenza` (lo vuole il lock `anno-scrittura-coverage`).
 *
 * ⚠️ Nei log: solo uuid, conteggi e codici. Mai il nome di una classe o di un bambino.
 */

/**
 * Ciò che si scrive su un bambino che ESISTE ed è fuori dalla scuola di oggi (archiviato) e torna l'anno
 * prossimo: senza questo resterebbe fra i «Non iscritti» con «Elimina definitivamente», e l'eliminazione gli cancellerebbe
 * l'iscrizione appena fatta. `in_arrivo` non ha sezione (il vincolo `alunni_in_arrivo_senza_sezione` lo esige).
 * La frequenza dell'anno di oggi (chiusa) NON si tocca: lo specchio non guarda un alunno `in_arrivo`.
 */
export const PATCH_RITORNO_IN_ARRIVO = {
  stato: STATO_IN_ARRIVO,
  archiviato_il: null,
  // (Riattiva, giro 6, P3) Quando la scheda torna viva se ne vanno anche le tracce dell'archiviazione: un `iscritto` con l'autore di un'archiviazione
  // vecchia addosso sembrerebbe a «Riattiva» una riattivazione rimasta a metà.
  archiviato_da: null,
  archiviato_motivo: null,
  archiviato_section_id: null,
  archiviato_classe_sezione: null,
  section_id: null,
  classe_sezione: null,
} as const

/**
 * Un bambino vivo oggi (`iscritto`, `sospeso`) NON cambia stato né classe: la domanda aggiunge solo la frequenza dell'anno dopo.
 * Ex alunno = ARCHIVIATO (`archiviato_il` valorizzato) e basta (4.5.16, D). Un bambino «ritirato» dalla tendina della scheda non è
 * archiviato: la sua frequenza di oggi resta viva con la sua classe, lo specchio la tratta così, e portarlo `in_arrivo` lo
 * lascerebbe con una frequenza di oggi viva e `in_arrivo` insieme (alla prima scrittura tornerebbe `iscritto` con la classe).
 * Per lui la scheda non cambia, e nasce solo la frequenza dell'anno dopo.
 */
export function eExAlunno(scheda: { stato?: string | null; archiviato_il?: string | null } | null | undefined): boolean {
  if (!scheda) return false
  return scheda.archiviato_il !== null && scheda.archiviato_il !== undefined
}

/** L'anno aperto a cui una domanda appartiene: `annoSedeId` (`anni_sede.id`) e `annoId` (`anni_scolastici.id`). */
export type AnnoProssimo = { annoSedeId: string; annoId: string }

/**
 * Per l'IMPORT MASSIVO, che riceve una domanda già caricata senza il suo `anno_id`: lo legge qui e dice se è per l'anno
 * prossimo. NON LANCIA MAI.
 *  · `null`           → il percorso di oggi: domanda inesistente, `anno_id` assente, colonna/schema dell'anno assente (la CI,
 *                       `schemaAnnoIndietro`), anno attivo. Una domanda storica non diventa mai un errore;
 *  · `'non-aperto'`   → l'anno della domanda non ha le iscrizioni aperte: l'import non scrive niente (come il 409 della route);
 *  · `'non-leggibile'`→ la lettura di `anno_id` è caduta per un motivo che NON è lo schema indietro (timeout, permessi,
 *                       eccezione): non si sa di che anno è la domanda, e ripiegare su oggi scriverebbe classe e retta di oggi
 *                       a una domanda dell'anno prossimo, in silenzio. Chi chiama fa fallire la domanda come `'non-aperto'`;
 *  · `{ annoSedeId, annoId }` → il ramo dell'anno prossimo.
 */
export async function annoProssimoDellaDomanda(
  supabase: SupabaseClient,
  domandaId: string,
  scuolaId: string,
): Promise<AnnoProssimo | 'non-aperto' | 'non-leggibile' | null> {
  try {
    const { data, error } = await supabase.from('enrollment_submissions').select('anno_id').eq('id', domandaId).maybeSingle()
    if (error) {
      if (schemaAnnoIndietro(error)) return null
      logEvento('anno-scolastico', 'error', { tipo: 'anno-domanda-non-letto', operazione: 'anno/domanda-anno-prossimo:annoProssimoDellaDomanda', entita_id: domandaId, error_code: error.code ?? undefined })
      return 'non-leggibile'
    }
    if (!data) return null
    const annoId = (data as { anno_id?: string | null }).anno_id ?? null
    if (!annoId) return null
    const anno = await annoDellaDomanda(supabase, scuolaId, annoId)
    if (anno.tipo === 'aperto') return { annoSedeId: anno.annoSedeId, annoId: anno.annoId }
    if (anno.tipo === 'non-aperto') return 'non-aperto'
    return null
  } catch (err) {
    logEvento('anno-scolastico', 'error', { tipo: 'anno-domanda-non-letto', operazione: 'anno/domanda-anno-prossimo:annoProssimoDellaDomanda', entita_id: domandaId }, err)
    return 'non-leggibile'
  }
}

/** `nome normalizzato → sections.id` delle sezioni di UN anno di UNA sede. */
export type SezioniDellAnno = { ok: true; perNome: Map<string, string> } | { ok: false }

/**
 * Le sezioni dell'anno `annoId` (`anni_scolastici.id`) della sede. NON LANCIA MAI: una lettura caduta è `{ ok: false }`
 * (il chiamante sa che senza sezione non può registrare la classe scelta) e un `warn` col solo codice.
 */
export async function sezioniDellAnnoDellaSede(
  supabase: SupabaseClient,
  scuolaId: string,
  annoId: string,
  operazione: string,
): Promise<SezioniDellAnno> {
  try {
    const { data, error } = await supabase
      .from('sections')
      .select('id, name')
      .eq('scuola_id', scuolaId)
      .eq('anno_id', annoId)
    if (error || !Array.isArray(data)) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'sezioni-anno-prossimo-non-lette',
        operazione,
        error_code: (error as { code?: string } | null)?.code ?? undefined,
      })
      return { ok: false }
    }
    const perNome = new Map<string, string>()
    for (const s of data as { id?: unknown; name?: unknown }[]) {
      if (typeof s.id === 'string') perNome.set(normalizzaNomeSezione(s.name), s.id)
    }
    return { ok: true, perNome }
  } catch (err) {
    logEvento('anno-scolastico', 'warn', { tipo: 'sezioni-anno-prossimo-non-lette', operazione }, err)
    return { ok: false }
  }
}

/**
 * I campi che la domanda porta (retta, giorno di scadenza, intestatario: le chiavi di `alunni`) tradotti nelle colonne della
 * FREQUENZA, più `retta_a_carico_di` quando il bambino è a carico di un fratello già in anagrafica. La lista bianca la
 * applica `anno_registra_frequenza`.
 */
export function campiFrequenzaDellaDomanda(
  economici: Record<string, unknown>,
  aCaricoDi?: string | null,
): Record<string, unknown> {
  const campi: Record<string, unknown> = { ...campiFrequenzaDaAlunno(economici) }
  if (aCaricoDi) campi.retta_a_carico_di = aCaricoDi
  return campi
}

/**
 * Le coppie sede→anno per «l'elenco delle sezioni di UN anno scelto» (parametro `anno_id` di `GET /api/admin/sections`,
 * PR 4.5.8: la pagina delle domande propone le classi dell'anno DELLA domanda, non dell'anno di oggi).
 *  · `null` = nessun filtro (il database non ha lo schema dell'anno: la CI);
 *  · `'nessuna'` = nessuna delle sedi ha quell'anno: l'elenco è vuoto, NON non filtrato;
 *  · altrimenti `{ coppie, liberi }` come `anniAttiviDeiPlessi`: una sede la cui lettura è caduta resta libera (un `warn`).
 */
export async function anniDiUnAnnoScelto(
  supabase: SupabaseClient,
  plessi: readonly string[],
  annoId: string,
): Promise<{ coppie: { sede: string; annoId: string }[]; liberi: string[] } | null | 'nessuna'> {
  const coppie: { sede: string; annoId: string }[] = []
  const liberi: string[] = []
  for (const sede of [...new Set(plessi)]) {
    const lette = await anniDellaSede(supabase, sede)
    if ('indietro' in lette) return null
    if ('guasto' in lette) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anni-sede-non-letti', operazione: 'anno/domanda-anno-prossimo:anniDiUnAnnoScelto' }, lette.guasto)
      liberi.push(sede)
      continue
    }
    const riga = lette.righe.find((r) => r.anno_id === annoId)
    if (riga) coppie.push({ sede, annoId })
  }
  return coppie.length === 0 && liberi.length === 0 ? 'nessuna' : { coppie, liberi }
}
