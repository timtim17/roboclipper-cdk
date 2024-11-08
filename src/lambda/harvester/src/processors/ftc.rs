use aws_sdk_dynamodb as ddb;

use crate::HarvestJob;

pub struct Processor {}

impl super::Processor for Processor {
    async fn process(&self, ddb_client: &ddb::Client, harvest_state_table: &String, event_key: &String) -> Vec<HarvestJob> {
        Vec::new()
    }
} 
