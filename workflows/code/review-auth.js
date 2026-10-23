// Lets a data call through only with a live session pass from the review page.

const query = $input.first().json.query || {};
const sessions = $getWorkflowStaticData('global').sessions || {};
const exp = sessions[String(query.t || '')];

return [{ json: { ok: Boolean(exp && exp > Date.now()) } }];
