import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · I TESTI DEL PANNELLO «COMPONI IL PAGAMENTO» REGGONO DA SOLI.
 *
 * ─── IL DIFETTO, MISURATO IL 2026-09-12 ──────────────────────────────────────
 *
 * La famiglia `reconComponi*` è nata con 21 chiavi (titolo, campi, quadratura,
 * conferma, riapertura) e **senza due dei mattoni che un pannello deve avere per
 * essere usabile**: una via d'uscita e lo stato vuoto del suo unico elenco.
 * Nessuno strumento poteva accorgersene: `messaggi-parita-cataloghi` verifica che
 * italiano e inglese si somiglino — e **due cataloghi possono essere perfettamente
 * simmetrici e perfettamente incompleti**; `messaggi-chiavi-orfane` guarda le chiavi
 * di troppo, non quelle che mancano, e su `adminContabilita` non è nemmeno acceso.
 *
 * Le due assenze non erano un'opinione, erano misurabili contro il pannello gemello
 * già in produzione:
 *
 *  1. VIA D'USCITA. `reconLottoChiudi` («Chiudi» / «Close») è la via d'uscita del
 *     pannello del lotto fatture, usata da `LottoFatturePanel.tsx:779` proprio come
 *     azione di chiusura. **La convenzione del namespace è che ogni pannello porti
 *     la PROPRIA chiave d'uscita, anche se `shared.chiudi` esiste già**, e il numero
 *     che lo dimostra è quello delle chiavi che ripetono `shared.chiudi` PAROLA PER
 *     PAROLA: contate il 2026-09-12 prima di questa correzione, le chiavi di
 *     `adminContabilita` il cui testo italiano è **esattamente** «Chiudi» erano
 *     **11** (`cassaChiuChiudi`, `cassaMovChiudi`, `dashChiudi`, `fatBtn_chiudi`,
 *     `incChiudi`, `modifChiudi`, `movdlgChiudi`, `quickChiudi`, `rateChiudi`,
 *     `sosp_chiudi`, `reconLottoChiudi`), e quelle il cui testo è esattamente
 *     «Annulla» altre 12. Il numero è scritto con la sua definizione apposta: una
 *     prima stesura di questo commento diceva «30 chiavi in 14 famiglie», che erano
 *     le chiavi il cui testo *comincia* con una parola d'uscita — dentro ci finiscono
 *     `movdlgChiudiDettaglio` («Chiudi il movimento», che chiude un movimento
 *     contabile, non un pannello) e `transAnnulloTitolo`, che uscite non sono.
 *     «Componi il pagamento» aveva `reconComponiConferma` e nient'altro: l'unico
 *     pannello del namespace da cui si entra e non si esce.
 *
 *  2. STATO VUOTO. `reconComponiVociAperte` intesta un elenco che **può benissimo
 *     essere vuoto**, ed è proprio il caso in cui il testo serve di più: una famiglia
 *     senza voci aperte è quella per cui l'operatrice deve aggiungere le voci a mano.
 *     Senza la chiave, l'elenco si rende vuoto e muto. Il namespace ha già tre
 *     precedenti per la stessa cosa (`reconVuoto`, `reconVuotoFiltro`,
 *     `reconLottoNessunaPronta`).
 *
 * ─── E DUE COSE DI LESSICO, DALLA STESSA MISURA ──────────────────────────────
 *
 *  3. L'ÀNCORA. `reconComponiAncora` è l'etichetta del campo che decide da quale
 *     voce si prendono intestatario e sede del documento. In inglese l'etichetta
 *     («Invoice details taken from») ripeteva parola per parola il messaggio d'errore
 *     che la reclama (`shared.erroreConciliazioneAncoraMancante`); in italiano no —
 *     l'etichetta diceva «Fattura intestata dalla voce» e l'errore «Scegli la voce da
 *     cui intestare la fattura». Due formule per lo stesso campo, nella stessa
 *     schermata: è il difetto n. 2 di `messaggi-plurali-e-glossario` (il glossario),
 *     ma fra un'etichetta e il suo errore, dove quel lock non guarda.
 *
 *     PERCHÉ LA FORMA NOMINALE («Voce da cui intestare la fattura») E NON L'IMPERATIVO
 *     DELL'ERRORE («Scegli la voce…»): perché è quello che fanno le etichette di campo
 *     di questo prodotto. MISURA, con il comando che la rifà, da eseguire invece di
 *     rileggere questo paragrafo:
 *
 *     node -e 'const f=require("fs"),p=require("path"),C=new Map();const pia=(v,k="")=>v&&typeof v=="object"&&!Array.isArray(v)?Object.entries(v).flatMap(([a,b])=>pia(b,k?k+"."+a:a)):[[k,v]];for(const n of f.readdirSync("messages/it").filter(x=>x.endsWith(".json")))for(const[k,v]of pia(JSON.parse(f.readFileSync("messages/it/"+n))))if(typeof v=="string"&&!C.has(k))C.set(k,v);const W=d=>f.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?W(p.join(d,e.name)):[p.join(d,e.name)]);const L=new Map();for(const F of W("src/components/features/admin").filter(x=>x.endsWith(".tsx")))for(const m of f.readFileSync(F,"utf8").matchAll(/<label\b[^>]*>((?:[^<]|<(?!\/?[a-zA-Z]))*)<\/label>/g))for(const k of m[1].matchAll(/\b(?:t|t[A-Z]\w*)\(\s*.([\w.]+)./g))if(C.has(k[1]))L.set(k[1],C.get(k[1]));const I=/^(aggiungi|annulla|apri|attiva|carica|cerca|chiudi|conferma|crea|elimina|filtra|genera|imposta|indica|inserisci|intesta|invia|modifica|ordina|programma|registra|rimuovi|salva|scarica|scegli|scrivi|seleziona|sposta|usa|verifica)\b/i;console.log("etichette di campo:",L.size,"· imperative:",[...L].filter(([,v])=>I.test(v)).map(([k,v])=>k+" = "+v))'
 *
 *     Perimetro: le chiavi che sono il contenuto INTERO di un `<label>` — cioè le
 *     etichette di un campo, non i `<label>` che avvolgono una casella di spunta e il
 *     suo testo — in `src/components/features/admin/`. Eseguito il 2026-09-12 su
 *     questo branch: **189 etichette, 8 imperative**, cioè 181 nominali su 189, il 96%.
 *
 *     ⚠️ ERANO SCRITTE «4», E L'ELENCO DI VERBI DENTRO IL COMANDO OMETTEVA PROPRIO
 *     QUELLI CHE CONTAVANO. Rifatta la rassegna su tutte le parole iniziali delle 189
 *     etichette — 96 distinte, lette una per una invece di fidarsi dell'elenco — ne
 *     sono uscite altre quattro: `sposta`, `intesta` e `programma` (due chiavi). Il
 *     comando qui sopra è quello CORRETTO, e le 8 si dividono in tre classi, perché
 *     dire «sono tutte comandi» sarebbe di nuovo falso:
 *      · quattro sono comandi, non campi che si compilano: `cerca` («Cerca…»),
 *        `legamiCercaEtichetta`, `ordina` («Ordina»), `selezionaRiga` («Seleziona
 *        {nome}») — due ricerche, un ordinamento, la casella di spunta di una riga;
 *      · due sono campi veri, e uno è **proprio la classe di `reconComponiAncora`**:
 *        `incIntestaCredito` («Intesta il credito a») è il `<label>` del `<select>`
 *        che sceglie il pagante intestatario del credito
 *        (`RegistraIncassoModal.tsx:282`), cioè un campo il cui valore finisce su un
 *        documento; `trasferimentoScegli` («Sposta in») è il `<select>` della sede di
 *        destinazione di un trasferimento (`StudentDetailPanel.tsx:1498`);
 *      · due sono ambigue in italiano e verbali in inglese: `editorProgrammaPer` e
 *        `proposteProgrammaPer` («Programma per» / «**Schedule** for»), etichette di
 *        un `<input type="datetime-local">`.
 *
 *     LA CONCLUSIONE REGGE LO STESSO, ed è il motivo per cui la correzione è qui e
 *     non nel catalogo: 181 nominali su 189 restano la convenzione di questo prodotto.
 *     A essere falsi erano il numero e l'assoluto («nessuna è un campo il cui valore
 *     finisce su un documento»), dentro un riquadro nato apposta per aver sostituito
 *     due misure non riproducibili. La forma nominale di `reconComponiAncora` sta in
 *     piedi per la regola generale, non perché non esistano eccezioni: ne esistono due,
 *     e sono nominate qui sopra.
 *
 *     ⚠️ QUESTA MISURA SOSTITUISCE DUE MISURE CHE NON SI RIPRODUCEVANO, e vale la pena
 *     sapere quali, perché la seconda ha quasi rimpiazzato la prima. (a) «740 etichette
 *     corte, 14 imperativi» stava solo nel rapporto di un esecutore, in nessun file: il
 *     740 torna, il 14 no — con la definizione «etichetta ≤ 3 parole» gli imperativi
 *     sono 127. (b) «su 152 chiavi dentro un `<label>`, ZERO cominciano con un
 *     imperativo», portata per correggere la prima: rieseguita qui, non torna né il 152
 *     né lo zero. Una misura che contraddice una misura sbagliata non è per ciò stesso
 *     giusta: va rifatta anche lei, ed è quello che questo riquadro è.
 *
 *  4. IL TICKET. `reconComponiAggiungiTicket` sta accanto ad «Aggiungi voce», fra
 *     rette, pomeridiano e gite: è un contesto MISTO, e lì il catalogo qualifica la
 *     parola in entrambe le lingue — `cnav_ticket` = «Ticket mensa» / «Meal tickets».
 *     Nudo («ticket», «tickets») il termine compare solo dove il contesto è già quello
 *     dei buoni mensa: `ticket_*` in `TicketMensaPanel`, e `transTicket` come unità di
 *     misura accanto a un numero (`TransazioniPanel.tsx:424`). L'inglese qui
 *     qualificava già, l'italiano no.
 *
 *     ⚠️ LA REGOLA GUARDAVA UNA CHIAVE SOLA, e la stesura che l'ha scritta lo aveva
 *     pure dichiarato: «anche `reconComponiErrQuantitaNonValida` dice "ticket mensa",
 *     ma a mano». Una prova che sorveglia UNA chiave è cieca a quella scritta il giorno
 *     dopo — che è la stessa specie di difetto dei punti 5 e 6. Il perimetro è ora la
 *     FAMIGLIA: ogni `reconComponi*` che nomina il ticket lo qualifica. Misurato prima
 *     di generalizzare: 2 chiavi per lingua, entrambe già qualificate — un rafforzamento
 *     che non ha chiesto una riscrittura, solo di smettere di guardare dal buco della
 *     serratura.
 *
 * ─── E DUE COSE AGGIUNTE IL 2026-09-12, DOPO IL TERZO RIFIUTO ────────────────
 *
 *  5. UN NOME SOLO PER LA RIGA BANCARIA. Le 23 chiavi `reconComponi*` della prima
 *     stesura — 23, ricontate: il «24» che gira nei rapporti è il numero delle RIGHE
 *     aggiunte al file, e una delle 24 è la riga preesistente che ha preso la virgola —
 *     scritte in un colpo solo, chiamavano la riga di estratto conto «bonifico» in
 *     `reconComponiQuadraturaAvanza`/`…Ok` e «movimento» in `reconComponiRiapri`/
 *     `…AvvisoRiapertura` — in inglese «transfer» e «transaction». È lo stesso difetto
 *     descritto al punto 3, otto chiavi più in basso e dentro LA STESSA SCHERMATA: le
 *     chiavi preesistenti del namespace che oscillano fra le due parole stanno in
 *     pannelli diversi, dove non si incontrano mai. E «transaction» era pure già
 *     occupato dalla TRANSAZIONE CONTABILE (le chiavi `trans*`), cioè dalla scrittura
 *     che nasce dal bonifico, non dal bonifico.
 *     Scelto «bonifico» / «bank transfer», per tutte e quattro, e per i messaggi
 *     d'errore della stessa fetta (`shared.erroreConciliazione*`, `…erroreRiapertura*`).
 *     Nessuna chiave preesistente è stata toccata: sarebbe stato un riordino.
 *
 *     ⚠️ DUE DELLE QUATTRO NON ESISTONO PIÙ (2026-09-13). `reconComponiRiapri` e
 *     `reconComponiAvvisoRiapertura` sono state tolte dal catalogo: la prima
 *     duplicava `movdlgRiapri`, che è la chiave del pulsante davvero reso dal
 *     popup; la seconda era una conferma PREVENTIVA, e i numeri delle fatture vive
 *     si conoscono solo DOPO la riapertura (li manda il server sulla risposta).
 *     Il paragrafo qui sopra resta com'è perché racconta il 2026-09-12, quando
 *     quelle quattro chiavi c'erano tutte: la regola che ne è nata vale ancora, e
 *     si applica ora a due chiavi invece che a quattro.
 *
 *     ⚠️ QUI C'ERA «21 chiavi preesistenti (11 bonifico, 10 movimento)», E NON SI
 *     RIPRODUCE DA NESSUN PERIMETRO. Rifatte le misure su `main`, in
 *     `messages/it/adminContabilita.json` (1027 chiavi):
 *       node -e 'const C=require("./messages/it/adminContabilita.json");const E=Object.entries(C).filter(([,v])=>typeof v=="string");const c=(re,rk)=>E.filter(([k,v])=>(!rk||rk.test(k))&&re.test(v)).length;console.log("bonific:",c(/bonific/i),"moviment:",c(/moviment/i),"· solo recon*:",c(/bonific/i,/^recon/),c(/moviment/i,/^recon/))'
 *     (da eseguire su `main`, cioè su `git show main:messages/it/adminContabilita.json`)
 *     radice `bonific`/`moviment` → **20 + 25**; singolare esatto → 20 + 19; ristretto
 *     a `recon*` → 5 + 8; `recon|trans|movdlg` → 10 + 10; con `cassaMov` → 11 + 15.
 *     La coppia 11/10 non esce da nessuno di questi. Il numero non è portante — la
 *     conclusione («riscriverle sarebbe un riordino») vale a 13 come a 45 — ma questo
 *     file pretende da sé, otto righe più su, che «il numero sia scritto con la sua
 *     definizione apposta». Il numero, con la sua definizione, è: **20 chiavi di
 *     `adminContabilita` su `main` contengono la radice «bonific», 25 la radice
 *     «moviment»**.
 *
 *  6. UN MESSAGGIO PER OGNI CODICE DI VIOLAZIONE. Il motore
 *     (`src/lib/pagamenti/conciliazione-composita.ts`) enumera i motivi per cui una
 *     composizione non si può confermare e scrive accanto a ciascuno che «il messaggio
 *     lo sceglie la UI». Finché la UI non c'è, «lo sceglie la UI» vuol dire «non
 *     esiste»: cercati in tutto `src/` e in tutti i cataloghi, gli 11 codici del
 *     2026-09-12 avevano ZERO occorrenze fuori dal modulo e dal suo test. Chi avrebbe
 *     scritto il componente ne avrebbe inventati 11 al volo, fuori da ogni lock.
 *     I codici NON sono ricopiati qui: si LEGGONO dal sorgente, così un codice
 *     aggiunto da un'altra fetta rende rosso questo file finché non ha il suo testo.
 *     (Il dodicesimo è arrivato davvero, il 2026-09-12: `costo_unitario_non_positivo`,
 *     e questo lock è diventato rosso finché non ha avuto il suo testo. Ha funzionato.)
 *
 *     ⚠️ MA L'ESTRATTORE DEGRADA IN SILENZIO, E IL PAVIMENTO ERA AGGREGATO. Misurato
 *     su forme alternative: con i doppi apici ritorna `[]`; con
 *     `export const CODICI = [...] as const` + `typeof CODICI[number]` ritorna `[]`;
 *     un codice con maiuscole o con un trattino lo scarta senza dire niente; un membro
 *     dell'unione a colonna zero tronca la lettura. Il presidio era
 *     `CODICI.length >= 8` su 12 codici: se `CodiceViolazioneComposizione` (2 codici)
 *     smettesse di essere letta resterebbero 10 ≥ 8, cioè **verde sul vuoto** — la
 *     trappola che questo lock esiste per evitare. Misurato eseguendolo: riscritta
 *     quell'unione a doppi apici, il vecchio presidio resta VERDE.
 *     La rete nuova è una CONTRO-LETTURA dall'altro capo — i punti in cui il motore
 *     EMETTE i codici (`aggiungi('…')`, `out.push('…')`) — con i due insiemi che devono
 *     coincidere: prende la perdita silenziosa in lettura **e** un codice dichiarato che
 *     nessuno emette più. Più un pavimento PER TIPO, perché due insiemi vuoti sono
 *     uguali fra loro e da sola l'uguaglianza sarebbe verde sul nulla.
 *
 * ─── E DUE COSE AGGIUNTE IL 2026-09-12, DOPO IL QUINTO RIFIUTO ───────────────
 *
 *  7. UN TESTO CHE MANDAVA DENTRO IL DIFETTO SUCCESSIVO. `reconComponiErrCostoUnitarioNegativo`
 *     diceva «Il costo unitario non può essere negativo. **Zero sì: è una ricarica in
 *     omaggio.**» / «Zero is fine: it's a free top-up.» Ma il motore, dalla riga
 *     accanto, fa
 *       if (costo < 0) aggiungi('costo_unitario_negativo')
 *       else if (costo <= 0) aggiungi('costo_unitario_non_positivo')
 *     cioè **lo zero è vietato**. Chi digitava
 *     `-1`, leggeva «Zero sì», correggeva a `0` e prendeva un secondo errore.
 *
 *     ⚠️ IL RIFERIMENTO È ALLE DUE RIGHE CITATE, NON AL LORO NUMERO, e la ragione sta
 *     scritta per esteso otto sezioni più in basso, nel punto 9: un numero di riga
 *     dentro un file di un'altra fetta invecchia da solo, e in silenzio. Qui era già
 *     successo: questa stesura citava `conciliazione-composita.ts:409-410`, e a
 *     quel punto c'è un commento (misurato il 2026-09-13: le due righe erano a
 *     `:413-414`, e quando leggerai saranno altrove). Sapevo che
 *     il numero era falso e l'avevo lasciato, mentre il rimedio era già applicato
 *     nella sezione accanto. Le due righe si ritrovano così, ed è una LETTURA che
 *     chiunque può rifare invece di rileggere questo paragrafo:
 *       grep -nF "if (costo < 0) aggiungi('costo_unitario_negativo')" src/lib/pagamenti/conciliazione-composita.ts
 *       grep -nF "else if (costo <= 0) aggiungi('costo_unitario_non_positivo')" src/lib/pagamenti/conciliazione-composita.ts
 *     Eseguiti il 2026-09-13: una occorrenza ciascuno.
 *     Non era colpa della stesura che l'ha scritto — la regola l'ha cambiata un'altra
 *     fetta dopo — ed è proprio per questo che serviva una PROVA: il lock dei codici
 *     vedeva un testo, non che quel testo fosse diventato falso. La regola nuova deriva
 *     la famiglia dal codice (`*_non_positivo` → `costo_unitario` →
 *     `reconComponiErrCostoUnitario*`) e vieta a quei testi di concedere lo zero.
 *     La concessione si scrive in due direzioni, e la seconda («il costo **può essere
 *     zero**») passava sotto la prima stesura del riconoscitore: misurato, verde. Ora
 *     sono chiuse tutt'e due. Il rimedio vero — la ricarica in omaggio si registra da
 *     «Ticket mensa», che non passa da `incassi` — sta nel testo del codice che lo
 *     zero lo vieta, cioè `reconComponiErrCostoUnitarioNonPositivo`.
 *
 *  8. I CODICI DEL RAMO TICKET PARLANO DEI CAMPI DEL RAMO TICKET. Nel ramo
 *     `riga.specie === 'ticket'` i campi a schermo non sono quelli di sempre: non c'è
 *     «Importo», ci sono «Quantità», «Costo unitario» e «Totale». E `importo_non_positivo`
 *     è emesso **in tutt'e due i rami** (`:419` e `:421`): il suo testo, «L'importo
 *     dev'essere maggiore di zero», mandava a cercare un campo che lì non esiste.
 *     Il ramo NON è elencato qui: si RITAGLIA dal motore contando le graffe, e i codici
 *     si leggono da dentro — così un codice spostato dentro o fuori porta con sé la
 *     propria regola. I nomi dei campi si leggono dal CATALOGO, non si ricopiano: se
 *     `reconComponiCampoQuantita` cambia parola, il messaggio va riallineato.
 *
 * ⚠️ DUE DIPENDENZE DA FUORI, ed è giusto saperlo prima di vedere il rosso:
 *  · la prova sull'àncora legge `shared.erroreConciliazioneAncoraMancante`. Se un
 *    giorno quella formula cambia, QUESTO lock diventa rosso senza che nessuno abbia
 *    toccato la fetta F5: la via d'uscita è riallineare l'etichetta `reconComponiAncora`
 *    alla formula nuova, non allentare il confronto.
 *  · la prova sui codici legge `export type CodiceViolazione` e
 *    `CodiceViolazioneComposizione` dal motore, che è di un'altra fetta. Un codice
 *    aggiunto là fa rosso qui, ed è il comportamento voluto — è l'unico momento in cui
 *    qualcuno si accorge che manca un testo.
 *  · e la prova del punto 8 ritaglia dal motore il ramo `specie === 'ticket'`. Se quel
 *    ramo cambia forma — un `if` senza graffe, un `switch` — il ritaglio cambia con
 *    lui: se ne accorge il pavimento (almeno 3 codici nel ramo), e la via d'uscita è
 *    riallineare il ritaglio, non toglierlo.
 *
 * ─── PERCHÉ UN LOCK SUL CATALOGO, E NON SUL COMPONENTE ───────────────────────
 *
 * Perché il componente non c'è ancora: i testi arrivano prima della schermata, ed è
 * esattamente la finestra in cui un mattone mancante non fa rumore da nessuna parte.
 * Quando la schermata arriverà, userà le chiavi che trova.
 *
 * ⚠️ COSA QUESTO LOCK **NON** DIMOSTRA: che il pannello mostri davvero quei testi.
 * Quella prova la darà il test del componente, quando il componente esisterà.
 */

const RADICE = process.cwd()
const LINGUE = ['it', 'en'] as const
type Lingua = (typeof LINGUE)[number]
type Catalogo = Record<string, string>

const leggi = (lingua: Lingua, ns: string): Catalogo =>
    JSON.parse(readFileSync(join(RADICE, 'messages', lingua, `${ns}.json`), 'utf8')) as Catalogo

const CONTABILITA: Record<Lingua, Catalogo> = { it: leggi('it', 'adminContabilita'), en: leggi('en', 'adminContabilita') }
const SHARED: Record<Lingua, Catalogo> = { it: leggi('it', 'shared'), en: leggi('en', 'shared') }

// ── 1 · La via d'uscita ──────────────────────────────────────────────────────

/** Le parole con cui, in questo prodotto, si esce da un pannello. */
const USCITA: Record<Lingua, RegExp> = {
    it: /^(chiudi|annulla|interrompi|indietro)\b/i,
    en: /^(close|cancel|stop|back)\b/i,
}

/** Le chiavi di una famiglia il cui testo è una via d'uscita. */
function vieDUscita(catalogo: Catalogo, prefisso: string, lingua: Lingua): string[] {
    return Object.entries(catalogo)
        .filter(([k, v]) => k.startsWith(prefisso) && typeof v === 'string' && USCITA[lingua].test(v))
        .map(([k]) => k)
}

/**
 * I pannelli della riconciliazione, col perimetro DICHIARATO: si allarga a misura,
 * una riga per pannello, come l'allowlist di `messaggi-chiavi-orfane`.
 */
const PANNELLI = [
    { prefisso: 'reconLotto', nome: 'Lotto fatture' },
    { prefisso: 'reconComponi', nome: 'Componi il pagamento' },
]

// ── 2 · Gli elenchi e il loro stato vuoto ────────────────────────────────────

const ELENCHI = [
    { dove: 'i movimenti della riconciliazione', vuoto: 'reconVuoto' },
    { dove: 'i movimenti sotto filtro', vuoto: 'reconVuotoFiltro' },
    { dove: 'le righe selezionate per il lotto', vuoto: 'reconLottoNessunaPronta' },
    {
        dove: 'le voci aperte della famiglia in «Componi il pagamento»',
        intestazione: 'reconComponiVociAperte',
        vuoto: 'reconComponiVociAperteVuoto',
        // Il vuoto qui non è un vicolo cieco: è il caso in cui si aggiungono le voci
        // a mano. Deve nominare l'azione del pulsante che sta lì accanto.
        nominaLAzioneDi: 'reconComponiAggiungiVoce',
    },
]

// ── 3 · L'etichetta e il messaggio d'errore che la reclama ───────────────────

/** Parole di servizio: non portano significato, e pretenderle sarebbe rumore. */
const PAROLE_DI_SERVIZIO: Record<Lingua, Set<string>> = {
    it: new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'del', 'della', 'dal', 'dalla', 'a', 'al', 'alla', 'in', 'nel', 'nella', 'per', 'con', 'su', 'e', 'o', 'che', 'si']),
    en: new Set(['the', 'a', 'an', 'of', 'from', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'that', 'is', 'are', 'be', 'it']),
}

const parole = (testo: string): string[] =>
    testo
        .toLowerCase()
        .replace(/[’']/g, ' ')
        .split(/[^a-zà-ÿ]+/)
        .filter(Boolean)

/** Le parole significative dell'etichetta che il messaggio d'errore NON dice. */
function paroleNonRiprese(etichetta: string, messaggio: string, lingua: Lingua): string[] {
    const dette = new Set(parole(messaggio))
    return parole(etichetta).filter((p) => !PAROLE_DI_SERVIZIO[lingua].has(p) && !dette.has(p))
}

// ── 4 · Il ticket, in un contesto misto, si qualifica ────────────────────────

/**
 * ⚠️ È UNA REGOLA PER PAROLE, e il suo limite è misurato: un testo che nomina
 * «ticket mensa» in modo decorativo la soddisfa. «Valore non valido. (ticket
 * mensa)» passa VERDE. Prende chi DIMENTICA il contesto, non chi lo finge — e
 * nessuna regola su una stringa può fare la seconda cosa. Quello che una prova
 * automatica non vede resta lavoro di chi rilegge.
 */
const QUALIFICA_TICKET: Record<Lingua, RegExp> = { it: /mensa/i, en: /meal/i }

// ── 5 · La riga di estratto conto ha UN nome solo, per lingua ────────────────

/**
 * I modi in cui, in questo prodotto, si è chiamata la riga bancaria che si sta
 * conciliando. Ordinati qui per leggibilità: il riconoscitore li prova **dal più
 * lungo al più corto**, perché «bank transfer» contiene «transfer» e cercandoli
 * nell'ordine sbagliato una frase che usa un termine solo ne conterebbe due.
 */
const SINONIMI_ENTITA: Record<Lingua, string[]> = {
    it: ['bonifico', 'movimento', 'transazione', 'operazione bancaria', 'riga bancaria'],
    en: ['bank transfer', 'transaction', 'transfer', 'movement', 'bank line'],
}

/**
 * La radice di una parola, con la vocale finale tolta.
 *
 * Serve perché in italiano il plurale **cambia** l'ultima vocale invece di
 * aggiungere una lettera: «bonifico» → «bonifici». Un riconoscitore che cercasse
 * `bonifico[a-z]*` non vedrebbe «bonifici» — misurato scrivendo questa prova, che
 * è nata rossa proprio su quel caso.
 */
const radice = (parola: string): string => `${parola.replace(/[aeiou]$/i, '')}[a-zà-ÿ]*`

/** I termini con cui un testo nomina la riga bancaria. Il plurale conta come il singolare. */
function terminiUsati(testo: string, lingua: Lingua): Set<string> {
    let resto = testo
    const visti = new Set<string>()
    for (const termine of [...SINONIMI_ENTITA[lingua]].sort((a, b) => b.length - a.length)) {
        const corpo = `\\b${termine.split(' ').map(radice).join('\\s+')}`
        if (new RegExp(corpo, 'i').test(resto)) {
            visti.add(termine)
            // Cancellato ciò che si è trovato, così «bank transfer» non lascia
            // dietro di sé un «transfer» da contare una seconda volta.
            resto = resto.replace(new RegExp(corpo, 'gi'), ' ')
        }
    }
    return visti
}

/**
 * IL TERMINE SCELTO, cablato. Senza questo la regola imponeva la COERENZA e non il
 * TERMINE: misurato riscrivendo l'intera famiglia da «bonifico» a «transazione» in
 * tutt'e due le lingue — **verde**, pur essendo esattamente ciò che il messaggio
 * d'errore qui sotto dichiara vietato («già occupato dalla TRANSAZIONE CONTABILE»).
 * E non è una deriva teorica: delle chiavi preesistenti del namespace, una ventina
 * dice già «movimento» (il conto sta nel riquadro in testa, col suo perimetro).
 */
const TERMINE_SCELTO: Record<Lingua, string> = { it: 'bonifico', en: 'bank transfer' }

/** Il termine che nel prodotto nomina un'ALTRA cosa: la scrittura contabile. */
const ENTITA_CONTABILE: Record<Lingua, string> = { it: 'transazione', en: 'transaction' }

/**
 * LA VIA D'USCITA PER UNA CHIAVE FUTURA LEGITTIMA, decisa adesso invece che il
 * giorno in cui servirà.
 *
 * Il confronto `trovati.size !== 1` rifiuta **a torto** una frase che nomina
 * davvero tutt'e due le entità — «Questo bonifico ha già generato una transazione
 * contabile» è vera, utile e oggi ROSSA in italiano e in inglese (misurato). Senza
 * una porta dichiarata, il primo che ci sbatte allenta il confronto — che è il modo
 * in cui un lock diventa decorazione — invece di usarlo.
 *
 * La porta è questa lista, e ha un prezzo: una chiave ammessa può nominare la
 * transazione contabile **solo se dice anche come si chiama la riga bancaria**. Così
 * la deroga serve a chi descrive la relazione fra le due, e NON a chi rinomina la
 * riga bancaria con la parola dell'altra entità — che è il difetto vero.
 *
 * Si allunga una riga per volta, con la motivazione accanto, come l'allowlist di
 * `messaggi-chiavi-orfane`. Oggi è vuota: nessuna chiave della fetta ne ha bisogno.
 */
const AMMESSE_A_NOMINARE_LA_TRANSAZIONE = new Set<string>([])

/**
 * I termini con cui il perimetro nomina la riga bancaria, e dove.
 *
 * ⚠️ DUE LIMITI, misurati e dichiarati perché nessuno li scopra credendo di aver
 * trovato una falla nuova:
 *  (a) `SINONIMI_ENTITA` è un elenco CHIUSO: un sinonimo che non è là dentro non
 *      viene contato. Misurato: «Riapri il **versamento**» passa verde insieme alle
 *      altre chiavi che dicono «bonifico», perché «versamento» non è nell'elenco.
 *      Allargarlo non è gratis e nemmeno simmetrico: in inglese il candidato
 *      naturale sarebbe «payment», che in questa schermata è già IL PAGAMENTO
 *      composto (`reconComponiTitolo` = «Compose the payment») — aggiungerlo
 *      renderebbe il lock rosso su un catalogo corretto. Si allunga a misura, con
 *      la prova che il catalogo di oggi resta verde.
 *  (b) una chiave che nomina legittimamente ENTRAMBE le entità è rifiutata, e la
 *      via d'uscita è `AMMESSE_A_NOMINARE_LA_TRANSAZIONE` qui sopra — non un
 *      confronto più largo.
 */
function nomiDellaRigaBancaria(
    voci: Array<{ dove: string; testo: string }>,
    lingua: Lingua,
    ammesse: Set<string> = AMMESSE_A_NOMINARE_LA_TRANSAZIONE,
): Map<string, string[]> {
    const trovati = new Map<string, string[]>()
    for (const { dove, testo } of voci) {
        const usati = terminiUsati(testo, lingua)
        // La deroga vale SOLO se la chiave dice anche come si chiama la riga bancaria.
        if (ammesse.has(dove) && usati.has(TERMINE_SCELTO[lingua])) usati.delete(ENTITA_CONTABILE[lingua])
        for (const termine of usati) trovati.set(termine, [...(trovati.get(termine) ?? []), dove])
    }
    return trovati
}

/**
 * Il perimetro della regola: le chiavi nate con questa fetta, e **solo quelle**.
 * Le 21 chiavi preesistenti del namespace che oscillano fra «bonifico» e
 * «movimento» stanno in pannelli DIVERSI, dove la convivenza non si vede mai:
 * riscriverle sarebbe un riordino di catalogo, non una correzione.
 */
function vociDelPerimetro(lingua: Lingua): Array<{ dove: string; testo: string }> {
    const righe: Array<{ dove: string; testo: string }> = []
    for (const [chiave, testo] of Object.entries(CONTABILITA[lingua])) {
        if (chiave.startsWith('reconComponi') && typeof testo === 'string') {
            righe.push({ dove: `adminContabilita.${chiave}`, testo })
        }
    }
    for (const [chiave, testo] of Object.entries(SHARED[lingua])) {
        if (/^(erroreConciliazione|erroreRiapertura)/.test(chiave) && typeof testo === 'string') {
            righe.push({ dove: `shared.${chiave}`, testo })
        }
    }
    return righe
}

// ── 6 · Ogni codice di violazione ha il suo messaggio ────────────────────────

const SORGENTE_MOTORE = 'src/lib/pagamenti/conciliazione-composita.ts'

/** Via i commenti: un apostrofo dentro un commento italiano sembrerebbe un letterale. */
const senzaCommenti = (sorgente: string): string =>
    sorgente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

/**
 * I codici dichiarati da un'unione di letterali del motore, **letti dal sorgente**.
 *
 * Ricopiarli qui sarebbe stato più semplice e sarebbe stato il difetto: un codice
 * aggiunto al motore da un'altra fetta nascerebbe senza messaggio e nessuno se ne
 * accorgerebbe, che è esattamente il buco che questo lock chiude. Letti di là,
 * invece, ogni codice nuovo rende questo file rosso finché il testo non c'è.
 *
 * L'unione finisce alla prima riga che riparte da colonna zero, qualunque sia il
 * numero di alternative e di commenti in mezzo.
 */
function codiciDelTipo(sorgente: string, nome: string): string[] {
    const trovato = new RegExp(`export type ${nome}\\b\\s*=([\\s\\S]*?)(?=\\n\\S|$)`).exec(sorgente)
    if (!trovato) throw new Error(`${SORGENTE_MOTORE}: non trovo \`export type ${nome}\``)
    return [...senzaCommenti(trovato[1]).matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])
}

// ── 7 · Chi vieta lo ZERO non può avere accanto un testo che lo concede ───

/**
 * I modi in cui un testo di questo catalogo dichiara AMMISSIBILE lo zero.
 *
 * DUE DIREZIONI, e la seconda è nata da una prova che la prima non passava.
 * La forma ovvia è «zero → concessione» («Zero sì», «lo zero è ammesso»), ed è
 * quella che il difetto vero aveva. Ma la stessa concessione si scrive benissimo
 * al rovescio — «Il costo **può essere zero**: è una ricarica in omaggio» — e una
 * regola che guardasse solo la prima direzione sarebbe **verde su quella frase**:
 * misurato scrivendo questo lock, sostituendo il testo difettoso con la forma
 * rovesciata e vedendo la prova passare. Cioè la riscrittura minima che rompe
 * l'invariante senza che l'asserzione se ne accorga: è chiusa qui.
 *
 * La finestra della prima direzione è corta apposta (`[^.]{0,12}`, e mai oltre il
 * punto): prende la concessione dentro la stessa frase, non una che sta tre
 * periodi più in là e parla d'altro. La seconda pretende invece l'ADIACENZA
 * («può essere zero»), perché senza di quella «dev'essere maggiore di zero» —
 * cioè il divieto — sarebbe letto come una concessione.
 *
 * ⚠️ LA CIFRA, ED È COME QUESTO CATALOGO SCRIVE GIÀ LO ZERO. Fino a questa stesura
 * la regola cercava soltanto `\bzero\b`, e la riscrittura MINIMA del difetto vero —
 * «Il costo unitario dei ticket mensa **può essere 0**: è una ricarica in omaggio» —
 * passava VERDE in italiano e in inglese (misurato, ed è il rosso da cui questa
 * riga è nata). Non è nemmeno una forma esotica: `adminContabilita` usa la cifra `0`
 * isolata in **10 chiavi**, e tre dicono letteralmente «Inserisci un importo maggiore
 * di 0» (`gencErrImporto`, `quickErrImporto`, `rateErrImporto`). Il catalogo scriveva
 * in tutt'e due i modi; la regola ne guardava uno.
 *
 * ⚠️ E LA NEGAZIONE, CHE LA CIFRA AVREBBE PEGGIORATO. Prima di questa stesura tre
 * divieti italiani perfettamente scritti erano letti come CONCESSIONI — «Il costo
 * unitario **non** può essere zero», «Lo zero **non** è ammesso», «Lo zero **non** va
 * bene» (misurati): il lock sarebbe diventato rosso su un catalogo corretto. Con la
 * sola aggiunta della cifra sarebbero saliti a cinque, perché «non può essere 0» e
 * «lo 0 non è ammesso» sono le stesse frasi in cifra. Chiusi insieme: la finestra
 * della prima direzione non attraversa un «non»/«mai», e il verbo della seconda non
 * può averlo davanti.
 *
 * ⚠️ E LA GUARDIA CHE LI CHIUDEVA ERA DI SOLA ADIACENZA, cioè guardava UNA parola:
 * ne restavano fuori tre, misurati col vitest vero e non dedotti — «**Non è** ammesso
 * lo zero», «**Non si** può indicare zero» e, in inglese, «The field **never accepts**
 * 0», dove il ramo `accepts?` non aveva guardia nessuna. Erano 3 falsi positivi, e la
 * frase qui sopra — «in inglese la seconda direzione era già immune» —
 * era vera per `can be` e falsa per `accepts`. Chiusi con un lookbehind A FINESTRA
 * (`NEGAZIONE_DAVANTI`, qui sotto), che ferma la negazione fino a 24 caratteri prima
 * del verbo senza attraversare il punto. Il conto dei divieti non è più scritto a
 * mano: lo asserisce la prova («il denominatore dei divieti è cambiato»), perché la
 * stesura precedente si era chiusa dichiarando «0 falsi positivi su 21 divieti»
 * quando i divieti erano 19.
 *
 * ⚠️ RESTA UN'EURISTICA SU PAROLE, E IL SUO TASSO È MISURATO DUE VOLTE, perché un
 * numero solo era un numero gentile con sé stesso. Fino a questa stesura diceva
 * «**54 su 66**, l'82%» — ed era esatto, ma le 66 forme erano state scritte GUARDANDO
 * la regola, una per ogni alternativa che la regex già prevedeva. Un tasso alto su un
 * elenco costruito attorno alla propria regola misura quanto l'elenco somiglia alla
 * regola, non quanto la regola copre la lingua. Misurato da chi ha riletto: su 24
 * forme scritte CONTRO la regola, nessuna esotica, ne passavano 9.
 * I due numeri di oggi, e la prova che li ricalcola sta dentro questo file:
 *  · **56 su 68** (82%; it 34/41, en 22/27) sulle forme costruite ATTORNO alla regola:
 *    serve solo a impedire che una copertura di oggi si perda domani;
 *  · **2 su 26** (8%; it 1/13, en 1/13) sulle forme costruite CONTRO, scritte come si
 *    scriverebbe un messaggio invece che come la regex vorrebbe leggerlo. Questo è il
 *    numero onesto, ed è basso: la regola prende chi DIMENTICA il divieto, non chi
 *    scrive la concessione in un modo che non le è stato insegnato;
 *  · **58 su 94** (62%) in tutto.
 * È lo stesso difetto che il riquadro di ieri rimproverava a sé stesso un piano più
 * su — dare l'elenco delle forme chiuse senza il tasso «fa credere a chi legge che la
 * copertura sia più alta del vero» — solo commesso un piano più in alto, sul tasso
 * invece che sull'elenco.
 *
 * LE 36 FORME CHE RESTANO FUORI stanno nella prova, divise in NOVE classi
 * (`FUORI_PORTATA`), e i numeri per classe non sono scritti da nessuna parte: sono la
 * lunghezza degli elenchi. Le tre di ieri — l'imperativo senza verbo di concessione,
 * la litote, la perifrasi — ci sono ancora; le altre sei sono uscite dalle forme
 * costruite contro la regola: il verbo fuori elenco, l'aggettivo o il participio
 * fuori elenco, qualcosa fra la copula e l'aggettivo, l'ordine delle parole, il
 * soggetto attivo o il plurale, lo zero dopo la concessione.
 * Chi ne trova un'altra la aggiunga lì: **una forma nuova non è la prova che la
 * regola non serva**, è la prova che l'elenco è corto di una riga — e che i tassi qui
 * sopra vanno rifatti, non cancellati. L'asserzione è un'UGUAGLIANZA, non un
 * pavimento: si accorge anche se la copertura MIGLIORA, perché un numero che scende
 * in silenzio e uno che sale in silenzio invecchiano nello stesso modo.
 */

/**
 * Lo zero, **a parola o in cifra** — ma non lo `0` di `10`, di `0,5` o di `1.0`.
 *
 * ⚠️ IL LOOKAHEAD GUARDA LA CIFRA DOPO IL SEPARATORE, NON IL SEPARATORE. La forma
 * ovvia — `(?<![\d,.])0(?![\d,.])` — è quella con cui questa riga è nata, ed è
 * CIECA SUL PUNTO FERMO: «Il costo unitario può essere 0.» non veniva vista, e un
 * messaggio di catalogo finisce col punto praticamente sempre. Misurato: con quella
 * forma «È accettato 0.», «The unit cost can be 0.» e «The field accepts 0.»
 * restavano fuori — cioè il lock sarebbe rimasto cieco proprio sulla scrittura più
 * naturale della concessione. Un punto DECIMALE è seguito da una cifra, un punto
 * FERMO no: è l'unica differenza che serve, ed è quella che questa riga guarda.
 */
const ZERO = String.raw`(?:\bzero\b|(?<![\d,.])0(?!\d)(?![.,]\d))`

/** Ciò che NEGA: non deve stare fra lo zero e la sua concessione, né davanti al verbo. */
const NEGAZIONE: Record<Lingua, string> = {
    it: String.raw`(?!\bnon\b|\bmai\b)`,
    en: String.raw`(?!\bnot\b|\bnever\b)`,
}

/**
 * LA NEGAZIONE DAVANTI AL VERBO, e la guardia è A FINESTRA, non di adiacenza.
 *
 * ⚠️ ERA `(?<!\bnon\s)(?<!\bmai\s)`, CIOÈ UNA PAROLA SOLA, E URLAVA SU TRE DIVIETI
 * SCRITTI BENE. Misurati con vitest, non dedotti: `reconComponiErrCostoUnitarioNonPositivo`
 * riscritta «**Non è ammesso** lo zero», «**Non si può** indicare zero» e — in inglese,
 * dove il ramo `accepts?` non aveva **nessuna** guardia — «The field **never accepts** 0».
 * In tutt'e tre la negazione sta due parole più su del verbo che concede: un lookbehind
 * che guarda la parola attaccata non la vede, e il lock diventava rosso su un catalogo
 * corretto — la classe stessa per cui la guardia era nata.
 *
 * La finestra si ferma al punto (`[^.]`), come quella dell'altra direzione: una
 * negazione del periodo precedente non deve spegnere la concessione di questo.
 * Misurato dopo la correzione: 0 concessioni perse sulle forme riconosciute, 0 divieti
 * scambiati, e il tasso delle forme costruite attorno alla regola resta identico
 * (54/66) — cioè la guardia chiude i falsi positivi senza tagliare niente.
 */
const NEGAZIONE_DAVANTI: Record<Lingua, string> = {
    it: String.raw`(?<!\b(?:non|mai)\b[^.]{0,24})`,
    en: String.raw`(?<!\b(?:not|never)\b[^.]{0,24})`,
}

const ZERO_CONCESSO: Record<Lingua, RegExp> = {
    it: new RegExp(
        `${ZERO}(?:${NEGAZIONE.it}[^.]){0,12}` +
        String.raw`(?:s[ìi](?![a-zà-ÿ])|va ben\w*|ci sta|[èe] (?:ammess|ammissibil|consentit|valid|accettat|permess|tollerat|legittim|previst)\w*|si pu[òo]|ok\b)` +
        '|' +
        NEGAZIONE_DAVANTI.it +
        String.raw`(?:pu[òo]i?|possono|potr[àeb]\w*|accett\w+|ammett\w+|ammess\w+|consent\w+|va ben\w*)\s+(?:essere|valere|indicare|mettere)?\s*(?:anche\s+)?(?:lo\s+)?` +
        ZERO,
        'i',
    ),
    en: new RegExp(
        `${ZERO}(?:${NEGAZIONE.en}[^.]){0,12}` +
        String.raw`(?:is (?:fine|ok|okay|allowed|accepted|acceptable|valid|permitted|tolerated|possible)|can be|works)` +
        '|' +
        NEGAZIONE_DAVANTI.en + String.raw`(?:can|may|could|might)\s+be\s+` + ZERO +
        `|${NEGAZIONE_DAVANTI.en}accepts?\\s+${ZERO}`,
        'i',
    ),
}

/**
 * `costo_unitario_non_positivo` → `costo_unitario`. Gli altri codici: `null`.
 *
 * ⚠️ IL PERIMETRO È LA FAMIGLIA DEL CODICE (`reconComponiErrCostoUnitario*`), NON
 * TUTTO IL PANNELLO, ed è una scelta, non una dimenticanza: misurato, una
 * concessione scritta in `reconComponiCampoTotale` («Totale (lo zero è ammesso)»)
 * passa VERDE. Allargare a ogni `reconComponi*` renderebbe rossa anche una
 * concessione legittima — uno sconto a zero, un saldo a zero — dove nessun codice
 * `*_non_positivo` la contraddice. La regola dice «non contraddire il codice
 * accanto», non «non nominare mai lo zero».
 */
const SUFFISSO_NON_POSITIVO = '_non_positivo'
const famigliaCheVietaLoZero = (codice: string): string | null =>
    codice.endsWith(SUFFISSO_NON_POSITIVO) ? codice.slice(0, -SUFFISSO_NON_POSITIVO.length) : null

// ── 8 · Il ramo TICKET del motore, e i campi di cui parlano i suoi codici ────

/**
 * Il corpo del blocco che si apre dopo `ancora`, dalla sua graffa a quella che la
 * chiude, **contando le graffe**. Serve a leggere UN ramo del motore invece di
 * tutto il file: i codici emessi sulla ricarica ticket stanno dentro
 * `if (riga.specie === 'ticket') { … }`, e lì i campi a schermo non si chiamano
 * come nel ramo accanto.
 *
 * ⚠️ Va usata sul sorgente SENZA COMMENTI: una graffa dentro un commento —
 * `{ indice: 0, codice: … }` ce n'è più d'una, in questo motore — sbilancerebbe il
 * conto. Il limite dichiarato: una graffa dentro un LETTERALE di stringa farebbe
 * lo stesso, e in questo ramo non ce ne sono (se un giorno ce ne fossero, il
 * blocco estratto cambierebbe e i codici letti con lui: se ne accorge il pavimento
 * qui sotto, che pretende che il ramo ticket ne emetta almeno 3).
 */
function bloccoBilanciato(sorgente: string, ancora: string): string {
    const inizio = sorgente.indexOf(ancora)
    if (inizio < 0) throw new Error(`${SORGENTE_MOTORE}: non trovo \`${ancora}\``)
    const apertura = sorgente.indexOf('{', inizio + ancora.length)
    if (apertura < 0) throw new Error(`${SORGENTE_MOTORE}: nessuna graffa dopo \`${ancora}\``)
    let livello = 0
    for (let i = apertura; i < sorgente.length; i += 1) {
        if (sorgente[i] === '{') livello += 1
        else if (sorgente[i] === '}') {
            livello -= 1
            if (livello === 0) return sorgente.slice(apertura + 1, i)
        }
    }
    throw new Error(`${SORGENTE_MOTORE}: graffa mai chiusa dopo \`${ancora}\``)
}

/**
 * I codici EMESSI da un pezzo di motore: `aggiungi('…')` e `out.push('…')`.
 *
 * Il letterale si prende intero (`[^']*`) e non con la forma di un codice
 * (`[a-z][a-z0-9_]*`), ed è voluto: un codice scritto `'Costo-Zero'` non è
 * dichiarabile in nessuna chiave di catalogo, e dev'essere VISTO per poter essere
 * segnalato. L'estrattore dei tipi lo scarterebbe in silenzio — è il difetto che
 * la contro-lettura qui sotto esiste per prendere.
 */
function codiciEmessi(sorgente: string): string[] {
    // ⚠️ Nessuna parentesi chiusa pretesa dopo il letterale, e non è pigrizia: una
    // prima stesura cercava `aggiungi('…')` con la `)` attaccata, e una contro-prova
    // con `aggiungi('codice_fantasma' as CodiceViolazione)` — cioè un codice emesso e
    // mai dichiarato, esattamente il caso che questa lettura esiste per prendere — le
    // è passata sotto VERDE. Un cast, un secondo argomento o uno spazio bastavano.
    return [...sorgente.matchAll(/(?:aggiungi|out\.push)\(\s*'([^']*)'/g)].map((m) => m[1])
}

const MOTORE = readFileSync(join(RADICE, SORGENTE_MOTORE), 'utf8')
const CODICI = [
    ...codiciDelTipo(MOTORE, 'CodiceViolazione'),
    ...codiciDelTipo(MOTORE, 'CodiceViolazioneComposizione'),
]

const MOTORE_SENZA_COMMENTI = senzaCommenti(MOTORE)
/** Il corpo di `violazioniRighe`: dentro, il ramo ticket è uno solo. */
const CORPO_VIOLAZIONI_RIGHE = bloccoBilanciato(MOTORE_SENZA_COMMENTI, 'export function violazioniRighe')
/** Il ramo della ricarica ticket, e i codici che SOLO lì si possono leggere. */
const RAMO_TICKET = bloccoBilanciato(CORPO_VIOLAZIONI_RIGHE, "specie === 'ticket')")
const CODICI_DEL_RAMO_TICKET = [...new Set(codiciEmessi(RAMO_TICKET))]
/** I codici emessi ANCHE fuori dal ramo ticket: il loro testo vale in due contesti. */
const CODICI_IN_DUE_CONTESTI = CODICI_DEL_RAMO_TICKET.filter(
    (c) => codiciEmessi(MOTORE_SENZA_COMMENTI).filter((x) => x === c).length >
        codiciEmessi(RAMO_TICKET).filter((x) => x === c).length,
)

/** `oltre_residuo_aggregato` → `reconComponiErrOltreResiduoAggregato`. */
const chiaveDelCodice = (codice: string): string =>
    `reconComponiErr${codice.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}`

// ── 9 · Un «campo mancante» non ordina di compilare un campo che non c'è ─────

/**
 * IL DIFETTO CHE HA FATTO NASCERE QUESTA REGOLA, misurato il 2026-09-13 eseguendo
 * il motore: una riga nuova senza bambino produce DUE violazioni, e i due messaggi
 * arrivavano a schermo in fila —
 *   → «Scegli il bambino di questa riga.»
 *   → «Indica la sede di questa riga: da lì si propone la sede del documento.»
 * Ma la sede di riga NON SI INDICA: il motore — fetta approvata — dichiara, nel
 * commento sopra `aggiungi('sede_mancante')`, che «le righe esistenti la portano dal
 * DB, le nuove dal contesto che conosce già il plesso del bambino».
 *
 * ⚠️ IL RIFERIMENTO È ALLA FRASE, NON AL NUMERO DI RIGA, e non è pedanteria: questa
 * stesura era nata citando `conciliazione-composita.ts:453-454`, e nelle due ore in
 * cui è stata scritta quel punto è diventato `:457-459` — un'altra fetta ha
 * aggiunto quattro righe più in su, sullo stesso albero di lavoro. Un numero di riga
 * dentro un file di un'altra fetta invecchia da solo, e in silenzio.
 *
 * L'operatrice leggeva un ordine e non aveva niente da eseguire, perché **un campo
 * «sede della riga» non esiste**:
 * dei quattro codici «campo mancante» tre avevano l'etichetta del proprio campo
 * (`reconComponiCampoBambino`, `…Categoria`, `…Descrizione`) e la sede di riga
 * nessuna — c'è solo `reconComponiSedeDocumento`, che è l'ALTRO campo, quello che il
 * messaggio stesso distingueva.
 *
 * La regola: se un messaggio di «campo mancante» ORDINA di compilare qualcosa, deve
 * nominare almeno un campo che il pannello ha davvero. I nomi dei campi si LEGGONO
 * dal catalogo (`reconComponiCampo*`), non si ricopiano qui: il giorno in cui un
 * campo «sede della riga» esistesse per davvero, l'imperativo tornerebbe legittimo
 * da solo — ed è il comportamento voluto, non una scappatoia.
 *
 * ⚠️ IL PERIMETRO SI DERIVA DAL MOTORE, ed è `CodiceViolazione` (le violazioni DI
 * RIGA), non l'unione dei due enumerati. Misurato prima di scriverlo:
 * `composizione_vuota` finisce in `_vuota` e sarebbe entrato nel perimetro, ma il
 * suo testo — «**Aggiungi** almeno una voce: un pagamento senza voci non assegna un
 * centesimo a nessuno» — è un ordine legittimo che non parla di nessun campo di
 * riga, e la regola lo avrebbe dichiarato fantasma. Non è un campo: è la
 * composizione intera.
 *
 * ⚠️ SI GUARDA CHE COSA REGGE L'IMPERATIVO, NON SE IL TESTO NOMINA UN CAMPO DA
 * QUALCHE PARTE. La prima stesura di questa regola faceva la seconda cosa ed è nata
 * VERDE sul difetto che doveva prendere: il messaggio rotto diceva «**Indica la
 * sede** di questa riga: … lo decide **il bambino**, non questo campo», e quel
 * «bambino» della seconda frase — che è l'etichetta di un campo vero — bastava a
 * soddisfarla. Un falso verde su un catalogo che il rilievo dichiarava rotto: se
 * fosse rimasto così, questo file avrebbe certificato il difetto invece di vederlo.
 * Ora l'ordine si legge col suo complemento (fino alla punteggiatura forte, al più
 * 60 caratteri), e il campo va cercato LÌ DENTRO.
 *
 * ⚠️ SI ESCLUDE LA FORMA NON IMPERATIVA, NON LA POSIZIONE. La via d'uscita da
 * questo difetto è proprio un testo che SPIEGA invece di comandare — «la sede **non
 * si indica** qui» contiene la parola «indica» e non ordina niente — ma la prima
 * stesura la otteneva pretendendo che l'imperativo stesse a inizio frase o dopo
 * punteggiatura, e quella regola l'ho battuta io stesso in due mosse, misurate:
 * «Per poter confermare **indica** la sede di questa riga» e «Scegli il bambino **e
 * indica** la sede di questa riga» passavano VERDI, e sono due modi perfettamente
 * naturali di riscrivere lo stesso ordine impossibile. A escludere ora è la forma
 * verbale — il «si» impersonale in italiano, l'ausiliare di `be` in inglese («isn't
 * **set** here») — che è ciò che distingue davvero una spiegazione da un comando.
 * Il participio non ha bisogno di guardie: «indicata», «chosen» non hanno il
 * confine di parola che l'elenco pretende.
 *
 * ⚠️ RESTA UN'EURISTICA SU PAROLE, come le altre di questo file, e questi sono i
 * limiti misurati provando a batterla:
 *  · un SINONIMO fuori elenco sfugge. «**Assegna** la sede di questa riga» passava
 *    verde: chiuso allungando l'elenco, che è l'unica risposta giusta a una forma
 *    nuova. Chi ne trova un'altra faccia lo stesso invece di allentare la regola;
 *  · l'etichetta si cerca nel complemento, quindi un ordine che nomina un campo
 *    VERO per reclamarne un altro nella stessa frase senza congiunzioni («Scegli il
 *    bambino della sede giusta») non si distingue. Prende chi ordina un campo
 *    inesistente, non chi descrive male un campo esistente;
 *  · e `imposta` è anche un sostantivo italiano: dentro questo perimetro — quattro
 *    messaggi d'errore di riga — non capita, ma è il genere di parola che in un
 *    catalogo contabile va tenuta d'occhio;
 *  · ⚠️ UN COMPLEMENTO OLTRE I 60 CARATTERI PORTA L'ETICHETTA FUORI DALLA FINESTRA, e
 *    il lock diventa rosso su un messaggio corretto. Misurato: «Scegli, nella colonna
 *    che trovi in fondo a destra della tabella, il bambino di questa riga.» viene
 *    troncato a «Scegli, nella colonna che trovi in fondo a destra della tabella, i» e
 *    il «bambino» resta fuori. È un FALSO POSITIVO dichiarato, non un buco, e la
 *    finestra NON è stata allargata apposta: il limite semantico vero è la
 *    punteggiatura forte (`[^.:;]`), che regge da sola; i 60 caratteri sono il tetto
 *    che impedisce a un ordine di andarsi a pescare un'etichetta in fondo al periodo,
 *    e spostarli a 80 o a 120 sposta soltanto il punto in cui il prossimo inciso sarà
 *    più lungo, senza un criterio che dica dove fermarsi. In un messaggio d'errore un
 *    complemento più lungo di 60 caratteri è un messaggio da riscrivere prima che da
 *    far passare: i quattro di questo perimetro stanno tutti sotto la metà. La prova
 *    qui sotto RENDE VISIBILE il taglio, così nessuno lo scopre credendo di aver
 *    trovato una falla nuova;
 *  · e il confronto per RADICE, che chiude il plurale, allarga per definizione: una
 *    parola diversa con la stessa radice del campo vale come il campo. Misurato:
 *    «Indica l'importanza di questa riga» nomina `Importo` e passa. È lo scambio
 *    scelto — un falso positivo che urla su un catalogo corretto costa più di un
 *    falso negativo su una frase che nessuno scriverebbe in un errore di campo.
 * Il pavimento qui sotto conta quanti ordini la regola sorveglia davvero: se
 * l'elenco degli imperativi smettesse di riconoscerne uno, la prova sarebbe verde
 * per non aver guardato niente.
 */
const IMPERATIVO_DI_COMPILAZIONE: Record<Lingua, RegExp> = {
    // ⚠️ L'ENCLITICO È NELLA REGOLA, e ci è entrato perché lo ha battuto: «La sede di
    // questa riga manca. **Indicala** prima di confermare» passava VERDE, perché
    // `indica\b` non vede «indicala». `digita` sta fuori dal gruppo dell'enclitico e
    // non è pigrizia: con `(?:la|lo|le|li|ne)?` dentro, la parola «digitale» sarebbe
    // diventata un ordine. Il participio non chiede guardie: «indicata» rompe il
    // confine di parola in tutt'e due i rami.
    //
    // ⚠️ `assegna` È L'ELEMENTO DA SORVEGLIARE SE QUALCUNO ALLARGA IL PERIMETRO.
    // Misurato passando l'elenco su tutte le chiavi `reconComponiErr*`:
    // `reconComponiErrComposizioneVuota` — «…un pagamento senza voci non **assegna** un
    // centesimo a nessuno» — produce un ordine spurio, e lo produce in italiano (in
    // inglese il testo non ha il verbo). Oggi è innocuo perché quel codice sta FUORI
    // dal perimetro, che è `CodiceViolazione` e non l'unione dei due enumerati; il
    // giorno in cui qualcuno allargasse il perimetro all'unione, questo lock
    // diventerebbe rosso su un messaggio corretto. Prima di allargare, si tolga
    // `assegna` o si chieda al verbo di reggere un campo.
    it: /(?<!\bsi\s)(?<!\bci\s)\b(?:(?:scegli|seleziona|indica|inserisci|scrivi|compila|imposta|metti|specifica|immetti|completa|riempi|assegna|associa|collega|abbina|valorizza|aggiungi)(?:la|lo|le|li|ne)?|digita)\b/gi,
    en: /(?<!\b(?:is|are|was|were|be|been|being|isn’t|aren’t|wasn’t|weren’t|not|already|auto)\s)\b(?:choose|select|set|enter|write|fill|type|specify|pick|provide|input|complete|assign|link|attach|add)\b/gi,
}

/** I nomi dei campi DI RIGA che il pannello ha davvero, letti dal catalogo. */
const etichetteDiCampo = (lingua: Lingua): string[] =>
    Object.entries(CONTABILITA[lingua])
        .filter(([k, v]) => k.startsWith('reconComponiCampo') && typeof v === 'string' && v.trim() !== '')
        .map(([, v]) => v)

/**
 * Gli ordini di compilare qualcosa, ciascuno col proprio complemento.
 *
 * ⚠️ IL COMPLEMENTO SI FERMA AL PROSSIMO ORDINE, e non è un dettaglio: con una
 * regex sola che consumava verbo E complemento, «**Scegli** il bambino **e indica**
 * la sede di questa riga» passava VERDE — misurato provando a battere questa
 * regola. Il primo ordine si mangiava il secondo (`matchAll` non torna indietro), e
 * il «bambino» del primo bastava per tutt'e due. Ogni ordine risponde del proprio
 * complemento, e di nessun altro.
 */
function ordiniDiCompilazione(testo: string, lingua: Lingua): string[] {
    const verbi = [...testo.matchAll(IMPERATIVO_DI_COMPILAZIONE[lingua])].map((m) => ({
        verbo: m[0],
        da: m.index ?? 0,
    }))
    return verbi.map(({ verbo, da }, i) => {
        const fino = verbi[i + 1]?.da ?? testo.length
        const dopo = testo.slice(da + verbo.length, fino)
        return `${verbo}${/^[^.:;]{0,60}/.exec(dopo)?.[0] ?? ''}`
    })
}

/**
 * L'etichetta di un campo, ridotta alla RADICE di ogni sua parola.
 *
 * ⚠️ IL CONFRONTO ERA PER INCLUSIONE, E URLAVA SUL PLURALE. Misurato: il pannello
 * compone PIÙ righe, e `reconComponiErrAlunnoMancante` scritta «Scegli **i bambini**
 * di queste righe» faceva rosso il lock, perché `«bambini».includes(«bambino»)` è
 * falso. In inglese cadevano i plurali in `-y` → `-ies` (`Category`→`Categories`,
 * `Quantity`→`Quantities`) mentre `Child`→`Children` passava per inclusione: un falso
 * positivo che cambiava pure lingua per lingua. È la stessa specie di difetto della
 * guardia sulla negazione — il lock che urla su un catalogo corretto — e si chiude
 * allo stesso modo: guardando la radice invece della parola intera.
 *
 * La vocale finale si toglie solo alle parole da 5 lettere in su: in italiano il
 * plurale la CAMBIA («bambino» → «bambini», «costi unitari»), in inglese si aggiunge
 * («costs») o si passa da `-y` a `-ies`. Sotto le 5 lettere non si taglia niente,
 * perché una radice di due o tre lettere si troverebbe dentro mezzo vocabolario:
 * «Ore» → «Or» finirebbe dentro «ordine». Le vocali accentate non si toccano —
 * «Quantità» è invariabile, e la coda `[a-zà-ÿ]*` basta da sola.
 *
 * ⚠️ È UNA SECONDA FUNZIONE E NON `radice`, che sta dieci sezioni più su: quella
 * serve ai sinonimi della riga bancaria, non conosce la `y` inglese, ed è verificata
 * con le proprie prove. Cambiarla per un'altra regola vorrebbe dire far dipendere due
 * invarianti dallo stesso punto.
 */
const radiceDiEtichetta = (parola: string): string =>
    `${parola.length >= 5 ? parola.replace(/[aeiouy]$/i, '') : parola}[a-zà-ÿ]*`

/** L'ordine nomina il campo se ne dice le parole, in fila, ciascuna dalla sua radice. */
const nominaIlCampo = (ordine: string, etichetta: string): boolean => {
    const pezzi = etichetta.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (pezzi.length === 0) return false
    return new RegExp(`\\b${pezzi.map(radiceDiEtichetta).join('\\s+')}`, 'i').test(ordine)
}

/** Gli ordini che reclamano qualcosa che fra i campi del pannello non c'è. */
const ordiniSenzaCampo = (testo: string, etichette: string[], lingua: Lingua): string[] =>
    ordiniDiCompilazione(testo, lingua).filter(
        (ordine) => !etichette.some((nome) => nominaIlCampo(ordine, nome)),
    )

/** I codici di RIGA che dicono «questo campo manca»: il perimetro della regola. */
const CODICI_DI_CAMPO_MANCANTE = codiciDelTipo(MOTORE, 'CodiceViolazione').filter((c) =>
    /_(mancante|vuota)$/.test(c),
)

describe('lock architettura · i testi del pannello «Componi il pagamento»', () => {
    it('ogni pannello della riconciliazione ha la PROPRIA via d’uscita, in tutt’e due le lingue', () => {
        const senzaUscita: string[] = []
        for (const pannello of PANNELLI) {
            for (const lingua of LINGUE) {
                const uscite = vieDUscita(CONTABILITA[lingua], pannello.prefisso, lingua)
                if (uscite.length === 0) {
                    senzaUscita.push(
                        `messages/${lingua}/adminContabilita.json → famiglia \`${pannello.prefisso}*\` ` +
                        `(«${pannello.nome}»): nessuna chiave con un testo d’uscita.`,
                    )
                }
            }
        }
        expect(
            senzaUscita,
            `Da questi pannelli si entra e non si esce:\n  ${senzaUscita.join('\n  ')}\n` +
            `La convenzione del namespace è che ogni pannello porti la sua chiave d’uscita anche ` +
            `quando `+ '`shared.chiudi`' + ` esiste: 11 chiavi di adminContabilita lo ripetono ` +
            `parola per parola, e `+ '`reconLottoChiudi`' + ` è quella del pannello gemello ` +
            `(LottoFatturePanel.tsx:779). Aggiungi \`<prefisso>Chiudi\` in coda ai due cataloghi.`,
        ).toEqual([])
    })

    it('il controllo dell’uscita vede davvero un pannello che non ne ha (e non urla su uno che ce l’ha)', () => {
        // Senza questa prova, un `vieDUscita` che ritornasse sempre qualcosa lascerebbe
        // il divieto qui sopra verde per sempre.
        const senza: Catalogo = { pincoTitolo: 'Fai una cosa', pincoConferma: 'Conferma' }
        const con: Catalogo = { ...senza, pincoChiudi: 'Chiudi' }
        expect(vieDUscita(senza, 'pinco', 'it')).toEqual([])
        expect(vieDUscita(con, 'pinco', 'it')).toEqual(['pincoChiudi'])
        // e non si fa ingannare da una famiglia vicina col nome che comincia uguale
        expect(vieDUscita({ pincoPallinoChiudi: 'Chiudi' }, 'pincoPallino', 'it')).toEqual(['pincoPallinoChiudi'])
    })

    it('ogni elenco della riconciliazione ha il suo stato vuoto, in tutt’e due le lingue', () => {
        const muti: string[] = []
        for (const elenco of ELENCHI) {
            for (const lingua of LINGUE) {
                if (elenco.intestazione && !(elenco.intestazione in CONTABILITA[lingua])) {
                    muti.push(`messages/${lingua}/adminContabilita.json → manca \`${elenco.intestazione}\` (${elenco.dove})`)
                }
                const testo = CONTABILITA[lingua][elenco.vuoto]
                if (typeof testo !== 'string' || testo.trim() === '') {
                    muti.push(`messages/${lingua}/adminContabilita.json → manca \`${elenco.vuoto}\`: ${elenco.dove}`)
                }
            }
        }
        expect(
            muti,
            `Questi elenchi si renderebbero vuoti e muti:\n  ${muti.join('\n  ')}\n` +
            `Un elenco senza stato vuoto non è mezza schermata: è la schermata che tace nel ` +
            `momento in cui l’operatrice ha più bisogno di sapere che cosa fare.`,
        ).toEqual([])
    })

    it('lo stato vuoto delle voci aperte nomina l’azione che lo risolve', () => {
        // Quel vuoto non è un vicolo cieco — è il caso NORMALE di una famiglia senza
        // pendenze, e l'unica via d'uscita è aggiungere le voci a mano. Se il testo non
        // nomina l'azione del pulsante che sta lì accanto, l'operatrice resta ferma.
        const elenco = ELENCHI.find((e) => e.nominaLAzioneDi)!
        const scollegati: string[] = []
        for (const lingua of LINGUE) {
            const vuoto = CONTABILITA[lingua][elenco.vuoto] ?? ''
            const azione = CONTABILITA[lingua][elenco.nominaLAzioneDi!] ?? ''
            const verbo = parole(azione)[0] ?? ''
            // la radice del verbo: «Aggiungi» → «aggiung», «Add» → «add»
            const radice = verbo.slice(0, Math.max(3, verbo.length - 1))
            if (!radice || !new RegExp(radice, 'i').test(vuoto)) {
                scollegati.push(
                    `messages/${lingua}/adminContabilita.json → \`${elenco.vuoto}\` = «${vuoto}» ` +
                    `non nomina l’azione di \`${elenco.nominaLAzioneDi}\` («${azione}»)`,
                )
            }
        }
        expect(scollegati, `Stato vuoto che non dice come uscirne:\n  ${scollegati.join('\n  ')}`).toEqual([])
    })

    it('l’etichetta dell’àncora usa le stesse parole del messaggio d’errore che la reclama', () => {
        // L'etichetta è `reconComponiAncora`; l'errore che la reclama è
        // `shared.erroreConciliazioneAncoraMancante`. Se parlano due lingue diverse
        // DENTRO la stessa lingua, l'operatrice legge un errore che non sa a quale
        // campo si riferisca.
        const divergenti: string[] = []
        for (const lingua of LINGUE) {
            const etichetta = CONTABILITA[lingua].reconComponiAncora ?? ''
            const errore = SHARED[lingua].erroreConciliazioneAncoraMancante ?? ''
            const fuori = paroleNonRiprese(etichetta, errore, lingua)
            if (fuori.length > 0) {
                divergenti.push(
                    `${lingua}: etichetta «${etichetta}» ⟶ errore «${errore}»; ` +
                    `parole dell’etichetta che l’errore non dice: ${fuori.join(', ')}`,
                )
            }
        }
        expect(
            divergenti,
            `L’etichetta del campo e l’errore che lo reclama non usano la stessa formula:\n  ` +
            `${divergenti.join('\n  ')}\n` +
            `La formula decisa è quella del messaggio d’errore, che è anche la più esplicita: ` +
            `«la voce da cui intestare la fattura».`,
        ).toEqual([])
    })

    it('il confronto fra etichetta ed errore vede davvero due formule diverse', () => {
        // Il controllo positivo: senza, `paroleNonRiprese` potrebbe ritornare sempre []
        // e la prova qui sopra sarebbe verde su qualunque testo.
        expect(paroleNonRiprese('Fattura intestata dalla voce', 'Scegli la voce da cui intestare la fattura', 'it'))
            .toEqual(['intestata'])
        expect(paroleNonRiprese('Voce da cui intestare la fattura', 'Scegli la voce da cui intestare la fattura', 'it'))
            .toEqual([])
    })

    it('in un contesto misto il ticket si qualifica, in OGNI chiave della famiglia e in tutt’e due le lingue', () => {
        // ⚠️ La prima stesura guardava `reconComponiAggiungiTicket` E BASTA, e lo
        // dichiarava: «anche `reconComponiErrQuantitaNonValida` dice "ticket mensa",
        // ma a mano». Una regola che sorveglia UNA chiave è cieca a quella scritta il
        // giorno dopo. Qui il perimetro è la famiglia: ogni `reconComponi*` che nomina
        // il ticket lo qualifica. Misurato prima di generalizzare: 2 chiavi per lingua,
        // entrambe già qualificate — cioè un rafforzamento che non chiedeva nessuna
        // riscrittura, solo di smettere di guardare da un buco della serratura.
        const nudi: string[] = []
        for (const lingua of LINGUE) {
            for (const [chiave, testo] of Object.entries(CONTABILITA[lingua])) {
                if (!chiave.startsWith('reconComponi') || typeof testo !== 'string') continue
                if (!/ticket/i.test(testo)) continue
                if (!QUALIFICA_TICKET[lingua].test(testo)) {
                    nudi.push(`messages/${lingua}/adminContabilita.json → ${chiave} = «${testo}»`)
                }
            }
        }
        expect(
            nudi,
            `Qui «ticket» sta accanto ad «Aggiungi voce», fra rette, pomeridiano e gite: senza la ` +
            `qualifica si legge come un’altra categoria di voce.\n  ${nudi.join('\n  ')}\n` +
            `Il precedente è \`cnav_ticket\`, che qualifica in entrambe le lingue.`,
        ).toEqual([])
    })

    it('e il precedente che giustifica la qualifica esiste davvero', () => {
        // Se un giorno `cnav_ticket` smettesse di qualificare, la regola qui sopra
        // resterebbe appesa a un precedente che non c'è più: meglio saperlo.
        expect(CONTABILITA.it.cnav_ticket).toMatch(QUALIFICA_TICKET.it)
        expect(CONTABILITA.en.cnav_ticket).toMatch(QUALIFICA_TICKET.en)
    })

    it('la riga bancaria ha UN SOLO nome per lingua, in tutta la schermata e nei suoi errori', () => {
        // ⚠️ Si guarda il TESTO, mai il nome della chiave. `erroreConciliazioneMovimentoCambiato`
        // e `reconComponiErrMovimentoNonPositivo` si chiamano «…Movimento…» e dicono
        // «bonifico»: i nomi seguono `CODICI_ERRORE` e l'enumerato del motore, che non si
        // toccano; le parole seguono il glossario, che è ciò che l'operatrice legge.
        const guasti: string[] = []
        for (const lingua of LINGUE) {
            const trovati = nomiDellaRigaBancaria(vociDelPerimetro(lingua), lingua)
            // `=== 1` e non `<= 1`: a zero il pannello avrebbe smesso di dire CHE COSA
            // sta conciliando, e questa prova sarebbe verde per non aver guardato niente.
            if (trovati.size !== 1) {
                guasti.push(
                    `${lingua}: ${trovati.size} termini invece di uno — ` +
                    [...trovati].map(([t, dove]) => `«${t}» (${dove.join(', ')})`).join(' · '),
                )
            }
            // E il termine dev'essere QUELLO, non uno qualunque purché unico: la
            // coerenza da sola lascia passare l'intera famiglia riscritta con la parola
            // di un'altra entità — misurato verde prima di questa riga.
            if (!trovati.has(TERMINE_SCELTO[lingua])) {
                guasti.push(
                    `${lingua}: la riga bancaria non si chiama «${TERMINE_SCELTO[lingua]}» ma ` +
                    `${[...trovati.keys()].map((t) => `«${t}»`).join(', ') || '«—»'}`,
                )
            }
        }
        expect(
            guasti,
            `La stessa riga di estratto conto ha due nomi nella stessa schermata:\n  ${guasti.join('\n  ')}\n` +
            `È il difetto n. 2 di \`messaggi-plurali-e-glossario\` dentro una famiglia sola. Il termine ` +
            `scelto è «bonifico» / «bank transfer»: «transazione»/«transaction» è già occupato dalla ` +
            `TRANSAZIONE CONTABILE (le 6 chiavi \`trans*\` del namespace), e riusarlo qui vorrebbe dire ` +
            `chiamare con lo stesso nome la riga della banca e la scrittura che ne nasce.`,
        ).toEqual([])
    })

    it('la deroga apre alla frase che nomina DAVVERO due entità, e non a chi rinomina la riga', () => {
        // Il limite (b), misurato: «Questo bonifico ha già generato una transazione
        // contabile» è una frase legittima, e senza la porta è ROSSA — due termini.
        const dueEntita = [{ dove: 'adminContabilita.reconComponiX', testo: 'Questo bonifico ha già generato una transazione contabile.' }]
        expect([...nomiDellaRigaBancaria(dueEntita, 'it').keys()].sort()).toEqual(['bonifico', 'transazione'])
        // Con la chiave nella lista, la transazione contabile smette di contare.
        const ammesse = new Set(['adminContabilita.reconComponiX'])
        expect([...nomiDellaRigaBancaria(dueEntita, 'it', ammesse).keys()]).toEqual(['bonifico'])
        // Ma la deroga NON copre chi RINOMINA la riga bancaria: la stessa chiave
        // ammessa, se dice soltanto «transazione», continua a portare il secondo nome.
        const soloAltra = [{ dove: 'adminContabilita.reconComponiX', testo: 'Riapri la transazione' }]
        expect([...nomiDellaRigaBancaria(soloAltra, 'it', ammesse).keys()]).toEqual(['transazione'])
        // e in inglese, dove «bank transfer» contiene «transfer»
        const dueEn = [{ dove: 'shared.erroreConciliazioneX', testo: 'This bank transfer already produced an accounting transaction.' }]
        expect([...nomiDellaRigaBancaria(dueEn, 'en').keys()].sort()).toEqual(['bank transfer', 'transaction'])
        expect([...nomiDellaRigaBancaria(dueEn, 'en', new Set(['shared.erroreConciliazioneX'])).keys()]).toEqual(['bank transfer'])
        // Il limite (a), misurato e dichiarato: un sinonimo fuori elenco non si vede.
        // Questa riga è qui per NON far credere a nessuno che il lock lo prenda.
        expect([...nomiDellaRigaBancaria([{ dove: 'x', testo: 'Riapri il versamento' }], 'it').keys()]).toEqual([])
    })

    it('il riconoscitore dei sinonimi ne vede due dove ci sono, e uno dove ce n’è uno', () => {
        // Senza questo, `terminiUsati` potrebbe ritornare sempre un insieme da un
        // elemento e il divieto qui sopra sarebbe verde su qualunque catalogo.
        expect([...terminiUsati('Riapri il movimento e il bonifico', 'it')].sort()).toEqual(['bonifico', 'movimento'])
        expect([...terminiUsati('Riapri il bonifico', 'it')]).toEqual(['bonifico'])
        // Il plurale italiano CAMBIA la vocale finale: «bonifici», non «bonificoi».
        expect([...terminiUsati('Questi bonifici sono due', 'it')]).toEqual(['bonifico'])
        expect([...terminiUsati('Due movimenti e una transazione', 'it')].sort()).toEqual(['movimento', 'transazione'])
        expect([...terminiUsati('Two bank transfers', 'en')]).toEqual(['bank transfer'])
        // «bank transfer» contiene «transfer»: senza l'ordine dal più lungo al più
        // corto, una frase che usa un termine solo ne conterebbe due e il lock
        // sarebbe rosso per sempre su un catalogo corretto.
        expect([...terminiUsati('Reopen the bank transfer', 'en')]).toEqual(['bank transfer'])
        expect([...terminiUsati('Reopen the transaction', 'en')]).toEqual(['transaction'])
        expect([...terminiUsati('Le voci quadrano', 'it')]).toEqual([])
    })

    it('ogni codice di violazione del motore ha il suo messaggio, in tutt’e due le lingue', () => {
        // I codici sono un ENUMERATO e il modulo lo dichiara per iscritto: «il messaggio
        // lo sceglie la UI». Finché la UI non c'è, «lo sceglie la UI» vuol dire «non
        // esiste», e chi scriverà il componente inventerà un testo al volo per ognuno,
        // fuori da ogni lock — la stessa finestra in cui sono passate le due assenze
        // corrette qui sopra.
        const senzaTesto: string[] = []
        for (const codice of CODICI) {
            const chiave = chiaveDelCodice(codice)
            for (const lingua of LINGUE) {
                const testo = CONTABILITA[lingua][chiave]
                if (typeof testo !== 'string' || testo.trim() === '') {
                    senzaTesto.push(`messages/${lingua}/adminContabilita.json → manca \`${chiave}\` (codice \`${codice}\`)`)
                }
            }
        }
        expect(
            senzaTesto,
            `Questi codici di violazione arriverebbero a schermo senza niente da mostrare:\n  ` +
            `${senzaTesto.join('\n  ')}\n` +
            `I codici NON sono scritti qui: si leggono da ${SORGENTE_MOTORE}, così un codice ` +
            `aggiunto da un'altra fetta rende rosso questo lock finché non ha il suo testo.`,
        ).toEqual([])
    })

    it('nessun testo della famiglia dichiara ammissibile uno ZERO che il motore vieta', () => {
        // La prova che mancava, e che il difetto ha dimostrato servire: il catalogo
        // aveva `reconComponiErrCostoUnitarioNegativo` = «Il costo unitario non può
        // essere negativo. Zero sì: è una ricarica in omaggio.» mentre il motore, dalla
        // riga accanto, emetteva `costo_unitario_non_positivo` **proprio sullo zero**.
        // Chi digitava -1 leggeva «Zero sì», correggeva a 0 e prendeva il secondo
        // errore. Il lock dei codici non poteva vederlo: c'era il testo, ed era falso.
        //
        // La famiglia si deriva dal CODICE, non da un elenco: `costo_unitario_non_positivo`
        // → `costo_unitario` → tutte le chiavi che cominciano per
        // `reconComponiErrCostoUnitario`, cioè anche quelle di un codice fratello.
        const contraddizioni: string[] = []
        for (const codice of CODICI) {
            const famiglia = famigliaCheVietaLoZero(codice)
            if (!famiglia) continue
            const prefisso = chiaveDelCodice(famiglia)
            for (const lingua of LINGUE) {
                for (const [chiave, testo] of Object.entries(CONTABILITA[lingua])) {
                    if (!chiave.startsWith(prefisso) || typeof testo !== 'string') continue
                    if (ZERO_CONCESSO[lingua].test(testo)) {
                        contraddizioni.push(
                            `messages/${lingua}/adminContabilita.json → \`${chiave}\` = «${testo}» ` +
                            `dichiara ammissibile lo zero, ma il motore emette \`${codice}\``,
                        )
                    }
                }
            }
        }
        expect(
            contraddizioni,
            `Questi testi mandano l’operatrice dentro il difetto successivo:\n  ` +
            `${contraddizioni.join('\n  ')}\n` +
            `Un codice \`*${SUFFISSO_NON_POSITIVO}\` dice che lo zero È VIETATO: nessuna chiave della ` +
            `stessa famiglia può concederlo. Dove lo zero ha un rimedio, il rimedio si scrive nel ` +
            `testo del codice che lo vieta — non in quello del codice accanto.`,
        ).toEqual([])
    })

    it('il riconoscitore della concessione vede le due direzioni, e non scambia il divieto per una concessione', () => {
        // Il controllo positivo, e il verbale delle forme che le prime stesure NON
        // vedevano: senza questo, `ZERO_CONCESSO` potrebbe non riconoscere più niente e
        // il divieto qui sopra sarebbe verde su qualunque catalogo.
        const concedono: Array<[Lingua, string]> = [
            ['it', 'Zero sì: è una ricarica in omaggio.'],
            ['it', 'Il costo può essere zero: è una ricarica in omaggio.'],
            // LA CIFRA, che è come questo catalogo scrive già lo zero in 10 chiavi.
            ['it', 'Il costo unitario dei ticket mensa può essere 0: è una ricarica in omaggio.'],
            ['it', '0 sì: è una ricarica in omaggio.'],
            // …e la cifra COL PUNTO FERMO ATTACCATO, che è come finisce ogni messaggio
            // di questo catalogo. La forma ovvia del lookahead — `(?![\d,.])` — è cieca
            // proprio qui, ed è il rosso da cui `ZERO` è nato nella forma che ha.
            ['it', 'Il costo unitario può essere 0.'],
            ['it', 'Lo zero va benissimo.'],
            ['it', 'Lo zero è accettato.'],
            ['it', 'Si ammette anche lo zero.'],
            ['en', 'Zero is fine: it’s a free top-up.'],
            ['en', 'The cost can be zero.'],
            ['en', 'Zero is tolerated.'],
            ['en', 'The unit cost of meal tickets can be 0: it’s a free top-up.'],
            ['en', '0 is fine: it’s a free top-up.'],
            ['en', 'The unit cost can be 0.'],
        ]
        const vietano: Array<[Lingua, string]> = [
            ['it', 'Il costo unitario dev’essere maggiore di zero.'],
            ['it', 'Il costo unitario dei ticket mensa non può essere negativo.'],
            ['it', 'Questo bonifico non ha un importo positivo: non c’è niente da comporre.'],
            ['en', 'The unit cost must be greater than zero.'],
            ['en', 'The unit cost of meal tickets can’t be negative.'],
            // LA CIFRA DAL LATO DEL DIVIETO, che è il modo in cui questo catalogo scrive
            // già lo zero in `gencErrImporto`, `quickErrImporto`, `rateErrImporto`.
            ['it', 'Inserisci un importo maggiore di 0.'],
            ['it', 'La quantità dev’essere un numero intero maggiore di 0.'],
            ['en', 'Enter an amount greater than 0.'],
            // LA NEGAZIONE. Tre di queste erano ROSSE prima di questa stesura — cioè il
            // lock urlava su un divieto scritto benissimo — e con la sola aggiunta della
            // cifra sarebbero diventate cinque: «non può essere 0» e «lo 0 non è ammesso»
            // sono la stessa frase in cifra. Misurato, e chiuso insieme alla cifra.
            ['it', 'Il costo unitario non può essere zero.'],
            ['it', 'Il costo unitario non può essere 0.'],
            ['it', 'Lo zero non è ammesso.'],
            ['it', 'Lo 0 non è ammesso.'],
            ['it', 'Lo zero non va bene.'],
            ['en', 'The unit cost cannot be zero.'],
            ['en', 'Zero is not allowed.'],
            // LA NEGAZIONE A DISTANZA, e sono i tre falsi positivi che hanno fatto
            // riscrivere la guardia: «non **è** ammesso», «non **si** può» e «**never**
            // accepts» portano la negazione due parole più su del verbo, e un lookbehind
            // di sola adiacenza (`(?<!\bnon\s)`) non la vede. Misurati tutt'e tre ROSSI
            // sulla stesura precedente — cioè il lock urlava su tre divieti scritti bene,
            // ed è la classe stessa per cui la guardia era nata.
            ['it', 'Non è ammesso lo zero: il costo unitario dev’essere positivo.'],
            ['it', 'Non si può indicare zero.'],
            ['en', 'The field never accepts 0.'],
            // ⚠️ E QUESTA È L’UNICA RIGA CHE ESERCITA `NEGAZIONE.en`, cioè la guardia
            // del PRIMO ramo inglese. Il riquadro in testa dichiarava quella guardia
            // «lì per simmetria», e aveva ragione per le forme che elencava — ma
            // «lì per simmetria» e «mai messa alla prova» sono la stessa cosa:
            // cancellandola, tutti i test restavano VERDI (misurato). `works` è
            // un'alternativa del ramo 1, e «never» ci sta comodamente dentro la
            // finestra: senza guardia questa frase è letta come una concessione.
            ['en', 'Zero never works.'],
            // IL DECIMALE, che la cifra non deve trascinarsi dietro. L'ultima è la prova
            // del lookbehind: senza, «1.0» varrebbe uno zero e «is fine» sta a 11
            // caratteri, cioè dentro la finestra — un falso positivo su un prezzo.
            ['it', 'Il costo unitario dev’essere maggiore di 0,50.'],
            ['it', 'Con 10 ticket mensa il totale non torna.'],
            ['en', 'The unit cost must be greater than 0.50.'],
            ['en', 'A 1.0 unit cost is fine.'],
        ]
        expect(
            concedono.filter(([lingua, testo]) => !ZERO_CONCESSO[lingua].test(testo)),
            'concessioni che il riconoscitore non vede',
        ).toEqual([])
        expect(
            vietano.filter(([lingua, testo]) => ZERO_CONCESSO[lingua].test(testo)),
            'divieti scambiati per concessioni',
        ).toEqual([])
        // ⚠️ I DUE DENOMINATORI SONO ASSERZIONI, NON NUMERI IN UN COMMENTO. La stesura
        // precedente si chiudeva dichiarando «0 falsi positivi su 21 divieti»: i divieti
        // erano 19, contati. Un rapporto la cui moneta è il numero misurato non può
        // sbagliare il proprio denominatore, e l'unico modo per non sbagliarlo più è
        // farlo contare al test.
        expect(vietano.length, 'il denominatore dei divieti è cambiato: riscrivilo dove lo dichiari').toBe(23)
        expect(concedono.length, 'il denominatore delle concessioni è cambiato').toBe(14)
    })

    it('e i DUE TASSI dell’euristica sono quelli dichiarati: 56/68 sulle forme costruite ATTORNO alla regola, 2/26 su quelle costruite CONTRO', () => {
        // ⚠️ IL NUMERO DEL RIQUADRO SI MISURA QUI, non in un rapporto che nessuno
        // rilegge. Questo file ha già pagato due misure che non si riproducevano (le
        // «740 etichette, 14 imperativi» e le «152 chiavi, zero imperativi» del punto
        // 3): un tasso scritto in un commento e calcolato altrove è la stessa cosa.
        //
        // ⚠️ E L’82% DELLA STESURA PRECEDENTE ERA TARATO SUL PROPRIO ELENCO. Le 66 forme
        // non erano un campione: erano state scritte guardando la regola, una per ogni
        // alternativa che la regola già prevedeva. Misurato da chi ha riletto: su 24
        // forme scritte CONTRO la regola — nessuna esotica — ne passavano 9. Un tasso
        // alto su un elenco costruito attorno alla propria regola dice quanto l’elenco
        // somiglia alla regola, non quanto la regola copre la lingua: è la stessa cosa
        // che il riquadro dello zero rimprovera a chi dà le forme chiuse senza il tasso,
        // un piano più su.
        //
        // Perciò gli elenchi sono DUE, e dichiarati per quello che sono:
        //  · ATTORNO — le forme costruite guardando la regola. Il loro tasso è alto per
        //    costruzione, e serve solo a impedire che una copertura di oggi si perda;
        //  · CONTRO — le forme scritte apposta per batterla, senza guardarla. Il loro
        //    tasso è la misura onesta di quanto l’euristica copre la lingua vera.
        // Il secondo numero è basso, ed è il punto: una regola su parole prende chi
        // DIMENTICA, non chi scrive in un modo che non le è stato insegnato. Dirlo col
        // numero vero è ciò che la rende un presidio invece che una promessa.

        /**
         * Le forme che sfuggono, per CLASSE. I numeri per classe non sono scritti:
         * sono la lunghezza degli elenchi, così non possono invecchiare da soli.
         */
        const FUORI_PORTATA: Record<string, string[]> = {
            // l'ordine è un imperativo, e il verbo di concessione non c'è proprio
            'l’imperativo senza verbo di concessione': [
                'Metti 0 per una ricarica in omaggio.',
                'Lascia 0 se è in omaggio.',
                'Leave it at 0 for a free top-up.',
                'Set it to zero for a free top-up.',
                'Use 0 for a free top-up.',
            ],
            // la tagliano fuori le stesse guardie che chiudono i falsi positivi della
            // negazione, ed è uno scambio consapevole: un falso positivo urla su un
            // divieto scritto bene e si vede subito, questo buco no.
            'la litote': [
                'Lo zero non è un errore.',
                'Zero is not an error.',
                'Nessun problema se il costo è zero.',
                'Zero is no problem.',
            ],
            // nessuna parola di concessione: solo il senso
            'la perifrasi': [
                'Zero: nessun problema.',
                'Zero è il valore di una ricarica in omaggio.',
                'Con 0 la ricarica è in omaggio.',
                'Il minimo è 0.',
                'Zero means a free top-up.',
                'Lo zero rientra fra i valori possibili.',
                'Zero equivale a una ricarica in omaggio.',
                'È possibile indicare zero.',
            ],
            // la concessione c'è, ma la porta un verbo che l'elenco non conosce
            'il verbo fuori elenco': [
                'Puoi lasciare 0.',
                'Si può lasciare a zero.',
                'Il campo prende anche lo zero.',
                'The field takes 0.',
                'You can leave it at zero.',
                'The cost may equal zero.',
                'Zero remains valid.',
            ],
            'l’aggettivo o il participio fuori elenco': [
                'Zero è accettabile.',
                'Zero is supported.',
            ],
            // fra la copula e l'aggettivo c'è un sostantivo o un avverbio, e la seconda
            // direzione pretende invece l'adiacenza
            'qualcosa fra la copula e l’aggettivo': [
                'Lo zero è un importo valido.',
                'Zero is a valid amount.',
                'Zero is perfectly valid.',
            ],
            // «può ANCHE essere» invece di «può essere ANCHE», «pari a zero» invece di
            // «zero»: l'ordine delle parole è un altro, e la regex ne conosce uno solo
            'l’ordine delle parole': [
                'Il costo unitario può anche essere zero.',
                'Si può anche mettere 0.',
                'Il costo può essere pari a zero.',
            ],
            // la concessione ha un soggetto attivo, o un soggetto al plurale
            'il soggetto attivo o il plurale': [
                'We allow zero.',
                'Zero values are accepted.',
                'You are allowed to enter zero.',
            ],
            // lo zero sta DOPO la concessione, e nessuno dei due rami lo cerca lì
            'lo zero dopo la concessione': [
                'It is fine to use zero.',
            ],
        }
        const NON_PRESE_ATTESE = Object.values(FUORI_PORTATA).flat()

        /** Le forme costruite ATTORNO alla regola: il loro tasso è alto per costruzione. */
        const ATTORNO: Array<[Lingua, string]> = [
            ['it', 'Zero sì: è una ricarica in omaggio.'],
            ['it', '0 sì: è una ricarica in omaggio.'],
            ['it', 'Lo zero è ammesso.'],
            ['it', 'Lo 0 è ammesso.'],
            ['it', 'Lo zero è consentito.'],
            ['it', 'Lo zero è valido.'],
            ['it', 'Lo zero è accettato.'],
            ['it', 'Lo zero è permesso.'],
            ['it', 'Lo zero è tollerato.'],
            ['it', 'Lo zero va bene.'],
            ['it', 'Lo zero va benissimo.'],
            ['it', 'Lo 0 va bene.'],
            ['it', 'Lo zero ci sta.'],
            ['it', 'Zero ok.'],
            ['it', 'Lo zero si può.'],
            ['it', 'Lo zero è ammissibile.'],
            ['it', 'Lo zero è previsto.'],
            ['it', 'Lo zero è legittimo.'],
            ['it', 'Zero: nessun problema.'],
            ['it', 'Lo zero non è un errore.'],
            ['it', 'Il costo unitario può essere zero: è una ricarica in omaggio.'],
            ['it', 'Il costo unitario dei ticket mensa può essere 0: è una ricarica in omaggio.'],
            ['it', 'Il costo può valere zero.'],
            ['it', 'Si può indicare zero.'],
            ['it', 'Puoi mettere zero.'],
            ['it', 'Possono essere zero.'],
            ['it', 'Si accetta anche zero.'],
            ['it', 'Si ammette anche lo zero.'],
            ['it', 'Si consente lo zero.'],
            ['it', 'Va bene anche zero.'],
            ['it', 'Il costo potrà essere zero.'],
            ['it', 'Il costo potrebbe essere zero.'],
            ['it', 'È ammesso anche zero.'],
            ['it', 'È consentito zero.'],
            ['it', 'È accettato 0.'],
            ['it', 'Zero è il valore di una ricarica in omaggio.'],
            ['it', 'Metti 0 per una ricarica in omaggio.'],
            ['it', 'Lascia 0 se è in omaggio.'],
            ['it', 'Con 0 la ricarica è in omaggio.'],
            ['it', 'Il minimo è 0.'],
            // ⚠️ LE DUE FORME COLL’INCISO, ED È IL PRESIDIO DELLA FINESTRA `{0,12}`.
            // Senza di loro nessuna delle 66 forme precedenti la esercitava davvero:
            // misurato stringendo la finestra a `{0,4}` — la prova restava VERDE, cioè
            // il tetto poteva essere stretto fino a quasi zero senza che niente lo
            // dicesse. Con queste due, `{0,4}` le perde e l’uguaglianza qui sotto è
            // rossa: fra lo zero e la concessione ci sono 7 e 6 caratteri.
            ['it', 'Lo zero, qui, è ammesso.'],
            ['en', 'Zero is fine: it’s a free top-up.'],
            ['en', '0 is fine: it’s a free top-up.'],
            ['en', 'Zero is allowed.'],
            ['en', '0 is allowed.'],
            ['en', 'Zero is accepted.'],
            ['en', 'Zero is acceptable.'],
            ['en', 'Zero is valid.'],
            ['en', 'Zero is permitted.'],
            ['en', 'Zero is tolerated.'],
            ['en', 'Zero is ok.'],
            ['en', 'Zero works.'],
            ['en', 'Zero can be used.'],
            ['en', 'Zero is allowed here.'],
            ['en', 'Zero is not an error.'],
            ['en', 'Zero is possible.'],
            ['en', 'Zero means a free top-up.'],
            ['en', 'The unit cost can be zero.'],
            ['en', 'The unit cost can be 0.'],
            ['en', 'It may be zero.'],
            ['en', 'It could be zero.'],
            ['en', 'It might be zero.'],
            ['en', 'The field accepts zero.'],
            ['en', 'The field accepts 0.'],
            ['en', 'Leave it at 0 for a free top-up.'],
            ['en', 'Set it to zero for a free top-up.'],
            ['en', 'Use 0 for a free top-up.'],
            ['en', 'A zero cost is allowed.'],
        ]

        /**
         * Le forme costruite CONTRO la regola: scritte come si scriverebbe il messaggio,
         * non come la regex vorrebbe leggerlo. Due sole passano, e restano qui apposta —
         * un elenco da cui si tolgono le forme che passano non misura più niente.
         */
        const CONTRO: Array<[Lingua, string]> = [
            ['it', 'Il costo unitario può anche essere zero.'],
            ['it', 'Si può anche mettere 0.'],
            ['it', 'Il costo può essere pari a zero.'],
            ['it', 'È possibile indicare zero.'],
            ['it', 'Lo zero è un importo valido.'],
            ['it', 'Puoi lasciare 0.'],
            ['it', 'Zero è accettabile.'],
            ['it', 'Il campo prende anche lo zero.'],
            ['it', 'Si può lasciare a zero.'],
            ['it', 'Lo zero rientra fra i valori possibili.'],
            ['it', 'Nessun problema se il costo è zero.'],
            ['it', 'Zero equivale a una ricarica in omaggio.'],
            ['it', 'Il costo unitario ammette lo zero.'],
            ['en', 'Zero is a valid amount.'],
            ['en', 'Zero values are accepted.'],
            ['en', 'It is fine to use zero.'],
            ['en', 'Zero is supported.'],
            ['en', 'We allow zero.'],
            ['en', 'Zero is perfectly valid.'],
            ['en', 'The field takes 0.'],
            ['en', 'You can leave it at zero.'],
            ['en', 'The cost may equal zero.'],
            ['en', 'Zero is no problem.'],
            ['en', 'You are allowed to enter zero.'],
            ['en', 'Zero remains valid.'],
            ['en', 'Zero is okay by us.'],
        ]

        const prese = (elenco: Array<[Lingua, string]>): number =>
            elenco.filter(([l, t]) => ZERO_CONCESSO[l].test(t)).length
        const TUTTE = [...ATTORNO, ...CONTRO]
        const nonPrese = TUTTE.filter(([l, t]) => !ZERO_CONCESSO[l].test(t)).map(([, t]) => t)

        // ⚠️ UGUAGLIANZA, NON PAVIMENTO, ed è il rilievo che ha fatto riscrivere questa
        // riga. Era `toBeGreaterThanOrEqual(54)`: misurato, portando il riconoscitore a
        // 55/66 il test restava VERDE, e con lui l’«82%» del riquadro e l’elenco delle
        // «12 che restano fuori» — cioè la copertura poteva MIGLIORARE e il file
        // continuare a dichiarare il vecchio numero, che è esattamente ciò che il
        // commento qui sopra promette di impedire. Un presidio che si accorge solo dei
        // peggioramenti lascia invecchiare in silenzio metà delle proprie promesse.
        expect(
            [...nonPrese].sort(),
            'l’elenco delle forme che sfuggono non è più quello dichiarato: riscrivi le classi e i due tassi',
        ).toEqual([...NON_PRESE_ATTESE].sort())
        // I due denominatori e i due numeratori, che sono i quattro numeri del riquadro.
        expect(ATTORNO.length, 'l’elenco costruito ATTORNO alla regola si è accorciato').toBe(68)
        expect(CONTRO.length, 'l’elenco costruito CONTRO la regola si è accorciato').toBe(26)
        expect(prese(ATTORNO), 'il tasso sulle forme costruite attorno alla regola è cambiato').toBe(56)
        expect(prese(CONTRO), 'il tasso sulle forme costruite contro la regola è cambiato').toBe(2)
        // e nessuna forma contata due volte: un duplicato gonfierebbe un denominatore.
        expect(new Set(TUTTE.map(([l, t]) => `${l}|${t}`)).size, 'una forma è elencata due volte').toBe(TUTTE.length)
    })

    it('un errore «campo mancante» non ordina di compilare un campo che il pannello non ha', () => {
        // La prova che mancava, e il difetto che l'ha fatta nascere sta nel riquadro
        // della sezione 9: `reconComponiErrSedeMancante` diceva «Indica la sede di
        // questa riga» mentre il motore, due righe più su, dichiara che la sede la
        // DERIVA dal bambino. Il lock dei codici non poteva vederlo — il testo c'era,
        // ed era un ordine impossibile.
        const fantasma: string[] = []
        let sorvegliati = 0
        for (const codice of CODICI_DI_CAMPO_MANCANTE) {
            const chiave = chiaveDelCodice(codice)
            for (const lingua of LINGUE) {
                const testo = CONTABILITA[lingua][chiave] ?? ''
                const campi = etichetteDiCampo(lingua)
                sorvegliati += ordiniDiCompilazione(testo, lingua).length
                for (const ordine of ordiniSenzaCampo(testo, campi, lingua)) {
                    fantasma.push(
                        `messages/${lingua}/adminContabilita.json → \`${chiave}\` ordina «${ordine.trim()}», ` +
                        `ma fra i campi che il pannello ha non ce n’è nessuno con quel nome: ` +
                        `${campi.map((c) => `«${c}»`).join(', ')}`,
                    )
                }
            }
        }
        expect(
            fantasma,
            `Questi messaggi mandano l’operatrice a cercare un campo che nella schermata non ` +
            `esiste:\n  ${fantasma.join('\n  ')}\n` +
            `I nomi dei campi NON sono elencati qui: si leggono dalle chiavi ` +
            `\`reconComponiCampo*\` del catalogo. Se il campo esiste davvero, dagli la sua ` +
            `etichetta; se non esiste — come la sede di riga, che il motore DERIVA dal ` +
            `bambino — il messaggio non può ordinare di compilarlo.`,
        ).toEqual([])
        // I tre pavimenti, perché una regola che non guarda niente è verde su tutto.
        expect(CODICI_DI_CAMPO_MANCANTE.length, 'i codici «campo mancante» non si leggono più dal motore')
            .toBeGreaterThanOrEqual(4)
        expect(etichetteDiCampo('it').length, 'le etichette di campo non si leggono più dal catalogo')
            .toBeGreaterThanOrEqual(5)
        expect(sorvegliati, 'nessun messaggio sorvegliato: l’elenco degli imperativi è morto')
            .toBeGreaterThanOrEqual(6)
    })

    it('il controllo del campo fantasma vede l’ordine impossibile, e tace su quello eseguibile', () => {
        // Il controllo positivo: senza, `ordinaUnCampoFantasma` potrebbe ritornare
        // sempre `false` e il divieto qui sopra sarebbe verde su qualunque catalogo.
        const campi = ['Bambino', 'Categoria', 'Descrizione', 'Importo']
        expect(ordiniSenzaCampo('Indica la sede di questa riga.', campi, 'it')).toEqual(['Indica la sede di questa riga'])
        expect(ordiniSenzaCampo('Scegli il bambino di questa riga.', campi, 'it')).toEqual([])
        // ⚠️ LA PROVA CHE HA FATTO RISCRIVERE LA REGOLA. Il testo difettoso vero nomina
        // «il bambino» nella SECONDA frase, per dire che è lui a decidere: una regola
        // che cercasse l'etichetta in tutto il testo sarebbe VERDE qui — misurato,
        // ed è com'era nata. Il campo si cerca dentro il complemento dell'ordine.
        expect(
            ordiniSenzaCampo(
                'Indica la sede di questa riga: da lì si propone la sede del documento. ' +
                'Dove viene archiviata la voce lo decide il bambino, non questo campo.',
                campi,
                'it',
            ),
        ).toEqual(['Indica la sede di questa riga'])
        // Un messaggio che SPIEGA invece di comandare non ha ordini da sorvegliare, ed è
        // la via d'uscita presa da `reconComponiErrSedeMancante`: «non si indica» contiene
        // «indica», ma non sta in posizione d'ordine.
        expect(ordiniDiCompilazione('Questa riga non ha una sede, e la sede non si indica qui.', 'it')).toEqual([])
        expect(ordiniSenzaCampo('Set the location of this row.', ['Child', 'Category'], 'en')).toEqual([
            'Set the location of this row',
        ])
        expect(ordiniSenzaCampo('Choose the child for this row.', ['Child', 'Category'], 'en')).toEqual([])
        // L'etichetta si cerca senza badare alle maiuscole…
        expect(ordiniSenzaCampo('Inserisci il costo unitario.', ['Costo unitario'], 'it')).toEqual([])
        // ⚠️ …E SENZA BADARE AL NUMERO, che è il falso positivo misurato su questa
        // regola: il pannello compone PIÙ righe, e «Scegli **i bambini** di queste
        // righe» è un modo perfettamente legittimo di scriverlo. Con il confronto per
        // inclusione — `«bambini».includes(«bambino»)` è FALSO — il lock diventava rosso
        // su un catalogo corretto. In inglese colpiva i plurali in `-y` → `-ies`
        // (`Category`→`Categories`, `Quantity`→`Quantities`) e non «Child»→«Children»,
        // che per inclusione passa: cioè il difetto era pure asimmetrico fra le lingue.
        expect(ordiniSenzaCampo('Scegli i bambini di queste righe.', campi, 'it')).toEqual([])
        expect(ordiniSenzaCampo('Indica le categorie di queste righe.', campi, 'it')).toEqual([])
        // il plurale di un'etichetta di DUE parole cambia tutt'e due
        expect(ordiniSenzaCampo('Inserisci i costi unitari.', ['Costo unitario'], 'it')).toEqual([])
        expect(ordiniSenzaCampo('Select the categories of these rows.', ['Child', 'Category'], 'en')).toEqual([])
        expect(ordiniSenzaCampo('Enter the quantities for these rows.', ['Quantity'], 'en')).toEqual([])
        // …ma la radice non deve diventare una scorciatoia: «sede» non è nessun campo,
        // al plurale come al singolare.
        expect(ordiniSenzaCampo('Indica le sedi di queste righe.', campi, 'it')).toEqual(['Indica le sedi di queste righe'])
        // ⚠️ I DUE LIMITI DICHIARATI NEL RIQUADRO, RESI VISIBILI QUI invece che lasciati
        // al prossimo che ci sbatte credendo di aver trovato una falla nuova.
        // (b) un complemento oltre i 60 caratteri porta l'etichetta fuori dalla
        // finestra, e un ordine CORRETTO viene segnalato: è un falso positivo noto,
        // e la via d'uscita è accorciare il messaggio, non allargare la finestra.
        expect(
            ordiniSenzaCampo(
                'Scegli, nella colonna che trovi in fondo a destra della tabella, il bambino di questa riga.',
                campi,
                'it',
            ),
        ).toEqual(['Scegli, nella colonna che trovi in fondo a destra della tabella, i'])
        // e il prezzo del confronto per radice: una parola diversa con la stessa radice
        // del campo vale come il campo — «l'importanza» copre `Importo`.
        expect(ordiniSenzaCampo('Indica l’importanza di questa riga.', campi, 'it')).toEqual([])
        // ⚠️ LA SOGLIA DELLE 5 LETTERE, ESERCITATA. Senza una riga che la provi, portarla
        // a zero non rompeva niente — misurato VERDE — e una radice di due lettere si
        // troverebbe dentro mezzo vocabolario: «Ore» diventerebbe «Or», che sta dentro
        // «ordine». Un'etichetta corta si confronta intera.
        expect(nominaIlCampo('Indica l’ordine di questa riga', 'Ore')).toBe(false)
        expect(nominaIlCampo('Indica le ore di questa riga', 'Ore')).toBe(true)
        // …e un ordine dopo il punto conta come quello in testa.
        expect(ordiniSenzaCampo('Questa riga non quadra. Indica la sede.', campi, 'it')).toEqual(['Indica la sede'])
        // ⚠️ OGNI ORDINE RISPONDE DEL PROPRIO COMPLEMENTO. Questa riga è il verbale di
        // un tentativo riuscito di battere la regola: con una regex sola che consumava
        // verbo e complemento insieme, il primo ordine si mangiava il secondo e il
        // «bambino» copriva anche «la sede» — misurato VERDE.
        expect(ordiniDiCompilazione('Scegli il bambino e indica la sede di questa riga.', 'it'))
            .toEqual(['Scegli il bambino e ', 'indica la sede di questa riga'])
        expect(ordiniSenzaCampo('Scegli il bambino e indica la sede di questa riga.', campi, 'it'))
            .toEqual(['indica la sede di questa riga'])
        // …e un ordine incastonato a metà periodo conta lo stesso: a escludere è la
        // FORMA del verbo, non la sua posizione.
        expect(ordiniSenzaCampo('Per poter confermare indica la sede di questa riga.', campi, 'it'))
            .toEqual(['indica la sede di questa riga'])
        // L'ENCLITICO, altro tentativo riuscito prima che entrasse nella regola…
        expect(ordiniSenzaCampo('La sede manca. Indicala prima di confermare.', campi, 'it'))
            .toEqual(['Indicala prima di confermare'])
        // …e il participio, che NON deve diventare un ordine.
        expect(ordiniDiCompilazione('La sede indicata non esiste più.', 'it')).toEqual([])
        // «digitale» non è «digita»: sta fuori dal gruppo dell'enclitico apposta.
        expect(ordiniDiCompilazione('Il documento è in formato digitale.', 'it')).toEqual([])
        expect(ordiniDiCompilazione('Digita la sede.', 'it')).toEqual(['Digita la sede'])
        // Il perimetro vero è quello dei codici DI RIGA: `composizione_vuota` — che
        // finisce in `_vuota` ma non parla di un campo — ne resta fuori.
        expect(CODICI_DI_CAMPO_MANCANTE).not.toContain('composizione_vuota')
        expect(CODICI_DI_CAMPO_MANCANTE).toContain('sede_mancante')
    })

    it('i codici che il motore emette SOLO sulla ricarica ticket parlano di ticket', () => {
        // Il ramo `specie === 'ticket'` è l'unico posto in cui i campi a schermo non
        // sono quelli di sempre: non c'è «Importo», ci sono «Quantità», «Costo
        // unitario» e «Totale». Un messaggio scritto per la riga normale, letto lì,
        // manda a cercare un campo che non esiste.
        const muti: string[] = []
        for (const codice of CODICI_DEL_RAMO_TICKET) {
            const chiave = chiaveDelCodice(codice)
            for (const lingua of LINGUE) {
                const testo = CONTABILITA[lingua][chiave] ?? ''
                if (!/ticket/i.test(testo) || !QUALIFICA_TICKET[lingua].test(testo)) {
                    muti.push(
                        `messages/${lingua}/adminContabilita.json → \`${chiave}\` = «${testo}» ` +
                        `non nomina il ticket mensa, ma il motore emette \`${codice}\` nel ramo della ricarica`,
                    )
                }
            }
        }
        expect(
            muti,
            `Messaggi del ramo ticket che non dicono di stare parlando di ticket:\n  ${muti.join('\n  ')}\n` +
            `I codici NON sono elencati qui: si leggono dal ramo \`specie === 'ticket'\` di ` +
            `${SORGENTE_MOTORE}, così un codice spostato dentro o fuori da quel ramo cambia la regola con sé.`,
        ).toEqual([])
        // Pavimento: se l'estrazione del ramo smettesse di funzionare, l'elenco
        // sarebbe vuoto e la prova qui sopra verde per non aver preteso niente.
        expect(CODICI_DEL_RAMO_TICKET.length, 'il ramo ticket del motore non si legge più').toBeGreaterThanOrEqual(3)
    })

    it('un codice emesso in DUE contesti nomina i campi di tutt’e due', () => {
        // `importo_non_positivo` è emesso sulla riga normale — dove il campo si chiama
        // «Importo» — E dentro il ramo ticket, dove quel campo non esiste e il totale
        // è quantità × costo unitario. Il testo che regge in un contesto solo è falso
        // nell'altro, e i nomi dei campi si leggono dal CATALOGO, non si ricopiano qui:
        // se domani `reconComponiCampoQuantita` cambia parola, questo lock lo pretende
        // anche nel messaggio.
        const CAMPI_DEL_RAMO_TICKET = ['reconComponiCampoQuantita', 'reconComponiCampoCostoUnitario']
        const CAMPO_DELLA_RIGA_NORMALE = 'reconComponiCampoImporto'
        const parziali: string[] = []
        for (const codice of CODICI_IN_DUE_CONTESTI) {
            const chiave = chiaveDelCodice(codice)
            for (const lingua of LINGUE) {
                const testo = (CONTABILITA[lingua][chiave] ?? '').toLowerCase()
                for (const campo of [CAMPO_DELLA_RIGA_NORMALE, ...CAMPI_DEL_RAMO_TICKET]) {
                    const nome = (CONTABILITA[lingua][campo] ?? '').toLowerCase()
                    if (!nome || !testo.includes(nome)) {
                        parziali.push(
                            `messages/${lingua}/adminContabilita.json → \`${chiave}\` non nomina ` +
                            `\`${campo}\` («${CONTABILITA[lingua][campo]}»), e il codice \`${codice}\` ` +
                            `arriva anche da quel contesto`,
                        )
                    }
                }
            }
        }
        expect(
            parziali,
            `Un messaggio che vale per metà dei suoi contesti:\n  ${parziali.join('\n  ')}\n` +
            `Quali codici arrivino da due contesti NON è scritto qui: si conta quante volte ` +
            `${SORGENTE_MOTORE} li emette dentro e fuori dal ramo ticket.`,
        ).toEqual([])
        expect(CODICI_IN_DUE_CONTESTI.length, 'nessun codice bi-contesto: l’estrazione è morta').toBeGreaterThanOrEqual(1)
    })

    it('i codici DICHIARATI dal motore e quelli EMESSI sono gli stessi', () => {
        // ⚠️ LA PROVA CHE MANCAVA, e il pavimento che la rendeva aggirabile.
        // `CODICI` nasce da due unioni lette con una regex, e quella regex degrada in
        // SILENZIO: misurato, con i doppi apici ritorna `[]`, con
        // `typeof CODICI[number]` ritorna `[]`, un codice con maiuscole o con un
        // trattino lo scarta, e un membro dell'unione a colonna zero tronca la lettura.
        // Il presidio era `CODICI.length >= 8` su 12 codici: se una delle due unioni
        // smettesse di essere letta, i 2 codici di composizione sparirebbero lasciando
        // 10 ≥ 8 — cioè VERDE SUL VUOTO, la trappola che questo lock esiste per evitare.
        //
        // La contro-lettura prende i codici dall'altro capo, dai punti in cui il motore
        // li EMETTE, e pretende gli stessi due insiemi. Prende la perdita silenziosa in
        // lettura **e** un codice dichiarato che nessuno emette più.
        const dalTipo = new Set(CODICI)
        const dalleEmissioni = new Set(codiciEmessi(MOTORE_SENZA_COMMENTI))
        const dichiaratiMaiEmessi = [...dalTipo].filter((c) => !dalleEmissioni.has(c))
        const emessiMaiDichiarati = [...dalleEmissioni].filter((c) => !dalTipo.has(c))
        expect(
            { dichiaratiMaiEmessi, emessiMaiDichiarati },
            `I due capi del motore non dicono la stessa cosa.\n` +
            `Dichiarati e mai emessi: ${dichiaratiMaiEmessi.join(', ') || '—'}\n` +
            `Emessi e mai dichiarati: ${emessiMaiDichiarati.join(', ') || '—'}\n` +
            `Se il secondo elenco non è vuoto, l’estrattore delle unioni ha smesso di leggere ` +
            `(o il codice nuovo non ha la forma \`minuscole_con_underscore\`): il catalogo ` +
            `resterebbe senza il suo testo e nessuno se ne accorgerebbe.`,
        ).toEqual({ dichiaratiMaiEmessi: [], emessiMaiDichiarati: [] })
        // E il pavimento PER TIPO, che quello aggregato non era: due insiemi vuoti sono
        // uguali fra loro, e senza questo l'uguaglianza qui sopra sarebbe verde su nulla.
        expect(codiciDelTipo(MOTORE, 'CodiceViolazione').length, 'CodiceViolazione non si legge più').toBeGreaterThanOrEqual(9)
        expect(codiciDelTipo(MOTORE, 'CodiceViolazioneComposizione').length, 'CodiceViolazioneComposizione non si legge più').toBeGreaterThanOrEqual(2)
    })

    it('l’estrattore delle EMISSIONI vede un codice che quello delle unioni scarterebbe', () => {
        // Il controllo positivo della contro-lettura: i due estrattori devono leggere
        // cose diverse, altrimenti degradano insieme e il confronto è una formalità.
        const finto = [
            "        if (x) aggiungi('minuscolo_ok')",
            "        else aggiungi('Maiuscolo-Strano')",
            "    out.push('di_composizione')",
            '    out.push({ indice, codice })',
            // ⚠️ IL CAST, ED È LA SOLA RIGA CHE ESERCITA LA `)` NON PRETESA. Il commento
            // dentro `codiciEmessi` racconta che una prima stesura chiedeva la parentesi
            // attaccata e che `aggiungi('codice_fantasma' as CodiceViolazione)` le passava
            // sotto — ma quella forma non stava in nessuna prova, e nel motore di oggi non
            // c'è nessuna emissione con qualcosa dopo il letterale (misurato con
            // `grep -nE "(aggiungi|out\\.push)\\(\\s*'[^']*'[^)]"`: zero righe). Cioè
            // rimettere la `)` non rompeva niente: VERDE (misurato). Con questa riga no.
            "    aggiungi('con_cast' as CodiceViolazione)",
        ].join('\n')
        expect(codiciEmessi(finto)).toEqual(['minuscolo_ok', 'Maiuscolo-Strano', 'di_composizione', 'con_cast'])
        // l'oggetto NON è un codice, e non deve entrare
        expect(codiciEmessi(finto)).not.toContain(' indice, codice ')
        // e il ritaglio di un ramo prende il ramo, non il file
        const sorgente = "function f() {\n    if (a === 'ticket') {\n        aggiungi('dentro')\n    }\n    aggiungi('fuori')\n}"
        expect(codiciEmessi(bloccoBilanciato(sorgente, "a === 'ticket')"))).toEqual(['dentro'])
        expect(() => bloccoBilanciato(sorgente, 'non_esiste')).toThrow(/non_esiste/)
    })

    it('l’estrattore legge davvero l’unione del motore, e si accorge se cambia forma', () => {
        // Il controllo positivo dell'estrattore: senza, `CODICI` potrebbe essere vuoto
        // e la prova qui sopra sarebbe verde per non aver preteso niente.
        const finto = [
            'export type CodiceFinto =',
            "    | 'uno'",
            "    /** L'apostrofo di un commento non e' un codice, e nemmeno 'questo'. */",
            "    | 'due_tre'",
            '',
            'export interface Altro { x: number }',
        ].join('\n')
        expect(codiciDelTipo(finto, 'CodiceFinto')).toEqual(['uno', 'due_tre'])
        // e un nome che è il PREFISSO di un altro non deve pescare l'unione sbagliata
        expect(codiciDelTipo("export type CodiceFintoLungo = 'z'\n\nconst x = 1", 'CodiceFintoLungo')).toEqual(['z'])
        expect(() => codiciDelTipo(finto, 'CodiceAssente')).toThrow(/CodiceAssente/)
        // Sul sorgente vero: 11 il 2026-09-12 (9 di riga + 2 di composizione), 12 da
        // quando un'altra fetta ha aggiunto `costo_unitario_non_positivo` (10 + 2).
        //
        // ⚠️ QUESTO PAVIMENTO È AGGREGATO, E DA SOLO NON BASTA: con le due unioni sommate,
        // perderne una INTERA (i 2 codici di composizione) lascia 10 ≥ 8, cioè verde sul
        // vuoto. Misurato riscrivendo quell'unione a doppi apici: questa riga resta
        // VERDE. Resta qui perché è il controllo positivo dell'estrattore dei TIPI; la
        // rete vera sono i due pavimenti PER TIPO e la contro-lettura dalle emissioni,
        // nella prova qui sopra. Chi legge solo questa riga si fa un'idea sbagliata di
        // quanto è protetto.
        expect(CODICI.length, 'l’estrattore non vede più i codici del motore').toBeGreaterThanOrEqual(8)
        expect(new Set(CODICI).size, 'due codici uguali nelle due unioni').toBe(CODICI.length)
        expect(chiaveDelCodice('oltre_residuo_aggregato')).toBe('reconComponiErrOltreResiduoAggregato')
    })
})
