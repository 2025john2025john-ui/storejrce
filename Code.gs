/** Blue Marketplace - Google Apps Script backend */
const SPREADSHEET_ID = '1DU1fnQTq-YgUCBGW8wz6nQyjxzWzm-f5SoTMuPGfCX8';
const SENDER_NAME = 'BlueCart';
const SENDER_EMAIL = 'dev.jrce@gmail.com';
const PASSWORD_HASH_PREFIX = 'sha256$';
const ORDER_STATUSES = ['Pending','Paid','Preparing','Ready for Pickup','Ready for Delivery','Shipped','In Transit','Out for Delivery','Delivered','Delivery Attempt Failed','Delivery Rescheduled','Picked-up','Completed','Cancelled','Cancelled due to duplicate order'];

function doGet() { return jsonOut({ ok: true, message: 'Blue Marketplace API ready' }); }

function doPost(e) {
  try {
    const data = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action = data.action || '';
    switch (action) {
      case 'getBusinesses': return jsonOut(getBusinesses_());
      case 'getListings': return jsonOut(getListings_(data.businessID, data.includeInactive));
      case 'getBanners': return jsonOut(getBanners_());
      case 'placeOrder': return jsonOut(placeOrder_(data));
      case 'trackOrder': return jsonOut(trackOrder_(data.orderID));
      case 'sellerLogin': return jsonOut(sellerLogin_(data));
      case 'changeSellerPassword': return jsonOut(changeSellerPassword_(data));
      case 'getOrdersByBusiness': return jsonOut(getOrdersByBusiness_(data.businessID));
      case 'updateOrderStatus': return jsonOut(updateOrderStatus_(data.orderID, data.status, data.remark));
      case 'sendCheckoutEmail': return jsonOut(sendCheckoutEmail_(data));
      case 'deactivateListing': return jsonOut(deactivateListing_(data.businessID, data.listingID));
      case 'updateBusinessCouriers': return jsonOut(updateBusinessCouriers_(data.businessID, data.couriers));
      default: return jsonOut({ ok: false, message: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonOut({ ok: false, message: err.message, stack: err.stack });
  }
}

function getBusinesses_() { return getRows_('Businesses').filter(r => upper_(r.Status) === 'ACTIVE'); }
function getBanners_() { return getRows_('Banners').filter(r => String(r.BannerURL || '').trim()); }

function getListings_(businessID, includeInactive) {
  return getRows_('Listings').filter(r => {
    const byBusiness = businessID ? String(r.BusinessID) === String(businessID) : true;
    const isActive = upper_(r.Status) === 'ACTIVE';
    return byBusiness && (includeInactive ? true : isActive);
  });
}

function placeOrder_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getSheet_('Orders');
    const headers = getHeaders_(sh);
    const orderID = generateOrderID_();
    const nowText = formatTimelineTime_(new Date());
    const history = JSON.stringify([{ time: nowText, status: 'Pending' }]);
    const rowObj = {
      OrderID: orderID,
      BusinessID: data.BusinessID || '',
      Customer: data.Customer || '',
      Email: data.Email || '',
      Contact: data.Contact || '',
      Address: data.Address || '',
      Payment: data.Payment || '',
      Items: data.Items || '[]',
      Total: Number(data.Total || 0),
      Date: data.Date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      Mode: data.Mode || '',
      Courier: data.Courier || '',
      Proof: data.Proof || '',
      FinalAddr: data.FinalAddr || '',
      Status: 'Pending',
      StatusHistory: history
    };
    sh.appendRow(headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
    sendOrderEmail_(rowObj, data.SellerEmail || '', data.StoreName || 'Blue Marketplace');
    return { ok: true, orderID: orderID };
  } finally { lock.releaseLock(); }
}

function trackOrder_(orderID) { const order = getRows_('Orders').find(r => String(r.OrderID) === String(orderID)); return order || {}; }

function sellerLogin_(data) {
  const email = String(data.Email || '').trim().toLowerCase();
  const businessID = String(data.BusinessID || '').trim();
  const password = String(data.Password || '').trim();
  if (!email || !businessID || !password) return { ok: false, message: 'Email, BusinessID, and Password are required.' };
  const sh = getSheet_('Businesses');
  const headers = getHeaders_(sh);
  const values = sh.getDataRange().getValues();
  const emailIdx = headers.indexOf('Email');
  const businessIdx = headers.indexOf('BusinessID');
  const passwordIdx = headers.indexOf('Password');
  const statusIdx = headers.indexOf('Status');
  if (emailIdx < 0 || businessIdx < 0 || passwordIdx < 0 || statusIdx < 0) return { ok: false, message: 'Businesses header mismatch.' };
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const rowEmail = String(row[emailIdx] || '').trim().toLowerCase();
    const rowBusinessID = String(row[businessIdx] || '').trim();
    const rowPassword = String(row[passwordIdx] || '').trim();
    const rowStatus = upper_(row[statusIdx]);
    if (rowEmail !== email || rowBusinessID !== businessID || rowStatus !== 'ACTIVE') continue;
    const matched = verifyPassword_(password, rowPassword);
    if (!matched) return { ok: false, message: 'Invalid credentials or inactive account.' };
    if (!isHashedPassword_(rowPassword)) sh.getRange(r + 1, passwordIdx + 1).setValue(hashPassword_(password));
    recomputeWallet_(businessID);
    const refreshed = getRows_('Businesses').find(x => String(x.BusinessID) === String(businessID));
    return { ok: true, seller: refreshed || rowToObj_(headers, row) };
  }
  return { ok: false, message: 'Invalid credentials or inactive account.' };
}

function changeSellerPassword_(data) {
  const businessID = String(data.BusinessID || '').trim();
  const currentPassword = String(data.currentPassword || '').trim();
  const newPassword = String(data.newPassword || '').trim();
  if (!businessID || !currentPassword || !newPassword) return { ok: false, message: 'BusinessID, current password, and new password are required.' };
  if (newPassword.length < 8) return { ok: false, message: 'New password must be at least 8 characters.' };
  const sh = getSheet_('Businesses');
  const headers = getHeaders_(sh);
  const values = sh.getDataRange().getValues();
  const businessIdx = headers.indexOf('BusinessID');
  const passwordIdx = headers.indexOf('Password');
  if (businessIdx < 0 || passwordIdx < 0) return { ok: false, message: 'Businesses header mismatch.' };
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][businessIdx]) !== businessID) continue;
    const storedPassword = String(values[r][passwordIdx] || '');
    if (!verifyPassword_(currentPassword, storedPassword)) return { ok: false, message: 'Current password is incorrect.' };
    sh.getRange(r + 1, passwordIdx + 1).setValue(hashPassword_(newPassword));
    return { ok: true, message: 'Password updated successfully.' };
  }
  return { ok: false, message: 'Seller not found.' };
}

function updateBusinessCouriers_(businessID, couriers) {
  const cleanBusinessID = String(businessID || '').trim();
  if (!cleanBusinessID) return { ok: false, message: 'BusinessID is required.' };
  const normalized = sanitizeCouriers_(couriers);
  const sh = getSheet_('Businesses');
  const headers = getHeaders_(sh);
  const idCol = headers.indexOf('BusinessID') + 1;
  const couriersCol = headers.indexOf('Couriers') + 1;
  if (!idCol || !couriersCol) return { ok: false, message: 'Businesses header mismatch.' };
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) !== cleanBusinessID) continue;
    sh.getRange(r + 1, couriersCol).setValue(normalized.join(', '));
    return { ok: true, couriers: normalized };
  }
  return { ok: false, message: 'Seller not found.' };
}

function sanitizeCouriers_(couriers) {
  const source = Array.isArray(couriers) ? couriers : String(couriers || '').split(',');
  const unique = [];
  for (let i = 0; i < source.length; i++) {
    const clean = String(source[i] || '').trim();
    if (!clean) continue;
    if (unique.indexOf(clean) >= 0) continue;
    unique.push(clean);
    if (unique.length >= 3) break;
  }
  return unique;
}

function getOrdersByBusiness_(businessID) {
  return getRows_('Orders')
    .filter(r => String(r.BusinessID) === String(businessID))
    .sort((a,b)=>parseDateTime_(b.Date)-parseDateTime_(a.Date));
}

function updateOrderStatus_(orderID, status, remark) {
  const sh = getSheet_('Orders');
  const headers = getHeaders_(sh);
  const idCol = headers.indexOf('OrderID') + 1;
  const statusCol = headers.indexOf('Status') + 1;
  const historyCol = headers.indexOf('StatusHistory') + 1;
  if (!idCol || !statusCol || !historyCol) return { ok: false, message: 'Orders header mismatch.' };
  const values = sh.getDataRange().getValues();
  const cleanStatusRaw = String(status || '').trim();
  const cleanStatus = ORDER_STATUSES.indexOf(cleanStatusRaw) >= 0 ? cleanStatusRaw : cleanStatusRaw;
  const cleanRemark = String(remark || '').trim();
  const finalStatus = cleanRemark ? (cleanStatus + ', ' + cleanRemark) : cleanStatus;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) === String(orderID)) {
      sh.getRange(r + 1, statusCol).setValue(finalStatus);
      const currentHistoryRaw = values[r][historyCol - 1];
      const history = parseStatusHistory_(currentHistoryRaw);
      history.push({ time: formatTimelineTime_(new Date()), status: cleanStatus });
      sh.getRange(r + 1, historyCol).setValue(JSON.stringify(history));
      const rowObj = rowToObj_(headers, values[r]);
      rowObj.Status = finalStatus;
      rowObj.StatusRemark = cleanRemark;
      rowObj.StatusHistory = JSON.stringify(history);
      if (rowObj.Email) sendStatusEmail_(rowObj, getBusinessEmail_(rowObj.BusinessID));
      if (upper_(statusBase_(finalStatus)) === 'COMPLETED') recomputeWallet_(rowObj.BusinessID);
      return { ok: true };
    }
  }
  return { ok: false, message: 'Order not found.' };
}

function deactivateListing_(businessID, listingID) {
  const cleanBusinessID = String(businessID || '').trim();
  const cleanListingID = String(listingID || '').trim();
  if (!cleanBusinessID || !cleanListingID) return { ok: false, message: 'BusinessID and ListingID are required.' };

  const sh = getSheet_('Listings');
  const headers = getHeaders_(sh);
  const idCol = headers.indexOf('ListingID') + 1;
  const businessCol = headers.indexOf('BusinessID') + 1;
  const statusCol = headers.indexOf('Status') + 1;
  if (!idCol || !businessCol || !statusCol) return { ok: false, message: 'Listings header mismatch.' };

  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) === cleanListingID && String(values[r][businessCol - 1]) === cleanBusinessID) {
      sh.getRange(r + 1, statusCol).setValue('DEACTIVATED');
      return { ok: true };
    }
  }

  return { ok: false, message: 'Listing not found.' };
}


function sendCheckoutEmail_(data) {
  const orderIDs = String(data.orderIDs || '').trim();
  const customerEmail = firstValidEmail_(data.to || '');
  const sellerCc = normalizeCc_(data.sellerEmails || '');
  if (!customerEmail) return { ok: false, message: 'Missing or invalid customer email.' };
  const subject = 'Order Received - ' + (orderIDs || 'Order');
  const htmlBody = `<h3>Order Received - ${escapeHtml_(orderIDs || '-')}</h3><p>Order Details</p><p>Please monitor your order's status through the Cart Section using your Order ID.</p><p><b>Order ID:</b> ${escapeHtml_(orderIDs || '-')}</p>`;
  const sent = sendMailSafe_({ to: customerEmail, cc: sellerCc, subject: subject, htmlBody: htmlBody, replyTo: SENDER_EMAIL });
  return sent ? { ok: true } : { ok: false, message: 'Unable to send checkout email.' };
}

function sendOrderEmail_(orderObj, sellerEmail, storeName) {
  const customerEmail = firstValidEmail_(orderObj.Email || '');
  const sellerTo = firstValidEmail_(sellerEmail || '');
  const items = parseItems_(orderObj.Items);
  const itemsHtml = items.map(i => `<li>${formatRichTextHtml_(i.Name || 'Item')} × ${Number(i.Qty || 1)} — ₱${Number(i.Price || 0).toFixed(2)}</li>`).join('') || '<li>No item details</li>';
  const split = splitStatus_(orderObj.Status);
  const timelineHtml = renderTimelineHtml_(orderObj.StatusHistory);
  const subject = 'Order Received - ' + (orderObj.OrderID || 'Order');
  const htmlBody = `<h3>Order Received - ${escapeHtml_(orderObj.OrderID || '-')}</h3><p><b>Order Details</b></p><p><b>Store:</b> ${formatRichTextHtml_(storeName)}</p><p><b>Customer:</b> ${formatRichTextHtml_(orderObj.Customer)}</p><p><b>Contact:</b> ${formatRichTextHtml_(orderObj.Contact)}</p><p><b>Email:</b> ${formatRichTextHtml_(orderObj.Email)}</p><p><b>Address:</b> ${formatRichTextHtml_(orderObj.Address)}</p><p><b>Delivery/Pickup Address:</b> ${formatRichTextHtml_(orderObj.FinalAddr || orderObj.Address)}</p><p><b>Courier:</b> ${formatRichTextHtml_(orderObj.Courier || '-')}</p><p><b>Payment:</b> ${formatRichTextHtml_(orderObj.Payment)}</p><p><b>Mode:</b> ${formatRichTextHtml_(orderObj.Mode)}</p><p><b>Proof/Ref:</b> ${formatRichTextHtml_(orderObj.Proof || '-')}</p><p><b>Date:</b> ${formatRichTextHtml_(orderObj.Date)}</p><p><b>Status:</b> ${formatRichTextHtml_(split.status || '-')}</p><p><b>Remarks:</b> ${formatRichTextHtml_(split.remark || '-')}</p><p><b>Total:</b> ₱${Number(orderObj.Total || 0).toFixed(2)}</p><p><b>Timeline:</b></p>${timelineHtml}<p><b>Items:</b></p><ul>${itemsHtml}</ul><p>Please monitor your order's status through the Cart Section using your Order ID.</p>`;
  if (customerEmail) sendMailSafe_({ to: customerEmail, cc: sellerTo, subject: subject, htmlBody: htmlBody, replyTo: SENDER_EMAIL });
  if (sellerTo && sellerTo !== customerEmail) sendMailSafe_({ to: sellerTo, subject: subject, htmlBody: htmlBody, replyTo: SENDER_EMAIL });
  return { ok: true };
}

function sendStatusEmail_(orderObj, sellerEmail) {
  const customerEmail = firstValidEmail_(orderObj.Email || '');
  const sellerTo = firstValidEmail_(sellerEmail || '');
  if (!customerEmail && !sellerTo) return { ok: false, message: 'No valid recipient.' };
  const statusLabel = String(orderObj.Status || '');
  const parsed = splitStatus_(statusLabel);
  const remark = String(orderObj.StatusRemark || parsed.remark || '').trim();
  const timelineHtml = renderTimelineHtml_(orderObj.StatusHistory);
  const subject = 'Order Received - ' + (orderObj.OrderID || 'Order');
  const htmlBody = `<h3>ORDER STATUS UPDATE - ${escapeHtml_(orderObj.OrderID || '-')}</h3><p><b>Status:</b> ${formatRichTextHtml_(parsed.status || '-')}</p><p><b>Remarks:</b> ${formatRichTextHtml_(remark || '-')}</p><p><b>Payment:</b> ${formatRichTextHtml_(orderObj.Payment)}</p><p><b>Mode:</b> ${formatRichTextHtml_(orderObj.Mode)}</p><p><b>Delivery/Pickup Address:</b> ${formatRichTextHtml_(orderObj.FinalAddr || orderObj.Address)}</p><p><b>Total:</b> ₱${Number(orderObj.Total || 0).toFixed(2)}</p><p><b>Timeline:</b></p>${timelineHtml}<p>Please monitor your order's status through the Cart Section using your Order ID.</p>`;
  if (customerEmail) sendMailSafe_({ to: customerEmail, cc: sellerTo, subject: subject, htmlBody: htmlBody, replyTo: SENDER_EMAIL });
  if (sellerTo && sellerTo !== customerEmail) sendMailSafe_({ to: sellerTo, subject: subject, htmlBody: htmlBody, replyTo: SENDER_EMAIL });
  return { ok: true };
}

function recomputeWallet_(businessID) {
  const orders = getRows_('Orders').filter(r => String(r.BusinessID) === String(businessID) && upper_(statusBase_(r.Status)) === 'COMPLETED');
  const wallet = orders.reduce((sum, o) => sum + Number(o.Total || 0), 0);
  const sh = getSheet_('Businesses');
  const headers = getHeaders_(sh);
  const idCol = headers.indexOf('BusinessID') + 1;
  const walletCol = headers.indexOf('Wallet') + 1;
  if (!idCol || !walletCol) return;
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) === String(businessID)) { sh.getRange(r + 1, walletCol).setValue(wallet); break; }
  }
}

function parseDateTime_(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime();
  }
  const dt = new Date(raw);
  const t = dt.getTime();
  return Number.isNaN(t) ? 0 : t;
}

function parseStatusHistory_(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function formatTimelineTime_(dt) {
  return Utilities.formatDate(dt, 'Asia/Manila', 'M/d/yyyy, h:mm a');
}

function renderTimelineHtml_(raw) {
  const history = parseStatusHistory_(raw);
  if (!history.length) return '<p>-</p>';
  return '<table style="border-collapse:collapse;width:100%;max-width:420px">' + history.map(function(item){
    var status = statusBase_(item.status || '');
    return '<tr><td style="padding:4px 8px;border-left:2px solid #bfdbfe"><span style="font-size:12px;color:#6b7280">' + escapeHtml_(item.time || '-') + '</span><br><b style="color:#0d47a1">' + escapeHtml_(status || '-') + '</b></td></tr>';
  }).join('') + '</table>';
}

function generateOrderID_() { const datePart = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss'); const randPart = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); return `ORD-${datePart}-${randPart}`; }
function getRows_(sheetName) { const sh = getSheet_(sheetName); const values = sh.getDataRange().getValues(); if (values.length < 2) return []; const headers = values[0]; return values.slice(1).map(row => rowToObj_(headers, row)); }
function rowToObj_(headers, row) { const obj = {}; headers.forEach((h, i) => obj[h] = row[i]); return obj; }
function parseItems_(raw) { try { return JSON.parse(raw || '[]'); } catch (e) { return []; } }
function getSheet_(name) { const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); if (!sh) throw new Error('Missing sheet: ' + name); return sh; }
function getHeaders_(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }
function upper_(v) { return String(v || '').trim().toUpperCase(); }
function hashPassword_(password) { const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password), Utilities.Charset.UTF_8); const hex = bytes.map(b => { const v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join(''); return PASSWORD_HASH_PREFIX + hex; }
function isHashedPassword_(stored) { return String(stored || '').indexOf(PASSWORD_HASH_PREFIX) === 0; }
function verifyPassword_(plainPassword, storedPassword) { const stored = String(storedPassword || ''); if (!stored) return false; if (isHashedPassword_(stored)) return hashPassword_(plainPassword) === stored; return String(plainPassword) === stored; }
function escapeHtml_(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function formatRichTextHtml_(value) { const escaped = escapeHtml_(value); const linkified = escaped.replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/(^|\s)([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?=$|\s)/gi, function(_, prefix, email){ return prefix + '<a href="mailto:' + email + '">' + email + '</a>'; }); return linkified.replace(/\r?\n/g, '<br>'); }
function splitStatus_(statusValue) { const raw = String(statusValue || '').trim(); if (!raw) return { status: '', remark: '' }; const commaIdx = raw.indexOf(','); const colonIdx = raw.indexOf(':'); let idx = -1; if (commaIdx >= 0 && colonIdx >= 0) idx = Math.min(commaIdx, colonIdx); else idx = commaIdx >= 0 ? commaIdx : colonIdx; if (idx < 0) return { status: raw, remark: '' }; return { status: raw.slice(0, idx).trim(), remark: raw.slice(idx + 1).trim() }; }
function statusBase_(statusValue) { return splitStatus_(statusValue).status; }
function getBusinessEmail_(businessID) { if (!businessID) return ''; const business = getRows_('Businesses').find(r => String(r.BusinessID) === String(businessID)); return business ? String(business.Email || '').trim() : ''; }
function emailParts_(emails) { return String(emails || '').split(/[\n,;]+/).map(e => e.trim()).filter(Boolean); }
function firstValidEmail_(emails) { const list = emailParts_(emails); const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; for (let i = 0; i < list.length; i++) { if (re.test(list[i])) return list[i]; } return ''; }
function normalizeCc_(emails) { const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; const list = emailParts_(emails).filter(e => re.test(e)); return list.filter((e, i) => list.indexOf(e) === i).join(','); }
function sendMailSafe_(options) { try { const payload = { to: options.to, subject: String(options.subject || ''), htmlBody: String(options.htmlBody || ''), name: SENDER_NAME, replyTo: options.replyTo || SENDER_EMAIL }; const cc = normalizeCc_(options.cc || ''); if (cc) payload.cc = cc; MailApp.sendEmail(payload); return true; } catch (err) { console.error('MailApp error: ' + err.message); return false; } }
function jsonOut(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
