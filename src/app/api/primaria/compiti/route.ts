import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zDataYMD, zOpzionale, zPeriodo, zUuid } from '@/lib/validation/common'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { firmaPercorsi, percorsoNelBucket } from '@/lib/allegati/storage'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { allegatiRegistroViviDalJoin } from '@/lib/primaria/cestino-allegati-registro'

// ─── IL CONTENITORE DEGLI ALLEGATI DEL REGISTRO ──────────────────────────────
//
// È PRIVATO (`public: false`, deciso in `primaria/allegati:POST`), e in tabella
// `allegati_registro.file_url` porta il PERCORSO dentro il contenitore
// (`registro/<uuid>/<timestamp>-<rnd>.jpg`), non un indirizzo: l'indirizzo lo
// genera la LETTURA, firmato e a scadenza breve, dietro al gate della route che
// lo serve.
//
// ⚠️ Il nome è ripetuto qui perché è ripetuto altrove. MISURA del 2026-09-19
// (`grep -rn "registro-allegati" src/`): la stringa sta in **TRE** file —
// `api/parent/primaria/route.ts` e questo, dove la costante si chiama
// `BUCKET_REGISTRO_ALLEGATI`, e `api/primaria/allegati/route.ts`, dove si chiama
// `BUCKET`. Tre stringhe uguali in tre file sono tre cose da tenere allineate, e
// la casa giusta è `@/lib/allegati/storage`, accanto a `BUCKET_AVVISI_ALLEGATI`
// e `BUCKET_TASK_ALLEGATI`. Lo spostamento tocca file che non appartengono a
// questo lavoro e resta da fare.
//
// ⚠️ E NON SONO QUATTRO. Fino al 2026-09-19 questa nota diceva «quattro stringhe
// uguali in quattro file» e metteva `primaria/registro` fra le route che
// nominano il contenitore: `primaria/registro` non nomina né il bucket né lo
// Storage — non firma niente e restituisce `file_url` GREZZO. Un inventario
// sbagliato manda chi verrà a cercare una quarta occorrenza che non esiste, e
// gli fa credere che quella route abbia una firma da tenere allineata con
// questa.
const BUCKET_REGISTRO_ALLEGATI = 'registro-allegati'

/** Quanto indietro si guarda quando il chiamante non dichiara `dataDa`. */
const GIORNI_PREDEFINITI = 30

/**
 * QUANTE RIGHE DI REGISTRO SI LEGGONO IN UNA PAGINA, e perché proprio 300.
 *
 * 🔴 PostgREST TRONCA DA SOLO, E NON LO DICE. `supabase/config.toml:18` dichiara
 * `max_rows = 1000` (ed è anche il valore del progetto ospitato): una query senza
 * `.limit()` che ne trovasse 1.600 ne riceverebbe 1.000 e una risposta 200
 * identica a quella completa. Con l'ordine `data DESC` a sparire sarebbe la parte
 * più VECCHIA del periodo.
 *
 * 🔴 E QUI IL TETTO DI PAGINA NON È SOLO UN TAGLIO: È LA CONDIZIONE DI FINE. La
 * route dice «non c'è altro da leggere» quando una lettura torna con MENO di
 * `RIGHE_PER_PAGINA` righe. Se questo numero superasse `max_rows`, a tagliare
 * sarebbe PostgREST e non noi: la lettura tornerebbe con 1.000 righe su 1.200
 * chieste, cioè «meno del tetto», e la route direbbe `prossimoCursore: null`
 * davanti a un anno ancora da leggere. Sarebbe la perdita silenziosa contro cui è
 * costruita tutta questa route, prodotta dalla sua stessa paginazione. Per questo
 * 300 sta COMODAMENTE sotto il mille, non appena sotto: regge anche se un domani
 * `max_rows` scendesse a 500. Il caso `la pagina resta sotto max_rows` in
 * `__tests__/api/primaria-compiti.test.ts` legge `supabase/config.toml` e rifà il
 * confronto, invece di fidarsi di questa riga.
 *
 * PERCHÉ 300 E NON 50 O 900, misurato in produzione il 2026-09-19:
 *
 *   SELECT max(ore) FROM (SELECT section_id, data, count(*) AS ore
 *                           FROM registro_orario GROUP BY 1, 2) t;         → 5
 *   SELECT max(ore) FROM (SELECT section_id, giorno_settimana, count(*) AS ore
 *                           FROM orario_settimanale GROUP BY 1, 2) t;      → 5
 *
 * Cinque ore in ogni giorno di lezione, lunedì-venerdì (nessuna riga di sabato o
 * domenica in nessuna delle due tabelle). Quindi 300 righe = 60 giorni di lezione
 * = 12 settimane piene: una pagina copre un trimestre di registro, e un anno
 * scolastico pieno (~200 giorni × 5 ore ≈ 1.000 righe) sta in quattro pagine.
 *
 * ⚠️ NON VALE per i percorsi da firmare allo Storage: quelli sono
 * `RIGHE_PER_PAGINA × allegati per riga`, e il secondo fattore non ha tetto. La
 * misura sta accanto a `firmaPercorsi`, in fondo alla route, dov'è il codice che la
 * usa.
 */
const RIGHE_PER_PAGINA = 300

/**
 * QUANTE LETTURE PUÒ FARE UNA SOLA RISPOSTA, e perché il ciclo esiste.
 *
 * La route PAGINA righe di registro e RESTITUISCE solo quelle che hanno un compito.
 * Il filtro avviene dopo la lettura — e non può avvenire prima, vedi il blocco
 * `PERCHÉ IL FILTRO DEI COMPITI NON SI PUÒ SPOSTARE NEL DATABASE` più sotto —
 * quindi una pagina di 300 righe può contenere zero compiti pur avendone di più
 * vecchi da leggere. Senza questo ciclo, la prima risposta di una classe che per un
 * trimestre non ha assegnato niente sarebbe un elenco vuoto: vero, ma indistinguibile
 * da «non ci sono compiti» per chiunque non guardi anche il cursore.
 *
 * Il ciclo NON è illimitato, e il tetto è dichiarato perché il costo lo paga una
 * richiesta HTTP: al massimo `GIRI_MAX_PER_PAGINA × RIGHE_PER_PAGINA` = 1.200 righe
 * lette per una risposta, cioè un anno intero. Quando il tetto morde si esce con un
 * elenco vuoto e il cursore VALORIZZATO — che è il contratto, non un ripiego: il
 * client continua a chiedere. E parte la riga `pagina-senza-compiti` a `warn`, che è
 * l'informazione da cui si decide se alzare il tetto.
 *
 * QUANTO SERVE DAVVERO, misurato in produzione il 2026-09-19 (97 righe, 6 classi):
 * 18 righe su 97 hanno il compito di classe, e la sequenza più lunga di righe
 * consecutive SENZA compiti — nell'ordine esatto in cui questa route legge — è **30**
 * (media 7,9 su 10 sequenze). Trenta contro 300: oggi nessuna pagina esce vuota, e
 * il ciclo non fa mai più di un giro. È un campione piccolo di un registro appena
 * avviato, ed è il motivo per cui il tetto c'è lo stesso invece di essere «uno».
 */
const GIRI_MAX_PER_PAGINA = 4

/**
 * L'AMPIEZZA MASSIMA DELL'INTERVALLO — un presidio contro le richieste assurde, e
 * NON più un calcolo sul numero di righe leggibili.
 *
 * 🔴 PERCHÉ TORNA A 365, dopo essere stato 223 per un giorno. Fino al 2026-09-19
 * questo numero era CALCOLATO dal tetto delle righe (`MAX_RIGHE / (ore × giorni)`),
 * ed era un ragionamento rigoroso su una premessa che non vale più: che la finestra
 * dovesse stare in UNA lettura. Con `max_rows = 1000` e un tetto nostro che per
 * restare distinguibile dal suo deve stargli sotto, nessun valore copriva un anno —
 * e la conseguenza era che a giugno il docente non poteva più chiedere l'anno
 * scolastico: da settembre a gennaio spariva dietro un 400 `PERIODO_TROPPO_LUNGO`.
 * Un rifiuto che si vede è meglio di un elenco accorciato in silenzio, ma è pur
 * sempre una funzione richiesta che smette di esserci.
 *
 * Il limite delle righe adesso lo risolve la PAGINAZIONE (`RIGHE_PER_PAGINA` +
 * `prossimoCursore`), e questo numero torna a fare il solo mestiere che gli
 * compete: dire di no a un intervallo che nessun docente chiede sul serio. 365
 * giorni di calendario sono un anno; la pastiglia «Anno scolastico» del registro ne
 * chiede 364 e passa, com'è giusto. Chi ne chiede tremila sta sbagliando i campi o
 * sta sondando: la finestra non è un tetto sulle righe, quindi non ha più bisogno
 * di essere stretta — ma un estremo aperto all'indietro farebbe scandire al
 * database tutto il registro a ogni pagina, e questo resta un motivo sufficiente.
 *
 * Non si CLAMPA: un intervallo silenziosamente accorciato fa credere al docente di
 * star guardando tutto l'anno mentre ne vede sei mesi, e «non ci sono compiti in
 * quel periodo» diventa indistinguibile da «quel periodo non te l'ho letto». È la
 * stessa ragione per cui `zLimite` (`@/lib/validation/common`) rifiuta invece di
 * stringere.
 */
const GIORNI_MAX_INTERVALLO = 365

/** Sposta una data 'YYYY-MM-DD' di N giorni di CALENDARIO (niente fusi: è aritmetica). */
function spostaGiorni(dataIso: string, giorni: number): string {
  const [anno, mese, giorno] = dataIso.split('-').map(Number)
  return new Date(Date.UTC(anno, mese - 1, giorno) + giorni * 86_400_000).toISOString().slice(0, 10)
}

/** Giorni fra due date 'YYYY-MM-DD' (positivo se `a` viene dopo `da`). */
function giorniFra(da: string, a: string): number {
  const [ay, am, ag] = da.split('-').map(Number)
  const [by, bm, bg] = a.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bg) - Date.UTC(ay, am - 1, ag)) / 86_400_000)
}

/**
 * Gli estremi EFFETTIVI del periodo, con i default applicati.
 *
 * ⚠️ «Oggi» è `oggiFiscaleISO()` (fuso `Europe/Rome`), MAI
 * `new Date().toISOString()`: il runtime gira in UTC, e fra mezzanotte e le due di
 * notte italiane le due date sono diverse — il periodo predefinito partirebbe (e
 * il tetto si misurerebbe) da un giorno che in Italia non è ancora arrivato.
 *
 * `a: null` significa «nessun tetto superiore», ed è deliberato: i compiti con
 * consegna futura sono esattamente quelli che la linguetta deve mostrare. Per
 * MISURARE l'ampiezza, però, l'estremo aperto vale oggi — altrimenti un intervallo
 * senza fine non avrebbe ampiezza e il tetto non potrebbe mordere.
 */
function risolviPeriodo(dataDa: string | undefined, dataA: string | undefined) {
  const oggi = oggiFiscaleISO()
  const da = dataDa ?? spostaGiorni(oggi, -GIORNI_PREDEFINITI)
  const a = dataA ?? null
  return { da, a, giorni: giorniFra(da, a ?? oggi) }
}

// ⚠️ `userId` NON sta nello schema: l'identità la risolve il gate
// (`requireDocente` → `utenteDellaRichiesta`), e uno schema che la accettasse
// suggerirebbe che il client possa dichiararla. `z.object` è «strip»: il
// parametro arriva, non passa, e non fa fallire la validazione.
//
// ⚠️ I DUE RIFIUTI DEL PERIODO NON STANNO QUI, e fino al 2026-09-19 il tetto dei
// 365 giorni ci stava (`superRefine`). Sembrava la scelta ordinata — stessa porta
// e stessa forma di ogni altro ingresso rifiutato — ma quella forma è
// `{ error: 'Dati non validi', details: [{ path, message }] }`, e `details` NON LO
// LEGGE NESSUNO: `messaggioDaCorpo`, `soloCatalogoDaCorpo` ed `erroreDaRisposta`
// (`@/lib/ui/esito-fetch`) guardano solo `error` e `codice`, e l'unico consumatore
// di `details` in tutta `src/` è `CassaMovimentoModal.tsx`, che ne usa il `path`.
// Il docente leggeva «Dati non validi» e il motivo restava nel corpo, intatto e
// invisibile. Un rifiuto muto è un intervallo accorciato in silenzio con un
// passaggio in più: i due controlli stanno ora nel corpo della route, ciascuno col
// suo `codice` traducibile.
//
// ⚠️ GLI ESTREMI PASSANO DA `zPeriodo`, non da un `zDataYMD.optional()` nudo. La
// differenza è la STRINGA VUOTA: `?dataDa=` è quello che manda una barra filtri
// con il campo svuotato (e il navigatore di date del registro), e con
// `.optional()` nudo `''` non è «assente» — è una data che non rispetta la regex,
// cioè un 400 «Dati non validi» SENZA `codice`. Lo stesso rifiuto muto che il
// commento qui sopra condanna, riprodotto sul parametro accanto. `zPeriodo('data')`
// genera esattamente questi due nomi (`<chiave>Da`/`<chiave>A`) e li avvolge in
// `zOpzionale`, che porta `''` e `null` a `undefined`: il campo vuoto torna a
// significare «nessun estremo», cioè la finestra predefinita. È anche l'helper che
// la corsia sorella (`api/parent/primaria`) ha appena adottato: due route che
// leggono lo stesso periodo con due grammatiche diverse sono il modo in cui una
// convenzione diverge.
//
// ⚠️ `cursore` È OPACO PER IL CLIENT, e qui lo schema può dirne una cosa sola: che
// è una stringa e quanto può essere lunga. Il suo CONTENUTO non si valida in
// `zod` insieme agli altri parametri — va decodificato prima, e il rifiuto che ne
// esce deve poter dire «ricarica l'elenco», non «Dati non validi». Vedi
// `leggiCursore`.
const getQuerySchema = z.object({
  sectionId: zUuid,
  ...zPeriodo('data').shape,
  // ⚠️ RIMISURATO IL 2026-09-19. Qui c'era scritto «512 caratteri sono VENTI
  // VOLTE il cursore che questa route emette (~120)», e quel ~120 era la
  // lunghezza del JSON PRIMA della base64 — cioè di una cosa che non esce da
  // nessuna parte. Misurato su un cursore vero (sezione e riga uuid, ora a una
  // cifra): JSON **116** caratteri, base64url **155**. Il rapporto col tetto è
  // **3,3 volte**, non venti. Terza occorrenza in questo file della stessa forma
  // di difetto — vedi «E NON SONO QUATTRO» in testa e «RIMISURATO perché la
  // misura dichiarata era FALSA» sui percorsi da firmare: un numero scritto con
  // sicurezza e mai rifatto.
  //
  // Il tetto resta 512 e il margine basta: anche l'`i` più lungo che `zCursore`
  // accetta (64 caratteri) fa 192. Non serve comunque a stringere — serve a non
  // far arrivare mezzo megabyte di base64 a `Buffer.from` e a `JSON.parse`.
  // `zOpzionale` porta `''` a `undefined`, per la stessa ragione degli estremi
  // del periodo: un client che svuota il cursore sta dicendo «riparti
  // dall'inizio», non «ecco un cursore vuoto».
  cursore: zOpzionale(z.string().max(512, 'Cursore non valido')),
})

/**
 * LA FORMA DEL CURSORE, e perché è opaca ma non cifrata.
 *
 * Dentro c'è la POSIZIONE dell'ultima riga di registro letta — `data`,
 * `ora_lezione`, `id` — più la SEZIONE a cui appartiene, in JSON, in base64url.
 * Opaco significa che il client lo rimanda identico e non lo interpreta, non che
 * sia un segreto: chi lo decodifica trova tre valori che ha appena mandato lui
 * (la classe, il periodo) e un uuid di riga di registro. Nessun dato di bambino
 * ci passa — questa route non ne legge nemmeno uno.
 *
 * ⚠️ LA SEZIONE STA DENTRO, e non è decorazione: il cursore GUIDA una lettura
 * fatta col client service-role. Un cursore preso da un'altra classe non potrebbe
 * far uscire righe di quella classe (i filtri `section_id` e `scuola_id` restano
 * in AND, e il gate di scope è già passato), ma farebbe ripartire QUESTA classe da
 * una posizione che non le appartiene, saltando in silenzio tutto ciò che sta
 * prima. Un salto silenzioso è esattamente il difetto contro cui questa route è
 * costruita: meglio un 400.
 *
 * ⚠️ IL PERIODO NON STA DENTRO, deliberatamente. Gli estremi viaggiano già nella
 * query e vengono validati a ogni richiesta, e il keyset è sempre in AND con loro:
 * un cursore di un'altra finestra non può far uscire una riga fuori periodo — al
 * massimo ne fa uscire meno. Legarcelo trasformerebbe in un 400 il caso legittimo
 * del docente che allarga il periodo all'indietro mentre sta scorrendo.
 */
const VERSIONE_CURSORE = 1

/**
 * 🔴 QUESTO SCHEMA È UN PRESIDIO DI SICUREZZA, non una formalità: i tre valori
 * finiscono DENTRO la stringa di `.or()` che si manda a PostgREST, dove la
 * virgola, il punto e le parentesi sono SINTASSI. Un `id` che contenesse
 * `,and(` non produrrebbe un errore: produrrebbe un albero logico diverso da
 * quello che il codice qui sotto crede di aver scritto, scelto da chi ha
 * fabbricato il cursore. Per questo `d` passa da `zDataYMD` (che è anche una
 * regex), `o` è un numero e `i` è vincolato all'alfabeto sotto.
 */
const zCursore = z.object({
  v: z.literal(VERSIONE_CURSORE),
  s: zUuid,
  d: zDataYMD,
  // Intero e basta: `registro_orario_ora_lezione_check` dice oggi 1..8, ma un
  // cursore che ribattesse quel vincolo comincerebbe a rifiutare posizioni
  // legittime il giorno in cui lo schema lo allarga — e il cursore lo abbiamo
  // emesso noi.
  o: z.number().int(),
  // ⚠️ NON `zUuid`, ed è una scelta. In produzione `registro_orario.id` È un
  // uuid e lo soddisferebbe — ma quello che va garantito qui non è il TIPO della
  // colonna (che può cambiare, e il giorno che cambiasse tutti i cursori in mano
  // ai client diventerebbero 400): è che nel filtro non entri un metacarattere.
  // Questo alfabeto lo dice, e dice perché.
  i: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
})

/** La posizione da cui riprende la lettura. */
type Posizione = { data: string; ora: number; id: string }

/**
 * Perché un cursore è stato rifiutato: entra nel log — sotto la chiave `tipo`, per
 * la ragione scritta accanto alla riga di `logEvento` — e mai nella risposta.
 */
type MotivoCursore = 'forma' | 'altra-sezione'

function scriviCursore(sezione: string, riga: { data: string; ora_lezione: number; id: string }): string {
  const corpo = JSON.stringify({ v: VERSIONE_CURSORE, s: sezione, d: riga.data, o: riga.ora_lezione, i: riga.id })
  return Buffer.from(corpo, 'utf8').toString('base64url')
}

/**
 * Il cursore ricevuto → una posizione, oppure il motivo del rifiuto.
 *
 * ⚠️ `Buffer.from(x, 'base64url')` NON LANCIA su spazzatura: scarta i caratteri
 * che non sono base64 e restituisce i byte che restano. Non è lui il presidio — lo
 * sono `JSON.parse` e `zCursore`, che su quei byte falliscono. Un cursore
 * inventato a mano non arriva a guidare nessuna lettura.
 */
function leggiCursore(grezzo: string, sezione: string): { posizione: Posizione } | { motivo: MotivoCursore } {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(grezzo, 'base64url').toString('utf8'))
  } catch {
    return { motivo: 'forma' }
  }
  const letto = zCursore.safeParse(json)
  if (!letto.success) return { motivo: 'forma' }
  if (letto.data.s !== sezione) return { motivo: 'altra-sezione' }
  return { posizione: { data: letto.data.d, ora: letto.data.o, id: letto.data.i } }
}

/** Una firma del registro, come esce dal join `firme_docenti(...)`. */
type FirmaRiga = { id: string; compiti_propri: string | null }

/**
 * Un destinatario dell'assegnazione mirata.
 *
 * ⚠️ `alunno_id` NON SI LEGGE NEMMENO, dal 2026-09-19. Serviva a contare quanti
 * bambini ha davanti un compito individualizzato, ma per contare basta
 * `firma_id`: l'indice UNIQUE `(registro_id, firma_id, alunno_id)` garantisce che
 * una coppia firma/alunno non si ripeta, quindi il conteggio per `firma_id` è già
 * esatto. In una route il cui punto dichiarato è «nessun uuid di alunno esce di
 * qui», leggerlo comunque lo teneva a un `...r` di distanza dal JSON: il modo più
 * economico di non farlo uscire è non chiederlo.
 */
type DestinatarioRiga = { firma_id: string }

/**
 * Un allegato come esce dal join `allegati_registro(...)`.
 *
 * `ambito` dice se il file era stato caricato per l'ARGOMENTO della lezione o per
 * i COMPITI: vedi il commento sulla `select`, dove sta la ragione per cui si
 * espone e NON si filtra.
 */
type AllegatoRiga = {
  id: string
  tipo: string | null
  ambito: string | null
  file_url: string | null
  file_name: string | null
  /** Cestino: valorizzato = eliminato. Letto solo per scartarlo (`allegatiRegistroViviDalJoin`). */
  eliminato_il?: string | null
}

/** Una riga di `registro_orario` con i suoi join. */
type RigaRegistro = {
  id: string
  data: string
  ora_lezione: number
  materia: string | null
  compiti: string | null
  data_consegna_compiti: string | null
  materie?: { nome?: string | null } | null
  firme_docenti?: FirmaRiga[] | null
  registro_destinatari?: DestinatarioRiga[] | null
  allegati_registro?: AllegatoRiga[] | null
}

/** Testo davvero scritto: `null`, `''` e `'   '` sono tutti «niente». */
function pieno(testo: string | null | undefined): boolean {
  return (testo ?? '').trim() !== ''
}

/**
 * Il primo testo DAVVERO SCRITTO fra quelli dati, o `null`.
 *
 * Esiste perché `??` non basta qui: è nullish, quindi una stringa VUOTA vince —
 * e `materie.nome` è `NOT NULL` ma senza `CHECK` (verificato in produzione il
 * 2026-09-19), cioè `''` è un valore permesso. Con `r.materie?.nome ?? r.materia`
 * una materia d'anagrafica svuotata per sbaglio nascondeva il nome storico della
 * riga e usciva come `""`: una materia senza nome, dove il nome c'era.
 * Il file aveva già `pieno()` per questa esatta distinzione e lo applicava ai
 * compiti quaranta righe più in là; qui mancava.
 */
function primoPieno(...testi: Array<string | null | undefined>): string | null {
  return testi.find((t) => pieno(t)) ?? null
}

/**
 * GET /api/primaria/compiti?sectionId=&dataDa=&dataA=&cursore=
 *
 * I compiti per casa di una classe in un periodo, A PAGINE: è la linguetta
 * «Compiti» del registro di classe (docente + segreteria).
 *
 * I compiti vivono in DUE posti e la vista li riunisce senza confonderli:
 *  · `registro_orario.compiti` — il compito di CLASSE, con la sua scadenza in
 *    `data_consegna_compiti`;
 *  · `firme_docenti.compiti_propri` — l'assegnazione MIRATA ad alcuni alunni
 *    (tipicamente il sostegno), che qui esce come testo + CONTEGGIO dei
 *    destinatari, mai coi nomi.
 *
 * Escono solo le ore che hanno davvero un compito: una lezione con il solo
 * `argomento` non è un compito, e in una lista di compiti sarebbe rumore.
 *
 * ═══ IL CONTRATTO DELLA PAGINAZIONE, per intero ═══════════════════════════════
 *
 * → `{ success: true, data: { compiti: [...], prossimoCursore: string | null } }`
 *
 *  · `prossimoCursore: null` significa UNA cosa sola e si può credere: **non c'è
 *    altro da leggere in questo periodo**. È l'unica promessa che questa route
 *    fa, ed è quella che tutto il resto serve a mantenere.
 *  · `prossimoCursore` valorizzato significa «c'è ancora finestra da leggere»: il
 *    client lo rimanda TALE E QUALE in `?cursore=` per avere il seguito, e NON lo
 *    interpreta.
 *  · 🔴 UNA PAGINA PUÒ ESSERE VUOTA CON IL CURSORE VALORIZZATO, ed è normale, non
 *    un guasto. La route pagina righe di REGISTRO e restituisce solo quelle che
 *    hanno un compito: `compiti: []` con un cursore vuol dire «in questo tratto di
 *    registro non era stato assegnato niente, continua a chiedere». Il client
 *    smette di chiedere quando arriva `null`, non quando arriva una pagina vuota.
 *    La route riduce da sola questo caso leggendo fino a `GIRI_MAX_PER_PAGINA`
 *    tratti prima di rispondere — ma non lo elimina, e il contratto lo dice invece
 *    di lasciarlo scoprire.
 *
 * `troncato` NON C'È PIÙ. Diceva «ti sto nascondendo la parte più vecchia»: accanto
 * a un cursore che dice «ce n'è ancora» sarebbero due verità per lo stesso fatto, e
 * quella vecchia sarebbe la meno vera delle due — perché adesso il resto non è
 * nascosto, è a una richiesta di distanza.
 *
 * ═══ PERCHÉ IL FILTRO DEI COMPITI NON SI PUÒ SPOSTARE NEL DATABASE ═════════════
 *
 * Sarebbe la via per non avere mai pagine vuote: far filtrare a PostgREST le righe
 * senza compiti. La condizione è `compiti` non vuoto **oppure** almeno una firma
 * con `compiti_propri` non vuoto — cioè un OR fra una colonna della riga e una
 * colonna di una risorsa EMBEDDED. PROVATO su PostgREST vero il 2026-09-19, non
 * dedotto:
 *
 *   GET /rest/v1/registro_orario?or=(compiti.not.is.null,firme_docenti.compiti_propri.not.is.null)
 *   → 400 PGRST100 «failed to parse logic tree» (unexpected "c" expecting "not" or operator)
 *
 * L'albero logico di `or=` conosce solo colonne della tabella principale. La forma
 * che funziona — `select=…,firme_docenti!inner(…)&firme_docenti.compiti_propri=not.is.null`
 * (provata: 200) — filtra il PADRE sull'embed, ma con un `!inner` e senza OR:
 * restituirebbe **solo** le righe con assegnazione mirata, buttando via quelle col
 * compito di classe, che sono la maggioranza. Metà dei compiti in cambio di zero
 * pagine vuote non è uno scambio.
 *
 * Filtrare in SQL il solo `compiti` non nullo, lasciando fuori `compiti_propri`,
 * sarebbe la perdita silenziosa in persona: oggi in produzione le firme con
 * `compiti_propri` valorizzato sono **0 su 101** (misurato il 2026-09-19), quindi
 * nessuno se ne accorgerebbe — fino al giorno in cui un'insegnante di sostegno
 * assegnasse la prima scheda facilitata e quella non comparisse a nessuno.
 */
export const GET = withRoute('primaria/compiti:GET', async (request: NextRequest) => {
  try {
    // Il gate PRIMA di `createAdminClient()`: dopo un 403 non deve partire
    // nemmeno una lettura. `createAdminClient` è service-role e scavalca la RLS,
    // quindi qui il gate applicativo è l'unico presidio che esista.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data
    const periodo = risolviPeriodo(q.data.dataDa, q.data.dataA)

    // ═══ I DUE RIFIUTI DEL PERIODO, PRIMA DEL CLIENT ═════════════════════════
    //
    // Stanno qui — dopo `parseQuery`, prima di `createAdminClient()` — perché un
    // intervallo impossibile o smisurato non deve far nascere nemmeno il client
    // service-role, e perché il motivo deve arrivare a chi legge: ciascuno porta
    // un `codice` dichiarato in `CODICI_ERRORE`, cioè una frase che esiste anche
    // in inglese.

    // Fine PRIMA dell'inizio. Senza questo la risposta sarebbe 200 con elenco
    // vuoto, e «in questo periodo non sono stati assegnati compiti» diventerebbe
    // indistinguibile da «il periodo che hai chiesto non esiste» — con la
    // differenza che nel secondo caso non c'è nessun periodo da riprovare.
    // Il controllo vale solo a estremo superiore DICHIARATO: con `dataA` assente
    // l'intervallo è aperto, e un `dataDa` nel futuro («i compiti da lunedì in
    // poi») è una domanda legittima, non un periodo rovesciato.
    if (periodo.a !== null && periodo.giorni < 0) {
      return NextResponse.json(
        {
          error: `Periodo rovesciato: la fine (${periodo.a}) viene prima dell'inizio (${periodo.da}).`,
          codice: 'PERIODO_ROVESCIATO',
        },
        { status: 400 },
      )
    }

    if (periodo.giorni > GIORNI_MAX_INTERVALLO) {
      return NextResponse.json(
        {
          error:
            `Periodo troppo lungo: al massimo ${GIORNI_MAX_INTERVALLO} giorni fra l'inizio e la fine ` +
            `(ne sono stati chiesti ${periodo.giorni}). Restringi l'intervallo.`,
          codice: 'PERIODO_TROPPO_LUNGO',
        },
        { status: 400 },
      )
    }

    // ═══ IL TERZO RIFIUTO: UN CURSORE CHE NON È NOSTRO ═══════════════════════
    //
    // Sta qui, accanto agli altri due e prima di `createAdminClient()`, per la
    // stessa ragione: un cursore che non si sa leggere non deve far nascere il
    // client service-role, e il motivo deve arrivare a chi legge.
    //
    // 🔴 400 E NON UN SILENZIO, e nemmeno un 500. Ignorare un cursore illeggibile
    // e ripartire dall'inizio sembra gentile ed è la cosa peggiore: il docente ha
    // in mano mezza lista, preme «carica altri» e ricomincia dal primo compito
    // senza che niente glielo dica. Un `catch` che diventa 500 è solo un difetto
    // con un'altra faccia.
    //
    // ⚠️ IL CODICE È `CORPO_NON_VALIDO`, RIUSATO, e va detto invece di lasciarlo
    // sembrare una svista. Un `CURSORE_NON_VALIDO` proprio andrebbe dichiarato in
    // `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`) e tradotto nei due cataloghi —
    // tre file che questo lavoro non tocca. `CORPO_NON_VALIDO` non è un ripiego
    // muto: la sua frase di catalogo è «La richiesta non è valida. Ricarica la
    // pagina e riprova» / «The request is not valid. Reload the page and try
    // again», che è ESATTAMENTE la via d'uscita di un cursore illeggibile —
    // ricominciare l'elenco. Il perché preciso (forma sbagliata o classe
    // sbagliata) resta nel log sotto la chiave `tipo`, e non a schermo, dove non
    // aiuterebbe nessuno. Che la chiave sia `tipo` e non `motivo` è la sola cosa
    // che rende vera questa frase: il perché sta nel commento sulla riga di log
    // qui sotto.
    let posizioneIniziale: Posizione | null = null
    if (q.data.cursore) {
      const letto = leggiCursore(q.data.cursore, sectionId)
      if ('motivo' in letto) {
        // `warn` e non `info`: se questa riga comincia a comparire in massa
        // significa che il client sta rimandando cursori che non è riuscito a
        // conservare, e la linguetta sta ricominciando l'elenco in faccia alle
        // maestre. Il cursore NON si logga: sarebbe testo libero arrivato da fuori.
        //
        // 🔴 LA CAUSA VA SU `tipo`, E FINO AL 2026-09-19 ANDAVA SU `motivo` — che
        // è una RADICE DI TESTO LIBERO in `@/lib/logging/redact`, quella che
        // difende il motivo dell'assenza, le note mediche e le allergie. Passata
        // dal redattore vero (cioè in `app_log`, che è l'unico posto dove questa
        // riga serve) usciva `"motivo":"[redatto:str/5]"` e
        // `"[redatto:str/13]"`: l'UNICO campo perso di tutta la route — `esito`,
        // `sezione`, `operazione`, `limite`, `n_giri`, `giorni`, `n_righe`,
        // `ultima`, `n_percorsi` e `giro` sopravvivono tutti — e per giunta
        // proprio quello su cui poggiava la frase «il perché resta nel log».
        // Restava distinguibile solo perché `forma` e `altra-sezione` hanno
        // lunghezze diverse: un accidente, che una terza causa qualunque
        // romperebbe.
        //
        // La correzione NON è aggiungere `motivo` alla lista bianca — quella
        // radice difende dati sanitari di minori, e AGENTS.md dice di
        // restringerla, non di allargarla. È mettere il valore su una chiave che
        // la lista bianca HA GIÀ: `tipo` è in `CHIAVI_IN_CHIARO`, e `'forma'` /
        // `'altra-sezione'` passano anche il controllo di forma (`FORMA_ENUMERATO`)
        // perché sono enumerati scritti da noi, non testo di qualcuno.
        //
        // E `esito` resta UNO (`cursore-non-valido`) invece di spaccarsi in
        // `…-forma` / `…-altra-sezione`: `esito` è la colonna su cui si contano i
        // rifiuti, e due valori avrebbero spostato il difetto dal campo perso
        // alla query che ne conta metà. La causa è una dimensione a parte, e sta
        // su un campo a parte.
        logEvento('registro', 'warn', {
          operazione: 'primaria/compiti:GET',
          esito: 'cursore-non-valido',
          sezione: sectionId,
          tipo: letto.motivo,
        })
        return NextResponse.json(
          {
            error: 'Il punto da cui riprendere non è valido: ricarica l’elenco dei compiti.',
            codice: 'CORPO_NON_VALIDO',
          },
          { status: 400 },
        )
      }
      posizioneIniziale = letto.posizione
    }

    const supabase = await createAdminClient()

    // Sede invalicabile + (per chi non vede tutte le classi) assegnazione.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // La SEDE della classe, che serve come secondo filtro della query qui sotto.
    //
    // ⚠️ È LA SECONDA VOLTA CHE SI LEGGE `sections` IN QUESTA RICHIESTA, e va
    // detto invece che lasciato scoprire: `assertSezioneInScope` fa già
    // `select('id, scuola_id').eq('id', …).maybeSingle()` sulla stessa riga, ma
    // NON la restituisce — torna `NextResponse | null`. La via d'uscita pulita
    // non è ricopiare la query: è far restituire al gate la sezione che ha già
    // letto (`{ sezione } | { response }`, come fa `parseQuery`), e allora questo
    // blocco sparisce. Tocca `@/lib/auth/scope` e i suoi ~40 chiamanti, cioè file
    // che non appartengono a questo lavoro. Finché resta, è una lettura per `id`
    // (una riga sola, indice primario) e non un elenco.
    const { data: sezione, error: sezioneErr } = await supabase
      .from('sections')
      .select('id, scuola_id')
      // ⚠️ Il filtro per `id` NON è ridondante: senza, `maybeSingle()` prende la
      // PRIMA riga di `sections` che capita — un'altra classe, di un altro
      // plesso — e da lì in poi tutta la query qui sotto filtrerebbe sulla sede
      // sbagliata, in silenzio e con un 200 in faccia.
      .eq('id', sectionId)
      .maybeSingle()
    // PostgREST non lancia: senza questo controllo un GUASTO di lettura uscirebbe
    // come 404 «Sezione non trovata», cioè un'affermazione su una riga che non si
    // è letta — e la sezione, un istante prima, il gate di scope l'aveva trovata.
    if (sezioneErr) {
      logEvento('registro', 'error', {
        operazione: 'primaria/compiti:GET', esito: 'sezione-non-risolta', sezione: sectionId,
      }, sezioneErr)
      return NextResponse.json(
        { error: 'Verifica della sezione non riuscita.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      )
    }
    if (!sezione?.scuola_id) {
      return NextResponse.json({ error: 'Sezione non trovata', codice: 'SEZIONE_NON_TROVATA' }, { status: 404 })
    }

    // ═══ SEZIONE **E** SEDE, NELLA STESSA QUERY ══════════════════════════════
    //
    // Non è una cintura sopra le bretelle: le sedi di produzione sono tre, il
    // client è service-role, e l'AND fra i due filtri è l'unico posto in cui
    // «questa classe» e «questo plesso» diventano una condizione sola. Un filtro
    // che manca non fa fallire niente — restituisce solo più righe del dovuto, in
    // silenzio — ed è la forma esatta del difetto che il lock
    // `isolamento-sede-coverage` cerca.
    //
    // ─── PERCHÉ `allegati_registro.ambito` SI ESPONE E NON SI FILTRA ──────────
    //
    // `ambito` distingue il file caricato per l'ARGOMENTO della lezione da quello
    // caricato per i COMPITI. Senza, la linguetta «Compiti» mostrerebbe la foto
    // della lavagna dell'argomento senza dirlo — un allegato che non è quello che
    // il bambino deve fare a casa, presentato come se lo fosse.
    //
    // 🔴 MA UN FILTRO `ambito === 'compiti'` QUI SAREBBE PEGGIO DEL DIFETTO.
    // Misurato in produzione il 2026-09-19: `allegati_registro` ha ZERO righe, e
    // l'unico punto dell'app che carica (`teacher/primaria/[sectionId]/registro`)
    // non manda mai `ambito`, che in `primaria/allegati:POST` ha
    // `.default('argomento')`. Filtrare renderebbe la lista degli allegati VUOTA
    // PER SEMPRE, in silenzio — e con zero righe in tabella non se ne accorgerebbe
    // nessuno per mesi, esattamente come per le email che rispondevano 403.
    // Il campo si espone; a etichettarlo («foto dell'argomento») è la linguetta,
    // che così mostra tutto e dice che cos'è. Chi un domani vorrà filtrare
    // cominci dal caricatore, non da qui.
    //
    // ─── IL KEYSET, E PERCHÉ NON `offset` ────────────────────────────────────
    //
    // `offset` conta le righe dall'inizio: basta che qualcuno firmi un'ora mentre
    // il docente sta scorrendo e la finestra scivola — una riga ripetuta, o una
    // saltata, senza nessun segnale. Il keyset dice «più vecchia di QUESTA
    // posizione», e resta vero qualunque cosa venga scritta dopo. È la stessa
    // scelta, con la stessa forma, di `chat/messages:GET` («carica messaggi
    // precedenti»).
    //
    // ⚠️ LO SPAREGGIO SULL'`id` NON È UN DI PIÙ. Con il solo `(data, ora_lezione)`
    // il keyset presume che quella coppia sia unica per classe: se due righe la
    // condividessero e cadessero sul confine di pagina, la seconda non starebbe
    // nella pagina di prima (non è «maggiore») e non entrerebbe in quella dopo —
    // sparirebbe. Oggi la coppia è unica in produzione (misurato il 2026-09-19:
    // zero gruppi con più di una riga su `(section_id, scuola_id, data,
    // ora_lezione)`), e c'è anche un indice che la protegge —
    // `uidx_registro_orario_chiave (scuola_id, classe_sezione, data, ora_lezione)
    // NULLS NOT DISTINCT` — ma è un indice su `classe_sezione`, non su
    // `section_id`: garantisce quasi la nostra chiave, non la nostra chiave. Un
    // ordine TOTALE non costa niente e non dipende da quella quasi-coincidenza.
    //
    // L'ordinamento resta quello di prima — `data DESC, ora_lezione ASC` — con
    // `id ASC` solo come terzo criterio: a schermo non cambia niente, perché
    // decide unicamente fra righe che sarebbero comunque uscite in ordine casuale.
    //
    // ⚠️ La data va fra VIRGOLETTE dentro `.or()`: nella sintassi di PostgREST il
    // punto è un separatore, e una stringa non quotata che ne contenesse uno
    // spezzerebbe l'albero logico. Una `YYYY-MM-DD` non ne ha, ma la regola sì.
    const leggiTratto = async (da: Posizione | null) => {
      let query = supabase
        .from('registro_orario')
        .select(`
          id, data, ora_lezione, materia, compiti, data_consegna_compiti,
          materie(nome),
          firme_docenti(id, compiti_propri),
          registro_destinatari(firma_id),
          allegati_registro(id, ambito, tipo, file_url, file_name, eliminato_il)
        `)
        .eq('section_id', sectionId)
        .eq('scuola_id', sezione.scuola_id)
        .gte('data', periodo.da)
      // Estremo superiore INCLUSIVO, e solo se dichiarato: senza `dataA` la vista
      // arriva anche ai compiti assegnati per i giorni che verranno.
      if (periodo.a) query = query.lte('data', periodo.a)
      if (da) {
        const giorno = `"${da.data}"`
        query = query.or(
          `data.lt.${giorno},` +
          `and(data.eq.${giorno},ora_lezione.gt.${da.ora}),` +
          `and(data.eq.${giorno},ora_lezione.eq.${da.ora},id.gt.${da.id})`,
        )
      }
      return await query
        .order('data', { ascending: false })
        .order('ora_lezione', { ascending: true })
        .order('id', { ascending: true })
        .limit(RIGHE_PER_PAGINA)
    }

    /** Un'ora entra nell'elenco se ha il compito di CLASSE oppure almeno
     *  un'assegnazione mirata. La lezione col solo `argomento` resta fuori. */
    const haCompiti = (r: RigaRegistro) =>
      pieno(r.compiti) || (r.firme_docenti ?? []).some((f) => pieno(f.compiti_propri))

    // ─── IL CICLO, E LA SUA CONDIZIONE DI FINE ───────────────────────────────
    //
    // 🔴 `prossimoCursore: null` SI DICE SOLO QUANDO LA FINESTRA È FINITA, e la
    // finestra è finita quando una lettura torna con MENO righe di quante ne siano
    // state chieste. Non «quando non ho trovato compiti», che è la scorciatoia che
    // produce la perdita silenziosa: un tratto di registro senza compiti non dice
    // niente su quelli più vecchi. Non si guarda nemmeno la lunghezza dell'elenco
    // restituito, che è un'altra grandezza.
    //
    // Il prezzo di questa asimmetria è una pagina finale vuota: con esattamente
    // 300 righe nell'ultimo tratto il cursore esce valorizzato e la richiesta dopo
    // torna `{ compiti: [], prossimoCursore: null }`. Una richiesta in più contro
    // una riga persa: si sbaglia da questa parte.
    const conCompiti: RigaRegistro[] = []
    let posizione = posizioneIniziale
    let prossimoCursore: string | null = null

    for (let giro = 0; giro < GIRI_MAX_PER_PAGINA; giro++) {
      const { data: righe, error: righeErr } = await leggiTratto(posizione)

      // PostgREST non lancia: un `{ error }` scartato qui uscirebbe come elenco
      // vuoto dentro un 200 — cioè «in questo periodo non sono stati assegnati
      // compiti», che è una frase diversa da «non sono riuscito a leggerli» e che a
      // un genitore che chiede conto verrebbe ripetuta in buona fede.
      if (righeErr) {
        logEvento('registro', 'error', {
          operazione: 'primaria/compiti:GET', esito: 'compiti-non-letti', sezione: sectionId, giro,
        }, righeErr)
        return NextResponse.json(
          { error: 'Non siamo riusciti a leggere i compiti della classe.', codice: 'LETTURA_FALLITA' },
          { status: 500 },
        )
      }

      // Gli allegati nel CESTINO non escono: si scartano QUI, prima che qualunque
      // passo successivo (la firma dei link compresa) li veda.
      const lette = ((righe ?? []) as unknown as RigaRegistro[]).map((r) => ({
        ...r,
        allegati_registro: allegatiRegistroViviDalJoin(r.allegati_registro),
      }))
      conCompiti.push(...lette.filter(haCompiti))

      const ultima = lette[lette.length - 1]
      if (lette.length < RIGHE_PER_PAGINA || !ultima) {
        prossimoCursore = null
        break
      }
      prossimoCursore = scriviCursore(sectionId, ultima)
      if (conCompiti.length > 0) break
      posizione = { data: ultima.data, ora: ultima.ora_lezione, id: ultima.id }
    }

    if (conCompiti.length === 0 && prossimoCursore !== null) {
      // Il tetto dei giri ha morso: la risposta è legittima e il contratto la
      // prevede, ma è anche l'unico caso in cui il client deve fare un giro in più
      // per vedere qualcosa. `warn` e non `info` perché si persiste PER LIVELLO:
      // senza questa riga nessuno saprebbe MAI quante classi hanno tratti di
      // registro più lunghi di `GIRI_MAX_PER_PAGINA × RIGHE_PER_PAGINA` senza un
      // compito — che è l'informazione da cui si decide se alzare il tetto.
      logEvento('registro', 'warn', {
        operazione: 'primaria/compiti:GET',
        esito: 'pagina-senza-compiti',
        sezione: sectionId,
        limite: RIGHE_PER_PAGINA,
        n_giri: GIRI_MAX_PER_PAGINA,
        giorni: periodo.giorni,
      })
    }

    if (posizioneIniziale) {
      // Il SUCCESSO di «carica i compiti precedenti»: `withRoute` non persiste i
      // 2xx, e senza questa riga «nessun log» non distinguerebbe «nessuno usa la
      // paginazione» da «la paginazione non funziona». Solo con il cursore: la
      // prima pagina è anche l'apertura della linguetta, e scriverebbe una riga a
      // ogni visita. Stessa scelta, per la stessa ragione, di `chat/messages:GET`.
      logEvento('registro', 'info', {
        operazione: 'primaria/compiti:GET',
        esito: 'pagina-successiva',
        sezione: sectionId,
        n_righe: conCompiti.length,
        ultima: prossimoCursore === null,
      })
    }

    // ─── GLI ALLEGATI SI FIRMANO IN BLOCCO ───────────────────────────────────
    //
    // Una chiamata allo Storage per pagina, non una per allegato, con la stessa
    // funzione di galleria, avvisi, incarichi e chat: stesso TTL, stesso log col
    // corpo dell'errore del provider, stessa gestione del fallimento. Il percorso
    // si calcola UNA volta per allegato e si riusa: la funzione che decide che
    // cosa firmare dev'essere la stessa che decide che cosa sostituire.
    //
    // Si firmano solo gli allegati delle righe che ESCONO: le altre non le vedrà
    // nessuno, e firmarle sarebbe lavoro (e link vivi) per niente.
    const percorsoPerAllegato = new Map<string, string | null>()
    for (const r of conCompiti) {
      for (const a of r.allegati_registro ?? []) {
        percorsoPerAllegato.set(a.id, percorsoNelBucket(BUCKET_REGISTRO_ALLEGATI, a.file_url))
      }
    }
    const percorsi = [...new Set([...percorsoPerAllegato.values()].filter((p): p is string => p !== null))]

    // ─── QUANTI PERCORSI VANNO ALLO STORAGE, E PERCHÉ NON SONO 300 ───────────
    //
    // ⚠️ RIMISURATO IL 2026-09-19, perché la misura dichiarata era FALSA. Il
    // commento del tetto diceva «al massimo N percorsi in una sola
    // `createSignedUrls`»: il tetto è sulle RIGHE, e ogni riga porta N allegati.
    // I percorsi sono `RIGHE_PER_PAGINA × allegati per riga`, e il secondo fattore
    // NON HA TETTO: `primaria/allegati:POST` limita solo la DIMENSIONE del file
    // (10 MB per un PDF, 3 MB per un'immagine), mai il NUMERO di allegati per
    // `registro_id` — nessun conteggio, nessun `.limit()`, nessun vincolo in
    // tabella. 300 righe con due allegati ciascuna fanno 600 percorsi da ~71 caratteri
    // (`registro/<uuid>/<timestamp>-<rnd>.jpg`), cioè **~44 KB** di JSON in una
    // sola POST — 600 × ~74 byte a voce, virgolette e virgole comprese.
    // ⚠️ Qui c'era scritto «~120 KB»: sbagliato di un fattore 2,7, e proprio
    // nella frase che rimprovera «una misura scritta con sicurezza e mai
    // rifatta» — cioè la stessa forma del difetto corretto in testa a questo
    // file («E NON SONO QUATTRO»). Rifatta il 2026-09-19: i 71 caratteri sono
    // giusti (9 + 36 di uuid + 1 + 13 di epoch + 1 + 7 + 1 + 3 di estensione),
    // era il salto da caratteri a kilobyte a non tornare.
    //
    // Oggi non rompe niente — `SELECT count(*) FROM allegati_registro` → 0 righe,
    // misurato il 2026-09-19 — e un TETTO sui percorsi NON si mette: tagliare
    // l'elenco farebbe uscire gli allegati oltre il taglio con `file_url: null`,
    // cioè indistinguibili da un guasto dello Storage. Sarebbe la perdita
    // silenziosa contro cui è costruita tutta questa route, introdotta per evitare
    // una POST grande. Spezzare in blocchi è la risposta giusta, ma la casa è
    // `firmaPercorsi` (`@/lib/allegati/storage`), che ha cinque chiamanti: farlo
    // qui sarebbe una sesta forma da tenere allineata.
    //
    // Quindi si DICHIARA e si MISURA: oltre `RIGHE_PER_PAGINA` percorsi — il punto
    // esatto in cui l'ipotesi «al massimo un allegato per riga» smette di valere —
    // parte una riga a `warn`. È l'informazione da cui si deciderà se spezzare, la
    // stessa logica di `pagina-senza-compiti`: senza, il giorno in cui succedesse
    // non lo saprebbe nessuno.
    if (percorsi.length > RIGHE_PER_PAGINA) {
      logEvento('storage', 'warn', {
        operazione: 'primaria/compiti:GET',
        esito: 'firme-oltre-la-stima',
        n_percorsi: percorsi.length,
        n_righe: conCompiti.length,
        limite: RIGHE_PER_PAGINA,
      })
    }

    // Con l'elenco vuoto `firmaPercorsi` non tocca lo Storage: una classe senza
    // allegati non paga niente.
    const urlFirmato = await firmaPercorsi(supabase, BUCKET_REGISTRO_ALLEGATI, percorsi, 'primaria/compiti:GET')

    const compiti = conCompiti.map((r) => {
      const destinatari = r.registro_destinatari ?? []
      return {
        id: r.id,
        data: r.data,
        ora_lezione: r.ora_lezione,
        // La materia dell'anagrafica vince su quella scritta a mano nella riga,
        // che è il campo storico rimasto sulle righe più vecchie — ma vince solo
        // se c'è davvero: `primoPieno` e non `??`, perché `materie.nome` accetta
        // la stringa vuota e un `??` la farebbe vincere sul testo storico.
        materia: primoPieno(r.materie?.nome, r.materia),
        compiti: r.compiti ?? null,
        data_consegna_compiti: r.data_consegna_compiti ?? null,
        // Chi non si è potuto firmare esce con `file_url: null` — MAI il percorso
        // grezzo, che come indirizzo non funziona lo stesso e maschererebbe un
        // guasto dello Storage da «allegato rotto».
        allegati: (r.allegati_registro ?? []).map((a) => {
          const p = percorsoPerAllegato.get(a.id) ?? null
          return {
            id: a.id,
            tipo: a.tipo,
            // Allargamento DICHIARATO del contratto (2026-09-19): senza, la
            // linguetta non può distinguere la foto dell'argomento da quella dei
            // compiti, e le mostra come se fossero la stessa cosa.
            ambito: a.ambito ?? null,
            file_name: a.file_name,
            file_url: p === null ? null : (urlFirmato.get(p) ?? null),
          }
        }),
        // Solo il TESTO e il CONTEGGIO: nomi e uuid dei bambini restano nel
        // database. Chi deve sapere a chi è andato cosa apre quella singola ora
        // nel registro, dove il gate è lo stesso ma la domanda è un'altra.
        individualizzati: (r.firme_docenti ?? [])
          .filter((f) => pieno(f.compiti_propri))
          .map((f) => ({
            compiti: f.compiti_propri ?? '',
            destinatari: destinatari.filter((d) => d.firma_id === f.id).length,
          })),
      }
    })

    return NextResponse.json({ success: true, data: { compiti, prossimoCursore } })
  } catch (err) {
    logErrore({ operazione: 'primaria/compiti:GET', stato: 500 }, err)
    // Il `message` dell'eccezione NON esce verso il docente: quello di PostgREST
    // riecheggia filtri e nomi di colonna. Resta nel log, intero, che è dove dice
    // perché.
    return NextResponse.json(
      { error: 'Non siamo riusciti a leggere i compiti della classe.', codice: 'LETTURA_FALLITA' },
      { status: 500 },
    )
  }
})
