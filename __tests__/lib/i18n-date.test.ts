import { describe, it, expect } from 'vitest';
import { formatData, nomeMese } from '@/lib/i18n/date';

// Helper condiviso di formattazione data/ora localizzata. In italiano (locale='it')
// il risultato deve restare IDENTICO a quanto producevano le vecchie chiamate
// `toLocale*String('it-IT', …)`: tutti gli attesi italiani qui sotto sono infatti
// gli stessi di prima del 2026-08-01. In inglese (locale='en') deve localizzare
// mesi e giorni.
//
// L'istante è ASSOLUTO (una `Z` esplicita) e gli attesi sono l'ora di Roma. Prima
// la data si costruiva con componenti locali «per essere indipendenti dal fuso
// della macchina di test»: era vero solo finché anche la formattazione usava il
// fuso della macchina — cioè finché il difetto c'era. Ora il fuso è dichiarato
// (Europe/Rome) e l'unico modo di essere davvero indipendenti è fissare
// l'istante, non i suoi componenti. Il lock che lo prova su più fusi è
// `__tests__/architecture/date-con-timezone.test.ts`.
describe('formatData', () => {
  // 5 novembre 2026, 08:30 UTC = 09:30 a Roma (CET, +1 in novembre).
  const d = new Date('2026-11-05T08:30:00Z');

  it('formato "lunga": giorno mese-per-esteso anno', () => {
    expect(formatData(d, 'it', 'lunga')).toBe('5 novembre 2026');
    // EN: localizzato (mese in inglese), NON più italiano
    expect(formatData(d, 'en', 'lunga')).toContain('November');
    expect(formatData(d, 'en', 'lunga')).not.toContain('novembre');
  });

  it('formato "breve": gg/mm/aaaa in IT e in EN (en-GB, non en-US)', () => {
    expect(formatData(d, 'it', 'breve')).toBe('05/11/2026');
    // La lingua inglese dell'app è en-GB: giorno/mese/anno come in italiano.
    // Con 'en' nudo Intl risolveva en-US e rendeva «11/05/2026» — la stessa
    // stringa letta al contrario, in un prodotto che altrove scriveva en-GB.
    expect(formatData(d, 'en', 'breve')).toBe('05/11/2026');
    expect(formatData(d, 'en', 'breve')).not.toBe('11/05/2026');
  });

  it('formato "ora": solo ore e minuti (nessun campo data iniettato)', () => {
    expect(formatData(d, 'it', 'ora')).toBe('09:30');
    // en-GB usa l'orologio a 24 ore, come l'italiano (en-US userebbe AM/PM).
    expect(formatData(d, 'en', 'ora')).toBe('09:30');
  });

  it('formato "dataOra": data + ora', () => {
    expect(formatData(d, 'it', 'dataOra')).toBe('05/11/2026, 09:30');
    expect(formatData(d, 'en', 'dataOra')).toBe('05/11/2026, 09:30');
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
