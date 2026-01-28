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
  "vendor": { "name": "seller name", "taxId": "VAT number or null", "address": "address or null" },
  "invoice": { "invoiceNumber": "number", "purchaseOrderNumber": "PO number or null", "invoiceType": "Standard or Prepayment", "invoiceDate": "YYYY-MM-DD", "dueDate": "YYYY-MM-DD or null", "currency": "JPY/EUR/USD/etc", "totalAmount": 0.00, "taxAmount": 0.00 },
  "lineItems": [{ "description": "item description", "quantity": 1, "unitPrice": 0.00, "amount": 0.00 }]
}

Rules:
- vendor = the invoice ISSUER/SELLER (the company being paid, who created this invoice). 
- vendor is NOT the buyer/recipient/bill-to/ship-to.
- CRITICAL for Japanese invoices (請求書):
  - Names followed by 御中, 様, or 殿 are ALWAYS the RECIPIENT (customer), never the vendor.
  - The vendor is the company with: registration number (登録番号), tax ID, bank account (振込先), or company stamp (印).
  - Often the recipient is top-left and the vendor info is on the right or bottom.
  - Example: "EF Cultural Tours GmbH 御中" means EF is the RECIPIENT. Look elsewhere for the vendor.
- Keep the vendor name in its original language/script (e.g. Japanese 株式会社, Chinese, Korean).
- totalAmount = final amount including tax.
- taxAmount = VAT/consumption tax amount.
- lineItems amounts = pre-tax amounts.
- For Proforma invoices, set invoiceType to "Prepayment".
- purchaseOrderNumber = only the PO code (no labels), null if not present.
`;
};

export const buildRepairPrompt = (brokenJson: string) => {
  return `Fix this JSON to match the required format. Return ONLY valid JSON.

REQUIRED FORMAT:
{
  "vendor": { "name": "...", "taxId": "...", "address": "..." },
  "invoice": { "invoiceNumber": "...", "purchaseOrderNumber": "...", "invoiceType": "...", "invoiceDate": "...", "dueDate": "...", "currency": "...", "totalAmount": 0, "taxAmount": 0 },
  "lineItems": [{ "description": "...", "amount": 0, "quantity": 1 }]
}

INPUT TO FIX:
${brokenJson}
`;
};
