import '@testing-library/jest-dom';
import { vi } from 'vitest';

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
