import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock globale di next-intl per i test. I componenti migrati usano
// useTranslations/useLocale, che senza il NextIntlClientProvider (vive nel
// RootLayout, non montato negli unit test) lancerebbero. Il mock risolve le
// chiavi contro i messaggi ITALIANI reali (messages/it.json), così i test che
// asseriscono sui testi italiani continuano a passare senza wrapper. Scalabile a
// tutta la migrazione i18n: nessun test esistente va toccato per il provider.
vi.mock('next-intl', async () => {
  const it = (await import('../messages/it.json')).default as Record<string, Record<string, string>>;
  const resolve = (ns: string | undefined, key: string): string => {
    const gruppo = ns ? it[ns] : undefined;
    return (gruppo && gruppo[key]) ?? (ns ? `${ns}.${key}` : key);
  };
  const useTranslations = (ns?: string) => {
    const t = (key: string) => resolve(ns, key);
    return Object.assign(t, {
      rich: (key: string) => resolve(ns, key),
      markup: (key: string) => resolve(ns, key),
      raw: (key: string) => resolve(ns, key),
      has: () => true,
    });
  };
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

// I mock browser-specifici valgono solo in ambiente jsdom (i test con
// `@vitest-environment node` non hanno `window`).
if (typeof window !== 'undefined') {
  // Mock per funzioni specifiche del browser che jsdom non supporta
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Polyfill semplificato per crypto.randomUUID usato nei nostri script
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = () => '12345678-1234-1234-1234-123456789012';
  }
}
