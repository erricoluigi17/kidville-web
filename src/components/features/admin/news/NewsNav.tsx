'use client';

import type { LucideIcon } from 'lucide-react';
import { Newspaper, PenSquare, Inbox, Tag, Mail } from 'lucide-react';
import { Tabs } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

export type VistaNews = 'elenco' | 'editor' | 'proposte' | 'categorie' | 'digest';

export const VISTE_NEWS: { id: VistaNews; label: string; icon: LucideIcon }[] = [
    { id: 'elenco', label: 'Elenco', icon: Newspaper },
    { id: 'editor', label: 'Editor', icon: PenSquare },
    { id: 'proposte', label: 'Proposte', icon: Inbox },
    { id: 'categorie', label: 'Categorie', icon: Tag },
    { id: 'digest', label: 'Digest', icon: Mail },
];

/**
 * Navigazione della sezione News: pills scrollabili su mobile (pattern
 * /admin/pagamenti → ContabilitaNav), Tabs cockpit da md in su. Il sync con
 * `?vista=` vive nella pagina, qui solo value/onChange.
 */
export function NewsNav({ value, onChange }: { value: VistaNews; onChange: (v: VistaNews) => void }) {
    return (
        <>
            <div className="md:hidden mb-4 min-w-0 overflow-x-auto">
                <div className="flex w-max gap-2">
                    {VISTE_NEWS.map((v) => {
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
                    onChange={(id) => onChange(id as VistaNews)}
                    options={VISTE_NEWS.map(({ id, label, icon }) => ({ id, label, icon }))}
                />
            </div>
        </>
    );
}
