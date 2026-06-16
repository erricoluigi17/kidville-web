import { describe, it, expect } from 'vitest';
import { suggerisciGiudizio } from '@/lib/primaria/suggerimento';
import type { ScalaVoce } from '@/lib/primaria/media';

// Scala Allegato A O.M. 3/2025 con l'associazione numerica nascosta usata nel seed.
const SCALA: ScalaVoce[] = [
  { etichetta: 'Ottimo', valore_numerico: 10 },
  { etichetta: 'Distinto', valore_numerico: 9 },
  { etichetta: 'Buono', valore_numerico: 8 },
  { etichetta: 'Discreto', valore_numerico: 7 },
  { etichetta: 'Sufficiente', valore_numerico: 6 },
  { etichetta: 'Non sufficiente', valore_numerico: 4 },
];

describe('suggerisciGiudizio', () => {
  it('mappa un valore esatto sul giudizio corrispondente', () => {
    expect(suggerisciGiudizio(SCALA, 8)).toBe('Buono');
    expect(suggerisciGiudizio(SCALA, 10)).toBe('Ottimo');
    expect(suggerisciGiudizio(SCALA, 4)).toBe('Non sufficiente');
  });

  it('sceglie il giudizio più vicino per valori intermedi', () => {
    expect(suggerisciGiudizio(SCALA, 9.6)).toBe('Ottimo'); // 0.4 da 10 vs 0.6 da 9
    expect(suggerisciGiudizio(SCALA, 4.4)).toBe('Non sufficiente'); // 0.4 da 4 vs 1.6 da 6
    expect(suggerisciGiudizio(SCALA, 6.4)).toBe('Sufficiente');
  });

  it('in caso di pari distanza preferisce il giudizio più alto', () => {
    expect(suggerisciGiudizio(SCALA, 7.5)).toBe('Buono'); // 0.5 da 7 e da 8 → 8
    expect(suggerisciGiudizio(SCALA, 5)).toBe('Sufficiente'); // 1 da 4 e da 6 → 6
  });

  it('gestisce gli estremi oltre la scala', () => {
    expect(suggerisciGiudizio(SCALA, 0)).toBe('Non sufficiente');
    expect(suggerisciGiudizio(SCALA, 10)).toBe('Ottimo');
  });

  it('ritorna null per numero assente o scala senza valori', () => {
    expect(suggerisciGiudizio(SCALA, null)).toBeNull();
    expect(suggerisciGiudizio(SCALA, undefined)).toBeNull();
    expect(suggerisciGiudizio(SCALA, NaN)).toBeNull();
    expect(suggerisciGiudizio([], 7)).toBeNull();
    expect(suggerisciGiudizio([{ etichetta: 'X', valore_numerico: null }], 7)).toBeNull();
  });
});
