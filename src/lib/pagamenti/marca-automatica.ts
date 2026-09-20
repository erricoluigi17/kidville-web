import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// ─────────────────────────────────────────────────────────────────────────────
// LA MARCA «QUESTO ABBINAMENTO L'HA DECISO LA MACCHINA» — c'è o non c'è.
//
// `riconciliazione_movimenti.abbinato_auto_il` (migrazione `20260920124742`) è
// una colonna `timestamptz` che nasce NULL e che scrive SOLO l'abbinamento
// automatico, dentro lo stesso compare-and-swap che conferma la riga. Non è un
// quinto stato — `stato` resta `confermato` sia che ad abbinare sia stata una
// persona sia che sia stata l'applicazione — ed è l'unico appiglio
// dell'annullamento in blocco: «disfa tutto ciò che l'import ha deciso da solo».
//
// ─── 🔴 LA DECISIONE SUL RAMO DI DEGRADAZIONE, E NON È «SI PROCEDE SENZA» ────
//
// Il database E2E della CI è un progetto separato e NON è migrato: lì questa
// colonna non esiste, e PostgREST risponde `42703` in lettura e `PGRST204` in
// scrittura. La regola di casa, per una colonna nuova, è «si degrada»: si
// ritenta senza e si va avanti.
//
// **Qui no, e la differenza è stata decisa apposta.** Senza la marca non esiste
// l'annullamento in blocco, e un automatismo che non si può disfare non è quello
// che è stato chiesto: sarebbe un abbinamento deciso da nessuno, su denaro vero,
// che nessuno può più distinguere da quello fatto a mano. Quindi colonna assente
// ⇒ **l'abbinamento automatico si spegne per intero**, con un log `warn`. Ciò
// che resta acceso è tutto il percorso MANUALE, che questa colonna non la scrive
// e non la legge: la coda, i suggerimenti, la conferma a voce singola e la
// composizione continuano a funzionare esattamente come prima.
//
// ⚠️ È il ramo che gira in CI, non un caso di scuola: sul DB E2E la risposta di
// questa funzione è `false` SEMPRE, e l'E2E dell'import deve restare verde
// proprio grazie a quel `false`.
//
// ─── PERCHÉ UNA FUNZIONE ESPORTATA E NON UN `if` DENTRO CHI ABBINA ──────────
//
// Perché le porte che chiederanno «posso marcare?» stanno per essere più d'una —
// l'import che confermerà da sé, l'annullamento in blocco che cerca le righe
// marcate — e in questo repository un predicato scritto in linea in due punti
// diverge il giorno dopo essere nato. La domanda ha un posto solo, e ci passano
// tutti.
//
// ─── 🔴 E LA RIAPERTURA **NON** PASSA DI QUI (corretto il 2026-09-20) ────────
//
// Fino a oggi questa testata elencava fra i chiamanti anche «la riapertura, che
// le smarca», e la rotta `pagamenti/riconciliazione/[id]:PATCH` la chiamava
// davvero. Era il chiamante SBAGLIATO, e il motivo è tutto nel verso in cui
// questa funzione sbaglia.
//
// Qui si risponde a UNA domanda: «l'automatismo deve PARTIRE?». Su «non lo so»
// si risponde `false`, e va bene: l'automatismo non parte, il lavoro resta a una
// persona, che è l'errore recuperabile.
//
// La riapertura fa la domanda OPPOSTA — «posso SPEGNERE la marca?» — e lì lo
// stesso `false` è il verso sbagliato: su un guasto transitorio (timeout, 5xx di
// PostgREST, pool esaurito) la riapertura proseguiva, STORNO COMPRESO, e la riga
// tornava in coda ancora marcata «automatica». Poi la riconferma fatta a mano da
// `confermaSuVoceSingola` non la spegne — là `abbinato_auto_il` si scrive solo
// quando `automatico` è vero — e l'annullamento in blocco disfa il lavoro di una
// persona. Cioè, esattamente, la marca che mente: la cosa che questa colonna
// esiste per impedire.
//
// La rotta chiede perciò `abbinato_auto_il` dentro la LETTURA DEL MOVIMENTO che
// fa comunque (`MOV_SELECT_MARCA`): lì un `42703` degrada e qualunque altro
// errore esce 500 PRIMA dello storno. Una lettura in meno, e il verso giusto.
// Chi aggiungerà un chiamante si chieda prima quale delle due domande sta
// facendo: questa funzione risponde bene solo alla prima.
//
// L'ESITO NON SI MEMORIZZA fra una richiesta e l'altra: una migrazione applicata
// mentre il processo è vivo cambierebbe la risposta, e una cache renderebbe
// l'automatismo spento fino al prossimo riavvio (o acceso su uno schema che non
// c'è più). Costa una `SELECT … LIMIT 1` su un indice: si paga.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La colonna che porta la marca. Scritta UNA volta, qui, perché i due codici di
 * degradazione qui sotto e il nome della colonna sono la stessa decisione: chi
 * un giorno la rinominasse deve trovarli insieme.
 */
export const COLONNA_MARCA_AUTO = 'abbinato_auto_il'

/**
 * «La colonna non esiste su questo database»: `42703` è la risposta di PostgREST
 * a una `SELECT`, `PGRST204` quella a un `INSERT`/`UPDATE`. Sono due codici per
 * lo stesso fatto, e vanno tenuti insieme: questa sonda legge, ma chi la
 * interroga poi SCRIVE, e il giorno in cui qualcuno guardasse un solo codice
 * l'altro ramo cadrebbe invece di spegnersi.
 */
export const MARCA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * La marca dell'abbinamento automatico è scrivibile su questo database?
 *
 * `true` ⇒ l'automatismo può marcare, e quindi l'annullamento in blocco potrà
 * disfare ciò che ha deciso. `false` ⇒ l'automatismo NON deve partire affatto
 * (vedi il riquadro in testata): non è un permesso in meno, è la funzione intera
 * che si spegne.
 *
 * ⚠️ FAIL-CLOSED ANCHE SUL GUASTO, e non solo sulla colonna assente. Un errore
 * di lettura che non sia `42703`/`PGRST204` significa «non lo so», e «non lo so»
 * non è «sì»: partire lo stesso vorrebbe dire scommettere che la marca si
 * scriverà: se poi non si scrive, la riga è già confermata e non la ritrova più
 * nessuno. Il verso in cui si sbaglia è quello che lascia il lavoro a una
 * persona, che è l'unico recuperabile.
 *
 * 🔴 PROPRIO PER QUESTO NON SI USA PER DECIDERE SE SPEGNERE LA MARCA. Quella è
 * la domanda opposta, e lì `false` su «non lo so» lascia ACCESA una marca che
 * mente invece di spegnerla: il verso non recuperabile. Il riquadro in testata
 * racconta il chiamante che è stato tolto, e perché.
 *
 * @param operazione il nome dell'operazione nei log: lo dichiara il chiamante,
 *   che è l'unico a sapere se sta rispondendo a uno schermo o chiudendo un
 *   import notturno.
 */
export async function marcaAutomaticaDisponibile(
  supabase: SupabaseClient,
  operazione: string,
): Promise<boolean> {
  // PostgREST non lancia: ritorna `{ error }`. Un `try/catch` qui non scatterebbe
  // mai, e con l'errore scartato dalla destrutturazione «la colonna non c'è»
  // diventerebbe «la colonna c'è e non ha righe» — cioè l'automatismo partirebbe
  // proprio sull'ambiente in cui la marca non si può scrivere.
  const { error } = await supabase
    .from('riconciliazione_movimenti')
    .select(COLONNA_MARCA_AUTO)
    .limit(1)

  if (!error) return true

  const code = (error as { code?: string }).code ?? ''
  if (MARCA_ASSENTE.has(code)) {
    // `warn` e non `info`: un automatismo spento che nessuno vede è la prima
    // metà di ogni guasto lungo di questo repository. Non è `error` perché su
    // questo ambiente è lo stato ATTESO — il DB E2E non è migrato — e un canale
    // rosso a ogni giro di CI smette di essere guardato.
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'abbinamento-automatico-spento',
      tipo: 'colonna-marca-assente',
      error_code: code,
    })
    return false
  }

  // Qualunque altro errore è un guasto vero, e qui `error` è il livello giusto:
  // su un database migrato questa lettura non ha una ragione di SCHEMA per
  // fallire, quindi ciò che resta sono i guasti transitori — deadlock, timeout,
  // pool esaurito, un 5xx di PostgREST — e su ognuno di quelli l'automatismo
  // resta spento senza che nessuno l'abbia deciso.
  //
  // ⚠️ QUI PRIMA C'ERA SCRITTO «questa lettura NON PUÒ fallire», ed era falso:
  // proprio quei guasti la fanno fallire, ed è per questo che un chiamante che
  // usasse questo `false` per decidere di SPEGNERE la marca sbaglierebbe verso.
  // Una frase assoluta in un commento è il modo in cui un ramo raro si fa
  // scambiare per impossibile.
  logEvento(
    'pagamento',
    'error',
    { operazione, esito: 'marca-automatica-non-verificabile', error_code: code },
    error,
  )
  return false
}
