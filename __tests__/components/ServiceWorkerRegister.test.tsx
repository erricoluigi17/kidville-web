import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister';

const nav = navigator as unknown as { serviceWorker?: unknown };

describe('ServiceWorkerRegister', () => {
  // In jsdom `serviceWorker` non esiste sul navigator: lo memorizziamo per
  // ripristinarlo fedelmente (chiave presente o del tutto assente) dopo ogni test.
  const hadSW = 'serviceWorker' in navigator;
  const originalSW = nav.serviceWorker;

  afterEach(() => {
    if (hadSW) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalSW });
    } else {
      delete nav.serviceWorker;
    }
    vi.clearAllMocks();
  });

  it('registra /sw.js al mount quando serviceWorker è supportato', () => {
    const register = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    });

    const { container } = render(<ServiceWorkerRegister />);

    expect(register).toHaveBeenCalledWith('/sw.js');
    // Non renderizza nulla (hydration-safe).
    expect(container.firstChild).toBeNull();
  });

  it('no-op quando serviceWorker non è supportato (nessun crash)', () => {
    // Rimuove del tutto la proprietà: `'serviceWorker' in navigator` diventa false.
    if ('serviceWorker' in navigator) delete nav.serviceWorker;

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
  });
});
