import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami';

// A6 — Riparazione automatica del legame runtime.
//
// In produzione 10 coppie genitore↔bambino esistono SOLO in `student_parents`
// (spazio anagrafica) e 11 `parents` non hanno nemmeno un account. Le letture
// ora fanno l'unione, ma la tabella runtime resta vuota: le POLICY RLS del
// baseline (`pagamenti`, `incassi`, `note_disciplinari`) leggono ancora
// `legame_genitori_alunni` e non si toccano. L'unico modo corretto di renderle
// vere è POPOLARE la tabella — ed è ciò che fa questo helper nel momento in cui
// il genitore riceve davvero un account.
//
// Vincolo non negoziabile: `ignoreDuplicates` + `onConflict`, perché una quota
// impostata a mano dalla Segreteria (`intestatario_fattura`,
// `percentuale_pagamento`) NON deve mai essere sovrascritta da una riparazione.

interface UpsertRegistrato {
  tabella: string;
  righe: Record<string, unknown>[];
  opzioni: Record<string, unknown> | undefined;
}

function makeSupabase(
  righePerTabella: Record<string, Record<string, unknown>[]>,
  guasti: { upsert?: { code?: string; message: string }; select?: Record<string, { code?: string; message: string }> } = {},
): { client: SupabaseClient; upserts: UpsertRegistrato[] } {
  const upserts: UpsertRegistrato[] = [];
  const client = {
    from(tabella: string) {
      const righe = () => righePerTabella[tabella] ?? [];
      const errore = () => guasti.select?.[tabella] ?? null;
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.eq = chain;
      b.in = chain;
      b.maybeSingle = async () => ({ data: errore() ? null : (righe()[0] ?? null), error: errore() });
      b.upsert = async (righeIns: unknown, opzioni: Record<string, unknown> | undefined) => {
        upserts.push({
          tabella,
          righe: Array.isArray(righeIns) ? (righeIns as Record<string, unknown>[]) : [righeIns as Record<string, unknown>],
          opzioni,
        });
        return { data: null, error: guasti.upsert ?? null };
      };
      b.then = (res: (v: { data: unknown; error: unknown }) => unknown) =>
        res({ data: errore() ? null : righe(), error: errore() });
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, upserts };
}

describe('sincronizzaLegamiRuntime', () => {
  it('parents SENZA account: {creati:0} e nessuna scrittura (non si inventa un account)', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: null }],
      student_parents: [{ student_id: 'a1' }, { student_id: 'a2' }],
      legame_genitori_alunni: [],
    });
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 0 });
    expect(upserts).toEqual([]);
  });

  it('parents inesistente: {creati:0} e nessuna scrittura', async () => {
    const { client, upserts } = makeSupabase({ parents: [], student_parents: [], legame_genitori_alunni: [] });
    expect(await sincronizzaLegamiRuntime(client, 'p-ignoto')).toEqual({ creati: 0 });
    expect(upserts).toEqual([]);
  });

  it('con account: crea SOLO i legami runtime mancanti', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
      student_parents: [{ student_id: 'a1' }, { student_id: 'a2' }],
      // a1 c'è già a runtime (magari con una quota impostata dalla Segreteria)
      legame_genitori_alunni: [{ alunno_id: 'a1' }],
    });
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 1 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].tabella).toBe('legame_genitori_alunni');
    expect(upserts[0].righe).toEqual([
      { genitore_id: 'acc9', alunno_id: 'a2', intestatario_fattura: false, percentuale_pagamento: 0 },
    ]);
  });

  it('scrive con onConflict genitore_id,alunno_id e ignoreDuplicates (mai sovrascrivere una quota)', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
      student_parents: [{ student_id: 'a1' }],
      legame_genitori_alunni: [],
    });
    await sincronizzaLegamiRuntime(client, 'p1');
    expect(upserts[0].opzioni).toMatchObject({ onConflict: 'genitore_id,alunno_id', ignoreDuplicates: true });
  });

  it('nessun figlio in anagrafica: {creati:0} e nessuna scrittura', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
      student_parents: [],
      legame_genitori_alunni: [],
    });
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 0 });
    expect(upserts).toEqual([]);
  });

  it('tutti i legami già presenti a runtime: nessuna scrittura', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
      student_parents: [{ student_id: 'a1' }],
      legame_genitori_alunni: [{ alunno_id: 'a1' }],
    });
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 0 });
    expect(upserts).toEqual([]);
  });

  it('upsert in errore (PostgREST NON lancia): {creati:0}, nessuna eccezione al chiamante', async () => {
    const { client } = makeSupabase(
      {
        parents: [{ id: 'p1', auth_user_id: 'acc9' }],
        student_parents: [{ student_id: 'a1' }],
        legame_genitori_alunni: [],
      },
      { upsert: { code: 'PGRST204', message: 'column not found' } },
    );
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 0 });
  });

  it('ponte parents illeggibile: {creati:0}, nessuna eccezione', async () => {
    const { client, upserts } = makeSupabase(
      { parents: [], student_parents: [], legame_genitori_alunni: [] },
      { select: { parents: { code: '42P01', message: 'relation does not exist' } } },
    );
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 0 });
    expect(upserts).toEqual([]);
  });

  it('duplicati in student_parents: una sola riga per alunno', async () => {
    const { client, upserts } = makeSupabase({
      parents: [{ id: 'p1', auth_user_id: 'acc9' }],
      student_parents: [{ student_id: 'a1' }, { student_id: 'a1' }],
      legame_genitori_alunni: [],
    });
    expect(await sincronizzaLegamiRuntime(client, 'p1')).toEqual({ creati: 1 });
    expect(upserts[0].righe).toHaveLength(1);
  });
});
