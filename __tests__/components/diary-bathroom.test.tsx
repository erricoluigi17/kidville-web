import { describe, it, expect } from 'vitest';
import { BATHROOM_TYPES, EVENT_CONFIG } from '@/components/features/teacher/diary/eventConfig';

describe('Diario 0-6 — evento bagno', () => {
    it('il vasino usa il water 🚽, non più il secchiello 🪣', () => {
        const vasino = BATHROOM_TYPES.find(b => b.value === 'vasino');
        expect(vasino?.icon).toBe('🚽');
    });

    it('nessun tipo bagno usa più il secchiello 🪣', () => {
        expect(BATHROOM_TYPES.every(b => b.icon !== '🪣')).toBe(true);
    });

    it('ogni tipo bagno ha una label italiana per la vista impilata (mobile)', () => {
        expect(BATHROOM_TYPES.map(b => b.label)).toEqual(['Pipì', 'Cacca', 'Vasino']);
    });

    it("l'emoji della routine bagno resta la doccia 🚿", () => {
        expect(EVENT_CONFIG.bagno.emoji).toBe('🚿');
    });
});
