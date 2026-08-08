import { describe, it, expect } from 'vitest';
import { titleCaseNome, nomeCompleto } from '@/lib/format/nome';

// ⚠️ I NOMI DI QUESTO FILE SONO INVENTATI, E DEVONO RESTARE INVENTATI.
// Fino al 2026-08-08 la fixture era l'anagrafica di una bambina VERA, copiata dal
// database di produzione con dentro anche il suo difetto di formato (minuscolo,
// doppio spazio) — il segno che era stata presa dal vivo e non pensata. Il repo è
// pubblico. Un test sul formato di un nome non ha bisogno di un nome vero: ha
// bisogno di una forma, e «nuvola bianca» ha la stessa identica forma.

describe('titleCaseNome', () => {
  it('mette in maiuscolo l\'iniziale di ogni parola da minuscolo', () => {
    expect(titleCaseNome('nuvola bianca')).toBe('Nuvola Bianca');
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
    expect(nomeCompleto('bianca', 'nuvola')).toBe('Bianca Nuvola');
  });

  it('compone cognome-nome quando richiesto', () => {
    expect(nomeCompleto('bianca', 'nuvola', 'cognome-nome')).toBe('Nuvola Bianca');
  });

  it('salta i campi mancanti senza spazi doppi', () => {
    expect(nomeCompleto('bianca', null)).toBe('Bianca');
    expect(nomeCompleto(null, 'nuvola', 'cognome-nome')).toBe('Nuvola');
    expect(nomeCompleto(undefined, undefined)).toBe('');
  });
});
