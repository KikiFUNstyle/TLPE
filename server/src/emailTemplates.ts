import * as fs from 'node:fs';
import * as path from 'node:path';

import Handlebars = require('handlebars');

import { db } from './db';

export const DEFAULT_EMAIL_TEMPLATE_CODES = [
  'invitation_campagne',
  'relance_declaration',
  'mise_en_demeure_auto',
  'accuse_reception_declaration',
  'titre_emis',
  'paiement_recu',
  'decision_contentieuse',
  'alerte_contentieux',
] as const;

export type EmailTemplateCode = (typeof DEFAULT_EMAIL_TEMPLATE_CODES)[number];

type TemplatePart = 'subject' | 'html' | 'text';

type TemplateSource = {
  subject: string;
  html: string;
  text: string;
  source: 'default' | 'override';
};

export type EmailTemplateContext = Record<string, unknown>;

export interface RenderEmailTemplateInput {
  templateCode: string;
  context: EmailTemplateContext;
}

export interface RenderedEmailTemplate {
  subject: string;
  html: string;
  text: string;
  source: 'default' | 'override';
}

export interface PreviewEmailTemplateInput {
  templateCode: string;
  context?: EmailTemplateContext;
}

type EmailTemplateOverrideRow = {
  subject_template: string;
  html_template: string;
  text_template: string;
};

const HANDLEBARS_HTML = Handlebars.create();
const HANDLEBARS_TEXT = Handlebars.create();
const HANDLEBARS_SUBJECT = Handlebars.create();

function isKnownTemplateCode(templateCode: string): templateCode is EmailTemplateCode {
  return (DEFAULT_EMAIL_TEMPLATE_CODES as readonly string[]).includes(templateCode);
}

function resolveTemplatesDirectory(currentDir = __dirname) {
  const candidates = [
    path.join(currentDir, 'templates', 'emails'),
    path.resolve(currentDir, '..', 'src', 'templates', 'emails'),
  ];
  const templateDir = candidates.find((candidate) => fs.existsSync(candidate));
  if (!templateDir) {
    throw new Error(`Répertoire des templates email introuvable. Chemins testés: ${candidates.join(', ')}`);
  }
  return templateDir;
}

function readDefaultTemplatePart(templateCode: EmailTemplateCode, part: TemplatePart) {
  const filePath = path.join(resolveTemplatesDirectory(), `${templateCode}.${part}.hbs`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fichier de template email introuvable: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function getDefaultTemplateSource(templateCode: EmailTemplateCode): TemplateSource {
  return {
    subject: readDefaultTemplatePart(templateCode, 'subject'),
    html: readDefaultTemplatePart(templateCode, 'html'),
    text: readDefaultTemplatePart(templateCode, 'text'),
    source: 'default',
  };
}

function getOverrideTemplateSource(templateCode: EmailTemplateCode): TemplateSource | null {
  const row = db
    .prepare(
      `SELECT subject_template, html_template, text_template
       FROM email_templates
       WHERE code = ?
       LIMIT 1`,
    )
    .get(templateCode) as EmailTemplateOverrideRow | undefined;

  if (!row) return null;

  return {
    subject: row.subject_template,
    html: row.html_template,
    text: row.text_template,
    source: 'override',
  };
}

function resolveTemplateSource(templateCode: EmailTemplateCode): TemplateSource {
  return getOverrideTemplateSource(templateCode) ?? getDefaultTemplateSource(templateCode);
}

function compileTemplate(source: string, context: EmailTemplateContext, part: TemplatePart) {
  const engine = part === 'html'
    ? HANDLEBARS_HTML
    : part === 'text'
      ? HANDLEBARS_TEXT
      : HANDLEBARS_SUBJECT;
  const template = engine.compile(source, {
    strict: true,
    noEscape: part !== 'html',
  });
  return template(context, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
  });
}

function getPreviewContext(templateCode: EmailTemplateCode): EmailTemplateContext {
  return {
    collectivite: 'Ville de Test',
    service: 'Service TLPE',
    campagne_annee: 2026,
    annee: 2026,
    identifiant: 'TLPE-EXEMPLE-001',
    identifiant_tlpe: 'TLPE-EXEMPLE-001',
    raison_sociale: 'Exemple Affichage',
    numero_declaration: 'DEC-2026-001',
    numero_titre: 'T-2026-001',
    numero_paiement: 'PAY-2026-001',
    numero_contentieux: 'CONT-2026-001',
    date_limite_declaration: '2026-05-31',
    date_reception: '2026-05-06',
    date_emission: '2026-06-15',
    date_paiement: '2026-06-20',
    date_decision: '2026-07-01',
    date_echeance: '2026-07-15',
    echeance: '2026-07-15',
    niveau_relance: 'J-15',
    niveau_alerte: 'J-7',
    montant: '1 250,00 €',
    lien: `https://portail.tlpe.test/templates/${templateCode}`,
    portail_url: 'https://portail.tlpe.test/login',
    motif_decision: 'Réclamation rejetée faute de pièces justificatives suffisantes.',
    statut_contentieux: 'instruction',
    days_remaining: 7,
    delai_depasse_jours: 3,
  };
}

export function listDefaultEmailTemplateCodes(): EmailTemplateCode[] {
  return [...DEFAULT_EMAIL_TEMPLATE_CODES];
}

export function renderEmailTemplate(input: RenderEmailTemplateInput): RenderedEmailTemplate {
  if (!isKnownTemplateCode(input.templateCode)) {
    throw new Error(`Template email inconnu: ${input.templateCode}`);
  }

  const source = resolveTemplateSource(input.templateCode);
  return {
    subject: compileTemplate(source.subject, input.context, 'subject'),
    html: compileTemplate(source.html, input.context, 'html'),
    text: compileTemplate(source.text, input.context, 'text'),
    source: source.source,
  };
}

export function previewEmailTemplate(input: PreviewEmailTemplateInput): RenderedEmailTemplate {
  if (!isKnownTemplateCode(input.templateCode)) {
    throw new Error(`Template email inconnu: ${input.templateCode}`);
  }

  return renderEmailTemplate({
    templateCode: input.templateCode,
    context: {
      ...getPreviewContext(input.templateCode),
      ...(input.context ?? {}),
    },
  });
}