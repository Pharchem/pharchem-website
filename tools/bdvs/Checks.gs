/**
 * BDVS - automatic checks (Checks.gs)
 *
 * 1. LIMITS: reads the master BMR / specification / COA-format documents from the GMP folder and asks Claude
 *    to extract the limits (in-process limits, test specifications, shelf life). QA approves them once.
 * 2. SCANS: when PRD / QC upload a scan, Claude reads it (handwritten BMR, typed COA) and returns the recorded
 *    values plus header data (batch no., size, dates). BDVS then checks:
 *      - every value against the approved limit (out of limit = BLOCK until deviation / OOS reference)
 *      - out-of-trend against the previous accepted batches (mean +/- 3 SD)
 *      - BMR vs COA vs registered dispatch (batch no., size, dates, customer, challan)
 *      - date sequence (sample receipt, analysis, report, dispatch, expiry = mfg + shelf life)
 * 3. Monthly limits / trend report.
 *
 * Calls the Claude Messages API through the Message Batches endpoint (asynchronous, half price), driven by a
 * 5-minute timer. The API key is kept in Script Properties, never in the sheet.
 */

var CLAUDE_API = 'https://api.anthropic.com/v1/messages/batches';
var CLAUDE_VERSION = '2026-10-21';

var SHEETS = (typeof SHEETS !== 'undefined' && SHEETS) || {};
var DEFAULT_SETTINGS = (typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS) || {};
var ACTIONS = (typeof ACTIONS !== 'undefined' && ACTIONS) || {};

SHEETS.Limits = ['id', 'masterId', 'masterTitle', 'productCode', 'kind', 'parameter', 'stage', 'unit', 'limitType',
  'low', 'high', 'textSpec', 'order', 'status', 'source', 'approvedBy', 'approvedAt', 'updatedAt', 'verify', 'verifyNote'];
SHEETS.AiJobs = ['id', 'kind', 'refId', 'batchId', 'status', 'apiBatchId', 'createdAt', 'submittedAt', 'doneAt',
  'error', 'inputTokens', 'outputTokens', 'retries', 'model', 'reading'];
SHEETS.Results = ['id', 'versionId', 'docId', 'batchId', 'productCode', 'customer', 'docType', 'parameter', 'stage',
  'value', 'numValue', 'unit', 'page', 'confidence', 'limitId', 'limitText', 'check', 'oot', 'ootText',
  'correctedBy', 'correctionReason', 'createdAt', 'priorValue'];
SHEETS.Findings = ['id', 'versionId', 'batchId', 'docType', 'type', 'severity', 'text', 'resultId', 'status',
  'devRef', 'resolution', 'resolvedBy', 'resolvedAt', 'createdAt'];

DEFAULT_SETTINGS.VALUE_SOURCE = ['FORM', 'FORM = PRD / QC type the key values while uploading (free); AI = Claude reads them from the scan (paid, API key needed)'];
DEFAULT_SETTINGS.AI_ENABLED = ['YES', 'YES = allow Claude API calls (limit extraction, and scan reading when VALUE_SOURCE = AI)'];
DEFAULT_SETTINGS.AI_MODEL = ['claude-haiku-5-5', 'Claude model that reads scans when VALUE_SOURCE = AI (Haiku = lowest cost)'];
DEFAULT_SETTINGS.AI_MODEL_2 = ['claude-sonnet-5-5', 'Stronger (costlier) model used only for the second reading of a doubtful scan'];
DEFAULT_SETTINGS.SCAN_SECOND_OPINION = ['YES', 'YES = when the first reading is unsure about a handwritten value, cannot find it, or finds it out of limit, the scan is read again by AI_MODEL_2 and the two readings are compared before QA is alerted'];
DEFAULT_SETTINGS.LIMITS_MODEL = ['claude-opus-5-5', 'Claude model for the one-time reading of limits from master documents'];
DEFAULT_SETTINGS.GMP_SYNC_HOUR = ['6', 'Hour (IST, 0-23) at which the GMP folder is re-scanned daily and limits for new documents are read automatically; empty = off'];
DEFAULT_SETTINGS.KEY_PARAMS_ONLY = ['YES', 'YES = the upload form asks only the key values below; NO = every approved numeric limit'];
DEFAULT_SETTINGS.KEY_PARAMS_BMR = ['pH | viscosity | free chlorine', 'BMR values read / typed (groups separated by |, alternative words by commas). Only the LAST stage of each group is used. Al2O3 content is checked on the COA, not the BMR.'];
DEFAULT_SETTINGS.KEY_PARAMS_COA = ['pH | assay | chloride | neutraliz', 'COA values QC types (groups separated by |, alternative words by commas). Every matching test is asked.'];
DEFAULT_SETTINGS.KEY_PARAMS_COA_LAKE = ['solid content | LOD, loss on drying', 'Extra COA values asked only for lake colour customers'];
DEFAULT_SETTINGS.LAKE_COLOUR_CUSTOMERS = ['Koel, Akay, Dynemic, Roha, Neelikon', 'Customers that get lake colour grade (comma separated)'];
DEFAULT_SETTINGS.KEY_PARAMS_EXCLUDE = ['pH of water, re-wash, rewash, NaCl, sodium chloride, magnesium chloride, MgCl2, raw material', 'Limits whose name contains any of these words are never asked'];
DEFAULT_SETTINGS.FORM_ASK_DESCRIPTIVE = ['NO', 'YES = the upload form also asks for descriptive limits (e.g. "clarity OK"); NO = numbers only, QA checks descriptive items on the scan'];
DEFAULT_SETTINGS.EMAIL_QA_HEAD = ['', 'QA Head - emailed immediately when a value is out of limit (comma separated)'];
DEFAULT_SETTINGS.TREND_BATCHES = ['30', 'Number of previous accepted batches used for the out-of-trend check'];

ACTIONS.aiStatus = { roles: ['QA', 'ADMIN'], fn: apiAiStatus_ };
ACTIONS.setApiKey = { roles: ['ADMIN'], fn: apiSetApiKey_, write: true };
ACTIONS.queueLimitExtraction = { roles: ['QA', 'ADMIN'], fn: apiQueueLimitExtraction_, write: true };
ACTIONS.runAiNow = { roles: ROLES, fn: function () {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { throw new Error('The automatic checks are already running - try again in a few minutes.'); }
  try { runAiQueue_(); } finally { lock.releaseLock(); }
  return apiAiStatus_();
}, write: false };
ACTIONS.getLimits = { roles: ['QA', 'ADMIN'], fn: apiGetLimits_ };
ACTIONS.saveLimit = { roles: ['QA'], fn: apiSaveLimit_, write: true };
ACTIONS.approveLimits = { roles: ['QA'], fn: apiApproveLimits_, write: true };
ACTIONS.approveLimitsMany = { roles: ['QA'], fn: apiApproveLimitsMany_, write: true };
ACTIONS.queueLimitVerify = { roles: ['QA', 'ADMIN'], fn: apiQueueLimitVerify_, write: true };
ACTIONS.getChecks = { roles: ['QA', 'PRD', 'QC'], fn: apiGetChecks_ };
ACTIONS.correctResult = { roles: ['QA'], fn: apiCorrectResult_, write: true };
ACTIONS.resolveFinding = { roles: ['QA'], fn: apiResolveFinding_, write: true };
ACTIONS.recheck = { roles: ['QA'], fn: function (u, p) { queueScan_(p.versionId, true); return true; }, write: true };
ACTIONS.monthlyReport = { roles: ['QA', 'ADMIN'], fn: apiMonthlyReport_ };
ACTIONS.formFields = { roles: ['PRD', 'QC', 'QA'], fn: apiFormFields_ };
ACTIONS.skipAiCheck = { roles: ['QA'], fn: function (u, p) {
  var v = findById_('Versions', p.versionId);
  if (!v) { throw new Error('Version not found.'); }
  var reason = req_(p.reason, 'Reason');
  var f = addFinding_(v.id, 'SKIP_AI', 'WARN', 'QA proceeded without waiting for the automatic check');
  var ok = apiResolveFinding_(u, { findingId: f.id, resolution: reason, client: p.client });
  evaluateVersion_(v.id); // a value held for the second reading becomes a normal out-of-limit block
  return ok;
}, write: true };

// ---------------------------------------------------------------------------
// Settings / status
// ---------------------------------------------------------------------------

function apiKey_() { return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || ''; }
function aiOn_() { return setting_('AI_ENABLED') !== 'NO' && !!apiKey_(); }
function aiScans_() { return setting_('VALUE_SOURCE') === 'AI' && aiOn_(); }

function apiSetApiKey_(user, p) {
  var k = String(p.key || '').trim();
  if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) { throw new Error('That does not look like an Anthropic API key (sk-ant-...).'); }
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', k);
  audit_(user, 'CONFIG_CHANGED', 'Setting', 'ANTHROPIC_API_KEY', '', '', k ? 'API key set (ends ...' + k.slice(-4) + ')' : 'API key removed', '', p.client);
  return true;
}

function apiAiStatus_() {
  var jobs = rows_('AiJobs');
  var c = { PENDING: 0, SUBMITTED: 0, DONE: 0, FAILED: 0 };
  var tokensIn = 0, tokensOut = 0;
  jobs.forEach(function (j) { c[j.status] = (c[j.status] || 0) + 1; tokensIn += Number(j.inputTokens) || 0; tokensOut += Number(j.outputTokens) || 0; });
  var lim = rows_('Limits');
  return {
    keySet: !!apiKey_(), enabled: setting_('AI_ENABLED') !== 'NO', model: setting_('AI_MODEL'), valueSource: setting_('VALUE_SOURCE') || 'FORM', jobs: c,
    model2: setting_('SCAN_SECOND_OPINION') === 'NO' ? '' : setting_('AI_MODEL_2'),
    recentFailures: jobs.filter(function (j) { return j.status === 'FAILED'; }).slice(-5).map(strip_),
    tokensIn: tokensIn, tokensOut: tokensOut,
    limits: { draft: lim.filter(function (l) { return l.status === 'DRAFT'; }).length, approved: lim.filter(function (l) { return l.status === 'APPROVED'; }).length }
  };
}

// ---------------------------------------------------------------------------
// Job queue (Message Batches API)
// ---------------------------------------------------------------------------

/** extra: { model, reading, afterJobId } - a second reading is queued while the first job is still being finalised. */
function queueJob_(kind, refId, batchId, extra) {
  extra = extra || {};
  var open = rows_('AiJobs').filter(function (j) {
    return j.kind === kind && j.refId === refId && (j.status === 'PENDING' || j.status === 'SUBMITTED') && j.id !== extra.afterJobId;
  });
  if (open.length) { return open[0]; }
  return insert_('AiJobs', { id: newId_('J'), kind: kind, refId: refId, batchId: batchId || '', status: 'PENDING', apiBatchId: '',
    createdAt: iso_(Date.now()), submittedAt: '', doneAt: '', error: '', inputTokens: '', outputTokens: '', retries: '',
    model: extra.model || '', reading: extra.reading || '1' });
}

/** Called after every upload (from Code.gs). */
function queueScan_(versionId, force) {
  if (!aiScans_()) { return null; }
  var v = findById_('Versions', versionId);
  if (!v) { return null; }
  if (force) {
    rows_('Findings').filter(function (f) { return f.versionId === versionId && f.status === 'OPEN' && f.type !== 'MANUAL'; })
      .forEach(function (f) { f.status = 'SUPERSEDED'; update_('Findings', f); });
  }
  return queueJob_('SCAN', versionId, v.batchId);
}

function apiQueueLimitExtraction_(user, p) {
  if (!apiKey_()) { throw new Error('Set the Claude API key first (Settings, administrator).'); }
  var docs = rows_('DocMaster').filter(function (d) { return d.active === 'Y' && (d.kind === 'BMR' || d.kind === 'COA' || d.kind === 'SPEC'); });
  var have = {};
  rows_('Limits').forEach(function (l) { if (l.status !== 'RETIRED') { have[l.masterId] = true; } });
  var queued = 0;
  docs.forEach(function (d) {
    if (p.all || !have[d.id]) { queueJob_('LIMITS', d.id, ''); queued++; }
  });
  audit_(user, 'LIMIT_EXTRACTION_QUEUED', 'Limits', '', '', '', queued + ' master documents queued for limit extraction', '', p.client);
  return { queued: queued };
}

/** A failed job is retried once before giving up (temporary API problems heal themselves). */
function failJob_(job, label, msg) {
  if (Number(job.retries || 0) < 1) {
    job.retries = String(Number(job.retries || 0) + 1);
    job.status = 'PENDING'; job.apiBatchId = ''; job.error = 'retrying after: ' + msg;
    return;
  }
  job.status = 'FAILED'; job.error = msg;
  if (job.kind === 'SCAN') { addFinding_(job.refId, 'AI', 'WARN', label + msg + '. Verify the values on the scan manually.'); }
}

/** Daily GMP sync (called from the hourly reminders timer): re-scans the GMP folder and
 *  queues limit reading + double-check for new or changed master documents. QA only approves. */
function maybeGmpSync_() {
  var hour = String(setting_('GMP_SYNC_HOUR') || '').trim();
  if (hour === '' || istHour_(Date.now()) !== Number(hour)) { return; }
  if (!setting_('GMP_FOLDER_ID')) { return; }
  var props = PropertiesService.getScriptProperties();
  var today = istYmd_(Date.now());
  if (props.getProperty('GMP_SYNC_LAST') === today) { return; }
  props.setProperty('GMP_SYNC_LAST', today);
  var res = apiImportDocMaster_(null, { client: 'daily GMP sync' });
  var queued = 0, checked = 0;
  if (aiOn_()) {
    queued = apiQueueLimitExtraction_(null, { client: 'daily GMP sync' }).queued;
    checked = apiQueueLimitVerify_(null, { client: 'daily GMP sync' }).queued;
  }
  if (res.added || queued) {
    sendMail_('GMPSYNC|' + today, 'GMP_SYNC', '', '', deptEmails_('QA'), [],
      'BDVS: ' + (res.added ? res.added + ' new GMP master document(s) indexed' : queued + ' document(s) queued for limit reading'),
      mailBody_('GMP folder sync', 'The GMP folder was re-scanned automatically: <b>' + res.added + ' new</b>, ' + res.updated + ' refreshed, ' + res.retired + ' removed. ' +
        (queued ? 'Limits for <b>' + queued + '</b> document(s) are being read and will appear under Settings &gt; Limits as drafts for QA approval (with the AI double-check).' :
          'No new limits needed.'), ''));
  }
}

/** Timer entry point (every 5 minutes). */
function runAiQueue() {
  cacheReset_();
  if (!apiKey_()) { return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { return; }
  try { runAiQueue_(); } finally { lock.releaseLock(); }
}

function runAiQueue_() {
  if (!apiKey_()) { throw new Error('Claude API key not set.'); }
  pollBatches_();
  submitPending_();
}

function claudeFetch_(url, method, body) {
  var opts = { method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-api-key': apiKey_(), 'anthropic-version': CLAUDE_VERSION } };
  if (body) { opts.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch(url, opts);
  var code = r.getResponseCode();
  var text = r.getContentText();
  if (code >= 300) { throw new Error('Claude API ' + code + ': ' + text.slice(0, 300)); }
  return text;
}

function submitPending_() {
  var pending = rows_('AiJobs').filter(function (j) { return j.status === 'PENDING'; }).slice(0, 40);
  if (!pending.length) { return 0; }
  var requests = [], used = [], bytes = 0;
  pending.forEach(function (j) {
    try {
      var params = j.kind === 'LIMITS' ? limitsRequest_(j) : j.kind === 'LIMITS_VERIFY' ? verifyRequest_(j) : scanRequest_(j);
      var size = JSON.stringify(params).length;
      if (bytes + size > 150 * 1024 * 1024) { return; } // stay well under the batch size limit; rest next run
      bytes += size;
      requests.push({ custom_id: j.id, params: params });
      used.push(j);
    } catch (e) {
      failJob_(j, 'Automatic check could not start: ', String(e.message || e));
    }
  });
  if (!requests.length) { return 0; }
  var res = JSON.parse(claudeFetch_(CLAUDE_API, 'post', { requests: requests }));
  used.forEach(function (j) { j.status = 'SUBMITTED'; j.apiBatchId = res.id; j.submittedAt = iso_(Date.now()); update_('AiJobs', j); });
  return used.length;
}

function pollBatches_() {
  var subs = rows_('AiJobs').filter(function (j) { return j.status === 'SUBMITTED'; });
  var ids = {};
  subs.forEach(function (j) { ids[j.apiBatchId] = true; });
  Object.keys(ids).forEach(function (bid) {
    var st = JSON.parse(claudeFetch_(CLAUDE_API + '/' + bid, 'get'));
    if (st.processing_status !== 'ended') { return; }
    var lines = claudeFetch_(st.results_url, 'get').split('\n').filter(function (l) { return l.trim(); });
    var byId = {};
    lines.forEach(function (l) { var o = JSON.parse(l); byId[o.custom_id] = o; });
    subs.filter(function (j) { return j.apiBatchId === bid; }).forEach(function (j) {
      cacheReset_();
      var job = findById_('AiJobs', j.id);
      if (!job || job.status !== 'SUBMITTED') { return; } // already handled by an overlapping run
      var r = byId[j.id];
      try {
        if (!r) { throw new Error('No result returned'); }
        if (r.result.type !== 'succeeded') { throw new Error('Request ' + r.result.type + (r.result.error ? ': ' + JSON.stringify(r.result.error).slice(0, 200) : '')); }
        var msg = r.result.message;
        if (msg.stop_reason === 'refusal') { throw new Error('Claude declined to read this document'); }
        if (msg.stop_reason === 'max_tokens') { throw new Error('Response too long (document very large)'); }
        var text = (msg.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('');
        var data = JSON.parse(text);
        job.inputTokens = String(msg.usage ? msg.usage.input_tokens : '');
        job.outputTokens = String(msg.usage ? msg.usage.output_tokens : '');
        job.status = 'DONE'; // before storing: the evaluation must not see this very job as "still running"
        if (job.kind === 'LIMITS') { storeLimits_(job.refId, data); } else if (job.kind === 'LIMITS_VERIFY') { storeVerify_(job.refId, data); } else { storeScan_(job.refId, data, job); }
      } catch (e) {
        failJob_(job, 'Automatic check failed: ', String(e.message || e));
        if (job.kind === 'SCAN' && job.status === 'FAILED') {
          // a second reading that never arrives must not keep an out-of-limit value "soft"
          try { evaluateVersion_(job.refId); } catch (e2) { /* keep the job bookkeeping */ }
        }
      }
      job.doneAt = iso_(Date.now());
      update_('AiJobs', job);
    });
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function baseParams_(effort, schema, system, content, model) {
  return {
    model: model || setting_('AI_MODEL') || 'claude-haiku-5-5',
    max_tokens: 16000,
    output_config: { effort: effort, format: { type: 'json_schema', schema: schema } },
    system: system,
    messages: [{ role: 'user', content: content }]
  };
}

var LIMITS_SCHEMA_ = {
  type: 'object', additionalProperties: false, required: ['parameters', 'shelfLifeMonths'],
  properties: {
    shelfLifeMonths: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    parameters: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['parameter', 'stage', 'unit', 'limitType', 'low', 'high', 'textSpec'],
      properties: {
        parameter: { type: 'string' }, stage: { type: 'string' }, unit: { type: 'string' },
        limitType: { type: 'string', enum: ['RANGE', 'MAX', 'MIN', 'TEXT'] },
        low: { anyOf: [{ type: 'number' }, { type: 'null' }] }, high: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        textSpec: { type: 'string' }
      } } }
  }
};

function limitsRequest_(job) {
  var d = findById_('DocMaster', job.refId);
  if (!d) { throw new Error('Master document no longer exists'); }
  var text = masterText_(d.fileId);
  var what = d.kind === 'BMR'
    ? 'This is a master Batch Manufacturing Record. List every IN-PROCESS LIMIT a filled record must meet: pH limits at each step, pressures, temperatures, times, titration / chloride / free-chlorine limits, clarity or appearance requirements, % yield limit, drum or bag weight limits, and any other numeric acceptance limit. Use the step number or section as "stage".'
    : 'This is a ' + (d.kind === 'COA' ? 'Certificate of Analysis format' : 'finished product specification') + '. List every TEST with its SPECIFICATION LIMIT exactly as written (appearance, pH, solid content, LOD, NaCl, chloride, sulphate, heavy metals, iron, HCl insoluble matter, particle size, assay, microbial limits, etc.). Use "Finished product" as stage unless the document says bulk.';
  return baseParams_('medium', LIMITS_SCHEMA_,
    'You extract acceptance limits from pharmaceutical GMP master documents for an automated checking system. Copy limits exactly; never invent a limit that is not written in the document. ' +
    'limitType: RANGE (low and high), MAX (NMT / not more than / max / less than; put the value in high), MIN (NLT / not less than / min; put the value in low), TEXT (descriptive, e.g. "White paste free from foreign material"; put it in textSpec and set low/high null). ' +
    'For RANGE/MAX/MIN also copy the limit as written into textSpec. Units go in unit (e.g. %, % w/w, ppm, PSI, ml, kg). Give shelfLifeMonths if a shelf life is stated, else null.',
    [{ type: 'text', text: 'Document: ' + d.title + '\nProduct: ' + PRODUCTS[d.productCode] + '\n\n' + what + '\n\n<document>\n' + text + '\n</document>' }],
    setting_('LIMITS_MODEL') || 'claude-opus-5-5');
}

// ---- AI double-check of draft limits (a second, independent reading) ----

var VERIFY_SCHEMA_ = {
  type: 'object', additionalProperties: false, required: ['checks', 'missing'],
  properties: {
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'verdict', 'documentSays'],
      properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['MATCH', 'MISMATCH', 'NOT_FOUND'] }, documentSays: { type: 'string' } } } },
    missing: LIMITS_SCHEMA_.properties.parameters
  }
};

function apiQueueLimitVerify_(user, p) {
  if (!apiKey_()) { throw new Error('Set the Claude API key first (Settings, administrator).'); }
  var need = {};
  rows_('Limits').forEach(function (l) { if (l.status === 'DRAFT' && (p.all || !l.verify)) { need[l.masterId] = true; } });
  var ids = Object.keys(need).filter(function (id) { return !p.masterIds || p.masterIds.indexOf(id) >= 0; });
  ids.forEach(function (id) { queueJob_('LIMITS_VERIFY', id, ''); });
  audit_(user, 'LIMIT_DOUBLE_CHECK_QUEUED', 'Limits', '', '', '', ids.length + ' documents queued for the AI double-check of draft limits', '', p.client);
  return { queued: ids.length };
}

function verifyRequest_(job) {
  var d = findById_('DocMaster', job.refId);
  if (!d) { throw new Error('Master document no longer exists'); }
  var drafts = rows_('Limits').filter(function (l) { return l.masterId === d.id && l.status === 'DRAFT'; });
  if (!drafts.length) { throw new Error('No draft limits left to check'); }
  var list = drafts.map(function (l) {
    return { id: l.id, parameter: l.parameter, stage: l.stage, unit: l.unit, limitType: l.limitType, low: l.low, high: l.high, limitAsWritten: l.textSpec };
  });
  var text = masterText_(d.fileId);
  return baseParams_('medium', VERIFY_SCHEMA_,
    'You independently verify acceptance limits that were read from a pharmaceutical GMP master document. For EACH listed limit, find it in the document and compare it exactly: parameter, stage/step, numbers, unit and limit type (NLT/NMT/range). ' +
    'verdict MATCH only if the document states exactly this limit. MISMATCH if the document states a different value, unit, type or step - put exactly what the document says in documentSays. NOT_FOUND if the document does not contain it. ' +
    'For MATCH, documentSays may be empty. In "missing", list numeric acceptance limits written in the document that are absent from the list (empty array if none). Never invent limits.',
    [{ type: 'text', text: 'Document: ' + d.title + '\nProduct: ' + PRODUCTS[d.productCode] + '\nKind: ' + d.kind + '\n\nLimits to verify (JSON):\n' + JSON.stringify(list) + '\n\n<document>\n' + text + '\n</document>' }],
    setting_('LIMITS_MODEL') || 'claude-opus-5-5');
}

function storeVerify_(masterId, data) {
  var d = findById_('DocMaster', masterId);
  var drafts = indexBy_(rows_('Limits').filter(function (l) { return l.masterId === masterId && l.status === 'DRAFT'; }), 'id');
  var now = iso_(Date.now());
  var changed = [], c = { MATCH: 0, MISMATCH: 0, NOT_FOUND: 0 };
  (data.checks || []).forEach(function (k) {
    var l = drafts[k.id];
    if (!l) { return; }
    l.verify = k.verdict; l.verifyNote = k.verdict === 'MATCH' ? '' : String(k.documentSays || '').slice(0, 300); l.updatedAt = now;
    c[k.verdict] = (c[k.verdict] || 0) + 1;
    changed.push(l);
  });
  updateMany_('Limits', changed);
  var start = rows_('Limits').filter(function (l) { return l.masterId === masterId; }).length;
  var added = (data.missing || []).map(function (p, i) {
    return { id: newId_('L'), masterId: masterId, masterTitle: d.title, productCode: d.productCode, kind: d.kind,
      parameter: p.parameter, stage: p.stage || '', unit: p.unit || '', limitType: p.limitType,
      low: p.low == null ? '' : String(p.low), high: p.high == null ? '' : String(p.high), textSpec: p.textSpec || '',
      order: String(start + i + 1), status: 'DRAFT', source: 'AI check', approvedBy: '', approvedAt: '', updatedAt: now,
      verify: 'ADDED', verifyNote: 'Found only by the double-check - not in the first reading' };
  });
  insertMany_('Limits', added);
  audit_(null, 'LIMITS_DOUBLE_CHECKED', 'DocMaster', masterId, '', '', d.title + ': ' + c.MATCH + ' agree, ' + c.MISMATCH + ' differ, ' +
    c.NOT_FOUND + ' not found, ' + added.length + ' added', '', '');
}

/** Approves the draft limits of several documents with one electronic signature. Documents with
 *  unresolved double-check differences are skipped - QA opens and resolves those one by one. */
function apiApproveLimitsMany_(user, p) {
  if (hashPw_(p.password, user.salt) !== user.pwHash) { throw new Error('Password incorrect.'); }
  var ids = (p.masterIds || []).slice(0, 200);
  if (!ids.length) { throw new Error('Select at least one document.'); }
  var all = rows_('Limits');
  var now = iso_(Date.now());
  var toWrite = [], done = [], skipped = [];
  ids.forEach(function (mid) {
    var drafts = all.filter(function (l) { return l.masterId === mid && l.status === 'DRAFT'; });
    if (!drafts.length) { return; }
    var open = drafts.filter(function (l) { return l.verify === 'MISMATCH' || l.verify === 'NOT_FOUND' || l.verify === 'ADDED'; });
    if (open.length) { skipped.push({ title: drafts[0].masterTitle, reason: open.length + ' limit(s) to review' }); return; }
    drafts.forEach(function (l) { l.status = 'APPROVED'; l.approvedBy = user.name; l.approvedAt = now; l.updatedAt = now; toWrite.push(l); });
    done.push({ id: mid, title: drafts[0].masterTitle, n: drafts.length,
      checked: drafts.filter(function (l) { return l.verify === 'MATCH'; }).length });
  });
  updateMany_('Limits', toWrite);
  done.forEach(function (x) {
    audit_(user, 'LIMITS_APPROVED', 'DocMaster', x.id, '', '', x.n + ' limits approved for ' + x.title + ' (' + x.checked + ' confirmed by AI double-check; approved together with ' +
      (done.length - 1) + ' other document(s))', '', p.client);
  });
  return { approved: done.length, limits: toWrite.length, skipped: skipped };
}

/** Text of a .doc / .docx / Google Doc / PDF master document (converted through a temporary Google Doc). */
function masterText_(fileId) {
  var f = DriveApp.getFileById(fileId);
  var mime = f.getMimeType();
  if (mime === MimeType.GOOGLE_DOCS) { return DocumentApp.openById(fileId).getBody().getText(); }
  var copy = Drive.Files.copy({ name: 'BDVS temp - ' + f.getName(), mimeType: MimeType.GOOGLE_DOCS }, fileId);
  try { return DocumentApp.openById(copy.id).getBody().getText(); } finally { Drive.Files.remove(copy.id); }
}

var SCAN_SCHEMA_ = {
  type: 'object', additionalProperties: false, required: ['header', 'values', 'otherValues', 'observations'],
  properties: {
    header: { type: 'object', additionalProperties: false,
      required: ['batchNo', 'batchSize', 'mfgDate', 'expiryDate', 'retestDate', 'sampleReceiptDate', 'analysisStartDate',
        'analysisCompletedDate', 'reportDate', 'customer', 'challanNo', 'dispatchDate', 'dispatchQty', 'pagesPerIndex', 'missingPages'],
      properties: {
        batchNo: { type: 'string' }, batchSize: { type: 'string' }, mfgDate: { type: 'string' }, expiryDate: { type: 'string' },
        retestDate: { type: 'string' }, sampleReceiptDate: { type: 'string' }, analysisStartDate: { type: 'string' },
        analysisCompletedDate: { type: 'string' }, reportDate: { type: 'string' }, customer: { type: 'string' },
        challanNo: { type: 'string' }, dispatchDate: { type: 'string' }, dispatchQty: { type: 'string' },
        pagesPerIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, missingPages: { type: 'string' }
      } },
    values: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['limitId', 'value', 'numericValue', 'page', 'confidence', 'found'],
      properties: {
        limitId: { type: 'string' }, value: { type: 'string' }, numericValue: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        page: { type: 'integer' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, found: { type: 'boolean' }
      } } },
    otherValues: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['parameter', 'value', 'page'], properties: { parameter: { type: 'string' }, value: { type: 'string' }, page: { type: 'integer' } } } },
    observations: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['page', 'text', 'severity'],
      properties: { page: { type: 'integer' }, text: { type: 'string' }, severity: { type: 'string', enum: ['Critical', 'Major', 'Minor'] } } } }
  }
};

/** Key-parameter filter for the typed-values form: Production / QC type only the values QA decided matter. */
function keyWords_(txt) {
  return String(txt || '').split('|').map(function (g) {
    return g.split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(String);
  }).filter(function (g) { return g.length; });
}
function nameHas_(name, word) {
  var n = String(name || '').toLowerCase();
  if (/^[a-z0-9]{1,3}$/.test(word)) { return new RegExp('(^|[^a-z0-9])' + word + '([^a-z0-9]|$)').test(n); } // short words (pH, LOD) as whole words
  return n.indexOf(word) >= 0;
}
function isLakeCustomer_(customer) {
  var key = customerKey_(customer);
  return String(setting_('LAKE_COLOUR_CUSTOMERS') || '').split(',').some(function (c) {
    var k = customerKey_(c);
    return k && (key === k || (' ' + key + ' ').indexOf(' ' + k + ' ') >= 0);
  });
}
function keyFilter_(limits, docType, b) {
  if (setting_('KEY_PARAMS_ONLY') === 'NO') { return limits; }
  var exclude = String(setting_('KEY_PARAMS_EXCLUDE') || '').split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(String);
  var usable = limits.filter(function (l) { return !exclude.some(function (w) { return nameHas_(l.parameter, w); }); });
  var groups = keyWords_(setting_(docType === 'BMR_BPR' ? 'KEY_PARAMS_BMR' : 'KEY_PARAMS_COA'));
  if (docType !== 'BMR_BPR' && isLakeCustomer_(b.customer)) { groups = groups.concat(keyWords_(setting_('KEY_PARAMS_COA_LAKE'))); }
  var keep = {};
  groups.forEach(function (g) {
    var hits = usable.filter(function (l) { return g.some(function (w) { return nameHas_(l.parameter, w); }); });
    if (!hits.length) { return; }
    if (docType === 'BMR_BPR') { hits = [hits[hits.length - 1]]; } // last stage only (limits are in document order)
    hits.forEach(function (l) { keep[l.id] = true; });
  });
  return limits.filter(function (l) { return keep[l.id]; });
}

/** numericOnly: for the typed-values form - descriptive limits ("stir 15 min", "clarity OK") are checked by QA on the scan instead. */
function limitsForVersion_(v, numericOnly) {
  var d = findById_('Documents', v.docId);
  var b = findById_('Batches', v.batchId);
  var md = parseJson_(b.masterDocs, {});
  // COA: QC types what is printed on the customer's COA format. The specification is used only
  // when that COA format has no approved limits - combining both asked for every test twice.
  var approved = function (m) { return m && rows_('Limits').some(function (l) { return l.masterId === m.id && l.status === 'APPROVED'; }); };
  var masters = d.type === 'BMR_BPR' ? [md.BMR] : (approved(md.COA) ? [md.COA] : [md.SPEC]);
  var seen = {}, out = [];
  masters.forEach(function (m) {
    if (!m) { return; }
    rows_('Limits').filter(function (l) { return l.masterId === m.id && l.status === 'APPROVED' && l.stage !== 'INFO' && !(numericOnly && l.limitType === 'TEXT'); })
      .sort(function (a, c) { return Number(a.order) - Number(c.order); })
      .forEach(function (l) {
        var key = norm_(l.parameter) + '|' + norm_(l.stage);
        if (!seen[key]) { seen[key] = true; out.push(l); }
      });
  });
  if (numericOnly) { out = keyFilter_(out, d.type, b); }
  return out;
}

function scanRequest_(job) {
  var v = findById_('Versions', job.refId);
  if (!v) { throw new Error('Version not found'); }
  var d = findById_('Documents', v.docId);
  var b = findById_('Batches', v.batchId);
  var limits = limitsForVersion_(v, true); // key numeric values only - the same list QA chose for the form
  var files = parseJson_(v.files, []);
  var content = files.map(function (f) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf',
      data: Utilities.base64Encode(DriveApp.getFileById(f.fileId).getBlob().getBytes()) } };
  });
  var list = limits.map(function (l) {
    return '- limitId ' + l.id + ': ' + l.parameter + (l.stage ? ' [' + l.stage + ']' : '') + (l.unit ? ' (' + l.unit + ')' : '') + ' - limit: ' + limitText_(l);
  }).join('\n');
  content.push({ type: 'text', text:
    'Document type: ' + DOC_TYPES[d.type].label + '\nProduct: ' + b.product + '\nRegistered batch no.: ' + b.batchNo + '\nCustomer: ' + b.customer +
    '\nPages: ' + v.actualPages + (files.length > 1 ? ' across ' + files.length + ' files, in the order given' : '') + '\n\n' +
    (list ? 'Read the recorded (actual) result for each of these parameters. Report one entry per limitId; if a parameter was recorded several times (e.g. re-checks), report the final recorded value and mention the others in observations:\n' + list
      : 'No approved limits exist yet for this document; leave "values" empty and report all recorded results in otherValues.') +
    '\n\nAlso fill the header from the document (dates as YYYY-MM-DD; empty string if not present) and list any other recorded numeric results in otherValues. ' +
    'If the pages carry their own numbering such as "Page 3 of 21", set header.pagesPerIndex to that total (null if there is none) and list in header.missingPages the page numbers of that numbering that are absent from the upload (e.g. "1, 6, 16-21"; empty string if complete). ' +
    'In observations, report documentation problems you can see: blank fields or columns, missing signatures or dates, overwriting, unclear corrections, missing pages per the index, values that look inconsistent. Do not judge whether values meet limits - the system does that. ' +
    'Most serious first, at most 12 observations. These are NORMAL and must not be reported: the financial-year suffix after a batch number (e.g. "ALP/820 (26-27)" is batch ALP/820); ' +
    '"previous product" / "previous batch" entries on line-clearance, cleaning or dispensing records naming another batch; packing, labelling, sampling or dispatch dated after the completion of manufacturing; ' +
    '"NA" in a quantity-added or adjustment column when the measured value beside it is within its range; DEMO or training watermarks.' +
    (job.reading === '2' ? '\n\nThis is an independent second reading of a scan whose first reading was uncertain. Read every requested value digit by digit and report honestly what is written.' : '') });
  return baseParams_('high', SCAN_SCHEMA_,
    'You read scanned pharmaceutical batch records (handwritten Batch Manufacturing Records and typed Certificates of Analysis with raw data) for a QA checking system. ' +
    'Transcribe exactly what is written; never guess a value that is not legible. If a value is illegible or not recorded, set found=false, value="" and numericValue=null. ' +
    'numericValue is the number in the same unit as the limit (e.g. "6.56" -> 6.56; "18.42%" -> 18.42; "Less than 1 PPM" -> 1). Page numbers are 1-based across the whole upload. ' +
    'Handwriting rules: report the handwritten RESULT, never the pre-printed limit or specification next to it. Look carefully at decimal points and at digits that are easily confused ' +
    '(1/7, 4/9, 0/6, 5/6/8, 3/8). If a digit could reasonably be read two ways, put the most likely reading in value and set confidence=low. Use confidence=high only when every digit is unambiguous; ' +
    'medium when the writing is readable but untidy. If an entry was corrected (struck through and rewritten), report the final value and describe the correction in observations.',
    content, job.model || '');
}

// ---------------------------------------------------------------------------
// Entry form (VALUE_SOURCE = FORM): PRD / QC type the key values while uploading
// ---------------------------------------------------------------------------

var HEADER_FIELDS_ = {
  BMR_BPR: [['batchSize', 'Batch size (as written)', 'text'], ['mfgDate', 'Date of manufacture', 'date'], ['expiryDate', 'Expiry date', 'date'],
    ['challanNo', 'Challan no. in dispatch details', 'text'], ['dispatchDate', 'Dispatch date in dispatch details', 'date']],
  COA_RAW: [['batchNo', 'Batch no. as printed on COA', 'text'], ['mfgDate', 'Date of manufacture', 'date'], ['expiryDate', 'Expiry date', 'date'],
    ['sampleReceiptDate', 'Date of receipt of sample', 'date'], ['analysisCompletedDate', 'Analysis completed on', 'date'], ['reportDate', 'Report date', 'date'],
    ['customer', 'Customer name on COA', 'text']]
};

/** Fields shown in the upload form: the approved limits for this document's master documents + header data. */
function apiFormFields_(user, p) {
  var d = findById_('Documents', p.docId);
  if (!d) { throw new Error('Document not found.'); }
  if ((user.role === 'PRD' || user.role === 'QC') && d.dept !== user.role) { throw new Error('Not permitted.'); }
  if (setting_('VALUE_SOURCE') === 'AI' && aiOn_()) { return { mode: 'AI', fields: [], header: [] }; }
  var limits = limitsForVersion_({ docId: d.id, batchId: d.batchId }, setting_('FORM_ASK_DESCRIPTIVE') !== 'YES');
  return {
    mode: 'FORM',
    fields: limits.map(function (l) { return { limitId: l.id, parameter: l.parameter, stage: l.stage, unit: l.unit, text: l.limitType === 'TEXT' }; }),
    header: HEADER_FIELDS_[d.type].map(function (h) { return { key: h[0], label: h[1], type: h[2] }; })
  };
}

/** Called from apiUpload_ (Code.gs) in FORM mode, before anything is written: returns an error text or ''. */
function validateEntered_(d, p) {
  if (setting_('VALUE_SOURCE') === 'AI' && aiOn_()) { return ''; }
  var limits = limitsForVersion_({ docId: d.id, batchId: d.batchId }, setting_('FORM_ASK_DESCRIPTIVE') !== 'YES');
  var vals = p.values || {};
  var missing = limits.filter(function (l) { return !String(vals[l.id] == null ? '' : vals[l.id]).trim(); });
  if (missing.length) { return 'Enter the value recorded in the document for: ' + missing.map(function (l) { return l.parameter + (l.stage ? ' [' + l.stage + ']' : ''); }).join(', ') + ' (write NR if it is not recorded).'; }
  return '';
}

/** Stores the values typed at upload as results and runs all checks. */
function storeEntered_(versionId, p, user) {
  if (setting_('VALUE_SOURCE') === 'AI' && aiOn_()) { return null; }
  var v = findById_('Versions', versionId);
  var d = findById_('Documents', v.docId);
  var b = findById_('Batches', v.batchId);
  var limits = limitsForVersion_(v, setting_('FORM_ASK_DESCRIPTIVE') !== 'YES');
  var now = iso_(Date.now());
  var base = { versionId: versionId, docId: d.id, batchId: b.id, productCode: b.productCode, customer: b.customer, docType: d.type,
    correctedBy: '', correctionReason: '', createdAt: now, page: '', oot: '', ootText: '' };
  var hdr = p.header || {};
  Object.keys(hdr).forEach(function (k) {
    var val = String(hdr[k] || '').trim();
    if (val && HEADER_FIELDS_[d.type].some(function (h) { return h[0] === k; })) {
      insert_('Results', Object.assign({ id: newId_('RS'), parameter: k, stage: 'HEADER', value: val, numValue: '', unit: '',
        confidence: 'entered', limitId: '', limitText: '', check: 'INFO' }, base));
    }
  });
  var vals = p.values || {};
  insertMany_('Results', limits.map(function (l) {
    var raw = String(vals[l.id] == null ? '' : vals[l.id]).trim();
    var nr = /^(nr|na|n\/a|not recorded)$/i.test(raw);
    var num = nr ? null : raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return Object.assign({ id: newId_('RS'), parameter: l.parameter, stage: l.stage, value: nr ? '' : raw,
      numValue: num ? num[0] : '', unit: l.unit, confidence: 'entered', limitId: l.id, limitText: limitText_(l), check: '' }, base);
  }));
  evaluateVersion_(versionId);
  return true;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function storeLimits_(masterId, data) {
  var d = findById_('DocMaster', masterId);
  var now = iso_(Date.now());
  updateMany_('Limits', rows_('Limits').filter(function (l) { return l.masterId === masterId && l.status === 'DRAFT'; })
    .map(function (l) { l.status = 'RETIRED'; l.updatedAt = now; return l; }));
  var params = (data.parameters || []).slice();
  if (data.shelfLifeMonths) {
    params.push({ parameter: 'Shelf life', stage: 'INFO', unit: 'months', limitType: 'TEXT', low: null, high: null, textSpec: String(data.shelfLifeMonths) });
  }
  insertMany_('Limits', params.map(function (p, i) {
    return { id: newId_('L'), masterId: masterId, masterTitle: d.title, productCode: d.productCode, kind: d.kind,
      parameter: p.parameter, stage: p.stage || '', unit: p.unit || '', limitType: p.limitType,
      low: p.low == null ? '' : String(p.low), high: p.high == null ? '' : String(p.high), textSpec: p.textSpec || '',
      order: String(i + 1), status: 'DRAFT', source: 'AI', approvedBy: '', approvedAt: '', updatedAt: now };
  }));
  audit_(null, 'LIMITS_EXTRACTED', 'DocMaster', masterId, '', '', params.length + ' limits read from ' + d.title + ' (draft, awaiting QA approval)', '', '');
}

function limitText_(l) {
  if (l.limitType !== 'TEXT' && l.textSpec) { return l.textSpec; }
  if (l.limitType === 'RANGE') { return l.low + ' - ' + l.high + (l.unit ? ' ' + l.unit : ''); }
  if (l.limitType === 'MAX') { return 'NMT ' + l.high + (l.unit ? ' ' + l.unit : ''); }
  if (l.limitType === 'MIN') { return 'NLT ' + l.low + (l.unit ? ' ' + l.unit : ''); }
  return l.textSpec;
}

/** Without masterId: one summary row per master document (counts only - fast).
 *  With masterId: that document's limits. */
function apiGetLimits_(user, p) {
  p = p || {};
  var lim = rows_('Limits').filter(function (l) { return l.status !== 'RETIRED'; });
  if (p.masterId) {
    return { limits: lim.filter(function (l) { return l.masterId === p.masterId; }).map(strip_) };
  }
  var cnt = {};
  lim.forEach(function (l) {
    var c = cnt[l.masterId] = cnt[l.masterId] || { draft: 0, approved: 0, checked: 0, issues: 0 };
    if (l.status === 'DRAFT') {
      c.draft++;
      if (l.verify) { c.checked++; }
      if (l.verify === 'MISMATCH' || l.verify === 'NOT_FOUND' || l.verify === 'ADDED') { c.issues++; }
    } else if (l.status === 'APPROVED') { c.approved++; }
  });
  var masters = rows_('DocMaster').filter(function (d) { return d.active === 'Y' && d.kind !== 'STP'; }).map(function (d) {
    var c = cnt[d.id] || { draft: 0, approved: 0, checked: 0, issues: 0 };
    return { id: d.id, title: d.title, kind: d.kind, productCode: d.productCode, customerHint: d.customerHint, draft: c.draft, approved: c.approved,
      checked: c.checked, issues: c.issues };
  });
  return { masters: masters };
}

/** p = { id?, masterId, parameter, stage, unit, limitType, low, high, textSpec, retire, reason } */
function apiSaveLimit_(user, p) {
  var reason = req_(p.reason, 'Reason for change');
  var now = iso_(Date.now());
  var old = p.id ? findById_('Limits', p.id) : null;
  if (p.id && !old) { throw new Error('Limit not found.'); }
  if (p.retire) {
    old.status = 'RETIRED'; old.updatedAt = now; update_('Limits', old);
    audit_(user, 'LIMIT_RETIRED', 'Limit', old.id, '', old.parameter + ': ' + limitText_(old), '', reason, p.client);
    return true;
  }
  if (['RANGE', 'MAX', 'MIN', 'TEXT'].indexOf(p.limitType) < 0) { throw new Error('Choose the limit type.'); }
  var num = function (x, label) { if (x === '' || x == null) { return ''; } if (isNaN(Number(x))) { throw new Error(label + ' must be a number.'); } return String(Number(x)); };
  var lo = num(p.low, 'Lower limit'), hi = num(p.high, 'Upper limit');
  if (p.limitType === 'RANGE' && (lo === '' || hi === '' || Number(lo) > Number(hi))) { throw new Error('A range needs lower <= upper.'); }
  if (p.limitType === 'MAX' && hi === '') { throw new Error('Enter the maximum.'); }
  if (p.limitType === 'MIN' && lo === '') { throw new Error('Enter the minimum.'); }
  var m = findById_('DocMaster', p.masterId || (old && old.masterId));
  if (!m) { throw new Error('Master document not found.'); }
  var rec = { id: newId_('L'), masterId: m.id, masterTitle: m.title, productCode: m.productCode, kind: m.kind,
    parameter: req_(p.parameter, 'Parameter'), stage: String(p.stage || ''), unit: String(p.unit || ''), limitType: p.limitType,
    low: lo, high: hi, textSpec: String(p.textSpec || ''), order: old ? old.order : '999', status: 'DRAFT', source: 'QA',
    approvedBy: '', approvedAt: '', updatedAt: now };
  insert_('Limits', rec);
  if (old) { old.status = 'RETIRED'; old.updatedAt = now; update_('Limits', old); }
  audit_(user, old ? 'LIMIT_CHANGED' : 'LIMIT_ADDED', 'Limit', rec.id, '', old ? old.parameter + ': ' + limitText_(old) : '',
    rec.parameter + ': ' + limitText_(rec) + ' (draft)', reason, p.client);
  return rec.id;
}

/** Removes (retires) all descriptive draft limits of one document in one step, with one reason. */
function apiRetireDescriptive_(user, p) {
  var reason = req_(p.reason, 'Reason');
  var now = iso_(Date.now());
  var list = rows_('Limits').filter(function (l) {
    return l.masterId === p.masterId && l.status === 'DRAFT' && l.limitType === 'TEXT' && l.stage !== 'INFO';
  });
  if (!list.length) { throw new Error('No descriptive draft limits in this document.'); }
  list.forEach(function (l) { l.status = 'RETIRED'; l.updatedAt = now; });
  updateMany_('Limits', list);
  audit_(user, 'LIMITS_RETIRED_DESCRIPTIVE', 'DocMaster', p.masterId, '', list.map(function (l) { return l.parameter; }).join('; '),
    list.length + ' descriptive draft limits removed from ' + list[0].masterTitle, reason, p.client);
  return list.length;
}
ACTIONS.retireDescriptive = { roles: ['QA'], fn: apiRetireDescriptive_, write: true };

/** Approves all draft limits of one master document (electronic signature). */
function apiApproveLimits_(user, p) {
  if (hashPw_(p.password, user.salt) !== user.pwHash) { throw new Error('Password incorrect.'); }
  var drafts = rows_('Limits').filter(function (l) { return l.masterId === p.masterId && l.status === 'DRAFT'; });
  if (!drafts.length) { throw new Error('No draft limits to approve.'); }
  var now = iso_(Date.now());
  drafts.forEach(function (l) { l.status = 'APPROVED'; l.approvedBy = user.name; l.approvedAt = now; l.updatedAt = now; });
  updateMany_('Limits', drafts);
  audit_(user, 'LIMITS_APPROVED', 'DocMaster', p.masterId, '', '', drafts.length + ' limits approved for ' + drafts[0].masterTitle, '', p.client);
  return drafts.length;
}

// ---------------------------------------------------------------------------
// Checking a scan
// ---------------------------------------------------------------------------

/** The stronger model used for a second reading; '' when the feature is off or no stronger model is configured. */
function secondModel_(firstModel) {
  if (setting_('SCAN_SECOND_OPINION') === 'NO') { return ''; }
  var m2 = String(setting_('AI_MODEL_2') || '').trim();
  return m2 && m2 !== (firstModel || setting_('AI_MODEL')) ? m2 : '';
}

function storeScan_(versionId, data, job) {
  var v = findById_('Versions', versionId);
  var d = findById_('Documents', v.docId);
  var b = findById_('Batches', v.batchId);
  var limits = indexBy_(limitsForVersion_(v, true), 'id');
  var now = iso_(Date.now());
  var second = !!(job && job.reading === '2');
  // First-reading values, kept for comparison when this is the second reading.
  var prior = {};
  rows_('Results').filter(function (r) { return r.versionId === versionId && r.check !== 'SUPERSEDED' && r.limitId && r.confidence !== 'entered' && !r.correctedBy; })
    .forEach(function (r) { prior[r.limitId] = r; });
  updateMany_('Results', rows_('Results').filter(function (r) { return r.versionId === versionId && r.check !== 'SUPERSEDED'; })
    .map(function (r) { r.check = 'SUPERSEDED'; return r; }));
  updateMany_('Findings', rows_('Findings').filter(function (f) { return f.versionId === versionId && ((f.type === 'AI_NOTE' && f.status === 'NOTE') || (f.type === 'PAGES' && f.status === 'OPEN')); })
    .map(function (f) { f.status = 'SUPERSEDED'; return f; }));
  var base = { versionId: versionId, docId: d.id, batchId: b.id, productCode: b.productCode, customer: b.customer, docType: d.type,
    correctedBy: '', correctionReason: '', createdAt: now, priorValue: '' };
  var out = [];
  // Header fields
  var h = data.header || {};
  // The document's own page numbering ("Page x of N") versus what was uploaded: an incomplete scan is flagged for QA
  // even though the uploader ticked "all pages present".
  var perIndex = Number(h.pagesPerIndex) || 0, missing = String(h.missingPages || '').trim();
  if (perIndex && (perIndex > Number(v.actualPages || 0) || missing)) {
    addFinding_(versionId, 'PAGES', 'WARN', 'Upload looks incomplete: the document is numbered "of ' + perIndex + '" pages but ' + v.actualPages + ' page(s) were uploaded' +
      (missing ? ' (not found: page ' + missing + ')' : '') + '. Reject for re-upload of the complete document, or justify if the numbering is misleading.', '');
  }
  delete h.pagesPerIndex; delete h.missingPages;
  Object.keys(h).forEach(function (k) {
    if (String(h[k] || '').trim()) {
      out.push(Object.assign({ id: newId_('RS'), parameter: k, stage: 'HEADER', value: String(h[k]), numValue: '', unit: '',
        page: '', confidence: '', limitId: '', limitText: '', check: 'INFO', oot: '', ootText: '' }, base));
    }
  });
  // Values against limits
  var reported = {};
  (data.values || []).forEach(function (x) {
    var l = limits[x.limitId];
    if (!l || reported[l.id]) { return; }
    reported[l.id] = true;
    var row = Object.assign({ id: newId_('RS'), parameter: l.parameter, stage: l.stage, value: x.found ? String(x.value) : '',
      numValue: x.found && x.numericValue != null ? String(x.numericValue) : '', unit: l.unit, page: String(x.page || ''),
      confidence: x.confidence, limitId: l.id, limitText: limitText_(l), check: '', oot: '', ootText: '' }, base);
    if (second) { compareReadings_(row, prior[l.id]); }
    out.push(row);
  });
  Object.keys(limits).forEach(function (id) {
    if (reported[id] || limits[id].stage === 'INFO') { return; }
    var l = limits[id];
    var miss = Object.assign({ id: newId_('RS'), parameter: l.parameter, stage: l.stage, value: '', numValue: '', unit: l.unit,
      page: '', confidence: '', limitId: l.id, limitText: limitText_(l), check: '', oot: '', ootText: '' }, base);
    if (second) { compareReadings_(miss, prior[l.id]); }
    out.push(miss);
  });
  insertMany_('Results', out);
  // Documentation remarks from the reading: one non-blocking note for QA, who reviews the scan anyway.
  var obs = (data.observations || []).map(function (o) { return 'p.' + o.page + ' [' + o.severity + '] ' + o.text; });
  if (obs.length) {
    var f = addFinding_(versionId, 'AI_NOTE', 'INFO', 'Noticed while reading the scan (check while answering the checklist): ' + obs.join(' | '), '');
    if (f && f.status === 'OPEN') { f.status = 'NOTE'; update_('Findings', f); }
  }
  // Doubt after the first reading -> an independent second reading by the stronger model, queued BEFORE the
  // evaluation so that an out-of-limit value is held back (not emailed) until both readings have been seen.
  if (job && !second) {
    var m2 = secondModel_(job.model);
    var doubt = m2 && out.some(function (r) {
      if (!r.limitId) { return false; }
      var c = checkValue_(limits[r.limitId], r);
      return c === 'FAIL' || c === 'CHECK' || c === 'UNREADABLE' || r.confidence === 'medium';
    });
    if (doubt) { queueJob_('SCAN', versionId, b.id, { model: m2, reading: '2', afterJobId: job.id }); }
  }
  evaluateVersion_(versionId);
}

/** Second reading vs first: agreement makes the value certain; disagreement marks it for QA with both readings shown. */
function compareReadings_(row, first) {
  if (!first) { return; }
  var a = first.value !== '' ? first.value : '', bb = row.value;
  if (a === '' && bb === '') { return; }
  if (a === '' || bb === '') { row.priorValue = a === '' ? '(not found)' : a; if (bb !== '') { row.confidence = 'low'; } return; }
  var na = Number(first.numValue), nb = Number(row.numValue);
  var same = (!isNaN(na) && !isNaN(nb) && first.numValue !== '' && row.numValue !== '') ? na === nb : norm_(a) === norm_(bb);
  if (same) { row.confidence = 'high'; row.priorValue = ''; }
  else { row.confidence = 'low'; row.priorValue = a; }
}

/** (Re)computes limit checks, trend, cross-checks and date checks for a version. */
function evaluateVersion_(versionId) {
  var v = findById_('Versions', versionId);
  var d = findById_('Documents', v.docId);
  var b = findById_('Batches', v.batchId);
  var limits = indexBy_(rows_('Limits'), 'id');
  // Derived findings are recomputed; resolved ones are kept for the record.
  rows_('Findings').filter(function (f) { return f.versionId === versionId && (f.status === 'OPEN' || f.status === 'NOTE') && ['LIMIT', 'UNREADABLE', 'OOT', 'CROSS', 'DATE', 'NR_NOTE'].indexOf(f.type) >= 0; })
    .forEach(function (f) { f.status = 'SUPERSEDED'; update_('Findings', f); });
  var fails = [], notRecorded = [], toConfirm = [], held = [];
  // A second reading on its way means a first-reading "out of limit" may simply be a misread digit: hold the
  // alarm (no BLOCK, no email) until both readings are in. QA's "proceed without automatic check" ends the hold.
  var skipped = rows_('Findings').some(function (f) { return f.versionId === versionId && f.type === 'SKIP_AI' && f.status === 'RESOLVED'; });
  var secondPending = !skipped && rows_('AiJobs').some(function (j) {
    return j.kind === 'SCAN' && j.refId === versionId && j.reading === '2' && (j.status === 'PENDING' || j.status === 'SUBMITTED');
  });
  rows_('Results').filter(function (r) { return r.versionId === versionId && r.check !== 'SUPERSEDED' && r.limitId; }).forEach(function (r) {
    var l = limits[r.limitId];
    var res = checkValue_(l, r);
    r.check = res;
    var t = trend_(r, b);
    r.oot = t ? 'Y' : 'N'; r.ootText = t || '';
    update_('Results', r);
    var where = r.parameter + (r.stage ? ' [' + r.stage + ']' : '') + (r.page ? ' (p.' + r.page + ')' : '');
    var fromScan = r.confidence !== 'entered' && !r.correctedBy;
    if (res === 'FAIL' && secondPending && fromScan) {
      held.push(where + ': read "' + r.value + '", outside limit ' + r.limitText);
    } else if (res === 'FAIL') {
      fails.push(where + ': ' + r.value + ' vs limit ' + r.limitText);
      addFinding_(versionId, 'LIMIT', 'BLOCK', 'OUT OF LIMIT - ' + where + ': recorded ' + r.value + ', limit ' + r.limitText +
        (r.priorValue ? ' (first reading: ' + r.priorValue + ')' : '') +
        (fromScan ? '. If the handwriting was misread, use "Correct"; otherwise record the deviation / OOS reference.' : ''), r.id);
    } else if (res === 'UNREADABLE' && r.confidence === 'entered') {
      notRecorded.push(r.parameter + (r.stage ? ' [' + r.stage + ']' : '')); // typed as NR by the uploader - shown, not blocking
    } else if (res === 'UNREADABLE') {
      toConfirm.push(where + ': not found / not legible' + (r.priorValue && r.priorValue !== '(not found)' ? ' on the second reading; the first reading saw "' + r.priorValue + '"' : ''));
    } else if (res === 'CHECK') {
      toConfirm.push(where + (r.priorValue ? ': the two readings differ - first "' + r.priorValue + '", second "' + r.value + '" (second is within limit ' + r.limitText + ')'
        : ': read "' + r.value + '" (unsure, within limit ' + r.limitText + ')'));
    }
    if (t) { addFinding_(versionId, 'OOT', 'WARN', 'Out of trend - ' + where + ': ' + t, r.id); }
  });
  if (held.length) {
    var hf = addFinding_(versionId, 'NR_NOTE', 'INFO', 'Being re-read by the stronger model before it is raised - ' + held.length + ' value(s) looked out of limit on the first reading: ' + held.join('; ') +
      '. Nothing to do yet; the result appears here in a few minutes.', '');
    if (hf && hf.status === 'OPEN') { hf.status = 'NOTE'; update_('Findings', hf); }
  }
  if (toConfirm.length) {
    var cf = addFinding_(versionId, 'NR_NOTE', 'INFO', 'Confirm on the scan - the automatic reading was not sure about ' + toConfirm.length + ' value(s): ' + toConfirm.join('; ') +
      '. Use "Correct" if a value is misread; no separate justification needed.', '');
    if (cf && cf.status === 'OPEN') { cf.status = 'NOTE'; update_('Findings', cf); }
  }
  if (notRecorded.length) {
    addFinding_(versionId, 'NR_NOTE', 'INFO', notRecorded.length + ' value(s) typed as NR (not recorded in the document): ' + notRecorded.join('; ') +
      '. Confirm on the scan while answering the checklist - no separate justification needed.', '');
    var nf = rows_('Findings').filter(function (f) { return f.versionId === versionId && f.type === 'NR_NOTE' && f.status === 'OPEN'; });
    nf.forEach(function (f) { f.status = 'NOTE'; update_('Findings', f); });
  }
  dateChecks_(v, d, b);
  crossChecks_(b);
  if (fails.length) {
    var to = splitEmails_(setting_('EMAIL_QA_HEAD')).concat(deptEmails_('QA'));
    sendMail_('OOL|' + versionId + '|' + fails.length, 'OUT_OF_LIMIT', versionId, b.batchNo, to, splitEmails_(setting_('EMAIL_ESCALATION')),
      'OUT OF LIMIT: ' + DOC_TYPES[d.type].label + ' - Batch ' + b.batchNo,
      mailBody_('Out-of-limit value found by the automatic check',
        'The automatic check of <b>' + DOC_TYPES[d.type].label + '</b> v' + v.versionNo + ' for batch <b>' + esc_(b.batchNo) + '</b> (' + esc_(b.customer) +
        ') found:<ul>' + fails.map(function (f) { return '<li>' + esc_(f) + '</li>'; }).join('') + '</ul>The document cannot be accepted until QA records a deviation / OOS reference (QAGE/025) and justification for each item.', ''));
  }
}

function checkValue_(l, r) {
  if (!l) { return 'NO_LIMIT'; }
  if (l.limitType === 'TEXT') { return r.value ? 'INFO' : 'UNREADABLE'; }
  if (r.numValue === '' || isNaN(Number(r.numValue))) { return 'UNREADABLE'; }
  var x = Number(r.numValue);
  var ok = l.limitType === 'RANGE' ? (x >= Number(l.low) && x <= Number(l.high))
    : l.limitType === 'MAX' ? x <= Number(l.high) : x >= Number(l.low);
  if (!ok) { return 'FAIL'; }
  return r.confidence === 'low' && !r.correctedBy ? 'CHECK' : 'PASS';
}

/** Out of trend: beyond mean +/- 3 SD of the same parameter in previous accepted batches (needs >= 8). */
function trend_(r, b) {
  if (r.numValue === '' || isNaN(Number(r.numValue))) { return ''; }
  var n = Number(setting_('TREND_BATCHES')) || 30;
  var accepted = {};
  rows_('Versions').forEach(function (v) { if (v.status === 'ACCEPTED') { accepted[v.id] = true; } });
  var hist = rows_('Results').filter(function (x) {
    return accepted[x.versionId] && x.batchId !== b.id && x.check !== 'SUPERSEDED' && x.productCode === r.productCode &&
      norm_(x.parameter) === norm_(r.parameter) && norm_(x.stage) === norm_(r.stage) && x.numValue !== '' && !isNaN(Number(x.numValue));
  }).sort(function (a, c) { return String(a.createdAt).localeCompare(String(c.createdAt)); }).slice(-n).map(function (x) { return Number(x.numValue); });
  if (hist.length < 8) { return ''; }
  var mean = hist.reduce(function (s, x) { return s + x; }, 0) / hist.length;
  var sd = Math.sqrt(hist.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (hist.length - 1));
  if (!(sd > 0)) { return ''; }
  var z = (Number(r.numValue) - mean) / sd;
  if (Math.abs(z) <= 3) { return ''; }
  return r.numValue + ' is ' + Math.abs(z).toFixed(1) + ' SD ' + (z > 0 ? 'above' : 'below') + ' the mean of the last ' + hist.length +
    ' batches (' + mean.toFixed(2) + ' +/- ' + sd.toFixed(2) + ')';
}

function headerOf_(versionId) {
  var h = {};
  rows_('Results').filter(function (r) { return r.versionId === versionId && r.stage === 'HEADER' && r.check !== 'SUPERSEDED'; })
    .forEach(function (r) { h[r.parameter] = r.value; });
  return h;
}

function ymdOrEmpty_(s) { try { return s ? normDate_(s) : ''; } catch (e) { return ''; } }

function dateChecks_(v, d, b) {
  var h = headerOf_(v.id);
  var D = function (k) { return ymdOrEmpty_(h[k]); };
  var issues = [];
  var mfg = D('mfgDate'), rec = D('sampleReceiptDate'), st = D('analysisStartDate'), comp = D('analysisCompletedDate'), rep = D('reportDate'), exp = D('expiryDate');
  var pairs = [[mfg, rec, 'Sample received before manufacture'], [rec, st, 'Analysis started before sample receipt'],
    [st, comp, 'Analysis completed before it started'], [comp, rep, 'Report dated before analysis completed']];
  pairs.forEach(function (p) { if (p[0] && p[1] && p[1] < p[0]) { issues.push(p[2] + ' (' + fmtDate_(ymdToMs_(p[0], 12)) + ' > ' + fmtDate_(ymdToMs_(p[1], 12)) + ')'); } });
  if (rep && b.dispatchDate < rep) { issues.push('COA report date ' + fmtDate_(ymdToMs_(rep, 12)) + ' is after dispatch ' + fmtDate_(ymdToMs_(b.dispatchDate, 12)) + ' - batch dispatched before release?'); }
  if (mfg && b.dispatchDate < mfg) { issues.push('Dispatch date is before the manufacturing date'); }
  if (mfg && mfg > istYmd_(Date.now())) { issues.push('Manufacturing date is in the future'); }
  if (mfg && exp) {
    var md = parseJson_(b.masterDocs, {});
    var months = null;
    rows_('Limits').forEach(function (l) {
      if (l.status === 'APPROVED' && l.parameter === 'Shelf life' && md && ((md.BMR && l.masterId === md.BMR.id) || (md.SPEC && l.masterId === md.SPEC.id) || (md.COA && l.masterId === md.COA.id))) { months = Number(l.textSpec); }
    });
    if (months) {
      var p = mfg.split('-').map(Number);
      var expect = istYmd_(Date.UTC(p[0], p[1] - 1 + months, p[2], 12) - IST_OFF);
      var diff = Math.round((ymdToMs_(exp, 12) - ymdToMs_(expect, 12)) / DAY);
      if (diff > 1 || diff < -2) { issues.push('Expiry ' + fmtDate_(ymdToMs_(exp, 12)) + ' does not match mfg date + ' + months + ' months shelf life (' + fmtDate_(ymdToMs_(expect, 12)) + ')'); }
    }
  }
  issues.forEach(function (t) { addFinding_(v.id, 'DATE', 'WARN', t); });
}

/** BMR vs COA vs registered dispatch. Runs whenever either document has been read. */
function crossChecks_(b) {
  var docs = rows_('Documents').filter(function (x) { return x.batchId === b.id; });
  var latest = {};
  docs.forEach(function (x) {
    var v = rows_('Versions').filter(function (y) { return y.docId === x.id && String(y.versionNo) === String(x.currentVersion); })[0];
    if (v) { latest[x.type] = v; }
  });
  var bmr = latest.BMR_BPR ? headerOf_(latest.BMR_BPR.id) : null;
  var coa = latest.COA_RAW ? headerOf_(latest.COA_RAW.id) : null;
  // Batch numbers compare without spaces and without a financial-year suffix: "ALP/820 (26-27)" = "ALP/820" = "ALP/820/2026-27".
  var bn = function (s) {
    return String(s || '').toUpperCase().replace(/\s+/g, '')
      .replace(/[(\[\/\-]+(20)?\d{2}-(20)?\d{2}[)\]]*$/, '')
      .replace(/[()]/g, '');
  };
  var kg = function (s) { var m = String(s || '').replace(/,/g, '').match(/(\d+(\.\d+)?)/); return m ? Number(m[1]) : null; };
  var checks = [];
  [['BMR_BPR', bmr, 'BMR'], ['COA_RAW', coa, 'COA']].forEach(function (x) {
    var hh = x[1]; if (!hh) { return; }
    if (hh.batchNo && bn(hh.batchNo) !== bn(b.batchNo)) { checks.push([x[0], 'BLOCK', x[2] + ' batch no. "' + hh.batchNo + '" does not match registered batch ' + b.batchNo]); }
    if (hh.batchSize && kg(hh.batchSize) && kg(b.batchSize) && kg(hh.batchSize) !== kg(b.batchSize)) { checks.push([x[0], 'WARN', x[2] + ' batch size ' + hh.batchSize + ' differs from registered ' + b.batchSize]); }
  });
  if (bmr && bmr.challanNo && b.invoiceNo && bn(bmr.challanNo).indexOf(bn(b.invoiceNo)) < 0 && bn(b.invoiceNo).indexOf(bn(bmr.challanNo)) < 0) {
    checks.push(['BMR_BPR', 'WARN', 'Challan no. in BMR dispatch details (' + bmr.challanNo + ') differs from registered ' + b.invoiceNo]);
  }
  if (bmr && bmr.dispatchDate && ymdOrEmpty_(bmr.dispatchDate) && ymdOrEmpty_(bmr.dispatchDate) !== b.dispatchDate) {
    checks.push(['BMR_BPR', 'WARN', 'Dispatch date in BMR (' + bmr.dispatchDate + ') differs from registered ' + fmtDate_(ymdToMs_(b.dispatchDate, 12))]);
  }
  if (coa && coa.customer) {
    var ck = customerKey_(b.customer).split(' ').filter(function (t) { return t.length >= 3; });
    var cc = ' ' + customerKey_(coa.customer) + ' ';
    if (ck.length && !ck.some(function (t) { return cc.indexOf(' ' + t) >= 0; })) { checks.push(['COA_RAW', 'WARN', 'Customer on COA ("' + coa.customer + '") differs from dispatch customer ' + b.customer]); }
  }
  if (bmr && coa) {
    [['batchNo', 'Batch no.', bn], ['batchSize', 'Batch size', kg], ['mfgDate', 'Mfg date', ymdOrEmpty_], ['expiryDate', 'Expiry date', ymdOrEmpty_]].forEach(function (f) {
      var a = f[2](bmr[f[0]]), c = f[2](coa[f[0]]);
      if (a && c && a !== c) { checks.push(['COA_RAW', f[0] === 'batchNo' ? 'BLOCK' : 'WARN', f[1] + ' differs: BMR "' + bmr[f[0]] + '" vs COA "' + coa[f[0]] + '"']); }
    });
  }
  // Replace open cross-check findings on both documents.
  Object.keys(latest).forEach(function (t) {
    rows_('Findings').filter(function (f) { return f.versionId === latest[t].id && f.type === 'CROSS' && f.status === 'OPEN'; })
      .forEach(function (f) { f.status = 'SUPERSEDED'; update_('Findings', f); });
  });
  checks.forEach(function (c) { if (latest[c[0]]) { addFinding_(latest[c[0]].id, 'CROSS', c[1], c[2]); } });
}

function addFinding_(versionId, type, severity, text, resultId) {
  var v = findById_('Versions', versionId);
  if (!v) { return null; }
  var d = findById_('Documents', v.docId);
  // Keep an identical resolved finding resolved (e.g. after a re-check) instead of re-opening it.
  var same = rows_('Findings').filter(function (f) { return f.versionId === versionId && f.text === text && f.status === 'RESOLVED'; })[0];
  if (same) { return same; }
  return insert_('Findings', { id: newId_('FN'), versionId: versionId, batchId: v.batchId, docType: d ? d.type : '', type: type,
    severity: severity, text: text, resultId: resultId || '', status: 'OPEN', devRef: '', resolution: '', resolvedBy: '', resolvedAt: '',
    createdAt: iso_(Date.now()) });
}

// ---------------------------------------------------------------------------
// QA actions on checks
// ---------------------------------------------------------------------------

function apiGetChecks_(user, p) {
  var v = findById_('Versions', p.versionId);
  if (!v) { throw new Error('Version not found.'); }
  var d = findById_('Documents', v.docId);
  if ((user.role === 'PRD' || user.role === 'QC') && d.dept !== user.role) { throw new Error('Not permitted.'); }
  var job = rows_('AiJobs').filter(function (j) { return j.kind === 'SCAN' && j.refId === v.id; }).pop();
  var legacy = rows_('Findings').some(function (f) { return f.versionId === v.id && f.status === 'OPEN' && /^Recorded as not available \(NR\)/.test(f.text); });
  if (legacy && v.status === 'UNDER_VERIFICATION') { withLock_(function () { evaluateVersion_(v.id); }); }
  return {
    aiEnabled: true, valueSource: setting_('VALUE_SOURCE') || 'FORM',
    job: job ? { status: job.status, error: job.error, createdAt: job.createdAt, doneAt: job.doneAt, reading: job.reading || '1', model: job.model || '' } : null,
    results: rows_('Results').filter(function (r) { return r.versionId === v.id && r.check !== 'SUPERSEDED'; }).map(strip_),
    findings: rows_('Findings').filter(function (f) { return f.versionId === v.id && f.status !== 'SUPERSEDED'; }).map(strip_)
  };
}

/** QA enters the value read on the scan (illegible / misread). Re-evaluates the version. */
function apiCorrectResult_(user, p) {
  var r = findById_('Results', p.resultId);
  if (!r) { throw new Error('Result not found.'); }
  var reason = req_(p.reason, 'Reason');
  var val = req_(p.value, 'Value');
  var num = String(val).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  var old = r.value;
  r.value = val; r.numValue = num ? num[0] : ''; r.correctedBy = user.name; r.correctionReason = reason; r.confidence = 'high';
  update_('Results', r);
  var b = findById_('Batches', r.batchId);
  audit_(user, 'RESULT_CORRECTED', 'Result', r.id, b.batchNo, old, r.parameter + ' = ' + val, reason, p.client);
  evaluateVersion_(r.versionId);
  return true;
}

/** BLOCK findings need a deviation / OOS reference; every finding needs a justification. */
function apiResolveFinding_(user, p) {
  var f = findById_('Findings', p.findingId);
  if (!f || f.status !== 'OPEN') { throw new Error('Finding not open.'); }
  var just = req_(p.resolution, 'Justification');
  var ref = String(p.devRef || '').trim();
  if (f.severity === 'BLOCK' && !ref) { throw new Error('Enter the Deviation / OOS reference number (QAGE/025).'); }
  f.status = 'RESOLVED'; f.devRef = ref; f.resolution = just; f.resolvedBy = user.name; f.resolvedAt = iso_(Date.now());
  update_('Findings', f);
  var b = findById_('Batches', f.batchId);
  audit_(user, 'FINDING_RESOLVED', 'Finding', f.id, b.batchNo, f.text, (ref ? 'Ref ' + ref + ': ' : '') + just, '', p.client);
  return true;
}

/** Used by apiDecide_ before ACCEPT. Returns a list of reasons the version cannot be accepted. */
function acceptBlockers_(versionId) {
  var out = [];
  var job = rows_('AiJobs').filter(function (j) { return j.kind === 'SCAN' && j.refId === versionId; }).pop();
  if (job && (job.status === 'PENDING' || job.status === 'SUBMITTED')) {
    out.push(job.reading === '2' ? 'The second reading of a doubtful value is still running (a few minutes). Wait for it, or record a justification under "Proceed without automatic check".'
      : 'The automatic check is still running (usually a few minutes). Wait for it, or record a justification under "Proceed without automatic check".');
    var skip = rows_('Findings').filter(function (f) { return f.versionId === versionId && f.type === 'SKIP_AI' && f.status === 'RESOLVED'; })[0];
    if (skip) { out.pop(); }
  }
  // Belt and braces: an out-of-limit value can never be accepted without a resolved LIMIT finding, whatever the job state.
  var resolvedFor = {};
  rows_('Findings').forEach(function (f) { if (f.versionId === versionId && f.type === 'LIMIT' && f.status === 'RESOLVED') { resolvedFor[f.resultId] = true; } });
  rows_('Results').filter(function (r) { return r.versionId === versionId && r.check === 'FAIL' && !resolvedFor[r.id]; }).forEach(function (r) {
    if (!rows_('Findings').some(function (f) { return f.resultId === r.id && f.type === 'LIMIT' && f.status === 'OPEN'; })) {
      out.push('Out of limit on the first reading (' + r.parameter + ' = ' + r.value + ') - wait for the second reading, or use "Proceed without automatic check" to record the deviation now.');
    }
  });
  rows_('Findings').filter(function (f) { return f.versionId === versionId && f.status === 'OPEN'; }).forEach(function (f) {
    out.push((f.severity === 'BLOCK' ? 'Needs deviation/OOS ref: ' : 'Needs QA justification: ') + f.text);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Monthly limits / trend report
// ---------------------------------------------------------------------------

/** p = { month: 'YYYY-MM', productCode? } - batches dispatched in that month. */
function apiMonthlyReport_(user, p) {
  var month = String(p.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) { throw new Error('Choose a month.'); }
  var batches = rows_('Batches').filter(function (b) { return String(b.dispatchDate).slice(0, 7) === month && (!p.productCode || b.productCode === p.productCode); });
  var ids = {}; batches.forEach(function (b) { ids[b.id] = b; });
  var current = {};
  rows_('Documents').forEach(function (d) { if (ids[d.batchId]) { current[d.id] = String(d.currentVersion); } });
  var verIds = {};
  rows_('Versions').forEach(function (v) { if (ids[v.batchId] && current[v.docId] === String(v.versionNo)) { verIds[v.id] = true; } });
  var res = rows_('Results').filter(function (r) { return verIds[r.versionId] && r.check !== 'SUPERSEDED' && r.limitId; });
  var by = {};
  res.forEach(function (r) {
    var k = r.productCode + '|' + r.docType + '|' + r.parameter + '|' + r.stage;
    var g = by[k] = by[k] || { productCode: r.productCode, docType: r.docType, parameter: r.parameter, stage: r.stage, unit: r.unit, limitText: r.limitText, values: [], fail: 0, oot: 0, unreadable: 0 };
    if (r.numValue !== '' && !isNaN(Number(r.numValue))) { g.values.push(Number(r.numValue)); }
    if (r.check === 'FAIL') { g.fail++; }
    if (r.check === 'UNREADABLE') { g.unreadable++; }
    if (r.oot === 'Y') { g.oot++; }
  });
  var rows = Object.keys(by).sort().map(function (k) {
    var g = by[k], v = g.values, n = v.length;
    var mean = n ? v.reduce(function (s, x) { return s + x; }, 0) / n : null;
    var sd = n > 1 ? Math.sqrt(v.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (n - 1)) : null;
    return { productCode: g.productCode, docType: g.docType, parameter: g.parameter, stage: g.stage, unit: g.unit, limitText: g.limitText,
      n: n, min: n ? Math.min.apply(null, v) : null, max: n ? Math.max.apply(null, v) : null,
      mean: mean == null ? null : Number(mean.toFixed(3)), sd: sd == null ? null : Number(sd.toFixed(3)), fail: g.fail, oot: g.oot, unreadable: g.unreadable };
  });
  var findings = rows_('Findings').filter(function (f) { return verIds[f.versionId] && f.status !== 'SUPERSEDED'; }).map(function (f) {
    var b = ids[f.batchId];
    return { batchNo: b.batchNo, customer: b.customer, docType: f.docType, type: f.type, severity: f.severity, text: f.text, status: f.status, devRef: f.devRef, resolution: f.resolution };
  });
  return { month: month, batches: batches.length, closed: batches.filter(function (b) { return b.status === 'CLOSED'; }).length, rows: rows, findings: findings };
}
