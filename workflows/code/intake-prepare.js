// @include _helpers.js
// Cleans each new Gmail message, drops mail we sent ourselves, and builds the
// triage request for OpenRouter.

const cfg = $('Config').first().json;
const ourAddress = String(cfg.intake_email || '').toLowerCase();

const TRIAGE_PROMPT = `You sort the inbox of a biscuit manufacturer's procurement desk.
Decide whether the email is from a business that wants to become a supplier, vendor, carrier or service provider.
Customer complaints, job applications, invoices from existing suppliers, newsletters and spam are not.
Reply with JSON only, no prose:
{"is_vendor_inquiry": true|false, "confidence": 0.0-1.0, "company_name": "", "contact_name": "", "website": "", "category_guess": "Raw materials|Packaging (food contact)|Packaging (secondary)|Logistics and warehousing|Services and indirect|Unknown", "summary": "one sentence"}`;

function address(field) {
  if (!field) return { address: '', name: '' };
  if (field.value && field.value[0]) {
    return { address: field.value[0].address || '', name: field.value[0].name || '' };
  }
  if (typeof field === 'string') {
    const angle = field.match(/<([^>]+)>/);
    return {
      address: (angle ? angle[1] : field).trim(),
      name: field.replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
    };
  }
  return { address: '', name: '' };
}

function bodyText(m) {
  if (m.text) return m.text;
  if (m.html) return m.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  return m.snippet || '';
}

const out = [];
for (const item of $('Gmail Trigger').all()) {
  const m = item.json;
  const from = address(m.from);
  const replyTo = address(m.replyTo);
  // Reply-To wins so the demo can send mock vendor mail from our own account.
  const vendor = replyTo.address ? replyTo : from;
  const vendorEmail = vendor.address.toLowerCase();

  // Our own form-link emails land back in the inbox when a vendor address is
  // a plus-alias of this mailbox. They have no Reply-To, so this drops them.
  if (!vendorEmail || vendorEmail === ourAddress) continue;

  const subject = m.subject || '';
  // Strip quoted history so the model reads only the new message.
  const body = clip(bodyText(m).split(/\n(?:On .+wrote:|-----Original Message-----)/)[0], 4000);

  out.push({
    json: {
      message_id: m.id,
      thread_id: m.threadId,
      vendor_email: vendorEmail,
      sender_name: vendor.name || from.name,
      subject,
      body,
      received_at: m.date || new Date().toISOString(),
      request: {
        models: [cfg.triage_model, cfg.fallback_model].filter(Boolean),
        temperature: 0,
        messages: [
          { role: 'system', content: TRIAGE_PROMPT },
          { role: 'user', content: `From: ${vendor.name} <${vendorEmail}>\nSubject: ${subject}\n\n${body}` },
        ],
      },
    },
  });
}
return out;
