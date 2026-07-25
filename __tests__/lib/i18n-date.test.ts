import { describe, it, expect } from 'vitest';
import { formatData, nomeMese } from '@/lib/i18n/date';

// Helper condiviso di formattazione data/ora localizzata. In italiano (locale='it')
// il risultato deve restare IDENTICO a quanto producevano le vecchie chiamate
// `toLocale*String('it-IT', …)`; in inglese (locale='en') deve localizzare mesi e
// giorni. Le date sono costruite con componenti LOCALI (new Date(anno, meseIdx, …))
// per essere indipendenti dal fuso orario della macchina di test.
describe('formatData', () => {
  // 5 novembre 2026, 09:30 in ora locale
  const d = new Date(2026, 10, 5, 9, 30, 0);

  it('formato "lunga": giorno mese-per-esteso anno', () => {
    expect(formatData(d, 'it', 'lunga')).toBe('5 novembre 2026');
    // EN: localizzato (mese in inglese), NON più italiano
    expect(formatData(d, 'en', 'lunga')).toContain('November');
    expect(formatData(d, 'en', 'lunga')).not.toContain('novembre');
  });

  it('formato "breve": gg/mm/aaaa in IT, localizzato in EN', () => {
    expect(formatData(d, 'it', 'breve')).toBe('05/11/2026');
    // EN usa l'ordine mese/giorno
    expect(formatData(d, 'en', 'breve')).toBe('11/05/2026');
  });

  it('formato "ora": solo ore e minuti (nessun campo data iniettato)', () => {
    expect(formatData(d, 'it', 'ora')).toBe('09:30');
    // In EN l'ora è a 12h con AM/PM
    expect(formatData(d, 'en', 'ora')).toContain('AM');
  });

  it('formato "dataOra": data + ora', () => {
    expect(formatData(d, 'it', 'dataOra')).toBe('05/11/2026, 09:30');
    // EN: ordine mese/giorno e ora a 12h
    expect(formatData(d, 'en', 'dataOra')).toContain('11/05/2026');
    expect(formatData(d, 'en', 'dataOra')).toContain('AM');
  });

  it('formato "giornoMese": giorno + mese per esteso, senza anno', () => {
    expect(formatData(d, 'it', 'giornoMese')).toBe('5 novembre');
    expect(formatData(d, 'en', 'giornoMese')).toContain('November');
  });

  it('formato "meseAnno": mese per esteso + anno', () => {
    expect(formatData(d, 'it', 'meseAnno')).toBe('novembre 2026');
    expect(formatData(d, 'en', 'meseAnno')).toContain('November');
  });

  it('accetta stringhe e numeri come input', () => {
    expect(formatData('2026-11-05', 'it', 'breve')).toBe('05/11/2026');
    expect(formatData(d.getTime(), 'it', 'breve')).toBe('05/11/2026');
  });

  it('input non valido → stringa vuota (mai «Invalid Date»)', () => {
    expect(formatData(null, 'it', 'lunga')).toBe('');
    expect(formatData(undefined, 'it', 'lunga')).toBe('');
    expect(formatData('', 'it', 'lunga')).toBe('');
    expect(formatData('non-una-data', 'it', 'breve')).toBe('');
  });
});

describe('nomeMese', () => {
  it('rende il nome del mese (1-12) capitalizzato, localizzato', () => {
    expect(nomeMese(1, 'it')).toBe('Gennaio');
    expect(nomeMese(11, 'it')).toBe('Novembre');
    expect(nomeMese(12, 'it')).toBe('Dicembre');
    expect(nomeMese(1, 'en')).toBe('January');
    expect(nomeMese(11, 'en')).toBe('November');
  });

  it('mese fuori range → stringa vuota', () => {
    expect(nomeMese(0, 'it')).toBe('');
    expect(nomeMese(13, 'it')).toBe('');
    expect(nomeMese(NaN, 'it')).toBe('');
  });
});
