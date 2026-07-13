import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks for the two Supabase clients resolveIdentity touches:
//  - createClient(): the SSR/session client (reads the auth cookie)
//  - createAdminClient(): service-role, used to map auth.uid() -> app id
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  utentiMaybeSingle: vi.fn(),
  parentsMaybeSingle: vi.fn(),
  // `loadAppUser` interroga `utenti` con `.single()` (non `.maybeSingle()`): serve un mock
  // suo, altrimenti i gate non caricherebbero mai un utente.
  utentiSingle: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mocks.getUser },
  }),
  createAdminClient: vi.fn().mockResolvedValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle:
            table === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
          single: mocks.utentiSingle,
        }),
      }),
    }),
  }),
}));

// Il logger è mockato per SPIARE il livello: è la decisione di progetto del Task 7
// (dinieghi → `info`, non persistiti; header-fallback → `warn`, persistito) ed è ciò che
// tiene `app_log` leggibile. Un test che non la blocca la lascia regredire in silenzio.
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }));

import {
  resolveIdentity,
  requireStaff,
  requireDocente,
  requireUser,
  requireKitchenRead,
} from '@/lib/auth/require-staff';
import { logEvento } from '@/lib/logging/logger';
import { conContesto, contesto } from '@/lib/logging/context';

describe('resolveIdentity (session-authoritative shim)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.utentiSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('prefers the session id for a staff user (utenti.id == auth.uid())', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'staff-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: { id: 'staff-uid' }, error: null });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'staff-uid', source: 'session' });
  });

  it('ignores a spoofed x-user-id that differs from the session (anti-spoof)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'staff-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: { id: 'staff-uid' }, error: null });
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'attacker' } });
    const res = await resolveIdentity(req);
    expect(res.userId).toBe('staff-uid');
    expect(res.source).toBe('session');
  });

  it('maps a parent session via parents.auth_user_id -> parents.id', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'auth-parent' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: { id: 'parent-row' }, error: null });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'parent-row', source: 'session' });
  });

  it('falls back to header/query identity when no session and flag not disabled', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await resolveIdentity(new Request('http://localhost?userId=hdr-123'));
    expect(res).toEqual({ userId: 'hdr-123', source: 'header' });
  });

  it('rejects header identity when ALLOW_HEADER_IDENTITY=false', async () => {
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'false');
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'hdr-123' } });
    const res = await resolveIdentity(req);
    expect(res).toEqual({ userId: null, source: null });
  });

  it('degrades to header path if the session lookup throws (cookies() unavailable)', async () => {
    mocks.getUser.mockRejectedValue(new Error('cookies() unavailable'));
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'hdr-xyz' } });
    const res = await resolveIdentity(req);
    expect(res).toEqual({ userId: 'hdr-xyz', source: 'header' });
  });

  it('returns the raw session uid when neither staff nor parent matches (bridge column missing)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'unknown-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'column parents.auth_user_id does not exist' },
    });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'unknown-uid', source: 'session' });
  });

  /**
   * Prima questo test asseriva su `console.warn`. Asseriva cioè su un EFFETTO COLLATERALE
   * («ha chiamato quella funzione con quella stringa»), non sul comportamento: il giorno in cui
   * il progetto ha sostituito il `console.warn` con il logger strutturato, il test è diventato
   * rosso pur essendo il codice più corretto di prima. Un test così non protegge un'invariante,
   * protegge un'implementazione. Ora si verifica ciò che conta davvero: che l'identità venga
   * comunque risolta dall'header quando non c'è sessione.
   */
  it('senza sessione, l\'identità arriva comunque dall\'header/query (osservabilità S13)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await resolveIdentity(new Request('http://localhost/api/grades?userId=hdr-1'));
    expect(res).toEqual({ userId: 'hdr-1', source: 'header' });
  });

  it('il fallback dall\'header è un segnale di SICUREZZA: warn, quindi persistito', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await resolveIdentity(new Request('http://localhost/api/grades?userId=hdr-1'));
    // `tipo` e non `motivo`: `redact()` è a lista bianca PER CHIAVE e `motivo` non è in lista,
    // quindi in tabella la riga avrebbe detto `[redatto:str/15]` — il segnale sarebbe stato
    // persistito e illeggibile.
    expect(logEvento).toHaveBeenCalledWith('auth', 'warn', { tipo: 'header-fallback' });

    // Il livello NON è decorativo: `warn` è ciò che manda la riga in tabella. Si asserisce
    // sul logger VERO, non sul mock, perché è lì che vive la regola.
    const vero = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger');
    expect(vero.vaPersistito('warn', 'auth')).toBe(true);
  });

  it('con una sessione valida NON logga il fallback (il contatore S13 non va gonfiato)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'staff-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: { id: 'staff-uid' }, error: null });
    const req = new Request('http://localhost/api/grades', { headers: { 'x-user-id': 'staff-uid' } });
    await resolveIdentity(req);
    expect(logEvento).not.toHaveBeenCalled();
  });

  it('il path GREZZO non finisce nella riga (contiene il token di /m/<token>)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await resolveIdentity(
      new Request('http://localhost/api/public/forms/3f2504e0-4f89-11d3-9a0c-0305e82c3301/submit?userId=hdr-1'),
    );
    const campi = vi.mocked(logEvento).mock.calls[0][2];
    expect(JSON.stringify(campi)).not.toContain('3f2504e0');
    expect(campi).not.toHaveProperty('path');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Task 7 — i gate depositano l'identità nel contesto, e loggano i dinieghi.
 * ──────────────────────────────────────────────────────────────────────────── */

const UTENTE = {
  id: 'u-1',
  nome: 'X',
  cognome: 'Y',
  ruolo: 'educator',
  role: 'educator',
  scuola_id: 's-1',
};

describe('i gate depositano l\'identità nel contesto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  const gate = (r: Request) => requireDocente(r);
  const richiesta = () => new Request('http://localhost/api/grades', { headers: { 'x-user-id': 'u-1' } });

  it('uid, ruolo e sede finiscono nel contesto: da lì vanno in OGNI riga della richiesta', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: UTENTE, error: null });
    await conContesto({ requestId: 'r1', path: '/api/grades' }, async () => {
      const auth = await gate(richiesta());
      expect(auth.user?.id).toBe('u-1');
      expect(contesto()).toMatchObject({ userId: 'u-1', ruolo: 'educator', scuolaId: 's-1' });
    });
  });

  it('scuola_id null non sporca il contesto (la colonna è opzionale)', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: { ...UTENTE, scuola_id: null }, error: null });
    await conContesto({ requestId: 'r1', path: '/api/grades' }, async () => {
      await gate(richiesta());
      expect(contesto()?.scuolaId).toBeUndefined();
      expect(contesto()?.userId).toBe('u-1');
    });
  });

  it('tutti e quattro i gate depositano l\'identità', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: { ...UTENTE, ruolo: 'admin', role: 'admin' }, error: null });
    for (const g of [requireStaff, requireDocente, requireUser, requireKitchenRead]) {
      await conContesto({ requestId: 'r1', path: '/api/x' }, async () => {
        const auth = await g(richiesta());
        expect(auth.response, g.name).toBeUndefined();
        expect(contesto()?.userId, g.name).toBe('u-1');
        expect(contesto()?.ruolo, g.name).toBe('admin');
      });
    }
  });

  it('fuori da una richiesta (Request nuda, nessun contesto) il gate non lancia', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: UTENTE, error: null });
    // È la forma dei ~90 test API del repo: l'handler invocato come una funzione qualunque.
    await expect(gate(richiesta())).resolves.toMatchObject({ user: { id: 'u-1' } });
  });
});

describe('i gate loggano i dinieghi — a INFO, per non affogare app_log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.utentiSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('403 per ruolo non ammesso: motivo, gate e ruolo effettivo', async () => {
    mocks.utentiSingle.mockResolvedValue({
      data: { ...UTENTE, ruolo: 'genitore', role: 'genitore' },
      error: null,
    });
    const auth = await requireStaff(new Request('http://localhost/api/admin/x?userId=u-1'));
    expect(auth.response?.status).toBe(403);
    expect(logEvento).toHaveBeenCalledWith('auth', 'info', {
      tipo: 'ruolo-negato',
      azione: 'requireStaff',
      ruolo: 'genitore',
    });
  });

  it('401 senza identità: nessun ruolo da riportare', async () => {
    const auth = await requireDocente(new Request('http://localhost/api/grades'));
    expect(auth.response?.status).toBe(401);
    expect(logEvento).toHaveBeenCalledWith('auth', 'info', {
      tipo: 'non-autenticato',
      azione: 'requireDocente',
      ruolo: undefined,
    });
  });

  it('utente sconosciuto: si distingue da «ruolo non ammesso»', async () => {
    const auth = await requireStaff(new Request('http://localhost/api/admin/x?userId=fantasma'));
    expect(auth.response?.status).toBe(403);
    expect(logEvento).toHaveBeenCalledWith('auth', 'info', {
      tipo: 'utente-sconosciuto',
      azione: 'requireStaff',
      ruolo: undefined,
    });
  });

  it('un 403 dice anche A CHI: l\'identità è nel contesto pure quando il gate nega', async () => {
    mocks.utentiSingle.mockResolvedValue({
      data: { ...UTENTE, ruolo: 'genitore', role: 'genitore' },
      error: null,
    });
    await conContesto({ requestId: 'r1', path: '/api/admin/x' }, async () => {
      await requireStaff(new Request('http://localhost/api/admin/x?userId=u-1'));
      expect(contesto()).toMatchObject({ userId: 'u-1', ruolo: 'genitore' });
    });
  });

  it('i dinieghi NON finiscono in tabella: sono i 4xx più frequenti che esistano', async () => {
    // La regola vive in `vaPersistito`, non in questo file: si asserisce sul logger VERO.
    const vero = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger');
    expect(vero.vaPersistito('info', 'auth')).toBe(false);
    // …e il livello che i gate usano davvero è proprio `info`.
    await requireDocente(new Request('http://localhost/api/grades'));
    expect(vi.mocked(logEvento).mock.calls.every((c) => c[1] === 'info')).toBe(true);
  });

  it('le risposte di diniego non cambiano: status e corpo sono quelli di prima', async () => {
    const casi: Array<[Promise<{ response?: Response }>, number, string]> = [
      [requireStaff(new Request('http://localhost')), 401, 'Non autenticato: userId mancante'],
      [requireUser(new Request('http://localhost')), 401, 'Non autenticato: userId mancante'],
      [requireUser(new Request('http://localhost?userId=x')), 401, 'Utente non trovato'],
      [
        requireKitchenRead(new Request('http://localhost?userId=x')),
        403,
        'Accesso negato: operazione riservata a cucina/staff',
      ],
      [
        requireDocente(new Request('http://localhost?userId=x')),
        403,
        'Accesso negato: riservato al personale docente',
      ],
    ];
    for (const [p, stato, errore] of casi) {
      const { response } = await p;
      expect(response?.status).toBe(stato);
      expect(await response?.json()).toEqual({ error: errore });
    }
  });
});
