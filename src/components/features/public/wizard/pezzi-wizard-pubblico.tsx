'use client'

import type { ReactNode, Ref } from 'react'
import { useTranslations } from 'next-intl'
import type { FieldValues, UseFormRegister } from 'react-hook-form'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, ListChecks, Loader2, PartyPopper,
  type LucideIcon,
} from 'lucide-react'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL GUSCIO DEI MODULI PUBBLICI — una volta sola, per tutti e tre         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/iscrizione`, `/lavora-con-noi` e — dall'11/08/2026 — `/anagrafica-personale`
 * sono tre moduli diversi con lo STESSO guscio: barra di avanzamento, pallini
 * dei passi, testata del passo, impaginatura a due colonne, comandi, pannelli
 * d'errore e di conferma, colonna di contesto, esca per i compilatori
 * automatici. Ogni pezzo qui dentro porta con sé la misura che gli ha dato la
 * forma che ha: quelle misure sono state pagate una volta e non si ricopiano.
 *
 * ⚠️ QUESTO FILE È L'UNICO POSTO in cui possono comparire le classi della
 * griglia e della barra di avanzamento: lo verifica
 * `__tests__/architecture/wizard-pubblici-un-solo-guscio.test.ts`, che è il lock
 * nato per impedire al terzo modulo di ricopiare il guscio invece di usarlo.
 *
 * ── PERCHÉ I COMANDI NON SONO INCOLLATI IN FONDO ALLO SCHERMO ──────────────
 *
 * Il guscio non ha `flex-1`: i comandi stanno subito sotto il contenuto, a ogni
 * larghezza. Prima il contenitore si allungava fino in fondo alla finestra e
 * spingeva i bottoni contro il bordo inferiore, lasciando in mezzo un vuoto
 * misurato in 180 px a 360×740 (riepilogo), 230 al primo passo e 327 a 768: sul
 * telefono si legge come «manca qualcosa più sotto».
 *
 * E NON è una barra `sticky`: un piede appiccicato al fondo copre l'ultimo campo
 * del modulo, che è esattamente il difetto che questo repo ha già pagato su
 * «Comunica un'assenza» (il campo «Motivo» finito sotto il piede, e la misura che
 * ha mostrato che la leva era l'altezza della testata). Sui moduli pubblici
 * l'ultimo campo è spesso una textarea alta: sarebbe lo stesso guasto.
 *
 * Da `lg` in su la colonna di contenuto non si allarga — 65-75 caratteri per riga
 * restano il limite di leggibilità — ma le accanto compare una colonna di
 * CONTESTO, che è ciò che riempie i 384 px di crema per lato invece di stirare il
 * modulo.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1 · LA BARRA DI AVANZAMENTO
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * LA BARRA DI AVANZAMENTO, ED È IL PRIMO GIALLO DELLA PAGINA.
 * Il censimento dei colori calcolati, l'11/08/2026, contava ZERO elementi
 * con `#FDC400` in tutta la schermata: verde, crema, bianco e grigio — una
 * scuola per bambini con l'aria di un portale amministrativo. Il giallo
 * torna come ACCENTO, mai come inchiostro su bianco (1,6:1, e su questo il
 * repo ha già ragione da tempo): qui è la testa della barra, che sta sopra
 * il riempimento verde (4,05:1) e accanto alla traccia crema.
 * È decorativa e ridondante — «Passo N di M» dice la stessa cosa a parole —
 * quindi non porta informazione che il colore da solo debba reggere.
 *
 * La percentuale si calcola QUI e non al chiamante: `(indice + 1) / totale` è
 * la formula che una copia sbaglia (`indice / totale` lascia la barra a zero
 * sul primo passo e non arriva mai in fondo sull'ultimo).
 */
export function BarraAvanzamento({ indice, totale }: { indice: number; totale: number }) {
  const avanzamento = totale > 0 ? ((indice + 1) / totale) * 100 : 0
  return (
    /* ⚠️ L'ANELLO SULLA TRACCIA, ed è la stessa misura che i pallini qui sotto
       hanno già pagato — applicata allora ai pallini e non alla barra che sta
       sopra di loro. `bg-kidville-cream-dark` è elencata fra le classi che il
       blocco «1 · La carta» di `globals.css` porta a bianco: MISURATO l'12/08/2026
       sulla pagina viva con «Alto contrasto» acceso, la traccia leggeva
       `rgb(255,255,255)` su fondo `rgb(255,255,255)` — 1,00:1, `box-shadow: none`
       — mentre il riempimento restava scuro (`rgb(0,31,28)`). Cioè: della barra
       si vedeva un moncone che finiva nel nulla, e nulla diceva più quanto manca.
       L'anello è `ring-inset` e non un bordo: la regola
       `[data-contrast="high"] .kv-public [class*="border-kidville-"]` porterebbe
       un bordo a nero (visibile, ma un contorno nero in più su una superficie
       che ne ha già molti), mentre il `box-shadow` non viene toccato da nessuna
       regola per-superficie e `ring-kidville-green` porta l'hex inlinato da
       `@theme inline` — quindi resta verde in ENTRAMBE le modalità. `inset`
       perché la barra è alta 6 px e corre da vetro a vetro: un anello esterno
       aggiungerebbe una riga verde sopra e sotto, cioè un divisore che nessuno
       ha chiesto. */
    <div className="h-1.5 w-full bg-kidville-cream-dark ring-1 ring-inset ring-kidville-green">
      <div
        className="relative h-full bg-kidville-green transition-all duration-300"
        style={{ width: `${avanzamento}%` }}
      >
        <span aria-hidden="true" className="absolute right-0 top-0 h-full w-6 bg-kidville-yellow" />
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2 · I PALLINI DEI PASSI, E LA RIGA «PASSO N DI M»
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * I pallini dei passi e la riga che li dice a parole.
 *
 * `id` è quello con cui la testata del passo aggancia questa riga come propria
 * DESCRIZIONE (`aria-describedby`): arrivando su un passo nuovo il fuoco si posa
 * sull'`h2`, e chi ascolta sente il titolo seguito dalla posizione nella sequenza
 * («Il tuo profilo… Passo 3 di 5») invece del solo titolo. La riga esiste già a
 * schermo: non si aggiunge testo, si dichiara un legame.
 */
export function ContatorePassi({ id, indice, totale }: { id: string; indice: number; totale: number }) {
  const t = useTranslations('public')
  return (
    <p id={id} className="mt-2 flex items-center gap-2 text-xs font-medium text-kidville-sub">
      {/* I pallini dei passi: fatti (verde), corrente (GIALLO, con
          l'anello verde che lo stacca dal crema), da fare (crema
          scuro, CON un anello verde da 1 px). Sono `aria-hidden`
          perché la frase accanto dice già la stessa cosa a parole: il
          colore non porta da solo nessuna informazione.

          L'anello sui pallini DA FARE non è decorazione: senza, quei
          pallini si reggevano sul solo riempimento, e il riempimento è
          la cosa che l'Alto Contrasto ribalta. MISURATO l'11/08/2026
          con «Alto contrasto» acceso: `bg-kidville-cream-dark` finisce
          dentro il blocco «1 · La carta» di `globals.css` e diventa
          `rgb(255,255,255)` su fondo `rgb(255,255,255)` — 1,00:1, cioè
          quattro pallini su cinque semplicemente non c'erano, e al loro
          posto restava un vuoto largo quanto loro accanto al pallino
          giallo. In luce normale non stavano molto meglio: 1,12:1.
          L'anello è un `box-shadow`, non un `border-color`: la regola
          `[data-contrast="high"] .kv-public [class*="border-kidville-"]`
          non lo tocca, e il verde resta verde in entrambe le modalità —
          6,51:1 sul bianco dell'Alto Contrasto, 5,86:1 sul crema. È lo
          stesso mezzo con cui il pallino corrente si stacca dal fondo, e
          quello con cui i punti elenco della colonna di contesto si
          staccano dal loro. */}
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {Array.from({ length: totale }, (_, i) => (
          <span
            key={i}
            className={`h-2 w-2 rounded-pill ${
              i === indice
                ? 'bg-kidville-yellow ring-2 ring-kidville-green'
                : i < indice
                  ? 'bg-kidville-green'
                  : 'bg-kidville-cream-dark ring-1 ring-kidville-green'
            }`}
          />
        ))}
      </span>
      {/* La chiave è quella del modulo d'iscrizione, ed è deliberato:
          «Passo N di M» è una posizione in una sequenza, non un
          conteggio, ed è dichiarata come tale nell'allowlist del lock
          `messaggi-plurali-e-glossario` — un'allowlist che «può solo
          accorciarsi». Una seconda chiave identica con un altro nome
          sarebbe la stessa frase da mantenere in due posti. */}
      {t('wizardPassoDi', { corrente: indice + 1, totale })}
    </p>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3 · LA TESTATA DEL PASSO
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Il titolo del passo, con il quadrato giallo dell'icona e il sottotitolo.
 *
 * `titoloRef` è il bersaglio del fuoco quando il passo CAMBIA, e `contatoreId`
 * è l'`id` della riga «Passo N di M» che gli fa da descrizione.
 */
export function TestataPasso({
  icona: Icona,
  titolo,
  sotto,
  titoloRef,
  contatoreId,
}: {
  icona: LucideIcon
  titolo: string
  sotto: string
  titoloRef?: Ref<HTMLHeadingElement>
  contatoreId?: string
}) {
  return (
    <div className="mb-5 flex items-center gap-3">
      {/*
        L'ICONA DEL PASSO — e il verde che portava era di troppo.
        Era `text-kidville-success` su `bg-kidville-success-soft`:
        2,89:1, sotto il 3:1 degli elementi non testuali (formalmente
        esente perché `aria-hidden`, ma illeggibile lo stesso), ed era
        un QUARTO verde accanto agli altri tre della pagina — per di
        più il token del SUCCESSO, su una cosa che non è un successo
        ma «il passo che stai compilando». Adesso è il giallo di
        marchio con l'inchiostro verde, che `globals.css` porta a
        `green-ink` sulla coppia `bg-kidville-yellow .text-kidville-green`
        (più scuro di #006A5F su #FDC400, quindi sopra 4:1), e in Alto
        Contrasto la regola `.kv-public` lo manda a nero pieno.
      */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-kidville-yellow">
        <Icona className="h-4 w-4 text-kidville-green" aria-hidden="true" />
      </div>
      <div>
        {/* Il titolo del passo è un `h2`, COMPRESO quello dei consensi:
            sul wizard fratello quel ramo mancava, la catena di ternari
            cadeva sul ramo finale, e la schermata su cui si presta il
            consenso al trattamento si annunciava col titolo della
            pagina successiva. È la prima cosa che uno screen reader
            legge quando ci si arriva.

            La FORMA è quella dei titoli di questo repo — Barlow
            Condensed, maiuscolo — e non più Maven Pro 20 px minuscolo:
            due famiglie diverse a 4 px di distanza dall'`h1` non si
            leggevano come due livelli, si leggevano come due titoli in
            disaccordo. */}
        {/* `tabIndex={-1}` = raggiungibile col FUOCO ma non col Tab,
            esattamente come l'`h2` della conferma: serve solo perché
            l'effetto del cambio di passo possa posarci chi arriva, non
            per aggiungere una tappa alla tabulazione di tutti gli
            altri. `aria-describedby` gli aggancia la riga «Passo N di
            M», che sta già a schermo qualche riga più su. */}
        <h2
          ref={titoloRef}
          tabIndex={-1}
          aria-describedby={contatoreId}
          className="font-barlow text-lg font-bold uppercase tracking-wide leading-tight text-kidville-green"
        >
          {titolo}
        </h2>
        <p className="text-sm text-kidville-sub">{sotto}</p>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4 · L'IMPAGINATURA
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Il guscio della superficie pubblica.
 *
 * `kv-public` è il marcatore della superficie PUBBLICA: senza, l'Alto
 * Contrasto su questa pagina non cambia un pixel — i token si ribaltano, ma
 * il guscio è dipinto con utility il cui hex `@theme inline` ha già inlinato,
 * e le regole per-superficie di `globals.css` sono l'unico modo di
 * raggiungerlo.
 */
export function GuscioPubblico({ children }: { children: ReactNode }) {
  return (
    <div className="kv-public flex min-h-screen flex-col bg-kidville-cream text-kidville-ink">
      {children}
    </div>
  )
}

/**
 * La colonna centrale, e i suoi margini.
 *
 * Niente `flex-1` sul guscio: i comandi seguono il contenuto invece di
 * essere spinti in fondo alla finestra con un vuoto in mezzo (180 px al
 * riepilogo a 360×740, 327 a 768). Vedi il blocco in testa al file.
 *
 * IL MARGINE NON SI STRINGE MAI QUANDO LA FINESTRA SI ALLARGA.
 * Con `lg:max-w-5xl` (1024 px) e il solo `sm:px-5`, a 1024 px di finestra il
 * contenitore occupava il vetro per intero e restavano 20 px di riempimento:
 * MISURATO l'11/08/2026 sulla pagina viva (x dell'`h1` al variare della
 * larghezza) 360→16, 640→20, 768→68, **1024→20**, 1280→148, 1440→228. Cioè
 * allargando la finestra da 768 a 1024 il contenuto si AVVICINAVA al bordo
 * di 48 px, con la barra di avanzamento che corre da vetro a vetro sopra di
 * esso: la pagina sembra tagliata a sinistra, ed è la larghezza di un iPad
 * in orizzontale e di una finestra non massimizzata su un portatile da 13".
 * La curva dei margini dev'essere monotona, e per esserlo non basta
 * aggiungere riempimento: 59,5rem = 952 px = 888 px di contenuto + i 64 px
 * di `lg:px-8`, cioè a 1024 px restano 36 px di margine + 32 di riempimento
 * = 68, esattamente quanto a 768. Le due colonne ci stanno tutte (colonna
 * del modulo 592 + 40 di spazio + 256 di contesto).
 */
export function ColonnaCentrale({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-5 sm:py-8 lg:max-w-[59.5rem] lg:px-8">
      {children}
    </div>
  )
}

/**
 * La griglia del passo.
 *
 * TRE FIGLI, NON DUE — e il terzo esiste perché su `lg` i comandi
 * restino sotto il modulo mentre il contesto sta a destra.
 * Su `lg` la griglia colloca a mano: contenuto in (1,1), contesto in
 * (2,1), comandi in (1,2). Sotto `lg` la griglia non c'è: è una colonna
 * flex, e l'ordine si decide con `order`.
 *
 * ── SOTTO `lg` IL CONTESTO STA DOPO I COMANDI. E il perché è misurato.
 * Fino all'11/08/2026 stava PRIMA, cioè incastrato fra i campi e i
 * bottoni a OGNI passo. Al primo passo — tre card di sede, un tocco solo
 * — la prima schermata di un telefono finiva con 262 px di testo
 * esplicativo e nessun bottone: MISURATO a 360×740 con la sede già
 * scelta, docH 827, riquadro «Dopo l'invio» da y 457 a y 719, «Avanti»
 * a y 759, cioè 19 px SOTTO la piega — e su un telefono vero, dove la
 * barra del browser mangia 60-120 px, molto più giù. Chi apre il link da
 * WhatsApp sceglie la sede e non vede niente da premere. Al riepilogo lo
 * stesso riquadro si infilava fra l'ultima card dei propri dati e «Invia
 * candidatura».
 * L'ordine di prima era stato scelto per una ragione vera — la frase
 * «controlla che l'email sia giusta prima di inviare» non deve stare
 * dopo il bottone d'invio — ma quella ragione riguarda UNA riga e UN
 * passo: adesso quella riga è scritta dov'è utile, nel riepilogo, sopra
 * i comandi (`candRiepilogoControllaEmail`). Il resto del riquadro
 * racconta cosa succede DOPO l'invio, e dopo i comandi ci sta bene.
 *
 * Lo spostamento è nel DOM e non con `order`: sotto `lg` l'ordine di
 * lettura di uno screen reader e l'ordine di tabulazione seguono il
 * documento, non il foglio di stile, e un riquadro che a schermo sta
 * dopo i comandi ma nel documento prima è la stessa incoerenza vista da
 * un'altra parte. Da `lg` in su non cambia nulla comunque: i tre figli
 * hanno una collocazione ESPLICITA nella griglia, che non dipende
 * dall'ordine in cui sono scritti.
 * `gap-x-10` e non `gap-10`: la riga dei comandi porta già il suo
 * `mt-4`/`pt-6`, e un `row-gap` di 40 px la staccherebbe dal modulo.
 */
export function GrigliaPasso({
  contenuto,
  comandi,
  contesto,
}: {
  contenuto: ReactNode
  /** I comandi e l'avviso d'invio fallito che li precede: stanno insieme perché
      il pannello «non siamo riusciti a inviare» parla del bottone che gli sta
      sotto, e separarli li farebbe finire in due colonne diverse. */
  comandi: ReactNode
  /** La colonna di contesto, che si colloca da sé nella seconda colonna. */
  contesto: ReactNode
}) {
  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start lg:gap-x-10">
      <div className="lg:col-start-1 lg:row-start-1">{contenuto}</div>
      <div className="lg:col-start-1 lg:row-start-2">{comandi}</div>
      {contesto}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5 · I COMANDI
 * ──────────────────────────────────────────────────────────────────────── */

/** Il comando di ritorno. `null` = non c'è: vedi il perché sotto. */
export interface ComandoIndietro {
  etichetta: string
  onClick: () => void
  disabilitato?: boolean
}

/**
 * Il comando primario, e ciò che sta per succedere quando lo si preme.
 *
 * IL COMANDO DICE DOVE PORTA, e quando si è entrati dal riepilogo
 * porta al riepilogo. Quattro versi e non due: `invio` sull'ultimo passo,
 * `riepilogo` finché il segno del ritorno è acceso, `avanti` nel percorso
 * normale, `inCorso` mentre la richiesta è in volo. L'icona segue
 * l'etichetta — la lista spuntata è il riepilogo, la freccia è il
 * passo dopo — così non ci sono due comandi con lo stesso segno
 * che fanno cose diverse.
 */
export interface ComandoAvanti {
  etichetta: string
  onClick: () => void
  disabilitato?: boolean
  verso: 'avanti' | 'riepilogo' | 'invio' | 'inCorso'
}

/**
 * ─── LO STATO SPENTO SI DIPINGE, E MENTRE SI LAVORA NON SI SPEGNE AFFATTO ────
 *
 * Due difetti gemelli, misurati il 12/08/2026 sul modulo del personale, e
 * entrambi già chiusi altrove in questo repo — su `Btn` (`src/components/ui/Btn.tsx`,
 * blocco in testa) e su «Comunica un'assenza» — ma non qui, perché il guscio dei
 * moduli pubblici non passa da `Btn` e quei lock leggono solo `Btn`.
 *
 * **1. `disabled` non è il modo di dire «sto lavorando».** Mettendo `disabled` al
 * comando primario mentre l'invio è in volo, Chrome sfila il fuoco da un elemento
 * che si disabilita: MISURATO col fuoco sul bottone «INVIA L'ANAGRAFICA», clic,
 * risposta ritardata di 2200 ms → `document.activeElement === document.body`, e
 * ci restava anche dopo il rifiuto 503. Chi naviga da tastiera preme «Invia», il
 * fuoco cade all'inizio del documento e per sapere se è successo qualcosa deve
 * ritabulare l'intero riepilogo — 5 «MODIFICA» e 33 righe. Ora quel caso porta
 * `aria-disabled` più una guardia nel gestore: il bottone resta focalizzabile,
 * resta annunciato, cambia nome («INVIO…») ed è quello il messaggio.
 * Il `disabled` VERO resta dove il comando è davvero inerte e non è successo
 * niente che riguardi il fuoco: il passo «sede» senza un elenco da cui scegliere.
 *
 * **2. Lo stato spento si sbiadiva.** `disabled:opacity-50` sul primario e
 * `disabled:opacity-30` su «Indietro» abbassano IN BLOCCO riempimento e
 * inchiostro: MISURATO su «INVIO…», inchiostro `rgb(255,218,92)` su
 * `rgb(0,106,95)` — nominale 4,78:1, **reale 2,02:1** una volta composto al 50 %
 * sulla crema `rgb(254,241,228)`. Cioè l'unico segnale visivo che il gesto sia
 * partito era proprio quello che svaniva. La coppia qui sotto è la stessa di
 * `Btn` e vale **5,75:1** (`sub` #55615C su `neutral-soft` #F0F2F1), col contorno
 * `neutral` che dice ancora dove comincia il comando (1.4.11): nessuna alfa, così
 * il rapporto non dipende da ciò che sta sotto.
 *
 * ⚠️ IL BORDO STA NELLA BASE, IL SUO COLORE NELLO STATO. Il contorno dello stato
 * spento è largo 1 px: dichiararlo solo lì farebbe allargare il bottone di 2 px
 * nell'istante in cui si preme. E il colore non può stare in due posti — fra
 * `border-transparent` e `border-kidville-neutral` scritte sullo stesso elemento
 * vince quella che sta più avanti nel FOGLIO, non quella scritta dopo nella
 * stringa (è la stessa trappola documentata in `FieldRenderer.tsx`, blocco «I tre
 * pezzi»): l'unico modo di sceglierla è non averle entrambe.
 */
const COMANDO_SPENTO =
  'cursor-not-allowed border-kidville-neutral bg-kidville-neutral-soft text-kidville-sub'

export function ComandiWizard({
  indietro,
  avanti,
}: {
  indietro: ComandoIndietro | null
  avanti: ComandoAvanti
}) {
  /** L'invio è in volo: il comando è un MESSAGGIO, non un controllo spento. */
  const inVolo = avanti.verso === 'inCorso'
  const avantiSpento = avanti.disabilitato === true
  const indietroSpento = indietro?.disabilitato === true

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-kidville-line pt-6">
      {/*
        «INDIETRO» AL PRIMO PASSO NON C'È, invece di esserci spento.
        Portava `disabled:opacity-30` su testo `text-kidville-sub`: 1,3:1 sul
        crema, cioè non un comando disabilitato ma un fantasma — si legge
        come un pezzo di interfaccia rotto. Uno spazio vuoto dice la
        stessa cosa («da qui non si torna indietro») senza chiedere a
        nessuno di decifrare un grigio.
        (L'`opacity` non c'è più nemmeno negli altri passi: dal 12/08/2026 lo
        stato spento si DIPINGE — vedi `COMANDO_SPENTO` qui sopra. Questo
        comando resta comunque assente al primo passo: un comando che non porta
        da nessuna parte è meglio non renderlo affatto.)
        Il bottone «Avanti» tiene la sua posizione a destra da solo, con
        `ml-auto`: `justify-between` con un figlio solo lo porterebbe a
        sinistra, e i comandi salterebbero da un lato all'altro fra il
        primo passo e il secondo.
      */}
      {indietro !== null && (
        <button
          type="button"
          /* «Indietro» si spegne SOLO mentre l'invio è in volo (è l'unico uso
             che ne fanno i due moduli), cioè esattamente il caso in cui il
             fuoco non va rubato: `aria-disabled` e guardia, mai `disabled`. */
          onClick={() => {
            if (indietroSpento) return
            indietro.onClick()
          }}
          aria-disabled={indietroSpento || undefined}
          className={`flex items-center gap-2 rounded-pill border px-4 py-3 font-barlow text-sm font-bold uppercase tracking-wide transition-all ${
            indietroSpento
              ? COMANDO_SPENTO
              : 'border-transparent text-kidville-sub hover:bg-kidville-green-soft hover:text-kidville-green'
          }`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {indietro.etichetta}
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          // La guardia è ciò che `aria-disabled` NON fa da solo: l'attributo
          // dichiara lo stato, non impedisce il clic.
          if (avantiSpento) return
          avanti.onClick()
        }}
        /* `disabled` solo quando il comando è DAVVERO inerte e nessuno ha appena
           premuto niente (passo «sede» senza elenco). In volo no: vedi il blocco
           qui sopra. */
        disabled={avantiSpento && !inVolo}
        aria-disabled={avantiSpento || undefined}
        /* `aria-busy` sul bottone che sta lavorando: è l'attributo che dice
           «questa cosa sta cambiando», ed è la controparte del nome che nel
           frattempo è diventato «Invio…». */
        aria-busy={inVolo || undefined}
        /* `py-3` e non `py-2.5`: 24 px di riempimento + 20 px di riga =
           44 px, il bersaglio raccomandato per un pollice (WCAG 2.5.5
           AAA / 2.5.8 «Target Size Minimum» ne chiede 24, che questi
           comandi passavano già a 40 px — ma 40 px su un modulo pubblico
           che si compila dal telefono restano quattro sotto la misura
           che tutti raccomandano, e costano solo 4 px). */
        /* TRE ASPETTI, non due — e il terzo è il motivo di tutto il blocco in
           testa. IN VOLO il comando tiene il verde e l'inchiostro pieni
           (4,78:1): «INVIO…» è l'unico segnale che il gesto sia partito, e
           spegnerlo o sbiadirlo cancella proprio quello. Cambia solo il
           puntatore, e sparisce l'`hover`, che su una cosa che sta già
           lavorando prometterebbe un secondo clic. */
        className={`ml-auto flex items-center gap-2 rounded-pill border px-6 py-3 font-barlow text-sm font-bold uppercase tracking-wide transition-all ${
          inVolo
            ? 'cursor-wait border-transparent bg-kidville-green text-kidville-yellow-ink'
            : avantiSpento
              ? COMANDO_SPENTO
              : 'border-transparent bg-kidville-green text-kidville-yellow-ink hover:bg-kidville-green-dark'
        }`}
      >
        {avanti.verso === 'inCorso' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : avanti.verso === 'invio' ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : null}
        <span>{avanti.etichetta}</span>
        {avanti.verso === 'riepilogo' && <ListChecks className="h-4 w-4" aria-hidden="true" />}
        {avanti.verso === 'avanti' && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6 · IL PANNELLO D'ERRORE D'INVIO
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * L'invio è fallito. Sta SOPRA i bottoni, dentro la pagina — e non in un
 * `alert()`: chi ha appena premuto «Invia» deve leggere, senza chiudere niente,
 * che il lavoro fatto non è andato perduto.
 *
 * Sono due righe di testo e non una perché la seconda NON è sempre «premi di
 * nuovo Invia»: quando il rifiuto riguarda la sede, ripremere darebbe la stessa
 * risposta all'infinito, e la frase deve mandare al passo che nel frattempo è
 * ricomparso.
 */
export function PannelloErroreInvio({
  titolo,
  corpo,
  nota,
  riferimento,
}: {
  titolo: string
  corpo: string
  nota: string
  /** L'ancoraggio del fuoco, quando chi compila l'ha appena perso. */
  riferimento?: Ref<HTMLDivElement>
}) {
  return (
    <div
      role="alert"
      /* `tabIndex={-1}` = raggiungibile col FUOCO ma non col Tab, come
         l'`h2` della conferma: serve solo perché l'effetto del rifiuto
         possa posarci chi ha appena perso l'appiglio, non per
         aggiungere una tappa alla tabulazione di tutti gli altri. */
      ref={riferimento}
      tabIndex={-1}
      className="mt-4 rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {titolo}
      </p>
      {/* ── IL TETTO DI LARGHEZZA, E QUI VALE PIÙ CHE ALTROVE (12/08/2026) ────
          MISURATE con un `Range` sui nodi di testo, carattere per carattere:
          **107 · 108 · 111** caratteri per riga a 768 px e 96 · 104 · 104 a
          1440. Sono righe da 12 px, e a un centinaio di caratteri l'occhio
          perde il capo della riga successiva — su un testo che si legge quando
          l'invio è appena stato rifiutato, cioè nel momento peggiore per
          chiedere a qualcuno di rileggere due volte.
          26rem = 416 px = 75 caratteri: la misura è quella già fatta sulla
          stessa pagina per il banner «Ti serve il documento d'identità»
          (384 → 70 · 400 → 70 · **416 → 75** · 432 → 78), e si scrive in rem
          perché `ch` è la larghezza dello ZERO e dichiara un numero mentre ne
          produce un altro. Il titolo non lo porta: è una riga corta e sola. */}
      <p className="mt-1 max-w-[26rem] text-xs leading-relaxed text-kidville-ink">{corpo}</p>
      <p className="mt-1 max-w-[26rem] text-xs leading-relaxed text-kidville-ink">{nota}</p>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7 · IL PANNELLO DI CONFERMA
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * LA CONFERMA È IL MOMENTO PIÙ IMPORTANTE DEL MODULO, E VA ANNUNCIATA.
 *
 * Questo pannello SOSTITUISCE l'intero blocco dei passi: il bottone «Invia»
 * appena premuto viene smontato, e con lui se ne va il fuoco della tastiera,
 * che cade su `<body>`. Senza le due righe qui sotto chi usa uno screen reader
 * preme «Invia», torna in cima al documento e non sente niente: indistinguibile
 * da una pagina che si è rotta, sul solo schermo che dice che l'invio è partito.
 *
 * `jest-axe` non poteva vederlo — l'assenza di una regione live non è
 * una violazione axe — e infatti gli 11 controlli di accessibilità
 * passavano lo stesso. Il presidio è il test che asserisce l'annuncio,
 * non la sonda automatica.
 *
 * `role="status"` (che implica `aria-live="polite"`) annuncia il
 * pannello a chi non guarda; il fuoco sull'`h2` (`tabIndex={-1}`, non
 * raggiungibile col Tab) rimette chi usa la tastiera dentro il
 * contenuto nuovo invece che all'inizio del documento.
 */
export function PannelloConferma({
  titolo,
  corpo,
  riferimento,
}: {
  titolo: string
  corpo: string
  /** L'`h2` a cui portare il fuoco: l'invio l'ha appena distrutto. */
  riferimento?: Ref<HTMLHeadingElement>
}) {
  return (
    <div role="status" className="flex flex-col items-center py-12 text-center">
      {/* QUI il verde del successo è al suo posto: l'invio È
          partito. È l'unico punto della pagina in cui `success` dice la
          verità — l'icona del passo, che lo usava per «stai compilando il
          passo 2», porta il giallo di marchio. */}
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-card bg-kidville-success-soft">
        <PartyPopper className="h-8 w-8 text-kidville-success" aria-hidden="true" />
      </div>
      <h2 ref={riferimento} tabIndex={-1} className="text-xl font-semibold text-kidville-green">
        {titolo}
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-kidville-sub">{corpo}</p>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8 · LA COLONNA DI CONTESTO
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * LA COLONNA DI CONTESTO — ed è ciò che riempie i 300 px di crema per
 * lato a 1440, invece di stirare il modulo.
 * Da `lg` in su è la seconda colonna della griglia e SI MUOVE COL
 * CONTENUTO (`lg:sticky lg:top-6`): ferma in cima lasciava 1022 px di
 * colonna destra vuoti su 1362 di griglia al passo del riepilogo (75%
 * dell'altezza), e la frase che dice di ricontrollare l'email era già
 * uscita dallo schermo quando si arrivava al pulsante d'invio.
 * Sotto `lg` non c'è griglia e conta l'ordine del documento: sta
 * DOPO i comandi, che è il motivo per cui è il terzo figlio della
 * griglia (il perché misurato è nel commento di `GrigliaPasso`).
 * Un solo nodo, quindi nessun testo scritto due volte.
 *
 * ⚠️ IL TESTO NON PROMETTE PIÙ DEL PANNELLO DI CONFERMA, ed è la sola
 * regola che lo governa. Sul modulo delle candidature `candInviataCorpo`
 * dice che la Direzione valuta e risponde, e che le credenziali arrivano
 * SE la candidatura è accolta: nessun termine, nessuna garanzia. Perciò
 * qui non c'è «ti rispondiamo entro N giorni» — sarebbe una promessa che
 * nessuna parte del prodotto mantiene, scritta proprio a chi cerca lavoro.
 */
export function ColonnaContesto({ titolo, voci }: { titolo: string; voci: string[] }) {
  return (
    /* `<div>` e non `<aside>`: le pagine pubbliche di questo repo un
       `<main>` CE L'HANNO, quindi un `aside` in questo punto sarebbe un
       landmark `complementary` annidato dentro `main` — il rilievo axe
       `landmark-complementary-is-top-level`.
       Per essere un `aside` legittimo dovrebbe stare FUORI dal `<main>`,
       e non può: è la seconda colonna della griglia da `lg` in su
       (`lg:col-start-2`), e sotto `lg` il suo posto nell'ordine del
       documento — dopo i comandi — è misurato e sorvegliato da un test.
       Resta un `<div>`, e resta navigabile perché ha la sua `h2`. */
    <div className="mt-8 rounded-card border border-kidville-line bg-kidville-cream-dark px-4 py-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:mt-0">
      <h2 className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green">
        {titolo}
      </h2>
      {/* ── E ANCHE QUI IL TETTO, che da `lg` in su non serve e sotto sì ──────
          Da `lg` la colonna è larga 256 px e le righe rientrano da sole; nella
          fascia in cui il riquadro corre per tutta la larghezza no. MISURATE
          sulla pagina viva: **96 · 101 · 98** caratteri a 640 px e **106 · 101
          · 104** da 768 a 1023, in un riquadro largo 600-632 px. Non è testo
          decorativo: dice che il modulo non crea nessun accesso e per quanto
          tempo si conserva la copia del documento d'identità.
          Il tetto sta sulla riga e non sul riquadro: il riquadro ha il suo
          riempimento e il suo fondo, e stringerlo lascerebbe una colonna di
          crema dentro il crema. 26rem = 416 px = 75 caratteri, la stessa misura
          del banner del documento. */}
      <ul className="mt-2 space-y-2.5">
        {voci.map((riga) => (
          <li key={riga} className="flex max-w-[26rem] gap-2 text-xs leading-relaxed text-kidville-ink">
            <span
              aria-hidden="true"
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-kidville-yellow ring-1 ring-kidville-green"
            />
            {riga}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9 · L'ESCA (HONEYPOT)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * L'ESCA, e va montata DENTRO il contenuto del passo, perché deve esistere in
 * ogni passo del modulo: react-hook-form conserva i valori dei campi smontati,
 * ma un campo che non viene montato MAI non è registrato affatto e l'esca non
 * scatterebbe. È nascosta agli occhi (`hidden`) e agli screen reader
 * (`aria-hidden`), fuori dall'ordine di tabulazione, e senza autocompletamento:
 * nessuna persona la trova, nessun assistente vocale la annuncia. Un
 * compilatore automatico che riempie ogni `input` sì.
 *
 * `nome` è anche l'`id`: le rotte pubbliche accettano `sito_web` e `honeypot`
 * come sinonimi, e si manda il primo — quello che un compilatore automatico
 * riempie più volentieri. Un modulo che l'esca non la rende affatto è una difesa
 * che non scatta mai, cioè una difesa che sembra esserci.
 */
export function EscaHoneypot({
  nome,
  etichetta,
  register,
}: {
  nome: string
  etichetta: string
  register: UseFormRegister<FieldValues>
}) {
  return (
    <div hidden aria-hidden="true">
      <label htmlFor={nome}>{etichetta}</label>
      <input id={nome} type="text" tabIndex={-1} autoComplete="off" {...register(nome)} />
    </div>
  )
}
