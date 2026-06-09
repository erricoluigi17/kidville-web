'use client';

import { Save } from 'lucide-react';
import { input, label, btnPrimary, checkbox, checkboxLabel, checkboxRow } from './ui';

// Campi form condivisi tra i pannelli modulo delle Impostazioni.

export function CheckField({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
    return (
        <label className={checkboxRow}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={checkbox} />
            <span className={checkboxLabel}>{children}</span>
        </label>
    );
}

export function TimeField({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
    return (
        <div>
            <label className={label}>{children}</label>
            <input type="time" value={value} onChange={(e) => onChange(e.target.value)} className={`${input} w-full`} />
        </div>
    );
}

export function NumberField({ value, onChange, min, max, children }: { value: number; onChange: (v: number) => void; min?: number; max?: number; children: React.ReactNode }) {
    return (
        <div>
            <label className={label}>{children}</label>
            <input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} className={`${input} w-full`} />
        </div>
    );
}

export function TextField({ value, onChange, placeholder, children }: { value: string; onChange: (v: string) => void; placeholder?: string; children: React.ReactNode }) {
    return (
        <div>
            <label className={label}>{children}</label>
            <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${input} w-full`} />
        </div>
    );
}

// Selettore multiplo a pill (es. ruoli, giorni, routine).
export function PillMultiSelect({ options, selected, onChange }: { options: { id: string; label: string }[]; selected: string[]; onChange: (next: string[]) => void }) {
    const toggle = (id: string) =>
        onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    return (
        <div className="flex flex-wrap gap-2">
            {options.map((o) => (
                <button
                    key={o.id}
                    type="button"
                    onClick={() => toggle(o.id)}
                    className={`font-maven rounded-full px-3 py-1.5 text-sm transition ${
                        selected.includes(o.id) ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500 hover:bg-kidville-green/10'
                    }`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function SaveRow({ onSave, saving, msg, error }: { onSave: () => void; saving: boolean; msg: string; error: string | null }) {
    return (
        <div className="mt-4 flex items-center gap-3">
            <button onClick={onSave} disabled={saving} className={btnPrimary}>
                <Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}
            </button>
            {msg && <span className="font-maven text-sm text-kidville-success">{msg}</span>}
            {error && <span className="font-maven text-sm text-kidville-error">{error}</span>}
        </div>
    );
}

export function ComingSoonBadge() {
    return <span className="ml-1 text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full align-middle">in arrivo</span>;
}
