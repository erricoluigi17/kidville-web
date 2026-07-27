import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/admin/chat/threads — vista di supervisione (Direzione) arricchita
 * con `sospensione` per thread (C5 §2).
 *
 *  · UNA sola query batched su conversazioni_sospensioni (thread_id IN (...)):
 *    NON una query per-thread (niente N+1);
 *  · scoping per thread: sospenderne uno non tocca gli altri;
 *  · la Direzione vede il `motivo` in chiaro (strumento interno, non un log).
 */

const TEACHER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TEACHER_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const PARENT_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const PARENT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const THREAD_A = 'dddddddd-0000-4000-8000-00000000000a';
const THREAD_B = 'dddddddd-0000-4000-8000-00000000000b';

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  threads: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
  alunni: [] as Record<string, unknown>[],
  sospensioni: [] as Record<string, unknown>[],
  sospIn: null as string[] | null,
  sospFromCount: 0,
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));

const adminClient = {
  from(table: string) {
    if (table === 'conversazioni_sospensioni') h.sospFromCount += 1;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.in = (col: string, vals: string[]) => {
      if (table === 'conversazioni_sospensioni' && col === 'thread_id') h.sospIn = vals;
      return b;
    };
    // Thenable: risolve in base alla tabella interrogata.
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      let result: unknown;
      if (table === 'chat_threads') result = { data: h.threads, error: null };
      else if (table === 'utenti') result = { data: h.utenti, error: null };
      else if (table === 'alunni') result = { data: h.alunni, error: null };
      else if (table === 'conversazioni_sospensioni') result = { data: h.sospensioni, error: null };
      else result = { data: null, error: null };
      return Promise.resolve(result).then(onF, onR);
    };
    return b;
  },
};
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }));

import { GET } from '@/app/api/admin/chat/threads/route';

const req = () => new NextRequest('http://localhost/api/admin/chat/threads');

interface EnrichedThread {
  id: string;
  sospensione: { motivo: string | null; sospesaIl: string } | null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin' } });
  h.sospIn = null;
  h.sospFromCount = 0;
  h.threads = [
    { id: THREAD_A, teacher_id: TEACHER_A, parent_id: PARENT_A, student_id: 's-a', last_message_at: '2026-07-27T10:00:00Z' },
    { id: THREAD_B, teacher_id: TEACHER_B, parent_id: PARENT_B, student_id: 's-b', last_message_at: '2026-07-27T09:00:00Z' },
  ];
  h.utenti = [
    { id: TEACHER_A, nome: 'Ta', cognome: 'X', ruolo: 'educator', role: 'educator' },
    { id: TEACHER_B, nome: 'Tb', cognome: 'Y', ruolo: 'educator', role: 'educator' },
    { id: PARENT_A, nome: 'Pa', cognome: 'Z', ruolo: 'genitore', role: 'genitore' },
    { id: PARENT_B, nome: 'Pb', cognome: 'W', ruolo: 'genitore', role: 'genitore' },
  ];
  h.alunni = [
    { id: 's-a', nome: 'Al', cognome: 'A', classe_sezione: 'Girasoli' },
    { id: 's-b', nome: 'Be', cognome: 'B', classe_sezione: 'Papaveri' },
  ];
  // Solo il thread A è sospeso.
  h.sospensioni = [
    { thread_id: THREAD_A, sospesa_da: TEACHER_A, sospesa_verso: PARENT_A, motivo: 'MOTIVO_DIREZIONE', sospesa_il: '2026-07-27T10:30:00Z' },
  ];
});

describe('GET /api/admin/chat/threads — arricchimento sospensione', () => {
  it('una sola query batched su conversazioni_sospensioni con tutti i thread_id (no N+1)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(h.sospFromCount).toBe(1);
    expect(h.sospIn).toEqual([THREAD_A, THREAD_B]);
  });

  it('A sospeso (motivo in chiaro per la Direzione), B intatto', async () => {
    const res = await GET(req());
    const body = (await res.json()) as { data: EnrichedThread[] };
    const a = body.data.find((t) => t.id === THREAD_A)!;
    const b = body.data.find((t) => t.id === THREAD_B)!;
    expect(a.sospensione).toMatchObject({ motivo: 'MOTIVO_DIREZIONE' });
    expect(b.sospensione).toBeNull();
  });
});
