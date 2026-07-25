'use client';

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { CalendarClock, Euro, Layers, Settings, UtensilsCrossed } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { ContabilitaNav, VISTE_CONTABILITA, type VistaContabilita } from '@/components/features/admin/pagamenti/ContabilitaNav';
import { CockpitPage, PageHeader, SectionTitle } from '@/components/ui/cockpit';
import { Card } from '@/components/ui/Card';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired } from '@/lib/context/sede-context';

// Le viste secondarie si caricano on-demand: la pagina apre sempre sullo
// scadenzario e non paga il bundle dei generatori/ticket finché non servono.
function Caricamento() {
    const t = useTranslations('adminContabilita');
    return <p className="py-8 text-center font-maven text-sm text-kidville-muted">{t('pagPageCaricamento')}</p>;
}
const GeneratoreRette = dynamic(() => import('@/components/features/admin/pagamenti/GeneratoreRette').then((m) => m.GeneratoreRette), { loading: Caricamento });
const GeneratoreCategoria = dynamic(() => import('@/components/features/admin/pagamenti/GeneratoreCategoria').then((m) => m.GeneratoreCategoria), { loading: Caricamento });
const TicketMensaPanel = dynamic(() => import('@/components/features/admin/pagamenti/TicketMensaPanel').then((m) => m.TicketMensaPanel), { loading: Caricamento });
const FiscalePanel = dynamic(() => import('@/components/features/admin/pagamenti/FiscalePanel').then((m) => m.FiscalePanel), { loading: Caricamento });
const SollecitiPanel = dynamic(() => import('@/components/features/admin/pagamenti/SollecitiPanel').then((m) => m.SollecitiPanel), { loading: Caricamento });
const RiconciliazionePanel = dynamic(() => import('@/components/features/admin/pagamenti/RiconciliazionePanel').then((m) => m.RiconciliazionePanel), { loading: Caricamento });
const TransazioniPanel = dynamic(() => import('@/components/features/admin/pagamenti/TransazioniPanel').then((m) => m.TransazioniPanel), { loading: Caricamento });
const CausaliPanel = dynamic(() => import('@/components/features/admin/pagamenti/CausaliPanel').then((m) => m.CausaliPanel), { ssr: false, loading: Caricamento });
const CassaPanel = dynamic(() => import('@/components/features/admin/pagamenti/CassaPanel').then((m) => m.CassaPanel), { ssr: false, loading: Caricamento });
type PrecompilaTransazione = import('@/components/features/admin/pagamenti/TransazioniPanel').PrecompilaTransazione;

const isVista = (v: string | null): v is VistaContabilita => !!v && VISTE_CONTABILITA.some((o) => o.id === v);

function PagamentiInner() {
    const t = useTranslations('adminContabilita');
    const { userId } = useSessionIdentity();
    const router = useRouter();
    const params = useSearchParams();
    const fromUrl = params.get('vista');
    const [vista, setVista] = useState<VistaContabilita>(isVista(fromUrl) ? fromUrl : 'scadenzario');
    // Precompilazione del wizard «Incasso unico» quando lo si apre da un bonifico
    // multi-CF della Riconciliazione. Transitoria: la nav manuale (ContabilitaNav)
    // la azzera, così una tornata successiva sulla vista riparte da wizard pulito.
    const [precompilaTx, setPrecompilaTx] = useState<PrecompilaTransazione | null>(null);

    // Identità di sessione (M4): con identità non risolta il parametro viene
    // omesso (href invariato), mai `userId=null`.
    const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);
    const cambiaVista = (id: VistaContabilita) => {
        setVista(id);
        setPrecompilaTx(null);
        router.replace(userId ? `?userId=${userId}&vista=${id}` : `?vista=${id}`, { scroll: false });
    };

    // Aggancio «Incasso unico»: dalla Riconciliazione apre il wizard precompilato.
    // Non passa da `cambiaVista` (che azzererebbe la precompilazione appena impostata).
    const apriIncassoUnico = useCallback((pre: PrecompilaTransazione) => {
        setPrecompilaTx(pre);
        setVista('transazioni');
        router.replace(userId ? `?userId=${userId}&vista=transazioni` : `?vista=transazioni`, { scroll: false });
    }, [router, userId]);

    const linkCls = 'inline-flex h-[40px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green';

    return (
        <CockpitPage max={1152}>
            <PageHeader
                icon={Euro}
                eyebrow={t('pagPageEyebrow')}
                title={t('pagPageTitolo')}
                subtitle={t('pagPageSottotitolo')}
                actions={
                    <>
                        <Link href={withUser('/admin/mensa')} className={linkCls}><UtensilsCrossed size={15} /> {t('pagPageMensaCucina')}</Link>
                        <Link href={withUser('/admin/impostazioni')} className={linkCls}><Settings size={15} /> {t('pagPageImpostazioni')}</Link>
                    </>
                }
            />

            <ContabilitaNav value={vista} onChange={cambiaVista} />

            <SedeRequired cosa={t('pagPageCosaContabilita')}>
                {(scuolaId) => (
                    <Card className="p-4 md:p-6">
                        {vista === 'scadenzario' && userId && <PaymentsDashboard userId={userId} scuolaId={scuolaId} />}

                        {vista === 'transazioni' && userId && <TransazioniPanel userId={userId} scuolaId={scuolaId} precompila={precompilaTx} />}

                        {vista === 'genera' && userId && (
                            <div className="space-y-8">
                                <div>
                                    <SectionTitle icon={CalendarClock} title={t('pagPageRetteMensili')} sub={t('pagPageRetteMensiliSub')} />
                                    <GeneratoreRette userId={userId} scuolaId={scuolaId} />
                                </div>
                                <div>
                                    <SectionTitle icon={Layers} title={t('pagPageAddebitiCategoria')} sub={t('pagPageAddebitiCategoriaSub')} />
                                    <GeneratoreCategoria userId={userId} scuolaId={scuolaId} />
                                </div>
                            </div>
                        )}

                        {vista === 'solleciti' && userId && <SollecitiPanel userId={userId} scuolaId={scuolaId} />}
                        {vista === 'riconciliazione' && userId && <RiconciliazionePanel userId={userId} scuolaId={scuolaId} onIncassoUnico={apriIncassoUnico} />}
                        {vista === 'fiscale' && userId && <FiscalePanel userId={userId} scuolaId={scuolaId} />}

                        {vista === 'ticket' && userId && <TicketMensaPanel userId={userId} scuolaId={scuolaId} />}

                        {vista === 'cassa' && userId && <CassaPanel userId={userId} scuolaId={scuolaId} />}

                        {vista === 'causali' && userId && <CausaliPanel userId={userId} scuolaId={scuolaId} />}
                    </Card>
                )}
            </SedeRequired>
        </CockpitPage>
    );
}

export default function AdminPagamentiPage() {
    const t = useTranslations('adminContabilita');
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('pagPageCaricamento')}</div>}>
            <PagamentiInner />
        </Suspense>
    );
}
