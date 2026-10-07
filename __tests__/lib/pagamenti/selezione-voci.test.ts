import { describe, expect, it } from 'vitest';
import {
  annoScolasticoDi,
  eMeseDiRetta,
  eVistaPerAlunno,
  etichettaMese,
  etichettaMesi,
  filtraPerSelezione,
  meseDellaVoce,
  meseDi,
  mesiAnnoScolastico,
  periodoDi,
  type SelezioneVoci,
  type VoceDatata,
} from '@/lib/pagamenti/selezione-voci';

const RETTA = 'cat-retta';
const MENSA = 'cat-mensa';

const sel = (s: Partial<SelezioneVoci>): SelezioneVoci => ({ categorie: [], anno: 2026, mesi: [], ...s });

describe('periodoDi / mesiAnnoScolastico', () => {
  it('settembre-dicembre cadono nell\'anno, gennaio-agosto nel successivo', () => {
    expect(periodoDi(2026, 9)).toBe('2026-09-01');
    expect(periodoDi(2026, 12)).toBe('2026-12-01');
    expect(periodoDi(2026, 1)).toBe('2027-01-01');
    expect(periodoDi(2026, 8)).toBe('2027-08-01');
  });

  it('i 12 mesi vanno da settembre ad agosto', () => {
    const m = mesiAnnoScolastico(2026);
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ mese: 9, periodo: '2026-09-01' });
    expect(m[11]).toEqual({ mese: 8, periodo: '2027-08-01' });
  });
});

describe('meseDellaVoce', () => {
  it('periodo_competenza vince sulla scadenza', () => {
    expect(meseDellaVoce({ periodo_competenza: '2026-10-01', scadenza: '2026-11-05' })).toBe('2026-10');
  });
  it('senza periodo si usa il mese della scadenza (anche con orario)', () => {
    expect(meseDellaVoce({ periodo_competenza: null, scadenza: '2026-11-05' })).toBe('2026-11');
    expect(meseDellaVoce({ scadenza: '2026-12-31T10:00:00Z' })).toBe('2026-12');
  });
  it('senza date è null', () => {
    expect(meseDellaVoce({})).toBeNull();
    expect(meseDellaVoce({ periodo_competenza: '', scadenza: null })).toBeNull();
  });
});

describe('annoScolasticoDi / meseDi', () => {
  it('agosto appartiene all\'anno scolastico precedente, settembre al nuovo', () => {
    expect(annoScolasticoDi('2026-08-03')).toBe(2025);
    expect(annoScolasticoDi('2026-09-01')).toBe(2026);
    expect(annoScolasticoDi('2027-01-15')).toBe(2026);
  });
  it('meseDi restituisce 1..12', () => {
    expect(meseDi('2026-10-07')).toBe(10);
    expect(meseDi('2026-01-07')).toBe(1);
  });
});

describe('filtraPerSelezione', () => {
  const voci: (VoceDatata & { id: string })[] = [
    { id: 'retta-set-senza-periodo', categoria_id: RETTA, scadenza: '2026-09-05' },
    { id: 'retta-ott', categoria_id: RETTA, periodo_competenza: '2026-10-01', scadenza: '2026-11-05' },
    { id: 'mensa-ott', categoria_id: MENSA, scadenza: '2026-10-20' },
    { id: 'mensa-lug-27', categoria_id: MENSA, scadenza: '2027-07-10' },
    { id: 'mensa-ago-26', categoria_id: MENSA, scadenza: '2026-08-10' },
    { id: 'mensa-set-27', categoria_id: MENSA, scadenza: '2027-09-10' },
    { id: 'senza-categoria', categoria_id: null, scadenza: '2026-10-02' },
    { id: 'senza-date', categoria_id: RETTA },
  ];
  const ids = (r: { id: string }[]) => r.map((v) => v.id);

  it('una retta senza periodo cade nel mese della scadenza', () => {
    expect(ids(filtraPerSelezione(voci, sel({ categorie: [RETTA], mesi: [9] })))).toEqual(['retta-set-senza-periodo']);
  });

  it('periodo_competenza vince sulla scadenza (ottobre, non novembre)', () => {
    expect(ids(filtraPerSelezione(voci, sel({ categorie: [RETTA], mesi: [10] })))).toEqual(['retta-ott']);
    expect(ids(filtraPerSelezione(voci, sel({ categorie: [RETTA], mesi: [11] })))).toEqual([]);
  });

  it('«tutto l\'anno» 2026 include luglio 2027, esclude agosto 2026 e settembre 2027, e le voci senza date', () => {
    const r = ids(filtraPerSelezione(voci, sel({})));
    expect(r).toContain('mensa-lug-27');
    expect(r).not.toContain('mensa-ago-26');
    expect(r).not.toContain('mensa-set-27');
    expect(r).not.toContain('senza-date');
  });

  it('combina più categorie e più mesi', () => {
    const r = filtraPerSelezione(voci, sel({ categorie: [RETTA, MENSA], mesi: [9, 10] }));
    expect(ids(r)).toEqual(['retta-set-senza-periodo', 'retta-ott', 'mensa-ott']);
  });

  it('categorie vuote = tutte, compresa la voce senza categoria', () => {
    expect(ids(filtraPerSelezione(voci, sel({ mesi: [10] })))).toEqual(['retta-ott', 'mensa-ott', 'senza-categoria']);
  });

  it('una voce senza categoria non entra se si sceglie una categoria', () => {
    expect(ids(filtraPerSelezione(voci, sel({ categorie: [MENSA], mesi: [10] })))).toEqual(['mensa-ott']);
  });

  it('mese 7 e 8 dell\'anno scolastico cadono nell\'anno successivo', () => {
    expect(ids(filtraPerSelezione(voci, sel({ mesi: [7] })))).toEqual(['mensa-lug-27']);
    expect(ids(filtraPerSelezione(voci, sel({ mesi: [8] })))).toEqual([]);
  });
});

describe('eVistaPerAlunno', () => {
  it('vera solo con retta unica e un solo mese', () => {
    expect(eVistaPerAlunno(sel({ categorie: [RETTA], mesi: [10] }), RETTA)).toBe(true);
  });
  it('falsa con due mesi, due categorie, nessun mese o rettaId assente', () => {
    expect(eVistaPerAlunno(sel({ categorie: [RETTA], mesi: [10, 11] }), RETTA)).toBe(false);
    expect(eVistaPerAlunno(sel({ categorie: [RETTA, MENSA], mesi: [10] }), RETTA)).toBe(false);
    expect(eVistaPerAlunno(sel({ categorie: [RETTA], mesi: [] }), RETTA)).toBe(false);
    expect(eVistaPerAlunno(sel({ categorie: [RETTA], mesi: [10] }), undefined)).toBe(false);
    expect(eVistaPerAlunno(sel({ categorie: [MENSA], mesi: [10] }), RETTA)).toBe(false);
  });
});

describe('eMeseDiRetta', () => {
  it('settembre-giugno sì, luglio e agosto no', () => {
    expect(eMeseDiRetta(6)).toBe(true);
    expect(eMeseDiRetta(7)).toBe(false);
    expect(eMeseDiRetta(8)).toBe(false);
    expect(eMeseDiRetta(9)).toBe(true);
    expect(eMeseDiRetta(1)).toBe(true);
  });
});

describe('etichette', () => {
  it('etichettaMese corta: iniziale maiuscola', () => {
    expect(etichettaMese('2026-10-01', 'it', 'corta')).toBe('Ott 2026');
  });
  it('etichettaMese lunga: minuscolo per esteso', () => {
    expect(etichettaMese('2026-10-01', 'it', 'lunga')).toBe('ottobre 2026');
    expect(etichettaMese('2027-01-01', 'it', 'lunga')).toBe('gennaio 2027');
  });
  it('lingua inglese', () => {
    expect(etichettaMese('2026-10-01', 'en', 'corta')).toBe('Oct 2026');
    expect(etichettaMese('2026-10-01', 'en', 'lunga')).toBe('October 2026');
  });
  it('lingua inglese: intervalli e mesi isolati seguono le maiuscole di Intl', () => {
    expect(etichettaMesi(sel({ mesi: [9, 10] }), 'en')).toBe('Sept–Oct 2026'); // l'inglese dell'app è en-GB: settembre = «Sept»
    expect(etichettaMesi(sel({ mesi: [12, 1] }), 'en')).toBe('Dec 2026–Jan 2027');
    expect(etichettaMesi(sel({ mesi: [10] }), 'en')).toBe('October 2026');
  });

  it('nessun mese = null (tutto l\'anno)', () => {
    expect(etichettaMesi(sel({ mesi: [] }), 'it')).toBeNull();
  });
  it('un mese: forma lunga', () => {
    expect(etichettaMesi(sel({ mesi: [10] }), 'it')).toBe('ottobre 2026');
  });
  it('intervallo contiguo, anno una volta sola', () => {
    expect(etichettaMesi(sel({ mesi: [9, 10] }), 'it')).toBe('set–ott 2026');
    expect(etichettaMesi(sel({ mesi: [10, 9, 11] }), 'it')).toBe('set–nov 2026');
  });
  it('intervallo a cavallo d\'anno: due anni', () => {
    expect(etichettaMesi(sel({ mesi: [12, 1] }), 'it')).toBe('dic 2026–gen 2027');
  });
  it('mesi non contigui: elenco separato da virgola', () => {
    expect(etichettaMesi(sel({ mesi: [9, 11] }), 'it')).toBe('set 2026, nov 2026');
    expect(etichettaMesi(sel({ mesi: [11, 9, 10, 1] }), 'it')).toBe('set–nov 2026, gen 2027');
  });
  it('duplicati ignorati; il primo gennaio-agosto prende l\'anno dopo', () => {
    expect(etichettaMesi(sel({ mesi: [10, 10] }), 'it')).toBe('ottobre 2026');
    expect(etichettaMesi(sel({ mesi: [7, 8] }), 'it')).toBe('lug–ago 2027');
  });
});
