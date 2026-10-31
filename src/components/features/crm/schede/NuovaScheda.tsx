'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { DateField } from '@/components/ui/DateField'
import { ETICHETTA_CAMPO_FILTRO } from '@/components/ui/BarraFiltri'
import { ANNI_INGRESSO, type AnnoIngresso } from '@/lib/crm/tipi'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { ModuloFamiglia, FAMIGLIA_VUOTA, contattoValido, type DatiFamiglia } from './ModuloFamiglia'
import { chiama, leggiJson, scrittura } from './rete'
import { CAMPO, MESSAGGIO_ERRORE, RIQUADRO, TESTO_SECONDARIO, TITOLO_SEZIONE } from './stile'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · «Nuova famiglia»: i contatti, l'origine, uno o più bambini e le tre domande
 * facoltative. Dopo la creazione chiama `onCreata(id)`.
 *
 * ── La famiglia che c'è già ─────────────────────────────────────────────────────────────────────
 * Un telefono o un'email già presenti in un'altra scheda della sede fanno rispondere alla route
 * `409 SCHEDA_ESISTENTE` con l'id di quella scheda. Non è un errore da mostrare in rosso: è una
 * domanda. Qui diventa una scelta — «Apri la scheda esistente» (e allora non si crea niente) oppure
 * «Crea comunque» (la stessa richiesta, con `forza`: due genitori che condividono un numero sono
 * due famiglie vere). Se si tocca un campo prima di scegliere, la scelta decade: il confronto che il
 * server aveva fatto non vale più.
 *
 * "Apri la scheda esistente" chiama anch'essa `onCreata`: la firma è fissata dal contratto fra le
 * sessioni, e a chi ascolta serve la stessa cosa (chiudere il modulo e aprire QUELLA scheda).
 *
 * ── La sede ─────────────────────────────────────────────────────────────────────────────────────
 * Si manda sempre `scuolaId`, quella che la pagina ha dichiarato: un utente con più sedi non deve
 * mai far indovinare al server dove archiviare una famiglia.
 */

/** L'`id` del titolo: chi monta il modulo in un dialogo lo usa come `labelledBy`. */
export const ID_TITOLO_NUOVA_SCHEDA = 'crm-nuova-scheda-titolo'

const MAX_BAMBINI = 6

interface BozzaBambino {
  chiave: number
  nome: string
  dataNascita: string
  annoIngresso: AnnoIngresso
}

const nuovoBambino = (chiave: number): BozzaBambino => ({ chiave, nome: '', dataNascita: '', annoIngresso: 'non_indicato' })

type Fase = { tipo: 'compila' } | { tipo: 'invio' } | { tipo: 'creata' } | { tipo: 'esistente'; schedaId: string }

const pulito = (v: string) => v.trim()

export function NuovaScheda({
  scuolaId,
  onCreata,
  onAnnulla,
}: {
  scuolaId: string
  onCreata: (schedaId: string) => void
  onAnnulla: () => void
}) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const id = useId()
  const [dati, setDati] = useState<DatiFamiglia>(FAMIGLIA_VUOTA)
  const [bambini, setBambini] = useState<BozzaBambino[]>([nuovoBambino(0)])
  const [fase, setFase] = useState<Fase>({ tipo: 'compila' })
  const [errore, setErrore] = useState<string | null>(null)
  const prossimaChiave = useRef(1)

  const bloccato = fase.tipo === 'invio' || fase.tipo === 'creata'
  const valido = pulito(dati.genitoreNome) !== '' && contattoValido(dati) && bambini.every((b) => pulito(b.nome) !== '')

  // Toccare un campo annulla la scelta «esiste già»: il confronto del server riguardava i dati di prima.
  const tornaACompilare = () => setFase((f) => (f.tipo === 'esistente' ? { tipo: 'compila' } : f))
  const cambiaFamiglia = (d: DatiFamiglia) => {
    setDati(d)
    tornaACompilare()
  }
  const cambiaBambino = (chiave: number, parte: Partial<BozzaBambino>) => {
    setBambini((lista) => lista.map((b) => (b.chiave === chiave ? { ...b, ...parte } : b)))
    tornaACompilare()
  }
  const aggiungiBambino = () => {
    if (bambini.length >= MAX_BAMBINI) return
    const chiave = prossimaChiave.current++
    setBambini((lista) => [...lista, nuovoBambino(chiave)])
    tornaACompilare()
  }
  const togliBambino = (chiave: number) => {
    setBambini((lista) => (lista.length > 1 ? lista.filter((b) => b.chiave !== chiave) : lista))
    tornaACompilare()
  }

  /** Solo i campi compilati: un campo vuoto non è «svuota», è «non c'è». */
  const corpo = (forza: boolean) => ({
    scuolaId,
    genitoreNome: pulito(dati.genitoreNome),
    ...(pulito(dati.telefono1) && { telefono1: pulito(dati.telefono1) }),
    ...(pulito(dati.telefono2) && { telefono2: pulito(dati.telefono2) }),
    ...(pulito(dati.email1) && { email1: pulito(dati.email1) }),
    ...(pulito(dati.email2) && { email2: pulito(dati.email2) }),
    origine: dati.origine,
    ...(pulito(dati.routine) && { routine: pulito(dati.routine) }),
    ...(pulito(dati.paura) && { paura: pulito(dati.paura) }),
    ...(pulito(dati.desiderio) && { desiderio: pulito(dati.desiderio) }),
    bambini: bambini.map((b) => ({
      nome: pulito(b.nome),
      ...(b.dataNascita !== '' && { dataNascita: b.dataNascita }),
      annoIngresso: b.annoIngresso,
    })),
    ...(forza && { forza: true }),
  })

  const crea = async (forza: boolean) => {
    if (!valido || bloccato) return
    setFase({ tipo: 'invio' })
    setErrore(null)
    const res = await chiama('scheda-crea', '/api/admin/crm/schede', scrittura('POST', corpo(forza)))
    if (res === null) {
      setErrore(t('nuovaErrore'))
      setFase({ tipo: 'compila' })
      return
    }
    const json = (await leggiJson(res, 'scheda-crea')) as { id?: unknown; codice?: unknown; schedaId?: unknown } | null
    if (res.ok && typeof json?.id === 'string') {
      setFase({ tipo: 'creata' })
      onCreata(json.id)
      return
    }
    if (res.status === 409 && json?.codice === 'SCHEDA_ESISTENTE' && typeof json.schedaId === 'string') {
      setFase({ tipo: 'esistente', schedaId: json.schedaId })
      return
    }
    setErrore(messaggioDaCorpo(json, t('nuovaErrore')))
    setFase({ tipo: 'compila' })
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void crea(false)
      }}
      className="space-y-5"
    >
      <h2 id={ID_TITOLO_NUOVA_SCHEDA} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
        {t('nuovaTitolo')}
      </h2>

      <ModuloFamiglia dati={dati} onCambia={cambiaFamiglia} disabilitato={bloccato} />
      {!contattoValido(dati) && <p className={TESTO_SECONDARIO}>{t('formContattoServe')}</p>}

      <section aria-labelledby={`${id}-bambini`} className="space-y-3">
        <h3 id={`${id}-bambini`} className={TITOLO_SEZIONE}>
          {t('sezioneBambini')}
        </h3>
        {bambini.map((b, indice) => (
          <fieldset key={b.chiave} className={`${RIQUADRO} relative space-y-3`} disabled={bloccato}>
            <legend className="px-1 font-barlow text-[13px] font-extrabold uppercase text-kidville-ink">{t('nuovaBambinoN', { n: indice + 1 })}</legend>
            {bambini.length > 1 && (
              <button
                type="button"
                onClick={() => togliBambino(b.chiave)}
                aria-label={t('nuovaTogliBambino', { n: indice + 1 })}
                className="absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-pill text-kidville-sub transition-colors hover:bg-kidville-line/40 hover:text-kidville-error-strong"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
            <div>
              <label htmlFor={`${id}-nome-${b.chiave}`} className={ETICHETTA_CAMPO_FILTRO}>
                {t('nuovaBambinoNome')}
              </label>
              <input
                id={`${id}-nome-${b.chiave}`}
                type="text"
                autoComplete="off"
                maxLength={100}
                value={b.nome}
                onChange={(e) => cambiaBambino(b.chiave, { nome: e.target.value })}
                className={CAMPO}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${id}-nascita-${b.chiave}`} className={ETICHETTA_CAMPO_FILTRO}>
                  {t('nuovaBambinoNascita')}
                </label>
                <DateField
                  id={`${id}-nascita-${b.chiave}`}
                  value={b.dataNascita}
                  onChange={(iso) => cambiaBambino(b.chiave, { dataNascita: iso })}
                  className={CAMPO}
                />
              </div>
              <div>
                <label htmlFor={`${id}-anno-${b.chiave}`} className={ETICHETTA_CAMPO_FILTRO}>
                  {t('nuovaBambinoAnno')}
                </label>
                <select
                  id={`${id}-anno-${b.chiave}`}
                  value={b.annoIngresso}
                  onChange={(e) => cambiaBambino(b.chiave, { annoIngresso: e.target.value as AnnoIngresso })}
                  className={CAMPO}
                >
                  {ANNI_INGRESSO.map((a) => (
                    <option key={a} value={a}>
                      {etichetta(tc, 'anniIngresso', a)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>
        ))}
        {bambini.length < MAX_BAMBINI && (
          <Btn variant="ghost" size="sm" onClick={aggiungiBambino} disabled={bloccato}>
            <Plus size={14} aria-hidden="true" />
            {t('nuovaAggiungiBambino')}
          </Btn>
        )}
      </section>

      {errore !== null && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}

      {fase.tipo === 'esistente' ? (
        <div role="status" className="space-y-3 rounded-card border border-kidville-warn/40 bg-kidville-warn-soft p-4">
          <p className="font-barlow text-sm font-extrabold uppercase text-kidville-warn-strong">{t('esistenteTitolo')}</p>
          <p className="font-maven text-sm text-kidville-ink">{t('esistenteCorpo')}</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => onCreata(fase.schedaId)}>{t('esistenteApri')}</Btn>
            <Btn variant="ghost" onClick={() => void crea(true)}>
              {t('esistenteForza')}
            </Btn>
            <Btn variant="ghost" onClick={onAnnulla}>
              {t('annulla')}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Btn variant="ghost" onClick={onAnnulla} disabled={fase.tipo === 'invio'}>
            {t('annulla')}
          </Btn>
          <Btn type="submit" disabled={!valido || bloccato}>
            {fase.tipo === 'invio' ? t('nuovaCreazione') : t('nuovaCrea')}
          </Btn>
        </div>
      )}
    </form>
  )
}
