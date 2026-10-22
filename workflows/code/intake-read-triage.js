// @include _helpers.js
// Reads the model's verdict, falls back to keywords if the free model failed,
// and prepares the Intake row and the form-link email.

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

  const vendorId = vendorIdFor(e.vendor_email);
  const company = t.company_name || '';
  const formLink = String(cfg.form_prefill_url)
    .replace('{{vendor_id}}', encodeURIComponent(vendorId))
    .replace('{{company_name}}', encodeURIComponent(company))
    .replace('{{contact_email}}', encodeURIComponent(e.vendor_email));

  const firstName = (t.contact_name || e.sender_name || '').split(' ')[0];
  const replyHtml = `
<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#212529;max-width:560px">
  <p>${firstName ? 'Dear ' + esc(firstName) : 'Hello'},</p>
  <p>Thank you for writing to us about supplying ${esc(cfg.company_short)}. To start your registration, please fill in our vendor information form. It takes about ten minutes; keep your NTN, STRN and certificate details nearby.</p>
  <p style="margin:22px 0"><a href="${esc(formLink)}" style="background:#343579;color:#ffffff;padding:11px 20px;border-radius:22px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px">Open the vendor form</a></p>
  <p>Your reference is <b>${vendorId}</b>. Please quote it if you write to us again. Our team reviews every submission and replies within five working days.</p>
  <p>Kind regards,<br>${esc(cfg.desk_name)}</p>
</div>`;

  return {
    json: {
      is_vendor: isVendor,
      vendor_id: vendorId,
      contact_email: e.vendor_email,
      sender_name: e.sender_name,
      company_name: company,
      website: t.website || '',
      category_guess: t.category_guess || 'Unknown',
      subject: e.subject,
      email_summary: t.summary || '',
      email_body: e.body,
      received_at: e.received_at,
      form_sent_at: new Date().toISOString(),
      status: 'form_sent',
      triage_note: usedFallback ? 'model unavailable, keyword match used' : `confidence ${t.confidence}`,
      // Not written to the sheet (extra fields are ignored there).
      reply_subject: /^re:/i.test(e.subject) ? e.subject : 'Re: ' + e.subject,
      reply_html: replyHtml,
      message_id: e.message_id,
    },
  };
});
