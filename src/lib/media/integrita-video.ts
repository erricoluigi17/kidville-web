import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'

/**
 * IL CANCELLO CHE MANCAVA A VALLE DELLA CONVERSIONE VIDEO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO CHE QUESTO MODULO CHIUDE
 *
 * La conversione lato client (`@/lib/media/video-mediarecorder`, che il barile
 * `@/lib/media/processing` ri-esporta) ridisegna il video su una tela e lo ri-registra con
 * `MediaRecorder`. Quando qualcosa cede a metà — il ciclo di disegno si ferma perché la
 * scheda è passata in background, la traccia audio non entra nello stream, il decoder molla
 * il colpo su un HEVC — il risultato NON è un errore: è un FILE. Un file con la durata
 * giusta, il container giusto, la dimensione giusta, che si apre e mostra **un fotogramma
 * fermo** per quaranta secondi, **muto**.
 *
 * `validateVideoFile` non lo ferma, e non può: guarda `type` e `size`, e quel file li ha
 * entrambi in ordine. Nessun test è rosso, nessuna route risponde 400, nessun log si
 * accende. Il primo a scoprirlo è il genitore che apre la galleria.
 *
 * Questo modulo è l'unico posto in cui si decide se una conversione è andata a buon fine
 * **guardando il risultato invece del suo involucro**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ È PURO E SENZA DOM
 *
 * Due motivi, e il secondo conta più del primo.
 *
 *  1. **Si testa senza browser.** La decisione è aritmetica su sette numeri: sotto vitest
 *     si copre ogni caso di confine in millisecondi, senza `MediaRecorder` (che in jsdom
 *     non esiste) e senza una tela vera. Una regola che si può provare solo a mano è una
 *     regola che nessuno prova.
 *  2. **Non può divergere fra le due strade di conversione.** Le strade che consegnano un
 *     video convertito sono più d'una, e la storia di questo repo è la storia della stessa
 *     regola scritta tre volte con tre `split` diversi (vedi il commento di `mimeBase` in
 *     `@/lib/gallery/limiti`: il 2026-09-08 ha fermato TUTTI i video della galleria, ed era
 *     la seconda volta). Qui la regola ha un nome solo: chi misura passa una
 *     `MisuraConversione`, chi decide è questa funzione.
 *
 * La purezza non è un'intenzione ma un lock: `__tests__/lib/integrita-video.test.ts`
 * legge questo sorgente, ne toglie i commenti e pretende che il codice non nomini nessun
 * globale del browser e non importi niente oltre `@/lib/gallery/limiti`. Il perimetro di
 * quel lock — cosa NON prende — è dichiarato accanto a lui.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * QUESTO MODULO NON LOGGA — È UN DOVERE DEL CHIAMANTE
 *
 * Non logga perché è puro (e perché gira nel browser, dove il logger è `logClient`, non
 * `logEvento`). Ma un rifiuto che non lascia traccia è un rifiuto che non si può contare:
 * **chi chiama `verificaIntegrita` logga il `motivo`** quando `integro` è `false`, così in
 * `app_log` si vede se la conversione è guasta su un dispositivo, su un formato o su tutti.
 * Il `motivo` è un enum senza dati personali: si logga per intero, sempre.
 */

/**
 * LE SETTE MISURE, prese dal chiamante prima e dopo la conversione.
 *
 * Sono tutte numeri o booleani: nessun nome di file, nessun percorso, nessun MIME. Il nome
 * di un file di galleria è anagrafica di un minore (`IMG_bambina-rossi.mov`) e non entra in
 * questa struttura proprio perché il chiamante la logga.
 */
export interface MisuraConversione {
    /** Durata del video SORGENTE, in secondi. Va risolta prima di chiamare (vedi `durata-illeggibile`). */
    durataIngressoS: number
    /**
     * Durata del video PRODOTTO, in secondi, oppure `null` se non si è riusciti a leggerla.
     *
     * ⚠️ `MediaRecorder` consegna quasi sempre `duration === Infinity`: il container che
     * scrive non conosce la durata finché non chiude, e la durata dell'elemento resta
     * `Infinity` fino a che non si forza un seek. Vedi `durata-illeggibile`.
     */
    durataUscitaS: number | null
    /** Dimensione in byte del file prodotto (`blob.size`). */
    byteUscita: number
    /**
     * Il SORGENTE aveva una traccia audio.
     *
     * ⚠️ COME SI OTTIENE — ed è il campo più difficile dei sette, quindi è quello che ha più
     * bisogno di una riga qui invece che di un default scelto in fretta dal chiamante.
     *
     * L'elemento video **non** espone in modo portabile la presenza di una traccia audio:
     * `audioTracks` è di Safari, `mozHasAudio` di Firefox, e su Chrome non c'è né l'uno né
     * l'altro. Serve una sonda esplicita (una lettura del contenitore, o un passaggio in
     * Web Audio che misuri se esce campione diverso da zero) prima di riempire questo campo.
     *
     * ⚠️ IN MANCANZA DI UNA MISURA AFFIDABILE SI PASSA `false` DA ENTRAMBI I LATI, cioè si
     * SPEGNE la regola 3 — non `true`. Le due scelte non sono simmetriche:
     *
     *  - con `true` fisso, un video girato in silenzio che passa dal ramo `catch` della
     *    cattura Web Audio (`video-mediarecorder.ts:103`, quello che azzera il volume e
     *    prosegue senza traccia) viene rifiutato per `audio-perduto`. È un falso rifiuto,
     *    cioè l'insegnante che riprova tre volte e poi chiama: il modo più rapido di far
     *    disattivare un cancello, ed è scritto anche accanto alla regola 3;
     *  - con `false` fisso la regola 3 non scatta mai, ed è una regola morta. Una regola
     *    morta non fa danni: un falso rifiuto sì.
     *
     * Nota per chi collega: lato USCITA l'unico segnale attendibile è l'esito della cattura
     * (`audioTrack !== null` in `video-mediarecorder.ts:101`), e attenzione perché
     * `createMediaStreamDestination()` produce SEMPRE una traccia, anche silenziosa: dedotta
     * dallo stream, `tracciaAudioUscita` è `true` quasi sempre. La regola 3 vive o muore sul
     * valore in INGRESSO.
     */
    tracciaAudioIngresso: boolean
    /** Il PRODOTTO ha una traccia audio. Vedi la nota su `tracciaAudioIngresso`. */
    tracciaAudioUscita: boolean
    /**
     * Quanti disegni il ciclo di conversione si ASPETTAVA di fare (tipicamente
     * `durata × fps`; i fps della tela sono i 25 di `captureStream(25)`,
     * `video-mediarecorder.ts:117`).
     */
    fotogrammiAttesi: number
    /**
     * Quanti disegni hanno mostrato un fotogramma DIVERSO dal precedente.
     *
     * ⚠️ COME SI OTTIENE, ed è l'unico modo che regge: si tiene l'ultimo tempo del video
     * SORGENTE disegnato e si incrementa il contatore **solo quando quel tempo è CAMBIATO**
     * rispetto al disegno precedente:
     *
     * ```ts
     * let ultimoTempo = -1
     * let distinti = 0
     * // dentro il ciclo di disegno:
     * ctx.drawImage(video, 0, 0, w, h)
     * if (video.currentTime !== ultimoTempo) { distinti++; ultimoTempo = video.currentTime }
     * ```
     *
     * Contare i giri del ciclo NON serve a niente: il ciclo gira anche su un video fermo, e
     * un contatore di giri resterebbe perfetto proprio nel caso che qui si vuole prendere.
     * Contare i fotogrammi DISTINTI invece **inchioda** il contatore appena la tela si
     * ferma, che è la firma del difetto.
     *
     * ⚠️ Se il chiamante non strumenta il ciclo e passa `0` e `0`, la regola
     * `fotogrammi-congelati` non scatta (0 non è sotto metà di 0): non è un cancello che si
     * arma da sé, va misurato. `NaN` e i negativi invece sono una misura ROTTA e vengono
     * RIFIUTATI — vedi il guard della regola 5.
     */
    fotogrammiDistinti: number
}

/**
 * Perché la conversione NON è integra, in forma di CODICE.
 *
 * Enum-like e senza PII, per lo stesso motivo dei `codice:` delle route e di
 * `MotivoVideoNonValido`: nasce in una libreria condivisa dove il locale non esiste, e la
 * frase nella lingua dell'interfaccia la mette chi ha il locale — la pagina.
 */
export type MotivoNonIntegro =
    | 'durata-illeggibile' | 'durata-divergente' | 'audio-perduto'
    | 'byte-implausibili'  | 'fotogrammi-congelati'

/**
 * Il bitrate MINIMO cablato nella conversione.
 *
 * È il `600000` di `bitrate = Math.max(600000, Math.min(2500000, bitrate))` in
 * `src/lib/media/video-mediarecorder.ts:89` (oggi riga 89; il numero si trova a colpo sicuro
 * cercando `Math.max(600000`). Non è una scelta di questo file: è il pavimento che
 * `MediaRecorder` riceve, quindi il pavimento sotto cui il file prodotto non può stare se la
 * registrazione ha davvero scritto qualcosa.
 *
 * ⚠️ PERCHÉ È COPIATO A MANO, e cosa impedisce che diverga. Il tetto dei byte lo si importa
 * (`TETTO_GALLERIA_BYTE`) perché vive in un modulo senza import, caricabile dal browser
 * senza trascinarsi dietro niente. Questo no: sta dentro il modulo di conversione, che è
 * tutto DOM — importarlo qui romperebbe la purezza che è la ragione d'esistere di questo
 * file. Quindi la copia è voluta, ed è **esportata** e **sorvegliata da un lock**: il test
 * rilegge il sorgente della conversione, ne estrae quel numero e pretende che sia identico a
 * questa costante. Se domani il cap passa a 300 kbps, il lock diventa rosso — invece di
 * lasciare questo pavimento a rifiutare video sani in silenzio.
 *
 * La citazione qui sopra, prima di questo giro, puntava a `processing.ts` riga ~252: era
 * esatta contro un `HEAD` vecchio e falsa sul file, perché la conversione era stata spostata
 * e `processing.ts` è diventato un barile di 75 righe. Un puntatore si verifica sul file, non
 * su `git show`; e un numero che conta si sorveglia con un lock, non con un puntatore.
 */
export const BITRATE_MINIMO_BPS = 600_000

/**
 * Quanto si concede al pavimento: **un quarto**.
 *
 * Il bitrate richiesto a `MediaRecorder` è un obiettivo, non un contratto — un video molto
 * statico (una parete, un disegno) si comprime molto sotto la richiesta, in modo del tutto
 * legittimo. Un quarto lascia passare quella compressione e prende comunque il caso che
 * conta: un file che pesa come se non contenesse quasi nessun fotogramma.
 */
const FRAZIONE_PAVIMENTO = 1 / 4

/** Tolleranza assoluta sulla durata: mezzo secondo. */
const TOLLERANZA_DURATA_S = 0.5

/** Tolleranza relativa sulla durata: 5% dell'ingresso, quando vale più di mezzo secondo. */
const TOLLERANZA_DURATA_FRAZIONE = 0.05

/** Sotto questa frazione dei fotogrammi attesi, la tela era ferma. */
const FRAZIONE_FOTOGRAMMI_MINIMA = 0.5

/**
 * Una conversione è integra?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * L'ORDINE DI VALUTAZIONE, e perché è QUESTO
 *
 * **La prima regola che fallisce vince**, e l'ordine è quello dichiarato qui sotto. Non è
 * cosmetico: il `motivo` è ciò che finisce nel log e nella diagnosi, quindi decide se fra
 * sei mesi si guarda nel posto giusto.
 *
 *  1. **`durata-illeggibile` per prima**, perché senza una durata non si può giudicare
 *     nient'altro: le regole 2 e 4 la usano, e in JavaScript un confronto con `NaN` è
 *     `false` — cioè un file senza durata **passerebbe tutti i controlli in silenzio**.
 *     Non è un'ipotesi: è il modo in cui questa verifica diventerebbe decorazione.
 *  2. **`durata-divergente` per seconda**: se la durata prodotta non è quella di partenza,
 *     i byte e i fotogrammi descrivono un video DIVERSO da quello misurato, e ogni soglia
 *     più sotto starebbe confrontando due cose che non si corrispondono. «Il video è
 *     tronco» è anche la diagnosi più azionabile che si possa dare.
 *  3. **`audio-perduto` per terza**: è indipendente dalle altre, ma è la diagnosi più
 *     precisa e più stretta che questo modulo sappia dare, ed è metà del sintomo riferito
 *     («congelati, e muti»). Sta sopra i byte di proposito: un file muto pesa anche MENO,
 *     quindi la regola 4 scatterebbe facilmente al posto suo e riporterebbe la causa
 *     sbagliata.
 *  4. **`byte-implausibili` per quarta**: è l'unica soglia **euristica** delle cinque (un
 *     pavimento su un bitrate che è un obiettivo, non una garanzia), quindi cede il passo a
 *     ogni misura deterministica che le sta sopra.
 *  5. **`fotogrammi-congelati` per ultima**, e con un prezzo da dichiarare: un file
 *     congelato E minuscolo viene riportato come `byte-implausibili`. Entrambe rifiutano —
 *     il file non passa in nessuno dei due casi — ma il nome è meno preciso. Si accetta
 *     perché la regola 4 copre anche il caso in cui il chiamante NON ha strumentato il
 *     ciclo di disegno (`fotogrammiAttesi: 0`), dove la regola 5 è cieca per costruzione:
 *     l'euristica sui byte è l'unica rete rimasta sotto.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * LA REGOLA CHE VALE PER TUTTE E CINQUE: una misura ROTTA è un RIFIUTO
 *
 * Ogni regola qui sotto è un confronto fra numeri, e ogni confronto con `NaN` è `false`: una
 * strumentazione guasta non fa scattare niente, **apre il cancello in silenzio**. Perciò
 * `NaN`, `±Infinity` e i valori fuori dominio (durate e conteggi negativi) vengono rifiutati
 * per primi, campo per campo, col motivo della regola a cui quel campo appartiene. È il
 * difetto per cui questo modulo esiste, applicato a sé stesso: un video congelato con il
 * contatore dei fotogrammi guasto è stato **accettato** finché quel guard mancava.
 */
export function verificaIntegrita(m: MisuraConversione): { integro: true } | { integro: false; motivo: MotivoNonIntegro } {
    // 1 ── DURATA ILLEGGIBILE.
    //
    // `null` è il chiamante che dichiara di non averla; poi tutto ciò che non è un numero di
    // secondi utilizzabile: `Infinity` (il caso NORMALE di `MediaRecorder`, non un caso
    // raro), `-Infinity`, `NaN`, e i valori NEGATIVI.
    //
    // ⚠️ DOVERE DEL CHIAMANTE, e non è un dettaglio: la durata vera del file prodotto va
    // RISOLTA prima di chiamare — si carica il blob in un elemento video, si porta il tempo
    // corrente a un valore enorme (`1e101`) e si aspetta `durationchange`, che è il modo con
    // cui il browser finalmente la calcola. Chi passa qui l'`Infinity` grezzo di
    // `MediaRecorder` rende questa verifica SEMPRE rossa, e una verifica sempre rossa in due
    // giorni viene spenta da qualcuno — con dentro anche le quattro regole che funzionavano.
    //
    // Vale anche per l'INGRESSO: una durata sorgente non utilizzabile rende insensate la
    // regola 2 (il confronto) e la 4 (il pavimento), e in silenzio. Misurato: prima che
    // questo ramo coprisse i negativi, un'uscita di -96 s su un ingresso di -100 s passava
    // per INTEGRA, perché la tolleranza si calcolava sul valore assoluto dell'ingresso.
    //
    // ⚠️ L'ASIMMETRIA FRA I DUE LATI È VOLUTA: l'ingresso si rifiuta anche a ZERO, l'uscita
    // no. Un sorgente di zero secondi non è una misura rispetto a cui giudicare qualcosa —
    // sta con `NaN`. Un'uscita di zero secondi invece è una durata LETTA, ed è un guasto
    // preciso e diagnosticabile («la registrazione non ha scritto nulla»): la prende la
    // regola 2, che sa dire di più.
    if (m.durataUscitaS === null || !Number.isFinite(m.durataUscitaS) || m.durataUscitaS < 0) {
        return { integro: false, motivo: 'durata-illeggibile' }
    }
    if (!Number.isFinite(m.durataIngressoS) || m.durataIngressoS <= 0) {
        return { integro: false, motivo: 'durata-illeggibile' }
    }

    // 2 ── DURATA DIVERGENTE: più di mezzo secondo, o più del 5% dell'ingresso, di scarto.
    //
    // Un'uscita di ZERO secondi divergerebbe del 100% da qualunque ingresso (che qui è già
    // certo essere positivo), ma la tolleranza ASSOLUTA di mezzo secondo la assorbirebbe su
    // ogni clip più corta di mezzo secondo: misurato, `{ingresso: 0,4 s, uscita: 0 s, 1
    // byte}` passava per integra. Un file senza durata non è un video, e la tolleranza non
    // deve poterlo salvare: ramo esplicito, prima del confronto.
    if (m.durataUscitaS === 0) {
        return { integro: false, motivo: 'durata-divergente' }
    }

    // Il massimo fra i due, non il minimo: su un video di 3 secondi il 5% sono 150 ms, meno
    // dell'imprecisione normale di un container, e la regola diventerebbe un falso positivo
    // a ogni clip corta. Su un video di due minuti mezzo secondo è nulla, e il 5% (6 s) è la
    // soglia che serve.
    //
    // Nessun `Math.abs` sull'ingresso: la regola 1 garantisce che sia positivo e finito. Il
    // `Math.abs` che stava qui si giustificava con una ragione FALSA («una tolleranza
    // negativa farebbe scattare la regola su qualunque cosa» — impossibile, `Math.max(0.5,
    // x)` non torna mai un negativo) e faceva l'opposto di quel che dichiarava: su un
    // ingresso di -100 s ALLARGAVA la tolleranza da 0,5 s a 5 s.
    const tolleranza = Math.max(
        TOLLERANZA_DURATA_S,
        m.durataIngressoS * TOLLERANZA_DURATA_FRAZIONE,
    )
    if (Math.abs(m.durataUscitaS - m.durataIngressoS) > tolleranza) {
        return { integro: false, motivo: 'durata-divergente' }
    }

    // 3 ── AUDIO PERDUTO: c'era e non c'è più.
    //
    // Solo in questa direzione. Un video girato in silenzio (o con il microfono coperto, o
    // un timelapse) è legittimo e resta legittimo: pretendere audio dove non ce n'era
    // significherebbe rifiutare video sani, ed è il modo più rapido di far disattivare un
    // cancello. La cattura Web Audio in `video-mediarecorder.ts:103` ha un ramo di ripiego
    // che azzera il volume (riga 110) e prosegue SENZA traccia: è esattamente il caso che
    // questa regola prende — a patto che il chiamante sappia misurare l'audio in ingresso,
    // e la nota su `tracciaAudioIngresso` dice cosa fare quando non lo sa.
    if (m.tracciaAudioIngresso && !m.tracciaAudioUscita) {
        return { integro: false, motivo: 'audio-perduto' }
    }

    // 4 ── BYTE IMPLAUSIBILI: sotto il pavimento, o sopra il tetto del bucket.
    //
    // Il pavimento è un quarto del bitrate minimo cablato per la durata prodotta (si usa la
    // durata dell'USCITA perché è il file di cui si stanno contando i byte — e a questo
    // punto è già certo che coincida con l'ingresso entro la tolleranza della regola 2).
    //
    // Il tetto NON è riscritto qui: è `TETTO_GALLERIA_BYTE` di `@/lib/gallery/limiti`, cioè
    // il limite GLOBALE del progetto Supabase. Dichiararne uno diverso da quello vero
    // significa firmare un caricamento che lo Storage poi rifiuta, dopo che il file è stato
    // spedito per intero su rete mobile (difetto misurato il 2026-09-01).
    //
    // Il non-finito (`NaN` da una sottrazione andata male, `Infinity`) è implausibile per
    // definizione, e va detto: senza questo ramo passerebbe indenne dai due confronti qui
    // sotto, perché ogni confronto con `NaN` è `false`.
    //
    // ⚠️ NON c'è un ramo `byteUscita <= 0`, e l'assenza è voluta: sarebbe morto. La regola 2
    // garantisce `durataUscitaS > 0`, quindi il pavimento è STRETTAMENTE positivo e prende
    // già lo zero e i negativi, con lo stesso motivo. Un ramo che nessun caso di test può
    // distinguere da quello accanto non è una rete di sicurezza: è un mutante che sopravvive
    // per sempre (misurato: rimuovendolo, 43 test restavano verdi). Ciò che tiene in piedi
    // l'invariante «zero byte non passa» sono i casi `byteUscita: 0` e `-1` del test, che
    // diventano rossi se il pavimento scende a zero.
    if (!Number.isFinite(m.byteUscita)) {
        return { integro: false, motivo: 'byte-implausibili' }
    }
    const pavimentoByte = (BITRATE_MINIMO_BPS / 8) * FRAZIONE_PAVIMENTO * m.durataUscitaS
    if (m.byteUscita < pavimentoByte) {
        return { integro: false, motivo: 'byte-implausibili' }
    }
    if (m.byteUscita > TETTO_GALLERIA_BYTE) {
        return { integro: false, motivo: 'byte-implausibili' }
    }

    // 5 ── FOTOGRAMMI CONGELATI: meno della metà dei disegni ha mostrato qualcosa di nuovo.
    //
    // ⚠️ PRIMA il guard sulla MISURA, per la stessa ragione scritta due volte qui sopra (per
    // la durata e per i byte) e con la stessa conseguenza quando manca: `distinti < 0.5 *
    // attesi` con un `NaN` da una parte è `false`, e con un `attesi` NEGATIVO il confronto è
    // falso sempre. Misurato, prima che questo guard esistesse: `{attesi: NaN, distinti: 0}`
    // → integro, `{distinti: NaN}` → integro, `{attesi: -100, distinti: 0}` → integro. Cioè
    // un video CONGELATO con la strumentazione guasta veniva ACCETTATO e arrivava al
    // genitore: la direzione peggiore in cui questo modulo possa sbagliare, e proprio sulla
    // regola che prende il sintomo riferito. Misura inattendibile = RIFIUTO.
    //
    // L'UNICO non-misurato che resta ammesso è `fotogrammiAttesi: 0`: è il chiamante che
    // dichiara di non aver strumentato il ciclo di disegno, e in quel caso la regola 5 è
    // cieca per costruzione (sotto resta l'euristica dei byte della regola 4). Zero è una
    // DICHIARAZIONE DI ASSENZA; `NaN` e i negativi sono una misura ROTTA. Non si confondono,
    // e il confine fra i due è questo guard.
    //
    // ⚠️ L'ASIMMETRIA È MISURATA, non una dimenticanza: c'è `fotogrammiAttesi < 0` e NON c'è
    // `fotogrammiDistinti < 0`. Un ATTESO negativo rende il confronto qui sotto falso sempre
    // (`0 < -50` è falso), quindi senza questa clausola un video fermo passerebbe — provato,
    // togliendola il caso `{attesi: -100}` diventa rosso. Un DISTINTO negativo invece
    // soddisfa il confronto comunque (un numero negativo è sotto qualunque metà non
    // negativa), quindi una clausola per lui non cambierebbe un solo esito: sarebbe un ramo
    // che nessun caso di test può distinguere da quello accanto, cioè un mutante che
    // sopravvive per sempre. Stesso ragionamento, e stessa misura, del `byteUscita <= 0` che
    // non c'è nella regola 4. Il RIFIUTO di un conteggio negativo resta comunque preteso dal
    // test: è l'esito che si inchioda, non il ramo che lo produce.
    if (
        !Number.isFinite(m.fotogrammiAttesi) || !Number.isFinite(m.fotogrammiDistinti)
        || m.fotogrammiAttesi < 0
    ) {
        return { integro: false, motivo: 'fotogrammi-congelati' }
    }

    // È il controllo che prende il sintomo riferito dal titolare — durata piena, un
    // fotogramma solo — e l'unico che non si possa dedurre dall'involucro del file. Metà è
    // larga di proposito: un `drawImage` può ripetere lo stesso fotogramma quando la tela
    // gira più veloce del video sorgente (25 fps di tela su un sorgente a 24, o una scheda
    // rallentata in background), e va tollerato. Sotto la metà non è più ripetizione: è una
    // tela che ha smesso di aggiornarsi.
    if (m.fotogrammiDistinti < FRAZIONE_FOTOGRAMMI_MINIMA * m.fotogrammiAttesi) {
        return { integro: false, motivo: 'fotogrammi-congelati' }
    }

    return { integro: true }
}
