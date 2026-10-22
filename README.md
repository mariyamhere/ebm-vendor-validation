# EBM Vendor Desk

Vendor validation on n8n Cloud. A vendor emails the Gmail inbox and gets a pre-filled Google Form. Once they fill it in, gpt-oss scores them against the GRC policy doc using the form answers and a web search. A reviewer then approves, sends back, or rejects them in the Vendor Desk page. All the data here is mock.

```
Vendor email ──▶ 1 Intake ──▶ reply with form link ──▶ Vendor fills Google Form
                  (triage: is this a vendor?)                     │
                                                                  ▼
Reviewer ◀── email ◀── 2 Assess ◀── new row in "Form Responses 1"
   │                   (3 web searches ▸ gpt-oss vs GRC doc ▸ weighted score ▸ Assessments sheet)
   ▼
Vendor Desk page ──▶ 3 Review API ──▶ Assessments sheet + email to vendor
```

## Design decisions

**The model scores the criteria, the code does the maths.** gpt-oss gives each of C1–C7 a score from 0 to 5, with evidence, and says which knockout rules (K1–K6) are triggered. The `Score against GRC` node reads the weights from the GRC doc's lines like `C2 — Food safety … (weight 20)`, computes the total out of 100, and sets the tier. If any knockout is triggered the vendor is Blocked, whatever the model recommended. Procurement can change the weights by editing the doc, with no workflow change.

**The GRC doc goes into the prompt in full.** The doc holds the rubric, the knockout rules and the Restricted Parties list. Sending all of it lets the model catch a director who is shared with a debarred company. The mock vendor Sunrise Edible Oils is there to test exactly that.

**Web search goes through Tavily, not the OpenRouter `:online` plugin.** The plugin is billed per result, so the free model would no longer be free. Tavily's free tier gives 1,000 searches a month, and each vendor uses 3: profile, adverse news about the company and its directors, and their own site.

**One ID per vendor from start to finish.** The vendor ID is a hash of the vendor's email address. It is pre-filled in the form, so the form response joins back to the original email. Both the workflow and the Apps Script seeder compute it the same way.

**A human always decides.** Nothing is approved automatically. To approve a Blocked vendor the reviewer must write an exception note of at least 20 characters. The page checks this and `Check Decision` enforces it again on the server.

**Free-tier limits are built in.** Each OpenRouter call lists gpt-oss-120b with 20b as the fallback, runs one request at a time with a gap between them, and retries 3 times. If the model still fails, triage falls back to a keyword match, and an assessment is saved as `Unscored` so a person can review it by hand. Nothing is dropped.

## Files

| Path | What it is |
|---|---|
| `dist/1-intake.json`, `2-assess.json`, `3-review-api.json` | n8n workflows to import |
| `dist/setup.gs` | Apps Script that creates the mock sheet, GRC doc and form, and sends the mock emails and form responses |
| `frontend/index.html` | Vendor Desk page: one static file that opens with sample data |
| `mock/` | GRC policy, form questions, 6 emails (5 vendors and 1 customer complaint), 5 form responses |
| `workflows/code/` | Source for every Code node |
| `build.py` | Puts `workflows/code` and `mock/` together into `dist/` |

## Setup (about 30 minutes)

**1. Accounts.** You need an OpenRouter key (free) and a Tavily key (free). Use the same Google account for Gmail, Sheets, Docs and Forms.

**2. Mock Google data.** Open script.google.com and create a new project. Paste in `dist/setup.gs` and run `setupVendorDesk`. Copy the JSON it logs into `config.json`, using `config.example.json` as the template. Also fill in `approver_email` and `review_url`. Then run:

```bash
python3 build.py
```

**3. n8n credentials.** In n8n Cloud, create:
- Gmail OAuth2, Google Sheets OAuth2 and Google Docs OAuth2
- Header Auth **OpenRouter**: `Authorization` = `Bearer sk-or-…`
- Header Auth **Tavily**: `Authorization` = `Bearer tvly-…`
- Header Auth **Vendor Desk key**: `x-desk-key` = a long random string

**4. Import and activate.** Import the three files in `dist/`. Open each red node and pick its credential. Each HTTP node's note says which one it needs. Then activate all three workflows.

**5. Vendor Desk page.** Host `frontend/index.html` anywhere static, such as Netlify Drop or GitHub Pages. In the page's Settings, enter `https://<you>.app.n8n.cloud/webhook`, the desk key and your name.

**6. Run the demo.** In Apps Script, run `sendMockVendorEmails`. Within about a minute, Intake has 5 rows, 5 form-link replies are in the inbox, and the customer complaint has been left alone. Then run `submitMockFormResponses`. About 2–3 minutes later, 5 assessments appear in the Desk.

## Expected demo outcome

| Vendor | Expected | Why |
|---|---|---|
| Al-Noor Packaging | Tier A | FSSC 22000 and BRCGS, capacity, SMETA |
| SwiftHaul Logistics | Tier B | Solid, with a *declared* relationship to an EBM employee, so it is flagged but not a knockout |
| Chenab Flour Mills | Blocked (K3) | Halal certificate expired 31 Aug 2026 |
| Sunrise Edible Oils | Blocked (K4) | Shares a director with a debarred company and answered "No" to past action |
| Seaview Cocoa | Blocked (K2, K3) | No certificates, one year old, asks for full advance |

The mock companies don't exist, so web search finds nothing about them. The policy scores that as neutral (C6 = 2–3), not as adverse.

## Known limits

- The free OpenRouter models allow about 50 requests a day, or 1,000 with $10 of credit on the account. One vendor costs 2 calls.
- The Gmail trigger polls every minute and reads up to 10 messages per poll.
- The webhooks allow any origin (`allowedOrigins: *`) and are protected by the header key. Once the page has a fixed URL, set `allowedOrigins` to that URL.
- Mock vendors use plus-aliases of the demo inbox (`you+alnoor@…`), so every email the system sends comes back to the inbox where you can see it. The intake workflow ignores those returning emails.
