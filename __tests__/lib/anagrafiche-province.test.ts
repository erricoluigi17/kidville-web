import { describe, it, expect } from 'vitest';
import {
  PROVINCE,
  normalizzaProvincia,
  isSiglaProvincia,
} from '@/lib/anagrafiche/province';

describe('PROVINCE', () => {
  it('contiene le 107 province/città metropolitane attuali', () => {
    expect(PROVINCE).toHaveLength(107);
  });

  it('ogni sigla è di 2 lettere maiuscole e unica', () => {
    const sigle = PROVINCE.map((p) => p.sigla);
    for (const s of sigle) {
      expect(s).toMatch(/^[A-Z]{2}$/);
    }
    expect(new Set(sigle).size).toBe(107);
  });

  it('ogni nome è una stringa non vuota e unico', () => {
    const nomi = PROVINCE.map((p) => p.nome);
    for (const n of nomi) {
      expect(typeof n).toBe('string');
      expect(n.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(nomi.map((n) => n.toLowerCase())).size).toBe(107);
  });

  it('include le sigle recenti/particolari', () => {
    const sigle = new Set(PROVINCE.map((p) => p.sigla));
    for (const s of ['SU', 'BT', 'MB', 'FC', 'VB', 'AQ', 'PU', 'MS']) {
      expect(sigle.has(s)).toBe(true);
    }
  });
});

describe('isSiglaProvincia', () => {
  it('riconosce le sigle valide, case-insensitive', () => {
    expect(isSiglaProvincia('NA')).toBe(true);
    expect(isSiglaProvincia('na')).toBe(true);
    expect(isSiglaProvincia('Su')).toBe(true);
  });

  it('rifiuta sigle inesistenti o input non-sigla', () => {
    expect(isSiglaProvincia('XX')).toBe(false);
    expect(isSiglaProvincia('N')).toBe(false);
    expect(isSiglaProvincia('Napoli')).toBe(false);
    expect(isSiglaProvincia('')).toBe(false);
  });
});

describe('normalizzaProvincia', () => {
  it('accetta la sigla già valida e la restituisce MAIUSCOLA', () => {
    expect(normalizzaProvincia('NA')).toBe('NA');
    expect(normalizzaProvincia('na')).toBe('NA');
    expect(normalizzaProvincia('Na')).toBe('NA');
    expect(normalizzaProvincia('SU')).toBe('SU');
    expect(normalizzaProvincia('vb')).toBe('VB');
    expect(normalizzaProvincia('BT')).toBe('BT');
  });

  it('riconosce il nome per esteso (case/accent-insensitive)', () => {
    expect(normalizzaProvincia('Napoli')).toBe('NA');
    expect(normalizzaProvincia('NAPOLI')).toBe('NA');
    expect(normalizzaProvincia(' Caserta ')).toBe('CE');
  });

  it('normalizza trattini, spazi, apostrofi e accenti', () => {
    expect(normalizzaProvincia('Forlì-Cesena')).toBe('FC');
    expect(normalizzaProvincia('forli cesena')).toBe('FC');
    expect(normalizzaProvincia("L'Aquila")).toBe('AQ');
    expect(normalizzaProvincia('laquila')).toBe('AQ');
    expect(normalizzaProvincia('Sud Sardegna')).toBe('SU');
  });

  it('riconosce varianti comuni del nome', () => {
    expect(normalizzaProvincia('Monza e della Brianza')).toBe('MB');
    expect(normalizzaProvincia('Monza Brianza')).toBe('MB');
    expect(normalizzaProvincia('Reggio Emilia')).toBe('RE');
    expect(normalizzaProvincia('Reggio Calabria')).toBe('RC');
  });

  it('restituisce null (mai troncare) su input non riconosciuto', () => {
    expect(normalizzaProvincia('')).toBeNull();
    expect(normalizzaProvincia('   ')).toBeNull();
    expect(normalizzaProvincia('XX')).toBeNull();
    expect(normalizzaProvincia('Pippo')).toBeNull();
    expect(normalizzaProvincia('Napolitano')).toBeNull();
  });

  it('restituisce null su tipi non-stringa', () => {
    expect(normalizzaProvincia(null)).toBeNull();
    expect(normalizzaProvincia(undefined)).toBeNull();
    expect(normalizzaProvincia(42)).toBeNull();
    expect(normalizzaProvincia({})).toBeNull();
    expect(normalizzaProvincia(['NA'])).toBeNull();
  });
});
