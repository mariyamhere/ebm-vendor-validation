// @include _helpers.js
// Reads the model's verdict, falls back to keywords if the free model failed,
// and prepares the vendor record and the form-link email.

const cfg = $('Config').first().json;
const emails = $('Prepare Email').all();
const KEYWORDS = /\b(supplier|vendor|supply|suppliers|registration|onboard|quotation|carrier|distribut|manufactur)/i;

return $input.all().map((item, i) => {
  const e = emails[i].json;
  const verdict = parseJson(llmText(item.json));
  const usedFallback = !verdict;
  const isVendor = verdict
    ? verdict.is_vendor_inquiry === true && Number(verdict.confidence || 0) >= 0.5
    : KEYWORDS.test(e.subject + ' ' + e.body);
  const t = verdict || {};

  // One vendor per email thread, so several test vendors can share one sender.
  const vendorId = 'EBM-' + String(e.thread_id || e.message_id).slice(-6).toUpperCase();
  // The n8n form fills its hidden "vendor_id" field from the query string.
  const formLink = `${cfg.form_url}?vendor_id=${encodeURIComponent(vendorId)}`;

  const firstName = (t.contact_name || e.sender_name || '').split(' ')[0];
  const replyHtml = `
<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#212529;max-width:560px">
  <p>${firstName ? 'Dear ' + esc(firstName) : 'Hello'},</p>
  <p>Thank you for writing to us about supplying ${esc(cfg.company_short)}. To start your registration, please fill in our vendor information form. It takes about ten minutes; keep your NTN, STRN, SECP registration number and certificate details nearby.</p>
  <p style="margin:22px 0"><a href="${esc(formLink)}" style="background:#343579;color:#ffffff;padding:11px 20px;border-radius:22px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px">Open the vendor form</a></p>
  <p>Your reference is <b>${vendorId}</b>. Please quote it if you write to us again. Our team reviews every submission and replies within five working days.</p>
  <p>Kind regards,<br>${esc(cfg.desk_name)}</p>
</div>`;

  return {
    json: {
      is_vendor: isVendor,
      // Exactly the columns of the "ebm_vendors" Data Table.
      row: {
        vendor_id: vendorId,
        contact_email: e.vendor_email,
        sender_name: e.sender_name || '',
        company_name: t.company_name || '',
        thread_id: e.thread_id || '',
        message_id: e.message_id || '',
        subject: e.subject,
        email_body: e.body,
        status: 'form_sent',
        received_at: e.received_at ? new Date(e.received_at).toISOString() : new Date().toISOString(),
        note: usedFallback ? 'AI unavailable, keyword match used' : `AI confidence ${t.confidence}`,
      },
      message_id: e.message_id,
      vendor_id: vendorId,
      contact_email: e.vendor_email,
      reply_subject: /^re:/i.test(e.subject) ? e.subject : 'Re: ' + e.subject,
      reply_html: replyHtml,
    },
  };
});
