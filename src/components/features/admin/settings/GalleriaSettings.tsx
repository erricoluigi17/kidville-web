'use client';

import { useState } from 'react';
import { Images } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface GalleriaConfig {
    consenso_privacy_richiesto: boolean;
    upload_ruoli: string[];
    approvazione_admin_richiesta: boolean;
    download_genitori_abilitato: boolean;
    max_mb_per_file: number;
}

const RUOLI = [
    { id: 'admin', label: 'Segreteria/Admin' },
    { id: 'teacher', label: 'Docenti' },
];

export function GalleriaSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<GalleriaConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-gray-400">Caricamento…</p>;
    const cfg = draft ?? ((settings.galleria_config ?? {}) as GalleriaConfig);
    const set = (patch: Partial<GalleriaConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ galleria_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><Images size={16} /> Galleria foto e video</h3>

            <label className={label}>Chi può caricare media</label>
            <PillMultiSelect options={RUOLI} selected={cfg.upload_ruoli ?? ['admin', 'teacher']} onChange={(v) => set({ upload_ruoli: v })} />

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.consenso_privacy_richiesto ?? true} onChange={(v) => set({ consenso_privacy_richiesto: v })}>
                    Mostra solo media di alunni con consenso privacy
                </CheckField>
                <CheckField checked={cfg.approvazione_admin_richiesta ?? false} onChange={(v) => set({ approvazione_admin_richiesta: v })}>
                    <>Approvazione della segreteria prima della pubblicazione <ComingSoonBadge /></>
                </CheckField>
                <CheckField checked={cfg.download_genitori_abilitato ?? true} onChange={(v) => set({ download_genitori_abilitato: v })}>
                    Download consentito ai genitori
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.max_mb_per_file ?? 25} min={1} max={500} onChange={(v) => set({ max_mb_per_file: v })}>
                    Dimensione max per file (MB)
                </NumberField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>La visibilità della galleria per grado si gestisce in Funzioni &amp; moduli.</p>
        </section>
    );
}
