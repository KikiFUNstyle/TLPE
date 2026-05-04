import React from 'react';
import { useLocation } from 'react-router-dom';
import { buildHelpUrl } from './help';

export function HelpLink() {
  const location = useLocation();
  const href = buildHelpUrl(location.pathname);

  return (
    <a className="header-help-link" href={href} target="_blank" rel="noreferrer">
      Aide
    </a>
  );
}
