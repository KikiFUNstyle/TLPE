import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mkdocsPath = path.join(repoRoot, 'mkdocs.yml');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'docs.yml');

const requiredPages = [
  'docs/index.md',
  'docs/installation.md',
  'docs/agents.md',
  'docs/financier.md',
  'docs/controleur.md',
  'docs/contribuable.md',
  'docs/administrateur.md',
];

test('la documentation utilisateur MkDocs référence les sections attendues, active l’export PDF et prépare le déploiement GitHub Pages', () => {
  assert.ok(fs.existsSync(mkdocsPath), 'mkdocs.yml doit exister à la racine du dépôt');
  const config = fs.readFileSync(mkdocsPath, 'utf8');
  assert.ok(fs.existsSync(workflowPath), 'Le workflow docs.yml doit exister pour le déploiement automatique');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(config, /site_name:\s*TLPE Manager/i);
  assert.match(config, /theme:\s*[\s\S]*name:\s*material/i);
  assert.match(config, /pdf-export/i);
  assert.match(config, /Agents/i);
  assert.match(config, /Financier/i);
  assert.match(config, /Contrôleur/i);
  assert.match(config, /Contribuable/i);
  assert.match(config, /Administrateur/i);
  assert.match(config, /Administrateur/i);
  assert.match(workflow, /actions\/deploy-pages@v4/i);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/i);
  assert.match(workflow, /mkdocs build --strict/i);

  for (const relativePath of requiredPages) {
    const absolutePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(absolutePath), `Page manquante: ${relativePath}`);
  }
});

test('chaque guide rôle/installation référence au moins une capture ou illustration annotée', () => {
  for (const relativePath of requiredPages.slice(1)) {
    const absolutePath = path.join(repoRoot, relativePath);
    const content = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
    assert.match(content, /!\[[^\]]+\]\([^\)]+\)/, `Illustration annotée manquante dans ${relativePath}`);
  }
});
