// @include _helpers.js
// Validates a reviewer's decision against the stored assessment and prepares
// the table update and the reply to the vendor's email thread.

const cfg = $('Config').first().json;
// The page posts form-encoded "payload=<json>" so a sandboxed page needs no CORS preflight.
const raw = $('Decision Webhook').first().json.body || {};
let body = raw;
try { if (typeof raw.payload === 'string') body = JSON.parse(raw.payload); } catch (e) { body = {}; }
const row = $input.first().json || {};
let saved = {};
try { saved = JSON.parse(row.assessment || '{}'); } catch (e) {}
row.contact_name = row.contact_name || saved.contact_name || row.sender_name;
row.company_name = row.company_name || saved.company_name;

const DECISIONS = {
  approved: 'approved',
  info_requested: 'info_requested',
  rejected: 'rejected',
};

function fail(error) {
  return [{ json: { ok: false, error } }];
}

const decision = DECISIONS[body.decision];
const note = String(body.note || '').trim();
const reviewer = String(body.reviewer || '').trim();

if (!decision) return fail('decision must be approved, info_requested or rejected');
if (!reviewer) return fail('reviewer name is required');
if (!row.vendor_id || row.vendor_id !== body.vendor_id) return fail(`no assessment found for ${body.vendor_id}`);

const blocked = row.blocked === true || row.blocked === 'true';
// Policy section 3: a blocked vendor needs a written exception to be approved.
if (decision === 'approved' && blocked && note.length < 20) {
  return fail('this vendor is blocked; approving it needs an exception note of at least 20 characters');
}
if (decision === 'info_requested' && !note) return fail('write what the vendor should send');

const name = esc((row.contact_name || '').split(' ')[0] || 'there');
const sign = `<p>Kind regards,<br>${esc(cfg.desk_name)}</p>`;
const wrap = inner => `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#212529;max-width:560px"><p>Dear ${name},</p>${inner}${sign}</div>`;

const emails = {
  approved: {
    subject: `Your vendor registration is approved – ${row.vendor_id}`,
    html: wrap(`<p>We are glad to let you know that ${esc(row.company_name)} has been approved as a supplier to ${esc(cfg.company_short)}. A buyer from our procurement team will contact you within a week about your vendor code and next steps.</p>`),
  },
  info_requested: {
    subject: `We need a few more details – ${row.vendor_id}`,
    html: wrap(`<p>Thank you for completing our vendor form. Before we can finish reviewing ${esc(row.company_name)}, we need the following:</p><p style="white-space:pre-line;border-left:3px solid #4ec3ec;padding-left:12px">${esc(note)}</p><p>Please reply to this email with the documents attached and keep your reference ${row.vendor_id} in the subject.</p>`),
  },
  rejected: {
    subject: `Your vendor registration – ${row.vendor_id}`,
    html: wrap(`<p>Thank you for your interest in supplying ${esc(cfg.company_short)}. After reviewing your submission we are not able to add ${esc(row.company_name)} to our supplier list at this time. You are welcome to apply again in twelve months.</p>`),
  },
};

return [{
  json: {
    ok: true,
    notify: body.notify !== false && Boolean(row.contact_email),
    contact_email: row.contact_email,
    email_subject: emails[decision].subject,
    email_html: emails[decision].html,
    vendor_id: row.vendor_id,
    status: decision,
    // Replies go into the vendor's original thread when we have it.
    message_id: row.message_id || '',
    // Exactly the columns updated in the "ebm_vendors" Data Table.
    update: {
      vendor_id: row.vendor_id,
      status: decision,
      reviewer,
      reviewer_note: decision === 'approved' && blocked ? '[Exception] ' + note : note,
      decided_at: new Date().toISOString(),
    },
  },
}];
