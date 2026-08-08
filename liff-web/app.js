/* ============================================================
   StockBar Mobile — LIFF app (GitHub Pages)
   คุยกับ Apps Script ผ่าน JSONP (GET) และ POST สำหรับข้อมูลก้อนใหญ่
   ============================================================ */

var M = {
  cfg: window.SB_CONFIG || {},
  token: null,
  user: null,
  boot: {},
  index: {},
  balances: {},
  lots: [],
  inLine: false,
  idToken: null,
  cart: [],
  mode: 'in',       // in | out | count
  locationId: '',
  pages: {}
};

/* ---------------- utils ---------------- */
M.esc = function (s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/[<]/g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
M.n = function (v) { var x = parseFloat(v); return isNaN(x) ? 0 : x; };
M.fmt = function (v, d) {
  d = d === undefined ? 0 : d;
  return M.n(v).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });
};
M.money = function (v) { return M.fmt(v, 2); };
M.today = function () {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
};
M.dt = function (iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' +
    ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
};
M.toast = function (msg, kind) {
  var el = $('<div class="t ' + (kind || '') + '">' + M.esc(msg) + '</div>');
  $('#toasts').append(el);
  setTimeout(function () { el.fadeOut(200, function () { el.remove(); }); }, kind === 'bad' ? 4200 : 2400);
};
M.busy = function (on) { $('#load').toggleClass('on', !!on); };
M.beep = function (kind) {
  try {
    var ctx = M._ac || (M._ac = new (window.AudioContext || window.webkitAudioContext)());
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = kind === 'bad' ? 220 : (kind === 'dup' ? 520 : 880);
    o.type = 'square';
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch (e) { }
  try { if (navigator.vibrate) navigator.vibrate(kind === 'bad' ? [60, 40, 60] : 35); } catch (e) { }
};

/* ---------------- API client ---------------- */
/** JSONP: เลี่ยงปัญหา CORS ของ Apps Script ได้ 100% */
M.jsonp = function (params) {
  return new Promise(function (resolve, reject) {
    var cb = 'sbcb_' + Math.random().toString(36).slice(2, 10);
    var t = setTimeout(function () { cleanup(); reject(new Error('หมดเวลาเชื่อมต่อเซิร์ฟเวอร์')); }, 30000);
    function cleanup() {
      clearTimeout(t);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (sc && sc.parentNode) sc.parentNode.removeChild(sc);
    }
    window[cb] = function (res) { cleanup(); resolve(res); };
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var url = M.cfg.GAS_URL + '?' + qs + '&callback=' + cb;
    if (url.length > 7000) { cleanup(); reject(new Error('__TOO_LONG__')); return; }
    var sc = document.createElement('script');
    sc.src = url;
    sc.onerror = function () { cleanup(); reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจ GAS_URL ใน config.js')); };
    document.body.appendChild(sc);
  });
};

/** POST สำรองสำหรับ payload ใหญ่ (text/plain เลี่ยง preflight) */
M.post = function (body) {
  return fetch(M.cfg.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  }).then(function (r) { return r.json(); });
};

M.call = function (api, args, needToken) {
  var p = { api: api, p: JSON.stringify(args || []) };
  if (needToken !== false && M.token) p.token = M.token;
  return M.jsonp(p)
    .catch(function (e) {
      if (e.message === '__TOO_LONG__') {
        return M.post({ api: api, token: p.token, p: args || [] });
      }
      throw e;
    })
    .then(function (res) {
      if (!res) throw new Error('ไม่ได้รับข้อมูลจากเซิร์ฟเวอร์');
      if (res.status === 'error') {
        if (String(res.message || '').indexOf('เซสชัน') === 0) M.logout(true);
        var err = new Error(res.message);
        err.code = res.code;
        throw err;
      }
      return res;
    });
};

/* ---------------- scanner ---------------- */
/** ใช้สแกนเนอร์ของ LINE ถ้าเปิดใน LINE ไม่งั้นใช้กล้องผ่าน html5-qrcode */
M.scan = function (onCode) {
  if (M.inLine && liff.isApiAvailable && liff.isApiAvailable('scanCodeV2')) {
    liff.scanCodeV2().then(function (r) {
      if (r && r.value) { M.beep('ok'); onCode(r.value); }
    }).catch(function (e) {
      M.toast('เปิดสแกนเนอร์ไม่ได้ ใช้กล้องแทน', 'bad');
      M.camera(onCode);
    });
    return;
  }
  M.camera(onCode);
};

M.camera = function (onCode) {
  $('#camBox').show();
  var q = new Html5Qrcode('camView');
  M._cam = q;
  q.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 160 } },
    function (txt) {
      q.stop().then(function () {
        $('#camBox').hide(); M._cam = null;
        M.beep('ok'); onCode(txt);
      });
    }, function () { })
    .catch(function (e) {
      $('#camBox').hide();
      M.toast('เปิดกล้องไม่ได้: ' + e, 'bad');
    });
};
$(document).on('click', '#camClose', function () {
  if (M._cam) { try { M._cam.stop(); } catch (e) { } M._cam = null; }
  $('#camBox').hide();
});

M.lookup = function (code) {
  var c = String(code || '').trim();
  if (!c) return null;
  return M.index[c] || M.index[c.toUpperCase()] || null;
};
M.qtyAt = function (pid, loc) { return M.n(M.balances[pid + '|' + loc]); };

/* ---------------- auth ---------------- */
M.boot0 = function () {
  $('#appTitle').text(M.cfg.APP_NAME || 'StockBar');
  if (!M.cfg.GAS_URL || M.cfg.GAS_URL.indexOf('XXXX') > -1) {
    $('#view').html('<div class="card-m"><div class="hd">ยังไม่ได้ตั้งค่า</div>' +
      '<div style="font-size:13.5px">เปิดไฟล์ <code>config.js</code> แล้วใส่ <b>GAS_URL</b> ' +
      'ของ Apps Script Web App ก่อนใช้งาน</div></div>');
    return;
  }
  var saved = null;
  try { saved = localStorage.getItem('sb_m_token'); } catch (e) { }

  if (M.cfg.LIFF_ID) {
    M.busy(true);
    liff.init({ liffId: M.cfg.LIFF_ID }).then(function () {
      M.inLine = liff.isInClient();
      if (liff.isLoggedIn()) M.idToken = liff.getIDToken();
      if (M.idToken) {
        return M.call('apiLineLogin', [M.idToken], false)
          .then(function (r) { return M.afterLogin(r.data); })
          .catch(function (e) {
            if (e.code === 'NOT_LINKED') { M.busy(false); M.loginScreen(true); return; }
            throw e;
          });
      }
      if (!liff.isLoggedIn() && !M.inLine) { liff.login(); return; }
      M.busy(false); M.loginScreen(false);
    }).catch(function (e) {
      M.busy(false);
      M.toast('LIFF: ' + e.message, 'bad');
      if (saved) { M.token = saved; M.resume(); } else M.loginScreen(false);
    });
    return;
  }

  if (saved) { M.token = saved; M.resume(); } else M.loginScreen(false);
};

M.resume = function () {
  M.busy(true);
  M.call('apiBootstrap', [])
    .then(function (r) { return M.afterLogin({ token: M.token, user: r.data.user }, r.data); })
    .catch(function () { M.busy(false); M.loginScreen(false); });
};

M.afterLogin = function (d, bootData) {
  M.token = d.token;
  try { localStorage.setItem('sb_m_token', M.token); } catch (e) { }
  var p = bootData ? Promise.resolve({ data: bootData }) : M.call('apiBootstrap', []);
  return p.then(function (r) {
    M.boot = r.data;
    M.user = r.data.user;
    var locs = (M.boot.locations || []).filter(function (l) { return l.active !== false; });
    M.locationId = locs.length ? locs[0].id : '';
    return M.call('apiScanIndex', []);
  }).then(function (r) {
    M.index = r.data.index || {};
    M.balances = r.data.balances || {};
    M.lots = r.data.lots || [];
    $('#who').html(M.esc(M.user.name) + '<br>' + M.esc(M.boot.roles[M.user.role] || M.user.role));
    $('#nav').show();
    M.busy(false);
    M.route();
  }).catch(function (e) {
    M.busy(false); M.toast(e.message, 'bad'); M.loginScreen(false);
  });
};

M.refreshIndex = function () {
  return M.call('apiScanIndex', []).then(function (r) {
    M.index = r.data.index || {};
    M.balances = r.data.balances || {};
    M.lots = r.data.lots || [];
  });
};

M.loginScreen = function (needLink) {
  $('#nav').hide(); $('#fabScan').hide();
  $('#view').html(
    '<div class="card-m">' +
    '<div class="hd">' + (needLink ? 'ผูกบัญชี LINE กับผู้ใช้ในระบบ' : 'เข้าสู่ระบบ') + '</div>' +
    (needLink ? '<div style="font-size:13px;color:var(--ink-faint);margin-bottom:12px">' +
      'ล็อกอินด้วยชื่อผู้ใช้/รหัสผ่านครั้งเดียว หลังจากนี้เปิดจาก LINE จะเข้าอัตโนมัติ</div>' : '') +
    '<div class="mb-3"><label class="form-label">ชื่อผู้ใช้</label>' +
    '<input id="lgU" class="form-control" autocomplete="username"></div>' +
    '<div class="mb-3"><label class="form-label">รหัสผ่าน</label>' +
    '<input id="lgP" type="password" class="form-control" autocomplete="current-password"></div>' +
    '<button class="btn btn-primary w-100 py-2" id="lgGo">เข้าสู่ระบบ</button>' +
    '<div id="lgM" style="color:var(--red);font-size:13px;margin-top:10px;text-align:center"></div>' +
    '</div>');

  $('#lgGo').on('click', function () {
    var u = $('#lgU').val(), p = $('#lgP').val();
    if (!u || !p) { $('#lgM').text('กรุณากรอกให้ครบ'); return; }
    M.busy(true);
    M.call('apiLogin', [u, p], false).then(function (r) {
      M.token = r.data.token;
      if (M.idToken) {
        return M.call('apiLinkLine', [M.idToken])
          .then(function () { M.toast('ผูกบัญชี LINE แล้ว', 'ok'); return r; })
          .catch(function () { return r; });
      }
      return r;
    }).then(function (r) { return M.afterLogin(r.data); })
      .catch(function (e) { M.busy(false); $('#lgM').text(e.message); });
  });
  $('#lgP').on('keydown', function (e) { if (e.key === 'Enter') $('#lgGo').click(); });
};

M.logout = function (silent) {
  M.token = null; M.user = null;
  try { localStorage.removeItem('sb_m_token'); } catch (e) { }
  if (!silent) M.toast('ออกจากระบบแล้ว', 'ok');
  M.loginScreen(false);
};

/* ---------------- router ---------------- */
M.route = function () {
  var p = (location.hash || '#home').replace('#', '').split('?')[0];
  if (!M.pages[p]) p = 'home';
  $('#nav a').removeClass('on');
  $('#nav a[data-p="' + p + '"]').addClass('on');
  $('#fabScan').hide();
  try { M.pages[p](); } catch (e) { M.toast(e.message, 'bad'); }
};
$(window).on('hashchange', function () { if (M.token) M.route(); });
window.onerror = function (msg) { M.toast('ข้อผิดพลาด: ' + msg, 'bad'); return false; };

/* ============================================================
   หน้าแรก
   ============================================================ */
M.pages.home = function () {
  $('#view').html('<div class="empty"><div class="spinner-border spinner-border-sm"></div></div>');
  M.call('apiMobileSummary', []).then(function (r) {
    var d = r.data;
    $('#view').html(
      '<div class="kpi">' +
      '<div class="k"><div class="kv">' + M.fmt(d.totalValue) + '</div><div class="kl">มูลค่าสต๊อก</div></div>' +
      '<div class="k' + (d.lowCount ? ' warn' : '') + '"><div class="kv">' + d.lowCount + '</div><div class="kl">ใกล้หมด</div></div>' +
      '<div class="k' + (d.expired ? ' bad' : (d.expiringSoon ? ' warn' : '')) + '"><div class="kv">' +
      (d.expired + d.expiringSoon) + '</div><div class="kl">หมด/ใกล้หมดอายุ</div></div>' +
      '</div>' +
      '<div class="tiles">' +
      '<button class="tile lead" data-go="check"><i class="bi bi-upc-scan"></i>' +
      '<div class="tn">สแกนเช็คของ</div><div class="ts">ยอดคงเหลือ ราคา ล็อต</div></button>' +
      '<button class="tile" data-go="in"><i class="bi bi-box-arrow-in-down"></i>' +
      '<div class="tn">รับเข้า</div><div class="ts">สแกนแล้วบันทึก</div></button>' +
      '<button class="tile" data-go="out"><i class="bi bi-box-arrow-up"></i>' +
      '<div class="tn">เบิก-จ่ายออก</div><div class="ts">ตัดสต๊อกทันที</div></button>' +
      '<button class="tile" data-go="count"><i class="bi bi-clipboard-check"></i>' +
      '<div class="tn">ตรวจนับ</div><div class="ts">นับจริงเทียบระบบ</div></button>' +
      '<button class="tile" data-go="po"><i class="bi bi-cart-check"></i>' +
      '<div class="tn">ใบสั่งซื้อ</div><div class="ts">' + d.openPo + ' ใบค้างรับ</div></button>' +
      '<button class="tile" data-go="expiry"><i class="bi bi-hourglass-split"></i>' +
      '<div class="tn">ใกล้หมดอายุ</div><div class="ts">' + d.expiringSoon + ' ล็อต</div></button>' +
      '</div>');
    $('#view').on('click', '.tile', function () {
      var g = $(this).data('go');
      if (g === 'check') location.hash = '#check';
      else if (g === 'po') location.hash = '#po';
      else if (g === 'expiry') location.hash = '#expiry';
      else { M.mode = g; location.hash = '#move'; }
    });
  }).catch(function (e) { $('#view').html('<div class="empty">' + M.esc(e.message) + '</div>'); });
};

/* ============================================================
   เช็คของ
   ============================================================ */
M.pages.check = function () {
  $('#view').html(
    '<div class="scanbar">' +
    '<div class="lb">สแกนหรือพิมพ์บาร์โค้ด / รหัสสินค้า / ซีเรียล</div>' +
    '<input id="ckIn" class="scan-in" placeholder="รอรับบาร์โค้ด...">' +
    '<button class="btn-scan" id="ckScan"><i class="bi bi-upc-scan"></i> เปิดสแกนเนอร์</button>' +
    '</div><div id="ckOut"></div>');

  function show(code) {
    var hit = M.lookup(code);
    M.busy(true);
    var p = hit
      ? M.call('apiProductSnapshot', [hit.productId])
      : M.call('apiLookupSerial', [code]).then(function (r) {
        return M.call('apiProductSnapshot', [r.data.productId]).then(function (s) {
          s.data.__serial = r.data; return s;
        });
      });
    p.then(function (r) {
      var d = r.data, sr = d.__serial;
      var h = '<div class="card-m">' +
        '<div style="font-size:17px;font-weight:700;line-height:1.25">' + M.esc(d.name) + '</div>' +
        '<div class="mono" style="font-size:12px;color:var(--ink-faint)">' + M.esc(d.code) + '</div>' +
        '<div class="kpi" style="margin-top:12px;margin-bottom:0">' +
        '<div class="k"><div class="kv">' + M.fmt(d.total, 2) + '</div><div class="kl">คงเหลือรวม</div></div>' +
        '<div class="k"><div class="kv">' + M.money(d.salePrice) + '</div><div class="kl">ราคาขาย</div></div>' +
        '<div class="k"><div class="kv">' + M.money(d.avgCost) + '</div><div class="kl">ทุนเฉลี่ย</div></div>' +
        '</div></div>';

      if (sr) {
        h += '<div class="card-m"><div class="hd">ซีเรียล ' + M.esc(sr.serial) + '</div>' +
          '<div class="row-i"><div><div class="nm">' +
          (sr.status === 'in' ? '<span class="bdg b-in">อยู่ในสต๊อก</span>' : '<span class="bdg b-out">จ่ายออกแล้ว</span>') +
          '</div><div class="sb">รับเข้า ' + M.esc(sr.inDocNo || '-') +
          (sr.outDocNo ? ' · จ่ายออก ' + M.esc(sr.outDocNo) : '') + '</div></div></div></div>';
      }

      h += '<div class="card-m"><div class="hd">ยอดคงเหลือแยกคลัง</div>';
      if (!d.balances.length) h += '<div class="sb">ไม่มีของในคลังใด</div>';
      d.balances.forEach(function (b) {
        h += '<div class="row-i"><div class="nm">' + M.esc(b.locationName) + '</div>' +
          '<div class="qt">' + M.fmt(b.qty, 2) + ' <span class="sb">' + M.esc(d.unit) + '</span></div></div>';
      });
      h += '</div>';

      if (d.lots.length) {
        h += '<div class="card-m"><div class="hd">ล็อต (เรียงตามวันหมดอายุ)</div>';
        d.lots.forEach(function (l) {
          var bd = l.daysLeft === null ? '<span class="bdg b-mu">ไม่ระบุ</span>'
            : (l.daysLeft < 0 ? '<span class="bdg b-out">หมดอายุแล้ว</span>'
              : (l.daysLeft <= 30 ? '<span class="bdg b-ct">เหลือ ' + l.daysLeft + ' วัน</span>'
                : '<span class="bdg b-in">เหลือ ' + l.daysLeft + ' วัน</span>'));
          h += '<div class="row-i"><div><div class="nm mono">' + M.esc(l.lotNo || '-') + '</div>' +
            '<div class="sb">' + M.esc(l.locationName) + ' · ' + M.esc(l.expiryDate || 'ไม่ระบุวันหมดอายุ') +
            ' ' + bd + '</div></div>' +
            '<div class="qt">' + M.fmt(l.qty, 2) + '</div></div>';
        });
        h += '</div>';
      }

      if (d.recent.length) {
        h += '<div class="card-m"><div class="hd">เคลื่อนไหวล่าสุด</div>';
        d.recent.forEach(function (m) {
          h += '<div class="row-i"><div><div class="nm mono" style="font-size:12.5px">' + M.esc(m.docNo) + '</div>' +
            '<div class="sb">' + M.dt(m.ts) + '</div></div>' +
            '<div class="qt" style="color:' + (m.qty > 0 ? 'var(--green)' : 'var(--red)') + '">' +
            (m.qty > 0 ? '+' : '') + M.fmt(m.qty, 2) + '</div></div>';
        });
        h += '</div>';
      }
      $('#ckOut').html(h);
    }).catch(function (e) {
      M.beep('bad');
      $('#ckOut').html('<div class="empty"><i class="bi bi-question-circle"></i>' + M.esc(e.message) + '</div>');
    }).then(function () { M.busy(false); }, function () { M.busy(false); });
  }

  $('#ckIn').on('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var v = $(this).val(); $(this).val('');
    if (v) show(v);
  }).focus();
  $('#ckScan').on('click', function () { M.scan(show); });
};

/* ============================================================
   รับ-จ่าย-ตรวจนับ
   ============================================================ */
M.pages.move = function () {
  var locs = (M.boot.locations || []).filter(function (l) { return l.active !== false; });
  var labels = { in: 'รับเข้า', out: 'เบิก-จ่ายออก', count: 'ตรวจนับ' };

  $('#view').html(
    '<div class="card-m" style="padding:10px">' +
    '<div class="btn-group w-100" role="group">' +
    ['in', 'out', 'count'].map(function (k) {
      return '<button class="btn btn-sm ' + (M.mode === k ? 'btn-primary' : 'btn-light') +
        ' mvTab" data-k="' + k + '">' + labels[k] + '</button>';
    }).join('') +
    '</div>' +
    '<div class="mt-2"><label class="form-label">คลัง</label>' +
    '<select id="mvLoc" class="form-select form-select-sm">' +
    locs.map(function (l) {
      return '<option value="' + M.esc(l.id) + '"' + (l.id === M.locationId ? ' selected' : '') + '>' +
        M.esc(l.name) + '</option>';
    }).join('') + '</select></div>' +
    '</div>' +
    '<div class="scanbar">' +
    '<div class="lb" id="mvLb"></div>' +
    '<input id="mvIn" class="scan-in" placeholder="รอรับบาร์โค้ด...">' +
    '<button class="btn-scan" id="mvScan"><i class="bi bi-upc-scan"></i> เปิดสแกนเนอร์</button>' +
    '</div>' +
    '<div class="card-m"><div class="hd">รายการ (<span id="mvN">0</span>)</div><div id="mvList"></div></div>' +
    '<button class="btn btn-primary w-100 py-2 mb-2" id="mvSave">บันทึกเอกสาร</button>' +
    '<button class="btn btn-light w-100 py-2" id="mvClear">ล้างรายการ</button>');

  $('#mvLb').text(M.mode === 'count'
    ? 'ยิงสินค้าเพื่อสะสมยอดนับจริง (ยิงซ้ำ = นับเพิ่ม)'
    : 'ยิงบาร์โค้ดแล้วกด Enter · ยิงซ้ำ = บวกจำนวน');

  function draw() {
    $('#mvN').text(M.cart.length);
    if (!M.cart.length) {
      $('#mvList').html('<div class="empty"><i class="bi bi-upc-scan"></i>ยังไม่มีรายการ</div>');
      return;
    }
    var h = '';
    M.cart.forEach(function (it, i) {
      var sys = M.qtyAt(it.productId, M.locationId);
      var diff = M.n(it.qty) - sys;
      h += '<div class="row-i"><div style="flex:1;min-width:0">' +
        '<div class="nm">' + M.esc(it.name) + '</div>' +
        '<div class="sb">คงเหลือ ' + M.fmt(sys, 2) + ' ' + M.esc(it.unit) +
        (M.mode === 'count' && diff !== 0
          ? ' · <span class="bdg ' + (diff > 0 ? 'b-in' : 'b-out') + '">' + (diff > 0 ? '+' : '') + M.fmt(diff, 2) + '</span>'
          : '') +
        (it.trackLot && M.mode === 'in'
          ? ' · <span class="bdg ' + (it.lotNo ? 'b-ct' : 'b-out') + '" data-lot="' + i + '">' +
          (it.lotNo ? 'ล็อต ' + M.esc(it.lotNo) : 'ระบุล็อต') + '</span>'
          : '') +
        (it.trackSerial
          ? ' · <span class="bdg ' + ((it.serials || []).length ? 'b-in' : 'b-out') + '" data-ser="' + i + '">' +
          'ซีเรียล ' + (it.serials || []).length + '</span>'
          : '') +
        '</div>' +
        '<input class="form-control form-control-sm qin mvQ" data-i="' + i + '" type="number" step="any" value="' +
        M.n(it.qty) + '"' + (it.trackSerial ? ' readonly' : '') + '>' +
        '<button class="btn btn-light btn-sm mvX" data-i="' + i + '"><i class="bi bi-x-lg"></i></button>' +
        '</div>';
    });
    $('#mvList').html(h);
  }
  draw();

  function add(code) {
    var hit = M.lookup(code);
    if (!hit) {
      M.beep('bad');
      M.toast('ไม่พบบาร์โค้ด ' + code, 'bad');
      return;
    }
    var idx = -1;
    for (var i = 0; i < M.cart.length; i++) if (M.cart[i].productId === hit.productId) idx = i;
    if (idx > -1) {
      if (hit.trackSerial) { M.beep('dup'); M.serialSheet(idx, draw); return; }
      M.cart[idx].qty = M.n(M.cart[idx].qty) + (M.n(hit.perUnit) || 1);
      M.beep('dup'); draw(); return;
    }
    M.cart.unshift({
      productId: hit.productId, code: hit.code, name: hit.name, unit: hit.unit,
      qty: M.n(hit.perUnit) || 1,
      unitCost: M.n(hit.avgCost), price: M.n(hit.salePrice),
      trackLot: !!hit.trackLot, trackSerial: !!hit.trackSerial,
      shelfLifeDays: M.n(hit.shelfLifeDays),
      lotNo: '', expiryDate: '', serials: []
    });
    M.beep('ok');
    draw();
    if (M.cart[0].trackSerial) M.serialSheet(0, draw);
    else if (M.cart[0].trackLot && M.mode === 'in') M.lotSheet(0, draw);
  }

  $('#mvIn').on('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var v = $(this).val(); $(this).val('');
    if (v) add(v);
  }).focus();
  $('#mvScan').on('click', function () { M.scan(add); });

  $('#view').on('click', '.mvTab', function () {
    if (M.cart.length) { M.toast('ล้างรายการก่อนเปลี่ยนโหมด', 'bad'); return; }
    M.mode = $(this).data('k');
    M.route();
  });
  $('#view').on('change', '#mvLoc', function () { M.locationId = $(this).val(); draw(); });
  $('#view').on('input', '.mvQ', function () { M.cart[$(this).data('i')].qty = M.n($(this).val()); });
  $('#view').on('blur', '.mvQ', draw);
  $('#view').on('click', '.mvX', function () { M.cart.splice($(this).data('i'), 1); draw(); });
  $('#view').on('click', '[data-lot]', function () { M.lotSheet($(this).data('lot'), draw); });
  $('#view').on('click', '[data-ser]', function () { M.serialSheet($(this).data('ser'), draw); });

  $('#mvClear').on('click', function () {
    if (!M.cart.length) return;
    if (confirm('ล้างรายการทั้งหมด?')) { M.cart = []; draw(); }
  });

  $('#mvSave').on('click', function () {
    if (!M.cart.length) { M.toast('ยังไม่มีรายการ', 'bad'); return; }
    var missLot = M.cart.filter(function (x) { return x.trackLot && M.mode === 'in' && !x.lotNo; });
    if (missLot.length) { M.toast('ยังไม่ได้ระบุล็อตของ ' + missLot[0].name, 'bad'); return; }
    var missSer = M.cart.filter(function (x) { return x.trackSerial && !(x.serials || []).length; });
    if (missSer.length) { M.toast('ยังไม่ได้ยิงซีเรียลของ ' + missSer[0].name, 'bad'); return; }

    var head = { locationId: M.locationId, docDate: M.today(), note: 'บันทึกจากมือถือ' };
    var items, api;
    if (M.mode === 'count') {
      api = 'apiCreateCount';
      items = M.cart.map(function (x) { return { productId: x.productId, countQty: M.n(x.qty) }; });
    } else {
      api = M.mode === 'in' ? 'apiCreateStockIn' : 'apiCreateStockOut';
      items = M.cart.map(function (x) {
        return {
          productId: x.productId,
          qty: x.trackSerial ? (x.serials || []).length : M.n(x.qty),
          unitCost: M.n(x.unitCost), price: M.n(x.price),
          lotNo: x.lotNo || '', expiryDate: x.expiryDate || '',
          serials: x.trackSerial ? (x.serials || []) : []
        };
      });
    }
    if (!confirm('ยืนยันบันทึก ' + M.cart.length + ' รายการ?')) return;
    M.busy(true);
    M.call(api, [head, items])
      .then(function (r) {
        M.toast(r.message, 'ok');
        M.cart = [];
        return M.refreshIndex();
      })
      .then(function () { M.route(); })
      .catch(function (e) { M.toast(e.message, 'bad'); })
      .then(function () { M.busy(false); }, function () { M.busy(false); });
  });
};

/* ---- แผ่นระบุล็อต ---- */
M.lotSheet = function (i, done) {
  var it = M.cart[i];
  var exp = it.expiryDate;
  if (!exp && it.shelfLifeDays > 0) {
    exp = new Date(Date.now() + it.shelfLifeDays * 86400000).toISOString().slice(0, 10);
  }
  var lot = prompt('เลขล็อตของ ' + it.name, it.lotNo || '');
  if (lot === null) return;
  it.lotNo = String(lot).trim();
  var e2 = prompt('วันหมดอายุ (YYYY-MM-DD) เว้นว่างได้', exp || '');
  if (e2 !== null) it.expiryDate = String(e2).trim();
  done();
};

/* ---- แผ่นยิงซีเรียล ---- */
M.serialSheet = function (i, done) {
  var it = M.cart[i];
  $('#view').append(
    '<div id="serSheet" style="position:fixed;inset:0;z-index:120;background:var(--paper);overflow:auto">' +
    '<div class="appbar"><i class="bi bi-123"></i><div class="ttl">ซีเรียล</div>' +
    '<div class="who"><span id="serDone" style="font-size:15px">เสร็จ</span></div></div>' +
    '<div class="wrap">' +
    '<div class="scanbar"><div class="lb">' + M.esc(it.name) + ' — ยิงทีละชิ้น</div>' +
    '<input id="serIn" class="scan-in" placeholder="รอรับซีเรียล...">' +
    '<button class="btn-scan" id="serScan"><i class="bi bi-upc-scan"></i> เปิดสแกนเนอร์</button></div>' +
    '<div class="card-m"><div class="hd">เพิ่มแล้ว <span id="serN">0</span> ชิ้น</div>' +
    '<div id="serList"></div></div></div></div>');

  function draw() {
    $('#serN').text(it.serials.length);
    if (!it.serials.length) { $('#serList').html('<div class="empty">ยังไม่มีซีเรียล</div>'); return; }
    var h = '';
    it.serials.forEach(function (sn, k) {
      h += '<div class="row-i"><div class="nm mono">' + M.esc(sn) + '</div>' +
        '<button class="btn btn-light btn-sm serX qt" data-k="' + k + '"><i class="bi bi-x-lg"></i></button></div>';
    });
    $('#serList').html(h);
  }
  function addSn(v) {
    v = String(v || '').trim();
    if (!v) return;
    if (it.serials.filter(function (x) { return x.toUpperCase() === v.toUpperCase(); }).length) {
      M.beep('dup'); M.toast('ซีเรียลนี้เพิ่มไปแล้ว', 'bad'); return;
    }
    it.serials.push(v);
    it.qty = it.serials.length;
    M.beep('ok'); draw();
  }
  draw();
  $('#serIn').on('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addSn($(this).val()); $(this).val('');
  }).focus();
  $('#serScan').on('click', function () { M.scan(addSn); });
  $('#serSheet').on('click', '.serX', function () {
    it.serials.splice($(this).data('k'), 1); it.qty = it.serials.length; draw();
  });
  $('#serDone').on('click', function () {
    it.qty = it.serials.length;
    $('#serSheet').remove();
    done();
  });
};

/* ============================================================
   ใบสั่งซื้อ
   ============================================================ */
M.pages.po = function () {
  $('#view').html('<div class="empty"><div class="spinner-border spinner-border-sm"></div></div>');
  M.call('apiListPO', ['']).then(function (r) {
    var rows = (r.data || []).filter(function (x) {
      return x.status === 'open' || x.status === 'partial';
    });
    if (!rows.length) {
      $('#view').html('<div class="empty"><i class="bi bi-cart-check"></i>ไม่มีใบสั่งซื้อค้างรับ</div>');
      return;
    }
    var h = '';
    rows.forEach(function (x) {
      h += '<div class="card-m">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<div class="mono" style="font-weight:700">' + M.esc(x.docNo) + '</div>' +
        '<span class="bdg ' + (x.status === 'open' ? 'b-tr' : 'b-ct') + '">' +
        (x.status === 'open' ? 'เปิดอยู่' : 'รับบางส่วน') + '</span></div>' +
        '<div class="sb" style="margin-top:4px">' + M.esc((x.itemNames || []).join(', ')) + '</div>' +
        '<div class="row-i" style="border:none;padding-bottom:0">' +
        '<div class="sb">สั่ง ' + M.fmt(x.orderQty) + ' · รับแล้ว ' + M.fmt(x.recvQty) + '</div>' +
        '<div class="qt"><span class="bdg b-ct">ค้าง ' + M.fmt(x.pending) + '</span></div></div>' +
        '<button class="btn btn-primary w-100 mt-2 poGo" data-id="' + M.esc(x.id) + '">' +
        '<i class="bi bi-box-arrow-in-down"></i> รับเข้าตาม PO นี้</button>' +
        '</div>';
    });
    $('#view').html(h);
    $('#view').on('click', '.poGo', function () {
      var id = $(this).data('id');
      M.busy(true);
      M.call('apiGetPO', [id]).then(function (rr) {
        var d = rr.data;
        M.cart = [];
        M.mode = 'in';
        M.locationId = d.locationId || M.locationId;
        M._poId = id;
        (d.items || []).forEach(function (i) {
          if (i.pending <= 0) return;
          var hit = null;
          for (var c in M.index) if (M.index[c].productId === i.productId) { hit = M.index[c]; break; }
          if (!hit) return;
          M.cart.push({
            productId: i.productId, code: i.code, name: i.name, unit: i.unit,
            qty: i.pending, unitCost: M.n(i.unitCost), price: M.n(hit.salePrice),
            trackLot: !!hit.trackLot, trackSerial: !!hit.trackSerial,
            shelfLifeDays: M.n(hit.shelfLifeDays),
            lotNo: '', expiryDate: '', serials: []
          });
        });
        M.busy(false);
        M.toast('ดึงรายการค้างรับ ' + M.cart.length + ' รายการ', 'ok');
        location.hash = '#move';
      }).catch(function (e) { M.busy(false); M.toast(e.message, 'bad'); });
    });
  }).catch(function (e) { $('#view').html('<div class="empty">' + M.esc(e.message) + '</div>'); });
};

/* ============================================================
   ใกล้หมดอายุ
   ============================================================ */
M.pages.expiry = function () {
  $('#view').html('<div class="empty"><div class="spinner-border spinner-border-sm"></div></div>');
  M.call('apiReportExpiry', [30]).then(function (r) {
    var d = r.data;
    function block(title, rows, empty) {
      var h = '<div class="card-m"><div class="hd">' + title + '</div>';
      if (!rows.length) return h + '<div class="sb">' + empty + '</div></div>';
      rows.forEach(function (x) {
        h += '<div class="row-i"><div style="flex:1;min-width:0">' +
          '<div class="nm">' + M.esc(x.name) + '</div>' +
          '<div class="sb mono">' + M.esc(x.lotNo || '-') + ' · ' + M.esc(x.expiryDate) +
          ' · ' + M.esc(x.locationName) + '</div></div>' +
          '<div class="qt"><span class="bdg ' + (x.daysLeft < 0 ? 'b-out' : 'b-ct') + '">' +
          (x.daysLeft < 0 ? 'เกิน ' + Math.abs(x.daysLeft) + ' วัน' : x.daysLeft + ' วัน') + '</span>' +
          '<div class="sb">' + M.fmt(x.qty, 2) + '</div></div></div>';
      });
      return h + '</div>';
    }
    $('#view').html(
      '<div class="kpi">' +
      '<div class="k bad"><div class="kv">' + d.expired.length + '</div><div class="kl">หมดอายุแล้ว</div></div>' +
      '<div class="k warn"><div class="kv">' + d.soon.length + '</div><div class="kl">ใกล้หมดอายุ</div></div>' +
      '<div class="k"><div class="kv">' + M.fmt(d.expiredValue + d.soonValue) + '</div><div class="kl">มูลค่าเสี่ยง</div></div>' +
      '</div>' +
      block('หมดอายุแล้ว', d.expired, 'ไม่มี') +
      block('ใกล้หมดอายุใน ' + d.warnDays + ' วัน', d.soon, 'ไม่มี'));
  }).catch(function (e) { $('#view').html('<div class="empty">' + M.esc(e.message) + '</div>'); });
};

/* ============================================================
   บัญชี
   ============================================================ */
M.pages.me = function () {
  $('#view').html(
    '<div class="card-m">' +
    '<div style="font-size:17px;font-weight:700">' + M.esc(M.user.name) + '</div>' +
    '<div class="sb">' + M.esc(M.user.username) + ' · ' +
    M.esc(M.boot.roles[M.user.role] || M.user.role) + '</div>' +
    '<div class="sb" style="margin-top:8px">' +
    (M.inLine ? 'เปิดอยู่ใน LINE · ใช้สแกนเนอร์ของ LINE ได้' : 'เปิดในเบราว์เซอร์ · ใช้กล้องของเครื่อง') +
    '</div></div>' +
    '<div class="card-m"><div class="hd">คลังที่ใช้อยู่</div>' +
    '<select id="meLoc" class="form-select">' +
    (M.boot.locations || []).map(function (l) {
      return '<option value="' + M.esc(l.id) + '"' + (l.id === M.locationId ? ' selected' : '') + '>' +
        M.esc(l.name) + '</option>';
    }).join('') + '</select></div>' +
    (M.idToken ? '<button class="btn btn-light w-100 py-2 mb-2" id="meLink">' +
      '<i class="bi bi-link-45deg"></i> ผูกบัญชี LINE นี้กับผู้ใช้ปัจจุบัน</button>' : '') +
    '<button class="btn btn-light w-100 py-2 mb-2" id="meSync"><i class="bi bi-arrow-repeat"></i> ซิงก์ข้อมูลสินค้าใหม่</button>' +
    '<button class="btn btn-light w-100 py-2 text-danger" id="meOut">ออกจากระบบ</button>');

  $('#meLoc').on('change', function () { M.locationId = $(this).val(); M.toast('เปลี่ยนคลังแล้ว', 'ok'); });
  $('#meLink').on('click', function () {
    M.busy(true);
    M.call('apiLinkLine', [M.idToken])
      .then(function (r) { M.toast(r.message, 'ok'); })
      .catch(function (e) { M.toast(e.message, 'bad'); })
      .then(function () { M.busy(false); }, function () { M.busy(false); });
  });
  $('#meSync').on('click', function () {
    M.busy(true);
    M.refreshIndex()
      .then(function () { M.toast('ซิงก์ข้อมูลแล้ว', 'ok'); })
      .catch(function (e) { M.toast(e.message, 'bad'); })
      .then(function () { M.busy(false); }, function () { M.busy(false); });
  });
  $('#meOut').on('click', function () { if (confirm('ออกจากระบบ?')) M.logout(); });
};

/* ---------------- start ---------------- */
$(function () { M.boot0(); });
