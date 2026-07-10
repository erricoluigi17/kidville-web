import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFigliDiGenitore, genitoreHasFiglio } from '@/lib/anagrafiche/legami';

// Mock minimale: from(table) restituisce una catena awaitable (.select().eq()/.in())
// e .maybeSingle(). I filtri eq/in sono ignorati: si testano UNION e FALLBACK
// (la parte logica dell'helper), non il filtro DB.
function makeSupabase(rowsByTable: Record<string, Record<string, unknown>[]>): SupabaseClient {
  const make = (rows: Record<string, unknown>[]) => {
    const res = Promise.resolve({ data: rows, error: null });
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => res.then(onF, onR),
    };
    return chain;
  };
  return {
    from: (t: string) => make(rowsByTable[t] ?? []),
  } as unknown as SupabaseClient;
}

describe('getFigliDiGenitore', () => {
  it('runtime: restituisce i figli da legame_genitori_alunni', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1' }, { alunno_id: 'a2' }],
      parents: [],
      student_parents: [],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli.sort()).toEqual(['a1', 'a2']);
  });

  it('fallback: risolve dall\'anagrafica quando il runtime è vuoto', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      parents: [{ id: 'p1' }],
      student_parents: [{ student_id: 'a3' }],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli).toEqual(['a3']);
  });

  it('union: dedup tra runtime e anagrafica', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1' }],
      parents: [{ id: 'p1' }],
      student_parents: [{ student_id: 'a1' }, { student_id: 'a2' }],
    });
    const figli = await getFigliDiGenitore(sb, 'acc1');
    expect(figli.sort()).toEqual(['a1', 'a2']);
  });

  it('nessun legame: array vuoto', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [], student_parents: [] });
    expect(await getFigliDiGenitore(sb, 'acc1')).toEqual([]);
  });
});

describe('genitoreHasFiglio', () => {
  it('true via fast-path runtime', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [{ alunno_id: 'a1' }], parents: [], student_parents: [] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'a1')).toBe(true);
  });

  it('true via fallback anagrafico', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [{ id: 'p1' }], student_parents: [{ student_id: 'a3' }] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'a3')).toBe(true);
  });

  it('false se non collegato in nessuna delle due', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], parents: [{ id: 'p1' }], student_parents: [{ student_id: 'a3' }] });
    expect(await genitoreHasFiglio(sb, 'acc1', 'aX')).toBe(false);
  });
});
