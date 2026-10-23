#!/usr/bin/env python3
"""Builds the n8n workflows for the EBM Vendor Validation System (proof of concept).

    python3 build.py        # writes dist/*.json from config.json (or config.example.json)

Everything runs inside n8n: Gmail for email, an n8n Form for the vendor form, an n8n
Data Table ("ebm_vendors") for storage, a Google Doc for the policy, OpenRouter for the
AI and Tavily for web research. Code node bodies live in workflows/code/*.js.
"""
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).parent
CODE = ROOT / "workflows" / "code"
DIST = ROOT / "dist"
NS = uuid.UUID("6f1c2b0e-8f7a-4c55-9a51-0e0b3c7d2a10")
FORM = json.loads((ROOT / "mock" / "form-spec.json").read_text())
TABLE = "ebm_vendors"
FORM_PATH = "ebm-vendor-form"

# Columns of the one Data Table. Intake fills the first block, Assess the second, Review the third.
COLUMNS = [
    ("vendor_id", "string"), ("contact_email", "string"), ("sender_name", "string"), ("company_name", "string"),
    ("thread_id", "string"), ("message_id", "string"), ("subject", "string"), ("email_body", "string"),
    ("received_at", "string"), ("note", "string"),
    ("status", "string"), ("score", "number"), ("tier", "string"), ("blocked", "boolean"),
    ("assessment", "string"), ("assessed_at", "string"),
    ("reviewer", "string"), ("reviewer_note", "string"), ("decided_at", "string"),
]


def load_config():
    path = ROOT / "config.json"
    if not path.exists():
        print("config.json not found: building from config.example.json")
        path = ROOT / "config.example.json"
    return json.loads(path.read_text())


def code(name):
    src = (CODE / name).read_text()
    if src.startswith("// @include _helpers.js"):
        src = (CODE / "_helpers.js").read_text() + "\n" + src.split("\n", 1)[1]
    fields = [{"key": f["key"], "title": f["title"]} for f in FORM["fields"]]
    return src.replace("/*@form_fields*/[]", json.dumps(fields, indent=2))


# ---------- node builders ----------

def node(wf, name, type_, version, params, **extra):
    n = {"id": str(uuid.uuid5(NS, wf + "/" + name)), "name": name, "type": type_,
         "typeVersion": version, "position": [0, 0], "parameters": params}
    n.update(extra)
    return n


def code_node(wf, name, file):
    return node(wf, name, "n8n-nodes-base.code", 2, {"jsCode": code(file)})


def config_node(wf, cfg, keys):
    return node(wf, "Config", "n8n-nodes-base.set", 3.4, {
        "assignments": {"assignments": [
            {"id": str(uuid.uuid5(NS, wf + "/cfg/" + k)), "name": k, "value": str(cfg[k]), "type": "string"}
            for k in keys]},
        "options": {},
    }, executeOnce=True, notes="All settings for this workflow live here.")


def row_only(wf, name, expr):
    """Passes on just the table columns, so the Data Table node can map them automatically."""
    return node(wf, name, "n8n-nodes-base.set", 3.4, {
        "mode": "raw", "jsonOutput": "={{ JSON.stringify(" + expr + ") }}", "options": {},
    })


def table_ref():
    return {"__rl": True, "mode": "name", "value": TABLE}


def by_vendor_id(expr):
    return {"conditions": [{"keyName": "vendor_id", "condition": "eq", "keyValue": expr}]}


def table_upsert(wf, name):
    return node(wf, name, "n8n-nodes-base.dataTable", 1, {
        "resource": "row", "operation": "upsert", "dataTableId": table_ref(),
        "matchType": "allConditions", "filters": by_vendor_id("={{ $json.vendor_id }}"),
        "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": []},
        "options": {},
    })


def table_get(wf, name, filters=None, **extra):
    p = {"resource": "row", "operation": "get", "dataTableId": table_ref(), "matchType": "allConditions"}
    if filters:
        p["filters"] = filters
    else:
        p["returnAll"] = True
    return node(wf, name, "n8n-nodes-base.dataTable", 1, p, **extra)


def openrouter(wf, name, interval_ms):
    return node(wf, name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "https://openrouter.ai/api/v1/chat/completions",
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True, "headerParameters": {"parameters": [{"name": "X-Title", "value": "EBM Vendor Validation"}]},
        "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.request) }}",
        "options": {"batching": {"batch": {"batchSize": 1, "batchInterval": interval_ms}}, "timeout": 180000},
    }, retryOnFail=True, maxTries=5, waitBetweenTries=5000, onError="continueRegularOutput",
       notes="Credential: Header Auth 'OpenRouter' (Authorization: Bearer sk-or-…)")


def gmail_send(wf, name, to, subject, html):
    return node(wf, name, "n8n-nodes-base.gmail", 2.1, {
        "resource": "message", "operation": "send", "sendTo": to, "subject": subject,
        "emailType": "html", "message": html,
        "options": {"appendAttribution": False, "senderName": "={{ $('Config').first().json.desk_name }}"},
    })


def gmail_reply(wf, name, message_id, html):
    """Replies inside the vendor's original thread, to the sender only."""
    return node(wf, name, "n8n-nodes-base.gmail", 2.1, {
        "resource": "message", "operation": "reply", "messageId": message_id,
        "emailType": "html", "message": html,
        "options": {"appendAttribution": False, "replyToSenderOnly": True,
                    "senderName": "={{ $('Config').first().json.desk_name }}"},
    })


def if_true(wf, name, expr):
    return node(wf, name, "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": str(uuid.uuid5(NS, wf + "/if/" + name)), "leftValue": expr, "rightValue": "",
                            "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and"},
        "options": {}})


def sticky(wf, name, text, pos, w=520, h=200):
    n = node(wf, name, "n8n-nodes-base.stickyNote", 1, {"content": text, "width": w, "height": h})
    n["position"] = pos
    return n


def workflow(name, nodes, edges, layout):
    for n in nodes:
        if n["name"] in layout:
            c, r = layout[n["name"]]
            n["position"] = [c * 240, r * 200]
    names = {n["name"] for n in nodes}
    conns = {}
    for e in edges:
        src, dst, out = (e + (0,))[:3]
        assert src in names and dst in names, e
        main = conns.setdefault(src, {"main": []})["main"]
        while len(main) <= out:
            main.append([])
        main[out].append({"node": dst, "type": "main", "index": 0})
    return {"name": name, "nodes": nodes, "connections": conns, "pinData": {},
            "settings": {"executionOrder": "v1"}}


def line(order, row=0):
    return {n: (i, row) for i, n in enumerate(order)}


# ---------- 0. setup ----------

def build_setup(cfg):
    wf = "setup"
    nodes = [
        node(wf, "Run once", "n8n-nodes-base.manualTrigger", 1, {}),
        node(wf, "Create vendor table", "n8n-nodes-base.dataTable", 1, {
            "resource": "table", "operation": "create", "tableName": TABLE,
            "columns": {"column": [{"name": c, "type": t} for c, t in COLUMNS]},
            "options": {"createIfNotExists": True}}),
        sticky(wf, "About", "## 0 · Setup\nRun once. Creates the **ebm_vendors** Data Table that the other three workflows use. Running it again changes nothing.", [-40, -240], 460, 160),
    ]
    return workflow("EBM Vendors · 0 Setup (run once)", nodes, [("Run once", "Create vendor table")],
                    line(["Run once", "Create vendor table"]))


# ---------- 1. intake ----------

def build_intake(cfg):
    wf = "intake"
    nodes = [
        node(wf, "Gmail Trigger", "n8n-nodes-base.gmailTrigger", 1.2, {
            "pollTimes": {"item": [{"mode": "everyMinute"}]}, "simple": False,
            # Never our own mail, so replies we send can't loop back in.
            "filters": {"q": "in:inbox -from:me -category:promotions -category:social", "readStatus": "both"},
            "options": {}}),
        config_node(wf, cfg, ["intake_email", "form_url", "company_short", "desk_name", "triage_model", "fallback_model"]),
        code_node(wf, "Prepare Email", "intake-prepare.js"),
        openrouter(wf, "Triage with AI", 3500),
        code_node(wf, "Read Triage", "intake-read-triage.js"),
        if_true(wf, "Vendor inquiry?", "={{ $json.is_vendor }}"),
        node(wf, "New vendor thread?", "n8n-nodes-base.dataTable", 1, {
            "resource": "row", "operation": "rowNotExists", "dataTableId": table_ref(),
            "matchType": "allConditions", "filters": by_vendor_id("={{ $json.vendor_id }}")},
            notes="Stops a second email in the same thread from resending the form."),
        row_only(wf, "Vendor Row", "$json.row"),
        table_upsert(wf, "Save Vendor"),
        gmail_reply(wf, "Reply with Form Link", "={{ $('Read Triage').item.json.message_id }}",
                    "={{ $('Read Triage').item.json.reply_html }}"),
        node(wf, "Leave for a person", "n8n-nodes-base.noOp", 1, {}),
        sticky(wf, "About", "## 1 · Intake\nEvery minute: new inbox mail (never our own) is read by the AI. A supplier inquiry gets a reference ID, a row in **ebm_vendors**, and a reply **in the same thread** with their personal form link. Anything else is left for a person.", [-40, -260], 560, 180),
    ]
    order = ["Gmail Trigger", "Config", "Prepare Email", "Triage with AI", "Read Triage", "Vendor inquiry?",
             "New vendor thread?", "Vendor Row", "Save Vendor", "Reply with Form Link"]
    edges = [(a, b) for a, b in zip(order, order[1:]) if a != "Vendor inquiry?"]
    edges += [("Vendor inquiry?", "New vendor thread?", 0), ("Vendor inquiry?", "Leave for a person", 1)]
    layout = line(order)
    layout["Leave for a person"] = (6, 1)
    return workflow("EBM Vendors · 1 Intake", nodes, edges, layout)


# ---------- 2. assess ----------

def form_fields():
    out = []
    for f in FORM["fields"]:
        if f["type"] == "hidden":
            out.append({"fieldType": "hiddenField", "fieldName": f["key"]})
            continue
        fld = {"fieldLabel": f["title"], "fieldName": f["key"], "requiredField": bool(f.get("required"))}
        kind = f["type"]
        if kind == "paragraph":
            fld["fieldType"] = "textarea"
        elif kind == "email":
            fld["fieldType"] = "email"
        elif kind == "choice":
            fld["fieldType"] = "dropdown"
            fld["fieldOptions"] = {"values": [{"option": c} for c in f["choices"]]}
        elif kind == "checkbox":
            fld["fieldType"] = "checkbox"
            fld["fieldOptions"] = {"values": [{"option": c} for c in f["choices"]]}
        out.append(fld)
    return out


FORM_CSS = """
:root { --font-family: 'Figtree', Arial, sans-serif; --color-header: #343579; --color-label: #212529;
        --color-submit-btn-bg: #343579; --color-submit-btn-text: #ffffff; --color-focus-border: #4ec3ec;
        --border-radius-card: 18px; --border-radius-input: 10px; --color-background: #f7f4f2; }
"""


def build_assess(cfg):
    wf = "assess"
    http = lambda name, params, **kw: node(wf, name, "n8n-nodes-base.httpRequest", 4.2, params, **kw)
    nodes = [
        node(wf, "Vendor Form", "n8n-nodes-base.formTrigger", 2.2, {
            "formTitle": FORM["title"], "formDescription": FORM["description"],
            "formFields": {"values": form_fields()}, "responseMode": "onReceived",
            "options": {"appendAttribution": False, "path": FORM_PATH, "buttonLabel": "Submit",
                        "respondWithOptions": {"values": {"respondWith": "text", "formSubmittedText":
                            "Thank you. Our procurement team will review your details and reply to your email within five working days."}},
                        "customCss": FORM_CSS}},
            webhookId=str(uuid.uuid5(NS, wf + "/form"))),
        config_node(wf, cfg, ["approver_email", "review_url", "grc_doc_id", "company_short", "desk_name",
                              "assess_model", "fallback_model"]),
        node(wf, "Get GRC Policy", "n8n-nodes-base.googleDocs", 2, {
            "operation": "get", "documentURL": "={{ $('Config').first().json.grc_doc_id }}", "simple": True},
            executeOnce=True),
        table_get(wf, "Find Vendor", by_vendor_id("={{ $('Vendor Form').first().json.vendor_id }}"),
                  alwaysOutputData=True, executeOnce=True),
        code_node(wf, "Normalize Vendor", "assess-normalize.js"),
        http("SECP Search", {
            "method": "POST", "url": "https://eservices.secp.gov.pk/eServices/ControllerServlet",
            "sendBody": True, "contentType": "form-urlencoded",
            "bodyParameters": {"parameters": [
                {"name": "request_id", "value": "SEARCH_NAME"}, {"name": "requesterProcess", "value": ""},
                {"name": "searchName", "value": "={{ $('Normalize Vendor').first().json.secp_query }}"},
                {"name": "searchOption", "value": "Exact Name"}]},
            "options": {"response": {"response": {"responseFormat": "text"}}, "timeout": 30000}},
            onError="continueRegularOutput", alwaysOutputData=True),
        http("UN Sanctions List", {
            "method": "GET", "url": "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
            "options": {"response": {"response": {"responseFormat": "text"}}, "timeout": 60000}},
            onError="continueRegularOutput", alwaysOutputData=True),
        code_node(wf, "Official Results", "assess-official.js"),
        code_node(wf, "Build Search Queries", "assess-queries.js"),
        http("Web Search", {
            "method": "POST", "url": "https://api.tavily.com/search",
            "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ query: $json.query, search_depth: 'basic', max_results: 5, include_answer: false }) }}",
            "options": {"timeout": 30000}},
            retryOnFail=True, maxTries=2, waitBetweenTries=2000, onError="continueRegularOutput",
            notes="Credential: Header Auth 'Tavily' (Authorization: Bearer tvly-…)"),
        code_node(wf, "Build Assessment Prompt", "assess-prompt.js"),
        openrouter(wf, "Assess with AI", 1000),
        code_node(wf, "Score against GRC", "assess-score.js"),
        row_only(wf, "Assessment Row", "$json.row"),
        table_upsert(wf, "Save Assessment"),
        gmail_send(wf, "Tell the Approver", "={{ $('Config').first().json.approver_email }}",
                   "={{ $('Score against GRC').first().json.subject }}",
                   "={{ $('Score against GRC').first().json.notify_html }}"),
        sticky(wf, "About", "## 2 · Assess\nStarts when a vendor submits the form. Checks the **SECP** company register and the **UN** sanctions list, runs three web searches, and has the AI score the vendor against the policy Google Doc. Hard rules are applied in code, the result is saved to **ebm_vendors**, and the approver gets an email.", [-40, -300], 620, 200),
    ]
    order = ["Vendor Form", "Config", "Get GRC Policy", "Find Vendor", "Normalize Vendor", "SECP Search",
             "UN Sanctions List", "Official Results", "Build Search Queries", "Web Search", "Build Assessment Prompt",
             "Assess with AI", "Score against GRC", "Assessment Row", "Save Assessment", "Tell the Approver"]
    return workflow("EBM Vendors · 2 Assess", nodes, list(zip(order, order[1:])), line(order))


# ---------- 3. review API ----------

def build_review(cfg):
    wf = "review"
    hook = lambda name, method, path: node(wf, name, "n8n-nodes-base.webhook", 2, {
        "httpMethod": method, "path": path, "authentication": "headerAuth",
        "responseMode": "responseNode", "options": {"allowedOrigins": "*"}},
        webhookId=str(uuid.uuid5(NS, wf + "/hook/" + name)),
        notes="Credential: Header Auth 'Vendor Desk key' (Name: x-desk-key)")
    respond = lambda name, body, code=200: node(wf, name, "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "json", "responseBody": body, "options": {"responseCode": code}})
    saved = "={{ JSON.stringify({ ok: true, vendor_id: $('Check Decision').first().json.vendor_id, status: $('Check Decision').first().json.status, emailed: %s }) }}"
    nodes = [
        hook("List Webhook", "GET", "vendor-desk/vendors"),
        table_get(wf, "Read Vendors", alwaysOutputData=True),
        code_node(wf, "Shape for Desk", "review-list.js"),
        respond("Send List", "={{ JSON.stringify($json) }}"),

        hook("Decision Webhook", "POST", "vendor-desk/decision"),
        config_node(wf, cfg, ["company_short", "desk_name"]),
        table_get(wf, "Find Vendor", by_vendor_id("={{ $('Decision Webhook').first().json.body.vendor_id }}"),
                  alwaysOutputData=True),
        code_node(wf, "Check Decision", "review-check.js"),
        if_true(wf, "Valid?", "={{ $json.ok }}"),
        row_only(wf, "Decision Row", "$json.update"),
        table_upsert(wf, "Save Decision"),
        if_true(wf, "Email vendor?", "={{ $('Check Decision').first().json.notify }}"),
        if_true(wf, "Have their thread?", "={{ !!$('Check Decision').first().json.message_id }}"),
        gmail_reply(wf, "Reply in Thread", "={{ $('Check Decision').first().json.message_id }}",
                    "={{ $('Check Decision').first().json.email_html }}"),
        gmail_send(wf, "Email Vendor", "={{ $('Check Decision').first().json.contact_email }}",
                   "={{ $('Check Decision').first().json.email_subject }}",
                   "={{ $('Check Decision').first().json.email_html }}"),
        respond("Saved", saved % "true"),
        respond("Saved (sent)", saved % "true"),
        respond("Saved, no email", saved % "false"),
        respond("Rejected Request", "={{ JSON.stringify({ ok: false, error: $json.error }) }}", 400),
        sticky(wf, "About", "## 3 · Review API\nTwo webhooks for the review page, behind one header key. **GET vendor-desk/vendors** lists assessed vendors. **POST vendor-desk/decision** saves approve / ask for more / reject and replies to the vendor in their original email thread.", [-40, -300], 620, 200),
    ]
    edges = [("List Webhook", "Read Vendors"), ("Read Vendors", "Shape for Desk"), ("Shape for Desk", "Send List"),
             ("Decision Webhook", "Config"), ("Config", "Find Vendor"), ("Find Vendor", "Check Decision"),
             ("Check Decision", "Valid?"), ("Valid?", "Decision Row", 0), ("Valid?", "Rejected Request", 1),
             ("Decision Row", "Save Decision"), ("Save Decision", "Email vendor?"),
             ("Email vendor?", "Have their thread?", 0), ("Email vendor?", "Saved, no email", 1),
             ("Have their thread?", "Reply in Thread", 0), ("Have their thread?", "Email Vendor", 1),
             ("Reply in Thread", "Saved"), ("Email Vendor", "Saved (sent)")]
    layout = {"List Webhook": (0, 0), "Read Vendors": (1, 0), "Shape for Desk": (2, 0), "Send List": (3, 0),
              "Decision Webhook": (0, 1.5), "Config": (1, 1.5), "Find Vendor": (2, 1.5), "Check Decision": (3, 1.5),
              "Valid?": (4, 1.5), "Decision Row": (5, 1.2), "Save Decision": (6, 1.2), "Email vendor?": (7, 1.2),
              "Have their thread?": (8, 1), "Reply in Thread": (9, 0.8), "Email Vendor": (9, 1.4),
              "Saved": (10, 0.8), "Saved (sent)": (10, 1.4), "Saved, no email": (8, 1.9), "Rejected Request": (5, 2.2)}
    return workflow("EBM Vendors · 3 Review API", nodes, edges, layout)


def main():
    cfg = load_config()
    DIST.mkdir(exist_ok=True)
    for old in DIST.glob("*"):
        old.unlink()
    for file, wf in [("0-setup.json", build_setup(cfg)), ("1-intake.json", build_intake(cfg)),
                     ("2-assess.json", build_assess(cfg)), ("3-review-api.json", build_review(cfg))]:
        (DIST / file).write_text(json.dumps(wf, indent=2, ensure_ascii=False))
        print("wrote dist/" + file)


if __name__ == "__main__":
    main()
