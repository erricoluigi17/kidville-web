'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { FileText, Loader2, X, Pencil } from 'lucide-react';
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
import { logClient, nomeErrore } from '@/lib/logging/client';
// ⚠️ `import type`, e NON un import di valori: `@/lib/fatture-coda/api` tira dentro
// `next/server`, il logger del server e il conteggio orario su Supabase. Un tipo sparisce
// a compilazione e lega questo pulsante al contratto vero della coda, senza bundle.
import type { CorpoAccoda, RispostaAccoda, StatoCodaAttivo } from '@/lib/fatture-coda/api';
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
import { CHIAVE_MOTIVO_PROPOSTA, propostaApplicabile } from '@/lib/pagamenti/proposta-intestatario';
import type { ScartoFattura } from '@/lib/pagamenti/scarico-fattura';
import { FatturaDocumenti } from '@/components/features/pagamenti/FatturaDocumenti';
import { CODA_FATTURE_HREF } from '@/components/features/admin/admin-nav-config';
import { azioneConCoda } from '@/lib/pagamenti/fatturazione-riga';

/**
 * PERCHÉ LO SDI HA RESPINTO IL DOCUMENTO — la sola resa, per i QUATTRO punti che la usano.
 *
 * ⚠️ Quattro, non due, e vale la pena contarli: tre sono dentro `EmessaLinks` e
 * si somigliano abbastanza da far credere che siano lo stesso. Il commento che
 * stava qui diceva «due» — erano due il giorno in cui è stato scritto — e un
 * numero sbagliato in cima a un componente è il modo in cui un ramo resta
 * scoperto senza che nessuno se ne accorga:
 *
 *   1. `ScartoLinks`               — `fattura_stato = 'scartata'`, sotto «Riprova»;
 *   2. `EmessaLinks`, 0 comandi    — «emessa» senza nessun PDF nel bucket;
 *   3. `EmessaLinks`, 1 comando    — accanto ad «Apri»/«Scarica» dell'altra quota;
 *   4. `EmessaLinks`, N comandi    — FUORI dal pannello a tendina, di proposito:
 *      chi non lo apre deve leggere il perché lo stesso.
 *
 * Tutti e quattro sono coperti da
 * `__tests__/components/motivo-scarto-solo-in-segreteria.test.tsx`, che verifica
 * anche che il riquadro non si renda DUE VOLTE sullo stesso schermo (il caso 4 a
 * tendina aperta).
 *
 * ─── IL DIFETTO CHE CHIUDE ──────────────────────────────────────────────────
 *
 * `fatture_emesse.sdi_scarto_motivo` era scritta in quattro punti e letta da
 * nessuna rotta. Alla segreteria arrivava la notifica «Fattura scartata dallo
 * SDI» e poi nessuna schermata diceva il perché: correggere e ritrasmettere
 * restava un tirare a indovinare su un documento fiscale.
 *
 * ─── PERCHÉ TESTO IN LINEA, E NON UN SUGGERIMENTO ───────────────────────────
 *
 * La tentazione, in una tabella di rette, è un `title=` o un pallino da
 * sorvolare. Un `title` non si apre da TASTIERA e la maggior parte dei lettori
 * di schermo non lo annuncia: l'unica frase che dice cosa correggere finirebbe
 * dietro un gesto che non tutti possono fare. Il riquadro sta nel flusso, si
 * legge senza premere niente, e proprio per questo NON è un `role="alert"`: non
 * è un aggiornamento che arriva mentre si guarda altrove, è il contenuto della
 * riga (e un `role` inserito nel DOM col testo già dentro spesso resta muto).
 *
 * ─── E NON SI TRONCA ────────────────────────────────────────────────────────
 *
 * «Con misura» vuol dire tipo piccolo e larghezza ferma, non testo tagliato: le
 * due prose misurate in produzione stanno in 46 e 60 caratteri, e accorciare
 * l'unica informazione che dice cosa sistemare sarebbe riaprire il difetto con
 * un'altra faccia.
 *
 * Il numero sezionale davanti al motivo non è ornamento: quando le quote sono
 * due (genitori separati) dice QUALE delle due è stata respinta, ed è anche il
 * modo in cui la fattura si nomina al telefono col commercialista.
 */
function MotiviScarto({ scarti }: { scarti: ScartoFattura[] }) {
    const t = useTranslations('adminContabilita');
    if (scarti.length === 0) return null;
    return (
        <div
            data-testid="fattura-scarto"
            className="mt-1 max-w-[22rem] rounded-input border-[1.5px] border-kidville-error/40 bg-kidville-error-soft px-2 py-1.5 text-left"
        >
            <p className="font-barlow font-bold text-[11px] uppercase text-kidville-error-strong">
                {t('fatBtn_scarto_titolo')}
            </p>
            <ul className="mt-0.5 space-y-0.5">
                {scarti.map((s) => (
                    <li key={s.id} className="font-maven text-[11px] text-kidville-error-strong break-words">
                        {t('fatBtn_scarto_voce', { numero: String(s.numero), motivo: s.motivo })}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/**
 * Il motivo accanto al pulsante «Riprova fattura».
 *
 * Esiste come componente suo perché l'elenco delle quote si chiede con un hook, e
 * gli hook non stanno dentro un ramo: il pulsante di ritrasmissione vive in un
 * ternario su `stato`. Una GET in più c'è solo sulle righe SCARTATE, che in
 * produzione sono poche — le righe «emessa» quell'elenco lo chiedevano già.
 */
function ScartoLinks({ pagamentoId, userId }: { pagamentoId: string; userId: string }) {
    return (
        <FatturaDocumenti
            pagamentoId={pagamentoId}
            userId={userId}
            aspetto="segreteria"
            renderScarti={(scarti) => <MotiviScarto scarti={scarti} />}
        />
    );
}

/**
 * I comandi della fattura, per la segreteria.
 *
 * ⚠️ IL FAST-PATH NON C'È PIÙ, ED È IL PUNTO DI QUESTO COMPONENTE. Qui c'era
 * `if (!fatture || fatture.length <= 1) return <a>Fattura</a>`: `fatture` è
 * `null` anche MENTRE STA CARICANDO, quindi quel ramo rendeva il link senza
 * sapere se dietro ci fosse un PDF. Le tre fasi ora vengono da
 * `useFattureScaricabili` (`@/lib/pagamenti/scarico-fattura`), che è lo stesso
 * motore della card del genitore: in caricamento non si rende NIENTE e non si
 * riserva spazio (in una tabella di rette uno scheletro per riga sarebbe una
 * pagina che lampeggia), senza PDF disponibili non si rende NIENTE, e solo con
 * almeno una riga verificata sul bucket compaiono i comandi.
 *
 * Due ancore e non una: «Apri» legge il documento a schermo, «Scarica» chiede
 * alla route l'`attachment`. Nessun `target="_blank"`, mai: nella WebView
 * dell'app `window.open` non apre niente e non lo dice.
 */
function EmessaLinks({ pagamentoId, userId }: { pagamentoId: string; userId: string }) {
    return (
        <FatturaDocumenti
            pagamentoId={pagamentoId}
            userId={userId}
            aspetto="segreteria"
            renderScarti={(scarti) => <MotiviScarto scarti={scarti} />}
        />
    );
}

/** L'esito di un accodamento, per chi monta il pulsante (D12). */
export type EsitoAccodamento = { accodata: 'nuova' | 'gia' };

interface Props {
    pagamentoId: string;
    userId: string;
    fatturaStato?: string;
    /** La voce ATTIVA della coda sul pagamento, dai dati della riga (D5): fotografia del caricamento. */
    codaStato?: StatoCodaAttivo | null;
    onEmessa?: (esito?: EsitoAccodamento) => void;
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
 * Le frasi dei motivi e la regola «questa proposta si può usare» vivono in
 * `@/lib/pagamenti/proposta-intestatario`, non qui: da quando anche il LOTTO
 * emette usando la proposta del bonifico, una copia locale vorrebbe dire due
 * regole che possono divergere su chi intestare un documento fiscale.
 *
 * Il `Record` là dentro è esaustivo sull'unione dei motivi: un quinto motivo
 * aggiunto in `ordinante-genitore.ts` resta un errore di compilazione, come prima.
 */
const CHIAVE_MOTIVO = CHIAVE_MOTIVO_PROPOSTA;

/** Valore del selettore per «scrivo io l'intestatario»: non è l'id di nessuno. */
const VALORE_ALTRO = '__altro__';

/** La route che accoda (nucleo coda fatture, §3). */
const URL_CODA = '/api/pagamenti/fattura/coda';

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
// bonifico è una PRESELEZIONE e mai un invio: si preme «Metti in coda» comunque.
//
// Né la causale né l'intestatario sono ricalcolati qui: arrivano da
// `/api/pagamenti/fattura/anteprima`, che chiama gli stessi `componiCausalePagamento`
// e `determinaQuoteFatturazione` dell'emissione. Ricalcolarli nel browser vorrebbe
// dire far approvare un documento e spedirne un altro, su una cosa che si corregge
// solo con una nota di variazione.
//
// ─── DAL 2026-09-23 «EMETTI» METTE IN CODA, IN TESTA ─────────────────────────
// (nucleo della coda fatture, `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md` §4)
// Il pulsante non chiama più `POST /api/pagamenti/fattura`: fa `POST …/fattura/coda`
// con UNA voce e `urgente: true`. La voce passa davanti al lotto, la route sveglia
// subito il lavoratore, e la fattura esce col motore del lotto — una sessione Aruba,
// il tetto orario, lo stop su 429/5xx — invece di una seconda strada che quei limiti
// non li vede. A schermo: «Messa in coda: parte entro pochi minuti».
//
// ─── DAL 2026-09-24 LA STRADA È UNA SOLA (consegna 2b, D1 e D5) ──────────────
// (`docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2b-rifiniture.md` §4.10)
// Anche l'intestatario scritto a mano («Altro», `tipo: 'persona'`) va in coda: il
// contratto lo accetta in un gesto di UNA voce e la POST lo valida con
// `validaCessionario` PRIMA di accodare (400 `INTESTATARIO_DIGITATO_INCOMPLETO`). La
// «ricorda sulla scheda» non è più una PATCH del browser: viaggia nella voce come
// `conferma_proposta: true`, e la scheda la scrive il lavoratore solo a emissione nuova
// riuscita. La route diretta `POST /api/pagamenti/fattura` resta, per decisione, ma
// dall'interfaccia non la chiama più nessuno.
//
// Con una voce ATTIVA sul pagamento (`codaStato`, dai dati della riga) il pulsante non
// c'è: un secondo accodamento tornerebbe «già in coda». Su «Errore in coda» al suo posto
// c'è il collegamento alla pagina «Coda fatture», dove la voce si toglie o si rimette. La
// regola è del motore (`azioneConCoda`, `@/lib/pagamenti/fatturazione-riga`): qui c'è
// solo la resa. Sparisce QUI DENTRO e non nel genitore, perché smontarlo lì porterebbe
// via la live region «Messa in coda» proprio quando il genitore aggiorna la riga (D12).
export function FatturaButton({ pagamentoId, userId, fatturaStato, codaStato, onEmessa }: Props) {
    const t = useTranslations('adminContabilita');
    // Dalla prop, a ogni resa: il suo setter lo usava solo la POST diretta, che da qui non
    // parte più. Così un genitore che ricarica la riga (D12) aggiorna anche il pulsante.
    const stato = fatturaStato ?? 'non_richiesta';
    // Letta dalla prop a ogni resa, MAI copiata in uno stato: è la fotografia del caricamento.
    const azione = azioneConCoda(codaStato);
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
    /** L'esito dell'ULTIMA azione: l'accodamento rifiutato. */
    const [erroreAzione, setErroreAzione] = useState<string | null>(null);
    /** Accodata in questa sessione del modale: «Metti in coda» non si ripreme. */
    const [emessa, setEmessa] = useState(false);
    /**
     * L'esito dell'accodamento: `nuova` = è entrata adesso, `gia` = la coda l'aveva già
     * (voce attiva sullo stesso pagamento, anche ferma in errore). Finché vale, al posto
     * del pulsante c'è la frase: un secondo «Invia fattura» non accoderebbe niente.
     */
    const [accodata, setAccodata] = useState<'nuova' | 'gia' | null>(null);

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

            // Le quattro condizioni (proposta presente · il proposto è fra i
            // candidati · il motivo lo sappiamo spiegare · l'ordinante non è vuoto)
            // stanno nel motore condiviso col lotto. Fra le quattro, la seconda è
            // quella che conta: senza, un ripiego su `candidati[0]` intesterebbe la
            // fattura alla persona sbagliata in SILENZIO.
            const usabile = propostaApplicabile(dati.intestatario);
            if (usabile) setScelta(usabile.adult_id);
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

    const emettiBloccato = busy || !anteprima || emessa || sceltoNonFatturabile || altroIncompleto;

    /**
     * ─── LA STRADA DI SEMPRE: in coda, in testa ─────────────────────────────────
     *
     * Una voce sola, `urgente: true`. La causale è quella di `causaleDaSpedire()` — la
     * correzione scritta a mano, oppure `null`, che per il lavoratore significa, come
     * per la POST diretta, TOGLIERE la correzione salvata. L'intestatario, se scelto, è
     * un adulto per id oppure la persona digitata a mano (D1).
     *
     * ⚠️ `conferma_proposta` è ciò che autorizza il lavoratore a SCRIVERE l'intestatario
     * sulla scheda del bambino (il nome è storico: nel lavoratore è `ricordaSullaScheda`,
     * T3). Per un ADULTO scelto dal selettore NON si manda, come prima: vale per QUESTO
     * documento e basta, e la scheda si cambia dalla scheda. Per la PERSONA digitata è la
     * casella «ricorda sulla scheda», e parte solo se è accesa e se l'anteprima sa di
     * quale bambino è la retta. La scrittura avviene nel lavoratore, a emissione nuova
     * riuscita: un documento rifiutato non lascia dietro nessuna modifica.
     *
     * ⚠️ `onEmessa` si chiama anche qui, pur non essendo ancora uscito niente, e porta
     * l'ESITO (D12): con `nuova` il genitore aggiorna la sola riga, con `gia` rilegge.
     */
    const mettiInCoda = async (intestatarioScelto?: IntestatarioScelto) => {
        const corpo: CorpoAccoda = {
            urgente: true,
            voci: [{
                pagamento_id: pagamentoId,
                causale: causaleDaSpedire(),
                ...(intestatarioScelto ? { intestatario: intestatarioScelto } : {}),
                ...(intestatarioScelto?.tipo === 'persona' && ricorda && alunno?.id ? { conferma_proposta: true } : {}),
            }],
        };
        let res: Response;
        let j: unknown;
        try {
            res = await fetch(URL_CODA, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify(corpo),
            });
            j = await res.json();
        } catch (err) {
            // Un `catch` che non logga è un bug (AGENTS.md, regola 6). Qui la risposta non
            // è arrivata o non si è letta: a schermo il rifiuto generico, e ripremere è
            // sicuro — una voce già in coda non si duplica (tornerebbe «già in coda»).
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `fattura-singola-accodamento-fallito: ${nomeErrore(err)}`,
                stato: 0,
            });
            setErroreAzione(t('fatBtn_err_emissione'));
            return;
        }
        if (!res.ok) {
            // Prima qui c'era un `alert()` del browser: un 409 che spiega una regola
            // fiscale dentro una finestrella di sistema non si legge, non si copia e non
            // si traduce. `messaggioDaCorpo` porta il testo del `codice` nella lingua
            // dell'interfaccia — compreso il 503 `CODA_FATTURE_NON_DISPONIBILE` del DB non
            // ancora migrato. ⚠️ Lo `stato` NON diventa «scartata»: un accodamento
            // rifiutato non è un documento respinto dallo SDI.
            setErroreAzione(messaggioDaCorpo(j, t('fatBtn_err_emissione')));
            return;
        }
        const r = j as Partial<RispostaAccoda> | null;
        const giaInCoda = (r?.accodate ?? 0) === 0 && Array.isArray(r?.gia_in_coda) && r.gia_in_coda.length > 0;
        setAccodata(giaInCoda ? 'gia' : 'nuova');
        setEmessa(true);
        setOpen(false);
        onEmessa?.({ accodata: giaInCoda ? 'gia' : 'nuova' });
    };

    const emetti = async () => {
        if (emettiBloccato) return;
        setBusy(true);
        setErroreAzione(null);
        try {
            await mettiInCoda(intestatarioDaSpedire());
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
                // Il riquadro del motivo sta SOTTO il pulsante che rimanda il
                // documento: chi legge «Riprova fattura» ha, nella stessa riga, la
                // ragione per cui la prima volta non è andata. Colonna e non riga
                // perché la prosa del provider è una frase, non un'etichetta.
                <div className="inline-flex flex-col items-start gap-1">
                    {accodata === null && azione === 'invia' && (
                        <button onClick={apri}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-kidville-line text-kidville-muted text-xs font-bold transition-colors hover:border-kidville-green hover:text-kidville-green">
                            <FileText size={12} />
                            {stato === 'scartata' ? t('fatBtn_riprova') : t('fatBtn_invia')}
                        </button>
                    )}
                    {/* «Errore in coda» (D5): la voce si toglie o si rimette dalla pagina
                        «Coda fatture», non da qui. Con `in_coda`/`in_invio` non c'è niente:
                        il chip della riga dice già dov'è la fattura. */}
                    {azione === 'vai_alla_coda' && (
                        <Link href={CODA_FATTURE_HREF}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-current text-kidville-error-strong text-xs font-bold underline-offset-2 hover:underline">
                            {t('fatBtn_vai_alla_coda')}
                        </Link>
                    )}
                    {/* ⚠️ «MESSA IN CODA» È UNA LIVE REGION MONTATA VUOTA E RIEMPITA DOPO.
                        Nasce (vuota) quando si apre il modale, e resta lo stesso nodo
                        quando il modale si chiude e la frase arriva: un `role="status"`
                        inserito col testo già dentro resta muto su NVDA e JAWS. Non è
                        montata su ogni riga di una tabella di rette: solo su quella in
                        cui qualcuno ha aperto il modale. */}
                    {(open || accodata !== null) && (
                        <span
                            role="status"
                            data-testid="fattura-accodata"
                            className={accodata !== null
                                ? 'inline-flex items-center rounded-pill bg-kidville-info-soft px-2 py-1 font-maven text-xs font-bold text-kidville-info-strong'
                                : undefined}
                        >
                            {accodata === 'nuova'
                                ? t('codaFatture.singola.messaInCoda')
                                : accodata === 'gia'
                                    ? t('codaFatture.singola.giaInCoda')
                                    : ''}
                        </span>
                    )}
                    {/* Solo sulle SCARTATE: su «non richiesta» non c'è nessuna fattura
                        di cui chiedere l'esito, e l'elenco sarebbe una GET per niente
                        su ogni riga di una tabella di rette. */}
                    {stato === 'scartata' && <ScartoLinks pagamentoId={pagamentoId} userId={userId} />}
                </div>
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
                                                            nomina comunque, e «Metti in coda» resta bloccato. */}
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
