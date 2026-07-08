export interface CognitoAuthConfig {
  /**
   * Optional external/shared Cognito issuer, for example:
   * https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_Example
   */
  issuer?: string;
  region?: string;
  userPoolId?: string;
  clientId?: string;
  /**
   * Hosted UI domain host without path, for example:
   * entirely-invoice.auth.eu-central-1.amazoncognito.com
   */
  domain?: string;
  scope?: string;
  responseType?: "token" | "code";
  landingClientId?: string;
  landingUrl?: string;
}

export interface InvoiceConfig {
  memberAccountName: string;
  memberAccountEmail: string;
  managementAccountId: string;
  region: string;
  projectPrefix: string;
  bedrockModelId: string;
  maxUploadBytes: number;
  dataRetentionDays: number;
  extractReservedConcurrency: number;
  viesLookupEnabled: boolean;
  viesRequestTimeoutMs: number;
  netSuiteLivePushEnabled: boolean;
  cognito?: CognitoAuthConfig;
}

export const config: InvoiceConfig = {
  memberAccountName: "invoice-extractor",
  memberAccountEmail: "your-email@company.com",
  managementAccountId: "YOUR_MGMT_ACCOUNT_ID",

  // AWS region to deploy to. If you use the email-ingestion path this MUST be a region that
  // supports Amazon SES inbound email receiving (e.g. us-east-1, us-west-2, eu-west-1).
  // eu-central-1 does NOT support inbound receiving.
  region: "eu-west-1",

  // Prefix for all resource names (buckets, tables, etc.). Lowercase, DNS-safe.
  projectPrefix: "invoice-extractor",

  // Amazon Bedrock model id used for extraction. Use a cross-region inference profile whose geo
  // prefix matches `region`: us. / eu. / jp. / au. (or "global." for residency-agnostic routing).
  // Examples: "us.anthropic.claude-sonnet-4-6", "global.anthropic.claude-sonnet-4-6".
  bedrockModelId: "eu.anthropic.claude-sonnet-4-6",

  // Maximum size (bytes) for an uploaded or emailed invoice attachment. Default 10 MiB.
  maxUploadBytes: 10 * 1024 * 1024,

  // Days to retain invoice records (DynamoDB TTL) and attachments before automatic deletion.
  // Increase for longer audit retention. Default 90.
  dataRetentionDays: 90,

  // Reserved concurrency for the extraction Lambda — caps simultaneous Bedrock calls (and
  // therefore cost) if the ingestion paths are flooded. Tune to your Bedrock account quota.
  extractReservedConcurrency: 5,

  // Validate vendor VAT numbers during extraction. EU/Northern Ireland numbers use the
  // European Commission VIES REST API; Swiss CHE MWST/TVA/IVA numbers use the Swiss
  // UID PublicServices SOAP endpoint. Lookup errors are metadata and do not fail invoices.
  viesLookupEnabled: true,
  viesRequestTimeoutMs: 6000,

  // Live NetSuite pushes are disabled by default. When false, API requests still create a
  // durable transaction log record that can be replayed after credentials/config are ready.
  netSuiteLivePushEnabled: false,

  // Optional shared Cognito override. Leave unset to keep creating and using the stack-owned
  // eu-west-1 admin pool/client. For the future shared Frankfurt pool, set these values here
  // or pass equivalent CDK context values (see README).
  //
  // cognito: {
  //   region: "eu-central-1",
  //   userPoolId: "eu-central-1_...",
  //   clientId: "...",
  //   domain: "....auth.eu-central-1.amazoncognito.com",
  //   responseType: "code",
  //   landingClientId: "3ckpnotgecjp7gtb7a1h5tgaan",
  //   landingUrl: "https://d31eg8zeuvav8w.cloudfront.net/?signed_out=1",
  // },
};
