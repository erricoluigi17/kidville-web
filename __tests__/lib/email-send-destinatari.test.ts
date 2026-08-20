import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PIÙ DESTINATARI: UN ELENCO, MAI UNA STRINGA CON LE VIRGOLE.
 *
 * ─── IL DIFETTO CHE QUESTI TEST BLOCCANO, E CHE È GIÀ COSTATO ────────────────
 * Il 2026-08-20, commit `2e505bd`, `copia-alla-sede.ts` costruiva il destinatario
 * con `destinatari.join(', ')` e `SendEmailParams.to` era tipato `string`. Resend
 * accetta una stringa OPPURE un elenco; una stringa sola che contiene due
 * indirizzi non è nessuna delle due, e risponde:
 *
 *     422 validation_error — "Invalid `to` field. The email address needs to
 *     follow the `[email]` or `Name <[email]>` format."
 *
 * In produzione: alle 11:02:02 e alle 11:04:30, le UNICHE due candidature rivolte
 * a due plessi. Quelle a una sede sola passavano. Cioè la copia al plesso
 * funzionava dappertutto tranne che nel caso multi-sede — che è la ragione per
 * cui la funzione era stata scritta una settimana prima.
 *
 * ─── PERCHÉ GLI UNDICI TEST ESISTENTI ERANO VERDI ────────────────────────────
 * Perché il finto di Resend accettava qualunque `to`. Il tipo diceva `string`, il
 * finto diceva sì, e nessuno dei due parlava col protocollo vero.
 *
 * **Un finto più permissivo del servizio vero non verifica: autorizza.** E
 * autorizza esattamente l'input che la produzione rifiuta.
 *
 * ─── QUINDI IL TEST CHE CONTA NON È «PASSA UN ARRAY» ─────────────────────────
 * Passare un array e vedere che arriva è la metà facile. La metà che tiene è che
 * il finto qui sotto **RIFIUTI la virgola con lo stesso 422 di Resend**: senza
 * quello, fra un mese qualcuno rimette il `join(', ')` e questi test tornano
 * verdi insieme agli altri undici.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }));
vi.mock('@/lib/logging/logger', () => log);

import { sendEmailDetailed, destinatariPerIlProvider } from '@/lib/email/send';

const realFetch = global.fetch;
const realKey = process.env.RESEND_API_KEY;

/** L'ultimo corpo che è arrivato al finto, per guardarci dentro. */
let ultimoCorpo: Record<string, unknown> | null = null;

/**
 * IL FINTO CHE SI COMPORTA COME RESEND, cioè che dice di NO.
 *
 * Riproduce la sola regola che ci interessa del protocollo: `to` è una stringa
 * con un indirizzo, oppure un elenco di stringhe con un indirizzo ciascuna. Una
 * stringa con una virgola dentro (e senza `<`) è un errore `422`, con lo stesso
 * corpo che Resend ha restituito in produzione.
 */
function resendCheDiceNo() {
  global.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
    const corpo = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    ultimoCorpo = corpo;
    const to = corpo.to;
    const valido = (v: unknown): boolean =>
      typeof v === 'string' && v.trim() !== '' && (!v.includes(',') || v.includes('<'));
    const ok = Array.isArray(to) ? to.length > 0 && to.every(valido) : valido(to);
    if (!ok) {
      return new Response(
        JSON.stringify({
          statusCode: 422,
          name: 'validation_error',
          message:
            'Invalid `to` field. The email address needs to follow the `[email]` or `Name <[email]>` format.',
        }),
        { status: 422 },
      );
    }
    return new Response(JSON.stringify({ id: 'msg_finto' }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  ultimoCorpo = null;
  log.logEvento.mockClear();
  resendCheDiceNo();
});

afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

// Indirizzi inventati su `.test`: il repo è pubblico, e una casella vera qui
// dentro sarebbe pubblicata per sempre.
const UNA = 'giugliano@example.test';
const DUE = 'aversa@example.test';
const TRE = 'cesa@example.test';

describe('il finto rifiuta come Resend — il controllo negativo che tiene su tutto il resto', () => {
  it('la stringa con la virgola prende 422, ESATTAMENTE come in produzione', async () => {
    // Se questo test diventa verde col vecchio codice, il finto è tornato
    // permissivo e nessuno degli altri test di questo file vale più niente.
    global.fetch = vi.fn(async (_u: unknown, init?: unknown) => {
      const c = JSON.parse((init as { body: string }).body) as { to: unknown };
      expect(c.to).toEqual([UNA, DUE]); // la correzione: elenco, non stringa
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    const esito = await sendEmailDetailed({ to: [UNA, DUE], subject: 's', text: 't' });
    expect(esito.ok).toBe(true);
  });

  it('il vecchio comportamento (una stringa `a, b`) sarebbe rifiutato dal finto', async () => {
    // Non passa da `sendEmailDetailed`: interroga il finto direttamente, perché
    // la rete di sicurezza in `destinatariPerIlProvider` ORA impedisce a quella
    // forma di arrivare al provider. Questo test misura il FINTO, non il codice:
    // è la prova che il banco di prova sa dire di no.
    const res = await (global.fetch as unknown as typeof fetch)('https://api.resend.com/emails', {
      method: 'POST',
      body: JSON.stringify({ to: `${UNA}, ${DUE}`, subject: 's', text: 't' }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Invalid `to` field');
  });
});

describe('sendEmailDetailed — il campo `to` sul filo', () => {
  it('un elenco di tre plessi arriva come elenco, e parte', async () => {
    const esito = await sendEmailDetailed({ to: [UNA, DUE, TRE], subject: 's', text: 't' });
    expect(esito.ok).toBe(true);
    expect(ultimoCorpo?.to).toEqual([UNA, DUE, TRE]);
  });

  it('un destinatario solo resta un elenco di uno — un elenco di uno è un elenco', async () => {
    const esito = await sendEmailDetailed({ to: UNA, subject: 's', text: 't' });
    expect(esito.ok).toBe(true);
    expect(ultimoCorpo?.to).toEqual([UNA]);
  });

  it("la forma `Nome <indirizzo>` NON si spezza, nemmeno se il nome ha una virgola", async () => {
    // Spezzarla produrrebbe due destinatari inesistenti: un invio riuscito
    // trasformato in due rifiuti.
    const conNome = `Rossi, Maria <${UNA}>`;
    const esito = await sendEmailDetailed({ to: conNome, subject: 's', text: 't' });
    expect(esito.ok).toBe(true);
    expect(ultimoCorpo?.to).toEqual([conNome]);
  });
});

describe('destinatariPerIlProvider — la rete sotto il tipo', () => {
  it('separa una stringa con le virgole invece di far fallire l’invio', () => {
    expect(destinatariPerIlProvider(`${UNA}, ${DUE}`)).toEqual([UNA, DUE]);
  });

  it('e NON tace: quella separazione lascia una riga `warn`', () => {
    // Silenzio qui vorrebbe dire che il difetto del 2026-08-20 può tornare e
    // sopravvivere, perché l'email partirebbe comunque e nessuno lo saprebbe.
    log.logEvento.mockClear();
    destinatariPerIlProvider(`${UNA}, ${DUE}`);
    const righe = log.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'destinatari-in-una-stringa-sola',
    );
    expect(righe).toHaveLength(1);
    expect(righe[0][1]).toBe('warn');
    expect((righe[0][2] as { n_destinatari?: number }).n_destinatari).toBe(2);
  });

  it('un elenco già elenco passa intatto e non logga niente', () => {
    log.logEvento.mockClear();
    expect(destinatariPerIlProvider([UNA, DUE])).toEqual([UNA, DUE]);
    expect(log.logEvento).not.toHaveBeenCalled();
  });

  it('gli spazi attorno agli indirizzi si tolgono, e i pezzi vuoti spariscono', () => {
    expect(destinatariPerIlProvider(`  ${UNA} ,, ${DUE}  `)).toEqual([UNA, DUE]);
  });
});
