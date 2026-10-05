'use client';

// ─── «ASSOCIATO A»: A CHE COSA È LEGATO QUESTO BONIFICO (2026-10-05) ──────────
//
// Il popup di un movimento CONFERMATO sapeva dire lo stato della fattura della
// voce àncora e basta: non la voce, non il bambino, non chi aveva confermato. E
// prima di «Modifica/Elimina associazione» bisogna sapere CHE COSA si sta per
// sciogliere. Questo riquadro lo dice.
//
// PRESENTAZIONALE: nessuna fetch. La lettura è del popup (`MovimentoDialog`), una
// sola per apertura — lock «aprire il popup costa UNA lettura sola».
//
// I TRE STATI CHE NON SI CONFONDONO: in volo («Caricamento…»), NON LETTO (un
// avviso: «non è stato possibile leggere…») e NESSUNA VOCE (una frase). Un errore
// travestito da elenco vuoto direbbe che il bonifico non paga niente.
//
// 🔴 La voce di un fratello iscritto in un ALTRA SEDE arriva dal server senza
// nome né descrizione (`fuori_sede`): qui si scrive «Voce di un'altra sede», con
// le sole cifre. Mai un `null` a schermo, mai un nome indovinato.

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { formatEuro } from '@/lib/format/valuta';
import { OCCHIELLO, type AssociazioneUi, type VoceAssociataUi } from './riconciliazione-ui';

/**
 * Lo stato della voce con le parole che il genitore legge sulla stessa voce
 * (`pagamenti.stato*`): il catalogo della contabilità non ha le quattro etichette,
 * e scriverle di nuovo vorrebbe dire due nomi per lo stesso stato. Mappa STATICA:
 * le chiavi sono nominate per esteso, nessuna costruita da un dato. Uno stato
 * fuori dai quattro non si scrive — un enum grezzo a schermo non è un'etichetta.
 */
const CHIAVE_STATO_VOCE: Record<string, 'statoDaPagare' | 'statoParziale' | 'statoPagato' | 'statoScaduto'> = {
  da_pagare: 'statoDaPagare',
  parziale: 'statoParziale',
  pagato: 'statoPagato',
  scaduto: 'statoScaduto',
};

interface Props {
  associazione: AssociazioneUi | null;
  caricamento: boolean;
  errore: boolean;
}

export function AssociazioneBonifico({ associazione, caricamento, errore }: Props) {
  const t = useTranslations('adminContabilita');
  const tp = useTranslations('pagamenti');
  const f = useDateFormat();
  const data = (d: string | null) => (d ? f.dataBreve(d) : '—');

  /** «Mara Bianchi · Retta ottobre», oppure «Voce di un'altra sede». */
  const nomeVoce = (v: VoceAssociataUi) =>
    v.fuori_sede ? t('movdlgAssociatoAltraSede') : `${v.alunno ?? '—'} · ${v.descrizione ?? '—'}`;

  /** Chi ha abbinato, e quando: la macchina, una persona con nome, o solo una data. */
  const chiHaConfermato = (a: AssociazioneUi) =>
    a.automatico
      ? t('movdlgAssociatoAutomatico', { data: data(a.confermato_il) })
      : a.confermato_da
        ? t('movdlgAssociatoConfermatoDa', { nome: a.confermato_da, data: data(a.confermato_il) })
        : t('movdlgAssociatoConfermatoIl', { data: data(a.confermato_il) });

  const voci = associazione?.voci ?? [];

  return (
    // Crema PIENO come i due riquadri gemelli (causale, documenti): con l'alfa nel
    // nome della classe la regola di Alto Contrasto `.bg-kidville-cream` del popup
    // non lo raggiungerebbe. `mb-4` è lo stacco dal riquadro Documenti sotto.
    // Senza nome accessibile, come il gemello «Documenti»: un `region` in più dentro
    // l'`aside` sarebbe un landmark per un riquadro, e chi naviga per regioni ne
    // troverebbe uno ogni pochi centimetri. Lo struttura il titolo `h3`.
    <section className="mb-4 rounded-card bg-kidville-cream p-4">
      <h3 className={OCCHIELLO}>{t('movdlgAssociatoA')}</h3>
      {caricamento ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('movdlgCaricamento')}</p>
      ) : errore ? (
        // Lo stesso vestito degli altri errori del popup. «Non ho potuto leggere» non
        // impedisce di scollegare: la riapertura la decide il server, non questa lettura.
        <p role="alert" className="mt-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
          {t('movdlgAssociatoErrore')}
        </p>
      ) : voci.length === 0 ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('movdlgAssociatoNessuna')}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {voci.map((v) => {
            const chiaveStato = CHIAVE_STATO_VOCE[v.stato_voce];
            return (
              <li key={v.pagamento_id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 break-words font-maven text-sm font-bold leading-snug text-kidville-ink">{nomeVoce(v)}</p>
                  {/* Quanto ha messo QUESTO bonifico sulla voce, su quanto vale la voce:
                      su un composito la somma delle prime cifre fa l'importo del bonifico. */}
                  <p className="shrink-0 font-maven text-sm tabular-nums text-kidville-ink">
                    {t('movdlgAssociatoIncassato', { incassato: formatEuro(v.incassato_qui), totale: formatEuro(v.importo_voce) })}
                  </p>
                </div>
                {/* Mai `text-kidville-muted` (2,51:1): c'è un lock, e il motivo è che non si legge. */}
                {chiaveStato && <p className="mt-1 font-maven text-xs text-kidville-sub">{tp(chiaveStato)}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {associazione && !caricamento && !errore && (
        <p className="mt-4 font-maven text-xs text-kidville-sub">{chiHaConfermato(associazione)}</p>
      )}
    </section>
  );
}
