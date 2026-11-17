'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const domainHooks = require('./domainHooks');
const maskyHooks = require('./domain-hooks/masky.ai.js');
const { handleSetupEmail, handleSendEmail, handleSesEvent, storeEmailForUser } = require('./api.js');

const CRLF = String.fromCharCode(13, 10);
const RAW = ['From: out@elsewhere.org', 'To: alice@masky.ai', 'Subject: hi', 'Content-Type: text/plain', '', 'hello'].join(CRLF);

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeDatabase(initial = {}) {
    const data = { ...initial }; // flat: path -> value
    const read = (p) => {
        if (p in data) return data[p];
        const prefix = `${p}/`;
        const out = {};
        let any = false;
        for (const [k, v] of Object.entries(data)) {
            if (!k.startsWith(prefix)) continue;
            any = true;
            const rest = k.slice(prefix.length).split('/');
            let node = out;
            rest.forEach((seg, i) => {
                if (i === rest.length - 1) node[seg] = v;
                else node = node[seg] = node[seg] || {};
            });
        }
        return any ? out : null;
    };
    const write = (p, v) => {
        for (const k of Object.keys(data)) if (k === p || k.startsWith(`${p}/`)) delete data[k];
        if (v !== null && v !== undefined) data[p] = v;
    };
    const ref = (p = '') => ({
        once: async () => {
            const v = read(p);
            return { exists: () => v !== null && v !== undefined, val: () => v };
        },
        set: async (v) => write(p, v),
        update: async (updates) => { for (const [k, v] of Object.entries(updates)) write(p ? `${p}/${k}` : k, v); },
        transaction: async (fn) => write(p, fn(read(p)))
    });
    return { data, ref };
}

function fakeConfig(domain, db, extra = {}) {
    const s3Calls = [];
    return {
        domain,
        s3BucketName: 'test-bucket',
        firebaseApp: { database: () => db },
        s3Client: { send: async (cmd) => { s3Calls.push(cmd); return {}; } },
        sesClient: { send: async () => ({ MessageId: 'ses-1' }) },
        s3Calls,
        ...extra
    };
}

const post = (body) => ({ body: JSON.stringify(body), isBase64Encoded: false });
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });

let invokes;
function maskyAnswers(answer) {
    invokes = [];
    maskyHooks._deps.invoke = async (call) => {
        invokes.push(call);
        if (typeof answer === 'function') return answer(call);
        return answer;
    };
}
const verdict = (allowed, error) => ({
    statusCode: 200,
    body: JSON.stringify({ mailHook: 'username', allowed, ...(error ? { error } : {}) })
});

// ── Hook runner ──────────────────────────────────────────────────────────────

describe('checkUsername', () => {
    const ctx = { domain: 'example.com', username: 'alice', uid: 'u1' };

    it('allows when the domain has no hook file', async () => {
        assert.deepEqual(await domainHooks.checkUsername(ctx), { allowed: true });
    });

    it('allows when the hook file has no verifyUsername', async () => {
        assert.deepEqual(await domainHooks.checkUsername(ctx, { hooks: {} }), { allowed: true });
    });

    it('passes an explicit yes through', async () => {
        const hooks = { verifyUsername: async () => ({ allowed: true }) };
        assert.deepEqual(await domainHooks.checkUsername(ctx, { hooks }), { allowed: true });
    });

    it('refuses with the hook message and a 403 by default', async () => {
        const hooks = { verifyUsername: async () => ({ allowed: false, error: 'Reserved.' }) };
        assert.deepEqual(await domainHooks.checkUsername(ctx, { hooks }), {
            allowed: false, statusCode: 403, error: 'Reserved.'
        });
    });

    it('refuses anything that is not an explicit yes', async () => {
        for (const value of [undefined, null, true, 'yes', {}, { allowed: 'true' }, { allowed: 1 }]) {
            const hooks = { verifyUsername: async () => value };
            const res = await domainHooks.checkUsername(ctx, { hooks });
            assert.equal(res.allowed, false, `value ${JSON.stringify(value)}`);
            assert.equal(res.statusCode, 403);
        }
    });

    it('fails closed when the hook throws, synchronously or not', async () => {
        const asyncThrow = { verifyUsername: async () => { throw new Error('boom'); } };
        const syncThrow = { verifyUsername: () => { throw new Error('boom'); } };
        for (const hooks of [asyncThrow, syncThrow]) {
            const res = await domainHooks.checkUsername(ctx, { hooks });
            assert.equal(res.allowed, false);
            assert.equal(res.statusCode, 503);
        }
    });

    it('fails closed when the hook hangs', async () => {
        const hooks = { verifyUsername: () => new Promise(() => {}) };
        const res = await domainHooks.checkUsername(ctx, { hooks, timeoutMs: 20 });
        assert.equal(res.allowed, false);
        assert.equal(res.statusCode, 503);
    });

    it('fails closed when the hook file could not be loaded', async () => {
        const res = await domainHooks.checkUsername(ctx, { hooks: { loadError: new Error('syntax') } });
        assert.equal(res.allowed, false);
        assert.equal(res.statusCode, 503);
    });

    it('ignores an out-of-range status code from the hook', async () => {
        const hooks = { verifyUsername: async () => ({ allowed: false, statusCode: 200 }) };
        assert.equal((await domainHooks.checkUsername(ctx, { hooks })).statusCode, 403);
    });
});

describe('notifyEmailStored', () => {
    it('never throws', async () => {
        await domainHooks.notifyEmailStored({ domain: 'example.com' });
        await domainHooks.notifyEmailStored({ domain: 'x' }, { hooks: { onEmailStored: () => { throw new Error('boom'); } } });
        await domainHooks.notifyEmailStored({ domain: 'x' }, { hooks: { onEmailStored: async () => { throw new Error('boom'); } } });
        await domainHooks.notifyEmailStored({ domain: 'x' }, { hooks: { onEmailStored: () => new Promise(() => {}) }, timeoutMs: 20 });
        await domainHooks.notifyEmailStored(null);
    });

    it('hands the context to the hook', async () => {
        let seen = null;
        await domainHooks.notifyEmailStored({ domain: 'x', emailKey: 'e1' }, { hooks: { onEmailStored: async (c) => { seen = c; } } });
        assert.equal(seen.emailKey, 'e1');
    });
});

describe('loadDomainHooks', () => {
    it('loads a domain file and nothing else', () => {
        assert.equal(typeof domainHooks.loadDomainHooks('masky.ai').verifyUsername, 'function');
        assert.equal(domainHooks.loadDomainHooks('MASKY.AI'), domainHooks.loadDomainHooks('masky.ai'));
        assert.equal(domainHooks.loadDomainHooks('example.com'), null);
        assert.equal(domainHooks.loadDomainHooks('_template'), null);
        assert.equal(domainHooks.loadDomainHooks('../domainHooks'), null);
        assert.equal(domainHooks.loadDomainHooks('..'), null);
        assert.equal(domainHooks.loadDomainHooks(''), null);
        assert.equal(domainHooks.loadDomainHooks(undefined), null);
    });
});

// ── masky.ai hook ────────────────────────────────────────────────────────────

describe('masky.ai hook', () => {
    const ctx = { domain: 'masky.ai', username: 'alice', uid: 'twitch:1', token: { uid: 'twitch:1' } };

    it('asks the Masky API and waits for the answer', async () => {
        maskyAnswers(verdict(true));
        assert.deepEqual(await maskyHooks.verifyUsername(ctx), { allowed: true });
        assert.equal(invokes.length, 1);
        assert.equal(invokes[0].wait, true);
        assert.deepEqual(invokes[0].payload, {
            internalMailHook: 'username', domain: 'masky.ai', username: 'alice', uid: 'twitch:1'
        });
    });

    it('passes a refusal and its message through', async () => {
        maskyAnswers(verdict(false, 'Your address is your Twitch username.'));
        assert.deepEqual(await maskyHooks.verifyUsername(ctx), {
            allowed: false, statusCode: 403, error: 'Your address is your Twitch username.'
        });
    });

    it('treats every other reply as no verdict', async () => {
        const replies = [
            null,
            { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) },
            { statusCode: 200, body: JSON.stringify({ allowed: true }) },
            { statusCode: 200, body: 'not json' },
            { statusCode: 500, body: JSON.stringify({ mailHook: 'username', allowed: true }) },
            { statusCode: 200, body: JSON.stringify({ mailHook: 'username' }) }
        ];
        for (const reply of replies) {
            maskyAnswers(reply);
            await assert.rejects(() => maskyHooks.verifyUsername(ctx), /no username verdict/);
            const res = await domainHooks.checkUsername(ctx);
            assert.equal(res.allowed, false, JSON.stringify(reply));
            assert.equal(res.statusCode, 503);
        }
    });

    it('reports only local deliveries, without waiting', async () => {
        maskyAnswers(null);
        await maskyHooks.onEmailStored({ domain: 'masky.ai', source: 'ses', username: 'alice' });
        assert.equal(invokes.length, 0);
        await maskyHooks.onEmailStored({
            domain: 'masky.ai', source: 'local', username: 'alice', uid: 'u', emailKey: 'email_1',
            messageId: 'vcmail-1', from: 'bob@masky.ai', to: 'alice@masky.ai', subject: 'hi', timestamp: 5
        });
        assert.equal(invokes.length, 1);
        assert.equal(invokes[0].wait, false);
        assert.equal(invokes[0].payload.internalMailHook, 'delivered');
        assert.equal(invokes[0].payload.messageId, 'vcmail-1');
        assert.equal(invokes[0].payload.username, 'alice');
    });
});

// ── setupEmail ───────────────────────────────────────────────────────────────

describe('setupEmail with a domain hook', () => {
    let db;
    beforeEach(() => { db = fakeDatabase({ 'usernames/taken': 'someone', 'usernames/mine': 'twitch:1', 'users/twitch:1/profile': { username: 'mine', email: 'mine@masky.ai' } }); });

    it('behaves as before on a domain without hooks', async () => {
        const res = parse(await handleSetupEmail(post({ username: 'Alice' }), { uid: 'u9' }, {}, fakeConfig('example.com', db)));
        assert.equal(res.status, 200);
        assert.equal(db.data['usernames/alice'], 'u9');
        assert.deepEqual(db.data['users/u9/profile'], { username: 'alice', email: 'alice@example.com' });
    });

    it('writes the address when the hook allows it', async () => {
        maskyAnswers(verdict(true));
        const res = parse(await handleSetupEmail(post({ username: 'alice' }), { uid: 'twitch:2' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 200);
        assert.equal(db.data['usernames/alice'], 'twitch:2');
        assert.equal(invokes[0].payload.uid, 'twitch:2');
    });

    it('writes nothing when the hook refuses', async () => {
        maskyAnswers(verdict(false, 'Your address is your Twitch username.'));
        const before = JSON.stringify(db.data);
        const res = parse(await handleSetupEmail(post({ username: 'alice' }), { uid: 'twitch:2' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 403);
        assert.equal(res.body.errorCode, 'UsernameNotAllowed');
        assert.equal(res.body.error, 'Your address is your Twitch username.');
        assert.equal(JSON.stringify(db.data), before);
    });

    it('writes nothing when the hook cannot be reached', async () => {
        maskyAnswers(() => { throw new Error('AccessDenied'); });
        const before = JSON.stringify(db.data);
        const res = parse(await handleSetupEmail(post({ username: 'alice' }), { uid: 'twitch:2' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 503);
        assert.equal(JSON.stringify(db.data), before);
    });

    it('does not consult the hook for an address the caller already holds', async () => {
        maskyAnswers(verdict(false, 'no'));
        const res = parse(await handleSetupEmail(post({ username: 'mine' }), { uid: 'twitch:1' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 200);
        assert.equal(invokes.length, 0);
    });

    it('a refused change of address keeps the old one', async () => {
        maskyAnswers(verdict(false, 'no'));
        const res = parse(await handleSetupEmail(post({ username: 'other' }), { uid: 'twitch:1' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 403);
        assert.equal(db.data['usernames/mine'], 'twitch:1');
        assert.equal(db.data['usernames/other'], undefined);
    });

    it('still answers taken before asking the hook', async () => {
        maskyAnswers(verdict(true));
        const res = parse(await handleSetupEmail(post({ username: 'taken' }), { uid: 'twitch:2' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 409);
        assert.equal(invokes.length, 0);
    });
});

// ── sendEmail / store ────────────────────────────────────────────────────────

describe('sendEmail sender check', () => {
    it('refuses a profile whose address the index does not give to this uid', async () => {
        const db = fakeDatabase({
            'usernames/seth': 'real-seth',
            'users/u2/profile': { username: 'seth', email: 'seth@example.com' },
            'usernames/bob': 'u3'
        });
        const config = fakeConfig('example.com', db);
        const res = parse(await handleSendEmail(post({ to: 'bob@example.com', subject: 's', body: 'b' }), { uid: 'u2' }, {}, config));
        assert.equal(res.status, 403);
        assert.equal(res.body.errorCode, 'SenderNotRegistered');
        assert.equal(config.s3Calls.length, 0);
    });

    it('refuses a profile naming an address nobody holds', async () => {
        const db = fakeDatabase({ 'users/u2/profile': { username: 'ghost', email: 'ghost@example.com' } });
        const res = parse(await handleSendEmail(post({ to: 'x@elsewhere.org', subject: 's', body: 'b' }), { uid: 'u2' }, {}, fakeConfig('example.com', db)));
        assert.equal(res.status, 403);
    });

    it('delivers between two addresses on the domain and reports it as local', async () => {
        maskyAnswers(null);
        const db = fakeDatabase({
            'usernames/alice': 'u1', 'users/u1/profile': { username: 'alice', email: 'alice@masky.ai' },
            'usernames/bob': 'u3'
        });
        const res = parse(await handleSendEmail(post({ to: 'bob@masky.ai', subject: 'hello', body: 'hi bob' }), { uid: 'u1' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 200);
        const stored = Object.keys(db.data).filter((k) => k.startsWith('emails/u3/'));
        assert.equal(stored.length, 1);
        assert.equal(invokes.length, 1);
        const p = invokes[0].payload;
        assert.equal(p.internalMailHook, 'delivered');
        assert.equal(p.username, 'bob');
        assert.equal(p.uid, 'u3');
        assert.equal(p.from, 'alice@masky.ai');
        assert.equal(p.subject, 'hello');
        assert.equal(`emails/u3/${p.emailKey}`, stored[0]);
        assert.equal(p.messageId, res.body.messageId);
    });
});

describe('sendEmail between two addresses on a domain', () => {
    const seed = () => fakeDatabase({
        'usernames/alice': 'u1', 'users/u1/profile': { username: 'alice', email: 'alice@masky.ai' },
        'usernames/bob': 'u3'
    });

    it('delivers and answers 200 even when the hook fails', async () => {
        maskyAnswers(() => { throw new Error('down'); });
        const db = seed();
        const res = parse(await handleSendEmail(post({ to: 'bob@masky.ai', subject: 'hello', body: 'hi' }), { uid: 'u1' }, {}, fakeConfig('masky.ai', db)));
        assert.equal(res.status, 200);
        assert.equal(Object.keys(db.data).filter((k) => k.startsWith('emails/u3/')).length, 1);
        assert.equal(Object.keys(db.data).filter((k) => k.startsWith('sent/u1/')).length, 1);
        assert.equal(invokes.length, 1);
    });

    it('keeps the subject on one header line', async () => {
        maskyAnswers(null);
        const db = seed();
        const config = fakeConfig('masky.ai', db);
        const sneaky = ['hello', 'From: someone@else.example', 'Reply-To: x@y.z'].join(CRLF);
        const res = parse(await handleSendEmail(post({ to: 'bob@masky.ai', subject: sneaky, body: 'hi' }), { uid: 'u1' }, {}, config));
        assert.equal(res.status, 200);
        const raw = config.s3Calls.map((c) => c.input && c.input.Body).find((b) => typeof b === 'string' && b.startsWith('From: '));
        const lines = raw.split(CRLF + CRLF)[0].split(CRLF);
        assert.equal(lines.filter((l) => /^from:/i.test(l)).length, 1);
        assert.equal(lines.filter((l) => /^reply-to:/i.test(l)).length, 0);
        assert.ok(lines.includes('Subject: hello From: someone@else.example Reply-To: x@y.z'));
        assert.equal(invokes[0].payload.subject, 'hello From: someone@else.example Reply-To: x@y.z');
        assert.equal(invokes[0].payload.from, 'alice@masky.ai');
    });

    it('still refuses an empty subject', async () => {
        const res = parse(await handleSendEmail(post({ to: 'bob@masky.ai', subject: CRLF, body: 'hi' }), { uid: 'u1' }, {}, fakeConfig('masky.ai', seed())));
        assert.equal(res.status, 400);
    });
});

describe('SES delivery to several recipients', () => {
    it('stores every recipient before any hook runs', async () => {
        const order = [];
        const db = fakeDatabase({ 'usernames/alice': 'u1', 'usernames/bob': 'u3' });
        const realSet = db.ref;
        const config = fakeConfig('masky.ai', db);
        config.firebaseApp = { database: () => ({ ref: (p) => {
            const r = realSet(p);
            if (/^emails\/u\d\/email_/.test(p)) { const set = r.set; r.set = async (v) => { order.push('store ' + p.split('/')[1]); return set(v); }; }
            return r;
        } }) };
        config.s3Client = { send: async (cmd) => (cmd.constructor.name === 'GetObjectCommand'
            ? { Body: { transformToString: async () => RAW, [Symbol.asyncIterator]: async function* () { yield Buffer.from(RAW); } } }
            : {}) };
        maskyHooks._deps.invoke = async () => { order.push('hook'); return null; };
        const hooks = require('./domainHooks');
        const original = hooks.notifyEmailStored;
        hooks.notifyEmailStored = async (ctx) => { order.push('notify ' + ctx.uid); return original(ctx); };
        try {
            const res = await handleSesEvent({ Records: [{ eventSource: 'aws:ses', ses: {
                mail: { messageId: 'ses-multi', timestamp: '2026-11-17T12:00:00.000Z', destination: ['alice@masky.ai'] },
                receipt: { recipients: ['alice@masky.ai', 'bob@masky.ai', 'nobody@masky.ai'] }
            } }] }, config);
            assert.equal(res.statusCode, 200);
            assert.equal(JSON.parse(res.body).processedCount, 3);
        } finally {
            hooks.notifyEmailStored = original;
        }
        assert.deepEqual(order.filter((o) => !o.startsWith('hook')), ['store u1', 'store u3', 'notify u1', 'notify u3']);
    });
});

describe('storeEmailForUser', () => {
    const emailData = { from: 'out@elsewhere.org', to: 'bob@masky.ai', subject: 'hi', body: 'text', headers: { 'content-type': 'text/plain' } };

    it('stores first and returns what it stored, without calling the hook itself', async () => {
        maskyAnswers(null);
        const db = fakeDatabase({ 'usernames/bob': 'u3' });
        const stored = await storeEmailForUser('bob', 'ses-abc', emailData, fakeConfig('masky.ai', db), 1000);
        const keys = Object.keys(db.data).filter((k) => k.startsWith('emails/u3/'));
        assert.equal(keys.length, 1);
        assert.equal(invokes.length, 0);
        assert.deepEqual(stored, {
            domain: 'masky.ai', username: 'bob', uid: 'u3', emailKey: keys[0].split('/').pop(), messageId: 'ses-abc',
            source: 'ses', from: 'out@elsewhere.org', to: 'bob@masky.ai', subject: 'hi', timestamp: 1000
        });
        const local = await storeEmailForUser('bob', 'vcmail-1', emailData, fakeConfig('masky.ai', db), null, 'local');
        assert.equal(local.source, 'local');
    });

    it('returns nothing for an address nobody holds', async () => {
        const db = fakeDatabase({});
        assert.equal(await storeEmailForUser('ghost', 'ses-abc', emailData, fakeConfig('masky.ai', db), 1000), undefined);
        assert.equal(Object.keys(db.data).length, 0);
    });
});
