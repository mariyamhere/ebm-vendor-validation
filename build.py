#!/usr/bin/env python3
"""Builds the n8n workflows and the Google Apps Script for the EBM Vendor Desk.

    python3 build.py            # dist/ with placeholders, if config.json is missing
    python3 build.py            # dist/ ready to import, once config.json is filled in

Sources: workflows/code/*.js (Code node bodies), mock/*.json and mock/grc-policy.md.
"""
import json
import re
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).parent
CODE = ROOT / "workflows" / "code"
DIST = ROOT / "dist"
NS = uuid.UUID("6f1c2b0e-8f7a-4c55-9a51-0e0b3c7d2a10")

FORM = json.loads((ROOT / "mock" / "form-spec.json").read_text())


def load_config():
    path = ROOT / "config.json"
    if not path.exists():
        print("config.json not found: building with placeholders. Copy config.example.json to config.json after running the Apps Script.")
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
    n = {
        "id": str(uuid.uuid5(NS, wf + "/" + name)),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": [0, 0],
        "parameters": params,
    }
    n.update(extra)
    return n


def rl_id(value):
    return {"__rl": True, "mode": "id", "value": value}


def rl_name(value):
    return {"__rl": True, "mode": "name", "value": value}


def code_node(wf, name, file):
    return node(wf, name, "n8n-nodes-base.code", 2, {"jsCode": code(file)})


def config_node(wf, cfg, keys):
    return node(wf, "Config", "n8n-nodes-base.set", 3.4, {
        "assignments": {"assignments": [
            {"id": str(uuid.uuid5(NS, wf + "/cfg/" + k)), "name": k, "value": str(cfg[k]), "type": "string"}
            for k in keys
        ]},
        "options": {},
    }, executeOnce=True)


def openrouter_node(wf, name, interval_ms):
    return node(wf, name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True,
        "headerParameters": {"parameters": [{"name": "X-Title", "value": "Vendor Desk"}]},
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.request) }}",
        # The free tier allows about 20 requests a minute.
        "options": {"batching": {"batch": {"batchSize": 1, "batchInterval": interval_ms}}, "timeout": 180000},
    }, retryOnFail=True, maxTries=3, waitBetweenTries=5000, onError="continueRegularOutput",
       notes="Credential: Header Auth named 'OpenRouter' — Name: Authorization, Value: Bearer sk-or-…")


def sheets(wf, name, cfg, operation, sheet, **params):
    p = {
        "operation": operation,
        "documentId": rl_id(cfg["spreadsheet_id"]),
        "sheetName": rl_name(sheet),
    }
    p.update(params)
    return p


def upsert_columns(key):
    return {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [key], "schema": []}


def gmail_send(wf, name, to, subject, html):
    return node(wf, name, "n8n-nodes-base.gmail", 2.1, {
        "resource": "message",
        "operation": "send",
        "sendTo": to,
        "subject": subject,
        "emailType": "html",
        "message": html,
        "options": {"appendAttribution": False, "senderName": "={{ $('Config').first().json.desk_name }}"},
    })


def if_true(wf, name, expr):
    return node(wf, name, "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": str(uuid.uuid5(NS, wf + "/if/" + name)),
                "leftValue": expr,
                "rightValue": "",
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
            "combinator": "and",
        },
        "options": {},
    })


def note(wf, name, text, pos, w=420, h=200):
    n = node(wf, name, "n8n-nodes-base.stickyNote", 1, {"content": text, "width": w, "height": h})
    n["position"] = pos
    return n


def workflow(name, nodes, edges, layout):
    """edges: (from, to) or (from, to, output_index). layout: {name: (col, row)}."""
    for n in nodes:
        if n["name"] in layout:
            c, r = layout[n["name"]]
            n["position"] = [c * 240, r * 200]
    conns = {}
    for e in edges:
        src, dst, out = (e + (0,))[:3]
        main = conns.setdefault(src, {"main": []})["main"]
        while len(main) <= out:
            main.append([])
        main[out].append({"node": dst, "type": "main", "index": 0})
    names = {n["name"] for n in nodes}
    for e in edges:
        assert e[0] in names and e[1] in names, e
    return {"name": name, "nodes": nodes, "connections": conns, "pinData": {},
            "settings": {"executionOrder": "v1", "saveManualExecutions": True}, "active": False}


# ---------- 1. intake ----------

def build_intake(cfg):
    wf = "intake"
    nodes = [
        node(wf, "Gmail Trigger", "n8n-nodes-base.gmailTrigger", 1.2, {
            "pollTimes": {"item": [{"mode": "everyMinute"}]},
            "simple": False,
            "filters": {"q": "in:inbox newer_than:2d -category:promotions -category:social", "readStatus": "both"},
            "options": {},
        }),
        config_node(wf, cfg, ["intake_email", "form_prefill_url", "company_short", "desk_name",
                              "triage_model", "fallback_model"]),
        code_node(wf, "Prepare Email", "intake-prepare.js"),
        openrouter_node(wf, "Triage with AI", 3500),
        code_node(wf, "Read Triage", "intake-read-triage.js"),
        if_true(wf, "Vendor inquiry?", "={{ $json.is_vendor }}"),
        node(wf, "Log Intake", "n8n-nodes-base.googleSheets", 4.5, sheets(
            wf, "Log Intake", cfg, "appendOrUpdate", "Intake",
            columns=upsert_columns("vendor_id"),
            options={"handlingExtraData": "ignoreIt"})),
        gmail_send(wf, "Send Form Link",
                   "={{ $('Read Triage').item.json.contact_email }}",
                   "={{ $('Read Triage').item.json.reply_subject }}",
                   "={{ $('Read Triage').item.json.reply_html }}"),
        node(wf, "Leave for a person", "n8n-nodes-base.noOp", 1, {}),
        note(wf, "About", "## 1 · Intake\nEvery minute, new inbox mail is triaged by the AI model (Gemma 4 31B). Vendor inquiries get a reference ID, a row in **Intake** and a reply with their pre-filled Google Form link. Everything else is left untouched for a person.", [-40, -260], 520, 180),
    ]
    edges = [("Gmail Trigger", "Config"), ("Config", "Prepare Email"), ("Prepare Email", "Triage with AI"),
             ("Triage with AI", "Read Triage"), ("Read Triage", "Vendor inquiry?"),
             ("Vendor inquiry?", "Log Intake", 0), ("Vendor inquiry?", "Leave for a person", 1),
             ("Log Intake", "Send Form Link")]
    layout = {"Gmail Trigger": (0, 0), "Config": (1, 0), "Prepare Email": (2, 0), "Triage with AI": (3, 0),
              "Read Triage": (4, 0), "Vendor inquiry?": (5, 0), "Log Intake": (6, -0.5), "Send Form Link": (7, -0.5),
              "Leave for a person": (6, 0.6)}
    return workflow("EBM Vendor Desk · 1 Intake", nodes, edges, layout)


# ---------- 2. assessment ----------

def build_assess(cfg):
    wf = "assess"
    nodes = [
        node(wf, "Form Response Trigger", "n8n-nodes-base.googleSheetsTrigger", 1, {
            "pollTimes": {"item": [{"mode": "everyMinute"}]},
            "documentId": rl_id(cfg["spreadsheet_id"]),
            "sheetName": rl_id(str(cfg["form_responses_gid"])),
            "event": "rowAdded",
            "options": {},
        }),
        config_node(wf, cfg, ["approver_email", "review_url", "company_short", "desk_name",
                              "assess_model", "fallback_model"]),
        node(wf, "Get GRC Policy", "n8n-nodes-base.googleDocs", 2, {
            "operation": "get", "documentURL": cfg["grc_doc_id"], "simple": True,
        }, executeOnce=True),
        node(wf, "Read Intake", "n8n-nodes-base.googleSheets", 4.5,
             sheets(wf, "Read Intake", cfg, "read", "Intake", options={}),
             executeOnce=True, alwaysOutputData=True),
        code_node(wf, "Normalize Vendors", "assess-normalize.js"),
        code_node(wf, "Build Search Queries", "assess-queries.js"),
        node(wf, "Web Search", "n8n-nodes-base.httpRequest", 4.2, {
            "method": "POST",
            "url": "https://api.tavily.com/search",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ query: $json.query, search_depth: 'basic', max_results: 5, include_answer: false }) }}",
            "options": {"timeout": 30000},
        }, retryOnFail=True, maxTries=2, waitBetweenTries=2000, onError="continueRegularOutput",
           notes="Credential: Header Auth named 'Tavily' — Name: Authorization, Value: Bearer tvly-…"),
        code_node(wf, "Build Assessment Prompt", "assess-prompt.js"),
        openrouter_node(wf, "Assess with AI", 6000),
        code_node(wf, "Score against GRC", "assess-score.js"),
        node(wf, "Save Assessment", "n8n-nodes-base.googleSheets", 4.5, sheets(
            wf, "Save Assessment", cfg, "appendOrUpdate", "Assessments",
            columns=upsert_columns("vendor_id"),
            options={"handlingExtraData": "ignoreIt"})),
        gmail_send(wf, "Tell the Approver",
                   "={{ $('Config').first().json.approver_email }}",
                   "=Vendor ready for review: {{ $('Score against GRC').item.json.company_name }} · {{ $('Score against GRC').item.json.score }} ({{ $('Score against GRC').item.json.tier }})",
                   "={{ $('Score against GRC').item.json.notify_html }}"),
        note(wf, "About", "## 2 · Assess\nWhen a Google Form response lands in the sheet, each vendor gets three web searches, then the AI model scores them against the GRC doc. The weighted score and tier are computed in **Score against GRC** from the weights in the doc. The result goes to **Assessments** with status *pending_review*, and the approver gets an email.", [-40, -300], 620, 200),
    ]
    order = ["Form Response Trigger", "Config", "Get GRC Policy", "Read Intake", "Normalize Vendors",
             "Build Search Queries", "Web Search", "Build Assessment Prompt", "Assess with AI",
             "Score against GRC", "Save Assessment", "Tell the Approver"]
    edges = list(zip(order, order[1:]))
    layout = {n: (i, 0) for i, n in enumerate(order)}
    return workflow("EBM Vendor Desk · 2 Assess", nodes, edges, layout)


# ---------- 3. review API ----------

def build_review(cfg):
    wf = "review"
    hook = lambda name, method, path: node(wf, name, "n8n-nodes-base.webhook", 2, {
        "httpMethod": method, "path": path, "authentication": "headerAuth",
        "responseMode": "responseNode", "options": {"allowedOrigins": "*"},
    }, webhookId=str(uuid.uuid5(NS, wf + "/hook/" + name)),
       notes="Credential: Header Auth named 'Vendor Desk key' — Name: x-desk-key, Value: a long random string")
    respond = lambda name, body, code=200: node(wf, name, "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "json", "responseBody": body, "options": {"responseCode": code},
    })
    nodes = [
        hook("List Webhook", "GET", "vendor-desk/vendors"),
        node(wf, "Read Assessments", "n8n-nodes-base.googleSheets", 4.5,
             sheets(wf, "Read Assessments", cfg, "read", "Assessments", options={}),
             alwaysOutputData=True),
        code_node(wf, "Shape for Desk", "review-list.js"),
        respond("Send List", "={{ JSON.stringify($json) }}"),

        hook("Decision Webhook", "POST", "vendor-desk/decision"),
        config_node(wf, cfg, ["company_short", "desk_name"]),
        node(wf, "Find Assessment", "n8n-nodes-base.googleSheets", 4.5, sheets(
            wf, "Find Assessment", cfg, "read", "Assessments",
            filtersUI={"values": [{"lookupColumn": "vendor_id",
                                   "lookupValue": "={{ $('Decision Webhook').first().json.body.vendor_id }}"}]},
            options={}), alwaysOutputData=True),
        code_node(wf, "Check Decision", "review-check.js"),
        if_true(wf, "Valid?", "={{ $json.ok }}"),
        node(wf, "Save Decision", "n8n-nodes-base.googleSheets", 4.5, sheets(
            wf, "Save Decision", cfg, "appendOrUpdate", "Assessments",
            columns=upsert_columns("vendor_id"), options={"handlingExtraData": "ignoreIt"})),
        if_true(wf, "Email vendor?", "={{ $('Check Decision').item.json.notify }}"),
        gmail_send(wf, "Email Vendor",
                   "={{ $('Check Decision').item.json.contact_email }}",
                   "={{ $('Check Decision').item.json.email_subject }}",
                   "={{ $('Check Decision').item.json.email_html }}"),
        respond("Saved", "={{ JSON.stringify({ ok: true, vendor_id: $('Check Decision').item.json.vendor_id, status: $('Check Decision').item.json.status, emailed: true }) }}"),
        respond("Saved, no email", "={{ JSON.stringify({ ok: true, vendor_id: $('Check Decision').item.json.vendor_id, status: $('Check Decision').item.json.status, emailed: false }) }}"),
        respond("Rejected Request", "={{ JSON.stringify({ ok: false, error: $json.error }) }}", 400),
        note(wf, "About", "## 3 · Vendor Desk API\nTwo webhooks behind one header key. **GET vendor-desk/vendors** returns every assessment for the Desk page. **POST vendor-desk/decision** records approve, ask-for-info or reject, writes it to **Assessments**, and emails the vendor unless the reviewer turned that off.", [-40, -300], 620, 200),
    ]
    edges = [("List Webhook", "Read Assessments"), ("Read Assessments", "Shape for Desk"), ("Shape for Desk", "Send List"),
             ("Decision Webhook", "Config"), ("Config", "Find Assessment"), ("Find Assessment", "Check Decision"),
             ("Check Decision", "Valid?"), ("Valid?", "Save Decision", 0), ("Valid?", "Rejected Request", 1),
             ("Save Decision", "Email vendor?"), ("Email vendor?", "Email Vendor", 0), ("Email vendor?", "Saved, no email", 1),
             ("Email Vendor", "Saved")]
    layout = {"List Webhook": (0, 0), "Read Assessments": (1, 0), "Shape for Desk": (2, 0), "Send List": (3, 0),
              "Decision Webhook": (0, 1.5), "Config": (1, 1.5), "Find Assessment": (2, 1.5), "Check Decision": (3, 1.5),
              "Valid?": (4, 1.5), "Save Decision": (5, 1), "Email vendor?": (6, 1), "Email Vendor": (7, 0.7),
              "Saved": (8, 0.7), "Saved, no email": (7, 1.5), "Rejected Request": (5, 2.2)}
    return workflow("EBM Vendor Desk · 3 Review API", nodes, edges, layout)


# ---------- Apps Script ----------

def build_apps_script():
    helpers = (CODE / "_helpers.js").read_text()
    vendor_id_fn = re.search(r"function vendorIdFor[\s\S]*?\n}\n", helpers).group(0)
    tpl = (ROOT / "apps-script" / "setup.template.gs").read_text()
    return (tpl
            .replace("/*@form_spec*/null", json.dumps(FORM, indent=2))
            .replace("/*@grc_policy*/''", json.dumps((ROOT / "mock" / "grc-policy.md").read_text()))
            .replace("/*@emails*/[]", json.dumps(json.loads((ROOT / "mock" / "emails.json").read_text()), indent=2))
            .replace("/*@responses*/[]", json.dumps(json.loads((ROOT / "mock" / "form-responses.json").read_text()), indent=2))
            .replace("/*@vendorIdFor*/", vendor_id_fn))


def main():
    cfg = load_config()
    DIST.mkdir(exist_ok=True)
    for file, wf in [("1-intake.json", build_intake(cfg)), ("2-assess.json", build_assess(cfg)),
                     ("3-review-api.json", build_review(cfg))]:
        (DIST / file).write_text(json.dumps(wf, indent=2, ensure_ascii=False))
        print("wrote dist/" + file)
    (DIST / "setup.gs").write_text(build_apps_script())
    print("wrote dist/setup.gs")


if __name__ == "__main__":
    sys.exit(main())
