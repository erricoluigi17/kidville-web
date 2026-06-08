import { describe, it, expect } from 'vitest';
import { calcolaOreAssenza, giornataDaCampanelle, GIORNATA_DEFAULT } from '@/lib/primaria/oreAssenza';

// Costruisce un timestamp ISO locale per un dato orario del 2026-06-08.
function ts(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  const d = new Date(2026, 5, 8, Number(h), Number(m), 0);
  return d.toISOString();
}

describe('calcolaOreAssenza', () => {
  it('conta la giornata intera per le assenze (default 08:30-13:30 = 5h)', () => {
    const r = calcolaOreAssenza([{ stato: 'assente' }]);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreTotali).toBe(5);
  });

  it('conta le ore di ritardo come entrata − inizio', () => {
    const r = calcolaOreAssenza([{ stato: 'ritardo', orario_entrata: ts('09:30') }]);
    expect(r.oreRitardo).toBe(1); // 09:30 − 08:30
    expect(r.oreTotali).toBe(1);
  });

  it('conta le ore di permesso come fine − uscita', () => {
    const r = calcolaOreAssenza([{ stato: 'uscita_anticipata', orario_uscita: ts('12:30') }]);
    expect(r.orePermesso).toBe(1); // 13:30 − 12:30
    expect(r.oreTotali).toBe(1);
  });

  it('non conta nulla per i presenti e somma le categorie', () => {
    const r = calcolaOreAssenza([
      { stato: 'presente' },
      { stato: 'assente' },
      { stato: 'ritardo', orario_entrata: ts('09:00') }, // 0.5h
      { stato: 'uscita_anticipata', orario_uscita: ts('13:00') }, // 0.5h
    ]);
    expect(r.oreAssenza).toBe(5);
    expect(r.oreRitardo).toBe(0.5);
    expect(r.orePermesso).toBe(0.5);
    expect(r.oreTotali).toBe(6);
  });

  it('clampa i valori fuori giornata a [0, durata]', () => {
    // Entrata prima dell'inizio → 0; uscita prima dell'inizio → durata intera.
    const r = calcolaOreAssenza([
      { stato: 'ritardo', orario_entrata: ts('08:00') },
      { stato: 'uscita_anticipata', orario_uscita: ts('08:00') },
    ]);
    expect(r.oreRitardo).toBe(0);
    expect(r.orePermesso).toBe(5);
  });

  it('rispetta una giornata personalizzata', () => {
    const r = calcolaOreAssenza([{ stato: 'assente' }], { inizio: '08:00', fine: '16:00' });
    expect(r.oreAssenza).toBe(8);
  });
});

describe('giornataDaCampanelle', () => {
  it('deduce inizio/fine da min/max delle lezioni', () => {
    const g = giornataDaCampanelle([
      { ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
      { ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
      { ora_inizio: '12:00:00', ora_fine: '13:00:00', tipo: 'mensa' },
    ]);
    expect(g).toEqual({ inizio: '08:30', fine: '10:30' });
  });

  it('usa il default senza campanelle', () => {
    expect(giornataDaCampanelle([])).toEqual(GIORNATA_DEFAULT);
  });
});
