// @include _helpers.js
// Turns one n8n form submission into a vendor record, joins it to the email the
// vendor first sent, and prepares the inputs for the official checks.

const FIELDS = /*@form_fields*/[];

const sub = $('Vendor Form').first().json;
const intake = $('Find Vendor').first().json || {};

// Newer form versions key answers by field name, older ones by label.
const answer = f => {
  const raw = sub[f.key] !== undefined ? sub[f.key] : sub[f.title];
  return Array.isArray(raw) ? raw.join(', ') : String(raw == null ? '' : raw).trim();
};

const v = {};
for (const f of FIELDS) v[f.key] = answer(f);

v.contact_email = v.contact_email.toLowerCase();
// A form opened without the personal link has no reference; fall back to the email address.
if (!/^EBM-/.test(v.vendor_id)) v.vendor_id = intake.vendor_id || vendorIdFor(v.contact_email);
v.form_submitted_at = sub.submittedAt || new Date().toISOString();
v.website = v.website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
v.original_email = intake.email_body ? `Subject: ${intake.subject}\n\n${intake.email_body}` : '';

// Directors as a clean list of names, for the sanctions check and web searches.
v.director_list = v.directors
  .replace(/\(.*?\)/g, '')
  .split(/[,;\n]| and /)
  .map(s => s.trim())
  .filter(s => s.split(/\s+/).length >= 2);

// SECP stores names as "XYZ (PRIVATE) LIMITED"; vendors often write "XYZ (Pvt) Ltd".
v.secp_query = v.company_name.toUpperCase()
  .replace(/\(\s*PVT\.?\s*\)|\bPVT\.?(?=\s)/g, '(PRIVATE)')
  .replace(/\bLTD\b\.?/g, 'LIMITED')
  .replace(/\s+/g, ' ')
  .trim();

return [{ json: v }];
