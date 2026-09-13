import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · L'ANNULLO RIAPRE IL MOVIMENTO **SENZA** DISARMARE LA GUARDIA CHE LO PROTEGGE.
 *
 * ─── IL DIFETTO, MISURATO ───────────────────────────────────────────────────
 *
 * `annulla_transazione_contabile` (migrazione `…180200_…`) riapre il movimento
 * bancario legato alla transazione annullata. La prima stesura azzerava anche
 * `pagamento_id` — e quella colonna non è un ornamento: è l'unico appiglio della
 * guardia «un bonifico non si fattura due volte» in
 * `src/app/api/pagamenti/riconciliazione/[id]/route.ts`, che comincia con
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
 */

const RADICE = process.cwd()
const FILE_SQL = join(
    RADICE,
    'supabase',
    'migrations',
    '20260912180200_annulla_transazione_riapre_movimento.sql',
)
const FILE_GUARDIA = join(
    RADICE,
    'src',
    'app',
    'api',
    'pagamenti',
    'riconciliazione',
    '[id]',
    'route.ts',
)

const SQL = readFileSync(FILE_SQL, 'utf8')
const GUARDIA = readFileSync(FILE_GUARDIA, 'utf8')

/**
 * La route SENZA i suoi commenti. Non è una raffinatezza: è la stessa pulizia
 * che `istruzioneUpdate()` fa qui sotto sull'SQL, per la stessa identica
 * ragione, su un file che la pretende anche di più. La prosa di quella route
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
 *
 * Che lo strip a regex basti QUI è anch'esso misurato, non supposto: rimuove
 * esattamente gli stessi byte (16.935 → 10.881, sha identico) che rimuove il
 * parser di TypeScript (`createSourceFile` + `getLeadingCommentRanges`); e dei
 * 120 letterali del file — stringhe, template, regex — ZERO contengono una
 * sequenza che possa disallinearlo (due sbarre, o un delimitatore di commento
 * a blocco). La prima asserzione dell'`it` sorveglia che resti vero.
 */
const GUARDIA_CODICE = GUARDIA.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

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
                '(`src/app/api/pagamenti/riconciliazione/[id]/route.ts`), che comincia con ' +
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

    it('🔴 la guardia che giustifica la scelta qui sopra ESISTE ancora nel CODICE della route', () => {
        // Le due metà viaggiano insieme: se un giorno la guardia cambia forma o
        // sparisce, conservare `pagamento_id` non protegge più niente e chi legge
        // la migrazione crederebbe il contrario.
        //
        // Si asserisce su GUARDIA_CODICE, MAI su GUARDIA: entrambe le stringhe
        // cercate qui sotto compaiono anche nella prosa di quella route, e sul
        // file grezzo questo blocco restava verde con la guardia cancellata.

        // Sanity dello strip, prima di tutto: se domani la route guadagnasse un
        // letterale con due sbarre dentro (un URL) o un delimitatore di commento,
        // la pulizia potrebbe disallinearsi — tagliare del codice, o peggio
        // lasciare in piedi un commento e con lui la cecità che si sta chiudendo.
        const delimitatoriResidui = GUARDIA_CODICE.match(/\/\/|\/\*|\*\//g) ?? []
        expect(
            delimitatoriResidui,
            `Dopo la pulizia dei commenti restano dei delimitatori (${delimitatoriResidui.join(' ')}): ` +
                'o un commento è sopravvissuto, o lo strip a regex si è disallineato su un letterale ' +
                'che li contiene. In entrambi i casi le due asserzioni qui sotto non stanno più ' +
                'leggendo il solo codice: si passi a una pulizia col parser di TypeScript ' +
                '(`createSourceFile` + `getLeadingCommentRanges`, o `transpileModule` con ' +
                '`removeComments`).',
        ).toEqual([])
        expect(
            GUARDIA_CODICE,
            'la pulizia dei commenti ha divorato anche il corpo della route: non ci si legge più ' +
                'nemmeno la firma del `withRoute`. Le asserzioni qui sotto sarebbero verdi o rosse ' +
                'sul nulla — si vada col parser.',
        ).toContain("withRoute('pagamenti/riconciliazione/[id]:PATCH'")

        expect(
            /mov\.pagamento_id\s*!=\s*null/.test(GUARDIA_CODICE),
            'In `src/app/api/pagamenti/riconciliazione/[id]:PATCH` non c\'è più la guardia ' +
                '`mov.pagamento_id != null` — non nel CODICE: i commenti che la nominano non ' +
                'contano, ed è esattamente il motivo per cui qui si legge la route ripulita. La ' +
                'migrazione dell\'annullo conserva `pagamento_id` PROPRIO perché quella guardia lo ' +
                'legga: senza, la riapertura automatica torna a essere una strada aperta verso il ' +
                'doppio incasso. Si aggiornano insieme, o si scrive qui perché non serva più.',
        ).toBe(true)
        expect(
            GUARDIA_CODICE,
            'il codice `BONIFICO_GIA_FATTURATO` non compare più nel codice della route (il ' +
                'commento che lo cita non conta): è il 409 che ferma il riabbinamento di un ' +
                'bonifico già fatturato.',
        ).toContain('BONIFICO_GIA_FATTURATO')
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
