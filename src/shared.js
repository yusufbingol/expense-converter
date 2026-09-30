export const CATEGORY_OPTIONS = [
  'Arbitrary', 'Food', 'Family', 'Transport', 'Home Stuff', 'Clothing',
  'Hobby & Activity', 'Bill', 'Market', 'Health', 'General'
];

export function toExportDate(value) {
  const match = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, year] = match;
  const day = Number(dayText), month = Number(monthText);
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${dayText}/${monthText}/${year}`;
}

export function toDisplayDate(pdfDate) {
  return String(pdfDate);
}

export function isAllowedCategory(category) {
  return CATEGORY_OPTIONS.includes(category);
}

export function parseUserAmount(value) {
  const text = String(value ?? '').trim();
  if (!text) return Number.NaN;
  return Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
}

export function formatUserAmount(value, withCurrency = false) {
  const formatted = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
  return withCurrency ? `${formatted} TL` : formatted;
}

export function makeExportRow(transaction) {
  return {
    date: transaction.date,
    account: 'Card',
    category: transaction.category,
    subcategory: '',
    note: transaction.note,
    amount: Number(transaction.amount),
    incomeExpense: 'Expense',
    description: transaction.description
  };
}

function escapeTsv(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function rowsToTsv(rows) {
  const header = ['Date', 'Account', 'Category', 'Subcategory', 'Note', 'Amount', 'Income/Expense', 'Description'];
  const body = rows.map(row => [
    row.date, row.account, row.category, row.subcategory, row.note,
    formatUserAmount(row.amount), row.incomeExpense, row.description
  ].map(escapeTsv).join('\t'));
  return [header.join('\t'), ...body].join('\r\n');
}

export function downloadTsv(rows, fileName = 'import.tsv') {
  const blob = new Blob([rowsToTsv(rows)], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), { href: url, download: fileName });
  anchor.click();
  URL.revokeObjectURL(url);
}

export function validateManualTransaction(input) {
  const date = toExportDate(input.date);
  const amount = parseUserAmount(input.amount);
  if (!date) return { error: 'Enter a valid date in DD/MM/YYYY format.' };
  if (!isAllowedCategory(input.category)) return { error: 'Choose a category.' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter an amount greater than zero.' };
  if (!input.note.trim()) return { error: 'Enter a note.' };
  if (!input.description.trim()) return { error: 'Enter a description.' };
  return { value: { date, category: input.category, note: input.note.trim(), amount, description: input.description.trim() } };
}
