// Turns "ebm_vendors" rows into the vendor objects the review page shows.
// Only vendors who have submitted the form (and so have an assessment) are listed.

function parse(s) {
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
const list = x => (Array.isArray(x) ? x : []);

const vendors = $input.all()
  .map(i => i.json)
  .filter(r => r.vendor_id && r.assessment)
  .map(r => {
    const a = parse(r.assessment) || {};
    return {
      ...a,
      vendor_id: r.vendor_id,
      status: r.status || 'pending_review',
      reviewer: r.reviewer || null,
      reviewer_note: r.reviewer_note || null,
      decided_at: r.decided_at || null,
      score: r.score == null || r.score === '' ? null : Number(r.score),
      tier: r.tier || a.tier,
      blocked: r.blocked === true || r.blocked === 'true',
      criteria: list(a.criteria),
      knockouts: list(a.knockouts),
      red_flags: list(a.red_flags),
      web_findings: list(a.web_findings),
      questions: list(a.questions),
      form: a.form || {},
      official_checks: a.official_checks || {},
      raw_model_output: undefined,
    };
  });

return [{ json: { vendors, fetched_at: new Date().toISOString() } }];
