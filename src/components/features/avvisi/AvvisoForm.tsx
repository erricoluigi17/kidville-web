import { useState, useRef, useId } from 'react';
import { useTranslations } from 'next-intl';
import { X, Send, Upload, Link, AlertTriangle } from 'lucide-react';
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
 * PIANI (z-index) — la scala in uso nel repo, dal basso. I numeri sono scritti
 * NUDI di proposito: il lock `native-privacy-lock` cerca la forma `z-[…]` in
 * tutti i file di `src`, commenti compresi, e un esempio in un commento gli
 * risulterebbe indistinguibile da un piano vero.
 *   50        bottom-nav (parent · teacher · admin), drawer laterali, tendine
 *   60        toast e popover ancorati
 *   80        MODALI (questa) — la primitiva `Modal`
 *   105 · 110 chrome dell'admin (topbar, sidebar, bottom-sheet «Menu»)
 *   9999      gate biometrico, che deve stare sopra a tutto
 * Prima la modale stava a 50, cioè sullo STESSO piano della bottom-nav: che
 * infatti le copriva il bottone «Pubblica avviso». Ora è 80 (dalla primitiva), e
 * il lock `AvvisoForm-a11y-modale` confronta il numero con quello dichiarato
 * davvero dalle tre bottom-nav, non con una costante scritta a mano.
 */
export function AvvisoForm({ open, onClose, onSubmit, availableClasses = [], initialAvviso = null, soloClassiProprie = false }: Props) {
    const t = useTranslations('teacherComunicazioni');
    // `shared` per la sola etichetta «Chiudi»: già presente in IT e EN, nessuna
    // chiave nuova da tradurre (stessa scelta di AdminMenuSheet).
    const ts = useTranslations('shared');
    // Id stabile e unico per istanza: è il bersaglio di `aria-labelledby`.
    const titoloId = useId();
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
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleSubmit = async () => {
        if (!titolo.trim() || !contenuto.trim()) return;
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
                    non il disegno. `-mr-2` riassorbe i 12px in più a destra così
                    l'allineamento dell'header resta quello di prima. */}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={ts('chiudi')}
                    className="group -mr-2 min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded-xl"
                >
                    <span className="w-8 h-8 rounded-xl bg-kidville-cream group-hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-green transition-colors">
                        <X size={14} strokeWidth={1.5} aria-hidden="true" />
                    </span>
                </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 bg-white">
                {errore && (
                    <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                        <span>{errore}</span>
                    </div>
                )}
                {chiedeSede && (
                    <div>
                        <label htmlFor="avviso-sede" className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">
                            {t('formLabelSedePubblicazione')}
                        </label>
                        <select
                            id="avviso-sede"
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
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelTitolo')}</label>
                    <input value={titolo} onChange={e => setTitolo(e.target.value)} placeholder={t('formPlaceholderTitolo')}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                </div>
                <div>
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelContenuto')}</label>
                    <textarea value={contenuto} onChange={e => setContenuto(e.target.value)} placeholder={t('formPlaceholderContenuto')} rows={4}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all resize-none" />
                </div>
                <div>
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelTipo')}</label>
                    <div className="flex gap-2">
                        <button onClick={() => setTipo('presa_visione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'presa_visione' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-cream-dark'}`}>{t('formTipoPresaVisione')}</button>
                        <button onClick={() => setTipo('adesione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'adesione' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-cream-dark'}`}>{t('formTipoAdesione')}</button>
                    </div>
                </div>
                {soloClassiProprie ? (
                    <div>
                        <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelLeTueClassi')}</label>
                        <p className="font-maven text-xs text-kidville-muted mb-2">{t('formNotaLeTueClassi')}</p>
                    </div>
                ) : (
                    <div>
                        <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelDestinatari')}</label>
                        <div className="flex gap-2">
                            <button onClick={() => setScope('globale')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'globale' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-cream-dark'}`}>{t('formDestinatariTutti')}</button>
                            <button onClick={() => setScope('classe')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'classe' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-cream-dark'}`}>{t('formDestinatariPerClasse')}</button>
                        </div>
                    </div>
                )}
                {scope === 'classe' && (
                    // `key={c.id}`, non `key={c.nome}`: da quando le sedi sono
                    // tre lo stesso nome esiste in due plessi, e con la chiave
                    // sul nome React rendeva UNA pillola per due classi diverse.
                    // L'etichetta porta la sede quando le sedi sono più d'una
                    // e non c'è già un selettore a dirla (caso «modifica»).
                    <div className="flex flex-wrap gap-1.5 p-2 bg-kidville-cream rounded-2xl border border-kidville-line">
                        {classiVisibili.map(c => (
                            <button
                                key={c.id}
                                onClick={() => toggleClass(c.nome)}
                                className={`px-3 py-1.5 rounded-xl font-maven text-xs font-semibold transition-all ${selectedClasses.includes(c.nome) ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-white text-kidville-muted border border-kidville-line hover:bg-kidville-cream'}`}
                            >
                                {!chiedeSede && sedi.length > 1 && c.scuolaNome ? `${c.nome} — ${c.scuolaNome}` : c.nome}
                            </button>
                        ))}
                    </div>
                )}
                
                <div>
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">
                        {tipo === 'presa_visione' ? t('formScadenzaAvviso') : t('formScadenzaAdesione')}
                    </label>
                    <input type="date" value={scadenza} onChange={e => setScadenza(e.target.value)}
                        className="w-full border-2 border-kidville-line rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                </div>

                {/* Upload File */}
                <div>
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelFileAllegato')}</label>
                    <div className="flex items-center gap-3">
                        <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".pdf,image/*,.doc,.docx" />
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
                            <div className="flex items-center gap-2 bg-kidville-cream border border-kidville-line rounded-xl px-3 py-1.5 max-w-[200px] truncate text-xs font-maven text-kidville-green">
                                <span className="truncate flex-1">{fileName}</span>
                                <button type="button" onClick={removeFile} className="text-kidville-muted hover:text-kidville-error flex-shrink-0">
                                    <X size={12} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Link Esterno */}
                <div>
                    <label className="font-maven font-medium text-xs text-kidville-muted uppercase tracking-wide mb-1.5 block">{t('formLabelLinkEsterno')}</label>
                    <div className="relative">
                        <Link size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-kidville-muted" />
                        <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder={t('formPlaceholderLink')}
                            className="w-full border-2 border-kidville-line rounded-2xl pl-10 pr-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                    </div>
                </div>
            </div>
            <div className="px-6 py-4 border-t border-kidville-line bg-white">
                <button onClick={handleSubmit} disabled={submitting || fileUploading || !titolo.trim() || !contenuto.trim() || (chiedeSede && !scuolaId) || (scope === 'classe' && selectedClasses.length === 0)}
                    className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                    {submitting ? (
                        <>
                            <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                            {initialAvviso ? t('formSubmitSalvataggio') : t('formSubmitPubblicazione')}
                        </>
                    ) : (
                        <>
                            <Send size={16} strokeWidth={1.5} />
                            {initialAvviso ? t('formSubmitSalvaModifiche') : t('formSubmitPubblicaAvviso')}
                        </>
                    )}
                </button>
            </div>
        </Modal>
    );
}
