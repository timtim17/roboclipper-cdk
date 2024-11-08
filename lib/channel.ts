import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as medialive from 'aws-cdk-lib/aws-medialive';
import * as mediapackage from 'aws-cdk-lib/aws-mediapackage';
import * as s3 from 'aws-cdk-lib/aws-s3';

export enum EventType { FTC, FRC, RoboMaster, Test }

interface ChannelStackProps {
    harvestBucket: s3.Bucket,
    iamHarvestRole: iam.Role,
    harvestStateTable?: ddb.Table,
    downstreamRtmp?: {rtmpUrl: string, rtmpKey: string},
    eventKey?: string,
    eventType?: EventType,
    inputSecurityGroup: medialive.CfnInputSecurityGroup,
}

export class ChannelStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps & ChannelStackProps) {
        super(scope, id, props);

        if (props.eventType == EventType.FRC || props.eventType == EventType.RoboMaster) {
            throw new Error('FRC and RoboMaster events are not yet supported');
        }

        // MediaPackage channel for harvest VOD jobs
        const mpChannel = new mediapackage.CfnChannel(this, 'MediaPackageChannel', {
            id: `${id}Channel`,
            description: 'MediaPackage channel for harvest VOD jobs',
        });
        const mpEndpoint = new mediapackage.CfnOriginEndpoint(this, 'MediaPackageEndpoint', {
            channelId: mpChannel.ref,
            id: `${id}Endpoint`,
            hlsPackage: {
                segmentDurationSeconds: 6,
                playlistWindowSeconds: 60,
            },
            startoverWindowSeconds: 30 * 60,    // 30 * 60 seconds = 30 minutes
            origination: 'ALLOW',
        });

        // MediaLive channel to intake RTMP Push input and stream to two locations, RTMP and MediaPackage
        const input = new medialive.CfnInput(this, 'MediaLiveInput', {
            type: 'RTMP_PUSH',
            destinations: [{
                streamName: 'live',
            }],
            inputSecurityGroups: [props.inputSecurityGroup.ref],
            name: `${id}Input`,
        });
        const destinations: medialive.CfnChannel.OutputDestinationProperty[] = [{
            id: 'MediaPackageOutput',
            mediaPackageSettings: [{
                channelId: mpChannel.ref,
            }],
        }];
        const outputGroups: medialive.CfnChannel.OutputGroupProperty[] = [{
            outputGroupSettings: {
                mediaPackageGroupSettings: {
                    destination: {
                        destinationRefId: 'MediaPackageOutput',
                    },
                },
            },
            outputs: [{
                audioDescriptionNames: ['audio_3_aac128'],
                outputName: "1920_1080",
                outputSettings: {
                    mediaPackageOutputSettings: {}
                },
                videoDescriptionName: "video_1920_1080"
            }],
        }];
        if (props.downstreamRtmp) {
            destinations.push({
                id: 'RtmpOutput',
                settings: [{
                    streamName: props.downstreamRtmp.rtmpKey,
                    url: props.downstreamRtmp.rtmpUrl,
                }]
            });
            outputGroups.push({
                outputGroupSettings: {
                    rtmpGroupSettings: {
                        authenticationScheme: 'COMMON',
                        inputLossAction: 'EMIT_OUTPUT',
                    },
                },
                outputs: [{
                    audioDescriptionNames: ['audio_3_aac128'],
                    outputName: "Stream",
                    outputSettings: {
                        rtmpOutputSettings: {
                            destination: {
                                destinationRefId: 'RtmpOutput',
                            },
                        },
                    },
                    videoDescriptionName: "video_1920_1080"
                }],
            });
        }
        const mlChannel = new medialive.CfnChannel(this, 'MediaLiveChannel', {
            channelClass: 'SINGLE_PIPELINE',
            destinations,
            encoderSettings: {
                audioDescriptions: [{
                    audioSelectorName: 'Default',
                    languageCodeControl: 'FOLLOW_INPUT',
                    codecSettings: {
                        aacSettings: {
                            bitrate: 128000,
                            sampleRate: 48000,
                        },
                    },
                    name: "audio_3_aac128"
                }],
                timecodeConfig: {
                    source: 'SYSTEMCLOCK',
                },
                videoDescriptions: [{
                    codecSettings: {
                        h264Settings: {
                            rateControlMode: 'CBR',
                            bitrate: 12_000_000,
                            framerateControl: 'SPECIFIED',
                            framerateDenominator: 1,
                            framerateNumerator: 60,
                            parControl: 'SPECIFIED',
                            parNumerator: 1,
                            parDenominator: 1,
                            profile: 'HIGH',
                            level: 'H264_LEVEL_4_2',
                            gopSize: 2,
                            gopSizeUnits: 'SECONDS',
                            gopNumBFrames: 2,
                        },
                    },
                    height: 1080,
                    name: 'video_1920_1080',
                    width: 1920,
                }],
                outputGroups,
            },
            inputAttachments: [{
                inputAttachmentName: 'InputAttachment',
                inputId: input.ref,
                inputSettings: {},
            }],
            inputSpecification: {
                codec: 'AVC',
                maximumBitrate: 'MAX_20_MBPS',
                resolution: 'HD',
            },
            name: `${id}Channel`,
            roleArn: 'arn:aws:iam::267253737119:role/MediaLiveAccessRole',  // TODO: portability,
            maintenance: {
                maintenanceDay: 'MONDAY',
                maintenanceStartTime: '09:00',
            },
        });

        // Lambda to create harvest jobs
        // const harvestLambda = new lambda.Function(this, 'HarvestLambda', {
        //     code: lambda.Code.fromAsset('src/lambda/harvester/target/lambda/robotclipper-harvester/'),
        //     handler: '.',
        //     runtime: lambda.Runtime.PROVIDED_AL2,
        //     architecture: lambda.Architecture.ARM_64,
        //     logRetention: logs.RetentionDays.THREE_DAYS,
        //     environment: {
        //         DDB_TABLE: props.harvestStateTable.tableArn,
        //         MP_ENDPOINT: mpEndpoint.ref,
        //         DEST_BUCKET: props.harvestBucket.bucketName,
        //         IAM_HARVEST: props.iamHarvestRole.roleArn,
        //         EVENT_KEY: props.eventKey,
        //         EVENT_TYPE: EventType[props.eventType],
        //     },
        //     timeout: cdk.Duration.seconds(10),
        // });
        // props.harvestStateTable.grantReadWriteData(harvestLambda);
        // harvestLambda.addToRolePolicy(new iam.PolicyStatement({
        //     actions: ['iam:PassRole'],
        //     resources: [props.iamHarvestRole.roleArn],
        // }));
        // harvestLambda.addToRolePolicy(new iam.PolicyStatement({
        //     actions: ['mediapackage:CreateHarvestJob'],
        //     resources: ['*'],
        // }));

        // Emit a CloudFormation output of the RTMP Input Push URL
        new cdk.CfnOutput(this, 'InputPushUrl', {
            value: cdk.Fn.select(0, input.attrDestinations),
            description: 'RTMP Input URL',
        });

        // TODO: CloudWatch alarm for if the channel is Enabled but no signal
        // from the input for > 10m, to trigger a command to turn off the Channel
        // TODO: A better way to detect this
        const noSignalAlarm = new cw.Alarm(this, 'ChannelNoInputAlarm', {
            metric: new cw.MathExpression({
                expression: 'FILL(m1, 0.0001)',
                label: 'InputVideoFrameRate (Replace Missing Data with 0.0001)',
                usingMetrics: {
                    m1: new cw.Metric({
                        namespace: 'AWS/MediaLive',
                        metricName: 'InputVideoFrameRate',
                        statistic: 'Average',
                        dimensionsMap: {
                            ChannelId: mlChannel.ref,
                            Pipeline: '0',
                        },
                    }),
                },
                period: cdk.Duration.minutes(1),
            }),
            threshold: 0,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 10,
        });

        this.tags.setTag('AppManagerCFNStackKey', this.stackName);
    }
}
