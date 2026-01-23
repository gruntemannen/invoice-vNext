// Schema for model extraction - Oracle Fusion Payables compatible
export const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vendor", "invoice", "lineItems"],
  properties: {
    vendor: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Supplier/vendor name (company issuing the invoice)" },
        taxId: { type: "string", description: "Tax ID or VAT number" },
        site: { type: "string", description: "Supplier site name or code" },
        address: {
          type: "object",
          description: "Vendor address",
          properties: {
            line1: { type: "string", description: "Address line 1" },
            line2: { type: "string", description: "Address line 2" },
            city: { type: "string", description: "City" },
            state: { type: "string", description: "State/province" },
            postalCode: { type: "string", description: "Postal/ZIP code" },
            country: { type: "string", description: "Country" }
          }
        }
      }
    },
    invoice: {
      type: "object",
      additionalProperties: false,
      required: ["invoiceNumber", "invoiceDate", "currency", "totalAmount"],
      properties: {
        invoiceNumber: { type: "string", description: "Unique invoice number" },
        invoiceDate: { type: "string", description: "Invoice date (YYYY-MM-DD)" },
        currency: { type: "string", description: "3-letter currency code (e.g., USD, EUR, CHF)" },
        totalAmount: { type: "number", description: "Total invoice amount including tax" },
        taxAmount: { type: "number", description: "Total tax/VAT amount" },
        dueDate: { type: "string", description: "Payment due date (YYYY-MM-DD)" },
        paymentTerms: { type: "string", description: "Payment terms (e.g., Net 30, Net 60)" },
        purchaseOrderNumber: { type: "string", description: "PO number if PO-matched invoice" },
        description: { type: "string", description: "Invoice description or notes" },
        invoiceType: { type: "string", description: "Invoice type (e.g., Standard, Credit Memo, Debit Memo)" }
      }
    },
    lineItems: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lineNumber", "description", "amount"],
        properties: {
          lineNumber: { type: "number", description: "Line sequence number" },
          description: { type: "string", description: "Line item description" },
          amount: { type: "number", description: "Line amount" },
          quantity: { type: "number", description: "Quantity" },
          unitPrice: { type: "number", description: "Unit price" },
          taxAmount: { type: "number", description: "Tax amount for this line" },
          taxRate: { type: "number", description: "Tax rate percentage" },
          costCenter: { type: "string", description: "Cost center code" },
          account: { type: "string", description: "GL account code" },
          department: { type: "string", description: "Department code" },
          project: { type: "string", description: "Project code" }
        }
      }
    },
    billTo: {
      type: "object",
      description: "Bill-to customer/entity information",
      properties: {
        name: { type: "string", description: "Bill-to entity name" },
        address: {
          type: "object",
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            postalCode: { type: "string" },
            country: { type: "string" }
          }
        }
      }
    }
  }
} as const;

// Full schema for validation (includes meta and raw populated by code)
export const invoiceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meta", "vendor", "invoice", "lineItems", "raw"],
  properties: {
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "receivedAt", "from", "subject", "attachmentKey", "extractionModel", "confidenceScore", "warnings"],
      properties: {
        messageId: { type: "string" },
        receivedAt: { type: "string" },
        from: { type: "string" },
        subject: { type: "string" },
        attachmentKey: { type: "string" },
        extractionModel: { type: "string" },
        confidenceScore: { type: "number" },
        warnings: { type: "array", items: { type: "string" } }
      }
    },
    vendor: extractionSchema.properties.vendor,
    invoice: extractionSchema.properties.invoice,
    lineItems: extractionSchema.properties.lineItems,
    billTo: extractionSchema.properties.billTo,
    raw: {
      type: "object",
      additionalProperties: false,
      required: ["extractedTextSnippet", "fieldsNotFound"],
      properties: {
        extractedTextSnippet: { type: "string", maxLength: 2000 },
        fieldsNotFound: { type: "array", items: { type: "string" } }
      }
    }
  }
} as const;
