'use client';

import { Fragment, Suspense, useCallback, useState } from 'react';
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
import { SedeNotice, SedeRequired, useSediAttive } from '@/lib/context/sede-context';

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
// Stesso modulo del pannello qui sopra (un solo chunk): l'editor è uno, le istanze due.
const CausaliFatturaPanel = dynamic(() => import('@/components/features/admin/pagamenti/CausaliPanel').then((m) => m.CausaliFatturaPanel), { ssr: false, loading: Caricamento });
const CassaPanel = dynamic(() => import('@/components/features/admin/pagamenti/CassaPanel').then((m) => m.CassaPanel), { ssr: false, loading: Caricamento });
type PrecompilaTransazione = import('@/components/features/admin/pagamenti/TransazioniPanel').PrecompilaTransazione;

const isVista = (v: string | null): v is VistaContabilita => !!v && VISTE_CONTABILITA.some((o) => o.id === v);

/**
 * Guard delle viste che lavorano su PIÙ sedi insieme (scadenzario, incasso unico,
 * solleciti, riconciliazione, fiscale, ticket, cassa).
 *
 * Fino al 2026-09-26 tutta la contabilità stava dentro `SedeRequired`: con due o
 * tre plessi attivi — il caso normale della Direzione — ogni vista si fermava su
 * «Seleziona una sede». Qui invece i figli ricevono:
 *  - la sede, quando quella effettiva è UNA;
 *  - `null`, quando sono più d'una: il pannello omette `scuola_id` e il server
 *    scopa sulle sedi del cookie (`resolveScuoleAttive`), ri-validate lato server.
 *
 * I pannelli NON si montano solo in due casi, che non sono «più sedi»:
 *  - l'elenco delle sedi NON è arrivato (`errore`): lo scope è ignoto, e
 *    `SedeNotice` dice il guasto e offre «Riprova»;
 *  - nessuna sede accessibile (elenco arrivato ma vuoto): un avviso dedicato
 *    («Nessuna sede associata al tuo account»), non `SedeNotice`, che chiederebbe
 *    di sceglierne una da un menu che con zero sedi non esiste.
 *
 * Finché le sedi non sono caricate non si monta nessun pannello: altrimenti
 * partirebbe una fetch con `null` e, un attimo dopo, una seconda con la sede vera.
 *
 * La `key` su `reFetchKey` rimonta i pannelli quando cambia l'INSIEME delle sedi
 * anche se `scuolaId` resta `null` (da tre sedi a due): lo fa già
 * `SedeScopeBoundary` nel layout, ma la pagina non deve dipendere da dove viene
 * montata per non mostrare i dati dello scope precedente.
 */
function ContabilitaMultiSede({ children }: { children: (scuolaId: string | null) => React.ReactNode }) {
    const { effettive, sedeCorrente, reFetchKey, loading, errore } = useSediAttive();
    const tShared = useTranslations('shared');
    const t = useTranslations('adminContabilita');
    if (loading) {
        // `sub` e non `muted`: il debito di `text-kidville-muted` si smaltisce e non si
        // rifinanzia (lock `__tests__/a11y/testo-muted-allowlist.test.ts`).
        return <div className="p-8 font-maven text-kidville-sub">{tShared('caricamentoPuntini')}</div>;
    }
    if (errore) {
        // Senza `cosa`: il ramo d'errore di `SedeNotice` dice il guasto e offre
        // «Riprova», non chiede mai di scegliere una sede (qui non accade più).
        return <SedeNotice />;
    }
    if (effettive.length === 0) {
        // Elenco arrivato ma vuoto: NON `SedeNotice`, che con zero sedi direbbe «Hai più
        // sedi attive. Scegline una sola dal menu in alto» — frase falsa e istruzione
        // impossibile, perché quel menu con zero sedi non si monta nemmeno.
        return (
            <div role="status" className="rounded-2xl border border-kidville-line bg-kidville-white p-8 text-center">
                <p className="font-maven text-[14px] text-kidville-sub">{t('pagPageNessunaSede')}</p>
            </div>
        );
    }
    return <Fragment key={reFetchKey}>{children(sedeCorrente)}</Fragment>;
}

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

            {/* Genera e Causali SCRIVONO la configurazione di UNA sede (rette, addebiti,
                testi delle causali): con più sedi attive chiedono di sceglierne una. */}
            {vista === 'genera' && (
                <SedeRequired cosa={t('pagPageCosaGenera')}>
                    {(scuolaId) => (
                        <Card key={scuolaId} className="p-4 md:p-6">
                            {userId && (
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
                        </Card>
                    )}
                </SedeRequired>
            )}

            {/* Due editor, uno per documento: la causale del bonifico la ricopia
                il genitore, quella della fattura finisce nell'XML per lo SDI. */}
            {vista === 'causali' && (
                <SedeRequired cosa={t('pagPageCosaCausali')}>
                    {(scuolaId) => (
                        <Card key={scuolaId} className="p-4 md:p-6">
                            {userId && (
                                <div className="space-y-8">
                                    <CausaliPanel userId={userId} scuolaId={scuolaId} />
                                    <CausaliFatturaPanel userId={userId} scuolaId={scuolaId} />
                                </div>
                            )}
                        </Card>
                    )}
                </SedeRequired>
            )}

            {vista !== 'genera' && vista !== 'causali' && (
                <ContabilitaMultiSede>
                    {(scuolaId) => (
                        <Card className="p-4 md:p-6">
                            {vista === 'scadenzario' && userId && <PaymentsDashboard userId={userId} scuolaId={scuolaId} />}

                            {vista === 'transazioni' && userId && <TransazioniPanel userId={userId} scuolaId={scuolaId} precompila={precompilaTx} />}

                            {vista === 'solleciti' && userId && <SollecitiPanel userId={userId} scuolaId={scuolaId} />}
                            {vista === 'riconciliazione' && userId && <RiconciliazionePanel userId={userId} scuolaId={scuolaId} onIncassoUnico={apriIncassoUnico} />}
                            {vista === 'fiscale' && userId && <FiscalePanel userId={userId} scuolaId={scuolaId} />}

                            {vista === 'ticket' && userId && <TicketMensaPanel userId={userId} scuolaId={scuolaId} />}

                            {vista === 'cassa' && userId && <CassaPanel userId={userId} scuolaId={scuolaId} />}
                        </Card>
                    )}
                </ContabilitaMultiSede>
            )}
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
