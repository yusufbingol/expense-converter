import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';
import './classification.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const storageKey = 'enpara-money-manager.merchant-mappings.v1';
const state = { mappings: new Map(), parsed: [], included: [], skipped: { installments: 0, negatives: 0, unrecognized: 0 }, skippedDescriptions: new Set(), unknown: [], unknownIndex: 0 };
const $ = (selector) => document.querySelector(selector);
const els = {
  input: $('#pdf-input'), dropZone: $('#drop-zone'), upload: $('#upload-panel'), processing: $('#processing-panel'), processingMessage: $('#processing-message'), classification: $('#classification-panel'), review: $('#review-panel'), empty: $('#empty-state'), unknownDescription: $('#unknown-description'), unknownProgress: $('#unknown-progress'), classificationCopy: $('#classification-copy'), classificationTransactions: $('#classification-transactions'), classificationForm: $('#classification-form'), merchantName: $('#merchant-name'), merchantCategory: $('#merchant-category'), categoryOptions: $('#category-options'), reviewBody: $('#review-body'), summaryCards: $('#summary-cards'), toast: $('#toast'), merchantCount: $('#merchant-count'), merchantBody: $('#merchant-body'), merchantSearch: $('#merchant-search'), merchantTable: $('#merchant-table-wrap'), merchantsEmpty: $('#merchants-empty'), clearAll: $('#clear-all')
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
  const categories = [...new Set([...state.mappings.values()].map(m => m.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'tr'));
  els.categoryOptions.replaceChildren(...categories.map(category => Object.assign(document.createElement('option'), { value: category })));
  renderMerchantTable();
}
function showToast(message) { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2800); }
function normalizeSpace(text) { return text.replace(/\s+/g, ' ').trim(); }
function parseAmount(raw) { return Number(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '')); }
function formatAmount(amount) { return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' TL'; }
function usDate(date) { const [day, month, year] = date.split('/'); return `${month}/${day}/${year}`; }
function escapeTsv(value) { return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }

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
  resetPanels(); els.upload.classList.add('hidden'); els.processing.classList.remove('hidden');
  try {
    const parsed = await extractTransactions(file);
    const filtered = filterTransactions(parsed);
    state.parsed = parsed; state.included = filtered.included; state.skipped = filtered.skipped; state.skippedDescriptions = new Set();
    state.unknown = [...new Set(state.included.map(t => t.description))].filter(description => !state.mappings.has(description));
    state.unknownIndex = 0;
    els.processing.classList.add('hidden');
    if (!state.included.length) { els.upload.classList.remove('hidden'); els.empty.classList.remove('hidden'); showToast('No supported purchase rows were found in this PDF.'); return; }
    state.unknown.length ? showClassification() : showReview();
  } catch (error) {
    console.error(error); els.processing.classList.add('hidden'); els.upload.classList.remove('hidden'); els.empty.classList.remove('hidden'); showToast('The PDF could not be read. Please use an Enpara card statement PDF.');
  }
}
function resetPanels() { els.classification.classList.add('hidden'); els.review.classList.add('hidden'); els.empty.classList.add('hidden'); els.processing.classList.add('hidden'); }
function showClassification() {
  els.classification.classList.remove('hidden');
  const description = state.unknown[state.unknownIndex];
  const transactions = state.included.filter(transaction => transaction.description === description);
  els.unknownDescription.textContent = description;
  els.unknownProgress.textContent = `${state.unknownIndex + 1} / ${state.unknown.length}`;
  els.classificationCopy.textContent = `${transactions.length} transaction${transactions.length === 1 ? '' : 's'} will use this mapping. This exact description has not been saved before.`;
  els.classificationTransactions.replaceChildren(...transactions.map(transaction => {
    const item = document.createElement('div'); item.className = 'classification-transaction';
    const date = document.createElement('span'); date.textContent = usDate(transaction.date);
    const amount = document.createElement('span'); amount.className = 'transaction-amount'; amount.textContent = `${transaction.amount.toFixed(2)} TL`;
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
  els.review.classList.remove('hidden');
  const known = new Set(state.included.map(t => t.description)).size - state.unknown.length;
  const cards = [
    ['Parsed rows', state.parsed.length], ['Imported purchases', state.included.length], ['Skipped installments', state.skipped.installments], ['Skipped payments / credits', state.skipped.negatives]
  ];
  els.summaryCards.replaceChildren(...cards.map(([label,value]) => { const card=document.createElement('div'); card.className='summary-card'; card.innerHTML=`<span>${label}</span><strong>${value}</strong>`; return card; }));
  els.reviewBody.replaceChildren(...state.included.map(t => { const mapping=state.mappings.get(t.description); const row=document.createElement('tr'); [usDate(t.date),t.description,mapping?.name || '—',mapping?.category || '—'].forEach((value,index)=>{const cell=document.createElement('td');cell.textContent=value;if(index===1)cell.className='description-cell';row.append(cell)});const amount=document.createElement('td');amount.className='amount-cell';amount.textContent=formatAmount(t.amount);row.append(amount);return row;}));
}
function exportTsv() {
  const header = ['Date','Account','Category','Subcategory','Note','Amount','Income/Expense','Description'];
  const rows = state.included.map(t => { const mapping = state.mappings.get(t.description); return [usDate(t.date),'Card',mapping.category,'',mapping.name,t.amount.toFixed(2),'Expense',t.description].map(escapeTsv).join('\t'); });
  const blob = new Blob([[header.join('\t'), ...rows].join('\r\n')], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = Object.assign(document.createElement('a'), { href:url, download:'import.tsv' }); anchor.click(); URL.revokeObjectURL(url); showToast(`Downloaded ${rows.length} transactions as import.tsv.`);
}
function renderMerchantTable() {
  if (!els.merchantBody) return;
  const query = els.merchantSearch?.value?.trim().toLocaleLowerCase('tr-TR') || '';
  const mappings = [...state.mappings.values()].sort((a,b)=>a.description.localeCompare(b.description,'tr')).filter(mapping => !query || `${mapping.description} ${mapping.name} ${mapping.category}`.toLocaleLowerCase('tr-TR').includes(query));
  els.merchantTable.classList.toggle('hidden', !mappings.length); els.merchantsEmpty.classList.toggle('hidden', state.mappings.size > 0); els.clearAll.classList.toggle('hidden', !state.mappings.size);
  els.merchantBody.replaceChildren(...mappings.map(mapping => { const row=$('#merchant-row-template').content.firstElementChild.cloneNode(true); row.dataset.description=mapping.description; row.querySelector('.description-cell').textContent=mapping.description; row.querySelector('.mapping-name').value=mapping.name; row.querySelector('.mapping-category').value=mapping.category; return row; }));
}
function resetImport() { state.parsed=[];state.included=[];state.skippedDescriptions=new Set();state.unknown=[];state.unknownIndex=0;els.input.value=''; resetPanels();els.upload.classList.remove('hidden');els.empty.classList.remove('hidden'); }

document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.nav-button').forEach(x=>x.classList.toggle('active',x===button)); document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id===`${button.dataset.view}-view`)); }));
els.input.addEventListener('change', event => handleFile(event.target.files[0]));
['dragenter','dragover'].forEach(type=>els.dropZone.addEventListener(type,event=>{event.preventDefault();els.dropZone.classList.add('dragging')}));
['dragleave','drop'].forEach(type=>els.dropZone.addEventListener(type,event=>{event.preventDefault();els.dropZone.classList.remove('dragging')}));
els.dropZone.addEventListener('drop', event=>handleFile(event.dataTransfer.files[0]));
els.classificationForm.addEventListener('submit', event => { event.preventDefault(); const description=state.unknown[state.unknownIndex],category=els.merchantCategory.value.trim(); if(!category){showToast('A category is required.');return;} const name=els.merchantName.value.trim() || description; state.mappings.set(description,{description,name,category}); persistMappings(); advanceClassification(); });
$('#skip-merchant').addEventListener('click', () => { const description = state.unknown[state.unknownIndex]; const skippedCount = state.included.filter(transaction => transaction.description === description).length; state.skippedDescriptions.add(description); state.included = state.included.filter(transaction => transaction.description !== description); showToast(`${skippedCount} transaction${skippedCount === 1 ? '' : 's'} skipped for this import.`); advanceClassification(); });
$('#cancel-import').addEventListener('click',resetImport); $('#new-import').addEventListener('click',resetImport); $('#export-button').addEventListener('click',exportTsv);
els.merchantSearch.addEventListener('input',renderMerchantTable);
els.merchantBody.addEventListener('click',event=>{ const row=event.target.closest('tr'); if(!row)return; const description=row.dataset.description; if(event.target.closest('.save-mapping')) { const name=row.querySelector('.mapping-name').value.trim() || description,category=row.querySelector('.mapping-category').value.trim(); if(!category){showToast('A category is required.');return;} state.mappings.set(description,{description,name,category});persistMappings();showToast('Merchant mapping saved.'); } if(event.target.closest('.delete-mapping')) { state.mappings.delete(description);persistMappings();showToast('Merchant mapping deleted.'); } });
els.clearAll.addEventListener('click',()=>{ if(confirm('Delete every saved merchant mapping from this browser?')){state.mappings.clear();persistMappings();showToast('All saved mappings deleted.');} });
readMappings();
