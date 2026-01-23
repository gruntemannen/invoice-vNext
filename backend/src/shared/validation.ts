import Ajv from "ajv";
import { invoiceSchema } from "./schema";

const ajv = new Ajv({ allErrors: true, removeAdditional: false });
const validateFn = ajv.compile(invoiceSchema);

export function validateInvoiceJson(data: any) {
  const valid = validateFn(data);
  return { valid: !!valid, errors: validateFn.errors ?? [] };
}
