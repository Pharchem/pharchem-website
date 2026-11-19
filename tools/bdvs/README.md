# BDVS – Batch Document Verification System

Google Apps Script web app for QA batch document verification (ref. URS-BDVS-001).

**Flow:** QA registers dispatched batches → PRD uploads the scanned filled **BMR/BPR**, QC uploads the scanned **COA + raw data / analytical protocol** (deadline: dispatch + 2 days, 23:59 IST) → QA verifies each scan within **24 working hours** (accept, or reject with page-wise observations → re-upload as a new version) → PRD/QC hand over the **hardcopy** within **3 working days** → QA records receipt → QA completes **Batch Data Verification** (batch locked).

Reminders and escalations run every hour from Gmail, even when nobody is logged in.

## What's in this folder

| File | Purpose |
|---|---|
| `Code.gs` | Server: data, workflow rules, deadlines, reminders, audit trail, GMP folder index, production register |
| `Checks.gs` | Automatic checks: limits from GMP documents, AI reading of scans, limit / trend / cross / date checks, monthly report |
| `Index.html` | The web page used by PRD, QC, QA and Admin |
| `appsscript.json` | Project settings (IST time zone, web app runs as the deploying account) |

## One-time setup (about 15 minutes)

Do this signed in to the **QA Google account** that will own the data (e.g. the QA department mailbox). That account owns the sheet, the scans and the emails.

1. **Create the spreadsheet.** Go to sheets.google.com → Blank → name it `BDVS – Batch Document Verification`.
2. **Add the code.** Extensions → Apps Script. Delete the sample code, then:
   - paste `Code.gs` into `Code.gs`;
   - **+ → Script**, name it `Checks`, paste `Checks.gs`;
   - **+ → HTML**, name it `Index`, paste `Index.html`;
   - Project Settings (gear) → tick **Show "appsscript.json"**, open it and paste `appsscript.json`.
   - Save.
3. **Run setup.** Reload the spreadsheet. A **BDVS** menu appears → **1. Initial setup** → allow the permissions Google asks for.
   A pop-up shows the **admin username and temporary password** — write it down.
4. **Deploy the web app.** In Apps Script: **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (users still log in with their own BDVS username and password)
   - Copy the **web app URL** — this is the link everyone uses. (Run *1. Initial setup* once more so email links use it.)
5. **Share the GMP folder** (Viewer) with the QA Google account, if it is not already its owner.
6. **Log in as admin** at the web app URL, set a new password, then go to **Settings**:
   - `EMAIL_PRD` = `prd.pharchem@gmail.com`
   - `EMAIL_QC` = `qc.pharchem@gmail.com`
   - `EMAIL_QA` = `qa.pharchem@gmail.com`
   - `EMAIL_ESCALATION` = the management escalation addresses, comma separated
   - `EMAIL_ADMIN` = whoever should hear about failed emails
   - Click **Send test email to departments** and check that all mailboxes received it.
7. **Create users** (Users tab). One login per person, with role PRD, QC, QA or ADMIN. Hand over the temporary passwords personally.
8. **Log in as a QA user** → Settings → **GMP document master** → paste the GMP folder link → **Scan GMP folder**.
9. **Production register:** Settings → **Daily Production & Dispatch Register** → **Create template sheet**. It is created in Drive, linked, and shared (edit) with the Production mailbox. Alternatively, paste the link of your own Google Sheet → **Link sheet**; it needs the column headers *Batch No.*, *Customer* and *Dispatch Date*.
   Add declared **holidays** in the same screen. Review the **verification checklists** (pre-loaded from QAGE/033, 043, 047, 054 and the BMR/COA formats).

10. **Limits (one time):**
    - Create an API key at console.anthropic.com (Settings → API keys), add a payment method and set a low monthly spend limit (e.g. ₹500).
    - As admin: Settings → *Automatic checks* → paste the key → **Save API key** (or use the sheet menu *BDVS → Set Claude API key*). The key is kept in Script Properties, never in the sheet.
    - As QA: **Read limits from GMP documents**. Within about an hour every master BMR, specification and COA format has a draft list of limits (one-time cost: about ₹50–150 in total). Check each list against its document, edit where needed, then **Approve** (password signature). Only approved limits are used.
    - The API key can then be removed (Save an empty key). Limits can also be typed in by QA instead.
    - Fill `EMAIL_QA_HEAD` in Settings; this person is emailed immediately when a value is out of limit.

## Automatic checks: how they work

1. **Free (default, `VALUE_SOURCE = FORM`):** when PRD or QC upload, the form asks for the key values of that batch's master BMR, or for the COA test results, plus a few details (dates, batch no., challan). Typing them takes about 2–3 minutes per document. Write **NR** for a value that isn't recorded. Uploaders don't see pass/fail while typing, so nobody is tempted to adjust a value; QA sees the results.
2. **Optional AI reading (`VALUE_SOURCE = AI`):** Claude reads the values from the scan instead (model `AI_MODEL`, default Claude Haiku, roughly ₹0.5–2 per batch, results usually within an hour). It also notes blank fields and missing signatures. Low-confidence handwriting is marked for QA to confirm.
3. BDVS then checks:
   - **Limits:** every value against the approved limit. **Out of limit blocks acceptance** until QA records a Deviation/OOS reference (QAGE/025) and justification. QA Head and the escalation list are emailed at once.
   - **Trend:** values more than 3 SD from the mean of the last 30 accepted batches (needs at least 8) are flagged *out of trend*.
   - **Cross-check:** batch no., batch size, mfg/expiry dates, customer and challan are compared across the BMR, the COA and the registered dispatch.
   - **Dates:** sample receipt ≥ mfg, analysis after receipt, report after analysis, report before dispatch, expiry = mfg + shelf life.
4. Values that couldn't be read, low-confidence readings and all other flags need a QA justification, or QA enters the value read on the scan (**Correct**, audit-trailed and re-checked). QA stays the decision-maker; the AI only reads.
5. **Reports** tab: per month and product, n / min / max / mean / SD and out-of-limit / out-of-trend counts per parameter, plus all findings and how they were closed. QA and QA Head are emailed this summary on the 1st of each month.

**Cost:** free in FORM mode. The only cost is the one-time limits reading (about ₹50–150). In AI mode with Haiku, roughly ₹0.5–2 per batch. Token usage is shown in Settings. **Data:** scans are sent to Anthropic's API for reading. API data isn't used for model training; check that this fits your confidentiality agreements with customers. **Validation:** treat the AI reading as a supporting tool. During PQ, compare its readings against manual verification for a sample of batches, and record the agreement rate.

## Daily use

| Who | What |
|---|---|
| **Production (every evening)** | In the *Daily Production & Dispatch Register* Google Sheet, add one row per batch made today (Mfg Date, Batch No., Customer; Product and Batch Size are optional). Add a **NIL** row on days with no production. When a batch is dispatched, fill **Dispatch Date** and **Invoice / Challan No.** on the same row. |
| **BDVS (8 PM daily, automatic)** | Reads the register and **registers every newly dispatched batch**, filling in the BMR, STP, specification, COA format and batch size from the GMP folder. PRD and QC are emailed. The result is written in the *BDVS Status* column (Registered / Awaiting dispatch / ERROR). QA gets a summary email that flags new customers to check; Production is copied when rows have problems or nothing was entered for the day. |
| **QA** | Check the evening summary; correct a new customer's documents in the batch (**Change master documents**, remembered for next time). QA can also register by hand: *Register dispatch* → single batch or **Bulk: paste list from Production** (Batch No. · Dispatch date · Customer · Invoice). The product, BMR, STP, specification, COA format and batch size are filled in from the GMP folder. Check the preview → Register. |
| **PRD / QC** | *My tasks* → **Upload scan** (PDF, or JPG/PNG pages combined automatically) → enter the page count → tick the checklist. If a scan is rejected, read the observations and **Re-upload**. After Verified OK, **print the transmittal slip** and hand over the original. |
| **QA** | *Verification queue* → **Verify**: the scan opens beside the checklist and the master documents. Accept, or reject with observations, using your password as the signature. *Hardcopy receipt* → **Record receipt** (page count and storage location). Open the batch → **Complete Batch Data Verification**. |
| **Admin** | Users, settings, test email. The admin role cannot verify or close batches (segregation of duties). |

When the GMP folder changes (a new or revised BMR, STP or COA format), go to Settings → **Scan GMP folder** again.
**Read now** (Settings) reads the production register immediately; re-reading never registers a batch twice.

The register must be a **Google Sheet**, not an uploaded .xlsx. If Production works in Excel, open the file in Drive → *File → Save as Google Sheets*, and keep using that copy.

## Data integrity notes

- Every action is written to an **append-only audit trail** with a SHA-256 hash chain. *Audit trail → Verify integrity* (or BDVS menu → *Verify audit trail integrity*) detects any edited or deleted entry.
- Uploaded scans are stored read-only in the Drive folder `BDVS Scanned Documents (do not edit)`, with a SHA-256 hash. The hash is re-checked every time a scan is viewed, and a mismatch alerts the admin.
- Corrections are made only by new versions. Earlier versions, verifications and observations are never deleted.
- Passwords are salted and hashed. Accounts lock after 5 failed logins (admin unlocks them), sessions end after 15 minutes of inactivity, and accept/reject/close decisions require the password again.
- Retention: keep the spreadsheet and Drive folder for at least **expiry + 1 year (6 years)**, as per QAGE/047.
- Only the owning QA Google account can open the spreadsheet directly. Do not share the sheet or the scans folder with edit access, and keep that account's password and 2-step verification under QA Head control.
- Known platform limits: Apps Script cannot record the user's IP address (the browser details are logged instead); the Gmail quota is about 100 emails/day on a free Gmail account (enough for roughly 10–15 dispatches/day); scans are limited to 25 MB per file (several files per document are allowed).

## Validation (CSV)

Before GMP use, run IQ/OQ/PQ (or UAT) against URS-BDVS-001 §14. The deadline maths, reminders, versioning, audit trail, access control and closure rules are already covered by an automated test (108 checks) run during development. Repeat them as documented OQ test cases on your deployment.
