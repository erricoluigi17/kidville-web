'use client';

import { useTranslations } from 'next-intl';
import { Play } from 'lucide-react';

/**
 * L'ANTEPRIMA DI UN FILE APPENA SCELTO — un'immagine con `<img>`, un video con `<video>`.
 *
 * ─── IL DIFETTO CHE QUESTO COMPONENTE CHIUDE (2026-09-11) ────────────────────
 * Il titolare, dall'app iOS: «l'anteprima di un video è l'icona di immagine
 * rotta». Le anteprime rendevano SEMPRE `<img src={objectURL}>` — anche quando il
 * file scelto era un filmato, che `MediaUploader` accetta da sempre
 * (`accept="image/*,video/*"`). Un browser non sa disegnare un frame di MP4
 * dentro un `<img>`: mostra il glifo del file rotto, e l'insegnante non ha modo
 * di sapere QUALE dei suoi video ha scelto.
 *
 * ─── PERCHÉ UN COMPONENTE E NON TRE TOPPE ───────────────────────────────────
 * Le stesse due righe esistevano in TRE posti: la griglia di `MediaUploader`, la
 * striscia delle miniature dello step 2 e l'anteprima piccola della «foto in
 * configurazione». Tre copie dello stesso difetto sono tre occasioni di
 * correggerne due — ed è esattamente il modo in cui questo repo si è già trovato
 * un ramo mai preso. La decisione «immagine o video?» vive qui, in un posto solo.
 *
 * ─── SI DECIDE SUL TIPO MIME, NON SULL'ESTENSIONE DEL NOME ──────────────────
 * `file.type` è ciò che il sistema operativo dichiara; il nome è un'altra cosa e
 * mente: la libreria di iOS consegna filmati con nomi tipo `IMG_0042.jpg`, e
 * questo repo la lezione del MIME l'ha già pagata due volte (il `;codecs=avc1`
 * di `MediaRecorder`, che aveva fatto rifiutare 34 video a 8 insegnanti).
 *
 * ─── PERCHÉ QUI UN `<video>` E IN `MediaGrid` NO (rilievo del critico) ──────
 * Nella galleria pubblicata (`MediaGrid`) la miniatura di un video è un glifo
 * Play più la parola, e il commento accanto dice perché: «quaranta miniature
 * sono quaranta richieste di metadati su rete mobile». È un argomento di RETE, e
 * qui non si trasferisce: le sorgenti sono `blob:` già in memoria — il file l'ha
 * appena scelto l'utente, non c'è nessun byte da scaricare. E soprattutto il
 * frame È l'informazione: la segnalazione del titolare non era «non capisco che
 * è un video», era «non so quale video ho scelto». Una tessella con un
 * triangolino non risponde a quella domanda; un primo frame sì.
 *
 * ⚠️ MA IL FRAME NON È GARANTITO, E VA DETTO (rilievo del critico, giro 2).
 * `preload="metadata"` è la condizione NECESSARIA perché un fotogramma arrivi —
 * senza, non arriva di sicuro — non quella SUFFICIENTE: su Safari/iOS il
 * precaricamento dei media è un suggerimento che il browser può ignorare
 * (Modalità Risparmio Energetico, e storicamente su rete cellulare), e in jsdom
 * un `<video>` non carica mai niente. Nessuno dei test di questo lavoro dimostra
 * che si veda qualcosa: è collaudo da fare sull'iPhone vero, insieme al numero di
 * `<video>` che una griglia può tenere accesi. Per questo la risposta alla
 * domanda «quale video ho scelto» NON è appesa al frame: la tessella dello step 1
 * porta il NOME del file (`MediaUploader`), che si vede sempre.
 *
 * ─── LA PAROLA VIENE DAL CATALOGO ───────────────────────────────────────────
 * `shared.galleryVideo` — la stessa chiave che `MediaGrid` consuma con
 * `t('galleryVideo')` da quando quella parola è stata portata fuori dal suo
 * sorgente. Al giro 2 qui viveva una costante cablata, con quattro commenti che
 * sostenevano che la chiave non esistesse: esisteva già, e il risultato erano due
 * sorgenti di verità per una parola sola. Non si scrive a mano una parola
 * d'interfaccia che il catalogo ha già.
 */

/**
 * QUANTA ETICHETTA STA SULLA TESSELLA. Non è un vezzo: dipende dai pixel che la
 * superficie ha davvero, e le superfici sono tre di misure diverse.
 *
 *  · `'con-parola'` — la pastiglia intera, triangolino + parola visibile. È la
 *    griglia dello step 1: tessere di ~98 px, e in basso a sinistra non c'è
 *    nient'altro.
 *  · `'solo-icona'` — il triangolino, e la parola per i soli screen reader
 *    (`sr-only`). È la striscia dello step 2: tessere di `w-16` (64 px, e 80 solo
 *    da `sm:`, cioè su nessun telefono), col badge dello stato dei tag in basso a
 *    destra. Aritmetica sulle classi vere: la pastiglia intera va da 4 px a ~52,
 *    il badge comincia fra ~43 e ~50 — sono ~2-9 px di sovrapposizione, e il
 *    badge sta DOPO nell'ordine del documento con un fondo opaco, quindi copre il
 *    bordo destro della parola proprio dove serve. Spegnere l'etichetta l'avrebbe
 *    tolta anche a chi non vede la tessella; così resta, e non occupa pixel: la
 *    pastiglia scende a ~20 px e non arriva al badge.
 *  · `'nessuna'` — niente. È l'anteprima da 40 px della «foto in configurazione»,
 *    dove un badge coprirebbe l'immagine invece di descriverla (e là il tipo è già
 *    detto dalla miniatura selezionata, che di etichetta ne ha una).
 *
 * ⚠️ L'etichetta è posizionata in ASSOLUTO: chi la mostra deve essere `relative`.
 * Tutte le tessere che la usano oggi lo sono già.
 */
export type EtichettaAnteprima = 'con-parola' | 'solo-icona' | 'nessuna';

interface Props {
    /** Il file scelto. Serve solo il TIPO: è lui che decide, non il nome. */
    file: Pick<File, 'type'>;
    /** L'objectURL dell'anteprima. Lo crea — e lo REVOCA — chi possiede l'elenco. */
    src: string;
    /** Le classi dell'elemento che dipinge. Il default riempie la tessella. */
    className?: string;
    /** Quanta etichetta ci sta: vedi `EtichettaAnteprima`. */
    etichetta?: EtichettaAnteprima;
}

/** Riempie la tessella senza deformare: identico per immagini e video. */
const RIEMPI = 'w-full h-full object-cover';

export function AnteprimaMedia({ file, src, className = RIEMPI, etichetta = 'con-parola' }: Props) {
    const t = useTranslations('shared');

    if (file.type.startsWith('video/')) {
        return (
            <>
                {/*
                  `muted` + `playsInline`: su iOS un video con l'audio attivo non
                  parte e, senza `playsinline`, passa a schermo pieno da solo alla
                  prima interazione. `preload="metadata"` è la condizione necessaria
                  perché compaia il primo frame — non la garanzia, vedi l'avviso in
                  testa al file. Nessun `controls`: è un'anteprima di 98 px, i
                  comandi la coprirebbero e il gesto utile qui è la X di rimozione.
                */}
                <video src={src} muted playsInline preload="metadata" className={className} />
                {etichetta !== 'nessuna' && (
                    // In BASSO A SINISTRA: la X di rimozione sta in alto a destra, e
                    // in basso a destra ci sono i badge dei tag sulla striscia dello
                    // step 2 — questo è l'angolo che resta libero su entrambe.
                    // La parola c'è sempre, e non è `aria-hidden`: un triangolino non
                    // si legge ad alta voce, e senza di lei per chi usa uno screen
                    // reader la tessella di un filmato è indistinguibile da quella di
                    // una foto. Quando lo spazio non basta smette di occupare pixel,
                    // non di esistere.
                    <span className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-0.5 rounded-pill bg-kidville-ink/90 px-1.5 py-0.5 font-barlow text-[9px] font-bold uppercase tracking-wide text-kidville-white">
                        <Play size={8} strokeWidth={2} fill="currentColor" aria-hidden="true" />
                        <span className={etichetta === 'solo-icona' ? 'sr-only' : ''}>{t('galleryVideo')}</span>
                    </span>
                )}
            </>
        );
    }

    // Un frammento SENZA involucro anche qui: le tessere che chiamano questo
    // componente posizionano i propri badge in assoluto rispetto a sé stesse, e
    // un `<div>` in mezzo cambierebbe il genitore di tutti loro.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={className} />;
}
