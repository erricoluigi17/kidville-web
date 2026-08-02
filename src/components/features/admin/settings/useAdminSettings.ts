'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { hdr } from './ui';

/**
 * L'errore si tiene come MARCATORE, non come frase già tradotta.
 *
 * Non è pignoleria di stile: `t` di next-intl è un valore che può cambiare
 * identità fra un render e l'altro (cambio lingua, provider ri-creato, e nei
 * test a ogni singolo render). Tenerlo fra le dipendenze dell'effetto significa
 * ricaricare la configurazione a ogni render — e, peggio, rende impossibile
 * accorgersi se la SEDE cade fuori dalle dipendenze, perché l'effetto riparte
 * comunque. La traduzione si fa al ritorno, dove non è dipendenza di nessuno;
 * `testo` è invece il messaggio del server, che è già una frase compiuta.
 */
type Errore = { chiave: string } | { testo: string } | null;

/**
 * Hook condiviso per i pannelli Impostazioni: carica `admin_settings` DI UNA
 * SEDE e ne salva aggiornamenti parziali via PATCH (le chiavi `*_config` e
 * `funzioni_matrice` vengono unite lato server, non sovrascritte).
 *
 * LA SEDE È UN PARAMETRO, non un dettaglio implementativo. `admin_settings` ha
 * UNA riga per plesso: senza `scuola_id` la scelta finiva al server, che fino al
 * 2026-07-31 ripiegava in silenzio sulla sede primaria dell'operatore. Chi
 * credeva di configurare Aversa cambiava i permessi della chat, degli avvisi e
 * delle presenze DI GIUGLIANO — senza errore e senza log. Da quella data lo
 * stesso percorso risponde 400: il salvataggio non avviene e basta. In entrambi
 * i casi il selettore di sede del cockpit era decorativo.
 *
 * Perciò `scuolaId` è OBBLIGATORIO e i pannelli girano dentro <SedeRequired>,
 * che rende i figli solo quando è selezionata una singola sede.
 */
export function useAdminSettings(userId: string, scuolaId: string) {
    const t = useTranslations('adminSettings');
    const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState<Errore>(null);

    // La sede è una DIPENDENZA: cambiarla ricarica la configurazione di quella
    // sede. Non azzera però lo stato locale del pannello (la bozza di modifica),
    // che è un problema diverso e si risolve dove va risolto: il chiamante
    // rimonta il pannello con `key={scuolaId}` (vedi `conSede` nella pagina).
    useEffect(() => {
        let active = true;
        fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => {
                if (!active) return;
                if (d?.success) { setSettings(d.data as Record<string, unknown>); return; }
                // Il server ha risposto NO (403 sede fuori scope, 400 sede non
                // risolvibile). Senza questo ramo il pannello restava su
                // «Caricamento…» per sempre: il modo silenzioso di non funzionare.
                // Si rende con i valori di default e si DICE che la lettura è fallita.
                setSettings({});
                setErrore({ chiave: 'erroreCaricamentoDati' });
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: 'admin/settings:GET — configurazione di sede non letta',
                });
            })
            .catch((err: unknown) => {
                if (!active) return;
                setSettings({});
                setErrore({ chiave: 'erroreCaricamentoDati' });
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `admin/settings:GET — ${nomeErrore(err)}`,
                });
            });
        return () => { active = false; };
    }, [userId, scuolaId]);

    const save = useCallback(async (updates: Record<string, unknown>) => {
        setSaving(true);
        setErrore(null);
        try {
            const res = await fetch('/api/admin/settings', {
                method: 'PATCH',
                headers: hdr(userId),
                // `scuola_id` DOPO lo spread: la sede la decide il selettore, non il
                // pannello. Una chiave omonima nel corpo non deve poterla scavalcare.
                body: JSON.stringify({ ...updates, scuola_id: scuolaId }),
            });
            const j = await res.json();
            if (j.success) { setSettings(j.data); return true; }
            setErrore(typeof j.error === 'string' ? { testo: j.error } : { chiave: 'erroreSalvataggio' });
            // Una configurazione che non si salva è un guasto operativo, non un
            // dettaglio: `withRoute` vede il 4xx lato server, ma non sa che
            // l'operatore stava salvando le impostazioni di un plesso. Nel
            // messaggio nessun testo del server (può contenere dato): solo lo stato.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'admin/settings:PATCH — configurazione di sede non salvata',
                stato: res.status,
            });
            return false;
        } catch (err: unknown) {
            setErrore({ chiave: 'erroreRete' });
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `admin/settings:PATCH — ${nomeErrore(err)}`,
            });
            return false;
        } finally {
            setSaving(false);
        }
    }, [userId, scuolaId]);

    const error = errore === null ? null : 'testo' in errore ? errore.testo : t(errore.chiave);

    return { settings, save, saving, error };
}
