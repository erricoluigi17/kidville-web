'use client';

import { useTranslations } from 'next-intl';
import { Film, RotateCw, Trash2 } from 'lucide-react';

import { useDateFormat } from '@/lib/i18n/date';

/**
 * V11 · LA SCHEDA DI UN VIDEO CHE NON È ANCORA IN GALLERIA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERCHÉ ESISTE, DETTO CON LA MISURA ACCANTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una foto si carica e c'è. Un video no: dopo che i byte sono arrivati comincia
 * una conversione che gira su una macchina lontana e **dura minuti** — in un
 * campione misurato il 2026-09-17, un filmato di 180 secondi a 1080p è costato 709
 * secondi di wall su due vCPU, e il piano dimensiona il caso tipico fra 212 e 653.
 *
 * In quei minuti l'interfaccia deve dire la verità, e la verità cambia:
 *
 *  · **caricamento** — i byte partono dal telefono. Qui una percentuale esiste
 *    davvero, perché i byte si contano. Il caricamento continua finché l'app è
 *    aperta; se la si chiude riprende da solo alla riapertura;
 *  · **preparazione** (in coda, poi conversione) — il telefono ha finito e non
 *    sta facendo niente. Una barra che avanza qui sarebbe inventata: l'unica cosa
 *    vera da dire è *quanto può durare* e *che si può chiudere l'app*;
 *  · **pronto** — il video esiste, convertito e verificato, e il server lo sta per
 *    pubblicare: non c'è più nessun gesto da fare, i bambini li ha scelti prima.
 *
 * ⚠️ Perché tre e non «caricamento» per tutti: **se l'interfaccia dice
 * “caricamento” per otto minuti, qualcuno ricarica la pagina e carica due volte.**
 * Due conversioni, due video in galleria, due notifiche alle famiglie — e nessun
 * errore da nessuna parte, perché tecnicamente non è andato storto niente.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA SCHEDA NON DECIDE NIENTE, E NON CHIEDE PIÙ I BAMBINI
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fino alla PR 2 i bambini vivevano nella memoria della pagina: al rientro la
 * scheda di un video pronto li richiedeva, e a pubblicare era un pulsante. Adesso
 * viaggiano con l'invio, il server li conosce e pubblica da solo: la scheda
 * racconta soltanto a che punto è il video, e offre i gesti che restano — riprendere
 * un caricamento fermo, riprovare una pubblicazione fallita, togliere ciò che non
 * è andato a buon fine. Riceve righe già composte (`useVideoGalleria`, che fonde le
 * righe di questo dispositivo con l'elenco del server) e messaggi già tradotti.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DUE REGIONI VIVE STANNO SEMPRE NEL DOM (secondario #36)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VoiceOver spesso non annuncia una regione `aria-live` che entra nel documento già
 * piena, e le insegnanti dell'incidente erano su iOS: il messaggio sotto la fase
 * compariva proprio così, montato a condizione. Ora il paragrafo c'è SEMPRE e cambia
 * solo il suo testo — vuoto quando non c'è niente da dire.
 */

export type FaseVideoUI =
    /** I byte stanno partendo da questo dispositivo: la percentuale è vera. */
    | 'caricamento'
    /** Accodato: il suo caricamento parte quando finisce quello prima (uno alla volta). */
    | 'in-fila'
    /** Una sessione di caricamento è aperta ma ferma: riprende da sola, o col pulsante. */
    | 'interrotto'
    /** Il server aspetta i byte e non li sta mandando questo dispositivo. */
    | 'altro-dispositivo'
    /** Il server ha il file e aspetta il proprio turno. Secondi, di solito. */
    | 'in-coda'
    /** La conversione è in corso. Minuti. */
    | 'conversione'
    /** Un guasto nostro: il server ritenta da solo. Non serve fare niente. */
    | 'in-riprova'
    /** Convertito e verificato: il server lo pubblica a momenti. */
    | 'pronto'
    /** Convertito ma NON pubblicato, in modo definitivo: il messaggio dice perché. */
    | 'non-pubblicato'
    /** Rifiutato o non riuscito: il messaggio dice che cosa fare. */
    | 'fallito'
    /** Non c'è più niente da fare con questo invio: il video va scelto e mandato di nuovo. */
    | 'da-ricaricare'
    /** Ritirato da una persona. */
    | 'annullato';

export interface RigaVideoLavorazione {
    jobId: string;
    /**
     * Il nome scelto da chi ha caricato, o `null` quando questo dispositivo non lo sa (un video
     * mandato da un altro: l'elenco del server non porta nomi). Si mostra perché è l'unico modo
     * di sapere QUALE dei tre video è quello fermo.
     *
     * ⚠️ Resta sullo schermo di chi ha scelto il file e non entra in nessun log:
     * `recita-bambina-rossi.mov` è anagrafica di un minore, e in `app_log`
     * resterebbe trenta giorni interrogabile in SQL.
     */
    nome: string | null;
    /** Quando il video è stato inviato (ISO): è ciò che si legge al posto del nome che manca. */
    creatoIl: string | null;
    fase: FaseVideoUI;
    /** 0–100, oppure `null` quando una percentuale non significherebbe niente. */
    percentuale: number | null;
    /** Già tradotto da chi chiama (catalogo, mai la prosa del server). */
    messaggio: string | null;
    /** «Riprova» ha senso solo su un non pubblicato che il server riprenderebbe. */
    riprovaPossibile: boolean;
}

interface Props {
    righe: RigaVideoLavorazione[];
    onRiprendi: (jobId: string) => void;
    onRimuovi: (jobId: string) => void;
    onRiprova: (jobId: string) => void;
}

/** Le fasi che finiscono male o in nulla: lì il gesto che resta è «Togli», non «Rimuovi». */
const FASI_DA_TOGLIERE: ReadonlySet<FaseVideoUI> = new Set<FaseVideoUI>([
    'non-pubblicato',
    'fallito',
    'da-ricaricare',
    'annullato',
]);

/** Le fasi in cui c'è una cosa da NON dimenticare, e si legge in rosso. */
const FASI_ROSSE: ReadonlySet<FaseVideoUI> = new Set<FaseVideoUI>([
    'non-pubblicato',
    'fallito',
    'da-ricaricare',
]);

export function VideoInLavorazione({ righe, onRiprendi, onRimuovi, onRiprova }: Props) {
    const t = useTranslations('teacherServizi');
    const { dataOra } = useDateFormat();

    // Nessuna riga, nessun riquadro: un contenitore vuoto con un titolo dentro è
    // una promessa che non mantiene niente, e su una schermata che di norma non ha
    // video in lavorazione sarebbe lì per sempre.
    if (righe.length === 0) return null;

    const testoFase = (fase: FaseVideoUI): string => {
        switch (fase) {
            case 'caricamento': return t('galleryVideoFaseCaricamento');
            case 'in-fila': return t('galleryVideoFaseInFila');
            case 'interrotto': return t('galleryVideoFaseInterrotto');
            case 'altro-dispositivo': return t('galleryVideoFaseAltroDispositivo');
            case 'in-coda': return t('galleryVideoFaseInCoda');
            case 'conversione': return t('galleryVideoFaseConversione');
            // «Il problema è nostro, lo stiamo riprovando»: è già la frase intera, e dice anche
            // che non serve ricaricare e che si può chiudere l'app.
            case 'in-riprova': return t('galleryVideoRiprovaAutomatica');
            case 'pronto': return t('galleryVideoFasePronto');
            // Un fallimento e un non pubblicato hanno la stessa etichetta: per chi guarda lo
            // schermo è la stessa notizia («il video non è uscito»), e il PERCHÉ sta nel messaggio
            // che arriva dal codice (`codiceMessaggioVideo`): «accorcialo», «ricaricalo», «riprova».
            case 'non-pubblicato':
            case 'fallito': return t('galleryVideoNonPubblicato');
            case 'da-ricaricare': return t('galleryVideoDaRicaricare');
            case 'annullato': return t('galleryVideoFaseAnnullato');
        }
    };

    return (
        <section className="mb-4 rounded-3xl border border-kidville-line bg-white p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
                <Film size={15} strokeWidth={1.75} aria-hidden="true" />
                {t('galleryVideoLavorazioneTitolo')}
            </h2>

            <ul className="space-y-3">
                {righe.map((r) => {
                    const rossa = FASI_ROSSE.has(r.fase);
                    // Su un fallimento e su un non pubblicato il messaggio è il MOTIVO (la frase del
                    // codice); se per un guasto non c'è, resta quello generico: mai una scheda che dice
                    // «non pubblicato» senza dire perché. Le altre fasi lo lasciano vuoto.
                    const conMotivo = r.fase === 'fallito' || r.fase === 'non-pubblicato';
                    const messaggio = r.messaggio ?? (conMotivo ? t('galleryErrCaricamentoGenerico') : '');
                    const nome = r.nome ?? t('galleryVideoSenzaNome', { quando: dataOra(r.creatoIl) });
                    return (
                        <li key={r.jobId} className="rounded-2xl border border-kidville-green/10 bg-kidville-cream/35 p-3">
                            <p className="truncate font-maven text-xs font-semibold text-kidville-green" title={nome}>
                                {nome}
                            </p>

                            {/*
                              LA FASE VA ANNUNCIATA, non solo dipinta: cambia da sola, minuti
                              dopo, senza che nessuno abbia toccato niente. Senza `aria-live`
                              chi usa uno screen reader resta sull'ultima cosa che ha sentito —
                              «caricamento» — e non ha modo di sapere che adesso è pronto.
                              `polite` e non `assertive`: non interrompe ciò che si sta facendo.
                            */}
                            <p
                                aria-live="polite"
                                className={`mt-1 font-maven text-[11px] leading-snug ${
                                    rossa ? 'font-semibold text-kidville-error' : 'text-kidville-sub'
                                }`}
                            >
                                {testoFase(r.fase)}
                            </p>

                            {/*
                              LA SECONDA REGIONE VIVA, SEMPRE MONTATA (#36). Su una fase che NON
                              è un fallimento porta un messaggio che dice che cosa toglie di mezzo
                              l'ostacolo — il 401 di una sessione scaduta mentre i byte partivano,
                              «il caricamento continua finché resti in Galleria» — e non è un errore
                              rosso. Su una scheda rossa porta il MOTIVO: la frase del codice.
                              Vuota quando non c'è niente da dire, e allora non occupa spazio: il
                              margine sta sul testo, non sul paragrafo, e l'elemento resta nel DOM
                              perché VoiceOver lo conosca già quando si riempie.
                            */}
                            <p
                                aria-live="polite"
                                className={`font-maven text-[11px] leading-snug ${
                                    rossa ? 'text-kidville-error' : 'text-kidville-sub'
                                } ${messaggio ? 'mt-1' : ''}`}
                            >
                                {messaggio}
                            </p>

                            {/*
                              LA BARRA ESISTE SOLO DOVE LA PERCENTUALE È VERA.
                              Su un fallimento una barra piena sarebbe una bugia e una barra
                              ferma al 60% lascerebbe credere che qualcosa stia ancora
                              succedendo: quando l'avanzamento non significa più niente si
                              toglie, e parla il messaggio. È la stessa regola che
                              `avanzamentoDaStatoVideo` applica lato contratto.
                            */}
                            {r.percentuale !== null && (
                                <div
                                    role="progressbar"
                                    aria-valuenow={r.percentuale}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-label={t('galleryVideoAvanzamento')}
                                    className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-kidville-green/15"
                                >
                                    <div
                                        className="h-full rounded-pill bg-kidville-green transition-all"
                                        style={{ width: `${Math.max(0, Math.min(100, r.percentuale))}%` }}
                                    />
                                </div>
                            )}

                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {r.fase === 'interrotto' && (
                                    <button
                                        type="button"
                                        onClick={() => onRiprendi(r.jobId)}
                                        className="flex items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-yellow"
                                    >
                                        <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                                        {t('galleryVideoRiprendi')}
                                    </button>
                                )}

                                {/*
                                  «RIPROVA» C'È SOLO SE IL SERVER, PREMUTO, DIREBBE DI SÌ
                                  (`riprovaPossibile`: la stessa risposta della RPC). Un pulsante che
                                  risponde 409 è un pulsante che mente: quando la causa è «nessuno dei
                                  bambini scelti è più nella sede» ripubblicare darebbe lo stesso
                                  rifiuto, e il pulsante non si offre.
                                */}
                                {r.fase === 'non-pubblicato' && r.riprovaPossibile && (
                                    <button
                                        type="button"
                                        onClick={() => onRiprova(r.jobId)}
                                        className="flex items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-yellow"
                                    >
                                        <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                                        {t('galleryVideoRiprova')}
                                    </button>
                                )}

                                {/*
                                  «Rimuovi» c'è anche mentre il video è in preparazione, ed è
                                  deliberato: chi ha caricato il filmato sbagliato deve poterlo
                                  ritirare PRIMA che finisca in galleria, non dopo — e il ritiro
                                  dell'intento è anche ciò che libera l'originale dal bucket
                                  privato invece di lasciarlo scadere in sette giorni. Su ciò che è
                                  andato male il gesto si chiama «Togli»: non c'è più niente da
                                  ritirare, c'è una scheda da levare di mezzo (e, per un intento che
                                  il server non ha chiuso, da annullare).
                                */}
                                <button
                                    type="button"
                                    onClick={() => onRimuovi(r.jobId)}
                                    className="flex items-center gap-1.5 rounded-pill border border-kidville-line px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-green"
                                >
                                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                                    {FASI_DA_TOGLIERE.has(r.fase) ? t('galleryVideoTogli') : t('galleryVideoRimuovi')}
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
