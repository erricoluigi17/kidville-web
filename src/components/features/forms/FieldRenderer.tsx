'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type {
  UseFormRegister,
  Control,
  FieldValues,
  RegisterOptions,
} from 'react-hook-form'
import { Controller, useWatch } from 'react-hook-form'
import {
  Upload, FileCheck2, Loader2, AlertCircle, PenLine, ExternalLink,
} from 'lucide-react'
import { LinkInterno } from '@/components/ui/LinkInterno'
import type { FormField } from '@/types/database.types'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { useMessaggioCampo } from '@/components/features/forms/messaggio-campo'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { caricaFile } from '@/lib/upload/carica-file'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton'

// ── La forma di un campo, in pezzi separabili ────────────────────────────────
// Erano una stringa sola, e per questo il campo IN ERRORE aveva lo stesso
// contorno di un campo valido: il bordo stava dentro la base e non c'era modo di
// cambiarlo. Misurato l'11/08/2026 sul modulo pubblico con tre campi obbligatori
// vuoti: `border-color` computato #55615C — identico a un campo mai toccato —
// e l'unico segnale visivo era la riga rossa di 12px sotto. `aria-invalid` c'era
// (chi usa lo screen reader lo sapeva), a occhio no: WCAG 3.3.1 chiede che
// l'errore sia IDENTIFICATO, e il repo aveva già il token per farlo.
//
// I tre pezzi, e perché sono tre:
//  · STRUTTURA: geometria, riempimento, segnaposto — non dichiara né il
//    colore del bordo né quello del testo, così chi compone non deve sperare
//    nell'ordine delle utility Tailwind (che è quello del FOGLIO, non quello
//    della stringa: due `text-*` sullo stesso elemento non si risolvono a mano).
//    E dal 11/08/2026 non dichiara NEPPURE il bordo del fuoco: vedi sotto.
//  · BORDO: `ok` con la sfumatura di brand — che `globals.css` rimappa a
//    `neutral`/`sub` per portarla sopra i 3:1 di WCAG 1.4.11 — oppure `errore`
//    con `--color-kidville-error` (#E53935, 4,23:1 su bianco) a 1,5px.
//    ⚠️ Il pezzo in errore NON deve portarsi dietro `border-kidville-green/<alfa>`:
//    la regola dei contorni deboli di `globals.css` aggancia proprio
//    `input[class*="border-kidville-green/"]` e ridipingerebbe di grigio il rosso.
//    È il motivo per cui qui il bordo si SOSTITUISCE invece di aggiungersi.
//  · INCHIOSTRO: il verde del valore, oppure `sub` quando il controllo è vuoto
//    (vedi `SelectField`).
//
// ── IL FUOCO DISEGNA UNA LINEA SOLA, E L'ERRORE NON SE NE VA (11/08/2026) ────
// La struttura portava `focus:border-kidville-green focus:ring-2
// focus:ring-kidville-green/20`. Due difetti, uno per pezzo, misurati nel
// browser sul passo 2 di `/lavora-con-noi`:
//  · il campo a fuoco mostrava DUE anelli verdi concentrici separati da un filo
//    bianco. Non è un'illusione: `outline: 2px solid rgb(0,106,95)` a 2px di
//    stacco, `box-shadow: rgb(255,255,255) 0 0 0 2px` e `border-top: 1px
//    rgb(0,106,95)` — l'anello globale di `globals.css` e il bordo del campo
//    dello stesso identico verde, che si leggono come una linea sdoppiata;
//  · il campo IN ERRORE, appena riceveva il fuoco, tornava verde: misurato
//    «Cognome» in errore non a fuoco `1.5px rgb(229,57,53)`, «Nome» in errore E
//    a fuoco `1.5px rgb(0,106,95)`. Il messaggio rosso restava sotto, ma il
//    campo — la cosa che si guarda mentre lo si ricorregge — smetteva di dire
//    di essere quello sbagliato. Causa: una `focus:border-*` nella STRUTTURA,
//    cioè nel pezzo comune, vince sul bordo di STATO scritto nel pezzo suo.
// Ora l'anello lo fa tutto `globals.css` e il bordo resta il contorno del campo.
//
// ⚠️ E il contorno al fuoco va DICHIARATO, non lasciato cadere. La regola dei
// contorni deboli di `globals.css` si sfila con `:not(:focus)`: tolta la
// `focus:border-*` e basta, al fuoco il bordo tornerebbe alla utility grezza
// `border-kidville-green/15`, cioè #D9E9E7 — 1,25:1, il contorno che quella
// regola esiste per chiudere. MISURATO con una sonda nella pagina vera: a
// riposo `rgb(85,97,92)`, al fuoco `lab(… / 0.15)`, cioè il 15% di verde. Per
// questo `BORDO_OK` porta `focus:border-kidville-sub`: #55615C, 6,46:1 sul
// bianco del campo e 5,33:1 sulla crema, lo STESSO colore che la regola per
// superficie crema gli dà già a riposo — sulle superfici crema il bordo non
// cambia affatto, sulle bianche passa da `neutral` a `sub`, cioè si scurisce.
// `BORDO_ERRORE` non dichiara nessun fuoco: il rosso resta rosso (verificato
// con la stessa sonda: `rgb(229,57,53)` a riposo e a fuoco).
// ── IL SEGNAPOSTO HA IL SUO INCHIOSTRO, E NON È QUELLO DEL VALORE (11/08/2026) ─
// `placeholder-kidville-green/40` valeva #99C3BF composto sul bianco del campo,
// cioè 1,92:1: sotto 1.4.3, e il segnaposto è TESTO. Sulle superfici pubbliche
// `globals.css` lo copriva già; nei moduli in-app e nel modulo d'iscrizione —
// stesso componente, stessa gente che ci scrive dentro — no: là il difetto era
// ancora tutto intero. Ora il colore lo porta il componente, con `hint`, e vale
// su OGNI superficie: 5,08:1 sul bianco del campo (`bg-kidville-white`, che in
// Alto Contrasto resta bianco perché la sua utility ha l'hex inlinato) e 1,28:1
// col valore digitato #006A5F, contro 1,01:1 di `sub`. Il conto per esteso e il
// perché 1,28:1 sia vicino al massimo ottenibile stanno accanto al token in
// `globals.css`. Il secondo segnale, il corsivo, resta: è quello che sopravvive
// dove il colore non c'è.
//
// ── E IL CORSIVO VIAGGIA COL COMPONENTE, non con la superficie ───────────────
// MISURATO nella pagina vera l'11/08/2026, togliendo `kv-public` dal guscio per
// riprodurre la cascata dei moduli in-app: `getComputedStyle(campo,
// '::placeholder').fontStyle` tornava `normal` in luce normale (la regola del
// corsivo di `globals.css` è scopata a `.kv-public`, quella generale solo
// all'Alto Contrasto). Cioè lo stesso componente dava DUE segnali sul modulo
// pubblico e UNO nella modulistica di famiglie e segreteria. `placeholder:italic`
// lo attacca al campo: dove c'è il campo ci sono tutti e due i segnali.
const FIELD_STRUTTURA =
  'w-full px-4 py-3 rounded-input bg-kidville-white placeholder-kidville-hint placeholder:italic ' +
  'focus:outline-none transition-all'
const BORDO_OK = 'border border-kidville-green/15 focus:border-kidville-sub'
const BORDO_ERRORE = 'border-[1.5px] border-kidville-error'

export const FIELD_BASE = `${FIELD_STRUTTURA} ${BORDO_OK} text-kidville-green`
export const FIELD_BASE_ERRORE = `${FIELD_STRUTTURA} ${BORDO_ERRORE} text-kidville-green`

// ── La card di una SCELTA (radio, checkbox, consenso) ────────────────────────
// Stesso linguaggio delle card di sede dei due wizard pubblici
// (`CandidaturaInsegnanteWizard.tsx:1111`, `EnrollmentWizard.tsx:648`): carta
// BIANCA sul crema della pagina, raggio di card, controllo da 16px e — questa è
// la parte che mancava — uno STATO SCELTO che si vede senza guardare il
// quadratino. Prima erano crema su crema, e spuntarle non cambiava nulla:
// il dato `checked` era già calcolato nel componente e non veniva usato per niente.
//
// Il contorno a riposo è `neutral` e non `line`: è lo stesso grigio che
// `globals.css` impone al contorno di OGNI campo di questo modulo (3,10:1 su
// bianco), mentre `line` — quello delle card di sede — vale 1,23:1. La coerenza
// che il rilievo chiede è di forma, riempimento e stato; il bordo lo si allinea
// verso l'alto, non verso il basso.
//
// ── PERCHÉ QUESTE CINQUE RIGHE SONO ESPORTATE (11/08/2026) ───────────────────
// Perché «lo stesso linguaggio» scritto due volte è due linguaggi. Misurato sul
// modulo insegnanti: le card della SEDE (passo 1) portavano
// `border-kidville-line` — #EFE7DC, 1,10:1 sul crema, cioè nessun contorno —
// mentre le card delle FASCE e dei CONSENSI (passi 3 e 4), che nascono qui,
// portavano `neutral` #8A958F a 2,79:1. Stessa domanda, due grafiche, nella
// stessa pagina. La coerenza non si ottiene ricopiando la stringa giusta nel
// secondo posto: si ottiene togliendo il secondo posto. Chi disegna una card di
// scelta fuori da `FieldRenderer` — i due wizard pubblici — importa
// `classeScelta`/`SCELTA_CONTROLLO` da qui.
//
// ── E UN GRUPPO IN ERRORE LO DICE ANCHE SULLE CARD (11/08/2026) ──────────────
// Il difetto è lo stesso dei campi di testo, sopravvissuto nei GRUPPI: premendo
// «Avanti» senza scegliere nessuna fascia d'età compariva «Campo obbligatorio»
// sotto il gruppo, il fuoco andava sulla prima casella, e le tre card restavano
// IDENTICHE a tre card valide e non spuntate. MISURATO nella pagina viva
// (passo 3 di `/lavora-con-noi`, gradi vuoti, «Avanti» premuto): tutte e tre
// `border-top-color: rgb(138,149,143)`, `border-top-width: 1px`, cioè
// esattamente lo stato di riposo — mentre un `input` obbligatorio vuoto, due
// campi più su, mostrava `rgb(229,57,53)` a 1,5px. Il messaggio c'era
// (`role="alert"`, `aria-invalid`, `aria-describedby`): mancava il campo.
//
// Perché la struttura non dichiara più `border`: il peso del contorno fa parte
// dello STATO (1px a riposo, 1,5px in errore), ed è la stessa ragione per cui
// `FIELD_STRUTTURA` qui sopra non lo dichiara. Fra `border` e `border-[1.5px]`
// scritte sullo stesso elemento vince quella che sta più avanti nel FOGLIO, non
// quella scritta dopo nella stringa: l'unico modo di sceglierla è non averle
// entrambe.
//
// Le card GIÀ spuntate restano verdi: l'errore riguarda il gruppo vuoto, non la
// singola scelta.
// ── IL FUOCO DISEGNA UN ANELLO SOLO, ANCHE SULLE CARD (11/08/2026) ───────────
// La struttura portava `focus-within:ring-2 focus-within:ring-kidville-green
// focus-within:ring-offset-2`. È lo stesso difetto del «doppio anello» già
// chiuso sui campi di testo (blocco del fuoco più su), sopravvissuto nelle card:
// MISURATO nella pagina viva arrivando col TAB sulla prima fascia d'età di
// `/lavora-con-noi`, `:focus-visible` vero, transizioni spente e scheda in primo
// piano —
//   · sull'`input` 16×16: `outline: 2px solid rgb(0,106,95)`, `outline-offset: 2px`
//     (lo dà `:focus-visible` di `globals.css`, fuori da ogni `@layer`);
//   · sulla `<label>` 632×51: `box-shadow: rgb(255,255,255) 0 0 0 2px,
//     rgb(0,106,95) 0 0 0 4px`, cioè un SECONDO anello concentrico attorno a
//     tutta la card.
// Le card della SEDE, un passo prima nello stesso modulo, ne mostrano uno solo:
// il wizard aveva già rilevato la cosa e scelto di NON propagare l'anello
// (commento in `CandidaturaInsegnanteWizard.tsx`, blocco «L'ANELLO DI FUOCO…»).
// La coerenza si chiude togliendo l'anello di troppo qui, che è la fonte comune
// alle due famiglie di card e alla modulistica in-app.
//
// Nulla resta scoperto: il fuoco lo dà comunque `:focus-visible` sul controllo
// vero, che è l'elemento che il Tab raggiunge e quello che uno screen reader
// annuncia. La card è il bersaglio allargato, non il controllo.
// ── IL CURSORE NON FA PARTE DELLA GEOMETRIA (12/08/2026) ─────────────────────
// `cursor-pointer` stava dentro la struttura, cioè su OGNI card. Vale finché la
// card È il comando — un'opzione, una fascia d'età, una sede: lì la label
// avvolge il controllo e cliccare ovunque lo attiva. Non vale più per il
// CONSENSO, la cui card ora contiene un testo che si legge e si seleziona e che
// NON deve spuntare niente (vedi il blocco `consent`): un dito a freccia su un
// paragrafo inerte è una promessa che il clic poi non mantiene. Le due stringhe
// non sono ricopiate — la seconda è la prima più il cursore — perché la
// geometria resta una sola.
const SCELTA_GEOMETRIA = 'gap-3 px-4 py-3.5 rounded-card transition-all'
export const SCELTA_STRUTTURA = `${SCELTA_GEOMETRIA} cursor-pointer`
export const SCELTA_LIBERA = 'border border-kidville-neutral bg-kidville-white hover:border-kidville-green/40'
export const SCELTA_PRESA = 'border border-kidville-green bg-kidville-green-soft'
/**
 * La card di un gruppo NON VALIDO: lo stesso rosso e lo stesso peso del bordo di
 * un campo di testo in errore (`BORDO_ERRORE`) — #E53935, 4,23:1 sul bianco.
 * Niente `hover:border-*`: il rosso non se ne va passandoci sopra, come non se
 * ne va al fuoco su un `input` (vedi il blocco del fuoco qui sopra).
 */
export const SCELTA_ERRORE = 'border-[1.5px] border-kidville-error bg-kidville-white'
/** Il controllo dentro la card: 16px come nelle card di sede (era 13px, taglia di default). */
export const SCELTA_CONTROLLO = 'h-4 w-4 shrink-0 accent-kidville-green'

/**
 * La classe di una card di scelta: la stessa per un'opzione, un consenso, una sede.
 *
 * `cliccabile` dice se la card COINCIDE col comando (una `<label>` che avvolge il
 * controllo) o se è solo il contenitore che lo disegna. Nel secondo caso resta
 * fuori il `cursor-pointer`, e basta quello: il disegno — contorno, fondo,
 * raggio, stato — è identico, altrimenti sarebbero due linguaggi.
 */
export const classeScelta = (
  scelta: boolean,
  allineamento = 'items-center',
  nonValido = false,
  cliccabile = true,
) =>
  `flex ${allineamento} ${cliccabile ? SCELTA_STRUTTURA : SCELTA_GEOMETRIA} ${
    scelta ? SCELTA_PRESA : nonValido ? SCELTA_ERRORE : SCELTA_LIBERA
  }`

/**
 * Gli attributi di una card di scelta: la classe, e — quando il gruppo è in
 * errore — il marcatore che serve all'Alto Contrasto.
 *
 * Là il rosso non esiste: `.kv-public [class*="border-kidville-"]` porta OGNI
 * contorno a #000000, quindi la card in errore tornerebbe indistinguibile dalle
 * altre. `globals.css` aggancia `[data-scelta-invalida="true"]` e le dà il bordo
 * DOPPIO — lo stesso secondo segnale, non cromatico, che ha già il campo di
 * testo via `aria-invalid`. Sulla card l'attributo ARIA non si può usare: sta
 * sull'`input`, non sulla `<label>` che disegna il contorno.
 */
export const propsScelta = (
  scelta: boolean,
  {
    allineamento,
    nonValido = false,
    cliccabile = true,
  }: { allineamento?: string; nonValido?: boolean; cliccabile?: boolean } = {},
) => ({
  className: classeScelta(scelta, allineamento, nonValido, cliccabile),
  ...(nonValido && !scelta ? { 'data-scelta-invalida': 'true' as const } : {}),
})

/**
 * Le classi del MESSAGGIO D'ERRORE, in due pezzi.
 *
 * Sono estratte qui — invece di stare scritte due volte nei due rami che rendono
 * il messaggio — perché dal 2026-09-01 c'è un terzo nodo che deve portarle
 * IDENTICHE: l'ombra (`OmbraErrore`). Se le due stringhe divergessero,
 * l'altezza riservata smetterebbe di corrispondere a quella del messaggio e il
 * difetto sotto tornerebbe in silenzio.
 *
 * `ERRORE_IMPAGINAZIONE` è ciò che determina l'ALTEZZA (taglia del testo,
 * disposizione, distanza dall'icona); `ERRORE_TONO` il peso e il colore — che
 * l'altezza non la cambiano, ma cambiano la LARGHEZZA del testo, quindi quante
 * righe occupa.
 */
const ERRORE_IMPAGINAZIONE = 'flex items-center gap-1.5 text-xs'
const ERRORE_TONO = 'font-bold text-kidville-error-strong'
const ERRORE_CLASSI = `${ERRORE_IMPAGINAZIONE} ${ERRORE_TONO}`

/**
 * ── L'OMBRA DEL MESSAGGIO D'ERRORE: LO SPAZIO NON SI RESTITUISCE ─────────────
 *
 * MISURATO nel trace della CI, passo «Consensi» di `/iscrizione` su **WebKit**
 * (Safari e la WebView iOS dell'app), cioè su ciò che i genitori hanno in mano:
 *  1. «Avanti» senza spunta → il `<p role="alert">` entra nel flusso e spinge i
 *     comandi giù di **31,99 px** (667,71 → 699,70);
 *  2. il genitore spunta la casella con un tocco vero. WebKit **non assegna il
 *     fuoco a un checkbox cliccato**: il fuoco cade su `<body>` → blur;
 *  3. `mode: 'onTouched'` valida al blur → il campo diventa valido → il
 *     messaggio viene RIMOSSO (`errore:false` a t=0 ms su WebKit; su Chromium
 *     resta `true` per 540 ms, ed è per questo che il difetto era «solo
 *     webkit»);
 *  4. rimosso il messaggio, «Avanti» **risale di 24,98 px** — più della sua
 *     semi-altezza (20 px su 40);
 *  5. il tocco in corso, calcolato sulla posizione *con* l'errore, cade fuori
 *     dal pulsante. Il wizard resta fermo e non dice niente.
 *
 * La causa non è il blur di WebKit: è che **la posizione dei comandi dipende da
 * un messaggio effimero**. Perciò lo spazio che il messaggio ha occupato resta
 * suo finché il campo vive, e a occuparlo è questa ombra: una copia esatta del
 * messaggio, `invisible` (che tiene il posto e non si vede) e `aria-hidden`.
 *
 * ⚠️ PIGRA, e non un `min-h` sempre acceso. Riservare l'altezza a prescindere
 * metterebbe spazio morto sotto OGNI campo di ogni modulo pubblico — al passo
 * dei consensi sono quattro, al passo 1 dell'iscrizione sono dodici — anche in
 * una pagina che non ha mai sbagliato niente. L'ombra nasce solo DOPO che un
 * errore c'è stato davvero: a riposo la pila è identica a prima.
 *
 * ⚠️ UNA COPIA, e non un'altezza fissa. Quanto è alto il messaggio dipende da
 * quante righe occupa. MISURATO nella pagina viva (build di produzione,
 * `/iscrizione`, sonda nel pannello del wizard) restringendo la colonna:
 * «Devi accettare per proseguire» sta su una riga (16 px) fino a 200 px di
 * larghezza e ne occupa DUE (32 px) a 150 px — dove il salto, prima della
 * correzione, era di **41 px** invece di 25. Un `min-h-4` avrebbe riservato
 * 16 px dei 32 che servivano, cioè avrebbe lasciato in piedi metà del difetto
 * proprio nella colonna più stretta; e sarebbe stato tarato su UNA stringa in
 * UNA lingua, mentre i messaggi sono nove e il catalogo è bilingue.
 *
 * ⚠️ NON ANNUNCIA A VUOTO, ed è la ragione per cui è un `<div>` senza ruolo e
 * non un `role="alert"` sempre presente e vuoto:
 *  · niente `role`, `aria-hidden="true"` e `visibility: hidden` (che da sola
 *    già toglie il nodo all'albero di accessibilità): nessuna seconda live
 *    region negli snapshot delle pagine pubbliche, dove ce n'è già una in coda;
 *  · niente `id`: `<campo>-error` resta uno solo, ed è il bersaglio di
 *    `aria-describedby`;
 *  · è un `<div>` mentre il messaggio è un `<p>` **di proposito**: due tipi
 *    diversi obbligano React a smontare e rimontare invece di riusare il nodo,
 *    quindi al ritorno dell'errore il `role="alert"` viene INSERITO nel DOM
 *    insieme al proprio contenuto — che è la forma che le tecnologie assistive
 *    annunciano. Trasformare in `alert` un nodo che era già lì è comportamento
 *    non specificato.
 */
function OmbraErrore({ testo, classiIcona }: { testo: string; classiIcona: string }) {
  return (
    <div aria-hidden="true" className={`${ERRORE_CLASSI} invisible`}>
      <AlertCircle className={classiIcona} />
      {testo}
    </div>
  )
}

export function FieldRenderer({
  field,
  modelId,
  register,
  control,
  error,
  uploadEndpoint,
  nota,
  onNomeAllegato,
  nomeAllegatoIniziale,
}: {
  field: FormField
  modelId: string
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  error: unknown
  /** Se valorizzato, gli upload passano da questo endpoint server (multipart) invece del client browser. */
  uploadEndpoint?: string
  /**
   * La NOTA del campo: il testo di aiuto che sta sotto il controllo, e che il
   * campo dichiara come propria descrizione (`aria-describedby`).
   *
   * ⚠️ MISURATO il 25/08/2026 sul curriculum di `/lavora-con-noi`: `candCvNota`
   * (la chiave sta in `messages/{it,en}/public.json` — NON si ricopia qui: una
   * citazione ribattuta a mano invecchia come una cifra, e queste due righe
   * invecchiarono nel commit stesso che le scrisse, descrivendo una stesura
   * intermedia della nota) era un `<p>` senza `id`, reso dal wizard SOTTO il
   * campo. Chi legge la pagina in sequenza la incontra; chi la percorre
   * campo per campo — la modalità moduli degli screen reader, cioè il modo in cui
   * un modulo si compila davvero — non la sentiva mai. È la sola frase che dice a
   * chi non ha un PDF sottomano che può fotografare il foglio invece di
   * abbandonare il modulo.
   *
   * ── E DAL 2026-08-25 IL NODO LO RENDE QUESTO COMPONENTE, NON IL CHIAMANTE ──
   *
   * Fino a stamattina qui arrivava il solo `notaId` e il `<p>` lo rendeva il
   * wizard, DOPO `<FieldRenderer>`. Due proprietari per una pila sola, e il conto
   * si pagava sul curriculum: `field.link` è l'ultimo figlio di questo componente,
   * quindi il collegamento «Leggi l'informativa» si infilava FRA il controllo e la
   * sua nota. MISURATO nella pagina viva a 900 px, prima della correzione:
   * riquadro → link 8 px, link → nota 6 px, riquadro → **58 px** → nota (82 px in
   * errore, e 82 anche a 360 px), contro i **6 px** del campo gemello «Per quali
   * posizioni ti proponi», che la nota ce l'ha ma il link no. Cioè: l'unico campo
   * del modulo in cui qualcosa si interpone fra il controllo e il suo testo di
   * aiuto era quello diventato obbligatorio, e la frase spinta più lontano era
   * proprio quella che tiene aperta la porta a chi il curriculum lo FOTOGRAFA.
   *
   * Non si rimedia spostando il blocco `field.link` dentro il wizard: sarebbe una
   * seconda copia del collegamento e le due divergerebbero. Si rimedia dando a
   * questo componente l'intera pila — controllo → errore → nota → link — così
   * l'ordine è garantito per OGNI campo con `link`, presente e futuro, e non
   * dipende da chi chiama.
   *
   * L'`id` non si passa più: si DERIVA da `field.id` (`<id>-nota`). Erano due
   * props che dovevano dire la stessa cosa, cioè due props che un giorno si
   * sarebbero contraddette.
   */
  nota?: React.ReactNode
  /**
   * Il nome del file allegato, per chi lo deve mostrare DOPO che questo campo è
   * smontato (il riepilogo di un wizard a passi). Passa e basta: la ragione per
   * esteso sta su `onNomeFile` in `FileField`. Stringa vuota = niente allegato.
   */
  onNomeAllegato?: (nome: string) => void
  /**
   * Il nome dell'allegato che il chiamante si è tenuto, RIMANDATO INDIETRO.
   *
   * ⚠️ MISURATO il 25/08/2026 su `/lavora-con-noi`: dal riepilogo si preme
   * «Modifica» sul blocco «Il tuo profilo», si torna al passo 3 e il riquadro del
   * curriculum dice «Allegato caricato» — mentre il riepilogo, nella stessa
   * sessione e a due clic di distanza, continua a dire «cv-di-prova.pdf». Due
   * schermate dello stesso wizard raccontavano lo stesso dato in due modi nello
   * stesso istante, e lo facevano nel punto peggiore: su «Modifica» si preme
   * proprio per controllare quale file si è allegato.
   *
   * La causa è che il wizard rende UN PASSO ALLA VOLTA: tornando indietro
   * `FileField` si RIMONTA e il suo `fileName` riparte da ''. Il valore del
   * modulo sopravvive (è in react-hook-form), il nome no — e dal percorso non si
   * ricava, perché la rotta di caricamento butta via il nome originale.
   *
   * Perciò il nome ha UN SOLO proprietario, il chiamante: esce da `onNomeAllegato`
   * quando il file sale, e rientra da qui quando il campo torna in vita. È la
   * stessa forma già usata per `notaId`.
   */
  nomeAllegatoIniziale?: string
}) {
  const t = useTranslations('parentForms')
  /*
   * ── UN ALLEGATO STA SALENDO (25/08/2026) ────────────────────────────────────
   *
   * `FileField` teneva `uploading` tutto per sé e chiamava `rhf.onChange` SOLO a
   * caricamento finito. Per il modulo, quindi, un file in volo e un file mai
   * scelto erano lo stesso fatto: valore vuoto. Premendo «Avanti» mentre il
   * curriculum saliva, sotto un riquadro che nello stesso istante diceva
   * «Caricamento…» e portava `aria-busy="true"`, compariva «Campo obbligatorio» —
   * l'accusa di non aver allegato niente rivolta a chi il file l'aveva appena
   * scelto.
   *
   * ⚠️ Fino al 24/08 la stessa corsa non aveva conseguenze: sul curriculum il
   * campo era facoltativo, si passava oltre e basta. Da quando è obbligatorio
   * quella frase si legge come un rifiuto, e la legge per prima la gente che
   * carica una FOTOGRAFIA del curriculum da rete mobile, cioè quella che il
   * caricamento lo aspetta davvero.
   *
   * ⚠️ NON SI TOCCA `validateField`, che ha ragione: il valore È vuoto, e il passo
   * NON deve avanzare finché il percorso non c'è. A essere sbagliato era solo il
   * MOTIVO detto a chi compila. Una seconda regola di validazione qui sarebbe
   * stata «la regola destinata a divergere» contro cui questo repo ha una dottrina
   * scritta: l'informazione mancante era una sola — «sto caricando» — e ora esce
   * da `FileField` insieme a tutte le altre.
   */
  const [caricamentoInVolo, setCaricamentoInVolo] = useState(false)
  // Regola unica di validazione: la STESSA `validateField` che rigira il server
  // (obbligatorietà + pattern/lunghezze/provincia/email/date/select). RHF mostra
  // sotto il campo il messaggio (in italiano) che ritorna. I blocchi `consent`
  // mantengono la loro regola dedicata (messaggio migliore).
  const rules = {
    validate: (value: unknown) => validateField(field, value) ?? true,
  }
  /*
   * ── LA FRASE CHE FERMA QUALCUNO SI LEGGE NELLA SUA LINGUA (25/08/2026) ─────
   *
   * `validateField` è la regola UNICA che gira sul client e sul server, e i suoi
   * messaggi sono italiani per costruzione: sul server il locale non esiste. Ma
   * qui quella stringa finisce A SCHERMO, e questa superficie serve anche la
   * porta pubblica anonima, che ha il catalogo inglese completo. MISURATO su
   * `/lavora-con-noi` con `KV_LOCALE=en`: sotto «Curriculum» compariva «Allega un
   * file per proseguire», sotto «Titolo di studio» «Campo obbligatorio».
   *
   * ⚠️ SI TRADUCE L'OBBLIGO, NON SOLO IL CAMPO FILE, e la differenza non è di
   * ambizione: sono i due rami dello stesso `if`, si leggono nella stessa
   * schermata a 500 px di distanza, e tradurne uno solo avrebbe prodotto una
   * pagina inglese con una riga italiana accanto — mezza traduzione, cioè una
   * voce in più.
   *
   * ⚠️ IL CONFRONTO È SU UNA COSTANTE IMPORTATA, non su una stringa ribattuta
   * qui: ribatterla sarebbe la seconda copia della stessa frase, e la prima volta
   * che qualcuno corregge una virgola di là questo `if` smetterebbe di scattare —
   * in silenzio, col catalogo giusto e il testo sbagliato a schermo.
   *
   * ⚠️ E LA VOCE DEL CATALOGO NON RICOPIA LA COSTANTE (25/08/2026, quinto giro).
   * `campoObbligatorio` valeva «Campo obbligatorio» in italiano, cioè la stessa
   * identica stringa che la regola ritorna: la sostituzione avveniva e non si
   * vedeva. MISURATO al passo «I tuoi dati» dopo un «Avanti» a vuoto, leggendo
   * insieme i `[role=alert]`: `["Campo obbligatorio", "Campo obbligatorio",
   * "Campo obbligatorio"]`, e 24 px più in alto la legenda nuova «* campo
   * obbligatorio» — l'errore era l'eco letterale del glifo che pretende di
   * spiegare, tre volte. Al passo dopo, la stessa colonna dice «Scegli almeno
   * un'opzione per proseguire», «Seleziona un'opzione per proseguire», «Allega un
   * file per proseguire»: il prodotto dimostrava di saper parlare a una persona e
   * sceglieva di non farlo sul ramo che copre più campi di tutti (text, email,
   * phone, number, textarea, date).
   * Ora il catalogo dice «Compila questo campo per proseguire» / «Fill in this
   * field to continue». La COSTANTE resta «Campo obbligatorio», ed è giusto che
   * resti: è il contratto del server — `POST /api/iscrizione*` risponde
   * `{ campi: { id: msg } }`, il wizard lo rimette sotto il campo con `setError`,
   * e questo `if` lo riconosce. Costante e catalogo hanno due mestieri diversi;
   * pretenderli identici (come faceva un lock fino a stamattina) non protegge
   * niente e impedisce di scrivere una frase migliore di quella del database.
   *
   * Il resto dei predicati (email, data, numero, pattern) resta italiano: è
   * debito dichiarato nella testata di `validate-fields`, e si chiude con questa
   * stessa forma quando lo si affronterà.
   *
   * ⚠️ E DAL 25/08 (settimo giro) LA MAPPATURA NON È PIÙ QUI DENTRO, perché non
   * era vero che «passa tutto da `FieldRenderer`». MISURATO su
   * `/anagrafica-personale`: il codice fiscale è reso a mano (gli serve un
   * `aria-describedby` in più) e leggeva `error.message` grezzo — con
   * `KV_LOCALE=en` la sua colonna mostrava otto righe inglesi e una italiana,
   * «Campo obbligatorio». La mappatura vive in `messaggio-campo.ts` e i quattro
   * punti che rendono un campo la chiamano: vedi la testata di quel file.
   */
  const messaggioCampo = useMessaggioCampo()
  const errMsg = messaggioCampo(error)
  const errorId = `${field.id}-error`
  /**
   * L'ultimo messaggio che questo campo ha mostrato: è ciò che l'ombra
   * ricalca quando il messaggio se ne va (vedi `OmbraErrore` per la misura e
   * per il perché).
   *
   * ⚠️ È uno STATO aggiornato durante il render, non un `useRef` scritto
   * durante il render: il primo tentativo era un ref, e la regola
   * `react-hooks/refs` lo rifiuta a ragione — un valore che decide che cosa
   * disegnare non è un ref, è stato, e un ref cambiato in render non fa
   * ridisegnare niente. La forma qui sotto è quella documentata da React per
   * derivare uno stato da una prop: la guardia `!==` la rende idempotente,
   * React rilancia il render subito e senza commit intermedio, e il doppio
   * render di StrictMode dà lo stesso valore.
   *
   * Si azzera quando il campo si smonta, cioè al cambio di passo: lo spazio
   * riservato non sopravvive al campo che l'ha reso necessario.
   */
  const [ombraErrore, setOmbraErrore] = useState<string | null>(null)
  if (errMsg && errMsg !== ombraErrore) setOmbraErrore(errMsg)
  /**
   * L'`id` della nota, DERIVATO e non ricevuto: c'è se e solo se c'è la nota.
   * Vedi la prop `nota` — erano due props che dovevano concordare.
   */
  const notaId = nota ? `${field.id}-nota` : undefined
  // Accessibilità: input in errore marcato `aria-invalid` e collegato al testo
  // del messaggio via `aria-describedby` (il messaggio è testo visibile, non
  // solo colore).
  //
  // ── `aria-required`: IL SECONDO SEGNALE DELL'OBBLIGO (25/08/2026) ───────────
  //
  // Fino a oggi questo componente lo emetteva in UN SOLO punto — il ramo
  // `consent`, riga ~432, dove il commento accanto dice «l'obbligatorietà detta
  // anche a chi non vede l'asterisco». Per tutti gli altri tipi l'obbligo
  // viaggiava esclusivamente nell'ASTERISCO aggiunto al testo dell'etichetta,
  // cioè in un carattere di punteggiatura: chi ascolta lo sente come «asterisco»
  // o non lo sente affatto, e nessuna legenda dice che cosa significhi:
  // `grep -rniE 'contrassegnat|asterisc' messages/it messages/en` → **zero**, e i
  // cataloghi sono l'unica sorgente di testo tradotto che finisce a schermo.
  //
  // ⚠️ IL COMANDO CITATO QUI SOPRA È IL SECONDO, e il primo era falso. Fino al
  // 25/08 questa parentesi diceva «`grep -rn 'campi contrassegnati\|asterisco' src
  // messages` → zero»: quel comando ne torna **19**, e due dei file che trova
  // (`Combobox.tsx`, `LuogoNascitaFields.tsx`) sono esattamente i due che il
  // paragrafo qui sotto cita come precedenti — cioè il commento si smentiva da
  // solo in dieci righe. L'affermazione era vera e la misura no: il grep cercava
  // la parola «asterisco» in tutto il sorgente, COMMENTI COMPRESI, mentre la cosa
  // da dimostrare riguarda solo il testo che l'utente legge. È lo stesso difetto
  // che il resto di questo changeset denuncia altrove, applicato a se stesso: un
  // esito ribattuto in prosa invece che rieseguito.
  //
  // ⚠️ LA DOTTRINA IL REPO CE L'AVEVA GIÀ SCRITTA, in due posti, ed è questo file
  // che la contraddiceva: `Combobox.tsx` («l'asterisco è l'UNICA convenzione con
  // cui questa pagina dice "questo è obbligatorio"… `aria-required` è il secondo
  // segnale, quello che non dipende da un carattere dentro l'etichetta») e
  // `LuogoNascitaFields`, che lo emette da agosto. La misura che ha chiuso la
  // discussione è del 25/08 sul curriculum di `/lavora-con-noi`, letta dall'albero
  // di accessibilità di Chromium: `role=button`, nome «Curriculum * Seleziona un
  // file…», NESSUNA proprietà `required`.
  //
  // ⚠️ È UNA RIGA SOLA E VALE PER TUTTI I CAMPI, di proposito. Metterla sul solo
  // campo che l'ha fatta scoprire sarebbe stata «una seconda regola applicata a un
  // campo su sei» — l'obiezione era giusta, e la risposta è darlo a tutti, non
  // toglierlo a uno. `field.required || undefined` e non `|| false`: `false`
  // stamperebbe `aria-required="false"` su ogni campo facoltativo, cioè rumore al
  // posto del silenzio.
  //
  // ⚠️ `jest-axe` NON LO VEDE: un input senza `aria-required` non è una violazione
  // axe. Il presidio è scritto a mano in
  // `__tests__/a11y/candidatura-insegnante-a11y.test.tsx`, nei due versi (c'è sul
  // campo obbligatorio, NON c'è su quello facoltativo accanto).
  //
  // ⚠️ E QUANTO ARRIVI DAVVERO DIPENDE DAL RUOLO — misurato in Chromium con
  // `Accessibility.getPartialAXTree`, il 25/08, invece di darlo per buono:
  //   · `textbox` (`text`/`email`/`phone`): `required=true` sui campi obbligatori,
  //     `required=false` su quelli facoltativi. Arriva, ed è il caso della maggior
  //     parte dei campi;
  //   · `combobox` (`select`) e il campo di caricamento (che Chromium espone come
  //     `button`): NESSUNA proprietà `required` nell'albero. L'attributo sta nel
  //     DOM — altri motori e altre tecnologie assistive possono leggerlo — ma su
  //     quei due ruoli Chromium lo lascia cadere.
  // Perciò su quei campi l'obbligo continua ad arrivare per le altre due strade, e
  // nessuna delle due è di scorta: l'asterisco dentro il nome accessibile, e la
  // NOTA agganciata con `notaId` (sul curriculum è la frase che dice «senza
  // allegato la candidatura non si può inviare», e nell'albero AX si legge come
  // `description` — verificato).
  //
  // `aria-describedby` accetta PIÙ id, in ordine di lettura: prima il messaggio
  // d'errore (che è la cosa urgente), poi la nota del campo. Concatenare invece di
  // sovrascrivere è il punto: fino al 25/08 l'attributo lo occupava il solo errore,
  // quindi una nota agganciata sarebbe sparita esattamente quando serve di più.
  const descrizioni = [errMsg ? errorId : null, notaId ?? null].filter(Boolean).join(' ')
  //
  // ⚠️ DUE OGGETTI E NON UNO, ED È LA CORREZIONE DEL 2026-08-25. Il 24/08 questo
  // era un oggetto solo, sparso indistintamente sui controlli SINGOLI e su ogni
  // OPZIONE dei gruppi (`{...ariaProps}` dentro i due `map`). Per `aria-invalid`
  // e `aria-describedby` va bene; per `aria-required` no, e il difetto si
  // misurava in pagina: tutte e SETTE le caselle di «Per quali posizioni ti
  // proponi» dichiaravano `aria-required="true"`, cioè — su `role="checkbox"`,
  // dove quell'attributo significa «questa casella va spuntata» — che andavano
  // spuntate tutte e sette, mentre ne basta UNA. Un modulo che dice il falso a chi
  // ascolta e il vero a chi guarda.
  //
  // La generalizzazione «una riga sola e vale per tutti i campi» era giusta a metà:
  // vale per tutti i campi, non per tutti i CONTROLLI. In un gruppo «almeno uno di
  // N» l'obbligo è dell'insieme, e va dichiarato una volta.
  //
  // ⚠️ E NON SI RIMEDIA SPOSTANDOLO SUL CONTENITORE, almeno non su entrambi:
  //   · `role="radiogroup"` AMMETTE `aria-required` (ARIA 1.2, «Supported States
  //     and Properties») ed è il posto giusto: lo porta il gruppo, non le opzioni;
  //   · `role="group"` NON lo ammette. Metterlo lì scambierebbe un difetto
  //     semantico con una violazione formale, che `axe` segnala come
  //     `aria-allowed-attr`. Per il gruppo a spunta l'obbligo continua ad arrivare
  //     dalle due strade che ha sempre avuto: l'ASTERISCO dentro il nome del gruppo
  //     (`aria-labelledby` punta la <label> che lo stampa quando `required`) e il
  //     messaggio d'errore agganciato con `aria-describedby`.
  //
  // ⚠️ E LA NOTA SEGUE LA STESSA REGOLA. `notaId` è nato il 24/08 dentro
  // `ariaProps`, quindi finiva su ogni opzione: la nota di «posizioni» («Puoi
  // sceglierne più d'una…») si annunciava SETTE VOLTE, una per casella. Una
  // descrizione del gruppo si dichiara sul gruppo. Alle opzioni resta il solo
  // messaggio d'errore — che è ciò che portavano prima del 24/08, e che va
  // ripetuto perché è la risposta alla domanda «perché questo è rosso?».
  //
  // Il presidio, nei tre versi, è in `__tests__/a11y/candidatura-insegnante-a11y.test.tsx`
  // («l'obbligo del gruppo NON si ripete su ogni casella»): non sulle caselle, non
  // sul `role="group"`, sì sul campo singolo accanto. `jest-axe` non vede nessuno
  // dei primi due — `aria-required` su `role="checkbox"` è consentito — quindi le
  // asserzioni sono scritte a mano.
  // ⚠️ `aria-invalid` SEGUE LA VERNICE, E FINO AL 25/08 NON LA SEGUIVA.
  // Durante il caricamento questo campo ha TRE segnali, e due erano già stati
  // corretti: il bordo torna neutro (`nonValido={… && !caricamentoInVolo}`) e il
  // messaggio passa al tono della nota con la rotellina. Il terzo no. MISURATO
  // con l'upload rallentato: riquadro `rgb(85,97,92)`, testo `rgb(85,97,92)` peso
  // 400 — e l'`<input>` che continuava a dichiarare `aria-invalid="true"`.
  // Vernice e icona dicevano «aspetta», l'albero di accessibilità «campo non
  // valido», sull'unico campo che blocca il passo e proprio a chi sta facendo la
  // cosa giusta. È la dottrina di `nonValido` («un sistema con tre stati —
  // riposo · attesa · errore — non ne dipinge due con la stessa tinta») applicata
  // ai soli pixel, cioè sopravvissuta nel canale che non si vede.
  // Il predicato è lo stesso, scritto una volta: `caricamentoInVolo` è falso per
  // ogni tipo che non sia `file`, quindi qui non cambia niente per gli altri.
  // Presidio: `FieldRenderer-stati-visivi` §14, col controllo negativo che
  // pretende `aria-invalid` sull'errore vero.
  const ariaProps: React.AriaAttributes = {
    ...(errMsg && !caricamentoInVolo ? { 'aria-invalid': true as const } : {}),
    ...(descrizioni ? { 'aria-describedby': descrizioni } : {}),
    ...(field.required ? { 'aria-required': true as const } : {}),
  }
  /** Ciò che porta la SINGOLA OPZIONE dentro un gruppo: mai l'obbligo, mai la nota. */
  const ariaOpzione: React.AriaAttributes = {
    ...(errMsg ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {}),
  }
  // Tipi a controllo SINGOLO: la <label> esterna li etichetta direttamente
  // (htmlFor ↔ id). radio/checkbox hanno un GRUPPO di controlli → la label
  // esterna resta una didascalia senza htmlFor (per non puntare a un id
  // inesistente) e il gruppo si nomina con `aria-labelledby`.
  //
  // ⚠️ `file` È in questo elenco dal 12/08/2026, ed è metà del rimedio al difetto
  // descritto in `FileField`: il campo del caricamento è un `<input type="file">`
  // vero, con un `id` vero, e la sua etichetta è quella che sta a schermo. Il
  // nome accessibile che ne esce è la somma delle due `<label>` che lo puntano —
  // quella esterna («Scansione o foto del documento *») e quella che lo avvolge e
  // ne disegna la scatola («Seleziona un file» / il nome del file caricato) —
  // cioè che cos'è il campo E a che punto sta.
  const CONTROLLO_SINGOLO = ['text', 'number', 'email', 'phone', 'date', 'textarea', 'select', 'file']
  const associaLabel = CONTROLLO_SINGOLO.includes(field.type)
  /**
   * L'`id` dell'etichetta esterna — e serve ai GRUPPI, che senza di esso non
   * hanno nome affatto.
   *
   * MISURATO il 12/08/2026 sul passo «I tuoi dati» di `/anagrafica-personale`:
   * il `<div role="group">` delle tre caselle `gradi` («Fasce d'età su cui
   * lavori», campo OBBLIGATORIO) aveva `aria-label: null`, `aria-labelledby:
   * null` e solo `aria-describedby`, mentre la sua etichetta visibile era una
   * `<label>` senza `for` e senza controllo annidato — cioè legata a niente. Chi
   * ascolta sentiva «Nido (0-3), casella di controllo» senza aver mai sentito la
   * domanda, su un campo che decide quali funzioni vedrà nell'app. Lo stesso
   * valeva per `role="radiogroup"`.
   * `jest-axe` non lo vede: un `role="group"` senza nome non è una violazione
   * axe, ed è la ragione per cui i controlli automatici passavano lo stesso.
   *
   * Si lega con `aria-labelledby` e NON promuovendo il blocco a
   * `<fieldset>`/`<legend>`: questo componente rende una ventina di tipi diversi
   * con la stessa intestazione — asterisco dell'obbligatorietà compreso — e un
   * `fieldset` cambierebbe l'impaginatura di tutti per servirne due.
   */
  const idEtichetta = `${field.id}-label`
  // WCAG 2.1 AA, SC 1.3.5 «Identify Input Purpose»: lo scopo del campo lo
  // dichiara il TEMPLATE (`given-name`, `email`, `tel`, …) e da qui arriva al
  // controllo. Nessun campo lo dichiarava fino al 2026-08-11, e il prezzo lo
  // pagava chi compila dal telefono un modulo pubblico: sei campi digitati a
  // mano invece di un tocco. Omesso = nessun attributo, cioè il comportamento
  // di prima per ogni modello che non lo dichiara.
  const autoCompleteProps = field.autocomplete ? { autoComplete: field.autocomplete } : {}
  /** Un campo in errore si vede: bordo rosso a 1,5px invece del contorno di riposo. */
  const campoClasse = errMsg ? FIELD_BASE_ERRORE : FIELD_BASE

  // Blocchi non-input
  if (field.type === 'section_header') {
    return (
      <h3 className="text-lg font-semibold text-kidville-green pt-2 border-b border-kidville-green/15 pb-2">
        {field.label}
      </h3>
    )
  }
  if (field.type === 'paragraph') {
    return <p className="text-sm text-kidville-sub leading-relaxed">{field.label}</p>
  }
  if (field.type === 'signature') {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-card bg-kidville-green-light border border-kidville-green/20">
        <PenLine className="w-4 h-4 text-kidville-green flex-shrink-0 mt-0.5" />
        <p className="text-sm text-kidville-green/80">
          {field.label || t('firmaRichiesta')}
        </p>
      </div>
    )
  }

  // Blocco Consensi/Privacy (DL-029): una singola checkbox da accettare; se
  // obbligatorio il wizard blocca finché non è spuntata. L'accettazione viene
  // archiviata con snapshot del testo + timestamp lato server (consents_log).
  if (field.type === 'consent') {
    // ── IL CORPO DELL'INFORMATIVA È UNA DESCRIZIONE, NON UN NOME (12/08/2026) ──
    //
    // MISURATO sul passo «Informativa e dichiarazioni» di `/anagrafica-personale`,
    // con `label.textContent` sui tre consensi resi: il NOME ACCESSIBILE delle
    // caselle era lungo 564 · 292 · 379 caratteri, perché la `<label>` avvolgeva
    // titolo E corpo. Nessuna delle tre aveva un `id`, nessuna un
    // `aria-describedby`: il corpo non era agganciato come descrizione, era il
    // nome — e il titolo ci compariva DUE volte («Ho letto l'informativa sulla
    // privacy *Dichiaro di aver preso visione dell'informativa sul…»).
    // Chi ascolta, arrivando sulla casella, si sentiva leggere l'informativa
    // intera al posto di «Ho letto l'informativa sulla privacy, casella di
    // controllo, obbligatorio». Il nome è ciò che serve a DECIDERE, e stava
    // sepolto sotto la cosa su cui si decide.
    //
    // Il rimedio è strutturale, non un `aria-label` che rinomini il controllo:
    // il titolo resta nella `<label>` (quindi nome e testo a schermo restano la
    // stessa cosa) e il corpo esce dalla label in un nodo con `id`, puntato da
    // `aria-describedby`. Una descrizione si può saltare, un nome no.
    //
    // ── E LA MIRA SEGUE LA STESSA REGOLA ──────────────────────────────────────
    // Sempre misurato: la `<label>` occupava 328×373 / 328×211 / 328×279 px
    // contro una casella di 16×16, cioè fino a 477 volte l'area del controllo.
    // Tutto quel testo era cliccabile: provare a selezionare una riga
    // dell'informativa per rileggerla SPUNTAVA il consenso. È lo stesso difetto
    // già chiuso sul collegamento «Leggi l'informativa completa» (§9), e si
    // chiude allo stesso modo: fuori dalla label. Ora la card è un `<div>` che
    // disegna e basta — `cliccabile: false`, quindi senza `cursor-pointer` —, e
    // il comando è la riga del titolo.
    const descrizioneId = `${field.id}-descrizione`
    // L'ORDINE non è indifferente: `aria-describedby` viene letto nell'ordine
    // dichiarato, e il corpo è lungo fra i 292 e i 564 caratteri. Col messaggio
    // d'errore in coda, chi ascolta dovrebbe attraversare tutta l'informativa
    // prima di sapere perché il modulo non avanza: l'errore va per primo.
    const descriveConsenso =
      [errMsg ? errorId : null, field.text ? descrizioneId : null].filter(Boolean).join(' ') ||
      undefined
    return (
      <Controller
        name={field.id}
        control={control}
        defaultValue={false}
        rules={field.required ? { validate: (v) => v === true || t('devAccettare') } : undefined}
        render={({ field: rhf }) => {
          const accettato = rhf.value === true
          return (
            // ⚠️ `space-y-2` E NON PIÙ `space-y-1.5` (25/08/2026), e la ragione è
            // cambiata nel corso della stessa giornata — vale la pena scriverlo,
            // perché il primo motivo era di per sé un difetto.
            //
            // AL MATTINO: `CollegamentoInformativa` portava un `-mt-3.5` tarato su
            // UNA sola delle due pile in cui il componente vive, e questa riga
            // serviva a far concordare l'altra. Cioè un componente foglia pretendeva
            // un valore preciso dal proprio genitore, in tre moduli diversi.
            // ADESSO: il collegamento allarga il bersaglio con uno `::before`
            // assoluto e non porta più nessun margine. Nessun contenitore deve
            // essere d'accordo con lui, e questa riga non è più una taratura.
            //
            // Resta `space-y-2` perché 8 px è il ritmo che il resto del modulo usa
            // già, e perché la distanza determina quanto dello pseudo-elemento entra
            // nel vicino di sopra: con 8 px sono 6 px dentro il riempimento inferiore
            // della card — la stessa cifra accettata e scritta per la nota del campo,
            // e su una fascia in cui la card non ha né testo né comandi.
            <div className="space-y-2">
              {/* La card disegna, non comanda: `cliccabile: false` le toglie il
                  `cursor-pointer` e nient'altro — contorno, fondo, raggio e stato
                  d'errore restano quelli di ogni altra card di scelta.
                  Il figlio è UNO: così il `gap-3` della geometria non si applica e
                  l'impaginazione resta identica a quella misurata (titolo a filo
                  del contorno, corpo a 4px sotto e rientrato di 28px, cioè
                  esattamente dove stava quando era annidato nella label). */}
              <div
                {...propsScelta(accettato, {
                  allineamento: 'items-start',
                  nonValido: Boolean(errMsg),
                  cliccabile: false,
                })}
              >
                <div className="w-full min-w-0">
                  {/* IL COMANDO È QUESTA RIGA. `-my-1.5 py-1.5` la porta a 32px di
                      altezza senza spostare di un pixel né il titolo né il corpo
                      (il riempimento entra, il margine negativo lo restituisce al
                      flusso): sopra i 24×24 di WCAG 2.2 §2.5.8, che i 16×16 della
                      sola casella non raggiungono. */}
                  <label
                    htmlFor={field.id}
                    className="-my-1.5 flex w-full items-start gap-3 py-1.5 cursor-pointer"
                  >
                    <input
                      id={field.id}
                      type="checkbox"
                      checked={accettato}
                      onChange={e => rhf.onChange(e.target.checked)}
                      name={rhf.name}
                      // Senza questo `ref` il nodo non entra nel registro di RHF e
                      // `setFocus(id)` non trova nulla da mettere a fuoco: misurato
                      // l'11/08/2026 al passo dei consensi, dove premendo «Avanti»
                      // senza la spunta obbligatoria il fuoco restava sul bottone
                      // mentre al passo 2 (campi registrati con `register`) andava
                      // correttamente sul primo campo in errore. Vale per ogni
                      // controllo disegnato dentro un `Controller`.
                      ref={rhf.ref}
                      onBlur={rhf.onBlur}
                      className={`${SCELTA_CONTROLLO} mt-0.5`}
                      // NON `{...ariaProps}`: la descrizione di questo campo non è
                      // né l'errore né una nota di `NOTE_DEI_CAMPI`, è
                      // `descriveConsenso` — il TESTO del consenso, più l'errore
                      // quando c'è. (Fino al 2026-08-25 qui c'era scritto che
                      // `ariaProps` porta «il solo messaggio d'errore»: vero fino al
                      // 24/08, poi `descrizioni` ha cominciato a concatenargli la
                      // nota. La ragione di non usarlo resta, la frase che la
                      // spiegava no.)
                      aria-invalid={errMsg ? true : undefined}
                      aria-describedby={descriveConsenso}
                      // L'obbligatorietà detta anche a chi non vede l'asterisco.
                      aria-required={field.required || undefined}
                    />
                    {/* Gerarchia ricostruita con ciò che il rimappaggio pubblico NON tocca.
                        `.kv-public [class*="text-kidville-green/"]` porta a #006A5F pieno sia
                        `/90` sia `/70`: titolo e corpo del consenso finivano identici per
                        colore, e restavano 14px/500 contro 14px/400. Quella regola è giusta
                        (chiudeva un 3,96:1) e resta: qui cambia il TOKEN — titolo `green`
                        semigrassetto, corpo `sub` (5,82:1 su crema, 6,46:1 su bianco). */}
                    <span className="text-sm text-kidville-green">
                      <span className="font-semibold">
                        {field.label}
                        {field.required && <span className="text-kidville-green"> *</span>}
                      </span>
                    </span>
                  </label>
                  {field.text && (
                    // ── LA MISURA IN CARATTERI NON SI SCRIVE IN `ch` (11/08/2026) ──
                    // Qui c'era `max-w-[60ch]`, messo per scendere sotto i 78-80
                    // caratteri per riga. Non ci scendeva: `ch` è la larghezza
                    // dello ZERO, e in Maven Pro lo zero è più largo della
                    // minuscola media. MISURATO a 1456px con un `Range` sul nodo
                    // di testo, riga per riga: 85 · 86 · 87 · 75 · 74 — massimo
                    // 87, cioè PIÙ degli 82 che il vincolo doveva correggere,
                    // perché 60ch valevano 542,64px e in 542,64px ci stanno 87
                    // caratteri. Un vincolo che dichiarava un numero e ne
                    // produceva un altro.
                    // Ora la misura è in rem e il numero qui sotto è quello
                    // MISURATO dopo la modifica, non quello sperato:
                    // 29rem = 464px → massimo 74 caratteri per riga.
                    //
                    // ⚠️ Il rientro è `ml-7` e NON `pl-7`: con `box-sizing:
                    // border-box` (preflight di Tailwind) il riempimento starebbe
                    // DENTRO i 29rem e la riga scenderebbe a ~70 caratteri, cioè
                    // il vincolo tornerebbe a dichiarare un numero e a produrne un
                    // altro. Il margine no. 28px = casella 16 + `gap-3` 12: il
                    // corpo resta allineato sotto il titolo, dove stava prima.
                    <p
                      id={descrizioneId}
                      className="ml-7 mt-1 block max-w-[29rem] text-sm text-kidville-sub leading-relaxed"
                    >
                      {field.text}
                    </p>
                  )}
                </div>
              </div>
              {/* ── L'INFORMATIVA È UN BERSAGLIO, NON UNA POSTILLA (11/08/2026) ──
                  Era un `<a>` alto 16px DENTRO la <label> del consenso: chi lo
                  manca col pollice colpisce un bersaglio alto 325px che fa
                  un'altra cosa (spunta la casella). Il `stopPropagation` teneva
                  corretto il comportamento, non la mira — e WCAG 2.2 §2.5.8
                  chiede 24×24px, senza l'eccezione «inline» perché il
                  collegamento sta su una riga sua. È anche l'unica via verso
                  l'informativa privacy su un modulo che raccoglie dati personali.
                  Fuori dalla <label> anche per una ragione di specifica: «i
                  discendenti di label non devono includere contenuto interattivo
                  diverso dal controllo etichettato».
                  Il riempimento verticale gli dà 44px, la stessa altezza dei
                  comandi principali del wizard.
                  `LinkInterno` e non `<a target="_blank">`: nella WebView di
                  Capacitor una scheda nuova non esiste e il sistema consegna
                  l'indirizzo a Safari — il genitore che sta leggendo come
                  vengono trattati i dati di suo figlio si ritrova fuori
                  dall'app. Stesso rimedio già applicato allo stesso testo in
                  `ComunicaAssenzaCard` (R25). Solo per gli indirizzi INTERNI:
                  un `link` esterno dichiarato dal template resta un `<a>`. */}
              {/* ── L'ERRORE PRIMA DEL LINK, QUI COME NEL RAMO GENERICO (25/08/2026)
                  Fino a stamattina questo ramo rendeva link-poi-errore e il ramo
                  generico errore-poi-link: lo STESSO componente impaginava la
                  stessa coppia in due modi, a 270 righe di distanza e nello stesso
                  wizard (il consenso al passo 4, il curriculum al passo 3). Un
                  sistema di design ha UNA risposta alla domanda «dove va il
                  messaggio d'errore rispetto al resto della pila», e la risposta
                  giusta è quella del ramo generico: l'errore è la cosa urgente e
                  sta il più vicino possibile al controllo. Il collegamento chiude
                  il blocco.
                  ⚠️ Restando DOPO `errMsg` resta comunque FUORI dalla <label> del
                  consenso, che è il vincolo del blocco qui sopra. */}
              {/* ⚠️ L'`else` NON È UN `null`: quando il messaggio se ne va, il
                  suo spazio resta all'ombra. È la correzione del difetto WebKit
                  misurato su questo stesso campo — la catena, i pixel e le tre
                  ragioni di forma stanno sulla dichiarazione di `OmbraErrore`. */}
              {errMsg ? (
                <p id={errorId} role="alert" className={ERRORE_CLASSI}>
                  <AlertCircle className="w-3.5 h-3.5" />
                  {errMsg}
                </p>
              ) : ombraErrore ? (
                <OmbraErrore testo={ombraErrore} classiIcona="w-3.5 h-3.5" />
              ) : null}
              {/* ⚠️ LO STESSO RIPIEGO DEL RAMO DI CAMPO, E FINO AL 25/08 ERANO DUE.
                  Qui si ripiegava su `leggiInformativa` («Leggi l'informativa» /
                  «Read the policy»), il ramo generico su `leggiInformativaCompleta`:
                  due rami dello stesso componente, due frasi per lo stesso
                  collegamento. Finché i tre template cablavano `link_label` la
                  divergenza non si vedeva in italiano — e si vedeva in inglese,
                  dove sotto una pagina inglese compariva una riga italiana.
                  Tolti i `link_label`, senza questa riga la resa italiana dei
                  consensi sarebbe peggiorata: da «Leggi l'informativa completa»
                  a «Leggi l'informativa», cioè una regressione introdotta da una
                  pulizia. Una sola chiave per un solo collegamento.
                  ⚠️ E LA RESA ITALIANA È CAMBIATA LO STESSO, va detto invece che
                  lasciato dedurre: i tre `link_label` dicevano «Leggi l'informativa
                  completa», la chiave dice «Leggi l'informativa completa sulla
                  privacy». Due parole in più, comprate per il collegamento NUOVO —
                  quello sotto il curriculum, dove «privacy» non compare altrove nel
                  passo — e pagate qui, dove l'etichetta del consenso la nomina già
                  (fra le due righe stanno però i 440 caratteri della dichiarazione,
                  misurati: non sono una sotto l'altra). Il prezzo è questo, ed è
                  stato scelto: una sola resa per un solo collegamento vale più di
                  due parole risparmiate in un punto. */}
              {field.link && (
                <CollegamentoInformativa
                  href={field.link}
                  etichetta={field.link_label || t('leggiInformativaCompleta')}
                />
              )}
            </div>
          )
        }}
      />
    )
  }

  return (
    <div className="space-y-2">
      <label
        id={idEtichetta}
        htmlFor={associaLabel ? field.id : undefined}
        className="flex items-center gap-1.5 text-sm font-medium text-kidville-green/80"
      >
        {field.label}
        {field.required && <span className="text-kidville-green">*</span>}
      </label>

      {/* Testo / numero / email / telefono */}
      {['text', 'number', 'email', 'phone'].includes(field.type) && (
        isProvinceField(field) ? (
          // Campo PROVINCIA: digitazione libera (i nomi per esteso devono essere
          // scrivibili) con auto-MAIUSCOLO; su blur `normalizzaProvincia` riduce
          // il nome riconosciuto alla sigla ("Napoli" → "NA", "na" → "NA"). Un
          // valore irriconoscibile NON viene indovinato: resta e la validazione lo
          // blocca con messaggio chiaro. Il valore che parte è sempre sigla o bloccato.
          <Controller
            name={field.id}
            control={control}
            defaultValue=""
            rules={rules}
            render={({ field: rhf }) => (
              <input
                id={field.id}
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                // LO SCOPO SI DICHIARA — e il ripiego non dice il contrario.
                // `off` vale per un template che NON dichiara niente: senza uno
                // scopo dichiarato il suggerimento del browser è un valore
                // qualunque, e questo campo ha una regola sua (si scrive per
                // esteso e si riduce a sigla su blur). Quando il template dice
                // `address-level1` lo scopo È noto, e dichiararlo è ciò che
                // SC 1.3.5 chiede: le due frasi parlano di due casi diversi.
                //
                // ⚠️ E NON si aggiunge `maxlength`, per quanto il template
                // dichiari `max_length: 2`. MISURATO l'11/08/2026: «Campania»
                // troncata a due lettere fa «CA», cioè Cagliari — un dato
                // sbagliato accettato in silenzio; lasciata intera fa `null`,
                // cioè un errore visibile e correggibile. Un valore che
                // l'autofill può davvero scrivere qui viene dall'elenco delle
                // province italiane (in Chromium l'admin area per l'Italia è
                // quell'elenco: chiave = sigla, nome = provincia) e tutte e 107
                // sono riconosciute in entrambe le forme — collaudi (m) e (n) di
                // `__tests__/components/FieldRenderer-validation.test.tsx`.
                autoComplete={field.autocomplete ?? 'off'}
                placeholder={field.placeholder}
                className={campoClasse}
                name={rhf.name}
                ref={rhf.ref}
                value={typeof rhf.value === 'string' ? rhf.value : ''}
                onChange={e => rhf.onChange(e.target.value.toUpperCase())}
                onBlur={() => {
                  const sigla = normalizzaProvincia(rhf.value)
                  if (sigla && sigla !== rhf.value) rhf.onChange(sigla)
                  rhf.onBlur()
                }}
                {...ariaProps}
              />
            )}
          />
        ) : (
          <input
            id={field.id}
            type={field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
            placeholder={field.placeholder}
            className={campoClasse}
            {...autoCompleteProps}
            {...ariaProps}
            {...register(field.id, rules)}
          />
        )
      )}

      {/* Nessun `[color-scheme:light]` sui campi qui sotto: dal 2026-09-04 lo
          schema chiaro e dichiarato una volta sola su `html` in globals.css,
          per tutti i 463 input e i 152 select dell'app. Non riaggiungerlo per
          un campo solo: era proprio la toppa locale che nascondeva la causa. */}
      {field.type === 'date' && (
        <input id={field.id} type="date" className={campoClasse} {...autoCompleteProps} {...ariaProps} {...register(field.id, rules)} />
      )}

      {field.type === 'textarea' && (
        <textarea
          id={field.id}
          rows={4}
          placeholder={field.placeholder}
          className={`${campoClasse} resize-none`}
          {...autoCompleteProps}
          {...ariaProps}
          {...register(field.id, rules)}
        />
      )}

      {field.type === 'select' && (
        <SelectField
          field={field}
          control={control}
          register={register}
          rules={rules}
          bordo={errMsg ? BORDO_ERRORE : BORDO_OK}
          ariaProps={ariaProps}
          autoCompleteProps={autoCompleteProps}
        />
      )}

      {field.type === 'radio' && (
        <RadioGroup
          field={field}
          control={control}
          register={register}
          rules={rules}
          ariaOpzione={ariaOpzione}
          etichettaId={idEtichetta}
          descriveGruppo={descrizioni || undefined}
          obbligatorio={field.required}
          nonValido={Boolean(errMsg)}
        />
      )}

      {field.type === 'checkbox' && (
        <Controller
          name={field.id}
          control={control}
          rules={rules}
          defaultValue={[]}
          render={({ field: rhf }) => {
            const value: string[] = Array.isArray(rhf.value) ? rhf.value : []
            // ⚠️ IL ROSSO GUARDA IL GRUPPO, NON IL MESSAGGIO. Il modulo valida
            // in `mode: 'onTouched'`: dopo un «Avanti» fallito il messaggio
            // resta finché il gruppo non viene rivalidato (blur o «Avanti»
            // successivo), quindi legandogli il contorno si otterrebbero due
            // card ROSSE accanto a una spuntata — cioè un allarme su un gruppo
            // che nel frattempo è diventato valido. Il rosso dice «qui non hai
            // ancora scelto niente», e sparisce alla prima spunta.
            const vuoto = value.length === 0
            return (
              <div
                className="space-y-2"
                role="group"
                // Il nome del gruppo È l'etichetta che sta a schermo: vedi
                // `idEtichetta`. Senza, chi ascolta entra nelle caselle senza
                // aver mai sentito la domanda.
                aria-labelledby={idEtichetta}
                // La descrizione del GRUPPO: il messaggio d'errore e, se c'è, la
                // nota del campo — che fino al 2026-08-25 stava invece su ognuna
                // delle opzioni, cioè si annunciava tante volte quante le caselle.
                aria-describedby={descrizioni || undefined}
              >
                {(field.options ?? []).map((opt, i) => {
                  const checked = value.includes(opt.value)
                  return (
                    <label key={i} {...propsScelta(checked, { nonValido: Boolean(errMsg) && vuoto })}>
                      <input
                        type="checkbox"
                        checked={checked}
                        className={SCELTA_CONTROLLO}
                        name={rhf.name}
                        // Solo sulla PRIMA opzione: `setFocus(id)` cerca un nodo
                        // solo, e il gruppo comincia da qui. Vedi il blocco
                        // `consent` per la misura che ha portato a questo.
                        ref={i === 0 ? rhf.ref : undefined}
                        onBlur={rhf.onBlur}
                        // `ariaOpzione`, NON `ariaProps`: l'obbligo e la nota sono
                        // del gruppo. Vedi la testata dei due oggetti.
                        {...ariaOpzione}
                        onChange={e =>
                          rhf.onChange(
                            e.target.checked
                              ? [...value, opt.value]
                              : value.filter(v => v !== opt.value)
                          )
                        }
                      />
                      <span className={`text-sm text-kidville-green ${checked ? 'font-semibold' : ''}`}>
                        {opt.label}
                      </span>
                    </label>
                  )
                })}
              </div>
            )
          }}
        />
      )}

      {field.type === 'file' && (
        <Controller
          name={field.id}
          control={control}
          rules={rules}
          defaultValue=""
          render={({ field: rhf }) => (
            <FileField
              modelId={modelId}
              value={rhf.value}
              onChange={rhf.onChange}
              uploadEndpoint={uploadEndpoint}
              accept={field.accept}
              maxSizeMb={field.max_size_mb}
              // Le quattro cose che facevano di questo campo l'unico irraggiungibile
              // da tastiera: l'`id` (che l'etichetta esterna punta), gli attributi
              // dell'errore, il `ref` di react-hook-form — senza il quale
              // `setFocus(id)` non ha niente da mettere a fuoco — e il `blur`.
              fieldId={field.id}
              // L'etichetta umana, che il bottone «Scatta foto» usa per dire DI QUALE
              // campo è: al passo «Documento» ce ne sono due, fronte e retro.
              etichettaCampo={field.label}
              ariaProps={ariaProps}
              // …e il quinto: che il riquadro CAMBI ASPETTO quando è in errore.
              // Era l'unico campo del modulo che non lo faceva (vedi `nonValido`).
              //
              // ⚠️ `&& !caricamentoInVolo`, e questo pezzo è arrivato dopo. Il
              // 25/08/2026, con l'upload rallentato a 3,5 s, il riquadro mostrava
              // MENTRE IL FILE SALIVA un bordo pieno rosso più l'anello rosso: la
              // vernice dell'errore addosso a chi sta facendo esattamente la cosa
              // giusta, e per giunta un attimo dopo averla già letta una volta —
              // il percorso che l'obbligo apre a tutti è «premi Avanti → ti dice
              // di allegare → alleghi». La FRASE sotto il campo era già stata
              // corretta e il colore no: uno dei due segnali diceva ancora
              // «sbagliato». Un sistema con tre stati (riposo · attesa · errore)
              // non ne dipinge due con la stessa tinta.
              // Se il caricamento fallisce, `caricamentoInVolo` torna falso e
              // l'errore riappare da sé: qui non si nasconde niente, si aspetta.
              nonValido={Boolean(errMsg) && !caricamentoInVolo}
              inputRef={rhf.ref}
              onBlur={rhf.onBlur}
              // …e il sesto: che «sto caricando» esca da `FileField` invece di
              // restare chiuso lì dentro (vedi `caricamentoInVolo`).
              onCaricamento={setCaricamentoInVolo}
              // …e il settimo: il NOME del file, per il riepilogo, che questo campo
              // non lo vede perché a quel punto è smontato (vedi `onNomeFile`).
              onNomeFile={onNomeAllegato}
              // …e l'ottavo, che è il verso di ritorno del settimo: il nome che il
              // chiamante ha conservato torna DENTRO quando il campo si rimonta.
              nomeIniziale={nomeAllegatoIniziale}
            />
          )}
        />
      )}

      {/* `font-bold` non è enfasi: è il SECONDO segnale, quello che sopravvive
          all'Alto Contrasto. Là il messaggio diventa #000000 su bianco — 21:1,
          identico a un'etichetta qualunque — e il colore smette di dire «errore».
          Il peso resta, e con lui il bordo doppio del campo (globals.css). */}
      {/* ── E L'ATTESA NON SI DIPINGE COME UN ERRORE (25/08/2026) ─────────────
          Il nodo è lo stesso — è la risposta all'«Avanti» appena premuto, quindi
          resta un `role="alert"`: chi ha premuto deve sapere perché non è
          successo niente, e deve saperlo anche se non guarda. A cambiare è ciò
          che il nodo DICE di se stesso. MISURATO col caricamento rallentato a
          3,5 s: `error-strong` (#C62828), peso 700 e l'icona `AlertCircle`
          addosso a un messaggio il cui contenuto era «aspetta», sull'unico campo
          che blocca il passo. Ora l'attesa porta il tono della nota
          (`kidville-sub`, peso normale) e la rotellina che gira già nel riquadro:
          i due segnali del campo — vernice e icona — tornano a dire la stessa
          cosa del testo.
          ⚠️ `font-bold` e `error-strong` restano SULL'ERRORE VERO, e non sono
          decorazione: il peso è il secondo segnale, quello che sopravvive
          all'Alto Contrasto, dove il messaggio diventa #000000 su bianco — 21:1,
          identico a un'etichetta qualunque — e il colore smette di dire
          «errore». */}
      {/* ⚠️ Il ramo `else` è l'OMBRA, non il vuoto: lo spazio che il messaggio
          ha occupato resta riservato finché il campo vive, altrimenti la sua
          scomparsa sposta i comandi sotto le dita di chi sta correggendo. La
          misura, la catena su WebKit e le ragioni di forma stanno sulla
          dichiarazione di `OmbraErrore`. Qui vale identico al ramo del
          consenso: è lo stesso componente, e su questa stessa pila i due rami
          hanno già raccontato la stessa cosa in due modi una volta
          (25/08/2026, §9 dei test degli stati visivi). */}
      {errMsg ? (
        <p
          id={errorId}
          role="alert"
          className={`${ERRORE_IMPAGINAZIONE} ${
            caricamentoInVolo ? 'text-kidville-sub' : ERRORE_TONO
          }`}
        >
          {caricamentoInVolo ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          {/* Il MESSAGGIO, non la regola: vedi `caricamentoInVolo` in testa. */}
          {caricamentoInVolo ? t('attendiCaricamento') : errMsg}
        </p>
      ) : ombraErrore ? (
        <OmbraErrore testo={ombraErrore} classiIcona="w-3.5 h-3.5 shrink-0" />
      ) : null}

      {/* ── LA NOTA DEL CAMPO, SUBITO SOTTO IL CAMPO ────────────────────────────
          Il posto in cui sta è metà del suo valore: è la coppia «controllo → testo
          che lo spiega», la regola di prossimità che questo modulo rispetta
          ovunque. Il collegamento all'informativa viene DOPO, non prima — vedi la
          prop `nota` in testa per la misura (58 px, 82 in errore) che ha portato
          qui il `<p>` che fino a stamattina rendeva il wizard.
          Niente `mt-*`: la distanza la dà lo `space-y-2` del blocco, come per il
          messaggio d'errore. Una spaziatura scritta a mano qui vorrebbe dire tre
          distanze diverse (8 · 6 · 6 px) dentro la stessa pila, che è esattamente
          ciò che smette di raggruppare. */}
      {nota && (
        <p id={notaId} className="text-xs text-kidville-sub">
          {nota}
        </p>
      )}

      {/* ── L'INFORMATIVA AL PUNTO DI RACCOLTA, ANCHE FUORI DAI CONSENSI (25/08/2026)
          Fino a oggi `field.link` esisteva su `FormField` ma lo rendeva SOLO il
          ramo `consent` (riga ~643): un template che lo dichiarava su un altro
          tipo di campo non otteneva niente, e non otteneva niente in silenzio.
          Costava poco finché l'unico dato che partiva prima dei consensi era
          nessuno.

          Non è più così. Il curriculum di `/lavora-con-noi` NON viaggia con
          l'invio: `FileField` chiama la rotta di caricamento dentro `onChange`,
          quindi il documento è già sul nostro server due passi prima della
          schermata dei consensi — l'unico posto in cui l'informativa era
          raggiungibile. Finché il campo era facoltativo restava una strada
          (saltare l'allegato, leggere, tornare indietro) e la percorrevano
          quattro su dieci (la cifra, con la sua ora, sta nell'àncora `MISURA-CV`
          in `src/lib/forms/insegnanti-template.ts`).
          Dal 24/08 il campo è obbligatorio e quella strada non c'è
          più. L'art. 13 parla del momento in cui i dati sono OTTENUTI: per un
          allegato quel momento è il caricamento, non l'invio.

          Il rimedio è una riga qui e una `link: '/privacy'` nel template, non un
          secondo componente: stesso `CollegamentoInformativa`, stesso bersaglio
          da 44px, etichetta dal catalogo invece che cablata. Chi domani
          dichiarasse `link` su un campo qualunque otterrà ciò che ha scritto
          invece del silenzio di prima.

          ⚠️ IL RIPIEGO È `leggiInformativaCompleta`, NON `leggiInformativa`, e la
          differenza si è pagata due volte in un giorno. Il ripiego generico dice
          «Leggi l'informativa» / «Read the policy» — e in inglese chiede «quale
          policy?», in un punto dove la parola «informativa» non compare da
          nessun'altra parte del passo. Per evitarlo si era cablata l'etichetta
          italiana nel template, cioè si era pagata la lingua per comprare la
          chiarezza: sotto una nota inglese compariva «Leggi l'informativa
          completa». C'era una terza strada, ed è questa — una chiave nei due
          cataloghi, con le stesse parole delle altre dichiarazioni. */}
      {field.link && (
        <CollegamentoInformativa
          href={field.link}
          etichetta={field.link_label || t('leggiInformativaCompleta')}
        />
      )}
    </div>
  )
}

/**
 * Il collegamento all'informativa del consenso — un bersaglio da 44px, fuori
 * dalla <label> che spunta la casella (vedi il commento nel blocco `consent`).
 *
 * Due strade, e la scelta è sull'INDIRIZZO, non sulla piattaforma: un percorso
 * interno (`/privacy`) passa da `LinkInterno`, che nel guscio Capacitor naviga
 * dentro l'app invece di consegnare l'indirizzo a Safari; un indirizzo esterno
 * dichiarato dal template resta un `<a target="_blank">`, perché lì uscire È il
 * comportamento giusto.
 *
 * ── E PESA QUANTO UNA NOTA, NON QUANTO UN'ETICHETTA (25/08/2026) ─────────────
 *
 * Era `text-sm font-medium`, cioè — MISURATO nella pagina viva, 900 px, passo 3 di
 * `/lavora-con-noi` — 14 px / peso 500 / #006A5F / sottolineato / con icona: la
 * stessa resa dell'ETICHETTA «Curriculum *» (14 px / 500 / #006A5F) più una
 * sottolineatura, e PIÙ GRANDE del messaggio d'errore (12 px / 700 / #C62828).
 * Nell'unico campo che blocca il passo l'ordine di lettura per peso visivo era
 * link → errore → nota: un rimando legale a piè di campo urlava più forte del
 * campo a cui appartiene e più forte della ragione per cui non si prosegue.
 *
 * Ora è 12 px a peso normale: sotto l'errore (che resta l'unico in grassetto e in
 * rosso) e alla pari della nota, che è il suo vicino di riga.
 *
 * ⚠️ IL COLORE RESTA IL VERDE, e non diventa il grigio della nota. In questo
 * prodotto il verde È l'affordance del collegamento: un link grigio, in mezzo a
 * testo grigio della stessa taglia, si legge come testo spento. La gerarchia la
 * fanno taglia e peso, che sono già scesi; il colore dice «questo si preme», ed è
 * anche l'unica via all'informativa da un passo che i dati li ha già spediti.
 *
 * ── IL BERSAGLIO DA 44 px STA FUORI DAL FLUSSO (25/08/2026, quarto giro) ─────
 *
 * Il bersaglio deve essere 44 px (WCAG 2.2 §2.5.8, e la stessa altezza dei
 * comandi del wizard) su una riga di testo alta 16. I 28 px mancanti sono stati
 * per mezza giornata `py-3.5` + `-mt-3.5`, cioè riempimento nel flusso più una
 * compensazione a margine negativo. Erano sbagliati in due modi, ed entrambi
 * MISURATI, non dedotti.
 *
 *  1. IL BERSAGLIO NON ERA 44: ERA 38. A 390 px, sondando con
 *     `document.elementFromPoint` un pixel alla volta lungo l'asse del link, la
 *     SCATOLA andava da y=451,5 a y=495,5 — 44 px esatti, come dichiarato — ma
 *     dal 451 al 457 rispondeva il `<p>` della nota, e la `<a>` solo dal 458 in
 *     giù. Trentotto, cioè meno dei 40 px da cui la vecchia stesura di questo
 *     commento metteva in guardia. Il motivo sta nell'ordine di pittura: un box
 *     di blocco non posizionato si dipinge alla fase 4, il contenuto inline del
 *     vicino alla fase 7, e il hit-test segue la pittura. `getBoundingClientRect`
 *     diceva 44 e il hit-test 38: fra i due ha ragione il secondo.
 *  2. IL -14 px LEGAVA QUESTO COMPONENTE AL SUO CONTENITORE. La prova è che per
 *     farlo tornare si era dovuto accordare lo `space-y-*` del ramo `consent`,
 *     cioè un ALTRO punto del file. Un componente foglia che pretende un valore
 *     preciso dal genitore non è un componente del sistema: è una taratura, e
 *     vive in tre moduli (`/lavora-con-noi`, `/iscrizione`, `/anagrafica-personale`).
 *
 * Quindi l'ingrandimento esce dal modello a scatole: la `<a>` è alta quanto il
 * suo testo — nessun contenitore deve più essere d'accordo con lei, e la distanza
 * la dà lo `space-y-*` come per ogni altro anello della pila — e i 44 px li dà uno
 * `::before` assoluto a ±14 px. Essendo su un elemento POSIZIONATO (`relative`) si
 * dipinge in fase 8, cioè sopra il testo del vicino, e il bersaglio è suo davvero.
 * Lo schema è già in casa: `AvvisoCard.tsx` allarga così l'area della card
 * (`after:absolute after:inset-0 after:content-['']`).
 * MISURATO dopo la correzione, stessa sonda: 44 px su 44, in tutte e due i rami.
 *
 * ⚠️ RESTA `flex w-fit` E NON `inline-flex`, e la ragione è cambiata insieme al
 * rimedio: non più i margini (non ce ne sono più), ma la larghezza. `w-fit` tiene
 * la `<a>` larga quanto il testo, e `before:inset-x-0` fa sì che lo pseudo-elemento
 * erediti quella larghezza invece di prendersi tutta la colonna.
 *
 * ── L'EFFETTO SUGLI ALTRI DUE MODULI, MISURATO E NON DEDOTTO (25/08/2026) ────
 *
 * Questo è un componente CONDIVISO: vive anche nei consensi di `/iscrizione` e di
 * `/anagrafica-personale`, che non erano nel perimetro del lavoro sul curriculum.
 * Un rilievo del quinto giro ha chiesto conto di ciò che cambia là dentro. La
 * risposta è misurata sul ramo `consent` — lo stesso identico codice che quei due
 * moduli percorrono — raggiunto in Chromium al passo 4 di `/lavora-con-noi` con la
 * rotta di caricamento intercettata (`.env.local` punta allo Storage di
 * PRODUZIONE: nessun file è stato caricato davvero). A 390 px:
 *
 *  · TAGLIA E PESO. Da 14 px / 500 a 12 px / 400. È lo stesso difetto che il
 *    paragrafo qui sopra descrive sul curriculum — un rimando legale che pesava
 *    come l'etichetta del campo e più del messaggio d'errore — e nei consensi
 *    pesava uguale: là il vicino è una card di dichiarazione, e il link le urlava
 *    sopra. Quei due moduli ci guadagnano per la stessa ragione, non per caso.
 *  · BERSAGLIO. 44 px prima (`py-3` nel flusso) e 44 px adesso (`::before` a
 *    ±14 px): invariato come CIFRA, e non più a spese del flusso. MISURATO col
 *    hit-test, non con `getBoundingClientRect`: scatola 442→458, bersaglio
 *    428→471 = 44 px pieni.
 *  · CHI PERDE I 14 px SOPRA. `document.elementsFromPoint`, un pixel alla volta,
 *    lungo l'asse del link: 6 righe cadono nel riempimento inferiore della card
 *    del consenso e 8 nel vuoto dello `space-y-2`. Elementi interattivi in quella
 *    fascia: ZERO — la `<label>` che spunta la casella sta più in alto e non è
 *    mai fra i candidati. Il costo massimo è un tocco che apre l'informativa.
 *  · ETICHETTA. In italiano da «Leggi l'informativa completa» (cablata nei
 *    template) a `leggiInformativaCompleta` del catalogo, che nomina anche il
 *    documento. In INGLESE è il guadagno vero: quei due moduli mostravano una
 *    riga italiana dentro una pagina inglese, e adesso no. Il blocco del consenso
 *    resta misto perché label e testo dei consensi sono cablati in italiano —
 *    debito dichiarato in testa ai template, e non è questo componente a poterlo
 *    chiudere. MISURATO con `KV_LOCALE=en`: nella stessa schermata la legenda
 *    dice «* required field» e i comandi «Next», quindi rimettere l'etichetta
 *    italiana non renderebbe il blocco «di nuovo coerente»: aggiungerebbe una
 *    seconda stringa italiana a una pagina inglese.
 *
 * ⚠️ E I 6 px CHE LO PSEUDO-ELEMENTO SI PRENDE SOPRA DI SÉ SONO NOTI E VOLUTI:
 * 14 px di allargamento contro 8 px di `space-y-2` lasciano 6 px dentro il vicino
 * di sopra — la coda dell'ultima riga della nota, oppure il riempimento inferiore
 * della card del consenso. Nessuno dei due è interattivo, quindi il costo è al
 * massimo un tocco che apre l'informativa, ed è lo stesso 6 px che il ramo
 * `consent` aveva già accettato e scritto. L'alternativa senza sovrapposizione
 * (±8 px, cioè 32 px di bersaglio) sarebbe più piccola dei 38 px di oggi: si
 * chiuderebbe il rilievo peggiorando la misura che l'ha fatto nascere.
 */
function CollegamentoInformativa({ href, etichetta }: { href: string; etichetta: string }) {
  const classe =
    "relative flex w-fit items-center gap-1.5 text-xs text-kidville-green underline " +
    "before:absolute before:inset-x-0 before:-inset-y-3.5 before:content-['']"
  const contenuto = (
    <>
      {etichetta}
      <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
    </>
  )
  /*
   * ── IL PRIMO CLIC NON SI PERDE, ANCHE QUI (25/08/2026) ──────────────────────
   *
   * Stessa riga, stessa catena e stessa dottrina dei due comandi del wizard: il
   * perché per intero — `mode: 'onTouched'`, il blur che fa nascere il messaggio,
   * il bersaglio che scende FRA la pressione e il rilascio, e il prezzo del fuoco
   * che non si sposta più col puntatore — sta nel blocco «IL PRIMO CLIC NON SI
   * PERDE» di `src/components/features/public/wizard/pezzi-wizard-pubblico.tsx`.
   * Là era stata applicata ai due bottoni e NON a questo collegamento, che vive
   * nello stesso flusso, sotto lo stesso `useForm`, e — da quando il curriculum è
   * obbligatorio — subito sotto un campo che al blur produce un errore.
   *
   * MISURATO in Chromium su `/lavora-con-noi` a 1280×950 e a 390×844, in
   * entrambi i punti in cui questo componente compare:
   *     passo 3 · mousedown@A → mouseup@P#cv_path-nota                    → click@DIV
   *     passo 4 · mousedown@A → mouseup@P#presa_visione_informativa-error → click@DIV
   * Spostamento 24 px, schede aperte al PRIMO clic: zero. Al secondo: una.
   *
   * ⚠️ UN LINK NON È UN BOTTONE, e il prezzo in più è stato misurato prima di
   * scegliere questa strada invece di un'altra:
   *   · SELEZIONE DEL TESTO: invariata, perché non esiste nemmeno adesso. Una
   *     `<a href>` è trascinabile di suo e il trascinamento nativo vince sulla
   *     selezione — verificato con un controllo positivo sulla stessa sonda (lo
   *     stesso gesto sul `<p>` della nota, due righe più su, seleziona).
   *   · TASTO CENTRALE e CMD-CLIC: non solo intatti, RIPARATI. Senza questa riga
   *     si perdevano anche loro (`auxclick`/`click` mai emessi sul link): il
   *     bersaglio si sposta allo stesso modo per tutti e tre i bottoni.
   *   · TRASCINARE IL LINK verso i preferiti o un'altra finestra: questo sì, si
   *     perde — `dragstart` non parte più. È l'unico prezzo, ed è dichiarato.
   * Il presidio in jsdom (che il difetto non può vederlo: non ha layout) è
   * `__tests__/components/FieldRenderer-stati-visivi.test.tsx` §12 (j), su
   * entrambi i rami; quello che vede il difetto vero è in
   * `e2e/public-candidatura-insegnante.spec.ts`.
   */
  const nonRubareIlFuoco = (e: React.MouseEvent<HTMLAnchorElement>) => e.preventDefault()
  return href.startsWith('/') ? (
    <LinkInterno href={href} className={classe} onMouseDown={nonRubareIlFuoco}>
      {contenuto}
    </LinkInterno>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classe}
      onMouseDown={nonRubareIlFuoco}
    >
      {contenuto}
    </a>
  )
}

/**
 * Il menu a tendina, con l'inchiostro che dice se è stato compilato.
 *
 * Il difetto (misurato l'11/08/2026): «Seleziona…» era scritto nel VERDE dei
 * valori (#006A5F), cioè un menu non compilato aveva esattamente l'aspetto di un
 * menu compilato — mentre negli `input` il suggerimento è grigio. Un componente
 * separato perché `useWatch` è un hook e serve solo qui: metterlo in
 * `FieldRenderer` lo farebbe girare per ogni campo di ogni tipo, e un ri-render a
 * ogni tasto su moduli da 17 campi non è gratis.
 *
 * ── E IL COLORE DA SOLO NON BASTA, PER LO STESSO MOTIVO DEL SEGNAPOSTO ───────
 * Fra `sub` #55615C e il verde dei valori #006A5F corrono **1,01:1**: sono due
 * tinte, non due chiarezze. Sugli `input` il repo l'ha già riconosciuto e ha
 * aggiunto un secondo segnale non cromatico — il CORSIVO del segnaposto, più il
 * prefisso «Es. » — mentre il `<select>` era rimasto col solo colore, e per
 * giunta con un `::placeholder` che su un menu non esiste. Dall'11/08/2026 il
 * colore non è più `sub` ma `hint` (#65716C): 1,28:1 col verde del valore, L*
 * 46,5 contro 39,8, e 5,08:1 sul bianco del controllo. In Alto Contrasto, dove
 * il blocco «2 · L'inchiostro» manderebbe «Seleziona…» nel nero del valore, una
 * regola dedicata di `globals.css` lo tiene a #595959. Qui il corsivo si
 * dichiara sull'elemento: sul controllo chiuso il browser disegna il testo
 * dell'opzione scelta col font del `<select>`, quindi «Seleziona…» esce corsivo
 * e «Laurea triennale» tondo, in luce normale come in Alto Contrasto.
 *
 * ⚠️ NOTA DI MISURA, perché costa mezz'ora a chi la rifà. Un rilievo dell'11/08
 * dava questo componente per rotto: `color` computato `rgb(85,97,92)` in
 * ENTRAMBI gli stati, «rapporto 1,00:1». È un artefatto della SCHEDA NASCOSTA:
 * `FIELD_STRUTTURA` porta `transition-all`, che comprende `color`, e in una
 * scheda in background Chrome non avanza i fotogrammi — la transizione resta
 * ferma sul valore di partenza e `getComputedStyle` restituisce quello (nella
 * stessa sonda anche un `style.color` scritto a mano tornava indietro immutato).
 * Rimisurato con la scheda in primo piano: vuoto `rgb(85,97,92)`, compilato
 * `rgb(0,106,95)`, cioè il codice faceva già la sua parte. Chi misura un colore
 * in transizione controlli prima `document.visibilityState`.
 */
function SelectField({
  field,
  control,
  register,
  rules,
  bordo,
  ariaProps,
  autoCompleteProps,
}: {
  field: FormField
  control: Control<FieldValues>
  register: UseFormRegister<FieldValues>
  rules: RegisterOptions<FieldValues, string>
  bordo: string
  ariaProps: React.AriaAttributes
  autoCompleteProps: { autoComplete?: string }
}) {
  const t = useTranslations('parentForms')
  const valore = useWatch({ control, name: field.id })
  const vuoto = valore === undefined || valore === null || valore === ''
  return (
    <select
      id={field.id}
      // L'inchiostro si compone QUI e non concatenando due `text-*`: fra due
      // utility sullo stesso elemento vince quella che sta più avanti nel FOGLIO,
      // non quella scritta dopo nella stringa.
      className={`${FIELD_STRUTTURA} ${bordo} ${
        vuoto ? 'text-kidville-hint italic' : 'text-kidville-green not-italic'
      }`}
      defaultValue=""
      {...autoCompleteProps}
      {...ariaProps}
      {...register(field.id, rules)}
    >
      {/* Il corsivo anche sull'OPZIONE, non solo sul controllo chiuso: nella
          tendina aperta i browser che disegnano la lista in HTML (Chrome su
          Android, Firefox) prendono lo stile dell'`<option>`, non quello del
          `<select>`. Dove la lista la disegna il sistema (macOS, iOS) questa
          classe non ha effetto e non fa danno. */}
      <option value="" disabled className="bg-kidville-white text-kidville-hint italic">
        {t('seleziona')}
      </option>
      {(field.options ?? []).map((opt, i) => (
        <option key={i} value={opt.value} className="bg-kidville-white text-kidville-green not-italic">
          {opt.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Il gruppo di scelta singola. Le opzioni sono registrate con `register` (il
 * valore lo tiene RHF), ma la card ha bisogno di sapere QUALE è scelta per
 * dipingersi: `useWatch` è l'unico modo di leggerlo senza duplicare lo stato.
 */
function RadioGroup({
  field,
  control,
  register,
  rules,
  ariaOpzione,
  etichettaId,
  descriveGruppo,
  obbligatorio = false,
  nonValido = false,
}: {
  field: FormField
  control: Control<FieldValues>
  register: UseFormRegister<FieldValues>
  rules: RegisterOptions<FieldValues, string>
  /** Ciò che porta la singola opzione: errore sì, obbligo e nota NO (sono del gruppo). */
  ariaOpzione: React.AriaAttributes
  /** L'`id` dell'etichetta esterna: è il NOME del gruppo. Vedi `idEtichetta`. */
  etichettaId?: string
  /** Errore + nota del gruppo, in quest'ordine. */
  descriveGruppo?: string
  /**
   * L'obbligo sta QUI e non sulle opzioni: `aria-required` è fra le proprietà che
   * ARIA ammette su `radiogroup`, e su un gruppo «scegline una» è l'insieme a
   * essere obbligatorio. Vedi la testata di `ariaProps`/`ariaOpzione`.
   */
  obbligatorio?: boolean
  /** Il gruppo è in errore: le opzioni NON scelte portano il contorno rosso. */
  nonValido?: boolean
}) {
  const valore = useWatch({ control, name: field.id })
  // Come nel gruppo a spunta: il contorno rosso segnala il gruppo ANCORA VUOTO,
  // non il messaggio (che in `mode: 'onTouched'` sopravvive alla prima scelta).
  const vuoto = valore === undefined || valore === null || valore === ''
  return (
    <div
      className="space-y-2"
      role="radiogroup"
      aria-labelledby={etichettaId}
      aria-describedby={descriveGruppo}
      aria-required={obbligatorio || undefined}
    >
      {(field.options ?? []).map((opt, i) => {
        const scelta = valore === opt.value
        return (
          <label key={i} {...propsScelta(scelta, { nonValido: nonValido && vuoto })}>
            <input
              type="radio"
              value={opt.value}
              className={SCELTA_CONTROLLO}
              {...ariaOpzione}
              {...register(field.id, rules)}
            />
            <span className={`text-sm text-kidville-green ${scelta ? 'font-semibold' : ''}`}>
              {opt.label}
            </span>
          </label>
        )
      })}
    </div>
  )
}

/**
 * ── Upload allegato (bucket form_attachments) ────────────────────────────────
 *
 * ⚠️ IL CONTROLLO È NASCOSTO AGLI OCCHI, MAI ALLA TASTIERA (12/08/2026).
 *
 * Qui c'era `<input type="file" className="hidden">`, cioè `display: none`: un
 * elemento con `display:none` non è focalizzabile, non entra nell'ordine di
 * tabulazione e NON ESISTE nell'albero di accessibilità. Attorno c'era una
 * `<label>` che ne disegna la scatola, senza `tabIndex`, senza `role` e senza
 * gestore di tastiera — cioè una cosa che sembra un bottone e non lo è — e
 * nessun altro comando apriva il selettore di file.
 *
 * MISURATO sul passo «Documento d'identità» di `/anagrafica-personale` (riquadro
 * 360×740, pressioni di tasto vere): il giro del Tab faceva
 * `#document_number` → `#pers-documento-scadenza` → «INDIETRO» → «TORNA AL
 * RIEPILOGO» → fine del documento. **Zero fermate sul caricamento**, che è
 * l'unico campo senza il quale «Avanti» non passa. Chi compila con la sola
 * tastiera riempiva tre caselle, premeva «Avanti», leggeva «Campo obbligatorio»
 * sotto una cosa che non poteva raggiungere e non aveva nessuna via d'uscita.
 * `jest-axe` non lo vede — non esiste una regola per «una label che sembra un
 * bottone» — e infatti dava 0 violazioni su quel passo.
 *
 * Il rimedio è che il controllo VERO resti quello che era, e diventi
 * raggiungibile: `sr-only` invece di `hidden` (fuori dalla vista, dentro
 * l'albero e dentro il Tab), l'`id` con cui l'etichetta esterna lo nomina, il
 * `ref` di react-hook-form perché `setFocus` sappia dove andare, e l'anello di
 * fuoco disegnato sulla `<label>`, che è la sola cosa che si vede.
 *
 * ⚠️ E questo è l'UNICO punto del repo in cui l'anello si disegna sul
 * contenitore: la regola generale — scritta nel blocco delle card di scelta più
 * su — è che l'anello lo dia `:focus-visible` sul controllo vero, e che un
 * secondo anello sul contenitore sia un difetto. Qui il controllo è alto un
 * pixel e clippato: l'anello di sistema esiste, e non lo vede nessuno.
 */
/**
 * Spezza un nome di file in RADICE + CODA per il troncamento centrale.
 *
 * `truncate` (cioè `text-overflow: ellipsis`) taglia sempre in fondo, e in fondo
 * c'è l'estensione: è l'unico pezzo che distingue un curriculum in PDF dallo
 * screenshot di una chat. Rendendo la coda come uno `<span>` `shrink-0` accanto a
 * una radice `truncate`, a stringersi è solo la parte centrale.
 *
 * `CODA = 10` non è un numero tondo scelto a caso: copre `-2026.pdf`, `.jpeg`,
 * `(1).pdf` e le code che la galleria di un telefono produce, senza rubare metà
 * della larghezza a nomi corti — da cui il `Math.max`, che impedisce alla coda di
 * superare la metà del nome.
 *
 * ⚠️ RADICE + CODA È SEMPRE IL NOME INTERO, byte per byte: nessun carattere si
 * perde e nessuno si duplica. Il troncamento lo fa il FOGLIO DI STILE, non questa
 * funzione — che è anche il motivo per cui non si taglia qui a un numero di
 * caratteri: la larghezza disponibile la conosce solo il browser.
 *
 * ── E LA CODA COMINCIA DA UNA PAROLA, NON DA UNA SILLABA (25/08/2026) ────────
 *
 * Con l'indice fisso, MISURATO a 390 px su «Curriculum Vitae Maria Giuseppina
 * Esposito aggiornato settembre 2026.pdf», a schermo si leggeva
 * «Curriculum Vitae M…e 2026.pdf»: la coda cominciava con la «e» mozzata di
 * «settembre». Il resto di questo campo è curato al millimetro — la coda esiste
 * apposta perché l'estensione non si perda — e una sillaba tagliata a metà subito
 * dopo i puntini si legge come un errore di rendering, proprio nel riquadro che
 * conferma alla persona che il suo curriculum è arrivato.
 *
 * Quindi la lunghezza resta quella, e si SPOSTA al confine di parola più vicino
 * entro `FINESTRA` caratteri. Tre scelte, tutte con una ragione:
 *
 *  · SI TAGLIA DOPO IL SEPARATORE, non prima: la radice si porta via lo spazio
 *    (che è invisibile, viene clippato) e la coda comincia con un carattere
 *    pieno. Tagliando prima, fra i puntini e la coda resterebbe uno spazio.
 *  · IL PUNTO NON È UN CONFINE, benché sia il separatore più ovvio in un nome di
 *    file: la finestra arriva a toccare le estensioni lunghe (`.numbers` sta
 *    dentro i ±4), e un taglio dopo il punto darebbe coda «numbers», cioè
 *    l'estensione senza il punto — esattamente il pezzo che il troncamento
 *    centrale esiste per proteggere.
 *  · A PARITÀ DI DISTANZA VINCE IL TAGLIO PIÙ A SINISTRA, cioè la coda più
 *    lunga: la coda è `shrink-0` e sopravvive sempre, la radice no.
 *
 * Se nella finestra non c'è nessun confine, il taglio resta quello di prima: la
 * regola non peggiora mai il caso che non sa migliorare.
 */
export function spezzaNomeFile(nome: string): [string, string] {
  const CODA = 10
  const FINESTRA = 4
  const CONFINI = new Set([' ', '_', '-'])
  if (nome.length <= CODA) return ['', nome]
  const minimo = Math.ceil(nome.length / 2)
  const ideale = Math.max(minimo, nome.length - CODA)
  let taglio = ideale
  let distanza = Number.POSITIVE_INFINITY
  const da = Math.max(minimo, ideale - FINESTRA)
  const a = Math.min(nome.length - 1, ideale + FINESTRA)
  for (let t = da; t <= a; t++) {
    if (!CONFINI.has(nome[t - 1])) continue
    const d = Math.abs(t - ideale)
    if (d < distanza) {
      distanza = d
      taglio = t
    }
  }
  return [nome.slice(0, taglio), nome.slice(taglio)]
}

export function FileField({
  modelId,
  value,
  onChange,
  uploadEndpoint,
  accept,
  maxSizeMb,
  fieldId,
  etichettaCampo,
  ariaProps,
  nonValido = false,
  inputRef,
  onBlur,
  onCaricamento,
  onNomeFile,
  nomeIniziale,
}: {
  modelId: string
  value: string
  onChange: (path: string) => void
  uploadEndpoint?: string
  /** Estensioni/MIME ammessi (default PDF + immagini). */
  accept?: string
  /** Dimensione massima in MB comunicata al server per la validazione. */
  maxSizeMb?: number
  /** L'`id` del controllo: ciò che l'etichetta esterna punta con `htmlFor`. */
  fieldId?: string
  /**
   * L'ETICHETTA UMANA DEL CAMPO — serve al bottone «Scatta foto», non all'input.
   *
   * ⚠️ MISURATO IL 12/08/2026 sul passo «Documento» di `/anagrafica-personale`, che da
   * quel giorno chiede DUE scansioni: ogni `FileField` che ammette immagini rende un
   * `ScattaFotoButton`, e i due bottoni avevano lo stesso identico nome accessibile —
   * «Scatta foto» — senza niente che dicesse quale fosse il fronte e quale il retro.
   * Il controllo vero (`<input type=file>`) non aveva il problema: l'etichetta esterna
   * lo nomina con `htmlFor`. Il bottone nativo no, perché sta FUORI dalla `<label>`
   * (altrimenti riaprirebbe il selettore di file), quindi non eredita niente.
   *
   * NESSUN TEST ESISTENTE lo vedeva: `ScattaFotoButton` fa `if (!nativo) return null`,
   * quindi in jsdom di default non esiste — e nell'app Capacitor quello è il modo normale
   * di consegnare la scansione di un documento. Ecco perché il rilievo è arrivato da una
   * lettura e non da un rosso.
   *
   * ⚠️ MA «nessun test POTEVA vederlo» era falso, ed è stato scritto qui: basta mockare
   * `fotocameraNativaDisponibile` perché il bottone esista anche in jsdom. Il presidio è
   * `__tests__/a11y/scatta-foto-due-facce.test.tsx`, che fa esattamente questo e monta le
   * due facce del template. Misurato per mutazione il 13/08/2026: cancellata questa prop,
   * quel file va ROSSO su «i due bottoni hanno nomi accessibili DIVERSI».
   *
   * NON è `__tests__/i18n/scatta-foto-i18n.test.tsx`, che qui era indicato come «l'unico
   * posto da cui questa catena si può sorvegliare»: quel file non nomina `scattaFotoDi`,
   * `nomeAccessibile` né `etichettaCampo` (grep: zero occorrenze) e con la stessa
   * mutazione resta VERDE. Sorveglia un'altra cosa — che nessun host cabli «Scatta foto»
   * in italiano — ed è utile, ma non questa.
   */
  etichettaCampo?: string
  /** `aria-invalid` e `aria-describedby` del campo in errore, come ogni altro tipo. */
  ariaProps?: React.AriaAttributes
  /**
   * Il campo è in ERRORE — e il riquadro lo deve DIRE, non solo dichiararlo.
   *
   * ⚠️ MISURATO il 12/08/2026 al passo «Documento d'identità» di
   * `/anagrafica-personale`, premendo «Avanti» a passo vuoto: `document_type`,
   * `document_number` e la scadenza prendevano il bordo rosso pieno a 1,5 px
   * (rgb(229,57,53), **4,23:1** sul bianco); il riquadro del file — che aveva
   * `aria-invalid="true"` e «Campo obbligatorio» scritto sotto — conservava il
   * suo `border-kidville-green/20` a 1 px: composto sul crema, **1,35:1**.
   * WCAG 1.4.11 chiede ≥ 3:1 per gli indicatori non testuali: 1,35:1 non è un
   * contorno debole, è nessun contorno. Chi rilegge la schermata dopo un
   * «Avanti» fallito cerca il rosso, vede tre caselle rosse e il riquadro del
   * documento immutato, e conclude che quello è a posto — proprio il campo che
   * costa più fatica di tutti (alzarsi, fotografare il documento, allegarlo) e
   * quindi il più facile da saltare.
   * La testata di questo file dichiarava già la regola per gli `input`
   * (righe 41-44 e 68): non era stata applicata al riquadro del caricamento.
   */
  nonValido?: boolean
  /** Il `ref` di react-hook-form: senza, `setFocus(id)` non trova niente da fare. */
  inputRef?: React.Ref<HTMLInputElement>
  /** Il `blur` di react-hook-form: è ciò che rende «toccato» il campo. */
  onBlur?: () => void
  /**
   * «Un allegato sta salendo», detto a chi rende il messaggio d'errore.
   *
   * ⚠️ È l'unica cosa che `FileField` sapeva e non diceva a nessuno. Il valore del
   * modulo resta vuoto per tutta la durata del caricamento — `onChange` parte solo
   * alla fine, col percorso — quindi senza questo segnale «sto caricando» e «non
   * ho allegato niente» sono indistinguibili per chi scrive sotto il campo. Il
   * perché per esteso sta su `caricamentoInVolo`, in `FieldRenderer`.
   */
  onCaricamento?: (inVolo: boolean) => void
  /**
   * Il NOME del file scelto, detto a chi sopravvive a questo componente.
   *
   * ⚠️ MISURATO il 25/08/2026 sul riepilogo di `/lavora-con-noi`: la riga
   * «CURRICULUM» diceva «Allegato», mentre ogni altra riga rimanda indietro il
   * valore vero che la persona ha scritto («Prova», «Insegnante — Infanzia
   * (3-6)», «Diploma di scuola superiore»). Il riepilogo esiste per far
   * controllare cosa si sta per mandare, e l'unica cosa diventata obbligatoria era
   * ridotta all'unica riga non verificabile della pagina: da «Allegato» non si
   * distingue il curriculum dalla fotografia sbagliata scattata due minuti prima.
   *
   * ⚠️ E NON BASTAVA LEGGERLO DAL VALORE DEL MODULO: dal 15/08 la rotta di
   * caricamento BUTTA VIA il nome originale (il percorso è
   * `candidature/<uuid>-cv.pdf`), quindi dal valore non si ricava. Né basta lo
   * stato di questo componente: il wizard rende UN PASSO ALLA VOLTA, quindi
   * arrivando al riepilogo questo `FileField` è smontato e `fileName` non esiste
   * più. L'unica strada è farlo uscire quando c'è, come già fa `onCaricamento`.
   *
   * ⚠️ NON SI LOGGA. Il nome è `cv-<cognome>.pdf`: è un dato personale, sta sullo
   * schermo di chi l'ha scelto e non entra in nessun evento.
   */
  onNomeFile?: (nome: string) => void
  /**
   * Il nome dell'allegato con cui questo componente NASCE.
   *
   * ⚠️ È il verso di ritorno di `onNomeFile`, e serve perché il wizard rende un
   * passo alla volta: tornando al passo 3 dal riepilogo questo componente si
   * RIMONTA, `fileName` ripartiva da '' e il riquadro diceva «Allegato caricato»
   * mentre il riepilogo, nello stesso istante, diceva «cv-di-prova.pdf».
   * Il proprietario del nome resta UNO — il chiamante — e questa prop è il modo in
   * cui glielo si restituisce, non una seconda memoria.
   */
  nomeIniziale?: string
}) {
  const t = useTranslations('parentForms')
  const [uploading, setUploading] = useState(false)
  // ⚠️ Valore INIZIALE, non sincronizzato: dopo il montaggio il nome lo decide
  // `processaFile`, che è l'unico posto in cui un file cambia. Un `useEffect` che
  // riallineasse lo stato a ogni render del padre sovrascriverebbe il nome appena
  // scelto con quello vecchio, per il tempo che il chiamante impiega a saperlo.
  const [fileName, setFileName] = useState(nomeIniziale ?? '')
  const [uploadError, setUploadError] = useState<string | null>(null)

  /**
   * SE LA RADICE DEL NOME SIA DAVVERO TAGLIATA — e questa misura è l'unica cosa
   * che rende onesti i puntini (25/08/2026).
   *
   * Il troncamento centrale spezza il nome in due `<span>`: radice che si
   * stringe, coda intatta (vedi `spezzaNomeFile`). Con `truncate` sulla radice i
   * puntini li disegnava il browser — nel punto in cui TAGLIA il testo, non a
   * filo della scatola: fra i puntini e la coda restava fino a un carattere di
   * bianco, e a 390 px il nome smetteva di leggersi come una cosa sola
   * («Curriculum Vitae Eu… nitivo.pdf», misurato).
   *
   * ⚠️ E IL RIMEDIO OVVIO — `text-clip` più un nodo `…` fisso — È SBAGLIATO, con
   * una prova che sta in una riga. MISURATO a 900 px con «cv-anna.pdf», undici
   * caratteri dentro un riquadro largo 600: a schermo compariva «cv-ann…a.pdf».
   * `spezzaNomeFile` divide SEMPRE (sopra i 10 caratteri), perché non conosce la
   * larghezza disponibile — solo il browser la conosce — quindi puntini
   * incondizionati significano puntini in mezzo a nomi che ci starebbero interi.
   * Si sarebbe chiuso un difetto da un carattere aprendone uno da tre, e su ogni
   * nome corto invece che sui soli lunghi.
   *
   * Quindi: taglio netto (`text-clip`, nessuna ellissi automatica) e i puntini
   * resi SOLO quando `scrollWidth > clientWidth`, cioè quando la radice sta
   * davvero perdendo dei caratteri. La misura si rifà al cambio del nome e a ogni
   * cambio di larghezza — un riquadro in una colonna fluida cambia dimensione
   * senza che il nome cambi, e senza `ResizeObserver` i puntini resterebbero
   * quelli dell'ultimo nome scelto.
   *
   * `ResizeObserver` è protetto perché jsdom non ce l'ha: là la misura resta
   * quella iniziale (0 > 0 = falso), che è anche il caso di riposo giusto.
   */
  const radiceRef = useRef<HTMLSpanElement>(null)
  const [radiceTagliata, setRadiceTagliata] = useState(false)
  useEffect(() => {
    const nodo = radiceRef.current
    if (!nodo) {
      setRadiceTagliata(false)
      return
    }
    const misura = () => setRadiceTagliata(nodo.scrollWidth > nodo.clientWidth)
    misura()
    if (typeof ResizeObserver === 'undefined') return
    const osservatore = new ResizeObserver(misura)
    osservatore.observe(nodo)
    return () => osservatore.disconnect()
    // ⚠️ TRE DIPENDENZE, NON SOLO IL NOME, e la prima stesura ne aveva una sola.
    // La radice esiste solo nel ramo «allegato e non in volo»: durante il
    // caricamento la riga mostra «Caricamento del file…» e il nodo non c'è. Con
    // il solo `fileName` l'effetto girava mentre il file saliva — nodo assente,
    // misura falsa — e non tornava a girare quando il nome compariva davvero,
    // perché a cambiare in quel momento è `value`, non il nome. Risultato: i
    // puntini non arrivavano mai, cioè il rimedio non rimediava niente e il test
    // che lo prova sarebbe stato l'unico ad accorgersene.
  }, [fileName, value, uploading])

  // Accept dinamico: mostra «Scatta foto» solo se il campo ammette immagini
  // (la fotocamera produce un JPG) — così non si aggiunge un trigger foto a un
  // input che accetta solo PDF/doc.
  const acceptEff = accept || '.pdf,.jpg,.jpeg,.png'
  const consenteImmagini = /image\/|\*|\.jpe?g|\.png|\.webp|\.gif|\.heic/i.test(acceptEff)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    // ⚠️ LA GUARDIA STA QUI, e non su `disabled` (12/08/2026). Il controllo
    // NON si disabilita durante il caricamento: disabilitare un elemento che ha
    // il fuoco lo fa cadere su `<body>` — è lo stesso difetto chiuso sul comando
    // primario del wizard (`ComandiWizard`) — e qui colpirebbe proprio chi ha
    // appena scelto un file da tastiera, cioè l'unico percorso che questa
    // correzione esiste per rendere possibile. Che stia lavorando lo dicono il
    // testo («Caricamento…»), la rotellina e `aria-busy`.
    if (uploading) return
    const file = e.target.files?.[0]
    if (!file) return
    await processaFile(file)
  }

  async function processaFile(file: File) {
    setUploading(true)
    // Lo stesso fatto detto due volte a due destinatari diversi: al riquadro (che
    // disegna la rotellina e `aria-busy`) e a chi scrive il messaggio sotto il
    // campo. Sta ATTACCATO a `setUploading`, sopra e sotto, perché è l'unico modo
    // di non lasciare acceso il segnale quando il caricamento è finito.
    onCaricamento?.(true)
    setUploadError(null)
    setFileName(file.name)

    try {
      // ── IL CARICAMENTO NON VIVE PIÙ QUI, ed è il motivo per cui questo blocco è
      // corto. Il controllo della taglia PRIMA di spedire, `res.ok` letto PRIMA di
      // `res.json()`, il `path` preso dal corpo, lo stato HTTP che non si perde e il
      // tetto di tempo stanno in `@/lib/upload/carica-file`.
      //
      // ⚠️ QUESTA È UNA DELLE DUE CHIAMATE, non l'unica. Qui c'è stato scritto prima che
      // il modulo «lo legge ANCHE il tab Documento» (allora non ancora vero), poi che
      // «`caricaFile` ha un solo chiamante, ed è questa riga» — con `grep -rn caricaFile
      // src` indicato come prova. Quel comando ne trova due: questa riga e
      // `StaffDetailPanel.tsx`, cioè proprio il tab «Documento», che nel frattempo è
      // arrivato. L'elenco aggiornato sta nella testata di `@/lib/upload/carica-file`, in
      // un posto solo: qui non si ricontano i chiamanti, perché è ricontandoli in due
      // posti che si è finito per sbagliarli in due modi opposti.
      //
      // Il fronte/retro della carta d'identità restano due ISTANZE di questo stesso
      // componente su due campi `type: 'file'` del template — non una seconda copia di
      // questa logica. E l'estrazione regge anche per il motivo più modesto: dentro un
      // componente quei rami erano misurabili solo montando una `<label>`, un `<input>` e
      // `useTranslations`; fuori si misurano da soli.
      //
      // Qui resta ciò che è di chi RENDE: le stringhe tradotte, lo stato del riquadro e
      // la guardia sul fuoco (vedi `handleFile`).
      const esito = await caricaFile({
        // Upload SEMPRE via endpoint server (service-role, bucket privato deny-by-default).
        // Pubblico: token-scoped; autenticato: `/api/forms/upload` (requireUser). Niente
        // più scrittura diretta dal client anon (P0/DL-035).
        endpoint: uploadEndpoint || '/api/forms/upload',
        file,
        maxSizeMb,
        extra: { folder: modelId },
      })

      if (esito.esito === 'ok') {
        onChange(esito.path)
        // Il nome esce INSIEME al percorso, non prima: sono la stessa notizia
        // («questo file è allegato») detta a due destinatari, e devono nascere e
        // morire insieme — vedi i due `onNomeFile?.('')` accanto ai `onChange('')`
        // dei rami di guasto.
        onNomeFile?.(file.name)
        // ⚠️ E SUBITO DOPO IL VALORE, IL «TOCCATO» — misurato in Chromium il
        // 2026-08-25 su `/lavora-con-noi`. Allegando il curriculum DOPO un
        // «Avanti» fallito, il riquadro mostrava il nome del file e l'icona
        // verde mentre il campo restava `aria-invalid="true"`, col suo
        // `<p role="alert">` (la voce `allegaFile` del catalogo) e il bordo
        // rosso: chi ascolta
        // aveva appena risolto il problema e sentiva che il campo era ancora
        // sbagliato — sull'unico campo bloccante del passo.
        //
        // LA CAUSA è `mode: 'onTouched'`, che governa tutti i moduli di questo
        // repo. Un campo mandato in errore dal `trigger()` di «Avanti» senza
        // essere mai stato TOCCATO non viene rivalidato al cambio di valore:
        // l'errore sopravvive al valore che lo risolve. Sui campi di testo il
        // caso si chiude da solo — si tabula via, e quel blur segna «toccato» —
        // ma qui quel blur non arriva MAI: il selettore di file del sistema non
        // sfoca l'input, e il `preventDefault` sul comando primario
        // (`ComandiWizard`, il rimedio al primo clic perduto) toglie l'ultimo
        // blur rimasto. Prima del 2026-08-24 il caso era IRRAGGIUNGIBILE, perché
        // `cv_path` era facoltativo e non produceva errori: renderlo obbligatorio
        // ha messo sulla strada di tutti un difetto che non aveva mai avuto una
        // strada.
        //
        // `onBlur()` è il segnale che RHF aspetta: segna il campo come toccato e
        // in `onTouched` lo rivalida sul valore appena scritto. Non sposta il
        // fuoco (è il gestore di RHF, non `HTMLElement.blur()`), quindi chi ha
        // scelto il file da tastiera resta dov'è.
        //
        // Presidio: `__tests__/a11y/candidatura-insegnante-a11y.test.tsx`,
        // «allegato il curriculum, il campo NON resta marcato non valido».
        onBlur?.()
        return
      }

      // `troppo-grande` copre due strade — il file respinto prima di partire e il 413
      // della piattaforma — e le copre insieme di proposito: per chi carica sono lo
      // stesso guasto, e il messaggio è uno solo. `limiteMb` arriva già calcolato col
      // `Math.min` fra il tetto del campo e quello della piattaforma: ricalcolarlo qui
      // da `maxSizeMb` è il modo di promettere 8 MB che nessuno può mantenere.
      //
      // ⚠️ IL `codice` NON SI BUTTA VIA — e fino al 13/08/2026 qui si buttava. Restava
      // `esito.messaggioServer ?? t('caricamentoNonRiuscito')`: la prosa del server
      // riversata in pagina così com'è. Quella prosa nasce sul server, dove il locale
      // dell'interfaccia non esiste, ed è ITALIANA PER COSTRUZIONE — mentre questo
      // componente sta sulla porta ANONIMA (i due wizard pubblici e i moduli delle
      // famiglie), che ha il catalogo inglese completo. Le rotte di caricamento il
      // codice lo mandano già (`ALLEGATO_PDF_O_IMMAGINE` e `TROPPE_RICHIESTE` da
      // `@/lib/upload/allegati-pubblici`, `ALLEGATO_OLTRE_LIMITE_PIATTAFORMA` da
      // `iscrizione/personale/upload`), e il chiamante GEMELLO di `caricaFile` — il tab
      // «Documento» della scheda staff — lo traduceva già con questa stessa funzione:
      // due consumatori della stessa primitiva, e quello sulla porta pubblica era
      // l'unico a mostrare italiano a chi ha l'interfaccia in inglese. È testualmente il
      // fallimento F2 del collaudo del 31/07/2026, lasciato aperto dalla parte anonima.
      //
      // `messaggioDaCorpo` e non `soloCatalogoDaCorpo`: il codice dichiarato vince
      // sempre, ma dove il codice ANCORA non c'è (`/api/forms/upload` non ne manda
      // nessuno) la prosa resta l'unica cosa che dice qualcosa, e toglierla
      // sostituirebbe un messaggio italiano con un messaggio generico — un difetto
      // scambiato con un altro. La strada per chiudere il residuo è dichiarare il
      // codice in `CODICI_ERRORE`, non nascondere la frase.
      setUploadError(
        esito.esito === 'troppo-grande'
          ? t('fileTroppoPesante', { mb: esito.limiteMb })
          : messaggioDaCorpo(
              { error: esito.messaggioServer, codice: esito.codice },
              t('caricamentoNonRiuscito'),
            ),
      )
      onChange('')
      onNomeFile?.('')
    } catch (err) {
      // `caricaFile` non lancia MAI: questo ramo copre l'APPLICAZIONE dell'esito — un
      // `onChange` del form che esplode — e resta perché `processaFile` è chiamata da
      // `ScattaFotoButton` SENZA `await`: di lì una promise rifiutata diventerebbe un
      // `unhandledrejection`, cioè un guasto che nessuno ricollega al caricamento.
      // Un catch che non logga è un bug. `logClient` redige il path e non lancia.
      //
      // ⚠️ IL MESSAGGIO È DIVERSO DA QUELLO DI `caricaFile`, e non è una preferenza di
      // stile. Entrambi i `catch` scrivevano `modulo-allegato-upload-fallito:
      // ${nomeErrore(err)}` con lo stesso `evento` e senza `stato`: in `app_log` i due
      // guasti erano la stessa riga — e visto che `nomeErrore` dà `Error` per quasi
      // tutto, la chiave del throttle (`${evento}|${messaggio}|${stato ?? ''}`,
      // `DEDUP_MS = 60_000`) coincideva e la SECONDA veniva scartata in silenzio. Un
      // caricamento fallito e un form che esplode nell'applicare l'esito sono due
      // riparazioni diverse: qui si dice quale dei due è.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `modulo-allegato-esito-non-applicato: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      setUploadError(t('caricamentoNonRiuscito'))
      onChange('')
      onNomeFile?.('')
    } finally {
      setUploading(false)
      onCaricamento?.(false)
    }
  }

  return (
    /* ── UNA PILA, UNA DISTANZA (25/08/2026) ──────────────────────────────────
       Il contenitore era un `<div>` nudo e le distanze se le scriveva ogni figlio
       per conto suo: `mt-2` sul bottone «Scatta foto», `mt-1.5` (6 px) sul
       messaggio del caricamento fallito — mentre l'ALTRO messaggio d'errore dello
       stesso campo, quello di `FieldRenderer`, stava a 8 px perché la distanza
       gliela dà lo `space-y-2` del blocco. Due messaggi d'errore sullo stesso
       campo a due distanze diverse.
       La regola era già scritta di nostra mano duecento righe più in su, nel
       commento della nota: «Niente `mt-*`: la distanza la dà lo `space-y-2` del
       blocco… tre distanze diverse (8 · 6 · 6 px) dentro la stessa pila». Il 6 px
       che quel commento cita come esito da evitare viveva qui sotto. Una regola
       enunciata e non applicata al vicino di casa è una regola che il prossimo
       lettore non crederà.
       ⚠️ La regione `sr-only` in mezzo non spezza la pila: è
       `position: absolute`, quindi non partecipa al flusso e il margine del
       fratello successivo si misura dalla `<label>`. */
    <div className="space-y-2">
      <label
        /* `focus-within:ring-*` — vedi la testata: il controllo è `sr-only`,
           quindi l'anello di `:focus-visible` cade su un rettangolo di 1×1 px
           clippato e non lo vede nessuno. Qui l'anello sul contenitore non è il
           SECONDO: è l'unico.
           ⚠️ QUESTO COMMENTO DICEVA DUE COSE FALSE, corrette il 25/08/2026 con le
           misure che le smentiscono — ed è lo stesso difetto che il resto del file
           denuncia, cioè una riga di prosa che sopravvive alla cosa che descrive.
             1. «`ring-offset-1` è lo stesso stacco usato dai comandi del cockpit».
                Il metro giusto non sono i comandi del cockpit: sono i CAMPI ACCANTO,
                e quelli usano `:focus-visible` di `globals.css` — `outline: 2px` +
                `outline-offset: 2px` + alone bianco 2 px, cioè anello a +4. Con
                `ring-offset-1` questo riquadro chiudeva a +3 (misurato:
                `0 0 0 1px #FFFFFF, 0 0 0 3px #006A5F`), unico della colonna. Ora è
                `ring-offset-2`, che pareggia i 4 px.
             2. «`ring-kidville-green` … resta verde anche in Alto Contrasto». Vero
                alla lettera, e in Alto Contrasto è precisamente il difetto: là ogni
                altro controllo risponde `#FFE500`, e restare verde vuol dire essere
                l'unico che risponde diverso. Il giallo arriva ora dalla regola
                `[data-contrast="high"] label:focus-within` in `globals.css`, che
                ribalta `--tw-ring-color` — misurato `rgb(255,229,0)`. In luce
                normale il verde resta (6,51:1 sul bianco, 5,86:1 sulla crema). */
        /* ⚠️ `border` NON sta più nella base, ed è la stessa ragione per cui non
           sta in `FIELD_STRUTTURA` né in `SCELTA_STRUTTURA`: il PESO del
           contorno fa parte dello STATO (1 px a riposo, 1,5 px in errore), e fra
           `border` e `border-[1.5px]` scritte sullo stesso elemento vince quella
           che sta più avanti nel FOGLIO, non quella scritta dopo nella stringa.
           L'unico modo di scegliere è non averle entrambe.
           Il fondo passa a bianco come su `SCELTA_ERRORE`: il rosso vale 4,23:1
           sul bianco contro 3,81:1 sul crema, e «in errore» diventa uno stato
           che si vede anche prima di guardare il bordo.
           `data-scelta-invalida` è il gancio dell'Alto Contrasto — là ogni
           contorno diventa nero e il rosso non esiste più, quindi il secondo
           segnale è il bordo DOPPIO (globals.css). L'attributo ARIA non basta:
           sta sull'`input` `sr-only` da 1×1 px, mentre il contorno lo disegna
           questa `<label>`. */
        {...(nonValido ? { 'data-scelta-invalida': 'true' as const } : {})}
        /* ── IL CAMPO CHE ORA È IL CANCELLO NON PUÒ ESSERE L'UNICO INVISIBILE
               (25/08/2026) ─────────────────────────────────────────
           I tre rami erano scritti a mano, con tre coppie di token che non
           esistono da nessun'altra parte, e il ramo a riposo era il peggiore:
           `bg-kidville-cream` + `border-kidville-green/20`. MISURATO nella pagina
           viva, passo 3 di `/lavora-con-noi` a 900 px: fondo del riquadro
           `rgb(254,241,228)` — IDENTICO, byte per byte, al fondo della pagina — e
           contorno `lab(39.62 -29.33 -1.64 / 0.2)`, cioè **~1,35:1**. Nello stesso
           passo un `<select>` mostrava `rgb(255,255,255)` di riempimento e
           `rgb(85,97,92)` di contorno. Il campo che dal 24/08 BLOCCA il passo era
           l'unico controllo della schermata che non si vedeva: un segnaposto
           vuoto, non un campo. WCAG 1.4.11 chiede 3:1 al confine di un componente;
           1,35 è meno della metà.

           ⚠️ PERCHÉ È SFUGGITO AL RIMEDIO CENTRALE. `globals.css` corregge già i
           contorni deboli, ma le sue regole sono scopate a
           `input|select|textarea[class*="border-kidville-green/"]` e a
           `label[class*="border-kidville-neutral"]`. Questa è una `<label>` che
           portava `border-kidville-green/20`: cadeva in mezzo alle due famiglie e
           nessuna la prendeva. Non è un caso nuovo — è lo STESSO caso delle card
           di scelta, chiuso l'11/08 agganciando il rimedio alla superficie.

           Perciò qui non si inventano tre nuovi valori: si usano le tre costanti
           che questo file già esporta, cioè lo stesso linguaggio delle card di
           scelta, dei consensi e delle sedi.
             · a riposo → `SCELTA_LIBERA`: bianco + `border-kidville-neutral`, che
               sulla crema `globals.css` porta a `sub` (5,82:1), al passaggio del
               mouse al verde pieno e in Alto Contrasto al nero. Gratis, e per
               costruzione identico a ogni altra card;
             · con l'allegato → `SCELTA_PRESA`, lo stato «scelto» del sistema;
             · in errore → `SCELTA_ERRORE`, che è LETTERALMENTE la stringa che qui
               era ribattuta a mano.

           ⚠️ E `border-dashed` SE N'È ANDATO DEL TUTTO, poche ore dopo essere
           stato tolto dal solo stato d'errore. La motivazione scritta qui era
           «è l'affordance della zona di rilascio, non un segnale d'errore»: una
           frase che il codice NON conferma. MISURATO — `grep -rnE 'onDrop|onDragOver' src`,
           esito catturato prima di qualunque pipe: DUE occorrenze in tutto il
           prodotto, entrambe in `MediaUploader.tsx` (la galleria), zero in questo
           file. Trascinare un file su questo riquadro non allega niente, e non
           l'ha mai fatto. La vera zona di rilascio del prodotto per giunta è
           disegnata in un'altra lingua: `border-2 border-dashed rounded-3xl`,
           contro `1px dashed rounded-input` qui.
           Restava quindi un tratteggio — il segnale più debole a disposizione,
           una linea a metà duty cycle — sull'unico controllo della schermata
           senza contorno pieno, e sull'unico campo che blocca il passo, a
           promettere un gesto che non esiste. Delle due strade coerenti
           (implementare il rilascio, oppure togliere il segnale) si è presa la
           seconda: il carattere di «campo da riempire» lo portano già l'icona
           `Upload` e il testo, e implementare `onDrop` sulla porta anonima è un
           lavoro con un gate di sicurezza suo, non una riga di stile.
           Presidio: `__tests__/components/FieldRenderer-stati-visivi.test.tsx`
           §12, che verifica insieme l'assenza del tratteggio e l'assenza dei
           gestori di trascinamento — così il giorno in cui il rilascio si
           implementa davvero, quel test va rosso ed è il momento di rimetterlo.

           ⚠️ E L'ANELLO DEL FUOCO È QUELLO DEL SISTEMA, NON UNO SUO (25/08/2026,
           terzo giro di critica — e la stesura di stamattina aveva peggiorato
           proprio questa riga, quindi vale la pena raccontarla per intero).

           Questo è l'UNICO controllo del prodotto che il proprio anello se lo
           disegna da sé: gli altri lo ricevono dalla regola `:focus-visible` di
           `globals.css`, che è un `outline`. Un `<input type="file">` `sr-only`
           non può riceverlo — l'anello deve stare sulla `<label>` che si vede —
           e da lì nascono tre divergenze, tutte MISURATE con `getComputedStyle`
           sulla pagina viva a 900 px:

             1. LO STACCO. Input e select: `outline: 2px solid #006A5F` +
                `box-shadow 0 0 0 2px #FFFFFF`, cioè anello a +4 px. Il riquadro,
                con `ring-offset-1`: `0 0 0 1px #FFFFFF, 0 0 0 3px #006A5F`, cioè
                +3. Stesso verde, stesso spessore, stacco bianco dimezzato:
                l'alone stringeva il riquadro più di ogni altro campo del passo.
                `ring-offset-2` lo pareggia.

             2. IL COLORE IN ERRORE, che era la novità di stamattina ed è stata
                un errore. Il ragionamento («il fuoco verde attorno a un bordo
                rosso è una contraddizione») è sbagliato nella premessa: l'anello
                e il bordo non rispondono alla stessa domanda. Il bordo dice
                «questo campo è sbagliato» e resta rosso anche senza fuoco; il
                fuoco dice «sei qui», ed è l'unico segnale che ha quel mestiere.
                Un anello che cambia colore col contenuto smette di essere il
                segnale del fuoco e diventa un secondo segnale d'errore, cioè
                il terzo sullo stesso campo. Nessun altro controllo del prodotto
                lo fa: l'`outline` di `:focus-visible` è verde su un input valido
                e su uno in errore.

             3. …E IL ROSSO NON SEGUIVA NEMMENO L'ALTO CONTRASTO.
                `ring-kidville-error` compila al LETTERALE #E53935, mentre in
                Alto Contrasto `--color-kidville-error` vale #FF5252. MISURATO
                con `data-contrast="high"`: input e select a fuoco rispondono
                `rgb(255,229,0)` (il giallo, unica risposta ammessa a «dove
                sono»), il riquadro rispondeva `rgb(0,106,95)` a riposo e
                `rgb(229,57,53)` in errore. Chi accende l'Alto Contrasto lo fa
                per non dover interpretare i colori.

           L'anello resta quindi UNO SOLO in tutti gli stati, e la sua riga in
           Alto Contrasto sta accanto alle altre in `globals.css` (blocco
           «l'anello del riquadro segue l'Alto Contrasto»), agganciata a
           `label:focus-within` con la stessa cardinalità stretta usata per le
           card di scelta. Presidio: `FieldRenderer-stati-visivi` §13. */
        className={`flex items-center gap-3 px-4 py-3 rounded-input cursor-pointer transition-all focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-kidville-green ${
          nonValido ? SCELTA_ERRORE : value ? SCELTA_PRESA : SCELTA_LIBERA
        }`}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 text-kidville-green animate-spin flex-shrink-0" />
        ) : value ? (
          <FileCheck2 className="w-4 h-4 text-kidville-green flex-shrink-0" />
        ) : (
          <Upload className="w-4 h-4 text-kidville-sub flex-shrink-0" />
        )}
        {/* ⚠️ `caricamentoAllegato` E NON `caricamento` (25/08/2026). La chiave
            generica è quella delle PAGINE che caricano — «Caricamento…» /
            «Loading…» — ed è usata in una trentina di posti per una schermata che
            si popola. Qui l'evento è un FILE CHE SALE, e in inglese il resto del
            campo lo chiama `upload` dappertutto: `allegatoCaricato`,
            `caricamentoNonRiuscito`, e adesso anche `attendiCaricamento`. Con la
            chiave generica si leggeva «Loading…» nel riquadro e, due centimetri
            sotto, un messaggio che parlava di `upload`: due nomi per lo stesso
            evento, nello stesso istante.
            ⚠️ LE CHIAVI E NON LE FRASI, e la ragione è che questo commento le
            frasi le aveva già sbagliate: citava «Wait for the upload to finish»,
            testo che `attendiCaricamento` ha smesso di avere lo stesso giorno in
            cui questa riga è stata scritta. Un commento che ricopia una stringa
            del catalogo invecchia dentro il commit successivo — spesso lo stesso.
            Il nome della chiave no. Finché lo stato in volo non
            parlava a nessuno non costava niente; da quando il curriculum è
            obbligatorio è lo stato in cui una persona viene esplicitamente
            invitata ad aspettare. In italiano «caricamento» copriva entrambi ed è
            per questo che il difetto si vedeva solo in inglese. */}
        {/* ── LA RIGA DI CONTENUTO: TAGLIA, INCHIOSTRO E CODA (25/08/2026) ────
            Tre difetti misurati insieme nella pagina viva, tutti sulla stessa
            riga e tutti della stessa famiglia — «il campo che blocca il passo
            parla diverso dai suoi pari».

            1. LA TAGLIA. Era `text-sm` (14 px) mentre ogni altro controllo del
               passo rende il proprio valore a 16 px: select 16, `titolo_dettaglio`
               16, `anni_esperienza` 16, `note` 16. Di conseguenza divergeva anche
               l'altezza — riquadro 46 px contro 50 degli `input`. Il sistema usa
               due taglie con due mestieri: 16 per ciò che si compila, 14 per
               etichette e contorno. Qui la riga di CONTENUTO portava la taglia
               delle etichette.

            2. L'INCHIOSTRO. «Seleziona un file (PDF, JPG…)» usciva nel VERDE dei
               valori: un campo non compilato con l'aspetto di uno compilato. È
               letteralmente il difetto diagnosticato e chiuso l'11/08/2026 sul
               `<select>` — la dottrina sta cinquecento righe sopra, su
               `SelectField` — e il riquadro non ne aveva ricevuto nessuno dei tre
               segnali (colore `hint`, corsivo, e in Alto Contrasto la regola
               dedicata di `globals.css`). Qui si RIUSA la stessa espressione di
               `SelectField`, non se ne scrive una seconda.
               ⚠️ «in volo» conta come PIENO: mentre il file sale non c'è nessun
               segnaposto da distinguere, c'è un'attività in corso.

            3. LA CODA. `truncate` taglia in fondo e si mangia l'estensione: a
               390 px «Curriculum Vitae Europass Anna Maria Verdi aggiornato
               settembre 2026 definitivo.pdf» si legge «Curriculum Vitae Europass
               Anna Maria Verdi …», senza overflow ma senza il «.pdf». Il modulo
               si compila dal telefono, dove i nomi generati dalla galleria o
               dallo scanner sono lunghi e si somigliano tutti, e l'unico pezzo
               che dice «è il file giusto, ed è un PDF e non lo screenshot della
               chat» è proprio la coda. Da qui il troncamento CENTRALE: la radice
               si accorcia, la coda no. */}
        <span
          title={fileName || undefined}
          className={`flex min-w-0 flex-1 items-baseline text-base ${
            value || uploading ? 'text-kidville-green not-italic' : 'text-kidville-hint italic'
          }`}
        >
          {uploading ? (
            <span className="truncate">{t('caricamentoAllegato')}</span>
          ) : value && fileName ? (
            (() => {
              const [radice, coda] = spezzaNomeFile(fileName)
              return (
                <>
                  {/* ⚠️ IL NOME INTERO, IN UN NODO SOLO, PER CHI ASCOLTA — e questa
                      riga è la riparazione di un difetto che il troncamento
                      centrale AVEVA APPENA INTRODOTTO. MISURATO in Chromium via
                      CDP (`Accessibility.getPartialAXTree`) subito dopo averlo
                      scritto: il nome accessibile del controllo era
                      «Curriculum * cv-di-pr ova.pdf». Il calcolo del nome
                      accessibile INSERISCE UNO SPAZIO fra due elementi inline
                      adiacenti, quindi spezzare il nome in due `<span>` per
                      poterlo troncare al centro lo spezzava anche a chi lo
                      sente leggere — su un campo che decide se la candidatura
                      parte, e che Chromium espone come `role="button"`, dove il
                      nome è tutto ciò che si ha.
                      Rimedio: il nome intero una volta sola per l'albero AX, e
                      le due metà VISIBILI marcate `aria-hidden`. Nessuna delle
                      due è un testo in più: sono la stessa stringa, impaginata.
                      Presidio: `__tests__/a11y/candidatura-insegnante-a11y.test.tsx`,
                      «il nome del file arriva INTERO a chi ascolta». */}
                  <span className="sr-only">{fileName}</span>
                  {/* ⚠️ `text-clip` E I PUNTINI COME NODO, NON `truncate`
                      (25/08/2026). `truncate` è `overflow-hidden` +
                      `text-overflow: ellipsis`, e l'ellissi automatica il browser
                      la disegna DOVE IL TESTO VIENE TAGLIATO, non a filo della
                      scatola: fra i puntini e la coda resta il residuo dell'ultimo
                      carattere che non ci stava. MISURATO a 390 px con «Curriculum
                      Vitae Europass Anna Maria Verdi aggiornato settembre 2026
                      definitivo.pdf»: la scatola della radice finisce a x=222 e la
                      coda parte esattamente da x=222 — le due metà si toccano, il
                      difetto non è lì — eppure a schermo si legge «Curriculum
                      Vitae Eu… nitivo.pdf», due frammenti separati invece di un
                      nome elisso. L'ampiezza del buco dipende da dove cade il
                      taglio: a 900 px è quasi impercettibile, a 390 — il caso
                      d'uso vero, il modulo si compila dal telefono — è un
                      carattere pieno.
                      Con `text-clip` il taglio è netto e i puntini stanno dove li
                      mettiamo noi, cioè attaccati. Il nodo va marcato
                      `aria-hidden` come le due metà: il nome intero, senza
                      puntini, lo porta già lo `sr-only` qui sopra — e `spezzaNomeFile`
                      continua a garantire che RADICE + CODA sia il nome byte per
                      byte, perché i puntini non sono testo del nome. */}
                  {/* ⚠️ `whitespace-pre` E NON `whitespace-nowrap` (25/08/2026,
                      settimo giro). I due valori non vanno a capo allo stesso modo,
                      ma solo `pre` CONSERVA LO SPAZIO IN FONDO ALLA RIGA: con
                      `nowrap` la collassa via, e `spezzaNomeFile` taglia proprio
                      DOPO un separatore, che nei nomi veri è quasi sempre uno
                      spazio. Le due metà si saldavano: «Curriculum Vitae Europeo
                      definitivo.pdf» si leggeva «Curriculum Vitae Europeodefinitivo.pdf».
                      MISURATO in Chromium riproducendo la riga (flex, tre figli):
                      radice + coda rese 280,42 px contro i 284,61 px del nome intero
                      in un nodo solo — 4,19 px, cioè esattamente uno spazio; con
                      `pre`, 284,61 px, cioè il nome esatto. Non succede col taglio su
                      `_` o `-`, né quando la radice trabocca (là i puntini fanno da
                      separatore): succede sui nomi con gli spazi, che è come si
                      chiamano i curriculum. E il riepilogo, due passi dopo, lo scrive
                      con lo spazio: il prodotto si contraddiceva da solo sul campo
                      che dal 24/08 decide se la candidatura parte.
                      ⚠️ `pre` non riporta il rischio di andare a capo: `pre` implica
                      già il non andare a capo (`white-space: pre` = preserve +
                      nowrap). Il taglio resta `text-clip`, i puntini restano un nodo
                      nostro. */}
                  <span ref={radiceRef} aria-hidden="true" className="overflow-hidden text-clip whitespace-pre">{radice}</span>
                  {radiceTagliata && <span aria-hidden="true" className="shrink-0">…</span>}
                  <span aria-hidden="true" className="shrink-0">{coda}</span>
                </>
              )
            })()
          ) : (
            <span className="truncate">{value ? t('allegatoCaricato') : t('selezionaFile')}</span>
          )}
        </span>
        {/* ── «SI PUÒ ANCORA CAMBIARE», DETTO INVECE CHE LASCIATO INDOVINARE ──
            Allegato il file, il riquadro mostrava spunta e nome e restava
            cliccabile (è la `<label>` dell'input), ma niente lo diceva: né una
            «×», né un «Sostituisci», né una parola. Finché il campo era
            facoltativo sbagliare file costava poco; ora è l'allegato che decide
            se la candidatura parte, e chi ha caricato la foto sbagliata doveva
            indovinare che ri-toccando il riquadro il selettore si riapre.
            Una parola, DENTRO il bersaglio che già esiste: nessun secondo
            controllo da mantenere, nessun secondo punto di fuoco, e `aria-hidden`
            perché il nome accessibile dell'input è già la sua etichetta — questa
            è un'istruzione visiva, non un comando in più da annunciare. */}
        {value && !uploading && (
          <span aria-hidden="true" className="ml-auto shrink-0 text-xs text-kidville-sub">
            {t('sostituisci')}
          </span>
        )}
        {/* `sr-only` e NON `hidden`: fuori dalla vista, dentro l'albero di
            accessibilità e dentro l'ordine di tabulazione. Con lo `spazio` o
            l'`invio` il browser apre da sé il selettore di file — non serve
            nessun gestore di tastiera, serve che il controllo ci sia. */}
        <input
          id={fieldId}
          ref={inputRef}
          onBlur={onBlur}
          type="file"
          accept={acceptEff}
          className="sr-only"
          aria-busy={uploading || undefined}
          onChange={handleFile}
          {...ariaProps}
        />
      </label>
      {/* ── LA FINE DELL'ATTESA, DETTA A CHI NON VEDE LA ROTELLINA ─────────────
          WCAG 2.1 SC 4.1.3 (Status Messages, AA). Fino al 2026-08-25 `FileField`
          comunicava lo stato del caricamento SOLO con i pixel — `Loader2` →
          `FileCheck2` e il testo del riquadro — più `aria-busy` sull'`input`.
          `aria-busy` è una PROPRIETÀ dell'elemento, non un messaggio di stato:
          nessuno screen reader ne garantisce l'annuncio, e il cambio del nome
          accessibile di un controllo già a fuoco è comportamento non specificato.

          ⚠️ PERCHÉ È DIVENTATO UN DIFETTO PROPRIO ORA. Il 24/08 il curriculum è
          diventato obbligatorio, e con lui è nato «Attendi la fine del
          caricamento.»: un ORDINE di aspettare, dentro un `role="alert"`, sul solo
          campo che blocca il passo. Mandare qualcuno ad aspettare e poi non dirgli
          che l'attesa è finita lo lascia a ripremere «Avanti» a tentativi.

          ⚠️ FRATELLA DELLA `<label>`, NON DENTRO. Il testo del riquadro sta dentro
          la `<label>`, che compone il NOME accessibile dell'`input`: una regione
          viva là dentro annuncerebbe il nome del campo, non uno stato — e
          cambierebbe il nome di un controllo mentre lo si usa (WCAG 2.5.3).

          ⚠️ IL NODO C'È SEMPRE, anche vuoto. Una regione viva inserita nel DOM
          INSIEME al suo contenuto non viene annunciata: le tecnologie assistive
          osservano le mutazioni di una regione che era già lì. Comparire e
          annunciare sono due cose diverse, e la seconda pretende la prima.

          `polite` e non `assertive`: è un lavoro finito, non un guasto —
          interrompere la lettura in corso significherebbe troncare proprio il
          messaggio che dice di aspettare. È la stessa forma già usata per l'altra
          rotellina della pagina in `CandidaturaInsegnanteWizard`. */}
      <span id={fieldId ? `${fieldId}-stato` : undefined} className="sr-only" role="status" aria-live="polite">
        {uploading ? t('caricamentoAllegato') : value ? t('allegatoCaricato') : ''}
      </span>
      {/* Nativo: scatta la foto dell'allegato (solo se il campo ammette immagini).
          Fuori dalla <label> per non riaprire il file picker. Su web non compare.
          ⚠️ Lo stato spento si DIPINGE anche qui: portava `disabled:opacity-50`,
          cioè la stessa alfa che sul comando primario dei wizard è stata misurata
          a 2,02:1 (vedi `ComandiWizard`). La coppia è quella di `Btn` — `sub`
          #55615C su `neutral-soft` #F0F2F1, 5,75:1 — e nell'app nativa questo è
          il modo normale di consegnare la scansione del documento: spento è
          proprio mentre il caricamento è in volo, cioè quando si guarda. */}
      {consenteImmagini && (
        <ScattaFotoButton
          onFile={processaFile}
          label={t('scattaFoto')}
          // ⚠️ IL TESTO VISIBILE RESTA CORTO, IL NOME NO. «Scatta foto: Retro del
          // documento» dentro il bottone spezzerebbe la riga su 360 px; come nome
          // accessibile è l'unica cosa che distingue due bottoni identici a un
          // centimetro di distanza. E CONTIENE il testo visibile, che non è una
          // formalità: WCAG 2.5.3 («Label in Name») esiste perché chi comanda a voce
          // pronuncia ciò che legge, e un nome che non contiene le parole visibili
          // rende il bottone inattivabile invece che più chiaro.
          nomeAccessibile={etichettaCampo ? t('scattaFotoDi', { campo: etichettaCampo }) : undefined}
          disabled={uploading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-input border border-dashed border-kidville-green/30 text-sm font-medium text-kidville-green hover:border-kidville-green transition-colors disabled:cursor-not-allowed disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub"
        />
      )}
      {/* ── ERA L'UNICO MESSAGGIO D'ERRORE DEL MODULO SCRITTO PIÙ PIANO DEGLI
          ALTRI (12/08/2026) ──────────────────────────────────────────────────
          «Caricamento non riuscito. Riprova.» portava `text-kidville-error` a
          peso 400 e nessun ruolo. MISURATO forzando un 500 sulla rotta di
          caricamento: `rgb(229,57,53)` sul crema della pagina `rgb(254,241,228)`
          = **3,81:1**, l'unico testo della pagina sotto i 4,5:1 richiesti — e a
          due centimetri più in basso, sullo STESSO campo, il messaggio di
          `FieldRenderer` diceva la sua in `error-strong` e `font-bold`.
          In Alto Contrasto il colore spariva del tutto (nero, 21:1, come
          un'etichetta qualunque) e restava peso 400: cioè nessuno dei due
          segnali che la testata di questo file dichiara obbligatori.
          `role="alert"` perché senza, chi usa uno screen reader non sa nemmeno
          che il caricamento è fallito: è un guasto che nasce da un gesto
          riuscito (il file È stato scelto) e non annuncia niente da solo. */}
      {uploadError && (
        <p role="alert" className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong">
          <AlertCircle className="w-3.5 h-3.5" />
          {uploadError}
        </p>
      )}
      {/* ── ⚠️ QUI NON SI STAMPA IL PERCORSO NEL BUCKET (12/08/2026) ───────────
          C'era una riga in monospazio da 11 px con dentro il valore di `value`,
          cioè la chiave con cui si firma un oggetto di un bucket PRIVATO. La
          forma vera è `documenti/${uuid}/${uuid}.${est}`: MISURATO a 360 px sul
          modulo del personale, 87 caratteri in una scatola larga 315 px contro
          576 px di testo — 48 caratteri visibili su 87, troncati.
          Non diceva niente a chi compila: che la foto sia quella giusta lo dice
          il NOME DEL FILE, che sta già nella riga qui sopra. E lo stesso repo
          tratta quel valore come dato da non far uscire — `logClient` lo redige
          (vedi il `catch` più su) e il riepilogo del wizard del personale
          rifiuta esplicitamente di mostrarlo, perché una schermata si fotografa,
          si legge ad alta voce e finisce nelle segnalazioni di guasto. Redatto
          nei log, nascosto al riepilogo e stampato in pagina erano tre risposte
          diverse alla stessa domanda.
          Se un giorno servisse una conferma in più del caricamento riuscito, il
          posto è l'icona `FileCheck2` qui sopra, non il percorso. */}
    </div>
  )
}
