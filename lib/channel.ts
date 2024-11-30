import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    aws_cloudwatch as cw,
    aws_dynamodb as ddb,
    aws_medialive as medialive,
    aws_mediapackagev2 as emp2,
} from 'aws-cdk-lib';

interface RtmpOutput {
    rtmpUrl: string,
    rtmpKey: string,
}

export class YouTubeOutput implements RtmpOutput {
    rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
    rtmpKey: string;

    constructor(rtmpKey: string) {
        this.rtmpKey = rtmpKey;
    }
}

export class TwitchOutput implements RtmpOutput {
    rtmpUrl = 'rtmp://usw20.contribute.live-video.net/app/';
    rtmpKey: string;

    constructor(rtmpKey: string) {
        this.rtmpKey = rtmpKey;
    }
}

interface ChannelStackProps {
    harvestStateTable?: ddb.Table,
    /**
     * @deprecated
     * @see {@link downstreamRtmps}
     */
    downstreamRtmp?: {rtmpUrl: string, rtmpKey: string},
    downstreamRtmps?: {rtmpUrl: string, rtmpKey: string}[],
    eventKey?: string,
    inputSecurityGroup: medialive.CfnInputSecurityGroup,
    empChannelGroup: emp2.CfnChannelGroup,
}

export class ChannelStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps & ChannelStackProps) {
        super(scope, id, props);

        if (props.downstreamRtmp) {
            props.downstreamRtmps = [...(props.downstreamRtmps ?? []), props.downstreamRtmp];
        }

        // MediaPackage channel for harvest VOD jobs
        const mp2Channel = new emp2.CfnChannel(this, 'MediaPackageV2Channel', {
            channelGroupName: props.empChannelGroup.channelGroupName,
            channelName: `${id}Channel`,
            inputType: 'HLS',
        });
        const mp2Endpoint = new emp2.CfnOriginEndpoint(this, 'MediaPackageV2Endpoint', {
            channelGroupName: props.empChannelGroup.channelGroupName,
            channelName: mp2Channel.channelName,
            containerType: 'TS',
            originEndpointName: 'main',
            lowLatencyHlsManifests: [
                {
                    manifestName: 'index',
                    manifestWindowSeconds: 60,
                },
            ],
            segment: {
                segmentDurationSeconds: 10,
                tsUseAudioRenditionGroup: false,
            },
            startoverWindowSeconds: 30 * 60,    // 30 * 60 seconds = 30 minutes
        });
        new emp2.CfnOriginEndpointPolicy(this, 'EMP2OriginEndpointPolicy', {
            channelGroupName: props.empChannelGroup.channelGroupName,
            channelName: mp2Channel.channelName,
            originEndpointName: mp2Endpoint.originEndpointName,
            policy: {
                "Version" : "2012-10-17",
                "Statement" : [ {
                  "Sid" : "AllowPublicGetObjectAccess",
                  "Effect" : "Allow",
                  "Principal" : "*",
                  "Action" : [ "mediapackagev2:GetHeadObject", "mediapackagev2:GetObject" ],
                  "Resource" : mp2Endpoint.attrArn
                }, {
                  "Sid" : "AllowMediaPackageHarvestObjectAccess",
                  "Effect" : "Allow",
                  "Principal" : {
                    "Service" : "mediapackagev2.amazonaws.com"
                  },
                  "Action" : "mediapackagev2:HarvestObject",
                  "Resource" : mp2Endpoint.attrArn,
                  "Condition" : {
                    "StringEquals" : {
                      "AWS:SourceAccount" : "267253737119"
                    }
                  }
                } ]
              },
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
            id: 'EMP2Output',
            settings: [
                {
                    url: cdk.Fn.select(0, mp2Channel.attrIngestEndpointUrls),
                }
            ],
        }];
        const outputGroups: medialive.CfnChannel.OutputGroupProperty[] = [{
            outputGroupSettings: {
                hlsGroupSettings: {
                    destination: {
                        destinationRefId: 'EMP2Output',
                    },
                    hlsCdnSettings: {
                        hlsBasicPutSettings: {
                            numRetries: 10,
                            connectionRetryInterval: 1,
                        },
                    },
                },
            },
            outputs: [{
                audioDescriptionNames: ['audio_3_aac128'],
                outputName: "1920_1080",
                outputSettings: {
                    hlsOutputSettings: {
                        hlsSettings: {
                            standardHlsSettings: {
                                m3U8Settings: {},
                            },
                        },
                    },
                },
                videoDescriptionName: "video_1920_1080"
            }],
        }];
        const downstreams = props.downstreamRtmps ?? [];
        for (let i = 0; i < downstreams.length; i++) {
            destinations.push({
                id: `RtmpOutput${i}`,
                settings: [{
                    streamName: downstreams[i].rtmpKey,
                    url: downstreams[i].rtmpUrl,
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
                    outputName: `Stream${i}`,
                    outputSettings: {
                        rtmpOutputSettings: {
                            destination: {
                                destinationRefId: `RtmpOutput${i}`,
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
