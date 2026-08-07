/**
 * Simple, direct prompts for invoice extraction.
 * Used with Claude which can read PDFs directly.
 */

export const buildExtractionPrompt = (textSnippet: string, hasDocument: boolean = false) => {
  const intro = hasDocument
    ? "Look at the attached document, decide whether it is a payable invoice, and extract the data."
    : `Decide whether this text is a payable invoice, then extract the data:\n\n${textSnippet}`;

  return `${intro}

Return ONLY valid JSON in this exact format:

{
  "document": {
    "isPayableInvoice": true,
    "documentType": "short label, e.g. Invoice, Credit note, Cost allocation schedule, Exchange rate notification, Remittance advice, Delivery note, Timesheet, Contract",
    "classificationReason": "one short sentence explaining the choice"
  },
  "vendor": {
    "name": "seller name",
    "taxId": "VAT/tax number or null",
    "address": "seller address or null",
    "email": "seller email or null",
    "bankDetails": {
      "ibans": ["IBAN values on the invoice"],
      "bic": "BIC/SWIFT or null",
      "bankName": "bank name or null",
      "accountName": "account holder or null",
      "accountNumber": "local account number or null"
    }
  },
  "buyer": {
    "name": "bill-to/customer/legal entity name or null",
    "taxId": "buyer VAT/tax number or null",
    "address": "buyer address or null",
    "email": "buyer email or null",
    "entityCode": "entity/subsidiary code if shown, else null"
  },
  "invoice": {
    "invoiceNumber": "number",
    "purchaseOrderNumber": "PO/order reference exactly as printed or null",
    "invoiceType": "Standard, Proforma, CreditNote, Reminder, Statement, or Other",
    "transactionIntent": "VendorBill or VendorPrepayment",
    "invoiceDate": "YYYY-MM-DD",
    "dueDate": "YYYY-MM-DD or null",
    "currency": "ISO code such as EUR/USD/CHF/JPY",
    "paymentTerms": "payment terms or null",
    "description": "short invoice/matter/mandate/project description or null",
    "servicePeriod": { "startDate": "YYYY-MM-DD or null", "endDate": "YYYY-MM-DD or null" },
    "remittanceReference": "payment reference or null",
    "netAmount": 0.00,
    "taxAmount": 0.00,
    "totalAmount": 0.00
  },
  "lineItems": [
    {
      "lineNumber": 1,
      "description": "item description",
      "quantity": 1,
      "unitPrice": 0.00,
      "amount": 0.00,
      "taxRate": 0.00,
      "account": "GL/account code if shown, else null",
      "department": "department/cost object if shown, else null",
      "costCenter": "cost center/class if shown, else null",
      "project": "project/job/customer reference if shown, else null"
    }
  ]
}

Rules:
- FIRST decide document.isPayableInvoice. AP emails routinely bundle supporting material with the
  actual invoices, and only a payable document should ever be booked.
- isPayableInvoice = true ONLY for documents that themselves request or adjust payment: invoices,
  proforma invoices, and credit notes.
- isPayableInvoice = false for anything else attached alongside them, for example: cost allocation
  or cost breakdown schedules, currency/exchange-rate notifications from a tax or customs
  authority, remittance advices, delivery notes, timesheets, price lists, contracts, bank
  statements, reminders, and vendor statements of account.
- A document is not a payable invoice merely because it names an amount, a company, or a reference
  number. Ask whether THIS document is the one asking to be paid.
- When isPayableInvoice is false: still fill in what genuinely appears on the document, but leave
  totalAmount, netAmount and taxAmount null rather than 0, and return an empty lineItems array.
  Do NOT turn the rows of a rate table, an allocation breakdown, or a summary listing into
  lineItems — those are not billed lines.
- vendor = the invoice ISSUER/SELLER (the company being paid, who created this invoice).
- vendor is NOT the buyer/recipient/bill-to/ship-to.
- buyer = the invoice recipient/customer/legal entity being billed.
- In the user's samples, buyer names may include Censhare GmbH, Censhare Deutschland GmbH, Entirely AG, or similar entities; do not confuse those with the vendor.
- For Japanese invoices, names followed by recipient honorifics are recipients/customers, not vendors. The vendor is usually the company with a registration number, tax ID, bank account, or stamp.
- Keep the vendor name in its original language/script.
- For EU VAT numbers, preserve the country prefix when printed (for example DE123456789, FR..., NL..., XI...). For Swiss VAT/UID numbers, preserve CHE and any MWST/TVA/IVA suffix.
- totalAmount = final gross amount including tax.
- netAmount = subtotal before tax/discounts when shown.
- taxAmount = VAT/consumption tax amount.
- lineItems amounts = pre-tax amounts.
- EVERY monetary field — netAmount, taxAmount, totalAmount, and each line's amount and unitPrice —
  must be in the SINGLE currency you report in invoice.currency. Never mix currencies across
  fields.
- Cross-border invoices frequently print the same amounts twice, once in the seller's local
  currency and once in the currency the invoice is settled in (for example an Indian supplier
  billing a European customer showing both INR and EUR). When that happens, choose the currency
  the invoice is actually payable in — the one on the "total due"/"amount payable" line and
  matching the bank details — set invoice.currency to it, and read every other amount from that
  same column. Do NOT take totalAmount from one currency and netAmount from the other.
- Sanity-check before returning: netAmount + taxAmount should equal totalAmount, and the line
  amounts should sum to netAmount. If they don't, you have most likely mixed currencies or
  misread a figure — re-read the document rather than returning inconsistent numbers.
- For Proforma invoices, set invoiceType to "Proforma". For reminders/dunning notices/Mahnung, set "Reminder". For vendor statements, set "Statement".
- Treat Proforma invoices as prepayment requests: set transactionIntent to "VendorPrepayment". Standard payable invoices should use "VendorBill".
- purchaseOrderNumber = the PO/order reference exactly as printed on the invoice, null if not present.
- Do not normalize, strip, rewrite, or correct purchaseOrderNumber; the system derives a separate lookup key for NetSuite matching.
- Capture PO/order references from labels such as PO, P.O., Auftrag, Bestellnummer, purchase order, or order number.
- Capture IBAN/BIC/SWIFT values exactly as printed. If multiple IBANs are shown, include them all.
- Convert written dates such as "May 21, 2026" or "08.05.26" to YYYY-MM-DD.
`;
};

export const buildRepairPrompt = (brokenJson: string) => {
  return `Fix this JSON to match the required format. Return ONLY valid JSON.

REQUIRED FORMAT:
{
  "document": { "isPayableInvoice": true, "documentType": "...", "classificationReason": "..." },
  "vendor": { "name": "...", "taxId": "...", "address": "...", "email": null, "bankDetails": { "ibans": [], "bic": null, "bankName": null, "accountName": null, "accountNumber": null } },
  "buyer": { "name": "...", "taxId": "...", "address": "...", "email": null, "entityCode": null },
  "invoice": { "invoiceNumber": "...", "purchaseOrderNumber": "...", "invoiceType": "...", "transactionIntent": "VendorBill", "invoiceDate": "...", "dueDate": "...", "currency": "...", "paymentTerms": null, "description": null, "servicePeriod": { "startDate": null, "endDate": null }, "remittanceReference": null, "netAmount": 0, "taxAmount": 0, "totalAmount": 0 },
  "lineItems": [{ "lineNumber": 1, "description": "...", "amount": 0, "quantity": 1, "unitPrice": 0, "taxRate": null, "account": null, "department": null, "costCenter": null, "project": null }]
}

INPUT TO FIX:
${brokenJson}
`;
};
