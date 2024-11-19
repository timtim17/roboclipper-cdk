import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as medialive from 'aws-cdk-lib/aws-medialive';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { ChannelStack, YouTubeOutput } from './channel';

export class RobotClipperStack extends cdk.Stack {

    harvestBucket: s3.Bucket;
    iamHarvestRole: iam.Role;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // S3 bucket for harvest VOD m3u8 playlists
        this.harvestBucket = new s3.Bucket(this, 'IntermediateBucket', {
            lifecycleRules: [{
                expiration: cdk.Duration.days(3),
            }],
        });
        this.iamHarvestRole = new iam.Role(this, 'IAMHarvestRole', {
            assumedBy: new iam.ServicePrincipal('mediapackage.amazonaws.com'),
        });
        const iamHarvestPolicy = new iam.Policy(this, 'IAMHarvestPolicy', {
            statements: [new iam.PolicyStatement({
                actions: ['s3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
                resources: [
                    this.harvestBucket.bucketArn,
                    this.harvestBucket.bucketArn + '/*',
                ],
            })],
        });
        iamHarvestPolicy.attachToRole(this.iamHarvestRole);

        // S3 bucket to store final assets
        const finalBucket = new s3.Bucket(this, 'FinalBucket', {
            blockPublicAccess: new s3.BlockPublicAccess({
                blockPublicPolicy: false,
                blockPublicAcls: true,
                restrictPublicBuckets: false,
                ignorePublicAcls: true,
            }),
        });
        finalBucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [finalBucket.arnForObjects('*')],
            principals: [new iam.AnyPrincipal()],
        }));
        finalBucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [finalBucket.bucketArn],
            principals: [new iam.AnyPrincipal()],
        }));
        finalBucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            effect: iam.Effect.DENY,
            resources: [finalBucket.arnForObjects('test/*')],
            notPrincipals: [new iam.ArnPrincipal('arn:aws:iam::267253737119:user/Administrator')],
        }));
        const finalBucketCreateSns = new sns.Topic(this, 'FinalBucketObjectCreate');
        finalBucket.addObjectCreatedNotification(new s3n.SnsDestination(finalBucketCreateSns));
        finalBucketCreateSns.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['SNS:Subscribe'],
            resources: [finalBucketCreateSns.topicArn],
            principals: [new iam.AccountPrincipal('831866741626')],
        }));

        // Lambda function to convert m3u8 to mp4
        const iamTranscode = new iam.Role(this, 'IAMTransRole', {
            assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
        });
        this.harvestBucket.grantRead(iamTranscode);
        finalBucket.grantPut(iamTranscode);
        const transcodeLambda = new lambda.Function(this, 'TransLambda', {
            code: lambda.Code.fromAsset('src/lambda/trans_rs/target/lambda/robotclipper-trans/'),
            handler: '.',
            runtime: lambda.Runtime.PROVIDED_AL2,
            architecture: lambda.Architecture.ARM_64,
            logRetention: logs.RetentionDays.THREE_DAYS,
            environment: {
                S3_DESTINATION_BUCKET: finalBucket.bucketName,
                IAM_ROLE: iamTranscode.roleArn,
            },
        });
        this.harvestBucket.grantRead(transcodeLambda);
        transcodeLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [iamTranscode.roleArn],
        }));
        transcodeLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['mediaconvert:CreateJob'],
            resources: ['*'],
        }));
        new events.Rule(this, 'HarvestSuccessEventRule', {
            eventPattern: {
                source: ['aws.mediapackage'],
                detailType: ['MediaPackage HarvestJob Notification'],
                detail: {
                    harvest_job: {
                        status: ['SUCCEEDED'],
                        s3_destination: {
                            bucket_name: [this.harvestBucket.bucketName],
                        },
                    }
                }
            },
            targets: [new targets.LambdaFunction(transcodeLambda)],
        });
        const inputSecurityGroup = new medialive.CfnInputSecurityGroup(this, 'MediaLiveInputSecurityGroup', {
            whitelistRules: [{
                cidr: '0.0.0.0/0',
            }],
        });

        new ChannelStack(this, 'TestChannelStack', {
            harvestBucket: this.harvestBucket,
            iamHarvestRole: this.iamHarvestRole,
            // downstreamRtmp: {
            //     rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
            //     rtmpKey: 'xxxx-xxxx-xxxx-xxxx-xxxx',
            // },
            inputSecurityGroup,
        });

        this.tags.setTag('AppManagerCFNStackKey', this.stackName);
    }
}
