/**
 * COME UNA SCHERMATA NOMINA LA PROPRIA CLASSE AL SERVER — in un posto solo.
 *
 * Le route dell'area 0-6 accettano due forme: `sectionId` (l'uuid, l'identità
 * vera) e `sezione` (il nome, che resta per le shell native già installate e per
 * gli URL salvati). La scelta fra le due è sempre la stessa — *se hai l'uuid usa
 * quello* — e sei schermate diverse la facevano ognuna per conto proprio: è il
 * modo in cui una regola valida per due strade si mette a divergere.
 *
 * ⚠️ NON si mandano entrambi. Il server, se vede `sectionId`, ignora il nome e
 * applica `assertSezioneInScope`: mandare anche un nome incoerente non
 * cambierebbe l'esito ma renderebbe illeggibili i log di sicurezza, dove il nome
 * è uno dei pochi campi in lista bianca.
 */
export function parametroClasse(classe: { id?: string | null; name: string }): string {
  return classe.id
    ? `sectionId=${encodeURIComponent(classe.id)}`
    : `sezione=${encodeURIComponent(classe.name)}`
}
