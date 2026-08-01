'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm';
import { AvvisoDetailsDrawer } from '@/components/features/avvisi/AvvisoDetailsDrawer';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useTranslations } from 'next-intl';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function TeacherAvvisiContent() {
    const t = useTranslations('teacherComunicazioni');
    const { userId: teacherId } = useSessionIdentity();

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingAvviso, setEditingAvviso] = useState<Avviso | null>(null);
    const [selectedAvviso, setSelectedAvviso] = useState<Avviso | null>(null);
    const [showDetails, setShowDetails] = useState(false);

    // Classi reali del docente (utenti_sezioni via /api/educator-sections):
    // niente elenco hardcoded; con 0 sezioni le pill del form restano vuote.
    const [availableClasses, setAvailableClasses] = useState<ClasseAvviso[]>([]);
    // Esito dell'ultima operazione sulla lista (eliminazione): prima un DELETE
    // respinto non lasciava traccia a schermo.
    const [erroreLista, setErroreLista] = useState('');

    // Un educator può inviare avvisi solo alle proprie classi. Default RESTRITTIVO
    // (true) finché /api/educator-sections non conferma il ruolo: solo
    // admin/coordinator (Direzione) ottengono il form completo (con «🌐 Tutti»).
    const [soloClassiProprie, setSoloClassiProprie] = useState(true);

    useEffect(() => {
        if (!teacherId) return;
        fetch(`/api/educator-sections?userId=${teacherId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                // `sections` porta l'identità quando la route la espone; finché
                // restituisce i soli nomi si ripiega su quelli, e la sede resta
                // ignota: la dichiara il server (che, se resta ambigua, risponde
                // 400 — e adesso quel 400 si vede nel modulo).
                const righe = (d?.sections ?? []) as { id?: string; name: string; scuolaId?: string; scuolaNome?: string }[];
                const classi: ClasseAvviso[] = righe.length > 0
                    ? righe.map(s => ({ id: s.id ?? s.name, nome: s.name, scuolaId: s.scuolaId ?? null, scuolaNome: s.scuolaNome ?? null }))
                    : ((d?.sectionNames ?? []) as string[]).map(n => ({ id: n, nome: n }));
                setAvailableClasses(classi);
                const role = d?.role;
                setSoloClassiProprie(!(role === 'admin' || role === 'coordinator'));
            })
            .catch(err => {
                // Un catch che non logga è un bug (AGENTS.md): senza sezioni il
                // docente non può indirizzare nessun avviso, e senza questa riga
                // «non ha classi» e «la chiamata è morta» sono indistinguibili.
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `educator-sections-non-caricate: ${nomeErrore(err)}`,
                    route: '/teacher/avvisi',
                });
            });
    }, [teacherId]);

    const loadAvvisi = useCallback(async () => {
        if (!teacherId) return;
        try {
            const res = await fetch(`/api/avvisi?userId=${teacherId}`).catch(() => null);
            if (res?.ok) setAvvisi(await res.json());
        } finally {
            setLoading(false);
        }
    }, [teacherId]);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    // Come nel cockpit: l'esito torna al modulo, che su rifiuto resta aperto col
    // messaggio del server invece di chiudersi buttando via il testo scritto.
    const handleCreateOrUpdate = async (data: DatiAvviso): Promise<EsitoInvioAvviso> => {
        if (!teacherId) return { ok: false, errore: t('formErroreInvio') };
        try {
            // In modifica la sede non si cambia (la PUT non tocca `scuola_id`).
            const { scuola_id, ...comuni } = data;
            const res = editingAvviso
                ? await fetch(`/api/avvisi/${editingAvviso.id}?userId=${teacherId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
                    body: JSON.stringify(comuni),
                })
                : await fetch(`/api/avvisi?userId=${teacherId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
                    body: JSON.stringify({ author_id: teacherId, ...comuni, scuola_id }),
                });

            if (!res.ok) {
                const errore = await messaggioErrore(res, t('formErroreInvio'));
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: editingAvviso ? 'avviso-modifica-respinta' : 'avviso-pubblicazione-respinta',
                    route: '/teacher/avvisi', stato: res.status,
                });
                return { ok: false, errore };
            }
            await loadAvvisi();
            if (editingAvviso) setEditingAvviso(null);
            return { ok: true };
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `avviso-salvataggio-fallito: ${nomeErrore(err)}`, route: '/teacher/avvisi' });
            return { ok: false, errore: t('formErroreInvio') };
        }
    };

    const handleDelete = async (avvisoId: string) => {
        if (!teacherId) return;
        if (!window.confirm(t('avvisiConfermaElimina'))) return;
        setErroreLista('');
        try {
            const res = await fetch(`/api/avvisi/${avvisoId}?userId=${teacherId}`, {
                method: 'DELETE',
                headers: { 'x-user-id': teacherId },
            });
            if (!res.ok) {
                setErroreLista(await messaggioErrore(res, t('formErroreInvio')));
                logClient({
                    livello: 'error', evento: 'fetch', messaggio: 'avviso-eliminazione-respinta',
                    route: '/teacher/avvisi', stato: res.status,
                });
                return;
            }
            await loadAvvisi();
        } catch (err) {
            setErroreLista(t('formErroreInvio'));
            logClient({ livello: 'error', evento: 'fetch', messaggio: `avviso-eliminazione-fallita: ${nomeErrore(err)}`, route: '/teacher/avvisi' });
        }
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow={t('avvisiEyebrow')}
                title={t('avvisiTitolo')}
                subtitle={t('avvisiSottotitolo')}
                action={
                    <Btn variant="secondary" size="sm" onClick={() => { setEditingAvviso(null); setShowForm(true); }}>
                        <Plus size={16} strokeWidth={1.8} /> {t('avvisiNuovo')}
                    </Btn>
                }
            />
            <div className="mt-5">{/* contenuto */}</div>

            {erroreLista && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error-strong">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                    <span>{erroreLista}</span>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-sub">{t('avvisiCaricamento')}</p>
                </div>
            )}

            {/* Empty state */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📢</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">{t('avvisiVuotoTitolo')}</h2>
                    <p className="font-maven text-kidville-sub text-sm max-w-xs">
                        {t('avvisiVuotoDescrizione')}
                    </p>
                </div>
            )}

            {/* Avvisi list */}
            {!loading && avvisi.length > 0 && (
                <div className="space-y-3">
                    {avvisi.map((avviso, idx) => (
                        <AvvisoCard
                            key={avviso.id}
                            avviso={avviso}
                            index={idx}
                            isTeacher
                            onShowDetails={(a) => {
                                setSelectedAvviso(a);
                                setShowDetails(true);
                            }}
                            onEdit={(a) => {
                                setEditingAvviso(a);
                                setShowForm(true);
                            }}
                            onDelete={handleDelete}
                        />
                    ))}
                </div>
            )}

            {/* Form modale */}
            <AvvisoForm
                open={showForm}
                onClose={() => {
                    setShowForm(false);
                    setEditingAvviso(null);
                }}
                onSubmit={handleCreateOrUpdate}
                availableClasses={availableClasses}
                initialAvviso={editingAvviso}
                soloClassiProprie={soloClassiProprie}
            />

            {/* Drawer Dettaglio Monitoraggio */}
            <AvvisoDetailsDrawer
                open={showDetails}
                avviso={selectedAvviso}
                onClose={() => {
                    setShowDetails(false);
                    setSelectedAvviso(null);
                }}
                // Il drawer di monitoraggio ragiona per NOMI (li confronta con
                // `target_classes` dell'avviso): riceve i nomi, non le identità.
                availableClasses={availableClasses.map(c => c.nome)}
            />
        </div>
    );
}

export default function TeacherAvvisiPage() {
    return (
        <Suspense fallback={
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherAvvisiContent />
        </Suspense>
    );
}
