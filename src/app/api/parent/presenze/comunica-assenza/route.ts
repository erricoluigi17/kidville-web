import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { formattaIstante } from '@/i18n/config'
import { rateLimit } from '@/lib/security/rate-limit'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// «COMUNICA UN'ASSENZA» — la funzione che nessuno ha mai potuto usare.
//
// Misurato in produzione il 2026-08-07: ZERO notifiche `assenza_comunicata` mai
// emesse, ZERO righe `presenze` con `giustificata_da` su 49. Non era poco usata:
// era irraggiungibile per costruzione, e serviva la combinazione di due difetti
// che presi uno per uno sembravano scelte:
//
//  · la dashboard del genitore portava alla pagina SOLO per nido e infanzia
//    (`parent/page.tsx`, `BottomNav.tsx`);
//  · questa route rispondeva 403 «Disponibile solo per la scuola primaria» a
//    chiunque non fosse primaria.
//
// I due insiemi sono complementari: l'intersezione è vuota. Nessun test era
// rosso — anzi, `comunica-assenza-sospensione.test.ts` era verde da mesi — e in
// `app_log` non c'era una riga, perché i 403 li registra `withRoute` a livello
// `info` e l'`info` NON si persiste. Un mese di silenzio perfetto.
//
// Da qui le regole che questo file ora rispetta e che i suoi test tengono
// ferme: la funzione vale per TUTTI I GRADI (il `school_type` decide solo dove
// porta il link della notifica), ogni rifiuto porta un CODICE tradotto e lascia
// una riga `warn`, e il genitore può ANNULLARE finché il docente non ha fatto
// l'appello.
//
// ─── LA QUARTA REGOLA, PAGATA IL 2026-08-07 ─────────────────────────────────
//
// L'APPELLO DEL DOCENTE NON SI SOVRASCRIVE. In nessuno dei due versi del gesto,
// in nessun giorno, e nemmeno se l'appello arriva mentre stiamo scrivendo. Fino
// al collaudo, questa regola era implementata come proprietà del solo
// ANNULLAMENTO, mentre la comunicazione si difendeva con la sola data — che
// copre ieri e lascia scoperto OGGI, cioè il giorno in cui l'appello si fa.
//
// E QUESTO STESSO BLOCCO DI COMMENTI DICHIARAVA IL CONTRARIO: sosteneva che la
// validazione della data avesse chiuso «un genitore poteva riscrivere a assente
// un giorno in cui il docente aveva già segnato presente». L'aveva chiusa per
// ieri, non per oggi. Un commento che descrive una protezione che non c'è è
// peggio di nessun commento: convince il lettore successivo a non ricontrollare.
// Le due difese ora vivono nel codice — nella WHERE della scrittura e nel
// confronto di data del DELETE — e questa nota resta a ricordare perché non ci
// si fida di una riga di prosa.
// =============================================================================

/**
 * L'annullamento viaggia sullo STESSO tipo della comunicazione: «titolo diverso,
 * stesso canale». Un tipo nuovo sarebbe un toggle nuovo nel pannello
 * Impostazioni (`src/lib/notifiche/tipi.ts`), e una scuola che spegne «Assenza
 * comunicata dal genitore» si ritroverebbe comunque gli annullamenti — cioè
 * l'impostazione mentirebbe.
 */
const TIPO_NOTIFICA = 'assenza_comunicata'

// ═════════════════════════════════════════════════════════════════════════════
// I TRE CONFINI CHE QUESTA ROTTA NON AVEVA (collaudo del 2026-08-07)
//
// Misurati, non dedotti: `data: '2099-12-31'` → **201**; un `motivo` di
// **200.000 caratteri** → **201**, e la GET successiva restituiva 200 KB; dodici
// chiamate di fila non costavano niente. Ogni colpo accodava una notifica ai
// docenti della sezione, e la rotta è aperta da questo ciclo a tutte e 32 le
// famiglie di tutti e tre i gradi.
//
// I tre numeri stanno QUI, uno per volta e con il loro perché: sono decisioni di
// prodotto, non dettagli d'implementazione, e sparpagliarli fra schema e handler
// è il modo in cui poi divergono.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Quanti giorni in avanti si può comunicare un'assenza.
 *
 * ─── PERCHÉ SESSANTA, E NON «UN ANNO SCOLASTICO» ────────────────────────────
 *
 * Sessanta giorni coprono con abbondanza ogni comunicazione che una famiglia fa
 * davvero: l'indomani, la settimana di viaggio, l'intervento già in calendario.
 * Un anno scolastico intero (il candidato ovvio, e quello che il rilievo
 * suggeriva) sarebbe dieci volte tanto e non servirebbe a nessuno — mentre
 * lascerebbe creare centinaia di righe per bambino e, soprattutto, NON
 * fermerebbe l'errore di battitura che questo tetto esiste anche per prendere:
 * «2027» al posto di «2026» resta dentro l'anno scolastico per metà dell'anno.
 *
 * E non è un limite di calendario: è un numero di GIORNI, quindi non ha né il
 * caso di bordo del 31 luglio (dove «fine dell'anno scolastico» collassa su
 * «oggi») né un fuso da sbagliare. Oltre il tetto la strada esiste e ha un nome:
 * la segreteria.
 *
 * Il tetto sul VOLUME è un'altra cosa e sta più sotto (`TETTO_SCRITTURE_FINESTRA`):
 * questo confine dice *fin dove*, quello dice *quanto in fretta*.
 */
export const GIORNI_MASSIMI_IN_ANTICIPO = 60

/**
 * Caratteri ammessi nel motivo dell'assenza.
 *
 * 500 è la misura che questo repo usa già per il testo libero scritto da un
 * genitore — `mensa/alternative` (`richiesta`), `merch/ordini` (`note`),
 * `merch/articoli` (`descrizione`) — ed è il posto giusto in cui stare: «febbre»
 * e «visita medica dal dentista, rientra dopo pranzo» ci stanno dentro dieci
 * volte.
 *
 * Non è una comodità di validazione: `giustificazione_testo` è testo libero di
 * natura sanitaria su un MINORE (art. 9), e la minimizzazione (art. 5.1.c) si
 * impone alla fonte. In produzione è già stata scritta una riga da 200.000
 * caratteri, restituita per intero al client del genitore e alle viste dei
 * docenti.
 */
export const MOTIVO_MAX_CARATTERI = 500

/** L'ampiezza della finestra del tetto di frequenza. */
export const TETTO_FINESTRA_MS = 10 * 60 * 1000

/**
 * Scritture (POST o DELETE) ammesse a un genitore in dieci minuti.
 *
 * ─── IL CONTO ───────────────────────────────────────────────────────────────
 *
 * Il gesto più intenso che una famiglia vera compie è comunicare una settimana
 * di assenze per più figli: tre bambini × cinque giorni = quindici colpi. Venti
 * lascia margine a quel caso e a un ripensamento, e chiude la porta alla raffica
 * — che qui non è un fastidio, perché **ogni POST accoda una notifica push ai
 * docenti della sezione**.
 *
 * I due verbi hanno budget SEPARATI (`assenza-comunica:` / `assenza-annulla:`):
 * una raffica di annullamenti e una di comunicazioni sono due guasti diversi e
 * si diagnosticano separatamente. La chiave è l'UTENTE e non l'IP, per la stessa
 * ragione delle rotte OTP: è l'unica cosa che l'attore non può cambiare senza
 * rifare il login, e dietro un NAT ci sta un plesso intero.
 *
 * ⚠️ Il contatore è condiviso via `public.tetto_frequenza`; se il database non
 * risponde degrada al conteggio per istanza — vedi la testata di
 * `src/lib/security/rate-limit.ts`. Un guasto costa PRECISIONE, non PROTEZIONE.
 */
export const TETTO_SCRITTURE_FINESTRA = 20

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` NON è più `z.string().min(1)`: quello schema accettava qualunque
// stringa, comprese le date del passato.
//
// ⚠️ QUI C'ERA SCRITTO CHE LA VALIDAZIONE DELLA DATA CHIUDEVA LA SOVRASCRITTURA
// DELL'APPELLO. Non era vero, e il collaudo del 2026-08-07 l'ha misurato: la
// data copre IERI, l'appello si fa OGGI, e oggi è il valore preimpostato nel
// modulo. Un bambino segnato «presente» alle 08:45 diventava «assente
// giustificato» con un 201. Quell'invariante ora vive dove deve vivere — nella
// WHERE della scrittura, più sotto — e non in questo commento.
// `motivo` resta permissivo SUL TIPO: qualunque tipo è accettato (i non-string
// diventano null). È testo libero di natura sanitaria, e NON entra in nessun log.
//
// ⚠️ IL TETTO DI LUNGHEZZA NON STA QUI, ED È UNA SCELTA. Due ragioni, e la
// seconda da sola basterebbe:
//  1. lo schema decide PRIMA di `requireParentOfStudent`. Un 400 emesso qui
//     scavalcherebbe il 403 del gate, e la prova adversarial dell'E2E pretende
//     **403** su un figlio altrui — è la stessa trappola già pagata con la data;
//  2. `validationError` risponde `{ error: 'Dati non validi', details }` senza
//     `codice`, e la regola di questo file è che **ogni rifiuto porta un codice
//     tradotto e lascia una riga `warn`**. Un tetto in zod sarebbe l'unico
//     diniego muto della rotta, in prosa italiana dentro un'interfaccia inglese.
// Il confine vive quindi nell'handler, subito dopo il gate, accanto a quello
// della data — e il numero è dichiarato una volta sola in `MOTIVO_MAX_CARATTERI`.
const postBodySchema = z.object({
  studentId: zUuid,
  data: zDataYMD,
  motivo: z.unknown().optional(),
})

/**
 * L'annullamento prende i parametri dalla QUERY, non dal corpo: un DELETE con
 * body è legale ma è un'anomalia che ogni proxy tratta a modo suo, e qui non
 * serve — sono due valori. Di conseguenza il gate `requireParentOfStudent` sta
 * PRIMA di qualunque lettura di corpo, e questo handler non ha (e non deve
 * avere) una voce nell'allowlist di `corpo-letto-dopo-il-gate`.
 */
const deleteQuerySchema = z.object({
  studentId: zUuid,
  data: zDataYMD,
})

/**
 * Dove porta la notifica al docente, secondo il GRADO della sezione.
 *
 * Il link era `/teacher/primaria/${section_id}/appello` per tutti — cioè una
 * rotta che esiste solo per la primaria. Finché la route rifiutava nido e
 * infanzia il difetto era invisibile; aprendola, una maestra del nido avrebbe
 * toccato la notifica e sarebbe finita su una pagina che per lei non esiste.
 *
 * Il ripiego è l'appello 0-6 e non il contrario: `/teacher/attendance` è una
 * pagina che esiste per chiunque insegni, mentre l'altro indirizzo contiene un
 * uuid di sezione e senza quello non è nemmeno formabile — quindi un grado
 * illeggibile degrada a una pagina che c'è, non a un indirizzo rotto.
 *
 * È PURA, e la lettura di `sections` sta negli handler: `sections` ha
 * `scuola_id`, e una query dentro un helper di file è codice che il lock
 * `isolamento-sede-coverage` valuta FUORI da ogni handler — cioè senza il gate
 * che l'handler ha appena eseguito. Il lock ha ragione a chiederlo: un helper
 * riusato non porta con sé le verifiche di chi lo chiama.
 */
function linkAppello(schoolType: string | null, sectionId: string | null): string {
  return schoolType === 'primaria' && sectionId
    ? `/teacher/primaria/${sectionId}/appello`
    : '/teacher/attendance'
}

/**
 * La riga di log di un RIFIUTO.
 *
 * Esiste perché `withRoute` registra 4xx e 403 a livello `info`, e `vaPersistito`
 * tiene in tabella solo `warn` ed `error`: è letteralmente il motivo per cui
 * questo difetto è vissuto un mese in produzione senza una sola riga
 * interrogabile. Un rifiuto che nessuno può contare è un rifiuto che nessuno
 * scopre.
 *
 * Ci vanno SOLO uuid, numeri e il codice: mai il motivo dell'assenza, che è un
 * dato sanitario di un minore (`giustificazione_testo` non compare in questo
 * file dentro nessun log, e i test lo verificano). `error_code` è in lista
 * bianca di `redact`; `codice` non lo è e uscirebbe come `[redatto:str/20]`.
 */
function logRifiuto(
  operazione: string,
  codice: string,
  campi: Record<string, string | number | null>,
): void {
  logEvento('registro', 'warn', { operazione, error_code: codice, ...campi })
}

/**
 * Il giorno come lo legge un DOCENTE ITALIANO: `11/08/2026`, non `2026-08-11`.
 *
 * Il corpo della notifica è l'unico testo che questa funzione produce per il
 * docente, ed è il motivo per cui la funzione esiste. La data si interpolava
 * grezza dalla stringa validata da `zDataYMD` (formato del database), mentre la
 * stessa data, sulla schermata del genitore, si legge `11/08/2026`: due formati
 * per lo stesso giorno a due utenti diversi.
 *
 * Non si può usare `useTranslations`: le notifiche si PERSISTONO e si rileggono
 * dalla campanella molto dopo, quindi il testo lo compone il server. È la strada
 * che il repo già percorre per le ricevute e gli export — `formattaIstante`
 * dichiara `Europe/Rome` per costruzione e restituisce stringa vuota invece di
 * lanciare su un input non valido.
 *
 * MEZZOGIORNO IN UTC, non mezzanotte: `${data}T00:00:00Z` a Roma è l'01:00 o le
 * 02:00 dello stesso giorno, ma basta un fuso a ovest per farlo scivolare al
 * giorno prima. A mezzogiorno nessuno scarto realistico cambia la data, e la
 * riga resta la stessa qualunque sia il fuso del processo.
 */
function giornoIt(data: string): string {
  return formattaIstante(`${data}T12:00:00Z`, 'it', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/**
 * L'ultimo giorno comunicabile, a partire da «oggi» in `YYYY-MM-DD`.
 *
 * Aritmetica di calendario in UTC e basta: `Date.UTC` somma i giorni senza mai
 * consultare il fuso del processo, e il risultato torna in `YYYY-MM-DD`. Il fuso
 * lo ha già deciso `oggiFiscaleISO()` una volta sola, a monte — sommare giorni a
 * una data locale sarebbe il modo di sbagliarlo una seconda volta.
 */
function ultimoGiornoComunicabile(oggi: string): string {
  const [anno, mese, giorno] = oggi.split('-').map(Number)
  return new Date(Date.UTC(anno, mese - 1, giorno + GIORNI_MASSIMI_IN_ANTICIPO))
    .toISOString()
    .slice(0, 10)
}

/**
 * Il 429 del tetto di frequenza.
 *
 * `TROPPE_RICHIESTE` è già dichiarato in `CODICI_ERRORE` e tradotto in entrambe
 * le lingue: qui non nasce un codice nuovo, si riusa quello che le rotte OTP del
 * genitore usano da sempre. `Retry-After` in secondi, come vuole l'HTTP: senza,
 * il client non sa se riprovare fra un minuto o fra dieci.
 *
 * Nessun `logEvento` qui dentro, ed è deliberato: `withRoute` classifica i 429
 * come ANOMALIE e li persiste già a livello `warn`. Una riga a mano sarebbe un
 * doppione che sposta soltanto il punto in cui si cerca.
 */
function troppeRichieste(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Troppe richieste in poco tempo. Riprova fra qualche minuto.',
      codice: 'TROPPE_RICHIESTE',
    },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    },
  )
}

/**
 * Consuma una unità del budget di scrittura dell'utente.
 *
 * Va chiamata **dopo** `requireParentOfStudent` — la chiave è l'id di sessione,
 * e chi non ha titolo su quel bambino deve leggere 403, non 429: un 429 gli
 * direbbe «riprova più tardi» su una porta che non si aprirà mai.
 */
async function tettoScritture(gruppo: string, userId: string): Promise<NextResponse | null> {
  const rl = await rateLimit(`${gruppo}:${userId}`, {
    limit: TETTO_SCRITTURE_FINESTRA,
    windowMs: TETTO_FINESTRA_MS,
  })
  return rl.ok ? null : troppeRichieste(rl.retryAfterMs)
}

// POST /api/parent/presenze/comunica-assenza?userId=
// body: { studentId, data, motivo? }
// Il genitore comunica IN ANTICIPO un'assenza (oggi o un giorno futuro). Crea o
// aggiorna la riga presenza come 'assente' già giustificata. TUTTI i gradi.
export const POST = withRoute('parent/presenze/comunica-assenza:POST', async (request: NextRequest) => {
  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { studentId, data, motivo } = b.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    // IL TETTO DI FREQUENZA, SUBITO DOPO IL GATE E PRIMA DI OGNI LETTURA.
    //
    // Dopo il gate perché la chiave è l'utente e perché chi non ha titolo su
    // quel bambino deve leggere 403. Prima di tutto il resto perché una raffica
    // non deve nemmeno costare le query che seguono: il senso di un tetto è che
    // il colpo respinto sia il più economico dei colpi.
    const tettoErr = await tettoScritture('assenza-comunica', userId)
    if (tettoErr) return tettoErr

    const supabase = await createAdminClient()

    // Sospensione moroso (DL-021 · M4): il genitore sospeso non può comunicare
    // un'assenza (azione di servizio). Guard DOPO l'identità di sessione; blocca
    // solo la SCRITTURA (la consultazione presenze resta accessibile).
    const sospesoErr = await assertGenitoreNonSospeso(supabase, userId)
    if (sospesoErr) return sospesoErr

    // LA DATA SI VALIDA QUI, E NEL FUSO DI ROMA.
    //
    // `oggiFiscaleISO()` e non `new Date().toISOString().slice(0,10)`: il runtime
    // di Vercel gira in UTC, quindi fra mezzanotte e le due del mattino italiane
    // «oggi» in UTC è ancora IERI. Con la data grezza, un genitore che comunica
    // l'assenza dell'indomani alle 00:30 si sarebbe visto accettare una data che
    // il server considera futura e il calendario italiano no — e, peggio, il
    // giorno appena finito sarebbe rimasto scrivibile per due ore.
    //
    // Il confronto è lessicografico perché entrambe le stringhe sono YYYY-MM-DD
    // a lunghezza fissa (zero-padded): su questo formato l'ordine dei caratteri
    // E l'ordine cronologico coincidono, e non c'è nessun `Date` da costruire —
    // cioè nessun fuso da sbagliare una seconda volta.
    const oggi = oggiFiscaleISO()
    if (data < oggi) {
      logRifiuto('parent/presenze/comunica-assenza:POST', 'ASSENZA_DATA_PASSATA', { alunno_id: studentId, stato: 400 })
      return NextResponse.json(
        { error: 'La data indicata è già passata', codice: 'ASSENZA_DATA_PASSATA' },
        { status: 400 },
      )
    }

    // …E ORA ANCHE IL TETTO SUPERIORE, che non c'è mai stato.
    //
    // Il confronto qui sopra è un limite INFERIORE, e per un mese è stato
    // l'UNICO vincolo temporale della rotta: `data: '2099-12-31'` rispondeva 201,
    // scriveva una riga di `presenze` e accodava una push ai docenti. Il
    // confronto resta lessicografico per la stessa ragione dell'altro — due
    // stringhe `YYYY-MM-DD` a lunghezza fissa ordinano come le date che
    // rappresentano, e non c'è nessun `Date` da costruire nel fuso sbagliato.
    if (data > ultimoGiornoComunicabile(oggi)) {
      logRifiuto('parent/presenze/comunica-assenza:POST', 'ASSENZA_DATA_TROPPO_LONTANA', {
        alunno_id: studentId,
        stato: 400,
        // I giorni, non la data: dice se è un errore di battitura (migliaia) o
        // una comunicazione un po' troppo in anticipo (settanta).
        n: GIORNI_MASSIMI_IN_ANTICIPO,
      })
      return NextResponse.json(
        {
          error: `Puoi comunicare un'assenza fino a ${GIORNI_MASSIMI_IN_ANTICIPO} giorni in anticipo`,
          codice: 'ASSENZA_DATA_TROPPO_LONTANA',
        },
        { status: 400 },
      )
    }

    // IL MOTIVO HA UNA LUNGHEZZA MASSIMA, e si normalizza UNA VOLTA SOLA.
    //
    // Era `z.unknown().optional()` e basta: permissivo sul tipo, e letto come
    // permissivo sulla dimensione. In produzione è già stata scritta una riga da
    // 200.000 caratteri — testo libero di natura sanitaria su un minore, che
    // torna per intero al client del genitore e alle viste dei docenti.
    //
    // Si misura il testo NORMALIZZATO (`trim`), che è quello che finisce in
    // tabella: rifiutare per gli spazi in coda sarebbe un rifiuto che il
    // genitore non può capire guardando ciò che ha scritto.
    const motivoTesto = typeof motivo === 'string' ? motivo.trim() : ''
    if (motivoTesto.length > MOTIVO_MAX_CARATTERI) {
      logRifiuto('parent/presenze/comunica-assenza:POST', 'ASSENZA_MOTIVO_TROPPO_LUNGO', {
        alunno_id: studentId,
        stato: 400,
        // La LUNGHEZZA, mai il testo: il motivo è un dato sanitario di un minore
        // e non entra in nessun log. Il numero dice se è un incollaggio
        // sbagliato o un collaudo con 200.000 caratteri.
        n: motivoTesto.length,
      })
      return NextResponse.json(
        {
          error: `Il motivo non può superare ${MOTIVO_MAX_CARATTERI} caratteri`,
          codice: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
        },
        { status: 400 },
      )
    }

    // `nome`/`cognome` si leggono QUI e non in una seconda query dentro il blocco
    // di notifica: è la stessa riga, e servono al corpo dell'avviso. Non escono
    // mai da questa funzione se non dentro `corpo`.
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()

    if (alunnoErr) {
      // PostgREST non lancia. Senza questo controllo una lettura fallita usciva
      // dalla porta del 404 «Alunno non trovato»: al genitore si diceva che suo
      // figlio non esiste per un guasto del database.
      logErrore({ operazione: 'parent/presenze/comunica-assenza:POST', stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ASSENZA_NON_SALVATA' },
        { status: 500 },
      )
    }
    if (!alunno) {
      logRifiuto('parent/presenze/comunica-assenza:POST', 'ALUNNO_NON_TROVATO', { alunno_id: studentId, stato: 404 })
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_NON_TROVATO' },
        { status: 404 },
      )
    }

    // ═══ LA SCRITTURA È CONDIZIONATA, NON CIECA ══════════════════════════════
    //
    // Era `upsert(…, { onConflict: 'alunno_id,data' })`, cioè INSERT … ON
    // CONFLICT DO UPDATE sulle SOLE colonne del payload. Su una riga che il
    // docente aveva già lavorato riscriveva `stato` a 'assente' e lasciava
    // intatti `registrato_da` e `orario_entrata`, che nel payload non ci sono: ne
    // usciva una riga che nessuno dei due attori riconosceva come propria, con un
    // 201 e una notifica «sarà assente» a una maestra che il bambino l'aveva
    // appena visto entrare. E il danno diventava irreparabile dall'interfaccia:
    // quella riga risulta «già registrata», quindi il genitore non può annullarla
    // (409) e non la vede nemmeno in elenco (`comunicate` filtra
    // `registrato_da IS NULL`).
    //
    // L'invariante è lo stesso del DELETE — «l'insegnante ha già lavorato questa
    // presenza» — e da qui in avanti è una proprietà della COPPIA di route, non
    // del solo annullamento.
    //
    // ─── PERCHÉ TRE PASSI E NON UNA LETTURA + UPSERT ────────────────────────
    //
    // Perché fra la lettura e la scrittura ci sta l'appello: è la stessa mezz'ora
    // del mattino, e il genitore che comunica «oggi» lo fa proprio mentre la
    // maestra apre il registro. Una guardia basata su ciò che si è letto un
    // istante prima è una guardia che in quella mezz'ora non c'è. Quindi:
    //
    //  1. si LEGGE — non per decidere la scrittura, ma per poter dire QUALE riga
    //     ha bloccato la comunicazione (`presenza_id` nel log) e per rispondere
    //     409 al primo colpo nel caso normale;
    //  2. si AGGIORNA con la condizione DENTRO la WHERE (`registrato_da IS NULL`)
    //     e si guarda quante righe sono state colpite: quella condizione la
    //     valuta il database, sotto lock di riga, non questo processo;
    //  3. se non c'era niente da aggiornare si INSERISCE, e lì la corsa la
    //     arbitra `unique_presenza_giornaliera (alunno_id, data)`: chi perde
    //     prende `23505` invece di scrivere una seconda riga per lo stesso
    //     giorno. A quel punto la riga c'è ed è di qualcun altro: si riprova
    //     UNA volta l'aggiornamento condizionato, che distingue le due corse
    //     opposte — persa contro un DOCENTE (409, l'appello vince) o persa
    //     contro l'ALTRO GENITORE (201, la comunicazione è comunque sua).
    //
    // Un solo giro di riprova, e la condizione resta nella WHERE: non è un
    // ritentativo ottimistico che può girare all'infinito.
    //
    // `scuola_id` È DICHIARATO su ENTRAMBE le scritture, e chiude il debito che
    // l'allowlist di `isolamento-sede-coverage` teneva aperto dal 2026-07-31
    // («l'attore è verificato, la riga nasce senza plesso»). Fino a ieri lo
    // metteva solo il trigger `trg_presenze_scuola_id`: una rete, non un
    // presidio — e una rete che il DB E2E della CI non ha, perché non è migrato.
    const sezione = (alunno.section_id as string | null) ?? null
    const riga = {
      alunno_id: studentId,
      scuola_id: alunno.scuola_id,
      section_id: alunno.section_id,
      data,
      stato: 'assente',
      giustificata: true,
      giustificazione_testo: motivoTesto || null,
      giustificata_da: userId,
      giustificata_il: new Date().toISOString(),
    }

    const errore500 = (e: unknown) => {
      // Il `message` di PostgREST NON esce verso il client (era `{ error:
      // error.message }`: prosa inglese con dentro nomi di colonne, mostrata a un
      // genitore). Resta nel log, intero, che è dove dice PERCHÉ.
      logErrore({ operazione: 'parent/presenze/comunica-assenza:POST', stato: 500, evento: 'db' }, e)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ASSENZA_NON_SALVATA' },
        { status: 500 },
      )
    }

    const rifiuto409 = (presenzaId: string | null, esito: string) => {
      logRifiuto('parent/presenze/comunica-assenza:POST', 'ASSENZA_GIA_REGISTRATA', {
        alunno_id: studentId,
        presenza_id: presenzaId,
        stato: 409,
        // Due diagnosi sotto lo stesso codice, come nel DELETE: «l'appello era
        // già lì quando ho guardato» e «è arrivato mentre scrivevo» si correggono
        // in due modi diversi, e la differenza non si legge dallo status.
        esito,
      })
      return NextResponse.json(
        { error: 'La presenza di questo giorno è già stata registrata', codice: 'ASSENZA_GIA_REGISTRATA' },
        { status: 409 },
      )
    }

    // ═══ SI CHIEDONO DUE COLONNE, NON VENTICINQUE ════════════════════════════
    //
    // `.select()` nudo su PostgREST è `select *`, ed era stato scritto per
    // ottenere l'`id` della riga (serve come `entitaId` della notifica). Si
    // portava dietro tutto il resto — e nel caso di UPDATE ciò che torna non è
    // quello che il chiamante ha scritto, ma quello che C'ERA: `note_appello`
    // (nota del docente), `registrato_da`/`utente_id` (identificativi di
    // personale scolastico) e soprattutto `giustificazione_firma`, che è il log
    // della firma elettronica e contiene **email, indirizzo IP e user agent** di
    // chi ha firmato.
    //
    // Il caso concreto misurato: riga futura già giustificata con firma dal
    // genitore A, il genitore B della stessa famiglia rifà la comunicazione
    // (consentito: `registrato_da` è nullo) e riceve nella risposta email, IP e
    // user agent di A. Al modulo servono `id` e `data`.
    const COLONNE_ESITO = 'id, data'

    /** UPDATE con la condizione nella WHERE: ritorna le righe DAVVERO colpite. */
    const aggiornaSeNonRegistrata = async () =>
      await supabase
        .from('presenze')
        .update(riga)
        .eq('alunno_id', studentId)
        .eq('data', data)
        .is('registrato_da', null)
        .select(COLONNE_ESITO)

    const { data: esistente, error: letturaErr } = await supabase
      .from('presenze')
      .select('id, registrato_da')
      .eq('alunno_id', studentId)
      .eq('data', data)
      .maybeSingle()
    if (letturaErr) return errore500(letturaErr)
    if (esistente?.registrato_da) {
      return rifiuto409((esistente.id as string | null) ?? null, 'appello-gia-fatto')
    }

    const { data: aggiornate, error: aggiornaErr } = await aggiornaSeNonRegistrata()
    if (aggiornaErr) return errore500(aggiornaErr)
    // `| null` DICHIARATO: senza `noUncheckedIndexedAccess`, TypeScript tipa
    // `array[0]` come non-nullo anche quando l'array è vuoto — cioè proprio il
    // caso che qui decide se si passa all'INSERT.
    type RigaEsito = { id?: string; data?: string }
    let row: RigaEsito | null = ((aggiornate ?? []) as RigaEsito[])[0] ?? null
    let creata = false

    if (!row) {
      const { data: inserita, error: inserisciErr } = await supabase
        .from('presenze')
        .insert(riga)
        .select(COLONNE_ESITO)
        .single()
      if (!inserisciErr) {
        row = inserita as RigaEsito | null
        creata = true
      } else if ((inserisciErr as { code?: string }).code === '23505') {
        // Corsa persa: la riga di quel giorno è comparsa fra il passo 2 e il 3.
        // Chi l'ha scritta lo dice la stessa condizione di prima.
        const { data: riprovate, error: riprovaErr } = await aggiornaSeNonRegistrata()
        if (riprovaErr) return errore500(riprovaErr)
        row = ((riprovate ?? []) as RigaEsito[])[0] ?? null
        if (!row) return rifiuto409(null, 'appello-in-corsa')
      } else {
        return errore500(inserisciErr)
      }
    }

    const presenzaId = row?.id ?? null

    // Il grado serve SOLO a scegliere il link della notifica: non rifiuta più
    // nessuno. È l'intero residuo del gate «solo primaria» che rendeva questa
    // funzione irraggiungibile a nido e infanzia.
    let schoolType: string | null = null
    if (sezione) {
      const { data: sez, error: sezErr } = await supabase
        .from('sections')
        .select('school_type')
        .eq('id', sezione)
        .maybeSingle()
      if (sezErr) {
        // PostgREST non lancia: senza questo controllo un grado illeggibile
        // sarebbe indistinguibile da «sezione senza grado», e la notifica
        // partirebbe col ripiego senza che nessuno sappia perché.
        logEvento('registro', 'warn', {
          operazione: 'parent/presenze/comunica-assenza:POST',
          esito: 'grado-non-letto',
          sezione_id: sezione,
        }, sezErr)
      }
      schoolType = (sez?.school_type as string | null) ?? null
    }

    // Quanti docenti sono stati avvisati. `null` finché non lo si sa: se il
    // blocco qui sotto muore prima del conteggio, la riga di successo lo dice
    // invece di inventare uno zero — «nessun destinatario» e «non sono arrivato a
    // contarli» sono due guasti diversi.
    let nDocenti: number | null = null

    // Notifica ai docenti della sezione (best-effort): assenza comunicata.
    try {
      const docenti = (await docentiDiSezione(supabase, sezione)).filter((id) => id !== userId)
      nDocenti = docenti.length
      const nomeAlunno = [alunno.nome, alunno.cognome].filter(Boolean).join(' ') || 'Un alunno'
      await notificaEvento(supabase, {
        tipo: TIPO_NOTIFICA,
        scuolaId: (alunno.scuola_id as string | undefined) ?? null,
        utenteIds: docenti,
        titolo: 'Assenza comunicata',
        corpo: `${nomeAlunno} sarà assente il ${giornoIt(data)}.`,
        link: linkAppello(schoolType, sezione),
        entitaTipo: 'presenza',
        // L'ENTITÀ È LA RIGA DI PRESENZA, non l'alunno. Con `studentId` due
        // assenze di giorni diversi dello stesso bambino erano la stessa entità:
        // la revoca dell'una avrebbe cancellato dalla coda l'altra, legittima. È
        // già così nel gemello `parent/presenze/giustifica/route.ts`.
        entitaId: presenzaId,
        bufferMin: 0,
        // LA RAFFICA SULLO STESSO GIORNO COLLASSA IN UNA NOTIFICA SOLA.
        //
        // Senza `debounce`, ogni POST produceva una riga `notifiche` per docente
        // e una push immediata: un genitore che corregge tre volte il motivo
        // della stessa assenza svegliava la maestra tre volte, e una raffica
        // svegliava un plesso. Il gemello `attendance/daily:POST` lo fa già.
        //
        // Non confonde due giorni diversi: `entitaId` è la RIGA di presenza —
        // una per (alunno, data) — non l'alunno. È la stessa proprietà per cui
        // l'`entitaId` è stato cambiato in questo ciclo.
        debounce: true,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'parent/presenze/comunica-assenza:POST',
        tipo: TIPO_NOTIFICA,
        esito: 'notifica_non_inviata',
      }, e)
    }

    // IL SUCCESSO SI LOGGA — è la domanda che ha aperto questo ciclo.
    //
    // «Sta funzionando? qualcuno sta comunicando assenze, e ai docenti arriva
    // l'avviso?» non aveva risposta interrogabile: di una POST riuscita restava
    // solo il `KV_OK` di `withRoute`, che non dice per quale alunno, se la riga è
    // stata scritta né a quanti docenti è partito l'avviso — e che `logOk` non
    // persiste mai. È lo stesso silenzio in cui il difetto originale è vissuto un
    // mese: con i soli errori, «nessun log» non distingue «tutto ok» da «non è
    // mai partito niente».
    //
    // IL CONTEGGIO È LA PARTE CHE CONTA: senza `n_docenti`, «la maestra non ha
    // ricevuto niente» resta indistinguibile da «l'avviso è partito e la push non
    // è arrivata» — e in produzione un solo docente su 12 ha una sottoscrizione
    // push.
    //
    // Solo uuid, enumerati e numeri: `grado` è in lista bianca di `redact`, gli
    // uuid passano per forma, i booleani e i numeri in chiaro. Il MOTIVO
    // dell'assenza non compare qui e non deve comparirci mai: è un dato sanitario
    // di un minore.
    //
    // ⚠️ QUI C'ERA SCRITTO CHE QUESTA RIGA NON FINISCE IN TABELLA. Non è vero, e
    // non lo era nemmeno il giorno in cui è stato scritto: `registro` **è** fra
    // gli `EVENTI_PERSISTITI` (`src/lib/logging/logger.ts`), aggiunto dallo
    // stesso commit che ha scritto questo commento. `vaPersistito` manda in
    // `app_log` tutto ciò che ha un evento persistito, `info` compreso — quindi
    // «sta funzionando? qualcuno sta comunicando assenze?» si risponde in SQL, ed
    // è esattamente la domanda che ha aperto questo ciclo.
    //
    // Un commento che dichiara un limite inesistente costa quanto uno che
    // dichiara una protezione inesistente: convince il lettore successivo a
    // cercare la risposta dove non è.
    logEvento('registro', 'info', {
      operazione: 'parent/presenze/comunica-assenza:POST',
      esito: 'assenza-comunicata',
      alunno_id: studentId,
      presenza_id: presenzaId,
      attore_id: userId,
      sezione_id: sezione,
      grado: schoolType,
      n_docenti: nDocenti,
      // Una comunicazione NUOVA o la correzione di una già inviata: sono due
      // gesti diversi, e in tabella si contano insieme.
      riga_creata: creata,
    })

    // LA RISPOSTA SI COMPONE, NON SI INOLTRA.
    //
    // `data: row` restituiva ciò che PostgREST aveva in mano; qui si dichiara
    // campo per campo ciò che il modulo usa. È difesa in profondità e non
    // ridondanza: il `.select('id, data')` più sopra decide cosa viaggia sul
    // filo, questa riga decide cosa esce dall'API — e il giorno in cui qualcuno
    // riallarga la `select` per un motivo suo, la risposta non cambia.
    //
    // Nessun `giustificazione_testo`: è il dato sanitario del minore, il client
    // l'ha appena mandato e non ha bisogno di riaverlo indietro.
    return NextResponse.json(
      { success: true, data: { id: row?.id ?? null, data: row?.data ?? data } },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: 'parent/presenze/comunica-assenza:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: 'Errore interno', codice: 'ASSENZA_NON_SALVATA' },
      { status: 500 },
    )
  }
})

// DELETE /api/parent/presenze/comunica-assenza?studentId=&data=
// Il genitore annulla un'assenza che ha comunicato lui, finché il docente non ha
// fatto l'appello di quel giorno.
export const DELETE = withRoute('parent/presenze/comunica-assenza:DELETE', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { studentId, data } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    // Il tetto vale in ENTRAMBI i versi del gesto, e su un budget suo: la DELETE
    // cancella righe di registro e può accodare una notifica «assenza annullata»
    // ai docenti. Una raffica di annullamenti è un guasto diverso da una di
    // comunicazioni, e con due chiavi separate si legge separatamente.
    const tettoErr = await tettoScritture('assenza-annulla', userId)
    if (tettoErr) return tettoErr

    const supabase = await createAdminClient()

    // Stessa catena del POST: un account sospeso non modifica il registro, in
    // nessuna direzione.
    const sospesoErr = await assertGenitoreNonSospeso(supabase, userId)
    if (sospesoErr) return sospesoErr

    // SI ANNULLA CIÒ CHE DEVE ANCORA ACCADERE, NON CIÒ CHE È GIÀ STATO.
    //
    // La regola temporale viveva in UNO SOLO dei due versi del gesto: il POST
    // rifiutava le date passate, questo handler no — e qui la cancellazione è
    // FISICA. Il criterio di annullabilità («`registrato_da` nullo e
    // `giustificata_da` valorizzato») non è una firma della comunicazione: è
    // esattamente la forma che assume un'assenza dello 0-6 registrata prima di
    // questo ciclo e poi GIUSTIFICATA dal genitore, perché
    // `parent/presenze/giustifica` scrive `giustificata_da` su qualunque riga
    // passata. Bastava quello perché una riga vera del registro sparisse dal
    // database — insieme a `giustificazione_firma`, cioè al log della firma
    // elettronica — senza lasciare traccia, e senza che il POST potesse
    // nemmeno ricrearla (400 sulla stessa data).
    //
    // L'argomento che reggeva la sicurezza del criterio era una MISURA DI QUEL
    // GIORNO (`count(giustificata_da) = 0` su 49 presenze), cioè un fatto
    // destinato a smettere di essere vero appena un genitore usa la giustifica.
    // Questo confronto invece non scade.
    //
    // ⚠️ QUI NON C'È IL TETTO SUPERIORE CHE IL POST HA APPENA PRESO, ed è
    // deliberato: le righe con una data assurda **esistono già** — il collaudo
    // del 2026-08-07 ne ha scritta una al 2099 su un alunno di prova prima che
    // il tetto ci fosse. Chiudere anche questa porta significherebbe renderle
    // non annullabili dall'interfaccia, cioè trasformare un difetto già chiuso
    // alla fonte in un dato che nessun genitore può più togliersi di dosso.
    // L'annullamento è l'unica via d'uscita: resta aperta.
    if (data < oggiFiscaleISO()) {
      logRifiuto('parent/presenze/comunica-assenza:DELETE', 'ASSENZA_DATA_PASSATA', {
        alunno_id: studentId,
        stato: 400,
      })
      return NextResponse.json(
        { error: 'La data indicata è già passata', codice: 'ASSENZA_DATA_PASSATA' },
        { status: 400 },
      )
    }

    const { data: riga, error: letturaErr } = await supabase
      .from('presenze')
      .select('id, section_id, scuola_id, giustificata_da, registrato_da')
      .eq('alunno_id', studentId)
      .eq('data', data)
      .maybeSingle()

    if (letturaErr) {
      // Degradare qui a «niente da annullare» sarebbe la bugia peggiore: il
      // genitore crede di aver ritirato l'assenza e la riga resta.
      logErrore({ operazione: 'parent/presenze/comunica-assenza:DELETE', stato: 500, evento: 'db' }, letturaErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ASSENZA_NON_ANNULLATA' },
        { status: 500 },
      )
    }

    // IDEMPOTENTE. Niente da annullare non è un errore: lo stato che il genitore
    // vuole — nessuna assenza comunicata per quel giorno — è già quello. Succede
    // col doppio tocco, con una schermata ricaricata, con due dispositivi aperti.
    // Un 404 qui manderebbe un messaggio d'errore per un'operazione riuscita.
    if (!riga) {
      return NextResponse.json({ success: true, annullata: false })
    }

    // SI ANNULLA SOLO CIÒ CHE È NATO DA UNA COMUNICAZIONE E CHE NESSUN DOCENTE
    // HA LAVORATO.
    //
    // ─── PERCHÉ ESISTENZA E NON APPARTENENZA ────────────────────────────────
    //
    // Fino al 2026-08-07 la seconda condizione era `giustificata_da !== userId`:
    // si annullava solo ciò che si era comunicato di persona. Sembra prudenza, ed
    // era invece un messaggio d'errore che diceva il falso a metà delle famiglie.
    // Misurato in produzione: **10 alunni su 26 hanno due genitori** in
    // `student_parents`, e la GET che alimenta l'elenco (`parent/presenze`) NON
    // filtra su chi ha comunicato. Quindi il secondo genitore vedeva la riga in
    // elenco, premeva «Annulla» e leggeva «La presenza di questo giorno è già
    // stata registrata» — mentre l'insegnante non aveva toccato niente. Un
    // rifiuto che racconta un fatto che non è avvenuto, sulla stessa classe di
    // difetto che questo intervento è nato per chiudere.
    //
    // La garanzia non è l'identità di chi ha scritto la riga: è il GATE.
    // `requireParentOfStudent` ha già verificato il legame con il bambino, e per
    // un genitore quello scope è la famiglia intera — nemmeno la sede si applica,
    // perché due fratelli possono stare in due plessi. «L'ha comunicata mia
    // moglie e io non posso toglierla» è un caso che nessuna famiglia capirebbe,
    // e che il gate non ha nessuna ragione di produrre.
    //
    // ─── COSA FERMA ANCORA IL CONTROLLO DI SOLA ESISTENZA ───────────────────
    //
    // Le righe dell'APPELLO: il docente non valorizza `giustificata_da`, quindi
    // una riga con quella colonna nulla non è mai nata da una comunicazione e non
    // si tocca. Ci ricadono per intero anche le righe storiche — misurato il
    // 2026-08-07, `count(giustificata_da) = 0` su 49 presenze, comprese le 36 che
    // non hanno nemmeno `registrato_da`. Nessun backfill serve: l'argomento delle
    // «36 righe storiche» reggeva grazie a questa colonna, non grazie al confronto
    // con `userId`, che su quelle righe non decideva nulla.
    //
    // La prima condizione regge solo da questo ciclo: fino a ieri l'appello 0-6
    // non scriveva `registrato_da` (13 righe su 49, tutte della primaria), quindi
    // «nessun docente l'ha toccata» non era decidibile per nido e infanzia. Ora lo
    // scrivono entrambi i gradi (`attendance/daily:POST`).
    const appelloFatto = Boolean(riga.registrato_da)
    if (appelloFatto || !riga.giustificata_da) {
      logRifiuto('parent/presenze/comunica-assenza:DELETE', 'ASSENZA_GIA_REGISTRATA', {
        alunno_id: studentId,
        presenza_id: riga.id as string,
        stato: 409,
        // Un solo codice a schermo, due diagnosi nel log: «l'insegnante ha già
        // fatto l'appello» e «quella riga non l'ha scritta nessun genitore» si
        // correggono in due modi diversi, e la differenza non si può leggere
        // dallo status.
        esito: appelloFatto ? 'appello-gia-fatto' : 'non-nata-da-comunicazione',
      })
      return NextResponse.json(
        { error: 'La presenza di questo giorno è già stata registrata', codice: 'ASSENZA_GIA_REGISTRATA' },
        { status: 409 },
      )
    }

    // LA RIGA SI CANCELLA, non si riporta a uno stato neutro: prima della
    // comunicazione non esisteva, e `presenze_stato_check` non ammette uno stato
    // vuoto. Lasciarla «presente» direbbe al registro una cosa che nessuno ha
    // verificato — che il bambino c'era.
    //
    // Si cancella con LE STESSE CHIAVI con cui è stata letta, non per `id`:
    // `unique_presenza_giornaliera UNIQUE (alunno_id, data)` rende la coppia una
    // chiave, quindi la riga colpita è esattamente quella verificata qui sopra —
    // e in più la clausola porta addosso `alunno_id`, che è l'identità che
    // `requireParentOfStudent` ha verificato. Con `.eq('id', …)` il legame con il
    // gate sarebbe solo nella testa di chi legge.
    const { error: cancErr } = await supabase
      .from('presenze')
      .delete()
      .eq('alunno_id', studentId)
      .eq('data', data)
    if (cancErr) {
      logErrore({ operazione: 'parent/presenze/comunica-assenza:DELETE', stato: 500, evento: 'db' }, cancErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'ASSENZA_NON_ANNULLATA' },
        { status: 500 },
      )
    }

    // REVOCA della notifica ancora in coda — stesso pattern di
    // `attendance/daily:POST`, ed è lì che sta scritto perché l'errore della
    // delete si logga: PostgREST NON lancia, quindi un `catch` attorno sarebbe
    // codice morto proprio sul ramo che pretende di coprire. E il fallimento
    // della revoca non è una notifica mancata: è una notifica FALSA — la maestra
    // riceverebbe «sarà assente» per un'assenza già ritirata.
    //
    // `.select('id')` non è un ornamento: dice QUANTE righe sono state tolte, ed
    // è così che si sa se la push era già partita.
    const { data: revocate, error: revocaErr } = await supabase
      .from('notifiche')
      .delete()
      .eq('tipo', TIPO_NOTIFICA)
      .eq('entita_id', riga.id)
      .is('push_inviata_il', null)
      .select('id')

    if (revocaErr) {
      logEvento('notifica', 'error', {
        operazione: 'parent/presenze/comunica-assenza:DELETE',
        esito: 'revoca-assenza-fallita',
        tipo: TIPO_NOTIFICA,
        presenza_id: riga.id as string,
      }, revocaErr)
    }

    // Nessuna riga tolta dalla coda ⇒ o la push era già partita, o la revoca è
    // fallita. In entrambi i casi c'è un docente che può credere a un'assenza che
    // non c'è più, e allora si avvisa: meglio una notifica in più.
    const daAvvisare = Boolean(revocaErr) || (revocate ?? []).length === 0
    if (daAvvisare) {
      try {
        const { data: anagrafica, error: anagraficaErr } = await supabase
          .from('alunni')
          .select('nome, cognome, scuola_id')
          .eq('id', studentId)
          .maybeSingle()
        if (anagraficaErr) {
          // `warn`: l'avviso parte lo stesso, col nome generico.
          logEvento('registro', 'warn', {
            operazione: 'parent/presenze/comunica-assenza:DELETE',
            esito: 'anagrafica-non-letta',
            alunno_id: studentId,
          }, anagraficaErr)
        }
        const sezione = (riga.section_id as string | null) ?? null
        let schoolType: string | null = null
        if (sezione) {
          const { data: sez, error: sezErr } = await supabase
            .from('sections')
            .select('school_type')
            .eq('id', sezione)
            .maybeSingle()
          if (sezErr) {
            logEvento('registro', 'warn', {
              operazione: 'parent/presenze/comunica-assenza:DELETE',
              esito: 'grado-non-letto',
              sezione_id: sezione,
            }, sezErr)
          }
          schoolType = (sez?.school_type as string | null) ?? null
        }
        const docenti = (await docentiDiSezione(supabase, sezione)).filter((id) => id !== userId)
        const nomeAlunno = [anagrafica?.nome, anagrafica?.cognome].filter(Boolean).join(' ') || 'Un alunno'
        await notificaEvento(supabase, {
          tipo: TIPO_NOTIFICA,
          scuolaId: (riga.scuola_id as string | undefined) ?? (anagrafica?.scuola_id as string | undefined) ?? null,
          utenteIds: docenti,
          titolo: 'Assenza annullata',
          corpo: `${nomeAlunno} sarà presente il ${giornoIt(data)}: l'assenza comunicata è stata annullata.`,
          link: linkAppello(schoolType, sezione),
          entitaTipo: 'presenza',
          entitaId: riga.id as string,
          bufferMin: 0,
        })
      } catch (e) {
        logEvento('notifica', 'error', {
          operazione: 'parent/presenze/comunica-assenza:DELETE',
          tipo: TIPO_NOTIFICA,
          esito: 'annullamento_non_notificato',
        }, e)
      }
    }

    // Il SUCCESSO si logga: è una cancellazione di dato, e «nessun log» non deve
    // poter significare insieme «tutto a posto» e «non è mai partito niente» —
    // che è esattamente l'ambiguità in cui questa funzione è vissuta un mese.
    // `info` e non `warn` perché una cancellazione riuscita non è un'anomalia; e
    // in tabella ci finisce lo stesso, perché `registro` è fra gli
    // `EVENTI_PERSISTITI` — la riga qui sopra diceva il contrario e sbagliava.
    //
    // `attore_id` NON è un ornamento, ed è nato insieme all'ambito famiglia qui
    // sopra: finché si annullava solo il proprio, «chi l'ha tolta» si deduceva
    // dalla riga: era chi l'aveva scritta. Ora che può toglierla l'altro
    // genitore, la riga cancellata non porta più quella risposta, e se non la
    // scrive il log non la sa più nessuno. È un uuid — passa la lista bianca di
    // `redact` per la forma, non per la chiave — e non dice altro che «quale
    // account»: nessun nome, nessuna email, e mai il motivo dell'assenza.
    logEvento('registro', 'info', {
      operazione: 'parent/presenze/comunica-assenza:DELETE',
      esito: 'assenza-annullata',
      alunno_id: studentId,
      presenza_id: riga.id as string,
      attore_id: userId,
      notifica_gia_partita: daAvvisare,
    })

    return NextResponse.json({ success: true, annullata: true })
  } catch (err) {
    logErrore({ operazione: 'parent/presenze/comunica-assenza:DELETE', stato: 500 }, err)
    return NextResponse.json(
      { error: 'Errore interno', codice: 'ASSENZA_NON_ANNULLATA' },
      { status: 500 },
    )
  }
})
