'use client';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ELIMINARE UNA FOTO O UN VIDEO — la conferma dice cosa sparisce e cosa resta.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── COM'ERA, E PERCHÉ NON ANDAVA ───────────────────────────────────────────
 * `MediaGrid` faceva, su due righe:
 *
 *     onDelete(item.id);
 *     handleCloseLightbox();
 *
 * cioè chiudeva il visore PRIMA che il server avesse risposto. Tre difetti in
 * due righe: nessuna conferma (un tocco cancellava la foto di un minore), il
 * rifiuto del server arrivava su una schermata che non mostrava più la foto di
 * cui parlava, e la riga dell'elenco restava lì — perché il ricarico era
 * affidato a chi aveva già smesso di guardare.
 *
 * ─── PERCHÉ NON `window.confirm` (+ `alert`), CHE SAREBBE STATO UNA RIGA ────
 *  1. sarebbero DUE dialoghi nativi bloccanti in fila nella WebView (`confirm`
 *     e poi `alert`), e `MediaGrid` stesso documenta che `alert()` blocca il
 *     thread: un log spedito dopo si perde se intanto l'utente se ne va;
 *  2. un `confirm` nativo non può dire le due cose che qui contano — vedi sotto;
 *  3. non ha stato: non può restare aperto mentre la DELETE è in volo, né
 *     mostrare al proprio interno un rifiuto distinguendo un 403 da un 500.
 *
 * ─── LE DUE COSE CHE QUESTO DIALOGO DEVE DIRE ───────────────────────────────
 * · CHE COSA ACCADE: sparisce SUBITO dalla galleria dei genitori.
 * · CHE COSA RESTA: la segreteria può ripristinarla entro 30 giorni, poi viene
 *   distrutta per sempre, file compreso.
 *
 * ⚠️ La seconda frase NON è cosmesi, ed è la ragione per cui questo componente
 * esiste invece di un `confirm`. L'insegnante non ha nessuna schermata di
 * cestino: senza quella riga crede di aver distrutto la foto e non chiama
 * nessuno. Il cestino in `galleria_media_v2` (`eliminato_il`, `eliminato_da`,
 * `file_rimosso_il`) esisterebbe e non servirebbe a nessuno — un ripristino che
 * nessuno sa di poter chiedere non è un ripristino.
 *
 * ─── I TRE ESITI, E PERCHÉ SI DIPINGONO DIVERSI ─────────────────────────────
 * Il modello è `DialogoScollega`, riga per riga, perché la lezione è la stessa:
 * un rifiuto dipinto tutto allo stesso modo trasforma una protezione in un
 * guasto agli occhi di chi la incontra.
 *
 * · 403 — non è un guasto, è un confine di sede o di ruolo. Il messaggio resta a
 *   schermo e il comando SPARISCE: ripremerlo darebbe lo stesso identico
 *   rifiuto, e il rimedio è un'altra cosa (chiederlo alla segreteria della
 *   propria sede). Si logga `warn`.
 * · 404 — l'esito voluto È RAGGIUNTO: quel media non c'è già più (una seconda
 *   scheda aperta, un doppio invio). Mostrarlo come errore accuserebbe l'utente
 *   di non aver ottenuto ciò che ha ottenuto: si CHIUDE, senza dipingere niente
 *   di rosso, con un `warn` in `app_log` perché «due schermate che si pestano i
 *   piedi» è un fatto che vale sapere. ⚠️ Chiudere non è ricaricare: su questo
 *   ramo l'elenco resta indietro, e il perché è accettabile sta nel contratto
 *   della prop `onEliminato` qui sotto.
 * · 500 / rete — il comando RESTA, perché riprovare è esattamente il rimedio.
 *   Si logga `error`.
 *
 * ─── COSA NON SI SCRIVE, NÉ A SCHERMO NÉ NEI LOG ────────────────────────────
 * · a schermo MAI l'uuid del media: questo componente non lo riceve nemmeno
 *   (`onElimina` è una chiusura che `MediaGrid` costruisce), quindi non può
 *   stamparlo per distrazione. La didascalia sì: l'utente la sta guardando.
 * · nei log MAI la didascalia — è il nome del file, e il nome del file di una
 *   foto scolastica contiene spessissimo il nome di un bambino — e MAI il
 *   messaggio del server, che riecheggia filtri, colonne e valori. Escono lo
 *   stato HTTP (un numero) e il nome della classe d'errore: forma, non
 *   contenuto.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Lo stato HTTP attaccato al rigetto di `onElimina`.
 *
 * ⚠️ SI LEGGE PER FORMA E NON PER CLASSE (`instanceof`), di proposito: chi scrive
 * la pagina può costruire il rigetto come preferisce — `erroreElimina(...)`
 * oppure `Object.assign(new Error(testo), { stato: res.status })` — e i due
 * devono valere lo stesso. Un `instanceof` attraverso i confini di un bundle è
 * anche il modo classico di essere falso per due copie dello stesso modulo.
 */
export function statoDaRigetto(errore: unknown): number | null {
    try {
        if (typeof errore !== 'object' || errore === null) return null;
        const grezzo = (errore as { stato?: unknown }).stato;
        return typeof grezzo === 'number' && Number.isInteger(grezzo) ? grezzo : null;
    } catch {
        // Getter ostile: si comporta come un rigetto senza stato, cioè ritentabile.
        return null;
    }
}

/**
 * Il rigetto che questo dialogo sa leggere: testo GIÀ TRADOTTO (da
 * `messaggioErrore`/`messaggioDaCorpo` di `@/lib/ui/esito-fetch`) più lo stato
 * HTTP, che è l'unica cosa che distingue un divieto da un guasto.
 */
export function erroreElimina(testoTradotto: string, stato: number | null): Error & { stato: number | null } {
    return Object.assign(new Error(testoTradotto), { stato });
}

/**
 * Il testo da mostrare, e l'unico caso in cui il `.message` si butta.
 *
 * Il contratto dice «`.message` già tradotto», e va onorato: è l'unico modo di
 * far arrivare a schermo il 403 di sede o il «Specificare la sede» del
 * multi-sede nella lingua di chi legge. L'ECCEZIONE è un `TypeError`, che è ciò
 * che lancia `fetch` quando la rete non c'è: il suo messaggio («Failed to
 * fetch», «Load failed») è testo del MOTORE, in inglese, e a un'insegnante non
 * dice niente. Lì vince la frase di catalogo, che porta anche il rimedio.
 */
function testoDaRigetto(errore: unknown, generico: string): string {
    if (errore instanceof TypeError) return generico;
    if (errore instanceof Error && errore.message.trim() !== '') return errore.message;
    return generico;
}

interface Props {
    /** `file_type` del media: decide la parola del titolo (foto / video). */
    tipoMedia: string;
    /** La didascalia, se c'è. È l'unico dato del media che compare a schermo. */
    didascalia: string | null;
    /**
     * L'eliminazione vera, già legata al media: una chiusura su `onDelete(id)`.
     * **Rigetta** con un `Error` dal `.message` già tradotto; se ci attacca un
     * `stato` numerico, i tre esiti qui sopra si distinguono.
     */
    onElimina: () => Promise<void>;
    /**
     * L'esito è raggiunto (riuscita, oppure 404 = non c'era già più): chiudi il
     * dialogo e il visore.
     *
     * ⚠️ IL RICARICO DELL'ELENCO **NON** È QUI, ED È DEL CHIAMANTE, dentro la
     * risoluzione della propria `onDelete`: qui non si sa nemmeno che cosa sia
     * «l'elenco». Fino al 2026-09-12 questa riga prometteva «e ricarica
     * l'elenco», e l'unico cablaggio esistente passa `handleCloseLightbox`, che
     * non ricarica niente — un contratto che nessuno esegue, cioè la forma di
     * difetto che questo repo ha già pagato più volte.
     *
     * SULLA STRADA DEL 404 RIGETTATO L'ELENCO NON SI AGGIORNA, e va detto: lì il
     * chiamante ha LANCIATO invece di ricaricare, questo dialogo tratta il 404
     * come esito raggiunto e chiude, quindi la riga già cancellata resta nella
     * griglia — la si ritocca e si prende un altro 404. È accettabile perché il
     * chiamante raccomandato (il corpo scritto nel lock
     * `__tests__/architecture/media-elimina-chiamante-rigetta.test.ts`) assorbe
     * il 404 da sé — `if (res.ok || res.status === 404) { await loadMedia(); return; }`
     * — quindi quel ramo non si percorre: è una difesa, non il comportamento di
     * tutti i giorni.
     */
    onEliminato: () => void;
    /** L'utente annulla. Non è mai chiamata da un esito del server. */
    onChiudi: () => void;
    /**
     * LA RICHIESTA È IN VOLO / NON LO È PIÙ — la notizia SALE al padre.
     *
     * Serve perché chi smonta questo dialogo è il PADRE, e un componente non può
     * impedire al padre di smontarlo. `chiudiSePossibile` qui sotto chiude tre
     * strade su cinque (Escape, tasto Indietro di Android, «Annulla»); le altre
     * due sono nel visore di `MediaGrid` — la ✕ e lo scroller chiamano
     * `handleCloseLightbox` direttamente, e quella azzera il media catturato,
     * cioè smonta questo dialogo. Con la DELETE in volo il 403 o il 500 che
     * arriva dopo troverebbe `setErrore` su un componente morto: no-op
     * silenzioso, la foto resta, e chi ha premuto non vede niente.
     *
     * ⚠️ CHIAMATA PRIMA DI `onEliminato`, sempre, in tutti e due i rami. Chi la
     * riceve la usa per RIFIUTARE la chiusura: se la bandiera scendesse dopo, la
     * guardia del padre mangerebbe proprio la chiusura che l'esito positivo
     * chiede. Il perché dell'ordine è scritto dentro `conferma()`.
     *
     * Opzionale: il dialogo reso da solo (i test, e un domani un'altra
     * superficie) non ha nessun padre da avvisare.
     */
    onInVolo?: (inVolo: boolean) => void;
}

export function DialogoEliminaMedia({ tipoMedia, didascalia, onElimina, onEliminato, onChiudi, onInVolo }: Props) {
    const t = useTranslations('shared');
    const [inCorso, setInCorso] = useState(false);
    /** `ripetibile: false` è il 403: il comando non si ripropone. */
    const [errore, setErrore] = useState<{ testo: string; ripetibile: boolean } | null>(null);

    const titolo = tipoMedia === 'video' ? t('galleryEliminaTitoloVideo') : t('galleryEliminaTitoloFoto');

    async function conferma(): Promise<void> {
        // LA GUARDIA È NELLO STATO, non in `disabled` sul bottone. `disabled`
        // durante una richiesta fa sfogare il fuoco a Chrome (torna su `<body>`,
        // cioè in cima al documento) e sbiadisce l'unico segnale che il gesto sia
        // partito: è scritto per esteso in testa a `@/components/ui/Btn`. Il
        // bottone porta `aria-disabled` e il doppio invio lo ferma questa riga.
        if (inCorso) return;
        setInCorso(true);
        setErrore(null);
        // LA BANDIERA SALE AL PADRE: da qui la ✕ e lo scroller del visore non
        // possono più smontare questo dialogo. La scende la riga marcata più
        // sotto — una sola, in mezzo, prima di qualunque richiamo al padre.
        onInVolo?.(true);
        /*
         * L'ESITO SI RACCOGLIE, NON SI DIPINGE SUBITO — e non è uno stile.
         *
         * Fra l'`await` e la pittura dell'esito deve girare una riga in TUTTI E
         * DUE i rami: la bandiera che scende. Un `try/catch/finally` non
         * basterebbe, perché il `finally` gira DOPO il corpo del `try`, cioè
         * DOPO `onEliminato()`. E `onEliminato` è `handleCloseLightbox`, che con
         * la bandiera ancora alzata ESCE senza chiudere niente: il visore non si
         * chiuderebbe più, né a esito positivo né sul 404. La guardia che chiude
         * un silenzio ne aprirebbe un altro, peggiore perché quotidiano.
         *
         * Il rigetto è INCARTATO (`{ c }`) invece di tenuto in una variabile
         * nuda: il valore di un rigetto può essere `undefined` o `null`, e un
         * `if (rifiuto)` li leggerebbe come «è andata bene».
         */
        let rifiuto: { c: unknown } | null = null;
        try {
            await onElimina();
        } catch (e) {
            rifiuto = { c: e };
        }
        // ⚠️ QUI, E NON IN UN `finally`: vedi il commento sopra. Dopo queste due
        // righe il padre può di nuovo chiudere il visore, ed è ciò che serve
        // perché `onEliminato()` funzioni.
        setInCorso(false);
        onInVolo?.(false);

        if (rifiuto === null) {
            /*
             * ANCHE IL SUCCESSO LASCIA UNA RIGA, e per la ragione del §5 di
             * AGENTS.md: con i soli errori, «nessun log» non distingue «tutto
             * bene» da «il comando non ha mai fatto partire niente» — ed è
             * esattamente l'ambiguità in cui «Elimina Media» è vissuto per mesi
             * cadendo fuori dallo schermo. `warn` e non `info` perché
             * `/api/logs` accetta SOLO `warn|error`: un `info` non è spedibile,
             * quindi l'unico modo di non conservare l'evento è non mandarlo.
             */
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-elimina-riuscita',
            });
            onEliminato();
            return;
        }

        // ─── DA QUI IN GIÙ: IL RIFIUTO ──────────────────────────────────────
        const e = rifiuto.c;
        const stato = statoDaRigetto(e);
        if (stato === 404) {
            // L'esito voluto è raggiunto: `warn`, non `error`. Ma si logga,
            // perché «due schermate che si pestano i piedi» è un fatto.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-elimina-gia-assente',
                campi: { stato_http: stato },
            });
            onEliminato();
            return;
        }
        const vietato = stato === 403;
        setErrore({
            testo: testoDaRigetto(e, t('galleryEliminaErroreGenerico')),
            ripetibile: !vietato,
        });
        /*
         * ⚠️ LO STATO VA NEI `campi` E NON IN `stato`, e non è un vezzo:
         * `livelloEvento` applica a ogni `stato` fra 400 e 599 la politica di
         * `livelloFetch`, che per un 403 risponde «non spedire». Dichiararlo lì
         * significherebbe scartare in silenzio proprio la riga che si sta
         * aggiungendo. Come numero dentro `campi` resta, e `redact` lo lascia in
         * chiaro perché è un numero.
         *
         * Un 403 è `warn` (è un confine, non un guasto); tutto il resto è
         * `error`. `error_code` è la CLASSE dell'errore, non il suo testo.
         */
        logClient({
            livello: vietato ? 'warn' : 'error',
            evento: 'fetch',
            messaggio: 'gallery-elimina-non-riuscita',
            campi: { stato_http: stato ?? 0, error_code: nomeErrore(e) },
        });
    }

    /**
     * L'ANNULLAMENTO, CON UNA GUARDIA SOLA PER TRE STRADE — E LE ALTRE DUE SONO
     * DEL PADRE, perché è lui che smonta.
     *
     * ⚠️ LE STRADE SONO CINQUE, NON TRE, e per due mesi questo commento ne ha
     * contate tre. Le tre che passano da qui sono `Escape`, il tasto Indietro di
     * Android (entrambi via `onClose` di `Modal`) e «Annulla». Le altre due sono
     * la ✕ del visore e il suo scroller, in `MediaGrid`: chiamano
     * `handleCloseLightbox`, che azzera il media catturato e quindi SMONTA questo
     * componente — e da dentro non c'è `return` che possa impedirlo. Per quelle
     * la notizia sale col prop `onInVolo`, e la guardia gemella vive in
     * `handleCloseLightbox`. Due guardie, non una, perché sono due i posti da cui
     * si può smontare; identiche nel motivo, che è scritto qui sotto.
     *
     * ⚠️ `closeOnBackdrop={false}` ferma il click fuori e NIENT'ALTRO. `Modal`
     * chiude su `Escape` sempre (`onCloseRef.current()`, nessuna condizione) e il
     * tasto Indietro di Android passa dalla stessa `onClose` (`useOverlayIndietro`).
     * Erano due strade aperte, più il bottone «Annulla», che è la terza.
     *
     * Perché conta: premuto Escape durante la DELETE il dialogo si smonta, e se
     * la richiesta poi RIGETTA con un 500 `setErrore` gira su un componente
     * smontato — no-op silenzioso in React, senza nemmeno un avviso. La foto
     * resta e l'insegnante non sa perché: è esattamente il silenzio per cui
     * questo componente esiste invece di un `confirm`. Il caso del SUCCESSO
     * degradava bene (`onEliminato` è una chiusura di `MediaGrid`, che è ancora
     * montato), il rifiuto no.
     *
     * Non si «disabilita» niente: la guardia è nello stato, come per la conferma.
     * A richiesta finita — riuscita o rifiutata — l'uscita torna possibile, e
     * infatti un test la ripercorre: una guardia che resta incastrata sarebbe un
     * dialogo da cui non si esce più.
     */
    const chiudiSePossibile = (): void => {
        if (inCorso) return;
        onChiudi();
    };

    return (
        <Modal
            open
            onClose={chiudiSePossibile}
            title={titolo}
            // Non si chiude cliccando fuori: è una conferma distruttiva, e un
            // click distratto sullo sfondo non deve poter essere scambiato per un
            // annullamento. Il click fuori è però solo UNA delle strade: Escape e
            // il tasto Indietro di Android arrivano da `onClose`, ed è `chiudiSePossibile`
            // — non questa prop — a impedire che passino con la DELETE in volo.
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-3 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <Trash2 size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <h2 className="font-barlow text-lg font-bold uppercase leading-tight text-kidville-green">
                    {titolo}
                </h2>
            </div>

            {/* La didascalia: l'utente la sta già guardando nel visore, e senza di
                lei una segreteria con tre schede aperte non sa DI QUALE foto si
                parla. L'uuid no: questo componente non lo riceve nemmeno. */}
            {didascalia && (
                <p data-testid="elimina-media-didascalia" className="mb-2 font-maven text-[13px] italic text-kidville-sub">«{didascalia}»</p>
            )}

            {/* CHE COSA ACCADE. */}
            <p className="flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t('galleryEliminaSubito')}
            </p>

            {/* CHE COSA RESTA — la riga per cui questo dialogo esiste. */}
            <p className="mt-2 flex items-start gap-2 font-maven text-[13px] text-kidville-ink">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-kidville-green" aria-hidden="true" />
                {t('galleryEliminaRipristino')}
            </p>

            {errore !== null &&
                (errore.ripetibile ? (
                    <p
                        role="alert"
                        data-testid="elimina-media-errore"
                        className="mt-3 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong"
                    >
                        {errore.testo}
                    </p>
                ) : (
                    /* Il 403 non è un rosso da riprovare: è un confine. Si dipinge
                       come l'avviso che è, col comando che sparisce. */
                    <div
                        role="alert"
                        data-testid="elimina-media-vietato"
                        className="mt-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <p className="font-barlow text-sm font-extrabold uppercase tracking-[0.03em]">
                            {t('galleryEliminaRifiutoTitolo')}
                        </p>
                        <p className="mt-1">{errore.testo}</p>
                    </div>
                ))}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                    type="button"
                    onClick={chiudiSePossibile}
                    // `aria-disabled` e non `disabled`, per la ragione scritta in
                    // testa a `@/components/ui/Btn`: `disabled` durante una
                    // richiesta fa sfogare il fuoco su `<body>`. Il gesto lo ferma
                    // `chiudiSePossibile`.
                    aria-disabled={inCorso}
                    className={btnClass('ghost', 'sm')}
                >
                    {/* Dopo un divieto non c'è niente da annullare: si chiude. */}
                    {errore !== null && !errore.ripetibile ? t('chiudi') : t('galleryAnnulla')}
                </button>
                {(errore === null || errore.ripetibile) && (
                    <button
                        type="button"
                        onClick={() => void conferma()}
                        aria-disabled={inCorso}
                        className={btnClass('danger', 'sm')}
                    >
                        {inCorso ? (
                            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                        ) : (
                            <Trash2 size={14} aria-hidden="true" />
                        )}
                        {inCorso ? t('galleryEliminaInCorso') : t('galleryEliminaConferma')}
                    </button>
                )}
            </div>
        </Modal>
    );
}
