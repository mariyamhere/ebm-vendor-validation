// @include _helpers.js
// The model scores each criterion; the weighted total, tier and knockout
// verdict are computed here so they always follow the policy's arithmetic.

const cfg = $('Config').first().json;
const policy = $('Get GRC Policy').first().json.content || '';
const vendors = $('Normalize Vendors').all();

// Weights come from lines like "C2 — Food safety ... (weight 20)" in the
// GRC doc, so procurement can re-weight by editing the doc.
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

// Section 5 of the policy.
function tierFor(score, blocked) {
  if (blocked) return 'Blocked';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

return $input.all().map((item, i) => {
  const v = vendors[i].json;
  const raw = llmText(item.json);
  const a = parseJson(raw);
  const now = new Date().toISOString();

  const base = {
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
    form_json: JSON.stringify(v),
    assessed_at: now,
    model: (item.json && item.json.model) || '',
    status: 'pending_review',
    reviewer: '', reviewer_note: '', decided_at: '',
  };

  if (!a || !Array.isArray(a.criteria)) {
    const why = item.json && item.json.error ? String(item.json.error.message || item.json.error) : 'model reply was not valid JSON';
    return { json: { ...base, score: '', tier: 'Unscored', blocked: false,
      summary: `Automatic assessment failed (${why}). Review the form by hand.`,
      recommendation: 'send_back', criteria_json: '[]', knockouts_json: '[]', red_flags_json: JSON.stringify([why]),
      web_findings_json: '[]', questions_json: '[]', raw_model_output: clip(raw, 4000) } };
  }

  const byId = {};
  for (const c of a.criteria) byId[String(c.id).toUpperCase()] = c;
  const criteria = Object.entries(rubric).map(([id, [name, weight]]) => {
    const c = byId[id] || {};
    const s = Math.max(0, Math.min(5, Number(c.score) || 0));
    return { id, name, weight, score: s, evidence: c.evidence || 'Not assessed by the model.' };
  });
  const score = Math.round(criteria.reduce((sum, c) => sum + (c.score / 5) * c.weight, 0) * 100 / totalWeight);
  const knockouts = (a.knockouts || []).filter(k => k.triggered === true || k.triggered === 'true');
  const blocked = knockouts.length > 0;

  return {
    json: {
      ...base,
      score,
      tier: tierFor(score, blocked),
      blocked,
      summary: a.summary || '',
      recommendation: blocked && /approve/.test(a.recommendation || '') ? 'reject' : (a.recommendation || ''),
      criteria_json: JSON.stringify(criteria),
      knockouts_json: JSON.stringify(knockouts.map(k => ({ rule: k.rule, reason: k.reason }))),
      red_flags_json: JSON.stringify(a.red_flags || []),
      web_findings_json: JSON.stringify((a.web_findings || []).slice(0, 8)),
      questions_json: JSON.stringify(a.questions_for_vendor || []),
      raw_model_output: '',
      // Used by the approver email only; the sheet ignores it.
      notify_html: `
<div style="font-family:Arial,sans-serif;color:#212529;font-size:15px;line-height:1.5;max-width:560px">
  <p><b>${esc(v.company_name)}</b> (${esc(v.category)}, ${esc(v.city)}) is ready for review.</p>
  <p style="font-size:28px;margin:6px 0">${score}<span style="font-size:15px"> out of 100</span></p>
  ${blocked ? `<p style="color:#c42e1c"><b>Not allowed:</b> ${knockouts.map(k => esc(k.reason)).join(' ')}</p>` : ''}
  <p>${esc(a.summary || '')}</p>
  <p><a href="${esc(cfg.review_url)}#${encodeURIComponent(v.vendor_id)}" style="color:#343579">Review this supplier</a></p>
</div>`,
    },
  };
});
