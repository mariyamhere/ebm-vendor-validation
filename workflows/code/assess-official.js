// Runs the two official checks that need no database: the SECP company register
// and the UN Security Council sanctions list. A check that could not run is
// "unknown", never a pass.

const v = $('Normalize Vendor').first().json;
const secpHtml = String($('SECP Search').first().json.data || '');
const unXml = String($('UN Sanctions List').first().json.data || '');

// SECP returns an HTML table: Sr, Company Name, Status, CRO, Registration No., Registration Date, Last filing.
function secpRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    // SECP leaves some <td> tags unclosed, so split on cell starts instead of matching pairs.
    const cells = tr.split(/<td[^>]*>/i).slice(1)
      .map(td => td.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length >= 6 && /^\d+$/.test(cells[0])) {
      rows.push({ name: cells[1], status: cells[2], cro: cells[3], reg_no: cells[4], registered_on: cells[5], last_filing: cells[6] || '' });
    }
  }
  return rows;
}

// Lower-case, drop punctuation and legal suffixes so "Packages Ltd." matches "PACKAGES LIMITED".
const norm = s => String(s || '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(m s|pvt|private|ltd|limited|co|company|the|smc|llc|inc)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Every individual and entity name (and alias) on the UN list.
function unNames(xml) {
  const names = [];
  for (const block of xml.match(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g) || []) {
    const kind = block.startsWith('<INDIVIDUAL') ? 'individual' : 'entity';
    const ref = (block.match(/<REFERENCE_NUMBER>([^<]*)</) || [])[1] || '';
    const parts = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME']
      .map(t => (block.match(new RegExp(`<${t}>([^<]*)<`)) || [])[1]).filter(Boolean);
    if (parts.length) names.push({ kind, ref, name: parts.join(' ') });
    for (const a of block.match(/<ALIAS_NAME>([^<]*)</g) || []) names.push({ kind, ref, name: a.replace(/<\/?ALIAS_NAME>/g, '') });
  }
  return names;
}

const lines = [];

// SECP company register
const found = secpRows(secpHtml);
const regNo = String(v.secp_no || '').replace(/\D/g, '').replace(/^0+/, '');
const sameNo = r => regNo && r.reg_no.replace(/\D/g, '').replace(/^0+/, '') === regNo;
const match = found.find(sameNo) || found[0];
const secp = { query: v.secp_query, found: Boolean(match), match: match || null };
if (!secpHtml) {
  lines.push({ check: 'secp', result: 'unknown', text: 'Could not reach the SECP company register.' });
} else if (!match) {
  lines.push({ check: 'secp', result: 'warn', text: `No company named "${v.secp_query}" in the SECP register. It may be a sole trader or partnership, or the name differs.` });
} else if (regNo && !sameNo(match)) {
  lines.push({ check: 'secp', result: 'warn', text: `Registered with SECP, but under number ${match.reg_no}, not ${v.secp_no} as stated on the form.` });
} else {
  lines.push({ check: 'secp', result: 'pass', text: `Registered company since ${match.registered_on} (${match.status}, ${match.cro}).` });
}

// UN sanctions list: exact match on the normalised company name or any director's name
const listed = unXml ? unNames(unXml) : [];
const wanted = [v.company_name, ...v.director_list].map(n => ({ query: n, key: norm(n) })).filter(q => q.key.length >= 4);
const hits = [];
for (const q of wanted) {
  for (const e of listed) if (norm(e.name) === q.key) hits.push({ query: q.query, ...e });
}
if (!listed.length) {
  lines.push({ check: 'sanctions', result: 'unknown', text: 'Could not load the UN sanctions list.' });
} else if (hits.length) {
  lines.push({ check: 'sanctions', result: 'fail', text: `"${hits[0].query}" matches "${hits[0].name}" on the UN sanctions list (${hits[0].ref}). A person must check this.` });
} else {
  lines.push({ check: 'sanctions', result: 'pass', text: `Company and directors not on the UN sanctions list (${listed.length} names checked).` });
}

return [{ json: { secp, sanctions: { hits, names_checked: listed.length }, lines } }];
