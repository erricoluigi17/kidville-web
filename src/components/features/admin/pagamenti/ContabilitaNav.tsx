'use client';

import type { LucideIcon } from 'lucide-react';
import { Euro, Coins, CalendarClock, BellRing, Landmark, FileSpreadsheet, Ticket, Wallet, Pencil } from 'lucide-react';
import { Tabs } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

export type VistaContabilita = 'scadenzario' | 'transazioni' | 'genera' | 'solleciti' | 'riconciliazione' | 'fiscale' | 'ticket' | 'cassa' | 'causali';

export const VISTE_CONTABILITA: { id: VistaContabilita; label: string; icon: LucideIcon }[] = [
    { id: 'scadenzario', label: 'Scadenzario', icon: Euro },
    { id: 'transazioni', label: 'Incasso unico', icon: Coins },
    { id: 'genera', label: 'Genera', icon: CalendarClock },
    { id: 'solleciti', label: 'Solleciti', icon: BellRing },
    { id: 'riconciliazione', label: 'Riconciliazione', icon: Landmark },
    { id: 'fiscale', label: 'Fiscale', icon: FileSpreadsheet },
    { id: 'ticket', label: 'Ticket mensa', icon: Ticket },
    { id: 'cassa', label: 'Cassa', icon: Wallet },
    { id: 'causali', label: 'Causali', icon: Pencil },
];

/**
 * Navigazione della Contabilità: pills scrollabili su mobile (pattern
 * /admin/impostazioni), Tabs cockpit da md in su. Il sync con `?vista=`
 * vive nella pagina, qui solo value/onChange.
 */
export function ContabilitaNav({ value, onChange }: { value: VistaContabilita; onChange: (v: VistaContabilita) => void }) {
    return (
        <>
            <div className="md:hidden mb-4 min-w-0 overflow-x-auto">
                <div className="flex w-max gap-2">
                    {VISTE_CONTABILITA.map((v) => {
                        const Icon = v.icon;
                        const on = value === v.id;
                        return (
                            <button
                                key={v.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => onChange(v.id)}
                                className={cx(
                                    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 py-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-[0.03em] transition-colors',
                                    'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
                                    on
                                        ? 'bg-kidville-green text-kidville-white'
                                        : 'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50'
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
