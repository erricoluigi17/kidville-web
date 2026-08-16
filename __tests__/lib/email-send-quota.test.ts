import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * «NON OGGI» NON È «NON SI PUÒ».
 *
 * IL DIFETTO CHE QUESTI TEST BLOCCANO. Chi manda gli inviti in blocco (la ripresa
 * delle iscrizioni, `src/lib/iscrizioni/import/inviti.ts`) ha un solo bivio: o
 * l'email è partita, o si registra un fallimento — e un fallimento consuma un
 * tentativo, sporca `ultimo_errore` e dopo tre giri marca la riga come bloccata.
 * Se il rifiuto per QUOTA (`429`) finisse in quel ramo, il giorno in cui il tetto
 * del piano Resend si esaurisce a metà giro verrebbero marcate come «rotte»
 * decine di iscrizioni perfettamente buone: il messaggio non è mai stato guardato,
 * il destinatario nemmeno: ha solo parlato il contatore del provider.
 *
 * LA REGOLA, ed è tutta qui: `429` → `rinviabile: true`. Ogni altro rifiuto no.
 *
 * IL TEST CHE CONTA DAVVERO NON È IL PRIMO. È quello sul `403`: rendere rinviabile
 * il `429` è facile, rendere rinviabile TUTTO è il modo in cui questa regola si
 * rompe davvero — e sarebbe il guasto storico di questo repo travestito da
 * gentilezza, perché un dominio non verificato non passa aspettando domani:
 * costruirebbe una coda che ritenta all'infinito senza che nessuna riga dica mai
 * «fallita».
 *
 * COME SI OSSERVA. Come in `email-send.test.ts`: si sostituisce `globalThis.fetch`
 * (la guardia anti-produzione di `test/setup.ts` non serve a un test che si finge
 * la rete). Il logger è silenzioso sotto vitest, quindi si mocka con delle spie:
 * l'unico modo di guardare il LIVELLO della riga.
 */

// ── Le spie sul logger ───────────────────────────────────────────────────────
// Vale anche per `externalFetch`, che dal logger passa a sua volta: qui interessa
// la riga che emette `send.ts`, riconoscibile dal campo `esito`.
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }));
vi.mock('@/lib/logging/logger', () => log);

import { sendEmail, sendEmailDetailed } from '@/lib/email/send';

const realFetch = global.fetch;
const realKey = process.env.RESEND_API_KEY;

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  log.logEvento.mockClear();
});

afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

// Destinatario inventato su dominio `.test`: il repo è pubblico e un indirizzo
// vero di famiglia qui dentro sarebbe pubblicato per sempre.
const params = { to: 'genitore.finto@example.test', subject: 'Le tue credenziali', text: 'corpo' };

/** Una risposta del provider, con lo status che si vuole misurare. */
function rispondiCon(stato: number, corpo: string) {
  global.fetch = vi.fn(async () => new Response(corpo, { status: stato })) as typeof fetch;
}

/** Il corpo con cui Resend rifiuta per tetto orario superato. */
const CORPO_429 = JSON.stringify({
  statusCode: 429,
  message: 'Too many requests. You can only make 2 requests per second.',
});

describe('sendEmailDetailed — il 429 è un rinvio, non un fallimento', () => {
  it('429 → ok falso ma rinviabile, e il motivo nomina la quota', async () => {
    rispondiCon(429, CORPO_429);
    const r = await sendEmailDetailed(params);
    // `ok: false` resta vero: quell'email NON è partita. Chi non guarda il campo
    // nuovo si comporta esattamente come prima — è ciò che lo rende additivo.
    expect(r.ok).toBe(false);
    expect(r.rinviabile).toBe(true);
    // Il motivo deve poter finire in un avviso all'operatore SENZA traduzione:
    // «quota» dice cosa aspettare, il numero dice a chi chiedere.
    expect(r.error).toMatch(/quota/i);
    expect(r.error).toMatch(/429/);
    // E il corpo del provider non si butta via nemmeno qui (AGENTS, regola 3).
    expect(r.error).toMatch(/2 requests per second/);
  });

  it('429 a corpo vuoto → resta rinviabile, e il motivo regge da solo', async () => {
    // Un provider dietro a un proxy può rispondere 429 senza dire una parola:
    // il rinvio non può dipendere dalla presenza di un messaggio.
    rispondiCon(429, '');
    const r = await sendEmailDetailed(params);
    expect(r.rinviabile).toBe(true);
    expect(r.error).toMatch(/quota/i);
  });

  it('429 → riga a livello warn: è il tetto del piano, non un guasto', async () => {
    // A `error` ogni giro di inviti che tocca il tetto avvelenerebbe il canale
    // degli errori veri; senza riga, invece, nessuno saprebbe MAI perché il giro
    // è finito prima del previsto. Quindi: scritta, ma a `warn`.
    rispondiCon(429, CORPO_429);
    await sendEmailDetailed(params);
    const quota = log.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: unknown } | undefined)?.esito === 'quota-esaurita',
    );
    expect(quota, 'il rifiuto per quota deve lasciare una riga sua').toBeDefined();
    expect(quota?.[1]).toBe('warn');
  });

  it('il wrapper booleano `sendEmail` resta false sul 429 (nessun chiamante cambia)', async () => {
    // La retro-compatibilità è la ragione per cui `rinviabile` è opzionale: un
    // 429 che diventasse `true` farebbe credere a 13 chiamanti che l'email è
    // partita, ed è il guasto storico di questo file al contrario.
    rispondiCon(429, CORPO_429);
    expect(await sendEmail(params)).toBe(false);
  });
});

describe('sendEmailDetailed — tutto il resto NON si rinvia', () => {
  it('403 dominio non verificato → NON rinviabile (aspettare domani non lo ripara)', async () => {
    // È IL TEST CHE PROTEGGE DAL RENDERE RINVIABILE TUTTO. Questo 403 è il guasto
    // vero del 2026-07: il dominio non verificato non si sistema col tempo, si
    // sistema su Resend. Trattarlo come «non oggi» significherebbe ritentare per
    // sempre senza che nessuno veda mai una riga «fallita» — cioè mesi di email
    // mai arrivate con il registro che dice «in coda».
    rispondiCon(403, JSON.stringify({ statusCode: 403, message: 'The kidville.it domain is not verified' }));
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.rinviabile ?? false).toBe(false);
    expect(r.error).toMatch(/403/);
    expect(r.error).toMatch(/not verified/);
  });

  it('422 destinatario rifiutato → NON rinviabile (è il messaggio, non il tetto)', async () => {
    rispondiCon(422, JSON.stringify({ statusCode: 422, message: 'Invalid `to` field' }));
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.rinviabile ?? false).toBe(false);
  });

  it('500 del provider → NON rinviabile: transitorio non è dimostrato', async () => {
    // Un 500 PUÒ essere passeggero quanto un 429, ma può anche essere una
    // configurazione rotta che nessuna attesa sistema: solo il 429 ha un
    // significato unico e scritto nel protocollo. La ristrettezza è la regola.
    rispondiCon(500, 'boom testuale');
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.rinviabile ?? false).toBe(false);
  });

  it('errore di rete (nessuna risposta) → NON rinviabile, e il motivo dice rete', async () => {
    // `externalFetch` riporta `stato: 0` quando una risposta non c'è stata
    // affatto: zero non è 429, e il ramo del rinvio non deve nemmeno essere
    // sfiorato — altrimenti un DNS rotto diventerebbe una coda infinita.
    global.fetch = vi.fn(async () => {
      throw new Error('rete giù');
    }) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.rinviabile ?? false).toBe(false);
    expect(r.error).toMatch(/rete/);
  });

  it('senza RESEND_API_KEY → NON rinviabile: domani non riparte da sola', async () => {
    // Sembra il caso più «temporaneo» di tutti, ed è il contrario: una chiave
    // assente non torna col tempo, torna quando qualcuno la configura. Marcarlo
    // rinviabile costruirebbe una coda che cresce in silenzio — zero email, zero
    // fallimenti, zero sospetti: esattamente il guasto muto di questo file.
    delete process.env.RESEND_API_KEY;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.rinviabile ?? false).toBe(false);
    expect(r.error).toMatch(/non configurato/);
  });
});

describe('sendEmailDetailed — il successo non porta il campo nuovo', () => {
  it('200 → l\'esito è esattamente {ok, error, messageId}, senza `rinviabile`', async () => {
    // NON è pedanteria di forma: `email-send.test.ts:36` asserisce l'esito del
    // ramo di successo con un `toEqual` ESATTO. Un `rinviabile: false` aggiunto
    // «per simmetria» lo farebbe diventare rosso — e il campo direbbe comunque
    // una cosa priva di senso, perché un'email partita non si rinvia.
    rispondiCon(200, '{"id":"msg-finto-1"}');
    const r = await sendEmailDetailed(params);
    expect('rinviabile' in r).toBe(false);
    expect(r).toStrictEqual({ ok: true, error: null, messageId: 'msg-finto-1' });
  });
});
