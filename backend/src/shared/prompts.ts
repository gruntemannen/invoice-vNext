/**
 * Simple, direct prompts for invoice extraction.
 * Used with Claude which can read PDFs directly.
 */

export const buildExtractionPrompt = (textSnippet: string, hasDocument: boolean = false) => {
  const intro = hasDocument
    ? "Look at the attached invoice document and extract the data."
    : `Extract invoice data from this text:\n\n${textSnippet}`;

  return `${intro}

Return ONLY valid JSON in this exact format:

{
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
    "purchaseOrderNumber": "PO number or null",
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
- vendor = the invoice ISSUER/SELLER (the company being paid, who created this invoice).
- vendor is NOT the buyer/recipient/bill-to/ship-to.
- buyer = the invoice recipient/customer/legal entity being billed.
- In the user's samples, buyer names may include Censhare GmbH, Censhare Deutschland GmbH, Entirely AG, or similar entities; do not confuse those with the vendor.
- For Japanese invoices, names followed by recipient honorifics are recipients/customers, not vendors. The vendor is usually the company with a registration number, tax ID, bank account, or stamp.
- Keep the vendor name in its original language/script.
- totalAmount = final gross amount including tax.
- netAmount = subtotal before tax/discounts when shown.
- taxAmount = VAT/consumption tax amount.
- lineItems amounts = pre-tax amounts.
- For Proforma invoices, set invoiceType to "Proforma". For reminders/dunning notices/Mahnung, set "Reminder". For vendor statements, set "Statement".
- Treat Proforma invoices as prepayment requests: set transactionIntent to "VendorPrepayment". Standard payable invoices should use "VendorBill".
- purchaseOrderNumber = only the PO code (no labels), null if not present.
- Extract PO numbers from labels such as PO, P.O., Auftrag, Bestellnummer, purchase order, or order number.
- Capture IBAN/BIC/SWIFT values exactly as printed. If multiple IBANs are shown, include them all.
- Convert written dates such as "May 21, 2026" or "08.05.26" to YYYY-MM-DD.
`;
};

export const buildRepairPrompt = (brokenJson: string) => {
  return `Fix this JSON to match the required format. Return ONLY valid JSON.

REQUIRED FORMAT:
{
  "vendor": { "name": "...", "taxId": "...", "address": "...", "email": null, "bankDetails": { "ibans": [], "bic": null, "bankName": null, "accountName": null, "accountNumber": null } },
  "buyer": { "name": "...", "taxId": "...", "address": "...", "email": null, "entityCode": null },
  "invoice": { "invoiceNumber": "...", "purchaseOrderNumber": "...", "invoiceType": "...", "transactionIntent": "VendorBill", "invoiceDate": "...", "dueDate": "...", "currency": "...", "paymentTerms": null, "description": null, "servicePeriod": { "startDate": null, "endDate": null }, "remittanceReference": null, "netAmount": 0, "taxAmount": 0, "totalAmount": 0 },
  "lineItems": [{ "lineNumber": 1, "description": "...", "amount": 0, "quantity": 1, "unitPrice": 0, "taxRate": null, "account": null, "department": null, "costCenter": null, "project": null }]
}

INPUT TO FIX:
${brokenJson}
`;
};
