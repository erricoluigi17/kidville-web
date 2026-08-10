/**
 * Anagrafica del CESSIONARIO — chi riceve la fattura, qui sempre una persona
 * fisica (il genitore) — e il gate che impedisce di bruciare un numero su di essa.
 *
 * ─── IL DIFETTO CHE QUESTO MODULO CHIUDE ─────────────────────────────────────
 *
 * Sul CEDENTE il controllo c'era ed era fail-closed (`cedenteDaConfig`): o
 * l'anagrafica è completa, o non si compone niente. Sul CESSIONARIO no. L'unica
 * verifica era `reg.fiscal_code` presente; indirizzo, CAP e comune del genitore
 * finivano nell'XML così com'erano — anche vuoti. Misurato con il validatore XSD
 * di questo repo: `residence_address`/`zip_code`/`residence_city` vuoti producono
 * tre violazioni di `pattern` su `Indirizzo`, `CAP` e `Comune`. Il documento è
 * invalido, ma il numero è GIÀ STATO allocato (`prossimo_numero_fattura_sezionale`
 * scrive il contatore prima dell'upload) e l'invio parte lo stesso: numero bruciato
 * più scarto SDI, che si corregge solo con una nota di variazione.
 *
 * ─── LA FORMA DEL CODICE FISCALE, e perché non basta «c'è» ───────────────────
 *
 * Misurato in produzione il 2026-08-10 su `parents` (solo conteggi e maschere, mai
 * valori): 49 righe, 22 con un `fiscal_code` valorizzato, e di quelle **21 non sono
 * codici fiscali**. Venti hanno la forma `XXXX99X99X999X` — quattordici caratteri,
 * quattro lettere iniziali invece di sei — e una ne ha due. Una sola riga su
 * ventidue ha la forma vera `XXXXXX99X99X999X`.
 *
 * Quattordici caratteri alfanumerici superano il `pattern` dello XSD
 * (`[A-Za-z0-9]{11,16}`): il documento sarebbe formalmente valido e verrebbe scartato
 * dallo SdI a valle (00301/00302). Cioè: senza questo controllo, oggi, venti genitori
 * su ventidue farebbero bruciare un numero ciascuno. Non è la «50ª riga» che potrebbe
 * arrivare un domani — è la situazione attuale.
 *
 * ─── L'OMOCODIA, che una regex ingenua respingerebbe ─────────────────────────
 *
 * Nei codici fiscali omocodici l'Agenzia sostituisce le cifre con lettere secondo la
 * tabella `L M N P Q R S T U V` (0→L, 1→M, … 9→V). Un `^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$`
 * — la forma che verrebbe naturale — rifiuterebbe un codice fiscale VERO e legittimo,
 * bloccando l'emissione a una famiglia che non ha nessuna colpa. La classe delle
 * posizioni numeriche qui sotto le ammette entrambe.
 *
 * ─── PERCHÉ È PURO (nessun I/O, nessun log) ──────────────────────────────────
 *
 * Stessa ragione di `@/lib/fatturazione/cedente`: la regola deve poter valere anche
 * per un pannello, e `@/lib/logging/logger` trascina `node:crypto`. Il log lo scrive
 * chi chiama, che ha il contesto (sede, pagamento, quota).
 */

/** L'anagrafica del genitore come la restituisce `resolveParentRegistry`. */
export interface AnagraficaCessionario {
    codice_fiscale?: string | null
    nome?: string | null
    cognome?: string | null
    indirizzo?: string | null
    cap?: string | null
    comune?: string | null
}

/** I campi, nell'ordine in cui vanno nominati a chi deve correggerli. */
export const CAMPI_CESSIONARIO = ['codice_fiscale', 'nome', 'cognome', 'indirizzo', 'cap', 'comune'] as const

export type CampoCessionario = (typeof CAMPI_CESSIONARIO)[number]

/** Perché un campo non va bene: non c'è, oppure c'è ma ha la forma sbagliata. */
export type MotivoCampoCessionario = 'mancante' | 'formato'

export type ErroriCessionario = Partial<Record<CampoCessionario, MotivoCampoCessionario>>

export const ETICHETTE_CAMPO_CESSIONARIO: Record<CampoCessionario, string> = {
    codice_fiscale: 'codice fiscale',
    nome: 'nome',
    cognome: 'cognome',
    indirizzo: 'indirizzo di residenza',
    cap: 'CAP',
    comune: 'comune di residenza',
}

/**
 * Le posizioni «numeriche» di un codice fiscale: cifra oppure la lettera che
 * l'omocodia mette al suo posto (`L M N P Q R S T U V`, cioè 0…9).
 */
const CIFRA_O_OMOCODIA = '[0-9LMNPQRSTUVlmnpqrstuv]'
const RE_CF_PERSONA = new RegExp(
    `^[A-Za-z]{6}${CIFRA_O_OMOCODIA}{2}[A-Za-z]${CIFRA_O_OMOCODIA}{2}[A-Za-z]${CIFRA_O_OMOCODIA}{3}[A-Za-z]$`,
)
/**
 * Un intestatario può essere un ente (11 cifre): raro qui, ma il tracciato lo ammette
 * e rifiutarlo bloccherebbe un caso legittimo per una nostra assunzione.
 */
const RE_CF_ENTE = /^\d{11}$/
const RE_CAP = /^\d{5}$/

function pulisci(v?: string | null): string {
    return typeof v === 'string' ? v.trim() : ''
}

/** Il codice fiscale di un intestatario di fattura ha una forma che lo SdI accetta? */
export function codiceFiscaleIntestatarioValido(cf?: string | null): boolean {
    const c = pulisci(cf).replace(/\s/g, '')
    return RE_CF_PERSONA.test(c) || RE_CF_ENTE.test(c)
}

/**
 * Cosa non va nell'anagrafica dell'intestatario. Vuoto = si può fatturare.
 *
 * OBBLIGATORI tutti e sei: `CodiceFiscale`, `Nome`, `Cognome` e la `Sede`
 * (`Indirizzo`, `CAP`, `Comune`) sono elementi NON facoltativi del tracciato per un
 * cessionario persona fisica. La provincia sì, è facoltativa, e resta fuori: si
 * omette senza conseguenze (`emissione.ts` la legge a parte e la scrive solo se c'è).
 */
export function validaCessionario(a: AnagraficaCessionario): ErroriCessionario {
    const errori: ErroriCessionario = {}
    const cf = pulisci(a.codice_fiscale)
    const nome = pulisci(a.nome)
    const cognome = pulisci(a.cognome)
    const indirizzo = pulisci(a.indirizzo)
    const cap = pulisci(a.cap)
    const comune = pulisci(a.comune)

    if (cf === '') errori.codice_fiscale = 'mancante'
    else if (!codiceFiscaleIntestatarioValido(cf)) errori.codice_fiscale = 'formato'
    if (nome === '') errori.nome = 'mancante'
    if (cognome === '') errori.cognome = 'mancante'
    if (indirizzo === '') errori.indirizzo = 'mancante'
    if (cap === '') errori.cap = 'mancante'
    else if (!RE_CAP.test(cap)) errori.cap = 'formato'
    if (comune === '') errori.comune = 'mancante'

    return errori
}

/** L'anagrafica dell'intestatario è completa e ben formata? */
export function cessionarioCompleto(a: AnagraficaCessionario): boolean {
    return Object.keys(validaCessionario(a)).length === 0
}

/**
 * Il messaggio che la segreteria legge, e che dice DOVE si corregge.
 *
 * `nomeVisibile` è già sotto gli occhi di chi opera (è la riga del pagamento che ha
 * appena cliccato): nel LOG invece non ci va mai — lì entrano solo gli uuid e i
 * booleani, perché quello è un dato personale.
 */
export function messaggioCessionarioIncompleto(errori: ErroriCessionario, nomeVisibile: string): string {
    const campi = CAMPI_CESSIONARIO.filter((c) => errori[c] !== undefined)
    const elenco = campi
        .map((c) => (errori[c] === 'formato' ? `${ETICHETTE_CAMPO_CESSIONARIO[c]} (formato)` : ETICHETTE_CAMPO_CESSIONARIO[c]))
        .join(', ')
    return (
        `Dati fiscali incompleti o non validi per ${nomeVisibile} (${elenco}): ` +
        'completali nell’anagrafica del genitore prima di emettere la fattura. ' +
        'Nessun numero è stato consumato.'
    )
}
