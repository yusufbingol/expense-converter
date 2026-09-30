import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';
import './classification.css';
import './manual.css';
import { CATEGORY_OPTIONS, downloadTsv, formatUserAmount, isAllowedCategory, makeExportRow, parseUserAmount, toDisplayDate, toExportDate, validateManualTransaction } from './shared.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const storageKey = 'enpara-money-manager.merchant-mappings.v1';
const state = { mappings: new Map(), parsed: [], included: [], skipped: { installments: 0, negatives: 0, unrecognized: 0 }, skippedDescriptions: new Set(), unknown: [], unknownIndex: 0, importActive: false, manualEntries: [], editingManualId: null, editingReviewId: null };
const $ = (selector) => document.querySelector(selector);
const els = {
  input: $('#pdf-input'), dropZone: $('#drop-zone'), upload: $('#upload-panel'), processing: $('#processing-panel'), processingMessage: $('#processing-message'), classification: $('#classification-panel'), review: $('#review-panel'), reviewCopy: $('#review-copy'), empty: $('#empty-state'), importSession: $('#import-session-panel'), importSessionTitle: $('#import-session-title'), importSessionCopy: $('#import-session-copy'), unknownDescription: $('#unknown-description'), unknownProgress: $('#unknown-progress'), classificationCopy: $('#classification-copy'), classificationTransactions: $('#classification-transactions'), classificationForm: $('#classification-form'), merchantName: $('#merchant-name'), merchantCategory: $('#merchant-category'), categoryOptions: $('#category-options'), reviewBody: $('#review-body'), summaryCards: $('#summary-cards'), toast: $('#toast'), merchantCount: $('#merchant-count'), merchantBody: $('#merchant-body'), merchantSearch: $('#merchant-search'), merchantTable: $('#merchant-table-wrap'), merchantsEmpty: $('#merchants-empty'), clearAll: $('#clear-all'), manualForm: $('#manual-form'), manualDate: $('#manual-date'), manualCategory: $('#manual-category'), manualNote: $('#manual-note'), manualAmount: $('#manual-amount'), manualDescription: $('#manual-description'), manualError: $('#manual-error'), manualFormTitle: $('#manual-form-title'), saveManual: $('#save-manual'), cancelManualEdit: $('#cancel-manual-edit'), manualBody: $('#manual-body'), manualTable: $('#manual-table-wrap'), manualEmpty: $('#manual-empty'), manualSummary: $('#manual-summary'), exportManual: $('#export-manual'), reviewEditDialog: $('#review-edit-dialog'), reviewEditForm: $('#review-edit-form'), reviewEditDate: $('#review-edit-date'), reviewEditCategory: $('#review-edit-category'), reviewEditNote: $('#review-edit-note'), reviewEditAmount: $('#review-edit-amount'), reviewEditError: $('#review-edit-error')
};

function readMappings() {
  try {
    const values = JSON.parse(localStorage.getItem(storageKey) || '[]');
    state.mappings = new Map(values.filter(x => x?.description && x?.name && x?.category).map(x => [x.description, x]));
  } catch { state.mappings = new Map(); }
  updateMappingUi();
}
function persistMappings() { localStorage.setItem(storageKey, JSON.stringify([...state.mappings.values()])); updateMappingUi(); }
function updateMappingUi() {
  els.merchantCount.textContent = String(state.mappings.size);
  renderMerchantTable();
}
function populateCategoryControls() {
  const categoryOptions = CATEGORY_OPTIONS.map(category => Object.assign(document.createElement('option'), { value: category, textContent: category }));
  els.merchantCategory.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Choose a category' }), ...categoryOptions.map(option => option.cloneNode(true)));
  els.manualCategory.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Choose a category' }), ...categoryOptions.map(option => option.cloneNode(true)));
  els.reviewEditCategory.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Choose a category' }), ...categoryOptions.map(option => option.cloneNode(true)));
  els.categoryOptions.replaceChildren(...categoryOptions.map(option => option.cloneNode(true)));
}
function showToast(message) { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2800); }
function normalizeSpace(text) { return text.replace(/\s+/g, ' ').trim(); }
function parseAmount(raw) { return Number(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '')); }
function formatAmount(amount) { return formatUserAmount(amount, true); }

// Builds visual lines from PDF text rather than relying on a fixed page coordinate.
function pageToLines(items) {
  const positioned = items.filter(item => item.str?.trim()).map((item, index) => ({ text: item.str, x: item.transform[4], y: item.transform[5], index }));
  const rows = [];
  for (const item of positioned) {
    let row = rows.find(candidate => Math.abs(candidate.y - item.y) < 2.4);
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  return rows.sort((a,b) => b.y - a.y).map(row => normalizeSpace(row.items.sort((a,b) => a.x - b.x || a.index - b.index).map(i => i.text).join(' ')));
}
function looksLikeNoise(text) {
  return /^(işlem tarihi|açıklama|taksit|tutar|sayfa |enpara\.com|www\.|müşteri|kart no|ekstre tarihi|son ekstre borcu|güncel dönem borcu|toplam borç|ödeme tarihi|hesap kesim|türkiye finans)/i.test(text);
}
function parseTransactionLine(line) {
  const date = line.match(/(?:^|\s)(\d{2}\/\d{2}\/\d{4})(?=\s|$)/)?.[1];
  if (!date || looksLikeNoise(line)) return null;
  const remainder = normalizeSpace(line.slice(line.indexOf(date) + date.length));
  const installmentMatch = remainder.match(/(?:^|\s)(\d{1,2}\s*\/\s*\d{1,2})(?=\s|$)/);
  // Remove the installment token first. That avoids interpreting a row like "1/3 551,83"
  // as the Turkish amount "3 551,83" when PDF text inserts a space for a table column.
  const amountSource = installmentMatch ? remainder.replace(installmentMatch[0], ' ') : remainder;
  // Turkish currency cells may have thousands dots or whitespace inserted by extraction.
  const amountMatch = amountSource.match(/(-?\s*\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\s*\d+,\d{2})\s*(?:TL|₺)\b/i);
  if (!amountMatch) return null;
  const beforeAmount = normalizeSpace(amountSource.slice(0, amountMatch.index));
  const description = beforeAmount;
  if (!description || description.length < 2) return null;
  return { date, description, installment: installmentMatch?.[1]?.replace(/\s/g, '') || null, amount: parseAmount(amountMatch[1]), raw: line };
}
function parseEnparaLines(lines) {
  const candidates = [];
  // Normal Enpara statements put each row on one visual line. A fallback joins a date line
  // with its next two fragments, handling PDFs that split long descriptions/amounts.
  for (let index = 0; index < lines.length; index++) {
    const source = [lines[index], lines[index + 1], lines[index + 2]].filter(Boolean);
    let transaction = null;
    for (let length = 1; length <= source.length; length++) {
      transaction = parseTransactionLine(normalizeSpace(source.slice(0, length).join(' ')));
      if (transaction) break;
    }
    if (transaction) candidates.push(transaction);
  }
  return candidates.filter((transaction, index, list) => index === 0 || transaction.raw !== list[index - 1].raw);
}
async function extractTransactions(file) {
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let rows = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    els.processingMessage.textContent = `Reading page ${pageNumber} of ${document.numPages} locally.`;
    const content = await (await document.getPage(pageNumber)).getTextContent();
    rows = rows.concat(parseEnparaLines(pageToLines(content.items)));
  }
  return rows;
}
function filterTransactions(rows) {
  const included = []; const skipped = { installments: 0, negatives: 0, unrecognized: 0 };
  for (const row of rows) {
    if (!Number.isFinite(row.amount)) { skipped.unrecognized++; continue; }
    if (row.amount < 0 || /^ödeme\b/i.test(row.description)) { skipped.negatives++; continue; }
    if (row.installment) { skipped.installments++; continue; }
    included.push(row);
  }
  return { included, skipped };
}
async function handleFile(file) {
  if (!file || !/\.pdf$/i.test(file.name)) { showToast('Please choose a PDF statement.'); return; }
  if (state.importActive && !confirm('Start a new import? Your current statement session, including pending classifications, will be replaced. Saved merchant mappings will remain.')) { els.input.value = ''; return; }
  resetPanels(); els.upload.classList.add('hidden'); els.processing.classList.remove('hidden');
  try {
    const parsed = await extractTransactions(file);
    const filtered = filterTransactions(parsed);
    state.parsed = parsed; state.included = filtered.included.map(transaction => ({ ...transaction, id: crypto.randomUUID(), override: null })); state.skipped = filtered.skipped; state.skippedDescriptions = new Set(); state.importActive = Boolean(state.included.length);
    state.unknown = [...new Set(state.included.map(t => t.description))].filter(description => !state.mappings.has(description));
    state.unknownIndex = 0;
    els.processing.classList.add('hidden');
    if (!state.included.length) { state.importActive = false; els.upload.classList.remove('hidden'); els.empty.classList.remove('hidden'); showToast('No supported purchase rows were found in this PDF.'); return; }
    state.unknown.length ? showClassification() : showReview();
  } catch (error) {
    console.error(error); els.processing.classList.add('hidden'); els.upload.classList.remove('hidden'); els.empty.classList.remove('hidden'); showToast('The PDF could not be read. Please use an Enpara card statement PDF.');
  }
}
function resetPanels() { els.classification.classList.add('hidden'); els.review.classList.add('hidden'); els.empty.classList.add('hidden'); els.processing.classList.add('hidden'); }
function getExportableImportTransactions() { return state.included.filter(transaction => state.mappings.has(transaction.description)); }
function getPendingImportTransactions() { return state.included.filter(transaction => !state.mappings.has(transaction.description)); }
function makeImportExportRow(transaction) {
  const mapping = state.mappings.get(transaction.description);
  const override = transaction.override || {};
  return makeExportRow({
    date: override.date || toDisplayDate(transaction.date),
    category: override.category || mapping.category,
    note: override.note || mapping.name,
    amount: override.amount ?? transaction.amount,
    description: transaction.description
  });
}
function showImportLanding() {
  resetPanels(); els.upload.classList.remove('hidden'); els.empty.classList.toggle('hidden', state.importActive);
  els.importSession.classList.toggle('hidden', !state.importActive);
  if (!state.importActive) return;
  const pending = getPendingImportTransactions().length, eligible = getExportableImportTransactions().length;
  els.importSessionTitle.textContent = `${state.included.length} supported purchases in this statement`;
  els.importSessionCopy.textContent = `${eligible} eligible for export${pending ? ` · ${pending} still need classification` : ' · all remaining purchases are classified'}.`;
  $('#resume-import').textContent = pending ? 'Resume classification' : 'Open review';
}
function showClassification() {
  resetPanels(); els.upload.classList.add('hidden'); els.importSession.classList.add('hidden');
  els.classification.classList.remove('hidden');
  const description = state.unknown[state.unknownIndex];
  const transactions = state.included.filter(transaction => transaction.description === description);
  els.unknownDescription.textContent = description;
  els.unknownProgress.textContent = `${state.unknownIndex + 1} / ${state.unknown.length}`;
  els.classificationCopy.textContent = `${transactions.length} transaction${transactions.length === 1 ? '' : 's'} will use this mapping. This exact description has not been saved before.`;
  els.classificationTransactions.replaceChildren(...transactions.map(transaction => {
    const item = document.createElement('div'); item.className = 'classification-transaction';
    const date = document.createElement('span'); date.textContent = toDisplayDate(transaction.date);
    const amount = document.createElement('span'); amount.className = 'transaction-amount'; amount.textContent = formatAmount(transaction.amount);
    item.append(date, amount); return item;
  }));
  els.merchantName.value = ''; els.merchantCategory.value = ''; els.merchantName.focus();
}
function advanceClassification() {
  state.unknownIndex++;
  if (state.unknownIndex < state.unknown.length) { showClassification(); return; }
  els.classification.classList.add('hidden'); showReview();
}
function showReview() {
  resetPanels(); els.upload.classList.add('hidden'); els.importSession.classList.add('hidden');
  els.review.classList.remove('hidden');
  const exportable = getExportableImportTransactions();
  const pending = getPendingImportTransactions();
  els.reviewCopy.textContent = pending.length ? `${pending.length} transaction${pending.length === 1 ? '' : 's'} still need classification and will not be included. Only the eligible transactions below will be written to import.tsv.` : 'Only the transactions below will be written to import.tsv.';
  const cards = [
    ['Parsed rows', state.parsed.length], ['Eligible for export', exportable.length], ['Pending classification', pending.length], ['Skipped installments', state.skipped.installments], ['Skipped payments / credits', state.skipped.negatives]
  ];
  els.summaryCards.replaceChildren(...cards.map(([label,value]) => { const card=document.createElement('div'); card.className='summary-card'; card.innerHTML=`<span>${label}</span><strong>${value}</strong>`; return card; }));
  els.reviewBody.replaceChildren(...exportable.map(transaction => { const data = makeImportExportRow(transaction); const row=document.createElement('tr'); row.dataset.id = transaction.id; [data.date,data.description,data.note,data.category].forEach((value,index)=>{const cell=document.createElement('td');cell.textContent=value;if(index===1)cell.className='description-cell';row.append(cell)});const amount=document.createElement('td');amount.className='amount-cell';amount.textContent=formatAmount(data.amount);row.append(amount);const actions=document.createElement('td');actions.className='review-row-actions';actions.innerHTML='<button class="review-edit" type="button">Edit</button><button class="review-delete" type="button">Delete</button>';row.append(actions);return row;}));
  els.exportButton = $('#export-button'); els.exportButton.disabled = !exportable.length; els.exportButton.title = exportable.length ? '' : 'Classify a merchant before exporting.';
  const resumeButton = $('#resume-from-review'); resumeButton.disabled = !pending.length; resumeButton.title = pending.length ? '' : 'No unclassified transactions remain.';
}
function exportTsv() {
  const rows = getExportableImportTransactions().map(makeImportExportRow);
  if (!rows.length) { showToast('Classify at least one merchant before exporting.'); return; }
  downloadTsv(rows); showToast(`Downloaded ${rows.length} transactions as import.tsv.`);
}
function openReviewEdit(id) {
  const transaction = state.included.find(item => item.id === id); if (!transaction || !state.mappings.has(transaction.description)) return;
  const data = makeImportExportRow(transaction);
  state.editingReviewId = id;
  els.reviewEditDate.value = data.date; els.reviewEditCategory.value = data.category; els.reviewEditNote.value = data.note; els.reviewEditAmount.value = formatUserAmount(data.amount);
  els.reviewEditError.classList.add('hidden'); els.reviewEditDialog.showModal(); els.reviewEditDate.focus();
}
function closeReviewEdit() { state.editingReviewId = null; els.reviewEditDialog.close(); }
function saveReviewEdit() {
  const date = toExportDate(els.reviewEditDate.value), category = els.reviewEditCategory.value, note = els.reviewEditNote.value.trim(), amount = parseUserAmount(els.reviewEditAmount.value);
  if (!date) { els.reviewEditError.textContent = 'Enter a valid date in DD/MM/YYYY format.'; els.reviewEditError.classList.remove('hidden'); return; }
  if (!isAllowedCategory(category)) { els.reviewEditError.textContent = 'Choose a category.'; els.reviewEditError.classList.remove('hidden'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { els.reviewEditError.textContent = 'Enter an amount greater than zero.'; els.reviewEditError.classList.remove('hidden'); return; }
  const transaction = state.included.find(item => item.id === state.editingReviewId); if (!transaction) return;
  transaction.override = { date, category, note: note || transaction.description, amount };
  closeReviewEdit(); showReview(); showToast('Transaction updated for this import.');
}
function deleteReviewTransaction(id) {
  state.included = state.included.filter(transaction => transaction.id !== id);
  showReview(); showToast('Transaction removed from this import.');
}
function renderMerchantTable() {
  if (!els.merchantBody) return;
  const query = els.merchantSearch?.value?.trim().toLocaleLowerCase('tr-TR') || '';
  const mappings = [...state.mappings.values()].sort((a,b)=>a.description.localeCompare(b.description,'tr')).filter(mapping => !query || `${mapping.description} ${mapping.name} ${mapping.category}`.toLocaleLowerCase('tr-TR').includes(query));
  els.merchantTable.classList.toggle('hidden', !mappings.length); els.merchantsEmpty.classList.toggle('hidden', state.mappings.size > 0); els.clearAll.classList.toggle('hidden', !state.mappings.size);
  els.merchantBody.replaceChildren(...mappings.map(mapping => { const row=$('#merchant-row-template').content.firstElementChild.cloneNode(true); row.dataset.description=mapping.description; row.querySelector('.description-cell').textContent=mapping.description; row.querySelector('.mapping-name').value=mapping.name; row.querySelector('.mapping-category').value=mapping.category; return row; }));
}
function resetImport() { state.parsed=[];state.included=[];state.skippedDescriptions=new Set();state.unknown=[];state.unknownIndex=0;state.importActive=false;els.input.value=''; showImportLanding(); }
function resetManualForm() {
  state.editingManualId = null;
  els.manualForm.reset();
  els.manualError.classList.add('hidden');
  els.manualFormTitle.textContent = 'Add a manual expense';
  els.saveManual.textContent = 'Add transaction';
  els.cancelManualEdit.classList.add('hidden');
}
function renderManualEntries() {
  const entries = state.manualEntries;
  els.manualEmpty.classList.toggle('hidden', entries.length > 0);
  els.manualTable.classList.toggle('hidden', !entries.length);
  els.exportManual.classList.toggle('hidden', !entries.length);
  els.manualSummary.textContent = entries.length ? `${entries.length} manual transaction${entries.length === 1 ? '' : 's'} ready to export.` : 'Add an expense to begin.';
  els.manualBody.replaceChildren(...entries.map(entry => {
    const row = document.createElement('tr'); row.dataset.id = entry.id;
    [entry.date, entry.category, entry.note, entry.description].forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value; if (index === 3) cell.className = 'description-cell'; row.append(cell);
    });
    const amount = document.createElement('td'); amount.className = 'amount-cell'; amount.textContent = formatAmount(entry.amount); row.append(amount);
    const actions = document.createElement('td'); actions.className = 'manual-actions'; actions.innerHTML = '<button class="manual-edit" type="button">Edit</button><button class="manual-delete" type="button">Delete</button>'; row.append(actions);
    return row;
  }));
}
function editManualEntry(id) {
  const entry = state.manualEntries.find(item => item.id === id); if (!entry) return;
  state.editingManualId = id;
  els.manualDate.value = entry.date; els.manualCategory.value = entry.category; els.manualNote.value = entry.note; els.manualAmount.value = formatUserAmount(entry.amount); els.manualDescription.value = entry.description;
  els.manualError.classList.add('hidden'); els.manualFormTitle.textContent = 'Edit manual expense'; els.saveManual.textContent = 'Save changes'; els.cancelManualEdit.classList.remove('hidden'); els.manualDate.focus();
}
function saveManualEntry() {
  const result = validateManualTransaction({ date: els.manualDate.value, category: els.manualCategory.value, note: els.manualNote.value, amount: els.manualAmount.value, description: els.manualDescription.value });
  if (result.error) { els.manualError.textContent = result.error; els.manualError.classList.remove('hidden'); return; }
  const wasEditing = Boolean(state.editingManualId);
  const entry = { ...result.value, id: state.editingManualId || crypto.randomUUID() };
  if (wasEditing) state.manualEntries = state.manualEntries.map(item => item.id === entry.id ? entry : item);
  else state.manualEntries.push(entry);
  renderManualEntries(); resetManualForm(); showToast(wasEditing ? 'Manual transaction updated.' : 'Manual transaction added.');
}
function exportManualEntries() {
  const rows = state.manualEntries.map(entry => makeExportRow(entry));
  if (!rows.length) return;
  downloadTsv(rows); showToast(`Downloaded ${rows.length} manual transaction${rows.length === 1 ? '' : 's'} as import.tsv.`);
}

document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.nav-button').forEach(x=>x.classList.toggle('active',x===button)); document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id===`${button.dataset.view}-view`)); if (button.dataset.view === 'import') showImportLanding(); }));
els.input.addEventListener('change', event => handleFile(event.target.files[0]));
['dragenter','dragover'].forEach(type=>els.dropZone.addEventListener(type,event=>{event.preventDefault();els.dropZone.classList.add('dragging')}));
['dragleave','drop'].forEach(type=>els.dropZone.addEventListener(type,event=>{event.preventDefault();els.dropZone.classList.remove('dragging')}));
els.dropZone.addEventListener('drop', event=>handleFile(event.dataTransfer.files[0]));
els.classificationForm.addEventListener('submit', event => { event.preventDefault(); const description=state.unknown[state.unknownIndex],category=els.merchantCategory.value.trim(); if(!category){showToast('A category is required.');return;} const name=els.merchantName.value.trim() || description; state.mappings.set(description,{description,name,category}); persistMappings(); advanceClassification(); });
$('#skip-merchant').addEventListener('click', () => { const description = state.unknown[state.unknownIndex]; const skippedCount = state.included.filter(transaction => transaction.description === description).length; state.skippedDescriptions.add(description); state.included = state.included.filter(transaction => transaction.description !== description); showToast(`${skippedCount} transaction${skippedCount === 1 ? '' : 's'} skipped for this import.`); advanceClassification(); });
$('#cancel-import').addEventListener('click',resetImport); $('#new-import').addEventListener('click',resetImport); $('#export-button').addEventListener('click',exportTsv); $('#review-from-classification').addEventListener('click',showReview); $('#review-import').addEventListener('click',showReview); $('#resume-import').addEventListener('click', () => getPendingImportTransactions().length ? showClassification() : showReview()); $('#resume-from-review').addEventListener('click', () => { if (getPendingImportTransactions().length) showClassification(); });
els.merchantSearch.addEventListener('input',renderMerchantTable);
els.reviewBody.addEventListener('click', event => { const row = event.target.closest('tr'); if (!row) return; if (event.target.closest('.review-edit')) openReviewEdit(row.dataset.id); if (event.target.closest('.review-delete')) deleteReviewTransaction(row.dataset.id); });
els.reviewEditForm.addEventListener('submit', event => { event.preventDefault(); saveReviewEdit(); });
$('#close-review-edit').addEventListener('click', closeReviewEdit); $('#cancel-review-edit').addEventListener('click', closeReviewEdit);
els.merchantBody.addEventListener('click',event=>{ const row=event.target.closest('tr'); if(!row)return; const description=row.dataset.description; if(event.target.closest('.save-mapping')) { const name=row.querySelector('.mapping-name').value.trim() || description,category=row.querySelector('.mapping-category').value.trim(); if(!category){showToast('A category is required.');return;} state.mappings.set(description,{description,name,category});persistMappings();showToast('Merchant mapping saved.'); } if(event.target.closest('.delete-mapping')) { state.mappings.delete(description);persistMappings();showToast('Merchant mapping deleted.'); } });
els.clearAll.addEventListener('click',()=>{ if(confirm('Delete every saved merchant mapping from this browser?')){state.mappings.clear();persistMappings();showToast('All saved mappings deleted.');} });
els.manualForm.addEventListener('submit', event => { event.preventDefault(); saveManualEntry(); });
els.cancelManualEdit.addEventListener('click', resetManualForm);
els.manualBody.addEventListener('click', event => { const row = event.target.closest('tr'); if (!row) return; if (event.target.closest('.manual-edit')) editManualEntry(row.dataset.id); if (event.target.closest('.manual-delete')) { state.manualEntries = state.manualEntries.filter(entry => entry.id !== row.dataset.id); if (state.editingManualId === row.dataset.id) resetManualForm(); renderManualEntries(); showToast('Manual transaction deleted.'); } });
els.exportManual.addEventListener('click', exportManualEntries);
populateCategoryControls(); readMappings(); renderManualEntries(); showImportLanding();
