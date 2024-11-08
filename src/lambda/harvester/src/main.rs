mod processors;

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use aws_config::BehaviorVersion;
use aws_lambda_events::event::eventbridge::EventBridgeEvent;
use aws_sdk_dynamodb as ddb;
use aws_sdk_mediapackage as mediapackage;
use lambda_runtime::{run, service_fn, tracing, Error, LambdaEvent};

use mediapackage::types::S3Destination;
use serde::Serialize;

use crate::processors::ftc;
use crate::processors::test;
use crate::processors::Processor;

#[derive(Serialize)]
struct Response {
    result_jobs: Vec<String>,
}

#[derive(Debug)]
pub struct HarvestJob {
    match_name: String,
    start_time: String,
    end_time: String,
}


async fn function_handler(event: LambdaEvent<EventBridgeEvent>) -> Result<Response, Error> {
    println!("{:?}", event.payload);

    let harvest_state_table = required_env_var("DDB_TABLE");
    let mp_endpoint_id = required_env_var("MP_ENDPOINT");
    let destination_bucket_name = required_env_var("DEST_BUCKET");
    let iam_harvest_role = required_env_var("IAM_HARVEST");
    let event_type = required_env_var("EVENT_TYPE");
    let event_key = required_env_var("EVENT_KEY");

    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let ddb_client = ddb::Client::new(&config);
    let harvest_jobs = match &*event_type {
        "FTC" => ftc::Processor {}.process(&ddb_client, &harvest_state_table, &event_key).await,
        "Test" => test::Processor {}.process(&ddb_client, &harvest_state_table, &event_key).await,
        _ => panic!("Unknown event type")
    };
    let mut result_jobs = Vec::new();
    if harvest_jobs.len() > 0 {
        let mp_client = mediapackage::Client::new(&config);
        let harvest_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        for job in harvest_jobs {
            println!("Creating harvest job for: {:?}", job);
            let file_name_key = build_key(&event_type, &event_key, &job.match_name);
            let response = mp_client.create_harvest_job()
                .id(format!("{}-{}", harvest_epoch, file_name_key))
                .origin_endpoint_id(&mp_endpoint_id)
                .s3_destination(S3Destination::builder()
                    .bucket_name(&destination_bucket_name)
                    .manifest_key(format!("{0}/{0}.m3u8", file_name_key))
                    .role_arn(&iam_harvest_role)
                    .build())
                .start_time(&job.start_time)
                .end_time(&job.end_time)
                .send().await;
            if response.is_err() {
                println!("Failed to create harvest job '{:?}' - {:?}", job, response.unwrap_err());
            } else {
                let response_body = response.unwrap();
                result_jobs.push(response_body.id().unwrap().to_string());
                println!("{:?}", response_body);
            }
        }
    }

    Ok(Response {
        result_jobs: result_jobs,
    })
}

fn build_key(event_type: &String, event_key: &String, match_name: &String) -> String {
    format!("{}_{}_{}", event_type.to_lowercase(), event_key.to_lowercase(), match_name)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing::init_default_subscriber();

    run(service_fn(function_handler)).await
}

fn required_env_var(name: &str) -> String {
    match std::env::var(name) {
        Ok(val) => val,
        Err(_) => panic!("{} not set", name),
    }
}
