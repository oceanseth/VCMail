/**
 * Google Calendar (GIS OAuth + Calendar API) for ICS import and duplicate checks.
 * Tokens are stored in localStorage for this browser only (typical SPA tradeoff).
 */

/** Events import + listing user's calendars for the target picker */
const CALENDAR_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const STORAGE_TOKEN = 'vcmail_gcal_access_token';
const STORAGE_EXPIRY = 'vcmail_gcal_expires_at';
const STORAGE_TARGET_CALENDAR_ID = 'vcmail_gcal_target_calendar_id';

export function getGoogleOAuthClientId(cfg) {
  const id = cfg?.googleOAuthClientId;
  return typeof id === 'string' ? id.trim() : '';
}

export function isGoogleCalendarConfigured(cfg) {
  const id = getGoogleOAuthClientId(cfg);
  return id.length > 15 && id.includes('.apps.googleusercontent.com');
}

export function hasCalendarAccessToken() {
  const t = localStorage.getItem(STORAGE_TOKEN);
  const exp = parseInt(localStorage.getItem(STORAGE_EXPIRY) || '0', 10);
  return !!(t && exp > Date.now());
}

/** True when a token was ever stored, even if expired (user connected before). */
export function hasStoredCalendarToken() {
  return !!localStorage.getItem(STORAGE_TOKEN);
}

/** Non-interactive: stored token if still valid, else null. Never opens Google UI. */
export function getLocallyValidAccessToken() {
  const t = localStorage.getItem(STORAGE_TOKEN);
  const exp = parseInt(localStorage.getItem(STORAGE_EXPIRY) || '0', 10);
  return t && exp > Date.now() ? t : null;
}

/** True when OAuth client is configured and this browser has a valid Calendar token. */
export function shouldShowIcsGoogleActions(cfg) {
  return isGoogleCalendarConfigured(cfg) && hasCalendarAccessToken();
}

function persistToken(tokenResponse) {
  localStorage.setItem(STORAGE_TOKEN, tokenResponse.access_token);
  const slackMs = 90_000;
  const expiresAt = Date.now() + (tokenResponse.expires_in || 3600) * 1000 - slackMs;
  localStorage.setItem(STORAGE_EXPIRY, String(expiresAt));
}

export function disconnectGoogleCalendar() {
  localStorage.removeItem(STORAGE_TOKEN);
  localStorage.removeItem(STORAGE_EXPIRY);
}

/** Calendar ID for ICS import / duplicate checks (default primary). */
export function getTargetCalendarId() {
  const id = localStorage.getItem(STORAGE_TARGET_CALENDAR_ID);
  return id && id.trim() ? id.trim() : 'primary';
}

export function setTargetCalendarId(calendarId) {
  const id = (calendarId || '').trim();
  if (!id || id === 'primary') {
    localStorage.removeItem(STORAGE_TARGET_CALENDAR_ID);
    return;
  }
  localStorage.setItem(STORAGE_TARGET_CALENDAR_ID, id);
}

function loadGisScript() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-vcmail-gis]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Identity Services failed to load')), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.dataset.vcmailGis = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google Identity Services failed to load'));
    document.head.appendChild(s);
  });
}

export async function connectGoogleCalendar(clientId) {
  if (!clientId) throw new Error('Missing Google OAuth client ID');
  await loadGisScript();
  return new Promise((resolve, reject) => {
    try {
      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: CALENDAR_OAUTH_SCOPES,
        callback: (tokenResponse) => {
          if (tokenResponse.error) {
            reject(new Error(tokenResponse.error_description || tokenResponse.error));
            return;
          }
          persistToken(tokenResponse);
          resolve(tokenResponse);
        },
      });
      client.requestAccessToken({ prompt: 'consent' });
    } catch (e) {
      reject(e);
    }
  });
}

export async function getValidAccessToken(clientId) {
  if (!clientId) return null;
  const t = localStorage.getItem(STORAGE_TOKEN);
  const exp = parseInt(localStorage.getItem(STORAGE_EXPIRY) || '0', 10);
  if (t && exp > Date.now()) return t;

  if (!t) return null;

  try {
    await loadGisScript();
    return await new Promise((resolve) => {
      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: CALENDAR_OAUTH_SCOPES,
        callback: (tokenResponse) => {
          if (tokenResponse.error) {
            disconnectGoogleCalendar();
            resolve(null);
            return;
          }
          persistToken(tokenResponse);
          resolve(tokenResponse.access_token);
        },
      });
      client.requestAccessToken({ prompt: '' });
    });
  } catch {
    disconnectGoogleCalendar();
    return null;
  }
}

/** RFC 5545 line folding: CRLF + space/tab continues previous line (replace fold with a single space). */
function unfoldIcs(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ' ');
}

function extractFirstVeventBlock(text) {
  const unfolded = unfoldIcs(text);
  const begin = unfolded.search(/BEGIN:VEVENT/i);
  if (begin === -1) return null;
  const end = unfolded.indexOf('END:VEVENT', begin);
  if (end === -1) return null;
  return unfolded.slice(begin, end + 'END:VEVENT'.length);
}

function parseVeventLine(line) {
  const ci = line.indexOf(':');
  if (ci === -1) return null;
  const namePart = line.slice(0, ci);
  const value = line.slice(ci + 1).trim();
  const upperName = namePart.split(';')[0].toUpperCase();
  return { name: upperName, value };
}

function parseVeventLineDetail(line) {
  const ci = line.indexOf(':');
  if (ci === -1) return null;
  const namePart = line.slice(0, ci);
  const value = line.slice(ci + 1).trim();
  const parts = namePart.split(';');
  const upperName = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name: upperName, value, params };
}

function unescapeIcsText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Maps DTSTART/DTEND value + params to Google Calendar API time object.
 * @returns {{ date?: string, dateTime?: string, timeZone?: string } | null}
 */
function icsDtToGoogleTimeObject(value, params) {
  const v = (value || '').trim();
  const p = params || {};
  const valueDate = (p.VALUE || '').toUpperCase() === 'DATE';
  if (valueDate || /^\d{8}$/.test(v)) {
    const raw = v.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1$2$3');
    if (!/^\d{8}$/.test(raw)) return null;
    return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const localIso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === 'Z') return { dateTime: `${localIso}Z` };
  if (p.TZID) return { dateTime: localIso, timeZone: p.TZID };
  return { dateTime: localIso };
}

/** When DTEND is missing: +1h wall clock in same timezone object shape (best-effort). */
function defaultEndFromStart(startObj) {
  if (startObj.date) {
    const d = new Date(`${startObj.date}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return { date: d.toISOString().slice(0, 10) };
  }
  const dt = startObj.dateTime || '';
  if (dt.endsWith('Z')) {
    const d = new Date(dt);
    if (!Number.isNaN(d.getTime())) {
      d.setTime(d.getTime() + 3600000);
      return { dateTime: d.toISOString().replace(/\.\d{3}Z$/, 'Z') };
    }
  }
  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return { ...startObj };
  const base = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  base.setHours(base.getHours() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const out = {
    dateTime: `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}:${pad(base.getSeconds())}`,
  };
  if (startObj.timeZone) out.timeZone = startObj.timeZone;
  return out;
}

/**
 * Google Calendar `events.import` expects a JSON **Event** resource, not raw text/calendar.
 * @see https://developers.google.com/calendar/api/v3/reference/events/import
 */
export function icsTextToGoogleCalendarImportResource(icsText) {
  const block = extractFirstVeventBlock(icsText);
  if (!block) throw new Error('No VEVENT found in calendar file');
  const lines = block.split(/\n/);
  let uid = '';
  let summary = '';
  let sequence = 0;
  let description = '';
  let location = '';
  /** @type {{ date?: string, dateTime?: string, timeZone?: string } | null} */
  let dtstart = null;
  /** @type {{ date?: string, dateTime?: string, timeZone?: string } | null} */
  let dtend = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;
    const p = parseVeventLineDetail(line);
    if (!p) continue;
    if (p.name === 'UID') uid = p.value;
    else if (p.name === 'SUMMARY') summary = (summary ? `${summary} ` : '') + p.value;
    else if (p.name === 'DESCRIPTION') description = (description ? `${description}\n` : '') + p.value;
    else if (p.name === 'LOCATION') location = (location ? `${location} ` : '') + p.value;
    else if (p.name === 'SEQUENCE') sequence = parseInt(p.value, 10) || 0;
    else if (p.name === 'DTSTART') dtstart = icsDtToGoogleTimeObject(p.value, p.params);
    else if (p.name === 'DTEND') dtend = icsDtToGoogleTimeObject(p.value, p.params);
  }

  if (!uid) throw new Error('Calendar invitation has no UID');
  if (!dtstart) throw new Error('Calendar invitation has no DTSTART');
  if (!dtend) dtend = defaultEndFromStart(dtstart);

  if (dtstart.date && dtend.date && dtstart.date === dtend.date) {
    const d = new Date(`${dtstart.date}T12:00:00`);
    d.setDate(d.getDate() + 1);
    dtend = { date: d.toISOString().slice(0, 10) };
  }

  const event = {
    iCalUID: uid,
    summary: (summary || '').trim() || 'Imported event',
    start: dtstart,
    end: dtend,
    sequence,
  };
  const desc = unescapeIcsText(description).trim();
  if (desc) event.description = desc;
  const loc = unescapeIcsText(location).trim();
  if (loc) event.location = loc;
  return event;
}

/**
 * @returns {{ uid: string, summary: string, dtstartValue: string } | null}
 */
export function parseFirstVeventIcs(icsText) {
  const block = extractFirstVeventBlock(icsText);
  if (!block) return null;
  const lines = block.split(/\n/);
  let uid = '';
  let summary = '';
  let dtstartValue = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;
    const parsed = parseVeventLine(line);
    if (!parsed) continue;
    if (parsed.name === 'UID') uid = parsed.value;
    else if (parsed.name === 'SUMMARY') summary = parsed.value;
    else if (parsed.name === 'DTSTART') dtstartValue = parsed.value;
  }
  if (!dtstartValue) return null;
  return { uid, summary, dtstartValue };
}

/** Human-readable one-line summary for attachment UI (title · date · time or all-day). */
export function formatIcsEventPreview(parsed) {
  if (!parsed || !parsed.dtstartValue) return '';
  const d = parseIcsDateValue(parsed.dtstartValue);
  if (!d || Number.isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const raw = parsed.dtstartValue.trim();
  const isDateOnly = /^\d{8}$/.test(raw);
  const timePart = isDateOnly
    ? 'All day'
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const title = (parsed.summary || '').trim() || 'Calendar event';
  return `${title} · ${datePart} · ${timePart}`;
}

export function parseIcsDateValue(dtValue) {
  const v = dtValue.trim();
  if (/^\d{8}$/.test(v)) {
    const y = parseInt(v.slice(0, 4), 10);
    const m = parseInt(v.slice(4, 6), 10) - 1;
    const d = parseInt(v.slice(6, 8), 10);
    return new Date(y, m, d, 12, 0, 0, 0);
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if (m) {
    const y = +m[1];
    const mo = +m[2] - 1;
    const d = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const s = +m[6];
    if (m[7] === 'Z') return new Date(Date.UTC(y, mo, d, h, mi, s));
    return new Date(y, mo, d, h, mi, s);
  }
  return null;
}

function localDayRangeIsoStrings(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function normalizeUid(u) {
  if (!u) return '';
  return u.replace(/^mailto:/i, '').trim().toLowerCase();
}

function normalizeSummary(s) {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function googleEventStartMillis(ev) {
  if (ev.start?.dateTime) return new Date(ev.start.dateTime).getTime();
  if (ev.start?.date) return new Date(`${ev.start.date}T12:00:00`).getTime();
  return NaN;
}

function parsedStartMillis(parsed) {
  return parseIcsDateValue(parsed.dtstartValue)?.getTime() ?? NaN;
}

export function calendarEventMatchesIcs(ev, parsed) {
  const evIcal = normalizeUid(ev.iCalUID || '');
  const icsUid = normalizeUid(parsed.uid);
  if (icsUid && evIcal) {
    if (evIcal === icsUid) return true;
    if (evIcal.startsWith(`${icsUid}@`)) return true;
  }
  const tEv = googleEventStartMillis(ev);
  const tIcs = parsedStartMillis(parsed);
  if (!Number.isFinite(tEv) || !Number.isFinite(tIcs)) return false;
  const close = Math.abs(tEv - tIcs) <= 120_000;
  if (!close) return false;
  const s1 = normalizeSummary(parsed.summary);
  const s2 = normalizeSummary(ev.summary || '');
  if (!s1 || !s2) return close;
  return s1 === s2 || s2.includes(s1) || s1.includes(s2);
}

async function listEventsInRange(accessToken, timeMin, timeMax, calendarId) {
  const cal = calendarId || getTargetCalendarId();
  const all = [];
  let pageToken = '';
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`
    );
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `Calendar list failed: ${res.status}`);
    }
    const data = await res.json();
    all.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

export async function checkIcsExistsOnCalendar(accessToken, icsText) {
  const parsed = parseFirstVeventIcs(icsText);
  if (!parsed) return { exists: false, parsed: null };
  const startDate = parseIcsDateValue(parsed.dtstartValue);
  if (!startDate) return { exists: false, parsed };
  const { timeMin, timeMax } = localDayRangeIsoStrings(startDate);
  const calId = getTargetCalendarId();
  const events = await listEventsInRange(accessToken, timeMin, timeMax, calId);
  const exists = events.some((ev) => calendarEventMatchesIcs(ev, parsed));
  return { exists, parsed };
}

/** Calendars the user can add events to (for Settings picker). */
export async function listWritableCalendars(accessToken) {
  const url =
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=writer';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `calendarList failed: ${res.status}`);
  }
  const data = await res.json();
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary || c.id,
    primary: !!c.primary,
    accessRole: c.accessRole,
  }));
}

export async function importIcsToCalendar(accessToken, icsText, calendarId = getTargetCalendarId()) {
  const cal = calendarId || 'primary';
  const eventResource = icsTextToGoogleCalendarImportResource(icsText);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/import`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventResource),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `Import failed: ${res.status}`);
  }
  return res.json();
}

/** @deprecated Use importIcsToCalendar; kept for callers using "primary" naming. */
export async function importIcsToPrimaryCalendar(accessToken, icsText) {
  return importIcsToCalendar(accessToken, icsText, getTargetCalendarId());
}

export function isIcsAttachment(attachment) {
  const fn = (attachment.filename || '').toLowerCase();
  const ct = (attachment.contentType || '').toLowerCase();
  return fn.endsWith('.ics') || ct.includes('text/calendar') || ct === 'application/ics';
}

export async function fetchIcsText(attachment) {
  // Prefer body from API JSON (Lambda inlines small .ics). Presigned S3 URLs often fail browser fetch() CORS.
  if (attachment.content) {
    if (attachment.encoding === 'base64') {
      try {
        const bin = atob(attachment.content.replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
      } catch {
        return null;
      }
    }
    return typeof attachment.content === 'string' ? attachment.content : null;
  }
  if (attachment.url) {
    try {
      const r = await fetch(attachment.url);
      if (!r.ok) throw new Error(`Could not fetch calendar file (${r.status})`);
      return r.text();
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        throw new Error(
          'Could not load invitation file (browser blocked cross-origin fetch to storage). Reload the email after redeploying the API, or open the attachment link to download.'
        );
      }
      throw e;
    }
  }
  return null;
}
