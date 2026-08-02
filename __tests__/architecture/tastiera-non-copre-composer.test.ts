import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ─── LA TASTIERA NON DEVE COPRIRE LA BARRA DI COMPOSIZIONE DELLA CHAT ───────
 *
 * La chat è il canale con cui le famiglie parlano con la scuola. Se aprendo la
 * tastiera sparisce la barra con «allega · fotocamera · scrivi · Invia», il
 * genitore non può mandare il messaggio e non capisce perché.
 *
 * **COSA È STATO MISURATO, il 2026-08-02.** Il rilievo era aperto da un ciclo
 * precedente, dove era stato formulato ma provato solo su una SONDA che
 * riproduceva il layout — non sulla chat vera (`GET /teacher/chat` rispondeva
 * 307 e in WebView dava «Qualcosa è andato storto»). Rifatto sulla schermata
 * VERA, con sessione valida, su genitore E docente, su due versioni di Android,
 * con la tastiera confermata da `dumpsys input_method` (`mInputShown=true`) e non
 * dedotta:
 *
 *   API 36 (viewport CSS 411×731)  chiusa → aperta:
 *     innerHeight 731 → 399 · visualViewport.height 731,43 → 399,24
 *     bottone «Invia» bottom 695 → 387 · offsetTop sempre 0 · VISIBILE (12px sotto)
 *   API 33 (viewport CSS 393×778)  chiusa → aperta:
 *     innerHeight 778 → 499 · visualViewport.height 778,18 → 499,27
 *     bottone «Invia» bottom 766 → 487 · offsetTop sempre 0 · VISIBILE (12px sotto)
 *
 * Il difetto **non si riproduce**. L'ipotesi alternativa — «un `transform` su un
 * antenato diventa blocco contenitore per i `fixed`» — è stata falsificata a
 * runtime risalendo l'intera catena da `[aria-label="Invia messaggio"]` fino a
 * `documentElement`: nessun antenato con `transform` diverso da `none`.
 *
 * **Perciò nessun rimedio applicativo è stato aggiunto**, e in particolare NON
 * `interactive-widget=resizes-content` in `src/app/layout.tsx`: i numeri dicono
 * che il comportamento che quella direttiva imporrebbe è già quello di default
 * (`offsetTop` 0 e viewport che si accorcia = `resizes-content`, non
 * `overlays-content`). Un rimedio che non fa niente è peggio del rilievo aperto:
 * chiude la voce e toglie a chiunque la ragione di guardarci ancora.
 *
 * ─── COSA DIFENDE QUESTO LOCK ──────────────────────────────────────────────
 *
 * Una cosa sola, ed è l'unica correzione difendibile emersa: il comportamento
 * misurato dipendeva da un DEFAULT di sistema, non da una nostra scelta. Senza
 * `windowSoftInputMode` vale `adjustUnspecified` e decide la ROM; sulle versioni
 * provate risolve in `adjustResize`, ma su una che risolvesse in `adjustPan` la
 * finestra scorrerebbe invece di ridimensionarsi e il composer uscirebbe davvero
 * dallo schermo. Dichiararlo non cambia nulla di ciò che è stato misurato: toglie
 * la dipendenza da chi ha compilato la ROM.
 *
 * LIMITE DICHIARATO, che questo lock non copre e che non va abbellito: tutte le
 * misure sono su EMULATORE, con Gboard, in verticale, a schermo intero. Restano
 * non provati un dispositivo fisico, le tastiere di terze parti (SwiftKey,
 * Samsung, IME con barra candidati), l'orizzontale e lo split-screen. API 30 è
 * BLOCCATA per una ragione diversa e nota: quella WebView è Chrome 91 e il
 * bundle non ci gira (`SyntaxError: Unexpected token '{'`), quindi non dice
 * niente sulla tastiera.
 */

const RADICE = process.cwd();
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const LAYOUT = 'src/app/layout.tsx';

function leggi(relativo: string): string {
  return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

/** Il blocco `<activity …>` della MainActivity, attributi compresi. */
function attributiMainActivity(manifest: string): string {
  const i = manifest.search(/<activity\b[^>]*android:name="\.MainActivity"/s);
  // L'ordine degli attributi non è garantito: si cerca l'apertura del tag che
  // contiene `.MainActivity`, non una posizione fissa.
  const inizio = i >= 0 ? i : manifest.search(/<activity\b/);
  if (inizio < 0) throw new Error(`${MANIFEST}: nessuna <activity> trovata`);
  const fine = manifest.indexOf('>', inizio);
  if (fine < 0) throw new Error(`${MANIFEST}: tag <activity> mai chiuso`);
  return manifest.slice(inizio, fine + 1);
}

describe('lock: la tastiera non copre la barra di composizione della chat', () => {
  it('la MainActivity dichiara windowSoftInputMode=adjustResize', () => {
    const tag = attributiMainActivity(leggi(MANIFEST));
    expect(
      tag,
      'Senza questo attributo vale `adjustUnspecified` e decide la ROM: se risolve in ' +
        '`adjustPan` la finestra scorre invece di ridimensionarsi, e la barra con «Invia» ' +
        'esce dallo schermo mentre il genitore scrive alla scuola. Misurato il 2026-08-02: ' +
        'su API 36 e 33 il viewport si accorcia (731→399, 778→499) e il composer resta ' +
        'visibile — ma perché il sistema sceglieva adjustResize, non perché lo chiedessimo noi.',
    ).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it('la MainActivity NON torna a un modo che sposta la finestra invece di ridimensionarla', () => {
    const tag = attributiMainActivity(leggi(MANIFEST));
    const modo = /android:windowSoftInputMode="([^"]+)"/.exec(tag)?.[1] ?? '';
    expect(
      modo.includes('adjustPan'),
      `windowSoftInputMode="${modo}": \`adjustPan\` fa scorrere la finestra sotto la tastiera ` +
        'invece di ridimensionarla. È esattamente il comportamento che il rilievo descriveva.',
    ).toBe(false);
    expect(
      modo.includes('adjustNothing'),
      `windowSoftInputMode="${modo}": \`adjustNothing\` lascia la tastiera sopra la pagina.`,
    ).toBe(false);
  });

  it('non è stato aggiunto `interactive-widget` senza una misura che lo giustifichi', () => {
    // Non è una regola di stile: è la contromisura al rimedio-placebo. Se un
    // giorno servirà davvero, chi lo aggiunge deve poter esibire la misura in cui
    // `visualViewport.offsetTop` è diverso da 0 (cioè la tastiera che si sovrappone
    // invece di accorciare) — e allora aggiornerà anche questo lock e il commento
    // in cima, dicendo su quale dispositivo l'ha vista.
    expect(
      leggi(LAYOUT),
      'Misurato il 2026-08-02 su API 36 e API 33, chat vera, genitore e docente: ' +
        '`visualViewport.offsetTop` è SEMPRE 0 e `innerHeight` si accorcia da sé — cioè il ' +
        'comportamento è già `resizes-content`. Aggiungere la direttiva non cambierebbe niente ' +
        'e farebbe sembrare chiuso da un rimedio ciò che è chiuso da una misura. Se hai una ' +
        'misura contraria, mettila qui e in `tastiera-non-copre-composer.test.ts`.',
    ).not.toContain('interactive-widget');
  });
});
