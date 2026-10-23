// Serves the review page. The browser has already passed the page's Basic Auth
// login; here we hand it a session pass that the page sends with each data call,
// so the data webhooks need no password of their own.

const PAGE = /*@page_html*/'';
const TTL_HOURS = 12;

let token;
try {
  token = require('crypto').randomBytes(24).toString('hex');
} catch (e) {
  token = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('');
}

// Passes live in this workflow's static data, which n8n keeps between production runs.
const store = $getWorkflowStaticData('global');
const now = Date.now();
store.sessions = Object.fromEntries(Object.entries(store.sessions || {}).filter(([, exp]) => exp > now));
store.sessions[token] = now + TTL_HOURS * 3600 * 1000;

const query = $('Page Webhook').first().json.query || {};
const config = {
  base: $('Config').first().json.webhook_base.replace(/\/$/, ''),
  token,
  open: String(query.vendor || ''),
};
const inject = `<script>window.VENDOR_DESK = ${JSON.stringify(config)};</script>`;

return [{ json: { html: PAGE.replace('<script>', inject + '\n<script>') } }];
