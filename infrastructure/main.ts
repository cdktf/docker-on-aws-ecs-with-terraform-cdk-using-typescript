import { Construct } from "constructs";
import { App, TerraformAsset, TerraformOutput, TerraformStack } from "cdktf";
import * as path from "path";
import { sync as glob } from "glob";
import { lookup as mime } from "mime-types";
import {
  AwsProvider,
  CloudfrontDistribution,
  CloudwatchLogGroup,
  DataAwsEcrAuthorizationToken,
  EcrRepository,
  EcsCluster,
  EcsService,
  EcsTaskDefinition,
  IamRole,
  Lb,
  LbListener,
  LbListenerRule,
  LbTargetGroup,
  S3Bucket,
  S3BucketObject,
  S3BucketPolicy,
  SecurityGroup,
} from "@cdktf/provider-aws";
import { DockerProvider } from "./.gen/providers/docker/docker-provider";
import { NullProvider } from "./.gen/providers/null/null-provider";
import { Resource } from "./.gen/providers/null/resource";
import { TerraformAwsModulesVpcAws as VPC } from "./.gen/modules/terraform-aws-modules/vpc/aws";
import { TerraformAwsModulesRdsAws } from "./.gen/modules/terraform-aws-modules/rds/aws";
import { Password } from "./.gen/providers/random/password";

const S3_ORIGIN_ID = "s3Origin";
const BACKEND_ORIGIN_ID = "backendOrigin";
const REGION = "us-east-1";

const tags = {
  team: "cdk",
  owner: "dschmidt",
};

function PushedECRImage(scope: Construct, name: string, projectPath: string) {
  const repo = new EcrRepository(scope, `${name}-ecr`, {
    name,
    tags,
  });

  const auth = new DataAwsEcrAuthorizationToken(scope, `${name}-auth`, {
    dependsOn: [repo],
    registryId: repo.registryId,
  });

  const asset = new TerraformAsset(scope, `${name}-project`, {
    path: projectPath,
  });

  const version = require(`${projectPath}/package.json`).version;
  const tag = `${repo.repositoryUrl}:${version}-${asset.assetHash}`;
  // Workaround due to https://github.com/kreuzwerker/terraform-provider-docker/issues/189
  const image = new Resource(scope, `${name}-image-${tag}`, {});
  image.addOverride(
    "provisioner.local-exec.command",
    `
docker login -u ${auth.userName} -p ${auth.password} ${auth.proxyEndpoint} &&
docker build -t ${tag} ${asset.path} &&
docker push ${tag}
`
  );

  return { image, tag };
}

class PostgresDB extends Resource {
  public instance: TerraformAwsModulesRdsAws;

  constructor(
    scope: Construct,
    name: string,
    vpc: VPC,
    serviceSecurityGroup: SecurityGroup
  ) {
    super(scope, name);

    // Create a password stored in the TF State on the fly
    const password = new Password(this, `${name}-db-password`, {
      length: 16,
      special: false,
    });

    const dbPort = 5432;

    const dbSecurityGroup = new SecurityGroup(this, "db-security-group", {
      vpcId: vpc.vpcIdOutput,
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
    const db = new TerraformAwsModulesRdsAws(this, "db", {
      identifier: `${name}-db`,

      engine: "postgres",
      engineVersion: "11.10",
      family: "postgres11",
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

class Cluster extends Resource {
  public cluster: EcsCluster;
  constructor(scope: Construct, clusterName: string) {
    super(scope, clusterName);

    const cluster = new EcsCluster(this, `ecs-${clusterName}`, {
      name: clusterName,
      capacityProviders: ["FARGATE"],
      tags,
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
    const executionRole = new IamRole(this, `${name}-execution-role`, {
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
    const taskRole = new IamRole(this, `${name}-task-role`, {
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
    const logGroup = new CloudwatchLogGroup(this, `${name}-loggroup`, {
      name: `${this.cluster.name}/${name}`,
      retentionInDays: 30,
      tags,
    });

    // Creates a task that runs the docker container
    const task = new EcsTaskDefinition(this, `${name}-task`, {
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

class LoadBalancer extends Resource {
  lb: Lb;
  lbl: LbListener;
  vpc: VPC;
  cluster: EcsCluster;

  constructor(scope: Construct, name: string, vpc: VPC, cluster: EcsCluster) {
    super(scope, name);
    this.vpc = vpc;
    this.cluster = cluster;

    const lbSecurityGroup = new SecurityGroup(
      this,
      `${name}-lb-security-group`,
      {
        vpcId: vpc.vpcIdOutput,
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
      }
    );
    this.lb = new Lb(this, `${name}-lb`, {
      name,
      tags,
      // we want this to be our public load balancer so that cloudfront can access it
      internal: false,
      loadBalancerType: "application",
      securityGroups: [lbSecurityGroup.id],
    });

    // This is necessary due to a shortcoming in our token system to be adressed in
    // https://github.com/hashicorp/terraform-cdk/issues/651
    this.lb.addOverride("subnets", vpc.publicSubnetsOutput);

    this.lbl = new LbListener(this, `${name}-lb-listener`, {
      loadBalancerArn: this.lb.arn,
      port: 80,
      protocol: "HTTP",
      tags,
      defaultAction: [
        // We define a fixed 404 message, just in case
        {
          type: "fixed-response",
          fixedResponse: [
            {
              contentType: "text/plain",
              statusCode: "404",
              messageBody: "Could not find the resource you are looking for",
            },
          ],
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
    const targetGroup = new LbTargetGroup(this, `${name}-target-group`, {
      dependsOn: [this.lbl],
      tags,
      name: `${name}-target-group`,
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: this.vpc.vpcIdOutput,
      healthCheck: [
        {
          enabled: true,
          path: "/ready",
        },
      ],
    });

    // Makes the listener forward requests from subpath to the target group
    new LbListenerRule(this, `${name}-rule`, {
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
          pathPattern: [{ values: [`${path}*`] }],
        },
      ],
    });

    // Ensure the task is running and wired to the target group, within the right security group
    const service = new EcsService(this, `${name}-service`, {
      dependsOn: [this.lbl],
      tags,
      name,
      launchType: "FARGATE",
      cluster: this.cluster.id,
      desiredCount: 1,
      taskDefinition: task.arn,
      networkConfiguration: [
        {
          subnets: [],
          assignPublicIp: true,
          securityGroups: [serviceSecurityGroup.id],
        },
      ],
      loadBalancer: [
        {
          containerPort: 80,
          containerName: name,
          targetGroupArn: targetGroup.arn,
        },
      ],
    });

    // This is necessary due to a shortcoming in our token system to be adressed in
    // https://github.com/hashicorp/terraform-cdk/issues/651
    service.addOverride(
      "network_configuration.0.subnets",
      this.vpc.publicSubnetsOutput
    );
  }
}

function PublicS3Bucket(
  scope: Construct,
  name: string,
  absoluteContentPath: string
) {
  // Get built frontend into the terraform context
  const { path: contentPath, assetHash: contentHash } = new TerraformAsset(
    scope,
    `${name}-frontend`,
    {
      path: absoluteContentPath,
    }
  );

  // create bucket with website delivery enabled
  const bucket = new S3Bucket(scope, `${name}-bucket`, {
    bucketPrefix: `${name}-frontend`,

    website: [
      {
        indexDocument: "index.html",
        errorDocument: "index.html", // we could put a static error page here
      },
    ],
    tags: {
      ...tags,
      "hc-internet-facing": "true", // this is only needed for HashiCorp internal security auditing
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
    new S3BucketObject(scope, `${bucket.id}/${f}/${contentHash}`, {
      bucket: bucket.id,
      tags,
      key: f,
      source: filePath,
      // mime is an open source node.js tool to get mime types per extension
      contentType: mime(path.extname(f)) || "text/html",
      etag: `filemd5("${filePath}")`,
    });
  });

  // allow read access to all elements within the S3Bucket
  new S3BucketPolicy(scope, `${name}-s3-policy`, {
    bucket: bucket.id,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Id: `${name}-public-website`,
      Statement: [
        {
          Sid: "PublicRead",
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`${bucket.arn}/*`, `${bucket.arn}`],
        },
      ],
    }),
  });

  return bucket;
}

// TODO: tag everything
class MyStack extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    // We need to instanciate all providers we are going to use
    new AwsProvider(this, "aws", {
      region: REGION,
    });
    new DockerProvider(this, "docker");
    new NullProvider(this, "provider", {});

    const vpc = new VPC(this, "vpc", {
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
      `${name}-service-security-group`,
      {
        vpcId: vpc.vpcIdOutput,
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

    const { image: backendImage, tag: backendTag } = PushedECRImage(
      this,
      "backend",
      path.resolve(__dirname, "../../application/backend")
    );

    const task = cluster.runDockerImage("backend", backendTag, backendImage, {
      PORT: "80",
      POSTGRES_USER: db.instance.username,
      POSTGRES_PASSWORD: db.instance.password,
      POSTGRES_DB: db.instance.name,
      POSTGRES_HOST: db.instance.dbInstanceAddressOutput,
      POSTGRES_PORT: db.instance.dbInstancePortOutput,
    });
    loadBalancer.exposeService(
      "backend",
      task,
      serviceSecurityGroup,
      "/backend"
    );

    const bucket = PublicS3Bucket(
      this,
      name,
      path.resolve(__dirname, "../../application/frontend/build")
    );

    const cdn = new CloudfrontDistribution(this, "cf", {
      comment: `Docker example frontend`,
      tags,
      enabled: true,
      defaultCacheBehavior: [
        {
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
          forwardedValues: [
            { queryString: false, cookies: [{ forward: "none" }] },
          ],
        },
      ],
      // origins describe different entities that can serve traffic
      origin: [
        {
          originId: S3_ORIGIN_ID, // origin ids can be freely chosen
          domainName: bucket.websiteEndpoint, // we serve the website hosted by S3 here
          customOriginConfig: [
            {
              originProtocolPolicy: "http-only", // the CDN terminates the SSL connection, we can use http internally
              httpPort: 80,
              httpsPort: 443,
              originSslProtocols: ["TLSv1.2", "TLSv1.1", "TLSv1"],
            },
          ],
        },
        {
          originId: BACKEND_ORIGIN_ID,
          domainName: loadBalancer.lb.dnsName, // our backend is served by the load balancer
          customOriginConfig: [
            {
              originProtocolPolicy: "http-only",
              httpPort: 80,
              httpsPort: 443,
              originSslProtocols: ["TLSv1.2", "TLSv1.1", "TLSv1"],
            },
          ],
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
          forwardedValues: [
            {
              queryString: true,
              headers: ["*"],
              cookies: [
                {
                  forward: "all",
                },
              ],
            },
          ],
        },
      ],
      defaultRootObject: "index.html",
      restrictions: [{ geoRestriction: [{ restrictionType: "none" }] }],
      viewerCertificate: [{ cloudfrontDefaultCertificate: true }], // we use the default SSL Certificate
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
