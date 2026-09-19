'use client';

import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { NumeriAdesioni } from './numeri-adesioni';

/**
 * ─── IL RIEPILOGO DEI POSTI, SOTTO I TRE CONTATORI SÌ/NO/SENZA RISPOSTA ──────
 *
 * Un riquadro a PIENA LARGHEZZA, e non una quarta colonna accanto agli altri
 * tre: a 360 px quattro riquadri di quella misura diventano quattro numeri
 * illeggibili incolonnati. Qui la frase si legge per esteso e va a capo da sola.
 *
 * ── I NUMERI ARRIVANO DA `numeriAdesioni`, CHE LI POSSIEDE TUTTI ────────────
 *
 * 🔴 Non da un totale calcolato altrove, e non da uno `stats` del server: un
 * totale che non venga dalle stesse righe è il modo in cui la capienza mente — la
 * schermata direbbe «22 su 50» mentre il database rifiuta la ventitreesima
 * adesione, e nessuno dei due numeri sarebbe sbagliato da solo. `numeriAdesioni`
 * (`./numeri-adesioni`) chiama `riepilogoPosti`, la stessa funzione che il server
 * usa per le sue statistiche, e tiene insieme anche i tre contatori accanto:
 * finché i numeri di una schermata vivono lontani l'uno dall'altro, prima o poi
 * contano su basi diverse — ed è successo.
 *
 * ── CHI LEGGE DEVE POTER RITROVARE QUESTO TOTALE, O SAPERE PERCHÉ NON PUÒ ───
 *
 * ⚠️ Il totale conta TUTTE le righe che il server ha restituito, cioè la base di
 * `avviso_posti_occupati`; l'elenco accanto mostra le sole righe che si accostano
 * a un alunno delle sezioni destinatarie. Quando un bambino esce da una sezione
 * dopo aver risposto le due cose divergono, e la somma fatta a mano sui chip non
 * torna più. **Quella differenza si DICHIARA** (`nonIncrociate`): un totale più
 * alto e inspiegato è peggio di un totale più basso, perché sembra un errore di
 * qualcun altro invece di una riga da andare a cercare.
 *
 * ── PERCHÉ ANCHE LE FAMIGLIE ────────────────────────────────────────────────
 *
 * Perché il totale in PERSONE è volutamente largo: due fratelli invitati allo
 * stesso avviso dichiarano lo stesso accompagnatore due volte, e il totale dice 4
 * dove le teste sono 3. È giusto così — un pullman pieno al 110% è un bambino a
 * terra — ma senza il numero delle famiglie accanto la segreteria non ha modo di
 * sapere QUANTO quel totale sia gonfio, e finirebbe per indovinarlo.
 *
 * ── SOPRA CAPIENZA NON È UN ERRORE, E LA CAUSA QUI NON SI SA ────────────────
 *
 * Il badge segnala uno stato legittimo: chi era già dentro resta dentro e chi
 * aderisce da quel momento va in coda. La riga accanto dice questo — e **solo**
 * questo. Fino al 2026-09-19 diceva invece «il tetto è stato abbassato sotto le
 * adesioni già registrate», che è UNA delle strade per arrivarci e non l'unica:
 * si finisce sopra capienza anche con un tetto mai toccato, per esempio quando
 * una riga fuori sezione porta cinque persone. Una schermata che spiega una causa
 * che non conosce fa cercare il colpevole sbagliato — e chi aveva modificato i
 * posti giura, con ragione, di non averlo fatto.
 *
 * ── «NON MISURATO» NON È «ZERO» ─────────────────────────────────────────────
 *
 * 🔴 Con `misurato` falso (database non migrato: le colonne del cantiere non
 * esistono e la rotta le omette) qui non si stampa nessun numero. Prima si
 * leggeva «0 persone · su 10 posti · 0 persone in lista d'attesa» accanto a
 * «Sì 3»: uno zero è l'unico valore capace di far sembrare vuoto un pullman
 * pieno, e la schermata non aveva modo di dire «non lo so». Adesso ce l'ha.
 *
 * Il riquadro sta in `role="status"`: dopo un'ammissione dalla coda il totale
 * cambia, e chi usa uno screen reader deve sentirlo senza andarlo a cercare.
 */

interface Props {
    /** Tutti i numeri della schermata, da `numeriAdesioni`: una funzione sola. */
    numeri: NumeriAdesioni;
    /** Il tetto, in PERSONE. `null` = nessun tetto, che è il caso più comune. */
    postiTotali: number | null;
}

export function RiepilogoPosti({ numeri, postiTotali }: Props) {
    const t = useTranslations('avvisi');
    const conTetto = postiTotali !== null && postiTotali !== undefined;

    // «N persone · su M posti · K persone in lista d'attesa». Ogni pezzo è una
    // chiave con il PROPRIO plurale ICU: una frase unica con tre numeri dentro
    // avrebbe un plurale solo, e in italiano «1 persona su 1 posto» e «1 persona
    // su 2 posti» non si declinano insieme.
    const frase = [
        t('postiPersone', { count: numeri.persone }),
        conTetto ? t('postiSuTotale', { totale: postiTotali }) : null,
        t('postiInAttesa', { count: numeri.personeInAttesa }),
    ]
        .filter((pezzo): pezzo is string => pezzo !== null)
        .join(' · ');

    return (
        <div
            role="status"
            className="rounded-3xl border border-kidville-info/60 bg-kidville-info-soft/50 p-4 space-y-2"
        >
            {/* `h2`, come il riquadro accanto: il guscio porta un `h1` (pagina) o un
                `h2` (drawer), e un `h4` qui sarebbe un salto di livello. */}
            <h2 className="flex items-center gap-1.5 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-info">
                <Users size={14} strokeWidth={1.5} aria-hidden="true" /> {t('postiRiepilogoEtichetta')}
            </h2>

            {!numeri.misurato ? (
                // Nessun numero, nessun badge: non c'è niente da segnalare su un
                // conteggio che non è avvenuto, e un «sopra capienza» qui sarebbe
                // un'accusa inventata.
                <p className="font-maven text-xs leading-relaxed text-kidville-sub">{t('postiNonMisurato')}</p>
            ) : (
                <>
                    <p className="font-barlow text-base font-black leading-snug text-kidville-ink">{frase}</p>

                    {/* Le famiglie: lo scarto fra teste e adesioni, leggibile invece che indovinato. */}
                    <p className="font-maven text-xs text-kidville-sub">{t('postiFamiglie', { count: numeri.famiglie })}</p>

                    {/* Le righe che l'elenco non accosta a nessun nome: senza questa
                        riga il totale non si può più sommare a mano, e la differenza
                        resta un mistero di N persone invisibili.

                        ⚠️ La frase (`postiNonIncrociate`) dice «non associata a un
                        alunno di queste sezioni», ma il numero include anche la
                        seconda riga di un genitore separato — un caso legittimo in
                        produzione, dove il bambino È fra i destinatari. Il numero
                        resta giusto (vedi il commento su `NumeriAdesioni.nonIncrociate`
                        in `./numeri-adesioni`); la frase andrebbe rivista in
                        `messages/it/avvisi.json` (+ `en`), fuori perimetro qui. */}
                    {numeri.nonIncrociate > 0 && (
                        <p className="font-maven text-xs leading-relaxed text-kidville-sub">
                            {t('postiNonIncrociate', { count: numeri.nonIncrociate })}
                        </p>
                    )}

                    {numeri.sopraCapienza && (
                        <div className="space-y-1 pt-1">
                            <Badge tone="error">{t('postiSopraCapienza')}</Badge>
                            <p className="font-maven text-xs leading-relaxed text-kidville-sub">
                                {t('postiSopraCapienzaAiuto')}
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
