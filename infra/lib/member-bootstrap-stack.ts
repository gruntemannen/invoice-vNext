import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

interface MemberBootstrapStackProps extends cdk.StackProps {
  managementAccountId: string;
  projectPrefix: string;
}

export class MemberBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemberBootstrapStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", props.projectPrefix);

    const deployerRole = new iam.Role(this, "InvoiceExtractorDeployerRole", {
      roleName: "InvoiceExtractorDeployerRole",
      assumedBy: new iam.AccountPrincipal(props.managementAccountId),
      description: "Least-privilege deployer for Invoice Extractor",
    });

    const policy = new iam.Policy(this, "InvoiceExtractorDeployerPolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "cloudformation:CreateStack",
            "cloudformation:UpdateStack",
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:GetTemplate",
            "cloudformation:ListStackResources",
            "cloudformation:CreateChangeSet",
            "cloudformation:ExecuteChangeSet",
            "cloudformation:DescribeChangeSet",
            "cloudformation:DescribeEvents",
            "cloudformation:ListChangeSets",
            "cloudformation:DeleteChangeSet",
          ],
          resources: [
            `arn:aws:cloudformation:*:${cdk.Aws.ACCOUNT_ID}:stack/${props.projectPrefix}*/*`,
            `arn:aws:cloudformation:*:${cdk.Aws.ACCOUNT_ID}:stack/InvoiceExtractorStack*/*`,
            `arn:aws:cloudformation:*:${cdk.Aws.ACCOUNT_ID}:stack/MemberBootstrapStack*/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            "cloudformation:ListStacks",
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStackResources",
            "cloudformation:GetTemplate",
            "cloudformation:ValidateTemplate",
            "cloudformation:DescribeEvents",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: [
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:PutRolePolicy",
            "iam:DeleteRolePolicy",
            "iam:AttachRolePolicy",
            "iam:DetachRolePolicy",
            "iam:PassRole",
            "iam:GetRole",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:CreatePolicy",
            "iam:DeletePolicy",
            "iam:GetPolicy",
            "iam:ListPolicyVersions",
            "iam:DeletePolicyVersion",
            "iam:CreatePolicyVersion",
          ],
          resources: ["*"],
          conditions: {
            StringEqualsIfExists: {
              "aws:RequestTag/Project": props.projectPrefix,
              "aws:ResourceTag/Project": props.projectPrefix,
            },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["Project"] },
          },
        }),
        new iam.PolicyStatement({
          actions: [
            "lambda:*",
            "apigateway:*",
            "logs:*",
            "events:*",
            "s3:*",
            "sqs:*",
            "dynamodb:*",
            "ses:*",
            "cloudfront:*",
            "cloudwatch:*",
            "ssm:*",
          ],
          resources: ["*"],
          conditions: {
            StringEqualsIfExists: {
              "aws:RequestTag/Project": props.projectPrefix,
              "aws:ResourceTag/Project": props.projectPrefix,
            },
            "ForAllValues:StringEquals": { "aws:TagKeys": ["Project"] },
          },
        }),
      ],
    });

    deployerRole.attachInlinePolicy(policy);
  }
}
