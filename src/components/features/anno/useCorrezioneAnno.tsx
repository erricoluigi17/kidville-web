'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CorrezioneAnnoDialog } from '@/components/features/anno/CorrezioneAnnoDialog'
import { inviaChiedendoLaCorrezione, type InviaConCorrezione } from '@/lib/ui/correzione-fetch'

/**
 * `useCorrezioneAnno` — il gancio delle schermate che scrivono per lo staff (PR 4.9, compito 4.9.3).
 *
 *     const { inviaConCorrezione, dialogo } = useCorrezioneAnno('2026/27')
 *     const r = await inviaConCorrezione((correzione) =>
 *       fetch(url, { method: 'POST', body: JSON.stringify({ ...corpo, ...(correzione ? { correzione } : {}) }) }))
 *     …
 *     return <>{…}{dialogo}</>
 *
 * Se il server risponde 409 `ANNO_CHIUSO` con `correzione_possibile: true`, si apre il dialogo; col motivo la richiesta riparte UNA
 * volta, con `correzione`. Se la persona annulla (o la pagina si smonta mentre il dialogo è aperto) torna la prima risposta, il 409,
 * e la schermata lo mostra come ogni altro rifiuto. Un altro rifiuto qualunque (docente, anno in chiusura, rete) non apre niente.
 *
 * `etichetta` è l'anno che si sta correggendo, se la pagina lo sa (es. «2026/27»): finisce nella frase del dialogo. Se la pagina non lo
 * sa, vale quello che il server scrive nel 409 (`etichetta`).
 * Una sola richiesta in attesa alla volta: una seconda mentre il dialogo è aperto prende il rifiuto del 409 senza aprirne un altro.
 */
export function useCorrezioneAnno(etichetta?: string): { inviaConCorrezione: InviaConCorrezione; dialogo: ReactNode } {
  const [aperto, setAperto] = useState(false)
  // L'anno che il server ha nominato nel 409: serve quando la pagina non lo sa (votazioni, competenze).
  const [dalServer, setDalServer] = useState<string | undefined>(undefined)
  const attesa = useRef<((motivo: string | null) => void) | null>(null)

  const chiudi = useCallback((motivo: string | null) => {
    const risolvi = attesa.current
    attesa.current = null
    setAperto(false)
    risolvi?.(motivo)
  }, [])

  // La pagina si smonta con il dialogo aperto: la richiesta in attesa non resta appesa.
  useEffect(() => () => {
    const risolvi = attesa.current
    attesa.current = null
    risolvi?.(null)
  }, [])

  const chiediMotivo = useCallback(
    (daServer?: string) =>
      new Promise<string | null>((risolvi) => {
        if (attesa.current) {
          risolvi(null)
          return
        }
        attesa.current = risolvi
        setDalServer(daServer)
        setAperto(true)
      }),
    [],
  )

  const inviaConCorrezione = useCallback<InviaConCorrezione>(
    (invia) => inviaChiedendoLaCorrezione(invia, chiediMotivo),
    [chiediMotivo],
  )

  const dialogo = aperto ? (
    <CorrezioneAnnoDialog etichetta={etichetta ?? dalServer} onConferma={(motivo) => chiudi(motivo)} onAnnulla={() => chiudi(null)} />
  ) : null

  return { inviaConCorrezione, dialogo }
}
