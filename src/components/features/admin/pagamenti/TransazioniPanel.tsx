'use client';

// ─── Vista «Incasso unico» (Contabilità v2 S4) ────────────────────────────────
// Registra UN pagamento di famiglia (un bonifico/POS) che salda più voci di più
// figli e ricarica la mensa, con quadratura live e — solo su conferma esplicita —
// eccedenza a credito famiglia. Wizard a 3 passi:
//   (a) pagante  → ricerca tutori, GET /api/pagamenti/famiglia
//   (b) importi  → voci per figlio (checkbox + importo) + proposta automatica +
//                  ricariche mensa (euro + ticket) + quadratura live
//   (c) conferma → dialog eccedenza→credito (mai silenzioso); post-salvataggio
//                  ricevuta famiglia PDF o «dividi in fatture»
// In fondo: registro transazioni con annullo (motivo obbligatorio) e ristampa.
//
// PIÙ SEDI (contratto K4, 2026-09-26). `scuolaId` è null quando le sedi
// selezionate sono più d'una. Il pannello NON manda più `scuola_id` nella POST:
// la sede la decide il server, voce per voce (`pagamenti.scuola_id`) e alunno per
// alunno per le ricariche (`alunni.scuola_id`), e se le sedi sono più d'una il
// pagamento diventa UNA transazione per sede, tutte o nessuna. Qui si deve:
//   · dirlo PRIMA di confermare, con il riepilogo per sede;
//   · con un'eccedenza a credito, far scegliere la sede del credito (obbligatorio:
//     il server risponde 422 SEDE_ECCEDENZA_MANCANTE senza);
//   · mostrare una ricevuta per ogni transazione creata;
//   · nel registro, le colonne Sede e Pagante.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Coins, Search, Wand2, X, RotateCcw, FileText, UtensilsCrossed, ArrowLeft, Check, Printer } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { Modal } from '@/components/ui/Modal';
import { cx } from '@/lib/ui/cx';
import { Badge } from '@/components/ui/Badge';
import { formatEuro } from '@/lib/format/valuta';
import { INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY, MODAL_CARD, MODAL_SHADOW } from './ui';
import { FatturaButton } from './FatturaButton';
import { LinkDocumento } from './LinkDocumento';
import { proponiAllocazione, round2 } from '@/lib/pagamenti/transazioni-quadratura';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Precompilazione del wizard «Incasso unico» quando lo si apre da un bonifico
 * multi-CF della Riconciliazione: pagante risolto (o null → step «scegli
 * pagante»), riferimento/CRO dalla causale, totale dall'importo del movimento e
 * alunni riconosciuti (per pre-spuntare solo le loro voci).
 */
export interface PrecompilaTransazione {
    parent?: string | null;
    rif?: string | null;
    tot?: number | null;
    alunni?: string[] | null;
}

/** `scuolaId` null = più sedi selezionate (nessuna sede «di pagina»). */
interface Props { userId: string; scuolaId: string | null; precompila?: PrecompilaTransazione | null }

interface ParentLite { id: string; first_name?: string | null; last_name?: string | null; scuole_ids?: string[] | null }
interface Figlio {
    id: string; nome: string | null; cognome: string | null; saldo_ticket: number;
    scuola_id?: string | null; scuola_nome?: string | null;
}
interface Voce {
    id: string; alunno_id: string; descrizione?: string | null;
    importo: number; importo_pagato: number; sconto?: number;
    scadenza?: string | null; stato_effettivo?: string; residuo: number;
    /** Sede della VOCE (`pagamenti.scuola_id`): decide in quale transazione finisce. */
    scuola_id?: string | null; scuola_nome?: string | null;
}
interface Famiglia { parent: { id: string; nome: string }; figli: Figlio[]; voci: Voce[]; credito: number }
interface TxRow {
    id: string; pagante_parent_id: string; importo_totale: number; metodo: string;
    riferimento?: string | null; data_valuta?: string | null; note?: string | null;
    annullata_il?: string | null; creato_il?: string | null;
    /** Sede della transazione: la GET la dà sempre; il nome può mancare (`nomi-sede-non-letti`). */
    scuola_id?: string | null; scuola_nome?: string | null; pagante_nome?: string | null;
}
/** Un elemento di `data.transazioni` della POST (una transazione per sede). */
interface EsitoTx {
    transazione_id: string | null; scuola_id: string | null;
    scuola_nome: string | null; importo_totale: number | null;
}
/** Una sede toccata dall'operazione, con quanto le spetta. `chiave` '' = sede ignota. */
interface GruppoSede { chiave: string; id: string | null; nome: string; somma: number }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
// Gli uuid si confrontano in minuscolo: il maiuscolo è la stessa sede (come
// `formaConfronto` lato server).
const chiaveSede = (id?: string | null) => (id ? id.trim().toLowerCase() : '');
const nomeFiglio = (f?: { nome?: string | null; cognome?: string | null } | null) =>
    `${f?.nome ?? ''} ${f?.cognome ?? ''}`.trim() || 'Alunno';

const METODI = [
    { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' },
    { v: 'contanti', l: 'Contanti' },
    { v: 'assegno', l: 'Assegno' },
    { v: 'altro', l: 'Altro' },
];

type Ricarica = { euro: string; ticket: string };

/**
 * Un caricamento non riuscito: `corpo` è il JSON della risposta rifiutata dal server
 * (`{ error, codice? }`), oppure null per un guasto di rete o un corpo illeggibile.
 * Il testo si ricava al render con `messaggioDaCorpo`, così i loader non dipendono
 * dal traduttore.
 */
type ErroreCarica = { corpo: unknown };

/** Etichetta di sede accanto a pagante, figlio, voce. */
function BadgeSede({ nome }: { nome: string }) {
    return <Badge tone="neutral" className="px-2 py-0.5 text-[10.5px]">{nome}</Badge>;
}

export function TransazioniPanel({ userId, scuolaId, precompila }: Props) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    const { sedi } = useSediAttive();
    // Nome di una sede: quello dato dal server sulla riga, poi l'elenco delle sedi
    // accessibili, e solo in ultimo «sede non indicata» (mai un uuid a schermo).
    const nomeSede = (id?: string | null, nomeServer?: string | null) =>
        nomeServer || sedi.find((s) => chiaveSede(s.id) === chiaveSede(id))?.nome || t('transSedeIgnota');
    // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
    const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
    const [step, setStep] = useState<'pagante' | 'importi'>('pagante');

    // Step (a) — ricerca pagante.
    const [query, setQuery] = useState('');
    const [parents, setParents] = useState<ParentLite[]>([]);
    const [loadingParents, setLoadingParents] = useState(true);
    // null = elenco caricato; altrimenti il corpo della risposta rifiutata (null per
    // un guasto di rete), da cui `messaggioDaCorpo` ricava il testo a schermo.
    const [parentsErrore, setParentsErrore] = useState<ErroreCarica | null>(null);
    const [fam, setFam] = useState<Famiglia | null>(null);

    // Step (b) — importi.
    const [totale, setTotale] = useState('');
    const [metodo, setMetodo] = useState('bonifico');
    const [riferimento, setRiferimento] = useState('');
    const [dataValuta, setDataValuta] = useState(() => new Date().toISOString().slice(0, 10));
    const [note, setNote] = useState('');
    const [alloc, setAlloc] = useState<Record<string, string>>({}); // voce.id → importo (assente = esclusa)
    const [ric, setRic] = useState<Record<string, Ricarica>>({});    // alunno_id → { euro, ticket }

    // Dialog eccedenza + esito. Il ref sul bottone che apre il dialog serve al
    // ripristino del focus (WCAG 2.4.3): durante la POST async il bottone è
    // `disabled`, quindi al capture del Modal activeElement è già <body>.
    const registraBtnRef = useRef<HTMLButtonElement>(null);
    const [confermaEcc, setConfermaEcc] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Famiglia della precompilazione non caricata: il CORPO della risposta (o `rete`),
    // tradotto al render come per registro e paganti — così l'effetto non dipende da `t`.
    const [precompilaErrore, setPrecompilaErrore] = useState<{ corpo: unknown; rete?: boolean } | null>(null);
    const [fatto, setFatto] = useState<{ transazioni: EsitoTx[]; voci: Voce[] } | null>(null);
    // Sede a cui attribuire l'eccedenza quando l'operazione tocca più sedi ('' = non scelta).
    const [sedeEcc, setSedeEcc] = useState('');

    // Registro transazioni.
    const [registro, setRegistro] = useState<TxRow[]>([]);
    const [registroDisp, setRegistroDisp] = useState(true);
    const [loadingRegistro, setLoadingRegistro] = useState(true);
    const [registroErrore, setRegistroErrore] = useState<ErroreCarica | null>(null);
    const [annullaTx, setAnnullaTx] = useState<TxRow | null>(null);

    // ── Loader registro ──────────────────────────────────────────────────────
    // Forma obbligata da react-hooks/set-state-in-effect (errore nel gate), la stessa
    // documentata in admin/students/page.tsx e admin/page.tsx: NIENTE blocco `catch`
    // (un setState lì è raggiungibile in modo sincrono), il guasto si intercetta con
    // `.catch()` DELLA PROMISE, che logga col solo nome dell'errore e restituisce un
    // esito; e il `try { … } finally { setLoading… }` resta, perché è la forma che
    // l'analisi riconosce.
    // Due guasti diversi, stesso esito a schermo (un avviso d'errore, MAI «Nessuna
    // transazione registrata.» né «Registro non disponibile su questo ambiente.»):
    //  · la fetch che rigetta o il corpo non JSON → `.catch()`;
    //  · la risposta HTTP d'errore (500 `{ error }`, 401/403 del gate) o un 200 senza
    //    `success: true` → la fetch NON rigetta, quindi va controllato `r.ok`.
    // «Non disponibile» resta al SOLO caso che il server dichiara: 200
    // `{ success: true, disponibile: false }` (tabella assente sul DB non migrato).
    const caricaRegistro = useCallback(async () => {
        type CorpoRegistro = { success?: boolean; data?: TxRow[]; disponibile?: boolean };
        type Esito = { errore: ErroreCarica | null; j: CorpoRegistro | null };
        try {
            const esito: Esito = await fetch('/api/pagamenti/transazioni', { headers: hdr(userId) })
                .then(async (r): Promise<Esito> => {
                    const j = (await r.json()) as CorpoRegistro | null;
                    if (!r.ok || j?.success !== true) {
                        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'transazioni-registro-http', stato: r.status });
                        return { errore: { corpo: j }, j: null };
                    }
                    return { errore: null, j };
                })
                .catch((err: unknown): Esito => {
                    logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-registro-rete: ${nomeErrore(err)}` });
                    return { errore: { corpo: null }, j: null };
                });
            setRegistroErrore(esito.errore);
            if (esito.j) { setRegistro(esito.j.data ?? []); setRegistroDisp(esito.j.disponibile !== false); }
        } finally {
            setLoadingRegistro(false);
        }
    }, [userId]);

    useEffect(() => { caricaRegistro(); }, [caricaRegistro]);

    // ── Step (a): ricerca pagante ─────────────────────────────────────────────
    // Stessa forma del registro: né la fetch che rigetta né una risposta HTTP d'errore
    // (500 `{ error }`, 401/403 del gate) si travestono da «Nessun tutore trovato.».
    // È un elenco valido SOLO una risposta `r.ok` il cui corpo è un array o `{ data: [] }`.
    const cercaParents = useCallback(async () => {
        type Esito = { errore: ErroreCarica | null; lista: ParentLite[] };
        try {
            const esito: Esito = await fetch('/api/admin/parents', { headers: hdr(userId) })
                .then(async (r): Promise<Esito> => {
                    const j = (await r.json()) as unknown;
                    const dati = (j as { data?: unknown } | null)?.data;
                    const lista = !r.ok ? null : Array.isArray(j) ? j : Array.isArray(dati) ? dati : null;
                    if (lista === null) {
                        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'transazioni-paganti-http', stato: r.status });
                        return { errore: { corpo: j }, lista: [] };
                    }
                    return { errore: null, lista: lista as ParentLite[] };
                })
                .catch((err: unknown): Esito => {
                    logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-paganti-rete: ${nomeErrore(err)}` });
                    return { errore: { corpo: null }, lista: [] };
                });
            setParentsErrore(esito.errore);
            setParents(esito.lista);
        } finally {
            setLoadingParents(false);
        }
    }, [userId]);

    useEffect(() => { cercaParents(); }, [cercaParents]);

    const parentsFiltrati = parents
        .filter((p) => {
            const nome = `${p.first_name ?? ''} ${p.last_name ?? ''}`.toLowerCase();
            return query.trim().length === 0 || nome.includes(query.trim().toLowerCase());
        })
        .slice(0, 40);

    // Applica una famiglia caricata allo step «importi»: pre-spunta le voci con il
    // loro residuo effettivo (modificabili). `soloAlunni` restringe la pre-spunta
    // agli alunni riconosciuti dal bonifico multi-CF (precompilazione); assente =
    // tutte le voci (scelta manuale del pagante). NON tocca il totale: così un
    // totale già precompilato sopravvive alla scelta manuale del pagante.
    const applicaFamiglia = useCallback((f: Famiglia, soloAlunni?: string[] | null) => {
        const filtro = soloAlunni && soloAlunni.length > 0 ? new Set(soloAlunni) : null;
        const initAlloc: Record<string, string> = {};
        for (const v of f.voci) {
            if (filtro && !filtro.has(v.alunno_id)) continue;
            initAlloc[v.id] = String(v.residuo);
        }
        setFam(f);
        setAlloc(initAlloc);
        setRic({});
        setSedeEcc('');
        setStep('importi');
        setFatto(null);
    }, []);

    const selezionaPagante = async (p: ParentLite) => {
        setError(null);
        setPrecompilaErrore(null);
        try {
            const r = await fetch(`/api/pagamenti/famiglia?parent_id=${p.id}`, { headers: hdr(userId) });
            const j = await r.json();
            if (!r.ok || j?.success !== true) {
                // Risposta HTTP d'errore (500 `{ error }`, 401/403 del gate): la fetch non
                // rigetta, quindi il `catch` sotto non la vede. Solo lo stato, mai il pagante.
                logClient({ livello: 'warn', evento: 'fetch', messaggio: 'transazioni-famiglia-http', stato: r.status });
                setError(messaggioDaCorpo(j, t('transErrCaricaFamiglia')));
                return;
            }
            applicaFamiglia(j.data as Famiglia);
        } catch (err) {
            // È la GET da cui arrivano anche `scuola_id`/`scuola_nome` di figli e voci:
            // se cade deve restarne traccia. Solo il NOME dell'errore, mai il pagante.
            logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-famiglia-rete: ${nomeErrore(err)}` });
            setError(t('transErrReteFamiglia'));
        }
    };

    // ── Precompilazione da bonifico multi-CF (Riconciliazione v2) ──────────────
    // All'apertura da «Apri Incasso unico»: se il pagante è risolto carica la sua
    // famiglia e va allo step «importi» (voci degli alunni riconosciuti pre-spuntate);
    // altrimenti resta su «scegli pagante». In entrambi i casi imposta totale e
    // riferimento. setState SOLO dopo un await (mai sincrono nell'effetto →
    // react-hooks/set-state-in-effect).
    useEffect(() => {
        if (!precompila) return;
        let active = true;
        (async () => {
            const { parent, rif, tot, alunni } = precompila;
            if (parent) {
                let f: Famiglia | null = null;
                // Perché la famiglia non è arrivata: corpo della risposta HTTP d'errore, o rete.
                let errore: { corpo: unknown; rete?: boolean } | null = null;
                try {
                    const r = await fetch(`/api/pagamenti/famiglia?parent_id=${parent}`, { headers: hdr(userId) });
                    const j = await r.json();
                    if (r.ok && j?.success === true) {
                        f = j.data as Famiglia;
                    } else {
                        // 500 `{ error }` (con K4: lettura di figli/voci/ticket fallita) o
                        // 401/403 del gate: la fetch non rigetta, quindi il `catch` non la vede.
                        // Senza questo ramo si resterebbe su «scegli pagante» in silenzio.
                        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'transazioni-precompila-famiglia-http', stato: r.status });
                        errore = { corpo: j };
                    }
                } catch (err) {
                    // Si degrada allo step «scegli pagante», ma il guasto si registra.
                    logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-precompila-famiglia-rete: ${nomeErrore(err)}` });
                    f = null;
                    errore = { corpo: null, rete: true };
                }
                if (!active) return;
                // Famiglia non caricabile → degrada allo step «scegli pagante», con l'avviso.
                if (f) applicaFamiglia(f, alunni);
                else setPrecompilaErrore(errore);
            } else {
                await Promise.resolve(); // confine microtask: il setState sotto non è sincrono
                if (!active) return;
            }
            if (!active) return;
            if (tot != null) setTotale(String(tot));
            if (rif) setRiferimento(rif);
        })();
        return () => { active = false; };
    }, [precompila, userId, applicaFamiglia]);

    // ── Step (b): quadratura ──────────────────────────────────────────────────
    const totaleNum = Number(totale) || 0;
    const vociIncluse = (fam?.voci ?? []).filter((v) => alloc[v.id] !== undefined && Number(alloc[v.id]) > 0);
    const allocatoVoci = round2(vociIncluse.reduce((s, v) => s + Number(alloc[v.id] || 0), 0));
    const ricInclusi = Object.entries(ric)
        .map(([alunno_id, r]) => ({ alunno_id, euro: Number(r.euro) || 0, ticket: Math.trunc(Number(r.ticket) || 0) }))
        .filter((r) => r.euro > 0 && r.ticket > 0);
    const allocatoRic = round2(ricInclusi.reduce((s, r) => s + r.euro, 0));
    const allocato = round2(allocatoVoci + allocatoRic);
    const differenza = round2(totaleNum - allocato);
    const hasRigheOltreTotale = Object.entries(ric).some(([, r]) => (Number(r.euro) > 0) !== (Math.trunc(Number(r.ticket) || 0) > 0));
    const eccedenza = differenza > 0.005 ? differenza : 0;

    // ── Più sedi ──────────────────────────────────────────────────────────────
    // Sedi della FAMIGLIA (figli + voci): decidono se mostrare la sede accanto a
    // figli e voci. Sedi dell'OPERAZIONE (righe incluse): decidono se il server
    // dividerà il pagamento. Stesso ordine del server: voci, poi ricariche.
    const sediFamiglia = new Set(
        [...(fam?.figli ?? []).map((x) => x.scuola_id), ...(fam?.voci ?? []).map((v) => v.scuola_id)]
            .map(chiaveSede).filter(Boolean),
    );
    const famigliaMultiSede = sediFamiglia.size > 1;
    const gruppiSede: GruppoSede[] = [];
    const aggiungiAGruppo = (id: string | null | undefined, nomeServer: string | null | undefined, importo: number) => {
        const chiave = chiaveSede(id);
        let g = gruppiSede.find((x) => x.chiave === chiave);
        if (!g) { g = { chiave, id: id ?? null, nome: nomeSede(id, nomeServer), somma: 0 }; gruppiSede.push(g); }
        g.somma = round2(g.somma + importo);
    };
    for (const v of vociIncluse) aggiungiAGruppo(v.scuola_id, v.scuola_nome, Number(alloc[v.id] || 0));
    for (const r of ricInclusi) {
        const figlio = fam?.figli.find((x) => x.id === r.alunno_id);
        aggiungiAGruppo(figlio?.scuola_id, figlio?.scuola_nome, r.euro);
    }
    const operazioneMultiSede = gruppiSede.length > 1;
    const serveSedeEcc = operazioneMultiSede && eccedenza > 0;
    // Una scelta fatta prima e poi resa estranea (voce tolta) non vale più: si
    // ricava, non si corregge con un effetto.
    const gruppoEcc = serveSedeEcc && sedeEcc ? gruppiSede.find((g) => g.chiave !== '' && g.chiave === chiaveSede(sedeEcc)) ?? null : null;

    const toggleVoce = (v: Voce) => {
        setAlloc((prev) => {
            const next = { ...prev };
            if (next[v.id] !== undefined) delete next[v.id];
            else next[v.id] = String(v.residuo);
            return next;
        });
    };
    const setVoceImporto = (id: string, val: string) => setAlloc((prev) => ({ ...prev, [id]: val }));

    const proponi = () => {
        if (!fam) return;
        if (totaleNum <= 0) { setError(t('transErrImportoTotale')); return; }
        setError(null);
        // Capienza = totale meno quanto già destinato alle ricariche mensa; le voci
        // sono già ordinate dal server (più vecchie prima).
        setAlloc(proponiAllocazione(fam.voci, round2(totaleNum - allocatoRic)));
    };

    const setRicarica = (alunnoId: string, campo: keyof Ricarica, val: string) => {
        setRic((prev) => {
            const base: Ricarica = prev[alunnoId] ?? { euro: '', ticket: '' };
            return { ...prev, [alunnoId]: { ...base, [campo]: val } };
        });
    };

    // ── Salvataggio ───────────────────────────────────────────────────────────
    const puoConfermare = !!fam && totaleNum > 0 && (vociIncluse.length > 0 || ricInclusi.length > 0) && differenza >= -0.005 && !hasRigheOltreTotale
        && (!serveSedeEcc || gruppoEcc != null);

    const invia = async (confermaEccedenza: boolean) => {
        if (!fam) return;
        setSaving(true);
        setError(null);
        try {
            // Niente `scuola_id`: la sede la decide il server (contratto K4).
            const payload: Record<string, unknown> = {
                pagante_parent_id: fam.parent.id,
                metodo,
                riferimento: riferimento.trim() || null,
                data_valuta: dataValuta || null,
                note: note.trim() || null,
                importo_totale: totaleNum,
                voci: vociIncluse.map((v) => ({ pagamento_id: v.id, importo: round2(Number(alloc[v.id])) })),
                ricariche_mensa: ricInclusi.map((r) => ({ alunno_id: r.alunno_id, importo: round2(r.euro), ticket: r.ticket })),
                eccedenza_a_credito: eccedenza,
            };
            if (serveSedeEcc && gruppoEcc?.id) payload.sede_eccedenza = gruppoEcc.id;
            if (confermaEccedenza) payload.conferma_eccedenza = 'credito_famiglia';

            const res = await fetch('/api/pagamenti/transazioni', {
                method: 'POST', headers: hdr(userId), body: JSON.stringify(payload),
            });
            const j = await res.json();
            // Eccedenza mai silenziosa: 409 → apri la conferma esplicita «credito famiglia».
            if (res.status === 409 && j.eccedenza != null) { setConfermaEcc(Number(j.eccedenza)); return; }
            // Ogni errore chiude il dialogo dell'eccedenza: i 422 SEDE_ECCEDENZA_* (e i
            // 403/500/503) arrivano proprio dalla POST confermata, lanciata DA quel
            // dialogo, e con il dialogo aperto il resto della pagina è inerte: l'avviso
            // resterebbe invisibile e muto per lo screen reader.
            if (!res.ok) { setConfermaEcc(null); setError(messaggioDaCorpo(j, t('transErrRegistrazione'))); return; }
            setConfermaEcc(null);
            // `transazioni[]` è sempre presente dal 26/09; un server più vecchio dà solo
            // `transazione_id`, e allora la transazione è una.
            const elenco: EsitoTx[] = Array.isArray(j.data?.transazioni) && j.data.transazioni.length > 0
                ? (j.data.transazioni as EsitoTx[])
                : [{ transazione_id: j.data?.transazione_id ?? null, scuola_id: null, scuola_nome: null, importo_totale: totaleNum }];
            const senzaId = elenco.filter((x) => !x.transazione_id).length;
            if (senzaId > 0) {
                // Il server ha scritto (200) ma non ha restituito l'id di qualche
                // transazione: la ricevuta di quella sede non si può aprire da qui.
                logClient({ livello: 'warn', evento: 'fetch', messaggio: 'transazioni-esito-senza-id', campi: { n: senzaId, sedi: elenco.length } });
            }
            setFatto({ transazioni: elenco, voci: vociIncluse });
            void caricaRegistro();
        } catch (err) {
            logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-registrazione-rete: ${nomeErrore(err)}` });
            setConfermaEcc(null);
            setError(t('transErrRete'));
        }
        finally { setSaving(false); }
    };

    const reset = () => {
        setStep('pagante'); setFam(null); setFatto(null); setError(null); setPrecompilaErrore(null);
        setTotale(''); setRiferimento(''); setNote(''); setAlloc({}); setRic({}); setSedeEcc('');
    };

    // ── Annullo transazione ───────────────────────────────────────────────────
    const [motivoAnnullo, setMotivoAnnullo] = useState('');
    const [busyAnnullo, setBusyAnnullo] = useState(false);
    const eseguiAnnullo = async () => {
        if (!annullaTx || motivoAnnullo.trim().length < 3) return;
        setBusyAnnullo(true);
        try {
            const res = await fetch(`/api/pagamenti/transazioni/${annullaTx.id}/annulla`, {
                method: 'POST', headers: hdr(userId), body: JSON.stringify({ motivo: motivoAnnullo.trim() }),
            });
            if (res.ok) { setAnnullaTx(null); setMotivoAnnullo(''); void caricaRegistro(); }
            else { const j = await res.json(); setError(messaggioDaCorpo(j, t('transErrAnnullo'))); }
        } catch (err) {
            logClient({ livello: 'warn', evento: 'fetch', messaggio: `transazioni-annullo-rete: ${nomeErrore(err)}` });
            setError(t('transErrReteAnnullo'));
        }
        finally { setBusyAnnullo(false); }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="space-y-8">
            <div>
                <SectionTitle icon={Coins} title={t('transTitolo')} sub={t('transSottotitolo')} />

                {/* STEP A — pagante */}
                {step === 'pagante' && (
                    <div className="space-y-3">
                        <div className="relative">
                            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
                            <input
                                type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                                placeholder={t('transCercaPlaceholder')}
                                className={cx(INPUT, 'pl-9')} aria-label={t('transCercaPagante')}
                            />
                        </div>
                        <div className="max-h-80 overflow-y-auto rounded-card border border-kidville-line divide-y divide-kidville-line">
                            {loadingParents && <p className="px-3 py-3 font-maven text-sm text-kidville-muted">{t('transCaricamento')}</p>}
                            {!loadingParents && parentsErrore && (
                                <p role="alert" className="px-3 py-3 font-maven text-sm text-kidville-error-strong">{messaggioDaCorpo(parentsErrore.corpo, t('transPagantiErrore'))}</p>
                            )}
                            {!loadingParents && !parentsErrore && parentsFiltrati.length === 0 && (
                                <p className="px-3 py-3 font-maven text-sm text-kidville-muted">{t('transNessunTutore')}</p>
                            )}
                            {parentsFiltrati.map((p) => (
                                <button
                                    key={p.id} type="button" onClick={() => selezionaPagante(p)}
                                    className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-kidville-green-soft"
                                >
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <span className="font-maven text-sm text-kidville-ink">{`${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '—'}</span>
                                        {/* Sedi del pagante (= sedi dei figli, `scuole_ids`): con più sedi
                                            selezionate dicono in quale plesso sta la famiglia. */}
                                        {(scuolaId == null || (p.scuole_ids?.length ?? 0) > 1) && (p.scuole_ids ?? []).map((id) => (
                                            <BadgeSede key={id} nome={nomeSede(id)} />
                                        ))}
                                    </span>
                                    <ArrowLeft size={15} className="shrink-0 rotate-180 text-kidville-muted" />
                                </button>
                            ))}
                        </div>
                        {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
                        {!error && precompilaErrore && (
                            <p role="alert" className="font-maven text-xs text-kidville-error-strong">
                                {precompilaErrore.rete ? t('transErrReteFamiglia') : messaggioDaCorpo(precompilaErrore.corpo, t('transErrCaricaFamiglia'))}
                            </p>
                        )}
                    </div>
                )}

                {/* STEP B — importi */}
                {step === 'importi' && fam && !fatto && (
                    <div className="space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <p className="font-barlow text-sm font-black uppercase text-kidville-green">{fam.parent.nome || t('transPagante')}</p>
                                <p className="font-maven text-xs text-kidville-sub">
                                    {fam.figli.length} {fam.figli.length === 1 ? t('transFiglio') : t('transFigli')} {t('transCreditoFamiglia')} {formatEuro(fam.credito)}
                                </p>
                            </div>
                            <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'py-1.5 px-3 text-xs')}>
                                <ArrowLeft size={13} /> {t('transCambiaPagante')}
                            </button>
                        </div>

                        {/* Dati del versamento */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label htmlFor="tx-totale" className="mb-1 block font-maven text-xs text-kidville-sub">{t('transTotaleVersato')}</label>
                                <input id="tx-totale" type="number" min={0} step="0.01" value={totale} onChange={(e) => setTotale(e.target.value)} className={INPUT} />
                            </div>
                            <div>
                                <label htmlFor="tx-metodo" className="mb-1 block font-maven text-xs text-kidville-sub">{t('transMetodo')}</label>
                                <select id="tx-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} className={SELECT}>
                                    {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="tx-riferimento" className="mb-1 block font-maven text-xs text-kidville-sub">{t('transRiferimento')}</label>
                                <input id="tx-riferimento" type="text" value={riferimento} onChange={(e) => setRiferimento(e.target.value)} placeholder={t('transRifPlaceholder')} className={INPUT} />
                            </div>
                            <div>
                                <label htmlFor="tx-datavaluta" className="mb-1 block font-maven text-xs text-kidville-sub">{t('transDataValuta')}</label>
                                <input id="tx-datavaluta" type="date" value={dataValuta} onChange={(e) => setDataValuta(e.target.value)} className={INPUT} />
                            </div>
                        </div>

                        {/* Voci aperte per figlio */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('transVociDaSaldare')}</h3>
                                <button type="button" onClick={proponi} className={cx(BTN_SECONDARY, 'py-1.5 px-3 text-xs')}>
                                    <Wand2 size={13} /> {t('transPropostaAutomatica')}
                                </button>
                            </div>
                            {fam.voci.length === 0 && <p className="font-maven text-sm text-kidville-muted">{t('transNessunaVoce')}</p>}
                            {fam.figli.filter((f) => fam.voci.some((v) => v.alunno_id === f.id)).map((f) => (
                                <div key={f.id} data-testid={`tx-figlio-${f.id}`} className="rounded-card border border-kidville-line p-3">
                                    <p data-testid={`tx-figlio-intestazione-${f.id}`} className="mb-2 flex flex-wrap items-center gap-1.5 font-maven text-sm font-bold text-kidville-ink">
                                        {nomeFiglio(f)}
                                        {famigliaMultiSede && <BadgeSede nome={nomeSede(f.scuola_id, f.scuola_nome)} />}
                                    </p>
                                    <div className="space-y-1.5">
                                        {fam.voci.filter((v) => v.alunno_id === f.id).map((v) => {
                                            const on = alloc[v.id] !== undefined;
                                            return (
                                                <div key={v.id} data-testid={`tx-voce-${v.id}`} className="flex items-center gap-2">
                                                    <input
                                                        type="checkbox" checked={on} onChange={() => toggleVoce(v)}
                                                        className="h-4 w-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                                        aria-label={`${t('transIncludi')} ${v.descrizione ?? t('transVoce')}`}
                                                    />
                                                    <span className="flex-1 truncate font-maven text-sm text-kidville-ink">
                                                        {v.descrizione ?? t('transVoceCap')}
                                                        <span className={cx('ml-2 text-xs', v.stato_effettivo === 'scaduto' ? 'text-kidville-error-strong' : 'text-kidville-sub')}>
                                                            {t('transResta')} {formatEuro(v.residuo)}{v.scadenza ? ` ${t('transScad')} ${dataIt(v.scadenza)}` : ''}
                                                        </span>
                                                    </span>
                                                    {/* La sede della VOCE decide in quale transazione finisce. */}
                                                    {famigliaMultiSede && <BadgeSede nome={nomeSede(v.scuola_id, v.scuola_nome)} />}
                                                    <span className="font-maven text-xs text-kidville-muted">€</span>
                                                    <input
                                                        type="number" min={0} step="0.01" disabled={!on}
                                                        value={on ? alloc[v.id] : ''} onChange={(e) => setVoceImporto(v.id, e.target.value)}
                                                        className="w-24 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green disabled:opacity-50"
                                                        aria-label={`${t('transImporto')} ${v.descrizione ?? t('transVoce')}`}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Ricariche mensa per figlio */}
                        <div className="space-y-2">
                            <h3 className="flex items-center gap-1.5 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">
                                <UtensilsCrossed size={13} /> {t('transRicaricaMensa')}
                            </h3>
                            {fam.figli.map((f) => (
                                <div key={f.id} data-testid={`tx-ricarica-${f.id}`} className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-40 flex-1 font-maven text-sm text-kidville-ink">
                                        {nomeFiglio(f)} <span className="text-xs text-kidville-muted">({f.saldo_ticket} {t('transTicket')})</span>
                                        {/* La ricarica va nella sede dell'ALUNNO. */}
                                        {famigliaMultiSede && <span className="ml-1.5 align-middle"><BadgeSede nome={nomeSede(f.scuola_id, f.scuola_nome)} /></span>}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <span className="font-maven text-xs text-kidville-muted">€</span>
                                        <input
                                            type="number" min={0} step="0.01" value={ric[f.id]?.euro ?? ''}
                                            onChange={(e) => setRicarica(f.id, 'euro', e.target.value)}
                                            className="w-20 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                                            aria-label={`${t('transEuroRicarica')} ${nomeFiglio(f)}`}
                                        />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <input
                                            type="number" min={0} step="1" value={ric[f.id]?.ticket ?? ''}
                                            onChange={(e) => setRicarica(f.id, 'ticket', e.target.value)}
                                            className="w-20 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                                            aria-label={`${t('transTicketRicarica')} ${nomeFiglio(f)}`}
                                        />
                                        <span className="font-maven text-xs text-kidville-muted">{t('transTicket')}</span>
                                    </div>
                                </div>
                            ))}
                            {hasRigheOltreTotale && (
                                <p role="alert" className="font-maven text-[11px] text-kidville-error-strong">{t('transRicaricaWarn')}</p>
                            )}
                        </div>

                        {/* Quadratura + divisione per sede: niente spaziatura sul contenitore,
                            così la regione live vuota non lascia un buco. */}
                        <div>
                            {/* Quadratura live — annunciata agli screen reader mentre cambia */}
                            <div role="status" aria-live="polite" className={cx(
                                'flex flex-wrap items-center justify-between gap-2 rounded-card px-3 py-2.5',
                                differenza === 0 ? 'bg-kidville-success-soft' : differenza > 0 ? 'bg-kidville-warn-soft' : 'bg-kidville-error-soft',
                            )}>
                                <span className="font-maven text-sm text-kidville-ink">
                                    {t('transAllocato')} <strong>{formatEuro(allocato)}</strong> {t('transSu')} <strong>{formatEuro(totaleNum)}</strong>
                                </span>
                                <span className={cx(
                                    'font-barlow text-sm font-black uppercase',
                                    differenza === 0 ? 'text-kidville-success-strong' : differenza > 0 ? 'text-kidville-warn-strong' : 'text-kidville-error-strong',
                                )}>
                                    {differenza === 0 ? t('transQuadra') : differenza > 0 ? `${formatEuro(differenza)} ${t('transInEccesso')}` : `${formatEuro(-differenza)} ${t('transOltreTotale')}`}
                                </span>
                            </div>

                            {/* Più sedi nell'operazione: il server creerà una transazione per
                                sede. Si dice PRIMA di confermare, con quanto va a ciascuna.
                                La regione live è SEMPRE montata e l'avviso ci compare dentro:
                                una regione che nasce insieme al suo testo spesso non viene
                                annunciata. La select del credito sta FUORI dalla regione, perché
                                un controllo dentro uno `status` verrebbe riletto a ogni scelta. */}
                            <div data-testid="tx-divisione-sedi-regione" role="status" aria-live="polite">
                                {operazioneMultiSede && (
                                    <div data-testid="tx-divisione-sedi" className={cx(
                                        'mt-3 rounded-card border border-kidville-warn bg-kidville-warn-soft px-3 py-2.5',
                                        serveSedeEcc && 'rounded-b-none border-b-0',
                                    )}>
                                        <p className="font-maven text-sm font-bold text-kidville-ink">
                                            {t('transSedeDivisione', { n: gruppiSede.length })}
                                        </p>
                                        <p className="mb-2 font-maven text-xs text-kidville-sub">{t('transSedeDivisioneSub')}</p>
                                        <ul className="space-y-1">
                                            {gruppiSede.map((g) => {
                                                const conEcc = gruppoEcc != null && g.chiave === gruppoEcc.chiave;
                                                return (
                                                    <li key={g.chiave || 'ignota'} className="flex items-center justify-between gap-2 font-maven text-sm text-kidville-ink">
                                                        <span>{g.nome}</span>
                                                        <span className="font-bold">
                                                            {formatEuro(round2(g.somma + (conEcc ? eccedenza : 0)))}
                                                            {conEcc && <span className="ml-1 text-xs font-normal text-kidville-sub">{t('transSedeConCredito', { importo: formatEuro(eccedenza) })}</span>}
                                                        </span>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                )}
                            </div>
                            {/* Stesso riquadro dell'avviso, visivamente; fuori dalla regione live. */}
                            {serveSedeEcc && (
                                <div className="rounded-b-card border border-t-0 border-kidville-warn bg-kidville-warn-soft px-3 pb-2.5 pt-1">
                                    <label htmlFor="tx-sede-eccedenza" className="mb-1 block font-maven text-xs font-bold text-kidville-ink">
                                        {t('transSedeCreditoLabel')}
                                    </label>
                                    <select
                                        id="tx-sede-eccedenza" required aria-required="true"
                                        aria-describedby="tx-sede-eccedenza-aiuto"
                                        value={gruppoEcc?.id ?? ''} onChange={(e) => setSedeEcc(e.target.value)}
                                        className={SELECT}
                                    >
                                        <option value="">{t('transSedeCreditoScegli')}</option>
                                        {gruppiSede.filter((g) => g.id).map((g) => (
                                            <option key={g.chiave} value={g.id ?? ''}>{g.nome}</option>
                                        ))}
                                    </select>
                                    {/* L'unico testo che spiega perché «Registra incasso» è spento. */}
                                    <p id="tx-sede-eccedenza-aiuto" className="mt-1 font-maven text-xs text-kidville-sub">
                                        {t('transSedeCreditoAiuto', { importo: formatEuro(eccedenza) })}
                                    </p>
                                </div>
                            )}
                        </div>

                        {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}

                        <div className="flex gap-2">
                            <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'flex-1')}>{t('transAnnulla')}</button>
                            <button
                                ref={registraBtnRef}
                                type="button" onClick={() => invia(false)} disabled={!puoConfermare || saving}
                                className={cx(BTN_PRIMARY, 'flex-1')}
                            >
                                {saving ? t('transRegistrazione') : t('transRegistraIncasso')}
                            </button>
                        </div>
                    </div>
                )}

                {/* ESITO — ricevuta / dividi in fatture */}
                {fatto && fam && (
                    <div className="space-y-4">
                        <div role="status" className="flex items-center gap-2 rounded-card bg-kidville-success-soft px-3 py-2.5">
                            <Check size={18} className="text-kidville-success-strong" />
                            <span className="font-maven text-sm font-bold text-kidville-success-strong">
                                {fatto.transazioni.length > 1 ? t('transSedeEsitoMulti', { n: fatto.transazioni.length }) : t('transRegistrata')} {formatEuro(totaleNum)}
                            </span>
                        </div>

                        {/* Una ricevuta per ogni transazione creata (una per sede). */}
                        <div data-testid="tx-esito-transazioni" className="flex flex-wrap gap-2">
                            {fatto.transazioni.map((tx, i) => {
                                const sede = nomeSede(tx.scuola_id, tx.scuola_nome);
                                const multi = fatto.transazioni.length > 1;
                                if (!tx.transazione_id) {
                                    return (
                                        <p key={`senza-id-${i}`} className="font-maven text-sm text-kidville-error-strong">
                                            {t('transSedeRicevutaNonDisponibile', { nome: sede })}
                                        </p>
                                    );
                                }
                                return (
                                    <LinkDocumento
                                        key={tx.transazione_id}
                                        href={`/api/pagamenti/transazioni/${tx.transazione_id}/ricevuta?userId=${userId}`}
                                        target="_blank"
                                        modo="apri" nomeFile="ricevuta-famiglia.pdf" mime="application/pdf" etichetta="ricevuta-transazione"
                                        className={cx(BTN_PRIMARY, 'text-sm')}
                                    >
                                        <FileText size={15} />{' '}
                                        {multi
                                            ? t('transSedeRicevutaDi', { nome: sede, importo: formatEuro(Number(tx.importo_totale ?? 0)) })
                                            : t('transRicevutaFamiglia')}
                                    </LinkDocumento>
                                );
                            })}
                        </div>

                        {fatto.voci.length > 0 && (
                            <div className="rounded-card border border-kidville-line p-3">
                                <p className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('transDividiFatture')}</p>
                                <p className="mb-3 font-maven text-[11px] text-kidville-muted">{t('transDividiFattureSub')}</p>
                                <div className="space-y-1.5">
                                    {fatto.voci.map((v) => (
                                        <div key={v.id} className="flex items-center justify-between gap-2">
                                            <span className="flex-1 truncate font-maven text-sm text-kidville-ink">{v.descrizione ?? t('transVoceCap')}</span>
                                            <FatturaButton pagamentoId={v.id} userId={userId} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'w-full')}>{t('transNuovoIncasso')}</button>
                    </div>
                )}
            </div>

            {/* REGISTRO TRANSAZIONI */}
            <div>
                <SectionTitle icon={RotateCcw} title={t('transRegistroTitolo')} sub={t('transRegistroSub')} />
                {loadingRegistro && <p className="font-maven text-sm text-kidville-muted">{t('transCaricamento')}</p>}
                {!loadingRegistro && registroErrore && <p role="alert" className="font-maven text-sm text-kidville-error-strong">{messaggioDaCorpo(registroErrore.corpo, t('transRegistroErrore'))}</p>}
                {!loadingRegistro && !registroErrore && !registroDisp && <p className="font-maven text-sm text-kidville-muted">{t('transRegistroNonDisp')}</p>}
                {!loadingRegistro && !registroErrore && registroDisp && registro.length === 0 && <p className="font-maven text-sm text-kidville-muted">{t('transNessunaTransazione')}</p>}
                {!loadingRegistro && !registroErrore && registroDisp && registro.length > 0 && (
                    <div className="overflow-x-auto rounded-card border border-kidville-line">
                        <table className="w-full min-w-[820px] border-collapse">
                            <thead>
                                <tr className="border-b border-kidville-line bg-kidville-cream/40 text-left">
                                    {[t('transThData'), t('transSedeTh'), t('transPagante'), t('transThTotale'), t('transMetodo'), t('transThRiferimento'), ''].map((h) => (
                                        <th key={h} className="px-3 py-2 font-barlow text-[11px] font-black uppercase tracking-wide text-kidville-muted">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {registro.map((tx) => (
                                    <tr key={tx.id} className={cx('border-b border-kidville-line last:border-0', tx.annullata_il && 'opacity-50')}>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{dataIt(tx.data_valuta ?? tx.creato_il)}</td>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{tx.scuola_id || tx.scuola_nome ? nomeSede(tx.scuola_id, tx.scuola_nome) : '—'}</td>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{tx.pagante_nome || '—'}</td>
                                        <td className="px-3 py-2 font-maven text-sm font-bold text-kidville-green">{formatEuro(Number(tx.importo_totale))}</td>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{METODI.find((m) => m.v === tx.metodo)?.l ?? tx.metodo}</td>
                                        <td className="px-3 py-2 font-maven text-xs text-kidville-muted">{tx.riferimento || '—'}</td>
                                        <td className="px-3 py-2 text-right">
                                            {tx.annullata_il ? (
                                                <span className="font-barlow text-[11px] font-black uppercase text-kidville-error">{t('transAnnullata')}</span>
                                            ) : (
                                                <div className="flex items-center justify-end gap-1.5">
                                                    <LinkDocumento
                                                        href={`/api/pagamenti/transazioni/${tx.id}/ricevuta?userId=${userId}`}
                                                        target="_blank" title={t('transRistampaRicevuta')}
                                                        modo="apri" nomeFile="ricevuta-famiglia.pdf" mime="application/pdf" etichetta="ricevuta-transazione"
                                                        className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-2 py-1 font-maven text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green/20"
                                                    >
                                                        <Printer size={12} /> {t('transRicevuta')}
                                                    </LinkDocumento>
                                                    <button
                                                        type="button" onClick={() => { setAnnullaTx(tx); setMotivoAnnullo(''); }}
                                                        className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-error hover:text-kidville-error"
                                                    >
                                                        <X size={12} /> {t('transAnnulla')}
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* DIALOG — conferma eccedenza → credito famiglia (primitiva accessibile) */}
            <Modal
                open={confermaEcc != null}
                onClose={() => setConfermaEcc(null)}
                title={t('transEccTitolo')}
                labelledBy="tx-eccedenza-title"
                className={cx(MODAL_CARD, 'max-w-sm')}
                style={{ boxShadow: MODAL_SHADOW }}
                returnFocusRef={registraBtnRef}
            >
                <h2 id="tx-eccedenza-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">{t('transEccTitolo')}</h2>
                <p className="mb-3 font-maven text-sm text-kidville-ink">
                    {t('transEccPre')} <strong>{formatEuro(confermaEcc)}</strong>{t('transEccMid')} <strong>{t('transEccCredito')}</strong> {t('transEccPost')}
                </p>
                {serveSedeEcc && gruppoEcc && (
                    <p className="mb-3 font-maven text-sm text-kidville-ink">
                        {t('transSedeCreditoDialogo', { nome: gruppoEcc.nome })}
                    </p>
                )}
                <div className="flex gap-2">
                    <button type="button" onClick={() => setConfermaEcc(null)} className={cx(BTN_SECONDARY, 'flex-1')}>{t('transAnnulla')}</button>
                    <button type="button" onClick={() => invia(true)} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>{t('transConfermaCredito')}</button>
                </div>
            </Modal>

            {/* DIALOG — annullo transazione (primitiva accessibile) */}
            <Modal
                open={annullaTx != null}
                onClose={() => setAnnullaTx(null)}
                title={t('transAnnulloTitolo')}
                labelledBy="tx-annullo-title"
                className={cx(MODAL_CARD, 'max-w-sm')}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                <h2 id="tx-annullo-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">{t('transAnnulloTitolo')}</h2>
                <p className="mb-3 font-maven text-sm text-kidville-ink">
                    {t('transAnnulloIntro')}{annullaTx ? ` (${formatEuro(Number(annullaTx.importo_totale))})` : ''}{t('transAnnulloOutro')}
                </p>
                <input
                    type="text" value={motivoAnnullo} onChange={(e) => setMotivoAnnullo(e.target.value)}
                    placeholder={t('transMotivoPlaceholder')} className={cx(INPUT, 'mb-3')} aria-label={t('transMotivoAria')}
                />
                <div className="flex gap-2">
                    <button type="button" onClick={() => setAnnullaTx(null)} className={cx(BTN_SECONDARY, 'flex-1')}>{t('transIndietro')}</button>
                    <button
                        type="button" onClick={eseguiAnnullo} disabled={busyAnnullo || motivoAnnullo.trim().length < 3}
                        className={cx(BTN_PRIMARY, 'flex-1')}
                    >
                        {busyAnnullo ? t('transAnnulloBusy') : t('transConfermaAnnullo')}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
