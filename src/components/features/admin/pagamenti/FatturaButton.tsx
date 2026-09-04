'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { FileText, Download, Loader2, X, Pencil } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

interface FatturaRow { id: string; quota_label: string | null; intestatario: string }

// Download fattura(e): link singolo o menù a tendina quando il pagamento è stato
// fatturato in più quote (genitori separati).
function EmessaLinks({ pagamentoId, userId }: { pagamentoId: string; userId: string }) {
    const t = useTranslations('adminContabilita');
    const [fatture, setFatture] = useState<FatturaRow[] | null>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        let active = true;
        fetch(`/api/pagamenti/fattura/list?pagamento_id=${pagamentoId}&userId=${userId}`, { headers: { 'x-user-id': userId } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (active && d?.success) setFatture(d.data); })
            .catch(() => {});
        return () => { active = false; };
    }, [pagamentoId, userId]);

    if (!fatture || fatture.length <= 1) {
        return (
            <a href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&userId=${userId}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-kidville-green-soft text-kidville-green text-xs font-bold transition-colors hover:bg-kidville-green/20">
                <Download size={12} /> {t('fatBtn_fattura')}
            </a>
        );
    }
    return (
        <div className="relative inline-block">
            <button onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-kidville-green-soft text-kidville-green text-xs font-bold transition-colors hover:bg-kidville-green/20">
                <Download size={12} /> {t('fatBtn_fatture')} ({fatture.length})
            </button>
            {open && (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-card border border-kidville-line bg-kidville-white p-1" style={{ boxShadow: MODAL_SHADOW }}>
                    {fatture.map((f) => (
                        <a key={f.id} href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&fattura_id=${f.id}&userId=${userId}`}
                            className="block rounded-input px-3 py-1.5 font-maven text-xs text-kidville-green hover:bg-kidville-green-soft">
                            {t('fatBtn_fattura_dash')} {f.quota_label || f.intestatario}
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

interface Props {
    pagamentoId: string;
    userId: string;
    fatturaStato?: string;
    onEmessa?: () => void;
}

/** Ciò che `/api/pagamenti/fattura/anteprima` risponde: il testo che uscirà davvero. */
interface Anteprima {
    causale: string;
    origine: 'manuale' | 'categoria' | 'predefinito' | 'fabbrica';
    /** Misurata sul TRACCIATO (`€`→`EUR`), non su `.length`. */
    lunghezza: number;
    limite: number;
    eccede: boolean;
}

// Pulsante "Invia Fattura" (emissione reale Aruba/SDI). Prima di emettere apre un
// modale che MOSTRA la causale composta dal modello della sede; personalizzarla è un
// gesto in più, deliberato.
//
// ─── PERCHÉ NON C'È PIÙ UNA CASELLA PRECOMPILATA ─────────────────────────────
// Fino al 2026-09-04 questo componente nasceva con `useState(descrizione ?? '')` e
// spediva quella stringa come `causale`: cioè come *correzione manuale della
// segreteria*, che batte qualunque modello configurato in Contabilità → Causali.
// Chi premeva «Emetti» senza svuotare il campo — chiunque — annullava la
// configurazione senza saperlo. La fattura FPR 1948/26 è partita così verso lo SDI,
// con la nuda descrizione «Retta 09/2026», mentre Aversa aveva configurato un
// modello coi segnaposti. Il segnaposto della casella prometteva perfino «Lascia
// vuoto per usare il template delle impostazioni».
//
// Il testo mostrato NON è ricalcolato qui: arriva da `/api/pagamenti/fattura/anteprima`,
// che chiama lo stesso `componiCausalePagamento` dell'emissione. Ricalcolarlo nel
// browser vorrebbe dire far approvare un testo e spedirne un altro, su un documento
// che si corregge solo con una nota di variazione.
export function FatturaButton({ pagamentoId, userId, fatturaStato, onEmessa }: Props) {
    const t = useTranslations('adminContabilita');
    const [stato, setStato] = useState(fatturaStato ?? 'non_richiesta');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
    const [erroreAnteprima, setErroreAnteprima] = useState<string | null>(null);
    const [personalizza, setPersonalizza] = useState(false);
    const [causale, setCausale] = useState('');

    // L'anteprima si chiede all'apertura del modale, non al montaggio: in una tabella
    // di rette ci sono decine di questi pulsanti, e una GET a testa sarebbe una raffica
    // per una schermata che nessuno ha ancora deciso di usare.
    const apri = async () => {
        setOpen(true);
        setAnteprima(null);
        setErroreAnteprima(null);
        setPersonalizza(false);
        setCausale('');
        try {
            const res = await fetch(`/api/pagamenti/fattura/anteprima?pagamento_id=${pagamentoId}&userId=${userId}`, {
                headers: { 'x-user-id': userId },
            });
            const j = await res.json();
            if (!res.ok || !j?.data?.causale) {
                setErroreAnteprima(messaggioDaCorpo(j, t('fatBtn_anteprima_errore')));
                return;
            }
            setAnteprima(j.data as Anteprima);
            setCausale(String(j.data.causale));
        } catch {
            // Un `catch` muto è un bug (AGENTS.md, regola 6): qui l'errore diventa il
            // messaggio a schermo che blocca l'emissione, che è il modo giusto di non
            // ignorarlo.
            setErroreAnteprima(t('fatBtn_anteprima_errore'));
        }
    };

    /**
     * La correzione manuale si spedisce SOLO se è davvero una correzione.
     *
     * `null` non è «niente»: la route lo legge come «togli la correzione salvata».
     * Serve perché `pagamenti.fattura_causale` è appiccicoso — una volta scritto,
     * congela quel pagamento e rende invisibile ogni modifica futura al modello.
     */
    const causaleDaSpedire = (): string | null => {
        if (!personalizza) return null;
        const testo = causale.trim();
        if (!testo || testo === anteprima?.causale.trim()) return null;
        return testo;
    };

    const emetti = async () => {
        if (!anteprima) return;
        setBusy(true);
        try {
            const res = await fetch('/api/pagamenti/fattura', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ pagamento_id: pagamentoId, causale: causaleDaSpedire() }),
            });
            const j = await res.json();
            if (res.ok) { setStato(j.data?.fattura_stato ?? 'in_attesa'); setOpen(false); onEmessa?.(); }
            // Senza ripiego questo `alert` mostrava la stringa «undefined» ogni volta che il
            // server rifiutava SENZA un campo `error` (403 di scope, 500): non è un difetto di
            // lingua, è un messaggio che non dice niente a nessuno.
            else { setStato(j.data?.fattura_stato ?? 'scartata'); alert(messaggioDaCorpo(j, t('fatBtn_err_emissione'))); }
        } finally { setBusy(false); }
    };

    if (stato === 'emessa') {
        return <EmessaLinks pagamentoId={pagamentoId} userId={userId} />;
    }

    if (stato === 'in_attesa') {
        return (
            <Badge tone="warn" title={t('fatBtn_attesa_title')}>
                <Loader2 size={12} className="animate-spin" /> {t('fatBtn_attesa_sdi')}
            </Badge>
        );
    }

    return (
        <>
            <button onClick={apri}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-kidville-line text-kidville-muted text-xs font-bold transition-colors hover:border-kidville-green hover:text-kidville-green">
                <FileText size={12} />
                {stato === 'scartata' ? t('fatBtn_riprova') : t('fatBtn_invia')}
            </button>

            {open && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-kidville-ink/40 p-4" onClick={() => setOpen(false)}>
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        className={MODAL_CARD}
                        style={{ boxShadow: MODAL_SHADOW }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                                <FileText size={18} /> {t('fatBtn_emetti_titolo')}
                            </h3>
                            <button onClick={() => setOpen(false)} aria-label={t('fatBtn_chiudi')} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                        </div>
                        <label htmlFor={`causale-${pagamentoId}`} className="font-maven text-xs text-kidville-muted mb-1 block">
                            {anteprima ? t(`fatBtn_origine_${anteprima.origine}`) : t('fatBtn_causale_label')}
                        </label>
                        <textarea
                            id={`causale-${pagamentoId}`}
                            value={causale}
                            onChange={(e) => setCausale(e.target.value)}
                            readOnly={!personalizza}
                            rows={3}
                            placeholder={anteprima ? undefined : t('fatBtn_causale_caricamento')}
                            aria-describedby={`causale-misura-${pagamentoId} causale-avviso-${pagamentoId}`}
                            className={cx(INPUT, !personalizza && 'bg-kidville-cream/60')}
                        />

                        {/* Il conteggio è SEMPRE a schermo, non solo quando si sfora: dice su
                            cosa è misurato, ed è la metà della regola che nel 2026-08-10 era
                            stata presa senza l'altra. */}
                        <p id={`causale-misura-${pagamentoId}`} className="font-maven text-[11px] text-kidville-sub mt-1">
                            {anteprima ? `${anteprima.lunghezza} / ${anteprima.limite}` : ''}
                        </p>
                        {/* Live region montata VUOTA e riempita dopo: un `role="status"` inserito
                            nel DOM col contenuto già dentro spesso resta muto (NVDA/JAWS osservano
                            le mutazioni di quelli già presenti). È lo stesso nodo, sempre. */}
                        <p id={`causale-avviso-${pagamentoId}`} role="status" className="font-maven text-[11px] text-kidville-error mt-1">
                            {anteprima?.eccede ? t('fatBtn_causale_troppo_lunga') : ''}
                        </p>

                        {erroreAnteprima && (
                            <p role="alert" className="font-maven text-xs text-kidville-error mt-1">{erroreAnteprima}</p>
                        )}

                        {anteprima && !personalizza && (
                            <button
                                onClick={() => setPersonalizza(true)}
                                className="mt-2 inline-flex items-center gap-1 font-maven text-xs font-bold text-kidville-green underline"
                            >
                                <Pencil size={12} /> {t('fatBtn_personalizza')}
                            </button>
                        )}
                        {personalizza && (
                            <p className="font-maven text-[11px] text-kidville-sub mt-2">{t('fatBtn_personalizza_hint')}</p>
                        )}

                        <div className="flex gap-2 mt-4">
                            <button onClick={() => setOpen(false)} className={cx(BTN_SECONDARY, 'flex-1')}>
                                {t('fatBtn_annulla')}
                            </button>
                            {/* Senza anteprima non si emette: emettere alla cieca su un documento
                                irreversibile non è un ripiego accettabile. */}
                            <button onClick={emetti} disabled={busy || !anteprima} className={cx(BTN_PRIMARY, 'flex-1')}>
                                {busy ? <Loader2 size={14} className="animate-spin" /> : null} {t('fatBtn_emetti')}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </>
    );
}
