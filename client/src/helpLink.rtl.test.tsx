import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelpLink } from './helpLink';

describe('HelpLink', () => {
  it('redirige vers le guide financier depuis la page titres', () => {
    render(
      <MemoryRouter initialEntries={['/titres']}>
        <HelpLink />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Aide' });
    expect(link).toHaveAttribute('href', 'https://kikifunstyle.github.io/TLPE/financier/#titres-recouvrement-et-export');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('redirige vers le guide contribuable depuis la page compte', () => {
    render(
      <MemoryRouter initialEntries={['/compte']}>
        <HelpLink />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Aide' })).toHaveAttribute(
      'href',
      'https://kikifunstyle.github.io/TLPE/contribuable/#connexion-securisee-et-double-authentification',
    );
  });
});
