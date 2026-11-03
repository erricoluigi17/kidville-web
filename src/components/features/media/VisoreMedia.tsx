'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { rendiInerteFuoriDaConFocus } from '@/lib/accessibility/inerti';
import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro';
import type { TipoMedia } from '@/lib/native/scarica';

/**
 * DOVE SI MONTA IL PORTALE: `document.body`, TRANNE nel cockpit della Direzione/Segreteria.
 *
 * Lì la cornice persistente (il binario a 88 px dei tablet in verticale, la sidebar da 16rem
 * da 1024 px) non deve MAI essere coperta da un overlay a tutto schermo: lo dice
 * `globals.css`, dove la regola `[data-cockpit-content] .fixed.inset-0 { left: var(--kv-rail-w) }`
 * (da 744 px) fa partire ogni overlay `fixed inset-0` DOPO la navigazione. Il visore stava
 * dentro quell'area quando viveva in `MediaGrid`; col portale su `body` ne usciva e la regola
 * non lo vedeva più: il visore dipingeva a `z-[115]` sopra binario, sidebar e topbar (trovato
 * dalla revisione del 2026-11-03).
 *
 * Si poteva ridefinire `--kv-rail-w` fuori dal guscio (`:root:has(…)`) e ripetere la regola
 * per un secondo selettore: due posti per le stesse larghezze, e niente sulle WebView che non
 * conoscono `:has()` (iOS 15.0–15.3). Montando il portale NELL'AREA CONTENUTO la regola che
 * esiste già copre da sola la radice del visore e il `Modal` di conferma che ci sta dentro
 * (anch'esso `fixed inset-0`), come prima, senza una riga di CSS in più.
 *
 * Fuori dal cockpit (genitore, docente, chat) il selettore non trova niente e il visore resta
 * figlio di `body`, a tutto schermo: lì la cornice, sul tablet, va coperta (lock
 * `visore-media-sopra-la-bottom-nav`). Il lock `visore-rispetta-la-cornice-del-cockpit` tiene
 * insieme le due metà: la regola in `globals.css` e questo selettore.
 */
const AREA_CONTENUTO_COCKPIT = '[data-cockpit-content]';

function dovePortare(): HTMLElement {
    return document.querySelector<HTMLElement>(AREA_CONTENUTO_COCKPIT) ?? document.body;
}

/**
 * UN MEDIA DEL VISORE, ridotto a ciò che il visore deve sapere per mostrarlo.
 *
 * Il visore non conosce didascalie, tag, autori o messaggi: chi lo usa tiene i propri
 * dati e gli passa questa vista minima. `url` è `null` quando la firma non è riuscita
 * (bucket privato): il visore lo dice a schermo invece di mostrare un riquadro rotto.
 */
export interface MediaVisore {
    id: string;
    url: string | null;
    tipo: TipoMedia;
    alt: string;
}

export interface VisoreMediaProps {
    /** I media fra cui si scorre con le frecce, nell'ordine in cui si scorrono. */
    elementi: MediaVisore[];
    /**
     * L'`id` del media aperto; `null` = chiuso.
     *
     * ⚠️ Un id che NON è fra gli `elementi` vale «chiuso»: non c'è niente da mostrare, e un
     * visore invisibile non si iscrive al tasto Indietro (si porterebbe via un Indietro che
     * deve navigare). Chiuderlo davvero — azzerare l'id — resta di chi lo usa: il visore non
     * chiama `onChiudi` da solo, perché non è un gesto dell'utente.
     */
    apertoId: string | null;
    /** Le frecce ‹ › e i tasti ← →: chiede di passare al media con quell'id. */
    onCambia: (id: string) => void;
    /**
     * ✕, `Escape`, tocco sullo scroller e tasto Indietro di Android.
     *
     * LA GUARDIA LA FA CHI CHIAMA: il visore non sa se in quel momento si può chiudere (in
     * Foto non si chiude mentre un'eliminazione è in volo). Una chiusura rifiutata non è un
     * errore: la funzione ritorna e basta, e il visore resta com'è.
     */
    onChiudi: () => void;
    /** Il nome del dialogo: l'annuncio dello screen reader all'apertura. */
    etichetta: (m: MediaVisore) => string;
    /**
     * Un dialogo figlio è aperto (la conferma di eliminazione): frecce, ← → ed `Escape` non
     * fanno niente. `Escape` lo gestisce già il dialogo, ma le frecce arriverebbero qui e
     * cambierebbero il media dietro di lui.
     */
    tastiBloccati?: boolean;
    /** Dentro la colonna, sotto il media: didascalia, tag, comandi, elimina. */
    children?: React.ReactNode;
    /**
     * FRATELLI DELLO SCROLLER, dentro il visore: il dialogo di conferma. Il perché sta
     * sul punto in cui vengono resi, qui sotto.
     */
    sovrapposti?: React.ReactNode;
}

/**
 * IL VISORE DEI MEDIA — UNO SOLO, per la galleria e per la chat.
 *
 * Viveva dentro `MediaGrid`; estratto il 2026-11-03 perché la chat ne aveva bisogno e due
 * visori divergono (è il difetto che `native/share.ts` dice di aver tolto dalla galleria:
 * i pulsanti scritti due volte). Il comportamento è quello di prima, con due eccezioni
 * volute:
 *
 *  · **PORTALE FUORI DALLA PAGINA** (`document.body`, o l'area contenuto del cockpit: vedi
 *    `dovePortare`). La conversazione mobile della chat è un `fixed inset-0 z-[60]`, cioè un
 *    contesto d'impilamento: un visore reso lì dentro resterebbe chiuso a 60, sotto la
 *    bottom-nav e il chrome del cockpit, qualunque `z-` si scriva sulla sua radice. Fuori da
 *    ogni antenato, il `z-[115]` torna a contare. Si monta solo da aperto e solo se
 *    `document` esiste, quindi la prima resa (server compresa) non cambia.
 *  · **TASTO INDIETRO DI ANDROID.** Prima, con il visore aperto, Indietro usciva dalla
 *    pagina; adesso chiude il visore (`useOverlayIndietro`, come `ui/Modal`). Con il
 *    dialogo di conferma aperto quello è più in alto nella pila e si chiude per primo.
 */
export function VisoreMedia({
    elementi,
    apertoId,
    onCambia,
    onChiudi,
    etichetta,
    tastiBloccati = false,
    children,
    sovrapposti,
}: VisoreMediaProps) {
    const t = useTranslations('shared');
    const visoreRef = useRef<HTMLDivElement>(null);

    const indice = apertoId === null ? -1 : elementi.findIndex((m) => m.id === apertoId);
    const corrente = indice >= 0 ? elementi[indice] : undefined;
    const visoreAperto = corrente !== undefined;

    // Il contenitore si sceglie UNA volta per apertura: se cambiasse a visore aperto, React
    // smonterebbe e rimonterebbe il portale (fuoco compreso) sotto gli occhi di chi guarda.
    const contenitore = useMemo(
        () => (visoreAperto && typeof document !== 'undefined' ? dovePortare() : null),
        [visoreAperto],
    );

    useOverlayIndietro(visoreAperto, onChiudi);

    /**
     * IL VISORE È UNA FINESTRA MODALE, E SI COMPORTA COME TALE.
     *
     * ─── COSA MANCAVA, misurato il 2026-09-11 ────────────────────────────────
     * Rendere la card un comando da tastiera (WCAG 2.1.1) senza portarci il fuoco
     * ha spostato il difetto, non l'ha chiuso: premendo Invio il visore si apriva,
     * il fuoco restava sulla card — che da quell'istante sta DIETRO un velo opaco a
     * tutto schermo — e per raggiungere «Elimina Media» bisognava tabulare
     * attraverso l'intera griglia, perché il visore è reso DOPO di lei nel DOM: 30
     * tappe con 10 foto, 120 con 40. Sono WCAG 2.4.3 (ordine del fuoco) e 2.4.11
     * (fuoco non coperto) al posto di quella che si stava chiudendo.
     *
     * ─── PERCHÉ NON BASTA `aria-modal="true"` ────────────────────────────────
     * Perché su un `div` non esclude NIENTE: Chromium lo onora solo per il top
     * layer (`<dialog>` + `showModal()`). È scritto per esteso in testa a
     * `@/lib/accessibility/inerti`, e misurato su Android il 2026-07-31 — col dump
     * dell'albero di accessibilità che mostrava ancora i comandi della pagina sotto
     * la modale. L'attributo senza l'inerzia dello sfondo è decorazione.
     *
     * ─── IL PEZZO NON SI RISCRIVE: È GIÀ IN CASA ─────────────────────────────
     * `rendiInerteFuoriDaConFocus` è lo stesso di `Modal` e di `PageLoader` (e il
     * registro dei nodi marcati è CONDIVISO, che è ciò che regge il caso «visore
     * aperto mentre parte una navigazione»). Fa tre cose in una: marca `inert` tutto
     * fuori dal visore — da cui il contenimento del Tab, gratis e senza trappola
     * scritta a mano —, ricorda chi aveva il fuoco e glielo restituisce alla
     * chiusura, e non lo ruba se nel frattempo è finito altrove.
     *
     * Dal portale in poi il visore è figlio diretto di `body` (o dell'area contenuto del
     * cockpit): i nodi che marca sono i suoi fratelli, e quelli dei suoi antenati — fuori
     * dal cockpit la radice dell'app intera, dentro il cockpit anche binario, sidebar e
     * topbar, come quando il visore stava in `MediaGrid`. `inert` si eredita lungo il
     * sottoalbero, quindi la griglia (o la chat) dietro il velo è inerte anche se non è
     * lei il nodo marcato.
     *
     * ⚠️ LA DIPENDENZA È «È APERTO», NON «QUALE MEDIA». Con l'id del media fra le
     * dipendenze ogni freccia avanti/indietro rifarebbe girare l'effetto e strapperebbe
     * il fuoco dalla freccia appena premuta, a ogni foto.
     */
    useEffect(() => {
        const radice = visoreRef.current;
        if (!radice) return;
        const ripristina = rendiInerteFuoriDaConFocus(radice);
        // Il fuoco va sul CONTENITORE `role="dialog"` (che ha `tabIndex={-1}`, quindi
        // riceve il fuoco ma non è una tappa del ciclo): così l'annuncio è il nome
        // del dialogo — «Foto: Laboratorio dei colori, finestra di dialogo» — e non
        // il primo bottone che capita, che sarebbe una «✕» senza contesto.
        radice.focus();
        return ripristina;
    }, [visoreAperto]);

    const vaiAlPrecedente = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (indice > 0) onCambia(elementi[indice - 1].id);
    }, [indice, elementi, onCambia]);

    const vaiAlSuccessivo = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (indice >= 0 && indice < elementi.length - 1) onCambia(elementi[indice + 1].id);
    }, [indice, elementi, onCambia]);

    useEffect(() => {
        /**
         * ⚠️ `tastiBloccati` NON È UNA RIFINITURA. Con la conferma aperta, `Escape`
         * lo gestisce già `Modal` (che fa `stopPropagation()` su `document`, cioè
         * prima che l'evento arrivi a questo listener su `window`), ma le FRECCE no:
         * arrivavano fin qui e cambiavano il media dietro al dialogo. Il dialogo
         * nomina e cancella quello che ha catturato all'apertura — quindi da quel
         * momento si sarebbe letta una didascalia e cancellata un'altra foto.
         */
        if (!visoreAperto || tastiBloccati) return;
        const gestisciTasto = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                vaiAlPrecedente();
            } else if (e.key === 'ArrowRight') {
                vaiAlSuccessivo();
            } else if (e.key === 'Escape') {
                onChiudi();
            }
        };
        window.addEventListener('keydown', gestisciTasto);
        return () => window.removeEventListener('keydown', gestisciTasto);
    }, [visoreAperto, tastiBloccati, vaiAlPrecedente, vaiAlSuccessivo, onChiudi]);

    if (!corrente || !contenitore) return null;

    return createPortal(
        /*
          IL VISORE — TRE NODI, E OGNUNO CHIUDE UN DIFETTO MISURATO.

          ─── COM'ERA, E COSA COSTAVA ─────────────────────────────────────────
          Un nodo solo: `fixed inset-0` + `backdrop-blur-xl` + `flex
          justify-center` + `overflow-hidden`. Su iPhone 14 (390×844, meno le aree
          di sicurezza = 763 px utili) la colonna misura ~840 px — immagine 464 +
          didascalia 52 + pannello dei taggati 200 + «Elimina Media» 52 + margini
          72. Mancano ~80 px e l'ultimo figlio è proprio il bottone: finiva sotto
          il bordo, senza barra di scorrimento perché `overflow-hidden` non scorre
          e senza nessun gesto per raggiungerlo. Il titolare, dall'app, ha
          riferito che «Elimina non esiste». Esisteva.

          ─── (a) IL CONTENITORE è nudo ───────────────────────────────────────
          Solo posizione e z-index. Frecce e chiusura sono suoi figli diretti,
          FUORI dallo scroller: così non scorrono via col contenuto.

          ─── (b) IL VELO È UN FRATELLO, e non è estetica ─────────────────────
          Sulla WebView Chromium di Android un antenato con `backdrop-filter`
          CANCELLA l'intero sottoalbero dall'albero di accessibilità: col velo sul
          contenitore, `uiautomator dump` restituiva 120 nodi e nessuno era della
          modale — per TalkBack la finestra non esisteva. È una lezione già pagata
          in questo repo: sta scritta per esteso in `src/components/ui/Modal.tsx`,
          che per questo mette la sfocatura su un div fratello `aria-hidden`.

          ─── (c) LO SCROLLER ────────────────────────────────────────────────
          `absolute inset-0 overflow-y-auto overscroll-contain`, e dentro un
          `flex min-h-full items-center justify-center`: centrato quando il
          contenuto ci sta, ancorato in alto e scorrevole quando non ci sta —
          cosa che `items-center` da solo non fa (taglia il bordo di sopra).
          `overscroll-contain` perché su iOS, arrivati a fine corsa, il gesto
          proseguirebbe trascinando la pagina sotto.
          Il riempimento ingloba `env(safe-area-inset-*)`: nel browser e su
          Android valgono 0, su iPhone sono la Dynamic Island e la barra di casa.

          La chiusura al click fuori sta sullo SCROLLER e non sul velo: il velo
          gli è sotto, quindi nessun tocco lo raggiunge. La colonna ferma la
          propagazione, come prima.
        */
        <div
            ref={visoreRef}
            role="dialog"
            aria-modal="true"
            /* Il nome del dialogo lo dà chi usa il visore: in galleria è la STESSA
               funzione che nomina la card, così l'annuncio all'apertura combacia con
               quello del comando che si è premuto. */
            aria-label={etichetta(corrente)}
            tabIndex={-1}
            /* `z-[115]` E NON `z-50` — vedi il commento del dialogo di
               eliminazione qui sotto, che questa riga chiude: misurato il
               2026-09-12 su iPhone 16e, a pari livello la bottom-nav
               (dichiarata DOPO `<main>`) dipingeva sopra il visore e
               teneva l'ultimo comando della colonna sotto di sé, a
               scroller finito. 115 è il livello che `ui/cockpit.tsx` usa
               già per stare sopra tutto il chrome (topbar e sidebar
               `z-[105]`, foglio «Menu» `z-[110]`, filtri `z-[112]`).
               Lock: `__tests__/architecture/visore-media-sopra-la-bottom-nav`. */
            className="fixed inset-0 z-[115] focus:outline-none"
        >
            <motion.div
                aria-hidden="true"
                data-testid="visore-velo"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 bg-white/70 backdrop-blur-xl"
            />

            {/* Navigation Arrows */}
            {indice > 0 && (
                <button
                    onClick={vaiAlPrecedente}
                    className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-20 cursor-pointer border border-kidville-line"
                    title={t('mediaPrecedente')}
                >
                    <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                </button>
            )}
            {indice < elementi.length - 1 && (
                <button
                    onClick={vaiAlSuccessivo}
                    className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-20 cursor-pointer border border-kidville-line"
                    title={t('mediaSuccessiva')}
                >
                    <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                </button>
            )}

            <div
                data-testid="visore-scorrimento"
                className="absolute inset-0 overflow-y-auto overscroll-contain z-10"
                onClick={onChiudi}
            >
                <div className="flex min-h-full items-center justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
                    <div data-testid="visore-colonna" className="relative max-w-2xl w-full" onClick={e => e.stopPropagation()}>
                        <div className="relative bg-white rounded-2xl overflow-hidden shadow-xl p-3 border border-kidville-green/10">
                            {!corrente.url ? (
                                /* Firma non riuscita: si dice, non si mostra un riquadro rotto. */
                                <div className="w-full min-h-[35svh] rounded-xl bg-kidville-cream flex flex-col items-center justify-center gap-2 px-6 text-center">
                                    <ImageOff size={32} className="text-kidville-green/70" strokeWidth={1.5} />
                                    <span className="font-maven text-sm text-kidville-green/70">
                                        {t('galleryAnteprimaNonDisponibile')}
                                    </span>
                                </div>
                            ) : corrente.tipo === 'video' ? (
                                /*
                                  VIDEO E IMMAGINE HANNO LA STESSA REGOLA, ed è un invariante:
                                  due media aperti nello stesso visore non possono comportarsi
                                  in due modi. Il video aveva `w-full max-h-[55vh]` e nessun
                                  rapporto d'aspetto — un video verticale (cioè tutti quelli
                                  girati col telefono) veniva allargato alla colonna e
                                  guarnito di due fasce nere ai lati.
                                  `w-auto max-w-full` lascia decidere al rapporto d'aspetto;
                                  `object-contain` non taglia niente.
                                  `svh` E NON `vh`: su Safari iOS `vh` è il viewport GRANDE,
                                  quello senza la barra degli indirizzi, quindi `70vh` vale più
                                  del 70% di ciò che si vede — di nuovo contenuto fuori campo.
                                  `playsInline` perché senza di lui iOS apre il video a schermo
                                  pieno da solo, `preload="metadata"` perché senza la WebView
                                  può tirarsi giù l'intero file.
                                  `bg-black` resta: è il letterbox di un player, ed è il caso
                                  che il lock `palette-di-serie` dichiara legittimo per scritto.
                                */
                                <video src={corrente.url} controls playsInline preload="metadata"
                                    className="mx-auto max-h-[70svh] w-auto max-w-full object-contain rounded-xl bg-black" />
                            ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={corrente.url} alt={corrente.alt}
                                    className="mx-auto max-h-[70svh] w-auto max-w-full object-contain rounded-xl" />
                            )}
                        </div>

                        {children}
                    </div>{/* /visore-colonna */}
                </div>{/* /involucro flex centrante */}
            </div>{/* /visore-scorrimento */}

            {/* Close button. Fuori dallo scroller — non scorre via — e con la
                safe-area in cima: a `top-4` fisso, su iPhone finisce sotto la
                Dynamic Island. */}
            <button onClick={onChiudi}
                className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-10 h-10 rounded-full bg-kidville-green/10 text-kidville-green flex items-center justify-center hover:bg-kidville-green/20 transition-colors shadow-sm font-bold z-20">
                ✕
            </button>

            {/*
              I SOVRAPPOSTI (LA CONFERMA DI ELIMINAZIONE) SONO FIGLI DEL VISORE, E FRATELLI
              DELLO SCROLLER — non nipoti. Due ragioni misurate, non estetiche:

              · lo scroller porta `onClick={onChiudi}` («clic fuori = chiudi»). Un
                dialogo reso DENTRO di lui farebbe risalire ogni clic sul proprio velo
                fin lì: il visore si chiuderebbe portandosi via la conferma, cioè
                l'annullamento per distrazione che `closeOnBackdrop={false}` esiste per
                impedire;
              · dentro il visore e non fuori perché l'effetto del visore marca `inert`
                tutto ciò che gli sta FUORI: un dialogo là nascerebbe inerte, cioè con i
                suoi due comandi irraggiungibili. Il registro di `inerti` conta per
                elemento, quindi l'inerzia che `Modal` aggiunge sopra si somma e si
                sottrae senza scoprire lo sfondo del visore.

              ⚠️ IL `z-[120]` DI `Modal`, ANNIDATO QUI, È CLAMPATO — va saputo prima di
              fidarsene, e resta vero anche adesso. Il visore è `fixed inset-0 z-[115]`:
              posizione più `z-index` diverso da `auto` creano un CONTESTO
              D'IMPILAMENTO, quindi il `z-[120]` del Modal si risolve DENTRO quel
              contesto e non può superare il livello del visore rispetto ai suoi
              FRATELLI. Non è un difetto: là dentro gli basta stare sopra i figli del
              visore (`z-10` lo scroller, `z-20` le frecce e la ✕), e ci sta.

              ─── LA MISURA È ARRIVATA, E LA RIGA È STATA SCRITTA ────────
              Questo commento, fino al 2026-09-12, diceva: «il visore è `z-50`, la
              bottom-nav è `fixed bottom-0 … z-50` e nel layout viene DOPO
              `<main>{children}</main>`, cioè stesso livello e più avanti nel DOM —
              dipinge sopra il visore. NON È CORRETTO A OCCHIO DI PROPOSITO: una
              sovrapposizione vera dei bottoni non è dimostrata ai formati comuni, e
              jsdom non ha layout. Si misura nel browser vero. Se la misura dirà che c'è,
              la correzione è una riga: da `z-50` a `z-[115]`».

              **La misura ha detto che c'è.** Simulatore iPhone 16e (390×844, iOS
              26.2), app nativa contro `app.kidville.it`, un video VERTICALE aperto nel
              visore: lo scroller arriva a fine corsa — due schermate dopo due gesti
              risultavano identiche al byte — e di «Elimina Media» restava una striscia
              rossa di ~4 px sotto la pastiglia della barra. Non era «non dimostrata ai
              formati comuni»: era invisibile al formato più comune che esista, un
              filmato ripreso col telefono in verticale. Ciò che la nascondeva non era il
              dialogo compatto di cui parla il paragrafo qui sopra — era la COLONNA del
              visore, che con un video a `max-h-[70svh]` più didascalia, taggati e
              comando supera l'altezza utile.

              La riga è scritta (vedi il `className` della radice del visore) e adesso la
              misura ha un lock che la tiene:
              `__tests__/architecture/visore-media-sopra-la-bottom-nav`. Effetto
              collaterale voluto: `rendiInerteFuoriDaConFocus` marca inerte tutto ciò che
              sta FUORI dal visore, la barra compresa — prima era inerte ma visibile e
              sopra, cioè il peggio dei due mondi.
            */}
            {sovrapposti}
        </div>,
        contenitore,
    );
}
