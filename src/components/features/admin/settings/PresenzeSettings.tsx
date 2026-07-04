'use client';

import { useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint } from './ui';
import { CheckField, TimeField, NumberField, SaveRow } from './fields';

interface PresenzeConfig {
    giustifica_obbligatoria: boolean;
    giustifica_max_giorni_retroattivi: number;
    giustifica_richiede_firma_otp: boolean;
    soglia_assenze_alert_pct: number;
    orario_appello_entro: string;
    uscite_anticipate_richiedono_delega: boolean;
}

export function PresenzeSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<PresenzeConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>;
    const cfg = draft ?? ((settings.presenze_config ?? {}) as PresenzeConfig);
    const set = (patch: Partial<PresenzeConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ presenze_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><CalendarCheck size={16} /> Presenze e giustifiche</h3>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <NumberField value={cfg.giustifica_max_giorni_retroattivi ?? 5} min={0} max={60} onChange={(v) => set({ giustifica_max_giorni_retroattivi: v })}>
                    Giorni max per giustificare
                </NumberField>
                <NumberField value={cfg.soglia_assenze_alert_pct ?? 25} min={1} max={100} onChange={(v) => set({ soglia_assenze_alert_pct: v })}>
                    Soglia alert assenze (%)
                </NumberField>
                <TimeField value={cfg.orario_appello_entro ?? '09:30'} onChange={(v) => set({ orario_appello_entro: v })}>
                    Appello entro le
                </TimeField>
            </div>

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.giustifica_obbligatoria ?? true} onChange={(v) => set({ giustifica_obbligatoria: v })}>
                    Giustifica obbligatoria per le assenze
                </CheckField>
                <CheckField checked={cfg.giustifica_richiede_firma_otp ?? true} onChange={(v) => set({ giustifica_richiede_firma_otp: v })}>
                    La giustifica richiede firma OTP del genitore
                </CheckField>
                <CheckField checked={cfg.uscite_anticipate_richiedono_delega ?? true} onChange={(v) => set({ uscite_anticipate_richiedono_delega: v })}>
                    Le uscite anticipate richiedono delega registrata
                </CheckField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>La finestra retroattiva e la firma OTP sono applicate dal server alla creazione delle giustifiche.</p>
        </section>
    );
}
