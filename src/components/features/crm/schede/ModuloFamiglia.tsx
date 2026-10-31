'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { ORIGINI, type Origine, type SchedaRow } from '@/lib/crm/tipi'
import { normalizzaEmail, normalizzaTelefono } from '@/lib/crm/contatti'
import { ETICHETTA_CAMPO_FILTRO } from '@/components/ui/BarraFiltri'
import { AREA, CAMPO } from './stile'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · i campi della FAMIGLIA, gli stessi alla nascita di una scheda e quando la si
 * corregge: genitore, recapiti, origine e le tre domande del colloquio.
 *
 * È un pezzo di modulo, non un modulo: chi lo monta decide il contenitore, i pulsanti e che cosa
 * succede al salvataggio. Tutto lo stato sta fuori (`dati` / `onCambia`), così il confronto con la
 * scheda salvata — «parte solo ciò che è cambiato» — lo fa chi sa com'era.
 */

export interface DatiFamiglia {
  genitoreNome: string
  telefono1: string
  telefono2: string
  email1: string
  email2: string
  origine: Origine
  routine: string
  paura: string
  desiderio: string
}

export const FAMIGLIA_VUOTA: DatiFamiglia = {
  genitoreNome: '',
  telefono1: '',
  telefono2: '',
  email1: '',
  email2: '',
  origine: 'telefonata',
  routine: '',
  paura: '',
  desiderio: '',
}

export function famigliaDaScheda(s: SchedaRow): DatiFamiglia {
  return {
    genitoreNome: s.genitore_nome ?? '',
    telefono1: s.telefono1 ?? '',
    telefono2: s.telefono2 ?? '',
    email1: s.email1 ?? '',
    email2: s.email2 ?? '',
    origine: s.origine,
    routine: s.routine ?? '',
    paura: s.paura ?? '',
    desiderio: s.desiderio ?? '',
  }
}

/**
 * C'è almeno un recapito che il server riconoscerà? Le stesse funzioni con cui lo decide la route
 * (`normalizzaTelefono`, `normalizzaEmail`): un telefono di due cifre qui «vale» e là no, e il
 * modulo partirebbe per tornare con un 422.
 */
export function contattoValido(d: Pick<DatiFamiglia, 'telefono1' | 'telefono2' | 'email1' | 'email2'>): boolean {
  return (
    [d.telefono1, d.telefono2].some((t) => normalizzaTelefono(t) !== null) ||
    [d.email1, d.email2].some((e) => normalizzaEmail(e) !== null)
  )
}

export function ModuloFamiglia({ dati, onCambia, disabilitato = false }: { dati: DatiFamiglia; onCambia: (d: DatiFamiglia) => void; disabilitato?: boolean }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const id = useId()
  const imposta = <K extends keyof DatiFamiglia>(chiave: K, valore: DatiFamiglia[K]) => onCambia({ ...dati, [chiave]: valore })

  // L'origine «ai» la scrive solo l'assistente automatico: da qui non si sceglie. Resta fra le voci
  // solo se è quella che la scheda ha già, altrimenti la tendina non saprebbe mostrarla.
  const origini = ORIGINI.filter((o) => o !== 'ai' || dati.origine === 'ai')

  const testo = (chiave: 'genitoreNome' | 'telefono1' | 'telefono2' | 'email1' | 'email2', etichettaCampo: string, extra?: { tipo?: string; modo?: 'tel' | 'email'; max: number }) => (
    <div>
      <label htmlFor={`${id}-${chiave}`} className={ETICHETTA_CAMPO_FILTRO}>
        {etichettaCampo}
      </label>
      <input
        id={`${id}-${chiave}`}
        type={extra?.tipo ?? 'text'}
        inputMode={extra?.modo}
        autoComplete="off"
        maxLength={extra?.max ?? 120}
        value={dati[chiave]}
        disabled={disabilitato}
        onChange={(e) => imposta(chiave, e.target.value)}
        className={CAMPO}
      />
    </div>
  )

  const domanda = (chiave: 'routine' | 'paura' | 'desiderio', etichettaCampo: string) => (
    <div>
      <label htmlFor={`${id}-${chiave}`} className={ETICHETTA_CAMPO_FILTRO}>
        {etichettaCampo}
      </label>
      <textarea
        id={`${id}-${chiave}`}
        rows={2}
        maxLength={2000}
        value={dati[chiave]}
        disabled={disabilitato}
        onChange={(e) => imposta(chiave, e.target.value)}
        className={AREA}
      />
    </div>
  )

  return (
    <div className="space-y-4">
      {testo('genitoreNome', t('formGenitore'), { max: 120 })}
      <div className="grid gap-4 sm:grid-cols-2">
        {testo('telefono1', t('formTelefono1'), { tipo: 'tel', modo: 'tel', max: 40 })}
        {testo('telefono2', t('formTelefono2'), { tipo: 'tel', modo: 'tel', max: 40 })}
        {testo('email1', t('formEmail1'), { tipo: 'email', modo: 'email', max: 200 })}
        {testo('email2', t('formEmail2'), { tipo: 'email', modo: 'email', max: 200 })}
      </div>
      <div>
        <label htmlFor={`${id}-origine`} className={ETICHETTA_CAMPO_FILTRO}>
          {t('formOrigine')}
        </label>
        <select
          id={`${id}-origine`}
          value={dati.origine}
          disabled={disabilitato}
          onChange={(e) => imposta('origine', e.target.value as Origine)}
          className={CAMPO}
        >
          {origini.map((o) => (
            <option key={o} value={o}>
              {etichetta(tc, 'origini', o)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="space-y-3">
        <legend className={ETICHETTA_CAMPO_FILTRO}>{t('formDomande')}</legend>
        {domanda('routine', t('domandaRoutine'))}
        {domanda('paura', t('domandaPaura'))}
        {domanda('desiderio', t('domandaDesiderio'))}
      </fieldset>
    </div>
  )
}
