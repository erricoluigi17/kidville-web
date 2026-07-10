import { describe, it, expect } from 'vitest';
import { titleCaseNome, nomeCompleto } from '@/lib/format/nome';

describe('titleCaseNome', () => {
  it('mette in maiuscolo l\'iniziale di ogni parola da minuscolo', () => {
    expect(titleCaseNome('esposito gaia')).toBe('Esposito Gaia');
  });

  it('normalizza da MAIUSCOLO', () => {
    expect(titleCaseNome('MARIA ROSSI')).toBe('Maria Rossi');
  });

  it('gestisce apostrofo e trattino', () => {
    expect(titleCaseNome("d'angelo")).toBe("D'Angelo");
    expect(titleCaseNome('anna-maria')).toBe('Anna-Maria');
  });

  it('è sicuro su valori vuoti/nulli', () => {
    expect(titleCaseNome('')).toBe('');
    expect(titleCaseNome(null)).toBe('');
    expect(titleCaseNome(undefined)).toBe('');
  });
});

describe('nomeCompleto', () => {
  it('compone nome-cognome di default', () => {
    expect(nomeCompleto('gaia', 'esposito')).toBe('Gaia Esposito');
  });

  it('compone cognome-nome quando richiesto', () => {
    expect(nomeCompleto('gaia', 'esposito', 'cognome-nome')).toBe('Esposito Gaia');
  });

  it('salta i campi mancanti senza spazi doppi', () => {
    expect(nomeCompleto('gaia', null)).toBe('Gaia');
    expect(nomeCompleto(null, 'esposito', 'cognome-nome')).toBe('Esposito');
    expect(nomeCompleto(undefined, undefined)).toBe('');
  });
});
