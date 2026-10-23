// Runs one Code node from dist/ with stubbed $() outputs: node tests/run-node.js <workflow.json> <node name> <outputs.json>
const fs = require('fs');
const [wfFile, nodeName, outFile] = process.argv.slice(2);
const wf = JSON.parse(fs.readFileSync(wfFile));
const n = wf.nodes.find(x => x.name === nodeName);
const outputs = JSON.parse(fs.readFileSync(outFile));
const wrap = a => a.map(json => ({ json }));
const $ = name => { const items = wrap(outputs[name] || []); return { all: () => items, first: () => items[0] || { json: {} } }; };
const input = wrap(outputs.$input || []);
const res = new Function('$', '$input', n.parameters.jsCode)($, { all: () => input, first: () => input[0] });
console.log(JSON.stringify(res.map(r => r.json), null, 1));
