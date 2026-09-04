'use client';

import { useMemo, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { FileText, Download, Loader2, X, Pencil } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import {
    CAMPI_CESSIONARIO,
    validaCessionario,
    type CampoCessionario,
    type ErroriCessionario,
} from '@/lib/fatturazione/cessionario';
import type { IntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto';
import type { MotivoAbbinamentoOrdinante } from '@/lib/pagamenti/ordinante-genitore';
/**
 * ⚠️ IL BLOCCO DELL'INTESTATARIO SI IMPORTA, NON SI RICOPIA.
 *
 * Qui c'erano tre interfacce scritte a mano che ripetevano la risposta della
 * route. Quando il backend ha spostato `alunno` DENTRO il blocco, niente si è
 * rotto: `tsc` non poteva accorgersene (la copia locale lo dichiarava altrove) e
 * i test nemmeno (il loro mock ripeteva la stessa copia). In produzione la
 * casella «ricorda sulla scheda» sarebbe semplicemente sparita, e la PATCH non
 * sarebbe mai partita — con ventuno test verdi.
 *
 * `import type` sparisce a compilazione: non porta niente nel bundle del browser,
 * e lega questo dialogo al contratto che il server produce davvero.
 */
import type { CandidatoIntestatario, IntestatarioAnteprima } from '@/lib/aruba/intestatario-pagamento';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

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
    /** Assente su una risposta più vecchia: il modale funziona lo stesso, senza selettore. */
    intestatario?: IntestatarioAnteprima | null;
}

/**
 * I campi che si digitano quando l'intestatario NON è in archivio.
 *
 * I sei obbligatori NON sono riscritti: arrivano da `CAMPI_CESSIONARIO`, la
 * stessa lista su cui `validaCessionario` costruisce il verdetto. Se domani il
 * tracciato ne pretendesse un settimo, `CampoAltro` cambierebbe e `tsc`
 * romperebbe la mappa delle etichette qui sotto — invece di lasciare a schermo
 * un campo senza nome che nessuno compila.
 *
 * Provincia e civico sono i due FACOLTATIVI del tracciato: stanno fuori da
 * `CAMPI_CESSIONARIO` proprio perché la loro assenza non è mai un errore.
 */
const CAMPI_ALTRO = [...CAMPI_CESSIONARIO, 'provincia', 'civico'] as const;
type CampoAltro = CampoCessionario | 'provincia' | 'civico';
type DatiAltro = Record<CampoAltro, string>;

const ALTRO_VUOTO: DatiAltro = {
    codice_fiscale: '', nome: '', cognome: '', indirizzo: '', cap: '', comune: '', provincia: '', civico: '',
};

const CHIAVE_ETICHETTA: Record<CampoAltro, string> = {
    codice_fiscale: 'fatBtn_int_campo_codice_fiscale',
    nome: 'fatBtn_int_campo_nome',
    cognome: 'fatBtn_int_campo_cognome',
    indirizzo: 'fatBtn_int_campo_indirizzo',
    cap: 'fatBtn_int_campo_cap',
    comune: 'fatBtn_int_campo_comune',
    provincia: 'fatBtn_int_campo_provincia',
    civico: 'fatBtn_int_campo_civico',
};

/**
 * Una frase per ciascuno dei quattro motivi, e non è ridondanza.
 *
 * Con un messaggio solo, l'interfaccia avrebbe detto «è l'intestatario sulla
 * scheda del bambino» anche quando la scheda non c'entra niente — cioè avrebbe
 * mentito a chi sta per confermare un documento fiscale. Un motivo che non
 * conosciamo non produce nessuna frase e nessuna preselezione: una proposta muta
 * non si può né confermare né smentire.
 *
 * ⚠️ L'UNIONE È IMPORTATA, NON RICOPIATA. Con una copia locale dei quattro nomi,
 * un quinto motivo aggiunto in `ordinante-genitore.ts` non farebbe rompere niente:
 * `tsc` resta verde (misurato) e a schermo la proposta sparisce in silenzio —
 * l'operatore vedrebbe solo un selettore senza preselezione, senza sapere che ce
 * n'era una. Legato al tipo, quello stesso quinto motivo diventa un errore di
 * compilazione qui, dove va scritta la frase che lo spiega. `import type` sparisce
 * a compilazione, e quel modulo è puro comunque.
 */
const CHIAVE_MOTIVO: Record<MotivoAbbinamentoOrdinante, string> = {
    bonifico_esatto: 'fatBtn_int_proposta_bonifico_esatto',
    sottoinsieme_unico: 'fatBtn_int_proposta_sottoinsieme_unico',
    sottoinsieme_scheda: 'fatBtn_int_proposta_sottoinsieme_scheda',
    sottoinsieme_famiglia: 'fatBtn_int_proposta_sottoinsieme_famiglia',
};

/** Valore del selettore per «scrivo io l'intestatario»: non è l'id di nessuno. */
const VALORE_ALTRO = '__altro__';

// Pulsante "Invia Fattura" (emissione reale Aruba/SDI). Prima di emettere apre un
// modale che MOSTRA la causale composta dal modello della sede e CHI riceverà il
// documento; personalizzare l'una o cambiare l'altro sono gesti in più, deliberati.
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
// ─── PERCHÉ SI SCEGLIE ANCHE L'INTESTATARIO ──────────────────────────────────
// Misurato in produzione il 2026-09-04: su 93 pagamenti saldati, 88 rispondevano
// «Intestatario fattura non impostato sull'anagrafica» e non emettevano niente —
// 579 alunni su 630 non hanno un intestatario risolvibile e i genitori marcati
// «intestatario di famiglia» sono DUE su 735. Il selettore non raffina: è ciò che
// sblocca l'emissione. Proprio per questo la proposta ricavata dall'ordinante del
// bonifico è una PRESELEZIONE e mai un invio: si preme «Emetti» comunque.
//
// Né la causale né l'intestatario sono ricalcolati qui: arrivano da
// `/api/pagamenti/fattura/anteprima`, che chiama gli stessi `componiCausalePagamento`
// e `determinaQuoteFatturazione` dell'emissione. Ricalcolarli nel browser vorrebbe
// dire far approvare un documento e spedirne un altro, su una cosa che si corregge
// solo con una nota di variazione.
export function FatturaButton({ pagamentoId, userId, fatturaStato, onEmessa }: Props) {
    const t = useTranslations('adminContabilita');
    const [stato, setStato] = useState(fatturaStato ?? 'non_richiesta');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
    const [erroreAnteprima, setErroreAnteprima] = useState<string | null>(null);
    const [personalizza, setPersonalizza] = useState(false);
    const [causale, setCausale] = useState('');
    const [intestatario, setIntestatario] = useState<IntestatarioAnteprima | null>(null);
    const [alunno, setAlunno] = useState<{ id: string; nome: string } | null>(null);
    /** `''` = nessuna scelta (decide la cascata del server, come sempre). */
    const [scelta, setScelta] = useState('');
    const [altro, setAltro] = useState<DatiAltro>(ALTRO_VUOTO);
    const [ricorda, setRicorda] = useState(false);
    /** L'esito dell'ULTIMA azione: emissione rifiutata, o scheda non aggiornata. */
    const [erroreAzione, setErroreAzione] = useState<string | null>(null);
    /** Emessa in questa sessione del modale: «Emetti» non si ripreme. */
    const [emessa, setEmessa] = useState(false);

    // L'anteprima si chiede all'apertura del modale, non al montaggio: in una tabella
    // di rette ci sono decine di questi pulsanti, e una GET a testa sarebbe una raffica
    // per una schermata che nessuno ha ancora deciso di usare.
    const apri = async () => {
        setOpen(true);
        setAnteprima(null);
        setErroreAnteprima(null);
        setPersonalizza(false);
        setCausale('');
        setIntestatario(null);
        setAlunno(null);
        setScelta('');
        setAltro(ALTRO_VUOTO);
        setRicorda(false);
        setErroreAzione(null);
        setEmessa(false);
        try {
            const res = await fetch(`/api/pagamenti/fattura/anteprima?pagamento_id=${pagamentoId}&userId=${userId}`, {
                headers: { 'x-user-id': userId },
            });
            const j = await res.json();
            if (!res.ok || !j?.data?.causale) {
                setErroreAnteprima(messaggioDaCorpo(j, t('fatBtn_anteprima_errore')));
                return;
            }
            const dati = j.data as Anteprima;
            setAnteprima(dati);
            setCausale(String(dati.causale));
            setIntestatario(dati.intestatario ?? null);
            setAlunno(dati.intestatario?.alunno ?? null);

            // ⚠️ NESSUN `?? candidati[0]`. Se l'id proposto non è fra i candidati
            // letti, un ripiego sul primo intesterebbe la fattura alla persona
            // sbagliata in SILENZIO: si preferisce nessuna preselezione.
            const p = dati.intestatario?.proposta;
            const propostoEsiste = !!p && (dati.intestatario?.candidati ?? []).some((c) => c.adult_id === p.adult_id);
            if (p && propostoEsiste && CHIAVE_MOTIVO[p.motivo] && (dati.intestatario?.ordinante ?? '').trim()) {
                setScelta(p.adult_id);
            }
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

    const scelto = intestatario && !intestatario.ripartito
        ? intestatario.candidati.find((c) => c.adult_id === scelta) ?? null
        : null;
    const erroriAltro = useMemo(() => validaCessionario(altro), [altro]);
    const digitando = !!intestatario && !intestatario.ripartito && scelta === VALORE_ALTRO;
    const altroIncompleto = digitando && Object.keys(erroriAltro).length > 0;
    const sceltoNonFatturabile = !!scelto && !scelto.fatturabile;

    /** I campi guasti, nominati come li nomina il server: stessa lista, stesso ordine. */
    const elencoCampi = (errori: ErroriCessionario): string =>
        CAMPI_CESSIONARIO
            .filter((c) => errori[c] !== undefined)
            .map((c) => {
                const etichetta = t(CHIAVE_ETICHETTA[c]);
                return errori[c] === 'formato' ? `${etichetta} (${t('fatBtn_int_campo_formato')})` : etichetta;
            })
            .join(', ');

    const avvisoIntestatario = sceltoNonFatturabile && scelto
        ? t('fatBtn_int_non_fatturabile', { chi: scelto.nome, campi: elencoCampi(scelto.errori) })
        : altroIncompleto
            ? t('fatBtn_int_altro_incompleto', { campi: elencoCampi(erroriAltro) })
            : null;

    /**
     * Che cosa viaggia nel campo `intestatario` della POST.
     *
     * `undefined` = il corpo di sempre, e la cascata del server decide da sola: è
     * il comportamento su cui contano i sei punti in cui questo pulsante è montato
     * e i test che li coprono.
     *
     * Su un pagamento RIPARTITO non si manda mai niente: il server rifiuta con un
     * 409 comunque, ma l'interfaccia non deve nemmeno proporlo — con i genitori
     * separati la ripartizione esiste perché ciascuno riceva un documento per la
     * propria quota, e un documento unico cancella la detrazione dell'altro.
     */
    const intestatarioDaSpedire = (): IntestatarioScelto | undefined => {
        if (!intestatario || intestatario.ripartito || scelta === '') return undefined;
        if (scelta !== VALORE_ALTRO) return { tipo: 'adult', adult_id: scelta };
        const v = (campo: CampoAltro) => altro[campo].trim();
        return {
            tipo: 'persona',
            codice_fiscale: v('codice_fiscale'),
            nome: v('nome'),
            cognome: v('cognome'),
            indirizzo: v('indirizzo'),
            cap: v('cap'),
            comune: v('comune'),
            ...(v('provincia') ? { provincia: v('provincia') } : {}),
            ...(v('civico') ? { numero_civico: v('civico') } : {}),
        };
    };

    /**
     * «Ricorda sulla scheda», e il perché di DOPO.
     *
     * Si scrive `alunni.intestatario_fatture` solo a emissione riuscita: prima
     * vorrebbe dire che una fattura rifiutata da Aruba — o fermata da un gate —
     * lascia comunque dietro di sé un intestatario nuovo su tutte le rette future
     * del bambino, deciso da nessuno. La forma dei dati è quella condivisa col
     * backend (`tipo: 'altro'`, `dati.cf`, `dati.civico`): non se ne inventa una
     * seconda, o la scheda direbbe una cosa e l'emissione un'altra.
     *
     * Ritorna `false` se non si è salvato: il chiamante lo trasforma in un avviso
     * a schermo. La fattura, a quel punto, è già uscita — e va detto.
     */
    const ricordaSullaScheda = async (): Promise<boolean> => {
        if (!ricorda || !digitando || !alunno?.id) return true;
        const v = (campo: CampoAltro) => altro[campo].trim();
        const dati: Record<string, string> = {
            nome: v('nome'), cognome: v('cognome'), cf: v('codice_fiscale'),
            indirizzo: v('indirizzo'), cap: v('cap'), comune: v('comune'),
        };
        if (v('provincia')) dati.provincia = v('provincia');
        if (v('civico')) dati.civico = v('civico');
        try {
            const res = await fetch('/api/admin/students', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ id: alunno.id, intestatario_fatture: { tipo: 'altro', dati } }),
            });
            return res.ok;
        } catch {
            // Non è un `catch` muto: l'esito `false` diventa la riga rossa che dice
            // «la fattura è uscita, la scheda no». Ingoiarlo qui lascerebbe credere
            // di aver impostato un intestatario che non è stato salvato.
            return false;
        }
    };

    const emettiBloccato = busy || !anteprima || emessa || sceltoNonFatturabile || altroIncompleto;

    const emetti = async () => {
        if (emettiBloccato) return;
        setBusy(true);
        setErroreAzione(null);
        try {
            const daSpedire = intestatarioDaSpedire();
            const res = await fetch('/api/pagamenti/fattura', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    pagamento_id: pagamentoId,
                    causale: causaleDaSpedire(),
                    ...(daSpedire ? { intestatario: daSpedire } : {}),
                }),
            });
            const j = await res.json();
            if (!res.ok) {
                // Prima qui c'era un `alert()` del browser: un 409 che spiega una regola
                // fiscale — «l'intestatario di una fattura emessa si cambia solo con una
                // nota di variazione» — dentro una finestrella di sistema non si legge,
                // non si copia e non si traduce. `messaggioDaCorpo` porta il testo del
                // `codice` nella lingua dell'interfaccia.
                setStato(j?.data?.fattura_stato ?? 'scartata');
                setErroreAzione(messaggioDaCorpo(j, t('fatBtn_err_emissione')));
                return;
            }
            setStato(j?.data?.fattura_stato ?? 'in_attesa');
            setEmessa(true);
            if (!(await ricordaSullaScheda())) {
                setErroreAzione(t('fatBtn_int_ricorda_errore'));
                return;
            }
            setOpen(false);
            onEmessa?.();
        } finally { setBusy(false); }
    };

    const quotaUnica = intestatario && !intestatario.ripartito && intestatario.quote.length === 1
        ? intestatario.quote[0]
        : null;

    const proposta = intestatario?.proposta ?? null;
    const propostoNome = proposta ? intestatario?.candidati.find((c) => c.adult_id === proposta.adult_id)?.nome : undefined;
    const ordinante = (intestatario?.ordinante ?? '').trim();
    const chiaveMotivo = proposta ? CHIAVE_MOTIVO[proposta.motivo] : undefined;
    const spiegazioneProposta = chiaveMotivo && propostoNome && ordinante
        ? `${t(chiaveMotivo, { ordinante, nome: propostoNome })} ${t('fatBtn_int_proposta_conferma')}`
        : null;

    const etichettaCandidato = (c: CandidatoIntestatario): string => {
        const chi = c.relazione ? t('fatBtn_int_opzione_relazione', { nome: c.nome, relazione: c.relazione }) : c.nome;
        return c.fatturabile ? chi : t('fatBtn_int_opzione_incompleta', { chi, campi: elencoCampi(c.errori) });
    };

    const trigger = stato === 'emessa'
        ? <EmessaLinks pagamentoId={pagamentoId} userId={userId} />
        : stato === 'in_attesa'
            ? (
                <Badge tone="warn" title={t('fatBtn_attesa_title')}>
                    <Loader2 size={12} className="animate-spin" /> {t('fatBtn_attesa_sdi')}
                </Badge>
            )
            : (
                <button onClick={apri}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-kidville-line text-kidville-muted text-xs font-bold transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <FileText size={12} />
                    {stato === 'scartata' ? t('fatBtn_riprova') : t('fatBtn_invia')}
                </button>
            );

    return (
        <>
            {trigger}

            {/* Il modale NON è dentro il ramo dello stato: dopo un'emissione riuscita
                `stato` diventa «in attesa SDI», e se il pannello vivesse lì dentro
                sparirebbe dallo schermo portandosi via l'avviso che dice se la scheda
                del bambino è stata aggiornata o no. */}
            {open && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-kidville-ink/40 p-4" onClick={() => setOpen(false)}>
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        className={cx(MODAL_CARD, 'max-h-[90vh] overflow-y-auto')}
                        style={{ boxShadow: MODAL_SHADOW }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                                <FileText size={18} /> {t('fatBtn_emetti_titolo')}
                            </h3>
                            <button onClick={() => setOpen(false)} aria-label={t('fatBtn_chiudi')} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                        </div>

                        {/* CHI riceve il documento sta SOPRA la causale: fra le due cose,
                            quella che non si corregge senza una nota di variazione è
                            l'intestatario. */}
                        {intestatario && (intestatario.ripartito ? (
                            <div className="mb-4">
                                <p className="font-barlow font-bold text-xs uppercase text-kidville-green">
                                    {t('fatBtn_int_ripartito_titolo')}
                                </p>
                                <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('fatBtn_int_quote_titolo')}</p>
                                <ul className="mt-1 rounded-input border-[1.5px] border-kidville-line bg-kidville-cream/50 p-2">
                                    {intestatario.quote.map((q, i) => (
                                        <li key={`${q.adult_id ?? 'digitato'}-${i}`} className="flex items-center justify-between gap-2 py-0.5">
                                            <span className="font-maven text-xs text-kidville-ink">
                                                {q.nome || q.label}{q.nome && q.label ? ` — ${q.label}` : ''}
                                            </span>
                                            <span className="font-maven text-xs font-bold text-kidville-ink">{formatEuro(q.importo)}</span>
                                        </li>
                                    ))}
                                </ul>
                                <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('fatBtn_int_ripartito_spiega')}</p>
                            </div>
                        ) : (
                            <div className="mb-4">
                                {spiegazioneProposta && (
                                    <p data-testid="intestatario-proposta" className="font-maven text-[11px] text-kidville-sub mb-1">
                                        {spiegazioneProposta}
                                    </p>
                                )}
                                <label htmlFor={`intestatario-${pagamentoId}`} className="font-maven text-xs text-kidville-sub mb-1 block">
                                    {t('fatBtn_int_label')}
                                </label>
                                <select
                                    id={`intestatario-${pagamentoId}`}
                                    value={scelta}
                                    onChange={(e) => {
                                        setScelta(e.target.value);
                                        setErroreAzione(null);
                                        // La casella «ricorda» vale solo per l'intestatario digitato:
                                        // lasciarla accesa uscendo da «Altro» sarebbe un consenso
                                        // raccolto per una cosa e speso per un'altra.
                                        if (e.target.value !== VALORE_ALTRO) setRicorda(false);
                                    }}
                                    className={SELECT}
                                >
                                    <option value="">
                                        {quotaUnica?.nome ? t('fatBtn_int_anagrafica', { nome: quotaUnica.nome }) : t('fatBtn_int_scegli')}
                                    </option>
                                    {/* I NON fatturabili restano in elenco, col motivo accanto: in 3
                                        casi su 89 nessun candidato lo è, e una tendina vuota senza
                                        spiegazione manda a cercare un guasto che non esiste. */}
                                    {intestatario.candidati.map((c) => (
                                        <option key={c.adult_id} value={c.adult_id}>{etichettaCandidato(c)}</option>
                                    ))}
                                    <option value={VALORE_ALTRO}>{t('fatBtn_int_altro')}</option>
                                </select>

                                {digitando && (
                                    <div className="mt-2 rounded-input border-[1.5px] border-kidville-line p-2">
                                        <p className="font-barlow font-bold text-xs uppercase text-kidville-green mb-1">
                                            {t('fatBtn_int_altro_titolo')}
                                        </p>
                                        <div className="grid grid-cols-2 gap-2">
                                            {CAMPI_ALTRO.map((campo) => {
                                                const motivo = campo === 'provincia' || campo === 'civico'
                                                    ? undefined
                                                    : erroriAltro[campo as CampoCessionario];
                                                const idCampo = `int-${campo}-${pagamentoId}`;
                                                return (
                                                    <div key={campo}>
                                                        <label htmlFor={idCampo} className="font-maven text-[11px] text-kidville-sub mb-0.5 block">
                                                            {t(CHIAVE_ETICHETTA[campo])}
                                                        </label>
                                                        <input
                                                            id={idCampo}
                                                            value={altro[campo]}
                                                            onChange={(e) => {
                                                                const valore = e.target.value;
                                                                setAltro((precedente) => ({ ...precedente, [campo]: valore }));
                                                                setErroreAzione(null);
                                                            }}
                                                            aria-invalid={motivo !== undefined}
                                                            aria-describedby={motivo ? `${idCampo}-errore` : undefined}
                                                            className={INPUT}
                                                        />
                                                        {/* Il motivo accanto al campo, oltre che nel riepilogo:
                                                            chi corregge deve sapere QUALE casella riguarda.
                                                            Solo `formato`, di proposito: «manca» sotto sei
                                                            caselle appena aperte e ancora vuote è rumore che
                                                            insegna a non leggere gli avvisi. Il riepilogo li
                                                            nomina comunque, e «Emetti» resta bloccato. */}
                                                        <p id={`${idCampo}-errore`} className="font-maven text-[11px] text-kidville-error">
                                                            {motivo === 'formato' ? t('fatBtn_int_campo_formato') : ''}
                                                        </p>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {alunno?.id && (
                                            <>
                                                <label className="mt-2 flex items-start gap-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={ricorda}
                                                        onChange={(e) => setRicorda(e.target.checked)}
                                                        className="mt-0.5 accent-kidville-green"
                                                    />
                                                    <span className="font-maven text-xs text-kidville-ink">
                                                        {alunno.nome
                                                            ? t('fatBtn_int_ricorda', { bambino: alunno.nome })
                                                            : t('fatBtn_int_ricorda_generico')}
                                                    </span>
                                                </label>
                                                <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('fatBtn_int_ricorda_hint')}</p>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}

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

                        {/* UN SOLO `role="alert"`, montato sempre e vuoto quando non serve —
                            stessa ragione del `role="status"` qui sopra. Porta, in quest'ordine:
                            l'anteprima che non si è potuta leggere (blocca tutto), l'esito
                            dell'ultima azione, l'intestatario che non si può fatturare. */}
                        <p role="alert" className="font-maven text-xs text-kidville-error mt-1">
                            {erroreAnteprima ?? erroreAzione ?? avvisoIntestatario ?? ''}
                        </p>

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
                                irreversibile non è un ripiego accettabile. E non si riemette dopo
                                un'emissione riuscita: sarebbe una SECONDA fattura vera per la
                                stessa retta. */}
                            <button onClick={emetti} disabled={emettiBloccato} className={cx(BTN_PRIMARY, 'flex-1')}>
                                {busy ? <Loader2 size={14} className="animate-spin" /> : null} {t('fatBtn_emetti')}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </>
    );
}
