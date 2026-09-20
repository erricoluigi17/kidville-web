/**
 * IL CODICE DELLA VOCE — l'etichetta breve che dice QUALE voce si sta pagando.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * La causale che il genitore ricopia nell'home banking porta il codice fiscale
 * del minore: dice di CHI è il pagamento, non di CHE COSA. Finché la famiglia ha
 * una sola voce aperta la differenza non si vede; appena ne ha due la
 * riconciliazione deve indovinare, e l'importo non la aiuta perché le rette sono
 * tutte uguali. Misura su produzione: 37 movimenti rossi su 50 hanno più voci
 * aperte con lo stesso identico residuo. Un codice per voce toglie l'ambiguità
 * alla fonte, cioè nel testo che il genitore ha già in mano.
 *
 * ─── PERCHÉ QUESTO MODULO NON HA NEMMENO UN `import` ────────────────────────
 * Il vincolo è misurabile, non una preferenza di stile. Chi consuma questo
 * modulo è `src/lib/pagamenti/causale.ts`, che è importato da
 * `src/components/features/admin/pagamenti/CausaliPanel.tsx` (riga 14), e quel
 * file è `'use client'`. Tutto ciò che entra in questa catena entra nel bundle
 * del browser: un `node:crypto` qui — anche solo per una `createHash` che
 * sembrerebbe più "seria" di una moltiplicazione — romperebbe la build della
 * pagina, e il difetto non lo vede `vitest`, salta fuori solo a `next build`.
 * È la stessa porta che il lock `coordinate-bonifico-un-motore-solo` tiene
 * chiusa per `fiscale.ts`. Qui la si chiude prima: zero import, nessuna
 * dipendenza da chiudere fuori.
 *
 * Conseguenza pratica di quel vincolo: niente `TextEncoder` e niente letterali
 * BigInt. I byte da mescolare se li produce la funzione (UTF-16LE, i due byte di
 * ogni code unit), e i BigInt nascono da `BigInt('…')` perché il `target` del
 * `tsconfig.json` è **ES2017** e un letterale `20n` è un errore di compilazione
 * (TS2737) prima ancora di essere una scelta.
 *
 * ─── IL CODICE È UN INDICE, NON UN'AUTORIZZAZIONE ───────────────────────────
 * Non protegge niente e non deve proteggere niente: chi ne inventa uno a caso
 * non ottiene nulla. Il denaro è già arrivato dove è arrivato (il bonifico è un
 * fatto della banca, non di questo software), e il risolutore che legge il
 * codice resta comunque vincolato alla sede e alla famiglia del movimento: un
 * codice valido ma estraneo non apre nessuna porta, non sposta nessun saldo, non
 * fa vedere nessun dato.
 *
 * Quindi — ed è scritto qui apposta per il lettore di fra sei mesi — **nessuno
 * lo "rinforzi" con un hash crittografico**. Sostituire questa mescola con
 * SHA-256 non aggiungerebbe una sicurezza che qui non serve, e cambierebbe TUTTI
 * i codici già stampati nelle causali, nei solleciti già spediti e nei bonifici
 * già partiti: un intero parco di codici in circolazione diventerebbe muto nello
 * stesso istante. Se un giorno il formato deve davvero cambiare, si cambia il
 * `SEME_CODICE_VOCE` a `:v2` **e si tiene vivo il riconoscimento del v1**.
 *
 * ─── IL CODICE SEGUE LA VOCE, NON IL SUO CONTENUTO ──────────────────────────
 * Dipende solo dall'`id` della riga di pagamento. Correggere importo,
 * descrizione o scadenza NON lo cambia: un sollecito spedito a luglio resta
 * abbinabile a ottobre anche dopo una rettifica dell'importo, ed è proprio il
 * caso che si voleva coprire. Cancellare la voce e ricrearla invece lo cambia —
 * ed è giusto: quella è un'altra voce, e il vecchio codice deve smettere di
 * valere insieme alla riga che nominava.
 */

/**
 * L'ALFABETO, COSTRUITO PER SOTTRAZIONE. Ogni assenza ha un motivo, e si legge
 * dal fondo: 36 simboli alfanumerici, meno quelli che creano un problema a chi
 * legge il codice su un foglio o lo detta al telefono.
 *
 *  · fuori le VOCALI `A E I O U`: senza vocali un codice di sette caratteri non
 *    può formare una parola italiana — né, soprattutto, una volgare. È l'unica
 *    difesa davvero efficace contro il codice imbarazzante stampato su una
 *    comunicazione alle famiglie, e costa meno di una lista di parole proibite
 *    (che andrebbe mantenuta, e che sbaglierebbe comunque);
 *  · fuori `0` e `1` e i loro SOSIA `O I L J Q D`: `0/O/D/Q` e `1/I/L/J` sono le
 *    due famiglie che si confondono in stampa e a mano;
 *  · fuori `B S Z G`, sosia rispettivamente di `8 5 2 6`;
 *  · fuori `W`, che in molti caratteri tipografici si legge `VV`.
 *
 * Restano 8 cifre + 12 consonanti = 20 simboli.
 *
 * ⚠️ RESIDUO NOTO E DICHIARATO: `7` e `T` restano entrambi, e in qualche
 * grafia si assomigliano. Accettato: il canale primario è il copia-incolla
 * (bottone «Copia causale»), e chi detta usa l'alfabeto di compitazione. Toglierne
 * uno porterebbe l'alfabeto a 19 simboli senza togliere il problema vero, che è
 * la dettatura.
 */
export const ALFABETO_CODICE_VOCE = '23456789CFHKMNPRTVXY'

/**
 * Sette simboli. 20^7 = 1.280.000.000 combinazioni lorde; tolti i tutto-lettere
 * (12^7) e i tutto-cifre (8^7) restano **1.242.071.040** codici ammessi.
 * Sei sarebbero 20^6 = **64.000.000** lordi, cioè **60.751.872** ammessi una
 * volta tolti i 12^6 tutto-lettere e gli 8^6 tutto-cifre: troppo pochi per
 * smettere di pensarci. Otto non entrerebbero più in un colpo d'occhio.
 */
export const LUNGHEZZA_CODICE_VOCE = 7

/** Il cancelletto davanti: rende il codice riconoscibile a occhio dentro una causale. */
export const SIGILLO_CODICE_VOCE = '#'

/**
 * Il seme della mescola. Cambiarlo cambia OGNI codice già in circolazione: si
 * tocca solo per un `:v2` deliberato, e insieme al riconoscimento del `:v1`.
 */
export const SEME_CODICE_VOCE = 'kidville:codice-voce:v1'

// ─── La macchina, sotto il cofano ───────────────────────────────────────────

const UNO = BigInt(1)
/** Maschera a 64 bit: BigInt non ha larghezza, l'aritmetica a 64 bit la si impone. */
const M64 = (UNO << BigInt(64)) - UNO
const BASE = BigInt(ALFABETO_CODICE_VOCE.length)
const SPAZIO = BASE ** BigInt(LUNGHEZZA_CODICE_VOCE)

/** FNV-1a a 64 bit: offset basis e primo, quelli canonici. */
const FNV_OFFSET = BigInt('14695981039346656037')
const FNV_PRIMO = BigInt('1099511628211')

/** Le due costanti del finalizzatore splitmix64. */
const SPLITMIX_A = BigInt('0xbf58476d1ce4e5b9')
const SPLITMIX_B = BigInt('0x94d049bb133111eb')

/**
 * Quanti giri prima di arrendersi. Un giro fallisce solo se il codice esce
 * tutto-lettere o tutto-cifre: (12^7 + 8^7) / 20^7 ≈ **2,96%**. Otto giri
 * lasciano una probabilità di resa di ~5,9e-13, cioè mai.
 */
const GIRI_MASSIMI = 8

/**
 * FNV-1a a 64 bit sui pezzi, concatenati. I byte sono UTF-16LE (prima il byte
 * basso, poi l'alto di ogni code unit): un `TextEncoder` sarebbe un'API di
 * piattaforma data per scontata in più, e questo modulo non ne dà per scontata
 * nessuna. Per l'ASCII — cioè per ogni uuid — il byte alto è sempre 0.
 */
function fnv1a64(pezzi: string[]): bigint {
    let h = FNV_OFFSET
    for (const pezzo of pezzi) {
        for (let i = 0; i < pezzo.length; i++) {
            const unita = pezzo.charCodeAt(i)
            h = ((h ^ BigInt(unita & 0xff)) * FNV_PRIMO) & M64
            h = ((h ^ BigInt(unita >>> 8)) * FNV_PRIMO) & M64
        }
    }
    return h
}

/**
 * Finalizzatore splitmix64. Serve, non è decorazione: i bit ALTI di FNV-1a sono
 * pigri (l'ultimo byte mescolato li muove poco), e i simboli più significativi
 * del codice nascono proprio da lì. Senza questo passaggio due uuid che
 * differiscono per l'ultimo carattere producono codici che si somigliano in
 * testa — e il codice lo legge un essere umano, che guarda proprio la testa.
 */
function finalizza(x: bigint): bigint {
    let z = x
    z = ((z ^ (z >> BigInt(30))) * SPLITMIX_A) & M64
    z = ((z ^ (z >> BigInt(27))) * SPLITMIX_B) & M64
    return (z ^ (z >> BigInt(31))) & M64
}

/** La mescola completa per un dato giro. */
function mescola(s: string, giro: number): bigint {
    return finalizza(fnv1a64([SEME_CODICE_VOCE, ':', String(giro), ':', s]))
}

/**
 * Da un numero a 64 bit ai sette simboli, dal più significativo al meno.
 *
 * DISTORSIONE DA MODULO, dichiarata perché non si nasconde un'approssimazione:
 * 2^64 non è un multiplo di 20^7, quindi i primi 2^64 mod 20^7 codici sono
 * leggerissimamente più probabili. L'eccesso relativo è 20^7 / 2^64 ≈ **7e-11**
 * — irrilevante per un indice (non stiamo estraendo una chiave), e comunque
 * misurato invece che ignorato.
 */
function simboli(n: bigint): string {
    let resto = n % SPAZIO
    let peso = SPAZIO / BASE
    let codice = ''
    for (let i = 0; i < LUNGHEZZA_CODICE_VOCE; i++) {
        codice += ALFABETO_CODICE_VOCE[Number(resto / peso)]
        resto %= peso
        peso /= BASE
    }
    return codice
}

/**
 * Almeno una cifra E almeno una lettera. NON è una regola estetica, ed è il
 * perno di tutto il modulo:
 *  · rende sicura l'estrazione della forma NUDA (senza sigillo), perché toglie
 *    di mezzo i riferimenti di sole cifre — `2345678` è composto per intero di
 *    simboli dell'alfabeto, ed è esattamente il caso che questo vincolo respinge;
 *  · e rende NON estraibile l'esempio mostrato a schermo, se lo si sceglie
 *    apposta di sole lettere.
 * Costa ~3% di giri in più (vedi `GIRI_MASSIMI`), ed è il prezzo più conveniente
 * pagato in questo file.
 */
function misto(codice: string): boolean {
    let cifra = false
    let lettera = false
    for (const ch of codice) {
        if (ch >= '0' && ch <= '9') cifra = true
        else lettera = true
    }
    return cifra && lettera
}

/**
 * IL CODICE DI UNA VOCE, in forma canonica col sigillo: `#K7MXN3P`.
 *
 * Deterministico e senza stato: stesso `id` → stesso codice, per sempre, su
 * server e su browser (è il motivo dello zero-import qui sopra).
 *
 * Restituisce `''` — mai un codice malformato — per un id assente, vuoto o di
 * soli spazi. Il `typeof` è la difesa gemella di quella su `template` in
 * `renderCausale` (`causale.ts`): la firma dice `string`, ma questo valore
 * arriva da una riga di database passata attraverso una rotta, e un `.trim()` su
 * `null` sarebbe un 500 sull'intera lista pagamenti del genitore.
 */
export function codiceVoce(pagamentoId: string): string {
    const id = typeof pagamentoId === 'string' ? pagamentoId.trim().toLowerCase() : ''
    if (!id) return ''
    for (let giro = 0; giro < GIRI_MASSIMI; giro++) {
        const codice = simboli(mescola(id, giro))
        if (misto(codice)) return SIGILLO_CODICE_VOCE + codice
    }
    // Irraggiungibile in pratica (~5,9e-13). Se mai accadesse: nessun codice è
    // meglio di un codice tutto-cifre, che l'estrattore scarterebbe comunque.
    return ''
}

/**
 * Le regex sono COSTRUITE dalle costanti esportate, non riscritte a mano: una
 * seconda copia dell'alfabeto è una copia che un giorno diverge, e il lock
 * `__tests__/architecture/codice-voce-congelato.test.ts` vieta che la stringa
 * dell'alfabeto compaia altrove in `src/`.
 *
 * ⚠️ NIENTE LOOKBEHIND, di proposito. `(?<![0-9A-Z#])` direbbe la stessa cosa in
 * modo più breve, ma è una funzione di RUNTIME che nessun transpilatore può
 * riscrivere, e questo modulo gira anche dentro la WebView di Capacitor su
 * telefoni che non si aggiornano (il `target` del `tsconfig.json` è ES2017, e
 * quella conservazione va rispettata anche qui). Il delimitatore iniziale si
 * CONSUMA e si scala l'indice: il comportamento dichiarato è identico, e le
 * sovrapposizioni non si perdono perché un match non consuma mai il
 * delimitatore FINALE (quello resta un lookahead).
 */
const CLASSE = `[${ALFABETO_CODICE_VOCE}]{${LUNGHEZZA_CODICE_VOCE}}`
/** Col sigillo: `#K7MXN3P`, `##K7MXN3P`, `# K7MXN3P`. */
const RE_SIGILLO = new RegExp(`${SIGILLO_CODICE_VOCE}+\\s*(${CLASSE})(?![0-9A-Z])`, 'g')
/** Nuda: il codice senza sigillo, purché non sia una finestra ritagliata da un run più lungo. */
const RE_NUDA = new RegExp(`(^|[^0-9A-Z${SIGILLO_CODICE_VOCE}])(${CLASSE})(?![0-9A-Z])`, 'g')

/**
 * ESTRAE I CODICI VOCE DISTINTI da un testo (causale + controparte di un
 * movimento). Gemella di `estraiCodiciFiscali` in `./riconciliazione`: stessa
 * forma, stessa disciplina, e la stessa variante SENZA SPAZI, perché gli export
 * bancari spezzano i token («#K7M XN3P», «# K7MXN3P»).
 *
 * Restituisce sempre la forma canonica `#CODICE`, distinta, nell'ordine di prima
 * apparizione **nel testo di partenza** — non nell'ordine in cui le due varianti
 * e le due passate incontrano i candidati. La differenza non è accademica: un
 * codice spezzato dall'export bancario si recupera SOLO dalla variante senza
 * spazi, e accodare quella variante alla prima lo farebbe uscire per ultimo anche
 * quando nel testo viene per primo. Perciò la variante compressa porta con sé la
 * mappa delle posizioni originali, e i candidati delle due varianti si ordinano
 * una volta sola sullo stesso asse (vedi `estraiCodiciVoce`).
 *
 * La forma NUDA è sicura per due motivi che si reggono a vicenda: nessuna parola
 * italiana di sette lettere esiste senza vocali (l'alfabeto non ne ha), e il
 * vincolo lettera+cifra uccide i riferimenti puramente numerici. I delimitatori
 * ai due lati impediscono di ritagliare una finestra da 7 dentro un TRN bancario
 * da 16 caratteri: un codice è un token intero, o non è.
 *
 * ⚠️ LIMITE DICHIARATO, identico a quello della gemella: la variante senza
 * spazi incolla TUTTO, quindi un codice spezzato recupera solo se ciò che lo
 * segue è punteggiatura o fine testo. «CAUSALE: #K7M XN3P.» torna agganciabile,
 * «RETTA #K7M XN3P GRAZIE» no — lì «GRAZIE» si salda al codice e il delimitatore
 * finale non c'è più. Si potrebbe ricucire solo il gruppo dopo il sigillo, ma
 * sarebbe una terza regola che diverge dalla gemella al primo ritocco, per
 * recuperare un caso che il copia-incolla non produce.
 *
 * ⚠️ NESSUNA CORREZIONE DEGLI ERRORI DI BATTITURA, e nessun carattere di
 * controllo che la renderebbe possibile. Un codice sbagliato di un carattere non
 * si "aggiusta": aggiustarlo vorrebbe dire indovinare quale voce intendesse il
 * genitore e incassare su quella. Questo repository non indovina — un movimento
 * senza codice riconosciuto resta semplicemente da abbinare a mano, che è il
 * comportamento di oggi e non fa danni.
 */
export function estraiCodiciVoce(testo: string): string[] {
    if (typeof testo !== 'string' || !testo) return []
    const su = testo.toUpperCase()

    // La variante SENZA SPAZI si costruisce carattere per carattere insieme alla
    // mappa delle posizioni di partenza, invece che con un `replace`. Un
    // `su.replace(/\s+/g, '')` darebbe la stessa stringa ma butterebbe via DOVE
    // stava ogni carattere, e senza quel dove un codice recuperato solo da qui non
    // sa dichiarare la propria posizione nel testo: finirebbe in coda anche quando
    // nel testo viene per primo. È precisamente il caso del bonifico composito
    // letto da un export che spezza i token.
    const compressa: string[] = []
    const origine: number[] = []
    for (let i = 0; i < su.length; i++) {
        if (!/\s/.test(su[i])) {
            compressa.push(su[i])
            origine.push(i)
        }
    }

    /** `pos` riporta un indice della variante all'indice nel testo di partenza. */
    const varianti: { testo: string; pos: (i: number) => number }[] = [
        { testo: su, pos: (i) => i },
        { testo: compressa.join(''), pos: (i) => origine[i] },
    ]

    // UN SOLO array per DUE varianti × DUE passate, e UN SOLO ordinamento, sul
    // solo asse che il chiamante conosce: l'indice nel testo che ci ha dato.
    // Riordinare dentro ciascuna variante e poi accodarle sarebbe un ordine
    // parziale spacciato per totale — la forma di promessa scritta e non
    // mantenuta che questo repository paga più cara.
    const candidati: { indice: number; codice: string }[] = []
    for (const variante of varianti) {
        for (const m of variante.testo.matchAll(RE_SIGILLO)) {
            candidati.push({ indice: variante.pos(m.index ?? 0), codice: m[1] })
        }
        for (const m of variante.testo.matchAll(RE_NUDA)) {
            // `m[1]` è il delimitatore iniziale, consumato al posto del lookbehind:
            // il codice comincia subito dopo.
            candidati.push({ indice: variante.pos((m.index ?? 0) + m[1].length), codice: m[2] })
        }
    }
    candidati.sort((a, b) => a.indice - b.indice)

    const trovati = new Set<string>()
    for (const c of candidati) {
        if (misto(c.codice)) trovati.add(SIGILLO_CODICE_VOCE + c.codice)
    }
    return [...trovati]
}
