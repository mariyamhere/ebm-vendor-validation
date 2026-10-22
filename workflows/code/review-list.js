// Turns Assessment rows back into objects for the Vendor Desk page.

const JSON_COLUMNS = ['criteria_json', 'knockouts_json', 'red_flags_json', 'web_findings_json', 'questions_json', 'form_json'];

function parse(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

const vendors = $input.all()
  .map(i => i.json)
  .filter(r => r.vendor_id)
  .map(r => {
    const v = { ...r };
    for (const col of JSON_COLUMNS) {
      v[col.replace(/_json$/, '')] = parse(r[col], col === 'form_json' ? {} : []);
      delete v[col];
    }
    delete v.raw_model_output;
    delete v.row_number;
    v.score = r.score === '' ? null : Number(r.score);
    v.blocked = r.blocked === true || String(r.blocked).toUpperCase() === 'TRUE';
    return v;
  });

return [{ json: { vendors, fetched_at: new Date().toISOString() } }];
