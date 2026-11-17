'use strict';

/**
 * masky.ai hooks.
 *
 * Addresses on masky.ai belong to Masky accounts and avatars, so the Masky API
 * owns the rules. Both hooks hand off to it by invoking its Lambda directly
 * (IAM-authenticated: no shared secret and no public endpoint).
 *
 *   verifyUsername  asks Masky whether this uid may hold this address.
 *   onEmailStored   reports mail sent between two masky.ai addresses. Mail
 *                   from outside already reaches Masky through the SES
 *                   receipt rule, so only 'local' deliveries are forwarded.
 *
 * This Lambda's role needs lambda:InvokeFunction on the function named below.
 */

const FUNCTION_NAME = process.env.MASKY_API_FUNCTION || 'masky-api-production';

// Overridable in tests.
const deps = {
    invoke: async ({ payload, wait }) => {
        // Provided by the Lambda Node.js runtime.
        const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
        const client = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
        const res = await client.send(new InvokeCommand({
            FunctionName: FUNCTION_NAME,
            InvocationType: wait ? 'RequestResponse' : 'Event',
            Payload: Buffer.from(JSON.stringify(payload))
        }));
        if (!wait) return null;
        if (res.FunctionError) throw new Error(`Masky API error: ${res.FunctionError}`);
        return JSON.parse(Buffer.from(res.Payload || []).toString('utf-8') || 'null');
    }
};

async function verifyUsername(ctx) {
    const answer = await deps.invoke({
        wait: true,
        payload: {
            internalMailHook: 'username',
            domain: ctx.domain,
            username: ctx.username,
            uid: ctx.uid
        }
    });
    let body = answer && answer.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = null; }
    }
    // Only an explicit answer from the mail-hook handler counts. A Masky API
    // build that does not know this event replies with something else, and
    // that must not read as a yes.
    if (answer && answer.statusCode === 200 && body && body.mailHook === 'username') {
        if (body.allowed === true) return { allowed: true };
        if (body.allowed === false) return { allowed: false, statusCode: 403, error: body.error };
    }
    throw new Error('Masky API gave no username verdict');
}

async function onEmailStored(ctx) {
    if (ctx.source !== 'local') return;
    await deps.invoke({
        wait: false,
        payload: {
            internalMailHook: 'delivered',
            domain: ctx.domain,
            username: ctx.username,
            uid: ctx.uid,
            emailKey: ctx.emailKey,
            messageId: ctx.messageId,
            from: ctx.from,
            to: ctx.to,
            subject: ctx.subject,
            timestamp: ctx.timestamp
        }
    });
}

module.exports = { verifyUsername, onEmailStored, _deps: deps };
