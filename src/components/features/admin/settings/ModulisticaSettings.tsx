'use client';

import { useState } from 'react';
import { FileSignature } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, input, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface ModulisticaConfig {
    firma_otp_richiesta: boolean;
    promemoria_giorni: number;
    invio_ruoli: string[];
    export_formato: string;
}

const RUOLI = [
    { id: 'admin', label: 'Segreteria/Admin' },
    { id: 'teacher', label: 'Docenti' },
];

export function ModulisticaSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<ModulisticaConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-gray-400">Caricamento…</p>;
    const cfg = draft ?? ((settings.modulistica_config ?? {}) as ModulisticaConfig);
    const set = (patch: Partial<ModulisticaConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ modulistica_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><FileSignature size={16} /> Modulistica</h3>

            <label className={label}>Chi può inviare moduli alle famiglie</label>
            <PillMultiSelect options={RUOLI} selected={cfg.invio_ruoli ?? ['admin']} onChange={(v) => set({ invio_ruoli: v })} />

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.firma_otp_richiesta ?? true} onChange={(v) => set({ firma_otp_richiesta: v })}>
                    Firma dei moduli con OTP
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.promemoria_giorni ?? 3} min={1} max={30} onChange={(v) => set({ promemoria_giorni: v })}>
                    <>Promemoria moduli non compilati (giorni) <ComingSoonBadge /></>
                </NumberField>
                <div>
                    <label className={label}>Formato export submissions</label>
                    <select value={cfg.export_formato ?? 'csv'} onChange={(e) => set({ export_formato: e.target.value })} className={`${input} w-full`}>
                        <option value="csv">CSV</option>
                        <option value="xlsx">Excel (XLSX)</option>
                    </select>
                </div>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>Il form builder e le graduatorie restano nella sezione Modulistica dell&apos;area admin.</p>
        </section>
    );
}
