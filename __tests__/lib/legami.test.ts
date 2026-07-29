import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getFigliDiGenitore,
  genitoreHasFiglio,
  getGenitoriDiAlunni,
  getGenitoriDiAlunno,
} from '@/lib/anagrafiche/legami';

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

describe('getGenitoriDiAlunni (verso inverso: alunno → account genitore)', () => {
  it('runtime: mappa alunno → genitori da legame_genitori_alunni', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [
        { alunno_id: 'a1', genitore_id: 'acc1' },
        { alunno_id: 'a1', genitore_id: 'acc2' },
      ],
      student_parents: [],
      parents: [],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1']);
    expect((mappa.get('a1') ?? []).sort()).toEqual(['acc1', 'acc2']);
  });

  it('fallback: risolve dall\'anagrafica via ponte parents.auth_user_id', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      student_parents: [{ student_id: 'a1', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1']);
    expect(mappa.get('a1')).toEqual(['acc9']);
  });

  it('parents senza account (auth_user_id null) non produce destinatari', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [],
      student_parents: [{ student_id: 'a1', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: null }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1']);
    expect(mappa.get('a1') ?? []).toEqual([]);
  });

  it('union: dedup fra runtime e anagrafica', async () => {
    const sb = makeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1', genitore_id: 'acc1' }],
      student_parents: [{ student_id: 'a1', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc1' }],
    });
    const mappa = await getGenitoriDiAlunni(sb, ['a1']);
    expect(mappa.get('a1')).toEqual(['acc1']);
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
      student_parents: [{ student_id: 'a1', parent_id: 'p1' }],
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
    });
    expect(await getGenitoriDiAlunno(sb, 'a1')).toEqual(['acc9']);
  });

  it('array vuoto quando non c\'è alcun legame', async () => {
    const sb = makeSupabase({ legame_genitori_alunni: [], student_parents: [], parents: [] });
    expect(await getGenitoriDiAlunno(sb, 'a1')).toEqual([]);
  });
});
