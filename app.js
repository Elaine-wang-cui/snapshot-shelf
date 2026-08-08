const DB_NAME = 'snapshot-shelf';
const STORE = 'screenshots';
const DEFAULT_FOLDERS = ['未分类', '灵感', '工作', '生活'];

let db;
let items = [];
let folders = [...DEFAULT_FOLDERS];
let activeFolder = '全部';
let sortNewestFirst = true;
let draftFiles = [];
let editingId = null;
let statusTimer;
const objectUrls = new Set();

const $ = (selector) => document.querySelector(selector);
const gallery = $('#gallery');
const fileInput = $('#file-input');
const importDialog = $('#import-dialog');
const detailDialog = $('#detail-dialog');
const folderDialog = $('#folder-dialog');

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => { db = request.result; resolve(); };
    request.onerror = () => reject(request.error);
  });
}

function getAll() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(item) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function remove(id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function parseTags(value) {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return '不足 1 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function showStatus(message) {
  const status = $('#status-message');
  status.textContent = message;
  status.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('visible'), 3600);
}

async function updateStorageEstimate() {
  if (!navigator.storage?.estimate) return;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $('#quota-note').textContent = Number.isFinite(quota) ? `本机已用 ${formatBytes(usage || 0)} / 可用约 ${formatBytes(quota)}` : '';
  } catch {
    $('#quota-note').textContent = '';
  }
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadBackup() {
  if (!items.length) { showStatus('资料库还是空的，导入截图后再备份吧。'); return; }
  const records = [];
  for (const item of items) {
    const backupId = item.backupId || crypto.randomUUID();
    if (!item.backupId) { item.backupId = backupId; await put(item); }
    records.push({
      backupId,
      title: item.title,
      folder: item.folder,
      tags: item.tags || [],
      note: item.note || '',
      ocrText: item.ocrText || '',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      image: { name: item.image.name || `${item.title}.png`, type: item.image.type || 'image/png', dataUrl: await readAsDataUrl(item.image) },
    });
  }
  const payload = { app: 'snapshot-shelf', version: 1, exportedAt: new Date().toISOString(), records };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `拾图备份-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showStatus(`已导出 ${records.length} 张截图的备份文件。`);
}

async function restoreBackup(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.app !== 'snapshot-shelf' || backup.version !== 1 || !Array.isArray(backup.records)) throw new Error('invalid backup');
    const existing = new Set(items.map((item) => item.backupId).filter(Boolean));
    let restored = 0;
    let skipped = 0;
    for (const record of backup.records) {
      if (!record?.image?.dataUrl) { skipped += 1; continue; }
      const backupId = record.backupId || crypto.randomUUID();
      if (existing.has(backupId)) { skipped += 1; continue; }
      const response = await fetch(record.image.dataUrl);
      const image = new File([await response.blob()], record.image.name || '截图.png', { type: record.image.type || 'image/png' });
      await put({ image, backupId, title: record.title || '未命名截图', folder: record.folder || '未分类', tags: Array.isArray(record.tags) ? record.tags : [], note: record.note || '', ocrText: record.ocrText || '', createdAt: Number(record.createdAt) || Date.now(), updatedAt: Number(record.updatedAt) || Date.now() });
      existing.add(backupId);
      restored += 1;
    }
    items = await getAll();
    render();
    showStatus(restored ? `已恢复 ${restored} 张截图${skipped ? `，跳过 ${skipped} 条重复或无效记录` : ''}。` : '没有发现可恢复的新截图。');
  } catch (error) {
    console.error(error);
    showStatus('这个文件不是有效的拾图备份。');
  } finally {
    $('#restore-input').value = '';
  }
}

function createUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function cleanUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function imageTitle(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || '未命名截图';
}

function readableDate(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function updateFolderOptions() {
  for (const select of [$('#import-folder'), $('#detail-folder')]) {
    const current = select.value;
    select.innerHTML = folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join('');
    select.value = folders.includes(current) ? current : '未分类';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function renderFolders() {
  const counts = new Map(folders.map((folder) => [folder, 0]));
  items.forEach((item) => counts.set(item.folder || '未分类', (counts.get(item.folder || '未分类') || 0) + 1));
  const choices = [['全部', items.length], ...folders.map((folder) => [folder, counts.get(folder) || 0])];
  $('#folder-pills').innerHTML = choices.map(([folder, count]) => `<button type="button" class="folder-pill ${folder === activeFolder ? 'selected' : ''}" data-folder="${escapeHtml(folder)}">${escapeHtml(folder)} <small>${count}</small></button>`).join('');
}

function filteredItems() {
  const query = $('#search-input').value.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => {
    const inFolder = activeFolder === '全部' || item.folder === activeFolder;
    const words = [item.title, item.note, ...(item.tags || []), item.ocrText || ''].join(' ').toLocaleLowerCase();
    return inFolder && (!query || words.includes(query));
  });
  return filtered.sort((a, b) => sortNewestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
}

function renderGallery() {
  cleanUrls();
  const view = filteredItems();
  $('#library-kicker').textContent = activeFolder === '全部' ? '全部收集' : activeFolder;
  $('#library-title').textContent = $('#search-input').value.trim() ? `找到 ${view.length} 张` : '我的截图';
  if (!view.length) {
    gallery.replaceChildren($('#empty-state').content.cloneNode(true));
    return;
  }
  gallery.innerHTML = view.map((item) => `<article class="card"><img src="${createUrl(item.image)}" alt="${escapeHtml(item.title)}" /><div class="card-overlay"><span class="card-title">${escapeHtml(item.title)}</span><span class="card-meta">${escapeHtml(item.folder || '未分类')} · ${readableDate(item.createdAt)}</span></div><button type="button" class="card-button" data-item-id="${item.id}" aria-label="整理 ${escapeHtml(item.title)}">整理</button></article>`).join('');
}

function render() {
  folders = [...new Set([...DEFAULT_FOLDERS, ...items.map((item) => item.folder || '未分类'), ...folders])];
  updateFolderOptions();
  renderFolders();
  renderGallery();
  $('#storage-note').textContent = items.length ? `已收好 ${items.length} 张 · 只保存在这台设备` : '所有内容只保存在这台设备';
  updateStorageEstimate();
}

function clearDraft() {
  draftFiles.forEach((file) => { if (file.previewUrl) URL.revokeObjectURL(file.previewUrl); });
  draftFiles = [];
  fileInput.value = '';
}

function startImport(files) {
  clearDraft();
  draftFiles = [...files].filter((file) => file.type.startsWith('image/')).map((file) => ({ file, previewUrl: URL.createObjectURL(file) }));
  if (!draftFiles.length) return;
  $('#import-previews').innerHTML = draftFiles.map(({ file, previewUrl }) => `<div class="preview"><img src="${previewUrl}" alt="" /><span>${escapeHtml(imageTitle(file.name))}</span></div>`).join('');
  $('#import-folder').value = activeFolder !== '全部' ? activeFolder : '未分类';
  $('#import-tags').value = '';
  $('#import-note').value = '';
  importDialog.showModal();
}

async function saveDraft(event) {
  if (event.submitter?.value === 'cancel') { clearDraft(); return; }
  event.preventDefault();
  if (!draftFiles.length) return;
  const folder = $('#import-folder').value;
  const tags = parseTags($('#import-tags').value);
  const note = $('#import-note').value.trim();
  const timestamp = Date.now();
  await Promise.all(draftFiles.map(({ file }, offset) => put({
    image: file,
    title: imageTitle(file.name),
    folder,
    tags,
    note,
    ocrText: '',
    backupId: crypto.randomUUID(),
    createdAt: timestamp + offset,
    updatedAt: timestamp + offset,
  })));
  items = await getAll();
  clearDraft();
  importDialog.close();
  render();
}

function openDetails(id) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;
  editingId = id;
  const image = $('#detail-image');
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  image.dataset.objectUrl = URL.createObjectURL(item.image);
  image.src = image.dataset.objectUrl;
  image.alt = item.title;
  $('#detail-title').value = item.title;
  $('#detail-folder').value = item.folder || '未分类';
  $('#detail-tags').value = (item.tags || []).join(', ');
  $('#detail-note').value = item.note || '';
  detailDialog.showModal();
}

async function saveDetails(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const item = items.find((candidate) => candidate.id === editingId);
  if (!item) return;
  item.title = $('#detail-title').value.trim() || '未命名截图';
  item.folder = $('#detail-folder').value;
  item.tags = parseTags($('#detail-tags').value);
  item.note = $('#detail-note').value.trim();
  item.updatedAt = Date.now();
  await put(item);
  items = await getAll();
  detailDialog.close();
  render();
}

async function deleteEditing() {
  const item = items.find((candidate) => candidate.id === editingId);
  if (!item || !confirm(`确定删除“${item.title}”吗？删除后无法恢复。`)) return;
  await remove(editingId);
  items = await getAll();
  detailDialog.close();
  render();
}

function addFolder(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const name = $('#new-folder').value.trim();
  if (!name || folders.includes(name)) return;
  folders.push(name);
  $('#new-folder').value = '';
  folderDialog.close();
  render();
}

function bindEvents() {
  $('#add-button').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (event) => startImport(event.target.files));
  $('#import-form').addEventListener('submit', saveDraft);
  importDialog.addEventListener('close', clearDraft);
  $('#detail-form').addEventListener('submit', saveDetails);
  $('#delete-button').addEventListener('click', deleteEditing);
  $('#folder-form').addEventListener('submit', addFolder);
  $('#manage-folders').addEventListener('click', () => folderDialog.showModal());
  $('#backup-button').addEventListener('click', downloadBackup);
  $('#restore-input').addEventListener('change', (event) => restoreBackup(event.target.files[0]));
  $('#folder-pills').addEventListener('click', (event) => { const button = event.target.closest('[data-folder]'); if (button) { activeFolder = button.dataset.folder; render(); } });
  gallery.addEventListener('click', (event) => { const button = event.target.closest('[data-item-id]'); if (button) openDetails(Number(button.dataset.itemId)); if (event.target.closest('.empty-add')) fileInput.click(); });
  $('#search-input').addEventListener('input', renderGallery);
  $('#sort-button').addEventListener('click', () => { sortNewestFirst = !sortNewestFirst; $('#sort-button').innerHTML = `${sortNewestFirst ? '最新在前' : '最早在前'} <span aria-hidden="true">⌄</span>`; renderGallery(); });
  window.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); } });
}

async function init() {
  await openDatabase();
  items = await getAll();
  bindEvents();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init().catch((error) => { console.error(error); gallery.innerHTML = '<p class="empty-state">资料库暂时无法打开，请刷新页面再试。</p>'; });
