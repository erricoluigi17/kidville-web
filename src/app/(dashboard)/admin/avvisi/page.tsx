'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { AlertTriangle, Bell, ClipboardList, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { CockpitPage, HEADER_BTN, PageHeader, StatCard, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit';
import { Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';

// Bacheca avvisi nel cockpit: lista full-width; il dettaglio/monitoraggio apre
// a tutta area su /admin/avvisi/[id] (niente più drawer laterale mobile).

interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: { id: string; name: string; school_type: string }[] }

/** Riconosce una voce di `target_classes` che è in realtà un ID di sezione. */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function AdminAvvisiInner() {
    const router = useRouter();
    const t = useTranslations('adminComunicazioni');
    const locale = useLocale();
    const { userId } = useSessionIdentity();

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingAvviso, setEditingAvviso] = useState<Avviso | null>(null);
    const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
    // Errore dell'ultima operazione sulla LISTA (eliminazione): il modale ha il
    // suo, ma un DELETE respinto avviene fuori dal modale e prima non lo diceva
    // nessuno — la riga restava a schermo e sembrava un ritardo di caricamento.
    const [erroreLista, setErroreLista] = useState('');

    // Classi disponibili dai plessi consentiti, CON la loro sede.
    //
    // Fino al 2026-07-31 qui c'era `[...new Set(sezioni.map(s => s.name))]`: i
    // soli nomi, deduplicati su tutte le sedi. Con tre plessi «2 ANNI» esiste ad
    // Aversa e a Cesa, quindi quel Set trasformava due classi diverse in una
    // pillola sola, e la sede non arrivava mai al server. `/api/admin/sections/scoped`
    // raggruppa già per sede: si smette di appiattire ciò che il server distingue.
    const availableClasses = useMemo<ClasseAvviso[]>(
        () => scuole.flatMap(g =>
            g.sezioni.map(s => ({ id: s.id, nome: s.name, scuolaId: g.scuolaId, scuolaNome: g.scuolaNome })),
        ),
        [scuole]
    );

    // Le sedi rappresentate fra le classi disponibili: se sono più d'una,
    // l'etichetta di un destinatario deve dire ANCHE il plesso.
    const piuSedi = useMemo(
        () => new Set(availableClasses.map(c => c.scuolaId).filter(Boolean)).size > 1,
        [availableClasses],
    );

    /**
     * L'etichetta di una voce di `target_classes`, che è un campo ETEROGENEO.
     *
     * `AvvisoForm` ci scrive i NOMI, ma in produzione esistono record che ci
     * hanno messo l'ID della sezione — e la tabella li stampava tali e quali:
     * un uuid nella colonna «Destinatari», dove ci si aspetta una classe.
     *
     * Si risolve prima per `id` (identità vera), poi per `nome`. La sede si
     * aggiunge SOLO quando è deducibile senza ambiguità: se lo stesso nome
     * esiste in due plessi, attribuirlo a uno dei due sarebbe indovinare — cioè
     * l'errore che questo audit sta chiudendo. L'uuid resta nel `title`: a
     * disposizione del supporto, invisibile a chi legge.
     */
    const etichettaDestinatario = useCallback((voce: string): { testo: string; titolo?: string } => {
        const perId = availableClasses.find(c => c.id === voce);
        if (perId) {
            return {
                testo: piuSedi && perId.scuolaNome ? `${perId.nome} — ${perId.scuolaNome}` : perId.nome,
                titolo: voce,
            };
        }
        const omonime = availableClasses.filter(c => c.nome === voce);
        if (omonime.length === 1) {
            const c = omonime[0];
            return { testo: piuSedi && c.scuolaNome ? `${c.nome} — ${c.scuolaNome}` : c.nome };
        }
        // Più di una: il nome è tutto ciò che si sa con certezza.
        if (omonime.length > 1) return { testo: voce };
        // Nessuna corrispondenza. Se ha la forma di un uuid è una sezione
        // cancellata (o di un plesso che non ci compete): si dice questo, non lo
        // si stampa. Altrimenti è un nome storico, e il nome si legge.
        return UUID_RX.test(voce)
            ? { testo: t('avvisiClasseSconosciuta'), titolo: voce }
            : { testo: voce };
    }, [availableClasses, piuSedi, t]);

    const loadAvvisi = useCallback(async () => {
        if (!userId) return;
        try {
            const res = await fetch(`/api/avvisi?userId=${userId}`).catch(() => null);
            if (res?.ok) setAvvisi(await res.json());
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    useEffect(() => {
        if (!userId) return;
        let active = true;
        fetch(`/api/admin/sections/scoped?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => { if (active && d?.success) setScuole(d.data ?? []); })
            .catch(() => {});
        return () => { active = false; };
    }, [userId]);

    // Ritorna l'ESITO al modulo. Prima era `=> void` e il modulo si chiudeva
    // comunque: un 400 «Specificare la sede» cancellava il testo appena scritto
    // e usciva senza dire niente. Ora un rifiuto lascia il modulo aperto, col
    // messaggio del server, e finisce anche nei log del client (lo `stato` è
    // l'unica cosa che distingue «sede ambigua» da «non sei autorizzato»).
    const handleCreateOrUpdate = async (data: DatiAvviso): Promise<EsitoInvioAvviso> => {
        if (!userId) return { ok: false, errore: t('avvisiErroreOperazione') };
        try {
            // In MODIFICA la sede non si cambia: la PUT non tocca `scuola_id`,
            // e mandarlo lascerebbe credere il contrario a chi legge il codice.
            const { scuola_id, ...comuni } = data;
            const res = editingAvviso
                ? await fetch(`/api/avvisi/${editingAvviso.id}?userId=${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify(comuni),
                })
                : await fetch(`/api/avvisi?userId=${userId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify({ author_id: userId, ...comuni, scuola_id }),
                });

            if (!res.ok) {
                const errore = await messaggioErrore(res, t('avvisiErroreOperazione'));
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: editingAvviso ? 'avviso-modifica-respinta' : 'avviso-pubblicazione-respinta',
                    route: '/admin/avvisi',
                    stato: res.status,
                });
                return { ok: false, errore };
            }
            await loadAvvisi();
            if (editingAvviso) setEditingAvviso(null);
            return { ok: true };
        } catch (err) {
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-salvataggio-fallito: ${nomeErrore(err)}`,
                route: '/admin/avvisi',
            });
            return { ok: false, errore: t('avvisiErroreOperazione') };
        }
    };

    const handleDelete = async (avvisoId: string) => {
        if (!userId) return;
        if (!window.confirm(t('avvisiConfermaElimina'))) return;
        setErroreLista('');
        try {
            const res = await fetch(`/api/avvisi/${avvisoId}?userId=${userId}`, {
                method: 'DELETE',
                headers: { 'x-user-id': userId },
            });
            if (!res.ok) {
                setErroreLista(await messaggioErrore(res, t('avvisiErroreOperazione')));
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'avviso-eliminazione-respinta',
                    route: '/admin/avvisi',
                    stato: res.status,
                });
                return;
            }
            await loadAvvisi();
        } catch (err) {
            setErroreLista(t('avvisiErroreOperazione'));
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-eliminazione-fallita: ${nomeErrore(err)}`,
                route: '/admin/avvisi',
            });
        }
    };

    const openDetail = (id: string) => {
        router.push(`/admin/avvisi/${id}${userId ? `?userId=${userId}` : ''}`);
    };

    const adesioni = avvisi.filter(a => a.tipo === 'adesione').length;

    return (
        <CockpitPage max={1360}>
            <PageHeader
                eyebrow={t('eyebrow')}
                icon={Bell}
                title={t('avvisiTitolo')}
                subtitle={t('avvisiSottotitolo')}
                actions={
                    <button
                        onClick={() => { setEditingAvviso(null); setShowForm(true); }}
                        className={HEADER_BTN}
                    >
                        <Plus size={16} strokeWidth={1.8} /> {t('avvisiNuovoAvviso')}
                    </button>
                }
            />

            {erroreLista && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-card bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                    <span>{erroreLista}</span>
                </div>
            )}

            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-[560px]">
                <StatCard icon={Bell} label={t('avvisiStatPubblicati')} value={loading ? '…' : avvisi.length} />
                <StatCard icon={ClipboardList} label={t('avvisiStatConAdesione')} value={loading ? '…' : adesioni} tone="yellow" />
            </div>

            {loading ? (
                <div className="flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
                    <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                    <p className="font-maven text-sm text-kidville-muted">{t('avvisiCaricamento')}</p>
                </div>
            ) : avvisi.length === 0 ? (
                <div className="rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-cream text-3xl">📢</div>
                    <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('avvisiVuotoTitolo')}</h2>
                    <p className="font-maven mt-1 text-sm text-kidville-muted">{t('avvisiVuotoDescrizione')}</p>
                </div>
            ) : (
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                    <div className={TABLE_WRAP}>
                        <table className={TABLE}>
                            <thead>
                                <tr>
                                    <th className={TH}>{t('avvisiColAvviso')}</th>
                                    <th className={TH}>{t('avvisiColTipo')}</th>
                                    <th className={TH}>{t('avvisiColDestinatari')}</th>
                                    <th className={TH}>{t('avvisiColScadenza')}</th>
                                    <th className={TH}>{t('avvisiColLetture')}</th>
                                    <th className={TH}>{t('avvisiColAdesioni')}</th>
                                    <th className={TH}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {avvisi.map(a => (
                                    <tr key={a.id} className={`${TROW} cursor-pointer`} onClick={() => openDetail(a.id)}>
                                        <td className={TD}>
                                            <span className="font-maven block max-w-[360px] truncate text-sm font-semibold text-kidville-ink">{a.titolo}</span>
                                            <span className="font-maven block text-xs text-kidville-muted">
                                                {a.author ? `${a.author.first_name} ${a.author.last_name}` : ''} · {new Date(a.created_at).toLocaleDateString(locale)}
                                            </span>
                                        </td>
                                        <td className={TD}>
                                            <span className={`rounded-pill px-2.5 py-1 font-maven text-[11px] font-bold ${a.tipo === 'adesione' ? 'bg-kidville-info-soft text-kidville-info' : 'bg-kidville-green-soft text-kidville-green'}`}>
                                                {a.tipo === 'adesione' ? t('avvisiTipoAdesione') : t('avvisiTipoPresaVisione')}
                                            </span>
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                                            {a.target_scope === 'globale'
                                                ? t('avvisiTuttoIstituto')
                                                : (a.target_classes ?? []).map((voce, i) => {
                                                    const e = etichettaDestinatario(voce);
                                                    return (
                                                        <span key={`${voce}-${i}`}>
                                                            {i > 0 && ', '}
                                                            <span title={e.titolo}>{e.testo}</span>
                                                        </span>
                                                    );
                                                })}
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-muted`}>
                                            {a.scadenza ? new Date(a.scadenza).toLocaleDateString(locale) : '—'}
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>{a.stats?.letti ?? 0}</td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                                            {a.tipo === 'adesione' ? t('avvisiAdesioniSiNo', { si: a.stats?.adesioni_si ?? 0, no: a.stats?.adesioni_no ?? 0 }) : '—'}
                                        </td>
                                        <td className={TD}>
                                            <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                                <button
                                                    onClick={() => openDetail(a.id)}
                                                    title={t('avvisiAzioneApri')}
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                                                >
                                                    <Eye size={14} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    onClick={() => { setEditingAvviso(a); setShowForm(true); }}
                                                    title={t('avvisiAzioneModifica')}
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                                                >
                                                    <Pencil size={14} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(a.id)}
                                                    title={t('avvisiAzioneElimina')}
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-error/10 text-kidville-error transition-colors hover:bg-kidville-error/20"
                                                >
                                                    <Trash2 size={14} strokeWidth={1.8} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Form modale (riusato dal flusso docente) */}
            <AvvisoForm
                open={showForm}
                onClose={() => {
                    setShowForm(false);
                    setEditingAvviso(null);
                }}
                onSubmit={handleCreateOrUpdate}
                availableClasses={availableClasses}
                initialAvviso={editingAvviso}
            />
        </CockpitPage>
    );
}

function AvvisiFallback() {
    const t = useTranslations('adminComunicazioni');
    return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function AdminAvvisiPage() {
    return (
        <Suspense fallback={<AvvisiFallback />}>
            <AdminAvvisiInner />
        </Suspense>
    );
}
