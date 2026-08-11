'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type {
  UseFormRegister,
  Control,
  FieldValues,
  RegisterOptions,
} from 'react-hook-form'
import { Controller, useWatch } from 'react-hook-form'
import {
  Upload, FileCheck2, Loader2, AlertCircle, PenLine, Info, ExternalLink,
} from 'lucide-react'
import { LinkInterno } from '@/components/ui/LinkInterno'
import type { FormField } from '@/types/database.types'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { limiteUploadByte, limiteUploadMb } from '@/lib/upload/limite-piattaforma'
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
export const SCELTA_STRUTTURA = 'gap-3 px-4 py-3.5 rounded-card cursor-pointer transition-all'
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

/** La classe di una card di scelta: la stessa per un'opzione, un consenso, una sede. */
export const classeScelta = (scelta: boolean, allineamento = 'items-center', nonValido = false) =>
  `flex ${allineamento} ${SCELTA_STRUTTURA} ${
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
  { allineamento, nonValido = false }: { allineamento?: string; nonValido?: boolean } = {},
) => ({
  className: classeScelta(scelta, allineamento, nonValido),
  ...(nonValido && !scelta ? { 'data-scelta-invalida': 'true' as const } : {}),
})

export function FieldRenderer({
  field,
  modelId,
  register,
  control,
  error,
  uploadEndpoint,
}: {
  field: FormField
  modelId: string
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  error: unknown
  /** Se valorizzato, gli upload passano da questo endpoint server (multipart) invece del client browser. */
  uploadEndpoint?: string
}) {
  const t = useTranslations('parentForms')
  // Regola unica di validazione: la STESSA `validateField` che rigira il server
  // (obbligatorietà + pattern/lunghezze/provincia/email/date/select). RHF mostra
  // sotto il campo il messaggio (in italiano) che ritorna. I blocchi `consent`
  // mantengono la loro regola dedicata (messaggio migliore).
  const rules = {
    validate: (value: unknown) => validateField(field, value) ?? true,
  }
  const errMsg = (error as { message?: string } | undefined)?.message
  const errorId = `${field.id}-error`
  // Accessibilità: input in errore marcato `aria-invalid` e collegato al testo
  // del messaggio via `aria-describedby` (il messaggio è testo visibile, non
  // solo colore).
  const ariaProps: React.AriaAttributes = errMsg
    ? { 'aria-invalid': true, 'aria-describedby': errorId }
    : {}
  // Tipi a controllo SINGOLO: la <label> esterna li etichetta direttamente
  // (htmlFor ↔ id). radio/checkbox/file hanno un gruppo di controlli o una label
  // propria annidata → la label esterna resta una didascalia senza htmlFor (per
  // non puntare a un id inesistente); il gruppo usa già `aria-describedby`.
  const CONTROLLO_SINGOLO = ['text', 'number', 'email', 'phone', 'date', 'textarea', 'select']
  const associaLabel = CONTROLLO_SINGOLO.includes(field.type)
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
    return (
      <Controller
        name={field.id}
        control={control}
        defaultValue={false}
        rules={field.required ? { validate: (v) => v === true || t('devAccettare') } : undefined}
        render={({ field: rhf }) => {
          const accettato = rhf.value === true
          return (
            <div className="space-y-1.5">
              <label
                {...propsScelta(accettato, {
                  allineamento: 'items-start',
                  nonValido: Boolean(errMsg),
                })}
              >
                <input
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
                  {...ariaProps}
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
                    <span className="block max-w-[29rem] text-kidville-sub mt-1 leading-relaxed">
                      {field.text}
                    </span>
                  )}
                </span>
              </label>
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
                  `py-3` + interlinea di `text-sm` = 44px, la stessa altezza dei
                  comandi principali del wizard.
                  `LinkInterno` e non `<a target="_blank">`: nella WebView di
                  Capacitor una scheda nuova non esiste e il sistema consegna
                  l'indirizzo a Safari — il genitore che sta leggendo come
                  vengono trattati i dati di suo figlio si ritrova fuori
                  dall'app. Stesso rimedio già applicato allo stesso testo in
                  `ComunicaAssenzaCard` (R25). Solo per gli indirizzi INTERNI:
                  un `link` esterno dichiarato dal template resta un `<a>`. */}
              {field.link && (
                <CollegamentoInformativa
                  href={field.link}
                  etichetta={field.link_label || t('leggiInformativa')}
                />
              )}
              {errMsg && (
                <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong">
                  <AlertCircle className="w-3.5 h-3.5" />
                  {errMsg}
                </p>
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

      {field.type === 'date' && (
        <input id={field.id} type="date" className={`${campoClasse} [color-scheme:light]`} {...autoCompleteProps} {...ariaProps} {...register(field.id, rules)} />
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
          ariaProps={ariaProps}
          descriveErrore={errMsg ? errorId : undefined}
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
              <div className="space-y-2" role="group" aria-describedby={errMsg ? errorId : undefined}>
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
                        {...ariaProps}
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
            />
          )}
        />
      )}

      {/* `font-bold` non è enfasi: è il SECONDO segnale, quello che sopravvive
          all'Alto Contrasto. Là il messaggio diventa #000000 su bianco — 21:1,
          identico a un'etichetta qualunque — e il colore smette di dire «errore».
          Il peso resta, e con lui il bordo doppio del campo (globals.css). */}
      {errMsg && (
        <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong">
          <AlertCircle className="w-3.5 h-3.5" />
          {errMsg}
        </p>
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
 */
function CollegamentoInformativa({ href, etichetta }: { href: string; etichetta: string }) {
  const classe =
    'inline-flex items-center gap-1.5 py-3 text-sm font-medium text-kidville-green underline'
  const contenuto = (
    <>
      {etichetta}
      <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
    </>
  )
  return href.startsWith('/') ? (
    <LinkInterno href={href} className={classe}>
      {contenuto}
    </LinkInterno>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classe}>
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
      } [color-scheme:light]`}
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
  ariaProps,
  descriveErrore,
  nonValido = false,
}: {
  field: FormField
  control: Control<FieldValues>
  register: UseFormRegister<FieldValues>
  rules: RegisterOptions<FieldValues, string>
  ariaProps: React.AriaAttributes
  descriveErrore?: string
  /** Il gruppo è in errore: le opzioni NON scelte portano il contorno rosso. */
  nonValido?: boolean
}) {
  const valore = useWatch({ control, name: field.id })
  // Come nel gruppo a spunta: il contorno rosso segnala il gruppo ANCORA VUOTO,
  // non il messaggio (che in `mode: 'onTouched'` sopravvive alla prima scelta).
  const vuoto = valore === undefined || valore === null || valore === ''
  return (
    <div className="space-y-2" role="radiogroup" aria-describedby={descriveErrore}>
      {(field.options ?? []).map((opt, i) => {
        const scelta = valore === opt.value
        return (
          <label key={i} {...propsScelta(scelta, { nonValido: nonValido && vuoto })}>
            <input
              type="radio"
              value={opt.value}
              className={SCELTA_CONTROLLO}
              {...ariaProps}
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
 * Il messaggio d'errore del SERVER, o `null` se non ce n'è uno leggibile.
 *
 * Tre strette, e ognuna ha un motivo:
 *  · si legge solo se il `content-type` è JSON — il corpo di un 413 di piattaforma è
 *    testo, e riversarlo in pagina mostrerebbe al genitore «FUNCTION_PAYLOAD_TOO_LARGE»;
 *  · si legge SOLO il campo `error`, che è quello che scriviamo noi nelle route;
 *  · si tronca. Non lancia mai: è il ramo che gestisce un errore, non il posto dove
 *    aprirne un secondo.
 */
async function messaggioDelServer(res: Response): Promise<string | null> {
  try {
    if (!/application\/json/i.test(res.headers.get('content-type') ?? '')) return null
    const body: unknown = await res.json()
    const msg = (body as { error?: unknown } | null)?.error
    return typeof msg === 'string' && msg !== '' ? msg.slice(0, 200) : null
  } catch {
    return null
  }
}

// ── Upload allegato (bucket form_attachments) ────────────────
export function FileField({
  modelId,
  value,
  onChange,
  uploadEndpoint,
  accept,
  maxSizeMb,
}: {
  modelId: string
  value: string
  onChange: (path: string) => void
  uploadEndpoint?: string
  /** Estensioni/MIME ammessi (default PDF + immagini). */
  accept?: string
  /** Dimensione massima in MB comunicata al server per la validazione. */
  maxSizeMb?: number
}) {
  const t = useTranslations('parentForms')
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Accept dinamico: mostra «Scatta foto» solo se il campo ammette immagini
  // (la fotocamera produce un JPG) — così non si aggiunge un trigger foto a un
  // input che accetta solo PDF/doc.
  const acceptEff = accept || '.pdf,.jpg,.jpeg,.png'
  const consenteImmagini = /image\/|\*|\.jpe?g|\.png|\.webp|\.gif|\.heic/i.test(acceptEff)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await processaFile(file)
  }

  async function processaFile(file: File) {
    setUploading(true)
    setUploadError(null)
    setFileName(file.name)

    try {
      // ── IL CONTROLLO DELLA TAGLIA STA QUI, PRIMA DI SPEDIRE. Non è una gentilezza
      // verso la rete mobile del genitore: sopra il tetto della piattaforma la
      // richiesta non arriva MAI alla nostra route (Vercel risponde 413
      // `FUNCTION_PAYLOAD_TOO_LARGE` con un corpo di testo), quindi nessun controllo
      // lato server potrebbe scattare e nessun messaggio nostro potrebbe uscire. Il
      // 31 luglio 2026 sono stati 41 tentativi in un giorno sul modulo pubblico.
      // Vedi `@/lib/upload/limite-piattaforma`.
      const limite = limiteUploadByte(maxSizeMb)
      if (file.size > limite) {
        // Il NOME del file non si logga mai: «certificato-mario-rossi.pdf» è un dato.
        // La dimensione sì: è un numero, ed è l'unica cosa che serve per sapere se il
        // tetto è tarato bene o se i genitori caricano foto da 12 MB.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `modulo-allegato-troppo-pesante: ${file.size} byte, limite ${limite}`,
        })
        setUploadError(t('fileTroppoPesante', { mb: limiteUploadMb(maxSizeMb) }))
        onChange('')
        return
      }

      // Upload SEMPRE via endpoint server (service-role, bucket privato deny-by-default).
      // Pubblico: token-scoped; autenticato: `/api/forms/upload` (requireUser). Niente
      // più scrittura diretta dal client anon (P0/DL-035).
      const endpoint = uploadEndpoint || '/api/forms/upload'
      const fd = new FormData()
      fd.append('file', file)
      fd.append('folder', modelId)
      if (maxSizeMb) fd.append('max_size_mb', String(maxSizeMb))
      const res = await fetch(endpoint, { method: 'POST', body: fd })

      // `res.ok` PRIMA di `res.json()`, ed è il difetto che questo ordine ripara: il 413
      // della piattaforma ha `content-type: text/plain`, quindi il parse LANCIAVA
      // `SyntaxError` e il genitore si vedeva «Caricamento non riuscito. Riprova.» —
      // l'invito a rifare l'unica cosa che non poteva funzionare. In `app_log` restava
      // `modulo-allegato-upload-fallito: SyntaxError`, che del 413 non diceva nulla.
      // (Il 413 in tabella ci finisce comunque, una volta sola: lo registra il patch di
      // `fetch` in `@/lib/logging/client`, che i 413 li tiene come anomalia.)
      if (!res.ok) {
        setUploadError(
          res.status === 413
            ? t('fileTroppoPesante', { mb: limiteUploadMb(maxSizeMb) })
            : (await messaggioDelServer(res)) ?? t('caricamentoNonRiuscito'),
        )
        onChange('')
        return
      }

      const json: unknown = await res.json()
      const path = (json as { path?: unknown } | null)?.path
      if (typeof path !== 'string' || path === '') throw new Error('risposta senza path')
      onChange(path)
    } catch (err) {
      // Un catch che non logga è un bug: l'upload fallito è invisibile a chi
      // non ha in mano il dispositivo. `logClient` redige il path e non lancia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `modulo-allegato-upload-fallito: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      setUploadError(t('caricamentoNonRiuscito'))
      onChange('')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <label
        className={`flex items-center gap-3 px-4 py-3 rounded-input border border-dashed cursor-pointer transition-all ${
          value
            ? 'border-kidville-green/40 bg-kidville-green-light'
            : 'border-kidville-green/20 bg-kidville-cream hover:border-kidville-green/30'
        }`}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 text-kidville-green animate-spin flex-shrink-0" />
        ) : value ? (
          <FileCheck2 className="w-4 h-4 text-kidville-green flex-shrink-0" />
        ) : (
          <Upload className="w-4 h-4 text-kidville-sub flex-shrink-0" />
        )}
        <span className="text-sm text-kidville-green/80 truncate">
          {uploading
            ? t('caricamento')
            : value
            ? fileName || t('allegatoCaricato')
            : t('selezionaFile')}
        </span>
        <input
          type="file"
          accept={acceptEff}
          className="hidden"
          disabled={uploading}
          onChange={handleFile}
        />
      </label>
      {/* Nativo: scatta la foto dell'allegato (solo se il campo ammette immagini).
          Fuori dalla <label> per non riaprire il file picker. Su web non compare. */}
      {consenteImmagini && (
        <ScattaFotoButton
          onFile={processaFile}
          label={t('scattaFoto')}
          disabled={uploading}
          className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-input border border-dashed border-kidville-green/30 text-sm font-medium text-kidville-green hover:border-kidville-green transition-colors disabled:opacity-50"
        />
      )}
      {uploadError && (
        <p className="flex items-center gap-1.5 text-xs text-kidville-error mt-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {uploadError}
        </p>
      )}
      {value && !uploading && (
        <p className="flex items-center gap-1.5 text-[11px] text-kidville-sub mt-1.5">
          <Info className="w-3 h-3" />
          <span className="font-mono truncate">{value}</span>
        </p>
      )}
    </div>
  )
}
