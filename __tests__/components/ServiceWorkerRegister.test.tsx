import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister';
import { logClient } from '@/lib/logging/client';
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread';

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

/**
 * IL CLIC SU UNA WEB PUSH DI CHAT, CON LA CHAT GIÀ APERTA (parte C, 2026-09-15).
 *
 * `public/sw.js` non naviga una finestra che è già sulla pagina chat: le manda
 * `{ tipo: 'kv-apri-thread', threadId }` e la porta davanti. Il ponte lo trasforma nella
 * stessa richiesta del tocco su una push nativa (`richiediAperturaThread`), che la pagina
 * chat montata riceve e tratta con le sue regole.
 *
 * Se nessuna pagina ascolta — l'URL dice chat ma l'ascoltatore non è ancora montato — la
 * richiesta non si perde: il thread va nell'URL, e la pagina lo legge al montaggio. La
 * pagina chat qui è un ascoltatore vero di `ascoltaAperturaThread`.
 */
describe('ServiceWorkerRegister — il clic su una web push di chat', () => {
  const T = 'dddddddd-0000-4000-8000-000000000014';
  const U = 'aaaaaaaa-0000-4000-8000-000000000011';
  const hadSW = 'serviceWorker' in navigator;
  const originalSW = nav.serviceWorker;
  const pagineMontate: Array<() => void> = [];

  const suPagina = (percorso: string) => window.history.replaceState(null, '', percorso);
  const dove = () => `${window.location.pathname}${window.location.search}`;

  afterEach(() => {
    while (pagineMontate.length) pagineMontate.pop()!();
    suPagina('/');
    if (hadSW) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalSW });
    } else {
      delete nav.serviceWorker;
    }
    vi.clearAllMocks();
  });

  /** La pagina chat montata: ascolta le richieste di apertura. */
  function paginaChatMontata() {
    const gestore = vi.fn();
    pagineMontate.push(ascoltaAperturaThread(gestore));
    return gestore;
  }

  /** Monta il ponte e restituisce la funzione che gli consegna un messaggio del Service Worker. */
  function ponte() {
    const listeners = new Map<string, (e: MessageEvent) => void>();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue({}),
        controller: {},
        addEventListener: (n: string, cb: (e: MessageEvent) => void) => listeners.set(n, cb),
        removeEventListener: () => undefined,
      },
    });
    render(<ServiceWorkerRegister />);
    return (data: unknown) => listeners.get('message')?.({ data } as MessageEvent);
  }

  it('pagina chat in ascolto: la conversazione arriva alla pagina, in forma canonica, senza log e senza toccare l’URL', () => {
    suPagina('/parent/chat');
    const gestore = paginaChatMontata();
    const consegna = ponte();

    consegna({ tipo: 'kv-apri-thread', threadId: T });
    consegna({ tipo: 'kv-apri-thread', threadId: T.toUpperCase() });

    expect(gestore.mock.calls).toEqual([[T], [T]]);
    expect(mockLog).not.toHaveBeenCalled();
    expect(dove()).toBe('/parent/chat');
  });

  it('presidio — un threadId che non è un id (o che manca) non apre niente e non scrive niente', () => {
    suPagina('/parent/chat');
    const gestore = paginaChatMontata();
    const consegna = ponte();

    consegna({ tipo: 'kv-apri-thread', threadId: 'abc' });
    consegna({ tipo: 'kv-apri-thread', threadId: 42 });
    consegna({ tipo: 'kv-apri-thread' });

    expect(gestore).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
    expect(dove()).toBe('/parent/chat');
  });

  it('nessuna pagina chat in ascolto: il thread va nell’URL, sulla voce corrente, e il resto della query resta', () => {
    suPagina(`/teacher/chat?userId=${U}`);
    const voci = window.history.length;
    const consegna = ponte();

    consegna({ tipo: 'kv-apri-thread', threadId: T });

    expect(dove()).toBe(`/teacher/chat?userId=${U}&thread=${T}`);
    // Sostituita, non aggiunta: «Indietro» non deve riportare sulla stessa chat senza thread.
    expect(window.history.length).toBe(voci);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('la finestra non è più sulla chat: nessuna navigazione, e una riga di log senza l’id', () => {
    suPagina('/parent/home');
    const consegna = ponte();

    consegna({ tipo: 'kv-apri-thread', threadId: T });

    expect(dove()).toBe('/parent/home');
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toEqual({
      livello: 'warn',
      evento: 'push',
      messaggio: 'chat-apertura-da-notifica: nessuna-pagina-chat (sw)',
    });
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain(T);
  });
});
