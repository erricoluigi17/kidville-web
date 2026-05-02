import { DiaryEventType } from '@/lib/offline/db';

interface EventConfig {
    label: string;
    emoji: string;
    color: string; // Tailwind bg color class
    accentColor: string; // Tailwind text/border color class
}

export const EVENT_CONFIG: Record<DiaryEventType, EventConfig> = {
    entrata: {
        label: 'Entrata',
        emoji: '🌅',
        color: 'bg-amber-50',
        accentColor: 'text-amber-600 border-amber-200',
    },
    attivita: {
        label: 'Attività',
        emoji: '🎨',
        color: 'bg-purple-50',
        accentColor: 'text-purple-600 border-purple-200',
    },
    merenda: {
        label: 'Merenda',
        emoji: '🍎',
        color: 'bg-orange-50',
        accentColor: 'text-orange-600 border-orange-200',
    },
    pranzo: {
        label: 'Pranzo',
        emoji: '🍽️',
        color: 'bg-green-50',
        accentColor: 'text-green-600 border-green-200',
    },
    nanna_inizio: {
        label: 'Nanna',
        emoji: '😴',
        color: 'bg-blue-50',
        accentColor: 'text-blue-600 border-blue-200',
    },
    nanna_fine: {
        label: 'Sveglia',
        emoji: '☀️',
        color: 'bg-yellow-50',
        accentColor: 'text-yellow-600 border-yellow-200',
    },
    bagno: {
        label: 'Bagno',
        emoji: '🚿',
        color: 'bg-sky-50',
        accentColor: 'text-sky-600 border-sky-200',
    },
};

export const MEAL_QUANTITIES = [
    { value: 'niente', label: 'Niente', icon: '❌' },
    { value: 'poco', label: 'Poco', icon: '🤏' },
    { value: 'meta', label: 'Metà', icon: '🍽️' },
    { value: 'tanto', label: 'Tanto', icon: '😋' },
    { value: 'tutto', label: 'Tutto!', icon: '⭐' },
] as const;

export const BATHROOM_TYPES = [
    { value: 'pipi', label: 'Pipì', icon: '💧' },
    { value: 'cacca', label: 'Cacca', icon: '💩' },
    { value: 'vasino', label: 'Vasino', icon: '🪣' },
] as const;
