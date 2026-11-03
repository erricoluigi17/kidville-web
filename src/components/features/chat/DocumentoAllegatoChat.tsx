'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { allegatoMostrabile } from '@/lib/chat/stato-conversazione';
import { avvisoDocumento, nomeDocumentoDa, suNativo, type AvvisoDocumento } from '@/lib/native/documento-genitore';

/**
 * IL CHIP «📎 DOCUMENTO ALLEGATO» DI UNA BOLLA DI CHAT, e l'avviso che lo accompagna.
 *
 * Estratto da `ChatMessageArea` il 2026-11-03, SENZA cambiare niente di ciò che faceva: la pagina
 * Messaggi della segreteria (le schede «Con i genitori» e «Tutti») disegna ora gli stessi allegati
 * delle chat di genitore e docente, e il chip è il pezzo che non si deve ricopiare — è quello con la
 * logica dell'app nativa, e due copie divergono (è già successo con il visore delle foto).
 *
 * ─── COSA FA ────────────────────────────────────────────────────────────────────────────────
 *  · indirizzo `http(s)`: un collegamento che apre il documento. Sul web resta un `<a target="_blank">`;
 *    nell'app 1.1 `suNativo('apri', …)` ferma la navigazione e apre l'anteprima di sistema DENTRO
 *    l'app (spec 2026-09-24, NAT3c). Il log dell'esito lo scrive l'helper, non questo componente;
 *  · tutto il resto (un percorso grezzo non ancora firmato, uno schema non-http come `javascript:`
 *    salvato via API): niente collegamento, solo il chip inerte com'era prima;
 *  · l'avviso: nell'app, se l'ultimo tocco non ha mostrato niente (anteprima non aperta, condivisione
 *    fallita, copia muta negli appunti) lo si dice sotto il chip. Il valore dello stato è il TIPO
 *    d'avviso: sul binario 1.0 (`'aggiorna'`) riprovare non riuscirà mai, e il testo lo deve dire
 *    invece di «riprova fra qualche minuto».
 *
 * Chi lo usa decide SE c'è un documento (`attachment_type === 'document'` e un indirizzo): qui si
 * disegna soltanto. `suSfondoScuro` dice su che bolla sta — la propria, verde col testo bianco, oppure
 * una chiara — perché cambiano il fondo del chip e il colore dell'avviso.
 */
export function DocumentoAllegatoChat({ url, suSfondoScuro }: { url: string; suSfondoScuro: boolean }) {
    const t = useTranslations('parentChat');
    const ts = useTranslations('shared');
    const [allegatoNonAperto, setAllegatoNonAperto] = useState<AvvisoDocumento | null>(null);

    const classiChip = `mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 ${suSfondoScuro ? 'bg-white/20' : 'bg-kidville-neutral-soft'}`;

    return (
        <>
            {allegatoMostrabile(url) ? (
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    // L'allegato è da GUARDARE (spec 2026-09-24, NAT3c): sul web il
                    // collegamento resta com'è; nell'app 1.1 `suNativo` apre l'anteprima
                    // di sistema dentro l'app. Il log lo scrive l'helper.
                    onClick={suNativo(
                        'apri',
                        () => ({
                            sorgente: url,
                            nomeFile: nomeDocumentoDa(null, url, 'kidville-allegato'),
                            etichetta: 'allegato-chat',
                        }),
                        (esito) => setAllegatoNonAperto(avvisoDocumento(esito)),
                    )}
                    className={`${classiChip} underline-offset-2 hover:underline`}
                >
                    📎 {t('documentAttachment')}
                </a>
            ) : (
                // URL con schema non-http (es. javascript:) salvato via API:
                // niente link, solo il chip inerte com'era prima.
                <div className={classiChip}>
                    📎 {t('documentAttachment')}
                </div>
            )}
            {allegatoNonAperto && (
                <p role="alert" className={`mb-2 font-maven text-xs ${suSfondoScuro ? 'font-semibold text-white' : 'text-kidville-error'}`}>
                    {ts(allegatoNonAperto === 'aggiorna' ? 'documentoAppDaAggiornare' : 'documentoNonAperto')}
                </p>
            )}
        </>
    );
}
