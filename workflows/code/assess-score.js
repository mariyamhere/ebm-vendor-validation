// @include _helpers.js
// The model scores each criterion; the weighted total, tier and blocking rules
// are computed here. Official check failures override the model.

const cfg = $('Config').first().json;
const policy = $('Get GRC Policy').first().json.content || '';
const v = $('Normalize Vendor').first().json;
const official = $('Official Results').first().json;
const item = $input.first();

// Weights come from lines like "C2 — Food safety ... (weight 20)" in the GRC doc.
const FALLBACK = {
  C1: ['Legal and tax compliance', 15], C2: ['Food safety and quality certification', 20],
  C3: ['Financial stability', 15], C4: ['Operational capacity and delivery', 15],
  C5: ['Ethics, labour and environment', 10], C6: ['Reputation and public record', 15],
  C7: ['Commercial terms and references', 10],
};
const weights = {};
for (const m of policy.matchAll(/\b(C\d{1,2})\s*[—–-]\s*([^\n(]+?)\s*\(weight\s*(\d+)\)/gi)) {
  weights[m[1].toUpperCase()] = [m[2].trim(), Number(m[3])];
}
const rubric = Object.keys(weights).length ? weights : FALLBACK;
const totalWeight = Object.values(rubric).reduce((s, [, w]) => s + w, 0);

const tierFor = (score, blocked) => blocked ? 'Blocked' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';

// Official results that block or need a person, whatever the model said.
const officialBlocks = official.lines.filter(l => l.result === 'fail')
  .map(l => ({ rule: 'K4', reason: l.text }));
const officialWarnings = official.lines.filter(l => l.result === 'warn').map(l => l.text);

const raw = llmText(item.json);
const a = parseJson(raw);

const record = {
  vendor_id: v.vendor_id,
  company_name: v.company_name,
  contact_name: v.contact_name,
  contact_email: v.contact_email,
  phone: v.phone,
  category: v.category,
  city: v.city,
  website: v.website,
  years_in_business: v.years_in_business,
  turnover: v.turnover,
  payment_terms: v.payment_terms,
  certifications: v.certifications,
  official_checks: official,
  form: (({ original_email, director_list, secp_query, ...f }) => f)(v),
  assessed_at: new Date().toISOString(),
  model: (item.json && item.json.model) || null,
  status: 'pending_review',
  reviewer: null, reviewer_note: null, decided_at: null,
};

if (!a || !Array.isArray(a.criteria)) {
  const why = item.json && item.json.error ? String(item.json.error.message || item.json.error) : 'the AI reply was not readable';
  Object.assign(record, {
    score: null, tier: officialBlocks.length ? 'Blocked' : 'Unscored', blocked: officialBlocks.length > 0,
    summary: `The automatic assessment did not finish (${why}). Please review this supplier by hand.`,
    recommendation: officialBlocks.length ? 'reject' : 'send_back',
    criteria: [], knockouts: officialBlocks, red_flags: [...officialWarnings, why], web_findings: [], questions: [],
    raw_model_output: clip(raw, 4000),
  });
} else {
  const byId = {};
  for (const c of a.criteria) byId[String(c.id).toUpperCase()] = c;
  const criteria = Object.entries(rubric).map(([id, [name, weight]]) => {
    const c = byId[id] || {};
    return { id, name, weight, score: Math.max(0, Math.min(5, Number(c.score) || 0)), evidence: c.evidence || 'Not assessed.' };
  });
  const score = Math.round(criteria.reduce((sum, c) => sum + (c.score / 5) * c.weight, 0) * 100 / totalWeight);
  const modelBlocks = (a.knockouts || []).filter(k => k.triggered === true || k.triggered === 'true')
    .map(k => ({ rule: k.rule, reason: k.reason }));
  const knockouts = [...officialBlocks, ...modelBlocks];
  const blocked = knockouts.length > 0;
  let tier = tierFor(score, blocked);
  // A register mismatch is not a ban, but it should never read as "Looks good".
  if (!blocked && officialWarnings.length && (tier === 'A' || tier === 'B')) tier = 'C';

  Object.assign(record, {
    score, tier, blocked,
    summary: a.summary || '',
    recommendation: blocked ? 'reject' : (a.recommendation || ''),
    criteria, knockouts,
    red_flags: [...officialWarnings, ...(a.red_flags || [])],
    web_findings: (a.web_findings || []).slice(0, 8),
    questions: a.questions_for_vendor || [],
    raw_model_output: null,
  });
}

const notifyHtml = `
<div style="font-family:Arial,sans-serif;color:#212529;font-size:15px;line-height:1.5;max-width:560px">
  <p><b>${esc(record.company_name)}</b> (${esc(record.category)}, ${esc(record.city)}) is ready for review.</p>
  ${record.score != null ? `<p style="font-size:28px;margin:6px 0">${record.score}<span style="font-size:15px"> out of 100</span></p>` : ''}
  ${record.blocked ? `<p style="color:#c42e1c"><b>Not allowed:</b> ${record.knockouts.map(k => esc(k.reason)).join(' ')}</p>` : ''}
  <p>${esc(record.summary)}</p>
  <p><a href="${esc(cfg.review_url)}?vendor=${encodeURIComponent(record.vendor_id)}" style="color:#343579">Review this supplier</a></p>
</div>`;

// The Data Table keeps a few columns for sorting and the full assessment as JSON.
const row = {
  vendor_id: record.vendor_id,
  contact_email: record.contact_email,
  company_name: record.company_name,
  status: 'pending_review',
  score: record.score,
  tier: record.tier,
  blocked: record.blocked,
  assessment: JSON.stringify(record),
  assessed_at: record.assessed_at,
};

return [{ json: { row, record, notify_html: notifyHtml, subject: `Supplier ready for review: ${record.company_name}${record.score != null ? ' · ' + record.score + '/100' : ''}` } }];
