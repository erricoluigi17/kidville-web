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
 * dallo schermo. Dichiararlo toglie la dipendenza da chi ha compilato la ROM.
 *
 * ⚠️ FINO AD ANDROID 14, E NON OLTRE — correzione del 2026-08-02.
 *
 * La frase qui sopra era scritta come se l'attributo proteggesse ovunque. Non è
 * così, ed è stato MISURATO: compilando un APK gemello con `adjustPan` e
 * installandolo sui due emulatori,
 *   · API 36 → numeri IDENTICI a quelli dell'APK ufficiale con `adjustResize`
 *     (ih 731→399, «Invia» bottom 695→387, margine 12px): l'attributo è INERTE;
 *   · API 33 → il composer sparisce davvero sotto la tastiera: l'attributo è
 *     DECISIVO.
 * Il perché: da Android 15 le app con `targetSdk ≥ 35` sono edge-to-edge per
 * forza e `windowSoftInputMode` non ridimensiona più la finestra — gli inset
 * dell'IME arrivano alla vista e Chromium WebView accorcia da sé il viewport.
 * Questa app dichiara `targetSdk 36`.
 *
 * Conseguenza pratica, ed è la ragione per cui la correzione è di PAROLE e non
 * di codice: la riga va TENUTA (su Android ≤ 14 è ciò che regge il composer), ma
 * chi domani vedrà la tastiera coprire la barra su un telefono nuovo non deve
 * perdere tempo a rileggerla credendola la difesa. Su API ≥ 35 la difesa, se
 * servisse, sarebbe gestire gli inset (`WindowInsetsCompat.Type.ime`) o
 * `interactive-widget` — e allora servirà una misura con
 * `visualViewport.offsetTop ≠ 0` da esibire.
 *
 * Va anche registrata la PROVA DI VALIDITÀ che prima non c'era: nessuno aveva
 * mai dimostrato SUL DISPOSITIVO che quella riga servisse. Ora è dimostrato su
 * API 33. Non è un placebo — è una difesa con un perimetro.
 *
 * ─── LIMITE DICHIARATO ─────────────────────────────────────────────────────
 * Tutte le misure sono su EMULATORE, con Gboard, a schermo intero. Restano non
 * provati un dispositivo fisico, le tastiere di terze parti (SwiftKey, Samsung,
 * IME con barra candidati) e lo split-screen affiancato vero. API 30 è BLOCCATA
 * per una ragione diversa e nota: quella WebView è Chrome 91 e il bundle non ci
 * gira (`SyntaxError: Unexpected token '{'`), quindi non dice niente sulla
 * tastiera.
 *
 * L'ORIZZONTALE NON È PIÙ «NON PROVATO»: è provato, e NON regge. Misurato il
 * 2026-08-02, chat con tastiera aperta:
 *   · API 36 landscape → viewport 150 CSS px, «Invia» top 126 / bottom 170,
 *     margine −20: il bottone è tagliato dal bordo e resta toccabile per 24,4px
 *     su 44 (hit-test: y=130 e y=148 → INVIA, y=166 → null);
 *   · API 33, ruotando DENTRO una conversazione → la conversazione si CHIUDE
 *     (si torna alla lista), la tastiera si chiude, il composer residuo è largo
 *     33px e non prende il fuoco ai tap. Causa: la conversazione aperta non sta
 *     nell'URL (genitore e docente restano su `/parent/chat` · `/teacher/chat`
 *     anche dentro la conversazione), quindi il cambio di configurazione la
 *     butta via al rimontaggio.
 * È DEBITO DICHIARATO, non chiuso: i due rimedi (una regola di layout sotto una
 * certa altezza di viewport, e la conversazione portata nell'URL) toccano file
 * che erano in lavorazione da altri quando questa riga è stata scritta. Va
 * ripreso; nel frattempo non si dica più che l'orizzontale non è provato.
 */

const RADICE = process.cwd();
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const LAYOUT = 'src/app/layout.tsx';

function leggi(relativo: string): string {
  return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

/** Il blocco `<activity …>` della MainActivity, attributi compresi. */
function attributiMainActivity(manifest: string): string {
  // `[^>]*` attraversa già i newline (una classe negata li include): niente flag `s`,
  // che il target di questo progetto non accetta (TS1501, e lo vede solo `tsc --noEmit`
  // — build e vitest passano lo stesso).
  const i = manifest.search(/<activity\b[^>]*android:name="\.MainActivity"/);
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

  it('il manifest DICHIARA fin dove l\'attributo ha effetto (Android ≤ 14)', () => {
    // Il commento diceva che la riga «toglie la dipendenza da chi ha compilato la
    // ROM», senza aggiungere che da Android 15 (targetSdk ≥ 35, edge-to-edge
    // forzato) il sistema la ignora e l'inset della tastiera lo applica la
    // WebView. Misurato con un APK gemello ad `adjustPan`: su API 36 i numeri
    // sono identici al millimetro, su API 33 il composer sparisce. Una difesa
    // descritta più larga di quanto sia è peggio di una difesa assente: manda
    // fuori strada chi indagherà il prossimo guasto.
    // Si guarda SOLO il commento che parla di `windowSoftInputMode`, non l'intero
    // manifest: «targetSdk» compare già in un altro commento (quello sui
    // riferimenti XML), e cercarlo nel file intero rendeva questo test verde
    // senza che nessuno avesse scritto niente. È il falso verde che questo lock
    // esiste per non produrre.
    const manifest = leggi(MANIFEST);
    const commenti = manifest.match(/<!--[\s\S]*?-->/g) ?? [];
    const blocco = commenti.find((c) => c.includes('windowSoftInputMode'));
    expect(blocco, 'nessun commento spiega `windowSoftInputMode` nel manifest').toBeDefined();
    expect(
      /Android 15|targetSdk\s*(?:≥|>=)?\s*35|API\s*(?:≥|>=)\s*35/i.test(blocco ?? ''),
      'il commento di `windowSoftInputMode` non dice che da Android 15 / targetSdk 35 ' +
        'l\'attributo è ignorato: chi legge lo crederà la difesa anche sui telefoni nuovi. ' +
        'Misurato con un APK gemello ad `adjustPan`: su API 36 numeri identici, su API 33 ' +
        'il composer sparisce.',
    ).toBe(true);
  });

  it('il targetSdk dichiarato è ancora quello su cui la misura è stata fatta', () => {
    // Se un giorno il targetSdk scendesse sotto 35, l'attributo tornerebbe
    // efficace ovunque e il paragrafo qui sopra andrebbe riscritto — al
    // contrario. Il numero è il perno di tutto il ragionamento: si àncora.
    const gradle = leggi('android/variables.gradle');
    const target = /targetSdkVersion\s*=\s*(\d+)/.exec(gradle)?.[1];
    expect(target, 'targetSdkVersion non trovato in android/variables.gradle').toBeDefined();
    expect(Number(target)).toBeGreaterThanOrEqual(35);
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
