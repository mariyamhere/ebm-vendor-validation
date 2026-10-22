// @include _helpers.js
// Maps Google Form column titles to field keys and joins each response to the
// email the vendor first sent us.

const FIELDS = /*@form_fields*/[];

const intake = {};
for (const row of $('Read Intake').all()) {
  if (row.json.vendor_id) intake[row.json.vendor_id] = row.json;
}

return $('Form Response Trigger').all().map(({ json: row }) => {
  const v = {};
  for (const f of FIELDS) v[f.key] = String(row[f.title] == null ? '' : row[f.title]).trim();

  v.contact_email = v.contact_email.toLowerCase();
  // A vendor who opens a forwarded or bare form link has no reference ID.
  if (!/^EBM-V-/.test(v.vendor_id)) v.vendor_id = vendorIdFor(v.contact_email);
  v.form_submitted_at = row.Timestamp || new Date().toISOString();
  v.website = v.website.replace(/^https?:\/\//i, '').replace(/\/$/, '');

  const first = intake[v.vendor_id] || {};
  v.original_email = first.email_body ? `Subject: ${first.subject}\n\n${first.email_body}` : '';
  return { json: v };
});
