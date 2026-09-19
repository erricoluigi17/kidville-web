'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useParentIdentity } from './use-parent-identity';

export type SchoolType = 'primaria' | 'infanzia' | 'nido';

/**
 * La risposta della rete, LEGATA AL FIGLIO a cui appartiene. Senza `figlio` un
 * esito sopravvivrebbe al cambio di bambino — è il modo in cui un fratello
 * eredita il grado dell'altro.
 *
 * `determinato` separa «il server ha detto che non c'è grado» da «il server non
 * ha detto niente» (un 500, la rete giù): entrambi chiudono l'attesa, ma solo il
 * primo ha il diritto di smentire ciò che il dispositivo ricordava.
 */
interface EsitoGrado {
  figlio: string;
  grado: SchoolType | null;
  determinato: boolean;
}

/**
 * La memoria del grado non cambia sotto i piedi di chi la legge: la scrive
 * questo stesso hook, subito dopo una risposta, e ogni scrittura passa già da un
 * `setState`. Nessuna sottoscrizione, quindi — ma la funzione è di MODULO e non
 * un letterale inline: `useSyncExternalStore` si riabbona a ogni identità nuova
 * di `subscribe`, e un letterale ne crea una a ogni render.
 */
const nessunaSottoscrizione = () => () => {};

/**
 * I TRE GRADI NOTI, e la funzione che li riconosce.
 *
 * Serve a DUE ingressi, non a uno: la risposta della rete e la voce riletta dal
 * `localStorage`. Il secondo è scrivibile da chiunque abbia la console aperta —
 * la stessa ragione per cui `riprendiCoda` (`@/lib/logging/client`) non si fida
 * della propria coda persistita — e una quarta parola che nessun ramo dell'app
 * si aspetta non deve poter arrivare fino a `isPrimaria`.
 */
const GRADI_NOTI: readonly SchoolType[] = ['primaria', 'infanzia', 'nido'];

function eGradoNoto(v: unknown): v is SchoolType {
  return typeof v === 'string' && (GRADI_NOTI as readonly string[]).includes(v);
}

/**
 * ─── PERCHÉ IL GRADO SI RICORDA ─────────────────────────────────────────────
 *
 * Il grado di un bambino non cambia mai **dentro un anno scolastico**: nessuno
 * passa da nido a primaria a metà anno.
 *
 * ⚠️ FRA un anno e l'altro invece cambia, con lo STESSO uuid, e questa voce non
 * scade: attraversa l'estate. A settembre, alla prima apertura, un bambino
 * passato da infanzia a primaria trova il seme vecchio — `gradoIgnoto` falso,
 * riga a quattro colonne — e quando la rete risponde `primaria` la riga va a
 * cinque: `4 → 5`, il **verso cattivo** (un bersaglio compare fra quelli già
 * mirati), sul ramo che la tabella degli assestamenti in `parent/page.tsx` dà a
 * zero. Dura **un** giro di rete, si ripara da sé (`memorizzaGrado`: la rete
 * vince sempre e riscrive) e capita **una volta per bambino, in tutta la sua
 * carriera**. È dichiarato e non corretto: chiuderlo vorrebbe dire datare la
 * voce con l'anno scolastico, cioè un secondo dato da invalidare — un prezzo
 * più alto del difetto. Chi lo chiuderà aggiorni anche quella tabella.
 *
 * Ma ogni apertura dell'app lo dimenticava, e il costo non era
 * teorico — la riga delle scorciatoie della home ha CINQUE colonne per la
 * primaria («Compiti» in più) e QUATTRO per il 0-6, quindi finché il grado non
 * si sapeva la quinta colonna restava riservata e all'arrivo della risposta la
 * riga si riassestava. Per il 0-6, che in questo prodotto è la MAGGIORANZA
 * delle famiglie, il centro della quarta card passa da ~0,70 a ~0,875 della
 * larghezza: un dito puntato sul vecchio centro atterra DENTRO la terza card.
 *
 * ─── LA FORMA: UNA VOCE PER FIGLIO ──────────────────────────────────────────
 *
 * `kv_grado_<uuid del figlio>` → `'primaria' | 'infanzia' | 'nido'`. La chiave
 * dipende dal figlio e non dal dispositivo, perché due fratelli possono avere
 * due gradi diversi: una voce sola, globale, darebbe al secondo la griglia del
 * primo — ed è l'errore che si fa scrivendo la cache più semplice.
 *
 * Dentro non ci va nient'altro. Il grado è un'ETICHETTA — non una classe, non
 * una sezione, non un nome: tre parole che valgono per centinaia di bambini.
 * L'unico dato personale della voce è l'uuid nella chiave, lo stesso che
 * `kv_student_id` tiene già sullo stesso dispositivo.
 *
 * ─── È UN SUGGERIMENTO, NON UNA VERITÀ ──────────────────────────────────────
 *
 * La risposta della rete vince SEMPRE e riscrive la voce; una voce assente,
 * malformata o che non è uno dei tre gradi si ignora e si torna esattamente al
 * comportamento di prima. Il `localStorage` può lanciare (finestra privata,
 * quota, storage negato, WebView antica): ogni accesso è avvolto, e un guasto
 * della cache riporta il grado a «ignoto», cioè a ieri — non rompe la home.
 */
const PREFISSO_GRADO = 'kv_grado_';

/** Il figlio scelto su QUESTO dispositivo: la stessa chiave che scrive `useParentIdentity`. */
const CHIAVE_FIGLIO = 'kv_student_id';

/**
 * Il guasto dello storage NON si ingoia in silenzio.
 *
 * `logClient` ha un anti-tempesta di 60 s per chiave `evento|messaggio|stato`,
 * quindi una finestra privata — dove OGNI accesso fallisce, su ogni mount di
 * ogni pagina genitore — produce una riga al minuto per operazione, non una per
 * render. È il motivo per cui qui si logga invece di ingoiare come fanno i
 * `catch` vuoti dei vicini: senza una riga, «la cache non funziona su nessun
 * dispositivo» e «la cache funziona» sono lo stesso identico silenzio.
 *
 * `warn` e non `info` perché il canale del client non ha `info`
 * (`EventoClient.livello` è `'warn' | 'error'`). Solo `nomeErrore`: il
 * `message` di un'eccezione dello storage può citare la chiave, e nella chiave
 * c'è l'uuid di un minore.
 */
function segnalaStorage(operazione: string, err: unknown): void {
  logClient({
    livello: 'warn',
    evento: 'react',
    messaggio: `grado-figlio-cache-non-disponibile — operazione=${operazione}`,
    campi: { error_code: nomeErrore(err) },
  });
}

/**
 * ⚠️ IL `typeof window` NON È UNA CINTURA IN PIÙ SUL `try`, È UN RAMO DIVERSO.
 * Questi lettori girano anche durante il RENDER, e i componenti client vengono
 * resi pure sul server (il layout radice fa `await cookies()`: ogni rotta è
 * dinamica). Lì `window` non esiste: senza questa uscita il `catch` chiamerebbe
 * `logClient` a ogni richiesta, cioè accoderebbe eventi in un modulo che sul
 * server è condiviso fra utenti — la regola 1 di `logging/client.ts` esiste per
 * questo. Fuori dal browser non c'è nessun guasto da raccontare: non c'è lo
 * storage, e basta dirlo con un `null`. È la stessa forma di `readStore` in
 * `current-user.ts`.
 */
function fuoriDalBrowser(): boolean {
  return typeof window === 'undefined';
}

/** Il figlio noto al dispositivo, quando l'identità non l'ha ancora risolto. */
function figlioNotoSulDispositivo(): string | null {
  if (fuoriDalBrowser()) return null;
  try {
    return window.localStorage.getItem(CHIAVE_FIGLIO);
  } catch (err) {
    segnalaStorage('figlio-noto', err);
    return null;
  }
}

/** Il grado memorizzato per QUEL figlio, se è uno dei tre. Non lancia mai. */
function leggiGradoMemorizzato(studentId: string): SchoolType | null {
  if (fuoriDalBrowser()) return null;
  let grezzo: string | null;
  try {
    grezzo = window.localStorage.getItem(PREFISSO_GRADO + studentId);
  } catch (err) {
    segnalaStorage('lettura', err);
    return null;
  }
  return eGradoNoto(grezzo) ? grezzo : null;
}

/** Scrive il grado, o TOGLIE la voce quando il grado è `null`. Non lancia mai. */
function memorizzaGrado(studentId: string, grado: SchoolType | null): void {
  if (fuoriDalBrowser()) return;
  try {
    if (grado === null) window.localStorage.removeItem(PREFISSO_GRADO + studentId);
    else window.localStorage.setItem(PREFISSO_GRADO + studentId, grado);
  } catch (err) {
    segnalaStorage('scrittura', err);
  }
}

/**
 * ─── L'INVALIDAZIONE, COPIATA DA `decidiFiglioRivalidato` ───────────────────
 *
 * La regola è quella di `use-parent-identity`: un `kv_student_id` che non è tra
 * i figli reali del genitore non si corregge, si BUTTA (`rimuoviCache`). Qui
 * vale voce per voce — una voce il cui uuid non è tra i `figliIds` non è di
 * questa famiglia (cambio account su un dispositivo condiviso) o non lo è più
 * (figlio archiviato o ritirato: sparisce dall'elenco).
 *
 * ⚠️ E QUI FINISCE CIÒ CHE QUESTA FUNZIONE PUÒ GARANTIRE. Al posto di questo
 * riquadro c'era scritto «così un grado non sopravvive né alla famiglia né
 * all'iscrizione che lo giustificava», ed era falso proprio nel caso che la riga
 * sopra nomina per esteso: quando il figlio archiviato è l'UNICO, l'elenco arriva
 * vuoto e il grado di quel bambino resta sul dispositivo.
 *
 * 🔑 E il MECCANISMO non è quello che verrebbe da pensare — qui prima era scritto
 * «questo filtro non vede nessuna voce da togliere», che è l'**opposto** di ciò
 * che accade. Con `figliIds = []` il predicato `!figliIds.includes(figlio)` è vero
 * per OGNI voce: `dimenticaGradiEstranei([])` le porterebbe via **tutte**. Il
 * grado sopravvive perché **il chiamante esce prima**, non perché il filtro trovi
 * l'insieme vuoto. La differenza conta: letta al contrario, quella frase invita a
 * «semplificare» togliendo la guardia del chiamante, credendo che il caso vuoto
 * sia un no-op — e cancellerebbe la cache di tutti a ogni blip di rete.
 * Il caso dell'elenco vuoto lo decide il CHIAMANTE, che ha in mano il segno per
 * farlo (`inAttesa`) e lo spiega accanto alla guardia.
 *
 * E la stessa ECCEZIONE, che è la parte da non sbagliare: `figliIds` vale `[]`
 * sia per «elenco vuoto» sia per «elenco non determinabile» (rete giù, endpoint
 * non-ok), e questa funzione non può distinguerli — riceve un array e basta. Su
 * un elenco vuoto, quindi, non si cancella NIENTE — e «non si cancella» è una
 * decisione del CHIAMANTE, non un no-op di questa funzione (vedi il 🔑 sopra:
 * chiamata con `[]`, qui dentro il predicato è vero per ogni voce). Una cache
 * buona non si
 * butta per un blip di rete, è scritto per esteso nella testata di
 * `decidiFiglioRivalidato` ed è il punto che impedisce a un rimedio di
 * diventare un nuovo modo di perdere i dati offline. La guardia sta nel
 * chiamante, dove si vede accanto alla ragione.
 *
 * ⚠️ QUESTA pulizia non copre il LOGOUT, e non deve: la sua eccezione
 * sull'elenco vuoto — giusta qui — lì sarebbe esattamente il difetto. Il logout
 * usa `dimenticaTuttiIGradi()`, qui sotto, che è una domanda diversa — la stessa
 * che si fa il chiamante quando il vuoto è determinato.
 */
function dimenticaGradiEstranei(figliIds: readonly string[]): void {
  togliGradi((figlio) => !figliIds.includes(figlio));
}

/**
 * Tutte le voci, senza eccezioni: è la pulizia di chi NON ha dubbi.
 *
 * Non è `dimenticaGradiEstranei([])`, e la differenza non è di stile. Lì
 * l'elenco vuoto significa anche «non ho potuto sapere quali sono i figli» (rete
 * giù), e su quel dubbio la regola è **non cancellare**. Qui il dubbio non
 * esiste, ed è per questo che i chiamanti sono DUE:
 *
 *   · `doLogout` (`lib/auth/logout.ts`) — chi esce esce, e sul dispositivo non
 *     resta l'uuid di un minore;
 *   · l'effetto di pulizia qui sotto, quando l'elenco è vuoto ma DETERMINATO
 *     (`inAttesa`): nessun figlio visibile, quindi nessuna voce può essere di
 *     uno di loro. Il perché sta accanto alla guardia.
 *
 * Esportata per il primo dei due, perché lo chiami invece di ricopiare il
 * prefisso nella sua `LOCAL_KEYS`. È la stessa scelta che quel file ha già fatto
 * per `impostaBiometria(false)`, con la ragione scritta accanto: duplicare la
 * stringa creerebbe due fonti di verità, e il giorno in cui la chiave venisse
 * rinominata il logout smetterebbe di ripulirla **in silenzio**. Che la chiamata
 * ci sia — non solo che sia scritta bene — lo tiene fermo
 * `__tests__/lib/logout.test.ts`.
 */
export function dimenticaTuttiIGradi(): void {
  togliGradi(() => true);
}

/** La meccanica condivisa dalle due pulizie. Non lancia mai. */
function togliGradi(vaTolto: (figlio: string) => boolean): void {
  if (fuoriDalBrowser()) return;
  try {
    const store = window.localStorage;
    // Si raccoglie PRIMA e si cancella DOPO: `removeItem` dentro il giro
    // rinumera gli indici di `key(i)` e salterebbe la voce successiva.
    const daTogliere: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const chiave = store.key(i);
      if (chiave === null || !chiave.startsWith(PREFISSO_GRADO)) continue;
      if (vaTolto(chiave.slice(PREFISSO_GRADO.length))) daTogliere.push(chiave);
    }
    for (const chiave of daTogliere) store.removeItem(chiave);
  } catch (err) {
    segnalaStorage('pulizia', err);
  }
}

/**
 * Recupera il grado scolastico (schoolType) del figlio corrente, per filtrare il
 * menu genitore: un bimbo di primaria non vede le sezioni infanzia e viceversa.
 * `ready` è false finché il dato non è disponibile (evita flicker/nascondere a torto).
 *
 * ⚠️ «FINCHÉ IL DATO NON È DISPONIBILE» HA UN CASO IN CUI È PER SEMPRE: senza
 * `parentId`/`studentId` l'effetto esce prima di chiedere qualcosa, e senza
 * figlio non c'è nemmeno una voce da ricordare — quindi per un genitore senza
 * figli visibili nessuna delle due fonti produce niente e `ready` resta `false`
 * per tutta la vita della pagina. Chi usa questo segno come barriera lo combina
 * con la presenza del figlio (`!!studentId && !ready`, vedi `gradoIgnoto` in
 * `parent/page.tsx`): usato da solo diventa uno skeleton che non finisce mai.
 *
 * ⚠️ DAL 2026-09-19 `ready` PUÒ DIVENTARE VERO SENZA CHE LA RETE ABBIA RISPOSTO,
 * perché il grado può arrivare dalla memoria del dispositivo (vedi il seme qui
 * sotto). Il SIGNIFICATO non cambia — «il grado è disponibile» — cambia da dove
 * arriva; la firma `{ schoolType, ready }` è la stessa. I quattro consumatori
 * sono stati riletti uno per uno prima di toccarlo:
 *
 *   · `parent/page.tsx` (`gradoLetto` → `gradoIgnoto`): un `ready` vero prima
 *     significa una riserva di colonna in meno, cioè il motivo di questo lavoro;
 *   · `parent/diary/page.tsx` (`schoolTypeReady && schoolType === 'primaria'`):
 *     la schermata di cortesia «il diario è solo 0-6» compare subito invece che
 *     dopo la fetch — e se il suggerimento fosse sbagliato durerebbe un giro di
 *     rete, poi la risposta lo smentisce. «Durerebbe» non vuol però dire
 *     «passerebbe inosservato»: quella schermata non è solo testo, porta un
 *     `Link` verso `/parent/primaria` (`parent/diary/page.tsx:484`), quindi in
 *     quel giro al posto del diario c'è un bersaglio TOCCABILE, e un dito veloce
 *     ci arriva davvero. Da dove può venire un suggerimento sbagliato sta scritto
 *     più sotto, accanto al seme;
 *   · `components/features/parent/BottomNav.tsx`: legge il solo `schoolType` e
 *     `ready` lo ignora, quindi guadagna le voci giuste al primo fotogramma;
 *   · `parent/layout.tsx`: lo cita in un commento, non lo consuma.
 *
 * ⚠️ E PUÒ TORNARE FALSO, cosa che prima non faceva: quando `studentId` CAMBIA
 * (la rivalidazione che scarta un id stantio, il selettore dei fratelli) il
 * grado del bambino precedente smette di valere, e finché non c'è quello del
 * nuovo il dato non è disponibile — che è esattamente ciò che `ready` dice.
 * L'alternativa sarebbe tenere a schermo il grado di un altro bambino, cioè la
 * griglia sbagliata su una riga che si tocca.
 */
export function useChildSchoolType(): { schoolType: SchoolType | null; ready: boolean } {
  const { parentId, studentId, figliIds, inAttesa, ready: idReady } = useParentIdentity();
  /** La risposta della rete, con il figlio a cui appartiene. `null` = non è ancora arrivata. */
  const [esito, setEsito] = useState<EsitoGrado | null>(null);

  // ── IL SEME: il grado dell'ULTIMA apertura, prima di qualunque rete ────────
  //
  // Si legge dal dispositivo e non dall'identità: al primo render `studentId` è
  // `null` ogni volta che si arriva su `/parent` senza `?id=` (la tab Home
  // della bottom-nav, ogni avvio a freddo), e aspettarlo vorrebbe dire
  // aspettare `/api/parent/students` — cioè restituire il grado alla velocità
  // della rete, che è esattamente il difetto che questa memoria toglie. Il
  // figlio, lì, il dispositivo lo sa già: è `kv_student_id`, la stessa chiave
  // che l'identità rilegge e rivalida un istante dopo.
  //
  // ⚠️ `useSyncExternalStore` E NON UN `useEffect` CHE SEMINA UNO STATO, per due
  // ragioni che puntano nella stessa direzione. La prima è meccanica: un
  // `setState` sincrono nel corpo di un effetto è un errore di lint in questo
  // repo (`react-hooks/set-state-in-effect`), ed è la regola ad avere ragione —
  // il grado in memoria non è uno stato di React, è uno store esterno da
  // leggere. La seconda è che così il seme è DERIVATO dal figlio corrente a
  // ogni render: quando `studentId` cambia — la rivalidazione che scarta un id
  // stantio, vedi `decidiFiglioRivalidato` — il suggerimento del bambino
  // precedente sparisce da sé, senza nessun ramo che se lo ricordi. Un fratello
  // non può ereditare la griglia dell'altro per costruzione, non per disciplina.
  //
  // ⚠️ IL PARAGRAFO QUI SOPRA DICE SOLO CHE IL SEME SPARISCE *POI*: nei
  // fotogrammi PRIMA può essere del bambino sbagliato, e va detto invece che
  // lasciato scoprire. La finestra si apre quando `studentId` è `null` al primo
  // render E `kv_student_id` è STANTIO — l'anomalia che `decidiFiglioRivalidato`
  // esiste per riparare (cache di un altro account, link altrui, alunno
  // ricreato): lì il figlio che il dispositivo «sa già» non è quello vero, e
  // finché la rivalidazione non risponde il grado a schermo è di un altro
  // bambino. Quanto dura lo misura il test «il figlio cambia dopo la
  // rivalidazione» (`__tests__/lib/grado-figlio-memorizzato.test.tsx`): un solo
  // `rerender`, cioè la risposta di `/api/parent/students`.
  //
  // In quella finestra l'assestamento della home va nel verso CATTIVO (4 → 5: un
  // bersaglio che *appare* fra quelli che il dito stava già mirando, proprio ciò
  // che `parent/page.tsx:282-286` dichiara di evitare) e il diario mostra la
  // cortesia «il diario è solo 0-6», che ha dentro un `Link` toccabile. Si tiene
  // lo stesso, ed è una scelta: la finestra dura un giro di rete e non distrugge
  // niente, mentre aspettare `studentId` vorrebbe dire restituire il grado alla
  // velocità della rete — cioè cancellare questa funzionalità.
  //
  // ⚠️ `() => null` COME SNAPSHOT DEL SERVER, ed è la riga che tiene in piedi
  // l'hydration: il layout radice fa `await cookies()`, quindi ogni rotta è
  // resa sul SERVER, e il server il `localStorage` di quel telefono non può
  // leggerlo. React usa lo snapshot del server per il render di hydration e
  // rilegge quello vero subito dopo — cioè fa in modo pulito ciò che un
  // `useState` inizializzato dal `localStorage` farebbe sbagliando (className
  // diversi fra server e client). È lo stesso motivo per cui
  // `useParentIdentity` inizializza `studentId` dal solo URL.
  //
  // ⚠️ CIÒ CHE RESTA, scritto invece che lasciato credere: il primo render —
  // quello del server — mostra comunque la riga alla larghezza massima. Con la
  // memoria calda il 0-6 la stringe a quattro colonne all'HYDRATION, senza aver
  // chiesto niente a nessuno; senza memoria la stringeva alla risposta di
  // `/api/parent/primaria`, cioè dopo DUE giri di rete e con il dito già sullo
  // schermo. L'assestamento non sparisce: smette di aspettare la rete. Per
  // farlo sparire davvero il grado dovrebbe arrivare al SERVER (un cookie), o
  // la riga non dovrebbe rendersi prima di saperlo: due cose che non stanno in
  // questo file.
  const seme = useSyncExternalStore(
    nessunaSottoscrizione,
    () => {
      const figlio = studentId ?? figlioNotoSulDispositivo();
      return figlio === null ? null : leggiGradoMemorizzato(figlio);
    },
    () => null,
  );

  // ── LA PULIZIA (vedi `dimenticaGradiEstranei` per la disciplina) ───────────
  //
  // `figliIds.length === 0` non è «nessun figlio»: `figli ?? []`
  // (`use-parent-identity.ts:320`) fa collassare «elenco vuoto e DETERMINATO»
  // e «elenco non determinabile» (rete giù) nello stesso `[]`, e i due casi non
  // meritano la stessa risposta. `inAttesa` è il segno che li separa senza
  // chiedere all'identità una firma nuova: vale `lettura !== null &&
  // lettura.inAttesa` (`use-parent-identity.ts:325`), quindi `inAttesa === true`
  // implica una lettura RIUSCITA con l'elenco dei visibili vuoto — dei legami di
  // famiglia esistono e il filtro li ha tolti tutti (archiviato, ritirato, senza
  // sezione). Lì il vuoto è MISURATO, non subìto, e la voce va via come al
  // logout.
  //
  // Non è un caso di carta: in produzione (misura del 2026-09-06) sono 4 account
  // senza figli visibili, di cui UNO con l'unico figlio archiviato. Nello stesso
  // evento `decidiFiglioRivalidato(known, [])` cancella già `kv_student_id`:
  // senza questa riga l'identità butterebbe l'uuid del minore e la cache del
  // grado se lo terrebbe: diventerebbe l'ultima traccia rimasta di quel bambino
  // su quel telefono, a tempo indefinito. Lo stesso vale per il cambio account su
  // un dispositivo condiviso, quando il nuovo genitore non ha figli visibili.
  //
  // ⚠️ CIÒ CHE RESTA SCOPERTO, scritto invece che lasciato credere: il segno è a
  // SENSO UNICO. `inAttesa` vero implica elenco vuoto e determinato, ma non tutti
  // i vuoti determinati lo alzano — con `inAttesa` falso ed elenco vuoto qui non
  // si cancella niente, e sotto quel silenzio stanno due casi diversi: la rete giù
  // (giusto così: una cache buona non si butta per un blip) e il genitore senza
  // NESSUN legame di famiglia, dove la voce resta finché non si esce. Lì la rete
  // di sicurezza è solo `dimenticaTuttiIGradi()` del logout — una sola, e per
  // questo va tenuta sotto lock (`__tests__/lib/logout.test.ts`).
  useEffect(() => {
    if (figliIds.length === 0) {
      if (inAttesa) dimenticaTuttiIGradi();
      return;
    }
    dimenticaGradiEstranei(figliIds);
  }, [figliIds, inAttesa]);

  useEffect(() => {
    if (!idReady || !parentId || !studentId) return;
    let cancelled = false;
    fetch(`/api/parent/primaria?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { data?: { schoolType?: unknown } } | null) => {
        if (cancelled) return;
        // `d === null` è la risposta NON-OK (un 500, un 404): non è «questo
        // bambino non ha un grado», è il server che non ha risposto. `ready`
        // si sblocca come si è sempre fatto, ma la voce in cache NON si tocca e
        // il seme NON si cancella: buttare un suggerimento buono per un blip di
        // rete è la cosa che `decidiFiglioRivalidato` si dà la pena di non fare.
        if (d === null) {
          setEsito({ figlio: studentId, grado: null, determinato: false });
          return;
        }
        // Una parola che non è uno dei tre gradi vale `null` — cioè il ramo 0-6,
        // che è già ciò che faceva prima ogni consumatore (`=== 'primaria'`).
        // Qui in più non finisce in cache: una voce che nessun ramo dell'app
        // sa leggere resterebbe sul dispositivo a suggerire niente.
        const dichiarato: unknown = d.data?.schoolType;
        const grado = eGradoNoto(dichiarato) ? dichiarato : null;
        setEsito({ figlio: studentId, grado, determinato: true });
        // LA RETE VINCE E RISCRIVE — `null` compreso: se il server dice che
        // quel bambino non ha un grado, un suggerimento che dice il contrario
        // va tolto, altrimenti sopravvive alla propria smentita. Dopo il
        // `setState` e mai prima, per la stessa ragione d'ordine scritta qui
        // sotto: la persistenza è un'ottimizzazione, la home è il prodotto.
        memorizzaGrado(studentId, grado);
      })
      // AGENTS.md regola 6: un `catch` che non logga è un bug. Qui l'errore è
      // tollerabile per il PRODOTTO — `ready` passa comunque a `true`, il menu
      // genitore mostra il ramo 0-6 e la home non resta appesa — ma non per chi
      // diagnostica: senza questa riga «al genitore di primaria mancano le voci
      // di scuola» e «/api/parent/primaria non risponde» sono lo stesso identico
      // sintomo, ed è la coppia di silenzi che questo repo paga più cara.
      //
      // ⚠️ L'ORDINE È IL FAIL-OPEN: `setReady(true)` PRIMA del log. `logClient`
      // non lancia mai per costruzione, ma se un giorno lo facesse un guasto
      // dell'osservabilità congelerebbe il menu di ogni genitore — esattamente
      // ciò che la regola 9 vieta.
      //
      // `warn` e non `info` benché la regola dica `info`: il canale del client
      // non ha `info` (`EventoClient.livello` è `'warn' | 'error'`, e `/api/logs`
      // rifiuta il resto). È il livello più basso che esista qui, ed è lo stesso
      // che usano `use-profili.ts` e `use-parent-identity.ts`.
      //
      // Solo `nomeErrore`: il `message` di una fetch fallita si porta dietro
      // l'URL, e in quell'URL ci sono gli uuid di un minore e di suo padre.
      // Niente `stato`: non ce n'è uno (la risposta non è arrivata), e un
      // `stato` fuori posto farebbe scartare l'evento da `livelloEvento`.
      //
      // Nessuna `route` cablata: questo hook lo chiamano la home, il diario, la
      // bottom-nav e il layout genitore. Scriverne una sola sarebbe il nome del
      // luogo sbagliato; `logClient` ripiega su `pagina()`, che è quello vero.
      //
      // ⚠️ E NON SI TOCCA LA CACHE: rete giù con una voce buona è il caso in cui
      // il suggerimento vale di più, non di meno.
      .catch((err: unknown) => {
        if (cancelled) return;
        setEsito({ figlio: studentId, grado: null, determinato: false });
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `grado-figlio-non-letto — errore=${nomeErrore(err)}`,
        });
      });
    return () => { cancelled = true; };
  }, [idReady, studentId, parentId]);

  // ── LE DUE USCITE, DERIVATE E NON MEMORIZZATE ─────────────────────────────
  //
  // Un esito appartiene a UN figlio: quando `studentId` cambia — la
  // rivalidazione che scarta un id stantio, il selettore dei fratelli — la
  // risposta del bambino precedente smette di valere nello stesso render, senza
  // nessun effetto che la ripulisca. È la stessa proprietà del seme, e per la
  // stessa ragione: qui non si conserva niente che non sia legato al figlio a
  // cui appartiene.
  const risposta = esito !== null && esito.figlio === studentId ? esito : null;

  // La rete vince SOLO se ha detto qualcosa (`determinato`). Un 500 o una rete
  // giù sbloccano l'attesa ma non smentiscono niente: lì il seme resta, ed è il
  // caso in cui vale di più, non di meno.
  const schoolType = risposta !== null && risposta.determinato ? risposta.grado : seme;

  // `ready` = «il grado è disponibile», da qualunque delle due fonti — oppure
  // «non lo sarà»: una risposta arrivata e non utilizzabile chiude comunque
  // l'attesa, come ha sempre fatto. Resta falso per sempre per un account senza
  // figli visibili, ed è il caso descritto in testa a questa funzione.
  const ready = risposta !== null || seme !== null;

  return { schoolType, ready };
}
