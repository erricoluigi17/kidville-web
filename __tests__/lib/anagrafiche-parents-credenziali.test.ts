import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';

// S6bis: alla CREAZIONE di un'anagrafica genitore con email, l'account nasce
// completo e le credenziali partono via email IN AUTOMATICO (nessun passaggio
// manuale). L'esito dell'invio è propagato al chiamante e in audit.

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  send: vi.fn(),
  logScrittura: vi.fn(),
  // Le schede che la ricerca «stessa email» restituirebbe (il nome lo filtra il codice).
  schedeConEmail: [] as Array<Record<string, unknown>>,
  ricercaErrore: null as { code?: string; message?: string } | null,
  ricerche: [] as unknown[],
  inserts: [] as Array<{ table: string; row: unknown }>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }));
vi.mock('@/lib/auth/parent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/parent-identity')>();
  return { ...actual, ensureParentIdentity: h.ensure };
});
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: h.send,
  credentialsEmailBody: (_n: string | null, e: string, p: string) => `credenziali ${e} pwd:${p}`,
}));

import { linkOrCreateParent } from '@/lib/anagrafiche/parents';

const actor: AppUser = { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' };

function makeSupabase() {
  return {
    from: (table: string) => ({
      insert: (row: unknown) => {
        h.inserts.push({ table, row });
        return { select: () => ({ single: async () => ({ data: { id: 'p-new' }, error: null }) }) };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        // La ricerca per email: `.overlaps(...).order(...).limit(...)`.
        overlaps: (colonna: string, valori: unknown) => {
          h.ricerche.push({ colonna, valori });
          return {
            order: () => ({
              limit: async () => ({
                data: h.ricercaErrore ? null : h.schedeConEmail,
                error: h.ricercaErrore,
              }),
            }),
          };
        },
      }),
      upsert: async (row: Record<string, unknown>) => {
        h.upserts.push({ table, row });
        return { error: null };
      },
      _table: table,
    }),
  } as unknown as SupabaseClient;
}

const payload = { first_name: 'Mario', last_name: 'Rossi', role: 'father', emails: ['mario@x.it'] };

const IDENTITA_CREATA = {
  ok: true as const,
  authUserId: 'auth-1',
  email: 'mario@x.it',
  createdAuth: true,
  createdUtenti: true,
  boundNow: true,
  password: 'tmp-pass-123',
};

describe('linkOrCreateParent — invio automatico credenziali (S6bis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.schedeConEmail = [];
    h.ricercaErrore = null;
    h.ricerche = [];
    h.inserts = [];
    h.upserts = [];
    h.ensure.mockResolvedValue(IDENTITA_CREATA);
    h.send.mockResolvedValue({ ok: true, error: null });
  });

  it('account creato → credenziali inviate automaticamente con la password temporanea', async () => {
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(h.send).toHaveBeenCalledTimes(1);
    const arg = h.send.mock.calls[0][0] as { to: string; text: string };
    expect(arg.to).toBe('mario@x.it');
    expect(arg.text).toContain('tmp-pass-123');
    expect(r.credenzialiEmail).toEqual({ email: 'mario@x.it', inviata: true, errore: null });
    // audit con esito email
    const auditCred = h.logScrittura.mock.calls.map((c) => c[1]).find((a) => a.entitaTipo === 'credenziali');
    expect(auditCred?.valoreDopo).toMatchObject({ emailed: true, emailError: null });
  });

  it('invio rifiutato → esito negativo propagato con MOTIVO (mai silenzioso)', async () => {
    h.send.mockResolvedValue({ ok: false, error: 'rifiutato dal provider email (403): sandbox' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(r.credenzialiEmail).toEqual({
      email: 'mario@x.it',
      inviata: false,
      errore: 'rifiutato dal provider email (403): sandbox',
    });
    const auditCred = h.logScrittura.mock.calls.map((c) => c[1]).find((a) => a.entitaTipo === 'credenziali');
    expect(auditCred?.valoreDopo).toMatchObject({ emailed: false, emailError: expect.stringContaining('403') });
  });

  it('account riusato (email già con accesso) → NESSUN invio', async () => {
    h.ensure.mockResolvedValue({ ...IDENTITA_CREATA, createdAuth: false, password: null, boundNow: true });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(h.send).not.toHaveBeenCalled();
    expect(r.credenzialiEmail).toBeUndefined();
  });

  it('anagrafica senza email → nessun invio e nessun errore', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'no_email', message: 'Genitore senza email in anagrafica' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: { ...payload, emails: [] } });
    expect(h.send).not.toHaveBeenCalled();
    expect(r.identitaErrore).toBeUndefined();
  });

  it('identità non completata → errore propagato al chiamante', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'error', message: 'boom identità' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(r.identitaErrore).toBe('boom identità');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('record-staff (tab Staff) → identità e invio NON tentati', async () => {
    const r = await linkOrCreateParent(makeSupabase(), actor, {
      studentId: null,
      payload: { ...payload, role: 'educator' },
    });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(r.credenzialiEmail).toBeUndefined();
  });
});

// =============================================================================
// LA STESSA PERSONA CON UN REFUSO NEL CODICE FISCALE
//
// Il 2026-10-06 una madre risultava con quattro schede: stesso nome, stesso
// cognome, stessa email, tre CF diversi da quello dell'import. La deduplica per CF
// non le univa, e ogni tentativo di collegare il bambino ne creava una nuova, che
// poi urtava nella UNIQUE sul ponte con l'account (`email_conflict`). Il bambino
// finiva su una scheda senza accesso e la famiglia entrava in un'app vuota.
// =============================================================================
describe('linkOrCreateParent — stessa persona, CF diverso (nome + email)', () => {
  const SCHEDA_IMPORT = {
    id: 'p-import',
    auth_user_id: 'auth-1',
    emails: ['mario@x.it'],
    first_name: 'MARIO',
    last_name: 'rossi',
    fiscal_code: 'RSSMRA80A01H501Z',
  };
  const conCf = { ...payload, fiscal_code: 'RSSMRA80A01H501X' };

  beforeEach(() => {
    vi.clearAllMocks();
    h.schedeConEmail = [];
    h.ricercaErrore = null;
    h.ricerche = [];
    h.inserts = [];
    h.upserts = [];
    h.ensure.mockResolvedValue({ ...IDENTITA_CREATA, createdAuth: false, password: null, boundNow: false });
    h.send.mockResolvedValue({ ok: true, error: null });
  });

  it('stesso nome (senza badare alle maiuscole) e stessa email ⇒ riusa la scheda, NON ne crea una nuova', async () => {
    h.schedeConEmail = [SCHEDA_IMPORT];
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload: conCf });

    expect(r.parentId).toBe('p-import');
    expect(r.created).toBe(false);
    expect(h.inserts.filter((i) => i.table === 'parents')).toHaveLength(0);
    // Il bambino viene collegato alla scheda che ha l'account, non a una vuota.
    expect(h.upserts.find((u) => u.table === 'student_parents')?.row).toMatchObject({ student_id: 's1', parent_id: 'p-import' });
    // E l'identità parte dalla scheda trovata, col suo account già attaccato.
    expect(h.ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'p-import', auth_user_id: 'auth-1' }),
      expect.anything(),
    );
    // Nessuna credenziale in più verso una famiglia che le ha già.
    expect(h.send).not.toHaveBeenCalled();
  });

  it('PROVA NEGATIVA — stessa email ma NOME DIVERSO ⇒ è un\'altra persona, si crea', async () => {
    h.schedeConEmail = [{ ...SCHEDA_IMPORT, first_name: 'Luigi' }];
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload: conCf });
    expect(r.created).toBe(true);
    expect(r.parentId).toBe('p-new');
  });

  it('nessuna scheda con quell\'email ⇒ si crea come sempre', async () => {
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload: conCf });
    expect(r.created).toBe(true);
    expect(h.ricerche).toHaveLength(1);
  });

  it('la ricerca va per email e cerca anche la variante minuscola', async () => {
    await linkOrCreateParent(makeSupabase(), actor, {
      studentId: null,
      payload: { ...payload, emails: ['Mario@X.it'] },
    });
    const { colonna, valori } = h.ricerche[0] as { colonna: string; valori: string[] };
    expect(colonna).toBe('emails');
    expect(valori).toEqual(expect.arrayContaining(['Mario@X.it', 'mario@x.it']));
  });

  it('più candidate: vince quella che ha già un account', async () => {
    h.schedeConEmail = [
      { ...SCHEDA_IMPORT, id: 'p-vecchia-senza-account', auth_user_id: null },
      { ...SCHEDA_IMPORT, id: 'p-con-account', auth_user_id: 'auth-9' },
    ];
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: conCf });
    expect(r.parentId).toBe('p-con-account');
  });

  it('più candidate senza account: la prima, cioè la più vecchia (la ricerca è ordinata per data)', async () => {
    h.schedeConEmail = [
      { ...SCHEDA_IMPORT, id: 'p-prima', auth_user_id: null },
      { ...SCHEDA_IMPORT, id: 'p-dopo', auth_user_id: null },
    ];
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: conCf });
    expect(r.parentId).toBe('p-prima');
  });

  it('la ricerca FALLISCE ⇒ si torna a creare (un guasto di lettura non blocca la segreteria)', async () => {
    h.ricercaErrore = { code: '57014', message: 'timeout' };
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: conCf });
    expect(r.created).toBe(true);
  });

  it('senza email o senza cognome ⇒ nessuna ricerca (un solo indizio non basta)', async () => {
    await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: { ...payload, emails: [] } });
    await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: { ...payload, last_name: '' } });
    expect(h.ricerche).toHaveLength(0);
  });

  it('record-staff ⇒ nessuna ricerca: non sono genitori dell\'app', async () => {
    await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: { ...payload, role: 'educator' } });
    expect(h.ricerche).toHaveLength(0);
  });
});

describe('linkOrCreateParent — `identitaMotivo`', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.schedeConEmail = [];
    h.ricercaErrore = null;
    h.ricerche = [];
    h.inserts = [];
    h.upserts = [];
  });

  it('email già di un\'altra scheda ⇒ `email_conflict`, e il motivo NON contiene l\'indirizzo', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'email_conflict', message: "L'email mario@x.it risulta già collegata" });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload });
    expect(r.identitaMotivo).toBe('email_conflict');
    expect(r.identitaMotivo).not.toContain('@');
  });

  it('qualunque altro guasto ⇒ `error`', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'error', message: 'boom' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload });
    expect(r.identitaMotivo).toBe('error');
  });

  it('identità completata, o adulto senza email ⇒ nessun motivo', async () => {
    h.ensure.mockResolvedValue(IDENTITA_CREATA);
    h.send.mockResolvedValue({ ok: true, error: null });
    expect((await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload })).identitaMotivo).toBeUndefined();
    h.ensure.mockResolvedValue({ ok: false, reason: 'no_email', message: 'senza email' });
    expect((await linkOrCreateParent(makeSupabase(), actor, { studentId: 's1', payload: { ...payload, emails: [] } })).identitaMotivo).toBeUndefined();
  });
});
