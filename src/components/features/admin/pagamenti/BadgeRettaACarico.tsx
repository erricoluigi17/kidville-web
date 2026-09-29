'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { STATI_PAGAMENTO as STATI } from './stati';
import { anomaliaPagante, componiBadge, ripulisciFrase, valoriPrefisso, type LegameRetta } from '@/lib/pagamenti/rette-a-carico';

/**
 * K2 (seconda revisione 2026-09-28) — nella TABELLA desktop ogni badge di questo file ha una
 * larghezza minima. Con `aCapo` l'algoritmo della tabella stringe la colonna Stato fino alla
 * larghezza minima del contenuto: misurato fra 1024 e 1279 px, a 1024 un badge di 109×132 px,
 * otto righe di testo, righe della tabella alte 155–198 px. E con `[overflow-wrap:anywhere]`
 * (K3, in `Badge.tsx`) quella larghezza minima scende a una lettera. SOLO nella tabella: nella
 * card mobile il badge ha la sua riga intera, e a 360 px è giusto com'è.
 *
 * PERCHÉ 10rem E NON DI PIÙ — misurato a 1024 px col CSS della build e il font vero, con nomi
 * lunghi apposta («Mario Francesco Santamaria Esposito (Sezione Primavera C)»):
 *   · vista a UNA sede: senza minimo la tabella entra (704 su 704 px); con 10rem entra ancora
 *     (righe al più 136 px, badge 164 px); con 11rem sfora di 10 px, con 13rem di 42 — cioè
 *     il bottone «Incassa» finirebbe oltre il bordo, dietro uno scorrimento che prima non c'era;
 *   · vista a PIÙ sedi (la colonna Sede in più): la tabella scorre già senza minimo (805 su 704);
 *     con 10rem le righe scendono da 152–198 px a 105–136, con 13rem a 105–133. Il guadagno è
 *     quasi tutto nei primi 10rem.
 */
const MINIMO_IN_TABELLA = 'min-w-[10rem]';

interface PropsComuni {
    legame: LegameRetta;
    /** Il badge sta nella tabella desktop: larghezza minima (K2). Mai nella card mobile. */
    inTabella?: boolean;
}

/** La riga SENZA retta propria: il badge al posto di «Non generata», con lo stato del pagante. */
interface PropsSenzaRettaPropria extends PropsComuni {
    conRettaPropria?: false;
    /** La retta del PAGANTE per il mese scelto — la stessa che disegna la sua riga — se c'è. */
    rettaPagante?: { stato: string } | null;
    /**
     * I pagamenti della sede del pagante sono caricati: allora «nessuna retta» vuol dire
     * «Non generata» (D4). Se non lo sono, lo stato NON si conosce e non si inventa.
     */
    sedeCaricata: boolean;
}

/**
 * Il bambino ha anche una retta PROPRIA del mese (D9): solo l'avviso «da verificare». Lo stato
 * del pagante qui non si mostra, quindi né la sua retta né la sua sede servono — e il tipo lo
 * dice (Z3d, quinta revisione 2026-09-29): prima `sedeCaricata` era obbligatoria anche qui, e
 * il cruscotto passava un `sedeCaricata` che non significava niente.
 */
interface PropsConRettaPropria extends PropsComuni {
    conRettaPropria: true;
    rettaPagante?: never;
    sedeCaricata?: never;
}

type Props = PropsSenzaRettaPropria | PropsConRettaPropria;

/**
 * Tutti i badge di questo file sono `aCapo`: sono FRASI (fino a ~430 px col font vero), e con
 * il `whitespace-nowrap` del Badge uscivano dalla card mobile e allargavano la tabella.
 *
 * «Paga il fratello Mario Rossi (Sez. C) · Da pagare» al posto di «Non generata» (D1–D5),
 * del colore della retta del fratello (D3). Più, se serve, l'avviso rosso quando chi paga
 * non risulta iscritto (ritirato, archiviato, ma anche sospeso: «non più» sarebbe falso) o è
 * in un'altra sede (D12). Nessuna azione: si incassa solo dalla riga del fratello (D8).
 */
export function BadgeRettaACarico(props: Props) {
    const { legame, inTabella = false } = props;
    const t = useTranslations('adminContabilita');
    const valori = valoriPrefisso(legame.pagante);
    const anomalia = anomaliaPagante(legame);
    const larghezza = inTabella ? MINIMO_IN_TABELLA : undefined;
    const avvisoAnomalia = anomalia ? (
        <Badge tone="error" aCapo className={larghezza} data-testid="retta-a-carico-anomalia">
            {anomalia === 'non-iscritto' ? t('dashPaganteNonIscritto') : t('dashPaganteAltraSede')}
        </Badge>
    ) : null;

    if (props.conRettaPropria) {
        return (
            <>
                <Badge tone="warn" aCapo className={larghezza} data-testid="retta-a-carico-verifica">{ripulisciFrase(t('dashACaricoVerifica', valori))}</Badge>
                {avvisoAnomalia}
            </>
        );
    }

    const { rettaPagante, sedeCaricata } = props;
    const st = rettaPagante ? (STATI[rettaPagante.stato] ?? STATI.da_pagare) : null;
    const stato = st ? st.label : sedeCaricata ? t('dashNonGenerata') : null;
    return (
        <>
            <Badge tone={st?.tone ?? 'neutral'} aCapo className={larghezza} data-testid="retta-a-carico">
                {/* `ripulisciFrase` (Q8): con un nome vuoto il messaggio ICU lascia uno spazio in
                    coda, e davanti a « · stato» diventavano due. La stessa dell'Excel (lock). */}
                {componiBadge(ripulisciFrase(t('dashACarico', valori)), stato)}
            </Badge>
            {avvisoAnomalia}
        </>
    );
}

/**
 * C3 (revisione 2026-09-28) — chi paga sta in una sede che l'utente NON legge: di lui la GET
 * non manda niente (né nome, né classe, né lo stato della sua retta), e qui non si inventa.
 * Si dice solo che il bambino è a carico di un fratello altrove — così non sembra dimenticato
 * («Non generata») — più l'avviso rosso già usato per l'altra sede. Vale con e senza una retta
 * propria del bambino (D9): nessuna azione, come per ogni riga a carico (D8).
 */
export function BadgeRettaACaricoNonVisibile({ inTabella = false }: { inTabella?: boolean } = {}) {
    const t = useTranslations('adminContabilita');
    const larghezza = inTabella ? MINIMO_IN_TABELLA : undefined;
    return (
        <>
            <Badge tone="neutral" aCapo className={larghezza} data-testid="retta-a-carico-non-visibile">{t('dashACaricoAltraSede')}</Badge>
            <Badge tone="error" aCapo className={larghezza} data-testid="retta-a-carico-anomalia">{t('dashPaganteAltraSede')}</Badge>
        </>
    );
}
