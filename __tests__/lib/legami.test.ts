import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getFigliDiGenitore,
  genitoreHasFiglio,
  getGenitoriDiAlunni,
  getGenitoriDiAlunno,
  getGenitoriDiAlunnoEsito,
  getGenitoriDiAlunniEsito,
} from '@/lib/anagrafiche/legami';

/** L'errore di PostgREST come arriva davvero: nel RITORNO, non lanciato. */
type ErroreFinto = { code: string; message: string };

// Mock minimale: from(table) restituisce una catena awaitable (.select().eq()/.in())
// e .maybeSingle(). I filtri eq/in sono ignorati: si testano UNION e FALLBACK
// (la parte logica dell'helper), non il filtro DB.
//
// `errorsByTable` pilota il guasto di UNA sola lettura: è l'unico modo di provare
// che il verdetto di completezza distingue «non c'è» da «non ho potuto leggere».
function makeSupabase(
  rowsByTable: Record<string, Record<string, unknown>[]>,
  errorsByTable: Record<string, ErroreFinto> = {},
): SupabaseClient {
  const make = (rows: Record<string, unknown>[], error: ErroreFinto | null) => {
    const res = Promise.resolve(error ? { data: null, error } : { data: rows, error: null });
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      maybeSingle: () =>
        Promise.resolve(error ? { data: null, error } : { data: rows[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => res.then(onF, onR),
    };
    return chain;
  };
  return {
    from: (t: string) => make(rowsByTable[t] ?? [], errorsByTable[t] ?? null),
  } as unknown as SupabaseClient;
}

describe('getFigliDiGenitore', () => {
  it('runtime: restituisce i figli da legame_genitori_alunni', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1111111-1111-4111-8111-111111111111' }, { alunno_id: 'a2222222-2222-4222-8222-222222222222' }],
      parents: [],
      student_parents: [],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli.sort()).toEqual(['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222']);
  });

  it('fallback: risolve dall\'anagrafica quando il runtime è vuoto', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      parents: [{ id: 'p1' }],
      student_parents: [{ student_id: 'a3333333-3333-4333-8333-333333333333' }],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli).toEqual(['a3333333-3333-4333-8333-333333333333']);
  });

  it('union: dedup tra runtime e anagrafica', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1111111-1111-4111-8111-111111111111' }],
      parents: [{ id: 'p1' }],
      student_parents: [{ student_id: 'a1111111-1111-4111-8111-111111111111' }, { student_id: 'a2222222-2222-4222-8222-222222222222' }],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli.sort()).toEqual(['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222']);
  });

  it('nessun legame: array vuoto', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [], student_parents: [] });
    expect(await getFigliDiGenitore(sb, 'acc1')).toEqual([]);
  });
});

describe('genitoreHasFiglio', () => {
  it('true via fast-path runtime', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [{ alunno_id: 'a1111111-1111-4111-8111-111111111111' }], parents: [], student_parents: [] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'a1111111-1111-4111-8111-111111111111')).toBe(true);
  });

  it('true via fallback anagrafico', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [{ id: 'p1' }], student_parents: [{ student_id: 'a3333333-3333-4333-8333-333333333333' }] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'a3333333-3333-4333-8333-333333333333')).toBe(true);
  });

  it('false se non collegato in nessuna delle due', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [{ id: 'p1' }], student_parents: [{ student_id: 'a3333333-3333-4333-8333-333333333333' }] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'aX')).toBe(false);
  });
});

describe('getGenitoriDiAlunni (verso inverso: alunno → account genitore)', () => {
  it('runtime: mappa alunno → genitori da legame_genitori_alunni', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [
        { alunno_id: 'a1111111-1111-4111-8111-111111111111', genitore_id: 'acc1' },
        { alunno_id: 'a1111111-1111-4111-8111-111111111111', genitore_id: 'acc2' },
      ],
      student_parents: [],
      parents: [],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1111111-1111-4111-8111-111111111111']);
    expect((mappa.get('a1111111-1111-4111-8111-111111111111') ?? []).sort()).toEqual(['acc1', 'acc2']);
  });

  it('fallback: risolve dall\'anagrafica via ponte parents.auth_user_id', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      student_parents: [{ student_id: 'a1111111-1111-4111-8111-111111111111', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1111111-1111-4111-8111-111111111111']);
    expect(mappa.get('a1111111-1111-4111-8111-111111111111')).toEqual(['acc9']);
  });

  it('parents senza account (auth_user_id null) non produce destinatari', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      student_parents: [{ student_id: 'a1111111-1111-4111-8111-111111111111', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: null }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1111111-1111-4111-8111-111111111111']);
    expect(mappa.get('a1111111-1111-4111-8111-111111111111') ?? []).toEqual([]);
  });

  it('union: dedup fra runtime e anagrafica', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1111111-1111-4111-8111-111111111111', genitore_id: 'acc1' }],
      student_parents: [{ student_id: 'a1111111-1111-4111-8111-111111111111', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc1' }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1111111-1111-4111-8111-111111111111']);
    expect(mappa.get('a1111111-1111-4111-8111-111111111111')).toEqual(['acc1']);
  });

  it('lista vuota: nessuna query, mappa vuota', async () => {
    const sb = makeSupabase({});
    expect((await getGenitoriDiAlunni(sb, [])).size).toBe(0);
  });
});

describe('getGenitoriDiAlunno', () => {
  it('restituisce i genitori anche quando il legame è solo in student_parents', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      student_parents: [{ student_id: 'a1111111-1111-4111-8111-111111111111', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
    });
    expect(await getGenitoriDiAlunno(sb, 'a1111111-1111-4111-8111-111111111111')).toEqual(['acc9']);
  });

  it('array vuoto quando non c\'è alcun legame', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], student_parents: [], parents: [] });
    expect(await getGenitoriDiAlunno(sb, 'a1111111-1111-4111-8111-111111111111')).toEqual([]);
  });
});

/**
 * IL VERSO INVERSO AVEVA UN SILENZIO SOLO, DOVE L'ANDATA NE HA TRE.
 *
 * `getFigliDiGenitoreEsito` distingue da tempo «non ci sono figli» da «non ho
 * potuto leggere»; il verso alunno → genitori no: le tre letture loggavano un
 * `warn` e proseguivano, e chi le usava per RIFIUTARE (l'emissione di una
 * fattura: «questo adulto non è un genitore di questo bambino», 422) leggeva
 * come risposta di merito ciò che era un guasto del database.
 *
 * `completo: false` significa esattamente «l'elenco può essere corto: non
 * trarne conclusioni negative». Chi ELENCA (mensa, diario, solleciti, merch,
 * modulistica) può continuare a ignorarlo — mostrerà meno destinatari, non i
 * destinatari di un altro — e per questo `getGenitoriDiAlunno` non cambia.
 *
 * «SCHEMA ASSENTE» NON È UN GUASTO: sul DB E2E della CI, mai migrato, una delle
 * sorgenti può non esistere affatto (`PGRST205`, `42P01`, `42703`). Trattarlo da
 * guasto renderebbe `completo: false` OGNI verifica in CI, cioè un 503 su ogni
 * emissione con intestatario scelto.
 */
describe('getGenitoriDiAlunnoEsito — «non lo so» non è «no»', () => {
  const ALUNNO = 'a1111111-1111-4111-8111-111111111111';
  const ACCOUNT_ANAGRAFICA = 'acc99999-9999-4999-8999-999999999999';
  const ACCOUNT_RUNTIME = 'acc11111-1111-4111-8111-111111111111';
  /** `57014`: statement timeout. Un guasto vero, non uno schema che non c'è. */
  const GUASTO: ErroreFinto = { code: '57014', message: 'canceling statement due to statement timeout' };

  const conAnagrafica = {
    legame_genitori_alunni: [{ alunno_id: ALUNNO, genitore_id: ACCOUNT_RUNTIME }],
    student_parents: [{ student_id: ALUNNO, parent_id: 'p1' }],
    parents: [{ id: 'p1', auth_user_id: ACCOUNT_ANAGRAFICA }],
  };

  it('lettura pulita → completo=true (senza questa riga, «sempre false» passerebbe le altre)', async () => {
    const esito = await getGenitoriDiAlunnoEsito(makeSupabase(conAnagrafica), ALUNNO);
    expect(esito.completo).toBe(true);
    expect(esito.genitori.sort()).toEqual([ACCOUNT_ANAGRAFICA, ACCOUNT_RUNTIME].sort());
  });

  it('guasto su `legame_genitori_alunni` → completo=false, e i genitori delle altre sorgenti ci sono', async () => {
    const esito = await getGenitoriDiAlunnoEsito(
      makeSupabase(conAnagrafica, { legame_genitori_alunni: GUASTO }),
      ALUNNO,
    );
    expect(esito.completo, 'una lettura fallita non può uscire come «non è un genitore»').toBe(false);
    // L'elenco NON si azzera: l'altra sorgente ha risposto e quel genitore esiste.
    expect(esito.genitori).toEqual([ACCOUNT_ANAGRAFICA]);
  });

  it('`PGRST205` su `legame_genitori_alunni` (DB CI non migrato) → completo=true', async () => {
    const esito = await getGenitoriDiAlunnoEsito(
      makeSupabase(conAnagrafica, { legame_genitori_alunni: { code: 'PGRST205', message: 'Could not find the table' } }),
      ALUNNO,
    );
    expect(esito.completo, 'lo schema assente in CI non è un guasto: 503 su ogni emissione').toBe(true);
    expect(esito.genitori).toEqual([ACCOUNT_ANAGRAFICA]);
  });

  it('guasto su `student_parents` → completo=false, e il genitore runtime c\'è', async () => {
    const esito = await getGenitoriDiAlunnoEsito(
      makeSupabase(conAnagrafica, { student_parents: GUASTO }),
      ALUNNO,
    );
    expect(esito.completo).toBe(false);
    expect(esito.genitori).toEqual([ACCOUNT_RUNTIME]);
  });

  it('guasto sul ponte `parents` → completo=false (il legame anagrafico resta irrisolto)', async () => {
    const esito = await getGenitoriDiAlunnoEsito(
      makeSupabase(conAnagrafica, { parents: GUASTO }),
      ALUNNO,
    );
    expect(esito.completo).toBe(false);
    expect(esito.genitori).toEqual([ACCOUNT_RUNTIME]);
  });

  it('il wrapper `getGenitoriDiAlunno` NON cambia: stesso elenco anche col guasto', async () => {
    // I sei chiamanti storici (solleciti, mensa, merch, diario, modulistica,
    // `determinaQuoteFatturazione` in `intestatari.ts`) restano identici:
    // elencano, non rifiutano.
    const sb = makeSupabase(conAnagrafica, { legame_genitori_alunni: GUASTO });
    expect(await getGenitoriDiAlunno(sb, ALUNNO)).toEqual([ACCOUNT_ANAGRAFICA]);
  });

  it('in BLOCCO: il verdetto vale per l\'intera lettura, non per il singolo alunno', async () => {
    const ALTRO = 'a2222222-2222-4222-8222-222222222222';
    const esito = await getGenitoriDiAlunniEsito(
      makeSupabase(conAnagrafica, { legame_genitori_alunni: GUASTO }),
      [ALUNNO, ALTRO],
    );
    expect(esito.completo).toBe(false);
    expect(esito.perAlunno.get(ALUNNO)).toEqual([ACCOUNT_ANAGRAFICA]);
    // La mappa resta quella di prima: il flag si aggiunge, non sostituisce.
    expect(await getGenitoriDiAlunni(makeSupabase(conAnagrafica), [ALUNNO])).toBeInstanceOf(Map);
  });
});
