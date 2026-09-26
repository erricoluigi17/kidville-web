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

/**
 * Una voce di `dettagli.activities[]`.
 *
 * `ora_inizio` / `ora_fine` (dal 2026-09-26): orario PROPRIO di ciascuna attività,
 * formato "HH:MM" a 24 ore, entrambi facoltativi. Nessuna migrazione: vivono nel
 * jsonb. Contratto in `docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/D1.md`.
 */
export type VoceAttivita = {
    tipo?: string;
    descrizione?: string;
    partecipazione?: string | null;
    ora_inizio?: string | null;
    ora_fine?: string | null;
};

/**
 * "HH:MM" a 24 ore, con lo zero davanti: 00:00–23:59. È anche l'unica forma che
 * un `<input type="time">` senza `step` produce. Zero-padded ⇒ il confronto fra
 * due orari validi si fa come confronto fra stringhe.
 */
export const ORA_ATTIVITA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** È un orario d'attività valido ("HH:MM", 24 ore)? */
export function oraAttivitaValida(v: unknown): v is string {
    return typeof v === 'string' && ORA_ATTIVITA_RE.test(v);
}

function normalizzaOra(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return ORA_ATTIVITA_RE.test(t) ? t : null;
}

/**
 * L'orario di una voce, normalizzato per chi lo MOSTRA: stringa vuota, valore
 * assente o fuori formato → `null`. Non inventa niente: un orario che non è
 * "HH:MM" non viene «aggiustato», sparisce.
 */
export function orarioAttivita(voce: unknown): { inizio: string | null; fine: string | null } {
    if (!voce || typeof voce !== 'object') return { inizio: null, fine: null };
    const v = voce as VoceAttivita;
    return { inizio: normalizzaOra(v.ora_inizio), fine: normalizzaOra(v.ora_fine) };
}

/**
 * L'ora da mostrare A LATO della voce «attività» nel diario del genitore.
 *
 * Decisione del titolare (26/09): l'ora di inizio della PRIMA attività
 * dell'elenco (`activities[0]`), se inserita. NON la prima attività che ha un
 * orario: se la prima non l'ha, si torna all'ora del salvataggio, come prima.
 *
 * Restituisce `null` in quel caso, e l'ora del salvataggio la formatta il
 * chiamante: è lui che conosce fuso e locale della pagina. Il secondo argomento
 * è accettato (è la firma del piano) ma di proposito non viene usato qui.
 *
 * Accetta sia `dettagli` sia la voce di diario intera (`{ dettagli }`).
 */
export function oraDiLatoAttivita(
    dettagliOVoce: unknown,
    timestampSalvataggio?: unknown,
): string | null {
    void timestampSalvataggio; // il ripiego sul salvataggio è del chiamante (vedi sopra)
    if (!dettagliOVoce || typeof dettagliOVoce !== 'object') return null;
    const o = dettagliOVoce as Record<string, unknown>;
    const dettagli = 'activities' in o
        ? o
        : (o.dettagli && typeof o.dettagli === 'object' ? o.dettagli as Record<string, unknown> : null);
    const voci = dettagli?.activities;
    if (!Array.isArray(voci) || voci.length === 0) return null;
    return orarioAttivita(voci[0]).inizio;
}

/**
 * Questa registrazione di attività DICE qualcosa?
 *
 * Basta **una** voce con una descrizione o una partecipazione: le altre, vuote,
 * non la annullano. Il `tipo` da solo non conta — è quello che nasce a `'pittura'`
 * senza che nessuno l'abbia scelto.
 *
 * Nemmeno l'ORARIO conta (26/09): «dalle 10 alle 11» senza dire che cosa non
 * racconta niente al genitore, e una voce con il solo orario resta muta — il
 * server la salta come le altre voci mute.
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
