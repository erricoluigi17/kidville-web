import { randomInt } from 'crypto'

// =============================================================================
// LA PASSWORD TEMPORANEA — e perché non è più `randomBytes(18).toString('base64url')`.
//
// MISURA DEL 2026-08-22. Il cron delle iscrizioni ha creato 67 account genitore e
// spedito 67 password del vecchio formato. 37 famiglie sono entrate (metodo
// `password`, misurato su `auth.mfa_amr_claims`), 30 no, e alcune hanno telefonato
// in segreteria dicendo che «le credenziali non funzionano». Nessuna password era
// stata ruotata dopo l'invio: quelle che le 30 famiglie avevano in mano erano, e
// sono tuttora, esattamente quelle scritte su GoTrue. Il difetto non era nel valore.
// Era nel viaggio dal messaggio al campo di accesso.
//
// Il vecchio formato produceva 28 caratteri così:
//
//     randomBytes(18).toString('base64url') + 'Aa1!'     →  xK7-mQ_9lI0OZa...Aa1!
//
// e portava dentro tre difetti, tutti sul lato umano:
//
//  · `l` `I` `1` e `O` `0` sono indistinguibili nel monospaziato di un'email letta
//    su un telefono. Chi la digita sbaglia; chi la detta a un nonno non ce la fa.
//  · `base64url` mescola maiuscole e minuscole senza struttura: 28 caratteri senza
//    un appiglio, impossibili da tenere a mente anche solo il tempo di trascriverli.
//  · il suffisso `Aa1!` non portava entropia — è scritto qui nel repo, lo conosce
//    chiunque — e serviva solo a soddisfare la policy di GoTrue appiccicandole
//    quattro caratteri in coda, fra cui un `!` da cercare sulla terza tastiera di
//    un telefono.
//
// IL FORMATO NUOVO — `Xxxx-xxxx-xxxx-xxxx`, 19 caratteri:
//
//  · alfabeto CROCKFORD BASE32 in minuscolo (`0-9` più le lettere senza `i l o u`):
//    non è un alfabeto inventato qui, è progettato per la trascrizione umana, e
//    l'esclusione di quelle quattro lettere è già motivata da chi l'ha disegnato.
//    32 simboli = 5 bit esatti per carattere, quindi il conto dell'entropia si fa
//    a mente e chiunque può rifarlo.
//  · UNA sola maiuscola, in testa, da un sottoinsieme ancora più prudente
//    (via anche `B`/8, `G`/6, `S`/5, `Z`/2, `Q`/O): una sola perché ogni maiuscola
//    in più è un tocco in più sulla tastiera di un telefono.
//  · i trattini spezzano la lettura in quattro gruppi da quattro — la stessa ragione
//    per cui si scrivono così gli IBAN e i codici delle carte — e il trattino è
//    anche il SIMBOLO che soddisfa la policy più severa di GoTrue. La conformità
//    viene dalla STRUTTURA, non da una costante in coda.
//
// ENTROPIA: log2(17) + 15 × 5 = 4,09 + 75 = ~79 bit. Si scende dai ~144 bit di
// prima, e va detto perché è abbondante lo stesso invece che essere una concessione:
// la password è temporanea, l'hash lato GoTrue è bcrypt, e un attacco online passa
// dal rate limit di GoTrue. Il numero da battere non è 144 ma il minimo difendibile,
// che sta fra 40 e 64 bit. 79 ci sta sopra con margine, e in cambio la password
// arriva viva dall'altra parte — che è l'unica cosa che il 22/08 non è successa.
//
// ⚠️ UN SOLO GENERATORE, PER TUTTI. Chi aggiunge un secondo modo di fare password
// riapre esattamente il difetto che questo file chiude, e lo riapre in silenzio:
// il lock `__tests__/architecture/password-temporanea-un-posto-solo.test.ts` lo
// impedisce. In questo repo è già successo due volte (vedi i commenti in
// `parent-identity.ts` e `staff-identity.ts`).
// =============================================================================

/** Crockford Base32: cifre e lettere, senza `i` `l` `o` `u`. 32 simboli = 5 bit. */
const MINUSCOLE = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * Le maiuscole ammesse in testa. Oltre alle quattro di Crockford togliamo anche
 * `B` `G` `S` `Z` (confondibili con 8 6 5 2 quando qualcuno le detta o le legge di
 * fretta) e `Q` (con `O`). Restano 17: chi legge al telefono non deve mai dover
 * dire «la esse, non il cinque».
 */
const MAIUSCOLE = 'ACDEFHJKMNPRTVWXY'

const GRUPPI = 4
const PER_GRUPPO = 4

/** Un carattere a caso da `alfabeto`. `randomInt` è CSPRNG e rifiuta il bias del modulo. */
function scegli(alfabeto: string): string {
    return alfabeto[randomInt(0, alfabeto.length)]
}

/**
 * La password temporanea da spedire a una famiglia o a una collega.
 *
 * La cifra è garantita per campionamento a rifiuto e non appiccicando una costante:
 * la probabilità che 15 estrazioni da 32 simboli non contengano nessuna cifra è
 * (22/32)^15 ≈ 0,4%, quindi il ciclo gira una volta sola quasi sempre e finisce
 * sempre.
 */
export function passwordTemporanea(): string {
    for (;;) {
        const corpo: string[] = []
        for (let g = 0; g < GRUPPI; g++) {
            let gruppo = ''
            for (let c = 0; c < PER_GRUPPO; c++) {
                // Il primissimo carattere è la maiuscola; tutto il resto è Crockford.
                gruppo += g === 0 && c === 0 ? scegli(MAIUSCOLE) : scegli(MINUSCOLE)
            }
            corpo.push(gruppo)
        }
        const password = corpo.join('-')
        // Policy `letters_digits` di GoTrue: almeno una cifra e almeno una lettera
        // minuscola. Se l'estrazione non le contiene si rifà: mai correggere il
        // risultato a mano, che introdurrebbe una posizione prevedibile.
        if (/[0-9]/.test(password) && /[a-z]/.test(password)) return password
    }
}

/**
 * Il riconoscimento del formato vive in `forma-password.ts` — senza `crypto`, così
 * la schermata di accesso può importarlo — ed è ri-esportato qui perché chi cerca
 * «la password temporanea» trovi entrambe le metà nello stesso posto.
 */
export { classificaFormaPassword, type FormaPassword } from '@/lib/auth/forma-password'
