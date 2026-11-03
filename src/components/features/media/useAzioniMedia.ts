'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { logClient } from '@/lib/logging/client';
import {
    condividiMedia as condividiNelDispositivo,
    nomeFileScarico,
    puoCondividereFileMedia,
    scaricaMedia as scaricaNelDispositivo,
    type RisultatoCondivisioneMedia,
    type RisultatoScaricoNativo,
    type TipoMedia,
} from '@/lib/native/scarica';

/**
 * UN MEDIA SU CUI SI AGISCE (scaricare, condividere), ridotto a ciò che serve ai due gesti.
 *
 * Il chiamante tiene i propri dati (una riga di galleria, un messaggio di chat) e passa questa
 * vista minima: l'hook non sa niente di tabelle, di bucket o di persone.
 */
export interface MediaAzionabile {
    /**
     * L'IDENTITÀ STABILE del media (id della riga o del messaggio). Non l'URL: l'indirizzo firmato
     * cambia a ogni rifirma, e col visore aperto a lungo il secondo tocco su «Condividi» arriva con
     * un indirizzo nuovo. Con questa chiave `condividiMedia` ritrova il file già pronto.
     */
    id: string;
    /**
     * L'indirizzo FIRMATO, quello più recente che il chiamante conosce. Non vuoto: un media senza
     * firma non è azionabile (vedi `ComandiMedia`, che in quel caso non mostra i due pulsanti).
     */
    url: string;
    tipo: TipoMedia;
    /**
     * Da dove ricavare il nome del file (la didascalia, in Foto); `null` = lo si ricava dal
     * percorso dell'indirizzo. Si passa grezzo: lo ripulisce e gli aggiunge l'estensione
     * `nomeFileScarico`, che è idempotente.
     */
    nomeFile: string | null;
    /** Il titolo del foglio di sistema. Assente = «Foto da Kidville»: mai un nome di persona. */
    titolo?: string;
}

/**
 * Chi sta agendo: è il prefisso dei log dell'helper (`<etichetta>-scarico-riuscito:…`,
 * `<etichetta>-condivisione-…`) e di quelli di questo hook. Un elenco CHIUSO, perché `app_log`
 * si interroga per etichetta: `etichettaSicura` dell'helper accetta solo `[a-z0-9-]`.
 */
export type EtichettaAzioniMedia = 'gallery' | 'chat' | 'chat-vigilanza';

export interface AzioniMedia {
    /** Scarica il media (Galleria/Rullino nell'app 1.1, file sul web). Non lancia mai. */
    scarica: (m: MediaAzionabile) => Promise<void>;
    /** Manda il FILE al foglio di condivisione. Mai il link, che scade in 10 minuti. */
    condividi: (m: MediaAzionabile) => Promise<void>;
    /**
     * Questo dispositivo può condividere un file? `false` al render del server e sul web senza
     * `navigator.canShare({ files })`: lì «Condividi» NON deve comparire, e decide chi disegna il
     * pulsante (`ComandiMedia` e la card di Foto leggono questo campo).
     */
    puoCondividere: boolean;
}

/**
 * `useSyncExternalStore` per leggere un fatto del BROWSER senza stato e senza effetto: la regola
 * `react-hooks/set-state-in-effect` vieta il `useState` + `useEffect` che si scriveva una volta, e
 * un `try/finally` attorno al `setState` non la soddisfa (memoria `eslint_set_state_in_effect`).
 * Il fatto non cambia mai a pagina aperta, quindi non c'è niente a cui iscriversi.
 */
const iscrivitiSenzaNovita = () => () => {};
const sulServerNonSiPuo = () => false;

/**
 * SCARICA E CONDIVIDI, IN UN POSTO SOLO — per la galleria, per il visore della chat e per le
 * card: scritti due volte (sulla card e nel visore) erano già divergenti, e la card non aveva
 * nemmeno un log.
 *
 * ─── UNA GUARDIA PER SUPERFICIE ─────────────────────────────────────────────────────────────
 * UN'AZIONE ALLA VOLTA, per scarico E condivisione insieme. Non è cosmesi: su iOS presentare un
 * secondo foglio di condivisione mentre il primo è aperto solleva, e su nativo la seconda
 * pressione riscriverebbe lo stesso file mentre lo si sta consegnando. Un `ref` e non uno
 * `state` perché non deve ridisegnare niente: in Foto l'hook sta in `MediaGrid`, che ha fino a 40
 * card, e due card diverse non devono poter scaricare insieme — per questo il chiamante lo
 * chiama UNA volta e ne passa il risultato a chi disegna i pulsanti (`ComandiMedia`, le card).
 * Lo stato «sto lavorando» di ciascun pulsante resta INVECE nel pulsante (vedi `ComandiMedia`).
 *
 * Una seconda pressione mentre la prima lavora si scarta e SI LOGGA. Non un `return` nudo: le
 * azioni possono NON RISOLVERE (la `fetch` verso l'indirizzo firmato è cross-origin e nella
 * WebView può accettare e tacere: è la riga di produzione con `stato_http = 0` citata in
 * `scarica.ts`). Da lì in avanti ogni pressione uscirebbe dalla guardia, e senza una riga «il
 * pulsante è incagliato» e «nessuno l'ha mai premuto» sarebbero lo stesso identico silenzio in
 * `app_log` (§5 di AGENTS.md) — il modo in cui lo «Scarica» rotto è sopravvissuto per mesi.
 * Il tetto di tempo sulle azioni è una decisione separata (`MAI_OLTRE_MS`, 30 s, sono pochi per
 * il video di un genitore su rete lenta) e non si prende qui.
 *
 * Il nome della riga: `gallery-scarico-gia-in-corso` per lo SCARICO in Foto, perché `app_log` lo
 * conta già; qualunque altro caso (Condividi, o un'azione di chat) porta la propria etichetta:
 * `<etichetta>-azione-gia-in-corso`. Livello `warn`, come ogni successo e ogni scarto previsto.
 *
 * ─── GLI AVVISI A SCHERMO SONO QUI, IL LOG DELL'ESITO È DELL'HELPER ─────────────────────────
 * `scaricaMedia` e `condividiMedia` di `@/lib/native/scarica` registrano da sé l'esito — successo
 * compreso, con `etichetta`, `operazione` e `piattaforma` — PRIMA di risolvere: loggare anche da
 * qui sarebbe la stessa notizia due volte, cioè un contatore di successi raddoppiato. Restano
 * a questo file due cose: la riga della pressione scartata, e gli `alert` d'esito, che sono
 * della UI e NON si loggano. Un `alert` blocca il thread: l'helper ha già scritto la riga quando
 * parte.
 *
 * ─── «CONDIVIDI» NON MANDA MAI IL LINK ──────────────────────────────────────────────────────
 * Il link firmato scade dopo 10 minuti: chi lo riceve su WhatsApp e lo apre dopo trova un
 * errore. Qui non c'è nessun ramo che lo usi, nemmeno in un errore: se il file non parte si
 * AVVISA, e basta.
 */
export function useAzioniMedia({ etichetta }: { etichetta: EtichettaAzioniMedia }): AzioniMedia {
    const t = useTranslations('shared');
    const inCorso = useRef(false);
    const puoCondividere = useSyncExternalStore(
        iscrivitiSenzaNovita,
        puoCondividereFileMedia,
        sulServerNonSiPuo,
    );

    /** La pressione scartata dalla guardia: una riga, e il nome dipende da cosa e dove. */
    const logGiaInCorso = useCallback((azione: 'scarico' | 'condivisione') => {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio:
                azione === 'scarico' && etichetta === 'gallery'
                    ? 'gallery-scarico-gia-in-corso'
                    : `${etichetta}-azione-gia-in-corso`,
        });
    }, [etichetta]);

    /** Il nome con estensione e il titolo del foglio: gli STESSI per i due gesti. */
    const datiHelper = useCallback((m: MediaAzionabile) => ({
        url: m.url,
        nomeFile: nomeFileScarico(m.nomeFile, m.url, m.tipo),
        tipo: m.tipo,
        titolo: m.titolo ?? t('galleryFotoDaKidville'),
        etichetta,
    }), [etichetta, t]);

    const avvisoScarico = useCallback((risultato: RisultatoScaricoNativo) => {
        // L'UNICO RAMO MUTO, e va detto: sul web senza Web Share (Firefox su desktop) con
        // l'indirizzo firmato scaduto il file non c'è, negli appunti c'è il link, e sullo schermo
        // non è cambiato niente. Senza questa riga «Scarica» tornerebbe a essere un pulsante che
        // sembra rotto.
        if (risultato.esito === 'ripiego-appunti') {
            alert(t('mediaLinkCopiato'));
            return;
        }
        // I DUE SILENZI DELL'APP 1.1. `nativo-galleria` scrive il file nel Rullino SENZA foglio di
        // sistema: senza questa conferma «Scarica» (magari dopo parecchi secondi di FileTransfer
        // per un video) non cambierebbe niente sullo schermo, e le pressioni ripetute finirebbero
        // tutte nella riga «già in corso». `non-riuscito` è l'altro silenzio: l'utente non ha
        // niente e nessuno glielo dice. Tranne `annullato`, un gesto ritirato e non un guasto.
        if (risultato.esito === 'nativo-galleria') alert(t('mediaSalvataInGalleria'));
        else if (risultato.esito === 'non-riuscito' && risultato.motivo !== 'annullato') {
            alert(t('mediaScaricoNonRiuscito'));
        }
    }, [t]);

    const avvisoCondivisione = useCallback((risultato: RisultatoCondivisioneMedia) => {
        switch (risultato.esito) {
            case 'web-gesto-scaduto':
                // Safari rifiuta `navigator.share` se fra il tocco e la chiamata c'è stata una
                // `fetch` lunga. Il file è già scaricato e tenuto pronto: il tocco successivo parte
                // subito, nello stesso gesto.
                alert(t('mediaCondividiToccaDiNuovo'));
                return;
            case 'app-da-aggiornare':
                // Il binario 1.0 non ha Filesystem né FileTransfer: non può consegnare un file, e
                // NON ripiega sul link (come i documenti con `documentoAppDaAggiornare`).
                alert(t('mediaCondividiAppDaAggiornare'));
                return;
            case 'non-riuscita':
                // Un gesto RITIRATO da chi lo aveva chiesto (segnale interrotto) non è un guasto.
                if (risultato.motivo !== 'annullato') alert(t('mediaCondivisioneNonRiuscita'));
                return;
            case 'non-supportato':
                // Il pulsante non dovrebbe esserci (`puoCondividere` è falso): se qualcuno l'ha
                // premuto lo stesso, non deve restare muto.
                alert(t('mediaCondivisioneNonRiuscita'));
                return;
            case 'nativo-foglio':
            case 'web-foglio':
                // Il foglio è a schermo (o l'utente lo ha chiuso): niente da aggiungere.
                return;
        }
    }, [t]);

    const scarica = useCallback(async (m: MediaAzionabile) => {
        if (inCorso.current) {
            logGiaInCorso('scarico');
            return;
        }
        inCorso.current = true;
        try {
            // L'HELPER UNICO DELL'APP 1.1: nell'app aggiornata foto e video vanno DIRETTAMENTE in
            // Galleria/Rullino (Android: album «Kidville»); sul web e sul binario 1.0 fa quello che
            // faceva `scarica()`. Logga da sé l'esito PRIMA di risolvere.
            avvisoScarico(await scaricaNelDispositivo(datiHelper(m)));
        } finally {
            inCorso.current = false;
        }
    }, [datiHelper, avvisoScarico, logGiaInCorso]);

    const condividi = useCallback(async (m: MediaAzionabile) => {
        if (inCorso.current) {
            logGiaInCorso('condivisione');
            return;
        }
        inCorso.current = true;
        try {
            avvisoCondivisione(await condividiNelDispositivo({ ...datiHelper(m), chiave: m.id }));
        } finally {
            inCorso.current = false;
        }
    }, [datiHelper, avvisoCondivisione, logGiaInCorso]);

    return useMemo(() => ({ scarica, condividi, puoCondividere }), [scarica, condividi, puoCondividere]);
}
