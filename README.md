# Enpara → Money Manager

A local browser application for converting supported Enpara credit-card statement purchases into a Money Manager `import.tsv` file.

## Run locally

```bash
npm install
npm run dev
```

Open the local address shown by Vite, then select an Enpara statement PDF.

## What is kept local

- The PDF is read in the browser using the bundled PDF.js library. It is never uploaded.
- Merchant mappings are stored in this browser's `localStorage` only. During classification, an empty friendly name falls back to the original description; a skipped merchant is excluded only from the current import and is never saved.
- The downloaded TSV has this exact column order: `Date`, `Account`, `Category`, `Subcategory`, `Note`, `Amount`, `Income/Expense`, `Description`.

## Current Enpara rules

The parser recognizes Enpara rows with a date, description and Turkish-Lira amount. It includes only positive, non-installment transactions. It omits payments, negative credits/refunds, installments, and rows that do not resemble statement transactions.

The reference statement PDF and `import.xlsx` mentioned in the brief were not included in this workspace, so the parser was validated against the supplied row examples. If a real statement exposes a different text layout, adjust `parseTransactionLine` in `src/main.js` while keeping the parsing, filtering, mapping, and TSV stages separate.
