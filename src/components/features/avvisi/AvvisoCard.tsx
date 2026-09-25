'use client';

import { motion } from 'framer-motion';
import { Eye, ThumbsUp, ThumbsDown, Clock, ChevronDown, Users, Pencil, Trash2, Megaphone, ClipboardList, Share2, Hourglass, Lock } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { condividi } from '@/lib/native/share';
import { avvisoDocumento, nomeDocumentoDa, suNativo, type AvvisoDocumento } from '@/lib/native/documento-genitore';
import { formatData } from '@/lib/i18n/date';
import { etichettaDestinatario, type ClasseNota } from '@/lib/avvisi/destinatari';

// Tipo del traduttore next-intl: serve per passare `t` alle funzioni helper
// (timeAgo/statusBadge) definite fuori dal componente, dove gli hook non si usano.
type Traduttore = ReturnType<typeof useTranslations>;

/**
 * UN FIGLIO DESTINATARIO, CON LO STATO DELLA SUA RIGA.
 *
 * 🔴 `stato_adesione` e `numero_partecipanti` sono qui per la stessa ragione per
 * cui stanno in `my_response`: sono LA PROPRIA RIGA, non una capienza. Da «Giulia
 * è in lista d'attesa» non si ricava nessun numero di posti liberi — servono
 * quando i figli NON concordano, cioè esattamente quando l'aggregato è `null` e
 * `null`, in quel punto, vale «ammesso».
 *
 * Facoltativi nel tipo perché il ramo staff non li manda e un payload degradato
 * può non averli: chi legge ricade sull'aggregato, come prima.
 */
export interface FiglioAvviso {
    student_id: string;
    nome: string;
    stato_adesione?: string | null;
    numero_partecipanti?: number | null;
}

export interface Avviso {
    id: string;
    author_id: string;
    titolo: string;
    contenuto: string;
    tipo: string; // 'presa_visione' | 'adesione'
    target_scope: string;
    target_classes: string[] | null;
    /** La colonna STORICA (una `date` pura). Resta per gli avvisi pubblicati prima del cantiere A2. */
    scadenza: string | null;
    /**
     * Le due scadenze del cantiere A2 (data **e ora**). Facoltative nel tipo perché
     * su un database non migrato — il DB E2E della CI — non esistono, e la card
     * deve rendersi lo stesso: il degrado lo dichiara la rotta, non si nasconde qui.
     */
    scadenza_avviso?: string | null;
    scadenza_adesione?: string | null;
    /** La configurazione del contatore, come l'ha scritta la segreteria. */
    chiedi_numero?: boolean | null;
    etichetta_numero?: string | null;
    numero_min?: number | null;
    numero_max?: number | null;
    /**
     * ─── I DUE BOOLEANI LI DECIDE IL SERVER, E NON PIÙ IL TABLET ─────────────
     *
     * `GET /api/avvisi` li calcola con l'UNICO istante della richiesta e con le
     * stesse funzioni (`@/lib/avvisi/scadenze`) che la RPC dell'adesione usa per
     * decidere chi entra. Fino al 2026-09-19 questa card faceva invece
     * `new Date(avviso.scadenza) < new Date()`: `new Date('2026-09-19')` è
     * mezzanotte **UTC**, cioè le 02:00 italiane d'estate, quindi dalle 02:00 in
     * poi un avviso che scadeva quel giorno risultava già morto — scaduto per
     * ventidue ore su ventiquattro dell'ULTIMO giorno utile. E il confronto lo
     * faceva l'orologio del dispositivo: un tablet con la data sbagliata mostrava
     * bottoni che il server avrebbe rifiutato.
     *
     * 🔴 Non si ricostruiscono qui: la regola «la scadenza è l'ultimo istante
     * valido, INCLUSO» vive in un posto solo, e il lock
     * `__tests__/architecture/avvisi-scadenza-un-motore-solo.test.ts` lo impone.
     */
    scaduto?: boolean;
    adesioni_chiuse?: boolean;
    attachment_url: string | null;
    created_at: string;
    author: { first_name: string; last_name: string; role: string };
    stats: { letti: number; adesioni_si: number; adesioni_no: number };
    /**
     * LA PROPRIA RIGA, aggregata sui figli destinatari dal server.
     *
     * 🔴 `stato_adesione` e `numero_partecipanti` non sono una statistica di
     * capienza: dicono dove sta QUESTA famiglia, non quanto spazio resta agli
     * altri. I posti liberi al genitore non arrivano mai, nemmeno per sottrazione
     * (decisione n. 17 del committente): vede «sei in lista d'attesa», non «ne
     * restano 3». Quando i figli non concordano i due campi sono `null` — un
     * genitore con Marco ammesso e Giulia in coda non HA uno stato.
     */
    my_response?: {
        letto_il: string | null;
        risposta: string | null;
        risposto_il: string | null;
        stato_adesione?: string | null;
        numero_partecipanti?: number | null;
    } | null;
    /**
     * I FIGLI cui l'avviso si riferisce, con lo stato della riga di ciascuno.
     * Lo aggiunge il ramo genitore di `GET /api/avvisi`; sul ramo staff non c'è.
     */
    figli?: FiglioAvviso[];
}

interface Props {
    avviso: Avviso;
    index: number;
    isTeacher?: boolean;
    /**
     * Le sezioni che il chiamante conosce, per tradurre `target_classes` in
     * nomi di classe. È OPZIONALE perché non tutti hanno una fonte: il genitore
     * non ha nessun elenco di sezioni, e in quel caso una voce che è un id si
     * dichiara sconosciuta invece di comparire a schermo come uuid.
     */
    classiNote?: readonly ClasseNota[];
    onReadReceipt?: (avvisoId: string) => void;
    /**
     * IL GESTO, NON LA SCRITTURA.
     *
     * 🔴 La card non scrive mai un'adesione. `si` significa «questo genitore vuole
     * aderire»: se l'avviso chiede quante persone, la PAGINA apre la modale e la
     * riga nasce solo alla conferma — senza il numero l'adesione non vale e non si
     * salva. `no` è la risposta negativa e il ritiro, che un numero non ce l'hanno.
     * Riceve l'avviso intero e non il solo id, perché chi decide ha bisogno di
     * `chiedi_numero`, dell'etichetta e dell'intervallo.
     */
    onAdesione?: (avviso: Avviso, risposta: 'si' | 'no') => void;
    /** «Modifica il numero»: riapre la stessa modale, precompilata. */
    onModificaNumero?: (avviso: Avviso) => void;
    onShowDetails?: (avviso: Avviso) => void;
    onEdit?: (avviso: Avviso) => void;
    onDelete?: (avvisoId: string) => void;
}

function timeAgo(iso: string, t: Traduttore): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('adesso');
    if (mins < 60) return t('minutiFa', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('oreFa', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('giorniFa', { n: days });
}

/**
 * Badge di stato in stile DR (AvvisoRow). Riceve `t` perché è definita fuori dal
 * componente.
 *
 * 🔴 `inAttesa` NON è un ornamento del corpo: il badge sta FUORI dal pannello
 * espanso, ed è ciò che la famiglia legge senza aprire la card. Fino al
 * 2026-09-19 questa funzione guardava il solo `myAnswer`, quindi a chi era in
 * coda annunciava «HAI ADERITO» in verde — lo stesso difetto che il riquadro di
 * `statoRisposta` dichiarava chiuso, sopravvissuto tre righe più su perché il
 * corpo diceva la verità e la testata no.
 */
function statusBadge(opts: { isAdesione: boolean; isRead: boolean; myAnswer?: string | null; inAttesa: boolean; isTeacher?: boolean }, t: Traduttore) {
    const { isAdesione, isRead, myAnswer, inAttesa, isTeacher } = opts;
    if (isTeacher) {
        return isAdesione
            ? { txt: t('badgeConfermaAdesione'), cls: 'bg-kidville-yellow text-kidville-green' }
            : { txt: t('badgeComunicazione'), cls: 'bg-kidville-info-soft text-kidville-info' };
    }
    if (isAdesione) {
        if (myAnswer === 'si') {
            return inAttesa
                ? { txt: t('badgeInAttesa'), cls: 'bg-kidville-warn-soft text-kidville-warn' }
                : { txt: t('badgeHaiAderito'), cls: 'bg-kidville-success-soft text-kidville-success' };
        }
        if (myAnswer === 'no') return { txt: t('badgeNonAderisci'), cls: 'bg-kidville-error-soft text-kidville-error' };
        return { txt: t('badgeRichiedeAdesione'), cls: 'bg-kidville-yellow text-kidville-green' };
    }
    return isRead
        ? { txt: t('badgeLetto'), cls: 'bg-kidville-neutral-soft text-kidville-sub' }
        : { txt: t('badgeDaLeggere'), cls: 'bg-kidville-green-soft text-kidville-green' };
}

/**
 * LA RIGA CHE DICE DOVE STA QUESTA FAMIGLIA — e che non dice mai quanti posti restano.
 *
 * Tre esiti e non due: «hai aderito», «sei in lista d'attesa», «hai declinato». Il
 * secondo esisteva già nel database dal cantiere A2 e non arrivava a nessuno: la
 * card mostrava «Hai aderito ✓» anche a chi era in coda, cioè annunciava un posto
 * che non c'era.
 *
 * ⚠️ QUESTA FUNZIONE È SOLO LA METÀ DEL RIMEDIO, e per due settimane il riquadro
 * ha dichiarato chiuso un difetto che era chiuso a metà: il BADGE della testata
 * continuava a dire «HAI ADERITO» in verde a chi aspettava, ed è quello che si
 * legge senza aprire la card. L'altra metà sta in `statusBadge`; la terza — i
 * figli che non stanno nello stesso posto — in `statoPerFiglio`.
 *
 * Il numero di persone compare solo quando la famiglia l'ha
 * dichiarato: le righe storiche non ce l'hanno, e «per 1 persona» scritto per
 * convenzione sarebbe un dato inventato messo davanti a chi l'avrebbe smentito.
 *
 * 🔴 Nessuna di queste frasi contiene un conteggio di posti liberi, e non deve
 * poterlo contenere: al genitore arriva lo stato della PROPRIA riga, mai la
 * capienza (decisione n. 17 del committente).
 */
function statoRisposta(
    opts: { myAnswer?: string | null; statoAdesione: string | null; numeroPersone: number | null },
    t: Traduttore,
) {
    const { myAnswer, statoAdesione, numeroPersone } = opts;
    if (myAnswer !== 'si') {
        return (
            <>
                <ThumbsDown size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>{t('haiDeclinato')}</span>
            </>
        );
    }
    const inAttesa = statoAdesione === 'in_attesa';
    // `Number.isFinite` e non `!= null`: un `NaN` sfuggito al trasporto
    // diventerebbe «NaN persone» a schermo, che è peggio del numero mancante.
    const n = typeof numeroPersone === 'number' && Number.isFinite(numeroPersone) ? numeroPersone : null;
    const testo = inAttesa
        ? (n !== null ? t('seiInAttesaPersone', { count: n }) : t('badgeInAttesa'))
        : (n !== null ? t('haiAderitoPersone', { count: n }) : t('haiAderitoConferma'));
    return (
        <>
            {inAttesa
                ? <Hourglass size={12} strokeWidth={1.8} aria-hidden="true" />
                : <ThumbsUp size={12} strokeWidth={1.8} aria-hidden="true" />}
            <span>{testo}</span>
        </>
    );
}

/**
 * QUANDO I FIGLI NON STANNO NELLO STESSO POSTO — una riga per ciascuno.
 *
 * 🔴 Il caso che questo blocco esiste per dire: Marco ammesso, Giulia in coda.
 * `risposta` CONCORDA (entrambi «sì»), quindi la card è nel ramo «hai aderito», e
 * lì l'aggregato `stato_adesione: null` vale AMMESSO — e deve valere ammesso,
 * perché le 869 righe storiche hanno lo stato nullo e quelle famiglie sono dentro
 * davvero. Il risultato misurato era «Hai aderito per 3 persone ✓», in verde, con
 * la coda mai nominata.
 *
 * Non si inventa un terzo valore aggregato: si mostra il dato che già esiste, per
 * figlio. Le due frasi sono quelle del pannello d'esito della modale
 * (`adesioneEsitoAttesaFiglio` / `adesioneEsitoAmmessoFiglio`): è lo stesso fatto
 * detto nello stesso modo, e una seconda formulazione della stessa cosa è il
 * difetto F1 del collaudo del 2026-07-31.
 *
 * ⚠️ `stato_adesione` diverso da `'in_attesa'` — `null` compreso — è AMMESSO. La
 * lista bianca è sul valore che cambia la frase, mai sull'assenza del dato.
 */
function statoPerFiglio(figli: readonly FiglioAvviso[], t: Traduttore) {
    return (
        <ul className="flex flex-col gap-1">
            {figli.map((f) => (
                <li key={f.student_id} className="flex items-center gap-2">
                    {f.stato_adesione === 'in_attesa'
                        ? <Hourglass size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
                        : <ThumbsUp size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />}
                    <span>
                        {f.stato_adesione === 'in_attesa'
                            ? t('adesioneEsitoAttesaFiglio', { nome: f.nome })
                            : t('adesioneEsitoAmmessoFiglio', { nome: f.nome })}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function AvvisoCard({ avviso, index, isTeacher, classiNote, onReadReceipt, onAdesione, onModificaNumero, onShowDetails, onEdit, onDelete }: Props) {
    const t = useTranslations('avvisi');
    const ts = useTranslations('shared');
    const locale = useLocale();
    const [expanded, setExpanded] = useState(false);
    // Nell'app, l'ultimo tocco sull'allegato non ha mostrato niente (anteprima non aperta,
    // condivisione fallita, copia muta negli appunti): lo si dice, o il pulsante resta muto.
    // Il valore è il TIPO d'avviso: sul binario 1.0 (`'aggiorna'`) riprovare non riuscirà
    // mai, e il testo lo deve dire invece di «riprova fra qualche minuto».
    const [allegatoNonAperto, setAllegatoNonAperto] = useState<AvvisoDocumento | null>(null);
    // L'id del pannello che il bottone della testata governa. Da `useId()` e non
    // da `avviso.id`: un id ricavato dal DATO è una proprietà del dato, non
    // dell'ISTANZA — due card dello stesso avviso montate nello stesso documento
    // avrebbero lo stesso `aria-controls`, e il bottone dell'una aprirebbe (per
    // chi ascolta) il pannello dell'altra.
    //
    // ⚠️ La home NON è quel caso, e per due settimane questo commento ha detto il
    // contrario: `/parent` monta `AvvisiPreview`, che è un'altra componente e non
    // questa card. `useId()` resta perché lega l'id all'istanza e non costa
    // niente; la ragione, però, è questa.
    const idCard = useId();
    const idPannello = `avviso-corpo-${idCard}`;
    // Stessa ragione di `idPannello`: la domanda di conferma del ritiro è puntata
    // da `aria-describedby`, e due istanze della stessa card non devono
    // condividere l'id.
    const idConfermaRitiro = `avviso-ritiro-${idCard}`;
    const isAdesione = avviso.tipo === 'adesione';
    const isRead = !!avviso.my_response?.letto_il;
    const myAnswer = avviso.my_response?.risposta;
    const statoAdesione = avviso.my_response?.stato_adesione ?? null;
    const numeroPersone = avviso.my_response?.numero_partecipanti ?? null;
    // ── LO STATO PER FIGLIO, E LE DUE DOMANDE CHE DECIDE ────────────────────
    //
    // `qualcunoInAttesa` decide il BADGE della testata (che si legge senza aprire
    // la card); `figliDiscordi` decide se il corpo elenca i figli uno per uno
    // invece di dare una frase sola per tutta la famiglia. Su un payload che non
    // porta `figli` — ramo staff, degrado — entrambi restano falsi e il
    // comportamento è quello di prima, deciso dal solo aggregato.
    const figliAvviso = avviso.figli ?? [];
    const qualcunoInAttesa =
        statoAdesione === 'in_attesa' || figliAvviso.some((f) => f.stato_adesione === 'in_attesa');
    // Discordi = c'è chi aspetta e c'è chi no. Se aspettano tutti l'aggregato è
    // già `'in_attesa'` e la frase unica dice il vero (col numero, se c'è).
    const figliDiscordi =
        figliAvviso.length > 1
        && figliAvviso.some((f) => f.stato_adesione === 'in_attesa')
        && !figliAvviso.every((f) => f.stato_adesione === 'in_attesa');
    // I DUE BOOLEANI ARRIVANO CALCOLATI (vedi il riquadro su `Avviso.scaduto`):
    // qui non si confronta più niente. `=== true` e non un cast: su un payload
    // degradato il campo manca del tutto, e «assente» deve valere «non scaduto»
    // come prima, non `undefined` che si comporta a caso dentro un ternario.
    const scaduto = avviso.scaduto === true;
    const adesioniSonoChiuse = avviso.adesioni_chiuse === true;
    // I due istanti, col ripiego sulla colonna storica — lo STESSO che fa
    // `scadenzaEffettiva` sulla rotta. Estratti in una costante e non letti dentro
    // il JSX perché così restano un valore, non un'espressione da confrontare.
    const istanteAvviso = avviso.scadenza_avviso ?? avviso.scadenza ?? null;
    const istanteAdesioni = avviso.scadenza_adesione ?? null;
    // Quando le adesioni si sono chiuse: il termine dedicato se c'è, altrimenti
    // quello dell'avviso — gemello del ripiego di `adesioniChiuse` in
    // `@/lib/avvisi/scadenze`, che è chi ha deciso il booleano qui sopra.
    const istanteChiusura = istanteAdesioni ?? istanteAvviso;
    const unread = !isRead && !isTeacher;
    const badge = statusBadge({ isAdesione, isRead, myAnswer, inAttesa: qualcunoInAttesa, isTeacher }, t);
    // «Cambia risposta» non scrive: riapre le due scelte. Una POST per tornare
    // sul «no» che c'è già sarebbe una scrittura che non cambia niente — e che su
    // un avviso con i posti contati passerebbe comunque dalla RPC.
    const [riapriScelta, setRiapriScelta] = useState(false);
    // Il ritiro libera un posto che un'altra famiglia può prendere: si conferma.
    // In LINEA e a due passi, non con una seconda modale — su 360 px un dialogo
    // dentro un dialogo è un vicolo cieco, e il pollice è già qui.
    const [confermaRitiro, setConfermaRitiro] = useState(false);
    const rifConferma = useRef<HTMLButtonElement>(null);
    // Il bottone che ha aperto la conferma sparisce, quindi il fuoco resterebbe su
    // `<body>`: si porta sul primo comando del passo successivo (WCAG 2.4.3).
    useEffect(() => {
        if (confermaRitiro) rifConferma.current?.focus();
    }, [confermaRitiro]);

    // Target leggibile: una pill «🌐 Tutti» per gli avvisi di plesso, una pill
    // per ogni classe destinataria. Contrasto Clay Village (green su green-soft).
    //
    // `target_classes` è un campo ETEROGENEO: il modulo ci scrive i NOMI, ma in
    // produzione ci sono record che portano l'ID della sezione. Finché il plesso
    // era uno le due forme erano ugualmente leggibili (il nome era di fatto una
    // chiave); con tre sedi non lo è più, e il collaudo iOS del 2026-07-31 (F4)
    // ha fotografato questa card mentre stampava `219cab6a-…` come destinatario
    // — mentre il cockpit, sullo stesso avviso, diceva «TEST Infanzia».
    // `etichettaDestinatario` fa quella risoluzione (id → nome, sede accanto solo
    // se deducibile) e, quando la voce è un uuid che non si risolve, NON restituisce
    // testo: la parola la mette qui il catalogo. Un uuid non è un'informazione per
    // un genitore né per un docente, ed è la ragione per cui non finisce nemmeno
    // in un `title`: un attributo lo nasconde alla vista, non allo screen reader.
    const isGlobale = avviso.target_scope === 'globale';
    const classiTarget = isGlobale ? [] : (avviso.target_classes ?? []).filter(Boolean);
    const destinatari = classiTarget.map((voce) => {
        const e = etichettaDestinatario(voce, classiNote ?? []);
        return { chiave: voce, testo: e.risolta ? e.testo : t('classeSconosciuta') };
    });
    const showTargetPills = isGlobale || destinatari.length > 0;

    // Decodifica allegato (JSON o link semplice)
    let fileUrl = null;
    let linkUrl = null;
    if (avviso.attachment_url) {
        if (avviso.attachment_url.startsWith('{')) {
            try {
                const parsed = JSON.parse(avviso.attachment_url);
                fileUrl = parsed.file;
                linkUrl = parsed.link;
            } catch {
                fileUrl = avviso.attachment_url;
            }
        } else {
            fileUrl = avviso.attachment_url;
        }
    }

    const handleExpand = () => {
        setExpanded(v => !v);
        if (!isRead && onReadReceipt) {
            onReadReceipt(avviso.id);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.3 }}
            className={`overflow-hidden rounded-3xl border bg-kidville-white shadow-sm transition-all ${
                unread ? 'border-kidville-yellow/60' : 'border-kidville-line'
            }`}
        >
            {/* Testata — disclosure secondo ARIA APG: intestazione → bottone
                (`aria-expanded` + `aria-controls`) → pannello con lo stesso id.
                Prima era un unico `<button>` che avvolgeva TUTTA la testata:
                due difetti in una riga sola.
                 · Nessuno dei due stati era annunciato: si premeva Invio, il
                   corpo dell'avviso compariva, e lo screen reader continuava a
                   dire «pulsante». Su /teacher/avvisi gli elementi con
                   `aria-expanded` erano uno solo in tutta la pagina, ed era il
                   menu della bottom-nav.
                 · `<h2>`, `<p>` e `<div>` stavano DENTRO il bottone, che per
                   content model ammette solo phrasing content: HTML non valido,
                   e diversi screen reader appiattiscono il contenuto del bottone
                   in un'unica etichetta — vanificando proprio la correzione
                   h3 → h2 fatta per chi naviga per intestazioni.
                L'area di tocco NON si restringe al titolo: il bottone si estende
                sulla testata con uno pseudo-elemento (`after:inset-0` sopra
                questo contenitore `relative`), così sul telefono la card si apre
                toccandola ovunque come prima. */}
            <div
                data-kv-testata-avviso
                className="relative flex w-full items-start gap-3 px-5 py-4 text-left"
            >
                {/* Icon */}
                {/* L'icona è il segno che distingue «adesione» da «comunicazione»:
                    va letta, quindi vale la soglia 3:1 di WCAG 1.4.11. Il token
                    caldo che la reggeva (`yellow-dark`) sta a 1,75:1 sul proprio
                    fondo — meno di un'ombra. `warn-strong` tiene il caldo a 4,97:1. */}
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${
                    isAdesione ? 'bg-kidville-yellow-soft text-kidville-warn-strong' : 'bg-kidville-green-soft text-kidville-green'
                }`}>
                    {isAdesione ? <ClipboardList size={19} strokeWidth={1.8} /> : <Megaphone size={19} strokeWidth={1.8} />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
                            {badge.txt}
                        </span>
                        <span className="flex-shrink-0 font-maven text-[11px] text-kidville-sub">{timeAgo(avviso.created_at, t)}</span>
                    </div>
                    {/* `h2`, non `h3`: la card sta SEMPRE sotto l'`h1` della testata di
                        pagina (`PageHeaderCard`) e non c'è nessuna sezione in mezzo. Con
                        l'`h3` la bacheca del docente saltava da h1 a h3 dieci volte di
                        fila, e chi naviga per intestazioni non aveva modo di sapere se si
                        era perso un livello. */}
                    <h2 className="mt-1.5 font-barlow text-base font-extrabold uppercase leading-tight tracking-wide text-kidville-green">
                        <button
                            type="button"
                            onClick={handleExpand}
                            aria-expanded={expanded}
                            aria-controls={idPannello}
                            className="block w-full text-left after:absolute after:inset-0 after:content-['']"
                        >
                            {/* Il troncamento sta su questo `span`, non sul bottone.
                                `truncate` porta con sé `overflow: hidden`, e un
                                elemento che ritaglia i propri discendenti è l'ultimo
                                posto dove mettere lo pseudo-elemento che allarga
                                l'area di tocco: il comportamento dipenderebbe da
                                una regola di clipping sottile invece che dalla
                                struttura. Uno `span` resta phrasing content, quindi
                                il bottone continua a essere HTML valido. */}
                            <span className="block truncate">{avviso.titolo}</span>
                        </button>
                    </h2>
                    <p className="mt-0.5 font-maven text-[11px] text-kidville-sub">
                        {avviso.author.first_name} {avviso.author.last_name}
                    </p>
                    {showTargetPills && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {isGlobale ? (
                                <span className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green">
                                    {t('tutti')}
                                </span>
                            ) : (
                                destinatari.map((d) => (
                                    <span
                                        key={d.chiave}
                                        className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green"
                                    >
                                        {d.testo}
                                    </span>
                                ))
                            )}
                        </div>
                    )}
                </div>

                <motion.div
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-1 flex-shrink-0"
                >
                    <ChevronDown size={16} className="text-kidville-sub" strokeWidth={1.8} />
                </motion.div>
            </div>

            {/* Expanded content — è il pannello puntato da `aria-controls`. */}
            {expanded && (
                <motion.div
                    id={idPannello}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="border-t border-kidville-line"
                >
                    {/* Contenuto */}
                    <div className="px-5 py-4">
                        {/* `text-kidville-sub`, non l'hex letterale che c'era prima:
                            è lo STESSO colore (#55615C), ma scritto a mano restava
                            fuori dalle rimappature per-superficie e dall'inventario
                            dei token. */}
                        <p className="whitespace-pre-wrap font-maven text-sm leading-relaxed text-kidville-sub">
                            {avviso.contenuto}
                        </p>

                        {/* ── LE DUE SCADENZE ────────────────────────────────
                            Una riga per ciascuna, e due frasi diverse: «fino a
                            quando si legge» e «entro quando si risponde» sono la
                            ragione stessa per cui i termini sono due — «le adesioni
                            si chiudono venerdì, ma l'avviso resta leggibile fino
                            alla gita».

                            `formatData`, mai `toLocaleDateString(locale, …)`.
                            Quella chiamata aveva due difetti nello stesso
                            argomento: il locale GREZZO di next-intl («en», che Intl
                            risolve su en-US: «8/10» letto al contrario) e NESSUN
                            fuso, quindi il fuso dell'ambiente — UTC sul processo
                            Vercel, Europe/Rome nel browser di una famiglia. Fra le
                            00:00 e le 02:00 italiane la stessa scadenza rendeva due
                            GIORNI diversi. Il formato è `dataOra` e non `lunga`:
                            adesso i termini hanno un'ORA, e mostrarne solo il
                            giorno rifarebbe a schermo lo stesso taglio che il
                            cantiere ha appena tolto dai confronti. */}
                        {istanteAvviso && (
                            <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                scaduto
                                    ? 'border-kidville-error/20 bg-kidville-error-soft text-kidville-error'
                                    : 'border-kidville-warn/20 bg-kidville-warn-soft text-kidville-warn'
                            }`}>
                                <Clock size={12} strokeWidth={1.8} aria-hidden="true" />
                                <span>
                                    {scaduto
                                        ? `${t('scadutoIl')} ${formatData(istanteAvviso, locale, 'dataOra')}`
                                        : t('visibileFinoAl', { data: formatData(istanteAvviso, locale, 'dataOra') })}
                                </span>
                            </div>
                        )}
                        {isAdesione && istanteAdesioni && (
                            <div className={`mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                adesioniSonoChiuse
                                    ? 'border-kidville-neutral/20 bg-kidville-neutral-soft text-kidville-sub'
                                    : 'border-kidville-info/20 bg-kidville-info-soft text-kidville-info'
                            }`}>
                                <ClipboardList size={12} strokeWidth={1.8} aria-hidden="true" />
                                <span>
                                    {adesioniSonoChiuse
                                        ? t('adesioniChiuseIl', { data: formatData(istanteAdesioni, locale, 'dataOra') })
                                        : t('perAderireEntro', { data: formatData(istanteAdesioni, locale, 'dataOra') })}
                                </span>
                            </div>
                        )}

                        {/* Allegati e Link */}
                        {(fileUrl || linkUrl) && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {fileUrl && (
                                    <a
                                        href={fileUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        // L'allegato è da GUARDARE (spec 2026-09-24, NAT3c): sul web
                                        // il collegamento resta com'è; nell'app 1.1 `suNativo` apre
                                        // l'anteprima di sistema dentro l'app. Il log lo scrive l'helper.
                                        onClick={suNativo(
                                            'apri',
                                            () => ({
                                                sorgente: String(fileUrl),
                                                nomeFile: nomeDocumentoDa(null, String(fileUrl), 'kidville-avviso'),
                                                etichetta: 'allegato-avviso',
                                            }),
                                            (esito) => setAllegatoNonAperto(avvisoDocumento(esito)),
                                        )}
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-green transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        {t('allegatoFile')}
                                    </a>
                                )}
                                {linkUrl && (
                                    <a
                                        href={linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-info transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        {t('linkEsterno')}
                                    </a>
                                )}
                                {fileUrl && allegatoNonAperto && (
                                    <p role="alert" className="basis-full font-maven text-xs text-kidville-error">
                                        {ts(allegatoNonAperto === 'aggiorna' ? 'documentoAppDaAggiornare' : 'documentoNonAperto')}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Condivisione (genitore): titolo + testo dell'avviso */}
                        {!isTeacher && (
                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        void condividi({ title: avviso.titolo, text: `${avviso.titolo}\n\n${avviso.contenuto}` })
                                    }
                                    aria-label={t('condividiAria')}
                                    className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 bg-kidville-white px-3 py-2 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green transition-colors hover:bg-kidville-cream active:scale-95"
                                >
                                    <Share2 size={14} strokeWidth={2} /> {t('condividi')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* ═══ IL BLOCCO DELL'ADESIONE, PER IL GENITORE ═══════════
                        Cinque stati, e nessuno di loro è il silenzio. Prima, a
                        termine passato, i due bottoni SPARIVANO senza una parola:
                        il genitore leggeva un avviso che chiede di aderire e non
                        aveva nessun modo di rispondere né di sapere perché. */}
                    {!isTeacher && isAdesione && (
                        <div className="px-5 pb-4">
                            {adesioniSonoChiuse ? (
                                /* ── Adesioni chiuse: si spiega, e NIENTE bottoni. ── */
                                <div className="flex flex-col gap-2">
                                    {myAnswer && (
                                        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                            myAnswer === 'si' && qualcunoInAttesa
                                                ? 'border-kidville-warn/20 bg-kidville-warn-soft text-kidville-warn'
                                                : myAnswer === 'si'
                                                    ? 'border-kidville-success/20 bg-kidville-success-soft text-kidville-success'
                                                    : 'border-kidville-neutral/20 bg-kidville-neutral-soft text-kidville-sub'
                                        }`}>
                                            {myAnswer === 'si' && figliDiscordi
                                                ? statoPerFiglio(figliAvviso, t)
                                                : statoRisposta({ myAnswer, statoAdesione, numeroPersone }, t)}
                                        </div>
                                    )}
                                    <div className="flex items-start gap-2 rounded-xl border border-kidville-neutral/20 bg-kidville-neutral-soft px-3 py-2 font-maven text-xs text-kidville-sub">
                                        <Lock size={12} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0" />
                                        <span>
                                            {myAnswer
                                                ? t('adesioniChiuse', { data: formatData(istanteChiusura, locale, 'dataOra') })
                                                : t('adesioniChiuseSenzaRisposta')}
                                        </span>
                                    </div>
                                </div>
                            ) : !myAnswer || riapriScelta ? (
                                /* ── Nessuna risposta (o «cambia risposta»): le due scelte. ──
                                   «Aderisco» NON scrive: chiede alla pagina di aprire la
                                   modale quando l'avviso vuole il numero. */
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => { setRiapriScelta(false); onAdesione?.(avviso, 'si'); }}
                                        className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow transition-all hover:bg-kidville-green-dark active:scale-[0.98]"
                                    >
                                        <ThumbsUp size={14} strokeWidth={2} aria-hidden="true" /> {t('aderisco')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => { setRiapriScelta(false); onAdesione?.(avviso, 'no'); }}
                                        className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green-soft py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green transition-all hover:bg-kidville-cream-dark active:scale-[0.98]"
                                    >
                                        <ThumbsDown size={14} strokeWidth={2} aria-hidden="true" /> {t('nonAderisco')}
                                    </button>
                                </div>
                            ) : myAnswer === 'si' ? (
                                /* ── Ammesso oppure in lista d'attesa. ──────────────
                                   Le due righe differiscono per TONO e per parola, mai
                                   per un numero di posti: quanti ne restano è affare
                                   della segreteria. */
                                <div className="flex flex-col gap-2">
                                    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                        qualcunoInAttesa
                                            ? 'border-kidville-warn/20 bg-kidville-warn-soft text-kidville-warn'
                                            : 'border-kidville-success/20 bg-kidville-success-soft text-kidville-success'
                                    }`}>
                                        {figliDiscordi
                                            ? statoPerFiglio(figliAvviso, t)
                                            : statoRisposta({ myAnswer, statoAdesione, numeroPersone }, t)}
                                    </div>
                                    {confermaRitiro ? (
                                        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2">
                                            <span id={idConfermaRitiro} className="font-maven text-xs text-kidville-error">
                                                {t('ritiraConferma')}
                                            </span>
                                            <button
                                                type="button"
                                                ref={rifConferma}
                                                aria-describedby={idConfermaRitiro}
                                                onClick={() => { setConfermaRitiro(false); onAdesione?.(avviso, 'no'); }}
                                                className="rounded-pill bg-kidville-error px-3 py-1.5 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-white transition-transform active:scale-95"
                                            >
                                                {t('ritiraSi')}
                                            </button>
                                            <button
                                                type="button"
                                                aria-describedby={idConfermaRitiro}
                                                onClick={() => setConfermaRitiro(false)}
                                                className="rounded-pill border border-kidville-line bg-kidville-white px-3 py-1.5 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green transition-transform active:scale-95"
                                            >
                                                {t('ritiraAnnulla')}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {/* «Modifica il numero» solo se un numero è
                                                stato chiesto: su un avviso senza contatore
                                                non c'è niente da modificare, e un comando
                                                che apre un campo inesistente è peggio di
                                                un comando assente. */}
                                            {avviso.chiedi_numero === true && (
                                                <button
                                                    type="button"
                                                    onClick={() => onModificaNumero?.(avviso)}
                                                    className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 bg-kidville-white px-3 py-2 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green transition-colors hover:bg-kidville-cream active:scale-95"
                                                >
                                                    <Pencil size={13} strokeWidth={2} aria-hidden="true" /> {t('modificaNumero')}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => setConfermaRitiro(true)}
                                                className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-error/30 bg-kidville-white px-3 py-2 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-error transition-colors hover:bg-kidville-error-soft active:scale-95"
                                            >
                                                <Trash2 size={13} strokeWidth={2} aria-hidden="true" /> {t('ritiraAdesione')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* ── Declinato. ─────────────────────────────────── */
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2 rounded-xl border border-kidville-neutral/20 bg-kidville-neutral-soft px-3 py-2 font-maven text-xs text-kidville-sub">
                                        {statoRisposta({ myAnswer, statoAdesione, numeroPersone }, t)}
                                    </div>
                                    <div>
                                        <button
                                            type="button"
                                            onClick={() => setRiapriScelta(true)}
                                            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 bg-kidville-white px-3 py-2 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green transition-colors hover:bg-kidville-cream active:scale-95"
                                        >
                                            <Pencil size={13} strokeWidth={2} aria-hidden="true" /> {t('cambiaRisposta')}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Stats e Azioni per insegnante */}
                    {isTeacher && (
                        <div className="flex flex-wrap items-center gap-4 border-t border-kidville-line px-5 pb-4 pt-3">
                            <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-sub">
                                <Eye size={12} strokeWidth={1.8} />
                                <span>{t('hannoLetto', { count: avviso.stats.letti })}</span>
                            </div>
                            {isAdesione && (
                                <>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-success">
                                        <ThumbsUp size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_si}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-sub">
                                        <ThumbsDown size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_no}</span>
                                    </div>
                                </>
                            )}
                            <div className="ml-auto flex items-center gap-3">
                                <button
                                    onClick={() => onShowDetails?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-green hover:underline"
                                >
                                    <Users size={12} strokeWidth={1.8} /> {t('dettaglio')}
                                </button>
                                <button
                                    onClick={() => onEdit?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-info hover:underline"
                                >
                                    <Pencil size={12} strokeWidth={1.8} /> {t('modifica')}
                                </button>
                                <button
                                    onClick={() => onDelete?.(avviso.id)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-error hover:underline"
                                >
                                    <Trash2 size={12} strokeWidth={1.8} /> {t('elimina')}
                                </button>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </motion.div>
    );
}
