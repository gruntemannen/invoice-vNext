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
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as kms from "aws-cdk-lib/aws-kms";

interface InvoiceExtractorStackProps extends cdk.StackProps {
  projectPrefix: string;
}

export class InvoiceExtractorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InvoiceExtractorStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", props.projectPrefix);

    // Customer-managed KMS key for data at rest (attachment bucket + DynamoDB).
    const dataKey = new kms.Key(this, "DataKey", {
      description: `${props.projectPrefix} data-at-rest CMK`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Central S3 server-access-log bucket (SSE-S3: log delivery does not support a CMK target).
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      bucketName: `${props.projectPrefix}-access-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const rawBucket = new s3.Bucket(this, "RawEmailBucket", {
      bucketName: `${props.projectPrefix}-raw-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "raw-bucket/",
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

    const attachmentBucket = new s3.Bucket(this, "AttachmentBucket", {
      bucketName: `${props.projectPrefix}-attachments-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "attachment-bucket/",
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
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
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
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const lambdaLogRetention = logs.RetentionDays.TWO_WEEKS;

    // Lambda handler sources live in the sibling `backend` package. Point NodejsFunction at
    // that package as its project root so the cross-package entries are under projectRoot and
    // their dependencies resolve during esbuild bundling.
    const backendRoot = path.join(__dirname, "../../backend");
    const backendLockFile = path.join(backendRoot, "package-lock.json");

    const ingestFn = new lambdaNode.NodejsFunction(this, "IngestLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/ingest.ts"),
      projectRoot: backendRoot,
      depsLockFilePath: backendLockFile,
      handler: "handler",
      timeout: cdk.Duration.minutes(2),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        ATTACHMENT_BUCKET: attachmentBucket.bucketName,
        QUEUE_URL: queue.queueUrl,
        TABLE_NAME: table.tableName,
      },
      logRetention: lambdaLogRetention,
    });

    // Claude Sonnet 4.6 - reads PDFs directly (no OCR needed).
    // This is the EU cross-region inference profile: Sonnet 4.6 has no in-region
    // on-demand endpoint in eu-west-1, so the bare model id won't work here.
    // If you deploy outside the EU geo, switch the prefix (us./jp./au.) to match the
    // deploy region, or use the residency-agnostic "global.anthropic.claude-sonnet-4-6".
    const bedrockModelId = "eu.anthropic.claude-sonnet-4-6";
    const maxUploadBytes = 10 * 1024 * 1024;

    const extractFn = new lambdaNode.NodejsFunction(this, "ExtractLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/extract.ts"),
      projectRoot: backendRoot,
      depsLockFilePath: backendLockFile,
      handler: "handler",
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      // Cap parallel Bedrock invocations to bound cost if the upload/email paths are
      // flooded (denial-of-wallet control the README claimed but never set).
      reservedConcurrentExecutions: 5,
      environment: {
        ATTACHMENT_BUCKET: attachmentBucket.bucketName,
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
      logRetention: lambdaLogRetention,
    });

    const apiFn = new lambdaNode.NodejsFunction(this, "ApiLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../backend/src/api.ts"),
      projectRoot: backendRoot,
      depsLockFilePath: backendLockFile,
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      environment: {
        ATTACHMENT_BUCKET: attachmentBucket.bucketName,
        TABLE_NAME: table.tableName,
        QUEUE_URL: queue.queueUrl,
        MAX_UPLOAD_BYTES: String(maxUploadBytes),
      },
      logRetention: lambdaLogRetention,
    });

    rawBucket.grantRead(ingestFn);
    attachmentBucket.grantWrite(ingestFn);
    attachmentBucket.grantRead(extractFn);
    attachmentBucket.grantRead(apiFn);
    attachmentBucket.grantPut(apiFn);
    attachmentBucket.grantDelete(apiFn);
    table.grantReadWriteData(ingestFn);
    table.grantReadWriteData(extractFn);
    table.grantReadWriteData(apiFn);
    queue.grantSendMessages(ingestFn);
    queue.grantConsumeMessages(extractFn);
    queue.grantSendMessages(apiFn);

    // NetSuite OAuth 2.0 (M2M) credentials for the scaffolded push path. Populate the secret
    // value after deploy (or in a sandbox): { accountId, clientId, certificateId, privateKeyPem, alg }.
    const netsuiteSecret = new secretsmanager.Secret(this, "NetSuiteSecret", {
      secretName: `${props.projectPrefix}/netsuite`,
      description: "NetSuite SuiteTalk OAuth 2.0 M2M credentials (accountId, clientId, certificateId, privateKeyPem, alg)",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    netsuiteSecret.grantRead(apiFn);
    apiFn.addEnvironment("NETSUITE_SECRET_ARN", netsuiteSecret.secretArn);

    // Bedrock permissions for Claude
    extractFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          // bedrockModelId is a cross-region inference profile, not a base model,
          // so InvokeModel must be granted on the inference-profile resource...
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${bedrockModelId}`,
          // ...and on the underlying foundation model in every region the EU geo
          // profile may route to (hence the region wildcard).
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*`,
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
      projectRoot: backendRoot,
      depsLockFilePath: backendLockFile,
      handler: "handler",
      timeout: cdk.Duration.minutes(2),
      environment: {
        ATTACHMENT_BUCKET: attachmentBucket.bucketName,
        QUEUE_URL: queue.queueUrl,
        TABLE_NAME: table.tableName,
        MAX_UPLOAD_BYTES: String(maxUploadBytes),
      },
      logRetention: lambdaLogRetention,
    });

    attachmentBucket.grantRead(uploadIngestFn);
    table.grantReadWriteData(uploadIngestFn);
    queue.grantSendMessages(uploadIngestFn);

    // Web uploads land under "uploads/" and only those should trigger the upload-ingest
    // Lambda. Email attachments live under "attachments/" and are enqueued directly by the
    // ingest Lambda, so they must NOT be re-processed here (prevents double extraction and
    // clobbering of the email sender metadata).
    attachmentBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(uploadIngestFn),
      { prefix: "uploads/" }
    );

    rawBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${rawBucket.bucketArn}/raw/*`],
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        conditions: {
          // aws:Referer is spoofable; SES now supports the standard source conditions.
          StringEquals: { "aws:SourceAccount": cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": `arn:aws:ses:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:receipt-rule-set/${props.projectPrefix}-rule-set:receipt-rule/*`,
          },
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

    // SES only routes inbound mail through the ONE active rule set per region, and there is
    // no native CloudFormation resource to activate one. Use a custom resource to call
    // ses:SetActiveReceiptRuleSet on deploy (and clear it on delete). Only one rule set can be
    // active per account/region, so coordinate if other stacks manage SES receipt rules.
    new cr.AwsCustomResource(this, "ActivateReceiptRuleSet", {
      onUpdate: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: { RuleSetName: receiptRuleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of(`active-${props.projectPrefix}-rule-set`),
      },
      onDelete: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    extractFn.addEventSourceMapping("ExtractQueueMapping", {
      eventSourceArn: queue.queueArn,
      batchSize: 1,
    });

    // Operational alarms. Subscribe an email/Slack endpoint to this topic after deploy.
    const alarmTopic = new sns.Topic(this, "AlarmsTopic", {
      topicName: `${props.projectPrefix}-alarms`,
    });

    dlq
      .metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) })
      .createAlarm(this, "DlqNotEmptyAlarm", {
        alarmDescription: "Messages have landed in the extraction dead-letter queue",
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    new cloudwatch.Metric({
      namespace: "InvoiceExtractor",
      metricName: "ExtractionFailure",
      statistic: "Sum",
      period: cdk.Duration.minutes(15),
    })
      .createAlarm(this, "ExtractionFailureAlarm", {
        alarmDescription: "Invoice extractions are failing",
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // --- Frontend hosting (created before the API so the Cognito callback URLs and the
    // API CORS allow-list can reference the CloudFront URL) ---
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `${props.projectPrefix}-ui-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "frontend-bucket/",
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    siteBucket.grantRead(oai);

    // Security response headers (HSTS, CSP, frame/referrer/content-type protections).
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      responseHeadersPolicyName: `${props.projectPrefix}-security-headers`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          // script-src 'self' is safe: the page has no inline scripts (see frontend/sw-register.js).
          // connect-src covers the API Gateway + presigned S3 (both *.amazonaws.com); the Cognito
          // hosted-UI login is a top-level navigation, not a fetch.
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.amazonaws.com; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "FrontendDistribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
      },
      defaultRootObject: "index.html",
    });

    const appUrl = `https://${distribution.domainName}`;

    // --- Cognito (admin authentication for the API + UI) ---
    const cognitoDomainPrefix = `${props.projectPrefix}-admin-${cdk.Aws.ACCOUNT_ID}`;

    const userPool = new cognito.UserPool(this, "AdminUserPool", {
      userPoolName: `${props.projectPrefix}-admins`,
      selfSignUpEnabled: false, // admins are invited, not self-registered
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    userPool.addDomain("AdminUserPoolDomain", {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

    const userPoolClient = userPool.addClient("AdminWebClient", {
      userPoolClientName: `${props.projectPrefix}-admin-web`,
      generateSecret: false, // public SPA client
      authFlows: { userSrp: true },
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [appUrl, `${appUrl}/`],
        logoutUrls: [appUrl, `${appUrl}/`],
      },
    });

    // JWT authorizer validating Cognito id tokens on every API route.
    const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      "AdminJwtAuthorizer",
      `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] }
    );

    const httpApi = new apigwv2.HttpApi(this, "InvoiceApi", {
      apiName: `${props.projectPrefix}-api`,
      corsPreflight: {
        allowOrigins: [appUrl],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.days(10),
      },
    });

    httpApi.addRoutes({
      path: "/invoices",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("ListIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/stats",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("StatsIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DetailIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DeleteIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}/download",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DownloadIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/invoices/{messageId}/{attachmentId}/netsuite",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("NetSuiteIntegration", apiFn),
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/upload",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("UploadIntegration", apiFn),
      authorizer: jwtAuthorizer,
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
              cognito: {
                region: cdk.Aws.REGION,
                userPoolId: userPool.userPoolId,
                clientId: userPoolClient.userPoolClientId,
                domain: `${cognitoDomainPrefix}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
                scope: "openid email profile",
                redirectUri: appUrl,
              },
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
    new cdk.CfnOutput(this, "AttachmentBucketName", { value: attachmentBucket.bucketName });
    new cdk.CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new cdk.CfnOutput(this, "AlarmsTopicArn", { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CognitoHostedUiDomain", {
      value: `${cognitoDomainPrefix}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, "NetSuiteSecretName", { value: netsuiteSecret.secretName });
  }
}
