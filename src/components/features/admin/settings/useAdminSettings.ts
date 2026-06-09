'use client';

import { useCallback, useEffect, useState } from 'react';
import { hdr } from './ui';

/**
 * Hook condiviso per i pannelli Impostazioni: carica admin_settings e
 * salva aggiornamenti parziali via PATCH (le chiavi *_config e
 * funzioni_matrice vengono unite lato server, non sovrascritte).
 */
export function useAdminSettings(userId: string) {
    const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => { if (active && d.success) setSettings(d.data); })
            .catch(() => { if (active) setError('Errore di caricamento'); });
        return () => { active = false; };
    }, [userId]);

    const save = useCallback(async (updates: Record<string, unknown>) => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch('/api/admin/settings', {
                method: 'PATCH', headers: hdr(userId), body: JSON.stringify(updates),
            });
            const j = await res.json();
            if (j.success) { setSettings(j.data); return true; }
            setError(j.error ?? 'Errore di salvataggio');
            return false;
        } catch {
            setError('Errore di rete');
            return false;
        } finally {
            setSaving(false);
        }
    }, [userId]);

    return { settings, save, saving, error };
}
