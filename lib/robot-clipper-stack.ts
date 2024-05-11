import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { ChannelStack, EventType } from './channel';

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
        const finalBucket = new s3.Bucket(this, 'FinalBucket', {});

        // Lambda function to convert m3u8 to mp4 using FFmpeg
        const ffmpegLayer = new lambda.LayerVersion(this, 'FFmpegLayer', {
            code: lambda.Code.fromAsset('src/lambda-layer/ffmpeg/ffmpeg.zip'),
            compatibleArchitectures: [lambda.Architecture.ARM_64],
            license: 'https://ffmpeg.org/legal.html',
        });
        const ffmpegLambda = new lambda.Function(this, 'FFmpegLambda', {
            code: lambda.Code.fromAsset('src/lambda/trans'),
            handler: 'handler.handler',
            runtime: lambda.Runtime.PYTHON_3_12,
            architecture: lambda.Architecture.ARM_64,
            logRetention: logs.RetentionDays.THREE_DAYS,
            layers: [ffmpegLayer],
            environment: {
                'S3_DESTINATION_BUCKET': finalBucket.bucketName,
            },
            timeout: cdk.Duration.seconds(600),
            memorySize: 6144,
        });
        this.harvestBucket.grantRead(ffmpegLambda);
        finalBucket.grantPut(ffmpegLambda);
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
            targets: [new targets.LambdaFunction(ffmpegLambda)],
        });

        // TODO: DDB store for harvest state

        new ChannelStack(this, 'TestChannelStack', {
            harvestBucket: this.harvestBucket,
            iamHarvestRole: this.iamHarvestRole,
            eventType: EventType.FTC,
        });
    }
}
