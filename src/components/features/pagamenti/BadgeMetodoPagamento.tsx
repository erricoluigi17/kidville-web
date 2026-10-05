import { Badge } from '@/components/ui/Badge';
import { soloUnMetodo } from '@/lib/pagamenti/metodi-ammessi';

/**
 * «Solo contanti» / «Solo bonifico» accanto a una voce. Con entrambi i metodi
 * ammessi — il caso normale — non rende NIENTE: un badge che dice «tutto come
 * sempre» su ogni riga sarebbe rumore. I testi li passa il chiamante, perché
 * segreteria e genitore leggono da due cataloghi diversi.
 *
 * La faccia è quella del `Badge` del design system, tono `warn`: la coppia
 * `warn-soft`/`warn-strong` regge il contrasto AA e si ribalta in Alto Contrasto.
 */
export function BadgeMetodoPagamento({
  metodi, testoSoloContanti, testoSoloBonifico, className,
}: {
  metodi: unknown;
  testoSoloContanti: string;
  testoSoloBonifico: string;
  className?: string;
}) {
  const uno = soloUnMetodo(metodi);
  if (!uno) return null;
  return (
    <Badge tone="warn" className={className} data-testid="badge-metodo-pagamento">
      {uno === 'contanti' ? testoSoloContanti : testoSoloBonifico}
    </Badge>
  );
}
