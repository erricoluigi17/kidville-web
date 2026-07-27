import { describe, it, expect } from 'vitest'

import itParent from '../../messages/it/parentChat.json'
import enParent from '../../messages/en/parentChat.json'
import itTeacher from '../../messages/it/teacherComunicazioni.json'
import enTeacher from '../../messages/en/teacherComunicazioni.json'

// C5 §2 — le stringhe UGC della chat (menu ⋮ segnala/sospendi + banner) devono
// esistere in it ED en, in entrambi i namespaci (parentChat, teacherComunicazioni).
// I componenti condivisi (ChatConversationMenu/ChatSuspensionBanner) ricevono `t`
// dal namespace del contesto: una chiave mancante in un namespace = testo rotto
// solo su una delle due aree.

const UGC_KEYS = [
  'ugcMenuLabel',
  'ugcReportMessage',
  'ugcReportUser',
  'ugcSuspend',
  'ugcReportMessageTitle',
  'ugcReportUserTitle',
  'ugcSuspendTitle',
  'ugcSuspendExplain',
  'ugcSuspendMotivoLabel',
  'ugcSuspendMotivoPlaceholder',
  'ugcSuspendConfirm',
  'ugcSuspendCancel',
  'ugcSuspendSending',
  'ugcSuspendError',
  'ugcSuspendAlready',
  'ugcBannerSuspendedTitle',
  'ugcBannerSuspendedBody',
  'ugcBannerISuspendedTitle',
  'ugcBannerISuspendedBody',
  'ugcBannerMotivo',
  'ugcReopen',
  'ugcReopening',
  'ugcReopenError',
  'ugcTermsBlockedTitle',
  'ugcTermsBlockedBody',
  'ugcTermsBlockedCta',
] as const

const dizionari: Record<string, Record<string, unknown>> = {
  'it/parentChat': itParent as Record<string, unknown>,
  'en/parentChat': enParent as Record<string, unknown>,
  'it/teacherComunicazioni': itTeacher as Record<string, unknown>,
  'en/teacherComunicazioni': enTeacher as Record<string, unknown>,
}

describe('i18n chat UGC — copertura chiavi ugc*', () => {
  for (const [nome, dict] of Object.entries(dizionari)) {
    it(`${nome} espone tutte le chiavi ugc*`, () => {
      for (const k of UGC_KEYS) {
        expect(dict, `${nome} manca "${k}"`).toHaveProperty(k)
        expect(typeof dict[k], `${nome}.${k} deve essere una stringa`).toBe('string')
      }
    })
  }

  it('ugcBannerMotivo porta il placeholder {motivo} in entrambe le lingue', () => {
    expect(itParent.ugcBannerMotivo).toContain('{motivo}')
    expect(enParent.ugcBannerMotivo).toContain('{motivo}')
    expect(itTeacher.ugcBannerMotivo).toContain('{motivo}')
    expect(enTeacher.ugcBannerMotivo).toContain('{motivo}')
  })
})
