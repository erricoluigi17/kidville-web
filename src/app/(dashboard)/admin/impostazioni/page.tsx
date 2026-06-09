'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    Settings, CreditCard, GraduationCap, LayoutGrid, NotebookPen, CalendarCheck,
    StickyNote, Megaphone, MessageCircle, Images, Package, FileSignature,
    UtensilsCrossed, BookOpenCheck,
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

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

type Sezione =
    | 'moduli'
    | 'pagamenti' | 'modulistica'
    | 'didattica' | 'pagelle' | 'diario' | 'presenze' | 'note'
    | 'mensa' | 'armadietto'
    | 'avvisi' | 'chat' | 'galleria';

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
        ],
    },
];

const SEZIONI_VALIDE = new Set<string>(GRUPPI.flatMap((g) => g.voci.map((v) => v.id)));

function Inner() {
    const params = useSearchParams();
    const router = useRouter();
    const userId = params.get('userId') || DEV_ADMIN;
    const fromUrl = params.get('sezione');
    const [sezione, setSezione] = useState<Sezione>(
        fromUrl && SEZIONI_VALIDE.has(fromUrl) ? (fromUrl as Sezione) : 'pagamenti'
    );

    const vai = (id: Sezione) => {
        setSezione(id);
        router.replace(`?userId=${userId}&sezione=${id}`, { scroll: false });
    };

    const voceAttiva = GRUPPI.flatMap((g) => g.voci).find((v) => v.id === sezione);

    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-6">
                    <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                        <Settings size={24} /> Impostazioni
                    </h1>
                    <p className="font-maven text-sm text-gray-500">
                        Configurazione completa della scuola: moduli, didattica, servizi e comunicazione.
                    </p>
                </header>

                {/* Nav mobile: pills scrollabili raggruppate */}
                <nav className="mb-6 md:hidden -mx-4 px-4 overflow-x-auto">
                    <div className="flex gap-2 w-max">
                        {GRUPPI.map((g, gi) => (
                            <div key={g.label} className={`flex gap-2 ${gi > 0 ? 'border-l border-gray-200 pl-2' : ''}`}>
                                {g.voci.map((v) => (
                                    <button
                                        key={v.id}
                                        onClick={() => vai(v.id)}
                                        className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-2 text-sm whitespace-nowrap transition ${
                                            sezione === v.id ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-gray-600'
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
                    <aside className="hidden md:block w-56 shrink-0 sticky top-6 bg-white rounded-2xl shadow-sm p-4">
                        {GRUPPI.map((g) => (
                            <div key={g.label} className="mb-4 last:mb-0">
                                <p className="font-barlow font-bold text-[11px] text-gray-400 uppercase tracking-wider mb-1 px-2">
                                    {g.label}
                                </p>
                                <div className="space-y-0.5">
                                    {g.voci.map((v) => (
                                        <button
                                            key={v.id}
                                            onClick={() => vai(v.id)}
                                            className={`font-maven w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-left transition ${
                                                sezione === v.id
                                                    ? 'bg-kidville-green text-kidville-yellow font-bold'
                                                    : 'text-gray-600 hover:bg-kidville-green/10'
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
                        {sezione === 'moduli' && <FunzioniMatricePanel userId={userId} />}
                        {sezione === 'pagamenti' && <SettingsPanel userId={userId} scuolaId={SCUOLA_ID} />}
                        {sezione === 'modulistica' && <ModulisticaSettings userId={userId} />}
                        {sezione === 'didattica' && <DidatticaPrimariaPanel scuolaId={SCUOLA_ID} userId={userId} />}
                        {sezione === 'pagelle' && <PagelleScrutinioPanel scuolaId={SCUOLA_ID} userId={userId} />}
                        {sezione === 'diario' && <DiarioSettings userId={userId} />}
                        {sezione === 'presenze' && <PresenzeSettings userId={userId} />}
                        {sezione === 'note' && <NoteSettings userId={userId} />}
                        {sezione === 'mensa' && <MensaSettings userId={userId} scuolaId={SCUOLA_ID} />}
                        {sezione === 'armadietto' && <ArmadiettoSettings userId={userId} />}
                        {sezione === 'avvisi' && <AvvisiSettings userId={userId} />}
                        {sezione === 'chat' && <ChatSettings userId={userId} />}
                        {sezione === 'galleria' && <GalleriaSettings userId={userId} />}
                    </main>
                </div>
            </div>
        </div>
    );
}

export default function AdminImpostazioniPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
            <Inner />
        </Suspense>
    );
}
