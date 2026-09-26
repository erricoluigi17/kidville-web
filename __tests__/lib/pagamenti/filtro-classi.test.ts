import { describe, it, expect } from 'vitest';
import {
  classiDaAlunni,
  etichettaClasse,
  filtraPerClassi,
  NOME_CLASSE_ASSENTE,
  type ClasseFiltro,
} from '@/lib/pagamenti/filtro-classi';

// =============================================================================
// Filtro per classe della contabilità (K6) — la parte pura.
//
// La decisione del titolare che questi test difendono: con più sedi le classi
// OMONIME restano SEPARATE. «Sezione A» di Giugliano e «Sezione A» di Aversa
// sono due classi, due `section_id`, due voci del filtro. Unirle per nome
// sarebbe lo stesso difetto che il lock `nome-classe-con-sede` sorveglia sulle
// query: un nome di classe senza la sede non seleziona niente di preciso.
//
// Dati inventati: uuid finti, nessun nome di persona (il repo è pubblico).
// =============================================================================

// Gli id delle sedi sono volutamente in un ordine DIVERSO da quello dei nomi
// (id: Giugliano < Cesa < Aversa; nomi: Aversa < Cesa < Giugliano). In
// produzione gli scuola_id sono uuid: se il modulo ordinasse per id invece che
// per nome, il test «ordina per sede» se ne accorgerebbe.
const GIU = 'sede-1';
const CES = 'sede-2';
const AVE = 'sede-3';
const NOMI = { [GIU]: 'Giugliano', [AVE]: 'Aversa', [CES]: 'Cesa' };

const alunno = (section_id: string | null, classe_sezione: string | null, scuola_id: string | null) => ({
  section_id,
  classe_sezione,
  scuola_id,
});

describe('classiDaAlunni', () => {
  it('tiene SEPARATE le classi omonime di sedi diverse (una voce per section_id)', () => {
    const classi = classiDaAlunni(
      [alunno('sec-a-giu', 'Sezione A', GIU), alunno('sec-a-ave', 'Sezione A', AVE)],
      NOMI,
    );
    expect(classi).toHaveLength(2);
    expect(classi.map((c) => c.id).sort()).toEqual(['sec-a-ave', 'sec-a-giu']);
    expect(classi.find((c) => c.id === 'sec-a-giu')).toEqual({
      id: 'sec-a-giu',
      nome: 'Sezione A',
      scuolaId: GIU,
      scuolaNome: 'Giugliano',
    });
  });

  it('una classe con molti alunni compare una volta sola', () => {
    const classi = classiDaAlunni(
      [alunno('s1', 'Sezione A', GIU), alunno('s1', 'Sezione A', GIU), alunno('s1', 'Sezione A', GIU)],
      NOMI,
    );
    expect(classi).toHaveLength(1);
  });

  it('esclude gli alunni senza section_id', () => {
    const classi = classiDaAlunni([alunno(null, 'Sezione A', GIU), alunno('s2', 'Sezione B', GIU)], NOMI);
    expect(classi.map((c) => c.id)).toEqual(['s2']);
  });

  it('ordina per sede e poi per nome (numeri in ordine naturale)', () => {
    const classi = classiDaAlunni(
      [
        alunno('g-10', 'Sezione 10', GIU),
        alunno('c-b', 'Sezione B', CES),
        alunno('g-2', 'Sezione 2', GIU),
        alunno('a-b', 'Sezione B', AVE),
        alunno('a-a', 'Sezione A', AVE),
      ],
      NOMI,
    );
    expect(classi.map((c) => c.id)).toEqual(['a-a', 'a-b', 'c-b', 'g-2', 'g-10']);
  });

  it('se il nome manca sul primo alunno lo prende dal primo che lo ha', () => {
    const classi = classiDaAlunni([alunno('s1', null, GIU), alunno('s1', '  Sezione C ', GIU)], NOMI);
    expect(classi[0].nome).toBe('Sezione C');
  });

  it('una classe senza nome su nessun alunno prende il ripiego ESPORTATO (che il componente traduce)', () => {
    const classi = classiDaAlunni([alunno('s1', null, GIU), alunno('s1', '   ', GIU)], NOMI);
    expect(classi[0].nome).toBe(NOME_CLASSE_ASSENTE);
    expect(NOME_CLASSE_ASSENTE).toBe('—');
  });

  it('una sede assente dalla mappa dei nomi non inventa un nome', () => {
    const classi = classiDaAlunni([alunno('s1', 'Sezione A', 'sede-sconosciuta')], NOMI);
    expect(classi[0]).toMatchObject({ scuolaId: 'sede-sconosciuta', scuolaNome: '' });
  });
});

describe('etichettaClasse', () => {
  const c: ClasseFiltro = { id: 's1', nome: 'Sezione A', scuolaId: GIU, scuolaNome: 'Giugliano' };

  it('con una sede sola: solo il nome', () => {
    expect(etichettaClasse(c, false)).toBe('Sezione A');
  });

  it('con più sedi: «nome — sede»', () => {
    expect(etichettaClasse(c, true)).toBe('Sezione A — Giugliano');
  });

  it('senza il nome della sede non lascia un trattino appeso', () => {
    expect(etichettaClasse({ ...c, scuolaNome: '' }, true)).toBe('Sezione A');
  });
});

describe('filtraPerClassi', () => {
  type Riga = { id: number; sec: string | null };
  const righe: Riga[] = [
    { id: 1, sec: 'sec-a-giu' },
    { id: 2, sec: 'sec-a-ave' },
    { id: 3, sec: null },
    { id: 4, sec: 'sec-b-giu' },
  ];
  const di = (r: Riga) => r.sec;

  it('nessuna classe selezionata = nessun filtro (anche le righe senza classe restano)', () => {
    expect(filtraPerClassi(righe, [], di).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('filtra per section_id, non per nome: Sezione A di Giugliano NON porta Aversa', () => {
    expect(filtraPerClassi(righe, ['sec-a-giu'], di).map((r) => r.id)).toEqual([1]);
  });

  it('selezione multipla: unione delle classi scelte, righe senza classe escluse', () => {
    expect(filtraPerClassi(righe, ['sec-a-giu', 'sec-b-giu'], di).map((r) => r.id)).toEqual([1, 4]);
  });

  it('non muta l’array di partenza', () => {
    const copia = [...righe];
    filtraPerClassi(righe, ['sec-a-giu'], di);
    expect(righe).toEqual(copia);
  });
});
