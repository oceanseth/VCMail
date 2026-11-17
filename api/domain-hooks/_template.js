'use strict';

/**
 * Domain hook template.
 *
 * Copy this file to api/domain-hooks/<your-domain>.js (for example
 * api/domain-hooks/example.com.js), keep the hooks you need, delete the rest,
 * and redeploy the Lambda. The file name is the mail domain, so one Lambda
 * serving several domains can give each its own rules. This template is never
 * loaded: an underscore cannot start a domain name.
 *
 * Hooks run inside the API Lambda, so they can use anything it can: the
 * domain's Firebase app, the AWS SDK, fetch.
 */

module.exports = {
    /**
     * Decide whether a user may claim an address.
     *
     * Called by setupEmail before a NEW address is written. It is not called
     * when the user already holds that address, so existing mailboxes keep
     * working whatever this returns.
     *
     * @param {object} ctx
     * @param {string} ctx.username     requested local part, lower-cased and
     *                                  already format-checked (3-32 characters
     *                                  of a-z 0-9 . _ -)
     * @param {string} ctx.email        username@domain
     * @param {string} ctx.domain       the mail domain
     * @param {string} ctx.uid          Firebase uid of the caller
     * @param {object} ctx.token        the caller's verified Firebase ID token,
     *                                  including any custom claims
     * @param {object} ctx.firebaseApp  firebase-admin app for this domain
     *
     * @returns {{allowed: true} | {allowed: false, error?: string, statusCode?: number}}
     *
     * This hook fails closed. Throwing, taking longer than 12 seconds, or
     * returning anything other than { allowed: true } refuses the address.
     * `error` is shown to the user, so say what they can do instead.
     *
     * Ideas:
     *   - a reserved list (admin, support, postmaster, ...)
     *   - only an address that matches a verified identity, such as a
     *     username the person holds in your own app
     *   - invite-only: allow only uids on a list in your database
     */
    async verifyUsername(ctx) {
        const reserved = new Set(['admin', 'administrator', 'postmaster', 'abuse', 'support']);
        if (reserved.has(ctx.username)) {
            return { allowed: false, error: 'That address is reserved.' };
        }
        return { allowed: true };
    },

    /**
     * Called after a message has been stored in a mailbox on this domain.
     *
     * Use it to notify another system: a webhook, a queue, a second Lambda.
     * It runs once every recipient of the message has been stored, so it
     * cannot hold mail up. Errors are logged and ignored. It is cut off after
     * 5 seconds, and whatever it had not finished by then may be lost, so do
     * one quick call here and hand long work to something asynchronous.
     *
     * @param {object} ctx
     * @param {string} ctx.domain      the mail domain
     * @param {string} ctx.username    recipient local part
     * @param {string} ctx.uid         recipient's Firebase uid
     * @param {string} ctx.emailKey    key of the stored record (emails/{uid}/{emailKey})
     * @param {string} ctx.messageId   key of the raw message in the domain's S3 bucket
     * @param {string} ctx.source      'ses' for mail that arrived from outside,
     *                                 'local' for mail sent between two
     *                                 addresses on this domain, which never
     *                                 passes through SES
     * @param {string} ctx.from
     * @param {string} ctx.to
     * @param {string} ctx.subject
     * @param {number} ctx.timestamp   ms since epoch
     */
    async onEmailStored(ctx) {
        // Example:
        // await fetch('https://example.com/hooks/mail', {
        //     method: 'POST',
        //     headers: { 'Content-Type': 'application/json' },
        //     body: JSON.stringify({ to: ctx.to, from: ctx.from, subject: ctx.subject }),
        //     signal: AbortSignal.timeout(4000)
        // });
    }
};
