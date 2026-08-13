'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel';
import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel';
import { StaffDetailPanel } from '@/components/features/admin/StaffDetailPanel';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

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

    /**
     * ⚠️ QUESTA FUNZIONE ERA `handleDeleteStudent`, ED ERA IL DIFETTO DESCRITTO
     * NEL COMMENTO QUI SOTTO, LASCIATO INTATTO SU QUESTO RAMO.
     *
     * Chiamava `DELETE /api/admin/students` e **non leggeva mai `res.json()`**:
     * qualunque cosa il server avesse da dire — «l'alunno ha ancora dati
     * collegati», che il 12 agosto era la risposta per 28 alunni su 33 — finiva
     * in un `❌ Errore nell'eliminazione` senza causa. E `flash` fa
     * `setTimeout(goBack, 900)` **anche sul fallimento**: l'operatore veniva
     * sbattuto fuori dalla scheda 0,9 secondi dopo, con l'errore in mano e
     * niente da farci.
     *
     * La forma giusta esisteva già in questo stesso file, dodici righe più sotto
     * (`handleSaveParent`), dove la correzione era stata capita e mai propagata a
     * questo ramo: il corpo si legge UNA volta sola (`res.json()` consuma lo
     * stream), sul successo si annuncia e si torna alla lista, sul fallimento
     * **non si naviga** e l'esito torna alla scheda, che lo mostra in un
     * `role="alert"` dove chi ha premuto lo sta ancora guardando.
     */
    const handleArchiveStudent = async (alunnoId: string) => {
        const res = await fetch('/api/admin/students/archivia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alunno_id: alunnoId }),
        }).catch(() => null);
        if (res?.ok) {
            // Il nome nel messaggio non è decorazione: la segreteria lavora su più
            // schede aperte, e «alunno spostato» non dice QUALE.
            flash(`✅ ${t('detailPageArchiviato', { nome: [student?.nome, student?.cognome].filter(Boolean).join(' ') })}`);
            return { ok: true as const };
        }
        // Il corpo si legge una volta sola, e il `codice` che la rotta manda vale
        // più della sua prosa: `messaggioDaCorpo` traduce il codice dichiarato e
        // ricade sulla frase del server solo quando non lo riconosce. Senza,
        // un'interfaccia in inglese leggerebbe il rifiuto in italiano.
        const corpo = res ? await res.json().catch(() => null) : null;
        return { ok: false as const, errore: messaggioDaCorpo(corpo, t('detailArchiviaErrore')) };
    };

    /**
     * IL RITORNO — la metà del modello che a questa scheda mancava.
     *
     * Ha la stessa forma dell'archiviazione (esito letto una volta sola, sul
     * fallimento NON si naviga) e una cosa in più: l'annuncio distingue il caso in
     * cui il bambino è rientrato SENZA classe, perché è l'unico che lascia qualcosa
     * da fare. `esito_classe` ha quattro valori (`riattiva/route.ts`) e solo
     * `sparita` e `assente` significano «va assegnata»: `conservata` è il ritiro
     * fatto a mano dalla tendina, dove la classe non è mai stata tolta — ed è il
     * caso su cui, fino al 2026-08-13, l'elenco diceva ugualmente «Assegna una
     * classe» a un bambino che era in «2 ANNI».
     */
    const handleRiattivaStudent = async (alunnoId: string) => {
        const res = await fetch('/api/admin/students/riattiva', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alunno_id: alunnoId }),
        }).catch(() => null);
        // ⚠️ Il corpo si legge UNA volta sola e serve a ENTRAMBI i rami: `res.json()`
        // consuma lo stream, quindi leggerlo dentro l'`if` e poi di nuovo fuori
        // darebbe una promise già risolta a vuoto sul secondo tentativo.
        const corpo = res ? await res.json().catch(() => null) : null;
        if (res?.ok) {
            const nome = [student?.nome, student?.cognome].filter(Boolean).join(' ');
            const senzaClasse = (corpo as { esito_classe?: unknown } | null)?.esito_classe;
            flash(
                senzaClasse === 'sparita' || senzaClasse === 'assente'
                    ? `✅ ${t('detailPageRiattivatoSenzaClasse', { nome })}`
                    : `✅ ${t('detailPageRiattivato', { nome })}`,
            );
            return { ok: true as const };
        }
        return { ok: false as const, errore: messaggioDaCorpo(corpo, t('detailRiattivaErrore')) };
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
                    onArchive={handleArchiveStudent}
                    onRiattiva={handleRiattivaStudent}
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
