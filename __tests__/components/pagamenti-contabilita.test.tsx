import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STATI_PAGAMENTO } from '@/components/features/admin/pagamenti/stati';
import { ContabilitaNav, VISTE_CONTABILITA } from '@/components/features/admin/pagamenti/ContabilitaNav';

/**
 * Lock del re-skin W3a (Contabilità): il vocabolario stati passa ai `tone` del
 * Badge dell'app e la nav a pillole parla il linguaggio delle Tabs 0A (attiva
 * verde con testo bianco, inattive bianche con ring `kidville-line`). Nessun
 * testo utente cambia — solo la pelle.
 */

const TONI_VALIDI = new Set(['unread', 'info', 'read', 'success', 'warn', 'error', 'neutral']);

describe('stati.ts — chip di stato su Badge/TONE', () => {
  it('ogni stato espone un tone di Badge valido, con label invariata', () => {
    expect(STATI_PAGAMENTO.da_pagare).toMatchObject({ label: 'Da pagare' });
    expect(STATI_PAGAMENTO.parziale).toMatchObject({ label: 'Parziale' });
    expect(STATI_PAGAMENTO.pagato).toMatchObject({ label: 'Pagato' });
    expect(STATI_PAGAMENTO.scaduto).toMatchObject({ label: 'Scaduto' });
    for (const s of Object.values(STATI_PAGAMENTO)) {
      expect(TONI_VALIDI.has(s.tone)).toBe(true);
    }
  });

  it('lo stato scaduto è di tono error, il pagato success', () => {
    expect(STATI_PAGAMENTO.scaduto.tone).toBe('error');
    expect(STATI_PAGAMENTO.pagato.tone).toBe('success');
  });
});

describe('ContabilitaNav — pillole nel linguaggio delle Tabs 0A', () => {
  it('elenca tutte le viste senza cambiare le etichette', () => {
    render(<ContabilitaNav value="scadenzario" onChange={() => {}} />);
    for (const v of VISTE_CONTABILITA) {
      // etichetta presente (mobile + desktop → almeno una occorrenza)
      expect(screen.getAllByText(v.label).length).toBeGreaterThan(0);
    }
  });

  it('la pillola attiva è verde con testo bianco, le inattive hanno il ring line (mai testo giallo)', () => {
    const { container } = render(<ContabilitaNav value="scadenzario" onChange={() => {}} />);
    const html = container.innerHTML;
    // pillola attiva = verde piena + testo bianco (linguaggio 0A), non giallo
    expect(html).toContain('bg-kidville-green');
    expect(html).toContain('text-kidville-white');
    expect(html).not.toContain('text-kidville-yellow');
    // pillole inattive = bianche con ring line
    expect(html).toContain('ring-kidville-line');
  });
});
