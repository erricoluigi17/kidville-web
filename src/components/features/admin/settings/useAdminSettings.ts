'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { hdr } from './ui';

/**
 * Hook condiviso per i pannelli Impostazioni: carica admin_settings e
 * salva aggiornamenti parziali via PATCH (le chiavi *_config e
 * funzioni_matrice vengono unite lato server, non sovrascritte).
 */
export function useAdminSettings(userId: string) {
    const t = useTranslations('adminSettings');
    const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => { if (active && d.success) setSettings(d.data); })
            .catch(() => { if (active) setError(t('erroreCaricamentoDati')); });
        return () => { active = false; };
    }, [userId, t]);

    const save = useCallback(async (updates: Record<string, unknown>) => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch('/api/admin/settings', {
                method: 'PATCH', headers: hdr(userId), body: JSON.stringify(updates),
            });
            const j = await res.json();
            if (j.success) { setSettings(j.data); return true; }
            setError(j.error ?? t('erroreSalvataggio'));
            return false;
        } catch {
            setError(t('erroreRete'));
            return false;
        } finally {
            setSaving(false);
        }
    }, [userId, t]);

    return { settings, save, saving, error };
}
