#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OrgAccountStack } from "../lib/org-account-stack";
import { MemberBootstrapStack } from "../lib/member-bootstrap-stack";
import { InvoiceExtractorStack } from "../lib/workload-stack";
import { config } from "../lib/config";

const app = new cdk.App();
const stackFilter = String(app.node.tryGetContext("stacks") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const shouldDeploy = (name: string) => stackFilter.length === 0 || stackFilter.includes(name);

if (shouldDeploy("OrgAccountStack")) {
  new OrgAccountStack(app, "OrgAccountStack", {
    env: { account: config.managementAccountId, region: config.region },
  });
}

if (shouldDeploy("MemberBootstrapStack")) {
  new MemberBootstrapStack(app, "MemberBootstrapStack", {
    env: { account: cdk.Aws.ACCOUNT_ID, region: config.region },
    managementAccountId: config.managementAccountId,
    projectPrefix: config.projectPrefix,
  });
}

if (shouldDeploy("InvoiceExtractorStack")) {
  new InvoiceExtractorStack(app, "InvoiceExtractorStack", {
    env: { account: cdk.Aws.ACCOUNT_ID, region: config.region },
    projectPrefix: config.projectPrefix,
  });
}
