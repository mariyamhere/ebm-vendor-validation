// Three web searches per vendor: who they are, anything adverse about the
// company or its directors, and what their own site claims.

const out = [];
for (const { json: v } of $input.all()) {
  const name = `"${v.company_name}"`;
  const people = v.directors
    .replace(/\(.*?\)/g, '')
    .split(/[,;\n]| and /)
    .map(s => s.trim())
    .filter(s => s.split(' ').length >= 2)
    .slice(0, 2)
    .map(s => `"${s}"`);

  const queries = [
    `${name} ${v.city} Pakistan`,
    `${[name, ...people].join(' OR ')} fraud OR lawsuit OR debarred OR adulteration OR penalty OR FIR`,
    v.website ? `${v.website} ${v.company_name} certification clients` : `${name} ${v.offering.split(/[,.]/)[0]} supplier reviews`,
  ];
  queries.forEach((query, n) => out.push({
    json: { vendor_id: v.vendor_id, purpose: ['profile', 'adverse', 'claims'][n], query },
  }));
}
return out;
