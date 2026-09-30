'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, BellOff } from 'lucide-react';
import { isNativeApp, registerNativePush, unregisterNativePush } from '@/lib/push/native-register';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { esitoPushRitentabile, statoHttpRitentabile } from '@/lib/push/esiti-ritentabili';

interface Props {
    userId: string;
    /**
     * I testi del pulsante per chi non è un genitore (consegna 2c: la pagina «Coda fatture»
     * dello staff). Assente → i testi dei promemoria pagamenti, come sempre.
     */
    etichette?: { attiva: string; attive: string };
}

/**
 * Le classi d'errore con cui `pushManager.subscribe()` rifiuta per un motivo che NON guarisce
 * riprovando: permesso negato dal browser, chiavi che non combaciano con l'iscrizione già
 * presente, configurazione che il browser non regge.
 */
const ERRORI_SUBSCRIBE_DEFINITIVI: ReadonlySet<string> = new Set([
    'NotAllowedError',
    'InvalidStateError',
    'InvalidAccessError',
    'NotSupportedError',
]);

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

export function PushOptIn({ userId, etichette }: Props) {
    const t = useTranslations('pagamenti');
    // Nella shell nativa la push non usa il service worker: bottone sempre disponibile.
    // Lazy initializer (non setState in effect) per non violare react-hooks set-state-in-effect.
    const [supported, setSupported] = useState<boolean>(() => isNativeApp());
    const [subscribed, setSubscribed] = useState(false);
    const [busy, setBusy] = useState(false);
    /**
     * L'ULTIMO TENTATIVO È ANDATO MALE — e prima del 2026-09-30 non lo diceva nessuno.
     *
     * `enable()` scriveva `setSubscribed(true)` senza guardare `res.ok`: il POST risponde 503
     * quando VAPID non è configurato, e il pulsante diventava «Promemoria attivi» con zero
     * righe in `push_subscriptions`. È il silenzio della segnalazione del 29/09 visto da
     * questo lato: a schermo «attive», sul telefono niente.
     */
    const [errore, setErrore] = useState<'ritentabile' | 'definitivo' | null>(null);

    useEffect(() => {
        if (isNativeApp()) return; // nativo: nessun service worker da interrogare
        const ok = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
        if (ok) {
            navigator.serviceWorker.getRegistration().then(async (reg) => {
                const sub = await reg?.pushManager.getSubscription();
                setSupported(true);
                setSubscribed(!!sub);
            });
        }
    }, []);

    /**
     * Annulla l'iscrizione che il server non ha accettato, e lo scrive.
     *
     * Non lancia: se `unsubscribe()` fallisce resta un'iscrizione locale che il server non
     * conosce — cioè il difetto di partenza — e l'unica cosa che si può fare è dirlo, perché
     * al prossimo montaggio il pulsante mentirà e nessun'altra traccia lo spiegherebbe.
     */
    const annullaIscrizione = async (sub: PushSubscription) => {
        try {
            const via = await sub.unsubscribe();
            logClient({
                livello: 'warn',
                evento: 'push',
                messaggio: 'push-optin-iscrizione-annullata-dopo-rifiuto',
                campi: { esito: via ? 'annullata' : 'rifiutata' },
            });
        } catch (e) {
            logClient({
                livello: 'error',
                evento: 'js',
                messaggio: `push-optin-annullamento-fallito: ${nomeErrore(e)}`,
            });
        }
    };

    /**
     * Un tentativo respinto: lo si DICE, distinguendo ciò che ha senso riprovare.
     * La regola sta in `statoHttpRitentabile`, con l'eccezione del 503 scritta lì.
     */
    const rifiutato = (messaggio: string, stato: number) => {
        // `evento: 'fetch'` e lo `stato`: è una risposta HTTP, e il livello lo decide la
        // politica di `logClient` (la stessa dei due lati, vedi `livelloEvento`).
        logClient({ livello: 'error', evento: 'fetch', stato, messaggio });
        setErrore(statoHttpRitentabile(stato) ? 'ritentabile' : 'definitivo');
    };

    const enable = async () => {
        setBusy(true);
        setErrore(null);
        /**
         * L'ISCRIZIONE NATA IN QUESTO TENTATIVO, tenuta FUORI dal `try`.
         *
         * ⚠️ Serve al `catch`, ed è il difetto che chiude: quando il POST cade per RETE
         * (`fetch` che lancia, non un 503) il ramo `!res.ok` non viene mai raggiunto, e prima
         * l'iscrizione appena creata restava nel browser. Al montaggio successivo
         * `getSubscription()` la ritrovava e il pulsante diceva «Promemoria attivi» con zero
         * righe sul server — la stessa bugia del 503, per un'altra strada. Dentro il `try`
         * questa variabile non sarebbe visibile da lì.
         *
         * ⚠️ «NATA ORA» SI DECIDE PRIMA DI `subscribe()`, non dopo: con le stesse chiavi VAPID
         * `subscribe()` restituisce l'iscrizione che c'è GIÀ invece di crearne una seconda, e
         * quella può essere di un'altra scheda (o di un'altra persona su un PC condiviso) e
         * funzionare benissimo. Annullarla per un guasto avvenuto qui spegnerebbe le notifiche
         * a chi non ha fatto niente.
         */
        let creata: PushSubscription | null = null;
        try {
            if (isNativeApp()) {
                const r = await registerNativePush();
                if (r.ok) {
                    setSubscribed(true);
                } else {
                    // Il perché l'ha già loggato `registerNativePush`, con l'esito preciso
                    // (permesso negato, plugin assente, token mai arrivato): qui si mostra.
                    // La classificazione è quella condivisa con `NativePushAutoRegister`, che
                    // su un esito ritentabile riprova da sé: se i due elenchi divergessero, lo
                    // stesso fatto avrebbe due risposte a due metri di distanza.
                    setErrore(esitoPushRitentabile(r.error) ? 'ritentabile' : 'definitivo');
                }
                return;
            }
            const perm = await Notification.requestPermission();
            // `default` è il prompt chiuso senza scegliere (X, Esc): il permesso si può ancora
            // chiedere, quindi il pulsante resta com'è e non si dice niente.
            if (perm !== 'granted') return;
            const reg = await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
            const keyRisposta = await fetch('/api/push/vapid-public-key');
            if (!keyRisposta.ok) {
                // Senza la chiave VAPID `subscribe()` lancerebbe, e l'utente leggerebbe
                // soltanto il catch generico: qui l'esito è lo status, che dice dov'è il guasto.
                rifiutato('push-optin-chiave-vapid-non-disponibile', keyRisposta.status);
                return;
            }
            const keyRes = await keyRisposta.json();
            const esistente = await reg.pushManager.getSubscription();
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey) as BufferSource,
            });
            // `subscribe()` può aver restituito quella di prima: solo se non c'era niente
            // l'iscrizione è nostra, e solo allora si può annullare.
            creata = esistente ? null : sub;
            const res = await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ subscription: sub.toJSON() }),
            });
            if (!res.ok) {
                // ⚠️ IL RAMO CHE MANCAVA. 503 = VAPID non configurato, 500 = scrittura
                // fallita: in entrambi i casi il dispositivo NON è iscritto, e dire «attivi»
                // è la bugia descritta in testa a questo file. L'iscrizione nata qui si
                // annulla, altrimenti al montaggio dopo il pulsante torna a mentire da solo.
                if (creata) await annullaIscrizione(creata);
                creata = null;
                rifiutato('push-optin-registrazione-rifiutata', res.status);
                return;
            }
            setSubscribed(true);
        } catch (e) {
            // `evento: 'js'` e non `'fetch'`: qui a rompersi è quasi sempre un'API del browser
            // (`Notification.requestPermission`, `serviceWorker.register`, `pushManager.subscribe`),
            // non una chiamata HTTP — e la classe dell'errore è l'unica cosa che lo distingue.
            const classe = nomeErrore(e);
            logClient({ livello: 'error', evento: 'js', messaggio: `push-optin-fallito: ${classe}` });
            // Il POST caduto per rete arriva QUI, non nel ramo `!res.ok`: se l'iscrizione è
            // nata in questo tentativo va annullata, o resta un'iscrizione che il server non
            // conosce e il pulsante dirà «attivi» al prossimo montaggio.
            if (creata) await annullaIscrizione(creata);
            // NON TUTTO QUELLO CHE ARRIVA QUI È RITENTABILE. Una rete caduta (`TypeError`) sì.
            // Ma `pushManager.subscribe()` rifiuta con `NotAllowedError` quando il permesso è
            // negato e con `InvalidStateError`/`NotSupportedError` quando le chiavi non
            // combaciano o il browser non regge quella configurazione: riprovare fra qualche
            // istante non cambierebbe niente, e lo direbbe a chi deve invece andare nelle
            // impostazioni del sito.
            setErrore(ERRORI_SUBSCRIBE_DEFINITIVI.has(classe) ? 'definitivo' : 'ritentabile');
        } finally {
            setBusy(false);
        }
    };

    const disable = async () => {
        setBusy(true);
        setErrore(null);
        try {
            if (isNativeApp()) {
                await unregisterNativePush();
                setSubscribed(false);
                return;
            }
            const reg = await navigator.serviceWorker.getRegistration();
            const sub = await reg?.pushManager.getSubscription();
            if (sub) {
                await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}&userId=${userId}`, {
                    method: 'DELETE', headers: { 'x-user-id': userId },
                });
                await sub.unsubscribe();
            }
            setSubscribed(false);
        } finally {
            setBusy(false);
        }
    };

    if (!supported) return null;

    return (
        <div className="flex flex-col items-start gap-1">
            <button
                onClick={subscribed ? disable : enable}
                disabled={busy}
                className={`flex items-center gap-2 px-4 py-2 rounded-full font-maven text-sm font-bold disabled:opacity-50 ${subscribed ? 'bg-kidville-green text-white' : 'border-2 border-kidville-green text-kidville-green'}`}
            >
                {subscribed ? <Bell size={15} /> : <BellOff size={15} />}
                {subscribed ? (etichette?.attive ?? t('promemoriaAttivi')) : (etichette?.attiva ?? t('attivaPromemoria'))}
            </button>
            {/* La regione è SEMPRE nel DOM e si riempie: uno `role="status"` inserito già
                pieno non viene annunciato dagli screen reader, perché dentro una regione appena
                creata non c'è stato nessun cambiamento. È l'unico segnale che dice a chi non
                vede il colore del pulsante che il tentativo è andato male. Vuota è `sr-only` e
                non `hidden`: `display: none` la toglierebbe dall'albero di accessibilità, e
                riempirla equivarrebbe a crearne una nuova. */}
            <p role="status" className="font-maven text-[13px] text-kidville-error-strong empty:sr-only">
                {errore === null
                    ? ''
                    : errore === 'ritentabile'
                      ? t('pushAttivazioneNonRiuscita')
                      : t('pushAttivazioneNonPossibile')}
            </p>
        </div>
    );
}
