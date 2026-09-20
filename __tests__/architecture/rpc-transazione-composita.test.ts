import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · LE QUATTRO DECISIONI DELLA RPC COMPOSITA, CHE SENZA QUESTO FILE SI
 * DISFANNO IN SILENZIO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * `registra_transazione_contabile(jsonb)` impara in `…180100_transazione_voci_nuove.sql`
 * tre campi nuovi (`voci_nuove`, `voci_ticket`, `movimento_id` + `stato_atteso`).
 * La PRIMA stesura di quella migrazione conteneva quattro difetti, tutti corretti
 * dopo una rimisurazione sul database vivo. Il punto è che **nessuno dei 19 test
 * citati come "test sulla RPC"** — `transazioni-voci-in-sede` (3),
 * `transazioni-post` (7), `ticket-ricarica-atomica` (9) — li sorveglia: collaudano
 * il comportamento VECCHIO, quello che i campi nuovi non toccano, e restano verdi
 * anche se qualcuno rimette esattamente le quattro righe sbagliate.
 * Misurato prima di scrivere questo file:
 * `grep -rn "voci_nuove\|voci_ticket\|stato_atteso\|ancora_indice" src/ __tests__/`
 * → **zero righe**. Nessun test nominava questa migrazione.
 *
 * ⚠️ NON È PIÙ ZERO, e **il numero nuovo non è scritto qui apposta**. Quello di
 * ieri diceva «tre righe» ed era già falso il giorno dopo: è il terzo
 * invecchiamento della stessa cifra in due giorni, dentro un paragrafo che
 * raccomanda «si rifà, non si cita» e poi la citava. Al posto del risultato sta
 * il comando che lo rifà — e che va eseguito, non letto:
 *
 *     grep -rn "voci_nuove\|voci_ticket\|stato_atteso\|ancora_indice" src/ __tests__/ \
 *       | grep -v rpc-transazione-composita.test.ts | wc -l
 *
 * Quello che NON invecchia è la conclusione, ed è per questo che è scritta a parole:
 * le righe che il grep trova sono **commenti** — la fetta che costruisce il payload
 * lato client cita questa migrazione, non la esercita — quindi nessun test esegue
 * questa RPC. La riprova si rifà con una riga sola, e quella sì che vale:
 * `grep -rn "registra_transazione_contabile" src/` → l'unica chiamata è
 * `transazioni/route.ts`, e il payload che passa non ha nessuno dei tre campi nuovi.
 *
 * E il lock che sembrava coprirla — `migrazioni-senza-sede-cablata` — è **cieco
 * per costruzione** su questi difetti: cerca uuid di sede SCRITTI NEL FILE, e la
 * prima stesura, che prendeva la sede dal payload, di uuid cablati non ne aveva
 * nessuno. Era verde sul codice rotto.
 *
 * ─── PERCHÉ LEGGE IL FILE `.sql` ────────────────────────────────────────────
 *
 * Il corpo della funzione vive nel database, non nel bundle: nessun tipo
 * TypeScript, nessun test di route e nessuno dei test della suite tocca quelle
 * righe. Il `.sql` è l'unico artefatto VERSIONATO che dica cosa la funzione fa.
 *
 * ⚠️ COSA QUESTO LOCK **NON** DIMOSTRA: che la funzione viva nel database sia
 * questa. Quella prova la danno `apply_migration` e la fotografia di
 * `__tests__/fixtures/migrazioni-applicate-snapshot.json`
 * (`migrazioni-complete.test.ts`). Qui si sorveglia l'intenzione scritta.
 *
 * ⚠️ E NON LEGGE I COMMENTI. Dentro `$$ … $$` un `--` è prosa, e la prosa di
 * quella migrazione NOMINA per esteso le righe sbagliate che racconta di aver
 * corretto — `COALESCE(voce.scuola_id, …)`, `stato_atteso='confermato'`,
 * `costo_unitario >= 0`. Un lock che cercasse nel testo grezzo si
 * **immuniserebbe col proprio commento**: sarebbe verde per colpa della
 * spiegazione, qualunque cosa faccia il codice sotto. In questo repository è già
 * successo. Quindi si toglie ogni commento prima di guardare — **le sintassi sono
 * due**, e per cinque stesure qui se ne toglieva una sola: il perché sta sopra
 * `CODICE`, ed è il rilievo che ha aperto questa stesura. Come fanno già
 * `fk-scuola-id.test.ts:139`, `rls-policy-sede.test.ts:75` e
 * `security-definer-revoke-lock.test.ts:99` (⚠️ **non**
 * `annullo-riapre-movimento.test.ts:106`, che era il modello citato qui e toglie
 * solo i `--`: è uno dei file con lo stesso buco, non il modello da seguire).
 *
 * ─── LA REGOLA CHE QUESTO FILE HA IMPARATO A PROPRIE SPESE ──────────────────
 *
 * **Un lock che cerca la PRESENZA di una cosa giusta è cieco a chi la sposta.**
 * Non è una massima: è il referto di otto mutazioni che questo file ha lasciato
 * passare, misurate una per una e poi chiuse.
 *   1. la sede DERIVATA (`v_sedi_* := … || v_scuola_voce`) sostituita con quella
 *      dichiarata dal client — l'INSERT restava perfetto;
 *   2. la sede letta dall'ALUNNO SBAGLIATO (`WHERE a.id = v_pagante`), e le due
 *      letture cancellate del tutto: un filtro su ciò che trova è verde sul vuoto;
 *   3. `'confermato'` che salta la guardia del vocabolario per via di un
 *      congiunto in più, con l'elenco dei tre stati intatto;
 *   4. l'INTERO jsonb della voce interpolato in un `RAISE` — una lista nera
 *      chiude i nomi già sbagliati, mai quelli che nessuno ha ancora scritto;
 *   5. la stessa cosa sulla guardia del costo, e la stessa cosa ANNIDANDOLA in un
 *      `IF` esterno invece che aggiungendo un congiunto;
 *   6. il compare-and-swap neutralizzato da un `OR TRUE`, col `CASE` al suo posto;
 *   7. la sede giusta scritta e poi RISCRITTA da un `UPDATE` aggiunto dopo;
 *   8. il cursore `v_i` congelato a 1: tutte le voci sulla sede della prima.
 * Da qui la forma delle asserzioni: si pretende la condizione INTERA e non il
 * confronto, l'elenco CHIUSO e non il campione, il conteggio oltre al
 * riconoscimento. Chi aggiunge una regola qui si chieda, PRIMA di dichiararla
 * fatta: «qual è la modifica minima che rompe l'invariante e che questa
 * asserzione non vede?» — e poi la esegua davvero.
 *
 * ─── E LA SECONDA REGOLA, PAGATA AL QUINTO GIRO ─────────────────────────────
 *
 * **Un lock si prova da UNA direzione sola finché qualcuno non elenca le altre.**
 * Le otto mutazioni qui sopra, e le sette provate dopo di loro, erano tutte nella
 * stessa classe: `:=`. Nessuno aveva scritto un `SELECT … INTO`, né un `||` al
 * posto di una virgola. Altre **sedici** mutazioni, provate una per una dopo aver
 * elencato PRIMA le forme alternative di ogni cosa che questo file cerca, sono
 * passate tutte — «7 passed» — e sono le classi che le regole di oggi chiudono:
 *   · ASSEGNAZIONE — `SELECT … INTO`, `INTO STRICT`, `EXECUTE … INTO`,
 *     `FOR <var> IN … LOOP`, `GET DIAGNOSTICS <var> =`;
 *   · SCRITTURA — senza schema (`UPDATE pagamenti`, che con `search_path =
 *     public` è la stessa riga), `EXECUTE format(…)` dinamico, dentro un'altra
 *     funzione (`PERFORM public.…`), dentro un `CREATE TRIGGER` in coda al file;
 *   · MESSAGGIO — costruito con `||` (nessuna virgola ⇒ nessun argomento ⇒
 *     nessun controllo) e passato in `USING DETAIL`;
 *   · GUARDIA — annidata in un `IF` esterno, o con un congiunto in più
 *     (`IF NOT FOUND AND v_idx > 0`);
 *   · CONTEGGIO — compensato: +1 ramo annidando una guardia, −1 togliendone
 *     un'altra altrove, saldo invariato.
 * Prima di dichiarare chiusa una regola nuova si scriva l'elenco delle forme
 * alternative di ciò che sorveglia, e poi si attacchi da tutte.
 *
 * ─── IL PERIMETRO, E CIÒ CHE RESTA FUORI ────────────────────────────────────
 *
 * 🔴 QUESTO LOCK GUARDA UN FILE SOLO: `…180100_transazione_voci_nuove.sql`. La
 * fetta ne porta altri due — `…180000_riconciliazione_transazione.sql` e
 * `…180200_annulla_transazione_riapre_movimento.sql` — e un `CREATE TRIGGER …
 * BEFORE INSERT ON public.pagamenti` o un `ALTER` scritto LÌ vanificherebbe la
 * derivazione della sede su ogni riga della tabella senza che una sola asserzione
 * di questo file si muova: l'inventario del DDL (test 5) chiude ciò che è estraneo
 * a QUESTA migrazione, non al branch. Allargarlo a tutte e tre sarebbe meglio;
 * finché non lo si fa, il limite sta scritto qui e non si scopre a incidente
 * avvenuto.
 *
 * E le altre classi che restano fuori portata, dette per nome:
 *   · **la compilabilità.** Un `/*` mai chiuso IN CODA al file, o una chiusura
 *     senza apertura, restano verdi qui ed è giusto — non nascondono niente — ma
 *     quel file non si applica affatto (`42601`). A dirlo è `apply_migration` al
 *     merge: non questo lock, e non `migrazioni-complete`, che legge i soli nomi;
 *   · **che la funzione viva nel database sia questa.** Qui si sorveglia
 *     l'intenzione scritta; la prova la danno `apply_migration` e la fotografia
 *     `__tests__/fixtures/migrazioni-applicate-snapshot.json`;
 *   · **che a runtime faccia la cosa giusta.** Nessun test esegue questa RPC — il
 *     grep qui sopra lo rifà —, e un file che legge un testo non è un collaudo;
 *   · **le sintassi che gli scanner non sanno leggere**: virgolette doppie,
 *     `E'…'`, dollar-quote con tag diversi da `guardia`, `$$` in numero diverso da
 *     due. Non sono sorvegliate leggendole: sono VIETATE dal test di sanity. Se
 *     una servisse davvero, prima si insegna agli scanner a leggerla.
 * Le tre classi che questa stesura ha TOLTO da questo elenco — il `$$` senza tag,
 * il controllo di flusso (`RETURN`/`CONTINUE`/`EXCEPTION WHEN` che rendono
 * irraggiungibile una guardia senza toccarla) e la compensazione del conteggio dei
 * tre `IF v_mov IS NOT NULL THEN` — hanno adesso un'asserzione ciascuna, ed è
 * l'unico modo onesto di accorciare un elenco del genere.
 */

const RADICE = process.cwd()
const CARTELLA_MIGRAZIONI = join(RADICE, 'supabase', 'migrations')

/**
 * ─── 🔴 IL FILE NON SI NOMINA PIÙ: SI CERCA (2026-09-20) ────────────────────
 *
 * Fino a oggi qui c'era scritto `'20260912180100_transazione_voci_nuove.sql'`, e
 * per otto giorni è stato giusto. Poi la marca dell'abbinamento automatico ha
 * preteso un `CREATE OR REPLACE` in più — `abbinato_auto_il` si scrive DENTRO il
 * compare-and-swap, mai in un `UPDATE` dopo la RPC — e quel `CREATE OR REPLACE`
 * NON poteva stare nel file del 12/09: quella `version` è già in
 * `supabase_migrations.schema_migrations` (lo dice
 * `__tests__/fixtures/migrazioni-applicate-snapshot.json`), e una migrazione già
 * applicata non la riapplica nessuno. Correggerla avrebbe prodotto un repository
 * che descrive una funzione e un database che ne esegue un'altra, senza un errore
 * da nessuna parte.
 *
 * Quindi il corpo vivo sta in un file NUOVO, e un lock che continuasse a nominare
 * il vecchio resterebbe **verde sorvegliando un corpo che il database non esegue
 * più**: smetterebbero di essere sorvegliate, tutte insieme e in silenzio, le
 * quattro decisioni di una RPC che muove denaro — la sede DERIVATA dall'alunno
 * (un bonifico multi-sede finirebbe nel plesso sbagliato), il vocabolario di
 * `stato_atteso` che esclude `'confermato'` (senza, un bonifico da X incide 2×X),
 * `costo_unitario > 0`, e il divieto di testo libero nei `RAISE`, che è la difesa
 * contro la PII nei log. È la cecità che questo repository ha appena pagato in
 * PR #154 («tre lock erano verdi scansionando zero file»): non si paga una quarta
 * volta per una costante.
 *
 * Si cerca perciò l'ULTIMA migrazione che ridefinisce la funzione — l'ultima in
 * ordine di `version`, che è l'ordine in cui il CLI le applica, cioè quella che
 * vince — e la prossima riscrittura sarà seguita da sé. È la stessa scelta, e per
 * la stessa ragione, del lock gemello `annullo-riapre-movimento.test.ts`.
 *
 * ⚠️ Si guarda il TESTO GREZZO, commenti compresi, e va bene così: un file che
 * NOMINA la funzione senza ridefinirla — la testata di `…124744` la cita — farebbe
 * scegliere il file sbagliato, ma il `sanity` se ne accorgerebbe subito, perché
 * quella asserzione cerca la stessa firma nel CODICE, cioè dopo aver tolto ogni
 * commento. Il verso dell'errore è quello rumoroso.
 */
const FIRMA_FUNZIONE = 'CREATE OR REPLACE FUNCTION public.registra_transazione_contabile(p jsonb)'

function ultimaMigrazioneDellaRpc(): string {
    const candidati = readdirSync(CARTELLA_MIGRAZIONI)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .filter((f) => readFileSync(join(CARTELLA_MIGRAZIONI, f), 'utf8').includes(FIRMA_FUNZIONE))
    return candidati.length === 0 ? '' : candidati[candidati.length - 1]
}

const NOME_FILE_SQL = ultimaMigrazioneDellaRpc()
const SQL = NOME_FILE_SQL ? readFileSync(join(CARTELLA_MIGRAZIONI, NOME_FILE_SQL), 'utf8') : ''

/**
 * Il file senza un solo commento — né di riga né a blocco: resta il codice, e basta.
 *
 * ⚠️ In tutta questa prosa «chiusura» sta per `*` seguito da `/`: scriverlo per
 * davvero chiuderebbe il commento che stai leggendo.
 *
 * 🔴 LE SINTASSI SONO DUE, e per cinque stesure questo file ne ha tolta una sola.
 * Un `--` AGGIUNGE prosa: chi lo scrive immunizza il lock col proprio commento, ed
 * è il difetto che la testata racconta. Un commento A BLOCCO (`/*` … chiusura)
 * TOGLIE codice: avvolgendoci dentro una guardia, PostgreSQL smette di eseguirla e
 * qui il testo resta intatto — il lock lo legge, il database no, e **nessun
 * conteggio si muove**. Misurato su questo file, prima che questa funzione
 * esistesse: un blocco attorno a
 * `IF v_costo IS NULL OR v_costo <= 0 …` → «7 passed» con la guardia morta (a valle,
 * il 23514 su `incassi`); attorno a `IF v_stato_att IS NOT NULL …` → «7 passed» col
 * vocabolario morto, cioè `'confermato'` di nuovo ammesso, cioè il DOPPIO INCASSO —
 * e con lui cade anche la giustificazione che mette `v_stato_att` nella lista bianca
 * dei `RAISE` (test 4), che si regge proprio su quella riduzione a tre letterali.
 * La convenzione è già di casa: `fk-scuola-id.test.ts:139`,
 * `rls-policy-sede.test.ts:75`, `security-definer-revoke-lock.test.ts:99`.
 *
 * 🔴 E LA CORREZIONE CHE TOGLIEVA LE DUE SINTASSI NE HA APERTA UNA TERZA. È la
 * lezione più cara di questo file, e vale oltre questo file: **una correzione può
 * aprire ciò che chiude**. Quella stesura toglieva i blocchi con una `replace`
 * globale e poi i `--` riga per riga, entrambe sul testo GREZZO. Ma un `/*` non è
 * un `/*` dovunque: dentro `'…'` e dentro un `--` PostgreSQL non ci vede nessun
 * commento, mentre quella `replace` sì — e cancellava dagli occhi del lock tutto
 * ciò che stava fino alla prima chiusura, che è codice VIVO.
 *
 * Misurato sul database di produzione con un `DO` che assegna soltanto variabili
 * locali e finisce in `RAISE` (quindi non scrive niente): due righe, una con i
 * marcatori dentro due letterali e una con i marcatori dentro due `--`, ciascuna
 * con un incremento in mezzo → `ERROR: F2G-A n=11`. PostgreSQL le ha eseguite
 * ENTRAMBE. Il lock, sullo stesso file, non le vedeva affatto:
 * `CODICE.includes('UPDATE public.pagamenti SET scuola_id = v_scuola …')` valeva
 * `false`, e l'inventario delle scritture del test 5 restava identico al file sano.
 *
 * Nove attacchi, tutti «7 passed» prima di questa funzione, tutti rossi dopo — e
 * tutti e nove già ROSSI sulla stesura precedente ancora: non è un buco vecchio,
 * è una REGRESSIONE che la correzione dei blocchi si è portata dietro.
 *   · `UPDATE public.pagamenti SET scuola_id = v_scuola` fra due letterali, e la
 *     stessa riga fra due `--`: è il difetto n. 7 della testata — la sede derivata
 *     bene e poi RISCRITTA — scritto in chiaro, con una riga di contorno. Cadono
 *     insieme l'invariante 1 (sede dall'alunno), la 4 (niente PII nei `RAISE`) e
 *     l'INTERO inventario del test 5;
 *   · `EXECUTE format('upd' || 'ate %I set scuola_id = %L', …)`, nei letterali e
 *     nei `--`;
 *   · `PERFORM public.sposta_pagamento_di_sede(…)`;
 *   · `DELETE FROM public.incassi …`;
 *   · `RAISE EXCEPTION 'voce %', v_voce` — il jsonb della voce nei log del server;
 *   · una seconda `SELECT a.scuola_id INTO v_scuola_voce FROM public.parents …`;
 *   · un `/*` aperto dentro un `--` e chiuso dentro un letterale.
 * E DIECI provate dopo, sulle forme che nessuno dei nove tocca. Le regole di
 * PostgreSQL non sono state dedotte: sono state rimisurate sul database vivo, un
 * `DO` per ciascuna, tutti che assegnano solo variabili locali e finiscono in
 * `RAISE` — quindi non scrivono niente. **Cinque erano verdi e adesso sono rosse:**
 *   · tre `/*` annidati con UNA sola chiusura, davanti alla guardia del metodo.
 *     `ERROR: F2G-C n=3` dice che i blocchi ANNIDANO davvero: lì il blocco resta
 *     aperto a profondità 2 e si mangia il RESTO DEL FILE, guardia compresa.
 *     Prima «7 passed», perché la vecchia regex chiudeva alla prima chiusura che
 *     trovava. Adesso 7 asserzioni su 7 rosse, sanity compresa;
 *   · un annidamento chiuso BENE attorno alla stessa guardia: per il database
 *     quella validazione è morta. Prima «7 passed», adesso rosso;
 *   · un `/*` mai chiuso A METÀ FILE. Prima «7 passed» — la vecchia regex non
 *     trovava nessuna chiusura e quindi non toglieva NIENTE, mentre PostgreSQL da
 *     lì in poi non esegue più niente. Adesso 1 asserzione su 7, fail-loud;
 *   · un letterale che porta il `/*` DOPO un apostrofo raddoppiato
 *     (`v_desc := 'l''anno /*';`). Prima «7 passed», adesso rosso: è la parità
 *     degli apici, ed è il motivo per cui `''` si salta a due a due;
 *   · un `/*` citato dentro un letterale che sta dentro un `--`, con la chiusura
 *     in un secondo `--`. Prima «7 passed», adesso rosso.
 * Le prime tre erano verdi anche sulla stesura ANCORA precedente: quelle non sono
 * una regressione, sono un buco vecchio che nessuna delle due aveva chiuso. Le
 * ultime due sì, come i nove qui sopra.
 * **Tre erano già rosse prima, e non si vantano**: servono solo a dimostrare che
 * lo scanner legge come il database — un `--` dentro un blocco non protegge la
 * chiusura (`F2G-B n=7`), una chiusura fra apici dentro un blocco chiude lo stesso
 * (`F2G-D n=5`), e un `$x$ … $x$` lo ferma la sanity (`F2G-E n=9`: lì dentro il
 * `/*` per PostgreSQL è TESTO e il codice in mezzo GIRA — ed è per questo che il
 * perimetro vieta i tag invece di sperarci).
 * ⚠️ E QUELLA RIGA DICEVA «è l'UNICA divergenza rimasta»: non lo era. Le forme
 * sono DUE, e la seconda — il dollar-quote SENZA tag, `$$ … $$` usato come
 * LETTERALE — faceva esattamente la stessa cosa (`F2G-F n=44`, misurato sul
 * database vivo) senza che nessuno la guardasse: `/\$([A-Za-z_]\w*)\$/` pretende
 * almeno un carattere fra i due `$`, quindi `$$` non compariva in quell'elenco.
 * Misurato: `COMMENT ON SCHEMA public IS $$…/*$$;` + `CREATE TRIGGER … BEFORE
 * INSERT ON public.pagamenti` + il `COMMENT` che chiude → «7 passed», col trigger
 * invisibile a TUTTE le regole di questo file, sanity compresa (`X1f`). Adesso la
 * chiude il conteggio dei `$$` nel test di sanity, contati su `SQL` e non su
 * `CODICE` — che è proprio ciò che l'attacco acceca.
 * **Due restano verdi, ed è giusto**, perché non nascondono niente: una chiusura
 * senza apertura, e un `/*` mai chiuso IN CODA al file, dopo il quale non c'è più
 * codice da nascondere. Quel file non si applicherebbe — misurate, `42601
 * unterminated /* comment` e `42601 syntax error at or near` la chiusura — ma a
 * dirlo è `apply_migration` al merge, non questo lock: qui si sorveglia
 * l'intenzione scritta, non la compilabilità.
 * ⚠️ E NON LO DICE `migrazioni-complete`, che questa riga citava come secondo
 * guardiano. Quel test confronta i NOMI dei file (`readdirSync`) con la fotografia
 * delle migrazioni applicate: le sue uniche due `readFileSync` sono la fotografia
 * stessa e il generatore, mai un `.sql` — si rifà con
 * `grep -n readFileSync __tests__/architecture/migrazioni-complete.test.ts`. Un
 * file con un commento mai chiuso ha il nome giusto e gli passa davanti.
 *
 * Quindi qui non si fanno più due passate di `replace`: si passa UNA volta sola da
 * sinistra a destra, e si tolgono i commenti **come li toglie PostgreSQL**:
 *   1. dentro un letterale `'…'` non comincia NESSUN commento, né `--` né `/*`, e
 *      `''` è l'apostrofo e non la fine;
 *   2. `--` consuma fino al capo, e lì dentro un `/*` è inerte. Non è un caso di
 *      scuola: **107 righe** di questa migrazione portano un apostrofo dentro un
 *      `--` («nell'ordine», «sede DELL'ALUNNO»), e TRE di loro stanno in coda a
 *      una riga di CODICE — misurato oggi, mentre un `grep -cE "^\s*--.*'"` ne
 *      conta 104 e perde esattamente quelle tre. Senza questa regola ognuna
 *      aprirebbe un letterale fantasma che si chiude al prossimo apostrofo, cioè
 *      si mangia il codice che sta in mezzo;
 *   3. `/*` … chiusura ANNIDA (PostgreSQL conta le profondità), e lì dentro non
 *      contano né gli apici né i `--`;
 *   4. si sostituisce con SPAZI e si tengono i capo riga: il testo esce lungo
 *      quanto il file — 47 214 caratteri, cioè `SQL.length` — mentre le due
 *      `replace` della stesura precedente lo consegnavano a 17 937, cioè
 *      cancellavano il 62% del file (misurato oggi, rieseguendo il vecchio scanner
 *      su questa migrazione). Così un indice in `CODICE` è lo stesso indice nel
 *      `.sql`, e ciò che un'asserzione mostra si ritrova nel file dov'è scritto.
 *      (È anche il motivo per cui un `--` dentro un letterale smette di essere un
 *      rosso per disallineamento e diventa un rosso per il motivo giusto: prima
 *      cadevano il test 2 E il test 5, adesso cade il solo test 5, che è quello
 *      che vede l'`UPDATE` in più.)
 *      ⚠️ Quello che questa scelta NON fa è «tenere allineati `MASCHERA` e
 *      `CORPO`», che è la motivazione scritta qui fino a questa stesura ed è
 *      falsa: quell'allineamento lo dà `mascheraLetterali`, che conserva la
 *      lunghezza PER COSTRUZIONE — scrive spazi su una copia di `CODICE`,
 *      carattere per carattere — e valeva identico col vecchio scanner che
 *      accorciava. Una motivazione sbagliata sopravvive alla riga che spiegava, e
 *      la correzione dopo la legge per vera.
 * I `/*` che questa funzione NON legge come PostgreSQL sono quelli dentro un
 * dollar-quote: lì per il database sono testo, qui sono commenti. E sono DUE
 * forme, non una — con tag (`$x$ … $x$`) e SENZA (`$$ … $$` usato come letterale,
 * per esempio in un `COMMENT ON`). Questa riga ne ha dichiarata una sola fino a
 * questa stesura, e quella che passava era l'altra: misurato, un `CREATE TRIGGER`
 * chiuso fra due `COMMENT ON SCHEMA public IS $$…$$` resta invisibile a ogni
 * regola di questo file (`X1f`, «7 passed»). Si è scelto di sorvegliare il
 * perimetro invece di inseguirlo, perché il corpo della funzione vive dentro
 * `$$ … $$` e lì i commenti sono veri: il test di sanity vieta i tag diversi da
 * `guardia` E pretende che i `$$` senza tag siano esattamente due.
 */
function senzaCommenti(t: string): string {
    const out = t.split('')
    let i = 0
    while (i < t.length) {
        // 1. un letterale si SALTA intero, senza toccarne un carattere.
        if (t[i] === "'") {
            i++
            while (i < t.length) {
                if (t[i] !== "'") {
                    i++
                    continue
                }
                // `''` è l'apostrofo raddoppiato: il letterale continua.
                if (t[i + 1] === "'") {
                    i += 2
                    continue
                }
                i++
                break
            }
            continue
        }
        // 2. commento di riga: fino al capo, che resta al suo posto.
        if (t[i] === '-' && t[i + 1] === '-') {
            while (i < t.length && t[i] !== '\n') {
                out[i] = ' '
                i++
            }
            continue
        }
        // 3. commento a blocco: annida, e si chiude solo a profondità zero.
        if (t[i] === '/' && t[i + 1] === '*') {
            let profondita = 0
            while (i < t.length) {
                if (t[i] === '/' && t[i + 1] === '*') {
                    profondita++
                    out[i] = ' '
                    out[i + 1] = ' '
                    i += 2
                    continue
                }
                if (t[i] === '*' && t[i + 1] === '/') {
                    profondita--
                    out[i] = ' '
                    out[i + 1] = ' '
                    i += 2
                    if (profondita === 0) break
                    continue
                }
                if (t[i] !== '\n') out[i] = ' '
                i++
            }
            continue
        }
        i++
    }
    return out.join('')
}

const CODICE = senzaCommenti(SQL)

/**
 * Lo stesso testo, alla STESSA LUNGHEZZA e alle stesse posizioni, con ogni
 * letterale `'…'` (gli escape `''` compresi) riempito di spazi.
 *
 * 🔴 SERVE DOVE SI CERCANO I CONFINI, e la differenza con `senzaLetterali` qui
 * sotto è tutta lì: quella collassa i letterali a `''` e va bene per gli ELENCHI
 * (un nome negli apici non è un identificatore), questa conserva gli offset e va
 * bene per i TAGLI (un `END $$;` negli apici non è la fine del corpo). Misurate su
 * questo file, prima di questa funzione, tutte e tre «7 passed»:
 *   · `v_desc := 'END $$;';` un rigo prima di `RETURN v_out;` accorcia `CORPO` fin
 *     lì, e un `EXECUTE format('upd' || 'ate %I set scuola_id = %L', …)` scritto
 *     SUBITO DOPO diventa invisibile a tutti e cinque gli inventari del test 5 —
 *     riscrive la sede di OGNI riga di `pagamenti`, non solo di quelle sue;
 *   · lo stesso trucco con `PERFORM public.sposta_pagamento_di_sede(…)`: l'elenco
 *     chiuso dei cinque `PERFORM` si aggira non aggiungendone uno, ma spostando il
 *     traguardo prima di lui. Nessuna compensazione richiesta: una riga;
 *   · `IF v_qta > 1 AND 'IF v_costo IS NULL OR v_costo <= 0 THEN END IF' = '' THEN`
 *     — la guardia del costo zero MORTA (la condizione è sempre falsa) mentre
 *     `condizioniIfCon` legge, dentro gli apici, esattamente la condizione attesa.
 *     Qui la compensazione dei conteggi serve, ed è la ricetta già nota.
 * I conteggi grezzi (i 43 rami, i 32 `RAISE`, l'inventario delle scritture)
 * restano APPOSTA sul testo non mascherato: lì un `IF` fra gli apici è un falso
 * positivo che aggiunge severità, e toglierlo indebolirebbe il lock invece di
 * rafforzarlo.
 */
function mascheraLetterali(t: string): string {
    const out = t.split('')
    let inStringa = false
    for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (inStringa) {
            out[i] = ' '
            if (c === "'") {
                if (t[i + 1] === "'") out[++i] = ' '
                else inStringa = false
            }
            continue
        }
        if (c === "'") {
            inStringa = true
            out[i] = ' '
        }
    }
    return out.join('')
}

/** `CODICE` con i letterali svuotati, posizione per posizione. */
const MASCHERA = mascheraLetterali(CODICE)

/**
 * Il solo CORPO della funzione — da `AS $$` a `END $$;` — cioè le istruzioni che
 * girano con i privilegi del DEFINER.
 *
 * Serve dove il perimetro conta: `GRANT EXECUTE ON FUNCTION` contiene la parola
 * `EXECUTE` ed è legittimo, mentre un `EXECUTE` DENTRO il corpo è SQL costruito a
 * runtime — cioè una scrittura che nessuna delle regex di questo file può leggere,
 * perché il bersaglio non esiste finché la funzione non gira. Misurato:
 * `EXECUTE format('upd' || 'ate %I set scuola_id = %L …', …)` riscriveva la sede
 * di ogni voce nuova e il lock restava «7 passed».
 */
const CORPO = (() => {
    // I due confini si cercano nella MASCHERA — un `END $$;` scritto fra gli apici
    // non è la fine di niente — e si affetta il testo vero. Senza, bastava
    // `v_desc := 'END $$;';` per far finire il corpo dove faceva comodo.
    const da = MASCHERA.search(/\bAS\s+\$\$/)
    const a = MASCHERA.search(/\bEND\s*\$\$\s*;/)
    return da < 0 || a < 0 ? '' : CODICE.slice(da, a)
})()

/**
 * Lo stesso codice con ogni stringa SQL svuotata (`'…'` → `''`, gli escape `''`
 * compresi). Serve a distinguere una PAROLA in un messaggio da un IDENTIFICATORE
 * passato come argomento: «descrizione obbligatoria» dentro gli apici è innocua,
 * `v_desc` fuori dagli apici è PII sul filo.
 */
function senzaLetterali(t: string): string {
    return t.replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * Tutto ciò che viene assegnato a `nome` **con l'operatore `:=`**, dichiarazione
 * compresa: sia `nome tipo := <valore>;` sia `nome := <valore>;` sia
 * `nome[indice] := <valore>;`.
 *
 * ⚠️ PERCHÉ NON BASTA CERCARE DOVE `nome` VIENE LETTO. Il primo giro di questo
 * lock guardava solo il punto d'USO (`scuola_id` nell'INSERT) e le sorgenti che
 * *trovava*: un filtro su ciò che c'è è verde anche quando non c'è più niente, e
 * soprattutto è cieco a chi cambia il valore un rigo prima. La derivazione della
 * sede avviene QUI, nell'assegnazione — non nell'INSERT.
 *
 * 🔴 E PERCHÉ QUESTA FUNZIONE DA SOLA NON BASTA, che è la lezione del quinto
 * giro. Il nome prometteva «tutto ciò che viene assegnato», la regex pretendeva
 * `:=`, e **in plpgsql `SELECT … INTO` è un'assegnazione**. Sette mutazioni
 * erano state provate contro questo lock: tutte e sette nella classe `:=`,
 * nessuna con `INTO`. Misurate poi, e tutte «7 passed»:
 *   · `SELECT array_agg(v_scuola) INTO v_sedi_nuove FROM jsonb_array_elements(v_nuove);`
 *     dopo il ciclo → TUTTE le voci nuove sulla sede del documento, INSERT intatto;
 *   · `SELECT v_scuola INTO v_scuola_voce;` un rigo prima dell'accodamento → idem;
 *   · `SELECT … INTO STRICT v_scuola_voce`, `EXECUTE … INTO v_scuola_voce`,
 *     `FOR v_scuola_voce IN … LOOP` → idem, tre forme diverse dello stesso gesto.
 * Da qui `scrittureNonDirette()` qui sotto, e la sorveglianza per SOTTRAZIONE
 * (`usiNonClassificati`) sulle tre variabili che decidono la sede.
 */
function assegnazioniA(nome: string): string[] {
    const re = new RegExp(String.raw`\b${nome}\b[^;:=]*:=\s*([^;]+);`, 'g')
    return [...CODICE.matchAll(re)].map((m) => m[1].replace(/\s+/g, ' ').trim())
}

/**
 * Le scritture su `nome` che **non** passano da `:=` — cioè tutte quelle che
 * `assegnazioniA` non vede: `SELECT/EXECUTE/RETURNING … INTO [STRICT] nome`,
 * `GET DIAGNOSTICS nome = …`, `FOR nome IN … LOOP`, `FOREACH nome …`.
 *
 * Si guardano PER FORMA e non per bersaglio: in plpgsql una variabile cambia
 * valore in sei modi diversi, e un lock che ne sorveglia uno solo non sorveglia
 * la variabile — sorveglia una sintassi.
 */
function scrittureNonDirette(nome: string): string[] {
    const forme = [
        String.raw`\bINTO\s+(?:STRICT\s+)?(?:[\w.]+\s*,\s*)*${nome}\b`,
        String.raw`\bGET\s+DIAGNOSTICS\s+(?:[\w.]+\s*=\s*[\w.]+\s*,\s*)*${nome}\s*=`,
        String.raw`\bFOR\s+${nome}\s+IN\b`,
        String.raw`\bFOREACH\s+${nome}\b`,
    ]
    const out: string[] = []
    for (const f of forme) {
        for (const m of CODICE.matchAll(new RegExp(f, 'gi'))) {
            const da = m.index ?? 0
            // `fineIstruzione` e non `indexOf(';')`: un `;` dentro un letterale
            // taglierebbe qui esattamente come tagliava nei `RAISE`.
            const puntoEVirgola = fineIstruzione(CODICE, da)
            const fine = puntoEVirgola < 0 ? da + 120 : Math.min(puntoEVirgola, da + 120)
            out.push(CODICE.slice(da, fine).replace(/\s+/g, ' ').trim())
        }
    }
    return out
}

/**
 * Le condizioni INTERE di tutti gli `IF … THEN` che contengono `ago` — cioè il
 * testo fra l'`IF` che apre e il `THEN` che chiude, normalizzato negli spazi e
 * senza ripetizioni (una condizione che nomina `ago` due volte è una sola
 * condizione).
 *
 * ⚠️ È LA DIFFERENZA FRA GUARDARE UNA PAROLA E GUARDARE UNA REGOLA. Leggere solo
 * il contenuto della parentesi di un `NOT IN (…)` dice quali valori sono
 * elencati, non se quell'elenco viene mai consultato: basta anteporre un
 * `AND <qualcosa> <> '…'` nella stessa congiunzione e il `RAISE` non scatta più,
 * con la parentesi intatta. Misurato su questo file.
 *
 * `NULLIF`/`ELSIF` non sono falsi positivi: `\bIF\b` pretende un confine di
 * parola e lì la `I` è preceduta da una lettera.
 */
function condizioniIfCon(ago: RegExp): string[] {
    const re = new RegExp(ago.source, ago.flags.includes('g') ? ago.flags : ago.flags + 'g')
    // Gli `IF` che APRONO un ramo: quelli di `END IF` chiudono, e prenderli per
    // aperture farebbe finire la ricerca del `THEN` dentro il ramo successivo —
    // cioè farebbe passare per «condizione» un blocco intero di corpo.
    //
    // 🔴 E si contano nella MASCHERA, non nel testo grezzo. Un `IF … THEN` scritto
    //   DENTRO un letterale sposta l'apertura e il traguardo: misurato su questo
    //   file, `IF v_qta > 1 AND 'IF v_costo IS NULL OR v_costo <= 0 THEN END IF' = ''
    //   THEN` faceva leggere qui la condizione attesa mentre quella vera era sempre
    //   falsa — la guardia del costo zero morta, e con la compensazione dei
    //   conteggi «7 passed». Il testo estratto viene dal CODICE, così i letterali
    //   veri (i tre stati del `NOT IN`) restano leggibili nell'asserzione.
    const aperture = [...MASCHERA.matchAll(/\bIF\b/gi)]
        .map((x) => x.index ?? 0)
        .filter((i) => !/\bEND\s+$/i.test(MASCHERA.slice(Math.max(0, i - 12), i)))
    const out: string[] = []
    for (const m of MASCHERA.matchAll(re)) {
        const qui = m.index ?? 0
        const prime = aperture.filter((i) => i < qui)
        if (prime.length === 0) continue
        const apertura = prime[prime.length - 1]
        const relativo = MASCHERA.slice(apertura).search(/\bTHEN\b/i)
        if (relativo < 0) continue
        const fineCondizione = apertura + relativo
        // Se l'occorrenza sta OLTRE il `THEN`, è nel corpo del ramo e non nella
        // condizione: non dice niente su quando quel ramo viene preso.
        if (qui >= fineCondizione) continue
        const testo = CODICE.slice(apertura + 2, fineCondizione).replace(/\s+/g, ' ').trim()
        if (!out.includes(testo)) out.push(testo)
    }
    return out
}

/**
 * Gli usi di `nome` che NON rientrano in nessuna delle forme lecite passate.
 *
 * Funziona per sottrazione, non per riconoscimento: cancella dal testo ogni
 * occorrenza lecita e mostra ciò che avanza. Un elenco di forme ammesse che si
 * limitasse a CONTARE sarebbe soddisfatto anche da un uso in più; qui un uso in
 * più resta sul tavolo e si vede, col suo contesto.
 */
function usiNonClassificati(nome: string, leciti: RegExp[]): string[] {
    let resto = CODICE
    for (const re of leciti) resto = resto.replace(re, (s) => ' '.repeat(s.length))
    const out: string[] = []
    const re = new RegExp(String.raw`\b${nome}\b`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(resto)) !== null) {
        out.push(
            '…' +
                CODICE.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, ' ').trim() +
                '…',
        )
    }
    return out
}

/** Divide una lista `a, b, c` al livello di parentesi 0, ignorando le stringhe. */
function dividiTopLevel(t: string): string[] {
    const fuori: string[] = []
    let prof = 0
    let inStringa = false
    let corrente = ''
    for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (inStringa) {
            corrente += c
            if (c === "'") inStringa = t[i + 1] === "'" ? (corrente += t[++i], true) : false
            continue
        }
        if (c === "'") { inStringa = true; corrente += c; continue }
        if (c === '(') prof++
        if (c === ')') prof--
        if (c === ',' && prof === 0) { fuori.push(corrente.trim()); corrente = ''; continue }
        corrente += c
    }
    if (corrente.trim() !== '') fuori.push(corrente.trim())
    return fuori
}

/** Il gruppo di parentesi che comincia in `da` (incluso), stringhe rispettate. */
function gruppoParentesi(t: string, da: number): { interno: string; fine: number } {
    const apertura = t.indexOf('(', da)
    if (apertura < 0) return { interno: '', fine: da }
    let prof = 0
    let inStringa = false
    for (let i = apertura; i < t.length; i++) {
        const c = t[i]
        if (inStringa) {
            if (c === "'") inStringa = t[i + 1] === "'" ? (i++, true) : false
            continue
        }
        if (c === "'") { inStringa = true; continue }
        if (c === '(') prof++
        else if (c === ')') {
            prof--
            if (prof === 0) return { interno: t.slice(apertura + 1, i), fine: i }
        }
    }
    return { interno: '', fine: t.length }
}

/**
 * La fine dell'istruzione che comincia in `da`: il primo `;` che sta DAVVERO
 * fuori da un letterale (`-1` se non c'è).
 *
 * 🔴 `indexOf(';')` NON è la stessa cosa, ed è la terza volta che questo file
 * paga la stessa lezione: un'analisi testuale che legge una forma e non l'altra.
 * Un `;` dentro un messaggio taglia l'istruzione a metà per chi la legge nel
 * testo — e tutto ciò che segue (gli argomenti posizionali, il `USING DETAIL`)
 * smette di esistere per il lock mentre continua a esistere per PostgreSQL.
 * Misurato su questo file, prima di questa funzione:
 * `RAISE EXCEPTION '#%; %', v_idx, v_voce;` → «7 passed», con `v_voce` — il jsonb
 * INTERO della voce, `descrizione` compresa — mai guardato da nessuna delle regole
 * del test 4, e in uscita nel `details` del 500 (`transazioni/route.ts:201`) e nel
 * campo `causa` del log (`logger.ts:514`), che NON passa da `redact`: dati di
 * minori, regola 8 di `AGENTS.md`. La stessa forma con delle lettere prima del `;`
 * («voce #3; scartata») è rossa, ma **per caso**: quelle parole finiscono fra gli
 * identificatori non ammessi. Qui non si dipende più dal caso.
 * Le stringhe si saltano come in `dividiTopLevel` e `gruppoParentesi`, che questa
 * regola ce l'avevano già: `''` è un apostrofo, non una chiusura.
 */
function fineIstruzione(t: string, da: number): number {
    let inStringa = false
    for (let i = da; i < t.length; i++) {
        const c = t[i]
        if (inStringa) {
            if (c === "'") inStringa = t[i + 1] === "'" ? (i++, true) : false
            continue
        }
        if (c === "'") { inStringa = true; continue }
        if (c === ';') return i
    }
    return -1
}

/**
 * Gli `INSERT INTO public.pagamenti … ;` del file, per intero.
 *
 * ⚠️ IL `\b` NON È DECORATIVO, ed è costato il primo giro rosso di questo lock:
 * senza, `indexOf('INSERT INTO public.pagamenti')` pesca anche
 * `INSERT INTO public.pagamenti_transazioni` — la TESTATA della transazione, che
 * in `scuola_id` scrive `v_scuola` *giustamente*, perché quella è la sede del
 * DOCUMENTO. Il lock sarebbe stato rosso sul codice corretto, cioè avrebbe
 * misurato la riga sbagliata e insegnato la regola sbagliata.
 */
function insertPagamenti(): string[] {
    const out: string[] = []
    const re = /INSERT\s+INTO\s+public\.pagamenti\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(CODICE)) !== null) {
        const fine = fineIstruzione(CODICE, m.index)
        out.push(CODICE.slice(m.index, fine < 0 ? CODICE.length : fine))
    }
    return out
}

/**
 * Il valore scritto in `colonna` da un `INSERT … (colonne) VALUES (valori)`,
 * abbinato **per posizione**: è l'unico modo di sapere che cosa finisce davvero
 * in `scuola_id`, invece di sperare che la riga «somigli» a quella giusta.
 */
function valorePerColonna(insert: string, colonna: string): string | null {
    const colonne = dividiTopLevel(gruppoParentesi(insert, 0).interno).map((c) => c.trim())
    const iValues = insert.search(/\bVALUES\b/i)
    if (iValues < 0) return null
    const valori = dividiTopLevel(gruppoParentesi(insert, iValues).interno)
    if (colonne.length !== valori.length) return null
    const i = colonne.indexOf(colonna)
    return i < 0 ? null : valori[i].replace(/\s+/g, ' ').trim()
}

/** Le istruzioni `RAISE EXCEPTION … ;` del file (codice, non prosa). */
function raiseDelFile(): string[] {
    const out: string[] = []
    const re = /RAISE\s+EXCEPTION/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(CODICE)) !== null) {
        const fine = fineIstruzione(CODICE, m.index)
        out.push(CODICE.slice(m.index, fine < 0 ? CODICE.length : fine))
    }
    return out
}

/**
 * Il corpo del ramo `IF <condizione> THEN … END IF`, `IF` annidati rispettati.
 *
 * Serve dove la guardia giusta e l'azione giusta possono essere separate: il
 * compare-and-swap si controlla nel `WHERE`, ma chi ha perso la corsa lo scopre
 * DENTRO questo ramo — e lì `RAISE EXCEPTION` e `RAISE NOTICE` si somigliano
 * abbastanza da passare inosservati, mentre il secondo scrive due incassi sullo
 * stesso bonifico e risponde 200.
 */
function ramoDi(apertura: RegExp): string {
    // Confini nella MASCHERA, testo dal CODICE: un `END IF` fra gli apici
    // chiuderebbe il ramo dove fa comodo a chi lo scrive, non dove finisce.
    const i = MASCHERA.search(apertura)
    if (i < 0) return ''
    const rel = MASCHERA.slice(i).search(/\bTHEN\b/i)
    if (rel < 0) return ''
    const inizio = i + rel + 'THEN'.length
    let prof = 1
    const re = /\bEND\s+IF\b|\bIF\b/gi
    re.lastIndex = inizio
    let m: RegExpExecArray | null
    while ((m = re.exec(MASCHERA)) !== null) {
        if (/^END/i.test(m[0])) {
            prof--
            if (prof === 0) return CODICE.slice(inizio, m.index)
        } else {
            prof++
        }
    }
    return CODICE.slice(inizio)
}

/**
 * A quanti `IF … THEN` APERTI si trova la prima riga che corrisponde ad `ago`
 * (`null` se quella riga non c'è più).
 *
 * 🔴 È LA CHIUSURA DELLA COMPENSAZIONE, l'ultima porta lasciata aperta dai due
 * conteggi del test 5. Annidare una guardia in un `IF` che non si avvera la lascia
 * scritta parola per parola — quindi invisibile a `condizioniIfCon`, che ne legge
 * la FORMA — mentre smette di valere; e un `IF` tolto altrove più un `RAISE` di
 * riempimento rimettono in pari i 43 rami e i 32 `RAISE`. Tre mutazioni così,
 * misurate «7 passed» prima di questa funzione.
 * La profondità non è un totale e per questo non si compensa: dice a quanti `IF`
 * aperti sta QUELLA riga, e un blocco tolto o aggiunto altrove — che apre e chiude
 * — non la muove di uno. Né la muovono le riformattazioni: nessuna aggiunge rami.
 */
function profonditaIf(ago: RegExp): number | null {
    const i = MASCHERA.search(ago)
    if (i < 0) return null
    let prof = 0
    const re = /\bEND\s+IF\b|\bIF\b/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(MASCHERA)) !== null && (m.index ?? 0) < i) {
        if (/^END/i.test(m[0])) prof--
        else prof++
    }
    return prof
}

/**
 * LISTA BIANCA degli identificatori che possono comparire in un argomento di
 * `RAISE`. Non è una lista di comodo: è la stessa scelta di
 * `@/lib/logging/redact`, e per la stessa ragione.
 *
 * Una lista NERA (`v_desc`, `descrizione`) chiude i due nomi che si sono visti e
 * lascia aperti tutti gli altri — misurato: `RAISE … , v_idx, v_voce` passava
 * indisturbato, e `v_voce` è il jsonb INTERO della voce, descrizione compresa.
 * Qui passa solo ciò che è stato dichiarato sicuro perché NON può trasportare
 * testo del chiamante:
 *   · `v_idx`, `v_qta`, `v_rows`, `v_sum_*`, `v_tot`, `v_ecc` → numeri;
 *   · `v_mov`, `v_aid`, `v_txid`, `v_anc_*`, `v_id_nuove`, `v_id_tick` → uuid;
 *   · `COALESCE`, `array_length` → funzioni, non dati;
 *   · `v_stato_att` → l'UNICA variabile `text` ammessa, e solo perché quando
 *     arriva a un messaggio la validazione del vocabolario l'ha già ridotta a uno
 *     di tre letterali. Quella riduzione è sorvegliata dal test «2» qui sotto:
 *     se cade lei, questa riga smette di essere sicura. I due test si reggono a
 *     vicenda, ed è voluto.
 * Aggiungere un nome qui è una decisione sui dati dei minori, non una comodità.
 */
const IDENT_AMMESSI_NEI_RAISE = new Set([
    'v_idx', 'v_qta', 'v_rows', 'v_tot', 'v_ecc',
    'v_sum_voci', 'v_sum_nuove', 'v_sum_tick', 'v_sum_ric',
    'v_mov', 'v_aid', 'v_txid',
    'v_anc_pid', 'v_anc_risolto', 'v_anc_incasso', 'v_anc_i_nuova', 'v_anc_i_tick',
    'v_id_nuove', 'v_id_tick',
    'v_stato_att',
    'COALESCE', 'array_length',
])

/**
 * Le parole che in un `RAISE` sono SINTASSI e non dati. Tutto il resto, ovunque
 * stia nell'istruzione, passa dalla lista bianca qui sopra.
 *
 * 🔴 PERCHÉ «OVUNQUE STIA», che è la correzione del quinto giro. Fino a qui il
 * controllo guardava i soli ARGOMENTI POSIZIONALI, raccolti dividendo alle
 * virgole di primo livello e buttando via il `USING`. Due forme perfettamente
 * ordinarie gli passavano davanti, misurate entrambe «7 passed»:
 *   · `RAISE EXCEPTION 'voce nuova non valida: ' || v_voce::text;` — **non ha
 *     virgole**, quindi l'elenco degli argomenti era vuoto e non si controllava
 *     NIENTE; ed esce il jsonb intero della voce, descrizione compresa;
 *   · `RAISE EXCEPTION '…', v_idx USING DETAIL = v_voce::text;` — il `USING` era
 *     tagliato via prima di guardare, quindi la PII viaggiava nella clausola che
 *     il controllo aveva deciso di non leggere.
 * Un messaggio si compone in almeno cinque modi (`%`, `||`, `format()`, `USING
 * DETAIL`, `USING HINT`): l'unica difesa che non dipende da quale ha scelto chi
 * scrive è guardare l'istruzione INTERA, tolti i letterali e tolta la sintassi.
 */
const PAROLE_CHIAVE_RAISE = new Set([
    'RAISE', 'EXCEPTION', 'USING', 'ERRCODE', 'MESSAGE', 'DETAIL', 'HINT',
])

const INSERT_PAGAMENTI = insertPagamenti()
const RAISE = raiseDelFile()

describe('lock architettura · la RPC composita non torna indietro sulle quattro correzioni, e non si aggira', () => {
    it('sanity: il file si legge, ed è quello giusto (senza, ogni asserzione qui sotto sarebbe verde sul vuoto)', () => {
        // 🔴 PRIMA DI TUTTO: che un file ci SIA. `ultimaMigrazioneDellaRpc()`
        //   restituisce la stringa vuota quando nessuna migrazione ridefinisce la
        //   funzione, e senza questa riga `SQL` sarebbe `''` — cioè ogni `matchAll`
        //   qui sotto darebbe zero, ogni elenco atteso sarebbe vuoto, e il lock
        //   resterebbe verde sul nulla. È la specie di verde falso che questo file
        //   condanna dalla riga uno, e la prima che si chiude.
        expect(
            NOME_FILE_SQL,
            `nessun file di \`supabase/migrations/\` contiene \`${FIRMA_FUNZIONE}\`. O la RPC è ` +
                'stata rinominata, o il suo corpo è stato spostato fuori dalle migrazioni: in ' +
                'entrambi i casi questo lock non starebbe guardando niente, e le quattro decisioni ' +
                'di una RPC che muove denaro resterebbero senza nessuna sorveglianza.',
        ).not.toBe('')
        expect(
            SQL.length,
            `la migrazione della RPC (\`${NOME_FILE_SQL}\`) non si legge: questo lock non starebbe ` +
                'misurando niente.',
        ).toBeGreaterThan(5000)
        expect(
            CODICE,
            `in \`${NOME_FILE_SQL}\` non c'è più \`${FIRMA_FUNZIONE}\` fuori dai commenti: il file ` +
                'è stato scelto perché lo NOMINA, ma non ridefinisce la funzione. Le asserzioni qui ' +
                'sotto guarderebbero un file che non descrive più niente.',
        ).toContain(FIRMA_FUNZIONE)
        expect(
            INSERT_PAGAMENTI.length,
            'gli `INSERT INTO public.pagamenti` non sono due. Sono le due voci che questa fetta crea ' +
                '(`voci_nuove` e `voci_ticket`): se non ci sono, la regola sulla sede qui sotto non ' +
                'ha più un soggetto.',
        ).toBe(2)
        expect(
            RAISE.length,
            'nessun `RAISE EXCEPTION` nel file: le validazioni sono sparite, e con loro tutto ciò ' +
                'che questo lock controlla sui messaggi.',
        ).toBeGreaterThan(10)

        // ⚠️ E LE SINTASSI CHE QUESTO LOCK SA LEGGERE SONO QUESTE TRE RIGHE, che
        //   sono il presupposto di tutte le altre asserzioni. Gli scanner di questo
        //   file (`fineIstruzione`, `mascheraLetterali`, `senzaLetterali`,
        //   `dividiTopLevel`, `gruppoParentesi`) conoscono UNA sola forma di
        //   letterale — `'…'`, con `''` per l'apostrofo — e le regex dell'inventario
        //   conoscono UNA sola forma di nome: `\w+`. Quindi:
        //     · niente virgolette doppie. Misurato, «7 passed» prima di questa riga:
        //       `UPDATE "pagamenti" SET scuola_id = v_scuola …` non compare in
        //       NESSUN inventario, perché dopo `UPDATE ` c'è una virgoletta e `\w+`
        //       non la prende. È il difetto n. 7 della testata — la sede derivata
        //       bene e poi riscritta — con otto virgolette addosso;
        //     · niente `E'…'`: lì `\'` è un apice, e chi conta gli apici a coppie
        //       sbaglia la parità da quel punto in poi;
        //     · niente dollar-quoting oltre ai due `$guardia$` (il `$$` del corpo
        //       non ha tag): un `$x$'$x$` contiene un apice dispari e disallinea le
        //       stesse coppie.
        //   Le ultime due oggi cadono comunque (misurate rosse), ma per ragioni che
        //   non dipendono da questa cecità: qui il perimetro si dichiara invece di
        //   sperarci. Se una di queste sintassi servisse davvero, prima si insegna
        //   agli scanner a leggerla — e poi si cambia questa riga.
        expect(
            [
                [...CODICE.matchAll(/"/g)].length,
                [...CODICE.matchAll(/(?<![\w."])E'/gi)].length,
                [...CODICE.matchAll(/\$([A-Za-z_]\w*)\$/g)].map((m) => m[1]).join(','),
            ],
            'questa migrazione usa una sintassi che il lock non sa leggere: virgolette doppie, un ' +
                'letterale `E\'…\'` o un dollar-quoting con un tag diverso da `guardia`.\n' +
                'Non è una questione di stile: ogni regola di questo file conta gli apici a coppie e ' +
                'legge i nomi come `\\w+`. Con una di queste tre forme in mezzo, le asserzioni ' +
                'continuano a passare mentre guardano un testo che non è più quello che PostgreSQL ' +
                'esegue.',
        ).toEqual([0, 0, 'guardia,guardia'])
        // 🔴 E IL DOLLAR-QUOTING SENZA TAG, che la riga qui sopra NON può vedere:
        //   `/\$([A-Za-z_]\w*)\$/` pretende almeno un carattere fra i due `$`, quindi
        //   `$$` non compare mai in quell'elenco. Misurato sul database vivo: dentro
        //   un `$$ … $$` usato come LETTERALE (non come corpo) il `/*` è TESTO per
        //   PostgreSQL (`F2G-F n=44`) mentre qui apre un commento — cioè cancella
        //   dagli occhi del lock tutto ciò che sta fino alla chiusura. Misurato:
        //   `COMMENT ON SCHEMA public IS $$x/*$$;` + `CREATE TRIGGER … BEFORE INSERT
        //   ON public.pagamenti` + `COMMENT ON SCHEMA public IS $$x*/$$;` → «7
        //   passed», col trigger invisibile a TUTTE le regole di questo file, sanity
        //   compresa. Si conta su `SQL`, non su `CODICE`: `CODICE` è proprio ciò che
        //   l'attacco acceca.
        expect(
            (SQL.match(/\$\$/g) ?? []).length,
            'i dollar-quote SENZA tag non sono più esattamente due (`AS $$` e `END $$;`).\n' +
                'Dentro un `$$ … $$` usato come letterale un `/*` è testo per PostgreSQL e ' +
                'commento per lo scanner di questo file: tutto ciò che sta fra due `$$` così ' +
                'costruiti sparisce dalla vista di OGNI regola qui sotto.',
        ).toBe(2)
    })

    it('🔴 1 · la sede di una voce creata qui viene DALL\'ALUNNO, mai dal payload', () => {
        // (a) `scuola_id` si legge dal jsonb UNA volta sola, ed è la TESTATA:
        //     `v_scuola := (p->>'scuola_id')` — la sede del DOCUMENTO. Nessun
        //     `voce->>'scuola_id'`, che è la riga con cui il difetto era nato.
        const lettureDalPayload = [...CODICE.matchAll(/(\w+)\s*->>\s*'scuola_id'/g)].map((m) => m[1])
        expect(
            lettureDalPayload,
            'in questa migrazione `scuola_id` si legge dal jsonb solo da `p` (la testata della ' +
                'transazione, cioè la sede del DOCUMENTO). Qui viene letto anche da: ' +
                `${[...new Set(lettureDalPayload.filter((v) => v !== 'p'))].join(', ')}. ` +
                'La sede di una voce creata dalla RPC deve venire da `alunni.scuola_id`, mai dal ' +
                'client: un valore sbagliato archivierebbe la voce nel plesso di un altro bambino ' +
                'IN SILENZIO, con un 200 sopra — ed è esattamente l\'incidente che ha prodotto il ' +
                '403 di `transazioni/route.ts:148-177` sulle voci esistenti.',
        ).toEqual(lettureDalPayload.map(() => 'p'))

        // (b) nessun ripiego sulla sede: un `COALESCE(<sede del client>, v_scuola)`
        //     è la forma esatta con cui la prima stesura sbagliava.
        const coalesceConSede = [...CODICE.matchAll(/COALESCE\s*\([^;]*?scuola[^;]*?\)/gi)].map((m) =>
            m[0].replace(/\s+/g, ' ').slice(0, 120),
        )
        expect(
            coalesceConSede,
            'c\'è un `COALESCE` che nomina una sede: ' + coalesceConSede.join(' | ') + '\n' +
                'La sede di una voce non ha ripieghi. `COALESCE(voce.scuola_id, v_scuola)` — la riga ' +
                'della prima stesura — mette in fila due valori che arrivano ENTRAMBI dal client e ' +
                'che nessuno confronta con niente: non è un fallback, è una sede indovinata due volte.',
        ).toEqual([])

        // (c) e nei due INSERT la colonna `scuola_id` è alimentata dagli array di
        //     sedi DERIVATE, mai da `v_scuola` (che è la sede del documento).
        const sedi = INSERT_PAGAMENTI.map((i) => valorePerColonna(i, 'scuola_id'))
        expect(
            sedi[0],
            'il primo `INSERT INTO public.pagamenti` (le `voci_nuove`) non scrive `v_sedi_nuove[v_i]` ' +
                `in \`scuola_id\`, ma «${sedi[0]}». Quell'array è l'unico posto in cui la sede è stata ` +
                'DERIVATA da `alunni.scuola_id` durante la validazione, prima di qualunque scrittura.',
        ).toMatch(/^v_sedi_nuove\[\s*v_i\s*\]$/)
        expect(
            sedi[1],
            'il secondo `INSERT INTO public.pagamenti` (le `voci_ticket`) non scrive `v_scuola_voce` ' +
                `in \`scuola_id\`, ma «${sedi[1]}».`,
        ).toBe('v_scuola_voce')
        // `v_scuola_voce` è una variabile: vale solo quanto vale ciò che ci finisce
        // dentro. Le SUE sorgenti sono due e sono entrambe derivazioni dall'alunno.
        expect(
            assegnazioniA('v_scuola_voce'),
            'a `v_scuola_voce` viene assegnato qualcosa che non è `v_sedi_tick[v_i]`. Quella ' +
                'variabile finisce dritta in `pagamenti.scuola_id` e nel movimento di ledger della ' +
                'mensa: qualunque altra sorgente rimette in piedi la sede dal client.',
        ).toEqual(['v_sedi_tick[v_i]'])

        // (d) E GLI ARRAY? Sono l'unico posto in cui la sede viene DERIVATA, e
        //     fino a questa stesura nessuno li guardava: il lock leggeva il NOME
        //     scritto nell'INSERT e le sorgenti di `v_scuola_voce`, mai la riga
        //     `v_sedi_* := v_sedi_* || …`. Misurato: sostituendo `v_scuola_voce`
        //     con `v_scuola` in quelle due righe il lock restava «6 passed», e in
        //     `pg_temp` la voce nasceva sulla sede DICHIARATA DAL CLIENT.
        for (const nome of ['v_sedi_nuove', 'v_sedi_tick']) {
            expect(
                assegnazioniA(nome),
                `\`${nome}\` non viene più riempito solo con la sede derivata dall'alunno.\n` +
                    `Le uniche due forme ammesse sono \`ARRAY[]::uuid[]\` (l'inizializzazione) e ` +
                    `\`${nome} || v_scuola_voce\` (l'accodamento della sede letta da \`alunni\`). ` +
                    'Questa riga è il punto in cui la sede si DECIDE: l\'INSERT più sotto si limita ' +
                    'a rileggerla, quindi un lock che guardasse solo l\'INSERT vedrebbe il nome ' +
                    'giusto sopra un valore sbagliato.',
            ).toEqual(['ARRAY[]::uuid[]', `${nome} || v_scuola_voce`])
        }

        // (e) …e la sede accodata dev'essere quella DI QUELL'ALUNNO: la lettura si
        //     pretende per intero, `WHERE a.id = v_aid` compreso. Con la sola
        //     presenza di `SELECT … FROM public.alunni` il lock restava verde sia
        //     cambiando il `WHERE` in `v_pagante` (la sede del GENITORE pagante),
        //     sia cancellando le due letture del tutto — verde sul vuoto.
        const LETTURA_SEDE =
            /SELECT\s+a\.scuola_id\s+INTO\s+v_scuola_voce\s+FROM\s+public\.alunni\s+a\s+WHERE\s+a\.id\s*=\s*v_aid\s*;/g
        expect(
            [...CODICE.matchAll(LETTURA_SEDE)].length,
            'le letture `SELECT a.scuola_id INTO v_scuola_voce FROM public.alunni a WHERE a.id = ' +
                'v_aid;` non sono DUE (una per `voci_nuove`, una per `voci_ticket`).\n' +
                'Si pretende la forma intera, `WHERE` compreso: `WHERE a.id = v_pagante` archivierebbe ' +
                'la voce sulla sede di un altro soggetto — silenziosamente, perché una sede c\'è e ' +
                'plausibile lo è. E si pretende il CONTEGGIO, perché un controllo che filtra ciò che ' +
                'trova è soddisfatto anche quando non trova niente.',
        ).toBe(2)

        // (f) `v_aid` è l'alunno DELLA VOCE IN CORSO, sempre: è la variabile con
        //     cui si legge la sede, e spostarla un rigo prima della SELECT
        //     sposterebbe la sede senza toccare né la SELECT né l'INSERT.
        const alunniLetti = assegnazioniA('v_aid')
        const alunniEstranei = alunniLetti.filter(
            (s) => !/^\(v_(?:voce|ric)->>'alunno_id'\)::uuid$/.test(s),
        )
        expect(
            alunniEstranei,
            '`v_aid` riceve qualcosa che non è l\'`alunno_id` dell\'elemento in corso: ' +
                alunniEstranei.join(' | ') + '\n' +
                'È la chiave con cui si legge `alunni.scuola_id`: se non è l\'alunno della voce, la ' +
                'voce nasce nel plesso di un altro bambino con tutte le righe al posto giusto.',
        ).toEqual([])
        expect(
            alunniLetti.length,
            'le assegnazioni di `v_aid` sono cambiate di numero: erano quattro (voci nuove, voci ' +
                'ticket in validazione, voci ticket in scrittura, ricariche storiche). Una in più o ' +
                'in meno significa che un ciclo ha cambiato soggetto.',
        ).toBe(4)

        // (g) L'ARRAY SI LEGGE PER POSIZIONE, e la posizione è l'unico filo che
        //     tiene insieme il ciclo di validazione (dove la sede si legge) e
        //     quello di scrittura (dove si usa). Quel filo si taglia senza
        //     toccare né la lettura né l'INSERT: misurato su questo file —
        //     `v_i := v_i + 1;` diventato `v_i := 1;` nel ciclo di scrittura fa
        //     prendere a TUTTE le voci nuove la sede del PRIMO alunno
        //     dell'elenco, cioè esattamente il plesso sbagliato su un bonifico
        //     cross-sede, che è il caso per cui questa fetta esiste. Il lock
        //     restava «7 passed»: `v_sedi_nuove[v_i]` era ancora lì, scritto
        //     bene, e puntava sempre alla stessa casella.
        expect(
            assegnazioniA('v_i'),
            'il cursore `v_i` non avanza più di uno per iterazione in tutti e quattro i cicli ' +
                '(scrittura voci nuove, scrittura ticket, incassi delle nuove, incassi dei ticket).\n' +
                'È l\'indice con cui si rilegge `v_sedi_nuove` / `v_sedi_tick` / `v_id_*`: se non ' +
                'avanza, ogni voce eredita la sede — e l\'id — della prima.',
        ).toEqual(['0', 'v_i + 1', '0', 'v_i + 1', '0', 'v_i + 1', '0', 'v_i + 1'])
        expect(
            assegnazioniA('v_idx'),
            'l\'indice 0-based mostrato nei messaggi non parte più da `-1` o non avanza di uno: i ' +
                'due cicli di validazione nominerebbero tutti la stessa voce, e «voce nuova #0» ' +
                'smetterebbe di dire quale.',
        ).toEqual(['-1', 'v_idx + 1', '-1', 'v_idx + 1'])
        const cicliNuovi = [...CODICE.matchAll(/FOR\s+\w+\s+IN\s+(SELECT[\s\S]*?)\s+LOOP/g)]
            .map((m) => m[1].replace(/\s+/g, ' ').trim())
            .filter((s) => /v_nuove|v_tickets/.test(s))
        expect(
            cicliNuovi,
            'i cicli sui due array nuovi non sono più sei letture nude di `jsonb_array_elements`: ' +
                cicliNuovi.join(' | ') + '\n' +
                'Un `ORDER BY` in uno solo dei due (validazione o scrittura) disallineerebbe le ' +
                'posizioni senza cambiare una riga di ciò che questo lock guarda: le sedi resterebbero ' +
                'tutte corrette e tutte sulla voce sbagliata.',
        ).toEqual([
            'SELECT * FROM jsonb_array_elements(v_nuove)',
            'SELECT * FROM jsonb_array_elements(v_tickets)',
            'SELECT * FROM jsonb_array_elements(v_nuove)',
            'SELECT * FROM jsonb_array_elements(v_tickets)',
            'SELECT * FROM jsonb_array_elements(v_nuove)',
            'SELECT * FROM jsonb_array_elements(v_tickets)',
        ])

        // (h) e la riga scritta nomina lo STESSO alunno di cui si è letta la sede:
        //     `alunno_id` e `scuola_id` dello stesso INSERT devono parlare di un
        //     bambino solo.
        expect(
            valorePerColonna(INSERT_PAGAMENTI[0], 'alunno_id'),
            'il primo `INSERT INTO public.pagamenti` non scrive più `(v_voce->>\'alunno_id\')::uuid` ' +
                'in `alunno_id`. La sede accanto viene da `v_sedi_nuove[v_i]`, cioè dall\'alunno ' +
                'letto in validazione: se le due colonne nominano bambini diversi, la riga è ' +
                'internamente incoerente e nessun vincolo del database se ne accorge.',
        ).toBe("(v_voce->>'alunno_id')::uuid")
        expect(
            valorePerColonna(INSERT_PAGAMENTI[1], 'alunno_id'),
            'il secondo `INSERT INTO public.pagamenti` non scrive più `v_aid` in `alunno_id`: è la ' +
                'stessa variabile con cui è stata letta la sede in `v_scuola_voce`, e devono restare ' +
                'la stessa cosa.',
        ).toBe('v_aid')
        for (const [i, ins] of INSERT_PAGAMENTI.entries()) {
            expect(
                /\bv_scuola\b/.test(ins),
                `l'INSERT #${i} in \`public.pagamenti\` usa \`v_scuola\`, che è la sede del ` +
                    'DOCUMENTO dichiarata dal client in testata al payload — non la sede del bambino. ' +
                    'Su un bonifico che paga figli di plessi diversi (il caso per cui questa fetta ' +
                    'esiste) archivierebbe la voce nella sede sbagliata senza dirlo a nessuno.',
            ).toBe(false)
        }

        // (i) 🔴 E TUTTO QUANTO SOPRA CADE CON UNA RIGA, se si guardano le sole
        //     assegnazioni `:=`. In plpgsql una variabile cambia valore in sei
        //     modi, e i sette tentativi con cui questo lock era stato provato
        //     erano tutti e sette nella stessa classe. Misurate poi, e tutte
        //     «7 passed» col lock precedente:
        //       · `SELECT array_agg(v_scuola) INTO v_sedi_nuove FROM
        //         jsonb_array_elements(v_nuove);` dopo il ciclo di validazione →
        //         TUTTE le voci nuove nascono sulla sede del DOCUMENTO, con
        //         l'INSERT, il `WHERE a.id = v_aid` e il cursore intatti;
        //       · `SELECT v_scuola INTO v_scuola_voce;` un rigo prima
        //         dell'accodamento → la stessa cosa, una voce per volta;
        //       · una SECONDA `SELECT … INTO v_scuola_voce` da un'altra tabella
        //         dopo quella buona → il conteggio `LETTURA_SEDE = 2` resta
        //         soddisfatto dalla lettura giusta, e la sovrascrittura passa.
        //     È il difetto ORIGINALE di questa fetta — la sede presa dal client —
        //     rimesso in piedi col lock verde. Quindi le tre variabili che
        //     decidono la sede si sorvegliano PER SOTTRAZIONE: si cancella ogni
        //     forma dichiarata lecita e si guarda cosa avanza. Un uso in più
        //     resta sul tavolo, qualunque sintassi abbia scelto.
        const FORME_SEDE = [
            /v_sedi_nuove\s+uuid\[\]\s*:=\s*ARRAY\[\]::uuid\[\]\s*;/g,
            /v_sedi_tick\s+uuid\[\]\s*:=\s*ARRAY\[\]::uuid\[\]\s*;/g,
            /v_scuola_voce\s+uuid\s*;/g,
            /SELECT\s+a\.scuola_id\s+INTO\s+v_scuola_voce\s+FROM\s+public\.alunni\s+a\s+WHERE\s+a\.id\s*=\s*v_aid\s*;/g,
            /v_sedi_nuove\s*:=\s*v_sedi_nuove\s*\|\|\s*v_scuola_voce\s*;/g,
            /v_sedi_tick\s*:=\s*v_sedi_tick\s*\|\|\s*v_scuola_voce\s*;/g,
            /v_scuola_voce\s*:=\s*v_sedi_tick\[\s*v_i\s*\]\s*;/g,
            /v_sedi_nuove\[\s*v_i\s*\]\s*,/g,
            /\(\s*v_aid,\s*v_scuola_voce,\s*v_cat,/g,
            /\(\s*v_aid,\s*v_scuola_voce,\s*'ricarica',/g,
        ]
        for (const nome of ['v_sedi_nuove', 'v_sedi_tick', 'v_scuola_voce']) {
            const avanzi = usiNonClassificati(nome, FORME_SEDE)
            expect(
                avanzi,
                `c'è un uso di \`${nome}\` che non è nessuno di quelli dichiarati:\n  ` +
                    avanzi.join('\n  ') + '\n' +
                    'Queste tre variabili SONO la derivazione della sede dall\'alunno: la lettura da ' +
                    '`alunni`, i due array che la conservano fino alla scrittura, e la casella che ' +
                    'l\'INSERT rilegge. Un uso in più — una seconda lettura, un `INTO` che le ' +
                    'sovrascrive, un accodamento da un\'altra fonte — archivia le voci nel plesso ' +
                    'sbagliato IN SILENZIO, con tutte le righe che questo file controlla ancora al ' +
                    'posto giusto. Se l\'uso nuovo è legittimo, si aggiunge a `FORME_SEDE` ' +
                    'spiegando perché è sicuro, non perché fa passare il test.',
            ).toEqual([])
        }

        // (l) …e le stesse variabili non vengono scritte da nessuna delle forme
        //     che `assegnazioniA` non sa leggere. Vale anche per il cursore e per
        //     l'alunno: `GET DIAGNOSTICS v_i = ROW_COUNT;` congela l'indice
        //     esattamente come `v_i := 1;`, ma per una regex che cerca `:=` non
        //     esiste.
        expect(
            scrittureNonDirette('v_scuola_voce'),
            'le scritture su `v_scuola_voce` che non passano da `:=` non sono più esattamente le ' +
                'due letture da `alunni`. Una terza `… INTO v_scuola_voce` è una sede che arriva da ' +
                'un\'altra parte, e nessuna delle regole qui sopra la vede.',
        ).toEqual([
            'INTO v_scuola_voce FROM public.alunni a WHERE a.id = v_aid',
            'INTO v_scuola_voce FROM public.alunni a WHERE a.id = v_aid',
        ])
        for (const nome of [
            'v_sedi_nuove', 'v_sedi_tick', 'v_i', 'v_idx', 'v_aid',
            'v_scuola', 'v_mov', 'v_stato_att', 'v_anc_risolto', 'v_anc_incasso',
        ]) {
            expect(
                scrittureNonDirette(nome),
                `\`${nome}\` viene scritto da una forma che non è \`:=\` — un \`SELECT … INTO\`, un ` +
                    '`GET DIAGNOSTICS`, un `FOR … IN` — e `assegnazioniA` è cieca a tutte e tre. ' +
                    'Queste dieci variabili sono quelle da cui dipendono la sede, l\'ordine delle ' +
                    'voci e l\'esito del compare-and-swap: se una di loro cambia valore in un punto ' +
                    'che nessuno guarda, tutte le asserzioni di questo file restano vere e la ' +
                    'funzione fa un\'altra cosa.',
            ).toEqual([])
        }
    })

    it('🔴 2 · gli stati attesi del CAS sono esattamente tre, e `confermato` non è fra loro', () => {
        const clausola = /v_stato_att\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(CODICE)
        expect(
            clausola,
            'non c\'è più la validazione `v_stato_att NOT IN (…)`. Senza vocabolario, `stato_atteso` ' +
                'accetta qualunque stringa: un refuso diventa «un altro operatore ti ha preceduto» ' +
                'per sempre, e `\'confermato\'` diventa un doppio incasso.',
        ).not.toBeNull()
        const ammessi = [...(clausola?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1])
        expect(
            ammessi,
            `gli stati attesi ammessi sono cambiati: [${ammessi.join(', ')}].\n` +
                'Devono essere esattamente `da_abbinare`, `suggerito`, `ignorato` — tre dei quattro ' +
                'valori del CHECK della tabella. `confermato` è escluso APPOSTA: con ' +
                'confermato→confermato il compare-and-swap riscriverebbe `incasso_id` e ' +
                '`pagamento_id` **senza stornare l\'incasso precedente** (che resta attaccato al suo ' +
                'pagamento) e **senza il guard «già fatturato»** che il riabbinamento applica altrove ' +
                '(`riconciliazione/[id]/route.ts`: il 409 «Movimento già confermato» e la lettura ' +
                'di `fatture_emesse` — citati per contenuto perché quel file cambia in questo ' +
                'branch). Un bonifico da €X inciderebbe ' +
                '2×€X, con un 200 sopra. Il riabbinamento passa dal `riapri`, che quei presidi ce li ha.',
        ).toEqual(['da_abbinare', 'suggerito', 'ignorato'])

        // ⚠️ LEGGERE L'ELENCO NON BASTA: quella parentesi può restare intatta e
        //   non essere mai consultata. Misurato su questo file — anteponendo
        //   `AND v_stato_att <> 'confermato'` alla stessa congiunzione,
        //   `'confermato'` SALTA il `RAISE` e il lock restava «6 passed». A valle
        //   il CAS diventa `stato = 'confermato'`: confermato→confermato, cioè il
        //   doppio incasso descritto qui sopra. Quindi si pretende la condizione
        //   INTERA, non il suo pezzo più visibile.
        expect(
            condizioniIfCon(/v_stato_att\s+NOT\s+IN/i),
            'la guardia del vocabolario non è più esattamente `IF v_stato_att IS NOT NULL AND ' +
                'v_stato_att NOT IN (…) THEN`. Qualunque congiunto in più la disarma per il valore ' +
                'che nomina, lasciando l\'elenco dei tre stati al suo posto e questo lock verde: è ' +
                'il modo esatto in cui `\'confermato\'` tornerebbe ammesso.',
        ).toEqual([
            "v_stato_att IS NOT NULL AND v_stato_att NOT IN ('da_abbinare', 'suggerito', 'ignorato')",
        ])

        // E l'inventario COMPLETO di `v_stato_att`: sette usi, tutti dichiarati.
        // Contarli non basterebbe (un uso in più e uno in meno si compensano), e
        // riconoscerli uno per uno lascerebbe passare quelli che non si guardano:
        // qui si cancella il lecito e si mostra ciò che avanza.
        const usiStato = usiNonClassificati('v_stato_att', [
            /v_stato_att\s+text\s*:=\s*NULLIF\(p->>'stato_atteso',\s*''\)/g,
            /v_stato_att\s+IS\s+NOT\s+NULL/gi,
            /v_stato_att\s+NOT\s+IN\s*\([^)]*\)/gi,
            /v_stato_att\s+IS\s+NULL/gi,
            /stato\s*=\s*v_stato_att/gi,
            /COALESCE\(v_stato_att,\s*'[^']*'\)/gi,
        ])
        expect(
            usiStato,
            'c\'è un uso di `v_stato_att` che non è nessuno dei sette dichiarati (dichiarazione, ' +
                'due `IS NOT NULL`, il `NOT IN`, l\'`IS NULL` del CAS, il `stato = v_stato_att` del ' +
                'CAS, il `COALESCE` del messaggio KV409):\n  ' + usiStato.join('\n  ') + '\n' +
                'Ogni confronto in più su questa variabile è una decisione sul doppio incasso presa ' +
                'in un punto che nessuno sorveglia — e, se finisce in un messaggio, anche un canale ' +
                'di testo verso i log (vedi la lista bianca del test 4, che dà `v_stato_att` per ' +
                'sicuro PROPRIO perché il vocabolario lo riduce a tre letterali).',
        ).toEqual([])

        // L'altra metà della stessa protezione: senza `stato_atteso` il CAS non
        // deve poter riconfermare una riga già confermata.
        //
        // ⚠️ SI PRETENDE IL `WHERE` PER INTERO, non la presenza del `CASE`. Un
        //   controllo di sola presenza è verde anche quando il `CASE` non decide
        //   più niente: misurato su questo file — avvolgendo la condizione in
        //   `(… END OR TRUE)` il compare-and-swap smette di confrontare qualunque
        //   cosa, l'`UPDATE` riesce sempre, e con lui la riconferma di una riga
        //   già confermata. Il `CASE` resta lì, intatto e irrilevante.
        const iUpdate = CODICE.search(/UPDATE\s+public\.riconciliazione_movimenti\b/i)
        const fineUpdate = fineIstruzione(CODICE, Math.max(0, iUpdate))
        const corpoUpdate =
            iUpdate < 0 ? '' : CODICE.slice(iUpdate, fineUpdate < 0 ? CODICE.length : fineUpdate)
        const iWhere = corpoUpdate.search(/\bWHERE\b/i)
        expect(
            iWhere < 0 ? null : corpoUpdate.slice(iWhere + 5).replace(/\s+/g, ' ').trim(),
            'la clausola `WHERE` dell\'`UPDATE` su `riconciliazione_movimenti` non è più esattamente ' +
                'quella attesa. È il compare-and-swap: `id = v_mov` sceglie la riga, il `CASE` decide ' +
                'se la corsa è vinta. Senza `stato <> \'confermato\'` nel ramo di default due ' +
                'conferme sullo stesso bonifico passano entrambe; con un congiunto sempre vero non ' +
                'ne perde nessuna, ed è la stessa cosa detta peggio. `ROW_COUNT = 0` è il solo modo ' +
                'in cui questa funzione sa di aver perso.',
        ).toBe(
            "id = v_mov AND CASE WHEN v_stato_att IS NULL THEN stato <> 'confermato' " +
                'ELSE stato = v_stato_att END',
        )

        // …E ANCHE IL `SET`, per intero. Il `WHERE` dice CHI vince la corsa, il
        // `SET` dice che cosa il vincitore scrive — ed è lì che sta la decisione
        // n. 15 del titolare: `scuola_id = v_scuola`, la sede del DOCUMENTO,
        // deliberatamente diversa dalla regola del PATCH («il movimento assume la
        // sede del pagamento confermato»). Misurato: `scuola_id =
        // v_sedi_nuove[1]` — cioè la sede del PRIMO BAMBINO invece di quella
        // scelta dall'operatore — passava, «7 passed». Una decisione dichiarata
        // deliberata in quattro punti di prosa e nel `COMMENT ON FUNCTION`, e in
        // nessuna asserzione, è una decisione affidata a un `git blame` futuro.
        const iSet = corpoUpdate.search(/\bSET\b/i)
        expect(
            iSet < 0 || iWhere < 0 ? null : corpoUpdate.slice(iSet + 3, iWhere).replace(/\s+/g, ' ').trim(),
            'la clausola `SET` dell\'`UPDATE` su `riconciliazione_movimenti` non è più esattamente ' +
                'quella attesa. Le OTTO colonne scritte qui sono il patto della conferma: lo stato, ' +
                'il legame con la transazione, la voce àncora, il suo incasso, la sede del DOCUMENTO ' +
                '(`v_scuola`, non la sede del pagamento: §3 della testata), e chi/quando. ' +
                'Cambiare `scuola_id` in una sede derivata dai bambini ribalta in silenzio la ' +
                'decisione n. 15 — un bonifico multi-sede produce UN documento, intestato alla sede ' +
                'che l\'operatore sceglie — e nessun\'altra riga di questo file se ne accorgerebbe.\n' +
                '⚠️ E l\'OTTAVA, `abbinato_auto_il` (dal 2026-09-20), sta QUI e non in un `UPDATE` ' +
                'dopo la RPC: fuori dal compare-and-swap non sarebbe atomica, e una riga confermata ' +
                'dalla macchina ma non marcata è una riga che l\'annullamento in blocco non ' +
                'troverebbe più. Il `CASE` è portante in tutt\'e due i versi: quando la chiave manca ' +
                'AZZERA la marca, cioè una ricomposizione fatta A MANO smette di risultare ' +
                'automatica. Sostituirlo con `abbinato_auto_il = now()` marcherebbe automatica OGNI ' +
                'conferma, anche quella di un\'operatrice, e l\'annullamento in blocco disferebbe il ' +
                'suo lavoro.',
        ).toBe(
            "stato = 'confermato', transazione_id = v_txid, pagamento_id = v_anc_risolto, " +
                'incasso_id = v_anc_incasso, scuola_id = v_scuola, confermato_da = v_reg, ' +
                "confermato_il = now(), abbinato_auto_il = CASE WHEN " +
                "COALESCE((p->>'abbinato_auto')::boolean, false) THEN now() ELSE NULL END",
        )

        // E CHE COSA FINISCE IN `pagamento_id`/`incasso_id`: l'ÀNCORA. Trovato
        // attaccando questo file dopo averlo corretto —
        // `v_anc_risolto := v_id_nuove[v_anc_i_nuova + 1];` diventato
        // `:= v_id_nuove[1];` passava, «7 passed»: l'indice indicato dal chiamante
        // veniva ignorato e il movimento finiva agganciato SEMPRE alla prima voce
        // nuova. La riga resta plausibile (un uuid di questa transazione c'è), e da
        // `riconciliazione_movimenti.pagamento_id` dipendono l'oblio GDPR (ramo
        // «Movimenti collegati AL PAGAMENTO») e l'intestatario della fattura
        // (`src/lib/aruba/intestatario-pagamento.ts`): la fattura di un bonifico
        // multi-famiglia si sarebbe intestata al genitore sbagliato.
        expect(
            assegnazioniA('v_anc_risolto'),
            'la risoluzione dell\'àncora è cambiata. Le quattro forme sono, in ordine di ' +
                'precedenza: l\'uuid dichiarato, l\'indice dentro `voci_nuove`, l\'indice dentro ' +
                '`voci_ticket`, e il ripiego sulla prima voce incassata. Gli indici si risolvono ' +
                '`+ 1` perché sono 0-based nel payload e gli array plpgsql sono 1-based: perdere ' +
                'quel `+ 1`, o sostituirlo con una costante, aggancia il movimento a una voce di ' +
                'questa stessa transazione — quindi plausibile, quindi invisibile — ma di un\'ALTRA ' +
                'famiglia.\n' +
                'Le tre `v_incasso_id` in coda non sono assegnazioni a `v_anc_risolto`: sono i tre ' +
                '`IF v_anc_incasso IS NULL AND v_pid = v_anc_risolto THEN v_anc_incasso := ' +
                'v_incasso_id;` dei cicli di incasso, che questa regex vede perché fra il nome e ' +
                'il `:=` non c\'è un `;`. Restano nell\'elenco APPOSTA: se quella condizione perde ' +
                'il confronto con l\'àncora, l\'incasso agganciato al movimento diventa il primo ' +
                'qualunque, e qui si vede.',
        ).toEqual([
            'v_anc_pid',
            'v_id_nuove[v_anc_i_nuova + 1]',
            'v_id_tick[v_anc_i_tick + 1]',
            "COALESCE( (COALESCE(p->'voci', '[]'::jsonb)->0->>'pagamento_id')::uuid, v_id_nuove[1], v_id_tick[1])",
            'v_incasso_id',
            'v_incasso_id',
            'v_incasso_id',
        ])

        // 🔴 E IL CAS NON FINISCE COL `WHERE`: un `UPDATE` che non aggiorna
        //   niente è un `UPDATE` riuscito. La corsa persa si scopre solo tre
        //   righe più sotto, e lì si disarma in tre modi, tutti misurati «7
        //   passed» perché questo file guardava soltanto il `WHERE`:
        //     · `v_rows := 1;` al posto del `GET DIAGNOSTICS`;
        //     · `IF v_rows < 0 THEN`, che non è mai vero;
        //     · `RAISE NOTICE` al posto di `RAISE EXCEPTION`, che scrive una riga
        //       nel log del server e lascia proseguire la transazione.
        //   In tutti e tre i casi due operatori sullo stesso bonifico incassano
        //   ENTRAMBI, con un 200 a testa. Il commento qui sopra diceva già
        //   «`ROW_COUNT = 0` è il solo modo in cui questa funzione sa di aver
        //   perso»: adesso lo guarda anche.
        expect(
            [...CODICE.matchAll(/\bGET\s+DIAGNOSTICS\b[^;]*/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim()),
            'il `GET DIAGNOSTICS v_rows = ROW_COUNT;` subito dopo l\'`UPDATE` non è più esattamente ' +
                'uno. È l\'unica riga che distingue «ho confermato io» da «mi ha preceduto un altro ' +
                'operatore»: senza, l\'`UPDATE` che non tocca nessuna riga passa per riuscito e la ' +
                'transazione arriva in fondo — voci create, ticket accreditati, incassi scritti.',
        ).toEqual(['GET DIAGNOSTICS v_rows = ROW_COUNT'])
        // …e ATTACCATO all'`UPDATE`, come la guardia `NOT FOUND` alla sua lettura.
        // `ROW_COUNT` è una diagnostica dell'ULTIMA istruzione eseguita: spostare
        // questa riga di due posizioni più in su non toglie niente e non cambia
        // nessuno dei tre controlli qui sopra — il `GET DIAGNOSTICS` resta uno, la
        // condizione resta `v_rows = 0`, il `RAISE` resta un'eccezione KV409 — e il
        // compare-and-swap smette di esistere: `v_rows` porta il conteggio
        // dell'INSERT precedente, che è sempre 1. Misurato dopo aver scritto le tre
        // regole qui sopra: «7 passed», col doppio incasso di nuovo aperto.
        const CAS_COMPLETO =
            /UPDATE\s+public\.riconciliazione_movimenti\b[\s\S]*?;\s*GET\s+DIAGNOSTICS\s+v_rows\s*=\s*ROW_COUNT\s*;\s*IF\s+v_rows\s*=\s*0\s+THEN/g
        expect(
            [...CODICE.matchAll(CAS_COMPLETO)].length,
            'la sequenza `UPDATE … ; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows = 0 THEN` non è ' +
                'più contigua.\n' +
                '`ROW_COUNT` descrive l\'ULTIMA istruzione eseguita: fra l\'`UPDATE` e la sua ' +
                'diagnostica non può esserci niente, o `v_rows` racconta di un\'altra scrittura — ' +
                'tipicamente un INSERT riuscito, cioè 1, cioè «ho vinto la corsa» sempre.',
        ).toBe(1)
        // 🔴 E IL RAMO CHE CONTIENE TUTTO QUESTO NON ERA SORVEGLIATO DA NIENTE, per
        //   sette stesure. Il compare-and-swap vive dentro il TERZO
        //   `IF v_mov IS NOT NULL THEN` del file: sostituire quella riga con
        //   `IF false THEN` lascia il `WHERE`, il `SET`, il `GET DIAGNOSTICS` e il
        //   `RAISE … KV409` scritti parola per parola — e non li fa girare MAI.
        //   Misurato, «7 passed», e `profonditaIf(/IF v_rows = 0/)` legge ancora `1`
        //   perché il ramo finto apre un livello esattamente come quello vero: la
        //   profondità dice A QUANTI `IF` aperti sta una riga, non QUALE condizione
        //   li ha aperti. I conteggi 43/43 e 32/32 non si muovono. Il movimento non
        //   viene mai confermato, il secondo operatore sullo stesso bonifico passa
        //   anche lui: è il DOPPIO INCASSO, cioè l'invariante che questo test esiste
        //   per difendere.
        //   Due varianti più discrete danno lo stesso verde, misurate entrambe:
        //     · `IF v_mov IS NOT NULL AND v_stato_att IS NOT NULL THEN` — il CAS
        //       salta ogni volta che il client non manda `stato_atteso`, che è
        //       proprio il caso previsto dal `CASE WHEN v_stato_att IS NULL` del
        //       `WHERE`, cioè quello ordinario;
        //     · `IF v_mov IS NULL THEN`, che lo rovescia.
        //   E le stesse due sugli altri due rami (pre-lock `FOR UPDATE` e
        //   risoluzione dell'àncora): «7 passed» anche lì.
        //   ⚠️ E NON SI USA `condizioniIfCon(/\bv_mov\b/)`, che sarebbe la forma
        //   naturale in questo file: quella funzione DEDUPLICA
        //   (`if (!out.includes(testo)) out.push(testo)`). Sul file sano restituisce
        //   tre condizioni — la guardia `v_mov IS NULL AND (…)`, `v_mov IS NOT NULL`
        //   una volta sola per tutte e tre le occorrenze, e
        //   `v_n_nuove > 0 OR v_n_tick > 0 OR v_mov IS NOT NULL` — e con `IF false
        //   THEN` al posto di una delle tre restituisce ESATTAMENTE le stesse tre,
        //   perché le altre due bastano a tenere in vita quella voce dell'elenco.
        //   Misurato scrivendo il lock in quella forma: `IF false THEN` sul ramo del
        //   CAS → «7 passed»; sul pre-lock → «7 passed»; sull'àncora → «7 passed».
        //   Solo le due varianti che RISCRIVONO la condizione (`AND v_stato_att IS
        //   NOT NULL`, `IS NULL`) la farebbero cadere. Qui serve il CONTEGGIO, non
        //   l'elenco: si contano le occorrenze nella maschera, e si pretende tre.
        expect(
            [...MASCHERA.matchAll(/\bIF\s+v_mov\s+IS\s+NOT\s+NULL\s+THEN\b/gi)].length,
            'i tre rami che dipendono dal movimento bancario (pre-lock `FOR UPDATE`, risoluzione ' +
                'dell\'àncora, compare-and-swap) non sono più esattamente tre `IF v_mov IS NOT NULL ' +
                'THEN`.\n' +
                'Un congiunto in più, o un `IF false THEN` al posto di uno di loro, spegne il ' +
                'compare-and-swap lasciandolo scritto per intero: `profonditaIf` legge la stessa ' +
                'profondità, i conteggi dei rami e dei `RAISE` non si muovono, e due operatori ' +
                'incassano lo stesso bonifico.\n' +
                '⚠️ È un conteggio LETTERALE, quindi fragile anche a una riformattazione ' +
                'legittima, e la ricetta per aggiornarlo è la stessa dei 43 rami del test 5. ' +
                'Misurate: `IF (v_mov IS NOT NULL) THEN` — parentesi in più, comportamento ' +
                'identico — lo porta a 2; lo stesso ramo spezzato in due (quarta occorrenza, ' +
                'anch\'essa legittima) lo porta a 4 e fa cadere con sé i 43 rami. Prima di ' +
                'cambiare il numero si guardi QUALE occorrenza è comparsa o sparita, si verifichi ' +
                'che i tre rami — pre-lock `FOR UPDATE`, risoluzione dell\'àncora, ' +
                'compare-and-swap — dipendano ancora tutti dal movimento, e si scriva qui accanto ' +
                'perché. Un numero abbassato senza spiegazione trasforma un lock in una ' +
                'decorazione.',
        ).toBe(3)
        // 🔴 …E IL CONTEGGIO SI COMPENSA ANCHE QUI, come si compensano i 43 rami.
        //   Misurato: CAS → `IF false THEN` (conteggio 2) E la condizione esterna
        //   `IF v_n_nuove > 0 OR v_n_tick > 0 OR v_mov IS NOT NULL THEN` riscritta in
        //   `IF v_mov IS NOT NULL THEN` (conteggio di nuovo 3) → «7 passed», con
        //   43/43 rami, 32 `RAISE` e le quattro profondità IDENTICHE al file sano, e
        //   il compare-and-swap morto. Un conteggio si rimette in pari SOSTITUENDO,
        //   non solo aggiungendo: qui si fissa anche la condizione che fa da esca.
        expect(
            condizioniIfCon(/\bv_n_nuove\b/),
            'la condizione che decide se l\'esito porta le cinque chiavi nuove non è più ' +
                'esattamente `IF v_n_nuove > 0 OR v_n_tick > 0 OR v_mov IS NOT NULL THEN`.\n' +
                'Ridurla a `v_mov IS NOT NULL` rimette a tre il conteggio qui sopra mentre il ramo ' +
                'del compare-and-swap è stato spento: è la compensazione, applicata al conteggio ' +
                'che avrebbe dovuto chiuderla.',
        ).toEqual(['v_n_nuove > 0 OR v_n_tick > 0 OR v_mov IS NOT NULL'])
        expect(
            assegnazioniA('v_rows'),
            '`v_rows` viene assegnato con `:=`. Quel valore deve venire SOLO da `GET DIAGNOSTICS`: ' +
                'un `v_rows := 1;` scritto a mano rende la guardia della corsa persa un ramo morto, ' +
                'lasciando `IF v_rows = 0 THEN RAISE …` esattamente com\'è.',
        ).toEqual([])
        expect(
            condizioniIfCon(/\bv_rows\b/),
            'la guardia della corsa persa non è più esattamente `IF v_rows = 0 THEN`. `< 0` non è ' +
                'mai vero (ROW_COUNT non è negativo) e `> 0` la rovescia: in entrambi i casi la ' +
                'conferma perduta prosegue e incassa.',
        ).toEqual(['v_rows = 0'])
        const ramoCorsaPersa = ramoDi(/\bIF\s+v_rows\s*=\s*0\s+THEN\b/i)
        // Stessa regola del resto del file: i `RAISE` si trovano nella maschera del
        // ramo e l'istruzione finisce al primo `;` VERO — `[^;]*` si fermava al
        // primo punto e virgola anche quando era dentro il messaggio, e il
        // `USING ERRCODE` che viene dopo sparirebbe dalla vista.
        const ramoMascherato = mascheraLetterali(ramoCorsaPersa)
        const raiseNelRamo = [...ramoMascherato.matchAll(/\bRAISE\b/gi)].map((m) => {
            const da = m.index ?? 0
            const fine = fineIstruzione(ramoCorsaPersa, da)
            return ramoCorsaPersa
                .slice(da, fine < 0 ? ramoCorsaPersa.length : fine)
                .replace(/\s+/g, ' ')
                .trim()
        })
        expect(
            raiseNelRamo.length,
            'dentro `IF v_rows = 0 THEN` non c\'è più esattamente un `RAISE`: ' + raiseNelRamo.join(' | '),
        ).toBe(1)
        expect(
            /^RAISE\s+EXCEPTION\b/i.test(raiseNelRamo[0] ?? ''),
            'la corsa persa non solleva più un\'ECCEZIONE: «' + (raiseNelRamo[0] ?? '(niente)') + '».\n' +
                '`RAISE NOTICE` e `RAISE WARNING` scrivono nel log del server e lasciano proseguire ' +
                'la transazione: il secondo operatore incassa lo stesso bonifico del primo, e ' +
                'nessuno dei due vede un errore. Solo `RAISE EXCEPTION` annulla tutto.',
        ).toBe(true)
        expect(
            /USING\s+ERRCODE\s*=\s*'KV409'/i.test(raiseNelRamo[0] ?? ''),
            'l\'eccezione della corsa persa non porta più `USING ERRCODE = \'KV409\'`: «' +
                (raiseNelRamo[0] ?? '(niente)') + '».\n' +
                'È il codice con cui la route traduce «ti hanno preceduto» in un 409 invece che in ' +
                'un 500 — lo stesso patto di `20260718500000_annulla_transazione_rpc.sql`, già ' +
                'onorato dalla route dell\'annullo (cerca `code === \'KV409\'`, citato per contenuto ' +
                'perché quel file cambia in questo branch). Senza il codice, l\'unica differenza fra ' +
                '«conflitto» e «guasto» è il testo del messaggio.',
        ).toBe(true)
    })

    it('🔴 3 · `costo_unitario` è rifiutato a ZERO, non solo se negativo', () => {
        const confronti = [...CODICE.matchAll(/v_costo\s*(<=|<|>=|>|=)\s*0/g)].map((m) => m[0])
        expect(
            confronti.some((c) => /<=/.test(c)),
            `le comparazioni su \`v_costo\` nel file sono [${confronti.join(', ')}] e nessuna è ` +
                '`v_costo <= 0`.\n' +
                'A costo zero l\'importo della riga vale `0.00` e l\'INSERT in `incassi` viola ' +
                '`incassi_importo_check CHECK (importo <> 0)` — misurato, SQLSTATE 23514: un 500 opaco ' +
                'a metà transazione invece di un rifiuto parlante prima di scrivere una riga. Un ' +
                'ticket regalato si registra con `ricariche_mensa`, che muove il saldo senza incassare.',
        ).toBe(true)
        expect(
            confronti.filter((c) => /(?<![<>=])<(?!=)/.test(c)),
            'c\'è un confronto `v_costo < 0`: lascia passare `costo_unitario = 0`, che è esattamente ' +
                'il valore che fa cadere l\'INSERT in `incassi` con un 23514.',
        ).toEqual([])

        // ⚠️ E LA GUARDIA PER INTERO, per la stessa ragione del test 2: un
        //   confronto giusto dentro una condizione che non si avvera è un
        //   confronto che non c'è. Misurato su questo file — trasformando la
        //   guardia in `IF v_qta > 1 AND (v_costo IS NULL OR v_costo <= 0) THEN`,
        //   un ticket singolo a costo zero passava indisturbato e il lock restava
        //   «6 passed». Qui si elencano TUTTE le condizioni che nominano
        //   `v_costo`: dev'essercene una sola, e dev'essere questa.
        expect(
            condizioniIfCon(/\bv_costo\b/),
            'le condizioni che nominano `v_costo` non sono più esattamente una, ed esattamente ' +
                '`v_costo IS NULL OR v_costo <= 0`. Un congiunto in più (sulla quantità, sulla ' +
                'categoria, su qualunque cosa) rende il rifiuto condizionato a un caso invece che a ' +
                'tutti, e il valore zero torna a passare per la porta accanto.',
        ).toEqual(['v_costo IS NULL OR v_costo <= 0'])
    })

    it('🔴 4 · nessun `RAISE EXCEPTION` porta testo del chiamante nei log, e l\'esito resta quattro numeri', () => {
        // ── LISTA BIANCA, non lista nera ────────────────────────────────────
        //   Misurato su questo file: `RAISE EXCEPTION 'voce nuova #% (%): …',
        //   v_idx, v_voce;` passava il controllo a lista nera e restava «6
        //   passed». `v_voce` è il jsonb INTERO della voce — `alunno_id`,
        //   `descrizione`, `importo`, `scadenza` — quindi «Uscita anticipata
        //   ‹nome del bambino›» sarebbe uscita nel `details` del 500 e nel campo
        //   `causa` del log, che non passa da `redact`: lo stesso canale che
        //   questo test dichiara di chiudere. Una lista nera chiude i nomi che
        //   qualcuno ha già sbagliato; la lista bianca chiude quelli che nessuno
        //   ha ancora scritto, ed è la scelta di `@/lib/logging/redact`.
        //   ⚠️ E SI GUARDA L'ISTRUZIONE INTERA, non i suoi argomenti posizionali.
        //   Misurate su questo file, entrambe «7 passed» col controllo di prima:
        //   `RAISE EXCEPTION 'voce nuova non valida: ' || v_voce::text;` (nessuna
        //   virgola ⇒ nessun argomento ⇒ nessun controllo) e
        //   `RAISE … , v_idx USING DETAIL = v_voce::text;` (il `USING` veniva
        //   tagliato prima di guardare). Un messaggio si costruisce in cinque modi;
        //   la lista bianca deve valere per tutti e cinque, e l'unico modo di
        //   ottenerlo è non scegliere quale pezzo dell'istruzione leggere.
        const argomentiIlleciti: string[] = []
        for (const r of RAISE) {
            const identificatori = [
                ...senzaLetterali(r).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g),
            ].map((m) => m[0])
            const estranei = identificatori.filter(
                (i) => !PAROLE_CHIAVE_RAISE.has(i.toUpperCase()) && !IDENT_AMMESSI_NEI_RAISE.has(i),
            )
            if (estranei.length > 0) {
                argomentiIlleciti.push(
                    `«${r.replace(/\s+/g, ' ').slice(0, 120)}» (non ammessi: ${[...new Set(estranei)].join(', ')})`,
                )
            }
        }
        expect(
            argomentiIlleciti,
            'un `RAISE EXCEPTION` nomina qualcosa che non è nella lista bianca:\n  ' +
                argomentiIlleciti.join('\n  ') + '\n' +
                'Vale per tutta l\'istruzione — argomenti posizionali, concatenazioni `||`, ' +
                '`format()`, `USING DETAIL`/`HINT` — perché la PII non sceglie la sintassi con cui ' +
                'viaggia. ' +
                'Il messaggio di un\'eccezione plpgsql esce come `rpcErr.message`, finisce in ' +
                '`details` della risposta 500 (`transazioni/route.ts:201`) **e** nel campo `causa` ' +
                'della riga di log (`src/lib/logging/logger.ts:514`), che NON passa da `redact`. ' +
                'Ammessi solo indici, conteggi, importi e uuid — più `v_stato_att`, che a quel punto ' +
                'la validazione del vocabolario ha già ridotto a uno di tre letterali. Tutto il ' +
                'resto è potenzialmente testo scritto da chi ha composto il payload, e questi sono ' +
                'dati di minori: regola 8 di `AGENTS.md`. Se il nome nuovo è davvero un numero o un ' +
                'uuid, si aggiunge a `IDENT_AMMESSI_NEI_RAISE` **spiegando perché**, non per comodità.',
        ).toEqual([])

        // La stessa regola detta dall'altro lato, perché è la ricaduta che si è
        // già vista e merita un messaggio suo invece di un elenco generico.
        const colpevoli = RAISE.filter((r) => {
            const argomenti = senzaLetterali(r)
            return (
                /\bv_desc\b/.test(argomenti) ||
                /\bdescrizione\b/i.test(argomenti) ||
                /->>?\s*'descrizione'/i.test(r)
            )
        }).map((r) => r.replace(/\s+/g, ' ').slice(0, 160))
        expect(
            colpevoli,
            'un `RAISE EXCEPTION` interpola la descrizione di una voce:\n  ' +
                colpevoli.join('\n  ') + '\n' +
                'Quel testo è LIBERO — «Uscita anticipata <nome del bambino>» — e il messaggio di ' +
                'un\'eccezione plpgsql esce come `rpcErr.message`, finisce in `details` della ' +
                'risposta 500 (`transazioni/route.ts:201`) **e** nel campo `causa` della riga di log ' +
                '(`src/lib/logging/logger.ts:514`), che NON passa da `redact`. Sono dati di minori in ' +
                'chiaro, nei log e sul filo HTTP: regola 8 di `AGENTS.md`. Le voci si nominano con il ' +
                'loro INDICE 0-based, mai con la descrizione; interpolare resta lecito per uuid, ' +
                'numeri e letterali.',
        ).toEqual([])

        // ── L'ALTRO CANALE, che non è un'eccezione: il VALORE DI RITORNO ──────
        //   Trovato attaccando questo stesso file dopo averlo corretto:
        //   `v_out := v_out || jsonb_build_object('debug', v_nuove);` prima del
        //   `RETURN` rimanda indietro l'array INTERO delle voci — descrizioni
        //   comprese — e tutte le regole sui `RAISE` restavano verdi, perché un
        //   `RETURN` non è un `RAISE`. La testata promette in lettere che l'esito
        //   resta `{transazione_id, incassi, ricariche, eccedenza}` più le cinque
        //   chiavi nuove: qui quella promessa diventa un'asserzione.
        const esiti = [...CODICE.matchAll(/jsonb_build_object\s*\(/g)].map((m) =>
            gruppoParentesi(CODICE, m.index ?? 0).interno.replace(/\s+/g, ' ').trim(),
        )
        expect(
            esiti,
            'il jsonb di ritorno non è più esattamente questo:\n  ' + esiti.join('\n  ') + '\n' +
                'È ciò che la RPC rimanda al chiamante, e da lì alla risposta HTTP. Contiene solo ' +
                'conteggi e uuid — mai un pezzo del payload ricevuto, mai una descrizione: un ' +
                '«campo di debug» aggiunto qui è testo libero di minori che esce dal database senza ' +
                'passare da nessuna redazione, e nessuna delle regole sui `RAISE` lo vedrebbe.',
        ).toEqual([
            "'transazione_id', v_txid, 'incassi', v_n_incassi, 'ricariche', v_n_ric, 'eccedenza', v_ecc",
            "'voci_nuove', v_n_nuove, 'voci_ticket', v_n_tick, 'movimento_id', v_mov, " +
                "'ancora_pagamento_id', v_anc_risolto, 'ancora_incasso_id', v_anc_incasso",
        ])
    })

    it('🔴 5 · le scritture sono queste undici su sette tabelle, e i rami condizionali 43', () => {
        /**
         * ⚠️ PERCHÉ UN LOCK SULL'INVENTARIO E NON SOLO SULLE SINGOLE RIGHE.
         *
         * Le quattro regole qui sopra guardano ciascuna una riga giusta. Nessuna
         * di loro vede una riga IN PIÙ. Misurato su questo file: aggiungendo
         * `UPDATE public.pagamenti SET scuola_id = v_scuola WHERE id = v_new_pid;`
         * subito dopo l'INSERT delle voci nuove, la sede corretta viene scritta e
         * poi immediatamente riscritta con quella del client — e il lock restava
         * «6 passed», perché l'INSERT che controlla è ancora perfetto.
         * Un elenco chiuso dei bersagli chiude la classe intera, non l'esempio.
         *
         * ⚠️ E IL CONTEGGIO DEI RAMI chiude l'altra classe, quella che tre
         * mutazioni diverse hanno usato: spostare una guardia dentro un `IF`
         * esterno. La guardia resta identica — quindi invisibile a chi ne legge
         * la forma — e semplicemente non viene più eseguita per tutti. Un ramo in
         * più o in meno qui è una decisione da guardare, non un dettaglio.
         *
         * Se un intervento legittimo cambia questi numeri, si aggiornano — DOPO
         * aver verificato che nessuna guardia sia finita dentro una condizione, e
         * scrivendo qui accanto perché. Un numero abbassato senza spiegazione
         * trasforma un lock in una decorazione.
         */
        // ⚠️ `public.` È OPZIONALE NELLE TRE REGEX, e non è un dettaglio di
        //   scrittura: la funzione gira con `SET search_path = public`, quindi
        //   `UPDATE pagamenti …` fa ESATTAMENTE la stessa cosa di
        //   `UPDATE public.pagamenti …` — cioè la mutazione che il commento qui
        //   sopra porta come esempio, scritta senza lo schema. Misurata: «7
        //   passed» quando l'elenco pretendeva il prefisso. Un inventario che
        //   riconosce una forma su due non è un inventario chiuso.
        //   (`ON CONFLICT … DO UPDATE` è escluso: non è una scrittura nuova, è la
        //   coda dell'INSERT che sta già nell'elenco.)
        const bersagli = [
            ...[...CODICE.matchAll(/INSERT\s+INTO\s+((?:public\.)?\w+)/gi)].map((m) => `INSERT ${m[1]}`),
            ...[...CODICE.matchAll(/(?<!\bDO\s{1,8})\bUPDATE\s+((?:public\.)?\w+)/gi)].map((m) => `UPDATE ${m[1]}`),
            ...[...CODICE.matchAll(/DELETE\s+FROM\s+((?:public\.)?\w+)/gi)].map((m) => `DELETE ${m[1]}`),
        ]
        const nonQualificate = bersagli.filter((b) => !/\bpublic\./.test(b))
        expect(
            nonQualificate,
            'c\'è una scrittura senza schema: ' + nonQualificate.join(' · ') + '\n' +
                'Con `SET search_path = public` colpisce la stessa tabella di quella qualificata, ma ' +
                'si legge come se parlasse di un\'altra cosa. Si scrive sempre `public.<tabella>`, ' +
                'così l\'elenco qui sotto resta l\'inventario di tutto ciò su cui questa funzione ' +
                'incide con i privilegi del DEFINER.',
        ).toEqual([])
        expect(
            bersagli.slice().sort(),
            'le scritture di questa RPC non sono più esattamente queste. Ogni riga di questo elenco ' +
                'è una tabella su cui la funzione incide, con i privilegi del DEFINER: una in più ' +
                'nessuno l\'ha chiesta, e una che riscrive `scuola_id` dopo l\'INSERT annullerebbe ' +
                'in silenzio la derivazione della sede dall\'alunno — con l\'INSERT ancora perfetto.\n' +
                'Trovate: ' + bersagli.join(' · '),
        ).toEqual(
            [
                'INSERT public.pagamenti_transazioni',
                'INSERT public.pagamenti',
                'INSERT public.pagamenti',
                'INSERT public.mensa_ticket_movimenti',
                'INSERT public.incassi',
                'INSERT public.incassi',
                'INSERT public.incassi',
                'INSERT public.ticket_mensa',
                'INSERT public.mensa_ticket_movimenti',
                'INSERT public.crediti_famiglia',
                'UPDATE public.riconciliazione_movimenti',
            ].sort(),
        )

        // `\bIF\b` non pesca né `NULLIF` né `ELSIF`: in entrambi la `I` è
        // preceduta da una lettera, e il confine di parola non c'è.
        const apreIf = [...CODICE.matchAll(/\bIF\b/gi)].length
        const chiudeIf = [...CODICE.matchAll(/\bEND\s+IF\b/gi)].length
        expect(
            [apreIf - chiudeIf, chiudeIf],
            `i rami condizionali sono cambiati: ${apreIf - chiudeIf} aperti, ${chiudeIf} chiusi ` +
                '(erano 43 e 43, `DO $guardia$` compreso).\n' +
                'Un `IF` in più può essere legittimo — o può essere una guardia esistente spostata ' +
                'dentro una condizione, che è il modo più economico di disarmarla lasciandola scritta ' +
                'esattamente com\'è. Prima di aggiornare il numero, si guardi QUALE ramo è comparso.',
        ).toEqual([43, 43])

        // 🔴 …E IL CONTEGGIO SI COMPENSA, che è la classe che il conteggio stesso
        //   dichiarava di chiudere. Misurato: annidare la guardia dell'alunno
        //   inesistente in un `IF v_idx > 0 THEN` (+1 ramo, e la PRIMA voce non
        //   viene più validata) INSIEME a togliere `IF v_metodo = '' THEN`
        //   altrove (−1) lascia 43 aperture e 43 chiusure → «7 passed». Prese una
        //   per una sono rosse, ed è così che erano state provate. Quindi al
        //   conteggio si affianca la FORMA delle guardie rimaste scoperte, come
        //   si fa già per `v_costo` (test 3) e per `v_stato_att` (test 2).
        expect(
            [...CODICE.matchAll(/\bRAISE\b/gi)].length,
            'i `RAISE` del file non sono più 32. Una guardia tolta si vede qui anche quando il ' +
                'saldo dei rami torna: un `IF` in meno e uno in più si compensano, un rifiuto in ' +
                'meno no.',
        ).toBe(32)
        expect(
            RAISE.length,
            'i `RAISE` non sono più tutti e 32 `RAISE EXCEPTION`. `RAISE NOTICE`/`WARNING` ' +
                'scrivono nel log del server e lasciano PROSEGUIRE la transazione: una validazione ' +
                'che diventa una nota è una validazione che non c\'è più, e il payload che doveva ' +
                'essere rifiutato viene scritto.',
        ).toBe(32)
        expect(
            condizioniIfCon(/\bv_metodo\b/),
            'la guardia del metodo non è più esattamente `IF v_metodo = \'\' THEN`. È una delle ' +
                'quattro validazioni storiche, ed è il pezzo che la mutazione di compensazione ' +
                'toglie per far tornare il conteggio dei rami: senza, `metodo` vuoto arriva al ' +
                '`CASE` che lo mappa su `altro` e l\'incasso viene registrato con un metodo ' +
                'inventato.',
        ).toEqual(["v_metodo = ''"])
        // 🔴 …E LA COMPENSAZIONE SI CHIUDE QUI. Le quattro guardie stanno a una
        //   profondità NOTA di `IF` aperti: annidarne una in un ramo che non si
        //   avvera la disarma lasciandola scritta identica, e il saldo dei rami si
        //   rimette in pari togliendo un `IF` altrove più un `RAISE` di riempimento.
        //   Misurate tutte e tre «7 passed» prima di questa asserzione:
        //     · `IF v_idx > 0 THEN` attorno alla guardia del costo → la PRIMA voce
        //       di ogni elenco non viene più validata;
        //     · `IF false THEN` attorno alla stessa → nessuna voce viene validata,
        //       e il costo zero torna a produrre il 23514 su `incassi`;
        //     · `IF false THEN` attorno alla guardia del vocabolario →
        //       `'confermato'` di nuovo ammesso, cioè il DOPPIO INCASSO.
        //   Un totale si compensa, una profondità no: dice a quanti `IF` aperti sta
        //   QUELLA riga, e un blocco aggiunto o tolto altrove apre e chiude.
        expect(
            [
                profonditaIf(/\bIF\s+v_costo\s+IS\s+NULL\b/i),
                profonditaIf(/\bIF\s+v_stato_att\s+IS\s+NOT\s+NULL\b/i),
                profonditaIf(/\bIF\s+v_rows\s*=\s*0\b/i),
                profonditaIf(/\bIF\s+v_metodo\s*=/i),
            ],
            'una delle quattro guardie ha cambiato profondità di annidamento (erano 0, 0, 1, 0: ' +
                'la corsa persa sta dentro `IF v_mov IS NOT NULL THEN`, le altre tre al livello del ' +
                'corpo).\n' +
                'Un numero più ALTO significa che qualcuno l\'ha messa dentro un ramo in più — la ' +
                'guardia resta scritta parola per parola, e semplicemente non vale più per tutti: è ' +
                'il modo più economico di disarmarla, e i conteggi dei rami e dei `RAISE` si ' +
                'compensano da soli. Un `null` significa che la riga non si trova più nella forma ' +
                'attesa (per esempio con un congiunto anteposto), ed è altrettanto grave. Se ' +
                'l\'annidamento nuovo è legittimo si aggiorna il numero, DOPO aver verificato che ' +
                'la condizione esterna sia sempre vera per tutte le voci — e scrivendo qui perché.',
        ).toEqual([0, 0, 1, 0])
        expect(
            condizioniIfCon(/\bNOT\s+FOUND\b/i),
            'una guardia `IF NOT FOUND` ha preso dei congiunti: ' +
                condizioniIfCon(/\bNOT\s+FOUND\b/i).join(' | ') + '\n' +
                'Le tre di questo file (alunno di una voce nuova, alunno di un ticket, movimento ' +
                'bancario) devono essere `NOT FOUND` e basta. `IF NOT FOUND AND v_idx > 0` — ' +
                'misurato, «7 passed», e il conteggio dei rami non si muove — lascia passare senza ' +
                'controlli la PRIMA voce di ogni elenco, che è poi quella su cui cade l\'àncora ' +
                'quando nessuno la indica.',
        ).toEqual(['NOT FOUND'])

        // E la guardia dev'essere ATTACCATA alla sua lettura. `FOUND` è una
        // variabile di sistema che l'istruzione SUCCESSIVA riscrive: qualunque
        // cosa infilata in mezzo — un `IF` esterno che la annida, un'altra query,
        // un'assegnazione innocua — non disarma la guardia, la fa mentire.
        const LETTURA_E_GUARDIA =
            /SELECT\s+a\.scuola_id\s+INTO\s+v_scuola_voce\s+FROM\s+public\.alunni\s+a\s+WHERE\s+a\.id\s*=\s*v_aid\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RAISE\s+EXCEPTION\b/g
        expect(
            [...CODICE.matchAll(LETTURA_E_GUARDIA)].length,
            'le due letture della sede da `alunni` non sono più seguite IMMEDIATAMENTE da `IF NOT ' +
                'FOUND THEN RAISE EXCEPTION`.\n' +
                'Fra la query e il controllo non può esserci niente: `FOUND` vale per l\'ultima ' +
                'istruzione eseguita. E un `IF` esterno che annida la guardia la lascia scritta ' +
                'parola per parola mentre smette di valere per tutti — misurato, e il saldo dei ' +
                'rami si rimette in pari togliendone uno altrove.',
        ).toBe(2)
        const LOCK_E_GUARDIA =
            /PERFORM\s+1\s+FROM\s+public\.riconciliazione_movimenti\s+WHERE\s+id\s*=\s*v_mov\s+FOR\s+UPDATE\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RAISE\s+EXCEPTION\b/g
        expect(
            [...CODICE.matchAll(LOCK_E_GUARDIA)].length,
            'il pre-lock `FOR UPDATE` sul movimento non è più seguito immediatamente da `IF NOT ' +
                'FOUND THEN RAISE EXCEPTION`: è ciò che distingue «movimento inesistente» da «gara ' +
                'persa», e senza, un `movimento_id` sbagliato scriverebbe tutta la transazione per ' +
                'poi fallire (o peggio, riuscire) sul compare-and-swap.',
        ).toBe(1)

        // ── E LE SCRITTURE CHE NON SI CHIAMANO `INSERT`/`UPDATE`/`DELETE` ──────
        //   L'inventario qui sopra chiude una forma su quattro. Le altre tre,
        //   misurate tutte «7 passed» prima di queste righe:
        //     · `EXECUTE format('upd' || 'ate %I set scuola_id = %L …', …)` — SQL
        //       costruito a runtime: il bersaglio non esiste finché la funzione
        //       non gira, quindi NESSUNA regex di questo file può leggerlo;
        //     · `PERFORM public.sposta_pagamento_di_sede(…)` — la scrittura sta
        //       dentro un'altra funzione, e qui si vede solo una chiamata;
        //     · un `CREATE TRIGGER … BEFORE INSERT ON public.pagamenti` aggiunto
        //       in coda al file, che riscrive `NEW.scuola_id` per sempre e su
        //       tutte le righe, comprese quelle che questa RPC non tocca.
        //   ⚠️ E SI CERCA IN TUTTO IL FILE, non nel solo `CORPO`. Cercarlo nel corpo
        //   dava per scontato il confine del corpo, e il confine è una ricerca
        //   testuale come le altre: misurato — `DO $zz$ BEGIN EXECUTE format('crea'
        //   || 'te trigger …'); END $zz$;` in coda al file, «7 passed», perché lì
        //   fuori nessuno guardava. `GRANT EXECUTE ON FUNCTION` è l'unica forma
        //   legittima ed è esclusa per nome; la maschera toglie di mezzo la parola
        //   `EXECUTE` quando sta dentro un messaggio.
        const executeDinamici = [...MASCHERA.matchAll(/\bEXECUTE\b(?!\s+ON\s+FUNCTION\b)/gi)].map((m) =>
            CODICE.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 60).replace(/\s+/g, ' ').trim(),
        )
        expect(
            executeDinamici,
            'c\'è un `EXECUTE` in questa migrazione:\n  ' + executeDinamici.join('\n  ') + '\n' +
                'SQL costruito a runtime: la tabella che tocca non è scritta da nessuna parte, ' +
                'quindi l\'inventario delle scritture qui sopra — e ogni altra regola di questo ' +
                'file — diventa cieco per costruzione. Vale dentro il corpo e FUORI (un `DO $$ … $$;` ' +
                'in coda scrive con gli stessi privilegi di chi applica la migrazione). Oggi non ce ' +
                'n\'è nessuno e non ne serve nessuno: se un giorno servisse davvero, prima si scrive ' +
                'qui come lo si sorveglia.',
        ).toEqual([])
        expect(
            [...CORPO.matchAll(/\bPERFORM\b[^;]*/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim()),
            'i `PERFORM` del corpo non sono più esattamente questi cinque. Un `PERFORM` è una ' +
                'chiamata di cui si butta via il risultato: è il modo più discreto di far scrivere ' +
                'qualcosa a un\'ALTRA funzione, che qui dentro non si vede. I due `PERFORM 1 … FOR ' +
                'UPDATE` sono i lock di riga; i tre `ricalcola_stato_pagamento` ricalcolano lo stato ' +
                'del pagamento dopo ogni incasso.',
        ).toEqual([
            'PERFORM 1 FROM public.riconciliazione_movimenti WHERE id = v_mov FOR UPDATE',
            'PERFORM public.ricalcola_stato_pagamento(v_pid)',
            'PERFORM public.ricalcola_stato_pagamento(v_pid)',
            'PERFORM public.ricalcola_stato_pagamento(v_pid)',
            'PERFORM 1 FROM public.parents WHERE id = v_pagante FOR UPDATE',
        ])
        // `senzaLetterali(CORPO)` e non `CORPO`, come le due asserzioni qui sopra e
        // le due qui sotto: un nome DENTRO gli apici non è una chiamata, è una
        // parola. Misurato su questo file, prima di questa riga — sostituendo
        // `v_saldo_ticket := public.varia_saldo_ticket(v_aid, v_tick);` con
        // `v_desc := 'public.varia_saldo_ticket'; v_saldo_ticket := 0;` → «7
        // passed»: il saldo non veniva più accreditato e `mensa_ticket_movimenti`
        // scriveva `saldo_dopo = 0`, mentre l'elenco che deve sorvegliare quella
        // chiamata si dichiarava soddisfatto da un letterale.
        expect(
            [...senzaLetterali(CORPO).matchAll(/\bpublic\.([a-z_]\w*)/gi)].map((m) => 'public.' + m[1]).sort(),
            'ciò che il corpo nomina nello schema `public` è cambiato. È l\'inventario COMPLETO — ' +
                'tabelle, tipi e funzioni — di tutto quello che questa RPC tocca, ripetizioni ' +
                'comprese: una `public.varia_saldo_ticket` in più non è un dettaglio di stile, è un ' +
                'saldo accreditato due volte.',
        ).toEqual(
            [
                'public.alunni', 'public.alunni',
                'public.crediti_famiglia', 'public.crediti_famiglia',
                'public.incassi', 'public.incassi', 'public.incassi',
                'public.incasso_metodo', 'public.incasso_metodo',
                'public.incasso_metodo', 'public.incasso_metodo',
                'public.mensa_ticket_movimenti', 'public.mensa_ticket_movimenti',
                'public.pagamenti', 'public.pagamenti',
                'public.pagamenti_transazioni',
                'public.pagamento_tipo', 'public.pagamento_tipo',
                'public.parents',
                'public.payment_categories',
                'public.ricalcola_stato_pagamento', 'public.ricalcola_stato_pagamento',
                'public.ricalcola_stato_pagamento',
                'public.riconciliazione_movimenti', 'public.riconciliazione_movimenti',
                'public.ticket_mensa',
                'public.varia_saldo_ticket',
            ].sort(),
        )
        // …e le chiamate qualificate verso uno schema che NON è `public`: trovato
        // attaccando questo file dopo averlo corretto —
        // `v_saldo_prec := extensions.sposta_sede(v_txid, v_scuola);` passava tutti
        // e tre gli elenchi (non è un `PERFORM`, non nomina `public.`, non è un
        // nome nudo), e su Supabase gli schemi `extensions`/`graphql`/`vault`
        // esistono e sono raggiungibili da una funzione DEFINER.
        const altriSchemi = [...senzaLetterali(CORPO).matchAll(/(?<![\w.])([a-z_]\w*)\.([a-z_]\w*)\s*\(/gi)]
            .filter((m) => m[1].toLowerCase() !== 'public')
            .map((m) => `${m[1]}.${m[2]}()`)
        expect(
            altriSchemi,
            'il corpo chiama una funzione di uno schema diverso da `public`: ' +
                altriSchemi.join(' · ') + '\n' +
                'Questa RPC è `SECURITY DEFINER` con `search_path = public`: tutto ciò che le serve ' +
                'sta lì e si scrive `public.<nome>`. Un nome qualificato altrove sfugge ai tre ' +
                'elenchi qui sopra — non è un `PERFORM`, non nomina `public.`, non è un nome nudo — ' +
                'e può scrivere quello che vuole con i privilegi del proprietario.',
        ).toEqual([])
        const funzioniNude = [
            ...new Set(
                [...senzaLetterali(CORPO).matchAll(/(?<![\w.])([a-z_]\w*)\s*\(/gi)].map((m) => m[1]),
            ),
        ].sort()
        expect(
            funzioniNude,
            'nel corpo compare un nome seguito da `(` che non è fra quelli dichiarati: ' +
                funzioniNude.join(', ') + '\n' +
                'Sono le funzioni chiamate senza schema (più le parole chiave che si scrivono con ' +
                'una parentesi accanto). `search_path = public` le risolve tutte, quindi una ' +
                'scrittura può nascondersi qui come dietro un `PERFORM public.…` — e `format(` è ' +
                'anche il modo più comodo di rimettere testo libero dentro un messaggio.',
        ).toEqual([
            'AND', 'ANY', 'CONFLICT', 'COALESCE', 'IF', 'IN', 'NULLIF', 'VALUES',
            'array_length', 'btrim', 'enum_range', 'jsonb_array_elements',
            'jsonb_build_object', 'jsonb_typeof', 'now', 'round', 'trunc',
        ].sort())
        const ddl = [
            ...senzaLetterali(CODICE).matchAll(/\b(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?([A-Za-z]+)\s+([\w.]+)/gi),
        ].map((m) => `${m[1].toUpperCase()} ${m[2].toUpperCase()} ${m[3]}`)
        expect(
            ddl,
            'questa migrazione crea o altera qualcosa oltre alla RPC: ' + ddl.join(' · ') + '\n' +
                'Doveva essere «solo il corpo di una funzione, nessuno schema alterato» (testata). ' +
                'Un `CREATE TRIGGER … BEFORE INSERT ON public.pagamenti` che riscrive ' +
                '`NEW.scuola_id` vanifica la derivazione della sede su OGNI riga della tabella, non ' +
                'solo su quelle di questa funzione, e nessuna delle regole qui sopra lo vedrebbe: ' +
                'misurato, «7 passed».',
        ).toEqual(['CREATE FUNCTION public.registra_transazione_contabile'])
        // 🔴 E IL CONTROLLO DI FLUSSO, che nessuna regola qui sopra guarda. Una
        //   guardia scritta parola per parola non vale niente se non viene
        //   RAGGIUNTA, e per renderla irraggiungibile non serve toccarla: basta un
        //   `RETURN` prima, un `CONTINUE` dentro, o un `EXCEPTION WHEN OTHERS` che ne
        //   ingoia l'eccezione. Nessuna di queste quattro mutazioni muove i conteggi
        //   43/43, i 32 `RAISE`, le profondità, l'inventario delle scritture o il
        //   conteggio dei tre `IF v_mov IS NOT NULL THEN`. Misurate tutte e quattro
        //   «7 passed» prima di questa riga:
        //     · `RETURN v_out;` subito prima del CAS → il movimento non viene mai
        //       confermato e il secondo operatore incassa lo stesso bonifico;
        //     · `RETURN v_out;` come prima istruzione di `IF v_rows = 0 THEN` → la
        //       corsa persa esce in silenzio e la transazione COMMITTA, col
        //       `RAISE … KV409` ancora scritto sotto;
        //     · `CONTINUE;` in testa alla guardia del costo → la voce a costo zero
        //       viene SALTATA invece che rifiutata;
        //     · `BEGIN … EXCEPTION WHEN OTHERS THEN NULL; END;` attorno al CAS → il
        //       KV409 sparisce (provato sul database vivo: plpgsql lo ingoia).
        const MASCHERA_CORPO = mascheraLetterali(CORPO)
        expect(
            [
                [...MASCHERA_CORPO.matchAll(/\bRETURN\b/gi)].length,
                [...MASCHERA_CORPO.matchAll(/\bCONTINUE\b/gi)].length,
                [...MASCHERA_CORPO.matchAll(/\bEXIT\b/gi)].length,
                [...MASCHERA_CORPO.matchAll(/\bEXCEPTION\s+WHEN\b/gi)].length,
                [...MASCHERA_CORPO.matchAll(/\bBEGIN\b/gi)].length,
            ],
            'il controllo di flusso del corpo è cambiato (erano: un solo `RETURN` — quello ' +
                'finale —, nessun `CONTINUE`, nessun `EXIT`, nessun blocco `EXCEPTION WHEN`, un ' +
                'solo `BEGIN`).\n' +
                'Un `RETURN` in più, un `CONTINUE`, o un sotto-blocco con `EXCEPTION WHEN OTHERS` ' +
                'rendono IRRAGGIUNGIBILE una guardia senza toccarne una lettera: tutti i conteggi ' +
                'di questo file restano identici e la funzione fa un\'altra cosa.',
        ).toEqual([1, 0, 0, 0, 1])
    })

    it('la RPC resta chiusa: SECURITY DEFINER, search_path, e solo `service_role`', () => {
        // `CREATE OR REPLACE` conserva i privilegi esistenti, che su Supabase
        // includono l'EXECUTE concesso ad `anon`/`authenticated` per default ACL:
        // ometterli qui lascerebbe in piedi ciò che c'era.
        expect(CODICE).toMatch(/SECURITY\s+DEFINER/i)
        // ⚠️ IL VALORE PER INTERO, non il suo prefisso, e UNO SOLO. `toMatch(/=\s*public/)`
        //   era soddisfatto anche da `= public, extensions`, e un `SET LOCAL
        //   search_path = extensions, public;` scritto DENTRO il corpo passava
        //   indisturbato: entrambe misurate «7 passed». In una funzione DEFINER il
        //   `search_path` decide che cosa significa ogni nome non qualificato —
        //   `round`, `now`, `format` — e anteporre uno schema scrivibile a `public`
        //   è il modo classico di far eseguire altro codice ai privilegi del
        //   proprietario. La direzione più vistosa (`= evil, public`) era già rossa;
        //   questa chiude anche l'altra.
        const searchPath = [...CODICE.matchAll(/\bsearch_path\s*=\s*([^\n;]*)/gi)].map((m) =>
            m[1].trim(),
        )
        expect(
            searchPath,
            'il `search_path` di questa funzione non è più esattamente uno, e `public`: [' +
                searchPath.join(' | ') + '].\n' +
                'Un secondo valore (in coda all\'opzione, o un `SET LOCAL` dentro il corpo) cambia ' +
                'che cosa significano i nomi non qualificati per una funzione che gira con i ' +
                'privilegi del proprietario.',
        ).toEqual(['public'])
        expect(CODICE).toMatch(
            /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.registra_transazione_contabile\(jsonb\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
        )
        expect(CODICE).toMatch(
            /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.registra_transazione_contabile\(jsonb\)\s+TO\s+service_role/i,
        )
    })
})
