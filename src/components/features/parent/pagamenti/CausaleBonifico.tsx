'use client';

import { Fragment, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { formatEuro } from '@/lib/format/valuta';

// La FORMA comune dei due bottoni di copia della card (questo e «Copia l'IBAN» di
// `ComePagare`, che vive dentro la stessa card): una sola costante, perché due copie
// sarebbero due comandi che divergono al primo ritocco.
//
// Tre scelte che NON sono decorative (2026-09-05, dopo le misure sulle schermate):
//  · `min-h-[44px]` — era `h-9`, cioè 36px: sotto il bersaglio minimo del dito.
//  · `min-w-[6.5rem]` — «Copia» è largo 82px, «Copiato» 96px. Senza un minimo
//    comune il bottone si allargava PREMENDOLO, e nel riquadro dell'IBAN questo
//    faceva andare a capo l'IBAN in un punto diverso: il testo si muoveva sotto
//    il dito che l'aveva appena toccato.
//  · `w-full sm:w-auto` — sul telefono prende la riga intera invece di galleggiare
//    su una riga occupata per un terzo (103px di pillola e un centinaio di crema
//    vuota alla sua sinistra, tre volte per schermata). Il contenitore porta
//    `sm:justify-end`: da lì in su TUTTI i comandi della card — questo e quello
//    dell'IBAN — condividono un margine solo.
//  · `motion-safe:` su transizione E pressione — con `prefers-reduced-motion` il
//    `@media` di `globals.css` azzera già le transizioni, ma NON un `active:scale`,
//    che è un cambio di stato istantaneo e resterebbe l'unico movimento in pagina.
const BTN_COPIA_FORMA =
    'inline-flex min-h-[44px] w-full min-w-[6.5rem] items-center justify-center gap-2 whitespace-nowrap rounded-pill px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.05em] motion-safe:transition-[transform,background-color] motion-safe:active:scale-95 disabled:opacity-45 disabled:pointer-events-none sm:w-auto';

// CTA PRIMARIA AA della feature: BIANCO su verde (≈6,5:1) invece del giallo-su-verde
// del `Btn` primary dell'app (~4:1, sotto AA). Locale alla feature per non toccare il
// `Btn` globale — ESPORTATA perché la usa «Copia l'IBAN» in `ComePagare`.
//
// NE RESTA UNA SOLA IN TUTTA LA CARD (2026-09-05, terzo giro). Prima erano quattro
// macchie verdi piene — il tab attivo, «Copia l'IBAN» a tutta larghezza e tre pillole
// «Copia» — identiche per saturazione: nessun punto focale, e il bottone che conta
// davvero si distingueva solo per la larghezza.
export const BTN_COPIA_AA = `${BTN_COPIA_FORMA} bg-kidville-green text-kidville-white hover:bg-kidville-green-dark`;

// …e questa è la variante SECONDARIA, per i «Copia» della causale: stesso bersaglio
// da 44px, stessa forma, ma contorno invece di pieno. Verde su crema è 5,86:1, sopra
// AA. Il bordo è `border-current` e non `border-kidville-green`: in Alto Contrasto la
// regola `.kv-come-pagare .text-kidville-green` porta l'inchiostro a #FFE500 e il
// contorno ci va dietro DA SOLO — un verde #006A5F disegnato sul nero starebbe a
// 3,23:1, appena sopra la soglia dei bordi e sotto ogni altra cosa della card.
export const BTN_COPIA_SECONDARIO = `${BTN_COPIA_FORMA} border-2 border-current bg-transparent text-kidville-green hover:bg-kidville-green/10`;

// …e la stessa pillola COL FUOCO DA TASTIERA (2026-09-05, quarto giro).
//
// L'anello globale è `outline: 2px solid #006A5F` (`globals.css`), e il bordo del
// secondario è già 2px dello STESSO verde, separato dall'anello da 2px di crema: il
// cambio di stato si leggeva come «bordo un po' più spesso», non come «sono qui».
// Al fuoco il bottone si RIEMPIE, così l'anello contorna un pieno e non un contorno,
// e il `border-current` — che ora segue l'inchiostro bianco — diventa il filetto
// chiaro fra il verde e l'anello: la stessa separazione netta che il pieno
// dell'IBAN ha sempre avuto.
//
// Le classi sono STATICHE e non varianti `focus-visible:…`, e non è un dettaglio:
// `.bg-kidville-green` è l'aggancio su cui `globals.css` ribalta il pieno in GIALLO
// con inchiostro nero dentro `.kv-come-pagare`. Una variante Tailwind genererebbe
// un nome di classe diverso (`focus-visible\:bg-kidville-green`), che quella regola
// non vedrebbe: in Alto Contrasto resterebbe una pillola verde #006A5F sul nero,
// 3,2:1, l'unica superficie della card a non essersi ribaltata.
export const BTN_COPIA_SECONDARIO_FUOCO = `${BTN_COPIA_FORMA} border-2 border-current bg-kidville-green text-kidville-white`;

/**
 * Un pezzo di causale, e se può spezzarsi a fine riga.
 * `unito: true` ⇒ va reso dentro uno `<span class="whitespace-nowrap">`.
 */
export interface SegmentoCausale {
    testo: string;
    unito: boolean;
}

/**
 * La causale, DIVISA nei pezzi che a fine riga non devono spezzarsi.
 *
 * Il testo arriva composto dal server ed è quello che deve finire negli appunti,
 * identico. Ma a schermo quella stessa stringa ha due punti di rottura che rovinano
 * l'unica cosa che il genitore rilegge carattere per carattere prima di digitarla:
 *
 *  1. il separatore « - » può scendere a capo DA SOLO, e l'ultima riga diventa
 *     «- GIUGLIANO»: una riga che comincia con un trattino si legge come un elenco
 *     puntato, ed è anche corta un terzo della colonna.
 *  2. il trattino DENTRO una parola — i cognomi composti — è un punto d'a-capo
 *     regolare: «Arcobaleno-» a fine riga e «Prova» sotto taglia in due il nome
 *     proprio di un bambino.
 *
 * ─── PERCHÉ IL MARKUP E NON I CARATTERI (quinto giro, 2026-09-05) ─────────────
 * La prima versione risolveva entrambi SOSTITUENDO i caratteri: uno spazio
 * unificatore al posto di quello del separatore, un trattino non separabile al posto
 * di quello interno alle parole. A schermo funzionava, e il bottone «Copia» mandava
 * comunque la stringa grezza — ma il `<p>` resta selezionabile, e chi seleziona la
 * causale col dito invece di premere il bottone (cioè metà delle persone) incollava
 * nell'home banking esattamente i due caratteri che il commento di questo file
 * dichiarava pericolosi.
 *
 * Qui i caratteri non si toccano: si RAGGRUPPANO. Ogni gruppo non spezzabile è UNA
 * parola più il trattino che le sta incollato, mai una corsa di parole — legarne
 * mezza causale la farebbe uscire dal campo su un telefono da 390px. Le parole senza
 * vincoli restano in segmenti liberi, così il DOM non si frantuma in un nodo per
 * parola. Vale l'invariante che i test misurano:
 *
 *     segmentiCausale(c).map((s) => s.testo).join(' ') === c
 *
 * Effetto tipografico identico, appunti identici anche via selezione manuale.
 */
export function segmentiCausale(causale: string): SegmentoCausale[] {
    const segmenti: SegmentoCausale[] = [];
    for (const pezzo of causale.split(' ')) {
        const ultimo = segmenti[segmenti.length - 1];
        // Il separatore isolato si incolla alla parola che lo precede — e SOLO a
        // quella: se il segmento prima è una corsa libera di parole, l'ultima si
        // stacca e diventa il gruppo non spezzabile.
        if (pezzo === '-' && ultimo) {
            const spazio = ultimo.unito ? -1 : ultimo.testo.lastIndexOf(' ');
            if (spazio === -1) {
                ultimo.testo = `${ultimo.testo} -`;
                ultimo.unito = true;
            } else {
                const coda = ultimo.testo.slice(spazio + 1);
                ultimo.testo = ultimo.testo.slice(0, spazio);
                segmenti.push({ testo: `${coda} -`, unito: true });
            }
            continue;
        }
        // Trattino DENTRO la parola (cognome composto), oppure un separatore che apre
        // la causale — caso limite, senza nessuna parola a cui aggrapparsi.
        if (/\S-\S/.test(pezzo) || pezzo === '-') {
            segmenti.push({ testo: pezzo, unito: true });
            continue;
        }
        if (ultimo && !ultimo.unito) {
            ultimo.testo = `${ultimo.testo} ${pezzo}`;
            continue;
        }
        segmenti.push({ testo: pezzo, unito: false });
    }
    return segmenti;
}

/**
 * La causale renderizzata: testo identico a quello del server, con i soli gruppi non
 * spezzabili avvolti in uno `<span>`. Gli spazi FRA i gruppi restano nodi di testo a
 * sé — se stessero dentro lo `span` sarebbero non spezzabili anche loro, e il campo
 * non andrebbe più a capo da nessuna parte.
 */
export function CausaleLeggibile({ causale }: { causale: string }) {
    return (
        <>
            {segmentiCausale(causale).map((s, i) => (
                <Fragment key={`${i}-${s.testo}`}>
                    {i > 0 ? ' ' : null}
                    {s.unito ? <span className="whitespace-nowrap">{s.testo}</span> : s.testo}
                </Fragment>
            ))}
        </>
    );
}

/**
 * L'etichetta di un campo copiabile: quieta, sempre SOPRA il suo valore, la stessa per
 * «Intestato a», «IBAN» e «Causale». Vive qui, accanto a `CAMPO_COPIABILE`, perché le
 * due costanti descrivono la stessa cosa — un campo etichettato da cui si copia — e
 * `ComePagare` le importa tutte e due.
 *
 * 12px e non 11: era il testo più piccolo della card, su un telefono da 390px, sopra
 * le sole cose che il genitore deve trascrivere a mano.
 */
export const ETICHETTA = 'font-maven text-xs uppercase tracking-[0.08em] text-kidville-sub';

/**
 * Il campo da cui si copia — la forma condivisa dai DUE testi copiabili della card:
 * la causale (bianca dentro la chip crema) e l'IBAN (crema dentro il riquadro bianco
 * del conto). Il fondo lo mette chi la usa, perché dipende da dove il campo sta.
 *
 * `kv-campo-copiabile` è l'ancora dell'Alto Contrasto: `globals.css` la ribalta in
 * nero con un filetto #8A8A8A (6,4:1) per entrambi, perché in Alto Contrasto due neri
 * vicini non si separano più col colore — si separano col contorno.
 *
 * `rounded-[8px]` e non `rounded-input` (12px): il campo è ANNIDATO dentro un
 * contenitore già arrotondato a 12px, e un raggio interno uguale all'esterno si legge
 * come un adesivo appoggiato invece che come un campo incassato.
 *
 * `px-2 sm:px-3`: a 390px la stringa dell'IBAN misura 276,5px e nel riquadro ne
 * restano 284 con `px-2` — entra su una riga sola, che è l'unica cosa che conta per
 * un numero che si rilegge carattere per carattere. Da `sm` in su lo spazio c'è e il
 * campo respira.
 *
 * `max-sm:[text-wrap:balance] sm:text-pretty` — il bilanciamento SOLO sul telefono.
 * Su 390px il campo è alto tre o quattro righe e `balance` le distribuisce tutte,
 * il che tiene la colonna piena fino in fondo; su desktop la stessa regola lasciava
 * il campo visibilmente vuoto per un terzo della larghezza, e la scatola sembrava
 * sovradimensionata rispetto al proprio contenuto. Da `sm` in su la riga riempie e
 * `pretty` bada solo all'ultima — l'orfana che cominciava con un trattino non può
 * più capitare, perché il trattino sta in un gruppo non spezzabile (`segmentiCausale`).
 * (Sul campo dell'IBAN, che sta su una riga sola, non cambia niente.)
 */
export const CAMPO_COPIABILE =
    'kv-campo-copiabile break-words rounded-[8px] px-2 py-2 leading-relaxed max-sm:[text-wrap:balance] sm:text-pretty text-kidville-ink sm:px-3';

export interface VoceCausale {
    id: string;
    /** Sede a cui la voce appartiene: decide SU QUALE CONTO va pagata (`ComePagare`). */
    scuola_id: string;
    /** Causale già COMPOSTA dal server col modello per-categoria (admin_settings.causali_config). */
    causale: string;
    /**
     * Come il genitore chiama questa voce («Retta Settembre 2026»). È il TITOLO della
     * riga: la causale è lunga, quasi identica fra una voce e l'altra, e serve a
     * essere copiata — non a essere letta per capire di che si tratta.
     */
    descrizione: string;
    /**
     * Quanto RESTA da versare per questa voce (residuo, non importo pieno): è la cifra
     * che il genitore digita nel bonifico. Per una voce parziale i due numeri
     * divergono, ed è esattamente il caso in cui sbagliare costa una telefonata.
     */
    importo: number;
    nome: string;
    cognome: string;
    /** Il CF del proprio figlio è presente: quando manca, mostra la nota di ripiego. */
    hasCf: boolean;
}

// Card «Causale consigliata per il bonifico»: UNA causale per voce ancora aperta,
// COMPOSTA DAL SERVER col modello per-categoria (personalizzabile dalla segreteria),
// pronta da copiare. Scrivere questa causale rende univoco l'abbinamento del bonifico
// (riconciliazione). Se il CF del bambino manca, il server lo omette dalla causale e
// una nota invita a indicare comunque il nome. Il CF è del PROPRIO figlio: dato del
// genitore, lecito da mostrargli.
//
// GERARCHIA DELLA RIGA (rifatta il 2026-09-05). Prima la causale era il testo più
// forte della card — verde, grassetto, 14px, quattro righe — e vinceva sull'IBAN, che
// è il dato per cui la card esiste. Ma la causale non si legge: si copia. Quindi la
// riga oggi si presenta con ciò che la fa riconoscere in un colpo d'occhio (la voce e
// quanto resta) e tiene la causale sotto, in un campo chiaro che dice «questo testo va
// incollato lì»: quieto, integrale, senza tagli.
//
// `incorporata`: la stessa lista dentro un'altra card (il pannello «Bonifico» di
// `ComePagare`). Toglie SOLO il guscio — bordo, fondo, padding — e l'occhiello:
// due card annidate darebbero due bordi e due titoli per una cosa sola.
export function CausaleBonifico({ voci, incorporata = false }: { voci: VoceCausale[]; incorporata?: boolean }) {
    const t = useTranslations('pagamenti');
    const [copiato, setCopiato] = useState<string | null>(null);
    // Il fuoco DA TASTIERA, tenuto a mano invece che con `focus-visible:` di
    // Tailwind: al fuoco il bottone deve prendere le classi STATICHE su cui l'Alto
    // Contrasto lo ribalta (vedi `BTN_COPIA_SECONDARIO_FUOCO`), e una variante
    // genererebbe un nome di classe che quelle regole non vedono.
    //
    // La distinzione tastiera/puntatore è quella del polyfill classico di
    // `:focus-visible` — un `pointerdown` appena prima del `focus` significa che il
    // fuoco arriva dal dito o dal mouse — e non `matches(':focus-visible')`, che è
    // un selettore: chiederlo a un motore che non lo conosce lancia, e un `try`
    // attorno a un cambio di stato è un `catch` che non saprebbe cosa dire.
    const [fuocoTastiera, setFuocoTastiera] = useState<string | null>(null);
    const daPuntatore = useRef(false);
    if (voci.length === 0) return null;

    const nomeDi = (v: VoceCausale) => [v.nome, v.cognome].filter(Boolean).join(' ') || t('questoPagamento');
    const vocecopiata = voci.find((v) => v.id === copiato);

    const copia = async (id: string, testo: string) => {
        try {
            await navigator.clipboard.writeText(testo);
            setCopiato(id);
            setTimeout(() => setCopiato(null), 2000);
        } catch (err) {
            // `navigator.clipboard` dice di no per motivi DIVERSI e distinguibili, e
            // ognuno vuole una correzione diversa: permesso negato, contesto non
            // sicuro, o l'API che dentro una WebView non esiste affatto. Il `catch`
            // senza binding buttava via proprio la parola che li separa. Nessun dato
            // personale nel messaggio: `nomeErrore` restituisce SOLO il nome della
            // classe d'errore, mai il testo — e la causale, che porta il nome di un
            // minore, non ci entra.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: `copia-causale-non-riuscita: ${nomeErrore(err)}`,
                route: '/parent/pagamenti',
            });
        }
    };

    return (
        <div className={incorporata ? '' : 'rounded-card border border-kidville-line bg-kidville-white p-4'}>
            {!incorporata && (
                <p className="mb-1 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                    {t('causaleTitolo')}
                </p>
            )}
            {/* `text-pretty` (text-wrap: pretty) e non un a-capo a mano: impedisce la
                riga orfana — «giusta.» da sola in fondo — senza congelare dove cade
                l'a-capo, che dipende dalla larghezza dello schermo e dalla lingua.
                14px e non 12: è testo che si legge, su un telefono, prima di spostare
                dei soldi. */}
            <p className="font-maven text-sm leading-relaxed text-pretty text-kidville-sub">
                {t('causaleIntro')}
            </p>
            {/* 12px fra una voce e l'altra e non 8: con card alte 118 le tre superfici
                crema si saldavano in un blocco unico a righe, e si perdeva il conteggio
                delle voci a colpo d'occhio. */}
            <ul className="mt-3 space-y-3">
                {voci.map((v) => {
                    const causale = v.causale;
                    const done = copiato === v.id;
                    const nome = nomeDi(v);
                    return (
                        // `border border-transparent`: il riquadro del conto, che sta
                        // nella stessa colonna, porta un bordo da 1px e questi blocchi
                        // no — stessa scatola esterna, margini interni diversi di un
                        // pixel, e su desktop i comandi finivano su due verticali
                        // distanti 1px (misurato: 367,5 contro 368,5). Un bordo
                        // trasparente non si vede e pareggia la scatola.
                        <li key={v.id} className="rounded-input border border-transparent bg-kidville-cream p-3">
                            <div className="flex items-baseline justify-between gap-3">
                                {/* Tondo, non maiuscolo: è CONTENUTO, non un'etichetta. Nella
                                    card il maiuscolo è già il linguaggio dell'occhiello, dei
                                    tab e dei bottoni — un quarto livello lo avrebbe reso
                                    rumore, e «Retta Settembre 2026» qui si legge come si
                                    legge nell'elenco dei pagamenti più sotto. */}
                                <p className="min-w-0 break-words font-barlow text-sm font-bold leading-snug text-kidville-ink">
                                    {v.descrizione}
                                </p>
                                {/* L'importo in colonna a destra, come nella card «Totale
                                    famiglia» 200px più su: tre importi che condividono un
                                    bordo, non tre appesi alla fine di titoli di lunghezza
                                    diversa.

                                    INCHIOSTRO E NON VERDE (quinto giro, 2026-09-05). In Alto
                                    Contrasto `.text-kidville-green` diventa #FFE500, e col
                                    verde qui il giallo lo portavano anche tre numeri che
                                    nessuno preme: il segnale «questo si tocca» si diluiva su
                                    dieci elementi invece dei quattro comandi. La gerarchia la
                                    fa il PESO — `font-black`, il più grasso della riga — non il
                                    colore, e dentro il blocco resta un solo accento: il «Copia». */}
                                <p className="shrink-0 font-barlow text-[15px] font-black text-kidville-ink">
                                    {formatEuro(v.importo)}
                                </p>
                            </div>
                            {/* IL CAMPO DA COPIARE.

                                `break-words` e non `break-all`: la causale va a capo fra le
                                parole, mai dentro il codice fiscale. E il testo è quello del
                                server, carattere per carattere: a non spezzarsi sono i gruppi
                                del markup (`CausaleLeggibile`), non i caratteri.

                                ⚠️ MANCA ANCORA L'OCCHIELLO «CAUSALE» sopra il campo — quello
                                che spiegherebbe il salto di ruolo fra il titolo della voce e il
                                testo da incollare, e che toglierebbe l'eco («Retta Settembre
                                2026» come titolo e di nuovo come prima riga del campo). Serve
                                una chiave nuova nel catalogo, e non si può verificare a
                                schermo: il server di sviluppo di questa sessione tiene il
                                catalogo `pagamenti` congelato in cache (misurato — nemmeno il
                                cambio di valore di una chiave ESISTENTE arriva alla pagina), e
                                una chiave nuova uscirebbe a schermo come `pagamenti.<chiave>`.
                                Si aggiunge al primo riavvio del server. */}
                            {/* L'occhiello che «Intestato a» e «IBAN» hanno già: tre campi, una sola etichetta. */}
                            <p className={`mt-3 ${ETICHETTA}`}>{t('causaleEtichetta')}</p>
                            <p className={`mt-1 bg-kidville-white font-maven text-sm ${CAMPO_COPIABILE}`}>
                                <CausaleLeggibile causale={causale} />
                            </p>
                            {!v.hasCf && (
                                <p className="mt-2 flex items-start gap-2 font-maven text-xs leading-relaxed text-pretty text-kidville-sub">
                                    <span className="mt-[2px] flex w-4 shrink-0 justify-center" aria-hidden="true">
                                        <Info size={14} />
                                    </span>
                                    <span>{t('cfNonDisponibile')}</span>
                                </p>
                            )}
                            <div className="mt-3 flex sm:justify-end">
                                <button
                                    type="button"
                                    className={fuocoTastiera === v.id ? BTN_COPIA_SECONDARIO_FUOCO : BTN_COPIA_SECONDARIO}
                                    onClick={() => copia(v.id, causale)}
                                    onPointerDown={() => { daPuntatore.current = true; }}
                                    // Il flag si abbassa alla FINE dell'interazione, non solo
                                    // sul `focus`: cliccando un bottone che il fuoco ce l'ha
                                    // già, l'evento `focus` non riparte, il flag restava
                                    // alzato per sempre e il TAB successivo non riempiva più
                                    // niente. (`focus` arriva comunque prima di `pointerup`,
                                    // quindi l'azzeramento qui non toglie mai un fuoco vero.)
                                    onPointerUp={() => { daPuntatore.current = false; }}
                                    onPointerCancel={() => { daPuntatore.current = false; }}
                                    onFocus={() => {
                                        if (!daPuntatore.current) setFuocoTastiera(v.id);
                                        daPuntatore.current = false;
                                    }}
                                    onBlur={() => setFuocoTastiera((f) => (f === v.id ? null : f))}
                                    // Il nome accessibile segue il testo visibile: quando la
                                    // scritta diventa «Copiato», il nome deve contenerlo
                                    // (WCAG 2.5.3) e dire ancora DI QUALE voce si parla, perché
                                    // i bottoni della lista sono altrimenti identici.
                                    aria-label={done ? t('ariaCopiatoCausale', { nome }) : t('ariaCopiaCausale', { nome })}
                                >
                                    {done
                                        ? <><Check size={15} aria-hidden="true" /> {t('copiato')}</>
                                        : <><Copy size={15} aria-hidden="true" /> {t('copia')}</>}
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
            {/* L'esito della copia detto A VOCE, non solo con l'etichetta che cambia.
                La regione è montata SEMPRE, anche vuota: un `aria-live` che compare
                insieme al proprio testo, nei lettori di schermo, spesso non annuncia
                niente — è l'errore che rende inutili metà delle conferme «copiato». */}
            <p role="status" aria-live="polite" className="sr-only">
                {vocecopiata ? t('ariaCopiatoCausale', { nome: nomeDi(vocecopiata) }) : ''}
            </p>
        </div>
    );
}
