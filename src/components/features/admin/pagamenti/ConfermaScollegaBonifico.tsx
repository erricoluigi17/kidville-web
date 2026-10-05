'use client';

// ─── LA CONFERMA DELLO SCOLLEGAMENTO: CHE COSA SUCCEDE, PRIMA CHE SUCCEDA ──────
//
// «Riapri» su un bonifico confermato stornava l'incasso senza dire QUALE, né che
// fine avrebbero fatto ricevuta, fattura emessa e richiesta in coda. Questa
// conferma elenca le conseguenze PRIMA di farle, ricavandole dall'associazione che
// il popup ha appena letto (`AssociazioneBonifico`), e solo quelle vere per QUESTO
// bonifico: una conferma che dice sempre le stesse sei righe smette di essere letta.
//
// Due modi, un componente:
//  · «modifica» — si scioglie l'abbinamento per rifarlo: la riga torna libera e il
//    popup si riapre su di lei (lo fa il pannello). Nessun destino da scegliere.
//  · «elimina»  — si scioglie e basta, e si sceglie dove va la riga: di nuovo da
//    abbinare (predefinito) o fra gli ignorati, per un bonifico che in app non
//    corrisponde a niente.
//
// Annidata nel popup con il `Modal` dell'app: niente portale, quindi eredita
// l'àncora `kv-recon-dialog` dell'Alto Contrasto; la pila dei `Modal` le dà Escape
// e il giro del fuoco finché è aperta.
//
// 🔴 La voce di un fratello iscritto in un'ALTRA SEDE (`fuori_sede`) non ha nome
// né descrizione: al loro posto «Voce di un'altra sede» — e il suo storno si dice
// lo stesso, con la cifra, perché avverrà.

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { MODAL_CARD, MODAL_SHADOW, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { OCCHIELLO, type AssociazioneUi, type VoceAssociataUi } from './riconciliazione-ui';

type Destino = 'da_abbinare' | 'ignorato';

interface Props {
  modo: 'modifica' | 'elimina';
  associazione: AssociazioneUi;
  busy: boolean;
  onConferma: (poi: Destino) => void;
  onAnnulla: () => void;
}

export function ConfermaScollegaBonifico({ modo, associazione, busy, onConferma, onAnnulla }: Props) {
  const t = useTranslations('adminContabilita');
  const uid = useId();
  const idTitolo = `${uid}-titolo`;
  const idAiutoIgnorato = `${uid}-aiuto-ignorato`;
  const [scelta, setScelta] = useState<Destino>('da_abbinare');

  const altraSede = t('movdlgAssociatoAltraSede');
  /** La voce per nome — o «Voce di un'altra sede», che non ne ha uno da mostrare. */
  const voceDi = (v: VoceAssociataUi) => (v.fuori_sede ? altraSede : (v.descrizione ?? '—'));
  /**
   * Il bambino. Su una voce di un'altra sede il nome non c'è, e ripetere lì
   * «Voce di un'altra sede» farebbe dire la stessa cosa due volte nella stessa
   * riga: la parentesi porta il trattino, come ogni campo che il server non ha.
   */
  const alunnoDi = (v: VoceAssociataUi) => (v.fuori_sede ? '—' : (v.alunno ?? '—'));

  /**
   * Le conseguenze, nell'ordine in cui accadono: prima il DENARO (gli storni), poi
   * ciò che quel denaro aveva generato (voci composte, ricevuta), poi i DOCUMENTI
   * fiscali (fattura emessa, richiesta in coda), infine — per «Modifica» — il passo
   * che resta da fare. Ogni riga è vera per questo bonifico, o non c'è.
   * La chiave React è l'identità della conseguenza (tipo + voce), non la posizione.
   */
  const conseguenze: { k: string; testo: string }[] = [];
  for (const v of associazione.voci) {
    if (v.incassato_qui > 0) {
      conseguenze.push({
        k: `storno-${v.pagamento_id}`,
        testo: t('scollegaStorno', { voce: voceDi(v), alunno: alunnoDi(v), importo: formatEuro(v.incassato_qui) }),
      });
    }
  }
  if (associazione.tipo === 'composita') {
    conseguenze.push({ k: 'voci-composte', testo: t('scollegaVociComposte') });
    conseguenze.push({ k: 'ricevuta', testo: t('scollegaRicevuta') });
  }
  for (const v of associazione.voci) {
    if (v.fattura_stato === 'emessa') {
      conseguenze.push({ k: `fattura-${v.pagamento_id}`, testo: t('scollegaFatturaEmessa', { voce: voceDi(v) }) });
    }
  }
  // `in_invio` NON si dice qui: una fattura in volo verso lo SDI non si toglie, e il
  // server rifiuta la riapertura con un 409 che il popup mostra per esteso.
  for (const v of associazione.voci) {
    if (v.fattura_in_coda === 'in_coda' || v.fattura_in_coda === 'errore') {
      conseguenze.push({ k: `coda-${v.pagamento_id}`, testo: t('scollegaFatturaInCoda', { voce: voceDi(v) }) });
    }
  }
  if (modo === 'modifica') conseguenze.push({ k: 'dopo-modifica', testo: t('scollegaDopoModifica') });

  const titolo = t(modo === 'modifica' ? 'scollegaTitoloModifica' : 'scollegaTitoloElimina');

  return (
    <Modal
      open
      onClose={onAnnulla}
      title={titolo}
      labelledBy={idTitolo}
      className={cx(MODAL_CARD, 'max-h-[90vh] overflow-y-auto')}
      style={{ boxShadow: MODAL_SHADOW }}
    >
      <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">{titolo}</h2>

      {/* Nessuna intestazione sopra un elenco vuoto: succede solo se la lettura
          dell'associazione è fallita, e allora la conferma dice soltanto ciò che
          vale per tutte — la scelta del destino. Non inventa storni che non conosce. */}
      {conseguenze.length > 0 && (
        <>
          <p className="mt-4 font-maven text-sm text-kidville-ink">{t('scollegaIntro')}</p>
          <ul className="mt-2 list-disc space-y-2 pl-5 font-maven text-sm leading-snug text-kidville-ink">
            {conseguenze.map((c) => <li key={c.k}>{c.testo}</li>)}
          </ul>
        </>
      )}

      {modo === 'elimina' && (
        <fieldset className="mt-4">
          <legend className={OCCHIELLO}>{t('scollegaDestinoLegenda')}</legend>
          {/* Bersagli da 44px (WCAG 2.5.8): l'etichetta intera è il bersaglio, non il
              pallino da 16. Il nome di ogni scelta è la sua sola frase; l'aiuto di
              «ignorato» le è collegato come DESCRIZIONE, così il nome resta corto. */}
          <div className="mt-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 font-maven text-sm text-kidville-ink">
              <input
                type="radio"
                name={`${uid}-destino`}
                value="da_abbinare"
                checked={scelta === 'da_abbinare'}
                onChange={() => setScelta('da_abbinare')}
                className="h-4 w-4 shrink-0 accent-kidville-green"
              />
              {t('scollegaDestinoDaAbbinare')}
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 font-maven text-sm text-kidville-ink">
              <input
                type="radio"
                name={`${uid}-destino`}
                value="ignorato"
                checked={scelta === 'ignorato'}
                onChange={() => setScelta('ignorato')}
                aria-describedby={idAiutoIgnorato}
                className="h-4 w-4 shrink-0 accent-kidville-green"
              />
              {t('scollegaDestinoIgnorato')}
            </label>
            {/* Mai `text-kidville-muted` (2,51:1): c'è un lock, e il motivo è che non si legge.
                `pl-7` allinea l'aiuto al testo dell'etichetta: pallino 16px + spazio 12px. */}
            <p id={idAiutoIgnorato} className="pl-7 font-maven text-xs leading-relaxed text-kidville-sub">
              {t('scollegaDestinoIgnoratoAiuto')}
            </p>
          </div>
        </fieldset>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {/* «Annulla» PRIMA, ed è il primo comando che il `Modal` mette a fuoco su
            «Modifica»: davanti a uno storno, Invio a vuoto non deve confermare. */}
        <button type="button" onClick={onAnnulla} className={cx(BTN_SECONDARY, 'min-h-11')}>
          {t('scollegaAnnulla')}
        </button>
        <button
          type="button"
          onClick={() => onConferma(modo === 'modifica' ? 'da_abbinare' : scelta)}
          disabled={busy}
          className={cx(BTN_PRIMARY_AA, 'min-h-11')}
        >
          {t('scollegaConferma')}
        </button>
      </div>
    </Modal>
  );
}
