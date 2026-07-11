'use client';

import type { LucideIcon } from 'lucide-react';
import { Euro, CalendarClock, BellRing, Landmark, FileSpreadsheet, Ticket } from 'lucide-react';
import { Tabs } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

export type VistaContabilita = 'scadenzario' | 'genera' | 'solleciti' | 'riconciliazione' | 'fiscale' | 'ticket';

export const VISTE_CONTABILITA: { id: VistaContabilita; label: string; icon: LucideIcon }[] = [
    { id: 'scadenzario', label: 'Scadenzario', icon: Euro },
    { id: 'genera', label: 'Genera', icon: CalendarClock },
    { id: 'solleciti', label: 'Solleciti', icon: BellRing },
    { id: 'riconciliazione', label: 'Riconciliazione', icon: Landmark },
    { id: 'fiscale', label: 'Fiscale', icon: FileSpreadsheet },
    { id: 'ticket', label: 'Ticket mensa', icon: Ticket },
];

/**
 * Navigazione della Contabilità: pills scrollabili su mobile (pattern
 * /admin/impostazioni), Tabs cockpit da md in su. Il sync con `?vista=`
 * vive nella pagina, qui solo value/onChange.
 */
export function ContabilitaNav({ value, onChange }: { value: VistaContabilita; onChange: (v: VistaContabilita) => void }) {
    return (
        <>
            <div className="md:hidden -mx-4 mb-4 overflow-x-auto px-4">
                <div className="flex w-max gap-2">
                    {VISTE_CONTABILITA.map((v) => {
                        const Icon = v.icon;
                        const on = value === v.id;
                        return (
                            <button
                                key={v.id}
                                type="button"
                                onClick={() => onChange(v.id)}
                                className={cx(
                                    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border-2 px-3.5 py-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-[0.03em]',
                                    on ? 'border-kidville-green bg-kidville-green text-kidville-yellow' : 'border-kidville-line bg-kidville-white text-kidville-ink/70'
                                )}
                            >
                                <Icon size={14} strokeWidth={2.2} /> {v.label}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="hidden md:block">
                <Tabs
                    value={value}
                    onChange={(id) => onChange(id as VistaContabilita)}
                    options={VISTE_CONTABILITA.map(({ id, label, icon }) => ({ id, label, icon }))}
                />
            </div>
        </>
    );
}
