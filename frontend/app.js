let apiBaseUrl = "";
let nextToken = undefined;
let items = [];

const listEl = document.getElementById("list");
const detailSection = document.getElementById("detail-section");
const listSection = document.getElementById("list-section");
const detailJson = document.getElementById("detail-json");
const detailMeta = document.getElementById("detail-meta");
const pdfViewer = document.getElementById("pdf-viewer");
const loadMoreBtn = document.getElementById("load-more");
const backBtn = document.getElementById("back");
const downloadBtn = document.getElementById("download");
const deleteBtn = document.getElementById("delete");
const uploadBtn = document.getElementById("upload-btn");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const uploadSpinner = document.getElementById("upload-spinner");
let maxUploadBytes = 0;
let currentDetail = null;

async function loadConfig() {
  const res = await fetch("config.json");
  const cfg = await res.json();
  apiBaseUrl = cfg.apiBaseUrl;
  maxUploadBytes = Number(cfg.maxUploadBytes ?? 0);
}

function renderList() {
  listEl.innerHTML = "";
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">${item.subject || "(no subject)"}</div>
      <div class="card-subtitle">${item.from || "(unknown sender)"}</div>
      <div class="card-meta">
        <span>${new Date(item.receivedAt).toLocaleString()}</span>
        <span class="badge ${badgeClass(item.confidence)}">Confidence ${formatConfidence(item.confidence)}</span>
        <span class="status">${item.status}</span>
      </div>
      <div class="card-details">
        <span>${item.vendorName || "Vendor unknown"}</span>
        <span>${item.invoiceNumber || "Invoice # missing"}</span>
        <span>${formatAmount(item.totalAmount, item.currency)}</span>
      </div>
    `;
    card.onclick = () => openDetail(item.messageId, item.attachmentId);
    listEl.appendChild(card);
  });
}

function badgeClass(confidence) {
  if (confidence >= 0.8) return "good";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function formatConfidence(confidence) {
  if (typeof confidence !== "number") return "n/a";
  return `${Math.round(confidence * 100)}%`;
}

function formatAmount(amount, currency) {
  if (typeof amount !== "number") return "Total unknown";
  return `${currency || ""} ${amount.toFixed(2)}`;
}

async function loadInvoices() {
  const params = new URLSearchParams();
  if (nextToken) params.set("nextToken", nextToken);
  const res = await fetch(`${apiBaseUrl}/invoices?${params.toString()}`);
  const data = await res.json();
  items = items.concat(data.items || []);
  nextToken = data.nextToken;
  loadMoreBtn.disabled = !nextToken;
  renderList();
}

async function openDetail(messageId, attachmentId) {
  const res = await fetch(`${apiBaseUrl}/invoices/${messageId}/${attachmentId}`);
  const data = await res.json();
  currentDetail = { messageId, attachmentId };
  
  // Display extracted JSON or error information
  if (data.status === "FAILED") {
    const errorInfo = {
      status: "FAILED",
      errors: data.errors || ["Unknown error"],
      messageId: data.messageId,
      attachmentId: data.attachmentId,
      receivedAt: data.receivedAt,
    };
    detailJson.textContent = JSON.stringify(errorInfo, null, 2);
  } else {
    detailJson.textContent = JSON.stringify(data.extractedJson ?? data, null, 2);
  }
  
  detailMeta.textContent = `Message: ${messageId} | Attachment: ${attachmentId}`;
  const d = await fetch(`${apiBaseUrl}/invoices/${messageId}/${attachmentId}/download`);
  const j = await d.json();
  if (d.ok && j?.url) {
    pdfViewer.src = j.url;
    downloadBtn.onclick = () => window.open(j.url, "_blank");
  } else {
    pdfViewer.src = "";
    downloadBtn.onclick = null;
  }
  listSection.classList.add("hidden");
  detailSection.classList.remove("hidden");
}

async function deleteCurrentInvoice() {
  if (!currentDetail?.messageId || !currentDetail?.attachmentId) return;
  const ok = window.confirm("Delete this invoice and its uploaded PDF?");
  if (!ok) return;

  const res = await fetch(`${apiBaseUrl}/invoices/${currentDetail.messageId}/${currentDetail.attachmentId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data?.message || `Delete failed (${res.status}).`);
    return;
  }

  // Reset UI + reload list
  currentDetail = null;
  pdfViewer.src = "";
  detailSection.classList.add("hidden");
  listSection.classList.remove("hidden");
  items = [];
  nextToken = undefined;
  await loadInvoices();
}

async function uploadInvoice() {
  try {
    if (!fileInput.files || fileInput.files.length === 0) {
      uploadStatus.textContent = "Select a file first.";
      return;
    }
    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      uploadStatus.textContent = "PDF files only.";
      return;
    }
    if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
      uploadStatus.textContent = `File too large. Max ${formatBytes(maxUploadBytes)}.`;
      return;
    }

    uploadStatus.textContent = "Requesting upload URL...";
    uploadBtn.disabled = true;
    setSpinner(true);

    const res = await fetch(`${apiBaseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: "application/pdf",
        fileSize: file.size,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      uploadStatus.textContent = data?.message || "Upload request failed.";
      return;
    }

    uploadStatus.textContent = "Uploading to S3...";
    const putRes = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: file,
    });
    if (!putRes.ok) {
      uploadStatus.textContent = `Upload failed (${putRes.status}).`;
      return;
    }

    uploadStatus.textContent = "Upload complete. Processing...";
    items = [];
    nextToken = undefined;
    await waitForExtraction(data.messageId, data.attachmentId);
  } catch (err) {
    uploadStatus.textContent = "Upload failed. Check browser console/network.";
    console.error(err);
  } finally {
    uploadBtn.disabled = false;
    setSpinner(false);
  }
}

async function waitForExtraction(messageId, attachmentId) {
  const maxAttempts = 20;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(`${apiBaseUrl}/invoices/${messageId}/${attachmentId}`);
    
    // 404 is expected during initial S3 event → Lambda trigger delay
    if (res.status === 404) {
      uploadStatus.textContent = `Waiting for processing to start... (${attempt}/${maxAttempts})`;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    
    const data = await res.json().catch(() => ({}));
    
    // Processing complete
    if (res.ok && data?.status && data.status !== "PENDING") {
      if (data.status === "FAILED") {
        const errorMsg = data.errors?.join(", ") || "Unknown error";
        uploadStatus.textContent = `Processing failed: ${errorMsg}`;
      } else {
        uploadStatus.textContent = `Processing ${data.status.toLowerCase()}.`;
      }
      await loadInvoices();
      await openDetail(messageId, attachmentId);
      return;
    }
    
    // Still pending
    uploadStatus.textContent = `Processing... (${attempt}/${maxAttempts})`;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  uploadStatus.textContent = "Processing is taking longer than expected.";
  await loadInvoices();
}

function setSpinner(isVisible) {
  if (isVisible) {
    uploadSpinner.classList.remove("hidden");
  } else {
    uploadSpinner.classList.add("hidden");
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

backBtn.onclick = () => {
  detailSection.classList.add("hidden");
  listSection.classList.remove("hidden");
  pdfViewer.src = "";
  currentDetail = null;
};

loadMoreBtn.onclick = loadInvoices;
uploadBtn.onclick = uploadInvoice;
deleteBtn.onclick = deleteCurrentInvoice;

loadConfig().then(loadInvoices);
