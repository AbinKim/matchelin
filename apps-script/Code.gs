/**
 * 맛슐랭 — 구글 시트 저장소 (Apps Script 웹앱)
 *
 * 설치:
 *  1) 새 구글 시트 → [확장 프로그램 → Apps Script] → 이 파일 내용을 Code.gs에 붙여넣고 저장
 *  2) 위쪽 함수 선택에서 setup 선택 → 실행 → 권한 허용 → [실행 로그]에 편집 토큰이 나온다
 *  3) [배포 → 새 배포 → 유형: 웹 앱], 실행 사용자: 나, 액세스 권한: 모든 사용자 → 배포 → 웹 앱 URL 복사
 *  4) 앱 설정 화면에 URL과 편집 토큰 입력 → 앱 설정에서 편집용/보기 전용 링크를 복사해 공유
 *
 * 토큰은 두 개다. 편집 토큰(TOKEN)은 읽기·쓰기, 보기 토큰(VIEW_TOKEN)은 읽기만.
 * 보기 전용 링크를 끊으려면 rotateViewToken, 편집 링크까지 모두 끊으려면 rotateAllTokens를 실행한다.
 *
 * 코드를 고친 뒤에는 [배포 → 배포 관리 → 수정 → 버전: 새 버전]으로 다시 배포해야 반영된다.
 * 시트에서 직접 행을 추가/수정해도 된다 (id 칸이 비어 있으면 다음 읽기 때 자동으로 채움).
 */
const SHEET_NAME = '맛집';
const HEADERS = ['id', 'name', 'rating', 'category', 'region', 'area', 'menu', 'years', 'closed',
  'lat', 'lng', 'address', 'placeId', 'approx', 'memo', 'createdAt', 'updatedAt'];
const NUMERIC = ['lat', 'lng'];

function setup() {
  const sh = getSheet_();
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#fde8ea');
  const head = headers_(sh);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['3', '2', '1', 'bib', 'wish'], true).setAllowInvalid(false).build();
  sh.getRange(2, head.indexOf('rating') + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', newToken_());
  if (!props.getProperty('VIEW_TOKEN')) props.setProperty('VIEW_TOKEN', newToken_());
  Logger.log('편집 토큰: ' + props.getProperty('TOKEN'));
  Logger.log('보기 토큰: ' + props.getProperty('VIEW_TOKEN') + '  (앱이 알아서 쓰니 따로 입력할 필요 없음)');
}

// 보기 전용 링크를 모두 끊는다. 편집용 링크는 그대로
function rotateViewToken() {
  PropertiesService.getScriptProperties().setProperty('VIEW_TOKEN', newToken_());
  Logger.log('보기 토큰을 바꿨어요. 앱 설정에서 보기 전용 링크를 다시 복사해 보내세요');
}

// 편집·보기 링크를 모두 끊는다. 새 편집 토큰을 내 앱 설정에 다시 넣어야 한다
function rotateAllTokens() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TOKEN', newToken_());
  props.setProperty('VIEW_TOKEN', newToken_());
  Logger.log('새 편집 토큰: ' + props.getProperty('TOKEN'));
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

// v(앱이 마지막으로 받은 버전)가 지금 버전과 같으면 목록 없이 unchanged만 돌려준다 — 20초마다 확인해도 가볍게
// role: 'edit' | 'view'. 편집 토큰으로 읽으면 보기 토큰도 알려 줘서 앱이 보기 전용 링크를 만들 수 있게 한다
function doGet(e) {
  const role = role_(e.parameter.token);
  if (!role) return out_({ ok: false, error: 'unauthorized' });
  const meta = { ok: true, role: role, version: getVersion_() };
  if (role === 'edit') meta.viewToken = PropertiesService.getScriptProperties().getProperty('VIEW_TOKEN') || '';
  if (e.parameter.v && e.parameter.v === meta.version) { meta.unchanged = true; return out_(meta); }
  meta.places = readAll_(getSheet_());
  return out_(meta);
}

// 시트에서 직접 수정해도 버전을 올려 앱들이 새로 받아 가게 한다 (단순 트리거라 따로 설정할 것 없음)
function onEdit() {
  bumpVersion_();
}

function getVersion_() {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty('VERSION');
  if (!v) { v = String(Date.now()); props.setProperty('VERSION', v); }
  return v;
}

function bumpVersion_() {
  PropertiesService.getScriptProperties().setProperty('VERSION', String(Date.now()));
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  const role = role_(body.token);
  if (!role) return out_({ ok: false, error: 'unauthorized' });
  if (role !== 'edit') return out_({ ok: false, error: 'read only' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_();
    if (body.action === 'upsert') upsert_(sh, body.places || []);
    else if (body.action === 'delete') remove_(sh, body.ids || []);
    else return out_({ ok: false, error: 'unknown action' });
    bumpVersion_();
    return out_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function role_(token) {
  if (!token) return null;
  const props = PropertiesService.getScriptProperties();
  if (token === props.getProperty('TOKEN')) return 'edit';
  if (token === props.getProperty('VIEW_TOKEN')) return 'view';
  return null;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

// 시트의 실제 헤더 순서를 따른다. 빠진 열은 오른쪽에 추가 (열 순서를 바꾸거나 새 필드가 생겨도 안전)
function headers_(sh) {
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  const missing = HEADERS.filter(h => head.indexOf(h) < 0);
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
    return head.concat(missing);
  }
  return head;
}

function formats_(head) {
  return head.map(h => NUMERIC.indexOf(h) >= 0 ? '0.000000' : (h === 'closed' ? 'General' : '@'));
}

function toCell_(h, v) {
  if (NUMERIC.indexOf(h) >= 0) return v === null || v === undefined || v === '' ? '' : Number(v);
  if (h === 'closed') return v === true || String(v).toUpperCase() === 'TRUE';
  return v === null || v === undefined ? '' : String(v);
}

function readAll_(sh) {
  const head = headers_(sh);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, head.length).getValues();
  const idCol = head.indexOf('id');
  const places = [];
  rows.forEach((row, i) => {
    const p = {};
    head.forEach((h, j) => { if (h) p[h] = row[j]; });
    if (!p.name) return;
    if (!p.id) {  // 시트에서 직접 추가한 행 — 버전은 그대로 둬서 다른 기기가 같은 id를 받게 한다
      p.id = 'p_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
      sh.getRange(i + 2, idCol + 1).setValue(p.id);
    }
    HEADERS.forEach(h => {
      if (NUMERIC.indexOf(h) >= 0) p[h] = p[h] === '' || p[h] === undefined ? null : Number(p[h]);
      else if (h === 'closed') p[h] = p[h] === true || String(p[h]).toUpperCase() === 'TRUE';
      else p[h] = p[h] === undefined ? '' : String(p[h]);
    });
    places.push(p);
  });
  return places;
}

function upsert_(sh, places) {
  const head = headers_(sh);
  const fmts = formats_(head);
  const idCol = head.indexOf('id');
  const last = sh.getLastRow();
  const ids = last < 2 ? [] : sh.getRange(2, idCol + 1, last - 1, 1).getValues().map(r => String(r[0]));
  const appends = [];
  places.forEach(p => {
    const row = head.map(h => toCell_(h, p[h]));
    const i = ids.indexOf(String(p.id));
    if (i >= 0) {
      sh.getRange(i + 2, 1, 1, head.length).setNumberFormats([fmts]).setValues([row]);
    } else {
      appends.push(row);
      ids.push(String(p.id));
    }
  });
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, head.length)
      .setNumberFormats(appends.map(() => fmts)).setValues(appends);
  }
}

function remove_(sh, ids) {
  const head = headers_(sh);
  const last = sh.getLastRow();
  if (last < 2) return;
  const col = sh.getRange(2, head.indexOf('id') + 1, last - 1, 1).getValues().map(r => String(r[0]));
  const rows = [];
  col.forEach((id, i) => { if (ids.indexOf(id) >= 0) rows.push(i + 2); });
  rows.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}
