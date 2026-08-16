import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — un elenco di `alunni` letto PER SEDE INTERA deve dire di che stato.
 *
 * ─── PERCHÉ ESISTE, e perché non basta averlo corretto tre volte ─────────────
 *
 * Dal 2026-08-12 un alunno si ARCHIVIA invece di cancellarlo (migrazione
 * `20260812194517`): l'anagrafica resta intatta — nome, cognome e codice fiscale
 * non si toccano, così registri e pagamenti restano leggibili per dieci anni — e
 * il bambino esce dagli elenchi operativi.
 *
 * La leva che lo fa uscire NON è lo stato: è lo SGANCIAMENTO DALLA CLASSE
 * (`section_id` e `classe_sezione` a NULL). È stata una misura a deciderlo: le
 * letture di `alunni` sono quasi duecento e i filtri di stato scritti a mano una
 * dozzina — contare sullo stato avrebbe lasciato cieca l'app in un centinaio di
 * punti, mentre un UPDATE solo copre tutte le query per sezione, che sono la
 * maggioranza.
 *
 * ⚠️ I NUMERI DI QUESTA TESTATA NON SI SCRIVONO PIÙ A MANO, e vale la pena dire
 * perché. Il 2026-08-12 lo stesso rapporto è stato scritto tre volte nello stesso
 * lavoro con tre valori diversi: «182 volte in 117 file» qui, «181 volte in 117
 * file» nella migrazione `20260812194517`, «dodici filtri operativi» in due
 * commenti di route mentre i filtri con la stringa a mano erano **undici**.
 * Nessuno dei tre era una bugia: erano tre `grep` leggermente diversi, invecchiati
 * in giorni. In un repo che ha fatto della misura la sua regola, tre cifre per la
 * stessa misura sono un difetto di metodo. Il rimedio non è correggerle — sarebbe
 * di nuovo vero per una settimana — ma **calcolarle**: il test «il rapporto che ha
 * deciso il piano è ancora vero» le rimisura a ogni esecuzione e stampa i valori
 * del giorno nel messaggio di fallimento. La migrazione resta com'è, e apposta:
 * un file già applicato al database di produzione è il verbale di ciò che è stato
 * eseguito, non un documento da ritoccare.
 *
 * Restano fuori le query che leggono `alunni` PER SEDE INTERA: la classe non la
 * nominano proprio, quindi lo sganciamento non le tocca. Sono queste che, senza
 * un filtro di stato, continuano a mostrare un bambino archiviato — in rubrica,
 * fra i destinatari di un avviso di plesso, nell'elenco dei taggabili.
 *
 * ⚠️ E ORA LA RAGIONE DEL LOCK, che è diversa dalla ragione della correzione.
 * Le query cieche trovate il 2026-08-12 sono state corrette una per una. Il
 * problema è che **il difetto non è visibile finché non esiste un archiviato**:
 * al 2026-08-12 in produzione gli alunni sono 33 e sono tutti `iscritto`, quindi
 * una query cieca si comporta esattamente come una corretta. Nessun test
 * funzionale la vede, nessun collaudo la trova, nessuna pagina si rompe. La
 * quarta query di questa famiglia nascerà fra tre settimane, sarà cieca, e se ne
 * accorgerà una famiglia — non un gate.
 *
 * Da qui la forma: non un test che prova un comportamento, ma un lock che vieta
 * una FORMA di codice. Chi ha una ragione per leggere anche i non iscritti la
 * scrive in `AMMESSE`. Chi non ce l'ha, aggiunge il filtro.
 *
 * ─── LA REGOLA, per esteso ───────────────────────────────────────────────────
 *
 * Una lettura d'ELENCO da `alunni` che porta un filtro di SEDE
 * (`.in('scuola_id', …)` / `.eq('scuola_id', …)`) e NON porta un filtro per
 * identità (`.in('id', …)` / `.eq('id', …)`) deve portare un filtro di STATO —
 * oppure stare in `AMMESSE` con la ragione scritta per esteso.
 *
 * L'unica esenzione per FORMA è quella **per identità**, e non è generosità: le
 * query per id ereditano il filtro da MONTE. Sono il secondo giro di una lettura
 * in due tempi («prendi gli alunni della sede, poi i loro legami»): se il primo
 * giro è cieco, è LUI a diventare rosso, e la catena regge. Un lock che
 * pretendesse il filtro anche qui chiederebbe di riscrivere una cinquantina di
 * query corrette, e il primo che lo zittisse con un'allowlist infinita avrebbe
 * ragione lui.
 *
 * ─── 🔻 L'ESENZIONE «PER SEZIONE» È STATA TOLTA IL 2026-08-13 ────────────────
 *
 * Fino a quel giorno una seconda esenzione per forma copriva le query che
 * nominano `section_id`/`classe_sezione`, con questa motivazione: «già coperte
 * dallo sganciamento: un archiviato non ha più né `section_id` né
 * `classe_sezione`, quindi non torna comunque».
 *
 * **La frase era falsa, e a smentirla era un altro file scritto lo stesso
 * giorno**: `src/lib/notifiche/destinatari.ts` spiega che `alunni.stato` si
 * porta a `'ritirato'` anche dalla TENDINA della scheda alunno, «che la classe
 * non la tocca: per quella strada il bambino resta agganciato alla sezione».
 * Verificato nel codice, non dedotto: `src/app/api/admin/students/route.ts` ha
 * `stato` fra gli `allowedFields` del PATCH e quell'UPDATE non azzera né
 * `section_id` né `classe_sezione`; solo `src/lib/alunni/archiviazione.ts` e la
 * rotta `archivia` sganciano. Le due strade esistono entrambe **oggi**.
 *
 * Il danno non era teorico: `genitoriDiGrado` (`src/lib/news/notifiche.ts`) —
 * terzo ramo dello stesso dispatcher di cui gli altri due erano stati corretti —
 * mandava la News di grado alla famiglia di un ritirato, e questo lock non
 * poteva vederlo perché quella query filtra `section_id` ed era esente per
 * costruzione. Un'esenzione che nasconde il difetto che il lock esiste per
 * trovare non è un presidio: è un buco dichiarato come garanzia.
 *
 * Quindi le letture per sezione entrano nella scansione come tutte le altre. Le
 * sei che restano scoperte sono in `AMMESSE`, ognuna con la sua ragione: sono
 * decisioni scritte da una persona, non un ramo di regex. E la settima, quando
 * qualcuno la scriverà, sarà rossa.
 *
 * ⚠️ IL FILTRO DEVE ESSERE INCONDIZIONATO. `if (stato) q = q.eq('stato', stato)`
 * NON conta, ed è una distinzione misurata, non teorica: è la forma esatta di
 * `admin/students:GET`, dove il filtro esiste ma si applica solo se il client lo
 * chiede — cioè la risposta PREDEFINITA è la sede intera, archiviati compresi.
 * Per quella route va bene (è l'anagrafica, e sta in `AMMESSE` per questo); il
 * punto è che la decisione la prenda una persona invece di un `if`. Si
 * riconosce dalla profondità di graffe: una continuazione più annidata del
 * `.from(…)`, o preceduta da un `if`/`?`/`&&` sulla sua riga, è condizionale.
 *
 * ─── CHE COSA QUESTO LOCK NON GUARDA ─────────────────────────────────────────
 *  · le SCRITTURE (`insert`/`update`/`delete`): archiviare è un UPDATE, e un
 *    UPDATE che filtrasse per stato non potrebbe riattivare nessuno;
 *  · le letture di UNA riga (`.single()`/`.maybeSingle()`): sono per id, e la
 *    scheda di un archiviato si deve poter aprire — è il punto del modello;
 *  · l'isolamento fra SEDI, che è di `isolamento-sede-coverage.test.ts`: qui si
 *    dà per scontato che il filtro di sede ci sia, e lo si usa come indizio che
 *    la query è un elenco di plesso.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Le forme che il lock riconosce
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = path.join(process.cwd(), 'src')

/** L'inizio di una query PostgREST sull'anagrafica alunni. */
const DA_ALUNNI = /\.from\(\s*['"]alunni['"]\s*\)/g

/**
 * Il filtro di sede, nelle forme in uso nel repo — la stessa espressione di
 * `isolamento-sede-coverage.test.ts`, e per la stessa ragione: colonna diretta,
 * colonna di una tabella incorporata, sintassi PostgREST dentro `.or(…)`,
 * `.match({ scuola_id })`.
 */
const FILTRO_SEDE =
  /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`](?:[A-Za-z_]\w*\.)?scuola_id['"`]|['"`.]scuola_id\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\bscuola_id\b/

/**
 * La query parla di una SEZIONE. Non esenta più da niente (vedi la testata): resta
 * perché DESCRIVE la lettura, e il test «le esenzioni per sezione sono quelle
 * dichiarate» la usa per distinguere le due famiglie dentro `AMMESSE`.
 */
const PER_SEZIONE =
  /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`](?:[A-Za-z_]\w*\.)?(?:section_id|classe_sezione)['"`]|['"`.](?:section_id|classe_sezione)\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\b(?:section_id|classe_sezione)\b/

/** La query è agganciata a identità già scelte a monte. */
const PER_ID = /\.(?:eq|in|filter)\s*\(\s*['"`](?:[A-Za-z_]\w*\.)?id['"`]|\.match\s*\(\s*\{[^}]*\bid\b/

/**
 * Il filtro che questo lock pretende — SOLO IN FORMA POSITIVA (`eq`, `in`).
 *
 * ⚠️ Fino al 2026-08-13 la regex accettava anche `neq|not|filter`, cioè benediva
 * la NEGAZIONE: `.neq('stato', 'ritirato')` soddisfaceva il lock. Ed è
 * esattamente la forma che `src/lib/alunni/stato.ts` documenta come **il difetto
 * appena riparato in produzione** — `admin/gdpr/candidates` sceglieva i candidati
 * all'oblio con `.neq('stato','iscritto')`, e un bambino soltanto `sospeso`
 * finiva fra i candidati a un'anonimizzazione irreversibile. «Un elenco che si
 * allarga da solo… è un incidente che aspetta una tendina»: un lock che verifica
 * la PRESENZA di un filtro e non il suo VERSO avrebbe lasciato rinascere lo
 * stesso difetto col gate verde, il giorno che qualcuno aggiunge uno stato
 * `trasferito`.
 *
 * `filter('stato', …)` esce insieme alle negazioni: il suo operatore è un
 * argomento, quindi `filter('stato','neq','ritirato')` sarebbe indistinguibile da
 * `filter('stato','eq','iscritto')` senza leggere l'argomento successivo. Oggi in
 * `src/` non lo usa nessuno su questa colonna (misurato); chi ne avesse bisogno
 * scriva `eq`/`in`, che è più chiaro comunque.
 */
const CON_STATO = /\.(?:eq|in)\s*\(\s*['"`](?:[A-Za-z_]\w*\.)?stato['"`]|['"`.]stato\.(?:eq|in)\./

const SCRITTURA = /\.(?:insert|upsert|update|delete)\s*\(/
const UNA_RIGA = /\.(?:maybeSingle|single)\s*\(/

/** `withRoute('gruppo/route:METODO'` — il nome che il repo dà a un handler. */
const WITH_ROUTE = /\bwithRoute\s*\(\s*['"]([^'"]+)['"]/g

/** Le dichiarazioni di primo livello, per nominare il contenitore in `src/lib`. */
const DICHIARAZIONE_TOP =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/gm

/** Profondità di graffe (sul testo `struttura`) all'indice `i`. */
function profondita(strut: string, i: number): number {
  let d = 0
  for (let k = 0; k < i && k < strut.length; k++) {
    if (strut[k] === '{') d++
    else if (strut[k] === '}') d--
  }
  return d
}

/** C'è una guardia (`if`, ternario, `&&`) davanti a `i` sulla sua stessa riga? */
function guardiaInRiga(src: string, i: number): boolean {
  const inizioRiga = src.lastIndexOf('\n', Math.max(0, i - 1)) + 1
  return /\bif\s*\(|\?|&&|\|\|/.test(src.slice(inizioRiga, i))
}

/**
 * Chi contiene la query: l'handler (`admin/chat/contacts:GET`) se il file è una
 * route, altrimenti la funzione di primo livello (`genitoriDiScuola`).
 *
 * È la CHIAVE dell'allowlist, ed è scelta apposta perché non contenga un numero
 * di riga: una voce che scade quando qualcuno aggiunge un `import` più su non è
 * una decisione, è un dispetto. E non è il FILE: un elenco nuovo scritto accanto
 * a uno esentato non deve ereditare l'esenzione — è il difetto d'impianto che
 * `isolamento-sede-coverage` ha già pagato con un'allowlist per prefisso.
 */
export function contenitoreDi(senzaCommenti: string, struttura: string, i: number): string {
  WITH_ROUTE.lastIndex = 0
  let handler: string | null = null
  for (const m of senzaCommenti.matchAll(WITH_ROUTE)) {
    if (m.index > i) break
    const aperta = struttura.indexOf('(', m.index)
    if (aperta >= 0 && fineParentesi(struttura, aperta) > i) handler = m[1]
  }
  if (handler) return handler

  DICHIARAZIONE_TOP.lastIndex = 0
  let nome = '<modulo>'
  for (const m of struttura.matchAll(DICHIARAZIONE_TOP)) {
    if (m.index > i) break
    nome = m[1] ?? m[2] ?? nome
  }
  return nome
}

export interface Lettura {
  riga: number
  /** `<percorso>::<contenitore>` — la chiave dell'allowlist. */
  chiave: string
  scrittura: boolean
  singola: boolean
  perSede: boolean
  perSezione: boolean
  perId: boolean
  conStato: boolean
}

/**
 * Le letture di `alunni` di un sorgente, ciascuna con tutte le sue
 * continuazioni.
 *
 * «Una query» è la catena che parte da `.from('alunni')` PIÙ le riassegnazioni
 * sulla stessa variabile (`let q = supabase.from('alunni')…` seguito da
 * `q = q.eq(…)`): PostgREST le combina in AND, quindi sono la stessa query. È la
 * forma con cui mezzo repo costruisce i filtri facoltativi, e senza questo il
 * lock leggerebbe metà delle query. Le continuazioni CONDIZIONALI però contano
 * solo per capire che cosa la query PUÒ filtrare, non che cosa filtra sempre:
 * per i tre criteri che esentano, e per lo stato, si guarda la parte
 * incondizionata.
 */
export function lettureAlunni(src: string, percorso = '<test>'): Lettura[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const out: Lettura[] = []
  DA_ALUNNI.lastIndex = 0
  for (const m of senzaCommenti.matchAll(DA_ALUNNI)) {
    const inizio = m.index
    const tratti = [{ a: inizio, b: fineCatena(struttura, inizio) }]

    // A quale variabile è assegnata la query? Serve per riattaccarle le
    // continuazioni.
    const prima = senzaCommenti.slice(Math.max(0, inizio - 200), inizio)
    const senzaRicevitore = prima.replace(/(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/, '')
    const variabile =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      null

    let usiSuccessivi = ''
    if (variabile) {
      const riassegna = new RegExp(`\\b${variabile}\\s*=`, 'g')
      riassegna.lastIndex = tratti[0].b
      for (let r = riassegna.exec(senzaCommenti); r; r = riassegna.exec(senzaCommenti)) {
        const dopo = senzaCommenti.slice(r.index + r[0].length)
        const cont = new RegExp(`^\\s*(?:await\\s+)?${variabile}\\s*\\.`).exec(dopo)
        if (!cont) {
          // La variabile viene RICOSTRUITA da un altro `.from(…)`: da lì in poi
          // le continuazioni sono di un'altra query. Non si esce, perché a
          // runtime i filtri in coda si applicano all'oggetto vivo qualunque sia
          // il ramo preso.
          if (!/^\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*\.\s*from\s*\(/.test(dopo)) break
          continue
        }
        const punto = r.index + r[0].length + cont[0].length - 1
        tratti.push({ a: punto, b: fineCatena(struttura, punto) })
      }
      // `return q.maybeSingle()` non aggiunge filtri, ma dice che la lettura è di
      // UNA riga: senza guardarlo ogni `.maybeSingle()` scritto in coda a una
      // variabile verrebbe scambiato per un elenco.
      const usi = new RegExp(`\\b${variabile}\\s*\\.\\s*(?:maybeSingle|single)\\s*\\(`, 'g')
      usiSuccessivi = (senzaCommenti.slice(tratti[0].b).match(usi) ?? []).join(' ')
    }

    const dBase = profondita(struttura, inizio)
    const testo = tratti.map((t) => senzaCommenti.slice(t.a, t.b)).join('\n')
    const incondizionato = tratti
      .filter(
        (t, k) => k === 0 || (profondita(struttura, t.a) <= dBase && !guardiaInRiga(senzaCommenti, t.a)),
      )
      .map((t) => senzaCommenti.slice(t.a, t.b))
      .join('\n')

    out.push({
      riga: riga(src, inizio),
      chiave: `${percorso}::${contenitoreDi(senzaCommenti, struttura, inizio)}`,
      scrittura: SCRITTURA.test(testo),
      singola: UNA_RIGA.test(testo) || UNA_RIGA.test(usiSuccessivi),
      // La SEDE vale anche se arriva da una continuazione condizionale: dice che
      // la query è un elenco di plesso, e un filtro facoltativo in più non la
      // rende meno tale.
      perSede: FILTRO_SEDE.test(testo),
      perSezione: PER_SEZIONE.test(incondizionato),
      perId: PER_ID.test(incondizionato),
      conStato: CON_STATO.test(incondizionato),
    })
  }
  return out
}

/**
 * Gli elenchi di sede che non dichiarano lo stato, in un sorgente.
 *
 * ⚠️ `perSezione` NON compare più fra i filtri (2026-08-13): era l'esenzione per
 * forma che nascondeva `genitoriDiGrado`. Vedi la testata.
 */
export function elenchiScoperti(src: string, percorso = '<test>'): Lettura[] {
  return lettureAlunni(src, percorso).filter(
    (u) => !u.scrittura && !u.singola && u.perSede && !u.perId && !u.conStato,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// L'ALLOWLIST — a MATCH ESATTO, `<percorso>::<contenitore>`
//
// Ogni riga è una decisione, non un'eccezione di comodo: significa «questo
// elenco mostra anche i bambini che non frequentano più, e va bene così».
// Chi ne aggiunge una deve poterla difendere davanti a un genitore.
//
// ⚠️ OGNI VOCE DICE ANCHE **QUANTE** LETTURE COPRE, e non è pedanteria
// (2026-08-13). La chiave è `<percorso>::<contenitore>` e non il FILE — scelta
// giusta, spiegata alle righe della funzione `contenitoreDi` — ma restava un
// residuo non dichiarato: una query CIECA NUOVA scritta dentro un contenitore
// già esente ereditava l'esenzione **in silenzio**. Non era teorico:
// `admin/gdpr/candidates:GET` contiene già due letture di `alunni` sotto
// un'unica chiave, quindi una terza sarebbe nata esentata senza che nessuno
// decidesse. Con `scoperte` dichiarato, la terza fa fallire il conteggio e la
// decisione torna a una persona.
// ─────────────────────────────────────────────────────────────────────────────
interface Esenzione {
  /** Quante letture scoperte copre questa chiave. Una in più ⇒ rosso. */
  scoperte: number
  /** Perché quell'elenco mostra anche chi non frequenta più. */
  ragione: string
}

const AMMESSE: Record<string, Esenzione> = {
  // ── ANAGRAFICA: la scheda di un archiviato deve restare raggiungibile ───────
  // È il punto del modello a due tempi. L'archiviazione NON anonimizza: nome,
  // cognome e codice fiscale restano intatti proprio perché registri e pagamenti
  // devono restare leggibili per dieci anni. Se l'anagrafica smettesse di
  // elencarli, quei dieci anni sarebbero conservati e irraggiungibili — cioè il
  // peggio dei due mondi.
  // Qui il filtro di stato ESISTE ed è la tendina dell'interfaccia
  // (`?stato=ritirato` è come si legge l'elenco dei non più iscritti): non conta
  // come presidio proprio perché è facoltativo, ed è giusto che sia facoltativo.
  //
  // ⚠️ MA LA ROTTA NON HA UN SOLO SCOPO, e fino al 2026-08-13 questa riga era
  // scritta come se ce l'avesse. Misurato sui chiamanti (`grep` su
  // `/api/admin/students?` in `src/`): **undici** fetch, non uno. Tre passavano
  // già `stato=iscritto` (`PaymentsDashboard`, `GeneratoreCategoria`,
  // `FiscalePanel`), uno passa `stato=ritirato` (la linguetta «Non più
  // iscritti»), e **cinque erano elenchi OPERATIVI che non passavano niente** —
  // fra cui due schermate mensa in cui la segreteria seleziona un bambino e gli
  // inserisce un ticket o gli vende un pacchetto. Un'esenzione che vale per
  // l'anagrafica benediceva in silenzio anche quelli, e «tuo figlio archiviato è
  // ancora prenotabile a mensa» davanti a un genitore non si difende.
  // I cinque ora dichiarano `stato=iscritto`; a impedire che il sesto se ne
  // dimentichi c'è il lock «i chiamanti dell'anagrafica dichiarano lo stato», in
  // fondo a questo file.
  'src/app/api/admin/students/route.ts::admin/students:GET': {
    scoperte: 1,
    ragione:
      "anagrafica: l'elenco completo della sede è il suo scopo, e lo stato è una tendina — `?stato=ritirato` È la vista «non più iscritti». Gli undici chiamanti dichiarano il loro (lock a fondo file)",
  },

  // ── ARCHIVIO DOCUMENTI: dieci anni di conservazione, e la ragione è la stessa
  // dell'anagrafica. Il filtro di stato ESISTE ed è il default: si vedono gli
  // iscritti, e solo la segreteria — non l'insegnante — può chiedere
  // `includiNonIscritti=1`. Non conta come presidio perché è facoltativo, ed è
  // giusto che sia facoltativo: il fascicolo di un bambino ritirato non si
  // cancella con lui, e cercare il suo nulla osta o la sua ultima ricevuta è
  // esattamente ciò per cui quei documenti si conservano.
  //
  // Non è la trappola della mensa citata qui sopra: da questa schermata non si
  // prenota, non si vende e non si inserisce niente. Si legge, e ogni lettura di
  // un documento sanitario è registrata in `fascicolo_accessi_audit`.
  'src/app/api/documenti-firmati/route.ts::documenti-firmati:GET': {
    scoperte: 1,
    ragione:
      "archivio documenti: gli iscritti sono il default, `includiNonIscritti=1` è riservato alla segreteria e serve perché i documenti si conservano dieci anni — un fascicolo irraggiungibile è il peggio dei due mondi",
  },

  'src/app/api/admin/search/route.ts::admin/search:GET': {
    scoperte: 1,
    ragione:
      'ricerca globale: si cerca un ex alunno per aprire i suoi registri o i suoi pagamenti, ed è il caso in cui serve di più — chi cerca un nome sa già chi sta cercando',
  },

  // La sede del genitore si deriva dai FIGLI (`parents` non ha, e non deve avere,
  // una colonna di sede). Filtrare per stato qui toglierebbe dall'anagrafica
  // adulti i genitori dei soli archiviati — persone con pagamenti aperti, fatture
  // da emettere e un account attivo. Un genitore non si archivia insieme al
  // figlio, e questa lista non è un elenco operativo: è un'anagrafica.
  'src/app/api/admin/parents/route.ts::admin/parents:GET': {
    scoperte: 1,
    ragione:
      'anagrafica adulti: la sede del genitore si deduce dai figli, e un genitore con un solo figlio archiviato resta un contribuente con pagamenti aperti',
  },

  // Il pannello che misura la completezza dei codici fiscali. Un archiviato ha
  // ancora fatture da emettere (conservazione decennale, e Aruba il codice
  // fiscale lo pretende): nasconderlo qui significherebbe scoprire il codice
  // mancante il giorno dell'emissione, cioè troppo tardi. ⚠️ Lo `stato` che
  // questa route filtra è quello del CODICE (`incoerente`/`da-compilare`), non
  // quello dell'iscrizione: due parole uguali per due cose diverse.
  'src/app/api/admin/anagrafiche/codici-fiscali/route.ts::admin/anagrafiche/codici-fiscali:GET': {
    scoperte: 1,
    ragione:
      'qualità del dato fiscale: un archiviato ha ancora fatture da emettere, e un codice fiscale mancante va visto PRIMA dell’emissione, non il giorno dell’invio',
  },

  // ── SONDA: la query serve proprio a contare gli stati ──────────────────────
  // Legge la sola colonna `stato` (nessuna PII) delle righe non ancora
  // anonimizzate e conta quelle con uno stato fuori dall'allowlist di
  // `@/lib/alunni/stato`. Filtrare per stato la renderebbe una sonda che misura
  // ciò che ha già escluso: verde a vuoto, per sempre.
  'src/app/api/admin/gdpr/candidates/route.ts::admin/gdpr/candidates:GET': {
    // ⚠️ DUE letture di `alunni` sotto questa sola chiave, e l'esenzione ne
    // riguarda UNA. L'altra — l'elenco dei candidati vero e proprio — il filtro
    // ce l'ha (`.in('stato', [...STATI_NON_PIU_ISCRITTO])`) ed è la correzione
    // del 12/08 che ha tolto di mezzo la negazione. È esattamente il caso che ha
    // fatto nascere `scoperte`: senza il conteggio, una terza query scritta qui
    // dentro sarebbe nata esente per via di una decisione presa su un'altra.
    scoperte: 1,
    ragione:
      'sonda: legge la sola colonna `stato` (nessuna PII) e conta i valori FUORI dall’allowlist di `@/lib/alunni/stato` — un filtro di stato la renderebbe cieca esattamente su ciò che deve vedere',
  },

  // ── OBBLIGHI VERSO TERZI: il perimetro non è l'iscrizione di oggi ──────────
  // Comunicazione delle spese scolastiche all'Agenzia delle Entrate, criterio di
  // cassa sull'anno solare. Un bambino ritirato a ottobre ha pagato da gennaio a
  // settembre: escluderlo qui vorrebbe dire omettere quelle quote da un
  // adempimento fiscale, in silenzio e una volta l'anno.
  // La chiave è `exportAde` e non `pagamenti/export:GET`: la query vive in una
  // funzione di file, fuori dallo `withRoute`. È il verso giusto — l'esenzione
  // vale per QUEL ramo, e un elenco nuovo scritto nell'handler non la eredita.
  'src/app/api/pagamenti/export/route.ts::exportAde': {
    scoperte: 1,
    ragione:
      'export AdE: criterio di cassa sull’anno solare — chi si è ritirato a ottobre ha comunque pagato da gennaio, e quelle quote vanno comunicate lo stesso',
  },

  // Il filtro c'è, e vive DOVE SI COSTRUISCE IL FLUSSO: `src/lib/sidi/payload.ts`
  // scarta `a.stato !== STATO_ISCRITTO || !a.section_id`. Questa route legge
  // `stato` apposta per passarglielo. Ribattere il filtro anche qui violerebbe la
  // regola che questo repo ha già pagato — «una regola valida per due strade deve
  // vivere in un posto solo» — e il giorno che il Ministero cambiasse la
  // definizione di frequentante ne resterebbe aggiornata una sola.
  'src/app/api/admin/sidi/frequentanti/route.ts::admin/sidi/frequentanti:POST': {
    scoperte: 1,
    ragione:
      'il filtro esiste ed è in `src/lib/sidi/payload.ts` (`a.stato !== STATO_ISCRITTO || !a.section_id`): questa route legge `stato` proprio per passarglielo',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // LETTURE PER SEZIONE — dal 2026-08-13 non più esenti per forma
  //
  // Erano coperte da un ramo di regex e da una frase falsa (vedi la testata).
  // Sono SEI, misurate col rilevatore invece che elencate a memoria — il
  // riesame ne dichiarava dodici «più i `primaria/*`», ma `primaria/classe`
  // il filtro ce l'ha già (`.eq('section_id', …).eq('stato','iscritto')`) e
  // `genitoriDiGrado` l'ha preso in questo stesso lavoro.
  //
  // Il filo che le tiene insieme: sono tutte REGISTRI o produzioni di
  // documenti riferiti a una CLASSE, e in quel contesto un bambino che se n'è
  // andato a metà anno deve restare leggibile — è lo stesso obbligo di
  // conservazione decennale per cui l'archiviazione non cancella l'anagrafica.
  // Dove invece l'elenco serve a CONTATTARE una famiglia, il filtro c'è: il
  // gemello lato maestra di `chat/contacts` l'ha preso il 2026-08-13 e per
  // questo non è in questo elenco.
  // ───────────────────────────────────────────────────────────────────────────
  'src/app/api/attendance/monthly/route.ts::attendance/monthly:GET': {
    scoperte: 1,
    ragione:
      'registro delle presenze del MESE: un bambino ritirato il 20 ha frequentato dall’1 al 19, e filtrarlo qui cancellerebbe quelle presenze dal registro — che si conserva dieci anni',
  },

  // La STAMPA dello stesso registro (2026-08-16). Legge gli alunni della sezione
  // esattamente come la rotta qui sopra, e la decisione non poteva che essere la
  // stessa — ma per una ragione in più, che vale la pena scrivere: il foglio che
  // esce dalla stampante deve dire ciò che la maestra ha appena guardato sullo
  // schermo. Un PDF più severo dei dati che lo generano non è un PDF più
  // corretto: è una seconda verità, e chi firma il registro non saprebbe quale
  // delle due ha in mano. Se un giorno si decidesse di filtrare, si filtra nelle
  // DUE rotte nello stesso lavoro.
  'src/app/api/admin/registro-presenze/pdf/route.ts::admin/registro-presenze/pdf:GET': {
    scoperte: 1,
    ragione:
      'stampa del registro mensile: legge gli stessi alunni di `attendance/monthly:GET` e deve dire ciò che la maestra ha appena visto a schermo — un foglio più severo dei dati che lo generano sarebbe una seconda verità',
  },

  'src/app/api/diary/entries/route.ts::diary/entries:GET': {
    scoperte: 1,
    ragione:
      'diario di una GIORNATA passata: la lettura è per data, e nascondere le voci scritte per un bambino quando ancora frequentava riscriverebbe il registro all’indietro',
  },

  'src/app/api/diary/students/route.ts::diary/students:GET': {
    scoperte: 1,
    ragione:
      'è l’elenco con cui si RILEGGE il diario oltre che scriverlo: senza il bambino in lista le sue voci passate restano nel database e diventano righe senza nome a schermo',
  },

  'src/app/api/gallery/route.ts::gallery:GET': {
    scoperte: 1,
    ragione:
      'galleria di una classe: le foto sono dell’anno, non di oggi — togliere gli ex compagni dal filtro farebbe sparire dalle foto di gruppo i bambini che c’erano quel giorno',
  },

  'src/app/api/admin/documents-merge/route.ts::admin/documents-merge:GET': {
    scoperte: 1,
    ragione:
      'stampa unione della classe: serve anche per i documenti di FINE anno o di trasferimento, cioè proprio per chi nel frattempo è uscito — è lì che quella carta va prodotta',
  },

  'src/app/api/teacher/modulistica/route.ts::teacher/modulistica:GET': {
    scoperte: 1,
    ragione:
      'modulistica della classe: stessa ragione della stampa unione — il modulo che serve più spesso per un bambino uscito è quello che si compila DOPO che è uscito',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Il lock
// ─────────────────────────────────────────────────────────────────────────────

const COME_SI_RIPARA =
  "Aggiungi `.eq('stato', STATO_ISCRITTO)` (da `@/lib/alunni/stato`) alla query, oppure — se " +
  'quell’elenco ha una ragione per mostrare anche chi non è più iscritto — aggiungi la sua ' +
  'chiave a `AMMESSE`, in questo file, con la ragione scritta per esteso.'

interface Scoperta extends Lettura {
  percorso: string
}

function scanSorgenti(): Scoperta[] {
  const out: Scoperta[] = []
  for (const file of fileSorgente(RADICE)) {
    const percorso = path.relative(process.cwd(), file).split(path.sep).join('/')
    for (const u of elenchiScoperti(fs.readFileSync(file, 'utf8'), percorso)) {
      out.push({ ...u, percorso })
    }
  }
  return out
}

describe('elenchi operativi: chi legge `alunni` per sede intera dichiara lo stato', () => {
  const scoperte = scanSorgenti()

  it('nessun elenco di sede senza filtro di stato fuori dall’allowlist', () => {
    const fuori = scoperte.filter((s) => !(s.chiave in AMMESSE))
    expect(
      fuori.map((s) => `${s.percorso}:${s.riga}  →  chiave: ${s.chiave}`),
      `Elenchi di alunni letti PER SEDE INTERA senza filtro di stato.\n${COME_SI_RIPARA}`,
    ).toEqual([])
  })

  it('l’allowlist non ha voci MORTE: ogni esenzione copre una query che esiste davvero', () => {
    // Una voce che non corrisponde più a niente è peggio di una voce sbagliata:
    // resta lì a dire che una decisione è stata presa su un codice che nel
    // frattempo è cambiato, e chi legge le dà credito. Se una route sparisce, o
    // se il filtro arriva, la sua riga va tolta.
    const vive = new Set(scoperte.map((s) => s.chiave))
    const morte = Object.keys(AMMESSE).filter((k) => !vive.has(k))
    expect(morte, 'voci di `AMMESSE` che non coprono più nessuna query: vanno tolte').toEqual([])
  })

  it('nessuna query CIECA NUOVA eredita l’esenzione di un contenitore già esente', () => {
    // Il residuo che la chiave `<percorso>::<contenitore>` lasciava aperto: due
    // letture cieche nello stesso handler condividono una chiave, quindi la
    // seconda nasceva esentata da una decisione presa sulla prima. Ora ogni voce
    // dichiara QUANTE ne copre, e una in più fa fallire questo test invece di
    // passare inosservata.
    const perChiave = new Map<string, number>()
    for (const s of scoperte) perChiave.set(s.chiave, (perChiave.get(s.chiave) ?? 0) + 1)
    const disallineate = Object.entries(AMMESSE)
      .filter(([k, e]) => (perChiave.get(k) ?? 0) !== e.scoperte)
      .map(([k, e]) => `${k}: dichiarate ${e.scoperte}, trovate ${perChiave.get(k) ?? 0}`)
    expect(
      disallineate,
      'una lettura è nata (o sparita) dentro un contenitore già esente: aggiorna `scoperte` DOPO aver deciso se quella query nuova può mostrare chi non frequenta più',
    ).toEqual([])
  })

  it('ogni esenzione porta una ragione scritta, non un «ok»', () => {
    for (const [chiave, { ragione }] of Object.entries(AMMESSE)) {
      expect(
        ragione.length,
        `la ragione di ${chiave} è troppo corta per essere una decisione`,
      ).toBeGreaterThan(60)
    }
  })

  it('le esenzioni PER SEZIONE sono esattamente quelle dichiarate (non più un ramo di regex)', () => {
    // Il ramo `perSezione` esentava in silenzio; ora le letture per sezione che
    // restano scoperte devono essere quelle decise a mano. Se qualcuno ne
    // aggiunge una, questo test la nomina — che è tutto ciò che serviva.
    // Erano sei; dal 2026-08-16 sono sette, ed è la STAMPA del registro mensile,
    // che legge gli stessi alunni della rotta che alimenta lo schermo.
    const DICHIARATE = [
      'src/app/api/admin/documents-merge/route.ts::admin/documents-merge:GET',
      'src/app/api/admin/registro-presenze/pdf/route.ts::admin/registro-presenze/pdf:GET',
      'src/app/api/attendance/monthly/route.ts::attendance/monthly:GET',
      'src/app/api/diary/entries/route.ts::diary/entries:GET',
      'src/app/api/diary/students/route.ts::diary/students:GET',
      'src/app/api/gallery/route.ts::gallery:GET',
      'src/app/api/teacher/modulistica/route.ts::teacher/modulistica:GET',
    ]
    const trovate = [...new Set(scoperte.filter((s) => s.perSezione).map((s) => s.chiave))].sort()
    expect(trovate).toEqual([...DICHIARATE].sort())
  })

  it('il rapporto che ha deciso il piano è ancora vero — e si RIMISURA, non si cita', () => {
    // ⚠️ QUESTO TEST ESISTE PERCHÉ TRE NUMERI SCRITTI A MANO NON CONCORDAVANO.
    // Il 2026-08-12 lo stesso rapporto è stato dichiarato «182 volte in 117
    // file» in questa testata, «181 volte in 117 file» nella migrazione e
    // «dodici filtri» in due commenti di route. Correggerli sarebbe stato vero
    // per una settimana: qui si contano, e i valori del giorno finiscono nel
    // messaggio di fallimento — che è l'unico posto in cui un numero non
    // invecchia.
    let letture = 0
    const file = new Set<string>()
    let conFiltroDiStato = 0
    for (const f of fileSorgente(RADICE)) {
      const src = fs.readFileSync(f, 'utf8')
      const trovate = lettureAlunni(src)
      if (trovate.length > 0) file.add(f)
      letture += trovate.length
      conFiltroDiStato += trovate.filter((u) => u.conStato).length
    }
    const misura = `misurato adesso: ${letture} letture di \`alunni\` in ${file.size} file, ${conFiltroDiStato} con un filtro di stato`
    // Le soglie stanno LARGHE di proposito: non devono diventare rosse perché
    // qualcuno ha scritto una query nuova e corretta. Diventano rosse se il
    // rapporto si ribalta — cioè se un giorno lo stato governasse davvero
    // l'uscita dagli elenchi, e allora il piano andrebbe riletto, non il test.
    expect(letture, misura).toBeGreaterThan(100)
    expect(conFiltroDiStato, misura).toBeLessThan(letture / 3)
  })

  it('le correzioni del 12 e del 13 agosto restano corrette (regressione puntuale)', () => {
    // Le chiavi che NON devono più comparire fra le scoperte. Se qualcuno
    // togliesse un filtro, la prima asserzione diventerebbe rossa comunque — ma
    // questa dice anche QUALI erano, che è l'informazione che si perde per prima.
    //
    // ⚠️ NOTA DEL 2026-08-13 — l'elenco è cresciuto da quattro a sette, e per due
    // ragioni diverse. Il 12/08 la testata di questo test spiegava, con una
    // franchezza rara, che `genitoriDiClassi` NON poteva stare in elenco: filtrava
    // `classe_sezione`, quindi per il lock era esente e sarebbe rimasta verde
    // anche senza filtro di stato — «una riga che non può fallire è una
    // protezione che sembra esserci, il modo più efficace di perderla». Quella
    // nota era giusta e ha smesso di valere insieme all'esenzione: da oggi le
    // letture per sezione le guarda il lock, quindi `genitoriDiClassi` e il
    // `chat/contacts` lato maestra possono davvero diventare rosse. E
    // `genitoriDiGrado` — il ramo che nessuno vedeva — è in elenco perché è il
    // motivo per cui questo lavoro è stato rifatto.
    const corrette = [
      'src/app/api/admin/chat/contacts/route.ts::admin/chat/contacts:GET',
      'src/app/api/chat/contacts/route.ts::chat/contacts:GET',
      'src/lib/notifiche/destinatari.ts::genitoriDiScuola',
      'src/lib/notifiche/destinatari.ts::genitoriDiClassi',
      'src/lib/news/notifiche.ts::genitoriDiGrado',
      'src/app/api/agenda/route.ts::agenda:POST',
      'src/lib/news/digest.ts::emailFamiglie',
    ]
    const scoperteChiavi = new Set(scoperte.map((s) => s.chiave))
    expect(corrette.filter((c) => scoperteChiavi.has(c))).toEqual([])
  })

  it('il lock GUARDA DAVVERO qualcosa: gli elenchi di sede esistono e sono contati', () => {
    // Un lock verde perché non trova violazioni e uno verde perché non guarda più
    // niente, da fuori, sono identici. Questa soglia è la differenza: se una
    // riscrittura delle regex smettesse di riconoscere le query, il numero
    // crollerebbe e il test lo direbbe invece di lasciar passare il silenzio.
    let elenchiDiSede = 0
    for (const file of fileSorgente(RADICE)) {
      for (const u of lettureAlunni(fs.readFileSync(file, 'utf8'))) {
        if (!u.scrittura && !u.singola && u.perSede) elenchiDiSede++
      }
    }
    // 46 il 2026-08-12. La soglia sta sotto di proposito: questo test non deve
    // diventare rosso perché qualcuno ha scritto una query nuova e corretta.
    expect(elenchiDiSede).toBeGreaterThanOrEqual(40)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL SECONDO LOCK — chi CHIAMA l'anagrafica dichiara che stato vuole
//
// `admin/students:GET` sta in `AMMESSE` perché è un'anagrafica: l'elenco
// completo della sede è il suo scopo, e la vista «non più iscritti» è
// letteralmente `?stato=ritirato`. Vero — ma l'esenzione era scritta come se la
// rotta avesse un solo consumatore, e i consumatori sono undici. Fra quelli che
// non passavano niente c'erano due schermate MENSA in cui la segreteria
// seleziona un bambino e gli inserisce un ticket o gli vende un pacchetto: un
// archiviato restava selezionabile, e quello non è un'anagrafica, è un elenco
// operativo.
//
// Il rimedio esisteva già ed era noto — tre chiamanti passavano `stato=iscritto`
// da sempre. Mancava la regola che impedisce al dodicesimo di dimenticarsene.
// ─────────────────────────────────────────────────────────────────────────────

/** L'URL dell'anagrafica in una chiamata client. */
const CHIAMATA_ANAGRAFICA = /\/api\/admin\/students\?/g

/**
 * I chiamanti che chiedono l'elenco COMPLETO, e perché possono.
 * Chiave: il percorso del file. Ognuno dichiara quante chiamate cieche ha.
 */
const CHIAMANTI_SENZA_STATO: Record<string, Esenzione> = {
  'src/app/(dashboard)/admin/students/page.tsx': {
    scoperte: 1,
    ragione:
      'È l’anagrafica stessa: la linguetta «Non più iscritti» accanto chiede `?stato=ritirato`, quindi qui l’elenco completo è il contenuto della pagina, non una dimenticanza',
  },
  'src/app/(dashboard)/admin/protocolli/page.tsx': {
    scoperte: 1,
    ragione:
      'Registro dei protocolli DPR 445: si protocolla soprattutto per chi è USCITO (nulla osta, trasferimenti, certificati chiesti dopo), quindi togliere gli archiviati toglierebbe il caso d’uso principale',
  },
  // ⚠️ QUESTA VOCE NON DICE «voglio anche chi non frequenta più»: dice che il confine
  // giusto qui è PIÙ LARGO di `stato=iscritto` e più stretto della sede intera. Il banco
  // dei prestampati sceglie il bambino a cui rilasciare un certificato, e il gate che
  // conta è quello del SERVER: `alunnoNonStampabile` (`src/lib/prestampati/prefill.ts`)
  // rifiuta con 409 solo chi è `eNonPiuIscritto`, cioè il RITIRATO — il `sospeso` no,
  // perché «è un bambino che frequenta» (`src/lib/alunni/stato.ts`, dove quel confine è
  // deciso una volta sola). Passare `stato=iscritto` renderebbe impossibile emettere il
  // certificato per il Bonus Asilo Nido a una famiglia sospesa per morosità — che è
  // proprio la famiglia che quel certificato lo chiede — e sarebbe una scelta di prodotto
  // presa da un filtro di interfaccia invece che da una persona. Il pannello legge quindi
  // l'elenco della classe e lo filtra con `eAncoraIscritto`, la STESSA funzione del
  // rifiuto del server: due strade, una regola sola.
  'src/components/features/prestampati/PrestampatiSegreteria.tsx': {
    scoperte: 1,
    ragione:
      'Banco dei prestampati: il confine è quello del server (`alunnoNonStampabile` rifiuta solo `eNonPiuIscritto`, quindi il sospeso resta), e il pannello filtra con `eAncoraIscritto` — `stato=iscritto` escluderebbe i sospesi, cioè bambini che frequentano e a cui il certificato si rilascia',
  },
}

describe('i chiamanti dell’anagrafica dichiarano lo stato che vogliono', () => {
  /** Le chiamate a `/api/admin/students?` in `src/`, commenti esclusi. */
  function chiamate(): { percorso: string; riga: number; conStato: boolean }[] {
    const out: { percorso: string; riga: number; conStato: boolean }[] = []
    for (const file of fileSorgente(RADICE)) {
      const src = fs.readFileSync(file, 'utf8')
      const { senzaCommenti } = mascheraSorgente(src)
      CHIAMATA_ANAGRAFICA.lastIndex = 0
      for (const m of senzaCommenti.matchAll(CHIAMATA_ANAGRAFICA)) {
        // La query string sta su UNA riga in tutte le chiamate del repo
        // (misurato): si legge fino a fine riga, che è più robusto che provare a
        // chiudere un template literal con dentro un ternario e altri backtick.
        const fineRiga = senzaCommenti.indexOf('\n', m.index)
        const url = senzaCommenti.slice(m.index, fineRiga < 0 ? undefined : fineRiga)
        out.push({
          percorso: path.relative(process.cwd(), file).split(path.sep).join('/'),
          riga: riga(src, m.index),
          conStato: /[?&]stato=/.test(url),
        })
      }
    }
    return out
  }

  const tutte = chiamate()

  it('nessuna chiamata cieca fuori dall’elenco dichiarato', () => {
    const cieche = tutte.filter((c) => !c.conStato && !(c.percorso in CHIAMANTI_SENZA_STATO))
    expect(
      cieche.map((c) => `${c.percorso}:${c.riga}`),
      'Chiamate a `/api/admin/students` senza `stato=`: la risposta PREDEFINITA è la sede intera, ' +
        'archiviati compresi. Aggiungi `stato=iscritto` se è un elenco operativo, oppure aggiungi il ' +
        'file a `CHIAMANTI_SENZA_STATO` con la ragione per cui vuole anche chi non frequenta più.',
    ).toEqual([])
  })

  it('l’elenco dei chiamanti completi non ha voci morte, e ognuna dice quante ne copre', () => {
    const perFile = new Map<string, number>()
    for (const c of tutte.filter((x) => !x.conStato)) {
      perFile.set(c.percorso, (perFile.get(c.percorso) ?? 0) + 1)
    }
    const disallineate = Object.entries(CHIAMANTI_SENZA_STATO)
      .filter(([f, e]) => (perFile.get(f) ?? 0) !== e.scoperte)
      .map(([f, e]) => `${f}: dichiarate ${e.scoperte}, trovate ${perFile.get(f) ?? 0}`)
    expect(disallineate).toEqual([])
  })

  it('il lock GUARDA DAVVERO: le chiamate esistono e la maggioranza dichiara lo stato', () => {
    // La solita differenza fra «verde perché non trova violazioni» e «verde
    // perché non guarda più niente». Undici chiamate il 2026-08-13.
    expect(tutte.length, `chiamate trovate: ${tutte.length}`).toBeGreaterThanOrEqual(8)
    expect(tutte.filter((c) => c.conStato).length).toBeGreaterThanOrEqual(6)
  })

  it('le due schermate MENSA passano `stato=iscritto` (regressione puntuale)', () => {
    // Sono le due che il riesame ha nominato, ed è la ragione per cui questo lock
    // esiste: «tuo figlio archiviato è ancora prenotabile a mensa» non si difende
    // davanti a un genitore.
    for (const f of [
      'src/components/features/admin/mensa/PrenotazioneSegreteria.tsx',
      'src/components/features/admin/pagamenti/TicketMensaPanel.tsx',
    ]) {
      const cieche = tutte.filter((c) => c.percorso === f && !c.conStato)
      expect(cieche, `${f} chiama l’anagrafica senza dichiarare lo stato`).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Le forme che DEVE vedere e quelle che NON deve segnalare, scritte a mano. Sono
// la sola difesa contro il modo più comune di perdere un lock: una regex che
// smette di combaciare, e un file che resta verde per sempre.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore riconosce la forma vietata', () => {
  it('elenco per sede intera senza stato (era il caso `admin/chat/contacts`)', () => {
    const src = `
      export const GET = withRoute('admin/chat/contacts:GET', async (request) => {
        const supabase = await createAdminClient()
        const plessi = await resolveScuoleAttive(request, supabase, auth.user)
        const { data } = await supabase
          .from('alunni')
          .select('id, nome, cognome, classe_sezione, scuola_id')
          .in('scuola_id', plessi)
        return NextResponse.json({ data })
      })
    `
    expect(elenchiScoperti(src).map((s) => [s.riga, s.chiave])).toEqual([
      [6, '<test>::admin/chat/contacts:GET'],
    ])
  })

  it("`.eq('scuola_id', …)` singolo, in una funzione di libreria (era `genitoriDiScuola`)", () => {
    // Sorgente NON indentato di proposito: fuori dalle route il contenitore si
    // riconosce dalle dichiarazioni di PRIMO livello, ed è quella severità a
    // impedire che una `const` locale dentro la funzione rubi il nome alla
    // chiave dell'allowlist.
    const src = `
export async function genitoriDiScuola(supabase, scuolaId) {
  const operazione = 'notifiche/destinatari:genitoriDiScuola'
  const { data, error } = await supabase.from('alunni').select('id').eq('scuola_id', scuolaId)
  return genitoriDiAlunni(supabase, (data ?? []).map((a) => a.id))
}
    `
    expect(elenchiScoperti(src).map((s) => s.chiave)).toEqual(['<test>::genitoriDiScuola'])
  })

  it('il filtro di stato applicato SOLO dentro un `if` non conta (è la forma di `admin/students`)', () => {
    const src = `
      export const GET = withRoute('admin/students:GET', async (request) => {
        const supabase = await createAdminClient()
        let query = supabase.from('alunni').select('*').in('scuola_id', scuole)
        if (stato) query = query.eq('stato', stato)
        const { data } = await query
      })
    `
    expect(elenchiScoperti(src)).toHaveLength(1)
  })

  it('anche dentro un blocco `if` su più righe la continuazione resta condizionale', () => {
    const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const supabase = await createAdminClient()
        let q = supabase.from('alunni').select('id').in('scuola_id', plessi)
        if (soloIscritti) {
          q = q.eq('stato', 'iscritto')
        }
        const { data } = await q
      })
    `
    expect(elenchiScoperti(src)).toHaveLength(1)
  })

  it('il filtro di stato citato in un COMMENTO non conta', () => {
    const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const supabase = await createAdminClient()
        // Qui manca \`.eq('stato', STATO_ISCRITTO)\`: gli archiviati compaiono ancora.
        const { data } = await supabase.from('alunni').select('id').in('scuola_id', plessi)
      })
    `
    expect(elenchiScoperti(src)).toHaveLength(1)
  })

  it('la NEGAZIONE non conta come filtro: `.neq(stato, ritirato)` è il difetto, non la cura', () => {
    // Il verso, non la presenza. `.neq` dice «tutto tranne uno»: il giorno che
    // qualcuno aggiunge uno stato `trasferito`, una query «corretta» così torna
    // cieca e il gate resta verde. È la stessa forma con cui
    // `admin/gdpr/candidates` metteva un bambino soltanto SOSPESO fra i candidati
    // a un'anonimizzazione irreversibile — difetto vero, in produzione, riparato
    // il 2026-08-12 passando a un'allowlist.
    const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const { data } = await supabase
          .from('alunni').select('id').in('scuola_id', plessi).neq('stato', 'ritirato')
      })
    `
    expect(elenchiScoperti(src)).toHaveLength(1)
  })

  it('nemmeno `not(...)` o `filter(...)`: l’operatore è un argomento, e non si legge', () => {
    const conNot = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const { data } = await supabase
          .from('alunni').select('id').in('scuola_id', plessi).not('stato', 'eq', 'ritirato')
      })
    `
    const conFilter = `
      export const GET = withRoute('admin/y:GET', async (request) => {
        const { data } = await supabase
          .from('alunni').select('id').in('scuola_id', plessi).filter('stato', 'neq', 'ritirato')
      })
    `
    expect(elenchiScoperti(conNot)).toHaveLength(1)
    expect(elenchiScoperti(conFilter)).toHaveLength(1)
  })

  it('l’elenco PER SEZIONE non è più esente per forma (era il buco che nascondeva `genitoriDiGrado`)', () => {
    // Il rilevatore lo vedeva e lo scartava: la sua esenzione era motivata con
    // «un archiviato non ha più né section_id né classe_sezione», frase che la
    // tendina della scheda alunno smentisce. Ora è una lettura come le altre, e
    // se ha una ragione la scrive in `AMMESSE`.
    const src = `
      export const GET = withRoute('diary/students:GET', async (request) => {
        const { data } = await supabase
          .from('alunni')
          .select('id, nome, cognome')
          .eq('classe_sezione', sezione)
          .in('scuola_id', plessi)
      })
    `
    expect(elenchiScoperti(src).map((s) => s.chiave)).toEqual(['<test>::diary/students:GET'])
  })

  it('un filtro per sezione CONDIZIONALE non basta: senza sezione è un elenco di plesso (era `agenda`)', () => {
    const src = `
      export const POST = withRoute('agenda:POST', async (request) => {
        let alunniQuery = supabase.from('alunni').select('id').eq('scuola_id', scuolaId)
        if (sectionId) alunniQuery = alunniQuery.eq('section_id', sectionId)
        const { data: alunni } = await alunniQuery
      })
    `
    expect(elenchiScoperti(src).map((s) => s.chiave)).toEqual(['<test>::agenda:POST'])
  })
})

describe('il rilevatore NON segnala le forme corrette', () => {
  it('il filtro di stato nella stessa catena, su più righe e con commenti in mezzo', () => {
    const src = `
      export const GET = withRoute('admin/chat/contacts:GET', async (request) => {
        const { data } = await supabase
          .from('alunni')
          // la rubrica non contatta le famiglie di chi non frequenta più
          .select('id, nome, cognome')
          .in('scuola_id', plessi)
          .eq('stato', STATO_ISCRITTO)
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('continuazione INCONDIZIONATA sulla stessa variabile (PostgREST la mette in AND)', () => {
    const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        let q = supabase.from('alunni').select('id').eq('stato', STATO_ISCRITTO)
        q = q.in('scuola_id', plessi)
        const { data } = await q
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('elenco per SEZIONE **col filtro di stato**: la forma corretta resta verde', () => {
    // Il gemello del test qui sopra, dall'altra parte del confine: da quando
    // l'esenzione per forma non c'è più, ciò che rende verde una query per
    // sezione è il filtro — non il fatto di nominare la classe.
    const src = `
      export const GET = withRoute('chat/contacts:GET', async (request) => {
        const { data } = await supabase
          .from('alunni')
          .select('id, nome, cognome')
          .eq('classe_sezione', teacherSection)
          .in('scuola_id', plessi)
          .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('elenco per IDENTITÀ: eredita il filtro dalla query di monte', () => {
    const src = `
      export const GET = withRoute('gallery:GET', async (request) => {
        const { data } = await supabase
          .from('alunni')
          .select('classe_sezione')
          .in('id', myTaggedStudentIds)
          .in('scuola_id', plessi)
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('UNA riga per id: la scheda di un archiviato si deve poter aprire', () => {
    const src = `
      export const GET = withRoute('admin/students/[id]:GET', async (request) => {
        const { data } = await supabase
          .from('alunni')
          .select('*')
          .eq('id', id)
          .in('scuola_id', plessi)
          .maybeSingle()
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('una SCRITTURA non riguarda questo lock: archiviare è un UPDATE', () => {
    const src = `
      export const PATCH = withRoute('admin/students:PATCH', async (request) => {
        await supabase
          .from('alunni')
          .update({ stato: STATO_RITIRATO, archiviato_il: adesso })
          .eq('id', id)
          .in('scuola_id', plessi)
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('una query senza filtro di SEDE non è un elenco di plesso (la guarda un altro lock)', () => {
    const src = `
      export const GET = withRoute('debug/x:GET', async (request) => {
        const { data } = await supabase.from('alunni').select('id').limit(5)
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })

  it('un’altra tabella non riguarda questo lock', () => {
    const src = `
      export const GET = withRoute('admin/parents:GET', async (request) => {
        const { data } = await supabase.from('parents').select('id').in('scuola_id', plessi)
      })
    `
    expect(elenchiScoperti(src)).toEqual([])
  })
})
