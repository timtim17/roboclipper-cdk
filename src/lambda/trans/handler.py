import os
import boto3

S3_DESTINATION_BUCKET = os.getenv("S3_DESTINATION_BUCKET")
assert S3_DESTINATION_BUCKET is not None, "S3_DESTINATION_BUCKET must be set"
IAM_ROLE = os.getenv("IAM_ROLE")
assert IAM_ROLE is not None, "IAM_ROLE must be set"

def handler(event, context):
    print(event)
    s3_source_bucket = event["detail"]["harvest_job"]["s3_destination"]["bucket_name"]
    s3_source_key = event["detail"]["harvest_job"]["s3_destination"]["manifest_key"]

    mediaconvert = boto3.client("mediaconvert")
    response = mediaconvert.create_job(
        Role=IAM_ROLE,
        Settings={
            "TimecodeConfig": {
                "Source": "ZEROBASED",
            },
            "OutputGroups": [{
                "Name": "File Group",
                "Outputs": [{
                    "ContainerSettings": {
                        "Container": "MP4",
                        "Mp4Settings": {},
                    },
                    "VideoDescription": {
                        "CodecSettings": {
                            "Codec": "H_264",
                            "H264Settings": {
                                "MaxBitrate": 12000000,
                                "RateControlMode": "QVBR",
                                "SceneChangeDetect": "TRANSITION_DETECTION",
                            },
                        },
                    },
                    "AudioDescriptions": [{
                        "AudioSourceName": "Audio Selector 1",
                        "CodecSettings": {
                            "Codec": "AAC",
                            "AacSettings": {
                                "Bitrate": 128000,
                                "CodingMode": "CODING_MODE_2_0",
                                "SampleRate": 48000,
                            },
                        },
                    }],
                }],
                "OutputGroupSettings": {
                    "Type": "FILE_GROUP_SETTINGS",
                    "FileGroupSettings": {
                        "Destination": f"s3://{S3_DESTINATION_BUCKET}/{os.path.dirname(s3_source_key)}/",
                        "DestinationSettings": {
                            "S3Settings": {
                                "StorageClass": "STANDARD",
                            },
                        },
                    },
                },
            }],
            "FollowSource": 1,
            "Inputs": [{
                "InputClippings": [{}],
                "AudioSelectors": {
                    "Audio Selector 1": {
                        "DefaultSelection": "DEFAULT",
                    },
                },
                "VideoSelector": {},
                "TimecodeSource": "ZEROBASED",
                "FileInput": f"s3://{s3_source_bucket}/{s3_source_key}"
            }],
        },
    )
    print(response)

    return {
        "statusCode": response["ResponseMetadata"]["HTTPStatusCode"],
        "jobId": response["Job"]["Id"] if "Id" in response["Job"] else None,
    }
