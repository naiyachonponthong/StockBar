/**
 * ============================================================
 *  STOCKBAR — ระบบสต๊อกสินค้า รองรับเครื่องยิงบาร์โค้ด
 *  Google Apps Script + Google Sheets
 *  สถาปัตยกรรม: JSON-per-row, ledger-based, session auth
 * ============================================================
 */

var CONFIG = {
  APP_NAME: 'StockBar',
  APP_SUB: 'ระบบสต๊อกสินค้า',
  // ไอดีโฟลเดอร์ Drive สำหรับเก็บรูปสินค้า/โลโก้
  // ปกติตั้งค่าได้จากหน้า "ตั้งค่า" ในแอปเลย ไม่ต้องแก้ตรงนี้ (ใช้ค่านี้เป็น fallback เท่านั้น)
  FOLDER_ID: '',
  // LINE Login Channel ID ของ LIFF app (ใช้ตรวจ idToken ตอนล็อกอินอัตโนมัติ)
  // ปกติตั้งค่าได้จากหน้า "ตั้งค่า" ในแอปเลย ไม่ต้องแก้ตรงนี้ (ใช้ค่านี้เป็น fallback เท่านั้น)
  LINE_CHANNEL_ID: '',
  SESSION_HOURS: 12,
  EXPIRY_WARN_DAYS: 30,
  ADMIN_USERS: [
    { username: 'admin', password: 'admin1234', name: 'ผู้ดูแลระบบ', role: 'admin' }
  ],
  USER_ROLES: {
    admin: 'ผู้ดูแลระบบ',
    manager: 'หัวหน้าคลัง',
    staff: 'เจ้าหน้าที่สต๊อก',
    viewer: 'ดูอย่างเดียว'
  }
};

var SHEETS = {
  Users: 'users_json',
  Sessions: 'sessions_json',
  Products: 'products_json',
  Barcodes: 'barcodes_json',
  Categories: 'categories_json',
  Locations: 'locations_json',
  Suppliers: 'suppliers_json',
  Movements: 'movements_json',
  Balances: 'balances_json',
  Lots: 'lots_json',
  Serials: 'serials_json',
  DocPO: 'docpo_json',
  DocIn: 'docin_json',
  DocOut: 'docout_json',
  DocTransfer: 'doctransfer_json',
  DocCount: 'doccount_json',
  DocAdjust: 'docadjust_json',
  Settings: 'settings_json',
  Logs: 'logs_json'
};

/* ================= WEB ENTRY ================= */

function doGet(e) {
  initializeSheets();
  // JSONP API สำหรับหน้ามือถือ LIFF ที่โฮสต์บน GitHub Pages
  if (e && e.parameter && e.parameter.api) return apiGateway_(e);
  var t = HtmlService.createTemplateFromFile('index');
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — ' + CONFIG.APP_SUB)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ================= LOW LEVEL STORE ================= */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.getRange(1, 1).setValue(SHEETS[name]);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 900);
  }
  return sh;
}

function readAll_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var raw = vals[i][0];
    if (!raw) continue;
    try {
      var o = JSON.parse(raw);
      o.__row = i + 2;
      out.push(o);
    } catch (err) { /* ข้ามแถวเสีย */ }
  }
  return out;
}

function insert_(name, obj) {
  if (!obj.id) obj.id = Utilities.getUuid();
  if (!obj.createdAt) obj.createdAt = nowIso_();
  var sh = sheet_(name);
  sh.appendRow([JSON.stringify(obj)]);
  return obj;
}

function insertMany_(name, arr) {
  if (!arr.length) return [];
  var sh = sheet_(name);
  var rows = arr.map(function (o) {
    if (!o.id) o.id = Utilities.getUuid();
    if (!o.createdAt) o.createdAt = nowIso_();
    return [JSON.stringify(o)];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
  return arr;
}

function update_(name, id, patch) {
  var all = readAll_(name);
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) {
      var merged = all[i];
      for (var k in patch) merged[k] = patch[k];
      merged.updatedAt = nowIso_();
      var row = merged.__row;
      delete merged.__row;
      sheet_(name).getRange(row, 1).setValue(JSON.stringify(merged));
      merged.__row = row;
      return merged;
    }
  }
  return null;
}

function remove_(name, id) {
  var all = readAll_(name);
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) {
      sheet_(name).deleteRow(all[i].__row);
      return true;
    }
  }
  return false;
}

function findById_(name, id) {
  var all = readAll_(name);
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function nowIso_() { return new Date().toISOString(); }

function ok_(message, data) {
  var r = { status: 'success', message: message || 'สำเร็จ' };
  if (data !== undefined) r.data = data;
  return r;
}

function err_(message) { return { status: 'error', message: message || 'เกิดข้อผิดพลาด' }; }

function num_(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

/* ================= INIT ================= */

function initializeSheets() {
  var s = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = s.getSheetByName(name);
    if (!sh) {
      sh = s.insertSheet(name);
      sh.getRange(1, 1).setValue(SHEETS[name]);
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 900);
    } else if (String(sh.getRange(1, 1).getValue()).trim() === '') {
      sh.getRange(1, 1).setValue(SHEETS[name]);
    }
  });

  // seed users
  if (readAll_('Users').length === 0) {
    CONFIG.ADMIN_USERS.forEach(function (u) {
      insert_('Users', {
        username: u.username,
        name: u.name,
        role: u.role,
        salt: 'seed',
        hash: hash_(u.password, 'seed'),
        active: true
      });
    });
  }
  migrateOldUsers();

  // seed settings
  if (readAll_('Settings').length === 0) {
    insert_('Settings', {
      key: 'main',
      orgName: 'ชื่อหน่วยงาน / ร้านของคุณ',
      logoUrl: '',
      costMethod: 'average',
      allowNegative: false,
      lineToken: '',
      notifyEmail: '',
      labelWidth: 50,
      labelHeight: 25,
      docPrefix: { IN: 'IN', OUT: 'OUT', TR: 'TR', CT: 'CT', AD: 'AD' }
    });
  }

  // seed default location
  if (readAll_('Locations').length === 0) {
    insert_('Locations', { code: 'MAIN', name: 'คลังหลัก', address: '', active: true });
  }
  if (readAll_('Categories').length === 0) {
    insert_('Categories', { code: 'GEN', name: 'ทั่วไป', active: true });
  }
  return true;
}

function migrateOldUsers() {
  var users = readAll_('Users');
  users.forEach(function (u) {
    if (!u.hash && u.password) {
      update_('Users', u.id, { salt: 'seed', hash: hash_(u.password, 'seed'), password: '' });
    }
    if (u.active === undefined) update_('Users', u.id, { active: true });
  });
}

/* ================= AUTH ================= */

function hash_(pw, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(salt) + '::' + String(pw), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function apiLogin(username, password) {
  try {
    initializeSheets();
    var users = readAll_('Users');
    var u = null;
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].username).toLowerCase() === String(username || '').toLowerCase()) u = users[i];
    }
    if (!u) return err_('ไม่พบชื่อผู้ใช้นี้');
    if (u.active === false) return err_('บัญชีนี้ถูกปิดใช้งาน');
    if (hash_(password, u.salt) !== u.hash) return err_('รหัสผ่านไม่ถูกต้อง');

    var token = Utilities.getUuid();
    var exp = new Date(Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000).toISOString();
    insert_('Sessions', { token: token, userId: u.id, expireAt: exp });
    cleanSessions_();
    log_(u.id, 'login', 'เข้าสู่ระบบ');
    return ok_('เข้าสู่ระบบสำเร็จ', {
      token: token,
      user: { id: u.id, username: u.username, name: u.name, role: u.role }
    });
  } catch (e) { return err_(e.message); }
}

function apiLogout(token) {
  try {
    var ses = readAll_('Sessions');
    for (var i = 0; i < ses.length; i++) if (ses[i].token === token) remove_('Sessions', ses[i].id);
    return ok_('ออกจากระบบแล้ว');
  } catch (e) { return err_(e.message); }
}

function cleanSessions_() {
  var now = new Date().toISOString();
  var ses = readAll_('Sessions');
  for (var i = ses.length - 1; i >= 0; i--) {
    if (ses[i].expireAt < now) remove_('Sessions', ses[i].id);
  }
}

function auth_(token, roles) {
  var ses = readAll_('Sessions');
  var found = null;
  for (var i = 0; i < ses.length; i++) if (ses[i].token === token) found = ses[i];
  if (!found) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (found.expireAt < new Date().toISOString()) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  var u = findById_('Users', found.userId);
  if (!u) throw new Error('ไม่พบผู้ใช้');
  if (roles && roles.length && roles.indexOf(u.role) === -1) throw new Error('คุณไม่มีสิทธิ์ใช้งานส่วนนี้');
  return u;
}

function apiMe(token) {
  try {
    var u = auth_(token);
    return ok_('ok', { id: u.id, username: u.username, name: u.name, role: u.role });
  } catch (e) { return err_(e.message); }
}

function apiChangePassword(token, oldPw, newPw) {
  try {
    var u = auth_(token);
    if (hash_(oldPw, u.salt) !== u.hash) return err_('รหัสผ่านเดิมไม่ถูกต้อง');
    if (!newPw || newPw.length < 6) return err_('รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัว');
    var salt = Utilities.getUuid().slice(0, 8);
    update_('Users', u.id, { salt: salt, hash: hash_(newPw, salt) });
    return ok_('เปลี่ยนรหัสผ่านแล้ว');
  } catch (e) { return err_(e.message); }
}

function log_(userId, action, detail) {
  try {
    insert_('Logs', { userId: userId, action: action, detail: detail, ts: nowIso_() });
  } catch (e) { }
}

/* ================= BOOTSTRAP (โหลดข้อมูลตั้งต้นทีเดียว) ================= */

function apiBootstrap(token) {
  try {
    var u = auth_(token);
    var settings = readAll_('Settings')[0] || {};
    return ok_('ok', {
      user: { id: u.id, username: u.username, name: u.name, role: u.role },
      roles: CONFIG.USER_ROLES,
      settings: settings,
      categories: readAll_('Categories'),
      locations: readAll_('Locations'),
      suppliers: readAll_('Suppliers')
    });
  } catch (e) { return err_(e.message); }
}

/* ================= MASTER DATA ================= */

function apiListProducts(token) {
  try {
    auth_(token);
    var prods = readAll_('Products');
    var bcs = readAll_('Barcodes');
    var bal = balanceMap_();
    var bcByProd = {};
    bcs.forEach(function (b) {
      if (!bcByProd[b.productId]) bcByProd[b.productId] = [];
      bcByProd[b.productId].push(b);
    });
    prods.forEach(function (p) {
      p.barcodes = bcByProd[p.id] || [];
      var total = 0;
      var perLoc = {};
      for (var k in bal) {
        var parts = k.split('|');
        if (parts[0] === p.id) { total += bal[k]; perLoc[parts[1]] = bal[k]; }
      }
      p.qty = total;
      p.qtyByLoc = perLoc;
      p.value = total * num_(p.avgCost);
    });
    return ok_('ok', prods);
  } catch (e) { return err_(e.message); }
}

function apiSaveProduct(token, data) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    lock.waitLock(20000);
    if (!data.name) return err_('กรุณากรอกชื่อสินค้า');
    var prods = readAll_('Products');
    // เช็ครหัสซ้ำ
    for (var i = 0; i < prods.length; i++) {
      if (data.code && prods[i].code === data.code && prods[i].id !== data.id) {
        return err_('รหัสสินค้า ' + data.code + ' ถูกใช้แล้ว');
      }
    }
    var payload = {
      code: data.code || autoProductCode_(prods),
      name: data.name,
      categoryId: data.categoryId || '',
      unit: data.unit || 'ชิ้น',
      trackLot: !!data.trackLot,
      trackSerial: !!data.trackSerial,
      shelfLifeDays: num_(data.shelfLifeDays),
      minQty: num_(data.minQty),
      maxQty: num_(data.maxQty),
      salePrice: num_(data.salePrice),
      avgCost: num_(data.avgCost),
      imageUrl: data.imageUrl || '',
      note: data.note || '',
      active: data.active !== false
    };
    var saved;
    if (data.id) {
      saved = update_('Products', data.id, payload);
      if (!saved) return err_('ไม่พบสินค้า');
    } else {
      saved = insert_('Products', payload);
      // บาร์โค้ดแรกที่แนบมาตอนสร้าง
      if (data.barcode) {
        var dup = findBarcode_(data.barcode);
        if (!dup) {
          insert_('Barcodes', {
            barcode: String(data.barcode).trim(),
            productId: saved.id,
            unit: payload.unit,
            perUnit: 1,
            isPrimary: true
          });
        }
      }
    }
    log_(u.id, 'product', 'บันทึกสินค้า ' + payload.name);
    return ok_('บันทึกสินค้าแล้ว', saved);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function autoProductCode_(prods) {
  var max = 0;
  prods.forEach(function (p) {
    var m = String(p.code || '').match(/^P(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'P' + ('0000' + (max + 1)).slice(-5);
}

function apiDeleteProduct(token, id) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager']);
    lock.waitLock(20000);
    var mv = readAll_('Movements');
    for (var i = 0; i < mv.length; i++) {
      if (mv[i].productId === id) return err_('ลบไม่ได้ — สินค้านี้มีประวัติการเคลื่อนไหวแล้ว ให้ปิดใช้งานแทน');
    }
    var bcs = readAll_('Barcodes');
    bcs.forEach(function (b) { if (b.productId === id) remove_('Barcodes', b.id); });
    remove_('Products', id);
    log_(u.id, 'product', 'ลบสินค้า ' + id);
    return ok_('ลบสินค้าแล้ว');
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function findBarcode_(code) {
  var c = String(code || '').trim();
  var bcs = readAll_('Barcodes');
  for (var i = 0; i < bcs.length; i++) if (String(bcs[i].barcode).trim() === c) return bcs[i];
  return null;
}

function apiListBarcodes(token) {
  try {
    auth_(token);
    return ok_('ok', readAll_('Barcodes'));
  } catch (e) { return err_(e.message); }
}

function apiSaveBarcode(token, data) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    lock.waitLock(20000);
    var code = String(data.barcode || '').trim();
    if (!code) return err_('กรุณากรอก/ยิงบาร์โค้ด');
    if (!data.productId) return err_('กรุณาเลือกสินค้า');
    var dup = findBarcode_(code);
    if (dup && dup.id !== data.id) return err_('บาร์โค้ดนี้ผูกกับสินค้าอื่นแล้ว');
    var payload = {
      barcode: code,
      productId: data.productId,
      unit: data.unit || 'ชิ้น',
      perUnit: num_(data.perUnit) || 1,
      isPrimary: !!data.isPrimary
    };
    var saved = data.id ? update_('Barcodes', data.id, payload) : insert_('Barcodes', payload);
    log_(u.id, 'barcode', 'บันทึกบาร์โค้ด ' + code);
    return ok_('บันทึกบาร์โค้ดแล้ว', saved);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function apiDeleteBarcode(token, id) {
  try {
    auth_(token, ['admin', 'manager']);
    remove_('Barcodes', id);
    return ok_('ลบบาร์โค้ดแล้ว');
  } catch (e) { return err_(e.message); }
}

/** สร้าง index บาร์โค้ดทั้งหมดให้ฝั่งเว็บ cache ไว้ ยิงแล้วหาเจอทันทีไม่ต้องวิ่ง server */
function apiScanIndex(token) {
  try {
    auth_(token);
    var prods = readAll_('Products');
    var pm = {};
    prods.forEach(function (p) {
      pm[p.id] = {
        id: p.id, code: p.code, name: p.name, unit: p.unit,
        salePrice: num_(p.salePrice), avgCost: num_(p.avgCost),
        trackLot: !!p.trackLot, trackSerial: !!p.trackSerial,
        shelfLifeDays: num_(p.shelfLifeDays)
      };
    });
    var idx = {};
    readAll_('Barcodes').forEach(function (b) {
      var p = pm[b.productId];
      if (!p) return;
      idx[String(b.barcode).trim()] = {
        productId: p.id, code: p.code, name: p.name,
        unit: b.unit || p.unit, perUnit: num_(b.perUnit) || 1,
        salePrice: p.salePrice, avgCost: p.avgCost,
        trackLot: p.trackLot, trackSerial: p.trackSerial, shelfLifeDays: p.shelfLifeDays
      };
    });
    // ให้ยิงด้วย "รหัสสินค้า" ได้ด้วย เผื่อสินค้าไม่มีบาร์โค้ด
    prods.forEach(function (p) {
      if (p.code && !idx[p.code]) {
        idx[p.code] = {
          productId: p.id, code: p.code, name: p.name,
          unit: p.unit, perUnit: 1, salePrice: num_(p.salePrice), avgCost: num_(p.avgCost),
          trackLot: !!p.trackLot, trackSerial: !!p.trackSerial, shelfLifeDays: num_(p.shelfLifeDays)
        };
      }
    });
    var lots = readAll_('Lots').filter(function (l) { return num_(l.qty) > 0; })
      .map(function (l) {
        return {
          id: l.id, productId: l.productId, lotNo: l.lotNo, expiryDate: l.expiryDate || '',
          locationId: l.locationId, qty: num_(l.qty), unitCost: num_(l.unitCost), receivedAt: l.receivedAt
        };
      });
    return ok_('ok', { index: idx, balances: balanceMap_(), lots: lots });
  } catch (e) { return err_(e.message); }
}

/* ---- Categories / Locations / Suppliers (รูปแบบเดียวกัน) ---- */

function apiSaveCategory(token, d) {
  try {
    var u = auth_(token, ['admin', 'manager']);
    if (!d.name) return err_('กรุณากรอกชื่อหมวด');
    var p = { code: d.code || '', name: d.name, active: d.active !== false };
    var s = d.id ? update_('Categories', d.id, p) : insert_('Categories', p);
    return ok_('บันทึกหมวดแล้ว', s);
  } catch (e) { return err_(e.message); }
}
function apiDeleteCategory(token, id) {
  try { auth_(token, ['admin', 'manager']); remove_('Categories', id); return ok_('ลบแล้ว'); }
  catch (e) { return err_(e.message); }
}
function apiListCategories(token) {
  try { auth_(token); return ok_('ok', readAll_('Categories')); } catch (e) { return err_(e.message); }
}

function apiSaveLocation(token, d) {
  try {
    auth_(token, ['admin', 'manager']);
    if (!d.name) return err_('กรุณากรอกชื่อคลัง');
    var p = { code: d.code || '', name: d.name, address: d.address || '', active: d.active !== false };
    var s = d.id ? update_('Locations', d.id, p) : insert_('Locations', p);
    return ok_('บันทึกคลังแล้ว', s);
  } catch (e) { return err_(e.message); }
}
function apiDeleteLocation(token, id) {
  try {
    auth_(token, ['admin', 'manager']);
    var bal = balanceMap_();
    for (var k in bal) { if (k.split('|')[1] === id && bal[k] !== 0) return err_('ลบไม่ได้ — คลังนี้ยังมีสินค้าคงเหลือ'); }
    remove_('Locations', id); return ok_('ลบแล้ว');
  } catch (e) { return err_(e.message); }
}
function apiListLocations(token) {
  try { auth_(token); return ok_('ok', readAll_('Locations')); } catch (e) { return err_(e.message); }
}

function apiSaveSupplier(token, d) {
  try {
    auth_(token, ['admin', 'manager', 'staff']);
    if (!d.name) return err_('กรุณากรอกชื่อผู้จำหน่าย');
    var p = {
      code: d.code || '', name: d.name, contact: d.contact || '',
      phone: d.phone || '', address: d.address || '', taxId: d.taxId || '', active: d.active !== false
    };
    var s = d.id ? update_('Suppliers', d.id, p) : insert_('Suppliers', p);
    return ok_('บันทึกผู้จำหน่ายแล้ว', s);
  } catch (e) { return err_(e.message); }
}
function apiDeleteSupplier(token, id) {
  try { auth_(token, ['admin', 'manager']); remove_('Suppliers', id); return ok_('ลบแล้ว'); }
  catch (e) { return err_(e.message); }
}
function apiListSuppliers(token) {
  try { auth_(token); return ok_('ok', readAll_('Suppliers')); } catch (e) { return err_(e.message); }
}

/* ================= BALANCE ENGINE ================= */

function balanceKey_(productId, locationId) { return productId + '|' + locationId; }

function balanceMap_() {
  var out = {};
  readAll_('Balances').forEach(function (b) { out[b.key] = num_(b.qty); });
  return out;
}

/**
 * ปรับยอดคงเหลือแบบชุดเดียว — อ่านชีตครั้งเดียว เขียนครั้งเดียว
 * deltas = [{productId, locationId, qty}]
 * (ต้องเรียกภายใต้ LockService เสมอ)
 */
function applyBalances_(deltas) {
  if (!deltas || !deltas.length) return;
  var sh = sheet_('Balances');
  var all = readAll_('Balances');
  var byKey = {}, dirty = {};
  all.forEach(function (b) { byKey[b.key] = b; });

  var news = [];
  deltas.forEach(function (d) {
    var key = balanceKey_(d.productId, d.locationId);
    if (byKey[key]) {
      byKey[key].qty = num_(byKey[key].qty) + num_(d.qty);
      dirty[key] = true;
    } else {
      var o = {
        id: Utilities.getUuid(), key: key, productId: d.productId,
        locationId: d.locationId, qty: num_(d.qty), createdAt: nowIso_()
      };
      byKey[key] = o;
      news.push(o);
    }
  });

  all.forEach(function (b) {
    if (!dirty[b.key]) return;
    var row = b.__row;
    var copy = {};
    for (var k in b) { if (k !== '__row') copy[k] = b[k]; }
    copy.updatedAt = nowIso_();
    sh.getRange(row, 1).setValue(JSON.stringify(copy));
  });

  if (news.length) {
    var rows = news.map(function (o) { return [JSON.stringify(o)]; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
  }
}

function getBalanceFrom_(bal, productId, locationId) {
  return num_(bal[balanceKey_(productId, locationId)]);
}

function onHandFrom_(bal, productId) {
  var t = 0;
  for (var k in bal) if (k.split('|')[0] === productId) t += num_(bal[k]);
  return t;
}

/** ปรับ flag void ของ movement หลายรายการในครั้งเดียว */
function markMovementsVoid_(ids) {
  if (!ids.length) return;
  var want = {};
  ids.forEach(function (i) { want[i] = true; });
  var sh = sheet_('Movements');
  readAll_('Movements').forEach(function (m) {
    if (!want[m.id]) return;
    var copy = {};
    for (var k in m) { if (k !== '__row') copy[k] = m[k]; }
    copy.void = true;
    copy.updatedAt = nowIso_();
    sh.getRange(m.__row, 1).setValue(JSON.stringify(copy));
  });
}

function apiBalances(token) {
  try {
    auth_(token);
    var prods = readAll_('Products');
    var locs = readAll_('Locations');
    var pm = {}, lm = {};
    prods.forEach(function (p) { pm[p.id] = p; });
    locs.forEach(function (l) { lm[l.id] = l; });
    var out = [];
    readAll_('Balances').forEach(function (b) {
      var p = pm[b.productId], l = lm[b.locationId];
      if (!p) return;
      out.push({
        productId: b.productId, code: p.code, name: p.name, unit: p.unit,
        categoryId: p.categoryId, minQty: num_(p.minQty),
        locationId: b.locationId, locationName: l ? l.name : '-',
        qty: num_(b.qty), avgCost: num_(p.avgCost), value: num_(b.qty) * num_(p.avgCost)
      });
    });
    return ok_('ok', out);
  } catch (e) { return err_(e.message); }
}

/** สร้างยอดคงเหลือใหม่ทั้งหมดจาก Movements — ใช้เมื่อสงสัยว่ายอดเพี้ยน */
function apiRebuildBalances(token) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager']);
    lock.waitLock(60000);
    var agg = {};
    readAll_('Movements').forEach(function (m) {
      if (m.void) return;
      var k = balanceKey_(m.productId, m.locationId);
      agg[k] = (agg[k] || 0) + num_(m.qty);
    });
    var sh = sheet_('Balances');
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    var rows = [];
    for (var k in agg) {
      var parts = k.split('|');
      rows.push({ key: k, productId: parts[0], locationId: parts[1], qty: agg[k] });
    }
    insertMany_('Balances', rows);
    log_(u.id, 'rebuild', 'คำนวณยอดคงเหลือใหม่ ' + rows.length + ' รายการ');
    return ok_('คำนวณยอดคงเหลือใหม่แล้ว ' + rows.length + ' รายการ');
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}


/* ============================================================
   LOT ENGINE (FEFO) + SERIAL
   ============================================================ */

function lotKey_(productId, locationId, lotNo) {
  return productId + '|' + locationId + '|' + String(lotNo || '');
}

/** อ่านล็อตทั้งหมดครั้งเดียวแล้วทำงานในหน่วยความจำ */
function lotWorkspace_() {
  var all = readAll_('Lots');
  var byId = {}, byKey = {}, dirty = {}, news = [];
  all.forEach(function (l) { byId[l.id] = l; byKey[lotKey_(l.productId, l.locationId, l.lotNo)] = l; });
  return {
    all: all, byId: byId, byKey: byKey, dirty: dirty, news: news,
    /** ล็อตของสินค้าในคลังหนึ่ง เรียงตามวันหมดอายุก่อน (FEFO) */
    avail: function (productId, locationId) {
      var out = all.concat(news).filter(function (l) {
        return l.productId === productId && l.locationId === locationId && num_(l.qty) > 0;
      });
      out.sort(function (a, b) {
        var ea = a.expiryDate || '9999-12-31', eb = b.expiryDate || '9999-12-31';
        if (ea !== eb) return ea < eb ? -1 : 1;
        return String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''));
      });
      return out;
    },
    add: function (productId, locationId, lotNo, expiryDate, qty, unitCost, docId, docNo) {
      var k = lotKey_(productId, locationId, lotNo);
      var found = byKey[k];
      if (found) {
        found.qty = num_(found.qty) + num_(qty);
        if (expiryDate && !found.expiryDate) found.expiryDate = expiryDate;
        if (num_(unitCost) > 0) found.unitCost = num_(unitCost);
        if (found.__new) { /* อยู่ใน news อยู่แล้ว */ } else { dirty[found.id] = true; }
        return found;
      }
      var o = {
        id: Utilities.getUuid(), productId: productId, locationId: locationId,
        lotNo: String(lotNo || ''), expiryDate: expiryDate || '',
        qty: num_(qty), unitCost: num_(unitCost),
        docId: docId || '', docNo: docNo || '',
        receivedAt: nowIso_(), createdAt: nowIso_(), __new: true
      };
      byKey[k] = o; byId[o.id] = o; news.push(o);
      return o;
    },
    take: function (lotId, qty) {
      var l = byId[lotId];
      if (!l) return false;
      l.qty = num_(l.qty) - num_(qty);
      if (!l.__new) dirty[l.id] = true;
      return true;
    },
    /** จัดสรรแบบ FEFO คืน [{lotId, lotNo, expiryDate, qty, unitCost}] */
    allocate: function (productId, locationId, qty) {
      var need = num_(qty), alloc = [];
      var list = this.avail(productId, locationId);
      for (var i = 0; i < list.length && need > 0; i++) {
        var take = Math.min(need, num_(list[i].qty));
        if (take <= 0) continue;
        alloc.push({
          lotId: list[i].id, lotNo: list[i].lotNo, expiryDate: list[i].expiryDate || '',
          qty: take, unitCost: num_(list[i].unitCost)
        });
        need -= take;
      }
      return { alloc: alloc, shortage: need };
    },
    commit: function () {
      var sh = sheet_('Lots');
      all.forEach(function (l) {
        if (!dirty[l.id]) return;
        var c = {};
        for (var k in l) { if (k !== '__row' && k !== '__new') c[k] = l[k]; }
        c.updatedAt = nowIso_();
        sh.getRange(l.__row, 1).setValue(JSON.stringify(c));
      });
      if (news.length) {
        var rows = news.map(function (o) {
          var c = {};
          for (var k in o) { if (k !== '__new' && k !== '__row') c[k] = o[k]; }
          return [JSON.stringify(c)];
        });
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
      }
    }
  };
}

/** อ่านซีเรียลทั้งหมดครั้งเดียว */
function serialWorkspace_() {
  var all = readAll_('Serials');
  var byCode = {}, dirty = {}, news = [];
  all.forEach(function (x) { byCode[String(x.serial).trim().toUpperCase()] = x; });
  return {
    all: all, byCode: byCode, news: news, dirty: dirty,
    find: function (code) { return byCode[String(code || '').trim().toUpperCase()] || null; },
    checkIn: function (productId, code, locationId, lotNo, docId, docNo) {
      var key = String(code || '').trim();
      if (!key) return { ok: false, msg: 'ซีเรียลว่าง' };
      var ex = this.find(key);
      if (ex && ex.status === 'in') return { ok: false, msg: 'ซีเรียล ' + key + ' อยู่ในสต๊อกอยู่แล้ว' };
      if (ex) {
        ex.status = 'in'; ex.locationId = locationId; ex.lotNo = lotNo || '';
        ex.inDocNo = docNo; ex.inDocId = docId; ex.outDocNo = ''; ex.ts = nowIso_();
        if (!ex.__new) dirty[ex.id] = true;
        return { ok: true };
      }
      var o = {
        id: Utilities.getUuid(), productId: productId, serial: key, status: 'in',
        locationId: locationId, lotNo: lotNo || '', inDocId: docId, inDocNo: docNo,
        outDocNo: '', ts: nowIso_(), createdAt: nowIso_(), __new: true
      };
      byCode[key.toUpperCase()] = o; news.push(o);
      return { ok: true };
    },
    checkOut: function (productId, code, locationId, docId, docNo) {
      var ex = this.find(code);
      if (!ex) return { ok: false, msg: 'ไม่พบซีเรียล ' + code + ' ในระบบ' };
      if (ex.status !== 'in') return { ok: false, msg: 'ซีเรียล ' + code + ' ถูกจ่ายออกไปแล้ว' };
      if (ex.productId !== productId) return { ok: false, msg: 'ซีเรียล ' + code + ' ไม่ใช่ของสินค้ารายการนี้' };
      if (locationId && ex.locationId && ex.locationId !== locationId) {
        return { ok: false, msg: 'ซีเรียล ' + code + ' ไม่ได้อยู่ในคลังที่เลือก' };
      }
      ex.status = 'out'; ex.outDocId = docId; ex.outDocNo = docNo; ex.ts = nowIso_();
      if (!ex.__new) dirty[ex.id] = true;
      return { ok: true, lotNo: ex.lotNo };
    },
    move: function (code, toLocationId) {
      var ex = this.find(code);
      if (!ex) return false;
      ex.locationId = toLocationId; ex.ts = nowIso_();
      if (!ex.__new) dirty[ex.id] = true;
      return true;
    },
    /** คืนสถานะตอนยกเลิกเอกสาร */
    revert: function (code, backTo, locationId) {
      var ex = this.find(code);
      if (!ex) return false;
      ex.status = backTo;
      if (locationId) ex.locationId = locationId;
      ex.ts = nowIso_();
      if (!ex.__new) dirty[ex.id] = true;
      return true;
    },
    commit: function () {
      var sh = sheet_('Serials');
      all.forEach(function (x) {
        if (!dirty[x.id]) return;
        var c = {};
        for (var k in x) { if (k !== '__row' && k !== '__new') c[k] = x[k]; }
        c.updatedAt = nowIso_();
        sh.getRange(x.__row, 1).setValue(JSON.stringify(c));
      });
      if (news.length) {
        var rows = news.map(function (o) {
          var c = {};
          for (var k in o) { if (k !== '__new' && k !== '__row') c[k] = o[k]; }
          return [JSON.stringify(c)];
        });
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
      }
    }
  };
}

function daysUntil_(dateStr) {
  if (!dateStr) return null;
  var d = new Date(String(dateStr) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
}

/* ================= DOC NUMBER ================= */

function nextDocNo_(prefix, sheetName) {
  var d = new Date();
  var ym = Utilities.formatDate(d, 'Asia/Bangkok', 'yyMM');
  var rows = readAll_(sheetName);
  var max = 0;
  var head = prefix + ym;
  rows.forEach(function (r) {
    var s = String(r.docNo || '');
    if (s.indexOf(head) === 0) {
      var n = parseInt(s.slice(head.length), 10);
      if (!isNaN(n)) max = Math.max(max, n);
    }
  });
  return head + ('000' + (max + 1)).slice(-4);
}

/* ================= STOCK TRANSACTIONS ================= */

/**
 * items: [{productId, qty, unitCost, note}]
 */
function apiCreateStockIn(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    if (!items || !items.length) return err_('ยังไม่มีรายการสินค้า');
    if (!head.locationId) return err_('กรุณาเลือกคลังปลายทาง');
    lock.waitLock(30000);

    var docNo = nextDocNo_('IN', 'DocIn');
    var docId = Utilities.getUuid();
    var total = 0;
    var mvs = [], deltas = [];
    var bal = balanceMap_();
    var onHand = {};
    var LW = lotWorkspace_(), SW = serialWorkspace_();
    var prodCache = {};

    function prod_(id) {
      if (prodCache[id] === undefined) prodCache[id] = findById_('Products', id);
      return prodCache[id];
    }

    // ตรวจซีเรียลทั้งหมดก่อน ถ้าพลาดจะได้ไม่เขียนอะไรเลย
    for (var vi = 0; vi < items.length; vi++) {
      var vp = prod_(items[vi].productId);
      if (vp && vp.trackSerial) {
        var sl = items[vi].serials || [];
        if (!sl.length) return err_('สินค้า "' + vp.name + '" ต้องระบุซีเรียลอย่างน้อย 1 รายการ');
        var seen = {};
        for (var si = 0; si < sl.length; si++) {
          var code = String(sl[si] || '').trim();
          if (!code) return err_('มีซีเรียลว่างในรายการ "' + vp.name + '"');
          if (seen[code.toUpperCase()]) return err_('ซีเรียล ' + code + ' ซ้ำกันในเอกสารเดียวกัน');
          seen[code.toUpperCase()] = true;
          var ex = SW.find(code);
          if (ex && ex.status === 'in') return err_('ซีเรียล ' + code + ' อยู่ในสต๊อกอยู่แล้ว');
        }
      }
      if (vp && vp.trackLot && !String(items[vi].lotNo || '').trim()) {
        return err_('สินค้า "' + vp.name + '" ต้องระบุเลขล็อต');
      }
    }

    items.forEach(function (it) {
      var p = prod_(it.productId);
      var qty = (p && p.trackSerial) ? (it.serials || []).length : num_(it.qty);
      if (qty <= 0) return;
      var cost = num_(it.unitCost);
      total += qty * cost;

      if (onHand[it.productId] === undefined) onHand[it.productId] = onHandFrom_(bal, it.productId);
      applyAvgCost_(it.productId, onHand[it.productId], qty, cost);
      onHand[it.productId] += qty;

      var lotNo = String(it.lotNo || '').trim();
      var exp = String(it.expiryDate || '').trim();
      if (p && p.trackLot) {
        if (!exp && num_(p.shelfLifeDays) > 0) {
          exp = Utilities.formatDate(
            new Date(Date.now() + num_(p.shelfLifeDays) * 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');
        }
        LW.add(it.productId, head.locationId, lotNo, exp, qty, cost, docId, docNo);
      }
      if (p && p.trackSerial) {
        (it.serials || []).forEach(function (code) {
          SW.checkIn(it.productId, code, head.locationId, lotNo, docId, docNo);
        });
      }

      deltas.push({ productId: it.productId, locationId: head.locationId, qty: qty });
      mvs.push({
        ts: nowIso_(), type: 'in', docId: docId, docNo: docNo,
        productId: it.productId, locationId: head.locationId,
        qty: qty, unitCost: cost, lotNo: lotNo, expiryDate: exp,
        serials: (p && p.trackSerial) ? (it.serials || []) : [],
        note: it.note || '', userId: u.id
      });
    });

    LW.commit(); SW.commit();
    applyBalances_(deltas);
    insertMany_('Movements', mvs);

    var doc = insert_('DocIn', {
      id: docId, docNo: docNo, docDate: head.docDate || nowIso_(),
      supplierId: head.supplierId || '', locationId: head.locationId,
      refNo: head.refNo || '', note: head.note || '', poId: head.poId || '',
      items: items, total: total, userId: u.id, userName: u.name, void: false
    });
    if (head.poId) applyPoReceipt_(head.poId, items, docNo);
    log_(u.id, 'stockin', 'รับเข้า ' + docNo + ' ' + mvs.length + ' รายการ');
    return ok_('บันทึกรับเข้า ' + docNo + ' แล้ว', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

/** ต้นทุนเฉลี่ยถ่วงน้ำหนัก: (คงเหลือเดิม×ทุนเดิม + รับเข้า×ทุนใหม่) / รวม */
function applyAvgCost_(productId, onHand, inQty, inCost) {
  if (inCost <= 0) return;
  var p = findById_('Products', productId);
  if (!p) return;
  var oldCost = num_(p.avgCost);
  var base = Math.max(onHand, 0);
  var newAvg = (base + inQty) > 0
    ? ((base * oldCost) + (inQty * inCost)) / (base + inQty)
    : inCost;
  update_('Products', productId, { avgCost: Math.round(newAvg * 10000) / 10000 });
}

function apiCreateStockOut(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    if (!items || !items.length) return err_('ยังไม่มีรายการสินค้า');
    if (!head.locationId) return err_('กรุณาเลือกคลังต้นทาง');
    lock.waitLock(30000);

    var settings = readAll_('Settings')[0] || {};
    var bal = balanceMap_();
    // ตรวจยอดก่อนตัดจริงทั้งหมด (รวมกรณีสินค้าตัวเดียวกันซ้ำหลายบรรทัด)
    if (!settings.allowNegative) {
      var need = {};
      for (var i = 0; i < items.length; i++) {
        need[items[i].productId] = (need[items[i].productId] || 0) + num_(items[i].qty);
      }
      for (var pid in need) {
        var have = getBalanceFrom_(bal, pid, head.locationId);
        if (need[pid] > have) {
          var pp = findById_('Products', pid);
          return err_('สินค้า "' + (pp ? pp.name : '') + '" คงเหลือ ' + have + ' ไม่พอเบิก ' + need[pid]);
        }
      }
    }

    var docNo = nextDocNo_('OUT', 'DocOut');
    var docId = Utilities.getUuid();
    var total = 0, mvs = [], deltas = [];
    var LW = lotWorkspace_(), SW = serialWorkspace_();
    var prodCache = {};
    function prod_(id) {
      if (prodCache[id] === undefined) prodCache[id] = findById_('Products', id);
      return prodCache[id];
    }

    // ตรวจล็อต/ซีเรียลให้ครบก่อน แล้วค่อยเขียน
    for (var vi = 0; vi < items.length; vi++) {
      var vp = prod_(items[vi].productId);
      if (!vp) continue;
      if (vp.trackSerial) {
        var sl = items[vi].serials || [];
        if (!sl.length) return err_('สินค้า "' + vp.name + '" ต้องยิงซีเรียลที่จะจ่ายออก');
        for (var si = 0; si < sl.length; si++) {
          var chk = SW.find(sl[si]);
          if (!chk) return err_('ไม่พบซีเรียล ' + sl[si] + ' ในระบบ');
          if (chk.status !== 'in') return err_('ซีเรียล ' + sl[si] + ' ถูกจ่ายออกไปแล้ว');
          if (chk.productId !== vp.id) return err_('ซีเรียล ' + sl[si] + ' ไม่ใช่ของสินค้า "' + vp.name + '"');
        }
      }
      if (vp.trackLot && !settings.allowNegative) {
        var test = LW.allocate(vp.id, head.locationId, num_(items[vi].qty));
        if (test.shortage > 0) {
          return err_('ล็อตของ "' + vp.name + '" ในคลังนี้ไม่พอ ขาดอีก ' + test.shortage);
        }
      }
    }

    items.forEach(function (it) {
      var p = prod_(it.productId);
      var qty = (p && p.trackSerial) ? (it.serials || []).length : num_(it.qty);
      if (qty <= 0) return;
      var cost = p ? num_(p.avgCost) : 0;
      total += qty * num_(it.price !== undefined ? it.price : cost);

      var alloc = [];
      if (p && p.trackLot) {
        var res = LW.allocate(it.productId, head.locationId, qty);
        alloc = res.alloc;
        alloc.forEach(function (a) { LW.take(a.lotId, a.qty); });
      }
      if (p && p.trackSerial) {
        (it.serials || []).forEach(function (code) {
          SW.checkOut(it.productId, code, head.locationId, docId, docNo);
        });
      }

      deltas.push({ productId: it.productId, locationId: head.locationId, qty: -qty });
      mvs.push({
        ts: nowIso_(), type: 'out', docId: docId, docNo: docNo,
        productId: it.productId, locationId: head.locationId,
        qty: -qty, unitCost: cost, price: num_(it.price),
        lotAlloc: alloc, serials: (p && p.trackSerial) ? (it.serials || []) : [],
        note: it.note || '', userId: u.id
      });
    });

    LW.commit(); SW.commit();
    applyBalances_(deltas);
    insertMany_('Movements', mvs);

    var doc = insert_('DocOut', {
      id: docId, docNo: docNo, docDate: head.docDate || nowIso_(),
      locationId: head.locationId, issueTo: head.issueTo || '',
      purpose: head.purpose || '', refNo: head.refNo || '', note: head.note || '',
      items: items, total: total, userId: u.id, userName: u.name, void: false
    });
    log_(u.id, 'stockout', 'เบิกออก ' + docNo);
    checkLowStockNotify_(items.map(function (i) { return i.productId; }));
    return ok_('บันทึกเบิกออก ' + docNo + ' แล้ว', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function apiCreateTransfer(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    if (!items || !items.length) return err_('ยังไม่มีรายการสินค้า');
    if (!head.fromLocationId || !head.toLocationId) return err_('กรุณาเลือกคลังต้นทางและปลายทาง');
    if (head.fromLocationId === head.toLocationId) return err_('คลังต้นทางและปลายทางต้องต่างกัน');
    lock.waitLock(30000);

    var settings = readAll_('Settings')[0] || {};
    var bal = balanceMap_();
    if (!settings.allowNegative) {
      var need = {};
      for (var i = 0; i < items.length; i++) {
        need[items[i].productId] = (need[items[i].productId] || 0) + num_(items[i].qty);
      }
      for (var pid in need) {
        var have = getBalanceFrom_(bal, pid, head.fromLocationId);
        if (need[pid] > have) {
          var pp = findById_('Products', pid);
          return err_('สินค้า "' + (pp ? pp.name : '') + '" ในคลังต้นทางคงเหลือ ' + have + ' ไม่พอโอน');
        }
      }
    }

    var docNo = nextDocNo_('TR', 'DocTransfer');
    var docId = Utilities.getUuid();
    var mvs = [], deltas = [];
    var LW = lotWorkspace_(), SW = serialWorkspace_();
    items.forEach(function (it) {
      var qty = num_(it.qty);
      if (qty <= 0) return;
      var p = findById_('Products', it.productId);
      var cost = p ? num_(p.avgCost) : 0;
      if (p && p.trackLot) {
        var res = LW.allocate(it.productId, head.fromLocationId, qty);
        res.alloc.forEach(function (a) {
          LW.take(a.lotId, a.qty);
          LW.add(it.productId, head.toLocationId, a.lotNo, a.expiryDate, a.qty, a.unitCost, docId, docNo);
        });
        it.lotAlloc = res.alloc;
      }
      if (p && p.trackSerial) {
        (it.serials || []).forEach(function (code) { SW.move(code, head.toLocationId); });
      }
      deltas.push({ productId: it.productId, locationId: head.fromLocationId, qty: -qty });
      deltas.push({ productId: it.productId, locationId: head.toLocationId, qty: qty });
      mvs.push({
        ts: nowIso_(), type: 'transfer_out', docId: docId, docNo: docNo,
        productId: it.productId, locationId: head.fromLocationId,
        qty: -qty, unitCost: cost, note: it.note || '', userId: u.id
      });
      mvs.push({
        ts: nowIso_(), type: 'transfer_in', docId: docId, docNo: docNo,
        productId: it.productId, locationId: head.toLocationId,
        qty: qty, unitCost: cost, note: it.note || '', userId: u.id
      });
    });
    LW.commit(); SW.commit();
    applyBalances_(deltas);
    insertMany_('Movements', mvs);

    var doc = insert_('DocTransfer', {
      id: docId, docNo: docNo, docDate: head.docDate || nowIso_(),
      fromLocationId: head.fromLocationId, toLocationId: head.toLocationId,
      note: head.note || '', items: items, userId: u.id, userName: u.name, void: false
    });
    log_(u.id, 'transfer', 'โอนย้าย ' + docNo);
    return ok_('บันทึกโอนย้าย ' + docNo + ' แล้ว', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

/**
 * ตรวจนับ: items = [{productId, countQty}]
 * ระบบเทียบกับยอดระบบ แล้วสร้าง movement ปรับส่วนต่างให้อัตโนมัติ
 */
function apiCreateCount(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    if (!items || !items.length) return err_('ยังไม่มีรายการนับ');
    if (!head.locationId) return err_('กรุณาเลือกคลังที่นับ');
    lock.waitLock(30000);

    var docNo = nextDocNo_('CT', 'DocCount');
    var docId = Utilities.getUuid();
    var mvs = [], lines = [], deltas = [];
    var bal = balanceMap_();
    var LW = lotWorkspace_();

    items.forEach(function (it) {
      var sysQty = getBalanceFrom_(bal, it.productId, head.locationId);
      var cnt = num_(it.countQty);
      var diff = cnt - sysQty;
      var p = findById_('Products', it.productId);
      lines.push({
        productId: it.productId, sysQty: sysQty, countQty: cnt, diff: diff,
        avgCost: p ? num_(p.avgCost) : 0
      });
      if (diff !== 0) {
        if (p && p.trackLot) adjustLots_(LW, it.productId, head.locationId, diff, p, docId, docNo);
        deltas.push({ productId: it.productId, locationId: head.locationId, qty: diff });
        mvs.push({
          ts: nowIso_(), type: 'count', docId: docId, docNo: docNo,
          productId: it.productId, locationId: head.locationId,
          qty: diff, unitCost: p ? num_(p.avgCost) : 0,
          note: 'ปรับจากการตรวจนับ (ระบบ ' + sysQty + ' → นับจริง ' + cnt + ')', userId: u.id
        });
      }
    });
    LW.commit();
    applyBalances_(deltas);
    insertMany_('Movements', mvs);

    var doc = insert_('DocCount', {
      id: docId, docNo: docNo, docDate: head.docDate || nowIso_(),
      locationId: head.locationId, note: head.note || '',
      items: lines, adjusted: mvs.length, userId: u.id, userName: u.name, void: false
    });
    log_(u.id, 'count', 'ตรวจนับ ' + docNo + ' ปรับ ' + mvs.length + ' รายการ');
    return ok_('บันทึกตรวจนับ ' + docNo + ' — ปรับยอด ' + mvs.length + ' รายการ', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

/** ปรับปรุงยอดตรง (ของเสีย/หาย/ได้เพิ่ม) items=[{productId, qty(+/-), reason}] */
function apiCreateAdjust(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager']);
    if (!items || !items.length) return err_('ยังไม่มีรายการ');
    if (!head.locationId) return err_('กรุณาเลือกคลัง');
    lock.waitLock(30000);

    var docNo = nextDocNo_('AD', 'DocAdjust');
    var docId = Utilities.getUuid();
    var mvs = [], deltas = [];
    var LW = lotWorkspace_();
    items.forEach(function (it) {
      var qty = num_(it.qty);
      if (qty === 0) return;
      var p = findById_('Products', it.productId);
      if (p && p.trackLot) adjustLots_(LW, it.productId, head.locationId, qty, p, docId, docNo, it.lotNo, it.expiryDate);
      deltas.push({ productId: it.productId, locationId: head.locationId, qty: qty });
      mvs.push({
        ts: nowIso_(), type: 'adjust', docId: docId, docNo: docNo,
        productId: it.productId, locationId: head.locationId,
        qty: qty, unitCost: p ? num_(p.avgCost) : 0,
        note: it.reason || head.reason || '', userId: u.id
      });
    });
    LW.commit();
    applyBalances_(deltas);
    insertMany_('Movements', mvs);
    var doc = insert_('DocAdjust', {
      id: docId, docNo: docNo, docDate: head.docDate || nowIso_(),
      locationId: head.locationId, reason: head.reason || '', note: head.note || '',
      items: items, userId: u.id, userName: u.name, void: false
    });
    log_(u.id, 'adjust', 'ปรับปรุงยอด ' + docNo);
    return ok_('บันทึกปรับปรุงยอด ' + docNo + ' แล้ว', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}


/** ปรับยอดล็อตตามส่วนต่าง: ลบ = ตัด FEFO, บวก = เข้าล็อตที่ระบุหรือล็อตปรับยอด */
function adjustLots_(LW, productId, locationId, diff, p, docId, docNo, lotNo, expiryDate) {
  if (diff < 0) {
    var res = LW.allocate(productId, locationId, -diff);
    res.alloc.forEach(function (a) { LW.take(a.lotId, a.qty); });
  } else if (diff > 0) {
    var ln = String(lotNo || '').trim() || ('ADJ-' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyMMdd'));
    var exp = String(expiryDate || '').trim();
    if (!exp && p && num_(p.shelfLifeDays) > 0) {
      exp = Utilities.formatDate(new Date(Date.now() + num_(p.shelfLifeDays) * 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');
    }
    LW.add(productId, locationId, ln, exp, diff, p ? num_(p.avgCost) : 0, docId, docNo);
  }
}

/* ================= DOCUMENTS ================= */

var DOC_SHEET = {
  in: 'DocIn', out: 'DocOut', transfer: 'DocTransfer', count: 'DocCount', adjust: 'DocAdjust'
};

function apiListDocs(token, kind, from, to) {
  try {
    auth_(token);
    var name = DOC_SHEET[kind];
    if (!name) return err_('ประเภทเอกสารไม่ถูกต้อง');
    var rows = readAll_(name);
    if (from) rows = rows.filter(function (r) { return String(r.docDate).slice(0, 10) >= from; });
    if (to) rows = rows.filter(function (r) { return String(r.docDate).slice(0, 10) <= to; });
    rows.sort(function (a, b) { return String(b.docDate).localeCompare(String(a.docDate)); });
    return ok_('ok', rows.slice(0, 500));
  } catch (e) { return err_(e.message); }
}

function apiGetDoc(token, kind, id) {
  try {
    auth_(token);
    var name = DOC_SHEET[kind];
    if (!name) return err_('ประเภทเอกสารไม่ถูกต้อง');
    var d = findById_(name, id);
    if (!d) return err_('ไม่พบเอกสาร');
    return ok_('ok', d);
  } catch (e) { return err_(e.message); }
}

/** ยกเลิกเอกสาร — กลับรายการ movement ทั้งหมดของเอกสารนั้น */
function apiVoidDoc(token, kind, id, reason) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager']);
    var name = DOC_SHEET[kind];
    if (!name) return err_('ประเภทเอกสารไม่ถูกต้อง');
    lock.waitLock(30000);
    var d = findById_(name, id);
    if (!d) return err_('ไม่พบเอกสาร');
    if (d.void) return err_('เอกสารนี้ถูกยกเลิกไปแล้ว');

    var mvs = readAll_('Movements').filter(function (m) { return m.docId === id && !m.void; });
    var rev = [], deltas = [], voidIds = [];
    var LW = lotWorkspace_(), SW = serialWorkspace_();
    mvs.forEach(function (m) {
      // คืนล็อต
      if (num_(m.qty) > 0 && m.lotNo) {
        // เคยรับเข้า -> ตัดคืนออกจากล็อตนั้น
        var k = lotKey_(m.productId, m.locationId, m.lotNo);
        var lo = LW.byKey[k];
        if (lo) LW.take(lo.id, num_(m.qty));
      } else if (num_(m.qty) < 0 && m.lotAlloc && m.lotAlloc.length) {
        // เคยจ่ายออก -> คืนกลับเข้าล็อตเดิม
        m.lotAlloc.forEach(function (a) {
          LW.add(m.productId, m.locationId, a.lotNo, a.expiryDate, num_(a.qty), num_(a.unitCost), id, d.docNo);
        });
      }
      // คืนซีเรียล
      if (m.serials && m.serials.length) {
        m.serials.forEach(function (code) {
          SW.revert(code, num_(m.qty) > 0 ? 'out' : 'in', m.locationId);
        });
      }
      deltas.push({ productId: m.productId, locationId: m.locationId, qty: -num_(m.qty) });
      voidIds.push(m.id);
      rev.push({
        ts: nowIso_(), type: 'void', docId: id, docNo: d.docNo + '-VOID',
        productId: m.productId, locationId: m.locationId,
        qty: -num_(m.qty), unitCost: num_(m.unitCost),
        note: 'ยกเลิกเอกสาร ' + d.docNo + (reason ? ' : ' + reason : ''), userId: u.id
      });
    });
    LW.commit(); SW.commit();
    applyBalances_(deltas);
    markMovementsVoid_(voidIds);
    insertMany_('Movements', rev);
    if (kind === 'in' && d.poId) revertPoReceipt_(d.poId, d.items || []);
    update_(name, id, { void: true, voidReason: reason || '', voidBy: u.name, voidAt: nowIso_() });
    log_(u.id, 'void', 'ยกเลิกเอกสาร ' + d.docNo);
    return ok_('ยกเลิกเอกสาร ' + d.docNo + ' และคืนยอดแล้ว');
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

/* ================= REPORTS ================= */

function apiDashboard(token) {
  try {
    auth_(token);
    var prods = readAll_('Products');
    var pm = {}; prods.forEach(function (p) { pm[p.id] = p; });
    var bal = readAll_('Balances');

    var totalValue = 0, totalQty = 0, low = [], zero = 0;
    var byProd = {};
    bal.forEach(function (b) {
      var p = pm[b.productId]; if (!p) return;
      byProd[b.productId] = (byProd[b.productId] || 0) + num_(b.qty);
      totalQty += num_(b.qty);
      totalValue += num_(b.qty) * num_(p.avgCost);
    });
    prods.forEach(function (p) {
      var q = byProd[p.id] || 0;
      if (q <= 0) zero++;
      if (num_(p.minQty) > 0 && q <= num_(p.minQty)) {
        low.push({ id: p.id, code: p.code, name: p.name, qty: q, minQty: num_(p.minQty), unit: p.unit });
      }
    });
    low.sort(function (a, b) { return (a.qty - a.minQty) - (b.qty - b.minQty); });

    // เคลื่อนไหว 14 วันล่าสุด
    var since = new Date(Date.now() - 14 * 86400000).toISOString();
    var mv = readAll_('Movements').filter(function (m) { return !m.void && m.ts >= since; });
    var daily = {};
    mv.forEach(function (m) {
      var d = String(m.ts).slice(0, 10);
      if (!daily[d]) daily[d] = { inQty: 0, outQty: 0 };
      if (num_(m.qty) > 0) daily[d].inQty += num_(m.qty); else daily[d].outQty += -num_(m.qty);
    });
    var series = Object.keys(daily).sort().map(function (d) {
      return { date: d, inQty: daily[d].inQty, outQty: daily[d].outQty };
    });

    // สินค้าเคลื่อนไหวมากสุดใน 14 วัน
    var moverMap = {};
    mv.forEach(function (m) {
      var mm = moverMap[m.productId] || (moverMap[m.productId] = { inQty: 0, outQty: 0 });
      if (num_(m.qty) > 0) mm.inQty += num_(m.qty); else mm.outQty += -num_(m.qty);
    });
    var topMovers = Object.keys(moverMap).map(function (pid) {
      var p = pm[pid]; var mm = moverMap[pid];
      return {
        name: p ? p.name : '-', code: p ? p.code : '', unit: p ? p.unit : '',
        inQty: mm.inQty, outQty: mm.outQty, total: mm.inQty + mm.outQty
      };
    }).sort(function (a, b) { return b.total - a.total; }).slice(0, 6);

    // มูลค่าคงคลังแยกตามหมวดหมู่
    var catMap = {}; readAll_('Categories').forEach(function (c) { catMap[c.id] = c.name; });
    var byCat = {};
    prods.forEach(function (p) {
      var q = byProd[p.id] || 0; if (q <= 0) return;
      var cn = catMap[p.categoryId] || 'ไม่ระบุหมวด';
      byCat[cn] = (byCat[cn] || 0) + q * num_(p.avgCost);
    });
    var byCategory = Object.keys(byCat).map(function (n) { return { name: n, value: byCat[n] }; })
      .sort(function (a, b) { return b.value - a.value; });
    if (byCategory.length > 6) {
      var rest = byCategory.slice(6).reduce(function (s, x) { return s + x.value; }, 0);
      byCategory = byCategory.slice(0, 6).concat([{ name: 'อื่นๆ', value: rest }]);
    }

    // ใบสั่งซื้อค้างรับ
    var poPending = readAll_('DocPO').filter(function (x) { return x.status === 'open' || x.status === 'partial'; }).length;

    // ล็อตใกล้หมดอายุ/หมดอายุแล้ว
    var warnDays = CONFIG.EXPIRY_WARN_DAYS, expiredCount = 0, soonCount = 0;
    readAll_('Lots').forEach(function (l) {
      if (num_(l.qty) <= 0 || !l.expiryDate) return;
      var dd = daysUntil_(l.expiryDate);
      if (dd === null) return;
      if (dd < 0) expiredCount++; else if (dd <= warnDays) soonCount++;
    });

    var recent = readAll_('Movements').filter(function (m) { return !m.void; })
      .sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); })
      .slice(0, 15)
      .map(function (m) {
        var p = pm[m.productId];
        return {
          ts: m.ts, type: m.type, docNo: m.docNo, qty: num_(m.qty),
          name: p ? p.name : '-', code: p ? p.code : '', unit: p ? p.unit : ''
        };
      });

    return ok_('ok', {
      productCount: prods.length,
      totalQty: totalQty,
      totalValue: totalValue,
      lowCount: low.length,
      zeroCount: zero,
      low: low.slice(0, 20),
      series: series,
      recent: recent,
      topMovers: topMovers,
      byCategory: byCategory,
      poPending: poPending,
      expiredCount: expiredCount,
      soonCount: soonCount
    });
  } catch (e) { return err_(e.message); }
}

/** การ์ดสินค้า — ประวัติเคลื่อนไหวรายตัว พร้อมยอดคงเหลือสะสม */
function apiStockCard(token, productId, from, to, locationId) {
  try {
    auth_(token);
    var p = findById_('Products', productId);
    if (!p) return err_('ไม่พบสินค้า');
    var locs = readAll_('Locations'); var lm = {};
    locs.forEach(function (l) { lm[l.id] = l.name; });

    var mv = readAll_('Movements').filter(function (m) {
      if (m.void || m.productId !== productId) return false;
      if (locationId && m.locationId !== locationId) return false;
      return true;
    }).sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });

    var run = 0, rows = [];
    mv.forEach(function (m) {
      run += num_(m.qty);
      var d = String(m.ts).slice(0, 10);
      if (from && d < from) return;
      if (to && d > to) return;
      rows.push({
        ts: m.ts, type: m.type, docNo: m.docNo,
        locationName: lm[m.locationId] || '-',
        inQty: num_(m.qty) > 0 ? num_(m.qty) : 0,
        outQty: num_(m.qty) < 0 ? -num_(m.qty) : 0,
        balance: run, unitCost: num_(m.unitCost), note: m.note || ''
      });
    });
    return ok_('ok', { product: p, rows: rows });
  } catch (e) { return err_(e.message); }
}

function apiReportMovement(token, from, to, type, locationId) {
  try {
    auth_(token);
    var prods = readAll_('Products'); var pm = {};
    prods.forEach(function (p) { pm[p.id] = p; });
    var locs = readAll_('Locations'); var lm = {};
    locs.forEach(function (l) { lm[l.id] = l.name; });

    var rows = readAll_('Movements').filter(function (m) {
      if (m.void) return false;
      var d = String(m.ts).slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (type && m.type !== type) return false;
      if (locationId && m.locationId !== locationId) return false;
      return true;
    }).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });

    var out = rows.slice(0, 3000).map(function (m) {
      var p = pm[m.productId];
      return {
        ts: m.ts, type: m.type, docNo: m.docNo,
        code: p ? p.code : '', name: p ? p.name : '-', unit: p ? p.unit : '',
        locationName: lm[m.locationId] || '-',
        qty: num_(m.qty), unitCost: num_(m.unitCost),
        value: num_(m.qty) * num_(m.unitCost), note: m.note || ''
      };
    });
    return ok_('ok', out);
  } catch (e) { return err_(e.message); }
}

/** สินค้าไม่เคลื่อนไหวเกิน N วัน */
function apiReportDeadStock(token, days) {
  try {
    auth_(token);
    var d = num_(days) || 90;
    var cut = new Date(Date.now() - d * 86400000).toISOString();
    var lastMove = {};
    readAll_('Movements').forEach(function (m) {
      if (m.void) return;
      if (!lastMove[m.productId] || m.ts > lastMove[m.productId]) lastMove[m.productId] = m.ts;
    });
    var bal = {};
    readAll_('Balances').forEach(function (b) { bal[b.productId] = (bal[b.productId] || 0) + num_(b.qty); });

    var out = [];
    readAll_('Products').forEach(function (p) {
      var q = bal[p.id] || 0;
      if (q <= 0) return;
      var lm = lastMove[p.id] || '';
      if (!lm || lm < cut) {
        out.push({
          code: p.code, name: p.name, unit: p.unit, qty: q,
          avgCost: num_(p.avgCost), value: q * num_(p.avgCost),
          lastMove: lm ? String(lm).slice(0, 10) : 'ไม่เคยเคลื่อนไหว'
        });
      }
    });
    out.sort(function (a, b) { return b.value - a.value; });
    return ok_('ok', out);
  } catch (e) { return err_(e.message); }
}

function apiReportValuation(token) {
  try {
    auth_(token);
    var cats = readAll_('Categories'); var cm = {};
    cats.forEach(function (c) { cm[c.id] = c.name; });
    var bal = {};
    readAll_('Balances').forEach(function (b) { bal[b.productId] = (bal[b.productId] || 0) + num_(b.qty); });
    var byCat = {};
    var rows = [];
    readAll_('Products').forEach(function (p) {
      var q = bal[p.id] || 0;
      var v = q * num_(p.avgCost);
      var cn = cm[p.categoryId] || 'ไม่ระบุหมวด';
      byCat[cn] = (byCat[cn] || 0) + v;
      rows.push({
        code: p.code, name: p.name, category: cn, unit: p.unit,
        qty: q, avgCost: num_(p.avgCost), value: v, salePrice: num_(p.salePrice),
        saleValue: q * num_(p.salePrice)
      });
    });
    rows.sort(function (a, b) { return b.value - a.value; });
    return ok_('ok', { rows: rows, byCategory: byCat });
  } catch (e) { return err_(e.message); }
}

/* ================= NOTIFY ================= */

function checkLowStockNotify_(productIds) {
  try {
    var s = readAll_('Settings')[0] || {};
    if (!s.lineToken && !s.notifyEmail) return;
    var bal = {};
    readAll_('Balances').forEach(function (b) { bal[b.productId] = (bal[b.productId] || 0) + num_(b.qty); });
    var msgs = [];
    (productIds || []).forEach(function (pid) {
      var p = findById_('Products', pid);
      if (!p || num_(p.minQty) <= 0) return;
      var q = bal[pid] || 0;
      if (q <= num_(p.minQty)) {
        msgs.push('• ' + p.name + ' เหลือ ' + q + ' ' + p.unit + ' (ขั้นต่ำ ' + p.minQty + ')');
      }
    });
    if (!msgs.length) return;
    var text = 'แจ้งเตือนสินค้าใกล้หมด\n' + msgs.join('\n');
    if (s.lineToken) sendLineMulticast_(s.lineToken, text);
    if (s.notifyEmail) MailApp.sendEmail(s.notifyEmail, '[' + CONFIG.APP_NAME + '] สินค้าใกล้หมด', text);
  } catch (e) { }
}

/** ส่งข้อความผ่าน LINE Messaging API (multicast) ไปยังผู้ใช้ role admin/manager
 *  ที่ผูกบัญชี LINE ไว้แล้ว (Users.lineUid) — แทนที่ LINE Notify ซึ่งปิดบริการถาวรแล้ว */
function sendLineMulticast_(channelToken, text) {
  try {
    var to = readAll_('Users').filter(function (u) {
      return u.lineUid && u.active !== false && (u.role === 'admin' || u.role === 'manager');
    }).map(function (u) { return u.lineUid; });
    if (!to.length) return;
    for (var i = 0; i < to.length; i += 500) {
      UrlFetchApp.fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + channelToken },
        payload: JSON.stringify({ to: to.slice(i, i + 500), messages: [{ type: 'text', text: text }] }),
        muteHttpExceptions: true
      });
    }
  } catch (e) { }
}

/** ตั้ง trigger รายวันเรียกฟังก์ชันนี้เพื่อสรุปของใกล้หมดทั้งระบบ */
function dailyLowStockReport() {
  var s = readAll_('Settings')[0] || {};
  if (!s.lineToken && !s.notifyEmail) return;
  var bal = {};
  readAll_('Balances').forEach(function (b) { bal[b.productId] = (bal[b.productId] || 0) + num_(b.qty); });
  var msgs = [];
  readAll_('Products').forEach(function (p) {
    if (num_(p.minQty) <= 0) return;
    var q = bal[p.id] || 0;
    if (q <= num_(p.minQty)) msgs.push('• ' + p.name + ' เหลือ ' + q + ' ' + p.unit);
  });
  if (!msgs.length) return;
  var text = 'สรุปสินค้าใกล้หมดประจำวัน (' + msgs.length + ' รายการ)\n' + msgs.slice(0, 40).join('\n');
  if (s.lineToken) sendLineMulticast_(s.lineToken, text);
  if (s.notifyEmail) MailApp.sendEmail(s.notifyEmail, '[' + CONFIG.APP_NAME + '] สรุปสินค้าใกล้หมด', text);
}

/* ================= USERS / SETTINGS / FILES ================= */

function apiListUsers(token) {
  try {
    auth_(token, ['admin']);
    return ok_('ok', readAll_('Users').map(function (u) {
      return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false };
    }));
  } catch (e) { return err_(e.message); }
}

function apiSaveUser(token, d) {
  var lock = LockService.getScriptLock();
  try {
    var me = auth_(token, ['admin']);
    lock.waitLock(20000);
    if (!d.username || !d.name) return err_('กรุณากรอกชื่อผู้ใช้และชื่อ-สกุล');
    var users = readAll_('Users');
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].username).toLowerCase() === String(d.username).toLowerCase() && users[i].id !== d.id) {
        return err_('ชื่อผู้ใช้นี้ถูกใช้แล้ว');
      }
    }
    var payload = { username: d.username, name: d.name, role: d.role || 'staff', active: d.active !== false };
    if (d.password) {
      var salt = Utilities.getUuid().slice(0, 8);
      payload.salt = salt;
      payload.hash = hash_(d.password, salt);
    }
    var saved;
    if (d.id) {
      saved = update_('Users', d.id, payload);
    } else {
      if (!d.password) return err_('กรุณากำหนดรหัสผ่าน');
      saved = insert_('Users', payload);
    }
    log_(me.id, 'user', 'บันทึกผู้ใช้ ' + d.username);
    return ok_('บันทึกผู้ใช้แล้ว', { id: saved.id });
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function apiDeleteUser(token, id) {
  try {
    var me = auth_(token, ['admin']);
    if (me.id === id) return err_('ลบบัญชีตัวเองไม่ได้');
    remove_('Users', id);
    return ok_('ลบผู้ใช้แล้ว');
  } catch (e) { return err_(e.message); }
}

function apiGetSettings(token) {
  try { auth_(token); return ok_('ok', readAll_('Settings')[0] || {}); }
  catch (e) { return err_(e.message); }
}

/** ชื่อหน่วยงาน/โลโก้แบบไม่ต้องล็อกอิน — ใช้แสดงบนหน้า login ก่อนรู้ token
 *  ตั้งใจคืนแค่ 2 ฟิลด์นี้เท่านั้น ไม่ให้หลุดค่าที่อ่อนไหวอื่นๆ ใน Settings ออกไปก่อนล็อกอิน */
function apiPublicBranding() {
  try {
    var s = readAll_('Settings')[0] || {};
    return ok_('ok', { orgName: s.orgName || '', logoUrl: s.logoUrl || '' });
  } catch (e) { return err_(e.message); }
}

function apiSaveSettings(token, d) {
  try {
    var u = auth_(token, ['admin', 'manager']);
    var s = readAll_('Settings')[0];
    if (!s) return err_('ไม่พบการตั้งค่า');
    update_('Settings', s.id, {
      orgName: d.orgName || '', logoUrl: d.logoUrl || '',
      allowNegative: !!d.allowNegative,
      lineToken: d.lineToken || '', notifyEmail: d.notifyEmail || '',
      lineChannelId: d.lineChannelId || '', folderId: d.folderId || '',
      labelWidth: num_(d.labelWidth) || 50, labelHeight: num_(d.labelHeight) || 25
    });
    log_(u.id, 'settings', 'แก้ไขการตั้งค่า');
    return ok_('บันทึกการตั้งค่าแล้ว');
  } catch (e) { return err_(e.message); }
}

/** อัปโหลดไฟล์เข้า Drive (รูปสินค้า/โลโก้) — ส่ง base64 มาจากฝั่งเว็บ
 *  Folder ID อ่านจากหน้าตั้งค่า (Settings.folderId) ก่อน ถ้าไม่มีจะ fallback ไปที่ CONFIG.FOLDER_ID */
function apiUploadFile(token, base64, filename, mime) {
  try {
    auth_(token);
    var s = readAll_('Settings')[0] || {};
    var folderId = s.folderId || CONFIG.FOLDER_ID;
    if (!folderId) return err_('ยังไม่ได้ตั้งค่า Drive Folder ID ในหน้าตั้งค่า');
    var bytes = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(bytes, mime, filename);
    var folder = DriveApp.getFolderById(folderId);
    var f = folder.createFile(blob);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // ใช้ endpoint thumbnail แทน uc?export=view — ฝังเป็น <img> ในหน้าที่รันอยู่ใน iframe ของ Apps Script ได้จริง
    // (uc?export=view เปิดตรงในแท็บได้ปกติ แต่มักโดนบล็อกเมื่อฝังเป็น <img> ข้ามโดเมนจาก iframe แบบ sandbox)
    return ok_('อัปโหลดแล้ว', { url: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w1000', id: f.getId() });
  } catch (e) { return err_(e.message); }
}

function apiListLogs(token, limit) {
  try {
    auth_(token, ['admin']);
    var users = readAll_('Users'); var um = {};
    users.forEach(function (u) { um[u.id] = u.name; });
    var rows = readAll_('Logs').sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
    return ok_('ok', rows.slice(0, num_(limit) || 300).map(function (r) {
      return { ts: r.ts, action: r.action, detail: r.detail, userName: um[r.userId] || '-' };
    }));
  } catch (e) { return err_(e.message); }
}

/* ================= IMPORT ================= */

/** นำเข้าสินค้าจาก CSV: code,name,barcode,unit,minQty,salePrice,avgCost */
function apiImportProducts(token, rows) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager']);
    lock.waitLock(60000);
    var existing = readAll_('Products');
    var byCode = {}; existing.forEach(function (p) { byCode[p.code] = p; });
    var added = 0, updated = 0, bcAdded = 0;
    (rows || []).forEach(function (r) {
      if (!r.name) return;
      var payload = {
        code: r.code || autoProductCode_(existing),
        name: r.name, unit: r.unit || 'ชิ้น',
        minQty: num_(r.minQty), salePrice: num_(r.salePrice), avgCost: num_(r.avgCost),
        active: true
      };
      var p;
      if (r.code && byCode[r.code]) { p = update_('Products', byCode[r.code].id, payload); updated++; }
      else { p = insert_('Products', payload); existing.push(p); byCode[p.code] = p; added++; }
      if (r.barcode && !findBarcode_(r.barcode)) {
        insert_('Barcodes', {
          barcode: String(r.barcode).trim(), productId: p.id,
          unit: payload.unit, perUnit: 1, isPrimary: true
        });
        bcAdded++;
      }
    });
    log_(u.id, 'import', 'นำเข้าสินค้า เพิ่ม ' + added + ' แก้ไข ' + updated);
    return ok_('นำเข้าสำเร็จ — เพิ่ม ' + added + ' / แก้ไข ' + updated + ' / บาร์โค้ด ' + bcAdded);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

/* ============================================================
   PURCHASE ORDER (ใบสั่งซื้อ)
   ============================================================ */

function apiCreatePO(token, head, items) {
  var lock = LockService.getScriptLock();
  try {
    var u = auth_(token, ['admin', 'manager', 'staff']);
    if (!items || !items.length) return err_('ยังไม่มีรายการสินค้า');
    if (!head.supplierId) return err_('กรุณาเลือกผู้จำหน่าย');
    if (!head.locationId) return err_('กรุณาเลือกคลังที่จะรับของ');
    lock.waitLock(30000);

    var docNo = nextDocNo_('PO', 'DocPO');
    var total = 0;
    var lines = items.map(function (it) {
      var qty = num_(it.qty), cost = num_(it.unitCost);
      total += qty * cost;
      return { productId: it.productId, qty: qty, unitCost: cost, received: 0, note: it.note || '' };
    }).filter(function (x) { return x.qty > 0; });
    if (!lines.length) return err_('จำนวนสั่งซื้อต้องมากกว่า 0');

    var doc = insert_('DocPO', {
      docNo: docNo, docDate: head.docDate || nowIso_(),
      expectDate: head.expectDate || '', supplierId: head.supplierId,
      locationId: head.locationId, refNo: head.refNo || '', note: head.note || '',
      items: lines, total: total, status: 'open',
      userId: u.id, userName: u.name, void: false
    });
    log_(u.id, 'po', 'เปิดใบสั่งซื้อ ' + docNo);
    return ok_('เปิดใบสั่งซื้อ ' + docNo + ' แล้ว', doc);
  } catch (e) { return err_(e.message); }
  finally { try { lock.releaseLock(); } catch (e2) { } }
}

function apiListPO(token, status) {
  try {
    auth_(token);
    var rows = readAll_('DocPO');
    if (status) rows = rows.filter(function (r) { return r.status === status; });
    rows.sort(function (a, b) { return String(b.docDate).localeCompare(String(a.docDate)); });
    var prods = readAll_('Products'); var pm = {};
    prods.forEach(function (p) { pm[p.id] = p; });
    rows.forEach(function (r) {
      var ord = 0, rec = 0;
      (r.items || []).forEach(function (i) { ord += num_(i.qty); rec += num_(i.received); });
      r.orderQty = ord; r.recvQty = rec; r.pending = ord - rec;
      r.itemNames = (r.items || []).slice(0, 3).map(function (i) {
        return pm[i.productId] ? pm[i.productId].name : '';
      }).filter(Boolean);
    });
    return ok_('ok', rows.slice(0, 300));
  } catch (e) { return err_(e.message); }
}

function apiGetPO(token, id) {
  try {
    auth_(token);
    var d = findById_('DocPO', id);
    if (!d) return err_('ไม่พบใบสั่งซื้อ');
    var pm = {};
    readAll_('Products').forEach(function (p) { pm[p.id] = p; });
    (d.items || []).forEach(function (i) {
      var p = pm[i.productId];
      i.code = p ? p.code : '';
      i.name = p ? p.name : '(ไม่พบสินค้า)';
      i.unit = p ? p.unit : '';
      i.trackLot = p ? !!p.trackLot : false;
      i.trackSerial = p ? !!p.trackSerial : false;
      i.pending = num_(i.qty) - num_(i.received);
    });
    return ok_('ok', d);
  } catch (e) { return err_(e.message); }
}

/** ตัดยอดค้างรับเมื่อรับเข้าอ้างอิง PO (เรียกภายใน apiCreateStockIn) */
function applyPoReceipt_(poId, items, docNo) {
  var po = findById_('DocPO', poId);
  if (!po) return;
  var recv = {};
  items.forEach(function (it) {
    var q = (it.serials && it.serials.length) ? it.serials.length : num_(it.qty);
    recv[it.productId] = (recv[it.productId] || 0) + q;
  });
  var lines = (po.items || []).map(function (l) {
    if (recv[l.productId]) l.received = num_(l.received) + recv[l.productId];
    return l;
  });
  var done = lines.every(function (l) { return num_(l.received) >= num_(l.qty); });
  var any = lines.some(function (l) { return num_(l.received) > 0; });
  update_('DocPO', poId, {
    items: lines,
    status: done ? 'closed' : (any ? 'partial' : 'open'),
    lastReceiptNo: docNo, lastReceiptAt: nowIso_()
  });
}

function revertPoReceipt_(poId, items) {
  var po = findById_('DocPO', poId);
  if (!po) return;
  var recv = {};
  items.forEach(function (it) {
    var q = (it.serials && it.serials.length) ? it.serials.length : num_(it.qty);
    recv[it.productId] = (recv[it.productId] || 0) + q;
  });
  var lines = (po.items || []).map(function (l) {
    if (recv[l.productId]) l.received = Math.max(0, num_(l.received) - recv[l.productId]);
    return l;
  });
  var done = lines.every(function (l) { return num_(l.received) >= num_(l.qty); });
  var any = lines.some(function (l) { return num_(l.received) > 0; });
  update_('DocPO', poId, { items: lines, status: done ? 'closed' : (any ? 'partial' : 'open') });
}

function apiSetPOStatus(token, id, status) {
  try {
    var u = auth_(token, ['admin', 'manager']);
    var d = findById_('DocPO', id);
    if (!d) return err_('ไม่พบใบสั่งซื้อ');
    if (['open', 'partial', 'closed', 'cancelled'].indexOf(status) === -1) return err_('สถานะไม่ถูกต้อง');
    update_('DocPO', id, { status: status });
    log_(u.id, 'po', 'เปลี่ยนสถานะ ' + d.docNo + ' เป็น ' + status);
    return ok_('อัปเดตสถานะแล้ว');
  } catch (e) { return err_(e.message); }
}

/* ============================================================
   LOT / SERIAL / EXPIRY — รายงานและการค้นหา
   ============================================================ */

function apiListLots(token, locationId, onlyActive) {
  try {
    auth_(token);
    var pm = {}; readAll_('Products').forEach(function (p) { pm[p.id] = p; });
    var lm = {}; readAll_('Locations').forEach(function (l) { lm[l.id] = l.name; });
    var rows = readAll_('Lots').filter(function (l) {
      if (locationId && l.locationId !== locationId) return false;
      if (onlyActive !== false && num_(l.qty) <= 0) return false;
      return true;
    }).map(function (l) {
      var p = pm[l.productId];
      var dd = daysUntil_(l.expiryDate);
      return {
        id: l.id, lotNo: l.lotNo, expiryDate: l.expiryDate || '',
        daysLeft: dd, productId: l.productId,
        code: p ? p.code : '', name: p ? p.name : '(ไม่พบสินค้า)', unit: p ? p.unit : '',
        locationId: l.locationId, locationName: lm[l.locationId] || '-',
        qty: num_(l.qty), unitCost: num_(l.unitCost), value: num_(l.qty) * num_(l.unitCost),
        receivedAt: l.receivedAt, docNo: l.docNo || ''
      };
    });
    rows.sort(function (a, b) {
      var ea = a.expiryDate || '9999-12-31', eb = b.expiryDate || '9999-12-31';
      return ea < eb ? -1 : (ea > eb ? 1 : 0);
    });
    return ok_('ok', rows);
  } catch (e) { return err_(e.message); }
}

/** รายงานใกล้หมดอายุ / หมดอายุแล้ว */
function apiReportExpiry(token, days) {
  try {
    auth_(token);
    var warn = num_(days) || CONFIG.EXPIRY_WARN_DAYS;
    var pm = {}; readAll_('Products').forEach(function (p) { pm[p.id] = p; });
    var lm = {}; readAll_('Locations').forEach(function (l) { lm[l.id] = l.name; });
    var expired = [], soon = [];
    readAll_('Lots').forEach(function (l) {
      if (num_(l.qty) <= 0 || !l.expiryDate) return;
      var dd = daysUntil_(l.expiryDate);
      if (dd === null) return;
      var p = pm[l.productId];
      var row = {
        lotNo: l.lotNo, expiryDate: l.expiryDate, daysLeft: dd,
        code: p ? p.code : '', name: p ? p.name : '-', unit: p ? p.unit : '',
        locationName: lm[l.locationId] || '-',
        qty: num_(l.qty), value: num_(l.qty) * num_(l.unitCost)
      };
      if (dd < 0) expired.push(row);
      else if (dd <= warn) soon.push(row);
    });
    expired.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    soon.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    return ok_('ok', {
      warnDays: warn, expired: expired, soon: soon,
      expiredValue: expired.reduce(function (s, x) { return s + x.value; }, 0),
      soonValue: soon.reduce(function (s, x) { return s + x.value; }, 0)
    });
  } catch (e) { return err_(e.message); }
}

function apiLookupSerial(token, code) {
  try {
    auth_(token);
    var key = String(code || '').trim().toUpperCase();
    if (!key) return err_('กรุณาระบุซีเรียล');
    var found = null;
    readAll_('Serials').forEach(function (x) {
      if (String(x.serial).trim().toUpperCase() === key) found = x;
    });
    if (!found) return err_('ไม่พบซีเรียล ' + code);
    var p = findById_('Products', found.productId);
    var history = readAll_('Movements').filter(function (m) {
      return !m.void && m.serials && m.serials.some(function (sx) {
        return String(sx).trim().toUpperCase() === key;
      });
    }).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); })
      .map(function (m) {
        return { ts: m.ts, type: m.type, docNo: m.docNo, qty: num_(m.qty) };
      });
    return ok_('ok', {
      serial: found.serial, status: found.status, lotNo: found.lotNo || '',
      productId: found.productId,
      code: p ? p.code : '', name: p ? p.name : '-',
      locationId: found.locationId,
      inDocNo: found.inDocNo || '', outDocNo: found.outDocNo || '',
      history: history
    });
  } catch (e) { return err_(e.message); }
}

function apiListSerials(token, productId, status) {
  try {
    auth_(token);
    var pm = {}; readAll_('Products').forEach(function (p) { pm[p.id] = p; });
    var lm = {}; readAll_('Locations').forEach(function (l) { lm[l.id] = l.name; });
    var rows = readAll_('Serials').filter(function (x) {
      if (productId && x.productId !== productId) return false;
      if (status && x.status !== status) return false;
      return true;
    }).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); })
      .slice(0, 1000)
      .map(function (x) {
        var p = pm[x.productId];
        return {
          serial: x.serial, status: x.status, lotNo: x.lotNo || '',
          code: p ? p.code : '', name: p ? p.name : '-',
          locationName: lm[x.locationId] || '-',
          inDocNo: x.inDocNo || '', outDocNo: x.outDocNo || '', ts: x.ts
        };
      });
    return ok_('ok', rows);
  } catch (e) { return err_(e.message); }
}

/** ข้อมูลสินค้าแบบเต็มสำหรับหน้าเช็คของ (มือถือ/เดสก์ท็อป) */
function apiProductSnapshot(token, productId) {
  try {
    auth_(token);
    var p = findById_('Products', productId);
    if (!p) return err_('ไม่พบสินค้า');
    var lm = {}; readAll_('Locations').forEach(function (l) { lm[l.id] = l.name; });
    var bal = [];
    readAll_('Balances').forEach(function (b) {
      if (b.productId !== productId) return;
      bal.push({ locationName: lm[b.locationId] || '-', qty: num_(b.qty) });
    });
    var lots = readAll_('Lots').filter(function (l) {
      return l.productId === productId && num_(l.qty) > 0;
    }).map(function (l) {
      return {
        lotNo: l.lotNo, expiryDate: l.expiryDate || '', daysLeft: daysUntil_(l.expiryDate),
        locationName: lm[l.locationId] || '-', qty: num_(l.qty)
      };
    }).sort(function (a, b) {
      var ea = a.expiryDate || '9999-12-31', eb = b.expiryDate || '9999-12-31';
      return ea < eb ? -1 : 1;
    });
    var last = readAll_('Movements').filter(function (m) {
      return !m.void && m.productId === productId;
    }).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 8)
      .map(function (m) { return { ts: m.ts, type: m.type, docNo: m.docNo, qty: num_(m.qty) }; });
    var barcodes = readAll_('Barcodes').filter(function (b) { return b.productId === productId; })
      .map(function (b) { return b.barcode; });
    return ok_('ok', {
      id: p.id, code: p.code, name: p.name, unit: p.unit,
      avgCost: num_(p.avgCost), salePrice: num_(p.salePrice), minQty: num_(p.minQty),
      trackLot: !!p.trackLot, trackSerial: !!p.trackSerial,
      barcodes: barcodes, balances: bal, lots: lots, recent: last,
      total: bal.reduce(function (s, x) { return s + x.qty; }, 0)
    });
  } catch (e) { return err_(e.message); }
}

/** สรุปสำหรับหน้าแรกมือถือ */
function apiMobileSummary(token) {
  try {
    auth_(token);
    var pm = {}; readAll_('Products').forEach(function (p) { pm[p.id] = p; });
    var byProd = {};
    readAll_('Balances').forEach(function (b) {
      byProd[b.productId] = (byProd[b.productId] || 0) + num_(b.qty);
    });
    var value = 0, low = 0;
    for (var id in pm) {
      var q = byProd[id] || 0;
      value += q * num_(pm[id].avgCost);
      if (num_(pm[id].minQty) > 0 && q <= num_(pm[id].minQty)) low++;
    }
    var expSoon = 0, expBad = 0;
    readAll_('Lots').forEach(function (l) {
      if (num_(l.qty) <= 0 || !l.expiryDate) return;
      var dd = daysUntil_(l.expiryDate);
      if (dd === null) return;
      if (dd < 0) expBad++; else if (dd <= CONFIG.EXPIRY_WARN_DAYS) expSoon++;
    });
    var openPo = readAll_('DocPO').filter(function (x) {
      return x.status === 'open' || x.status === 'partial';
    }).length;
    return ok_('ok', {
      totalValue: value, lowCount: low, expiringSoon: expSoon,
      expired: expBad, openPo: openPo, productCount: Object.keys(pm).length
    });
  } catch (e) { return err_(e.message); }
}

/** Trigger รายวัน: สรุปของใกล้หมดอายุ */
function dailyExpiryReport() {
  var s = readAll_('Settings')[0] || {};
  if (!s.lineToken && !s.notifyEmail) return;
  var pm = {}; readAll_('Products').forEach(function (p) { pm[p.id] = p; });
  var bad = [], soon = [];
  readAll_('Lots').forEach(function (l) {
    if (num_(l.qty) <= 0 || !l.expiryDate) return;
    var dd = daysUntil_(l.expiryDate);
    if (dd === null) return;
    var p = pm[l.productId];
    var line = '• ' + (p ? p.name : '-') + ' ล็อต ' + l.lotNo + ' คงเหลือ ' + num_(l.qty) +
      ' (' + l.expiryDate + ')';
    if (dd < 0) bad.push(line);
    else if (dd <= CONFIG.EXPIRY_WARN_DAYS) soon.push(line);
  });
  if (!bad.length && !soon.length) return;
  var text = 'สรุปล็อตสินค้า\n';
  if (bad.length) text += '\nหมดอายุแล้ว ' + bad.length + ' ล็อต\n' + bad.slice(0, 20).join('\n');
  if (soon.length) text += '\n\nใกล้หมดอายุใน ' + CONFIG.EXPIRY_WARN_DAYS + ' วัน ' + soon.length + ' ล็อต\n' +
    soon.slice(0, 20).join('\n');
  if (s.lineToken) sendLine_(s.lineToken, text);
  if (s.notifyEmail) MailApp.sendEmail(s.notifyEmail, '[' + CONFIG.APP_NAME + '] สรุปวันหมดอายุ', text);
}

/* ============================================================
   API GATEWAY — สำหรับหน้ามือถือ LIFF ที่โฮสต์บน GitHub Pages
   GET  ?api=<ชื่อฟังก์ชัน>&token=<token>&p=<json array>&callback=<cb>  -> JSONP
   POST body JSON {api, token, p:[...]}  (text/plain เลี่ยง preflight) -> JSON
   ============================================================ */

/** เฉพาะฟังก์ชันในลิสต์นี้เท่านั้นที่เรียกผ่าน gateway ได้ */
var API_WHITELIST = {
  apiLogin: 1, apiLineLogin: 1, apiLinkLine: 1, apiUnlinkLine: 1,
  apiBootstrap: 1, apiMe: 1, apiLogout: 1, apiPublicBranding: 1,
  apiScanIndex: 1, apiProductSnapshot: 1, apiLookupSerial: 1,
  apiMobileSummary: 1, apiDashboard: 1,
  apiCreateStockIn: 1, apiCreateStockOut: 1, apiCreateTransfer: 1,
  apiCreateCount: 1, apiCreateAdjust: 1,
  apiListProducts: 1, apiSaveProduct: 1, apiSaveBarcode: 1,
  apiBalances: 1, apiStockCard: 1, apiListLots: 1, apiReportExpiry: 1,
  apiListPO: 1, apiGetPO: 1, apiCreatePO: 1, apiSetPOStatus: 1,
  apiListDocs: 1, apiGetDoc: 1
};

function apiGateway_(e) {
  var out;
  try {
    var name = String(e.parameter.api || '');
    if (!API_WHITELIST[name]) throw new Error('ไม่อนุญาตให้เรียก ' + name);
    var args = [];
    if (e.parameter.p) args = JSON.parse(e.parameter.p);
    if (!(args instanceof Array)) args = [args];
    if (e.parameter.token) args.unshift(e.parameter.token);
    out = globalThis[name].apply(null, args);
  } catch (err) {
    out = err_(err.message);
  }
  var json = JSON.stringify(out);
  var cb = e.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out;
  try {
    initializeSheets();
    var body = JSON.parse(e.postData.contents);
    var name = String(body.api || '');
    if (!API_WHITELIST[name]) throw new Error('ไม่อนุญาตให้เรียก ' + name);
    var args = body.p || [];
    if (!(args instanceof Array)) args = [args];
    if (body.token) args.unshift(body.token);
    out = globalThis[name].apply(null, args);
  } catch (err) {
    out = err_(err.message);
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- LINE account linking ---------- */

/** ตรวจ idToken จาก liff.getIDToken() กับเซิร์ฟเวอร์ LINE แล้วคืน sub (lineUid)
 *  Channel ID อ่านจากหน้าตั้งค่า (Settings.lineChannelId) ก่อน ถ้าไม่มีจะ fallback ไปที่ CONFIG.LINE_CHANNEL_ID */
function verifyLineIdToken_(idToken) {
  var s = readAll_('Settings')[0] || {};
  var channelId = s.lineChannelId || CONFIG.LINE_CHANNEL_ID;
  if (!channelId) throw new Error('ยังไม่ได้ตั้งค่า LINE Login Channel ID ในหน้าตั้งค่า');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !data.sub) {
    throw new Error('ตรวจสอบบัญชี LINE ไม่สำเร็จ: ' + (data.error_description || data.error || 'unknown'));
  }
  return data;
}

/** ล็อกอินอัตโนมัติด้วยบัญชี LINE ที่ผูกไว้แล้ว */
function apiLineLogin(idToken) {
  try {
    initializeSheets();
    var info = verifyLineIdToken_(idToken);
    var users = readAll_('Users');
    var u = null;
    for (var i = 0; i < users.length; i++) if (users[i].lineUid === info.sub) u = users[i];
    if (!u) return { status: 'error', code: 'NOT_LINKED', message: 'บัญชี LINE นี้ยังไม่ได้ผูกกับผู้ใช้ในระบบ' };
    if (u.active === false) return err_('บัญชีนี้ถูกปิดใช้งาน');

    var token = Utilities.getUuid();
    insert_('Sessions', {
      token: token, userId: u.id,
      expireAt: new Date(Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000).toISOString()
    });
    cleanSessions_();
    log_(u.id, 'login', 'เข้าสู่ระบบผ่าน LINE');
    return ok_('เข้าสู่ระบบสำเร็จ', {
      token: token,
      user: { id: u.id, username: u.username, name: u.name, role: u.role },
      lineName: info.name || '', linePicture: info.picture || ''
    });
  } catch (e) { return err_(e.message); }
}

/** ผูกบัญชี LINE เข้ากับผู้ใช้ที่กำลังล็อกอินอยู่ (ทำครั้งเดียว) */
function apiLinkLine(token, idToken) {
  try {
    var u = auth_(token);
    var info = verifyLineIdToken_(idToken);
    var users = readAll_('Users');
    for (var i = 0; i < users.length; i++) {
      if (users[i].lineUid === info.sub && users[i].id !== u.id) {
        return err_('บัญชี LINE นี้ถูกผูกกับผู้ใช้ ' + users[i].username + ' แล้ว');
      }
    }
    update_('Users', u.id, { lineUid: info.sub, lineName: info.name || '' });
    log_(u.id, 'line', 'ผูกบัญชี LINE');
    return ok_('ผูกบัญชี LINE เรียบร้อย ครั้งต่อไปเปิดจาก LINE จะเข้าระบบอัตโนมัติ');
  } catch (e) { return err_(e.message); }
}

function apiUnlinkLine(token) {
  try {
    var u = auth_(token);
    update_('Users', u.id, { lineUid: '', lineName: '' });
    return ok_('ยกเลิกการผูกบัญชี LINE แล้ว');
  } catch (e) { return err_(e.message); }
}
