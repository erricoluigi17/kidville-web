import { z } from 'zod'
import { METODI_AMMESSI } from './metodi-ammessi'

/**
 * Lo schema dei metodi ammessi negli ingressi delle route. Sta qui e non
 * nell'helper puro perché `zod` non deve entrare nei componenti client che
 * importano l'helper. Almeno uno, solo valori noti, senza doppioni.
 */
export const zMetodiAmmessi = z
  .array(z.enum(METODI_AMMESSI))
  .min(1, 'Scegli almeno un metodo di pagamento')
  .max(METODI_AMMESSI.length)
  .refine((a) => new Set(a).size === a.length, 'Metodo ripetuto')
