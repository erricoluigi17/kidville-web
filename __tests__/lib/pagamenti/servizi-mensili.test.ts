import { describe, expect, it } from 'vitest';
import {
  attivaNel,
  mesiCoperti,
  periodiSovrapposti,
  periodoValido,
  primoDelMese,
  zMese,
  type PeriodoIscrizione,
} from '@/lib/pagamenti/servizi-mensili';

const p = (dal: string, al: string | null = null): PeriodoIscrizione => ({ dal, al });

describe('zMese', () => {
  it('accetta un mese YYYY-MM', () => {
    expect(zMese.safeParse('2026-10').success).toBe(true);
    expect(zMese.safeParse('2026-01').success).toBe(true);
    expect(zMese.safeParse('2026-12').success).toBe(true);
  });

  it.each(['2026-13', '2026-1', '26-10', '', '2026-00', '2026-10-01'])('rifiuta %j', (v) => {
    const r = zMese.safeParse(v);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/mese/i);
  });
});

describe('primoDelMese', () => {
  it('da YYYY-MM a YYYY-MM-01', () => {
    expect(primoDelMese('2026-10')).toBe('2026-10-01');
  });
  it('da YYYY-MM-DD al primo di quel mese', () => {
    expect(primoDelMese('2026-10-17')).toBe('2026-10-01');
    expect(primoDelMese('2026-10-01')).toBe('2026-10-01');
  });
});

describe('attivaNel', () => {
  const i = p('2026-10-01', '2026-12-01');
  it('falso prima di dal', () => expect(attivaNel(i, '2026-09-01')).toBe(false));
  it('vero nel mese dal', () => expect(attivaNel(i, '2026-10-01')).toBe(true));
  it('vero dentro', () => expect(attivaNel(i, '2026-11-01')).toBe(true));
  it('vero nel mese al (compreso)', () => expect(attivaNel(i, '2026-12-01')).toBe(true));
  it('falso dopo al', () => expect(attivaNel(i, '2027-01-01')).toBe(false));
  it('al nullo: sempre attiva dopo dal', () => {
    expect(attivaNel(p('2026-10-01'), '2030-05-01')).toBe(true);
    expect(attivaNel(p('2026-10-01'), '2026-09-01')).toBe(false);
  });
});

describe('periodiSovrapposti', () => {
  const sim = (a: PeriodoIscrizione, b: PeriodoIscrizione, atteso: boolean) => {
    expect(periodiSovrapposti(a, b)).toBe(atteso);
    expect(periodiSovrapposti(b, a)).toBe(atteso);
  };
  it('identici', () => sim(p('2026-10-01', '2026-12-01'), p('2026-10-01', '2026-12-01'), true));
  it('uno contenuto nell’altro', () => sim(p('2026-10-01', '2027-06-01'), p('2026-12-01', '2027-01-01'), true));
  it('a cavallo', () => sim(p('2026-10-01', '2026-12-01'), p('2026-12-01', '2027-03-01'), true));
  it('adiacenti: non si sovrappongono', () => sim(p('2026-01-01', '2026-03-01'), p('2026-04-01'), false));
  it('entrambi senza fine', () => sim(p('2026-10-01'), p('2027-02-01'), true));
  it('uno senza fine che parte dopo la fine dell’altro', () =>
    sim(p('2026-10-01', '2026-12-01'), p('2027-01-01'), false));
  it('un solo mese in comune', () => sim(p('2026-10-01', '2026-10-01'), p('2026-10-01', '2026-10-01'), true));
  it('senza fine che parte prima di un periodo chiuso', () => sim(p('2026-09-01'), p('2026-10-01', '2026-12-01'), true));
});

describe('periodoValido', () => {
  it('valido con al nullo o uguale a dal', () => {
    expect(periodoValido(p('2026-10-01'))).toBe(true);
    expect(periodoValido(p('2026-10-01', '2026-10-01'))).toBe(true);
    expect(periodoValido(p('2026-10-01', '2027-06-01'))).toBe(true);
  });
  it('al < dal è falso', () => expect(periodoValido(p('2026-10-01', '2026-09-01'))).toBe(false));
  it('giorno diverso da 1 è falso', () => {
    expect(periodoValido(p('2026-10-15'))).toBe(false);
    expect(periodoValido(p('2026-10-01', '2026-12-31'))).toBe(false);
  });
});

describe('mesiCoperti', () => {
  it('scavalco d’anno dic–feb', () => {
    expect(mesiCoperti(p('2026-12-01', '2027-02-01'), '2026-09-01', '2027-08-01')).toEqual([
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
  it('al nullo: fino a fine intervallo', () => {
    expect(mesiCoperti(p('2027-06-01'), '2026-09-01', '2027-08-01')).toEqual([
      '2027-06-01',
      '2027-07-01',
      '2027-08-01',
    ]);
  });
  it('intervallo fuori dall’iscrizione: vuoto', () => {
    expect(mesiCoperti(p('2026-10-01', '2026-10-01'), '2026-11-01', '2026-12-01')).toEqual([]);
  });
});
