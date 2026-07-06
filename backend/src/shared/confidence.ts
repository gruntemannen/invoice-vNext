export function calculateConfidence(extracted: any): number {
  let score = 0;
  let total = 8;

  const vendorName = String(extracted?.vendor?.name ?? "").trim();
  const buyerName = String(extracted?.buyer?.name ?? "").trim();
  const invoiceNumber = String(extracted?.invoice?.invoiceNumber ?? "").trim();
  const invoiceDate = String(extracted?.invoice?.invoiceDate ?? "").trim();
  const currency = String(extracted?.invoice?.currency ?? "").trim();
  const totalAmount = extracted?.invoice?.totalAmount;
  const taxAmount = extracted?.invoice?.taxAmount;
  const netAmount = extracted?.invoice?.netAmount;
  const lineItems: any[] = Array.isArray(extracted?.lineItems) ? extracted.lineItems : [];

  const hasRealVendor = !!vendorName && !isPlaceholder(vendorName) && vendorName.length >= 3;
  const hasRealBuyer = !!buyerName && !isPlaceholder(buyerName) && buyerName.length >= 3;
  const hasRealInvoiceNumber =
    !!invoiceNumber && !isPlaceholder(invoiceNumber) && /[A-Za-z0-9]/.test(invoiceNumber) && /\d/.test(invoiceNumber);
  const hasRealInvoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate);
  const hasRealCurrency = !!currency && /^[A-Z]{3}$/.test(currency) && currency !== "ETC";
  const hasRealTotalAmount = typeof totalAmount === "number" && Number.isFinite(totalAmount) && totalAmount > 0;
  const hasRealLineItem =
    lineItems.length > 0 &&
    lineItems.some((li) => {
      const desc = String(li?.description ?? "").trim();
      const amt = li?.amount;
      return !!desc && !isPlaceholder(desc) && typeof amt === "number" && Number.isFinite(amt) && amt > 0;
    });

  if (hasRealVendor) score += 1;
  if (hasRealBuyer) score += 1;
  if (hasRealInvoiceNumber) score += 1;
  if (hasRealInvoiceDate) score += 1;
  if (hasRealCurrency) score += 1;
  if (hasRealTotalAmount) score += 1;
  if (hasRealLineItem) score += 1;

  // Basic math sanity: if totals exist, check net + tax ~= total and line sum ~= net (when possible)
  if (typeof totalAmount === "number" && typeof taxAmount === "number" && Number.isFinite(totalAmount) && Number.isFinite(taxAmount) && totalAmount > 0 && taxAmount >= 0) {
    const net = typeof netAmount === "number" && Number.isFinite(netAmount) && netAmount > 0 ? netAmount : totalAmount - taxAmount;
    const lineSum =
      lineItems.length
        ? lineItems.reduce((acc: number, li: any) => acc + (typeof li?.amount === "number" && Number.isFinite(li.amount) ? li.amount : 0), 0)
        : null;

    if (typeof lineSum === "number") {
      const close = (a: number, b: number, t = 0.01) => {
        const maxVal = Math.max(Math.abs(a), Math.abs(b));
        return maxVal === 0 ? a === b : Math.abs(a - b) / maxVal <= t;
      };
      if (net > 0 && lineSum > 0 && close(net, lineSum)) score += 1;
    }
  }

  let conf = Math.min(1, Math.max(0, score / total));

  // Strong caps for obvious placeholder/empty extractions.
  const snippet = String(extracted?.meta?.extractedTextSnippet ?? "").trim();
  const looksLikeTemplate =
    isPlaceholder(vendorName) ||
    lineItems.some((li) => isPlaceholder(String(li?.description ?? "").trim())) ||
    vendorName.toLowerCase() === "seller name" ||
    currency.toLowerCase().includes("eur/usd") ||
    invoiceNumber.toLowerCase() === "number";

  if (looksLikeTemplate) conf = Math.min(conf, 0.2);
  if (typeof totalAmount === "number" && totalAmount === 0) conf = Math.min(conf, 0.2);
  
  // Only penalize short snippets for text-based extraction (not visual AI processing)
  const isVisualProcessing = snippet.includes("visually by AI") || snippet.includes("PDF processed");
  if (snippet && snippet.length < 80 && !isVisualProcessing) conf = Math.min(conf, 0.35);

  return conf;
}

function isPlaceholder(s: string): boolean {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v) return true;
  return (
    v === "seller name" ||
    v === "item" ||
    v === "number" ||
    v === "address or null" ||
    v === "vat number or null" ||
    v === "vat number" ||
    v === "eur/usd/etc" ||
    v === "eur/usd/etc." ||
    v === "..." ||
    v.includes("or null")
  );
}
