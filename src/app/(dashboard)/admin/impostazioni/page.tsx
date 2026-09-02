'use client';

import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    Settings, CreditCard, GraduationCap, LayoutGrid, NotebookPen, CalendarCheck,
    StickyNote, Megaphone, MessageCircle, Images, Package, FileSignature,
    UtensilsCrossed, BookOpenCheck, BellRing, Percent, Building2, KeyRound,
} from 'lucide-react';
import { CambiaPasswordCard } from '@/components/features/account/CambiaPasswordCard';
import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel';
import { RetteSettings } from '@/components/features/admin/settings/RetteSettings';
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
import { AnagraficaSedeSettings } from '@/components/features/admin/settings/AnagraficaSedeSettings';
import { SedeCorrente } from '@/components/features/admin/settings/SedeCorrente';
import { PageHeader } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired } from '@/lib/context/sede-context';

type Sezione =
    | 'moduli' | 'sede' | 'account'
    | 'pagamenti' | 'rette' | 'modulistica'
    | 'didattica' | 'pagelle' | 'diario' | 'presenze' | 'note'
    | 'mensa' | 'armadietto'
    | 'avvisi' | 'chat' | 'galleria' | 'notifiche';

// `labelKey`/`gruppoKey` sono chiavi i18n del namespace adminSettings, tradotte
// al render (l'ordine e le icone restano dati, non testo utente).
interface Voce { id: Sezione; labelKey: string; icon: React.ReactNode }
interface Gruppo { gruppoKey: string; voci: Voce[] }

const GRUPPI: Gruppo[] = [
    {
        gruppoKey: 'gruppoGenerale',
        voci: [
            { id: 'moduli', labelKey: 'voceFunzioniModuli', icon: <LayoutGrid size={15} /> },
            // Prima voce nata da un messaggio d'errore: i prestampati rimandavano
            // «nelle impostazioni della sede» a una schermata che non esisteva.
            { id: 'sede', labelKey: 'voceSede', icon: <Building2 size={15} /> },
            // ⚠️ L'UNICA VOCE DI QUESTA PAGINA CHE NON CONFIGURA UNA SEDE: configura
            // CHI STA GUARDANDO. Sta qui e non in una schermata sua perché è dove la
            // segreteria cerca le proprie preferenze, e perché una pagina in più per
            // un form solo sarebbe una voce in più da trovare nel menu.
            { id: 'account', labelKey: 'voceAccount', icon: <KeyRound size={15} /> },
        ],
    },
    {
        gruppoKey: 'gruppoAmministrazione',
        voci: [
            { id: 'pagamenti', labelKey: 'vocePagamenti', icon: <CreditCard size={15} /> },
            { id: 'rette', labelKey: 'voceRette', icon: <Percent size={15} /> },
            { id: 'modulistica', labelKey: 'voceModulistica', icon: <FileSignature size={15} /> },
        ],
    },
    {
        gruppoKey: 'gruppoDidattica',
        voci: [
            { id: 'didattica', labelKey: 'voceDidattica', icon: <GraduationCap size={15} /> },
            { id: 'pagelle', labelKey: 'vocePagelle', icon: <BookOpenCheck size={15} /> },
            { id: 'diario', labelKey: 'voceDiario', icon: <NotebookPen size={15} /> },
            { id: 'presenze', labelKey: 'vocePresenze', icon: <CalendarCheck size={15} /> },
            { id: 'note', labelKey: 'voceNote', icon: <StickyNote size={15} /> },
        ],
    },
    {
        gruppoKey: 'gruppoServizi',
        voci: [
            { id: 'mensa', labelKey: 'voceMensa', icon: <UtensilsCrossed size={15} /> },
            { id: 'armadietto', labelKey: 'voceArmadietto', icon: <Package size={15} /> },
        ],
    },
    {
        gruppoKey: 'gruppoComunicazione',
        voci: [
            { id: 'avvisi', labelKey: 'voceAvvisi', icon: <Megaphone size={15} /> },
            { id: 'chat', labelKey: 'voceChat', icon: <MessageCircle size={15} /> },
            { id: 'galleria', labelKey: 'voceGalleria', icon: <Images size={15} /> },
            { id: 'notifiche', labelKey: 'voceNotifiche', icon: <BellRing size={15} /> },
        ],
    },
];

const SEZIONI_VALIDE = new Set<string>(GRUPPI.flatMap((g) => g.voci.map((v) => v.id)));

function Inner() {
    const t = useTranslations('adminSettings');
    // Il cambio password ha un namespace suo, condiviso con le altre tre superfici
    // che montano lo stesso form: qui non se ne ricopia nemmeno una frase.
    const tPwd = useTranslations('password');
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

    /**
     * OGNI sezione di questa pagina configura UNA sede: `admin_settings`,
     * `payment_categories`, le materie e i periodi di scrutinio hanno tutti una
     * riga per plesso. Dieci sezioni su quindici però chiedevano la
     * configurazione con il solo `userId`, lasciando indovinare la sede al
     * server: con un plesso l'indovinello aveva sempre ragione, con tre scriveva
     * (o falliva) sul plesso sbagliato in silenzio.
     *
     * Qui la sede diventa un prerequisito esplicito: se il selettore non ne
     * indica UNA sola, non parte nessuna fetch e si chiede di sceglierla; se la
     * indica, il suo NOME è la prima cosa scritta sopra il pannello.
     *
     * `key={sid}` non è un dettaglio di rendering: ogni pannello tiene una BOZZA
     * locale delle modifiche non ancora salvate (`draft`), che ha la precedenza
     * sui valori arrivati dal server. Senza il rimontaggio, cambiare sede
     * lascerebbe in pagina le spunte di Giugliano sotto l'intestazione «Stai
     * configurando: Aversa» — e il salvataggio successivo le scriverebbe davvero
     * su Aversa. La sede cambia ⇒ il pannello riparte da zero.
     */
    const conSede = (cosa: string, pannello: (scuolaId: string) => React.ReactNode) => (
        <SedeRequired cosa={cosa}>
            {(sid) => (
                <div key={sid}>
                    <SedeCorrente scuolaId={sid} />
                    {pannello(sid)}
                </div>
            )}
        </SedeRequired>
    );

    return (
        <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                <PageHeader
                    eyebrow={t('sistemaEyebrow')}
                    icon={Settings}
                    title={t('impostazioniTitolo')}
                    subtitle={t('impostazioniSottotitolo')}
                />

                {/* Nav mobile: pills scrollabili raggruppate */}
                <nav className="mb-6 md:hidden -mx-4 px-4 overflow-x-auto">
                    <div className="flex gap-2 w-max">
                        {GRUPPI.map((g, gi) => (
                            <div key={g.gruppoKey} className={`flex gap-2 ${gi > 0 ? 'border-l border-kidville-line pl-2' : ''}`}>
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
                                        {t(v.labelKey)}
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
                            <div key={g.gruppoKey} className="mb-4 last:mb-0">
                                <p className="font-barlow font-bold text-[11px] text-kidville-muted uppercase tracking-wider mb-1 px-2">
                                    {t(g.gruppoKey)}
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
                                            {t(v.labelKey)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </aside>

                    {/* Contenuto */}
                    <main className="flex-1 min-w-0">
                        <h2 className="md:hidden font-barlow font-black text-lg text-kidville-green uppercase tracking-wide mb-3 flex items-center gap-2">
                            {voceAttiva?.icon} {voceAttiva ? t(voceAttiva.labelKey) : null}
                        </h2>
                        {userId && sezione === 'moduli' && conSede(t('sedeRequiredModuli'), (sid) => <FunzioniMatricePanel userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'sede' && conSede(t('sedeRequiredSede'), (sid) => <AnagraficaSedeSettings userId={userId} scuolaId={sid} />)}
                        {/* ⚠️ SENZA `conSede`, ED È L'UNICA. La password non è un
                            affare di plesso: la chiave è `auth.users.id`, e la route
                            che la scrive (`POST /api/account/password`) è una sola per
                            genitori e personale. Passare di qui da `SedeRequired`
                            avrebbe messo un muro inventato davanti a chi le sedi le ha
                            tutte e tre — cioè proprio a `test.multisede.admin` e a chi
                            in Direzione lavora su Giugliano, Aversa e Cesa insieme:
                            «scegli una sede» prima di poter cambiare la PROPRIA
                            password è una domanda senza risposta giusta. */}
                        {/* La CARTA BIANCA non è cornice: è la superficie su cui i
                            contrasti di questo form sono stati misurati. Il fondo
                            della pagina è `bg-kidville-cream/40`, e lì il contorno
                            delle tacche della barra di forza (token `neutral`)
                            scenderebbe da 3,10:1 a 2,79:1 — sotto la soglia di WCAG
                            1.4.11, cioè con gli alloggiamenti che sbiadiscono.
                            Le misure stanno in
                            `__tests__/a11y/contrasto-barra-forza-password.test.ts`. */}
                        {sezione === 'account' && (
                            <section className="max-w-md rounded-2xl bg-kidville-white p-5 shadow-sm">
                                <h2 className="mb-1 font-barlow text-sm font-extrabold uppercase text-kidville-green">
                                    {tPwd('sezioneTitolo')}
                                </h2>
                                <p className="mb-4 font-maven text-[13px] leading-relaxed text-kidville-sub">
                                    {tPwd('sezioneDescrizione')}
                                </p>
                                <CambiaPasswordCard origine="self-service" />
                            </section>
                        )}
                        {userId && sezione === 'pagamenti' && conSede(t('sedeRequiredPagamenti'), (sid) => <SettingsPanel userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'rette' && conSede(t('sedeRequiredRette'), (sid) => <RetteSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'modulistica' && conSede(t('sedeRequiredModulistica'), (sid) => <ModulisticaSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'didattica' && conSede(t('sedeRequiredDidattica'), (sid) => <DidatticaPrimariaPanel scuolaId={sid} userId={userId} />)}
                        {userId && sezione === 'pagelle' && conSede(t('sedeRequiredPagelle'), (sid) => <PagelleScrutinioPanel scuolaId={sid} userId={userId} />)}
                        {userId && sezione === 'diario' && conSede(t('sedeRequiredDiario'), (sid) => <DiarioSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'presenze' && conSede(t('sedeRequiredPresenze'), (sid) => <PresenzeSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'note' && conSede(t('sedeRequiredNote'), (sid) => <NoteSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'mensa' && conSede(t('sedeRequiredMensa'), (sid) => <MensaSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'armadietto' && conSede(t('sedeRequiredArmadietto'), (sid) => <ArmadiettoSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'avvisi' && conSede(t('sedeRequiredAvvisi'), (sid) => <AvvisiSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'chat' && conSede(t('sedeRequiredChat'), (sid) => <ChatSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'galleria' && conSede(t('sedeRequiredGalleria'), (sid) => <GalleriaSettings userId={userId} scuolaId={sid} />)}
                        {userId && sezione === 'notifiche' && conSede(t('sedeRequiredNotifiche'), (sid) => <NotificheSettings userId={userId} scuolaId={sid} />)}
                    </main>
                </div>
            </div>
        </div>
    );
}

function ImpostazioniFallback() {
    const t = useTranslations('adminSettings');
    return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function AdminImpostazioniPage() {
    return (
        <Suspense fallback={<ImpostazioniFallback />}>
            <Inner />
        </Suspense>
    );
}
