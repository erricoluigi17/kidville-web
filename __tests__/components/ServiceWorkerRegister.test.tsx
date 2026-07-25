import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister';
import { logClient } from '@/lib/logging/client';

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn() }));
const mockLog = vi.mocked(logClient);

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

  /** navigator.serviceWorker finto, con il registro dei listener. */
  function montaSW(register: ReturnType<typeof vi.fn>) {
    const listeners = new Map<string, (e: MessageEvent) => void>();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register,
        controller: {},
        addEventListener: (n: string, cb: (e: MessageEvent) => void) => listeners.set(n, cb),
        removeEventListener: () => undefined,
      },
    });
    return listeners;
  }

  it('registra /sw.js al mount quando serviceWorker è supportato', () => {
    const register = vi.fn().mockResolvedValue({});
    montaSW(register);

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

describe('ServiceWorkerRegister — osservabilità', () => {
  const hadSW = 'serviceWorker' in navigator;
  const originalSW = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

  afterEach(() => {
    if (hadSW) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalSW });
    } else {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    }
    vi.clearAllMocks();
  });

  function monta(register: ReturnType<typeof vi.fn>) {
    const listeners = new Map<string, (e: MessageEvent) => void>();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register,
        controller: {},
        addEventListener: (n: string, cb: (e: MessageEvent) => void) => listeners.set(n, cb),
        removeEventListener: () => undefined,
      },
    });
    render(<ServiceWorkerRegister />);
    return listeners;
  }

  it('una registrazione FALLITA viene loggata, non ingoiata', async () => {
    // Il vecchio `.catch(() => {})` muto è la ragione per cui il difetto iOS è
    // vissuto invisibile: dentro WKWebView, senza WKAppBoundDomains, la
    // registrazione falliva sempre e nessuno lo sapeva.
    monta(vi.fn().mockRejectedValue(new DOMException('no', 'SecurityError')));
    await waitFor(() => expect(mockLog).toHaveBeenCalled());
    expect(mockLog.mock.calls[0][0]).toMatchObject({ livello: 'error', evento: 'offline' });
  });

  it('traduce i messaggi del Service Worker in log applicativi', async () => {
    const listeners = monta(vi.fn().mockResolvedValue({}));
    listeners.get('message')?.({
      data: { tipo: 'kv-sw-log', livello: 'warn', evento: 'sw-documento-da-cache', bucket: '/parent' },
    } as MessageEvent);
    await waitFor(() => expect(mockLog).toHaveBeenCalledTimes(1));
    expect(mockLog.mock.calls[0][0]).toMatchObject({
      livello: 'warn',
      evento: 'offline',
      messaggio: 'sw-documento-da-cache /parent',
    });
  });

  it('ignora i messaggi che non sono suoi', async () => {
    const listeners = monta(vi.fn().mockResolvedValue({}));
    listeners.get('message')?.({ data: { tipo: 'altro', evento: 'x' } } as MessageEvent);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
