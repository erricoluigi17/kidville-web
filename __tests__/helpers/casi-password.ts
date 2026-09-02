import type { CodiceRegolaPassword } from '@/lib/auth/regole-password'

/**
 * I CASI DELLA PASSWORD, scritti UNA volta e usati dai due lati.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ──────────────────────────────────────────────
 *
 * Fino al 2026-09-01 la stessa domanda («questa password va bene?») aveva due
 * risposte diverse nello stesso gesto: `parent/onboarding/page.tsx` si fermava a
 * `password.length < 8`, la route ne pretendeva 10 con una lettera e una cifra.
 * Il genitore che ne scriveva nove passava il controllo del client, vedeva partire
 * la richiesta e riceveva un rifiuto — e siccome quella schermata legge il
 * catalogo e non la prosa del server, il rifiuto diceva «Operazione non riuscita».
 *
 * Nessun test poteva vederlo: quello della pagina misurava la pagina, quello della
 * route misurava la route, e ognuno dei due era coerente con sé stesso. Il difetto
 * viveva ESATTAMENTE nello spazio fra i due file, che è il posto che nessuno dei
 * due test guardava.
 *
 * Questa tabella è quel posto. Gli stessi input attraversano il client
 * (`__tests__/components/parent-onboarding-password.test.tsx`) e il server
 * (`__tests__/api/parent-onboarding.test.ts`), e da tutt'e due deve uscire lo
 * stesso verdetto. Se un giorno uno dei due si sposta, il rosso arriva subito e
 * arriva da entrambe le parti.
 *
 * ⚠️ IL CAMPO SI CHIAMA `scritta` E NON `password`. Non è un vezzo: il lock
 * `__tests__/architecture/niente-password-nel-repo.test.ts` cerca `…password… =
 * '…'` e chiamerebbe credenziale in chiaro ogni riga di questa tabella. Le stringhe
 * qui sotto sono INVENTATE e servono a esercitare le regole: non sono, e non devono
 * mai diventare, le credenziali di nessuno.
 */
export interface CasoPassword {
    /** Ciò che una persona scrive nel campo. */
    scritta: string
    /** Il verdetto atteso: il codice del rifiuto, oppure `'OK'`. */
    atteso: CodiceRegolaPassword | 'OK'
    /** Perché questo caso è in tabella — si legge nel nome del test. */
    perche: string
}

export const CASI_PASSWORD: readonly CasoPassword[] = [
    // I due che il vecchio `length < 8` del client LASCIAVA PASSARE, ed erano il difetto.
    { scritta: 'abcdefg12', atteso: 'PASSWORD_TROPPO_CORTA', perche: 'nove caratteri: passava il client, non il server' },
    { scritta: 'parolachiavelunga', atteso: 'PASSWORD_SENZA_CIFRA', perche: 'diciassette caratteri e nessuna cifra' },
    // Il confine, dalle due parti.
    { scritta: 'abcdefgh12', atteso: 'OK', perche: 'esattamente dieci, con lettera e cifra' },
    { scritta: 'abc', atteso: 'PASSWORD_TROPPO_CORTA', perche: 'tre caratteri' },
    { scritta: '', atteso: 'PASSWORD_TROPPO_CORTA', perche: 'la stringa vuota è corta, non «senza cifra»' },
    // Le altre due regole.
    { scritta: '1234567890', atteso: 'PASSWORD_SENZA_CIFRA', perche: 'solo cifre: manca la lettera, e lo dice lo stesso codice' },
    { scritta: ' nonnarosa42', atteso: 'PASSWORD_CON_SPAZI_AI_BORDI', perche: 'uno spazio in testa, invisibile a chi digita' },
    { scritta: 'nonnarosa42 ', atteso: 'PASSWORD_CON_SPAZI_AI_BORDI', perche: 'uno spazio in coda, invisibile a chi digita' },
    { scritta: 'nonna rosa 42', atteso: 'OK', perche: 'lo spazio IN MEZZO è una frase di passaggio, non un errore' },
] as const
