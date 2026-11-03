# Foto della chat a tutto schermo, con Scarica e Condividi — piano di implementazione

## Come si esegue (deciso dal titolare)

- **Pianificazione**: Opus, in questa sessione (fatta).
- **Esecuzione**: solo **Sonnet 5.5 a effort «extra»**, cioè l'alias `sonnet` di Claude
  Code con `effort: "xhigh"`. La sessione principale lancia **un solo orchestratore**
  (`Agent`, `model: "sonnet"`, `effort: "xhigh"`), che esegue tutta la Parte 2 con
  `superpowers:subagent-driven-development`. Anche ogni esecutore e ogni revisore che
  l'orchestratore lancia usa `model: "sonnet"` ed `effort: "xhigh"`. Il messaggio finale
  dell'orchestratore riporta alla lettera la lista «Decisioni che ho preso».
- **Alla fine, la sessione principale** (Opus): legge il rapporto, ricontrolla di
  persona l'uscita dei gate, fa `git push`, apre la PR e la lega con `ccd_pr`. **Il merge
  lo fa il titolare.** La migrazione la applica l'integrazione al merge.

# Parte 2 — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** le foto della chat si aprono a tutto schermo in un visore unico, lo stesso della
sezione Foto, con Scarica e Condividi. Condividi manda il file vero ovunque. Lo scarico dalla
supervisione resta scritto nel registro di vigilanza.

**Architecture:**
1. Il visore di `MediaGrid` si estrae in `VisoreMedia`: un portale su `document.body` con
   dialog, frecce, tasti, fuoco, inerzia e tasto Indietro.
2. Scarica e Condividi passano da un hook `useAzioniMedia` sopra `scaricaMedia` e sopra una
   nuova `condividiMedia`, che consegna il file.
3. La chat ha una miniatura-pulsante e un `VisoreFotoChat` che adatta i messaggi al visore.
4. La supervisione scarica attraverso una route che prima scrive la riga `scarico` e poi firma.

**Tech Stack:** Next.js (App Router, versione del repo: leggere `node_modules/next/dist/docs/`
prima di toccare codice Next), React, next-intl, Capacitor 8, Supabase (PostgREST +
Storage), Vitest + Testing Library, Playwright (solo CI).

**Spec:** Parte 1 di questo file → `docs/superpowers/specs/2026-11-03-visore-foto-chat-design.md`.

## Global Constraints

- Lingua di codice, commenti, messaggi di commit e testi UI: **italiano**, nello stile dei
  file vicini (commenti che spiegano il *perché*, con la data quando misurano qualcosa).
- Mai `console.*` in `src/`. Lato client `logClient` da `@/lib/logging/client` (`livello`
  `warn` anche per il successo, `error` solo quando l'utente non ha ottenuto niente);
  lato server `logErrore`/`logEvento` da `@/lib/logging/logger`.
- Nei log mai URL, nome file, didascalia, testo del messaggio, testo d'errore: solo
  esito, operazione, piattaforma, uuid.
- Il visore sta a **`z-[115]`**; il lock
  `__tests__/architecture/visore-media-sopra-la-bottom-nav.test.ts` resta vero e si
  aggiorna solo nel percorso del file che legge.
- `@capacitor/share` si importa solo in `src/lib/native/share.ts`. I plugin nativi si
  chiamano solo dopo `Capacitor.isPluginAvailable`.
- I test esistenti non si indeboliscono. Un test che cambia perché il comportamento
  cambia (Condividi passa da link a file) si **riscrive** sul comportamento nuovo, con la
  stessa severità.
- Repo pubblico: niente PII né segreti nei test (nomi finti, uuid finti).
- Testi nuovi in `messages/it/shared.json` **e** `messages/en/shared.json` (le due lingue
  presenti). Le parole esatte sono quelle date nei compiti.
- Branch `feat/visore-foto-chat` da `origin/main`. **Mai** `git checkout -- <file>`, mai
  `npm install` (memoria `git_checkout_cancella_lavoro_non_committato`).
- `npm run e2e` / `npx playwright test` sono in `deny`: l'E2E gira in CI.
- La migrazione **non** si applica a mano: niente `apply_migration`, niente `psql`. Sul DB
  di produzione solo `SELECT`.

## Review Focus

1. **Due `ChatMessageArea` montate insieme** (desktop + mobile, sempre entrambe nel DOM):
   toccare una foto apre un visore solo, e Indietro chiude solo quello. → test nel Compito 4.
2. **Firma scaduta col visore aperto a lungo**: in chat genitore/docente l'URL nuovo del
   polling deve arrivare alle azioni ma non all'`<img>`. → test nel Compito 4.
3. **Doppio tocco rapido** su Condividi o su Scarica: parte un'azione sola. → test nel
   Compito 3.
4. **Messaggio arrivato in realtime col percorso grezzo** (non http): non è nel visore e non
   si può toccare finché non è firmato. → test nel Compito 4.
5. **Supervisione col registro guasto o fuori sede**: niente file, avviso a schermo. → test
   nei Compiti 5 e 6.

---

### Compito 0: Branch e documenti

**Files:**
- Create: `docs/superpowers/specs/2026-11-03-visore-foto-chat-design.md` (Parte 1)
- Create: `docs/superpowers/plans/2026-11-03-visore-foto-chat.md` (Parte 2 + «Come si esegue»)

- [ ] **Step 1:** `git -C /Users/lerri/kidville-web fetch origin && git -C /Users/lerri/kidville-web switch -c feat/visore-foto-chat origin/main`.
  Il `main` locale è indietro (`aac1b885` contro `2f081343`): si parte da `origin/main`.
  `.archify/` (non tracciato) non si tocca.
- [ ] **Step 2:** copia le due parti di `/Users/lerri/.claude/plans/glittery-popping-cray.md` nei
  due file sopra.
- [ ] **Step 3:** `git add docs/superpowers && git commit -m "Visore foto della chat: design e piano"`.

---

### Compito 1: `condividiMedia`, la condivisione del FILE

**Files:**
- Modify: `src/lib/native/share.ts` (aggiunge `condividiFileWeb`)
- Modify: `src/lib/native/scarica.ts` (aggiunge `condividiMedia`, `puoCondividereFileMedia` e il log della condivisione)
- Test: `__tests__/lib/condividi-media.test.ts` (i mock di Capacitor, `FileTransfer` e
  `logClient` si copiano da `__tests__/lib/scarica-helper-nativo.test.ts`)

**Interfaces — Produces:**
```ts
// share.ts — l'unico posto con navigator.share, come già per @capacitor/share
export type EsitoFileWeb = 'foglio' | 'annullato' | 'gesto-scaduto' | 'non-riuscita'
export async function condividiFileWeb(file: File, titolo?: string, signal?: AbortSignal): Promise<EsitoFileWeb>

// scarica.ts
export type EsitoCondivisioneMedia =
  | 'nativo-foglio' | 'web-foglio' | 'web-gesto-scaduto'
  | 'app-da-aggiornare' | 'non-supportato' | 'non-riuscita'
export interface RisultatoCondivisioneMedia { esito: EsitoCondivisioneMedia; motivo?: string; annullata?: boolean }
export interface CondividiMediaInput extends ScaricaMediaInput {
  /** Identità STABILE del media (id del messaggio o del media): l'URL cambia a ogni rifirma. */
  chiave: string
}
export function puoCondividereFileMedia(): boolean
export async function condividiMedia(input: CondividiMediaInput): Promise<RisultatoCondivisioneMedia>
```

Le regole, una per ramo (sono anche i test):
- `puoCondividereFileMedia()`: `true` nell'app (anche 1.0: il pulsante c'è e avvisa); sul
  web `navigator.canShare?.({ files: [new File([''], 'kidville-foto.jpg', { type: 'image/jpeg' })] }) === true`,
  con `try/catch` → `false`.
- **App 1.1** (Filesystem, FileTransfer, Share disponibili): `fileInCache(url, nomeFile, signal)`
  → `condividiFileLocale(uri, titolo, signal)` → `nativo-foglio`. La copia in Cache **non**
  si cancella dopo il foglio: su Android la promessa si risolve prima che l'app di destinazione
  legga il file (è lo stesso motivo per cui `foglioConFile` non pulisce).
- **App 1.0** (manca uno dei tre plugin): `app-da-aggiornare`, `motivo: plugin-assenti:<nomi>`
  (`motivoPluginAssenti`). Nessun `fetch`, nessun link.
- **Web**: se `!puoCondividereFileMedia()` → `non-supportato`, senza `fetch`. Se c'è un file
  pronto per la stessa `chiave` (unico posto, variabile di modulo) → `condividiFileWeb`
  subito, senza `fetch`, e il posto si svuota. Altrimenti `fetch(url)`: `!ok` → `non-riuscita`
  con `motivo: http-<status>`. Poi `File([blob], nomeFile, { type: blob.type || 'image/jpeg' })`
  (`video/mp4` se `tipo === 'video'` e il blob non ha tipo) → `condividiFileWeb`: `foglio` →
  `web-foglio`; `annullato` → `web-foglio` con `annullata: true`; `gesto-scaduto`
  (`NotAllowedError`) → il file va nel posto della `chiave` → `web-gesto-scaduto`.
- Il nome del file passa sempre da `nomeFileScarico(input.nomeFile, input.url, input.tipo)`,
  come `scaricaMediaSenzaLog`.
- **Log**: una riga per chiamata, con la forma di `registraEsito` e
  `campi: { esito, operazione: 'condivisione', piattaforma }`:
  - `<etichetta>-condivisione-riuscita:<esito>` → `warn`
  - `<etichetta>-condivisione-annullata` → `warn`
  - `<etichetta>-condivisione-gesto-scaduto` → `warn`
  - `<etichetta>-condivisione-non-riuscita: <motivo>` → `error`, anche per
    `app-da-aggiornare` e `non-supportato`

  L'etichetta passa da `etichettaSicura(input.etichetta, 'gallery')`.

- [ ] **Step 1: Scrivi i test che falliscono.** Test e asserzioni:
  - `app 1.1: il foglio riceve il FILE in cache, mai il link`: `condividiFileLocale` chiamata
    con l'uri restituito da `getUri`; `condividiLink` **mai** chiamata; `esito === 'nativo-foglio'`;
    log `gallery-condivisione-riuscita:nativo-foglio` a `warn`.
  - `app 1.0: avvisa di aggiornare e non manda il link`: plugin `FileTransfer` assente →
    `esito === 'app-da-aggiornare'`, `motivo` contiene `plugin-assenti:`, `fetch` e
    `condividiLink` mai chiamati, log a `error`.
  - `web con canShare: navigator.share riceve un File con estensione e nessun url`:
    `share.mock.calls[0][0].files[0]` è `instanceof File`, il nome finisce con `.jpg`, e
    nell'oggetto passato non c'è la chiave `url`.
  - `web senza canShare: non-supportato e nessun fetch`.
  - `gesto scaduto: il secondo tocco con la stessa chiave condivide senza rifare il fetch`:
    il primo `share` lancia `DOMException('', 'NotAllowedError')` → `web-gesto-scaduto`; la
    seconda chiamata con la stessa `chiave` e un **URL diverso** → `web-foglio`, e `fetch`
    è stato chiamato una volta sola in tutto.
  - `annullare il foglio non è un errore`: `AbortError` → `esito 'web-foglio'`,
    `annullata: true`, log `gallery-condivisione-annullata` a `warn`.
  - `firma scaduta: non-riuscita con http-403 e il log non contiene l'URL`: il `messaggio`
    e i `campi` del log non contengono la stringa dell'URL.
  - `etichetta chat: i log escono come chat-condivisione-…`.
- [ ] **Step 2:** `npx vitest run __tests__/lib/condividi-media.test.ts` → FAIL (export assenti).
- [ ] **Step 3:** implementa `condividiFileWeb` in `share.ts`. Il gesto perso si riconosce da
  `e?.name === 'NotAllowedError'`, l'annullamento da `annullatoDallUtente`. Poi
  `condividiMedia` e `puoCondividereFileMedia` in `scarica.ts`, riusando `pluginMancanti`,
  `fileInCache`, `motivoPluginAssenti`, `piattaforma` ed `etichettaSicura`.
- [ ] **Step 4:** `npx vitest run __tests__/lib/condividi-media.test.ts __tests__/lib/scarica-helper-nativo.test.ts __tests__/lib/native-share.test.ts __tests__/lib/native-share-import-tardivo.test.ts __tests__/architecture/plugin-capacitor-registrati.test.ts __tests__/architecture/plugin-capacitor-mai-risolto-da-promise.test.ts` → PASS.
- [ ] **Step 5:** commit `"Condividi manda il file: condividiMedia e condividiFileWeb"`.

---

### Compito 2: `VisoreMedia`, il visore estratto da `MediaGrid`

Rifattorizzazione **a comportamento invariato**, con due eccezioni volute: il portale e il
tasto Indietro di Android.

**Files:**
- Create: `src/components/features/media/VisoreMedia.tsx`
- Modify: `src/components/features/gallery/MediaGrid.tsx` (il blocco `{lightbox && (…)}` di
  `:796-…`, l'effetto di fuoco/inerzia `:331-344` e i tasti `:554-577` passano al visore)
- Modify: `__tests__/architecture/visore-media-sopra-la-bottom-nav.test.ts` (solo la costante
  `VISORE` → il file nuovo, e il testo che nomina `MediaGrid` dove parla della radice)
- Test: `__tests__/components/VisoreMedia.test.tsx`

**Interfaces — Produces:**
```tsx
export interface MediaVisore { id: string; url: string | null; tipo: TipoMedia; alt: string }
export interface VisoreMediaProps {
  elementi: MediaVisore[]
  apertoId: string | null            // null = chiuso
  onCambia: (id: string) => void     // frecce e tasti
  onChiudi: () => void               // ✕, Escape, tocco sullo scroller, Indietro: la guardia la fa chi chiama
  etichetta: (m: MediaVisore) => string   // aria-label del dialog
  tastiBloccati?: boolean            // dialogo figlio aperto: frecce, ← → ed Escape non fanno niente
  children?: React.ReactNode         // dentro la colonna, sotto il media (didascalia, tag, comandi, elimina)
  sovrapposti?: React.ReactNode      // fratelli dello scroller (il dialogo di conferma)
}
export function VisoreMedia(props: VisoreMediaProps): React.ReactElement | null
```

- Classi, `data-testid` (`visore-velo`, `visore-scorrimento`, `visore-colonna`), `role`,
  `aria-modal`, `tabIndex={-1}`, safe-area, frecce, ✕ e commenti: si **spostano**, non si
  riscrivono. Il commento `z-[115]` resta sulla radice nel file nuovo. Le frecce e i titoli
  restano `t('mediaPrecedente')` e `t('mediaSuccessiva')`.
- `createPortal(…, document.body)`, montato solo quando `apertoId !== null` e solo se
  `document` esiste. Serve perché la conversazione mobile della chat è un
  `fixed inset-0 z-[60]`, cioè un contesto d'impilamento.
- `useOverlayIndietro(apertoId !== null, onChiudi)`: con il dialogo di conferma aperto, quello
  è più in alto nella pila e si chiude per primo (lo fa già `Modal`).
- L'effetto di fuoco/inerzia dipende da «è aperto», **non** da «quale media» (commento
  `MediaGrid.tsx:327-329`).
- In `MediaGrid` resta: lo stato `lightbox`, `handleCloseLightbox` con la sua guardia, e gli
  extra passati come `children`/`sovrapposti`. `tastiBloccati={daEliminare !== null}`.

- [ ] **Step 1: Scrivi i test che falliscono** in `VisoreMedia.test.tsx`:
  - `Indietro di Android chiude il visore`: aperto → `chiudiOverlayInCima()` (da
    `@/lib/mobile/overlay-indietro`) restituisce `true` e `onChiudi` è chiamata una volta.
  - `il dialog vive in document.body ed è a z-[115]`: `screen.getByRole('dialog')` ha
    `parentElement === document.body` e la classe `z-[115]`.
  - `frecce: niente ‹ sul primo, niente › sull'ultimo; ArrowRight passa al successivo`.
  - `con tastiBloccati né le frecce né Escape fanno niente`.
  - `tocco sullo scroller chiude, tocco nella colonna no`.
  - `il fuoco va al dialog all'apertura e torna a chi l'aveva alla chiusura`.
  - `cambiare foto non sposta il fuoco dalla freccia premuta`.
- [ ] **Step 2:** `npx vitest run __tests__/components/VisoreMedia.test.tsx` → FAIL.
- [ ] **Step 3:** crea `VisoreMedia` e fai usare a `MediaGrid` il componente nuovo.
- [ ] **Step 4:** prima la rete, poi il resto:
  `npx vitest run __tests__/components/VisoreMedia.test.tsx __tests__/components/MediaGrid-impaginazione.test.tsx __tests__/components/DialogoEliminaMedia.test.tsx __tests__/components/MediaGrid-link-scaduto.test.tsx __tests__/components/MediaGrid-segnala.test.tsx __tests__/components/scarica-media-grid.test.tsx __tests__/pages/galleria-scarica-staff.test.tsx __tests__/pages/galleria-sede-pagina.test.tsx __tests__/architecture/visore-media-sopra-la-bottom-nav.test.ts __tests__/architecture/media-con-rapporto-daspetto.test.ts` → PASS.
  Se un test cerca il visore con `container.querySelector…` (per esempio
  `MediaGrid-link-scaduto.test.tsx:35`), il portale lo porta fuori dal `container`: la query
  passa a `document`/`screen` **senza** cambiare l'asserzione. Ogni test toccato va scritto
  nel rapporto, con il perché.
- [ ] **Step 5:** commit `"Visore dei media in un componente unico, con il tasto Indietro di Android"`.

---

### Compito 3: `useAzioniMedia` e Condividi col file in Foto

**Files:**
- Create: `src/components/features/media/useAzioniMedia.ts`
- Create: `src/components/features/media/ComandiMedia.tsx` (la riga Scarica/Condividi del
  visore, con lo stato «in preparazione» di ciascun pulsante)
- Modify: `src/components/features/gallery/MediaGrid.tsx`. Spariscono `scaricaMedia`
  (`:354-420`) e `condividiMedia` (`:433-451`). La card (`:708-750`) e il visore usano l'hook.
  La riga dei comandi del visore usa `ComandiMedia` e tiene `data-testid="visore-comandi"`.
- Modify: `messages/it/shared.json`, `messages/en/shared.json`
- Modify: `__tests__/components/scarica-media-grid.test.tsx`. I due test sulla condivisione
  (`:315` e `:327`) si riscrivono sul file: il mock diventa `condividiMedia` di
  `@/lib/native/scarica`.
- Test: `__tests__/components/useAzioniMedia.test.tsx`

**Interfaces — Consumes:** `scaricaMedia`, `condividiMedia`, `puoCondividereFileMedia`,
`nomeFileScarico`, `TipoMedia` (Compito 1).
**Produces:**
```ts
export interface MediaAzionabile { id: string; url: string; tipo: TipoMedia; nomeFile: string | null; titolo?: string }
export function useAzioniMedia(opts: { etichetta: 'gallery' | 'chat' | 'chat-vigilanza' }): {
  scarica: (m: MediaAzionabile) => Promise<void>
  condividi: (m: MediaAzionabile) => Promise<void>
  puoCondividere: boolean
}
// ComandiMedia.tsx
export function ComandiMedia(props: {
  media: MediaAzionabile
  conScarica: boolean
  conCondividi: boolean
  onScarica?: (m: MediaAzionabile) => Promise<void>   // sostituisce lo scarico dell'hook (supervisione)
  etichetta: 'gallery' | 'chat' | 'chat-vigilanza'
  extra?: React.ReactNode                              // «Segnala» in Foto
}): React.ReactElement | null
```

Come funziona:
- **Una guardia sola** (`useRef`) per scarico **e** condivisione. Una seconda pressione mentre
  la prima lavora si scarta e logga `<etichetta>-azione-gia-in-corso` (`warn`). Il nome di oggi
  `gallery-scarico-gia-in-corso` resta per lo scarico in Foto, perché `app_log` lo conta già.
- Gli `alert` dello scarico si **spostano** da `MediaGrid.tsx:354-420` così come sono.
- Gli `alert` della condivisione:

  | Esito | Testo |
  |---|---|
  | `web-gesto-scaduto` | `mediaCondividiToccaDiNuovo` |
  | `app-da-aggiornare` | `mediaCondividiAppDaAggiornare` |
  | `non-riuscita` / `non-supportato` | `mediaCondivisioneNonRiuscita` |
  | `nativo-foglio` / `web-foglio` | nessun avviso (il foglio è a schermo) |

- `condividi` passa `chiave: m.id` e `titolo: m.titolo ?? t('galleryFotoDaKidville')`.
- `puoCondividere` con `useSyncExternalStore(() => () => {}, puoCondividereFileMedia, () => false)`:
  niente stato in un effetto (memoria `eslint_set_state_in_effect`), e al render del server vale `false`.
- `ComandiMedia`: mentre il proprio pulsante lavora, `disabled`, `aria-busy="true"` e il testo
  `mediaInPreparazione`. Lo stato è locale al pulsante, così la griglia (fino a 40 card) non si
  ridisegna. «Condividi» compare solo se `conCondividi && puoCondividere`.
- In Foto: Condividi solo col genitore (`showActions`), come oggi, sia sulla card sia nel
  visore. Staff (`scaricabile`): solo Scarica.
- Testi nuovi (`it` / `en`), in `shared`:

  | Chiave | Italiano | Inglese |
  |---|---|---|
  | `mediaInPreparazione` | «Preparo…» | «Preparing…» |
  | `mediaCondividiToccaDiNuovo` | «Il file è pronto: tocca di nuovo «Condividi».» | «The file is ready: tap "Share" again.» |
  | `mediaCondividiAppDaAggiornare` | «Per condividere il file aggiorna l'app Kidville dallo store.» | «To share the file, update the Kidville app from the store.» |
  | `mediaCondivisioneNonRiuscita` | «Condivisione non riuscita. Riprova fra qualche minuto.» | «Sharing failed. Please try again in a few minutes.» |

  Se `mediaLinkCopiatoLungo` resta senza usi, si toglie, purché nessun lock sui cataloghi lo
  vieti (memoria `catalogo_messaggi_non_riordinare`: non si riordina niente).

- [ ] **Step 1: Scrivi i test che falliscono** (`useAzioniMedia.test.tsx`, con
  `@/lib/native/scarica` mockato):
  - `due tocchi rapidi su Condividi: una sola condividiMedia e una riga azione-gia-in-corso`.
  - `uno scarico in corso blocca anche Condividi`.
  - `gesto scaduto → avviso «tocca di nuovo»; app 1.0 → avviso aggiorna; non-riuscita → avviso`.
  - `foglio aperto o annullato: nessun avviso`.
  - `ComandiMedia: col pulsante al lavoro è disabled, aria-busy e dice «Preparo…»`.
  - `ComandiMedia: senza puoCondividere Condividi non c'è, Scarica sì`.
  - In `scarica-media-grid.test.tsx`, riscritti:
    - `la condivisione consegna il FILE: condividiMedia con chiave = id del media, mai condividiLink`
    - `card e visore condividono con la stessa funzione e lo stesso argomento`
- [ ] **Step 2:** `npx vitest run __tests__/components/useAzioniMedia.test.tsx __tests__/components/scarica-media-grid.test.tsx` → FAIL.
- [ ] **Step 3:** implementa l'hook, `ComandiMedia`, i testi, e fai usare tutto a `MediaGrid`.
- [ ] **Step 4:** stessa lista di test dello Step 4 del Compito 2, più i due file di questo
  compito, più `npx vitest run __tests__/i18n` (lock sui cataloghi) → PASS.
- [ ] **Step 5:** commit `"Foto: Condividi manda il file; Scarica e Condividi in un hook solo"`.

---

### Compito 4: la chat di genitore e docente

**Files:**
- Create: `src/components/features/chat/FotoAllegatoChat.tsx` (la miniatura-pulsante)
- Create: `src/components/features/chat/VisoreFotoChat.tsx` (adatta i messaggi a `VisoreMedia` + `ComandiMedia`)
- Modify: `src/components/features/chat/ChatMessageArea.tsx`. La bolla `:216-221` usa
  `FotoAllegatoChat`. Prop nuova **obbligatoria** `azioniFoto`. Lo stato `fotoAperta` sta in
  `ChatMessageArea`.
- Modify: `src/app/(dashboard)/parent/chat/page.tsx` (`:352`, `:423` → `azioniFoto="genitore"`),
  `src/app/(dashboard)/teacher/chat/page.tsx` (`:295`, `:369` → `azioniFoto="staff"`)
- Modify: `__tests__/components/download-genitore-helper.test.tsx` (aggiunge la prop dove
  renderizza `ChatMessageArea`), `messages/it/parentChat.json` e `messages/en/parentChat.json`
- Test: `__tests__/components/chat-visore-foto.test.tsx`

**Interfaces — Consumes:** `VisoreMedia`/`MediaVisore` (Compito 2), `ComandiMedia`/
`MediaAzionabile` (Compito 3), `allegatoMostrabile`, `ChatMessage`.
**Produces:**
```tsx
export function FotoAllegatoChat(props: { url: string; onApri: () => void }): React.ReactElement
export function VisoreFotoChat(props: {
  messaggi: Pick<ChatMessage, 'id' | 'attachment_url' | 'attachment_type'>[]
  apertoId: string | null
  onCambia: (id: string) => void
  onChiudi: () => void
  azioni: 'genitore' | 'staff' | 'vigilanza'
  onScaricaVigilanza?: (messaggioId: string) => Promise<void>   // solo con azioni="vigilanza" (Compito 6)
}): React.ReactElement | null
// ChatMessageArea: nuova prop
azioniFoto: 'genitore' | 'staff'
```

Come funziona:
- **`FotoAllegatoChat`** è un `<button type="button">` con `aria-label={t('chatApriFoto')}`.
  Dentro c'è lo stesso `<img>` di oggi: classi `w-full h-auto max-h-48 object-cover`, alt
  `attachmentAlt`. L'involucro `mb-2 rounded-xl overflow-hidden` diventa la classe del
  pulsante, più `block w-full` e un anello di fuoco visibile. Se il lock
  `media-con-rapporto-daspetto` cita la riga vecchia in un commento, il commento si aggiorna.
- **`VisoreFotoChat`**:
  - `elementi` = i messaggi con `attachment_type === 'image'` e `allegatoMostrabile(url)`,
    nell'ordine ricevuto (cronologico). Per ognuno: `id` = id del messaggio, `tipo: 'foto'`,
    `alt` = `attachmentAlt`.
  - **URL mostrato stabile**: un `useRef<Map<string, string>>` tiene il primo URL visto per
    ogni id finché il visore è aperto, e si svuota alla chiusura. L'`<img>` usa quello; le
    azioni usano l'URL **corrente** delle props.
  - Se `apertoId` non è più fra gli `elementi`, chiama `onChiudi()` dentro un effetto (nessuno
    `setState`).
  - `etichetta` = `t('chatFotoConversazione', { n, totale })`.
- **Comandi per superficie:**

  | `azioni` | Comandi |
  |---|---|
  | `genitore` | Scarica + Condividi, etichetta `chat` |
  | `staff` | solo Scarica, etichetta `chat` |
  | `vigilanza` | solo Scarica attraverso `onScaricaVigilanza`, etichetta `chat-vigilanza` |

  Il `nomeFile` è sempre `null`, così il nome lo decide `nomeFileScarico`: diventa
  `kidville-foto.<ext>`.
- Il percorso del file nel bucket ha la forma `${uuid}-${nome originale}`: il nome
  originale non entra mai nel nome del file né nei log.
- **Testi nuovi** (`parentChat`, `it` / `en`):

  | Chiave | Italiano | Inglese |
  |---|---|---|
  | `chatApriFoto` | «Apri la foto a tutto schermo» | «Open the photo full screen» |
  | `chatFotoConversazione` | «Foto {n} di {totale} della conversazione» | «Photo {n} of {totale} in the conversation» |

- [ ] **Step 1: Scrivi i test che falliscono** (`chat-visore-foto.test.tsx`, con
  `ChatMessageArea` vera e `@/lib/native/scarica` mockato):
  - `toccare la miniatura apre il visore su quella foto`: `getByRole('button', { name: 'Apri la foto a tutto schermo' })`
    → `getByRole('dialog', { name: 'Foto 1 di 2 della conversazione' })`.
  - `le frecce passano solo fra le foto mostrabili`: messaggi = foto A, documento, foto B con
    percorso grezzo, foto C. Da A, «›» porta a C, e il nome del dialog è `Foto 2 di 2…`.
  - `genitore: Scarica e Condividi; staff: solo Scarica`.
  - `l'URL rifirmato non ricarica l'immagine ma arriva a Scarica`: si rirenderizza con un URL
    nuovo per lo stesso id → l'`src` dell'`<img>` nel dialog non cambia, e il click su Scarica
    chiama `scaricaMedia` con l'URL **nuovo**.
  - `il messaggio sparisce dalla lista: il visore si chiude`.
  - `due ChatMessageArea montate: il tocco nella prima apre un dialog solo`:
    `getAllByRole('dialog')` ha lunghezza 1, e `chiudiOverlayInCima()` lo chiude.
- [ ] **Step 2:** `npx vitest run __tests__/components/chat-visore-foto.test.tsx` → FAIL.
- [ ] **Step 3:** implementa i due componenti, la prop e le quattro chiamate nelle due pagine.
- [ ] **Step 4:** `npx vitest run __tests__/components/chat-visore-foto.test.tsx __tests__/components/ChatMessageArea-allegato.test.tsx __tests__/components/download-genitore-helper.test.tsx __tests__/pages/chat-stato-conversazione.test.tsx __tests__/lib/chat __tests__/architecture/media-con-rapporto-daspetto.test.ts` e `npx tsc --noEmit` → PASS.
- [ ] **Step 5:** commit `"Chat: la foto si apre a tutto schermo, con Scarica e (per i genitori) Condividi"`.

---

### Compito 5: lo scarico dalla supervisione, registrato

**Files:**
- Create: `supabase/migrations/<VERSIONE>_chat_vigilanza_azione_scarico.sql`.
  `<VERSIONE>` = `date -u +%Y%m%d%H%M%S` al momento della scrittura, mai un orario tondo né
  nel futuro (memoria `versione_migrazione_nel_futuro_e_fotografie`).
- Create: `src/app/api/admin/chat/messages/scarico/route.ts`
- Modify: `src/lib/chat/vigilanza-audit.ts` (`AzioneVigilanza` += `'scarico'`; il commento
  di testa dice chi scrive la nuova azione)
- Modify: `src/app/api/admin/chat/vigilanza/route.ts:27` (`z.enum` += `'scarico'`)
- Modify: `src/components/features/admin/messaggi/RegistroVigilanza.tsx`: opzione del filtro
  (`:140`), etichetta della riga (`:198-201`), tipo `:25`
- Modify: `messages/it/adminComunicazioni.json` e `messages/en/adminComunicazioni.json`:

  | Chiave | Italiano | Inglese |
  |---|---|---|
  | `registroAzioneScarico` | «Ha scaricato una foto» | «Downloaded a photo» |

- Test:
  - `__tests__/api/admin-chat-scarico-vigilanza.test.ts`: i mock di Supabase si copiano da
    `__tests__/api/chat-allegati-firmati.test.ts`, che ha già il caso della GET admin.
  - Test della migrazione nello stile di `migrazione-votazioni.test.ts`, che si trova con
    `find . -name 'migrazione-votazioni.test.ts' -not -path './node_modules/*'`. Usa
    `__tests__/lib/sql-da-migrazioni.ts`.
  - `__tests__/components/RegistroVigilanza-conteggi.test.tsx`: un caso per la nuova azione.

**La migrazione:**
- **Prima**, il nome vero del vincolo, con una sola lettura su produzione:
  `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.chat_vigilanza_accessi'::regclass AND contype = 'c';`
- Poi:
  ```sql
  ALTER TABLE public.chat_vigilanza_accessi DROP CONSTRAINT IF EXISTS <nome-letto>;
  ALTER TABLE public.chat_vigilanza_accessi ADD CONSTRAINT <nome-letto>
    CHECK (azione IN ('lettura', 'ricerca', 'scarico'));
  ```
- Più `COMMENT ON TABLE` aggiornato: stesso testo di
  `20260909111608_chat_vigilanza_accessi_sola_aggiunta.sql`, con la route nuova fra quelle
  che scrivono.
- Intestazione `--` col perché e la data, come le migrazioni vicine.
- Nessuna `GRANT`: le scritture restano INSERT della service_role.

**La route** `POST /api/admin/chat/messages/scarico`, body `{ message_id: zUuid }` con
`parseBody`, `withRoute('admin/chat/messages/scarico:POST', …)`. In ordine:
1. `requireStaff`.
2. Il messaggio (`id, thread_id, attachment_url, attachment_type`). Se `{ error }` →
   `rispostaGuastoDb`. Se non c'è → 404.
3. Se `attachment_type !== 'image'` o manca il percorso → 400 `{ codice: 'ALLEGATO_NON_FOTO' }`.
4. Il thread (`student_id`): 404 se non c'è.
5. `assertAlunnoInScope`. Fuori scope → riga `azione: 'scarico', esito: 'fuori-scope'`, poi la
   risposta del guard.
6. La sede dell'alunno: un `{ error }` → `rispostaGuastoDb`, come la GET.
7. `registraAccessoVigilanza({ azione: 'scarico', threadId, alunnoId, scuolaId, nMessaggi: 1, request })`.
   Se `!tracciato` → 503 `{ codice: 'VIGILANZA_NON_TRACCIABILE' }`, **prima** di firmare.
8. `firmaAllegatiChat` sul solo messaggio. Se l'URL esce `null` → 503 `{ codice: 'FIRMA_NON_RIUSCITA' }`.
9. `200 { success: true, url }`.

Log del successo: `logEvento('chat', 'info', { operazione: 'admin/chat/messages/scarico:POST', esito: 'scarico-registrato', thread_id, operatore_id })`.
Solo uuid.

- [ ] **Step 1:** leggi il nome del vincolo con la `SELECT` sopra e scrivilo nel rapporto.
- [ ] **Step 2: Scrivi i test che falliscono:**
  - Route:
    - `registra la riga scarico PRIMA di firmare`: ordine delle chiamate.
    - `registro non scrivibile: 503 VIGILANZA_NON_TRACCIABILE e nessuna firma`.
    - `fuori sede: riga fuori-scope e rifiuto, nessuna firma`.
    - `un documento: 400 ALLEGATO_NON_FOTO, nessuna riga`.
    - `senza staff: rifiutata dal gate`.
    - `risponde con l'URL firmato e non col percorso del bucket`.
  - Migrazione: `azione 'scarico' si inserisce`, `'lettura' e 'ricerca' ancora sì`,
    `'altro' rifiutata dal CHECK`.
  - Registro: `la riga scarico si legge «Ha scaricato una foto» e il filtro la offre`.
- [ ] **Step 3:** `npx vitest run __tests__/api/admin-chat-scarico-vigilanza.test.ts <test migrazione> __tests__/components/RegistroVigilanza-conteggi.test.tsx` → FAIL.
- [ ] **Step 4:** scrivi migrazione, route, tipi e UI del registro.
- [ ] **Step 5:** `npx vitest run __tests__/api __tests__/architecture` → PASS. Lì girano
  `zod-coverage`, `logging-coverage`, `migrazioni-complete`, `isolamento-sede-coverage` e le
  altre fotografie: **si fa quello che chiedono, senza allentarle**. Ogni fixture rigenerata va
  scritta nel rapporto.
- [ ] **Step 6:** commit `"Supervisione chat: lo scarico di una foto resta nel registro di vigilanza"`.

---

### Compito 6: la pagina Messaggi della segreteria

**Files:**
- Create: `src/components/features/chat/DocumentoAllegatoChat.tsx`. È il chip estratto da
  `ChatMessageArea.tsx:222-256`, con `suNativo('apri', …)` e l'avviso, così com'è.
  `ChatMessageArea` lo usa.
- Modify: `src/app/(dashboard)/admin/messaggi/page.tsx`. `Msg` (`:27`) prende
  `attachment_url: string | null; attachment_type: string | null`. Nelle bolle di «Con i
  genitori» (`:375-384`) e di «Tutti» (`:536-546`) compaiono `FotoAllegatoChat` e
  `DocumentoAllegatoChat`, sopra il testo. Un visore per scheda:
  - «Con i genitori» → `VisoreFotoChat azioni="staff"`;
  - «Tutti» → `azioni="vigilanza"` con `onScaricaVigilanza`.
- Modify: `messages/it/adminComunicazioni.json` e `messages/en/adminComunicazioni.json`:

  | Chiave | Italiano | Inglese |
  |---|---|---|
  | `messaggiScaricoNonRegistrato` | «Lo scarico non si è potuto registrare, quindi non è partito. Riprova fra qualche minuto.» | «The download could not be recorded, so it did not start. Please try again in a few minutes.» |

- Test: `__tests__/pages/admin-messaggi-allegati.test.tsx` (i mock di pagina si copiano da
  `__tests__/pages/admin-messaggi-chat-letta.test.tsx`)

**Interfaces — Consumes:**
- `FotoAllegatoChat` e `VisoreFotoChat` (Compito 4);
- la route `POST /api/admin/chat/messages/scarico` → `{ url }` oppure `{ codice }` (Compito 5);
- `useAzioniMedia({ etichetta: 'chat-vigilanza' }).scarica` (Compito 3).

**`onScaricaVigilanza(id)`:**
1. `fetch` POST alla route.
2. Con `ok` → `scarica({ id, url, tipo: 'foto', nomeFile: null })`.
3. Senza `ok`, o con un errore di rete → `alert(t('messaggiScaricoNonRegistrato'))` più
   `logClient` a `warn` con `messaggio: 'chat-vigilanza-scarico-rifiutato'` e
   `campi: { stato }`. Nessuno scarico.

- [ ] **Step 1: Scrivi i test che falliscono:**
  - `Con i genitori: la foto compare, apre il visore con solo Scarica`.
  - `Tutti: Scarica chiama la route di vigilanza col message_id e scarica l'URL che riceve`:
    `scaricaMedia` riceve l'URL della risposta, non quello della bolla.
  - `Tutti: la route risponde 503 → avviso a schermo, nessuno scarico`.
  - `un documento compare come chip apribile`.
- [ ] **Step 2:** `npx vitest run __tests__/pages/admin-messaggi-allegati.test.tsx` → FAIL.
- [ ] **Step 3:** implementa `DocumentoAllegatoChat` e le modifiche alla pagina.
- [ ] **Step 4:** `npx vitest run __tests__/pages/admin-messaggi-allegati.test.tsx __tests__/pages/admin-messaggi-sede.test.tsx __tests__/pages/admin-messaggi-chat-letta.test.tsx __tests__/pages/admin-messaggi-scheda-notifiche.test.tsx __tests__/features/admin/thread-sospensione-banner.test.tsx __tests__/components/download-genitore-helper.test.tsx` → PASS.
- [ ] **Step 5:** commit `"Messaggi della segreteria: foto e documenti visibili, con lo stesso visore"`.

---

### Compito 7: E2E, PRD, gate interi

**Files:**
- Modify: `e2e/chat.spec.ts`, dopo l'invio della foto (`:64-113`).
- Modify: `PRD REGISTRO ELETTRONICO.md`: tabella di stato e voce
  `Changelog — 2026-11-03 — Foto della chat a tutto schermo` nel modello dei changelog vicini.
  La voce dice:
  - le decisioni del titolare;
  - le sei scelte minori;
  - la migrazione, che si applica al merge;
  - che lo scarico dalla supervisione finisce nel registro;
  - che la prova su iPhone e Android vero resta da fare.

**Test E2E:**
- `await page.getByRole('button', { name: 'Apri la foto a tutto schermo' }).first().click()`
- `await expect(page.getByRole('dialog')).toBeVisible()`
- `await expect(page.getByRole('dialog').getByRole('button', { name: /Scarica/i })).toBeVisible()`
- `await page.keyboard.press('Escape')` → `await expect(page.getByRole('dialog')).toBeHidden()`

Condividi **non** si asserisce: Chromium headless su Linux non condivide file.

- [ ] **Step 1:** aggiungi i passi all'E2E e scrivi la voce del PRD.
- [ ] **Step 2: gate interi**, in quest'ordine, ognuno con la **coda** dell'uscita nel rapporto:
  - `npx eslint . --max-warnings 0` → 0 problemi;
  - `npx tsc --noEmit` → nessun errore;
  - `npx vitest run 2>&1 | tail -25` → «Tests … passed», 0 failed. L'esito si legge dal
    testo: dopo una pipe `$?` mente (memoria `exit_code_dopo_una_pipe_mente`);
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -30` → build completata
    (la build locale va in OOM senza heap più grande).
- [ ] **Step 3:** se un gate è rosso, si corregge la causa, non il gate.
- [ ] **Step 4:** commit `"Visore foto della chat: E2E e PRD"`. **Niente push**: lo fa la
  sessione principale.

---

## Self-review (fatta)

- **Copertura dello spec**:

  | Parte dello spec | Compito |
  |---|---|
  | Visore unico | 2 |
  | Condividi col file in Foto | 3 |
  | Chat di genitore e docente | 4 |
  | Segreteria, scheda «Con i genitori» | 6 |
  | Supervisione registrata | 5 + 6 |
  | App 1.0 | 1 + 3 |
  | Web senza condivisione | 1 + 3 |
  | Indietro di Android | 2 |
  | URL stabile | 4 |
  | Log | 1, 3, 5, 6 |
  | PRD ed E2E | 7 |

  Il documento della supervisione resta fuori, come dice lo spec.
- **Nomi controllati fra i compiti**: `condividiMedia`/`CondividiMediaInput.chiave` (1→3),
  `MediaVisore`/`VisoreMedia` (2→4), `MediaAzionabile`/`ComandiMedia` (3→4, 6),
  `onScaricaVigilanza` (4→6), `azioniFoto` (4).
- **Review Focus**: i cinque punti hanno ciascuno un test in un compito.
