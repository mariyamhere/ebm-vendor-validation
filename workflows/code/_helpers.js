// Shared helpers. build.py pastes this file into every Code node that has the
// include line at its top, so n8n needs no external modules.

// Same algorithm runs in the Apps Script seeder, so a vendor keeps one ID
// from the first email through the form and the assessment.
function vendorIdFor(email) {
  const s = String(email || '').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'EBM-V-' + h.toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

// Models sometimes wrap JSON in fences or add a sentence before it.
function parseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { return null; }
}

function llmText(response) {
  const choice = response && response.choices && response.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+\n/g, '\n').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
