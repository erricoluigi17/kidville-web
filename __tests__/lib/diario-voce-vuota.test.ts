import { describe, it, expect } from 'vitest';
import { bagnoCompilato, contatoreBagno, eEventoBagno } from '@/lib/diary/bagno';
import { pastoCompilato, portateSegnate, eEventoPasto } from '@/lib/diary/pasto';
import { voceDaMostrare, eventoSelettivo, TIPI_SELETTIVI } from '@/lib/diary/registrazione';

/**
 * CHI FINISCE NEL DIARIO DI UN BAMBINO.
 *
 * ─── IL DIFETTO, MISURATO ──────────────────────────────────────────────────
 * «Salva bagno per tutti» scriveva una riga in `eventi_diario` per OGNI bambino
 * presente, anche per chi non era stato toccato: `buildInitialState` mette
 * d'ufficio `{pipi:0, cacca:0, vasino:0}` a tutti. Il genitore la leggeva come
 * un evento vero — «🚿 Sono stato/a al bagno oggi!».
 *
 * Dal 1° settembre 2026: **323 righe di bagno su 514 completamente vuote (63%)**,
 * più 40 pranzi e 26 merende senza nessuna portata → «Ho mangiato con i miei
 * amici!» a chi non ha mangiato.
 *
 * È lo stesso difetto già corretto per la nanna (PR #130). Bagno e pasti erano
 * stati lasciati fuori di proposito, con questa ragione scritta nel codice:
 * «lo stato vuoto È un dato — "segnato: non ha mangiato niente" è diverso da
 * "non l'ho segnato"». Per il BAGNO la premessa è falsa: quello zero è ciò che
 * il codice scrive a tutti, e nessun gesto produce «controllato, niente».
 * Per i PASTI invece è vera, e questi test la difendono.
 */

describe('bagno — lo zero d\'ufficio non è una registrazione', () => {
    it('tutti i contatori a zero: NON compilato (le 323 righe di produzione)', () => {
        expect(bagnoCompilato('bagno', { pipi: 0, cacca: 0, vasino: 0 })).toBe(false);
    });

    it('basta un contatore sopra zero', () => {
        expect(bagnoCompilato('bagno', { pipi: 1, cacca: 0, vasino: 0 })).toBe(true);
        expect(bagnoCompilato('bagno', { cacca: 2 })).toBe(true);
        expect(bagnoCompilato('bagno', { vasino: 1 })).toBe(true);
    });

    it('in JSONB un numero può arrivare come stringa, e va letto', () => {
        expect(bagnoCompilato('bagno', { pipi: '2' })).toBe(true);
        expect(contatoreBagno({ pipi: '2' }, 'pipi')).toBe(2);
    });

    it('spazzatura e negativi valgono zero, non «compilato»', () => {
        expect(bagnoCompilato('bagno', { pipi: 'due' })).toBe(false);
        expect(bagnoCompilato('bagno', { pipi: -1 })).toBe(false);
        expect(bagnoCompilato('bagno', { pipi: null })).toBe(false);
        expect(bagnoCompilato('bagno', {})).toBe(false);
        expect(bagnoCompilato('bagno', null)).toBe(false);
        expect(bagnoCompilato('bagno', undefined)).toBe(false);
    });

    it('fail-closed su un tipo che bagno non è: questo modulo non sa niente di un pranzo', () => {
        expect(bagnoCompilato('pranzo', { pipi: 3 })).toBe(false);
        expect(eEventoBagno('bagno')).toBe(true);
        expect(eEventoBagno('pranzo')).toBe(false);
    });
});

describe('pasto — «niente» È una registrazione, `null` no', () => {
    it('nessuna portata toccata: NON compilato', () => {
        expect(pastoCompilato('pranzo', { corsi: { primo: null, secondo: null, contorno: null, frutta: null } })).toBe(false);
        expect(pastoCompilato('merenda', { corsi: { merenda: null } })).toBe(false);
    });

    it('«niente» vale COMPILATO, ed è la riga che protegge la differenza', () => {
        // `MEAL_QUANTITIES[0]` è {value:'niente'}: la maestra l'ha toccato apposta,
        // e il genitore legge «non ne ho voluto assaggiare». Chi un domani
        // "semplificasse" il filtro in `v && v !== 'niente'` trova questa riga rossa.
        expect(pastoCompilato('pranzo', { corsi: { primo: 'niente' } })).toBe(true);
    });

    it('una portata qualsiasi basta, anche fuori dalle quattro canoniche', () => {
        expect(pastoCompilato('pranzo', { corsi: { primo: 'meta' } })).toBe(true);
        expect(pastoCompilato('pranzo', { corsi: { dolce: 'tutto' } })).toBe(true);
        expect(portateSegnate({ corsi: { primo: 'meta', secondo: null } })).toEqual(['primo']);
    });

    it('forma senza `corsi` (righe storiche): non compilata, e non esplode', () => {
        expect(pastoCompilato('pranzo', { quantita: 'meta' })).toBe(false);
        expect(pastoCompilato('pranzo', null)).toBe(false);
    });

    it('fail-closed fuori dai pasti', () => {
        expect(pastoCompilato('bagno', { corsi: { primo: 'tutto' } })).toBe(false);
        expect(eEventoPasto('merenda')).toBe(true);
        expect(eEventoPasto('nanna_inizio')).toBe(false);
    });
});

describe('voceDaMostrare — il dispatcher, e perché è fail-OPEN', () => {
    it('bagno e pasti vuoti: non si mostrano', () => {
        expect(voceDaMostrare('bagno', { pipi: 0, cacca: 0, vasino: 0 })).toBe(false);
        expect(voceDaMostrare('pranzo', { corsi: { primo: null } })).toBe(false);
    });

    it('bagno e pasti compilati: si mostrano', () => {
        expect(voceDaMostrare('bagno', { pipi: 1 })).toBe(true);
        expect(voceDaMostrare('merenda', { corsi: { merenda: 'poco' } })).toBe(true);
    });

    it('nanna e umore continuano a passare dalle regole che avevano già', () => {
        expect(voceDaMostrare('nanna_inizio', { orario_inizio: '' })).toBe(false);
        expect(voceDaMostrare('nanna_inizio', { orario_inizio: '13:00' })).toBe(true);
        // `nanna` senza suffisso è il tipo STORICO e non va perso.
        expect(voceDaMostrare('nanna', { orario_fine: '15:00' })).toBe(true);
        expect(voceDaMostrare('umore', { umore: null })).toBe(false);
        expect(voceDaMostrare('umore', { umore: 'felice' })).toBe(true);
    });

    it('FAIL-OPEN su ciò che non ha una regola: nel dubbio si MOSTRA', () => {
        // Un filtro che nel dubbio nasconde è il difetto opposto a quello che
        // stiamo chiudendo, e in questo repo è già costato: 29 bambini su 657
        // spariti dall'alert del pranzo per un eccesso di zelo.
        expect(voceDaMostrare('attivita', {})).toBe(true);
        expect(voceDaMostrare('entrata', null)).toBe(true);
        expect(voceDaMostrare('tipo_che_non_esiste_ancora', undefined)).toBe(true);
    });

    it('una NOTA da sola tiene in piedi la voce, anche senza contatori', () => {
        // Una maestra che apre «Pranzo», non segna nessuna portata e scrive «oggi
        // era un po' stanca» ha comunicato qualcosa. Il genitore la legge DENTRO
        // la tessera dell'evento: nascondere la tessera nasconde la frase.
        expect(voceDaMostrare('bagno', { pipi: 0, cacca: 0, vasino: 0 }, { conNota: true })).toBe(true);
        expect(voceDaMostrare('pranzo', { corsi: { primo: null } }, { conNota: true })).toBe(true);
        expect(voceDaMostrare('nanna_inizio', { orario_inizio: '' }, { conNota: true })).toBe(true);
        // Senza nota, niente cambia.
        expect(voceDaMostrare('bagno', { pipi: 0 }, { conNota: false })).toBe(false);
    });

    it('l\'elenco dei selettivi è esplicito, e `attivita` NON ne fa parte', () => {
        expect([...TIPI_SELETTIVI].sort()).toEqual(
            ['bagno', 'merenda', 'nanna', 'nanna_fine', 'nanna_inizio', 'pranzo', 'umore']);
        expect(eventoSelettivo('attivita')).toBe(false);
        expect(eventoSelettivo('bagno')).toBe(true);
    });
});
