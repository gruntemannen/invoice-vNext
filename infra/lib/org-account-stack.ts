import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnAccount } from "aws-cdk-lib/aws-organizations";
import { config } from "./config";

export class OrgAccountStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = new CfnAccount(this, "InvoiceExtractorAccount", {
      accountName: config.memberAccountName,
      email: config.memberAccountEmail,
      roleName: "OrganizationAccountAccessRole",
    });

    new cdk.CfnOutput(this, "MemberAccountId", {
      value: account.ref,
    });
  }
}
