import { describe, it, expect } from 'vitest';
import { oggiFiscaleISO, annoFiscale } from '@/lib/format/fiscal-date';

// Le date a valenza fiscale devono usare Europe/Rome, non l'UTC del runtime.
describe('fiscal-date (Europe/Rome)', () => {
  it('oggiFiscaleISO è nel formato YYYY-MM-DD', () => {
    expect(oggiFiscaleISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('annoFiscale è un intero a 4 cifre, coerente con la data', () => {
    const anno = annoFiscale();
    expect(Number.isInteger(anno)).toBe(true);
    expect(String(anno)).toBe(oggiFiscaleISO().slice(0, 4));
  });
});
