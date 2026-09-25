'use client';

// ─── UN DOCUMENTO DELLA CONTABILITÀ CHE SI SCARICA ANCHE DALL'APP ─────────────
// Ricevute, attestazione 730, export XLSX e giustificativi di cassa erano tutti
// `<a href="/api/…">` (o `window.open` dopo una fetch). Sul web vanno bene: il
// browser naviga, il server risponde con `Content-Disposition` e il file arriva.
// Nella WebView di Capacitor NO: Android non ha un `DownloadListener` e l'ancora
// non fa niente; iOS apre il PDF DENTRO la WebView, senza un «indietro» — e un
// XLSX non lo apre affatto. Il gesto è muto, e nessun log dice che è fallito.
//
// Qui la scelta si fa nel GESTORE DEL TOCCO, come in `LinkInterno`: il markup è
// identico fra server e client (niente disallineamenti di hydration) e SUL WEB
// NON CAMBIA NULLA — il clic segue l'`href` come prima. Solo nell'app si ferma la
// navigazione e si passa all'helper unico (`@/lib/native/scarica`):
//   • `apri`    → `apriDocumento`: anteprima di sistema dentro l'app;
//   • `scarica` → `scaricaDocumento`: foglio di condivisione con il FILE.
// L'helper legge la route con la `fetch` della WebView (che ha i cookie di
// sessione), logga da sé l'esito — successo compreso — e NON condivide mai il
// link di una route nostra come ripiego (è relativo e porta `userId`).
//
// Se il file non arriva l'utente lo deve SAPERE: compare un avviso accanto al
// comando, e l'avviso dice il guasto VERO. «Aggiorna l'app» solo quando l'helper
// ha visto mancare i plugin (`binarioDaAggiornare`, il binario 1.0); per tutto
// il resto — sessione scaduta, 403, 500, corpo vuoto, foglio che non si apre —
// «riprova»: chiedere di aggiornare un'app già aggiornata manda l'utente dalla
// parte sbagliata e nasconde il guasto. Il foglio di condivisione col link
// (`ripiego-condivisione`, solo per URL firmati di altra origine) si vede da sé,
// e un gesto annullato non è un guasto: niente avviso.

import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isNativeApp } from '@/lib/push/native-register';
import {
    apriDocumento,
    fileConsegnato,
    scaricaDocumento,
    type RisultatoScaricoNativo,
    type SorgenteDocumento,
} from '@/lib/native/scarica';

export type ModoDocumento = 'apri' | 'scarica';

/** Il tipo degli export XLSX di `/api/pagamenti/export`: dà l'estensione al file sul telefono. */
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface DocumentoNativo {
    modo: ModoDocumento;
    /** Nome del file sul telefono, estensione compresa. Mai un nome di persona. */
    nomeFile: string;
    mime?: string;
    /** Prefisso dei log dell'helper (token: `ricevuta-transazione`, `export-ade`…). */
    etichetta: string;
}

/** Il documento, nell'app, con l'helper unico. Non lancia mai: l'helper ritorna un verdetto. */
export function documentoNativo(sorgente: SorgenteDocumento, doc: DocumentoNativo): Promise<RisultatoScaricoNativo> {
    const input = {
        sorgente,
        nomeFile: doc.nomeFile,
        ...(doc.mime ? { mime: doc.mime } : {}),
        etichetta: doc.etichetta,
    };
    return doc.modo === 'apri' ? apriDocumento(input) : scaricaDocumento(input);
}

/**
 * L'utente va avvisato? Sì quando non ha ottenuto niente che si VEDA. Il file
 * consegnato e il foglio col link non chiedono avviso; il gesto annullato
 * nemmeno. Tutto il resto — `non-riuscito`, e un `ripiego-appunti` che è muto —
 * sì. Elenco chiuso di ciò che TACE: un esito nuovo nasce parlante.
 */
export function daAvvisare(risultato: RisultatoScaricoNativo): boolean {
    if (fileConsegnato(risultato)) return false;
    if (risultato.esito === 'ripiego-condivisione') return false;
    if (risultato.esito === 'non-riuscito' && risultato.motivo === 'annullato') return false;
    return true;
}

/** Quale avviso: il binario va aggiornato, oppure il documento non è arrivato e si riprova. */
export type TipoAvvisoDocumento = 'aggiorna' | 'riprova';

/**
 * Il testo dell'avviso segue il verdetto dell'helper. «Aggiorna» SOLO se l'helper
 * dice `binarioDaAggiornare: true`; ogni altro esito da segnalare è «riprova».
 */
export function tipoAvviso(risultato: RisultatoScaricoNativo): TipoAvvisoDocumento | null {
    if (!daAvvisare(risultato)) return null;
    return risultato.binarioDaAggiornare === true ? 'aggiorna' : 'riprova';
}

/**
 * Gesto nativo con un solo volo alla volta e l'avviso quando serve. Lo usano
 * `LinkDocumento` e i pulsanti che l'URL lo ottengono solo dopo una fetch (cassa).
 */
export function useDocumentoNativo() {
    const inVolo = useRef(false);
    const [avviso, setAvviso] = useState<TipoAvvisoDocumento | null>(null);
    const esegui = useCallback(async (sorgente: SorgenteDocumento, doc: DocumentoNativo) => {
        // Un secondo tocco mentre il primo scarica non apre un secondo foglio.
        if (inVolo.current) return;
        inVolo.current = true;
        setAvviso(null);
        try {
            const risultato = await documentoNativo(sorgente, doc);
            setAvviso(tipoAvviso(risultato));
        } finally {
            inVolo.current = false;
        }
    }, []);
    return { esegui, avviso, setAvviso };
}

/** L'avviso dopo un gesto nativo non riuscito: il testo dipende dal tipo. */
export function AvvisoDocumentoNativo({ tipo, className }: { tipo: TipoAvvisoDocumento; className?: string }) {
    const t = useTranslations('adminContabilita');
    return (
        <span role="alert" className={className ?? 'font-maven text-xs text-kidville-error-strong'}>
            {tipo === 'aggiorna' ? t('docNativoAggiornaApp') : t('docNativoNonRiuscito')}
        </span>
    );
}

interface Props extends DocumentoNativo {
    /** La route della stessa origine che produce il documento. */
    href: string;
    children: ReactNode;
    className?: string;
    title?: string;
    'aria-label'?: string;
    /** Come prima sul web: `_blank` per le ricevute, assente per gli export. */
    target?: '_blank';
}

export function LinkDocumento({ href, children, className, title, target, modo, nomeFile, mime, etichetta, ...resto }: Props) {
    const { esegui, avviso } = useDocumentoNativo();

    const alTocco = (e: MouseEvent<HTMLAnchorElement>) => {
        // Sul web il clic segue l'`href`: nessuna differenza da prima.
        if (!isNativeApp()) return;
        e.preventDefault();
        void esegui(href, { modo, nomeFile, etichetta, ...(mime ? { mime } : {}) });
    };

    return (
        <>
            <a
                href={href}
                {...(target ? { target, rel: 'noopener noreferrer' } : {})}
                title={title}
                aria-label={resto['aria-label']}
                className={className}
                onClick={alTocco}
            >
                {children}
            </a>
            {avviso && <AvvisoDocumentoNativo tipo={avviso} />}
        </>
    );
}
