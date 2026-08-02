import { describe, it, expect } from 'vitest';
import { offriTraduzione, linguaDiLettura } from '@/components/features/chat/ChatMessageArea';

/**
 * IL BOTTONE «TRADUCI» DEVE GUARDARE LA LINGUA SCELTA NELL'APP.
 *
 * Com'era: `navigator.language`, cioè la lingua del SISTEMA OPERATIVO. Una
 * famiglia che ha messo Kidville in inglese ma tiene il telefono in italiano —
 * il caso normale di chi vive in Italia e non parla italiano — non vedeva
 * «Traduci» su un messaggio italiano. Cioè proprio il caso d'uso per cui
 * `src/lib/translate/` esiste.
 *
 * La scelta della lingua dentro l'app è il segnale d'intento più forte che un
 * utente possa dare: più del locale di sistema, che spesso è quello con cui il
 * telefono è uscito dal negozio. `useLocale()` (cookie `KV_LOCALE`) è già letto
 * due righe sopra in questo componente per formattare le date: la lingua giusta
 * era già in mano, si guardava l'altra.
 *
 * La regola vive in una funzione PURA ed esportata, non dentro il render: era
 * duplicata in due punti del file (la decisione di mostrare il bottone e la
 * lingua di destinazione della traduzione), e due copie della stessa regola
 * divergono sempre.
 */
describe('linguaDiLettura — l\'app vince sul sistema operativo', () => {
    it('la lingua scelta nell\'app ha la precedenza', () => {
        expect(linguaDiLettura('en', 'it-IT')).toBe('en');
    });

    it('normalizza il tag: «en-GB» → «en»', () => {
        expect(linguaDiLettura('en-GB', 'it-IT')).toBe('en');
    });

    it('senza locale dell\'app si ripiega sul sistema (SSR, o provider assente)', () => {
        expect(linguaDiLettura(undefined, 'fr-FR')).toBe('fr');
        expect(linguaDiLettura('', 'fr-FR')).toBe('fr');
    });

    it('senza nessuno dei due, italiano: è la lingua del prodotto', () => {
        expect(linguaDiLettura(undefined, undefined)).toBe('it');
    });
});

describe('offriTraduzione — quando ha senso proporre «Traduci»', () => {
    it('app in INGLESE e telefono in ITALIANO: il bottone c\'è (era il caso rotto)', () => {
        expect(offriTraduzione('en', 'it-IT', 'Buongiorno, domani porto il costume.')).toBe(true);
    });

    it('app in italiano e messaggio italiano: niente bottone, non serve a nessuno', () => {
        expect(offriTraduzione('it', 'it-IT', 'Buongiorno, domani porto il costume.')).toBe(false);
    });

    it('app in italiano ma messaggio che NON sembra italiano: il bottone c\'è', () => {
        expect(offriTraduzione('it', 'it-IT', 'Good morning, tomorrow I will bring the swimsuit.')).toBe(true);
    });

    it('messaggio vuoto: niente da tradurre', () => {
        expect(offriTraduzione('en', 'it-IT', '   ')).toBe(false);
        expect(offriTraduzione('en', 'it-IT', null)).toBe(false);
    });
});
