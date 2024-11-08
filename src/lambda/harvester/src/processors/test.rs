use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_sdk_dynamodb as ddb;

use crate::HarvestJob;

use super::HarvestState;

pub struct Processor {}

impl super::Processor for Processor {
    async fn process(&self, ddb_client: &ddb::Client, harvest_state_table: &String, event_key: &String) -> Vec<HarvestJob> {
        let state = self.get_ddb_state_or_create(ddb_client, harvest_state_table, event_key).await.unwrap();
        let new_state = HarvestState {
            last_harvested_match: state.last_harvested_match + 1,
            last_harvested_match_type: state.last_harvested_match_type,
        };
        self.put_ddb_state(ddb_client, harvest_state_table, event_key, &new_state).await;
        vec![HarvestJob {
            match_name: format!("test{}", new_state.last_harvested_match),
            start_time: (SystemTime::now() - Duration::from_secs(3 * 60)).duration_since(UNIX_EPOCH).unwrap().as_secs().to_string(),
            end_time: (SystemTime::now() - Duration::from_secs(30)).duration_since(UNIX_EPOCH).unwrap().as_secs().to_string(),
        }]
    }
} 
