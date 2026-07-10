'use client';

import { useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, label, hint } from './ui';
import { CheckField, TimeField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface DiarioConfig {
    routine_attive: string[];
    orario_compilazione_da: string;
    orario_compilazione_a: string;
    visibile_genitori_da: string;
    buffer_visibilita_min: number;
    note_libere_abilitate: boolean;
    diario_primaria_visibile: boolean;
}

const ROUTINE = [
    { id: 'pasto', label: 'Pasto' },
    { id: 'sonno', label: 'Sonno' },
    { id: 'cambio', label: 'Cambio' },
    { id: 'attivita', label: 'Attività' },
    { id: 'umore', label: 'Umore' },
];

export function DiarioSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<DiarioConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>;
    const cfg = draft ?? ((settings.diario_config ?? {}) as DiarioConfig);
    const set = (patch: Partial<DiarioConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ diario_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><NotebookPen size={16} /> Diario (nido/infanzia) <ComingSoonBadge /></h3>
            <p className="font-maven text-xs text-kidville-muted mb-4">Configurazione del diario giornaliero. La routine Umore è già applicata al diario della maestra; le altre regole verranno applicate nelle prossime versioni.</p>

            <label className={label}>Routine attive nel diario</label>
            <PillMultiSelect options={ROUTINE} selected={cfg.routine_attive ?? []} onChange={(v) => set({ routine_attive: v })} />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                <TimeField value={cfg.orario_compilazione_da ?? '08:00'} onChange={(v) => set({ orario_compilazione_da: v })}>Compilazione dalle</TimeField>
                <TimeField value={cfg.orario_compilazione_a ?? '18:00'} onChange={(v) => set({ orario_compilazione_a: v })}>Compilazione fino alle</TimeField>
                <TimeField value={cfg.visibile_genitori_da ?? '16:00'} onChange={(v) => set({ visibile_genitori_da: v })}>Visibile ai genitori dalle</TimeField>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                <NumberField value={cfg.buffer_visibilita_min ?? 10} min={0} max={120} onChange={(v) => set({ buffer_visibilita_min: v })}>
                    Ritardo visibilità genitori (min)
                </NumberField>
            </div>
            <p className="font-maven text-xs text-kidville-muted mt-1">Il genitore vede una voce del diario solo dopo questi minuti dalla scrittura (finestra di correzione per la maestra), come per le valutazioni della primaria.</p>

            <div className="mt-4">
                <CheckField checked={cfg.note_libere_abilitate ?? true} onChange={(v) => set({ note_libere_abilitate: v })}>
                    Note libere dei docenti abilitate
                </CheckField>
            </div>

            <div className="mt-2">
                <CheckField checked={cfg.diario_primaria_visibile ?? false} onChange={(v) => set({ diario_primaria_visibile: v })}>
                    Esponi il diario 0-6 ai docenti di primaria
                </CheckField>
                <p className="font-maven text-xs text-kidville-muted mt-1">Se disattivato, i docenti che hanno solo sezioni di primaria non vedono il diario 0-6 (con nanna/bagno/pasti): usano il Registro. Disattivo di default.</p>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>Il diario resta visibile ai gradi attivati in Funzioni &amp; moduli.</p>
        </section>
    );
}
