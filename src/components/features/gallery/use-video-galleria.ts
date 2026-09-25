'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
    accodaCaricamentoVideo,
    annullaCaricamentoVideo,
    caricaVideo,
    creaArchivioCaricamenti,
    potaArchivioCaricamenti,
    type ArchivioCaricamentiVideo,
    type DipendenzeCaricamentoVideo,
} from '@/lib/media/video/upload';
import {
    annullaIntentoVideo,
    apriIntentoVideoGalleria,
    chiaveIdempotenzaVideo,
    confermaIntentoVideo,
    faseDelJob,
    leggiStatoIntentoVideo,
    pubblicaVideoInGalleria,
    rifiutoLocaleVideo,
    segnalaVideoCaricato,
    type StatoIntentoVideo,
} from '@/lib/gallery/video-galleria-flusso';
import { caricamentoNelContesto } from '@/lib/media/video/upload/stato';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient } from '@/lib/logging/client';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';

import type { FaseVideoUI, RigaVideoLavorazione } from './VideoInLavorazione';

/**
 * V11 · LA MACCHINA A STATI DI UN VIDEO DI GALLERIA, DAL LATO DELLA SCHERMATA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERCHÉ UN HOOK, E NON CODICE DENTRO `page.tsx`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Perché questa roba ha una VITA PROPRIA, più lunga della schermata che l'ha
 * avviata: un caricamento riprende al rientro nell'app, una conversione prosegue
 * mentre il telefono è in tasca, un job pronto aspetta un gesto che forse arriverà
 * domani. Tenerla dentro la pagina vorrebbe dire mescolarla ai passi «scegli /
 * tagga / pubblica», che invece durano quanto una sessione.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE TRE COSE CHE SOPRAVVIVONO ALLA CHIUSURA DELL'APP, E LA QUARTA CHE NO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **i byte non ancora spediti** — stanno in IndexedDB insieme all'URL della
 *     sessione TUS, e ripartono dall'offset che il server ha contato;
 *  2. **il riferimento al job** — `jobDaSeguire()` lo restituisce al rientro, ed è
 *     l'unico modo perché la schermata sappia che cosa tornare a interrogare;
 *  3. **la conversione**, che gira su una macchina lontana e non sa nemmeno che
 *     l'app si è chiusa.
 *
 * E la quarta, che **non** sopravvive: **i bambini taggati**. Vivono nella memoria
 * di questa pagina, e non possono andare su disco «per comodità» — sono
 * identificativi di minori, e l'archivio dei caricamenti ha un elenco chiuso di
 * chiavi (`CHIAVI_RIGA_CARICAMENTO`) proprio per impedire che ci finisca dentro
 * roba del genere. Perciò un job ritrovato al rientro porta `chiedeTag: true` e la
 * scheda chiede i bambini prima di pubblicare, invece di pubblicare a vuoto.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA FIRMA SCADE, E ALLA RIPRESA NE SERVE UNA NUOVA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * L'upload TUS si autentica con una firma coniata dalla route con la chiave di
 * servizio (`x-signature`), non con il token di sessione: `storage.objects` ha RLS
 * accesa e zero policy, e un upload col JWT dell'utente prenderebbe 403 al primo
 * byte. Quella firma vale due ore. Alla ripresa — che può avvenire tre giorni dopo
 * — se ne chiede una nuova RIAPRENDO l'intento con la stessa chiave di
 * idempotenza: `video_intent_open` ritrova lo stesso job e restituisce una firma
 * fresca. È il percorso deterministico su cui le due metà della pipeline si
 * incontrano, ed è il motivo per cui `intestazioni` è una funzione e non un valore.
 */

/** Ciò che si sa di un video in lavorazione, dentro questa pagina. */
interface VoceVideo {
    jobId: string;
    ownerId: string;
    scuolaId: string;
    intentId: string;
    revisione: number;
    /** Il nome del file: resta a schermo, non entra in nessun log. */
    nome: string;
    fase: FaseVideoUI;
    /** Solo durante il caricamento: i byte si contano, la conversione no. */
    percentuale: number | null;
    messaggio: string | null;
    /** Ritrovato al rientro: i tag non ci sono più e vanno richiesti. */
    chiedeTag: boolean;
}

/** I bambini scelti per un video, e se va a tutta la classe. */
interface SceltaTag {
    tag: string[];
    broadcast: boolean;
}

export interface OpzioniVideoGalleria {
    /** L'insegnante che carica: serve a `POST /api/gallery` come `x-user-id`. */
    utenteId: string | null;
    /**
     * La sede su cui si sta pubblicando, o `null` quando non si può sapere.
     * `null` NON è un ripiego: è il rifiuto che impedisce di archiviare il video
     * di un bambino nel plesso sbagliato senza che nessuno se ne accorga.
     */
    sede: string | null;
    /** Le classi destinatarie quando il video va in broadcast. */
    classi: string[];
    /** Da chiamare quando un video entra davvero in galleria: ricarica l'elenco. */
    onPubblicato: () => void | Promise<void>;
}

export interface ApiVideoGalleria {
    righe: RigaVideoLavorazione[];
    /** I bambini scelti per un job ritrovato al rientro. */
    tagDi: (jobId: string) => string[];
    cambiaTag: (jobId: string, alunnoId: string) => void;
    avviaVideo: (
        file: File,
        scelta: { tag: string[]; broadcast: boolean; durataSecondi: number | null },
    ) => Promise<{ ok: true } | { ok: false; messaggio: string }>;
    riprendi: (jobId: string) => void;
    rimuovi: (jobId: string) => void;
    pubblica: (jobId: string) => void;
}

/** Ogni quanto si ri-chiede lo stato mentre qualcuno guarda lo schermo. */
const RITMO_POLLING_MS = 5_000;

/** Le fasi in cui il server sta ancora lavorando: sono le sole da interrogare. */
const DA_INTERROGARE: ReadonlySet<FaseVideoUI> = new Set<FaseVideoUI>(['in-coda', 'conversione']);

export function useVideoGalleria(opzioni: OpzioniVideoGalleria): ApiVideoGalleria {
    const t = useTranslations('teacherServizi');

    const [voci, setVoci] = useState<VoceVideo[]>([]);
    const [tagPerJob, setTagPerJob] = useState<Record<string, SceltaTag>>({});

    const archivioRef = useRef<ArchivioCaricamentiVideo | null>(null);
    const montatoRef = useRef(false);
    useEffect(() => { montatoRef.current = true; return () => { montatoRef.current = false; }; }, []);
    /** Le firme valide di questa sessione: alla ripresa se ne chiede una nuova. */
    const firmeRef = useRef<Map<string, { token: string; scade: number }>>(new Map());
    /** Le pubblicazioni IN VOLO: un secondo tocco non ne fa partire una seconda. */
    const seguendoRef = useRef<Map<string, Promise<void>>>(new Map());
    const annullatiRef = useRef<Set<string>>(new Set());
    const pubblicandoRef = useRef<Set<string>>(new Set());
    /**
     * I job per cui la pubblicazione AUTOMATICA è già stata tentata una volta.
     *
     * ⚠️ NON È UN DOPPIONE DI `pubblicandoRef`, e la differenza è un difetto vero
     * misurato il 2026-09-18 con la prima stesura di questo file: il rifiuto del
     * Privacy Lock riportava la scheda a «pronto», l'effetto qui sotto la vedeva
     * pronta di nuovo e ripubblicava. **992 richieste a `/api/gallery` in 120
     * millisecondi**, ognuna con dentro gli id dei bambini taggati, finché la
     * pagina restava aperta. Questo insieme non si svuota mai: il tentativo
     * automatico è UNO, e dopo tocca a una persona — che il pulsante «Pubblica»
     * glielo lascia fare, perché quello guarda solo `pubblicandoRef`.
     */
    const autoTentatoRef = useRef<Set<string>>(new Set());

    /**
     * LO SPECCHIO DEI VALORI DI ADESSO, e perché serve.
     *
     * Le callback qui sotto vivono più a lungo di un render: una conversione dura
     * minuti, e la funzione che la sorveglia è partita all'inizio. Leggendo la
     * CHIUSURA vedrebbe la sede di quando è partita, non quella di adesso — e su
     * un admin che nel frattempo ha cambiato plesso nel cockpit, sarebbe il video
     * archiviato nella sede sbagliata.
     *
     * L'aggiornamento sta in un effetto SENZA elenco di dipendenze (gira dopo
     * ogni render) e non in corpo di funzione: scrivere un ref durante il render
     * è vietato da `react-hooks/refs`, ed è la stessa forma che usa
     * `usePollingVisibile` per la sua callback.
     */
    const opzioniRef = useRef(opzioni);
    const vociRef = useRef<VoceVideo[]>([]);
    const tagRef = useRef<Record<string, SceltaTag>>({});

    /** Il ripiego di ogni messaggio: mai la stringa vuota, che a schermo è silenzio. */
    const ripiego = t('galleryErrCaricamentoGenerico');
    const ripiegoRef = useRef(ripiego);

    useEffect(() => {
        opzioniRef.current = opzioni;
        vociRef.current = voci;
        tagRef.current = tagPerJob;
        ripiegoRef.current = ripiego;
    });

    /** La frase del catalogo per un codice della pipeline, nella lingua a schermo. */
    const frase = useCallback((codice: string | null): string => {
        return soloCatalogoDaCorpo({ codice }, ripiegoRef.current);
    }, []);

    const aggiorna = useCallback((jobId: string, modifiche: Partial<VoceVideo>) => {
        setVoci((prev) => prev.map((v) => (v.jobId === jobId ? { ...v, ...modifiche } : v)));
    }, []);

    const metti = useCallback((voce: VoceVideo) => {
        setVoci((prev) =>
            prev.some((v) => v.jobId === voce.jobId)
                ? prev.map((v) => (v.jobId === voce.jobId ? { ...v, ...voce } : v))
                : [...prev, voce],
        );
    }, []);

    const togli = useCallback((jobId: string) => {
        setVoci((prev) => prev.filter((v) => v.jobId !== jobId));
    }, []);

    const firmaPerJob = useCallback(async (jobId: string): Promise<string | null> => {
        const corrente = opzioniRef.current;
        const riga = await archivioRef.current?.leggi(jobId);
        if (!montatoRef.current || !riga || !corrente.utenteId || !corrente.sede
            || corrente.utenteId !== opzioniRef.current.utenteId || corrente.sede !== opzioniRef.current.sede
            || !caricamentoNelContesto(riga, corrente.utenteId, corrente.sede, 'gallery')) return null;
        const gia = firmeRef.current.get(jobId);
        if (gia && gia.scade > Date.now() + 15_000) return gia.token;
        const esito = await apriIntentoVideoGalleria(fetch, {
            file: { name: riga.nome, size: riga.dimensioneByte, type: riga.mime },
            scuolaId: riga.scuolaId!, durataSecondi: null, chiaveIdempotenza: riga.chiaveIdempotenza, ripiego: ripiegoRef.current,
        });
        if (!montatoRef.current || !esito.ok || !esito.dati.needsUpload || esito.dati.jobId !== jobId
            || opzioniRef.current.utenteId !== corrente.utenteId || opzioniRef.current.sede !== corrente.sede) return null;
        firmeRef.current.set(jobId, { token: esito.dati.firma, scade: Date.parse(esito.dati.expiresAt ?? '') || 0 });
        return esito.dati.firma;
    }, []);

    const dipendenze = useCallback(
        (jobId: string): DipendenzeCaricamentoVideo => ({
            archivio: archivioRef.current as ArchivioCaricamentiVideo,
            intestazioni: async () => {
                const firma = await firmaPerJob(jobId);
                // Il `throw` NON è un guasto muto: `caricaVideo` lo cattura, scrive
                // `video-upload-sessione-non-risolta` e restituisce «interrotto» —
                // cioè i byte restano sul dispositivo e una persona può rimediare.
                if (!firma) throw new Error('FirmaNonDisponibile');
                return { 'x-signature': firma };
            },
        }),
        [firmaPerJob],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * LO STATO CHE ARRIVA DAL SERVER
     * ──────────────────────────────────────────────────────────────────────── */

    const applicaStato = useCallback(
        (stato: StatoIntentoVideo) => {
            // La Galleria collega UN solo job per intento: lo impone
            // `video_intent_add_job` con `SINGLE_JOB_CHANNEL`.
            const job = stato.job[0];
            if (!job) return;

            if (!vociRef.current.some(v => v.jobId === job.jobId && v.ownerId === opzioniRef.current.utenteId && v.scuolaId === opzioniRef.current.sede)) return;
            if (stato.statoIntent === 'published') {
                togli(job.jobId);
                void archivioRef.current?.elimina(job.jobId).catch(err => logClient({ livello: 'warn', evento: 'offline', messaggio: 'video-riferimento-non-rimosso', campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' } }));
                return;
            }
            const fase = ['cancelled', 'superseded'].includes(stato.statoIntent) ? 'annullato' : faseDelJob(job.stato);
            setVoci((prev) =>
                prev.map((v) => {
                    if (v.jobId !== job.jobId) return v;
                    // Una pubblicazione in volo non si fa sovrascrivere da un polling
                    // che vede ancora `ready`: sarebbe la scheda che torna indietro.
                    if (v.fase === 'pubblicazione') return { ...v, revisione: stato.revisione };
                    return {
                        ...v,
                        revisione: stato.revisione,
                        fase,
                        // La percentuale esiste solo dove i byte si contano. In coda e
                        // in conversione il server dà un avanzamento a scalini (25, 60):
                        // disegnarlo come una barra vorrebbe dire promettere una misura
                        // che non c'è.
                        percentuale: null,
                        messaggio: fase === 'fallito' ? frase(job.codice) : null,
                    };
                }),
            );
        },
        [frase, togli],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * PUBBLICARE
     * ──────────────────────────────────────────────────────────────────────── */

    const pubblica = useCallback(
        (jobId: string) => {
            if (pubblicandoRef.current.has(jobId)) return;
            const voce = vociRef.current.find((v) => v.jobId === jobId);
            const utenteId = opzioniRef.current.utenteId;
            if (!voce || !utenteId || voce.ownerId !== utenteId || voce.scuolaId !== opzioniRef.current.sede
                || voce.fase !== 'pronto' || (voce.chiedeTag && !(tagRef.current[jobId]?.tag.length))) return;

            pubblicandoRef.current.add(jobId);
            aggiorna(jobId, { fase: 'pubblicazione', messaggio: null });

            void (async () => {
                const scelta = tagRef.current[jobId] ?? { tag: [], broadcast: false };
                const esito = await pubblicaVideoInGalleria(fetch, {
                    intentId: voce.intentId,
                    revisione: voce.revisione,
                    utenteId,
                    didascalia: voce.nome,
                    tagAlunni: scelta.tag,
                    broadcast: scelta.broadcast,
                    classi: opzioniRef.current.classi,
                    scuolaId: voce.scuolaId,
                    ripiego: ripiegoRef.current,
                });

                pubblicandoRef.current.delete(jobId);
                if (!montatoRef.current || opzioniRef.current.utenteId !== voce.ownerId || opzioniRef.current.sede !== voce.scuolaId) return;
                if (!esito.ok) {
                    const stato = await leggiStatoIntentoVideo(fetch, { intentId: voce.intentId, ripiego: ripiegoRef.current });
                    if (!montatoRef.current || opzioniRef.current.utenteId !== voce.ownerId || opzioniRef.current.sede !== voce.scuolaId) return;
                    if (stato.ok && stato.dati.statoIntent === 'published') {
                        await archivioRef.current?.elimina(jobId);
                        togli(jobId);
                        await opzioniRef.current.onPubblicato();
                        return;
                    }
                    // Si torna a «pronto»: il video è ancora lì, e il rifiuto dice che
                    // cosa fare (togliere un bambino senza liberatoria, per esempio —
                    // e in quel caso il corpo porta i nomi, che restano a schermo).
                    const dettaglio = esito.nomi?.length ? ` (${esito.nomi.join(', ')})` : '';
                    aggiorna(jobId, { fase: 'pronto', messaggio: `${esito.messaggio}${dettaglio}` });
                    return;
                }

                // Pubblicato: la riga locale non serve più, e con lei se ne va il
                // riferimento al job — altrimenti al prossimo rientro la scheda
                // ricomparirebbe per un video che è già in galleria.
                await archivioRef.current?.elimina(jobId).catch((err: unknown) => {
                    logClient({
                        livello: 'warn',
                        evento: 'offline',
                        route: '/teacher/gallery',
                        messaggio: `video-galleria-riga-locale-non-rimossa: job=${jobId}`,
                        campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' },
                    });
                });
                togli(jobId);
                await opzioniRef.current.onPubblicato();
            })().catch((err: unknown) => {
                pubblicandoRef.current.delete(jobId);
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'video-pubblicazione-interrotta', campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' } });
                if (montatoRef.current && opzioniRef.current.utenteId === voce.ownerId && opzioniRef.current.sede === voce.scuolaId) aggiorna(jobId, { fase: 'pronto', messaggio: ripiegoRef.current });
            });
        },
        [aggiorna, togli],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * CARICARE (che è anche RIPRENDERE)
     * ──────────────────────────────────────────────────────────────────────── */

    const segui = useCallback((jobId: string, intentId: string, revisione: number): Promise<void> => {
        const contesto = { owner: opzioniRef.current.utenteId, sede: opzioniRef.current.sede };
        const chiave = `${contesto.owner}:${contesto.sede}:${jobId}`;
        const gia = seguendoRef.current.get(chiave);
        if (gia) return gia;
        const ancora = () => montatoRef.current && contesto.owner === opzioniRef.current.utenteId && contesto.sede === opzioniRef.current.sede && !annullatiRef.current.has(jobId);
        const esegui = async () => {
            const archivio = archivioRef.current;
            const riga = await archivio?.leggi(jobId);
            if (!archivio || !riga || !contesto.owner || !contesto.sede || !ancora()
                || !caricamentoNelContesto(riga, contesto.owner, contesto.sede, 'gallery')) return;
            const apertura = await apriIntentoVideoGalleria(fetch, {
                file: { name: riga.nome, size: riga.dimensioneByte, type: riga.mime },
                scuolaId: riga.scuolaId!, durataSecondi: null, chiaveIdempotenza: riga.chiaveIdempotenza, ripiego: ripiegoRef.current,
            });
            if (!ancora()) return;
            if (!apertura.ok) { aggiorna(jobId, { fase: 'interrotto', messaggio: apertura.messaggio }); return; }
            const aperto = apertura.dati;
            if (aperto.jobId !== jobId || aperto.intentId !== intentId) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'video-ripresa-identita-diversa' });
                aggiorna(jobId, { fase: 'interrotto', messaggio: frase('VIDEO_NON_AUTORIZZATO') }); return;
            }
            if (aperto.statoIntent === 'published') { await archivio.elimina(jobId); if (ancora()) togli(jobId); return; }
            if (['cancelled', 'superseded'].includes(aperto.statoIntent) || aperto.statoJob === 'cancelled') {
                aggiorna(jobId, { fase: 'annullato', percentuale: null }); return;
            }
            if (['failed', 'rejected'].includes(aperto.statoJob)) {
                const stato = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
                if (ancora()) aggiorna(jobId, { fase: 'fallito', percentuale: null, messaggio: frase(stato.ok ? stato.dati.job.find(j => j.jobId === jobId)?.codice ?? 'VIDEO_RIPROVA' : 'VIDEO_RIPROVA') }); return;
            }
            let trasferito = !aperto.needsUpload;
            let byteCaricati = riga.dimensioneByte;
            if (aperto.needsUpload) {
                if (riga.stato === 'caricato') { aggiorna(jobId, { fase: 'interrotto', messaggio: frase('VIDEO_RIPROVA') }); return; }
                firmeRef.current.set(jobId, { token: aperto.firma, scade: Date.parse(aperto.expiresAt ?? '') || 0 });
                aggiorna(jobId, { fase: 'caricamento', messaggio: null });
                const esito = await caricaVideo(dipendenze(jobId), jobId, { alProgresso: (fatti, totali) => {
                    if (ancora()) aggiorna(jobId, { percentuale: totali > 0 ? Math.min(100, Math.round(fatti / totali * 100)) : null });
                } });
                if (!ancora()) return;
                if (esito.esito !== 'caricato') {
                    aggiorna(jobId, { fase: esito.esito === 'fallito' ? 'fallito' : esito.esito === 'annullato' ? 'annullato' : 'interrotto', messaggio: 'codice' in esito && esito.codice ? frase(esito.codice) : null }); return;
                }
                trasferito = true;
                byteCaricati = esito.byteCaricati;
            } else if (riga.stato !== 'caricato') {
                await archivio.aggiorna(jobId, { stato: 'caricato', offsetByte: riga.dimensioneByte, aggiornatoIl: new Date().toISOString() });
                await archivio.eliminaByte(jobId);
            }
            if (!ancora() || !trasferito) return;
            let stato: StatoIntentoVideo | null = null;
            if (aperto.statoJob === 'awaiting_upload') {
                const caricato = await segnalaVideoCaricato(fetch, { intentId, jobId, byte: byteCaricati, mime: riga.mime, ripiego: ripiegoRef.current });
                if (!ancora()) return;
                if (caricato.ok) stato = caricato.dati;
                else {
                    const letto = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
                    if (!ancora()) return;
                    if (!letto.ok || letto.dati.job.find(j => j.jobId === jobId)?.stato === 'awaiting_upload') {
                        aggiorna(jobId, { fase: 'interrotto', messaggio: caricato.messaggio }); return;
                    }
                    stato = letto.dati;
                }
            } else {
                const letto = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
                if (!ancora()) return;
                if (!letto.ok) { aggiorna(jobId, { fase: 'interrotto', messaggio: letto.messaggio }); return; }
                stato = letto.dati;
            }
            if (stato.statoIntent === 'pending') {
                const confermato = await confermaIntentoVideo(fetch, { intentId, revisione: stato.revisione || revisione, ripiego: ripiegoRef.current });
                if (!ancora()) return;
                if (confermato.ok) stato = confermato.dati;
                else {
                    const letto = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
                    if (!ancora()) return;
                    if (!letto.ok || letto.dati.statoIntent === 'pending') { aggiorna(jobId, { fase: 'interrotto', messaggio: confermato.messaggio }); return; }
                    stato = letto.dati;
                }
            }
            if (stato.statoIntent === 'published') { await archivio.elimina(jobId); if (ancora()) togli(jobId); return; }
            const job = stato.job.find(j => j.jobId === jobId);
            if (job && ancora()) aggiorna(jobId, { revisione: stato.revisione, fase: ['cancelled', 'superseded'].includes(stato.statoIntent) ? 'annullato' : faseDelJob(job.stato), percentuale: null, messaggio: job.codice ? frase(job.codice) : null });
        };
        const promessa = esegui().catch((err: unknown) => {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'video-ripresa-interrotta', campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' } });
            if (ancora()) aggiorna(jobId, { fase: 'interrotto', messaggio: ripiegoRef.current });
        }).finally(() => { seguendoRef.current.delete(chiave); });
        seguendoRef.current.set(chiave, promessa);
        return promessa;
    }, [aggiorna, dipendenze, frase, togli]);

    /* ────────────────────────────────────────────────────────────────────────
     * AVVIARE
     * ──────────────────────────────────────────────────────────────────────── */

    const avviaVideo = useCallback<ApiVideoGalleria['avviaVideo']>(
        async (file, scelta) => {
            const sede = opzioniRef.current.sede;
            if (!sede || !opzioniRef.current.utenteId) {
                // NON si indovina il plesso. `SEDE_DA_SPECIFICARE` è il codice che
                // `rifiutoSede` manda già da 137 route, con la sua voce di catalogo:
                // inventarne un secondo per i video vorrebbe dire due frasi diverse
                // per lo stesso rifiuto.
                return { ok: false, messaggio: frase('SEDE_DA_SPECIFICARE') };
            }
            const archivio = archivioRef.current;
            if (!archivio) return { ok: false, messaggio: ripiegoRef.current };

            const rifiuto = rifiutoLocaleVideo(file, scelta.durataSecondi);
            if (rifiuto) return { ok: false, messaggio: frase(rifiuto) };

            const owner = opzioniRef.current.utenteId!;
            let chiave = chiaveIdempotenzaVideo(file);
            let apertura = await apriIntentoVideoGalleria(fetch, {
                file,
                scuolaId: sede,
                durataSecondi: scelta.durataSecondi,
                chiaveIdempotenza: chiave,
                ripiego: ripiegoRef.current,
            });
            if (!apertura.ok) return { ok: false, messaggio: apertura.messaggio };

            if (opzioniRef.current.utenteId !== owner || opzioniRef.current.sede !== sede) return { ok: false, messaggio: frase('VIDEO_NON_AUTORIZZATO') };
            if (apertura.dati.statoIntent === 'published') return { ok: true };
            if (['cancelled', 'superseded'].includes(apertura.dati.statoIntent)) return { ok: false, messaggio: frase('VIDEO_RIPROVA') };
            if (['failed', 'rejected'].includes(apertura.dati.statoJob)) {
                chiave = `${chiave}-${crypto.randomUUID()}`;
                apertura = await apriIntentoVideoGalleria(fetch, { file, scuolaId: sede, durataSecondi: scelta.durataSecondi, chiaveIdempotenza: chiave, ripiego: ripiegoRef.current });
                if (!apertura.ok) return { ok: false, messaggio: apertura.messaggio };
                if (opzioniRef.current.utenteId !== owner || opzioniRef.current.sede !== sede) return { ok: false, messaggio: frase('VIDEO_NON_AUTORIZZATO') };
            }
            const { jobId, intentId, revisione, coordinate, firma, chiaveIdempotenza } = apertura.dati;
            firmeRef.current.set(jobId, { token: firma, scade: Date.parse(apertura.dati.expiresAt ?? '') || 0 });

            const messo = await accodaCaricamentoVideo(dipendenze(jobId), {
                jobId,
                intentId,
                canale: 'gallery',
                ownerId: owner, scuolaId: sede,
                chiaveIdempotenza,
                coordinate,
                file,
            });
            if (!messo.ok) return { ok: false, messaggio: frase(messo.codice) };
            if (!montatoRef.current || opzioniRef.current.utenteId !== owner || opzioniRef.current.sede !== sede) return { ok: false, messaggio: frase('VIDEO_NON_AUTORIZZATO') };

            // I tag si ricordano QUI, in memoria: sono identificativi di minori e su
            // disco non ci vanno. Se l'app si chiude prima che il video sia pronto,
            // al rientro la scheda li richiede — vedi la testata.
            setTagPerJob((prev) => ({ ...prev, [jobId]: { tag: scelta.tag, broadcast: scelta.broadcast } }));
            metti({
                jobId, ownerId: owner, scuolaId: sede,
                intentId,
                revisione,
                nome: file.name,
                fase: 'caricamento',
                percentuale: 0,
                messaggio: null,
                chiedeTag: false,
            });

            // NON si aspetta: da qui in poi il caricamento vive per conto suo e la
            // schermata torna alla galleria, dove la scheda racconta a che punto è.
            // Aspettarlo terrebbe l'insegnante ferma davanti a una rotellina per
            // tutto il tempo del trasferimento.
            void segui(jobId, intentId, revisione);
            return { ok: true };
        },
        [dipendenze, frase, metti, segui],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * GLI ALTRI GESTI
     * ──────────────────────────────────────────────────────────────────────── */

    const riprendi = useCallback(
        (jobId: string) => {
            const voce = vociRef.current.find((v) => v.jobId === jobId);
            if (!voce) return;
            void segui(jobId, voce.intentId, voce.revisione);
        },
        [segui],
    );

    const rimuovi = useCallback(
        (jobId: string) => {
            const voce = vociRef.current.find((v) => v.jobId === jobId);
            if (!voce || voce.ownerId !== opzioniRef.current.utenteId || voce.scuolaId !== opzioniRef.current.sede) return;
            annullatiRef.current.add(jobId);
            togli(jobId);
            void (async () => {
                if (voce) {
                    // Il ritiro dell'intento è anche ciò che libera l'originale dal
                    // bucket privato: senza, resterebbe lì fino alla scadenza dei sette
                    // giorni della retention.
                    await annullaIntentoVideo(fetch, {
                        intentId: voce.intentId,
                        revisione: voce.revisione,
                        ripiego: ripiegoRef.current,
                    });
                }
                if (archivioRef.current) {
                    // Chiude il lato CLIENT: termina la sessione TUS se è aperta, così
                    // nel bucket non resta un troncone che nessuno cerca.
                    await annullaCaricamentoVideo(dipendenze(jobId), jobId);
                    await archivioRef.current.elimina(jobId);
                }
            })().catch((err: unknown) => logClient({ livello: 'error', evento: 'offline', messaggio: 'video-annullamento-interrotto', campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' } }));
        },
        [dipendenze, togli],
    );

    const cambiaTag = useCallback((jobId: string, alunnoId: string) => {
        setTagPerJob((prev) => {
            const corrente = prev[jobId] ?? { tag: [], broadcast: false };
            const gia = corrente.tag.includes(alunnoId);
            return {
                ...prev,
                [jobId]: {
                    ...corrente,
                    tag: gia ? corrente.tag.filter((id) => id !== alunnoId) : [...corrente.tag, alunnoId],
                },
            };
        });
    }, []);

    const tagDi = useCallback((jobId: string) => tagPerJob[jobId]?.tag ?? [], [tagPerJob]);

    /* ────────────────────────────────────────────────────────────────────────
     * IL RIENTRO NELL'APP
     * ──────────────────────────────────────────────────────────────────────── */

    useEffect(() => {
        let vivo = true;
        const owner = opzioni.utenteId;
        const sede = opzioni.sede;
        void (async () => {
            await Promise.resolve();
            if (!vivo) return;
            setVoci([]); setTagPerJob({}); firmeRef.current.clear();
            if (!owner || !sede) return;
            const archivio = await creaArchivioCaricamenti();
            if (!vivo) return;
            archivioRef.current = archivio;
            await potaArchivioCaricamenti({ archivio, intestazioni: () => ({}) });
            const righe = (await archivio.elenca()).filter(r => caricamentoNelContesto(r, owner, sede, 'gallery'));
            if (!vivo) return;
            for (const riga of righe) {
                if (!['caricato', 'in_corso', 'da_caricare'].includes(riga.stato)) continue;
                metti({ jobId: riga.jobId, ownerId: owner, scuolaId: sede, intentId: riga.intentId, revisione: 1,
                    nome: riga.nome, fase: 'interrotto', percentuale: null, messaggio: null, chiedeTag: true });
                void segui(riga.jobId, riga.intentId, 1);
            }
        })().catch((err: unknown) => {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'video-archivio-non-disponibile', campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' } });
        });
        return () => { vivo = false; };
    }, [opzioni.utenteId, opzioni.sede, metti, segui]);

    /* ────────────────────────────────────────────────────────────────────────
     * IL POLLING — solo mentre qualcuno guarda
     * ──────────────────────────────────────────────────────────────────────── */

    const daInterrogare = voci.filter((v) => DA_INTERROGARE.has(v.fase));

    usePollingVisibile(
        async () => {
            // Un intento per volta e una richiesta per intento: dieci richieste per
            // giro di polling su rete mobile sono il difetto misurato il 2026-09-07,
            // 2,23 milioni di richieste al giorno.
            const intenti = [...new Set(vociRef.current.filter((v) => DA_INTERROGARE.has(v.fase)).map((v) => v.intentId))];
            for (const intentId of intenti) {
                const stato = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
                if (stato.ok) applicaStato(stato.dati);
            }
        },
        RITMO_POLLING_MS,
        { attivo: daInterrogare.length > 0 },
    );

    /* ────────────────────────────────────────────────────────────────────────
     * LA PUBBLICAZIONE AUTOMATICA DI CHI È RIMASTO A GUARDARE
     * ──────────────────────────────────────────────────────────────────────── */

    useEffect(() => {
        for (const voce of voci) {
            // Chi ha aspettato non deve premere niente: i bambini li ha già scelti al
            // passo 2, e chiederglieli di nuovo sarebbe lavoro rifatto. Chi invece è
            // rientrato dopo aver chiuso l'app li ha persi, e la scheda glieli chiede.
            //
            // ⚠️ UNA VOLTA SOLA. Il guardiano è `autoTentatoRef` e non «sta
            // pubblicando adesso»: un rifiuto riporta la scheda a «pronto», e con il
            // secondo guardiano questo effetto ripartiva all'infinito — 992 richieste
            // in 120 ms nel caso misurato.
            if (
                voce.fase === 'pronto'
                && !voce.chiedeTag
                && !autoTentatoRef.current.has(voce.jobId)
            ) {
                autoTentatoRef.current.add(voce.jobId);
                pubblica(voce.jobId);
            }
        }
    }, [voci, pubblica]);

    const righe: RigaVideoLavorazione[] = voci.map((v) => ({
        jobId: v.jobId,
        nome: v.nome,
        fase: v.fase,
        percentuale: v.percentuale,
        messaggio: v.messaggio,
        chiedeTag: v.chiedeTag,
        tagScelti: tagPerJob[v.jobId]?.tag.length ?? 0,
    }));

    return { righe, tagDi, cambiaTag, avviaVideo, riprendi, rimuovi, pubblica };
}
