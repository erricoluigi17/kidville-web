'use client'

import { Mail, Phone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { GenitoreScheda } from '@/lib/anagrafiche/docente/tipi'
import { CampoLettura } from './CampoLettura'

const LINK =
  'inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-kidville-green underline-offset-2 hover:underline'

/** Il numero come lo vuole il compositore: solo cifre e `+`. */
const hrefTelefono = (numero: string) => `tel:${numero.replace(/[^\d+]/g, '')}`

export function SchedaGenitore({ genitore }: { genitore: GenitoreScheda }) {
  const t = useTranslations('teacherServizi')
  const nonIndicato = t('anagraficaNonIndicato')
  const parentela =
    genitore.parentela === 'madre'
      ? t('anagraficaParentelaMadre')
      : genitore.parentela === 'padre'
        ? t('anagraficaParentelaPadre')
        : genitore.parentela === 'delegato'
          ? t('anagraficaParentelaDelegato')
          : genitore.parentela === 'altro'
            ? t('anagraficaParentelaAltro')
            : null
  const sottotitolo = [parentela, genitore.principale ? t('anagraficaPrincipale') : null].filter(Boolean).join(' · ')

  return (
    <article data-testid="scheda-genitore" className="rounded-input border border-kidville-line p-3">
      <h3 className="font-barlow text-sm font-extrabold uppercase text-kidville-ink">
        {genitore.cognome} {genitore.nome}
      </h3>
      {sottotitolo && <p className="font-maven text-xs text-kidville-sub">{sottotitolo}</p>}
      <dl className="mt-1 divide-y divide-kidville-line">
        <CampoLettura
          etichetta={t('anagraficaCampoTelefono')}
          nonIndicato={nonIndicato}
          valore={
            genitore.telefoni.length === 0 ? null : (
              <ul>
                {genitore.telefoni.map((numero, i) => (
                  <li key={`${i}-${numero}`}>
                    <a href={hrefTelefono(numero)} className={LINK}>
                      <Phone size={14} aria-hidden="true" />
                      {numero}
                    </a>
                  </li>
                ))}
              </ul>
            )
          }
        />
        <CampoLettura
          etichetta={t('anagraficaCampoEmail')}
          nonIndicato={nonIndicato}
          valore={
            genitore.email.length === 0 ? null : (
              <ul>
                {genitore.email.map((indirizzo, i) => (
                  <li key={`${i}-${indirizzo}`}>
                    <a href={`mailto:${indirizzo}`} className={`${LINK} break-all`}>
                      <Mail size={14} aria-hidden="true" />
                      {indirizzo}
                    </a>
                  </li>
                ))}
              </ul>
            )
          }
        />
        <CampoLettura etichetta={t('anagraficaCampoCodiceFiscale')} nonIndicato={nonIndicato} valore={genitore.codiceFiscale} />
      </dl>
    </article>
  )
}
