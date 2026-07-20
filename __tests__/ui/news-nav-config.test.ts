import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, ALL_HREFS } from '@/components/features/admin/admin-nav-config';

/**
 * Lock della voce «News» nel cockpit admin (Step 4).
 *
 * La sezione News aggiunge una sola voce di navigazione, nel gruppo
 * «Comunicazione» subito dopo «Avvisi». Le tre superfici admin (sidebar,
 * bottom-nav, menu sheet) leggono la stessa `NAV_GROUPS`, quindi qui basta un
 * lock sulla config per garantire la presenza ovunque.
 */
describe('admin-nav-config — voce News', () => {
  it('espone /admin/news nella nav', () => {
    expect(ALL_HREFS).toContain('/admin/news');
  });

  it('la voce News sta nel gruppo «Comunicazione» con label «News»', () => {
    const gruppo = NAV_GROUPS.find((g) => g.title === 'Comunicazione');
    expect(gruppo).toBeDefined();
    const voce = gruppo!.items.find((i) => i.href === '/admin/news');
    expect(voce).toBeDefined();
    expect(voce!.label).toBe('News');
  });

  it('News è collocata subito dopo «Avvisi» nel gruppo', () => {
    const gruppo = NAV_GROUPS.find((g) => g.title === 'Comunicazione')!;
    const idxAvvisi = gruppo.items.findIndex((i) => i.href === '/admin/avvisi');
    const idxNews = gruppo.items.findIndex((i) => i.href === '/admin/news');
    expect(idxAvvisi).toBeGreaterThanOrEqual(0);
    expect(idxNews).toBe(idxAvvisi + 1);
  });
});
