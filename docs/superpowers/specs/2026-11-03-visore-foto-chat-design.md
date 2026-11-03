# Foto della chat a tutto schermo, con Scarica e Condividi — design

> Parte 1 del documento di pianificazione del 03/11/2026. Il piano di implementazione sta in `docs/superpowers/plans/2026-11-03-visore-foto-chat.md`.

## Intento e perché

In chat le foto inviate non si possono né guardare per intero né salvare. Oggi toccare
una foto non fa niente (`src/components/features/chat/ChatMessageArea.tsx:216-221`: un
`<img>` nudo, ritagliato a `max-h-48 object-cover`, quindi la foto intera non si vede
mai). Il titolare vuole che una foto della chat si apra a tutto schermo e, da lì, si
possa **scaricare e condividere come nella sezione Foto**.

Con l'occasione, decisioni prese col titolare il 03/11/2026:

1. **«Condividi» manda la FOTO VERA (il file), in chat e anche in Foto.** Oggi in Foto
   «Condividi» passa un link firmato che scade dopo 10 minuti
   (`MediaGrid.tsx:433-451` → `condividiLink`; TTL 600 s in
   `src/lib/gallery/storage.ts:36`): chi lo riceve su WhatsApp e lo apre dopo trova un
   errore. Il link a tempo sparisce da tutti e due i posti.
2. **Frecce fra le foto della stessa conversazione**, come fa oggi il visore di Foto
   (pulsanti ‹ › e tasti freccia). Niente scorrimento col dito.
3. **Approccio A — un visore unico**: il visore oggi incollato dentro `MediaGrid` diventa
   un componente a sé, usato da Foto e dalla chat. Scelto perché il titolare vuole che
   le due si comportino uguale, e due visori divergono (è il difetto che
   `src/lib/native/share.ts:111-114` dice di aver tolto: «i pulsanti della galleria
   erano scritti due volte»).

## Obiettivi

- Tocco su una foto della chat → visore a tutto schermo, foto intera (`object-contain`).
- Nel visore: frecce fra le foto della conversazione, «Scarica», «Condividi», chiusura
  con ✕, `Escape`, tocco fuori e **tasto Indietro di Android**.
- Vale per **genitore** (`parent/chat`), **docente** (`teacher/chat`) e **segreteria**
  (`admin/messaggi`, schede «Con i genitori» e «Tutti»). La segreteria oggi non vede
  nemmeno la foto: mostra solo «📎 Allegato» (`admin/messaggi/page.tsx:27`, tipo `Msg`
  senza campi allegato), anche se `/api/admin/chat/messages` la firma e la manda
  (`route.ts:76,120`). Inclusa su proposta dell'assistente.
- «Condividi» = file vero, in chat e in Foto (card e visore), per foto e video.
- Il visore di Foto continua a fare tutto quello che fa oggi (elimina con conferma, tag
  degli alunni, «Segnala», guardie su eliminazione in volo), e in più chiude col tasto
  Indietro di Android, che oggi esce dalla pagina.
- Log di ogni gesto nuovo (regole di AGENTS.md), PRD aggiornato, test.

## Non obiettivi

- Zoom e pinch nel visore; scorrimento col dito fra le foto.
- Video in chat (la chat non li accetta: `api/chat/upload/route.ts:30-38`).
- Anteprima della foto nel campo di scrittura della chat (oggi è un chip col nome).
- Il tasto Indietro che chiude la **conversazione** aperta su mobile
  (`da_fare_chat_dopo_pr147` punto 1): resta un difetto a parte. Qui Indietro chiude
  solo il visore.
- Cambiare chi ha quale pulsante in Foto oltre a quanto scritto sotto.

## Anti-obiettivi (fallimento anche se «funziona»)

- Un «Condividi» che, in qualche ramo, manda ancora il link che scade.
- Un pulsante che fa qualcosa di diverso da quello che dice (es. «Condividi» che
  scarica in silenzio).
- Il visore di Foto che perde un comportamento esistente: lo dicono i test che ci sono
  già, che devono restare verdi **senza essere indeboliti** (memoria
  `abbassare_soglia_lock_e_decorazione`).
- La foto che sfarfalla o si ricarica mentre la si guarda (la chat rifirma gli URL a
  ogni polling di 30 s: `useChatRealtime.ts:187`, `stato-conversazione.ts:165`).
- URL, nomi di file, didascalie o testo d'errore finiti nei log.

## Vincoli (dal codice, non negoziabili)

- **Scarica** si fa SOLO con `scaricaMedia` di `src/lib/native/scarica.ts:932` (web: blob
  + `<a download>`; app 1.1: Galleria/Rullino; app 1.0: foglio con file). Non lancia,
  logga da sé l'esito con l'etichetta passata (`etichettaSicura` accetta `chat`).
- **`@capacitor/share` si importa in un posto solo**: `src/lib/native/share.ts`. La
  condivisione di un file locale passa da `condividiFileLocale` (`share.ts:121`).
- I plugin nativi si chiamano con `registerPlugin` e solo dopo
  `Capacitor.isPluginAvailable` (come in `scarica.ts:106-157`); lock
  `plugin-capacitor-registrati` e `plugin-capacitor-mai-risolto-da-promise`.
- **Livello `z-[115]`** del visore (sopra la bottom-nav, lock
  `__tests__/architecture/visore-media-sopra-la-bottom-nav.test.ts`). In chat mobile la
  conversazione è un `fixed inset-0 z-[60]` (`parent/chat/page.tsx:402`,
  `teacher/chat/page.tsx:348`), che crea un contesto di impilamento: un visore reso lì
  dentro resta chiuso a 60. Il visore deve stare sopra tutto anche da lì.
- **Accessibilità** come oggi in Foto: `role="dialog"`, `aria-modal`, nome del dialogo,
  fuoco sul contenitore, sfondo `inert` con `rendiInerteFuoriDaConFocus`
  (`src/lib/accessibility/inerti.ts:132`), velo sfocato su un fratello `aria-hidden`.
  Il tasto Indietro di Android con `useOverlayIndietro`
  (`src/lib/mobile/overlay-indietro.ts:113`, come `Modal.tsx:106`).
- **Log lato client** con `logClient` di `@/lib/logging/client` (`/api/logs` accetta solo
  `warn|error`: il successo è `warn`, come `registraEsito` in `scarica.ts:695`). Mai URL,
  nome file, didascalia o testo d'errore.
- Bucket chat `chat-allegati` privato, URL firmati a 10 minuti; un messaggio arrivato in
  realtime ha il percorso grezzo finché il polling non porta il link firmato
  (`allegatoMostrabile`, `stato-conversazione.ts:62-64`): quelle foto non entrano nel
  visore finché non sono mostrabili.
- Lock `media-con-rapporto-daspetto.test.ts:95-98` cita l'`<img>` della chat: se le
  classi cambiano, il lock va aggiornato, non allentato.
- Una sola migrazione (il `CHECK` del registro di vigilanza) e una sola route nuova (lo
  scarico registrato dalla supervisione); il resto è lato client. La migrazione non si
  applica a mano: la applica l'integrazione al merge (memoria
  `migrazione_in_pr_applicata_dall_integrazione`); il freno SQL nega `apply_migration`.

## Come si comporta

### Il visore unico

Un componente condiviso (nome e cartella al costruttore; proposta:
`src/components/features/media/VisoreMedia.tsx`) che contiene quello che oggi in
`MediaGrid` è generico:

- contenitore dialog, velo, scroller con «tocco fuori = chiudi», ✕ con safe-area,
  frecce ‹ › e tasti ArrowLeft/ArrowRight/Escape, fuoco e inerzia, Indietro di Android;
- il media: `<img>` o `<video controls playsInline preload="metadata">` con
  `max-h-[70svh] object-contain`, e il riquadro «anteprima non disponibile» se l'URL
  manca;
- la riga dei comandi «Scarica» / «Condividi», ciascuno acceso o spento da chi lo usa;
- **spazi per gli extra di chi lo usa**: la didascalia, il riquadro dei tag, «Segnala»,
  «Elimina» e il dialogo di conferma (che deve restare figlio del visore e fratello
  dello scroller, per le ragioni scritte in `MediaGrid.tsx:1081-1100`);
- una **guardia di chiusura** fornita da chi lo usa (in Foto: niente chiusura mentre
  un'eliminazione è in volo, con il log `gallery-chiusura-visore-rinviata`), e il blocco
  delle frecce mentre un dialogo figlio è aperto.

`MediaGrid` lo usa al posto del suo blocco `lightbox`, passando i suoi extra.
La chat lo usa con le sole foto.

### Le azioni Scarica e Condividi, in un posto solo

Oggi la guardia «uno scarico alla volta» e gli `alert` d'esito stanno dentro `MediaGrid`
(`:354-420`) e servono sia la card sia il visore. Diventano un pezzo riusabile (proposta:
un hook `useAzioniMedia`) che usano le card di Foto, il visore di Foto e il visore della
chat. Stessi testi di oggi (`messages/it/shared.json:74-81, :131`) più quelli nuovi.

### Condividi = il file

Una funzione nuova accanto a `scaricaMedia` (stesso modulo, perché riusa `fileInCache` e
la scelta dei plugin), che consegna il FILE al foglio di condivisione:

- **App 1.1** (Filesystem + FileTransfer presenti): file in cache con `fileInCache` →
  `condividiFileLocale` → pulizia della cache.
- **App 1.0** (plugin nuovi assenti): avviso «aggiorna l'app», mai il link (vedi sotto).
- **Web con condivisione di file** (`navigator.canShare({ files })` vero: Safari,
  Chrome Android): `fetch` → `File` → `navigator.share({ files, title })`.
- **Web senza condivisione di file**: il pulsante «Condividi» **non compare**; resta
  «Scarica». (Scelta dell'assistente: un pulsante che manda un link da 10 minuti è il
  difetto che si toglie; uno che scarica dicendo «Condividi» mentirebbe.)
- **Gesto utente perso sul web** (Safari rifiuta `navigator.share` con `NotAllowedError`
  se fra il tocco e la chiamata c'è stato un `fetch` lungo): il file già scaricato resta
  pronto e l'utente viene avvisato di toccare di nuovo «Condividi», che allora parte
  subito. (Scelta dell'assistente; niente pre-scaricamento all'apertura del visore.)
- Annullare il foglio non è un errore (`annullatoDallUtente`).
- Mentre il file si prepara il pulsante lo mostra (disabilitato + testo/indicatore), e
  vale la stessa guardia «un'azione alla volta» di Scarica.
- **Log**: una riga per gesto, stesso schema di `registraEsito` con una nuova operazione
  `condivisione` (`<etichetta>-condivisione-riuscita:<esito>`, `-annullata`,
  `-non-riuscita: <motivo>`), etichetta `gallery` in Foto e `chat` in chat.

### In chat

- La miniatura resta com'è nella bolla (stesse classi), ma diventa un comando: pulsante
  con nome accessibile («Apri la foto a tutto schermo»), Invio/Spazio da tastiera.
- Il visore riceve **le foto mostrabili della conversazione caricata**, in ordine
  cronologico, e si apre su quella toccata; l'identità di una foto è l'id del messaggio.
- **URL che cambia a ogni polling**: l'immagine a schermo non si ricarica finché il
  visore resta su quella foto; Scarica e Condividi usano l'URL **più recente** (quello
  vecchio può essere scaduto dopo 10 minuti di visore aperto).
- Se la conversazione cambia o il messaggio sparisce mentre il visore è aperto, il
  visore si chiude.
- Nome del file scaricato: `nomeFileScarico(null, url, 'foto')` ricava il nome dal
  percorso; titolo della condivisione «Foto da Kidville» (`galleryFotoDaKidville`).
- Nome del dialogo: un testo neutro («Foto della conversazione», con «n di N» se serve),
  mai il nome del mittente.
- In chat: nessuna didascalia, nessun «Segnala», nessun «Elimina».
- **Segreteria**: il tipo `Msg` di `admin/messaggi/page.tsx` prende `attachment_url` e
  `attachment_type`; nelle due schede la foto compare come miniatura nella bolla e apre
  lo stesso visore; i documenti compaiono come chip «📎 Documento allegato» apribile
  come in `ChatMessageArea` (così la segreteria non vede più «📎 Allegato» e basta).
  Miniatura e chip si estraggono da `ChatMessageArea` in un pezzo condiviso, invece di
  ricopiarli.

### Chi ha quali pulsanti (deciso dal titolare il 03/11: «come in Foto»)

| Superficie | Scarica | Condividi |
|---|---|---|
| Foto — genitore | sì | sì (file) |
| Foto — staff (`scaricabile`) | sì | no |
| Chat genitore (`parent/chat`) | sì | sì (file) |
| Chat docente (`teacher/chat`) | sì | no |
| Segreteria, scheda «Con i genitori» | sì | no |
| Segreteria/Direzione, scheda «Tutti» (supervisione) | sì, **registrato** | no |

### Lo scarico dalla supervisione resta nel registro di vigilanza

Deciso dal titolare il 03/11. La scheda «Tutti» è la supervisione silenziosa: i due
interlocutori non vedono niente, e il registro `chat_vigilanza_accessi` è «l'UNICO
contrappeso» (`src/lib/chat/vigilanza-audit.ts`). Oggi ammette solo `lettura` e `ricerca`
(`CHECK` in `supabase/migrations/20260909111537_chat_vigilanza_accessi.sql`).

- **Migrazione**: il `CHECK` di `azione` ammette anche `'scarico'`. Nient'altro: nessuna
  colonna nuova (il thread, l'operatore, la sede e l'ora bastano; scelta dell'assistente).
  La applica l'integrazione al merge, non a mano.
- **Route nuova** `POST` (proposta `src/app/api/admin/chat/messages/scarico/route.ts`),
  con lo stesso schema di `admin/chat/messages:GET`: `withRoute` → `requireStaff` → `zod`
  (`message_id`) → messaggio e thread → `assertAlunnoInScope` (fuori sede: riga
  `fuori-scope` e rifiuto) → sede dell'alunno → **riga `scarico` bloccante** (se non si
  scrive: 503 `VIGILANZA_NON_TRACCIABILE`, lo scarico non parte) → firma dell'allegato →
  risponde con l'URL fresco.
- **Il client** nella scheda «Tutti» chiama prima la route e scarica con l'URL che
  riceve; se la route rifiuta, l'utente vede un messaggio («lo scarico non si è potuto
  registrare, quindi non è partito») e il file non arriva. Bonus: la pagina non ha
  polling, quindi l'URL fresco chiude anche il problema della firma scaduta in quella
  scheda.
- Solo **foto** (`attachment_type = 'image'`); un documento dalla supervisione resta
  com'è oggi (non è in perimetro).
- Il registro letto dalla Direzione (`RegistroVigilanza`, `/api/admin/chat/vigilanza`)
  deve mostrare e filtrare anche la nuova azione.

### Condividi sull'app 1.0

Deciso dal titolare il 03/11: il binario 1.0 non ha Filesystem né i plugin nuovi
(`scarica.ts:569-574`), quindi non può consegnare un file. Lì il pulsante **c'è** e al
tocco avvisa di aggiornare l'app (come già fanno i documenti con
`documentoAppDaAggiornare`); non si ripiega MAI sul link. Il log porta
`plugin-assenti:<nomi>`.

### Scelte minori fatte dall'assistente (da controllare leggendo)

1. Web senza condivisione di file → «Condividi» nascosto, resta «Scarica».
2. Gesto perso su Safari web (`NotAllowedError` dopo il `fetch`) → file tenuto pronto,
   avviso «tocca di nuovo Condividi»; niente pre-scaricamento all'apertura del visore.
3. Segreteria inclusa anche nella scheda «Con i genitori», con i documenti apribili come
   chip (oggi vede solo «📎 Allegato»).
4. Nella scheda «Con i genitori» (nessun polling) una firma scaduta dopo 10 minuti dà il
   normale «scaricamento non riuscito»; si riapre la conversazione. Nessuna route nuova
   per quel caso.
5. Registro di vigilanza: nessuna colonna `messaggio_id`; basta il thread.
6. Nome del dialogo neutro, mai il nome del mittente; titolo della condivisione «Foto da
   Kidville».

## Approcci considerati

| | Cosa | Pro | Contro |
|---|---|---|---|
| **A — scelto** | Visore estratto da `MediaGrid`, unico per Foto e chat | Un comportamento solo; Indietro di Android sistemato anche in Foto | Si tocca `MediaGrid`, lavoro più lungo; i test esistenti fanno da rete |
| B | Visore nuovo solo per la chat, stesse funzioni di Scarica/Condividi | Foto quasi intatta, più rapido | Due visori che divergono |
| C (scartato) | Visore di sistema (anteprima del telefono, scheda nuova sul web) | Pochissimo codice, zoom gratis nell'app | Sul web niente pulsanti né frecce; non è «come Foto» |

## Lasciato al costruttore

- Nome, cartella e firma esatta del visore e dell'hook.
- Come garantire `z-[115]` da dentro la conversazione a `z-[60]` (portale su
  `document.body` o altro), purché il lock sul livello resti vero e i test di
  `MediaGrid` restino verdi.
- Testi esatti dei messaggi nuovi (in italiano, in `messages/it/shared.json` e nelle
  altre lingue presenti).
- Come aggiornare i lock che citano percorsi o righe spostate, senza allentarli.

## Verifica (definizione di «fatto»)

- Gate di AGENTS.md: `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`,
  `npm run build`; E2E in CI (`npm run e2e` è in `deny` in locale).
- Test nuovi: visore (apertura, frecce, Escape, ✕, tocco fuori, Indietro di Android,
  fuoco e inerzia, guardia di chiusura); condivisione del file (app 1.1, app 1.0, web con
  e senza `canShare`, `NotAllowedError` → secondo tocco, annullamento, log); chat (tocco
  sulla miniatura apre il visore, frecce fra le foto della conversazione, URL rifirmato
  che non ricarica l'immagine ma aggiorna le azioni); segreteria (foto e documento
  visibili nelle due schede).
- Test di `MediaGrid` esistenti verdi; quelli su «Condividi» aggiornati al file.
- E2E `e2e/chat.spec.ts`: dopo l'invio della foto, il tocco apre il dialogo e mostra
  «Scarica».
- PRD `PRD REGISTRO ELETTRONICO.md`: voce di changelog datata.
