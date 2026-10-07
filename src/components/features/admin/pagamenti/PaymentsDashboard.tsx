'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { dataCivile } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { Search, Filter, AlertTriangle, RefreshCw, Plus, Pencil, Eye, Download, X } from 'lucide-react';
import { RegistraIncassoModal, PagamentoRow } from './RegistraIncassoModal';
import { FatturaButton, type EsitoAccodamento } from './FatturaButton';
import { FatturaChip } from './FatturaChip';
import { LinkDocumento, MIME_XLSX } from './LinkDocumento';
import { PagamentoCardMobile, BadgeSede } from './PagamentoCardMobile';
import { PagamentoDrawer } from './PagamentoDrawer';
import { FiltroClassiContabilita } from './FiltroClassiContabilita';
import { BadgeRettaACarico, BadgeRettaACaricoNonVisibile } from './BadgeRettaACarico';
import { indicizzaLegami, legamiDaRisposta, nomePagante, nonVisibiliDaRisposta, type LegameRetta } from '@/lib/pagamenti/rette-a-carico';
import { classiDaAlunni, filtraPerClassi } from '@/lib/pagamenti/filtro-classi';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { SospensioneToggle } from './SospensioneToggle';
import { QuickAcquistoModal } from './QuickAcquistoModal';
import { ModificaPagamentoModal } from './ModificaPagamentoModal';
import { RateizzaModal } from './RateizzaModal';
import { STATI_PAGAMENTO as STATI, calcolaTotaliPagamenti } from './stati';
import { AgendaScadenze } from './AgendaScadenze';
import { KpiContabilita } from './KpiContabilita';
import { TabellaVociContabilita } from './TabellaVociContabilita';
import { FiltroAnnoContabilita, FiltroCategorieContabilita, FiltroMesiContabilita } from './FiltriSelezioneContabilita';
import { BTN_PRIMARY_SM, FILTER_SELECT, ICON_BTN } from './ui';
import { useCifreNascoste } from './cifre-nascoste';
import {
    annoScolasticoDi, eMeseDiRetta, eVistaPerAlunno, etichettaMese, etichettaMesi, filtraPerSelezione,
    meseDi, mesiValidi, periodoDi, type SelezioneVoci,
} from '@/lib/pagamenti/selezione-voci';
import { BadgeMetodoPagamento } from '@/components/features/pagamenti/BadgeMetodoPagamento';
import { useAgingLabel, bucketScadenze, isMoroso, residuoEffettivo, type AgingBucketId } from '@/lib/pagamenti/aging';
import { Badge } from '@/components/ui/Badge';
import { TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { eDirezioneCockpit } from '@/lib/auth/ruoli';

/** Stato vuoto nello stile app: cerchio crema + emoji + testo (come parent/avvisi). */
function EmptyRiga({ emoji, testo }: { emoji: string; testo: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-pill bg-kidville-cream text-2xl">{emoji}</div>
            <p className="max-w-xs font-maven text-sm text-kidville-muted">{testo}</p>
        </div>
    );
}

/** `scuola_id` null = categoria globale (K2: con più sedi arrivano anche quelle di ogni sede). */
interface Categoria { id: string; nome: string; slug: string; colore?: string; icona?: string; scuola_id?: string | null }
interface Pagamento extends PagamentoRow {
    alunno_id: string;
    scadenza: string;
    obbligatorio: boolean;
    categoria_id?: string | null;
    periodo_competenza?: string | null;
    payment_categories?: { nome?: string; colore?: string; icona?: string } | null;
    /** Sede della voce e suo nome: `GET /api/pagamenti` li manda su OGNI riga (K1). */
    scuola_id?: string | null;
    scuola_nome?: string | null;
    alunni?: {
        nome?: string; cognome?: string;
        classe_sezione?: string | null;
        /** K1: la chiave del filtro classi (`null` = alunno senza sezione). */
        section_id?: string | null;
        sospeso?: boolean | null;
    };
}
interface Alunno {
    id: string; nome?: string; cognome?: string;
    classe_sezione?: string | null; section_id?: string | null;
    /** Sede del bambino (`GET /api/admin/students` la manda sempre). */
    scuola_id?: string | null;
    stato?: string; importo_retta_mensile?: number | null;
}

/** Esito della lettura della configurazione Aruba di UNA sede. */
type EsitoAruba = 'attiva' | 'non-attiva' | 'errore';

/** Esito di una GET del cruscotto: `ok` solo con risposta 2xx E corpo leggibile. */
interface EsitoLettura<T> { ok: boolean; corpo: T | null }

/**
 * GET di un elenco del cruscotto. Ogni guasto è LOGGATO — rete giù, corpo illeggibile e
 * risposta 4xx/5xx — perché un `catch` muto qui è una tabella vuota che sembra «nessun
 * pagamento» o «nessun alunno». Il corpo si restituisce anche sul rifiuto: porta il
 * messaggio del server (`error`). Nel `messaggio` del log solo l'etichetta e la classe
 * d'errore: l'URL porta uuid e filtri.
 */
async function leggiJson<T>(url: string, userId: string, etichetta: string): Promise<EsitoLettura<T>> {
    try {
        const r = await fetch(url, { headers: { 'x-user-id': userId } });
        let leggibile = true;
        const corpo = (await r.json().catch((e: unknown) => {
            leggibile = false;
            logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: r.status });
            return null;
        })) as T | null;
        if (!r.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-rifiutato`, route: '/admin/pagamenti', stato: r.status });
        }
        return { ok: r.ok && leggibile, corpo };
    } catch (e) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${etichetta}-non-caricato: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0 });
        return { ok: false, corpo: null };
    }
}

/** Elenco di nomi in una frase («A, B e C»), nella lingua corrente. */
function elencoNomi(nomi: string[], locale: string): string {
    // `Intl.ListFormat` assente (browser molto vecchio): la virgola basta, e non è un guasto.
    if (typeof Intl.ListFormat !== 'function') return nomi.join(', ');
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(nomi);
}

/**
 * `scuolaId`: la sede dichiarata, oppure `null` quando le sedi selezionate sono più di una
 * (P1). Con `null` le GET NON portano `scuola_id` — la route restringe già alle sedi attive
 * dell'utente — e mai «undefined»/«null» nell'URL: le route lo validano come uuid (400).
 * Le sedi davvero visibili arrivano da `useSediAttive().effettive` (MAI da `selezionate`,
 * dove vuoto vuol dire «tutte»). Il ricaricamento al cambio di sede lo fa `SedeScopeBoundary`
 * del layout admin, che rimonta il contenuto.
 */
interface Props { userId: string; scuolaId: string | null }

export function PaymentsDashboard({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    const f = useDateFormat();
    const agingLabel = useAgingLabel();
    /**
     * I TOTALI ECONOMICI SONO DELLA DIREZIONE (decisione del titolare, 2026-09-02).
     *
     * ⚠️ E qui va detto cosa questa riga può e cosa non può, perché la differenza è reale.
     * I totali di questa schermata NON arrivano dal server: li somma il browser
     * (`calcolaTotaliPagamenti`) a partire dalle stesse righe che la Segreteria deve
     * legittimamente vedere — deve incassare, sollecitare, fatturare. Quindi nasconderli
     * è mettere in ordine la vista, NON costruire una barriera: chi apre gli strumenti per
     * sviluppatori, o esporta in Excel (`/api/pagamenti/export`, che resta aperto per
     * scelta del titolare), somma le righe da sé.
     *
     * Il pattern «il server omette la chiave» — quello vero, in `cassa/movimenti` — qui
     * non è applicabile senza togliere anche le righe. La home /admin, che prima calcolava
     * gli importi sul server e li ometteva ai ruoli non Direzione, ora non li calcola più
     * per nessun ruolo (decisione del titolare, 2026-10-07): lì non c'è nulla da nascondere.
     */
    const eDirezione = eDirezioneCockpit(useRuoloCockpit());
    // «Nascondi cifre»: scelta ricordata per utente su questo dispositivo (default: visibili).
    const [cifreNascoste, setCifreNascoste] = useCifreNascoste(userId);
    const [pagamenti, setPagamenti] = useState<Pagamento[]>([]);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [categorie, setCategorie] = useState<Categoria[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    /**
     * Le categorie scelte nel filtro. `null` = «predefinita» (la Retta, appena si sa qual è):
     * serve a distinguere la scelta dell'utente («tutte» = `[]`) da quella che nessuno ha ancora
     * fatto. È un valore DERIVATO in lettura (`categorieEffettive`), mai impostato da un effetto.
     */
    const [categorieScelte, setCategorieScelte] = useState<string[] | null>(null);
    /** Le categorie sono arrivate (o la risposta è inutilizzabile): da qui la predefinita è nota. */
    const [categorieLette, setCategorieLette] = useState(false);
    const [onlyMorosi, setOnlyMorosi] = useState(false);
    const [nuovoAcqId, setNuovoAcqId] = useState('');
    const [selected, setSelected] = useState<Pagamento | null>(null);
    const [editing, setEditing] = useState<Pagamento | null>(null);
    const [rateizza, setRateizza] = useState<{ alunno: Alunno; pagamento: Pagamento } | null>(null);
    const [drawer, setDrawer] = useState<Pagamento | null>(null);
    const [agendaFiltro, setAgendaFiltro] = useState<AgingBucketId | null>(null);
    const [quick, setQuick] = useState<{ alunno: Alunno; categoria: Categoria; scuolaId?: string } | null>(null);
    const [generando, setGenerando] = useState(false);
    /** Configurazione Aruba PER SEDE; `chiave` = le sedi a cui si riferisce (niente esiti stantii). */
    const [aruba, setAruba] = useState<{ chiave: string; esiti: Record<string, EsitoAruba> } | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** La GET degli iscritti è fallita: la vista Rette, i mancanti e l'acquisto non sono affidabili. */
    const [erroreAlunni, setErroreAlunni] = useState(false);
    /**
     * Chi paga la retta di chi (`alunni.retta_a_carico_di`), per alunno A CARICO. Vuota finché
     * non arriva, e vuota se la GET fallisce: allora quei bambini restano «Non generata» come
     * prima, e il banner `errore-legami` lo dice.
     */
    const [legami, setLegami] = useState<Map<string, LegameRetta>>(() => new Map());
    /**
     * C3: i bambini a carico il cui pagante sta in una sede che l'utente non legge (solo gli
     * uuid). Non sono «mancanti» (la generazione li salta) e non sono «Non generata».
     */
    const [aCaricoNonVisibili, setACaricoNonVisibili] = useState<Set<string>>(() => new Set());
    const [erroreLegami, setErroreLegami] = useState(false);
    /** `section_id` scelti nel filtro classi (K6). Si scartano in lettura, mai azzerati. */
    const [classiScelte, setClassiScelte] = useState<string[]>([]);
    /** Sede scelta per «Genera mancanti» e per il nuovo acquisto, quando le sedi sono più d'una. */
    const [sedeGenera, setSedeGenera] = useState('');
    const [sedeAcquistoScelta, setSedeAcquistoScelta] = useState('');

    // ── Le sedi ───────────────────────────────────────────────────────────────────────────
    const { sedi, effettive } = useSediAttive();
    const chiaveSedi = scuolaId ?? effettive.join(',');
    /** Le sedi che questa schermata mostra: quella dichiarata, o le effettive del contesto. */
    const sediVisibili = useMemo(() => (chiaveSedi ? chiaveSedi.split(',') : []), [chiaveSedi]);
    const mostraSede = sediVisibili.length > 1;
    const sedeUnica = sediVisibili.length === 1 ? sediVisibili[0] : null;
    /** `&scuola_id=…` solo con una sede dichiarata: con più sedi si OMETTE. */
    const sedeQs = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';

    // «Oggi» è la data civile italiana: `toISOString()` è UTC e dopo le 22:00 d'estate è già domani.
    // Anno scolastico corrente: set->ago = anno corrente, gen->giu = anno-1.
    const oggiStr = dataCivile();
    const annoScolasticoCorrente = annoScolasticoDi(oggiStr);
    const [annoScolastico, setAnnoScolastico] = useState<number>(() => annoScolasticoDi(dataCivile()));
    /** I mesi scelti (1–12); all'apertura il mese corrente. Cambiando anno si mantengono. */
    const [mesiScelti, setMesiScelti] = useState<number[]>(() => [meseDi(dataCivile())]);

    // NB: niente setLoading(true) sincrono qui dentro (react-hooks/set-state-in-effect):
    // al mount loading parte già true; il refresh manuale lo imposta nel suo handler.
    const load = useCallback(async () => {
        try {
            const [pagRes, alRes, legRes] = await Promise.all([
                leggiJson<{ success?: boolean; data?: Pagamento[]; error?: string }>(`/api/pagamenti?userId=${userId}${sedeQs}`, userId, 'scadenzario-pagamenti'),
                leggiJson<Alunno[] | { data?: Alunno[] }>(`/api/admin/students?stato=iscritto${sedeQs}&limit=${LIMITE_ELENCO_ALUNNI}`, userId, 'scadenzario-alunni'),
                leggiJson<{ success?: boolean; data?: unknown; a_carico_non_visibili?: unknown }>(`/api/pagamenti/rette-a-carico?userId=${userId}${sedeQs}`, userId, 'scadenzario-legami'),
            ]);
            const pag = pagRes.corpo;
            if (pagRes.ok && pag?.success) { setPagamenti(pag.data ?? []); setError(null); }
            else setError(pag?.error || t('dashErrCaricamento'));
            // Gli alunni: un rifiuto NON è «nessun alunno». Si svuota la lista (niente dati di
            // prima spacciati per attuali) e lo si dice a schermo; il guasto l'ha loggato `leggiJson`.
            const al = alRes.corpo;
            const lista: Alunno[] | null = !alRes.ok ? null : Array.isArray(al) ? al : Array.isArray(al?.data) ? al.data : null;
            if (lista === null) {
                if (alRes.ok) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-alunni-forma-inattesa', route: '/admin/pagamenti' });
                setAlunni([]);
                setErroreAlunni(true);
            } else {
                setAlunni(lista.filter((a) => a.classe_sezione != null || a.section_id != null));
                setErroreAlunni(false);
            }
            // I legami: un guasto NON è «nessun fratello paga». Si svuotano (niente badge di
            // prima spacciati per attuali) e lo si dice a schermo; il rifiuto l'ha loggato `leggiJson`.
            // (`listaLegami` e non `lista`: nel blocco degli alunni qui sopra c'è già una `lista`.)
            const listaLegami = legRes.ok && legRes.corpo?.success ? legamiDaRisposta(legRes.corpo.data) : null;
            // C3/R10/Q4: `a_carico_non_visibili` che non è un array — anche ASSENTE o `null` (la
            // route l'ha sempre mandato: non c'è una «risposta di prima») — è una forma inattesa,
            // come `data` non array: la risposta intera non si usa.
            const nonVisibili = listaLegami === null ? null : nonVisibiliDaRisposta(legRes.corpo?.a_carico_non_visibili);
            if (listaLegami === null || nonVisibili === null) {
                if (legRes.ok) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-legami-forma-inattesa', route: '/admin/pagamenti' });
                setLegami(new Map());
                setACaricoNonVisibili(new Set());
                setErroreLegami(true);
            } else {
                // Voci malformate scartate: quei bambini tornano «Non generata», e senza questo log
                // nessuno saprebbe perché. Solo il conteggio: mai nomi (AGENTS.md, regola 8).
                const scartati = listaLegami.scartati + nonVisibili.scartati;
                if (scartati > 0) {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-legami-voci-scartate', route: '/admin/pagamenti', campi: { n: scartati } });
                }
                setLegami(indicizzaLegami(listaLegami.legami));
                setACaricoNonVisibili(new Set(nonVisibili.ids));
                setErroreLegami(false);
            }
        } finally {
            setLoading(false);
        }
    }, [userId, sedeQs, t]);

    // D12: dopo un accodamento il chip deve comparire subito. `load()` sono tre GET (tutti i pagamenti
    // della sede, gli iscritti e i legami delle rette a carico di un fratello): con `nuova` lo stato è noto per costruzione (la RPC ha appena scritto
    // `in_coda`) e basta la riga; con `gia`, o senza esito, può essere `in_invio` o `errore`, e si
    // rilegge. Fotografia dichiarata: il lavoratore può prenderla un attimo dopo.
    const dopoAccodamento = useCallback((pagamentoId: string, esito?: EsitoAccodamento) => {
        if (esito?.accodata === 'nuova') {
            setPagamenti((prima) => prima.map((x) => (x.id === pagamentoId ? { ...x, coda_stato: 'in_coda' as const } : x)));
            return;
        }
        void load();
    }, [load]);

    useEffect(() => { load(); }, [load]);
    // Categorie: con più sedi (nessuna dichiarata) la GET è multi-sede (K2): globali + quelle
    // di ogni sede attiva. Prima rispondeva 400, e il `.catch` muto lasciava il select vuoto.
    useEffect(() => {
        void leggiJson<{ success?: boolean; data?: Categoria[] }>(`/api/admin/settings/categorie?userId=${userId}${sedeQs}`, userId, 'scadenzario-categorie')
            .then(({ ok, corpo: d }) => {
                if (ok && d?.success && Array.isArray(d.data)) {
                    setCategorie(d.data);
                } else if (ok) {
                    // 2xx ma senza elenco (il rifiuto, il corpo illeggibile e la rete giù li ha
                    // già loggati `leggiJson`): il filtro vuoto non deve sembrare «nessuna categoria».
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-categorie-forma-inattesa', route: '/admin/pagamenti' });
                }
                // Anche a risposta inutilizzabile: la categoria predefinita non arriverà più, e i
                // KPI non possono restare in attesa per sempre (somma di tutte le categorie).
                setCategorieLette(true);
            });
    }, [userId, sedeQs]);

    // Gating Aruba/SDI visibile (M2.4), PER SEDE: la configurazione è di ogni plesso, e la
    // route vuole UNA sede (`resolveScuolaScrittura`: senza `scuola_id` e con più sedi
    // risponde 400, che il vecchio `.catch` muto trasformava in «tutto a posto»). Una GET per
    // sede visibile; un esito non leggibile è «da verificare», detto a schermo e loggato.
    useEffect(() => {
        if (!chiaveSedi) return;
        let annullato = false;
        const ids = chiaveSedi.split(',');
        void Promise.all(ids.map(async (id): Promise<[string, EsitoAruba]> => {
            try {
                const r = await fetch(`/api/admin/settings/aruba?userId=${userId}&scuola_id=${encodeURIComponent(id)}`, { headers: { 'x-user-id': userId } });
                // Il corpo illeggibile si logga con la sua CAUSA (SyntaxError…): il log dopo
                // direbbe soltanto «non letta» con lo stato.
                const d = (await r.json().catch((e: unknown) => {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: `aruba-config-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: r.status, campi: { sedi: ids.length } });
                    return null;
                })) as { success?: boolean; data?: { abilitato?: boolean } } | null;
                if (!r.ok || !d?.success) {
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'aruba-config-non-letta', route: '/admin/pagamenti', stato: r.status, campi: { sedi: ids.length } });
                    return [id, 'errore'];
                }
                return [id, d.data?.abilitato ? 'attiva' : 'non-attiva'];
            } catch (e) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `aruba-config-non-letta: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0, campi: { sedi: ids.length } });
                return [id, 'errore'];
            }
        })).then((coppie) => {
            if (!annullato) setAruba({ chiave: chiaveSedi, esiti: Object.fromEntries(coppie) });
        });
        return () => { annullato = true; };
    }, [userId, chiaveSedi]);

    // ── Nomi delle sedi: dal contesto, e in ripiego dalle righe (`scuola_nome`, K1) ────────
    const nomiSedi = useMemo(() => {
        const m: Record<string, string> = {};
        for (const p of pagamenti) if (p.scuola_id && p.scuola_nome) m[p.scuola_id] = p.scuola_nome;
        for (const s of sedi) m[s.id] = s.nome;
        return m;
    }, [pagamenti, sedi]);
    /** Il nome della sede, o stringa vuota se ignoto (mai un nome inventato). */
    const nomeSede = useCallback((id: string | null | undefined) => (id ? nomiSedi[id] ?? '' : ''), [nomiSedi]);
    /** Nome da mostrare in una frase o in un'opzione: il ripiego è il testo «Sede non indicata». */
    const nomeSedeTesto = (id: string | null | undefined) => nomeSede(id) || t('sedeBadgeNonIndicata');

    // ── Filtro classi (K6) ────────────────────────────────────────────────────────────────
    // Le classi vengono dalle righe E dagli iscritti: nella vista Rette un bambino senza retta
    // generata («Non generata») ha comunque una classe. La sede si prende dalla RIGA
    // (`p.scuola_id`), non dal join `alunni`, che non la porta: con `scuolaId: ''` le omonime
    // di sedi diverse si fonderebbero in un gruppo solo.
    const classi = useMemo(
        () => classiDaAlunni(
            [
                ...pagamenti.flatMap((p) => (p.alunni
                    ? [{ section_id: p.alunni.section_id ?? null, classe_sezione: p.alunni.classe_sezione ?? null, scuola_id: p.scuola_id ?? null }]
                    : [])),
                ...alunni.map((a) => ({ section_id: a.section_id ?? null, classe_sezione: a.classe_sezione ?? null, scuola_id: a.scuola_id ?? sedeUnica })),
            ],
            nomiSedi,
        ),
        [pagamenti, alunni, nomiSedi, sedeUnica],
    );
    // Gli id scelti che non corrispondono più a una classe in elenco si SCARTANO in lettura
    // (e si deduplicano): la stessa lista va a righe, KPI, agenda, componente ed export.
    const scelteValide = useMemo(
        () => [...new Set(classiScelte)].filter((id) => classi.some((c) => c.id === id)),
        [classiScelte, classi],
    );
    /** Le righe dopo il filtro classi: base di KPI, agenda e tabelle. */
    const pagamentiVisibili = useMemo(
        () => filtraPerClassi(pagamenti, scelteValide, (p) => p.alunni?.section_id ?? null),
        [pagamenti, scelteValide],
    );

    const rettaCat = useMemo(() => categorie.find((c) => c.slug === 'retta'), [categorie]);
    /** Con più sedi due categorie omonime (es. «Gita» di Aversa e di Cesa) si distinguono dalla sede. */
    const etichettaCategoria = (c: Categoria) =>
        mostraSede && c.scuola_id ? t('dashMsCategoriaDiSede', { categoria: c.nome, nome: nomeSedeTesto(c.scuola_id) }) : c.nome;
    const opzioniCategorie = categorie.map((c) => ({ id: c.id, testo: etichettaCategoria(c) }));

    // ── La selezione: categorie × mesi di un anno scolastico (decisione del titolare) ─────
    // Guida le card KPI, la tabella per sede e la scelta fra vista per alunno ed elenco per voce.
    // NON segue la ricerca né «Morosi»: sono filtri dell'ELENCO, non di ciò che si somma.
    /** Nessuna scelta fatta = la Retta; finché le categorie non arrivano non si sa qual è. */
    const categorieEffettive = useMemo(
        () => categorieScelte ?? (rettaCat ? [rettaCat.id] : []),
        [categorieScelte, rettaCat],
    );
    // Una scelta che non corrisponde più a una categoria in elenco si scarta (e si deduplica):
    // stessa regola con cui il filtro scrive il riepilogo, così filtro e KPI dicono la stessa cosa.
    const categorieValide = useMemo(
        () => [...new Set(categorieEffettive)].filter((id) => categorie.some((c) => c.id === id)),
        [categorieEffettive, categorie],
    );
    const selezione = useMemo<SelezioneVoci>(
        () => ({ categorie: categorieValide, anno: annoScolastico, mesi: mesiScelti }),
        [categorieValide, annoScolastico, mesiScelti],
    );
    /** Finché le categorie non arrivano i KPI dicono «—»: niente lampo della somma di TUTTO. */
    const selezioneInAttesa = categorieScelte === null && !categorieLette;
    /**
     * Retta e un solo mese DI RETTA (set–giu): la vista «per alunno» (con «Non generata»,
     * «Genera mancanti», fratelli). A luglio e agosto le rette non si generano: la stessa
     * selezione apre l'elenco per voce (le eventuali voci reali del mese, o lo stato vuoto).
     */
    const vistaPerAlunno = eVistaPerAlunno(selezione, rettaCat?.id)
        && eMeseDiRetta(mesiValidi(mesiScelti)[0]);
    /** Il mese (1–12) della vista per alunno: il solo mese valido scelto. */
    const meseSolo = vistaPerAlunno ? mesiValidi(mesiScelti)[0] : undefined;
    /** 'YYYY-MM-01' del solo mese della vista per alunno (vuoto altrove). */
    const meseUnico = useMemo(
        () => (meseSolo === undefined ? '' : periodoDi(annoScolastico, meseSolo)),
        [meseSolo, annoScolastico],
    );
    /** Il nuovo acquisto ha senso con UNA categoria sola, e non la retta (quella si genera). */
    const categoriaAcquisto = categorieValide.length === 1 && categorieValide[0] !== rettaCat?.id
        ? categorie.find((c) => c.id === categorieValide[0])
        : undefined;
    const vociSelezione = useMemo(() => filtraPerSelezione(pagamentiVisibili, selezione), [pagamentiVisibili, selezione]);
    /** La frase sotto le card: «Retta · ottobre 2026», «3 categorie · set–ott 2026», … */
    const testoSelezione = (() => {
        const nomi = categorieValide.flatMap((id) => { const c = categorie.find((x) => x.id === id); return c ? [etichettaCategoria(c)] : []; });
        const categorieTesto = nomi.length === 0 ? t('filtroCategorieTutte')
            : nomi.length <= 3 ? nomi.join(', ')
                : t('filtroCategorieSelezionate', { n: nomi.length });
        return t('dashKpiSelezioneVoce', { categorie: categorieTesto, mesi: etichettaMesi(selezione, f.locale) ?? t('filtroMesiTutto') });
    })();

    // mappa retta del mese della vista per alunno: alunno_id -> pagamento
    const rettaByAlunno = useMemo(() => {
        const m = new Map<string, Pagamento>();
        if (!meseUnico) return m;
        for (const p of pagamenti) {
            if (p.categoria_id === rettaCat?.id && p.periodo_competenza === meseUnico) m.set(p.alunno_id, p);
        }
        return m;
    }, [pagamenti, rettaCat, meseUnico]);

    /**
     * Per ogni bambino A CARICO di un fratello: il legame e ciò che il suo badge sa del PAGANTE —
     * la retta del mese (la stessa che disegna la riga del pagante, D3) e se la sede del pagante
     * è fra le caricate (se no, lo stato non si conosce e non si inventa). Calcolato UNA volta
     * qui, per tabella e card (Z2, quinta revisione 2026-09-29): prima era la stessa espressione
     * scritta due volte, e quella della card poteva divergere senza che un test se ne accorgesse.
     */
    const aCaricoPerAlunno = useMemo(() => {
        const m = new Map<string, { legame: LegameRetta; rettaPagante: Pagamento | undefined; sedeCaricata: boolean }>();
        for (const [alunnoId, legame] of legami) {
            const sedePagante = legame.pagante.scuola_id;
            m.set(alunnoId, {
                legame,
                rettaPagante: rettaByAlunno.get(legame.pagante.id),
                sedeCaricata: !!sedePagante && sediVisibili.includes(sedePagante),
            });
        }
        return m;
    }, [legami, rettaByAlunno, sediVisibili]);

    // mappa alunno per id: usata dalla tabella-categoria (ricerca e label)
    const alunnoById = useMemo(() => new Map(alunni.map((a) => [a.id, a])), [alunni]);

    const alunniFiltrati = useMemo(() => {
        const q = search.trim().toLowerCase();
        return filtraPerClassi(alunni, scelteValide, (a) => a.section_id ?? null).filter((a) => {
            const legame = legami.get(a.id);
            if (q) {
                // D11: chi cerca il fratello che paga trova anche il bambino a suo carico.
                const pagante = legame ? nomePagante(legame.pagante) : '';
                const nome = `${a.nome ?? ''} ${a.cognome ?? ''} ${a.classe_sezione ?? ''} ${pagante}`.toLowerCase();
                if (!nome.includes(q)) return false;
            }
            if (vistaPerAlunno && onlyMorosi) {
                const p = rettaByAlunno.get(a.id);
                // D10: senza retta propria, conta la retta del fratello che paga.
                const pPagante = !p && legame ? rettaByAlunno.get(legame.pagante.id) : undefined;
                const riferimento = p ?? pPagante;
                if (!riferimento || !isMoroso(riferimento, oggiStr)) return false;
            }
            return true;
        });
    }, [alunni, scelteValide, search, vistaPerAlunno, onlyMorosi, rettaByAlunno, oggiStr, legami]);

    // Elenco PER VOCE (ogni selezione che non sia «retta + un mese»): una riga per pagamento
    // della selezione (padre escluso), con ricerca su alunno/sezione, filtro morosi e
    // ordinamento per scadenza. Parte da `vociSelezione`: categorie e mesi sono già applicati.
    const righeVoci = useMemo(() => {
        if (vistaPerAlunno) return [];
        const q = search.trim().toLowerCase();
        return vociSelezione
            .filter((p) => p.tipo !== 'padre')
            .filter((p) => {
                if (q) {
                    // nome da p.alunni (stessa fonte del display, copre anche i ritirati);
                    // sezione da alunnoById quando disponibile (solo iscritti)
                    const a = alunnoById.get(p.alunno_id);
                    const nome = `${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''} ${a?.classe_sezione ?? ''}`.toLowerCase();
                    if (!nome.includes(q)) return false;
                }
                if (onlyMorosi && !isMoroso(p, oggiStr)) return false;
                return true;
            })
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [vociSelezione, vistaPerAlunno, search, onlyMorosi, oggiStr, alunnoById]);

    // Le card sommano SOLO la selezione (categorie × mesi, dopo il filtro classi).
    const totals = useMemo(() => calcolaTotaliPagamenti(vociSelezione), [vociSelezione]);

    /**
     * KPI per sede: le stesse somme delle card (la selezione), una riga per sede visibile (nell'ordine del
     * contesto), più «Sede non indicata» se qualche riga non la porta. Solo con più sedi.
     */
    const totaliPerSede = useMemo(() => {
        if (!mostraSede) return [];
        const gruppi = new Map<string, Pagamento[]>(sediVisibili.map((id) => [id, []]));
        for (const p of vociSelezione) {
            const k = p.scuola_id ?? '';
            const g = gruppi.get(k);
            if (g) g.push(p); else gruppi.set(k, [p]);
        }
        return [...gruppi].map(([id, righe]) => ({ id, totali: calcolaTotaliPagamenti(righe) }));
    }, [mostraSede, sediVisibili, vociSelezione]);

    // ── «Genera mancanti» ─────────────────────────────────────────────────────────────────
    // Quanti iscritti non hanno la retta del mese, PER SEDE. Si conta su tutti gli iscritti
    // della sede (non sulla ricerca né sul filtro classi): la generazione è di sede intera,
    // e il numero che si legge deve essere quello che il bottone produce.
    const mancantiPerSede = useMemo(() => {
        const m = new Map<string, number>();
        if (!vistaPerAlunno) return m;
        for (const a of alunni) {
            // D6: chi ha la retta a carico di un fratello non è «mancante» — la generazione
            // lo salta, e contarlo teneva il numero sopra zero per sempre. Anche quando chi
            // paga sta in una sede che l'utente non legge (C3).
            if (rettaByAlunno.has(a.id) || legami.has(a.id) || aCaricoNonVisibili.has(a.id)) continue;
            const k = a.scuola_id ?? sedeUnica ?? '';
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
    }, [vistaPerAlunno, alunni, rettaByAlunno, sedeUnica, legami, aCaricoNonVisibili]);
    /** Le sedi fra cui scegliere: le visibili che hanno almeno un mancante. */
    const sediConMancanti = sediVisibili.filter((id) => (mancantiPerSede.get(id) ?? 0) > 0);
    const sedeGeneraValida = mostraSede ? (sediConMancanti.includes(sedeGenera) ? sedeGenera : '') : (sedeUnica ?? '');
    const mancantiTotali = mostraSede
        ? sediConMancanti.reduce((n, id) => n + (mancantiPerSede.get(id) ?? 0), 0)
        : [...mancantiPerSede.values()].reduce((n, v) => n + v, 0);
    const mancantiRette = mostraSede && sedeGeneraValida ? (mancantiPerSede.get(sedeGeneraValida) ?? 0) : mancantiTotali;

    // genera la retta del mese selezionato (per chi non ce l'ha ancora), SULLA
    // SEDE SCELTA: senza `scuola_id` il server emetteva su tutti i plessi, e con
    // più sedi visibili la sede la sceglie l'operatore (il bottone è spento finché
    // non l'ha fatto). La risposta si guarda: un rifiuto (sede non dichiarata, sede
    // di collaudo) resterebbe altrimenti invisibile all'operatore.
    const generaMese = async () => {
        if (!sedeGeneraValida || !meseUnico) return;
        setGenerando(true);
        try {
            const res = await fetch('/api/pagamenti/genera-rette', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ periodo: meseUnico.slice(0, 7), scuola_id: sedeGeneraValida }),
            });
            const j = await res.json().catch((e: unknown) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `genera-rette-corpo-illeggibile: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: res.status });
                return null;
            });
            if (!res.ok || !j?.success) setError(messaggioDaCorpo(j, t('dashErrCaricamento')));
            else setError(null);
            await load();
        } catch (e) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `genera-rette-non-partita: ${nomeErrore(e)}`, route: '/admin/pagamenti', stato: 0 });
            setError(t('dashErrCaricamento'));
        } finally {
            setGenerando(false);
        }
    };

    // ── Nuovo acquisto: la sede ───────────────────────────────────────────────────────────
    // Una categoria di sede vale solo per quella sede; una globale per tutte le visibili.
    const sediAcquisto = categoriaAcquisto?.scuola_id ? sediVisibili.filter((id) => id === categoriaAcquisto.scuola_id) : sediVisibili;
    const chiedeSedeAcquisto = sediAcquisto.length > 1;
    const sedeAcquisto = chiedeSedeAcquisto
        ? (sediAcquisto.includes(sedeAcquistoScelta) ? sedeAcquistoScelta : '')
        : (sediAcquisto[0] ?? '');
    // Con più sedi l'elenco dei bambini è SEMPRE quello della sede dell'acquisto, anche quando
    // non c'è domanda (categoria di una sede sola): la POST ricava la sede dall'ALUNNO e non
    // guarda la categoria, quindi un bambino di un'altra sede produrrebbe una voce di quella
    // sede con la categoria sbagliata — mentre il modale mostrerebbe la sede della categoria.
    const alunniAcquisto = mostraSede
        ? (sedeAcquisto ? alunniFiltrati.filter((a) => a.scuola_id === sedeAcquisto) : [])
        : alunniFiltrati;
    /** L'acquisto non può partire: con più sedi manca la sede (da scegliere, o nessuna ammessa). */
    const acquistoSenzaSede = mostraSede && !sedeAcquisto;
    const nuovoAcqValido = alunniAcquisto.some((a) => a.id === nuovoAcqId) ? nuovoAcqId : '';

    // ── Modifica di una voce: le categorie della SUA sede ─────────────────────────────────
    // Con più sedi la GET porta le categorie di ogni sede (K2), e il modale le elenca per
    // nome: due «Gita» identiche, e a una voce di Giugliano si potrebbe dare quella di Aversa.
    // Restano le globali, quelle della sede della voce e — sempre — quella che la voce ha
    // già (anche se incoerente: toglierla dal select la cambierebbe in silenzio al salvataggio).
    // Le categorie di sede portano il nome della sede (`etichettaCategoria`, come il filtro).
    const categorieModifica = editing
        ? categorie
            .filter((c) => !c.scuola_id || !editing.scuola_id || c.scuola_id === editing.scuola_id || c.id === editing.categoria_id)
            .map((c) => ({ ...c, nome: etichettaCategoria(c) }))
        : [];

    // Export dello scadenzario: la sede solo se dichiarata, le classi solo se scelte (K2).
    const hrefExport = useMemo(() => {
        const qs = new URLSearchParams({ tipo: 'scadenzario', userId });
        if (scuolaId) qs.set('scuola_id', scuolaId);
        if (scelteValide.length > 0) qs.set('section_ids', scelteValide.join(','));
        return `/api/pagamenti/export?${qs.toString()}`;
    }, [userId, scuolaId, scelteValide]);

    // Vista agenda: pagamenti aperti del bucket selezionato, per scadenza crescente.
    const agendaItems = useMemo(() => {
        if (!agendaFiltro) return [];
        return bucketScadenze(pagamentiVisibili, oggiStr)[agendaFiltro].items
            .slice()
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [agendaFiltro, pagamentiVisibili, oggiStr]);

    // Badge Aruba: le sedi non configurate e quelle non verificate, solo se l'esito è di
    // QUESTE sedi (un esito di prima del cambio sede non si mostra).
    const esitiAruba = aruba && aruba.chiave === chiaveSedi ? aruba.esiti : {};
    const arubaNonAttive = sediVisibili.filter((id) => esitiAruba[id] === 'non-attiva');
    const arubaNonVerificate = sediVisibili.filter((id) => esitiAruba[id] === 'errore');

    // Il banner degli scarti resta su TUTTE le righe: è un allarme, non una vista.
    const fattureScartate = pagamenti.filter((p) => p.fattura_stato === 'scartata').length;
    // Mappa alunno → sospeso (DL-021), derivata dal payload pagamenti.
    const sospesoByAlunno = new Map<string, boolean>();
    for (const p of pagamenti) {
        if (p.alunno_id) sospesoByAlunno.set(p.alunno_id, !!p.alunni?.sospeso);
    }

    return (
        <div>
            {/* Errore di caricamento: i KPI a 0,00 non devono sembrare dati reali */}
            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{error}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}

            {/* Iscritti non caricati: la vista Rette vuota, i mancanti a 0 e l'acquisto senza
                bambini NON devono sembrare «nessun alunno». */}
            {erroreAlunni && (
                <div data-testid="errore-alunni" role="alert" className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{t('dashMsErrAlunni')}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}

            {/* Legami non caricati: i bambini a carico di un fratello tornano «Non generata», e
                questo NON deve sembrare vero. Solo nella vista Rette (e non in Agenda): altrove
                «quei bambini risultano Non generata» non corrisponde a niente sullo schermo.
                Q7 (quarta revisione 2026-09-29): nemmeno senza gli iscritti — la vista Rette è
                vuota e il banner degli alunni dice già tutto — e il «Riprova» ha un nome
                accessibile suo: con due banner, due «Riprova» uguali non si distinguevano. */}
            {erroreLegami && !erroreAlunni && vistaPerAlunno && !agendaFiltro && (
                <div data-testid="errore-legami" role="alert" className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{t('dashMsErrLegami')}</span>
                    <button onClick={() => { setLoading(true); load(); }} aria-label={t('dashRiprovaLegami')}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}

            {/* Gating Aruba/SDI (M2.4), PER SEDE: segnale visibile quando la fatturazione non è
                configurata, con il nome delle sedi quando sono più d'una. Il testo è `sub` e non
                `muted`: dice cosa non funziona, e il contrasto conta. */}
            {arubaNonAttive.length > 0 && (
                <div data-testid="aruba-non-attiva" className="mb-4 flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{t('dashIntegrNonConfig')}</Badge>
                    <span className="font-maven text-xs text-kidville-sub">
                        {mostraSede
                            ? t('dashMsArubaNonAttivaSedi', { elenco: elencoNomi(arubaNonAttive.map(nomeSedeTesto), f.locale), n: arubaNonAttive.length })
                            : t('dashArubaNonAttiva')}
                    </span>
                </div>
            )}
            {/* La configurazione di una sede NON letta (errore, rete giù) non è «tutto a posto»:
                lo si dice, e il guasto è già nel log. */}
            {arubaNonVerificate.length > 0 && (
                <div data-testid="aruba-non-verificata" className="mb-4 flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{t('dashMsArubaDaVerificare')}</Badge>
                    <span className="font-maven text-xs text-kidville-sub">
                        {mostraSede
                            ? t('dashMsArubaNonVerificataSedi', { elenco: elencoNomi(arubaNonVerificate.map(nomeSedeTesto), f.locale) })
                            : t('dashMsArubaNonVerificata')}
                    </span>
                </div>
            )}

            {/* Banner scarti SDI (DL-020): fatture rifiutate da correggere e reinviare */}
            {fattureScartate > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="font-maven text-sm font-bold">
                        {fattureScartate} {fattureScartate > 1 ? t('dashFattureScartatePlur') : t('dashFatturaScartataSing')}
                    </span>
                </div>
            )}

            {/* KPI della Direzione: card, tabella per sede (con più sedi), selezione e occhio.
                Il gate `eDirezione` sta qui; il dettaglio e i testid in `KpiContabilita`. */}
            {eDirezione && (
                <KpiContabilita
                    totals={totals}
                    totaliPerSede={totaliPerSede}
                    loading={loading || selezioneInAttesa}
                    mostraSede={mostraSede}
                    nomeSedeTesto={nomeSedeTesto}
                    nascoste={cifreNascoste}
                    onCommutaNascoste={() => setCifreNascoste(!cifreNascoste)}
                    testoSelezione={selezioneInAttesa ? undefined : testoSelezione}
                />
            )}

            {/* Filtri di selezione, SOPRA l'agenda. Le classi (K6) valgono per KPI, agenda, tabelle
                ed export — anche in vista agenda, dove la barra dei filtri si nasconde; categorie,
                mesi e anno guidano KPI e tabella (non l'agenda, che resta su tutte le voci). */}
            {!loading && (
                <div className="mb-4 flex flex-wrap items-end gap-2">
                    <FiltroClassiContabilita
                        classi={classi}
                        selezionate={scelteValide}
                        onChange={setClassiScelte}
                        mostraSede={mostraSede}
                        className="max-sm:w-full"
                    />
                    <FiltroCategorieContabilita opzioni={opzioniCategorie} scelte={categorieValide} onChange={setCategorieScelte} className="max-sm:w-full" />
                    {/* L'anno prima dei mesi: le etichette dei mesi («Ott 2026») dipendono da lui. */}
                    <FiltroAnnoContabilita
                        anno={annoScolastico}
                        anni={[annoScolasticoCorrente - 1, annoScolasticoCorrente, annoScolasticoCorrente + 1]}
                        onChange={setAnnoScolastico}
                        className="max-sm:w-full"
                    />
                    <FiltroMesiContabilita anno={annoScolastico} mesi={mesiScelti} onChange={setMesiScelti} className="max-sm:w-full" />
                </div>
            )}

            {/* Agenda scadenze / aging: i bucket filtrano la lista sottostante.
                Alla Segreteria restano i CONTEGGI e il clic — è uno strumento di lavoro,
                non un cruscotto — e spariscono i soli importi (`mostraImporti`). */}
            {!loading && <AgendaScadenze pagamenti={pagamentiVisibili} attivo={agendaFiltro} onSelect={setAgendaFiltro} mostraImporti={eDirezione} mostraSede={mostraSede} mascheraImporti={cifreNascoste} />}

            {/* Filtri (nascosti in vista agenda: non filtrerebbero la lista del bucket) */}
            {!agendaFiltro && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
                    <input
                        value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('dashCercaAlunno')}
                        className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-9 pr-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                    />
                </div>
                {/* Filtro Morosi: disponibile in ogni selezione (filtra l'elenco, non i KPI) */}
                <button onClick={() => setOnlyMorosi((v) => !v)}
                    className={cx('inline-flex items-center gap-1 rounded-pill px-3 py-2 font-maven text-sm font-bold transition-colors', onlyMorosi ? 'bg-kidville-error-soft text-kidville-error' : 'border-[1.5px] border-kidville-line bg-kidville-white text-kidville-muted hover:border-kidville-green hover:text-kidville-green')}>
                    <Filter size={14} /> {t('dashMorosi')}
                </button>
                <button onClick={() => { setLoading(true); load(); }} aria-label={t('dashAggiorna')} title={t('dashAggiorna')} className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <RefreshCw size={14} />
                </button>
                <LinkDocumento href={hrefExport} title={t('dashEsportaXlsx')} aria-label={t('dashEsportaXlsx')}
                    modo="scarica" nomeFile="scadenzario.xlsx" mime={MIME_XLSX} etichetta="export-scadenzario"
                    className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <Download size={14} />
                </LinkDocumento>
            </div>
            )}

            {/* CTA generazione rette mancanti. Con più sedi la sede si SCEGLIE (il bottone resta
                spento finché non la si sceglie): la generazione è di UNA sede, e il numero
                mostrato diventa quello della sede scelta. */}
            {vistaPerAlunno && !loading && mancantiTotali > 0 && (
                <div data-testid="cta-genera-mancanti" className="flex flex-wrap items-center justify-between gap-2 bg-kidville-warn-soft border border-kidville-warn/30 rounded-card px-3 py-2 mb-3">
                    <span data-testid="cta-genera-mancanti-frase" className="font-maven text-xs text-kidville-warn-strong">
                        {t('dashMsAlunniSenzaRetta', { n: mancantiRette, mese: etichettaMese(meseUnico, f.locale, 'corta') })}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        {mostraSede && (
                            <label className="flex items-center gap-2 font-maven text-xs text-kidville-warn-strong">
                                {t('dashMsGeneraSedeLabel')}
                                <select value={sedeGeneraValida} onChange={(e) => setSedeGenera(e.target.value)} className={FILTER_SELECT}>
                                    <option value="">{t('dashMsScegliSede')}</option>
                                    {sediConMancanti.map((id) => (
                                        <option key={id} value={id}>{t('dashMsGeneraOpzione', { nome: nomeSedeTesto(id), n: mancantiPerSede.get(id) ?? 0 })}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <button onClick={generaMese} disabled={generando || !sedeGeneraValida} className={BTN_PRIMARY_SM}>
                            {generando ? t('dashGenerando') : t('dashGeneraMancanti')}
                        </button>
                    </div>
                </div>
            )}

            {/* Corpo */}
            {loading || selezioneInAttesa ? (
                <p className="font-maven text-sm text-kidville-muted py-8 text-center">{t('dashCaricamento')}</p>
            ) : agendaFiltro ? (
                /* ---- Vista AGENDA: pagamenti aperti del bucket, per scadenza ---- */
                <>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-maven text-xs text-kidville-muted">
                        <span className="font-bold text-kidville-green">{agingLabel(agendaFiltro)}</span> · {agendaItems.length} {agendaItems.length === 1 ? t('dashPagamentoApertiSing') : t('dashPagamentiApertiPlur')}
                    </p>
                    <button onClick={() => setAgendaFiltro(null)}
                        className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-2.5 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        <X size={12} /> {t('dashChiudi')}
                    </button>
                </div>
                {agendaItems.length === 0 ? (
                    <EmptyRiga emoji="🗓️" testo={t('dashVuotoIntervallo')} />
                ) : (
                    <>
                    <div className={cx('hidden lg:block', TABLE_WRAP)}>
                        <table className={TABLE}>
                            <thead>
                                <tr>
                                    <th className={TH}>{t('dashThAlunno')}</th>
                                    {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                                    <th className={TH}>{t('dashThDescrizione')}</th>
                                    <th className={TH}>{t('dashThScadenza')}</th>
                                    <th className={cx(TH, 'text-right')}>{t('dashThResiduo')}</th>
                                    <th className={TH}>{t('dashThStato')}</th>
                                    <th className={TH}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {agendaItems.map((p) => {
                                    const st = STATI[p.stato] ?? STATI.da_pagare;
                                    const residuo = residuoEffettivo(p);
                                    return (
                                        <tr key={p.id} className={TROW}>
                                            <td className={cx(TD, 'font-semibold text-kidville-green')}>{p.alunni?.nome} {p.alunni?.cognome}</td>
                                            {mostraSede && <td className={TD}><BadgeSede nome={p.scuola_nome} /></td>}
                                            <td className={cx(TD, 'text-kidville-ink')}>
                                                {p.descrizione}
                                                <BadgeMetodoPagamento metodi={p.metodi_ammessi} testoSoloContanti={t('badgeSoloContanti')} testoSoloBonifico={t('badgeSoloBonifico')} className="ml-2 align-middle" />
                                            </td>
                                            <td className={cx(TD, 'text-kidville-muted')}>{p.scadenza ? f.dataBreve(p.scadenza) : '—'}</td>
                                            <td className={cx(TD, 'text-right font-bold text-kidville-green')}>{formatEuro(residuo)}</td>
                                            <td className={TD}>
                                                <Badge tone={st.tone}>{st.label}</Badge>
                                            </td>
                                            <td className={cx(TD, 'text-right')}>
                                                <div className="flex items-center justify-end gap-2">
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                                    <button onClick={() => setDrawer(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <div className="space-y-2 lg:hidden">
                        {agendaItems.map((p) => (
                            <PagamentoCardMobile
                                key={p.id}
                                pagamento={p}
                                alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                                mostraSede={mostraSede}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        ))}
                    </div>
                    </>
                )}
                </>
            ) : vistaPerAlunno ? (
                /* ---- Vista PER ALUNNO (retta + un mese): tabella su desktop, card-list su mobile ---- */
                alunniFiltrati.length === 0 ? (
                // Con la GET degli iscritti fallita l'elenco vuoto NON è «nessun alunno»: lo
                // dice il banner d'errore qui sopra, e qui non si afferma il contrario.
                erroreAlunni ? null : <EmptyRiga emoji="🧒" testo={t('dashVuotoAlunni')} />
                ) : (
                <>
                <div className={cx('hidden lg:block', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <thead>
                            <tr>
                                <th className={TH}>{t('dashThAlunno')}</th>
                                {mostraSede && <th className={TH}>{t('dashMsThSede')}</th>}
                                <th className={TH}>{t('dashThSezione')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashThImporto')}</th>
                                <th className={cx(TH, 'text-right')}>{t('dashThPagato')}</th>
                                <th className={TH}>{t('dashThStato')}</th>
                                <th className={TH}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {alunniFiltrati.map((a) => {
                                const p = rettaByAlunno.get(a.id);
                                const st = p ? (STATI[p.stato] ?? STATI.da_pagare) : null;
                                const moroso = p ? isMoroso(p, oggiStr) : false;
                                const aCarico = aCaricoPerAlunno.get(a.id);
                                const legame = aCarico?.legame;
                                const nonVisibile = !legame && aCaricoNonVisibili.has(a.id);
                                return (
                                    <tr key={a.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                            {a.nome} {a.cognome}
                                            {sospesoByAlunno.get(a.id) && (
                                                <Badge tone="error" className="ml-1 align-middle">{t('dashSospeso')}</Badge>
                                            )}
                                        </td>
                                        {mostraSede && <td className={TD}><BadgeSede nome={nomeSede(a.scuola_id)} /></td>}
                                        <td className={cx(TD, 'text-kidville-muted')}>{a.classe_sezione || '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>{p ? formatEuro(p.importo) : '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{p ? formatEuro(p.importo_pagato) : '—'}</td>
                                        <td className={TD}>
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                {/* `inTabella` (K2): qui i badge-frase hanno una larghezza minima, nelle card no. */}
                                                {st
                                                    ? <Badge tone={st.tone}>{st.label}</Badge>
                                                    : aCarico
                                                        ? <BadgeRettaACarico {...aCarico} inTabella />
                                                        : nonVisibile
                                                            ? <BadgeRettaACaricoNonVisibile inTabella />
                                                            : <Badge tone="neutral">{t('dashNonGenerata')}</Badge>}
                                                {/* D9: retta propria E legame col fratello — si mostra, e si segnala. */}
                                                {p && legame && <BadgeRettaACarico legame={legame} conRettaPropria inTabella />}
                                                {p && nonVisibile && <BadgeRettaACaricoNonVisibile inTabella />}
                                                {p && moroso && Number(p.importo_pagato) > 0 && (
                                                    <Badge tone="warn">{t('dashAcconto')} {formatEuro(p.importo_pagato)}</Badge>
                                                )}
                                                {p && <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />}
                                            </span>
                                        </td>
                                        <td className={cx(TD, 'text-right')}>
                                            <div className="flex items-center justify-end gap-2">
                                                {p && p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>{t('dashIncassa')}</button>
                                                ) : p ? (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} codaStato={p.coda_stato ?? null} onEmessa={(e) => dopoAccodamento(p.id, e)} />
                                                ) : null}
                                                {p && (
                                                    <button onClick={() => setDrawer(p)} title={t('dashDettagli')} className={ICON_BTN}><Eye size={15} /></button>
                                                )}
                                                {p && (
                                                    <button onClick={() => setEditing(p)} title={t('dashModifica')} className={ICON_BTN}><Pencil size={15} /></button>
                                                )}
                                                <SospensioneToggle alunnoId={a.id} userId={userId} sospeso={!!sospesoByAlunno.get(a.id)} onChange={load} />
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="space-y-2 lg:hidden">
                    {alunniFiltrati.map((a) => {
                        const p = rettaByAlunno.get(a.id);
                        const aCarico = aCaricoPerAlunno.get(a.id);
                        const legame = aCarico?.legame;
                        const nonVisibile = !legame && aCaricoNonVisibili.has(a.id);
                        if (!p && (aCarico || nonVisibile)) {
                            // Il badge SOTTO il nome, non accanto: è una frase (fino a ~430 px col
                            // font vero, ~251 px di spazio a 360 px di schermo). Accanto al nome lo
                            // schiacciava e faceva scorrere la pagina in orizzontale; qui la card
                            // è un blocco, e il badge va a capo nella sua riga intera.
                            return (
                                <div key={a.id} data-testid="card-retta-a-carico" className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                    {mostraSede && <BadgeSede nome={nomeSede(a.scuola_id)} className="mt-1" />}
                                    <div data-testid="card-retta-a-carico-badge" className="mt-2 flex flex-wrap gap-1">
                                        {aCarico
                                            ? <BadgeRettaACarico {...aCarico} />
                                            : <BadgeRettaACaricoNonVisibile />}
                                    </div>
                                </div>
                            );
                        }
                        if (!p) {
                            return (
                                <div key={a.id} className="flex items-center justify-between gap-2 rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <div className="min-w-0">
                                        <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                        {mostraSede && <BadgeSede nome={nomeSede(a.scuola_id)} className="mt-1" />}
                                    </div>
                                    <Badge tone="neutral">{t('dashNonGenerata')}</Badge>
                                </div>
                            );
                        }
                        return (
                            <PagamentoCardMobile
                                key={a.id}
                                pagamento={p}
                                alunnoLabel={`${a.nome ?? ''} ${a.cognome ?? ''}`.trim()}
                                sezioneLabel={a.classe_sezione}
                                sospeso={!!sospesoByAlunno.get(a.id)}
                                mostraSede={mostraSede}
                                avviso={legame ? <BadgeRettaACarico legame={legame} conRettaPropria /> : nonVisibile ? <BadgeRettaACaricoNonVisibile /> : undefined}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        );
                    })}
                </div>
                </>
                )
            ) : (
                /* ---- Elenco PER VOCE: tabella 1-riga-per-pagamento (come le rette) ---- */
                <>
                {/* Aggiungi acquisto: solo con UNA categoria non retta; la tabella per-pagamento
                    non elenca gli alunni senza acquisti */}
                {categoriaAcquisto && (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    {/* Con più sedi l'acquisto CHIEDE la sede prima del bambino: l'elenco dei
                        bambini diventa quello della sede scelta, e la sede arriva al modale. */}
                    {chiedeSedeAcquisto && (
                        <label className="flex items-center gap-2 font-maven text-xs text-kidville-sub">
                            {t('dashMsAcquistoSedeLabel')}
                            <select value={sedeAcquisto} onChange={(e) => { setSedeAcquistoScelta(e.target.value); setNuovoAcqId(''); }}
                                className={FILTER_SELECT}>
                                <option value="">{t('dashMsScegliSede')}</option>
                                {sediAcquisto.map((id) => <option key={id} value={id}>{nomeSedeTesto(id)}</option>)}
                            </select>
                        </label>
                    )}
                    <select value={nuovoAcqValido} onChange={(e) => setNuovoAcqId(e.target.value)}
                        disabled={acquistoSenzaSede}
                        aria-label={t('dashSelezionaAlunno')}
                        className={cx(FILTER_SELECT, 'disabled:cursor-not-allowed disabled:opacity-60')}>
                        <option value="">{chiedeSedeAcquisto && !sedeAcquisto ? t('dashMsScegliPrimaSede') : t('dashSelezionaAlunno')}</option>
                        {alunniAcquisto.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}</option>
                        ))}
                    </select>
                    <button
                        disabled={!nuovoAcqValido || acquistoSenzaSede}
                        onClick={() => {
                            const a = alunnoById.get(nuovoAcqValido);
                            if (a) {
                                setQuick({ alunno: a, categoria: categoriaAcquisto, scuolaId: sedeAcquisto || undefined });
                                setNuovoAcqId('');
                            }
                        }}
                        className="inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-2 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                        <Plus size={15} /> {t('dashNuovoAcquisto')}
                    </button>
                </div>
                )}
                {righeVoci.length === 0 ? (
                    <EmptyRiga emoji="🧾" testo={t('dashVuotoSelezione')} />
                ) : (
                <TabellaVociContabilita
                    righe={righeVoci}
                    mostraSede={mostraSede}
                    mostraCategoria={categorieValide.length !== 1}
                    nomeCategoria={(p) => {
                        const c = categorie.find((x) => x.id === p.categoria_id);
                        return c ? etichettaCategoria(c) : p.payment_categories?.nome || '—';
                    }}
                    sospesoByAlunno={sospesoByAlunno}
                    oggiStr={oggiStr}
                    userId={userId}
                    rettaId={rettaCat?.id}
                    onIncassa={(p) => setSelected(p)}
                    onRateizza={(p) => { const a = alunnoById.get(p.alunno_id); if (a) setRateizza({ alunno: a, pagamento: p }); }}
                    onDettagli={(p) => setDrawer(p)}
                    onModifica={(p) => setEditing(p)}
                    dopoAccodamento={dopoAccodamento}
                />
                )}
                </>
            )}

            {selected && (
                <RegistraIncassoModal
                    pagamento={selected}
                    userId={userId}
                    onClose={() => setSelected(null)}
                    onDone={() => { setSelected(null); load(); }}
                />
            )}

            {quick && (
                <QuickAcquistoModal
                    alunno={quick.alunno}
                    categoria={quick.categoria}
                    userId={userId}
                    scuolaId={quick.scuolaId}
                    sedeNome={mostraSede && quick.scuolaId ? nomeSedeTesto(quick.scuolaId) : undefined}
                    onClose={() => setQuick(null)}
                    onDone={() => { setQuick(null); load(); }}
                />
            )}

            {editing && (
                <ModificaPagamentoModal
                    pagamento={editing}
                    categorie={categorieModifica}
                    userId={userId}
                    onClose={() => setEditing(null)}
                    onDone={() => { setEditing(null); load(); }}
                />
            )}

            {rateizza && (
                <RateizzaModal
                    alunno={rateizza.alunno}
                    userId={userId}
                    scuolaId={rateizza.pagamento.scuola_id ?? scuolaId ?? undefined}
                    categoriaId={rateizza.pagamento.categoria_id}
                    descrizione={rateizza.pagamento.descrizione}
                    importoTotale={Number(rateizza.pagamento.importo)}
                    obbligatorio={rateizza.pagamento.obbligatorio}
                    replacePagamentoId={rateizza.pagamento.id}
                    metodiAmmessi={rateizza.pagamento.metodi_ammessi}
                    onClose={() => setRateizza(null)}
                    onDone={() => { setRateizza(null); load(); }}
                />
            )}

            {drawer && (
                <PagamentoDrawer
                    pagamento={drawer}
                    userId={userId}
                    mostraSede={mostraSede}
                    onClose={() => setDrawer(null)}
                    onIncassa={() => { setSelected(drawer); setDrawer(null); }}
                    onModifica={() => { setEditing(drawer); setDrawer(null); }}
                    onRateizza={() => {
                        const a = alunni.find((x) => x.id === drawer.alunno_id);
                        if (a) setRateizza({ alunno: a, pagamento: drawer });
                        setDrawer(null);
                    }}
                    // Il `pagamento` del drawer resta la fotografia presa al clic: il suo chip non si
                    // accende finché non si riapre (dichiarato, D6); la riga della tabella sì.
                    onAccodata={(e) => dopoAccodamento(drawer.id, e)}
                    extra={
                        <SospensioneToggle alunnoId={drawer.alunno_id} userId={userId} sospeso={!!sospesoByAlunno.get(drawer.alunno_id)} onChange={load} />
                    }
                />
            )}
        </div>
    );
}
