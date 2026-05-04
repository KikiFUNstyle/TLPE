export const docsBaseUrl = 'https://kikifunstyle.github.io/TLPE/';

const routeToHelpPath: Array<[prefix: string, docsPath: string]> = [
  ['/assujettis', 'agents/#gestion-des-assujettis-et-dispositifs'],
  ['/dispositifs', 'agents/#gestion-des-assujettis-et-dispositifs'],
  ['/declarations', 'agents/#declarations-et-campagnes'],
  ['/titres', 'financier/#titres-recouvrement-et-export'],
  ['/rapprochement', 'financier/#rapprochement-bancaire'],
  ['/recouvrement', 'financier/#titres-recouvrement-et-export'],
  ['/comparatif', 'financier/#titres-recouvrement-et-export'],
  ['/recettes-geographiques', 'financier/#titres-recouvrement-et-export'],
  ['/exports-personnalises', 'administrateur/#supervision-et-audit'],
  ['/audit-log', 'administrateur/#supervision-et-audit'],
  ['/relances', 'agents/#declarations-et-campagnes'],
  ['/contentieux', 'agents/#contentieux-et-pieces-jointes'],
  ['/controles', 'controleur/#constats-terrain-et-pieces-jointes'],
  ['/carte', 'controleur/#constats-terrain-et-pieces-jointes'],
  ['/simulateur', 'contribuable/#simulation-declaration-et-suivi'],
  ['/compte', 'contribuable/#connexion-securisee-et-double-authentification'],
  ['/referentiels', 'administrateur/#referentiels-parametrage-et-sauvegarde'],
  ['/login', 'contribuable/#connexion-securisee-et-double-authentification'],
  ['/', 'agents/'],
];

export function buildHelpUrl(pathname: string): string {
  const match = routeToHelpPath.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!match) return docsBaseUrl;
  return new URL(match[1], docsBaseUrl).toString();
}
