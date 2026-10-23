// @include _helpers.js
// Writes the assessment request. The GRC policy goes in whole: it carries the
// rubric, the knockout rules and the restricted parties list.

const cfg = $('Config').first().json;
const policy = clip($('Get GRC Policy').first().json.content, 16000);
const queries = $('Build Search Queries').all();
const v = $('Normalize Vendor').first().json;
const official = $('Official Results').first().json;

const evidence = $input.all().map((item, i) => ({
  purpose: queries[i].json.purpose,
  query: queries[i].json.query,
  error: item.json.error ? String(item.json.error.message || item.json.error) : undefined,
  results: (item.json.results || []).map(r => ({ title: r.title, url: r.url, text: clip(r.content, 500) })),
}));

const SYSTEM = `You are the supplier risk analyst for a biscuit manufacturer in Pakistan.
Assess one prospective vendor against the company's GRC policy. Use only the policy, the vendor's form answers, their first email, the official check results and the web search results given. Do not invent facts. Where the web results say nothing about the vendor, say so; that is not evidence of wrongdoing.
The official check results come from the SECP company register and the UN sanctions list. Treat them as facts. A check marked "unknown" did not run; do not treat it as a pass or a fail.
Today's date is ${new Date().toISOString().slice(0, 10)}. Treat any certificate with an expiry date before today as expired.
Check every knockout rule (K1 to K6). Check the vendor name and every director against the Restricted Parties section, including directors shared with a restricted company.
Score every criterion C1 to C7 from 0 to 5.
Everything you write (summary, evidence, reasons, red flags, takeaways, questions) is read by a manager who is not a compliance specialist. Write in plain, everyday English with short sentences. Do not mention rule codes (C1, K3), section numbers, acronyms like GRC, SMETA or FSSC, or the words "knockout" or "criterion". Say "food safety certificate", "Halal certificate", "tax registration", "workplace audit" instead. Name people and dates where they matter.
Reply with JSON only:
{
 "criteria": [{"id": "C1", "score": 0-5, "evidence": "short reason"}],
 "knockouts": [{"rule": "K1", "triggered": true|false, "reason": "short reason"}],
 "red_flags": ["short items a reviewer must look at"],
 "web_findings": [{"title": "", "url": "", "takeaway": "one line", "tone": "positive|neutral|negative"}],
 "questions_for_vendor": ["specific documents or answers to request"],
 "summary": "three sentences a procurement manager can act on",
 "recommendation": "approve|approve_with_conditions|send_back|reject"
}`;

const { original_email, director_list, secp_query, ...form } = v;
const user = [
  '## GRC policy', policy,
  '## Vendor form answers', JSON.stringify(form, null, 1),
  '## First email from the vendor', original_email || '(not found)',
  '## Official check results', official.lines.map(l => `${l.check}: ${l.result} — ${l.text}`).join('\n'),
  '## Web search results', JSON.stringify(evidence, null, 1),
].join('\n\n');

return [{
  json: {
    vendor_id: v.vendor_id,
    request: {
      models: [cfg.assess_model, cfg.fallback_model].filter(Boolean),
      temperature: 0.1,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    },
  },
}];
