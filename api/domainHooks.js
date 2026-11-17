'use strict';

/**
 * Per-domain hooks.
 *
 * One VCMail Lambda can serve several mail domains, and each domain may want
 * its own rules. A domain opts in by adding a file named after itself:
 *
 *     api/domain-hooks/<domain>.js        e.g. api/domain-hooks/example.com.js
 *
 * Start from api/domain-hooks/_template.js, which documents every hook. A
 * domain without a file behaves exactly as VCMail always has.
 *
 * Two hooks exist:
 *
 *   verifyUsername  decides whether a user may claim an address. It runs
 *                   before a NEW address is written. It fails closed: if the
 *                   hook throws, times out, or returns anything other than
 *                   { allowed: true }, the address is refused.
 *
 *   onEmailStored   is told about each message after it has been stored. It
 *                   runs once every recipient of the message is stored, so it
 *                   cannot hold mail up. Errors are logged and ignored, and
 *                   it is cut off after 5 seconds.
 */

const path = require('path');

const USERNAME_HOOK_TIMEOUT_MS = 12000;
const STORED_HOOK_TIMEOUT_MS = 5000;
const HOOK_DIR = path.join(__dirname, 'domain-hooks');

const cache = new Map();

function normalizeDomain(domain) {
    const d = String(domain || '').trim().toLowerCase();
    // A hostname, and never the template or a dot-file.
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(d) && !d.includes('..') ? d : '';
}

/**
 * Returns the hook module for a domain, null when the domain has none, or
 * { loadError } when a file exists but could not be loaded.
 */
function loadDomainHooks(domain, hookDir = HOOK_DIR) {
    const d = normalizeDomain(domain);
    if (!d) return null;
    const file = path.join(hookDir, `${d}.js`);
    if (cache.has(file)) return cache.get(file);
    let hooks = null;
    try {
        hooks = require(file);
    } catch (error) {
        const missingThisFile = error && error.code === 'MODULE_NOT_FOUND'
            && String(error.message || '').includes(file);
        if (!missingThisFile) {
            console.error(`[HOOKS] Could not load hooks for ${d}:`, error);
            hooks = { loadError: error };
        }
    }
    cache.set(file, hooks);
    return hooks;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function unavailable() {
    return {
        allowed: false,
        statusCode: 503,
        error: 'That address could not be checked right now. Try again in a moment.'
    };
}

/**
 * May `ctx.uid` claim `ctx.username`@`ctx.domain`?
 * Resolves { allowed: true } or { allowed: false, statusCode, error }.
 */
async function checkUsername(ctx, opts = {}) {
    const hooks = opts.hooks !== undefined ? opts.hooks : loadDomainHooks(ctx && ctx.domain);
    if (!hooks) return { allowed: true };
    if (hooks.loadError) return unavailable();
    if (typeof hooks.verifyUsername !== 'function') return { allowed: true };
    try {
        const verdict = await withTimeout(
            Promise.resolve().then(() => hooks.verifyUsername(ctx)),
            opts.timeoutMs || USERNAME_HOOK_TIMEOUT_MS,
            'verifyUsername'
        );
        if (verdict && verdict.allowed === true) return { allowed: true };
        const statusCode = Number(verdict && verdict.statusCode);
        return {
            allowed: false,
            statusCode: statusCode >= 400 && statusCode < 600 ? statusCode : 403,
            error: (verdict && typeof verdict.error === 'string' && verdict.error.trim())
                || 'That address is not available to this account.'
        };
    } catch (error) {
        console.error(`[HOOKS] verifyUsername failed for ${ctx && ctx.domain}:`, error);
        return unavailable();
    }
}

/** Tell the domain a message was stored. Never throws. */
async function notifyEmailStored(ctx, opts = {}) {
    try {
        const hooks = opts.hooks !== undefined ? opts.hooks : loadDomainHooks(ctx && ctx.domain);
        if (!hooks || hooks.loadError || typeof hooks.onEmailStored !== 'function') return;
        await withTimeout(
            Promise.resolve().then(() => hooks.onEmailStored(ctx)),
            opts.timeoutMs || STORED_HOOK_TIMEOUT_MS,
            'onEmailStored'
        );
    } catch (error) {
        console.error(`[HOOKS] onEmailStored failed for ${ctx && ctx.domain}:`, error);
    }
}

module.exports = {
    loadDomainHooks,
    checkUsername,
    notifyEmailStored,
    normalizeDomain
};
