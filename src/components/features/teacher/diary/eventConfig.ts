import { useTranslations } from 'next-intl';
import { DiaryEventTypeBase, DiaryEventTypeLegacy } from '@/lib/offline/db';
import { eRoutinePersonalizzata } from '@/lib/diary/routine';

interface EventConfig {
    label: string;
    emoji: string;
    color: string; // Tailwind bg color class
    accentColor: string; // Tailwind text/border color class
}

// Colori on-token (brand/semantici Kidville) — sostituiscono i pastelli off-token
// (purple/orange/sky/amber) per coerenza con il redesign DR.
export const EVENT_CONFIG: Record<DiaryEventTypeBase, EventConfig> = {
    attivita: {
        label: 'Attività',
        emoji: '🎨',
        color: 'bg-kidville-green-soft',
        accentColor: 'text-kidville-green border-kidville-green/25',
    },
    merenda: {
        label: 'Merenda',
        emoji: '🍎',
        color: 'bg-kidville-warn-soft',
        accentColor: 'text-kidville-warn border-kidville-warn/25',
    },
    pranzo: {
        label: 'Pranzo',
        emoji: '🍽️',
        color: 'bg-kidville-success-soft',
        accentColor: 'text-kidville-success border-kidville-success/25',
    },
    nanna_inizio: {
        label: 'Nanna',
        emoji: '😴',
        color: 'bg-kidville-info-soft',
        accentColor: 'text-kidville-info border-kidville-info/25',
    },
    nanna_fine: {
        label: 'Sveglia',
        emoji: '☀️',
        color: 'bg-kidville-yellow-soft',
        accentColor: 'text-kidville-yellow-dark border-kidville-yellow-dark/25',
    },
    bagno: {
        label: 'Bagno',
        emoji: '🚿',
        color: 'bg-kidville-info-soft',
        accentColor: 'text-kidville-info border-kidville-info/25',
    },
    umore: {
        label: 'Umore',
        emoji: '🌈',
        color: 'bg-kidville-yellow-soft',
        accentColor: 'text-kidville-yellow-dark border-kidville-yellow-dark/25',
    },
};

/** Fallback per tipi evento legacy (es. 'entrata') rimossi dal diario attivo */
const LEGACY_FALLBACK: EventConfig = {
    label: 'Evento',
    emoji: '📝',
    color: 'bg-kidville-neutral-soft',
    accentColor: 'text-kidville-neutral border-kidville-neutral/25',
};

/** Config specifica per eventi legacy noti */
const LEGACY_EVENT_CONFIG: Partial<Record<string, EventConfig>> = {
    entrata: {
        label: 'Entrata',
        emoji: '🌅',
        color: 'bg-kidville-yellow-soft',
        accentColor: 'text-kidville-yellow-dark border-kidville-yellow-dark/25',
    },
};

/**
 * Restituisce la config per un tipo evento, inclusi i tipi legacy.
 * Sicuro per eventi storici che non sono più nel tipo DiaryEventType attivo.
 */
export function getEventConfig(type: DiaryEventTypeLegacy | string): EventConfig {
    if (type in EVENT_CONFIG) return EVENT_CONFIG[type as DiaryEventTypeBase];
    return LEGACY_EVENT_CONFIG[type] ?? LEGACY_FALLBACK;
}

/**
 * Da dove si prendono nome e icona di una routine della SCUOLA: la sua definizione (la maestra,
 * mentre compila) oppure la fotografia salvata nella voce (il genitore, anche a routine cancellata).
 */
export interface FonteRoutine { nome?: unknown; emoji?: unknown }

/**
 * Il colore delle routine della scuola: uno solo per tutte, on-token, diverso da quelli base. Sono
 * dati scritti dalla segreteria, e un colore per ciascuna sarebbe una scelta in più da fare.
 */
const ASPETTO_ROUTINE_SCUOLA = {
    color: 'bg-kidville-cream',
    accentColor: 'text-kidville-green border-kidville-green/25',
};

function testoPieno(v: unknown): string | null {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * L'aspetto di una voce, per QUALUNQUE tipo: per i base la config fissa, per una routine della
 * scuola (`routine:<id>`, 2026-09-28) nome e icona dalla `fonte`. Senza fonte ricade su «Evento» 📝,
 * come i tipi legacy: mai il codice grezzo `routine:…` a schermo.
 */
export function configDiVoce(type: string, fonte?: FonteRoutine | null): EventConfig {
    if (!eRoutinePersonalizzata(type)) return getEventConfig(type);
    return {
        label: testoPieno(fonte?.nome) ?? LEGACY_FALLBACK.label,
        emoji: testoPieno(fonte?.emoji) ?? LEGACY_FALLBACK.emoji,
        ...ASPETTO_ROUTINE_SCUOLA,
    };
}

/**
 * Hook locale-aware per la SOLA etichetta di un tipo evento (namespace
 * `etichette`, chiavi `evento_<tipo>`; il fallback generico legacy usa
 * `evento_legacy`). Da usare nei componenti client. Emoji e colori restano su
 * `getEventConfig` (config pura, non tradotta). Chiave assente → fallback alla
 * label pura, MAI la chiave i18n.
 */
export function useEventLabel(): (type: DiaryEventTypeLegacy | string, fonte?: FonteRoutine | null) => string {
    const t = useTranslations('etichette');
    return (type, fonte) => {
        // Una routine della scuola si chiama come l'ha chiamata la segreteria: è un dato, non un
        // testo dell'app, e non si traduce. Senza nome, «Evento» come i tipi legacy.
        if (eRoutinePersonalizzata(type)) {
            const nome = testoPieno(fonte?.nome);
            if (nome) return nome;
            return t.has('evento_legacy') ? t('evento_legacy') : LEGACY_FALLBACK.label;
        }
        const specific = `evento_${type}`;
        if (t.has(specific)) return t(specific);
        if (t.has('evento_legacy')) return t('evento_legacy');
        return getEventConfig(type).label;
    };
}

export const MEAL_QUANTITIES = [
    { value: 'niente', label: 'Niente', icon: '❌', short: '✗' },
    { value: 'poco', label: 'Poco', icon: '🤏', short: '¼' },
    { value: 'meta', label: 'Metà', icon: '🍽️', short: '½' },
    { value: 'quasi', label: 'Quasi tutto', icon: '😊', short: '¾' },
    { value: 'tutto', label: 'Tutto!', icon: '⭐', short: '★' },
] as const;

export const BATHROOM_TYPES = [
    { value: 'pipi', label: 'Pipì', icon: '💧' },
    { value: 'cacca', label: 'Cacca', icon: '💩' },
    { value: 'vasino', label: 'Vasino', icon: '🚽' },
] as const;
