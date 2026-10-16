'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseEmailContent,
    extractBoundary,
    extractMimePart,
    parseMultipartStructure
} = require('./api.js');

const BOUNDARY = '===============testboundary123==';
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function buildMixedEmail() {
    const b64 = PDF_BYTES.toString('base64');
    return [
        'From: sender@example.com',
        'To: dest@example.com',
        'Subject: application attached',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
        '',
        `--${BOUNDARY}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Attached is the completed application as a PDF.',
        '',
        `--${BOUNDARY}`,
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment;',
        ' filename="BnBMesh_Boundless_SF_Application.pdf"',
        '',
        b64,
        `--${BOUNDARY}--`,
        ''
    ].join('\r\n');
}

function storeWouldParseMultipart(emailData) {
    const originalContentType = emailData.headers['content-type'] || '';
    const extractedContentType = emailData.headers.content_type || '';
    const contentType = originalContentType.includes('multipart/')
        ? originalContentType
        : (extractedContentType || originalContentType);
    return contentType.includes('multipart/');
}

describe('SES ingest attachment preservation', () => {
    it('parseMultipartStructure finds a PDF part that extractMimePart drops', () => {
        const raw = buildMixedEmail();
        const parsed = parseEmailContent(raw);
        const boundary = extractBoundary(parsed.headers['content-type']);
        assert.ok(boundary);

        const stripped = extractMimePart(parsed.body, boundary, true);
        assert.equal(stripped.content_type, 'text/plain');
        assert.equal(stripped.body.includes('%PDF'), false);
        assert.equal(stripped.body.includes('JVBERi0'), false);

        const structure = parseMultipartStructure(parsed.body, boundary);
        assert.equal(structure.attachments.length, 1);
        assert.equal(structure.attachments[0].filename, 'BnBMesh_Boundless_SF_Application.pdf');
        assert.ok(structure.attachments[0].size > 0);
        assert.ok(structure.attachments[0].contentType.includes('application/pdf'));
        const decoded = Buffer.from(structure.attachments[0].content, 'base64');
        assert.equal(decoded.slice(0, 5).toString(), '%PDF-');
    });

    it('old ingest overwrite made storeEmailForUser skip multipart parsing', () => {
        const raw = buildMixedEmail();
        const emailData = parseEmailContent(raw);
        const boundary = extractBoundary(emailData.headers['content-type']);
        const { body, content_type } = extractMimePart(emailData.body, boundary, true);
        emailData.body = body;
        emailData.headers.content_type = content_type;

        const legacyType = emailData.headers.content_type || emailData.headers['content-type'] || '';
        assert.equal(legacyType.includes('multipart/'), false);
        assert.equal(legacyType, 'text/plain');
    });

    it('new ingest keeps raw MIME so storeEmailForUser parses attachments', () => {
        const raw = buildMixedEmail();
        const emailData = parseEmailContent(raw);
        assert.equal(storeWouldParseMultipart(emailData), true);

        const boundary = extractBoundary(emailData.headers['content-type']);
        const structure = parseMultipartStructure(emailData.body, boundary);
        assert.equal(structure.attachments.length, 1);
        assert.equal(structure.preferredContent.type, 'text/plain');
        assert.match(structure.preferredContent.content, /Attached is the completed application/);
    });
});
