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
  description: string | null;
  source: 'default' | 'override';
  updatedBy: number | null;
  updatedAt: string | null;
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

export interface EmailTemplateDefinition {
  code: EmailTemplateCode;
  subject_template: string;
  html_template: string;
  text_template: string;
  description: string | null;
  source: 'default' | 'override';
  updated_by: number | null;
  updated_at: string | null;
  available_variables: string[];
}

type EmailTemplateOverrideRow = {
  subject_template: string;
  html_template: string;
  text_template: string;
  description: string | null;
  updated_by: number | null;
  updated_at: string | null;
};

export interface UpsertEmailTemplateOverrideInput {
  templateCode: string;
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate: string;
  description?: string | null;
  updatedBy?: number | null;
}

const HANDLEBARS_HTML = Handlebars.create();
const HANDLEBARS_TEXT = Handlebars.create();
const HANDLEBARS_SUBJECT = Handlebars.create();

function isKnownTemplateCode(templateCode: string): templateCode is EmailTemplateCode {
  return (DEFAULT_EMAIL_TEMPLATE_CODES as readonly string[]).includes(templateCode);
}

function assertKnownTemplateCode(templateCode: string): EmailTemplateCode {
  if (!isKnownTemplateCode(templateCode)) {
    throw new Error(`Template email inconnu: ${templateCode}`);
  }
  return templateCode;
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
    description: null,
    source: 'default',
    updatedBy: null,
    updatedAt: null,
  };
}

function getOverrideTemplateSource(templateCode: EmailTemplateCode): TemplateSource | null {
  const row = db
    .prepare(
      `SELECT subject_template, html_template, text_template, description, updated_by, updated_at
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
    description: row.description ?? null,
    source: 'override',
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
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

function validateTemplateSource(subjectTemplate: string, htmlTemplate: string, textTemplate: string) {
  HANDLEBARS_SUBJECT.parse(subjectTemplate);
  HANDLEBARS_HTML.parse(htmlTemplate);
  HANDLEBARS_TEXT.parse(textTemplate);
}

function getPreviewContext(templateCode: EmailTemplateCode): EmailTemplateContext {
  return {
    collectivite: 'Ville de Test',
    service: 'Service TLPE',
    service_label: 'Service: Service TLPE',
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

function getTemplateVariables(templateCode: EmailTemplateCode): string[] {
  return Object.keys(getPreviewContext(templateCode)).sort();
}

export function listDefaultEmailTemplateCodes(): EmailTemplateCode[] {
  return [...DEFAULT_EMAIL_TEMPLATE_CODES];
}

export function getEmailTemplateDefinition(templateCode: string): EmailTemplateDefinition {
  const knownTemplateCode = assertKnownTemplateCode(templateCode);
  const source = resolveTemplateSource(knownTemplateCode);
  return {
    code: knownTemplateCode,
    subject_template: source.subject,
    html_template: source.html,
    text_template: source.text,
    description: source.description,
    source: source.source,
    updated_by: source.updatedBy,
    updated_at: source.updatedAt,
    available_variables: getTemplateVariables(knownTemplateCode),
  };
}

export function listEmailTemplateDefinitions(): EmailTemplateDefinition[] {
  return listDefaultEmailTemplateCodes().map((code) => getEmailTemplateDefinition(code));
}

export function upsertEmailTemplateOverride(input: UpsertEmailTemplateOverrideInput): EmailTemplateDefinition {
  const knownTemplateCode = assertKnownTemplateCode(input.templateCode);
  validateTemplateSource(input.subjectTemplate, input.htmlTemplate, input.textTemplate);

  db.prepare(
    `INSERT INTO email_templates (code, subject_template, html_template, text_template, description, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(code) DO UPDATE SET
       subject_template = excluded.subject_template,
       html_template = excluded.html_template,
       text_template = excluded.text_template,
       description = excluded.description,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  ).run(
    knownTemplateCode,
    input.subjectTemplate,
    input.htmlTemplate,
    input.textTemplate,
    input.description ?? null,
    input.updatedBy ?? null,
  );

  return getEmailTemplateDefinition(knownTemplateCode);
}

export function resetEmailTemplateOverride(templateCode: string): EmailTemplateDefinition {
  const knownTemplateCode = assertKnownTemplateCode(templateCode);
  db.prepare('DELETE FROM email_templates WHERE code = ?').run(knownTemplateCode);
  return getEmailTemplateDefinition(knownTemplateCode);
}

export function renderEmailTemplate(input: RenderEmailTemplateInput): RenderedEmailTemplate {
  const knownTemplateCode = assertKnownTemplateCode(input.templateCode);
  const source = resolveTemplateSource(knownTemplateCode);
  return {
    subject: compileTemplate(source.subject, input.context, 'subject'),
    html: compileTemplate(source.html, input.context, 'html'),
    text: compileTemplate(source.text, input.context, 'text'),
    source: source.source,
  };
}

export function previewEmailTemplate(input: PreviewEmailTemplateInput): RenderedEmailTemplate {
  const knownTemplateCode = assertKnownTemplateCode(input.templateCode);

  return renderEmailTemplate({
    templateCode: knownTemplateCode,
    context: {
      ...getPreviewContext(knownTemplateCode),
      ...(input.context ?? {}),
    },
  });
}
