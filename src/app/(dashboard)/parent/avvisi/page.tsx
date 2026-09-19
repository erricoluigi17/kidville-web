'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AdesioneNumeroModal, type ModoAdesione } from '@/components/features/avvisi/AdesioneNumeroModal';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { OfflineBadge } from '@/components/ui/OfflineBadge';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { fetchConCache } from '@/lib/offline/read-cache';
import { logClient, nomeErrore } from '@/lib/logging/client';

// m3: ogni avviso porta l'elenco dei FIGLI cui si riferisce — nome, `student_id`
// e, dal 2026-09-19, lo STATO DELLA RIGA di ciascuno — così il feed unificato può
// mostrare a chi si riferisce ogni comunicazione senza duplicare l'avviso. Il
// campo è aggiunto server-side dal ramo genitore.
//
// ⚠️ La forma sta in UN posto solo (`FiglioAvviso`, accanto ad `Avviso`), e non
// più anche qui: due definizioni della stessa riga sono il modo in cui una delle
// due resta indietro — è così che i numeri per figlio sarebbero arrivati alla
// modale senza che il tipo di questa pagina li conoscesse.
type AvvisoConFigli = Avviso;

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentAvvisiContent() {
    const t = useTranslations('avvisi');
    const { parentId, studentId, ready } = useParentIdentity();

    const [avvisi, setAvvisi] = useState<AvvisoConFigli[]>([]);
    const [loading, setLoading] = useState(true);
    // true quando gli avvisi mostrati arrivano dalla cache offline (rete assente).
    const [offline, setOffline] = useState(false);

    // Feed UNIFICATO server-derived (G3): niente più parentId/classe/studentId nella
    // query — il server ricava figli, classi e plesso dalla sessione. Si passa solo
    // l'identità (x-user-id) per il modello header-identity ancora attivo in prod.
    // try/finally (NON try/catch): dentro un effect il catch farebbe scattare
    // react-hooks/set-state-in-effect. I fallimenti di rete/!res.ok sono comunque
    // registrati dal fetch strumentato globale (logClient) — l'osservabilità c'è.
    // fetchConCache serve l'ultima copia salvata quando la rete manca (offline=true);
    // se non c'è né rete né cache rilancia e il flusso resta identico a prima.
    const loadAvvisi = useCallback(async () => {
        if (!ready || !parentId) return;
        try {
            const { data, offline: off } = await fetchConCache<AvvisoConFigli[]>(
                `avvisi:${parentId}`,
                '/api/avvisi',
                { headers: { 'x-user-id': parentId } },
            );
            setAvvisi(data);
            setOffline(off);
        } finally {
            setLoading(false);
        }
    }, [ready, parentId]);

    useEffect(() => {
        loadAvvisi();
    }, [loadAvvisi]);

    // I figli a cui si riferisce l'avviso: sono la CHIAVE per-figlio della risposta
    // (student_id nell'upsert). Fallback al figlio attivo se il feed non li porta.
    const figliDiAvviso = useCallback((avvisoId: string): string[] => {
        const a = avvisi.find((x) => x.id === avvisoId);
        const ids = (a?.figli ?? []).map((f) => f.student_id).filter(Boolean);
        return ids.length > 0 ? ids : (studentId ? [studentId] : []);
    }, [avvisi, studentId]);

    const postRisposta = useCallback(async (avvisoId: string, sid: string, risposta?: 'si' | 'no') => {
        const body = risposta ? { student_id: sid, risposta } : { student_id: sid };
        await fetch(`/api/avvisi/${avvisoId}/risposte`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(parentId ? { 'x-user-id': parentId } : {}) },
            body: JSON.stringify(body),
        });
    }, [parentId]);

    const handleReadReceipt = async (avvisoId: string) => {
        const ids = figliDiAvviso(avvisoId);
        if (ids.length === 0) return;
        try {
            // Presa visione = il genitore ha letto: vale per TUTTI i figli cui si riferisce.
            await Promise.all(ids.map((sid) => postRisposta(avvisoId, sid)));
            await loadAvvisi();
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `avviso-presa-visione-fallita: ${nomeErrore(err)}`,
                route: '/parent/avvisi',
            });
        }
    };

    // ── LA MODALE È UNA SOLA, E VIVE QUI ────────────────────────────────────
    //
    // Non dentro `AvvisoCard`. ⚠️ La ragione scritta qui era falsa — «la stessa
    // comunicazione è renderizzata nella lista E nell'anteprima in home»: la home
    // monta `AvvisiPreview`, non questa card. La conclusione però regge, e la
    // ragione vera è la lista stessa: una card per avviso, quindi una modale per
    // card sono N dialoghi nel DOM, N focus-trap in ascolto sullo stesso
    // `document`, e alla chiusura un fuoco da ripristinare su un elemento che nel
    // frattempo è scorso via. Lo stato è la coppia «su quale avviso» + «cosa si
    // sta facendo».
    const [modale, setModale] = useState<{ avviso: AvvisoConFigli; modo: ModoAdesione } | null>(null);

    const chiudiModale = useCallback(() => {
        setModale(null);
        // Si ricarica SEMPRE, anche dopo un annullamento: fra l'apertura e la
        // chiusura può essere stata scritta una riga (conferma andata a buon fine
        // per un figlio e respinta per l'altro), e una bacheca ferma mostrerebbe
        // alla famiglia uno stato che non è più il suo.
        void loadAvvisi();
    }, [loadAvvisi]);

    /**
     * ─── IL GESTO DEL GENITORE, NON LA SCRITTURA ─────────────────────────────
     *
     * Qui prima c'era `handleAdesione(avvisoId, risposta)`, che rispondeva IN
     * BLOCCO per tutti i figli con la stessa risposta: una famiglia con due bambini
     * di cui uno solo va in gita non aveva alcun modo di dirlo.
     *
     * 🔴 «Aderisco» NON scrive quando l'avviso chiede quante persone: apre la
     * modale, e la riga nasce alla conferma — una volta sola. Senza il numero
     * l'adesione non vale, e registrarla comunque significherebbe contarla come UNA
     * persona per convenzione contro il tetto dei posti.
     *
     * Il flusso a UN TOCCO resta per gli avvisi senza contatore: lì non c'è niente
     * da chiedere, e una modale che domanda una cosa sola già decisa sarebbe un
     * passo in più su ogni circolare della scuola.
     */
    const handleAdesione = async (avviso: AvvisoConFigli, risposta: 'si' | 'no') => {
        if (risposta === 'si' && avviso.chiedi_numero === true) {
            setModale({ avviso, modo: 'nuova' });
            return;
        }
        const ids = figliDiAvviso(avviso.id);
        if (ids.length === 0) return;
        try {
            await Promise.all(ids.map((sid) => postRisposta(avviso.id, sid, risposta)));
            await loadAvvisi();
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `avviso-adesione-fallita: ${nomeErrore(err)}`,
                route: '/parent/avvisi',
            });
        }
    };

    // "Da gestire" (DR): non letti (presa visione) + adesioni senza risposta.
    const daGestire = avvisi.filter(a =>
        a.tipo === 'adesione' ? !a.my_response?.risposta : !a.my_response?.letto_il
    ).length;

    return (
        <div className="px-4 pt-5 pb-24">
            {/* Header */}
            <PageHeaderCard
                eyebrow={t('pageEyebrow')}
                title={t('pageTitle')}
                subtitle={loading ? t('sottotitoloCaricamento') : daGestire > 0 ? t('sottotitoloDaGestire', { count: daGestire }) : t('sottotitoloOk')}
                className="mb-6"
            />

            {/* Indicatore offline: i dati vengono dall'ultima copia in cache */}
            {offline && !loading && (
                <div className="mb-4 flex justify-center">
                    <OfflineBadge />
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
                </div>
            )}

            {/* Empty */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📭</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">{t('vuotoTitolo')}</h2>
                    <p className="font-maven text-kidville-muted text-sm max-w-xs">
                        {t('vuotoDescrizione')}
                    </p>
                </div>
            )}

            {/* Avvisi */}
            {!loading && avvisi.length > 0 && (
                <div className="space-y-3">
                    {avvisi.map((avviso, idx) => {
                        // m3: il/i figlio/i cui si riferisce l'avviso (entrambi se globale).
                        const figli = avviso.figli ?? [];
                        return (
                            <div key={avviso.id}>
                                {figli.length > 0 && (
                                    <div className="mb-1 flex flex-wrap items-center gap-1 px-1">
                                        <span className="font-maven text-[10px] font-semibold text-kidville-green">{t('perFigli')}</span>
                                        {figli.map((f) => (
                                            <span
                                                key={f.student_id}
                                                className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green"
                                            >
                                                {f.nome || t('figlioFallback')}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <AvvisoCard avviso={avviso} index={idx}
                                    onReadReceipt={handleReadReceipt}
                                    onAdesione={handleAdesione}
                                    onModificaNumero={(a) => setModale({ avviso: a as AvvisoConFigli, modo: 'modifica' })} />
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Una sola modale per tutta la pagina — vedi il riquadro su `modale`. */}
            <AdesioneNumeroModal
                open={modale !== null}
                avviso={modale?.avviso ?? null}
                // I figli cui l'avviso si riferisce. Il ripiego sul figlio attivo è
                // lo stesso di `figliDiAvviso`: senza, un feed che non portasse i
                // nomi aprirebbe una modale senza nessuna riga da compilare.
                figli={
                    (modale?.avviso.figli ?? []).length > 0
                        ? (modale?.avviso.figli ?? [])
                        : (studentId ? [{ student_id: studentId, nome: t('figlioFallback') }] : [])
                }
                modo={modale?.modo ?? 'nuova'}
                parentId={parentId}
                onChiudi={chiudiModale}
            />

            {/* Footer */}
            <div className="mt-8 p-4 bg-white rounded-2xl border border-kidville-line text-center">
                <p className="font-maven text-xs text-kidville-muted">
                    {t('footerRiga1')}<br />
                    {t('footerRiga2')}
                </p>
            </div>
        </div>
    );
}

export default function ParentAvvisiPage() {
    return (
        <Suspense fallback={
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentAvvisiContent />
        </Suspense>
    );
}
