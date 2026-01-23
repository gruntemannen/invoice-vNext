import { simpleParser, Attachment } from "mailparser";

export type ParsedEmail = {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  attachments: Attachment[];
};

export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);
  const attachments = (parsed.attachments || []).filter((attachment) => {
    const disposition = attachment.contentDisposition?.toLowerCase() ?? "";
    if (disposition.includes("inline")) return false;
    if (attachment.contentId) return false;
    if (attachment.contentType?.startsWith("image/") && attachment.filename?.toLowerCase().includes("logo")) {
      return false;
    }
    return true;
  });

  return {
    messageId: (parsed.messageId || parsed.messageId === "" ? parsed.messageId : `${Date.now()}`) ?? `${Date.now()}`,
    from: parsed.from?.text ?? "",
    subject: parsed.subject ?? "",
    date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    attachments,
  };
}
