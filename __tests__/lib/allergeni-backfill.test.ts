// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { inferisciAllergeniDaTesto as inferLib, ALLERGENI } from '@/lib/mensa/allergeni';
import {
  inferisciAllergeniDaTesto as inferScript,
  pianificaRiga,
  isNegazione,
} from '../../scripts/backfill_allergeni.mjs';

describe('backfill allergeni — parità inferenza con la lib runtime', () => {
  // Battery: ogni sinonimo di ogni allergene + valori reali + combinazioni.
  const battery: string[] = [
    ...ALLERGENI.flatMap((a) => a.sinonimi),
    'Glutine',
    'Lattosio',
    'Nessuna allergia nota',
    'lattosio, fragole',
    'noci e mandorle',
    'uova; pesce',
    'burro di arachidi e latte',
    'kiwi',
    '',
  ];

  it('lo script inferisce esattamente come src/lib/mensa/allergeni.ts', () => {
    for (const testo of battery) {
      expect(inferScript(testo).sort()).toEqual(inferLib(testo).sort());
    }
  });
});

describe('backfill allergeni — pianificazione riga', () => {
  it('mappa un allergene noto senza nota storica', () => {
    const p = pianificaRiga({ allergies: 'Glutine', note_mediche: null });
    expect(p.skip).toBe(false);
    expect(p.allergeni).toEqual(['glutine']);
    expect(p.nota).toBeNull();
    expect(p.cambia).toBe(true);
  });

  it('struttura il mappabile e appende il residuo non mappato', () => {
    const p = pianificaRiga({ allergies: 'lattosio, fragole', note_mediche: null });
    expect(p.allergeni).toEqual(['latte']);
    expect(p.nota).toContain('Allergie (testo storico)');
    expect(p.nota).toContain('fragole');
    expect(p.nota).not.toContain('lattosio'); // lattosio è stato strutturato
  });

  it('preserva le note esistenti quando appende il residuo', () => {
    const p = pianificaRiga({ allergies: 'kiwi', note_mediche: 'Terapia X' });
    expect(p.allergeni).toEqual([]);
    expect(p.nota).toBe('Terapia X\nAllergie (testo storico): kiwi');
    expect(p.cambia).toBe(true);
  });

  it('è idempotente: non ri-appende se la nota storica è già presente', () => {
    const p = pianificaRiga({ allergies: 'kiwi', note_mediche: 'Allergie (testo storico): kiwi' });
    expect(p.nota).toBeNull();
    expect(p.cambia).toBe(false);
  });

  it('salta le negazioni ("Nessuna allergia nota")', () => {
    expect(pianificaRiga({ allergies: 'Nessuna allergia nota', note_mediche: null }).skip).toBe(true);
    expect(isNegazione('Nessuna allergia nota')).toBe(true);
    expect(isNegazione('lattosio')).toBe(false);
  });
});
