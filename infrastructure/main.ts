/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import {
  App,
  Fn,
  TerraformAsset,
  TerraformOutput,
  TerraformStack,
} from "cdktf";
import * as path from "path";
import { sync as glob } from "glob";
import { lookup as mime } from "mime-types";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import { CloudfrontDistribution } from "@cdktf/provider-aws/lib/cloudfront-distribution";
import { DataAwsEcrAuthorizationToken } from "@cdktf/provider-aws/lib/data-aws-ecr-authorization-token";
import { EcrRepository } from "@cdktf/provider-aws/lib/ecr-repository";
import { EcsCluster } from "@cdktf/provider-aws/lib/ecs-cluster";
import { EcsClusterCapacityProviders } from "@cdktf/provider-aws/lib/ecs-cluster-capacity-providers";
import { EcsService } from "@cdktf/provider-aws/lib/ecs-service";
import { EcsTaskDefinition } from "@cdktf/provider-aws/lib/ecs-task-definition";
import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { Lb } from "@cdktf/provider-aws/lib/lb";
import { LbListener } from "@cdktf/provider-aws/lib/lb-listener";
import { LbTargetGroup } from "@cdktf/provider-aws/lib/lb-target-group";
import { LbListenerRule } from "@cdktf/provider-aws/lib/lb-listener-rule";
import { CloudwatchLogGroup } from "@cdktf/provider-aws/lib/cloudwatch-log-group";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";
import { S3Bucket } from "@cdktf/provider-aws/lib/s3-bucket";
import { S3Object } from "@cdktf/provider-aws/lib/s3-object";
import { S3BucketPolicy } from "@cdktf/provider-aws/lib/s3-bucket-policy";
import { S3BucketWebsiteConfiguration } from "@cdktf/provider-aws/lib/s3-bucket-website-configuration";
import { NullProvider } from "@cdktf/provider-null/lib/provider";
import { Resource } from "@cdktf/provider-null/lib/resource";
import { Vpc } from "./.gen/modules/terraform-aws-modules/aws/vpc";
import { Rds } from "./.gen/modules/terraform-aws-modules/aws/rds";
import { RandomProvider } from "./.gen/providers/random/provider";
import { Password } from "./.gen/providers/random/password";

const S3_ORIGIN_ID = "s3Origin";
const BACKEND_ORIGIN_ID = "backendOrigin";
const REGION = "us-east-1";

const tags = {
  team: "cdk",
  owner: "dschmidt",
};

class PushedECRImage extends Construct {
  tag: string;
  image: Resource;
  constructor(scope: Construct, name: string, projectPath: string) {
    super(scope, name);
    const repo = new EcrRepository(this, `ecr`, {
      name,
      tags,
    });

    const auth = new DataAwsEcrAuthorizationToken(this, `auth`, {
      dependsOn: [repo],
      registryId: repo.registryId,
    });

    const asset = new TerraformAsset(this, `project`, {
      path: projectPath,
    });

    const version = require(`${projectPath}/package.json`).version;
    this.tag = `${repo.repositoryUrl}:${version}-${asset.assetHash}`;
    // Workaround due to https://github.com/kreuzwerker/terraform-provider-docker/issues/189
    this.image = new Resource(this, `image`, {
      provisioners: [
        {
          type: "local-exec",
          workingDir: asset.path,
          command: `docker login -u ${auth.userName} -p ${auth.password} ${auth.proxyEndpoint} && 
  docker build -t ${this.tag} . && 
  docker push ${this.tag}`,
        },
      ],
    });
  }
}
class PostgresDB extends Construct {
  public instance: Rds;

  constructor(
    scope: Construct,
    name: string,
    vpc: Vpc,
    serviceSecurityGroup: SecurityGroup
  ) {
    super(scope, name);

    // Create a password stored in the TF State on the fly
    const password = new Password(this, `db-password`, {
      length: 16,
      special: false,
    });

    const dbPort = 5432;

    const dbSecurityGroup = new SecurityGroup(this, "db-security-group", {
      vpcId: Fn.tostring(vpc.vpcIdOutput),
      ingress: [
        // allow traffic to the DBs port from the service
        {
          fromPort: dbPort,
          toPort: dbPort,
          protocol: "TCP",
          securityGroups: [serviceSecurityGroup.id],
        },
      ],
      tags,
    });

    // Using this module: https://registry.terraform.io/modules/terraform-aws-modules/rds/aws/latest
    const db = new Rds(this, "db", {
      identifier: `${name}-db`,

      engine: "postgres",
      engineVersion: "14.1",
      family: "postgres14",
      majorEngineVersion: "14",
      instanceClass: "db.t3.micro",
      allocatedStorage: "5",

      createDbOptionGroup: false,
      createDbParameterGroup: false,
      applyImmediately: true,

      name,
      port: String(dbPort),
      username: `${name}user`,
      password: password.result,

      maintenanceWindow: "Mon:00:00-Mon:03:00",
      backupWindow: "03:00-06:00",

      // This is necessary due to a shortcoming in our token system to be adressed in
      // https://github.com/hashicorp/terraform-cdk/issues/651
      subnetIds: vpc.databaseSubnetsOutput as unknown as any,
      vpcSecurityGroupIds: [dbSecurityGroup.id],
      tags,
    });

    this.instance = db;
  }
}

class Cluster extends Construct {
  public cluster: EcsCluster;
  constructor(scope: Construct, clusterName: string) {
    super(scope, clusterName);

    const cluster = new EcsCluster(this, `ecs-${clusterName}`, {
      name: clusterName,
      tags,
    });

    new EcsClusterCapacityProviders(this, `capacity-providers-${clusterName}`, {
      clusterName: cluster.name,
      capacityProviders: ["FARGATE"],
    });

    this.cluster = cluster;
  }

  public runDockerImage(
    name: string,
    tag: string,
    image: Resource,
    env: Record<string, string | undefined>
  ) {
    // Role that allows us to get the Docker image
    const executionRole = new IamRole(this, `execution-role`, {
      name: `${name}-execution-role`,
      tags,
      inlinePolicy: [
        {
          name: "allow-ecr-pull",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "ecr:GetAuthorizationToken",
                  "ecr:BatchCheckLayerAvailability",
                  "ecr:GetDownloadUrlForLayer",
                  "ecr:BatchGetImage",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                ],
                Resource: "*",
              },
            ],
          }),
        },
      ],
      // this role shall only be used by an ECS task
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Sid: "",
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
            },
          },
        ],
      }),
    });

    // Role that allows us to push logs
    const taskRole = new IamRole(this, `task-role`, {
      name: `${name}-task-role`,
      tags,
      inlinePolicy: [
        {
          name: "allow-logs",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: "*",
              },
            ],
          }),
        },
      ],
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Sid: "",
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
            },
          },
        ],
      }),
    });

    // Creates a log group for the task
    const logGroup = new CloudwatchLogGroup(this, `loggroup`, {
      name: `${this.cluster.name}/${name}`,
      retentionInDays: 30,
      tags,
    });

    // Creates a task that runs the docker container
    const task = new EcsTaskDefinition(this, `task`, {
      // We want to wait until the image is actually pushed
      dependsOn: [image],
      tags,
      // These values are fixed for the example, we can make them part of our function invocation if we want to change them
      cpu: "256",
      memory: "512",
      requiresCompatibilities: ["FARGATE", "EC2"],
      networkMode: "awsvpc",
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      containerDefinitions: JSON.stringify([
        {
          name,
          image: tag,
          cpu: 256,
          memory: 512,
          environment: Object.entries(env).map(([name, value]) => ({
            name,
            value,
          })),
          portMappings: [
            {
              containerPort: 80,
              hostPort: 80,
            },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              // Defines the log
              "awslogs-group": logGroup.name,
              "awslogs-region": REGION,
              "awslogs-stream-prefix": name,
            },
          },
        },
      ]),
      family: "service",
    });

    return task;
  }
}

class LoadBalancer extends Construct {
  lb: Lb;
  lbl: LbListener;
  vpc: Vpc;
  cluster: EcsCluster;

  constructor(scope: Construct, name: string, vpc: Vpc, cluster: EcsCluster) {
    super(scope, name);
    this.vpc = vpc;
    this.cluster = cluster;

    const lbSecurityGroup = new SecurityGroup(this, `lb-security-group`, {
      vpcId: Fn.tostring(vpc.vpcIdOutput),
      tags,
      ingress: [
        // allow HTTP traffic from everywhere
        {
          protocol: "TCP",
          fromPort: 80,
          toPort: 80,
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
      egress: [
        // allow all traffic to every destination
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
    });
    this.lb = new Lb(this, `lb`, {
      name,
      tags,
      // we want this to be our public load balancer so that cloudfront can access it
      internal: false,
      loadBalancerType: "application",
      securityGroups: [lbSecurityGroup.id],
      subnets: Fn.tolist(vpc.publicSubnetsOutput),
    });

    this.lbl = new LbListener(this, `lb-listener`, {
      loadBalancerArn: this.lb.arn,
      port: 80,
      protocol: "HTTP",
      tags,
      defaultAction: [
        // We define a fixed 404 message, just in case
        {
          type: "fixed-response",
          fixedResponse: {
            contentType: "text/plain",
            statusCode: "404",
            messageBody: "Could not find the resource you are looking for",
          },
        },
      ],
    });
  }

  exposeService(
    name: string,
    task: EcsTaskDefinition,
    serviceSecurityGroup: SecurityGroup,
    path: string
  ) {
    // Define Load Balancer target group with a health check on /ready
    const targetGroup = new LbTargetGroup(this, `target-group`, {
      dependsOn: [this.lbl],
      tags,
      name: `${name}-target-group`,
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: Fn.tostring(this.vpc.vpcIdOutput),
      healthCheck: {
        enabled: true,
        path: "/ready",
      },
    });

    // Makes the listener forward requests from subpath to the target group
    new LbListenerRule(this, `rule`, {
      listenerArn: this.lbl.arn,
      priority: 100,
      tags,
      action: [
        {
          type: "forward",
          targetGroupArn: targetGroup.arn,
        },
      ],

      condition: [
        {
          pathPattern: { values: [`${path}*`] },
        },
      ],
    });

    // Ensure the task is running and wired to the target group, within the right security group
    new EcsService(this, `service`, {
      dependsOn: [this.lbl],
      tags,
      name,
      launchType: "FARGATE",
      cluster: this.cluster.id,
      desiredCount: 1,
      taskDefinition: task.arn,
      networkConfiguration: {
        subnets: Fn.tolist(this.vpc.publicSubnetsOutput),
        assignPublicIp: true,
        securityGroups: [serviceSecurityGroup.id],
      },
      loadBalancer: [
        {
          containerPort: 80,
          containerName: name,
          targetGroupArn: targetGroup.arn,
        },
      ],
    });
  }
}

class PublicS3Bucket extends Construct {
  bucket: S3Bucket;

  constructor(scope: Construct, name: string, absoluteContentPath: string) {
    super(scope, name);
    // Get built context into the terraform context
    const { path: contentPath, assetHash: contentHash } = new TerraformAsset(
      this,
      `context`,
      {
        path: absoluteContentPath,
      }
    );

    // Create bucket
    this.bucket = new S3Bucket(this, `bucket`, {
      bucketPrefix: `${name}`,

      tags: {
        ...tags,
        "hc-internet-facing": "true", // this is only needed for HashiCorp internal security auditing
      },
    });

    // Enable website delivery
    new S3BucketWebsiteConfiguration(this, `website-configuration`, {
      bucket: this.bucket.bucket,

      indexDocument: {
        suffix: "index.html",
      },

      errorDocument: {
        key: "index.html", // we could put a static error page here
      },
    });

    // Get all build files synchronously
    const files = glob("**/*.{json,js,html,png,ico,txt,map,css}", {
      cwd: absoluteContentPath,
    });

    files.forEach((f) => {
      // Construct the local path to the file
      const filePath = path.join(contentPath, f);

      // Creates all the files in the bucket
      new S3Object(this, `${name}/${f}/${contentHash}`, {
        bucket: this.bucket.id,
        tags,
        key: f,
        source: filePath,
        // mime is an open source node.js tool to get mime types per extension
        contentType: mime(path.extname(f)) || "text/html",
        etag: `filemd5("${filePath}")`,
      });
    });

    // allow read access to all elements within the S3Bucket
    new S3BucketPolicy(this, `s3-policy`, {
      bucket: this.bucket.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Id: `${name}-public-website`,
        Statement: [
          {
            Sid: "PublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: ["s3:GetObject"],
            Resource: [`${this.bucket.arn}/*`, `${this.bucket.arn}`],
          },
        ],
      }),
    });
  }

  get websiteEndpoint() {
    return this.bucket.websiteEndpoint;
  }
}

class MyStack extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    // We need to instanciate all providers we are going to use
    new AwsProvider(this, "aws", {
      region: REGION,
    });
    new NullProvider(this, "null", {});
    new RandomProvider(this, "random", {});

    const vpc = new Vpc(this, "vpc", {
      // We use the name of the stack
      name,
      // We tag every resource with the same set of tags to easily identify the resources
      tags,
      cidr: "10.0.0.0/16",
      // We want to run on three availability zones
      azs: ["a", "b", "c"].map((i) => `${REGION}${i}`),
      // We need three CIDR blocks as we have three availability zones
      privateSubnets: ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"],
      publicSubnets: ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"],
      databaseSubnets: ["10.0.201.0/24", "10.0.202.0/24", "10.0.203.0/24"],
      createDatabaseSubnetGroup: true,
      enableNatGateway: true,
      // Using a single NAT Gateway will save us some money, coming with the cost of less redundancy
      singleNatGateway: true,
    });

    const cluster = new Cluster(this, "cluster");
    const loadBalancer = new LoadBalancer(
      this,
      "loadbalancer",
      vpc,
      cluster.cluster
    );
    const serviceSecurityGroup = new SecurityGroup(
      this,
      `service-security-group`,
      {
        vpcId: Fn.tostring(vpc.vpcIdOutput),
        tags,
        ingress: [
          // only allow incoming traffic from our load balancer
          {
            protocol: "TCP",
            fromPort: 80,
            toPort: 80,
            securityGroups: loadBalancer.lb.securityGroups,
          },
        ],
        egress: [
          // allow all outgoing traffic
          {
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
            cidrBlocks: ["0.0.0.0/0"],
            ipv6CidrBlocks: ["::/0"],
          },
        ],
      }
    );

    const db = new PostgresDB(
      this,
      "dockerintegration",
      vpc,
      serviceSecurityGroup
    );

    const { image: backendImage, tag: backendTag } = new PushedECRImage(
      this,
      "backend-image",
      path.resolve(__dirname, "../application/backend")
    );

    const task = cluster.runDockerImage("backend", backendTag, backendImage, {
      PORT: "80",
      POSTGRES_USER: db.instance.username,
      POSTGRES_PASSWORD: db.instance.password,
      POSTGRES_DB: db.instance.name,
      POSTGRES_HOST: Fn.tostring(db.instance.dbInstanceAddressOutput),
      POSTGRES_PORT: Fn.tostring(db.instance.dbInstancePortOutput),
    });
    loadBalancer.exposeService(
      "backend",
      task,
      serviceSecurityGroup,
      "/backend"
    );

    const bucket = new PublicS3Bucket(
      this,
      name,
      path.resolve(__dirname, "../application/frontend/build")
    );

    const cdn = new CloudfrontDistribution(this, "cf", {
      comment: `Docker example frontend`,
      tags,
      enabled: true,
      defaultCacheBehavior: {
        // Allow every method as we want to also serve the backend through this
        allowedMethods: [
          "DELETE",
          "GET",
          "HEAD",
          "OPTIONS",
          "PATCH",
          "POST",
          "PUT",
        ],
        cachedMethods: ["GET", "HEAD"],
        targetOriginId: S3_ORIGIN_ID,
        viewerProtocolPolicy: "redirect-to-https", // ensure we serve https
        forwardedValues: { queryString: true, cookies: { forward: "none" } },
      },

      // origins describe different entities that can serve traffic
      origin: [
        {
          originId: S3_ORIGIN_ID, // origin ids can be freely chosen
          domainName: bucket.websiteEndpoint, // we serve the website hosted by S3 here
          customOriginConfig: {
            originProtocolPolicy: "http-only", // the CDN terminates the SSL connection, we can use http internally
            httpPort: 80,
            httpsPort: 443,
            originSslProtocols: ["TLSv1.2", "TLSv1.1", "TLSv1"],
          },
        },
        {
          originId: BACKEND_ORIGIN_ID,
          domainName: loadBalancer.lb.dnsName, // our backend is served by the load balancer
          customOriginConfig: {
            originProtocolPolicy: "http-only",
            httpPort: 80,
            httpsPort: 443,
            originSslProtocols: ["TLSv1.2", "TLSv1.1", "TLSv1"],
          },
        },
      ],
      // We define everything that should not be served by the default here
      orderedCacheBehavior: [
        {
          allowedMethods: [
            "HEAD",
            "DELETE",
            "POST",
            "GET",
            "OPTIONS",
            "PUT",
            "PATCH",
          ],
          cachedMethods: ["HEAD", "GET"],
          pathPattern: "/backend/*", // our backend should be served under /backend
          targetOriginId: BACKEND_ORIGIN_ID,
          // low TTLs so that the cache is busted relatively quickly
          minTtl: 0,
          defaultTtl: 10,
          maxTtl: 50,
          viewerProtocolPolicy: "redirect-to-https",
          // currently our backend needs none of this, but it could potentially use any of these now
          forwardedValues: {
            queryString: true,
            headers: ["*"],
            cookies: {
              forward: "all",
            },
          },
        },
      ],
      defaultRootObject: "index.html",
      restrictions: { geoRestriction: { restrictionType: "none" } },
      viewerCertificate: { cloudfrontDefaultCertificate: true }, // we use the default SSL Certificate
    });

    // Prints the domain name that serves our application
    new TerraformOutput(this, "domainName", {
      value: cdn.domainName,
    });
  }
}

const app = new App();
new MyStack(app, "example-staging");
app.synth();
