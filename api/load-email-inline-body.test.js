'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    shouldInlineEmailBody,
    inlineEmailBodyFromS3,
    EMAIL_BODY_INLINE_MAX_BYTES
} = require('./api.js');

describe('loadEmail body inlining', () => {
    it('inlines typical HTML bodies and skips empty or huge objects', () => {
        assert.equal(shouldInlineEmailBody(14161), true);
        assert.equal(shouldInlineEmailBody(0), false);
        assert.equal(shouldInlineEmailBody(EMAIL_BODY_INLINE_MAX_BYTES), true);
        assert.equal(shouldInlineEmailBody(EMAIL_BODY_INLINE_MAX_BYTES + 1), false);
    });

    it('reads UTF-8 body from S3 when the declared size is under the cap', async () => {
        const html = '<html><body>Invoice INV-0233</body></html>';
        const s3Client = {
            async send(command) {
                assert.equal(command.constructor.name, 'GetObjectCommand');
                assert.equal(command.input.Bucket, 'masky-ai-mail-inbox');
                assert.equal(command.input.Key, 'emails/user/email_1/body');
                return {
                    Body: {
                        transformToString: async () => html
                    }
                };
            }
        };
        const body = await inlineEmailBodyFromS3(
            s3Client,
            'masky-ai-mail-inbox',
            'emails/user/email_1/body',
            html.length
        );
        assert.equal(body, html);
    });

    it('does not GetObject when the body is over the inline cap', async () => {
        let called = false;
        const s3Client = {
            async send() {
                called = true;
                throw new Error('should not GetObject');
            }
        };
        const body = await inlineEmailBodyFromS3(
            s3Client,
            'masky-ai-mail-inbox',
            'emails/user/email_1/body',
            EMAIL_BODY_INLINE_MAX_BYTES + 1
        );
        assert.equal(body, null);
        assert.equal(called, false);
    });
});
