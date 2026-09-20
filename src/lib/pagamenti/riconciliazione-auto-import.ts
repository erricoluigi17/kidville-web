import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import type { AppUser } from '@/lib/auth/require-staff'
import { sediReali } from '@/lib/scuole/reali'
import { marcaAutomaticaDisponibile } from '@/lib/pagamenti/marca-automatica'
import { residuoEffettivo } from '@/lib/pagamenti/aging'
import { round2 } from '@/lib/pagamenti/transazioni-quadratura'
import { pagantiAmmessiPerAlunni } from '@/lib/pagamenti/pagante-ammesso'
import { scegliPaganteComune } from '@/lib/pagamenti/pagante-comune'
import { proponiAncora, type RigaComposizione } from '@/lib/pagamenti/conciliazione-composita'
import { confermaSuVoceSingola } from '@/lib/pagamenti/riconciliazione-conferma'
import { registraConciliazione } from '@/lib/pagamenti/conciliazione-registra'
import {
  valutaCertezza,
  type VoceCertezza,
  type VoceIncassabile,
} from '@/lib/pagamenti/riconciliazione-auto'

// ─────────────────────────────────────────────────────────────────────────────
// L'ABBINAMENTO AUTOMATICO DENTRO L'IMPORT — la fase che scrive denaro senza
// che nessuno clicchi.
//
// Ogni guardia del percorso manuale vale anche qui: non ne esiste una copia in
// questo file. `valutaCertezza` decide, `confermaSuVoceSingola` e
// `registraConciliazione` scrivono, e i loro nove/cinque gate si attraversano
// tali e quali. Quello che sta qui è ciò che il percorso manuale ha in una
// PERSONA e l'automatismo non ha: il perimetro di sede, la scelta del pagante,
// il tetto di lavoro, e la decisione di non avvisare la famiglia.
//
// ─── DOVE SCATTA, E PERCHÉ PROPRIO LÌ ───────────────────────────────────────
// Secondo passo dentro la STESSA richiesta del `POST` di import, DOPO gli
// insert a blocchi. Non dentro il ciclo che costruisce le righe, per tre
// ragioni:
//
//  1. il compare-and-swap confronta lo STATO DELLA RIGA (`.eq('stato', …)`), e
//     dentro il ciclo la riga non esiste ancora: non c'è niente da confrontare
//     e niente da marcare;
//  2. l'insert a blocchi può fallire A METÀ — il file dell'import lo dichiara e
//     lo logga (`movimenti-scritti-a-meta`) — e allora resterebbero incassi
//     puntati su movimenti mai scritti, cioè denaro incassato su una riga
//     bancaria che in registro non c'è;
//  3. così la degradazione è un NON-EVENTO: se questa fase cade, le righe
//     restano gialle o rosse, cioè esattamente il comportamento di ieri, e
//     l'import resta valido. È il motivo per cui tutto il corpo sta dentro un
//     `try` che non rilancia mai.
//
// ─── COSA QUESTA FASE NON FA ────────────────────────────────────────────────
//  · NON emette fatture e non ne mette in coda: decisione del titolare,
//    l'automatismo si ferma all'abbinamento;
//  · NON ripassa lo storico: solo i movimenti di QUESTO import;
//  · NON crea voci nuove né ticket, e non mette niente a credito;
//  · NON avvisa il genitore — vedi qui sotto.
//
// ─── 🔴 LA NOTIFICA AL GENITORE: DECISIONE DEL TITOLARE, ED È UN'ASSENZA ────
//
// In questo file non c'è nessuna chiamata a `notificaEvento`, e non è una
// dimenticanza:
//
//  · la notifica partirà quando la segreteria avrà GUARDATO il riepilogo
//    dell'import senza annullare — è il lotto dell'onda successiva;
//  · se l'automatismo sbaglia e si annulla in blocco, la famiglia avrebbe già
//    ricevuto «Pagamento registrato» — e **l'annullo resta muto**, per decisione
//    esplicita. Un avviso mandato non si disfa: è l'unica cosa, in tutta questa
//    fase, che nessun rollback può riprendersi.
//
// L'AUDIT invece si fa, riga per riga (`logScrittura`): è registro, non
// notifica — non esce dall'applicazione e non arriva a nessuna famiglia.
//
// ⚠️ Chi aggiungerà la notifica la metta nel lotto del riepilogo, non qui: qui
// non esiste il gesto umano che la giustifica. Il percorso MANUALE continua ad
// avvisare come sempre: la notifica sta nella rotta che chiama
// `confermaSuVoceSingola`, non dentro il modulo, e questa fase semplicemente
// non la fa.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il tempo massimo che questa fase può spendere, in millisecondi.
 *
 * La rotta dichiara `maxDuration = 300` (cinque minuti), e l'import ha GIÀ
 * speso la sua parte prima di arrivare qui: leggere 2,1 MB di BIFF8, la
 * finestra di dedup paginata, l'elenco degli aperti paginato, gli insert a
 * blocchi. Quello che resta è un avanzo, non un budget pieno.
 *
 * ⚠️ E un timeout QUI non costa «qualche abbinamento in meno»: costa la
 * RISPOSTA. Senza risposta il pannello non riceve `import_id`, e senza
 * `import_id` non esiste l'annullamento in blocco — cioè si perderebbe proprio
 * l'appiglio con cui si disfa ciò che questa fase ha appena deciso da sola.
 * Due minuti lasciano margine abbondante alla risposta anche nel caso peggiore
 * misurabile, ed è il verso giusto in cui sbagliare: fermarsi lascia righe
 * gialle, che una persona lavora; non rispondere lascia scritture che nessuno
 * ritrova.
 */
export const BUDGET_AUTO_MS = 120_000

/**
 * Quante scritture automatiche al massimo in un solo import.
 *
 * L'estratto ANNUALE porta 6.775 accrediti: senza tetto, il primo import di uno
 * storico intero potrebbe tentare migliaia di scritture in una richiesta sola —
 * e ognuna è una transazione contabile vera. Il tetto non è una protezione
 * contro l'errore (a quello pensano le guardie dei moduli): è il limite oltre
 * il quale una persona deve poter GUARDARE prima che la macchina continui.
 *
 * ⚠️ IL CONTO, RIFATTO — E IL NUMERO NON È CAMBIATO: è cambiata la MOTIVAZIONE,
 * perché quella scritta qui era aritmeticamente falsa. Diceva «cinquecento è più
 * del doppio dei movimenti che un estratto mensile porta»: 6.775 accrediti
 * all'anno fanno ~565 al mese, quindi 500 è 0,89 volte il mensile, non 2,2 volte.
 * Per essere «più del doppio» servirebbe un mensile ≤ 250, cioè ~3.000 accrediti
 * annui — la metà della cifra misurata tre righe più su, nello stesso commento.
 *
 * Perché 500 regge lo stesso: **il tetto conta le SCRITTURE, non i movimenti**.
 * Dei ~565 accrediti di un mese si scrive solo ciò che `valutaCertezza` dichiara
 * certo al centesimo, che ne è una frazione — quanta, su dati veri, NON è
 * misurato, e si misurerà al primo import vero leggendo
 * `auto_singole + auto_composite` dentro `auto_abbinamento_eseguito`. Finché quel
 * numero non c'è, il verso in cui si sbaglia è quello giusto: se la frazione
 * fosse più alta del previsto il tetto morde, e mordere lascia righe gialle che
 * una persona lavora.
 * Della frase di prima resta vera solo la seconda metà: 6.775 / 500 ≈ 13,6, cioè
 * un ordine di grandezza sotto l'annuale — ed è esattamente il caso che il tetto
 * esiste per fermare, il primo import di uno storico intero.
 *
 * Superato: ci si ferma, si dice quanti ne restano (nei log e nella risposta),
 * e le righe restano gialle — cioè il lavoro di ieri.
 */
export const MAX_AUTO_PER_IMPORT = 500

/** Un movimento appena scritto in registro, coi soli campi che servono qui. */
export interface MovimentoInserito {
  /** L'uuid che il database ha appena assegnato: senza, non c'è CAS possibile. */
  id: string
  importo: number
  causale: string | null
  controparte: string | null
  dataOperazione: string
  /**
   * Lo stato con cui la riga è NATA (`da_abbinare` o `suggerito`): è il valore
   * del compare-and-swap, e lo conosciamo esattamente perché l'abbiamo appena
   * scritto noi. Non si rilegge dal database: fra la scrittura e la rilettura
   * ci starebbe una finestra, e la rilettura non direbbe niente di più.
   */
  stato: string
}

/**
 * Una voce aperta come la legge l'import, coi campi che servono a DECIDERE.
 * È la forma che la rotta ha già in mano (`ApertoDaAbbinare`): qui si dichiara
 * il contratto, non lo schema.
 */
export interface VoceApertaPerAuto {
  id: string
  alunno_id?: string | null
  scuola_id: string | null
  importo: number | string
  importo_pagato?: number | string | null
  /** Assente sui DB non migrati: allora vale `null`, e `residuoEffettivo` lo tratta come 0. */
  sconto?: number | string | null
  codice_fiscale?: string | null
  descrizione?: string | null
  categoria_slug: string | null
  /** Stato dell'ALUNNO (iscritto/ritirato), non del pagamento. */
  alunno_stato: string | null
  alunno_anonimizzato_il: string | null
  /** `pagamenti.tipo`: `padre` è il contenitore delle rate, non una voce da incassare. */
  tipo?: string | null
}

/** Ciò che la fase ha fatto, per la risposta del `POST`. */
export interface EsitoFaseAuto {
  /** `false` = la fase non è partita affatto (una precondizione l'ha spenta). */
  attiva: boolean
  autoSingole: number
  autoComposite: number
  /**
   * I movimenti nuovi che NON sono stati abbinati dalla macchina: quelli
   * esaminati e rinunciati, quelli su cui la scrittura è fallita, e quelli mai
   * esaminati perché il budget o il tetto hanno fermato la fase.
   * `candidati = autoSingole + autoComposite + saltati`, sempre.
   */
  saltati: number
}

/** Il lavoro su una voce: il residuo si consuma in memoria mentre il file scorre. */
interface VoceInLavorazione {
  voce: VoceCertezza
  /** Slug della categoria: serve SOLO all'àncora (`retta` vince su tutto). */
  categoriaSlug: string | null
  descrizione: string
}

/**
 * La fase automatica di un import. Non lancia MAI: qualunque cosa vada storta
 * qui dentro lascia le righe come le ha scritte l'import, e l'import resta
 * valido.
 */
export async function abbinaImportAutomaticamente(
  supabase: SupabaseClient,
  args: {
    importId: string
    /** I movimenti APPENA scritti da questo import, e solo quelli. */
    movimenti: readonly MovimentoInserito[]
    aperte: readonly VoceApertaPerAuto[]
    /**
     * L'elenco delle voci aperte è stato TAGLIATO dal server. Se è vero la fase
     * non parte: vedi la precondizione qui sotto.
     */
    apertiTroncati: boolean
    /**
     * Le righe che l'insert ha scritto ma di cui NON è tornato l'uuid — quindi
     * non sono in `movimenti` e questa fase non le può nemmeno guardare (senza
     * id non c'è compare-and-swap possibile).
     *
     * 🔴 SI PORTANO DENTRO PERCHÉ IL RIEPILOGO NON MENTA. Senza questo numero
     * `candidati` conterebbe solo ciò che è arrivato fin qui, e nel caso
     * degenere — `.insert(…)` senza `.select(…)`, cioè `data: null` — la fase
     * scriverebbe il log di SUCCESSO con `candidati: 0, saltati: 0` mentre N
     * righe restano in coda: l'aggregato che esiste apposta per distinguere
     * «non c'era niente da abbinare» da «la fase non è partita» direbbe il
     * falso. Sono movimenti non abbinati come tutti gli altri, e `saltati` è
     * esattamente «quanti ne restano».
     */
    nonMappati?: number
    /** Chi ha premuto «Importa»: firma incassi e conferme. */
    attore: AppUser
    operazione: string
    /** L'orologio, iniettabile: il budget si MISURA, e un test non aspetta due minuti. */
    adesso?: () => number
  },
): Promise<EsitoFaseAuto> {
  const { importId, movimenti, aperte, apertiTroncati, attore, operazione } = args
  const adesso = args.adesso ?? (() => Date.now())
  const inizio = adesso()

  const nonMappati = Math.max(0, args.nonMappati ?? 0)
  /** Tutti i movimenti nuovi di questo import, anche quelli mai arrivati fin qui. */
  const candidati = movimenti.length + nonMappati
  let esaminati = 0
  let autoSingole = 0
  let autoComposite = 0
  /** Le scritture TENTATE: è su queste che morde `MAX_AUTO_PER_IMPORT`. */
  let scritture = 0
  /** Motivo → quante volte. Aggregato, per non scrivere 6.775 righe di log. */
  const rinunce = new Map<string, number>()
  const rinuncia = (motivo: string) => rinunce.set(motivo, (rinunce.get(motivo) ?? 0) + 1)

  /** La fase non è partita: si dice perché, e si esce senza contare niente. */
  const spenta = (tipo: string): EsitoFaseAuto => {
    // `warn` e non `info`: un automatismo spento che nessuno vede è la prima
    // metà di ogni guasto lungo di questo repository. E non `error`, perché su
    // un database non migrato — la CI — è lo stato ATTESO, e un canale rosso a
    // ogni giro di CI smette di essere guardato.
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'auto-non-disponibile',
      tipo,
      import_id: importId,
      // Quanti movimenti restano alla coda manuale per questo spegnimento: è il
      // numero che dice se la fase spenta è costata niente o è costata tutto.
      n: candidati,
    })
    return { attiva: false, autoSingole: 0, autoComposite: 0, saltati: candidati }
  }

  // ── LE PRECONDIZIONI CHE SPENGONO TUTTO ────────────────────────────────────
  //
  // Sono CINQUE, e stanno in ordine di COSTO. Prima le tre che si sanno già
  // senza chiedere niente a nessuno:
  //
  //   1. nessun movimento nuovo da guardare (`movimenti.length === 0`);
  //   2. l'elenco degli aperti è stato TRONCATO dal server (`aperti-troncati`);
  //   3. quell'elenco è CIECO sul ciclo dell'alunno (`ciclo-alunno-cieco`).
  //
  // Poi le due che costano una lettura a testa:
  //
  //   4. la marca `abbinato_auto_il` non è disponibile (`marca-assente`);
  //   5. il perimetro di sede non è affidabile (`sediReali`).
  //
  // Spendere due round-trip per poi scoprire che l'elenco era troncato sarebbe
  // lavoro buttato a ogni import di un database grande.
  //
  // ⚠️ LE USCITE QUI SOTTO SONO SETTE, E LE ULTIME DUE NON SONO PRECONDIZIONI IN
  // PIÙ: `attiva-non-letta` e `sedi-reali-assenti` sono il secondo e il terzo
  // ramo della QUINTA — la stessa chiamata a `sediReali`, che può finire in tre
  // modi (non si è letto `schools`; si è letta ma il filtro `attiva` è caduto;
  // si è letta tutto e non c'è nessun plesso reale e attivo). Stesso round-trip,
  // tre esiti; contarli a parte farebbe credere che ci siano letture in più da
  // pagare.
  //
  // Il numero qui sopra si RICONTA sull'elenco che segue, non si eredita: in
  // questo repository un conteggio scritto in testa a un elenco è la prima cosa
  // che smette di essere vera.

  if (movimenti.length === 0) {
    // Niente da guardare: o non c'era nessun movimento nuovo (tutti duplicati, o
    // file già importato) — e allora `candidati` è 0 — oppure gli uuid non sono
    // tornati affatto, e allora `candidati` vale `nonMappati` e quelle righe sono
    // SALTATE, non inesistenti. La riga di successo si scrive in tutt'e due i
    // casi: senza, «nessun log» non distinguerebbe «non c'era niente da abbinare»
    // da «la fase non è mai partita» — l'ambiguità che la regola 5 di AGENTS.md
    // esiste per chiudere. Scriverla con `candidati: 0` mentre N righe restano in
    // coda sarebbe peggio del silenzio: un successo che mente.
    logEvento('pagamento', 'info', {
      operazione,
      esito: 'auto_abbinamento_eseguito',
      import_id: importId,
      candidati,
      esaminati: 0,
      auto_singole: 0,
      auto_composite: 0,
      saltati: candidati,
      restanti: candidati,
      ms: adesso() - inizio,
    })
    return { attiva: true, autoSingole: 0, autoComposite: 0, saltati: candidati }
  }

  // 🔴 L'ELENCO DEGLI APERTI TRONCATO SPEGNE TUTTO, e non è prudenza generica:
  // la regola di questa fase è «una sola combinazione di voci quadra con
  // l'importo». Con l'elenco incompleto le combinazioni che mancano non si
  // contano, quindi «una sola» diventa FALSAMENTE CERTO — si incasserebbe sulla
  // voce sbagliata di un bambino vero, col gate verde. Il segnale esiste già
  // come DATO (`apertiTroncati`) proprio perché chi decide potesse spegnersi, e
  // non solo lasciare una riga in `app_log`.
  if (apertiTroncati) return spenta('aperti-troncati')

  // 🔴 LA CECITÀ SUL CICLO DELL'ALUNNO SPEGNE TUTTO, e questa è la precondizione
  // che mancava.
  //
  // Delle bandiere che fanno RINUNCIARE `valutaCertezza`, due vengono dallo
  // stesso gruppo di colonne dell'elenco aperti (`ciclo_alunno`: `stato` e
  // `anonimizzato_il` dell'alunno, che cadono INSIEME perché stanno nello stesso
  // gradino della scala `SACRIFICIO_APERTI`). Se quel gradino cade — o se l'embed
  // `alunni` torna in un'altra forma — `alunno_anonimizzato_il` arriva `null` per
  // OGNI voce, `alunnoAnonimizzato` è `false` ovunque, e la rinuncia
  // `alunno_anonimizzato` non scatta MAI: la fase incasserebbe da sola su un
  // fascicolo già passato per l'oblio GDPR, e a valle non c'è nessuna guardia che
  // la fermi — né `confermaSuVoceSingola` né `registraConciliazione` guardano
  // l'anonimizzazione.
  //
  // ⚠️ È il contrario di ciò che vale per gli altri gruppi, e va detto proprio
  // perché è l'eccezione: su `sede_pagamento` la cecità PRODUCE una rinuncia
  // (`sede_ignota`), su `sconto` la macchina tenta e viene respinta a valle
  // (409/422). Solo qui la cecità SPEGNE una rinuncia, cioè apre invece di
  // chiudere. Per questo non basta contarla in `qualitaAperti`: va fermata.
  //
  // Si guarda il DATO e non il gradino: così la precondizione vale anche il
  // giorno in cui a mancare non è la colonna ma la forma dell'embed, che è il
  // modo in cui questi campi sono già spariti una volta. Se davvero tutte le voci
  // aperte appartenessero ad alunni con `stato` NULL (la colonna ha DEFAULT
  // 'iscritto': è un caso che in produzione non si dà), la fase si spegnerebbe lo
  // stesso — ed è il verso giusto: su quei dati non sappiamo distinguere un
  // fascicolo vivo da uno cancellato.
  if (aperte.length > 0 && aperte.every((p) => p.alunno_stato === null)) {
    return spenta('ciclo-alunno-cieco')
  }

  // Senza la marca `abbinato_auto_il` non esiste l'annullamento in blocco, e un
  // automatismo che non si può disfare non è quello che è stato chiesto. La
  // funzione risponde `false` anche sul guasto (fail-closed) e logga da sé il
  // perché: qui si aggiunge il fatto che a spegnersi è la FASE, che è un'altra
  // notizia.
  if (!(await marcaAutomaticaDisponibile(supabase, operazione))) return spenta('marca-assente')

  // ── IL PERIMETRO DI SEDE — LA DEROGA, DICHIARATA ───────────────────────────
  //
  // L'estratto conto è UNO SOLO per le tre sedi (il dedup è globale apposta), e
  // la decisione del titolare è che l'automatismo lavori su TUTTE E TRE anche
  // quando chi importa ha diritti su una sola: altrimenti per due plessi su tre
  // l'abbinamento automatico semplicemente non esisterebbe.
  //
  // Quindi il perimetro che questa fase passa ai moduli NON è quello
  // dell'operatore (`resolveScuoleAttive`, che è quello del percorso manuale):
  // sono le sedi REALI e ATTIVE del deployment, lette da `sediReali`. Il fatto
  // che il perimetro sia un PARAMETRO dei due moduli è esattamente il punto:
  // rende la differenza fra i due percorsi DICHIARATA invece che accidentale.
  //
  // E se quella lettura fallisce la fase non parte: un perimetro indovinato
  // scriverebbe nel plesso sbagliato in silenzio.
  //
  // 🔴 «ATTIVE» È LA META CHE ERA SCRITTA QUI E NON ERA VERA, e adesso lo è.
  // Dentro `sediReali` solo la lettura di `schools` è fail-CLOSED; il flag
  // `attiva` (soft-delete) si legge da `scuole` ed e dichiaratamente
  // fail-OPEN: se quella `SELECT` fallisce — e `42703` su un DB non migrato e il
  // caso NORMALE — i plessi disattivati RESTANO dentro `reali` con `error` a
  // `null`. Per chi MOSTRA un elenco è la scelta giusta; per questa fase no:
  // qui «una sede in più» vuol dire una macchina che incassa in un plesso che
  // l'organizzazione ha cancellato, e `sedeFittizia` che scatta meno spesso.
  // Cioè la deroga di sede — che questa fase si prende apposta — si
  // allargherebbe DA SOLA, e nessuna riga lo direbbe.
  // Per questo `sediReali` adesso DICHIARA il degrado (`attivaDegradata`) e qui
  // si spegne: stessa ragione di `aperti-troncati` e `ciclo-alunno-cieco`, che
  // spengono perché un perimetro indovinato scrive nel plesso sbagliato in
  // silenzio. Il costo è zero round-trip in più: il dato viene dalla lettura
  // che si faceva già.
  const sedi = await sediReali(supabase, operazione)
  if (sedi.error) return spenta('sedi-non-lette')
  if (sedi.attivaDegradata) return spenta('attiva-non-letta')
  const perimetro = sedi.reali.map((s) => s.id)
  // Nessuna sede reale e attiva: ogni scrittura sarebbe rifiutata dal gate di
  // sede dei moduli, una per una. Fermarsi qui costa zero round-trip invece di
  // uno per movimento, e dice la verità: qui non c'è nessun plesso su cui
  // incassare. È il caso di un ambiente con le sole sedi di prova.
  if (perimetro.length === 0) return spenta('sedi-reali-assenti')

  // La deroga si LOGGA, per sede: senza queste righe «l'automatismo lavora su
  // tutte le sedi, anche quelle che l'operatore non gestisce» resterebbe una
  // frase in un commento. Sono tre righe per import, non tre per movimento.
  for (const s of sedi.reali) {
    logEvento('pagamento', 'info', {
      operazione,
      esito: 'auto-perimetro-deroga',
      import_id: importId,
      sede_id: s.id,
      n: perimetro.length,
    })
  }

  const perimetroSet = new Set(perimetro)

  // ── LE VOCI, NELLA FORMA CHE IL PREDICATO LEGGE ────────────────────────────
  //
  // ⚠️ NON SI FILTRA NIENTE. Togliere qui una voce che non si può incassare
  // (fuori perimetro, di un fascicolo anonimizzato, di un contenitore di rate)
  // avrebbe lo stesso effetto dell'elenco TRONCATO: una combinazione in meno da
  // contare, e «una sola quadra» che diventa falsamente certo. Le voci entrano
  // tutte, e sono le BANDIERE su ciascuna a far rinunciare `valutaCertezza`
  // sull'intero movimento.
  const lavorazione: VoceInLavorazione[] = aperte.map((p) => ({
    voce: {
      pagamentoId: p.id,
      alunnoId: p.alunno_id ?? null,
      scuolaId: p.scuola_id ?? null,
      // Il residuo EFFETTIVO (`importo − sconto − incassato`, clampato a zero),
      // mai quello del matcher (`importo − importo_pagato`): su una voce
      // scontata i due numeri divergono, e chi dice «certo» userebbe lo
      // sbagliato. Si CHIEDE a `residuoEffettivo` invece di rifare il conto: una
      // seconda aritmetica sullo stesso centesimo diverge al primo ritocco.
      // ⚠️ `stato` si passa VUOTO perché la forma condivisa lo pretende e
      // `residuoEffettivo` non lo legge affatto (lo legge `statoEffettivo`, che
      // qui non c'entra): scriverci uno stato che non abbiamo letto sarebbe
      // inventare un dato per far contento un tipo.
      residuo: round2(
        residuoEffettivo({ importo: p.importo, importo_pagato: p.importo_pagato, sconto: p.sconto, stato: '' }),
      ),
      cf: (p.codice_fiscale ?? '').toUpperCase() || null,
      alunnoAnonimizzato: p.alunno_anonimizzato_il != null,
      alunnoRitirato: p.alunno_stato != null && p.alunno_stato !== 'iscritto',
      // 🔴 QUI «FITTIZIA» VUOL DIRE «FUORI DAL PERIMETRO REALE E ATTIVO», ed è
      // un sovrainsieme voluto: ci cadono la sede di collaudo (che esiste in
      // produzione), una sede disattivata e una sede che `schools` non conosce.
      // In tutti e tre i casi la risposta giusta è la stessa — una macchina lì
      // non incassa — e il motivo che ne esce (`sede_fittizia`) è un enumerato
      // che si legge nell'aggregato delle rinunce. Il nome dice meno della
      // verità; il comportamento no, ed è il verso sicuro.
      sedeFittizia: p.scuola_id != null && !perimetroSet.has(p.scuola_id),
      contenitore: p.tipo === 'padre',
    },
    categoriaSlug: p.categoria_slug,
    descrizione: p.descrizione ?? '',
  }))
  const perId = new Map(lavorazione.map((l) => [l.voce.pagamentoId, l]))
  const voci = lavorazione.map((l) => l.voce)

  /**
   * IL RESIDUO SI CONSUMA IN MEMORIA, man mano.
   *
   * Due bonifici dello stesso file che agganciano la stessa voce devono vedere
   * il residuo AGGIORNATO: senza, il secondo direbbe «certo» su una voce già
   * saldata dal primo e il database risponderebbe 409 (o, peggio, un secondo
   * incasso su un residuo che il database ha già consumato).
   *
   * ⚠️ NON è una protezione — quella è la guardia di residuo dentro
   * `confermaSuVoceSingola`, che RILEGGE dal database ed è l'unica che conti
   * contro un'altra sessione. Questa è igiene: evita di andare a sbattere
   * contro una guardia che sappiamo già che dirà di no.
   */
  const consuma = (v: VoceIncassabile) => {
    const l = perId.get(v.pagamentoId)
    if (!l) return
    l.voce.residuo = round2(Math.max(0, l.voce.residuo - v.importo))
  }

  /** L'audit, riga per riga: è REGISTRO, non notifica. Vedi il riquadro. */
  const audit = async (movimentoId: string, scuolaId: string, valoreDopo: Record<string, unknown>) => {
    await logScrittura(supabase, {
      attore,
      entitaTipo: 'riconciliazione_movimenti',
      entitaId: movimentoId,
      azione: 'update',
      scuolaId,
      valoreDopo: { ...valoreDopo, automatico: true, import_id: importId },
    })
  }

  /**
   * La scrittura ha detto no dove il predicato aveva detto «certo».
   *
   * `error`, e non `warn`: è il campanello che dice se il predicato MENTE. Un
   * 409 isolato è due sessioni sulla stessa riga; un 409 sistematico è una
   * regola che promette certezze che il database non conferma, e senza questa
   * riga non ci sarebbe modo di distinguerli.
   */
  const scritturaFallita = (movimentoId: string, tipo: string, stato: number, codice: unknown) => {
    logEvento('pagamento', 'error', {
      operazione,
      esito: 'auto-scrittura-fallita',
      tipo,
      import_id: importId,
      movimento_id: movimentoId,
      stato,
      error_code: typeof codice === 'string' && codice !== '' ? codice : 'nessuno',
    })
    rinuncia('scrittura_fallita')
  }

  try {
    for (const mov of movimenti) {
      // ── IL TETTO E IL BUDGET ───────────────────────────────────────────────
      // Si controllano PRIMA di valutare: fermarsi dopo aver deciso e prima di
      // scrivere sarebbe lavoro buttato; fermarsi dopo aver scritto sarebbe un
      // tetto che non tiene.
      if (scritture >= MAX_AUTO_PER_IMPORT || adesso() - inizio >= BUDGET_AUTO_MS) {
        logEvento('pagamento', 'warn', {
          operazione,
          esito: 'auto-budget-esaurito',
          tipo: scritture >= MAX_AUTO_PER_IMPORT ? 'tetto-scritture' : 'tempo',
          import_id: importId,
          // Quanti NON sono stati nemmeno guardati: restano gialli o rossi, cioè
          // il comportamento di ieri, e una persona li lavora.
          n: candidati - esaminati,
          scritture,
          ms: adesso() - inizio,
        })
        break
      }
      esaminati++

      const verdetto = valutaCertezza(
        {
          importo: mov.importo,
          causale: mov.causale ?? '',
          controparte: mov.controparte ?? '',
          // Una riga APPENA importata non è mai stata legata a un pagamento: il
          // campo nasce NULL. Lo si passa esplicito invece di ometterlo perché
          // è la guardia «un movimento riaperto non si auto-riabbina», e chi
          // legge deve vedere che qui è stata considerata.
          pagamentoIdPrecedente: null,
        },
        voci,
      )

      if (verdetto.esito === 'auto-singola') {
        const v = verdetto.voci[0]
        scritture++
        const esito = await confermaSuVoceSingola(supabase, {
          movimento: {
            id: mov.id,
            importo: mov.importo,
            data_operazione: mov.dataOperazione,
            causale: mov.causale,
            stato: mov.stato,
            pagamento_id: null,
          },
          pagamentoId: v.pagamentoId,
          sediAmmesse: perimetro,
          attoreId: attore.id,
          operazione,
          // 🔴 La marca è stata chiesta PRIMA (precondizione `marca-assente`):
          // `confermaSuVoceSingola` non la controlla, e a incasso già scritto
          // sarebbe troppo tardi per deciderlo.
          automatico: true,
        })
        if (esito.ok) {
          autoSingole++
          consuma(v)
          await audit(mov.id, esito.ok.pagamento.scuolaId, {
            stato: 'confermato',
            pagamento_id: esito.ok.pagamentoId,
            incasso_id: esito.ok.incassoId,
            importo: mov.importo,
          })
        } else {
          scritturaFallita(mov.id, 'singola', esito.status, (esito.body as { codice?: unknown }).codice)
        }
        continue
      }

      if (verdetto.esito === 'auto-composita') {
        const fatto = await componiAutomaticamente(supabase, {
          mov,
          voci: verdetto.voci,
          perId,
          perimetro,
          attore,
          operazione,
          importId,
          rinuncia,
          scritturaFallita,
        })
        if (fatto.tentata) scritture++
        if (fatto.riuscita && fatto.sedeDocumento) {
          autoComposite++
          for (const v of verdetto.voci) consuma(v)
          await audit(mov.id, fatto.sedeDocumento, {
            stato: 'confermato',
            transazione_id: fatto.transazioneId,
            importo: mov.importo,
            voci: verdetto.voci.length,
          })
        }
        continue
      }

      // Giallo o rosso: nessuna scrittura, e il motivo entra nell'aggregato.
      for (const m of verdetto.motivi) rinuncia(m)
    }
  } catch (e) {
    // Un `catch` che non logga è un bug — e qui il livello è `error`: la fase è
    // caduta dove non è previsto che cada. L'import resta valido, le righe
    // restano come le ha scritte l'insert, e i conteggi dicono quello che si è
    // fatto FINO A QUI invece di azzerarsi.
    logEvento('pagamento', 'error', {
      operazione,
      esito: 'auto-fase-interrotta',
      import_id: importId,
      esaminati,
      auto_singole: autoSingole,
      auto_composite: autoComposite,
    }, e)
  }

  // ── LE RINUNCE, AGGREGATE: una riga per MOTIVO, col conteggio ──────────────
  // 6.775 righe di log sarebbero rumore, e il rumore non si guarda. Il motivo è
  // un enumerato che `redact` lascia in chiaro sotto la chiave `tipo`: «quante
  // volte l'ambiguità ci ha fermati» diventa una query invece di un'ipotesi.
  // L'ordine è alfabetico e non per conteggio: così due import diversi si
  // confrontano riga per riga.
  for (const motivo of [...rinunce.keys()].sort()) {
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'auto-rinuncia',
      tipo: motivo,
      import_id: importId,
      n: rinunce.get(motivo) ?? 0,
    })
  }

  const saltati = candidati - autoSingole - autoComposite

  // ── IL LOG DI SUCCESSO DELL'EVENTO CRITICO (regola 5 di AGENTS.md) ─────────
  // Con i soli errori, «nessun log» non distingue «nessun movimento era certo»
  // da «la fase non è mai partita». Conteggi e uuid soltanto: mai causali, mai
  // nomi, mai codici fiscali, mai importi.
  logEvento('pagamento', 'info', {
    operazione,
    esito: 'auto_abbinamento_eseguito',
    import_id: importId,
    candidati,
    esaminati,
    auto_singole: autoSingole,
    auto_composite: autoComposite,
    saltati,
    /** Mai guardati: il budget o il tetto hanno fermato la fase prima. */
    restanti: candidati - esaminati,
    ms: adesso() - inizio,
  })

  return { attiva: true, autoSingole, autoComposite, saltati }
}

// ─────────────────────────────────────────────────────────────────────────────
// LA COMPOSITA — dove l'automatismo deve scegliere due cose che sulla singola
// non si pongono: CHI PAGA e SU QUALE SEDE ESCE IL DOCUMENTO.
// ─────────────────────────────────────────────────────────────────────────────

interface EsitoComposita {
  /** La scrittura è stata TENTATA (conta per il tetto). */
  tentata: boolean
  riuscita: boolean
  transazioneId: string | null
  sedeDocumento: string | null
}

async function componiAutomaticamente(
  supabase: SupabaseClient,
  args: {
    mov: MovimentoInserito
    voci: readonly VoceIncassabile[]
    perId: ReadonlyMap<string, VoceInLavorazione>
    perimetro: string[]
    attore: AppUser
    operazione: string
    importId: string
    rinuncia: (motivo: string) => void
    scritturaFallita: (movimentoId: string, tipo: string, stato: number, codice: unknown) => void
  },
): Promise<EsitoComposita> {
  const { mov, voci, perId, perimetro, attore, operazione, importId, rinuncia, scritturaFallita } = args
  const niente = (): EsitoComposita => ({ tentata: false, riuscita: false, transazioneId: null, sedeDocumento: null })

  // ── IL PAGANTE, E IL FAIL-CLOSED CHE QUI È OBBLIGATORIO ────────────────────
  //
  // Su una composizione il pagante è STRUTTURALMENTE obbligatorio:
  // `pagamenti_transazioni.pagante_parent_id` è `NOT NULL`, e da quell'uuid
  // `src/lib/pagamenti/ricevute.ts` prende NOME e CODICE FISCALE
  // dell'intestatario del documento fiscale.
  //
  // 🔴 DOVE LA COMPOSIZIONE MANUALE FA FAIL-**OPEN** SU UN PAGANTE NON
  // VERIFICATO, L'AUTOMATISMO RIFIUTA. Quel fail-open esiste perché c'è una
  // persona che guarda il nome sulla fattura. **In automatico non c'è.**
  // Le tre porte per cui si rinuncia sono quelle in cui il manuale prosegue:
  // l'insieme dei paganti ammessi non letto per intero (`completo: false`),
  // l'insieme vuoto, e la scelta che cade fuori da quell'insieme.
  //
  // ⚠️ LA TERZA È OGGI IRRAGGIUNGIBILE, e si dichiara come gli altri rami morti
  // di questo file invece di lasciarla sembrare viva: `PagantiAmmessi.parentIds`
  // è la DERIVATA di `legami` (lo dice il suo stesso commento), e
  // `scegliPaganteComune(ammessi.legami, …)` sceglie sempre dentro `legami` —
  // quindi il pagante scelto sta sempre in `parentIds`. Il controllo resta perché
  // non costa niente ed è l'unico posto che se ne accorgerebbe il giorno in cui
  // il pagante venisse da un'altra sorgente (un'euristica sull'ordinante, un
  // campo del tracciato bancario): allora sarebbe l'unica rete fra quel nome e
  // l'intestatario di un documento fiscale.
  //
  // ⚠️ Sì, `registraConciliazione` rileggerà i legami per conto suo: è il SUO
  // gate, e non si salta passandogli un insieme già risolto da fuori — un gate
  // che si fida di ciò che gli porta il chiamante non è un gate. Il prezzo è un
  // round-trip su una manciata di composite per import; il guadagno sarebbe una
  // guardia che dipende da chi la chiama.
  const alunni = [...new Set(voci.map((v) => v.alunnoId).filter((a): a is string => !!a))]
  if (alunni.length === 0) {
    // Non si arriva mai: `valutaCertezza` emette `alunno_mancante` sul ramo a
    // più voci proprio perché la composizione deriva il pagante dall'alunno di
    // ogni riga. Resta dichiarato invece di essere una scommessa muta.
    rinunciaPagante(operazione, importId, mov.id, 'voci-senza-alunno', rinuncia)
    return niente()
  }

  const ammessi = await pagantiAmmessiPerAlunni(supabase, alunni, operazione)
  if (!ammessi.completo || ammessi.parentIds.size === 0) {
    rinunciaPagante(
      operazione,
      importId,
      mov.id,
      ammessi.completo ? 'nessun-legame-noto' : 'legami-non-letti',
      rinuncia,
    )
    return niente()
  }
  // `scegliPaganteComune` vuole il genitore legato a TUTTI i bambini del
  // bonifico: su due fratelli, un genitore di uno solo non intesta niente.
  const pagante = scegliPaganteComune(ammessi.legami, alunni)
  // `!ammessi.parentIds.has(pagante)`: vedi il riquadro — oggi non scatta mai, e
  // resta come rete per una sorgente futura del pagante.
  if (!pagante || !ammessi.parentIds.has(pagante)) {
    rinunciaPagante(operazione, importId, mov.id, pagante ? 'fuori-dai-candidati' : 'nessun-pagante-comune', rinuncia)
    return niente()
  }

  // ── LA SEDE DEL DOCUMENTO: UNA REGOLA DETERMINISTICA ───────────────────────
  //
  // Sul percorso manuale la sede del documento la SCEGLIE l'operatore
  // (decisione n. 15 del titolare: un bonifico che paga figli di plessi diversi
  // produce UN documento solo, intestato a una sede sola). In automatico non la
  // sceglie nessuno, quindi serve una regola che dia sempre lo stesso esito
  // sugli stessi dati: **è la sede della voce ÀNCORA**, quella che `proponiAncora`
  // indica — la voce con categoria `retta`, o in mancanza la maggiore.
  //
  // È la scelta giusta perché l'àncora è già la riga da cui la fattura prende
  // intestatario, causale e competenza: far uscire il documento da una sede e
  // ancorarlo a una voce di un'altra sarebbe un documento che contraddice sé
  // stesso.
  //
  // ⚠️ L'ÀNCORA SI MANDA ESPLICITA, non si lascia ricalcolare a
  // `registraConciliazione`. Il risultato sarebbe lo stesso — è la stessa
  // funzione sugli stessi dati — ma sarebbe lo stesso PER COINCIDENZA: quel
  // modulo ricostruisce le righe rileggendole dal database, e il giorno in cui
  // una delle due letture portasse una categoria diversa la sede dichiarata qui
  // e l'àncora scritta là parlerebbero di due voci diverse. Mandandola, le due
  // sono la STESSA decisione per costruzione.
  const righe: RigaComposizione[] = voci.map((v) => ({
    specie: 'esistente',
    pagamentoId: v.pagamentoId,
    alunnoId: v.alunnoId,
    scuolaId: v.scuolaId,
    categoriaSlug: perId.get(v.pagamentoId)?.categoriaSlug ?? null,
    descrizione: perId.get(v.pagamentoId)?.descrizione ?? '',
    // La combinazione quadra ESATTAMENTE al centesimo: su ogni voce si incassa
    // tutto il residuo, quindi residuo e importo coincidono per costruzione.
    residuo: v.importo,
    importo: v.importo,
  }))
  const ancora = proponiAncora(righe)
  const sedeDocumento = ancora ? righe[ancora.indice].scuolaId : null
  if (!ancora || !sedeDocumento || !perimetro.includes(sedeDocumento)) {
    // Invariante rotta, non errore dell'operatrice: `proponiAncora` torna `null`
    // solo su zero righe (e qui ne abbiamo almeno due), e `valutaCertezza` non
    // lascia passare una voce senza sede (`sede_ignota`) o fuori perimetro
    // (`sede_fittizia`). Il livello lo dice.
    logEvento('pagamento', 'error', {
      operazione,
      esito: 'auto-sede-documento-non-determinata',
      tipo: 'invariante-motore',
      import_id: importId,
      movimento_id: mov.id,
      n: righe.length,
    })
    rinuncia('sede_documento_non_determinata')
    return niente()
  }

  const esito = await registraConciliazione(supabase, {
    movimentoId: mov.id,
    composizione: {
      scuola_id: sedeDocumento,
      pagante_parent_id: pagante,
      riferimento: null,
      // Niente `note`: la causale del bonifico porta i nomi delle famiglie, e
      // una nota scritta dalla macchina non direbbe niente che il movimento
      // legato non dica già.
      note: null,
      voci: voci.map((v) => ({ pagamento_id: v.pagamentoId, importo: v.importo })),
      // 🔴 L'AUTOMATISMO NON CREA MAI VOCI NUOVE, e non accredita ticket: crea
      // una voce a registro è un atto che nessuno ha chiesto alla macchina di
      // fare, e un ticket è un anticipo che va deciso. Gli elenchi si mandano
      // `[]` espliciti (mai `null`: la RPC legge con un `COALESCE` che sul jsonb
      // `null` non scatta). L'eccedenza è zero per costruzione — la quadratura
      // di `valutaCertezza` è esatta al centesimo — e `registraConciliazione`
      // manda sempre `eccedenza_a_credito: 0`.
      voci_nuove: [],
      voci_ticket: [],
      ancora: { specie: 'esistente', indice: ancora.indice },
    },
    sediAmmesse: perimetro,
    attoreId: attore.id,
    operazione,
    automatico: true,
  })

  if (!esito.ok) {
    scritturaFallita(mov.id, 'composita', esito.status, (esito.body as { codice?: unknown }).codice)
    return { tentata: true, riuscita: false, transazioneId: null, sedeDocumento }
  }

  // ⚠️ `movimentoConfermato: false` = la transazione contabile c'è, ma la riga
  // bancaria NON è stata legata (RPC vecchia senza compare-and-swap). Il denaro
  // è scritto, quindi la voce va consumata lo stesso e l'abbinamento si conta;
  // il fatto che la riga resti in coda lo dichiara già `registraConciliazione`
  // con la sua riga `error` `movimento-non-legato`, e ripeterlo qui sarebbe la
  // seconda copia dello stesso allarme.
  //
  // LA SEDE, invece, non si ri-logga qui: `conciliazione_composita_registrata`
  // esce da quel modulo con `sede_id` e `automatico: true`, cioè dice già quale
  // plesso ha intestato il documento e chi l'ha deciso. Una riga per ogni
  // composita riuscita in più sarebbe un log per abbinamento, che è proprio ciò
  // che l'aggregato esiste per evitare.
  return {
    tentata: true,
    riuscita: true,
    transazioneId: esito.ok.transazioneId,
    sedeDocumento,
  }
}

/** La rinuncia sul pagante: un `warn` col TIPO, più il motivo nell'aggregato. */
function rinunciaPagante(
  operazione: string,
  importId: string,
  movimentoId: string,
  tipo: string,
  rinuncia: (motivo: string) => void,
): void {
  // Nel log NESSUN uuid di genitore: identifica una persona. Il movimento sì —
  // è una riga bancaria, ed è l'unico modo di ritrovare il caso.
  logEvento('pagamento', 'warn', {
    operazione,
    esito: 'auto-pagante-non-determinato',
    tipo,
    import_id: importId,
    movimento_id: movimentoId,
  })
  rinuncia('pagante_non_determinato')
}
