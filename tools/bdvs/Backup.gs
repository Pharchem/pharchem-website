/**
 * BDVS - weekly backup (Backup.gs)
 *
 * Every Sunday at 02:00 IST (and on demand):
 *  1. Copies the whole BDVS spreadsheet into the Drive folder "BDVS Backups (do not edit)"
 *     and keeps the last BACKUP_KEEP weekly copies.
 *  2. Mirrors the scans folder into the backup folder, incrementally: scans are read-only,
 *     so only files not yet in the backup are copied.
 *  3. Verifies the backup: row counts of the key sheets in the copy, and a spot check that
 *     backed-up scan files still match the SHA-256 recorded at upload.
 *  4. Logs the run (BackupLog sheet) and emails the admin and QA the result. Any problem
 *     makes the subject line say PROBLEM.
 *
 * Give a second Google account read access by setting BACKUP_SHARE_WITH in Settings.
 * Restore steps are in README.md ("Backup and restore").
 */

var SHEETS = (typeof SHEETS !== 'undefined' && SHEETS) || {};
var DEFAULT_SETTINGS = (typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS) || {};
var ACTIONS = (typeof ACTIONS !== 'undefined' && ACTIONS) || {};

SHEETS.BackupLog = ['id', 'runAt', 'status', 'sheetCopy', 'filesTotal', 'filesCopied', 'hashChecked', 'hashOk',
  'rowCheck', 'errors', 'durationSec', 'startedBy'];

DEFAULT_SETTINGS.BACKUP_KEEP = ['8', 'Weekly spreadsheet copies kept in the backup folder (older ones are trashed)'];
DEFAULT_SETTINGS.BACKUP_SHARE_WITH = ['', 'Google account given read access to the backup folder (e.g. a second company account)'];

ACTIONS.backupStatus = { roles: ['QA', 'ADMIN'], fn: function () { return rows_('BackupLog').slice(-12).reverse().map(strip_); } };
ACTIONS.runBackupNow = { roles: ['ADMIN'], fn: function (u) { return doBackup_('manual: ' + u.name); }, write: true };

/** Timer entry point (weekly). */
function runWeeklyBackup() {
  cacheReset_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { return; }
  try { doBackup_('weekly timer'); } finally { lock.releaseLock(); }
}

function backupRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var f = DriveApp.createFolder('BDVS Backups (do not edit)');
  props.setProperty('BACKUP_FOLDER_ID', f.getId());
  return f;
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function doBackup_(who) {
  var start = Date.now();
  var props = PropertiesService.getScriptProperties();
  var errors = [];
  var root = backupRoot_();

  // Share the backup folder once with the second account, if configured.
  var share = setting_('BACKUP_SHARE_WITH');
  if (share && props.getProperty('BACKUP_SHARED_WITH') !== share) {
    try { root.addViewer(share); props.setProperty('BACKUP_SHARED_WITH', share); }
    catch (e) { errors.push('Could not share the backup folder with ' + share + ': ' + String(e.message || e)); }
  }

  // 1. Full copy of the spreadsheet.
  var sheetCopyName = '';
  var rowCheck = 'NOT CHECKED';
  try {
    var ssId = props.getProperty('SSID') || ss_().getId();
    var d = istParts_(start);
    var copy = DriveApp.getFileById(ssId).makeCopy(
      'BDVS data ' + istYmd_(start) + ' ' + pad_(d.getUTCHours()) + pad_(d.getUTCMinutes()), root);
    sheetCopyName = copy.getName();
    try {
      var copySs = SpreadsheetApp.openById(copy.getId());
      var live = ss_();
      var bad = [];
      ['Batches', 'Documents', 'Versions', 'Verifications', 'AuditLog', 'Users'].forEach(function (n) {
        var a = live.getSheetByName(n), b = copySs.getSheetByName(n);
        if (!a || !b || a.getLastRow() !== b.getLastRow()) { bad.push(n); }
      });
      rowCheck = bad.length ? 'MISMATCH: ' + bad.join(', ') : 'OK';
      if (bad.length) { errors.push('Row counts differ in the sheet copy: ' + bad.join(', ')); }
    } catch (e) { rowCheck = 'NOT CHECKED (' + String(e.message || e) + ')'; }
    // Keep only the newest BACKUP_KEEP copies.
    var keep = Number(setting_('BACKUP_KEEP')) || 8;
    var copies = [];
    var it = root.getFiles();
    while (it.hasNext()) { var f = it.next(); if (/^BDVS data /.test(f.getName())) { copies.push(f); } }
    copies.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
    copies.slice(keep).forEach(function (old) { try { old.setTrashed(true); } catch (e) { /* ignore */ } });
  } catch (e) { errors.push('Spreadsheet copy failed: ' + String(e.message || e)); }

  // 2. Incremental mirror of the scans folder.
  var total = 0, copied = 0, partial = false;
  var backupFiles = [];
  try {
    var srcId = props.getProperty('ROOT_FOLDER_ID');
    if (srcId) {
      var res = mirrorFolder_(DriveApp.getFolderById(srcId), childFolder_(root, 'scans'), start, backupFiles);
      total = res.total; copied = res.copied; partial = res.partial;
    }
  } catch (e) { errors.push('Scan copy failed: ' + String(e.message || e)); }

  // 3. Spot check: backed-up files still match the SHA-256 recorded at upload.
  var hashMap = {};
  rows_('Versions').forEach(function (v) { parseJson_(v.files, []).forEach(function (f) { hashMap[f.name] = f.sha256; }); });
  var checked = 0, hashOk = 0;
  for (var i = 0; i < backupFiles.length && checked < 5; i++) {
    var bf = backupFiles[i];
    var want = hashMap[bf.getName()];
    if (!want) { continue; }
    checked++;
    try { if (sha256Hex_(bf.getBlob().getBytes()) === want) { hashOk++; } } catch (e) { /* counts as failed */ }
  }
  if (checked && hashOk < checked) { errors.push('HASH MISMATCH in backup copies (' + hashOk + ' of ' + checked + ' correct)'); }

  var status = errors.length ? 'PROBLEM' : (partial ? 'PARTIAL' : 'SUCCESS');
  if (partial && !errors.length) {
    // Ran out of execution time (first run on a large folder): continue in 10 minutes.
    try { ScriptApp.newTrigger('runWeeklyBackup').timeBased().after(10 * 60 * 1000).create(); } catch (e) { /* weekly run continues it */ }
  }
  var log = insert_('BackupLog', { id: newId_('BK'), runAt: iso_(start), status: status, sheetCopy: sheetCopyName,
    filesTotal: String(total), filesCopied: String(copied), hashChecked: String(checked), hashOk: String(hashOk),
    rowCheck: rowCheck, errors: errors.join('; '), durationSec: String(Math.round((Date.now() - start) / 1000)),
    startedBy: who });
  audit_(null, 'BACKUP_RUN', 'Backup', log.id, '', '', status + ': sheet copy ' + (sheetCopyName || 'FAILED') + '; ' +
    copied + ' new scan file(s) of ' + total + '; row check ' + rowCheck +
    (checked ? '; hash check ' + hashOk + '/' + checked : ''), who, '');

  var to = uniq_(splitEmails_(setting_('EMAIL_ADMIN')).concat(deptEmails_('QA')));
  sendMail_('BACKUP|' + log.id, 'BACKUP', log.id, '', to, [],
    'BDVS backup ' + status + ' - ' + fmtDate_(start),
    mailBody_('Weekly backup ' + status,
      'Spreadsheet copy: <b>' + esc_(sheetCopyName || 'FAILED') + '</b> (row check: ' + esc_(rowCheck) + ').<br>' +
      'Scan files: ' + copied + ' newly copied, ' + total + ' in total' +
      (checked ? '; SHA-256 spot check ' + hashOk + ' / ' + checked + ' correct' : '') + '.' +
      (partial ? '<br><b>The run hit the time limit and will continue automatically.</b>' : '') +
      (errors.length ? '<p style="color:#b91c1c"><b>Problems:</b><br>' + errors.map(esc_).join('<br>') + '</p>' : '') +
      '<p>Backups live in the Drive folder "BDVS Backups (do not edit)". Restore steps: see the BDVS setup guide.</p>', ''));
  return strip_(log);
}

/** Copies every file missing from the backup, keeping the folder structure. Stops near the execution time limit. */
function mirrorFolder_(src, dst, startMs, collect) {
  var total = 0, copied = 0, partial = false;
  (function walk(s, d, depth) {
    if (depth > 5 || partial) { return; }
    var existing = {};
    var bit = d.getFiles();
    while (bit.hasNext()) { var bf = bit.next(); existing[bf.getName()] = bf; }
    var fit = s.getFiles();
    while (fit.hasNext()) {
      var f = fit.next();
      total++;
      if (existing[f.getName()]) { collect.push(existing[f.getName()]); continue; }
      if (Date.now() - startMs > 240000) { partial = true; return; }
      try { collect.push(f.makeCopy(f.getName(), d)); copied++; }
      catch (e) { partial = true; return; }
    }
    var sub = s.getFolders();
    while (sub.hasNext() && !partial) {
      var sf = sub.next();
      walk(sf, childFolder_(d, sf.getName()), depth + 1);
    }
  })(src, dst, 0);
  return { total: total, copied: copied, partial: partial };
}
