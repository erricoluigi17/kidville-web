import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { logEvento } from '@/lib/logging/logger';
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami';

/* ════════════════════════════════════════════════════════════════════════════
 * SCRIVERE UN LEGAME GENITORE↔BAMBINO — e le tabelle vive sono DUE.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Fino a oggi un genitore già in archivio si poteva riusare in un modo solo: per
 * COLLISIONE DI CODICE FISCALE dentro `linkOrCreateParent`. Nessuna ricerca,
 * nessuna scelta, e — soprattutto — nessun modo di SCOLLEGARE: gli unici DELETE
 * sui legami stavano dentro le funzioni SQL di annullamento import, che da una
 * schermata non si raggiungono. Correggere «madre» in «padre» dopo il
 * salvataggio non era possibile affatto.
 *
 * ─── LE DUE TABELLE, MISURATE E NON DEDOTTE ─────────────────────────────────
 *
 * Sul database di produzione, il 2026-09-05:
 *
 *   student_parents         885 righe   parent_id → `parents.id`  (ANAGRAFICA)
 *   legame_genitori_alunni  818 righe   genitore_id → `utenti.id` (ACCOUNT)
 *   student_guardians        34 righe   scritta nel luglio 2026, MAI LETTA da src/
 *
 * `student_guardians` NON è la canonica e qui non si tocca: non la legge nessuno.
 * Le altre due sono entrambe vive e servono a cose diverse — `student_parents` la
 * legge il codice applicativo (`getFigliDiGenitore`, l'unione di `legami.ts`),
 * `legame_genitori_alunni` la leggono le **policy RLS del baseline** su
 * `pagamenti`, `incassi`, `note_disciplinari`, che interrogano quella tabella e
 * non si toccano.
 *
 * Scriverne una sola non rompe niente e non avvisa nessuno: apre il gate
 * applicativo lasciando chiusa la RLS (il genitore vede il figlio in anagrafica e
 * non vede i suoi pagamenti), oppure il contrario. Il disallineamento è già
 * misurabile — a Giugliano 301 alunni hanno una riga in `student_parents` e solo
 * 297 in `legame_genitori_alunni` — ed è esattamente ciò che
 * `sincronizzaLegamiRuntime` esiste per riparare. Qui la si CHIAMA invece di
 * riscriverne il corpo: la regola che dice come nasce una riga runtime (quota a
 * zero, `ignoreDuplicates` per non disfare ciò che ha deciso una persona) vive in
 * un posto solo.
 *
 * ─── PostgREST NON LANCIA ───────────────────────────────────────────────────
 *
 * Ogni lettura e ogni scrittura qui dentro controlla `{ error }`. Un `try/catch`
 * attorno a `await supabase.from(…)` non scatta mai, e su questo modulo il
 * silenzio ha un prezzo preciso: «il bambino non ha più genitori» e «non ho
 * potuto leggere i suoi legami» sono la stessa risposta vuota, e solo una delle
 * due autorizza a cancellare.
 *
 * ─── NIENTE NOMI NEI LOG ────────────────────────────────────────────────────
 *
 * Dissociare è il gesto che toglie a un adulto la vista su un minore, quindi si
 * logga — successo compreso — ma solo per uuid ed enum. La redazione
 * (`@/lib/logging/redact`) è a lista bianca e da qui passano bambini: nessun
 * nome, nessuna email, nessun codice fiscale, nemmeno «perché sarebbe comodo».
 * La riga DUREVOLE è quella dell'audit immodificabile (`logScrittura`), che porta
 * attore, ruolo, sede, entità e il prima/dopo.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Il vocabolario del ruolo, e non è un'invenzione di questo modulo: è quello che
 * `linkOrCreateParent` scrive già in `student_parents.relation_type` e che
 * `normalizeRelazione` (`src/lib/import/template.ts`) produce dall'import.
 *
 * In produzione la colonna contiene anche `madre` (10 righe) e `padre` (1) —
 * residui di un import del 2026 — più 579 `null`. Non si normalizzano da qui:
 * questa API scrive il vocabolario canonico, non riscrive lo storico.
 */
export const RELAZIONI_FAMILIARI = ['mother', 'father', 'delegate'] as const;
export type RelazioneFamiliare = (typeof RELAZIONI_FAMILIARI)[number];

/**
 * `is_primary` NON è un campo dell'API, ed è una decisione.
 *
 * La regola («madre e padre sono primari, un delegato no») esiste già in tre
 * punti del repo — `linkOrCreateParent`, `import/anagrafiche`, `prestampati` —
 * ed è la forma di difetto che questo repo sa nominare: una regola valida per più
 * strade deve vivere in un posto solo. Accettandola dal corpo della richiesta si
 * potrebbe salvare una «madre» non primaria, che nessuna schermata sa mostrare.
 */
export function ePrimario(relazione: RelazioneFamiliare): boolean {
  return relazione === 'mother' || relazione === 'father';
}

/** Che cosa è successo all'ANAGRAFICA (`student_parents`). */
export type EsitoAnagrafica = 'creata' | 'gia-presente' | 'rimossa' | 'aggiornata';

/**
 * Che cosa è successo al RUNTIME (`legame_genitori_alunni`).
 *
 * `senza-account` non è un guasto: l'anagrafica esiste ma non ha ancora un
 * `auth_user_id` (64 su 747 in produzione), quindi non c'è nessun `utenti.id` da
 * mettere in `genitore_id` e inventarne uno scriverebbe una FK rotta. Si ripara
 * da sé il giorno in cui la Segreteria invia le credenziali — è
 * `sincronizzaLegamiRuntime` a farlo. Va DETTO, però: «non l'ho scritta perché
 * non c'era un account» e «non sono riuscito a scriverla» hanno rimedi opposti.
 */
export type EsitoRuntime = 'creato' | 'gia-presente' | 'rimosso' | 'assente' | 'senza-account' | 'non-scritto';

export type MotivoRifiuto =
  /** Il legame che si vuole togliere o correggere non c'è. */
  | 'legame-inesistente'
  /** Toglierlo lascerebbe il bambino senza nessun adulto collegato. */
  | 'ultimo-genitore'
  /** Una lettura è fallita: non si può concludere niente, quindi non si scrive. */
  | 'lettura-fallita'
  /** La scrittura è stata respinta dal database, e NIENTE è cambiato. */
  | 'scrittura-fallita'
  /**
   * Lo STATO A METÀ dello `scollega`: la prima cancellazione è passata, la
   * seconda no. L'accesso è già stato tolto — l'adulto non vede più pagamenti,
   * incassi e note del bambino — e il legame in anagrafica è rimasto lì.
   *
   * NON è `scrittura-fallita`, ed è la differenza che il 2026-09-06 arrivava
   * capovolta davanti all'operatore: i due motivi finivano sullo stesso codice
   * `LEGAME_NON_SALVATO`, la cui frase di catalogo dice «niente è stato
   * modificato» — l'esatto contrario del vero, proprio nell'istante in cui un
   * adulto ha appena perso l'accesso ai dati di un minore. I rimedi sono
   * opposti: là si riprova e basta, qui si riprova SAPENDO che metà del gesto è
   * già avvenuta, e che finché non riesce l'altra metà l'elenco della famiglia
   * mostra un legame che a runtime non c'è più.
   */
  | 'mezzo-tolto';

export interface Rifiuto {
  ok: false;
  motivo: MotivoRifiuto;
  /** Prosa per l'operatore. Mai un `message` grezzo di PostgREST, mai un nome. */
  dettaglio: string;
}

export interface EsitoCollega {
  ok: true;
  parentId: string;
  anagrafica: Extract<EsitoAnagrafica, 'creata' | 'gia-presente'>;
  runtime: EsitoRuntime;
}

/**
 * ⚠️ `runtime` qui vale DUE valori soli, e non è una svista da riallargare:
 * `'rimosso'` (c'era e non c'è più) oppure `'assente'` (non c'era nessuna riga
 * runtime da togliere, perché l'adulto non ha un account). `'non-scritto'` non
 * è raggiungibile — quando la cancellazione runtime fallisce non si risponde
 * `ok: true`, si esce con un `Rifiuto` — e prometterlo nel tipo farebbe scrivere
 * alla UI un ramo che non si accende mai, cioè un avviso che nessuno vedrà.
 */
export interface EsitoScollega {
  ok: true;
  anagrafica: Extract<EsitoAnagrafica, 'rimossa'>;
  runtime: Extract<EsitoRuntime, 'rimosso' | 'assente'>;
}

export interface EsitoRuolo {
  ok: true;
  relation_type: RelazioneFamiliare;
  is_primary: boolean;
}

const GRUPPO = 'anagrafica';

/** Il codice PostgREST dell'errore, se c'è: distingue un guasto da uno schema assente. */
function codice(err: unknown): string | null {
  return (err as { code?: string } | null | undefined)?.code ?? null;
}

/**
 * L'account (`utenti.id`) dell'anagrafica, o `null` se non ne ha.
 *
 * Il terzo stato — «non l'ho potuto leggere» — non si appiattisce su `null`: chi
 * cancella deve sapere se la riga runtime non c'era o se non l'ha vista.
 */
async function accountDelGenitore(
  supabase: SupabaseClient,
  parentId: string,
): Promise<{ accountId: string | null; letto: boolean }> {
  const { data, error } = await supabase
    .from('parents')
    .select('auth_user_id')
    .eq('id', parentId)
    .maybeSingle();
  if (error) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:account',
      esito: 'ponte-non-letto',
      entita_tipo: 'parents',
      parent_id: parentId,
      error_code: codice(error),
    }, error);
    return { accountId: null, letto: false };
  }
  const id = (data as { auth_user_id?: unknown } | null)?.auth_user_id;
  return { accountId: typeof id === 'string' && id !== '' ? id : null, letto: true };
}

/** La riga anagrafica del legame, se esiste. `letto: false` = non si sa. */
async function legameAnagrafico(
  supabase: SupabaseClient,
  alunnoId: string,
  parentId: string,
): Promise<{ riga: Record<string, unknown> | null; letto: boolean }> {
  const { data, error } = await supabase
    .from('student_parents')
    .select('student_id, parent_id, relation_type, is_primary')
    .eq('student_id', alunnoId)
    .eq('parent_id', parentId)
    .maybeSingle();
  if (error) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:legame',
      esito: 'anagrafica-non-letta',
      entita_tipo: 'student_parents',
      alunno_id: alunnoId,
      parent_id: parentId,
      error_code: codice(error),
    }, error);
    return { riga: null, letto: false };
  }
  return { riga: (data as Record<string, unknown> | null) ?? null, letto: true };
}

/**
 * Resterebbe qualcuno collegato al bambino, tolto questo legame?
 *
 * Si contano ENTRAMBE le tabelle, e non è pignoleria: 6 righe di
 * `legame_genitori_alunni` in produzione non hanno una gemella in
 * `student_parents`. Contare una tabella sola direbbe «nessuno» dove un adulto
 * c'è ancora — cioè rifiuterebbe una dissociazione legittima — oppure, nel verso
 * opposto, autorizzerebbe a lasciare un bambino invisibile.
 *
 * `deciso: false` significa «non lo so» e vale come divieto: nel dubbio non si
 * toglie a un adulto la vista su un minore.
 */
async function restanoAltriAdulti(
  supabase: SupabaseClient,
  alunnoId: string,
  parentId: string,
  accountId: string | null,
): Promise<{ restano: boolean; deciso: boolean }> {
  const { data: sp, error: errSp } = await supabase
    .from('student_parents')
    .select('parent_id')
    .eq('student_id', alunnoId);
  if (errSp) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:residui',
      esito: 'anagrafica-non-letta',
      entita_tipo: 'student_parents',
      alunno_id: alunnoId,
      error_code: codice(errSp),
    }, errSp);
    return { restano: false, deciso: false };
  }
  const altriInAnagrafica = ((sp ?? []) as { parent_id?: unknown }[]).some(
    (r) => typeof r.parent_id === 'string' && r.parent_id !== parentId,
  );

  const { data: lga, error: errLga } = await supabase
    .from('legame_genitori_alunni')
    .select('genitore_id')
    .eq('alunno_id', alunnoId);
  if (errLga) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:residui',
      esito: 'runtime-non-letto',
      entita_tipo: 'legame_genitori_alunni',
      alunno_id: alunnoId,
      error_code: codice(errLga),
    }, errLga);
    return { restano: false, deciso: false };
  }
  const altriARuntime = ((lga ?? []) as { genitore_id?: unknown }[]).some(
    (r) => typeof r.genitore_id === 'string' && r.genitore_id !== accountId,
  );

  return { restano: altriInAnagrafica || altriARuntime, deciso: true };
}

/**
 * COLLEGA un'anagrafica già esistente a un bambino, su ENTRAMBE le tabelle.
 *
 * Il verso è indifferente — «aggiungi una madre a questo bambino» e «aggiungi un
 * figlio a questa madre» sono lo stesso legame, e questa è la sola funzione che
 * lo scrive. Il perimetro (di chi è il bambino, di chi è il genitore) lo decide
 * il CHIAMANTE con `assertAlunnoInScope`/`assertParentInScope`: qui non si
 * verifica nessuna sede, e questo commento è l'unica ragione per cui è lecito.
 *
 * Un legame che c'è già NON viene riscritto: si risponde `gia-presente` e il
 * ruolo resta quello che una persona aveva scelto. Cambiarlo è un gesto a parte
 * (`cambiaRuoloFamiliare`), perché un «collega» che degrada una madre a delegata
 * per il valore di default di un modulo è esattamente il tipo di scrittura
 * silenziosa che questo repo ha già pagato.
 */
export async function collegaFamiliare(
  supabase: SupabaseClient,
  actor: AppUser,
  { alunnoId, parentId, relazione, scuolaId }: {
    alunnoId: string;
    parentId: string;
    relazione: RelazioneFamiliare;
    scuolaId?: string | null;
  },
): Promise<EsitoCollega | Rifiuto> {
  const { riga, letto } = await legameAnagrafico(supabase, alunnoId, parentId);
  if (!letto) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile leggere i legami di questo bambino: niente è stato modificato.' };
  }

  let anagrafica: EsitoCollega['anagrafica'] = 'gia-presente';
  if (!riga) {
    const { error } = await supabase.from('student_parents').insert({
      student_id: alunnoId,
      parent_id: parentId,
      relation_type: relazione,
      is_primary: ePrimario(relazione),
    });
    // `23505` = chiave duplicata: qualcun altro ha collegato lo stesso legame fra
    // la lettura e la scrittura. Non è un guasto, è il risultato che si voleva.
    if (error && codice(error) !== '23505') {
      logEvento(GRUPPO, 'error', {
        operazione: 'anagrafiche/legami-scrittura:collega',
        esito: 'anagrafica-non-scritta',
        entita_tipo: 'student_parents',
        alunno_id: alunnoId,
        parent_id: parentId,
        error_code: codice(error),
      }, error);
      return { ok: false, motivo: 'scrittura-fallita', dettaglio: 'Il collegamento non è stato salvato: niente è stato modificato.' };
    }
    anagrafica = error ? 'gia-presente' : 'creata';
  }

  // ── LA SECONDA TABELLA. Non è un dettaglio: senza questa riga il genitore
  //    resta fuori dalle policy RLS di `pagamenti`, `incassi` e
  //    `note_disciplinari`, e nessuna schermata lo dice.
  const runtime = await allineaRuntime(supabase, alunnoId, parentId);

  await logScrittura(supabase, {
    attore: actor,
    entitaTipo: 'legame',
    entitaId: alunnoId,
    azione: 'insert',
    scuolaId: scuolaId ?? null,
    valoreDopo: { student_id: alunnoId, parent_id: parentId, relation_type: relazione, is_primary: ePrimario(relazione) },
  });
  // Si logga anche il SUCCESSO: senza, «nessun log» non distingue «tutto ok» da
  // «non è mai partito niente».
  logEvento(GRUPPO, 'info', {
    operazione: 'anagrafiche/legami-scrittura:collega',
    azione: 'collega',
    esito: `${anagrafica}/${runtime}`,
    alunno_id: alunnoId,
    parent_id: parentId,
    attore_id: actor.id,
    ruolo: actor.role ?? null,
  });

  // ⚠️ `ok: true` ANCHE con `runtime: 'non-scritto'`, ed è deliberato: la riga
  // anagrafica c'è davvero, quindi rispondere «non salvato» sarebbe falso, e
  // disfarla per tornare indietro cancellerebbe un legame che, se era già lì,
  // l'aveva messo una persona. Lo stato che resta è metà — il genitore vede il
  // figlio in anagrafica e NON vede i suoi pagamenti, perché le policy RLS
  // leggono l'altra tabella — ma è uno stato RIPARABILE ripetendo lo stesso
  // gesto: al secondo giro l'anagrafica risponde `gia-presente` e la riga
  // runtime viene ritentata (e si ripara da sé anche il giorno in cui la
  // Segreteria manda le credenziali, via `sincronizzaLegamiRuntime`).
  //
  // Perciò `runtime: 'non-scritto'` è un AVVISO DA MOSTRARE, non un dettaglio da
  // ignorare perché lo status è 200: chi rende questa risposta lo dica in
  // chiaro, altrimenti l'unico segnale resta la riga `runtime-non-creato` in
  // `app_log`, che l'operatore non legge. Vale anche per `'senza-account'`, che
  // però ha un rimedio diverso (mandare le credenziali) e non è un guasto.
  return { ok: true, parentId, anagrafica, runtime };
}

/**
 * Porta la riga runtime allo stato dell'anagrafica e DICE che cos'è successo.
 *
 * La scrittura la fa `sincronizzaLegamiRuntime` (`legami.ts`), che è il posto in
 * cui vive già la regola: quota a zero per chi arriva dopo, `ignoreDuplicates`
 * per non disfare l'intestatario che una persona ha scelto a mano. Quella
 * funzione però risponde `{ creati }` e basta — con `creati: 0` che significa
 * insieme «c'era già», «non ha un account» e «la scrittura è stata respinta».
 * Qui si rilegge la riga per distinguerli, perché è la differenza che decide se
 * l'operatore deve fare qualcosa.
 */
async function allineaRuntime(
  supabase: SupabaseClient,
  alunnoId: string,
  parentId: string,
): Promise<EsitoRuntime> {
  const { accountId, letto } = await accountDelGenitore(supabase, parentId);
  if (!letto) return 'non-scritto';
  if (!accountId) return 'senza-account';

  const prima = await esisteRuntime(supabase, alunnoId, accountId);
  if (prima === true) return 'gia-presente';

  await sincronizzaLegamiRuntime(supabase, parentId);

  const dopo = await esisteRuntime(supabase, alunnoId, accountId);
  if (dopo === true) return 'creato';
  if (dopo === null) return 'non-scritto';
  logEvento(GRUPPO, 'error', {
    operazione: 'anagrafiche/legami-scrittura:collega',
    esito: 'runtime-non-creato',
    entita_tipo: 'legame_genitori_alunni',
    alunno_id: alunnoId,
    parent_id: parentId,
  });
  return 'non-scritto';
}

/** `true`/`false` se si è potuto leggere, `null` se la lettura è fallita. */
async function esisteRuntime(
  supabase: SupabaseClient,
  alunnoId: string,
  accountId: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('alunno_id', alunnoId)
    .eq('genitore_id', accountId)
    .maybeSingle();
  if (error) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:runtime',
      esito: 'runtime-non-letto',
      entita_tipo: 'legame_genitori_alunni',
      alunno_id: alunnoId,
      error_code: codice(error),
    }, error);
    return null;
  }
  return data !== null;
}

/**
 * SCOLLEGA un adulto da un bambino, su ENTRAMBE le tabelle.
 *
 * ⚠️ SI RIFIUTA DI LASCIARE UN BAMBINO SENZA NESSUN ADULTO. Un alunno senza
 * legami non è «un alunno con un campo vuoto»: è un bambino che nessun genitore
 * vede più — niente diario, niente galleria, niente pagamenti, niente chat — e
 * che nessuno può recuperare dall'app, perché il modo di ricollegarlo è proprio
 * questa rotta. In produzione cinque alunni sono già in quello stato: il rimedio
 * non è aggiungerne un sesto, è dire all'operatore di collegare prima l'altro
 * genitore. Un rifiuto che non dice il rimedio è un rifiuto che torna.
 *
 * ⚠️ L'ORDINE DELLE DUE CANCELLAZIONI È DELIBERATO: prima il RUNTIME, poi
 * l'anagrafica. Se la seconda fallisce, l'adulto ha comunque perso l'accesso —
 * che è ciò che l'operatore ha chiesto — e il legame anagrafico residuo si vede
 * e si ritenta. Nell'ordine opposto un guasto lascerebbe viva la riga che apre
 * la RLS, cioè la dissociazione sarebbe riuscita «a schermo» e fallita dove
 * conta.
 */
export async function scollegaFamiliare(
  supabase: SupabaseClient,
  actor: AppUser,
  { alunnoId, parentId, scuolaId }: { alunnoId: string; parentId: string; scuolaId?: string | null },
): Promise<EsitoScollega | Rifiuto> {
  const { accountId, letto: accountLetto } = await accountDelGenitore(supabase, parentId);
  if (!accountLetto) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile leggere l’anagrafica di questo adulto: niente è stato modificato.' };
  }

  const { riga, letto } = await legameAnagrafico(supabase, alunnoId, parentId);
  if (!letto) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile leggere i legami di questo bambino: niente è stato modificato.' };
  }
  const runtimePrima = accountId ? await esisteRuntime(supabase, alunnoId, accountId) : false;
  if (runtimePrima === null) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile leggere i legami di questo bambino: niente è stato modificato.' };
  }
  if (!riga && !runtimePrima) {
    return { ok: false, motivo: 'legame-inesistente', dettaglio: 'Questo adulto non risulta collegato a questo bambino: ricarica l’elenco.' };
  }

  const { restano, deciso } = await restanoAltriAdulti(supabase, alunnoId, parentId, accountId);
  if (!deciso) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile verificare gli altri genitori di questo bambino: nessun legame è stato tolto.' };
  }
  if (!restano) {
    return {
      ok: false,
      motivo: 'ultimo-genitore',
      dettaglio:
        'Questo è l’unico adulto collegato al bambino: togliendolo, nessun genitore vedrebbe più diario, galleria, pagamenti e messaggi. Collega prima l’altro genitore, poi scollega questo.',
    };
  }

  // 1ª cancellazione — il RUNTIME, cioè l'accesso vero (vedi l'ordine, sopra).
  let runtime: EsitoScollega['runtime'] = 'assente';
  if (accountId && runtimePrima) {
    const { error } = await supabase
      .from('legame_genitori_alunni')
      .delete()
      .eq('alunno_id', alunnoId)
      .eq('genitore_id', accountId);
    if (error) {
      logEvento(GRUPPO, 'error', {
        operazione: 'anagrafiche/legami-scrittura:scollega',
        esito: 'runtime-non-rimosso',
        entita_tipo: 'legame_genitori_alunni',
        alunno_id: alunnoId,
        parent_id: parentId,
        error_code: codice(error),
      }, error);
      return { ok: false, motivo: 'scrittura-fallita', dettaglio: 'Il legame non è stato tolto: niente è stato modificato.' };
    }
    runtime = 'rimosso';
  }

  // 2ª cancellazione — l'anagrafica.
  if (riga) {
    const { error } = await supabase
      .from('student_parents')
      .delete()
      .eq('student_id', alunnoId)
      .eq('parent_id', parentId);
    if (error) {
      // Stato misto DICHIARATO — ma solo se la prima cancellazione È avvenuta.
      // `runtime` qui vale `'rimosso'` oppure `'assente'`, e i due casi non si
      // raccontano uguale: se non c'era nessuna riga runtime da togliere (adulto
      // senza account) allora davvero NIENTE è stato modificato, e dire
      // «l'accesso è stato tolto» manderebbe l'operatore a cercare un guasto che
      // non esiste. Il motivo cambia con lo stato, non con la simmetria del
      // codice.
      const mezzo = runtime === 'rimosso';
      // Livello `error` perché va in tabella: è la riga con cui ci si accorge che
      // una dissociazione va ritentata.
      logEvento(GRUPPO, 'error', {
        operazione: 'anagrafiche/legami-scrittura:scollega',
        esito: mezzo ? 'anagrafica-non-rimossa-runtime-gia-tolto' : 'anagrafica-non-rimossa',
        entita_tipo: 'student_parents',
        alunno_id: alunnoId,
        parent_id: parentId,
        error_code: codice(error),
      }, error);
      return mezzo
        ? {
            ok: false,
            motivo: 'mezzo-tolto',
            dettaglio:
              'L’accesso è stato tolto ma il legame in anagrafica è rimasto: riprova a scollegare fra qualche istante.',
          }
        : {
            ok: false,
            motivo: 'scrittura-fallita',
            dettaglio: 'Il legame non è stato tolto: niente è stato modificato.',
          };
    }
  }

  await logScrittura(supabase, {
    attore: actor,
    entitaTipo: 'legame',
    entitaId: alunnoId,
    azione: 'delete',
    scuolaId: scuolaId ?? null,
    valorePrima: {
      student_id: alunnoId,
      parent_id: parentId,
      relation_type: (riga as { relation_type?: unknown } | null)?.relation_type ?? null,
    },
  });
  // Il gesto che toglie a un adulto la vista su un minore lascia una riga anche
  // quando riesce: chi · quando · quale legame, per uuid.
  logEvento(GRUPPO, 'info', {
    operazione: 'anagrafiche/legami-scrittura:scollega',
    azione: 'scollega',
    esito: `rimossa/${runtime}`,
    alunno_id: alunnoId,
    parent_id: parentId,
    attore_id: actor.id,
    ruolo: actor.role ?? null,
  });

  return { ok: true, anagrafica: 'rimossa', runtime };
}

/**
 * Corregge il ruolo di un legame che esiste già (madre / padre / delegato).
 *
 * Tocca la SOLA `student_parents`, e va detto invece di lasciarlo intendere:
 * `legame_genitori_alunni` una colonna `relation_type` non ce l'ha — porta la
 * quota di fatturazione, non il grado di parentela — quindi qui non c'è una
 * seconda scrittura da fare. Non è una dimenticanza: è lo schema.
 *
 * `is_primary` si RICALCOLA dal ruolo (`ePrimario`) invece di essere accettato
 * dal corpo: le due colonne dicono la stessa cosa e non devono poter divergere.
 */
export async function cambiaRuoloFamiliare(
  supabase: SupabaseClient,
  actor: AppUser,
  { alunnoId, parentId, relazione, scuolaId }: {
    alunnoId: string;
    parentId: string;
    relazione: RelazioneFamiliare;
    scuolaId?: string | null;
  },
): Promise<EsitoRuolo | Rifiuto> {
  const { riga, letto } = await legameAnagrafico(supabase, alunnoId, parentId);
  if (!letto) {
    return { ok: false, motivo: 'lettura-fallita', dettaglio: 'Non è stato possibile leggere questo legame: niente è stato modificato.' };
  }
  if (!riga) {
    return { ok: false, motivo: 'legame-inesistente', dettaglio: 'Questo adulto non risulta collegato a questo bambino: ricarica l’elenco.' };
  }

  const is_primary = ePrimario(relazione);
  const { error } = await supabase
    .from('student_parents')
    .update({ relation_type: relazione, is_primary })
    .eq('student_id', alunnoId)
    .eq('parent_id', parentId);
  if (error) {
    logEvento(GRUPPO, 'error', {
      operazione: 'anagrafiche/legami-scrittura:ruolo',
      esito: 'ruolo-non-scritto',
      entita_tipo: 'student_parents',
      alunno_id: alunnoId,
      parent_id: parentId,
      error_code: codice(error),
    }, error);
    return { ok: false, motivo: 'scrittura-fallita', dettaglio: 'Il ruolo non è stato salvato: niente è stato modificato.' };
  }

  await logScrittura(supabase, {
    attore: actor,
    entitaTipo: 'legame',
    entitaId: alunnoId,
    azione: 'update',
    scuolaId: scuolaId ?? null,
    valorePrima: { student_id: alunnoId, parent_id: parentId, relation_type: (riga as { relation_type?: unknown }).relation_type ?? null },
    valoreDopo: { student_id: alunnoId, parent_id: parentId, relation_type: relazione, is_primary },
  });
  logEvento(GRUPPO, 'info', {
    operazione: 'anagrafiche/legami-scrittura:ruolo',
    azione: 'cambia-ruolo',
    esito: relazione,
    alunno_id: alunnoId,
    parent_id: parentId,
    attore_id: actor.id,
    ruolo: actor.role ?? null,
  });

  return { ok: true, relation_type: relazione, is_primary };
}
