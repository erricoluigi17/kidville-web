// =============================================================================
// LA FORMA DI UNA PASSWORD — e perché sta in un file suo.
//
// Questo modulo è importato dalla SCHERMATA DI ACCESSO, che è un componente
// client. `password-temporanea.ts` importa `randomInt` da `crypto`: portarlo nel
// browser romperebbe la build, e affidarsi al tree-shaking perché «tanto la
// funzione non la usa nessuno lì» sarebbe una scommessa sul bundler.
//
// Qui dentro non c'è nessun segreto e nessuna generazione: solo il RICONOSCIMENTO
// di un formato, cioè due espressioni regolari e una parola in uscita. È l'unica
// cosa che serve al log dei fallimenti d'accesso, e l'unica che può stare in un
// pacchetto che finisce sul telefono di una famiglia.
// =============================================================================

/** Le tre forme che una password digitata può avere, dal punto di vista di chi la usa. */
export type FormaPassword = 'temporanea' | 'temporanea-legacy' | 'altra'

/** Il formato in vigore dal 2026-08-23: `Xxxx-xxxx-xxxx-xxxx`, alfabeto Crockford. */
const FORMA_NUOVA = /^[ACDEFHJKMNPRTVWXY][0-9a-hjkmnp-tv-z]{3}(-[0-9a-hjkmnp-tv-z]{4}){3}$/

/**
 * Il formato spedito fino al 2026-08-22: 24 caratteri base64url più `Aa1!` in coda.
 *
 * Resta riconosciuto, e non per nostalgia: 67 famiglie ne hanno una in mano, e per
 * mesi qualcuna proverà a usarla. Distinguerla dal formato nuovo è ciò che permette
 * di leggere, nei log, se chi non entra sta usando un invito VECCHIO — cioè se il
 * problema è la password o è che non gli è mai arrivata la seconda email.
 */
const FORMA_LEGACY = /^[A-Za-z0-9_-]{24}Aa1!$/

/**
 * A quale famiglia appartiene la password che qualcuno ha appena digitato.
 *
 * Separa due guasti che a schermo si somigliano e non si curano allo stesso modo:
 * chi sbaglia incollando una password TEMPORANEA sta dicendo «il vostro invito non
 * funziona»; chi sbaglia con una password sua sta dicendo «l'ho dimenticata». Il
 * primo è un difetto nostro, il secondo è il motivo per cui serve un recupero
 * autonomo.
 *
 * Il `trim()` è deliberato: chi incolla male deve comunque risultare «stava usando
 * l'invito», altrimenti il log perderebbe proprio i casi che deve spiegare.
 *
 * Da qui non esce mai la password: esce solo questa etichetta, a vocabolario chiuso.
 */
export function classificaFormaPassword(password: string): FormaPassword {
    const p = password.trim()
    if (FORMA_NUOVA.test(p)) return 'temporanea'
    if (FORMA_LEGACY.test(p)) return 'temporanea-legacy'
    return 'altra'
}
