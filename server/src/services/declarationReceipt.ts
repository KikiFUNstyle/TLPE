import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as PDFKit from 'pdfkit';
const PDFDocument = (PDFKit as unknown as { default?: typeof PDFKit; new (...args: any[]): any }).default ?? (PDFKit as unknown as any);
import QRCode from 'qrcode';
import { db } from '../db';

interface DeclarationReceiptPayload {
  declarationId: number;
  numeroDeclaration: string;
  assujetti: {
    id: number;
    identifiantTlpe: string;
    raisonSociale: string;
    email: string | null;
  };
  submittedAtUtc: string;
  submittedAtLocal: string;
  payloadHash: string;
  lignes: Array<{
    dispositifIdentifiant: string;
    typeLibelle: string;
    categorie: string;
    surfaceDeclaree: number;
    nombreFaces: number;
    adresseRue: string | null;
    adresseCp: string | null;
    adresseVille: string | null;
  }>;
}

interface ExistingReceipt {
  verification_token: string;
  payload_hash: string;
  pdf_path: string;
  generated_at: string;
}

export interface DeclarationReceiptResult {
  declarationId: number;
  verificationToken: string;
  payloadHash: string;
  pdfRelativePath: string;
  publicVerificationUrl: string;
  generatedAt: string;
  emailStatus: 'pending' | 'envoye' | 'echec';
  emailError: string | null;
  emailSentAt: string | null;
}

const CLIENT_BASE_URL = (process.env.TLPE_PORTAL_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const RECEIPTS_RELATIVE_DIR = path.join('receipts', 'declarations');
const RECEIPTS_ABSOLUTE_DIR = path.resolve(__dirname, '..', '..', 'data', RECEIPTS_RELATIVE_DIR);

function ensureReceiptsDirectory() {
  fs.mkdirSync(RECEIPTS_ABSOLUTE_DIR, { recursive: true });
}

function buildVerificationUrl(token: string): string {
  return `${CLIENT_BASE_URL}/verification/accuse/${token}`;
}

function parseSubmittedAtUtc(rawValue: string): Date {
  const trimmed = rawValue.trim();
  if (!trimmed) return new Date(NaN);

  // SQLite datetime('now') retourne "YYYY-MM-DD HH:MM:SS" sans suffixe timezone.
  // Dans notre schéma, on le traite explicitement comme UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed.replace(' ', 'T')}Z`);
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}Z`);
  }

  return new Date(trimmed);
}

function formatUtcTimestamp(isoUtc: string): string {
  const date = parseSubmittedAtUtc(isoUtc);
  return `${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`;
}

function formatParisTimestamp(isoUtc: string): string {
  const date = parseSubmittedAtUtc(isoUtc);
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return formatter.format(date);
}

function createVerificationToken(declarationId: number, payloadHash: string): string {
  const random = crypto.randomBytes(16).toString('hex');
  return `${declarationId}-${payloadHash.slice(0, 12)}-${random}`;
}

function renderTableHeader(doc: any, startY: number, columns: Array<{ label: string; x: number; w: number }>): number {
  doc.fontSize(9).fillColor('#111827');
  columns.forEach((col) => doc.text(col.label, col.x, startY, { width: col.w }));
  doc.moveTo(42, startY + 13).lineTo(552, startY + 13).stroke();
  return startY + 18;
}

async function generateReceiptPdf(params: {
  payload: DeclarationReceiptPayload;
  verificationToken: string;
  outputAbsolutePath: string;
}): Promise<void> {
  const { payload, verificationToken, outputAbsolutePath } = params;
  const verificationUrl = buildVerificationUrl(verificationToken);
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 180,
  });

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    const stream = fs.createWriteStream(outputAbsolutePath);
    stream.on('finish', () => resolve());
    stream.on('error', (err: Error) => reject(err));
    doc.on('error', (err: Error) => reject(err));
    doc.pipe(stream);

    doc.fontSize(18).text('Accusé de réception de déclaration TLPE', { align: 'center' });
    doc.moveDown(0.25);
    doc.fontSize(10).fillColor('#4b5563').text('Preuve de dépôt horodatée (US3.6)', { align: 'center' });
    doc.fillColor('black');
    doc.moveDown(1);

    doc.fontSize(11).text(`Numéro de déclaration : ${payload.numeroDeclaration}`);
    doc.text(`Identité déclarant : ${payload.assujetti.raisonSociale} (${payload.assujetti.identifiantTlpe})`);
    doc.text(`Horodatage UTC : ${payload.submittedAtUtc}`);
    doc.text(`Horodatage Europe/Paris : ${payload.submittedAtLocal}`);
    doc.text(`Hash SHA-256 du payload : ${payload.payloadHash}`);
    doc.text(`Jeton de vérification : ${verificationToken}`);
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#374151').text(`Vérification publique : ${verificationUrl}`);
    doc.fillColor('black');
    doc.moveDown(1);

    const tableHeaderY = doc.y;
    const cols = [
      { label: 'Dispositif', x: 42, w: 82 },
      { label: 'Type', x: 124, w: 118 },
      { label: 'Cat.', x: 242, w: 55 },
      { label: 'Surf.', x: 297, w: 45 },
      { label: 'Faces', x: 342, w: 38 },
      { label: 'Adresse', x: 380, w: 172 },
    ];

    let y = renderTableHeader(doc, tableHeaderY, cols);
    for (const line of payload.lignes) {
      const adresse = [line.adresseRue, [line.adresseCp, line.adresseVille].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '-';
      const lineHeight = 26;
      if (y + lineHeight > 760) {
        doc.addPage();
        y = renderTableHeader(doc, 52, cols);
      }
      doc.fontSize(8.5);
      doc.text(line.dispositifIdentifiant, cols[0].x, y, { width: cols[0].w });
      doc.text(line.typeLibelle, cols[1].x, y, { width: cols[1].w });
      doc.text(line.categorie, cols[2].x, y, { width: cols[2].w });
      doc.text(line.surfaceDeclaree.toFixed(2), cols[3].x, y, { width: cols[3].w });
      doc.text(String(line.nombreFaces), cols[4].x, y, { width: cols[4].w });
      doc.text(adresse, cols[5].x, y, { width: cols[5].w });
      y += lineHeight;
    }

    doc.moveTo(42, y + 2).lineTo(552, y + 2).stroke();

    const qrBuffer = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const qrY = Math.min(Math.max(y + 14, 560), 700);
    doc.image(qrBuffer, 42, qrY, { width: 96, height: 96 });
    doc.fontSize(9).fillColor('#374151').text('Scannez pour vérifier le hash et l’intégrité du dépôt.', 146, qrY + 16, { width: 320 });
    doc.text('Conserver ce document pour toute contestation de délai.', 146, qrY + 34, { width: 320 });

    doc.end();
  });
}

function normalizeStoredPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function buildDownloadUrl(relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/declarations/receipts/${encoded}`;
}

function maybeSendReceiptEmail(params: {
  declarationId: number;
  assujettiEmail: string | null;
  numeroDeclaration: string;
  payloadHash: string;
  verificationToken: string;
  receiptAbsolutePath: string;
}): { status: 'pending' | 'envoye' | 'echec'; error: string | null; sentAt: string | null } {
  const mode = process.env.TLPE_EMAIL_DELIVERY_MODE ?? 'disabled';
  if (!params.assujettiEmail || params.assujettiEmail.trim() === '') {
    return { status: 'echec', error: 'Email assujetti manquant', sentAt: null };
  }

  if (mode === 'mock-success') {
    return { status: 'envoye', error: null, sentAt: new Date().toISOString() };
  }

  if (mode === 'mock-failure') {
    return { status: 'echec', error: "Echec d'envoi (mode mock-failure)", sentAt: null };
  }

  // MVP: SMTP réel livré en US11.x. On enregistre l'attachement prêt pour envoi différé.
  if (!fs.existsSync(params.receiptAbsolutePath)) {
    return { status: 'echec', error: 'Pièce jointe introuvable', sentAt: null };
  }

  return {
    status: 'pending',
    error: 'Envoi différé: service SMTP non configuré',
    sentAt: null,
  };
}

export async function ensureDeclarationReceipt(input: {
  declarationId: number;
  numeroDeclaration: string;
  payloadHash: string;
  generatedBy: number | null;
  submittedAtIsoUtc: string;
  assujetti: {
    id: number;
    identifiantTlpe: string;
    raisonSociale: string;
    email: string | null;
  };
  lignes: DeclarationReceiptPayload['lignes'];
}): Promise<DeclarationReceiptResult> {
  const existing = db
    .prepare(
      `SELECT verification_token, payload_hash, pdf_path, generated_at, email_status, email_error, email_sent_at
       FROM declaration_receipts
       WHERE declaration_id = ?`,
    )
    .get(input.declarationId) as
    | (ExistingReceipt & { email_status: 'pending' | 'envoye' | 'echec'; email_error: string | null; email_sent_at: string | null })
    | undefined;

  if (existing && existing.payload_hash === input.payloadHash) {
    return {
      declarationId: input.declarationId,
      verificationToken: existing.verification_token,
      payloadHash: existing.payload_hash,
      pdfRelativePath: existing.pdf_path,
      publicVerificationUrl: buildVerificationUrl(existing.verification_token),
      generatedAt: existing.generated_at,
      emailStatus: existing.email_status,
      emailError: existing.email_error,
      emailSentAt: existing.email_sent_at,
    };
  }

  ensureReceiptsDirectory();
  const verificationToken = createVerificationToken(input.declarationId, input.payloadHash);
  const relativePath = normalizeStoredPath(path.join(RECEIPTS_RELATIVE_DIR, `${verificationToken}.pdf`));
  const absolutePath = path.resolve(__dirname, '..', '..', 'data', relativePath);

  await generateReceiptPdf({
    payload: {
      declarationId: input.declarationId,
      numeroDeclaration: input.numeroDeclaration,
      assujetti: input.assujetti,
      submittedAtUtc: formatUtcTimestamp(input.submittedAtIsoUtc),
      submittedAtLocal: formatParisTimestamp(input.submittedAtIsoUtc),
      payloadHash: input.payloadHash,
      lignes: input.lignes,
    },
    verificationToken,
    outputAbsolutePath: absolutePath,
  });

  const emailResult = maybeSendReceiptEmail({
    declarationId: input.declarationId,
    assujettiEmail: input.assujetti.email,
    numeroDeclaration: input.numeroDeclaration,
    payloadHash: input.payloadHash,
    verificationToken,
    receiptAbsolutePath: absolutePath,
  });

  db.prepare(
    `INSERT INTO declaration_receipts (
      declaration_id, verification_token, payload_hash, pdf_path, generated_by, email_status, email_error, email_sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(declaration_id) DO UPDATE SET
      verification_token = excluded.verification_token,
      payload_hash = excluded.payload_hash,
      pdf_path = excluded.pdf_path,
      generated_by = excluded.generated_by,
      generated_at = datetime('now'),
      email_status = excluded.email_status,
      email_error = excluded.email_error,
      email_sent_at = excluded.email_sent_at`,
  ).run(
    input.declarationId,
    verificationToken,
    input.payloadHash,
    relativePath,
    input.generatedBy,
    emailResult.status,
    emailResult.error,
    emailResult.sentAt,
  );

  const created = db
    .prepare(
      `SELECT generated_at, email_status, email_error, email_sent_at
       FROM declaration_receipts
       WHERE declaration_id = ?`,
    )
    .get(input.declarationId) as {
    generated_at: string;
    email_status: 'pending' | 'envoye' | 'echec';
    email_error: string | null;
    email_sent_at: string | null;
  };

  return {
    declarationId: input.declarationId,
    verificationToken,
    payloadHash: input.payloadHash,
    pdfRelativePath: relativePath,
    publicVerificationUrl: buildVerificationUrl(verificationToken),
    generatedAt: created.generated_at,
    emailStatus: created.email_status,
    emailError: created.email_error,
    emailSentAt: created.email_sent_at,
  };
}

export function getReceiptDownloadPath(relativePath: string): string {
  return path.resolve(__dirname, '..', '..', 'data', relativePath);
}

export function createReceiptDownloadUrl(relativePath: string): string {
  return buildDownloadUrl(relativePath);
}

export function getDeclarationReceiptByToken(token: string): null | {
  declaration_id: number;
  verification_token: string;
  payload_hash: string;
  generated_at: string;
  numero: string;
  assujetti_raison_sociale: string;
  assujetti_identifiant_tlpe: string;
  date_soumission: string | null;
} {
  return (
    db
      .prepare(
        `SELECT
          r.declaration_id,
          r.verification_token,
          r.payload_hash,
          r.generated_at,
          d.numero,
          a.raison_sociale AS assujetti_raison_sociale,
          a.identifiant_tlpe AS assujetti_identifiant_tlpe,
          d.date_soumission
         FROM declaration_receipts r
         JOIN declarations d ON d.id = r.declaration_id
         JOIN assujettis a ON a.id = d.assujetti_id
         WHERE r.verification_token = ?`,
      )
      .get(token) as {
      declaration_id: number;
      verification_token: string;
      payload_hash: string;
      generated_at: string;
      numero: string;
      assujetti_raison_sociale: string;
      assujetti_identifiant_tlpe: string;
      date_soumission: string | null;
    } | undefined
  ) ?? null;
}

export function getDeclarationReceiptRecord(declarationId: number): null | {
  verification_token: string;
  payload_hash: string;
  pdf_path: string;
  generated_at: string;
  email_status: 'pending' | 'envoye' | 'echec';
  email_error: string | null;
  email_sent_at: string | null;
} {
  return (
    db
      .prepare(
        `SELECT verification_token, payload_hash, pdf_path, generated_at, email_status, email_error, email_sent_at
         FROM declaration_receipts
         WHERE declaration_id = ?`,
      )
      .get(declarationId) as {
      verification_token: string;
      payload_hash: string;
      pdf_path: string;
      generated_at: string;
      email_status: 'pending' | 'envoye' | 'echec';
      email_error: string | null;
      email_sent_at: string | null;
    } | undefined
  ) ?? null;
}
