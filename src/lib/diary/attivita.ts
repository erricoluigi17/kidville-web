/**
 * ESTRATTORE CONDIVISO PER LE ATTIVITÀ — l'ultimo dei quattro, e il più delicato.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ LA REGOLA QUI NON È «PER BAMBINO», ED È IL PUNTO.
 *
 * La descrizione di un'attività è **di classe per progetto**: «oggi pittura, tema
 * autunno» è vero per tutti quelli che c'erano. L'unica cosa per bambino è la
 * partecipazione, e può legittimamente restare vuota per un bambino presente —
 * la maestra non è tenuta a valutare ognuno.
 *
 * Perciò filtrare sulla partecipazione del singolo farebbe sparire dal diario di
 * TUTTI un'attività realmente svolta. Sarebbe l'errore che questo repo ha già
 * pagato: 29 bambini su 657 spariti dall'alert del pranzo per un eccesso di zelo.
 * Misurato il 2026-09-08: su 444 righe, **294 hanno una descrizione vera e 132 la
 * sola partecipazione** — cioè il 96% racconta qualcosa.
 *
 * IL DIFETTO CHE RESTA, e che questo modulo chiude. Il tipo di default è
 * `'pittura'` (`handleEventSelect`), la descrizione nasce vuota, e «Salva Attività
 * per tutti» scriveva comunque. Aprire la schermata, non scrivere niente e salvare
 * mandava a ogni genitore «🎨 Ho fatto pittura»: un valore messo d'ufficio,
 * indistinguibile da una scelta — **la stessa trappola del bagno**, dove i
 * contatori nascono a zero per tutti.
 *
 * In produzione erano **2 righe su 444**. Piccolo, ma è la trappola a essere
 * armata, non il danno a essere grande: il giorno in cui una maestra apre e chiude
 * la schermata per sbaglio, un'intera sezione riceve una frase falsa.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Questo tipo evento è un'attività? */
export function eEventoAttivita(tipo: string): boolean {
    return tipo === 'attivita';
}

type VoceAttivita = { tipo?: string; descrizione?: string; partecipazione?: string | null };

/**
 * Questa registrazione di attività DICE qualcosa?
 *
 * Basta **una** voce con una descrizione o una partecipazione: le altre, vuote,
 * non la annullano. Il `tipo` da solo non conta — è quello che nasce a `'pittura'`
 * senza che nessuno l'abbia scelto.
 */
export function attivitaCompilata(dettagli: Record<string, unknown> | null | undefined): boolean {
    const voci = dettagli?.activities;
    if (!Array.isArray(voci)) return false;
    return (voci as VoceAttivita[]).some(a => {
        const desc = typeof a?.descrizione === 'string' ? a.descrizione.trim() : '';
        const part = typeof a?.partecipazione === 'string' ? a.partecipazione.trim() : '';
        return desc.length > 0 || part.length > 0;
    });
}
