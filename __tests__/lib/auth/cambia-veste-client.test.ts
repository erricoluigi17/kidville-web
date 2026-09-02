import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `cambiaRuoloAttivo` — l'UNICO posto che sa come si cambia veste.
 *
 * ─── PERCHÉ ESISTE QUESTO MODULO ─────────────────────────────────────────────
 * Il gesto «cambia veste» viveva DENTRO `auth/login/page.tsx`, in due funzioni
 * private (`passoDiRete` e `impostaRuoloAttivo`): lo switch dentro l'app avrebbe
 * dovuto ricopiarle, e una regola scritta due volte è una regola che diverge al
 * primo ritocco. Qui vive una volta sola, e la login la importa.
 *
 * ─── LA PARTE CHE NON È UN `fetch` ───────────────────────────────────────────
 * La POST è la metà facile. L'altra metà è la RICONCILIAZIONE dello stato locale,
 * e ognuno dei suoi tre passi chiude un difetto diverso:
 *
 *  · `kv_user_role` si scrive **dopo** il 200, mai prima — la regola d'ordine già
 *    pagata sulla login (un 403 lasciava il client convinto di avere un ruolo per
 *    cui il cookie non era mai stato scritto);
 *  · `kv_student_id` si CANCELLA: il figlio selezionato appartiene alla vista
 *    famiglia, e portarselo nella veste di lavoro mostrerebbe al docente un
 *    `ChildSwitcher` con una scelta fatta in un'altra veste;
 *  · `svuotaCacheLocale()` si ATTENDE: la cache offline (`cache_read`) contiene
 *    diario, mensa e galleria di minori raccolti nella veste precedente. È la
 *    ragione per cui questo non può essere un `fetch` seguito da un `push`.
 *
 * ─── E COSA NON DEVE FARE ────────────────────────────────────────────────────
 * Non deregistra la push e non fa `signOut`: la sessione non cambia, e le
 * notifiche appartengono alla persona, non alla veste. Un `doLogout` mascherato
 * qui dentro chiuderebbe fuori l'utente a ogni cambio di profilo.
 */

const spie = vi.hoisted(() => ({
  svuota: vi.fn(async () => {}),
}));

vi.mock('@/lib/offline/pulizia-cache', () => ({
  svuotaCacheLocale: spie.svuota,
}));

import { cambiaRuoloAttivo } from '@/lib/auth/ruolo-attivo-client';

let chiamate: Array<{ url: string; init?: RequestInit }> = [];
const fetchMock = vi.fn();

function rispostaOk() {
  return { ok: true, status: 200, json: async () => ({ ok: true, ruolo: 'genitore', area: 'parent' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  chiamate = [];
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_role', 'educator');
  window.localStorage.setItem('kv_student_id', 'alunno-della-veste-precedente');
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    chiamate.push({ url: String(url), init });
    return Promise.resolve(rispostaOk());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cambiaRuoloAttivo — la POST e la riconciliazione, in un posto solo', () => {
  it('POSTa il ruolo a /api/auth/active-role', async () => {
    const esito = await cambiaRuoloAttivo('genitore');
    expect(esito.ok).toBe(true);
    expect(chiamate).toHaveLength(1);
    expect(chiamate[0].url).toBe('/api/auth/active-role');
    expect(chiamate[0].init?.method).toBe('POST');
    expect(JSON.parse(String(chiamate[0].init?.body))).toEqual({ ruolo: 'genitore' });
  });

  it('sul 200: kv_user_role aggiornato, kv_student_id dimenticato, cache svuotata', async () => {
    await cambiaRuoloAttivo('genitore');
    expect(window.localStorage.getItem('kv_user_role')).toBe('genitore');
    expect(
      window.localStorage.getItem('kv_student_id'),
      'Il figlio selezionato appartiene alla vista famiglia: portarselo nella veste ' +
        'di lavoro mostra al docente una scelta fatta in un’altra veste.',
    ).toBeNull();
    expect(
      spie.svuota,
      'La cache offline contiene dati di minori raccolti nella veste precedente: ' +
        'va svuotata, e va ATTESA prima che il chiamante navighi.',
    ).toHaveBeenCalledTimes(1);
  });

  it('la cache è svuotata PRIMA che la promessa si risolva (niente lavoro in volo)', async () => {
    let risolviSvuotamento: (() => void) | null = null;
    spie.svuota.mockImplementationOnce(
      () => new Promise<void>((res) => { risolviSvuotamento = () => res(); }),
    );

    let finito = false;
    const inCorso = cambiaRuoloAttivo('genitore').then((e) => { finito = true; return e; });
    // Lascia girare la POST e arrivare fino allo svuotamento. `vi.waitFor` e non
    // una manciata di `Promise.resolve()`: il numero di microtask fra la POST e
    // lo svuotamento è un dettaglio dell'implementazione, e un test che lo conta
    // diventa rosso al primo `await` aggiunto — su un prodotto sano.
    await vi.waitFor(() => {
      expect(risolviSvuotamento, 'lo svuotamento non è nemmeno partito').not.toBeNull();
    });

    expect(
      finito,
      '`cambiaRuoloAttivo` si è risolta mentre lo svuotamento era ancora in volo: ' +
        'chi la attende navigherebbe subito e `router.replace` cancellerebbe la pulizia.',
    ).toBe(false);

    risolviSvuotamento!();
    expect((await inCorso).ok).toBe(true);
  });

  it('su 403 NON tocca nulla: né il ruolo memorizzato né la cache', async () => {
    fetchMock.mockImplementationOnce((url: unknown) => {
      chiamate.push({ url: String(url) });
      return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'no' }) });
    });

    const esito = await cambiaRuoloAttivo('genitore');
    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.stato).toBe(403);
    expect(
      window.localStorage.getItem('kv_user_role'),
      'Un 403 che aggiorna comunque `kv_user_role` lascia il client convinto di ' +
        'avere una veste per cui il server non ha scritto nessun cookie.',
    ).toBe('educator');
    expect(window.localStorage.getItem('kv_student_id')).toBe('alunno-della-veste-precedente');
    expect(spie.svuota).not.toHaveBeenCalled();
  });

  it('rete giù: esito di guasto SENZA stato, e nessuna riconciliazione', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));

    const esito = await cambiaRuoloAttivo('genitore');
    expect(esito.ok).toBe(false);
    if (!esito.ok) {
      expect(esito.stato).toBeUndefined();
      expect(esito.errore).toBeInstanceOf(TypeError);
    }
    expect(window.localStorage.getItem('kv_user_role')).toBe('educator');
    expect(spie.svuota).not.toHaveBeenCalled();
  });

  it('corpo illeggibile (una pagina HTML al posto del JSON): guasto, non successo', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('<!doctype html>'); } }),
    );

    const esito = await cambiaRuoloAttivo('genitore');
    expect(esito.ok).toBe(false);
    expect(window.localStorage.getItem('kv_user_role')).toBe('educator');
    expect(spie.svuota).not.toHaveBeenCalled();
  });

  it('IL TETTO: una risposta che non arriva mai non lascia il chiamante appeso', async () => {
    // Chi preme è GIÀ autenticato: senza tetto il bottone resta inattivo per
    // sempre. È il difetto W8, già pagato una volta sulla login.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    const esito = await cambiaRuoloAttivo('genitore', 5);
    expect(esito.ok).toBe(false);
    if (!esito.ok) {
      expect(esito.chiave).toBe('timeoutDopoAccesso');
      expect(esito.stato).toBeUndefined();
    }
    expect(spie.svuota).not.toHaveBeenCalled();
  });

  it('NON deregistra la push e NON chiude la sessione: la veste cambia, la persona no', async () => {
    await cambiaRuoloAttivo('genitore');
    const rotte = chiamate.map((c) => c.url);
    expect(rotte).not.toContain('/api/push/subscribe');
    expect(rotte).not.toContain('/api/auth/logout');
  });
});
