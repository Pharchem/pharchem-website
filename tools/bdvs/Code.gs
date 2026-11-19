/**
 * BDVS - Batch Document Verification System
 * Google Apps Script web app (container-bound to a Google Sheet).
 *
 * Flow: QA registers a dispatched batch -> PRD uploads the scanned BMR/BPR and
 * QC uploads the scanned COA + raw data within the upload deadline -> QA verifies
 * each scan within 24 working hours (accept / reject with observations ->
 * re-upload as a new version) -> PRD/QC hand over hardcopies -> QA records
 * receipt -> QA completes Batch Data Verification (batch CLOSED).
 *
 * Reference: URS-BDVS-001. See README.md for setup.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var IST_OFF = 330 * 60000;          // IST = UTC+05:30, no daylight saving
var HOUR = 3600000;
var DAY = 86400000;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var ROLES = ['PRD', 'QC', 'QA', 'ADMIN'];

var PRODUCTS = {
  ALP: 'Aluminium Hydroxide Gel Paste',
  MGP: 'Magnesium Hydroxide Paste'
};

var MASTER_KINDS = { BMR: 'BMR', STP: 'STP', SPEC: 'Specification', COA: 'COA format' };

var DOC_TYPES = {
  BMR_BPR: { label: 'BMR / BPR (filled, scanned)', dept: 'PRD' },
  COA_RAW: { label: 'COA + Raw data / Analytical protocol', dept: 'QC' }
};

var SHEETS = Object.assign(typeof SHEETS !== 'undefined' && SHEETS ? SHEETS : {}, {
  Users: ['id', 'name', 'username', 'email', 'role', 'active', 'salt', 'pwHash', 'mustChange',
    'pwChangedAt', 'failed', 'lockedUntil', 'createdAt', 'createdBy'],
  Batches: ['id', 'productCode', 'product', 'batchNo', 'batchSize', 'dispatchDate', 'invoiceNo', 'customer', 'market',
    'site', 'remarks', 'status', 'registeredAt', 'registeredBy', 'closedAt', 'closedBy', 'closeRemarks', 'masterDocs'],
  Documents: ['id', 'batchId', 'batchNo', 'product', 'type', 'dept', 'dueAt', 'status', 'currentVersion',
    'rejectCount', 'firstUploadAt', 'lateHours', 'verifiedAt', 'hardcopyDueAt', 'hardcopyReceivedAt',
    'lastRejectedAt', 'updatedAt'],
  Versions: ['id', 'docId', 'batchId', 'versionNo', 'files', 'declaredPages', 'actualPages', 'uploaderId',
    'uploaderName', 'uploadedAt', 'lateHours', 'checklist', 'remarks', 'verifyDueAt', 'status',
    'decidedAt', 'decidedBy', 'elapsedHours', 'breach'],
  Verifications: ['id', 'versionId', 'docId', 'batchId', 'outcome', 'checklist', 'remarks', 'verifierId',
    'verifierName', 'decidedAt', 'elapsedHours', 'breach'],
  Observations: ['id', 'versionId', 'docId', 'batchId', 'page', 'text', 'severity', 'createdAt', 'createdBy'],
  Hardcopies: ['id', 'docId', 'batchId', 'receivedFrom', 'receivedOn', 'pagesReceived', 'pagesScanned',
    'condition', 'location', 'discrepancy', 'discrepancyText', 'status', 'recordedAt', 'recordedBy',
    'resolvedAt', 'resolvedBy', 'resolution'],
  Holidays: ['date', 'name', 'addedBy', 'addedAt'],
  DocMaster: ['id', 'productCode', 'kind', 'number', 'title', 'customerHint', 'batchSize', 'fileId', 'url', 'folderPath',
    'active', 'importedAt'],
  ImportLog: ['id', 'runAt', 'by', 'rowsRead', 'registered', 'awaitingDispatch', 'alreadyRegistered', 'errors', 'details'],
  CustomerProfiles: ['key', 'productCode', 'customer', 'bmrId', 'stpId', 'specId', 'coaId', 'batchSize', 'market',
    'updatedAt', 'updatedBy'],
  Checklists: ['id', 'docType', 'item', 'order', 'active'],
  Settings: ['key', 'value', 'description'],
  ReminderLog: ['id', 'key', 'type', 'refId', 'batchNo', 'to', 'cc', 'subject', 'sentAt', 'status', 'error'],
  AuditLog: ['seq', 'timestamp', 'userId', 'userName', 'role', 'action', 'objectType', 'objectId',
    'batchNo', 'oldValue', 'newValue', 'reason', 'client', 'prevHash', 'hash']
});

// key -> [default value, description]. Recipients are left blank on purpose:
// enter them in the app (Settings) after setup.
var DEFAULT_SETTINGS = Object.assign(typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS ? DEFAULT_SETTINGS : {}, {
  COMPANY_NAME: ['Pharchem Pvt. Ltd.', 'Shown in the app header and emails'],
  EMAIL_PRD: ['', 'Production department mailbox (notifications)'],
  EMAIL_QC: ['', 'QC department mailbox (notifications)'],
  EMAIL_QA: ['', 'QA department mailbox (notifications)'],
  EMAIL_ESCALATION: ['', 'Escalation list for overdue items (comma separated)'],
  EMAIL_ADMIN: ['', 'Receives alerts when an email fails to send'],
  UPLOAD_DAYS: ['2', 'Upload deadline = dispatch date + this many days (23:59 IST)'],
  UPLOAD_DAYS_MODE: ['CALENDAR', 'CALENDAR or WORKING days for the upload deadline'],
  UPLOAD_SHIFT_NONWORKING: ['YES', 'YES = a deadline falling on Sunday/holiday moves to next working day'],
  VERIFY_HOURS: ['24', 'QA verification window in working hours (Sundays/holidays excluded)'],
  VERIFY_REMINDER_HOURS: ['12', 'Remind QA after this many working hours of the verification clock'],
  REUPLOAD_REMINDER_HOURS: ['24', 'Remind uploader if a rejected document is not re-uploaded within this many hours'],
  HARDCOPY_DAYS: ['3', 'Hardcopy due this many working days after Verified OK'],
  DAILY_REMINDER_HOUR: ['9', 'Hour (IST, 0-23) for daily overdue reminders'],
  MAX_FILE_MB: ['25', 'Maximum size per uploaded file (MB)'],
  SESSION_TIMEOUT_MIN: ['15', 'Log out after this many minutes of inactivity'],
  PASSWORD_EXPIRY_DAYS: ['90', 'Force password change after this many days (0 = never)'],
  LOCKOUT_ATTEMPTS: ['5', 'Lock the account after this many failed logins'],
  APP_URL: ['', 'Web app URL used in email links (filled automatically when possible)'],
  GMP_FOLDER_ID: ['', 'Google Drive ID of the GMP folder (BMRs, STPs, specifications, COA formats) used to auto-fill batch documents'],
  PRODUCTION_SHEET_ID: ['', 'Google Sheet ID of the Daily Production & Dispatch Register filled by Production every evening'],
  IMPORT_HOUR: ['20', 'Hour (IST, 0-23) at which the production register is read and dispatched batches are registered'],
  REGISTER_MISSING_ALERT: ['YES', 'YES = alert Production and QA if no row was entered for a working day (enter NIL when there is no production)']
});

// Seeded from Pharchem GMP documents: SOPs QAGE/033 (approval & release of batch),
// QAGE/043 (GDP & data integrity), QAGE/047 (document issuance & retrieval),
// QAGE/054 (checking of analytical report & data), the ALP/MGP BMR formats and the
// COA format PCF/PR/080. QA can edit, add or deactivate items in the app (Settings).
var DEFAULT_CHECKLISTS = {
  BMR_BPR: [
    'Controlled copy: BMR first page signed by QA; "ISSUED BY QA" (blue) and "CONTROLLED COPY" (green) stamps on all pages (QAGE/043, 047)',
    'Index sheet complete; all pages as per index present, numbered consecutively and legible; any DUPLICATE / additional page issued and recorded by QA (PCF/QA/072)',
    'BMR authorisation sheet: product, batch no. (as per QAGE/022), batch size, mfg & packing commencement / completion dates, area, previous product filled',
    'Correct MFR No. / Rev. referred; deviation and change control marked Yes/No and attached where Yes (QAGE/025, QAGE/021)',
    'Dispensing checklist complete (area & balance cleaning, previous product labels / containers, equipment cleaned)',
    'Raw material and packing material requisitions (production & stores copies): qty as per MFR, A.R. Nos., checked by Production, verified by QA',
    'Line clearance of manufacturing and packing operations recorded with equipment IDs, previous product & batch, verified by QA (QAGE/037)',
    'Batch processing: qty added, date, time, done by and checked by recorded for every step at the time of activity',
    'In-process results recorded and within limits (pH at each stage, filter press pressure, chloride / free chlorine of filtrate, clarity); IPQC checklist attached (QAGE/028)',
    'Packing, labelling, sampling and sealing records signed with date/time (QAGE/014, QAGE/060)',
    'Control sample details and specimen label (batch no., mfg & expiry date) attached',
    'Weight checking record of drums / bags complete and within limit',
    'Packing material reconciliation and destruction record complete and cross-checked by QA',
    'Batch yield record calculated correctly; % yield within limit (NLT 98.00%)',
    'Dispatch details (party, drums / bags, challan no., dispatch date, qty) match the actual dispatch',
    'Dispensing slips and listed attachments (analysis requisition slips, protocols, COA bulk & finished) attached',
    'GDP: correct ink colour (blue Production, green QA); dates as DD.MM.YYYY; no blank columns (NA with sign & date); no ditto marks (QAGE/043)',
    'Corrections by single line with sign, date and justification; no overwriting, white ink or back-dating (QAGE/043)',
    'Three-level review complete: done by / checked by / approved by; final BMR checked by Production and checked & released by QA',
    'All deviations / incidents for the batch closed before release (QAGE/033)'
  ],
  COA_RAW: [
    'COA on current format (PCF/PR/080) with correct customer, A.R. No., report date and STP / specification no. & revision',
    'Product, batch no. and batch size match the BMR and dispatch; mfg, sample receipt, analysis start / completion, retest and expiry dates consistent',
    'Analysis done as per current valid specification and STP (QAGE/054)',
    'All tests per specification reported; each result within limit and transcribed correctly from the raw data',
    'Raw data recorded in raw data sheet / protocol (bulk & finished, chemical & microbial) for every test',
    'Supportive printouts attached, signed and dated by the analyst (QAGE/043, 054)',
    'Solution / reagent preparation records available for solutions used',
    'Instruments and balances used were calibrated; instrument logbooks verified for working status (QAGE/054)',
    'Working / reference standards used were valid',
    'Calculations correct, with formula and units documented and independently checked (QAGE/043)',
    'System suitability, chromatographic audit trail and integration checked (where applicable, else NA)',
    'Outsourced or pending test reports (e.g. lead content) attached and referenced on the COA',
    'GDP in QC records: black ink, no overwriting, corrections with sign / date / justification, no blank columns',
    'Analyst, QC In-charge (verified) and QA signatures with dates; compliance decision (complies / does not comply) recorded',
    'QA reviewed intermediate & final results against previous year trend data from APQR (QAGE/033 Rev. 05)',
    'Release intimation / bulk release slip and Batch Release Note (PCF/QA/077) issued'
  ]
};

// ---------------------------------------------------------------------------
// Web app entry + sheet menu
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('BDVS - Batch Document Verification')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('BDVS')
    .addItem('1. Initial setup', 'setup')
    .addItem('2. Install / repair reminder timer', 'installTriggers')
    .addSeparator()
    .addItem('Run reminders now', 'runReminders')
    .addItem('Read production register now', 'runDailyImport')
    .addItem('Run automatic checks now', 'runAiQueue')
    .addItem('Set Claude API key', 'menuSetApiKey')
    .addItem('Verify audit trail integrity', 'menuVerifyAudit')
    .addItem('Reset admin password', 'menuResetAdmin')
    .addToUi();
}

/** Creates sheets, seeds settings/checklists, creates the Drive folder and the first admin user. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SSID', ss.getId());
  ss.setSpreadsheetTimeZone('Asia/Kolkata');

  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    } else {
      // Add any new columns introduced by an update (never removes columns).
      var existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
      headers.forEach(function (h) {
        if (existing.indexOf(h) < 0) { existing.push(h); }
      });
      sh.getRange(1, 1, 1, existing.length).setValues([existing]);
    }
    // Store everything as plain text so dates/numbers are not re-interpreted.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
      sh.protect().setDescription('Edit only through the BDVS app').setWarningOnly(true);
    }
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) { ss.deleteSheet(blank); }
  cacheReset_();

  var existingKeys = {};
  rows_('Settings').forEach(function (r) { existingKeys[r.key] = true; });
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!existingKeys[k]) { insert_('Settings', { key: k, value: DEFAULT_SETTINGS[k][0], description: DEFAULT_SETTINGS[k][1] }); }
  });

  if (rows_('Checklists').length === 0) {
    Object.keys(DEFAULT_CHECKLISTS).forEach(function (t) {
      DEFAULT_CHECKLISTS[t].forEach(function (item, i) {
        insert_('Checklists', { id: newId_('CK'), docType: t, item: item, order: String(i + 1), active: 'Y' });
      });
    });
  }

  if (!props.getProperty('ROOT_FOLDER_ID')) {
    var folder = DriveApp.createFolder('BDVS Scanned Documents (do not edit)');
    props.setProperty('ROOT_FOLDER_ID', folder.getId());
  }

  try {
    var url = ScriptApp.getService().getUrl();
    if (url && !setting_('APP_URL')) { setSetting_('APP_URL', url); }
  } catch (e) { /* not deployed yet */ }

  var msg = 'Setup complete. Sheets, settings, checklists and the Drive folder are ready.';
  if (rows_('Users').length === 0) {
    var temp = tempPassword_();
    createUserRecord_({ name: 'System Administrator', username: 'admin', email: '', role: 'ADMIN' }, temp, 'SETUP');
    audit_(null, 'SETUP', 'System', '', '', '', 'Initial setup; admin user created', '');
    msg += '\n\nAdmin login\nUsername: admin\nTemporary password: ' + temp +
      '\n\nWrite this down now. You will be asked to change it at first login.';
  }
  installTriggers();
  msg += '\n\nTimers installed: reminders every hour; production register read daily at ' + setting_('IMPORT_HOUR') + ':00.\nNext: Deploy > New deployment > Web app (see README).';
  try { SpreadsheetApp.getUi().alert('BDVS', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { Logger.log(msg); }
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runReminders') { ScriptApp.deleteTrigger(t); }
  });
  ScriptApp.newTrigger('runReminders').timeBased().everyHours(1).create();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyImport') { ScriptApp.deleteTrigger(t); }
  });
  var h = Number(setting_('IMPORT_HOUR'));
  ScriptApp.newTrigger('runDailyImport').timeBased().everyDays(1).atHour(isNaN(h) ? 20 : h).inTimezone('Asia/Kolkata').create();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAiQueue') { ScriptApp.deleteTrigger(t); }
  });
  ScriptApp.newTrigger('runAiQueue').timeBased().everyMinutes(5).create();
}

function menuSetApiKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Claude API key', 'Paste the Anthropic API key (sk-ant-...). It is stored in Script Properties, not in the sheet.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) { return; }
  apiSetApiKey_(null, { key: r.getResponseText(), client: 'sheet menu' });
  ui.alert('API key saved.');
}

function menuVerifyAudit() {
  var r = verifyAuditChain_();
  SpreadsheetApp.getUi().alert(r.ok ? 'Audit trail OK: ' + r.count + ' entries, hash chain intact.'
    : 'AUDIT TRAIL PROBLEM at entry ' + r.badSeq + ': ' + r.reason);
}

function menuResetAdmin() {
  var u = rows_('Users').filter(function (x) { return x.role === 'ADMIN' && x.active === 'Y'; })[0];
  if (!u) { SpreadsheetApp.getUi().alert('No active admin user found.'); return; }
  var temp = tempPassword_();
  setPassword_(u, temp, true);
  u.failed = '0'; u.lockedUntil = '';
  update_('Users', u);
  audit_(null, 'ADMIN_PASSWORD_RESET', 'User', u.id, '', '', 'Reset from spreadsheet menu by sheet owner', '');
  SpreadsheetApp.getUi().alert('Admin "' + u.username + '" temporary password: ' + temp);
}

// ---------------------------------------------------------------------------
// Single API entry point used by the web page
// ---------------------------------------------------------------------------

var ACTIONS = Object.assign(typeof ACTIONS !== 'undefined' && ACTIONS ? ACTIONS : {}, {
  bootstrap: { roles: ROLES, fn: apiBootstrap_ },
  changePassword: { roles: ROLES, fn: apiChangePassword_, write: true, allowMustChange: true },
  dashboard: { roles: ROLES, fn: apiDashboard_ },
  getBatch: { roles: ROLES, fn: apiGetBatch_ },
  getFile: { roles: ROLES, fn: apiGetFile_ },
  registerBatch: { roles: ['QA'], fn: apiRegisterBatch_, write: true },
  bulkRegister: { roles: ['QA'], fn: apiBulkRegister_, write: true },
  getDocMaster: { roles: ['QA', 'ADMIN'], fn: apiGetDocMaster_ },
  importDocMaster: { roles: ['QA', 'ADMIN'], fn: apiImportDocMaster_, write: true },
  importProduction: { roles: ['QA', 'ADMIN'], fn: function (u, p) { return importProductionRegister_(u, p.client); }, write: true },
  createProductionSheet: { roles: ['QA', 'ADMIN'], fn: apiCreateProductionSheet_, write: true },
  linkProductionSheet: { roles: ['QA', 'ADMIN'], fn: apiLinkProductionSheet_, write: true },
  importLog: { roles: ['QA', 'ADMIN'], fn: function () { return rows_('ImportLog').slice(-60).reverse().map(function (r) { r = strip_(r); r.details = parseJson_(r.details, []); return r; }); } },
  updateMasterDocs: { roles: ['QA'], fn: apiUpdateMasterDocs_, write: true },
  upload: { roles: ['PRD', 'QC'], fn: apiUpload_, write: true },
  decide: { roles: ['QA'], fn: apiDecide_, write: true },
  recordHardcopy: { roles: ['QA'], fn: apiRecordHardcopy_, write: true },
  resolveDiscrepancy: { roles: ['QA'], fn: apiResolveDiscrepancy_, write: true },
  closeBatch: { roles: ['QA'], fn: apiCloseBatch_, write: true },
  logPrint: { roles: ROLES, fn: apiLogPrint_, write: true },
  auditLog: { roles: ['QA', 'ADMIN'], fn: apiAuditLog_ },
  verifyAudit: { roles: ['QA', 'ADMIN'], fn: function () { return verifyAuditChain_(); } },
  reminderLog: { roles: ['QA', 'ADMIN'], fn: apiReminderLog_ },
  getSettings: { roles: ['QA', 'ADMIN'], fn: apiGetSettings_ },
  saveSetting: { roles: ['ADMIN'], fn: apiSaveSetting_, write: true },
  addHoliday: { roles: ['QA', 'ADMIN'], fn: apiAddHoliday_, write: true },
  removeHoliday: { roles: ['QA', 'ADMIN'], fn: apiRemoveHoliday_, write: true },
  saveChecklistItem: { roles: ['QA', 'ADMIN'], fn: apiSaveChecklistItem_, write: true },
  listUsers: { roles: ['ADMIN'], fn: apiListUsers_ },
  createUser: { roles: ['ADMIN'], fn: apiCreateUser_, write: true },
  updateUser: { roles: ['ADMIN'], fn: apiUpdateUser_, write: true },
  resetPassword: { roles: ['ADMIN'], fn: apiResetPassword_, write: true },
  sendTestEmail: { roles: ['ADMIN'], fn: apiSendTestEmail_, write: true }
});

/** Called from the page via google.script.run.api(token, action, payload). */
function api(token, action, payload) {
  try {
    cacheReset_();
    var def = ACTIONS[action];
    if (!def) { throw new Error('Unknown action: ' + action); }
    var user = sessionUser_(token);
    if (def.roles.indexOf(user.role) < 0) { throw new Error('Your role (' + user.role + ') is not allowed to do this.'); }
    if (user.mustChange === 'Y' && !def.allowMustChange && action !== 'bootstrap') {
      throw new Error('PASSWORD_CHANGE_REQUIRED');
    }
    payload = payload || {};
    var result = def.write ? withLock_(function () { return def.fn(user, payload); }) : def.fn(user, payload);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function login(username, password, client) {
  try {
    cacheReset_();
    return withLock_(function () {
      username = String(username || '').trim().toLowerCase();
      var u = rows_('Users').filter(function (x) { return String(x.username).toLowerCase() === username; })[0];
      var now = Date.now();
      if (!u) {
        audit_(null, 'LOGIN_FAILED', 'User', '', '', '', 'Unknown username: ' + username, client);
        throw new Error('Invalid username or password.');
      }
      if (u.active !== 'Y') {
        audit_(u, 'LOGIN_FAILED', 'User', u.id, '', '', 'Account disabled', client);
        throw new Error('This account is disabled. Contact the administrator.');
      }
      if (u.lockedUntil && Number(u.lockedUntil) > now) {
        audit_(u, 'LOGIN_FAILED', 'User', u.id, '', '', 'Account locked', client);
        throw new Error('Account locked after repeated failed logins. Ask the administrator to unlock it.');
      }
      if (hashPw_(password, u.salt) !== u.pwHash) {
        u.failed = String(Number(u.failed || 0) + 1);
        var limit = Number(setting_('LOCKOUT_ATTEMPTS')) || 5;
        var reason = 'Wrong password (attempt ' + u.failed + ' of ' + limit + ')';
        if (Number(u.failed) >= limit) {
          u.lockedUntil = String(now + 3650 * DAY); // locked until an admin unlocks
          reason += '; account locked';
        }
        update_('Users', u);
        audit_(u, 'LOGIN_FAILED', 'User', u.id, '', '', reason, client);
        throw new Error('Invalid username or password.');
      }
      u.failed = '0'; u.lockedUntil = '';
      var expiry = Number(setting_('PASSWORD_EXPIRY_DAYS')) || 0;
      if (expiry > 0 && u.pwChangedAt && now - new Date(u.pwChangedAt).getTime() > expiry * DAY) {
        u.mustChange = 'Y';
      }
      update_('Users', u);
      var token = Utilities.getUuid() + Utilities.getUuid();
      putSession_(token, u.id);
      audit_(u, 'LOGIN', 'User', u.id, '', '', '', client);
      return { ok: true, data: { token: token, mustChange: u.mustChange === 'Y' } };
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function logout(token) {
  try {
    var uid = CacheService.getScriptCache().get('sess_' + token);
    if (uid) {
      CacheService.getScriptCache().remove('sess_' + token);
      var u = findById_('Users', uid);
      if (u) { withLock_(function () { audit_(u, 'LOGOUT', 'User', u.id, '', '', '', ''); }); }
    }
  } catch (e) { /* ignore */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// API implementations
// ---------------------------------------------------------------------------

function apiBootstrap_(user) {
  var checklists = {};
  Object.keys(DOC_TYPES).forEach(function (t) { checklists[t] = activeChecklist_(t); });
  return {
    user: publicUser_(user),
    company: setting_('COMPANY_NAME'),
    docTypes: DOC_TYPES,
    checklists: checklists,
    holidays: holidayMap_(),
    config: {
      maxFileMb: Number(setting_('MAX_FILE_MB')) || 25,
      sessionTimeoutMin: Number(setting_('SESSION_TIMEOUT_MIN')) || 15,
      verifyHours: Number(setting_('VERIFY_HOURS')) || 24,
      uploadDays: Number(setting_('UPLOAD_DAYS')) || 2
    },
    serverNow: Date.now(),
    aiEnabled: aiOn_()
  };
}

function apiChangePassword_(user, p) {
  if (hashPw_(p.oldPassword, user.salt) !== user.pwHash) { throw new Error('Current password is incorrect.'); }
  validatePassword_(p.newPassword, user);
  if (hashPw_(p.newPassword, user.salt) === user.pwHash) { throw new Error('New password must differ from the current one.'); }
  setPassword_(user, p.newPassword, false);
  update_('Users', user);
  audit_(user, 'PASSWORD_CHANGED', 'User', user.id, '', '', '', p.client);
  return true;
}

/** Batches with their documents and computed flags. PRD/QC only see their own document. */
function apiDashboard_(user) {
  var now = Date.now();
  var hol = holidayMap_();
  var docsByBatch = groupBy_(rows_('Documents'), 'batchId');
  var versions = indexBy_(rows_('Versions'), 'id');
  var latestVer = {};
  Object.keys(versions).forEach(function (k) { var v = versions[k]; var cur = latestVer[v.docId]; if (!cur || Number(v.versionNo) > Number(cur.versionNo)) { latestVer[v.docId] = v; } });
  var findingsByVer = groupBy_(rows_('Findings').filter(function (f) { return f.status === 'OPEN'; }), 'versionId');
  var jobByVer = {};
  rows_('AiJobs').forEach(function (j) { if (j.kind === 'SCAN') { jobByVer[j.refId] = j.status; } });
  var batches = rows_('Batches').map(function (b) {
    var docs = (docsByBatch[b.id] || []).map(function (d) {
      var x = docView_(d, versions, now);
      var lv = latestVer[d.id];
      if (lv) {
        var fs = findingsByVer[lv.id] || [];
        x.check = { versionId: lv.id, job: jobByVer[lv.id] || '', open: fs.length,
          fails: fs.filter(function (f) { return f.type === 'LIMIT'; }).length, blocks: fs.filter(function (f) { return f.severity === 'BLOCK'; }).length };
      }
      return x;
    });
    if (user.role === 'PRD' || user.role === 'QC') {
      docs = docs.filter(function (d) { return d.dept === user.role; });
    }
    var view = batchView_(b, docs, now);
    view.ageDays = b.status === 'CLOSED' ? null : Math.floor((now - ymdToMs_(b.dispatchDate, 0)) / DAY);
    return view;
  });
  batches.sort(function (a, b) { return String(b.registeredAt).localeCompare(String(a.registeredAt)); });

  var c = { total: 0, awaitingUpload: 0, underVerification: 0, rejected: 0, awaitingHardcopy: 0, readyToClose: 0,
    closed: 0, overdueUpload: 0, overdueVerify: 0, overdueHardcopy: 0, age01: 0, age23: 0, age4: 0 };
  batches.forEach(function (b) {
    c.total++;
    if (b.status === 'CLOSED') { c.closed++; return; }
    b.docs.forEach(function (d) {
      if (d.status === 'PENDING_UPLOAD') { c.awaitingUpload++; }
      if (d.status === 'UNDER_VERIFICATION') { c.underVerification++; }
      if (d.status === 'REJECTED') { c.rejected++; }
      if (d.status === 'HARDCOPY_PENDING' || d.status === 'HARDCOPY_DISCREPANCY') { c.awaitingHardcopy++; }
      if (d.overdue === 'UPLOAD') { c.overdueUpload++; }
      if (d.overdue === 'VERIFICATION') { c.overdueVerify++; }
      if (d.overdue === 'HARDCOPY') { c.overdueHardcopy++; }
    });
    if (b.status === 'READY_TO_CLOSE') { c.readyToClose++; }
    if (b.ageDays <= 1) { c.age01++; } else if (b.ageDays <= 3) { c.age23++; } else { c.age4++; }
  });
  var imp = rows_('ImportLog');
  var lastImport = imp.length ? strip_(imp[imp.length - 1]) : null;
  if (lastImport) { lastImport.details = parseJson_(lastImport.details, {}); }
  if (user.role === 'PRD' || user.role === 'QC') { lastImport = null; }
  return { batches: batches, counts: c, holidays: hol, serverNow: now, lastImport: lastImport };
}

function apiGetBatch_(user, p) {
  var b = findById_('Batches', p.batchId);
  if (!b) { throw new Error('Batch not found.'); }
  var now = Date.now();
  var versionsAll = rows_('Versions').filter(function (v) { return v.batchId === b.id; });
  var vIndex = indexBy_(versionsAll, 'id');
  var docs = rows_('Documents').filter(function (d) { return d.batchId === b.id; });
  if (user.role === 'PRD' || user.role === 'QC') { docs = docs.filter(function (d) { return d.dept === user.role; }); }
  var allowedDocIds = docs.map(function (d) { return d.id; });
  var mine = function (x) { return allowedDocIds.indexOf(x.docId) >= 0; };
  var out = batchView_(b, docs.map(function (d) { return docView_(d, vIndex, now); }), now);
  out.versions = versionsAll.filter(mine).map(versionView_);
  out.verifications = rows_('Verifications').filter(function (v) { return v.batchId === b.id && mine(v); })
    .map(function (v) { v.checklist = parseJson_(v.checklist, []); delete v._row; return v; });
  out.observations = rows_('Observations').filter(function (o) { return o.batchId === b.id && mine(o); })
    .map(strip_);
  out.hardcopies = rows_('Hardcopies').filter(function (h) { return h.batchId === b.id && mine(h); }).map(strip_);
  if (user.role === 'QA' || user.role === 'ADMIN') {
    out.audit = rows_('AuditLog').filter(function (a) { return a.batchNo === b.batchNo && a.objectId; })
      .filter(function (a) { return a.objectId === b.id || allowedDocIds.indexOf(a.objectId) >= 0 ||
        vIndex[a.objectId] || String(a.objectType) === 'Hardcopy' || String(a.objectType) === 'Batch'; })
      .map(strip_);
    out.reminders = rows_('ReminderLog').filter(function (r) { return r.batchNo === b.batchNo; }).map(strip_);
  }
  return out;
}

function apiGetFile_(user, p) {
  var v = findById_('Versions', p.versionId);
  if (!v) { throw new Error('Version not found.'); }
  var d = findById_('Documents', v.docId);
  if ((user.role === 'PRD' || user.role === 'QC') && d.dept !== user.role) { throw new Error('Not permitted.'); }
  var files = parseJson_(v.files, []);
  var f = files[Number(p.index || 0)];
  if (!f) { throw new Error('File not found.'); }
  var blob = DriveApp.getFileById(f.fileId).getBlob();
  var bytes = blob.getBytes();
  var hash = sha256Hex_(bytes);
  var ok = hash === f.sha256;
  audit_(user, p.download ? 'FILE_DOWNLOADED' : 'FILE_VIEWED', 'Version', v.id, d.batchNo, '', f.name,
    ok ? '' : 'INTEGRITY CHECK FAILED: stored hash ' + f.sha256 + ', current ' + hash, p.client);
  if (!ok) { notifyAdmin_('BDVS integrity alert: file hash mismatch', 'File ' + f.name + ' (batch ' + d.batchNo + ') no longer matches its stored SHA-256 hash.'); }
  return { name: f.name, mime: 'application/pdf', base64: Utilities.base64Encode(bytes), sha256: f.sha256, integrityOk: ok };
}

function apiRegisterBatch_(user, p) {
  return registerOne_(user, p);
}

/** p.rows = [{ batchNo, dispatchDate, customer, invoiceNo, batchSize?, product?, market?, site?, remarks? }] */
function apiBulkRegister_(user, p) {
  var rows = p.rows || [];
  if (!rows.length) { throw new Error('Nothing to register.'); }
  if (rows.length > 100) { throw new Error('Register at most 100 batches at a time.'); }
  return rows.map(function (r, i) {
    try {
      var res = registerOne_(user, Object.assign({ client: p.client, fromBulk: true }, r));
      return { row: i + 1, ok: true, batchNo: r.batchNo, dueAt: res.dueAt, masterDocs: res.masterDocs };
    } catch (e) {
      return { row: i + 1, ok: false, batchNo: r.batchNo, error: String(e.message || e) };
    }
  });
}

function productCodeOf_(product, batchNo) {
  var bn = String(batchNo || '').trim().toUpperCase();
  if (/^ALP/.test(bn)) { return 'ALP'; }
  if (/^MGP/.test(bn)) { return 'MGP'; }
  var pr = String(product || '').trim().toLowerCase();
  if (PRODUCTS[pr.toUpperCase()]) { return pr.toUpperCase(); }
  if (/alum/.test(pr)) { return 'ALP'; }
  if (/magn/.test(pr)) { return 'MGP'; }
  return '';
}

function registerOne_(user, p) {
  var code = productCodeOf_(p.product, p.batchNo);
  var f = {
    productCode: code,
    product: String(p.product || '').trim() && !PRODUCTS[String(p.product).trim().toUpperCase()] ? String(p.product).trim() : (PRODUCTS[code] || ''),
    batchNo: req_(p.batchNo, 'Batch number'),
    batchSize: String(p.batchSize || '').trim(),
    dispatchDate: normDate_(req_(p.dispatchDate, 'Dispatch date')),
    invoiceNo: req_(p.invoiceNo, 'Invoice / challan number'),
    customer: req_(p.customer, 'Customer / destination'),
    market: String(p.market || '').trim(),
    site: String(p.site || '').trim() || 'Pharchem Pvt. Ltd.',
    remarks: String(p.remarks || '').trim()
  };
  req_(f.product, 'Product (could not tell from the batch number)');
  if (f.dispatchDate > istYmd_(Date.now())) { throw new Error('Dispatch date cannot be in the future.'); }
  var dup = rows_('Batches').filter(function (b) {
    return norm_(b.batchNo) === norm_(f.batchNo) && norm_(b.product) === norm_(f.product);
  })[0];
  if (dup) { throw new Error('Batch ' + f.batchNo + ' of ' + f.product + ' is already registered.'); }

  // Master documents: explicit choice > saved customer profile > best match in the GMP folder index.
  var profileKey = code + '|' + customerKey_(f.customer);
  var profile = rows_('CustomerProfiles').filter(function (x) { return x.key === profileKey; })[0];
  var chosen = p.masterDocIds || {};
  var md = {};
  var matchSource = profile ? 'remembered' : 'auto';
  if (p.masterDocIds) { matchSource = 'chosen'; }
  ['BMR', 'STP', 'SPEC', 'COA'].forEach(function (k) {
    var id = chosen[k] !== undefined ? chosen[k] : (profile ? profile[{ BMR: 'bmrId', STP: 'stpId', SPEC: 'specId', COA: 'coaId' }[k]] : '');
    if (id === undefined || id === null) { id = ''; }
    if (!id && chosen[k] === undefined && !profile) { var m = bestMasterMatch_(code, k, f.customer); if (m) { id = m.id; } }
    var doc = id ? findById_('DocMaster', id) : null;
    md[k] = doc ? { id: doc.id, number: doc.number, title: doc.title, url: doc.url } : null;
  });
  if (!f.batchSize) {
    f.batchSize = (profile && profile.batchSize) || (md.BMR && (findById_('DocMaster', md.BMR.id) || {}).batchSize) || '';
  }
  req_(f.batchSize, 'Batch size');
  if (!f.market) { f.market = (profile && profile.market) || 'Domestic'; }

  var now = Date.now();
  var hol = holidayMap_();
  var due = uploadDeadline_(f.dispatchDate, hol);
  var b = Object.assign({ id: newId_('B'), status: 'AWAITING_DOCUMENTS', registeredAt: iso_(now),
    registeredBy: user.name, closedAt: '', closedBy: '', closeRemarks: '', masterDocs: JSON.stringify(md) }, f);
  insert_('Batches', b);
  audit_(user, p.fromBulk ? 'BATCH_REGISTERED_BULK' : 'BATCH_REGISTERED', 'Batch', b.id, b.batchNo, '',
    JSON.stringify(f) + ' | master docs: ' + masterSummary_(md), '', p.client);

  // Remember the customer's documents for next time.
  if (code) {
    var prof = { key: profileKey, productCode: code, customer: f.customer, bmrId: md.BMR ? md.BMR.id : '',
      stpId: md.STP ? md.STP.id : '', specId: md.SPEC ? md.SPEC.id : '', coaId: md.COA ? md.COA.id : '',
      batchSize: f.batchSize, market: f.market, updatedAt: iso_(now), updatedBy: user.name };
    if (profile) { prof._row = profile._row; update_('CustomerProfiles', prof); } else { insert_('CustomerProfiles', prof); }
  }

  Object.keys(DOC_TYPES).forEach(function (t) {
    var d = { id: newId_('D'), batchId: b.id, batchNo: b.batchNo, product: b.product, type: t,
      dept: DOC_TYPES[t].dept, dueAt: iso_(due), status: 'PENDING_UPLOAD', currentVersion: '0',
      rejectCount: '0', firstUploadAt: '', lateHours: '', verifiedAt: '', hardcopyDueAt: '',
      hardcopyReceivedAt: '', lastRejectedAt: '', updatedAt: iso_(now) };
    insert_('Documents', d);
    audit_(user, 'TASK_CREATED', 'Document', d.id, b.batchNo, '', DOC_TYPES[t].label + ' due ' + fmt_(due), '', p.client);
    var refs = t === 'BMR_BPR' ? (md.BMR ? '<p>Master BMR: <b>' + esc_(md.BMR.title) + '</b></p>' : '')
      : [md.STP ? 'STP: <b>' + esc_(md.STP.title) + '</b>' : '', md.SPEC ? 'Specification: <b>' + esc_(md.SPEC.title) + '</b>' : '',
        md.COA ? 'COA format: <b>' + esc_(md.COA.title) + '</b>' : ''].filter(String).join('<br>');
    sendMail_('REG|' + d.id, 'REGISTERED', d.id, b.batchNo, deptEmails_(d.dept), deptEmails_('QA'),
      'Upload required: ' + DOC_TYPES[t].label + ' - Batch ' + b.batchNo,
      mailBody_('Batch dispatched - please upload the scanned document',
        'Batch <b>' + esc_(b.batchNo) + '</b> of <b>' + esc_(b.product) + '</b> was dispatched to <b>' + esc_(b.customer) + '</b> on ' +
        fmtDate_(ymdToMs_(b.dispatchDate, 12)) + '. Please upload the scanned <b>' + DOC_TYPES[t].label +
        '</b> before the deadline.' + (refs ? '<div style="margin-top:8px">' + refs + '</div>' : ''), docFacts_(b, d, now)));
  });
  return { id: b.id, dueAt: iso_(due), masterDocs: md, batchSize: f.batchSize, product: f.product, matchSource: matchSource };
}

function masterSummary_(md) {
  return ['BMR', 'STP', 'SPEC', 'COA'].map(function (k) { return k + '=' + (md[k] ? md[k].title : 'none'); }).join('; ');
}

/** Accepts YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY (also 2-digit years). */
function normDate_(s) {
  s = String(s).trim();
  var m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { return m[1] + '-' + pad_(+m[2]) + '-' + pad_(+m[3]); }
  if ((m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/))) {
    var y = m[3].length === 2 ? '20' + m[3] : m[3];
    return checkYmd_(y + '-' + pad_(+m[2]) + '-' + pad_(+m[1]), s);
  }
  if ((m = s.match(/^(\d{1,2})[.\/\- ]([A-Za-z]{3})[A-Za-z]*[.\/\- ](\d{2,4})$/))) {
    var mi = MONTHS.map(function (x) { return x.toLowerCase(); }).indexOf(m[2].toLowerCase());
    if (mi >= 0) { return checkYmd_((m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad_(mi + 1) + '-' + pad_(+m[1]), s); }
  }
  throw new Error('Unrecognised date "' + s + '". Use DD.MM.YYYY.');
}
function checkYmd_(ymd, raw) {
  if (istYmd_(ymdToMs_(ymd, 12)) !== ymd) { throw new Error('Invalid date "' + raw + '".'); }
  return ymd;
}

// ---------------------------------------------------------------------------
// GMP document master (index of BMRs, STPs, specifications and COA formats)
// ---------------------------------------------------------------------------

var CUSTOMER_NOISE_ = /\b(ltd|limited|pvt|private|ok|pending|new|old|correction|extra|batch|size|kgs?|lab|labs|laboratories|healthcare|healthc|health|pharma|pharmaceuticals?|life|science|sciences|india|for|the|and|ip|bp|usp|ih)\b|\d+(\.\d+)?\s*%|\d{1,2}\.\d{1,2}\.\d{2,4}|\(\d+\)|[0-9]+\s*kgs?/gi;

function customerKey_(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' ').replace(CUSTOMER_NOISE_, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Classifies a GMP file name. Returns null if it is not a master BMR / STP / SPEC / COA format. */
function classifyMasterFile_(title) {
  var t = String(title).replace(/\.(docx?|pdf|xlsx?)$/i, '').trim();
  var m;
  if ((m = t.match(/^(ALP)-BMR-(\d+)-(.+)$/i))) {
    var kg = (m[3].match(/(\d{4})\s*kg/i) || [])[1];
    return { productCode: 'ALP', kind: 'BMR', number: 'ALP-BMR-' + m[2], hint: m[3], batchSize: kg ? kg + ' Kgs' : '3000 Kgs' };
  }
  if ((m = t.match(/^\d+-PC-BMR-(MGP)-(\d+)-?\s*(?:(\d+)\s*Kgs)?\s*-?\s*(.*)$/i))) {
    return { productCode: 'MGP', kind: 'BMR', number: 'PC-BMR-MGP-' + m[2], hint: m[4] || 'General', batchSize: m[3] ? m[3] + ' Kgs' : '' };
  }
  if ((m = t.match(/^(\d+)-\s*(ALP|MGP)\s+STP\b\s*-?\s*(?:for\s+)?(.*)$/i))) {
    return { productCode: m[2].toUpperCase(), kind: 'STP', number: m[2].toUpperCase() + ' STP ' + m[1], hint: m[3] || 'General' };
  }
  if ((m = t.match(/^(\d+)-\s*(ALP|MGP)\s+SPE\b\s*(?:for\s+)?(.*)$/i))) {
    return { productCode: m[2].toUpperCase(), kind: 'SPEC', number: m[2].toUpperCase() + ' SPE ' + m[1], hint: m[3] || 'General' };
  }
  if ((m = t.match(/^PCF-FMR-(\d+)(?:-(\d+))?\s*-?\s*(ALP|MGP)\s*-?\s*(.*)$/i))) {
    return { productCode: m[3].toUpperCase(), kind: 'COA', number: 'PCF/FMR/' + m[1] + (m[2] ? '/' + m[2] : ''), hint: m[4] || 'General' };
  }
  return null;
}

/** Walks the GMP folder (skipping Draft / Obsolete / New folder) and rebuilds the DocMaster index. */
function apiImportDocMaster_(user, p) {
  var folderId = String(p.folderId || setting_('GMP_FOLDER_ID') || '').trim();
  var mm = folderId.match(/folders\/([A-Za-z0-9_-]+)/);
  if (mm) { folderId = mm[1]; }
  if (!folderId) { throw new Error('Set GMP_FOLDER_ID in Settings (the ID or link of the GMP folder).'); }
  var root;
  try { root = DriveApp.getFolderById(folderId); } catch (e) {
    throw new Error('Cannot open the GMP folder. Share it (Viewer) with the Google account that deployed BDVS.');
  }
  if (folderId !== setting_('GMP_FOLDER_ID')) { setSetting_('GMP_FOLDER_ID', folderId); }
  var found = [];
  var skip = /^(draft|obsolete|new folder)$/i;
  (function walk(folder, path, depth) {
    if (depth > 6) { return; }
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var name = f.getName();
      if (/^~\$/.test(name)) { continue; }
      var c = classifyMasterFile_(name);
      if (c) { found.push({ c: c, f: f, name: name, path: path }); }
    }
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      var sf = subs.next();
      if (skip.test(sf.getName().trim()) || /draft|obsolete/i.test(sf.getName())) { continue; }
      walk(sf, path + ' / ' + sf.getName(), depth + 1);
    }
  })(root, root.getName(), 0);

  var existing = indexBy_(rows_('DocMaster'), 'fileId');
  var now = iso_(Date.now());
  var seen = {};
  var added = 0, updated = 0;
  found.forEach(function (x) {
    var id = x.f.getId();
    seen[id] = true;
    var rec = existing[id];
    var obj = { productCode: x.c.productCode, kind: x.c.kind, number: x.c.number, title: x.name.replace(/\.(docx?|pdf|xlsx?)$/i, ''),
      customerHint: x.c.hint.trim(), batchSize: x.c.batchSize || '', fileId: id, url: x.f.getUrl(), folderPath: x.path,
      active: 'Y', importedAt: now };
    if (rec) { obj.id = rec.id; obj._row = rec._row; update_('DocMaster', obj); updated++; }
    else { obj.id = newId_('M'); insert_('DocMaster', obj); added++; }
  });
  var retired = 0;
  rows_('DocMaster').forEach(function (r) {
    if (!seen[r.fileId] && r.active === 'Y') { r.active = 'N'; update_('DocMaster', r); retired++; }
  });
  audit_(user, 'DOC_MASTER_IMPORTED', 'DocMaster', folderId, '', '',
    found.length + ' documents (' + added + ' new, ' + updated + ' refreshed, ' + retired + ' no longer in folder)', '', p.client);
  return { total: found.length, added: added, updated: updated, retired: retired };
}

function apiGetDocMaster_() {
  return {
    docs: rows_('DocMaster').filter(function (d) { return d.active === 'Y'; }).map(strip_),
    profiles: rows_('CustomerProfiles').map(strip_),
    folderId: setting_('GMP_FOLDER_ID')
  };
}

/** Best master document of a kind for a customer: shared tokens with the file's customer hint, else "General". */
function bestMasterMatch_(code, kind, customer) {
  var key = customerKey_(customer);
  var tokens = key.split(' ').filter(function (t) { return t.length >= 3; });
  var list = rows_('DocMaster').filter(function (d) { return d.active === 'Y' && d.productCode === code && d.kind === kind; });
  var best = null, bestScore = 0;
  list.forEach(function (d) {
    var hk = customerKey_(d.customerHint);
    var score = 0;
    tokens.forEach(function (t) { if ((' ' + hk + ' ').indexOf(' ' + t) >= 0) { score += t.length; } });
    if (score > bestScore) { best = d; bestScore = score; }
  });
  if (best) { return best; }
  return list.filter(function (d) { return /general/i.test(d.customerHint); })[0] || null;
}

/**
 * p = { docId, declaredPages, checklist: {key: true}, remarks, confirmDuplicate,
 *       files: [{ name, base64, pages, encrypted }] }  (files already converted to PDF in the browser)
 */
function apiUpload_(user, p) {
  var d = findById_('Documents', p.docId);
  if (!d) { throw new Error('Document task not found.'); }
  if (d.dept !== user.role) { throw new Error('Only ' + d.dept + ' can upload this document.'); }
  if (d.status !== 'PENDING_UPLOAD' && d.status !== 'REJECTED') {
    throw new Error('This document is not awaiting upload (status: ' + d.status + ').');
  }
  var b = findById_('Batches', d.batchId);
  if (b.status === 'CLOSED') { throw new Error('Batch is closed.'); }

  var required = ['allPages', 'legible', 'signatures', 'noMissing', 'attachments'];
  required.forEach(function (k) {
    if (!p.checklist || p.checklist[k] !== true) { throw new Error('Please confirm every item of the upload checklist.'); }
  });
  var declared = Number(p.declaredPages);
  if (!(declared > 0) || Math.floor(declared) !== declared) { throw new Error('Enter the number of pages scanned.'); }
  var files = p.files || [];
  if (!files.length) { throw new Error('Attach at least one file.'); }
  var maxBytes = (Number(setting_('MAX_FILE_MB')) || 25) * 1024 * 1024;

  var existingHashes = {};
  rows_('Versions').forEach(function (v) {
    parseJson_(v.files, []).forEach(function (f) { existingHashes[f.sha256] = v; });
  });

  var prepared = files.map(function (f) {
    var bytes = Utilities.base64Decode(f.base64);
    if (!bytes.length) { throw new Error(f.name + ' is empty.'); }
    if (bytes.length > maxBytes) { throw new Error(f.name + ' is larger than ' + setting_('MAX_FILE_MB') + ' MB.'); }
    var head = String.fromCharCode.apply(null, bytes.slice(0, 5).map(function (x) { return x & 255; }));
    if (head !== '%PDF-') { throw new Error(f.name + ' is not a PDF file.'); }
    if (f.encrypted || pdfLooksEncrypted_(bytes)) { throw new Error(f.name + ' is password-protected. Upload an unprotected scan.'); }
    var pages = Number(f.pages);
    var serverPages = pdfPageCount_(bytes);
    if (serverPages > 0 && pages > 0 && serverPages !== pages) { pages = serverPages; }
    if (!(pages > 0)) { pages = serverPages; }
    if (!(pages > 0)) { throw new Error('Could not read the page count of ' + f.name + '.'); }
    return { name: safeName_(f.name), bytes: bytes, pages: pages, sha256: sha256Hex_(bytes) };
  });
  var totalPages = prepared.reduce(function (s, f) { return s + f.pages; }, 0);
  if (totalPages !== declared) {
    throw new Error('Page count mismatch: you declared ' + declared + ' pages but the files contain ' + totalPages + '.');
  }
  var dups = prepared.filter(function (f) { return existingHashes[f.sha256]; });
  if (dups.length && !p.confirmDuplicate) {
    return { needConfirm: true, message: dups.map(function (f) {
      var v = existingHashes[f.sha256];
      return f.name + ' is identical to a file already uploaded (version ' + v.versionNo + ' of batch ' +
        (findById_('Batches', v.batchId) || {}).batchNo + ').';
    }).join('\n') };
  }

  var now = Date.now();
  var hol = holidayMap_();
  var n = Number(d.currentVersion || 0) + 1;
  var folder = docFolder_(b, d);
  var stored = prepared.map(function (f, i) {
    var name = b.batchNo + '_' + d.type + '_v' + n + '_' + (i + 1) + '_' + f.name;
    var file = folder.createFile(Utilities.newBlob(f.bytes, 'application/pdf', name));
    file.setDescription('BDVS | batch ' + b.batchNo + ' | ' + d.type + ' v' + n + ' | SHA-256 ' + f.sha256);
    return { fileId: file.getId(), name: name, pages: f.pages, size: f.bytes.length, sha256: f.sha256 };
  });

  var late = n === 1 ? Math.max(0, now - new Date(d.dueAt).getTime()) : 0;
  var verifyDue = addWorkingHours_(now, Number(setting_('VERIFY_HOURS')) || 24, hol);
  var v = { id: newId_('V'), docId: d.id, batchId: b.id, versionNo: String(n), files: JSON.stringify(stored),
    declaredPages: String(declared), actualPages: String(totalPages), uploaderId: user.id, uploaderName: user.name,
    uploadedAt: iso_(now), lateHours: late ? (late / HOUR).toFixed(1) : '0', checklist: JSON.stringify(p.checklist),
    remarks: String(p.remarks || ''), verifyDueAt: iso_(verifyDue), status: 'UNDER_VERIFICATION',
    decidedAt: '', decidedBy: '', elapsedHours: '', breach: '' };
  insert_('Versions', v);

  var old = d.status;
  d.status = 'UNDER_VERIFICATION';
  d.currentVersion = String(n);
  if (n === 1) { d.firstUploadAt = iso_(now); d.lateHours = v.lateHours; }
  d.updatedAt = iso_(now);
  update_('Documents', d);
  refreshBatchStatus_(b);

  audit_(user, n === 1 ? 'DOCUMENT_UPLOADED' : 'DOCUMENT_REUPLOADED', 'Version', v.id, b.batchNo, old,
    DOC_TYPES[d.type].label + ' v' + n + '; ' + totalPages + ' pages; files: ' +
    stored.map(function (s) { return s.name + ' [' + s.sha256.slice(0, 12) + '...]'; }).join(', ') +
    (late ? '; LATE by ' + v.lateHours + ' h' : ''), p.dupReason || '', p.client);

  sendMail_('UPL|' + v.id, 'UPLOADED', v.id, b.batchNo, deptEmails_('QA'), [],
    'Verify by ' + fmt_(verifyDue) + ': ' + DOC_TYPES[d.type].label + ' v' + n + ' - Batch ' + b.batchNo,
    mailBody_('Document uploaded - verification due',
      user.name + ' (' + user.role + ') uploaded <b>' + DOC_TYPES[d.type].label + '</b> version ' + n +
      ' (' + totalPages + ' pages)' + (late ? ', <b style="color:#b91c1c">late by ' + v.lateHours + ' h</b>' : '') +
      '. Please verify it by <b>' + fmt_(verifyDue) + '</b>.', docFacts_(b, d, now)));
  var aiQueued = false;
  try { aiQueued = !!queueScan_(v.id); } catch (e) { /* checks are optional */ }
  return { versionId: v.id, versionNo: n, verifyDueAt: iso_(verifyDue), lateHours: v.lateHours, aiQueued: aiQueued };
}

/**
 * p = { versionId, outcome: 'ACCEPT'|'REJECT', password, remarks,
 *       checklist: [{id, answer: 'YES'|'NO'|'NA', comment}],
 *       observations: [{page, text, severity}] }
 */
function apiDecide_(user, p) {
  if (hashPw_(p.password, user.salt) !== user.pwHash) {
    audit_(user, 'SIGNATURE_FAILED', 'Version', p.versionId, '', '', 'Wrong password at verification', '', p.client);
    throw new Error('Password incorrect. The decision was not recorded.');
  }
  var v = findById_('Versions', p.versionId);
  if (!v || v.status !== 'UNDER_VERIFICATION') { throw new Error('This version is not awaiting verification.'); }
  var d = findById_('Documents', v.docId);
  if (String(d.currentVersion) !== String(v.versionNo)) { throw new Error('A newer version exists.'); }
  var b = findById_('Batches', d.batchId);
  if (b.status === 'CLOSED') { throw new Error('Batch is closed.'); }
  if (p.outcome !== 'ACCEPT' && p.outcome !== 'REJECT') { throw new Error('Choose Accept or Reject.'); }
  if (p.outcome === 'ACCEPT') {
    var blockers = acceptBlockers_(v.id);
    if (blockers.length) { throw new Error('Cannot accept yet:\n- ' + blockers.join('\n- ')); }
  }

  var items = activeChecklist_(d.type);
  var answers = {};
  (p.checklist || []).forEach(function (a) { answers[a.id] = a; });
  var result = items.map(function (it) {
    var a = answers[it.id];
    if (!a || ['YES', 'NO', 'NA'].indexOf(a.answer) < 0) { throw new Error('Answer every checklist item (missing: "' + it.item + '").'); }
    if (a.answer === 'NA' && !String(a.comment || '').trim()) { throw new Error('Give a reason for "N/A" on: ' + it.item); }
    return { id: it.id, item: it.item, answer: a.answer, comment: String(a.comment || '') };
  });
  var obs = (p.observations || []).filter(function (o) { return String(o.text || '').trim(); });
  if (p.outcome === 'ACCEPT' && result.some(function (r) { return r.answer === 'NO'; })) {
    throw new Error('A checklist item is answered "No". Reject the document with observations instead.');
  }
  if (p.outcome === 'REJECT') {
    if (!obs.length) { throw new Error('Record at least one observation (page, observation, severity) to reject.'); }
    obs.forEach(function (o) {
      if (!String(o.page || '').trim()) { throw new Error('Each observation needs a page number.'); }
      if (['Critical', 'Major', 'Minor'].indexOf(o.severity) < 0) { throw new Error('Each observation needs a severity.'); }
    });
  }

  var now = Date.now();
  var hol = holidayMap_();
  var elapsed = workingMsBetween_(new Date(v.uploadedAt).getTime(), now, hol) / HOUR;
  var limit = Number(setting_('VERIFY_HOURS')) || 24;
  var breach = elapsed > limit ? 'Y' : 'N';

  insert_('Verifications', { id: newId_('VR'), versionId: v.id, docId: d.id, batchId: b.id, outcome: p.outcome,
    checklist: JSON.stringify(result), remarks: String(p.remarks || ''), verifierId: user.id, verifierName: user.name,
    decidedAt: iso_(now), elapsedHours: elapsed.toFixed(1), breach: breach });
  obs.forEach(function (o) {
    insert_('Observations', { id: newId_('OB'), versionId: v.id, docId: d.id, batchId: b.id, page: String(o.page),
      text: String(o.text).trim(), severity: o.severity, createdAt: iso_(now), createdBy: user.name });
  });

  v.status = p.outcome === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
  v.decidedAt = iso_(now); v.decidedBy = user.name; v.elapsedHours = elapsed.toFixed(1); v.breach = breach;
  update_('Versions', v);

  var old = d.status;
  if (p.outcome === 'ACCEPT') {
    var hcDue = addWorkingDaysEnd_(istYmd_(now), Number(setting_('HARDCOPY_DAYS')) || 3, hol);
    d.status = 'HARDCOPY_PENDING';
    d.verifiedAt = iso_(now);
    d.hardcopyDueAt = iso_(hcDue);
  } else {
    d.status = 'REJECTED';
    d.rejectCount = String(Number(d.rejectCount || 0) + 1);
    d.lastRejectedAt = iso_(now);
  }
  d.updatedAt = iso_(now);
  update_('Documents', d);
  refreshBatchStatus_(b);

  audit_(user, p.outcome === 'ACCEPT' ? 'VERIFIED_OK' : 'VERIFICATION_REJECTED', 'Version', v.id, b.batchNo, old,
    DOC_TYPES[d.type].label + ' v' + v.versionNo + ' ' + p.outcome + '; ' + elapsed.toFixed(1) + ' working h' +
    (breach === 'Y' ? ' (24 h BREACH)' : '') + (obs.length ? '; ' + obs.length + ' observation(s)' : ''),
    String(p.remarks || ''), p.client);

  var uploader = findById_('Users', v.uploaderId);
  var to = deptEmails_(d.dept).concat(uploader && uploader.email ? [uploader.email] : []);
  if (p.outcome === 'ACCEPT') {
    sendMail_('OK|' + v.id, 'VERIFIED_OK', v.id, b.batchNo, to, deptEmails_('QA'),
      'Verified OK - submit hardcopy by ' + fmtDate_(new Date(d.hardcopyDueAt).getTime()) + ': ' + DOC_TYPES[d.type].label + ' - Batch ' + b.batchNo,
      mailBody_('Scanned copy verified OK - submit the hardcopy',
        'QA (' + esc_(user.name) + ') verified <b>' + DOC_TYPES[d.type].label + '</b> v' + v.versionNo +
        '. Please hand over the original hardcopy to QA with the transmittal slip (print it from the app) by <b>' +
        fmtDate_(new Date(d.hardcopyDueAt).getTime()) + '</b>.', docFacts_(b, d, now)));
  } else {
    var rows = obs.map(function (o) {
      return '<tr><td>' + esc_(o.page) + '</td><td>' + esc_(o.severity) + '</td><td>' + esc_(o.text) + '</td></tr>';
    }).join('');
    sendMail_('REJ|' + v.id, 'REJECTED', v.id, b.batchNo, to, deptEmails_('QA'),
      'REJECTED - correct and re-upload: ' + DOC_TYPES[d.type].label + ' - Batch ' + b.batchNo,
      mailBody_('Scanned copy rejected - please correct and re-upload',
        'QA (' + esc_(user.name) + ') rejected <b>' + DOC_TYPES[d.type].label + '</b> v' + v.versionNo +
        ' with the observations below. Correct the document and upload a new version.' +
        '<table style="border-collapse:collapse;margin-top:10px" border="1" cellpadding="6"><tr><th>Page</th><th>Severity</th><th>Observation</th></tr>' +
        rows + '</table>' + (p.remarks ? '<p>Remarks: ' + esc_(p.remarks) + '</p>' : ''), docFacts_(b, d, now)));
  }
  return { status: d.status, elapsedHours: elapsed.toFixed(1), breach: breach };
}

/** p = { docId, receivedFrom, receivedOn, pagesReceived, condition, location, discrepancy, discrepancyText } */
function apiRecordHardcopy_(user, p) {
  var d = findById_('Documents', p.docId);
  if (!d || d.status !== 'HARDCOPY_PENDING') { throw new Error('This document is not awaiting hardcopy.'); }
  var b = findById_('Batches', d.batchId);
  var v = rows_('Versions').filter(function (x) { return x.docId === d.id && String(x.versionNo) === String(d.currentVersion); })[0];
  var scanned = Number(v.actualPages);
  var pages = Number(p.pagesReceived);
  if (!(pages > 0)) { throw new Error('Enter the number of pages received.'); }
  var receivedOn = req_(p.receivedOn, 'Date received');
  if (receivedOn > istYmd_(Date.now())) { throw new Error('Date received cannot be in the future.'); }
  req_(p.receivedFrom, 'Received from');
  req_(p.location, 'Storage location');
  var disc = p.discrepancy === true;
  var discText = String(p.discrepancyText || '').trim();
  if (pages !== scanned) {
    disc = true;
    discText = ('Page count mismatch: hardcopy ' + pages + ' pages vs scanned ' + scanned + ' pages. ' + discText).trim();
  }
  if (disc && !discText) { throw new Error('Describe the discrepancy.'); }
  var now = Date.now();
  var hc = { id: newId_('HC'), docId: d.id, batchId: b.id, receivedFrom: String(p.receivedFrom).trim(),
    receivedOn: receivedOn, pagesReceived: String(pages), pagesScanned: String(scanned),
    condition: String(p.condition || 'Good'), location: String(p.location).trim(), discrepancy: disc ? 'Y' : 'N',
    discrepancyText: discText, status: disc ? 'OPEN' : 'OK', recordedAt: iso_(now), recordedBy: user.name,
    resolvedAt: '', resolvedBy: '', resolution: '' };
  insert_('Hardcopies', hc);
  var old = d.status;
  d.status = disc ? 'HARDCOPY_DISCREPANCY' : 'HARDCOPY_RECEIVED';
  if (!disc) { d.hardcopyReceivedAt = iso_(now); }
  d.updatedAt = iso_(now);
  update_('Documents', d);
  refreshBatchStatus_(b);
  audit_(user, disc ? 'HARDCOPY_DISCREPANCY' : 'HARDCOPY_RECEIVED', 'Hardcopy', hc.id, b.batchNo, old,
    DOC_TYPES[d.type].label + '; ' + pages + ' pages; location ' + hc.location + (disc ? '; DISCREPANCY: ' + discText : ''), '', p.client);
  if (disc) {
    sendMail_('HCD|' + hc.id, 'HARDCOPY_DISCREPANCY', hc.id, b.batchNo, deptEmails_(d.dept), deptEmails_('QA'),
      'Hardcopy discrepancy: ' + DOC_TYPES[d.type].label + ' - Batch ' + b.batchNo,
      mailBody_('Hardcopy does not match the verified scan',
        'QA recorded a discrepancy on receipt of the hardcopy: <b>' + esc_(discText) + '</b>. Please contact QA to resolve it.',
        docFacts_(b, d, now)));
  }
  return { status: d.status };
}

function apiResolveDiscrepancy_(user, p) {
  var hc = findById_('Hardcopies', p.hardcopyId);
  if (!hc || hc.status !== 'OPEN') { throw new Error('No open discrepancy found.'); }
  var resolution = req_(p.resolution, 'Resolution / justification');
  var d = findById_('Documents', hc.docId);
  var b = findById_('Batches', hc.batchId);
  var now = Date.now();
  hc.status = 'RESOLVED'; hc.resolvedAt = iso_(now); hc.resolvedBy = user.name; hc.resolution = resolution;
  update_('Hardcopies', hc);
  d.status = 'HARDCOPY_RECEIVED'; d.hardcopyReceivedAt = iso_(now); d.updatedAt = iso_(now);
  update_('Documents', d);
  refreshBatchStatus_(b);
  audit_(user, 'DISCREPANCY_RESOLVED', 'Hardcopy', hc.id, b.batchNo, 'OPEN', 'RESOLVED', resolution, p.client);
  return true;
}

function apiCloseBatch_(user, p) {
  if (hashPw_(p.password, user.salt) !== user.pwHash) {
    audit_(user, 'SIGNATURE_FAILED', 'Batch', p.batchId, '', '', 'Wrong password at closure', '', p.client);
    throw new Error('Password incorrect. The batch was not closed.');
  }
  var b = findById_('Batches', p.batchId);
  if (!b) { throw new Error('Batch not found.'); }
  if (b.status === 'CLOSED') { throw new Error('Batch is already closed.'); }
  var docs = rows_('Documents').filter(function (d) { return d.batchId === b.id; });
  var notReady = docs.filter(function (d) { return d.status !== 'HARDCOPY_RECEIVED'; });
  if (notReady.length) {
    throw new Error('Cannot close: ' + notReady.map(function (d) { return DOC_TYPES[d.type].label + ' is ' + d.status; }).join('; '));
  }
  var open = rows_('Hardcopies').filter(function (h) { return h.batchId === b.id && h.status === 'OPEN'; });
  if (open.length) { throw new Error('Cannot close: an open hardcopy discrepancy exists.'); }
  var now = Date.now();
  b.status = 'CLOSED'; b.closedAt = iso_(now); b.closedBy = user.name; b.closeRemarks = String(p.remarks || '');
  update_('Batches', b);
  audit_(user, 'BATCH_DATA_VERIFICATION_COMPLETED', 'Batch', b.id, b.batchNo, 'READY_TO_CLOSE', 'CLOSED', b.closeRemarks, p.client);
  sendMail_('CLOSED|' + b.id, 'CLOSED', b.id, b.batchNo, deptEmails_('PRD').concat(deptEmails_('QC')), deptEmails_('QA'),
    'Batch Data Verification completed - Batch ' + b.batchNo,
    mailBody_('Batch Data Verification completed',
      'QA (' + esc_(user.name) + ') completed Batch Data Verification for batch <b>' + esc_(b.batchNo) + '</b> of <b>' +
      esc_(b.product) + '</b>. The batch record is now closed and locked.', ''));
  return true;
}

function apiLogPrint_(user, p) {
  var d = findById_('Documents', p.docId);
  if (!d) { throw new Error('Document not found.'); }
  audit_(user, 'TRANSMITTAL_SLIP_PRINTED', 'Document', d.id, d.batchNo, '', DOC_TYPES[d.type].label, '', p.client);
  return true;
}

function apiAuditLog_(user, p) {
  var q = norm_(p.batchNo || '');
  var rows = rows_('AuditLog');
  if (q) { rows = rows.filter(function (a) { return norm_(a.batchNo).indexOf(q) >= 0; }); }
  if (p.from) { rows = rows.filter(function (a) { return istYmd_(new Date(a.timestamp).getTime()) >= p.from; }); }
  if (p.to) { rows = rows.filter(function (a) { return istYmd_(new Date(a.timestamp).getTime()) <= p.to; }); }
  rows = rows.slice(-2000).reverse().map(strip_);
  audit_(user, 'AUDIT_TRAIL_VIEWED', 'AuditLog', '', p.batchNo || '', '', '', '', p.client);
  return rows;
}

function apiReminderLog_() {
  return rows_('ReminderLog').slice(-500).reverse().map(strip_);
}

function apiGetSettings_() {
  return {
    settings: rows_('Settings').map(strip_),
    holidays: rows_('Holidays').map(strip_).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }),
    checklists: rows_('Checklists').map(strip_),
    remainingEmailQuota: (function () { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return null; } })()
  };
}

function apiSaveSetting_(user, p) {
  if (!DEFAULT_SETTINGS[p.key]) { throw new Error('Unknown setting.'); }
  var value = String(p.value == null ? '' : p.value).trim();
  if (/^EMAIL_/.test(p.key) && value) {
    value.split(',').forEach(function (e) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim())) { throw new Error('Invalid email: ' + e); }
    });
  }
  if (['UPLOAD_DAYS', 'VERIFY_HOURS', 'VERIFY_REMINDER_HOURS', 'REUPLOAD_REMINDER_HOURS', 'HARDCOPY_DAYS',
    'DAILY_REMINDER_HOUR', 'MAX_FILE_MB', 'SESSION_TIMEOUT_MIN', 'PASSWORD_EXPIRY_DAYS', 'LOCKOUT_ATTEMPTS']
    .indexOf(p.key) >= 0 && !/^\d+$/.test(value)) { throw new Error('Enter a whole number.'); }
  if (p.key === 'UPLOAD_DAYS_MODE' && ['CALENDAR', 'WORKING'].indexOf(value) < 0) { throw new Error('Use CALENDAR or WORKING.'); }
  if (p.key === 'UPLOAD_SHIFT_NONWORKING' && ['YES', 'NO'].indexOf(value) < 0) { throw new Error('Use YES or NO.'); }
  var row = rows_('Settings').filter(function (r) { return r.key === p.key; })[0];
  var old = row ? row.value : '';
  setSetting_(p.key, value);
  audit_(user, 'CONFIG_CHANGED', 'Setting', p.key, '', old, value, String(p.reason || ''), p.client);
  return true;
}

function apiAddHoliday_(user, p) {
  var date = req_(p.date, 'Date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { throw new Error('Invalid date.'); }
  var name = req_(p.name, 'Holiday name');
  if (rows_('Holidays').some(function (h) { return h.date === date; })) { throw new Error('Holiday already exists for that date.'); }
  insert_('Holidays', { date: date, name: name, addedBy: user.name, addedAt: iso_(Date.now()) });
  audit_(user, 'HOLIDAY_ADDED', 'Holiday', date, '', '', name, '', p.client);
  return true;
}

function apiRemoveHoliday_(user, p) {
  var h = rows_('Holidays').filter(function (x) { return x.date === p.date; })[0];
  if (!h) { throw new Error('Holiday not found.'); }
  deleteRow_('Holidays', h);
  audit_(user, 'HOLIDAY_REMOVED', 'Holiday', h.date, '', h.name, '', req_(p.reason, 'Reason'), p.client);
  return true;
}

/** p = { id?, docType, item, active } - items are never deleted, only deactivated. */
function apiSaveChecklistItem_(user, p) {
  if (!DOC_TYPES[p.docType]) { throw new Error('Unknown document type.'); }
  var text = req_(p.item, 'Checklist item');
  if (p.id) {
    var r = findById_('Checklists', p.id);
    if (!r) { throw new Error('Item not found.'); }
    var old = r.item + ' [' + r.active + ']';
    r.item = text; r.active = p.active === false ? 'N' : 'Y';
    update_('Checklists', r);
    audit_(user, 'CHECKLIST_CHANGED', 'Checklist', r.id, '', old, r.item + ' [' + r.active + ']', String(p.reason || ''), p.client);
  } else {
    var max = rows_('Checklists').filter(function (x) { return x.docType === p.docType; })
      .reduce(function (m, x) { return Math.max(m, Number(x.order) || 0); }, 0);
    var n = { id: newId_('CK'), docType: p.docType, item: text, order: String(max + 1), active: 'Y' };
    insert_('Checklists', n);
    audit_(user, 'CHECKLIST_ADDED', 'Checklist', n.id, '', '', p.docType + ': ' + text, String(p.reason || ''), p.client);
  }
  return true;
}

function apiListUsers_() {
  return rows_('Users').map(function (u) {
    var x = publicUser_(u);
    x.failed = u.failed; x.locked = !!(u.lockedUntil && Number(u.lockedUntil) > Date.now());
    x.createdAt = u.createdAt; x.createdBy = u.createdBy; x.pwChangedAt = u.pwChangedAt;
    return x;
  });
}

function apiCreateUser_(user, p) {
  var temp = tempPassword_();
  var u = createUserRecord_(p, temp, user.name);
  audit_(user, 'USER_CREATED', 'User', u.id, '', '', u.name + ' (' + u.username + ', ' + u.role + ')', '', p.client);
  return { username: u.username, tempPassword: temp };
}

/** p = { id, name, email, role, active, unlock } */
function apiUpdateUser_(user, p) {
  var u = findById_('Users', p.id);
  if (!u) { throw new Error('User not found.'); }
  var before = JSON.stringify(publicUser_(u));
  if (p.name != null) { u.name = req_(p.name, 'Name'); }
  if (p.email != null) {
    var em = String(p.email).trim();
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { throw new Error('Invalid email.'); }
    u.email = em;
  }
  if (p.role != null) {
    if (ROLES.indexOf(p.role) < 0) { throw new Error('Invalid role.'); }
    if (u.id === user.id && p.role !== 'ADMIN') { throw new Error('You cannot remove your own admin role.'); }
    u.role = p.role;
  }
  if (p.active != null) {
    if (u.id === user.id && p.active === false) { throw new Error('You cannot disable your own account.'); }
    u.active = p.active ? 'Y' : 'N';
  }
  if (p.unlock) { u.failed = '0'; u.lockedUntil = ''; }
  update_('Users', u);
  audit_(user, p.unlock ? 'USER_UNLOCKED' : 'USER_UPDATED', 'User', u.id, '', before, JSON.stringify(publicUser_(u)),
    String(p.reason || ''), p.client);
  return true;
}

function apiResetPassword_(user, p) {
  var u = findById_('Users', p.id);
  if (!u) { throw new Error('User not found.'); }
  var temp = tempPassword_();
  setPassword_(u, temp, true);
  u.failed = '0'; u.lockedUntil = '';
  update_('Users', u);
  audit_(user, 'PASSWORD_RESET', 'User', u.id, '', '', u.username, '', p.client);
  return { username: u.username, tempPassword: temp };
}

function apiSendTestEmail_(user) {
  var to = uniq_([setting_('EMAIL_PRD'), setting_('EMAIL_QC'), setting_('EMAIL_QA')].concat(splitEmails_(setting_('EMAIL_ESCALATION'))));
  if (!to.length) { throw new Error('No recipient emails configured yet.'); }
  var r = sendMail_('TEST|' + Date.now(), 'TEST', '', '', to, [], 'BDVS test email',
    mailBody_('Test email', 'This is a test message from the Batch Document Verification System. If you can read it, notifications to this address work.', ''));
  return { sentTo: to, status: r };
}

// ---------------------------------------------------------------------------
// Reminder engine (hourly time trigger). Also callable from the sheet menu.
// ---------------------------------------------------------------------------

function runReminders() {
  cacheReset_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { return; }
  try {
    var now = Date.now();
    var hol = holidayMap_();
    var dailyHour = Number(setting_('DAILY_REMINDER_HOUR'));
    if (isNaN(dailyHour)) { dailyHour = 9; }
    var isDailySlot = istHour_(now) >= dailyHour;
    var today = istYmd_(now);
    var verifyRemindAt = Number(setting_('VERIFY_REMINDER_HOURS')) || 12;
    var reuploadHours = Number(setting_('REUPLOAD_REMINDER_HOURS')) || 24;
    var esc = splitEmails_(setting_('EMAIL_ESCALATION'));
    var batches = indexBy_(rows_('Batches'), 'id');
    var versions = rows_('Versions');

    rows_('Documents').forEach(function (d) {
      var b = batches[d.batchId];
      if (!b || b.status === 'CLOSED') { return; }
      var label = DOC_TYPES[d.type].label;
      var dept = deptEmails_(d.dept);
      var qa = deptEmails_('QA');
      var facts = docFacts_(b, d, now);

      if (d.status === 'PENDING_UPLOAD') {
        var due = new Date(d.dueAt).getTime();
        if (now < due && now >= due - DAY) {
          sendMail_('UP_D1|' + d.id, 'UPLOAD_REMINDER', d.id, b.batchNo, dept, qa,
            'Reminder: upload ' + label + ' - Batch ' + b.batchNo + ' due ' + fmt_(due),
            mailBody_('Upload reminder', 'The scanned <b>' + label + '</b> for batch <b>' + esc_(b.batchNo) +
              '</b> is due by <b>' + fmt_(due) + '</b> (' + hoursText_(due - now) + ' left).', facts));
        }
        if (now < due && istYmd_(now) === istYmd_(due) && isDailySlot) {
          sendMail_('UP_DDAY|' + d.id, 'UPLOAD_DUE_TODAY', d.id, b.batchNo, dept, qa,
            'DUE TODAY: upload ' + label + ' - Batch ' + b.batchNo,
            mailBody_('Upload due today', 'The scanned <b>' + label + '</b> for batch <b>' + esc_(b.batchNo) +
              '</b> must be uploaded today by <b>' + fmt_(due) + '</b>.', facts));
        }
        if (now >= due && isDailySlot) {
          sendMail_('UP_OVER|' + d.id + '|' + today, 'UPLOAD_OVERDUE', d.id, b.batchNo, dept, qa.concat(esc),
            'OVERDUE: ' + label + ' not uploaded - Batch ' + b.batchNo,
            mailBody_('Upload overdue - escalation', 'The scanned <b>' + label + '</b> for batch <b>' + esc_(b.batchNo) +
              '</b> was due on ' + fmt_(due) + ' and is <b style="color:#b91c1c">overdue by ' + hoursText_(now - due) +
              '</b>. Please upload it immediately.', facts));
        }
      }

      if (d.status === 'UNDER_VERIFICATION') {
        var v = versions.filter(function (x) { return x.docId === d.id && String(x.versionNo) === String(d.currentVersion); })[0];
        if (v) {
          var vdue = new Date(v.verifyDueAt).getTime();
          var elapsed = workingMsBetween_(new Date(v.uploadedAt).getTime(), now, hol) / HOUR;
          if (elapsed >= verifyRemindAt && now < vdue) {
            sendMail_('VER_HALF|' + v.id, 'VERIFY_REMINDER', v.id, b.batchNo, qa, [],
              'Reminder: verify ' + label + ' v' + v.versionNo + ' - Batch ' + b.batchNo + ' by ' + fmt_(vdue),
              mailBody_('Verification reminder', '<b>' + label + '</b> v' + v.versionNo + ' for batch <b>' + esc_(b.batchNo) +
                '</b> has been waiting ' + elapsed.toFixed(1) + ' working hours. Verification is due by <b>' + fmt_(vdue) + '</b>.', facts));
          }
          if (now >= vdue) {
            var key = 'VER_OVER|' + v.id + (sentBefore_('VER_OVER|' + v.id + '|first') ? '|' + today : '|first');
            if (key.slice(-6) === '|first' || isDailySlot) {
              sendMail_(key, 'VERIFY_OVERDUE', v.id, b.batchNo, qa, esc,
                'OVERDUE: QA verification of ' + label + ' - Batch ' + b.batchNo,
                mailBody_('Verification overdue - escalation', '<b>' + label + '</b> v' + v.versionNo + ' for batch <b>' +
                  esc_(b.batchNo) + '</b> was due for verification by ' + fmt_(vdue) +
                  ' and has not been verified (24-hour window breached).', facts));
            }
          }
        }
      }

      if (d.status === 'REJECTED' && d.lastRejectedAt) {
        var since = now - new Date(d.lastRejectedAt).getTime();
        if (since >= reuploadHours * HOUR) {
          var rk = 'REUP|' + d.id + '|' + d.rejectCount;
          var k2 = sentBefore_(rk + '|first') ? rk + '|' + today : rk + '|first';
          if (k2.slice(-6) === '|first' || isDailySlot) {
            sendMail_(k2, 'REUPLOAD_REMINDER', d.id, b.batchNo, dept, qa,
              'Reminder: re-upload corrected ' + label + ' - Batch ' + b.batchNo,
              mailBody_('Re-upload pending', 'The <b>' + label + '</b> for batch <b>' + esc_(b.batchNo) +
                '</b> was rejected ' + hoursText_(since) + ' ago and has not been re-uploaded. Please correct and upload a new version.', facts));
          }
        }
      }

      if (d.status === 'HARDCOPY_PENDING' && d.hardcopyDueAt) {
        var hdue = new Date(d.hardcopyDueAt).getTime();
        if (now < hdue && now >= hdue - DAY) {
          sendMail_('HC_D1|' + d.id, 'HARDCOPY_REMINDER', d.id, b.batchNo, dept, qa,
            'Reminder: submit hardcopy of ' + label + ' - Batch ' + b.batchNo + ' by ' + fmtDate_(hdue),
            mailBody_('Hardcopy submission reminder', 'Please hand over the original hardcopy of <b>' + label +
              '</b> for batch <b>' + esc_(b.batchNo) + '</b> to QA by <b>' + fmtDate_(hdue) + '</b>.', facts));
        }
        if (now >= hdue && isDailySlot) {
          sendMail_('HC_OVER|' + d.id + '|' + today, 'HARDCOPY_OVERDUE', d.id, b.batchNo, dept, qa.concat(esc),
            'OVERDUE: hardcopy of ' + label + ' not received - Batch ' + b.batchNo,
            mailBody_('Hardcopy overdue - escalation', 'The original hardcopy of <b>' + label + '</b> for batch <b>' +
              esc_(b.batchNo) + '</b> was due on ' + fmtDate_(hdue) + ' and has not been received by QA.', facts));
        }
      }
    });
    monthlyReportMail_(now);
  } finally {
    lock.releaseLock();
  }
}

/** On the 1st of each month (after the daily reminder hour) email QA the previous month's limits / trend summary. */
function monthlyReportMail_(now) {
  var d = istParts_(now);
  var hour = Number(setting_('DAILY_REMINDER_HOUR')); if (isNaN(hour)) { hour = 9; }
  if (d.getUTCDate() !== 1 || d.getUTCHours() < hour) { return; }
  var prev = istParts_(now - 2 * DAY);
  var month = prev.getUTCFullYear() + '-' + pad_(prev.getUTCMonth() + 1);
  if (sentBefore_('MONTHLY|' + month)) { return; }
  var r = apiMonthlyReport_(null, { month: month });
  var rows = r.rows.map(function (x) {
    return '<tr><td>' + x.productCode + '</td><td>' + esc_(x.parameter) + (x.stage ? ' [' + esc_(x.stage) + ']' : '') + '</td><td>' + esc_(x.limitText) + '</td><td>' + x.n +
      '</td><td>' + (x.min == null ? '' : x.min) + ' - ' + (x.max == null ? '' : x.max) + '</td><td>' + (x.mean == null ? '' : x.mean) + '</td><td' + (x.fail ? ' style="color:#b91c1c;font-weight:bold"' : '') + '>' + x.fail +
      '</td><td' + (x.oot ? ' style="color:#b45309;font-weight:bold"' : '') + '>' + x.oot + '</td></tr>';
  }).join('');
  sendMail_('MONTHLY|' + month, 'MONTHLY_REPORT', '', '', deptEmails_('QA'), splitEmails_(setting_('EMAIL_QA_HEAD')),
    'Monthly limits & trend report - ' + month,
    mailBody_('Monthly limits & trend report - ' + month, r.batches + ' batches dispatched, ' + r.closed + ' closed. Out-of-limit and out-of-trend counts per parameter:' +
      '<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px;margin-top:8px"><tr><th>Product</th><th>Parameter</th><th>Limit</th><th>n</th><th>Range</th><th>Mean</th><th>Out of limit</th><th>Out of trend</th></tr>' +
      rows + '</table><p>Full report with all findings: BDVS &gt; Reports.</p>', ''));
}

// ---------------------------------------------------------------------------
// Daily Production & Dispatch Register (Google Sheet filled by Production)
// ---------------------------------------------------------------------------

var REGISTER_COLUMNS = ['Mfg Date', 'Batch No.', 'Product', 'Batch Size', 'Customer', 'Dispatch Date',
  'Invoice / Challan No.', 'Market', 'Site', 'Remarks', 'BDVS Status'];

// Header text -> field. Matching is case/space-insensitive so Production can rename or reorder columns.
var REGISTER_HEADER_MAP = [
  [/^(mfg|manufactur\w*)\s*(date|dt)?$|^date\s*of\s*m(fg|anufactur\w*)$/, 'mfgDate'],
  [/^batch\s*(no|number|#)?\.?$/, 'batchNo'],
  [/^product(\s*name)?$/, 'product'],
  [/^(batch\s*)?(size|qty|quantity)(\s*\(?kgs?\)?)?$/, 'batchSize'],
  [/^(customer|party|company|consignee)(\s*name)?$/, 'customer'],
  [/^(dispatch|despatch)\s*(date|dt)?$|^date\s*of\s*(dispatch|despatch)$/, 'dispatchDate'],
  [/^(invoice|challan|inv)(\s*\/\s*challan)?\s*(no|number)?\.?$/, 'invoiceNo'],
  [/^market$/, 'market'],
  [/^(site|plant|unit)$/, 'site'],
  [/^remarks?$/, 'remarks'],
  [/^bdvs\s*status$/, 'status']
];

function apiCreateProductionSheet_(user, p) {
  var existing = setting_('PRODUCTION_SHEET_ID');
  if (existing && !p.force) { throw new Error('A production register is already linked. Clear PRODUCTION_SHEET_ID first if you want a new one.'); }
  var nss = SpreadsheetApp.create('Daily Production & Dispatch Register (BDVS)');
  var sh = nss.getSheets()[0];
  sh.setName('Register');
  sh.getRange(1, 1, 1, REGISTER_COLUMNS.length).setValues([REGISTER_COLUMNS]).setFontWeight('bold').setBackground('#dbeafe');
  sh.setFrozenRows(1);
  sh.getRange('A2:A').setNumberFormat('dd.MM.yyyy');
  sh.getRange('F2:F').setNumberFormat('dd.MM.yyyy');
  sh.getRange('B2:B').setNumberFormat('@');
  sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([PRODUCTS.ALP, PRODUCTS.MGP], true).setAllowInvalid(true).build());
  sh.getRange('H2:H').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Domestic', 'Export'], true).build());
  sh.getRange('I2:I').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pharchem Pvt. Ltd.', 'Enicar Pharmaceuticals Pvt. Ltd.'], true).build());
  sh.getRange('A2:A').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sh.getRange('F2:F').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sh.getRange('K2:K').setBackground('#f1f5f9');
  sh.protect().setDescription('Columns are used by BDVS').setWarningOnly(true);
  var help = nss.insertSheet('How to fill');
  help.getRange(1, 1, 12, 1).setValues([
    ['DAILY PRODUCTION & DISPATCH REGISTER - read by BDVS every evening at ' + setting_('IMPORT_HOUR') + ':00 IST'],
    ['1. Every evening add one row per batch manufactured today: Mfg Date, Batch No., Product, Batch Size, Customer.'],
    ['2. If there was no production today, add one row with Mfg Date = today and Batch No. = NIL.'],
    ['3. When the batch is dispatched, fill Dispatch Date and Invoice / Challan No. on the same row (do not add a new row).'],
    ['4. BDVS registers the batch on the evening the Dispatch Date is filled; PRD and QC then have 2 days from dispatch to upload the scans.'],
    ['5. Batch No. must start with ALP/ or MGP/ (e.g. ALP/214(26-27)); Product and Batch Size are taken from the BMR if left blank.'],
    ['6. Customer: use the same name every time (e.g. Dynemic Products Ltd) so BDVS finds the right BMR, STP and COA format.'],
    ['7. Market and Site are optional (default: Domestic / Pharchem Pvt. Ltd.).'],
    ['8. Do not edit the BDVS Status column - BDVS writes the result there (Registered / Awaiting dispatch / ERROR ...).'],
    ['9. If a row shows ERROR, correct it; BDVS retries the next evening (or QA can press "Read now").'],
    ['10. Never delete rows that BDVS has registered. To correct a registered batch, inform QA.'],
    ['Partial consignments: enter the FIRST dispatch date.']
  ]);
  help.setColumnWidth(1, 900);
  var id = nss.getId();
  try {
    var f = DriveApp.getFileById(id);
    splitEmails_(setting_('EMAIL_PRD')).forEach(function (e) { f.addEditor(e); });
    splitEmails_(setting_('EMAIL_QC')).concat(splitEmails_(setting_('EMAIL_QA'))).forEach(function (e) { f.addViewer(e); });
  } catch (e) { /* sharing is optional */ }
  setSetting_('PRODUCTION_SHEET_ID', id);
  audit_(user, 'PRODUCTION_REGISTER_CREATED', 'Setting', 'PRODUCTION_SHEET_ID', '', existing, id, '', p.client);
  return { id: id, url: nss.getUrl() };
}

function apiLinkProductionSheet_(user, p) {
  var id = sheetIdFrom_(p.sheet);
  if (!id) { throw new Error('Paste the link of the production register Google Sheet.'); }
  var name;
  try { name = SpreadsheetApp.openById(id).getName(); } catch (e) {
    throw new Error('Cannot open that sheet. Share it with the Google account that deployed BDVS (and make sure it is a Google Sheet, not an .xlsx file).');
  }
  var old = setting_('PRODUCTION_SHEET_ID');
  setSetting_('PRODUCTION_SHEET_ID', id);
  audit_(user, 'CONFIG_CHANGED', 'Setting', 'PRODUCTION_SHEET_ID', '', old, id + ' (' + name + ')', 'Production register linked', p.client);
  return { id: id, name: name };
}

function sheetIdFrom_(v) {
  v = String(v || '').trim();
  var m = v.match(/\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : v;
}

function cellYmd_(v) {
  if (isDate_(v)) { return istYmd_(v.getTime()); }
  if (v === '' || v == null) { return ''; }
  if (typeof v === 'number') { return istYmd_(Date.UTC(1899, 11, 30) - IST_OFF + v * DAY + 12 * HOUR); } // serial date
  return normDate_(String(v));
}

/** Trigger entry point (daily). */
function runDailyImport() {
  cacheReset_();
  if (!setting_('PRODUCTION_SHEET_ID')) { return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) { return; }
  try { importProductionRegister_(null, 'daily timer'); } finally { lock.releaseLock(); }
}

/**
 * Reads the production register. Rows with a dispatch date are registered (auto-matched to the GMP
 * master documents); rows without one are reported as awaiting dispatch; problems are written back to the
 * row and emailed to QA and Production.
 */
function importProductionRegister_(user, client) {
  var id = sheetIdFrom_(setting_('PRODUCTION_SHEET_ID'));
  if (!id) { throw new Error('Link the Daily Production & Dispatch Register first (Settings).'); }
  var actor = user || { id: 'SYSTEM', name: 'Daily import (production register)', role: 'SYSTEM' };
  var book;
  try { book = SpreadsheetApp.openById(id); } catch (e) {
    throw new Error('Cannot open the production register. Share it with the Google account that deployed BDVS.');
  }
  var sh = book.getSheetByName('Register') || book.getSheets()[0];
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 1) { throw new Error('The production register is empty (no header row).'); }
  var data = sh.getRange(1, 1, last, lastCol).getValues();
  var head = data[0].map(function (h) { return String(h).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:*]/g, ''); });
  var col = {};
  head.forEach(function (h, i) {
    REGISTER_HEADER_MAP.forEach(function (m) { if (col[m[1]] === undefined && m[0].test(h)) { col[m[1]] = i; } });
  });
  if (col.batchNo === undefined || col.dispatchDate === undefined || col.customer === undefined) {
    throw new Error('The production register needs columns "Batch No.", "Customer" and "Dispatch Date" in row 1.');
  }
  var get = function (row, k) { return col[k] === undefined ? '' : row[col[k]]; };
  var now = Date.now();
  var res = { rowsRead: 0, registered: [], awaiting: [], already: 0, errors: [], days: {} };
  var statusWrites = [];
  var batches = rows_('Batches');

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var batchNo = String(get(row, 'batchNo') || '').trim();
    var mfgRaw = get(row, 'mfgDate');
    var mfg = '';
    try { mfg = cellYmd_(mfgRaw); } catch (e) { mfg = ''; }
    if (mfg) { res.days[mfg] = true; }
    if (!batchNo || /^nil$/i.test(batchNo)) { continue; }
    res.rowsRead++;
    var oldStatus = String(get(row, 'status') || '');
    var status = '';
    var code = productCodeOf_(get(row, 'product'), batchNo);
    var productName = String(get(row, 'product') || '').trim() || PRODUCTS[code] || '';
    var dup = batches.filter(function (b) { return norm_(b.batchNo) === norm_(batchNo) && (!productName || norm_(b.product) === norm_(productName)); })[0];
    if (dup) {
      res.already++;
      if (!/^Registered/.test(oldStatus)) { status = 'Registered ' + fmtDate_(new Date(dup.registeredAt).getTime()); }
    } else {
      var disp = '';
      var rawDisp = get(row, 'dispatchDate');
      try { disp = cellYmd_(rawDisp); } catch (e) { status = 'ERROR: dispatch date "' + rawDisp + '" not understood (use DD.MM.YYYY)'; }
      if (!status && !disp) {
        res.awaiting.push({ row: r + 1, batchNo: batchNo, customer: String(get(row, 'customer')), mfgDate: mfg });
        status = 'Awaiting dispatch (manufactured' + (mfg ? ' ' + fmtDate_(ymdToMs_(mfg, 12)) : '') + ')';
      } else if (!status) {
        try {
          var out = registerOne_(actor, { batchNo: batchNo, product: get(row, 'product'), batchSize: String(get(row, 'batchSize') || ''),
            dispatchDate: disp, customer: String(get(row, 'customer') || ''), invoiceNo: String(get(row, 'invoiceNo') || ''),
            market: String(get(row, 'market') || ''), site: String(get(row, 'site') || ''),
            remarks: ['From production register row ' + (r + 1), mfg ? 'Mfg ' + fmtDate_(ymdToMs_(mfg, 12)) : '', String(get(row, 'remarks') || '')].filter(String).join('; '),
            client: client || 'daily import', fromBulk: true });
          batches = rows_('Batches');
          res.registered.push({ row: r + 1, batchNo: batchNo, customer: String(get(row, 'customer')), dueAt: out.dueAt,
            matchSource: out.matchSource, docs: masterSummary_(out.masterDocs) });
          status = 'Registered ' + fmtDate_(now) + ' - upload due ' + fmt_(new Date(out.dueAt).getTime());
        } catch (e) {
          status = 'ERROR: ' + String(e.message || e);
        }
      }
    }
    if (/^ERROR/.test(status)) { res.errors.push({ row: r + 1, batchNo: batchNo, error: status.replace(/^ERROR: /, '') }); }
    if (status && status !== oldStatus && col.status !== undefined) { statusWrites.push([r + 1, status]); }
  }
  // Write results back to the register so Production can see them (needs edit access; optional).
  try { statusWrites.forEach(function (w) { sh.getRange(w[0], col.status + 1).setValue(w[1]); }); } catch (e) { /* read-only */ }

  // Was the register filled for the last working day?
  var missingDay = '';
  if (setting_('REGISTER_MISSING_ALERT') !== 'NO') {
    var hol = holidayMap_();
    var today = istYmd_(now);
    if (isWorkingDay_(today, hol) && !res.days[today] && !user) { missingDay = today; }
  }

  var log = { id: newId_('IM'), runAt: iso_(now), by: actor.name, rowsRead: String(res.rowsRead), registered: String(res.registered.length),
    awaitingDispatch: String(res.awaiting.length), alreadyRegistered: String(res.already), errors: String(res.errors.length),
    details: JSON.stringify({ registered: res.registered, awaiting: res.awaiting, errors: res.errors, missingDay: missingDay }) };
  insert_('ImportLog', log);
  audit_(user, 'PRODUCTION_REGISTER_READ', 'ImportLog', log.id, '', '', res.registered.length + ' registered, ' + res.awaiting.length +
    ' awaiting dispatch, ' + res.errors.length + ' errors' + (missingDay ? ', no entry for ' + missingDay : ''), '', client);

  // Summary email to QA (and Production when there is something for them to fix).
  if (res.registered.length || res.errors.length || missingDay) {
    var html = '';
    if (res.registered.length) {
      html += '<h3 style="margin:12px 0 6px">Registered (' + res.registered.length + ') - PRD and QC have been notified</h3><table border="1" cellpadding="5" style="border-collapse:collapse;font-size:13px"><tr><th>Batch</th><th>Customer</th><th>Upload due</th><th>Master documents</th></tr>' +
        res.registered.map(function (x) {
          return '<tr><td>' + esc_(x.batchNo) + '</td><td>' + esc_(x.customer) + '</td><td>' + fmt_(new Date(x.dueAt).getTime()) + '</td><td>' + esc_(x.docs) +
            (x.matchSource === 'remembered' ? '' : ' <b style="color:#b45309">(new customer - auto-matched, please check)</b>') + '</td></tr>';
        }).join('') + '</table>';
    }
    if (res.errors.length) {
      html += '<h3 style="margin:12px 0 6px;color:#b91c1c">Rows with problems (' + res.errors.length + ') - correct them in the register</h3><table border="1" cellpadding="5" style="border-collapse:collapse;font-size:13px"><tr><th>Row</th><th>Batch</th><th>Problem</th></tr>' +
        res.errors.map(function (x) { return '<tr><td>' + x.row + '</td><td>' + esc_(x.batchNo) + '</td><td>' + esc_(x.error) + '</td></tr>'; }).join('') + '</table>';
    }
    if (missingDay) {
      html += '<p style="color:#b91c1c"><b>No entry was made in the production register for ' + fmtDate_(ymdToMs_(missingDay, 12)) + '.</b> Add today\'s batches, or a NIL row if there was no production.</p>';
    }
    html += '<p>Manufactured and awaiting dispatch: <b>' + res.awaiting.length + '</b> batch(es).</p>';
    var to = deptEmails_('QA');
    var cc = (res.errors.length || missingDay) ? deptEmails_('PRD') : [];
    sendMail_('IMPORT|' + log.id, 'DAILY_IMPORT', '', '', to, cc,
      'Daily production register: ' + res.registered.length + ' registered' + (res.errors.length ? ', ' + res.errors.length + ' problem(s)' : '') + (missingDay ? ', register not filled' : ''),
      mailBody_('Daily production register - ' + fmtDate_(now), 'Result of reading the Daily Production &amp; Dispatch Register.' + html, ''));
  }
  return { rowsRead: res.rowsRead, registered: res.registered, awaiting: res.awaiting, already: res.already, errors: res.errors, missingDay: missingDay };
}

/** QA can correct the master documents of an open batch (reason required). */
function apiUpdateMasterDocs_(user, p) {
  var b = findById_('Batches', p.batchId);
  if (!b) { throw new Error('Batch not found.'); }
  if (b.status === 'CLOSED') { throw new Error('Batch is closed.'); }
  var reason = req_(p.reason, 'Reason for change');
  var md = {};
  ['BMR', 'STP', 'SPEC', 'COA'].forEach(function (k) {
    var doc = p.ids && p.ids[k] ? findById_('DocMaster', p.ids[k]) : null;
    md[k] = doc ? { id: doc.id, number: doc.number, title: doc.title, url: doc.url } : null;
  });
  var old = masterSummary_(parseJson_(b.masterDocs, {}));
  b.masterDocs = JSON.stringify(md);
  update_('Batches', b);
  var key = b.productCode + '|' + customerKey_(b.customer);
  var prof = rows_('CustomerProfiles').filter(function (x) { return x.key === key; })[0];
  if (prof && p.remember !== false) {
    prof.bmrId = md.BMR ? md.BMR.id : ''; prof.stpId = md.STP ? md.STP.id : ''; prof.specId = md.SPEC ? md.SPEC.id : ''; prof.coaId = md.COA ? md.COA.id : '';
    prof.updatedAt = iso_(Date.now()); prof.updatedBy = user.name;
    update_('CustomerProfiles', prof);
  }
  audit_(user, 'MASTER_DOCS_CHANGED', 'Batch', b.id, b.batchNo, old, masterSummary_(md), reason, p.client);
  return md;
}

// ---------------------------------------------------------------------------
// Views / status
// ---------------------------------------------------------------------------

function docView_(d, versions, now) {
  var x = strip_(d);
  x.label = DOC_TYPES[d.type].label;
  x.overdue = '';
  if (d.status === 'PENDING_UPLOAD' && now > new Date(d.dueAt).getTime()) { x.overdue = 'UPLOAD'; }
  if (d.status === 'HARDCOPY_PENDING' && d.hardcopyDueAt && now > new Date(d.hardcopyDueAt).getTime()) { x.overdue = 'HARDCOPY'; }
  if (d.status === 'UNDER_VERIFICATION') {
    var v = null;
    Object.keys(versions).forEach(function (k) {
      var c = versions[k];
      if (c.docId === d.id && String(c.versionNo) === String(d.currentVersion)) { v = c; }
    });
    if (v) {
      x.verifyDueAt = v.verifyDueAt; x.currentVersionId = v.id; x.uploadedAt = v.uploadedAt; x.uploaderName = v.uploaderName;
      if (now > new Date(v.verifyDueAt).getTime()) { x.overdue = 'VERIFICATION'; }
    }
  }
  return x;
}

function batchView_(b, docs, now) {
  var x = strip_(b);
  x.masterDocs = parseJson_(b.masterDocs, {});
  x.docs = docs;
  x.overdue = docs.some(function (d) { return d.overdue; });
  return x;
}

function versionView_(v) {
  var x = strip_(v);
  x.files = parseJson_(v.files, []).map(function (f) { return { name: f.name, pages: f.pages, size: f.size, sha256: f.sha256 }; });
  x.checklist = parseJson_(v.checklist, {});
  return x;
}

function deriveBatchStatus_(docs) {
  var s = docs.map(function (d) { return d.status; });
  if (s.indexOf('REJECTED') >= 0) { return 'REJECTED_REUPLOAD'; }
  if (s.indexOf('PENDING_UPLOAD') >= 0) { return 'AWAITING_DOCUMENTS'; }
  if (s.indexOf('UNDER_VERIFICATION') >= 0) { return 'UNDER_VERIFICATION'; }
  if (s.every(function (x) { return x === 'HARDCOPY_RECEIVED'; })) { return 'READY_TO_CLOSE'; }
  return 'AWAITING_HARDCOPY';
}

function refreshBatchStatus_(b) {
  if (b.status === 'CLOSED') { return; }
  var docs = rows_('Documents').filter(function (d) { return d.batchId === b.id; });
  var s = deriveBatchStatus_(docs);
  if (s !== b.status) {
    var old = b.status;
    b.status = s;
    update_('Batches', b);
    audit_(null, 'BATCH_STATUS', 'Batch', b.id, b.batchNo, old, s, 'Automatic', '');
  }
}

// ---------------------------------------------------------------------------
// Working-time / deadline maths (IST, Sundays and holidays excluded)
// ---------------------------------------------------------------------------

function pad_(n) { return (n < 10 ? '0' : '') + n; }
function istParts_(ms) { return new Date(ms + IST_OFF); }
function istYmd_(ms) { var d = istParts_(ms); return d.getUTCFullYear() + '-' + pad_(d.getUTCMonth() + 1) + '-' + pad_(d.getUTCDate()); }
function istHour_(ms) { return istParts_(ms).getUTCHours(); }
function ymdToMs_(ymd, h, m, s) {
  var p = String(ymd).split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], h || 0, m || 0, s || 0) - IST_OFF;
}
function addDaysYmd_(ymd, n) { return istYmd_(ymdToMs_(ymd, 12) + n * DAY); }
function isWorkingDay_(ymd, hol) { return istParts_(ymdToMs_(ymd, 12)).getUTCDay() !== 0 && !hol[ymd]; }
function nextWorkingYmd_(ymd, hol) {
  for (var i = 0; i < 60 && !isWorkingDay_(ymd, hol); i++) { ymd = addDaysYmd_(ymd, 1); }
  return ymd;
}

/** Upload deadline: dispatch + N days at 23:59:59 IST, optionally moved off Sundays/holidays. */
function uploadDeadline_(dispatchYmd, hol) {
  var n = Number(setting_('UPLOAD_DAYS'));
  if (isNaN(n)) { n = 2; }
  var ymd;
  if (setting_('UPLOAD_DAYS_MODE') === 'WORKING') {
    return addWorkingDaysEnd_(dispatchYmd, n, hol);
  }
  ymd = addDaysYmd_(dispatchYmd, n);
  if (setting_('UPLOAD_SHIFT_NONWORKING') !== 'NO') { ymd = nextWorkingYmd_(ymd, hol); }
  return ymdToMs_(ymd, 23, 59, 59);
}

/** End (23:59:59 IST) of the Nth working day after the given date. */
function addWorkingDaysEnd_(ymd, n, hol) {
  var count = 0;
  for (var i = 0; i < 400 && count < n; i++) {
    ymd = addDaysYmd_(ymd, 1);
    if (isWorkingDay_(ymd, hol)) { count++; }
  }
  return ymdToMs_(ymd, 23, 59, 59);
}

/** Milliseconds between a and b that fall on working days. */
function workingMsBetween_(a, b, hol) {
  var total = 0, t = a;
  for (var i = 0; t < b && i < 2000; i++) {
    var ymd = istYmd_(t);
    var dayEnd = ymdToMs_(addDaysYmd_(ymd, 1), 0);
    var segEnd = Math.min(b, dayEnd);
    if (isWorkingDay_(ymd, hol)) { total += segEnd - t; }
    t = segEnd;
  }
  return total;
}

/** Point in time reached after adding `hours` of working time to `start`. */
function addWorkingHours_(start, hours, hol) {
  var remaining = hours * HOUR, t = start;
  for (var i = 0; i < 2000; i++) {
    var ymd = istYmd_(t);
    var dayEnd = ymdToMs_(addDaysYmd_(ymd, 1), 0);
    if (isWorkingDay_(ymd, hol)) {
      if (dayEnd - t >= remaining) { return t + remaining; }
      remaining -= dayEnd - t;
    }
    t = dayEnd;
  }
  return t;
}

function holidayMap_() {
  var m = {};
  rows_('Holidays').forEach(function (h) { m[h.date] = h.name || 'Holiday'; });
  return m;
}

function iso_(ms) {
  var d = istParts_(ms);
  return d.getUTCFullYear() + '-' + pad_(d.getUTCMonth() + 1) + '-' + pad_(d.getUTCDate()) + 'T' +
    pad_(d.getUTCHours()) + ':' + pad_(d.getUTCMinutes()) + ':' + pad_(d.getUTCSeconds()) + '+05:30';
}
function fmtDate_(ms) { var d = istParts_(ms); return pad_(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear(); }
function fmt_(ms) { var d = istParts_(ms); return fmtDate_(ms) + ' ' + pad_(d.getUTCHours()) + ':' + pad_(d.getUTCMinutes()); }
function hoursText_(ms) {
  var h = Math.round(ms / HOUR);
  return h >= 48 ? Math.floor(h / 24) + ' days ' + (h % 24) + ' h' : h + ' h';
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function deptEmails_(dept) {
  var list = splitEmails_(setting_('EMAIL_' + dept));
  rows_('Users').forEach(function (u) {
    if (u.role === dept && u.active === 'Y' && u.email) { list.push(u.email); }
  });
  return uniq_(list);
}

function splitEmails_(s) { return String(s || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean); }
function uniq_(a) { var o = {}; return a.filter(function (x) { x = String(x).toLowerCase(); if (!x || o[x]) { return false; } o[x] = 1; return true; }); }

function sentBefore_(key) {
  return rows_('ReminderLog').some(function (r) { return r.key === key && r.status === 'SENT'; });
}

/** Sends once per key (successful sends are never repeated; failures retry up to 3 times). */
function sendMail_(key, type, refId, batchNo, to, cc, subject, html) {
  var log = rows_('ReminderLog').filter(function (r) { return r.key === key; });
  if (log.some(function (r) { return r.status === 'SENT'; })) { return 'ALREADY_SENT'; }
  if (log.filter(function (r) { return r.status === 'FAILED'; }).length >= 3) { return 'GAVE_UP'; }
  to = uniq_(to || []);
  cc = uniq_(cc || []).filter(function (c) { return to.map(function (t) { return t.toLowerCase(); }).indexOf(c.toLowerCase()) < 0; });
  var entry = { id: newId_('R'), key: key, type: type, refId: refId, batchNo: batchNo, to: to.join(', '),
    cc: cc.join(', '), subject: subject, sentAt: iso_(Date.now()), status: 'SENT', error: '' };
  if (!to.length && !cc.length) {
    entry.status = 'SKIPPED'; entry.error = 'No recipient emails configured (Settings)';
    if (!log.some(function (r) { return r.status === 'SKIPPED'; })) { insert_('ReminderLog', entry); }
    return entry.status;
  }
  try {
    if (MailApp.getRemainingDailyQuota() < 1) { throw new Error('Daily email quota exhausted'); }
    var msg = { to: (to.length ? to : cc).join(','), subject: '[BDVS] ' + subject, htmlBody: html,
      name: 'BDVS - ' + (setting_('COMPANY_NAME') || 'QA') };
    if (to.length && cc.length) { msg.cc = cc.join(','); }
    MailApp.sendEmail(msg);
  } catch (e) {
    entry.status = 'FAILED'; entry.error = String(e && e.message ? e.message : e);
  }
  insert_('ReminderLog', entry);
  if (entry.status === 'FAILED' && type !== 'ADMIN_ALERT') {
    notifyAdmin_('BDVS email delivery failed', 'Could not send "' + subject + '" to ' + entry.to + ': ' + entry.error);
  }
  return entry.status;
}

function notifyAdmin_(subject, text) {
  var admin = splitEmails_(setting_('EMAIL_ADMIN'));
  if (!admin.length) { return; }
  sendMail_('ADMIN|' + subject + '|' + istYmd_(Date.now()) + '|' + istHour_(Date.now()), 'ADMIN_ALERT', '', '', admin, [],
    subject, mailBody_(subject, esc_(text), ''));
}

function docFacts_(b, d, now) {
  var rows = [
    ['Product', b.product], ['Batch No.', b.batchNo], ['Dispatch date', fmtDate_(ymdToMs_(b.dispatchDate, 12))],
    ['Invoice / challan', b.invoiceNo], ['Customer', b.customer], ['Document', DOC_TYPES[d.type].label]
  ];
  if (d.status === 'PENDING_UPLOAD' || d.status === 'REJECTED') {
    var due = new Date(d.dueAt).getTime();
    rows.push(['Upload deadline', fmt_(due) + (now > due ? ' (OVERDUE by ' + hoursText_(now - due) + ')' : ' (' + hoursText_(due - now) + ' left)')]);
  }
  if (d.status === 'HARDCOPY_PENDING' && d.hardcopyDueAt) { rows.push(['Hardcopy due', fmtDate_(new Date(d.hardcopyDueAt).getTime())]); }
  return '<table style="border-collapse:collapse;margin:14px 0" cellpadding="5">' + rows.map(function (r) {
    return '<tr><td style="color:#64748b;padding-right:16px">' + r[0] + '</td><td><b>' + esc_(r[1]) + '</b></td></tr>';
  }).join('') + '</table>';
}

function mailBody_(title, text, facts) {
  var url = setting_('APP_URL');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;max-width:640px">' +
    '<div style="background:#1e3a8a;color:#fff;padding:12px 16px;font-weight:bold">' + esc_(setting_('COMPANY_NAME') || '') +
    ' - Batch Document Verification</div><div style="padding:16px;border:1px solid #e2e8f0">' +
    '<h2 style="margin:0 0 10px;font-size:18px">' + esc_(title) + '</h2><p>' + text + '</p>' + (facts || '') +
    (url ? '<p><a href="' + url + '" style="background:#1e3a8a;color:#fff;padding:9px 16px;text-decoration:none;border-radius:6px">Open BDVS</a></p>' : '') +
    '<p style="color:#64748b;font-size:12px;margin-top:18px">Automatic message from BDVS. Times are IST. Do not reply.</p></div></div>';
}

// ---------------------------------------------------------------------------
// Users, passwords, sessions
// ---------------------------------------------------------------------------

function sessionUser_(token) {
  if (!token) { throw new Error('SESSION_EXPIRED'); }
  var cache = CacheService.getScriptCache();
  var uid = cache.get('sess_' + token);
  if (!uid) { throw new Error('SESSION_EXPIRED'); }
  var u = findById_('Users', uid);
  if (!u || u.active !== 'Y') { throw new Error('SESSION_EXPIRED'); }
  putSession_(token, uid); // sliding inactivity timeout
  return u;
}

function putSession_(token, uid) {
  var mins = Number(setting_('SESSION_TIMEOUT_MIN')) || 15;
  CacheService.getScriptCache().put('sess_' + token, uid, Math.min(21600, mins * 60));
}

function createUserRecord_(p, password, by) {
  var username = String(p.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) { throw new Error('Username: 3-30 letters, digits, dot, dash or underscore.'); }
  if (rows_('Users').some(function (u) { return String(u.username).toLowerCase() === username; })) {
    throw new Error('Username already exists (disabled users keep their username).');
  }
  if (ROLES.indexOf(p.role) < 0) { throw new Error('Choose a role.'); }
  var email = String(p.email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { throw new Error('Invalid email.'); }
  var u = { id: newId_('U'), name: req_(p.name, 'Full name'), username: username, email: email, role: p.role,
    active: 'Y', salt: '', pwHash: '', mustChange: 'Y', pwChangedAt: '', failed: '0', lockedUntil: '',
    createdAt: iso_(Date.now()), createdBy: by };
  setPassword_(u, password, true);
  insert_('Users', u);
  return u;
}

function setPassword_(u, pw, mustChange) {
  u.salt = Utilities.getUuid();
  u.pwHash = hashPw_(pw, u.salt);
  u.mustChange = mustChange ? 'Y' : 'N';
  u.pwChangedAt = iso_(Date.now());
}

function validatePassword_(pw, u) {
  pw = String(pw || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw new Error('Password must be at least 8 characters and contain letters and digits.');
  }
  if (u && pw.toLowerCase().indexOf(String(u.username).toLowerCase()) >= 0) { throw new Error('Password must not contain the username.'); }
}

function hashPw_(pw, salt) {
  var h = String(salt) + '|' + String(pw == null ? '' : pw);
  for (var i = 0; i < 200; i++) { h = sha256Hex_(h + '|' + salt); }
  return h;
}

function tempPassword_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  var digits = '23456789';
  var raw = Utilities.getUuid().replace(/-/g, '');
  var out = '';
  for (var i = 0; i < 8; i++) { out += chars.charAt(parseInt(raw.substr(i * 2, 2), 16) % chars.length); }
  return out + digits.charAt(parseInt(raw.substr(20, 2), 16) % digits.length) + digits.charAt(parseInt(raw.substr(22, 2), 16) % digits.length);
}

function publicUser_(u) {
  return { id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, active: u.active === 'Y',
    mustChange: u.mustChange === 'Y' };
}

// ---------------------------------------------------------------------------
// Audit trail (append-only, SHA-256 hash chained)
// ---------------------------------------------------------------------------

function audit_(user, action, objectType, objectId, batchNo, oldValue, newValue, reason, client) {
  var sh = sh_('AuditLog');
  var last = sh.getLastRow();
  var prevHash = '', seq = 1;
  if (last > 1) {
    var cols = SHEETS.AuditLog.length;
    var lastRow = sh.getRange(last, 1, 1, cols).getValues()[0];
    seq = Number(lastRow[0]) + 1;
    prevHash = String(lastRow[cols - 1]);
  }
  var e = { seq: String(seq), timestamp: iso_(Date.now()), userId: user ? user.id : 'SYSTEM',
    userName: user ? user.name : 'System', role: user ? user.role : 'SYSTEM', action: action,
    objectType: objectType || '', objectId: objectId || '', batchNo: batchNo || '',
    oldValue: clip_(oldValue), newValue: clip_(newValue), reason: clip_(reason), client: clip_(client), prevHash: prevHash, hash: '' };
  e.hash = auditHash_(e);
  insert_('AuditLog', e);
}

function auditHash_(e) {
  return sha256Hex_(SHEETS.AuditLog.slice(0, -1).map(function (k) { return String(e[k] == null ? '' : e[k]); }).join('␟'));
}

function verifyAuditChain_() {
  var rows = rows_('AuditLog');
  var prev = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.prevHash) !== prev) { return { ok: false, count: rows.length, badSeq: r.seq, reason: 'chain link broken (entry deleted or inserted)' }; }
    if (auditHash_(r) !== String(r.hash)) { return { ok: false, count: rows.length, badSeq: r.seq, reason: 'entry content altered' }; }
    prev = String(r.hash);
  }
  return { ok: true, count: rows.length };
}

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

function bytesToLatin1_(bytes, from, to) {
  var out = [], CH = 8192;
  for (var i = from; i < to; i += CH) {
    var part = bytes.slice(i, Math.min(to, i + CH)).map(function (x) { return x & 255; });
    out.push(String.fromCharCode.apply(null, part));
  }
  return out.join('');
}

function pdfLooksEncrypted_(bytes) {
  var start = Math.max(0, bytes.length - 65536);
  return /\/Encrypt\s/.test(bytesToLatin1_(bytes, start, bytes.length));
}

/** Best-effort page count (counts /Type /Page objects). Returns 0 if not determinable. */
function pdfPageCount_(bytes) {
  try {
    if (bytes.length > 30 * 1024 * 1024) { return 0; }
    var s = bytesToLatin1_(bytes, 0, bytes.length);
    if (/\/ObjStm/.test(s)) { return 0; } // compressed object streams: trust the browser count
    var m = s.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
    return m ? m.length : 0;
  } catch (e) { return 0; }
}

// ---------------------------------------------------------------------------
// Data layer (Google Sheets)
// ---------------------------------------------------------------------------

var CACHE_ = {};
function cacheReset_() { CACHE_ = {}; }

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SSID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sh_(name) {
  if (!CACHE_['sh_' + name]) {
    var s = ss_().getSheetByName(name);
    if (!s) { throw new Error('Sheet "' + name + '" is missing. Run BDVS > Initial setup in the spreadsheet.'); }
    CACHE_['sh_' + name] = s;
  }
  return CACHE_['sh_' + name];
}

function headers_(name) {
  if (!CACHE_['h_' + name]) {
    var s = sh_(name);
    CACHE_['h_' + name] = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String);
  }
  return CACHE_['h_' + name];
}

function rows_(name) {
  if (!CACHE_['r_' + name]) {
    var s = sh_(name);
    var last = s.getLastRow();
    var h = headers_(name);
    var vals = last > 1 ? s.getRange(2, 1, last - 1, h.length).getValues() : [];
    CACHE_['r_' + name] = vals.map(function (row, i) {
      var o = { _row: i + 2 };
      h.forEach(function (k, j) { o[k] = isDate_(row[j]) ? iso_(row[j].getTime()) : String(row[j]); });
      return o;
    });
  }
  return CACHE_['r_' + name];
}

function toRow_(name, obj) {
  return headers_(name).map(function (k) {
    var v = obj[k];
    if (v == null) { return ''; }
    if (typeof v === 'object') { return JSON.stringify(v); }
    return String(v);
  });
}

function insert_(name, obj) {
  var s = sh_(name);
  var row = toRow_(name, obj);
  var at = s.getLastRow() + 1;
  s.getRange(at, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  delete CACHE_['r_' + name];
  obj._row = at;
  return obj;
}

function update_(name, obj) {
  if (!obj._row) { throw new Error('update_ without row'); }
  var row = toRow_(name, obj);
  sh_(name).getRange(obj._row, 1, 1, row.length).setValues([row]);
  delete CACHE_['r_' + name];
  return obj;
}

function deleteRow_(name, obj) {
  if (name === 'AuditLog' || name === 'Versions' || name === 'Verifications' || name === 'Observations') {
    throw new Error('Records of this type can never be deleted.');
  }
  sh_(name).deleteRow(obj._row);
  delete CACHE_['r_' + name];
}

function findById_(name, id) {
  if (!id) { return null; }
  return rows_(name).filter(function (r) { return r.id === id; })[0] || null;
}

function setting_(key) {
  var r = rows_('Settings').filter(function (x) { return x.key === key; })[0];
  if (r) { return String(r.value); }
  return DEFAULT_SETTINGS[key] ? DEFAULT_SETTINGS[key][0] : '';
}

function setSetting_(key, value) {
  var r = rows_('Settings').filter(function (x) { return x.key === key; })[0];
  if (r) { r.value = value; update_('Settings', r); }
  else { insert_('Settings', { key: key, value: value, description: DEFAULT_SETTINGS[key] ? DEFAULT_SETTINGS[key][1] : '' }); }
}

function activeChecklist_(docType) {
  return rows_('Checklists').filter(function (c) { return c.docType === docType && c.active === 'Y'; })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (c) { return { id: c.id, item: c.item }; });
}

function docFolder_(b, d) {
  var root = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID'));
  var name = safeName_(b.batchNo + ' - ' + b.product);
  var it = root.getFoldersByName(name);
  var bf = it.hasNext() ? it.next() : root.createFolder(name);
  var it2 = bf.getFoldersByName(d.type);
  return it2.hasNext() ? it2.next() : bf.createFolder(d.type);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { throw new Error('The system is busy. Please try again.'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

function sha256Hex_(input) {
  var digest = typeof input === 'string'
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return digest.map(function (b) { return ((b & 255) + 256).toString(16).slice(1); }).join('');
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function newId_(prefix) { return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(); }
function req_(v, label) { v = String(v == null ? '' : v).trim(); if (!v) { throw new Error(label + ' is required.'); } return v; }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function safeName_(s) { return String(s || 'file').replace(/[\\/:*?"<>|#%\n\r\t]+/g, '_').slice(0, 120); }
function clip_(s) { s = s == null ? '' : String(s); return s.length > 45000 ? s.slice(0, 45000) + '...' : s; }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function parseJson_(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } }
function strip_(o) { var x = {}; Object.keys(o).forEach(function (k) { if (k !== '_row') { x[k] = o[k]; } }); return x; }
function groupBy_(arr, k) { var m = {}; arr.forEach(function (x) { (m[x[k]] = m[x[k]] || []).push(x); }); return m; }
function indexBy_(arr, k) { var m = {}; arr.forEach(function (x) { m[x[k]] = x; }); return m; }
