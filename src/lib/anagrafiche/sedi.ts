/* ════════════════════════════════════════════════════════════════════════════
 * DI CHE PLESSO È QUESTA PERSONA? — le tre letture, in un posto solo.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Il 2026-09-03 quattro route hanno smesso di prendere la sede da
 * `auth.user.scuola_id` — la sede dell'ACCOUNT, cioè il plesso in cui l'account
 * è stato aperto — e hanno iniziato a chiederla al dato che ce l'ha davvero: il
 * BAMBINO. Misurato in produzione quel giorno: 639 account genitore su 639
 * hanno `utenti.scuola_id` valorizzata, quindi la lettura sbagliata non falliva
 * mai — decideva sempre — e in 6 di quegli account contraddice almeno un figlio.
 * `parents` una `scuola_id` non ce l'ha, ed è una scelta esplicita: due fratelli
 * possono stare in due plessi.
 *
 * La correzione è nata TRE VOLTE, in tre file, con tre nomi diversi
 * (`sedeDelThread`, `sediDaAvvisare`, `sediDaAvvisare`) e le stesse identiche
 * due query dentro. In questo repo una regola valida per più strade vive in un
 * posto solo: tre copie sono tre occasioni di correggerne una e dimenticarne
 * due, ed è già successo (la stessa svista `.eq('id', …)` su `parents` andò
 * corretta in tre route separate).
 *
 * ─── COSA NON FANNO, E VA DETTO ─────────────────────────────────────────────
 *
 * Queste funzioni **non sono gate**: non negano niente e non delimitano niente.
 * Rispondono a «di che plesso è questa riga», e chi chiama decide cosa farne —
 * di norma a chi mandare una notifica. Il perimetro di chi può chiedere resta
 * dove è sempre stato: `requireUser`/`requireParentOfStudent` sul chiamante, e
 * `getFigliDiGenitore` che parte dall'account autenticato, mai da un id scelto
 * dal client.
 *
 * ─── PostgREST NON LANCIA ───────────────────────────────────────────────────
 *
 * Ogni lettura controlla `{ error }` e lascia una riga di `warn`. Senza, «il
 * bambino non ha plesso» e «non ho potuto leggerlo» sarebbero lo stesso `null`,
 * e solo uno dei due è un guasto nostro. Nessuna di queste funzioni lancia mai:
 * chi le chiama sta già mandando una notifica best-effort e non può fallire per
 * un plesso mancante — deve però poterlo DIRE, ed è per questo che il `null` e
 * l'elenco vuoto sono documentati come «non lo so», mai come «nessuno».
 *
 * ─── NIENTE DATI PERSONALI NEI LOG ──────────────────────────────────────────
 *
 * `extra` accetta solo uuid, numeri e booleani: la redazione
 * (`@/lib/logging/redact`) è a lista bianca e da qui passano bambini. Gli id
 * degli alunni NON si loggano mai — di `sediDeiFigli` si registra il CONTEGGIO.
 * ════════════════════════════════════════════════════════════════════════════ */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import { getFigliDiGenitore } from './legami';

export interface ContestoSede {
  /** Il gruppo dell'evento di log: `chat`, `modulistica`, `multi_sede`… */
  gruppo: string;
  /** `<route relativa a src/app/api>:<METODO>`, lo stesso nome usato da `withRoute`. */
  operazione: string;
  /**
   * Campi extra da allegare alle righe di log — `threadId` e simili.
   * SOLO uuid, numeri e booleani: la redazione è a lista bianca, e non si
   * aggiunge un campo «perché sarebbe comodo vederlo».
   */
  extra?: Record<string, string | number | boolean | null>;
}

/** Il codice PostgREST dell'errore, se c'è. Serve a distinguere `42703`
 *  (colonna assente sul DB della CI, non migrato) da un guasto vero. */
function codice(err: unknown): string | null {
  return (err as { code?: string } | null)?.code ?? null;
}

/**
 * La sede di UN BAMBINO. `null` = non l'ho potuta stabilire (riga assente,
 * `scuola_id` vuota, oppure lettura fallita — la riga di log distingue i casi).
 *
 * È la sorgente PREFERITA ovunque ci sia un bambino di mezzo: una conversazione
 * di chat parla sempre di UN bambino, e quel bambino ha UN plesso.
 */
export async function sedeDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  ctx: ContestoSede,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('alunni')
    .select('scuola_id')
    .eq('id', alunnoId)
    .maybeSingle();
  if (error) {
    logEvento(ctx.gruppo, 'warn', {
      operazione: ctx.operazione,
      esito: 'sede-bambino-non-letta',
      ...(ctx.extra ?? {}),
      error_code: codice(error),
    }, error);
  }
  return ((data as { scuola_id?: unknown } | null)?.scuola_id as string | null) ?? null;
}

/**
 * La sede dell'ACCOUNT di un membro dello staff (`utenti.scuola_id`).
 *
 * ⚠️ RIPIEGO, MAI PRIMA SCELTA, e mai su chi preme il pulsante. Si usa
 * sull'altra parte della conversazione — il DOCENTE del thread — perché lo
 * staff una sede propria ce l'ha sempre e i genitori no. Chiederla a chi ha
 * premuto significherebbe rimettere in piedi il difetto che questo modulo esiste
 * per chiudere.
 */
export async function sedeDiAccount(
  supabase: SupabaseClient,
  utenteId: string,
  ctx: ContestoSede,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('utenti')
    .select('scuola_id')
    .eq('id', utenteId)
    .maybeSingle();
  if (error) {
    logEvento(ctx.gruppo, 'warn', {
      operazione: ctx.operazione,
      esito: 'sede-docente-non-letta',
      ...(ctx.extra ?? {}),
      error_code: codice(error),
    }, error);
  }
  return ((data as { scuola_id?: unknown } | null)?.scuola_id as string | null) ?? null;
}

/**
 * Le sedi dei FIGLI di un account genitore, senza doppioni.
 *
 * Elenco vuoto = «non lo so» (nessun figlio, o nessuno con un plesso), MAI
 * «nessuno»: chi chiama non deve accodare una notifica senza destinatari, che
 * sarebbe rumore con l'aria di un successo.
 *
 * L'elenco di partenza viene da `getFigliDiGenitore`, che parte dall'ACCOUNT
 * autenticato: gli id non arrivano mai dalla richiesta, e non c'è niente da
 * filtrare per sede — è il legame genitore↔figlio a delimitare, non il plesso.
 * Un filtro di sede qui sarebbe perfino sbagliato: due fratelli possono stare in
 * due plessi, e la famiglia li segue entrambi.
 */
export async function sediDeiFigli(
  supabase: SupabaseClient,
  accountGenitore: string,
  ctx: ContestoSede,
): Promise<string[]> {
  const figli = await getFigliDiGenitore(supabase, accountGenitore);
  if (figli.length === 0) return [];

  const { data, error } = await supabase.from('alunni').select('scuola_id').in('id', figli);
  if (error) {
    logEvento(ctx.gruppo, 'warn', {
      operazione: ctx.operazione,
      esito: 'sedi-figli-non-lette',
      ...(ctx.extra ?? {}),
      // Solo il CONTEGGIO: gli id sono di minori.
      n: figli.length,
      error_code: codice(error),
    }, error);
    return [];
  }
  return [
    ...new Set(
      ((data ?? []) as { scuola_id?: unknown }[])
        .map((r) => r.scuola_id)
        .filter((s): s is string => typeof s === 'string' && s !== ''),
    ),
  ];
}
