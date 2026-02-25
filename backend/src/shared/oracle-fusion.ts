/**
 * Oracle Fusion Cloud Payables AP Integration
 * Transforms extracted invoice JSON to Oracle Fusion payablesInterfaceInvoices format
 */

export interface OracleFusionConfig {
  // Default values for Oracle Fusion
  source: string; // e.g., "INVOICE_EXTRACTOR"
  businessUnit: string; // e.g., "US1 Business Unit"
  defaultInvoiceType: string; // e.g., "Standard"
  
  // Supplier mapping: vendor name -> Oracle Supplier details
  supplierMapping: Record<string, {
    supplierId?: number;
    supplierNumber?: string;
    supplierSite?: string;
  }>;
  
  // Default accounting distribution
  defaultDistribution?: {
    account?: string;
    costCenter?: string;
    department?: string;
  };
}

export interface OracleFusionInvoice {
  Source: string;
  InvoiceNumber: string;
  InvoiceAmount: number;
  InvoiceDate: string;
  InvoiceCurrency: string;
  InvoiceType?: string;
  BusinessUnit?: string;
  Supplier?: string;
  SupplierNumber?: string;
  SupplierId?: number;
  SupplierSite?: string;
  Description?: string;
  GlDate?: string;
  PaymentTerms?: string;
  InvoiceReceivedDate?: string;
  
  // Line items
  lines?: Array<{
    LineNumber: number;
    LineType: string;
    LineAmount: number;
    Description?: string;
    Quantity?: number;
    UnitPrice?: number;
    TaxClassificationCode?: string;
    ProrateAcrossAllItemsFlag?: boolean;
    
    // Distribution (accounting)
    distributions?: Array<{
      DistributionLineNumber: number;
      DistributionLineType: string;
      Amount: number;
      DistributionCombination?: string;
    }>;
  }>;
}

/**
 * Transform extracted invoice to Oracle Fusion format
 */
export function transformToOracleFusion(
  extractedInvoice: any,
  config: OracleFusionConfig
): OracleFusionInvoice {
  const vendorName = extractedInvoice.vendor?.name || "";
  const supplierMapping = config.supplierMapping[vendorName] || {};
  
  // Determine GL date (defaults to invoice date)
  const glDate = extractedInvoice.invoice?.invoiceDate || new Date().toISOString().split("T")[0];
  
  const oracleInvoice: OracleFusionInvoice = {
    Source: config.source,
    InvoiceNumber: extractedInvoice.invoice?.invoiceNumber || "",
    InvoiceAmount: extractedInvoice.invoice?.totalAmount || 0,
    InvoiceDate: extractedInvoice.invoice?.invoiceDate || "",
    InvoiceCurrency: extractedInvoice.invoice?.currency || "USD",
    InvoiceType: extractedInvoice.invoice?.invoiceType || config.defaultInvoiceType,
    BusinessUnit: config.businessUnit,
    GlDate: glDate,
    Description: extractedInvoice.invoice?.description,
    PaymentTerms: extractedInvoice.invoice?.paymentTerms,
    InvoiceReceivedDate: extractedInvoice.meta?.receivedAt?.split("T")[0],
    
    // Supplier identification
    Supplier: vendorName,
    SupplierNumber: supplierMapping.supplierNumber,
    SupplierId: supplierMapping.supplierId,
    SupplierSite: supplierMapping.supplierSite || extractedInvoice.vendor?.site,
  };
  
  // Transform line items
  if (Array.isArray(extractedInvoice.lineItems)) {
    oracleInvoice.lines = extractedInvoice.lineItems.map((line: any, index: number) => {
      const lineNumber = line.lineNumber || index + 1;
      
      return {
        LineNumber: lineNumber,
        LineType: "Item",
        LineAmount: line.amount || 0,
        Description: line.description,
        Quantity: line.quantity,
        UnitPrice: line.unitPrice,
        
        // Distribution (accounting) - one distribution per line for simplicity
        distributions: [
          {
            DistributionLineNumber: 1,
            DistributionLineType: "Item",
            Amount: line.amount || 0,
            DistributionCombination: buildDistributionCombination(line, config),
          },
        ],
      };
    });
  }
  
  return oracleInvoice;
}

/**
 * Build distribution combination string from line item and config
 * Format depends on your Oracle chart of accounts structure
 * Example: "01-000-1234-0000-000" (Company-Cost Center-Account-Department-Project)
 */
function buildDistributionCombination(line: any, config: OracleFusionConfig): string | undefined {
  const account = line.account || config.defaultDistribution?.account;
  const costCenter = line.costCenter || config.defaultDistribution?.costCenter;
  const department = line.department || config.defaultDistribution?.department;
  
  // Return undefined if no accounting info available
  if (!account && !costCenter && !department) {
    return undefined;
  }
  
  // Build combination string - adjust format to match your COA structure
  const segments = [
    costCenter || "000",
    account || "0000",
    department || "000",
  ];
  
  return segments.join("-");
}

/**
 * Validate Oracle Fusion invoice before submission
 */
export function validateOracleFusionInvoice(invoice: OracleFusionInvoice): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (!invoice.Source) errors.push("Source is required");
  if (!invoice.InvoiceNumber) errors.push("InvoiceNumber is required");
  if (invoice.InvoiceAmount === undefined || invoice.InvoiceAmount === null) errors.push("InvoiceAmount is required");
  if (!invoice.InvoiceDate) errors.push("InvoiceDate is required");
  if (!invoice.InvoiceCurrency) errors.push("InvoiceCurrency is required");
  if (!invoice.BusinessUnit) errors.push("BusinessUnit is required");
  
  // Supplier identification - need at least one
  if (!invoice.Supplier && !invoice.SupplierNumber && !invoice.SupplierId) {
    errors.push("Supplier identification required (Supplier, SupplierNumber, or SupplierId)");
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Example configuration
 */
export const exampleConfig: OracleFusionConfig = {
  source: "INVOICE_EXTRACTOR",
  businessUnit: "US1 Business Unit",
  defaultInvoiceType: "Standard",
  
  supplierMapping: {
    "Oracle Software (Schweiz) GmbH": {
      supplierNumber: "SUP-001",
      supplierSite: "ZURICH",
    },
    "Acme Corporation": {
      supplierId: 12345,
      supplierSite: "MAIN",
    },
  },
  
  defaultDistribution: {
    account: "5000",
    costCenter: "100",
    department: "IT",
  },
};
