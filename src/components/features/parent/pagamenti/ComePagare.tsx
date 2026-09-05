'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info, Landmark, Banknote, Building2, MapPin } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { BTN_COPIA_AA, CAMPO_COPIABILE, CausaleBonifico, ETICHETTA, type VoceCausale } from './CausaleBonifico';

/**
 * Le coordinate di UNA sede, come le compone il server (`GET /api/pagamenti` →
 * `sedi`), che a sua volta le prende da `admin_settings.fiscale_config` /
 * `aruba_config` — le stesse che finiscono nel riquadro «Dati per il bonifico»
 * delle email di sollecito.
 *
 * `iban` arriva GIÀ leggibile a gruppi di quattro ed è `null` quando manca o non
 * supera il mod-97: a schermo non deve mai comparire un IBAN sbagliato, e un
 * campo vuoto è meno dannoso di uno errato. `intestatario` è la denominazione del
 * cedente (nessun campo nuovo: decisione del titolare nello spec del 2026-09-05).
 */
export interface SedeBonifico {
    id: string;
    nome: string;
    iban: string | null;
    intestatario: string | null;
}

/** Un conto: una o più sedi che condividono la stessa coppia (IBAN, intestatario). */
interface BloccoConto {
    chiave: string;
    /** I nomi delle sedi che pagano su questo conto, nell'ordine in cui il server le manda. */
    nomi: string[];
    iban: string | null;
    intestatario: string | null;
    voci: VoceCausale[];
}

/**
 * Raggruppa le voci per conto.
 *
 * Il conto è UNO per la cooperativa, ma la configurazione è PER SEDE e il codice
 * non può darlo per scontato: due sedi con le stesse coordinate si fondono in un
 * blocco solo (che le nomina entrambe), due sedi con coordinate diverse restano
 * due blocchi. Le voci di una sede che il server non ha descritto — risposta di
 * un backend più vecchio, oppure DB della CI senza `fiscale_config` — finiscono
 * in un blocco di ripiego senza coordinate: la causale resta comunque a schermo,
 * ed è l'unica cosa che il genitore non deve perdere.
 *
 * Esportata per essere misurabile da sola: è la regola, non un dettaglio del JSX.
 */
export function raggruppaPerConto(sedi: SedeBonifico[], voci: VoceCausale[]): BloccoConto[] {
    const perId = new Map(sedi.map((s) => [s.id, s]));
    const blocchi: BloccoConto[] = [];
    const indice = new Map<string, BloccoConto>();

    for (const sede of sedi) {
        const vociSede = voci.filter((v) => v.scuola_id === sede.id);
        if (vociSede.length === 0) continue;
        // La chiave è la COPPIA: due sedi con lo stesso IBAN ma intestatari diversi
        // restano due blocchi (il bonifico va intestato a chi lo riceve davvero).
        const chiave = `${sede.iban ?? ''} ${sede.intestatario ?? ''}`;
        const esistente = indice.get(chiave);
        if (esistente) {
            esistente.nomi.push(sede.nome);
            esistente.voci.push(...vociSede);
            continue;
        }
        const blocco: BloccoConto = {
            chiave,
            nomi: [sede.nome],
            iban: sede.iban,
            intestatario: sede.intestatario,
            voci: [...vociSede],
        };
        indice.set(chiave, blocco);
        blocchi.push(blocco);
    }

    const orfane = voci.filter((v) => !perId.has(v.scuola_id));
    if (orfane.length > 0) {
        blocchi.push({ chiave: 'senza-coordinate', nomi: [], iban: null, intestatario: null, voci: orfane });
    }
    return blocchi;
}

type Metodo = 'bonifico' | 'contanti';
const METODI: Metodo[] = ['bonifico', 'contanti'];

/**
 * La scatola dell'icona nelle righe «icona + testo». Larghezza FISSA e centratura:
 * due misure d'icona diverse (16 e 14) con lo stesso `gap` sfalsavano di due pixel il
 * margine sinistro del testo fra una riga e quella sotto — misurato, x84 contro x80.
 * Una sola colonna di testo per blocco.
 */
const SCATOLA_ICONA = 'mt-[2px] flex w-4 shrink-0 justify-center';

/**
 * «Come pagare» — bonifico o contanti, con l'intestatario e l'IBAN della propria
 * sede e le causali per voce incorporate.
 *
 * IL DIFETTO CHE CHIUDE (spec 2026-09-05): la pagina diceva CHE COSA scrivere nel
 * bonifico e non DOVE mandarlo. L'IBAN esisteva già in Impostazioni → Fiscale e
 * usciva soltanto nelle email di sollecito; il genitore che apriva l'app non
 * aveva modo di arrivarci.
 *
 * I contanti si dichiarano perché sono accettati davvero (in segreteria), e
 * insieme si dichiara che NON sono detraibili (L. 160/2019, la stessa regola che
 * `metodoTracciabile` applica in contabilità): dire la prima cosa senza la
 * seconda costerebbe al genitore la detrazione, in silenzio.
 *
 * ─── IL SECONDO GIRO (2026-09-05), dalle schermate a 390px ────────────────────
 * Quattro cose che il disegno di partenza sbagliava, e come sono state raddrizzate:
 *  1. L'IBAN andava a capo IN MEZZO a un gruppo di quattro («…1010 00 / 00 0123
 *     456») perché il bottone gli stava accanto e gli mangiava la riga — e il
 *     punto di rottura CAMBIAVA fra «Copia» e «Copiato». Oggi il valore ha la
 *     riga tutta per sé, senza `break-all`: l'unico posto dove può andare a capo
 *     è lo spazio fra un gruppo e l'altro. Il bottone sta sotto, a tutta larghezza.
 *  2. «Intestato a» era un'etichetta a sinistra col valore allineato a DESTRA:
 *     su un telefono la ragione sociale andava a capo lasciando «soc. coop.» orfano
 *     su una riga sua, con il margine sinistro frastagliato. Oggi è etichetta sopra,
 *     valore sotto, entrambi a bandiera sinistra.
 *  3. La card diceva due volte la stessa cosa: l'introduzione spiegava la causale e
 *     cinque righe dopo la spiegava di nuovo. Oggi l'introduzione ANNUNCIA i due
 *     passi — il conto e la causale — e ciascun passo ha il proprio titolo numerato.
 *  4. La riga dei plessi galleggiava sopra il riquadro, in maiuscolo su nomi propri.
 *     Oggi è la prima riga DENTRO il riquadro, in tondo, con la sua icona.
 */
export function ComePagare({ sedi, voci }: { sedi: SedeBonifico[]; voci: VoceCausale[] }) {
    const t = useTranslations('pagamenti');
    const idBase = useId();
    const [metodo, setMetodo] = useState<Metodo>('bonifico');
    const [copiato, setCopiato] = useState<string | null>(null);
    const tabRefs = useRef<Record<Metodo, HTMLButtonElement | null>>({ bonifico: null, contanti: null });

    if (voci.length === 0) return null;

    const blocchi = raggruppaPerConto(sedi, voci);
    // I nomi delle sedi si mostrano solo quando ce n'è più d'una in pagina:
    // ripetere l'unico plesso della famiglia sarebbe rumore.
    const nomiSedi = blocchi.flatMap((b) => b.nomi);
    const mostraNomi = nomiSedi.length > 1;

    const idTab = (m: Metodo) => `${idBase}-tab-${m}`;
    const idPannello = (m: Metodo) => `${idBase}-panel-${m}`;

    const vaiA = (m: Metodo) => {
        setMetodo(m);
        tabRefs.current[m]?.focus();
    };

    // Tastiera dei tab (WAI-ARIA Tabs, attivazione automatica): frecce con
    // avvolgimento + Home/End. Il fuoco segue la selezione, e il `tabIndex`
    // roving tiene UN solo tab nell'ordine di tabulazione.
    const suTasto = (e: React.KeyboardEvent, m: Metodo) => {
        const i = METODI.indexOf(m);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            vaiA(METODI[(i + 1) % METODI.length]);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            vaiA(METODI[(i - 1 + METODI.length) % METODI.length]);
        } else if (e.key === 'Home') {
            e.preventDefault();
            vaiA(METODI[0]);
        } else if (e.key === 'End') {
            e.preventDefault();
            vaiA(METODI[METODI.length - 1]);
        }
    };

    const copiaIban = async (chiave: string, iban: string) => {
        // Negli appunti va la forma ELETTRONICA dell'IBAN (ISO 13616, senza spazi):
        // è quella che ogni home banking accetta. A schermo resta quella a gruppi
        // di quattro, che è quella che si rilegge.
        try {
            await navigator.clipboard.writeText(iban.replace(/\s+/g, ''));
            setCopiato(chiave);
            setTimeout(() => setCopiato(null), 2000);
        } catch (err) {
            // `navigator.clipboard` dice di no per motivi DIVERSI e distinguibili, e
            // ognuno vuole una correzione diversa: `NotAllowedError` (permesso negato,
            // o gesto utente non riconosciuto), `SecurityError` (contesto non sicuro:
            // http, iframe senza `clipboard-write`), oppure l'API che dentro una
            // WebView non esiste affatto — e quest'ultima è l'unica che riguarda
            // l'app nativa, cioè il posto da cui la card viene letta di più.
            //
            // Il `catch` senza binding buttava via esattamente la parola che li
            // separa: restava «non è riuscita», che è ciò che si sapeva già. Nessun
            // dato personale nel messaggio — l'IBAN non ci entra, e `nomeErrore`
            // restituisce SOLO il nome della classe d'errore, mai il testo del
            // provider.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: `copia-iban-non-riuscita: ${nomeErrore(err)}`,
                route: '/parent/pagamenti',
            });
        }
    };

    const tab = (m: Metodo, etichetta: string, Icona: typeof Landmark) => {
        const attivo = metodo === m;
        return (
            <button
                key={m}
                type="button"
                role="tab"
                id={idTab(m)}
                ref={(el) => { tabRefs.current[m] = el; }}
                aria-selected={attivo}
                aria-controls={idPannello(m)}
                tabIndex={attivo ? 0 : -1}
                onClick={() => setMetodo(m)}
                onKeyDown={(e) => suTasto(e, m)}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-pill px-3 font-barlow text-[13px] font-extrabold uppercase tracking-[0.05em] motion-safe:transition-colors ${
                    attivo ? 'bg-kidville-green text-kidville-white' : 'text-kidville-sub hover:text-kidville-green'
                }`}
            >
                <Icona size={16} aria-hidden="true" /> {etichetta}
            </button>
        );
    };

    /**
     * Titolo di un passo. Il numero non è un vezzo: dice che le due cose vanno fatte
     * TUTTE E DUE, e in quest'ordine.
     *
     * TONDO, NON MAIUSCOLO (2026-09-05, terzo giro). Era `text-[13px] font-extrabold
     * uppercase`: identico — stessa taglia, stesso peso, stesso carattere — al tab e
     * al bottone di copia. «Il conto» e «La causale» sono intestazioni e si leggevano
     * come comandi: a colpo d'occhio la card sembrava avere sei pulsanti invece di
     * quattro. Il maiuscolo resta a occhiello di card, tab e bottoni: TRE livelli,
     * non cinque. 15px, cioè un gradino sopra il titolo delle voci che il passo
     * contiene (14px): un'intestazione non può essere più piccola dei propri figli.
     *
     * LA PASTIGLIA NON È PIÙ VERDE (quinto giro, 2026-09-05). Portava
     * `bg-kidville-green`, cioè proprio l'aggancio su cui l'Alto Contrasto riempie di
     * GIALLO con l'inchiostro nero — il segnale che nella card vuol dire «questo si
     * preme». Con le due pastiglie, l'occhiello e i tre importi, il giallo lo
     * portavano dieci elementi di cui quattro premibili: un accento che accenta tutto
     * non accenta niente, ed è il difetto che questo repo ha corretto sul popup della
     * riconciliazione il giorno prima. Crema col filetto: in Alto Contrasto diventa un
     * disco grigio scurissimo contornato di bianco con la cifra bianca — la stessa
     * voce dei tab NON attivi, cioè struttura, non comando.
     */
    const passo = (numero: string, titolo: string) => (
        <p className="flex items-center gap-2 font-barlow text-[15px] font-bold leading-snug text-kidville-ink">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border border-kidville-line bg-kidville-cream font-barlow text-xs font-black text-kidville-ink">
                {numero}
            </span>
            {titolo}
        </p>
    );

    return (
        // NIENTE OMBRA (quinto giro, 2026-09-05). Misurato sui pixel della pagina
        // intera: tutte le card passano di netto dal crema del fondo (254,241,228) al
        // filetto (239,231,220) — «Totale famiglia» a y=735, le quattro card
        // dell'elenco a y=3567/3763/4039/4307 — mentre questa sfumava su SEI pixel.
        // Era l'unica card sollevata della pagina, e il commento che giustificava
        // l'ombra («la stessa delle altre card del genitore») era smentito dai pixel.
        // Se il filetto su bianco è davvero troppo debole (1,23:1) si cambia il TOKEN
        // per tutte le card, non si aggiunge qui un'elevazione che il resto non ha.
        <div className="kv-come-pagare rounded-card border border-kidville-line bg-kidville-white p-4">
            <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                {t('comePagareTitolo')}
            </p>
            {/* SOPRA I TAB NON C'È PIÙ NIENTE (2026-09-05, quarto giro). C'era
                «Scegli il metodo. Per il bonifico servono due cose: il conto e la
                causale.», e restava in testa anche col tab «Contanti» attivo: metà
                della frase descriveva un pannello in quel momento nascosto, mentre
                sotto si leggeva «In segreteria, negli orari di apertura».
                La prima metà — «scegli il metodo» — la dicono già i due tab, che sono
                lì sotto e si chiamano «Bonifico» e «Contanti»: era una didascalia di
                sé stessi. La seconda metà è diventata la prima riga DENTRO il pannello
                del bonifico, dove serve e dove si nasconde insieme a lui. */}

            <div
                role="tablist"
                aria-label={t('ariaMetodoPagamento')}
                className="mt-3 flex gap-1 rounded-pill bg-kidville-cream p-1"
            >
                {tab('bonifico', t('metodoBonifico'), Landmark)}
                {tab('contanti', t('metodoContanti'), Banknote)}
            </div>

            {/* I due pannelli restano nel DOM (`hidden` su quello inattivo): così
                `aria-controls` punta sempre a un elemento che esiste davvero. */}
            <div
                role="tabpanel"
                id={idPannello('bonifico')}
                aria-labelledby={idTab('bonifico')}
                hidden={metodo !== 'bonifico'}
                className="mt-4"
            >
                {/* Quello che serve PER IL BONIFICO si dice dentro il pannello del
                    bonifico, e con lui si nasconde: è la stessa frase di prima, senza
                    la mezza riga che descriveva la scelta già fatta dai tab.
                    14px e non 12: è il corpo del testo di una card che un genitore
                    legge sul telefono prima di spostare dei soldi. */}
                <p className="font-maven text-sm leading-relaxed text-pretty text-kidville-sub">
                    {t('comePagareIntro')}
                </p>
                <div className="mt-3 space-y-6">
                {blocchi.map((b) => {
                    const copiatoQui = copiato === b.chiave;
                    // Legato a una costante e non letto da `b` dentro il ramo: così
                    // TypeScript lo restringe da solo e non serve nessun cast.
                    const iban = b.iban;
                    return (
                        <div key={b.chiave}>
                            {passo('1', t('passoConto'))}

                            {/* IL RIQUADRO DEL CONTO È LA STESSA SCATOLA DELLA CAUSALE
                                (quinto giro, 2026-09-05): chip crema, `rounded-input`,
                                `p-3`, bordo trasparente. I due passi sono fratelli e
                                devono avere la stessa quota — prima erano un riquadro
                                bianco bordato E SOLLEVATO accanto a tre chip crema
                                piatte, cioè due elevazioni diverse nella stessa colonna.

                                Il bordo trasparente non è un vezzo: senza, la scatola
                                col bordo e quella senza hanno margini interni diversi di
                                un pixel, e la colonna dei quattro comandi si sfalsava
                                (misurato: «COPIA L'IBAN» x[60..655], i tre «COPIA»
                                x[58..657]).

                                E il fondo crema fa un lavoro che il bianco su bianco non
                                faceva: separa il riquadro dalla card SENZA dipendere da
                                un filetto #EFE7DC che su bianco vale 1,23:1 — cioè che su
                                un telefono in pieno sole non si vede. */}
                            <div className="mt-2 rounded-input border border-transparent bg-kidville-cream p-3">
                                {mostraNomi && b.nomi.length > 0 && (
                                    // INCHIOSTRO PIENO, non `sub`, e 12px invece di 11: questa riga
                                    // compare SOLO quando in pagina c'è più di un plesso, e allora è
                                    // la riga che dice su quale conto va il bonifico. Era il testo
                                    // più piccolo e più chiaro della card: gerarchia rovesciata,
                                    // l'informazione che discrimina era quella che si vedeva meno.
                                    <p className="mb-3 flex items-start gap-2 font-maven text-xs leading-relaxed text-pretty text-kidville-ink">
                                        <span className={SCATOLA_ICONA} aria-hidden="true">
                                            <Building2 size={16} />
                                        </span>
                                        {/* `count` non è decorativo: un blocco può fondere due plessi e
                                            quello accanto averne uno solo, nella stessa pagina. */}
                                        <span className="min-w-0 break-words">
                                            {t('sediDelBlocco', { count: b.nomi.length, sedi: b.nomi.join(' · ') })}
                                        </span>
                                    </p>
                                )}

                                <div className="space-y-3">
                                    <div>
                                        <p className={ETICHETTA}>{t('intestatoA')}</p>
                                        {b.intestatario ? (
                                            // 15px FISSI, senza il `sm:text-base` di prima: su desktop
                                            // l'intestatario cresceva a 16 e l'IBAN restava a 14, cioè
                                            // il nome del beneficiario finiva due punti sopra le
                                            // coordinate su cui i soldi si muovono davvero. Il campo
                                            // dell'IBAN non può crescere — a 16px mono la stringa non
                                            // entra più su una riga sola — quindi a scendere è l'altro.
                                            <p className="mt-1 break-words font-maven text-[15px] font-bold leading-snug text-kidville-ink">
                                                {b.intestatario}
                                            </p>
                                        ) : (
                                            // Un'assenza non si scrive col peso di un valore.
                                            <p className="mt-1 break-words font-maven text-sm leading-snug text-pretty text-kidville-sub">
                                                {t('intestatarioNonDisponibile')}
                                            </p>
                                        )}
                                    </div>

                                    {iban ? (
                                        <div>
                                            <p className={ETICHETTA}>{t('ibanEtichetta')}</p>
                                            {/* L'IBAN HA LA FORMA DEL CAMPO DA CUI SI COPIA, e non è
                                                un vezzo: nella card ci sono due sole cose da copiare
                                                e finché una sola aveva l'aspetto di un campo — la
                                                causale, quella secondaria — chi guardava per tre
                                                secondi non riconosceva l'IBAN come «il rettangolo da
                                                prendere»: lo distingueva solo il peso del carattere.
                                                BIANCO dentro la chip crema, esattamente come la
                                                causale: ora che i due passi hanno la stessa scatola,
                                                anche i due campi da copiare hanno la stessa pelle —
                                                prima erano uno crema-su-bianco e l'altro
                                                bianco-su-crema, cioè la stessa idea detta in due modi.

                                                Resta a 14px e NIENTE `break-all`: l'IBAN arriva dal
                                                server già a gruppi di quattro separati da spazi, e
                                                con il ritorno a capo normale può spezzarsi SOLO lì.
                                                Un IBAN tagliato a metà di un gruppo si ricopia
                                                sbagliato a mano. */}
                                            <p className={`mt-1 bg-kidville-white font-mono text-sm font-bold ${CAMPO_COPIABILE}`}>
                                                {iban}
                                            </p>
                                        </div>
                                    ) : (
                                        // 14px: nella variante senza coordinate questa È la card.
                                        <p className="flex items-start gap-2 font-maven text-sm leading-relaxed text-pretty text-kidville-sub">
                                            <span className={SCATOLA_ICONA} aria-hidden="true">
                                                <Info size={16} />
                                            </span>
                                            <span>{t('ibanNonDisponibile')}</span>
                                        </p>
                                    )}
                                </div>

                                {iban && (
                                    // `sm:justify-end`: da qui in su TUTTI i comandi della card —
                                    // questo e i tre «Copia» delle causali — condividono un margine
                                    // solo. Prima erano quattro bottoni con due allineamenti: questo
                                    // a bandiera sinistra, gli altri a bandiera destra.
                                    // `mt-3` come nella chip della causale: stessa aria fra il campo
                                    // e il comando che lo copia, nei due passi.
                                    <div className="mt-3 flex sm:justify-end">
                                        {/* Il testo visibile È il nome accessibile: nessun `aria-label`
                                            che dica una cosa diversa da quella scritta (WCAG 2.5.3).
                                            `w-full sm:w-auto` (dalla forma condivisa): sul telefono
                                            prende la riga intera — così premerlo non toglie spazio
                                            all'IBAN — ma su desktop un bottone largo quanto la card
                                            sarebbe una fascia, non un comando. */}
                                        <button
                                            type="button"
                                            className={BTN_COPIA_AA}
                                            onClick={() => copiaIban(b.chiave, iban)}
                                        >
                                            {copiatoQui
                                                ? <><Check size={15} aria-hidden="true" /> {t('copiato')}</>
                                                : <><Copy size={15} aria-hidden="true" /> {t('copiaIban')}</>}
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="mt-4">{passo('2', t('passoCausale'))}</div>
                            <div className="mt-2">
                                <CausaleBonifico voci={b.voci} incorporata />
                            </div>
                        </div>
                    );
                })}
                </div>
            </div>

            <div
                role="tabpanel"
                id={idPannello('contanti')}
                aria-labelledby={idTab('contanti')}
                hidden={metodo !== 'contanti'}
                className="mt-4 space-y-3"
            >
                {/* LE ICONE NON SONO VERDI (quinto giro, 2026-09-05). Lo erano qui e nere
                    nel pannello del bonifico, per la stessa identica riga: due pannelli
                    della stessa card che dicevano lo stesso fatto con due colori. E in
                    Alto Contrasto `.text-kidville-green` diventa #FFE500: due icone
                    decorative accendevano il segnale che nella card vuol dire «premimi».
                    Ereditano l'inchiostro della riga, come tutte le altre. */}
                <p className="flex items-start gap-2 font-maven text-sm leading-relaxed text-pretty text-kidville-ink">
                    <span className={SCATOLA_ICONA} aria-hidden="true">
                        <MapPin size={16} />
                    </span>
                    <span>{t('contantiTesto')}</span>
                </p>
                {/* QUALE segreteria: «in segreteria» da solo, per una famiglia con figli
                    in due plessi, non è un'indicazione. Compare con la stessa condizione
                    della riga dei plessi nel pannello del bonifico — e con la stessa
                    scatola d'icona, così le due righe condividono UNA colonna di testo.
                    STESSA FRASE dell'altro pannello, e non una seconda formulazione: è
                    lo stesso fatto («questi sono i plessi di cui stiamo parlando») e
                    scriverlo in due modi diversi nella stessa card è il difetto da cui
                    nascono le divergenze, non un arricchimento. */}
                {mostraNomi && (
                    <p className="flex items-start gap-2 font-maven text-sm leading-relaxed text-pretty text-kidville-ink">
                        <span className={SCATOLA_ICONA} aria-hidden="true">
                            <Building2 size={16} />
                        </span>
                        <span className="min-w-0 break-words">
                            {t('sediDelBlocco', { count: nomiSedi.length, sedi: nomiSedi.join(' · ') })}
                        </span>
                    </p>
                )}
                <p className="flex items-start gap-2 rounded-input bg-kidville-cream px-3 py-3 font-maven text-sm leading-relaxed text-pretty text-kidville-sub">
                    <span className={SCATOLA_ICONA} aria-hidden="true">
                        <Info size={16} />
                    </span>
                    <span>{t('contantiNota730')}</span>
                </p>
            </div>

            {/* L'esito della copia detto A VOCE, non solo con l'etichetta del bottone che
                cambia. La regione è montata SEMPRE, anche vuota: un `aria-live` che
                compare insieme al proprio testo, nei lettori di schermo, spesso non
                annuncia niente — ed è l'errore che rende inutili metà delle conferme
                «copiato» in giro per il web. */}
            <p role="status" aria-live="polite" className="sr-only">
                {copiato ? t('copiato') : ''}
            </p>
        </div>
    );
}
