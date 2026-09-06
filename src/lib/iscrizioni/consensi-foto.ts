/**
 * LA LIBERATORIA FOTO, LETTA UNA VOLTA SOLA PER TUTTI E DUE GLI IMPORT.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ──────────────────────────────────────────────
 * Gli import sono due, e per un mese e mezzo solo uno leggeva i consensi:
 *  · a mano — `PATCH /api/admin/iscrizioni` — che li copiava tutti e tre;
 *  · in blocco — il giro automatico (`import-massivo` → `eseguiDomanda`) — che
 *    non li nominava affatto: le tre colonne non comparivano nel record e il
 *    bambino nasceva sul DEFAULT `false`, cioè su un «no» che nessuno aveva
 *    detto.
 *
 * Misurato in produzione il 2026-09-05: **474 bambini** sono entrati dal giro
 * automatico. I due creati quel giorno avevano tutti e tre i consensi a `false`
 * con la domanda che portava il «sì»; i 472 di prima risultavano giusti solo
 * perché il backfill della migrazione `20260801081502` era stato ripassato sopra
 * a mano. Una riparazione periodica non è una correzione: nasconde il guasto
 * invece di chiuderlo, ed è il motivo per cui nessun test era rosso.
 *
 * La regola vive QUI e non nei due chiamanti, perché due copie della stessa
 * regola divergono — è successo esattamente così: la copia che c'era è rimasta
 * giusta, e quella che mancava ha fatto danno per un mese e mezzo in silenzio.
 *
 * ─── LA PROVA STA IN `consents_log`, NON IN `data` ──────────────────────────
 * `data` è ciò che il client ha mandato; `consents_log.blocchi` è ciò che il
 * server ha verificato e congelato all'invio, con il TESTO che la famiglia ha
 * letto. È la prova legale, ed è l'unica cosa che si guarda qui.
 *
 * ─── LA REGOLA DEL BIANCO, E PERCHÉ RIBALTA IL DEFAULT DELLA COLONNA ────────
 * Vedi `BIANCO_VALE_CONSENSO`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CONSENSI_FOTO_CANALI } from '@/lib/forms/enrollment-template'
import { logEvento } from '@/lib/logging/logger'

/** Un blocco della prova: `{ field_id, label, text, accepted, accepted_at }`. */
export interface BloccoConsenso {
  field_id?: string
  accepted?: boolean
}

/** `enrollment_submissions.consents_log`, per la sola parte che serve qui. */
export interface ProvaConsensi {
  blocchi?: BloccoConsenso[] | null
}

/** Colonna di `alunni` → valore da scrivere. Spandibile dentro il record. */
export type ConsensiFotoColonne = Record<string, boolean>

/**
 * ⚠️ QUESTA COSTANTE RIBALTA IL DEFAULT DELLA COLONNA, ED È VOLUTO.
 *
 * `alunni.consenso_foto_sito` e `consenso_foto_social` sono `NOT NULL DEFAULT
 * false`, `consenso_privacy` è `DEFAULT false`: per il database il bianco vale
 * NO. Dal 2026-09-05, per istruzione del titolare, **per l'import il bianco vale
 * SÌ**: «se lasciata in bianco va intesa come consenso dato».
 *
 * Riguarda le domande anteriori al passo consensi — 86 approvate, misurate il
 * 2026-09-05, che non portano affatto le chiavi di consenso perché a quelle
 * famiglie non è mai stato chiesto niente.
 *
 * Chi legge fra sei mesi: non è una svista né un default ereditato. Se un giorno
 * la decisione cambia, si cambia QUI — un posto solo, e i due import cambiano
 * insieme.
 */
export const BIANCO_VALE_CONSENSO = true

/**
 * La prova esiste? Distinta dal suo contenuto perché le due cose portano a
 * conseguenze diverse: senza prova vale il bianco, con la prova si onora ciò che
 * la famiglia ha detto — anche quando ha detto no.
 */
export function provaConsensiPresente(prova: ProvaConsensi | null | undefined): boolean {
  return (prova?.blocchi ?? []).length > 0
}

/**
 * I valori da scrivere sulle colonne di `alunni`, canale per canale.
 *
 * L'elenco dei canali NON si scrive a mano: viene da `CONSENSI_FOTO_CANALI`,
 * unica fonte di verità del legame consenso→colonna. Un quarto canale aggiunto
 * al modulo entra qui da solo, invece di restare senza destinazione per mesi
 * (è già successo: sito e social, risposti da 141 famiglie, non arrivavano da
 * nessuna parte).
 *
 * La regola del bianco guarda la prova NEL SUO INSIEME, non il singolo canale:
 *  · `blocchi` vuoto o assente → nessuno ha mai chiesto niente a questa
 *    famiglia → bianco → `BIANCO_VALE_CONSENSO`;
 *  · `blocchi` presente → si onora quello che c'è scritto, canale per canale.
 *
 * Perché non per singolo canale: `estraiConsensi` scrive un blocco per OGNI
 * campo consenso del modulo, quindi in una prova vera i canali ci sono sempre
 * tutti (misurato il 2026-09-05 su 594 domande: 93 senza prova, 501 con tutte e
 * tre, **zero parziali**). Un canale mancante dentro una prova che esiste può
 * nascere solo domani, aggiungendo un quarto canale al modulo — e dare per
 * concesso a 501 famiglie un canale che non hanno mai visto significherebbe
 * inventare un consenso, che è il difetto del 2026-07-31 al rovescio.
 */
export function consensiFotoDaProva(prova: ProvaConsensi | null | undefined): ConsensiFotoColonne {
  const blocchi = prova?.blocchi ?? []
  const bianco = blocchi.length === 0
  return Object.fromEntries(
    Object.entries(CONSENSI_FOTO_CANALI).map(([fieldId, colonna]) => [
      colonna,
      bianco ? BIANCO_VALE_CONSENSO : blocchi.some((b) => b?.field_id === fieldId && b?.accepted === true),
    ]),
  )
}

/**
 * La prova di UNA domanda, letta dal database.
 *
 * Serve al giro automatico, che riceve la domanda già analizzata e non ha in
 * mano il `consents_log` (l'import a mano ha invece l'invio intero sotto gli
 * occhi e passa direttamente da `consensiFotoDaProva`).
 *
 * @returns `null` quando la prova NON si è potuta leggere — e allora non si
 * scrive nessuna colonna, lasciando decidere il default. Il bianco vale come sì
 * solo su una prova **letta davvero**: una lettura caduta non è un bianco, è un
 * non-so, e da un non-so non si inventa il consenso a pubblicare la foto di un
 * minore.
 */
export async function consensiFotoDellaDomanda(
  supabase: SupabaseClient,
  submissionId: string,
  operazione: string,
): Promise<{ colonne: ConsensiFotoColonne; daProva: boolean } | null> {
  // PostgREST non lancia: ritorna `{ error }`. Senza il controllo del valore di
  // ritorno una lettura caduta diventerebbe «nessun consenso», che qui è
  // indistinguibile dal bianco — e il bianco adesso vale SÌ.
  const { data, error } = await supabase
    .from('enrollment_submissions')
    .select('consents_log')
    .eq('id', submissionId)
    .maybeSingle()

  if (error || !data) {
    logEvento('iscrizione', 'error', {
      operazione,
      esito: 'consensi-foto-non-letti',
      entita_tipo: 'enrollment_submissions',
      entita_id: submissionId,
      error_code: (error as { code?: string } | null)?.code ?? null,
    }, error ?? new Error('domanda non trovata: consensi foto non verificabili'))
    return null
  }

  const prova = (data as { consents_log?: ProvaConsensi | null }).consents_log
  return { colonne: consensiFotoDaProva(prova), daProva: provaConsensiPresente(prova) }
}
