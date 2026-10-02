import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendPush, vapidConfigured } from '@/lib/push/web-push'
import { sendNativePush, fcmConfigured, type NativePushPayload } from '@/lib/push/native-push'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { TIPI_AVVISO_CODA } from '@/lib/fatture-coda/avvisi-testi'
import { ENTITA_CHAT_THREAD, TIPI_NOTIFICA_CHAT } from '@/lib/chat/notifiche-chat'
import { marcaConsegnati } from '@/lib/chat/delivered'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'

// =============================================================================
// IL DISPATCH DELLE PUSH — estratto dalla route `/api/push/dispatch` (PS2, 24/09).
//
// Una funzione sola, `eseguiDispatch`, riusabile da chi deve spedire SUBITO (la chat, 30 s
// dopo il messaggio: compito PS3) oltre che dal cron ogni 5 minuti. Non lancia mai: ogni
// guasto diventa una riga di log e un esito `{ stato: 500 }`.
//
// PERCHÉ LA PRESA ATOMICA. Fino al 24/09 il dispatch leggeva le notifiche in coda, spediva, e
// marcava `push_inviata_il` a FINE giro. Due giri sovrapposti (il cron e, da PS3, la chat)
// leggevano le stesse righe e le spedivano entrambi: il doppione misurato in produzione. Ora le
// notifiche si PRENDONO prima di spedirle, con un UPDATE condizionato:
//
//   update notifiche set push_inviata_il = <adesso>
//    where id in (<candidate>) and push_inviata_il is null
//   returning id
//
// e si spedisce SOLO ciò che l'UPDATE ha restituito. In Postgres l'UPDATE è atomico riga per
// riga: se due giri tentano la stessa riga, il secondo aspetta il lock del primo, rilegge la
// riga aggiornata, trova `push_inviata_il` non più NULL e la salta. Nessuna RPC: il filtro
// `.is('push_inviata_il', null)` sull'UPDATE di PostgREST È la condizione (per questo non c'è
// la migrazione `push_presa_atomica`: non serve).
//
// IL PREZZO DELLA PRESA, e come si paga. Prima un giro che moriva a metà (timeout della
// funzione) lasciava le notifiche NON marcate: al giro dopo ripartivano, magari doppie. Ora le
// lascerebbe PRESE e mai spedite — perse, che è peggio. Tre difese:
//  · il TETTO DI TEMPO del giro, guardato DUE volte. Subito prima della presa
//    (`SOGLIA_PRESA_MS`): se le letture l'hanno già consumato non si prende niente, e le
//    notifiche restano in coda intatte. Serve perché le letture che precedono la presa sono GET,
//    e postgrest-js le RITENTA DA SOLO su 503/520 e sugli errori di rete (fino a 4 tentativi,
//    ognuno al suo tetto, con un backoff di 1/2/4 s o l'attesa di un `Retry-After` SENZA limite
//    superiore: vedi `verràRitentato` in `@/lib/logging/supabase-fetch`): il loro tempo non ha
//    un tetto calcolabile. Con il controllo non conta più: se la Function muore lì, non è stato
//    preso niente. Poi dentro il ciclo (`TETTO_GIRO_MS`): passato quello non si comincia una
//    notifica nuova, e quelle prese e non ancora tentate tornano in coda (`rinviate_per_tempo`);
//  · il BUDGET DEI RITENTATIVI (`BUDGET_RITENTATIVI_MS`): passato quello, `sendNativePush` non
//    aspetta più i suoi 1 s + 3 s di ritentativi immediati — la notifica, se il guasto è
//    transitorio, torna comunque in coda;
//  · la DURATA DELLA FUNZIONE: il tetto serve solo se la piattaforma lascia arrivare il giro fin
//    lì, e non basta «il tetto più una notifica»: il tetto si guarda solo prima di cominciare
//    una notifica e il budget per dispositivo, quindi un invio nativo cominciato poco prima del
//    budget ha ancora tutti i ritentativi (fino a 60 s), e ogni altro dispositivo della notifica
//    in corso aggiunge il suo. Il caso peggiore, ricavato dai tetti (le letture prima della
//    presa non ci entrano: le copre il controllo di `SOGLIA_PRESA_MS`), è
//    `DURATA_MINIMA_FUNZIONE_S` in `./durata-dispatch.ts`; ogni route che chiama
//    `eseguiDispatch` dichiara un `export const maxDuration` almeno così lungo. Senza, una
//    Function si ferma prima e le notifiche prese restano perse. Lo impone il lock in
//    `__tests__/lib/push-dispatch-durata.test.ts`.
//
// A BLOCCHI, OGNI `.in()`. PostgREST mette `.in()` nella query string: 500 uuid sono ~18,5 kB e
// un proxy risponde 414 (`@/lib/db/blocchi`). La presa è la porta di TUTTI gli invii: rifiutata
// lei, la lettura dopo ripescherebbe le stesse 500 righe e la coda si fermerebbe per sempre.
//
// IL RITORNO IN CODA (spec 24/09, «Errori FCM 5xx e timeout: … se nessun telefono l'ha ricevuta
// resta in coda fino a 30'»). Se nessun dispositivo ha ricevuto la notifica e TUTTI quelli
// tentati hanno dato un errore ritentabile (5xx, timeout, rete, `429`: lo decide
// `sendNativePush`, compito PS1), la presa si annulla e la notifica ripartirà al giro dopo —
// fino a 30 minuti dalla sua programmazione (`invio_programmato_il`, o `creato_il` se non era
// programmata). Dopo ci si arrende: resta marcata e una riga `error` lo dice. Basta UN
// dispositivo che l'ha ricevuta, invece, e resta marcata: rispedirla vorrebbe dire un doppione
// su quel telefono.
//
// LA DOPPIA SPUNTA DELLA CHAT — D1 (30/09). Una mamma ha visto per cinque ore una spunta sola e ha
// creduto che il messaggio non fosse arrivato. Il titolare ha deciso che «Consegnato» vuol dire
// QUANDO IL MESSAGGIO ARRIVA, e le strade sono due: D2, l'app di chi riceve è aperta e la
// campanella consegna (`consegnaSeInAttesa` in `@/lib/chat/delivered`); e D1, qui — con l'app
// chiusa, il dispatcher manda la push e il PROVIDER LA ACCETTA. Da quel momento i messaggi di
// quella conversazione, nati fino alla notifica, sono consegnati (passo 7bis).
//
// ⚠️ UN 200 DI FCM, O IL 201 DEL WEB-PUSH, VUOL DIRE «CONSEGNATO AD APPLE, GOOGLE O AL SERVIZIO
// DEL BROWSER»: NON è la conferma del telefono. Un iPhone spento da tre giorni ha la sua notifica
// in attesa presso APNs, e qui risulterà consegnata. È l'approssimazione che fa qualunque app di
// messaggistica, ed è scritta qui perché chi legge il codice non debba dedurla — né crederla più
// forte di quello che è. La conferma vera del dispositivo vorrebbe una ricevuta dall'app, che oggi
// non esiste e non è in questo perimetro.
//
// PERCHÉ LA DIPENDENZA VA IN QUESTA DIREZIONE. Il dispatcher importa dalla chat
// (`@/lib/chat/delivered`, `@/lib/chat/notifiche-chat`); la chat NON importa il dispatcher, salvo
// l'`eseguiDispatch` del giro anticipato in `chat/messages/route.ts`. Il dispatch conosce la chat,
// la chat non conosce la push: è la stessa regola già scritta in `@/lib/chat/notifiche-chat`.
// =============================================================================

/**
 * Il nome del job nei log del cron. È quello che `/api/health` cerca per sapere se il cron
 * batte (`JOB_CRON` in `src/lib/health/controlli.ts`): vedi `operazioneDi`.
 */
export const JOB_DISPATCH = 'push-dispatch'

/** Quanto a lungo una notifica non consegnata per un guasto transitorio resta in coda. */
export const FINESTRA_CODA_MS = 30 * 60_000

/**
 * Dopo quanti millisecondi di giro gli invii nativi smettono di fare ritentativi immediati. Un
 * giro con molti dispositivi e FCM in affanno pagherebbe fino a 1 s + 3 s più tre timeout per
 * dispositivo: oltre questo budget la notifica non consegnata torna in coda invece di aspettare.
 * Si guarda per DISPOSITIVO, prima di ogni invio nativo. Chi lo alza alza anche
 * `DURATA_MINIMA_FUNZIONE_S` (`./durata-dispatch.ts`) e quindi il `maxDuration` delle route.
 */
export const BUDGET_RITENTATIVI_MS = 20_000

/**
 * Dopo quanti millisecondi di giro non si comincia più una notifica nuova: quelle prese e non
 * ancora tentate tornano in coda per il giro dopo. Vedi «IL PREZZO DELLA PRESA» in testa. Si
 * guarda solo all'inizio di una notifica: quella in corso arriva in fondo, e il suo costo sta in
 * `DURATA_MINIMA_FUNZIONE_S` (`./durata-dispatch.ts`).
 */
export const TETTO_GIRO_MS = 40_000

/**
 * Dopo quanti millisecondi di giro NON SI PRENDE PIÙ NIENTE: il controllo sta subito prima della
 * presa (passo 4). Le letture che la precedono (le notifiche, i dispositivi a blocchi) sono GET, e
 * postgrest-js le ritenta da solo con attese che non hanno un limite superiore (il `Retry-After`
 * di un 503): senza questo controllo potrebbero consumare quasi tutto il `maxDuration` e lasciare
 * la presa a una Function sul punto di essere troncata. Oltre la soglia il giro chiude senza
 * scrivere niente: le notifiche restano con `push_inviata_il` null e partono al giro dopo.
 *
 * Vale quanto `TETTO_GIRO_MS`: arrivato alla presa oltre il tetto, il ciclo non spedirebbe
 * comunque niente e rimetterebbe in coda tutto, cioè due scritture a blocchi per nessun invio.
 * Il caso peggiore DOPO il controllo (presa, badge, ritorno in coda: tutte scritture o RPC, che
 * postgrest-js non ritenta) è `GIRO_LENTO_PRIMA_DEL_CICLO_MS` in `./durata-dispatch.ts`.
 */
export const SOGLIA_PRESA_MS = TETTO_GIRO_MS

/**
 * Dopo quanti millisecondi di giro NON SI COMINCIA più una coppia (destinatario, thread) della
 * consegna della chat (passo 7bis). Le rimanenti si contano in `consegne_chat_saltate`, con la sua
 * riga `warn`, e la doppia spunta si accenderà quando chi riceve APRE l'app: la accende D2
 * (`consegnaSeInAttesa`, dalla campanella) o la GET del thread. Finché l'app resta chiusa, quei
 * messaggi restano a una spunta — nessuno li ritenta, ed è per questo che le coppie saltate si
 * chiamano saltate e non rinviate.
 *
 * Vale il DOPPIO di `TETTO_GIRO_MS`, che è il punto oltre cui il giro non comincia nemmeno una
 * notifica nuova. Arrivare qui con il doppio di quel tempo consumato vuol dire un provider o un
 * database in affanno, e in quel caso l'ultima cosa utile è aggiungere UPDATE: la consegna è un
 * contorno, le notifiche prese e da salvare non lo sono.
 * ⚠️ Non è vero che a questa soglia si arrivi solo dopo aver sforato `TETTO_GIRO_MS`: il tetto si
 * guarda PRIMA di cominciare una notifica, quindi un'ultima notifica lunga (fino a 60 s di
 * ritentativi per dispositivo) porta il giro oltre gli 80 s senza che la riga `tetto-di-tempo`
 * venga scritta. Per questo il salto ha una riga tutta sua.
 *
 * Il suo costo entra nel caso peggiore del giro (`CONSEGNA_CHAT_MS` in `./durata-dispatch.ts`):
 * con i valori di oggi resta ben sotto gli altri tre scenari, quindi non alza il `maxDuration`
 * di nessuna route. Chi la alza oltre quel margine alza `DURATA_MINIMA_FUNZIONE_S`, e il lock in
 * `__tests__/lib/push-dispatch-durata.test.ts` lo pretende dalle route.
 */
export const SOGLIA_CONSEGNA_CHAT_MS = 2 * TETTO_GIRO_MS

/**
 * Quante notifiche al massimo per giro (la lettura pesca sempre le più vecchie). Esportata perché
 * decide quanti blocchi di `ID_PER_QUERY` fanno la lettura dei dispositivi, la presa e il ritorno
 * in coda, e quindi il caso peggiore in `./durata-dispatch.ts`: chi la alza alza anche il
 * `maxDuration` delle route.
 */
export const LIMITE_LETTURA = 500

/**
 * I TIPI DELLA CHAT. Eccezione a `RUOLI_PUSH_SOLO_CODA` decisa dal titolare il 24/09 (spec
 * «sei interventi», §3 Notifiche): la chat verso Segreteria, Direzione e Cuoca va in push, con il
 * mittente come per tutti — il titolo e il corpo sono quelli della riga, identici a quelli che
 * riceve un genitore o un docente.
 *
 * I DUE NOMI VIVONO ORA IN `@/lib/chat/notifiche-chat`, che è anche chi li usa per SPEGNERE le
 * notifiche quando la conversazione viene letta. Non sono due elenchi da tenere allineati a
 * memoria: un terzo tipo di chat aggiunto in uno solo dei due resterebbe fuori dall'altro, e da
 * quello dello spegnimento non si vedrebbe — la campanella tornerebbe a gonfiarsi in silenzio.
 * Il nome esportato resta `TIPI_CHAT` perché è quello che il lock del dispatch confronta con la
 * route dei messaggi (`__tests__/lib/push-dispatch-presa.test.ts`).
 */
export const TIPI_CHAT: readonly string[] = TIPI_NOTIFICA_CHAT

/**
 * ALLO STAFF LA PUSH PORTA SOLO GLI AVVISI DELLA CODA FATTURE, LO SCARTO SDI, LA CHAT E I DUE AVVISI DEI
 * VIDEO (consegna 2c della coda fatture; decisione 21 del titolare: la push entro 5 minuti, e mai un nome —
 * più l'eccezione della chat del 24/09, vedi `TIPI_CHAT`, e quella dei video del 02/10).
 *
 * I DUE AVVISI DEI VIDEO (PR 2 «server e web», decisione del titolare del 02/10, spec §7): `video_esito`, l'esito
 * di un video caricato in galleria — a chi ha caricato, che può essere anche la Direzione o la segreteria —, e
 * `video_liberatoria_revocata`, l'avviso di sicurezza di un video pubblicato con bambini rimasti senza liberatoria.
 * Entrano per la ragione per cui entra lo scarto SDI: il testo non contiene MAI un nome (né di un bambino né di un
 * file), solo un numero o una frase fissa, quindi sulla schermata di blocco non c'è niente da proteggere. Senza questa
 * riga la segreteria che carica un video e la Direzione che deve sapere di una liberatoria persa non riceverebbero la
 * push, per il solo fatto di essere staff: l'esito resterebbe in campanella finché qualcuno non la apre.
 *
 * Fino alla 2c nessuno dello staff aveva un dispositivo iscritto. Il pulsante della «Coda
 * fatture» iscrive la PERSONA, non un tipo: senza questo filtro le porterebbe anche tutte le
 * altre notifiche dello staff — misurate il 24/09: 3.267 in 30 giorni su 7 destinatari, più di
 * un terzo di tipi che mettono nel corpo il nome di una persona (un genitore, un bambino, chi ha
 * ricevuto le credenziali: `onboarding_completato`, `credenziali`, `assenza_comunicata`,
 * `allergie_aggiornate`) — sulla schermata di blocco, e gli avvisi della coda ci annegherebbero
 * dentro. Quelle restano nella campanella, com'erano.
 * La cuoca sta nell'elenco per la stessa ragione: vive nell'area admin. Allargarlo è una
 * decisione del titolare (docs/superpowers/specs/2026-09-22-coda-fatture-aruba/
 * consegna-2c-notifiche.md, §7.2).
 * Il filtro vede solo le push che passano DI QUI: un modulo che chiamasse `sendPush` o
 * `sendNativePush` da sé, sui dispositivi dello staff, lo scavalcherebbe. Per questo il
 * dispatch è l'unico canale verso lo staff: l'alert allergie della mensa e il saldo basso (W2)
 * lasciano la riga pendente e passano di qui (`src/lib/mensa/notify.ts`). In tutto `src/`
 * l'unico modulo che importa i due invii è questo (sono esclusi solo `web-push.ts` e
 * `native-push.ts`, che li definiscono): lo tiene fermo un lock in fondo a
 * `__tests__/api/push-dispatch.test.ts`.
 */
export const RUOLI_PUSH_SOLO_CODA: ReadonlySet<string> = new Set(['admin', 'coordinator', 'segreteria', 'cuoca'])
export const TIPI_PUSH_STAFF: ReadonlySet<string> = new Set<string>([
  ...TIPI_AVVISO_CODA,
  'fattura_scartata',
  ...TIPI_CHAT,
  'video_esito',
  'video_liberatoria_revocata',
])

/**
 * Chi ha chiesto il giro. `cron` è il job ogni 5 minuti (pg_net → `/api/push/dispatch`); ogni
 * altra origine (la chat, da PS3) scrive i suoi log sotto un nome DIVERSO, vedi `operazioneDi`.
 */
export type OrigineDispatch = 'cron' | 'chat'

export interface OpzioniDispatch {
  /** Predefinito `cron`. */
  origine?: OrigineDispatch
}

/** I contatori del giro: numeri, che `redact()` lascia passare in chiaro. */
export interface DatiDispatch {
  /** Invii web riusciti. */
  inviate: number
  /** Invii nativi (FCM) riusciti. */
  native_inviate: number
  /** Invii rifiutati dal provider (né riusciti né su un dispositivo morto). */
  fallite: number
  /** Notifiche chiuse da questo giro: prese e rimaste marcate. */
  notifiche: number
  subs_rimosse: number
  /** Notifiche dello staff che la push non porta per scelta (vedi `TIPI_PUSH_STAFF`). */
  escluse_staff: number
  /** Notifiche in coda che un giro sovrapposto aveva già preso: saltate, niente doppione. */
  gia_prese: number
  /** Nessun dispositivo raggiunto per un guasto transitorio, entro 30': di nuovo in coda. */
  rimesse_in_coda: number
  /** Come sopra, ma oltre i 30': ci si arrende e restano marcate. */
  arrese: number
  /** Prese e non tentate perché il giro ha superato `TETTO_GIRO_MS`: di nuovo in coda. */
  rinviate_per_tempo: number
  /**
   * Coppie (destinatario, thread) per cui la consegna è stata eseguita, perché il provider ha
   * accettato la push di chat (D1, passo 7bis). È un conteggio di UPDATE andati a buon fine, non
   * di spunte accese: quelle sono `consegne_chat_righe`, e i due numeri sono diversi ogni volta
   * che qualcun altro ha consegnato prima.
   */
  consegne_chat: number
  /**
   * Le RIGHE di `chat_messages` su cui `delivered_at` si è appena acceso — la doppia spunta vera.
   * È questo il numero che distingue D1 vivo da D1 rotto: nel caso normale con l'app aperta, D2 o
   * la GET del thread consegnano per primi e l'UPDATE tocca ZERO righe, quindi un contatore di
   * chiamate direbbe «acceso» per sempre anche con D1 guasto.
   */
  consegne_chat_righe: number
  /**
   * Coppie rimaste senza consegna: quelle non tentate perché il giro ha superato
   * `SOGLIA_CONSEGNA_CHAT_MS` o perché il passo si è interrotto, più quella il cui UPDATE ha
   * risposto `fermati`. «Saltate» e non «rinviate»: nessuno le ritenta — la loro spunta la accende
   * D2 alla prossima apertura dell'app, non un giro successivo.
   */
  consegne_chat_saltate: number
}

export type EsitoDispatch =
  | { stato: 200; data: DatiDispatch | { inviate: 0; non_configurato: true } }
  | { stato: 500 }

/** La riga di `notifiche` letta dal giro, con il ruolo del destinatario incorporato. */
interface RigaNotifica {
  id: string
  utente_id: string
  tipo: string
  titolo: string
  corpo: string | null
  link: string | null
  creato_il?: string | null
  invio_programmato_il?: string | null
  /** L'entità a cui la notifica si riferisce: per la chat `chat_thread` + l'uuid del thread. */
  entita_tipo?: string | null
  entita_id?: string | null
  utenti?: unknown
}

interface Sottoscrizione {
  id: string
  utente_id: string
  endpoint: string
  p256dh: string | null
  auth: string | null
  platform?: string | null
}

/**
 * Il nome del giro nei log. IL CRON TIENE IL SUO: `push-dispatch`, con evento `cron`. Ogni altra
 * origine prende `push-dispatch-<origine>` ed evento `push`. Non è cosmesi: `/api/health`
 * riconosce il battito del cron da `operazione = 'push-dispatch'` con esito `ok`; se la chat
 * scrivesse lo stesso battito, un cron fermo da ore sembrerebbe vivo finché qualcuno scrive in
 * chat — il silenzio che il battito esiste per rendere visibile.
 */
function operazioneDi(origine: OrigineDispatch): string {
  return origine === 'cron' ? JOB_DISPATCH : `${JOB_DISPATCH}-${origine}`
}

type Livello = 'info' | 'warn' | 'error'
type Campi = Parameters<typeof logEvento>[2]

/** Una riga del giro: evento `cron` per il cron (persistito), `push` per le altre origini (idem). */
function riga(origine: OrigineDispatch, livello: Livello, campi: Campi, err?: unknown): void {
  if (origine === 'cron') logEvento('cron', livello, campi, err)
  else logEvento('push', livello, campi, err)
}

/**
 * Il destinatario è dello staff? Lo dice la relazione incorporata sull'utente (i due campi del
 * ruolo) della stessa lettura (una FK sola, `notifiche_utente_id_fkey`): un oggetto, un array per
 * prudenza. Schema doppio `role`/`ruolo`, come `staffScuola`. Riga senza utente → non è staff.
 * Nella stessa lettura e non in una seconda query sulla tabella degli utenti, che se fallisse
 * fermerebbe anche la push dei genitori.
 */
function destinatarioDelloStaff(n: { utenti?: unknown }): boolean {
  const u: unknown = Array.isArray(n.utenti) ? n.utenti[0] : n.utenti
  if (!u || typeof u !== 'object') return false
  const { role, ruolo } = u as { role?: unknown; ruolo?: unknown }
  return RUOLI_PUSH_SOLO_CODA.has(String(role ?? '')) || RUOLI_PUSH_SOLO_CODA.has(String(ruolo ?? ''))
}

function nativa(s: Sottoscrizione): s is Sottoscrizione & { platform: 'ios' | 'android' } {
  return s.platform === 'ios' || s.platform === 'android'
}

/** L'istante da cui si contano i 30 minuti della coda. Illeggibile → `NaN` (ci si arrende). */
function programmataIl(n: RigaNotifica): number {
  return Date.parse(String(n.invio_programmato_il ?? n.creato_il ?? ''))
}

/**
 * IL BADGE iOS: quante notifiche NON LETTE (`letta_il` null) ha ciascun destinatario. UNA query
 * per giro, qualunque sia il numero di utenti: la RPC `notifiche_non_lette_per_utente` conta
 * con un `GROUP BY` sull'indice `(utente_id, letta_il)`. Leggere le righe e contarle qui non si
 * può: il 25/09 erano 23.696 non lette su 689 utenti, fino a 635 per utente.
 *
 * Il badge è un numero sull'icona, non la notifica: se il conto non riesce (RPC assente su un
 * database non ancora migrato, DB in affanno) si spedisce SENZA badge — APNs lascia quello che
 * c'era — e una riga `warn` lo dice. Fermare le push per il badge sarebbe il danno maggiore.
 */
async function contaNonLette(
  supabase: SupabaseClient,
  utenti: string[],
  origine: OrigineDispatch,
): Promise<Map<string, number>> {
  const conteggi = new Map<string, number>()
  if (utenti.length === 0) return conteggi
  const operazione = operazioneDi(origine)
  try {
    const { data, error } = await supabase.rpc('notifiche_non_lette_per_utente', { p_utenti: utenti })
    if (error) {
      riga(origine, 'warn', { operazione, esito: 'badge-non-calcolato', utenti: utenti.length }, error)
      return conteggi
    }
    for (const r of (data ?? []) as Array<{ utente_id?: unknown; non_lette?: unknown }>) {
      const n = Number(r.non_lette)
      if (typeof r.utente_id === 'string' && Number.isInteger(n) && n >= 0) conteggi.set(r.utente_id, n)
    }
    // Un utente che la RPC non restituisce non ha non lette: badge 0, che AZZERA il numero.
    for (const u of utenti) if (!conteggi.has(u)) conteggi.set(u, 0)
    return conteggi
  } catch (err) {
    // Un guasto di trasporto: stesso trattamento dell'`error` di PostgREST, e si logga.
    riga(origine, 'warn', { operazione, esito: 'badge-non-calcolato', utenti: utenti.length }, err)
    return new Map()
  }
}

/**
 * Esegue UN giro di dispatch: legge le notifiche in coda (push non spedita e buffer scaduto),
 * le PRENDE con l'UPDATE condizionato, spedisce ai dispositivi dei destinatari, rimette in coda
 * quelle che nessun dispositivo ha ricevuto per un guasto transitorio (entro 30'), rimuove i
 * dispositivi morti. Non lancia mai. Vedi la testata del file.
 */
export async function eseguiDispatch(opzioni: OpzioniDispatch = {}): Promise<EsitoDispatch> {
  const origine: OrigineDispatch = opzioni.origine ?? 'cron'
  const operazione = operazioneDi(origine)
  const t0 = Date.now()

  /**
   * IL BATTITO NON PUÒ MENTIRE — ed è per questo che ogni query si controlla.
   *
   * **PostgREST NON LANCIA: ritorna `{ data, error }`** (regola 7 di AGENTS.md). Una lettura
   * fallita e ignorata lascerebbe `data` a `null`, il codice scivolerebbe nel ramo «zero
   * elementi» e il battito scriverebbe `esito: 'ok', inviate: 0`: il guasto muto delle email di
   * credenziali, coperto dal codice che doveva prevenirlo. Se `error` è valorizzato il giro
   * finisce lì — riga `error` (persistita), 500, e nessun effetto collaterale a valle.
   * `esito` e `azione` sono nella lista bianca di `redact`; il `msg` è distinto per query perché
   * `app_log` deduplica per impronta e l'impronta contiene il messaggio, non il `contesto`.
   */
  const queryFallita = (azione: string, error: unknown, contatori: Campi = {}): EsitoDispatch => {
    riga(
      origine,
      'error',
      { operazione, esito: 'query-fallita', azione, ...contatori, ms: Date.now() - t0, msg: `${operazione}: ${azione} fallita` },
      error,
    )
    return { stato: 500 }
  }

  try {
    riga(origine, 'info', { operazione, esito: 'avviato', msg: `${operazione}: avviato` })

    // Senza NESSUN canale configurato (né VAPID web né FCM native) il push non può partire:
    // esito visibile (non_configurato) e notifiche NON prese, così partiranno appena un canale
    // sarà configurato. Configurazione mancante = `error`, mai `info` (regola 4).
    const webOk = vapidConfigured()
    const nativeOk = fcmConfigured()
    if (!webOk && !nativeOk) {
      riga(origine, 'error', {
        operazione,
        esito: 'non-configurato',
        ms: Date.now() - t0,
        msg: `${operazione}: nessun canale push configurato (VAPID/FCM), notifiche lasciate in coda`,
      })
      return { stato: 200, data: { inviate: 0, non_configurato: true } }
    }

    const supabase = await createAdminClient()

    // ── 1. LE CANDIDATE: push non ancora spedita E buffer scaduto ─────────────────────────
    const nowIso = new Date().toISOString()
    const { data: lette, error: errPendenti } = await supabase
      .from('notifiche')
      // `entita_tipo, entita_id` servono alla consegna della chat (passo 7bis): sono le due
      // colonne che dicono QUALE conversazione la notifica annunciava. Nella stessa lettura e non
      // in una query a parte: una seconda query che fallisse fermerebbe anche le push.
      .select('id, utente_id, tipo, titolo, corpo, link, creato_il, invio_programmato_il, entita_tipo, entita_id, utenti(role, ruolo)')
      .is('push_inviata_il', null)
      .or(`invio_programmato_il.is.null,invio_programmato_il.lte.${nowIso}`)
      .order('creato_il', { ascending: true })
      .limit(LIMITE_LETTURA)
    if (errPendenti) return queryFallita('lettura notifiche', errPendenti)
    const pendenti = (lette ?? []) as RigaNotifica[]

    const vuoto: DatiDispatch = {
      inviate: 0,
      native_inviate: 0,
      fallite: 0,
      notifiche: 0,
      subs_rimosse: 0,
      escluse_staff: 0,
      gia_prese: 0,
      rimesse_in_coda: 0,
      arrese: 0,
      rinviate_per_tempo: 0,
      consegne_chat: 0,
      consegne_chat_righe: 0,
      consegne_chat_saltate: 0,
    }
    if (pendenti.length === 0) {
      // Il caso normale della stragrande maggioranza dei giri: niente da spedire. Ha comunque
      // bisogno del suo «ok», o la sorveglianza vedrebbe un job partito e mai finito.
      riga(origine, 'info', { operazione, esito: 'ok', ms: Date.now() - t0, notifiche: 0, inviate: 0, msg: `${operazione}: ok` })
      return { stato: 200, data: { ...vuoto } }
    }

    // ── 2. I DISPOSITIVI, PRIMA DELLA PRESA ──────────────────────────────────────────────
    // LA LETTURA PIÙ PERICOLOSA DEL FILE, ed è per questo che sta PRIMA della presa. Se
    // fallisse dopo, le notifiche resterebbero prese e mai spedite: perse, col log che dice ok.
    // Così si esce prima di qualunque scrittura, e partiranno al giro successivo.
    // A blocchi: fino a 500 destinatari distinti in un `.in()` sarebbero il 414 della testata.
    const utenti = [...new Set(pendenti.map((n) => n.utente_id))]
    const subs: Sottoscrizione[] = []
    for (const blocco of aBlocchi(utenti, ID_PER_QUERY)) {
      const { data: parte, error: errSubs } = await supabase
        .from('push_subscriptions')
        .select('id, utente_id, endpoint, p256dh, auth, platform')
        .in('utente_id', blocco)
      if (errSubs) return queryFallita('lettura push_subscriptions', errSubs)
      subs.push(...((parte ?? []) as Sottoscrizione[]))
    }

    const subsByUser = new Map<string, Sottoscrizione[]>()
    for (const s of subs) {
      const arr = subsByUser.get(s.utente_id) ?? []
      arr.push(s)
      subsByUser.set(s.utente_id, arr)
    }

    // ── 3. LE RIMANDATE PER CANALE SPENTO: non si prendono nemmeno ───────────────────────
    // Una notifica che HA destinatari, nessuno dei quali raggiungibile perché il loro canale
    // non è configurato (FCM o VAPID assenti), resta in coda senza essere toccata: partirà da
    // sola appena le chiavi arrivano. Marcarla vorrebbe dire perderla — il «degrado pulito»
    // che pulito non era (T17-F3). Una sola notifica con almeno un canale vivo si prende e si
    // tenta: rimandarla per il canale spento farebbe arrivare due volte la push a chi ha il web.
    const canaleVivo = (s: Sottoscrizione) => (nativa(s) ? nativeOk : webOk)
    let rimandate = 0
    let saltateNative = 0
    let saltateWeb = 0
    const candidate: RigaNotifica[] = []
    for (const n of pendenti) {
      const userSubs = subsByUser.get(n.utente_id) ?? []
      const esclusa = userSubs.length > 0 && destinatarioDelloStaff(n) && !TIPI_PUSH_STAFF.has(n.tipo)
      if (!esclusa && userSubs.length > 0 && !userSubs.some(canaleVivo)) {
        rimandate++
        for (const s of userSubs) {
          if (nativa(s)) saltateNative++
          else saltateWeb++
        }
        continue
      }
      candidate.push(n)
    }

    // Un canale spento è un incidente di configurazione, quindi `error` (regola 4): le tre
    // variabili FCM o le chiavi VAPID restano assenti finché qualcuno non le mette. Si scrive a
    // fine giro, e anche se il giro chiude prima della presa (qui sotto).
    const segnalaCanaleSpento = (notifiche: number) => {
      if (saltateNative === 0 && saltateWeb === 0) return
      riga(origine, 'error', {
        operazione,
        esito: 'canale-non-configurato',
        saltate_native: saltateNative,
        saltate_web: saltateWeb,
        rimandate,
        notifiche,
        ms: Date.now() - t0,
        msg:
          `${operazione}: ${saltateNative} invii nativi e ${saltateWeb} web saltati per canale non configurato ` +
          `(FCM/VAPID); ${rimandate} notifiche NON prese, restano in coda`,
      })
    }

    // ── 3bis. IL TEMPO, PRIMA DI PRENDERE ────────────────────────────────────────────────
    // Le letture qui sopra sono GET, e postgrest-js le ritenta da solo (503/520, rete) con
    // attese senza limite superiore: il loro tempo non si può mettere in conto. Se hanno già
    // consumato `SOGLIA_PRESA_MS` non si prende niente — nessuna scrittura, le notifiche restano
    // con `push_inviata_il` null e partono al giro dopo. Così una Function troncata da qui in su
    // non perde nulla. Il giro chiude con 200 e il suo battito «ok»: non c'è stato guasto né
    // perdita, e il cron ha finito. A dire che non ha spedito è la riga `warn` dedicata.
    if (candidate.length > 0 && Date.now() - t0 > SOGLIA_PRESA_MS) {
      const ms = Date.now() - t0
      riga(origine, 'warn', {
        operazione,
        esito: 'tetto-prima-della-presa',
        candidate: candidate.length,
        rimandate,
        ms,
        msg: `${operazione}: letture oltre ${SOGLIA_PRESA_MS} ms, ${candidate.length} notifiche NON prese, restano in coda`,
      })
      segnalaCanaleSpento(0)
      riga(origine, 'info', { operazione, esito: 'ok', ms, notifiche: 0, inviate: 0, candidate: candidate.length, msg: `${operazione}: ok` })
      return { stato: 200, data: { ...vuoto } }
    }

    // ── 4. LA PRESA ATOMICA, a blocchi di `ID_PER_QUERY` ─────────────────────────────────
    // Le scritture che falliscono DOPO che qualcosa è già stato preso non fermano il giro: si
    // annotano qui e il giro chiude con la riga `error` e il 500 invece dell'«ok», ma solo dopo
    // aver spedito ciò che ha preso e scritto le righe del passo 8. Uscire a metà lascerebbe
    // righe prese e mai spedite (perse) e muterebbe proprio le righe che dicono cosa si è perso.
    const scrittureFallite: Array<{ azione: string; error: unknown }> = []
    const presaIl = new Date().toISOString()
    const idsPresi = new Set<string>()
    let tentate = 0
    let errPresa: unknown = null
    for (const blocco of aBlocchi(candidate.map((n) => n.id), ID_PER_QUERY)) {
      const { data: preseIds, error } = await supabase
        .from('notifiche')
        .update({ push_inviata_il: presaIl })
        .in('id', blocco)
        .is('push_inviata_il', null)
        .select('id')
      if (error) {
        // Il DB rifiuta: ci si ferma qui. I blocchi non tentati restano NON presi, in coda.
        errPresa = error
        break
      }
      tentate += blocco.length
      for (const r of (preseIds ?? []) as Array<{ id: string }>) idsPresi.add(r.id)
    }
    const prese = candidate.filter((n) => idsPresi.has(n.id))
    // Niente preso: nessun effetto collaterale, si esce come prima di qualunque scrittura.
    if (errPresa && prese.length === 0) return queryFallita('presa notifiche', errPresa)
    // Preso qualcosa: lo si spedisce comunque (rilasciarlo sarebbe un'altra scrittura, che
    // potrebbe fallire a sua volta e lasciarlo preso e mai spedito), e il giro chiude con 500.
    if (errPresa) scrittureFallite.push({ azione: 'presa notifiche', error: errPresa })
    // Solo sui blocchi davvero tentati: una candidata di un blocco rifiutato non è «già presa».
    const giaPrese = tentate - prese.length

    // ── 5. IL BADGE: una query sola, per i destinatari con un iPhone ─────────────────────
    const conIphone = nativeOk
      ? [...new Set(prese.map((n) => n.utente_id))].filter((u) =>
          (subsByUser.get(u) ?? []).some((s) => s.platform === 'ios'),
        )
      : []
    const badge = await contaNonLette(supabase, conIphone, origine)

    // ── 6. GLI INVII ─────────────────────────────────────────────────────────────────────
    const d: DatiDispatch = { ...vuoto, gia_prese: giaPrese }
    const toRemove: string[] = []
    const daRimettere: string[] = []

    /**
     * LE COPPIE DA CONSEGNARE (D1): chiave `<destinatario>|<thread>`, e il `finoA` è il
     * `creato_il` della notifica che il provider ha accettato.
     *
     * UNA CHIAMATA PER COPPIA, e non una per destinatario col `finoA` più alto: quella sarebbe
     * sbagliata, e in modo invisibile. Chi ha due conversazioni con due notifiche di istanti
     * diversi si vedrebbe consegnare, nel thread annunciato PRIMA, anche i messaggi nati dopo —
     * messaggi che hanno una notifica loro, ancora da spedire: la doppia spunta su qualcosa che
     * non è arrivato da nessuna parte, cioè lo stesso genere di bugia che questo lavoro esiste
     * per togliere di mezzo, soltanto rovesciata.
     *
     * Due notifiche della STESSA coppia nello stesso giro (il debounce le sostituisce, ma un
     * secondo giro può trovarne due) tengono il `finoA` più RECENTE: consegnare fino all'istante
     * più avanzato di cui il provider ha accettato l'annuncio è vero per entrambe.
     */
    const consegneChat = new Map<string, { userId: string; threadId: string; finoA: string; ms: number }>()

    for (const n of prese) {
      if (Date.now() - t0 > TETTO_GIRO_MS) {
        // Tetto di tempo: la notifica è presa ma non tentata. Torna in coda, non si perde.
        d.rinviate_per_tempo++
        daRimettere.push(n.id)
        continue
      }
      const userSubs = subsByUser.get(n.utente_id) ?? []
      // Allo staff solo coda, scarto SdI e chat: il resto resta nella campanella. Niente da
      // spedire e niente da riprovare, come senza dispositivi: resta marcata e si conta.
      if (userSubs.length > 0 && destinatarioDelloStaff(n) && !TIPI_PUSH_STAFF.has(n.tipo)) {
        d.escluse_staff++
        d.notifiche++
        continue
      }

      const payload = { title: n.titolo, body: n.corpo ?? undefined, url: n.link ?? '/', tag: n.id }
      const conto = badge.get(n.utente_id)
      const payloadNativo: NativePushPayload = conto === undefined ? payload : { ...payload, badge: conto }

      // Per NOTIFICA: chi l'ha ricevuta, chi ha rifiutato per un guasto transitorio, chi per
      // un rifiuto definitivo. I dispositivi morti (`gone`) non contano: si rimuovono, e al
      // giro dopo non ci saranno.
      let ricevute = 0
      let ritentabili = 0
      let definitive = 0
      for (const s of userSubs) {
        if (!canaleVivo(s)) {
          if (nativa(s)) saltateNative++
          else saltateWeb++
          continue
        }
        if (nativa(s)) {
          const res =
            Date.now() - t0 > BUDGET_RITENTATIVI_MS
              ? await sendNativePush(s.endpoint, s.platform, payloadNativo, { maxRitentativi: 0 })
              : await sendNativePush(s.endpoint, s.platform, payloadNativo)
          if (res.ok) {
            d.native_inviate++
            ricevute++
          } else if (res.gone) toRemove.push(s.id)
          else {
            d.fallite++
            if (res.ritentabile === true) ritentabili++
            else definitive++
          }
        } else {
          const res = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh ?? '', auth: s.auth ?? '' }, payload)
          if (res.ok) {
            d.inviate++
            ricevute++
          } else if (res.gone) toRemove.push(s.id)
          else {
            // Il web-push non distingue il transitorio dal definitivo: un rifiuto è definitivo.
            d.fallite++
            definitive++
          }
        }
      }

      // LA REGOLA DI CHIUSURA.
      //  · almeno un dispositivo l'ha ricevuta → resta marcata (rispedirla = doppione);
      //  · nessuno, e TUTTI i rifiuti erano transitori → entro 30' dalla programmazione torna
      //    in coda; dopo ci si arrende e resta marcata;
      //  · altrimenti (nessun dispositivo, rifiuti definitivi, soli dispositivi morti) resta
      //    marcata: riprovare non cambierebbe niente, e i ritentativi infiniti sono il difetto
      //    opposto.
      if (ricevute === 0 && ritentabili > 0 && definitive === 0) {
        if (Date.now() - programmataIl(n) < FINESTRA_CODA_MS) {
          d.rimesse_in_coda++
          daRimettere.push(n.id)
          continue
        }
        d.arrese++
      }
      d.notifiche++

      // LA DOPPIA SPUNTA (D1). `ricevute > 0` è la condizione, e non «nessun errore»: la consegna
      // è dell'ACCETTAZIONE da parte del provider, e un rifiuto definitivo, un dispositivo morto
      // o un destinatario senza dispositivi non hanno consegnato niente a nessuno. Le notifiche
      // rimesse in coda non arrivano nemmeno qui: hanno già fatto `continue` sopra.
      // Un tipo che non è di chat, un'entità che non è un thread, un `entita_id` assente: niente
      // da consegnare — non è un errore, è una notifica di altro genere.
      if (ricevute > 0 && TIPI_CHAT.includes(n.tipo) && n.entita_tipo === ENTITA_CHAT_THREAD && n.entita_id) {
        // Senza un `creato_il` leggibile NON si consegna. `marcaConsegnati` senza `creatiFinoA`
        // non filtra per tempo, cioè consegnerebbe il thread INTERO, compresi i messaggi nati
        // dopo questa notifica: meglio una spunta in ritardo (la accende D2, o l'apertura della
        // lista) che una spunta bugiarda.
        const finoA = String(n.creato_il ?? '')
        const ms = Date.parse(finoA)
        if (Number.isFinite(ms)) {
          const chiave = `${n.utente_id}|${n.entita_id}`
          const gia = consegneChat.get(chiave)
          if (!gia || ms > gia.ms) consegneChat.set(chiave, { userId: n.utente_id, threadId: n.entita_id, finoA, ms })
        }
      }
    }

    // ── 7. IL RITORNO IN CODA ────────────────────────────────────────────────────────────
    // Si annulla la presa SOLO dove c'è ancora la NOSTRA (`push_inviata_il = presaIl`), a
    // blocchi. Anche questa scrittura ritorna `{ error }` senza lanciare: se un blocco fallisce,
    // quelle notifiche restano marcate e non ripartiranno. NON si esce: gli altri blocchi si
    // tentano lo stesso (ognuno riuscito sono notifiche salvate), si rimuovono i dispositivi
    // morti e si scrivono le righe del passo 8 — la resa compresa. Poi la riga `error` e il 500.
    let errRitorno: unknown = null
    for (const blocco of aBlocchi(daRimettere, ID_PER_QUERY)) {
      const { error } = await supabase
        .from('notifiche')
        .update({ push_inviata_il: null })
        .in('id', blocco)
        .eq('push_inviata_il', presaIl)
      if (error && errRitorno === null) errRitorno = error
    }
    if (errRitorno !== null) scrittureFallite.push({ azione: 'ritorno in coda', error: errRitorno })

    // Le subscription «gone» (410/404) che non si riesce a cancellare restano lì e ogni giro
    // riprovano a ricevere una push che non arriverà mai: un errore silenzioso e permanente.
    let errRimozione: unknown = null
    for (const blocco of aBlocchi(toRemove, ID_PER_QUERY)) {
      const { error } = await supabase.from('push_subscriptions').delete().in('id', blocco)
      if (error) {
        if (errRimozione === null) errRimozione = error
      } else d.subs_rimosse += blocco.length
    }
    if (errRimozione !== null) scrittureFallite.push({ azione: 'rimozione push_subscriptions', error: errRimozione })

    // ── 7bis. LA CONSEGNA DELLA CHAT (D1) ────────────────────────────────────────────────
    // La doppia spunta si accende sui messaggi che la push accettata annunciava: una chiamata per
    // COPPIA (destinatario, thread), col `finoA` della sua notifica.
    //
    // STA QUI, DOPO IL RITORNO IN CODA E LA RIMOZIONE, non prima: quelle due scritture sono ciò
    // che impedisce di PERDERE una notifica presa e non consegnata («IL PREZZO DELLA PRESA») e di
    // lasciare un dispositivo morto a ricevere per sempre una push che non arriverà. La doppia
    // spunta è un contorno — se andasse prima, un `chat_messages` lento ruberebbe il tempo che
    // serve a salvare le notifiche, e una Function troncata in mezzo le lascerebbe marcate e mai
    // spedite. Nessuna di queste consegne, invece, si perde se salta: la accende D2 all'apertura
    // dell'app.
    //
    // SI FA ANCHE QUANDO IL GIRO CHIUDERÀ IN 500. Le push sono partite e i provider le hanno
    // accettate: le spunte vanno accese, qualunque cosa sia andata storta DOPO sulle righe di
    // `notifiche`. Saltare il passo lascerebbe spente delle spunte per un guasto che non le
    // riguarda, e i contatori finiscono comunque nella riga d'errore del passo 8.
    //
    // NON ENTRA IN `scrittureFallite` e NON cambia lo stato del giro: un giro che ha spedito le
    // push e non ha accesa una spunta non è un giro fallito. `marcaConsegnati` non lancia per
    // contratto e scrive i propri log; il `try` qui è la difesa contro l'imprevisto (un client
    // sostituito, un builder che cambia forma), e un catch che non logga è un bug: la riga si
    // scrive una sola volta a fine ciclo, col conteggio e l'ultimo errore, perché N righe identiche
    // in un giro da 500 notifiche sarebbero rumore e in `app_log`, che deduplica per giorno,
    // resterebbe comunque la prima.
    //
    // SI CONTANO LE RIGHE, NON LE CHIAMATE (`consegne_chat_righe`), e si CHIEDE il conteggio: un
    // contatore di chiamate salirebbe anche quando l'UPDATE non tocca niente — il caso normale con
    // l'app aperta, dove D2 ha già consegnato — e un D1 rotto mostrerebbe `consegne_chat > 0` per
    // sempre. Una misura che conferma sé stessa è peggio di nessuna misura.
    //
    // E SI FERMA AL PRIMO `fermati`: un database che ha appena risposto male non va interrogato
    // altre cinquanta volte, e ogni tentativo in più aggiunge un `logErrore`, cioè un'altra
    // scrittura. Le coppie senza consegna — per l'arresto o per il tempo — si contano tutte in
    // `consegne_chat_saltate`. Il conto torna come coppie totali = consegnate + saltate + ROTTE:
    // le eccezioni impreviste finiscono in `consegneRotte`, dette dalla riga `warn`
    // `consegna-chat-non-riuscita`, non nel battito.
    const coppie = [...consegneChat.values()]
    let consegneRotte = 0
    let errConsegna: unknown = null
    for (let i = 0; i < coppie.length; i++) {
      const c = coppie[i]
      if (Date.now() - t0 > SOGLIA_CONSEGNA_CHAT_MS) {
        // Il tempo non torna indietro: le rimanenti sono saltate tutte, e si esce.
        d.consegne_chat_saltate += coppie.length - i
        break
      }
      try {
        const { esito, n } = await marcaConsegnati(supabase, {
          userId: c.userId,
          threadIds: [c.threadId],
          creatiFinoA: c.finoA,
          conteggia: true,
        })
        // Il parziale di una coppia fermata è comunque scritto sul database: si conta.
        d.consegne_chat_righe += n
        if (esito !== 'ok') {
          d.consegne_chat_saltate += coppie.length - i
          break
        }
        d.consegne_chat++
      } catch (err) {
        consegneRotte++
        errConsegna = err
      }
    }

    // ── 8. LE RIGHE CHE ALZANO LA VOCE, separate dal battito ────────────────────────────
    // I rifiuti: `warn`, perché molti sono transitori e il giro degrada con un 200. Il `msg`
    // dice la conseguenza, perché chi legge il log non deve dedurla dal codice.
    if (d.fallite > 0) {
      riga(origine, 'warn', {
        operazione,
        esito: 'invii-rifiutati',
        fallite: d.fallite,
        inviate: d.inviate,
        native_inviate: d.native_inviate,
        notifiche: d.notifiche,
        rimesse_in_coda: d.rimesse_in_coda,
        ms: Date.now() - t0,
        msg:
          `${operazione}: ${d.fallite} invii push rifiutati dal provider; tornano in coda (fino a 30') solo le ` +
          'notifiche che nessun dispositivo ha ricevuto per un guasto transitorio, le altre restano marcate',
      })
    }
    // La resa: notifiche che NESSUN dispositivo ha ricevuto in 30 minuti di guasti transitori.
    // Sono perse, ed è un `error`: è l'unica riga che lo dice.
    if (d.arrese > 0) {
      riga(origine, 'error', {
        operazione,
        esito: 'resa-dopo-30-minuti',
        arrese: d.arrese,
        ms: Date.now() - t0,
        msg: `${operazione}: ${d.arrese} notifiche mai consegnate dopo 30 minuti di errori transitori, restano marcate`,
      })
    }
    // Il tetto di tempo: non è una perdita (tornano in coda), ma un giro troppo lento va visto.
    if (d.rinviate_per_tempo > 0) {
      riga(origine, 'warn', {
        operazione,
        esito: 'tetto-di-tempo',
        rinviate_per_tempo: d.rinviate_per_tempo,
        ms: Date.now() - t0,
        msg: `${operazione}: giro oltre ${TETTO_GIRO_MS} ms, ${d.rinviate_per_tempo} notifiche prese e non tentate tornano in coda`,
      })
    }
    // Le coppie SALTATE, per tempo o per un `fermati` del database: `warn`, perché sono doppie
    // spunte che questo giro non ha accese. Non è una perdita — le accende D2 alla prossima
    // apertura dell'app — ma va vista, e non basta la riga `tetto-di-tempo` a dirlo: alla soglia
    // della consegna si arriva ANCHE senza sforare il tetto del giro (un'ultima notifica lunga, un
    // arretrato di coppie), e un `fermati` del database non ha niente a che fare col tempo.
    if (d.consegne_chat_saltate > 0) {
      riga(origine, 'warn', {
        operazione,
        esito: 'consegna-chat-saltata',
        consegne_chat_saltate: d.consegne_chat_saltate,
        consegne_chat: d.consegne_chat,
        consegne_chat_righe: d.consegne_chat_righe,
        ms: Date.now() - t0,
        msg:
          `${operazione}: ${d.consegne_chat_saltate} conversazioni senza la doppia spunta in questo giro ` +
          `(oltre ${SOGLIA_CONSEGNA_CHAT_MS} ms, o database fermo); si accenderà all'apertura dell'app`,
      })
    }
    // La consegna della chat che ha lanciato: `warn`, perché la conseguenza è una doppia spunta
    // in ritardo (la accende D2) e non una notifica persa — ma il contratto dice «non lancia mai»,
    // quindi se succede è un bug e va visto.
    if (consegneRotte > 0) {
      riga(
        origine,
        'warn',
        {
          operazione,
          esito: 'consegna-chat-non-riuscita',
          consegne_chat_rotte: consegneRotte,
          consegne_chat: d.consegne_chat,
          ms: Date.now() - t0,
          msg:
            `${operazione}: ${consegneRotte} consegne di chat interrotte da un'eccezione ` +
            '(`marcaConsegnati` non dovrebbe lanciare); la doppia spunta si accenderà all\'apertura dell\'app',
        },
        errConsegna,
      )
    }
    // Il canale spento (vedi `segnalaCanaleSpento`).
    segnalaCanaleSpento(d.notifiche)

    // Le scritture fallite del giro (presa parziale, ritorno in coda, rimozione dei dispositivi
    // morti): una riga `error` per ciascuna, con i contatori di ciò che il giro ha comunque
    // fatto, e il 500 al posto dell'«ok». Il battito non può dire «ok» su un giro che ha lasciato
    // notifiche marcate e mai spedite.
    if (scrittureFallite.length > 0) {
      for (const f of scrittureFallite) {
        queryFallita(f.azione, f.error, {
          inviate: d.inviate,
          native_inviate: d.native_inviate,
          notifiche: d.notifiche,
          rimesse_in_coda: d.rimesse_in_coda,
          arrese: d.arrese,
          subs_rimosse: d.subs_rimosse,
          // In un giro che chiude in 500 non c'è il battito «ok»: se i contatori della consegna
          // non fossero qui, le spunte accese da questo giro non sarebbero scritte in nessun log.
          consegne_chat: d.consegne_chat,
          consegne_chat_righe: d.consegne_chat_righe,
          consegne_chat_saltate: d.consegne_chat_saltate,
        })
      }
      return { stato: 500 }
    }

    // Il battito di chiusura, con i contatori: un dispatch che gira e invia sempre 0 è rotto
    // tanto quanto uno che non parte. `gia_prese` dice quante righe un giro sovrapposto aveva
    // già preso: la prova, in tabella, che la presa atomica sta evitando un doppione.
    riga(origine, 'info', {
      operazione,
      esito: 'ok',
      ms: Date.now() - t0,
      inviate: d.inviate,
      native_inviate: d.native_inviate,
      fallite: d.fallite,
      notifiche: d.notifiche,
      subs_rimosse: d.subs_rimosse,
      escluse_staff: d.escluse_staff,
      gia_prese: d.gia_prese,
      rimesse_in_coda: d.rimesse_in_coda,
      arrese: d.arrese,
      rinviate_per_tempo: d.rinviate_per_tempo,
      // Le doppie spunte di questo giro: senza questi numeri, «la consegna funziona» resterebbe
      // un'opinione, verificabile solo interrogando il database a mano — cioè da nessuno, che è
      // esattamente come le spunte sono rimaste spente per cinque ore.
      // I due primi sono DIVERSI di proposito: `consegne_chat` sono gli UPDATE riusciti,
      // `consegne_chat_righe` le spunte accese davvero. Un giro con `consegne_chat > 0` e
      // `consegne_chat_righe = 0` non è un guasto: vuol dire che l'app era aperta e D2 ha fatto
      // prima. Un giro con `consegne_chat_righe` sempre a zero, su molti giri, è D1 rotto.
      consegne_chat: d.consegne_chat,
      consegne_chat_righe: d.consegne_chat_righe,
      consegne_chat_saltate: d.consegne_chat_saltate,
      msg: `${operazione}: ok`,
    })
    return { stato: 200, data: d }
  } catch (err) {
    // Il fallimento TOTALE (il client admin che lancia, un guasto di rete): evento `cron` per il
    // cron, perché chi sorveglia i cron interroga `where evento = 'cron'` e non deve sapere che
    // il guasto peggiore si cerca da un'altra parte. `logErrore` emette l'Error con lo stack VERO.
    logErrore({ operazione, evento: origine === 'cron' ? 'cron' : 'push', ms: Date.now() - t0, stato: 500 }, err)
    return { stato: 500 }
  }
}
