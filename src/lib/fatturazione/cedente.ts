/**
 * Anagrafica del CEDENTE — chi emette la fattura — e sua traduzione nel blocco
 * `CedentePrestatore` del tracciato FatturaPA.
 *
 * ─── IL DIFETTO CHE QUESTO MODULO CHIUDE ─────────────────────────────────────
 *
 * Fino al 2026-08-09 la sede legale si inseriva nel pannello Aruba come UNA
 * STRINGA LIBERA (`aruba_config.fiscal.sede`), mentre chi generava l'XML leggeva
 * `fiscal.cap` e `fiscal.comune` come campi SEPARATI — due chiavi che quel
 * pannello non ha mai scritto. L'XML usciva con `<CAP></CAP><Comune></Comune>` e
 * lo SDI lo scartava (codici 00423 / 00200). Il PRD dichiarava la sede
 * strutturata «consumata dal CedentePrestatore»: non lo era, e nessun test era
 * rosso — perché nessun test partiva dalla CONFIGURAZIONE.
 *
 * ─── LE DUE SCELTE, ed è il punto del file ───────────────────────────────────
 *
 *  · UNA SOLA FONTE: `admin_settings.fiscale_config`, che è già strutturata e già
 *    alimenta ricevute e attestazioni (`datiStruttura`). `aruba_config.fiscal`
 *    resta solo come RIPIEGO per le sedi configurate prima, e la sua stringa
 *    libera `sede` non viene interpretata: da «Via Silvio Pellico 7, 81030 Cesa
 *    (CE)» non si ricava un CAP con certezza, e indovinare qui significa uno
 *    scarto. Due pannelli che scrivono la stessa anagrafica in due posti diversi
 *    sono il difetto, non la comodità.
 *
 *  · FAIL-CLOSED: se manca un campo obbligatorio questa funzione NON restituisce
 *    un cedente a metà — restituisce l'elenco di cosa manca. Una fattura con la
 *    sede vuota non è «quasi giusta»: è un documento che lo SDI rifiuta e un
 *    numero bruciato nel sezionale, che poi va rettificato a mano.
 *
 * ─── PERCHÉ È PURO (nessun I/O, nessun log) ─────────────────────────────────
 *
 * Lo importano DUE mondi: il server che emette la fattura e il PANNELLO CLIENT
 * delle impostazioni, che deve validare gli stessi campi con le stesse regole —
 * una regola valida per due strade vive in un posto solo. `@/lib/logging/logger`
 * qui dentro non può entrare: trascina `node:crypto` e romperebbe il bundle del
 * browser. Il log lo scrive chi chiama, che ha il contesto (sede, pagamento) —
 * la riga esatta da scrivere è documentata su `EsitoCedente`.
 *
 * I due import sono per la stessa ragione, e sono entrambi verso moduli PURI:
 *  · `LIMITI` (`@/lib/aruba/fatturapa-xml`) sono i `maxLength` dello XSD. Fino al
 *    2026-08-10 qui non c'era nessun controllo di lunghezza e il pannello
 *    invitava a scrivere un civico di 10 caratteri su un elemento che il
 *    tracciato tronca a 8: `27/B int.3` usciva `27/B int`, in silenzio. Il
 *    troncamento è l'ultima difesa, non il posto dove si decide: si decide qui.
 *  · `codiceFiscaleIntestatarioValido` (`@/lib/fatturazione/cessionario`) è
 *    l'UNICA definizione di «che forma ha un codice fiscale» in questo repo. Qui
 *    ce n'era una seconda, e rifiutava l'omocodia — cioè rifiutava un codice
 *    fiscale vero: la stessa regola scritta due volte con due esiti diversi, che
 *    è esattamente il difetto che questo modulo dice di chiudere.
 */

import { LIMITI, emailPerTracciato, type CedenteInput } from '@/lib/aruba/fatturapa-xml'
import { codiceFiscaleIntestatarioValido } from '@/lib/fatturazione/cessionario'

/**
 * L'anagrafica del cedente come sta scritta in `admin_settings.fiscale_config`.
 * `FiscaleConfig` (`@/lib/pagamenti/fiscale`) ESTENDE questa interfaccia: le
 * chiavi sono le stesse, i nomi sono quelli del JSONB già in produzione.
 */
export interface AnagraficaCedente {
    denominazione?: string
    piva?: string
    codice_fiscale?: string
    indirizzo?: string
    /** Separato dall'indirizzo: si compone solo al momento di scrivere il tracciato. */
    numero_civico?: string
    cap?: string
    comune?: string
    /** Sigla di 2 lettere (es. `CE`). */
    provincia?: string
    /** Uno dei 19 codici di `REGIMI_FISCALI`. Vuoto ⇒ `RF01` (ordinario). */
    regime_fiscale?: string
    /**
     * La casella della scuola: finisce in `<Contatti><Email>` del
     * `CedentePrestatore` ed è la casella da cui il genitore riceve risposta.
     *
     * FACOLTATIVA come lo è per il tracciato — ma se manca il documento esce
     * DIVERSO da quelli che la segreteria scrive a mano, dove c'è sempre
     * (misurato il 2026-08-10 sui campioni veri). Perciò l'emissione, quando non
     * c'è, scrive un `warn`: una differenza dichiarata è un'altra cosa da una
     * differenza silenziosa.
     */
    email?: string
}

/**
 * Ripiego storico: `aruba_config.fiscal`, così com'era scritto dal vecchio
 * pannello. Serve solo a non perdere ciò che una sede ha già configurato.
 */
export interface FiscalAruba {
    piva?: string
    cf?: string
    ragione_sociale?: string
    indirizzo?: string
    cap?: string
    comune?: string
    provincia?: string
    regime?: string
    /**
     * Sede legale come UNICA stringa libera — la chiave da cui nasce il difetto.
     * Si conserva (è quanto una sede ha scritto), non si interpreta MAI.
     */
    sede?: string
}

/** I campi dell'anagrafica, nell'ordine in cui vanno mostrati e validati. */
export const CAMPI_CEDENTE = [
    'denominazione',
    'piva',
    'codice_fiscale',
    'indirizzo',
    'numero_civico',
    'cap',
    'comune',
    'provincia',
    'regime_fiscale',
    'email',
] as const

export type CampoCedente = (typeof CAMPI_CEDENTE)[number]

/**
 * Perché un campo non va bene: non c'è, ha la forma sbagliata, oppure sta dentro
 * la forma giusta ma è più lungo di quanto il tracciato ammetta (`'lungo'`).
 * `'lungo'` è separato da `'formato'` perché la correzione è diversa e va detta:
 * non «riscrivilo», ma «accorcialo, il massimo è N».
 */
export type MotivoCampo = 'mancante' | 'formato' | 'lungo'

export type ErroriCedente = Partial<Record<CampoCedente, MotivoCampo>>

/**
 * L'esito che `emissione.ts` deve leggere PRIMA di comporre l'XML.
 *
 * Il ramo `ok: false` non porta nessun cedente parziale, di proposito: non deve
 * esistere un modo comodo di spedire lo stesso una fattura senza CAP. Chi lo
 * riceve fa due cose, entrambe obbligatorie:
 *   1. NON emette (la quota fallisce con motivo `non_configurato`, HTTP 503);
 *   2. logga a livello `error` — configurazione mancante è un incidente
 *      (AGENTS.md §4) — con i soli BOOLEANI di `errori` e l'uuid della sede.
 *      Nei campi del log non entrano né P.IVA né denominazione: `redact` la
 *      prima la tratta da segreto e la seconda la hasha, quindi uscirebbero
 *      comunque illeggibili, e non servono a nessuno lì. Il `messaggio` di
 *      questo esito è già scritto per finire in `msg` e sotto gli occhi della
 *      segreteria: dice quali campi mancano e dove si impostano.
 */
export type EsitoCedente =
    | { ok: true; cedente: CedenteInput }
    | { ok: false; mancanti: CampoCedente[]; errori: ErroriCedente; messaggio: string }

/**
 * I regimi fiscali che lo SCHEMA ammette — `RegimeFiscaleType`, `xs:enumeration`
 * chiusa di 19 valori, copiata da `src/lib/aruba/xsd/Schema_VFPR12_v1.2.3.xsd`.
 *
 * ⚠️ **`RF03` NON ESISTE**, e nemmeno `RF00`: l'enumerazione salta dal 02 al 04.
 * Sono proprio i due codici che sceglie chi conta a mano, ed è il motivo per cui
 * qui c'è un ELENCO e non più la regex `/^RF\d{2}$/` che c'era fino al
 * 2026-08-10. Quella regex lasciava passare `RF03`, `RF00` e `RF87`: la
 * configurazione veniva accettata dal pannello, l'emissione allocava un numero
 * sul sezionale (che non si restituisce), componeva l'XML e lo caricava su
 * Aruba — e la notizia dello scarto tornava per PEC giorni dopo, con un
 * progressivo bruciato su un registro fiscale. Il regime è l'unico campo del
 * cedente con un insieme di valori chiuso e noto: era il più facile da chiudere.
 *
 * La prova che questo elenco COINCIDE con lo schema non sta in questo commento:
 * `__tests__/lib/aruba/fatturapa-xsd.test.ts` valida un XML contro lo XSD
 * ufficiale per ciascuno dei 19 codici, e ne rifiuta tre fuori enumerazione.
 */
export const REGIMI_FISCALI = [
    'RF01', 'RF02', 'RF04', 'RF05', 'RF06', 'RF07', 'RF08', 'RF09', 'RF10',
    'RF11', 'RF12', 'RF13', 'RF14', 'RF15', 'RF16', 'RF17', 'RF18', 'RF19', 'RF20',
] as const

const REGIMI_AMMESSI = new Set<string>(REGIMI_FISCALI)

/** Regime ordinario: è quello della cooperativa, e l'unico che vale se il campo è vuoto. */
export const REGIME_FISCALE_DEFAULT = 'RF01'
/** L'unica nazione possibile per questo cedente. Non è configurabile. */
export const NAZIONE_CEDENTE = 'IT'

/**
 * I dati REALI del cedente — sono quelli che compaiono sulle fatture già emesse
 * dalla cooperativa, non un esempio. Servono a due cose: precompilare il pannello
 * delle impostazioni di una sede che non l'ha mai riempito, e dare ai test una
 * configurazione vera su cui misurare l'XML.
 *
 * Sono dati SOCIETARI, pubblici (visura camerale): nessun dato di famiglie o di
 * minori entra in questo file, che sta in un repository pubblico.
 *
 * ⚠️ Precompilare NON è configurare: finché nessuno preme «Salva», in
 * `admin_settings.fiscale_config` non c'è niente e la fattura non parte. Il
 * pannello lo dice esplicitamente.
 */
export const CEDENTE_COOPERATIVA: Required<AnagraficaCedente> = {
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    piva: '03394870616',
    codice_fiscale: '03394870616',
    indirizzo: 'Via Silvio Pellico',
    numero_civico: '7',
    cap: '81030',
    comune: 'Cesa',
    provincia: 'CE',
    regime_fiscale: REGIME_FISCALE_DEFAULT,
    // La casella che compare in `<Contatti><Email>` sulle fatture già emesse:
    // letta il 2026-08-10 dai due campioni scaricati da Aruba, non dedotta. È un
    // recapito ISTITUZIONALE della cooperativa (sta sulla carta intestata e sul
    // sito), non il dato personale di una persona: in un repository pubblico
    // questa differenza è tutta la differenza.
    email: 'scuolamat.lafavola@virgilio.it',
}

/** Etichette per il messaggio d'errore: quello che l'operatore deve andare a cercare. */
export const ETICHETTE_CAMPO_CEDENTE: Record<CampoCedente, string> = {
    denominazione: 'denominazione',
    piva: 'partita IVA',
    codice_fiscale: 'codice fiscale',
    indirizzo: 'indirizzo',
    numero_civico: 'numero civico',
    cap: 'CAP',
    comune: 'comune',
    provincia: 'provincia',
    regime_fiscale: 'regime fiscale',
    email: 'email',
}

const RE_CAP = /^\d{5}$/
const RE_PROVINCIA = /^[A-Za-z]{2}$/
const RE_PIVA = /^\d{11}$/

/**
 * Le lunghezze massime dei campi testuali del cedente, prese da `LIMITI` — cioè
 * dallo XSD — e non riscritte qui: due copie dello stesso numero divergono, e
 * quando divergono vince quella che tronca, in silenzio.
 *
 * Gli altri campi non compaiono perché la loro lunghezza è già imposta dalla
 * forma (`cap` 5, `provincia` 2, `piva` 11, `regime_fiscale` 4, codice fiscale
 * 11 o 16).
 */
export const LUNGHEZZE_CEDENTE: Partial<Record<CampoCedente, number>> = {
    denominazione: LIMITI.denominazione,
    indirizzo: LIMITI.indirizzo,
    numero_civico: LIMITI.numeroCivico,
    comune: LIMITI.comune,
    email: LIMITI.email,
}

/**
 * Via gli spazi, ovunque siano. Una P.IVA o un codice fiscale incollati da un
 * gestionale arrivano spesso a gruppi (`RSS MRA 80A01 H501U`): l'operatore ha
 * scritto un dato giusto, e rifiutarglielo è un difetto nostro. Ma il valore
 * ripulito deve essere anche quello che finisce nel tracciato, altrimenti si
 * valida una stringa e se ne spedisce un'altra — ci pensa `cedenteDaConfig`.
 */
function senzaSpazi(v: string): string {
    return v.replace(/\s+/g, '')
}

/**
 * La P.IVA è di 11 cifre **e il carattere di controllo torna** (algoritmo di
 * Luhn sulle prime dieci, come lo verifica lo SdI).
 *
 * Undici cifre qualsiasi non bastano: `03394870615` — la P.IVA vera con l'ultima
 * cifra sbagliata — passa la lunghezza, passa lo XSD, fa allocare un numero sul
 * sezionale (che non si restituisce) e torna indietro come scarto 00305
 * giorni dopo, per PEC. Il controllo costa dieci moltiplicazioni e si fa PRIMA.
 */
export function partitaIvaValida(piva?: string | null): boolean {
    const p = senzaSpazi(pulisci(piva))
    if (!RE_PIVA.test(p)) return false
    let somma = 0
    for (let i = 0; i < 10; i++) {
        const cifra = p.charCodeAt(i) - 48
        if (i % 2 === 0) somma += cifra
        else somma += cifra * 2 > 9 ? cifra * 2 - 9 : cifra * 2
    }
    return (10 - (somma % 10)) % 10 === p.charCodeAt(10) - 48
}

/**
 * Il regime scritto a mano è uno dei 19 dello schema? Il confronto è in
 * MAIUSCOLO perché nel tracciato ci finisce in maiuscolo (vedi `cedenteDaConfig`):
 * `rf01` è lo stesso regime scritto con lo Shift alzato, non un errore da
 * segnalare all'operatore.
 */
function regimeAmmesso(regime: string): boolean {
    return REGIMI_AMMESSI.has(regime.toUpperCase())
}

/** Stringa ripulita: mai `undefined`, mai spazi ai bordi. */
function pulisci(v?: string | null): string {
    return typeof v === 'string' ? v.trim() : ''
}

/**
 * Il primo valore davvero presente. Serve `||` sul risultato PULITO e non `??`:
 * una chiave salvata come stringa vuota (`cap: ''`) è "non configurata" tanto
 * quanto una chiave assente, e con `??` avrebbe azzerato il ripiego invece di
 * cederglielo.
 */
export function primoNonVuoto(...valori: (string | null | undefined)[]): string {
    for (const v of valori) {
        const s = pulisci(v)
        if (s !== '') return s
    }
    return ''
}

/**
 * Indirizzo e numero civico stanno separati nella configurazione e uniti nel
 * documento: `<Indirizzo>` del tracciato è un campo solo, e le ricevute stampano
 * una riga sola. Regola unica per fattura, ricevuta e attestazione — `datiStruttura`
 * chiama proprio questa funzione.
 */
export function componiIndirizzo(indirizzo?: string | null, numeroCivico?: string | null): string {
    return [pulisci(indirizzo), pulisci(numeroCivico)].filter((p) => p !== '').join(' ')
}

/**
 * Cosa non va nell'anagrafica, campo per campo. Vuoto = si può fatturare.
 *
 * OBBLIGATORI: denominazione, P.IVA, indirizzo, CAP, comune, provincia. La
 * PROVINCIA è fra questi anche se lo schema FatturaPA la dichiara facoltativa:
 * la nazione qui è sempre `IT`, per un indirizzo italiano va valorizzata, e
 * l'unico modo di scoprire che manca sarebbe leggerlo in una notifica di scarto.
 * FACOLTATIVI: numero civico (molti indirizzi non ne hanno), codice fiscale e
 * email — che però, se ci sono, devono avere una forma valida. Il regime fiscale vuoto vale
 * `RF01`, quindi non manca mai: si controlla solo che ciò che è scritto sia uno
 * dei 19 codici dell'enumerazione (`REGIMI_FISCALI`) — non «una lettera R, una F
 * e due cifre», che lasciava passare l'inesistente `RF03`.
 *
 * LE LUNGHEZZE si controllano qui e non solo nel generatore dell'XML: là c'è un
 * `.slice()` che taglia senza dirlo, e un indirizzo tagliato produce una fattura
 * formalmente valida spedita a una sede che non esiste. Chi decide di accorciare
 * la ragione sociale della cooperativa è una persona, non uno `slice`.
 */
export function validaCedente(a: AnagraficaCedente): ErroriCedente {
    const errori: ErroriCedente = {}
    const denominazione = pulisci(a.denominazione)
    const piva = pulisci(a.piva)
    const cf = pulisci(a.codice_fiscale)
    const indirizzo = pulisci(a.indirizzo)
    const numeroCivico = pulisci(a.numero_civico)
    const cap = pulisci(a.cap)
    const comune = pulisci(a.comune)
    const provincia = pulisci(a.provincia)
    const regime = pulisci(a.regime_fiscale)
    const email = pulisci(a.email)

    if (denominazione === '') errori.denominazione = 'mancante'
    if (piva === '') errori.piva = 'mancante'
    else if (!partitaIvaValida(piva)) errori.piva = 'formato'
    // Stessa identica regola dell'intestatario: forma classica, omocodia
    // ammessa (le cifre sostituite da `L M N P Q R S T U V` sono un codice
    // fiscale VERO) e undici cifre per un ente. Una seconda definizione qui
    // vorrebbe dire due risposte diverse alla stessa domanda.
    if (cf !== '' && !codiceFiscaleIntestatarioValido(cf)) errori.codice_fiscale = 'formato'
    if (indirizzo === '') errori.indirizzo = 'mancante'
    if (cap === '') errori.cap = 'mancante'
    else if (!RE_CAP.test(cap)) errori.cap = 'formato'
    if (comune === '') errori.comune = 'mancante'
    if (provincia === '') errori.provincia = 'mancante'
    else if (!RE_PROVINCIA.test(provincia)) errori.provincia = 'formato'
    if (regime !== '' && !regimeAmmesso(regime)) errori.regime_fiscale = 'formato'
    // L'email è FACOLTATIVA (lo è per il tracciato), ma se c'è dev'essere
    // scrivibile in `<Contatti><Email>`: la forma la decide `emailPerTracciato`,
    // che è la stessa funzione che poi la scrive: qui non ne nasce una seconda.
    // Un indirizzo che non passa non viene «omesso in silenzio» dal generatore,
    // perché il silenzio è il difetto: l'operatore lo vede rosso nel pannello e
    // l'emissione non parte finché non lo corregge o non lo cancella.
    if (email !== '' && email.length <= LIMITI.email && emailPerTracciato(email) === null)
        errori.email = 'formato'

    // Il troppo lungo si segnala solo su ciò che è già presente e ben formato:
    // dire «manca» e «è lungo» dello stesso campo confonderebbe la correzione.
    const valori: Partial<Record<CampoCedente, string>> = {
        denominazione, indirizzo, numero_civico: numeroCivico, comune, email,
    }
    for (const campo of CAMPI_CEDENTE) {
        const max = LUNGHEZZE_CEDENTE[campo]
        const valore = valori[campo]
        if (max === undefined || valore === undefined) continue
        if (errori[campo] === undefined && valore.length > max) errori[campo] = 'lungo'
    }

    return errori
}

/** L'anagrafica è completa e ben formata? (stessa regola per pannello e server) */
export function cedenteCompleto(a: AnagraficaCedente): boolean {
    return Object.keys(validaCedente(a)).length === 0
}

/**
 * `fiscale_config` (+ ripiego `aruba_config.fiscal`) → `CedentePrestatore`.
 *
 * È la funzione che `emissione.ts` deve chiamare al posto di leggere `fiscal.*`
 * a mano. Restituisce il cedente SOLO se è emettibile; altrimenti dice cosa
 * manca e non lascia comporre niente.
 */
export function cedenteDaConfig(
    fiscale?: AnagraficaCedente | null,
    arubaFiscal?: FiscalAruba | null,
): EsitoCedente {
    const f = fiscale ?? {}
    const a = arubaFiscal ?? {}

    const unione: AnagraficaCedente = {
        denominazione: primoNonVuoto(f.denominazione, a.ragione_sociale),
        // P.IVA e codice fiscale SENZA spazi anche nel documento, non solo nella
        // validazione: `codiceFiscaleIntestatarioValido` accetta
        // «RSS MRA 80A01 H501U» perché è un dato giusto scritto a gruppi, ma
        // `<CodiceFiscale>` con dentro degli spazi è uno scarto. Validare una
        // stringa e spedirne un'altra è il modo più silenzioso di sbagliare.
        piva: senzaSpazi(primoNonVuoto(f.piva, a.piva)),
        codice_fiscale: senzaSpazi(primoNonVuoto(f.codice_fiscale, a.cf)),
        indirizzo: primoNonVuoto(f.indirizzo, a.indirizzo),
        numero_civico: primoNonVuoto(f.numero_civico),
        cap: primoNonVuoto(f.cap, a.cap),
        comune: primoNonVuoto(f.comune, a.comune),
        provincia: primoNonVuoto(f.provincia, a.provincia).toUpperCase(),
        // In maiuscolo come la provincia: l'enumerazione dello schema è
        // `RF01`…`RF20`, e un `rf01` scritto minuscolo è lo stesso regime, non un
        // documento da far scartare.
        regime_fiscale: primoNonVuoto(f.regime_fiscale, a.regime, REGIME_FISCALE_DEFAULT).toUpperCase(),
        // Nessun ripiego su `aruba_config.fiscal`: quel pannello non ha mai
        // raccolto un'email, e inventarle una fonte che non esiste è il modo di
        // scoprire fra sei mesi che si leggeva sempre `undefined`.
        email: primoNonVuoto(f.email),
    }

    const errori = validaCedente(unione)
    const mancanti = CAMPI_CEDENTE.filter((c) => errori[c] !== undefined)
    if (mancanti.length > 0) {
        // Il motivo sta accanto al campo, come per il cessionario: «indirizzo» e
        // «indirizzo (troppo lungo)» si correggono in due modi diversi, e chi
        // legge il messaggio è chi deve correggere.
        const suffisso: Record<MotivoCampo, string> = {
            mancante: '',
            formato: ' (formato)',
            lungo: ' (troppo lungo)',
        }
        const elenco = mancanti
            .map((c) => `${ETICHETTE_CAMPO_CEDENTE[c]}${suffisso[errori[c] as MotivoCampo]}`)
            .join(', ')
        return {
            ok: false,
            mancanti: [...mancanti],
            errori,
            messaggio:
                `Dati del cedente incompleti o non validi (${elenco}): ` +
                'impostali in Impostazioni → Pagamenti → Dati fiscali prima di emettere la fattura.',
        }
    }

    return {
        ok: true,
        cedente: {
            piva: unione.piva as string,
            // Assente ⇒ tag omesso dal tracciato: si omette ciò che manca, non si inventa.
            codiceFiscale: unione.codice_fiscale || undefined,
            denominazione: unione.denominazione as string,
            regimeFiscale: unione.regime_fiscale as string,
            // Assente ⇒ `<Contatti>` omesso: si omette ciò che manca. Che il
            // documento esca allora DIVERSO da quelli scritti a mano lo dice
            // l'emissione con una riga di log, non questo modulo, che è puro.
            email: unione.email || undefined,
            sede: {
                // Via e civico restano SEPARATI fino all'XML, come per il
                // cessionario: `<NumeroCivico>` è un elemento del tracciato
                // (IndirizzoType, fra `Indirizzo` e `CAP`), non un dettaglio di
                // scrittura. Fino al 2026-08-10 qui si incollavano in una riga
                // sola con `componiIndirizzo` — un commento del test diceva
                // perfino che il tracciato «ha <Indirizzo>, non <NumeroCivico>»,
                // ed era falso: lo scrive `sedeXml`, e per il cessionario lo
                // scriveva già. Due regole per lo stesso indirizzo, con in più il
                // rischio che il civico cadesse nel troncamento a 60 caratteri
                // dell'indirizzo. Le RICEVUTE continuano a stampare una riga sola:
                // quella composizione vive in `componiIndirizzo`, che è la regola
                // unica di `datiStruttura`.
                indirizzo: unione.indirizzo as string,
                numeroCivico: unione.numero_civico || undefined,
                cap: unione.cap as string,
                comune: unione.comune as string,
                provincia: unione.provincia,
                nazione: NAZIONE_CEDENTE,
            },
        },
    }
}
