// Three web searches: who they are, anything adverse about the company or its
// directors, and what their own site claims.

const v = $('Normalize Vendor').first().json;
const name = `"${v.company_name}"`;
const people = v.director_list.slice(0, 2).map(s => `"${s}"`);

const queries = [
  ['profile', `${name} ${v.city} Pakistan`],
  ['adverse', `${[name, ...people].join(' OR ')} fraud OR lawsuit OR debarred OR adulteration OR penalty OR FIR`],
  ['claims', v.website ? `${v.website} ${v.company_name} certification clients` : `${name} ${v.offering.split(/[,.]/)[0]} supplier reviews`],
];
return queries.map(([purpose, query]) => ({ json: { vendor_id: v.vendor_id, purpose, query } }));
