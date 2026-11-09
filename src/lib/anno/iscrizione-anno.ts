import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { segnalaErroreAnnoGestito } from '@/lib/logging/context'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceAnnoDa, type CodiceAnno } from '@/lib/anno/tipi'

/**
 * L'ISCRIZIONE ALL'ANNO PROSSIMO: l'unica porta TypeScript per le funzioni SQL che la scrivono (PR 4.5).
 *
 * Una conferma o una domanda per un anno che non è quello in corso non cambia un dato dell'anno in corso: scrive una
 * FREQUENZA `in_attesa` nell'anno aperto e la voce della sua quota (`anno_registra_frequenza`, `anno_quota_voce`, migrazione
 * M45c). Chi chiama (domanda accolta 4.5.8, conferme 4.5.6, import 4.5.9) passa da qui e da nessun'altra parte.
 *
 * Le funzioni di questo modulo NON LANCIANO MAI e rispondono con un esito:
 *  · `{ ok: true, …campi del jsonb }`: scritta;
 *  · `{ ok: true, saltata: 'schema-indietro' }`: il database non ha ancora la funzione (la CI, la finestra del deploy). Il
 *    chiamante prosegue come oggi, senza errore e senza rumore: un `info` e basta;
 *  · `{ ok: false, codice }`: un codice dell'anno (`ANNO_NON_APERTO`, `SEDE_DIVERSA`…) o `SCRITTURA_FALLITA` per ogni altro guasto.
 *
 * ⚠️ Nei log: uuid, codici e booleani. Mai un nome, un codice fiscale, un importo, il testo di un errore di Postgres (che può
 * riportare la riga intera): del guasto si logga il solo SQLSTATE.
 */

export type QuotaEsito = 'creata' | 'collegata' | 'gia_collegata' | 'piu_voci' | 'senza_listino'

/** I campi del jsonb di `anno_registra_frequenza`. `quota` è NULL per una frequenza già chiusa (ritirata): non le nasce una voce. */
export type RisultatoRegistra = {
  frequenza_id: string
  creata: boolean
  quota: QuotaEsito | null
  pagamento_id: string | null
  posti_oltre: boolean
}

export type CodiceIscrizione = CodiceAnno | 'SCRITTURA_FALLITA'
export type EsitoRegistra =
  | ({ ok: true } & RisultatoRegistra)
  | { ok: true; saltata: 'schema-indietro' }
  | { ok: false; codice: CodiceIscrizione }

export type RegistraFrequenzaArgs = {
  alunnoId: string
  annoSedeId: string
  tipo: 'conferma' | 'nuova'
  origine: 'domanda' | 'conferma' | 'segreteria' | 'import'
  domandaId?: string | null
  sectionId?: string | null
  /** AAAA-MM-GG; assente = l'inizio dell'anno. */
  dataIngresso?: string | null
  /** Lista bianca lato SQL: ogni chiave non ammessa è ignorata. */
  campi?: Record<string, unknown>
}

const OPERAZIONE = 'anno/iscrizione-anno:registraFrequenzaPerAnno'

type ErrorePg = { code?: string | null; message?: string | null } | null | undefined

/** Un errore che ha fermato la scrittura: dell'anno → warn col codice; schema indietro → info; altro → logErrore col solo SQLSTATE. */
function esitoDaErrore(error: ErrorePg, operazione: string): EsitoRegistra {
  if (schemaAnnoIndietro(error)) {
    logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione, error_code: error?.code ?? undefined })
    return { ok: true, saltata: 'schema-indietro' }
  }
  const codice = codiceAnnoDa(error?.message)
  if (codice) {
    logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-anno-non-registrata', error_code: codice, operazione })
    // Gestito qui, fail-open: la rete di `withRoute` non deve tradurlo se la route risponde 500 per altro.
    segnalaErroreAnnoGestito(codice)
    return { ok: false, codice }
  }
  // Solo il codice di Postgres: il messaggio di un CHECK riporta la riga intera.
  logErrore({ operazione }, new Error(`iscrizione-anno:${error?.code ?? 'senza-codice'}`))
  return { ok: false, codice: 'SCRITTURA_FALLITA' }
}

const eRisultato = (d: unknown): d is RisultatoRegistra =>
  typeof d === 'object' && d !== null && typeof (d as RisultatoRegistra).frequenza_id === 'string'

/**
 * Registra la frequenza `(alunno, anno aperto)` e fa nascere (o collega) la voce della quota. Idempotente: rifatta con gli
 * stessi argomenti restituisce la stessa frequenza (`creata: false`). Mai blocca per i posti: `posti_oltre` è un avviso.
 */
export async function registraFrequenzaPerAnno(supabase: SupabaseClient, a: RegistraFrequenzaArgs): Promise<EsitoRegistra> {
  try {
    const { data, error } = await supabase.rpc('anno_registra_frequenza', {
      p_alunno: a.alunnoId,
      p_anno_sede: a.annoSedeId,
      p_tipo: a.tipo,
      p_origine: a.origine,
      p_domanda: a.domandaId ?? null,
      p_section: a.sectionId ?? null,
      p_data_ingresso: a.dataIngresso ?? null,
      p_campi: a.campi ?? null,
    })
    if (error) return esitoDaErrore(error, OPERAZIONE)
    if (!eRisultato(data)) {
      logErrore({ operazione: OPERAZIONE }, new Error('iscrizione-anno:risposta-inattesa'))
      return { ok: false, codice: 'SCRITTURA_FALLITA' }
    }

    logEvento('anno-scolastico', 'info', {
      tipo: 'frequenza-anno-registrata',
      esito: data.creata ? 'creata' : 'esistente',
      operazione: OPERAZIONE,
      entita_id: data.frequenza_id,
      posti_oltre: data.posti_oltre === true,
    })
    if (data.quota) {
      // l'esito della voce, con la voce se c'è: i soli uuid
      logEvento('anno-scolastico', 'info', {
        tipo: 'quota-anno-voce',
        esito: data.quota,
        operazione: OPERAZIONE,
        entita_id: data.pagamento_id ?? undefined,
      })
    }
    return { ok: true, ...data }
  } catch (err) {
    // il client ha lanciato (rete, configurazione): chi chiama non deve cadere per questo
    logErrore({ operazione: OPERAZIONE }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

export type AnnoDellaDomanda =
  | { tipo: 'attivo' | 'aperto'; annoSedeId: string; annoId: string }
  | { tipo: 'schema-indietro' }
  | { tipo: 'non-aperto' }

type RigaAnnoSede = { id: string; anno_id: string; stato: string }

const OP_ANNO = 'anno/iscrizione-anno:annoDellaDomanda'

/**
 * A che anno della sede appartiene una domanda. `annoId` è `anni_scolastici.id` (quello che il modulo pubblico manda), oppure
 * `null` = «come oggi»: l'anno attivo della sede.
 *  · l'anno è l'attivo                       → `attivo`;
 *  · l'anno ha le iscrizioni aperte          → `aperto` (la domanda diventa una frequenza dell'anno prossimo);
 *  · ogni altro anno, o uno che la sede non ha → `non-aperto`;
 *  · lo schema dell'anno non c'è (la CI)      → `schema-indietro`: il chiamante fa come oggi.
 * Non guarda `domande_aperte`: se la sede riceve domande per quell'anno lo decide la route pubblica. NON LANCIA MAI. Un guasto
 * (non di schema) con `annoId` nullo dà `schema-indietro` — il comportamento di oggi, che non perde una domanda vera —, con un
 * anno esplicito dà `non-aperto`; in tutti e due i casi `logErrore` col solo SQLSTATE.
 */
export async function annoDellaDomanda(
  supabase: SupabaseClient,
  scuolaId: string,
  annoId: string | null,
): Promise<AnnoDellaDomanda> {
  const guasto = (codice: string | null | undefined): AnnoDellaDomanda => {
    logErrore({ operazione: OP_ANNO }, new Error(`iscrizione-anno:${codice ?? 'senza-codice'}`))
    return annoId === null ? { tipo: 'schema-indietro' } : { tipo: 'non-aperto' }
  }
  try {
    const attivo = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
    if (attivo.error) {
      if (schemaAnnoIndietro(attivo.error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione: OP_ANNO, error_code: attivo.error.code ?? undefined })
        return { tipo: 'schema-indietro' }
      }
      return guasto(attivo.error.code)
    }
    const idAttivo = typeof attivo.data === 'string' ? attivo.data : null

    const anni = await supabase.from('anni_sede').select('id, anno_id, stato').eq('scuola_id', scuolaId)
    if (anni.error) {
      if (schemaAnnoIndietro(anni.error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'iscrizione-anno-schema-indietro', operazione: OP_ANNO, error_code: anni.error.code ?? undefined })
        return { tipo: 'schema-indietro' }
      }
      return guasto(anni.error.code)
    }
    const righe = (anni.data ?? []) as RigaAnnoSede[]

    const riga = annoId === null
      ? righe.find((r) => r.id === idAttivo)
      : righe.find((r) => r.anno_id === annoId)
    if (!riga) return { tipo: 'non-aperto' }
    if (riga.id === idAttivo) return { tipo: 'attivo', annoSedeId: riga.id, annoId: riga.anno_id }
    if (riga.stato === 'iscrizioni_aperte') return { tipo: 'aperto', annoSedeId: riga.id, annoId: riga.anno_id }
    return { tipo: 'non-aperto' }
  } catch (err) {
    logErrore({ operazione: OP_ANNO }, err)
    return annoId === null ? { tipo: 'schema-indietro' } : { tipo: 'non-aperto' }
  }
}
