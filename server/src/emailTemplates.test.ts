import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type EmailTemplateCode =
  | 'invitation_campagne'
  | 'relance_declaration'
  | 'mise_en_demeure_auto'
  | 'accuse_reception_declaration'
  | 'titre_emis'
  | 'paiement_recu'
  | 'decision_contentieuse'
  | 'alerte_contentieux';

const EXPECTED_TEMPLATE_CODES: EmailTemplateCode[] = [
  'invitation_campagne',
  'relance_declaration',
  'mise_en_demeure_auto',
  'accuse_reception_declaration',
  'titre_emis',
  'paiement_recu',
  'decision_contentieuse',
  'alerte_contentieux',
];

const TEMPLATE_DIR = path.join(__dirname, 'templates', 'emails');
const EMAIL_TEMPLATE_TEST_MODULES = ['./db', './emailTemplates'] as const;

type EmailTemplatesTestContext = {
  db: typeof import('./db').db;
  initSchema: typeof import('./db').initSchema;
  listDefaultEmailTemplateCodes: typeof import('./emailTemplates').listDefaultEmailTemplateCodes;
  previewEmailTemplate: typeof import('./emailTemplates').previewEmailTemplate;
  renderEmailTemplate: typeof import('./emailTemplates').renderEmailTemplate;
  cleanup: () => void;
};

function clearEmailTemplateModuleCache() {
  for (const modulePath of EMAIL_TEMPLATE_TEST_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // ignore cache misses during cleanup
    }
  }
}

function createEmailTemplatesTestContext(): EmailTemplatesTestContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlpe-email-templates-test-'));
  const dbPath = path.join(tempDir, 'tlpe.db');
  const previousDbPath = process.env.TLPE_DB_PATH;
  process.env.TLPE_DB_PATH = dbPath;
  clearEmailTemplateModuleCache();

  const dbModule = require('./db') as typeof import('./db');
  const emailTemplatesModule = require('./emailTemplates') as typeof import('./emailTemplates');

  return {
    db: dbModule.db,
    initSchema: dbModule.initSchema,
    listDefaultEmailTemplateCodes: emailTemplatesModule.listDefaultEmailTemplateCodes,
    previewEmailTemplate: emailTemplatesModule.previewEmailTemplate,
    renderEmailTemplate: emailTemplatesModule.renderEmailTemplate,
    cleanup: () => {
      try {
        dbModule.db.close();
      } catch {
        // ignore close errors during teardown
      }
      clearEmailTemplateModuleCache();
      if (previousDbPath === undefined) {
        delete process.env.TLPE_DB_PATH;
      } else {
        process.env.TLPE_DB_PATH = previousDbPath;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function withEmailTemplatesTestContext(run: (ctx: EmailTemplatesTestContext) => Promise<void> | void) {
  const ctx = createEmailTemplatesTestContext();
  try {
    await run(ctx);
  } finally {
    ctx.cleanup();
  }
}

test('default email templates exist on disk for each expected template code', async () => {
  await withEmailTemplatesTestContext((ctx) => {
    assert.deepEqual(ctx.listDefaultEmailTemplateCodes(), EXPECTED_TEMPLATE_CODES);
    for (const code of EXPECTED_TEMPLATE_CODES) {
      for (const kind of ['subject', 'html', 'text'] as const) {
        const filePath = path.join(TEMPLATE_DIR, `${code}.${kind}.hbs`);
        assert.equal(fs.existsSync(filePath), true, `template file missing: ${filePath}`);
      }
    }
  });
});

test('previewEmailTemplate renders every default template with a stable sample context', async () => {
  await withEmailTemplatesTestContext((ctx) => {
    ctx.initSchema();

    for (const code of EXPECTED_TEMPLATE_CODES) {
      const preview = ctx.previewEmailTemplate({ templateCode: code });
      const combined = `${preview.subject}\n${preview.html}\n${preview.text}`;
      assert.ok(preview.subject.length > 0, `subject vide pour ${code}`);
      assert.ok(preview.html.length > 0, `html vide pour ${code}`);
      assert.ok(preview.text.length > 0, `text vide pour ${code}`);
      assert.doesNotMatch(combined, /\{\{/);
      assert.match(combined, /Exemple Affichage|https:\/\/portail\.tlpe\.test\/templates\//);
    }
  });
});

test('renderEmailTemplate uses database overrides before default files and escapes HTML while keeping text readable', async () => {
  await withEmailTemplatesTestContext((ctx) => {
    ctx.initSchema();
    ctx.db.prepare(
      `INSERT INTO email_templates (code, subject_template, html_template, text_template)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'invitation_campagne',
      'Sujet override {{raison_sociale}}',
      '<p>{{raison_sociale}}</p><p>{{lien}}</p>',
      'Texte brut {{raison_sociale}} :: {{lien}}',
    );

    const unsafeCompanyName = 'Société <script>alert("x")</script>';
    const unsafeLink = 'https://portail.tlpe.test/invitation/unsafe?token=redacted';

    const result = ctx.renderEmailTemplate({
      templateCode: 'invitation_campagne',
      context: {
        raison_sociale: unsafeCompanyName,
        lien: unsafeLink,
      },
    });

    assert.equal(result.source, 'override');
    assert.equal(result.subject, `Sujet override ${unsafeCompanyName}`);
    assert.match(result.html, /Société &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(result.html, /<script>alert\("x"\)<\/script>/);
    assert.equal(result.text, `Texte brut ${unsafeCompanyName} :: ${unsafeLink}`);
  });
});

test('renderEmailTemplate throws an explicit error when template code is unknown', async () => {
  await withEmailTemplatesTestContext((ctx) => {
    ctx.initSchema();
    assert.throws(
      () => ctx.renderEmailTemplate({ templateCode: 'template_inexistant', context: {} }),
      /Template email inconnu: template_inexistant/,
    );
  });
});
