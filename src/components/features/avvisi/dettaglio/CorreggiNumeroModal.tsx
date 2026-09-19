'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Stepper } from '@/components/ui/Stepper';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { NUMERO_PARTECIPANTI_MIN, NUMERO_PARTECIPANTI_MAX_ASSOLUTO } from '@/lib/validation/avvisi';

/**
 * ─── I TRE GESTI DELLA SEGRETERIA SU UN'ADESIONE ────────────────────────────
 *
 * Una sola porta (`PATCH /api/avvisi/[id]/risposte/[rispostaId]`) e tre gesti che
 * condividono l'invariante — tutti e tre cambiano quante persone risultano dentro:
 *  · `{numero_partecipanti: N}`  corregge il numero;
 *  · `{stato: 'ammessa'}`        ammette dalla lista d'attesa;
 *  · `{stato: 'nessuna'}`        toglie l'adesione e libera il posto.
 *
 * Stanno in UN componente per la stessa ragione per cui stanno in una sola
 * funzione di database: separarli significherebbe due schermate che si misurano a
 * vicenda senza vedersi.
 *
 * ── 🔴 `RISPOSTA_CONTRARIA` NON È UN ERRORE: È UNA DOMANDA ──────────────────
 *
 * Quando si ammette una famiglia che aveva risposto **no**, il server risponde 409
 * con quel codice e NON scrive niente: il «no» di una famiglia, e l'istante in cui
 * l'ha espresso, sono un fatto suo, e sovrascriverlo lo farebbe sparire dal
 * database. La funzione si ferma apposta perché qualcuno possa CHIEDERE.
 *
 * Perciò qui quel 409 non finisce nel banner rosso: apre un riquadro di domanda,
 * col testo di catalogo — che è già scritto come una domanda, non come un
 * fallimento — e due vie d'uscita. Solo la conferma rimanda la stessa richiesta
 * con `ignora_rifiuto: true`. Mostrarlo come errore renderebbe la funzione
 * inutilizzabile: la segretaria leggerebbe «operazione fallita» e riproverebbe
 * all'infinito una cosa che non può riuscire finché non risponde alla domanda.
 *
 * ── ⚠️ `occupati` PUÒ TORNARE `null`, E `null` NON È ZERO ───────────────────
 *
 * Il server restituisce `occupati`/`posti_totali` solo quando li ha MISURATI
 * (c'è un tetto e il conteggio è avvenuto sotto il lock). Su un avviso senza tetto,
 * su una rimessa in coda o su una rimozione tornano `null` = «non misurato».
 * Scriverli come `0` direbbe «non c'è più nessuno dentro» proprio dove il sistema
 * sta dicendo «non l'ho contato»: qui si mostra la coppia SOLO se entrambi sono
 * numeri finiti, e altrimenti non si mostra niente.
 *
 * ── PERCHÉ «TOGLI» VIVE QUI DENTRO E NON SULLA RIGA ─────────────────────────
 *
 * Perché un terzo comando per riga, ripetuto trenta volte in un drawer da 448 px,
 * è la stessa trappola dell'«Modifica» nudo: trenta bottoni indistinguibili, e il
 * catalogo non ha (oggi) una chiave che permetta di dargli il nome dell'alunno nel
 * proprio `aria-label`. Da qui invece il gesto è già dentro il contesto di una
 * persona sola — il nome è nel titolo del dialogo — e la conferma è obbligata.
 */

/** Il gesto con cui il dialogo si apre. La rimozione si raggiunge da «numero». */
export type GestoAdesione = 'numero' | 'ammetti';

/** Ciò che serve di una riga per agirci sopra, e nient'altro. */
export interface RigaDaGestire {
    rispostaId: string;
    alunno: string;
    /** `'ammessa' | 'in_attesa' | null` — `in_attesa` è la **lista d'attesa**. */
    statoAdesione: string | null;
    numeroPartecipanti: number | null;
}

interface Props {
    open: boolean;
    avvisoId: string;
    riga: RigaDaGestire | null;
    gesto: GestoAdesione;
    /** L'intervallo dichiarato dall'avviso: fuori di lì il server risponde 400. */
    numeroMin?: number | null;
    numeroMax?: number | null;
    userId?: string | null;
    onChiudi: () => void;
    /** Il gesto è andato a buon fine: chi chiama ricarica l'elenco. */
    onFatto: () => void;
}

/** Il corpo di una PATCH: i tre gesti, più le due spunte di forzatura. */
type CorpoPatch = {
    stato?: 'ammessa' | 'in_attesa' | 'nessuna';
    numero_partecipanti?: number;
    ignora_rifiuto?: boolean;
};

export function CorreggiNumeroModal({
    open,
    avvisoId,
    riga,
    gesto,
    numeroMin,
    numeroMax,
    userId,
    onChiudi,
    onFatto,
}: Props) {
    const t = useTranslations('avvisi');

    /**
     * Gli id del dialogo, uno per istanza.
     *
     * ⚠️ `useId` e non una stringa cablata: questo componente è montato dentro
     * `AvvisoDetailsContent`, che a sua volta può stare due volte nella stessa
     * pagina (cockpit + drawer) — è la ragione, già scritta in quel file per i due
     * filtri, per cui due id uguali romperebbero l'associazione di ENTRAMBI. Un
     * `htmlFor` cablato a quaranta righe da quella spiegazione era la stessa
     * trappola lasciata aperta.
     */
    const idBase = useId();
    const idNumero = `${idBase}-numero`;
    const idTitolo = `${idBase}-titolo`;

    const [numero, setNumero] = useState<number | null>(null);
    const [inCorso, setInCorso] = useState(false);
    const [errore, setErrore] = useState('');
    /** Il dettaglio dei posti, SOLO quando il server li ha misurati. */
    const [dettaglioPosti, setDettaglioPosti] = useState('');
    /** La domanda di `RISPOSTA_CONTRARIA`: testo + il corpo da rimandare. */
    const [domanda, setDomanda] = useState<{ testo: string; corpo: CorpoPatch } | null>(null);
    /** Il passo di conferma della rimozione. */
    const [confermaTogli, setConfermaTogli] = useState(false);
    /**
     * La VIA D'USCITA di `POSTI_ESAURITI`.
     *
     * Il rifiuto, da solo, è un muro: dice che i posti non bastano e lascia chi
     * legge senza un passo successivo. Il passo esiste — si alza il tetto
     * dell'avviso — ma non era scritto da nessuna parte, e «forza» qui non si
     * espone di proposito: il tetto lo si cambia dov'è dichiarato.
     */
    const [viaUscita, setViaUscita] = useState(false);

    // Reset al cambio di riga o di gesto (adjust-state-during-render: prior art in
    // `AvvisoDetailsContent` e in `AvvisoForm`). Senza, il numero della famiglia
    // precedente resterebbe nel contatore della successiva — cioè si correggerebbe
    // l'adesione sbagliata con il numero di un'altra.
    const chiave = `${riga?.rispostaId ?? ''}|${gesto}|${open ? '1' : '0'}`;
    const [chiavePrec, setChiavePrec] = useState(chiave);
    if (chiave !== chiavePrec) {
        setChiavePrec(chiave);
        setNumero(riga?.numeroPartecipanti ?? null);
        setInCorso(false);
        setErrore('');
        setDettaglioPosti('');
        setDomanda(null);
        setConfermaTogli(false);
        setViaUscita(false);
    }

    if (!open || !riga) return null;

    /**
     * Da DOVE si sta ammettendo, che è ciò che cambia le parole intorno al gesto.
     *
     * `ElencoAdesioni` mostra «Ammetti» su due righe diverse: chi è in coda, e chi
     * aveva risposto **no** (senza la seconda, `RISPOSTA_CONTRARIA` non sarebbe
     * innescabile da nessuna parte). Una riga «no» ha `stato_adesione` nullo e non
     * è in nessuna coda: chiamarla «lista d'attesa» — nel titolo, e soprattutto
     * nell'`aria-label`, che è l'unico nome che sente chi usa uno screen reader —
     * è semplicemente falso.
     */
    const daCoda = riga.statoAdesione === 'in_attesa';

    const min = numeroMin ?? NUMERO_PARTECIPANTI_MIN;
    const max = numeroMax ?? NUMERO_PARTECIPANTI_MAX_ASSOLUTO;

    /** La coppia «occupati · su N posti», solo se il server li ha misurati davvero. */
    const postiMisurati = (corpo: unknown): string => {
        const c = corpo as { occupati?: unknown; posti_totali?: unknown } | null;
        const occupati = c?.occupati;
        const totali = c?.posti_totali;
        if (typeof occupati !== 'number' || !Number.isFinite(occupati)) return '';
        if (typeof totali !== 'number' || !Number.isFinite(totali)) return '';
        return `${t('postiPersone', { count: occupati })} · ${t('postiSuTotale', { totale: totali })}`;
    };

    const invia = async (corpo: CorpoPatch) => {
        setInCorso(true);
        setErrore('');
        setDettaglioPosti('');
        setViaUscita(false);
        try {
            const res = await fetch(
                `/api/avvisi/${avvisoId}/risposte/${riga.rispostaId}${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(userId ? { 'x-user-id': userId } : {}),
                    },
                    body: JSON.stringify(corpo),
                },
            );

            if (!res.ok) {
                // ⚠️ IL CORPO SI LEGGE UNA VOLTA SOLA, E SERVE INTERO. `erroreDaRisposta`
                // darebbe testo/codice/stato ma CONSUMA la risposta e non restituisce i
                // campi propri del rifiuto — e `occupati`/`posti_totali` viaggiano
                // proprio lì. Si legge il JSON a mano (mai lanciando: un 500 senza corpo
                // è una risposta possibile) e il testo lo dà comunque il CATALOGO, non la
                // prosa del server: quella nasce italiana e non si traduce.
                let corpoRisposta: unknown = null;
                try {
                    corpoRisposta = await res.json();
                } catch {
                    // Corpo assente, troncato o non JSON (un 502 di un proxy). Non è un
                    // caso da tacere né da segnalare due volte: il `logClient` qui sotto
                    // porta già lo stato, che è l'unica cosa che resta da sapere.
                    corpoRisposta = null;
                }
                const codice = (corpoRisposta as { codice?: unknown } | null)?.codice;
                const testo = soloCatalogoDaCorpo(corpoRisposta, t('correggiErrore'));

                if (codice === 'RISPOSTA_CONTRARIA') {
                    // 🔴 Non è un errore: è una domanda. Niente banner rosso e niente log
                    // a livello `error` — il server ha risposto esattamente come doveva, e
                    // la decisione ora è di chi guarda lo schermo.
                    setDomanda({ testo, corpo: { ...corpo, ignora_rifiuto: true } });
                    return;
                }

                setDettaglioPosti(postiMisurati(corpoRisposta));
                // La via d'uscita solo dove esiste: su un rifiuto di capienza il
                // passo successivo è il tetto dell'avviso. Su un 500 non c'è niente
                // da suggerire, e un suggerimento inutile è rumore su un errore.
                setViaUscita(codice === 'POSTI_ESAURITI');
                setErrore(testo);
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'avviso-adesione-gestione-respinta',
                    route: '/admin/avvisi',
                    stato: res.status,
                });
                return;
            }

            setDomanda(null);
            onFatto();
            onChiudi();
        } catch (e) {
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `avviso-adesione-gestione-fallita: ${nomeErrore(e)}`,
                route: '/admin/avvisi',
            });
            setErrore(t('correggiErrore'));
        } finally {
            setInCorso(false);
        }
    };

    const titolo = confermaTogli
        ? t('ritiraAdesione')
        : gesto === 'ammetti'
            ? (daCoda ? t('ammettiConfermaTitolo') : t('ammettiRispostaNoTitolo'))
            : t('correggiModaleTitolo');

    const BTN_PRIMARIO =
        'inline-flex min-h-[44px] items-center justify-center rounded-xl bg-kidville-green px-4 font-maven text-sm font-bold text-white transition-colors disabled:bg-kidville-neutral';
    const BTN_SECONDARIO =
        'inline-flex min-h-[44px] items-center justify-center rounded-xl border border-kidville-line px-4 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green';

    return (
        // `labelledBy` e non il solo `title`: la primitiva userebbe `aria-label`, e
        // il corpo ripete lo STESSO testo nell'`h2` qui sotto — il dialogo veniva
        // annunciato due volte. Il titolo visibile è anche il nome accessibile.
        <Modal open={open} onClose={onChiudi} title={titolo} labelledBy={idTitolo} className="w-full max-w-md">
            <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
                <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
                    {titolo}
                </h2>
                {/* Il nome sta nel dialogo: da qui in poi ogni comando parla di UNA
                    persona sola, e non serve ripeterlo su ciascun bottone. */}
                <p className="font-maven mt-0.5 text-xs text-kidville-sub">{riga.alunno}</p>

                <div className="mt-4 space-y-4">
                    {domanda ? (
                        // ── LA DOMANDA ────────────────────────────────────────
                        // Nessun `role="alert"`: non è un errore, e annunciarlo come
                        // tale direbbe a chi usa uno screen reader che qualcosa è
                        // andato storto mentre il sistema sta chiedendo il permesso.
                        <div
                            aria-live="polite"
                            className="flex items-start gap-2 rounded-2xl border border-kidville-warn/40 bg-kidville-warn-soft px-3 py-2.5"
                        >
                            <HelpCircle
                                size={16}
                                className="mt-0.5 shrink-0 text-kidville-warn-strong"
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            <p className="font-maven text-xs leading-relaxed text-kidville-ink">{domanda.testo}</p>
                        </div>
                    ) : confermaTogli ? (
                        // ⚠️ NON `ritiraConferma`, che dice «la TUA adesione»: quella è
                        // la conferma del GENITORE sulla propria card. Qui a premere è
                        // la segreteria, e sta togliendo l'adesione di un altro — col
                        // nome di quell'alunno due righe più su.
                        <p className="font-maven text-sm leading-relaxed text-kidville-ink">{t('ritiraConfermaSegreteria')}</p>
                    ) : gesto === 'ammetti' ? (
                        // Dalla CODA la conferma promette il posto e la notifica, ed è
                        // vero: il primo clic ammette davvero.
                        //
                        // 🔴 Da una riga che aveva risposto NO, no: quel clic riceve un
                        // 409 e il server non scrive niente, apposta — il «no» di una
                        // famiglia non si sovrascrive senza che qualcuno lo decida. Una
                        // conferma che promettesse lì il posto prometterebbe una cosa
                        // che non può mantenere, e la domanda vera arriva dopo.
                        <p className="font-maven text-sm leading-relaxed text-kidville-ink">
                            {daCoda
                                ? t('ammettiConfermaCorpo', { count: riga.numeroPartecipanti ?? 1 })
                                : t('ammettiRispostaNoCorpo')}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            <label
                                htmlFor={idNumero}
                                className="block font-maven text-xs font-semibold text-kidville-sub"
                            >
                                {t('adesioneQuantePersone')}
                            </label>
                            <Stepper
                                id={idNumero}
                                value={numero}
                                onChange={setNumero}
                                min={min}
                                max={max}
                                disabled={inCorso}
                                etichettaDiminuisci={t('partecipantiDiminuisci')}
                                etichettaAumenta={t('partecipantiAumenta')}
                            />
                        </div>
                    )}

                    {errore && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong"
                        >
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                            <span>
                                {errore}
                                {dettaglioPosti && <span className="mt-0.5 block font-semibold">{dettaglioPosti}</span>}
                                {/* Il passo successivo, dove esiste: senza, ci si sbatte
                                    contro il rifiuto e basta. */}
                                {viaUscita && <span className="mt-1 block">{t('postiEsauritiViaUscita')}</span>}
                            </span>
                        </div>
                    )}

                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <button type="button" onClick={onChiudi} disabled={inCorso} className={BTN_SECONDARIO}>
                            {confermaTogli ? t('ritiraAnnulla') : t('correggiAnnulla')}
                        </button>

                        {domanda ? (
                            <button
                                type="button"
                                onClick={() => invia(domanda.corpo)}
                                disabled={inCorso}
                                className={BTN_PRIMARIO}
                            >
                                {gesto === 'ammetti' ? t('ammettiDallaAttesa') : t('correggiSalva')}
                            </button>
                        ) : confermaTogli ? (
                            <button
                                type="button"
                                onClick={() => invia({ stato: 'nessuna' })}
                                disabled={inCorso}
                                className={BTN_PRIMARIO}
                            >
                                {t('ritiraSi')}
                            </button>
                        ) : gesto === 'ammetti' ? (
                            <button
                                type="button"
                                onClick={() => invia({ stato: 'ammessa' })}
                                disabled={inCorso}
                                className={BTN_PRIMARIO}
                            >
                                {t('ammettiDallaAttesa')}
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => numero !== null && invia({ numero_partecipanti: numero })}
                                disabled={inCorso || numero === null}
                                className={BTN_PRIMARIO}
                            >
                                {t('correggiSalva')}
                            </button>
                        )}
                    </div>

                    {/* Il terzo gesto: toglie l'adesione e libera il posto. Sta qui,
                        sotto, e chiede conferma — non è un'operazione da premere per
                        sbaglio mentre si correggeva un numero. */}
                    {!domanda && !confermaTogli && gesto === 'numero' && riga.statoAdesione !== null && (
                        <button
                            type="button"
                            onClick={() => {
                                setErrore('');
                                setConfermaTogli(true);
                            }}
                            disabled={inCorso}
                            className="min-h-[44px] w-full rounded-xl border border-kidville-error/30 px-3 font-maven text-xs font-bold text-kidville-error-strong transition-colors hover:bg-kidville-error-soft"
                        >
                            {t('ritiraAdesione')}
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
