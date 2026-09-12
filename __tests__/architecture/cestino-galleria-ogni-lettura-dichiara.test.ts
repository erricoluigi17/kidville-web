import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — OGNI LETTURA DI `galleria_media_v2` DICHIARA COSA FA DEL CESTINO.
 *
 * ─── Il guasto che questo lock esiste per impedire ───────────────────────────
 *
 * Dal 2026-09-11 `galleria_media_v2` ha tre colonne di cestino: «Elimina» non
 * distrugge più, NASCONDE, e distrugge dopo 30 giorni. La policy RLS del genitore
 * porta `eliminato_il IS NULL` come prima condizione — ma quasi tutte le letture
 * di questo repo passano dal **service-role**, che la RLS non la incontra
 * nemmeno. Là il filtro va scritto nella query, e il rischio numero uno è
 * banale e totale: **basta UNA lettura dimenticata perché una foto eliminata
 * riappaia**. Non con un errore, non con un 500: riappare, e nessuno lo sa.
 *
 * Un lock che guardasse il file, l'import o «c'è un `.is('eliminato_il', null)`
 * da qualche parte nell'handler» non servirebbe: le occorrenze sono in `src/` a
 * gruppi, spesso quattro nella stessa funzione, e un filtro «da qualche parte»
 * non è un filtro. La granularità qui è **la singola query**.
 *
 * ─── PERCHÉ NON È UN LOCK «FILTRA SEMPRE» ────────────────────────────────────
 *
 * Perché «filtra sempre» sarebbe un DIFETTO, non una protezione, e si vede su un
 * percorso solo: il diritto all'oblio. Se `obliaFotoAlunno` filtrasse le sole
 * foto vive, una foto nel cestino **sopravviverebbe alla cancellazione chiesta da
 * una famiglia** — riga in tabella, file nel bucket per i 30 giorni della purga,
 * e `spazio_liberato_il` scritto comunque: un «fatto» falso accanto al nome di un
 * bambino, su un gesto che non ha un annulla. Stessa cosa per il preventivo che la
 * Direzione conferma (`cosa-distrugge.ts`): se annunciasse MENO di quanto
 * l'esecuzione distrugge, il sì sarebbe dato a una cosa diversa da quella letta.
 *
 * Quindi il lock non pretende un filtro: pretende una **dichiarazione**. Tre
 * versi, tre funzioni, tutte in `src/lib/gallery/cestino.ts`:
 *
 *   · `soloVive(q)`            — le sole foto vive (il verso di quasi tutto)
 *   · `soloNelCestino(q, …)`   — il cestino, e solo ciò che è ripristinabile
 *   · `ancheNelCestino(q, motivo)` — l'IDENTITÀ, ma con l'obbligo di scrivere
 *                                perché. È il pezzo che rende il lock una
 *                                decisione invece di un automatismo.
 *   · `leggiVive(costruisci, op)` — `soloVive` più il degrado per il DB E2E della
 *                                CI, che non è migrato: là `eliminato_il` non
 *                                esiste, `42703`, e un filtro senza via d'uscita
 *                                non «mostrerebbe meno»: spegnerebbe la galleria.
 *
 * Sono quattro nomi e non tre perché il quarto è il terzo *con il degrado*: vivono
 * tutti nello stesso modulo, e nominare la regola vuol dire nominare uno di essi.
 *
 * ─── COME MISURA, E PERCHÉ NON È UNA `grep` ──────────────────────────────────
 *
 * Una `grep` per riga sbaglierebbe nei due versi opposti: conterebbe le
 * occorrenze dentro i COMMENTI (in questo repo ce ne sono, scritte apposta per
 * spiegare i difetti chiusi) e perderebbe le catene spezzate su otto righe, che
 * sono la forma normale qui dentro. Quindi si usa `mascheraSorgente` (commenti
 * spenti, indici invariati) e `fineCatena` (l'unità con cui PostgREST costruisce
 * una query), come gli altri sei lock di forma.
 *
 * Per ogni occorrenza si guardano DUE posti, e non uno:
 *   1. la CATENA — `.from(…).select(…).eq(…)`: un `soloVive` applicato in mezzo;
 *   2. i WRAPPER che la avvolgono, risalendo all'indietro attraverso `await`,
 *      le parentesi e le funzioni-thunk (`leggiVive((vive) => vive(q)…)`).
 * Il secondo posto è necessario perché queste funzioni *prendono* la query e la
 * restituiscono: stanno PRIMA di `.from(`, non dentro la catena.
 *
 * Deliberatamente NON si guarda «da qualche parte nella funzione»: è la regola
 * che rende il lock cieco. Un marcatore su una query vicina non copre questa.
 *
 * ─── E `leggiVive` NON BASTA CHE SIA NOMINATO: IL FILTRO VA APPLICATO ─────────
 *
 * Questo lock, al primo giro, è stato BOCCIATO proprio qui — e la bocciatura era
 * giusta. `leggiVive` riceve un THUNK e gli passa il filtro come parametro:
 *
 *     leggiVive((vive) => vive(supabase.from('galleria_media_v2')…)…, 'op')
 *
 * Il riconoscitore risaliva i wrapper, trovava il nome `leggiVive` e si fermava
 * lì. Ma il nome è il contenitore, non il filtro: basta togliere il parametro —
 *
 *     leggiVive(() => (supabase.from('galleria_media_v2')…)…, 'op')
 *
 * — e il filtro del cestino SPARISCE mentre il lock resta verde. Misurato il
 * 2026-09-12 su `tasks:GET`: lock 7/7 PASSED, `eslint` 0, `tsc` muto, e tutti i
 * test di `tasks` verdi. Cioè esattamente il guasto che questo file esiste per
 * impedire, con il gate verde — la stessa famiglia del lock che «cercava la
 * presenza della chiamata ed era cieco al ramo», già pagata in questo repo.
 *
 * Quindi su `leggiVive` si guardano DUE cose: il nome del parametro del thunk, e
 * che QUELLA query sia avvolta da lui. Non «che il parametro compaia nel corpo»:
 * avvolta, perché un thunk con due query dentro ne può filtrare una e dimenticare
 * l'altra, e il lock misura la singola query.
 *
 * ─── IL PERIMETRO, DETTO PRIMA CHE QUALCUNO LO DIA PER TOTALE ─────────────────
 *
 * Questo lock scandisce `src/`, e `src/` non è tutto ciò che tocca la tabella.
 * Misurato in produzione il 2026-09-12 (sola lettura, su `pg_class`/`pg_proc`):
 *  · NESSUNA vista né vista materializzata legge `galleria_media_v2` — quindi non
 *    esiste una lettura «di comodo» che aggiri il filtro dal lato database;
 *  · UNA funzione la scrive: il trigger `public.propaga_rinomina_sezione`, che
 *    quando una sezione viene rinominata riscrive `target_classes` su questa
 *    tabella (più altre cinque) senza guardare `eliminato_il`.
 *
 * Quel trigger **non è un difetto, ed è il verso giusto**: se salta le righe nel
 * cestino, una foto ripristinata entro i 30 giorni torna con il nome VECCHIO della
 * classe, che non corrisponde più a nessuna sezione — cioè riappare invisibile.
 * Vale la pena scriverlo qui perché un lock che copre il 100% del codice
 * applicativo non copre il 100% del sistema, e credere il contrario è il modo in
 * cui si smette di guardare. Quando un domani si aggiungerà una vista o un'altra
 * funzione, la sua decisione sul cestino andrà presa **nella migrazione**: questo
 * file non la vedrà mai.
 *
 * ─── E IL PERIMETRO HA UN LOCK GEMELLO, CON CUI QUESTO È IN CONFLITTO ─────────
 *
 * Il paragrafo qui sopra parlava di viste e di trigger e taceva sull'unica cosa che
 * questo lock ha davvero ROTTO, che non è nel database ed è a due file di distanza:
 * **`__tests__/architecture/isolamento-sede-coverage.test.ts`**.
 *
 * La forma che questo lock pretende — il marcatore come wrapper immediatamente a
 * monte di `.from(` — è la forma che il riconoscitore di quel lock non attraversa.
 * `unitaDiQuery` attacca a una query le sue CONTINUAZIONI (`if (conScuola) query =
 * query.in('scuola_id', plessi)`) solo quando riesce a leggere il nome della
 * variabile, e lo cerca con `(const|let|var) X = <ricevitore>` *immediatamente*
 * prima di `.from(` (isolamento-sede-coverage.test.ts:266-272). Un wrapper si
 * infila proprio in quel punto: il nome non si legge più, le continuazioni non si
 * attaccano, e **il filtro di sede che arriva per continuazione diventa
 * invisibile**.
 *
 * Misurato il 2026-09-12 eseguendo `unitaDiQuery` sulle due versioni di
 * `src/app/api/gallery/route.ts`, non dedotto:
 *   · a HEAD la query di `buildMedia` era UNA unità (riga 382), `risultati=[query]`,
 *     `conSede=true`;
 *   · nell'albero le sue tre copie (righe 444/448/449, avvolte una per verso) sono
 *     tre unità, `risultati=[]`, `conSede=false` — e `isolamento-sede-coverage`
 *     grida `elenco-senza-sede` tre volte su `gallery:GET`.
 * La triplicazione non è un capriccio: **è questo lock a pretenderla**, perché
 * misura la SINGOLA query (vedi il commento a gallery/route.ts:436-441).
 *
 * I due lock sono in **conflitto strutturale**: questo vuole il marcatore fra
 * `let X =` e il ricevitore, `unitaDiQuery` vuole `let X =` attaccato al ricevitore.
 * Quando il filtro di sede arriva per continuazione, le due richieste si escludono.
 * Le due uscite, e nessuna è una voce in `AMMESSE` di là:
 *   1. portare `.in('scuola_id', plessi)` DENTRO la catena di `.from(`, così
 *      `conSede` è vero qualunque wrapper ci sia (per `gallery:GET` si può: il
 *      commento del file dichiara il filtro di sede «incondizionato», e il
 *      `conScuola=false` esiste solo per il degrado su colonna assente);
 *   2. insegnare a `unitaDiQuery` ad attraversare una chiamata-wrapper.
 * Una voce in `AMMESSE` su `gallery:GET`, invece, metterebbe **l'elenco delle foto
 * dei bambini delle tre sedi** fuori dal lock di isolamento per sempre — cioè
 * esattamente ciò che il blocco su AMMESSE qui sotto argomenta di non fare.
 *
 * ⚠️ La cecità è FAIL-CLOSED, e va detto perché è l'unica ragione per cui questa
 * forma resta: perdere la variabile fa perdere le continuazioni (`conSede` può solo
 * passare da vero a falso), i `risultati` (`suRigaVerificata` → falso) e gli usi in
 * coda (`.maybeSingle()`, quindi `singola` → falso). Tutte e tre spingono verso PIÙ
 * rilievi, mai meno: un avvolgimento **non può spegnere** un rilievo di isolamento
 * che c'era. Misurato sui sei file di lettura: `scoperte()` ne conta le stesse a
 * HEAD e nell'albero (1→1, 0→0, 1→1, 22→22, 2→2, 3→3).
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

/** I quattro nomi che dichiarano la regola. Vivono tutti in `src/lib/gallery/cestino.ts`. */
const MARCATORI = ['soloVive', 'soloNelCestino', 'ancheNelCestino', 'leggiVive'] as const

/** `from('galleria_media_v2')`, con o senza spazi, apici singoli o doppi. */
const DA_TABELLA = /\bfrom\s*\(\s*['"]galleria_media_v2['"]\s*\)/g

/** Il modulo dove la regola vive. Non è sorvegliato da sé stesso. */
const MODULO = 'src/lib/gallery/cestino.ts'

/**
 * L'`import` NOMINATO da questo modulo, in qualunque forma di specificatore
 * (`@/lib/gallery/cestino`, `./cestino`, `../gallery/cestino`).
 *
 * ⚠️ SERVE PERCHÉ UN MARCATORE È UN NOME, E UN NOME SI PUÒ OMONIMARE. Senza questo
 * controllo il lock guardava la stringa e non la provenienza: misurato il
 * 2026-09-12 aggiungendo in un file di `src/` un
 *
 *     function soloVive<T>(q: T): T { return q }
 *
 * locale e usandolo come wrapper — l'occorrenza è stata contata **COPERTA** («2
 * coperte e 0 scoperte»), ed è diventata rossa solo per `COPERTI_ATTESI`, che è un
 * contatore esatto e vive per 7 file su 8. È la stessa famiglia della bocciatura del
 * primo giro («il nome è il contenitore, non il filtro»): chiusa per `leggiVive`,
 * era rimasta aperta per gli altri tre nomi. Tre righe la chiudono per tutti.
 *
 * ⚠️ Di proposito NON riconosce `import * as cestino from …` + `cestino.soloVive(…)`:
 * quella forma non è in uso nel repo, e un riconoscitore che non capisce deve dire
 * «scoperta», non «va bene». Se un giorno servirà, si allarga QUI — non si toglie la
 * prova.
 */
const IMPORT_MODULO = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*gallery\/cestino(?:\.[jt]s)?['"]/g

/**
 * I nomi che QUEL file importa dal modulo della regola, **senza alias**.
 *
 * Un `as` non viene contato, in nessuno dei due versi, e il verso che conta è il
 * secondo: `ancheNelCestino as soloVive` scriverebbe `soloVive(…)` nel sorgente
 * mentre la funzione applicata è l'identità — il marcatore direbbe «filtro» e non
 * ci sarebbe alcun filtro. Nessuno lo fa, e resta impossibile perché costa una
 * condizione.
 */
function marcatoriImportati(senzaCommenti: string): Set<string> {
    const nomi = new Set<string>()
    IMPORT_MODULO.lastIndex = 0
    for (const m of senzaCommenti.matchAll(IMPORT_MODULO)) {
        for (const pezzo of m[1].split(',')) {
            const nudo = pezzo.replace(/\btype\b/, '').trim()
            if (nudo && /^[A-Za-z_$][\w$]*$/.test(nudo)) nomi.add(nudo)
        }
    }
    return nomi
}

/**
 * Il testo che l'utente LEGGE nel dialogo di eliminazione, e i file che lo portano.
 *
 * ⚠️ QUESTA È L'UNICA COPIA DEI 30 GIORNI CHE NON PUÒ IMPORTARE LA COSTANTE.
 * Un file di messaggi è JSON: il numero ci sta scritto a mano, due volte nella
 * stessa frase («entro 30 giorni … passati i 30 giorni»). La duplicazione non si
 * può togliere, quindi si rende RUMOROSA — il giorno in cui qualcuno porta
 * `GIORNI_CESTINO_GALLERIA` a 15 e lascia «30 giorni» sullo schermo, questo lock
 * diventa rosso invece di tacere.
 *
 * Non è un'ipotesi di scuola: la prima stesura del commento sulla costante
 * sosteneva che il testo dell'utente venisse da lì. Non era vero, e un commento
 * che promette un presidio inesistente è peggio di nessun commento.
 */
const MESSAGGI_UTENTE = ['messages/it/shared.json', 'messages/en/shared.json']
const CHIAVE_RIPRISTINO = 'galleryEliminaRipristino'

/**
 * Quante caratteri deve avere la ragione di una deroga. Sessanta è la stessa
 * soglia dell'allowlist: una riga che non arriva a sessanta caratteri non è una
 * ragione, è un'etichetta — e un'etichetta non si può contestare fra sei mesi.
 */
const RAGIONE_MINIMA = 60

// ─────────────────────────────────────────────────────────────────────────────
// L'ALLOWLIST — una voce, e il conteggio ESATTO delle occorrenze scoperte
// ─────────────────────────────────────────────────────────────────────────────

interface VoceAmmessa {
    file: string
    /** Quante occorrenze, in quel file, sono ancora SENZA dichiarazione. Esatto. */
    scoperte: number
    ragione: string
}

/**
 * ⚠️ IL CONTEGGIO È ESATTO, NON UN TETTO PER FILE, e la differenza è il punto.
 *
 * Se fosse un tetto (`<=`), il giorno in cui un ramo ne copre la metà il lock
 * resterebbe verde col numero vecchio e nessuno lo saprebbe: le query rimaste
 * resterebbero fuori dal lock **per sempre**, col gate verde. È esattamente il modo
 * in cui un lock diventa decorazione — e in questo repo è già successo, su un tetto
 * di `<=` che due rami paralleli hanno lasciato più largo del vero.
 *
 * (Qui non c'è un intero d'esempio di proposito: la prima stesura di questo
 * commento ne aveva due, «nove» e «scoperte: 9», e **erano sbagliati** — quel file
 * di letture ne aveva 11. Un numero in un commento invecchia da solo, e in questo
 * repo un documento che spaccia una misura vecchia per un fatto è il difetto di cui
 * `CLAUDE.md` è il monumento.)
 *
 * Con l'uguaglianza, appena una query viene coperta il lock diventa ROSSO e dice
 * «abbassa il numero». L'allowlist può solo rimpicciolirsi, come quella dei catch
 * muti, e `MAX_SCOPERTE` scende con lei.
 */
const AMMESSE: VoceAmmessa[] = []

/**
 * ⚠️ L'ALLOWLIST È VUOTA, E LA SCELTA VA MOTIVATA — perché la via facile c'era.
 *
 * `src/app/api/gallery/route.ts` è il file del cestino stesso (GET elenca, DELETE
 * nasconde, PATCH ripristina) ed è quello che pesa: **11 letture di questa tabella
 * su 20 in tutto `src/`** (misurato il 2026-09-12 col riconoscitore di questo
 * stesso file, non con una `grep`: il letterale compare 15 volte, quattro delle
 * quali in commenti). Quando questo lock è nato, quel file era in lavorazione su un
 * altro ramo dello stesso branch — di un altro agente, che chi scriveva il lock non
 * poteva toccare. La via facile era una voce «in corso su altro ramo, scoperte: 9».
 * È stata scritta, provata, e poi TOLTA, per due ragioni misurate e non supposte:
 *
 *  1. **Era già falsa quando è stata scritta**, e in due modi. Fra il conteggio e
 *     il lancio del lock il file era passato da 9 scoperte a 8 (l'altro ramo aveva
 *     importato questo modulo e coperto la prima query); e quel «9» non era nemmeno
 *     il numero di letture del file, che erano **11**. Un numero che invecchia in
 *     due minuti non è un conteggio, è un attrito — e due agenti che si passano lo
 *     stesso intero litigano in merge su una riga che nessuno dei due considera sua.
 *  2. **Se quel numero si fossilizzasse, la strada principale della galleria
 *     resterebbe fuori dal lock col gate verde.** È precisamente il modo in cui un
 *     lock diventa decorazione, ed è un difetto che questo repo ha già pagato su
 *     un tetto `<=` che due rami paralleli hanno lasciato più largo del vero.
 *
 * Quindi il lock le pretende TUTTE, da subito — e per un po' questa prova è stata
 * ROSSA, nominando `gallery/route.ts` riga per riga. Era lo stato corretto (un
 * cestino incompleto *deve* tenere il gate rosso) e il miglior passaggio di
 * consegne possibile: l'elenco delle query che restavano, coi numeri di riga, sul
 * file di chi le stava scrivendo. Dal 2026-09-12 tutte e 11 sono dichiarate:
 * l'allowlist resta vuota perché non serve, non perché si è deciso di non guardare.
 * E quel file, che prima non aveva nessun controllo positivo, ora ne ha uno — la
 * `SOGLIA_SANITA` qui sotto: è la differenza fra «zero scoperte» e «zero occorrenze
 * viste».
 *
 * Il meccanismo resta: `VoceAmmessa` e le prove che lo controllano non sono state
 * rimosse, perché un'eccezione VERA potrà esistere (una lettura tecnica che non è
 * né una vista né un oblio). Quel giorno si scrive la voce, con la ragione per
 * esteso e il conteggio esatto. Oggi non ce n'è nessuna, e va bene così.
 */

const MAX_SCOPERTE = 0

/**
 * CONTROLLO POSITIVO — i file che DEVONO avere esattamente tante occorrenze
 * coperte, e zero scoperte.
 *
 * Senza di questo il lock passerebbe anche se il riconoscitore si rompesse: una
 * regex sbagliata, `fineCatena` che ritorna l'indice di partenza, la maschera che
 * spegne le stringhe invece dei commenti — e «zero occorrenze scoperte» sarebbe
 * vero per il motivo peggiore, cioè «zero occorrenze viste». È la lezione dei
 * lock che erano verdi su 140 rilievi: *un lock che non può vedere un'area non la
 * sta collaudando.*
 *
 * I numeri sono la misura del 2026-09-12. Chi aggiunge una lettura dichiarata in
 * uno di questi file alza il numero suo, e solo quello.
 *
 * ⚠️ `src/app/api/gallery/route.ts` NON è in questo elenco, e l'assenza va spiegata
 * perché è il file che pesa: **11** delle 20 occorrenze di `src/`, cioè più di
 * tutti gli altri sei insieme. Un conteggio ESATTO su un file che non è mio e che è
 * ancora in lavorazione sarebbe un intero che due agenti si passano — misurato: la
 * sua `mtime` è cambiata (01:27) mentre scrivevo queste righe — e diventerebbe rosso
 * al prossimo commit dell'altro ramo su una riga che nessuno dei due considera sua,
 * col rischio che venga «aggiustato» in fretta e nel verso sbagliato. È la stessa
 * ragione per cui l'allowlist è vuota, e vale ancora.
 *
 * Ciò che NON si può fare è lasciarlo senza alcun controllo positivo, che è com'era
 * fino a oggi: se il riconoscitore smettesse di VEDERE le sue occorrenze (un
 * `from(TABELLA)` scritto con una costante, una forma che `wrapperAMonte` non
 * attraversa, una regex ritoccata) quelle occorrenze sparirebbero da `TUTTE` e il
 * lock resterebbe **verde con la strada principale della galleria non guardata** —
 * esattamente il guasto che questo commento dichiara di esistere per impedire.
 * Quindi lì si usa una **soglia di sanità**, la forma che gli altri lock di questo
 * repo usano già: non «quante ne sono coperte» ma «quante ne VEDE». Vedi
 * `SOGLIA_SANITA`.
 */
const COPERTI_ATTESI: Record<string, number> = {
    // `gdpr/retention-galleria` — la purga del cestino, nata il 2026-09-12. Entra qui
    // dal giorno uno, e con il conteggio ESATTO, perché è il file in cui un verso
    // sbagliato costa più che altrove: è il solo posto del repo che DISTRUGGE una foto
    // di galleria insieme al suo file. Le sei occorrenze, e il verso di ciascuna:
    //   · `soloNelCestino(q, soglia)`  — le righe scadute il cui file è ancora lì;
    //   · `ancheNelCestino`            — la RIPRESA: le righe il cui file è già uscito,
    //                                    che `soloNelCestino` esclude per costruzione;
    //   · `soloNelCestino(q)`          — l'UPDATE che timbra `file_rimosso_il`: cintura,
    //                                    non si timbra mai una riga viva;
    //   · `ancheNelCestino`            — la `delete`, che deve raggiungere le righe già
    //                                    timbrate;
    //   · `ancheNelCestino` ×2         — la spazzata degli orfani: «chi reclama questi
    //                                    percorsi?» e «quante righe non ne portano uno
    //                                    confrontabile?». Lì filtrare le sole vive
    //                                    dichiarerebbe orfano il file di ogni foto nel
    //                                    cestino e lo porterebbe via a 24 ore, cioè
    //                                    distruggerebbe ciò che il prodotto promette di
    //                                    custodire per trenta giorni.
    // 2026-09-12, salito da 6 a 7: la route ha guadagnato una settima lettura
    // dichiarata mentre la si finiva (il giro dei reclami sugli orfani ne fa una in
    // più di quanto la prima stesura prevedeva). SETTE e non «>= 6»: il controllo
    // positivo di questo lock confronta il numero ESATTO, e un `>=` renderebbe
    // invisibile proprio il caso che qui conta — una lettura aggiunta di nascosto
    // in un file che distrugge foto. Le SCOPERTE restano zero, ed è quella la metà
    // che dice che non c'è un difetto: sette lette, sette dichiarate.
    'src/app/api/gdpr/retention-galleria/route.ts': 7,
    'src/app/api/tasks/route.ts': 1,
    'src/app/api/segnalazioni/route.ts': 1,
    'src/app/api/educator-sections/route.ts': 1,
    'src/lib/gdpr/esegui.ts': 4,
    'src/lib/gdpr/cosa-distrugge.ts': 1,
    'src/lib/alunni/libera-spazio.ts': 1,
}

/**
 * SOGLIA DI SANITÀ — quante occorrenze il riconoscitore deve almeno VEDERE nel file
 * che ne ha più di tutti. *Verde perché non trova violazioni* ≠ *verde perché non
 * guarda più niente*.
 *
 * Il numero, e da dove viene: `src/app/api/gallery/route.ts` ne ha **11** oggi
 * (misurato il 2026-09-12 col riconoscitore di questo file) e ne aveva **9** a HEAD,
 * prima del cestino — il cestino ne ha aggiunte, non tolte: l'elenco delle righe
 * cestinate e la purga sono letture nuove. Nove è quindi il minimo che quel file ha
 * toccato nella sua storia, ed è due sotto la misura di oggi: largo abbastanza per
 * non litigare con l'altro ramo, stretto abbastanza da diventare rosso su qualunque
 * cecità del riconoscitore (provato: bastano gli apici doppi nella regex e va a 0).
 *
 * ⚠️ SE DIVENTA ROSSA, ABBASSARLA È L'ULTIMA COSA DA FARE, non la prima. Prima si
 * stabilisce **se è il riconoscitore a essersi rotto o le query a essere davvero
 * diminuite** — e se sono diminuite, il numero nuovo si scrive QUI insieme a: cosa è
 * cambiato, quanto valeva prima, quanto vale la misura appena fatta. Un lock
 * ammorbidito una volta senza spiegazione viene ammorbidito la seconda senza
 * nemmeno guardare, e da lì certifica il nulla.
 */
const SOGLIA_SANITA: Record<string, number> = {
    'src/app/api/gallery/route.ts': 9,
}

// ─────────────────────────────────────────────────────────────────────────────
// Il riconoscitore
// ─────────────────────────────────────────────────────────────────────────────

/** Indice della `(` che apre la `)` in `chiusura`. Va usato su `struttura`. */
function aperturaParentesi(strut: string, chiusura: number): number {
    let livello = 0
    for (let k = chiusura; k >= 0; k--) {
        if (strut[k] === ')') livello++
        else if (strut[k] === '(') {
            livello--
            if (livello === 0) return k
        }
    }
    return 0
}

const IDENT = /[A-Za-z0-9_$]/

/**
 * Inizio dell'espressione RICEVITORE di `.from(` — `supabase` in
 * `supabase.from(…)`, `createAdminClient()` in `createAdminClient().from(…)`.
 * Attraversa identificatori, punti e parentesi/quadre bilanciate.
 */
function inizioRicevitore(strut: string, puntoFrom: number): number {
    let k = puntoFrom - 1
    const spazi = () => { while (k >= 0 && /\s/.test(strut[k])) k-- }
    spazi()
    for (;;) {
        if (k < 0) break
        if (IDENT.test(strut[k])) { while (k >= 0 && IDENT.test(strut[k])) k-- }
        else if (strut[k] === ')') k = aperturaParentesi(strut, k) - 1
        else if (strut[k] === '!') k--
        else break
        let j = k
        while (j >= 0 && /\s/.test(strut[j])) j--
        if (j >= 0 && strut[j] === '.') { k = j - 1; spazi(); continue }
        break
    }
    return k + 1
}

interface Wrapper {
    nome: string
    /** Indice della `(` della chiamata. Serve a leggere il `motivo`. */
    apertura: number
}

/**
 * Risale i WRAPPER che avvolgono la catena, dal più interno al più esterno.
 * Attraversa `await`, le parentesi di chiamata e le funzioni-thunk (`() =>`,
 * `(vive) =>`, `vive =>`), perché `leggiVive` riceve una funzione che COSTRUISCE
 * la query e non la query già costruita — e non per vezzo: `q.is(…)` ritorna
 * `this`, cioè muta il builder, quindi dopo un tentativo fallito non esiste più
 * una versione «pulita» da riusare.
 *
 * Il tetto di dodici giri non è prudenza: è la garanzia che questa funzione
 * termini su un sorgente che non ci si aspetta.
 */
function wrapperAMonte(strut: string, inizio: number): Wrapper[] {
    const trovati: Wrapper[] = []
    let k = inizio - 1
    const spazi = () => { while (k >= 0 && /\s/.test(strut[k])) k-- }
    for (let giri = 0; giri < 12; giri++) {
        spazi()
        if (k < 0) break
        // `=>` di un thunk: si salta la freccia e la sua lista di parametri.
        if (strut[k] === '>' && k >= 1 && strut[k - 1] === '=') {
            k -= 2
            spazi()
            if (k >= 0 && strut[k] === ')') { k = aperturaParentesi(strut, k) - 1; continue }
            while (k >= 0 && IDENT.test(strut[k])) k--
            continue
        }
        if (strut[k] === '(') {
            const apertura = k
            k--
            spazi()
            const fineId = k
            while (k >= 0 && IDENT.test(strut[k])) k--
            const nome = strut.slice(k + 1, fineId + 1)
            if (nome) trovati.push({ nome, apertura })
            continue
        }
        if (k >= 4 && strut.slice(k - 4, k + 1) === 'await') { k -= 5; continue }
        if (strut[k] === ',') { k--; continue }
        break
    }
    return trovati
}

/**
 * Il nome del PARAMETRO del thunk passato come primo argomento di `leggiVive`.
 *
 * `apertura` è la `(` di `leggiVive(`. Da lì si accetta solo ciò che è davvero un
 * thunk — `(vive) => …`, `(vive: FiltroVive) => …`, `vive => …` — e si restituisce
 * il nome del parametro. `null` in tre casi, e tutti e tre sono un rifiuto:
 *
 *  · `() => …`        il thunk non riceve il filtro: non può applicarlo;
 *  · `leggiVive(f, …)` il costruttore è altrove e questa query non è ispezionabile;
 *  · qualunque altra forma, perché fail-closed è l'unico verso corretto per un
 *    lock: un parser che non capisce deve dire «scoperta», non «va bene».
 */
function parametroDelThunk(strut: string, senza: string, apertura: number): string | null {
    let i = apertura + 1
    const spazi = () => { while (i < strut.length && /\s/.test(strut[i])) i++ }
    spazi()
    let grezzo: string
    if (strut[i] === '(') {
        const chiusura = fineParentesi(strut, i)
        grezzo = senza.slice(i + 1, chiusura - 1)
        i = chiusura
    } else {
        const inizio = i
        while (i < strut.length && IDENT.test(strut[i])) i++
        grezzo = senza.slice(inizio, i)
    }
    spazi()
    // Senza la freccia non è un thunk inline: `leggiVive(costruisci, 'op')`.
    if (!(strut[i] === '=' && strut[i + 1] === '>')) return null
    // Via l'eventuale annotazione di tipo e il default: resta l'identificatore.
    const nome = grezzo.split(':')[0].split('=')[0].trim()
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome) ? nome : null
}

interface Occorrenza {
    file: string
    linea: number
    /** Il marcatore che la dichiara, se c'è. */
    marcatore: string | null
    /** Il `motivo` scritto, per le occorrenze dichiarate con `ancheNelCestino`. */
    motivo: string | null
    /** Perché un marcatore TROVATO non è stato accettato. Solo per il messaggio. */
    respinto: string | null
    /** Un marcatore col nome giusto che NON viene da `@/lib/gallery/cestino`. */
    omonimo: string | null
}

function scandisci(rel: string): Occorrenza[] {
    const src = fs.readFileSync(path.join(RADICE, rel), 'utf8')
    const { senzaCommenti, struttura } = mascheraSorgente(src)
    // ⚠️ La PROVENIENZA, prima del nome: un marcatore vale solo se questo file lo
    // importa dal modulo della regola. Vedi `IMPORT_MODULO`.
    const dalModulo = marcatoriImportati(senzaCommenti)
    const out: Occorrenza[] = []
    DA_TABELLA.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DA_TABELLA.exec(senzaCommenti)) !== null) {
        const iFrom = m.index
        // Il `.` che precede `from(`: senza di esso non è una catena PostgREST.
        let p = iFrom - 1
        while (p >= 0 && /\s/.test(struttura[p])) p--
        if (struttura[p] !== '.') continue
        const fine = fineCatena(struttura, p)
        const ric = inizioRicevitore(struttura, p)
        const wrapper = wrapperAMonte(struttura, ric)

        // 1) nella catena stessa (un `soloVive` applicato a metà);
        const dentro = senzaCommenti.slice(ric, fine)
        const nelDubbio = MARCATORI.find((n) => new RegExp(`\\b${n}\\s*\\(`).test(dentro)) ?? null
        let marcatore: string | null = nelDubbio !== null && dalModulo.has(nelDubbio) ? nelDubbio : null
        let motivo: string | null = null
        let respinto: string | null = null
        let omonimo: string | null = nelDubbio !== null && marcatore === null ? nelDubbio : null
        // 2) fra i wrapper che la avvolgono.
        if (!marcatore && !omonimo) {
            const iW = wrapper.findIndex((v) => (MARCATORI as readonly string[]).includes(v.nome))
            const w = iW >= 0 ? wrapper[iW] : undefined
            if (w && !dalModulo.has(w.nome)) {
                omonimo = w.nome
            } else if (w) {
                marcatore = w.nome
                if (w.nome === 'ancheNelCestino') {
                    // Il secondo argomento: da fine catena alla `)` del wrapper.
                    const chiusura = fineParentesi(struttura, w.apertura)
                    motivo = senzaCommenti.slice(fine, Math.max(fine, chiusura - 1))
                }
                if (w.nome === 'leggiVive') {
                    // ⚠️ IL NOME NON È IL FILTRO. `leggiVive` riceve il filtro come
                    // parametro di un thunk: se il thunk non lo prende, o lo prende e
                    // non avvolge QUESTA query, il cestino non è filtrato — e senza
                    // questo controllo il lock resterebbe verde (misurato).
                    const param = parametroDelThunk(struttura, senzaCommenti, w.apertura)
                    // I wrapper sono dal più interno al più esterno: il filtro deve
                    // stare FRA la catena e `leggiVive`, cioè prima di lui nell'elenco.
                    const applicato =
                        param !== null && wrapper.slice(0, iW).some((v) => v.nome === param)
                    if (!applicato) {
                        marcatore = null
                        respinto =
                            param === null
                                ? '`leggiVive` è nominato ma il suo thunk non riceve il filtro ' +
                                  '(`() => …`, o un costruttore passato per nome): il parametro ' +
                                  'non esiste, quindi non può essere applicato'
                                : `\`leggiVive\` è nominato e il suo thunk riceve \`${param}\`, ` +
                                  `ma \`${param}(…)\` NON avvolge questa query: il filtro del ` +
                                  'cestino non entra, e la query legge anche le righe eliminate'
                    }
                }
            }
        }
        out.push({ file: rel, linea: riga(src, iFrom), marcatore, motivo, respinto, omonimo })
    }
    return out
}

/** Perché questa occorrenza non è coperta, quando qualcosa di simile c'era. */
function perche(o: Occorrenza): string {
    if (o.respinto) return ` — ${o.respinto}`
    if (o.omonimo) {
        return (
            ` — c'è \`${o.omonimo}(\` ma questo file NON lo importa da \`@/lib/gallery/cestino\`: ` +
            'è un omonimo, cioè un nome giusto su una funzione qualunque, e un nome non filtra ' +
            'niente. Importa il marcatore vero (o, se è una funzione locale tua, chiamala in un ' +
            'altro modo: qui il nome è un contratto)'
        )
    }
    return ''
}

/** Il testo vero della ragione: via apici, concatenazioni, virgole e spazi doppi. */
function ragioneNuda(grezzo: string): string {
    return grezzo
        .replace(/^\s*,\s*/, '')
        .replace(/['"`+\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

const TUTTE: Occorrenza[] = fileSorgente(SRC)
    .map((f) => path.relative(RADICE, f).split(path.sep).join('/'))
    .filter((f) => f !== MODULO)
    .flatMap((f) => scandisci(f))

describe('lock — il cestino della galleria: ogni lettura dichiara', () => {
    it('il modulo della regola esiste ed esporta i quattro nomi', () => {
        const percorso = path.join(RADICE, MODULO)
        expect(
            fs.existsSync(percorso),
            `Manca ${MODULO}. È l'unico posto dove la regola del cestino esiste: senza, ogni ` +
                'lettura riscriverebbe il filtro a mano e la prima che lo dimentica fa riapparire ' +
                'una foto eliminata.',
        ).toBe(true)
        const sorgente = fs.readFileSync(percorso, 'utf8')
        for (const nome of MARCATORI) {
            expect(
                new RegExp(`export (?:async )?function ${nome}\\b`).test(sorgente),
                `${MODULO} non esporta \`${nome}\`. I quattro nomi sono il vocabolario che questo ` +
                    'lock riconosce: se uno sparisce, le occorrenze che lo usavano diventano ' +
                    'scoperte e il lock lo dirà — ma il vocabolario va tenuto qui, non indovinato.',
            ).toBe(true)
        }
        // I 30 giorni, e la soglia calcolata da loro, stanno qui e in nessun altro posto.
        expect(
            /export const GIORNI_CESTINO_GALLERIA = 30\b/.test(sorgente),
            'I giorni di grazia devono vivere in una costante sola: la purga, l’elenco del cestino ' +
                'e il testo che l’utente legge devono dire lo stesso numero.',
        ).toBe(true)
    })

    it('il testo che l’utente legge dice gli STESSI giorni della costante', () => {
        const sorgente = fs.readFileSync(path.join(RADICE, MODULO), 'utf8')
        const m = /export const GIORNI_CESTINO_GALLERIA = (\d+)\b/.exec(sorgente)
        expect(m, `Non riesco a leggere GIORNI_CESTINO_GALLERIA in ${MODULO}.`).not.toBeNull()
        const giorni = m![1]
        const sbagliati: string[] = []
        for (const rel of MESSAGGI_UTENTE) {
            const percorso = path.join(RADICE, rel)
            if (!fs.existsSync(percorso)) { sbagliati.push(`${rel}: non esiste`); continue }
            const dizionario = JSON.parse(fs.readFileSync(percorso, 'utf8')) as Record<string, unknown>
            const testo = dizionario[CHIAVE_RIPRISTINO]
            if (typeof testo !== 'string') {
                sbagliati.push(
                    `${rel}: manca la chiave \`${CHIAVE_RIPRISTINO}\` — se il testo si è spostato, ` +
                        'punta questo lock alla chiave nuova invece di togliere la prova',
                )
                continue
            }
            if (!new RegExp(`\\b${giorni}\\b`).test(testo)) {
                sbagliati.push(`${rel}: la costante dice ${giorni}, il testo dice «${testo}»`)
            }
        }
        expect(
            sbagliati,
            'La costante e il testo sullo schermo dicono numeri diversi. Il numero che la ' +
                'segreteria legge PRIMA di eliminare («si può ripristinare entro N giorni») è una ' +
                'promessa, e la purga la mantiene o la tradisce: se il codice cancella a 15 giorni ' +
                'e il dialogo ne promette 30, chi ha eliminato una foto la cerca nel cestino dopo ' +
                'venti giorni e non la trova più. Un file di messaggi non può importare una ' +
                'costante — questa prova è tutto ciò che tiene le due copie insieme.',
        ).toEqual([])
    })

    it('il riconoscitore VEDE le occorrenze che deve vedere (controllo positivo)', () => {
        const sbagliati: string[] = []
        for (const [file, atteso] of Object.entries(COPERTI_ATTESI)) {
            expect(fs.existsSync(path.join(RADICE, file)), `sparito: ${file}`).toBe(true)
            const occ = TUTTE.filter((o) => o.file === file)
            const coperte = occ.filter((o) => o.marcatore !== null).length
            const scoperte = occ.length - coperte
            if (coperte !== atteso || scoperte !== 0) {
                sbagliati.push(
                    `${file}: attese ${atteso} coperte e 0 scoperte, misurate ${coperte} coperte ` +
                        `e ${scoperte} scoperte`,
                )
            }
        }
        expect(
            sbagliati,
            'Il controllo positivo non torna. Se le COPERTE sono meno delle attese il ' +
                'riconoscitore si è rotto (regex, maschera, o `fineCatena`) e «zero scoperte» ' +
                'sarebbe vero per il motivo peggiore: zero occorrenze viste. Se sono di più, hai ' +
                'aggiunto una lettura dichiarata: alza il numero di QUEL file. Se ci sono ' +
                'SCOPERTE, è il difetto che questo lock esiste per prendere.',
        ).toEqual([])
    })

    /**
     * ⚠️ IL CONTROLLO POSITIVO SUL FILE CHE PESA PIÙ DI TUTTI, che prima non c'era.
     * `gallery/route.ts` porta 11 delle 20 occorrenze di `src/` e non sta in
     * `COPERTI_ATTESI` (non è mio, ed è ancora in lavorazione: vedi il commento là).
     * Senza questa prova, una cecità del riconoscitore su quel file si sarebbe
     * manifestata come SILENZIO invece che come rosso.
     */
    it('il riconoscitore VEDE almeno la soglia di sanità dove le letture sono di più', () => {
        const sotto: string[] = []
        for (const [file, minimo] of Object.entries(SOGLIA_SANITA)) {
            expect(fs.existsSync(path.join(RADICE, file)), `sparito: ${file}`).toBe(true)
            const occ = TUTTE.filter((o) => o.file === file)
            const scoperte = occ.filter((o) => o.marcatore === null).length
            if (occ.length < minimo) {
                sotto.push(`${file}: viste ${occ.length} occorrenze, soglia ${minimo}`)
            }
            // Le scoperte le prende già la prova generale; qui serve perché il
            // messaggio nomini QUESTO file, che è quello su cui pesa.
            if (scoperte > 0) {
                sotto.push(`${file}: ${scoperte} occorrenze senza dichiarazione`)
            }
        }
        expect(
            sotto,
            'La soglia di sanità non è rispettata. Se le occorrenze VISTE sono sotto il minimo, la ' +
                'prima ipotesi non è «ne hanno tolte una»: è che il riconoscitore si sia rotto — ' +
                'regex, `mascheraSorgente`, `fineCatena` — e allora ogni altra prova di questo file ' +
                'è verde perché non guarda più niente, non perché il cestino sia a posto. Solo dopo ' +
                'aver stabilito che le query sono diminuite DAVVERO si abbassa il numero, e si ' +
                'scrive accanto cosa è cambiato e quanto valeva prima.',
        ).toEqual([])
    })

    /**
     * ⚠️ LA PROVA CHE IL PRIMO GIRO DI QUESTO LOCK NON AVEVA, E PER CUI È STATO
     * BOCCIATO. Sta PRIMA della prova generale di proposito: se un `leggiVive` è
     * finto, il messaggio deve dire *quello*, non «query senza dichiarazione» —
     * perché chi legge vede il nome `leggiVive` nel sorgente e cercherebbe altrove.
     */
    it('ogni `leggiVive` APPLICA il filtro che riceve, non si limita a nominarlo', () => {
        const finti = TUTTE.filter((o) => o.respinto !== null).map(
            (o) => `${o.file}:${o.linea} — ${o.respinto}`,
        )
        expect(
            finti,
            '`leggiVive` non è un’etichetta: è la funzione che PASSA il filtro al thunk. ' +
                'Scrivila nella forma che lo applica — `leggiVive((vive) => vive(supabase' +
                '.from(…).select(…)).order(…), "gruppo:METODO")` — con `vive(…)` che avvolge ' +
                'QUESTA query, non una vicina. La forma `() => (…)` compila, passa `eslint` e ' +
                '`tsc`, non rompe nessun test e legge anche le foto nel cestino: è il difetto ' +
                'per cui il primo giro di questo lock è stato bocciato, misurato su `tasks:GET` ' +
                'il 2026-09-12 col lock verde 7/7.',
        ).toEqual([])
    })

    /**
     * ⚠️ LA PROVA GEMELLA DELLA PRECEDENTE, E CHIUDE LO STESSO BUCO PER GLI ALTRI
     * TRE NOMI. Il primo giro aveva imparato che «il nome è il contenitore, non il
     * filtro» e l'aveva applicato solo a `leggiVive`. Ma `soloVive` è un nome, e un
     * nome si può omonimare: misurato il 2026-09-12, un
     * `function soloVive<T>(q: T): T { return q }` locale usato come wrapper faceva
     * contare l'occorrenza COPERTA. Ora il lock chiede la PROVENIENZA, non la
     * stringa: quel marcatore deve venire da `@/lib/gallery/cestino`.
     */
    it('un marcatore vale solo se viene DAL MODULO (niente omonimi)', () => {
        const omonimi = TUTTE.filter((o) => o.omonimo !== null).map(
            (o) => `${o.file}:${o.linea} — \`${o.omonimo}\` non è importato da ${MODULO}`,
        )
        expect(
            omonimi,
            'Il nome di un marcatore è un CONTRATTO, non una parola: una funzione locale che si ' +
                'chiama `soloVive` e ritorna la query intatta soddisfa la stringa e non filtra ' +
                'niente, e il lock la conterebbe coperta — misurato. Se è il marcatore vero, ' +
                `importalo da \`@/lib/gallery/cestino\`; se è roba tua, chiamala in un altro modo. ` +
                'Vale anche per `import * as …`: quella forma non è riconosciuta di proposito, ' +
                'perché un riconoscitore che non capisce deve dire «scoperta».',
        ).toEqual([])
    })

    it('nessuna lettura di `galleria_media_v2` resta senza dichiarazione', () => {
        const ammessi = new Map(AMMESSE.map((v) => [v.file, v]))
        const nude = TUTTE.filter((o) => o.marcatore === null && !ammessi.has(o.file)).map(
            (o) => `${o.file}:${o.linea}${perche(o)}`,
        )
        expect(
            nude,
            'Questa query legge (o scrive) `galleria_media_v2` senza dire niente del cestino. ' +
                'Non aggiungerla all’allowlist: scegli il verso e scrivilo. `soloVive(q)` (o ' +
                '`leggiVive(…)`, che porta anche il degrado per il DB E2E della CI) se la foto ' +
                'cestinata non deve comparire — è quasi sempre questo. `soloNelCestino(q, …)` per ' +
                'l’elenco del cestino e per la purga. `ancheNelCestino(q, motivo)` SOLO se la ' +
                'lettura deve vedere tutto — l’oblio GDPR e il preventivo che la Direzione ' +
                'conferma — e allora il motivo va scritto per esteso. Una lettura dimenticata non ' +
                'dà errore: fa riapparire la foto di un bambino che qualcuno aveva eliminato.',
        ).toEqual([])
    })

    it('ogni `ancheNelCestino` porta una ragione scritta per esteso', () => {
        const povere = TUTTE.filter((o) => o.marcatore === 'ancheNelCestino')
            .map((o) => ({ o, testo: ragioneNuda(o.motivo ?? '') }))
            .filter(({ testo }) => testo.length < RAGIONE_MINIMA)
            .map(({ o, testo }) => `${o.file}:${o.linea} (${testo.length} caratteri)`)
        expect(
            povere,
            `Una deroga con meno di ${RAGIONE_MINIMA} caratteri di ragione non è una deroga: è ` +
                'un’etichetta, e fra sei mesi nessuno potrà contestarla né confermarla. Scrivi ' +
                'cosa succederebbe se questa lettura filtrasse le sole vive — perché è quella la ' +
                'domanda: sull’oblio la risposta è «la foto sopravvive alla cancellazione chiesta ' +
                'dalla famiglia», e su un preventivo è «il numero che la Direzione conferma non è ' +
                'quello che accade».',
        ).toEqual([])
    })

    it('le voci ammesse esistono, hanno una ragione per esteso e il conteggio ESATTO', () => {
        const problemi: string[] = []
        for (const v of AMMESSE) {
            if (!fs.existsSync(path.join(RADICE, v.file))) {
                problemi.push(`${v.file}: non esiste più, togli la voce`)
                continue
            }
            if (ragioneNuda(v.ragione).length < RAGIONE_MINIMA) {
                problemi.push(`${v.file}: ragione troppo corta (${v.ragione.length})`)
            }
            const occ = TUTTE.filter((o) => o.file === v.file)
            const scoperte = occ.filter((o) => o.marcatore === null).length
            if (scoperte === 0) {
                problemi.push(
                    `${v.file}: NON ha più occorrenze scoperte — ottimo lavoro, ora togli la voce ` +
                        'e abbassa MAX_SCOPERTE',
                )
            } else if (scoperte !== v.scoperte) {
                problemi.push(
                    `${v.file}: dichiarate ${v.scoperte} scoperte, misurate ${scoperte} → scrivi ` +
                        `"scoperte": ${scoperte}`,
                )
            }
        }
        expect(
            problemi,
            'L’allowlist non combacia col sorgente. Se le scoperte sono SCESE è una buona ' +
                'notizia: abbassa il numero (e il tetto), invece di lasciare credito non speso — ' +
                'un conteggio più largo del vero tiene la strada principale della galleria fuori ' +
                'dal lock col gate verde, che è come un lock diventa decorazione. Se sono SALITE, ' +
                'hai aggiunto una lettura senza dichiarazione in un file dove il lock tace.',
        ).toEqual([])
    })

    it('le occorrenze scoperte possono solo diminuire (tetto monotono)', () => {
        const scoperte = TUTTE.filter((o) => o.marcatore === null).length
        expect(
            scoperte,
            `In src/ ci sono ${scoperte} letture di galleria_media_v2 senza dichiarazione (tetto ` +
                `${MAX_SCOPERTE}). Alzare il tetto non è la risposta: il tetto scende quando si ` +
                'copre una query, e non risale mai. A zero ci si è arrivati il 2026-09-12, quando ' +
                'anche `gallery/route.ts` ha dichiarato tutte le sue letture — vedi il blocco su ' +
                'AMMESSE. Se questo numero è risalito, una query nuova è nata senza dichiarazione.',
        ).toBeLessThanOrEqual(MAX_SCOPERTE)
    })

    it('nessuna occorrenza scoperta fuori dai file ammessi', () => {
        const ammessi = new Set(AMMESSE.map((v) => v.file))
        const fuori = [...new Set(TUTTE.filter((o) => o.marcatore === null).map((o) => o.file))]
            .filter((f) => !ammessi.has(f))
        expect(
            fuori,
            'Un file con letture scoperte che non sta in AMMESSE. È la stessa prova di sopra vista ' +
                'per file: serve perché il messaggio nomini il FILE e non solo la riga, e perché ' +
                'un’allowlist svuotata per sbaglio non passi inosservata.',
        ).toEqual([])
    })
})
