import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";

interface InvoiceExtractorStackProps extends cdk.StackProps {
  projectPrefix: string;
}

export class InvoiceExtractorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InvoiceExtractorStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", props.projectPrefix);

    const rawBucket = new s3.Bucket(this, "RawEmailBucket", {
      bucketName: `${props.projectPrefix}-raw-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 86400,
        },
      ],
      lifecycleRules: [
        {
          transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) }],
        },
      ],
    });

    const table = new dynamodb.Table(this, "InvoiceTable", {
      partitionKey: { name: "messageId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "attachmentKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const dlq = new sqs.Queue(this, "ExtractionDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, "ExtractionQueue", {
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 2 },
    });

    const lambdaLogRetention = logs.RetentionDays.TWO_WEEKS;

    const ingestFn = new lambdaNode.NodejsFunction(this, "IngestLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/ingest.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(2),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        ATTACHMENT_BUCKET: rawBucket.bucketName,
        QUEUE_URL: queue.queueUrl,
        TABLE_NAME: table.tableName,
      },
      logRetention: lambdaLogRetention,
    });

    // Claude 3.5 Sonnet - reads PDFs directly (no OCR needed)
    const bedrockModelId = "anthropic.claude-3-5-sonnet-20240620-v1:0";
    const maxUploadBytes = 10 * 1024 * 1024;

    const extractFn = new lambdaNode.NodejsFunction(this, "ExtractLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/extract.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        ATTACHMENT_BUCKET: rawBucket.bucketName,
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
      logRetention: lambdaLogRetention,
    });

    const apiFn = new lambdaNode.NodejsFunction(this, "ApiLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/api.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      environment: {
        ATTACHMENT_BUCKET: rawBucket.bucketName,
        TABLE_NAME: table.tableName,
        QUEUE_URL: queue.queueUrl,
        MAX_UPLOAD_BYTES: String(maxUploadBytes),
      },
      logRetention: lambdaLogRetention,
    });

    rawBucket.grantReadWrite(ingestFn);
    rawBucket.grantReadWrite(extractFn);
    rawBucket.grantRead(apiFn, "attachments/*");
    rawBucket.grantPut(apiFn, "attachments/*");
    rawBucket.grantDelete(apiFn, "attachments/*");
    table.grantReadWriteData(ingestFn);
    table.grantReadWriteData(extractFn);
    table.grantReadWriteData(apiFn);
    queue.grantSendMessages(ingestFn);
    queue.grantConsumeMessages(extractFn);
    queue.grantSendMessages(apiFn);

    // Bedrock permissions for Claude
    extractFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          // Claude 3.5 Sonnet
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${bedrockModelId}`,
          // Allow all Claude models in case of fallback
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
        ],
      })
    );

    // AWS Marketplace permissions for Bedrock model access
    extractFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
        resources: ["*"],
      })
    );

    rawBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(ingestFn),
      { prefix: "raw/" }
    );

    const uploadIngestFn = new lambdaNode.NodejsFunction(this, "UploadIngestLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/upload-ingest.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(2),
      environment: {
        ATTACHMENT_BUCKET: rawBucket.bucketName,
        QUEUE_URL: queue.queueUrl,
        TABLE_NAME: table.tableName,
        MAX_UPLOAD_BYTES: String(maxUploadBytes),
      },
      logRetention: lambdaLogRetention,
    });

    rawBucket.grantRead(uploadIngestFn);
    table.grantReadWriteData(uploadIngestFn);
    queue.grantSendMessages(uploadIngestFn);

    rawBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(uploadIngestFn),
      { prefix: "attachments/" }
    );

    rawBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${rawBucket.bucketArn}/raw/*`],
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        conditions: {
          StringEquals: { "aws:Referer": cdk.Aws.ACCOUNT_ID },
        },
      })
    );

    const receiptRuleSet = new ses.ReceiptRuleSet(this, "ReceiptRuleSet", {
      receiptRuleSetName: `${props.projectPrefix}-rule-set`,
    });

    receiptRuleSet.addRule("StoreRawEmails", {
      enabled: true,
      scanEnabled: true,
      actions: [
        new sesActions.S3({
          bucket: rawBucket,
          objectKeyPrefix: "raw/",
        }),
      ],
    });

    extractFn.addEventSourceMapping("ExtractQueueMapping", {
      eventSourceArn: queue.queueArn,
      batchSize: 1,
    });

    const httpApi = new apigwv2.HttpApi(this, "InvoiceApi", {
      apiName: `${props.projectPrefix}-api`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type"],
        maxAge: cdk.Duration.days(10),
      },
    });

    httpApi.addRoutes({
      path: "/invoices",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("ListIntegration", apiFn),
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DetailIntegration", apiFn),
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DeleteIntegration", apiFn),
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}/download",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DownloadIntegration", apiFn),
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}/oracle-fusion",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("OracleFusionIntegration", apiFn),
    });

    httpApi.addRoutes({
      path: "/upload",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("UploadIntegration", apiFn),
    });

    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `${props.projectPrefix}-ui-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    siteBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "FrontendDistribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
    });

    new s3deploy.BucketDeployment(this, "FrontendDeploy", {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../frontend")),
        s3deploy.Source.data(
          "config.json",
          JSON.stringify(
            {
              apiBaseUrl: httpApi.apiEndpoint,
              maxUploadBytes,
            },
            null,
            2
          )
        ),
      ],
      distribution,
      distributionPaths: ["/*"],
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "FrontendUrl", { value: `https://${distribution.domainName}` });
    new cdk.CfnOutput(this, "RawBucketName", { value: rawBucket.bucketName });
    new cdk.CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
  }
}
