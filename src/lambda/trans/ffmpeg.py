import os
import subprocess
import tempfile
import boto3

S3_DESTINATION_BUCKET = os.getenv("S3_DESTINATION_BUCKET")
assert S3_DESTINATION_BUCKET is not None, "S3_DESTINATION_BUCKET must be set"
TEMP_DIR = tempfile.TemporaryDirectory()
DEST_DIR = TEMP_DIR.name + '/'

def handler(event, context):
    print(event)
    s3_source_bucket = event["detail"]["harvest_job"]["s3_destination"]["bucket_name"]
    s3_source_key = event["detail"]["harvest_job"]["s3_destination"]["manifest_key"]

    # s3_source_key is something like `frc_pncmp/q1/match.hls`
    # we want to download all of the files under the "q1" prefix
    # (all of the files specified by the playlist)
    s3_client = boto3.client("s3")
    s3_source_prefix = os.path.dirname(s3_source_key)
    objects = s3_client.list_objects_v2(Bucket=s3_source_bucket, Prefix=s3_source_prefix)
    # print(objects)
    assert "Contents" in objects, "No objects found"
    for obj in objects["Contents"]:
        assert "Key" in obj
        local_path = os.path.join(DEST_DIR, os.path.basename(obj["Key"]))
        # print("Downloading", obj["Key"], "to", local_path)
        s3_client.download_file(s3_source_bucket, obj["Key"], local_path)

    s3_destination_filename = s3_source_prefix.replace("/", "_") + ".mp4"
    full_dest_filename = os.path.join(DEST_DIR, s3_destination_filename)
    ffmpeg_cmd = ["/opt/bin/ffmpeg", "-i",
                  os.path.join(DEST_DIR, os.path.basename(s3_source_key)),
                  full_dest_filename]
    result = subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # print("stdout:", str(result.stdout, "utf-8"))
    # print("stderr:", str(result.stderr, "utf-8"))

    print("Uploading", full_dest_filename, "to", s3_destination_filename)
    s3_client.upload_file(full_dest_filename, S3_DESTINATION_BUCKET, s3_destination_filename)

    TEMP_DIR.cleanup()

    return {
        "statusCode": 200,
    }
