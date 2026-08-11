'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel';
import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel';
import { StaffDetailPanel } from '@/components/features/admin/StaffDetailPanel';

// Scheda anagrafica a TUTTA AREA (sidebar + TopBar del cockpit restano). Sostituisce
// il pannello laterale (drawer) che si apriva sopra la lista: apertura full-screen,
// coerente col pattern di /admin/students/sezioni/[id] e /admin/avvisi/[id].
// `kind` (child|adult|staff) è propagato dalla tabella: decide quale scheda mostrare.

type Kind = 'child' | 'adult' | 'staff';

interface StudentRecord { id: string; nome?: string; cognome?: string; [k: string]: unknown }

function AnagraficaDetailInner() {
    const t = useTranslations('adminStudents');
    const params = useParams<{ id: string }>();
    const search = useSearchParams();
    const router = useRouter();
    const id = params?.id;
    const kind = (search.get('kind') as Kind) || 'child';
    const userId = search.get('userId');
    const isParent = kind === 'adult';
    const isStaff = kind === 'staff';

    const [student, setStudent] = useState<StudentRecord | null>(null);
    const [isLoading, setIsLoading] = useState(!isParent && !isStaff); // genitore/staff caricano dal proprio pannello
    const [notFound, setNotFound] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const withUser = useCallback(
        (href: string) => (userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href),
        [userId],
    );
    const backHref = withUser(
        kind === 'adult' ? '/admin/students?tab=adult' : kind === 'staff' ? '/admin/students?tab=staff' : '/admin/students',
    );
    const goBack = useCallback(() => router.push(backHref), [router, backHref]);

    // Carica l'alunno completo (genitori + delegati + dati economici + fratelli).
    // Genitore e staff hanno pannelli auto-caricanti dedicati: qui non si fetcha.
    useEffect(() => {
        if (isParent || isStaff || !id) return;
        const load = async () => {
            try {
                const res = await fetch(`/api/admin/students/${id}`).catch(() => null);
                if (res?.ok) {
                    const d = await res.json().catch(() => null);
                    if (d && d.id) setStudent(d as StudentRecord);
                    else setNotFound(true);
                } else {
                    setNotFound(true);
                }
            } finally {
                setIsLoading(false);
            }
        };
        load();
    }, [id, isParent, isStaff]);

    const flash = (msg: string) => {
        setToast(msg);
        setTimeout(goBack, 900);
    };

    const handleSaveStudent = async (data: Record<string, unknown> & { id: string }) => {
        const res = await fetch('/api/admin/students', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        }).catch(() => null);
        flash(res?.ok ? `✅ ${t('detailPageSalvaOk')}` : `❌ ${t('erroreSalvataggio')}`);
    };

    const handleDeleteStudent = async (delId: string) => {
        const res = await fetch('/api/admin/students', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: delId }),
        }).catch(() => null);
        flash(res?.ok ? `✅ ${t('detailPageEliminato')}` : `❌ ${t('detailPageEliminaErr')}`);
    };

    /**
     * ⚠️ QUESTO È L'UNICO PUNTO DI MONTAGGIO DI `ParentDetailPanel`, e fino all'11
     * agosto era anche il muro che rendeva IRRAGGIUNGIBILE il suo messaggio sul
     * codice fiscale duplicato. La funzione faceva `.catch(() => null)` e non
     * restituiva niente: `esito` arrivava alla scheda come `undefined`, il ramo
     * `esito.ok === false` non scattava mai, e la sola cosa che l'operatore vedeva
     * era un `❌ Errore nel salvataggio` seguito — 900 ms dopo — dal ritorno
     * automatico alla lista. Cioè: messaggio generico, causa ignota, **e le
     * correzioni appena digitate buttate via**. Su una scheda che serve proprio a
     * correggere un codice fiscale sbagliato.
     *
     * Ora la risposta del server torna alla scheda, che la traduce in una frase
     * («esiste già un genitore con questo codice fiscale») dentro un `role="alert"`
     * in pagina. E soprattutto: **sul fallimento non si naviga**. `flash` fa `push`
     * verso la lista, quindi chiamarlo qui significherebbe smontare il modulo con
     * dentro il lavoro dell'operatore. Si resta dov'è, e si riprova.
     *
     * Il corpo si legge una volta sola (`res.json()` consuma lo stream) e con la
     * propria rete: un 500 senza JSON è comunque un fallimento, non un'eccezione da
     * far risalire.
     */
    const handleSaveParent = async (data: Record<string, unknown> & { id: string }) => {
        const res = await fetch('/api/admin/parents', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        }).catch(() => null);
        if (res?.ok) {
            flash(`✅ ${t('detailPageAnagAgg')}`);
            return { ok: true as const };
        }
        const corpo = res ? await res.json().catch(() => null) : null;
        const errore = typeof (corpo as { error?: unknown } | null)?.error === 'string'
            ? ((corpo as { error: string }).error)
            : null;
        return { ok: false as const, errore };
    };

    const Back = (
        <button
            onClick={goBack}
            className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline"
        >
            <ArrowLeft size={15} strokeWidth={2} /> {t('detailPageBack')}
        </button>
    );

    if (isLoading) {
        return (
            <CockpitPage max={960}>
                {Back}
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="animate-spin text-kidville-green" size={32} />
                </div>
            </CockpitPage>
        );
    }

    if (notFound || (!isParent && !isStaff && !student)) {
        return (
            <CockpitPage max={960}>
                {Back}
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">🧒</div>
                    <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('detailPageNonDisp')}</h2>
                    <p className="font-maven mt-1 text-sm text-kidville-muted">{t('detailPageNonDispHint')}</p>
                </div>
            </CockpitPage>
        );
    }

    return (
        <CockpitPage max={960}>
            {Back}
            {isParent ? (
                <ParentDetailPanel
                    variant="page"
                    parentBasicInfo={{ id: id! }}
                    onClose={goBack}
                    onSave={handleSaveParent}
                />
            ) : isStaff ? (
                <StaffDetailPanel staffId={id!} onClose={goBack} />
            ) : (
                <StudentDetailPanel
                    variant="page"
                    student={student as never}
                    onClose={goBack}
                    onSave={handleSaveStudent}
                    onDelete={handleDeleteStudent}
                />
            )}

            {toast && (
                <div className="fixed bottom-6 right-6 z-[60] flex items-center gap-3 rounded-2xl bg-kidville-green px-6 py-4 font-maven font-semibold text-kidville-white shadow-2xl">
                    {toast}
                </div>
            )}
        </CockpitPage>
    );
}

export default function AnagraficaDetailPage() {
    return (
        <Suspense
            fallback={
                <CockpitPage max={960}>
                    <div className="flex items-center justify-center py-24">
                        <Loader2 className="animate-spin text-kidville-green" size={32} />
                    </div>
                </CockpitPage>
            }
        >
            <AnagraficaDetailInner />
        </Suspense>
    );
}
