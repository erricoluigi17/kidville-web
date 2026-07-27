import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventCard } from '@/app/(dashboard)/parent/diary/page';

// C5 §2 — segnalazione voce di diario. Ogni card della giornata espone un
// bottone "Segnala" con etichetta testuale sempre visibile (mai solo icona).
describe('Diario — segnalazione voce', () => {
  const entry = {
    id: 'evento-1',
    tipo_evento: 'pranzo',
    timestamp_evento: new Date('2026-07-27T12:30:00Z').toISOString(),
    dettagli: null,
    note: null,
  };

  it('ogni voce di diario mostra un bottone "Segnala" con testo visibile', () => {
    render(<EventCard entry={entry} index={0} />);
    const btn = screen.getByRole('button', { name: /Segnala/ });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Segnala');
  });
});
