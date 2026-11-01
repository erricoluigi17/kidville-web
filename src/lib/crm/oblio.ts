import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore, logEvento } from '@/lib/logging/logger'

// L'OBLIO DI UN ALUNNO NEL CRM DELLA SEGRETERIA (2026-11-01, PR-B dopo il merge di #276).
//
// Il CRM conosce il bambino PRIMA che diventi alunno: nome, data di nascita, la famiglia che ha
// telefonato, le note delle telefonate. Quando il bambino diventa alunno, `crm_bambini.alunno_id`
// lo lega alla sua scheda anagrafica, e l'oblio dell'alunno deve arrivare fin lì. Fino a questo
// file non ci arrivava: `anonimizzaAlunno` non nominava nessuna tabella `crm_*`, e cercava i
// movimenti di cassa solo per codice fiscale (punto 3e), mentre l'entrata dei contanti della quota
// porta il NOME del bambino («Quota d'iscrizione 2027/28 – nome (CRM)») e nessun codice.
//
// Cosa si toglie, e cosa resta. Stessa regola della conservazione a 12 mesi della specifica del CRM
// (§9): si svuotano i dati personali, restano sede, date, enumerazioni, esiti e attribuzioni, così le
// statistiche per persona non cambiano.
//  · il bambino collegato: nome, data di nascita e la nota del motivo di perdita (testo libero);
//  · le sue entrate di cassa della quota, comprese quelle stornate da una correzione (le ritrova
//    `crm_eventi.dati.movimento_id`, perché `quota_cassa_movimento_id` punta solo all'ultima): la
//    descrizione diventa «[rimosso]», come al punto 3e; importo, giorno e metodo restano, la cassa torna;
//  · la scheda, SOLO se nessun suo bambino resta in chiaro (un fratello ancora seguito tiene viva la
//    scheda della famiglia): nome del genitore, telefoni, email, le tre domande del manuale, il testo
//    delle note e delle telefonate, e `anonimizzata_il`.
//
// Tutto per id: niente ricerche per nome, che in un CRM di prospetti pescherebbero un omonimo.

export type EsitoOblioCrm = {
  /** Bambini del CRM collegati all'alunno e svuotati. */
  bambini: number
  /** Schede anonimizzate perché nessun loro bambino resta in chiaro. */
  schede: number
  /** Entrate di cassa della quota con la descrizione tolta. */
  cassa: number
  /**
   * `false` = una lettura o una scrittura non è riuscita, e qualcosa del CRM può essere rimasto in
   * chiaro. Chi lo riceve non può dichiarare l'oblio completo (vedi `lettureFallite`).
   */
  completo: boolean
}

const TIPI_EVENTO_QUOTA = ['quota_segnata', 'quota_corretta'] as const

type RigaBambino = { id: string; scheda_id: string; quota_cassa_movimento_id: string | null }

export async function obliaCrmAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  at: string,
  op: string,
): Promise<EsitoOblioCrm> {
  const esito: EsitoOblioCrm = { bambini: 0, schede: 0, cassa: 0, completo: true }
  const fallito = (evento: string, err: unknown) => {
    esito.completo = false
    logErrore({ operazione: op, evento }, err)
  }

  const { data: righe, error: errBambini } = await supabase
    .from('crm_bambini')
    .select('id, scheda_id, quota_cassa_movimento_id')
    .eq('alunno_id', alunnoId)
  if (errBambini) {
    // Senza le tabelle del CRM non c'è niente da dimenticare: è il database E2E della CI.
    if (!schemaAssente(errBambini)) fallito('oblio_crm_bambini_select', errBambini)
    return esito
  }
  const bambini = (righe ?? []) as RigaBambino[]
  if (bambini.length === 0) return esito

  const idBambini = new Set(bambini.map((b) => b.id))
  const idSchede = [...new Set(bambini.map((b) => b.scheda_id))]

  // Le entrate di cassa della quota: l'ultima dal bambino, le precedenti (stornate da una correzione)
  // dagli eventi della quota, che portano `bambino_id` e `movimento_id`.
  const movimenti = new Set(bambini.map((b) => b.quota_cassa_movimento_id).filter((m): m is string => !!m))
  const { data: eventi, error: errEventi } = await supabase
    .from('crm_eventi')
    .select('dati')
    .in('scheda_id', idSchede)
    .in('tipo', [...TIPI_EVENTO_QUOTA])
  if (errEventi) fallito('oblio_crm_eventi_quota_select', errEventi)
  for (const e of (eventi ?? []) as { dati: Record<string, unknown> | null }[]) {
    const bambino = e.dati?.bambino_id
    const movimento = e.dati?.movimento_id
    if (typeof bambino === 'string' && idBambini.has(bambino) && typeof movimento === 'string') {
      movimenti.add(movimento)
    }
  }

  const { data: svuotati, error: errSvuota } = await supabase
    .from('crm_bambini')
    .update({ nome: null, data_nascita: null, motivo_nota: null, aggiornata_il: at })
    .in('id', [...idBambini])
    .select('id')
  if (errSvuota) fallito('oblio_crm_bambini_update', errSvuota)
  else esito.bambini = (svuotati ?? []).length

  if (movimenti.size > 0) {
    const { data: cassa, error: errCassa } = await supabase
      .from('cassa_movimenti')
      .update({ descrizione: '[rimosso]' })
      .in('id', [...movimenti])
      .not('descrizione', 'is', null)
      .select('id')
    if (errCassa) {
      if (!schemaAssente(errCassa)) fallito('oblio_crm_cassa_update', errCassa)
    } else {
      esito.cassa = (cassa ?? []).length
    }
  }

  // Le schede: si anonimizzano solo quelle in cui nessun bambino resta in chiaro. Si rilegge dopo la
  // scrittura qui sopra: se quella è fallita, il bambino ha ancora il nome e la scheda resta com'è.
  const { data: tutti, error: errTutti } = await supabase
    .from('crm_bambini')
    .select('scheda_id, nome, data_nascita')
    .in('scheda_id', idSchede)
  if (errTutti) {
    fallito('oblio_crm_fratelli_select', errTutti)
    return chiudi(esito, op)
  }
  const inChiaro = new Set(
    ((tutti ?? []) as { scheda_id: string; nome: string | null; data_nascita: string | null }[])
      .filter((b) => (b.nome ?? '').trim() !== '' || b.data_nascita !== null)
      .map((b) => b.scheda_id),
  )
  const daAnonimizzare = idSchede.filter((s) => !inChiaro.has(s))
  if (daAnonimizzare.length > 0) {
    const { data: schede, error: errSchede } = await supabase
      .from('crm_schede')
      .update({
        genitore_nome: null,
        telefono1: null,
        telefono2: null,
        email1: null,
        email2: null,
        telefoni_norm: [],
        email_norm: [],
        routine: null,
        paura: null,
        desiderio: null,
        anonimizzata_il: at,
        aggiornata_il: at,
      })
      .in('id', daAnonimizzare)
      .select('id')
    if (errSchede) fallito('oblio_crm_schede_update', errSchede)
    else esito.schede = (schede ?? []).length

    // Il testo libero dello storico (note e telefonate) può nominare il bambino: va via con la scheda.
    const { error: errTesto } = await supabase
      .from('crm_eventi')
      .update({ testo: null })
      .in('scheda_id', daAnonimizzare)
      .not('testo', 'is', null)
    if (errTesto) fallito('oblio_crm_eventi_testo_update', errTesto)
  }

  return chiudi(esito, op)
}

function chiudi(esito: EsitoOblioCrm, op: string): EsitoOblioCrm {
  // L'oblio è un evento critico: si registra anche quando riesce, con i soli conteggi.
  logEvento('gdpr', esito.completo ? 'info' : 'error', {
    operazione: op,
    esito: esito.completo ? 'oblio-crm-fatto' : 'oblio-crm-parziale',
    n_bambini: esito.bambini,
    n_schede: esito.schede,
    n_cassa: esito.cassa,
  })
  return esito
}
