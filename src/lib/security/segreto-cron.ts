import { timingSafeEqual } from 'crypto';

/**
 * Il segreto con cui i lavori pianificati bussano alle proprie route.
 *
 * ─── PERCHÉ ESISTE QUESTA FUNZIONE ──────────────────────────────────────────
 *
 * Il confronto era scritto sette volte, sempre così:
 * `secret !== process.env.CRON_SECRET`. Due cose insieme:
 *
 *  1. era l'UNICA credenziale del repo confrontata senza tempo costante — il
 *     sigillo degli allegati (`lib/allegati/sigillo.ts`) e i ticket OTP
 *     (`lib/auth/otp-ticket.ts`) usano entrambi `timingSafeEqual`. Onestà sulla
 *     gravità: contro un segreto casuale, su HTTP, attraverso la rete e un
 *     runtime serverless, un attacco a tempo non è praticabile. Non si chiude
 *     per l'attacco: si chiude perché una regola con un'eccezione non dichiarata
 *     non è una regola, ed è la firma di difetto che questo progetto paga da
 *     tre cicli.
 *
 *  2. era scritto SETTE VOLTE. La proprietà che conta davvero qui non è il tempo
 *     costante, è il FAIL-CLOSED: senza `CRON_SECRET` configurato nessuna
 *     chiamata deve passare. Il `!==` ce l'aveva per caso (`undefined !== ''` è
 *     vero) — e bastava una variabile presente ma VUOTA, che è il modo in cui una
 *     configurazione sbagliata si presenta più spesso, perché una richiesta con
 *     header vuoto entrasse. Sette copie sono sette occasioni di sbagliarlo in
 *     una sola.
 *
 * Non logga: il livello e il messaggio della negazione sono decisioni della
 * route (i cron distinguono «segreto errato» da «segreto non configurato», e
 * quello è un incidente di livello `error`). Qui si risponde a una domanda sola.
 */
export function segretoCronValido(ricevuto: string | null | undefined): boolean {
    const atteso = process.env.CRON_SECRET;
    // Fail-closed: variabile assente o vuota ⇒ nessuno passa. Mai «se non è
    // configurato allora va bene»: sarebbe una porta che si apre proprio
    // nell'ambiente in cui qualcuno ha dimenticato di chiuderla.
    if (!atteso || !ricevuto) return false;

    const a = Buffer.from(ricevuto, 'utf8');
    const b = Buffer.from(atteso, 'utf8');
    // `timingSafeEqual` LANCIA se le lunghezze differiscono: la lunghezza si
    // confronta prima, e sì, quella perde di suo il tempo costante. È inevitabile
    // e noto: la lunghezza di un segreto non è il segreto.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
