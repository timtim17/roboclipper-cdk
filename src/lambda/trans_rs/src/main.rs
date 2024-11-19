
use aws_config::BehaviorVersion;
use aws_lambda_events::event::eventbridge::EventBridgeEvent;
use aws_sdk_mediaconvert as mediaconvert;
use aws_sdk_s3 as s3;
use lambda_runtime::{run, service_fn, tracing, Error, LambdaEvent};
use regex::Regex;

use mediaconvert::types::{AacCodingMode, AacSettings, AudioCodec, AudioCodecSettings, AudioDefaultSelection, AudioDescription, AudioSelector, ContainerSettings, ContainerType, DestinationSettings, FileGroupSettings, H264RateControlMode, H264SceneChangeDetect, H264Settings, Input, InputTimecodeSource, JobSettings, Output, OutputGroup, OutputGroupSettings, OutputGroupType, S3DestinationSettings, S3StorageClass, TimecodeConfig, TimecodeSource, VideoCodec, VideoCodecSettings, VideoDescription};
use serde::Serialize;

#[derive(Serialize)]
struct Response {
    job_id: String,
}


async fn function_handler(event: LambdaEvent<EventBridgeEvent>) -> Result<Response, Error> {
    println!("{:?}", event.payload);

    let iam_role = match std::env::var("IAM_ROLE") {
        Ok(val) => val,
        Err(_) => panic!("IAM_ROLE not set"),
    };
    let s3_destination_bucket = match std::env::var("S3_DESTINATION_BUCKET") {
        Ok(val) => val,
        Err(_) => panic!("S3_DESTINATION_BUCKET not set"),
    };

    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let client = mediaconvert::Client::new(&config);

    let s3_source_bucket = event.payload.detail["harvest_job"]["s3_destination"]["bucket_name"].as_str().unwrap();
    let s3_source_key = event.payload.detail["harvest_job"]["s3_destination"]["manifest_key"].as_str().unwrap();
    let re = Regex::new(r"^(.*)/(\d+)_(\d+)/main\.m3u8$").unwrap();
    let convert_job: mediaconvert::operation::create_job::CreateJobOutput;
    if let Some(captures) = re.captures(s3_source_key) {
        let s3_client = s3::Client::new(&config);
        let prefix = captures.get(1).unwrap().as_str();
        let total_parts: u8 = captures.get(3).unwrap().as_str().parse()?;
        let objects = s3_client.list_objects_v2()
            .bucket(s3_source_bucket)
            .prefix(prefix)
            .send().await?;
        if let Some(contents) = objects.contents {
            let m3u8_files: Vec<&str> = contents.iter()
            .map(|f| f.key().unwrap_or_default())
            .filter(|f| re.is_match(f))
            .collect();
            let m3u8_count = m3u8_files.len() as u8;
            if m3u8_count != total_parts {
                return Ok(Response {
                    job_id: "none".to_string(),
                });
            }
            convert_job = convert_parts(client, &iam_role, &s3_source_bucket,
                &s3_destination_bucket, m3u8_files, prefix).await?;
        } else {
            panic!("No contents found in S3");
        }
    } else {
        convert_job = legacy_logic(client, &iam_role, &s3_source_bucket,
            &s3_source_key, &s3_destination_bucket).await?;
    }

    println!("{:?}", convert_job);

    Ok(Response {
        job_id: convert_job.job.unwrap().id.unwrap(),
    })
}

async fn convert_parts(client: mediaconvert::Client, iam_role: &str, s3_source_bucket: &str,
    s3_destination_bucket: &str, mut parts: Vec<&str>, prefix: &str)
    -> Result<mediaconvert::operation::create_job::CreateJobOutput, Error> {
    parts.sort();
    Ok(client.create_job()
    .role(iam_role)
    .settings(JobSettings::builder()
        .timecode_config(TimecodeConfig::builder().source(TimecodeSource::Zerobased).build())
        .output_groups(OutputGroup::builder()
            .name("File Group")
            .outputs(Output::builder()
                .container_settings(ContainerSettings::builder()
                    .container(ContainerType::Mp4)
                    .build())
                .video_description(VideoDescription::builder()
                    .codec_settings(VideoCodecSettings::builder()
                        .codec(VideoCodec::H264)
                        .h264_settings(H264Settings::builder()
                            .max_bitrate(12_000_000)
                            .rate_control_mode(H264RateControlMode::Qvbr)
                            .scene_change_detect(H264SceneChangeDetect::TransitionDetection)
                            .build())
                        .build())
                    .build())
                .audio_descriptions(AudioDescription::builder()
                    .audio_source_name("Audio Selector 1")
                    .codec_settings(AudioCodecSettings::builder()
                        .codec(AudioCodec::Aac)
                        .aac_settings(AacSettings::builder()
                            .bitrate(128000)
                            .coding_mode(AacCodingMode::CodingMode20)
                            .sample_rate(48000)
                            .build())
                        .build())
                    .build())
                .build())
                .output_group_settings(OutputGroupSettings::builder()
                    .r#type(OutputGroupType::FileGroupSettings)
                    .file_group_settings(FileGroupSettings::builder()
                        .destination(format!("s3://{}/{}", s3_destination_bucket, prefix.replace("_", "/")))
                        .destination_settings(DestinationSettings::builder()
                            .s3_settings(S3DestinationSettings::builder().storage_class(S3StorageClass::Standard).build())
                            .build())
                        .build())
                    .build())
            .build())
        .follow_source(1)
        .set_inputs(Some(parts.iter()
            .map(|part| Input::builder()
                .audio_selectors("Audio Selector 1", AudioSelector::builder().default_selection(AudioDefaultSelection::Default).build())
                .timecode_source(InputTimecodeSource::Zerobased)
                .file_input(format!("s3://{}/{}", s3_source_bucket, part))
                .build()
            )
            .collect()
        ))
        .build()
    ).send().await?)
}

async fn legacy_logic(client: mediaconvert::Client, iam_role: &str, s3_source_bucket: &str,
    s3_source_key: &str, s3_destination_bucket: &str)
    -> Result<mediaconvert::operation::create_job::CreateJobOutput, Error> {
    Ok(client.create_job()
    .role(iam_role)
    .settings(
        JobSettings::builder()
            .timecode_config(TimecodeConfig::builder().source(TimecodeSource::Zerobased).build())
            .output_groups(OutputGroup::builder()
                .name("File Group")
                .outputs(Output::builder()
                    .container_settings(ContainerSettings::builder()
                        .container(ContainerType::Mp4)
                        .build())
                    .video_description(VideoDescription::builder()
                        .codec_settings(VideoCodecSettings::builder()
                            .codec(VideoCodec::H264)
                            .h264_settings(H264Settings::builder()
                                .max_bitrate(12_000_000)
                                .rate_control_mode(H264RateControlMode::Qvbr)
                                .scene_change_detect(H264SceneChangeDetect::TransitionDetection)
                                .build())
                            .build())
                        .build())
                    .audio_descriptions(AudioDescription::builder()
                        .audio_source_name("Audio Selector 1")
                        .codec_settings(AudioCodecSettings::builder()
                            .codec(AudioCodec::Aac)
                            .aac_settings(AacSettings::builder()
                                .bitrate(128000)
                                .coding_mode(AacCodingMode::CodingMode20)
                                .sample_rate(48000)
                                .build())
                            .build())
                        .build())
                    .build())
                    .output_group_settings(OutputGroupSettings::builder()
                        .r#type(OutputGroupType::FileGroupSettings)
                        .file_group_settings(FileGroupSettings::builder()
                            .destination(format!("s3://{}/", s3_destination_bucket))
                            .destination_settings(DestinationSettings::builder()
                                .s3_settings(S3DestinationSettings::builder().storage_class(S3StorageClass::Standard).build())
                                .build())
                            .build())
                        .build())
                .build())
            .follow_source(1)
            .inputs(Input::builder()
                .audio_selectors("Audio Selector 1", AudioSelector::builder().default_selection(AudioDefaultSelection::Default).build())
                .timecode_source(InputTimecodeSource::Zerobased)
                .file_input(format!("s3://{}/{}", s3_source_bucket, s3_source_key))
                .build())
            .build()
    ).send().await?)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing::init_default_subscriber();

    run(service_fn(function_handler)).await
}
