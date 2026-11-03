'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ComandiMedia } from '@/components/features/media/ComandiMedia';
import { useAzioniMedia } from '@/components/features/media/useAzioniMedia';
import { VisoreMedia, type MediaVisore } from '@/components/features/media/VisoreMedia';
import { allegatoMostrabile, type ChatMessage } from '@/lib/chat/stato-conversazione';

/** Dei messaggi il visore guarda solo l'allegato: id e tipo servono a scegliere e a identificare. */
type MessaggioConAllegato = Pick<ChatMessage, 'id' | 'attachment_url' | 'attachment_type'>;

export interface VisoreFotoChatProps {
    /** I messaggi della conversazione caricata, in ordine cronologico: il visore sceglie da sé le foto. */
    messaggi: MessaggioConAllegato[];
    /** L'id del MESSAGGIO la cui foto è aperta; `null` = chiuso. */
    apertoId: string | null;
    onCambia: (id: string) => void;
    /** ✕, `Escape`, tocco fuori, tasto Indietro di Android — e la sparizione del messaggio aperto. */
    onChiudi: () => void;
    /**
     * Chi sta guardando, e quindi quali comandi ha (spec 2026-11-03, «Chi ha quali pulsanti»):
     *  · `genitore` — Scarica e Condividi (il file);
     *  · `staff` — solo Scarica (docente, segreteria nella scheda «Con i genitori»);
     *  · `vigilanza` — solo Scarica, e SOLO attraverso `onScaricaVigilanza`: la scheda «Tutti» è la
     *    supervisione silenziosa, dove lo scarico deve prima farsi registrare dal server.
     */
    azioni: 'genitore' | 'staff' | 'vigilanza';
    /**
     * Solo con `azioni="vigilanza"` (la scheda «Tutti» di `admin/messaggi`): riceve l'id del messaggio
     * e fa tutto da sé — chiede al server di registrare lo scarico, scarica con l'indirizzo fresco che
     * riceve, avvisa a schermo se il registro rifiuta. Se manca, dalla supervisione Scarica NON
     * compare: un file che esce senza riga nel registro di vigilanza è esattamente ciò che questa
     * scheda deve impedire.
     */
    onScaricaVigilanza?: (messaggioId: string) => Promise<void>;
}

/**
 * IL VISORE DELLE FOTO DI UNA CONVERSAZIONE: adatta i messaggi a `VisoreMedia` e a `ComandiMedia`.
 *
 * Il visore (portale, livello, fuoco, inerzia dello sfondo, frecce, tasto Indietro di Android) e la
 * riga Scarica/Condividi sono i pezzi della galleria (`../media/*`): qui non si riscrive niente, si
 * decide solo COSA mostrare e COSA permettere. Lo usano la chat del genitore e quella del docente,
 * attraverso `ChatMessageArea`, e la pagina Messaggi della segreteria.
 *
 * ─── COSA ENTRA NEL VISORE ───────────────────────────────────────────────────────────────────
 * Le foto (`attachment_type === 'image'`) il cui indirizzo è `allegatoMostrabile`, nell'ordine in
 * cui arrivano (cronologico). Un messaggio col PERCORSO GREZZO — arrivato dal realtime, non ancora
 * firmato — non c'è: non avrebbe niente da mostrare, e la sua miniatura non si vede nemmeno (la
 * bolla non la disegna). Quando il polling porta il link firmato la foto entra al suo posto. I
 * documenti non sono media del visore. L'identità di una foto è l'id del messaggio, mai l'URL.
 *
 * ─── L'URL CHE CAMBIA A OGNI POLLING ─────────────────────────────────────────────────────────
 * La chat rifirma gli indirizzi a ogni giro da 30 s (`useChatRealtime`, `stato-conversazione`), e
 * ogni firma vale 10 minuti. Due esigenze opposte, e vanno tenute separate:
 *
 *  · l'IMMAGINE A SCHERMO non deve ricaricarsi finché il visore resta su quella foto: un `src` che
 *    cambia ogni mezzo minuto la fa sfarfallare sotto gli occhi di chi guarda. Si mostra quindi
 *    l'indirizzo visto quando ci si è arrivati (`mostrata`);
 *  · SCARICA e CONDIVIDI devono usare l'indirizzo PIÙ RECENTE (`urlCorrente`, dalle props): dopo dieci
 *    minuti di visore aperto quello con cui la foto è comparsa può essere scaduto.
 *
 * ⚠️ Si congela UN indirizzo solo, quello della foto a schermo, e si rilascia quando si cambia
 * foto o si chiude. Non uno per ogni foto già vista, fino alla chiusura: tornando su una foto dopo
 * più di dieci minuti si riaprirebbe con la sua prima firma, scaduta, mentre così riparte da quella
 * viva. Il costo è un nuovo scaricamento dell'immagine quando si torna su una foto già vista: si
 * sta comunque cambiando foto, e l'`<img>` cambia `src`. E non in un `useRef`: la regola
 * `react-hooks/refs` vieta di leggerlo e scriverlo durante il render, e qui serve a disegnare. È lo
 * stato derivato nella forma che React indica («aggiustare lo stato durante il render», con una
 * condizione che lo ferma al secondo giro), non un effetto: la regola `set-state-in-effect` non ne
 * vuole.
 *
 * ─── SE LA FOTO NON C'È PIÙ ──────────────────────────────────────────────────────────────────
 * Il messaggio sparisce o la conversazione cambia mentre il visore è aperto: `VisoreMedia` con un id
 * che non è fra i suoi elementi non rende niente, ma NON chiama `onChiudi` (non è un gesto
 * dell'utente) e non prende il tasto Indietro. Chiudere davvero, cioè azzerare l'id di chi lo usa,
 * tocca a noi: senza quello l'id resterebbe lì, e al ritorno del messaggio (la lista si ricarica) il
 * visore si riaprirebbe da solo. Lo si fa in un effetto che chiama `onChiudi`, non un `setState`.
 *
 * ─── IL NOME DEL FILE ────────────────────────────────────────────────────────────────────────
 * `nomeFile` è sempre `null`: lo decide `nomeFileScarico`, che dall'indirizzo ricava
 * `kidville-foto.<ext>`. Il percorso nel bucket ha la forma `${uuid}-${nome originale}`, e il nome
 * originale di una foto mandata da una famiglia o da una maestra non deve entrare né nel file
 * scaricato né nei log.
 */
export function VisoreFotoChat({ messaggi, apertoId, onCambia, onChiudi, azioni, onScaricaVigilanza }: VisoreFotoChatProps) {
    const t = useTranslations('parentChat');
    // UNA volta, qui: la guardia «un'azione alla volta» è una per superficie e la passa ai comandi.
    // L'etichetta dà il prefisso ai log (`chat-…`, `chat-vigilanza-…`) che `app_log` interroga.
    const azioniMedia = useAzioniMedia({ etichetta: azioni === 'vigilanza' ? 'chat-vigilanza' : 'chat' });

    const foto = useMemo(
        () =>
            messaggi.flatMap((m) =>
                m.attachment_type === 'image' && allegatoMostrabile(m.attachment_url)
                    ? [{ id: m.id, url: m.attachment_url as string }]
                    : [],
            ),
        [messaggi],
    );

    // L'indirizzo PIÙ RECENTE della foto aperta: è quello dei comandi.
    const urlCorrente = apertoId === null ? undefined : foto.find((f) => f.id === apertoId)?.url;

    // L'indirizzo con cui la foto aperta è COMPARSA: è quello dell'<img>. Vedi il blocco sopra.
    const [mostrata, setMostrata] = useState<{ id: string; url: string } | null>(null);
    if (apertoId === null) {
        if (mostrata !== null) setMostrata(null);
    } else if (urlCorrente !== undefined && mostrata?.id !== apertoId) {
        setMostrata({ id: apertoId, url: urlCorrente });
    }
    const urlMostrato = apertoId !== null && mostrata?.id === apertoId ? mostrata.url : urlCorrente;

    const elementi = useMemo<MediaVisore[]>(
        () =>
            foto.map((f) => ({
                id: f.id,
                url: f.id === apertoId && urlMostrato !== undefined ? urlMostrato : f.url,
                tipo: 'foto',
                alt: t('attachmentAlt'),
            })),
        [foto, apertoId, urlMostrato, t],
    );

    // Un nome neutro e con la posizione: mai quello del mittente.
    const etichetta = useCallback(
        (m: MediaVisore) =>
            t('chatFotoConversazione', { n: elementi.findIndex((e) => e.id === m.id) + 1, totale: elementi.length }),
        [elementi, t],
    );

    const fotoPersa = apertoId !== null && urlCorrente === undefined;
    useEffect(() => {
        if (fotoPersa) onChiudi();
    }, [fotoPersa, onChiudi]);

    const dallaSupervisione = azioni === 'vigilanza';

    return (
        <VisoreMedia
            elementi={elementi}
            apertoId={apertoId}
            onCambia={onCambia}
            onChiudi={onChiudi}
            etichetta={etichetta}
        >
            {apertoId !== null && urlCorrente !== undefined && (
                <ComandiMedia
                    // `url` è la CORRENTE delle props, mai quella congelata dell'<img>: dopo dieci
                    // minuti di visore aperto la prima firma può essere scaduta. (Un media con `url`
                    // vuota non sarebbe azionabile in `ComandiMedia`: da qui non succede, perché si
                    // arriva solo con la foto presente fra quelle mostrabili.)
                    media={{ id: apertoId, url: urlCorrente, tipo: 'foto', nomeFile: null }}
                    azioni={azioniMedia}
                    conScarica={!dallaSupervisione || onScaricaVigilanza !== undefined}
                    conCondividi={azioni === 'genitore'}
                    onScarica={
                        dallaSupervisione && onScaricaVigilanza
                            ? (m) => onScaricaVigilanza(m.id)
                            : undefined
                    }
                />
            )}
        </VisoreMedia>
    );
}
