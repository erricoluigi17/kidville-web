import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { mapStatoAruba } from '@/lib/aruba/stato'

/**
 * LOCK · L'ANNULLO RIAPRE IL MOVIMENTO **SENZA** DISARMARE LA GUARDIA CHE LO PROTEGGE.
 *
 * ─── IL DIFETTO, MISURATO ───────────────────────────────────────────────────
 *
 * `annulla_transazione_contabile` (migrazione `…180200_…`) riapre il movimento
 * bancario legato alla transazione annullata. La prima stesura azzerava anche
 * `pagamento_id` — e quella colonna non è un ornamento: è l'unico appiglio della
 * guardia «un bonifico non si fattura due volte», che dal 2026-09-20 vive in
 * `src/lib/pagamenti/riconciliazione-conferma.ts` e comincia con
 * `if (mov.pagamento_id != null && mov.pagamento_id !== pagamentoId)`.
 * **Con `pagamento_id` a NULL quella guardia non scatta mai.**
 *
 * Lo scenario, e non è teorico: il bonifico M salda la transazione T, la cui voce
 * di ancoraggio è P1; su P1 si emette la fattura; si annulla T; M torna
 * `da_abbinare` **senza memoria di P1**; l'operatore lo riabbina a P3. Restano in
 * circolazione una fattura viva su P1 senza l'incasso che la giustifica e un
 * secondo incasso su P3 — con un 200 sopra e nessuna riga d'errore da nessuna
 * parte. Prima della riapertura automatica quella strada non esisteva (`ignora` e
 * `riapri` rispondono 409 su un confermato): la migrazione che la apre non può
 * chiudere la sola guardia che la sorveglia, tanto più che cita proprio quella
 * guardia come propria giustificazione.
 *
 * ─── PERCHÉ UN LOCK, E PERCHÉ LEGGE IL FILE .SQL ────────────────────────────
 *
 * Il corpo della funzione vive nel database, non nel bundle: nessun test di
 * route, nessun tipo TypeScript e nessuno dei 6913 test della suite tocca quelle
 * sei righe. Prima di questo file si poteva **cancellare l'intero blocco nuovo**
 * dalla migrazione e vedere il gate restare verde — cioè la correzione non era
 * sorvegliata da niente. Il file `.sql` è l'unico artefatto versionato che dica
 * cosa la funzione fa: si legge quello.
 *
 * ⚠️ COSA QUESTO LOCK **NON** DIMOSTRA: che la funzione viva nel database sia
 * questa. Quella prova la danno `apply_migration` e la fotografia di
 * `__tests__/fixtures/migrazioni-applicate-snapshot.json`
 * (`migrazioni-complete.test.ts`). Qui si sorveglia l'intenzione scritta.
 *
 * ─── 🔴 E LE PORTE SONO DUE, NON UNA (corretto il 2026-09-13) ────────────────
 *
 * Fino a oggi questo file leggeva UNA sola route — `[id]/route.ts`, la conferma a
 * voce singola — e diceva di tenere insieme «le due metà». Ma sul movimento
 * riaperto si affacciano DUE porte, e la seconda è `[id]/componi/route.ts`
 * (blocco §9), nata proprio perché la prima copriva metà del caso: il movimento
 * di cui parla l'annullo non è `confermato`, è **riaperto**, cioè `da_abbinare`,
 * e da lì ci si passa anche componendo.
 *
 * **Misurato**: cancellando la guardia §9 da `componi`, questo lock restava
 * VERDE. Non era cieco per il motivo solito — il presidio comportamentale c'è,
 * e sono i 4 test del blocco «componi — un bonifico non si fattura due volte»
 * di `__tests__/api/pagamenti-riconciliazione-componi.test.ts` — ma un lock che
 * DICHIARA di tenere insieme la migrazione e la guardia che la giustifica, e
 * poi ne guarda una su due, dice il falso su sé stesso. È la stessa specie di
 * difetto che il riquadro qui sopra racconta d'aver già pagato.
 *
 * Si è scelto di ESTENDERLO invece di dichiarare la copertura parziale, e la
 * ragione è nel testo della migrazione: `pagamento_id` si conserva perché una
 * guardia lo legga. Se le guardie che lo leggono sono due, una dichiarazione
 * lascerebbe a chi legge il compito di ricordarsi della seconda — ed è
 * esattamente ciò che non è successo per sei settimane. Ciò che resta
 * dichiarato, perché non è sorvegliato qui, sta nel riquadro sopra ogni `it`.
 */

const RADICE = process.cwd()
const FILE_SQL = join(
    RADICE,
    'supabase',
    'migrations',
    '20260912180200_annulla_transazione_riapre_movimento.sql',
)
const LIB_PAGAMENTI = join(RADICE, 'src', 'lib', 'pagamenti')

const SQL = readFileSync(FILE_SQL, 'utf8')

/**
 * Una route SENZA i suoi commenti. Non è una raffinatezza: è la stessa pulizia
 * che `istruzioneUpdate()` fa qui sotto sull'SQL, per la stessa identica
 * ragione, su file che la pretendono anche di più. La prosa di queste route
 * NOMINA ciò che le asserzioni cercano — `mov.pagamento_id != null` compare
 * anche nel commento del campo `pagamento_id` (quello che spiega perché la
 * migrazione lo conserva) e `BONIFICO_GIA_FATTURATO` anche nel commento sopra
 * il 409 (quello che rimanda a `CODICI_CON_DETTAGLIO`).
 *
 * ⚠️ MISURATO, non temuto. Leggendo il file GREZZO: cancellata la riga
 * `if (mov.pagamento_id != null && …)` e lasciato il commento, questo lock
 * restava VERDE — soddisfatto dalla frase che descrive la guardia al posto
 * della guardia; rinominato `codice: 'BONIFICO_GIA_FATTURATO'` in `'XXX'`,
 * idem. Cioè l'`it` qui sotto non poteva fallire per NESSUNA modifica della
 * route: era decorazione, e c'era nato. Un lock che legge un file come testo
 * legge anche i commenti; se il commento nomina ciò che il lock cerca, il lock
 * è cieco per costruzione — e la beffa è che quel commento sta lì proprio per
 * spiegare la protezione che il lock crede di sorvegliare.
 */
const senzaCommenti = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/**
 * Le diagnostiche SINTATTICHE di un pezzo di TypeScript.
 *
 * ⚠️ Serve a misurare una cosa che prima era PROMESSA in prosa: che lo strip a
 * regex tolga i commenti e nient'altro. La stesura precedente lo dichiarava
 * confrontando a mano i byte con il parser di TypeScript, su UN file e in UN
 * giorno — cioè un numero destinato a invecchiare in silenzio come tutti gli
 * altri di questo repository. Adesso la condizione si verifica a ogni giro e su
 * ogni porta: se una route guadagnasse un letterale con due sbarre dentro (un
 * URL) o un delimitatore di commento, lo strip taglierebbe del codice vero e il
 * risultato smetterebbe di essere TypeScript valido. Il caso opposto — un
 * commento sopravvissuto — lo prende la prova sui delimitatori residui.
 */
const diagnosticheSintattiche = (codice: string): string[] =>
    (ts.transpileModule(codice, {
        reportDiagnostics: true,
        fileName: 'porta.ts',
        compilerOptions: { target: ts.ScriptTarget.ESNext, isolatedModules: true },
    }).diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))

/**
 * LE DUE PORTE che arrivano al movimento riaperto, ognuna con la forma esatta
 * della propria guardia. Sono scritte diversamente perché fanno cose diverse —
 * l'una riabbina a UNA voce, l'altra ricompone su più voci — e appiattirle in
 * una regex sola vorrebbe dire cercare una somiglianza invece della guardia.
 *
 * ─── 🔴 E DAL 2026-09-20 NESSUNA DELLE DUE È PIÙ UNA ROUTE ───────────────────
 *
 * Le due guardie hanno cambiato file, e questo lock è stato spostato con loro:
 * vivono in `src/lib/pagamenti/riconciliazione-conferma.ts` e
 * `src/lib/pagamenti/conciliazione-registra.ts`. Il motivo dello spostamento è
 * lo stesso che rende questo lock necessario: le porte stanno per diventare
 * TRE — l'import dell'estratto conto confermerà da sé i bonifici che riconosce —
 * e una terza copia della guardia sarebbe divergente il giorno dopo essere nata.
 * Ora la guardia è una funzione sola, e ci passano tutti.
 *
 * ⚠️ Perché questo file è stato modificato invece di lasciarlo puntare alle
 * rotte: continuando a leggere `…/[id]/route.ts` sarebbe rimasto VERDE — quelle
 * rotte sono gusci, e un guscio non contiene nessuna guardia da perdere. Cioè
 * avrebbe smesso di sorvegliare esattamente ciò che dichiara di tenere insieme
 * con la migrazione, restando del colore giusto. È la terza volta che questo
 * file lo scrive di sé stesso, e le altre due volte era un difetto: qui è il
 * prezzo di uno spostamento, ed è pagato guardando dove il codice è andato.
 */
const PORTE = [
    {
        nome: 'la conferma a voce singola',
        file: join(LIB_PAGAMENTI, 'riconciliazione-conferma.ts'),
        dove: 'src/lib/pagamenti/riconciliazione-conferma.ts',
        firma: 'export async function confermaSuVoceSingola(',
        /** La memoria del movimento, confrontata col pagamento che si sta per legare. */
        guardia: /mov\.pagamento_id\s*!=\s*null/,
        guardiaTesto: 'mov.pagamento_id != null',
    },
    {
        nome: 'la composizione (blocco §9)',
        file: join(LIB_PAGAMENTI, 'conciliazione-registra.ts'),
        dove: 'src/lib/pagamenti/conciliazione-registra.ts',
        firma: 'export async function registraConciliazione(',
        guardia: /const\s+pagamentoDiPrima\s*=\s*movimento\.pagamento_id[\s\S]*?pagamentoDiPrima\s*!=\s*null/,
        guardiaTesto: 'const pagamentoDiPrima = movimento.pagamento_id … pagamentoDiPrima != null',
    },
] as const

/**
 * CHI CHIEDE «QUESTO DOCUMENTO È ANCORA VIVO?» — tutti quanti, non le sole porte.
 *
 * Le due porte qui sopra sono il motivo per cui `@/lib/pagamenti/fattura-viva`
 * esiste, ma non sono le sole a fare quella domanda: la stessa riga di
 * `fatture_emesse` la interrogano anche il registro dei movimenti (per il chip
 * «fatturata»), la consegna del PDF e — la più pesante delle tre — la guardia di
 * idempotenza dell'emissione fiscale, quella che impedisce che allo SDI partano
 * due documenti per la stessa retta.
 *
 * ⚠️ QUELL'ULTIMA È CITATA DALLA TESTATA DI `fattura-viva.ts` come la ragione
 * della propria esistenza. Finché ne teneva una copia in casa, quella testata
 * prometteva un'unificazione che non c'era — la stessa specie di frase che
 * questo file ha già dovuto correggere una volta (riquadro «E LE PORTE SONO
 * DUE»). Perciò l'elenco non si ferma alle porte.
 *
 * Le tre aggiunte NON portano `firma`/`guardia`: quelle appartengono al
 * riabbinamento, e chiederle qui vorrebbe dire cercare una somiglianza invece
 * della cosa. Di comune hanno una cosa sola, ed è quella che si misura: la
 * definizione di «viva» la prendono da fuori.
 */
const CONSUMATORI = [
    ...PORTE.map((p) => ({ dove: p.dove, file: p.file })),
    {
        // ⚠️ AGGIUNTO IL 2026-09-20, insieme allo spostamento delle due porte: è
        // l'AVVISO della riapertura — «restano fatture vive su quella voce» — che
        // stava dentro `…/[id]/route.ts` ed è uscito con lo storno. Non è una
        // porta (non ferma niente, per decisione misurata del titolare: 167
        // riaperture su 174 hanno una fattura viva), ma la domanda che fa è la
        // stessa, e se un giorno se la ridefinisse in casa l'avviso della
        // riapertura e il 409 del riabbinamento direbbero due cose diverse dello
        // stesso documento. Lasciarlo fuori dall'elenco avrebbe rifatto,
        // sull'altro verso, l'errore del riquadro «E LE PORTE SONO DUE».
        dove: 'src/lib/pagamenti/riapertura-movimento.ts',
        file: join(LIB_PAGAMENTI, 'riapertura-movimento.ts'),
    },
    {
        dove: 'src/app/api/pagamenti/riconciliazione/route.ts',
        file: join(RADICE, 'src', 'app', 'api', 'pagamenti', 'riconciliazione', 'route.ts'),
    },
    {
        dove: 'src/app/api/pagamenti/fattura/route.ts',
        file: join(RADICE, 'src', 'app', 'api', 'pagamenti', 'fattura', 'route.ts'),
    },
    {
        dove: 'src/lib/aruba/emissione.ts',
        file: join(RADICE, 'src', 'lib', 'aruba', 'emissione.ts'),
    },
] as const

const CODICE_CONSUMATORE = new Map(
    CONSUMATORI.map((c) => [c.dove, senzaCommenti(readFileSync(c.file, 'utf8'))]),
)

/** Le due porte sono un sottoinsieme dei consumatori: stesso testo, stessa pulizia. */
const CODICE_PORTA = CODICE_CONSUMATORE

/**
 * I CODICI CHE OGGI SONO SCARTO, CHIESTI A `mapStatoAruba` MENTRE IL TEST GIRA.
 *
 * Scriverli a mano qui — `[2, 4, 9]` — sarebbe esattamente il peccato che la regola
 * costruita con questa lista vieta ai cinque consumatori: il lock resterebbe fermo al
 * 2026-09-13 e il giorno in cui Aruba aggiunge uno stato di scarto smetterebbe di
 * sorvegliare proprio la copia nuova, cioè l'unica che conta. Il range arriva a 20 perché
 * le diciture note stanno in `1..10` e restare stretti sul massimo di oggi è il modo di
 * non accorgersi di un undicesimo: è lo stesso calcolo, e per la stessa ragione, di
 * `statiDiScarto()` in `src/app/api/pagamenti/fattura/sync/route.ts`.
 */
const STATI_DI_SCARTO = Array.from({ length: 21 }, (_, codice) => codice).filter(
    (c) => mapStatoAruba(c).isScarto,
)

/**
 * Un letterale di array fatto SOLO di numeri.
 *
 * ⚠️ La `[` NON deve essere preceduta da un'espressione, altrimenti è
 * un'INDICIZZAZIONE e non un letterale: `righe[0]`, `mov.suggerimenti?.[0]`. È la
 * differenza fra 0 e 18 — nei cinque file ripuliti dai commenti le indicizzazioni
 * numeriche sono 18 (14 delle quali in `emissione.ts`) e i letterali numerici ZERO,
 * misurato il 2026-09-13 con l'AST di TypeScript, non con una regex.
 *
 * ⚠️ QUI PRIMA C'ERA SCRITTA UNA CONSEGUENZA DEDOTTA, spacciata per misurata:
 * «senza questa distinzione la regola darebbe rosso su un `?.[0]` innocuo».
 * Rimisurato togliendo il lookbehind: il lock restava **11/11 verde**, perché a
 * scartare `?.[0]` bastava già `every()` qui sotto — `[0]` non contiene 2, 4 e 9.
 * Il lookbehind non era portante, e il commento diceva che lo era: è il difetto che
 * questo file punisce dalla riga uno.
 *
 * **Adesso lo è**, e non per una frase: per un'asserzione. `a[2, 4, 9]` è
 * un'INDICIZZAZIONE valida — l'operatore virgola — e i suoi numeri sono esattamente
 * i codici di scarto: senza il lookbehind la regex la scambia per un letterale e il
 * lock dà rosso su codice innocuo. La prova sta nel controllo positivo in fondo al
 * file, ed è stata vista fallire: tolto il lookbehind, **un test rosso, e solo
 * quello**.
 *
 * ⚠️ IL FALSO POSITIVO VERO STA ALTROVE, e va nominato perché nessuno lo scopra
 * col rosso in mano: `every()` morde su QUALUNQUE array che contenga 2, 4 e 9 —
 * i mesi `[1,…,12]`, le cifre `[0,…,9]`, i pesi del codice fiscale
 * `[1,2,4,9,13,5,7,17]`. Incidenza misurata il 2026-09-13: **0 su 48** array
 * numerici distinti di tutto `src/`. Rischio reale, non imminente: chi ritocca
 * questo file lo stringa (per esempio pretendendo che l'array non contenga ALTRO
 * oltre ai codici di scarto).
 */
const LETTERALE_NUMERICO = /(?<![\w$)\]'"`.?])\[\s*-?\d+(?:\s*,\s*-?\d+)*\s*,?\s*\]/g

/**
 * I letterali numerici che contengono TUTTI i codici di scarto: la copia scritta a
 * mano, cioè la forma che `mapStatoAruba`/`isScarto` non intercettano.
 */
const copieLetterali = (codice: string): string[] =>
    (codice.match(LETTERALE_NUMERICO) ?? []).filter((lit) => {
        const numeri = new Set((lit.match(/-?\d+/g) ?? []).map(Number))
        return numeri.size > 0 && STATI_DI_SCARTO.every((c) => numeri.has(c))
    })

/**
 * L'unica istruzione `UPDATE` su `riconciliazione_movimenti` del file, dalla
 * parola `UPDATE` al `;` che la chiude, ripulita dai commenti di riga: dentro il
 * corpo `$$ … $$` un `--` è prosa, e la prosa di questa migrazione NOMINA le
 * colonne che tocca. Senza questa pulizia il lock leggerebbe la spiegazione al
 * posto del codice — l'errore che rende verde un lock qualunque cosa faccia il
 * codice sotto.
 */
function istruzioneUpdate(): string {
    const inizio = SQL.indexOf('UPDATE public.riconciliazione_movimenti')
    if (inizio < 0) return ''
    const fine = SQL.indexOf(';', inizio)
    return SQL.slice(inizio, fine < 0 ? SQL.length : fine)
        .split('\n')
        .map((r) => r.replace(/--.*$/, ''))
        .join('\n')
}

const UPDATE_MOV = istruzioneUpdate()

/** `colonna = NULL` nella SET list, in qualunque spaziatura. */
const azzera = (colonna: string) => new RegExp(`\\b${colonna}\\s*=\\s*NULL\\b`, 'i').test(UPDATE_MOV)

describe("lock architettura · l'annullo riapre il movimento senza accecare la guardia", () => {
    it("l'istruzione si legge davvero (sanity: senza, ogni asserzione qui sotto sarebbe verde sul vuoto)", () => {
        expect(
            SQL.length,
            'la migrazione dell\'annullo non si legge: questo lock non starebbe misurando niente.',
        ).toBeGreaterThan(1000)
        expect(
            UPDATE_MOV,
            'nessun `UPDATE public.riconciliazione_movimenti` nella migrazione ' +
                '`20260912180200_annulla_transazione_riapre_movimento.sql`. O la riapertura del ' +
                'movimento bancario è stata tolta, o è scritta in un altro modo: in entrambi i casi ' +
                'le asserzioni qui sotto non guarderebbero nessuna riga di SQL.',
        ).toContain('SET')
        expect(
            UPDATE_MOV,
            'l\'UPDATE non è filtrato per `transazione_id`: riaprirebbe movimenti che non ' +
                'appartengono alla transazione annullata.',
        ).toMatch(/WHERE\s+transazione_id\s*=\s*v_txid/i)
    })

    it('🔴 azzera i QUATTRO legami morti: transazione, incasso, firma di conferma', () => {
        const mancanti = ['transazione_id', 'incasso_id', 'confermato_da', 'confermato_il'].filter(
            (c) => !azzera(c),
        )
        expect(
            mancanti,
            mancanti.length === 0
                ? ''
                : `L'UPDATE che riapre il movimento non azzera: ${mancanti.join(', ')}.\n` +
                  'Una riga riaperta che conserva `incasso_id` punta a un incasso che esiste ancora ' +
                  'ed è morto (stornato, non cancellato) — il peggior tipo di puntatore, quello che ' +
                  'sembra valido; una che conserva `transazione_id` cita una transazione annullata; ' +
                  'una che conserva `confermato_da`/`confermato_il` attribuisce a un operatore una ' +
                  'conferma che non è più in piedi.',
        ).toEqual([])
    })

    it('🔴 NON azzera `pagamento_id`: è la memoria su cui poggia la guardia del riabbinamento', () => {
        expect(
            azzera('pagamento_id'),
            'L\'UPDATE che riapre il movimento azzera `pagamento_id`. Quella colonna è l\'UNICO ' +
                'appiglio della guardia «un bonifico non si fattura due volte» ' +
                '(`src/lib/pagamenti/riconciliazione-conferma.ts`), che comincia con ' +
                '`if (mov.pagamento_id != null && …)`: con NULL non scatta mai. Il movimento ' +
                'riaperto verrebbe riabbinato a un\'altra voce senza che nessuno veda la fattura ' +
                'già emessa su quella vecchia — una fattura viva senza incasso e un secondo ' +
                'incasso altrove, in silenzio. Il prezzo di conservarlo è misurato e pagato: dei ' +
                'tre consumatori di quella colonna, DUE filtrano da sé su `stato = \'confermato\'` ' +
                '(il lotto `daFatturareInListaDiLavoro` e `src/lib/aruba/intestatario-pagamento.ts`, ' +
                'da cui passa la detrazione 730); il terzo — il chip fattura della coda — NON filtra ' +
                'e non può, perché il suo tipo (`RigaFatturabile`) non porta lo stato del movimento. ' +
                'Per quello si è ristretto ALLA FONTE: `pagamenti/riconciliazione:GET` attacca i ' +
                'documenti solo con `pagamentoAbbinatoDi` (`confermato` + `pagamento_id`). Prova nel ' +
                'blocco «il movimento riaperto dall\'annullo» di ' +
                '`__tests__/api/pagamenti-riconciliazione-fatture.test.ts`.',
        ).toBe(false)
    })

    it("l'attrezzo che misura lo strip vede davvero una rottura (controllo positivo)", () => {
        // Un attrezzo mai visto fallire non è un attrezzo. Senza questa riga, un
        // `transpileModule` che restituisse sempre zero diagnostiche renderebbe
        // vera per sempre la prova sullo strip, qualunque cosa lo strip faccia.
        expect(diagnosticheSintattiche('const a = 1'), 'codice valido').toEqual([])
        expect(
            diagnosticheSintattiche('const a = { b: 1').length,
            'il parser non vede nemmeno una graffa mai chiusa',
        ).toBeGreaterThan(0)
    })

    it('la regola sul letterale MORDE, e non è vuota (controllo positivo)', () => {
        // ⚠️ PERCHÉ QUESTO `it` ESISTE, ed è la parte fragile di tutto il blocco.
        // `STATI_DI_SCARTO` è DERIVATA da `mapStatoAruba` — che è il punto — ma una
        // derivazione che restituisse una lista VUOTA non renderebbe rossa la regola:
        // la renderebbe MUTA. Con l'elenco vuoto `.every()` è vero per definizione, e
        // siccome nei cinque file oggi i letterali numerici sono ZERO il lock
        // resterebbe verde 10 su 10 senza vietare più niente — la stessa specie di
        // decorazione che questo file racconta d'aver già pagato due volte. Qui la
        // lista vuota diventa ROSSA: `[].join(', ')` è la stringa vuota, la copia
        // sintetica qui sotto diventa `const X = []`, il regex pretende almeno una
        // cifra e non morde più.
        expect(
            STATI_DI_SCARTO.length,
            '`mapStatoAruba` non marca `isScarto` NESSUN codice fra 0 e 20: o la tabella di ' +
                '`src/lib/aruba/stato.ts` è stata svuotata, o il modulo è mockato in questo file. ' +
                'In entrambi i casi la regola sul letterale non vieterebbe niente restando verde.',
        ).toBeGreaterThan(0)

        const copiaSintetica = `const STATI_BRUCIATI = [${STATI_DI_SCARTO.join(', ')}]`
        expect(
            copieLetterali(copiaSintetica),
            `la regola non morde sulla copia scritta a mano \`${copiaSintetica}\`: è l'unica ` +
                'forma che il divieto su `mapStatoAruba`/`isScarto` non vede, ed è quella che ' +
                'smette di seguire il motore Aruba in silenzio.',
        ).toHaveLength(1)
        expect(
            copieLetterali(`const spazi = [ ${STATI_DI_SCARTO.slice().reverse().join(' , ')} , ]`),
            'la regola si lascia aggirare da un ordine diverso, da una virgola in coda o da ' +
                'qualche spazio: allora non è una regola, è un confronto con una stringa.',
        ).toHaveLength(1)

        // E l'altro verso: un array numerico che NON è la copia deve restare muto,
        // altrimenti il lock dà rosso su codice innocuo e verrà spento dal primo che
        // ci inciampa. `[0]` è la forma che compare davvero in questi file — 18 volte.
        expect(
            copieLetterali('const soloUno = [0]\nconst righe = mov.suggerimenti?.[0]'),
            'la regola morde su un array numerico innocuo',
        ).toEqual([])

        // ⚠️ E QUESTA È L'ASSERZIONE CHE RENDE PORTANTE IL LOOKBEHIND, invece di
        // limitarsi a dichiararlo. `righe[2, 4, 9]` è un'INDICIZZAZIONE valida in
        // JavaScript — l'operatore virgola: vale `righe[9] `— e i suoi numeri sono
        // esattamente i codici di scarto. Senza il lookbehind la regex la scambia per
        // un letterale, `every()` passa, e il lock dà rosso su codice innocuo.
        // Provato togliendo il lookbehind: questa riga diventa ROSSA, l'altra no.
        expect(
            copieLetterali(`const righe = mov.suggerimenti[${STATI_DI_SCARTO.join(', ')}]`),
            "la regola scambia un'INDICIZZAZIONE per un letterale: `a[2, 4, 9]` è " +
                "l'operatore virgola, non una lista di codici, e un lock che dà rosso " +
                'lì lo disattiva il primo che ci inciampa.',
        ).toEqual([])
    })

    it.each(PORTE)(
        '🔴 la guardia che giustifica la scelta qui sopra ESISTE ancora nel CODICE — $nome',
        ({ dove, firma, guardia, guardiaTesto }) => {
            // Le due metà viaggiano insieme: se un giorno la guardia cambia forma o
            // sparisce, conservare `pagamento_id` non protegge più niente e chi legge
            // la migrazione crederebbe il contrario. E le guardie sono DUE: questo
            // blocco gira su tutt'e due le porte, perché fino al 2026-09-13 girava
            // solo sulla prima e cancellare la seconda lasciava il lock verde.
            //
            // Si asserisce sul CODICE RIPULITO, MAI sul file grezzo: tutte le
            // stringhe cercate qui sotto compaiono anche nella prosa di quelle
            // route — che le nomina proprio per spiegare questa protezione.
            const codice = CODICE_PORTA.get(dove)!

            // Sanity dello strip, prima di tutto, e in due direzioni opposte:
            // un commento SOPRAVVISSUTO riporterebbe la cecità che si sta
            // chiudendo; del CODICE DIVORATO renderebbe rosse (o verdi) sul nulla
            // le asserzioni vere.
            const delimitatoriResidui = codice.match(/\/\/|\/\*|\*\//g) ?? []
            expect(
                delimitatoriResidui,
                `${dove}: dopo la pulizia dei commenti restano dei delimitatori ` +
                    `(${delimitatoriResidui.join(' ')}): o un commento è sopravvissuto, o lo strip ` +
                    'a regex si è disallineato su un letterale che li contiene. In entrambi i casi ' +
                    'le asserzioni qui sotto non stanno più leggendo il solo codice: si passi a una ' +
                    'pulizia col parser di TypeScript.',
            ).toEqual([])
            const rotture = diagnosticheSintattiche(codice)
            expect(
                rotture.slice(0, 3),
                `${dove}: dopo la pulizia dei commenti il file non è più TypeScript valido. Lo ` +
                    'strip a regex ha tagliato del CODICE — quasi certamente perché in questo file ' +
                    'è comparso un letterale che contiene due sbarre (un URL) o un delimitatore di ' +
                    'commento. Si passi a una pulizia col parser.',
            ).toEqual([])
            expect(
                codice,
                `${dove}: la pulizia dei commenti ha divorato il corpo della route — non ci si ` +
                    'legge più nemmeno la firma del `withRoute`.',
            ).toContain(firma)

            expect(
                guardia.test(codice),
                `In \`${dove}\` non c'è più la guardia \`${guardiaTesto}\` — non nel CODICE: i ` +
                    'commenti che la nominano non contano, ed è esattamente il motivo per cui qui ' +
                    'si legge la route ripulita. La migrazione dell\'annullo conserva ' +
                    '`pagamento_id` PROPRIO perché quella guardia lo legga: senza, la riapertura ' +
                    'automatica torna a essere una strada aperta verso il doppio incasso — una ' +
                    'fattura viva senza l\'incasso che la giustifica, e un secondo incasso ' +
                    'altrove. Si aggiornano insieme, o si scrive qui perché non serva più.',
            ).toBe(true)
            expect(
                codice,
                `${dove}: il codice \`BONIFICO_GIA_FATTURATO\` non compare più nel codice della ` +
                    'route (il commento che lo cita non conta): è il 409 che ferma il ' +
                    'riabbinamento di un bonifico già fatturato.',
            ).toContain('BONIFICO_GIA_FATTURATO')
            expect(
                codice,
                `${dove}: la guardia non legge più \`fatture_emesse\`. Una guardia che non ` +
                    'guarda i documenti non è una guardia: lascerebbe passare il riabbinamento ' +
                    'senza sapere se ne esiste uno vivo.',
            ).toContain("from('fatture_emesse')")
        },
    )

    it('🔴 e TUTTI i consumatori usano LA STESSA definizione di «fattura viva»', () => {
        // La guardia può esserci in tutt'e due e dire cose diverse. Fino al
        // 2026-09-13 `[id]/route.ts` teneva una copia locale di `fatturaViva`,
        // `etichettaFattura` e della riga di `fatture_emesse`: identiche a quelle
        // del modulo — misurato su tutti gli stati SDI 0-20 e su 100 combinazioni
        // di numero/anno/sezionale — ed è per questo che sono state unite. Due
        // definizioni di «viva» direbbero due cose diverse dello stesso documento:
        // una fermerebbe e l'altra lascerebbe passare, la seconda con un 200 sopra.
        //
        // ⚠️ E IL NOME NON BASTA. Delle quattro copie trovate il 2026-09-13, UNA
        // sola si chiamava come il modulo: le altre erano `eViva`, `viveNonScartate`
        // e una condizione anonima dentro un `continue`. Un elenco di NOMI vietati
        // le avrebbe lasciate passare tutte e tre col lock verde. Perciò qui si
        // vietano DUE FORME: la materia prima — `mapStatoAruba`, `isScarto` — e i
        // codici di scarto riscritti a mano in un letterale di array.
        //
        // 🔴 DUE FORME, NON «TUTTE», e la differenza è stata pagata. Fino al
        // 2026-09-13 qui c'era scritto che vietare la materia prima bastava, «perché
        // comunque la si chiami, una copia del predicato deve per forza passare di
        // lì». È FALSO, misurato con tre tentativi sulla guardia di idempotenza di
        // `emissione.ts` — quella che impedisce il secondo documento fiscale:
        //   · `import { mapStatoAruba as m }` + copia locale → ROSSO (la regex cerca
        //     il nome importato, e l'alias non lo nasconde);
        //   · un MODULO PONTE che ri-esporti `(c) => mapStatoAruba(c).isScarto` →
        //     VERDE, 10 test su 10, e resta verde anche oggi;
        //   · `const STATI_BRUCIATI = [2, 4, 9]` scritto a mano → era VERDE 10/10 con
        //     eslint a zero, ed è il caso PEGGIORE: la copia NON DERIVATA, l'unica
        //     che smette di seguire il motore Aruba il giorno in cui Aruba aggiunge
        //     uno stato di scarto — cioè esattamente la ragione per cui
        //     `@/lib/pagamenti/fattura-viva` esiste. Ed è comportamentalmente
        //     identica oggi, quindi nessuno dei 33 test di quella guardia morde: il
        //     lock era l'unica difesa, e cedeva.
        // La terza da oggi è rossa. Il modulo ponte NO, e nemmeno una lista importata
        // da altrove o una catena `s === 2 || s === 4 || s === 9`: restano scoperte,
        // e sono scritte qui perché nessuno creda il contrario. Questo lock alza il
        // prezzo di una copia, non la rende impossibile — è lo stesso file che otto
        // righe più su condanna un lock che dice il falso su sé stesso.
        const guasti: string[] = []
        for (const { dove } of CONSUMATORI) {
            const codice = CODICE_CONSUMATORE.get(dove)!
            // Sanity dello strip anche qui, e non per simmetria: questa lista si è
            // appena allungata di tre file che nessuno aveva mai ripulito, e uno
            // (`emissione.ts`) è il più lungo del repository. Un commento
            // sopravvissuto renderebbe ROSSO il lock su una prosa che NOMINA
            // `mapStatoAruba` — e la prosa di questi file lo nomina, eccome.
            const residui = codice.match(/\/\/|\/\*|\*\//g) ?? []
            expect(
                residui,
                `${dove}: dopo la pulizia dei commenti restano dei delimitatori ` +
                    `(${residui.slice(0, 5).join(' ')}): le asserzioni qui sotto leggerebbero anche ` +
                    'la prosa, che questi predicati li nomina tutti.',
            ).toEqual([])
            expect(
                diagnosticheSintattiche(codice).slice(0, 3),
                `${dove}: dopo la pulizia dei commenti il file non è più TypeScript valido: lo ` +
                    'strip a regex ha tagliato del CODICE. Si passi a una pulizia col parser.',
            ).toEqual([])

            if (!codice.includes("from '@/lib/pagamenti/fattura-viva'")) {
                guasti.push(`${dove}: non importa più \`@/lib/pagamenti/fattura-viva\``)
            }
            if (/(?:const|function)\s+(?:fatturaViva|etichettaFattura)\b/.test(codice)) {
                guasti.push(`${dove}: ridefinisce in casa \`fatturaViva\`/\`etichettaFattura\``)
            }
            if (/\bisScarto\b/.test(codice) || /\bmapStatoAruba\b/.test(codice)) {
                guasti.push(
                    `${dove}: torna a derivare «viva» in casa da \`mapStatoAruba\`/\`isScarto\` ` +
                        '(nel CODICE, non in un commento)',
                )
            }
            for (const lit of copieLetterali(codice)) {
                guasti.push(
                    `${dove}: riscrive A MANO i codici di scarto in un letterale \`${lit}\` ` +
                        `(oggi \`mapStatoAruba\` ne marca ${STATI_DI_SCARTO.length}: ` +
                        `${STATI_DI_SCARTO.join(', ')}). È la copia NON DERIVATA, la peggiore: ` +
                        'non chiama nessuno, quindi nessun lock sui nomi la vede, ed è identica ' +
                        'alla definizione buona fino al giorno in cui Aruba aggiunge uno stato di ' +
                        'scarto — il giorno in cui questo elenco smette di seguirlo in silenzio',
                )
            }
        }
        expect(
            guasti,
            `${guasti.join('\n  ')}\n` +
                '«Questo documento è ancora vivo?» ha UNA definizione, in `@/lib/pagamenti/fattura-viva`, ' +
                'e il suo predicato è DERIVATO da `mapStatoAruba` invece che copiato: il giorno in cui ' +
                'Aruba aggiunge uno stato di scarto lo segue da sé. Una copia locale no. E le copie non ' +
                'sono un difetto teorico: la più cara delle quattro stava in `src/lib/aruba/emissione.ts`, ' +
                'cioè nella guardia che impedisce che allo SDI partano DUE documenti per la stessa retta — ' +
                'un errore che non si annulla con un UPDATE, ma con una nota di variazione.',
        ).toEqual([])
    })

    it('🔴 un movimento `ignorato` non resuscita', () => {
        const set = UPDATE_MOV.slice(0, UPDATE_MOV.search(/\bWHERE\b/i))
        const assegnaStato = /\bstato\s*=\s*([\s\S]*?)(?:,\s*\n|$)/i.exec(set)?.[1] ?? ''
        expect(
            /ignorato/i.test(assegnaStato),
            'L\'UPDATE riporta a `da_abbinare` QUALUNQUE riga legata alla transazione, anche una ' +
                `che un operatore aveva scartato (\`stato = 'ignorato'\`). Oggi quella riga non ` +
                'esiste — un movimento ignorato non ha `transazione_id` — ma «irraggiungibile oggi» ' +
                'non è una difesa: sarebbe una decisione dell\'operatore annullata da un effetto ' +
                'collaterale, e nessuno saprebbe da dove è tornata. Si preservi lo stato ' +
                `(\`CASE WHEN stato = 'ignorato' THEN stato ELSE 'da_abbinare' END\`), oppure si ` +
                'scriva nel commento che la resurrezione è voluta e perché.',
        ).toBe(true)
    })

    it('🔴 conta le righe riaperte e le fa uscire nel jsonb (`movimenti_riaperti`)', () => {
        expect(
            /GET\s+DIAGNOSTICS\s+v_n_mov\s*=\s*ROW_COUNT/i.test(SQL),
            'Nessun `GET DIAGNOSTICS … = ROW_COUNT` dopo l\'UPDATE: se un giorno la riapertura ' +
                'toccasse 0 righe dove doveva toccarne 1, niente lo direbbe.',
        ).toBe(true)
        expect(
            SQL,
            '`movimenti_riaperti` non esce dal `jsonb_build_object` finale: il conteggio ' +
                'resterebbe dentro la funzione, e la route non potrebbe né loggarlo né dirlo ' +
                "all'operatore.",
        ).toMatch(/'movimenti_riaperti'\s*,\s*v_n_mov/)
    })

    it('la RPC resta chiusa: SECURITY DEFINER, search_path, e solo `service_role`', () => {
        // La riscrittura di un corpo con `CREATE OR REPLACE` conserva i privilegi
        // esistenti: ometterle qui lascerebbe in piedi ciò che c'era, che su
        // Supabase include l'EXECUTE concesso ad `anon`/`authenticated`.
        expect(SQL).toMatch(/SECURITY\s+DEFINER/i)
        expect(SQL).toMatch(/SET\s+search_path\s*=\s*public/i)
        expect(SQL).toMatch(
            /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.annulla_transazione_contabile\(jsonb\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
        )
        expect(SQL).toMatch(
            /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.annulla_transazione_contabile\(jsonb\)\s+TO\s+service_role/i,
        )
    })
})
