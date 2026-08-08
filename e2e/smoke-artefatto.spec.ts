import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

/**
 * R11 · R20 — LA PROVA CHE GIRA SUL PRODOTTO COMPILATO, non sul sorgente.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il quinto collaudo (2026-08-08) ha trovato otto rotte che rispondevano **500
 * con corpo vuoto, zero byte, a tutte le famiglie**: l'ottimizzatore di
 * Turbopack compilava il ramo `null` di `assertGenitoreNonSospeso` nella stringa
 * «TURBOPACK unreachable», le rotte facevano `if (sospesoErr) return sospesoErr`
 * e Next non aveva nessuna Response da inviare.
 *
 * Nessuno dei quattro cancelli del gate poteva vederlo, e la ragione è una sola:
 * **girano tutti sul sorgente**. `eslint`, `tsc` e 7.694 test leggono il
 * TypeScript; `next build` esce 0 perché la build RIESCE — è il codice che
 * genera a essere sbagliato. E l'E2E, che sarebbe l'unico a eseguire il
 * prodotto, gira su `npm run dev` (`playwright.config.ts`), cioè sull'unica
 * configurazione in cui quel difetto NON esiste.
 *
 * Questo spec gira contro `next start`, cioè contro l'artefatto che va in
 * produzione. È la sola prova del repo che lo faccia.
 *
 * ─── COSA MISURA, E PERCHÉ NON GUARDA LO STATUS ─────────────────────────────
 * Non pretende un 201: il database E2E è un progetto separato e non migrato, e
 * il codice nuovo deve degradare pulito (`PGRST204`, `42703`). Un test che
 * pretendesse la scrittura sarebbe rosso per il database, non per il prodotto.
 *
 * Misura la FIRMA ESATTA del guasto, che è indipendente dai dati:
 *   · la risposta ha un CORPO (il difetto dava zero byte);
 *   · quel corpo è JSON leggibile;
 *   · non è il 500 di emergenza che `withRoute` emette quando l'handler non
 *     restituisce una Response (`HANDLER_SENZA_RESPONSE`) — che è il segnale,
 *     ora dichiarato, dello stesso identico guasto.
 *
 * Il terzo punto è la prova vera: dal 2026-08-08 un handler che non torna una
 * Response non produce più un 500 muto, ma un 500 che si NOMINA. Se quel codice
 * comparisse qui, vorrebbe dire che la classe di difetto è tornata — su questa
 * rotta o su qualunque altra, perché la guardia è nel wrapper condiviso.
 */

test.use({ storageState: STORAGE.genitore });

/** Le rotte del genitore che il guasto aveva messo a terra, e che una sessione raggiunge. */
const ROTTE = [
  {
    nome: 'comunica-assenza:POST',
    url: '/api/parent/presenze/comunica-assenza',
    corpo: { studentId: '00000000-0000-4000-8000-000000000000', data: '2099-12-31' },
  },
  {
    nome: 'giustifica:POST',
    url: '/api/parent/presenze/giustifica',
    corpo: { presenzaId: '00000000-0000-4000-8000-000000000000' },
  },
] as const;

for (const rotta of ROTTE) {
  test(`${rotta.nome}: sull'artefatto compilato risponde con un corpo, non con un 500 muto`, async ({
    request,
  }) => {
    const res = await request.post(rotta.url, { data: rotta.corpo });
    const testo = await res.text();

    expect(
      testo.length,
      `${rotta.nome} ha risposto ${res.status()} con ZERO BYTE: è la firma del guasto del ` +
        'quinto collaudo — un handler che non restituisce una Response. Il sorgente è ' +
        "sano (i test unitari lo provano): il difetto sta nell'artefatto compilato.",
    ).toBeGreaterThan(0);

    const corpo: unknown = JSON.parse(testo);
    expect(
      (corpo as { codice?: string }).codice,
      `${rotta.nome} è finita nel 500 di emergenza di withRoute: l'handler non ha restituito ` +
        'una Response. È la classe di guasto di R11/R14/R20, tornata.',
    ).not.toBe('HANDLER_SENZA_RESPONSE');
  });
}

test('la difesa è del wrapper, quindi vale per una rotta qualunque', async ({ request }) => {
  // Una GET innocua e senza effetti: se il wrapper degradasse, si vedrebbe anche qui.
  const res = await request.get('/api/parent/presenze?studentId=00000000-0000-4000-8000-000000000000');
  const testo = await res.text();
  expect(testo.length).toBeGreaterThan(0);
  expect((JSON.parse(testo) as { codice?: string }).codice).not.toBe('HANDLER_SENZA_RESPONSE');
});
