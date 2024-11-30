import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { 
    aws_events as events,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_logs as logs,
    aws_medialive as medialive,
    aws_s3 as s3,
    aws_s3_notifications as s3n,
    aws_sns as sns,
    aws_events_targets as targets,
    aws_mediapackagev2 as emp2,
} from 'aws-cdk-lib';
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
        this.harvestBucket.grantWrite(new iam.ServicePrincipal('mediapackagev2.amazonaws.com'));

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
            runtime: lambda.Runtime.PROVIDED_AL2023,
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

        const empChannelGroup = new emp2.CfnChannelGroup(this, 'ChannelGroup', {
            channelGroupName: 'RoboClipper',
        });

        new ChannelStack(this, 'TestChannelStack', {
            // downstreamRtmps: [new YouTubeOutput('xxxx-xxxx-xxxx-xxxx-xxxx'),],
            inputSecurityGroup,
            empChannelGroup,
        });

        this.tags.setTag('AppManagerCFNStackKey', this.stackName);
    }
}
