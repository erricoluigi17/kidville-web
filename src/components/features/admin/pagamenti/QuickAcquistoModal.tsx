'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { X, ShoppingBag } from 'lucide-react';
import { FatturaButton } from './FatturaButton';
import { RateizzaModal } from './RateizzaModal';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';
import { formatEuro } from '@/lib/format/valuta';

interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null }
interface Categoria { id: string; nome: string; slug?: string }

interface Props {
    alunno: Alunno;
    categoria: Categoria;
    userId: string;
    scuolaId?: string;
    onClose: () => void;
    onDone: () => void;
}

const METODI = [
    { v: 'contanti', l: 'Contanti' },
    { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' },
    { v: 'assegno', l: 'Assegno' },
    { v: 'altro', l: 'Altro' },
];

// Acquisto una tantum: la segreteria seleziona un alunno e registra al volo
// un acquisto della categoria scelta (Gita, Divisa, Materiale…). Può marcarlo
// "già pagato" (crea l'incasso) e poi inviare la fattura, tutto dal popup.
//
// ACCESSIBILITÀ (a11y #5 e #3 del collaudo 2026-08-02). Con questa finestra si
// mette a carico di una famiglia una somma di denaro, e montata in jsdom axe
// restituiva `label` ×3, `select-name` ×1 e `button-name` ×1, tutte CRITICAL:
// descrizione, importo, data e metodo si annunciavano «casella di testo»,
// «campo numerico», «menu». Le etichette a schermo c'erano — erano `<label>`
// senza `htmlFor`, cioè un legame soltanto visivo — e il contenitore non era un
// dialogo: niente Esc, niente focus-trap, sfondo raggiungibile col Tab.
//
// Niente di tutto questo è stato inventato qui: il gemello
// `RegistraIncassoModal`, nella stessa cartella e sullo stesso pagamento, usa
// già la primitiva `@/components/ui/Modal` e gli `htmlFor`/`id`. La differenza
// fra i due era casuale, non progettata.
//
// CONTRASTI, misurati sui valori dei token (sRGB, WCAG 2.x). Gli hex non si
// scrivono qui: vivono in `globals.css`, e un lock di quest'area li vieta.
//   · etichette e riga «classe · categoria» erano `kidville-muted` su bianco =
//     2,51:1 → `kidville-sub` = 6,46:1. `muted` è il token che il design system
//     dichiara DECORATIVO: un'etichetta che dice cosa scrivere in un campo non è
//     una decorazione (stessa sostituzione già fatta in `AvvisoForm`);
//   · il ✕ era anch'esso a 2,51:1 ed è un COMPONENTE d'interfaccia (1.4.11,
//     soglia 3:1), oltre a misurare 20×20 contro i 24×24 minimi di 2.5.8: ora
//     `sub` e bersaglio 44×44, con il glifo fermo a 20;
//   · gli avvisi «contanti» e «possibile duplicato» erano `kidville-warn` su
//     `warn-soft` = 2,74:1 → `warn-strong` sullo stesso fondo = 4,95:1;
//   · gli errori erano `kidville-error` su bianco = 4,23:1 con `text-xs`, sotto
//     i 4,5:1 di AA → `error-strong` = 5,62:1.
//
// L'animazione framer-motion di entrata è stata tolta, come nella migrazione
// gemella: la primitiva non ce l'ha, e quella scala/opacità era fra le
// animazioni JS che ignorano `prefers-reduced-motion` (la regola CSS globale
// azzera solo le transizioni CSS).
export function QuickAcquistoModal({ alunno, categoria, userId, scuolaId, onClose, onDone }: Props) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    // Un solo `useId()` per titolo e campi: gli id costanti scritti a mano
    // diventano ambigui nel momento in cui due istanze stanno nella stessa
    // pagina, e l'`htmlFor` finirebbe per etichettare il campo dell'altra.
    const uid = useId();
    const idTitolo = `${uid}-titolo`;
    const idDescrizione = `${uid}-descrizione`;
    const idImporto = `${uid}-importo`;
    const idData = `${uid}-data`;
    const idMetodo = `${uid}-metodo`;
    const [descrizione, setDescrizione] = useState(categoria.nome);
    const [importo, setImporto] = useState<number>(0);
    const [obbligatorio, setObbligatorio] = useState(false);
    const [acconti, setAcconti] = useState(false);
    const [rateizza, setRateizza] = useState(false);
    const [giaPagato, setGiaPagato] = useState(true);
    const [metodo, setMetodo] = useState('contanti');
    const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [creato, setCreato] = useState<{ id: string; fattura_stato?: string } | null>(null);
    // Anti-duplicato: al primo submit si controlla se esiste già un pagamento
    // gemello (stesso alunno+categoria, stesso importo, scadenza ±15gg); serve
    // una seconda conferma esplicita per procedere comunque.
    const [confermaDup, setConfermaDup] = useState<string | null>(null);

    const submit = async () => {
        if (!descrizione.trim()) { setError(t('quickErrDescrizione')); return; }
        if (!importo || importo <= 0) { setError(t('quickErrImporto')); return; }
        setSaving(true);
        setError(null);
        if (!confermaDup) {
            try {
                const r = await fetch(`/api/pagamenti?alunno_id=${alunno.id}&categoria_id=${categoria.id}`, { headers: { 'x-user-id': userId } });
                const j = await r.json();
                const SOGLIA_MS = 15 * 86_400_000;
                const dup = ((j?.data || []) as { importo: number; scadenza?: string | null; descrizione?: string }[]).find(
                    (p) => Number(p.importo) === Number(importo) && p.scadenza && Math.abs(Date.parse(p.scadenza) - Date.parse(data)) <= SOGLIA_MS
                );
                if (dup) {
                    setConfermaDup(`${t('quickDupPre')} "${dup.descrizione}" ${t('quickDupImporto')} ${formatEuro(dup.importo)} ${t('quickDupScadenza')} ${dup.scadenza ? f.dataBreve(dup.scadenza) : '—'}.`);
                    setSaving(false);
                    return;
                }
            } catch {
                // controllo best-effort: se fallisce non blocca la registrazione
            }
        }
        try {
            const res = await fetch('/api/pagamenti', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    alunno_id: alunno.id,
                    scuola_id: scuolaId,
                    descrizione: descrizione.trim(),
                    importo,
                    scadenza: data,
                    categoria_id: categoria.id,
                    tipo: 'singolo',
                    obbligatorio,
                }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || t('quickErrCreazione')); return; }
            const pagamento = json.data;

            if (giaPagato) {
                const incRes = await fetch('/api/pagamenti/incassi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify({
                        pagamento_id: pagamento.id,
                        importo,
                        data_incasso: data,
                        metodo,
                        spill: false,
                    }),
                });
                if (!incRes.ok) {
                    const j = await incRes.json().catch(() => ({}));
                    setError(j.error || t('quickErrIncasso'));
                    setCreato({ id: pagamento.id, fattura_stato: pagamento.fattura_stato });
                    return;
                }
            }
            setCreato({ id: pagamento.id, fattura_stato: pagamento.fattura_stato });
        } catch {
            setError(t('quickErrRete'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            {/* UNA FINESTRA PER VOLTA. `RateizzaModal` è ancora un overlay scritto
                a mano (`z-50`) e non è un dialogo: tenerlo aperto SOTTO la
                primitiva (`z-[120]`) lo seppellirebbe, e il focus-trap della
                finestra sopra gli ruberebbe ogni Tab — cioè lo renderebbe
                inutilizzabile da tastiera. Finché il piano rate non migra alla
                primitiva, l'acquisto si chiude e riappare quando quello si chiude. */}
            <Modal
                open={!rateizza}
                onClose={onClose}
                title={t('quickNuovoAcquisto')}
                labelledBy={idTitolo}
                className={MODAL_CARD}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 id={idTitolo} className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <ShoppingBag size={18} aria-hidden="true" /> {t('quickNuovoAcquisto')}
                    </h3>
                    {/* Bersaglio 44×44 col glifo fermo a 20: si allarga l'area, non
                        il disegno. La compensazione è metà della crescita — (44−20)/2
                        = 12px, cioè `-mr-3`. */}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('quickChiudi')}
                        className="-mr-3 min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded-xl text-kidville-sub transition-colors hover:text-kidville-ink"
                    >
                        <X size={20} aria-hidden="true" />
                    </button>
                </div>

                <div className="bg-kidville-cream/60 rounded-card p-3 mb-4">
                    <p className="font-maven text-sm text-kidville-green font-bold">
                        {alunno.nome} {alunno.cognome}
                    </p>
                    <p className="font-maven text-xs text-kidville-sub">
                        {alunno.classe_sezione || '—'} · {t('quickCategoria')} {categoria.nome}
                    </p>
                </div>

                {/* Regione viva PERSISTENTE per l'esito: esiste già, vuota, prima
                    che l'acquisto parta. Uno screen reader annuncia i cambiamenti
                    di una regione che c'era prima — se nascesse insieme al testo,
                    la conferma potrebbe non essere letta.
                    L'eventuale errore dell'incasso vive DENTRO questa regione e
                    non porta un `role="alert"` suo: sarebbe una seconda live
                    region annidata, cioè lo stesso messaggio annunciato due volte. */}
                <div role="status">
                    {creato && (
                        <div className="text-center py-4">
                            <span className="mx-auto mb-2 flex w-10 justify-center text-kidville-green"><SaveCheck size={40} /></span>
                            <p className="font-maven text-sm text-kidville-green font-bold mb-1">
                                {t('quickAcquistoRegistrato')}{giaPagato ? ` ${t('quickESaldato')}` : ''}.
                            </p>
                            {error && <p className="font-maven text-xs text-kidville-error-strong mb-3">{error}</p>}
                            {giaPagato && (
                                <div className="flex justify-center my-3">
                                    <FatturaButton pagamentoId={creato.id} userId={userId} fatturaStato={creato.fattura_stato} descrizione={descrizione} />
                                </div>
                            )}
                            <button type="button" onClick={onDone} className={cx(BTN_PRIMARY, 'mt-2 w-full')}>
                                {t('quickChiudi')}
                            </button>
                        </div>
                    )}
                </div>

                {!creato && (
                    <>
                        <div className="space-y-3">
                            <div>
                                <label htmlFor={idDescrizione} className="font-maven text-xs text-kidville-sub mb-1 block">{t('quickDescrizione')}</label>
                                <input id={idDescrizione} type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)}
                                    className={INPUT} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor={idImporto} className="font-maven text-xs text-kidville-sub mb-1 block">{t('quickImportoLabel')}</label>
                                    <input id={idImporto} type="number" min={0} step="0.01" value={importo || ''}
                                        onChange={(e) => { setImporto(e.target.value === '' ? 0 : Number(e.target.value)); setConfermaDup(null); }}
                                        className={INPUT} />
                                </div>
                                <div>
                                    <label htmlFor={idData} className="font-maven text-xs text-kidville-sub mb-1 block">{t('quickData')}</label>
                                    <input id={idData} type="date" value={data} onChange={(e) => { setData(e.target.value); setConfermaDup(null); }}
                                        className={INPUT} />
                                </div>
                            </div>

                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={obbligatorio} onChange={(e) => setObbligatorio(e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                <span className="font-maven text-xs text-kidville-green">{t('quickObbligatorio')}</span>
                            </label>

                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={acconti} onChange={(e) => { setAcconti(e.target.checked); if (e.target.checked) setGiaPagato(false); }}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                <span className="font-maven text-xs text-kidville-green">{t('quickDividiAcconti')}</span>
                            </label>

                            {!acconti && (
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={giaPagato} onChange={(e) => setGiaPagato(e.target.checked)}
                                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                    <span className="font-maven text-xs text-kidville-green">{t('quickGiaPagato')}</span>
                                </label>
                            )}

                            {!acconti && giaPagato && (
                                <div>
                                    <label htmlFor={idMetodo} className="font-maven text-xs text-kidville-sub mb-1 block">{t('quickMetodo')}</label>
                                    <select id={idMetodo} value={metodo} onChange={(e) => setMetodo(e.target.value)}
                                        className={SELECT}>
                                        {METODI.map((m) => <option key={m.v} value={m.v}>{t(`quickMetodo_${m.v}`)}</option>)}
                                    </select>
                                </div>
                            )}

                            {!acconti && giaPagato && metodo === 'contanti' && (
                                <p className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn-strong">
                                    {t('quickWarnContanti')}
                                </p>
                            )}

                            {/* Il possibile duplicato BLOCCA la registrazione e chiede
                                una seconda conferma: è un messaggio che va annunciato
                                subito, non un'informazione di contorno. */}
                            {confermaDup && (
                                <p role="alert" className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn-strong">
                                    {confermaDup}
                                </p>
                            )}

                            {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
                        </div>

                        <div className="flex gap-2 mt-5">
                            <button type="button" onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>
                                {t('quickAnnulla')}
                            </button>
                            {acconti ? (
                                <button type="button" onClick={() => {
                                    if (!descrizione.trim()) { setError(t('quickErrDescrizione')); return; }
                                    if (!importo || importo <= 0) { setError(t('quickErrImporto')); return; }
                                    setError(null); setRateizza(true);
                                }}
                                    className={cx(BTN_PRIMARY, 'flex-1')}>
                                    {t('quickConfiguraAcconti')}
                                </button>
                            ) : (
                                <button type="button" onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>
                                    {saving ? t('quickSalvataggio') : confermaDup ? t('quickConfermaComunque') : t('quickRegistraAcquisto')}
                                </button>
                            )}
                        </div>
                    </>
                )}
            </Modal>

            {rateizza && (
                <RateizzaModal
                    alunno={alunno}
                    userId={userId}
                    scuolaId={scuolaId}
                    categoriaId={categoria.id}
                    descrizione={descrizione}
                    importoTotale={importo}
                    obbligatorio={obbligatorio}
                    onClose={() => setRateizza(false)}
                    onDone={() => { setRateizza(false); onDone(); }}
                />
            )}
        </>
    );
}
