'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    Settings, CreditCard, GraduationCap, LayoutGrid, NotebookPen, CalendarCheck,
    StickyNote, Megaphone, MessageCircle, Images, Package, FileSignature,
    UtensilsCrossed, BookOpenCheck, BellRing,
} from 'lucide-react';
import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel';
import { DidatticaPrimariaPanel } from '@/components/features/admin/primaria/DidatticaPrimariaPanel';
import { FunzioniMatricePanel } from '@/components/features/admin/settings/FunzioniMatricePanel';
import { PagelleScrutinioPanel } from '@/components/features/admin/settings/PagelleScrutinioPanel';
import { MensaSettings } from '@/components/features/admin/settings/MensaSettings';
import { DiarioSettings } from '@/components/features/admin/settings/DiarioSettings';
import { PresenzeSettings } from '@/components/features/admin/settings/PresenzeSettings';
import { NoteSettings } from '@/components/features/admin/settings/NoteSettings';
import { AvvisiSettings } from '@/components/features/admin/settings/AvvisiSettings';
import { ChatSettings } from '@/components/features/admin/settings/ChatSettings';
import { GalleriaSettings } from '@/components/features/admin/settings/GalleriaSettings';
import { ArmadiettoSettings } from '@/components/features/admin/settings/ArmadiettoSettings';
import { ModulisticaSettings } from '@/components/features/admin/settings/ModulisticaSettings';
import { NotificheSettings } from '@/components/features/admin/settings/NotificheSettings';
import { PageHeader } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired } from '@/lib/context/sede-context';

type Sezione =
    | 'moduli'
    | 'pagamenti' | 'modulistica'
    | 'didattica' | 'pagelle' | 'diario' | 'presenze' | 'note'
    | 'mensa' | 'armadietto'
    | 'avvisi' | 'chat' | 'galleria' | 'notifiche';

interface Voce { id: Sezione; label: string; icon: React.ReactNode }
interface Gruppo { label: string; voci: Voce[] }

const GRUPPI: Gruppo[] = [
    {
        label: 'Generale',
        voci: [{ id: 'moduli', label: 'Funzioni & moduli', icon: <LayoutGrid size={15} /> }],
    },
    {
        label: 'Amministrazione',
        voci: [
            { id: 'pagamenti', label: 'Pagamenti & Fatturazione', icon: <CreditCard size={15} /> },
            { id: 'modulistica', label: 'Modulistica', icon: <FileSignature size={15} /> },
        ],
    },
    {
        label: 'Didattica',
        voci: [
            { id: 'didattica', label: 'Didattica primaria', icon: <GraduationCap size={15} /> },
            { id: 'pagelle', label: 'Pagelle & Scrutinio', icon: <BookOpenCheck size={15} /> },
            { id: 'diario', label: 'Diario', icon: <NotebookPen size={15} /> },
            { id: 'presenze', label: 'Presenze & Giustifiche', icon: <CalendarCheck size={15} /> },
            { id: 'note', label: 'Note disciplinari', icon: <StickyNote size={15} /> },
        ],
    },
    {
        label: 'Servizi',
        voci: [
            { id: 'mensa', label: 'Mensa', icon: <UtensilsCrossed size={15} /> },
            { id: 'armadietto', label: 'Armadietto', icon: <Package size={15} /> },
        ],
    },
    {
        label: 'Comunicazione',
        voci: [
            { id: 'avvisi', label: 'Avvisi', icon: <Megaphone size={15} /> },
            { id: 'chat', label: 'Chat', icon: <MessageCircle size={15} /> },
            { id: 'galleria', label: 'Galleria', icon: <Images size={15} /> },
            { id: 'notifiche', label: 'Notifiche', icon: <BellRing size={15} /> },
        ],
    },
];

const SEZIONI_VALIDE = new Set<string>(GRUPPI.flatMap((g) => g.voci.map((v) => v.id)));

function Inner() {
    const params = useSearchParams();
    const router = useRouter();
    const { userId } = useSessionIdentity();
    const fromUrl = params.get('sezione');
    const [sezione, setSezione] = useState<Sezione>(
        fromUrl && SEZIONI_VALIDE.has(fromUrl) ? (fromUrl as Sezione) : 'pagamenti'
    );

    const vai = (id: Sezione) => {
        setSezione(id);
        // Identità non risolta: si omette ?userId= (mai 'userId=null'), la sezione resta.
        router.replace(userId ? `?userId=${userId}&sezione=${id}` : `?sezione=${id}`, { scroll: false });
    };

    const voceAttiva = GRUPPI.flatMap((g) => g.voci).find((v) => v.id === sezione);

    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <PageHeader
                    eyebrow="Sistema"
                    icon={Settings}
                    title="Impostazioni"
                    subtitle="Configurazione completa della scuola: moduli, didattica, servizi e comunicazione."
                />

                {/* Nav mobile: pills scrollabili raggruppate */}
                <nav className="mb-6 md:hidden -mx-4 px-4 overflow-x-auto">
                    <div className="flex gap-2 w-max">
                        {GRUPPI.map((g, gi) => (
                            <div key={g.label} className={`flex gap-2 ${gi > 0 ? 'border-l border-kidville-line pl-2' : ''}`}>
                                {g.voci.map((v) => (
                                    <button
                                        key={v.id}
                                        onClick={() => vai(v.id)}
                                        aria-pressed={sezione === v.id}
                                        className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-2 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1 ${
                                            sezione === v.id
                                                ? 'bg-kidville-green text-kidville-yellow'
                                                : 'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50'
                                        }`}
                                    >
                                        {v.icon}
                                        {v.label}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </nav>

                <div className="flex gap-6 items-start">
                    {/* Sidebar desktop */}
                    <aside className="hidden md:block w-56 shrink-0 sticky top-6 bg-kidville-white rounded-2xl shadow-sm p-4">
                        {GRUPPI.map((g) => (
                            <div key={g.label} className="mb-4 last:mb-0">
                                <p className="font-barlow font-bold text-[11px] text-kidville-muted uppercase tracking-wider mb-1 px-2">
                                    {g.label}
                                </p>
                                <div className="space-y-0.5">
                                    {g.voci.map((v) => (
                                        <button
                                            key={v.id}
                                            onClick={() => vai(v.id)}
                                            aria-pressed={sezione === v.id}
                                            className={`font-maven w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1 ${
                                                sezione === v.id
                                                    ? 'bg-kidville-green text-kidville-yellow font-bold'
                                                    : 'text-kidville-ink/70 hover:bg-kidville-green-soft hover:text-kidville-green'
                                            }`}
                                        >
                                            {v.icon}
                                            {v.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </aside>

                    {/* Contenuto */}
                    <main className="flex-1 min-w-0">
                        <h2 className="md:hidden font-barlow font-black text-lg text-kidville-green uppercase tracking-wide mb-3 flex items-center gap-2">
                            {voceAttiva?.icon} {voceAttiva?.label}
                        </h2>
                        {userId && sezione === 'moduli' && <FunzioniMatricePanel userId={userId} />}
                        {userId && sezione === 'pagamenti' && <SedeRequired cosa="pagamenti & fatturazione">{(sid) => <SettingsPanel userId={userId} scuolaId={sid} />}</SedeRequired>}
                        {userId && sezione === 'modulistica' && <ModulisticaSettings userId={userId} />}
                        {userId && sezione === 'didattica' && <SedeRequired cosa="la didattica primaria">{(sid) => <DidatticaPrimariaPanel scuolaId={sid} userId={userId} />}</SedeRequired>}
                        {userId && sezione === 'pagelle' && <SedeRequired cosa="pagelle & scrutinio">{(sid) => <PagelleScrutinioPanel scuolaId={sid} userId={userId} />}</SedeRequired>}
                        {userId && sezione === 'diario' && <DiarioSettings userId={userId} />}
                        {userId && sezione === 'presenze' && <PresenzeSettings userId={userId} />}
                        {userId && sezione === 'note' && <NoteSettings userId={userId} />}
                        {userId && sezione === 'mensa' && <SedeRequired cosa="la mensa">{(sid) => <MensaSettings userId={userId} scuolaId={sid} />}</SedeRequired>}
                        {userId && sezione === 'armadietto' && <ArmadiettoSettings userId={userId} />}
                        {userId && sezione === 'avvisi' && <AvvisiSettings userId={userId} />}
                        {userId && sezione === 'chat' && <ChatSettings userId={userId} />}
                        {userId && sezione === 'galleria' && <GalleriaSettings userId={userId} />}
                        {userId && sezione === 'notifiche' && <NotificheSettings userId={userId} />}
                    </main>
                </div>
            </div>
        </div>
    );
}

export default function AdminImpostazioniPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>

            <Inner />
        </Suspense>
    );
}
