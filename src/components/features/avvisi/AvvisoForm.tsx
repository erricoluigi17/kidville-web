import { useState, useRef, useId } from 'react';
import { useTranslations } from 'next-intl';
import { X, Send, Upload, Link, AlertTriangle, Check } from 'lucide-react';
import { Avviso } from './AvvisoCard';
import { Modal } from '@/components/ui/Modal';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Una classe destinataria, con la sua IDENTITÀ e la sua sede.
 *
 * Fino al 2026-07-31 qui passava `string[]`: i soli NOMI, deduplicati su tutte
 * le sedi attive. Con tre plessi «2 ANNI» esiste ad Aversa e a Cesa, e il nome
 * nudo non identifica più niente — né per la chiave di React, né per il server,
 * che dalla sede risolta cerca quella classe e non la trova (W2-B). `scuolaId`
 * è opzionale perché una sorgente può ancora non conoscerlo (`educator-sections`
 * restituisce i soli nomi finché W3-A non le dà l'identità): in quel caso la
 * sede non si dichiara e la risolve il server — che, se resta ambigua, risponde
 * 400, e adesso quel 400 si VEDE.
 */
export interface ClasseAvviso {
    id: string;
    nome: string;
    scuolaId?: string | null;
    scuolaNome?: string | null;
}

/** Il corpo consegnato al chiamante: `scuola_id` è parte del contratto, non un extra. */
export interface DatiAvviso {
    titolo: string;
    contenuto: string;
    tipo: string;
    target_scope: string;
    target_classes: string[];
    scadenza: string | null;
    attachment_url: string | null;
    /** Sede su cui si pubblica; `null` quando il chiamante non la conosce. */
    scuola_id: string | null;
}

/**
 * Esito dell'invio, visto dal modulo.
 *
 * Il piano di correzione lo chiamava `Promise<boolean>`; qui l'esito porta con
 * sé anche il MESSAGGIO, e non è un vezzo: questo modale copre l'intera pagina,
 * quindi un errore mostrato dalla pagina sotto non lo leggerebbe nessuno.
 * `ok: false` ha esattamente la semantica del `false` del piano — niente reset,
 * niente chiusura.
 */
export interface EsitoInvioAvviso {
    ok: boolean;
    errore?: string;
}

interface Props {
    open: boolean;
    onClose: () => void;
    onSubmit: (data: DatiAvviso) => Promise<EsitoInvioAvviso>;
    availableClasses?: ClasseAvviso[];
    initialAvviso?: Avviso | null;
    // Modalità docente (educator): niente destinatario «🌐 Tutti», scope forzato
    // a 'classe' e classi selezionabili solo tra le proprie (availableClasses),
    // preselezionate. Chiude il footgun lato UI (il gate server resta la difesa).
    // Le pagine admin NON passano questa prop → comportamento invariato.
    soloClassiProprie?: boolean;
}

/**
 * Le classi di un segmento «Tipo»/«Destinatari», scelto o no.
 *
 * `min-w-0` non è cosmetico: i due bottoni sono figli `flex-1` di un `flex`, e
 * senza di lui `min-width:auto` impedisce di scendere sotto la parola più lunga
 * — a 320px con etichette più lunghe (una terza lingua, o l'inglese in qualche
 * variante) il secondo bottone sborda e viene tagliato. Misurato: 11px fuori.
 */
function classiSegmento(scelto: boolean): string {
    return `flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${
        scelto
            ? 'bg-kidville-green text-kidville-yellow shadow-sm'
            : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-cream-dark'
    }`;
}

/** Sedi distinte presenti fra le classi disponibili, nell'ordine in cui compaiono. */
function sediDi(classi: ClasseAvviso[]): { id: string; nome: string }[] {
    const viste = new Map<string, string>();
    for (const c of classi) {
        if (c.scuolaId && !viste.has(c.scuolaId)) viste.set(c.scuolaId, c.scuolaNome || '');
    }
    return [...viste].map(([id, nome]) => ({ id, nome }));
}

/**
 * Modulo «Nuovo avviso / Modifica avviso».
 *
 * ACCESSIBILITÀ (2026-07-31). Fino a oggi il contenitore era due `motion.div`
 * nudi: nessun `role="dialog"`, nessun `aria-modal`, nessun `aria-labelledby`,
 * nessun focus-trap. Per TalkBack la modale NON esisteva — l'albero di
 * accessibilità continuava a esporre solo la pagina sotto, e il bottone di
 * chiusura (32×32, senza `aria-label`) era muto e sotto il minimo touch.
 *
 * La correzione NON reinventa il dialogo: usa la primitiva `@/components/ui/Modal`,
 * che in questo repo è l'unico modo giusto di fare una modale (`role="dialog"` +
 * `aria-modal` + focus-trap ciclico + Esc + scroll-lock del body + ripristino del
 * focus al trigger, con lo stack per i dialoghi annidati). Il prezzo pagato è
 * l'animazione framer-motion di entrata/uscita, che la primitiva non ha: la
 * consistenza con gli altri quattordici modali già migrati vale più della dissolvenza.
 *
 * I CAMPI (2026-08-01). Il contenitore era a posto, il suo contenuto no: il
 * collaudo del 31/07 ha misurato dentro il dialogo cinque campi senza etichetta
 * associata (axe `label`, *critical*; il campo data senza NESSUN nome), quattro
 * toggle che dicevano di essere scelti col solo colore, le pillole delle classi
 * mute — con il rischio concreto di pubblicare alla classe sbagliata — e un
 * «togli allegato» di 12×12 px senza nome. Le regole applicate qui:
 *   · ogni `<label>` è legato al suo controllo con `htmlFor`/`id` derivati da
 *     `useId()` (per ISTANZA: due moduli montati insieme non si rubano gli id);
 *     il placeholder torna a essere un suggerimento, non l'etichetta;
 *   · dove i controlli sono bottoni e non campi, l'intestazione etichetta il
 *     GRUPPO (`role="group"` + `aria-labelledby`): un `<label>` senza controllo
 *     non etichetta niente;
 *   · lo stato scelto si dichiara con `aria-pressed` E con una spunta, perché il
 *     colore non basta a chi non lo distingue (WCAG 1.4.1);
 *   · il bottone d'invio NON usa `disabled`: il browser, disabilitando un
 *     elemento che ha il fuoco, lo sposta su `<body>` — misurato — e chi naviga
 *     da tastiera si ritrova fuori dal dialogo nell'istante in cui pubblica. Si
 *     usa `aria-disabled` + la guardia nell'handler, che è anche la difesa
 *     contro il doppio invio.
 *
 * PIANI (z-index) — la scala in uso nel repo, dal basso. I numeri sono scritti
 * NUDI di proposito: il lock `native-privacy-lock` cerca la forma `z-[…]` in
 * tutti i file di `src`, commenti compresi, e un esempio in un commento gli
 * risulterebbe indistinguibile da un piano vero.
 *   50        bottom-nav (parent · teacher · admin), drawer laterali, tendine
 *   60        toast e popover ancorati
 *   105 · 110 chrome dell'admin (topbar, sidebar, bottom-sheet «Menu»)
 *   120       MODALI (questa) — la primitiva `Modal`
 *   9999      gate biometrico, che deve stare sopra a tutto
 * Prima la modale stava a 50, cioè sullo STESSO piano della bottom-nav, che
 * infatti le copriva il bottone «Pubblica avviso»; poi a 80, che risolveva la
 * collisione in basso e lasciava intatta quella simmetrica in alto — la barra
 * verde del cockpit (105) le tagliava intestazione e ✕, e su iPhone il tocco
 * sulla chiusura finiva sulla campanella. Dal 2026-08-01 la primitiva sta a 120,
 * sopra TUTTO il chrome: questa scala è verificata contro il sorgente dal lock
 * `AvvisoForm-a11y-modale` (che ricava l'inventario delle superfici fisse invece
 * di elencarle a mano) e dal lock `AvvisoForm-campi-a11y`, che confronta il
 * numero qui scritto con quello che la primitiva usa davvero: un commento che
 * mente su questa gerarchia è già costato una giornata di collaudo.
 */
export function AvvisoForm({ open, onClose, onSubmit, availableClasses = [], initialAvviso = null, soloClassiProprie = false }: Props) {
    const t = useTranslations('teacherComunicazioni');
    // `shared` per la sola etichetta «Chiudi»: già presente in IT e EN, nessuna
    // chiave nuova da tradurre (stessa scelta di AdminMenuSheet).
    const ts = useTranslations('shared');
    // `adminAltro` per il solo nome accessibile di «togli allegato»: la stringa
    // esiste già, tradotta in entrambe le lingue, e descrive ESATTAMENTE lo
    // stesso gesto sullo stesso oggetto (il registro protocolli la usa per il
    // suo bottone di rimozione allegato). Preferita a una chiave nuova perché
    // i cataloghi sono in mano a un altro intervento in corso: una chiave
    // aggiunta qui verrebbe sovrascritta. Da spostare in `teacherComunicazioni`
    // quando i cataloghi tornano liberi — è debito dichiarato, non una svista.
    const tAllegato = useTranslations('adminAltro');
    // Id stabile e unico per istanza: è il bersaglio di `aria-labelledby`.
    const titoloId = useId();
    // Un solo `useId()` per tutti i campi: l'alternativa (id costanti scritti a
    // mano, come l'`avviso-sede` di ieri) rende ambigui gli `htmlFor` nel momento
    // in cui due istanze del modulo stanno nella stessa pagina — ed è proprio
    // quello che succede quando una modale ne apre un'altra.
    const uid = useId();
    const idSede = `${uid}-sede`;
    const idTitolo = `${uid}-titolo`;
    const idContenuto = `${uid}-contenuto`;
    const idTipo = `${uid}-tipo`;
    const idDestinatari = `${uid}-destinatari`;
    const idClassi = `${uid}-classi`;
    const idScadenza = `${uid}-scadenza`;
    const idAllegato = `${uid}-allegato`;
    const idLink = `${uid}-link`;
    const [titolo, setTitolo] = useState('');
    const [contenuto, setContenuto] = useState('');
    const [tipo, setTipo] = useState<'presa_visione' | 'adesione'>('presa_visione');
    const [scope, setScope] = useState<'globale' | 'classe'>('globale');
    const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
    const [scadenza, setScadenza] = useState('');
    const [attachmentUrl, setAttachmentUrl] = useState(''); // File URL
    const [linkUrl, setLinkUrl] = useState(''); // External Link
    const [fileUploading, setFileUploading] = useState(false);
    const [fileName, setFileName] = useState('');
    // Link FIRMATO all'anteprima, restituito dall'upload e finora buttato via: il
    // bucket è privato, quindi è l'unico modo di riaprire l'allegato appena
    // caricato senza uscire dal modulo. Non si archivia (scade) e non vale per un
    // avviso già salvato: lì l'anteprima si rifirma dalla pagina, non da qui.
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    // Il messaggio del server quando rifiuta. Prima non esisteva: il modale si
    // chiudeva lo stesso e l'operatore restava convinto di aver pubblicato.
    const [errore, setErrore] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Sede di pubblicazione ────────────────────────────────────────────────
    // In MODIFICA la sede non si tocca: l'avviso è già archiviato in un plesso e
    // la PUT non la cambia. In creazione: una sola sede ⇒ implicita (ma sempre
    // DICHIARATA nel payload); più d'una ⇒ la si sceglie, senza preselezione —
    // «la prima della lista» è esattamente il ripiego che ha archiviato a
    // Giugliano gli avvisi di Aversa.
    const sedi = sediDi(availableClasses);
    const inModifica = Boolean(initialAvviso);
    const sedeUnica = sedi.length === 1 ? sedi[0].id : '';
    const chiedeSede = !inModifica && sedi.length > 1;
    const [scuolaId, setScuolaId] = useState('');
    const sedeScelta = chiedeSede ? scuolaId : sedeUnica;

    // Classi mostrate: in creazione multi-sede solo quelle della sede scelta
    // (finché non la si sceglie, nessuna); altrimenti tutte quelle ricevute.
    const classiVisibili = chiedeSede
        ? availableClasses.filter((c) => c.scuolaId === scuolaId)
        : availableClasses;

    // Gestione precompilazione in caso di modifica
    // (adjust-state-during-render, prior art: TaskForm.tsx)
    const [prevOpen, setPrevOpen] = useState(false);
    const [prevAvviso, setPrevAvviso] = useState<Avviso | null>(initialAvviso);
    if (open !== prevOpen || initialAvviso !== prevAvviso) {
        setPrevOpen(open);
        setPrevAvviso(initialAvviso);
        if (open) {
            // Un errore del tentativo precedente non deve sopravvivere alla
            // riapertura del modulo: accuserebbe l'operatore di un guasto vecchio.
            setErrore('');
            setScuolaId('');
            if (initialAvviso) {
                setTitolo(initialAvviso.titolo);
                setContenuto(initialAvviso.contenuto);
                setTipo(initialAvviso.tipo as 'presa_visione' | 'adesione');
                // Docente: scope sempre 'classe'; se l'avviso non aveva classi
                // (era globale) preseleziona le proprie.
                const initClasses = initialAvviso.target_classes || [];
                setScope(soloClassiProprie ? 'classe' : (initialAvviso.target_scope as 'globale' | 'classe'));
                setSelectedClasses(
                    soloClassiProprie && initClasses.length === 0
                        ? availableClasses.map((c) => c.nome)
                        : initClasses,
                );
                setScadenza(initialAvviso.scadenza || '');
                
                // Decodifica allegato (JSON o link semplice)
                let fUrl = '';
                let lUrl = '';
                if (initialAvviso.attachment_url) {
                    if (initialAvviso.attachment_url.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(initialAvviso.attachment_url);
                            fUrl = parsed.file || '';
                            lUrl = parsed.link || '';
                        } catch {
                            fUrl = initialAvviso.attachment_url;
                        }
                    } else {
                        fUrl = initialAvviso.attachment_url;
                    }
                }
                setAttachmentUrl(fUrl);
                setLinkUrl(lUrl);
                setFileName(fUrl ? fUrl.split('/').pop() || t('formFileAllegatoFallback') : '');
                // Un allegato già archiviato non porta con sé un link firmato: si
                // mostra il nome, non un'anteprima che non si può aprire.
                setPreviewUrl(null);
            } else {
                // Reset in caso di creazione
                setTitolo('');
                setContenuto('');
                setTipo('presa_visione');
                // Docente: scope forzato a 'classe' con le proprie classi preselezionate.
                setScope(soloClassiProprie ? 'classe' : 'globale');
                setSelectedClasses(soloClassiProprie ? availableClasses.map((c) => c.nome) : []);
                setScadenza('');
                setAttachmentUrl('');
                setLinkUrl('');
                setFileName('');
                setPreviewUrl(null);
            }
        }
    }

    const toggleClass = (c: string) => {
        setSelectedClasses(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        void processaFile(file);
    };

    // Punto d'ingresso unico dell'upload: lo usano sia l'<input> (che accetta anche
    // PDF/doc) sia il bottone «Scatta foto» nativo → stesso flusso, PDF intatto.
    const processaFile = async (file: File) => {
        setFileUploading(true);
        setFileName(file.name);
        try {
            const formData = new FormData();
            formData.append('file', file);

            // Identità nullable (M4): header vuoto → il server risponde 401,
            // gestito dal ramo d'errore esistente (niente fallback demo).
            const res = await fetch(`/api/avvisi/upload?userId=${getCurrentTeacherId(null) ?? ''}`, {
                method: 'POST',
                headers: { 'x-user-id': getCurrentTeacherId(null) ?? '' },
                body: formData,
            });

            if (res.ok) {
                const data = await res.json();
                setAttachmentUrl(data.fileUrl);
                // `previewUrl` è il link firmato che il server prepara apposta per
                // riaprire subito ciò che si è appena caricato: finora arrivava e
                // veniva scartato, e l'operatore poteva allegare il file sbagliato
                // senza avere modo di accorgersene prima di pubblicare.
                setPreviewUrl(typeof data.previewUrl === 'string' ? data.previewUrl : null);
            } else {
                // Lo STATO è un numero: passa la whitelist di `redact` ed è l'unica cosa che
                // distingue «401, l'identità non è arrivata» da «413, il file è troppo grosso».
                // Il nome del file NON si logga: è quello di un allegato di una comunicazione.
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'avviso-upload-allegato-rifiutato', stato: res.status });
                alert(t('formAlertUploadFallito'));
                setFileName('');
            }
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `avviso-upload-allegato-fallito: ${nomeErrore(err)}` });
            alert(t('formAlertUploadErrore'));
            setFileName('');
        } finally {
            setFileUploading(false);
        }
    };

    const removeFile = () => {
        setAttachmentUrl('');
        setFileName('');
        setPreviewUrl(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    // Le condizioni che rendono il modulo NON inviabile, in un posto solo: la
    // stessa espressione governa l'aspetto del bottone, il suo `aria-disabled` e
    // la guardia dell'handler. Prima viveva solo nell'attributo `disabled`, e un
    // bottone `disabled` esce dal giro del Tab senza dire perché — oltre a far
    // saltare il fuoco su `<body>` nell'istante in cui lo si preme.
    const nonInviabile =
        fileUploading ||
        !titolo.trim() ||
        !contenuto.trim() ||
        (chiedeSede && !scuolaId) ||
        (scope === 'classe' && selectedClasses.length === 0);

    const handleSubmit = async () => {
        // La guardia è la SOSTANZA, non una formalità: senza `disabled`, il
        // bottone resta cliccabile durante la POST e due click distratti
        // pubblicherebbero due volte lo stesso avviso a tutte le famiglie.
        if (submitting || nonInviabile) return;
        if (chiedeSede && !scuolaId) return;
        setSubmitting(true);
        setErrore('');

        // Prepariamo l'attachment_url serializzato come JSON se c'è file o link
        let serializedAttachment = null;
        if (attachmentUrl.trim() || linkUrl.trim()) {
            serializedAttachment = JSON.stringify({
                file: attachmentUrl.trim() || null,
                link: linkUrl.trim() || null
            });
        }

        const esito = await onSubmit({
            titolo: titolo.trim(), contenuto: contenuto.trim(), tipo,
            target_scope: scope, target_classes: scope === 'classe' ? selectedClasses : [],
            scadenza: scadenza || null,
            attachment_url: serializedAttachment,
            // La sede si DICHIARA. `null` solo quando davvero non la si conosce:
            // in quel caso decide il server, e se resta ambigua risponde 400.
            scuola_id: sedeScelta || null,
        });
        setSubmitting(false);

        // ⚠️ IL PUNTO DI QUESTO FIX. Prima qui si azzerava tutto e si chiamava
        // `onClose()` senza guardare niente: un 400 «Specificare la sede» o un
        // 403 chiudeva il modale e cancellava il testo appena scritto, e
        // l'operatore usciva convinto di aver pubblicato. Su un rifiuto NON si
        // tocca nulla: il modulo resta aperto, com'era, con l'errore in testa.
        if (!esito?.ok) {
            setErrore(esito?.errore || t('formErroreInvio'));
            return;
        }

        setTitolo(''); setContenuto(''); setTipo('presa_visione');
        setScope('globale'); setSelectedClasses([]); setScadenza(''); setAttachmentUrl(''); setLinkUrl(''); setFileName('');
        setPreviewUrl(null);
        setScuolaId('');
        onClose();
    };

    const titoloModale = initialAvviso ? t('formTitoloModifica') : t('formTitoloNuovo');

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={titoloModale}
            labelledBy={titoloId}
            className="w-full max-w-lg max-h-[90vh] bg-white rounded-3xl shadow-2xl flex flex-col overflow-hidden"
        >
            <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line bg-white">
                <h2 id={titoloId} className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">
                    {titoloModale}
                </h2>
                {/* Area toccabile 44×44 (WCAG 2.5.8 / linee guida iOS e Android)
                    con la pastiglia visiva ancora a 32: si allarga il bersaglio,
                    non il disegno. La compensazione è ESATTAMENTE la metà della
                    crescita — (44−32)/2 = 6px, cioè `-mr-1.5`: con `-mr-2` (8px,
                    il gradino più vicino della scala Tailwind) la pastiglia
                    finiva 2px oltre il bordo destro dei campi, misurato. */}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={ts('chiudi')}
                    className="group -mr-1.5 min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded-xl"
                >
                    <span className="w-8 h-8 rounded-xl bg-kidville-cream group-hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-green transition-colors">
                        <X size={14} strokeWidth={1.5} aria-hidden="true" />
                    </span>
                </button>
            </div>
            {/* `aria-busy` sul MODULO, non sul dialogo: la primitiva `Modal` è
                condivisa da quindici schermate e non espone l'attributo. Il
                significato è comunque quello giusto — «questa regione sta
                cambiando, aspetta prima di leggerla». */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 bg-white" aria-busy={submitting}>
                {errore && (
                    <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                        <span>{errore}</span>
                    </div>
                )}
                {chiedeSede && (
                    <div>
                        <label htmlFor={idSede} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">
                            {t('formLabelSedePubblicazione')}
                        </label>
                        <select
                            id={idSede}
                            value={scuolaId}
                            onChange={e => {
                                // Cambiare sede AZZERA le classi: tenerle
                                // significherebbe spedire al server i nomi di
                                // classi di un altro plesso — che è come è nato
                                // il difetto (400 sicuro, o peggio un'omonima).
                                setScuolaId(e.target.value);
                                setSelectedClasses([]);
                                setErrore('');
                            }}
                            className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all"
                        >
                            <option value="">{t('formSedeScegli')}</option>
                            {sedi.map(s => (
                                <option key={s.id} value={s.id}>{s.nome}</option>
                            ))}
                        </select>
                        <p className="font-maven text-xs text-kidville-muted mt-1.5">{t('formNotaSedePubblicazione')}</p>
                    </div>
                )}
                <div>
                    <label htmlFor={idTitolo} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelTitolo')}</label>
                    {/* Il placeholder NON è l'etichetta: sparisce appena si scrive,
                        e con TalkBack il campo tornava senza nome a metà frase. */}
                    <input id={idTitolo} aria-required="true" value={titolo} onChange={e => setTitolo(e.target.value)} placeholder={t('formPlaceholderTitolo')}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                </div>
                <div>
                    <label htmlFor={idContenuto} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelContenuto')}</label>
                    <textarea id={idContenuto} aria-required="true" value={contenuto} onChange={e => setContenuto(e.target.value)} placeholder={t('formPlaceholderContenuto')} rows={4}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all resize-none" />
                </div>
                {/* Tipo e Destinatari sono coppie di BOTTONI, non campi: un
                    `<label>` senza controllo non etichetta niente e resta un
                    titoletto muto. L'intestazione etichetta il GRUPPO, così lo
                    screen reader annuncia «Tipo — Presa visione, premuto» invece
                    di quattro bottoni sciolti tutti uguali. */}
                <div>
                    <span id={idTipo} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelTipo')}</span>
                    <div role="group" aria-labelledby={idTipo} className="flex gap-2">
                        <button type="button" aria-pressed={tipo === 'presa_visione'} onClick={() => setTipo('presa_visione')} className={classiSegmento(tipo === 'presa_visione')}>
                            {tipo === 'presa_visione' && <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
                            {t('formTipoPresaVisione')}
                        </button>
                        <button type="button" aria-pressed={tipo === 'adesione'} onClick={() => setTipo('adesione')} className={classiSegmento(tipo === 'adesione')}>
                            {tipo === 'adesione' && <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
                            {t('formTipoAdesione')}
                        </button>
                    </div>
                </div>
                {soloClassiProprie ? (
                    <div>
                        <span id={idClassi} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelLeTueClassi')}</span>
                        <p className="font-maven text-xs text-kidville-muted mb-2">{t('formNotaLeTueClassi')}</p>
                    </div>
                ) : (
                    <div>
                        <span id={idDestinatari} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelDestinatari')}</span>
                        <div role="group" aria-labelledby={idDestinatari} className="flex gap-2">
                            <button type="button" aria-pressed={scope === 'globale'} onClick={() => setScope('globale')} className={classiSegmento(scope === 'globale')}>
                                {scope === 'globale' && <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
                                {t('formDestinatariTutti')}
                            </button>
                            <button type="button" aria-pressed={scope === 'classe'} onClick={() => setScope('classe')} className={classiSegmento(scope === 'classe')}>
                                {scope === 'classe' && <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
                                {t('formDestinatariPerClasse')}
                            </button>
                        </div>
                    </div>
                )}
                {scope === 'classe' && (
                    // `key={c.id}`, non `key={c.nome}`: da quando le sedi sono
                    // tre lo stesso nome esiste in due plessi, e con la chiave
                    // sul nome React rendeva UNA pillola per due classi diverse.
                    // L'etichetta porta la sede quando le sedi sono più d'una
                    // e non c'è già un selettore a dirla (caso «modifica»).
                    //
                    // `aria-pressed` + spunta su OGNI pillola: sceglierne una
                    // cambiava solo il colore del fondo, e un avviso mandato alla
                    // classe sbagliata è una comunicazione arrivata a famiglie che
                    // non c'entrano — e non arrivata a quelle che dovevano averla.
                    <div
                        role="group"
                        aria-labelledby={soloClassiProprie ? idClassi : idDestinatari}
                        className="flex flex-wrap gap-1.5 p-2 bg-kidville-cream rounded-2xl border border-kidville-line"
                    >
                        {classiVisibili.map(c => {
                            const scelta = selectedClasses.includes(c.nome);
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    aria-pressed={scelta}
                                    onClick={() => toggleClass(c.nome)}
                                    className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl font-maven text-xs font-semibold transition-all ${scelta ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-white text-kidville-muted border border-kidville-line hover:bg-kidville-cream'}`}
                                >
                                    {scelta && <Check size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />}
                                    {!chiedeSede && sedi.length > 1 && c.scuolaNome ? `${c.nome} — ${c.scuolaNome}` : c.nome}
                                </button>
                            );
                        })}
                    </div>
                )}
                
                <div>
                    {/* Era il campo messo peggio di tutti: `read_page` sull'albero
                        di accessibilità lo dava come «textbox» con nome VUOTO —
                        non il placeholder, proprio niente. */}
                    <label htmlFor={idScadenza} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">
                        {tipo === 'presa_visione' ? t('formScadenzaAvviso') : t('formScadenzaAdesione')}
                    </label>
                    <input id={idScadenza} type="date" value={scadenza} onChange={e => setScadenza(e.target.value)}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                </div>

                {/* Upload File */}
                <div>
                    {/* Anche qui i controlli sono bottoni (l'`<input type="file">`
                        vero è nascosto e lo apre il bottone): etichetta di gruppo,
                        non `<label>`. */}
                    <span id={idAllegato} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelFileAllegato')}</span>
                    <div role="group" aria-labelledby={idAllegato} className="flex items-center gap-3">
                        {/* Nascosto ma pur sempre il campo vero: prende il nome
                            dall'intestazione del gruppo. Senza, axe lo conta fra
                            i controlli senza etichetta — e il giorno in cui
                            qualcuno lo mostrasse sarebbe muto davvero. */}
                        <input type="file" ref={fileInputRef} onChange={handleFileChange} aria-labelledby={idAllegato} className="hidden" accept=".pdf,image/*,.doc,.docx" />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={fileUploading}
                            className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-kidville-line rounded-2xl font-maven text-xs font-semibold text-kidville-green hover:border-kidville-green hover:text-kidville-green transition-colors disabled:opacity-50"
                        >
                            <Upload size={14} /> {fileUploading ? t('formFileCaricamento') : t('formFileCarica')}
                        </button>

                        {/* Nativo: scatta la foto dell'allegato. Su web non compare. */}
                        <ScattaFotoButton
                            onFile={processaFile}
                            disabled={fileUploading}
                            className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-kidville-line rounded-2xl font-maven text-xs font-semibold text-kidville-green hover:border-kidville-green transition-colors disabled:opacity-50"
                        />

                        {fileName && (
                            <div className="flex items-center gap-2 bg-kidville-cream border border-kidville-line rounded-xl px-3 py-1.5 max-w-[200px] text-xs font-maven text-kidville-green">
                                {previewUrl ? (
                                    // Nuova scheda per forza: aprire l'anteprima
                                    // nella stessa butterebbe via la bozza.
                                    // Sottolineato, non solo colorato: «è un link»
                                    // non si affida al colore (WCAG 1.4.1).
                                    <a
                                        href={previewUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="truncate flex-1 min-w-0 underline underline-offset-2 hover:text-kidville-green"
                                    >
                                        {fileName}
                                    </a>
                                ) : (
                                    <span className="truncate flex-1 min-w-0">{fileName}</span>
                                )}
                                {/* 12×12 px e senza nome: invisibile a uno screen
                                    reader e impossibile da centrare col dito. Ora
                                    il BERSAGLIO è 44×44 (WCAG 2.5.8) mentre la
                                    pastiglia visiva resta piccola; i margini
                                    negativi riassorbono la crescita così la
                                    pillola non cambia altezza. */}
                                <button
                                    type="button"
                                    onClick={removeFile}
                                    aria-label={tAllegato('protRimuoviAllegato', { nome: fileName })}
                                    className="group -mr-2 -my-2.5 min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded-xl"
                                >
                                    <span className="w-5 h-5 rounded-lg flex items-center justify-center text-kidville-sub group-hover:text-kidville-error transition-colors">
                                        <X size={12} strokeWidth={2} aria-hidden="true" />
                                    </span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Link Esterno */}
                <div>
                    <label htmlFor={idLink} className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelLinkEsterno')}</label>
                    <div className="relative">
                        <Link size={14} aria-hidden="true" className="absolute left-4 top-1/2 -translate-y-1/2 text-kidville-muted" />
                        <input id={idLink} value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder={t('formPlaceholderLink')}
                            className="w-full border-2 border-kidville-line rounded-2xl pl-10 pr-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                    </div>
                </div>
            </div>
            <div className="px-6 py-4 border-t border-kidville-line bg-white">
                {/* La regione viva nasce VUOTA e vive quanto il modulo: un
                    `role="status"` creato insieme al testo non viene annunciato,
                    perché lo screen reader legge i CAMBIAMENTI di una regione che
                    era già lì. Qui dentro finisce l'unico stato che l'operatore
                    non può dedurre da solo — «sto pubblicando» — che prima non
                    veniva detto in nessun modo. */}
                <span role="status" className="sr-only">
                    {submitting ? (initialAvviso ? t('formSubmitSalvataggio') : t('formSubmitPubblicazione')) : ''}
                </span>
                {/* NIENTE `disabled`. Un elemento che si disabilita mentre ha il
                    fuoco lo scarica su `<body>`: misurato, e da lì il Tab usciva
                    dal dialogo proprio nell'istante in cui si preme «Pubblica».
                    `aria-disabled` dice la stessa cosa agli assistivi, tiene il
                    bottone nel giro del Tab (chi naviga da tastiera lo TROVA, e
                    scopre che manca qualcosa) e lascia la decisione all'handler,
                    che è anche l'unico punto in cui si può impedire il doppio
                    invio. L'opacità segue `aria-disabled`, non `:disabled`. */}
                <button
                    type="button"
                    onClick={handleSubmit}
                    aria-disabled={submitting || nonInviabile}
                    className={`w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20 ${submitting || nonInviabile ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90'}`}
                >
                    {submitting ? (
                        <>
                            <div aria-hidden="true" className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                            {initialAvviso ? t('formSubmitSalvataggio') : t('formSubmitPubblicazione')}
                        </>
                    ) : (
                        <>
                            <Send size={16} strokeWidth={1.5} aria-hidden="true" />
                            {initialAvviso ? t('formSubmitSalvaModifiche') : t('formSubmitPubblicaAvviso')}
                        </>
                    )}
                </button>
            </div>
        </Modal>
    );
}
