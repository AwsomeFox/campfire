/**
 * Link from a list (or search) surface into a detail page while capturing list origin
 * for the shared DetailPageWayfinding return link (issue #652).
 */
import { type ComponentProps, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { captureListOrigin } from '../lib/detailListOrigin';

type ListDetailLinkProps = Omit<ComponentProps<typeof Link>, 'state'> & {
  to: string;
};

export function ListDetailLink({
  to,
  onClick,
  target,
  reloadDocument,
  replace,
  relative,
  preventScrollReset,
  download,
  ...rest
}: ListDetailLinkProps) {
  const location = useLocation();
  const navigate = useNavigate();

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (target && target !== '_self') return;
    if (reloadDocument) return;
    if (download != null) return;
    event.preventDefault();
    navigate(to, {
      state: { listOrigin: captureListOrigin(location) },
      replace,
      relative,
      preventScrollReset,
    });
  }

  return (
    <Link
      to={to}
      onClick={handleClick}
      target={target}
      reloadDocument={reloadDocument}
      replace={replace}
      relative={relative}
      preventScrollReset={preventScrollReset}
      download={download}
      {...rest}
    />
  );
}
