import { DiaryEventType, DiaryEventTypeLegacy } from '@/lib/offline/db';

interface EventConfig {
    label: string;
    emoji: string;
    color: string; // Tailwind bg color class
    accentColor: string; // Tailwind text/border color class
}

// Colori on-token (brand/semantici Kidville) — sostituiscono i pastelli off-token
// (purple/orange/sky/amber) per coerenza con il redesign DR.
export const EVENT_CONFIG: Record<DiaryEventType, EventConfig> = {
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
    if (type in EVENT_CONFIG) return EVENT_CONFIG[type as DiaryEventType];
    return LEGACY_EVENT_CONFIG[type] ?? LEGACY_FALLBACK;
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
    { value: 'vasino', label: 'Vasino', icon: '🪣' },
] as const;
