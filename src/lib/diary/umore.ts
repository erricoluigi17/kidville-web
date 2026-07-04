// Mappa condivisa teacher/parent per l'evento diario 'umore' (M5.4).
// Nessuna migrazione: il valore vive in eventi_diario.dettagli.umore (JSONB),
// un evento per alunno+giorno (upsert della route /api/diary/entries).

export const UMORE_VALUES = ['felice', 'sereno', 'cosi_cosi', 'triste', 'agitato'] as const;
export type UmoreValue = (typeof UMORE_VALUES)[number];

export interface UmoreConfig {
    label: string;
    emoji: string;
}

export const UMORE_CONFIG: Record<UmoreValue, UmoreConfig> = {
    felice: { label: 'Felice', emoji: '😄' },
    sereno: { label: 'Sereno', emoji: '🙂' },
    cosi_cosi: { label: 'Così così', emoji: '😐' },
    triste: { label: 'Triste', emoji: '😢' },
    agitato: { label: 'Agitato', emoji: '😣' },
};

export function isUmoreValue(v: unknown): v is UmoreValue {
    return typeof v === 'string' && (UMORE_VALUES as readonly string[]).includes(v);
}

/** Estrae il valore umore da dettagli JSONB (null se assente o non valido). */
export function umoreFromDettagli(dettagli: Record<string, unknown> | null | undefined): UmoreValue | null {
    const v = dettagli?.umore;
    return isUmoreValue(v) ? v : null;
}

/** La routine 'umore' è attiva in diario_config.routine_attive? (fail-closed) */
export function umoreAttivo(routineAttive: unknown): boolean {
    return Array.isArray(routineAttive) && routineAttive.includes('umore');
}

/** Frase in prima persona per il diario genitore (tono "raccontata da me"). */
export function umoreNarrative(value: UmoreValue): string {
    switch (value) {
        case 'felice': return 'Oggi sono stato/a proprio felice!';
        case 'sereno': return 'Oggi sono stato/a sereno/a e tranquillo/a.';
        case 'cosi_cosi': return 'Oggi è andata così così.';
        case 'triste': return 'Oggi ero un po\' triste.';
        case 'agitato': return 'Oggi ero un po\' agitato/a.';
    }
}
