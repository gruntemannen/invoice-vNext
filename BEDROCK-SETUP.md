# Amazon Bedrock Setup Guide

This document describes the steps needed to enable Amazon Bedrock model access for the Invoice Extractor application.

## Prerequisites

- AWS Account with administrator access
- AWS CLI configured with appropriate credentials
- Infrastructure already deployed via CDK

## Step 1: Enable Model Access in Amazon Bedrock Console

Before the Lambda function can invoke Bedrock models, you must enable access to them in the Bedrock console:

### Using AWS Console

1. **Navigate to Amazon Bedrock Console**
   - Go to https://console.aws.amazon.com/bedrock/
   - Ensure you're in the correct region (e.g., `eu-central-1`)

2. **Request Model Access**
   - In the left sidebar, click **"Model access"**
   - Click **"Manage model access"** or **"Edit"**
   - Find and enable the following model:
     - **Claude 3.5 Sonnet** (Anthropic) - `anthropic.claude-3-5-sonnet-20240620-v1:0`
   - Click **"Request model access"** or **"Save changes"**
   - Accept the EULA if prompted

3. **Wait for Approval**
   - Model access is usually granted immediately
   - Refresh the page to see when status changes to "Access granted"

## Step 2: Verify IAM Permissions

The CDK stack automatically adds the required IAM permissions to the Lambda execution role:

- `bedrock:InvokeModel` - To call Bedrock inference APIs
- `aws-marketplace:ViewSubscriptions` - To view model subscriptions
- `aws-marketplace:Subscribe` - To subscribe to models (if needed)

After updating the CDK stack, redeploy to apply these permissions:

```bash
cd infra
npx cdk deploy InvoiceExtractorStack
```

## Step 3: Verify Model Access

After enabling model access and deploying the updated stack:

1. **Upload a test invoice** through the web interface
2. **Check CloudWatch Logs** for the ExtractLambda function
3. **Verify success** by viewing the extracted JSON

## Troubleshooting

### Error: "Model access is denied"

**Problem:** Lambda doesn't have IAM permissions or model access isn't enabled.

**Solution:**
1. Verify model access is "Access granted" in Bedrock console
2. Redeploy the CDK stack to update IAM policies
3. Wait 2 minutes after enabling model access before retrying

### Error: "AWS Marketplace subscription" or "ViewSubscriptions"

**Problem:** AWS Marketplace permissions not configured.

**Solution:**
1. Ensure IAM policy includes `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe`
2. Redeploy the CDK stack
3. Wait 2 minutes before retrying

### Error: "Throttling" or "Too Many Requests"

**Problem:** Exceeding Bedrock service quotas.

**Solution:**
1. Go to Service Quotas in AWS Console
2. Search for "Bedrock"
3. Request quota increase for "Invocations per minute"

### Using Different Models

To use different Claude models, update `infra/lib/workload-stack.ts`:

```typescript
const bedrockModelId = "anthropic.claude-3-5-sonnet-20240620-v1:0"; // or other Claude model
```

Then redeploy:
```bash
cd infra
npx cdk deploy InvoiceExtractorStack
```

## Supported Models

The application is configured to use:
- **Primary:** Claude 3.5 Sonnet (`anthropic.claude-3-5-sonnet-20240620-v1:0`)

Claude 3.5 Sonnet is used because it can read PDFs directly (no OCR needed), providing accurate extraction even for scanned documents and non-Latin scripts (Japanese, Chinese, Korean, etc.).

## Cost Considerations

- **Claude 3.5 Sonnet:** ~$3 per 1M input tokens, ~$15 per 1M output tokens
- Typical invoice extraction uses 5-20K input tokens (PDF content) and 1-2K output tokens (JSON)
- Estimated cost: ~$0.02-0.05 per invoice

## Additional Resources

- [Amazon Bedrock Model Access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [Bedrock IAM Permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html)
- [Model Pricing](https://aws.amazon.com/bedrock/pricing/)
- [Claude Documentation](https://docs.anthropic.com/claude/docs)
